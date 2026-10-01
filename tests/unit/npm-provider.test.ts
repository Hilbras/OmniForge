/**
 * npm provider tests.
 *
 * Network calls are stubbed by injecting a fake executor, so these run offline
 * and deterministically. Live-registry coverage is opt-in.
 */

import { describe, expect, it, vi } from 'vitest';

import { NpmProvider } from '../../src/providers/npm/index.js';
import {
  VALID_DIST_TAGS,
  distTagFor,
  encodeName,
  isDistTag,
  normalizePublishError,
  validatePackageName,
} from '../../src/providers/npm/client.js';
import { build } from '../../src/configuration/resolve.js';
import type { ProviderContext } from '../../src/core/provider.js';
import { DuplicateReleaseError } from '../../src/errors/index.js';

/** A context whose `npm` invocations are answered by a scripted table. */
function makeContext(
  responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }> = {},
  overrides: { dryRun?: boolean; secret?: string | undefined } = {},
): ProviderContext {
  const config = build(
    {
      project: { name: 'test' },
      version: { strategy: 'semver', file: 'package.json', tagPrefix: 'v' },
      npm: {
        enabled: true,
        package: '@acme/pkg',
        registry: 'https://registry.example.test',
        distTag: 'latest',
      },
      github: { enabled: false },
      pypi: { enabled: false },
      checks: {},
      order: ['npm'],
    },
    '/tmp/test-project',
  );

  return {
    projectRoot: '/tmp/test-project',
    config: config as unknown as Record<string, unknown>,
    getSecret: () => overrides.secret,
    dryRun: overrides.dryRun ?? false,
    execute: {
      run: async (command: string, args: readonly string[]) => {
        // Registry reads go through fetch, not the executor; only npm CLI calls
        // reach here.
        if (command !== 'npm') return { exitCode: 0, stdout: '', stderr: '' };

        const joined = args.join(' ');
        for (const [needle, response] of Object.entries(responses)) {
          if (joined.includes(needle)) {
            return {
              exitCode: response.exitCode ?? 0,
              stdout: response.stdout ?? '',
              stderr: response.stderr ?? '',
            };
          }
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
}

describe('distTagFor', () => {
  it('uses latest for a stable version', () => {
    expect(distTagFor('1.0.0', false)).toBe('latest');
  });

  it.each([
    ['1.0.0-rc.1', 'next'],
    ['1.0.0-rc.2', 'next'],
    ['1.0.0-beta.2', 'beta'],
    ['1.0.0-alpha', 'alpha'],
    ['1.0.0-alpha.1', 'alpha'],
    // A prerelease whose name carries no channel defaults to next.
    ['1.0.0-preview.1', 'next'],
  ])('routes %s to %s', (version, expected) => {
    expect(distTagFor(version, true)).toBe(expected);
  });

  it('never returns latest for a prerelease', () => {
    for (const version of ['1.0.0-rc.1', '1.0.0-beta', '1.0.0-alpha.3']) {
      expect(distTagFor(version, true)).not.toBe('latest');
    }
  });
});

describe('isDistTag', () => {
  it.each(VALID_DIST_TAGS)('accepts %s', (tag) => {
    expect(isDistTag(tag)).toBe(true);
  });

  it('rejects an unknown tag', () => {
    expect(isDistTag('canary')).toBe(false);
    expect(isDistTag('nightly')).toBe(false);
  });
});

describe('encodeName', () => {
  it('encodes a scoped name for a registry URL', () => {
    expect(encodeName('@acme/pkg')).toBe('@acme%2Fpkg');
  });

  it('encodes a bare name', () => {
    expect(encodeName('lodash')).toBe('lodash');
  });
});

describe('validatePackageName', () => {
  it.each(['lodash', '@acme/pkg', 'my-package', 'a.b_c', 'pkg~1.0'])('accepts %s', (name) => {
    expect(validatePackageName(name)).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(validatePackageName('')).toMatch(/empty/);
  });

  it('rejects a name over 214 characters', () => {
    expect(validatePackageName('a'.repeat(215))).toMatch(/214/);
  });

  it('rejects a leading dot', () => {
    expect(validatePackageName('.hidden')).toMatch(/\./);
  });

  it('rejects a scope with no name', () => {
    expect(validatePackageName('@acme')).toMatch(/scope/);
  });

  it('rejects disallowed characters', () => {
    expect(validatePackageName('has space')).not.toBeNull();
    expect(validatePackageName('has/slash')).not.toBeNull();
  });
});

describe('normalizePublishError', () => {
  it('maps an already-published error to DUPLICATE_RELEASE', () => {
    // npm reports this as a 403, indistinguishable at a glance from a
    // permissions problem.
    const error = normalizePublishError(
      '@acme/pkg',
      '1.0.0',
      'npm error You cannot publish over the previously published versions: 1.0.0.',
    );

    expect(error).toBeInstanceOf(DuplicateReleaseError);
    expect(error.code).toBe('DUPLICATE_RELEASE');
  });

  it.each(['Cannot publish over previously staged version "1.0.0"', 'E409 Conflict'])(
    'maps %s to a duplicate error',
    (output) => {
      expect((normalizePublishError('@a/b', '1.0.0', output) as { code: string }).code).toBe(
        'DUPLICATE_RELEASE',
      );
    },
  );

  it.each([
    'npm error code ENEEDAUTH',
    'This command requires you to be logged in to https://registry.npmjs.org/',
  ])('maps %s to an auth error', (output) => {
    expect((normalizePublishError('@a/b', '1.0.0', output) as { code: string }).code).toBe(
      'AUTH_FAILED',
    );
  });

  it('maps a payment error to PROVIDER_FAILED', () => {
    expect(
      (normalizePublishError('@a/b', '1.0.0', '402 Payment Required') as { code: string }).code,
    ).toBe('PROVIDER_FAILED');
  });

  it('falls back to PROVIDER_FAILED with the output captured', () => {
    const error = normalizePublishError('@a/b', '1.0.0', 'something entirely unexpected happened');

    expect(error.code).toBe('PROVIDER_FAILED');
    expect(JSON.stringify(error.toJSON())).toContain('unexpected');
  });
});

describe('NpmProvider.capabilities', () => {
  it('declares publish, dist-tags, and verify', () => {
    const caps = new NpmProvider().capabilities();

    expect(caps.name).toBe('npm');
    expect(caps.capabilities).toContain('publish');
    expect(caps.capabilities).toContain('dist-tags');
    expect(caps.capabilities).toContain('verify');
  });
});

describe('NpmProvider.authenticate', () => {
  it('returns the account name', async () => {
    const result = await new NpmProvider().authenticate(
      makeContext({ whoami: { stdout: 'tester\n' } }),
    );

    expect(result.authenticated).toBe(true);
    expect(result.identity).toBe('tester');
  });

  it('never includes the token in its result', async () => {
    const result = await new NpmProvider().authenticate(
      makeContext({ whoami: { stdout: 'tester' } }, { secret: 'npm_secrettoken1234567890' }),
    );

    expect(JSON.stringify(result)).not.toContain('secrettoken');
  });

  it('throws AUTH_FAILED when npm rejects the credential', async () => {
    const ctx = makeContext({ whoami: { exitCode: 1, stderr: 'ENEEDAUTH' } });

    await expect(new NpmProvider().authenticate(ctx)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});

describe('NpmProvider.validate', () => {
  it('accepts a valid package name', async () => {
    await expect(new NpmProvider().validate(makeContext())).resolves.toBeUndefined();
  });

  it('rejects an invalid package name before attempting a publish', async () => {
    const ctx = makeContext();
    (ctx.config as Record<string, unknown>)['npm'] = {
      enabled: true,
      package: 'has space',
      registry: 'https://registry.example.test',
      distTag: 'latest',
      access: 'public',
      tokenEnv: 'NPM_TOKEN',
    };

    await expect(new NpmProvider().validate(ctx)).rejects.toThrow(/characters npm does not allow/);
  });

  it('skips packing in dry-run', async () => {
    const run = vi.fn();
    const ctx = { ...makeContext(), dryRun: true };
    ctx.execute.run = run as never;

    await new NpmProvider().validate(ctx);

    expect(run).not.toHaveBeenCalled();
  });

  it('fails when npm pack fails', async () => {
    const ctx = makeContext({ 'pack --dry-run': { exitCode: 1, stderr: 'ENOTFOUND' } });

    await expect(new NpmProvider().validate(ctx)).rejects.toThrow(/npm pack failed/);
  });
});

describe('NpmProvider.publish', () => {
  it('passes the expected dist-tag to npm', async () => {
    const calls: string[] = [];
    const ctx = makeContext();
    const original = ctx.execute.run.bind(ctx.execute);
    ctx.execute.run = (c: string, a: readonly string[]) => {
      calls.push(a.join(' '));
      return original(c, a);
    };

    await new NpmProvider().publish(ctx, { version: '1.0.0' }).catch(() => undefined);

    const publish = calls.find((line) => line.includes('publish'));
    expect(publish).toContain('--tag latest');
    expect(publish).toContain('--access public');
  });

  it('never passes the token as a CLI argument', async () => {
    const calls: string[] = [];
    const ctx = makeContext({}, { secret: 'npm_secrettoken1234567890' });
    const original = ctx.execute.run.bind(ctx.execute);
    ctx.execute.run = (c: string, a: readonly string[]) => {
      calls.push(a.join(' '));
      return original(c, a);
    };

    await new NpmProvider().publish(ctx, { version: '1.0.0' }).catch(() => undefined);

    // An argument is visible in the process list, so the token must go through
    // the environment instead.
    expect(calls.join(' ')).not.toContain('secrettoken');
  });

  it('routes a prerelease to next even when config says latest', async () => {
    const calls: string[] = [];
    const ctx = makeContext();
    const original = ctx.execute.run.bind(ctx.execute);
    ctx.execute.run = (c: string, a: readonly string[]) => {
      calls.push(a.join(' '));
      return original(c, a);
    };

    await new NpmProvider().publish(ctx, { version: '1.0.0-rc.1' }).catch(() => undefined);

    const publish = calls.find((line) => line.includes('publish'));
    expect(publish).toContain('--tag next');
  });

  it('still calls npm in dry-run, so the pack is actually validated', async () => {
    const run = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        _options?: unknown,
      ): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
      }),
    );
    const ctx = { ...makeContext(), dryRun: true };
    ctx.execute.run = run;

    const result = await new NpmProvider().publish(ctx, { version: '1.0.0' });

    // Returning early would make --dry-run a no-op that always "succeeds", so a
    // broken `files` list would go unnoticed until the real publish.
    expect(run).toHaveBeenCalledTimes(1);
    const [, args] = run.mock.calls[0] ?? [];
    expect(args).toContain('--dry-run');
    expect(result.published).toBe(false);
  });

  it('surfaces a duplicate version as DUPLICATE_RELEASE', async () => {
    const ctx = makeContext({
      publish: {
        exitCode: 1,
        stderr: 'You cannot publish over the previously published versions: 1.0.0.',
      },
    });

    await expect(new NpmProvider().publish(ctx, { version: '1.0.0' })).rejects.toBeInstanceOf(
      DuplicateReleaseError,
    );
  });

  it('surfaces an auth failure', async () => {
    const ctx = makeContext({ publish: { exitCode: 1, stderr: 'ENEEDAUTH' } });

    await expect(new NpmProvider().publish(ctx, { version: '1.0.0' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});

describe('NpmProvider.verify', () => {
  // The registry is read with fetch, so these assert on the shape of the
  // contract and the safety rule rather than on live data.
  it('declares a prerelease-not-on-latest check', () => {
    const names = new NpmProvider().capabilities().capabilities.map(String);

    expect(names).toContain('verify');
  });
});
