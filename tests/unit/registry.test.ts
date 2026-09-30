import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/core/registry.js';
import { Capability, type ProviderContext } from '../../src/core/provider.js';
import { ProviderError } from '../../src/errors/index.js';
import { FakeProvider } from '../fixtures/fake-provider.js';

const CTX = {} as ProviderContext;

describe('ProviderRegistry', () => {
  describe('registration', () => {
    it('registers a provider and finds it by name', () => {
      const registry = new ProviderRegistry();
      registry.registerInstance(new FakeProvider({ name: 'alpha' }));

      expect(registry.has('alpha')).toBe(true);
      expect(registry.names()).toEqual(['alpha']);
    });

    it('normalizes case and surrounding whitespace', () => {
      const registry = new ProviderRegistry();
      registry.registerInstance(new FakeProvider({ name: 'npm' }));

      expect(registry.has('  NPM ')).toBe(true);
      expect(registry.has('Npm')).toBe(true);
    });

    it('rejects an empty name', () => {
      const registry = new ProviderRegistry();
      expect(() =>
        registry.register('   ', () => new FakeProvider(), {
          description: 'x',
          capabilities: [],
          versionSources: [],
        }),
      ).toThrow(/must not be empty/i);
    });

    it('rejects a duplicate registration', () => {
      const registry = new ProviderRegistry().registerInstance(new FakeProvider({ name: 'npm' }));

      expect(() => registry.registerInstance(new FakeProvider({ name: 'npm' }))).toThrow(
        ProviderError,
      );
    });

    it('is chainable', () => {
      const registry = new ProviderRegistry();
      const result = registry
        .registerInstance(new FakeProvider({ name: 'a' }))
        .registerInstance(new FakeProvider({ name: 'b' }));

      expect(result).toBe(registry);
      expect(registry.names()).toEqual(['a', 'b']);
    });
  });

  describe('unknown providers', () => {
    it('throws PROVIDER_NOT_FOUND naming the known providers', () => {
      const registry = new ProviderRegistry().registerInstance(new FakeProvider({ name: 'npm' }));

      expect(() => registry.create('pypi')).toThrow(/Unknown provider "pypi"/);
      try {
        registry.create('pypi');
      } catch (error) {
        expect((error as ProviderError).code).toBe('PROVIDER_NOT_FOUND');
        expect((error as ProviderError).remediation).toContain('npm');
      }
    });

    it('says "none registered" when the registry is empty', () => {
      const registry = new ProviderRegistry();
      // The remediation, not the message, is where the empty case is explained.
      try {
        registry.create('npm');
        expect.unreachable('create() should have thrown');
      } catch (error) {
        expect((error as ProviderError).remediation).toBe('Known providers: none registered.');
      }
    });
  });

  describe('create', () => {
    it('returns a working instance', () => {
      const registry = new ProviderRegistry().registerInstance(new FakeProvider({ name: 'fake' }));
      const provider = registry.create('fake');

      expect(provider.name).toBe('fake');
      expect(provider.capabilities().capabilities).toContain(Capability.Publish);
    });

    it('calls the factory on each creation, not once at registration', () => {
      let built = 0;
      const registry = new ProviderRegistry().register(
        'counted',
        () => {
          built += 1;
          return new FakeProvider({ name: 'counted' });
        },
        { description: 'x', capabilities: [Capability.Publish], versionSources: [] },
      );

      expect(built).toBe(0);
      registry.create('counted');
      registry.create('counted');
      expect(built).toBe(2);
    });

    it('rejects a provider missing a method its capabilities require', () => {
      const broken = {
        name: 'broken',
        capabilities: () => ({
          name: 'broken',
          description: 'claims publish, implements nothing',
          capabilities: [Capability.Publish],
          versionSources: [],
        }),
      } as never;

      const registry = new ProviderRegistry().register('broken', () => broken, {
        description: 'x',
        capabilities: [Capability.Publish],
        versionSources: [],
      });

      expect(() => registry.create('broken')).toThrow(/does not implement every method/i);
    });
  });

  describe('capabilities', () => {
    it('reads capabilities without constructing the provider', () => {
      let built = 0;
      const registry = new ProviderRegistry().register(
        'lazy',
        () => {
          built += 1;
          return new FakeProvider({ name: 'lazy' });
        },
        {
          description: 'never constructed',
          capabilities: [Capability.Package, Capability.Verify],
          versionSources: ['package.json'],
        },
      );

      expect(registry.capabilitiesOf('lazy').description).toBe('never constructed');
      expect(registry.listCapabilities()).toHaveLength(1);
      expect(built).toBe(0);
    });

    it('lists every provider sorted by name', () => {
      const registry = new ProviderRegistry()
        .registerInstance(new FakeProvider({ name: 'zeta' }))
        .registerInstance(new FakeProvider({ name: 'alpha' }));

      expect(registry.listCapabilities().map((c) => c.name)).toEqual(['alpha', 'zeta']);
    });

    it('returns an empty list for an empty registry', () => {
      expect(new ProviderRegistry().listCapabilities()).toEqual([]);
      expect(new ProviderRegistry().names()).toEqual([]);
    });
  });

  describe('assertCapability', () => {
    it('passes for a supported capability', () => {
      const registry = new ProviderRegistry().registerInstance(new FakeProvider());
      expect(() => registry.assertCapability('fake', Capability.Publish)).not.toThrow();
    });

    it('throws PROVIDER_UNSUPPORTED listing what is supported', () => {
      const registry = new ProviderRegistry().registerInstance(new FakeProvider());

      expect(() => registry.assertCapability('fake', Capability.Releases)).toThrow(
        /does not support "releases"/,
      );
      try {
        registry.assertCapability('fake', Capability.Releases);
      } catch (error) {
        expect((error as ProviderError).code).toBe('PROVIDER_UNSUPPORTED');
        expect((error as ProviderError).remediation).toContain('dist-tags');
      }
    });
  });

  describe('lifecycle with an unknown platform', () => {
    it('runs load, authenticate, validate, publish, verify for any provider', async () => {
      const provider = new FakeProvider({ name: 'dockerhub' });
      const registry = new ProviderRegistry().registerInstance(provider);

      const resolved = registry.create('dockerhub');
      const auth = await resolved.authenticate(CTX);
      await resolved.validate(CTX);
      const before = await resolved.getVersion(CTX);
      const result = await resolved.publish(CTX, { version: '2.0.0' });
      const verification = await resolved.verify(CTX, '2.0.0');

      expect(auth.authenticated).toBe(true);
      expect(before.version).toBe('1.0.0');
      expect(result.published).toBe(true);
      expect(verification.verified).toBe(true);
      expect(provider.calls).toEqual([
        'authenticate',
        'validate',
        'getVersion',
        'publish',
        'verify',
      ]);
    });

    it('reports published=false without mutating state under dryRun', async () => {
      const provider = new FakeProvider({ name: 'dry' });
      const ctx = { ...CTX, dryRun: true } as ProviderContext;

      const result = await provider.publish(ctx, { version: '9.9.9' });

      expect(result.published).toBe(false);
      expect(result.reference).toMatch(/^dry-run:/);
      expect(provider.published).toHaveLength(0);
      expect((await provider.getVersion(ctx)).version).toBe('1.0.0');
    });

    it('surfaces verification failure as verified=false, not a throw', async () => {
      const provider = new FakeProvider({ currentVersion: '1.0.0' });
      const verification = await provider.verify(CTX, '2.0.0');

      expect(verification.verified).toBe(false);
      expect(verification.checks.find((c) => c.name === 'version-matches')?.passed).toBe(false);
    });

    it('propagates provider publish failures to the caller', async () => {
      const provider = new FakeProvider({ failPublish: new Error('403 already exists') });
      await expect(provider.publish(CTX, { version: '1.0.0' })).rejects.toThrow(
        '403 already exists',
      );
    });
  });
});
