# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
[0.3.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hilbras/hilbras-forge/releases/tag/v0.1.0
