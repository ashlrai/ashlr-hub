import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, clearReadSession, getAuthSnapshot, getMutationToken, hasMutationHold, markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { MockEventSource, verseFetch } from '../routes/verse/fixtures.test-support.js';
import * as verseQueries from '../routes/verse/verse-queries.js';
import { resetVerseStore } from '../routes/verse/verse-store.js';
import { reloadVerseUiForTest, resetVerseUi, VERSE_UI_STORAGE_KEY } from '../routes/verse/verse-ui-store.js';
import { isScopedConsolePath, isVerseConsolePath } from './console-mode.js';
import { listenForSidecarRestart, preloadVerseFirstPaint, preloadVerseFonts, SIDECAR_RESTARTED_EVENT, VerseConsoleApp } from './VerseConsoleApp.js';

const READ = 'c'.repeat(64);
const MUT = 'd'.repeat(64);

/**
 * Authentication reaches the shell's fresh Chat workspace, not the gate.
 * This fixture explicitly resets the module-level UI store as well as storage.
 * Fresh installs use Work with me; adopting tokens does not force Command.
 */
async function expectShellOnChat(): Promise<void> {
  const rail = await screen.findByRole('navigation', { name: 'Phantom sections' });
  expect(within(rail).getByRole('button', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
  expect(within(rail).getByRole('button', { name: /^Command/ })).not.toHaveAttribute('aria-current');
  const modes = screen.getByRole('navigation', { name: 'How you work' });
  expect(within(modes).getByRole('button', { name: 'Work with me' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(modes).getByRole('button', { name: 'Work for me' })).toHaveAttribute('aria-pressed', 'false');
}

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
  resetVerseUi();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  // auth-store's phase is module-level: every test starts on the gate, so the
  // injected-token path is exercised through SessionGate's own adoption.
  markCheckComplete(false);
  delete window.__ASHLR_TOKENS__;
});
afterEach(() => {
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  delete window.__ASHLR_TOKENS__;
  window.history.replaceState(null, '', '/');
});

describe('VerseConsoleApp', () => {
  it('is a scoped console on /verse', () => {
    expect(isVerseConsolePath('/verse')).toBe(true);
    expect(isVerseConsolePath('/verse/')).toBe(true);
    expect(isVerseConsolePath('/')).toBe(false);
    expect(isScopedConsolePath('/verse/')).toBe(true);
  });

  it('shows the Verse session gate when the probe is unauthenticated', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<VerseConsoleApp />);
    expect(await screen.findByRole('heading', { name: 'Connect to Phantom' })).toBeInTheDocument();
    expect(screen.getAllByText(/ashlr verse/).length).toBeGreaterThan(0);
    // No read session, no injected tokens: nothing is fetched until a token is pasted.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('adopts window.__ASHLR_TOKENS__ at load: read session established, mutation hold set, no dialog', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    window.__ASHLR_TOKENS__ = { readToken: READ, token: MUT };
    render(<VerseConsoleApp />);
    await expectShellOnChat();
    expect(screen.queryByRole('heading', { name: 'Connect to Phantom' })).not.toBeInTheDocument();
    const sessionCall = state.calls.find((c) => c.path === '/api/session')!;
    expect(sessionCall.method).toBe('POST');
    expect(sessionCall.headers['x-ashlr-token']).toBe(READ);
    await waitFor(() => expect(hasMutationHold()).toBe(true));
    expect(window.__ASHLR_TOKENS__).toBeUndefined();
    expect(Object.values(localStorage)).not.toContain(MUT);
    expect(Object.values(sessionStorage)).not.toContain(READ);
    expect(Object.values(sessionStorage)).not.toContain(MUT);
    // No unlock prompt shown once the hold exists.
    expect(screen.queryByText(/Actions locked/)).not.toBeInTheDocument();
  });

  it('adopts host tokens without changing the last saved Fleet workspace', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({
      version: 3, section: 'fleet', lastLaunchDay: '2026-09-01',
    }));
    reloadVerseUiForTest();
    window.__ASHLR_TOKENS__ = { readToken: READ, token: MUT };
    render(<VerseConsoleApp />);

    const rail = await screen.findByRole('navigation', { name: 'Phantom sections' });
    expect(within(rail).getByRole('button', { name: /^Fleet/ })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('button', { name: /^Command/ })).not.toHaveAttribute('aria-current');
    const modes = screen.getByRole('navigation', { name: 'How you work' });
    expect(within(modes).getByRole('button', { name: 'Work for me' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(modes).getByRole('button', { name: 'Work with me' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('heading', { name: 'Connect to Phantom' })).not.toBeInTheDocument();
    expect(state.calls.find((c) => c.path === '/api/session')).toMatchObject({
      method: 'POST', headers: { 'x-ashlr-token': READ },
    });
  });
});

describe('font preloads (no "preloaded but not used" on the connect screen)', () => {
  const fontPreloads = (doc: Document) =>
    [...doc.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"]')];
  let doc: Document;
  beforeEach(() => { doc = document.implementation.createHTMLDocument('preload'); });

  it('signed out: preloads only the UI face, as a CORS font fetch the CSS request matches', () => {
    preloadVerseFirstPaint(doc, false);
    const links = fontPreloads(doc);
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toMatch(/AshlrSans-latin/);
    expect(links[0]!.as).toBe('font');
    expect(links[0]!.crossOrigin).toBe('anonymous');
    expect(links[0]!.type).toBe('font/woff2');
  });

  it('host tokens injected: the chat will paint, so both faces go at once — and never twice', () => {
    preloadVerseFirstPaint(doc, true);
    preloadVerseFirstPaint(doc, true);
    const hrefs = fontPreloads(doc).map((l) => l.getAttribute('href') ?? '');
    expect(hrefs).toHaveLength(2);
    expect(hrefs.some((h) => /SpaceGrotesk-latin/.test(h))).toBe(true);
  });

  it('the display face follows once signed in, idempotently', () => {
    preloadVerseFirstPaint(doc, false);
    preloadVerseFonts(doc, true);
    preloadVerseFonts(doc, true);
    expect(fontPreloads(doc)).toHaveLength(2);
  });

  it('the app adds the display face when the session turns out to be signed in', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    window.__ASHLR_TOKENS__ = { readToken: READ, token: MUT };
    render(<VerseConsoleApp />);
    await expectShellOnChat();
    const hrefs = [...document.head.querySelectorAll('link[rel="preload"]')].map((l) => l.getAttribute('href') ?? '');
    expect(hrefs.some((h) => /SpaceGrotesk-latin/.test(h))).toBe(true);
  });
});

describe('listenForSidecarRestart (desktop sidecar restart → immediate re-adoption)', () => {
  const READ2 = 'e'.repeat(64);
  const MUT2 = 'f'.repeat(64);
  const READ3 = '1'.repeat(64);

  // Adoption remembers host tokens in memory for the page's life; forget the
  // previous test's so the gate case really starts on the gate.
  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await clearReadSession();
    vi.unstubAllGlobals();
    vi.stubGlobal('EventSource', MockEventSource);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function sessionPosts(calls: Array<{ path: string; method: string; headers: Record<string, string> }>): string[] {
    return calls.filter((c) => c.path === '/api/session' && c.method === 'POST').map((c) => c.headers['x-ashlr-token']!);
  }

  it('exchanges the restarted sidecar\'s tokens the moment the shell fires the event', async () => {
    const { fetch, state } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    const invalidate = vi.spyOn(verseQueries, 'invalidateVerseLists');
    const target = new EventTarget();
    const dispose = listenForSidecarRestart(target as unknown as Window);
    // The shell's token_handoff_script: set the tokens, then fire the event.
    window.__ASHLR_TOKENS__ = { readToken: READ2, token: MUT2 };
    target.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT));
    await waitFor(() => expect(sessionPosts(state.calls)).toEqual([READ2]));
    await waitFor(() => expect(getMutationToken()).toBe(MUT2));
    expect(getAuthSnapshot().phase).toBe('authenticated');
    expect(window.__ASHLR_TOKENS__).toBeUndefined();
    // The restarted server may have interrupted turns: the lists are re-read.
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    dispose();
  });

  it('a restart during an exchange runs once more with the newest tokens instead of racing', async () => {
    const { fetch: base, state } = verseFetch();
    let release: (() => void) | null = null;
    const gated = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/session') && release === null) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return (base as unknown as typeof fetch)(input, init);
    });
    vi.stubGlobal('fetch', gated);
    const target = new EventTarget();
    const dispose = listenForSidecarRestart(target as unknown as Window);
    window.__ASHLR_TOKENS__ = { readToken: READ2, token: MUT2 };
    target.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT));
    await waitFor(() => expect(release).not.toBeNull());
    window.__ASHLR_TOKENS__ = { readToken: READ3 };
    target.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT));
    target.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT));
    release!();
    await waitFor(() => expect(sessionPosts(state.calls)).toEqual([READ2, READ3]));
    dispose();
  });

  it('stops listening once disposed', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const target = new EventTarget();
    listenForSidecarRestart(target as unknown as Window)();
    window.__ASHLR_TOKENS__ = { readToken: READ2 };
    target.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT));
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces the session gate when the event lands while it is showing', async () => {
    const { fetch } = verseFetch();
    vi.stubGlobal('fetch', fetch);
    act(() => markCheckComplete(false));
    render(<VerseConsoleApp />);
    expect(await screen.findByRole('heading', { name: 'Connect to Phantom' })).toBeInTheDocument();
    window.__ASHLR_TOKENS__ = { readToken: READ2, token: MUT2 };
    act(() => { window.dispatchEvent(new CustomEvent(SIDECAR_RESTARTED_EVENT)); });
    await expectShellOnChat();
    expect(screen.queryByRole('heading', { name: 'Connect to Phantom' })).not.toBeInTheDocument();
  });
});
