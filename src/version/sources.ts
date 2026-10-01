/**
 * Version sources.
 *
 * Forge does not assume where a project stores its version. Each source knows
 * how to read and write one file shape, and the engine asks whichever ones are
 * configured. A polyglot project (npm + PyPI) is the normal case, not an edge
 * case, and a mismatch between them is a release-stopping inconsistency.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { VersionError, ErrorCode } from '../errors/index.js';

/** A place a version can be read from and written to. */
export interface VersionSource {
  /** Stable identifier, matching a config value. */
  readonly name: string;
  /** Files this source reads, relative to the project root. */
  readonly files: readonly string[];
  /** Human description for `forge version` output. */
  readonly description: string;
  /** Current version, or null when the file or field is absent. */
  read(root: string): string | null;
  /** Write a version. Must be a no-op-safe, minimal edit. */
  write(root: string, version: string): Promise<void>;
}

/**
 * `package.json`.
 *
 * Edits the file as text and replaces only the `"version"` value, because
 * round-tripping through JSON.stringify would reorder keys and reformat every
 * array — an unacceptable diff to leave in a user's repo.
 */
export class PackageJsonSource implements VersionSource {
  readonly name = 'package.json';
  readonly files = ['package.json'] as const;
  readonly description = 'npm package version';

  read(root: string): string | null {
    const raw = readJson(root, 'package.json');
    const version = raw?.['version'];
    return typeof version === 'string' ? version : null;
  }

  async write(root: string, version: string): Promise<void> {
    const path = join(root, 'package.json');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new VersionError(ErrorCode.VERSION_INVALID, 'package.json could not be read.', {
        operation: 'version.write',
        remediation: 'Check the file exists and is readable.',
        cause: error,
      });
    }

    // Replace only the version value, preserving all other formatting.
    const pattern = /("version"\s*:\s*)"[^"]*"/;
    if (!pattern.test(text)) {
      throw new VersionError(
        ErrorCode.VERSION_INVALID,
        'package.json has no "version" field to update.',
        {
          operation: 'version.write',
          remediation: 'Add a "version" field, or point version.file somewhere else.',
        },
      );
    }

    writeFileSync(path, text.replace(pattern, `$1"${version}"`), 'utf8');
  }
}

/**
 * `pyproject.toml`.
 *
 * Hand-written rather than round-tripped through a TOML writer: a serializer
 * would reorder keys and lose the author's comments, which matters more in a
 * pyproject than in a package.json.
 */
export class PyProjectTomlSource implements VersionSource {
  readonly name = 'pyproject.toml';
  readonly files = ['pyproject.toml'] as const;
  readonly description = 'Python distribution version';

  read(root: string): string | null {
    const path = join(root, 'pyproject.toml');
    if (!existsSync(path)) return null;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      return null;
    }

    try {
      const doc = parseToml(text) as Record<string, unknown>;
      const project = doc['project'];
      if (typeof project === 'object' && project !== null) {
        const version = (project as Record<string, unknown>)['version'];
        if (typeof version === 'string') return version;
      }
      // Poetry keeps it under [tool.poetry].
      const tool = doc['tool'];
      if (typeof tool === 'object' && tool !== null) {
        const poetry = (tool as Record<string, unknown>)['poetry'];
        if (typeof poetry === 'object' && poetry !== null) {
          const version = (poetry as Record<string, unknown>)['version'];
          if (typeof version === 'string') return version;
        }
      }
    } catch {
      // A malformed file yields null; the caller reports the inconsistency.
      return null;
    }

    return null;
  }

  async write(root: string, version: string): Promise<void> {
    const path = join(root, 'pyproject.toml');
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new VersionError(ErrorCode.VERSION_INVALID, 'pyproject.toml could not be read.', {
        operation: 'version.write',
        remediation: 'Check the file exists and is readable.',
        cause: error,
      });
    }

    // Target the [project] version, falling back to [tool.poetry].
    const projectMatch = /(\[project\][\s\S]*?^\s*version\s*=\s*)["'][^"']*["']/m.exec(text);
    if (projectMatch?.[0] !== undefined) {
      writeFileSync(path, text.replace(projectMatch[0], `${projectMatch[1]}"${version}"`), 'utf8');
      return;
    }

    const poetryMatch = /(\[tool\.poetry\][\s\S]*?^\s*version\s*=\s*)["'][^"']*["']/m.exec(text);
    if (poetryMatch?.[0] !== undefined) {
      writeFileSync(path, text.replace(poetryMatch[0], `${poetryMatch[1]}"${version}"`), 'utf8');
      return;
    }

    throw new VersionError(
      ErrorCode.VERSION_INVALID,
      'pyproject.toml has no version field to update.',
      {
        operation: 'version.write',
        remediation:
          'Add [project] version = "..." or [tool.poetry] version = "...", or point version.file elsewhere.',
      },
    );
  }
}

