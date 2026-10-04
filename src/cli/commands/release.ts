/**
 * `forge release` — the whole workflow in one command.
 *
 * This is the CLI's composition layer and the only place that knows the concrete
 * shape of every subsystem at once. The pipeline itself stays provider-agnostic.
 */

import type { Command } from 'commander';

import { globalSecrets } from '../../utils/secrets.js';
import {
  createConsole,
  Symbols,
  type Console as TerminalConsole,
  type Palette,
} from '../../ui/theme.js';
import { resolveConfig } from '../../configuration/resolve.js';
import { readVersionState, nextVersion, writeVersion } from '../../version/engine.js';
import { isPrerelease, type BumpStrategy } from '../../version/semver.js';
import { assertChecksPassed, runChecks } from '../../build/checks.js';
import { createTag, pushTag } from '../../build/git.js';
import { createDefaultRegistry } from '../../core/default-registry.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import { runRelease, type ReleaseResult, type StepResult } from '../../release/pipeline.js';
import { render, writeReport, type ReportFormat } from '../../release/report.js';
import { ExitCode } from '../exit-codes.js';
import { contextFor } from './context.js';
import { ConfigError, ErrorCode } from '../../errors/index.js';

export interface ReleaseCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly palette: Palette;
  readonly confirm: (question: string) => Promise<boolean>;
}

/** Attach the `release` command. */
export function registerReleaseCommand(program: Command, deps: ReleaseCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  program
    .command('release')
    .description('Run the full release workflow')
    .argument('[version]', 'Release this exact version instead of computing one')
    .option('--major', 'Increment the major version')
    .option('--minor', 'Increment the minor version')
    .option('--patch', 'Increment the patch version (default when no strategy given)')
    .option('--prerelease', 'Add or advance a prerelease tag')
    .option('--dry-run', 'Show the plan without changing anything')
    .option('--provider <names...>', 'Run only these providers, in order')
    .option('--report <format>', 'Also write a report: json | markdown')
    .option('--no-push', 'Do not push the git tag')
    .option('--yes', 'Skip the confirmation prompt')
    .addHelpText(
      'after',
      `
The workflow:
  configure → authenticate → validate → checks → version → tag
            → publish each provider → verify → report

A failing mandatory step halts the run. Nothing is published after a failed
check, and a dry run touches nothing at all.

Examples:
  $ forge release --dry-run
  $ forge release --patch
  $ forge release --minor --prerelease
  $ forge release 1.4.0
  $ forge release --provider npm
  $ forge release --patch --report markdown
`,
    )
    .action(async (explicitVersion: string | undefined, flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });

      const bumps: BumpStrategy[] = [];
      if (flags['major'] === true) bumps.push('major');
      if (flags['minor'] === true) bumps.push('minor');
      if (flags['patch'] === true) bumps.push('patch');
      if (flags['prerelease'] === true) bumps.push('prerelease');

      const dryRun = flags['dryRun'] === true;
      // Set during a dry run and restored afterwards; see writeVersion below.
      let restoreVersion: string | null = null;
      const providers = Array.isArray(flags['provider'])
        ? (flags['provider'] as string[])
        : undefined;

      // The plan, printed before anything runs, so the user sees the shape of
      // the release even when it later fails.
      printPlan(c, config, explicitVersion, bumps, providers, dryRun);

      if (!dryRun && flags['yes'] !== true) {
        const ok = await deps.confirm(`Release ${config.project.name}?`);
        if (!ok) {
          c.info('Cancelled. Nothing was changed.');
          return;
        }
      }

      const registry = createDefaultRegistry();
      const push = flags['push'] !== false;
      const secrets = collectSecrets(deps.env);

      // Restored in a `finally`, so a step that throws mid-run cannot leave the
      // working tree with a bumped version that was never released.
      let result: ReleaseResult;
      try {
        result = await runRelease(
          config,
          {
            bumps,
            version: explicitVersion,
            dryRun,
            only: providers,
            yes: flags['yes'] === true,
          },
          {
            registry,
            // Synchronous implementations behind an async interface: the pipeline
            // is written against promises so a provider or config source that is
            // genuinely async needs no change here.
            contextFor: (isDryRun) => Promise.resolve(contextFor(config, deps.env, isDryRun)),
            currentVersion: () => Promise.resolve(readVersionState(config).current),
            // During a dry run the version is written and then restored.
            //
            // Without this, `npm publish --dry-run` packs the *current*
            // package.json, sees a version already on npm, and fails a rehearsal
            // that has not actually tried to publish anything. Writing the version
            // first is what makes the dry run honest: npm packs exactly the
            // tarball the real release would upload, and the restore leaves the
            // working tree as it was found.
            writeVersion: async (version) => {
              const original = readVersionState(config).current;
              await writeVersion(config, version);
              if (dryRun) restoreVersion = original;
            },
            computeNext: (strategies) => Promise.resolve(nextVersion(config, strategies)),
            createTag: async (tag, message) => {
              await createTag(config.projectRoot, tag, message);
              if (push) await pushTag(config.projectRoot, tag);
            },
            runChecks: async () => {
              const outcome = await runChecks(config, {
                onFinish: (stepResult) => {
                  if (!stepResult.passed && !stepResult.skipped) {
                    deps.writeError(`${Symbols.fail} ${stepResult.name} ${stepResult.exitCode}\n`);
                  }
                },
              });
              assertChecksPassed(outcome, 'release.checks');
            },
            providersFor: (cfg, only) => providersFor(cfg, only),
            isPrerelease: (version) => isPrerelease(version),
            confirm: deps.confirm,
            onStep: (step) => reportStep(c, step),
          },
        );
      } finally {
        if (restoreVersion !== null) {
          await writeVersion(config, restoreVersion);
          restoreVersion = null;
        }
      }

      c.blank();
      deps.write(render(result, 'terminal', secrets));

      const reportFlag = flags['report'];
      if (typeof reportFlag === 'string') {
        const format: ReportFormat = reportFlag === 'markdown' ? 'markdown' : 'json';
        const written = await writeReport(result, config.projectRoot, [format]);
        c.blank();
        c.info('Reports written:');
        for (const path of written) c.detail(path);
      }

      if (result.outcome === 'failed') {
        // A failed release must not exit 0. A CI step gating on `forge release`
        // would otherwise pass on a release that published nothing.
        c.blank();
        c.failure('Release failed.');
        process.exitCode = ExitCode.Verification;
        return;
      }

      if (result.outcome === 'dry-run') {
        c.blank();
        c.info('Dry run complete. Nothing was changed.');
      }
    });
}

