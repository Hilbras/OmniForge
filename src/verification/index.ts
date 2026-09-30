/**
 * Verification and release integrity.
 *
 * Phase 0 reserves the boundary. Phase 9 implements per-provider verification
 * and the cross-platform comparison that fails a release when the observed tag,
 * release, npm version, and PyPI version do not all agree.
 */

import type { ObservedVersion, VerificationResult } from '../core/provider.js';

export type { ObservedVersion, VerificationResult };

/** One platform's contribution to the integrity comparison. */
export interface IntegrityEntry {
  readonly provider: string;
  readonly expected: string;
  readonly observed: string | null;
  readonly matches: boolean;
}

/** Aggregate integrity verdict across every provider that took part. */
export interface IntegrityReport {
  readonly passed: boolean;
  readonly expected: string;
  readonly entries: readonly IntegrityEntry[];
  readonly mismatches: readonly string[];
}
