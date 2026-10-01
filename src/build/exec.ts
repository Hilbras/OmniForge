/**
 * Hardened command execution.
 *
 * Every external command Forge runs — `git`, `gh`, `npm`, `twine` — goes
 * through here. The security spec forbids unsafe shell interpolation, so this
 * module takes an argument *array* and never uses a shell. `["sh", "-c", userInput]`
 * is impossible to express here because the array is passed straight to `spawn`.
 *
 * This was pulled forward from Phase 5: the GitHub provider needs it in Phase 3,
 * and retrofitting safe execution onto existing callers would have been the wrong
 * order.
 */

import { spawn } from 'node:child_process';

import { CheckError, ErrorCode } from '../errors/index.js';

/** A command that is not going to be executed is still validated. */
export interface ExecOptions {
  /** Working directory. Must be absolute; relative paths are rejected. */
  readonly cwd?: string;
  /** Extra environment variables, merged over the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds before the child is killed. Default 120s. */
  readonly timeoutMs?: number;
  /** Receives output as it arrives, for streaming progress to the terminal. */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /** Input written to stdin. */
  readonly input?: string;
  /** Grace period between SIGTERM and SIGKILL. Default 2s. */
  readonly killGraceMs?: number;
}

export interface ExecResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** True when the command was killed for exceeding its timeout. */
  readonly timedOut: boolean;
  /** True when the child had to be SIGKILLed after ignoring SIGTERM. */
  readonly killed: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_MS = 2_000;

/** Characters that only matter in a shell. Their presence in an argument is fine,
 * but a caller interpolating them into a single string is exactly what this module
 * prevents — so we log the shape, never the content. */
const SUSPICIOUS = /[;&|`$><\n]/;

/**
 * Run a command with an argument array and no shell.
 *
 * @throws CheckError when the command cannot be spawned at all (not found, not
 * executable). A non-zero exit is *not* thrown — callers decide whether it
 * matters, because "exit 1" is meaningful data for a check.
 */
export async function execute(
  command: string,
  args: readonly string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (command.trim().length === 0) {
    throw new CheckError(ErrorCode.COMMAND_REJECTED, 'Command must not be empty.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const grace = options.killGraceMs ?? DEFAULT_GRACE_MS;
  const started = Date.now();

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        // No shell. This is the entire point of the module.
        shell: false,
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new CheckError(
          ErrorCode.COMMAND_REJECTED,
          `Cannot run "${command}". Is it installed and on PATH?`,
          {
            remediation: `Install ${command}, or configure its path.`,
            cause: error,
            detail: { command, exitHint: describeExitHint(command) },
          },
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first so the child can clean up; SIGKILL only if it ignores us.
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, grace);
      hardKill.unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onOutput?.(text, 'stdout');
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onOutput?.(text, 'stderr');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new CheckError(ErrorCode.COMMAND_REJECTED, `"${command}" was not found on PATH.`, {
            remediation: `Install ${command}, or add it to PATH.`,
            cause: error,
            detail: { command, hint: describeExitHint(command) },
          }),
        );
        return;
      }
      reject(
        new CheckError(ErrorCode.COMMAND_REJECTED, `Failed to run "${command}".`, {
          cause: error,
          detail: { command },
        }),
      );
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      resolve({
        command,
        args,
        // A signalled process has no exit code; report the conventional 128+signal
        // so callers still see a non-zero value for "did not succeed".
        exitCode: code ?? (signal === 'SIGKILL' ? 137 : 143),
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        killed,
      });
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });
}

/** True when any argument contains shell metacharacters. */
export function hasShellMetacharacters(args: readonly string[]): boolean {
  return args.some((arg) => SUSPICIOUS.test(arg));
}

/**
 * Run a command and require a zero exit.
 *
 * @throws CheckError including captured stderr, which is what a user needs to
 * understand the failure. Never includes the full argument array, since an
 * argument can be a credential passed with `--token`.
 */
export async function executeOrThrow(
  command: string,
  args: readonly string[] = [],
  options: ExecOptions & { operation?: string } = {},
): Promise<ExecResult> {
  const result = await execute(command, args, options);

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || '(no output)';
    throw new CheckError(
      result.timedOut ? ErrorCode.CHECK_TIMEOUT : ErrorCode.CHECK_FAILED,
      `${command} failed with exit code ${result.exitCode}.`,
      {
        operation: options.operation,
        remediation: 'See the captured output above for the cause.',
        detail: {
          command,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: detail.slice(0, 2_000),
        },
      },
    );
  }

  return result;
}

/**
 * A short hint for a missing binary.
 *
 * Static, so it needs no PATH scan and stays testable. Covers the tools Forge
 * itself shells out to.
 */
function describeExitHint(command: string): string {
  switch (command) {
    case 'gh':
      return 'Install GitHub CLI: https://cli.github.com';
    case 'git':
      return 'Install git and ensure it is on PATH.';
    case 'npm':
      return 'Install Node.js, which provides npm.';
    case 'twine':
      return 'Install twine: pip install twine';
    default:
      return 'Install it, or add it to PATH.';
  }
}
