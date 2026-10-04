/**
 * The release pipeline.
 *
 * A linear sequence of steps, each recording its outcome as it runs. Two rules
 * define the whole design:
 *
 * 1. **A mandatory step failure halts the run.** Nothing later executes. This is
 *    the property that makes a release trustworthy — a failed test must never be
 *    followed by a published package.
 * 2. **Dry-run is the same pipeline with a no-op context**, not a separate code
 *    path. There is no second implementation that could drift from the first.
 *
 * The pipeline knows nothing about platforms. It resolves providers through the
 * registry and calls them through the `Provider` interface.
 */

import type { ObservedVersion, Provider, ProviderContext } from '../core/provider.js';
import { verifyRelease } from '../verification/integrity.js';
import type { ProviderRegistry } from '../core/registry.js';
import type { ForgeConfig } from '../configuration/schema.js';
import type { BumpStrategy } from '../version/semver.js';

/** How a step ended. */
export type StepStatus = 'passed' | 'failed' | 'skipped' | 'pending';

/** One step's recorded outcome. */
export interface StepResult {
  readonly step: string;
  /** The provider this step acted on, when it acted on one. */
  readonly provider?: string;
  readonly status: StepStatus;
  /** Human-readable explanation. Never contains a secret. */
  readonly detail: string;
  readonly durationMs: number;
  /** When true, a failure here stops the run. */
  readonly mandatory: boolean;
  /** Set when the step failed, for the report. */
  readonly error?: { code: string; message: string };
}

/** Overall verdict. */
export type ReleaseOutcome = 'success' | 'failed' | 'dry-run';

/** What the caller asked for. */
export interface ReleaseRequest {
  /** Bump strategies to apply, e.g. `['minor']`. Empty means keep the version. */
  readonly bumps: readonly BumpStrategy[];
  /** An explicit version, overriding `bumps`. */
  readonly version?: string | undefined;
  /** Plan only; make no external changes. */
  readonly dryRun: boolean;
  /** Restrict the run to these providers, in order. */
  readonly only?: readonly string[] | undefined;
  /** Skip the interactive confirmation. */
  readonly yes: boolean;
}

/** The complete result of a run. */
export interface ReleaseResult {
  readonly project: string;
  readonly version: string;
  readonly previousVersion: string;
  readonly tag: string;
  readonly dryRun: boolean;
  readonly outcome: ReleaseOutcome;
  readonly steps: readonly StepResult[];
  /** Cross-provider verification, when it ran. */
  readonly integrity?: IntegritySummary;
  readonly startedAt: string;
  readonly totalDurationMs: number;
}

/** Cross-provider version agreement. */
export interface IntegritySummary {
  readonly passed: boolean;
  readonly expected: string;
  readonly observed: readonly { provider: string; version: string | null }[];
  readonly mismatches: readonly string[];
}

/** Everything the pipeline needs from the outside world. */
export interface PipelineDeps {
  readonly registry: ProviderRegistry;
  /** Builds the context handed to each provider. */
  readonly contextFor: (dryRun: boolean) => Promise<ProviderContext>;
  /** Reads the current version, throwing when it cannot. */
  readonly currentVersion: () => Promise<string>;
  /** Writes a new version to every configured source. */
  readonly writeVersion: (version: string) => Promise<void>;
  /** Computes the next version from strategies. */
  readonly computeNext: (strategies: readonly BumpStrategy[]) => Promise<string>;
  /** Creates and pushes the git tag. */
  readonly createTag: (tag: string, message: string) => Promise<void>;
  /** Runs the configured checks; throws when a mandatory check fails. */
  readonly runChecks: () => Promise<void>;
  /** Resolves which providers take part. */
  readonly providersFor: (config: ForgeConfig, only?: readonly string[]) => readonly string[];
  /** Whether the version is a prerelease. */
  readonly isPrerelease: (version: string) => boolean;
  /** Confirms a destructive action. */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Progress reporting. */
  readonly onStep?: (result: StepResult) => void;
}

/**
 * Run a release.
 *
 * The step order is fixed and deliberate: validate before changing anything,
 * check before building, tag before publishing, and verify last so the report
 * reflects what actually landed.
 */
