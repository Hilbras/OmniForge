/**
 * `forge pypi` — inspect, build, publish, and verify a Python package.
 *
 * Mirrors `forge npm`, so the two platforms read the same way.
 */

import { join } from 'node:path';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import type { Command } from 'commander';

import { resolveConfig } from '../../configuration/resolve.js';
import { PyPiProvider } from '../../providers/pypi/index.js';
import {
  buildArtifacts,
  getRelease,
  listVersions,
  upload,
  validateArtifacts,
} from '../../providers/pypi/client.js';
import { normalizePackageName } from '../../providers/pypi/name.js';
import { exitCodeFor, ExitCode } from '../exit-codes.js';
import { toForgeError } from '../../errors/index.js';
import { contextFor } from './context.js';

export interface PyPiCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly palette: Palette;
}

/** Attach the `pypi` command group. */
export function registerPyPiCommand(program: Command, deps: PyPiCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text: string): string => globalSecrets.redact(text),
    });

  const pypi = program
    .command('pypi')
    .description('Inspect and publish PyPI packages')
    .addHelpText(
      'after',
      `
Builds an sdist and a wheel with \`python -m build\`, then uploads with \`twine\`.
Credentials come from PYPI_TOKEN (or pypi.tokenEnv) and are passed to twine
through the environment, so they never appear in the process list.

Publishing to PyPI is irreversible. Always run --dry-run first.

Examples:
  $ forge pypi status
  $ forge pypi build
  $ forge pypi publish --dry-run
  $ forge pypi verify --release-version 1.0.0

Flags, by subcommand:
  status    --config <path>
  build     --config <path>
  publish   --release-version <semver> --config <path> --dry-run --yes
  verify    --release-version <semver> --config <path>
`,
    );

  pypi
    .command('status')
    .description('Check authentication, package name, and registry state')
    .option('--config <path>', 'Path to forge.config.yaml')
    .action(async (flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd(), configPath: flagPath(flags) });
      const provider = new PyPiProvider();

      c.heading('PyPI');
      c.line(`project      ${config.pypi.package ?? '(not configured)'}`);
      c.line(`repository   ${config.pypi.repository ?? 'https://upload.pypi.org/legacy/'}`);

      try {
        const auth = await provider.authenticate(contextFor(config, deps.env));
        if (auth.authenticated) {
          c.success(`credentials   available via ${config.pypi.tokenEnv}`);
        } else {
          // Reading a public package needs no credential; only publishing does.
          c.warning(`credentials   not set (${config.pypi.tokenEnv})`);
          c.detailError('Reading a public package needs no token. Uploading does.');
        }
      } catch (error) {
        c.failure(toForgeError(error).message);
        return;
      }

      if (config.pypi.package === null) return;

      try {
        const versions = await listVersions(
          config.pypi.package,
          optionsFor(config, deps.env, process.cwd()),
        );
        if (versions === null) {
          c.line(`published    0 version(s) — not on PyPI yet`);
        } else {
          c.line(`published    ${versions.length} version(s)`);
          c.line(`latest       ${versions[versions.length - 1] ?? '(none)'}`);
        }
      } catch (error) {
        // A registry that cannot be reached is not a registry with nothing.
        const forgeError = toForgeError(error);
        c.failure(forgeError.message);
        if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
      }
    });

  pypi
    .command('build')
    .description('Build an sdist and a wheel into .forge/dist')
    .option('--config <path>', 'Path to forge.config.yaml')
    .action(async (flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd(), configPath: flagPath(flags) });
      const name = requirePackageName(config, c);
      if (name === null) return;

      const outDir = join(config.projectRoot, '.forge', 'dist');
      c.heading(`Build ${name}`);

      try {
        // Validate before building. Without this, a missing pyproject.toml produced
        // "could not build the distributions" with advice about a build backend —
        // answering a question the user had not asked.
        await new PyPiProvider().validate(contextFor(config, deps.env));
      } catch (error) {
        failWith(c, error);
        return;
      }

      try {
        const artifacts = await buildArtifacts(
          config.projectRoot,
          outDir,
          optionsFor(config, deps.env, config.projectRoot),
        );

        for (const artifact of artifacts) {
          c.line(`  ${artifact.kind.padEnd(6)} ${artifact.filename}  ${artifact.sizeBytes} bytes`);
        }

        const problems = validateArtifacts(artifacts, name);
        if (problems.length > 0) {
          c.blank();
          c.failure('These distributions are not publishable:');
          for (const problem of problems) c.detailError(problem);
          process.exitCode = ExitCode.Generic;
          return;
        }

        c.blank();
        c.success(`Built ${artifacts.length} distribution(s) into ${outDir}`);
      } catch (error) {
        failWith(c, error);
      }
    });

  pypi
    .command('publish')
    .description('Build and upload to PyPI')
    .option('--release-version <semver>', 'Version being published, for the report')
    .option('--config <path>', 'Path to forge.config.yaml')
    .option('--dry-run', 'Rehearse the upload without publishing')
    .option('--yes', 'Skip the confirmation prompt')
    .addHelpText(
      'after',
      `
--dry-run passes --skip-existing to twine, which performs the same existence
check PyPI does. It is a real rehearsal, not a no-op that always succeeds.

Publishing to PyPI is irreversible: a file name cannot be reused. Run --dry-run
first, and try a throwaway project name before your first real release.

Examples:
  $ forge pypi publish --dry-run
  $ forge pypi publish --yes
`,
    )
    .action(async (flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd(), configPath: flagPath(flags) });
      const name = requirePackageName(config, c);
      if (name === null) return;

      const dryRun = flags['dryRun'] === true;
      const version =
        typeof flags['releaseVersion'] === 'string' ? flags['releaseVersion'] : '(unspecified)';

      c.heading(`${dryRun ? 'Dry run: publish' : 'Publish'} ${name} ${version}`);

      try {
        const context = contextFor(config, deps.env);
        const provider = new PyPiProvider();
        // Validate before building, so a broken config fails before twine is
        // involved at all.
        await provider.validate(context);

        const result = await provider.publish(
          { ...context, dryRun },
          { version, prerelease: version.includes('-') },
        );

        c.blank();
        if (result.published) {
          c.success(`Uploaded ${name} ${version} to ${result.reference}`);
        } else {
          c.success('Dry run complete — the upload was rehearsed, not performed.');
          c.detail('Nothing was uploaded.');
        }
      } catch (error) {
        failWith(c, error);
      }
    });

  pypi
    .command('verify')
    .description('Confirm a version is published with both distributions')
    .argument('[version]', 'Version to verify; defaults to the latest on PyPI')
    .option('--release-version <semver>', 'Version to verify, as a flag')
    .option('--config <path>', 'Path to forge.config.yaml')
    .action(async (positional: string | undefined, flags: Record<string, unknown>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd(), configPath: flagPath(flags) });
      const name = requirePackageName(config, c);
      if (name === null) return;

      const version =
        typeof flags['releaseVersion'] === 'string'
          ? flags['releaseVersion']
          : (positional ?? (await latestVersion(config, deps.env)) ?? '');
      if (version.length === 0) {
        c.failure('No version to verify, and PyPI has no releases for this project.');
        process.exitCode = ExitCode.Verification;
        return;
      }

      c.heading(`Verify ${normalizePackageName(name)}@${version}`);
      try {
        const provider = new PyPiProvider();
        const result = await provider.verify(contextFor(config, deps.env), version);

        for (const check of result.checks) {
          const line = check.name.padEnd(16);
          if (check.passed) c.success(`${line} ${check.detail}`);
          else c.failure(`${line} ${check.detail}`);
        }

        c.blank();
        if (result.verified) {
          c.success(`${version} verified on PyPI`);
        } else {
          c.failure(`${version} is not correctly published`);
          process.exitCode = ExitCode.Verification;
        }
      } catch (error) {
        failWith(c, error);
        process.exitCode = exitCodeFor(toForgeError(error).code);
      }
    });
}

