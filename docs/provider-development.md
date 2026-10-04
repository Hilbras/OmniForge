# Writing a provider

Adding a platform means adding one directory and one line. Nothing in the Core,
the release pipeline, or the CLI changes — and a test enforces that.

## The contract

```ts
export interface Provider {
  readonly name: string;
  capabilities(): ProviderCapabilities;
  authenticate(context: ProviderContext): Promise<AuthResult>;
  validate(context: ProviderContext): Promise<void>;
  getVersion(context: ProviderContext): Promise<ObservedVersion>;
  publish(context: ProviderContext, input: PublishInput): Promise<PublishResult>;
  verify(context: ProviderContext, version: string): Promise<VerificationResult>;
}
```

Six methods, and the Core never asks which one it is talking to. It calls
`capabilities()` and then the matching method, so adding a registry means
implementing this interface and registering a factory.

## Step 1 — create the directory

```text
src/providers/docker/
├── index.ts      # the Provider implementation
├── client.ts     # the API or CLI wrapper
└── notes.ts      # optional: release-note extraction
```

## Step 2 — implement the provider

```ts
import { Capability, type Provider, type ProviderContext } from '../../core/provider.js';
import { AuthError, ErrorCode } from '../../errors/index.js';
import { pushImage } from './client.js';

export class DockerProvider implements Provider {
  readonly name = 'docker';

  capabilities() {
    return {
      name: 'docker',
      description: 'Docker Hub images',
      // Only claim what you implement. The pipeline asks for capabilities rather
      // than assuming, so an over-claim shows up as a broken release, not a
      // compile error.
      capabilities: [Capability.Publish, Capability.Verify],
      versionSources: ['image tags'],
    };
  }

  async authenticate(context: ProviderContext) {
    const token = context.getSecret('docker');
    if (token === undefined) {
      throw new AuthError(ErrorCode.AUTH_FAILED, 'No Docker Hub credential.', {
        provider: 'docker',
        // Never say "run forge release with a token" — say which variable, so
        // nobody pastes a token into a config file or a CI log.
        remediation: 'Set DOCKER_TOKEN in the environment.',
      });
    }
    return { authenticated: true, identity: 'docker-hub' };
  }

  async validate(context: ProviderContext): Promise<void> {
    // Config is already validated; this is for things only the remote knows.
  }

  async getVersion(context: ProviderContext) {
    const image = await resolveImage(context);
    return { provider: 'docker', version: image.tag, reference: image.url };
  }

  async publish(context: ProviderContext, input: PublishInput) {
    if (context.dryRun) {
      // A real rehearsal, not a no-op. `npm publish --dry-run` genuinely packs
      // and validates the tarball, and a dry run that does nothing is a dry run
      // that cannot catch anything.
      await pushImage(context, { dryRun: true });
      return { published: false, reference: '', version: input.version };
    }
    const pushed = await pushImage(context, { dryRun: false });
    return { published: true, reference: pushed.url, version: input.version };
  }

  async verify(context: ProviderContext, version: string): Promise<VerificationResult> {
    const image = await resolveImage(context, version);
    const exists = image !== null;

    return {
      provider: 'docker',
      verified: exists,
      observed: {
        provider: 'docker',
        version: exists ? version : null,
        reference: image?.url ?? '',
      },
      checks: [
        {
          name: 'image-exists',
          passed: exists,
          detail: exists ? image.url : `${version} not found`,
        },
        // The expected-tag rule: only enforce it for the version currently being
        // released. `latest` moves on, and enforcing it historically makes every
        // old release look broken.
        { name: 'digest-recorded', passed: exists, detail: image?.digest ?? 'no digest' },
      ],
    };
  }
}
```

## Step 3 — register it

`src/core/default-registry.ts` is the **only** file that may import a concrete
provider:

```ts
const dockerFactory: ProviderFactory = () => new DockerProvider();

return new ProviderRegistry().register('docker', dockerFactory, {
  description: 'Docker Hub images',
  capabilities: ['publish', 'verify'],
  versionSources: ['image tags'],
});
```

