# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.9.1] — 2026-10-04

Phase 13 — CLI UX and developer experience.

This phase started as polish and turned into three functional additions plus one
output bug that affected every command.

### Added

- **`forge init`** — generates a working `forge.config.yaml` by reading
  `package.json` or `pyproject.toml`, then shows what it detected before writing.
  The spec has listed `forge init` since Phase 13; what actually existed was
  `forge config init`, a Phase 1 stub still printing "generated in Phase 1 Task 7".
  It never got implemented, so the command everyone tries first did nothing.
- Ecosystems are **data, not branches**. The architecture test rejected the first
  version of this file for branching on the strings "npm" and "python" — which is
  the coupling §4.1 forbids: adding a Rust or Go project would have meant editing
  this file's conditionals. Adding one is now a row in `ECOSYSTEMS`. The guard
  caught a real violation in the same commit it was written to catch one.
- Examples for `forge check`, `forge test`, and `forge build`, which had none.
  All 11 top-level commands now document usage, arguments, options, and examples.
- 18 tests over detection and rendering, against real temp directories rather
  than a mocked filesystem. The generated YAML is parsed with an independent
  parser and run through the real schema validator, so "it wrote a file" is never
  mistaken for "it wrote a usable file".

### Fixed

- **A failure could be split across two output streams.** `warning` and
  `failure` write to stderr; `detail` writes to stdout. Every command paired them,
  so `forge config init > log` recorded "pass --force to overwrite" while dropping
  the warning explaining what passed — a log reading as an instruction with no
  problem attached, which is worse than silence. Added `detailError` and moved 23
  call sites across 7 files. Invisible at a terminal, which is why it survived:
  the terminal shows both lines perfectly.

- **`forge init` printed `[object Object]` for the ecosystem.** Caught by running
  the command against real fixtures, not by any test.

### Notes

- The regression guard for the stream bug is deliberately narrow — a plain
  `detail` on the line directly after a `warning`/`failure`. Two looser versions
  misfired on the common, correct shape of a failure branch that returns followed
  by a success branch printing details, so the rule is held to account by four
  explicit tests.
- 741 tests passing, up from 708.

## [0.9.0] — 2026-10-04

Phase 12 — testing and reliability. 708 tests, up from 628.

This phase was mostly about looking for what the tests did _not_ cover, because
"708 tests" is a number, not a guarantee. Four real defects surfaced, all of them
in code that had shipped.

### Fixed

- **`parseRemoteUrl` mangled three remote URL shapes.** A trailing slash after
  `.git` left `name.git/` in the result; a nested GitLab group
  (`group/sub/project`) was truncated to `group/sub`; and a bare local path
  (`/srv/git/repo`) parsed to `git/repo`, inventing a repository with no remote
  host. This function decides which GitHub repository Forge talks to, so each of
  those was a lookup against the wrong place — or a repository that does not
  exist.

- **`validatePackageName` accepted an empty scope.** `@/sdk` passed validation
  because the leading `@` was read as an unscoped prefix. npm rejects it.

- **npm auth failures were misclassified in two directions.**
  `"You must be logged in"` fell through to the generic branch, so a permissions
  problem was reported as an unexplained failure; and a duplicate publish on a
  scoped package — which npm emits as `E409` _and_ `403` together — was read as
  an auth failure, telling the user to fix a token that works perfectly.
  Duplicates are now classified first.

- **The declared Node floor was wrong.** `engines` said `>=22`, but `commander`
  requires `>=22.12.0` and vitest requires `^22.12.0`, so installing on 22.0
  would break. Corrected to `>=22.12.0`.

### Added

- **Coverage thresholds** in `vitest.config.ts`, per directory rather than
  globally. A global number would be meaningless here: the CLI is tested by
  spawning the built binary, which v8 coverage cannot observe, so `src/cli/**`
  reports near-zero while being well covered by integration tests that assert
  observable behaviour instead. Thresholds now cover the decision-making code,
  where a dropped branch means a release silently does the wrong thing — and
  `npm test` fails when they slip.
- **37 git tests against a real repository** in a temp directory, rather than a
  stub: a stub only proves the code calls what the stub expects. Covers annotated
  tags, duplicate-tag refusal, version sorting, pushing to a real bare remote, and
  the error paths that need an unusable git.
