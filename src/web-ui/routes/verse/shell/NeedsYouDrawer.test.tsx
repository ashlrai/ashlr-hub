/**
 * NeedsYouDrawer — ⌘J triage from the keyboard (unit C1). RTL + user-event.
 *
 *   - J / K move, H / L switch splits, ↩ opens, Esc backs out then closes;
 *   - A / R / V go through CONFIRMATION and then the TOKEN before any POST,
 *     and the POST carries the token to the item's own same-origin route;
 *   - E (mark done) needs no confirmation, only the token;
 *   - "All clear" only when every producer answered — never from silence;
 *   - an approval opens the full ApprovalDetail;
 *   - the drawer is a full-screen sheet at 375.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi } from '../verse-ui-store.js';
import { GuardHost, resetGuard } from './guarded-action.js';
import { resetResolvedForTest } from './needs-you-actions.js';
import { NeedsYouDrawer } from './NeedsYouDrawer.js';
import { activity, approvalNeed, chatFailedNeed, shellFetch, TOKEN, vetoNeed, type ShellFetch } from './shell-fixtures.test-support.js';
import { resetActivityForTest } from './useActivity.js';
import { mockCompactViewport, type ViewportMock } from './viewport.test-support.js';

function Harness() {
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
      <GuardHost />
    </>
  );
}

let net: ShellFetch;
let viewport: ViewportMock | null = null;

function setup(response = activity({ needsYou: [approvalNeed('p-1'), vetoNeed(), chatFailedNeed()] })) {
  net = shellFetch(response);
  vi.stubGlobal('fetch', net.fetch);
  // The real fetcher (apiGet over the stubbed fetch): 404 → ApiError, as in production.
  resetActivityForTest();
}

async function openDrawer() {
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>,
  );
  act(() => openVerseNeedsYou({ split: 'all' }));
  return screen.findByRole('dialog', { name: /Needs you/ });
}

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetGuard();
  resetResolvedForTest();
  clearMutationToken();
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
});

afterEach(() => {
  viewport?.restore();
  viewport = null;
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  resetActivityForTest();
});

const selected = () => screen.getByRole('listbox').querySelector('[aria-selected="true"]')?.textContent ?? '';

describe('NeedsYouDrawer', () => {
  it('lists every item most-urgent first, with J / K moving the selection', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    const list = await screen.findByRole('listbox', { name: /All needing you/ });
    expect(list).toHaveFocus();
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(selected()).toContain('fix the flaky snapshot');
    await user.keyboard('j');
    expect(selected()).toContain('Prune 17 stale goals');
    expect(selected()).toMatch(/closes in \d+[smhd]/);
    await user.keyboard('k');
    expect(selected()).toContain('fix the flaky snapshot');
  });

  it('H / L switch splits, each with its count', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    await screen.findByRole('listbox');
    expect(screen.getByRole('tab', { name: /All 3 items/ })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('l');
    expect(getVerseUiState().needsYouSplit).toBe('approvals');
    expect(screen.getByRole('tab', { name: /Approvals 1 items/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('h');
    await user.keyboard('h');
    expect(getVerseUiState().needsYouSplit).toBe('accounts');
  });

  it('A confirms, then asks for the token, then POSTs the item’s route with it', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    await screen.findByRole('listbox');
    await user.keyboard('a');
    const confirm = await screen.findByRole('dialog', { name: 'Approve this pr against binshield?' });
    expect(net.posts()).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Unlock actions' })).not.toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Approve and open the pull request' }));
    const unlock = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(net.posts()).toEqual([]);
    await user.type(within(unlock).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(unlock).getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(net.posts()).toEqual([{ path: '/api/inbox/p-1/approve', body: {}, token: TOKEN }]));
    // Hidden at once, before the next poll catches up.
    await waitFor(() => expect(screen.queryByRole('option', { name: /fix the flaky snapshot/ })).not.toBeInTheDocument());
    expect(await screen.findByText('Approve: PR: fix the flaky snapshot test')).toBeInTheDocument();
  });

  it('cancelling the confirmation sends nothing', async () => {
    setup();
    const user = userEvent.setup();
    await openDrawer();
    await screen.findByRole('listbox');
    await user.keyboard('r');
    const confirm = await screen.findByRole('dialog', { name: 'Reject this proposal?' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reject this proposal?' })).not.toBeInTheDocument());
    expect(net.posts()).toEqual([]);
    // Focus is back in the drawer, and the triage keys still work.
    await user.keyboard('j');
    expect(selected()).toContain('Prune 17 stale goals');
  });

  it('V vetoes with a generic confirmation when the item carries none; with a held token it runs straight after', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await screen.findByRole('listbox');
    await user.keyboard('j');
    await user.keyboard('v');
    const confirm = await screen.findByRole('dialog', { name: 'Veto this action?' });
    await user.click(within(confirm).getByRole('button', { name: 'Veto' }));
    await waitFor(() => expect(net.posts()).toEqual([{ path: '/api/verse/leader/veto', body: { actionId: 'm-7' }, token: TOKEN }]));
  });

  it('E marks a failed chat read without a confirmation', async () => {
    setup();
    act(() => setMutationToken(TOKEN));
    const user = userEvent.setup();
    await openDrawer();
    await screen.findByRole('listbox');
    await user.keyboard('jj');
    expect(selected()).toContain('Failed: Migrate the store');
    await user.keyboard('e');
    await waitFor(() => expect(net.posts()).toEqual([{ path: '/api/verse/activity/seen', body: { sessionId: 's-9', turnCount: 3 }, token: TOKEN }]));
    expect(screen.queryByRole('dialog', { name: /Mark read/ })).not.toBeInTheDocument();
  });

  it('↩ opens an approval in full; Esc goes back to the list, then closes', async () => {
    setup();
    const user = userEvent.setup();
    const base = net.fetch.getMockImplementation()!;
    net.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/inbox/p-1') {
        return new Response(JSON.stringify({
          id: 'p-1', repo: '/Users/m/repos/binshield', origin: 'swarm', kind: 'pr', title: 'Fix the flaky snapshot test', summary: 'Two assertions raced the clock.',
          status: 'pending', createdAt: new Date().toISOString(), diff: '', decisionEvidence: { decisions: [], sourceQuality: { state: 'ok' } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return base(input, init);
    });
    await openDrawer();
    await screen.findByRole('listbox');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Fix the flaky snapshot test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('listbox')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(getVerseUiState().overlay).toBeNull());
  });

  it('says "All clear" only when every producer answered', async () => {
    setup(activity({ needsYou: [] }));
    await openDrawer();
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('Fleet: Propose · 2 building.')).toBeInTheDocument();
  });

  it('refuses a false all-clear when a producer is silent', async () => {
    setup(activity({ needsYou: [], sources: { approvals: 'ok', authority: 'error', fleet: 'unavailable', leader: 'ok', chats: 'ok', accounts: 'ok' } }));
    await openDrawer();
    expect(await screen.findByText(/it isn't an all-clear/)).toBeInTheDocument();
    expect(screen.getByText(/The autonomy grant failed to answer and the fleet isn't reporting in this build/)).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });

  it('says so when the server has no activity route at all', async () => {
    setup();
    net.setActivity(404);
    await openDrawer();
    expect(await screen.findByText("Needs you isn't available on this server")).toBeInTheDocument();
  });

  it('is a full-screen sheet at 375', async () => {
    viewport = mockCompactViewport({ dark: true });
    setup();
    const dialog = await openDrawer();
    expect(dialog).toHaveAttribute('data-presentation', 'full');
    await screen.findByRole('listbox');
    // No keyboard legend on a phone.
    expect(screen.queryByText('splits')).not.toBeInTheDocument();
  });
});
