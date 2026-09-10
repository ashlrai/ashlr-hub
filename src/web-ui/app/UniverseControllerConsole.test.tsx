import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markCheckComplete } from '../data/auth-store.js';
import { evictAll } from '../data/cache.js';
import { UniverseConsoleApp } from './UniverseConsoleApp.js';

describe('controller inspector console isolation', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/universe/');
    evictAll();
    vi.stubGlobal('EventSource', vi.fn());
    markCheckComplete(true);
  });
  afterEach(() => {
    act(() => markCheckComplete(false));
    evictAll();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
  });
  it('reads named controller evidence even when experiment overview fails, then removes it on expiry', async () => {
    let expired = false;
    const request = vi.fn(async (path: string) => {
      if (expired) return new Response(null, { status: 401 });
      if (path === '/api/universe/console') return new Response(JSON.stringify({ schemaVersion: 1, mode: 'universe', readOnly: true, root: '/private/fixture' }));
      if (path === '/api/universe') return new Response(null, { status: 503 });
      if (path === '/api/universe/controller-status?controllerId=fleet') return new Response(JSON.stringify({
        schemaVersion: 1, controllerId: 'fleet', sourceState: 'missing', status: 'unavailable',
        createdAt: null, deadlineAt: null, observedAt: '2026-09-09T10:00:00.000Z', outcomes: [], reasons: ['controller-missing'],
      }));
      throw new Error('Unexpected request');
    });
    vi.stubGlobal('fetch', request);
    render(<UniverseConsoleApp />);
    await screen.findByRole('heading', { name: 'Universe records unavailable' });
    expect(screen.getByRole('heading', { name: 'Controller inspector' })).toBeInTheDocument();
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/universe/console', '/api/universe']);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Controller ID'), 'fleet');
    await user.click(screen.getByRole('button', { name: 'Inspect controller' }));
    expect(await screen.findByText(/No controller registration was found/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Universe records unavailable' })).toBeInTheDocument();
    expired = true;
    await user.click(screen.getByRole('button', { name: 'Refresh controller' }));
    await screen.findByRole('heading', { name: 'Connect to Ashlrverse' });
    expect(screen.queryByRole('heading', { name: 'Evidence for fleet' })).not.toBeInTheDocument();
    expect(EventSource).not.toHaveBeenCalled();
  });
});
