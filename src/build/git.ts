/**
 * Git introspection.
 *
 * Forge needs a handful of facts about the working tree before it releases
 * anything: is this a repo, what branch, what commit, is anything uncommitted,
 * does a tag already exist. All of it goes through `execute`, so no shell is
 * involved and a tag name can never be interpolated into a command string.
 */

import { execute } from './exec.js';
import { CheckError, DuplicateReleaseError, EnvironmentError, ErrorCode } from '../errors/index.js';

/**
 * How this module runs `git`.
 *
 * Mirrors the gh client: the real executor by default, injectable so a provider
 * test can drive git-dependent code paths without a repository on disk. Every
 * function accepts an optional `runner`.
 */
export type GitRunner = typeof execute;

/** Facts about the working tree at a point in time. */
export interface GitState {
  /** False when the directory is not inside a git repository. */
  readonly isRepository: boolean;
  readonly branch: string | null;
  readonly commit: string | null;
  /** Short commit hash, for display. */
  readonly shortCommit: string | null;
  /** Paths reported by `git status --porcelain`. Empty when clean. */
  readonly dirtyPaths: readonly string[];
}

/** Read the current git state. Never throws for "not a repository". */
export async function readGitState(cwd: string, runner: GitRunner = execute): Promise<GitState> {
  const inside = await runner('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return { isRepository: false, branch: null, commit: null, shortCommit: null, dirtyPaths: [] };
  }

  const [branch, commit, status] = await Promise.all([
    runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }),
    runner('git', ['rev-parse', 'HEAD'], { cwd }),
    runner('git', ['status', '--porcelain'], { cwd }),
  ]);

  return {
    isRepository: true,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
    shortCommit: commit.exitCode === 0 ? commit.stdout.trim().slice(0, 7) || null : null,
    dirtyPaths: parseStatus(status.stdout),
  };
}

/**
 * @throws EnvironmentError when the directory is not a git repository, which
 * matters because a release without a repository cannot be tagged.
 */
export async function requireRepository(
  cwd: string,
  runner: GitRunner = execute,
): Promise<GitState> {
  const state = await readGitState(cwd, runner);
  if (!state.isRepository) {
    throw new EnvironmentError(ErrorCode.GIT_REPO_NOT_FOUND, 'Not inside a git repository.', {
      operation: 'git.validate',
      remediation: 'Run `git init`, or run forge from inside your project.',
    });
  }
  return state;
}

/** Parse `git status --porcelain` output into paths. */
function parseStatus(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

/** The `owner/name` remote URL for a repository, or null when there is none. */
export async function readGitRemote(
  cwd: string,
  runner: GitRunner = execute,
): Promise<string | null> {
  const result = await runner('git', ['remote', 'get-url', 'origin'], { cwd });
  if (result.exitCode !== 0) return null;
  return parseRemoteUrl(result.stdout.trim());
}

/**
 * Parse a git remote URL into `owner/name`.
 *
 * Handles the three shapes that appear in practice:
 *   git@github.com:owner/name.git
 *   https://github.com/owner/name.git
 *   ssh://git@github.com/owner/name.git
 */
export function parseRemoteUrl(url: string): string | null {
  if (url.length === 0) return null;

  // scp-like: git@host:owner/name.git
  const scp = /^(?:[^@/]+@)?[^:/]+:([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (scp?.[1] !== undefined) return scp[1];

  // scheme://[user@]host/owner/name[.git]
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    const segments = parsed.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/');
    if (segments.length >= 2) {
      const owner = segments[0];
      const name = segments.slice(1).join('/');
      if (owner !== undefined && name !== undefined) return `${owner}/${name}`;
    }
  } catch {
    return null;
  }

  return null;
}

/** True when a tag exists locally. */
export async function tagExists(
  cwd: string,
  tag: string,
  runner: GitRunner = execute,
): Promise<boolean> {
  const result = await runner('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd });
  return result.exitCode === 0;
}

/** The commit a tag points at, or null. */
export async function tagCommit(
  cwd: string,
  tag: string,
  runner: GitRunner = execute,
): Promise<string | null> {
  const result = await runner('git', ['rev-list', '-n', '1', tag], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** The most recent tag matching a prefix, e.g. `v` — used to find the current version. */
export async function latestTag(
  cwd: string,
  prefix: string,
  runner: GitRunner = execute,
): Promise<string | null> {
  const result = await runner(
    'git',
    ['tag', '--list', `${prefix}*`, '--sort=-v:refname', '--sort=-creatordate'],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const first = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first ?? null;
}

/**
 * Create an annotated tag.
 *
 * @throws DuplicateReleaseError when the tag already exists. npm and GitHub both
 * treat an existing version as immutable, so overwriting is never the right move.
 */
export async function createTag(
  cwd: string,
  tag: string,
  message: string,
  runner: GitRunner = execute,
): Promise<{ created: boolean; tag: string }> {
  if (await tagExists(cwd, tag, runner)) {
    throw new DuplicateReleaseError(`Tag ${tag} already exists.`, {
      operation: 'git.tag',
      remediation: 'Choose a higher version, or delete the tag first if you are certain.',
      detail: { tag },
    });
  }

  const result = await runner('git', ['tag', '-a', tag, '-m', message], { cwd });
  if (result.exitCode !== 0) {
    throw new CheckError(ErrorCode.CHECK_FAILED, `Could not create tag ${tag}.`, {
      operation: 'git.tag',
      remediation: 'Check the working tree is clean and the tag name is valid.',
      detail: { tag, exitCode: result.exitCode, output: (result.stderr || '').slice(0, 500) },
    });
  }
  return { created: true, tag };
}

/** Push a tag to a remote. */
export async function pushTag(
  cwd: string,
  tag: string,
  remote = 'origin',
  runner: GitRunner = execute,
): Promise<void> {
  const result = await runner('git', ['push', remote, `refs/tags/${tag}`], { cwd });
  if (result.exitCode !== 0) {
    throw new CheckError(ErrorCode.CHECK_FAILED, `Could not push tag ${tag}.`, {
      operation: 'git.pushTag',
      remediation: 'Check the remote exists and you have push access.',
      detail: {
        tag,
        remote,
        exitCode: result.exitCode,
        output: (result.stderr || '').slice(0, 500),
      },
    });
  }
}
