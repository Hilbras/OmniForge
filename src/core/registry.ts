/**
 * The provider registry.
 *
 * Maps provider names to factories. The release engine resolves providers
 * through this registry and never imports a concrete provider, which is what
 * keeps platform logic out of the Core.
 */

import { Capability, type Provider, type ProviderCapabilities } from './provider.js';
import { ErrorCode, ProviderError } from '../errors/index.js';

/** Creates a provider instance. Factories keep construction lazy and testable. */
export type ProviderFactory = () => Provider;

interface RegistryEntry {
  readonly factory: ProviderFactory;
  /** Capabilities declared up front, avoiding instance construction for `list`. */
  readonly declared: Pick<ProviderCapabilities, 'description' | 'capabilities' | 'versionSources'>;
  /** Method each advertised capability maps to, verified on register. */
  readonly requires?: readonly string[];
}

/**
 * Methods a provider must implement to advertise a capability.
 *
 * Enforced at registration so a provider cannot claim `publish` and then
 * silently do nothing when the release engine calls it.
 */
const CAPABILITY_METHODS: Readonly<Record<string, string>> = {
  [Capability.Repository]: 'validate',
  [Capability.Tags]: 'publish',
  [Capability.Releases]: 'publish',
  [Capability.Assets]: 'publish',
  [Capability.Package]: 'getVersion',
  [Capability.Publish]: 'publish',
  [Capability.DistTags]: 'publish',
  [Capability.Upload]: 'publish',
  [Capability.Verify]: 'verify',
};

/** Holds registered provider factories and instantiates them on demand. */
export class ProviderRegistry {
  readonly #entries = new Map<string, RegistryEntry>();

  /**
   * Register a provider factory.
   *
   * @param name - Key used in `forge.config.yaml`, e.g. `npm`.
   * @param factory - Builds the provider. Called once per resolution.
   * @param declared - Capabilities advertised by this provider.
   */
  register(
    name: string,
    factory: ProviderFactory,
    declared: Pick<ProviderCapabilities, 'description' | 'capabilities' | 'versionSources'>,
  ): this {
    const key = name.trim().toLowerCase();
    if (key.length === 0) {
      throw new ProviderError(ErrorCode.PROVIDER_FAILED, 'Provider name must not be empty.');
    }
    if (this.#entries.has(key)) {
      throw new ProviderError(
        ErrorCode.PROVIDER_FAILED,
        `Provider "${key}" is already registered.`,
        { remediation: 'Rename one of the providers, or remove the duplicate registration.' },
      );
    }
    this.#entries.set(key, { factory, declared, requires: [...declared.capabilities] });
    return this;
  }

  /** Register a provider instance directly. Useful in tests. */
  registerInstance(provider: Provider): this {
    const caps = provider.capabilities();
    return this.register(provider.name, () => provider, {
      description: caps.description,
      capabilities: caps.capabilities,
      versionSources: caps.versionSources,
    });
  }

  /** True when a provider with this name is registered. */
  has(name: string): boolean {
    return this.#entries.has(name.trim().toLowerCase());
  }

  /** Every registered provider name, sorted. */
  names(): string[] {
    return [...this.#entries.keys()].sort();
  }

  /** Capabilities of a provider without constructing it. */
  capabilitiesOf(name: string): ProviderCapabilities {
    const entry = this.#lookup(name);
    return {
      name,
      description: entry.declared.description,
      capabilities: entry.declared.capabilities,
      versionSources: entry.declared.versionSources,
    };
  }

  /** Capabilities of every provider, sorted by name. */
  listCapabilities(): ProviderCapabilities[] {
    return this.names().map((name) => this.capabilitiesOf(name));
  }

  /**
   * Construct a provider by name.
   *
   * @throws ProviderError when the name is unknown.
   */
  create(name: string): Provider {
    const entry = this.#lookup(name);
    const provider = entry.factory();
    if (!this.#satisfies(provider)) {
      throw new ProviderError(
        ErrorCode.PROVIDER_FAILED,
        `Provider "${name}" does not implement every method its capabilities require.`,
        { remediation: 'Implement the missing methods or narrow the declared capabilities.' },
      );
    }
    return provider;
  }

  /** Assert a provider supports a capability, with an actionable error. */
  assertCapability(name: string, capability: string): void {
    const caps = this.capabilitiesOf(name);
    if (!caps.capabilities.includes(capability as never)) {
      throw new ProviderError(
        ErrorCode.PROVIDER_UNSUPPORTED,
        `Provider "${name}" does not support "${capability}".`,
        {
          provider: name,
          remediation: `Supported capabilities: ${caps.capabilities.join(', ') || 'none'}.`,
          detail: { requested: capability, supported: caps.capabilities },
        },
      );
    }
  }

  #lookup(name: string): RegistryEntry {
    const key = name.trim().toLowerCase();
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      throw new ProviderError(ErrorCode.PROVIDER_NOT_FOUND, `Unknown provider "${name}".`, {
        remediation: `Known providers: ${this.names().join(', ') || 'none registered'}.`,
        detail: { requested: name, known: this.names() },
      });
    }
    return entry;
  }

  /** Verify the constructed instance implements its declared capabilities. */
  #satisfies(provider: Provider): boolean {
    const caps = provider.capabilities();
    const surface = provider as unknown as Record<string, unknown>;
    return caps.capabilities.every((capability) => {
      const method = CAPABILITY_METHODS[capability];
      return method === undefined || typeof surface[method] === 'function';
    });
  }
}

/**
 * The registry the CLI uses.
 *
 * The shipped registry now lives in `default-registry.ts`, so this module stays
 * free of concrete provider imports and the composition root is the only file
 * that has to change when a provider is added.
 */
export { createDefaultRegistry } from './default-registry.js';
