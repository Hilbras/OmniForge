/**
 * Authentication.
 *
 * Credentials resolve from the environment at the moment a provider needs them,
 * never earlier. Nothing here returns a secret in a structure that could be
 * logged: `ResolvedCredential` carries a boolean and a non-secret identity, so
 * a caller can report "authenticated as lacrous" without holding the token.
 */

import { execFileSync } from 'node:child_process';

import { AuthError, ErrorCode } from '../errors/index.js';
import type { ProviderName } from '../configuration/schema.js';

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

/** The signed-in GitHub account, for display. Returns undefined when unknown. */
export function ghIdentity(): string | undefined {
  try {
    return execFileSync('gh', ['api', 'user', '--jq', '.login'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
  } catch {
    // gh absent, not signed in, or offline. Identity is decorative.
    return undefined;
  }
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
    const token = execFileSync('gh', ['auth', 'token'], {
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
