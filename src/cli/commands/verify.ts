/**
 * `forge verify` — confirm a release holds together.
 *
 * Checks every enabled provider for one version and reports whether they agree.
 * Exits non-zero on a mismatch so a deploy step can gate on it, which is the
 * whole point: catching a GitHub/npm disagreement before it reaches users rather
 * than after.
 */

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import type { Command } from 'commander';

import { resolveConfig } from '../../configuration/resolve.js';
import { createDefaultRegistry } from '../../core/default-registry.js';
import { readVersionState } from '../../version/engine.js';
import { execute } from '../../build/exec.js';
import { ExitCode } from '../exit-codes.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import type { ProviderContext } from '../../core/provider.js';
import {
  assertIntegrity,
  summarize,
  table,
  verifyRelease,
  type IntegrityReport,
} from '../../verification/integrity.js';

export interface VerifyCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly palette: Palette;
}

/** Attach the `verify` command. */
export function registerVerifyCommand(program: Command, deps: VerifyCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  program
    .command('verify')
    .description('Confirm every provider agrees on the released version')
    .argument('[version]', 'Version to verify; defaults to the current one')
    .option('--release-version <semver>', 'Version to verify, as a flag')
    .option('--provider <names...>', 'Check only these providers')
    .option('--config <path>', 'Path to forge.config.yaml')
    .option('--report <format>', 'Write a report: json | markdown')
    .addHelpText(
      'after',
      `
Checks that each enabled provider reports the same version and that its own
release exists and is published. A mismatch means part of a release is live and
part is not.

Examples:
  $ forge verify
  $ forge verify 1.5.0
  $ forge verify --provider github npm
  $ forge verify --report json
`,
    )
    .action(async (positional: string | undefined, flags: Record<string, unknown>) => {
      const c = out();
      const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined;
      const config = resolveConfig({ cwd: process.cwd(), configPath });

      const version =
        typeof flags['releaseVersion'] === 'string'
          ? flags['releaseVersion']
          : (positional ?? readVersionState(config).current);

      const only = Array.isArray(flags['provider']) ? (flags['provider'] as string[]) : undefined;
      const registry = createDefaultRegistry();

      c.heading(`Verify ${config.npm.package ?? config.project.name}@${version}`);

      const report = await verifyRelease(config, {
        registry,
        version,
        only,
        contextFor: () => contextFor(config, deps.env),
        providersFor: enabledProviders,
      });

      if (report.entries.length === 0) {
        c.warning('No providers are enabled, so there is nothing to verify.');
        c.detailError('Enable at least one in forge.config.yaml.');
        process.exitCode = ExitCode.Config;
        return;
      }

      for (const [provider, observed, state] of table(report)) {
        const line = `${provider.padEnd(10)} ${observed.padEnd(12)} ${state}`;
        if (state === 'ok') c.success(line);
        else c.failure(line);
      }

      // Per-check detail, so a failure says which assertion broke rather than
      // just that something did.
      for (const entry of report.entries) {
        for (const check of entry.checks) {
          if (check.passed) continue;
          c.detail(`${entry.provider}: ${check.name} — ${check.detail}`);
        }
      }

      c.blank();
      if (report.passed) {
        c.success(summarize(report));
      } else {
        c.failure(summarize(report));
        for (const problem of report.problems) c.detailError(problem);
      }

      const reportFlag = flags['report'];
      if (typeof reportFlag === 'string') {
        const { render } = await import('../../release/report.js');
        const text = render(
          toReport(config, version, report),
          reportFlag === 'markdown' ? 'markdown' : 'json',
        );
        deps.write(`\n${text}`);
      }

      if (!report.passed) {
        // Hard failure so a CI deploy step cannot pass on a partial release.
        try {
          assertIntegrity(report, 'forge.verify');
        } catch (error) {
          deps.writeError(
            `\n${(error as { format?: () => string }).format?.() ?? String(error)}\n`,
          );
        }
        process.exitCode = ExitCode.Verification;
      }
    });
}

/** Shape an integrity report as a ReleaseResult, for the report renderers. */
function toReport(config: ForgeConfig, version: string, report: IntegrityReport) {
  return {
    project: config.project.name,
    version,
    previousVersion: version,
    tag: `${config.version.tagPrefix}${version}`,
    dryRun: false,
    outcome: report.passed ? ('success' as const) : ('failed' as const),
    steps: report.entries.flatMap((entry) =>
      entry.checks.map((check) => ({
        step: check.name,
        provider: entry.provider,
        status: check.passed ? ('passed' as const) : ('failed' as const),
        detail: check.detail,
        durationMs: 0,
        mandatory: false,
      })),
    ),
    integrity: {
      passed: report.passed,
      expected: report.expected,
      observed: report.entries.map((e) => ({ provider: e.provider, version: e.observed })),
      mismatches: report.problems,
    },
    startedAt: new Date().toISOString(),
    totalDurationMs: 0,
  };
}

/**
 * Enabled providers, in configured order.
 *
 * Data-driven rather than a switch: the architecture test forbids per-provider
 * branching in the CLI, and this is exactly the shape it prohibits.
 */
function enabledProviders(config: ForgeConfig, only?: readonly string[]): readonly string[] {
  const enabledOf: Readonly<Record<string, boolean>> = {
    github: config.github.enabled,
    npm: config.npm.enabled,
    pypi: config.pypi.enabled,
  };

  const base = config.order.filter((name) => enabledOf[name] === true);
  if (only === undefined || only.length === 0) return base;

  // Report the requested set, in the requested order, so `--provider npm github`
  // produces a table in that order. `base` is typed ProviderName[], so the set is
  // widened once here rather than casting at the call site.
  const configured = new Set<string>(base);
  return only.filter((name) => configured.has(name));
}

/** Build a provider context with the real executor. */
function contextFor(config: ForgeConfig, env: NodeJS.ProcessEnv): ProviderContext {
  return {
    projectRoot: config.projectRoot,
    config: config as unknown as Record<string, unknown>,
    getSecret: (provider: string) => {
      if (!/^[a-z][a-z0-9]*$/.test(provider)) return undefined;
      const value = env[`${provider.toUpperCase()}_TOKEN`];
      return value !== undefined && value.length > 0 ? value : undefined;
    },
    execute: {
      run: (command, args, options) => {
        return execute(command, args, options ?? {});
      },
    },
    dryRun: false,
  };
}
