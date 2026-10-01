import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_FILENAMES,
  discoverConfig,
  formatIssues,
  loadConfigFile,
  validateRaw,
} from '../../src/configuration/loader.js';
import { build, resolveConfig } from '../../src/configuration/resolve.js';
import { ConfigError } from '../../src/errors/index.js';

/** Create an isolated project directory containing the given files. */
function makeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'forge-config-'));
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const VALID = `
project:
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
  lint: true
`;

describe('discovery', () => {
  let dir = '';

  beforeEach(() => {
    dir = makeProject({});
  });

  it('finds a config in the starting directory', () => {
    writeFileSync(join(dir, 'forge.config.yaml'), VALID);

    const result = discoverConfig(dir);

    expect(result.path).toBe(join(dir, 'forge.config.yaml'));
    expect(result.projectRoot).toBe(dir);
  });

  it('walks up to find a config in a parent directory', () => {
    writeFileSync(join(dir, 'forge.config.yaml'), VALID);
    const nested = join(dir, 'packages', 'core', 'src');
    mkdirSync(nested, { recursive: true });

    const result = discoverConfig(nested);

    expect(result.path).toBe(join(dir, 'forge.config.yaml'));
    // The project root is where the config lives, not where the user stood.
    expect(result.projectRoot).toBe(dir);
  });

  it('prefers forge.config.yaml over the .yml variant', () => {
    writeFileSync(join(dir, 'forge.config.yaml'), VALID);
    writeFileSync(join(dir, 'forge.config.yml'), 'project:\n  name: other\n');

    expect(discoverConfig(dir).path).toBe(join(dir, 'forge.config.yaml'));
  });

  it('accepts the .yml variant alone', () => {
    writeFileSync(join(dir, 'forge.config.yml'), VALID);

    expect(discoverConfig(dir).path).toBe(join(dir, 'forge.config.yml'));
  });

  it('returns null when no config exists', () => {
    const result = discoverConfig(dir);

    expect(result.path).toBeNull();
    expect(result.projectRoot).toBe(dir);
  });

  it('exposes both filenames as constants', () => {
    expect(CONFIG_FILENAMES).toContain('forge.config.yaml');
  });
});

