/**
 * Architecture tests.
 *
 * These enforce the structural rules from the spec as executable assertions, so
 * a violation fails CI rather than relying on a reviewer to notice. The spec
 * (§4.1) requires that Core contain no platform-specific logic; the only reliable
 * way to keep that true as the codebase grows is to test for it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Recursively collect `.ts` source files under a directory. */
function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collect(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ALL_SRC = collect(SRC);

/**
 * Remove comments from TypeScript source.
 *
 * A deliberately simple lexer rather than a regex over the whole file: it walks
 * the text tracking whether it is inside a string, template literal, or comment,
 * so a `//` inside a string literal does not truncate the rest of the file.
 * Good enough for an architectural guard, and it cannot mis-parse code.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch = source[i] ?? '';

    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const c = source[i] ?? '';
        if (c === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * Files permitted to name or import concrete providers.
 *
 * A composition root exists precisely to wire providers in, so exempting it is
 * the point, not a loophole: every other file must go through the registry by
 * name. Keeping the list explicit means a new provider has to be added here to
 * be importable, which is a deliberate act.
 */
/**
 * Normalise a relative path to forward slashes.
 *
 * `path.relative` returns `core\\default-registry.ts` on Windows, so the
 * allowlists below — written with forward slashes for readability — matched
 * nothing and every file looked like an offender. That is why the architecture
 * test failed on all three Windows jobs while passing on Linux and macOS: the
 * guarantee it enforces was never actually being checked there.
 */
function posixPath(rel: string): string {
  return rel.split(sep).join('/');
}

const COMPOSITION_ROOTS = ['core/default-registry.ts'] as const;

const isCompositionRoot = (rel: string): boolean =>
  (COMPOSITION_ROOTS as readonly string[]).includes(rel);

/**
 * Files allowed to import a concrete provider.
 *
 * A composition root wires providers in, and a command module is the user-facing
 * surface for one provider, so `forge github` importing the GitHub provider is
 * the intended shape — that is the command *for* that platform, not Core.
 * Everything else must resolve by name through the registry.
 */
const PROVIDER_IMPORT_EXEMPT = ['cli/commands/github.ts'] as const;

const mayImportProviders = (rel: string): boolean =>
  isCompositionRoot(rel) ||
  (PROVIDER_IMPORT_EXEMPT as readonly string[]).some(
    (allowed) => rel === allowed || rel.startsWith(`${allowed.split('/').slice(0, -1).join('/')}/`),
  );

/** Directories that must stay free of platform-specific logic. */
const PLATFORM_FREE_DIRS = [
  'core',
  'release',
  'cli',
  'version',
  'verification',
  'reporting',
] as const;

/**
 * Platform identifiers that would indicate leakage into the Core.
 *
 * `forge.config.yaml` keys legitimately use these names, so the check is on
 * string literals in logic, not on the mere presence of a provider name in a
 * type. Providers themselves are exempt — they are *supposed* to know.
 */
const PLATFORM_TOKENS = [
  'github',
  'npm',
  'pypi',
  'twine',
  'docker',
  'gitlab',
  'crates',
  'nuget',
] as const;

describe('architecture', () => {
  it('has source files to check', () => {
    expect(ALL_SRC.length).toBeGreaterThan(0);
  });

  describe.each(PLATFORM_FREE_DIRS)('src/%s stays platform-agnostic', (dir) => {
    const dirPath = join(SRC, dir);
    const files = collect(dirPath);
    const imports = files.flatMap((file) => {
      const rel = posixPath(relative(SRC, file));
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+'([^']+)'/g)]
        .map((m) => ({ rel, target: m[1] ?? '' }))
        .filter((i) => i.target.includes('providers/'));
    });

    it('does not import concrete provider implementations', () => {
      // The registry resolves providers by name at runtime. A direct import of a
      // provider from Core is exactly the coupling §4.1 forbids.
      const offenders = imports.filter(({ rel }) => !mayImportProviders(rel));
      expect(offenders).toEqual([]);
    });

    it('contains no platform name literals in conditional logic', () => {
      const offenders: string[] = [];
      for (const file of files) {
        const rel = posixPath(relative(SRC, file));
        // Strip comments before matching: prose legitimately discusses platform
        // names (including comments that explain why they are forbidden here),
        // and only code should be constrained.
        if (isCompositionRoot(rel)) continue;
        const code = stripComments(readFileSync(file, 'utf8'));
        // Match a platform token inside a string literal used in a comparison
        // or switch — a mention in prose or config keys is fine.
        const pattern = new RegExp(
          `(===|!==|==|!=|case\\s+|includes\\()\\s*['"\`](${PLATFORM_TOKENS.join('|')})['"\`]`,
          'gi',
        );
        if (pattern.test(code)) offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });
  });

  it('keeps every module boundary present', () => {
    const expected = [
      'core',
      'providers',
      'release',
      'version',
      'build',
      'verification',
      'configuration',
      'authentication',
      'reporting',
      'errors',
      'utils',
      'cli',
    ];
    for (const name of expected) {
      expect(
        readdirSync(SRC).some((e) => e === name && statSync(join(SRC, name)).isDirectory()),
        `missing src/${name}`,
      ).toBe(true);
    }
  });

  it('gives providers a directory per platform', () => {
    const providers = join(SRC, 'providers');
    expect(readdirSync(providers).some((e) => statSync(join(providers, e)).isDirectory())).toBe(
      true,
    );
  });

  it('does not construct the default registry outside the composition roots', () => {
    // `createDefaultRegistry` is the single composition root. Core must not
    // build one itself; only the library entry point and the CLI may, because
    // those are the two places providers get wired in.
    const offenders = ALL_SRC.filter((file) => {
      const rel = posixPath(relative(SRC, file));
      // The definition itself, the re-export, and the composition roots.
      if (rel === 'index.ts' || rel.startsWith('cli/') || rel === 'core/registry.ts') return false;
      if (isCompositionRoot(rel)) return false;
      // A re-export is not a construction site.
      const source = readFileSync(file, 'utf8');
      return (
        source.includes('createDefaultRegistry') &&
        !/export\s*{[^}]*createDefaultRegistry/.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('never instantiates a concrete provider outside the composition roots', () => {
    // The strongest form of the §4.1 rule: no file outside `src/cli/` and the
    // library entry point may `new` up a provider. Everything else must go
    // through the registry by name.
    const offenders: string[] = [];
    for (const file of ALL_SRC) {
      const rel = posixPath(relative(SRC, file));
      if (rel === 'index.ts' || rel.startsWith('cli/') || rel.startsWith('providers/')) continue;
      if (isCompositionRoot(rel)) continue;
      if (/new\s+[A-Z]\w*Provider\s*\(/.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
