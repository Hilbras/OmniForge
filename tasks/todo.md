# Hilbras Forge — Task Ledger

Plan: [plan.md](./plan.md) · Milestone M1 = Phase 0 → `0.1.0`

## Phase 0 — Foundation

- [ ] Task 1: Repo scaffolding — package.json, tsconfig, eslint, vitest, .gitignore, LICENSE, CI workflow. Verify: `npm run build && npm test`.
- [ ] Task 2: Module boundaries — typed empty modules for core/providers/release/version/build/verification/configuration/authentication/reporting/errors/utils + architecture test. Verify: test asserts no provider literals in core.
- [ ] Task 3: CLI skeleton — `forge --help`, `forge --version`. Verify: both run from `dist/cli/index.js`.

### Checkpoint: Foundation

- [ ] Build clean, tests green, `forge --version` prints `0.1.0`.

## Phase 1 — Configuration

- [ ] Task 4: `forge.config.yaml` schema + loader + upward discovery.
- [ ] Task 5: Validation with precise errors (path, expected, received) + defaults.
- [ ] Task 6: Env-var credential resolution + `redact()`.
- [ ] Task 7: CLI overrides + `forge config show|validate`.

### Checkpoint: Configuration

- [ ] Valid config round-trips; invalid fields rejected clearly; no token in `config show`.

## Phase 2 — Provider System

- [ ] Task 8: `Provider` interface + capabilities descriptor.
- [ ] Task 9: `ProviderRegistry` — register, discover, validate names, capabilities.
- [ ] Task 10: Lifecycle (load → authenticate → validate → execute → verify) with error isolation.
- [ ] Task 11: `forge provider list|capabilities`.

### Checkpoint: Providers

- [ ] Fake provider runs full lifecycle; core has no platform literals.

## Phase 3 — GitHub Provider

- [ ] Task 12: Auth via `gh auth token` / `GITHUB_TOKEN`; never echo token.
- [ ] Task 13: Repository detect/validate + default branch + working-tree state.
- [ ] Task 14: Tag create/validate/detect-existing.
- [ ] Task 15: Release create — draft, prerelease, notes.
- [ ] Task 16: Release-notes generator from CHANGELOG.
- [ ] Task 17: `forge github status|repository|tag|release`.

### Checkpoint: GitHub

- [ ] Tag + release create on scratch repo; duplicate detected, not overwritten.

## Phase 4 — Version Management

- [ ] Task 18: Semver parse/bump/validate incl. prereleases.
- [ ] Task 19: Sources — package.json, pyproject.toml, configured.
- [ ] Task 20: Cross-provider version consistency check.
- [ ] Task 21: `forge version current|next|bump`.

### Checkpoint: Versioning

- [ ] All sources round-trip; `2.3.4-rc.1` bumps right; mismatch reported.

## Phase 5 — Check & Build Engine

- [ ] Task 22: Check runner — stdout/stderr/exit capture, timeout, duration.
- [ ] Task 23: Mandatory vs optional policy; mandatory failure halts release.
- [ ] Task 24: Hardened exec helper — array args, no shell interpolation.
- [ ] Task 25: `forge check|test|build`.

### Checkpoint: Checks

- [ ] Failing mandatory check halts before publish; shell metachars cannot execute.

## Phase 6 — npm Provider

- [ ] Task 26: npm auth + package detect.
- [ ] Task 27: Package validation.
- [ ] Task 28: Publish + dist-tag.
- [ ] Task 29: Verify — package, version, metadata, dist-tag.
- [ ] Task 30: `forge npm status|package|publish|verify`.
- [ ] Task 31: Normalize npm errors (403 already-exists → duplicate release).

### Checkpoint: npm

- [ ] Publish a real `@hilbras/forge` version and verify via registry API.

## Phase 7 — PyPI Provider

- [ ] Task 32: pyproject.toml detection + metadata.
- [ ] Task 33: Artifact build (sdist + wheel).
- [ ] Task 34: Artifact validation + checksums.
- [ ] Task 35: Upload via twine.
- [ ] Task 36: Verify package, version, artifacts, metadata.
- [ ] Task 37: `forge pypi status|build|publish|verify`.

### Checkpoint: PyPI

- [ ] Unit + fixture tests green. Live publish blocked until a PyPI token exists.

## Phase 8 — Release Orchestration

- [ ] Task 38: Step pipeline + per-step recording + mandatory halt.
- [ ] Task 39: `forge release` full workflow.
- [ ] Task 40: `--patch|--minor|--major|--dry-run|--provider`.
- [ ] Task 41: Dry-run via noop executor.
- [ ] Task 42: Release state persistence (`.forge/releases/`).

### Checkpoint: Orchestration

- [ ] `--dry-run` prints plan; changes nothing on disk or remote.

## Phase 9 — Verification & Integrity

- [ ] Task 43: Verification interface + GitHub/npm/PyPI impls.
- [ ] Task 44: Cross-platform integrity comparison.
- [ ] Task 45: `forge verify`.

### Checkpoint: Verification

- [ ] Artificial mismatch detected → `Release Integrity: FAILED`.

## Phase 10 — Reporting

- [ ] Task 46: `ReleaseReport` model.
- [ ] Task 47: Terminal, JSON, Markdown renderers.
- [ ] Task 48: `--report json|markdown` + `.forge/releases/`.

### Checkpoint: Reporting

- [ ] JSON complete, Markdown readable, no secret in any renderer.

## Phase 11 — Security Hardening

- [ ] Task 49: Central `redact()` at every boundary + leak tests.
- [ ] Task 50: Command validation (args, paths, cwd, env).
- [ ] Task 51: Confirmation for destructive ops + duplicate guards.
- [ ] Task 52: Audit log, no secrets.

### Checkpoint: Security

- [ ] Token planted in every sink never appears in output.

## Phase 12 — Testing & Reliability

- [ ] Task 53: Unit suite — all Core subsystems.
- [ ] Task 54: Integration tests — GitHub, npm, PyPI.
- [ ] Task 55: Failure-path tests — bad creds, network, duplicates, failed builds.

### Checkpoint: Reliability

- [ ] All failure paths covered; CI green; no false-success.

## Phase 13 — CLI UX

- [ ] Task 56: Full command tree, `--help` everywhere.
- [ ] Task 57: Output polish + actionable errors.

### Checkpoint: CLI

- [ ] Every `--help` complete; errors name the recovery action.

## Phase 14 — Documentation

- [ ] Task 58: README + full docs set.
- [ ] Task 59: Six worked examples.
- [ ] Task 60: Tested example configs + CONTRIBUTING.

### Checkpoint: Documentation

- [ ] Every example config validates.

## Phase 15 — Release Candidate

- [ ] Task 61: End-to-end release on a real test project.
- [ ] Task 62: Compatibility matrix.
- [ ] Task 63: Blocker-only fixes.

### Checkpoint: RC

- [ ] Full release succeeds across all three providers.

## Phase 16 — v1.0.0

- [ ] Task 64: Run §22 checklist end to end.
- [ ] Task 65: `forge release --major` → v1.0.0, verified.

### Checkpoint: Stable

- [ ] Overall Status: SUCCESS across GitHub, npm, PyPI.
