/**
 * sections/ChatSection.first-paint.test.tsx — the chat's first-paint
 * boundaries stay where 3.10 put them (SPEC-310A §1: chat critical JS
 * ≤ 350 KB; scripts/check-first-paint-budget.mjs measures the real build).
 *
 *   - the budget script's closure: static imports count, dynamic ones never;
 *   - ChatSection imports the workspace, the chat list, the dock-only
 *     derivations and verse-model LAZILY (a static import would drag them —
 *     ~150 KB with the transcript, composer and markdown — back into the
 *     chunk a cold chat paint parses);
 *   - MessageMarkdown keeps marked + DOMPurify out of its static graph;
 *   - before the chunks land the surface paints skeletons in its own shape,
 *     and the real columns replace them.
 */
import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error — a plain .mjs build script with no type declarations.
import { aliasGroupedRoots, CHAT_FIRST_PAINT_ROOTS, criticalFiles } from '../../../../../scripts/check-first-paint-budget.mjs';

const VERSE = resolve(process.cwd(), 'src/web-ui/routes/verse');
const read = (rel: string) => readFileSync(join(VERSE, rel), 'utf8');

/** Module specifiers this source imports STATICALLY (type-only imports excluded: they vanish at build). */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^import\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)) out.push(m[1]!);
  for (const m of src.matchAll(/^export\s+(?!type\s)[^;]*?from\s+['"]([^'"]+)['"]/gms)) out.push(m[1]!);
  return out;
}

describe('check-first-paint-budget: what counts as critical', () => {
  const manifest = {
    'index.html': { file: 'assets/index.js', imports: ['_react.js'], dynamicImports: ['app/VerseConsoleApp.tsx'] },
    '_react.js': { file: 'assets/react.js' },
    'app/VerseConsoleApp.tsx': { file: 'assets/VerseConsoleApp.js', imports: ['_react.js', '_store.js'], css: ['assets/x.css'] },
    '_store.js': { file: 'assets/store.js' },
    'routes/verse/sections/ChatSection.tsx': { file: 'assets/ChatSection.js', imports: ['_store.js'], dynamicImports: ['routes/verse/Workspace.tsx'] },
    'routes/verse/Workspace.tsx': { file: 'assets/Workspace.js', imports: ['_markdown.js'] },
    '_markdown.js': { file: 'assets/markdown.js' },
  };

  it('is the static closure of the chat paint path, with dynamic imports excluded', () => {
    expect([...criticalFiles(manifest)].sort()).toEqual([
      'assets/ChatSection.js', 'assets/VerseConsoleApp.js', 'assets/index.js', 'assets/react.js', 'assets/store.js',
    ]);
  });

  it('a lazy chunk made static again joins the critical set (the regression this guards)', () => {
    const regressed = { ...manifest, 'routes/verse/sections/ChatSection.tsx': { file: 'assets/ChatSection.js', imports: ['_store.js', 'routes/verse/Workspace.tsx'] } };
    expect(criticalFiles(regressed)).toContain('assets/markdown.js');
  });

  it('fails loudly when a root is renamed away, instead of measuring nothing', () => {
    const { 'routes/verse/sections/ChatSection.tsx': _gone, ...rest } = manifest;
    expect(() => criticalFiles(rest)).toThrow(/ChatSection/);
  });

  it('measures from the entry, the /verse console and the Chat section', () => {
    expect(CHAT_FIRST_PAINT_ROOTS).toEqual(['index.html', 'app/VerseConsoleApp.tsx', 'routes/verse/sections/ChatSection.tsx']);
  });
});

describe('check-first-paint-budget: a root folded into a group chunk', () => {
  // vite.config.web.ts ships the console's first-paint modules as one group
  // chunk, which has no facade module: the manifest keys it by file name and
  // `app/VerseConsoleApp.tsx` is no longer a key.
  const grouped = {
    'index.html': { file: 'assets/index.js', imports: ['_react.js'] },
    '_react.js': { file: 'assets/react.js' },
    '_VerseConsoleApp-x.js': { file: 'assets/VerseConsoleApp-x.js', imports: ['_react.js'] },
    'routes/verse/sections/ChatSection.tsx': { file: 'assets/ChatSection.js', imports: ['_VerseConsoleApp-x.js'] },
  };
  const maps: Record<string, string[]> = {
    'assets/VerseConsoleApp-x.js': ['../../src/web-ui/routes/verse/VerseApp.tsx', '../../src/web-ui/app/VerseConsoleApp.tsx'],
    'assets/ChatSection.js': ['../../src/web-ui/routes/verse/sections/ChatSection.tsx'],
  };
  const sourcesOf = (file: string) => maps[file] ?? [];

  it('measures the chunk whose sourcemap carries the root', () => {
    const aliased = aliasGroupedRoots(grouped, sourcesOf);
    expect(aliased['app/VerseConsoleApp.tsx']).toBe(grouped['_VerseConsoleApp-x.js']);
    expect([...criticalFiles(aliased)].sort()).toEqual(['assets/ChatSection.js', 'assets/VerseConsoleApp-x.js', 'assets/index.js', 'assets/react.js']);
  });

  it('still fails loudly when no chunk carries the root', () => {
    expect(() => criticalFiles(aliasGroupedRoots(grouped, () => []))).toThrow(/VerseConsoleApp/);
  });
});

describe('the heavy parts of Chat stay out of its first-paint chunk', () => {
  it('ChatSection has no static import of the workspace, chat list, dock derivations or verse-model', () => {
    const imports = staticImports(read('sections/ChatSection.tsx'));
    for (const lazy of ['../Workspace.js', '../Sidebar.js', '../chat/tasks-model.js', '../chat/turn-files.js', '../verse-model.js', '../dock/DockHost.js', '../NewChatDialog.js']) {
      expect(imports, lazy).not.toContain(lazy);
    }
  });

  it('MessageMarkdown keeps marked, DOMPurify and the renderer out of its static graph', () => {
    const imports = staticImports(read('MessageMarkdown.tsx'));
    expect(imports).not.toContain('marked');
    expect(imports).not.toContain('dompurify');
    expect(imports).not.toContain('./MessageMarkdownRenderer.js');
    // …and the helpers it re-exports are dependency-free.
    expect(staticImports(read('markdown-stream.ts'))).toEqual([]);
  });
});

describe('ChatSection before its chunks land', () => {
  afterEach(() => {
    vi.doUnmock('../Workspace.js');
    vi.doUnmock('../Sidebar.js');
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('paints the list and workspace skeletons, then the real columns replace them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.resetModules();
    vi.doMock('../Workspace.js', async () => {
      await gate;
      return { Workspace: () => <main aria-label="Workspace loaded" /> };
    });
    vi.doMock('../Sidebar.js', async () => {
      await gate;
      return { Sidebar: () => <nav aria-label="Chats" /> };
    });
    const { ChatSection } = await import('./ChatSection.js');
    const { ToastProvider } = await import('../../../components/primitives/Toast.js');
    render(<ToastProvider><ChatSection /></ToastProvider>);

    expect(screen.getByRole('status', { name: 'Loading chat' })).toBeInTheDocument();
    // A <nav> like the real list (the grid's `.chat > nav` rules apply to it),
    // but never answering to the loaded list's name.
    expect(screen.getByRole('navigation', { name: 'Loading chat list' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Chats' })).toBeNull();

    await act(async () => { release(); await gate; });
    expect(await screen.findByRole('main', { name: 'Workspace loaded' })).toBeInTheDocument();
    expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Loading chat' })).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Loading chat list' })).toBeNull();
  });
});
