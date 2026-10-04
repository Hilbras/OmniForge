/**
 * PyPI registry client.
 *
 * Reads package metadata from the JSON API and uploads through `twine`, which is
 * the tool PyPI itself documents and which handles the multipart encoding,
 * retries, and `--non-interactive` prompt handling correctly. Wrapping twine
 * rather than hand-rolling the upload avoids reimplementing the one part of this
 * where getting it wrong publishes something broken.
 *
 * Every command runs as an argument array with no shell, and the token travels
 * through the environment, never argv — twine reads `TWINE_PASSWORD`, so a
 * credential never appears in the process list.
 */

import { normalizePackageName } from './name.js';

export interface PyPiOptions {
  readonly cwd?: string;
  /** Token, passed to twine as TWINE_PASSWORD. */
  readonly token?: string | undefined;
  /** Registry URL; defaults to real PyPI. */
  readonly repository?: string | undefined;
  /** Command runner, injectable for tests. */
  readonly runner?: PyPiRunner | undefined;
  readonly dryRun?: boolean;
}

/** The result shape the shared executor returns. */
export interface PyPiExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PyPiRunner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: Record<string, string> },
) => Promise<PyPiExecResult>;

/** A distribution artifact on disk. */
export interface Artifact {
  readonly filename: string;
  readonly path: string;
  readonly kind: 'sdist' | 'wheel';
  readonly sizeBytes: number;
}

/** What PyPI reports about a package version. */
export interface PyPiRelease {
  readonly version: string;
  readonly artifacts: readonly { readonly filename: string; readonly packagetype: string }[];
  readonly uploadTime: string | null;
  readonly yanked: boolean;
}

const DEFAULT_REPOSITORY = 'https://upload.pypi.org/legacy/';
const DEFAULT_READ_HOST = 'https://pypi.org';

async function runnerOf(options: PyPiOptions): Promise<PyPiRunner> {
  if (options.runner !== undefined) return options.runner;
  // Imported lazily so a test can pass a runner without touching the real
  // executor's process handling.
  const { execute } = await import('../../build/exec.js');
  return (command, args, opts) => execute(command, args, opts);
}

/**
 * Normalise a project name the way PEP 503 requires.
 *
 * Re-exported here so callers do not need to know where the rule lives.
 */
export { normalizePackageName };

/**
 * Fetch one release's metadata, or null when the version does not exist.
 *
 * A 404 is the only answer that means "absent". Anything else raises: reporting a
 * version as missing when the registry was unreachable is how a release gets
 * wrongly reported as incomplete, and the advice to re-publish is worse than
 * saying the question could not be answered.
 */
export async function getRelease(
  name: string,
  version: string,
  options: PyPiOptions = {},
): Promise<PyPiRelease | null> {
  const readHost = options.repository?.includes('upload.pypi.org')
    ? DEFAULT_READ_HOST
    : (options.repository ?? DEFAULT_READ_HOST);

  const url = `${readHost.replace(/\/$/, '')}/pypi/${encodeName(name)}/${encodeURIComponent(version)}/json`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // A stale cached 404 for a version published seconds ago would look like a
        // duplicate, so ask explicitly for a fresh answer.
        'cache-control': 'no-cache',
      },
    });
  } catch (cause) {
    const { ForgeError, ErrorCode } = await import('../../errors/index.js');
    throw new ForgeError(ErrorCode.PROVIDER_FAILED, `Could not reach ${readHost}.`, {
      provider: 'pypi',
      operation: 'pypi.getRelease',
      remediation: 'Check network access to pypi.org, then retry.',
      cause,
    });
  }

  if (response.status === 404) return null;

  if (response.status === 401 || response.status === 403) {
    const { AuthError, ErrorCode } = await import('../../errors/index.js');
    throw new AuthError(ErrorCode.AUTH_FAILED, `PyPI refused access to ${name}.`, {
      provider: 'pypi',
      operation: 'pypi.getRelease',
      remediation: 'A token is needed for a private project; reading a public one needs nothing.',
      detail: { package: name, version, status: response.status },
    });
  }

  if (!response.ok) {
    const { ProviderError, ErrorCode } = await import('../../errors/index.js');
    throw new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `PyPI returned ${response.status} for ${name}.`,
      {
        provider: 'pypi',
        operation: 'pypi.getRelease',
        remediation: 'Retry, and check whether the project name is correct.',
        detail: { package: name, version, status: response.status },
      },
    );
  }

  const body = (await response.json()) as {
    info?: { version?: unknown; yanked?: unknown; uploads?: unknown };
    urls?: { filename?: unknown; packagetype?: unknown; upload_time_iso_8601?: unknown }[];
  };

  const info = body.info ?? {};
  const uploads = Array.isArray(info.uploads) ? (info.uploads as string[] | null) : null;

  return {
    version: typeof info.version === 'string' ? info.version : version,
    artifacts: (body.urls ?? [])
      .filter(
        (entry): entry is { filename: string; packagetype: string } =>
          typeof entry.filename === 'string',
      )
      .map((entry) => ({ filename: entry.filename, packagetype: entry.packagetype })),
    uploadTime: uploads?.[0] ?? null,
    yanked: info.yanked === true,
  };
}

