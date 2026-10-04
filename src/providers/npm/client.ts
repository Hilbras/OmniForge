/**
 * npm registry client.
 *
 * Talks to the registry over its HTTP API rather than shelling out to `npm`.
 * The API gives three things the CLI does not: the exact dist-tag a version
 * carries, a clean 403/409 distinction for "already published", and a dry-run
 * that cannot accidentally publish. Publishing still shells out to
 * `npm publish` (below) because that is what handles auth, provenance, and
 * packing correctly.
 */

import { execute } from '../../build/exec.js';
import {
  AuthError,
  DuplicateReleaseError,
  EnvironmentError,
  ErrorCode,
  ProviderError,
  type ForgeError,
} from '../../errors/index.js';

/** Test seam, mirroring the gh client. */
export type NpmRunner = typeof execute;

/** The subset of registry metadata Forge uses. */
export interface PackageInfo {
  readonly name: string;
  readonly latest: string | null;
  /** Every version present in the registry. */
  readonly versions: readonly string[];
  /** Which dist-tag points at which version. */
  readonly distTags: Readonly<Record<string, string>>;
  readonly isPrivate: boolean;
  /** The account that owns the scope, for a scoped package. */
  readonly scope?: string;
}

export interface NpmOptions {
  readonly token?: string | undefined;
  /** Override the registry, for a private mirror or TestPyPI-style host. */
  readonly registry?: string | undefined;
  /** Test seam. Defaults to the real executor. */
  readonly runner?: NpmRunner;
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** npm dist-tags Forge accepts. */
export const VALID_DIST_TAGS = ['latest', 'next', 'beta', 'alpha'] as const;
export type DistTag = (typeof VALID_DIST_TAGS)[number];

/** True when the string is a usable dist-tag. */
export function isDistTag(value: string): value is DistTag {
  return (VALID_DIST_TAGS as readonly string[]).includes(value);
}

/**
 * Choose the dist-tag for a version.
 *
 * A prerelease must never land on `latest`: doing so makes every consumer who
 * runs `npm install` pull an unfinished build. This is the single most
 * important rule in the npm provider.
 */
export function distTagFor(version: string, prerelease: boolean): DistTag {
  if (!prerelease) return 'latest';
  // An explicit -beta or -alpha tag wins; everything else is a next.
  if (/-beta(\.|$)/.test(version)) return 'beta';
  if (/-alpha(\.|$)/.test(version)) return 'alpha';
  return 'next';
}

/**
 * Fetch package metadata.
 *
 * Returns null for a package that does not exist — a normal state for a first
 * release, not an error. A 5xx or a network failure does throw.
 */
export async function getPackage(
  name: string,
  options: NpmOptions = {},
): Promise<PackageInfo | null> {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  // npm's metadata is cached aggressively by intermediaries. A stale copy makes
  // a not-yet-published version look already published, which wrongly refuses an
  // irreversible publish — so the request must not be cacheable. The unique query
  // string defeats a proxy cache; the header alone may not.
  const url = `${registry}/${encodeName(name)}?cachebust=${Date.now().toString(36)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
        ...authHeaders(options.token),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new EnvironmentError(ErrorCode.NETWORK_ERROR, `Could not reach ${registry}.`, {
      provider: 'npm',
      operation: 'npm.getPackage',
      remediation: 'Check network connectivity, or set npm.registry to a reachable mirror.',
      cause: error,
      detail: { registry },
    });
  }

  // 404 means the package does not exist yet.
  if (response.status === 404) return null;

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(ErrorCode.AUTH_FAILED, `No access to ${name}.`, {
      provider: 'npm',
      operation: 'npm.getPackage',
      remediation: 'For a private package the token needs read access; check NPM_TOKEN.',
      detail: { package: name, status: response.status },
    });
  }

  if (!response.ok) {
    throw new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `Registry returned ${response.status} for ${name}.`,
      {
        provider: 'npm',
        operation: 'npm.getPackage',
        remediation:
          response.status >= 500 ? 'npm may be experiencing an outage.' : 'Check the package name.',
        detail: { package: name, status: response.status },
      },
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  const versions = Object.keys(body['versions'] ?? {});
  const distTags = (body['dist-tags'] ?? {}) as Record<string, string>;
  const latest = distTags['latest'] ?? null;

  const scope = name.startsWith('@') ? name.split('/')[0] : undefined;

  return {
    name: typeof body['name'] === 'string' ? body['name'] : name,
    latest,
    versions,
    distTags,
    isPrivate: latest === null && versions.length > 0,
    ...(scope !== undefined ? { scope } : {}),
  };
}

/** True when a version already exists in the registry. */
export async function versionExists(
  name: string,
  version: string,
  options: NpmOptions = {},
): Promise<boolean> {
  const info = await getPackage(name, options);
  return info !== null && info.versions.includes(version);
}

/**
 * The dist-tag a specific version currently carries.
 *
 * Used by verification: publishing `1.2.0` and finding it tagged `next` when
 * it should be `latest` is exactly the kind of drift the integrity check exists
 * to catch.
 */
export async function distTagOf(
  name: string,
  version: string,
  options: NpmOptions = {},
): Promise<string | null> {
  const info = await getPackage(name, options);
  if (info === null) return null;

  for (const [tag, tagged] of Object.entries(info.distTags)) {
    if (tagged === version) return tag;
  }
  return null;
}

/**
 * Move a dist-tag to a version.
 *
 * npm has no "set tag" endpoint; you PUT to `/-/package/<name>/dist-tags/<tag>`.
 */
export async function setDistTag(
  name: string,
  tag: string,
  version: string,
  options: NpmOptions = {},
): Promise<void> {
  const registry = options.registry ?? DEFAULT_REGISTRY;

  const response = await fetch(`${registry}/-/package/${encodeName(name)}/dist-tags/${tag}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(options.token),
    },
    body: JSON.stringify(version),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new ProviderError(ErrorCode.PROVIDER_FAILED, `Could not set ${tag} to ${version}.`, {
      provider: 'npm',
      operation: 'npm.setDistTag',
      remediation: 'Check the token has write access to the package.',
      detail: { package: name, tag, version, status: response.status },
    });
  }
}

