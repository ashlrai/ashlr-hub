/**
 * vitest.config.web.ts — DOM test runner for src/web-ui/**.
 *
 * Deliberately separate from the root vitest.config.ts, which is scoped to
 * `test/**` (the backend's own suite, per-process HOME isolation, forked
 * pool, etc.) and owned by the backend/test-migration work. Mixing a jsdom
 * environment + testing-library setup into that config would change
 * semantics for 650+ existing backend test files. Run with `npm run test:web`.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const excludes = ['**/node_modules/**', '**/dist/**'];
const transcriptTests = 'src/web-ui/routes/verse/Transcript.test.tsx';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    exclude: excludes,
    setupFiles: ['./src/web-ui/test/setup.ts'],
    css: false,
    clearMocks: true,
    restoreMocks: true,
    // Vitest 4 unions root and project includes, so keep the include at the
    // project level. Every Transcript case still runs, after other DOM workers
    // have stopped, to measure its unchanged streaming budget without contention.
    projects: [
      {
        extends: true,
        test: {
          name: 'console',
          include: ['src/web-ui/**/*.test.{ts,tsx}'],
          exclude: [...excludes, transcriptTests],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'transcript',
          include: [transcriptTests],
          exclude: excludes,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
