import { describe, expect, it } from 'vitest';

import {
  addPrefix,
  bump,
  bumpAll,
  compare,
  core,
  format,
  isLessThan,
  isPrerelease,
  isValid,
  max,
  parse,
  stripPrefix,
} from '../../src/version/semver.js';

describe('parse', () => {
  it('parses a plain version', () => {
    const parsed = parse('1.2.3');

    expect(parsed).not.toBeNull();
    expect(parsed?.major).toBe(1);
    expect(parsed?.minor).toBe(2);
    expect(parsed?.patch).toBe(3);
    expect(parsed?.prerelease).toEqual([]);
    expect(parsed?.build).toBeNull();
  });

  it('parses a prerelease', () => {
    expect(parse('1.0.0-rc.1')?.prerelease).toEqual(['rc', '1']);
  });

  it('parses build metadata', () => {
    expect(parse('1.0.0+build.5')?.build).toBe('build.5');
  });

  it('parses both prerelease and build', () => {
    const parsed = parse('1.0.0-alpha.1+exp.sha.5114f85');
    expect(parsed?.prerelease).toEqual(['alpha', '1']);
    expect(parsed?.build).toBe('exp.sha.5114f85');
  });

  it('trims surrounding whitespace', () => {
    expect(parse('  1.2.3  ')?.major).toBe(1);
  });

  it.each([
    ['1.2', 'too few components'],
    ['1.2.3.4', 'too many components'],
    ['01.2.3', 'leading zero in major'],
    ['1.02.3', 'leading zero in minor'],
    ['1.2.03', 'leading zero in patch'],
    ['v1.2.3', 'v prefix'],
    ['', 'empty'],
    ['  ', 'whitespace only'],
    ['abc', 'not numeric'],
    ['1.2.3-', 'trailing hyphen'],
    ['1.2.3+', 'trailing plus'],
    ['-1.2.3', 'negative'],
    ['1.2.3-01', 'leading zero in numeric prerelease'],
  ])('rejects %s (%s)', (input) => {
    expect(parse(input)).toBeNull();
    expect(isValid(input)).toBe(false);
  });

  it('accepts a zero version', () => {
    expect(isValid('0.0.0')).toBe(true);
  });

  it('accepts large numbers', () => {
    expect(parse('999999.999999.999999')?.major).toBe(999999);
  });
});

describe('format', () => {
  it('renders a plain version', () => {
    expect(format({ major: 1, minor: 2, patch: 3, prerelease: [], build: null })).toBe('1.2.3');
  });

  it('renders a prerelease', () => {
    expect(format({ major: 1, minor: 0, patch: 0, prerelease: ['rc', '2'], build: null })).toBe(
      '1.0.0-rc.2',
    );
  });

  it('renders build metadata', () => {
    expect(format({ major: 1, minor: 0, patch: 0, prerelease: [], build: 'abc' })).toBe(
      '1.0.0+abc',
    );
  });

  it('round-trips through parse and format', () => {
    for (const version of ['1.2.3', '0.0.1', '2.0.0-rc.1', '1.0.0-alpha.beta+build']) {
      const parsed = parse(version);
      expect(parsed).not.toBeNull();
      if (parsed === null) continue;
      expect(format(parsed)).toBe(version);
    }
  });
});

