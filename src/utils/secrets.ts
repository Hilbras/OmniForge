/**
 * Secret registry.
 *
 * The single answer to "what must never be printed". A credential is registered
 * once, when it is resolved, and every output sink redacts against it. That
 * inversion matters: auditing each call site for leaks does not scale, whereas a
 * redacting sink is correct by construction for every caller, including ones
 * written later.
 *
 * The threat this covers, concretely: `npm` and `gh` echo their arguments and
 * sometimes their headers in error output. Capturing that into a `ForgeError`
 * detail and writing it to `.forge/releases/*.json` would put a live token on
 * disk. Registration at the boundary is what stops it.
 */

/** Registered secrets, plus a fast membership test for the redaction pass. */
export class SecretRegistry {
  readonly #secrets = new Set<string>();
  #dirty = false;
  #cache: (text: string) => string = (text) => text;

  /**
   * Register a secret value.
   *
   * Very short values are ignored: redacting a 3-character string would mangle
   * unrelated text without meaningfully protecting anything.
   *
   * Returns the registry so registration can be chained in a single expression,
   * which is how tests and the CLI build it up.
   */
  add(value: string | undefined): this {
    if (value === undefined || value.length < 8) return this;
    if (this.#secrets.has(value)) return this;
    this.#secrets.add(value);
    this.#dirty = true;
    return this;
  }

  /** Register every candidate found in an environment. */
  addFromEnv(env: NodeJS.ProcessEnv): this {
    for (const [name, value] of Object.entries(env)) {
      if (isSecretName(name)) this.add(value);
    }
    return this;
  }

  /** How many secrets are registered. Used by tests. */
  get size(): number {
    return this.#secrets.size;
  }

  /** True when a value is registered. */
  has(value: string): boolean {
    return this.#secrets.has(value);
  }

  /**
   * Redact text against every registered secret.
   *
   * The compiled matcher is rebuilt only when a secret is added, so the cost is
   * one pass per output call and no allocation when nothing changed.
   */
  redact(text: string): string {
    if (this.#secrets.size === 0) return text;
    if (this.#dirty) {
      // Longest first, so a secret that contains another is replaced whole.
      const ordered = [...this.#secrets].sort((a, b) => b.length - a.length);
      const escaped = ordered.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const pattern = new RegExp(escaped.join('|'), 'g');
      this.#cache = (value: string): string => value.replace(pattern, REDACTED);
      this.#dirty = false;
    }
    return this.#cache(text);
  }

  /**
   * Redact a value only if it looks like a secret.
   *
   * For env-var-driven config: redact `NPM_TOKEN` but leave an ordinary value
   * alone, so a debug dump stays useful.
   */
  redactIfSecret(name: string, value: string): string {
    return isSecretName(name) ? this.redact(value) : value;
  }

  /**
   * Deeply redact a JSON-serializable structure.
   *
   * Note this does *not* short-circuit on an empty registry: even with no known
   * secret, a key whose name looks like a credential must still be blanked. That
   * is the case plain value-redaction cannot catch — a `{ token: "..." }` whose
   * value Forge never resolved — and short-circuiting would leave it in place.
   */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') {
      return (this.#secrets.size === 0 ? value : this.redact(value)) as T;
    }
    if (Array.isArray(value)) {
      // `Array.isArray` narrows to `any[]`, so the element type is restored
      // explicitly rather than letting the map produce `any[]`.
      const entries = value as unknown[];
      return entries.map((entry: unknown) => this.redactDeep(entry)) as T;
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = isSecretName(key) ? REDACTED : this.redactDeep(entry);
      }
      return out as T;
    }
    return value;
  }
}

/**
 * Placeholder substituted for a redacted secret.
 *
 * `[REDACTED]` rather than a masked prefix, because a masked prefix still
 * confirms the shape of a credential to anyone reading it.
 */
export const REDACTED = '[REDACTED]';

/** Environment variable names whose values must never appear in output. */
const SECRET_NAME_PATTERN =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_CREDENTIAL|CREDENTIALS|_KEY|AUTH)$/i;

/** True when an environment variable name looks like it holds a credential. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERN.test(name);
}

/** The registry the CLI uses, populated as credentials are resolved. */
export const globalSecrets = new SecretRegistry();
