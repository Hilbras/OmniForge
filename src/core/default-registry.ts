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
import { NpmProvider } from '../providers/npm/index.js';

/** Factory for the GitHub provider. */
const githubFactory: ProviderFactory = () => new GitHubProvider();

/** Factory for the npm provider. */
const npmFactory: ProviderFactory = () => new NpmProvider();

/**
 * Build the registry Forge ships with.
 *
 * PyPI (Phase 7) registers here next. Until then `provider list` shows `github`
 * and `npm`, which is honest about what exists.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return new ProviderRegistry()
    .register('github', githubFactory, {
      description: 'GitHub repositories: tags, releases, and release assets',
      capabilities: ['repository', 'tags', 'releases', 'assets', 'verify'],
      versionSources: ['git tags', 'GitHub releases'],
    })
    .register('npm', npmFactory, {
      description: 'npm packages: publish, dist-tags, and registry verification',
      capabilities: ['package', 'publish', 'dist-tags', 'verify'],
      versionSources: ['package.json', 'npm registry'],
    });
}
