/**
 * Check and build engine.
 *
 * Phase 0 reserves the boundary. Phase 5 implements command execution here with
 * stdout/stderr/exit-code capture, timeouts, and the mandatory/optional policy
 * that decides whether a failure halts the release.
 */

export interface CheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  /** False when the command exceeded its timeout. */
  readonly timedOut?: boolean;
  /** True when the failure is tolerated and the release may continue. */
  readonly optional?: boolean;
}
