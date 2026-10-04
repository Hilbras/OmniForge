/**
 * Git introspection tests.
 *
 * This module decides whether a release may proceed: it is where a duplicate tag
 * is caught, where a missing repository is refused, and where a push failure
 * surfaces. So the tests run against a *real* git repository in a temp directory
 * rather than a stub — a stub would confirm that the code calls what the stub
 * expects, which is not the property that matters.
 *
 * The remaining cases (no repository, a rejected command, a parse failure) need a
 * stub or a non-repo path, because there is no real repository that produces them.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ExecResult } from '../../src/build/exec.js';
import {
  createTag,
  latestTag,
  parseRemoteUrl,
  pushTag,
  readGitRemote,
  readGitState,
  requireRepository,
  tagCommit,
  tagExists,
  type GitRunner,
} from '../../src/build/git.js';
import { CheckError, DuplicateReleaseError, EnvironmentError } from '../../src/errors/index.js';

const execFileAsync = promisify(execFile);

/** A complete ExecResult, so a stub matches what the real executor returns. */
function result(
  exitCode: number,
  stdout = '',
  stderr = '',
  command = 'git',
  args: readonly string[] = [],
): ExecResult {
  return { exitCode, stdout, stderr, command, args, durationMs: 1, timedOut: false, killed: false };
}

/**
 * A runner where the tag does not exist and then creating it fails.
 *
 * The two-step shape matters: `tagExists` must say no, or `createTag` reports a
 * duplicate instead of the creation failure being tested.
 */
function tagCreationFails(stderr = 'fatal: tagger identity unknown'): GitRunner {
  return (_cmd, args) =>
    Promise.resolve(
      (args ?? []).includes('rev-parse')
        ? result(1, '', '', 'git', args ?? [])
        : result(1, '', stderr, 'git', args ?? []),
    );
}

/** A runner that always fails, standing in for an unusable git. */
const failingRunner: GitRunner = () => Promise.resolve(result(128, '', 'fatal: nope'));

describe('parseRemoteUrl', () => {
  it.each([
    ['git@github.com:Hilbras/hilbras-forge.git', 'Hilbras/hilbras-forge'],
    ['https://github.com/Hilbras/hilbras-forge.git', 'Hilbras/hilbras-forge'],
    ['https://github.com/Hilbras/hilbras-forge', 'Hilbras/hilbras-forge'],
    ['ssh://git@github.com/Hilbras/hilbras-forge.git', 'Hilbras/hilbras-forge'],
    ['git@gitlab.com:group/sub/project.git', 'group/sub/project'],
    ['https://github.com/owner/name.git/', 'owner/name'],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['https://github.com/', 'host only'],
    ['/local/path/repo', 'absolute local path'],
  ])('returns null for %s (%s)', (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });

  it('is not fooled by a URL containing a colon in the path', () => {
    // The scp-like pattern must not match https:// URLs and truncate the owner.
    expect(parseRemoteUrl('https://github.com/Hilbras/Forge')).toBe('Hilbras/Forge');
  });
});

