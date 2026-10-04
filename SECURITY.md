# Security Policy

## Reporting a vulnerability

Do not open a public issue. Use GitHub Security Advisories on
[Hilbras/OmniForge](https://github.com/Hilbras/OmniForge/security/advisories/new).

Include the affected version, reproduction steps, and impact. You can expect an
acknowledgement within a few days and a fix or mitigation plan once confirmed.

## Supported versions

| Version | Supported                  |
| ------- | -------------------------- |
| < 0.1.0 | No — pre-release, no fixes |

Forge has not reached 1.0.0. Treat it as experimental: use it on projects where a
failed release would be inconvenient rather than damaging.

## Credential handling

Credentials are read from the environment and are never stored in
`forge.config.yaml`.

| Variable       | Used by         |
| -------------- | --------------- |
| `GITHUB_TOKEN` | GitHub provider |
| `NPM_TOKEN`    | npm provider    |
| `PYPI_TOKEN`   | PyPI provider   |

Guarantees the codebase is built around:

- Credentials resolve on demand via `ProviderContext.getSecret`; they are never
  part of the configuration object.
- `createRedactor()` strips known secret values from any text before it reaches a
  log, report, or error message.
- `maskSecret()` renders a credential as `ghp_************`, keeping only a
  recognizable prefix.
- `.gitignore` excludes `.env` and friends; `forge.config.yaml` never holds a
  secret by design, not just by convention.

Command-execution hardening, destructive-operation confirmation, and audit
logging land in Phase 11.

## Publishing safety

npm and PyPI do not allow re-publishing a version. Forge treats a version that
already exists as a duplicate-release error rather than attempting a publish, and
`forge release --dry-run` shows the full plan without making changes.
