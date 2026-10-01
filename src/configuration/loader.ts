/**
 * Config discovery, loading, and validation.
 *
 * Discovery walks up from the working directory looking for `forge.config.yaml`,
 * the same way git finds `.git`. That makes `forge release` work from any
 * subdirectory of a project, which is what users expect from a repo-wide tool.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { ConfigError, ErrorCode } from '../errors/index.js';
import { isSecretName, maskSecret } from '../utils/index.js';
import {
  PROVIDER_NAMES,
  type CheckConfig,
  type ForgeConfig,
  type GitHubConfig,
  type NpmConfig,
  type ProjectConfig,
  type ProviderName,
  type PyPiConfig,
  type VersionConfig,
  type VersionStrategy,
} from './schema.js';

export const CONFIG_FILENAMES = ['forge.config.yaml', 'forge.config.yml'] as const;

/** Deep directory search stops here, so a config above $HOME is never adopted. */
const DISCOVERY_STOP = resolve(process.env['HOME'] ?? process.cwd());

/** Where a config was found, or the default location when none exists. */
export interface DiscoveryResult {
  readonly path: string | null;
  readonly projectRoot: string;
}

/**
 * Walk up from `startDir` looking for a config file.
 *
 * Stops at `$HOME` so running Forge outside any project never adopts an
 * unrelated config from a parent directory.
 */
export function discoverConfig(startDir: string = process.cwd()): DiscoveryResult {
  let dir = resolve(startDir);

  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return { path: candidate, projectRoot: dir };
      }
    }

    const parent = dirname(dir);
    if (dir === DISCOVERY_STOP || parent === dir) break;
    dir = parent;
  }

  return { path: null, projectRoot: resolve(startDir) };
}

/** One problem found while validating. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly expected?: string;
  readonly received?: string;
}

/** Aggregated validation result. */
export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

const VALID_STRATEGIES: readonly VersionStrategy[] = ['semver', 'manual', 'none'];
const VALID_TAGS = ['latest', 'next', 'beta', 'alpha'] as const;

/** True for `owner/name`, the only repository form the providers accept. */
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

/**
 * Validate a raw parsed YAML document.
 *
 * Every issue is collected rather than throwing on the first, so one run tells
 * the user everything that is wrong instead of making them fix problems one at
 * a time.
 */
