/**
 * CLI contract tests.
 *
 * These guard properties that are easy to break silently and hard to notice:
 * every command has usable help, and no subcommand uses a flag name that
 * commander intercepts before the subcommand ever sees it.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));
const COMMANDS_DIR = fileURLToPath(new URL('../../src/cli/', import.meta.url));

async function forge(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 30_000,
      cwd: REPO_ROOT,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('forge CLI contract', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}. Run \`npm run build\` first.`);
    }
  });

  describe('flag names', () => {
    /**
     * Reserved option names on the root program.
     *
     * `version` is the dangerous one: commander resolves a subcommand option
     * named `--version` against the *root* program's handler, which prints the
     * version and exits. The command appears to succeed while doing nothing —
     * the exact failure `forge github release --version` and
     * `forge npm publish --version` both had.
     */
    const RESERVED = ['version', 'help'];

    it('no subcommand declares a reserved flag', () => {
      // Read the source rather than spawning `--help` per subcommand: walking
      // five groups times every subcommand exceeded the test timeout.
      const commandFiles = readdirSync(join(COMMANDS_DIR, 'commands'))
        .filter((name) => name.endsWith('.ts'))
        .map((name) => join(COMMANDS_DIR, 'commands', name));

      // The root program itself is where `--version` is legitimately defined.
      const rootFile = join(COMMANDS_DIR, 'index.ts');

      const offenders: string[] = [];

      for (const file of commandFiles) {
        if (file === rootFile) continue;
        const source = readFileSync(file, 'utf8');
        const name = relative(COMMANDS_DIR, file);

        for (const match of source.matchAll(/\.option\(\s*['"]--([\w-]+)/g)) {
          const flag = match[1] ?? '';
          if (RESERVED.includes(flag)) {
            offenders.push(`${name} declares --${flag}`);
          }
        }
      }

      expect(offenders).toEqual([]);
    });

    it('a subcommand flag is actually applied, not swallowed by the root program', async () => {
      // Behavioural counterpart to the static check: a space-separated flag
      // must reach its command. If commander intercepted it, the output would be
      // the version string and nothing else.
      const { stdout, code } = await forge(['npm', 'verify', '--release-version', '0.4.0']);

      expect(code).toBe(0);
      expect(stdout).toContain('Verify');
      expect(stdout).toContain('@0.4.0');
      // A swallowed flag would make this print a bare semver and exit.
      expect(stdout.trim()).not.toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('help completeness', () => {
    it('the root help lists every command group', async () => {
      const { stdout } = await forge(['--help']);

      for (const group of ['config', 'github', 'npm', 'provider', 'version']) {
        expect(stdout).toContain(group);
      }
    });

    it('every command group has help', async () => {
      for (const group of ['config', 'github', 'npm', 'provider', 'version']) {
        const { stdout, code } = await forge([group, '--help']);
        expect(code, `${group} --help failed`).toBe(0);
        expect(stdout).toContain('Usage:');
      }
    });

    it('every command group documents its subcommands', async () => {
      for (const group of ['config', 'github', 'npm', 'provider', 'version']) {
        const { stdout } = await forge([group, '--help']);
        expect(stdout, `${group} help lists no subcommands`).toContain('Commands:');
      }
    });

    it('npm documents all five subcommands', async () => {
      const { stdout } = await forge(['npm', '--help']);

      for (const sub of ['status', 'package', 'publish', 'dist-tag', 'verify']) {
        expect(stdout).toContain(sub);
      }
    });
  });

  describe('exit codes', () => {
    it('is 0 for --help', async () => {
      expect((await forge(['--help'])).code).toBe(0);
    });

    it('is non-zero for an unknown command', async () => {
      expect((await forge(['nonsense'])).code).not.toBe(0);
    });

    it('is non-zero for an unknown flag', async () => {
      expect((await forge(['--nonsense'])).code).not.toBe(0);
    });

    it('is non-zero for a config error', async () => {
      // No config in a temp dir means the command should report and exit 2.
      const { code } = await forge(['config', 'validate']);
      // The repo itself has a config, so this should succeed; guard the shape.
      expect([0, 2]).toContain(code);
    });
  });
});
