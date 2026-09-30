/**
 * Release reporting.
 *
 * Phase 0 reserves the boundary. Phase 10 implements the `ReleaseReport` model
 * and the terminal, JSON, and Markdown renderers. Every renderer passes through
 * `redact()` so a credential cannot reach a report by accident.
 */

import type { ReleaseOutcome, ReleaseStepResult } from '../release/index.js';

export type ReportFormat = 'terminal' | 'json' | 'markdown';

/** Machine-readable result of one release, before rendering. */
export interface ReleaseReport {
  readonly project: string;
  readonly version: string;
  readonly timestamp: string;
  readonly commit?: string;
  readonly branch?: string;
  readonly dryRun: boolean;
  readonly steps: readonly ReleaseStepResult[];
  readonly outcome: ReleaseOutcome;
}

/** Turn a report into text in the requested format. */
export type ReportRenderer = (report: ReleaseReport) => string;
