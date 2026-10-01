/**
 * The version engine.
 *
 * Decides what the project's version is, what it should become, and whether
 * every source agrees. The consistency check matters most: a polyglot project
 * where `package.json` says `1.4.0` and `pyproject.toml` says `1.3.0` would
 * otherwise publish two different versions from one "release", which is exactly
 * the kind of silent inconsistency the spec forbids.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { VersionError, ErrorCode } from '../errors/index.js';
import type { ForgeConfig } from '../configuration/schema.js';
import { latestTag } from '../build/git.js';
import {
  addPrefix,
  bumpAll,
  isPrerelease,
  isValid,
  max,
  parse,
  stripPrefix,
  type BumpStrategy,
} from './semver.js';
import { resolveSource, type VersionSource } from './sources.js';

/** One source's view of the version. */
export interface VersionObservation {
  readonly source: string;
  readonly description: string;
  /** Files it looked at, relative to the project root. */
  readonly files: readonly string[];
  /** Version found, or null when the file or field is absent. */
  readonly version: string | null;
  /** True when the file exists but carries no usable version. */
  readonly malformed?: boolean;
}

/** The project's version state, assembled from every source. */
export interface VersionState {
  /** The version Forge will use. */
  readonly current: string;
  /** Where it came from. */
  readonly currentSource: string;
  /** Every source that was consulted. */
  readonly observations: readonly VersionObservation[];
  /** The most recent git tag, when the project is a repository. */
  readonly latestTag: string | null;
  /** True when two or more sources disagree. */
  readonly inconsistent: boolean;
}

/**
 * Which sources to consult.
 *
 * An explicit `version.file` wins. Otherwise every well-known file that exists
 * in the project is consulted, so a project with both `package.json` and
 * `pyproject.toml` gets both checked without being asked to configure anything.
 */
export function selectSources(config: ForgeConfig): VersionSource[] {
  if (config.version.file !== null && config.version.file.length > 0) {
    return [resolveSource(config.version.file)];
  }

  const candidates = ['package.json', 'pyproject.toml'];
  const sources: VersionSource[] = [];

  for (const name of candidates) {
    // resolveSource on a bare filename yields a PlainTextSource, which is not
    // what we want; construct the typed source directly instead.
    const source =
      name === 'package.json'
        ? resolveSource('package.json')
        : name === 'pyproject.toml'
          ? resolveSource('pyproject.toml')
          : null;
    if (source === null) continue;
    if (existsSync(join(config.projectRoot, name))) sources.push(source);
  }

  // Nothing recognised: fall back to package.json so the error message names a
  // concrete file rather than saying "no sources".
  return sources.length > 0 ? sources : [resolveSource('package.json')];
}

/**
 * Read every source and determine the current version.
 *
 * @throws VersionError when no source has a version at all, or when they
 * disagree. Disagreement is reported as an error rather than a warning because a
 * release that publishes inconsistent versions is worse than one that stops.
 */
export function readVersionState(config: ForgeConfig): VersionState {
  const sources = selectSources(config);
  const observations: VersionObservation[] = sources.map((source) =>
    observe(source, config.projectRoot),
  );

  const found = observations.filter((o) => o.version !== null && o.version.length > 0);

  if (found.length === 0) {
    const paths = observations.flatMap((o) => o.files).join(', ') || '(none found)';
    throw new VersionError(ErrorCode.VERSION_INVALID, `No version found. Looked in: ${paths}.`, {
      operation: 'version.read',
      remediation: 'Set version.file in forge.config.yaml, or add a version to one of those files.',
      detail: { observations },
    });
  }

  // Group by value; more than one distinct value is an inconsistency.
  const distinct = new Set(found.map((o) => o.version as string));
  const inconsistent = distinct.size > 1;

  if (inconsistent) {
    throw new VersionError(ErrorCode.VERSION_INCONSISTENT, 'Version sources disagree.', {
      operation: 'version.read',
      remediation:
        'Make every source report the same version, then retry. A release must not publish two versions.',
      detail: {
        sources: found.map((o) => ({ source: o.source, version: o.version })),
      },
    });
  }

  const chosen = found[0];
  const current = chosen?.version ?? '0.0.0';

  if (!isValid(current)) {
    throw new VersionError(
      ErrorCode.VERSION_INVALID,
      `Version "${current}" in ${chosen?.source} is not valid semver.`,
      {
        operation: 'version.read',
        remediation: 'Use MAJOR.MINOR.PATCH with an optional -prerelease suffix.',
        detail: { source: chosen?.source, version: current },
      },
    );
  }

  return {
    current,
    currentSource: chosen?.source ?? 'unknown',
    observations,
    latestTag: null,
    inconsistent,
  };
}

