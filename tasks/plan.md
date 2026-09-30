# Implementation Plan: Hilbras Forge V1.0.0

## Overview

Hilbras Forge is a provider-based release orchestration CLI: one `forge release`
command that validates a project, computes the next semantic version, runs
checks, builds, tags, creates a GitHub Release, publishes to npm and PyPI,
verifies what actually landed, and emits a structured report.

**Language: TypeScript on Node (>= 22).** Chosen because every provider shells
out to `gh` / `npm` / `twine` regardless, npm is the distribution channel for the
tool itself, and strict types give the Core a real provider contract. One
language across Core, providers, and CLI. No polyglot build.

**Distribution: `@hilbras/forge`** (npm), repo `Hilbras/hilbras-forge`.

## Current State

Verified before planning:

- Repo `Hilbras/hilbras-forge` created, public, local git on `main`, origin wired.
- npm auth token present in `~/.npmrc`; `npm whoami` -> `lacrous`; `@hilbras` scope
  has read-write (publishable). `@hilbras/forge` name is free.
- PyPI credentials: **none configured** (no `~/.pypirc`, no `PYPI_TOKEN`). The PyPI
  provider can be built and unit-tested but cannot be integration-verified until a
  token exists.
- `gh` authenticated as `lacrous`, admin on the `Hilbras` org.

## Architecture Decisions

- **Provider contract is an interface, not a base class.** `Provider` exposes
  `name`, `capabilities`, `authenticate`, `validate`, `getVersion`, `publish`,
  `verify`. Core depends only on the interface; `ProviderRegistry` maps name ->
  factory. Adding Docker Hub means adding one directory under `src/providers/`
  and one registry line.
- **Core contains zero platform conditionals.** No `if (provider === 'npm')`
  anywhere in `src/core`, `src/release`, or `src/cli`. Enforced by an architecture
  test that greps the source tree, so a violation fails CI rather than review.
- **Release is a linear step pipeline with a recorded result per step.** Every step
  appends `{step, provider, status, detail, durationMs}` to a `ReleaseReport`.
  A non-mandatory step failure is recorded and continues; a mandatory step failure
  halts and marks the overall result failed. There is no code path that reports
  overall success while a step is failed.
- **Dry-run is the same pipeline with a `NoopExecutor`**, not a separate code
  path. A dry run cannot drift from a real run because there is only one pipeline.
- **Credentials are resolved from env vars named by config, never stored in
  config.** `redact()` is applied at every serialization boundary (reports, logs,
  `config show`) so a token cannot reach disk even by accident.
- **Checks run through one hardened exec helper** using `execFile`-style argument
  arrays, never `shell: true` interpolation.
- **Verification is a first-class step, always last**, comparing every provider's
  observed version against the intended version.

## Task List

### Phase 0 — Foundation

- [ ] Task 1: Repo scaffolding — package.json, tsconfig, eslint, vitest, .gitignore,
      LICENSE, CI workflow skeleton. Verify: `npm run build && npm test` pass.
- [ ] Task 2: Module boundaries — empty-but-typed `src/{core,providers,release,
  version,build,verification,configuration,authentication,reporting,errors,utils}`
      with an architecture test. Verify: test asserts no cross-boundary import and
      core has no provider-name literals.
- [ ] Task 3: CLI skeleton with commander — `forge --help`, `forge --version`.
      Verify: both run from `node dist/cli/index.js` and via `npm link`.

### Checkpoint: Foundation

- [ ] Build clean, tests green, `forge --version` prints `0.1.0`.

### Phase 1 — Configuration

- [ ] Task 4: `forge.config.yaml` schema + loader + discovery (walk up from cwd).
- [ ] Task 5: Validation with precise errors (path + expected + received) and defaults.
- [ ] Task 6: Env-var credential resolution + redaction.
- [ ] Task 7: CLI overrides (`--config`, `--registry`, …) + `forge config show|validate`.

### Checkpoint: Configuration

- [ ] Round-trip a valid config; every invalid field rejected with a clear message;
      no token appears in `config show`.

### Phase 2 — Provider System

- [ ] Task 8: `Provider` interface + `capabilities` descriptor.
- [ ] Task 9: `ProviderRegistry` — register, discover, validate names, capabilities.
- [ ] Task 10: Provider lifecycle (load → authenticate → validate → execute → verify)
      with error isolation: one provider throwing must not abort the pipeline.
- [ ] Task 11: `forge provider list|capabilities`.

### Checkpoint: Providers

- [ ] A fake provider registered in a test runs the full lifecycle; core source
      contains no platform literals.

### Phase 3 — GitHub Provider

