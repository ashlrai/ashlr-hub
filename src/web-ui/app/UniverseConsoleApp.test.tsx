import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { UniverseConsoleApp } from './UniverseConsoleApp.js';
import { isUniverseConsolePath } from './console-mode.js';

const root = "/private/Universe lab/O'Brien $data";
const scope = { schemaVersion: 1, mode: 'universe', root, readOnly: true };
const overview = { schemaVersion: 1, sampledAt: '2026-09-07T12:00:00Z', sourceState: 'missing',
  reasons: [], universes: [], campaigns: [], deliveryReports: [], measurementScope: 'local-experiment' };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('scoped Universe console composition', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/universe/');
    evictAll();
    vi.stubGlobal('EventSource', vi.fn());
  });
  afterEach(() => {
    act(() => markCheckComplete(false));
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });

  it('probes only scope, authenticates, refreshes and disconnects without any Hub observer', async () => {
    let authenticated = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') {
        authenticated = init?.method === 'POST';
        return new Response(null, { status: 204 });
      }
      if (!authenticated) return new Response(null, { status: 401 });
      if (path === '/api/universe/console') return json(scope);
      if (path === '/api/universe') return json(overview);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', request);
    const user = userEvent.setup();
    render(<UniverseConsoleApp />);
    await screen.findByRole('heading', { name: 'Connect to Ashlr Universe' });
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/universe/console']);
    expect(screen.queryByText(root)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Read token'), 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Start your first universe' });
    expect(screen.getByLabelText('Universe store')).toHaveTextContent(root);
    expect(screen.getByText('Read-only observation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/api/universe')).toHaveLength(2));
    expect(EventSource).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlr Universe' });
    expect(screen.queryByText(root)).not.toBeInTheDocument();
    expect(request.mock.calls.every(([path]) => ['/api/session', '/api/universe/console', '/api/universe'].includes(path))).toBe(true);
    expect(request.mock.calls.filter(([path]) => path !== '/api/session').every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(sessionStorage.getItem('readToken')).toBeNull();
    expect(Object.values(sessionStorage)).not.toContain('a'.repeat(64));
  });

  it.each([{ ...scope, readOnly: false }, { ...scope, mode: 'hub' }, { ...scope, root: 'relative' }])(
    'withholds project reads when authenticated scope is invalid (%j)', async (invalid) => {
      markCheckComplete(true);
      const request = vi.fn(async () => json(invalid));
      vi.stubGlobal('fetch', request);
      render(<UniverseConsoleApp />);
      expect(await screen.findByRole('alert')).toHaveTextContent('Console scope unavailable');
      expect(screen.queryByRole('heading', { name: 'Ashlr Universe' })).not.toBeInTheDocument();
      expect(request.mock.calls).toHaveLength(1);
      expect(EventSource).not.toHaveBeenCalled();
    },
  );

  it('retries a failed scope check and returns to the gate on session expiry', async () => {
    markCheckComplete(true);
    let available = false;
    let expired = false;
    const request = vi.fn(async (path: string) => {
      if (expired) return new Response(null, { status: 401 });
      if (path === '/api/universe/console') return available ? json(scope) : new Response(null, { status: 503 });
      if (path === '/api/universe') return json(overview);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', request);
    const user = userEvent.setup();
    render(<UniverseConsoleApp />);
    await screen.findByRole('alert');
    available = true;
    await user.click(screen.getByRole('button', { name: 'Retry scope check' }));
    await screen.findByRole('heading', { name: 'Start your first universe' });
    expired = true;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlr Universe' });
    expect(screen.queryByText(root)).not.toBeInTheDocument();
    expect(EventSource).not.toHaveBeenCalled();
  });

  it('selects scoped mode only from its dedicated path', () => {
    expect(isUniverseConsolePath('/universe/')).toBe(true);
    expect(isUniverseConsolePath('/universe')).toBe(true);
    for (const path of ['/next', '/next/', '/', '/universe/other', '/next#/universe']) {
      expect(isUniverseConsolePath(path)).toBe(false);
    }
  });
});
