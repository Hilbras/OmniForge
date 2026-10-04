/**
 * `forge init` — write a starter forge.config.yaml.
 *
 * The first command a user runs, so it has to do the obvious thing: look at the
 * directory, work out what kind of project it is, and write a config that is
 * already correct rather than a blank template to fill in.
 *
 * Ecosystems are described as data, not as branches. An earlier version switched
 * on the strings "npm" and "python", which is the coupling §4.1 forbids: adding a
 * Rust or Go project would have meant editing this file's conditionals. Adding
 * one is now a row in ECOSYSTEMS.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import type { Command } from 'commander';

import { discoverConfig } from '../../configuration/loader.js';
import { PROVIDER_NAMES, type ProviderName } from '../../configuration/schema.js';
import { ExitCode } from '../exit-codes.js';

export interface InitCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly palette: Palette;
}

/** How one ecosystem is detected and written. */
interface Ecosystem {
  readonly id: string;
  /** Filename whose presence identifies the project. */
  readonly marker: string;
  /** The provider that publishes this ecosystem's artifacts. */
  readonly provider: ProviderName;
  /** Where the version lives. */
  readonly versionFile: string;
  /** Extract name and version from the marker file. */
  readonly read: (contents: string) => { name: string | null; version: string | null };
  /**
   * Which of `test`/`lint`/`build` this project can actually run.
   *
   * Returns null when the ecosystem does not name its scripts the way npm does —
   * a Python project's tooling is pytest or whatever it uses, and guessing npm
   * script names for it would enable checks that cannot run.
   */
  readonly scripts: ((contents: string) => ReadonlySet<string>) | null;
  /** Normalise a package name for this ecosystem's registry. */
  readonly normalize: (name: string) => string;
}

const NO_METADATA: { name: string | null; version: string | null } = { name: null, version: null };

const readPackageJson = (contents: string): { name: string | null; version: string | null } => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null) return NO_METADATA;
    const record = parsed as { name?: unknown; version?: unknown };
    return {
      name: typeof record.name === 'string' ? record.name : null,
      version: typeof record.version === 'string' ? record.version : null,
    };
  } catch {
    // A malformed manifest must not stop someone generating a config.
    return NO_METADATA;
  }
};

/** The npm scripts a package.json declares. */
const npmScripts = (contents: string): ReadonlySet<string> => {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null) return new Set();
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== 'object' || scripts === null) return new Set();
    return new Set(Object.keys(scripts));
  } catch {
    return new Set();
  }
};

const readPyProject = (contents: string): { name: string | null; version: string | null } => {
  try {
    const parsed = parseToml(contents) as { project?: { name?: unknown; version?: unknown } };
    return {
      name: typeof parsed.project?.name === 'string' ? parsed.project.name : null,
      version: typeof parsed.project?.version === 'string' ? parsed.project.version : null,
    };
  } catch {
    return NO_METADATA;
  }
};

/**
 * Known ecosystems, in detection order.
 *
 * Adding one is a row here, not a new `if` — which is what keeps this file free of
 * the platform branching the architecture test forbids.
 */
const ECOSYSTEMS: readonly Ecosystem[] = [
  {
    id: 'npm',
    marker: 'package.json',
    provider: 'npm',
    versionFile: 'package.json',
    read: readPackageJson,
    // Which npm scripts exist, so a generated `checks:` section does not enable a
    // test that is not there. `checks: { test: true }` expands to `npm test`, and
    // a project with no test script then fails its first `forge check` with
    // "Missing script: test" — a confusing way to learn your config is guesswork.
    scripts: (contents) => npmScripts(contents),
    normalize: (name) => name,
  },
  {
    id: 'python',
    marker: 'pyproject.toml',
    provider: 'pypi',
    versionFile: 'pyproject.toml',
    read: readPyProject,
    scripts: null,
    // PEP 503: PyPI treats Foo.Bar and foo-bar as the same name.
    normalize: (name) => name.toLowerCase().replace(/[-_.]+/g, '-'),
  },
];

/**
 * How each provider is written into a generated config.
 *
 * Data, not conditionals: the architecture test forbids platform names in
 * conditionals, and an `if (provider === 'npm')` here would be exactly the
 * coupling it exists to catch.
 */
