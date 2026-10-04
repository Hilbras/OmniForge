/**
 * Public entry point for `@hilbras/omniforge`.
 *
 * Consumers embedding Forge as a library get the provider contract, the
 * registry, the error taxonomy, and the factory that assembles a default
 * registry. Concrete provider implementations are reachable via the
 * `@hilbras/omniforge/providers` subpath export.
 */

export {
  Capability,
  type AuthResult,
  type CapabilityValue,
  type ObservedVersion,
  type Provider,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderExecOptions,
  type ProviderExecResult,
  type ProviderExecutor,
  type ProviderRequestInit,
  type ProviderRequestResult,
  type ProviderSettings,
  type PublishInput,
  type PublishResult,
  type VerificationCheck,
  type VerificationResult,
} from './core/provider.js';

export { ProviderRegistry, createDefaultRegistry, type ProviderFactory } from './core/registry.js';

export {
  AuthError,
  CheckError,
  ConfigError,
  DuplicateReleaseError,
  EnvironmentError,
  ErrorCode,
  ForgeError,
  ProviderError,
  VersionError,
  VerificationError,
  isForgeError,
  toForgeError,
  type ErrorCodeValue,
  type ForgeErrorOptions,
} from './errors/index.js';