export async function runRelease(
  config: ForgeConfig,
  request: ReleaseRequest,
  deps: PipelineDeps,
): Promise<ReleaseResult> {
  const started = Date.now();
  const steps: StepResult[] = [];
  let halted = false;

  /** Record a step, honouring the halt rule. */
  const record = (result: StepResult): StepResult => {
    steps.push(result);
    deps.onStep?.(result);
    return result;
  };

  /** Run one mandatory step; on failure, record and halt. */
  const mandatory = async (
    name: string,
    provider: string | undefined,
    work: () => Promise<string>,
  ): Promise<boolean> => {
    const stepStart = Date.now();
    try {
      const result = await work();
      record({
        step: name,
        ...(provider === undefined ? {} : { provider }),
        status: 'passed',
        detail: result,
        durationMs: Date.now() - stepStart,
        mandatory: true,
      });
      return true;
    } catch (error) {
      const forgeError = error as { code?: string; message?: string };
      record({
        step: name,
        ...(provider === undefined ? {} : { provider }),
        status: 'failed',
        detail: forgeError.message ?? String(error),
        durationMs: Date.now() - stepStart,
        mandatory: true,
        error: { code: forgeError.code ?? 'UNKNOWN', message: forgeError.message ?? String(error) },
      });
      halted = true;
      return false;
    }
  };

  /** Record a provider step, tolerating failure when not mandatory. */
  const forProvider = async (
    name: string,
    providerName: string,
    work: (provider: Provider, context: ProviderContext) => Promise<string>,
    context: ProviderContext,
  ): Promise<boolean> => {
    const stepStart = Date.now();
    try {
      const provider = deps.registry.create(providerName);
      const detail = await work(provider, context);
      record({
        step: name,
        provider: providerName,
        status: 'passed',
        detail,
        durationMs: Date.now() - stepStart,
        mandatory: true,
      });
      return true;
    } catch (error) {
      const forgeError = error as { code?: string; message?: string };
      record({
        step: name,
        provider: providerName,
        status: 'failed',
        detail: forgeError.message ?? String(error),
        durationMs: Date.now() - stepStart,
        mandatory: true,
        error: { code: forgeError.code ?? 'UNKNOWN', message: forgeError.message ?? String(error) },
      });
      halted = true;
      return false;
    }
  };

  // ---- Step 1: validate the project and pick providers -------------------
  const providerNames = deps.providersFor(config, request.only);
  const context = await deps.contextFor(request.dryRun);

  if (providerNames.length === 0) {
    record({
      step: 'configure',
      status: 'failed',
      detail: 'No providers are enabled. Enable at least one in forge.config.yaml.',
      durationMs: 0,
      mandatory: true,
      error: { code: 'CONFIG_INVALID', message: 'No providers enabled' },
    });
    // The version is still resolved so the report names the release that failed
    // rather than reporting a placeholder `0.0.0` the user never asked for.
    let version = 'unknown';
    try {
      version = await deps.currentVersion();
    } catch {
      // The real reason is the configure failure above; leave it as unknown.
    }
    return finish(
      config,
      version,
      version,
      `${config.version.tagPrefix}${version}`,
      steps,
      request,
      started,
      'failed',
    );
  }

  record({
    step: 'configure',
    status: 'passed',
    detail: `${config.project.name} — providers: ${providerNames.join(', ')}`,
    durationMs: 0,
    mandatory: true,
  });

  // ---- Step 2: authenticate every provider -------------------------------
  if (!halted) {
    for (const name of providerNames) {
      const ok = await forProvider(
        'authenticate',
        name,
        async (provider, ctx) => {
          const auth = await provider.authenticate(ctx);
          return auth.identity === undefined
            ? 'authenticated'
            : `authenticated as ${auth.identity}`;
        },
        context,
      );
      if (!ok) break;
    }
  }

  // ---- Step 3: validate every provider ------------------------------------
  if (!halted) {
    for (const name of providerNames) {
      const ok = await forProvider(
        'validate',
        name,
        async (provider, ctx) => {
          await provider.validate(ctx);
          return 'ok';
        },
        context,
      );
      if (!ok) break;
    }
  }

  // ---- Step 4: run the checks --------------------------------------------
  // Before the version is written: a failing check must not leave the project
  // files modified.
  if (!halted && Object.keys(config.checks).length > 0) {
    const ok = await mandatory('checks', undefined, async () => {
      await deps.runChecks();
      return `${Object.keys(config.checks).length} check(s) passed`;
    });
    void ok;
  }

  // ---- Step 5: decide the version -----------------------------------------
  // Resolved even if an earlier step halted, so every report names the version
  // the user asked for rather than a placeholder.
  let version = '0.0.0';
  let previousVersion = '0.0.0';

  const stepStart = Date.now();
  try {
    previousVersion = await deps.currentVersion();

    if (request.version !== undefined) {
      version = request.version;
    } else if (request.bumps.length > 0) {
      version = await deps.computeNext(request.bumps);
    } else {
      version = previousVersion;
    }

    record({
      step: 'version',
      status: 'passed',
      detail:
        request.bumps.length === 0 && request.version === undefined
          ? `unchanged at ${version}`
          : `${previousVersion} → ${version}`,
      durationMs: Date.now() - stepStart,
      mandatory: true,
    });
  } catch (error) {
    const forgeError = error as { code?: string; message?: string };
    record({
      step: 'version',
      status: 'failed',
      detail: forgeError.message ?? String(error),
      durationMs: Date.now() - stepStart,
      mandatory: true,
      error: { code: forgeError.code ?? 'UNKNOWN', message: forgeError.message ?? String(error) },
    });
    halted = true;
  }

  const tag = `${config.version.tagPrefix}${version}`;

  /** Record every remaining step as skipped, so the report shows the whole plan. */
  const skipRest = (): void => {
    const planned: [string, string | undefined][] = [
      ['write-version', undefined],
      ['tag', undefined],
      ...providerNames.map((name): [string, string | undefined] => ['publish', name]),
    ];
    const alreadyRecorded = new Set(steps.map((step) => `${step.step}:${step.provider ?? ''}`));
    for (const [name, provider] of planned) {
      const key = `${name}:${provider ?? ''}`;
      if (alreadyRecorded.has(key)) continue;
      record({
        step: name,
        ...(provider === undefined ? {} : { provider }),
        status: 'skipped',
        detail: 'an earlier step failed',
        durationMs: 0,
        mandatory: true,
      });
    }
  };

  // ---- Step 6: write the version -----------------------------------------
  if (!halted && version !== previousVersion) {
    await mandatory('write-version', undefined, async () => {
      // The write is the pipeline's own side effect, so the dry-run guard lives
      // here. Provider publishes are different: those are delegated, because a
      // provider's dry-run path is what actually validates its pack.
      if (request.dryRun) return `would write ${version}`;
      await deps.writeVersion(version);
      return `wrote ${version}`;
    });
  }

  // ---- Step 7: create the tag --------------------------------------------
  if (!halted) {
    await mandatory('tag', undefined, async () => {
      if (request.dryRun) return `would create ${tag}`;
      await deps.createTag(tag, `Release ${tag}`);
      return `created ${tag}`;
    });
  }

  // ---- Steps 8+: publish to each provider --------------------------------
  if (!halted) {
    for (const name of providerNames) {
      // A dry run still calls publish, because a provider's own dry-run path is
      // what validates the pack (npm runs `npm publish --dry-run` and reports
      // the files). Skipping the call here would make a dry run useless — the
      // one place you learn a release would fail before it is irreversible.
      const ok = await forProvider(
        'publish',
        name,
        async (provider, ctx) => {
          const result = await provider.publish(ctx, {
            version,
            prerelease: deps.isPrerelease(version),
          });
          return result.published
            ? `published ${name}@${version}`
            : `would publish ${name}@${version}`;
        },
        context,
      );
      if (!ok) break;
    }
  }

  // Anything not reached because of a halt is recorded, never dropped.
  if (halted) skipRest();

  // ---- Final step: verify -------------------------------------------------
  // Runs even after a partial failure, because knowing *what* landed is exactly
  // what the user needs when a release goes wrong.
  const outcome: ReleaseOutcome = halted ? 'failed' : request.dryRun ? 'dry-run' : 'success';

  let integrity: IntegritySummary | undefined;
  if (!request.dryRun) {
    // Delegates to the shared integrity module so `forge verify` and the pipeline
    // cannot drift apart. Two implementations of "do the providers agree?" would
    // eventually disagree with each other, which is the bug this exists to catch.
    const report = await verifyRelease(config, {
      registry: deps.registry,
      version,
      contextFor: () => context,
      providersFor: () => providerNames,
    });

    for (const entry of report.entries) {
      for (const check of entry.checks) {
        record({
          step: 'verify',
          provider: entry.provider,
          status: check.passed ? 'passed' : 'failed',
          detail: `${check.name}: ${check.detail}`,
          durationMs: 0,
          mandatory: false,
        });
      }
    }

    integrity = {
      passed: report.passed,
      expected: report.expected,
      observed: report.entries.map((entry) => ({
        provider: entry.provider,
        version: entry.observed,
      })),
      mismatches: report.problems,
    };

    if (!integrity.passed && !halted) halted = true;
  }

  return finish(
    config,
    version,
    previousVersion,
    tag,
    steps,
    request,
    started,
    halted ? 'failed' : outcome,
    integrity,
  );
}

/** Assemble the result. */
function finish(
  config: ForgeConfig,
  version: string,
  previousVersion: string,
  tag: string,
  steps: readonly StepResult[],
  request: ReleaseRequest,
  started: number,
  outcome: ReleaseOutcome,
  integrity?: IntegritySummary,
): ReleaseResult {
  return {
    project: config.project.name,
    version,
    previousVersion,
    tag,
    dryRun: request.dryRun,
    outcome,
    steps,
    ...(integrity === undefined ? {} : { integrity }),
    startedAt: new Date(started).toISOString(),
    totalDurationMs: Date.now() - started,
  };
}

/** True when any step failed. */
export function hasFailure(result: ReleaseResult): boolean {
  return result.steps.some((step) => step.status === 'failed');
}

/** Steps that did not pass, for a summary line. */
export function failedSteps(result: ReleaseResult): readonly StepResult[] {
  return result.steps.filter((step) => step.status === 'failed');
}

/** Total duration, formatted for display. */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Re-exported so a caller can build an observed version without importing core. */
export type { ObservedVersion };
