/**
 * /verse/m's bootstrap: the canonical path, the same session gate and token
 * model as the workbench (nothing new stored), the PWA head, and the shell
 * once a read session exists.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { bootstrap } from '../routes/verse/fixtures.test-support.js';
import { activityResponse, stubFetch } from '../routes/verse/mobile/mobile.test-support.js';
import { resetActivityForTest } from '../routes/verse/shell/useActivity.js';
import { ApiError } from '../data/client.js';
import { clearRemoteSessionForTest } from '../data/remote-session.js';
import { canonicalizeMobilePath, coverViewport, probeOutcome, VerseMobileApp } from './VerseMobileApp.js';

beforeEach(() => {
  evictAll();
  resetActivityForTest();
  clearMutationToken();
  localStorage.clear();
  sessionStorage.clear();
  clearRemoteSessionForTest();
});

afterEach(() => {
  act(() => markCheckComplete(false));
  resetActivityForTest();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('canonicalizeMobilePath', () => {
  it('adds the slash the service worker scope needs, keeping the screen', () => {
    window.history.replaceState(null, '', '/verse/m#/needs');
    canonicalizeMobilePath();
    expect(window.location.pathname).toBe('/verse/m/');
    expect(window.location.hash).toBe('#/needs');
    canonicalizeMobilePath();
    expect(window.location.pathname).toBe('/verse/m/');
  });
});

describe('the session probe', () => {
  it('asks for a token only when the Mac answered; otherwise says it is out of reach', () => {
    expect(probeOutcome('success', undefined)).toBe('authenticated');
    expect(probeOutcome('error', new ApiError('x', 401, '/api/verse/bootstrap'))).toBe('unauthenticated');
    expect(probeOutcome('error', new ApiError('x', 404, '/api/verse/bootstrap'))).toBe('unauthenticated');
    expect(probeOutcome('error', new ApiError('x', 502, '/api/verse/bootstrap'))).toBe('unreachable');
    expect(probeOutcome('error', new TypeError('Failed to fetch'))).toBe('unreachable');
  });

  it('opts the viewport into the safe area before the first paint, once', () => {
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    coverViewport(document);
    coverViewport(document);
    expect(document.head.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
  });
});

describe('VerseMobileApp', () => {
  it('uses the gateway session before any local token gate when its HTML marker is present', async () => {
    window.history.replaceState(null, '', '/verse/m/');
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ authenticated: false, csrfToken: 'c'.repeat(40), capabilities: { writes: false, pairing: false } }));
    vi.stubGlobal('fetch', fetch);
    act(() => markCheckComplete(false));
    render(<VerseMobileApp />);
    expect(await screen.findByText('Phone pairing is not enabled on this Mac yet. Open Verse on your Mac to finish gateway setup.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Connect to your Mac' })).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/remote/session');
    const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(headers.has('x-ashlr-token')).toBe(false);
    expect(headers.has('x-ashlr-read-client')).toBe(false);
  });
  it('clears an expired pending pairing and offers a new code', async () => {
    window.history.replaceState(null, '', '/verse/m/');
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    sessionStorage.setItem('ashlr.remotePairPending.v1', '00000000-0000-4000-8000-000000000001');
    const fetch = vi.fn(async (path: string) => path === '/remote/session'
      ? Response.json({ authenticated: false, csrfToken: 'c'.repeat(40), capabilities: { pairing: true, writes: false } })
      : Response.json({ error: 'Pairing unavailable' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    act(() => markCheckComplete(false));
    render(<VerseMobileApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check approval' }));
    expect(await screen.findByText('This pairing expired. Start over with a new code from your Mac.')).toBeInTheDocument();
    expect(sessionStorage.getItem('ashlr.remotePairPending.v1')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('heading', { name: 'Pair this phone' })).toBeInTheDocument();
  });
  it('keeps a pending pairing retryable through a transient network failure', async () => {
    window.history.replaceState(null, '', '/verse/m/');
    document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
    sessionStorage.setItem('ashlr.remotePairPending.v1', '00000000-0000-4000-8000-000000000001');
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/remote/session') return Response.json({ authenticated: false, csrfToken: 'c'.repeat(40), capabilities: { pairing: true, writes: false } });
      throw new TypeError('Network unreachable');
    }));
    act(() => markCheckComplete(false));
    render(<VerseMobileApp />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check approval' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not complete this step');
    expect(screen.getByRole('button', { name: 'Check approval' })).toBeEnabled();
    expect(sessionStorage.getItem('ashlr.remotePairPending.v1')).not.toBeNull();
  });
  it('without a session shows the same gate as the workbench, and fetches nothing', async () => {
    window.history.replaceState(null, '', '/verse/m');
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    act(() => markCheckComplete(false));
    render(<VerseMobileApp />);
    expect(await screen.findByRole('heading', { name: 'Connect to your Mac' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/verse/m/');
  });

  it('with a session draws the phone shell and makes the page installable', async () => {
    window.history.replaceState(null, '', '/verse/m/');
    stubFetch({
      'GET /api/verse/bootstrap': bootstrap(),
      'GET /api/verse/activity': activityResponse(),
      'GET /api/verse/control': { spend: { todayUsd: 0, todayDate: null, dailyBudgetUsd: 0 } },
    });
    act(() => markCheckComplete(true));
    render(<VerseMobileApp />);
    expect(await screen.findByRole('navigation', { name: 'Verse' })).toBeInTheDocument();
    await waitFor(() => expect(document.head.querySelector('link[rel="manifest"]')).not.toBeNull());
    expect(document.head.querySelector('meta[name="apple-mobile-web-app-capable"]')?.getAttribute('content')).toBe('yes');
  });

  it('keeps no secret in storage — only what the workbench already keeps', async () => {
    window.history.replaceState(null, '', '/verse/m/');
    stubFetch({ 'GET /api/verse/bootstrap': bootstrap(), 'GET /api/verse/activity': activityResponse() });
    act(() => markCheckComplete(true));
    render(<VerseMobileApp />);
    await screen.findByRole('navigation', { name: 'Verse' });
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i)!;
        // The per-tab read-client proof (auth-store) is the only auth-adjacent value, and it has no authority alone.
        expect(['ashlr.readClientProof.v1', 'ashlr.verse.layout.v1', 'ashlr.theme.v1', 'ashlr.verse.appearance.v1']).toContain(key);
      }
    }
  });
});
