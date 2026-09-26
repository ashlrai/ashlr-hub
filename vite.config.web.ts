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
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const webUiRoot = fileURLToPath(new URL('./src/web-ui', import.meta.url));

/**
 * FIRST-PAINT CHUNKING (SPEC-310A §1: chat first-paint critical JS, measured
 * by scripts/check-first-paint-budget.mjs). Two build-only adjustments. The
 * module graph — what is static, what is lazy — is untouched by both, and so
 * is what a cold /verse load downloads; only how it is packaged changes.
 *
 * 1. The Verse shell's first-paint modules ship as ONE chunk.
 *
 *    Rolldown gives every distinct set of importing entries its own chunk,
 *    and every lazy surface is an entry. So VerseConsoleApp's static closure
 *    (VerseApp, the ui store, the catalog, the dock store, the guard, the
 *    command bus …) was cut into a dozen chunks — every one of them needed
 *    at first paint anyway — each paying its own request, its import/export
 *    glue and, for each chunk holding an import(), its own copy of Vite's
 *    preload list (`__vite__mapDeps`: the file name of every chunk a lazy
 *    import needs). The overlays' list and the sections' list alone spelled
 *    out ~80 of the same file names twice.
 *
 *    The group captures exactly the modules in VerseConsoleApp's STATIC
 *    closure that nothing outside /verse can reach, computed from the module
 *    graph in buildEnd (so it follows the code): what first paint already
 *    downloads — never a lazy surface, never a module the other consoles
 *    share (React, data/*, and the primitives they use keep their own
 *    chunks). ChatSection keeps its own chunk: a cold load that opens on
 *    Command must not download Chat.
 *
 *    A group chunk has no facade module, so the manifest keys it by file
 *    name; check-first-paint-budget.mjs finds `app/VerseConsoleApp.tsx` in it
 *    through its sourcemap (aliasGroupedRoots).
 *
 * 2. Preload lists skip what the importing chunk has already loaded.
 *
 *    When a chunk runs, every chunk in its own static-import closure has
 *    been fetched and evaluated (ES module semantics), so naming one of them
 *    again in that chunk's preload list is a no-op paid for in the chunk's
 *    own bytes. resolveDependencies drops exactly those. CSS dependencies
 *    are never passed to it (Vite appends them afterwards) and are unchanged.
 */
const VERSE_SHELL_ROOT = fileURLToPath(new URL('./src/web-ui/app/VerseConsoleApp.tsx', import.meta.url));
const verseShellModules = new Set<string>();
/** chunk file name → the chunk file names it imports statically, as Vite's preload pass sees the bundle. */
const staticChunkImports = new Map<string, readonly string[]>();

function verseFirstPaintChunks(): Plugin {
  return {
    name: 'ashlr:verse-first-paint-chunks',
    apply: 'build',
    buildEnd() {
      verseShellModules.clear();
      const info = (id: string) => this.getModuleInfo(id);
      // Everything reachable — statically or lazily — from the entry without
      // passing through the Verse console: the other consoles' code.
      const elsewhere = new Set<string>();
      const walk = [...this.getModuleIds()].filter((id) => info(id)?.isEntry);
      while (walk.length > 0) {
        const id = walk.pop()!;
        if (id === VERSE_SHELL_ROOT || elsewhere.has(id)) continue;
        elsewhere.add(id);
        const mod = info(id);
        walk.push(...(mod?.importedIds ?? []), ...(mod?.dynamicallyImportedIds ?? []));
      }
      // The console's static closure, minus anything shared with them.
      const seen = new Set<string>();
      const stack = [VERSE_SHELL_ROOT];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!elsewhere.has(id)) verseShellModules.add(id);
        stack.push(...(info(id)?.importedIds ?? []));
      }
    },
    generateBundle: {
      // Before vite:build-import-analysis writes the preload lists.
      order: 'pre',
      handler(_options, bundle) {
        staticChunkImports.clear();
        for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') staticChunkImports.set(chunk.fileName, chunk.imports);
      },
    },
  };
}

/** The chunks already loaded whenever `fileName` runs: its static-import closure. */
function loadedWith(fileName: string): Set<string> {
  const loaded = new Set<string>();
  const stack = [...(staticChunkImports.get(fileName) ?? [])];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (loaded.has(file)) continue;
    loaded.add(file);
    stack.push(...(staticChunkImports.get(file) ?? []));
  }
  return loaded;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ASHLR_');
  const proxyTarget = env.ASHLR_DEV_API_PROXY_TARGET || 'http://127.0.0.1:4173';

  return {
    root: webUiRoot,
    base: '/next/',
    plugins: [react(), verseFirstPaintChunks()],
    build: {
      outDir: fileURLToPath(new URL('./dist/core/web/public/next', import.meta.url)),
      emptyOutDir: true,
      sourcemap: true,
      target: 'es2022',
      // FIRST-PAINT CHUNKING §2.
      modulePreload: {
        resolveDependencies: (_file, deps, { hostId, hostType }) => {
          if (hostType !== 'js') return deps;
          const loaded = loadedWith(hostId);
          return deps.filter((dep) => !loaded.has(dep));
        },
      },
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                // FIRST-PAINT CHUNKING §1.
                name: 'VerseConsoleApp',
                test: (id: string) => verseShellModules.has(id),
                // Only the modules the test names. The default would also
                // pull in their dependencies — the shared ones included.
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
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
