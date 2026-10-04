/**
 * `forge config` — show, validate, and locate the project configuration.
 *
 * Rendered through the shared console so it matches the rest of the CLI.
 * `config show` prints resolved values but never credential material: the token
 * env var *name* is shown because a name is not secret, and no value ever is.
 *
 * Failures are reported by throwing a `ConfigError`, not by setting
 * `process.exitCode` from inside an action. A command that mutates the global
 * exit code gets silently overwritten when `main()` returns its own value, so
 * the failure would vanish. Throwing routes it through the CLI's single error
 * path, which owns the exit code and the error format.
 */

import type { Command } from 'commander';

import { globalSecrets } from '../../utils/secrets.js';
import { createConsole, type Console, type Palette } from '../../ui/theme.js';
import {
  discoverConfig,
  formatIssues,
  loadConfigFile,
  validateRaw,
} from '../../configuration/loader.js';
import { resolveConfig, type Overrides } from '../../configuration/resolve.js';
import { writeStarterConfig } from './init.js';
import { resolveCredential } from '../../authentication/index.js';
import { PROVIDER_NAMES, type ForgeConfig, type ProviderName } from '../../configuration/schema.js';
import { ConfigError, ErrorCode, toForgeError } from '../../errors/index.js';

export interface ConfigCommandDeps {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Palette to render with. Required — without it every command would silently
   * fall back to the colourless palette and `FORCE_COLOR` would do nothing.
   */
  readonly palette: Palette;
}

/** Attach the `config` command group to the program. */
export function registerConfigCommand(program: Command, deps: ConfigCommandDeps): void {
  const out = (): Console =>
    createConsole({
      write: deps.write,
      writeError: deps.writeError,
      palette: deps.palette,
      redact: (text) => globalSecrets.redact(text),
    });

  const config = program
    .command('config')
    .description('Inspect and validate the project configuration')
    .addHelpText(
      'after',
      `
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
`,
    );

  config
    .command('show')
    .description('Print the resolved configuration')
    .option('--config <path>', 'Use a specific config file instead of discovery')
    .option('--registry <url>', 'Override the npm registry')
    .option('--dist-tag <tag>', 'Override the npm dist-tag')
    .option('--repository <owner/name>', 'Override the GitHub repository')
    .action((flags: Record<string, string>) => {
      const resolved = resolveConfig({
        configPath: flags['config'],
        overrides: overridesFrom(flags),
      });
      renderConfig(out(), resolved);
    });

  config
    .command('validate')
    .description('Validate the configuration file')
    .option('--config <path>', 'Use a specific config file instead of discovery')
    .action((flags: Record<string, string>) => {
      const c = out();
      const explicit = flags['config'];
      const discovery =
        explicit === undefined ? discoverConfig() : { path: explicit, projectRoot: process.cwd() };

      if (discovery.path === null) {
        throw new ConfigError(ErrorCode.CONFIG_NOT_FOUND, 'No forge.config.yaml found.', {
          remediation: 'Run `forge config init` to create one, or run forge from inside a project.',
        });
      }

      try {
        const { raw } = loadConfigFile(discovery.path);
        const result = validateRaw(raw);
        if (result.valid) {
          c.success(`${discovery.path} is valid.`);
          return;
        }
        // Thrown rather than printed-and-returned: the CLI's error path owns the
        // exit code, so CI can gate on this command.
        throw new ConfigError(
          ErrorCode.CONFIG_INVALID,
          formatIssues(discovery.path, result.issues),
          {
            remediation: 'Fix the fields above, then run `forge config validate`.',
            detail: { issues: result.issues },
          },
        );
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        const forgeError = toForgeError(error);
        throw new ConfigError(ErrorCode.CONFIG_INVALID, forgeError.message, {
          remediation: forgeError.remediation,
        });
      }
    });

  config
    .command('path')
    .description('Print the discovered config path and project root')
    .action(() => {
      const c = out();
      const discovery = discoverConfig();
      c.line(discovery.path ?? '(none found)');
      c.line(discovery.projectRoot);
    });

  config
    .command('credentials')
    .description('Report which credentials are available, without revealing them')
    .action(() => {
      const c = out();
      c.heading('Credentials');
      for (const provider of PROVIDER_NAMES) {
        const credential = resolveCredential(provider, deps.env);
        if (credential.present) {
          const identity = credential.identity === undefined ? '' : ` as ${credential.identity}`;
          c.success(
            `${provider} — available via ${credential.envVar ?? credential.source}${identity}`,
          );
        } else {
          c.info(`${provider} — not set (${credential.envVar})`);
        }
      }
      c.blank();
      c.detail('Values are never printed. Only presence and the variable name.');
    });

  config
    .command('init')
    .description('Write a starter forge.config.yaml')
    .option('--force', 'Overwrite an existing config')
    .addHelpText(
      'after',
      `
An alias for the top-level \`forge init\`, which is where the detection logic
lives. Both behave identically.

Examples:
  $ forge config init
  $ forge config init --force
`,
    )
    .action((flags: Record<string, boolean>) => {
      // Shares one implementation rather than duplicating it: two `init`s would
      // drift, and this is the name people find first.
      writeStarterConfig(out(), flags['force'] === true);
    });
}

