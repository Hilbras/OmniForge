/**
 * Configuration.
 *
 * Phase 0 reserves the boundary. Phase 1 implements `forge.config.yaml`
 * discovery, loading, validation, defaults, environment-variable resolution,
 * and CLI overrides.
 */

/** Name of the config file Forge looks for when walking up from the cwd. */
export const CONFIG_FILENAME = 'forge.config.yaml';

/** Environment variables Forge reads credentials from. */
export const CREDENTIAL_ENV_VARS = {
  github: 'GITHUB_TOKEN',
  npm: 'NPM_TOKEN',
  pypi: 'PYPI_TOKEN',
} as const;
