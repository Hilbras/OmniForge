# Maintaining Hilbras Forge

Notes for working on Forge itself, as opposed to using it. Verified 2026-10-01.

## Language and layout

TypeScript on Node >= 22, ESM (`"type": "module"`), compiled to CommonJS-free ESM
output under `dist/`. Strict mode with `noUncheckedIndexedAccess`, so an array
index yields `T | undefined` — handle it rather than asserting.

| Path                    | Role                                             |
| ----------------------- | ------------------------------------------------ |
| `src/core/`             | Provider contract + registry. Platform-agnostic. |
| `src/providers/<name>/` | One directory per platform.                      |
| `src/release/`          | Step pipeline (Phase 8).                         |
| `src/cli/`              | Command wiring and process concerns only.        |

## The rule that matters

**Core never learns a platform name.** No imports from `src/providers/`, no
`=== 'npm'`, no `new SomeProvider()` outside `src/cli/` and `src/index.ts`.
`tests/unit/architecture.test.ts` asserts all three and fails CI on violation.

If a feature seems to need platform branching, the missing abstraction is
usually in the `Provider` interface. Widen it there, not in Core.

## Verification gate

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

`npm test` runs `pretest`, which builds `dist/` first. That matters: the CLI
integration tests execute the built output, not the TypeScript source. Running
`vitest` directly skips the build and can pass against a stale `dist/`.

## Traps already hit

### Entrypoint guard must resolve symlinks

npm installs a `bin` as a **symlink** under `node_modules/.bin`. An
`isDirectRun()` that compares `import.meta.url` to `process.argv[1]` unresolved
makes the CLI exit 0 printing nothing. Both paths need `realpathSync` first.
Fixed in 0.1.1; `tests/integration/cli.test.ts` covers it by invoking through a
real symlink. **Any new entry point needs the same treatment.**

Verifying this locally is not enough. `node dist/cli/index.js` and `npm link`
both work while the published package is broken — only
`npm install @hilbras/forge@<v>` in a clean directory exercises the real path.

### Version numbers must exist

The first `npm publish` of this package was written with guessed dependency
versions (`eslint@^9.90.0`, which never existed). `npm install` failed with
ERESOLVE. Check the real latest with `npm view <pkg> version` rather than
estimating.

### npm propagation is slow and the local proxy caches it

After `npm publish` returns, the version can take 1-4 minutes to appear. During
that window `npm view` and `npm install` may 404 or report `notarget` **even
though the publish succeeded** — the metadata GET is served from a stale proxy
cache while the write path is authoritative.

How to tell whether a publish actually landed:

```bash
npm publish --access public   # retry deliberately
```

- `E403 ... You cannot publish over the previously published versions: X.Y.Z`
  → **the version is live.** This is the reliable signal.
- Success (a fresh version) → it had not landed; try again later.

Never burn a new version number to work around this; the original one is fine.

To install despite the cache:

```bash
npm install @hilbras/forge@0.1.1 --prefer-online
# or
npm install https://registry.npmjs.org/@hilbras/forge/-/forge-0.1.1.tgz
```

### Version bumps are manual

`package.json` is the single source of truth for the version. `forge --version`
reads it via `createRequire`, and `CHANGELOG.md` must be updated in the same
commit. There is no automation for this yet — Phase 4's version management
covers managed projects, not Forge's own release.

### Prettier and planning documents

`tasks/` is in `.prettierignore`. The plan's wide ASCII tables are not
idempotent under Prettier, so including it makes `format:check` fail every run.

### Vitest subprocess tests

The CLI integration tests run `dist/cli/index.js` through
`process.execPath`. Spawning `npx tsx` per test cost ~5s each and blew the
default 5s timeout. Do not reintroduce it.

## Releasing Forge

The sequence, which is also what `forge` will eventually automate:

1. `npm run lint && npm run format:check && npm run typecheck && npm test`
2. Bump `package.json` version.
3. Update `CHANGELOG.md` with the new section and its compare link.
4. `npm publish --access public`.
5. `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`.
6. `gh release create vX.Y.Z --title "..." --notes "..."`.
7. **Verify** — install from the registry in a clean directory and run the
   binary. Do not trust the publish output; 0.1.0 shipped broken precisely
   because that step was skipped.

npm refuses to republish a version. A bad 0.1.0 costs a 0.1.1 forever, so
step 7 is not optional.