const PROVIDER_SETTINGS: Record<
  ProviderName,
  { writtenSeparately: boolean; extraLines: readonly string[] }
> = {
  // GitHub's `repository` needs prose ("set this before releasing"), so it is
  // written above rather than generated from a table row.
  github: { writtenSeparately: true, extraLines: [] },
  npm: {
    writtenSeparately: false,
    extraLines: ['  registry: https://registry.npmjs.org', '  distTag: latest'],
  },
  pypi: { writtenSeparately: false, extraLines: [] },
};

/** What `forge init` could work out about the project. */
export interface DetectedProject {
  readonly name: string;
  /** A detected version, if any. */
  readonly version: string | null;
  /** The matched ecosystem, or null for an unrecognised directory. */
  readonly ecosystem: Ecosystem | null;
  readonly ecosystemId: string;
  readonly hasTests: boolean;
  readonly hasLint: boolean;
  readonly hasBuild: boolean;
  /** Which of `test`/`lint`/`build` the project can actually run. */
  readonly availableScripts: ReadonlySet<string>;
  /**
   * Whether the project names its scripts at all.
   *
   * Distinct from an empty set: "this package declares no scripts" means a
   * missing `test` script is not the project's intent, whereas "there is no
   * manifest here" means there is nothing to consult and a guess is all there is.
   */
  readonly declaresScripts: boolean;
}

/**
 * Detect the project from what is on disk.
 *
 * Only reads files, never runs a build tool — `forge init` must be fast and must
 * have no side effects beyond writing one config.
 */
export function detectProject(cwd: string): DetectedProject {
  const found = ECOSYSTEMS.find((eco) => existsSync(join(cwd, eco.marker)));
  const contents = found ? readFileSync(join(cwd, found.marker), 'utf8') : null;
  const read = found === undefined || contents === null ? NO_METADATA : found.read(contents);

  return {
    // Prefer an explicit package name: `@scope/pkg` in the manifest is what gets
    // published, and the directory is often just `repo`.
    name: read.name ?? basename(cwd),
    version: read.version,
    ecosystem: found ?? null,
    ecosystemId: found?.id ?? 'unknown',
    hasTests: ECOSYSTEMS.some((eco) => existsSync(join(cwd, eco.marker))),
    hasLint: existsSync(join(cwd, 'eslint.config.js')) || existsSync(join(cwd, '.eslintrc.json')),
    hasBuild: existsSync(join(cwd, 'tsconfig.json')),
    availableScripts:
      found === undefined || contents === null || found.scripts === null
        ? new Set<string>()
        : found.scripts(contents),
    declaresScripts: found !== undefined && contents !== null && found.scripts !== null,
  };
}

/** Render a config for a detected project. */
export function renderConfig(project: DetectedProject, tagPrefix = 'v'): string {
  const eco = project.ecosystem;
  // With no recognised ecosystem the config still has to pick a publisher, and npm
  // is the documented default.
  const publisher = eco?.provider ?? 'npm';

  const lines: string[] = [
    '# Forge configuration.',
    '#',
    '# Every value below was detected by `forge init`. Edit freely, then run',
    '# `forge config validate` to check it.',
    '',
    'project:',
    `  name: ${quoteIfNeeded(project.name)}`,
    '',
    'version:',
    '  strategy: semver',
    `  file: ${eco?.versionFile ?? 'package.json'}`,
    `  tagPrefix: ${tagPrefix}`,
    '',
    'github:',
    '  enabled: true',
    '  # repository: owner/name   <- set this before releasing',
    '',
  ];

  // Every provider is written explicitly, so the file reads top to bottom
  // instead of hiding several `enabled:` flags that mostly say false.
  for (const provider of PROVIDER_NAMES) {
    const settings = PROVIDER_SETTINGS[provider];
    // github is written above, with a placeholder for the repository — wording no
    // table entry could supply well.
    if (settings.writtenSeparately) continue;

    const isPublisher = provider === publisher;
    lines.push(`${provider}:`, `  enabled: ${isPublisher}`);
    if (isPublisher) {
      lines.push(`  package: '${eco === null ? project.name : eco.normalize(project.name)}'`);
    }
    lines.push(...settings.extraLines);
    lines.push('');
  }

  // A check is only enabled when the project can actually run it. Enabling
  // `test: true` in a project with no test script produces "Missing script:
  // test" on the first run, which reads as "forge is broken" rather than "this
  // check does not apply here".
  const checks = renderChecks(project);

  lines.push(
    'checks:',
    ...checks.map(([name, enabled]) => `  ${name}: ${enabled}`),
    '',
    'order:',
    '  - github',
  );
  if (eco !== null) lines.push(`  - ${eco.provider}`);

  return `${lines.join('\n')}\n`;
}

