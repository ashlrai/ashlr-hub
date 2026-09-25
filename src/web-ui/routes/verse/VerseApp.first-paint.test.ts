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
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
