/**
 * The provider contract.
 *
 * Everything the release engine knows about a platform lives behind this
 * interface. The Core never branches on a platform name — it asks a provider
 * what it can do via `capabilities` and calls the matching method. Adding a
 * registry means implementing this interface and registering a factory; no
 * orchestration code changes.
 */

/** Operations a provider may support. */
export const Capability = {
  Repository: 'repository',
  Tags: 'tags',
  Releases: 'releases',
  Assets: 'assets',
  Package: 'package',
  Publish: 'publish',
  DistTags: 'dist-tags',
  Upload: 'upload',
  Verify: 'verify',
} as const;

export type CapabilityValue = (typeof Capability)[keyof typeof Capability];

/** What a provider reports about itself. */
export interface ProviderCapabilities {
  readonly name: string;
  /** Short human description shown by `forge provider capabilities`. */
  readonly description: string;
  /** Every capability the provider implements. */
  readonly capabilities: readonly CapabilityValue[];
  /** Artifacts the provider can read or write a version from. */
  readonly versionSources: readonly string[];
}

/** Result of authenticating. Holds no secret material. */
export interface AuthResult {
  readonly authenticated: boolean;
  /** Non-secret identity, e.g. `lacrous` or `@hilbras/forge`. */
  readonly identity?: string;
}

/** A version observed at a provider, for integrity comparison. */
export interface ObservedVersion {
  readonly provider: string;
  readonly version: string | null;
  /** What the observation found — package, tag, release. */
  readonly reference: string;
}

/** Per-provider result of a verification pass. */
export interface VerificationResult {
  readonly provider: string;
  readonly verified: boolean;
  readonly observed: ObservedVersion;
  readonly checks: readonly VerificationCheck[];
}

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Everything a provider needs from the world to do its job.
 *
 * Passing a context rather than reaching for globals keeps providers testable
 * and means a dry run can supply an executor that does nothing.
 */
export interface ProviderContext {
  /** Absolute path of the project root (where forge.config.yaml was found). */
  readonly projectRoot: string;
  /** Resolved configuration, already validated. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Resolves a secret by name. Providers must never log the result. */
  readonly getSecret: (name: string) => string | undefined;
  /** Runs a command. May be a no-op in dry-run mode. */
  readonly execute: ProviderExecutor;
  /** True when the release should make no external changes. */
  readonly dryRun: boolean;
}

/** Command execution surface handed to providers. */
export interface ProviderExecutor {
  /** Run a command with an argument array. Resolves with the exit code. */
  run(
    command: string,
    args: readonly string[],
    options?: ProviderExecOptions,
  ): Promise<ProviderExecResult>;
  /** HTTP GET/POST against a registry API. */
  request?(url: string, init?: ProviderRequestInit): Promise<ProviderRequestResult>;
}

export interface ProviderExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Receives streamed stdout/stderr so providers can show progress. */
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export interface ProviderExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProviderRequestInit {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

export interface ProviderRequestResult {
  readonly status: number;
  readonly body: string;
}

/** Configuration a provider understands, in provider-neutral shape. */
export interface ProviderSettings {
  readonly enabled: boolean;
  readonly package?: string;
  readonly registry?: string;
  readonly repository?: string;
  readonly distTag?: string;
  readonly channel?: string;
}

/**
 * The contract every provider implements.
 *
 * Optional members are optional in the interface, not in practice: a provider
 * that advertises a capability must implement the matching method, and the
 * registry's `assertCapability` enforces that at registration time.
 */
export interface Provider {
  /** Stable identifier, matching the key in forge.config.yaml. */
  readonly name: string;

  /** What this provider can do. Queried by the release engine before calls. */
  capabilities(): ProviderCapabilities;

  /** Verify credentials. Must not log or return secret material. */
  authenticate(context: ProviderContext): Promise<AuthResult>;

  /** Check the provider is usable — target exists, config is coherent. */
  validate(context: ProviderContext): Promise<void>;

  /** Read the version this provider currently has. */
  getVersion(context: ProviderContext): Promise<ObservedVersion>;

  /** Publish a release. Must be a no-op under `context.dryRun`. */
  publish(context: ProviderContext, input: PublishInput): Promise<PublishResult>;

  /** Confirm what was published actually landed. */
  verify(context: ProviderContext, version: string): Promise<VerificationResult>;

  /** Clean up providers holding connections. Optional. */
  dispose?(): Promise<void>;
}

/** What a provider is asked to publish. */
export interface PublishInput {
  readonly version: string;
  /** Absolute paths of artifacts to attach, if the provider takes assets. */
  readonly artifacts?: readonly string[];
  readonly prerelease?: boolean;
  readonly draft?: boolean;
  readonly notes?: string;
}

export interface PublishResult {
  readonly published: boolean;
  /** URL or identifier the provider published to. */
  readonly reference: string;
  /** Version the provider recorded, which may differ from the request. */
  readonly version: string;
}
