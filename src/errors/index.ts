/**
 * Error taxonomy for Forge.
 *
 * Every error carries a machine-readable `code` so callers and the CLI can
 * branch on it, plus a human-readable message that names what failed and what
 * to do next. Provider-specific failures are normalized into these codes so the
 * release engine never needs to know which platform produced an error.
 */

/** Stable, machine-readable error codes. */
export const ErrorCode = {
  // Configuration
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_PARSE_ERROR: 'CONFIG_PARSE_ERROR',

  // Authentication
  AUTH_MISSING_CREDENTIALS: 'AUTH_MISSING_CREDENTIALS',
  AUTH_FAILED: 'AUTH_FAILED',

  // Versioning
  VERSION_INVALID: 'VERSION_INVALID',
  VERSION_INCONSISTENT: 'VERSION_INCONSISTENT',

  // Checks / build
  CHECK_FAILED: 'CHECK_FAILED',
  CHECK_TIMEOUT: 'CHECK_TIMEOUT',
  COMMAND_REJECTED: 'COMMAND_REJECTED',

  // Providers
  PROVIDER_NOT_FOUND: 'PROVIDER_NOT_FOUND',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED',

  // Release safety
  DUPLICATE_RELEASE: 'DUPLICATE_RELEASE',
  DUPLICATE_TAG: 'DUPLICATE_TAG',
  CONFIRMATION_REQUIRED: 'CONFIRMATION_REQUIRED',

  // Verification
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',

  // Environment
  GIT_REPO_NOT_FOUND: 'GIT_REPO_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Options accepted by the ForgeError constructor. */
export interface ForgeErrorOptions {
  /** The operation that was affected, e.g. `npm.publish`. */
  operation?: string;
  /** Which provider raised it, e.g. `npm`. */
  provider?: string;
  /** What the user can do to recover. */
  remediation?: string;
  /** Underlying error, preserved for `--verbose` but never rendered. */
  cause?: unknown;
  /** Free-form structured detail. Must never contain secrets. */
  detail?: Record<string, unknown>;
}

/**
 * Base error for everything Forge raises deliberately.
 *
 * Subclasses exist only where a `code` alone is not enough to tell the CLI how
 * to present the failure.
 */
export class ForgeError extends Error {
  readonly code: ErrorCodeValue;
  readonly operation?: string;
  readonly provider?: string;
  readonly remediation?: string;
  readonly detail?: Record<string, unknown>;

  constructor(code: ErrorCodeValue, message: string, options: ForgeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = code;
    this.operation = options.operation;
    this.provider = options.provider;
    this.remediation = options.remediation;
    this.detail = options.detail;
    // V8-only; harmless where absent.
    (Error as { captureStackTrace?: (target: object, ctor?: unknown) => void }).captureStackTrace?.(
      this,
      new.target,
    );
  }

  /** Structured form used by JSON reports. Never includes secrets. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.operation !== undefined ? { operation: this.operation } : {}),
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.remediation !== undefined ? { remediation: this.remediation } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }

  /**
   * Multi-line rendering for the terminal.
   *
   * Answers the four questions the CLI contract requires: what failed, why,
   * what it affected, and what to do next.
   */
  format(): string {
    const lines = [`✗ ${this.message}`];
    if (this.operation) lines.push(`  Operation:  ${this.operation}`);
    if (this.provider) lines.push(`  Provider:   ${this.provider}`);
    lines.push(`  Code:       ${this.code}`);
    if (this.remediation) lines.push(`  Next step:  ${this.remediation}`);
    return lines.join('\n');
  }
}

/** Configuration was missing, malformed, or failed validation. */
export class ConfigError extends ForgeError {
  constructor(
    code:
      | typeof ErrorCode.CONFIG_NOT_FOUND
      | typeof ErrorCode.CONFIG_INVALID
      | typeof ErrorCode.CONFIG_PARSE_ERROR,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** Credentials are missing or rejected. */
export class AuthError extends ForgeError {
  constructor(
    code: typeof ErrorCode.AUTH_MISSING_CREDENTIALS | typeof ErrorCode.AUTH_FAILED,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, {
      remediation: options.remediation ?? 'Set the credential in your environment, then retry.',
      ...options,
    });
  }
}

/** A version string is not valid semver, or versions disagree across sources. */
export class VersionError extends ForgeError {
  constructor(
    code: typeof ErrorCode.VERSION_INVALID | typeof ErrorCode.VERSION_INCONSISTENT,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** A check or build command failed, timed out, or was rejected as unsafe. */
export class CheckError extends ForgeError {
  constructor(
    code:
      | typeof ErrorCode.CHECK_FAILED
      | typeof ErrorCode.CHECK_TIMEOUT
      | typeof ErrorCode.COMMAND_REJECTED,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** A provider failed, was unknown, or lacks a requested capability. */
export class ProviderError extends ForgeError {
  constructor(
    code:
      | typeof ErrorCode.PROVIDER_NOT_FOUND
      | typeof ErrorCode.PROVIDER_FAILED
      | typeof ErrorCode.PROVIDER_UNSUPPORTED,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** A release, tag, or version already exists and must not be overwritten. */
export class DuplicateReleaseError extends ForgeError {
  constructor(message: string, options: ForgeErrorOptions = {}) {
    super(ErrorCode.DUPLICATE_RELEASE, message, {
      remediation:
        options.remediation ??
        'Choose a higher version, or delete the existing release before retrying.',
      ...options,
    });
  }
}

/** Verification or cross-platform integrity comparison failed. */
export class VerificationError extends ForgeError {
  constructor(
    code: typeof ErrorCode.VERIFICATION_FAILED | typeof ErrorCode.INTEGRITY_FAILED,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/** Network, timeout, or environment-level failure. */
export class EnvironmentError extends ForgeError {
  constructor(
    code:
      | typeof ErrorCode.NETWORK_ERROR
      | typeof ErrorCode.TIMEOUT
      | typeof ErrorCode.GIT_REPO_NOT_FOUND
      | typeof ErrorCode.UNKNOWN,
    message: string,
    options: ForgeErrorOptions = {},
  ) {
    super(code, message, options);
  }
}

/**
 * Coerce anything thrown into a `ForgeError` so callers always get a `code`.
 *
 * Non-Forge throwables become `UNKNOWN` errors whose message preserves the
 * original text, which keeps CLI error rendering uniform.
 */
export function toForgeError(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred.',
): ForgeError {
  if (error instanceof ForgeError) return error;
  if (error instanceof Error) {
    return new ForgeError(ErrorCode.UNKNOWN, error.message || fallbackMessage, { cause: error });
  }
  if (typeof error === 'string' && error.length > 0) {
    return new ForgeError(ErrorCode.UNKNOWN, error);
  }
  return new ForgeError(ErrorCode.UNKNOWN, fallbackMessage, { detail: { thrown: String(error) } });
}

/** Type guard for `ForgeError`. */
export function isForgeError(error: unknown): error is ForgeError {
  return error instanceof ForgeError;
}
