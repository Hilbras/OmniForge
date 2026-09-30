# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
[0.1.1]: https://github.com/Hilbras/hilbras-forge/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Hilbras/hilbras-forge/releases/tag/v0.1.0
