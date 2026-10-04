/**
 * Provider context construction.
 *
 * Shared by every provider command. Extracted because four command modules each
 * had their own copy, and a fix to one — say, adding the hardened executor rather
 * than a stub — would silently not apply to the others. That already happened
 * once: `forge github status` used a placeholder executor that shadowed the real
 * `gh` runner, and authentication worked in tests and failed in production.
 */

import { execute } from '../../build/exec.js';
import type { ProviderContext } from '../../core/provider.js';
import type { ForgeConfig } from '../../configuration/schema.js';

/**
 * Build a context with the real, hardened executor.
 *
 * Never a no-op executor: the shell-free executor is part of what makes a provider
 * safe, and swapping it out for a stub makes the CLI look like it works while
 * testing nothing. That happened once — a placeholder executor shadowed the real
 * `gh` runner, so authentication passed in tests and failed in production.
 *
 * `dryRun` is passed through rather than hard-coded false, because a provider
 * reads it to decide whether to rehearse or act, and a context that always said
 * false would make every dry run behave like a real release.
 */
export function contextFor(
  config: ForgeConfig,
  env: NodeJS.ProcessEnv,
  dryRun = false,
): ProviderContext {
  return {
    projectRoot: config.projectRoot,
    config: config as unknown as Record<string, unknown>,
    getSecret: (provider) => secretFor(config, provider, env),
    execute: {
      run: (command, args, options) => execute(command, args, options ?? {}),
    },
    dryRun,
  };
}

/**
 * Resolve a provider's credential from the environment.
 *
 * The variable name comes from configuration where the provider allows one, so a
 * project can rename `PYPI_TOKEN` without patching Forge. The provider name is
 * validated before being used to build a variable name, because an unchecked
 * name could otherwise read an arbitrary environment variable.
 */
function secretFor(
  config: ForgeConfig,
  provider: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!/^[a-z][a-z0-9]*$/.test(provider)) return undefined;

  // A provider with its own configured variable wins, so `pypi.tokenEnv` is
  // honoured rather than only the conventional `PYPI_TOKEN`.
  const read = CONFIGURED_TOKEN_ENV[provider];
  const variable = read?.(config) ?? `${provider.toUpperCase()}_TOKEN`;

  const value = env[variable];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The credential variable for a provider, where it declares one.
 *
 * A table, not a switch. A `provider === 'pypi'` conditional here would be the
 * platform branching the architecture test forbids: adding a provider with a
 * configurable credential would mean editing this function rather than adding a
 * row. A provider absent from the table uses the conventional
 * `<PROVIDER>_TOKEN`.
 */
const CONFIGURED_TOKEN_ENV: Record<string, (config: ForgeConfig) => string | undefined> = {
  pypi: (config) => config.pypi.tokenEnv,
  npm: (config) => config.npm.tokenEnv,
};