/**
 * Remove a dist-tag.
 *
 * A prerelease whose tag is still pointing at it would otherwise install as the
 * default for anyone who ran `npm install @scope/pkg@next`.
 */
export async function removeDistTag(
  name: string,
  tag: string,
  options: NpmOptions = {},
): Promise<boolean> {
  const registry = options.registry ?? DEFAULT_REGISTRY;

  const response = await fetch(`${registry}/-/package/${encodeName(name)}/dist-tags/${tag}`, {
    method: 'DELETE',
    headers: { ...authHeaders(options.token) },
    signal: AbortSignal.timeout(30_000),
  });

  return response.ok;
}

/** Result of a publish attempt. */
export interface PublishOutcome {
  readonly published: boolean;
  readonly version: string;
  readonly distTag: string;
  /** The tarball npm resolved, for the report. */
  readonly tarball: string | null;
}

/**
 * Publish by shelling out to `npm publish`.
 *
 * Delegating to npm rather than uploading the tarball ourselves is deliberate:
 * npm handles auth, the `files` allowlist, provenance attestations, and packing
 * correctly, and reimplementing that would be a worse version of npm.
 *
 * @param dryRun - Passes `--dry-run`, which packs and reports without uploading.
 */
export async function publish(
  name: string,
  version: string,
  distTag: string,
  options: NpmOptions & {
    cwd?: string;
    access?: 'public' | 'restricted';
    dryRun?: boolean;
    registry?: string;
  } = {},
): Promise<PublishOutcome> {
  const runner = options.runner ?? execute;
  const registry = options.registry ?? DEFAULT_REGISTRY;

  const args = [
    'publish',
    '--tag',
    distTag,
    '--registry',
    registry,
    '--access',
    options.access ?? 'public',
  ];
  if (options.dryRun === true) args.push('--dry-run');

  const result = await runner('npm', args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // NPM_TOKEN is what the npm CLI reads; the token never becomes a CLI flag.
    env: options.token === undefined ? {} : { NPM_TOKEN: options.token },
  });

  if (result.exitCode !== 0) {
    throw normalizePublishError(name, version, result.stderr || result.stdout);
  }

  return {
    published: options.dryRun !== true,
    version,
    distTag,
    tarball: extractTarball(result.stdout, version),
  };
}

/**
 * Turn npm's output into a Forge error.
 *
 * npm reports "version already exists" as a 403, which is indistinguishable at a
 * glance from a permissions problem. It is not: it is the single most common
 * outcome of re-running a release, and it deserves its own error code so the CLI
 * can suggest the right thing.
 */
