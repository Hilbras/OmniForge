import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertChecksPassed, runChecks, summarize } from '../../src/build/checks.js';
import { build } from '../../src/configuration/resolve.js';
import { CheckError } from '../../src/errors/index.js';

/** A config in an isolated directory. */
function configAt(checks: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-checks-'));
  return build({ project: { name: 't' }, checks }, dir);
}

/** Shorthand for a passing Node one-liner. */
const pass = (marker: string) => ({ command: ['node', '-e', `console.log('${marker}')`] });

/** Shorthand for a failing Node one-liner. */
const fail = (marker: string) => ({
  command: ['node', '-e', `console.error('${marker}'); process.exit(1)`],
});

describe('runChecks', () => {
  it('runs every configured check', async () => {
    const seen: string[] = [];
    const result = await runChecks(configAt({ a: pass('A'), b: pass('B') }), {
      onStart: (name) => seen.push(name),
    });

    expect(seen).toEqual(['a', 'b']);
    expect(result.ok).toBe(true);
    expect(result.halted).toBe(false);
    expect(result.outcomes).toHaveLength(2);
  });

  it('captures stdout, stderr, and the exit code', async () => {
    const result = await runChecks(
      configAt({ mixed: { command: ['node', '-e', 'console.log("out"); console.error("err")'] } }),
    );
    const outcome = result.outcomes[0];

    expect(outcome?.stdout).toContain('out');
    expect(outcome?.stderr).toContain('err');
    expect(outcome?.exitCode).toBe(0);
    expect(outcome?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a failure without throwing', async () => {
    const result = await runChecks(configAt({ broken: fail('nope') }));

    expect(result.ok).toBe(false);
    expect(result.outcomes[0]?.passed).toBe(false);
    expect(result.outcomes[0]?.exitCode).toBe(1);
  });

  describe('the mandatory halt', () => {
    it('stops after a mandatory failure', async () => {
      const started: string[] = [];
      await runChecks(
        configAt({ first: fail('boom'), second: pass('never'), third: pass('also never') }),
        { onStart: (name) => started.push(name) },
      );

      expect(started).toEqual(['first']);
    });

    it('marks the skipped checks rather than dropping them', async () => {
      const result = await runChecks(configAt({ first: fail('x'), second: pass('y') }));
      const skipped = result.outcomes.filter((o) => o.skipped === true);

      expect(skipped).toHaveLength(1);
      expect(skipped[0]?.name).toBe('second');
    });

    it('sets halted on the result', async () => {
      const result = await runChecks(configAt({ first: fail('x'), second: pass('y') }));
      expect(result.halted).toBe(true);
    });
  });

  describe('optional checks', () => {
    it('continues past an optional failure', async () => {
      const started: string[] = [];
      const result = await runChecks(
        configAt({ flaky: { ...fail('meh'), optional: true }, important: pass('ok') }),
        { onStart: (name) => started.push(name) },
      );

      expect(started).toEqual(['flaky', 'important']);
      // An optional failure does not make the run fail.
      expect(result.ok).toBe(true);
      expect(result.outcomes[0]?.passed).toBe(false);
    });

    it('still records the failure', async () => {
      const result = await runChecks(configAt({ flaky: { ...fail('meh'), optional: true } }));
      expect(result.outcomes[0]?.passed).toBe(false);
    });

    it('halts when a mandatory check follows an optional failure', async () => {
      const started: string[] = [];
      await runChecks(
        configAt({ flaky: { ...fail('meh'), optional: true }, critical: fail('stop') }),
        { onStart: (name) => started.push(name) },
      );

      expect(started).toEqual(['flaky', 'critical']);
    });
  });

  describe('selection', () => {
    it('runs only the named checks', async () => {
      const started: string[] = [];
      await runChecks(configAt({ a: pass('a'), b: pass('b') }), {
        only: ['b'],
        onStart: (name) => started.push(name),
      });

      expect(started).toEqual(['b']);
    });

    it('throws for an unknown check name', async () => {
      await expect(runChecks(configAt({ a: pass('a') }), { only: ['nope'] })).rejects.toThrow(
        /No check named/,
      );
    });
  });

  describe('timeouts', () => {
    it('reports a timeout as a failure', async () => {
      const result = await runChecks(
        configAt({
          slow: { command: ['node', '-e', 'setTimeout(()=>{}, 10000)'], timeoutMs: 300 },
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.outcomes[0]?.timedOut).toBe(true);
    });
  });

  describe('shell safety', () => {
    it('does not interpret metacharacters in an argument', async () => {
      // The marker must appear in the child's argv, and nothing else must run.
      const result = await runChecks(
        configAt({
          echo: {
            command: ['node', '-e', 'process.stdout.write(process.argv[1] ?? "")', '; rm -rf /'],
          },
        }),
      );

      expect(result.outcomes[0]?.stdout).toBe('; rm -rf /');
    });
  });

  it('rejects an empty command', async () => {
    await expect(runChecks(configAt({ empty: { command: [] } }))).rejects.toThrow(CheckError);
  });

  it('streams output through onOutput', async () => {
    const chunks: string[] = [];
    await runChecks(configAt({ chatty: pass('hello') }), {
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join('')).toContain('hello');
  });
});

describe('assertChecksPassed', () => {
  it('does nothing when everything passed', () => {
    const result = { outcomes: [], ok: true, halted: false, totalDurationMs: 0 };
    expect(() => assertChecksPassed(result)).not.toThrow();
  });

  it('throws CHECK_FAILED naming the failing check', async () => {
    const result = await runChecks(configAt({ tests: fail('assertion failed') }));

    try {
      assertChecksPassed(result);
      expect.unreachable('should have thrown');
    } catch (error) {
      const checkError = error as CheckError;
      expect(checkError.code).toBe('CHECK_FAILED');
      expect(checkError.message).toContain('tests');
      expect(checkError.remediation).toMatch(/optional/);
    }
  });

  it('reports the skipped checks so the user knows what did not run', async () => {
    const result = await runChecks(configAt({ first: fail('x'), second: pass('y') }));

    try {
      assertChecksPassed(result);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CheckError).detail?.['skipped']).toEqual(['second']);
    }
  });

  it('throws CHECK_TIMEOUT for a timed-out check', async () => {
    const result = await runChecks(
      configAt({ slow: { command: ['node', '-e', 'setTimeout(()=>{}, 10000)'], timeoutMs: 250 } }),
    );

    try {
      assertChecksPassed(result);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CheckError).code).toBe('CHECK_TIMEOUT');
    }
  });

  it('does not throw when only optional checks failed', async () => {
    const result = await runChecks(configAt({ flaky: { ...fail('x'), optional: true } }));
    expect(() => assertChecksPassed(result)).not.toThrow();
  });
});

describe('summarize', () => {
  it('counts passed checks', async () => {
    const result = await runChecks(configAt({ a: pass('a'), b: pass('b') }));
    expect(summarize(result)).toContain('2 passed');
  });

  it('counts failures and skips', async () => {
    const result = await runChecks(
      configAt({ first: fail('x'), second: pass('y'), third: pass('z') }),
    );
    const text = summarize(result);

    expect(text).toContain('1 failed');
    expect(text).toContain('2 skipped');
  });

  it('includes a duration', async () => {
    const result = await runChecks(configAt({ a: pass('a') }));
    expect(summarize(result)).toMatch(/[\d.]+s$/);
  });
});
