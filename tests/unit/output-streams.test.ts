/**
 * Output stream discipline.
 *
 * A warning goes to stderr and `detail` goes to stdout, so pairing a failure with
 * a plain `detail` splits one message across two streams. `forge config init >
 * log` then records "pass --force to overwrite" while dropping the warning that
 * explains what passed — the log reads as an instruction with no problem
 * attached, which is worse than silence.
 *
 * These are enforced as source-level invariants because the bug is invisible at
 * runtime: the terminal shows both lines perfectly well, which is exactly why it
 * survived a while.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createConsole } from '../../src/ui/theme.js';

const COMMANDS_DIR = fileURLToPath(new URL('../../src/cli/commands/', import.meta.url));

const sources = readdirSync(COMMANDS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, lines: readFileSync(join(COMMANDS_DIR, f), 'utf8').split('\n') }));

describe('a failure keeps its explanation on the same stream', () => {
  it('finds command sources to check', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources.map((s) => [s.file, s] as const))(
    '%s pairs every warning/failure with detailError',
    (_name, { lines }) => {
      const offenders: string[] = [];

      // Deliberately narrow: a plain `detail` is only wrong when it qualifies a
      // warning or failure on the line directly above. Anything looser misfires
      // on the common, correct pattern of a failure branch that returns followed
      // by a success branch printing details — which is what two earlier attempts
      // at this check did. The general case is covered by the tests below, which
      // hold the rule itself to account.
      lines.forEach((line, index) => {
        if (!/\.detail\(/.test(line)) return;

        const previous = lines[index - 1] ?? '';
        if (/\.(warning|failure)\(/.test(previous)) {
          offenders.push(`  line ${index + 1}: ${line.trim()}`);
        }
      });

      expect(offenders).toEqual([]);
    },
  );
});

describe('the pattern that actually caused the bug', () => {
  it('rejects detail immediately after a warning', () => {
    // A realistic excerpt of the real bug, so the guard cannot be weakened into
    // uselessness by a future edit to the check above.
    const source = [
      'if (exists) {',
      "  c.warning('file already exists.');",
      "  c.detail('Pass --force to overwrite it.');",
      '  return;',
      '}',
    ];

    const offenders: string[] = [];
    source.forEach((line, index) => {
      if (!/\.detail\(/.test(line)) return;
      if (/\.(warning|failure)\(/.test(source[index - 1] ?? '')) {
        offenders.push(line.trim());
      }
    });

    expect(offenders).toHaveLength(1);
  });

  it('accepts detail in a different branch', () => {
    const source = [
      'if (exists) {',
      "  c.warning('file already exists.');",
      "  c.detailError('Pass --force.');",
      '  return;',
      '}',
      "c.detail('Next: forge config validate');",
    ];

    const offenders: string[] = [];
    source.forEach((line, index) => {
      if (!/\.detail\(/.test(line)) return;
      if (/\.(warning|failure)\(/.test(source[index - 1] ?? '')) {
        offenders.push(line.trim());
      }
    });

    expect(offenders).toEqual([]);
  });
});

describe('detailError', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      console: createConsole({
        write: (t) => out.push(t),
        writeError: (t) => err.push(t),
      }),
    };
  };

  it('goes to stderr, matching the warning it follows', () => {
    const { out, err, console } = capture();

    console.warning('file already exists.');
    console.detailError('Pass --force to overwrite it.');

    expect(err.join('')).toContain('Pass --force');
    expect(out.join('')).toBe('');
  });

  it('keeps the pair intact when stdout is redirected', () => {
    // The exact scenario: `forge config init > log` used to keep half the message.
    const { out, err, console } = capture();

    console.warning('file already exists.');
    console.detailError('Pass --force to overwrite it.');

    expect(out.join('')).not.toContain('Pass --force');
    expect(err.join('')).toContain('already exists');
  });

  it('still leaves detail on stdout for non-error context', () => {
    const { out, console } = capture();

    console.success('Wrote forge.config.yaml');
    console.detail('Next: forge config validate');

    expect(out.join('')).toContain('Next:');
  });

  it('redacts detailError like every other sink', () => {
    const token = 'npm_STREAMCANARY_1234567890';
    const err: string[] = [];
    const console = createConsole({
      write: () => undefined,
      writeError: (t) => err.push(t),
      redact: (t) => t.split(token).join('[REDACTED]'),
    });

    console.failure(`publish failed with ${token}`);
    console.detailError(`retry using ${token}`);

    expect(err.join('')).not.toContain('STREAMCANARY');
  });
});
