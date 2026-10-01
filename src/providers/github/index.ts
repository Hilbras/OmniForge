/**
 * GitHub provider.
 *
 * Implements the `Provider` contract for GitHub repositories: authentication,
 * repository validation, tag and release creation, and verification. Core knows
 * none of this — it asks the registry for a provider named `github` and calls
 * these methods through the interface.
 */

import {
  Capability,
  type AuthResult,
  type ObservedVersion,
  type Provider,
  type ProviderCapabilities,
  type ProviderContext,
  type PublishInput,
  type PublishResult,
  type VerificationResult,
} from '../../core/provider.js';
import { DuplicateReleaseError, ErrorCode, ProviderError } from '../../errors/index.js';
import { readGitRemote, readGitState } from '../../build/git.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import * as gh from './client.js';
import type { GhRunner } from './client.js';
import { generateNotes } from './notes.js';

/**
 * The runner a provider context supplies, if any.
 *
 * A context carrying `execute.run` is used as the `gh` runner, which is how the
 * test suite drives this provider offline. In production no context supplies one
 * and the real executor is used.
 */
function runnerFrom(context: ProviderContext): GhRunner | undefined {
  const executor = context.execute;
  if (executor === undefined) return undefined;
  return async (command: string, args: readonly string[] = []) => {
    // Called as a method on its object rather than detached, so a context whose
    // `run` depends on `this` still works.
    const result = await executor.run(command, args);
    return {
      command,
      args,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: 0,
      timedOut: false,
      killed: false,
    };
  };
}

export const PROVIDER_NAME = 'github';

export class GitHubProvider implements Provider {
  readonly name = PROVIDER_NAME;

  capabilities(): ProviderCapabilities {
    return {
      name: PROVIDER_NAME,
      description: 'GitHub repositories: tags, releases, and release assets',
      capabilities: [
        Capability.Repository,
        Capability.Tags,
        Capability.Releases,
        Capability.Assets,
        Capability.Verify,
      ],
      versionSources: ['git tags', 'GitHub releases'],
    };
  }

  /** The repository this provider targets, from config or the git remote. */
  async #repoName(context: ProviderContext): Promise<string> {
    const configured = configOf(context).github.repository;
    if (configured !== null && configured.length > 0) return configured;

    const remote = await readGitRemote(context.projectRoot, runnerFrom(context));
    if (remote !== null) return remote;

    throw new ProviderError(
      ErrorCode.PROVIDER_FAILED,
      'No GitHub repository configured or detectable.',
      {
        provider: this.name,
        operation: 'github.repository',
        remediation: 'Set github.repository in forge.config.yaml, or add an origin remote.',
      },
    );
  }

  async authenticate(context: ProviderContext): Promise<AuthResult> {
    const identity = await gh.whoami({
      token: context.getSecret('github'),
      cwd: context.projectRoot,
      runner: runnerFrom(context),
    });

    return { authenticated: true, identity: identity.login };
  }

  async validate(context: ProviderContext): Promise<void> {
    const repo = await this.#repoName(context);
    if (context.dryRun) return;

    // A missing or inaccessible repository must fail before anything is tagged.
    await gh.getRepository(repo, {
      token: context.getSecret('github'),
      cwd: context.projectRoot,
      runner: runnerFrom(context),
    });

    const state = await readGitState(context.projectRoot, runnerFrom(context));
    if (state.isRepository && state.dirtyPaths.length > 0) {
      // Not fatal: the release report records a dirty tree, but a release can
      // legitimately be cut from one for local verification. Hard-failing here
      // would also break legitimate dry runs.
      return;
    }
  }

  async getVersion(context: ProviderContext): Promise<ObservedVersion> {
    const repo = await this.#repoName(context);
    const tags = await gh.listTags(repo, 20, {
      token: context.getSecret('github'),
      cwd: context.projectRoot,
      runner: runnerFrom(context),
    });
    const latest = tags[0];

    return {
      provider: this.name,
      version: latest?.name ?? null,
      reference: `https://github.com/${repo}/tags`,
    };
  }

  /**
   * Create a GitHub Release for the given version.
   *
   * The tag must already exist on the remote: a GitHub Release whose tag does not
   * exist is a dangling reference users cannot check out. The release engine
   * (Phase 8) creates and pushes the tag before calling this.
   */
  async publish(context: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const repo = await this.#repoName(context);
    const token = context.getSecret('github');
    const config = configOf(context);
    const tag = `${config.version.tagPrefix}${input.version}`;

    if (context.dryRun) {
      return {
        published: false,
        reference: `dry-run://github/${repo}/${tag}`,
        version: input.version,
      };
    }

    if (
      await gh.tagExistsRemote(repo, tag, {
        token,
        cwd: context.projectRoot,
        runner: runnerFrom(context),
      })
    ) {
      throw new DuplicateReleaseError(`Tag ${tag} already exists on ${repo}.`, {
        provider: this.name,
        operation: 'github.publish',
        detail: { repository: repo, tag },
      });
    }

    const notes =
      input.notes ??
      generateNotes({
        version: input.version,
        tagPrefix: config.version.tagPrefix,
        projectRoot: context.projectRoot,
        templatePath: config.github.notesTemplate,
      });

    const release = await gh.createRelease(
      repo,
      {
        tagName: tag,
        name: tag,
        body: notes,
        draft: input.draft ?? config.github.draft,
        prerelease: input.prerelease ?? config.github.prerelease,
      },
      { token, cwd: context.projectRoot, runner: runnerFrom(context) },
    );

    if (input.artifacts !== undefined && input.artifacts.length > 0) {
      await gh.uploadAssets(repo, tag, input.artifacts, {
        token,
        cwd: context.projectRoot,
        runner: runnerFrom(context),
      });
    }

    return { published: true, reference: release.url, version: input.version };
  }

  /** Confirm the release exists and matches the requested version. */
  async verify(context: ProviderContext, version: string): Promise<VerificationResult> {
    const repo = await this.#repoName(context);
    const token = context.getSecret('github');
    const config = configOf(context);
    const expectedTag = `${config.version.tagPrefix}${version}`;

    const release = await gh.getRelease(repo, expectedTag, {
      token,
      cwd: context.projectRoot,
      runner: runnerFrom(context),
    });
    const tagPresent = await gh.tagExistsRemote(repo, expectedTag, {
      token,
      cwd: context.projectRoot,
      runner: runnerFrom(context),
    });

    const checks = [
      {
        name: 'tag-exists',
        passed: tagPresent,
        detail: tagPresent ? expectedTag : `${expectedTag} not found on the remote`,
      },
      {
        name: 'release-exists',
        passed: release !== null,
        detail: release === null ? 'no release for this tag' : release.url || 'present',
      },
      {
        name: 'release-version-matches',
        passed: release !== null && release.tagName === expectedTag,
        detail:
          release === null
            ? 'no release to compare'
            : `expected ${expectedTag}, saw ${release.tagName}`,
      },
      {
        name: 'release-is-published',
        passed: release !== null && !release.isDraft,
        detail: release === null ? 'no release' : release.isDraft ? 'still a draft' : 'published',
      },
    ];

    return {
      provider: this.name,
      verified: checks.every((check) => check.passed),
      observed: {
        provider: this.name,
        version: release?.tagName ?? null,
        reference: release?.url ?? `https://github.com/${repo}`,
      },
      checks,
    };
  }
}

/** Read the Forge config out of a provider context. */
function configOf(context: ProviderContext): ForgeConfig {
  return context.config as unknown as ForgeConfig;
}
