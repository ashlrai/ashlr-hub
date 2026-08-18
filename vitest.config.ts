import { vi } from 'vitest';
import { defineConfig } from 'vitest/config';
// Lives under test/config/, not scripts/, on purpose: M457's artifact-firewall
// guard scans every file in scripts/ and bin/ for literal test-name strings
// (to keep certain modules observation-only / unreferenceable from shipped
// tooling), and this list's own comments name several such test files.
import { REAL_IO_LANE_TIMEOUT_MS, REAL_IO_TEST_FILES } from './test/config/realio-lane-membership.mjs';

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

// Shared exclude list: stray scaffolds and build output must never be collected
// by either lane. See the `projects` comment below for why `test.include` is
// left unset at the root — Vitest 4 UNIONS a child project's `include`/
// `exclude` array with the root's own array (rather than replacing it), so a
// broad root `include` leaks into every project regardless of what the
// project itself declares. Leaving root `include` unset, and repeating this
// exclude list in each project explicitly, is what keeps the two lanes a
// clean, non-overlapping partition (verified with `vitest list`; see
// scripts/check-realio-lane-membership.mjs for the ongoing guard).
const BASE_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  // Defense-in-depth: never collect tests from scaffolded output dirs that
  // may be created during manual verification at the repo root.
  'myapp/**',
  '**/.ashlrcode/**',
];

export default defineConfig({
  test: {
    // Make os.homedir() follow process.env.HOME on every platform (Windows
    // ignores $HOME natively). Without this, every HOME-isolated test resolves
    // to the developer's REAL ~/.ashlr on Windows — and the H1 fixture's
    // relocation guard throws, aborting the test. See test/setup/home.ts.
    setupFiles: ['./vitest.config.ts', './test/setup/home.ts'],
    clearMocks: true,
    pool: 'forks',
    exclude: BASE_EXCLUDE,
    // Two lanes, both scoped to the hub's OWN tests under `test/` (never the
    // bare vitest default glob — see the BASE_EXCLUDE comment above for why a
    // stray `ashlr new` scaffold at the repo root must never be collected).
    // `npm test` runs `vitest run` with no --project filter, so both lanes
    // execute in one invocation. REAL_IO_TEST_FILES (imported above, from
    // test/config/realio-lane-membership.mjs) is the single source of truth
    // for which files belong in the serialized, generous-timeout `real-io`
    // lane versus the fast, parallel `unit` lane — see that module for the
    // full rationale and the per-file "why" on every entry.
    //
    // The two lanes deliberately run different `maxWorkers`, and Vitest's
    // scheduler requires projects with different `maxWorkers` to sit in
    // different `sequence.groupOrder` groups (it reuses a single OS process
    // pool per invocation, resized between groups — it cannot run two pool
    // sizes at once). Groups execute in ascending order, each one waiting for
    // the previous to finish, so the two lanes run SEQUENTIALLY within a
    // single `vitest run`, not concurrently — accepted here because it also
    // means the real-io lane gets the machine to itself while it runs (no
    // contention from the unit lane's 4 workers), which is exactly the
    // reliability property this split exists for. `npm run test:ci` sidesteps
    // the ordering entirely: it always passes `--no-file-parallelism`, which
    // normalizes every project's effective worker count to 1, so CI never hits
    // the differing-`maxWorkers` constraint regardless of group order.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...BASE_EXCLUDE, ...REAL_IO_TEST_FILES],
          // Cap worker forks. Many tests spawn real git/child processes, so at
          // the default (~one fork per core) the machine oversubscribes and
          // heavy git-bound tests flake with timeouts — non-deterministically,
          // and only under load. A small fixed cap keeps meaningful
          // parallelism without the oversubscription.
          maxWorkers: 4,
          // Windows hosted runners execute the same hermetic durability
          // fixtures several times slower than local/POSIX hosts. CI injects a
          // bounded platform-specific default for both test bodies and
          // fixture setup; explicit fixture deadlines still win.
          testTimeout: testTimeoutMs,
          hookTimeout: testTimeoutMs,
          // Runs first: the fast lane should give feedback before the
          // serialized real-io lane even starts.
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'real-io',
          include: REAL_IO_TEST_FILES,
          exclude: BASE_EXCLUDE,
          // Serialize (mostly) rather than parallelize: these tests compete
          // for the same real external resources (git's index lock, disk
          // I/O, a spawned subprocess pool), so more concurrency among THEM
          // specifically makes each one slower and less predictable — the
          // opposite of what parallelism buys the fast lane. A small cap
          // (not maxWorkers:1) keeps this lane's own wall-clock reasonable
          // while still cutting self-contention far below the default pool.
          maxWorkers: 2,
          testTimeout: REAL_IO_LANE_TIMEOUT_MS,
          hookTimeout: REAL_IO_LANE_TIMEOUT_MS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
