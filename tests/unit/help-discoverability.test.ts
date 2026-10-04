/**
 * Help discoverability.
 *
 * Commander renders a group's subcommands as `name [options]` without their
 * flags, so `forge version --help` does not show that `bump` accepts `--set`.
 * Someone looking for an exact-version command reads "bump [options]", tries
 * `forge version set`, and gets "unknown command" — which reads as "Forge cannot
 * do that" rather than "the flag is one level down".
 *
 * These assert that every flag a subcommand accepts is named in the parent
 * group's help, so the surface is discoverable from where people start looking.
 */

import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

async function help(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CLI, ...args, '--help'], {
    timeout: 120_000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return stdout;
}

/** Long-form flags a subcommand declares, from its own help. */
async function flagsOf(group: string[], sub: string): Promise<string[]> {
  const text = await help([...group, sub]);
  const options = text.split('Options:')[1]?.split('-h, --help')[0] ?? '';
  return [...options.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1] ?? '');
}

describe('subcommand flags are discoverable from the group help', () => {
  const groups: { group: string[]; subs: string[]; exempt: string[] }[] = [
    // `version`'s bump flags are listed explicitly in the group help.
    { group: ['version'], subs: ['bump', 'next'], exempt: [] },
    { group: ['check'], subs: ['check'], exempt: [] },
    { group: ['npm'], subs: ['publish', 'dist-tag', 'verify'], exempt: [] },
    { group: ['github'], subs: ['tag', 'release'], exempt: [] },
    { group: ['pypi'], subs: ['build', 'publish', 'verify', 'status'], exempt: [] },
  ];

  it.each(groups)('$group lists every flag of $subs', async ({ group, subs, exempt }) => {
    const groupHelp = await help(group);

    for (const sub of subs) {
      for (const flag of await flagsOf(group, sub)) {
        if (exempt.includes(flag)) continue;
        expect(
          groupHelp.includes(`--${flag}`),
          `forge ${group.join(' ')} --help does not mention --${flag} (from \`${group.join(' ')} ${sub}\`)`,
        ).toBe(true);
      }
    }
  });
});

describe('an exact version is reachable from discoverable help', () => {
  it('names --set in the version group help', async () => {
    const text = await help(['version']);

    // Found the hard way: `--set` is only on `bump`, and the group help said
    // `bump [options]` with no indication of what those options were.
    expect(text).toContain('--set');
    expect(text).toMatch(/forge version bump --set/);
  });

  it('documents every bump flag', async () => {
    const text = await help(['version']);

    for (const flag of ['--major', '--minor', '--patch', '--prerelease', '--set', '--yes']) {
      expect(text, `version --help should mention ${flag}`).toContain(flag);
    }
  });
});

describe('unknown subcommands fail loudly', () => {
  it('rejects a plausible but non-existent command', async () => {
    // Not a silent success: a command that does nothing but exits 0 is the worst
    // possible outcome, because the caller believes it worked.
    await expect(
      execFileAsync(process.execPath, [CLI, 'version', 'set', '9.9.9'], {
        timeout: 120_000,
        env: { ...process.env, NO_COLOR: '1' },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});
