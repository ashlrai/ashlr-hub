/**
 * VerseApp first-paint imports (review 3.10 d1).
 *
 * Every module VerseApp imports statically is in the chunk a cold chat paint
 * must download before anything shows. The overlays (⌘K palette, ⌘J drawer,
 * ⌘/ shortcuts, the ⚙ tray), first-run onboarding and the rail's badge /
 * capacity module cannot draw anything at first paint, and together they were
 * ~97 KB of the 125 KB VerseConsoleApp chunk (727 KB chat critical JS against
 * the 350 KB budget). They must stay dynamic imports; a type-only import is
 * erased at build time and is fine.
 *
 * Measured with a scratch `vite build --config vite.config.web.ts` and the
 * static-closure walk of index → VerseConsoleApp → ChatSection:
 * 727.4 KB → 658.4 KB raw (239.0 → 221.3 KB gzip); VerseConsoleApp 125.0 → 27.8 KB.
 *
 * 3.11 (369.3 → 349.1 KB, `npm run check:first-paint`): the transcript
 * derivation, context-math, the composer's cost estimator, the session gate,
 * the dialogs, the shared icon set, the anchor reveal and the guarded
 * runners left the static closure too. The second describe below walks the
 * WHOLE static-import graph from the first-paint roots — the same closure the
 * budget script measures, from source — so a static import added anywhere in
 * it (not only in VerseApp) fails here before the budget does.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse', path), 'utf8');
const SOURCE = read('VerseApp.tsx');
const WARMUP = read('shell/warmup.ts');

/** Specifiers of VALUE imports (`import { X } from '…'`, `import X from '…'`, `import '…'`) — `import type` excluded. */
function staticValueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"];?/gm)) out.push(m[1]!);
  return out;
}

/** Modules VerseApp itself loads with import(). */
const DYNAMIC = [
  './shell/CommandPalette.js',
  './shell/NeedsYouDrawer.js',
  './shell/ShortcutsOverlay.js',
  './shell/GearTray.js',
  './onboarding/OnboardingFlow.js',
  './shell/RailStatus.js',
  // The after-first-paint warm-up (review 3.10.1): the idle gate, the step
  // list and — one import() further in — the surfaces' query table. Only a
  // few-line trigger (prefetchAfterFirstPaint) is on the first-paint path;
  // the static scheduler and its preload list cost ~0.9 KB of chat critical JS.
  './shell/warmup.js',
  // Resources (3.11 C6): the edge tab, rail button, ⌘. handler and — one
  // import() further in — the drawer. Only the ~0.7 KB store is static (a
  // pinned column must take its grid track at first paint).
  './resources/ResourcesChrome.js',
];

const LAZY_ONLY = [
  ...DYNAMIC,
  './shell/palette-model.js',
  // Reached only through ./shell/warmup.js, never from VerseApp at all.
  './shell/idle-prefetch.js',
  './shell/surface-prefetch.js',
  // Reached only through the Resources chunk.
  './resources/ResourcesHandle.js',
  './resources/ResourcesDrawer.js',
  './resources/resources-summary.js',
  './resources/resources-model.js',
  './resources/resources-queries.js',
];

describe('VerseApp keeps non-first-paint modules out of its static imports', () => {
  const statics = staticValueImports(SOURCE);

  it('sees the static imports it should (the parser works)', () => {
    expect(statics).toContain('./shell/run-command.js');
    expect(statics).toContain('./useVerseUi.js');
  });

  it.each(LAZY_ONLY)('%s is only ever a dynamic import', (spec) => {
    expect(statics).not.toContain(spec);
  });

  it('loads each of them with import()', () => {
    for (const spec of DYNAMIC) expect(SOURCE).toContain(`import('${spec}')`);
  });

  it('the warm-up chunk reaches the surfaces’ query table only through import() too', () => {
    // Otherwise every surface's data module would ride along with the tiny
    // warm-up chunk the moment the shell mounts.
    expect(staticValueImports(WARMUP)).not.toContain('./surface-prefetch.js');
    expect(WARMUP).toContain(`import('./surface-prefetch.js')`);
    // And VerseApp never names the scheduler or the table itself.
    expect(SOURCE).not.toMatch(/['"]\.\/shell\/(idle-prefetch|surface-prefetch)\.js['"]/);
  });
});

// ---------------------------------------------------------------------------
// The whole first-paint static closure, from source
// ---------------------------------------------------------------------------

const SRC = resolve(process.cwd(), 'src');

/**
 * Relative specifiers of the VALUE imports and re-exports in `src`: what the
 * bundler keeps as a static edge. Type-only forms (`import type`,
 * `export type`, `import { type A, type B }`) are erased and not edges;
 * `import()` is a dynamic edge and not matched. Assets (.css, ?url) are skipped.
 */
function staticEdges(src: string): string[] {
  const out: string[] = [];
  const re = /^\s*(?:import|export)\s+(type\s+)?(?:([\w*${}\s,]+?)\s+from\s+)?['"](\.[^'"]+)['"]/gm;
  for (const m of src.matchAll(re)) {
    const [, typeOnly, clause, spec] = m;
    if (typeOnly) continue;
    // `export { … } from` / `import { … } from` whose every name is `type X`.
    const braces = clause?.match(/^\{([\s\S]*)\}$/);
    if (braces) {
      const names = braces[1]!.split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    }
    if (!/\.(js|ts|tsx)$/.test(spec!)) continue;
    out.push(spec!);
  }
  return out;
}

function resolveModule(from: string, spec: string): string {
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const ext of ['.ts', '.tsx', '.js']) if (existsSync(base + ext)) return base + ext;
  throw new Error(`cannot resolve ${spec} from ${relative(SRC, from)}`);
}

/** Every module reachable through static edges from `roots`, as paths relative to src/. */
function staticClosure(roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = roots.map((r) => resolve(SRC, r));
  while (stack.length > 0) {
    const file = stack.pop()!;
    const key = relative(SRC, file);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const spec of staticEdges(readFileSync(file, 'utf8'))) stack.push(resolveModule(file, spec));
  }
  return seen;
}

