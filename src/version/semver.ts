/**
 * Semantic versioning.
 *
 * A focused, dependency-free semver implementation. Forge's whole job is
 * deciding the next version, so this needs to be exact: `2.3.4-rc.1` must bump
 * to `2.3.4-rc.2`, and anything malformed must be rejected rather than guessed
 * at, because a wrong version becomes an immutable published artifact.
 */

/** Which part of a version to increment. */
export type BumpStrategy = 'major' | 'minor' | 'patch' | 'prerelease';

/** A parsed semantic version. */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers, without the leading `-`. */
  readonly prerelease: readonly string[];
  /** Build metadata after `+`. Ignored for precedence, per the spec. */
  readonly build: string | null;
  readonly raw: string;
}

/**
 * Official semver pattern: `major.minor.patch[-prerelease][+build]`.
 *
 * Numeric identifiers must not have leading zeros; prerelease identifiers may be
 * alphanumeric or numeric, and numeric ones also may not.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Parse a version string. */
export function parse(raw: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(raw.trim());
  if (match === null) return null;

  const [, major, minor, patch, prerelease, build] = match;

  return {
    major: Number.parseInt(major ?? '0', 10),
    minor: Number.parseInt(minor ?? '0', 10),
    patch: Number.parseInt(patch ?? '0', 10),
    prerelease: prerelease === undefined || prerelease === '' ? [] : prerelease.split('.'),
    build: build ?? null,
    raw: raw.trim(),
  };
}

/** True when the string is valid semver. */
export function isValid(raw: string): boolean {
  return parse(raw) !== null;
}

/** Render a parsed version back to a string, dropping empty parts. */
export function format(version: Omit<ParsedVersion, 'raw'>): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  const pre = version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : '';
  const build = version.build === null || version.build.length === 0 ? '' : `+${version.build}`;
  return `${core}${pre}${build}`;
}

/**
 * Compare two versions by precedence.
 *
 * Build metadata is ignored, as semver requires. A prerelease sorts *below* its
 * release, so `1.0.0-rc.1 < 1.0.0`.
 *
 * @returns negative, zero, or positive.
 */
export function compare(a: string | ParsedVersion, b: string | ParsedVersion): number {
  const left = typeof a === 'string' ? parse(a) : a;
  const right = typeof b === 'string' ? parse(b) : b;

  if (left === null || right === null) {
    throw new TypeError('compare() requires two valid semver strings');
  }

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  // Equal core: a prerelease precedes the release it leads to.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < shared; i += 1) {
    const a = left.prerelease[i] ?? '';
    const b = right.prerelease[i] ?? '';
    if (a === b) continue;

    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);

    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (aNum && bNum) return Number.parseInt(a, 10) - Number.parseInt(b, 10);
    if (aNum) return -1;
    if (bNum) return 1;
    return a < b ? -1 : 1;
  }

  return left.prerelease.length - right.prerelease.length;
}

/** True when `a` is strictly older than `b`. */
export function isLessThan(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

/** The highest version in a list, ignoring invalid entries. */
export function max(versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of versions) {
    if (!isValid(candidate)) continue;
    if (best === null || compare(candidate, best) > 0) best = candidate;
  }
  return best;
}

/**
 * Compute the next version.
 *
 * The prerelease rule is the subtle one: bumping a version that is *already* a
 * prerelease advances the prerelease in place (`2.3.4-rc.1` → `2.3.4-rc.2`),
 * because the release is not finished. Only a stable version gets the
 * prerelease treatment on demand.
 */
export function bump(current: string, strategy: BumpStrategy): string {
  const parsed = parse(current);
  if (parsed === null) {
    throw new TypeError(`Cannot bump invalid semver: ${current}`);
  }

  const { major, minor, patch, prerelease } = parsed;

  if (strategy === 'prerelease') {
    // Already a prerelease: advance the last numeric identifier, or append one.
    if (prerelease.length > 0) {
      const last = prerelease[prerelease.length - 1] ?? '';
      const next =
        /^\d+$/.test(last) && Number.parseInt(last, 10) >= 0
          ? String(Number.parseInt(last, 10) + 1)
          : `${last}.1`;
      return format({ ...parsed, prerelease: [...prerelease.slice(0, -1), next] });
    }
    return format({ ...parsed, prerelease: ['rc.0'] });
  }

  if (strategy === 'major') {
    return `${major + 1}.0.0`;
  }
  if (strategy === 'minor') {
    // `major` must be carried: 1.9.9 + minor is 1.10.0, not 10.0.0.
    return `${major}.${minor + 1}.0`;
  }

  // patch
  if (prerelease.length > 0) {
    // `1.2.3-rc.1` → `1.2.3`: the prerelease graduates to its own release.
    return `${major}.${minor}.${patch}`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Bump several times, e.g. `--patch --prerelease` → `1.0.1-rc.0`.
 *
 * Order matters, so they are applied left to right.
 */
export function bumpAll(current: string, strategies: readonly BumpStrategy[]): string {
  return strategies.reduce((version, strategy) => bump(version, strategy), current);
}

/**
 * Strip a tag prefix from a version-ish string.
 *
 * Tags are `v1.2.3` while changelogs and packages say `1.2.3`, so most lookups
 * need the bare version.
 */
export function stripPrefix(tag: string, prefix: string): string {
  if (prefix.length > 0 && tag.startsWith(prefix)) return tag.slice(prefix.length);
  // Tolerate a leading `v` even when the configured prefix differs.
  return /^v\d/.test(tag) ? tag.slice(1) : tag;
}

/** Add a tag prefix to a bare version. */
export function addPrefix(version: string, prefix: string): string {
  return prefix.length > 0 ? `${prefix}${version}` : version;
}

/** True when the version carries a prerelease tag. */
export function isPrerelease(version: string): boolean {
  return parse(version)?.prerelease.length !== 0;
}

/** The major/minor/patch core, without prerelease or build. */
export function core(version: string): string {
  const parsed = parse(version);
  if (parsed === null) throw new TypeError(`Invalid semver: ${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}
