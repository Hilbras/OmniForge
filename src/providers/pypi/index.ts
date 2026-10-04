/**
 * PyPI provider.
 *
 * Builds and uploads Python distributions, then verifies the release landed.
 *
 * Dry runs are real rehearsals: `twine upload --skip-existing` performs the same
 * existence check PyPI does, so a dry run can catch a version that is already
 * published instead of reporting success regardless.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

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
import { AuthError, CheckError, ConfigError, ErrorCode } from '../../errors/index.js';
import type { ForgeConfig } from '../../configuration/schema.js';
import {
  buildArtifacts,
  getRelease,
  listVersions,
  upload,
  validateArtifacts,
  type PyPiOptions,
} from './client.js';
import { normalizePackageName, validatePackageName } from './name.js';

export const PROVIDER_NAME = 'pypi';

/** Where built artifacts go, relative to the project root. */
const OUT_DIR = join('.forge', 'dist');

export class PyPiProvider implements Provider {
  readonly name = PROVIDER_NAME;

  capabilities(): ProviderCapabilities {
    return {
      name: PROVIDER_NAME,
      description: 'PyPI packages: sdist, wheel, upload, and verification',
      // Only what is implemented. The pipeline asks rather than assuming, so an
      // over-claim surfaces as a broken release rather than a compile error.
      capabilities: [Capability.Package, Capability.Upload, Capability.Verify],
      versionSources: ['pyproject.toml', 'PyPI'],
    };
  }

  async authenticate(context: ProviderContext): Promise<AuthResult> {
    const config = configOf(context);
    const token = context.getSecret(PROVIDER_NAME);

    if (token === undefined) {
      // Reading a public package needs no credential, so this is not an error —
      // only publishing does. Reported so the user knows before they try.
      return { authenticated: false, identity: 'anonymous' };
    }

    // A token must look like a token. A truncated or wrong-kind value is caught
    // here rather than as an opaque 401 at upload time.
    if (!token.startsWith('pypi-')) {
      throw new AuthError(
        ErrorCode.AUTH_FAILED,
        `The ${config.pypi.tokenEnv} does not look like a PyPI token.`,
        {
          provider: PROVIDER_NAME,
          operation: 'pypi.authenticate',
          remediation: 'PyPI tokens begin "pypi-". Generate one at pypi.org/manage/account/token/.',
        },
      );
    }

    return { authenticated: true, identity: 'pypi' };
  }

  async validate(context: ProviderContext): Promise<void> {
    // Project first: with no pyproject.toml there is no project, so complaining
    // about its configured name answers the wrong question.
    if (!existsSync(join(context.projectRoot, 'pyproject.toml'))) {
      throw new ConfigError(ErrorCode.CONFIG_INVALID, 'No pyproject.toml was found.', {
        provider: PROVIDER_NAME,
        operation: 'pypi.validate',
        remediation:
          'PyPI publishing needs a pyproject.toml. Set version.file to where your version lives.',
      });
    }

    const name = this.#packageName(context);
    const invalid = validatePackageName(name);
    if (invalid !== null) {
      throw new ConfigError(ErrorCode.CONFIG_INVALID, `Invalid PyPI project name: ${invalid}`, {
        provider: PROVIDER_NAME,
        operation: 'pypi.validate',
        remediation: 'Set pypi.package in forge.config.yaml, or fix the name in pyproject.toml.',
      });
    }
  }

