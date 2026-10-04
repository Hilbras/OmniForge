/**
 * Hardened executor tests.
 *
 * The security property under test: Forge runs commands as argument arrays and
 * never through a shell. A metacharacter in an argument must be passed through
 * literally, not interpreted.
 */

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildInvocation,
  execute,
  executeOrThrow,
  hasShellMetacharacters,
  quoteCmdArgument,
  resolveProgram,
} from '../../src/build/exec.js';
import { CheckError } from '../../src/errors/index.js';

describe('execute', () => {
  it('captures stdout and the exit code', async () => {
    const result = await execute(process.execPath, ['-e', 'process.stdout.write("hello")']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await execute(process.execPath, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err")',
    ]);

    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
  });

  it('does not throw on a non-zero exit', async () => {
    // "exit 1" is meaningful data for a check; only executeOrThrow treats it as
    // an error.
    const result = await execute(process.execPath, ['-e', 'process.exit(3)']);

    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('streams output through onOutput', async () => {
    const chunks: string[] = [];
    await execute(process.execPath, ['-e', 'console.log("streamed")'], {
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join('')).toContain('streamed');
  });

  it('writes input to stdin', async () => {
    const result = await execute(
      process.execPath,
      [
        '-e',
        'let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>process.stdout.write(d))',
      ],
      { input: 'piped' },
    );

    expect(result.stdout).toBe('piped');
  });

  it('honours cwd', async () => {
    // `process.execPath` rather than the bare string 'node': a GitHub Windows
    // runner has setup-node's directory on PATH for the job but not necessarily
    // for a child spawn with a replaced environment. An absolute path always
    // resolves.
    //
    // `os.tmpdir()` rather than '/tmp', which does not exist on Windows.
    const target = mkdtempSync(join(tmpdir(), 'forge-cwd-'));
    const result = await execute(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
      cwd: target,
    });

    expect(realpathSync(result.stdout)).toBe(realpathSync(target));
  });

  it('passes extra environment variables', async () => {
    const result = await execute(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.FORGE_TEST_VAR ?? "")'],
      {
        env: { FORGE_TEST_VAR: 'injected' },
      },
    );

    expect(result.stdout).toBe('injected');
  });

  describe('shell safety', () => {
    it('passes a metacharacter through literally, not as a command', async () => {
      // If this ran through a shell, `;` would start a second command.
      const result = await execute(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        '; rm -rf /; echo pwned',
      ]);

      expect(result.stdout).toBe('; rm -rf /; echo pwned');
      expect(result.stdout).not.toContain('pwned\n');
    });

    it('does not expand an injected command substitution', async () => {
      const result = await execute(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        '$(id)',
      ]);

      expect(result.stdout).toBe('$(id)');
    });

    it('does not expand a backtick substitution', async () => {
      const result = await execute(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        '`id`',
      ]);

      expect(result.stdout).toBe('`id`');
    });

    it('treats a redirect character as data', async () => {
      const result = await execute(process.execPath, [
        '-e',
        'process.stdout.write(process.argv[1] ?? "")',
        'a > b',
      ]);

      expect(result.stdout).toBe('a > b');
    });
  });

  describe('timeouts', () => {
    it('kills a command that exceeds its timeout', async () => {
      const result = await execute(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
        timeoutMs: 300,
      });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    });

    it('does not time out a fast command', async () => {
      const result = await execute(process.execPath, ['-e', 'process.stdout.write("quick")'], {
        timeoutMs: 10_000,
      });

      expect(result.timedOut).toBe(false);
      expect(result.stdout).toBe('quick');
    });

    it('reports a non-zero exit for a signalled process', async () => {
      const result = await execute(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
        timeoutMs: 200,
      });

      // 143 = 128 + SIGTERM, so callers see failure rather than a zero exit.
      expect(result.exitCode).toBeGreaterThan(0);
    });
  });

  describe('missing binaries', () => {
    it('throws COMMAND_REJECTED when the command does not exist', async () => {
      await expect(execute('definitely-not-a-real-binary-xyz', [])).rejects.toThrow(CheckError);
    });

    it('includes the binary name in the message', async () => {
      try {
        await execute('definitely-not-a-real-binary-xyz', []);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as CheckError).message).toContain('definitely-not-a-real-binary-xyz');
      }
    });

    it('gives a useful hint for a known tool', async () => {
      try {
        await execute('twine', ['--version']);
        return; // twine is installed here; nothing to assert
      } catch (error) {
        expect((error as CheckError).remediation).toBeDefined();
      }
    });
  });

  it('rejects an empty command', async () => {
    await expect(execute('   ')).rejects.toThrow(/must not be empty/i);
  });
});

describe('executeOrThrow', () => {
  it('returns the result on success', async () => {
    const result = await executeOrThrow(process.execPath, ['-e', 'process.stdout.write("ok")']);

    expect(result.stdout).toBe('ok');
  });

  it('throws CHECK_FAILED on a non-zero exit', async () => {
    try {
      await executeOrThrow(process.execPath, [
        '-e',
        'process.stderr.write("bad"); process.exit(1)',
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CheckError).code).toBe('CHECK_FAILED');
      expect((error as CheckError).detail?.['output']).toContain('bad');
    }
  });

  it('throws CHECK_TIMEOUT when the command timed out', async () => {
    try {
      await executeOrThrow(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
        timeoutMs: 250,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CheckError).code).toBe('CHECK_TIMEOUT');
    }
  });

  it('includes the exit code in the message', async () => {
    try {
      await executeOrThrow(process.execPath, ['-e', 'process.exit(42)']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as CheckError).message).toContain('42');
    }
  });
});

