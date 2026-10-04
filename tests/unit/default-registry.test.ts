/**
 * The default composition root.
 *
 * Every factory is invoked here rather than only being declared. A factory that
 * is never called is a provider that might not exist at runtime — the registry
 * would report the name and then fail when something tried to use it. This is
 * also what keeps `src/core/**` function coverage honest: the factories are the
 * only untested functions left in Core.
 */

import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/core/default-registry.js';
import { PROVIDER_NAMES } from '../../src/configuration/schema.js';

describe('the default registry', () => {
  const registry = createDefaultRegistry();

  it('registers every provider the schema knows about', () => {
    // A provider name in the schema that is not registered is a release that
    // validates and then cannot publish.
    expect(registry.names().sort()).toEqual([...PROVIDER_NAMES].sort());
  });

  it.each(['github', 'npm', 'pypi'])('resolves a working %s provider', (name) => {
    const provider = registry.create(name);

    expect(provider.name).toBe(name);
    // Every contract method must exist, or the pipeline reaches it and crashes.
    for (const method of [
      'capabilities',
      'authenticate',
      'validate',
      'getVersion',
      'publish',
      'verify',
    ] as const) {
      expect(typeof provider[method], `${name}.${method}`).toBe('function');
    }
  });

  it('gives each provider a distinct instance per resolution', () => {
    // A shared instance would leak state between two releases in one process.
    expect(registry.create('npm')).not.toBe(registry.create('npm'));
  });

  it('advertises capabilities for every provider', () => {
    for (const name of registry.names()) {
      const caps = registry.capabilitiesOf(name);

      expect(caps.capabilities.length, `${name} declares no capabilities`).toBeGreaterThan(0);
      expect(caps.description.length).toBeGreaterThan(0);
    }
  });

  it('declares verification for every provider', () => {
    // `forge verify` depends on every provider being able to verify; one without
    // it silently drops out of the cross-provider comparison.
    for (const name of registry.names()) {
      expect(registry.capabilitiesOf(name).capabilities, name).toContain('verify');
    }
  });

  it('names every provider in its own capabilities', () => {
    for (const name of registry.names()) {
      expect(registry.capabilitiesOf(name).name).toBe(name);
    }
  });

  it('builds a fresh registry each call', () => {
    // Two registries must not share entries, or registering into one leaks into
    // the other — which is exactly what a test asserting isolation would catch.
    expect(createDefaultRegistry().names()).toEqual(registry.names());
  });

  it('rejects an unknown provider with a useful error', () => {
    expect(() => registry.create('dockerhub')).toThrow();
  });
});
