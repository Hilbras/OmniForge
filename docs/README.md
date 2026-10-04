# Documentation

## Start here

| I want to                    | Read                                               |
| ---------------------------- | -------------------------------------------------- |
| Set it up and ship something | [getting-started.md](getting-started.md)           |
| See every flag               | [cli.md](cli.md) — generated from the binary       |
| Configure a project          | [configuration.md](configuration.md)               |
| Understand a provider        | [providers.md](providers.md)                       |
| Write a new provider         | [provider-development.md](provider-development.md) |
| Know how it is put together  | [architecture.md](architecture.md)                 |
| Fix something that broke     | [troubleshooting.md](troubleshooting.md)           |
| Release Forge itself         | [maintaining.md](maintaining.md)                   |

Also in the repository root: [README](../README.md),
[CHANGELOG](../CHANGELOG.md), [CONTRIBUTING](../CONTRIBUTING.md), and
[SECURITY](../SECURITY.md).

## Which doc answers which question

**"How do I publish this?"** → [getting-started.md](getting-started.md)

**"What does `--dry-run` actually do?"** → [getting-started.md](getting-started.md),
step 6. It runs the real workflow and changes nothing.

**"Why is my credential not working?"** → [troubleshooting.md](troubleshooting.md),
Credentials. Note that `gh` prefers `GITHUB_TOKEN` over its own session.

**"Why does it say the release is missing when I can see it?"** →
[troubleshooting.md](troubleshooting.md), Verification. A token or network problem
is reported as unreachable, never as absent.

**"How do I add Docker Hub?"** → [provider-development.md](provider-development.md).
One directory and one line in `default-registry.ts`.

**"Can I use a shell string for a check?"** → No, and
[configuration.md](configuration.md) explains why. Use an argument array.

**"Why is the registry flat and the CLI thin?"** →
[architecture.md](architecture.md), The one rule.

## Conventions

Every documented command was run against a real CLI. Where output appears in these
docs, it is copied from an actual run rather than written from memory — which is
how the check syntax in `getting-started.md` was corrected after a draft showed a
form the validator rejects.

`cli.md` is generated:

```bash
npm run docs:cli        # regenerate
npm run docs:check      # fail if it is stale (CI does this)
```

Help text drifts silently otherwise: a flag is added, nobody updates the prose,
and the docs become wrong in a way nothing catches.
