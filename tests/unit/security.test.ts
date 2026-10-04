/**
 * Security tests.
 *
 * The strategy is to plant a distinctive fake credential in *every* place a
 * secret could plausibly reach output, then assert it appears in none of them.
 * Searching the code for leaks does not scale and misses indirect paths — a
 * provider's stderr captured into an error detail and then written to a report
 * is exactly the leak a grep-based audit would call clean.
 */

import { describe, expect, it } from 'vitest';

import { REDACTED, SecretRegistry, isSecretName } from '../../src/utils/secrets.js';
import { createConsole } from '../../src/ui/theme.js';
import { render } from '../../src/release/report.js';
import { ForgeError, ErrorCode } from '../../src/errors/index.js';
import type { ReleaseResult } from '../../src/release/pipeline.js';

const TOKEN = 'npm_LEAKCANARY_9f3a2b1c8d7e6f5a';

/** A console wired to a redactor holding the canary. */
function redactingConsole(registry: SecretRegistry) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const console = createConsole({
    write: (t) => stdout.push(t),
    writeError: (t) => stderr.push(t),
    redact: (t) => registry.redact(t),
  });
  return { console, out: () => stdout.join(''), err: () => stderr.join(''), stdout, stderr };
}

describe('SecretRegistry', () => {
  it('registers and redacts a value', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);

    expect(registry.size).toBe(1);
    expect(registry.redact(`failed with ${TOKEN}`)).toBe(`failed with ${REDACTED}`);
  });

  it('redacts every occurrence', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);

    expect(registry.redact(`${TOKEN} and ${TOKEN}`).match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('ignores values too short to redact safely', () => {
    // Redacting a 3-character string would mangle unrelated text.
    const registry = new SecretRegistry();
    registry.add('abc');

    expect(registry.size).toBe(0);
    expect(registry.redact('abc def')).toBe('abc def');
  });

  it('ignores undefined', () => {
    const registry = new SecretRegistry();
    registry.add(undefined);
    expect(registry.size).toBe(0);
  });

  it('is a no-op with nothing registered', () => {
    expect(new SecretRegistry().redact('anything at all')).toBe('anything at all');
  });

  it('redacts a secret containing another, longest first', () => {
    const registry = new SecretRegistry();
    registry.add('abcdefghij');
    registry.add('abcdefghijklmnopqrst');

    // If the shorter matched first, the longer would survive partially.
    expect(registry.redact('value abcdefghijklmnopqrst end')).toBe(`value ${REDACTED} end`);
  });

  it('handles regex metacharacters in a secret', () => {
    const registry = new SecretRegistry();
    registry.add('a.b*c+d(e)f');

    expect(registry.redact('token a.b*c+d(e)f here')).toBe(`token ${REDACTED} here`);
  });

  it('registers every secret-named variable from an environment', () => {
    const registry = new SecretRegistry();
    registry.addFromEnv({
      NPM_TOKEN: 'npm_secretvalue_123456',
      GITHUB_TOKEN: 'ghp_secretvalue_123456',
      HOME: '/home/user',
      PATH: '/usr/bin',
      CI: 'true',
    });

    expect(registry.size).toBe(2);
    expect(registry.redact('saw npm_secretvalue_123456')).not.toContain('npm_secretvalue');
  });

  it('redacts a named variable only when its name looks secret', () => {
    const registry = new SecretRegistry();
    registry.add('thevalue12345678');

    expect(registry.redactIfSecret('NPM_TOKEN', 'thevalue12345678')).toBe(REDACTED);
    expect(registry.redactIfSecret('HOME', '/home/user')).toBe('/home/user');
  });

  describe('addFromEnv', () => {
    // Called by the CLI to seed the registry at startup. It runs inside a
    // subprocess in the integration tests, so v8 coverage cannot observe it —
    // these tests exist so the behaviour is verified directly rather than
    // assumed to work because the leak tests pass.
    it('registers every secret-named variable', () => {
      const registry = new SecretRegistry().addFromEnv({
        NPM_TOKEN: 'npm_firstvalue_1',
        GITHUB_TOKEN: 'ghp_secondvalue_2',
        MY_SECRET: 'thirdvalue_3',
        HOME: '/home/user',
        PATH: '/usr/bin',
        CI: 'true',
      });

      expect(registry.size).toBe(3);
      expect(registry.has('npm_firstvalue_1')).toBe(true);
      expect(registry.has('ghp_secondvalue_2')).toBe(true);
      expect(registry.has('thirdvalue_3')).toBe(true);
    });

    it('does not register ordinary variables', () => {
      const registry = new SecretRegistry().addFromEnv({ HOME: '/home/user', PATH: '/usr/bin' });

      expect(registry.size).toBe(0);
    });

    it('ignores a secret-named variable that is empty', () => {
      const registry = new SecretRegistry().addFromEnv({ NPM_TOKEN: '' });

      expect(registry.size).toBe(0);
    });

    it('is chainable', () => {
      const registry = new SecretRegistry().addFromEnv({ NPM_TOKEN: 'npm_chainvalue_1' });

      expect(registry).toBeInstanceOf(SecretRegistry);
      expect(registry.size).toBe(1);
    });
  });

  describe('has', () => {
    it('reports whether a value is registered', () => {
      const registry = new SecretRegistry();
      registry.add('npm_registered_value_1');

      expect(registry.has('npm_registered_value_1')).toBe(true);
      expect(registry.has('npm_never_added_value')).toBe(false);
    });

    it('is false for a value that was too short to register', () => {
      const registry = new SecretRegistry();
      registry.add('short');

      expect(registry.has('short')).toBe(false);
    });
  });

  describe('redactDeep', () => {
    it('redacts nested strings', () => {
      const registry = new SecretRegistry();
      registry.add(TOKEN);

      const result = registry.redactDeep({
        a: `x ${TOKEN}`,
        b: { c: [`y ${TOKEN}`] },
      });

      expect(JSON.stringify(result)).not.toContain('LEAKCANARY');
    });

    it('blanks a value whose key name is secret-like even if unknown', () => {
      // Catches `{ token: 'unknown-to-registry' }` — a case plain redaction misses.
      const registry = new SecretRegistry();

      const result = registry.redactDeep({ token: 'value-never-registered', name: 'ok' });

      expect((result as { token: string }).token).toBe(REDACTED);
      expect((result as { name: string }).name).toBe('ok');
    });

    it('leaves non-secret data untouched', () => {
      const registry = new SecretRegistry();
      registry.add(TOKEN);

      const input = { version: '1.2.3', tags: ['a', 'b'], count: 3, ok: true };
      expect(registry.redactDeep(input)).toEqual(input);
    });
  });

  describe('isSecretName', () => {
    it.each([
      'NPM_TOKEN',
      'GITHUB_TOKEN',
      'MY_SECRET',
      'DB_PASSWORD',
      'SOME_API_KEY',
      'AWS_CREDENTIALS',
    ])('flags %s', (name) => {
      expect(isSecretName(name)).toBe(true);
    });

    it.each(['HOME', 'PATH', 'CI', 'NODE_ENV'])('does not flag %s', (name) => {
      expect(isSecretName(name)).toBe(false);
    });
  });
});

