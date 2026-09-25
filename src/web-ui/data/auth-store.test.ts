import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureQuery, getQuerySnapshot, runQuery, evictAll, subscribeQuery } from './cache.js';
import {
  adoptInjectedTokens,
  clearReadSession,
  establishReadSession,
  forgetRememberedTokens,
  getAuthSnapshot,
  getMutationToken,
  markCheckComplete,
  renewReadSession,
  reportSessionExpired,
  setMutationToken,
} from './auth-store.js';

const READ = 'e'.repeat(64);
const MUT = 'f'.repeat(64);

describe('auth-store protected-state eviction', () => {
  beforeEach(() => {
    evictAll();
    forgetRememberedTokens();
    markCheckComplete(true);
    setMutationToken('a'.repeat(64));
  });

  it('evicts protected cache data and the mutation hold on session expiry', async () => {
    await runQuery('protected', async () => ({ secret: true }));
    expect(getQuerySnapshot('protected').data).toEqual({ secret: true });
    reportSessionExpired();
    expect(getQuerySnapshot('protected').data).toBeUndefined();
    expect(getMutationToken()).toBeNull();
  });

  it('evicts protected cache data and the mutation hold on explicit logout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await runQuery('protected', async () => ({ secret: true }));
    await clearReadSession();
    expect(getQuerySnapshot('protected').data).toBeUndefined();
    expect(getMutationToken()).toBeNull();
  });
});

describe('auth-store read-session renewal', () => {
  beforeEach(() => {
    evictAll();
    forgetRememberedTokens();
    delete window.__ASHLR_TOKENS__;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    forgetRememberedTokens();
    delete window.__ASHLR_TOKENS__;
  });

  it('renews the cookie silently on 401 with the remembered read token instead of showing the gate', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await establishReadSession(READ);
    setMutationToken(MUT);
    await runQuery('protected', async () => ({ secret: true }));

    reportSessionExpired();
    await renewReadSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-ashlr-token']).toBe(READ);
    expect(getAuthSnapshot().phase).toBe('authenticated');
    expect(getMutationToken()).toBe(MUT);
    // Nothing is ever written to storage.
    expect(Object.values(sessionStorage)).not.toContain(READ);
    expect(Object.values(localStorage)).not.toContain(READ);
  });

  it('re-reads what is on screen after a renewal — not entries nobody observes (a warmed, never-opened surface)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await establishReadSession(READ);
    const onScreen = vi.fn(async () => ({ chat: 'sessions' }));
    const warmedOnly = vi.fn(async () => ({ fleet: 'history' }));
    let lapsedFails = true;
    const lapsed = vi.fn(async () => {
      if (lapsedFails) throw new Error('HTTP 401');
      return { models: '30d' };
    });
    await runQuery('chat:sessions', onScreen);
    const unsubscribe = subscribeQuery('chat:sessions', () => undefined);
    // The idle warm-up's reads: cached, fetcher registered, nobody subscribed.
    await ensureQuery('command:fleet-history', warmedOnly, 60_000);
    await ensureQuery('growth:models', lapsed, 60_000); // 401ed while the ticket was lapsed
    expect(getQuerySnapshot('growth:models').status).toBe('error');
    for (const fn of [onScreen, warmedOnly, lapsed]) fn.mockClear();

    reportSessionExpired();
    await renewReadSession();

    expect(onScreen).toHaveBeenCalledTimes(1);
    expect(warmedOnly).not.toHaveBeenCalled();
    expect(lapsed).not.toHaveBeenCalled();
    // Left exactly as it was: the next mount decides. Fresh data is served as-is…
    expect(getQuerySnapshot('command:fleet-history').data).toEqual({ fleet: 'history' });
    await ensureQuery('command:fleet-history', warmedOnly, 60_000);
    expect(warmedOnly).not.toHaveBeenCalled();
    // …and a read that failed during the lapse is re-read the moment its surface mounts.
    lapsedFails = false;
    await ensureQuery('growth:models', lapsed, 60_000);
    expect(lapsed).toHaveBeenCalledTimes(1);
    expect(getQuerySnapshot('growth:models').data).toEqual({ models: '30d' });
    unsubscribe();
  });

  it('shows the gate only when renewal is rejected (server restarted with new tokens)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await establishReadSession(READ);
    setMutationToken(MUT);

    reportSessionExpired();
    expect(await renewReadSession()).toBe(false);
    expect(getAuthSnapshot().phase).toBe('unauthenticated');
    expect(getMutationToken()).toBeNull();
    // A second 401 with nothing remembered expires immediately.
    markCheckComplete(true);
    reportSessionExpired();
    expect(getAuthSnapshot().phase).toBe('unauthenticated');
  });

  it('keeps host-injected tokens re-adoptable and never lets their hold idle out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    window.__ASHLR_TOKENS__ = { readToken: READ, token: MUT };

    expect(await adoptInjectedTokens()).toBe(true);
    expect(window.__ASHLR_TOKENS__).toBeUndefined();
    expect(getMutationToken()).toBe(MUT);

    // 20 idle minutes: a pasted token would be cleared; a host token is re-armed.
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(getMutationToken()).toBe(MUT);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(getMutationToken()).toBe(MUT);

    // The gate re-mounting (after a lapse) adopts again from memory, no paste.
    expect(await adoptInjectedTokens()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A pasted token still idles out.
    setMutationToken('1'.repeat(64));
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
    expect(getMutationToken()).toBeNull();
  });
});
