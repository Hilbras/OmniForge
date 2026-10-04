/**
 * `forge npm` — inspect and publish to npm.
 *
 * Read-only commands are safe anywhere. `publish` and `dist-tag` mutate the
 * registry and confirm first; neither will run unattended without `--yes`.
 */

import type { Command } from 'commander';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import { resolveConfig } from '../../configuration/resolve.js';
import { resolveCredential } from '../../authentication/index.js';
import { ConfigError, ErrorCode, toForgeError } from '../../errors/index.js';
import { readVersionState } from '../../version/engine.js';
import { isPrerelease } from '../../version/semver.js';
import { execute } from '../../build/exec.js';
import { NpmProvider } from '../../providers/npm/index.js';
import * as npm from '../../providers/npm/client.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import type { ProviderContext } from '../../core/provider.js';

export interface NpmCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly palette: Palette;
  readonly confirm: (question: string) => Promise<boolean>;
}

/** Attach the `npm` command group. */
export function registerNpmCommand(program: Command, deps: NpmCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  const cmd = program
    .command('npm')
    .description('Inspect and publish npm packages')
    .addHelpText(
      'after',
      `
Commands:
  status      Authentication, package, and registry state
  package     Local package metadata as npm sees it
  publish     Publish the current version
  dist-tag    Show or move a dist-tag
  verify      Confirm a version landed with the right dist-tag

Examples:
  $ forge npm status
  $ forge npm package
  $ forge npm publish --dry-run
  $ forge npm publish --yes
  $ forge npm dist-tag
  $ forge npm verify --release-version 1.2.3
`,
    );

  cmd
    .command('status')
    .description('Authentication, package, and registry state')
    .action(async () => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const provider = new NpmProvider();
      const ctx = contextFor(config, deps.env, false);

      c.heading('npm');

      const credential = resolveCredential('npm', deps.env);
      c.info(`credentials   ${credential.present ? 'present' : 'not set'} (${credential.envVar})`);

      if (credential.present) {
        try {
          const auth = await provider.authenticate(ctx);
          c.success(`authenticated  as ${auth.identity ?? 'unknown'}`);
        } catch (error) {
          const forgeError = toForgeError(error);
          c.failure(forgeError.message);
          if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
        }
      } else {
        c.detailError('Set NPM_TOKEN to publish. Reading public packages needs no token.');
      }

      const name = config.npm.package;
      c.info(`package      ${name ?? '(not configured)'}`);
      c.detail(`registry     ${config.npm.registry}`);
      c.detail(`distTag      ${config.npm.distTag}`);

      if (name === null || name.length === 0) return;

      try {
        const info = await npm.getPackage(name, { registry: config.npm.registry });
        if (info === null) {
          c.info('published    no — not in the registry yet');
          return;
        }
        c.info(`published    ${info.versions.length} version(s)`);
        c.line(`latest       ${info.latest ?? '(none)'}`);
        const tags = Object.entries(info.distTags).map(([tag, v]) => `${tag}→${v}`);
        if (tags.length > 0) c.detail(tags.join('  '));
      } catch (error) {
        const forgeError = toForgeError(error);
        c.warning(forgeError.message);
      }
    });

  cmd
    .command('package')
    .description('Local package metadata as npm sees it')
    .action(async () => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const ctx = contextFor(config, deps.env, false);

      c.heading('Package');
      try {
        await new NpmProvider().validate(ctx);
        c.success('The package is publishable.');
      } catch (error) {
        const forgeError = toForgeError(error);
        c.failure(forgeError.message);
        if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
      }

      const name = config.npm.package;
      if (name !== null && name.length > 0) {
        const problem = npm.validatePackageName(name);
        c.detail(problem ?? `name ${name} is valid`);
      }
    });

  cmd
    .command('publish')
    .description('Publish the current version')
    // Deliberately no --version override: `npm publish` only ever publishes the
    // version in package.json, so a flag appearing to override it would silently
    // do nothing while reporting success. Bump the file first.
    .option('--tag <tag>', 'Override the dist-tag')
    .option('--dry-run', 'Pack and report without uploading')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      // Commander camelCases dashed flags: `--dry-run` arrives as `dryRun`.
      // Reading `flags['dry-run']` silently yields undefined, which made
      // `--dry-run` a no-op that still required confirmation.
      const dryRun = flags['dryRun'] === true;

      // Resolved up front: every path below needs a real package name, and a
      // null reaching the client would surface as a confusing registry error.
      const name = requirePackageName(config);

      // Always the version in package.json, because that is what npm packs.
      const version = readVersionState(config).current;
      const prerelease = isPrerelease(version);

      const override = typeof flags['tag'] === 'string' ? flags['tag'] : null;
      const distTag = override ?? npm.distTagFor(version, prerelease);

      if (prerelease && distTag === 'latest') {
        c.failure(`${version} is a prerelease and cannot be tagged latest.`);
        c.detailError('Use --tag next, or let Forge choose.');
        return;
      }

      c.heading(`${dryRun ? 'Dry run: publish' : 'Publish'} ${name}@${version}`);
      c.detail(`dist-tag   ${distTag}`);
      c.detail(`registry   ${config.npm.registry}`);

      if (!dryRun) {
        const existing = await npm.versionExists(name, version, { registry: config.npm.registry });
        if (existing) {
          c.failure(`${name}@${version} is already published.`);
          c.detailError('npm does not allow overwriting a version.');
          return;
        }

        if (flags['yes'] !== true) {
          const ok = await deps.confirm(`Publish ${name}@${version} to npm?`);
          if (!ok) {
            c.info('Cancelled. Nothing was published.');
            return;
          }
        }
      }

      const ctx = contextFor(config, deps.env, dryRun);
      try {
        const result = await new NpmProvider().publish(ctx, { version, prerelease });
        if (result.published) {
          c.success(`Published ${name}@${version}`);
          c.detail(result.reference);
        } else {
          c.success('Dry run — nothing was published.');
          c.detail(result.reference);
        }
      } catch (error) {
        const forgeError = toForgeError(error);
        c.failure(forgeError.message);
        if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
      }
    });

  cmd
    .command('dist-tag')
    .description('Show or move a dist-tag')
    .option('--tag <tag>', 'The dist-tag to move')
    .option('--to <version>', 'The version it should point at')
    .option('--remove', 'Remove the dist-tag instead of moving it')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const name = requirePackageName(config);
      const credential = resolveCredential('npm', deps.env);
      const token = credential.present ? deps.env['NPM_TOKEN'] : undefined;

      const info = await npm.getPackage(name, { registry: config.npm.registry, token });

      if (info === null) {
        c.warning(`${name} is not in the registry.`);
        return;
      }

      const tag = typeof flags['tag'] === 'string' ? flags['tag'] : null;

      if (tag === null) {
        c.heading('Dist-tags');
        const entries = Object.entries(info.distTags);
        if (entries.length === 0) {
          c.info('(none)');
          return;
        }
        for (const [name_, version] of entries) c.line(`${name_.padEnd(8)} ${version}`);
        return;
      }

      if (!npm.isDistTag(tag)) {
        c.failure(`"${tag}" is not a dist-tag Forge manages.`);
        c.detailError(`Known: ${npm.VALID_DIST_TAGS.join(', ')}.`);
        return;
      }

      const target = typeof flags['to'] === 'string' ? flags['to'] : null;

      if (flags['remove'] === true) {
        if (flags['yes'] !== true) {
          const ok = await deps.confirm(`Remove the ${tag} tag from ${name}?`);
          if (!ok) {
            c.info('Cancelled.');
            return;
          }
        }
        const removed = await npm.removeDistTag(name, tag, {
          registry: config.npm.registry,
          token,
        });
        if (removed) c.success(`Removed ${tag}`);
        else c.failure(`Could not remove ${tag}.`);
        return;
      }

      if (target === null) {
        c.failure('--to <version> is required to move a dist-tag.');
        c.detailError(`Example: forge npm dist-tag --tag next --to 1.3.0`);
        return;
      }

      if (!info.versions.includes(target)) {
        c.failure(`${target} is not published, so ${tag} cannot point at it.`);
        return;
      }

      if (flags['yes'] !== true) {
        const ok = await deps.confirm(`Point ${tag} at ${target}?`);
        if (!ok) {
          c.info('Cancelled.');
          return;
        }
      }

      await npm.setDistTag(name, tag, target, { registry: config.npm.registry, token });
      c.success(`${tag} → ${target}`);
    });

  cmd
    .command('verify')
    .description('Confirm a version landed with the right dist-tag')
    .option('--release-version <semver>', 'Version to verify; defaults to the current one')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const name = requirePackageName(config);
      const version =
        typeof flags['releaseVersion'] === 'string'
          ? flags['releaseVersion']
          : readVersionState(config).current;

      c.heading(`Verify ${name}@${version}`);

      try {
        const result = await new NpmProvider().verify(contextFor(config, deps.env, false), version);
        for (const check of result.checks) {
          const line = `${check.name.padEnd(24)} ${check.detail}`;
          if (check.passed) c.success(line);
          else c.failure(line);
        }
        c.blank();
        if (result.verified) c.success('Release verified.');
        else c.failure('Verification failed.');
      } catch (error) {
        const forgeError = toForgeError(error);
        c.failure(forgeError.message);
        if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
      }
    });
}

/**
 * The configured package name, or a clear configuration error.
 *
 * Every publishing path needs a real name, and passing `null` into the registry
 * client would surface as a confusing HTTP error instead of a config problem.
 */
function requirePackageName(config: ForgeConfig): string {
  const name = config.npm.package;
  if (name === null || name.length === 0) {
    throw new ConfigError(ErrorCode.CONFIG_INVALID, 'No npm package is configured.', {
      remediation: 'Set npm.package in forge.config.yaml.',
    });
  }
  return name;
}

/**
 * Build a provider context.
 *
 * The real executor, because the npm provider shells out for `whoami`,
 * `pack`, and `publish`. A placeholder here would shadow those commands.
 */
function contextFor(config: ForgeConfig, env: NodeJS.ProcessEnv, dryRun: boolean): ProviderContext {
  const credential = resolveCredential('npm', env);
  return {
    projectRoot: config.projectRoot,
    config: config as unknown as Record<string, unknown>,
    getSecret: () => (credential.present ? env['NPM_TOKEN'] : undefined),
    execute: { run: (command, args, options) => execute(command, args, options ?? {}) },
    dryRun,
  };
}