describe('every console sink redacts', () => {
  it('covers stdout helpers', () => {
    const registry = new SecretRegistry().add(TOKEN);
    const { console, out } = redactingConsole(registry);

    console.line(`a ${TOKEN}`);
    console.info(`b ${TOKEN}`);
    console.detail(`c ${TOKEN}`);
    console.heading(`d ${TOKEN}`);
    console.success(`e ${TOKEN}`);
    console.step(`f ${TOKEN}`, 'status');
    console.blank();

    expect(out()).not.toContain('LEAKCANARY');
    expect(out().length).toBeGreaterThan(0);
  });

  it('covers stderr helpers', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);
    const { console, err } = redactingConsole(registry);

    console.failure(`a ${TOKEN}`);
    console.warning(`b ${TOKEN}`);
    console.writeErrorPlain(`c ${TOKEN}`);

    expect(err()).not.toContain('LEAKCANARY');
  });

  it('covers raw writes', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);
    const { console, out, err } = redactingConsole(registry);

    console.writePlain(`raw ${TOKEN}`);
    console.writeErrorPlain(`rawerr ${TOKEN}`);

    expect(out()).not.toContain('LEAKCANARY');
    expect(err()).not.toContain('LEAKCANARY');
  });

  it('redacts even without any output call knowing it should', () => {
    // The point of redacting at the sink: a caller cannot forget.
    const registry = new SecretRegistry();
    registry.add(TOKEN);
    const stdout: string[] = [];
    const console = createConsole({
      write: (t) => stdout.push(t),
      redact: (t) => registry.redact(t),
    });

    console.line(`leaked ${TOKEN} here`);
    expect(stdout.join('')).toBe(`leaked ${REDACTED} here\n`);
  });
});