- [ ] Task 12: Auth via `gh auth token` / `GITHUB_TOKEN`, token never echoed.
- [ ] Task 13: Repository detect + validate + default branch + working-tree state.
- [ ] Task 14: Tag create / validate / detect-existing.
- [ ] Task 15: Release create — draft, prerelease, notes (generated + template).
- [ ] Task 16: Release notes generator from CHANGELOG.
- [ ] Task 17: `forge github status|repository|tag|release`.

### Checkpoint: GitHub

- [ ] Tag + release create against a scratch repo; duplicate release detected as an
      error, not silently overwritten.

### Phase 4 — Version Management

- [ ] Task 18: Semver parse/bump/validate incl. `-alpha|-beta|-rc`.
- [ ] Task 19: Version sources — `package.json`, `pyproject.toml`, configured source.
- [ ] Task 20: Cross-provider version consistency check.
- [ ] Task 21: `forge version current|next|bump`.

### Checkpoint: Versioning

- [ ] Round-trip all source types; `2.3.4-rc.1` bumps correctly; a mismatched
      `package.json` vs `pyproject.toml` is reported.

### Phase 5 — Check & Build Engine

- [ ] Task 22: Check runner with stdout/stderr/exit capture, timeout, duration.
- [ ] Task 23: Mandatory vs optional check policy; mandatory failure halts release.
- [ ] Task 24: Hardened exec helper — array args, no shell interpolation.
- [ ] Task 25: `forge check|test|build`.

### Checkpoint: Checks

- [ ] A failing mandatory check halts the pipeline before any publish; shell
      metacharacters in a configured command cannot execute.

### Phase 6 — npm Provider

- [ ] Task 26: npm auth + package detect (name, version, registry).
- [ ] Task 27: Package validation (name, version, files, build output present).
- [ ] Task 28: Publish + dist-tag (`latest|next|beta|alpha`).
- [ ] Task 29: Verify — package exists, version exists, metadata matches, dist-tag correct.
- [ ] Task 30: `forge npm status|package|publish|verify`.
- [ ] Task 31: Normalized npm error mapping (403 already-exists → duplicate-release error).

### Checkpoint: npm

- [ ] Publish a real version to `@hilbras/forge` and verify it via the registry API.

### Phase 7 — PyPI Provider

- [ ] Task 32: `pyproject.toml` detection + metadata extraction.
- [ ] Task 33: Artifact build (sdist + wheel) via `python -m build`.
- [ ] Task 34: Artifact validation — exists, correct name/version, checksummed.
- [ ] Task 35: Upload via `twine` (or PEP 740 attestations when available).
- [ ] Task 36: Verify package, version, artifacts, metadata.
- [ ] Task 37: `forge pypi status|build|publish|verify`.

### Checkpoint: PyPI

- [ ] Unit + fixture tests green. **Live publish blocked until a PyPI token exists.**

### Phase 8 — Release Orchestration

- [ ] Task 38: Step pipeline with per-step result recording + mandatory halt.
- [ ] Task 39: `forge release` full workflow.
- [ ] Task 40: `--patch|--minor|--major|--dry-run|--provider`.
- [ ] Task 41: Dry-run via `NoopExecutor` producing the documented plan output.
- [ ] Task 42: Release state persistence (`.forge/releases/`).

### Checkpoint: Orchestration

- [ ] `forge release --dry-run` prints the plan and changes nothing on disk or remote.

### Phase 9 — Verification & Integrity

- [ ] Task 43: Per-provider verification interface + GitHub/npm/PyPI impls.
- [ ] Task 44: Cross-platform integrity comparison (tag / release / npm / PyPI).
- [ ] Task 45: `forge verify` standalone command.

### Checkpoint: Verification

- [ ] An artificial mismatch is detected and reported as `Release Integrity: FAILED`.

### Phase 10 — Reporting

- [ ] Task 46: `ReleaseReport` model — full field set per spec §16.
- [ ] Task 47: Renderers — terminal, JSON, Markdown.
- [ ] Task 48: `--report json|markdown`, `.forge/releases/<version>.{json,md}`.

### Checkpoint: Reporting

- [ ] JSON parses and contains every field; Markdown is readable; no secret appears
      in any renderer output.

### Phase 11 — Security Hardening

- [ ] Task 49: Central `redact()` applied at every boundary + secret-leak tests.
- [ ] Task 50: Command validation (args, paths, cwd, env allowlist).
- [ ] Task 51: Destructive-op confirmation, duplicate tag/release/version guards.
- [ ] Task 52: Audit log (operation, provider, timestamp, result, error — no secrets).

### Checkpoint: Security

- [ ] A token planted in every sink (report, log, audit, error) never appears in output.

### Phase 12 — Testing & Reliability

