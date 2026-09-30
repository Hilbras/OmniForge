## Summary

<!-- What this changes, and why. Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] New provider
- [ ] Documentation
- [ ] Refactor or internal cleanup

## Forge rule check

If you touched `src/core`, `src/release`, `src/cli`, `src/version`,
`src/verification`, or `src/reporting`:

- [ ] No imports from `src/providers/`
- [ ] No comparison against a platform name
- [ ] No instantiation of a concrete provider

`npm test` asserts all three. If it fails, the design needs to change, not the test.

## Verification

<!-- Paste the command output, not a description of it. -->

```
$ npm run lint
$ npm run typecheck
$ npm test
```

- [ ] `npm run lint` passes
- [ ] `npm run format:check` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

## Credentials

- [ ] No token, secret, or credential appears in this diff
- [ ] New fixtures use fake values only
- [ ] No log, report, or error output includes secret material

## Changelog

- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
