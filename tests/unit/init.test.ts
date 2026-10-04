/**
 * `forge init` detection and rendering.
 *
 * Runs against real directories in temp folders rather than a mocked filesystem:
 * detection is a set of `existsSync` calls, and a mock would only prove it calls
 * the mock.
 *
 * The generated config is fed back through `validateRaw`, so "it wrote a file" is
 * never mistaken for "it wrote a usable file".
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parse as parseYamlText } from 'yaml';

import { detectProject, renderConfig } from '../../src/cli/commands/init.js';
import { validateRaw } from '../../src/configuration/loader.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, contents: string): void => {
  writeFileSync(join(dir, name), contents, 'utf8');
};

describe('detectProject', () => {
  it('reads an npm project', () => {
    write('package.json', JSON.stringify({ name: '@acme/sdk', version: '2.3.1' }));

    const project = detectProject(dir);

    expect(project.name).toBe('@acme/sdk');
    expect(project.version).toBe('2.3.1');
    expect(project.ecosystemId).toBe('npm');
  });

  it('reads a Python project', () => {
    write('pyproject.toml', '[project]\nname = "acme-sdk"\nversion = "0.4.0"\n');

    const project = detectProject(dir);

    expect(project.name).toBe('acme-sdk');
    expect(project.version).toBe('0.4.0');
    expect(project.ecosystemId).toBe('python');
  });

  it('falls back to the directory name', () => {
    // No manifest name, and the directory is all there is to go on.
    const project = detectProject(dir);

    expect(project.name).toBe(dir.split('/').filter(Boolean).pop());
    expect(project.ecosystemId).toBe('unknown');
  });

  it('survives a malformed package.json', () => {
    // Someone running forge init in a broken project should still get a config.
    write('package.json', '{ this is not json');

    expect(() => detectProject(dir)).not.toThrow();
    expect(detectProject(dir).ecosystemId).toBe('npm');
  });

  it('survives a malformed pyproject.toml', () => {
    write('pyproject.toml', '[[[ not toml');

    expect(() => detectProject(dir)).not.toThrow();
  });

  it('prefers package.json when both markers exist', () => {
    // A Python package vendored inside an npm workspace is npm as far as forge
    // is concerned: the first row wins, deterministically.
    write('package.json', JSON.stringify({ name: 'wrapper', version: '1.0.0' }));
    write('pyproject.toml', '[project]\nname = "inner"\n');

    expect(detectProject(dir).ecosystemId).toBe('npm');
  });

  it('detects lint and build tooling', () => {
    write('package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));
    write('eslint.config.js', 'export default [];');
    write('tsconfig.json', '{}');

    const project = detectProject(dir);

    expect(project.hasLint).toBe(true);
    expect(project.hasBuild).toBe(true);
  });

  it('reports no tooling in a bare directory', () => {
    expect(detectProject(dir).hasTests).toBe(false);
  });
});

describe('renderConfig', () => {
  /** Parse the generated YAML and run the real schema validation over it. */
  const renderAndValidate = (project: ReturnType<typeof detectProject>) => {
    const yaml = renderConfig(project);
    // Read the YAML back with an independent parser: a file that this module
    // writes and this module reads could agree on something a user cannot load.
    return { yaml, result: validateRaw(parseYamlText(yaml)) };
  };

  it('produces a config that passes validation for an npm project', () => {
    write('package.json', JSON.stringify({ name: '@acme/sdk', version: '2.3.1' }));

    const { result } = renderAndValidate(detectProject(dir));

    expect(result.valid).toBe(true);
  });

  it('produces a config that passes validation for a Python project', () => {
    write('pyproject.toml', '[project]\nname = "acme-sdk"\nversion = "0.4.0"\n');

    const { result } = renderAndValidate(detectProject(dir));

    expect(result.valid).toBe(true);
  });

  it('produces a valid config even for an unrecognised directory', () => {
    const { result } = renderAndValidate(detectProject(dir));

    expect(result.valid).toBe(true);
  });

  it('leaves the repository as a comment rather than a guess', () => {
    write('package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));

    const { yaml } = renderAndValidate(detectProject(dir));

    // A guessed owner/name pointed at the wrong repository is worse than a blank.
    expect(yaml).toContain('# repository: owner/name');
    expect(yaml).not.toMatch(/^\s*repository:\s*\S/m);
  });

  it('enables only the publishing ecosystem', () => {
    write('package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));

    const { yaml } = renderAndValidate(detectProject(dir));

    expect(yaml).toMatch(/npm:\n\s+enabled: true/);
    expect(yaml).toMatch(/pypi:\n\s+enabled: false/);
  });

  it('normalises a Python name per PEP 503', () => {
    write('pyproject.toml', '[project]\nname = "Acme.SDK"\nversion = "0.1.0"\n');

    const { yaml } = renderAndValidate(detectProject(dir));

    expect(yaml).toContain("package: 'acme-sdk'");
  });

  it('writes a tag prefix', () => {
    write('package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));

    expect(renderConfig(detectProject(dir), 'release-')).toContain('tagPrefix: release-');
  });

  it('quotes a scoped package name', () => {
    write('package.json', JSON.stringify({ name: '@acme/sdk', version: '1.0.0' }));

    const { yaml } = renderAndValidate(detectProject(dir));

    expect(yaml).toContain("name: '@acme/sdk'");
  });

  it('lists providers in release order', () => {
    write('pyproject.toml', '[project]\nname = "acme"\n');

    const { yaml } = renderAndValidate(detectProject(dir));

    expect(yaml).toMatch(/order:\n\s+- github\n\s+- pypi/);
  });

  it('never emits a literal credential', () => {
    // Nothing in a generated config is secret-shaped by construction; this asserts
    // that property so a future field cannot quietly introduce one.
    write('package.json', JSON.stringify({ name: 'a', version: '1.0.0' }));

    const { yaml } = renderAndValidate(detectProject(dir));

    expect(yaml).not.toMatch(/token|password|secret/i);
  });
});
