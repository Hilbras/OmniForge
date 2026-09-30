/**
 * Shared utilities.
 *
 * Phase 0 establishes `redact()`, which every serialization boundary must call
 * before a credential could reach a log, a report, or an error message. The
 * secret-leak tests in Phase 11 plant a token in every sink to prove it.
 */

/** Placeholder substituted for any credential fragment found in output. */
export const REDACTED = '[REDACTED]';

/**
 * Environment variable names whose values must never appear in output.
 *
 * Matched case-insensitively against variable *names*, so `NPM_TOKEN` and
 * `npm_token` are both covered.
 */
export const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_CREDENTIAL|AUTH)$/i;

/** True when an environment variable name looks like it holds a credential. */
export function isSecretName(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}

/**
 * Mask a credential for display, keeping a short recognizable prefix.
 *
 * `ghp_1234567890abcdef` becomes `ghp_************`, matching the format in the
 * security spec. Values of 8 characters or fewer are fully masked, since a
 * partial mask of a short secret leaks most of it.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return REDACTED;
  if (value.length <= 8) return '*'.repeat(value.length);

  const separator = /^([a-z]+[_-])/i.exec(value);
  const prefix = separator?.[1] ?? '';
  return `${prefix}${'*'.repeat(12)}`;
}

/**
 * Remove known secret values from arbitrary text.
 *
 * Used at every boundary where provider output or error messages become
 * user-visible text. `secrets` should be the set of values actually resolved
 * during the run, since a token from an unlisted source cannot be recognized.
 */
export function redact(text: string, secrets: Iterable<string> = []): string {
  let output = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      output = output.split(secret).join(REDACTED);
    }
  }
  return output;
}

/**
 * Build a redactor bound to a set of resolved secrets.
 *
 * Capture once per run so every boundary shares the same redaction set.
 */
export function createRedactor(secrets: Iterable<string>): (text: string) => string {
  const known = [...secrets].filter((s) => typeof s === 'string' && s.length >= 4);
  return (text: string) => redact(text, known);
}
