// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.forge/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // eslint.config.js is plain JS and lives outside any tsconfig.
          allowDefaultProject: ['*.js', '*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['error', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Tests may use non-null assertions freely and need not exhaustively type mocks.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // Test doubles implement an async interface synchronously on purpose.
      '@typescript-eslint/require-await': 'off',
      // Tests read JSON loosely; a cast at the point of use is clearer than a
      // full type declaration for a fixture file.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'no-console': 'off',
    },
  },
  {
    // `VersionSource.write` is declared async so every implementation matches the
    // contract, but the file edits it performs are synchronous. Requiring an
    // `await` here would mean adding a fake one.
    files: ['src/version/sources.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // The same situation: the Provider contract is async, and a provider whose
    // `authenticate` or `validate` is purely local has nothing to await. A fake
    // await would be worse than an exemption.
    files: ['src/providers/pypi/index.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // The CLI is the one place console output is the product.
    files: ['src/cli/**/*.ts', 'src/reporting/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Build and maintenance scripts exist to report their result; console is how.
    files: ['scripts/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
