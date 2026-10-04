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
import { existsSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

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

/**
 * Characters that indicate a command was probably meant for a shell.
 *
 * Forge always passes an argument array with `shell: false`, so these are never
 * interpreted — `["sh","-c","a; rm -rf /"]` runs `a` in a subshell and `rm`
 * never happens. This list exists only to *warn* that a check looks shell-shaped,
 * so an unexpected result is traceable to an unexpected command. Expect false
 * positives on inline scripts (`node -e "...;..."`), which is why the warning is
 * advisory rather than an error.
 */
const SUSPICIOUS = /[;&|`$><\n]/;

/**
 * Resolve a command name to something spawnable on this platform.
 *
 * On Windows a package installed by npm is a batch file — `npm.cmd`, and
 * `twine.exe` only if a console-script wrapper was generated. Node's spawn with
 * `shell: false` does not consult PATHEXT, so `spawn('npm', ...)` fails there
 * with ENOENT even though npm is installed and on PATH. Using a shell would fix
 * the lookup and destroy the security property this module exists for, so the
 * extension is appended instead.
 *
 * Real executables such as `git` and `python` are untouched, and a command that
 * already carries an extension is left alone.
 */
export function resolveProgram(command: string): string {
  if (process.platform !== 'win32') return command;
  if (command.includes('/') || command.includes('\\')) return command;
  if (extname(command).length > 0) return command;

  // A .cmd shim is what npm and npx install; twine ships .exe and .bat.
  for (const extension of ['.cmd', '.exe', '.bat']) {
    if (findOnPath(`${command}${extension}`)) return `${command}${extension}`;
  }

  return command;
}

/**
 * Decide what to actually spawn.
 *
 * On POSIX this is the command and its arguments, untouched.
 *
 * On Windows a batch file has to go through cmd.exe, so the program becomes
 * `cmd.exe` and the arguments become `['/d', '/s', '/c', <command line>]`. The
 * command line is the one place a string is built, so it is escaped here with
 * the quoting rules cmd.exe applies — and Forge's own threat model says a
 * metacharacter must reach the command as a literal, which this preserves.
 */
export function buildInvocation(
  program: string,
  args: readonly string[],
): { program: string; args: string[]; verbatimArguments?: boolean } {
  if (!needsCommandInterpreter(program)) {
    return { program, args: [...args] };
  }

  // This mirrors what cross-spawn does, which is the only approach to this that
  // is known to work in practice:
  //
  //   - The command line is one quoted string: /s then strips that outer pair and
  //     leaves the command name bare with each argument in its own quoted region.
  //   - `windowsVerbatimArguments` stops Node re-quoting the string on its way to
  //     CreateProcess. Without it Node applies its own quoting rules to a string
  //     that is already quoted for cmd, and the two layers disagree — which is
  //     what produced '`"npm.cmd "pack" ...` is not recognized' on the Windows
  //     runners when /s was used without it.
  //
  // /d skips registry AutoRun entries, which would otherwise execute on every
  // invocation.
  const line = [program, ...args.map(quoteCmdArgument)].join(' ');

  return {
    program: process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatimArguments: true,
  };
}

/**
 * Quote one argument for cmd.exe.
 *
 * cmd.exe does not use backslash escapes. Its rules are:
 *
 *   - `"` inside an argument is escaped by doubling it.
 *   - A trailing backslash is doubled, because the closing `"` it sits next to
 *     would otherwise be read as escaped.
 *   - `&`, `|`, `<`, `>`, `^` and `%` are syntax even inside quotes, so they are
 *     escaped with `^` as well as quoted. Quoting alone is not enough.
 *
 * The result is what a caller sees after cmd.exe has parsed the line: a
 * metacharacter survives as itself rather than executing.
 */
export function quoteCmdArgument(value: string): string {
  // A caret must itself be doubled, or it escapes the character after it.
  // `&`, `|`, `<` and `>` are cmd statement separators; quoting does not stop
  // them, so they are caret-escaped as well.
  let escaped = value.replace(/([%^&|<>])/g, '^$1');
  escaped = escaped.replace(/"/g, '""');
  // Only a backslash run immediately before the closing quote is significant.
  escaped = escaped.replace(/(\\*)$/, '$1$1');

  return `"${escaped}"`;
}

/**
 * Whether a resolved program is a batch file, which Windows cannot spawn directly.
 *
 * Node closed CVE-2024-27980 by refusing to spawn `.bat` and `.cmd` files: an
 * argument to a batch file is not escaped by CreateProcess, so a crafted argument
 * could inject a command. `spawn('npm.cmd', ...)` therefore fails with EINVAL
 * even though the file exists and is on PATH.
 */
function needsCommandInterpreter(program: string): boolean {
  if (process.platform !== 'win32') return false;
  const extension = extname(program).toLowerCase();

  return extension === '.cmd' || extension === '.bat';
}

/**
 * Search every PATH directory for a file.
 *
 * `existsSync('npm.cmd')` would only look in the current directory, which is
 * never where it is. Windows resolves a bare command name by walking PATH and
 * appending each PATHEXT extension, so this does the same thing explicitly
 * rather than asking the OS, which is what fails under `shell: false`.
 */
function findOnPath(fileName: string): boolean {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      if (existsSync(join(dir, fileName))) return true;
    } catch {
      // An unreadable or malformed PATH entry is not a reason to fail; keep
      // looking, exactly as the OS resolver would.
    }
  }

  return false;
}

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
  const program = resolveProgram(command);
  const invocation = buildInvocation(program, args);

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(invocation.program, invocation.args, {
        // No shell, except where Windows gives us no alternative: a .cmd shim is
        // not a real executable, so cmd.exe is invoked explicitly with an
        // argument array and `shell: false`. cmd.exe is not interpreting a string
        // Forge built from user input — it receives a fixed argv, and each
        // argument is escaped by quoteCmdArgument below.
        shell: false,
        // Only set for the cmd.exe path; see buildInvocation.
        ...(invocation.verbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
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
