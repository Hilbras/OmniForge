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
      'no-console': 'off',
    },
  },
  {
    // The CLI is the one place console output is the product.
    files: ['src/cli/**/*.ts', 'src/reporting/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
