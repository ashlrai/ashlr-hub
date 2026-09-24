/**
 * ApprovalDetail — the approve path cannot fire on one click, and in 3.10 it
 * asks in the same order as every other guarded action: CONFIRMATION first
 * (what is about to happen), then the TOKEN, then the write (unit C1).
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { ApprovalDetail } from './ApprovalDetail.js';

const TOKEN = 'b'.repeat(64);

function proposal(over: Record<string, unknown> = {}) {
  return {
    id: 'p-1',
    repo: '/Users/m/repos/binshield',
    origin: 'swarm',
    kind: 'pr',
    title: 'Fix the flaky snapshot test',
    summary: 'Two assertions raced the clock.',
    status: 'pending',
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    diff: '',
    decisionEvidence: { decisions: [], sourceQuality: { state: 'ok' } },
    ...over,
  };
}

let posts: Array<{ path: string; token: string | undefined }>;

beforeEach(() => {
  evictAll();
  clearMutationToken();
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ path, token: (init?.headers as Record<string, string>)['x-ashlr-token'] });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(proposal()), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearMutationToken();
});

describe('ApprovalDetail', () => {
  it('confirms first, then asks for the token, then approves', async () => {
    const onDecided = vi.fn();
    const user = userEvent.setup();
    render(<ApprovalDetail id="p-1" dispatchEnabled onDispatchDisabled={() => {}} onDecided={onDecided} />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this pr against binshield?' });
    expect(within(confirm).getByText(/opens a real pull request/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Approve and open the pull request' }));
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(posts).toEqual([]);
    await user.type(within(unlock).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/api/inbox/p-1/approve', token: TOKEN }]));
    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1));
  });

  it('backing out of the confirmation asks for nothing and writes nothing', async () => {
    const user = userEvent.setup();
    render(<ApprovalDetail id="p-1" dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = await screen.findByRole('dialog', { name: 'Reject this proposal?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});
