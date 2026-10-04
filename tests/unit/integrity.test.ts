/**
 * Verification and integrity tests.
 *
 * The property under test: a release is only intact when every participating
 * provider reports the same version AND its own release exists. Each provider is
 * individually correct in a partial-release scenario, so only a cross-provider
 * comparison can catch it.
 */

import { describe, expect, it } from 'vitest';

import {
  assertIntegrity,
  stripPrefix,
  summarize,
  table,
  verifyRelease,
  type IntegrityReport,
} from '../../src/verification/integrity.js';
import { ProviderRegistry } from '../../src/core/registry.js';
import { Capability, type ProviderContext } from '../../src/core/provider.js';
import { build } from '../../src/configuration/resolve.js';
import { VerificationError } from '../../src/errors/index.js';

const CTX = {} as ProviderContext;

/** A provider reporting a fixed version and verification outcome. */
function providerReporting(name: string, version: string | null, verified = true) {
  return {
    name,
    capabilities: () => ({
      name,
      description: 'test double',
      capabilities: [Capability.Verify],
      versionSources: [],
    }),
    authenticate: async () => ({ authenticated: true }),
    validate: async () => undefined,
    getVersion: async () => ({ provider: name, version, reference: `test://${name}` }),
    publish: async () => ({ published: true, reference: '', version: version ?? '0.0.0' }),
    verify: async () => ({
      provider: name,
      verified,
      observed: { provider: name, version, reference: `test://${name}` },
      checks: [
        { name: 'exists', passed: version !== null, detail: version ?? 'no version' },
        { name: 'matches', passed: verified, detail: verified ? 'ok' : 'version differs' },
      ],
    }),
  };
}

/** A provider whose verify throws, simulating an unreachable registry. */
function failingProvider(name: string) {
  return {
    name,
    capabilities: () => ({
      name,
      description: 'unreachable',
      capabilities: [Capability.Verify],
      versionSources: [],
    }),
    authenticate: async () => ({ authenticated: true }),
    validate: async () => undefined,
    getVersion: async () => ({ provider: name, version: null, reference: '' }),
    publish: async () => ({ published: false, reference: '', version: '' }),
    verify: async () => {
      throw new Error('registry unreachable');
    },
  };
}

function registryOf(
  ...entries: { name: string; provider: ReturnType<typeof providerReporting> }[]
) {
  const registry = new ProviderRegistry();
  for (const entry of entries) {
    registry.register(entry.name, () => entry.provider, {
      description: 'test',
      capabilities: ['verify'],
      versionSources: [],
    });
  }
  return registry;
}

function configOf(tagPrefix = 'v') {
  return build(
    {
      project: { name: 'acme' },
      version: { strategy: 'semver', file: 'package.json', tagPrefix },
      github: { enabled: true, repository: 'A/b' },
      npm: { enabled: true, package: '@a/b' },
      pypi: { enabled: false },
      checks: {},
      order: ['github', 'npm'],
    },
    '/tmp/acme',
  );
}

const deps = (registry: ProviderRegistry, version: string, only?: readonly string[]) => ({
  registry,
  version,
  only,
  contextFor: () => CTX,
  providersFor: () => only ?? ['github', 'npm'],
});

