/**
 * Version management.
 *
 * Phase 0 reserves the boundary. Phase 4 implements semver parsing and bumping,
 * plus the pluggable version sources (`package.json`, `pyproject.toml`, or a
 * configured source) so the engine never assumes where a project keeps its version.
 */

/** Which part of a semantic version to increment. */
export type BumpStrategy = 'major' | 'minor' | 'patch' | 'prerelease';

/** A parsed semantic version. */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers without the leading `-`, empty for a stable version. */
  readonly prerelease: readonly string[];
  readonly raw: string;
}

/** A place a version can be read from and written to. */
export interface VersionSource {
  readonly name: string;
  /** Files this source reads, relative to the project root. */
  readonly files: readonly string[];
  read(root: string): Promise<string | null>;
  write(root: string, version: string): Promise<void>;
}
