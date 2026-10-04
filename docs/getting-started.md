# Getting started

Ten minutes from an empty directory to a released package.

## 1. Install

```bash
npm install -g @hilbras/forge
```

Requires Node.js >= 22.12. Or skip installing:

```bash
npx @hilbras/forge --help
```

## 2. Generate a config

```bash
forge init
```

`forge init` reads `package.json` or `pyproject.toml` and writes a
`forge.config.yaml` already filled in, after showing you what it found:

```text
Forge init
directory    /home/you/my-lib
name         @acme/my-lib
ecosystem    npm
version      1.4.0
checks       test=true lint=false build=false

✓ Wrote /home/you/my-lib/forge.config.yaml
```

One thing is left for you on purpose:

```yaml
github:
  enabled: true
  # repository: owner/name   <- set this before releasing
```

Forge will not guess your repository. An `owner/name` silently pointed at the
wrong repo is worse than an obvious blank, and `forge release` will tell you it
is missing rather than proceeding.

## 3. Set your credentials

Credentials come from the environment, never from the config file:

```bash
export GITHUB_TOKEN=ghp_...
export NPM_TOKEN=npm_...
```

Check what Forge can see without printing any value:

```bash
forge config credentials
```

```text
Credentials
✓ github — available via gh auth token as your-account
npm — not set (NPM_TOKEN)
pypi — not set (PYPI_TOKEN)

  Values are never printed. Only presence and the variable name.
```

`gh auth login` also works for GitHub — Forge shells out to `gh` and inherits its
session.

## 4. Validate

```bash
forge config validate
```

```text
✓ /home/you/my-lib/forge.config.yaml is valid.
```

Reports every problem at once rather than the first one, so you fix them in one
pass. Exits `2` on failure.

## 5. Run your checks

```bash
forge check
```

```text
→ test npm test
✓ test       1.2s

✓ 1 passed, 1.2s
```

Configure them in `forge.config.yaml` with an **argument array**, never a shell
string:

```yaml
checks:
  test:
    command: ['npm', 'test']
  lint:
    command: ['npm', 'run', 'lint']
    optional: true # record a failure, but do not stop the release
```

`command: 'npm test && echo done'` is rejected. Without an array, Forge would
have to build a shell string, and a project name or branch containing `;` or `$(…)`
would stop being data and become syntax. It also means a check with a metacharacter
in it cannot do anything but log it.

`optional: true` is the exception worth knowing: a mandatory check that fails
halts the release before anything is published, while an optional one is recorded
and the pipeline continues.

Output:

```text
→ test npm test
✓ test       1.2s
→ lint npm run lint
✓ lint       0.4s

✓ 2 passed, 1.6s
```

`forge check --quiet` prints only the summary, which is what you want in CI —
the exit code is the signal.

## 6. Rehearse the release

```bash
forge release --dry-run
```

This is the step worth not skipping. It runs the real workflow — checks, version
calculation, provider authentication, `npm publish --dry-run` — and changes
nothing: no files written, no tags created, nothing published.

```text
Release Plan
project    @acme/my-lib
version    1.4.1
tag        v1.4.1
providers  github, npm
checks     test, lint

Dry run — no changes will be made.
✓ configure      @acme/my-lib — providers: github, npm
✓ authenticate   authenticated as your-account
✓ validate       ok
✓ checks         2 check(s) passed
✓ version        1.4.0 → 1.4.1
✓ write-version  would write 1.4.1
✓ tag            would create v1.4.1
✓ publish        would publish npm@1.4.1

Completed in 6.9s
No changes were made.
```

Read the `would …` lines as the plan. Nothing was written, tagged, or uploaded,
and `npm publish --dry-run` really did pack and validate the tarball.

## 7. Release

Publishing is **irreversible** on npm and PyPI. Forge asks for confirmation, and
refuses in a non-interactive shell unless you pass `--yes`:

```bash
forge release --patch
```

## 8. Verify

```bash
forge verify
```

```text
Verify @acme/my-lib@1.4.1
✓ github     v1.4.1       ok
✓ npm        1.4.1        ok

✓ 1.4.1 verified across 2 provider(s)
```

`forge release` runs this automatically as its last step. Run it separately any
time — after CI, before a deploy, or when you suspect a tag and a package
disagree.

---

## A full workflow

```bash
forge init                          # write a config
$EDITOR forge.config.yaml           # set github.repository
export GITHUB_TOKEN=... NPM_TOKEN=...
forge config validate               # catches problems early
forge check                         # run your checks
forge release --dry-run             # rehearse
forge release --patch               # do it
forge verify                        # confirm
```

## Where to go next

| I want to                   | Read                                               |
| --------------------------- | -------------------------------------------------- |
| See every flag              | [cli.md](cli.md) — generated from the binary       |
| Configure a project         | [configuration.md](configuration.md)               |
| Understand a provider       | [providers.md](providers.md)                       |
| Write my own provider       | [provider-development.md](provider-development.md) |
| Fix something that broke    | [troubleshooting.md](troubleshooting.md)           |
| Know how it is put together | [architecture.md](architecture.md)                 |
