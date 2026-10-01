/**
 * Turning a raw document into a fully-defaulted `ForgeConfig`.
 *
 * Everything downstream — the release engine, the CLI, the providers — reads
 * this shape, never the raw YAML. That is what lets `validateRaw` be strict
 * about what the user may write while consumers see only well-formed values.
 */

import { dirname, resolve } from 'node:path';

import { ConfigError, ErrorCode } from '../errors/index.js';
import {
  DEFAULTS,
  PROVIDER_NAMES,
  type CheckConfig,
  type ForgeConfig,
  type ProviderName,
} from './schema.js';
import { discoverConfig, loadConfigFile } from './loader.js';

/** CLI flags that override configuration values. */
export interface Overrides {
  readonly registry?: string;
  readonly distTag?: string;
  readonly repository?: string;
  readonly projectName?: string;
  readonly tagPrefix?: string;
  /** Run only these providers, in this order. */
  readonly providers?: readonly string[];
}

/** Load, validate, and apply defaults. */
export function resolveConfig(
  options: {
    /** Explicit `--config` path. When absent, discovery walks up from cwd. */
    configPath?: string | undefined;
    cwd?: string;
    overrides?: Overrides;
  } = {},
): ForgeConfig {
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.configPath;

  if (explicit !== undefined) {
    // An explicit path must exist. Silently falling back to defaults when the
    // user named a file would release the wrong thing.
    return build(readRaw(explicit), dirname(resolve(explicit)), options.overrides, explicit);
  }

  const discovery = discoverConfig(cwd);
  if (discovery.path === null) {
    return build({}, cwd, options.overrides);
  }
  return build(readRaw(discovery.path), discovery.projectRoot, options.overrides, discovery.path);
}

/** Parse and validate a config file, returning the raw document. */
function readRaw(path: string): Record<string, unknown> {
  return loadConfigFile(path).raw;
}

/** Assemble the defaulted config. Exported for tests. */
export function build(
  raw: Record<string, unknown>,
  projectRoot: string,
  overrides: Overrides = {},
  sourcePath: string | null = null,
): ForgeConfig {
  const projectSection = section(raw['project']);
  const project = {
    name:
      overrides.projectName ??
      str(projectSection, 'name') ??
      // Falling back to the directory name keeps `forge` usable in a project
      // that has not written a config name yet.
      projectRoot.split('/').filter(Boolean).pop() ??
      'unnamed-project',
  };

  const versionSection = section(raw['version']);
  const version = {
    strategy: (str(versionSection, 'strategy') ??
      DEFAULTS.versionStrategy) as ForgeConfig['version']['strategy'],
    file: str(versionSection, 'file') ?? null,
    tagPrefix: overrides.tagPrefix ?? str(versionSection, 'tagPrefix') ?? DEFAULTS.tagPrefix,
  };

  const githubSection = section(raw['github']);
  const github = {
    enabled: bool(githubSection, 'enabled') ?? false,
    repository: overrides.repository ?? str(githubSection, 'repository') ?? null,
    tokenEnv: str(githubSection, 'tokenEnv') ?? DEFAULTS.tokenEnv.github,
    draft: bool(githubSection, 'draft') ?? false,
    prerelease: bool(githubSection, 'prerelease') ?? false,
    notesTemplate: str(githubSection, 'notesTemplate') ?? null,
  };

  const npmSection = section(raw['npm']);
  const npm = {
    enabled: bool(npmSection, 'enabled') ?? false,
    package: str(npmSection, 'package') ?? null,
    registry: overrides.registry ?? str(npmSection, 'registry') ?? DEFAULTS.npmRegistry,
    distTag: overrides.distTag ?? str(npmSection, 'distTag') ?? DEFAULTS.npmDistTag,
    access: (str(npmSection, 'access') ?? DEFAULTS.npmAccess) as 'public' | 'restricted',
    tokenEnv: str(npmSection, 'tokenEnv') ?? DEFAULTS.tokenEnv.npm,
  };

  const pypiSection = section(raw['pypi']);
  const pypi = {
    enabled: bool(pypiSection, 'enabled') ?? false,
    package: str(pypiSection, 'package') ?? null,
    repository: str(pypiSection, 'repository') ?? null,
    tokenEnv: str(pypiSection, 'tokenEnv') ?? DEFAULTS.tokenEnv.pypi,
  };

  const checks = buildChecks(raw['checks']);

  // An enabled provider with no target is a misconfiguration, not something to
  // silently skip: the user asked for a publish that cannot happen.
  assertTargetable('github', github.enabled, github.repository);
  assertTargetable('npm', npm.enabled, npm.package);
  assertTargetable('pypi', pypi.enabled, pypi.package ?? pypi.repository);

  const order = buildOrder(raw['order'], overrides.providers);

  return {
    project,
    version,
    github,
    npm,
    pypi,
    checks,
    order,
    sourcePath,
    projectRoot,
  };
}

