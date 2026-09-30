/**
 * CLI smoke tests.
 *
 * These run the real CLI in a child process, so they verify what a user actually
 * experiences — not just what the program object returns. Phase 0 acceptance
 * requires `forge --help` and `forge --version` to work.
 *
 * The tests run the built `dist/` output rather than the TypeScript source:
 * spawning `tsx` per test costs several seconds each and would dominate the
 * suite. A missing build is treated as a failure with a clear message, so the
 * suite cannot silently pass by skipping itself.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

/** Run the CLI and capture output regardless of exit code. */
async function forge(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 30_000,
      cwd: REPO_ROOT,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('forge CLI', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}. Run \`npm run build\` before the tests.`);
    }
  });

  describe('--help', () => {
    it('prints usage and the command list', async () => {
      const { stdout, code } = await forge(['--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('Usage: forge');
      expect(stdout).toContain('Unified release, publishing, versioning');
      expect(stdout).toContain('provider');
    });

    it('documents the global options', async () => {
      const { stdout } = await forge(['--help']);

      expect(stdout).toContain('--version');
      expect(stdout).toContain('--verbose');
      expect(stdout).toContain('-h, --help');
    });
  });

  describe('--version', () => {
    it('prints the package version', async () => {
      const { stdout, code } = await forge(['--version']);

      expect(code).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('matches package.json', async () => {
      const { stdout } = await forge(['--version']);
      const { readFileSync } = await import('node:fs');
      const pkg = JSON.parse(
        readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
      ) as {
        version: string;
      };

      expect(stdout.trim()).toBe(pkg.version);
    });
  });

  describe('provider group', () => {
    it('reports no providers registered rather than failing', async () => {
      const { stdout, code } = await forge(['provider', 'list']);

      expect(code).toBe(0);
      expect(stdout).toContain('No providers registered yet.');
    });

    it('reports capabilities with nothing registered', async () => {
      const { stdout, code } = await forge(['provider', 'capabilities']);

      expect(code).toBe(0);
      expect(stdout).toContain('No providers registered yet.');
    });

    it('has help for the provider group', async () => {
      const { stdout, code } = await forge(['provider', '--help']);

      expect(code).toBe(0);
      expect(stdout).toContain('Usage: forge provider');
      expect(stdout).toContain('list');
      expect(stdout).toContain('capabilities');
    });

    it('has help for provider list', async () => {
      const { stdout } = await forge(['provider', 'list', '--help']);
      expect(stdout).toContain('Usage: forge provider list');
    });
  });

  describe('error handling', () => {
    it('exits non-zero with guidance for an unknown command', async () => {
      const { stderr, code } = await forge(['nonsense']);

      expect(code).not.toBe(0);
      expect(stderr).toContain('unknown command');
    });

    it('exits non-zero for an unknown option', async () => {
      const { code } = await forge(['--bogus-flag']);
      expect(code).not.toBe(0);
    });
  });
});