- **33 npm error-normalization tests** built from real npm output. This function
  is the only place npm's undocumented prose becomes a typed error, so it decides
  whether a user is told "you already published this" or "your token is invalid".
  One case came from actually running `npm publish` against a bad version and
  reading the output: `ETARGET`, which was falling through to the generic branch.
- **CI tests Node 22.12, 24, and 26** across all three platforms, instead of only 24. The full suite was run locally on 22.23 first, so the matrix asserts a
  verified claim rather than a hopeful one.
- A visible coverage step in CI.

### Metrics

|                    | before | after              |
| ------------------ | ------ | ------------------ |
| tests              | 628    | 708                |
| `src/build/git.ts` | 46%    | 95%                |
| `src/build`        | 81%    | 95%                |
| coverage enforced  | no     | yes, per directory |

## [0.8.1] — 2026-10-04

Patch release. Both fixes below were found by verifying the v0.8.0 release from a
clean install — the released artifact, not the working tree — which is the only
place the second one showed up.

### Fixed

- **An invalid GitHub token was reported as "the tag does not exist."**
  `tagExistsRemote` and `getRelease` returned `false`/`null` for _any_ non-zero
  exit, so a 401 was indistinguishable from a 404. `forge verify` then told the
  user a published, healthy release was missing and advised re-publishing it —
  actively harmful advice when the real problem was a rejected token. Only 404
  may now mean "absent"; 401 and 403 raise an auth error naming `gh auth status`,
  and a request that never completed raises rather than guessing.

  Found by accident, which is the best kind of find: a canary token planted in
  the environment for a leak test happened to be invalid, and the healthy 0.8.0
  release failed its own integrity check.

- **`dist-tag-matches` made historical releases unverifiable.** It asserted that
  `latest` pointed at the version under verification, so verifying 0.7.0 after
  0.8.0 shipped reported a broken release — correct npm behaviour flagged as a
  bug. The expected tag is now enforced only for the version currently being
  released. What must hold for any version is that it carries _some_ tag, so a
  new `is-tagged` check covers that, since an untagged version cannot be
  installed by name.

- **GitHub provider test stubs were unrealistic.** They modelled "absent" as a
  bare non-zero exit with no HTTP status, which is why the 401-as-404 flaw went
  unnoticed. Real `gh` always reports the status; the stubs now do too.

### Added

- 14 regression tests covering 401, 403, 500, and an unstatused failure for both
  GitHub read paths, asserting that none of them report a resource as missing.
- The live `forge verify` tests now read the version from `package.json` instead
  of hard-coding `0.7.0`, which went stale the moment 0.8.0 shipped.

## [0.8.0] — 2026-10-04

Phase 9 — verification and release integrity.

### Added

- **`forge verify`** — checks that every enabled provider reports one agreed
  version, standalone and at any time: after CI, before a deploy, or days later
  when someone suspects a tag and a package disagree. Exits 3 on a mismatch, so a
  deploy step can gate on it.
- **Per-check detail on failure.** The output names which assertion broke
  (`tag-exists`, `version-exists`, `dist-tag-matches`) rather than only that a
  provider failed, so the next action is obvious.
- **`--provider` and `--config`** on `verify`, matching every other command.
- **An unreachable provider does not hide the others.** A registry that throws is
  recorded as unreachable and the comparison continues, because a real mismatch
  in another provider is still worth reporting.
- **Tag-prefix tolerance.** GitHub reports `v1.5.0` while npm reports `1.5.0`.
  That is agreement, and comparing them literally would have made the check
  useless for the most likely real-world shape.
- 27 tests: 19 unit (mismatch, missing version, unreachable provider, custom
  prefix, remediation text) and 8 CLI integration against live GitHub and npm.

### Changed

- **The release pipeline now delegates to the shared integrity module.** It had
  its own copy of the cross-provider comparison. Two implementations of "do the
  providers agree?" would eventually disagree with each other — which is the
  exact bug the check exists to catch — so the duplicate was removed rather than
  left to drift.

### Fixed

- **`forge verify` had no `--config` flag**, unlike every other command, so a
  verification could not be pointed at a specific configuration file.
- **A live-network integration test was flaky at roughly 1 run in 3.**
  `forge npm status` takes 1-2s alone but exceeded the 30s default timeout under
  parallel suite load. Raised to 120s for the tests that genuinely hit a
  provider, and confirmed stable over four consecutive full runs. The commands
  themselves were not slow; the timeout was simply too tight for loaded CI.

