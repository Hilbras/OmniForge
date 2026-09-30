/**
 * Architecture tests.
 *
 * These enforce the structural rules from the spec as executable assertions, so
 * a violation fails CI rather than relying on a reviewer to notice. The spec
 * (§4.1) requires that Core contain no platform-specific logic; the only reliable
 * way to keep that true as the codebase grows is to test for it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
      const rel = relative(SRC, file);
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/from\s+'([^']+)'/g)]
        .map((m) => ({ rel, target: m[1] ?? '' }))
        .filter((i) => i.target.includes('providers/'));
    });

    it('does not import concrete provider implementations', () => {
      // The registry resolves providers by name at runtime. A direct import of a
      // provider from Core is exactly the coupling §4.1 forbids.
      expect(imports).toEqual([]);
    });

    it('contains no platform name literals in conditional logic', () => {
      const offenders: string[] = [];
      for (const file of files) {
        const rel = relative(SRC, file);
        const source = readFileSync(file, 'utf8');
        // Match a platform token inside a string literal used in a comparison
        // or switch — a mention in prose comments or config keys is fine.
        const pattern = new RegExp(
          `(===|!==|==|!=|case\\s+|includes\\()\\s*['"\`](${PLATFORM_TOKENS.join('|')})['"\`]`,
          'gi',
        );
        if (pattern.test(source)) offenders.push(rel);
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
      const rel = relative(SRC, file);
      // The definition itself, and the two composition roots.
      if (rel === 'index.ts' || rel.startsWith('cli/') || rel === 'core/registry.ts') return false;
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
      const rel = relative(SRC, file);
      if (rel === 'index.ts' || rel.startsWith('cli/') || rel.startsWith('providers/')) continue;
      if (/new\s+[A-Z]\w*Provider\s*\(/.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
