import { describe, expect, it } from 'vitest';

import {
  Symbols,
  createConsole,
  createPalette,
  shouldUseColor,
  type Console,
} from '../../src/ui/theme.js';

/** Collect everything written, so output can be asserted without a TTY. */
function capture(): { console: Console; out: () => string; err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    console: createConsole({
      write: (t) => stdout.push(t),
      writeError: (t) => stderr.push(t),
    }),
    out: () => stdout.join(''),
    err: () => stderr.join(''),
  };
}

describe('createPalette', () => {
  it('is the identity function for every helper when disabled', () => {
    const p = createPalette(false);

    expect(p.bold('x')).toBe('x');
    expect(p.dim('x')).toBe('x');
    expect(p.gold('x')).toBe('x');
    expect(p.green('x')).toBe('x');
    expect(p.red('x')).toBe('x');
    expect(p.cyan('x')).toBe('x');
  });

  it('wraps text in ANSI codes when enabled', () => {
    const p = createPalette(true);

    expect(p.gold('x')).toBe('\u001b[33mx\u001b[0m');
    expect(p.green('x')).toBe('\u001b[32mx\u001b[0m');
    expect(p.dim('x')).toBe('\u001b[2mx\u001b[0m');
  });

  it('produces no ANSI codes when disabled, for clean piping', () => {
    const p = createPalette(false);
    expect(p.gold('anything')).not.toContain('\u001b');
  });
});

describe('shouldUseColor', () => {
  it('is true for a TTY by default', () => {
    expect(shouldUseColor({}, true)).toBe(true);
  });

  it('is false without a TTY, so piped output stays clean', () => {
    expect(shouldUseColor({}, false)).toBe(false);
  });

  it('NO_COLOR wins over a TTY', () => {
    expect(shouldUseColor({ NO_COLOR: '1' }, true)).toBe(false);
  });

  it('FORCE_COLOR wins over a non-TTY', () => {
    expect(shouldUseColor({ FORCE_COLOR: '1' }, false)).toBe(true);
  });

  it('NO_COLOR still wins over FORCE_COLOR', () => {
    // A user who set NO_COLOR wants plain text regardless of how output is piped.
    expect(shouldUseColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('FORCE_COLOR=0 does not force colour', () => {
    expect(shouldUseColor({ FORCE_COLOR: '0' }, false)).toBe(false);
  });

  it('treats an empty NO_COLOR as unset', () => {
    // `NO_COLOR=` exported by a wrapper should not disable colour.
    expect(shouldUseColor({ NO_COLOR: '' }, true)).toBe(true);
  });

  it('treats an empty FORCE_COLOR as unset', () => {
    expect(shouldUseColor({ FORCE_COLOR: '' }, false)).toBe(false);
  });

  it('treats a whitespace-only NO_COLOR as unset', () => {
    expect(shouldUseColor({ NO_COLOR: '   ' }, true)).toBe(true);
  });

  it('honours NO_COLOR=1 over FORCE_COLOR=1', () => {
    expect(shouldUseColor({ NO_COLOR: '1', FORCE_COLOR: '1' }, true)).toBe(false);
  });

  it('still honours NO_COLOR=0 as a deliberate opt-out', () => {
    expect(shouldUseColor({ NO_COLOR: '0' }, true)).toBe(false);
  });
});

describe('console output', () => {
  it('renders a success with the pass glyph', () => {
    const { console, out } = capture();

    console.success('Tests passed');

    expect(out()).toBe(`${Symbols.pass} Tests passed\n`);
  });

  it('renders a failure with the fail glyph', () => {
    const { console, err } = capture();

    console.failure('Tests failed');

    expect(err()).toBe(`${Symbols.fail} Tests failed\n`);
  });

  it('sends failures to stderr, not stdout', () => {
    const { console, out, err } = capture();

    console.failure('boom');

    expect(out()).toBe('');
    expect(err()).not.toBe('');
  });

  it('sends warnings to stderr', () => {
    const { console, out, err } = capture();

    console.warning('careful');

    expect(out()).toBe('');
    expect(err()).toContain(Symbols.warn);
  });

  it('indents details', () => {
    const { console, out } = capture();

    console.detail('nested');

    expect(out()).toBe('  nested\n');
  });

  it('prefixes and suffixes headings with a blank line', () => {
    const { console, out } = capture();

    console.heading('Checks');

    expect(out()).toBe('\nChecks\n');
  });

  it('writes plain lines undecorated', () => {
    const { console, out } = capture();

    console.line('exactly this');

    expect(out()).toBe('exactly this\n');
  });

  it('emits an empty line for line() with no argument', () => {
    const { console, out } = capture();

    console.line();

    expect(out()).toBe('\n');
  });

  it('renders blank() as a single newline', () => {
    const { console, out } = capture();

    console.blank();

    expect(out()).toBe('\n');
  });

  it('renders a rule', () => {
    const { console, out } = capture();

    console.rule();

    expect(out()).toContain('\u2500');
  });

  it('renders a step with its status', () => {
    const { console, out } = capture();

    console.step('npm publish', 'published');

    expect(out()).toContain('npm publish');
    expect(out()).toContain('published');
  });
});

describe('colour integration', () => {
  it('colours output when a palette is supplied', () => {
    const stdout: string[] = [];
    const console = createConsole({
      write: (t) => stdout.push(t),
      palette: createPalette(true),
    });

    console.success('ok');

    expect(stdout.join('')).toContain('\u001b[');
  });

  it('emits no escape sequences with the default palette', () => {
    const { console, out, err } = capture();

    console.success('a');
    console.failure('b');
    console.heading('c');
    console.detail('d');
    console.rule();

    expect(out()).not.toContain('\u001b');
    expect(err()).not.toContain('\u001b');
  });
});
