import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { ManagerStatus } from './ManagerStatus.js';

const association = (paused: boolean) => ({ sourceState: 'healthy', association: { outcomeId: 'chat-work', revision: 5, scopeRevision: 1, paused, terminalStageIds: [], manager: { sourceState: 'healthy', enabled: true, mode: 'interactive', sessionId: 'chat', conversationRevision: 1, running: null, next: null, latest: null } } });
beforeEach(() => { evictAll(); setMutationToken('a'.repeat(64)); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
describe('Manager status provenance', () => {
  it('shows an idle manager separately from paused and saves an exact revision pause', async () => {
    const posts: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(String(init.body)) }); return Response.json({ ok: true }); }
      return Response.json(association(false));
    }));
    render(<ManagerStatus sessionId="chat" />);
    expect(await screen.findByText('Manager idle')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pause manager' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.url).toBe('/api/verse/outcomes/chat-work/pause');
    expect(posts[0]?.body).toMatchObject({ expectedRevision: 5 });
  });
  it('shows actual paused provenance and retains it when resume fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? new Response('failed', { status: 503 }) : Response.json(association(true))));
    render(<ManagerStatus sessionId="chat" />);
    expect(await screen.findByText('Manager paused')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Resume manager' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update');
    expect(screen.getByText('Manager paused')).toBeInTheDocument();
  });
  it('never presents damaged discovery as idle or ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sourceState: 'degraded', association: null })));
    render(<ManagerStatus sessionId="chat" />);
    expect(await screen.findByText('Manager unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /manager/ })).toBeNull();
  });
});
