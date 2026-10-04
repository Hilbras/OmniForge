/**
 * `forge github` — inspect and manage GitHub release state.
 *
 * Read-only commands (`status`, `repository`) are safe to run anywhere. The
 * mutating ones (`tag`, `release`) confirm before writing, because a pushed tag
 * and a published release are both effectively permanent.
 */

import type { Command } from 'commander';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console as TerminalConsole, type Palette } from '../../ui/theme.js';
import { contextFor } from './context.js';
import { ConfigError, ErrorCode, toForgeError } from '../../errors/index.js';
import { resolveConfig } from '../../configuration/resolve.js';
import { resolveGitHub } from '../../authentication/index.js';
import { readGitRemote, readGitState } from '../../build/git.js';
import { GitHubProvider } from '../../providers/github/index.js';
import { getRepository, isAvailable } from '../../providers/github/client.js';
import type { ForgeConfig } from '../../configuration/schema.js';

export interface GitHubCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly palette: Palette;
  /** Asks the human to confirm a destructive action. */
  readonly confirm: (question: string) => Promise<boolean>;
}

/** Attach the `github` command group. */
export function registerGitHubCommand(program: Command, deps: GitHubCommandDeps): void {
  const out = (): TerminalConsole =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  const gh = program
    .command('github')
    .description('Inspect and manage GitHub release state')
    .addHelpText(
      'after',
      `
Commands:
  status      Authentication, repository, and working-tree state
  repository  Repository metadata and default branch
  tag         Show or create a release tag
  release     Show or create a GitHub Release

Examples:
  $ forge github status
  $ forge github repository
  $ forge github tag --show
  $ forge github tag --release-version 1.2.3 --push
  $ forge github release --release-version 1.2.3

Flags, by subcommand:
  tag       --release-version <semver> --show --push --yes
  release   --release-version <semver> --draft --prerelease --notes <text> --yes

Note: there is no --version flag. Commander routes it to the root version
handler, so \`forge github release --version 1.2.3\` would print the number and
exit without releasing anything. Use --release-version.
`,
    );

  gh.command('status')
    .description('Authentication, repository, and working-tree state')
    .action(async () => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const provider = new GitHubProvider();
      const ctx = contextFor(config, deps.env);

      c.heading('GitHub');

      const installed = await isAvailable({ cwd: config.projectRoot });
      c.info(
        installed
          ? 'gh CLI        available'
          : 'gh CLI        NOT FOUND — install from https://cli.github.com',
      );
      if (!installed) {
        c.detail('Every forge github command needs it.');
        return;
      }

      const credential = resolveGitHub(deps.env);
      if (!credential.present) {
        c.info('credentials   not set');
        c.detail('Run `gh auth login`, or export GITHUB_TOKEN.');
      } else {
        try {
          const auth = await provider.authenticate(ctx);
          c.success(`credentials   authenticated as ${auth.identity ?? 'unknown'}`);
        } catch (error) {
          const forgeError = toForgeError(error);
          c.failure(`credentials   ${forgeError.message}`);
          if (forgeError.remediation) c.detailError(`Next step: ${forgeError.remediation}`);
        }
      }

      const repo = await resolveRepository(config);
      if (repo === null) {
        c.warning('repository    not configured or detectable');
        return;
      }
      c.info(`repository    ${repo}`);

      const state = await readGitState(config.projectRoot);
      if (!state.isRepository) {
        c.warning('git           not a repository');
      } else {
        const dirty = state.dirtyPaths.length;
        c.info(`branch        ${state.branch ?? 'unknown'}`);
        c.info(`commit        ${state.shortCommit ?? 'unknown'}`);
        if (dirty === 0) {
          c.success('working tree  clean');
        } else {
          c.warning(`working tree  ${dirty} uncommitted change(s)`);
          for (const path of state.dirtyPaths.slice(0, 5)) c.detailError(path);
          if (dirty > 5) c.detailError(`…and ${dirty - 5} more`);
        }
      }
    });

  gh.command('repository')
    .description('Repository metadata and default branch')
    .action(async () => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const ctx = contextFor(config, deps.env);
      const repo = await resolveRepository(config);

      if (repo === null) {
        throw new ConfigError(
          ErrorCode.CONFIG_INVALID,
          'No GitHub repository configured or detectable.',
          {
            remediation: 'Set github.repository in forge.config.yaml, or add an origin remote.',
          },
        );
      }

      const info = await getRepository(repo, {
        token: ctx.getSecret('github'),
        cwd: config.projectRoot,
      });

      c.heading(info.fullName);
      c.line(`default branch  ${info.defaultBranch}`);
      c.line(`visibility      ${info.isPrivate ? 'private' : 'public'}`);
      c.line(`url             ${info.url}`);
      if (info.description !== null) c.line(`description     ${info.description}`);
    });

  gh.command('tag')
    .description('Show or create a release tag')
    // Not `--version`: commander routes that name to the *root* program's
    // version handler, which prints the version and exits, so
    // `forge github tag --version 1.2.3` would silently do nothing.
    // The `=` form happened to work, which made the bug easy to miss.
    .option('--release-version <semver>', 'Version to tag, without the prefix')
    .option('--show', 'Show the latest remote tag without changing anything')
    .option('--push', 'Push the tag to origin after creating it')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const ctx = contextFor(config, deps.env);
      const provider = new GitHubProvider();

      if (flags['show'] === true || flags['releaseVersion'] === undefined) {
        const observed = await provider.getVersion(ctx);
        c.heading('Tags');
        c.line(`latest   ${observed.version ?? '(none)'}`);
        c.detail(observed.reference);
        return;
      }

      const version = String(flags['releaseVersion']);
      const tag = `${config.version.tagPrefix}${version}`;

      c.heading(`Tag ${tag}`);
      c.detail(`repository  ${(await resolveRepository(config)) ?? '(unknown)'}`);
      c.detail(`commit      ${(await readGitState(config.projectRoot)).shortCommit ?? 'unknown'}`);

      if (flags['yes'] !== true) {
        const ok = await deps.confirm(`Create and push tag ${tag}?`);
        if (!ok) {
          c.info('Cancelled. Nothing was changed.');
          return;
        }
      }

      // Creation is Phase 8's orchestration job; here we create and push directly.
      const { createTag, pushTag } = await import('../../build/git.js');
      const result = await createTag(config.projectRoot, tag, `Release ${tag}`);
      c.success(`Created tag ${result.tag}`);

      if (flags['push'] === true) {
        await pushTag(config.projectRoot, tag);
        c.success(`Pushed ${tag} to origin`);
      } else {
        c.detail('Not pushed. Re-run with --push, or push it yourself.');
      }
    });

  gh.command('release')
    .description('Show or create a GitHub Release')
    // See the note on `forge github tag`: `--version` cannot be used here.
    .option('--release-version <semver>', 'Version to release, without the prefix')
    .option('--draft', 'Create as a draft')
    .option('--prerelease', 'Mark as a prerelease')
    .option('--notes <text>', 'Release notes, instead of generating them')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (flags: Record<string, string | boolean>) => {
      const c = out();
      const config = resolveConfig({ cwd: process.cwd() });
      const repo = await resolveRepository(config);

      if (repo === null) {
        throw new ConfigError(
          ErrorCode.CONFIG_INVALID,
          'No GitHub repository configured or detectable.',
          {
            remediation: 'Set github.repository in forge.config.yaml, or add an origin remote.',
          },
        );
      }

      const ctx = contextFor(config, deps.env);
      const provider = new GitHubProvider();
      const tagPrefix = config.version.tagPrefix;

      if (flags['releaseVersion'] === undefined) {
        c.heading('Releases');
        const observed = await provider.getVersion(ctx);
        c.line(`latest   ${observed.version ?? '(none)'}`);
        c.detail(observed.reference);
        return;
      }

      const version = String(flags['releaseVersion']);
      const tag = `${tagPrefix}${version}`;

      const existing = await getReleaseFor(config, deps.env, tag);
      if (existing !== null) {
        c.warning(`A release already exists for ${tag}.`);
        c.detailError(existing.url || existing.tagName);
        c.detailError('Forge never overwrites a release.');
        return;
      }

      c.heading(`Release ${tag}`);
      c.detail(`repository  ${repo}`);
      c.detail(`draft       ${flags['draft'] === true || config.github.draft}`);
      c.detail(`prerelease  ${flags['prerelease'] === true || config.github.prerelease}`);

      if (flags['yes'] !== true) {
        const ok = await deps.confirm(`Publish release ${tag} to ${repo}?`);
        if (!ok) {
          c.info('Cancelled. Nothing was published.');
          return;
        }
      }

      const result = await provider.publish(ctx, {
        version,
        draft: flags['draft'] === true || config.github.draft,
        prerelease: flags['prerelease'] === true || config.github.prerelease,
        ...(typeof flags['notes'] === 'string' ? { notes: flags['notes'] } : {}),
      });

      if (result.published) {
        c.success(`Published ${tag}`);
        c.detail(result.reference);
      } else {
        c.info('Dry run — nothing published.');
      }
    });
}

/** Fetch an existing release for a tag, or null. */
async function getReleaseFor(config: ForgeConfig, env: NodeJS.ProcessEnv, tag: string) {
  const repo = await resolveRepository(config);
  if (repo === null) return null;
  const { getRelease } = await import('../../providers/github/client.js');
  const credential = resolveGitHub(env);
  return getRelease(repo, tag, {
    token: credential.source === 'environment' ? env['GITHUB_TOKEN'] : undefined,
    cwd: config.projectRoot,
  });
}

/** The configured repository, or the one from the origin remote. */
async function resolveRepository(config: ForgeConfig): Promise<string | null> {
  if (config.github.repository !== null && config.github.repository.length > 0) {
    return config.github.repository;
  }
  return readGitRemote(config.projectRoot);
}

/**
 * Build a provider context.
 *
 * `getSecret` returns the token only when one is actually in the environment.
 * When authentication comes from `gh auth token`, it returns undefined and the
 * provider's `gh` calls authenticate themselves — that is the intended path,
 * not a missing credential, so the CLI reports `gh auth token` as the source.
 */
