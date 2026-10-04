import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests spawn the built CLI and, for GitHub commands, shell out
    // to `gh`. Under parallel load those calls regularly exceed vitest's 5s
    // default, which surfaced as failures with no failing assertion at all.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/**/index.ts'],
      thresholds: {
        // Thresholds on the whole of `src` are meaningless: the CLI is exercised
        // by spawning the built binary, which v8 coverage cannot observe, so
        // `src/cli/**` reports near-zero while being well covered in reality.
        // Those files are held to their integration tests instead, which assert
        // observable behaviour rather than line execution.
        //
        // What is thresholded here is everything the unit suite genuinely covers:
        // the decision-making core, where a dropped branch means a release
        // silently does the wrong thing.
        'src/core/**': { statements: 90, branches: 85, functions: 80, lines: 90 },
        'src/version/**': { statements: 80, branches: 75, functions: 80, lines: 80 },
        'src/build/**': { statements: 85, branches: 75, functions: 80, lines: 85 },
        'src/configuration/**': { statements: 85, branches: 80, functions: 90, lines: 85 },
        'src/release/**': { statements: 90, branches: 75, functions: 90, lines: 90 },
        'src/verification/**': { statements: 90, branches: 85, functions: 85, lines: 90 },
        'src/providers/**': { statements: 60, branches: 50, functions: 65, lines: 60 },
        'src/errors/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
        'src/utils/**': { statements: 85, branches: 85, functions: 85, lines: 85 },
      },
    },
  },
});
