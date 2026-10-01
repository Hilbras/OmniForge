import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  JsonPathSource,
  PackageJsonSource,
  PlainTextSource,
  PyProjectTomlSource,
  resolveSource,
} from '../../src/version/sources.js';
import {
  detectDuplicate,
  nextVersion,
  readVersionState,
  selectSources,
  tagFor,
  writeVersion,
} from '../../src/version/engine.js';
import { build } from '../../src/configuration/resolve.js';
import { VersionError } from '../../src/errors/index.js';

/** A project directory with the given files. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-src-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A config rooted at `dir`. */
function configAt(dir: string, raw: Record<string, unknown> = {}) {
  return build({ project: { name: 't' }, ...raw }, dir);
}

describe('PackageJsonSource', () => {
  it('reads the version', () => {
    const dir = project({ 'package.json': '{"name":"x","version":"1.2.3"}' });
    expect(new PackageJsonSource().read(dir)).toBe('1.2.3');
  });

  it('returns null when the file is missing', () => {
    expect(new PackageJsonSource().read(project({}))).toBeNull();
  });

  it('returns null when there is no version field', () => {
    expect(new PackageJsonSource().read(project({ 'package.json': '{"name":"x"}' }))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(new PackageJsonSource().read(project({ 'package.json': '{not json' }))).toBeNull();
  });

  it('writes the version', async () => {
    const dir = project({ 'package.json': '{"name":"x","version":"1.2.3"}' });
    await new PackageJsonSource().write(dir, '2.0.0');

    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))['version']).toBe('2.0.0');
  });

  it('changes only the version line, preserving formatting', async () => {
    // A round-trip through JSON.stringify would reorder keys and reindent, which
    // is an unacceptable diff to leave in a user's repo.
    const original =
      '{\n    "name": "@a/b",\n    "version": "1.0.0",\n    "dependencies": {\n        "zod": "^3.0.0"\n    }\n}\n';
    const dir = project({ 'package.json': original });

    await new PackageJsonSource().write(dir, '1.0.1');
    const after = readFileSync(join(dir, 'package.json'), 'utf8');

    expect(after).not.toBe(original);
    expect(after).toContain('"version": "1.0.1"');
    expect(after).toContain('    "name": "@a/b"');
    expect(after).toContain('        "zod": "^3.0.0"');
  });

  it('throws when there is no version field to update', async () => {
    await expect(
      new PackageJsonSource().write(project({ 'package.json': '{"name":"x"}' }), '1.0.0'),
    ).rejects.toThrow(VersionError);
  });
});

describe('PyProjectTomlSource', () => {
  it('reads [project] version', () => {
    const dir = project({ 'pyproject.toml': '[project]\nname = "x"\nversion = "1.2.3"\n' });
    expect(new PyProjectTomlSource().read(dir)).toBe('1.2.3');
  });

  it('reads [tool.poetry] version', () => {
    const dir = project({ 'pyproject.toml': '[tool.poetry]\nname = "x"\nversion = "2.0.0"\n' });
    expect(new PyProjectTomlSource().read(dir)).toBe('2.0.0');
  });

  it('prefers [project] over [tool.poetry]', () => {
    const dir = project({
      'pyproject.toml': '[project]\nversion = "1.0.0"\n\n[tool.poetry]\nversion = "9.9.9"\n',
    });
    expect(new PyProjectTomlSource().read(dir)).toBe('1.0.0');
  });

  it('returns null when the file is missing', () => {
    expect(new PyProjectTomlSource().read(project({}))).toBeNull();
  });

  it('returns null for malformed TOML', () => {
    expect(
      new PyProjectTomlSource().read(project({ 'pyproject.toml': '[project\nbroken' })),
    ).toBeNull();
  });

  it('writes [project] version, preserving comments', async () => {
    const original = '# my package\n[project]\nname = "x"  # keep me\nversion = "1.0.0"\n';
    const dir = project({ 'pyproject.toml': original });

    await new PyProjectTomlSource().write(dir, '1.1.0');
    const after = readFileSync(join(dir, 'pyproject.toml'), 'utf8');

    expect(after).toContain('version = "1.1.0"');
    expect(after).toContain('# my package');
    expect(after).toContain('# keep me');
  });

  it('writes [tool.poetry] version when that is where it lives', async () => {
    const dir = project({ 'pyproject.toml': '[tool.poetry]\nname = "x"\nversion = "1.0.0"\n' });
    await new PyProjectTomlSource().write(dir, '2.2.2');

    expect(readFileSync(join(dir, 'pyproject.toml'), 'utf8')).toContain('version = "2.2.2"');
  });

  it('throws when there is no version field', async () => {
    await expect(
      new PyProjectTomlSource().write(
        project({ 'pyproject.toml': '[project]\nname = "x"\n' }),
        '1.0.0',
      ),
    ).rejects.toThrow(VersionError);
  });
});

