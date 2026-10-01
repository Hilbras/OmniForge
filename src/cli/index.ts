#!/usr/bin/env node
/**
 * Forge CLI entry point.
 *
 * Command registration is split into per-command modules under
 * `src/cli/commands/`, each owning its own help text. This file only wires the
 * program together and owns process-level concerns: exit codes, top-level error
 * rendering, and the `--version` / `--verbose` flags.
 */

import { Command, CommanderError } from 'commander';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isForgeError, toForgeError } from '../errors/index.js';
import { createDefaultRegistry } from '../core/registry.js';
// Aliased: the bare name `Console` is a global in @types/node and would shadow
// Forge's own terminal interface.
import {
  createConsole,
  createPalette,
  shouldUseColor,
  type Console as TerminalConsole,
} from '../ui/theme.js';
import { registerConfigCommand } from './commands/config.js';
import { registerGitHubCommand } from './commands/github.js';
import { ExitCode, exitCodeFor } from './exit-codes.js';

// Re-exported so library consumers and tests can branch on CLI outcomes.
export { ExitCode, exitCodeFor } from './exit-codes.js';

const require = createRequire(import.meta.url);

/** Read the package version without importing the package's own entry points. */
function readVersion(): string {
  try {
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the CLI console from the process environment.
 *
 * Colour is on only for a TTY, and `NO_COLOR` overrides everything, so piping
 * output or running in CI produces clean text.
 */
export function buildConsole(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { isTTY?: boolean } = process.stdout,
): TerminalConsole {
  return createConsole({
    write: (text: string) => process.stdout.write(text),
    writeError: (text: string) => process.stderr.write(text),
    palette: createPalette(shouldUseColor(env, stdout.isTTY === true)),
  });
}

/** Attach the `provider` command group. */
function registerProviderCommands(program: Command, term: TerminalConsole): void {
  const registry = createDefaultRegistry();

  const provider = program
    .command('provider')
    .description('Inspect registered release providers')
    .addHelpText(
      'after',
      `
Examples:
  $ forge provider list
  $ forge provider capabilities
`,
    );

  provider
    .command('list')
    .description('List every registered provider name')
    .action(() => {
      const names = registry.names();
      if (names.length === 0) {
        term.info('No providers registered yet.');
        return;
      }
      for (const name of names) term.line(name);
    });

  provider
    .command('capabilities')
    .description('Show capabilities and version sources of every provider')
    .action(() => {
      const caps = registry.listCapabilities();
      if (caps.length === 0) {
        term.info('No providers registered yet.');
        return;
      }
      for (const entry of caps) {
        term.line(term.palette.gold(entry.name));
        term.detail(entry.description);
        term.line(`  capabilities: ${entry.capabilities.join(', ') || 'none'}`);
        term.line(`  version sources: ${entry.versionSources.join(', ') || 'none'}`);
      }
    });
}

/** Build the root `forge` program with every command attached. */
export function buildProgram(term: TerminalConsole = buildConsole()): Command {
  const program = new Command();

  program
    .name('forge')
    .description('Unified release, publishing, versioning, and package management platform')
    .version(readVersion(), '-V, --version', 'Print the Forge version')
    .option('--verbose', 'Print stack traces for unexpected errors')
    .option('--no-color', 'Disable colored output')
    .showHelpAfterError('(run `forge --help` for usage)')
    .configureOutput({
      writeErr: (str: string) => process.stderr.write(str),
    });

  registerProviderCommands(program, term);
  registerConfigCommand(program, {
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    env: process.env,
    palette: term.palette,
  });
  registerGitHubCommand(program, {
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    env: process.env,
    palette: term.palette,
    confirm: askYesNo,
  });

  return program;
}

/**
 * Ask for confirmation before a destructive action.
 *
 * Reads from stdin. Non-interactive runs (CI, pipes) answer no rather than
 * hanging or auto-approving — a script should pass `--yes` deliberately.
 */
function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      `\u001b[2mRefusing to continue without confirmation. Re-run with --yes.\u001b[0m\n`,
    );
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const onData = (chunk: Buffer): void => {
      const answer = chunk.toString().trim().toLowerCase();
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      resolve(answer === 'y' || answer === 'yes');
    };

    process.stdout.write(`\u001b[33m?\u001b[0m ${question} [y/N] `);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/**
 * Render a fatal error to stderr in the CLI's four-part format: what failed,
 * why, which operation it affected, and what to do next.
 */
export function reportFatalError(
  error: unknown,
  verbose: boolean,
  term: TerminalConsole = buildConsole(),
): number {
  const forgeError = toForgeError(error);
  const p = term.palette;

  term.writeErrorPlain(`${p.red(forgeError.message)}\n`);
  if (forgeError.operation !== undefined)
    term.writeErrorPlain(`  Operation:  ${forgeError.operation}\n`);
  if (forgeError.provider !== undefined)
    term.writeErrorPlain(`  Provider:   ${forgeError.provider}\n`);
  term.writeErrorPlain(`  Code:       ${forgeError.code}\n`);
  if (forgeError.remediation !== undefined) {
    term.writeErrorPlain(`  Next step:  ${forgeError.remediation}\n`);
  }

  if (verbose && forgeError.cause instanceof Error && forgeError.cause.stack !== undefined) {
    term.writeErrorPlain(`\n${forgeError.cause.stack}\n`);
  }

  return exitCodeFor(forgeError.code);
}

/** Parse argv and run. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const term = buildConsole();
  const program = buildProgram(term);
  const verbose = argv.includes('--verbose');

  try {
    await program.parseAsync([...argv]);
    return ExitCode.Success;
  } catch (error) {
    // Commander's own errors (unknown command, bad flag) already printed a message.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    // Both branches format identically today; confirmation-required is called
    // out so adding distinct handling later is a one-line change.
    if (isForgeError(error) && error.code === 'CONFIRMATION_REQUIRED') {
      return reportFatalError(error, verbose, term);
    }
    return reportFatalError(error, verbose, term);
  }
}

/**
 * True when this module is the process entry point, not an import.
 *
 * Both paths must be resolved through `realpath` before comparing. npm installs
 * a package's `bin` as a *symlink* under `node_modules/.bin`, so
 * `process.argv[1]` is the symlink path while `import.meta.url` is the real file
 * inside the package. Comparing them unresolved fails silently: the module
 * imports fine but the CLI never runs, so a globally installed `forge` exits 0
 * printing nothing.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;

  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved still deserves a best-effort comparison,
    // e.g. an in-memory or virtual module.
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  }
}

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.exitCode = reportFatalError(error, false);
    },
  );
}
