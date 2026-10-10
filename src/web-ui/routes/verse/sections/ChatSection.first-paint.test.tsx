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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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

describe('configured first-paint entrypoints retain absolute limits', () => {
  const scripts = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).scripts as Record<string, string>;
  const check = (entry: 'check:first-paint' | 'check:first-paint:built', desktopBytes: number, mobileBytes: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-paint-boundary-'));
    try {
      mkdirSync(join(dir, '.vite'));
      const manifest = {
        'index.html': { file: 'index.js' },
        'app/VerseConsoleApp.tsx': { file: 'console.js' },
        'routes/verse/sections/ChatSection.tsx': { file: 'chat.js' },
        'app/VerseMobileApp.tsx': { file: 'mobile.js' },
        'routes/verse/mobile/screens/HomeScreen.tsx': { file: 'home.js' },
      };
      writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(manifest));
      for (const [file, bytes] of [['index.js', 1], ['console.js', desktopBytes - 2], ['chat.js', 1],
        ['mobile.js', 1], ['home.js', mobileBytes - 2]] as const) writeFileSync(join(dir, file), Buffer.alloc(bytes));
      // Exercise the actual required npm command arguments against bytes on disk;
      // no bundle build or candidate JS execution occurs in this fixture.
      const [node, ...args] = scripts[entry]!.split(/\s+/);
      expect(node).toBe('node');
      return spawnSync(process.execPath, [...args, '--no-build', '--out-dir', dir, '--json'], { cwd: process.cwd(), encoding: 'utf8' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it.each(['check:first-paint', 'check:first-paint:built'] as const)('%s admits measured lazy-loader overhead but refuses desktop and phone overruns', (entry) => {
    const accepted = check(entry, 361_496, 255_296);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toMatchObject({ ok: true, totalBytes: 361_496, mobile: { ok: true, totalBytes: 255_296 } });
    const desktopOver = check(entry, 354 * 1024 + 1, 255_296);
    expect(desktopOver.status).toBe(1);
    expect(JSON.parse(desktopOver.stdout)).toMatchObject({ ok: false, desktopOk: false, mobile: { ok: true } });
    const phoneOver = check(entry, 361_496, 250 * 1024 + 1);
    expect(phoneOver.status).toBe(1);
    expect(JSON.parse(phoneOver.stdout)).toMatchObject({ ok: false, desktopOk: true, mobile: { ok: false } });
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
    for (const lazy of ['../Workspace.js', '../Sidebar.js', '../ChatResizer.js', '../chat/tasks-model.js', '../chat/turn-files.js', '../chat/start-chat.js', '../verse-model.js', '../dock/DockHost.js', '../NewChatDialog.js', '../verse-events.js', '../verse-list-channel.js']) {
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
  afterEach(async () => {
    // Module evaluation starts chunk imports; settle them before changing mocks or caches.
    await act(async () => { await vi.dynamicImportSettled(); });
    vi.doUnmock('../Workspace.js');
    vi.doUnmock('../Sidebar.js');
    vi.doUnmock('../ChatResizer.js');
    vi.doUnmock('../verse-list-channel.js');
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('paints synchronous saved sizing and the columns while only the resize control is delayed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.resetModules();
    vi.doMock('../Workspace.js', () => ({ Workspace: () => <main aria-label="Workspace loaded" /> }));
    vi.doMock('../Sidebar.js', () => ({ Sidebar: () => <nav aria-label="Chats" /> }));
    vi.doMock('../ChatResizer.js', async () => {
      await gate;
      return { ChatResizer: ({ label }: { label: string }) => <div role="separator" aria-label={label} /> };
    });
    const sizing = await import('../chat-panel-sizing.js');
    sizing.resetChatPanelSizing();
    sizing.setChatPanelWidth('sidebar', 280);
    const { ChatSection } = await import('./ChatSection.js');
    const { ToastProvider } = await import('../../../components/primitives/Toast.js');
    const mounted = render(<ToastProvider><ChatSection /></ToastProvider>);
    try {
      expect(await screen.findByRole('main', { name: 'Workspace loaded' })).toBeInTheDocument();
      expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: 'Resize chat list' })).toBeNull();
      const frame = mounted.container.querySelector('[data-sidebar="open"]') as HTMLElement;
      expect(frame).not.toBeNull();
      expect(frame.style.getPropertyValue('--verse-sidebar-width')).toBe('280px');
      // The same marker carries phone/focus hiding and bottom-dock row span.
      // It remains an inert grid gap, not a keyboard/screen-reader separator.
      const gap = frame.querySelector('[data-verse-resizer="sidebar"]');
      expect(gap).toHaveAttribute('aria-hidden', 'true');
      expect(gap).not.toHaveAttribute('role');
      expect(gap).not.toHaveAttribute('tabindex');
      const { setFocusMode } = await import('../shell/focus-mode.js');
      act(() => setFocusMode(true));
      expect(frame).toHaveAttribute('data-focus', 'on');
      expect(gap).toBeInTheDocument();
      act(() => setFocusMode(false));
      await act(async () => { release(); await gate; });
      expect(await screen.findByRole('separator', { name: 'Resize chat list' })).toBeInTheDocument();
      expect(frame.style.getPropertyValue('--verse-sidebar-width')).toBe('280px');
    } finally {
      release();
      mounted.unmount();
      sizing.resetChatPanelSizing();
    }
  });

  it('keeps the chat columns usable if the optional resize control cannot load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.stubGlobal('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
    vi.resetModules();
    vi.doMock('../Workspace.js', () => ({ Workspace: () => <main aria-label="Workspace loaded" /> }));
    vi.doMock('../Sidebar.js', () => ({ Sidebar: () => <nav aria-label="Chats" /> }));
    vi.doMock('../ChatResizer.js', async () => { throw new Error('Synthetic optional chunk failure'); });
    const { ChatSection } = await import('./ChatSection.js');
    const { ToastProvider } = await import('../../../components/primitives/Toast.js');
    const mounted = render(<ToastProvider><ChatSection /></ToastProvider>);
    expect(await screen.findByRole('main', { name: 'Workspace loaded' })).toBeInTheDocument();
    expect(await screen.findByRole('navigation', { name: 'Chats' })).toBeInTheDocument();
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(screen.queryByRole('separator', { name: 'Resize chat list' })).toBeNull();
    expect(screen.getByRole('main', { name: 'Workspace loaded' })).toBeInTheDocument();
    mounted.unmount();
  });

  it('never acquires a metadata connection when Chat unmounts before its channel module arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const open = vi.fn(() => vi.fn());
    vi.resetModules();
    vi.doMock('../Workspace.js', () => ({ Workspace: () => null }));
    vi.doMock('../Sidebar.js', () => ({ Sidebar: () => null }));
    vi.doMock('../verse-list-channel.js', async () => {
      await gate;
      return { openVerseListChannel: open, onVerseAccountReadingsChanged: () => () => undefined };
    });
    const { ChatSection } = await import('./ChatSection.js');
    const { ToastProvider } = await import('../../../components/primitives/Toast.js');
    const mounted = render(<ToastProvider><ChatSection /></ToastProvider>);
    mounted.unmount();
    await act(async () => { release(); await gate; });
    expect(open).not.toHaveBeenCalled();
  });

  it('releases one acquired metadata owner exactly once and leaves rejected loads retryable', async () => {
    const { openDeferredVerseListChannel } = await import('./ChatSection.js');
    const release = vi.fn();
    const open = vi.fn(() => release);
    const dispose = openDeferredVerseListChannel(async () => ({ openVerseListChannel: open }));
    await act(async () => undefined);
    expect(open).toHaveBeenCalledTimes(1);
    dispose();
    dispose();
    expect(release).toHaveBeenCalledTimes(1);
    const retry = vi.fn().mockRejectedValueOnce(new Error('Chunk unavailable')).mockResolvedValueOnce({ openVerseListChannel: open });
    openDeferredVerseListChannel(retry)();
    await act(async () => undefined);
    const recovered = openDeferredVerseListChannel(retry);
    await act(async () => undefined);
    expect(retry).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    recovered();
    expect(release).toHaveBeenCalledTimes(2);
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
