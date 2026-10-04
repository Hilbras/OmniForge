# Hilbras Forge

**Unified release, publishing, versioning, and package management platform.**

Forge is a provider-based release orchestrator. One command validates your project,
computes the next version, runs your checks, tags, creates a GitHub Release,
publishes to npm and PyPI, verifies what actually landed, and hands you a report.

```text
Project → Config → Validation → Version → Checks → Build
        → Git tag → GitHub Release → npm → PyPI → Verify → Report
```

> **Status: v0.9.0 — testing and reliability.** `forge release` runs the whole
> workflow, `forge verify` checks afterward that every provider agrees on one
> version, and credential redaction is enforced at every output sink. 708 tests,
> with coverage thresholds that fail the build. GitHub and npm are implemented;
> PyPI is pending credentials. See [Roadmap](#roadmap).

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

Requires Node.js >= 22.12. The minor matters: `commander` needs `>=22.12.0` and
vitest needs `^22.12.0`. CI tests 22.12, 24, and 26 on all three platforms.

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
forge npm status          # auth, package, and registry state
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

## Releasing

```bash
forge release --dry-run            # see the plan, change nothing
forge release --patch              # the real thing
forge release --minor --prerelease
forge release 1.4.0                # an exact version
forge release --provider npm       # one provider only
forge release --patch --report json
```

The workflow:

```text
configure → authenticate → validate → checks → version → tag
          → publish each provider → verify → report
```

**A failing mandatory check halts the run.** Nothing is tagged, nothing is
published, and the steps that were skipped are listed so you can see what did
not run. Checks run _before_ the version is written, so a failure never leaves
your files modified.

A failed release exits non-zero, so a CI step gating on `forge release` cannot
pass on a release that published nothing.

`--dry-run` changes nothing — no tag, no push, no publish, no file write — while
still showing the full plan. It does invoke each provider's dry-run path, because
that is what actually validates the pack (`npm publish --dry-run` really packs
and reports the file list).

`--report json|markdown` writes `.forge/releases/<version>.{json,md}`.

> **Publishing is irreversible on npm and PyPI.** Run `--dry-run` first, and try
> a throwaway package before your first real release.

---

## Verifying a release

`forge verify` answers one question: does every provider agree on one version?

```bash
forge verify              # the current version
forge verify 1.2.3        # a specific version
forge verify --provider npm github
forge verify --report json
```

```text
Verify @hilbras/forge@0.8.0
✓ github     v0.8.0       ok
✓ npm        0.8.0        ok

✓ 0.8.0 verified across 2 provider(s)
```

A release where GitHub says `1.5.0` and npm says `1.4.0` is broken in a way no
single provider can detect, because each is individually correct. That is what
this command exists for. On a mismatch it names the check that broke and exits
`3`, so a deploy step can gate on it:

```text
Verify @acme/sdk@9.9.9
✗ github     —            failed
✗ npm        —            failed
  github: tag-exists — v9.9.9 not found on the remote
  npm: version-exists — 9.9.9 not published

✗ 9.9.9: 2 problem(s)
```

`forge release` runs the same check automatically as its final step, so a partial
release fails the command rather than reporting success.

**A failed read is never reported as a missing release.** If your token is
expired, you get an auth error — not a claim that a healthy release is missing,
and not advice to re-publish on top of a working setup.

---

## Publishing to npm

```bash
forge version bump --patch   # bump package.json first — npm only publishes what's in it
forge npm status             # check auth and what is already published
forge npm publish --dry-run  # pack and report without uploading
forge npm publish --yes      # the real thing
forge npm verify --release-version 1.2.3
```

There is deliberately **no `--version` flag** on `forge npm publish`. `npm publish`
only ever publishes the version in `package.json`, so a flag that appeared to
override it would silently do nothing while reporting success. Bump the file
first.

**A prerelease never gets the `latest` tag.** Forge picks `next`, `beta`, or
`alpha` from the version, and refuses outright if you try to force `latest`:

```text
✗ 1.0.0-rc.1 is a prerelease and cannot be tagged latest.
```

`--dry-run` really runs npm with `--dry-run`, so a broken `files` allowlist or a
missing build output is caught before an irreversible publish.

Credentials come from `NPM_TOKEN` and are passed through the environment, never as
a CLI argument — an argument is visible in the process list.

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
`PYPI_TOKEN`) and are never stored in `forge.config.yaml`. Storing one in config
is rejected outright and reported masked.

**Redaction happens at the sink, not at each call site.** Every string the CLI
emits passes through a redactor before it reaches stdout, stderr, or a report
file. That matters because provider stderr routinely echoes back the token that
was passed on a command line — `npm ERR! Authorization: Bearer npm_…` — and that
text ends up inside a `ForgeError` detail and then inside a report on disk.
Redacting once at the sink is correct for every caller, including ones written
later.

Also in place:

- Commands run as argument arrays with `shell: false`. A metacharacter in an
  argument is data, never syntax.
- Credentials travel through the child process environment, never as a CLI
  argument — an argument is visible in the process list.
- `src/build/validate.ts` flags a suspicious command: a shell interpreter, a
  working directory outside the project, an overridden `PATH`/`LD_PRELOAD`, or a
  credential passed as an argument.
- `.forge/audit.log` records operation, provider, timestamp, result, and error
  code. Deliberately no free text, so it cannot carry a secret.
- Duplicate tag, release, and version protection; destructive operations confirm
  first and refuse without `--yes` in a non-interactive shell.

75 security tests plant a canary credential in every sink — stdout, stderr, error
details, stack traces, and written reports — and assert it appears in none.

Report a vulnerability via GitHub Security Advisories — not a public issue.

---

## License

MIT — see [LICENSE](LICENSE).
