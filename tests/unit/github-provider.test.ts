/**
 * GitHub provider tests.
 *
 * Network calls are stubbed by injecting a fake executor, so these run offline
 * and deterministically. Live-GitHub coverage is opt-in via FORGE_LIVE_GITHUB=1
 * and is not part of the default suite.
 */

import { describe, expect, it, vi } from 'vitest';

import { GitHubProvider, PROVIDER_NAME } from '../../src/providers/github/index.js';
import {
  extractSection,
  generateNotes,
  notesFromChangelog,
} from '../../src/providers/github/notes.js';
import { parseRelease, ghHttpStatus } from '../../src/providers/github/client.js';
import { Capability, type ProviderContext } from '../../src/core/provider.js';
import { DuplicateReleaseError, ProviderError } from '../../src/errors/index.js';
import { build } from '../../src/configuration/resolve.js';
import { parseRemoteUrl } from '../../src/build/git.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Build a context whose `gh` calls are answered by a scripted table.
 *
 * The runner dispatches on the command name first. That matters because the
 * provider also runs `git` through the same context, and matching only on
 * argument text would hand a `git rev-parse` call a scripted `gh` response.
 */
function makeContext(
  responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>,
  overrides: { projectRoot?: string; dryRun?: boolean } = {},
): ProviderContext {
  const raw = {
    project: { name: 'test' },
    version: { strategy: 'semver', file: null, tagPrefix: 'v' },
    github: {
      enabled: true,
      repository: 'Acme/repo',
      draft: false,
      prerelease: false,
      notesTemplate: null,
    },
    npm: { enabled: false },
    pypi: { enabled: false },
    checks: {},
    order: ['github'],
  };
  const config = build(raw, overrides.projectRoot ?? '/tmp/test-project');

  return {
    projectRoot: overrides.projectRoot ?? '/tmp/test-project',
    config: config as unknown as Record<string, unknown>,
    getSecret: () => undefined,
    dryRun: overrides.dryRun ?? false,
    execute: {
      run: async (command: string, args: readonly string[]) => {
        const respond = (stdout: string, exitCode = 0, stderr = '') => ({
          exitCode,
          stdout,
          stderr,
        });

        // git is stubbed separately: the provider reads working-tree state.
        if (command === 'git') {
          if (args.includes('--is-inside-work-tree')) return respond('true\n');
          return respond('');
        }

        // Longest matching key wins, so a specific endpoint beats a prefix.
        // The needle is matched against the joined args, because a scripted key
        // like 'api user' spans two separate argv entries (`api`, `user`).
        const joined = args.join(' ');
        let best: {
          response: { stdout?: string; stderr?: string; exitCode?: number };
          length: number;
        } | null = null;
        for (const [needle, response] of Object.entries(responses)) {
          if (joined.includes(needle) && (best === null || needle.length > best.length)) {
            best = { response, length: needle.length };
          }
        }

        if (best === null) return respond('');
        return respond(
          best.response.stdout ?? '',
          best.response.exitCode ?? 0,
          best.response.stderr ?? '',
        );
      },
    },
  };
}

const WHOAMI = { 'api user': { stdout: JSON.stringify({ login: 'tester', id: 1 }) } };

describe('GitHubProvider.capabilities', () => {
  it('declares what it supports', () => {
    const caps = new GitHubProvider().capabilities();

    expect(caps.name).toBe(PROVIDER_NAME);
    expect(caps.capabilities).toContain(Capability.Releases);
    expect(caps.capabilities).toContain(Capability.Tags);
    expect(caps.capabilities).toContain(Capability.Verify);
    // It does not publish packages.
    expect(caps.capabilities).not.toContain(Capability.Package);
  });

  it('reports its version sources', () => {
    expect(new GitHubProvider().capabilities().versionSources).toContain('git tags');
  });
});

