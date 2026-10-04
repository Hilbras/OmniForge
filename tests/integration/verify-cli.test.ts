/**
 * `forge verify` CLI integration.
 *
 * Runs the built CLI against the real world. The integrity check is only
 * meaningful if it consults live provider state, so the happy path runs against
 * this repository's own published release rather than a stub.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

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
  beforeAll(() => {
    expect(execFile).toBeDefined();
  });

  it('documents itself', async () => {
    const { stdout } = await forge(['verify', '--help']);

    expect(stdout).toContain('Confirm every provider agrees');
    expect(stdout).toContain('--provider');
    expect(stdout).toContain('Examples:');
  });

  it('verifies the published release across live providers', async () => {
    // 0.7.0 is the last version on both GitHub and npm, so this must pass — and
    // it exercises two real providers agreeing on nothing, which is the point.
    // Pinned deliberately: verifying the version currently being developed would
    // fail by construction until it ships.
    const { stdout, code } = await forge(['verify', '0.7.0']);

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

  it('restricts to a single provider', async () => {
    const { stdout } = await forge(['verify', '0.7.0', '--provider', 'npm']);

    expect(stdout).toContain('npm');
    expect(stdout).not.toContain('github');
  });

  it('emits a JSON report', async () => {
    const { stdout } = await forge(['verify', '0.7.0', '--report', 'json']);

    // Anchored to the pretty-printed root object, not the first `{` in the
    // stream: the heading above it is `Verify {@hilbras/forge@0.7.0}`, and
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

    expect(stdout).toMatch(/@0\.8\.0|@\d+\.\d+\.\d+/);
  });
});