export function validateRaw(raw: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (raw === null || raw === undefined) {
    return { valid: true, issues };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      issues: [
        { path: '<root>', message: 'Configuration must be a mapping', received: describe(raw) },
      ],
    };
  }

  const doc = raw as Record<string, unknown>;

  // project.name — the only truly required field.
  const project = doc['project'];
  if (project !== undefined) {
    if (!isRecord(project)) {
      issues.push({ path: 'project', message: 'Must be a mapping', received: describe(project) });
    } else {
      const name = project['name'];
      if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
        issues.push({
          path: 'project.name',
          message: 'Must be a non-empty string',
          expected: 'a non-empty string',
          received: describe(name),
        });
      }
    }
  }

  // version
  const version = doc['version'];
  if (version !== undefined) {
    if (!isRecord(version)) {
      issues.push({ path: 'version', message: 'Must be a mapping', received: describe(version) });
    } else {
      const strategy = version['strategy'];
      if (strategy !== undefined && !VALID_STRATEGIES.includes(strategy as VersionStrategy)) {
        issues.push({
          path: 'version.strategy',
          message: `Unknown strategy "${describe(strategy)}"`,
          expected: VALID_STRATEGIES.join(', '),
          received: describe(strategy),
        });
      }
      const file = version['file'];
      if (file !== undefined && (typeof file !== 'string' || file.length === 0)) {
        issues.push({
          path: 'version.file',
          message: 'Must be a non-empty string path',
          expected: 'a non-empty string',
          received: describe(file),
        });
      }
    }
  }

  // providers
  for (const name of PROVIDER_NAMES) {
    const section = doc[name];
    if (section === undefined) continue;
    if (!isRecord(section)) {
      issues.push({ path: name, message: 'Must be a mapping', received: describe(section) });
      continue;
    }
    issues.push(...validateProviderSection(name, section));
  }

  // checks
  const checks = doc['checks'];
  if (checks !== undefined) {
    if (!isRecord(checks)) {
      issues.push({ path: 'checks', message: 'Must be a mapping', received: describe(checks) });
    } else {
      for (const [checkName, value] of Object.entries(checks)) {
        const path = `checks.${checkName}`;
        if (value === true || value === false) continue; // shorthand: test/lint/build
        if (!isRecord(value)) {
          issues.push({ path, message: 'Must be a mapping or boolean', received: describe(value) });
          continue;
        }
        const command = value['command'];
        if (command !== undefined) {
          // An array is required, never a string: a string would invite shell
          // interpolation, which the security spec forbids.
          if (!Array.isArray(command)) {
            issues.push({
              path: `${path}.command`,
              message: 'Must be an argument array, not a string',
              expected: '["npm", "test"]',
              received: describe(command),
            });
          } else if (command.some((part) => typeof part !== 'string')) {
            issues.push({
              path: `${path}.command`,
              message: 'Every argument must be a string',
              received: describe(command),
            });
          } else if (command.length === 0) {
            issues.push({ path: `${path}.command`, message: 'Must not be empty' });
          }
        }
        const timeout = value['timeoutMs'];
        if (timeout !== undefined && (typeof timeout !== 'number' || timeout <= 0)) {
          issues.push({
            path: `${path}.timeoutMs`,
            message: 'Must be a positive number of milliseconds',
            expected: '> 0',
            received: describe(timeout),
          });
        }
      }
    }
  }

  // order
  const order = doc['order'];
  if (order !== undefined) {
    if (!Array.isArray(order)) {
      issues.push({
        path: 'order',
        message: 'Must be an array of provider names',
        received: describe(order),
      });
    } else {
      for (const entry of order) {
        if (!PROVIDER_NAMES.includes(entry as ProviderName)) {
          issues.push({
            path: 'order',
            message: `Unknown provider "${describe(entry)}"`,
            expected: PROVIDER_NAMES.join(', '),
            received: describe(entry),
          });
        }
      }
      if (new Set(order).size !== order.length) {
        issues.push({ path: 'order', message: 'Contains duplicate entries' });
      }
    }
  }

  // A credential in the config file is a design error, not a usage error.
  scanForSecrets(doc, '', issues);

  return { valid: issues.length === 0, issues };
}

/** Provider-specific validation. */
function validateProviderSection(
  name: ProviderName,
  section: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const enabled = section['enabled'];
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    issues.push({
      path: `${name}.enabled`,
      message: 'Must be a boolean',
      expected: 'true | false',
      received: describe(enabled),
    });
  }

  const tokenEnv = section['tokenEnv'];
  if (tokenEnv !== undefined) {
    if (typeof tokenEnv !== 'string' || tokenEnv.length === 0) {
      issues.push({
        path: `${name}.tokenEnv`,
        message: 'Must be an environment variable name',
        expected: 'e.g. GITHUB_TOKEN',
        received: describe(tokenEnv),
      });
    } else if (isSecretName(tokenEnv)) {
      // Valid — this is the supported way to point at a credential.
      if (tokenEnv === 'NODE_OPTIONS' || tokenEnv === 'PATH') {
        issues.push({
          path: `${name}.tokenEnv`,
          message: 'Refusing to use a non-credential variable',
          received: tokenEnv,
        });
      }
    }
  }

  if (name === 'github') {
    const repository = section['repository'];
    if (repository !== undefined) {
      if (typeof repository !== 'string' || !REPO_PATTERN.test(repository)) {
        issues.push({
          path: 'github.repository',
          message: 'Must be in "owner/name" form',
          expected: 'owner/name',
          received: describe(repository),
        });
      }
    }
  }

  if (name === 'npm') {
    const pkg = section['package'];
    if (pkg !== undefined && (typeof pkg !== 'string' || pkg.length === 0)) {
      issues.push({
        path: 'npm.package',
        message: 'Must be a non-empty package name',
        received: describe(pkg),
      });
    }
    const registry = section['registry'];
    if (registry !== undefined && (typeof registry !== 'string' || !registry.startsWith('http'))) {
      issues.push({
        path: 'npm.registry',
        message: 'Must be an http(s) URL',
        expected: 'https://registry.npmjs.org',
        received: describe(registry),
      });
    }
    const distTag = section['distTag'];
    if (distTag !== undefined && !VALID_TAGS.includes(distTag as (typeof VALID_TAGS)[number])) {
      issues.push({
        path: 'npm.distTag',
        message: `Unknown dist-tag "${describe(distTag)}"`,
        expected: VALID_TAGS.join(', '),
        received: describe(distTag),
      });
    }
  }

  if (name === 'pypi') {
    const pkg = section['package'];
    if (pkg !== undefined && (typeof pkg !== 'string' || pkg.length === 0)) {
      issues.push({
        path: 'pypi.package',
        message: 'Must be a non-empty distribution name',
        received: describe(pkg),
      });
    }
  }

  return issues;
}

