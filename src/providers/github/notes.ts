/**
 * Release notes generation.
 *
 * Produces notes for a GitHub Release from the project's CHANGELOG, falling back
 * to git commits and then to a minimal template. All three sources are
 * best-effort: a release must not fail because notes could not be generated.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { execute } from '../../build/exec.js';

/** Inputs for note generation. */
export interface NotesInput {
  readonly version: string;
  readonly tagPrefix: string;
  readonly projectRoot: string;
  /** Optional template path from config; supports `{{version}}` placeholders. */
  readonly templatePath?: string | null;
  /** Notes supplied by the caller, which win over everything generated here. */
  readonly override?: string;
}

/** Changelog file names, in the order they are tried. */
const CHANGELOG_NAMES = ['CHANGELOG.md', 'CHANGELOG.markdown', 'changelog.md'] as const;

/**
 * Build release notes.
 *
 * Order of preference: an explicit override, a configured template, the
 * CHANGELOG section for this version, then commits since the previous tag.
 */
export function generateNotes(input: NotesInput): string {
  if (input.override !== undefined && input.override.trim().length > 0) {
    return input.override;
  }

  if (
    input.templatePath !== null &&
    input.templatePath !== undefined &&
    input.templatePath.length > 0
  ) {
    const rendered = renderTemplate(input.templatePath, input);
    if (rendered !== null) return rendered;
  }

  const fromChangelog = notesFromChangelog(input);
  if (fromChangelog !== null) return fromChangelog;

  return fallbackNotes(input);
}

/**
 * Extract the section for a version from the changelog.
 *
 * The heading is matched loosely (`## [1.2.0]` and `## 1.2.0` are both common)
 * and the body runs until the next heading at the same level.
 */
export function notesFromChangelog(input: NotesInput): string | null {
  for (const name of CHANGELOG_NAMES) {
    const path = join(input.projectRoot, name);
    if (!existsSync(path)) continue;

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    // Keep a Changelog headings are conventionally written *without* the git tag
    // prefix — `## [1.2.0]`, not `## [v1.2.0]` — so both spellings are tried.
    // Without the fallback a perfectly ordinary changelog silently produced no
    // notes and the release fell back to a generic message.
    const bare = extractSection(text, input.version);
    if (bare !== null) return bare;

    const prefixed = extractSection(text, `${input.tagPrefix}${input.version}`);
    if (prefixed !== null) return prefixed;
  }

  return null;
}

/**
 * Pull one version's section out of a changelog.
 *
 * @returns the section body with its heading removed, or null when absent.
 */
export function extractSection(changelog: string, heading: string): string | null {
  const lines = changelog.split('\n');
  const target = heading.toLowerCase();

  let start = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match === null) continue;

    const hashes = match[1] ?? '';
    const title = (match[2] ?? '').trim().toLowerCase();
    // A heading like `## [1.2.0] — 2026-01-01` starts with the version.
    if (title.includes(target) || title.replace(/[[\]]/g, '').startsWith(target)) {
      start = i + 1;
      level = hashes.length;
      break;
    }
  }

  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const match = /^(#{1,6})\s+/.exec(line);
    // Stop at the next heading of the same or higher level.
    if (match !== null && (match[1] ?? '').length <= level) break;
    body.push(line);
  }

  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

/** Substitute `{{version}}`, `{{tag}}`, and `{{date}}` in a template. */
function renderTemplate(templatePath: string, input: NotesInput): string | null {
  const path = templatePath.startsWith('/') ? templatePath : join(input.projectRoot, templatePath);

  if (!existsSync(path)) return null;

  try {
    const template = readFileSync(path, 'utf8');
    return template
      .replaceAll('{{version}}', input.version)
      .replaceAll('{{tag}}', `${input.tagPrefix}${input.version}`)
      .replaceAll('{{date}}', new Date().toISOString().slice(0, 10));
  } catch {
    return null;
  }
}

/**
 * Commits since the previous release, as a last resort.
 *
 * Best-effort by design: a repository with no previous tag, or no git, simply
 * produces no commit list rather than failing the release.
 */
async function commitsSincePreviousTag(input: NotesInput): Promise<string | null> {
  const previous = await execute(
    'git',
    ['describe', '--tags', '--abbrev=0', `${input.tagPrefix}${input.version}^`],
    { cwd: input.projectRoot },
  );
  if (previous.exitCode !== 0) return null;

  const range = `${previous.stdout.trim()}..${input.tagPrefix}${input.version}`;
  const log = await execute('git', ['log', '--pretty=format:- %s', range], {
    cwd: input.projectRoot,
  });
  if (log.exitCode !== 0 || log.stdout.trim().length === 0) return null;

  return log.stdout.trim();
}

/** Notes when nothing better is available. */
function fallbackNotes(input: NotesInput): string {
  return [
    `## ${input.tagPrefix}${input.version}`,
    '',
    'Released automatically by [Forge](https://github.com/Hilbras/OmniForge).',
    '',
    'No changelog entry or commit history was found for this version.',
  ].join('\n');
}

/**
 * Notes from commits, when a changelog is absent.
 *
 * Separate from `generateNotes` so the synchronous path stays synchronous; the
 * release engine can await this when it wants commit-derived notes.
 */
export async function generateNotesFromCommits(input: NotesInput): Promise<string> {
  const commits = await commitsSincePreviousTag(input);
  if (commits === null) return fallbackNotes(input);

  return [`## ${input.tagPrefix}${input.version}`, '', '### Changes', '', commits].join('\n');
}
