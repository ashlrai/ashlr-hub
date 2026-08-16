/**
 * vite.config.web.ts — build config for the ashlr-hub operator web UI
 * (src/web-ui/**). Owned entirely by the web-ui foundation; the Node
 * backend (src/core/**, src/cli/**) is untouched by this config and is
 * built separately by `tsc -p tsconfig.json`.
 *
 * OUTPUT PATH — read this before changing it:
 *   The compiled backend serves static assets from `assetsDir()`
 *   (src/core/web/server.ts), which resolves to `dist/core/web/public`
 *   next to the compiled server.js. That directory already holds the
 *   legacy vanilla-JS SPA (src/core/web/public/index.html + app.js),
 *   copied verbatim by scripts/copy-assets.mjs, and "/" is special-cased
 *   by serveStatic() to resolve to that legacy index.html.
 *
 *   This build therefore outputs into a SIBLING subdirectory —
 *   dist/core/web/public/next/ — so:
 *     - the legacy app keeps serving unmodified at "/"
 *     - the new app is reachable at "/next/index.html" without any
 *       change to server.ts / static.ts (which this foundation must not
 *       touch)
 *     - `emptyOutDir` only clears the `next/` subfolder, never the
 *       legacy assets alongside it
 *
 *   base: '/next/' makes every built asset URL absolute under that
 *   subpath so index.html resolves its bundled JS/CSS correctly however
 *   the server routes it.
 *
 * DEV SERVER — `npm run dev:web` proxies /api and /api/events to a real
 * `ashlr serve` instance. Since the server mints a fresh random port and
 * two 32-byte tokens on every start, point the proxy at whichever port
 * that instance printed via ASHLR_DEV_API_PROXY_TARGET. See
 * src/web-ui/DESIGN.md for the full loop.
 */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const webUiRoot = fileURLToPath(new URL('./src/web-ui', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ASHLR_');
  const proxyTarget = env.ASHLR_DEV_API_PROXY_TARGET || 'http://127.0.0.1:4173';

  return {
    root: webUiRoot,
    base: '/next/',
    plugins: [react()],
    build: {
      outDir: fileURLToPath(new URL('./dist/core/web/public/next', import.meta.url)),
      emptyOutDir: true,
      sourcemap: true,
      target: 'es2022',
    },
    server: {
      port: 5183,
      strictPort: false,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: false,
          secure: false,
          ws: false,
        },
      },
    },
  };
});
