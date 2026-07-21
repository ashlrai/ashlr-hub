import { vi } from 'vitest';
import { defineConfig } from 'vitest/config';

const spyOnCompatKey = '__ASHLR_VITEST_3_SPY_ON_COMPAT__';
const testGlobal = globalThis as typeof globalThis & { [spyOnCompatKey]?: boolean };
const configuredTestTimeoutMs = Number(process.env['ASHLR_VITEST_TEST_TIMEOUT_MS']);
const testTimeoutMs = Number.isFinite(configuredTestTimeoutMs) &&
  configuredTestTimeoutMs >= 1_000 && configuredTestTimeoutMs <= 60_000
  ? Math.floor(configuredTestTimeoutMs)
  : 5_000;

// Preserve the Vitest 3 mock isolation semantics expected by the existing suite.
if (process.env['VITEST_WORKER_ID'] && !testGlobal[spyOnCompatKey]) {
  const spyOn = vi.spyOn.bind(vi) as (...args: unknown[]) => unknown;
  const doUnmock = vi.doUnmock.bind(vi);
  vi.spyOn = ((...args: unknown[]) => {
    const [target, property, accessType] = args as [object, PropertyKey, 'get' | 'set' | undefined];
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    const current = accessType
      ? descriptor?.[accessType]
      : Reflect.get(target, property);

    if (vi.isMockFunction(current)) current.mockClear();
    return spyOn(...args);
  }) as typeof vi.spyOn;
  vi.doUnmock = ((path: string) => {
    const result = doUnmock(path);
    vi.resetModules();
    return result;
  }) as typeof vi.doUnmock;
  testGlobal[spyOnCompatKey] = true;
}

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
    // to the developer's REAL ~/.ashlr on Windows — and the H1 fixture's
    // relocation guard throws, aborting the test. See test/setup/home.ts.
    setupFiles: ['./vitest.config.ts', './test/setup/home.ts'],
    clearMocks: true,
    // Cap worker forks. Many H-suite tests spawn real git/child processes, so at
    // the default (~one fork per core) the machine oversubscribes and heavy
    // git-bound tests flake with timeouts — non-deterministically, and only
    // under load (each passes in isolation; the suite passes serially). A small
    // fixed cap keeps meaningful parallelism without the oversubscription.
    pool: 'forks',
    maxWorkers: 4,
    // Windows hosted runners execute the same hermetic durability fixtures
    // several times slower than local/POSIX hosts. CI injects a bounded
    // platform-specific default; explicit fixture deadlines still win.
    testTimeout: testTimeoutMs,
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
