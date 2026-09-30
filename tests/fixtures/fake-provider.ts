/**
 * A provider that exists only for tests.
 *
 * It exercises the full lifecycle and every capability mapping without touching
 * a real registry, which is how we demonstrate that Core works with an unknown
 * platform — the same property a real Docker Hub provider would rely on.
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
} from '../../src/core/provider.js';

export interface FakeProviderOptions {
  readonly name?: string;
  readonly authenticated?: boolean;
  readonly currentVersion?: string | null;
  /** Throw from `publish`, simulating a registry failure. */
  readonly failPublish?: Error;
  /** Throw from `authenticate`, simulating bad credentials. */
  readonly failAuth?: Error;
  /** Throw from `verify`, simulating an unreachable registry. */
  readonly failVerify?: Error;
}

export class FakeProvider implements Provider {
  readonly name: string;
  readonly calls: string[] = [];
  readonly published: PublishInput[] = [];
  /** Flipped by `publish` so `verify` reports the new version. */
  #version: string | null;

  constructor(private readonly options: FakeProviderOptions = {}) {
    this.name = options.name ?? 'fake';
    this.#version = options.currentVersion ?? '1.0.0';
  }

  capabilities(): ProviderCapabilities {
    return {
      name: this.name,
      description: 'In-memory provider used by the test suite',
      capabilities: [
        Capability.Package,
        Capability.Publish,
        Capability.DistTags,
        Capability.Verify,
      ],
      versionSources: ['package.json'],
    };
  }

  async authenticate(_context: ProviderContext): Promise<AuthResult> {
    this.calls.push('authenticate');
    if (this.options.failAuth) throw this.options.failAuth;
    return { authenticated: this.options.authenticated ?? true, identity: `identity:${this.name}` };
  }

  async validate(context: ProviderContext): Promise<void> {
    this.calls.push('validate');
    if (context.dryRun) this.calls.push('validate:dry-run');
  }

  async getVersion(_context: ProviderContext): Promise<ObservedVersion> {
    this.calls.push('getVersion');
    return { provider: this.name, version: this.#version, reference: `memory://${this.name}` };
  }

  async publish(context: ProviderContext, input: PublishInput): Promise<PublishResult> {
    this.calls.push('publish');
    if (context.dryRun) {
      // A real provider must not mutate external state in dry-run, but it must
      // still report what it would have done.
      return { published: false, reference: `dry-run://${this.name}`, version: input.version };
    }
    if (this.options.failPublish) throw this.options.failPublish;
    this.published.push(input);
    this.#version = input.version;
    return {
      published: true,
      reference: `memory://${this.name}/${input.version}`,
      version: input.version,
    };
  }

  async verify(_context: ProviderContext, version: string): Promise<VerificationResult> {
    this.calls.push('verify');
    if (this.options.failVerify) throw this.options.failVerify;
    const matches = this.#version === version;
    return {
      provider: this.name,
      verified: matches,
      observed: { provider: this.name, version: this.#version, reference: `memory://${this.name}` },
      checks: [
        { name: 'version-exists', passed: this.#version !== null, detail: String(this.#version) },
        {
          name: 'version-matches',
          passed: matches,
          detail: `expected ${version}, saw ${this.#version}`,
        },
      ],
    };
  }
}