export function normalizePublishError(name: string, version: string, output: string): ForgeError {
  const text = output.toLowerCase();

  if (
    text.includes('cannot publish over') ||
    text.includes('previously published versions') ||
    text.includes('e409') ||
    text.includes('you cannot publish')
  ) {
    return new DuplicateReleaseError(`${name}@${version} is already published.`, {
      provider: 'npm',
      operation: 'npm.publish',
      remediation:
        'npm does not allow overwriting a version. Choose a higher one, or unpublish first if you are certain.',
      detail: { package: name, version },
    });
  }

  // npm puts the error code on its own line, separate from the prose message, so
  // both are checked. `ENEEDAUTH` and the "must be logged in" phrasing are the
  // two forms a real auth failure takes.
  if (
    text.includes('eneedauth') ||
    text.includes('need auth') ||
    // npm emits both "You need to be logged in" and "You must be logged in";
    // matching only one phrasing let the other fall through to the generic
    // branch and report a permissions problem as an unexplained failure.
    text.includes('be logged in') ||
    text.includes('403 forbidden') ||
    // A 403 is a permissions problem — but only once a duplicate has been ruled
    // out above. npm emits 403 alongside E409 for a duplicate publish on a
    // scoped package, and calling that an auth failure tells the user to fix a
    // token that is working perfectly.
    text.includes('403')
  ) {
    return new AuthError(ErrorCode.AUTH_FAILED, `npm refused to publish ${name}.`, {
      provider: 'npm',
      operation: 'npm.publish',
      remediation:
        'Check NPM_TOKEN has write access, and that 2FA is satisfied (auth-and-publish mode).',
      detail: { package: name, output: output.trim().slice(0, 400) },
    });
  }

  if (text.includes('e402') || text.includes('payment required')) {
    return new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `npm requires payment to publish ${name}.`,
      {
        provider: 'npm',
        operation: 'npm.publish',
        remediation: 'Private packages require a paid plan on npm.',
        detail: { package: name },
      },
    );
  }

  // `ETARGET` is npm's "no matching version found", which is what a publish of a
  // version the registry cannot resolve actually produces. It was falling through
  // to the generic branch, telling the user to run npm manually for an error with
  // a known cause.
  if (text.includes('etarget') || text.includes('no matching version')) {
    return new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      `npm could not resolve ${name}@${version}.`,
      {
        provider: 'npm',
        operation: 'npm.publish',
        remediation:
          'Check that npm.package and the version in package.json match a resolvable registry entry.',
        detail: { package: name, version },
      },
    );
  }

  if (text.includes('e404') || text.includes('404 not found')) {
    return new ProviderError(ErrorCode.PROVIDER_FAILED, `npm could not find ${name}.`, {
      provider: 'npm',
      operation: 'npm.publish',
      remediation: 'Check npm.package in forge.config.yaml.',
      detail: { package: name },
    });
  }

  return new ProviderError(
    ErrorCode.PROVIDER_FAILED,
    `npm publish failed for ${name}@${version}.`,
    {
      provider: 'npm',
      operation: 'npm.publish',
      remediation: "Run `npm publish` manually to see npm's full output.",
      detail: { package: name, version, output: output.trim().slice(0, 800) },
    },
  );
}

/** Validate a package name against npm's rules, as a fast local failure. */
export function validatePackageName(name: string): string | null {
  if (name.length === 0) return 'Package name must not be empty.';

  // npm's own limit, and the reason long scoped names fail confusingly.
  if (name.length > 214) return `Package name is ${name.length} characters; npm allows 214.`;

  if (name.startsWith('.') || name.startsWith('_')) {
    return 'Package name must not start with "." or "_".';
  }

  // Scope handling. `@acme` has no name, and `@/sdk` has no scope — both are
  // rejected by npm, and both previously slipped through: the empty scope made
  // the name look unscoped-and-valid once the `@` was taken as a prefix.
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) {
      return 'Scoped package names need a scope and a name, e.g. @hilbras/forge.';
    }
    const scope = name.slice(1, slash);
    const body = name.slice(slash + 1);
    if (scope.length === 0)
      return 'Scoped package names need a scope before the "@", e.g. @hilbras/forge.';
    if (body.length === 0) return 'Scoped package names need a name after the scope.';
  }

  const body = name.startsWith('@') ? (name.split('/')[1] ?? '') : name;
  if (body.length === 0) {
    return 'Package name must have a name after the scope.';
  }

  // npm allows lowercase, digits, and -._~ plus @/ in a scope.
  if (!/^[a-z0-9\-._~]+$/.test(body.toLowerCase())) {
    return `Package name "${name}" contains characters npm does not allow.`;
  }

  return null;
}

/** Extract the tarball URL npm printed, for the report. */
function extractTarball(output: string, version: string): string | null {
  const match = new RegExp(
    `https://[^\\s]*${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.tgz`,
  ).exec(output);
  return match?.[0] ?? null;
}

/** Percent-encode a package name for a registry URL: `@a/b` → `@a%2Fb`. */
export function encodeName(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** Authorization headers. Omitted entirely when no token is available. */
function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined || token.length === 0 ? {} : { authorization: `Bearer ${token}` };
}
