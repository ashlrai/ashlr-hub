// Minimal ESLint flat config for ashlr-hub.
// Lints TypeScript sources under src/ and test/. The Raycast subpackage
// owns its own lint config and is excluded here.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  // Global ignores must be in their own config object with no other keys.
  {
    ignores: [
      '.ashlr/**',
      '.m262-wip/**',
      'desktop/src-tauri/gen/**',
      'desktop/src-tauri/target/**',
      'dist/**',
      'dist-bin/**',
      'node_modules/**',
      'src/raycast/**',
      'undefined/**',
    ],
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
    // Test files legitimately use `any` to build partial mocks and stub shapes
    // that would be noise to fully type. Keep the rule on as a warning (so it's
    // still visible) rather than a hard error that blocks the suite from
    // linting. Source under src/ stays strict.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests legitimately use sync require() for dynamic module loading and
      // empty blocks/patterns to stub callbacks and ignore args.
      '@typescript-eslint/no-require-imports': 'off',
      'no-empty': 'off',
      'no-empty-pattern': 'off',
    },
  },
  {
    // Desktop build scripts (e.g. prepare-sidecar.mjs) run under Node and use
    // Node globals, same as the top-level scripts/ block.
    files: ['desktop/scripts/**/*.mjs', 'desktop/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
      },
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
  {
    // Node build scripts (e.g. scripts/copy-assets.mjs) run under Node and use
    // Node globals.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
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
  {
    // src/web-ui/** — the React operator console. Browser code (not Node),
    // TSX, and it owns its own hooks-correctness lint (the rest of the repo
    // has no React so eslint-plugin-react-hooks isn't registered globally).
    // See src/web-ui/tsconfig.json for the matching TS-side isolation.
    files: ['src/web-ui/**/*.ts', 'src/web-ui/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        RequestInit: 'readonly',
        RequestInfo: 'readonly',
        EventSource: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        crypto: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Element: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLDetailsElement: 'readonly',
        CSS: 'readonly',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // The M14 web dashboard SPA (src/core/web/public/*.js) is browser code
    // shipped as a static asset — it runs in the browser, not Node. Lint it
    // with browser globals. Empty catch blocks are an intentional best-effort
    // pattern in the live-update code; unused locals are surfaced as warnings.
    files: ['src/core/web/public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        console: 'readonly',
        EventSource: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        navigator: 'readonly',
        sessionStorage: 'readonly',
        localStorage: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': 'warn',
      // Plain browser JS, not TypeScript — the TS-aware unused-vars rule
      // (inherited from tseslint.configs.recommended) should not apply here.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
