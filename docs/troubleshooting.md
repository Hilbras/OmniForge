# Troubleshooting

Every error Forge prints names what failed, why, which operation was affected,
and what to do next. This page is organised by symptom.

```text
✗ 1.4.0 is already published as npm.

  Operation:  npm.publish
  Code:       DUPLICATE_RELEASE
  Next step:  npm does not allow overwriting a version. Choose a higher one, or
              unpublish first if you are certain.
```

Run any command with `--verbose` to add stack traces.

## Exit codes

| Code | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `0`  | Success                                                         |
| `1`  | Something failed                                                |
| `2`  | Configuration is invalid, or a config already exists            |
| `3`  | Verification failed — a release does not agree with itself      |
| `4`  | A destructive operation needed confirmation that did not arrive |

Distinct codes exist so CI can tell a bad config from a failed publish without
parsing text.

---

## Credentials

### `403 Forbidden` from npm

Your token cannot publish. Check, in order:

```bash
forge config credentials          # is NPM_TOKEN even set?
npm whoami                        # is it valid?
```

- The token needs **write** access, not just read.
- A **scoped** package needs 2FA set to `auth-and-publish` mode. `npm profile
enable-2fa auth-and-publish`.
- A package you are not a maintainer of cannot be published at all.

### GitHub says `Bad credentials (HTTP 401)`

`gh` prefers `GITHUB_TOKEN` over its own stored session, so an expired variable
shadows a working `gh auth login`.

```bash
gh auth status                   # does the session work?
echo "${GITHUB_TOKEN:+set}"      # is a stale variable shadowing it?
unset GITHUB_TOKEN               # then retry
```

### `no changes were made` but nothing appears to have happened

That is the dry-run output. `--dry-run` changes nothing at all — it is not a
weaker release.

---

## Configuration

### `github is enabled but no target is configured`

Set `github.repository` in `forge.config.yaml`. `forge init` deliberately leaves
it as a comment rather than guessing.

### `forge config validate` reports several problems at once

Intentional — one pass to fix them. Each has a path:

```text
forge.config.yaml has 2 configuration problems:
  npm.package: Required when npm is enabled
    expected a string, received null
  version.tagPrefix: Must be a non-empty string
```

### YAML parse errors quote the exact line

```text
…is not valid YAML: Map keys must be unique at line 30, column 3:

  lint: false
  lint: false
  ^
```

Often a copy-paste that duplicated a key.

---

## Checks

### `npm error Missing script: "test"`

`checks: { test: true }` expands to `npm test`. If you have no `test` script, set
it to `false` or give the real command:

```yaml
checks:
  test:
    command: ['npx', 'vitest', 'run']
```

`forge init` only enables checks whose scripts exist, so this should not happen
from a generated config.

### `Check "test" failed: exited 1`

The check ran and the command failed. Read the captured output above the error,
or rerun with `--verbose-output`.

### A failing check will not stop the release

It is marked optional:

```yaml
checks:
  lint:
    command: ['npm', 'run', 'lint']
    optional: true # recorded, but does not halt
```

Optional is for checks that are informational. A mandatory check that fails stops
the pipeline before anything is published.

### A check hangs

Give it a timeout:

```yaml
checks:
  test:
    command: ['npm', 'test']
    timeoutMs: 300000
```

---

## Versioning

### `Version 1.4.0 is already published as npm`

npm and GitHub both treat a published version as immutable. Forge will not
overwrite. Bump higher:

```bash
forge version bump --patch
```

### `package.json says 1.4.0 but npm says 1.3.0`

A real mismatch, and the pipeline stops before tagging. Usually a previous
release bumped the file but the publish failed. Reconcile deliberately:

```bash
forge version current          # what the files say
forge npm status               # what the registry says
```

---

## Releasing

### `forge release` refuses to run non-interactively

Destructive operations need confirmation, and there is no terminal to ask. Pass
`--yes` explicitly, which makes the decision visible in your CI log:

```bash
forge release --patch --yes
```

### `Tag v1.4.0 already exists`

Someone tagged it already. Check whether the release is live:

```bash
forge github tag --show
forge verify 1.4.0
```

If the tag exists but nothing was published, you can continue with the publish
steps rather than re-tagging.

### `Not inside a git repository`

Forge needs a repository to tag. Run it from your project root, or `git init`.

### A release failed halfway

The report tells you exactly how far it got:

```bash
cat .forge/releases/1.4.0.json
```

```json
{
  "outcome": "failed",
  "steps": [
    { "step": "tag", "status": "passed" },
    { "step": "publish", "provider": "npm", "status": "failed" }
  ]
}
```

Nothing is rolled back automatically — GitHub and PyPI have no unpublish that is
safe to automate. Recover by fixing the cause and publishing the remainder.

---

## Verification

### `Release integrity check failed`

Every provider must report one version. This is the check that catches a release
where GitHub succeeded and npm did not — a state no single provider can detect.

```text
✗ npm reports 1.3.0, expected 1.4.0
✗ npm: version-exists — 1.4.0 not published
```

### `github could not be reached`

A token or network problem, **not** a missing release. Forge distinguishes these:
a 401 raises an auth error rather than reporting the tag as absent. Check
`gh auth status`.

### An older version now fails `dist-tag-matches`

It should not — that check is only enforced for the version currently being
released, because `latest` moves on by design. If you see it, the version you are
verifying is the newest published one.

---

## Reporting

### Where are reports written

```text
.forge/
├── releases/
│   ├── 1.4.0.json
│   └── 1.4.0.md
└── audit.log
```

JSON is for machines, Markdown for humans, `audit.log` is JSON Lines recording
operation, provider, timestamp, result and error code — never free text, so it
cannot carry a credential.

### A secret appeared in a report

It should not, and there is a test asserting it cannot: every report is passed
through the credential registry before it is written, and every subprocess
credential is registered when it is resolved. If you find one, it is a bug worth
reporting privately.

---

### `twine could not start`

twine failed before uploading anything. Usually one of two things:

```bash
twine --version          # does twine run at all?
echo "$PYTHONPATH"       # is a stale path shadowing its dependencies?
```

An inherited `PYTHONPATH` pointing at another virtualenv's `site-packages` will
break twine with `ImportError: cannot import name 'errors' from 'packaging'`, even
though twine is installed correctly. Unsetting `PYTHONPATH` fixes it.

---

## Getting help

Include, from a version that reproduces it:

```bash
forge --version
forge config validate
forge config show        # values are masked
forge provider list
node --version
```

Then open an issue, or use GitHub Security Advisories if it involves a
credential. Never paste a token — the redaction will catch most of them, but do
not rely on it.