/** The configured project name, or null after reporting why there isn't one. */
function requirePackageName(
  config: ReturnType<typeof resolveConfig>,
  c: TerminalConsole,
): string | null {
  if (config.pypi.package !== null && config.pypi.package.length > 0) return config.pypi.package;
  c.failure('No PyPI project name is configured.');
  c.detailError('Set pypi.package in forge.config.yaml.');
  process.exitCode = ExitCode.Config;
  return null;
}

async function latestVersion(
  config: ReturnType<typeof resolveConfig>,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (config.pypi.package === null) return null;
  try {
    const versions = await listVersions(
      config.pypi.package,
      optionsFor(config, env, config.projectRoot),
    );
    return versions?.[versions.length - 1] ?? null;
  } catch {
    return null;
  }
}

function optionsFor(config: ReturnType<typeof resolveConfig>, env: NodeJS.ProcessEnv, cwd: string) {
  return {
    cwd,
    token: env[config.pypi.tokenEnv],
    repository: config.pypi.repository ?? undefined,
  };
}

function flagPath(flags: Record<string, unknown>): string | undefined {
  return typeof flags['config'] === 'string' ? flags['config'] : undefined;
}

/** Report a failure through the one top-level path. */
function failWith(c: TerminalConsole, error: unknown): void {
  const forgeError = toForgeError(error);
  c.failure(forgeError.message);
  if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
  process.exitCode = exitCodeFor(forgeError.code);
}

// Referenced so the unused import is meaningful: getRelease is re-exported by the
// client and used by the provider's verify path; naming it here keeps the module's
// dependency on the client explicit.
void getRelease;
void upload;