## [0.7.0] — 2026-10-01

Phase 11 — security hardening.

### Added

- **Secret registry** (`src/utils/secrets.ts`). Credentials are registered once,
  when resolved, and every output sink redacts against them. The inversion is the
  point: auditing each call site for leaks does not scale, whereas a redacting
  sink is correct by construction for every caller, including ones written later.
- **Redaction at the sink.** Every string the CLI emits — stdout, stderr, error
  details, stack traces, and written reports — passes through the redactor. This
  closes a real path: provider stderr routinely echoes back the token passed on a
  command line (`npm ERR! Authorization: Bearer npm_…`), which lands in a
  `ForgeError` detail and then in a report file on disk.
- **`redactDeep`** blanks any key whose _name_ looks like a credential even when
  its value was never resolved — the case value-substitution cannot catch.
- **Command validation** (`src/build/validate.ts`) flags a suspicious command: a
  shell interpreter, a working directory outside the project, an overridden
  `PATH`/`LD_PRELOAD`/`NODE_OPTIONS`, or a credential passed as an argument.
- **Audit log** (`.forge/audit.log`, JSON Lines): operation, provider, timestamp,
  result, error code, duration. Deliberately no free text, so it cannot carry a
  secret. Best-effort — an audit failure never fails the release.
- **75 security tests** planting a canary credential in every sink and asserting
  it appears in none, including end-to-end CLI subprocess runs and a report
  written to disk.

### Fixed

- **Credential flags were only detected at the start of an argument**, so a token
  inside an inline `sh -c "..."` script went unflagged — the more likely accident.
- **Deep redaction skipped objects whose keys were secret-shaped** when the
  registry held no known secret, which is exactly when an unknown token in a
  `{ token: … }` field would survive.
- **Reports were redacted only when a caller passed secrets explicitly.** The
  writer now defaults to the global registry, because a report is written to disk
  and a caller that forgets is not a caller anyone should have to trust.

### Notes

- The masked-prefix form (`ghp_***`) is used only for _display_; emitted output
  uses `[REDACTED]`, since a prefix still confirms a credential's shape.
- 587 tests passing, up from 512.

## [0.6.0] — 2026-10-01

Phases 8 and 10 — release orchestration and reporting. `forge release` now runs
the whole workflow in one command.

### Added

- **`forge release`** wiring every subsystem together:
  `configure → authenticate → validate → checks → version → tag → publish →
verify → report`.
- **Release pipeline** (`src/release/pipeline.ts`). Two rules define it: a
  mandatory step failure halts the run, and a dry run is the same pipeline with a
  no-op context rather than a second code path that could drift.
- **Skipped steps are recorded, not dropped**, so a failed release shows the
  whole plan and the user can see what did not run.
- **Checks run before the version is written**, so a failure never leaves the
  project's files modified.
- **Verification runs even after a partial failure**, because knowing _what_
  landed is exactly what you need when a release goes wrong.
- **Reporting** (`src/release/report.ts`): terminal, JSON, and Markdown
  renderers, all passing through redaction so a credential cannot reach a report.
  `--report json|markdown` writes `.forge/releases/<version>.{json,md}`.
- **Cross-provider integrity comparison** ignoring tag prefixes, so a GitHub
  release reporting `v1.5.0` is not called a mismatch against `1.5.0`.

### Fixed

- **A failed release exited 0.** `main()` returned Success and overwrote the exit
  code a command had set, so a CI step gating on `forge release` would have
  passed on a release that published nothing.
- **The plan listed every known provider** rather than the ones that would run,
  printing three while running one.
- **A failed release reported `v0.0.0`** when it halted before version
  resolution, naming a version the user never asked for.

### Notes

- 512 tests passing, up from 484. The architecture test caught two per-provider
  branches in the new CLI code; both were replaced with data-driven lookups.
- Publishing is irreversible. Run `--dry-run` first.

## [0.5.0] — 2026-10-01

Phase 6 — the npm provider. The second real platform behind the provider
contract, and the first one that publishes something irreversible.

### Added

