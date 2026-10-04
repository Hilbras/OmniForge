/**
 * `forge check` — run the project's checks.
 *
 * `forge check` runs everything; `forge check test` runs one. Output is streamed
 * live so a long test run shows progress rather than sitting silent, and the
 * command exits non-zero when a mandatory check fails so CI can gate on it.
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
import { assertChecksPassed, runChecks, summarize } from '../../build/checks.js';
import { ExitCode } from '../exit-codes.js';
import type { CheckOutcome } from '../../build/checks.js';

export interface CheckCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly palette: Palette;
  /** Show each check's own output. Off by default so summaries stay readable. */
  readonly verboseOutput?: boolean;
}

/** Attach the `check` command group. */
export function registerCheckCommand(program: Command, deps: CheckCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  program
    .command('check')
    .description('Run the configured checks')
    .argument('[names...]', 'Checks to run; omit to run all of them')
    .option('--only <names...>', 'Checks to run')
    .option('--verbose-output', "Print each check's stdout and stderr")
    .option('--quiet', 'Print only the summary line')
    .addHelpText(
      'after',
      `
Checks come from forge.config.yaml. Each runs as an argument array with no
shell, so a value containing shell metacharacters is data, never syntax.

Examples:
  $ forge check                 # every configured check
  $ forge check test lint       # just these two
  $ forge check --only build    # the same, as a flag
  $ forge check --verbose-output
  $ forge check --quiet         # CI: summary line only, exit code is the signal
`,
    )
    .action(async (names: string[], flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });

      const requested = [
        ...names,
        ...(Array.isArray(flags['only']) ? (flags['only'] as string[]) : []),
      ].filter((name) => name.length > 0);

      if (requested.length === 0 && Object.keys(config.checks).length === 0) {
        c.warning('No checks are configured.');
        c.detailError('Add a `checks:` section to forge.config.yaml.');
        return;
      }

      const quiet = flags['quiet'] === true;
      const showOutput = flags['verboseOutput'] === true || deps.verboseOutput === true;
      const p = c.palette;

      let current = '';
      const result = await runChecks(config, {
        ...(requested.length > 0 ? { only: requested } : {}),
        onStart: (name, command) => {
          current = name;
          if (!quiet) c.step(`${name}`, p.dim(command.join(' ')));
        },
        // Surfaced rather than enforced: `sh -c` is a legitimate choice, so the
        // check still runs. Making the decision visible is the point.
        onWarning: (name, warning) => {
          if (!quiet) c.warning(`${name}: ${warning.message}`);
        },
        onOutput: (chunk, stream) => {
          // Streamed live so a slow suite shows progress.
          if (!quiet) {
            const prefix = p.dim('│');
            for (const line of chunk.split('\n')) {
              if (line.length > 0) {
                (stream === 'stderr' ? deps.writeError : deps.write)(`${prefix} ${line}\n`);
              }
            }
          }
        },
        onFinish: (outcome) => reportOutcome(c, outcome, { quiet, showOutput, name: current }),
      });

      c.blank();
      if (result.ok) {
        c.success(summarize(result));
      } else {
        c.failure(summarize(result));
      }

      if (!result.ok) {
        assertChecksPassed(result);
      }
    });

  // `forge test` and `forge build` as conveniences over the same engine.
  program
    .command('test')
    .description('Run the test check')
    .option('--verbose-output', "Print each check's stdout and stderr")
    .addHelpText(
      'after',
      `
A shortcut for the "test" check in forge.config.yaml — the same engine, the same
exit code. Add --verbose-output to see what the test runner printed.

Examples:
  $ forge test
  $ forge test --verbose-output
`,
    )
    .action(async (flags: Record<string, unknown>) => {
      await runNamed(out(), 'test', flags);
    });

  program
    .command('build')
    .description('Run the build check')
    .option('--verbose-output', "Print each check's stdout and stderr")
    .addHelpText(
      'after',
      `
A shortcut for the "build" check in forge.config.yaml. Forge never builds for
you — this runs the command you configured and reports whether it succeeded.

Examples:
  $ forge build
  $ forge build --verbose-output
`,
    )
    .action(async (flags: Record<string, unknown>) => {
      await runNamed(out(), 'build', flags);
    });
}

/** Run a single named check, erroring clearly when it is not configured. */
async function runNamed(
  c: TerminalConsole,
  name: string,
  flags: Record<string, unknown>,
): Promise<void> {
  const config = resolveConfig({ cwd: process.cwd() });
  // `--verbose-output` arrives as `verboseOutput`, not `verbose-output`.
  const showOutput = flags['verboseOutput'] === true;

  if (config.checks[name] === undefined) {
    c.warning(`No "${name}" check is configured.`);
    c.detailError(
      `Configured: ${Object.keys(config.checks).join(', ') || 'none'}. Add a "${name}" entry to forge.config.yaml.`,
    );
    process.exitCode = ExitCode.Config;
    return;
  }

  const p = c.palette;
  // Bound as functions rather than detached method references:
  // `process.stdout.write` needs its receiver on some platforms.
  const writeErr = (text: string): void => {
    process.stderr.write(text);
  };
  const writeOut = (text: string): void => {
    process.stdout.write(text);
  };

  const result = await runChecks(config, {
    only: [name],
    onOutput: (chunk, stream) => {
      for (const line of chunk.split('\n')) {
        if (line.length > 0) {
          (stream === 'stderr' ? writeErr : writeOut)(`${p.dim('│')} ${line}\n`);
        }
      }
    },
    onFinish: (outcome) => reportOutcome(c, outcome, { quiet: false, showOutput, name }),
  });

  c.blank();
  if (result.ok) {
    c.success(summarize(result));
  } else {
    c.failure(summarize(result));
    assertChecksPassed(result);
  }
}

/** Render one check's outcome. */
function reportOutcome(
  c: TerminalConsole,
  outcome: CheckOutcome,
  view: { quiet: boolean; showOutput: boolean; name: string },
): void {
  if (outcome.skipped === true) {
    if (!view.quiet) c.info(`${outcome.name.padEnd(10)} ${c.palette.dim('skipped')}`);
    return;
  }

  const p = c.palette;
  const seconds = (outcome.durationMs / 1000).toFixed(1);

  if (outcome.passed) {
    if (!view.quiet) {
      c.success(`${outcome.name.padEnd(10)} ${p.dim(`${seconds}s`)}`);
    }
    return;
  }

  const reason = outcome.timedOut ? 'timed out' : `exit ${outcome.exitCode}`;
  c.writeErrorPlain(`${p.red(Symbols.fail)} ${outcome.name.padEnd(10)} ${p.dim(reason)}\n`);

  if (view.showOutput && outcome.stderr.trim().length > 0) {
    for (const line of outcome.stderr.trim().split('\n').slice(-20)) {
      c.writeErrorPlain(`  ${p.dim(line)}\n`);
    }
  }
}
