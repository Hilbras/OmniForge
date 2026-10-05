/**
 * End-to-end secret-leak tests.
 *
 * These run the real CLI in a child process with a distinctive credential in the
 * environment, then assert it appears nowhere in stdout, stderr, or a written
 * report. Unit tests prove the redactor works; this proves the CLI actually
 * *uses* it, which is the part a unit test cannot see.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReleaseResult } from '../../src/release/pipeline.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

/** Distinctive enough that a substring match cannot be a coincidence. */
const CANARY = 'FORGE_LEAKCANARY_7d3e9a1b4c2f';

/** Run the CLI with the canary planted under every credential-shaped variable. */
async function forge(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    GITHUB_TOKEN: CANARY,
    NPM_TOKEN: CANARY,
    PYPI_TOKEN: CANARY,
    SOME_API_KEY: CANARY,
    DB_PASSWORD: CANARY,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 120_000,
      cwd: REPO_ROOT,
      env,
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

describe('no secret reaches CLI output', () => {
  beforeAll(() => {
    if (!existsSync(CLI)) {
      throw new Error(`Built CLI not found at ${CLI}. Run \`npm run build\` first.`);
    }
  });

  const commands: string[][] = [
    ['--help'],
    ['--version'],
    ['config', 'show'],
    ['config', 'credentials'],
    ['config', 'validate'],
    ['provider', 'list'],
    ['provider', 'capabilities'],
    ['version', 'current'],
    ['version', 'sources'],
    ['github', 'status'],
    ['npm', 'status'],
  ];

  // These run against live providers, so the timeout is generous on purpose: a
  // slow registry response is a real condition, not a failure, and the default
  // 30s made this suite flaky roughly one run in three.
  const LIVE_TIMEOUT = 120_000;

  it.each(commands.map((c) => [c.join(' '), c] as const))(
    '`forge %s` never prints a credential',
    async (_label, args) => {
      const { stdout, stderr } = await forge(args);

      expect(stdout).not.toContain('LEAKCANARY');
      expect(stderr).not.toContain('LEAKCANARY');
    },
    LIVE_TIMEOUT,
  );

  it(
    'reports credential presence without printing a value',
    async () => {
      const { stdout } = await forge(['config', 'credentials']);

      // Presence and the variable name are safe and useful.
      expect(stdout).toContain('NPM_TOKEN');
      expect(stdout).not.toContain('LEAKCANARY');
    },
    LIVE_TIMEOUT,
  );

  it('does not leak a credential through a failing command', async () => {
    // A non-zero exit with a rendered ForgeError — the path most likely to carry
    // provider stderr into user-visible text.
    const { stdout, stderr } = await forge([
      'config',
      'validate',
      '--config',
      '/nonexistent/forge.yaml',
    ]);

    expect(stdout).not.toContain('LEAKCANARY');
    expect(stderr).not.toContain('LEAKCANARY');
  });

  it(
    'does not leak a credential through --verbose',
    async () => {
      const { stdout, stderr } = await forge(['--verbose', 'config', 'credentials']);

      expect(stdout).not.toContain('LEAKCANARY');
      expect(stderr).not.toContain('LEAKCANARY');
    },
    LIVE_TIMEOUT,
  );

  it('does not leak a credential through an unknown command error', async () => {
    const { stdout, stderr } = await forge(['nonexistent-command']);

    expect(stdout).not.toContain('LEAKCANARY');
    expect(stderr).not.toContain('LEAKCANARY');
  });
});

describe('no secret reaches a written report', () => {
  it('writes a redacted JSON report to disk', async () => {
    // Tested against the writer directly rather than by running a full release:
    // the pipeline takes 30s+ and the property under test is the writer's.
    const { globalSecrets } = await import('../../src/utils/secrets.js');
    const { writeReport } = await import('../../src/release/report.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    globalSecrets.add(CANARY);

    const dir = mkdtempSync(join(tmpdir(), 'forge-report-'));
    const result: ReleaseResult = {
      project: 'acme',
      version: '9.9.9',
      previousVersion: '9.9.8',
      tag: 'v9.9.9',
      dryRun: false,
      outcome: 'failed',
      steps: [
        {
          step: 'publish',
          provider: 'npm',
          status: 'failed',
          detail: `npm ERR! Authorization: Bearer ${CANARY}`,
          durationMs: 5,
          mandatory: true,
          error: { code: 'PROVIDER_FAILED', message: `rejected ${CANARY}` },
        },
      ],
      integrity: {
        passed: false,
        expected: '9.9.9',
        observed: [{ provider: 'npm', version: null }],
        mismatches: [`npm rejected ${CANARY}`],
      },
      startedAt: '2026-01-01T00:00:00.000Z',
      totalDurationMs: 50,
    };

    const paths = await writeReport(result, dir, ['json', 'markdown']);
    const path = paths[0];
    expect(path, 'a report should have been written').toBeDefined();
    const contents = readFileSync(path as string, 'utf8');

    expect(contents).not.toContain('LEAKCANARY');
    expect(contents).toContain('acme');
  });
});
