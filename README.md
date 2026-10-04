# Hilbras Forge

**Unified release, publishing, versioning, and package management platform.**

Forge is a provider-based release orchestrator. One command validates your project,
computes the next version, runs your checks, tags, creates a GitHub Release,
publishes to npm and PyPI, verifies what actually landed, and hands you a report.

```text
Project → Config → Validation → Version → Checks → Build
        → Git tag → GitHub Release → npm → PyPI → Verify → Report
```

> **Status: v1.0.0.** Every phase of the plan is implemented. `forge release`
> runs the whole workflow — validate, check, version, tag, publish, verify, report —
> across GitHub, npm, and PyPI, and refuses to report success when the providers
> disagree. 841 tests.
>
> One caveat, stated plainly: **no real PyPI upload has been performed.** The
> provider is implemented and unit-tested, and a real sdist and wheel were built
> and passed `twine check`, but the credentials could not be confirmed from an
> environment whose proxy intercepts `upload.pypi.org`. Use a throwaway project
> name for your first PyPI publish. See [Project status](#project-status).

---

## Why provider-based

Forge Core contains no platform-specific logic. Every platform is a provider
behind one interface, so adding Docker Hub, GitLab, crates.io, or a private
registry means adding a directory — not editing the release engine.

```text
Forge Core
    │
    └── Provider System
          ├── GitHub
          ├── npm
          └── PyPI
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

Starting from nothing:

```bash
forge init                # detect the project, write forge.config.yaml
forge config validate     # every problem at once, exits 2 on failure
forge check               # run the configured checks
forge release --dry-run   # the whole workflow, changing nothing
```

`forge init` reads `package.json` or `pyproject.toml` and fills the config in
from what it finds. It deliberately leaves `github.repository` as a comment
rather than guessing: an owner/name silently pointed at the wrong repository is
worse than an obvious blank.

Once set up:

```bash
forge --help              # discover commands
forge --version           # print the installed version
forge config show         # resolved configuration, secrets never shown
forge config credentials  # what is available, never any value
forge provider list       # registered providers
forge github status       # auth, repository, branch, dirty state
forge version current     # the project version and where it came from
forge npm status          # auth, package, and registry state
forge verify              # does every provider agree on one version?
```

Every command documents itself with `forge <command> --help`.

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

| Phase | Scope                                      | State                                      |
| ----- | ------------------------------------------ | ------------------------------------------ |
| 0     | Foundation, CLI, provider contract         | Done — v0.1.0                              |
| 1     | `forge.config.yaml` loading and validation | Done — v0.2.0                              |
| 2     | Provider registry and lifecycle            | Done — v0.3.0                              |
| 3     | GitHub provider                            | Done — v0.4.0                              |
| 4     | Version management                         | Done — v0.5.0                              |
| 5     | Check and build engine                     | Done — v0.6.0                              |
| 6     | npm provider                               | Done — v0.7.0                              |
| 7     | PyPI provider                              | Implemented, one path unverified — v0.10.0 |
| 8     | Release orchestration                      | Done — v0.8.0                              |
| 9     | Verification and integrity                 | Done — v0.9.0                              |
| 10    | Release reporting                          | Done — v0.9.0                              |
| 11    | Security hardening                         | Done — v0.9.0                              |
| 12    | Testing and reliability                    | Done — v0.9.0, 841 tests                   |
| 13    | CLI and developer experience               | Done — v0.9.1                              |
| 14    | Documentation                              | Done — v0.9.2                              |
| 15    | Release candidate                          | Done — v1.0.0-rc.1, rc.2                   |
| 16    | Stable v1.0.0                              | **This release**                           |

### What is verified

| Check                          | Result                                               |
| ------------------------------ | ---------------------------------------------------- |
| Tests                          | 841 passing, coverage thresholds enforced            |
| Lint, format, typecheck, build | clean                                                |
| `npm audit`                    | 0 vulnerabilities                                    |
| CI matrix                      | Node 22.12, 24, 26 × Linux, macOS, Windows           |
| GitHub provider                | live: repository, tags, releases, verification       |
| npm provider                   | live: publish, dist-tags, registry verification      |
| PyPI provider                  | verification live; build live; **upload unverified** |
| `forge release --dry-run`      | exit 0, every provider rehearsed, tree unchanged     |

### What is not

**A real PyPI upload.** Everything up to it is tested — a real sdist and wheel were
built from a real `pyproject.toml`, `twine check` passed both, and live
verification against PyPI reports a real release correctly. The upload itself has
never run, because the credentials in `~/.pypirc` cannot be confirmed from an
environment whose proxy answers `upload.pypi.org` identically to valid and invalid
credentials.

For your own first PyPI publish: use a throwaway project name. PyPI names are
permanent, and it is better to burn one deliberately.

---

## Roadmap

Released, in order:

```text
v0.1.0 – v0.2.0   Foundation, configuration, provider system
v0.3.0 – v0.6.0   GitHub, versioning, checks, npm
v0.7.0 – v0.9.0   Orchestration, verification, reporting, security
v0.9.1 – v0.9.6   CLI UX, testing, documentation
v0.10.0           PyPI provider
v1.0.0-rc.1/2     Release candidates
v1.0.0            Stable
```

Next, in rough priority order:

- **Verify a real PyPI upload** with a throwaway project name.
- **Docker Hub** — the first provider outside the JS/Python pair, and the real
  test of whether the provider contract generalises. See
  [Writing a provider](docs/provider-development.md).
- **GitLab and Bitbucket**, which need only a different API client.
- **Homebrew** and a private registry, both mostly `twine`-shaped.
- **crates.io, NuGet, Maven Central, RubyGems** — same shape again.

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

## Documentation

| I want to                    | Read                                                     |
| ---------------------------- | -------------------------------------------------------- |
| Set it up and ship something | [Getting started](docs/getting-started.md)               |
| See every flag               | [CLI reference](docs/cli.md) — generated from the binary |
| Configure a project          | [Configuration](docs/configuration.md)                   |
| Understand a provider        | [Providers](docs/providers.md)                           |
| Add a new platform           | [Writing a provider](docs/provider-development.md)       |
| Understand the design        | [Architecture](docs/architecture.md)                     |
| Fix something that broke     | [Troubleshooting](docs/troubleshooting.md)               |
| Release Forge itself         | [Maintaining](docs/maintaining.md)                       |

`docs/cli.md` is generated by `npm run docs:cli` and CI fails if it is stale, so
the reference cannot drift away from the actual help text.

## License

MIT — see [LICENSE](LICENSE).
