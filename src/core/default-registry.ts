/**
 * The default provider registry — the single composition root.
 *
 * Every provider Forge ships is registered here. This is the *only* place that
 * imports a concrete provider: Core resolves providers by name through the
 * registry, so adding one means editing this file and nothing else.
 *
 * `tests/unit/architecture.test.ts` enforces that rule.
 */

import { ProviderRegistry, type ProviderFactory } from './registry.js';
import { GitHubProvider } from '../providers/github/index.js';

/** Factory for the GitHub provider. */
const githubFactory: ProviderFactory = () => new GitHubProvider();

/**
 * Build the registry Forge ships with.
 *
 * npm (Phase 6) and PyPI (Phase 7) register here next. Until then `provider
 * list` shows only `github`, which is honest about what exists.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry().register('github', githubFactory, {
    description: 'GitHub repositories: tags, releases, and release assets',
    capabilities: ['repository', 'tags', 'releases', 'assets', 'verify'],
    versionSources: ['git tags', 'GitHub releases'],
  });
}