/** Expand the `checks` shorthand into full `CheckConfig` objects. */
function buildChecks(raw: unknown): Record<string, CheckConfig> {
  const source = section(raw);
  const out: Record<string, CheckConfig> = {};

  for (const [name, value] of Object.entries(source)) {
    // `test: true` means "run the package's own script".
    if (typeof value === 'boolean') {
      out[name] = {
        command: defaultCommandFor(name),
        optional: !value,
        timeoutMs: DEFAULTS.checkTimeoutMs,
      };
      continue;
    }

    const entry = section(value);
    const command = Array.isArray(entry['command'])
      ? (entry['command'] as string[]).filter((p): p is string => typeof p === 'string')
      : defaultCommandFor(name);

    const timeout =
      typeof entry['timeoutMs'] === 'number' ? entry['timeoutMs'] : DEFAULTS.checkTimeoutMs;
    const optional = typeof entry['optional'] === 'boolean' ? entry['optional'] : false;

    out[name] = { command, optional, timeoutMs: timeout };
  }

  return out;
}

/** The script a bare `test: true` or `lint: true` implies for a Node project. */
function defaultCommandFor(name: string): string[] {
  switch (name) {
    case 'test':
      return ['npm', 'test'];
    case 'lint':
      return ['npm', 'run', 'lint'];
    case 'build':
      return ['npm', 'run', 'build'];
    case 'typecheck':
      return ['npm', 'run', 'typecheck'];
    default:
      return ['npm', 'run', name];
  }
}

/** Merge configured order, `--provider` flags, and defaults. */
function buildOrder(
  raw: unknown,
  providerFilter: readonly string[] | undefined,
): readonly ProviderName[] {
  if (providerFilter !== undefined && providerFilter.length > 0) {
    for (const entry of providerFilter) {
      if (!PROVIDER_NAMES.includes(entry as ProviderName)) {
        throw new ConfigError(ErrorCode.CONFIG_INVALID, `Unknown provider "${entry}".`, {
          remediation: `Known providers: ${PROVIDER_NAMES.join(', ')}.`,
        });
      }
    }
    return providerFilter as readonly ProviderName[];
  }

  const configured = Array.isArray(raw)
    ? raw.filter((entry): entry is ProviderName => PROVIDER_NAMES.includes(entry as ProviderName))
    : [];

  return configured.length > 0 ? configured : DEFAULTS.order;
}

function assertTargetable(name: string, enabled: boolean, target: string | null | undefined): void {
  if (enabled && (target === null || target === undefined || target.length === 0)) {
    throw new ConfigError(
      ErrorCode.CONFIG_INVALID,
      `${name} is enabled but no target is configured.`,
      {
        remediation: `Set ${name}.package (or ${name}.repository) to what should be published.`,
        detail: { provider: name },
      },
    );
  }
}

function section(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === 'boolean' ? value : undefined;
}
