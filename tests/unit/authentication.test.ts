import { describe, expect, it } from 'vitest';

import {
  requireCredential,
  resolveCredential,
  resolveFromEnv,
  resolveGitHub,
} from '../../src/authentication/index.js';
import { AuthError } from '../../src/errors/index.js';

describe('resolveFromEnv', () => {
  it('reports a present credential without returning its value', () => {
    const credential = resolveFromEnv({ NPM_TOKEN: 'npm_secrettoken1234567890' }, 'NPM_TOKEN');

    expect(credential.present).toBe(true);
    expect(credential.source).toBe('environment');
    expect(credential.envVar).toBe('NPM_TOKEN');
    // The struct must not carry the secret — that is the whole point of it.
    expect(JSON.stringify(credential)).not.toContain('secrettoken');
  });

  it('treats an unset variable as absent', () => {
    const credential = resolveFromEnv({}, 'NPM_TOKEN');

    expect(credential.present).toBe(false);
    expect(credential.source).toBe('absent');
  });

  it('treats an empty variable as absent', () => {
    // An empty token would produce a confusing 401 rather than a clear message.
    expect(resolveFromEnv({ NPM_TOKEN: '' }, 'NPM_TOKEN').present).toBe(false);
  });
});

describe('resolveCredential', () => {
  it('resolves each provider from its documented variable', () => {
    const env = { GITHUB_TOKEN: 'ghp_x', NPM_TOKEN: 'npm_x', PYPI_TOKEN: 'pypi-x' };

    expect(resolveCredential('npm', env).envVar).toBe('NPM_TOKEN');
    expect(resolveCredential('pypi', env).envVar).toBe('PYPI_TOKEN');
    expect(resolveCredential('github', env).envVar).toBe('GITHUB_TOKEN');
  });

  it('does not consult gh for non-GitHub providers', () => {
    expect(resolveCredential('npm', {}).present).toBe(false);
  });
});

describe('resolveGitHub', () => {
  it('prefers the environment variable when set', () => {
    const credential = resolveGitHub({ GITHUB_TOKEN: 'ghp_fromenv1234567890' });

    expect(credential.present).toBe(true);
    expect(credential.source).toBe('environment');
  });

  it('reports absent when neither source is available', () => {
    // CI has no gh CLI and no token, so this is the common case there.
    const credential = resolveGitHub({});

    // Either the gh fallback found something on this machine, or nothing did.
    if (credential.present) {
      expect(credential.source).toBe('tool');
    } else {
      expect(credential.source).toBe('absent');
      expect(credential.envVar).toBe('GITHUB_TOKEN');
    }
  });

  it('never exposes the token in the returned struct', () => {
    const credential = resolveGitHub({ GITHUB_TOKEN: 'ghp_1234567890abcdefghijklmnop' });

    expect(JSON.stringify(credential)).not.toContain('1234567890abcdefghijklmnop');
  });
});

describe('requireCredential', () => {
  it('returns silently when present', () => {
    const credential = resolveFromEnv({ NPM_TOKEN: 'npm_x123456' }, 'NPM_TOKEN');
    expect(() => requireCredential('npm', credential)).not.toThrow();
  });

  it('throws AUTH_MISSING_CREDENTIALS naming the variable', () => {
    const credential = resolveFromEnv({}, 'PYPI_TOKEN');

    try {
      requireCredential('pypi', credential);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AuthError);
      const authError = error as AuthError;
      expect(authError.code).toBe('AUTH_MISSING_CREDENTIALS');
      expect(authError.remediation).toContain('PYPI_TOKEN');
      expect(authError.provider).toBe('pypi');
    }
  });

  it('suggests gh auth login for GitHub', () => {
    try {
      requireCredential('github', { present: false, source: 'absent', envVar: 'GITHUB_TOKEN' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AuthError).remediation).toMatch(/gh auth login/);
    }
  });

  it('does not leak the expected value into the error', () => {
    try {
      requireCredential('npm', { present: false, source: 'absent', envVar: 'NPM_TOKEN' });
      expect.unreachable('should have thrown');
    } catch (error) {
      // A missing credential has no value to leak, but the message must not
      // invent one either.
      expect((error as AuthError).message).toBe('No npm credentials found.');
    }
  });
});
