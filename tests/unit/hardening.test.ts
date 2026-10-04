import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateCommand, isClean, describeWarnings } from '../../src/build/validate.js';
import { append, entry, format } from '../../src/release/audit.js';
import { globalSecrets } from '../../src/utils/secrets.js';

const ROOT = '/tmp/project';

describe('validateCommand', () => {
  it('accepts an ordinary command', () => {
    const warnings = validateCommand({
      command: 'npm',
      args: ['test'],
      cwd: ROOT,
      projectRoot: ROOT,
    });

    expect(warnings).toEqual([]);
    expect(isClean({ command: 'npm', args: ['test'], cwd: ROOT, projectRoot: ROOT })).toBe(true);
  });

  it('flags an empty command', () => {
    const warnings = validateCommand({ command: '   ', cwd: ROOT, projectRoot: ROOT });

    expect(warnings[0]?.kind).toBe('missing');
  });

  it('flags a shell interpreter', () => {
    // Allowed — a project may legitimately use `sh -c` — but worth saying out loud.
    for (const shell of ['sh', 'bash', 'zsh']) {
      const warnings = validateCommand({
        command: shell,
        args: ['-c', 'npm test'],
        cwd: ROOT,
        projectRoot: ROOT,
      });
      expect(
        warnings.some((w) => w.kind === 'shell'),
        shell,
      ).toBe(true);
    }
  });

  it('flags a working directory outside the project', () => {
    const warnings = validateCommand({ command: 'npm', cwd: '/etc', projectRoot: ROOT });

    expect(warnings.some((w) => w.kind === 'path')).toBe(true);
    expect(warnings[0]?.message).toContain('outside the project root');
  });

  it('accepts a nested working directory inside the project', () => {
    const warnings = validateCommand({
      command: 'npm',
      cwd: join(ROOT, 'packages', 'core'),
      projectRoot: ROOT,
    });

    expect(warnings.some((w) => w.kind === 'path')).toBe(false);
  });

  it.each(['PATH', 'LD_PRELOAD', 'NODE_OPTIONS'])('flags overriding %s', (name) => {
    const warnings = validateCommand({
      command: 'npm',
      cwd: ROOT,
      projectRoot: ROOT,
      env: { [name]: '/evil' },
    });

    expect(warnings.some((w) => w.kind === 'env')).toBe(true);
  });

  it('allows an ordinary environment variable', () => {
    const warnings = validateCommand({
      command: 'npm',
      cwd: ROOT,
      projectRoot: ROOT,
      env: { NODE_ENV: 'production' },
    });

    expect(warnings.some((w) => w.kind === 'env')).toBe(false);
  });

  it.each(['--token', '--password', '--api-key', '--secret=x', '--auth'])(
    'flags a credential passed as %s',
    (flag) => {
      const warnings = validateCommand({
        command: 'npm',
        args: ['publish', flag, 'abc'],
        cwd: ROOT,
        projectRoot: ROOT,
      });

      expect(warnings.some((w) => w.kind === 'credential')).toBe(true);
    },
  );

  it('explains that an argument is visible in the process list', () => {
    const warnings = validateCommand({
      command: 'npm',
      args: ['publish', '--token', 'abc'],
      cwd: ROOT,
      projectRoot: ROOT,
    });

    expect(describeWarnings(warnings).join(' ')).toMatch(/process list/);
  });

  it('reports every category at once', () => {
    const warnings = validateCommand({
      command: 'sh',
      args: ['-c', 'x --token y'],
      cwd: '/etc',
      projectRoot: ROOT,
      env: { PATH: '/evil' },
    });

    const kinds = new Set(warnings.map((w) => w.kind));
    expect(kinds.has('shell')).toBe(true);
    expect(kinds.has('path')).toBe(true);
    expect(kinds.has('env')).toBe(true);
    expect(kinds.has('credential')).toBe(true);
  });
});

describe('audit log', () => {
  it('builds an entry from codes, not messages', () => {
    const record = entry('publish', 'failed', {
      provider: 'npm',
      code: 'PROVIDER_FAILED',
      durationMs: 12,
    });

    expect(record.operation).toBe('publish');
    expect(record.provider).toBe('npm');
    expect(record.code).toBe('PROVIDER_FAILED');
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('has no field that could carry free text', () => {
    // The shape is the guarantee: no message, no output, no stack.
    const record = entry('publish', 'failed', { provider: 'npm' });

    expect(Object.keys(record).sort()).toEqual(
      ['durationMs', 'provider', 'operation', 'result', 'timestamp']
        .filter((k) => k in record)
        .sort(),
    );
  });

  it('records a dry run distinctly', () => {
    expect(entry('publish', 'passed', { dryRun: true }).dryRun).toBe(true);
  });

  it('never records a secret, even if one is registered', () => {
    globalSecrets.add('npm_AUDITCANARY_1234567890');

    const record = entry('publish', 'failed', { provider: 'npm', code: 'X' });

    expect(JSON.stringify(record)).not.toContain('AUDITCANARY');
  });

  it('appends JSON Lines to .forge/audit.log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-audit-'));

    const ok = append(dir, [
      entry('tag', 'passed'),
      entry('publish', 'passed', { provider: 'npm' }),
    ]);

    expect(ok).toBe(true);
    const contents = readFileSync(join(dir, '.forge', 'audit.log'), 'utf8');
    const lines = contents.trim().split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')['operation']).toBe('tag');
    expect(JSON.parse(lines[1] ?? '{}')['provider']).toBe('npm');
  });

  it('appends rather than overwrites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-audit-'));

    append(dir, [entry('tag', 'passed')]);
    append(dir, [entry('publish', 'passed')]);

    const contents = readFileSync(join(dir, '.forge', 'audit.log'), 'utf8');
    expect(contents.trim().split('\n')).toHaveLength(2);
  });

  it('is a no-op for an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-audit-'));
    expect(append(dir, [])).toBe(true);
  });

  it('never fails the release it is recording', () => {
    // A project root that cannot be written must not break a publish. The path is
    // a read-only file rather than `/proc`, which blocks indefinitely rather than
    // erroring — a hang is not a failure this function can absorb.
    const dir = mkdtempSync(join(tmpdir(), 'forge-audit-ro-'));
    const locked = join(dir, 'locked');
    writeFileSync(locked, 'not a directory');

    expect(append(locked, [entry('tag', 'passed')])).toBe(false);
  });

  it('formats a line for the terminal', () => {
    const line = format(entry('publish', 'passed', { provider: 'npm', code: 'NONE' }));

    expect(line).toContain('publish');
    expect(line).toContain('npm');
    expect(line).toContain('passed');
  });
});

// Registering a canary in the global registry is safe: it only grows within this
// test process, and the assertion is that the value never appears.
