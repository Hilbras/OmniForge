/**
 * npm provider.
 *
 * Implements the `Provider` contract for npm publishing. Core learns nothing
 * about npm: it asks the registry for a provider named `npm` and calls these
 * methods through the interface.
 *
 * The rule this provider exists to enforce: a prerelease never gets the
 * `latest` tag. Getting that wrong silently ships unfinished code to everyone
 * who runs `npm install`.
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
import { AuthError, ErrorCode, ProviderError } from '../../errors/index.js';
import { execute, type ExecResult } from '../../build/exec.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import { isPrerelease } from '../../version/semver.js';
import * as npm from './client.js';

export const PROVIDER_NAME = 'npm';

export class NpmProvider implements Provider {
  readonly name = PROVIDER_NAME;

  capabilities(): ProviderCapabilities {
    return {
      name: PROVIDER_NAME,
      description: 'npm packages: publish, dist-tags, and registry verification',
      capabilities: [
        Capability.Package,
        Capability.Publish,
        Capability.DistTags,
        Capability.Verify,
      ],
      versionSources: ['package.json', 'npm registry'],
    };
  }

  /** The package name this provider targets. */
  #packageName(context: ProviderContext): string {
    const configured = configOf(context).npm.package;
    if (configured !== null && configured.length > 0) return configured;

    throw new ProviderError(ErrorCode.PROVIDER_FAILED, 'No npm package configured.', {
      provider: this.name,
      operation: 'npm.package',
      remediation: 'Set npm.package in forge.config.yaml, or npm.publish will read package.json.',
    });
  }

  /**
   * Verify credentials.
   *
   * Runs `npm whoami` through the executor, which reads the same auth the
   * publish will use. The token is never passed as a CLI argument — an argument
   * is visible in the process list, and a token must not be.
   */
  async authenticate(context: ProviderContext): Promise<AuthResult> {
    const result = await runnerFrom(context)('npm', ['whoami'], {
      cwd: context.projectRoot,
      ...(context.getSecret('npm') === undefined
        ? {}
        : { env: { NPM_TOKEN: context.getSecret('npm') ?? '' } }),
    });

    if (result.exitCode !== 0) {
      throw new AuthError(ErrorCode.AUTH_FAILED, 'npm authentication failed.', {
        provider: this.name,
        operation: 'npm.authenticate',
        remediation: 'Set NPM_TOKEN to a token with publish access for the package.',
        detail: { reason: firstLine(result.stderr) || firstLine(result.stdout) },
      });
    }

    return { authenticated: true, identity: result.stdout.trim() };
  }

  /**
   * Check the package can be published.
   *
   * Validates the name locally and confirms the package builds, because a
   * publish that fails on a missing name is a wasted irreversible attempt.
   */
  async validate(context: ProviderContext): Promise<void> {
    const config = configOf(context);
    const name = this.#packageName(context);

    const nameProblem = npm.validatePackageName(name);
    if (nameProblem !== null) {
      throw new ProviderError(ErrorCode.PROVIDER_FAILED, nameProblem, {
        provider: this.name,
        operation: 'npm.validate',
        remediation: `Set npm.package in forge.config.yaml — "${name}" is not a valid npm name.`,
        detail: { package: name },
      });
    }

    if (context.dryRun) return;

    // `npm pack --dry-run` resolves the files list without publishing.
    const packed = await runnerFrom(context)('npm', ['pack', '--dry-run', '--json'], {
      cwd: context.projectRoot,
    });

    if (packed.exitCode !== 0) {
      throw new ProviderError(ErrorCode.PROVIDER_FAILED, `npm pack failed for ${name}.`, {
        provider: this.name,
        operation: 'npm.validate',
        remediation: 'Fix the packaging error, or check that package.json has a files list.',
        detail: { output: (packed.stderr || packed.stdout).trim().slice(0, 800) },
      });
    }

    void config;
  }

  async getVersion(context: ProviderContext): Promise<ObservedVersion> {
    const name = this.#packageName(context);
    const config = configOf(context);

    const info = await npm.getPackage(name, {
      token: context.getSecret('npm'),
      registry: config.npm.registry,
    });

    return {
      provider: this.name,
      version: info?.latest ?? null,
      reference: `${config.npm.registry}/${name}`,
    };
  }

  /**
   * Publish to npm.
   *
   * The dist-tag is derived from the version unless config overrides it, and a
   * prerelease is never allowed to take `latest`.
   */
  async publish(context: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const name = this.#packageName(context);
    const config = configOf(context);
    const token = context.getSecret('npm');
    const prerelease = input.prerelease ?? isPrerelease(input.version);

    // A prerelease on `latest` would ship unfinished code to every plain
    // `npm install`, so it is corrected rather than honoured.
    const requested = config.npm.distTag;
    const derived = npm.distTagFor(input.version, prerelease);
    const distTag = prerelease && requested === 'latest' ? derived : requested;

    // A dry run still calls npm, with `--dry-run`. npm then packs the tarball,
    // resolves the `files` allowlist, and reports exactly what it *would*
    // upload — which is the only useful thing a dry run can tell you. Returning
    // early here would make `--dry-run` a no-op that always "succeeds", and a
    // broken `files` list would go unnoticed until the real publish.
    const outcome = await npm.publish(name, input.version, distTag, {
      token,
      registry: config.npm.registry,
      access: config.npm.access,
      cwd: context.projectRoot,
      runner: runnerFrom(context),
      dryRun: context.dryRun,
    });

    if (context.dryRun) {
      return {
        published: false,
        reference: `dry-run://npm/${name}@${input.version}#${distTag}`,
        version: input.version,
      };
    }

    // Record what the tag actually became, in case npm or the config disagreed.
    const verifiedTag = await npm.distTagOf(name, input.version, {
      token,
      registry: config.npm.registry,
    });

    return {
      published: outcome.published,
      reference:
        verifiedTag === null
          ? `${config.npm.registry}/package/${name}/v/${input.version}`
          : `${config.npm.registry}/${name}#${verifiedTag}`,
      version: input.version,
    };
  }

  /**
   * Confirm the version landed and carries the expected dist-tag.
   *
   * A publish that reports success but lands on the wrong tag is a silent
   * failure from a user's perspective, so the tag is part of verification rather
   * than assumed.
   */
  async verify(context: ProviderContext, version: string): Promise<VerificationResult> {
    const name = this.#packageName(context);
    const config = configOf(context);
    const token = context.getSecret('npm');

    const info = await npm.getPackage(name, { token, registry: config.npm.registry });
    const exists = info !== null && info.versions.includes(version);

    const prerelease = isPrerelease(version);
    const expectedTag = npm.distTagFor(version, prerelease);
    const actualTag = info === null ? null : findTag(info, version);

    const checks = [
      {
        name: 'package-exists',
        passed: info !== null,
        detail: info === null ? `${name} is not in the registry` : name,
      },
      {
        name: 'version-exists',
        passed: exists,
        detail: exists ? version : `${version} not published`,
      },
      {
        name: 'dist-tag-matches',
        passed: actualTag === expectedTag,
        detail:
          actualTag === null
            ? 'no dist-tag points at this version'
            : `expected ${expectedTag}, saw ${actualTag}`,
      },
      {
        // The safety property, asserted rather than assumed.
        name: 'prerelease-not-on-latest',
        passed: !prerelease || actualTag !== 'latest',
        detail: prerelease
          ? actualTag === 'latest'
            ? 'a prerelease is tagged latest — every install would get it'
            : `tagged ${actualTag ?? 'nothing'}`
          : 'not a prerelease',
      },
    ];

    return {
      provider: this.name,
      verified: checks.every((check) => check.passed),
      observed: {
        provider: this.name,
        version: actualTag === null ? null : version,
        reference: `${config.npm.registry}/${name}`,
      },
      checks,
    };
  }
}

/** Which dist-tag, if any, points at a version. */
function findTag(info: npm.PackageInfo, version: string): string | null {
  for (const [tag, tagged] of Object.entries(info.distTags)) {
    if (tagged === version) return tag;
  }
  return null;
}

/**
 * The runner a provider context supplies, if any.
 *
 * Mirrors the GitHub provider: a context carrying `execute.run` is used as the
 * executor, which is how the tests drive this provider offline.
 */
function runnerFrom(context: ProviderContext) {
  const executor = context.execute;
  if (executor === undefined) return execute;

  return async (
    command: string,
    args: readonly string[] = [],
    options?: Parameters<typeof execute>[2],
  ): Promise<ExecResult> => {
    const result = await executor.run(command, args, options ?? {});
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

/** Read the Forge config out of a provider context. */
function configOf(context: ProviderContext): ForgeConfig {
  return context.config as unknown as ForgeConfig;
}

/** First non-empty line of output, for a diagnostic. */
function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  ).slice(0, 300);
}
