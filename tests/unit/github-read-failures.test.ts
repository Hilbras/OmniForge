/**
 * Regression: a failed read must not be reported as a missing resource.
 *
 * `tagExistsRemote` and `getRelease` used to return `false`/`null` for *any*
 * non-zero exit, which made a rejected token indistinguishable from a tag that
 * genuinely does not exist. The integrity check then advised re-publishing a
 * release that was published and fine — the worst possible answer, because it
 * sends the user to do more publishing on top of a working setup.
 *
 * Only 404 (and, for a bare network failure with no status, a conservative null)
 * may mean "absent". Everything else must surface as an error.
 */

import { describe, expect, it } from 'vitest';

import { getRelease, tagExistsRemote } from '../../src/providers/github/client.js';
import { AuthError, ForgeError } from '../../src/errors/index.js';

type Result = { exitCode: number; stdout: string; stderr: string };

/** A runner returning one canned `gh` result. */
function runner(result: Result) {
  return () => Promise.resolve(result);
}

const NOT_FOUND: Result = {
  exitCode: 1,
  stdout: '{"message":"Not Found","status":"404"}',
  stderr: 'gh: Not Found (HTTP 404)',
};

const BAD_CREDENTIALS: Result = {
  exitCode: 1,
  stdout: '{"message":"Bad credentials","status":"401"}',
  stderr: 'gh: Bad credentials (HTTP 401)',
};

const FORBIDDEN: Result = {
  exitCode: 1,
  stdout: '{"message":"Forbidden","status":"403"}',
  stderr: 'gh: Forbidden (HTTP 403)',
};

const SERVER_ERROR: Result = {
  exitCode: 1,
  stdout: '{"message":"Server Error","status":"500"}',
  stderr: 'gh: Server Error (HTTP 500)',
};

const OK_TAG = '{"ref":"refs/tags/v1.0.0"}';
const OK_RELEASE = JSON.stringify({
  tag_name: 'v1.0.0',
  html_url: 'https://github.com/a/b/releases/tag/v1.0.0',
  draft: false,
  prerelease: false,
});

describe('tagExistsRemote', () => {
  it('is true when the tag is found', async () => {
    const exists = await tagExistsRemote('a/b', 'v1.0.0', {
      runner: runner({ exitCode: 0, stdout: OK_TAG, stderr: '' }),
    } as never);

    expect(exists).toBe(true);
  });

  it('is false only on 404', async () => {
    const exists = await tagExistsRemote('a/b', 'v1.0.0', { runner: runner(NOT_FOUND) } as never);

    expect(exists).toBe(false);
  });

  it.each([BAD_CREDENTIALS, FORBIDDEN, SERVER_ERROR])(
    'throws on an HTTP error rather than reporting the tag missing',
    async (result) => {
      await expect(
        tagExistsRemote('a/b', 'v1.0.0', { runner: runner(result) } as never),
      ).rejects.toBeInstanceOf(ForgeError);
    },
  );

  it('reports a rejected token as an auth failure', async () => {
    try {
      await tagExistsRemote('a/b', 'v1.0.0', { runner: runner(BAD_CREDENTIALS) } as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_FAILED');
    }
  });

  it('tells the user to check auth, not to re-publish', async () => {
    try {
      await tagExistsRemote('a/b', 'v1.0.0', { runner: runner(BAD_CREDENTIALS) } as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      // "Re-publish" advice here would be actively harmful.
      expect((error as AuthError).remediation).toMatch(/auth status/i);
      expect((error as AuthError).remediation).not.toMatch(/re-publish/i);
    }
  });

  it('throws when the request never completed', async () => {
    // No HTTP status at all: a timeout or a DNS failure. Still not "absent".
    const failed: Result = { exitCode: 1, stdout: '', stderr: 'dial tcp: connection refused' };

    await expect(
      tagExistsRemote('a/b', 'v1.0.0', { runner: runner(failed) } as never),
    ).rejects.toBeInstanceOf(ForgeError);
  });
});

describe('getRelease', () => {
  it('returns the release when it exists', async () => {
    const release = await getRelease('a/b', 'v1.0.0', {
      runner: runner({ exitCode: 0, stdout: OK_RELEASE, stderr: '' }),
    } as never);

    expect(release?.tagName).toBe('v1.0.0');
  });

  it('is null on 404', async () => {
    const release = await getRelease('a/b', 'v1.0.0', { runner: runner(NOT_FOUND) } as never);

    expect(release).toBeNull();
  });

  it.each([BAD_CREDENTIALS, FORBIDDEN, SERVER_ERROR])(
    'throws on an HTTP error rather than reporting the release missing',
    async (result) => {
      await expect(
        getRelease('a/b', 'v1.0.0', { runner: runner(result) } as never),
      ).rejects.toBeInstanceOf(ForgeError);
    },
  );

  it('reports a rejected token as an auth failure', async () => {
    try {
      await getRelease('a/b', 'v1.0.0', { runner: runner(BAD_CREDENTIALS) } as never);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
    }
  });
});