describe('PlainTextSource', () => {
  it('reads a VERSION file', () => {
    expect(new PlainTextSource('VERSION').read(project({ VERSION: '3.1.4\n' }))).toBe('3.1.4');
  });

  it('writes with a trailing newline', async () => {
    const dir = project({ VERSION: '3.1.4' });
    await new PlainTextSource('VERSION').write(dir, '3.1.5');

    expect(readFileSync(join(dir, 'VERSION'), 'utf8')).toBe('3.1.5\n');
  });

  it('returns null for an empty file', () => {
    expect(new PlainTextSource('VERSION').read(project({ VERSION: '  \n' }))).toBeNull();
  });
});

describe('JsonPathSource', () => {
  it('reads a nested value', () => {
    const dir = project({ 'package.json': '{"config":{"version":"9.9.9"}}' });
    expect(new JsonPathSource('package.json', 'config.version').read(dir)).toBe('9.9.9');
  });

  it('returns null for a missing path', () => {
    const dir = project({ 'package.json': '{"config":{}}' });
    expect(new JsonPathSource('package.json', 'config.version').read(dir)).toBeNull();
  });

  it('returns null when the path crosses a non-object', () => {
    const dir = project({ 'package.json': '{"config":"a string"}' });
    expect(new JsonPathSource('package.json', 'config.version').read(dir)).toBeNull();
  });
});

describe('resolveSource', () => {
  it('resolves registered names', () => {
    expect(resolveSource('package.json')).toBeInstanceOf(PackageJsonSource);
    expect(resolveSource('pyproject.toml')).toBeInstanceOf(PyProjectTomlSource);
    expect(resolveSource('VERSION')).toBeInstanceOf(PlainTextSource);
  });

  it('resolves an unregistered filename to a plain text source', () => {
    expect(resolveSource('MYVERSION')).toBeInstanceOf(PlainTextSource);
  });

  it('resolves a dotted path', () => {
    expect(resolveSource('package.json:config.version')).toBeInstanceOf(JsonPathSource);
  });

  it('rejects an empty name', () => {
    expect(() => resolveSource('')).toThrow(VersionError);
  });
});

describe('selectSources', () => {
  it('finds only files that exist', () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}' });
    expect(selectSources(configAt(dir)).map((s) => s.name)).toEqual(['package.json']);
  });

  it('finds both when a project is polyglot', () => {
    const dir = project({
      'package.json': '{"version":"1.0.0"}',
      'pyproject.toml': '[project]\nversion = "1.0.0"\n',
    });
    expect(
      selectSources(configAt(dir))
        .map((s) => s.name)
        .sort(),
    ).toEqual(['package.json', 'pyproject.toml']);
  });

  it('honours an explicit version.file', () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}', VERSION: '1.0.0' });
    const config = configAt(dir, { version: { file: 'VERSION' } });

    expect(selectSources(config).map((s) => s.name)).toEqual(['VERSION']);
  });

  it('falls back to package.json when nothing is recognised', () => {
    expect(selectSources(configAt(project({}))).map((s) => s.name)).toEqual(['package.json']);
  });
});