- [ ] Task 53: Unit suite — all Core subsystems.
- [ ] Task 54: Integration tests — GitHub (scratch repo), npm (real registry), PyPI (fixture/mock).
- [ ] Task 55: Failure-path tests — bad credentials, network failure, existing
      version/tag/release, failed build/test, publish failure, integrity mismatch,
      invalid config.

### Checkpoint: Reliability

- [ ] All failure paths covered; CI green on repeat runs; no false-success state.

### Phase 13 — CLI UX

- [ ] Task 56: Full command tree with `--help` on every command (description, usage,
      args, options, examples).
- [ ] Task 57: Output polish — `✓`/`✗` formatting, actionable errors
      (what failed / why / impact / next step).

### Checkpoint: CLI

- [ ] Every command's `--help` is complete; errors name the recovery action.

### Phase 14 — Documentation

- [ ] Task 58: README + docs set (install, CLI ref, config, providers, auth,
      versioning, workflow, dry-run, verification, reports, troubleshooting,
      security, provider development, architecture, contributing).
- [ ] Task 59: Examples for all six project shapes (npm-only, PyPI-only,
      GitHub-only, npm+GitHub, PyPI+GitHub, all three).
- [ ] Task 60: Tested example configs + a CONTRIBUTING guide.

### Checkpoint: Documentation

- [ ] Every example config validates via `forge config validate`.

### Phase 15 — Release Candidate

- [ ] Task 61: End-to-end release against a real test project across all three providers.
- [ ] Task 62: Compatibility matrix — OS, Node, Python, git versions.
- [ ] Task 63: Fix release blockers only; no architectural churn.

### Phase 16 — v1.0.0

- [ ] Task 64: Run the §22 pre-release checklist end to end.
- [ ] Task 65: `forge release --major` → v1.0.0, verified across all providers.

## Release Cadence — deviation from spec §26

Spec §26 mandates a published npm + GitHub release after **every** phase (17
publishes). That is too many irreversible publishes to reach v1.0.0, and it puts
a live-registry operation between every unit of work. Deviation, agreed with the
user: publish at the meaningful milestones only.

| Milestone | Version      | Covers                                               |
| --------- | ------------ | ---------------------------------------------------- |
| M1        | `0.1.0`      | Phase 0 — foundation, working CLI                    |
| M2        | `0.2.0`      | Phases 1–2 — config + provider system                |
| M3        | `0.3.0`      | Phases 3–5 — GitHub, versioning, checks              |
| M4        | `0.4.0`      | Phases 6–7 — npm + PyPI providers                    |
| M5        | `0.5.0`      | Phases 8–10 — orchestration, verification, reporting |
| M6        | `0.6.0`      | Phases 11–14 — security, tests, CLI, docs            |
| M7        | `1.0.0-rc.1` | Phase 15 — release candidate                         |
| M8        | `1.0.0`      | Phase 16 — stable                                    |

Intermediate phase numbers from spec §25 remain as **CHANGELOG entries** under
the encompassing milestone. Every milestone still runs the full §26 sequence
(tests → version → changelog → build → publish → tag → release → verify).

**Blocked:** M4's PyPI half and Phase 15's PyPI leg need PyPI credentials.

## Risks and Mitigations

| Risk                                                | Impact                              | Mitigation                                                                                                             |
| --------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| No PyPI credentials                                 | M4 PyPI half, Phase 15 leg blocked  | Build + unit-test fully; gate live publish behind `PYPI_TOKEN` presence with a clear error. User supplies token later. |
| PyPI is irreversible                                | A bad first publish can't be redone | Use TestPyPI for the integration test; require explicit confirmation; verify metadata locally before upload.           |
| `forge release` published before it's mature        | Users release into a broken tool    | CLI is pre-1.0; README marks the release command experimental until Phase 16 passes.                                   |
| Provider abstraction leaks platform logic into Core | Unmaintainable, breaks §4.1         | Architecture test greps `src/core                                                                                      | release | cli` for platform literals. Fails CI. |
| Dry-run drifts from real run                        | Dry-run lies — worst possible bug   | Dry-run is the same pipeline with a noop executor. No separate path exists.                                            |
| Rate limits on `gh` during integration tests        | Flaky CI                            | Scratch-repo tests are opt-in via env var; CI uses recorded fixtures by default.                                       |
| Scope creep from the 28-section spec                | Never reaches v1.0.0                | Tasks are S/M-sized with explicit acceptance criteria; vertical slices, not horizontal layers.                         |

## Open Questions

- PyPI token: needed before M4's PyPI leg. TestPyPI preferred for integration.
- Should `forge release` be gated behind an experimental warning until Phase 16?