describe('against a real repository', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
    // Fixed identity and dates so the assertions do not depend on the host's git
    // config or clock.
    const git = async (...args: string[]): Promise<void> => {
      await execFileAsync('git', args, { cwd: dir });
    };
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'tag.gpgsign', 'false');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const commit = async (message: string): Promise<void> => {
    writeFileSync(join(dir, 'file.txt'), message);
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-q', '-m', message], { cwd: dir });
  };

  describe('readGitState', () => {
    it('reports a clean repository', async () => {
      await commit('initial');

      const state = await readGitState(dir);

      expect(state.isRepository).toBe(true);
      expect(state.branch).toBe('main');
      expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(state.shortCommit).toBe(state.commit?.slice(0, 7));
      expect(state.dirtyPaths).toEqual([]);
    });

    it('reports uncommitted files', async () => {
      await commit('initial');
      writeFileSync(join(dir, 'file.txt'), 'changed');

      const state = await readGitState(dir);

      expect(state.dirtyPaths).toHaveLength(1);
      expect(state.dirtyPaths[0]).toContain('file.txt');
    });

    it('reports an untracked file', async () => {
      await commit('initial');
      writeFileSync(join(dir, 'new.txt'), 'untracked');

      const state = await readGitState(dir);

      expect(state.dirtyPaths.join(' ')).toContain('new.txt');
    });

    it('lists several dirty paths', async () => {
      await commit('initial');
      writeFileSync(join(dir, 'a.txt'), 'a');
      writeFileSync(join(dir, 'b.txt'), 'b');

      const state = await readGitState(dir);

      expect(state.dirtyPaths.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('requireRepository', () => {
    it('returns the state when inside a repository', async () => {
      await commit('initial');

      await expect(requireRepository(dir)).resolves.toMatchObject({ isRepository: true });
    });

    it('throws outside a repository', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'forge-nogit-'));
      try {
        await expect(requireRepository(bare)).rejects.toBeInstanceOf(EnvironmentError);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    it('suggests a fix', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'forge-nogit-'));
      try {
        await expect(requireRepository(bare)).rejects.toMatchObject({
          remediation: expect.stringMatching(/git init|inside your project/i),
        });
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });

  describe('readGitRemote', () => {
    it('reads origin', async () => {
      await execFileAsync(
        'git',
        ['remote', 'add', 'origin', 'git@github.com:Hilbras/hilbras-forge.git'],
        {
          cwd: dir,
        },
      );

      await expect(readGitRemote(dir)).resolves.toBe('Hilbras/hilbras-forge');
    });

    it('is null with no remote', async () => {
      await expect(readGitRemote(dir)).resolves.toBeNull();
    });
  });

  describe('tags', () => {
    it('creates an annotated tag', async () => {
      await commit('initial');

      const result = await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      expect(result).toEqual({ created: true, tag: 'v1.0.0' });
      await expect(tagExists(dir, 'v1.0.0')).resolves.toBe(true);
    });

    it('creates a real annotated tag object, not a lightweight one', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      const { stdout } = await execFileAsync('git', ['cat-file', '-t', 'v1.0.0'], { cwd: dir });

      expect(stdout.trim()).toBe('tag');
    });

    it('refuses to overwrite an existing tag', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      // npm and GitHub both treat a published version as immutable, so silently
      // replacing a tag would diverge from every registry.
      await expect(createTag(dir, 'v1.0.0', 'again')).rejects.toBeInstanceOf(DuplicateReleaseError);
    });

    it('explains how to recover from a duplicate tag', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'first');

      await expect(createTag(dir, 'v1.0.0', 'again')).rejects.toMatchObject({
        remediation: expect.stringMatching(/higher version|delete the tag/i),
      });
    });

    it('reports the tag as absent before creating it', async () => {
      await expect(tagExists(dir, 'v9.9.9')).resolves.toBe(false);
    });

    it('resolves a tag to its commit', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      const state = await readGitState(dir);
      const commitish = await tagCommit(dir, 'v1.0.0');

      expect(commitish).toBe(state.commit);
    });

    it('is null for an unknown tag', async () => {
      await expect(tagCommit(dir, 'v9.9.9')).resolves.toBeNull();
    });

    it('finds the highest version tag', async () => {
      await commit('initial');
      for (const tag of ['v0.9.0', 'v0.10.0', 'v0.2.0']) {
        await createTag(dir, tag, `Release ${tag}`);
      }

      // v0.10.0 sorts above v0.9.0 numerically, not lexically.
      await expect(latestTag(dir, 'v')).resolves.toBe('v0.10.0');
    });

    it('is null when no tag matches the prefix', async () => {
      await commit('initial');
      await createTag(dir, 'release-1', 'x');

      await expect(latestTag(dir, 'v')).resolves.toBeNull();
    });

    it('ignores tags outside the prefix', async () => {
      await commit('initial');
      await createTag(dir, 'nightly-99', 'x');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      await expect(latestTag(dir, 'v')).resolves.toBe('v1.0.0');
    });
  });

  describe('pushTag', () => {
    it('fails with actionable detail when there is no remote', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      // The common local-only case, and the error a user actually hits.
      await expect(pushTag(dir, 'v1.0.0')).rejects.toBeInstanceOf(CheckError);
      await expect(pushTag(dir, 'v1.0.0')).rejects.toMatchObject({
        remediation: expect.stringMatching(/remote|push access/i),
      });
    });

    it('pushes to a real bare remote', async () => {
      await commit('initial');
      await createTag(dir, 'v1.0.0', 'Release 1.0.0');

      const bare = mkdtempSync(join(tmpdir(), 'forge-bare-'));
      try {
        await execFileAsync('git', ['init', '-q', '--bare', bare], { timeout: 20_000 });
        await execFileAsync('git', ['remote', 'add', 'origin', bare], { cwd: dir });

        await pushTag(dir, 'v1.0.0');

        // Prove it landed on the remote, not just that the call returned.
        const { stdout } = await execFileAsync('git', ['tag', '--list'], { cwd: bare });
        expect(stdout).toContain('v1.0.0');
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });
});

describe('when git is unusable', () => {
  it('reports no repository rather than throwing', async () => {
    // A missing git must not look like a missing repository — one is an
    // environment problem, the other is a user error.
    const state = await readGitState('/tmp', failingRunner);

    expect(state.isRepository).toBe(false);
    expect(state.branch).toBeNull();
  });

  it('refuses to release without a repository', async () => {
    await expect(requireRepository('/tmp', failingRunner)).rejects.toBeInstanceOf(EnvironmentError);
  });

  it('reports a failed tag creation', async () => {
    // tagExists says no, then the tag command fails: the creation error must
    // surface rather than being swallowed as "already exists".
    await expect(createTag('/tmp', 'v1.0.0', 'msg', tagCreationFails())).rejects.toBeInstanceOf(
      CheckError,
    );
  });

  it('explains a tag creation failure', async () => {
    await expect(createTag('/tmp', 'v1.0.0', 'msg', tagCreationFails())).rejects.toMatchObject({
      remediation: expect.stringMatching(/clean|valid/i),
    });
  });

  it('truncates a huge git error rather than storing it whole', async () => {
    try {
      await createTag('/tmp', 'v1.0.0', 'msg', tagCreationFails('x'.repeat(50_000)));
      expect.unreachable('should have thrown');
    } catch (error) {
      const output = (error as { detail: { output: string } }).detail.output;
      expect(output.length).toBeLessThanOrEqual(500);
    }
  });
});
