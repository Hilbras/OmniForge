# Hilbras Forge

**Unified release, publishing, versioning, and package management platform.**

Forge is a provider-based release orchestrator. One command validates your project,
computes the next version, runs your checks, tags, creates a GitHub Release,
publishes to npm and PyPI, verifies what actually landed, and hands you a report.

```text
Project → Config → Validation → Version → Checks → Build
        → Git tag → GitHub Release → npm → PyPI → Verify → Report
```

> **Status: v0.2.0 — configuration.** The provider contract, error taxonomy, and
> `forge.config.yaml` system are in place and tested. Providers and the
> `forge release` command land in later phases. See [Roadmap](#roadmap).

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
```

`forge provider list` is intentionally empty today — providers register
themselves as they are implemented. That emptiness is the point: it proves Core
drives entirely through the registry.

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
| 3     | GitHub provider                            | Planned                       |
| 4     | Version management                         | Planned                       |
| 5     | Check and build engine                     | Planned                       |
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
