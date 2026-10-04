/**
 * PyPI CLI integration.
 *
 * The unit tests stub `fetch`, so they can reach every failure mode. This file
 * covers what only the real registry can answer: that reading a public package
 * works without a credential, and that a published release reports as complete.
 *
 * `requests` is used because it is a long-lived, widely mirrored project with both
 * a wheel and an sdist at known versions. Reading it needs no token.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

/** A project configured for a real, public package. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-pypi-cli-'));
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "requests"\nversion = "2.32.3"\n');
  writeFileSync(
    join(dir, 'forge.config.yaml'),
    `project:
  name: requests
version:
  strategy: semver
  file: pyproject.toml
  tagPrefix: v
github:
  enabled: false
npm:
  enabled: false
pypi:
  enabled: true
  package: 'requests'
order:
  - pypi
`,
  );
  return dir;
}

async function forge(args: string[], cwd = REPO_ROOT) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 180_000,
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('forge pypi', () => {
  it('documents itself', async () => {
    const { stdout } = await forge(['pypi', '--help']);

    expect(stdout).toContain('Inspect and publish PyPI packages');
    expect(stdout).toContain('status');
    expect(stdout).toContain('build');
    expect(stdout).toContain('publish');
    expect(stdout).toContain('verify');
    expect(stdout).toContain('Examples:');
  });

  it('lists pypi among the registered providers', async () => {
    const { stdout } = await forge(['provider', 'list']);

    expect(stdout.split('\n').map((l) => l.trim())).toContain('pypi');
  });

  it('reports its capabilities', async () => {
    const { stdout } = await forge(['provider', 'capabilities']);

    expect(stdout).toMatch(/pypi[\s\S]*upload[\s\S]*verify/);
  });

  it('reads a public package without a credential', async () => {
    // The property that matters: publishing needs a token, reading does not.
    const { stdout, stderr, code } = await forge(
      ['pypi', 'status', '--config', join(project(), 'forge.config.yaml')],
      project(),
    );

    expect(code).toBe(0);
    expect(stdout + stderr).toContain('requests');
    expect(stdout + stderr).toMatch(/published\s+\d+ version/);
  });

  it('verifies a real release as complete', async () => {
    const dir = project();
    const { stdout, stderr, code } = await forge(
      ['pypi', 'verify', '2.32.3', '--config', join(dir, 'forge.config.yaml')],
      dir,
    );

    expect(stdout + stderr).toContain('release-exists');
    expect(stdout + stderr).toContain('has-sdist');
    expect(stdout + stderr).toContain('has-wheel');
    expect(code).toBe(0);
  });

  it('fails verification for a version that does not exist', async () => {
    const dir = project();
    const { stdout, stderr, code } = await forge(
      ['pypi', 'verify', '99.99.99', '--config', join(dir, 'forge.config.yaml')],
      dir,
    );

    expect(stdout + stderr).toContain('release-exists');
    // Exit 3 is the verification code.
    expect(code).toBe(3);
  });

  it('says a missing credential affects publishing only', async () => {
    const dir = project();
    const { stdout, stderr } = await forge(
      ['pypi', 'status', '--config', join(dir, 'forge.config.yaml')],
      dir,
    );

    expect(stdout + stderr).toMatch(/not set \(PYPI_TOKEN\)|available via/);
    expect(stdout + stderr).toMatch(/no token|needs no token|only/);
  });

  it('refuses to build without a pyproject.toml', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-pypi-empty-'));
    writeFileSync(
      join(dir, 'forge.config.yaml'),
      "project:\n  name: x\nversion:\n  strategy: semver\n  file: pyproject.toml\npypi:\n  enabled: true\n  package: 'x'\n",
    );

    const { stdout, stderr, code } = await forge(
      ['pypi', 'build', '--config', join(dir, 'forge.config.yaml')],
      dir,
    );

    expect(code).not.toBe(0);
    expect(stdout + stderr).toMatch(/pyproject\.toml/);
  });

  it('never prints a credential', async () => {
    const dir = project();
    const canary = 'pypi-FORGECANARY_1234567890';

    const { stdout, stderr } = await (async () => {
      try {
        const out = await execFileAsync(
          process.execPath,
          [CLI, 'pypi', 'status', '--config', join(dir, 'forge.config.yaml')],
          {
            timeout: 180_000,
            cwd: dir,
            env: { ...process.env, NO_COLOR: '1', PYPI_TOKEN: canary },
          },
        );
        return { stdout: out.stdout, stderr: out.stderr };
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string };
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    })();

    expect(stdout).not.toContain('FORGECANARY');
    expect(stderr).not.toContain('FORGECANARY');
  });
});
