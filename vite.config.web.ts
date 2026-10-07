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
 * 1b. What the workbench shares with the phone app ships as ONE more chunk.
 *
 *    Verse on a phone (app/VerseMobileApp.tsx) is its own lazy app, but its
 *    screens read the same stores as the workbench (the session stream, the
 *    activity loop, the chat list's model …). Every such module is shared,
 *    so §1 must leave it out of the shell group — and Rolldown then cut each
 *    into a chunk of its own, every one paying request and import/export
 *    glue on the WORKBENCH's first paint. `VerseShared` collects exactly the
 *    shell's first-paint modules that the phone app also reaches (lazily),
 *    minus the phone's own first-paint closure (the phone must not download
 *    the workbench's share to paint its frame). The other consoles' code is
 *    still never captured.
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
const VERSE_MOBILE_ROOT = fileURLToPath(new URL('./src/web-ui/app/VerseMobileApp.tsx', import.meta.url));
const verseShellModules = new Set<string>();
/** FIRST-PAINT CHUNKING §1b: the workbench shell's first-paint modules the phone app also reaches. */
const verseSharedModules = new Set<string>();
/** chunk file name → the chunk file names it imports statically, as Vite's preload pass sees the bundle. */
const staticChunkImports = new Map<string, readonly string[]>();

function verseFirstPaintChunks(): Plugin {
  return {
    name: 'ashlr:verse-first-paint-chunks',
    apply: 'build',
    buildEnd() {
      verseShellModules.clear();
      verseSharedModules.clear();
      const info = (id: string) => this.getModuleInfo(id);
      /** Everything reachable from `roots` (lazily too, unless `staticOnly`), never passing through `stop`. */
      const reach = (roots: string[], stop: ReadonlySet<string>, staticOnly = false): Set<string> => {
        const out = new Set<string>();
        const walk = [...roots];
        while (walk.length > 0) {
          const id = walk.pop()!;
          if (stop.has(id) || out.has(id)) continue;
          out.add(id);
          const mod = info(id);
          walk.push(...(mod?.importedIds ?? []), ...(staticOnly ? [] : (mod?.dynamicallyImportedIds ?? [])));
        }
        return out;
      };
      const entries = [...this.getModuleIds()].filter((id) => info(id)?.isEntry);
      // The other consoles' code: reachable from the entry through neither Verse app.
      const elsewhere = reach(entries, new Set([VERSE_SHELL_ROOT, VERSE_MOBILE_ROOT]));
      // The phone app: everything it may load, and what its first paint loads.
      const mobileAll = reach([VERSE_MOBILE_ROOT], new Set([VERSE_SHELL_ROOT]));
      const mobileFirstPaint = reach([VERSE_MOBILE_ROOT], new Set([VERSE_SHELL_ROOT]), true);
      // The console's static closure, minus anything the other consoles share (§1),
      // with what the phone app also reaches split off into the shared group (§1b).
      for (const id of reach([VERSE_SHELL_ROOT], new Set(), true)) {
        if (elsewhere.has(id)) continue;
        if (!mobileAll.has(id)) verseShellModules.add(id);
        else if (!mobileFirstPaint.has(id)) verseSharedModules.add(id);
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
      // The release budget measures these exact generated bytes without rebuilding.
      manifest: true,
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
              {
                // FIRST-PAINT CHUNKING §1b.
                name: 'VerseShared',
                test: (id: string) => verseSharedModules.has(id),
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