/** Build an `Overrides` from commander flags, omitting absent ones. */
function overridesFrom(flags: Record<string, string>): Overrides {
  const overrides: { registry?: string; distTag?: string; repository?: string } = {};
  if (flags['registry'] !== undefined) overrides.registry = flags['registry'];
  if (flags['distTag'] !== undefined) overrides.distTag = flags['distTag'];
  if (flags['repository'] !== undefined) overrides.repository = flags['repository'];
  return overrides;
}

/**
 * Per-provider view data for rendering.
 *
 * Deliberately data-driven: the renderer iterates this and never asks which
 * provider it is looking at. The architecture test enforces that rule, so a
 * `provider === 'npm'` branch here would fail the build.
 */
interface ProviderView {
  readonly enabled: boolean;
  readonly target: string | null;
  readonly tokenEnv: string;
  /** Extra key/value lines specific to this provider. */
  readonly extras: readonly (readonly [string, string])[];
}

/** Build the per-provider view from a resolved config. */
function providerViews(config: ForgeConfig): Record<ProviderName, ProviderView> {
  return {
    github: {
      enabled: config.github.enabled,
      target: config.github.repository,
      tokenEnv: config.github.tokenEnv,
      extras: [],
    },
    npm: {
      enabled: config.npm.enabled,
      target: config.npm.package,
      tokenEnv: config.npm.tokenEnv,
      extras: [
        ['registry', config.npm.registry],
        ['distTag', config.npm.distTag],
      ],
    },
    pypi: {
      enabled: config.pypi.enabled,
      target: config.pypi.package ?? config.pypi.repository,
      tokenEnv: config.pypi.tokenEnv,
      extras: [],
    },
  };
}

/** Print a resolved config in a readable, secret-free shape. */
function renderConfig(c: Console, config: ForgeConfig): void {
  c.heading(`Project: ${config.project.name}`);
  c.detail(config.sourcePath ?? '(defaults — no config file found)');
  c.detail(`root ${config.projectRoot}`);

  c.heading('Version');
  c.line(`strategy   ${config.version.strategy}`);
  c.line(`tagPrefix  ${config.version.tagPrefix}`);
  c.line(`file       ${config.version.file ?? '(detected at release time)'}`);

  c.heading('Providers');
  const views = providerViews(config);
  for (const provider of PROVIDER_NAMES) {
    const view = views[provider];
    c.line(
      `${view.enabled ? 'on ' : 'off'}  ${provider.padEnd(8)} ${view.target ?? '(not configured)'}`,
    );
    c.detail(`token from ${view.tokenEnv}`);
    for (const [label, value] of view.extras) {
      c.detail(`${label.padEnd(9)} ${value}`);
    }
  }

  c.heading('Order');
  c.line(config.order.join(' → '));

  c.heading('Checks');
  const names = Object.keys(config.checks);
  if (names.length === 0) {
    c.info('(none configured)');
  } else {
    for (const name of names) {
      const check = config.checks[name];
      if (check === undefined) continue;
      c.line(`${name.padEnd(10)} ${check.command.join(' ')}`);
      c.detail(check.optional ? 'optional — failure will not halt' : 'mandatory');
    }
  }

  c.blank();
  c.rule();
  c.detail('Credentials are read from the environment and never stored in config.');
}
