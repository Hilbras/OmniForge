# Configuration

Forge reads `forge.config.yaml` from your project. Every field is optional except
what a provider needs to do its job — an enabled provider with no target is a
configuration error, not something Forge skips.

## Discovery

Forge walks **up** from the working directory looking for `forge.config.yaml` or
`forge.config.yml`, stopping at `$HOME`. So this works from anywhere in a repo:

```bash
cd packages/core/src
forge config show
```

Discovery never adopts a config above `$HOME`, so running Forge outside a project
does not silently pick up an unrelated file.

Use `--config <path>` to bypass discovery entirely. An explicit path that does not
exist is an error — Forge will not fall back to defaults when you named a file.

## Reference

```yaml
project:
  name: hilbras-ai-sdk # Falls back to the directory name

version:
  strategy: semver # semver | manual | none
  file: package.json # Where the project's own version lives
  tagPrefix: v

github:
  enabled: true
  repository: Hilbras/Hilbras-ai-sdk # Required when enabled: owner/name
  draft: false
  prerelease: false
  notesTemplate: .github/RELEASE_TEMPLATE.md

npm:
  enabled: true
  package: '@hilbras/ai-sdk' # Required when enabled
  registry: https://registry.npmjs.org
  distTag: latest # latest | next | beta | alpha
  access: public

pypi:
  enabled: false
  package: hilbras-ai-sdk
  repository: hilbras # Organization or user account on PyPI

checks:
  test: true # Shorthand for: npm test, mandatory
  lint: true
  build: true
  typecheck:
    command: ['npm', 'run', 'typecheck']
    optional: true
    timeoutMs: 120000

order:
  - github
  - npm
  - pypi
```

### Defaults

| Field                | Default                      |
| -------------------- | ---------------------------- |
| `version.strategy`   | `semver`                     |
| `version.tagPrefix`  | `v`                          |
| `npm.registry`       | `https://registry.npmjs.org` |
| `npm.distTag`        | `latest`                     |
| `npm.access`         | `public`                     |
| `checks.*.timeoutMs` | `600000`                     |
| `order`              | `github`, `npm`, `pypi`      |
| every `*.enabled`    | `false`                      |

## Checks

A check runs a command and gates the release on its exit code.

**`command` must be an argument array.** A string is rejected:

```yaml
# Rejected — invites shell interpolation, which the security spec forbids.
checks:
  test:
    command: 'npm test && echo done'

# Accepted.
checks:
  test:
    command: ['npm', 'test']
```

`optional: true` records a failure without halting the release. Mandatory checks
stop the pipeline before anything is published.

The boolean shorthand expands to the matching npm script:

| Key           | Command             |
| ------------- | ------------------- |
| `test`        | `npm test`          |
| `lint`        | `npm run lint`      |
| `build`       | `npm run build`     |
| `typecheck`   | `npm run typecheck` |
| anything else | `npm run <name>`    |

`test: false` means the check is present but optional.

## Credentials

**Credentials never go in this file.** Forge reads them from the environment:

| Provider | Variable       | Fallback        |
| -------- | -------------- | --------------- |
| `github` | `GITHUB_TOKEN` | `gh auth token` |
| `npm`    | `NPM_TOKEN`    | —               |
| `pypi`   | `PYPI_TOKEN`   | —               |

Validation actively rejects a credential stored in config, reporting it masked:

```yaml
# Rejected.
github:
  GITHUB_TOKEN: ghp_1234567890abcdefghijklmnop

# ✗ github.GITHUB_TOKEN: Credentials must not be stored in configuration.
#     Point to an environment variable instead
#     expected e.g. tokenEnv: GITHUB_TOKEN, received ghp_************
```

To use a differently-named variable, point at it by name:

```yaml
github:
  tokenEnv: MY_ORG_GITHUB_TOKEN
```

`forge config credentials` reports what is available without revealing any value:

```text
Credentials
✓ github — available via gh auth token as lacrous
npm — not set (NPM_TOKEN)
pypi — not set (PYPI_TOKEN)
```

## Commands

```bash
forge config show              # Resolved config, defaults applied, no secrets
forge config validate          # Every problem at once; exits 2 on failure
forge config path              # Discovered path and project root
forge config credentials       # Credential presence, never values
forge config init              # Write a starter config (coming in Phase 1)
```

Overrides for a single run:

```bash
forge config show --registry https://registry.npmjs.org --dist-tag beta
forge config show --repository Other/Repo
```

## Exit codes

| Code | Meaning                                 |
| ---- | --------------------------------------- |
| `0`  | Success                                 |
| `1`  | Unclassified failure                    |
| `2`  | Config missing, unparseable, or invalid |
| `3`  | Verification or integrity failure       |
| `4`  | Destructive operation not confirmed     |

`forge config validate` exits `2` on any problem, so CI can gate on it:

```yaml
- run: npm install -g @hilbras/omniforge
- run: forge config validate
```

## Validation errors

Every problem is reported in one pass, with the path, what was expected, and what
was received:

```text
✗ /path/forge.config.yaml has 2 configuration problems:
  version.strategy: Unknown strategy "nonsense"
    expected semver, manual, none, received "nonsense"
  npm.distTag: Unknown dist-tag "canary"
    expected latest, next, beta, alpha, received "canary"
```

## Colour

Forge colours output only when stdout is a TTY. `NO_COLOR` disables it, and
`FORCE_COLOR` enables it for a non-TTY. An empty value for either counts as
unset. `forge --no-color` disables it per-run.
