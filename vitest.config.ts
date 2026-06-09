import { defineConfig } from 'vitest/config';

/**
 * Scope the test run to the hub's OWN tests under `test/`.
 *
 * Without an explicit `include`, vitest's default glob collects
 * any test file anywhere in the tree — including a stray `ashlr new` scaffold
 * left at the repo root (e.g. `myapp/src/index.test.ts`). That would contaminate
 * the hub suite and could break the build if a template's deps are missing.
 *
 * Pinning `include` to `test/**` and excluding scaffold/build/node_modules dirs
 * guarantees stray scaffolds can never be picked up by `vitest run`.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Defense-in-depth: never collect tests from scaffolded output dirs that
      // may be created during manual verification at the repo root.
      'myapp/**',
      '**/.ashlrcode/**',
    ],
  },
});
