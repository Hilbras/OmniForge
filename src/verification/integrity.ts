/**
 * Verification and release integrity.
 *
 * Phase 9, split out of the pipeline so `forge verify` can check a release at any
 * time — after a CI run, before a deploy, or days later when someone suspects a
 * tag and a package disagree.
 *
 * The core question is narrow and important: does every provider agree on one
 * version? A release where GitHub says `1.5.0` and npm says `1.4.0` is broken in a
 * way no single provider can detect, because each is individually correct.
 */

import type { ProviderRegistry } from '../core/registry.js';
import type { ProviderContext, VerificationResult } from '../core/provider.js';
import { ErrorCode, VerificationError } from '../errors/index.js';
import type { ForgeConfig } from '../configuration/schema.js';

/** One provider's contribution to the comparison. */
export interface IntegrityEntry {
  readonly provider: string;
  /** The version this provider reports, or null when it reports nothing. */
  readonly observed: string | null;
  /** What the provider's own verify said. */
  readonly verified: boolean;
  /** Individual check outcomes, for the detail view. */
  readonly checks: readonly { name: string; passed: boolean; detail: string }[];
}

/** The whole comparison. */
export interface IntegrityReport {
  /** True when every participating provider agrees and verifies. */
  readonly passed: boolean;
  readonly expected: string;
  readonly entries: readonly IntegrityEntry[];
  /** Human-readable reasons it failed. Empty when it passed. */
  readonly problems: readonly string[];
  /** Providers that could not be reached at all. */
  readonly unreachable: readonly string[];
}

/** What to verify. */
export interface VerifyOptions {
  /** Providers are resolved through the registry, never constructed directly. */
  readonly registry: ProviderRegistry;
  /** The version to check. */
  readonly version: string;
  /** Restrict to these providers. Defaults to every enabled one. */
  readonly only?: readonly string[] | undefined;
  /** Build the provider context for each provider. */
  readonly contextFor: (provider: string) => ProviderContext;
  /** Which providers are enabled, in order. */
  readonly providersFor: (config: ForgeConfig, only?: readonly string[]) => readonly string[];
}

/**
 * Verify a release across every participating provider.
 *
 * A provider that throws is recorded as unreachable rather than aborting the
 * check: the others may still show a real mismatch, and knowing which one could
 * not be reached is part of the answer.
 */
export async function verifyRelease(
  config: ForgeConfig,
  deps: VerifyOptions,
): Promise<IntegrityReport> {
  const expected = deps.version;
  const names = deps.providersFor(config, deps.only);

  const entries: IntegrityEntry[] = [];
  const unreachable: string[] = [];

  for (const name of names) {
    try {
      const provider = deps.registry.create(name);
      const result: VerificationResult = await provider.verify(deps.contextFor(name), expected);

      entries.push({
        provider: name,
        observed: result.observed.version,
        verified: result.verified,
        checks: result.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      });
    } catch (error) {
      // One provider being unreachable must not hide a mismatch in another.
      unreachable.push(name);
      entries.push({
        provider: name,
        observed: null,
        verified: false,
        checks: [
          {
            name: 'reachable',
            passed: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  const problems: string[] = [];
  for (const name of unreachable) {
    problems.push(`${name} could not be reached`);
  }

  for (const entry of entries) {
    if (entry.observed === null) {
      if (!unreachable.includes(entry.provider)) {
        problems.push(`${entry.provider} reported no version`);
      }
      continue;
    }

    // A provider may report its tag form (`v1.5.0`) while package.json says
    // `1.5.0`. That is agreement, and treating it as a mismatch would make the
    // check useless for exactly the provider most likely to differ in shape.
    const observed = stripPrefix(entry.observed, config.version.tagPrefix);
    if (observed !== expected) {
      problems.push(`${entry.provider} reports ${entry.observed}, expected ${expected}`);
    }

    const failed = entry.checks.filter((c) => !c.passed);
    for (const check of failed) {
      problems.push(`${entry.provider}: ${check.name} failed — ${check.detail}`);
    }
  }

  return {
    passed: problems.length === 0,
    expected,
    entries,
    problems,
    unreachable,
  };
}

/**
 * Throw when a release does not hold together.
 *
 * Separate from `verifyRelease` so the caller can inspect a report without
 * exception handling — the CLI prints it either way, but the pipeline needs the
 * failure to be a hard error.
 */
export function assertIntegrity(report: IntegrityReport, operation = 'verify'): void {
  if (report.passed) return;

  throw new VerificationError(
    ErrorCode.INTEGRITY_FAILED,
    `Release integrity check failed for ${report.expected}.`,
    {
      operation,
      remediation:
        'Re-publish the missing provider, or roll the whole release back to one version.',
      detail: {
        expected: report.expected,
        problems: report.problems,
        unreachable: report.unreachable,
        observed: report.entries.map((e) => ({ provider: e.provider, version: e.observed })),
      },
    },
  );
}

/** Strip a configured tag prefix from a version-like string. */
export function stripPrefix(value: string, prefix: string): string {
  if (prefix.length > 0 && value.startsWith(prefix)) return value.slice(prefix.length);
  // Tolerate a bare `v` even when the configured prefix differs.
  return /^v\d/.test(value) ? value.slice(1) : value;
}

/** A one-line verdict, for the terminal. */
export function summarize(report: IntegrityReport): string {
  if (report.passed)
    return `${report.expected} verified across ${report.entries.length} provider(s)`;
  return `${report.expected}: ${report.problems.length} problem(s)`;
}

/** The observed versions as rows, for a table. */
export function table(report: IntegrityReport): readonly (readonly [string, string, string])[] {
  return report.entries.map((entry) => [
    entry.provider,
    entry.observed ?? '—',
    entry.verified ? 'ok' : 'failed',
  ]);
}