  async getVersion(context: ProviderContext): Promise<ObservedVersion> {
    const name = this.#packageName(context);

    // The registry is authoritative for what is published; the file says what is
    // about to be. A release pipeline needs both, and `verify` compares them.
    const versions = await listVersions(name, this.#options(context));
    const current = versions?.[versions.length - 1] ?? null;

    return {
      provider: PROVIDER_NAME,
      version: current,
      reference: `https://pypi.org/project/${normalizePackageName(name)}/`,
    };
  }

  async publish(context: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const name = this.#packageName(context);
    const outDir = join(context.projectRoot, OUT_DIR);

    // Always start clean: a stale artifact from a previous run would be uploaded
    // under this version's name, and PyPI would reject it as a duplicate for a
    // reason that has nothing to do with this release.
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const options: PyPiOptions = { ...this.#options(context), dryRun: context.dryRun };

    const artifacts = await buildArtifacts(context.projectRoot, outDir, options);

    const problems = validateArtifacts(artifacts, name);
    if (problems.length > 0) {
      throw new CheckError(
        ErrorCode.CHECK_FAILED,
        `The built distributions are not publishable: ${name}.`,
        {
          provider: PROVIDER_NAME,
          operation: 'pypi.publish',
          remediation: 'Check the project name and version in pyproject.toml.',
          detail: { package: name, version: input.version, problems },
        },
      );
    }

    const uploaded = await upload(name, input.version, artifacts, options);

    return {
      published: !context.dryRun,
      version: input.version,
      reference: uploaded.repository,
    };
  }

  async verify(context: ProviderContext, version: string): Promise<VerificationResult> {
    const name = this.#packageName(context);
    const release = await getRelease(name, version, this.#options(context));

    const artifacts = release?.artifacts ?? [];
    const hasSdist = artifacts.some((a) => a.packagetype === 'sdist');
    const hasWheel = artifacts.some((a) => a.packagetype === 'bdist_wheel');

    const checks = [
      {
        name: 'release-exists',
        passed: release !== null,
        detail:
          release === null
            ? `${version} is not on PyPI`
            : `https://pypi.org/project/${normalizePackageName(name)}/${version}/`,
      },
      {
        name: 'version-matches',
        // Compared after normalisation: PyPI canonicalises the project name, so a
        // literal comparison would call `Foo.Bar` and `foo-bar` a mismatch.
        passed:
          release !== null &&
          normalizePackageName(release.version) === normalizePackageName(version),
        detail: release === null ? 'no release to compare' : `PyPI reports ${release.version}`,
      },
      {
        // A release with no sdist cannot be installed on a platform its wheels do
        // not cover, which is the whole point of publishing one.
        name: 'has-sdist',
        passed: hasSdist,
        detail: hasSdist ? 'sdist present' : 'no source distribution',
      },
      {
        name: 'has-wheel',
        passed: hasWheel,
        detail: hasWheel ? 'wheel present' : 'no wheel',
      },
      {
        name: 'not-yanked',
        passed: release !== null && !release.yanked,
        detail:
          release === null ? 'no release' : release.yanked ? 'the release is yanked' : 'not yanked',
      },
    ];

    return {
      provider: PROVIDER_NAME,
      verified: checks.every((c) => c.passed),
      observed: {
        provider: PROVIDER_NAME,
        version: release?.version ?? null,
        reference: `https://pypi.org/project/${normalizePackageName(name)}/`,
      },
      checks,
    };
  }

  /** The configured project name. */
  #packageName(context: ProviderContext): string {
    const config = configOf(context);
    if (config.pypi.package !== null && config.pypi.package.length > 0) {
      return config.pypi.package;
    }
    throw new ConfigError(ErrorCode.CONFIG_INVALID, 'No PyPI project name is configured.', {
      provider: PROVIDER_NAME,
      operation: 'pypi.package',
      remediation: 'Set pypi.package in forge.config.yaml.',
    });
  }

  #options(context: ProviderContext): PyPiOptions {
    const config = configOf(context);
    return {
      cwd: context.projectRoot,
      token: context.getSecret(PROVIDER_NAME),
      // An empty string would produce a repository URL of "" and a confusing 400.
      repository: config.pypi.repository ?? undefined,
    };
  }
}

/** Read the resolved config out of the context, defensively. */
function configOf(context: ProviderContext): ForgeConfig {
  return context.config as unknown as ForgeConfig;
}
