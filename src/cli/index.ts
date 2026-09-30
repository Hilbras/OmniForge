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
import { createRequire } from 'node:module';
import { isForgeError, toForgeError } from '../errors/index.js';
import { createDefaultRegistry } from '../core/registry.js';

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

/** Print to stdout. Centralized so tests can assert on output shape. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Attach the `provider` command group. */
function registerProviderCommands(program: Command): void {
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
        out('No providers registered yet.');
        return;
      }
      for (const name of names) out(name);
    });

  provider
    .command('capabilities')
    .description('Show capabilities and version sources of every provider')
    .action(() => {
      const caps = registry.listCapabilities();
      if (caps.length === 0) {
        out('No providers registered yet.');
        return;
      }
      for (const entry of caps) {
        out(entry.name);
        out(`  ${entry.description}`);
        out(`  capabilities: ${entry.capabilities.join(', ') || 'none'}`);
        out(`  version sources: ${entry.versionSources.join(', ') || 'none'}`);
      }
    });
}

/** Build the root `forge` program with every command attached. */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('forge')
    .description('Unified release, publishing, versioning, and package management platform')
    .version(readVersion(), '-V, --version', 'Print the Forge version')
    .option('--verbose', 'Print stack traces for unexpected errors')
    .showHelpAfterError('(run `forge --help` for usage)')
    .configureOutput({
      writeErr: (str: string) => process.stderr.write(str),
    });

  registerProviderCommands(program);

  return program;
}

/**
 * Process exit codes, so scripts can branch on the class of failure.
 *
 * 1 generic, 2 configuration, 3 verification, 4 confirmation required.
 */
export const ExitCode = {
  Success: 0,
  Generic: 1,
  Config: 2,
  Verification: 3,
  Confirmation: 4,
} as const;

/** Render a fatal error to stderr in the CLI's four-part format. */
export function reportFatalError(error: unknown, verbose: boolean): number {
  const forgeError = toForgeError(error);

  process.stderr.write(`${forgeError.format()}\n`);

  if (verbose && forgeError.cause instanceof Error && forgeError.cause.stack !== undefined) {
    process.stderr.write(`\n${forgeError.cause.stack}\n`);
  }

  switch (forgeError.code) {
    case 'CONFIG_NOT_FOUND':
    case 'CONFIG_INVALID':
    case 'CONFIG_PARSE_ERROR':
      return ExitCode.Config;
    case 'VERIFICATION_FAILED':
    case 'INTEGRITY_FAILED':
      return ExitCode.Verification;
    case 'CONFIRMATION_REQUIRED':
      return ExitCode.Confirmation;
    default:
      return ExitCode.Generic;
  }
}

/** Parse argv and run. Returns the process exit code. */
export async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = buildProgram();
  const verbose = argv.includes('--verbose');

  try {
    await program.parseAsync([...argv]);
    return ExitCode.Success;
  } catch (error) {
    // Commander's own errors (unknown command, bad flag) already printed a message.
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    // Kept explicit for readability even though both branches format identically
    // today: confirmation-required gets its own exit code via reportFatalError.
    if (isForgeError(error) && error.code === 'CONFIRMATION_REQUIRED') {
      return reportFatalError(error, verbose);
    }
    return reportFatalError(error, verbose);
  }
}

/** True when this module is the process entry point, not an import. */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return (
      import.meta.url === new URL(`file://${entry}`).href ||
      import.meta.url.endsWith(entry.replace(/\\/g, '/'))
    );
  } catch {
    return false;
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
