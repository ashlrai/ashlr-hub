import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      'next/link': 'vinext/shims/link',
      'next/image': 'vinext/shims/image',
    },
  },
  test: { environment: 'jsdom', include: ['test/**/*.test.tsx'] },
});
