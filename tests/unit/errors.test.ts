import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ConfigError,
  DuplicateReleaseError,
  ErrorCode,
  ForgeError,
  isForgeError,
  toForgeError,
  VerificationError,
} from '../../src/errors/index.js';

describe('ForgeError', () => {
  it('carries a code, operation, provider, and remediation', () => {
    const error = new ForgeError(ErrorCode.UNKNOWN, 'boom', {
      operation: 'npm.publish',
      provider: 'npm',
      remediation: 'Check the token.',
    });

    expect(error.code).toBe(ErrorCode.UNKNOWN);
    expect(error.operation).toBe('npm.publish');
    expect(error.provider).toBe('npm');
    expect(error.remediation).toBe('Check the token.');
  });

  it('formats with what failed, what it affected, and the next step', () => {
    const text = new ForgeError(ErrorCode.PROVIDER_FAILED, 'publish failed', {
      operation: 'npm.publish',
      provider: 'npm',
      remediation: 'Check the token.',
    }).format();

    expect(text).toContain('✗ publish failed');
    expect(text).toContain('Operation:  npm.publish');
    expect(text).toContain('Provider:   npm');
    expect(text).toContain('Code:       PROVIDER_FAILED');
    expect(text).toContain('Next step:  Check the token.');
  });

  it('omits absent optional fields from format()', () => {
    const text = new ForgeError(ErrorCode.UNKNOWN, 'bare').format();
    expect(text).not.toContain('Operation:');
    expect(text).not.toContain('Provider:');
    expect(text).not.toContain('Next step:');
  });

  it('serializes to JSON without the cause chain', () => {
    const json = new ForgeError(ErrorCode.NETWORK_ERROR, 'down', {
      cause: new Error('ECONNREFUSED 10.0.0.1:443'),
      detail: { host: 'registry.npmjs.org' },
    }).toJSON();

    expect(json['code']).toBe('NETWORK_ERROR');
    expect(json['detail']).toEqual({ host: 'registry.npmjs.org' });
    expect(JSON.stringify(json)).not.toContain('ECONNREFUSED');
  });

  it('sets name to the concrete subclass', () => {
    expect(new ConfigError(ErrorCode.CONFIG_INVALID, 'bad').name).toBe('ConfigError');
    expect(new VerificationError(ErrorCode.INTEGRITY_FAILED, 'mismatch').name).toBe(
      'VerificationError',
    );
  });
});

describe('subclass defaults', () => {
  it('gives AuthError a default remediation', () => {
    const error = new AuthError(ErrorCode.AUTH_MISSING_CREDENTIALS, 'no token');
    expect(error.remediation).toMatch(/environment/i);
  });

  it('lets AuthError remediation be overridden', () => {
    const error = new AuthError(ErrorCode.AUTH_FAILED, 'bad token', {
      remediation: 'Run `gh auth login`.',
    });
    expect(error.remediation).toBe('Run `gh auth login`.');
  });

  it('gives DuplicateReleaseError a default remediation', () => {
    expect(new DuplicateReleaseError('v1.0.0 exists').remediation).toMatch(/higher version/i);
  });
});

describe('toForgeError', () => {
  it('passes ForgeError through unchanged', () => {
    const original = new ConfigError(ErrorCode.CONFIG_INVALID, 'x');
    expect(toForgeError(original)).toBe(original);
  });

  it('wraps a plain Error, preserving its message', () => {
    const wrapped = toForgeError(new Error('kaboom'));
    expect(wrapped).toBeInstanceOf(ForgeError);
    expect(wrapped.code).toBe(ErrorCode.UNKNOWN);
    expect(wrapped.message).toBe('kaboom');
  });

  it('wraps a thrown string', () => {
    expect(toForgeError('bad input').message).toBe('bad input');
  });

  it('uses the fallback for an empty throw', () => {
    expect(toForgeError(undefined, 'fallback').message).toBe('fallback');
  });

  it('records a non-Error throw in detail', () => {
    expect(toForgeError({ weird: true }).detail).toEqual({ thrown: '[object Object]' });
  });
});

describe('isForgeError', () => {
  it('is true for ForgeError and false for others', () => {
    expect(isForgeError(new ForgeError(ErrorCode.UNKNOWN, 'x'))).toBe(true);
    expect(isForgeError(new Error('x'))).toBe(false);
    expect(isForgeError('x')).toBe(false);
  });
});
