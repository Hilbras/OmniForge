/**
 * Authentication.
 *
 * Credentials resolve from the environment at the moment a provider needs them,
 * never earlier. Nothing here returns a secret in a structure that could be
 * logged: `ResolvedCredential` carries a boolean and a non-secret identity, so
 * a caller can report "authenticated as lacrous" without holding the token.
 */

import { execFileSync } from 'node:child_process';
import { buildInvocation, resolveProgram } from '../build/exec.js';

import { AuthError, ErrorCode } from '../errors/index.js';
import type { ProviderName } from '../configuration/schema.js';

/**
 * Resolve a command and its arguments into a spawnable program/argv pair.
 *
 * `gh` is `gh.exe` on Windows and spawns directly, but on some installations it
 * is a `.cmd` shim, which Windows cannot spawn without cmd.exe. Going through the
 * shared builder means that rule lives in one place rather than being re-decided
 * at every call site.
 */
function invocationFor(command: string, args: readonly string[] = []): [string, string[]] {
  const { program, args: resolved } = buildInvocation(resolveProgram(command), args);

  return [program, resolved];
}

/** Where a credential came from, so an auth failure can explain itself. */
export type CredentialSource = 'environment' | 'tool' | 'absent';

/** A resolved credential. Contains no secret material by construction. */
export interface ResolvedCredential {
  readonly present: boolean;
  readonly source: CredentialSource;
  /** Non-secret identity, e.g. `lacrous`. Safe to display and log. */
  readonly identity?: string;
  /** Which env var it came from. The name is not secret; the value is. */
  readonly envVar?: string;
}

/**
 * Resolve a credential from the environment.
 *
 * An unset variable and an empty one are the same thing: treat empty as absent,
 * since an empty token produces a confusing 401 rather than a clear message.
 */
export function resolveFromEnv(env: NodeJS.ProcessEnv, envVar: string): ResolvedCredential {
  const value = env[envVar];
  if (value === undefined || value.length === 0) {
    return { present: false, source: 'absent', envVar };
  }
  return { present: true, source: 'environment', envVar };
}

/**
 * The signed-in GitHub account, for display. Returns undefined when unknown.
 *
 * Memoised for the process. `resolveGitHub` calls this to label a credential,
 * and `config credentials` asks about every provider, so without this the same
 * `gh api user` call is made two or three times per command — which is why that
 * command was timing out under parallel test load rather than failing.
 */
let cachedIdentity: string | undefined;
let identityResolved = false;

export function ghIdentity(): string | undefined {
  if (identityResolved) return cachedIdentity;

  identityResolved = true;
  try {
    const [program, args] = invocationFor('gh', ['api', 'user', '--jq', '.login']);
    cachedIdentity = execFileSync(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    // gh absent, not signed in, or offline. Identity is decorative.
    cachedIdentity = undefined;
  }

  return cachedIdentity;
}

/**
 * Resolve a GitHub token, falling back to the `gh` CLI.
 *
 * `gh auth token` is a legitimate second source: developers already signed in
 * through `gh` should not have to duplicate that as an env var. The token is
 * read and discarded here — only its presence and the account name escape.
 */
export function resolveGitHub(env: NodeJS.ProcessEnv): ResolvedCredential {
  const fromEnv = resolveFromEnv(env, 'GITHUB_TOKEN');
  if (fromEnv.present) return fromEnv;

  try {
    const [program, args] = invocationFor('gh', ['auth', 'token']);
    const token = execFileSync(program, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();

    if (token.length > 0) {
      return {
        present: true,
        source: 'tool',
        identity: ghIdentity(),
        envVar: 'gh auth token',
      };
    }
  } catch {
    // Not installed, not signed in, or timed out. Fall through to absent.
  }

  return { present: false, source: 'absent', envVar: 'GITHUB_TOKEN' };
}

/**
 * Resolve whichever credential a provider needs.
 *
 * Dispatching here rather than inside each provider keeps the env var names in
 * one place and lets a provider ask for "my credential" without knowing the
 * convention.
 */
export function resolveCredential(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): ResolvedCredential {
  switch (provider) {
    case 'github':
      return resolveGitHub(env);
    case 'npm':
      return resolveFromEnv(env, 'NPM_TOKEN');
    case 'pypi':
      return resolveFromEnv(env, 'PYPI_TOKEN');
  }
}

/**
 * Throw a uniform auth error when a credential is missing.
 *
 * Names the variable so the user can tell "not set" from "set to the wrong
 * thing", without echoing anything sensitive.
 */
export function requireCredential(
  provider: ProviderName,
  credential: ResolvedCredential,
): asserts credential is ResolvedCredential & { present: true } {
  if (credential.present) return;

  const hint =
    provider === 'github'
      ? 'Run `gh auth login`, or export GITHUB_TOKEN.'
      : `Export ${credential.envVar ?? `${provider.toUpperCase()}_TOKEN`} in your shell.`;

  throw new AuthError(ErrorCode.AUTH_MISSING_CREDENTIALS, `No ${provider} credentials found.`, {
    provider,
    remediation: hint,
    detail: { searchedEnv: credential.envVar ?? null, source: credential.source },
  });
}