/** Every published version of a package, newest first. Null when absent. */
export async function listVersions(
  name: string,
  options: PyPiOptions = {},
): Promise<string[] | null> {
  const readHost = options.repository?.includes('upload.pypi.org')
    ? DEFAULT_READ_HOST
    : (options.repository ?? DEFAULT_READ_HOST);

  const url = `${readHost.replace(/\/$/, '')}/pypi/${encodeName(name)}/json`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
  } catch (cause) {
    const { ForgeError, ErrorCode } = await import('../../errors/index.js');
    throw new ForgeError(ErrorCode.PROVIDER_FAILED, `Could not reach ${readHost}.`, {
      provider: 'pypi',
      operation: 'pypi.listVersions',
      remediation: 'Check network access to pypi.org, then retry.',
      cause,
    });
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    const { ProviderError, ErrorCode } = await import('../../errors/index.js');
    throw new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `PyPI returned ${response.status} for ${name}.`,
      {
        provider: 'pypi',
        operation: 'pypi.listVersions',
        remediation: 'Check the project name.',
        detail: { package: name, status: response.status },
      },
    );
  }

  const body = (await response.json()) as { releases?: Record<string, unknown> };
  return Object.keys(body.releases ?? {});
}

/**
 * Build an sdist and a wheel.
 *
 * Uses `python -m build`, the reference implementation, in an isolated
 * environment. `--outdir` keeps artifacts out of the source tree, and the sdist
 * is built first because `python -m build` produces both when given no target.
 */
export async function buildArtifacts(
  projectRoot: string,
  outDir: string,
  options: PyPiOptions = {},
): Promise<readonly Artifact[]> {
  const runner = await runnerOf(options);

  const result = await runner('python', ['-m', 'build', '--outdir', outDir, projectRoot], {
    cwd: projectRoot,
  });

  if (result.exitCode !== 0) {
    const { CheckError, ErrorCode } = await import('../../errors/index.js');
    throw new CheckError(ErrorCode.CHECK_FAILED, 'Could not build the Python distributions.', {
      provider: 'pypi',
      operation: 'pypi.build',
      remediation:
        'Run `python -m build` yourself for the full error — a missing build backend is the usual cause.',
      detail: {
        exitCode: result.exitCode,
        output: (result.stderr || result.stdout).slice(0, 800),
      },
    });
  }

  const { readdirSync, statSync } = await import('node:fs');
  const { join: joinPath } = await import('node:path');

  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch {
    const { CheckError, ErrorCode } = await import('../../errors/index.js');
    throw new CheckError(
      ErrorCode.CHECK_FAILED,
      'The build reported success but produced no artifacts.',
      {
        provider: 'pypi',
        operation: 'pypi.build',
        remediation:
          'Check that the outdir is writable and that pyproject.toml declares a build backend.',
      },
    );
  }

  const artifacts: Artifact[] = [];
  for (const entry of entries) {
    const kind = artifactKind(entry);
    if (kind === null) continue;
    const path = joinPath(outDir, entry);
    artifacts.push({ filename: entry, path, kind, sizeBytes: statSync(path).size });
  }

  return artifacts;
}

