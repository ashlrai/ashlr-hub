import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';
import { ResourcePoolConsoleApp } from './ResourcePoolConsoleApp.js';
import { isResourceConsolePath, isScopedConsolePath } from './console-mode.js';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
beforeEach(() => {
  window.history.replaceState(null, '', '/resources/'); evictAll(); clearMutationToken();
  vi.stubGlobal('EventSource', vi.fn());
  markCheckComplete(false);
});
afterEach(() => { act(() => markCheckComplete(false)); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

describe('resource console scoped bootstrap', () => {
  it('authenticates, scopes, refreshes and disconnects without global observers or control requests', async () => {
    const { scope, snapshot } = resourceFixture(); let authenticated = false;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') { authenticated = init?.method === 'POST'; return new Response(null, { status: 204 }); }
      if (!authenticated) return new Response(null, { status: 401 });
      if (path === '/api/resources/console') return json(scope);
      if (path === '/api/resources') return json(snapshot);
      throw new Error(`Unexpected route: ${path}`);
    });
    vi.stubGlobal('fetch', request); const user = userEvent.setup();
    render(<ResourcePoolConsoleApp />);
    expect(screen.getByRole('heading', { name: 'Connect to Ashlrverse resources' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Resource store')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Read token'), 'a'.repeat(64));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { name: 'Routing board' });
    expect(screen.getByText('Ashlrverse')).toBeInTheDocument();
    expect(screen.getByLabelText('Resource store')).toHaveTextContent(scope.root);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/resources/console', '/api/resources']);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(request.mock.calls.filter(([path]) => path === '/api/resources')).toHaveLength(2));
    expect(EventSource).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([path]) => path !== '/api/session').every(([, init]) => init?.method === 'GET')).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlrverse resources' });
    expect(screen.queryByLabelText('Resource store')).not.toBeInTheDocument();
    expect(Object.values(sessionStorage)).not.toContain('a'.repeat(64));
  });

  it.each([
    { mode: 'hub' }, { root: 'relative' }, { root: '/private/line\nsecret' }, { readOnly: 'false' },
    { readOnly: false, workspace: null }, { workspace: 'relative' }, { maxQueued: 65 }, { maxParallel: 0 }, { poolId: 'invalid/id' },
  ])('withholds snapshots for invalid scope %j', async (patch) => {
    markCheckComplete(true); const { scope } = resourceFixture();
    const request = vi.fn(async () => json({ ...scope, ...patch })); vi.stubGlobal('fetch', request);
    render(<ResourcePoolConsoleApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Resource scope unavailable');
    expect(request.mock.calls).toHaveLength(1); expect(EventSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Routing board' })).not.toBeInTheDocument();
  });

  it('withholds a mismatched pool snapshot and preserves separate read-only setup', async () => {
    markCheckComplete(true); const { scope, snapshot } = resourceFixture(); scope.readOnly = true; scope.workspace = null;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => json(path.endsWith('/console') ? scope : { ...snapshot, pool: { ...snapshot.pool, id: 'another-pool' } })));
    render(<ResourcePoolConsoleApp />);
    expect(await screen.findByRole('alert')).toHaveTextContent('did not match the selected pool');
    expect(screen.getByText('Read-only console')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock controls' })).not.toBeInTheDocument();
  });

  it('accepts the real read-only scope with zero execution caps and no supervisor', async () => {
    markCheckComplete(true); const { scope, snapshot } = resourceFixture();
    scope.readOnly = true; scope.workspace = null; scope.maxParallel = 0; scope.maxQueued = 0; snapshot.supervisor = null;
    const request = vi.fn(async (path: string) => json(path.endsWith('/console') ? scope : snapshot));
    vi.stubGlobal('fetch', request); render(<ResourcePoolConsoleApp />);
    expect(await screen.findByRole('heading', { name: 'Routing board' })).toBeInTheDocument();
    expect(screen.getByText('Execution is disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock controls' })).not.toBeInTheDocument();
    expect(EventSource).not.toHaveBeenCalled();
  });

  it('returns to the gate and removes scoped content on a read-session expiry', async () => {
    markCheckComplete(true); const { scope, snapshot } = resourceFixture(); let expired = false;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => expired ? new Response(null, { status: 401 }) : json(path.endsWith('/console') ? scope : snapshot)));
    const user = userEvent.setup(); render(<ResourcePoolConsoleApp />); await screen.findByRole('heading', { name: 'Routing board' });
    expired = true; await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlrverse resources' });
    expect(screen.queryByLabelText('Resource store')).not.toBeInTheDocument(); expect(EventSource).not.toHaveBeenCalled();
  });

  it.each(['/resources', '/resources/'])('selects isolated resource mode for exact path %s', (path) => {
    expect(isResourceConsolePath(path)).toBe(true); expect(isScopedConsolePath(path)).toBe(true);
  });
  it.each(['/', '/next/', '/next#/resources', '/resources/other', '/resource/', '/resources?root=other'])('does not broaden resource mode for %s', (path) => {
    expect(isResourceConsolePath(path)).toBe(false); expect(isScopedConsolePath(path)).toBe(false);
  });
  it('continues isolating both Universe entry spellings', () => {
    expect(isResourceConsolePath('/universe/')).toBe(false);
    expect(isScopedConsolePath('/universe')).toBe(true); expect(isScopedConsolePath('/universe/')).toBe(true);
  });
});