- **npm registry client** (`src/providers/npm/client.ts`). Reads package metadata
  over HTTP, moves and removes dist-tags, and publishes by shelling out to
  `npm publish` — npm handles auth, the `files` allowlist, and provenance
  correctly, and reimplementing that would be a worse npm.
- **`NpmProvider`** implementing the full contract: authenticate, validate,
  getVersion, publish, verify. Registered in the composition root.
- **`forge npm status | package | publish | dist-tag | verify`**.
- **Dist-tag safety.** A prerelease never receives `latest`; Forge picks `next`,
  `beta`, or `alpha` from the version and refuses outright if `latest` is forced.
  Getting this wrong ships unfinished code to everyone running `npm install`.
- **Normalized npm errors.** "Already published" arrives as a 403, indistinguishable
  at a glance from a permissions problem; it gets its own `DUPLICATE_RELEASE` code
  with the right remediation. Auth, payment, and not-found are separated too.
- **Cache-busted registry reads.** A cached metadata document made an unpublished
  version look published, which wrongly refused an irreversible publish.
- **CLI contract tests** that assert no subcommand declares a flag commander
  intercepts (`--version`, `--help`), plus a behavioural check that a flag is
  actually applied rather than swallowed.

### Fixed

- **`--dry-run` was a no-op that still demanded confirmation.** Commander
  camelCases dashed flags, so `--dry-run` arrives as `dryRun`; reading
  `flags['dry-run']` silently yielded `undefined`.
- **A dry run now really runs npm with `--dry-run`.** It previously returned early,
  so a broken `files` allowlist went unnoticed until the real publish — the one
  thing a dry run exists to catch.
- **Auth failures were reported as generic provider errors.** npm puts the error
  code on a line separate from the prose, so `ENEEDAUTH` and "requires you to be
  logged in" both fell through.
- **Removed `forge npm publish --version`.** `npm publish` only ever publishes the
  version in `package.json`, so the flag silently did nothing while reporting
  success. There is no override; bump the file first.

### Notes

- The token is passed through the child environment, never as a CLI argument —
  an argument is visible in the process list.
- 484 tests passing, up from 427.

## [0.4.0] — 2026-10-01

Phases 4 and 5 — version management and the check engine.

### Added

- **Semantic versioning** (`src/version/semver.ts`), dependency-free. Parsing
  rejects what the spec rejects, including leading zeros; comparison sorts
  prereleases below their release and numeric identifiers numerically, so
  `rc.9 < rc.10` rather than the reverse.
- **Bumping** with correct prerelease semantics: `2.3.4-rc.1` + prerelease is
  `2.3.4-rc.2` (advance in place), while + patch graduates it to `2.3.4`.
- **Version sources** (`src/version/sources.ts`) so Forge never assumes where a
  project keeps its version. Reads and writes `package.json`,
  `pyproject.toml` (both `[project]` and `[tool.poetry]`), a plain `VERSION`
  file, and any `file.json:dotted.path`.
- **Minimal-diff writes.** `package.json` is edited as text so only the version
  line changes — no key reordering or reindentation. `pyproject.toml` likewise
  keeps its comments. A round-trip through a serializer would leave an
  unacceptable diff in a user's repo.
- **Cross-source consistency check.** A polyglot project whose `package.json` and
  `pyproject.toml` disagree is a hard error. Publishing two different versions
  from one release is exactly the silent inconsistency the spec forbids.
- **Check engine** (`src/build/checks.ts`): mandatory and optional checks, with a
  mandatory failure halting before anything is published. Skipped checks are
  recorded rather than dropped so the report shows the whole plan.
- **`forge version current | next | bump | sources`** and
  **`forge check [names...]`**, **`forge test`**, **`forge build`**.
  `bump` and the mutating GitHub commands confirm first and refuse without
  `--yes` when stdin is not a TTY.
- **Duplicate-release guard**: a bump to a version already published is refused
  before any file is written.

### Fixed

- **Minor bumps discarded the major.** `1.2.3` + minor produced `3.0.0` instead of
  `1.3.0`, and `1.9.9` produced `10.0.0`. Caught by the semver tests before
  release.
- **Errors printed twice** in `forge version`. Commands printed a failure and
  then rethrew it, so the CLI's top-level handler rendered it again.

### Notes

- Adds `smol-toml` for reading `pyproject.toml`.
- `forge check` streams output live, so a long suite shows progress.
- Version tests: 64 semver, 48 sources, 23 checks. Suite is 427 passing.

