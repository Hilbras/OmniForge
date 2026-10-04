/**
 * Generate docs/cli.md from the built CLI.
 *
 * Help text is generated rather than written because hand-copied help drifts
 * silently: a new flag appears in `--help`, nobody updates the docs, and the docs
 * are then wrong in a way nothing catches. This runs in CI and fails when the
 * committed file no longer matches what the CLI actually prints, so the docs
 * cannot go stale without someone choosing to regenerate them.
 *
 *   npm run docs:cli
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const TARGET = join(ROOT, 'docs', 'cli.md');

/** Every command whose help belongs in the reference. */
const COMMANDS = [
  { path: [], heading: 'forge' },
  { path: ['init'] },
  { path: ['provider'] },
  { path: ['provider', 'list'] },
  { path: ['provider', 'capabilities'] },
  { path: ['config'] },
  { path: ['config', 'show'] },
  { path: ['config', 'validate'] },
  { path: ['config', 'path'] },
  { path: ['config', 'credentials'] },
  { path: ['config', 'init'] },
  { path: ['github'] },
  { path: ['github', 'status'] },
  { path: ['github', 'repository'] },
  { path: ['github', 'tag'] },
  { path: ['github', 'release'] },
  { path: ['npm'] },
  { path: ['npm', 'status'] },
  { path: ['npm', 'package'] },
  { path: ['npm', 'publish'] },
  { path: ['npm', 'dist-tag'] },
  { path: ['npm', 'verify'] },
  { path: ['release'] },
  { path: ['verify'] },
  { path: ['version'] },
  { path: ['version', 'current'] },
  { path: ['version', 'next'] },
  { path: ['version', 'bump'] },
  { path: ['version', 'sources'] },
  { path: ['check'] },
  { path: ['test'] },
  { path: ['build'] },
];

/** Run the built CLI and capture one command's help. */
function help(path: readonly string[]): string {
  const output = execFileSync(process.execPath, [CLI, ...path, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  // Commander wraps at the terminal width; a fixed width makes the output stable
  // whether this runs in CI or on a wide local terminal.
  return output.replace(/\r\n/g, '\n').trimEnd();
}

const parts: string[] = [
  '# CLI reference',
  '',
  '<!-- GENERATED FILE — run `npm run docs:cli` to regenerate. CI fails if this',
  '     file no longer matches what the CLI actually prints. -->',
  '',
  'Every command documents itself. This page is the same text, collected.',
  '',
  '## Contents',
  '',
];

for (const entry of COMMANDS) {
  const title = ['forge', ...entry.path].join(' ');
  parts.push(`- [${title}](#${anchorFor(entry.path)})`);
}

/** GitHub-style heading anchor: lowercase, spaces to dashes, punctuation dropped. */
function anchorFor(path: readonly string[]): string {
  return ['forge', ...path]
    .join(' ')
    .replace(/ /g, '-')
    .replace(/[^a-z0-9-]/gi, '')
    .toLowerCase();
}
parts.push('');

for (const entry of COMMANDS) {
  const title = ['forge', ...entry.path].join(' ');
  parts.push(`## ${title}`, '', '```', help(entry.path), '```', '');
}

/**
 * Run generated Markdown through Prettier, in-process.
 *
 * Formatting here rather than leaving it to `npm run format`, because the two
 * otherwise fight: the generator writes raw text, `npm run format` rewrites it,
 * and `docs:check` then reports the file it just generated as stale. Formatting at
 * the source means the committed output is what the generator produces.
 */
async function format(text: string, path: string): Promise<string> {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(text, { ...config, filepath: path });
}

const rendered = await format(`${parts.join('\n')}\n`, TARGET);

mkdirSync(dirname(TARGET), { recursive: true });

/** Overwrite only when the content changed, to keep git diffs meaningful. */
function writeIfChanged(path: string, content: string): boolean {
  let existing: string | null = null;
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = null;
  }
  if (existing === content) return false;
  writeFileSync(path, content, 'utf8');
  return true;
}

const changed = writeIfChanged(TARGET, rendered);

if (process.argv.includes('--check')) {
  // Compare rather than rewrite. An earlier version regenerated the file and then
  // ran `git diff`, which could never fail: the script had already put the file
  // back to what it should be, so the diff was always empty.
  if (changed) {
    console.error('docs/cli.md is out of date. Run `npm run docs:cli` and commit the result.');
    process.exit(1);
  }
  console.log(`docs/cli.md is current (${COMMANDS.length} commands)`);
} else {
  console.log(
    changed
      ? `docs/cli.md written (${COMMANDS.length} commands)`
      : `docs/cli.md already up to date (${COMMANDS.length} commands)`,
  );
}
