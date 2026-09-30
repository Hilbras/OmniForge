# Contributing to Hilbras Forge

## Getting set up

```bash
git clone git@github.com:Hilbras/hilbras-forge.git
cd hilbras-forge
npm install
npm run build
npm test
```

Requires Node.js >= 22. The npm CLI and `gh` are needed for provider work.

## Before you open a pull request

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
```

All four must pass. CI runs the same four plus a build on Linux, Windows, and
macOS, and checks that the published tarball excludes tests and sources.

## The rule that matters most

**Core must never learn a platform name.** If you are working in `src/core`,
`src/release`, `src/cli`, `src/version`, `src/verification`, or
`src/reporting`, you may not:

- import anything from `src/providers/`
- write `if (provider === 'npm')` or any equivalent comparison
- instantiate a concrete provider

Ask a provider what it can do via `capabilities`, or resolve it by name through
`ProviderRegistry`. `tests/unit/architecture.test.ts` enforces all three rules and
will fail CI if you break them.

This is the property that lets Docker Hub, GitLab, or a private registry be added
without touching the release engine. It is worth more than any single feature.

## Adding a provider

1. Create `src/providers/<name>/index.ts`.
2. Implement the `Provider` interface from `src/core/provider.ts`:
   `capabilities`, `authenticate`, `validate`, `getVersion`, `publish`, `verify`.
3. Declare every capability you actually implement. The registry rejects a
   provider that advertises a capability without its required method.
4. Register the factory in `src/core/registry.ts` — the single composition root.
5. Add fixtures under `tests/fixtures/` and tests under `tests/unit/`.
6. Document it in `docs/providers/<name>.md`.

If you need a new capability that does not fit `Capability`, add it there and map
it to its required method in `CAPABILITY_METHODS` in `src/core/registry.ts`.

## Credentials

Never commit a token. Never log one. Never put one in a fixture, a snapshot, or a
test assertion.

Credentials resolve from the environment at runtime. If you need to assert that
redaction works, plant a fake token and assert it does not appear in output.

## Commit messages

Conventional Commits, since the changelog is generated from them:

```text
feat(npm-provider): add dist-tag support
fix(release): halt pipeline on mandatory check failure
docs(cli): document forge release flags
test(registry): cover duplicate registration
```

## Changelog

Update `CHANGELOG.md` under `## [Unreleased]`. Keep entries written for someone
reading the diff in six months — what changed and why, not which commit hash.
