/**
 * 3.15 — the Terminal panel stays OFF the chat's first paint (SPEC-310C
 * budget: chat critical JS ≤ 352 KB, `npm run check:first-paint`).
 *
 * xterm, its addons (WebGL, search, links, Unicode 11) and the block view are
 * several hundred KB. They may load only when a terminal is first shown:
 *   - every @xterm import in this directory is `import type` or `import()`;
 *   - the registration (terminal.pane.tsx, which the pane registry imports
 *     eagerly after first paint) names the panel only through `import()`;
 *   - no module OUTSIDE this directory imports it statically (the registry
 *     finds the registration by glob, and loads the panel through lazyPane).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = resolve(process.cwd(), 'src/web-ui');
const HERE = join(WEB, 'routes/verse/terminal');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...walk(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$|\.test-support\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

/** Specifiers of VALUE imports (static). `import type` and `import()` excluded. */
function staticValueImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"];?/gm)) out.push(m[1]!);
  for (const m of src.matchAll(/^export\s+(?!type\s)[^'";]*?\sfrom\s+['"]([^'"]+)['"];?/gm)) out.push(m[1]!);
  return out;
}

describe('the terminal loads lazily', () => {
  const own = walk(HERE);

  it('finds its own files (guards the walk itself)', () => {
    expect(own.map((f) => relative(HERE, f))).toEqual(expect.arrayContaining(['TerminalPanel.tsx', 'xterm-view.ts', 'terminal.pane.tsx', 'TerminalPane.tsx']));
  });

  it('never imports @xterm statically — only import() and import type', () => {
    for (const file of own) {
      const statics = staticValueImports(readFileSync(file, 'utf8')).filter((s) => s.startsWith('@xterm/'));
      expect(statics, relative(WEB, file)).toEqual([]);
    }
    const view = readFileSync(join(HERE, 'xterm-view.ts'), 'utf8');
    for (const mod of ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl', '@xterm/addon-search', '@xterm/addon-web-links', '@xterm/addon-unicode11']) {
      expect(view).toContain(`import('${mod}')`);
    }
  });

  it('CodeMirror (the input editor) is a chunk of its own: one file imports it, and only through import() is that file reached', () => {
    const editorFile = join(HERE, 'command-editor.ts');
    for (const file of own) {
      const statics = staticValueImports(readFileSync(file, 'utf8'));
      const cm = statics.filter((s) => s.startsWith('@codemirror/') || s.startsWith('@lezer/'));
      if (file === editorFile) expect(cm.length, 'command-editor.ts').toBeGreaterThan(0);
      else expect(cm, relative(WEB, file)).toEqual([]);
      expect(statics.filter((s) => /(^|\/)command-editor\.js$/.test(s)), relative(WEB, file)).toEqual([]);
    }
    expect(readFileSync(join(HERE, 'input-editor.ts'), 'utf8')).toContain("import('./command-editor.js')");
  });

  it('the registration names the panel only through import()', () => {
    const reg = readFileSync(join(HERE, 'terminal.pane.tsx'), 'utf8');
    // The registry API and a glyph the first-party panes already load: nothing of the panel.
    expect(staticValueImports(reg).sort()).toEqual(['../dock/dock-icons.js', '../panes/pane-registry.js']);
    expect(reg).toContain("import('./TerminalPane.js')");
  });

  it('nothing outside this directory imports it statically', () => {
    const outside = walk(WEB).filter((f) => !f.startsWith(HERE));
    const offenders: string[] = [];
    for (const file of outside) {
      for (const spec of staticValueImports(readFileSync(file, 'utf8'))) {
        if (/(^|\/)terminal\/(?!.*dock)/.test(spec) && resolve(join(file, '..'), spec).startsWith(HERE)) offenders.push(`${relative(WEB, file)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
