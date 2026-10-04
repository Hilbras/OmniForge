# CLI reference

<!-- GENERATED FILE — run `npm run docs:cli` to regenerate. CI fails if this
     file no longer matches what the CLI actually prints. -->

Every command documents itself. This page is the same text, collected.

## Contents

- [forge](#forge)
- [forge init](#forge-init)
- [forge provider](#forge-provider)
- [forge provider list](#forge-provider-list)
- [forge provider capabilities](#forge-provider-capabilities)
- [forge config](#forge-config)
- [forge config show](#forge-config-show)
- [forge config validate](#forge-config-validate)
- [forge config path](#forge-config-path)
- [forge config credentials](#forge-config-credentials)
- [forge config init](#forge-config-init)
- [forge github](#forge-github)
- [forge github status](#forge-github-status)
- [forge github repository](#forge-github-repository)
- [forge github tag](#forge-github-tag)
- [forge github release](#forge-github-release)
- [forge npm](#forge-npm)
- [forge npm status](#forge-npm-status)
- [forge npm package](#forge-npm-package)
- [forge npm publish](#forge-npm-publish)
- [forge npm dist-tag](#forge-npm-dist-tag)
- [forge npm verify](#forge-npm-verify)
- [forge release](#forge-release)
- [forge verify](#forge-verify)
- [forge version](#forge-version)
- [forge version current](#forge-version-current)
- [forge version next](#forge-version-next)
- [forge version bump](#forge-version-bump)
- [forge version sources](#forge-version-sources)
- [forge check](#forge-check)
- [forge test](#forge-test)
- [forge build](#forge-build)

## forge

```
Usage: forge [options] [command]

Unified release, publishing, versioning, and package management platform

Options:
  -V, --version                Print the Forge version
  --verbose                    Print stack traces for unexpected errors
  --no-color                   Disable colored output
  -h, --help                   display help for command

Commands:
  provider                     Inspect registered release providers
  config                       Inspect and validate the project configuration
  github                       Inspect and manage GitHub release state
  npm                          Inspect and publish npm packages
  release [options] [version]  Run the full release workflow
  init [options]               Create a forge.config.yaml for this project
  verify [options] [version]   Confirm every provider agrees on the released
                               version
  pypi                         Inspect and publish PyPI packages
  version                      Inspect and compute project versions
  check [options] [names...]   Run the configured checks
  test [options]               Run the test check
  build [options]              Run the build check
  help [command]               display help for command
```

## forge init

```
Usage: forge init [options]

Create a forge.config.yaml for this project

Options:
  --force     Overwrite an existing config
  -h, --help  display help for command

Reads package.json or pyproject.toml to fill the config in, then shows what it
detected before writing.

github.repository is deliberately left as a comment: a guessed owner/name
silently pointed at the wrong repository is worse than an obvious blank, and
forge will refuse to release until you fill it in.

Never overwrites an existing config without --force.

Examples:
  $ forge init
  $ forge init --force
  $ cd new-project && forge init
```

## forge provider

```
Usage: forge provider [options] [command]

Inspect registered release providers

Options:
  -h, --help      display help for command

Commands:
  list            List every registered provider name
  capabilities    Show capabilities and version sources of every provider
  help [command]  display help for command

Examples:
  $ forge provider list
  $ forge provider capabilities
```

## forge provider list

```
Usage: forge provider list [options]

List every registered provider name

Options:
  -h, --help  display help for command
```

## forge provider capabilities

```
Usage: forge provider capabilities [options]

Show capabilities and version sources of every provider

Options:
  -h, --help  display help for command
```

## forge config

```
Usage: forge config [options] [command]

Inspect and validate the project configuration

Options:
  -h, --help          display help for command

Commands:
  show [options]      Print the resolved configuration
  validate [options]  Validate the configuration file
  path                Print the discovered config path and project root
  credentials         Report which credentials are available, without revealing
                      them
  init [options]      Write a starter forge.config.yaml
  help [command]      display help for command

Commands:
  show         Resolved configuration with defaults applied
  validate     Check the file and report every problem at once
  path         Print the discovered config path and project root
  credentials  Report which credentials are available, without revealing them

Examples:
  $ forge config show
  $ forge config show --registry https://registry.npmjs.org
  $ forge config validate
  $ forge config path
```

## forge config show

```
Usage: forge config show [options]

Print the resolved configuration

Options:
  --config <path>            Use a specific config file instead of discovery
  --registry <url>           Override the npm registry
  --dist-tag <tag>           Override the npm dist-tag
  --repository <owner/name>  Override the GitHub repository
  -h, --help                 display help for command
```

## forge config validate

```
Usage: forge config validate [options]

Validate the configuration file

Options:
  --config <path>  Use a specific config file instead of discovery
  -h, --help       display help for command
```

## forge config path

```
Usage: forge config path [options]

Print the discovered config path and project root

Options:
  -h, --help  display help for command
```

## forge config credentials

```
Usage: forge config credentials [options]

Report which credentials are available, without revealing them

Options:
  -h, --help  display help for command
```

## forge config init

```
Usage: forge config init [options]

Write a starter forge.config.yaml

Options:
  --force     Overwrite an existing config
  -h, --help  display help for command

An alias for the top-level `forge init`, which is where the detection logic
lives. Both behave identically.

Examples:
  $ forge config init
  $ forge config init --force
```

## forge github

```
Usage: forge github [options] [command]

Inspect and manage GitHub release state

Options:
  -h, --help         display help for command

Commands:
  status             Authentication, repository, and working-tree state
  repository         Repository metadata and default branch
  tag [options]      Show or create a release tag
  release [options]  Show or create a GitHub Release
  help [command]     display help for command

Commands:
  status      Authentication, repository, and working-tree state
  repository  Repository metadata and default branch
  tag         Show or create a release tag
  release     Show or create a GitHub Release

Examples:
  $ forge github status
  $ forge github repository
  $ forge github tag --show
  $ forge github tag --release-version 1.2.3
  $ forge github release --release-version 1.2.3
```

## forge github status

```
Usage: forge github status [options]

Authentication, repository, and working-tree state

Options:
  -h, --help  display help for command
```

## forge github repository

```
Usage: forge github repository [options]

Repository metadata and default branch

Options:
  -h, --help  display help for command
```

## forge github tag

```
Usage: forge github tag [options]

Show or create a release tag

Options:
  --release-version <semver>  Version to tag, without the prefix
  --show                      Show the latest remote tag without changing
                              anything
  --push                      Push the tag to origin after creating it
  --yes                       Skip the confirmation prompt
  -h, --help                  display help for command
```

## forge github release

```
Usage: forge github release [options]

Show or create a GitHub Release

Options:
  --release-version <semver>  Version to release, without the prefix
  --draft                     Create as a draft
  --prerelease                Mark as a prerelease
  --notes <text>              Release notes, instead of generating them
  --yes                       Skip the confirmation prompt
  -h, --help                  display help for command
```

## forge npm

```
Usage: forge npm [options] [command]

Inspect and publish npm packages

Options:
  -h, --help          display help for command

Commands:
  status              Authentication, package, and registry state
  package             Local package metadata as npm sees it
  publish [options]   Publish the current version
  dist-tag [options]  Show or move a dist-tag
  verify [options]    Confirm a version landed with the right dist-tag
  help [command]      display help for command

Commands:
  status      Authentication, package, and registry state
  package     Local package metadata as npm sees it
  publish     Publish the current version
  dist-tag    Show or move a dist-tag
  verify      Confirm a version landed with the right dist-tag

Examples:
  $ forge npm status
  $ forge npm package
  $ forge npm publish --dry-run
  $ forge npm publish --yes
  $ forge npm dist-tag
  $ forge npm verify --release-version 1.2.3
```

## forge npm status

```
Usage: forge npm status [options]

Authentication, package, and registry state

Options:
  -h, --help  display help for command
```

## forge npm package

```
Usage: forge npm package [options]

Local package metadata as npm sees it

Options:
  -h, --help  display help for command
```

## forge npm publish

```
Usage: forge npm publish [options]

Publish the current version

Options:
  --tag <tag>  Override the dist-tag
  --dry-run    Pack and report without uploading
  --yes        Skip the confirmation prompt
  -h, --help   display help for command
```

## forge npm dist-tag

```
Usage: forge npm dist-tag [options]

Show or move a dist-tag

Options:
  --tag <tag>     The dist-tag to move
  --to <version>  The version it should point at
  --remove        Remove the dist-tag instead of moving it
  --yes           Skip the confirmation prompt
  -h, --help      display help for command
```

## forge npm verify

```
Usage: forge npm verify [options]

Confirm a version landed with the right dist-tag

Options:
  --release-version <semver>  Version to verify; defaults to the current one
  -h, --help                  display help for command
```

## forge release

```
Usage: forge release [options] [version]

Run the full release workflow

Arguments:
  version                Release this exact version instead of computing one

Options:
  --major                Increment the major version
  --minor                Increment the minor version
  --patch                Increment the patch version (default when no strategy
                         given)
  --prerelease           Add or advance a prerelease tag
  --dry-run              Show the plan without changing anything
  --provider <names...>  Run only these providers, in order
  --report <format>      Also write a report: json | markdown
  --no-push              Do not push the git tag
  --yes                  Skip the confirmation prompt
  -h, --help             display help for command

The workflow:
  configure → authenticate → validate → checks → version → tag
            → publish each provider → verify → report

A failing mandatory step halts the run. Nothing is published after a failed
check, and a dry run touches nothing at all.

Examples:
  $ forge release --dry-run
  $ forge release --patch
  $ forge release --minor --prerelease
  $ forge release 1.4.0
  $ forge release --provider npm
  $ forge release --patch --report markdown
```

## forge verify

```
Usage: forge verify [options] [version]

Confirm every provider agrees on the released version

Arguments:
  version                     Version to verify; defaults to the current one

Options:
  --release-version <semver>  Version to verify, as a flag
  --provider <names...>       Check only these providers
  --config <path>             Path to forge.config.yaml
  --report <format>           Write a report: json | markdown
  -h, --help                  display help for command

Checks that each enabled provider reports the same version and that its own
release exists and is published. A mismatch means part of a release is live and
part is not.

Examples:
  $ forge verify
  $ forge verify 1.5.0
  $ forge verify --provider github npm
  $ forge verify --report json
```

## forge version

```
Usage: forge version [options] [command]

Inspect and compute project versions

Options:
  -h, --help      display help for command

Commands:
  current         Show the current version and where it came from
  next [options]  Show what the next version would be
  bump [options]  Write the next version to every configured source
  sources         List the files the version is read from
  help [command]  display help for command

Commands:
  current   Show the current version and where it came from
  next      Show what the next version would be
  bump      Write the next version to every configured source
  sources   List the files the version is read from

Examples:
  $ forge version current
  $ forge version next --patch
  $ forge version next --minor --prerelease
  $ forge version bump --patch
  $ forge version bump --patch --prerelease --yes
```

## forge version current

```
Usage: forge version current [options]

Show the current version and where it came from

Options:
  -h, --help  display help for command
```

## forge version next

```
Usage: forge version next [options]

Show what the next version would be

Options:
  --major       Increment the major version
  --minor       Increment the minor version
  --patch       Increment the patch version (default)
  --prerelease  Add or advance a prerelease tag
  -h, --help    display help for command
```

## forge version bump

```
Usage: forge version bump [options]

Write the next version to every configured source

Options:
  --major          Increment the major version
  --minor          Increment the minor version
  --patch          Increment the patch version (default)
  --prerelease     Add or advance a prerelease tag
  --set <version>  Write an exact version instead of computing one
  --yes            Skip the confirmation prompt
  -h, --help       display help for command
```

## forge version sources

```
Usage: forge version sources [options]

List the files the version is read from

Options:
  -h, --help  display help for command
```

## forge check

```
Usage: forge check [options] [names...]

Run the configured checks

Arguments:
  names              Checks to run; omit to run all of them

Options:
  --only <names...>  Checks to run
  --verbose-output   Print each check's stdout and stderr
  --quiet            Print only the summary line
  -h, --help         display help for command

Checks come from forge.config.yaml. Each runs as an argument array with no
shell, so a value containing shell metacharacters is data, never syntax.

Examples:
  $ forge check                 # every configured check
  $ forge check test lint       # just these two
  $ forge check --only build    # the same, as a flag
  $ forge check --verbose-output
  $ forge check --quiet         # CI: summary line only, exit code is the signal
```

## forge test

```
Usage: forge test [options]

Run the test check

Options:
  --verbose-output  Print each check's stdout and stderr
  -h, --help        display help for command

A shortcut for the "test" check in forge.config.yaml — the same engine, the same
exit code. Add --verbose-output to see what the test runner printed.

Examples:
  $ forge test
  $ forge test --verbose-output
```

## forge build

```
Usage: forge build [options]

Run the build check

Options:
  --verbose-output  Print each check's stdout and stderr
  -h, --help        display help for command

A shortcut for the "build" check in forge.config.yaml. Forge never builds for
you — this runs the command you configured and reports whether it succeeded.

Examples:
  $ forge build
  $ forge build --verbose-output
```