/** The roots scripts/check-first-paint-budget.mjs measures (CHAT_FIRST_PAINT_ROOTS). */
const FIRST_PAINT_ROOTS = ['web-ui/main.tsx', 'web-ui/app/VerseConsoleApp.tsx', 'web-ui/routes/verse/sections/ChatSection.tsx'];

/**
 * Must never be statically reachable from the chat first paint. Each is
 * loaded with import() (or preloaded) by whoever needs it; the note says who.
 */
const NEVER_FIRST_PAINT: Readonly<Record<string, string>> = {
  'web-ui/routes/verse/verse-transcript.ts': 'transcript derivation — workspace/dock only (verse-store must not import it back)',
  'web-ui/routes/verse/useVerseTranscript.ts': 'transcript hook — workspace/dock only',
  'web-ui/routes/verse/Workspace.tsx': 'ChatSection preloads it',
  'web-ui/routes/verse/Sidebar.tsx': 'ChatSection preloads it',
  'web-ui/routes/verse/Transcript.tsx': 'inside the Workspace chunk',
  'web-ui/routes/verse/MessageMarkdown.tsx': 'markdown renderer',
  'web-ui/routes/verse/dock/DockHost.tsx': 'the dock starts closed',
  'web-ui/routes/verse/NewChatDialog.tsx': 'opens on request',
  'web-ui/routes/verse/verse-model.ts': 'ChatSection preloads the seat lookups',
  'core/verse/context-math.ts': 'verse-store uses compaction-point.ts instead',
  'web-ui/routes/verse/chat/composer-state.ts': 'first-paint callers use composer-memory.ts',
  'web-ui/components/auth/SessionGate.tsx': 'VerseConsoleApp loads it while the probe runs',
  'web-ui/components/auth/MutationTokenDialog.tsx': 'preloaded by ChatSection and guarded-action',
  'web-ui/components/primitives/Dialog.tsx': 'preloaded by ChatSection',
  'web-ui/routes/inbox/ConfirmDialog.tsx': 'preloaded by guarded-action',
  'web-ui/components/primitives/icons.tsx': 'the rail draws from icon-base.tsx',
  'web-ui/routes/verse/verse-icons.tsx': 'the rail draws from rail-icons.tsx',
  'web-ui/routes/verse/shell/reveal-anchor.ts': 'preloaded by anchor-requests.ts',
  'web-ui/routes/verse/shell/guarded-runners.ts': 'run-command imports it when a guarded run is confirmed',
  'web-ui/routes/verse/shell/CommandPalette.tsx': 'VerseApp overlay',
  'web-ui/routes/verse/shell/warmup.ts': 'VerseApp after-first-paint warm-up',
  'web-ui/routes/verse/resources/ResourcesChrome.tsx': 'VerseApp Resources chrome',
};

describe('the chat first-paint static closure (whole graph)', () => {
  const closure = staticClosure(FIRST_PAINT_ROOTS);

  it('walks the graph it should (the walker works)', () => {
    for (const expected of [
      'web-ui/routes/verse/VerseApp.tsx',
      'web-ui/routes/verse/verse-store.ts',
      'core/verse/compaction-point.ts',
      'web-ui/routes/verse/chat/composer-memory.ts',
      'web-ui/routes/verse/rail-icons.tsx',
      'web-ui/components/primitives/icon-base.tsx',
      'web-ui/routes/verse/shell/anchor-requests.ts',
      'web-ui/routes/verse/shell/run-command.ts',
    ]) expect(closure).toContain(expected);
  });

  it('parses type-only and re-export forms the way the bundler does', () => {
    expect(staticEdges(`import type { A } from './a.js';\nexport type { B } from './b.js';\nimport { type C, type D } from './c.js';`)).toEqual([]);
    expect(staticEdges(`import {\n  x,\n  type Y,\n} from './x.js';\nexport { z } from './z.js';\nimport './side.js';\nimport s from './s.module.css';`))
      .toEqual(['./x.js', './z.js', './side.js']);
    expect(staticEdges(`const m = import('./lazy.js');`)).toEqual([]);
  });

  it.each(Object.entries(NEVER_FIRST_PAINT))('%s stays out (%s)', (module) => {
    expect(closure).not.toContain(module);
  });
});
