/**
 * Package manifest guards.
 *
 * A NUL character anywhere in a published file makes npm reject the whole
 * upload with `E400 ... contains an unsupported NUL character`. That is a
 * confusing failure for what looks like a corrupted character in one README
 * line, and it is only discovered at publish time — after a version number is
 * spent and a release commit exists.
 *
 * These assertions run on every `npm test`, so the same defect is caught by CI
 * on a pull request rather than by a failed publish.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolveProgram } from '../../src/build/exec.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const NUL = 0;

/** Directories that are not part of the published artifact. */
const IGNORED = new Set(['node_modules', 'dist', 'coverage', '.git', '.next']);

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe('the package manifest', () => {
  it('names the package OmniForge', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      name: string;
    };

    expect(manifest.name).toBe('@hilbras/omniforge');
  });

  it('points every URL at the OmniForge repository', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      homepage?: string;
      repository?: { url?: string };
      bugs?: { url?: string };
    };

    for (const [label, url] of Object.entries({
      homepage: manifest.homepage,
      repository: manifest.repository?.url,
      bugs: manifest.bugs?.url,
    })) {
      expect(url, label).toBeDefined();
      expect(url, label).toContain('Hilbras/OmniForge');
      expect(url, label).not.toContain('hilbras-forge');
    }
  });

  it('contains no NUL byte in any shipped file', () => {
    // npm rejects the entire upload over a single NUL, so this sweeps the tree
    // rather than checking the manifest alone.
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      if (file.endsWith('.tgz') || file.endsWith('.png') || file.endsWith('.ico')) continue;
      if (readFileSync(file).includes(NUL)) offenders.push(relative(ROOT, file));
    }

    expect(offenders).toEqual([]);
  });

  // npm pack takes ~50s under parallel load, which exceeds vitest's 5s default.
  it('is publishable as a dry run', { timeout: 240_000 }, () => {
    // The real check npm makes. Slower than the assertions above, but it is the
    // only one that cannot be fooled by something npm treats specially.
    const result = execFileSync(resolveProgram('npm'), ['pack', '--dry-run', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(result) as {
      name: string;
      version: string;
      files: unknown[];
    }[];
    const packed = parsed[0];

    expect(packed, 'npm pack produced no output').toBeDefined();
    expect(packed?.name).toBe('@hilbras/omniforge');
    expect(packed?.files.length ?? 0).toBeGreaterThan(0);
  });
});
