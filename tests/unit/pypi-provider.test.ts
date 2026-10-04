/**
 * PyPI provider tests.
 *
 * The registry is stubbed at the `fetch` boundary and the toolchain at the runner
 * boundary, so every failure mode is reachable without a network or a PyPI
 * account. What is *not* covered here is covered by the integration tests, which
 * read the real registry for a public package.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { PyPiProvider } from '../../src/providers/pypi/index.js';
import { artifactKind, validateArtifacts, type Artifact } from '../../src/providers/pypi/client.js';
import { normalizeUploadError } from '../../src/providers/pypi/errors.js';
import {
  escapeFilenameName,
  normalizePackageName,
  sameProject,
  validatePackageName,
} from '../../src/providers/pypi/name.js';
import { AuthError, ConfigError, ProviderError } from '../../src/errors/index.js';
import type { ProviderContext } from '../../src/core/provider.js';
import { build } from '../../src/configuration/resolve.js';

const NO_RESPONSE = new Response('{}', { status: 500 });

/** A real directory containing a pyproject.toml, for validate() to accept. */
let PYTHON_PROJECT: string | undefined;

function projectWithPyProject(): string {
  if (PYTHON_PROJECT !== undefined) return PYTHON_PROJECT;
  PYTHON_PROJECT = mkdtempSync(join(tmpdir(), 'forge-pypi-'));
  writeFileSync(
    join(PYTHON_PROJECT, 'pyproject.toml'),
    '[project]\nname = "acme"\nversion = "1.0.0"\n',
    'utf8',
  );
  return PYTHON_PROJECT;
}

