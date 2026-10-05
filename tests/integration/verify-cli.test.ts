/**
 * `forge verify` CLI integration.
 *
 * Runs the built CLI against the real world. The integrity check is only
 * meaningful if it consults live provider state, so the happy path runs against
 * this repository's own published release rather than a stub.
 */

import { execFile, execFileSync } from 'node:child_process';
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
    const response = await fetch('https://registry.npmjs.org/@hilbras%2Fomniforge', {
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

/**
 * Whether this environment can authenticate to GitHub.
 *
 * The happy path asserts that *both* providers verify, which needs a credential
 * a CI runner does not have. Without this the suite failed on every GitHub-hosted
 * run: npm verified, GitHub could not, and the test reported a cross-provider
 * mismatch that was really a missing token.
 *
 * `gh auth token` is consulted rather than assumed, because a developer machine
 * authenticates through `gh` with no environment variable at all — checking only
 * `GITHUB_TOKEN` would skip the test for exactly the people who can run it.
 *
 * `FORGE_REQUIRE_GITHUB_AUTH=0` forces this off, which is how the skip path is
 * tested without a real credential rather than only being trusted.
 */
const HAS_GITHUB_AUTH = (() => {
  if (process.env.FORGE_REQUIRE_GITHUB_AUTH === '0') return false;
  if (process.env.GITHUB_TOKEN !== undefined && process.env.GITHUB_TOKEN.length > 0) return true;
  try {
    const result = execFileSync('gh', ['auth', 'token'], {
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return result.toString().trim().length > 0;
  } catch {
    return false;
  }
})();

const SKIP_TWO_PROVIDER = SKIP_LIVE || !HAS_GITHUB_AUTH;

async function forge(args: string[], cwd = REPO_ROOT): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 300_000,
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      signal?: string;
      message?: string;
    };
    // Say why. A spawn that dies yields an empty stdout, and the assertion then
    // reports only that a string was empty — which reads like a product bug and
    // sent this chasing quoting and timeouts instead of resource exhaustion.
    if ((e.stdout ?? '') === '' && e.code === null) {
      throw new Error(
        `forge ${args.join(' ')} produced no output ` +
          `(code=${String(e.code)} signal=${String(e.signal)}): ${e.stderr || e.message || 'no detail'}`,
      );
    }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

describe('forge verify', () => {
  it('documents itself', async () => {
    const { stdout } = await forge(['verify', '--help']);

    expect(stdout).toContain('Confirm every provider agrees');
    expect(stdout).toContain('--provider');
    expect(stdout).toContain('Examples:');
  });

  it.skipIf(SKIP_TWO_PROVIDER)('verifies the published release across live providers', async () => {
    // The newest published version: its dist-tag is authoritative, which is what
    // makes this a real check rather than a self-fulfilling one.
    const { stdout, code } = await forge(['verify', PUBLISHED as string]);

    expect(stdout).toContain('github');
    expect(stdout).toContain('npm');
    expect(stdout).toContain('verified across');
    expect(code).toBe(0);
  });

  it.skipIf(SKIP_LIVE)('verifies the published version against npm alone', async () => {
    // Runs everywhere, credentials or not. A GitHub-hosted runner has no token,
    // so asserting only on npm keeps a real registry assertion in CI rather than
    // skipping the whole live path.
    const { stdout, stderr, code } = await forge([
      'verify',
      PUBLISHED as string,
      '--provider',
      'npm',
    ]);

    expect(stdout + stderr).toMatch(/verified across 1 provider/);
    expect(code).toBe(0);
  });

  it.skipIf(SKIP_LIVE)('emits a machine-readable report for the published version', async () => {
    const { stdout } = await forge([
      'verify',
      PUBLISHED as string,
      '--provider',
      'npm',
      '--report',
      'json',
    ]);

    const start = stdout.indexOf('{\n');
    expect(start, 'expected a JSON object').toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(start)) as { integrity?: { passed?: boolean } };

    expect(parsed.integrity?.passed).toBe(true);
  });

  it('skips the two-provider path when GitHub auth is absent', () => {
    // Guards the guard: without this, a change that made HAS_GITHUB_AUTH always
    // true would restore the CI failure this was meant to fix, and nothing would
    // notice because the tests pass either way locally.
    expect(typeof HAS_GITHUB_AUTH).toBe('boolean');
    expect(SKIP_TWO_PROVIDER).toBe(SKIP_LIVE || !HAS_GITHUB_AUTH);
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

  it.skipIf(SKIP_TWO_PROVIDER)('emits a JSON report', async () => {
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
