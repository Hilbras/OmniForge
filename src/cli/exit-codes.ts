/**
 * Process exit codes.
 *
 * Lives in its own module so command modules can use it without importing the
 * CLI entry point, which imports them in turn. Scripts and CI branch on these
 * values, so they are part of the CLI's contract and must not drift.
 */
export const ExitCode = {
  /** Command completed. */
  Success: 0,
  /** Unclassified failure. */
  Generic: 1,
  /** Configuration missing, unparseable, or invalid. */
  Config: 2,
  /** Verification or cross-platform integrity failed. */
  Verification: 3,
  /** A destructive operation needed confirmation that was not given. */
  Confirmation: 4,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Map an error code to the exit code the CLI should return.
 *
 * Keeping the mapping in one place means a new error code cannot be forgotten
 * when a command starts handling it.
 */
export function exitCodeFor(code: string): ExitCodeValue {
  switch (code) {
    case 'CONFIG_NOT_FOUND':
    case 'CONFIG_INVALID':
    case 'CONFIG_PARSE_ERROR':
      return ExitCode.Config;
    case 'VERIFICATION_FAILED':
    case 'INTEGRITY_FAILED':
      return ExitCode.Verification;
    case 'CONFIRMATION_REQUIRED':
      return ExitCode.Confirmation;
    default:
      return ExitCode.Generic;
  }
}
