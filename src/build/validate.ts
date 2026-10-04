/**
 * Command validation.
 *
 * Forge runs commands a user configured: check scripts, provider tooling. The
 * executor already refuses to use a shell, so a metacharacter cannot be
 * *interpreted*. This module refuses to run a command that is nonetheless
 * suspicious, which covers the case the shell cannot: a `cwd` pointing outside
 * the project, an environment variable that would override `PATH`, or an
 * argument that looks like a credential being written somewhere visible.
 *
 * It is advisory rather than absolute — a legitimate project may use `sh -c` —
 * but it makes the decision explicit and loggable.
 */

import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

/** One finding from validation. */
export interface CommandWarning {
  readonly kind: 'shell' | 'path' | 'env' | 'credential' | 'missing';
  readonly message: string;
}

/** What to check. */
export interface ValidateCommandInput {
  readonly command: string;
  readonly args?: readonly string[];
  /** Absolute working directory the command will run in. */
  readonly cwd: string;
  /** The project root; a `cwd` outside it is suspicious. */
  readonly projectRoot: string;
  /** Extra environment variables the caller will set. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Variables that would change which binary runs or how it behaves.
 *
 * Setting `PATH` or `NODE_OPTIONS` for a child process is occasionally
 * necessary, but it is also the shape of an injection, so it is called out.
 */
const SENSITIVE_ENV = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
]);

const SHELL_COMMANDS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
]);

/**
 * Credential-looking flags.
 *
 * Matched anywhere in an argument, not only at its start: a credential is just as
 * exposed inside an inline `sh -c "..."` script as it is as a bare flag, and the
 * former is the more likely accident.
 */
const CREDENTIAL_FLAGS = /--(token|password|passwd|secret|api-?key|auth)([=\s]|$)/i;

/** Validate a command, returning warnings rather than throwing. */
export function validateCommand(input: ValidateCommandInput): readonly CommandWarning[] {
  const warnings: CommandWarning[] = [];
  const args = input.args ?? [];

  if (input.command.trim().length === 0) {
    warnings.push({ kind: 'missing', message: 'Command is empty.' });
    return warnings;
  }

  // A shell interpreter: allowed, but the caller should know the array is being
  // handed to a shell rather than to the tool directly.
  const base = input.command.split(sep).pop() ?? input.command;
  if (SHELL_COMMANDS.has(base) || SHELL_COMMANDS.has(input.command)) {
    warnings.push({
      kind: 'shell',
      message: `Runs through ${base}, so arguments are interpreted by the shell.`,
    });
  }

  // A cwd outside the project means the command can reach anywhere on disk.
  const cwd = normalize(resolve(input.cwd));
  const root = normalize(resolve(input.projectRoot));
  const rel = relative(root, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    warnings.push({
      kind: 'path',
      message: `Working directory ${cwd} is outside the project root ${root}.`,
    });
  }

  // Overriding a loader or interpreter variable is the shape of an injection.
  for (const name of Object.keys(input.env ?? {})) {
    if (SENSITIVE_ENV.has(name)) {
      warnings.push({
        kind: 'env',
        message: `Sets ${name}, which changes how the command is resolved or loaded.`,
      });
    }
  }

  // An inline script may embed a credential in its source text.
  for (const arg of args) {
    if (CREDENTIAL_FLAGS.test(arg)) {
      warnings.push({
        kind: 'credential',
        message: `Passes a credential as an argument (${arg.split('=')[0]}), which is visible in the process list.`,
      });
      break;
    }
  }

  return warnings;
}

/** True when nothing suspicious was found. */
export function isClean(input: ValidateCommandInput): boolean {
  return validateCommand(input).length === 0;
}

/** Warnings as single lines, for display. */
export function describeWarnings(warnings: readonly CommandWarning[]): readonly string[] {
  return warnings.map((w) => w.message);
}
