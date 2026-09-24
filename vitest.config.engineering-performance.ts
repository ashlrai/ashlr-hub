/** Explicit acceptance gate, not part of the default correctness lanes.
 * Keep the fixed latency assertions red until the runtime actually meets them. */
import { defineConfig } from 'vitest/config';

if (process.platform !== 'darwin') {
  throw new Error('The engineering responsiveness acceptance gate currently requires macOS; an untested platform is not a pass.');
}

export default defineConfig({
  test: {
    include: ['benchmarks/resource-engineering-responsiveness.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // The write guard too: this gate drives the real pool/universe writers
    // in-process (keys, campaigns, supervisors), exactly the class of writer
    // that once leaked into the real ~/.ashlr (see the guard's header).
    setupFiles: ['./vitest.config.ts', './test/setup/home.ts', './test/setup/home-isolation-guard.ts'],
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    clearMocks: true,
    testTimeout: 360_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
});
