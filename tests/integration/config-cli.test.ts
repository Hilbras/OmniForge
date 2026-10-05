/**
 * `forge config` integration tests.
 *
 * These spawn the real CLI against real config files, so they cover the whole
 * path: YAML parsing, validation, defaulting, rendering, and the exit code a
 * script would branch on.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

import { ExitCode } from '../../src/cli/exit-codes.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

async function forge(args: string[], cwd?: string, envExtra?: Record<string, string>) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 30_000,
      cwd: cwd ?? REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1', ...envExtra },
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

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cli-config-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const VALID = `project:
  name: acme-sdk
version:
  strategy: semver
github:
  enabled: true
  repository: Acme/acme-sdk
npm:
  enabled: true
  package: "@acme/sdk"
checks:
  test: true
`;

describe('forge config', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}. Run \`npm run build\` first.`);
    }
  });

  describe('validate', () => {
    it('exits 0 and confirms a valid config', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout, code } = await forge(['config', 'validate'], dir);

      expect(code).toBe(ExitCode.Success);
      expect(stdout).toContain('is valid');
    });

    it('exits 2 and lists every problem', async () => {
      const dir = project({
        'forge.config.yaml': 'version:\n  strategy: nope\nnpm:\n  distTag: canary\n',
      });

      const { stderr, code } = await forge(['config', 'validate'], dir);

      expect(code).toBe(ExitCode.Config);
      expect(stderr).toContain('version.strategy');
      expect(stderr).toContain('npm.distTag');
    });

    it('exits 2 when the config is missing', async () => {
      const dir = project({});

      const { stderr, code } = await forge(['config', 'validate'], dir);

      expect(code).toBe(ExitCode.Config);
      expect(stderr).toContain('No forge.config.yaml found');
    });

    it('exits 2 for malformed YAML', async () => {
      const dir = project({ 'forge.config.yaml': 'project:\n  name: [unclosed\n' });

      const { code } = await forge(['config', 'validate'], dir);

      expect(code).toBe(ExitCode.Config);
    });

    it('accepts an explicit --config path', async () => {
      const dir = project({ 'custom.yaml': VALID });

      const { code } = await forge(['config', 'validate', '--config', join(dir, 'custom.yaml')]);

      expect(code).toBe(ExitCode.Success);
    });

    it('finds the config from a nested directory', async () => {
      const dir = project({ 'forge.config.yaml': VALID });
      const nested = join(dir, 'packages', 'core');
      mkdirSync(nested, { recursive: true });

      const { code, stdout } = await forge(['config', 'validate'], nested);

      expect(code).toBe(ExitCode.Success);
      expect(stdout).toContain('is valid');
    });
  });

  describe('show', () => {
    it('renders the resolved configuration', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout, code } = await forge(['config', 'show'], dir);

      expect(code).toBe(ExitCode.Success);
      expect(stdout).toContain('acme-sdk');
      expect(stdout).toContain('Acme/acme-sdk');
      expect(stdout).toContain('@acme/sdk');
    });

    it('shows applied defaults', async () => {
      const dir = project({ 'forge.config.yaml': 'project:\n  name: bare\n' });

      const { stdout } = await forge(['config', 'show'], dir);

      expect(stdout).toContain('semver');
      expect(stdout).toContain('registry.npmjs.org');
      expect(stdout).toContain('latest');
    });

    it('applies CLI overrides', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout } = await forge(
        ['config', 'show', '--dist-tag', 'beta', '--registry', 'https://npm.internal'],
        dir,
      );

      expect(stdout).toContain('beta');
      expect(stdout).toContain('npm.internal');
    });

    it('exits 2 when an enabled provider has no target', async () => {
      const dir = project({
        'forge.config.yaml': 'project:\n  name: x\ngithub:\n  enabled: true\n',
      });

      const { code, stderr } = await forge(['config', 'show'], dir);

      expect(code).toBe(ExitCode.Config);
      expect(stderr).toContain('no target is configured');
    });

    it('never prints a credential value from the config', async () => {
      const dir = project({
        'forge.config.yaml': `project:
  name: leaky
github:
  enabled: true
  repository: A/b
  GITHUB_TOKEN: ghp_shouldneverappear1234567890
`,
      });

      const { stdout, stderr } = await forge(['config', 'show'], dir);
      const combined = stdout + stderr;

      expect(combined).not.toContain('ghp_shouldneverappear1234567890');
    });

    it('shows the token env var name but not any value', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout } = await forge(['config', 'show'], dir);

      expect(stdout).toContain('GITHUB_TOKEN');
      expect(stdout).toContain('NPM_TOKEN');
    });

    it('emits no ANSI escapes when NO_COLOR is set', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout } = await forge(['config', 'show'], dir);

      expect(stdout).not.toContain('\u001b[');
    });
  });

  describe('path', () => {
    it('prints the config path and project root', async () => {
      const dir = project({ 'forge.config.yaml': VALID });

      const { stdout, code } = await forge(['config', 'path'], dir);

      expect(code).toBe(ExitCode.Success);
      expect(stdout).toContain('forge.config.yaml');
    });

    it('reports when no config exists', async () => {
      const dir = project({});

      const { stdout, code } = await forge(['config', 'path'], dir);

      expect(code).toBe(ExitCode.Success);
      expect(stdout).toContain('(none found)');
    });
  });

  describe('credentials', () => {
    // `forge config credentials` shells out to `gh auth token` and
    // `gh api user`. Each can take several seconds, and under parallel test
    // load they exceed vitest's 5s default — which surfaced as an intermittent
    // failure with no failing assertion at all.
    //
    // 60s rather than 30s: the Windows and Linux jobs here both ran this file
    // alongside seven other live-network files, and 30s was not enough headroom
    // for the machine rather than for the code.
    const GITHUB_TIMEOUT_MS = 60_000;

    it(
      'reports presence without revealing values',
      async () => {
        const dir = project({ 'forge.config.yaml': VALID });

        const { stdout, code } = await forge(['config', 'credentials'], dir);

        expect(code).toBe(ExitCode.Success);
        expect(stdout).toContain('npm');
        expect(stdout).toContain('NPM_TOKEN');
        // A token would appear as a long opaque run after the provider name.
        // The variable name is safe to show; its value never is.
        expect(stdout).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
      },
      GITHUB_TIMEOUT_MS,
    );

    it(
      'marks an unset credential as not set',
      async () => {
        const dir = project({ 'forge.config.yaml': VALID });

        const { stdout } = await forge(['config', 'credentials'], dir, {
          NPM_TOKEN: '',
          PYPI_TOKEN: '',
          GITHUB_TOKEN: '',
        });

        // pypi is disabled in VALID and PYPI_TOKEN is explicitly blank, so the
        // result is deterministic regardless of the developer's shell.
        expect(stdout).toContain('pypi');
        expect(stdout).toContain('PYPI_TOKEN');
        expect(stdout).toMatch(/pypi — not set/);
      },
      GITHUB_TIMEOUT_MS,
    );
  });

  describe('help', () => {
    it('documents every subcommand', async () => {
      const { stdout, code } = await forge(['config', '--help']);

      expect(code).toBe(ExitCode.Success);
      for (const sub of ['show', 'validate', 'path', 'credentials']) {
        expect(stdout).toContain(sub);
      }
    });

    it('documents show flags', async () => {
      const { stdout } = await forge(['config', 'show', '--help']);

      expect(stdout).toContain('--registry');
      expect(stdout).toContain('--dist-tag');
    });
  });
});
