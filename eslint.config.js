// Minimal ESLint flat config for ashlr-hub.
// Lints TypeScript sources under src/ and test/. The Raycast subpackage
// owns its own lint config and is excluded here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores must be in their own config object with no other keys.
  {
    ignores: ['dist/**', 'node_modules/**', 'src/raycast/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      // TypeScript's own checker handles unused vars (noUnusedLocals); keep the
      // lint rule as a warning that mirrors the `_`-prefix escape hatch.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain-JS Node test fixtures (e.g. the stdio mock MCP server) run under
    // Node directly and legitimately use Node globals like `process`.
    files: ['test/**/*.mjs', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