describe('readVersionState', () => {
  it('reads a single source', () => {
    const dir = project({ 'package.json': '{"version":"1.4.0"}' });
    const state = readVersionState(configAt(dir));

    expect(state.current).toBe('1.4.0');
    expect(state.currentSource).toBe('package.json');
    expect(state.inconsistent).toBe(false);
  });

  it('reports every source it consulted', () => {
    const dir = project({
      'package.json': '{"version":"1.4.0"}',
      'pyproject.toml': '[project]\nversion = "1.4.0"\n',
    });
    expect(readVersionState(configAt(dir)).observations).toHaveLength(2);
  });

  it('accepts agreeing polyglot sources', () => {
    const dir = project({
      'package.json': '{"version":"1.4.0"}',
      'pyproject.toml': '[project]\nversion = "1.4.0"\n',
    });
    expect(readVersionState(configAt(dir)).current).toBe('1.4.0');
  });

  it('rejects disagreeing sources', () => {
    // Publishing two different versions from one release is the failure this
    // check exists to prevent.
    const dir = project({
      'package.json': '{"version":"1.4.0"}',
      'pyproject.toml': '[project]\nversion = "1.3.0"\n',
    });

    try {
      readVersionState(configAt(dir));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as VersionError).code).toBe('VERSION_INCONSISTENT');
      expect((error as VersionError).message).toContain('disagree');
    }
  });

  it('throws when no version exists at all', () => {
    expect(() => readVersionState(configAt(project({ 'package.json': '{"name":"x"}' })))).toThrow(
      VersionError,
    );
  });

  it('rejects a non-semver version', () => {
    const dir = project({ 'package.json': '{"version":"not-a-version"}' });

    try {
      readVersionState(configAt(dir));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as VersionError).code).toBe('VERSION_INVALID');
    }
  });

  it('flags a file that exists but carries no version', () => {
    const dir = project({
      'package.json': '{"name":"x"}',
      'pyproject.toml': '[project]\nversion="1.0.0"\n',
    });
    const state = readVersionState(configAt(dir));

    const broken = state.observations.find((o) => o.source === 'package.json');
    expect(broken?.version).toBeNull();
    expect(broken?.malformed).toBe(true);
  });
});

describe('nextVersion', () => {
  it('computes from the current version', () => {
    const dir = project({ 'package.json': '{"version":"1.2.3"}' });
    expect(nextVersion(configAt(dir), ['patch'])).toBe('1.2.4');
    expect(nextVersion(configAt(dir), ['minor'])).toBe('1.3.0');
    expect(nextVersion(configAt(dir), ['major'])).toBe('2.0.0');
  });

  it('applies several strategies in order', () => {
    const dir = project({ 'package.json': '{"version":"1.2.3"}' });
    expect(nextVersion(configAt(dir), ['minor', 'prerelease'])).toBe('1.3.0-rc.0');
  });

  it('accepts an explicit base version', () => {
    const dir = project({ 'package.json': '{"version":"1.2.3"}' });
    expect(nextVersion(configAt(dir), ['patch'], '5.0.0')).toBe('5.0.1');
  });
});

describe('writeVersion', () => {
  it('writes to every existing source', async () => {
    const dir = project({
      'package.json': '{"version":"1.0.0"}',
      'pyproject.toml': '[project]\nversion = "1.0.0"\n',
    });

    await writeVersion(configAt(dir), '1.1.0');

    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))['version']).toBe('1.1.0');
    expect(readFileSync(join(dir, 'pyproject.toml'), 'utf8')).toContain('version = "1.1.0"');
  });

  it('never creates a file that does not exist', async () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}' });
    const written = await writeVersion(configAt(dir), '1.1.0');

    expect(written.map((s) => s.name)).toEqual(['package.json']);
  });

  it('refuses to write an invalid version', async () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}' });
    await expect(writeVersion(configAt(dir), 'nope')).rejects.toThrow(VersionError);
  });

  it('throws when there is no file to update', async () => {
    await expect(writeVersion(configAt(project({})), '1.0.0')).rejects.toThrow(VersionError);
  });
});

describe('detectDuplicate', () => {
  it('flags the same version', () => {
    expect(detectDuplicate('1.0.0', '1.0.0').duplicate).toBe(true);
  });

  it('does not flag a higher version', () => {
    expect(detectDuplicate('1.1.0', '1.0.0').duplicate).toBe(false);
  });

  it('does not flag when nothing is published', () => {
    expect(detectDuplicate('1.0.0', null).duplicate).toBe(false);
  });
});

describe('tagFor', () => {
  it('applies the configured prefix', () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}' });
    expect(tagFor(configAt(dir), '1.2.3')).toBe('v1.2.3');
  });

  it('honours a custom prefix', () => {
    const dir = project({ 'package.json': '{"version":"1.0.0"}' });
    const config = configAt(dir, { version: { tagPrefix: 'release-' } });
    expect(tagFor(config, '1.2.3')).toBe('release-1.2.3');
  });
});
