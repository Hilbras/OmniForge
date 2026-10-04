/**
 * Audit log.
 *
 * Records what a release did: operation, provider, timestamp, result, and error
 * code. Deliberately not a debug log — it carries no stdout, no stack traces, and
 * no message text, because any of those can contain a credential echoed back by
 * a provider. The point is to answer "what did Forge do, when, and did it work",
 * which is answerable from codes alone.
 *
 * Appended to `.forge/audit.log` as JSON Lines, so it stays greppable and a
 * corrupt line cannot break the ones around it.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { globalSecrets } from '../utils/secrets.js';

/** What kind of thing happened. */
export type AuditOperation =
  | 'configure'
  | 'authenticate'
  | 'validate'
  | 'checks'
  | 'version'
  | 'tag'
  | 'publish'
  | 'verify'
  | 'dist-tag';

/** Outcome of one audited operation. */
export type AuditResult = 'passed' | 'failed' | 'skipped';

/** One audit entry. Fixed fields only — never free text. */
export interface AuditEntry {
  readonly timestamp: string;
  readonly operation: AuditOperation;
  readonly provider?: string;
  readonly result: AuditResult;
  /** A ForgeError code, or `UNKNOWN`. Never a message. */
  readonly code?: string;
  readonly durationMs?: number;
  /** Dry runs are recorded distinctly, so a plan is never mistaken for a release. */
  readonly dryRun?: boolean;
}

/** Build an entry, redacting defensively. */
export function entry(
  operation: AuditOperation,
  result: AuditResult,
  options: {
    provider?: string;
    code?: string;
    durationMs?: number;
    dryRun?: boolean;
  } = {},
): AuditEntry {
  return globalSecrets.redactDeep({
    timestamp: new Date().toISOString(),
    operation,
    result,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
}

/**
 * Append entries to the project's audit log.
 *
 * Writes are best-effort: an audit failure must never fail the release it is
 * recording. A permission problem on `.forge/` should not stop a publish.
 */
export function append(projectRoot: string, entries: readonly AuditEntry[]): boolean {
  if (entries.length === 0) return true;

  try {
    mkdirSync(join(projectRoot, '.forge'), { recursive: true });
    const lines = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    appendFileSync(join(projectRoot, '.forge', 'audit.log'), lines, 'utf8');
    return true;
  } catch {
    // Deliberately swallowed; see the note above.
    return false;
  }
}

/** Render an entry as one human-readable line, for the terminal. */
export function format(e: AuditEntry): string {
  const parts = [e.timestamp, e.operation];
  if (e.provider !== undefined) parts.push(e.provider);
  parts.push(e.result);
  if (e.code !== undefined) parts.push(e.code);
  return parts.join(' ');
}