## [0.3.0] — 2026-10-01

Phase 3 — the GitHub provider, and the hardened executor it needed.

### Added

- **Hardened command execution** (`src/build/exec.ts`). Every external command
  runs as an argument array with `shell: false`, so a metacharacter in an
  argument is passed through as data. Captures stdout/stderr separately, reports
  the exit code, enforces a timeout with SIGTERM then SIGKILL, and raises a
  missing-binary error naming the tool. Pulled forward from Phase 5 because the
  GitHub provider needed it and retrofitting safety later would have been the
  wrong order.
- **Git introspection** (`src/build/git.ts`): repository detection, branch,
  commit, dirty paths, remote URL parsing, tag creation with duplicate
  protection, and tag push.
- **GitHub client** (`src/providers/github/client.ts`) wrapping `gh`. The token
  is passed through the child process environment and never read into a Forge
  variable, so it cannot be logged. 404 and 403 are normalized into
  "repository not found" and "auth failed" rather than surfacing as raw API text.
- **`GitHubProvider`** implementing the full `Provider` contract: authenticate,
  validate, getVersion, publish, verify. Registered in the new composition root
  (`src/core/default-registry.ts`).
- **`forge github`**: `status`, `repository`, `tag`, `release`. Mutating commands
  confirm first, and refuse without `--yes` when stdin is not a TTY.
- **Release notes generation** from the changelog, a configured template, or
  commits since the previous tag — in that order, best-effort throughout so notes
  can never fail a release.
- **Test seams**: `gh` and `git` both accept an injected runner, so provider
  logic is verified offline and deterministically.

### Fixed

- **`forge github release --version 1.2.3` silently did nothing**, printing the
  version and exiting 0. Commander routes a subcommand option named `--version`
  to the _root_ program's version handler, which prints and exits. The `=` form
  happened to work, which is what made it easy to miss. The flag is now
  `--release-version`.
- **Changelog lookup ignored versions written without a tag prefix.** Keep a
  Changelog headings are conventionally `## [1.2.0]`, not `## [v1.2.0]`, so
  every release would have fallen back to a generic notes message.
- **GitHub authentication failed in the CLI** while passing in tests: the CLI
  supplied a placeholder `execute.run` returning empty output, which the provider
  forwarded to the `gh` client and so shadowed the real command.
- **Integration tests were intermittently failing** with no failing assertion —
  `gh` calls exceeding vitest's 5s default under parallel load. Timeout raised
  to 30s.

### Notes

- The architecture test now knows about composition roots: `core/default-registry.ts`
  wires providers in, and `cli/commands/github.ts` is the user-facing surface for
  one provider. Everything else still must resolve by name through the registry.
- npm and PyPI providers land in Phases 6 and 7.

## [0.2.0] — 2026-10-01

Phase 1 — configuration system, and the terminal theme shared across the CLI.

### Added

- **`forge.config.yaml` support**: discovery walks up from the working directory
  and stops at `$HOME`, so `forge config show` works from any subdirectory without
  adopting an unrelated config from a parent.
- **Validation that reports every problem at once**, each with its path, what was
  expected, and what was received — not one failure per run.
- **Credentials rejected in config**, reported masked (`ghp_************`). Any key
  that looks like a secret and holds a literal value is flagged, including nested
  ones, since that is how they get committed. `tokenEnv` is the supported
  alternative.
- **Argument arrays required for check commands.** A string command is rejected
  because it invites shell interpolation, which the security spec forbids.
- **CLI overrides** — `--config`, `--registry`, `--dist-tag`, `--repository`.
- **`forge config` subcommands**: `show`, `validate`, `path`, `credentials`, `init`.
- **Terminal theme** (`src/ui/theme.ts`) matching the Hilbras design system: gold
  accent, dim secondary text, green/red reserved for pass/fail, and the house
  `✓` / `✗` / `→` glyphs. Output goes through one injected console so colour and
  indentation are consistent everywhere and tests need no TTY.
- **Colour control**: on for a TTY, `NO_COLOR` disables, `FORCE_COLOR` forces,
  `forge --no-color` per-run.
- **Credential resolution** (`src/authentication/index.ts`): resolves from the
  environment on demand, falls back to `gh auth token` for GitHub, and returns a
  struct that carries presence and identity but never the secret.