/**
 * Write a detected starter config, refusing to clobber an existing one.
 *
 * Shared by `forge init` and the `forge config init` alias, so the two names
 * cannot drift apart.
 */
export function writeStarterConfig(c: TerminalConsole, force: boolean): void {
  const cwd = process.cwd();
  const target = join(cwd, 'forge.config.yaml');
  const discovery = discoverConfig(cwd);

  // The warning comes first. A "file exists" message printed after a paragraph of
  // detail gets skimmed past, and the user then wonders why nothing was written.
  if (discovery.path !== null && !force) {
    c.warning(`${discovery.path} already exists.`);
    c.detailError('Pass --force to overwrite it, or edit that file directly.');
    process.exitCode = ExitCode.Config;
    return;
  }

  const project = detectProject(cwd);

  c.heading('Forge init');
  c.line(`directory    ${cwd}`);
  c.line(`name         ${project.name}`);
  c.line(`ecosystem    ${project.ecosystemId}`);
  if (project.version !== null) c.line(`version      ${project.version}`);
  const enabled = renderChecks(project)
    .filter(([, on]) => on)
    .map(([name]) => name);
  c.line(`checks       ${enabled.length === 0 ? 'none' : enabled.join(', ')}`);

  c.blank();
  writeFileSync(target, renderConfig(project), { encoding: 'utf8' });
  c.success(`Wrote ${target}`);

  if (project.ecosystem === null) {
    c.blank();
    c.warning('No package.json or pyproject.toml found.');
    c.detailError('The config assumes npm; adjust it, or run forge init inside a project.');
  }

  c.blank();
  c.detail('Next:');
  c.line('  forge config validate');
  c.line('  forge check');
  c.line('  forge release --dry-run');
}

/** Attach the `init` command. */
export function registerInitCommand(program: Command, deps: InitCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text: string): string => globalSecrets.redact(text),
    });

  program
    .command('init')
    .description('Create a forge.config.yaml for this project')
    .option('--force', 'Overwrite an existing config')
    .addHelpText(
      'after',
      `
Reads package.json or pyproject.toml to fill the config in, then shows what it
detected before writing.

github.repository is deliberately left as a comment: a guessed owner/name
silently pointed at the wrong repository is worse than an obvious blank, and
forge will refuse to release until you fill it in.

Never overwrites an existing config without --force.

Examples:
  $ forge init
  $ forge init --force
  $ cd new-project && forge init
`,
    )
    .action((flags: Record<string, boolean>) => {
      writeStarterConfig(out(), flags['force'] === true);
    });
}

/**
 * The three checks and whether each is enabled, in display order.
 *
 * A project that declares its scripts is trusted: only scripts that exist are
 * enabled, because `test: true` expands to `npm test` and a missing script fails
 * with "Missing script: test" — which reads as a broken install rather than a
 * check that does not apply here.
 *
 * A project that declares no scripts at all — a Python package, or a directory
 * with nothing in it — has nothing to be wrong about, so the file-presence
 * heuristics stand in and give a starting point.
 */
function renderChecks(project: DetectedProject): readonly (readonly [string, boolean])[] {
  const declaresScripts = project.declaresScripts;
  const can = (script: string, fallback: boolean): boolean => {
    if (!declaresScripts) return fallback;
    return project.availableScripts.has(script);
  };
  return [
    ['test', can('test', project.hasTests)],
    ['lint', can('lint', project.hasLint)],
    ['build', can('build', project.hasBuild)],
  ];
}

function quoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value}'`;
}
