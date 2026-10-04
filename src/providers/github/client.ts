/**
 * GitHub API client.
 *
 * Wraps the `gh` CLI rather than speaking HTTP directly, because every Forge
 * user who has `gh` installed is already authenticated with it, and a second
 * auth mechanism would be a second thing to get wrong. The token is never read
 * into a variable: it is set in the child process's environment and the child
 * does the auth, so the secret never appears in Forge's memory or in a log.
 */

import { execute } from '../../build/exec.js';
import { AuthError, ErrorCode, ForgeError, ProviderError } from '../../errors/index.js';
import { maskSecret } from '../../utils/index.js';

/**
 * How this module runs `gh`.
 *
 * Defaults to the real executor. Tests inject a stub so provider logic can be
 * verified offline and deterministically. Every function here takes an optional
 * `runner`, and `GhOptions.runner` threads it through — the alternative would be
 * for the client to reach for a module-level singleton that tests cannot replace.
 */
export type GhRunner = typeof execute;

/** Repository facts. */
export interface RepositoryInfo {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly isPrivate: boolean;
  readonly url: string;
  readonly description: string | null;
}

export interface ReleaseInfo {
  readonly tagName: string;
  readonly name: string | null;
  readonly isDraft: boolean;
  readonly isPrerelease: boolean;
  readonly url: string;
  readonly publishedAt: string | null;
  readonly assets: readonly { name: string; size: number; url: string }[];
}

export interface ReleaseDraft {
  readonly tagName: string;
  readonly name?: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  /** Asset paths to attach, absolute. */
  readonly assets?: readonly string[];
}

export interface TagRef {
  readonly name: string;
  readonly commit: string | null;
}

/** Options shared by every call. */
export interface GhOptions {
  /** Token to present. Never logged; passed only through the child env. */
  readonly token?: string | undefined;
  /** Repository as `owner/name`. Defaults to the ambient repository. */
  readonly repo?: string | undefined;
  readonly cwd?: string | undefined;
  /** Test seam. Defaults to the real executor. */
  readonly runner?: GhRunner;
}

/** Pick the injected runner, or the real one. */
function runnerOf(options: GhOptions): GhRunner {
  return options.runner ?? execute;
}

/** True when `gh` is installed and responding. */
export async function isAvailable(options: GhOptions = {}): Promise<boolean> {
  const result = await runnerOf(options)('gh', ['--version'], { cwd: options.cwd });
  return result.exitCode === 0;
}

/**
 * Verify credentials.
 *
 * Uses `gh api user`, which returns the token's own identity. That is the one
 * call that proves the credential works without any write permission.
 */
export async function whoami(options: GhOptions = {}): Promise<{ login: string; id: string }> {
  const result = await runnerOf(options)('gh', ['api', 'user'], {
    cwd: options.cwd,
    env: authEnv(options.token),
  });

  if (result.exitCode !== 0) {
    throw new AuthError(ErrorCode.AUTH_FAILED, 'GitHub authentication failed.', {
      provider: 'github',
      operation: 'github.authenticate',
      remediation: 'Run `gh auth login`, or set GITHUB_TOKEN to a token with repo scope.',
      detail: { reason: firstLine(result.stderr) || firstLine(result.stdout) },
    });
  }

  try {
    const parsed = JSON.parse(result.stdout) as { login?: unknown; id?: unknown };
    if (typeof parsed.login !== 'string') throw new Error('no login');
    const id =
      typeof parsed.id === 'number' || typeof parsed.id === 'string' ? String(parsed.id) : '';
    return { login: parsed.login, id };
  } catch (error) {
    throw new ForgeError(ErrorCode.UNKNOWN, 'Could not read the GitHub account from gh.', {
      provider: 'github',
      cause: error,
      remediation: 'Run `gh auth status` to check the CLI configuration.',
    });
  }
}

