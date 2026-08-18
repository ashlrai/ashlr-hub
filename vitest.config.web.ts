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

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/web-ui/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/web-ui/test/setup.ts'],
    css: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
