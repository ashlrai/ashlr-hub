import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../data/auth-store.js';
import { evictAll } from '../../data/cache.js';
import { ResourcePoolView } from '../resources/ResourcePoolView.js';
import { resourceFixture } from '../resources/fixtures.test-support.js';

beforeEach(() => {
  window.history.replaceState(null, '', '/resources/');
  evictAll(); clearMutationToken(); markCheckComplete(true);
  vi.stubGlobal('EventSource', vi.fn());
});
afterEach(() => {
  act(() => { clearMutationToken(); markCheckComplete(false); });
  vi.unstubAllGlobals(); window.history.replaceState(null, '', '/');
});
function setup() {
  const f = resourceFixture();
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/resources' && init?.method === 'GET') return new Response(JSON.stringify(f.snapshot), { status: 200 });
    throw new Error(`Unexpected workspace navigation request: ${path}`);
  });
  vi.stubGlobal('fetch', request);
  render(<ResourcePoolView scope={f.scope} />);
  return { ...f, request };
}

describe('workspace navigation uses the existing scoped resource session', () => {
  it('preserves separate unsent drafts across operating surfaces without dispatch', async () => {
    const f = setup(); const user = userEvent.setup();
    await user.type(await screen.findByLabelText('What should this task do?'), 'Resource desk draft');
    const navigation = within(screen.getByRole('navigation', { name: 'Operating surface' }));
    await user.click(navigation.getByRole('button', { name: 'Workspace' }));
    await user.type(await screen.findByLabelText('Task prompt'), 'Workspace draft');
    expect(screen.getByRole('heading', { name: 'Engineering workspace' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resources' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(navigation.getByRole('button', { name: 'Resources' }));
    expect(screen.getByLabelText('What should this task do?')).toHaveValue('Resource desk draft');
    expect(screen.getByLabelText('Task prompt')).not.toBeVisible();
    await user.click(navigation.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Workspace draft');
    expect(f.request.mock.calls.every(([path, init]) => path === '/api/resources' && init?.method === 'GET')).toBe(true);
    expect(EventSource).not.toHaveBeenCalled();
  });

  it('opens the workspace deep link and follows hash navigation without an implicit send', async () => {
    window.history.replaceState(null, '', '/resources/#resource-workspace');
    const f = setup();
    expect(await screen.findByLabelText('Task prompt')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Engineering workspace' })).toBeVisible();
    act(() => { window.location.hash = 'resource-accounts'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await waitFor(() => expect(screen.getByRole('region', { name: 'Accounts and quota' })).toBeVisible());
    expect(screen.getByLabelText('Task prompt')).not.toBeVisible();
    expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
