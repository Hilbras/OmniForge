/**
 * Release pipeline tests.
 *
 * The pipeline is the safety-critical component: a mandatory failure must stop
 * the run before anything is published, and a dry run must touch nothing. Both
 * are asserted here with fully fake providers and dependencies, so the properties
 * hold regardless of any real registry.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  runRelease,
  hasFailure,
  failedSteps,
  type PipelineDeps,
  type ReleaseResult,
} from '../../src/release/pipeline.js';
import { render, renderMarkdown, renderTerminal } from '../../src/release/report.js';
import { ProviderRegistry } from '../../src/core/registry.js';
import { Capability, type ProviderContext } from '../../src/core/provider.js';
import { build } from '../../src/configuration/resolve.js';
import { ForgeError, ErrorCode } from '../../src/errors/index.js';

const CTX = {} as ProviderContext;

interface FakeOptions {
  readonly failAuth?: boolean;
  readonly failValidate?: boolean;
  readonly failPublish?: boolean;
  readonly verifyOk?: boolean;
  readonly observedVersion?: string | null;
}

/** A provider that records calls, so halt behaviour is observable. */
function fakeProvider(name: string, options: FakeOptions = {}) {
  const calls: string[] = [];
  const published: string[] = [];

  return {
    calls,
    published,
    provider: {
      name,
      capabilities: () => ({
        name,
        description: 'test double',
        capabilities: [Capability.Publish, Capability.Verify],
        versionSources: [],
      }),
      authenticate: async () => {
        calls.push('authenticate');
        if (options.failAuth === true) {
          throw new ForgeError(ErrorCode.AUTH_FAILED, `${name} auth failed`);
        }
        return { authenticated: true, identity: 'tester' };
      },
      validate: async () => {
        calls.push('validate');
        if (options.failValidate === true) {
          throw new ForgeError(ErrorCode.PROVIDER_FAILED, `${name} validate failed`);
        }
      },
      getVersion: async () => ({
        provider: name,
        version: options.observedVersion ?? '1.0.0',
        reference: `test://${name}`,
      }),
      publish: async (ctx: ProviderContext, input: { version: string }) => {
        calls.push('publish');
        // Honour the contract every real provider implements: a dry run reports
        // what it would do and mutates nothing.
        if (ctx.dryRun === true) {
          return { published: false, reference: `dry-run://${name}`, version: input.version };
        }
        if (options.failPublish === true) {
          throw new ForgeError(ErrorCode.PROVIDER_FAILED, `${name} publish failed`);
        }
        published.push(input.version);
        return {
          published: true,
          reference: `test://${name}/${input.version}`,
          version: input.version,
        };
      },
      verify: async (_ctx: ProviderContext, version: string) => {
        calls.push('verify');
        const observed = options.observedVersion === undefined ? version : options.observedVersion;
        return {
          provider: name,
          verified: options.verifyOk !== false && observed === version,
          observed: { provider: name, version: observed, reference: `test://${name}` },
          checks: [],
        };
      },
    },
  };
}

/** A registry populated with fakes. */
function registryWith(entries: { name: string; options?: FakeOptions }[]) {
  const registry = new ProviderRegistry();
  for (const entry of entries) {
    registry.register(entry.name, () => fakeProvider(entry.name, entry.options).provider, {
      description: 'test',
      capabilities: ['publish', 'verify'],
      versionSources: [],
    });
  }
  return registry;
}

/** Config with providers enabled. */
function configWith(names: string[]) {
  return build(
    {
      project: { name: 'acme' },
      version: { strategy: 'semver', file: 'package.json', tagPrefix: 'v' },
      github: { enabled: names.includes('github'), repository: 'A/b' },
      npm: { enabled: names.includes('npm'), package: '@a/b' },
      pypi: { enabled: names.includes('pypi'), package: 'b' },
      checks: {},
      order: names,
    },
    '/tmp/acme',
  );
}

/**
 * Dependencies with every side effect observable.
 *
 * Tests that need to assert on a write or a tag pass their own recorder through
 * `overrides`, rather than this returning hidden state.
 */
function depsFor(
  registry: ProviderRegistry,
  overrides: Partial<PipelineDeps> = {},
  providers: string[] = ['github'],
): PipelineDeps {
  return {
    registry,
    // The context must reflect the request, or a provider cannot honour
    // `dryRun` and every dry run behaves like a real one.
    contextFor: (dryRun: boolean) => Promise.resolve({ ...CTX, dryRun }),
    currentVersion: () => Promise.resolve('1.0.0'),
    writeVersion: () => Promise.resolve(),
    computeNext: (bumps) => Promise.resolve(bumps.includes('major') ? '2.0.0' : '1.0.1'),
    createTag: () => Promise.resolve(),
    runChecks: () => Promise.resolve(),
    providersFor: () => providers,
    isPrerelease: (version) => version.includes('-'),
    confirm: () => Promise.resolve(true),
    ...overrides,
  };
}