/** A plain text file holding only a version, e.g. `VERSION`. */
export class PlainTextSource implements VersionSource {
  readonly name: string;
  readonly files: readonly string[];
  readonly description = 'plain text version file';

  constructor(
    private readonly filename: string,
    name?: string,
  ) {
    this.name = name ?? filename;
    this.files = [filename];
  }

  read(root: string): string | null {
    const path = join(root, this.filename);
    if (!existsSync(path)) return null;
    try {
      const text = readFileSync(path, 'utf8').trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  async write(root: string, version: string): Promise<void> {
    writeFileSync(join(root, this.filename), `${version}\n`, 'utf8');
  }
}

/**
 * A source backed by a JSON pointer-ish dotted path, e.g. `config.version`.
 *
 * The escape hatch for projects that keep their version somewhere unusual.
 */
export class JsonPathSource implements VersionSource {
  readonly name: string;
  readonly files: readonly string[];
  readonly description: string;

  constructor(
    private readonly filename: string,
    private readonly dottedPath: string,
  ) {
    this.name = `${filename}:${dottedPath}`;
    this.files = [filename];
    this.description = `version at ${dottedPath} in ${filename}`;
  }

  read(root: string): string | null {
    const doc = readJson(root, this.filename);
    if (doc === null) return null;

    let current: unknown = doc;
    for (const key of this.dottedPath.split('.')) {
      if (typeof current !== 'object' || current === null) return null;
      current = (current as Record<string, unknown>)[key];
    }
    return typeof current === 'string' ? current : null;
  }

  async write(root: string, version: string): Promise<void> {
    const path = join(root, this.filename);
    const doc = readJson(root, this.filename);
    if (doc === null) {
      throw new VersionError(ErrorCode.VERSION_INVALID, `${this.filename} could not be read.`, {
        operation: 'version.write',
        remediation: `Check ${this.filename} exists.`,
      });
    }

    const keys = this.dottedPath.split('.');
    const last = keys.pop();
    if (last === undefined) {
      throw new VersionError(ErrorCode.VERSION_INVALID, 'Empty version path.', {
        operation: 'version.write',
      });
    }

    let current = doc;
    for (const key of keys) {
      const next = current[key];
      if (typeof next !== 'object' || next === null) return;
      current = next as Record<string, unknown>;
    }
    current[last] = version;

    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  }
}

/** Every source Forge knows, by name. */
export const SOURCES: Readonly<Record<string, () => VersionSource>> = {
  'package.json': () => new PackageJsonSource(),
  'pyproject.toml': () => new PyProjectTomlSource(),
  VERSION: () => new PlainTextSource('VERSION'),
  Cargo: () => new PlainTextSource('Cargo.toml', 'cargo'),
  'version.txt': () => new PlainTextSource('version.txt'),
  'package.json:config.version': () => new JsonPathSource('package.json', 'config.version'),
} as const;

/**
 * Resolve a source by name.
 *
 * Accepts either a registered name or a filename with a dotted path, so
 * `package.json:config.version` works without being registered.
 */
export function resolveSource(name: string): VersionSource {
  const registered = SOURCES[name];
  if (registered !== undefined) return registered();

  const [filename, dottedPath] = name.split(':');
  if (filename !== undefined && filename.length > 0) {
    if (dottedPath !== undefined && dottedPath.length > 0) {
      return new JsonPathSource(filename, dottedPath);
    }
    return new PlainTextSource(filename);
  }

  throw new VersionError(ErrorCode.VERSION_INVALID, `Unknown version source "${name}".`, {
    operation: 'version.resolveSource',
    remediation: `Known sources: ${Object.keys(SOURCES).join(', ')}.`,
    detail: { requested: name, known: Object.keys(SOURCES) },
  });
}

/** Read a JSON file, or null. */
function readJson(root: string, filename: string): Record<string, unknown> | null {
  const path = join(root, filename);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
