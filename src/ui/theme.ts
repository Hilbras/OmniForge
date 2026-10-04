/**
 * Terminal theme.
 *
 * Mirrors the Hilbras design system used by the IDE surface: a gold accent on
 * near-black, dim secondary text, and green/red reserved for pass/fail. The
 * palette and the injectable writer follow the same shape as the Code CLI
 * renderer, so the two tools read as one product.
 *
 * Colour is opt-out three ways: a non-TTY stream, `NO_COLOR`, or `--no-color`.
 * When disabled every helper becomes the identity function, so callers never
 * branch on whether colour is active.
 */

/** Where output goes. Injected so tests capture without a TTY. */
export type Writer = (text: string) => void;

/** The eight helpers Forge uses. Kept small on purpose. */
export interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  gold: (s: string) => string;
  goldBright: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  cyan: (s: string) => string;
}

const identity = (s: string): string => s;

const ESC = '\u001b';

/**
 * Build the palette.
 *
 * @param enabled - When false every helper is the identity function.
 */
export function createPalette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      gold: identity,
      goldBright: identity,
      green: identity,
      red: identity,
      cyan: identity,
    };
  }
  const wrap =
    (code: string) =>
    (s: string): string =>
      `${ESC}[${code}m${s}${ESC}[0m`;

  return {
    bold: wrap('1'),
    dim: wrap('2'),
    gold: wrap('33'),
    goldBright: wrap('93'),
    green: wrap('32'),
    red: wrap('31'),
    cyan: wrap('36'),
  };
}

/** Status marks. `pass`/`fail` match the release spec's expected output. */
export const Symbols = {
  pass: '\u2713',
  fail: '\u2717',
  pending: '\u25cb',
  running: '\u00b7',
  arrow: '\u2192',
  warn: '\u26a0',
} as const;

/**
 * Decide whether to emit colour.
 *
 * `NO_COLOR` wins over everything, including `FORCE_COLOR`, because a user who
 * set it wants plain text regardless of how they piped output.
 *
 * An *empty* value is treated as unset for both variables. `NO_COLOR=` exported
 * by a wrapper script, or `FORCE_COLOR=`, should not silently disable colour —
 * only an actual value counts, matching how the `no-color.org` convention is
 * normally interpreted in practice.
 */
export function shouldUseColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'].trim() !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force.trim() !== '' && force.trim() !== '0') return true;
  return isTTY;
}

/** Console facade. Every CLI message goes through one of these. */
export interface Console {
  readonly palette: Palette;
  /** A plain line, no decoration. */
  line: (text?: string) => void;
  /** Write raw text to stdout, bypassing decoration. */
  writePlain: (text: string) => void;
  /** Write raw text to stderr, bypassing decoration. */
  writeErrorPlain: (text: string) => void;
  /** Section heading: gold, bold, with a leading mark. */
  heading: (text: string) => void;
  /** A completed success. */
  success: (text: string) => void;
  /** A completed failure. Goes to stderr. */
  failure: (text: string) => void;
  /** Something the user should notice but that did not fail. */
  warning: (text: string) => void;
  /** An in-progress or neutral line. */
  info: (text: string) => void;
  /** Indented continuation of the previous line. */
  detail: (text: string) => void;
  /** A named step, e.g. `npm publish`. */
  step: (name: string, status: string) => void;
  blank: () => void;
  /** A thin horizontal rule, matching the web `.hairline`. */
  rule: () => void;
}

export interface ConsoleOptions {
  readonly write: Writer;
  readonly writeError?: Writer;
  readonly palette?: Palette;
  /**
   * Applied to every string the console emits.
   *
   * Redaction lives here rather than at each call site because a sink that
   * redacts is correct for every caller, including ones written later. Provider
   * stderr captured into a `ForgeError` routinely contains the token that was
   * passed on a command line, and that text reaches reports on disk.
   */
  readonly redact?: (text: string) => string;
}

/**
 * Create the console.
 *
 * `write` and `writeError` are injected rather than reaching for `process`, so
 * tests assert on output without a terminal and `forge --report json` can
 * capture stdout without decoration.
 */
export function createConsole(options: ConsoleOptions): Console {
  const p = options.palette ?? createPalette(false);
  const rawError = options.writeError ?? options.write;

  // Every write path funnels through these two functions, so redaction cannot be
  // forgotten by a future caller.
  const redact = options.redact ?? ((text: string) => text);
  const write = (text: string): void => options.write(redact(text));
  const writeErr = (text: string): void => rawError(redact(text));

  return {
    palette: p,
    line: (text = '') => write(`${text}\n`),
    writePlain: (text) => write(text),
    writeErrorPlain: (text) => writeErr(text),
    heading: (text) => write(`\n${p.gold(text)}\n`),
    success: (text) => write(`${p.green(Symbols.pass)} ${text}\n`),
    failure: (text) => writeErr(`${p.red(Symbols.fail)} ${text}\n`),
    warning: (text) => writeErr(`${p.gold(Symbols.warn)} ${text}\n`),
    info: (text) => write(`${text}\n`),
    detail: (text) => write(`${p.dim(`  ${text}`)}\n`),
    step: (name, status) => write(`${p.dim(Symbols.arrow)} ${name} ${p.dim(status)}\n`),
    blank: () => write('\n'),
    rule: () => write(`${p.dim('─'.repeat(48))}\n`),
  };
}