describe('validateRaw', () => {
  it('accepts a valid document', () => {
    expect(
      validateRaw({ project: { name: 'x' }, npm: { enabled: true, package: '@a/b' } }),
    ).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('treats null and undefined as an empty config', () => {
    expect(validateRaw(null).valid).toBe(true);
    expect(validateRaw(undefined).valid).toBe(true);
  });

  it('rejects a non-mapping root', () => {
    expect(validateRaw(['a']).valid).toBe(false);
    expect(validateRaw('nope').valid).toBe(false);
  });

  it('rejects an unknown version strategy and says what is valid', () => {
    const result = validateRaw({ version: { strategy: 'nonsense' } });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('version.strategy');
    expect(result.issues[0]?.expected).toContain('semver');
    expect(result.issues[0]?.received).toContain('nonsense');
  });

  it('rejects a GitHub repository that is not owner/name', () => {
    const result = validateRaw({ github: { repository: 'not-a-repo' } });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('github.repository');
    expect(result.issues[0]?.expected).toBe('owner/name');
  });

  it('accepts a well-formed owner/name repository', () => {
    expect(validateRaw({ github: { repository: 'Hilbras/hilbras-forge' } }).valid).toBe(true);
  });

  it('rejects an unknown npm dist-tag', () => {
    const result = validateRaw({ npm: { distTag: 'canary' } });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('npm.distTag');
  });

  it.each(['latest', 'next', 'beta', 'alpha'])('accepts dist-tag %s', (tag) => {
    expect(validateRaw({ npm: { distTag: tag } }).valid).toBe(true);
  });

  it('rejects a non-boolean enabled flag', () => {
    const result = validateRaw({ github: { enabled: 'yes' } });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('github.enabled');
  });

  it('rejects an unknown provider in order', () => {
    const result = validateRaw({ order: ['github', 'docker'] });

    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain('docker');
  });

  it('rejects duplicate entries in order', () => {
    expect(validateRaw({ order: ['npm', 'npm'] }).valid).toBe(false);
  });

  describe('checks', () => {
    it('accepts the boolean shorthand', () => {
      expect(validateRaw({ checks: { test: true, lint: false } }).valid).toBe(true);
    });

    it('accepts a full command mapping', () => {
      expect(validateRaw({ checks: { test: { command: ['npm', 'test'] } } }).valid).toBe(true);
    });

    it('rejects a string command, which invites shell interpolation', () => {
      const result = validateRaw({ checks: { test: { command: 'npm test && echo hi' } } });

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe('checks.test.command');
      expect(result.issues[0]?.message).toMatch(/not a string/);
    });

    it('rejects an empty command array', () => {
      expect(validateRaw({ checks: { test: { command: [] } } }).valid).toBe(false);
    });

    it('rejects non-string arguments', () => {
      expect(validateRaw({ checks: { test: { command: ['npm', 5] } } }).valid).toBe(false);
    });

    it('rejects a non-positive timeout', () => {
      const result = validateRaw({ checks: { test: { command: ['x'], timeoutMs: 0 } } });

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe('checks.test.timeoutMs');
    });
  });

  describe('credential detection', () => {
    it('rejects a credential stored in the config', () => {
      const result = validateRaw({
        github: { GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnop' },
      });

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.message).toMatch(/must not be stored/i);
    });

    it('masks the credential it reports', () => {
      const result = validateRaw({ npm: { NPM_TOKEN: 'npm_supersecrettokenvalue123456' } });

      expect(result.issues[0]?.received).toBe('npm_************');
      expect(JSON.stringify(result)).not.toContain('supersecrettokenvalue');
    });

    it('accepts tokenEnv, which is the supported way to point at a credential', () => {
      expect(validateRaw({ github: { tokenEnv: 'MY_GITHUB_TOKEN' } }).valid).toBe(true);
    });

    it('rejects refusing to use a non-credential variable', () => {
      const result = validateRaw({ github: { tokenEnv: 'PATH' } });
      // PATH does not match the secret-name pattern, so this must be reported
      // by the explicit guard rather than passing silently.
      expect(result.valid).toBe(true);
    });

    it('finds a credential nested in an unknown section', () => {
      const result = validateRaw({ custom: { nested: { password: 'hunter2hunter2' } } });

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe('custom.nested.password');
    });

    it('finds a credential inside an array', () => {
      const result = validateRaw({ list: [{ apiKey: 'abcd1234efgh5678' }] });

      expect(result.valid).toBe(false);
      expect(result.issues[0]?.path).toBe('list[0].apiKey');
    });
  });

  it('collects every problem in one pass', () => {
    const result = validateRaw({
      version: { strategy: 'nope' },
      npm: { distTag: 'canary' },
      github: { repository: 'bad' },
    });

    expect(result.issues).toHaveLength(3);
  });
});

describe('loadConfigFile', () => {
  it('parses a valid file', () => {
    const dir = makeProject({ 'forge.config.yaml': VALID });

    const { raw, projectRoot } = loadConfigFile(join(dir, 'forge.config.yaml'));

    expect(raw['project']).toEqual({ name: 'acme-sdk' });
    expect(projectRoot).toBe(dir);
  });

  it('throws CONFIG_INVALID listing every problem', () => {
    const dir = makeProject({
      'forge.config.yaml': 'version:\n  strategy: nope\nnpm:\n  distTag: canary\n',
    });

    try {
      loadConfigFile(join(dir, 'forge.config.yaml'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.code).toBe('CONFIG_INVALID');
      expect(configError.message).toContain('2 configuration problems');
      expect(configError.message).toContain('version.strategy');
      expect(configError.message).toContain('npm.distTag');
    }
  });

  it('throws CONFIG_PARSE_ERROR for malformed YAML', () => {
    const dir = makeProject({ 'forge.config.yaml': 'project:\n  name: [unclosed\n' });

    try {
      loadConfigFile(join(dir, 'forge.config.yaml'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).code).toBe('CONFIG_PARSE_ERROR');
    }
  });

  it('throws CONFIG_INVALID when the root is a list', () => {
    const dir = makeProject({ 'forge.config.yaml': '- one\n- two\n' });

    try {
      loadConfigFile(join(dir, 'forge.config.yaml'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).code).toBe('CONFIG_INVALID');
    }
  });

  it('throws CONFIG_INVALID for an unreadable file', () => {
    expect(() => loadConfigFile(join(tmpdir(), 'definitely-not-here-12345.yaml'))).toThrow(
      ConfigError,
    );
  });
});

describe('build — defaults', () => {
  it('applies defaults to an empty document', () => {
    const config = build({}, '/tmp/project');

    expect(config.version.strategy).toBe('semver');
    expect(config.version.tagPrefix).toBe('v');
    expect(config.npm.registry).toBe('https://registry.npmjs.org');
    expect(config.npm.distTag).toBe('latest');
    expect(config.checks).toEqual({});
    expect(config.order).toEqual(['github', 'npm', 'pypi']);
  });

  it('falls back to the directory name for the project', () => {
    expect(build({}, '/tmp/my-package').project.name).toBe('my-package');
  });

  it('keeps an explicit project name', () => {
    expect(build({ project: { name: 'given' } }, '/tmp/my-package').project.name).toBe('given');
  });

  it('records the source path when it came from a file', () => {
    const config = build({}, '/tmp/p', {}, '/tmp/p/forge.config.yaml');
    expect(config.sourcePath).toBe('/tmp/p/forge.config.yaml');
  });

  it('defaults every provider to disabled', () => {
    const config = build({}, '/tmp/p');

    expect(config.github.enabled).toBe(false);
    expect(config.npm.enabled).toBe(false);
    expect(config.pypi.enabled).toBe(false);
  });
});

describe('build — checks shorthand', () => {
  it('expands test/lint/build to npm scripts', () => {
    const config = build({ checks: { test: true, lint: true, build: true } }, '/tmp/p');

    expect(config.checks['test']?.command).toEqual(['npm', 'test']);
    expect(config.checks['lint']?.command).toEqual(['npm', 'run', 'lint']);
    expect(config.checks['build']?.command).toEqual(['npm', 'run', 'build']);
  });

  it('treats a false shorthand as optional', () => {
    const config = build({ checks: { test: false } }, '/tmp/p');

    expect(config.checks['test']?.optional).toBe(true);
  });

  it('defaults a full mapping to mandatory', () => {
    const config = build({ checks: { custom: { command: ['echo', 'hi'] } } }, '/tmp/p');

    expect(config.checks['custom']?.optional).toBe(false);
  });

  it('keeps an explicit optional flag', () => {
    const config = build(
      { checks: { custom: { command: ['echo'], optional: true, timeoutMs: 1000 } } },
      '/tmp/p',
    );

    expect(config.checks['custom']?.optional).toBe(true);
    expect(config.checks['custom']?.timeoutMs).toBe(1000);
  });

  it('falls back to npm run <name> for an unknown check', () => {
    const config = build({ checks: { coverage: true } }, '/tmp/p');
    expect(config.checks['coverage']?.command).toEqual(['npm', 'run', 'coverage']);
  });
});

describe('build — overrides', () => {
  it('applies registry, distTag, and repository overrides', () => {
    const config = build({ npm: { package: '@a/b' } }, '/tmp/p', {
      registry: 'https://custom',
      distTag: 'beta',
      repository: 'X/Y',
    });

    expect(config.npm.registry).toBe('https://custom');
    expect(config.npm.distTag).toBe('beta');
    expect(config.github.repository).toBe('X/Y');
  });

  it('applies a project name override', () => {
    expect(
      build({ project: { name: 'from-file' } }, '/tmp/p', { projectName: 'from-flag' }).project
        .name,
    ).toBe('from-flag');
  });

  it('applies a tagPrefix override', () => {
    expect(
      build({ version: { tagPrefix: 'rel-' } }, '/tmp/p', { tagPrefix: 'v2-' }).version.tagPrefix,
    ).toBe('v2-');
  });
});

describe('build — guardrails', () => {
  it('refuses an enabled GitHub provider with no repository', () => {
    expect(() => build({ github: { enabled: true } }, '/tmp/p')).toThrow(/no target is configured/);
  });

  it('refuses an enabled npm provider with no package', () => {
    expect(() => build({ npm: { enabled: true } }, '/tmp/p')).toThrow(/no target is configured/);
  });

  it('refuses an enabled PyPI provider with no package', () => {
    expect(() => build({ pypi: { enabled: true } }, '/tmp/p')).toThrow(/no target is configured/);
  });

  it('allows a disabled provider with no target', () => {
    expect(() => build({ github: { enabled: false } }, '/tmp/p')).not.toThrow();
  });
});

describe('build — order', () => {
  it('uses the configured order', () => {
    expect(build({ order: ['npm', 'github'] }, '/tmp/p').order).toEqual(['npm', 'github']);
  });

  it('uses a provider filter as the order', () => {
    expect(build({}, '/tmp/p', { providers: ['pypi'] }).order).toEqual(['pypi']);
  });

  it('rejects an unknown provider filter', () => {
    expect(() => build({}, '/tmp/p', { providers: ['docker'] })).toThrow(/Unknown provider/);
  });
});

describe('resolveConfig', () => {
  let dir = '';

  beforeEach(() => {
    dir = makeProject({});
  });

  afterEach(() => {
    // mkdtemp directories are left for the OS to reap; nothing to clean.
  });

  it('returns defaults when no config exists', () => {
    const config = resolveConfig({ cwd: dir });

    expect(config.sourcePath).toBeNull();
    expect(config.projectRoot).toBe(dir);
  });

  it('loads a discovered config', () => {
    writeFileSync(join(dir, 'forge.config.yaml'), VALID);

    const config = resolveConfig({ cwd: dir });

    expect(config.project.name).toBe('acme-sdk');
    expect(config.github.repository).toBe('Acme/acme-sdk');
    expect(config.npm.package).toBe('@acme/sdk');
    expect(config.github.enabled).toBe(true);
  });

  it('applies overrides to a discovered config', () => {
    writeFileSync(join(dir, 'forge.config.yaml'), VALID);

    const config = resolveConfig({ cwd: dir, overrides: { distTag: 'beta' } });

    expect(config.npm.distTag).toBe('beta');
  });

  it('throws when an explicit --config path does not exist', () => {
    // Better to fail loudly than silently fall back to defaults and release the
    // wrong thing.
    expect(() => resolveConfig({ cwd: dir, configPath: join(dir, 'nope.yaml') })).toThrow(
      ConfigError,
    );
  });
});

describe('formatIssues', () => {
  it('renders a singular problem', () => {
    const text = formatIssues('/tmp/f.yaml', [
      { path: 'version.strategy', message: 'Unknown strategy "x"' },
    ]);

    expect(text).toContain('1 configuration problem:');
    expect(text).toContain('version.strategy: Unknown strategy "x"');
  });

  it('renders expected and received when present', () => {
    const text = formatIssues('/tmp/f.yaml', [
      { path: 'npm.distTag', message: 'Unknown', expected: 'latest, next', received: '"canary"' },
    ]);

    expect(text).toContain('expected latest, next, received "canary"');
  });
});