/** Classify a filename, or null when it is not a distribution. */
export function artifactKind(filename: string): Artifact['kind'] | null {
  if (filename.endsWith('.tar.gz') || filename.endsWith('.zip')) return 'sdist';
  if (filename.endsWith('.whl')) return 'wheel';
  return null;
}

/**
 * Validate a set of artifacts before uploading.
 *
 * A PyPI release without both an sdist and a wheel is accepted but awkward to
 * install, and a wheel whose filename disagrees with the sdist's is a packaging
 * bug worth catching here rather than after publishing.
 */
export function validateArtifacts(
  artifacts: readonly Artifact[],
  expectedName: string,
): readonly string[] {
  const problems: string[] = [];

  if (artifacts.length === 0) problems.push('No distributions were built.');

  const sdist = artifacts.filter((a) => a.kind === 'sdist');
  const wheels = artifacts.filter((a) => a.kind === 'wheel');

  if (sdist.length === 0) problems.push('No source distribution (*.tar.gz) was built.');
  if (wheels.length === 0) problems.push('No wheel (*.whl) was built.');
  if (sdist.length > 1) problems.push(`More than one sdist was built (${sdist.length}).`);

  const normalized = normalizePackageName(expectedName);
  for (const artifact of artifacts) {
    if (!artifact.filename.toLowerCase().startsWith(normalized.replace(/-/g, '_'))) {
      // Wheel filenames escape the name as `normalized_with_underscores`, and a
      // name that differs is the packaging bug this check exists for.
      problems.push(`Artifact "${artifact.filename}" does not look like ${expectedName}.`);
    }
    if (artifact.sizeBytes === 0) problems.push(`Artifact "${artifact.filename}" is empty.`);
  }

  return problems;
}

/** Upload artifacts with twine. */
export async function upload(
  name: string,
  version: string,
  artifacts: readonly Artifact[],
  options: PyPiOptions = {},
): Promise<{ repository: string; command: string }> {
  const runner = await runnerOf(options);
  const repository = options.repository ?? DEFAULT_REPOSITORY;

  if (artifacts.length === 0) {
    const { CheckError, ErrorCode } = await import('../../errors/index.js');
    throw new CheckError(ErrorCode.CHECK_FAILED, 'Refusing to upload nothing.', {
      provider: 'pypi',
      operation: 'pypi.upload',
      remediation: 'Build the distributions first: `forge pypi build`.',
    });
  }

  const args = ['upload', '--non-interactive', '--repository-url', repository];

  if (options.dryRun === true) {
    // `--skip-existing` makes the dry run a genuine rehearsal of the check PyPI
    // performs, rather than a no-op that always "succeeds".
    args.push('--skip-existing');
  } else {
    args.push('--disable-progress-bar');
  }

  for (const artifact of artifacts) args.push(artifact.path);

  const result = await runner('twine', args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // The token never appears in argv; twine reads it from the environment.
    env: options.token === undefined ? {} : { TWINE_PASSWORD: options.token },
  });

  if (result.exitCode !== 0) {
    const { normalizeUploadError } = await import('./errors.js');
    throw normalizeUploadError(name, version, result.stderr || result.stdout);
  }

  return { repository, command: `twine ${args.slice(0, 4).join(' ')}` };
}

/** Percent-encode a project name for the JSON API. */
function encodeName(name: string): string {
  return normalizePackageName(name).replace(/[-_.]+/g, '-');
}
