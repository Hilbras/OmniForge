/**
 * `forge version` — inspect and compute versions.
 *
 * Read-only by default. `bump` and `set` write, and both confirm first unless
 * `--yes` is passed, because a version bump touches the project's own files.
 */

import type { Command } from 'commander';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import { resolveConfig } from '../../configuration/resolve.js';
import { toForgeError } from '../../errors/index.js';
import {
  detectDuplicate,
  detectPublishedVersion,
  nextVersion,
  prereleaseParts,
  readVersionState,
  writeVersion,
} from '../../version/engine.js';
import type { BumpStrategy } from '../../version/semver.js';
import type { ForgeConfig } from '../../configuration/schema.js';

export interface VersionCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly palette: Palette;
  readonly confirm: (question: string) => Promise<boolean>;
}

/** Attach the `version` command group. */
export function registerVersionCommand(program: Command, deps: VersionCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  const version = program
    .command('version')
    .description('Inspect and compute project versions')
    .addHelpText(
      'after',
      `
Commands:
  current   Show the current version and where it came from
  next      Show what the next version would be
  bump      Write the next version to every configured source
  sources   List the files the version is read from

Examples:
  $ forge version current
  $ forge version next --patch
  $ forge version next --minor --prerelease
  $ forge version bump --patch
  $ forge version bump --patch --prerelease --yes
  $ forge version bump --set 1.0.0-rc.1 --yes    # an exact version

Run \`forge version bump --help\` for every bump flag: --major, --minor,
--patch, --prerelease, --set, --yes.
`,
    );

  version
    .command('current')
    .description('Show the current version and where it came from')
    .action(async () => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });

      // No try/catch: a VersionError propagates to the CLI's top-level handler,
      // which renders the full what/why/impact/next-step format. Catching here
      // only to rethrow printed every failure twice.
      const state = readVersionState(config);

      c.heading(`Version ${state.current}`);
      c.detail(`from ${state.currentSource}`);

      if (state.observations.length > 1) {
        c.heading('Sources');
        for (const observation of state.observations) {
          const value = observation.version ?? '(no version)';
          c.line(`${observation.source.padEnd(16)} ${value}`);
        }
      }

      const published = await detectPublishedVersion(config);
      if (published.version !== null && published.version !== state.current) {
        c.blank();
        c.warning(
          `${published.source} reports ${published.version}, but the files say ${state.current}.`,
        );
        c.detailError('The next release should be above both.');
      }
    });

  version
    .command('next')
    .description('Show what the next version would be')
    .option('--major', 'Increment the major version')
    .option('--minor', 'Increment the minor version')
    .option('--patch', 'Increment the patch version (default)')
    .option('--prerelease', 'Add or advance a prerelease tag')
    .action((flags: Record<string, boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const strategies = strategiesFrom(flags);

      const next = nextVersion(config, strategies);
      c.line(next);

      const prerelease = prereleaseParts(next);
      if (prerelease.length > 0) c.detail(`prerelease ${prerelease.join('.')}`);
      c.detail(`tag ${config.version.tagPrefix}${next}`);
    });

  version
    .command('bump')
    .description('Write the next version to every configured source')
    .option('--major', 'Increment the major version')
    .option('--minor', 'Increment the minor version')
    .option('--patch', 'Increment the patch version (default)')
    .option('--prerelease', 'Add or advance a prerelease tag')
    .option('--set <version>', 'Write an exact version instead of computing one')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });

      const exact = typeof flags['set'] === 'string' ? flags['set'] : null;
      const target = exact ?? nextVersion(config, strategiesFrom(flags));

      const state = readVersionState(config);
      const duplicate = detectDuplicate(target, state.current);

      c.heading(`Bump ${state.current} → ${target}`);
      c.detail(`tag ${config.version.tagPrefix}${target}`);

      if (duplicate.duplicate) {
        c.warning(`Version ${target} is already the current version.`);
        c.detailError('Nothing would change.');
        return;
      }

      const published = await detectPublishedVersion(config);
      if (published.version !== null && target === published.version) {
        c.failure(`Version ${target} is already published as ${published.source}.`);
        c.detailError('npm and GitHub do not allow overwriting a release.');
        return;
      }

      const sources = sourceList(config);
      c.detail(`writes ${sources.join(', ')}`);

      if (flags['yes'] !== true) {
        const ok = await deps.confirm(`Write version ${target}?`);
        if (!ok) {
          c.info('Cancelled. Nothing was written.');
          return;
        }
      }

      // A failed write propagates: it is release-stopping, not a warning.
      const written = await writeVersion(config, target);
      c.success(`Version set to ${target}`);
      for (const source of written) c.detail(source.name);
    });

  version
    .command('sources')
    .description('List the files the version is read from')
    .action(() => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });

      c.heading('Version sources');
      try {
        const state = readVersionState(config);
        for (const observation of state.observations) {
          c.line(`${observation.source.padEnd(16)} ${observation.version ?? '(none)'}`);
          c.detail(`${observation.description} — ${observation.files.join(', ')}`);
        }
        if (config.version.file !== null) {
          c.blank();
          c.detail(`configured explicitly: ${config.version.file}`);
        }
      } catch (error) {
        // Report the sources even when they disagree or hold no version.
        const forgeError = toForgeError(error);
        c.warning(forgeError.message);
        for (const source of sourceList(config)) c.line(source);
      }
    });
}

/**
 * Turn flags into an ordered bump.
 *
 * Order is significant: `minor` then `prerelease` yields `1.3.0-rc.0`, while
 * `prerelease` then `minor` would yield `2.0.0-rc.0`.
 */
function strategiesFrom(flags: Record<string, unknown>): BumpStrategy[] {
  const strategies: BumpStrategy[] = [];
  if (flags['major'] === true) strategies.push('major');
  if (flags['minor'] === true) strategies.push('minor');
  if (flags['patch'] === true) strategies.push('patch');
  if (flags['prerelease'] === true) strategies.push('prerelease');
  // A bare `forge version next` means patch.
  return strategies.length > 0 ? strategies : ['patch'];
}

/** The files the version will be written to, for display. */
function sourceList(config: ForgeConfig): string[] {
  if (config.version.file !== null) return [config.version.file];
  const known = ['package.json', 'pyproject.toml'];
  return known;
}