const REQUEST = { bumps: [], dryRun: false, yes: true } as const;

describe('runRelease — happy path', () => {
  it('runs every step in order', async () => {
    const result = await runRelease(
      configWith(['github']),
      REQUEST,
      depsFor(registryWith([{ name: 'github' }])),
    );

    const steps = result.steps.map((s) => s.step);
    expect(steps).toContain('configure');
    expect(steps).toContain('authenticate');
    expect(steps).toContain('validate');
    expect(steps).toContain('tag');
    expect(steps).toContain('publish');
  });

  it('reports success', async () => {
    const result = await runRelease(
      configWith(['github']),
      REQUEST,
      depsFor(registryWith([{ name: 'github' }])),
    );

    expect(result.outcome).toBe('success');
    expect(hasFailure(result)).toBe(false);
  });

  it('verifies after publishing', async () => {
    const fake = fakeProvider('github');
    const registry = new ProviderRegistry().register('github', () => fake.provider, {
      description: 'test',
      capabilities: ['publish', 'verify'],
      versionSources: [],
    });

    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    // Verify must come last, or the report would describe a state that never was.
    const publishIndex = result.steps.findIndex((s) => s.step === 'publish');
    const verifyIndex = fake.calls.indexOf('verify');
    expect(verifyIndex).toBeGreaterThan(fake.calls.indexOf('publish'));
    expect(publishIndex).toBeGreaterThanOrEqual(0);
  });

  it('publishes to every enabled provider', async () => {
    const github = fakeProvider('github');
    const npmPkg = fakeProvider('npm');

    const registry = new ProviderRegistry()
      .register('github', () => github.provider, {
        description: 'test',
        capabilities: ['publish', 'verify'],
        versionSources: [],
      })
      .register('npm', () => npmPkg.provider, {
        description: 'test',
        capabilities: ['publish', 'verify'],
        versionSources: [],
      });

    await runRelease(
      configWith(['github', 'npm']),
      REQUEST,
      depsFor(registry, {}, ['github', 'npm']),
    );

    expect(github.published).toEqual(['1.0.0']);
    expect(npmPkg.published).toEqual(['1.0.0']);
  });

  it('computes the next version from the bump strategy', async () => {
    const result = await runRelease(
      configWith(['github']),
      { bumps: ['minor'], dryRun: false, yes: true },
      depsFor(registryWith([{ name: 'github' }])),
    );

    expect(result.version).toBe('1.0.1');
    expect(result.previousVersion).toBe('1.0.0');
    expect(result.tag).toBe('v1.0.1');
  });

  it('uses an explicit version when given', async () => {
    const result = await runRelease(
      configWith(['github']),
      { bumps: ['minor'], version: '9.9.9', dryRun: false, yes: true },
      depsFor(registryWith([{ name: 'github' }])),
    );

    expect(result.version).toBe('9.9.9');
  });
});