/** Fetch repository metadata. Throws when the repository is missing or forbidden. */
export async function getRepository(
  fullName: string,
  options: GhOptions = {},
): Promise<RepositoryInfo> {
  const result = await runnerOf(options)('gh', ['api', `repos/${fullName}`], {
    cwd: options.cwd,
    env: authEnv(options.token),
  });

  if (result.exitCode !== 0) {
    const status = ghHttpStatus(result.stderr) ?? ghHttpStatus(result.stdout);
    if (status === 404) {
      throw new ForgeError(ErrorCode.PROVIDER_FAILED, `Repository ${fullName} was not found.`, {
        provider: 'github',
        operation: 'github.repository',
        remediation: `Check the name, and that the token can access ${fullName}.`,
        detail: { repository: fullName, status },
      });
    }
    if (status === 403) {
      throw new AuthError(ErrorCode.AUTH_FAILED, `No access to ${fullName}.`, {
        provider: 'github',
        operation: 'github.repository',
        remediation: 'The token needs repo scope, or the account must be a collaborator.',
        detail: { repository: fullName, status },
      });
    }
    throw new ForgeError(ErrorCode.PROVIDER_FAILED, `Could not read ${fullName}.`, {
      provider: 'github',
      operation: 'github.repository',
      cause: new ForgeError(ErrorCode.UNKNOWN, firstLine(result.stderr)),
      detail: { repository: fullName, exitCode: result.exitCode },
    });
  }

  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  const owner = (raw['owner'] as { login?: unknown } | undefined)?.login;

  return {
    owner: typeof owner === 'string' ? owner : (fullName.split('/')[0] ?? ''),
    name: typeof raw['name'] === 'string' ? raw['name'] : (fullName.split('/')[1] ?? ''),
    fullName: typeof raw['full_name'] === 'string' ? raw['full_name'] : fullName,
    defaultBranch: typeof raw['default_branch'] === 'string' ? raw['default_branch'] : 'main',
    isPrivate: raw['private'] === true,
    url: typeof raw['html_url'] === 'string' ? raw['html_url'] : `https://github.com/${fullName}`,
    description: typeof raw['description'] === 'string' ? raw['description'] : null,
  };
}

