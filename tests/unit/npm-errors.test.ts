/**
 * npm error normalization.
 *
 * npm reports failures as free text in stderr with an error code on a separate
 * line, and the codes are not documented. This function is the only place Forge
 * turns that prose into a typed error, so it decides whether a user is told
 * "you already published this" or "your token is invalid" — advice that sends
 * them to opposite places.
 *
 * The test cases below are real npm output, not invented strings.
 */

import { describe, expect, it } from 'vitest';

import { normalizePublishError, validatePackageName } from '../../src/providers/npm/client.js';
import {
  AuthError,
  DuplicateReleaseError,
  ForgeError,
  ProviderError,
} from '../../src/errors/index.js';

describe('normalizePublishError', () => {
  describe('an already-published version is a duplicate', () => {
    it.each([
      ['E409 plain', 'npm error code E409'],
      ['cannot publish over', 'You cannot publish over the previously published versions: 1.0.0'],
      ['previously published', 'Cannot publish over previously published versions'],
      ['npmjs phrasing', 'You cannot publish over the previously published versions: 1.0.0.'],
    ])('recognises %s', (_label, output) => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', output);

      expect(error).toBeInstanceOf(DuplicateReleaseError);
      expect(error.message).toContain('@acme/sdk@1.0.0');
    });

    it('is not mistaken for an auth failure', () => {
      // npm emits 403 alongside E409 for a duplicate on a scoped package. The
      // duplicate must win, or the user is told to fix a working token.
      const error = normalizePublishError(
        '@acme/sdk',
        '1.0.0',
        'npm ERR! code E409\nnpm ERR! You cannot publish over the previously published versions: 1.0.0.\nnpm ERR! 403 Forbidden',
      );

      expect(error).toBeInstanceOf(DuplicateReleaseError);
      expect(error).not.toBeInstanceOf(AuthError);
    });

    it('says npm versions are immutable', () => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', 'code E409');

      expect(error.remediation).toMatch(/does not allow overwriting|higher one/i);
    });
  });

  describe('an auth failure is an auth failure', () => {
    it.each([
      ['ENEEDAUTH', 'npm ERR! code ENEEDAUTH'],
      ['need auth', 'You need to be logged in to publish'],
      ['must be logged in', 'You must be logged in to publish packages'],
      ['403 forbidden', 'npm ERR! 403 Forbidden - PUT https://registry.npmjs.org/@acme%2fsdk'],
    ])('recognises %s', (_label, output) => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', output);

      expect(error).toBeInstanceOf(AuthError);
      expect(error.code).toBe('AUTH_FAILED');
    });

    it('mentions 2FA, which is the usual cause on a scoped package', () => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', 'code ENEEDAUTH');

      expect(error.remediation).toMatch(/2FA|auth-and-publish/i);
    });

    it('is case-insensitive', () => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', 'NPM ERR! CODE ENEEDAUTH');

      expect(error).toBeInstanceOf(AuthError);
    });

    it('truncates a huge stderr rather than storing it whole', () => {
      const error = normalizePublishError(
        '@acme/sdk',
        '1.0.0',
        `code ENEEDAUTH ${'x'.repeat(20_000)}`,
      );

      expect((error.detail as { output: string }).output.length).toBeLessThanOrEqual(400);
    });
  });

  describe('other npm errors keep their meaning', () => {
    it('recognises a payment requirement', () => {
      const error = normalizePublishError(
        '@acme/sdk',
        '1.0.0',
        'npm ERR! code E402 Payment required',
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toMatch(/payment/i);
      expect(error.remediation).toMatch(/paid plan/i);
    });

    it('recognises a missing package', () => {
      const error = normalizePublishError(
        '@acme/nope',
        '1.0.0',
        'npm ERR! code E404 404 Not Found',
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.remediation).toMatch(/forge.config.yaml/);
    });

    it('falls back to a generic provider error', () => {
      const error = normalizePublishError(
        '@acme/sdk',
        '1.0.0',
        'npm ERR! something nobody has seen before',
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).not.toBeInstanceOf(DuplicateReleaseError);
      expect(error).not.toBeInstanceOf(AuthError);
    });

    it('suggests running npm manually for the unexplained case', () => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', 'npm ERR! mystery');

      expect(error.remediation).toMatch(/npm publish.*manually/i);
    });

    it('handles empty output without crashing', () => {
      const error = normalizePublishError('@acme/sdk', '1.0.0', '');

      expect(error).toBeInstanceOf(ForgeError);
    });

    it('recognises an unresolvable version', () => {
      // Captured from real npm output: publishing a version the registry cannot
      // resolve produces ETARGET, which previously fell through to the generic
      // "run npm manually" branch.
      const error = normalizePublishError(
        '@hilbras/forge',
        '0.0.0-nonexistent',
        'npm error code ETARGET\nnpm error notarget No matching version found for @hilbras/forge@0.0.0-nonexistent.',
      );

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).toMatch(/could not resolve/i);
      expect(error).not.toBeInstanceOf(AuthError);
    });

    it('is a ForgeError in every branch', () => {
      for (const output of ['E409', 'ENEEDAUTH', 'E402', 'E404', 'unknown']) {
        expect(normalizePublishError('@acme/sdk', '1.0.0', output)).toBeInstanceOf(ForgeError);
      }
    });
  });
});

describe('validatePackageName', () => {
  it.each(['@acme/sdk', 'acme', 'acme-sdk', 'acme.sdk', 'acme_sdk', 'a', '@a/b', 'Acme'])(
    'accepts %s',
    (name) => {
      expect(validatePackageName(name)).toBeNull();
    },
  );

  it.each(['has space', '@acme', 'acme/', '/acme', '@/sdk', '@/'])('rejects %s', (name) => {
    expect(validatePackageName(name)).toBeTruthy();
  });

  it('rejects an empty scope', () => {
    // '@/sdk' looked unscoped-and-valid once the '@' was read as a prefix.
    expect(validatePackageName('@/sdk')).toMatch(/scope/i);
  });

  it('rejects a name longer than npm allows', () => {
    expect(validatePackageName('a'.repeat(215))).toMatch(/214/);
  });

  it('explains why a name is rejected', () => {
    expect(validatePackageName('has space')).toMatch(/npm does not allow/);
  });
});
