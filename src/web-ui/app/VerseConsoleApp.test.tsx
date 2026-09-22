import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, hasMutationHold, markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { MockEventSource, verseFetch } from '../routes/verse/fixtures.test-support.js';
import { resetVerseStore } from '../routes/verse/verse-store.js';
import { isScopedConsolePath, isVerseConsolePath } from './console-mode.js';
import { VerseConsoleApp } from './VerseConsoleApp.js';

const READ = 'c'.repeat(64);
const MUT = 'd'.repeat(64);

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/');
  localStorage.clear();
  evictAll();
  resetVerseStore();
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
    expect(await screen.findByRole('heading', { name: 'Connect to Ashlr Verse' })).toBeInTheDocument();
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
    await screen.findByRole('navigation', { name: 'Chats' });
    expect(screen.queryByRole('heading', { name: 'Connect to Ashlr Verse' })).not.toBeInTheDocument();
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
});
