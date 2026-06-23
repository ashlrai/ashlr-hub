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
    // Make os.homedir() follow process.env.HOME on every platform (Windows
    // ignores $HOME natively). Without this, every HOME-isolated test resolves
    // to the developer's REAL ~/.ashlr on Windows. See test/setup/home.ts.
    setupFiles: ['./test/setup/home.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      // Defense-in-depth: never collect tests from scaffolded output dirs that
      // may be created during manual verification at the repo root.
      'myapp/**',
      '**/.ashlrcode/**',
    ],
    // Coverage runs only with `--coverage` (i.e. `npm run coverage`), so the
    // default `npm test` stays fast. Reported in CI but NOT yet gating: the
    // erosion floor must be calibrated from the first GREEN run on the Linux CI
    // (the suite cannot pass on Windows — symlink/path/TZ-dependent tests), so a
    // threshold set from anywhere else risks a false CI failure. To enable the
    // gate: read `coverage/coverage-summary.json` from a green CI run, then add
    // a `thresholds` block here a few points below the reported numbers.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/core/**/*.ts', 'src/cli/**/*.ts'],
      exclude: [
        'src/raycast/**',
        'src/**/web/static/**',
        'src/**/*.d.ts',
        '**/types.ts',
      ],
    },
  },
});