describe('verifyRelease', () => {
  it('passes when every provider agrees', async () => {
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', '1.5.0') },
      { name: 'npm', provider: providerReporting('npm', '1.5.0') },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.entries).toHaveLength(2);
  });

  it('accepts a tag form from one provider and a bare version from another', async () => {
    // GitHub reports `v1.5.0` while npm reports `1.5.0`. That is agreement, and
    // treating it as a mismatch would break the check for the most likely shape.
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', 'v1.5.0') },
      { name: 'npm', provider: providerReporting('npm', '1.5.0') },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(true);
  });

  it('detects a cross-provider mismatch', async () => {
    // The partial release: GitHub shipped, npm did not.
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', '1.5.0') },
      { name: 'npm', provider: providerReporting('npm', '1.4.0') },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(false);
    expect(report.problems.some((p) => p.includes('npm reports 1.4.0'))).toBe(true);
  });

  it('detects a provider reporting nothing', async () => {
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', '1.5.0') },
      { name: 'npm', provider: providerReporting('npm', null) },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(false);
    expect(report.problems.some((p) => p.includes('npm reported no version'))).toBe(true);
  });

  it('records an unreachable provider without hiding the others', async () => {
    // One registry being down must not prevent reporting a real mismatch.
    const registry = registryOf(
      { name: 'github', provider: failingProvider('github') },
      { name: 'npm', provider: providerReporting('npm', '1.4.0') },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(false);
    expect(report.unreachable).toContain('github');
    // The npm mismatch is still found.
    expect(report.problems.some((p) => p.includes('npm reports 1.4.0'))).toBe(true);
  });

  it('surfaces a failed provider check', async () => {
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', '1.5.0', false) },
      { name: 'npm', provider: providerReporting('npm', '1.5.0') },
    );

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0'));

    expect(report.passed).toBe(false);
    expect(report.problems.some((p) => p.includes('matches failed'))).toBe(true);
  });

  it('keeps per-check detail for the failing provider', async () => {
    const registry = registryOf({
      name: 'npm',
      provider: providerReporting('npm', '1.5.0', false),
    });

    const report = await verifyRelease(configOf(), deps(registry, '1.5.0', ['npm']));

    const entry = report.entries.find((e) => e.provider === 'npm');
    expect(entry?.checks.some((c) => c.name === 'matches' && !c.passed)).toBe(true);
  });

  it('handles a custom tag prefix', async () => {
    const registry = registryOf(
      { name: 'github', provider: providerReporting('github', 'rel-1.5.0') },
      { name: 'npm', provider: providerReporting('npm', '1.5.0') },
    );

    const report = await verifyRelease(configOf('rel-'), deps(registry, '1.5.0'));

    expect(report.passed).toBe(true);
  });

  it('returns an empty report when no providers take part', async () => {
    const report = await verifyRelease(configOf(), deps(new ProviderRegistry(), '1.5.0', []));

    expect(report.entries).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe('assertIntegrity', () => {
  it('does nothing when the report passed', () => {
    const report: IntegrityReport = {
      passed: true,
      expected: '1.0.0',
      entries: [],
      problems: [],
      unreachable: [],
    };

    expect(() => assertIntegrity(report)).not.toThrow();
  });

  it('throws INTEGRITY_FAILED with the problems listed', () => {
    const report: IntegrityReport = {
      passed: false,
      expected: '1.0.0',
      entries: [],
      problems: ['npm reports 0.9.0, expected 1.0.0'],
      unreachable: ['github'],
    };

    try {
      assertIntegrity(report, 'release.verify');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationError);
      const integrity = error as VerificationError;
      expect(integrity.code).toBe('INTEGRITY_FAILED');
      expect(integrity.operation).toBe('release.verify');
      expect(JSON.stringify(integrity.detail)).toContain('0.9.0');
    }
  });

  it('suggests a recovery, not just a failure', () => {
    const report: IntegrityReport = {
      passed: false,
      expected: '1.0.0',
      entries: [],
      problems: ['npm reports 0.9.0'],
      unreachable: [],
    };

    try {
      assertIntegrity(report);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as VerificationError).remediation).toBeTruthy();
    }
  });
});

describe('stripPrefix', () => {
  it('removes a configured prefix', () => {
    expect(stripPrefix('v1.2.3', 'v')).toBe('1.2.3');
    expect(stripPrefix('rel-1.2.3', 'rel-')).toBe('1.2.3');
  });

  it('removes a bare v with a different configured prefix', () => {
    expect(stripPrefix('v1.2.3', 'rel-')).toBe('1.2.3');
  });

  it('leaves a bare version alone', () => {
    expect(stripPrefix('1.2.3', 'v')).toBe('1.2.3');
  });
});

describe('presentation', () => {
  const report = (): IntegrityReport => ({
    passed: true,
    expected: '1.5.0',
    entries: [
      { provider: 'github', observed: 'v1.5.0', verified: true, checks: [] },
      { provider: 'npm', observed: '1.5.0', verified: true, checks: [] },
    ],
    problems: [],
    unreachable: [],
  });

  it('summarizes a passing report', () => {
    expect(summarize(report())).toContain('verified across 2 provider(s)');
  });

  it('counts problems in a failing report', () => {
    expect(summarize({ ...report(), passed: false, problems: ['a', 'b'] })).toContain(
      '2 problem(s)',
    );
  });

  it('renders a table', () => {
    const rows = table(report());

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['github', 'v1.5.0', 'ok']);
  });

  it('shows a dash for a provider that reported nothing', () => {
    const rows = table({
      ...report(),
      entries: [{ provider: 'pypi', observed: null, verified: false, checks: [] }],
    });

    expect(rows[0]?.[1]).toBe('—');
  });
});
