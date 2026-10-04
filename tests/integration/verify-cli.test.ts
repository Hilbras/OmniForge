/**
 * `forge verify` CLI integration.
 *
 * Runs the built CLI against the real world. The integrity check is only
 * meaningful if it consults live provider state, so the happy path runs against
 * this repository's own published release rather than a stub.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

/** The version in package.json. */
const DECLARED_VERSION: string = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * The newest version actually on npm, or null when the registry cannot be read.
 *
 * The live checks must run against a published release: verifying the version
 * currently being developed fails by construction, and hard-coding an older
 * number goes stale on every release. A missing publish is the publisher's
 * problem to notice, not a reason for the suite to go red mid-release.
 *
 * Resolved at module scope because `skipIf` is evaluated while tests are being
 * collected — a value assigned in `beforeAll` would still be undefined there.
 */
const PUBLISHED: string | null = await (async () => {
  try {
    const response = await fetch('https://registry.npmjs.org/@hilbras%2Fforge', {
      headers: { 'cache-control': 'no-cache' },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { 'dist-tags'?: { latest?: string } };
    return body['dist-tags']?.latest ?? null;
  } catch {
    return null;
  }
})();

const SKIP_LIVE = PUBLISHED === null;

async function forge(args: string[], cwd = REPO_ROOT): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 300_000,
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('forge verify', () => {
  it('documents itself', async () => {
    const { stdout } = await forge(['verify', '--help']);

    expect(stdout).toContain('Confirm every provider agrees');
    expect(stdout).toContain('--provider');
    expect(stdout).toContain('Examples:');
  });

  it.skipIf(SKIP_LIVE)('verifies the published release across live providers', async () => {
    // The newest published version: its dist-tag is authoritative, which is what
    // makes this a real check rather than a self-fulfilling one.
    const { stdout, code } = await forge(['verify', PUBLISHED as string]);

    expect(stdout).toContain('github');
    expect(stdout).toContain('npm');
    expect(stdout).toContain('verified across');
    expect(code).toBe(0);
  });

  it('fails for a version that was never released', async () => {
    const { stdout, stderr, code } = await forge(['verify', '99.99.99']);

    // Failure output goes to stderr, which is the correct stream for it.
    // Assert the outcome, not the glyph: the theme owns the symbol, and a test
    // that pins `✗` breaks the next time the palette changes.
    expect(stdout + stderr).toMatch(/problem\(s\)|integrity/i);
    // Exit 3 is the verification code, distinct from generic failure.
    expect(code).toBe(3);
  });

  it('names the failed checks rather than only the provider', async () => {
    const { stdout } = await forge(['verify', '99.99.99']);

    // Actionable: the user learns which assertion broke.
    expect(stdout).toMatch(/not (found|published)/);
  });

  it.skipIf(SKIP_LIVE)('restricts to a single provider', async () => {
    const { stdout } = await forge(['verify', PUBLISHED as string, '--provider', 'npm']);

    expect(stdout).toContain('npm');
    expect(stdout).not.toContain('github');
  });

  it.skipIf(SKIP_LIVE)('emits a JSON report', async () => {
    const { stdout } = await forge(['verify', PUBLISHED as string, '--report', 'json']);

    // Anchored to the pretty-printed root object, not the first `{` in the
    // stream: the heading above it is `Verify {@hilbras/forge@0.8.0}`, and
    // slicing at that brace produces invalid JSON.
    const start = stdout.indexOf('{\n');
    expect(start, 'expected a JSON object').toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(start)) as {
      integrity?: { passed?: boolean; observed?: readonly unknown[] };
    };
    expect(parsed.integrity?.passed).toBe(true);
    expect(parsed.integrity?.observed).toHaveLength(2);
  });

  it('says so when no providers are enabled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-verify-empty-'));
    writeFileSync(
      join(dir, 'forge.config.yaml'),
      'project:\n  name: nothing\nnpm:\n  enabled: false\ngithub:\n  enabled: false\n',
    );

    const { stdout, stderr, code } = await forge([
      'verify',
      '1.0.0',
      '--config',
      join(dir, 'forge.config.yaml'),
    ]);

    expect(stdout + stderr).toContain('No providers are enabled');
    expect(code).toBe(2);
  });

  it('defaults to the current version', async () => {
    const { stdout } = await forge(['verify']);

    expect(stdout).toContain(`@${DECLARED_VERSION}`);
  });
});