/** Build a context with a fixed config and secret. */
function contextWith(
  options: {
    package?: string | null;
    token?: string;
    dryRun?: boolean;
    projectRoot?: string;
  } = {},
): ProviderContext {
  const config = build(
    {
      project: { name: 'acme' },
      version: { strategy: 'semver', file: 'pyproject.toml', tagPrefix: 'v' },
      github: { enabled: false, repository: 'a/b' },
      npm: { enabled: false, package: null },
      pypi: { enabled: true, package: options.package ?? 'acme' },
      checks: {},
      order: ['pypi'],
    },
    options.projectRoot ?? process.cwd(),
  );

  return {
    projectRoot: config.projectRoot,
    config: config as unknown as Record<string, unknown>,
    getSecret: (name) => (name === 'pypi' ? options.token : undefined),
    execute: { run: () => Promise.reject(new Error('not used')) },
    dryRun: options.dryRun ?? false,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('name handling', () => {
  it.each([
    ['Foo.Bar', 'foo-bar'],
    ['foo_bar', 'foo-bar'],
    ['FOO--BAR', 'foo-bar'],
    ['foo.bar.baz', 'foo-bar-baz'],
    ['  spaced  ', 'spaced'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizePackageName(input)).toBe(expected);
  });

  it('treats differently-spelled names as the same project', () => {
    expect(sameProject('Acme.SDK', 'acme-sdk')).toBe(true);
    expect(sameProject('acme', 'acme2')).toBe(false);
  });

  it('escapes the name the way wheel filenames do', () => {
    // `foo-bar` ships as `foo_bar`, so comparing a filename to the canonical form
    // without this reports a false mismatch on every hyphenated package.
    expect(escapeFilenameName('foo-bar')).toBe('foo_bar');
    expect(normalizePackageName('foo-bar')).toBe('foo-bar');
  });

  it.each(['acme', 'acme-sdk', 'Acme.SDK', 'a.b.c'])('accepts %s', (name) => {
    expect(validatePackageName(name)).toBeNull();
  });

  it.each(['', 'has space', 'has/slash', 'a'.repeat(201)])('rejects %s', (name) => {
    expect(validatePackageName(name)).toBeTruthy();
  });

  it('rejects an over-long dotted segment', () => {
    // PyPI allows 64 per segment, and rejects the upload after the build has run.
    const name = `${'x'.repeat(65)}.pkg`;
    expect(validatePackageName(name)).toMatch(/64/);
  });

  it('rejects surrounding whitespace rather than silently trimming', () => {
    expect(validatePackageName(' acme ')).toMatch(/whitespace/i);
  });
});

describe('artifacts', () => {
  it.each([
    ['acme-1.0.0.tar.gz', 'sdist'],
    ['acme-1.0.0.zip', 'sdist'],
    ['acme-1.0.0-py3-none-any.whl', 'wheel'],
  ])('classifies %s as %s', (filename, kind) => {
    expect(artifactKind(filename)).toBe(kind);
  });

  it.each(['setup.py', 'README.md', 'acme-1.0.0.exe'])('ignores %s', (filename) => {
    expect(artifactKind(filename)).toBeNull();
  });

  const artifact = (filename: string, sizeBytes = 100): Artifact => ({
    filename,
    path: `/tmp/${filename}`,
    kind: artifactKind(filename) ?? 'wheel',
    sizeBytes,
  });

  it('accepts a normal pair', () => {
    const problems = validateArtifacts(
      [artifact('acme-1.0.0.tar.gz'), artifact('acme-1.0.0-py3-none-any.whl')],
      'acme',
    );

    expect(problems).toEqual([]);
  });

  it('accepts a hyphenated name spelled with underscores in the filenames', () => {
    // The common real case: `foo-bar` becomes `foo_bar` in both artifacts.
    expect(
      validateArtifacts(
        [artifact('foo_bar-1.0.0.tar.gz'), artifact('foo_bar-1.0.0-py3-none-any.whl')],
        'foo-bar',
      ),
    ).toEqual([]);
  });

  it('requires an sdist', () => {
    const problems = validateArtifacts([artifact('acme-1.0.0-py3-none-any.whl')], 'acme');
    expect(problems.join(' ')).toMatch(/source distribution/i);
  });

  it('requires a wheel', () => {
    const problems = validateArtifacts([artifact('acme-1.0.0.tar.gz')], 'acme');
    expect(problems.join(' ')).toMatch(/wheel/i);
  });

  it('rejects nothing at all', () => {
    expect(validateArtifacts([], 'acme').join(' ')).toMatch(/no distributions/i);
  });

  it('flags an artifact belonging to a different project', () => {
    const problems = validateArtifacts(
      [artifact('other-1.0.0.tar.gz'), artifact('other-1.0.0-py3-none-any.whl')],
      'acme',
    );
    expect(problems.join(' ')).toMatch(/does not look like acme/);
  });

  it('flags an empty artifact', () => {
    const problems = validateArtifacts(
      [artifact('acme-1.0.0.tar.gz', 0), artifact('acme-1.0.0-py3-none-any.whl')],
      'acme',
    );
    expect(problems.join(' ')).toMatch(/is empty/);
  });
});

describe('authenticate', () => {
  it('reports anonymous rather than failing when no token is set', async () => {
    // Reading a public package needs no credential; only publishing does.
    const result = await new PyPiProvider().authenticate(contextWith({ token: undefined }));

    expect(result.authenticated).toBe(false);
    expect(result.identity).toBe('anonymous');
  });

  it('accepts a well-formed token', async () => {
    const result = await new PyPiProvider().authenticate(
      contextWith({ token: 'pypi-AgEIcHlwaS5vcmcAAAA' }),
    );

    expect(result.authenticated).toBe(true);
  });

  it('rejects a token that cannot be one', async () => {
    // A truncated or wrong-kind value is caught here rather than as an opaque 401.
    await expect(
      new PyPiProvider().authenticate(contextWith({ token: 'npm_notapypitoken123456' })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('says how to obtain a token', async () => {
    try {
      await new PyPiProvider().authenticate(contextWith({ token: 'wrong_kind_of_secret' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AuthError).remediation).toMatch(/pypi-/);
    }
  });
});

describe('validate', () => {
  it('rejects an invalid project name', async () => {
    const context = contextWith({ package: 'has space', projectRoot: projectWithPyProject() });
    await expect(new PyPiProvider().validate(context)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a missing project name', async () => {
    // Defence in depth: `resolveConfig` already refuses an enabled provider with no
    // target, so this guards direct provider use rather than the normal path. The
    // context is assembled by hand to get past that earlier check.
    const config = build(
      {
        project: { name: 'acme' },
        version: { strategy: 'semver', file: 'pyproject.toml', tagPrefix: 'v' },
        github: { enabled: false, repository: 'a/b' },
        npm: { enabled: false, package: null },
        pypi: { enabled: false, package: null },
        checks: {},
        order: [],
      },
      projectWithPyProject(),
    );
    const context: ProviderContext = {
      projectRoot: config.projectRoot,
      config: config as unknown as Record<string, unknown>,
      getSecret: () => undefined,
      execute: { run: () => Promise.reject(new Error('not used')) },
      dryRun: false,
    };

    await expect(new PyPiProvider().validate(context)).rejects.toThrow(/No PyPI project name/);
  });

  it('requires a pyproject.toml', async () => {
    const context = contextWith({ projectRoot: '/nonexistent-path-for-tests' });
    await expect(new PyPiProvider().validate(context)).rejects.toThrow(/pyproject\.toml/);
  });

  it('checks the project before its name', async () => {
    // With neither a project nor a name, "no pyproject.toml" is the useful
    // answer; complaining about the name would be answering a question the user
    // cannot act on yet.
    const context = contextWith({ package: null, projectRoot: '/nonexistent-path-for-tests' });
    await expect(new PyPiProvider().validate(context)).rejects.toThrow(/pyproject\.toml/);
  });
});

describe('verify against a stubbed registry', () => {
  const releaseResponse = (version: string, yanked = false) =>
    new Response(
      JSON.stringify({
        info: { version, yanked },
        urls: [
          { filename: `acme-${version}.tar.gz`, packagetype: 'sdist' },
          { filename: `acme-${version}-py3-none-any.whl`, packagetype: 'bdist_wheel' },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('passes a complete release', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(releaseResponse('1.0.0')));

    const result = await new PyPiProvider().verify(contextWith(), '1.0.0');

    expect(result.verified).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('reports a missing release as absent', async () => {
    // Only a 404 may mean "absent" — see the network and auth cases below.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    const result = await new PyPiProvider().verify(contextWith(), '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.observed.version).toBeNull();
    expect(result.checks.find((c) => c.name === 'release-exists')?.passed).toBe(false);
  });

  it('raises rather than reporting absent when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND')));

    await expect(new PyPiProvider().verify(contextWith(), '1.0.0')).rejects.toThrow(
      /Could not reach/,
    );
  });

  it('raises rather than reporting absent when the token is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));

    await expect(new PyPiProvider().verify(contextWith(), '1.0.0')).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it.each([500, 502])('raises on a %s rather than reporting absent', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));

    await expect(new PyPiProvider().verify(contextWith(), '1.0.0')).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('flags a release with no wheel', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            info: { version: '1.0.0', yanked: false },
            urls: [{ filename: 'acme-1.0.0.tar.gz', packagetype: 'sdist' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const result = await new PyPiProvider().verify(contextWith(), '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'has-wheel')?.passed).toBe(false);
  });

  it('flags a yanked release', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(releaseResponse('1.0.0', true)));

    const result = await new PyPiProvider().verify(contextWith(), '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'not-yanked')?.detail).toMatch(/yanked/);
  });

  it('compares the project name after normalisation', async () => {
    // PyPI canonicalises names, so `Acme.SDK` and `acme-sdk` are one project.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(releaseResponse('1.0.0')));

    const result = await new PyPiProvider().verify(contextWith({ package: 'Acme.SDK' }), '1.0.0');

    expect(result.verified).toBe(true);
  });

  it('asks for a fresh answer rather than a cached one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(releaseResponse('1.0.0'));
    vi.stubGlobal('fetch', fetchMock);

    await new PyPiProvider().verify(contextWith(), '1.0.0');

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['cache-control']).toBe('no-cache');
  });

  it('links to the canonical project page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(releaseResponse('1.0.0')));

    const result = await new PyPiProvider().verify(contextWith({ package: 'Acme.SDK' }), '1.0.0');

    expect(result.observed.reference).toBe('https://pypi.org/project/acme-sdk/');
  });
});

describe('getVersion', () => {
  it('reports the newest published version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ releases: { '0.1.0': [], '0.2.0': [], '0.10.0': [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await new PyPiProvider().getVersion(contextWith());

    expect(result.version).toBe('0.10.0');
  });

  it('reports nothing for a project that does not exist', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));

    const result = await new PyPiProvider().getVersion(contextWith());

    expect(result.version).toBeNull();
  });

  it('raises rather than reporting nothing when the registry fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(NO_RESPONSE));

    await expect(new PyPiProvider().getVersion(contextWith())).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});

describe('upload error normalisation', () => {
  it('reads a duplicate as a duplicate', () => {
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      'HTTPError: 409 Conflict File already exists.',
    );

    expect(error.code).toBe('DUPLICATE_RELEASE');
    expect(error.remediation).toMatch(/does not allow re-uploading/i);
  });

  it('prefers a duplicate over an auth reading when both appear', () => {
    // A scoped-name duplicate can carry both phrases, and "your token is broken"
    // is the wrong advice when the token is fine.
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      'HTTPError: 409 Conflict\nFile already exists.\n403 Forbidden',
    );

    expect(error.code).toBe('DUPLICATE_RELEASE');
  });

  it.each([
    'HTTPError: 401 Client Error: Invalid or non-existent authentication token',
    'Please access the PyPI API using username and password',
  ])('reads %s as an auth failure', (output) => {
    expect(normalizeUploadError('acme', '1.0.0', output).code).toBe('AUTH_FAILED');
  });

  it('distinguishes a permission problem from a bad token', () => {
    // 403 means the token is valid but not scoped to this project — different
    // advice from "your token is wrong".
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      'HTTPError: 403 Forbidden User is not permitted',
    );

    expect(error.code).toBe('AUTH_FAILED');
    expect(error.remediation).toMatch(/project-scoped|manage\/account/);
  });

  it('names an unusable repository URL', () => {
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      'ERROR UnreachableRepositoryURLDetected: Invalid repository URL: host was required',
    );

    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.remediation).toMatch(/upload\.pypi\.org/);
  });

  it('recognises twine failing to start', () => {
    // Retrying cannot fix a broken install, and "run twine --verbose" would not
    // tell the user what is actually wrong.
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      "ImportError: cannot import name 'errors' from 'packaging'",
    );

    expect(error.code).toBe('CHECK_FAILED');
    expect(error.remediation).toMatch(/twine --version|PYTHONPATH/);
  });

  it('names a rejected distribution as a packaging problem', () => {
    const error = normalizeUploadError(
      'acme',
      '1.0.0',
      'HTTPError: 400 Bad Request Invalid distribution filename',
    );

    expect(error.code).toBe('PROVIDER_FAILED');
    expect(error.remediation).toMatch(/pyproject\.toml/);
  });

  it('reports having nothing to upload', () => {
    const error = normalizeUploadError('acme', '1.0.0', 'ERROR No files found');

    expect(error.remediation).toMatch(/forge pypi build/);
  });

  it('falls back to a generic provider error', () => {
    const error = normalizeUploadError('acme', '1.0.0', 'ERROR something nobody has seen');

    expect(error.code).toBe('PROVIDER_FAILED');
    expect(error.remediation).toMatch(/--verbose/);
  });

  it('handles empty output without crashing', () => {
    expect(() => normalizeUploadError('acme', '1.0.0', '')).not.toThrow();
  });
});
