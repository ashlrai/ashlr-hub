/**
 * Every way into the Leader conversation that is not Mind itself:
 *   ⌘K "Message the Leader…" / "Add Leader directive…" (catalog → shell handler → leader-focus);
 *   Command's Leader card line (latest message + "Message the Leader…");
 *   a Needs-you Leader question's "Answer" (the item's own actions stay Dismiss-only);
 *   and Mind itself: the conversation is its first card, lazily loaded.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { isNeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useSurfaceActions } from '../command/actions.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { leaderState } from '../command/fixtures.test-support.js';
import { LeaderCard } from '../command/LeaderCard.js';
import { MockEventSource } from '../fixtures.test-support.js';
import { MindSection } from '../sections/MindSection.js';
import { findCommand } from '../shell/command-catalog.js';
import { resetCommandBus } from '../shell/command-bus.js';
import { GuardHost, resetGuard } from '../shell/guarded-action.js';
import { resetResolvedForTest } from '../shell/needs-you-actions.js';
import { NeedsYouDrawer } from '../shell/NeedsYouDrawer.js';
import { buildPaletteItems, commandItem } from '../shell/palette-model.js';
import { executeCatalogCommand, registerShellCommandHandlers } from '../shell/run-command.js';
import { activity, shellFetch, vetoNeed } from '../shell/shell-fixtures.test-support.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { mockWideViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { useVerseUi } from '../useVerseUi.js';
import { getVerseUiState, openVerseNeedsYou, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { getLeaderFocus, resetLeaderFocus } from './leader-focus.js';
import { msg, QUESTION_TEXT, threadMessages } from './thread-fixtures.test-support.js';

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetLeaderFocus();
  clearMutationToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('⌘K', () => {
  let off: (() => void) | null = null;
  beforeEach(() => {
    resetCommandBus();
    off = registerShellCommandHandlers();
  });
  afterEach(() => off?.());

  it('lists "Message the Leader…" and "Add Leader directive…" as actions that run on Mind, with no key', () => {
    for (const [id, title] of [
      ['leader.message', 'Message the Leader…'],
      ['leader.directive', 'Add Leader directive…'],
    ] as const) {
      const c = findCommand(id)!;
      expect(c.title).toBe(title);
      expect(c.group).toBe('actions');
      expect(c.keys).toEqual([]);
      expect(commandItem(c, 'mac', 'actions').subtitle).toBe('on Mind');
    }
    const items = buildPaletteItems({ needsYou: [], running: [], sessions: [], seats: [], projects: [], recentActions: [], platform: 'mac' });
    expect(items.map((i) => i.title)).toEqual(expect.arrayContaining(['Message the Leader…', 'Add Leader directive…']));
  });

  it('"Message the Leader…" goes to Mind and asks the panel for its composer', async () => {
    setVerseSection('fleet');
    expect(executeCatalogCommand('leader.message', { via: 'palette' })).toBe(true);
    await waitFor(() => expect(getLeaderFocus()?.kind).toBe('composer'));
    expect(getVerseUiState().section).toBe('mind');
  });

  it('"Add Leader directive…" asks the panel for its directive box', async () => {
    expect(executeCatalogCommand('leader.directive', { via: 'palette' })).toBe(true);
    await waitFor(() => expect(getLeaderFocus()?.kind).toBe('directive'));
    expect(getVerseUiState().section).toBe('mind');
  });
});

function LeaderCardHarness() {
  const actions = useSurfaceActions();
  return <LeaderCard read={{ value: leaderState('live'), available: true, reason: null }} loading={false} actions={actions} />;
}

describe('Command’s Leader card', () => {
  it('previews the Leader’s latest message and opens the composer on Mind', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': { messages: [...threadMessages(), msg({ id: 'z', at: new Date().toISOString(), channel: 'telegram', text: '**Lanes** raised. See [memo](https://x).' })] } } });
    render(<LeaderCardHarness />);
    const preview = await screen.findByLabelText("The Leader's latest message");
    expect(preview).toHaveTextContent('Leader · Telegram');
    expect(preview).toHaveTextContent('Lanes raised. See memo.');
    await userEvent.click(screen.getByRole('button', { name: /Message the Leader…/ }));
    expect(getLeaderFocus()?.kind).toBe('composer');
    expect(getVerseUiState().section).toBe('mind');
  });

  it('keeps the button, and drops the preview, when the conversation route is absent', async () => {
    stubSurfaceFetch({ routes: { '/api/verse/leader/thread': null } });
    render(<LeaderCardHarness />);
    expect(await screen.findByRole('button', { name: /Message the Leader…/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("The Leader's latest message")).toBeNull();
  });
});

function questionNeed(): NeedsYouItem {
  const item: NeedsYouItem = {
    id: 'leader:leader-question:memo-0924:0',
    source: 'leader',
    kind: 'leader-question',
    severity: 'info',
    title: `Leader question: ${QUESTION_TEXT}`,
    detail: null,
    since: new Date().toISOString(),
    expiresAt: null,
    subject: { repo: null, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'mind', anchor: 'memo-0924' },
    actions: [{ kind: 'done', label: 'Dismiss', request: { method: 'POST', path: '/api/verse/leader', body: { action: 'dismiss', itemId: 'leader:leader-question:memo-0924:0' } }, confirm: null, destructive: false }],
  };
  if (!isNeedsYouItem(item)) throw new Error('fixture is not a valid NeedsYouItem');
  return item;
}

function DrawerHarness() {
  const ui = useVerseUi();
  return (
    <>
      {ui.overlay === 'needs-you' ? <NeedsYouDrawer /> : null}
      <GuardHost />
    </>
  );
}

describe('Needs-you', () => {
  beforeEach(() => {
    resetGuard();
    resetResolvedForTest();
    MockEventSource.reset();
    vi.stubGlobal('EventSource', MockEventSource);
    markCheckComplete(true);
  });
  afterEach(() => {
    act(() => markCheckComplete(false));
    resetActivityForTest();
  });

  it('a Leader question offers "Answer", which closes the drawer and opens that question in Mind — Dismiss stays its only action', async () => {
    const net = shellFetch(activity({ needsYou: [questionNeed(), vetoNeed()] }));
    vi.stubGlobal('fetch', net.fetch);
    resetActivityForTest();
    render(
      <ToastProvider>
        <DrawerHarness />
      </ToastProvider>,
    );
    act(() => openVerseNeedsYou({ split: 'all', focusId: 'leader:leader-question:memo-0924:0' }));
    const drawer = await screen.findByRole('dialog', { name: /Needs you/ });
    const detail = await within(drawer).findByRole('article');
    expect(within(detail).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    await userEvent.click(within(detail).getByRole('button', { name: 'Answer' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Needs you/ })).toBeNull());
    expect(getVerseUiState().section).toBe('mind');
    expect(getLeaderFocus()).toMatchObject({ kind: 'question', questionId: 'leader:leader-question:memo-0924:0', memoId: 'memo-0924', index: 0, text: QUESTION_TEXT });
  });

  it('other rows get no Answer button', async () => {
    const net = shellFetch(activity({ needsYou: [vetoNeed()] }));
    vi.stubGlobal('fetch', net.fetch);
    resetActivityForTest();
    render(
      <ToastProvider>
        <DrawerHarness />
      </ToastProvider>,
    );
    act(() => openVerseNeedsYou({ split: 'all', focusId: 'leader:veto-window:m-7' }));
    const drawer = await screen.findByRole('dialog', { name: /Needs you/ });
    await within(drawer).findByRole('article');
    expect(within(drawer).queryByRole('button', { name: 'Answer' })).toBeNull();
  });
});

describe('Mind', () => {
  let vp: ViewportMock | null = null;
  beforeEach(() => {
    vp = mockWideViewport();
  });
  afterEach(() => vp?.restore());

  it('puts the conversation first and keeps the memo timeline, hit rate and action log below it', async () => {
    stubSurfaceFetch({ kind: 'live', routes: { '/api/verse/leader/thread': { messages: threadMessages() }, '/api/verse/leader/directives': { directives: [] } } });
    render(<MindSection />);
    const panel = await screen.findByTestId('leader-conversation');
    await within(panel).findByText('Status?');
    const memos = await screen.findByRole('region', { name: 'Memos' });
    // Document order: the conversation, then the rest of Mind.
    expect(panel.compareDocumentPosition(memos) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Action log' })).toBeInTheDocument();
  });

  it('still talks when the Leader has never run (the dormant state stays below)', async () => {
    stubSurfaceFetch({ kind: 'dark', routes: { '/api/verse/leader/thread': { messages: [] }, '/api/verse/leader/directives': { directives: [] } } });
    render(<MindSection />);
    const panel = await screen.findByTestId('leader-conversation');
    await within(panel).findByText('No conversation yet');
    expect(within(panel).getByRole('textbox', { name: 'Message the Leader' })).toBeEnabled();
    await waitFor(() => expect(screen.getByTestId('autonomy-off')).toBeInTheDocument());
  });
});
