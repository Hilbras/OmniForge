import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  createRedactor,
  isSecretName,
  maskSecret,
  redact,
} from '../../src/utils/index.js';

describe('isSecretName', () => {
  it.each([
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'PYPI_TOKEN',
    'MY_API_KEY',
    'DB_PASSWORD',
    'SOME_SECRET',
    'AWS_CREDENTIAL',
    'USER_AUTH',
  ])('flags %s', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(['HOME', 'PATH', 'NODE_ENV', 'CI', 'EDITOR'])('does not flag %s', (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSecretName('npm_token')).toBe(true);
    expect(isSecretName('Npm_Token')).toBe(true);
  });
});

describe('maskSecret', () => {
  it('keeps a recognizable prefix', () => {
    expect(maskSecret('ghp_1234567890abcdef')).toBe('ghp_************');
    expect(maskSecret('npm_abcdefghijklmnop')).toBe('npm_************');
    expect(maskSecret('pypi-AgEIcHlwaS5vcmc')).toBe('pypi-************');
  });

  it('fully masks short values, since a partial mask would leak them', () => {
    expect(maskSecret('abcd')).toBe('****');
    expect(maskSecret('12345678')).toBe('********');
  });

  it('handles an empty value', () => {
    expect(maskSecret('')).toBe(REDACTED);
  });

  it('masks the tail of a token with no recognizable prefix', () => {
    const masked = maskSecret('AAAABBBBCCCCDDDD');
    expect(masked).toBe('************');
    expect(masked).not.toContain('AAAA');
  });
});

describe('redact', () => {
  const token = 'ghp_supersecrettoken1234567890';

  it('removes a known secret from arbitrary text', () => {
    const text = `Failed to publish with token ${token} to registry.npmjs.org`;
    const clean = redact(text, [token]);

    expect(clean).not.toContain(token);
    expect(clean).not.toContain('supersecret');
    expect(clean).toContain('registry.npmjs.org');
  });

  it('removes every occurrence, not just the first', () => {
    const clean = redact(`${token} and again ${token}`, [token]);
    expect(clean).not.toContain(token);
    expect(clean.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it('redacts several distinct secrets', () => {
    const a = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa';
    const b = 'npm_bbbbbbbbbbbbbbbbbbbbbbbb';
    const clean = redact(`a=${a} b=${b}`, [a, b]);

    expect(clean).not.toContain(a);
    expect(clean).not.toContain(b);
  });

  it('ignores very short values, which would redact too aggressively', () => {
    // A 2-char secret appearing in ordinary words would mangle the output.
    expect(redact('the cat sat', ['at'])).toBe('the cat sat');
  });

  it('is a no-op with no secrets registered', () => {
    expect(redact('nothing to hide')).toBe('nothing to hide');
  });
});

describe('createRedactor', () => {
  it('binds a set of secrets once and redacts repeatedly', () => {
    const token = 'ghp_1234567890abcdefghij';
    const redactIt = createRedactor([token]);

    expect(redactIt(`using ${token}`)).not.toContain(token);
    expect(redactIt(`again ${token}`)).not.toContain(token);
  });

  it('ignores empty and short entries at bind time', () => {
    const redactIt = createRedactor(['', 'ab', 'ghp_1234567890abcdefghij']);
    expect(redactIt('ab ghp_1234567890abcdefghij')).not.toContain('ghp_1234567890abcdefghij');
  });

  it('is not affected by later mutation of the source array', () => {
    const secrets = ['ghp_1234567890abcdefghij'];
    const redactIt = createRedactor(secrets);
    secrets.push('npm_zzzzzzzzzzzzzzzzzzzzzz');

    // The bound redactor only knows the first secret.
    expect(redactIt('npm_zzzzzzzzzzzzzzzzzzzzzz')).toContain('npm_zzzzzzzzzzzzzzzzzzzzzz');
  });
});
