/**
 * The check engine.
 *
 * Runs a project's checks and gates the release on their results. The rule that
 * matters: a mandatory check that fails stops the release *before anything is
 * published*. A release that publishes despite a failing test is the worst
 * outcome this tool can produce, so the halt is enforced here rather than left
 * to the orchestrator to remember.
 */

import { execute, hasShellMetacharacters } from './exec.js';
import { validateCommand, type CommandWarning } from './validate.js';
import { CheckError, ErrorCode } from '../errors/index.js';
import type { CheckConfig, ForgeConfig } from '../configuration/schema.js';

/** Outcome of one check. */
export interface CheckOutcome {
  readonly name: string;
  readonly passed: boolean;
  /** False when the check is optional and failed without halting the release. */
  readonly fatal: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  /** Skipped because an earlier mandatory check failed. */
  readonly skipped?: boolean;
}

/** Result of running every configured check. */
export interface CheckRunResult {
  readonly outcomes: readonly CheckOutcome[];
  /** True when every mandatory check passed. */
  readonly ok: boolean;
  /** True when at least one mandatory check failed. */
  readonly halted: boolean;
  readonly totalDurationMs: number;
}

export interface RunChecksOptions {
  /** Restrict the run to these check names. */
  readonly only?: readonly string[];
  /** Stream output as it arrives. */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Called before each check, for progress output. */
  readonly onStart?: (name: string, command: readonly string[]) => void;
  /** Called after each check completes. */
  readonly onFinish?: (outcome: CheckOutcome) => void;
  /**
   * Called when a configured command looks suspicious.
   *
   * Advisory: the check still runs, because `sh -c` is a legitimate choice. The
   * warning exists so the decision is visible rather than silent.
   */
  readonly onWarning?: (name: string, warning: CommandWarning) => void;
}

/**
 * Run the configured checks in order.
 *
 * A mandatory failure halts: remaining checks report `skipped` and no further
 * command runs. Optional failures are recorded and the run continues.
 */
export async function runChecks(
  config: ForgeConfig,
  options: RunChecksOptions = {},
): Promise<CheckRunResult> {
  const names = options.only ?? Object.keys(config.checks);
  const outcomes: CheckOutcome[] = [];
  const started = Date.now();
  let halted = false;

  for (const name of names) {
    const check = config.checks[name];
    if (check === undefined) {
      throw new CheckError(ErrorCode.COMMAND_REJECTED, `No check named "${name}" is configured.`, {
        operation: 'checks.run',
        remediation: `Configured checks: ${Object.keys(config.checks).join(', ') || 'none'}.`,
      });
    }

    if (halted) {
      // Recorded rather than dropped, so the report shows the whole plan.
      outcomes.push({
        name,
        passed: false,
        fatal: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        durationMs: 0,
        timedOut: false,
        skipped: true,
      });
      continue;
    }

    options.onStart?.(name, check.command);

    // Surface anything suspicious before running it. The executor already uses
    // no shell, so a metacharacter cannot be *interpreted*; this catches the
    // cases a shell cannot: a cwd outside the project, an overridden loader, or a
    // credential passed as an argument where anyone running `ps` can read it.
    const warnings = validateCommand({
      command: check.command[0] ?? '',
      args: check.command.slice(1),
      cwd: config.projectRoot,
      projectRoot: config.projectRoot,
    });
    for (const warning of warnings) options.onWarning?.(name, warning);

    const outcome = await runOne(name, check, config.projectRoot, options);
    outcomes.push(outcome);
    options.onFinish?.(outcome);

    if (!outcome.passed && !check.optional) halted = true;
  }

  const mandatoryFailed = outcomes.some(
    (o) => !o.passed && !o.skipped && !isOptional(config, o.name),
  );

  return {
    outcomes,
    ok: !mandatoryFailed,
    halted,
    totalDurationMs: Date.now() - started,
  };
}

/** True when the named check is optional. */
function isOptional(config: ForgeConfig, name: string): boolean {
  return config.checks[name]?.optional ?? false;
}

/**
 * Run one check.
 *
 * Argument arrays with shell metacharacters are allowed — `sh -c` inside the
 * array is a legitimate, explicit choice by the user — but the check warns so a
 * surprising result is traceable to an unexpected command.
 */
async function runOne(
  name: string,
  check: CheckConfig,
  projectRoot: string,
  options: RunChecksOptions,
): Promise<CheckOutcome> {
  if (check.command.length === 0) {
    throw new CheckError(ErrorCode.COMMAND_REJECTED, `Check "${name}" has an empty command.`, {
      operation: `checks.${name}`,
      remediation: 'Give it an argument array, e.g. ["npm", "test"].',
    });
  }

  const [command, ...args] = check.command;
  if (command === undefined) {
    throw new CheckError(ErrorCode.COMMAND_REJECTED, `Check "${name}" has an empty command.`, {
      operation: `checks.${name}`,
    });
  }

  const usesShellMetacharacters = hasShellMetacharacters(check.command);
  if (usesShellMetacharacters) {
    options.onOutput?.(
      `check "${name}" contains shell metacharacters; it is run as-is, unescaped\n`,
      'stderr',
    );
  }

  const result = await execute(command, args, {
    cwd: projectRoot,
    timeoutMs: check.timeoutMs,
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
  });

  return {
    name,
    passed: result.exitCode === 0,
    fatal: result.exitCode !== 0 && !check.optional,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
  };
}

/**
 * Throw when a mandatory check failed.
 *
 * The release pipeline calls this after `runChecks` so a halt happens in one
 * place, with one error message, regardless of which check failed first.
 */
export function assertChecksPassed(result: CheckRunResult, operation = 'release.checks'): void {
  if (result.ok) return;

  const failed = result.outcomes.filter((o) => !o.passed && !o.skipped);
  if (failed.length === 0) return;

  const first = failed[0];
  const reason = first?.timedOut === true ? 'timed out' : `exited ${first?.exitCode}`;

  throw new CheckError(
    first?.timedOut === true ? ErrorCode.CHECK_TIMEOUT : ErrorCode.CHECK_FAILED,
    `Check "${first?.name}" failed: ${reason}.`,
    {
      operation,
      remediation:
        'Fix the failure, or mark the check optional in forge.config.yaml to continue anyway.',
      detail: {
        failed: failed.map((o) => ({ name: o.name, exitCode: o.exitCode, timedOut: o.timedOut })),
        skipped: result.outcomes.filter((o) => o.skipped === true).map((o) => o.name),
      },
    },
  );
}

/** A short one-line summary for CLI output, e.g. `3 passed, 1 failed in 4.2s`. */
export function summarize(result: CheckRunResult): string {
  const passed = result.outcomes.filter((o) => o.passed).length;
  const failed = result.outcomes.filter((o) => !o.passed && !o.skipped).length;
  const skipped = result.outcomes.filter((o) => o.skipped === true).length;

  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  parts.push(`${(result.totalDurationMs / 1000).toFixed(1)}s`);

  return parts.join(', ');
}
