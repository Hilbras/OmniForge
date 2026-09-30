/**
 * Provider implementations.
 *
 * Concrete providers live in per-platform subdirectories and are registered in
 * the composition root (`src/core/registry.ts`). Nothing in Core imports from
 * here directly — the architecture test enforces that.
 *
 * V1 providers (GitHub, npm, PyPI) arrive in Phases 3, 6, and 7.
 */

export { Capability } from '../core/provider.js';
export type { Provider, ProviderCapabilities, ProviderContext } from '../core/provider.js';
export { ProviderRegistry, createDefaultRegistry, type ProviderFactory } from '../core/registry.js';