/**
 * Reject credentials stored in the config file.
 *
 * The security spec says credentials must never live in config. A key that looks
 * like a secret holding a literal value is reported even when the user did not
 * name it explicitly, since that is exactly how they end up committed.
 */
function scanForSecrets(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, i) => scanForSecrets(entry, `${path}[${i}]`, issues));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (isSecretName(key) && typeof entry === 'string' && entry.length > 0) {
      issues.push({
        path: childPath,
        message:
          'Credentials must not be stored in configuration. Point to an environment variable instead',
        expected: 'e.g. tokenEnv: GITHUB_TOKEN',
        received: maskSecret(entry),
      });
    }
    scanForSecrets(entry, childPath, issues);
  }
}

/** Load and validate a config file. */
export function loadConfigFile(path: string): {
  raw: Record<string, unknown>;
  projectRoot: string;
} {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new ConfigError(ErrorCode.CONFIG_INVALID, `Cannot read ${path}.`, {
      remediation: 'Check the file exists and is readable.',
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(ErrorCode.CONFIG_PARSE_ERROR, `${path} is not valid YAML: ${message}`, {
      remediation: 'Fix the YAML syntax, then run `forge config validate`.',
      cause: error,
    });
  }

  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (!isRecord(parsed)) {
    throw new ConfigError(
      ErrorCode.CONFIG_INVALID,
      `${path} must contain a mapping at the top level.`,
      { remediation: 'Indentation or a stray character is the usual cause.' },
    );
  }

  const validation = validateRaw(parsed);
  if (!validation.valid) {
    throw new ConfigError(ErrorCode.CONFIG_INVALID, formatIssues(path, validation.issues), {
      remediation: 'Fix the fields above, or run `forge config validate` for details.',
      detail: { issues: validation.issues },
    });
  }

  return { raw: parsed, projectRoot: dirname(resolve(path)) };
}

/** Render issues as an actionable multi-line message. */
export function formatIssues(path: string, issues: readonly ValidationIssue[]): string {
  const lines = [
    `${path} has ${issues.length} configuration ${issues.length === 1 ? 'problem' : 'problems'}:`,
  ];
  for (const issue of issues) {
    lines.push(`  ${issue.path}: ${issue.message}`);
    if (issue.expected !== undefined || issue.received !== undefined) {
      const expected = issue.expected ?? 'anything';
      const received = issue.received ?? 'nothing';
      lines.push(`    expected ${expected}, received ${received}`);
    }
  }
  return lines.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Short, non-secret description of a value for an error message. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string')
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  return typeof value;
}

export type {
  ForgeConfig,
  CheckConfig,
  GitHubConfig,
  NpmConfig,
  PyPiConfig,
  ProjectConfig,
  VersionConfig,
};
