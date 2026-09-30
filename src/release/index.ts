/**
 * Release orchestration.
 *
 * Phase 0 reserves the boundary. Phase 8 implements the step pipeline here:
 * a linear sequence of steps, each recording a result, where a mandatory step
 * failure halts the run and prevents any later step from making changes.
 */

export type ReleaseStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/** One executed step of a release. Appended to the report as the run proceeds. */
export interface ReleaseStepResult {
  readonly step: string;
  readonly provider?: string;
  readonly status: ReleaseStepStatus;
  readonly detail: string;
  readonly durationMs?: number;
}

/** Aggregate outcome of a whole release. */
export type ReleaseOutcome = 'success' | 'failed' | 'partial';