describe('GitHubProvider.authenticate', () => {
  it('returns the authenticated identity', async () => {
    const result = await new GitHubProvider().authenticate(makeContext(WHOAMI));

    expect(result.authenticated).toBe(true);
    expect(result.identity).toBe('tester');
  });

  it('does not include the token in its result', async () => {
    const ctx = { ...makeContext(WHOAMI), getSecret: () => 'ghp_secrettoken1234567890' };
    const result = await new GitHubProvider().authenticate(ctx);

    expect(JSON.stringify(result)).not.toContain('ghp_secrettoken');
  });

  it('throws AUTH_FAILED when gh rejects the credential', async () => {
    const ctx = makeContext({ 'api user': { exitCode: 1, stderr: 'HTTP 401: Bad credentials' } });

    await expect(new GitHubProvider().authenticate(ctx)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });
});

describe('GitHubProvider.validate', () => {
  it('resolves when the repository is readable', async () => {
    const ctx = makeContext({
      ...WHOAMI,
      'repos/Acme/repo': { stdout: JSON.stringify({ full_name: 'Acme/repo' }) },
      'rev-parse --is-inside-work-tree': { stdout: 'true\n' },
    });

    await expect(new GitHubProvider().validate(ctx)).resolves.toBeUndefined();
  });

  it('throws when the repository does not exist', async () => {
    const ctx = makeContext({ 'repos/Acme/repo': { exitCode: 1, stderr: 'HTTP 404: Not Found' } });

    await expect(new GitHubProvider().validate(ctx)).rejects.toThrow(/was not found/);
  });

  it('reports a 403 as an auth problem', async () => {
    const ctx = makeContext({ 'repos/Acme/repo': { exitCode: 1, stderr: 'HTTP 403: Forbidden' } });

    await expect(new GitHubProvider().validate(ctx)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('skips the network call in dry-run', async () => {
    const run = vi.fn();
    const ctx = { ...makeContext({}), dryRun: true };
    ctx.execute.run = run as never;

    await new GitHubProvider().validate(ctx);

    expect(run).not.toHaveBeenCalled();
  });
});

describe('GitHubProvider.getVersion', () => {
  it('returns the latest tag', async () => {
    const ctx = makeContext({
      'repos/Acme/repo/tags': {
        stdout: JSON.stringify([{ name: 'v1.2.0', commit: { sha: 'abc' } }]),
      },
    });

    const observed = await new GitHubProvider().getVersion(ctx);

    expect(observed.version).toBe('v1.2.0');
    expect(observed.provider).toBe(PROVIDER_NAME);
  });

  it('returns null when the repository has no tags', async () => {
    const ctx = makeContext({ 'repos/Acme/repo/tags': { stdout: '[]' } });

    expect((await new GitHubProvider().getVersion(ctx)).version).toBeNull();
  });
});

describe('GitHubProvider.publish', () => {
  const RELEASE = JSON.stringify({
    tag_name: 'v1.0.0',
    name: 'v1.0.0',
    html_url: 'https://github.com/Acme/repo/releases/tag/v1.0.0',
    draft: false,
    prerelease: false,
    assets: [],
  });

  it('creates a release and returns its URL', async () => {
    const ctx = makeContext({
      'git/ref/tags/': { exitCode: 1, stderr: 'HTTP 404: Not Found' }, // tag absent
      'releases/tags/': { exitCode: 1, stderr: 'HTTP 404: Not Found' }, // no existing release
      '--method': { stdout: RELEASE },
    });

    const result = await new GitHubProvider().publish(ctx, { version: '1.0.0' });

    expect(result.published).toBe(true);
    expect(result.reference).toBe('https://github.com/Acme/repo/releases/tag/v1.0.0');
  });

  it('refuses when the tag already exists remotely', async () => {
    const ctx = makeContext({ 'git/ref/tags/v1.0.0': { stdout: '{"ref":"refs/tags/v1.0.0"}' } });

    await expect(new GitHubProvider().publish(ctx, { version: '1.0.0' })).rejects.toThrow(
      DuplicateReleaseError,
    );
  });

  it('refuses when a release already exists for the tag', async () => {
    const ctx = makeContext({
      'git/ref/tags/': { exitCode: 1, stderr: 'HTTP 404: Not Found' },
      'releases/tags/v1.0.0': { stdout: RELEASE },
    });

    await expect(new GitHubProvider().publish(ctx, { version: '1.0.0' })).rejects.toThrow(
      DuplicateReleaseError,
    );
  });

  it('makes no changes in dry-run', async () => {
    const run = vi.fn();
    const ctx = { ...makeContext({}), dryRun: true };
    ctx.execute.run = run as never;

    const result = await new GitHubProvider().publish(ctx, { version: '1.0.0' });

    expect(result.published).toBe(false);
    expect(result.reference).toMatch(/^dry-run:/);
    expect(run).not.toHaveBeenCalled();
  });

  it('uses the configured tag prefix', async () => {
    const calls: string[][] = [];
    const ctx = makeContext({
      'git/ref/tags/': { exitCode: 1, stderr: 'HTTP 404: Not Found' },
      '--method': { stdout: RELEASE },
    });
    // Record the args, then delegate to the original stub. The original is
    // captured first: `ctx.execute` is the same object whose `run` is being
    // replaced, so delegating to `ctx.execute.run` would call this wrapper.
    const original = ctx.execute.run.bind(ctx.execute);
    ctx.execute.run = (c: string, a: readonly string[]) => {
      calls.push([...a]);
      return original(c, a);
    };

    await new GitHubProvider().publish(ctx, { version: '1.0.0' });
    expect(JSON.stringify(calls)).toContain('v1.0.0');
  });
});

describe('GitHubProvider.verify', () => {
  it('passes when tag, release, and version all agree', async () => {
    const ctx = makeContext({
      'git/ref/tags/v1.0.0': { stdout: '{"ref":"refs/tags/v1.0.0"}' },
      'releases/tags/v1.0.0': {
        stdout: JSON.stringify({
          tag_name: 'v1.0.0',
          html_url: 'https://github.com/Acme/repo/releases/tag/v1.0.0',
          draft: false,
          prerelease: false,
          assets: [],
        }),
      },
    });

    const result = await new GitHubProvider().verify(ctx, '1.0.0');

    expect(result.verified).toBe(true);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('fails when the release is missing', async () => {
    const ctx = makeContext({
      'git/ref/tags/v1.0.0': { stdout: '{"ref":"refs/tags/v1.0.0"}' },
      'releases/tags/v1.0.0': { exitCode: 1, stderr: 'HTTP 404: Not Found' },
    });

    const result = await new GitHubProvider().verify(ctx, '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'release-exists')?.passed).toBe(false);
  });

  it('fails when the tag is missing', async () => {
    const ctx = makeContext({
      'git/ref/tags/v1.0.0': { exitCode: 1, stderr: 'HTTP 404: Not Found' },
      'releases/tags/v1.0.0': { exitCode: 1, stderr: 'HTTP 404: Not Found' },
    });

    const result = await new GitHubProvider().verify(ctx, '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'tag-exists')?.passed).toBe(false);
  });

  it('fails when the release is still a draft', async () => {
    const ctx = makeContext({
      'git/ref/tags/v1.0.0': { stdout: '{}' },
      'releases/tags/v1.0.0': {
        stdout: JSON.stringify({ tag_name: 'v1.0.0', draft: true, assets: [] }),
      },
    });

    const result = await new GitHubProvider().verify(ctx, '1.0.0');

    expect(result.verified).toBe(false);
    expect(result.checks.find((c) => c.name === 'release-is-published')?.passed).toBe(false);
  });

  it('detects a version mismatch', async () => {
    const ctx = makeContext({
      'git/ref/tags/v1.0.0': { stdout: '{}' },
      'releases/tags/v1.0.0': {
        stdout: JSON.stringify({ tag_name: 'v9.9.9', draft: false, assets: [] }),
      },
    });

    const result = await new GitHubProvider().verify(ctx, '1.0.0');

    expect(result.verified).toBe(false);
    const check = result.checks.find((c) => c.name === 'release-version-matches');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain('v9.9.9');
  });
});

describe('GitHubProvider repository resolution', () => {
  it('uses the configured repository', async () => {
    const ctx = makeContext({ 'repos/Acme/repo': { stdout: '{}' } });
    await expect(new GitHubProvider().validate(ctx)).resolves.toBeUndefined();
  });

  it('throws PROVIDER_FAILED when nothing is configured or detectable', async () => {
    const ctx = makeContext({ 'rev-parse': { exitCode: 128 } });
    // Strip the configured repository.
    (ctx.config as Record<string, unknown>)['github'] = { enabled: true, repository: null };

    await expect(new GitHubProvider().validate(ctx)).rejects.toThrow(ProviderError);
  });
});

describe('parseRemoteUrl', () => {
  it.each([
    ['git@github.com:owner/name.git', 'owner/name'],
    ['https://github.com/owner/name.git', 'owner/name'],
    ['https://github.com/owner/name', 'owner/name'],
    ['ssh://git@github.com/owner/name.git', 'owner/name'],
    ['git@github.com:owner/name', 'owner/name'],
  ])('parses %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toBe(expected);
  });

  it('returns null for junk', () => {
    expect(parseRemoteUrl('')).toBeNull();
    expect(parseRemoteUrl('not a url')).toBeNull();
  });
});

describe('parseRelease', () => {
  it('maps the API shape', () => {
    const release = parseRelease({
      tag_name: 'v1.0.0',
      name: 'Release 1',
      draft: false,
      prerelease: true,
      html_url: 'https://example.test',
      published_at: '2026-01-01T00:00:00Z',
      assets: [{ name: 'a.tgz', size: 42, browser_download_url: 'https://example.test/a.tgz' }],
    });

    expect(release.tagName).toBe('v1.0.0');
    expect(release.isPrerelease).toBe(true);
    expect(release.assets).toHaveLength(1);
    expect(release.assets[0]?.name).toBe('a.tgz');
  });

  it('tolerates a missing assets array', () => {
    expect(parseRelease({ tag_name: 'v1' }).assets).toEqual([]);
  });
});

describe('ghHttpStatus', () => {
  it.each([
    ['HTTP 404: Not Found', 404],
    ['gh: Not Found (HTTP 403)', 403],
    ['401 Unauthorized', 401],
  ])('extracts %s', (text, expected) => {
    expect(ghHttpStatus(text)).toBe(expected);
  });

  it('returns null when there is no status', () => {
    expect(ghHttpStatus('something went wrong')).toBeNull();
  });
});

describe('release notes', () => {
  const CHANGELOG = `# Changelog

## [1.2.0] — 2026-01-02

### Added
- A new thing

## [1.1.0] — 2026-01-01

### Fixed
- An old thing
`;

  it('extracts a bracketed version section', () => {
    const section = extractSection(CHANGELOG, '1.2.0');

    expect(section).toContain('A new thing');
    expect(section).not.toContain('An old thing');
  });

  it('stops at the next heading of the same level', () => {
    const section = extractSection(CHANGELOG, '1.1.0');

    expect(section).toContain('An old thing');
    expect(section?.trim().endsWith('An old thing')).toBe(true);
  });

  it('returns null for a version that is not present', () => {
    expect(extractSection(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('matches an unbracketed heading', () => {
    const section = extractSection('# Changelog\n\n## 2.0.0\n\nBody here\n', '2.0.0');
    expect(section).toContain('Body here');
  });

  it('reads the changelog from a project directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));
    writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);

    // Changelog headings are written without the tag prefix: `## [1.2.0]`, not
    // `## [v1.2.0]`. The lookup therefore strips the prefix before matching.
    const notes = notesFromChangelog({ version: '1.2.0', tagPrefix: 'v', projectRoot: dir });

    expect(notes).not.toBeNull();
    expect(notes).toContain('A new thing');
  });

  it('prefers an explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));
    writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);

    const notes = generateNotes({
      version: '1.2.0',
      tagPrefix: 'v',
      projectRoot: dir,
      override: 'Hand-written notes',
    });

    expect(notes).toBe('Hand-written notes');
  });

  it('renders a configured template with placeholders substituted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));
    writeFileSync(join(dir, 'TEMPLATE.md'), 'Version {{version}} tagged {{tag}} on {{date}}');

    const notes = generateNotes({
      version: '3.0.0',
      tagPrefix: 'v',
      projectRoot: dir,
      templatePath: 'TEMPLATE.md',
    });

    expect(notes).toContain('Version 3.0.0');
    expect(notes).toContain('tagged v3.0.0');
    expect(notes).not.toContain('{{');
  });

  it('falls back rather than failing when there is no changelog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));

    const notes = generateNotes({ version: '1.0.0', tagPrefix: 'v', projectRoot: dir });

    expect(notes).toContain('v1.0.0');
    expect(notes).toContain('Forge');
  });

  it('falls back when the configured template is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));

    const notes = generateNotes({
      version: '1.0.0',
      tagPrefix: 'v',
      projectRoot: dir,
      templatePath: 'does-not-exist.md',
    });

    expect(notes).toContain('v1.0.0');
  });
});
