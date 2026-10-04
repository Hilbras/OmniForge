# Providers

A provider is how Forge talks to one platform. The Core never contains platform
logic; it drives everything through the registry.

## What a provider is for

```text
Forge Core
    │
    └── ProviderRegistry
          ├── GitHubProvider
          ├── NpmProvider
          └── PypiProvider
```

Adding Docker Hub, GitLab, crates.io or a private registry means adding a
directory under `src/providers/`. Nothing in the Core, the release pipeline, or
the CLI changes. See [provider-development.md](provider-development.md).

## What each one does

```bash
forge provider list
```

```text
github
npm
```

```bash
forge provider capabilities
```

```text
github
  GitHub repositories: tags, releases, and release assets
  capabilities: repository, tags, releases, assets, verify
  version sources: git tags, GitHub releases
npm
  npm packages: publish, dist-tags, and registry verification
  capabilities: package, publish, dist-tags, verify
  version sources: package.json, npm registry
```

Capabilities are queried rather than assumed, so a caller can ask what a provider
supports instead of hardcoding which one it is talking to.

## GitHub

Authentication is through the [`gh` CLI](https://cli.github.com), so whatever
session `gh` has is the session Forge uses. Set `GITHUB_TOKEN` to override.

```bash
forge github status
```

```text
GitHub
gh CLI        available
✓ credentials   authenticated as your-account
repository    Hilbras/hilbras-forge
branch        main
commit        0bbd2d2
⚠ working tree  6 uncommitted change(s)
  package.json
  src/cli/commands/init.ts
  …and 4 more
```

```bash
forge github repository     # owner/name, default branch, visibility, URL
forge github tag            # create a tag, and push it
forge github tag --show     # read the latest remote tag, change nothing
forge github release        # create a release
```

```bash
forge github tag --release-version 1.4.0 --push
forge github release --release-version 1.4.0 --notes "First stable release"
```

`forge github tag`:

| Flag                         | Effect                                               |
| ---------------------------- | ---------------------------------------------------- |
| `--release-version <semver>` | Version to tag, without the prefix                   |
| `--show`                     | Show the latest remote tag without changing anything |
| `--push`                     | Push the tag to origin after creating it             |
| `--yes`                      | Skip the confirmation prompt                         |

`forge github release`:

| Flag                         | Effect                                    |
| ---------------------------- | ----------------------------------------- |
| `--release-version <semver>` | Version to release, without the prefix    |
| `--draft`                    | Create as a draft, not published          |
| `--prerelease`               | Mark as a prerelease                      |
| `--notes <text>`             | Release notes, instead of generating them |
| `--yes`                      | Skip the confirmation prompt              |

Without `--notes`, Forge takes the section for that version from your
`CHANGELOG.md` (`CHANGELOG.markdown` and `changelog.md` also work). With no
changelog entry, it falls back to the commits since the previous tag, so a release
without a changelog entry still gets real notes rather than an empty body.

**There is no `--version` flag.** Commander routes `--version` to the root
version handler, so `forge github release --version 1.4.0` would print `1.4.0` and
exit without creating anything. The flag is `--release-version`, and a test
enforces that no provider subcommand declares `--version`.

## npm

```bash
forge npm status
```

```text
npm
credentials   not set (NPM_TOKEN)
package      @acme/my-lib
  registry     https://registry.npmjs.org
  distTag      latest
published    12 version(s)
latest       0.9.1
  latest→0.9.1
  Set NPM_TOKEN to publish. Reading public packages needs no token.
```

Reading a public package needs no token. Publishing needs one with write access,
and for a scoped package, 2FA in `auth-and-publish` mode.

```bash
forge npm package                # validate name, version, and metadata
forge npm publish --dry-run      # pack and validate, upload nothing
forge npm publish                # the real thing, with confirmation
forge npm dist-tag --tag next --to 1.5.0-beta.1
forge npm verify --release-version 1.4.0
```

**There is deliberately no `--version` flag on `publish`.** `npm publish` only
ever publishes the version in `package.json`, so a flag that appeared to override
it would silently do nothing while reporting success. Bump the file first:

```bash
forge version bump --patch
forge npm publish
```

**A prerelease never gets `latest`.** Forge picks `next`, `beta`, or `alpha` from
the version, and refuses outright if you try to force `latest`:

```text
✗ 1.0.0-rc.1 is a prerelease and cannot be tagged latest.
  Use --tag next, or let Forge choose.
```

Because `latest` moves on, verification only enforces the expected dist-tag for the
version currently being released. Verifying an older release requires only that it
carries _some_ tag — an untagged version cannot be installed by name.

## PyPI

PyPI publishing is not implemented in V1. It is the one gap between the current
state and the V1.0.0 Definition of Done, which lists PyPI verification.

Everything around it is in place: `pypi` is a known provider name, the schema
accepts it, `forge init` generates a `pypi:` section for a Python project with a
PEP 503-normalised name, and the provider registry and pipeline are ready for it.
What is missing is the implementation and the credentials to test it against.

Until then, set `pypi: { enabled: false }`.

## Enabling and ordering

```yaml
github:
  enabled: true
  repository: Hilbras/hilbras-forge

npm:
  enabled: true
  package: '@hilbras/forge'

pypi:
  enabled: false

order:
  - github
  - npm
```

`order` is the order providers are acted on during a release. GitHub first is the
sensible default: a tag and release exist before anything is published, so a
failed upload leaves a recoverable state rather than a published version with no
release.

Disable a provider rather than removing it — `forge init` writes all of them, and
the schema expects the keys.