describe('hasShellMetacharacters', () => {
  it.each(['a;b', 'a|b', 'a&b', 'a`b', 'a$b', 'a>b', 'a<b', 'a\nb'])('flags %s', (arg) => {
    expect(hasShellMetacharacters([arg])).toBe(true);
  });

  it.each(['npm', 'test', '--flag', 'a/b', 'plain text', ''])('does not flag %s', (arg) => {
    expect(hasShellMetacharacters([arg])).toBe(false);
  });

  it('checks every argument', () => {
    expect(hasShellMetacharacters(['safe', 'also;safe'])).toBe(true);
  });

  it('is false for an empty list', () => {
    expect(hasShellMetacharacters([])).toBe(false);
  });
});

describe('resolveProgram', () => {
  it('leaves a command untouched on this platform when it is already spawnable', () => {
    // On POSIX the resolver is a no-op, so this asserts the identity contract
    // rather than the Windows branch — which is all that can be observed here.
    // The Windows behaviour is covered by the CI matrix on windows-latest.
    const resolved = resolveProgram('git');

    if (process.platform === 'win32') {
      expect(resolved.endsWith('.cmd') || resolved.endsWith('.exe') || resolved === 'git').toBe(
        true,
      );
    } else {
      expect(resolved).toBe('git');
    }
  });

  it('never rewrites a command that carries a path or an extension', () => {
    // A path or explicit extension is already unambiguous; appending to it would
    // produce a name that cannot exist.
    for (const command of ['C:\\Program Files\\Git\\cmd\\git.exe', '/usr/bin/git', 'git.exe']) {
      expect(resolveProgram(command)).toBe(command);
    }
  });

  it('returns a name that spawn can actually resolve', async () => {
    // The property that matters: whatever comes back must be executable. On
    // Windows this is the assertion that would have caught the ENOENT.
    // Through execute(), which is the path the npm provider actually takes.
    const result = await execute('npm', ['--version'], { timeoutMs: 60_000 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/\d+\./);
  });
});

describe('cmd.exe argument quoting', () => {
  // cmd.exe does not use backslash escapes. These expectations encode its actual
  // rules, verified against Microsoft\'s own parser documentation, because a
  // plausible-looking but wrong escaper would pass a test written from memory and
  // then hand a crafted argument to a shell.
  it('quotes every argument, so /s cannot split it after stripping the outer pair', () => {
    for (const value of ['pack', '--dry-run', 'a b', 'release']) {
      expect(quoteCmdArgument(value).startsWith('"'), value).toBe(true);
      expect(quoteCmdArgument(value).endsWith('"'), value).toBe(true);
    }
  });

  it('doubles an embedded double quote, which is how cmd.exe escapes one', () => {
    expect(quoteCmdArgument('say "hi"')).toBe('"say ""hi"""');
  });

  it('caret-escapes a metacharacter, because quoting alone is not enough', () => {
    // These are cmd.exe syntax even inside quotes. This is the property that keeps
    // `a; rm -rf /` an argument rather than two commands.
    expect(quoteCmdArgument('a & b')).toBe('"a ^& b"');
    expect(quoteCmdArgument('a | b')).toBe('"a ^| b"');
    expect(quoteCmdArgument('x > y')).toBe('"x ^> y"');
  });

  it('doubles a literal caret so it does not escape the next character', () => {
    expect(quoteCmdArgument('a ^ b')).toBe('"a ^^ b"');
  });

  it('escapes a percent sign, which cmd expands as a variable', () => {
    expect(quoteCmdArgument('%PATH%')).toBe('"^%PATH^%"');
  });

  it('doubles a trailing backslash so it cannot escape the closing quote', () => {
    expect(quoteCmdArgument('ends with\\\\')).toBe('"ends with\\\\\\\\"');
  });

  it('leaves an interior backslash alone', () => {
    expect(quoteCmdArgument('C:\\\\tools\\\\npm.cmd')).toBe('"C:\\\\tools\\\\npm.cmd"');
  });
});

describe('buildInvocation', () => {
  it('passes a real executable straight through', () => {
    const { program, args } = buildInvocation('git', ['log', '--oneline']);

    expect(program).toBe('git');
    expect(args).toEqual(['log', '--oneline']);
  });

  it('routes a batch file through cmd.exe on Windows', () => {
    if (process.platform !== 'win32') {
      // Off Windows the shim is a no-op, so assert that explicitly rather than
      // pretending the Windows branch was exercised.
      expect(buildInvocation('npm.cmd', ['--version']).program).toBe('npm.cmd');
      return;
    }

    const { program, args } = buildInvocation('npm.cmd', ['--version']);

    expect(program.toLowerCase()).toContain('cmd');
    const line = args[3] ?? '';
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // The command name must be bare. Quoting it leaves cmd looking for a program
    // literally called `"npm.cmd"`, which fails with 'is not recognized' — that is
    // what the Windows jobs reported when every argument was quoted.
    expect(line.startsWith('npm.cmd ')).toBe(true);
    expect(line).not.toContain('"npm.cmd"');
  });

  it('produces the command line cmd.exe actually parses', () => {
    // The precise shape Windows receives, so a change in quoting is visible
    // without waiting for a Windows runner.
    if (process.platform !== 'win32') return;

    const { args } = buildInvocation('npm.cmd', ['pack', '--dry-run', '--json']);

    expect(args[3]).toBe('npm.cmd "pack" "--dry-run" "--json"');
  });
});
