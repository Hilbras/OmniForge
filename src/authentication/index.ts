/**
 * Authentication.
 *
 * Phase 0 reserves the boundary. Phase 3+ implements per-provider credential
 * resolution. The one rule established now, because it is a security
 * requirement rather than a feature: credentials are resolved from the
 * environment on demand and are never written into configuration, reports, or logs.
 */

/** Where a credential came from, so the CLI can explain an auth failure. */
export type CredentialSource = 'environment' | 'tool' | 'config-reference' | 'absent';

/** A resolved credential. `secret` must never be logged or serialized. */
export interface ResolvedCredential {
  readonly present: boolean;
  readonly source: CredentialSource;
  /** Non-secret identity, e.g. `lacrous`. Safe to display. */
  readonly identity?: string;
}
