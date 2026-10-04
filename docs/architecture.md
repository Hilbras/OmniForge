# Architecture

## The one rule

The Core never contains platform logic.

```text
Forge Core
    │
    └── ProviderRegistry
          ├── GitHubProvider
          ├── NpmProvider
          └── PypiProvider
```

Not this:

```ts
if (name === 'github') { … }
if (name === 'npm') { … }
```

Because the moment the Core knows a platform's name, adding another platform means
editing the orchestration — and that is what a release tool must not do. Forge
resolves providers by name through a registry and asks each one what it supports,
so a new platform is a new directory and one registration line.

This is enforced, not aspirational. `tests/unit/architecture.test.ts` fails the
build if a platform name appears in a conditional inside `core`, `release`, `cli`,
`version`, `verification`, or `reporting`, or if any of them imports a concrete
provider. It caught a real violation while `forge init` was being written.

## Layout

```text
src/
├── core/             provider contract, registry, composition root
├── providers/        one directory per platform
├── release/          the pipeline, orchestration, reporting, audit
├── version/          semver, version sources, the engine
├── build/            command execution, git, checks, command validation
├── verification/     cross-provider integrity
├── configuration/    discovery, parsing, schema, resolution
├── authentication/   credential resolution
├── ui/               console, palette, symbols
├── utils/            the secret registry
├── errors/           typed errors and terminal formatting
└── cli/              commander wiring, one file per command group
```

### Where things live, and why

| Directory      | Responsibility                | May it know about platforms? |
| -------------- | ----------------------------- | ---------------------------- |
| `core`         | The contract and the registry | No                           |
| `release`      | Ordering, halting, reporting  | No                           |
| `version`      | SemVer and version sources    | No                           |
| `build`        | Running commands, git, checks | No                           |
| `verification` | Do the providers agree?       | No                           |
| `cli`          | Argument parsing and output   | No                           |
| `providers/*`  | Everything platform-specific  | Only here                    |

### `core/default-registry.ts`

The single composition root, and the only file permitted to import a concrete
provider. Everything else resolves by name. Adding a provider means editing this
one file; the architecture test enforces that no other file does it.

## The release pipeline

```text
configure
   ↓
authenticate        each provider, independently
   ↓
validate            config, repository, version consistency
   ↓
checks              mandatory failures stop here
   ↓
version             computed, not yet written
   ↓
write version       only after checks pass
   ↓
tag
   ↓
publish             per provider, in configured order
   ↓
verify              does every provider agree?
   ↓
report
```

Two decisions worth knowing:

**Checks run before version files are written.** A failing test suite cannot leave
you with a bumped `package.json` and no release.

**Verification runs even after a partial failure.** When a release goes wrong,
knowing exactly what landed is the whole question. Skipped steps are recorded, not
dropped:

```json
{
  "outcome": "failed",
  "steps": [
    { "step": "tag", "status": "passed" },
    { "step": "publish", "provider": "npm", "status": "failed" },
    { "step": "publish", "provider": "pypi", "status": "skipped" }
  ]
}
```

## Error handling

One top-level handler in `src/cli/index.ts`. Commands throw typed errors; they
never call `process.exit` themselves.

```ts
throw new VerificationError(ErrorCode.INTEGRITY_FAILED, 'Release does not agree.', {
  operation: 'release.verify',
  remediation: 'Re-publish the missing provider, or roll back to one version.',
});
```

Every error carries four things: what failed, a code, which operation was
affected, and what to do next. The code maps to a process exit code through one
function, so a new error code cannot be forgotten by whoever handles it.

There is a documented trap here, written up in [maintaining.md](maintaining.md):
a command action that sets `process.exitCode` has it **overwritten** by the top
level returning `Success`. Two separate bugs came from that. Commands throw
instead.

## Security boundaries

| Concern            | Where                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Credentials        | `src/authentication`, `src/utils/secrets.ts`                         |
| Command execution  | `src/build/exec.ts` — argument arrays, `shell: false`                |
| Output redaction   | `src/ui/theme.ts` — at the sink                                      |
| Audit trail        | `src/release/audit.ts`                                               |
| Command inspection | `src/build/validate.ts` — available, not yet wired into the pipeline |

Three decisions carry most of the weight:

**Redaction happens at the sink, not at each call site.** Every string the CLI
emits passes through the redactor. Auditing call sites does not scale and misses
indirect paths — provider stderr routinely echoes back the token passed on a
command line, and that text ends up in an error detail and then in a report on
disk.

**Commands run as argument arrays.** A metacharacter in an argument is data. There
is no shell, so there is nothing for it to be syntax in.

**Credentials travel through the child environment, never argv.** An argument is
visible in the process list to every user on the machine.

## Testing strategy

| Layer        | How it is tested                           |
| ------------ | ------------------------------------------ |
| Unit         | Injected executors — a stub, not a process |
| Git          | A **real** repository in a temp directory  |
| Integration  | The built CLI, spawned as a subprocess     |
| Architecture | Source-level invariants                    |

Two lessons are baked in. A stubbed executor only proves the code calls what the
stub expects, which is why the git tests use a real repository. And the CLI is
tested by spawning the built binary, which is why its v8 coverage reads near-zero
while it is in fact well covered — coverage thresholds are therefore per-directory
and exclude the CLI, with integration tests holding it instead.

## Performance

Release time is dominated by subprocesses — checks, `gh`, `npm`, `git` — not by
Forge.

**Checks run sequentially**, deliberately. Three checks of 400ms each take about
1.6s, not 0.4s. That is a real cost, and it buys something: the output reads as an
ordered list, a failing check halts immediately instead of racing three others to
finish, and there is no interleaved output to untangle. When parallelism is worth
it, `sh -c 'a & b & wait'` is available — and `src/build/validate.ts` will warn
that a shell is involved.

npm registry reads carry `cache-control: no-cache` and a unique `cachebust`
parameter. Without it, a cached metadata document made Forge report an unpublished
version as already published, which blocked a legitimate release with "this
version already exists".

## Extending

See [provider-development.md](provider-development.md) for the full procedure and
[providers.md](providers.md) for what ships today.