/** Read one source. */
function observe(source: VersionSource, root: string): VersionObservation {
  const present = source.files.some((file) => existsSync(join(root, file)));
  const version = source.read(root);

  return {
    source: source.name,
    description: source.description,
    files: source.files,
    version,
    // The file is there but has no version field: worth surfacing, because it
    // usually means a malformed file rather than a project without a version.
    ...(present && version === null ? { malformed: true } : {}),
  };
}

/**
 * Compute the next version.
 *
 * @param from - The base version. Defaults to the current one.
 * @param strategies - Applied in order, so `['patch','prerelease']` yields
 * `1.0.1-rc.0`.
 */
export function nextVersion(
  config: ForgeConfig,
  strategies: readonly BumpStrategy[],
  from?: string,
): string {
  const base = from ?? readVersionState(config).current;
  return bumpAll(base, strategies);
}

/** Write a version to every configured source that exists. */
export async function writeVersion(config: ForgeConfig, version: string): Promise<VersionSource[]> {
  if (!isValid(version)) {
    throw new VersionError(
      ErrorCode.VERSION_INVALID,
      `Refusing to write invalid semver "${version}".`,
      {
        operation: 'version.write',
        remediation: 'Use MAJOR.MINOR.PATCH with an optional -prerelease suffix.',
      },
    );
  }

  const written: VersionSource[] = [];
  for (const source of selectSources(config)) {
    const present = source.files.some((file) => existsSync(join(config.projectRoot, file)));
    // Only write where a file already exists; never create a version file in a
    // project that does not have one.
    if (!present) continue;
    await source.write(config.projectRoot, version);
    written.push(source);
  }

  if (written.length === 0) {
    throw new VersionError(ErrorCode.VERSION_INVALID, 'No version file exists to update.', {
      operation: 'version.write',
      remediation: 'Set version.file in forge.config.yaml, or create the file first.',
    });
  }

  return written;
}

/**
 * The project's version as the remote sees it.
 *
 * The newest tag wins, falling back to the file version when there are no tags
 * yet. A tag ahead of the file means the file was not bumped for that release.
 */
export async function detectPublishedVersion(
  config: ForgeConfig,
): Promise<{ version: string | null; source: string }> {
  const prefix = config.version.tagPrefix;

  let newestTag: string | null = null;
  try {
    newestTag = await latestTag(config.projectRoot, prefix);
  } catch {
    newestTag = null;
  }

  if (newestTag !== null) {
    const newest = max([stripPrefix(newestTag, prefix)]);
    if (newest !== null) return { version: newest, source: 'git tag' };
  }

  try {
    const state = readVersionState(config);
    return { version: state.current, source: state.currentSource };
  } catch {
    return { version: null, source: 'unknown' };
  }
}

/**
 * Compare the project's version against what the remote already has.
 *
 * Used to refuse a duplicate release: publishing a version that already exists
 * is an error on both npm and PyPI, and Forge does not overwrite.
 */
export function detectDuplicate(
  current: string,
  published: string | null,
): { duplicate: boolean; reason?: string } {
  if (published === null) return { duplicate: false };
  if (published === current) {
    return { duplicate: true, reason: `Version ${current} is already published.` };
  }
  return { duplicate: false };
}

/** Whether the version being prepared is a prerelease. */
export function preparingPrerelease(version: string): boolean {
  return isPrerelease(version);
}

/** The tag name for a version, e.g. `1.2.3` → `v1.2.3`. */
export function tagFor(config: ForgeConfig, version: string): string {
  return addPrefix(version, config.version.tagPrefix);
}

/** Every prerelease identifier, for `forge version next --prerelease`. */
export function prereleaseParts(version: string): readonly string[] {
  return parse(version)?.prerelease ?? [];
}