That is the entire integration. The architecture test fails the build if any other
file imports a provider implementation.

## Step 4 — allow the name in config

```ts
// src/configuration/schema.ts
export type ProviderName = 'github' | 'npm' | 'pypi' | 'docker';
```

## Rules the architecture test enforces

Inside `src/core`, `src/release`, `src/cli`, `src/version`, `src/verification`, and
`src/reporting`:

- **No concrete provider imports.** Resolve by name through the registry.
- **No platform names in conditionals.** `if (provider === 'docker')` fails the
  build. Put the difference in a data table instead.

This caught a real violation during development: `forge init` branched on the
strings `'npm'` and `'python'`, which would have meant editing that file's
conditionals for every new ecosystem. It is now a row in a table, which is what
made adding an ecosystem a one-line change.

## Rules you have to honour yourself

### Never branch on the platform name in orchestration

```ts
// Wrong — the exact anti-pattern §4.1 forbids.
if (name === 'docker') {
  await pushImage();
}

// Right — ask what the provider can do.
if (registry.capabilitiesOf(name).capabilities.includes(Capability.Publish)) {
  await provider.publish(context, input);
}
```

### Pass the credential through the environment, never as an argument

```ts
// Wrong: visible in `ps` to every user on the machine.
await run('docker', ['login', '--password', token]);

// Right.
await run('docker', ['login'], { env: { DOCKER_TOKEN: token } });
```

### Distinguish "absent" from "could not read"

```ts
// Wrong: every failure looks like a missing image.
return result.exitCode === 0;

// Right: only a 404 means absent.
if (result.exitCode === 0) return true;
if (status === 404) return false;
throw new AuthError(ErrorCode.AUTH_FAILED, 'The token was rejected.');
```

This is not hypothetical. `tagExistsRemote` returned `false` for any non-zero
exit, so an expired GitHub token made `forge verify` report a healthy release as
missing and advise re-publishing it. The advice sent the user to publish again on
top of a working setup.

### A dry run must actually rehearse

`context.dryRun` means "do not change the outside world", not "do nothing".
`forge npm publish --dry-run` really packs and validates the tarball.

### Never log a secret

Do not include one in a message, a detail object, or an error. Forge redacts
every output sink against a registry of resolved credentials, but a secret you
construct from parts never gets registered.

## Testing

Providers take everything they need from `ProviderContext`, so they test without
a network or a repository:

```ts
const ctx = {
  projectRoot: '/tmp/project',
  config: { docker: { package: 'acme/api' } },
  getSecret: (name) => (name === 'docker' ? 'test-token' : undefined),
  execute: {
    // Stub `run`, not the process. A real executor in a unit test proves nothing
    // and is the reason the CLI's own coverage looked near-zero for years.
    run: () => Promise.resolve({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }),
  },
  dryRun: false,
} as unknown as ProviderContext;
```

Cover at minimum:

| Case              | Why                              |
| ----------------- | -------------------------------- |
| Happy path        | It works                         |
| 401 / 403         | Not read as "absent"             |
| 404               | Read as absent, not as an error  |
| Network failure   | Not read as "absent"             |
| Already published | Refuses rather than overwriting  |
| `dryRun: true`    | Changes nothing, still validates |

The GitHub provider's tests run against a **real** git repository in a temp
directory, because a stub only proves the code calls what the stub expects.

## Checklist

- [ ] `capabilities()` claims only what is implemented
- [ ] Errors carry a `remediation` that names an environment variable, never a secret
- [ ] 404 means absent; every other status raises
- [ ] Credentials travel through the environment, not argv
- [ ] `dryRun` rehearses rather than short-circuits
- [ ] Duplicates are refused
- [ ] Registered in `default-registry.ts`, and nowhere else
- [ ] Added to `ProviderName`
- [ ] `npm run lint && npm test` passes, including the architecture test