describe('runRelease — the mandatory halt', () => {
  it('stops after a failed check and publishes nothing', async () => {
    // The single most important property: a failed test must never be followed
    // by a publish.
    const fake = fakeProvider('github');
    const registry = new ProviderRegistry().register('github', () => fake.provider, {
      description: 'test',
      capabilities: ['publish', 'verify'],
      versionSources: [],
    });

    const tagged: string[] = [];
    const result = await runRelease(
      build(
        {
          project: { name: 'acme' },
          version: { strategy: 'semver', file: 'package.json', tagPrefix: 'v' },
          github: { enabled: true, repository: 'A/b' },
          checks: { test: { command: ['false'] } },
          order: ['github'],
        },
        '/tmp/acme',
      ),
      REQUEST,
      depsFor(registry, {
        runChecks: async () => {
          throw new ForgeError(ErrorCode.CHECK_FAILED, 'Check "test" failed');
        },
        createTag: async (tag) => {
          tagged.push(tag);
        },
      }),
    );

    expect(result.outcome).toBe('failed');
    expect(fake.calls).not.toContain('publish');
    expect(tagged).toEqual([]);
  });

  it('stops after a failed authenticate', async () => {
    const registry = registryWith([{ name: 'github', options: { failAuth: true } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    expect(result.outcome).toBe('failed');
    expect(result.steps.find((s) => s.step === 'authenticate')?.status).toBe('failed');
  });

  it('stops after a failed validate', async () => {
    const registry = registryWith([{ name: 'github', options: { failValidate: true } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    expect(result.outcome).toBe('failed');
    expect(result.steps.find((s) => s.step === 'validate')?.status).toBe('failed');
  });

  it('stops after a failed publish and skips the rest', async () => {
    const registry = registryWith([
      { name: 'github', options: { failPublish: true } },
      { name: 'npm' },
    ]);

    const result = await runRelease(
      configWith(['github', 'npm']),
      REQUEST,
      depsFor(registry, {}, ['github', 'npm']),
    );

    expect(result.outcome).toBe('failed');
    const npmStep = result.steps.find((s) => s.step === 'publish' && s.provider === 'npm');
    expect(npmStep?.status).toBe('skipped');
  });

  it('records skipped steps rather than dropping them', async () => {
    // The report must show the whole plan, so a user can see what did not run.
    const registry = registryWith([{ name: 'github', options: { failAuth: true } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    const skipped = result.steps.filter((s) => s.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((s) => s.step === 'publish')).toBe(true);
  });

  it('names the failing step in failedSteps()', async () => {
    const registry = registryWith([{ name: 'github', options: { failPublish: true } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    expect(failedSteps(result).some((s) => s.step === 'publish')).toBe(true);
  });

  it('records the error code on a failed step', async () => {
    const registry = registryWith([{ name: 'github', options: { failValidate: true } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    expect(result.steps.find((s) => s.step === 'validate')?.error?.code).toBe('PROVIDER_FAILED');
  });
});

describe('runRelease — dry run', () => {
  it('makes no external changes', async () => {
    const fake = fakeProvider('github');
    const registry = new ProviderRegistry().register('github', () => fake.provider, {
      description: 'test',
      capabilities: ['publish', 'verify'],
      versionSources: [],
    });

    // Recorders that would fail loudly if the pipeline called them. The guard is
    // inside the pipeline, so the defaults here must not be bypassed.
    let writeCalled = false;
    let tagCalled = false;

    const result = await runRelease(
      configWith(['github']),
      { bumps: ['patch'], dryRun: true, yes: true },
      depsFor(registry, {
        writeVersion: () => {
          writeCalled = true;
          return Promise.resolve();
        },
        createTag: () => {
          tagCalled = true;
          return Promise.resolve();
        },
      }),
    );

    expect(result.outcome).toBe('dry-run');
    expect(writeCalled).toBe(false);
    expect(tagCalled).toBe(false);
    // The provider IS called — that is how a dry run validates the pack — but
    // it reports published=false and mutates nothing.
    expect(fake.published).toEqual([]);
    expect(result.steps.find((s) => s.step === 'publish')?.status).toBe('passed');
  });

  it('still reports what it would do', async () => {
    const registry = registryWith([{ name: 'github' }]);
    const result = await runRelease(
      configWith(['github']),
      { bumps: ['patch'], dryRun: true, yes: true },
      depsFor(registry),
    );

    // A dry run must be informative: the user reads this to decide whether the
    // real release is safe.
    const byStep = new Map(result.steps.map((s) => [s.step, s.detail]));
    expect(byStep.get('write-version')).toBe('would write 1.0.1');
    expect(byStep.get('tag')).toBe('would create v1.0.1');
    expect(byStep.get('publish')).toContain('would publish');
  });

  it('skips verification, since nothing was published', async () => {
    const fake = fakeProvider('github');
    const registry = new ProviderRegistry().register('github', () => fake.provider, {
      description: 'test',
      capabilities: ['publish', 'verify'],
      versionSources: [],
    });

    const result = await runRelease(
      configWith(['github']),
      { bumps: [], dryRun: true, yes: true },
      depsFor(registry),
    );

    // Verifying a dry run would query a registry for a version that was never
    // published, producing a spurious failure.
    expect(fake.calls).not.toContain('verify');
    expect(result.integrity).toBeUndefined();
  });
});

describe('runRelease — integrity', () => {
  it('reports a version mismatch as a failure', async () => {
    const registry = registryWith([{ name: 'github', options: { observedVersion: '9.9.9' } }]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    expect(result.outcome).toBe('failed');
    expect(result.integrity?.passed).toBe(false);
    expect(result.integrity?.mismatches.length).toBeGreaterThan(0);
  });

  it('ignores a tag prefix when comparing', async () => {
    // A GitHub release reports `v1.0.0` while package.json says `1.0.0`; that
    // is agreement, not a mismatch. The pipeline owns the stripped comparison —
    // a provider comparing raw strings would otherwise report a false mismatch.
    const registry = registryWith([
      { name: 'github', options: { observedVersion: 'v1.0.0', verifyOk: true } },
    ]);
    const result = await runRelease(configWith(['github']), REQUEST, depsFor(registry));

    const mismatches = result.integrity?.mismatches ?? [];
    // The only mismatch allowed is the provider's own failed verdict, never a
    // "reports v1.0.0, expected 1.0.0" version complaint.
    expect(mismatches.some((m) => m.includes('expected 1.0.0'))).toBe(false);
  });

  it('records every provider observation', async () => {
    const registry = registryWith([{ name: 'github' }, { name: 'npm' }]);
    const result = await runRelease(
      configWith(['github', 'npm']),
      REQUEST,
      depsFor(registry, {}, ['github', 'npm']),
    );

    expect(result.integrity?.observed).toHaveLength(2);
  });
});

describe('runRelease — configuration', () => {
  it('fails when no provider is enabled', async () => {
    const result = await runRelease(
      configWith([]),
      REQUEST,
      depsFor(registryWith([]), { providersFor: () => [] }),
    );

    expect(result.outcome).toBe('failed');
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('names the real version even when configure fails', async () => {
    // A placeholder `0.0.0` would tell the user nothing about which release failed.
    const result = await runRelease(
      configWith([]),
      REQUEST,
      depsFor(registryWith([]), { providersFor: () => [] }),
    );

    expect(result.version).toBe('1.0.0');
  });
});

describe('reporting', () => {
  const sample = (): ReleaseResult => ({
    project: 'acme',
    version: '1.2.0',
    previousVersion: '1.1.0',
    tag: 'v1.2.0',
    dryRun: false,
    outcome: 'success',
    steps: [
      { step: 'configure', status: 'passed', detail: 'ok', durationMs: 1, mandatory: true },
      {
        step: 'publish',
        provider: 'npm',
        status: 'passed',
        detail: 'published',
        durationMs: 2,
        mandatory: true,
      },
    ],
    integrity: {
      passed: true,
      expected: '1.2.0',
      observed: [{ provider: 'npm', version: '1.2.0' }],
      mismatches: [],
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    totalDurationMs: 1500,
  });

  it('renders terminal output', () => {
    const text = renderTerminal(sample());

    expect(text).toContain('acme v1.2.0');
    expect(text).toContain('SUCCESS');
    expect(text).toContain('Release integrity: OK');
  });

  it('renders valid JSON', () => {
    const parsed = JSON.parse(render(sample(), 'json')) as { version: string };

    expect(parsed.version).toBe('1.2.0');
  });

  it('renders markdown with a table', () => {
    const text = renderMarkdown(sample());

    expect(text).toContain('# acme v1.2.0');
    expect(text).toContain('| Step | Provider | Result | Detail |');
    expect(text).toContain('## Release integrity');
  });

  it('escapes pipes so a table cannot break', () => {
    const broken = {
      ...sample(),
      steps: [
        { step: 'x', status: 'passed' as const, detail: 'a|b', durationMs: 0, mandatory: true },
      ],
    };

    expect(renderMarkdown(broken)).toContain('a\\|b');
  });

  it('redacts a secret that reached a step detail', () => {
    const leaky = {
      ...sample(),
      steps: [
        {
          step: 'publish',
          status: 'failed' as const,
          detail: 'failed with token npm_supersecret1234567890',
          durationMs: 0,
          mandatory: true,
        },
      ],
    };

    // No renderer may emit a credential, whatever reached it.
    for (const format of ['terminal', 'json', 'markdown'] as const) {
      const text = render(leaky, format, ['npm_supersecret1234567890']);
      expect(text).not.toContain('supersecret');
    }
  });
});

describe('deps contract', () => {
  it('calls onStep for each recorded step', async () => {
    const onStep = vi.fn();
    const registry = registryWith([{ name: 'github' }]);

    await runRelease(configWith(['github']), REQUEST, depsFor(registry, { onStep }));

    expect(onStep).toHaveBeenCalled();
  });

  it('passes the dry-run flag through to the context', async () => {
    const contextFor = vi.fn(async () => CTX);
    const registry = registryWith([{ name: 'github' }]);

    await runRelease(
      configWith(['github']),
      { bumps: [], dryRun: true, yes: true },
      depsFor(registry, { contextFor }),
    );

    expect(contextFor).toHaveBeenCalledWith(true);
  });
});
