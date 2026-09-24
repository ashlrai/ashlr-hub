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

const SOURCE = readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse/VerseApp.tsx'), 'utf8');

/** Specifiers of VALUE imports (`import { X } from '…'`, `import X from '…'`, `import '…'`) — `import type` excluded. */
function staticValueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"];?/gm)) out.push(m[1]!);
  return out;
}

const LAZY_ONLY = [
  './shell/CommandPalette.js',
  './shell/NeedsYouDrawer.js',
  './shell/ShortcutsOverlay.js',
  './shell/GearTray.js',
  './onboarding/OnboardingFlow.js',
  './shell/RailStatus.js',
  './shell/palette-model.js',
  // The idle surface warm-up's query table pulls in every surface's data
  // modules; only the tiny scheduler (./shell/idle-prefetch.js) is static.
  './shell/surface-prefetch.js',
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
    for (const spec of LAZY_ONLY.filter((s) => s !== './shell/palette-model.js')) {
      expect(SOURCE).toContain(`import('${spec}')`);
    }
  });
});
