/**
 * Needs you on a phone: every state (loading, all clear only when vouched,
 * error, offline), actions through the confirmation sheet with the token,
 * Hide is local (no request), Leader questions answered in a sheet, swipes
 * start the same actions, and nothing actionable shows when the device
 * cannot act.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseActivitySources } from '../../../../../core/verse/workbench-types.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetGuard } from '../../shell/guard-store.js';
import { resetResolvedForTest } from '../../shell/resolved-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from '../mobile-toast.js';
import {
  activityResponse,
  activityState,
  json,
  needsItem,
  permissionsFor,
  renderMobile,
  stubFetch,
  TOKEN,
} from '../mobile.test-support.js';
import { consequenceLine, destructiveAction, macOnlyRemoteAction, NeedsYouScreen, primaryAction, resetHiddenForTest } from './NeedsYouScreen.js';

function Harness() {
  return (
    <>
      <NeedsYouScreen />
      <MobileGuardSheet />
      <MobileToasts />
    </>
  );
}

const approval = needsItem();

const leaderQuestion = needsItem({
  id: 'leader:leader-question:memo-1:0',
  source: 'leader',
  kind: 'leader-question',
  severity: 'info',
  title: 'Leader question: Keep measurably on local enforcement?',
  detail: 'Keep measurably on local enforcement, or move it to propose-only until it has CI?',
  subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
  target: { kind: 'section', section: 'command', anchor: 'leader' },
  actions: [
    { kind: 'fix', label: 'Answer', request: null, confirm: null, destructive: false },
    { kind: 'done', label: 'Dismiss', request: { method: 'POST', path: '/api/verse/leader', body: { action: 'dismiss' } }, confirm: null, destructive: false },
  ],
});

const failedChat = needsItem({
  id: 'chats:chat-failed:s9',
  source: 'chats',
  kind: 'chat-failed',
  severity: 'warn',
  title: 'Failed: migrate the store',
  detail: null,
  target: { kind: 'session', sessionId: 's9' },
  actions: [{ kind: 'done', label: 'Mark read', request: { method: 'POST', path: '/api/verse/sessions/s9/read', body: {} }, confirm: null, destructive: false }],
});

function withItems(items = [approval], sources?: VerseActivitySources) {
  return activityState(activityResponse({ needsYou: items, ...(sources ? { sources } : {}) }));
}

beforeEach(() => {
  setMutationToken(TOKEN);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetResolvedForTest();
  resetHiddenForTest();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

it('labels local authority actions Mac-only on a paired remote phone', () => {
  window.history.replaceState(null, '', '/verse/m/');
  document.head.innerHTML = '<meta name="ashlr-remote-gateway" content="v1">';
  const item = needsItem({ kind: 'kill', actions: [{ kind: 'resume', label: 'Clear Stop', request: { method: 'POST', path: '/api/verse/authority/clear-stop', body: {} }, confirm: null, destructive: false }] });
  expect(macOnlyRemoteAction(item, item.actions[0]!)).toBe(true);
  renderMobile(<NeedsYouScreen />, { activity: withItems([item]), permissions: permissionsFor('unlocked') });
  expect(screen.getByText('Authority changes for this item are available on your Mac.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Clear Stop/ })).not.toBeInTheDocument();
});

describe('NeedsYouScreen — states', () => {
  it('shows a skeleton while the first poll is out', () => {
    renderMobile(<NeedsYouScreen />, { activity: activityState(null, 'loading') });
    expect(screen.getByRole('status', { name: 'Loading what needs you' })).toBeInTheDocument();
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });

  it('says All clear only when every source answered', () => {
    renderMobile(<NeedsYouScreen />, { activity: withItems([]) });
    expect(screen.getByText('All clear')).toBeInTheDocument();
  });

  it('never says All clear when a source is silent — it names which', () => {
    renderMobile(<NeedsYouScreen />, {
      activity: withItems([], { approvals: 'ok', authority: 'ok', fleet: 'error', leader: 'ok', chats: 'ok', accounts: 'unavailable' }),
    });
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(screen.getByText(/The fleet failed to answer and account health isn't reporting/)).toBeInTheDocument();
  });

  it('shows the server’s reason and retries when activity failed', async () => {
    const { context } = renderMobile(<NeedsYouScreen />, { activity: activityState(null, 'unavailable', 'The activity route timed out.') });
    expect(screen.getByRole('alert')).toHaveTextContent('The activity route timed out.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(context.refreshActivity).toHaveBeenCalled();
  });

  it('keeps the last list when the Mac is unreachable, with a banner, and turns Mac actions off', () => {
    renderMobile(<NeedsYouScreen />, { activity: { ...withItems(), status: 'stale' }, reachability: 'unreachable' });
    expect(screen.getByText(/Can’t reach your Mac/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'fix the flaky snapshot test' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve: fix the flaky snapshot test' })).toBeDisabled();
    // Hiding is local, so it still works.
    expect(screen.getByRole('button', { name: 'Hide on this phone: fix the flaky snapshot test' })).toBeEnabled();
  });

  it('hides every action and says why when the device cannot act', () => {
    renderMobile(<NeedsYouScreen />, { activity: withItems([approval, leaderQuestion]), permissions: permissionsFor('unavailable') });
    expect(screen.getByText('Your Mac started Verse without dispatch.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Reject/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Answer/ })).not.toBeInTheDocument();
  });

  it('filters by split with counts', async () => {
    renderMobile(<NeedsYouScreen />, { activity: withItems([approval, leaderQuestion, failedChat]) });
    expect(screen.getByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Chats 1' }));
    expect(screen.getByRole('heading', { name: /migrate the store/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'fix the flaky snapshot test' })).not.toBeInTheDocument();
  });
});

describe('NeedsYouScreen — actions', () => {
  it('approve confirms first, then POSTs the item’s route with the token, then the card goes', async () => {
    const stub = stubFetch({ 'POST /api/inbox/p1/approve': { ok: true } });
    renderMobile(<Harness />, { activity: withItems() });
    expect(screen.getByText('Review before applying.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Approve: fix the flaky snapshot test' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Approve this?' });
    expect(stub.posts()).toHaveLength(0);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    const [post] = stub.posts();
    expect(post!.url).toBe('/api/inbox/p1/approve');
    expect(post!.headers['x-ashlr-token']).toBe(TOKEN);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'fix the flaky snapshot test' })).not.toBeInTheDocument());
  });

  it('asks for the token after the confirmation when it is not held', async () => {
    clearMutationToken();
    const stub = stubFetch({ 'POST /api/inbox/p1/reject': { ok: true } });
    renderMobile(<Harness />, { activity: withItems(), permissions: permissionsFor('locked') });
    await userEvent.click(screen.getByRole('button', { name: 'Reject: fix the flaky snapshot test' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reject' }));
    expect(await screen.findByRole('dialog', { name: 'Unlock actions' })).toBeInTheDocument();
    expect(stub.posts()).toHaveLength(0);
  });

  it('Hide hides on this phone only — no request — and Undo brings it back', async () => {
    const stub = stubFetch({});
    renderMobile(<Harness />, { activity: withItems() });
    await userEvent.click(screen.getByRole('button', { name: 'Hide on this phone: fix the flaky snapshot test' }));
    expect(screen.queryByRole('heading', { name: 'fix the flaky snapshot test' })).not.toBeInTheDocument();
    expect(screen.getByText('Hidden on this phone. It stays on your Mac.')).toBeInTheDocument();
    // Not "All clear": something is only hidden here.
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
    expect(screen.getByText(/1 hidden on this phone/)).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Undo hide: fix the flaky snapshot test' }));
    expect(screen.getByRole('heading', { name: 'fix the flaky snapshot test' })).toBeInTheDocument();
  });

  it('answers a Leader question in a sheet and posts to its answer route', async () => {
    const stub = stubFetch({
      'POST /api/verse/leader/questions/memo-1:0/answer': json({ message: { id: 'lt-1', at: '2026-09-27T12:00:00Z', from: 'mason', channel: 'verse', kind: 'answer', text: 'Stay local.' }, reply: null }),
    });
    const { context } = renderMobile(<Harness />, { activity: withItems([leaderQuestion]) });
    expect(screen.getByText(/Sends your answer to the Leader/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^Answer:/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Answer the Leader' });
    expect(within(sheet).getByText(/move it to propose-only until it has CI/)).toBeInTheDocument();
    await userEvent.type(within(sheet).getByLabelText('Your answer'), 'Stay local.');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(stub.posts()).toHaveLength(1));
    const [post] = stub.posts();
    expect(post!.url).toBe('/api/verse/leader/questions/memo-1:0/answer');
    expect(post!.body).toEqual({ text: 'Stay local.' });
    expect(post!.headers['x-ashlr-token']).toBe(TOKEN);
    await waitFor(() => expect(context.refreshActivity).toHaveBeenCalled());
    expect(await screen.findByText('Answer sent to the Leader')).toBeInTheDocument();
  });

  it('keeps the answer and reopens the sheet when the send fails', async () => {
    stubFetch({ 'POST /api/verse/leader/questions/memo-1:0/answer': json({ error: 'The Leader is busy.' }, 500) });
    renderMobile(<Harness />, { activity: withItems([leaderQuestion]) });
    await userEvent.click(screen.getByRole('button', { name: /^Answer:/ }));
    await userEvent.type(screen.getByLabelText('Your answer'), 'Stay local.');
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    const sheet = await screen.findByRole('dialog', { name: 'Answer the Leader' });
    expect(within(sheet).getByLabelText('Your answer')).toHaveValue('Stay local.');
  });

  it('opens a session target on the phone', async () => {
    const { context } = renderMobile(<NeedsYouScreen />, { activity: withItems([failedChat]) });
    await userEvent.click(screen.getByRole('button', { name: /^Open chat:/ }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'agent', id: 's9', pane: 'transcript' });
  });
});

describe('NeedsYouScreen — swipe', () => {
  // jsdom has no PointerEvent; without one testing-library drops clientX.
  const hadPointerEvent = 'PointerEvent' in window;
  beforeEach(() => {
    if (hadPointerEvent) return;
    class PointerEventStub extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: PointerEventStub });
  });
  afterEach(() => {
    if (!hadPointerEvent) delete (window as { PointerEvent?: unknown }).PointerEvent;
  });

  function swipe(el: HTMLElement, dx: number) {
    Object.defineProperty(el, 'offsetWidth', { configurable: true, value: 300 });
    fireEvent.pointerDown(el, { pointerId: 1, clientX: 150, clientY: 100, button: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 150 + dx / 2, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 150 + dx, clientY: 100 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: 150 + dx, clientY: 100 });
  }

  const card = () => screen.getByRole('article', { name: 'fix the flaky snapshot test' });

  it('swipe right starts the primary action — which still confirms', async () => {
    const stub = stubFetch({});
    renderMobile(<Harness />, { activity: withItems() });
    act(() => swipe(card(), 140));
    expect(await screen.findByRole('alertdialog', { name: 'Approve this?' })).toBeInTheDocument();
    expect(stub.posts()).toHaveLength(0);
  });

  it('swipe left starts reject; a short swipe does nothing', async () => {
    stubFetch({});
    renderMobile(<Harness />, { activity: withItems() });
    act(() => swipe(card(), -40));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    act(() => swipe(card(), -140));
    expect(await screen.findByRole('alertdialog', { name: 'Reject this?' })).toBeInTheDocument();
  });

  it('swipe left hides an item with nothing to say no to', () => {
    renderMobile(<NeedsYouScreen />, { activity: withItems([failedChat]) });
    act(() => swipe(screen.getByRole('article', { name: /migrate the store/ }), -140));
    expect(screen.queryByRole('article', { name: /migrate the store/ })).not.toBeInTheDocument();
  });

  it('has no swipe under reduced motion (the buttons remain)', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener: () => undefined, removeEventListener: () => undefined }));
    renderMobile(<Harness />, { activity: withItems() });
    act(() => swipe(card(), 140));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve: fix the flaky snapshot test' })).toBeInTheDocument();
  });
});

describe('NeedsYouScreen — model', () => {
  it('picks the primary and the destructive action by kind, not paint', () => {
    expect(primaryAction(approval)?.kind).toBe('approve');
    expect(destructiveAction(approval)?.kind).toBe('reject');
    expect(destructiveAction(failedChat)).toBeNull();
  });

  it('says what the primary action will do', () => {
    const ownerLane = needsItem({ kind: 'owner-lane-pr' });
    expect(consequenceLine(ownerLane, primaryAction(ownerLane)!)).toBe('Merges the PR on GitHub. This can’t be undone from the phone.');
    const withCopy = needsItem({
      actions: [{ kind: 'approve', label: 'Land', request: { method: 'POST', path: '/api/x', body: {} }, confirm: { title: 'Land?', body: 'Squash-merges exactly abc1234 into main.', confirmLabel: 'Land' }, destructive: false }],
    });
    expect(consequenceLine(withCopy, withCopy.actions[0]!)).toBe('Squash-merges exactly abc1234 into main.');
  });
});