### Fixed

- **An enabled provider with no target is now an error.** Silently skipping meant
  `forge release` could report success while publishing nothing.
- **`forge config validate` exits 2 on failure.** It previously exited 0, so a CI
  step gating on it would pass on a broken config.
- **Commands report failures by throwing**, not by setting `process.exitCode`.
  The action-level assignment was overwritten when `main()` returned its own
  value, so a config failure vanished and exited 0.
- **`NO_COLOR=` (empty) no longer disables colour.** Only a real value counts;
  an empty variable exported by a wrapper script was silently killing colour.
- **`FORCE_COLOR` now actually reaches every command.** `forge config` built its
  own console without the palette, so colour never applied to it.

### Notes

- Exit codes moved to `src/cli/exit-codes.ts` so command modules can use them
  without importing the CLI entry point that imports them in turn.
- The architecture test now strips comments before checking for platform
  literals, so prose discussing provider names no longer trips it.

## [0.1.1] — 2026-10-01

Fixes a release-blocking bug found by installing the published package.

### Fixed

- **`forge` produced no output when installed as an npm package.** The
  entry-point guard compared `import.meta.url` against `process.argv[1]`
  without resolving symlinks. npm installs a `bin` as a symlink under
  `node_modules/.bin`, so the comparison failed, `main()` was never called,
  and every command exited 0 while printing nothing — a globally installed
  `forge` was unusable. Both paths are now resolved with `realpathSync` before
  comparison, with a suffix comparison as fallback.
- **Regression test** covering invocation through a `node_modules/.bin`
  symlink, which is how npm actually installs the binary.

## [0.1.0] — 2026-10-01

Phase 0 — Foundation.

### Added

- **Provider contract** (`Provider` interface): `capabilities`, `authenticate`,
  `validate`, `getVersion`, `publish`, `verify`. Providers declare what they can
  do rather than Core branching on platform names.
- **`ProviderRegistry`**: register, discover, resolve by name, and query
  capabilities. Factory-based so providers are constructed lazily and a
  registration can declare capabilities without instantiation.
- **Capability descriptors** (`Capability`): `repository`, `tags`, `releases`,
  `assets`, `package`, `publish`, `dist-tags`, `upload`, `verify`. Registration
  validates that a provider implements the method each advertised capability
  requires, so a provider cannot claim `publish` and silently do nothing.
- **Error taxonomy**: `ForgeError` with a stable machine-readable `code`,
  plus `ConfigError`, `AuthError`, `VersionError`, `CheckError`,
  `ProviderError`, `DuplicateReleaseError`, `VerificationError`, and
  `EnvironmentError`. `format()` renders what failed, why, which operation was
  affected, and the next step.
- **`toForgeError()`** normalizes any thrown value into a `ForgeError`, so
  provider-specific failures surface uniformly without Core knowing the platform.
- **Redaction utilities** (`src/utils`): `maskSecret()` renders credentials as
  `ghp_************`, `redact()` and `createRedactor()` strip known secret values
  from arbitrary text. The foundation of the Phase 11 security work.
- **`forge` CLI**: `forge --help`, `forge --version`, `forge provider list`,
  `forge provider capabilities`. Meaningful exit codes — 1 generic, 2 config,
  3 verification, 4 confirmation required.
- **Module boundaries** for core, providers, release, version, build,
  verification, configuration, authentication, reporting, errors, and utils.
- **Toolchain**: TypeScript 5.9 (strict, `noUncheckedIndexedAccess`), ESLint 9
  with type-aware rules, Prettier, Vitest 5. Zero known vulnerabilities.
- **CI** across Linux, Windows, and macOS running lint, format check, typecheck,
  tests, and build, plus a job that fails if the published tarball contains
  tests, sources, or task files.

### Notes

- `forge release` is not available yet. Providers and orchestration land in
  Phases 3 and 8.
- Node engine is `>=22`; developed and verified against Node 24 and 26.
- `provider list` is empty by design — it demonstrates that Core drives entirely
  through the registry.

[Unreleased]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.0...HEAD
[0.9.1]: https://github.com/Hilbras/hilbras-forge/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/Hilbras/hilbras-forge/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hilbras/hilbras-forge/releases/tag/v0.1.0
