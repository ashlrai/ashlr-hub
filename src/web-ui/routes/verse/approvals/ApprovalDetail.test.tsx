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
let served: Record<string, unknown>;

beforeEach(() => {
  evictAll();
  clearMutationToken();
  posts = [];
  served = proposal();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ path, token: (init?.headers as Record<string, string>)['x-ashlr-token'] });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(served), { status: 200, headers: { 'content-type': 'application/json' } });
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

/**
 * The live item: "patch: claude run: Advance goal "Add a circuit breaker to
 * binshield's worker scan pipeline so a deg…" TITRR claude:claude-fable-5 run
 * produced 2 file(s) (+384/-0). Review before applying. binshield · 38d".
 */
describe('ApprovalDetail — a readable header', () => {
  const TITLE = 'claude run: Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a deg';
  const REPO = '/private/tmp/claude-501/-Users-m/scratchpad/binshield';

  beforeEach(() => {
    served = proposal({
      kind: 'patch',
      repo: REPO,
      title: TITLE,
      summary: 'TITRR claude:claude-fable-5 run produced 2 file(s) (+384/-0). Review before applying.',
      engineModel: 'claude:claude-fable-5',
      createdAt: new Date(Date.now() - 38 * 86_400_000).toISOString(),
    });
  });

  it('wraps the title at a word, keeps the full text in the tooltip, and states the run as stats', async () => {
    render(<ApprovalDetail id="p-1" dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />);
    const heading = await screen.findByRole('heading', { level: 3 });
    expect(heading).toHaveTextContent('Advance goal "Add a circuit breaker to binshield\'s worker scan pipeline so a\u2026"');
    expect(heading).not.toHaveTextContent(/deg/);
    expect(heading).toHaveAttribute('title', TITLE);
    expect(screen.getByText('Patch \u00b7 Claude run')).toBeInTheDocument();
    // The glyph string is for the eye only; a screen reader reads the sentence,
    // which is real text (an aria-label on a generic span is never announced).
    const glyphs = screen.getByText('2 files \u00b7 +384 \u22120');
    expect(glyphs).toHaveAttribute('aria-hidden', 'true');
    expect(glyphs).not.toHaveAttribute('aria-label');
    const spoken = screen.getByText('2 files changed, 384 lines added, 0 removed');
    expect(spoken).toHaveClass('visually-hidden');
    expect(spoken.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText('created 38 days ago')).toBeInTheDocument();
    expect(screen.getByText('Review before applying.')).toBeInTheDocument();
    // The summary sentence is not repeated raw.
    expect(screen.queryByText(/file\(s\)/)).not.toBeInTheDocument();
  });

  it('explains TITRR instead of printing it bare, and names the project rather than its temp path', async () => {
    render(<ApprovalDetail id="p-1" dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />);
    const source = (await screen.findAllByText('Test-and-repair loop'))[0]!;
    expect(source).toHaveAttribute('title', expect.stringMatching(/^TITRR — Test, Iterate, Test, Refine, Repeat/));
    // The header names the project; the path is its tooltip…
    expect(screen.getByText('binshield')).toHaveAttribute('title', REPO);
    // …and the standing action note reads as a sentence, not a path.
    expect(screen.getByText(/^Writes the diff to binshield on disk now/)).toBeInTheDocument();
  });

  it('still prints the exact checkout once in the approve confirmation', async () => {
    const user = userEvent.setup();
    render(<ApprovalDetail id="p-1" dispatchEnabled onDispatchDisabled={() => {}} onDecided={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Approve…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Approve this patch against binshield?' });
    expect(within(confirm).getByText(REPO)).toBeInTheDocument();
  });
});