/**
 * Which providers take part.
 *
 * Only enabled providers, in the configured order, narrowed by `--provider` when
 * given. A provider named but not enabled is a configuration error rather than a
 * silent skip — the user asked for a publish that cannot happen.
 *
 * Data-driven by design: the architecture test forbids branching on a platform
 * name in Core or the CLI, and this function is exactly the shape it prohibits.
 */
function providersFor(config: ForgeConfig, only?: readonly string[]): readonly string[] {
  // Each provider contributes an `enabled` flag; there is no per-provider branch.
  const enabledOf: Readonly<Record<string, boolean>> = {
    github: config.github.enabled,
    npm: config.npm.enabled,
    pypi: config.pypi.enabled,
  };

  const base = config.order.filter((name) => enabledOf[name] === true);

  if (only === undefined || only.length === 0) return base;

  for (const name of only) {
    if (!(name in enabledOf)) {
      throw new ConfigError(ErrorCode.CONFIG_INVALID, `Unknown provider "${name}".`, {
        remediation: `Known providers: ${Object.keys(enabledOf).join(', ')}.`,
      });
    }
    if (enabledOf[name] !== true) {
      // A provider named but not enabled means the user asked for a publish that
      // cannot happen. Skipping it silently would report a successful release
      // that did nothing.
      throw new ConfigError(
        ErrorCode.CONFIG_INVALID,
        `--provider ${name} was requested but ${name}.enabled is false.`,
        {
          remediation: `Set ${name}.enabled: true in forge.config.yaml, or drop it from --provider.`,
        },
      );
    }
  }

  // Preserve the requested order rather than the configured one. `base` is typed
  // as ProviderName[], so narrow once rather than casting at the call site.
  const configured = new Set<string>(base);
  return only.filter((name) => configured.has(name));
}

/** Whether a provider is enabled, looked up rather than branched on. */
function enabledFlagOf(config: ForgeConfig, name: string): boolean {
  const flags: Readonly<Record<string, boolean>> = {
    github: config.github.enabled,
    npm: config.npm.enabled,
    pypi: config.pypi.enabled,
  };
  return flags[name] === true;
}

/** Print the plan before anything runs. */
function printPlan(
  c: TerminalConsole,
  config: ForgeConfig,
  explicitVersion: string | undefined,
  bumps: readonly BumpStrategy[],
  providers: readonly string[] | undefined,
  dryRun: boolean,
): void {
  c.heading(dryRun ? 'Release Plan' : 'Release');

  let target = explicitVersion ?? 'unchanged';
  if (explicitVersion === undefined && bumps.length > 0) {
    try {
      target = nextVersion(config, bumps);
    } catch {
      // A missing current version is reported properly by the pipeline.
      target = bumps.join('+');
    }
  }

  c.line(`project    ${config.project.name}`);
  c.line(`version    ${target}`);
  c.line(`tag        ${config.version.tagPrefix}${target === 'unchanged' ? '<version>' : target}`);

  // The plan must name the providers that will actually run, not every known
  // one — printing three while running one is misleading.
  const enabled = config.order.filter((name) => enabledFlagOf(config, name));
  const planned = providers !== undefined && providers.length > 0 ? providers : enabled;
  c.line(`providers  ${planned.length > 0 ? planned.join(', ') : 'none enabled'}`);
  if (Object.keys(config.checks).length > 0) {
    c.line(`checks     ${Object.keys(config.checks).join(', ')}`);
  }
  if (dryRun) {
    c.blank();
    c.info('Dry run — no changes will be made.');
  }
}

/** Render one step as it completes. */
function reportStep(c: TerminalConsole, step: StepResult): void {
  switch (step.status) {
    case 'passed':
      c.success(`${step.step.padEnd(14)} ${step.detail}`);
      return;
    case 'failed':
      c.failure(`${step.step.padEnd(14)} ${step.detail}`);
      return;
    case 'skipped':
      c.info(`${step.step.padEnd(14)} skipped`);
      return;
    case 'pending':
      c.detail(`${step.step} pending`);
  }
}

/**
 * Build the provider context.
 *
 * The real executor, because providers shell out for `gh`, `npm`, and `git`.
 */

/**
 * Secrets resolved this run, so reports can redact them.
 *
 * Only environment-sourced values are collected: a `gh auth token` value is
 * never held in memory by Forge, so there is nothing to redact.
 */
function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  return ['GITHUB_TOKEN', 'NPM_TOKEN', 'PYPI_TOKEN']
    .map((name) => env[name])
    .filter((value): value is string => value !== undefined && value.length >= 8);
}

export type { ReleaseResult };
