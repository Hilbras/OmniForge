/**
 * The configuration model.
 *
 * Typed shape of `forge.config.yaml` after defaults are applied. Every field is
 * either required or has a documented default, so downstream code never has to
 * test for `undefined` on a well-formed config.
 */

/** Which environment variables hold credentials. */
export type ProviderName = 'github' | 'npm' | 'pypi';

/** Every provider V1 knows about. Drives iteration, never branching. */
export const PROVIDER_NAMES: readonly ProviderName[] = ['github', 'npm', 'pypi'] as const;

/** How the next version is decided. */
export type VersionStrategy = 'semver' | 'manual' | 'none';

/** A configured check: run a command and gate the release on its exit code. */
export interface CheckConfig {
  /** Shell-free argument array. Never interpolated. */
  readonly command: readonly string[];
  /** When true, a failure is recorded but does not halt the release. */
  readonly optional: boolean;
  readonly timeoutMs: number;
}

export interface ProjectConfig {
  readonly name: string;
}

export interface VersionConfig {
  readonly strategy: VersionStrategy;
  /** Where the project's own version lives, e.g. `package.json`. */
  readonly file: string | null;
  /** Prefix for git tags, e.g. `v`. */
  readonly tagPrefix: string;
}

export interface GitHubConfig {
  readonly enabled: boolean;
  readonly repository: string | null;
  /** Name of the env var holding the token. The token itself is never stored. */
  readonly tokenEnv: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  /** Release notes template path, relative to the project root. */
  readonly notesTemplate: string | null;
}

export interface NpmConfig {
  readonly enabled: boolean;
  readonly package: string | null;
  readonly registry: string;
  readonly distTag: string;
  readonly access: 'public' | 'restricted';
  readonly tokenEnv: string;
}

export interface PyPiConfig {
  readonly enabled: boolean;
  readonly package: string | null;
  /** PyPI normalizes `-`, `_`, and `.` to one another; keep the display name. */
  readonly repository: string | null;
  readonly tokenEnv: string;
}

/** A fully resolved, defaulted configuration. */
export interface ForgeConfig {
  readonly project: ProjectConfig;
  readonly version: VersionConfig;
  readonly github: GitHubConfig;
  readonly npm: NpmConfig;
  readonly pypi: PyPiConfig;
  /** Check name to its configuration. */
  readonly checks: Readonly<Record<string, CheckConfig>>;
  /** Provider execution order. Defaults to `github`, `npm`, `pypi`. */
  readonly order: readonly ProviderName[];
  /** Absolute path of the file this came from, or null for defaults. */
  readonly sourcePath: string | null;
  /** Absolute path of the project root. */
  readonly projectRoot: string;
}

/** Defaults applied to every field the user did not set. */
export const DEFAULTS = {
  versionStrategy: 'semver',
  tagPrefix: 'v',
  npmRegistry: 'https://registry.npmjs.org',
  npmDistTag: 'latest',
  npmAccess: 'public',
  checkTimeoutMs: 600_000,
  order: PROVIDER_NAMES,
  tokenEnv: {
    github: 'GITHUB_TOKEN',
    npm: 'NPM_TOKEN',
    pypi: 'PYPI_TOKEN',
  },
} as const satisfies Partial<{
  versionStrategy: VersionStrategy;
  tagPrefix: string;
  npmRegistry: string;
  npmDistTag: string;
  npmAccess: 'public' | 'restricted';
  checkTimeoutMs: number;
  order: readonly ProviderName[];
  tokenEnv: Record<ProviderName, string>;
}>;
