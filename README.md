# Hilbras Forge

**Unified release, publishing, versioning, and package management platform.**

Forge is a provider-based release orchestrator. One command validates your project,
computes the next version, runs your checks, tags, creates a GitHub Release,
publishes to npm and PyPI, verifies what actually landed, and hands you a report.

```text
Project → Config → Validation → Version → Checks → Build
        → Git tag → GitHub Release → npm → PyPI → Verify → Report
```

> **Status: v0.4.0 — versioning and checks.** Configuration, the GitHub provider,
> semantic version management, and the check engine are in place and tested. npm,
> PyPI, and the `forge release` command land in later phases. See
> [Roadmap](#roadmap).

---

## Why provider-based

Forge Core contains no platform-specific logic. Every platform is a provider
behind one interface, so adding Docker Hub, GitLab, crates.io, or a private
registry means adding a directory — not editing the release engine.

```text
Forge Core
    │
    └── Provider System
          ├── GitHub    (Phase 3)
          ├── npm       (Phase 6)
          └── PyPI      (Phase 7)
```

This is enforced by an executable architecture test, not a convention: a test
fails the build if Core imports a provider or branches on a platform name.

---

## Install

Requires Node.js >= 22.

```bash
npm install -g @hilbras/forge
```

Or run without installing:

```bash
npx @hilbras/forge --help
```

---

## Usage

```bash
forge --help              # discover commands
forge --version           # print the installed version
forge config show         # resolved configuration, secrets never shown
forge config validate     # every problem at once, exits 2 on failure
forge config credentials  # what is available, never any value
forge provider list
forge github status       # auth, repository, branch, dirty state
forge version current     # the project version and where it came from
forge check               # run the configured checks
```

`forge provider list` is intentionally empty today — providers register
themselves as they are implemented. That emptiness is the point: it proves Core
drives entirely through the registry.

## Versions

```bash
forge version current                    # 1.4.0, from package.json
forge version next --patch               # 1.4.1
forge version next --minor --prerelease  # 1.5.0-rc.0
forge version bump --patch               # writes it, after confirming
forge version sources                    # which files are read
```

Forge does not assume where your version lives. It reads `package.json`,
`pyproject.toml` (both `[project]` and `[tool.poetry]`), a plain `VERSION` file,
or any `file.json:dotted.path` you name in `version.file`.

Writes are minimal: bumping `package.json` changes the version line and nothing
else — no key reordering, no reindentation, and `pyproject.toml` keeps its
comments.

**Disagreeing sources are an error.** If `package.json` says `1.4.0` and
`pyproject.toml` says `1.3.0`, Forge stops rather than publishing two versions
from one release.

Prereleases behave as you'd expect: `forge version next --prerelease` advances an
existing `2.3.4-rc.1` to `rc.2`, and `--patch` on it graduates to `2.3.4`.

---

## Checks

```yaml
checks:
  test: true
  lint: true
  build: true
  e2e:
    command: ['npx', 'playwright', 'test']
    optional: true
    timeoutMs: 900000
```

```bash
forge check              # everything
forge check test lint    # named checks
forge test
forge build
```

Commands are argument arrays and run **without a shell**, so a metacharacter in
an argument is data, never syntax. Output streams live so a long suite shows
progress.

A mandatory check that fails **halts the release** — later checks are recorded as
skipped and nothing is published. Mark a check `optional: true` to record its
failure without stopping.

---

## Releasing to GitHub

```bash
forge github status                      # check auth and working tree first
forge github tag --release-version 1.2.3 --push
forge github release --release-version 1.2.3
```

Release notes are generated from your `CHANGELOG.md`, a configured template, or
the commits since the last tag — in that order. Mutating commands ask before
writing and refuse without `--yes` when stdin is not a terminal, so nothing is
published from an unattended script by accident.

An existing tag or release is always reported rather than overwritten.

> Note the flag name: `--release-version`, not `--version`. Commander routes a
> subcommand option named `--version` to the root program's version handler, so
> `forge github release --version 1.2.3` would print the version and exit.

---

## Configuration

Drop a `forge.config.yaml` in your project root:

```yaml
project:
  name: hilbras-ai-sdk

github:
  enabled: true
  repository: Hilbras/Hilbras-ai-sdk

npm:
  enabled: true
  package: '@hilbras/ai-sdk'

checks:
  test: true
  lint: true
  build: true
```

Forge discovers it by walking up from the working directory, so it works from any
subdirectory. Credentials come from the environment (`GITHUB_TOKEN`, `NPM_TOKEN`,
`PYPI_TOKEN`) and a credential stored in the config file is rejected outright.

Full reference: [`docs/configuration.md`](docs/configuration.md).

---

## Project status

| Phase | Scope                                      | State                         |
| ----- | ------------------------------------------ | ----------------------------- |
| 0     | Foundation, CLI, provider contract         | Done                          |
| 1     | `forge.config.yaml` loading and validation | Done                          |
| 2     | Provider registry and lifecycle            | Contract done, wiring planned |
| 3     | GitHub provider                            | Done                          |
| 4     | Version management                         | Done                          |
| 5     | Check and build engine                     | Done                          |
| 6     | npm provider                               | Planned                       |
| 7     | PyPI provider                              | Planned                       |
| 8     | Release orchestration                      | Planned                       |
| 9     | Verification and integrity                 | Planned                       |
| 10    | Release reporting                          | Planned                       |
| 11    | Security hardening                         | Partially in place            |
| 12    | Testing and reliability                    | In progress                   |
| 13    | CLI and developer experience               | In progress                   |
| 14    | Documentation                              | In progress                   |
| 15–16 | RC and v1.0.0                              | Planned                       |

Full breakdown: [`tasks/plan.md`](tasks/plan.md) · Progress: [`tasks/todo.md`](tasks/todo.md)

---

## Roadmap

```text
v0.1.0  Foundation
v0.2.0  Configuration + provider system
v0.3.0  GitHub provider, versioning, checks
v0.4.0  npm + PyPI providers
v0.5.0  Orchestration, verification, reporting
v0.6.0  Security, testing, CLI, docs
v1.0.0-rc.1 → v1.0.0
```

Beyond v1: Docker Hub, GitLab, Bitbucket, crates.io, NuGet, Maven Central,
RubyGems, Homebrew, and custom registries.

---

## Development

```bash
git clone git@github.com:Hilbras/hilbras-forge.git
cd hilbras-forge
npm install
npm run build
npm test
```

| Script                  | Purpose                         |
| ----------------------- | ------------------------------- |
| `npm run build`         | Compile TypeScript to `dist/`   |
| `npm run typecheck`     | Types only, no emit             |
| `npm run lint`          | ESLint with type-aware rules    |
| `npm run format`        | Prettier write                  |
| `npm test`              | Vitest suite                    |
| `npm run test:coverage` | Vitest with V8 coverage         |
| `npm run dev`           | Run the CLI from source via tsx |

CI runs lint, format check, typecheck, tests, and build on Linux, Windows, and
macOS, and verifies the published tarball excludes tests and sources.

---

## Security

Credentials are read from the environment (`GITHUB_TOKEN`, `NPM_TOKEN`,
`PYPI_TOKEN`) and are never stored in `forge.config.yaml`. A redaction layer is
already in place: `createRedactor()` scrubs known secret values from any text
before it reaches a log, report, or error message, and `maskSecret()` renders
them as `ghp_************`.

Full security hardening lands in Phase 11.

Report a vulnerability via GitHub Security Advisories — not a public issue.

---

## License

MIT — see [LICENSE](LICENSE).