describe('error rendering redacts', () => {
  it('keeps a token out of a formatted error', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);
    const { console, err } = redactingConsole(registry);

    // The realistic leak: a provider echoes the token in its error output, Forge
    // captures it into a ForgeError detail, and the CLI prints the message.
    const error = new ForgeError(ErrorCode.PROVIDER_FAILED, `publish failed using ${TOKEN}`, {
      detail: { output: `npm ERR! Authorization: Bearer ${TOKEN}` },
    });

    console.writeErrorPlain(`${error.message}\n`);
    console.writeErrorPlain(`${JSON.stringify(error.toJSON())}\n`);

    expect(err()).not.toContain('LEAKCANARY');
  });

  it('leaves text alone when no redactor is supplied', () => {
    // Documents the default honestly: redaction is opt-in at the console, so the
    // CLI must always pass one. The CLI contract test asserts it does.
    const out: string[] = [];
    const console = createConsole({ write: (t) => out.push(t) });

    console.line(`plain ${TOKEN}`);
    expect(out.join('')).toContain('LEAKCANARY');
  });

  it('keeps a token out of a cause chain dump', () => {
    const registry = new SecretRegistry();
    registry.add(TOKEN);
    const { console, err } = redactingConsole(registry);

    // `--verbose` dumps the cause's stack, which often carries provider output.
    const cause = new Error(`inner failure with ${TOKEN}`);
    console.writeErrorPlain(`${cause.stack ?? ''}\n`);
    expect(err()).not.toContain('LEAKCANARY');
  });
});

describe('reports redact', () => {
  const leaky = (): ReleaseResult => ({
    project: 'acme',
    version: '1.0.0',
    previousVersion: '0.9.0',
    tag: 'v1.0.0',
    dryRun: false,
    outcome: 'failed',
    steps: [
      {
        step: 'publish',
        provider: 'npm',
        status: 'failed',
        detail: `npm ERR! sent token ${TOKEN}`,
        durationMs: 10,
        mandatory: true,
        error: { code: 'PROVIDER_FAILED', message: `rejected ${TOKEN}` },
      },
    ],
    integrity: {
      passed: false,
      expected: '1.0.0',
      observed: [{ provider: 'npm', version: null }],
      mismatches: [`npm rejected ${TOKEN}`],
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    totalDurationMs: 100,
  });

  it.each(['terminal', 'json', 'markdown'] as const)('redacts the %s report', (format) => {
    const text = render(leaky(), format, [TOKEN]);
    expect(text).not.toContain('LEAKCANARY');
  });

  it('still produces valid JSON after redaction', () => {
    const parsed: unknown = JSON.parse(render(leaky(), 'json', [TOKEN]));
    expect(parsed).toBeTruthy();
    expect(JSON.stringify(parsed)).not.toContain('LEAKCANARY');
  });

  it('keeps the useful parts of a report', () => {
    const text = render(leaky(), 'markdown', [TOKEN]);
    expect(text).toContain('acme v1.0.0');
    expect(text).toContain('publish');
  });
});