describe('compare', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compare('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compare('1.1.0', '1.2.0')).toBeLessThan(0);
    expect(compare('1.1.1', '1.1.2')).toBeLessThan(0);
    expect(compare('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compare('1.2.3', '1.2.3')).toBe(0);
  });

  it('sorts a prerelease below its release', () => {
    expect(compare('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compare('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });

  it('sorts prereleases by identifier order', () => {
    expect(compare('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compare('1.0.0-beta', '1.0.0-rc')).toBeLessThan(0);
    expect(compare('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0);
  });

  it('sorts numeric identifiers numerically, not lexically', () => {
    // The classic bug: 'rc.9' must sort before 'rc.10'.
    expect(compare('1.0.0-rc.9', '1.0.0-rc.10')).toBeLessThan(0);
  });

  it('ranks numeric identifiers below alphanumeric ones', () => {
    expect(compare('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
  });

  it('ignores build metadata, as the spec requires', () => {
    expect(compare('1.0.0+a', '1.0.0+b')).toBe(0);
    expect(compare('1.0.0+a', '1.0.0')).toBe(0);
  });

  it('throws on an invalid version', () => {
    expect(() => compare('not-a-version', '1.0.0')).toThrow(TypeError);
  });

  it('works with isLessThan', () => {
    expect(isLessThan('1.0.0', '2.0.0')).toBe(true);
    expect(isLessThan('2.0.0', '1.0.0')).toBe(false);
  });
});

describe('max', () => {
  it('picks the highest', () => {
    expect(max(['1.0.0', '2.0.0', '1.5.0'])).toBe('2.0.0');
  });

  it('prefers a release over its prerelease', () => {
    expect(max(['1.0.0-rc.1', '1.0.0'])).toBe('1.0.0');
  });

  it('compares numerically, not lexically', () => {
    expect(max(['1.0.9', '1.0.10'])).toBe('1.0.10');
  });

  it('ignores invalid entries', () => {
    expect(max(['1.0.0', 'garbage', '2.0.0'])).toBe('2.0.0');
  });

  it('returns null for an empty or all-invalid list', () => {
    expect(max([])).toBeNull();
    expect(max(['nope'])).toBeNull();
  });
});

describe('bump', () => {
  it.each([
    ['patch', '1.2.4'],
    ['minor', '1.3.0'],
    ['major', '2.0.0'],
  ] as const)('%s bumps 1.2.3 to %s', (strategy, expected) => {
    expect(bump('1.2.3', strategy)).toBe(expected);
  });

  it('carries a minor bump into the next major correctly', () => {
    expect(bump('1.9.9', 'minor')).toBe('1.10.0');
  });

  it('advances an existing prerelease in place', () => {
    // The subtle one: a release in progress moves to the next rc, not 1.0.1.
    expect(bump('2.3.4-rc.1', 'prerelease')).toBe('2.3.4-rc.2');
    expect(bump('1.0.0-alpha.3', 'prerelease')).toBe('1.0.0-alpha.4');
  });

  it('starts a prerelease on a stable version', () => {
    expect(bump('1.2.3', 'prerelease')).toBe('1.2.3-rc.0');
  });

  it('appends a counter when the last identifier is not numeric', () => {
    expect(bump('1.0.0-beta', 'prerelease')).toBe('1.0.0-beta.1');
  });

  it('graduates a prerelease on a patch bump', () => {
    // 2.3.4-rc.1 → 2.3.4: the release it was leading to finally ships.
    expect(bump('2.3.4-rc.1', 'patch')).toBe('2.3.4');
  });

  it('drops the prerelease on a minor or major bump', () => {
    expect(bump('1.2.3-rc.1', 'minor')).toBe('1.3.0');
    expect(bump('1.2.3-rc.1', 'major')).toBe('2.0.0');
  });

  it('rejects an invalid version', () => {
    expect(() => bump('nope', 'patch')).toThrow(TypeError);
  });

  it('handles zero versions', () => {
    expect(bump('0.0.0', 'patch')).toBe('0.0.1');
    expect(bump('0.0.0', 'major')).toBe('1.0.0');
  });
});

describe('bumpAll', () => {
  it('applies strategies in order', () => {
    expect(bumpAll('1.2.3', ['minor', 'prerelease'])).toBe('1.3.0-rc.0');
    expect(bumpAll('1.2.3', ['patch', 'prerelease'])).toBe('1.2.4-rc.0');
  });

  it('treats order as significant', () => {
    // minor then prerelease != prerelease then minor
    expect(bumpAll('1.2.3', ['minor', 'prerelease'])).not.toBe(
      bumpAll('1.2.3', ['prerelease', 'minor']),
    );
  });

  it('graduates then re-prereleases when patch+prerelease is applied to an rc', () => {
    // patch on 1.0.0-rc.1 graduates it to 1.0.0, then prerelease starts a fresh
    // rc.0. That is the documented sequence, and the reason `forge version bump
    // --prerelease` is the right flag for advancing an existing rc.
    expect(bumpAll('1.0.0-rc.1', ['patch', 'prerelease'])).toBe('1.0.0-rc.0');
  });

  it('advances an existing rc when only prerelease is applied', () => {
    expect(bumpAll('1.0.0-rc.1', ['prerelease'])).toBe('1.0.0-rc.2');
  });

  it('returns the input for an empty strategy list', () => {
    expect(bumpAll('1.2.3', [])).toBe('1.2.3');
  });
});

describe('prefix helpers', () => {
  it('strips a configured prefix', () => {
    expect(stripPrefix('v1.2.3', 'v')).toBe('1.2.3');
    expect(stripPrefix('release-1.2.3', 'release-')).toBe('1.2.3');
  });

  it('strips a bare v even with a different configured prefix', () => {
    expect(stripPrefix('v1.2.3', 'rel-')).toBe('1.2.3');
  });

  it('leaves an unprefixed version alone', () => {
    expect(stripPrefix('1.2.3', 'v')).toBe('1.2.3');
  });

  it('does not strip a v from a version that merely starts with v', () => {
    expect(stripPrefix('version-thing', 'v')).toBe('ersion-thing');
  });

  it('adds a prefix', () => {
    expect(addPrefix('1.2.3', 'v')).toBe('v1.2.3');
    expect(addPrefix('1.2.3', '')).toBe('1.2.3');
  });

  it('round-trips', () => {
    expect(stripPrefix(addPrefix('1.2.3', 'v'), 'v')).toBe('1.2.3');
  });
});

describe('isPrerelease', () => {
  it('detects a prerelease', () => {
    expect(isPrerelease('1.0.0-rc.1')).toBe(true);
    expect(isPrerelease('1.0.0-alpha')).toBe(true);
  });

  it('reports a stable version as not a prerelease', () => {
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('core', () => {
  it('strips prerelease and build', () => {
    expect(core('1.2.3-rc.1+build')).toBe('1.2.3');
  });

  it('throws on an invalid version', () => {
    expect(() => core('nope')).toThrow(TypeError);
  });
});