/** List tags, newest first. */
export async function listTags(
  fullName: string,
  limit = 100,
  options: GhOptions = {},
): Promise<TagRef[]> {
  const result = await runnerOf(options)(
    'gh',
    ['api', `repos/${fullName}/tags?per_page=${Math.min(Math.max(limit, 1), 100)}`],
    { cwd: options.cwd, env: authEnv(options.token) },
  );

  if (result.exitCode !== 0) return [];

  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (typeof entry !== 'object' || entry === null) return [];
      const name = (entry as { name?: unknown }).name;
      const sha = (entry as { commit?: { sha?: unknown } }).commit?.sha;
      return typeof name === 'string'
        ? [{ name, commit: typeof sha === 'string' ? sha : null }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * True when a tag exists in the remote repository.
 *
 * A 404 is the normal "no such tag" answer. Any other failure — 401, 403, a
 * network error, a timeout — means the question was never answered, and
 * collapsing those into `false` would report a perfectly good release as missing.
 * That distinction matters more than it looks: the integrity check tells users to
 * re-publish or roll back, and "your token is invalid" is the opposite advice.
 */
export async function tagExistsRemote(
  fullName: string,
  tag: string,
  options: GhOptions = {},
): Promise<boolean> {
  const result = await runnerOf(options)('gh', ['api', `repos/${fullName}/git/ref/tags/${tag}`], {
    cwd: options.cwd,
    env: authEnv(options.token),
  });

  if (result.exitCode === 0) return true;

  // 404 is the only answer that legitimately means "absent".
  if (ghHttpStatus(result.stderr) === 404 || ghHttpStatus(result.stdout) === 404) return false;

  const { AuthError, ForgeError } = await import('../../errors/index.js');
  const status = ghHttpStatus(result.stderr) ?? ghHttpStatus(result.stdout);

  if (status === 401 || status === 403) {
    throw new AuthError(
      ErrorCode.AUTH_FAILED,
      `Could not read ${fullName} — the token was rejected.`,
      {
        provider: 'github',
        operation: 'github.tagExists',
        remediation:
          'Run `gh auth status`. An expired or invalid token cannot distinguish a missing tag from a failed read.',
        detail: { repository: fullName, tag, status },
      },
    );
  }

  throw new ForgeError(
    ErrorCode.PROVIDER_FAILED,
    `Could not check whether ${tag} exists on ${fullName}.`,
    {
      provider: 'github',
      operation: 'github.tagExists',
      remediation: 'Check network access to api.github.com, then retry.',
      detail: { repository: fullName, tag, status, exitCode: result.exitCode },
    },
  );
}

/** Fetch one release by tag, or null when it does not exist. */
export async function getRelease(
  fullName: string,
  tag: string,
  options: GhOptions = {},
): Promise<ReleaseInfo | null> {
  const result = await runnerOf(options)('gh', ['api', `repos/${fullName}/releases/tags/${tag}`], {
    cwd: options.cwd,
    env: authEnv(options.token),
  });

  // A missing release is a normal state — but only a 404 says so. See
  // tagExistsRemote for why every other status must not be read as "absent".
  if (result.exitCode !== 0) {
    const status = ghHttpStatus(result.stderr) ?? ghHttpStatus(result.stdout);
    if (status === 404 || status === null) return null;

    const { AuthError, ForgeError } = await import('../../errors/index.js');
    if (status === 401 || status === 403) {
      throw new AuthError(
        ErrorCode.AUTH_FAILED,
        `Could not read releases for ${fullName} — the token was rejected.`,
        {
          provider: 'github',
          operation: 'github.getRelease',
          remediation:
            'Run `gh auth status`. An expired or invalid token cannot distinguish a missing release from a failed read.',
          detail: { repository: fullName, tag, status },
        },
      );
    }

    throw new ForgeError(ErrorCode.PROVIDER_FAILED, `Could not read the release for ${tag}.`, {
      provider: 'github',
      operation: 'github.getRelease',
      remediation: 'Check network access to api.github.com, then retry.',
      detail: { repository: fullName, tag, status, exitCode: result.exitCode },
    });
  }

  try {
    return parseRelease(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Create a release.
 *
 * Prefers the REST endpoint over `gh release create` because the API returns the
 * release URL directly and fails distinctly when the tag already has a release.
 */
export async function createRelease(
  fullName: string,
  draft: ReleaseDraft,
  options: GhOptions = {},
): Promise<ReleaseInfo> {
  const existing = await getRelease(fullName, draft.tagName, options);
  if (existing !== null) {
    const { DuplicateReleaseError } = await import('../../errors/index.js');
    throw new DuplicateReleaseError(`A release already exists for ${draft.tagName}.`, {
      provider: 'github',
      operation: 'github.createRelease',
      remediation: 'Forge never overwrites a release. Delete it first, or use a new tag.',
      detail: { repository: fullName, tag: draft.tagName, url: existing.url },
    });
  }

  const payload: Record<string, unknown> = {
    tag_name: draft.tagName,
    name: draft.name ?? draft.tagName,
    body: draft.body ?? '',
    draft: draft.draft ?? false,
    prerelease: draft.prerelease ?? false,
  };

  const run = runnerOf(options);
  let result;
  try {
    result = await run(
      'gh',
      ['api', '--method', 'POST', `repos/${fullName}/releases`, '--input', '-'],
      {
        cwd: options.cwd,
        env: authEnv(options.token),
        input: JSON.stringify(payload),
      },
    );
  } catch (error) {
    throw new ForgeError(
      ErrorCode.PROVIDER_FAILED,
      `Could not create the release for ${draft.tagName}.`,
      {
        provider: 'github',
        operation: 'github.createRelease',
        cause: error,
        remediation: 'Check that gh is authenticated and the repository is writable.',
        detail: { repository: fullName, tag: draft.tagName },
      },
    );
  }

  if (result.exitCode !== 0) {
    throw new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `Release creation failed with exit ${result.exitCode}.`,
      {
        provider: 'github',
        operation: 'github.createRelease',
        remediation:
          (result.stderr || result.stdout || '').trim().slice(0, 500) || 'Check gh authentication.',
        detail: { repository: fullName, tag: draft.tagName, exitCode: result.exitCode },
      },
    );
  }

  try {
    return parseRelease(JSON.parse(result.stdout) as Record<string, unknown>);
  } catch (error) {
    throw new ForgeError(
      ErrorCode.PROVIDER_FAILED,
      `Release for ${draft.tagName} was created but could not be read back.`,
      {
        provider: 'github',
        operation: 'github.createRelease',
        cause: error,
        remediation: `Check https://github.com/${fullName}/releases`,
        detail: { repository: fullName, tag: draft.tagName },
      },
    );
  }
}

/** Upload release assets. */
export async function uploadAssets(
  fullName: string,
  tag: string,
  assetPaths: readonly string[],
  options: GhOptions = {},
): Promise<{ name: string; size: number; url: string }[]> {
  const uploaded: { name: string; size: number; url: string }[] = [];

  for (const path of assetPaths) {
    const result = await runnerOf(options)(
      'gh',
      ['release', 'upload', tag, path, '--repo', fullName, '--clobber'],
      { cwd: options.cwd, env: authEnv(options.token) },
    );
    if (result.exitCode === 0) {
      uploaded.push({ name: path.split('/').pop() ?? path, size: 0, url: '' });
    }
  }

  return uploaded;
}

/**
 * The environment for a `gh` child process.
 *
 * When a token is supplied it is passed via `GH_TOKEN`, which `gh` prefers over
 * its own stored config. The value never leaves this object.
 */
function authEnv(token: string | undefined): Record<string, string> | undefined {
  if (token === undefined || token.length === 0) return undefined;
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

/** Map a gh API response to `ReleaseInfo`. */
export function parseRelease(raw: Record<string, unknown>): ReleaseInfo {
  const assetsRaw = Array.isArray(raw['assets']) ? raw['assets'] : [];
  return {
    tagName: typeof raw['tag_name'] === 'string' ? raw['tag_name'] : '',
    name: typeof raw['name'] === 'string' ? raw['name'] : null,
    isDraft: raw['draft'] === true,
    isPrerelease: raw['prerelease'] === true,
    url: typeof raw['html_url'] === 'string' ? raw['html_url'] : '',
    publishedAt: typeof raw['published_at'] === 'string' ? raw['published_at'] : null,
    assets: assetsRaw.flatMap((asset) => {
      if (typeof asset !== 'object' || asset === null) return [];
      const a = asset as { name?: unknown; size?: unknown; browser_download_url?: unknown };
      if (typeof a.name !== 'string') return [];
      return [
        {
          name: a.name,
          size: typeof a.size === 'number' ? a.size : 0,
          url: typeof a.browser_download_url === 'string' ? a.browser_download_url : '',
        },
      ];
    }),
  };
}

/** Extract an HTTP status from gh's error text, e.g. `HTTP 404`. */
export function ghHttpStatus(text: string): number | null {
  const match = /\b(?:HTTP\s*)?([45]\d{2})\b/.exec(text);
  if (match?.[1] === undefined) return null;
  const status = Number.parseInt(match[1], 10);
  return Number.isNaN(status) ? null : status;
}

/** First non-empty line of output, trimmed to a sane length. */
function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.slice(0, 300);
}

/** Masked form of a token, for a diagnostic that must reference it. */
export function describeToken(token: string): string {
  return maskSecret(token);
}
