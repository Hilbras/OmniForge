/**
 * Release reporting.
 *
 * Three renderers over one `ReleaseResult`: terminal, JSON, and Markdown. The
 * JSON form is the machine-readable contract; Markdown is what a person pastes
 * into a ticket. Both pass every string through redaction, so a credential that
 * reached an error message cannot reach a report.
 */

import { globalSecrets, SecretRegistry } from '../utils/secrets.js';
import type { ReleaseResult, StepResult } from './pipeline.js';

export type ReportFormat = 'terminal' | 'json' | 'markdown';

/**
 * Render a result in the requested format.
 *
 * Redaction is not optional. A caller that forgets to pass secrets still gets a
 * redacted report, because the global registry holds every credential resolved
 * during the run — and a report is written to disk, where a leaked token would
 * outlive the command that produced it.
 */
export function render(
  result: ReleaseResult,
  format: ReportFormat,
  secrets?: readonly string[],
): string {
  const registry = secrets === undefined ? globalSecrets : new SecretRegistry();
  if (secrets !== undefined) for (const secret of secrets) registry.add(secret);

  // Redacted deeply: a token can sit in a step detail, an error message, or a
  // nested detail object, and `redactDeep` also blanks any key whose *name*
  // looks like a credential even when its value is unknown.
  const safe = registry.redactDeep(result);

  switch (format) {
    case 'json':
      return `${JSON.stringify(safe, null, 2)}\n`;
    case 'markdown':
      return renderMarkdown(safe);
    case 'terminal':
      return renderTerminal(safe);
  }
}

/** Human-readable terminal output. */
export function renderTerminal(result: ReleaseResult): string {
  const lines: string[] = [];
  const p = result.dryRun ? 'Dry run' : result.outcome === 'success' ? 'SUCCESS' : 'FAILED';

  lines.push(`${result.project} v${result.version}  ${p}`);
  lines.push('');

  for (const step of result.steps) {
    lines.push(`${statusMark(step)} ${step.step.padEnd(16)} ${step.detail}`);
  }

  if (result.integrity !== undefined) {
    lines.push('');
    lines.push(`Release integrity: ${result.integrity.passed ? 'OK' : 'FAILED'}`);
    for (const entry of result.integrity.observed) {
      const mark = entry.version === null ? '✗' : '✓';
      lines.push(
        `  ${mark} ${entry.provider.padEnd(10)} ${entry.version ?? 'no version reported'}`,
      );
    }
    for (const mismatch of result.integrity.mismatches) {
      lines.push(`  ✗ ${mismatch}`);
    }
  }

  lines.push('');
  lines.push(`Completed in ${(result.totalDurationMs / 1000).toFixed(1)}s`);

  if (result.dryRun) lines.push('No changes were made.');
  else if (result.outcome === 'success') lines.push('Release completed successfully.');
  else lines.push('Release failed. See the failed steps above.');

  return `${lines.join('\n')}\n`;
}

/** Markdown, for a ticket or a release comment. */
export function renderMarkdown(result: ReleaseResult): string {
  const lines: string[] = [];

  lines.push(`# ${result.project} v${result.version}`);
  lines.push('');
  lines.push(`- **Result**: ${result.outcome}`);
  lines.push(`- **Tag**: ${result.tag}`);
  lines.push(`- **Previous version**: ${result.previousVersion}`);
  lines.push(`- **Started**: ${result.startedAt}`);
  lines.push(`- **Duration**: ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push('');

  lines.push('## Steps');
  lines.push('');
  lines.push('| Step | Provider | Result | Detail |');
  lines.push('|------|----------|--------|--------|');
  for (const step of result.steps) {
    lines.push(
      `| ${step.step} | ${step.provider ?? '—'} | ${step.status} | ${escapeCell(step.detail)} |`,
    );
  }
  lines.push('');

  if (result.integrity !== undefined) {
    lines.push('## Release integrity');
    lines.push('');
    lines.push(
      `**${result.integrity.passed ? 'OK' : 'FAILED'}** — expected ${result.integrity.expected}`,
    );
    lines.push('');
    lines.push('| Provider | Observed |');
    lines.push('|----------|----------|');
    for (const entry of result.integrity.observed) {
      lines.push(`| ${entry.provider} | ${entry.version ?? 'no version reported'} |`);
    }
    if (result.integrity.mismatches.length > 0) {
      lines.push('');
      for (const mismatch of result.integrity.mismatches) lines.push(`- ${mismatch}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

/** The status glyph for a step. */
function statusMark(step: StepResult): string {
  switch (step.status) {
    case 'passed':
      return '✓';
    case 'failed':
      return '✗';
    case 'skipped':
      return '○';
    case 'pending':
      return '·';
  }
}

/** Escape a value so it cannot break a Markdown table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Persist a report under `.forge/releases/`, when asked. */
export async function writeReport(
  result: ReleaseResult,
  projectRoot: string,
  formats: readonly ReportFormat[],
): Promise<string[]> {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');

  const dir = join(projectRoot, '.forge', 'releases');
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  for (const format of formats) {
    if (format === 'terminal') continue;
    const extension = format === 'json' ? 'json' : 'md';
    const path = join(dir, `${result.version}.${extension}`);
    writeFileSync(path, render(result, format), 'utf8');
    written.push(path);
  }
  return written;
}
