/**
 * The phone's Agents tab: chats grouped Working / Needs you / Review / Done
 * behind a chip row (the workbench's own board model), the default chip is
 * the first non-empty column, a row opens the agent, and loading / empty /
 * error / offline / read-only all say what is going on.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseSession } from '../../../../data/api-types.js';
import { clearMutationToken, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import type { SidebarRow } from '../../chat/sidebar-model.js';
import { resetLocalSeen } from '../../chat/use-chat-activity.js';
import { bootstrap, MockEventSource, session } from '../../fixtures.test-support.js';
import { resetGuard } from '../../shell/guard-store.js';
import { activityResponse, json, needsItem, permissionsFor, renderMobile, runningRow, stubFetch, TOKEN } from '../mobile.test-support.js';
import { agentBadge, agentStatusLine, AgentsScreen, defaultColumn } from './AgentsScreen.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');

const running = session({ id: 'run1', title: 'Fix the flaky snapshot test', status: 'running', updatedAt: '2026-09-27T11:59:00Z' });
const failed = session({ id: 'fail1', title: 'Migrate the config', status: 'error', updatedAt: '2026-09-27T11:00:00Z' });
const unread = session({ id: 'new1', title: 'Write the release notes', turnCount: 3, updatedAt: '2026-09-27T10:00:00Z', projectPath: '/Users/mason/dev/site' });
const done = session({ id: 'done1', title: '', turnCount: 2, updatedAt: '2026-09-26T10:00:00Z' });

function routes(over: Record<string, unknown> = {}, sessions: VerseSession[] = [running, failed, unread, done]) {
  return stubFetch({
    'GET /api/verse/sessions': sessions,
    'GET /api/verse/bootstrap': bootstrap({ sessions }),
    'GET /api/verse/activity': activityResponse({
      running: [runningRow({ sessionId: 'run1', startedAt: '2026-09-27T11:57:00Z', live: { phase: 'tool', tool: 'Edit', elapsedMs: 180_000, thinkingTail: null } })],
    }),
    'GET /api/verse/session-meta': { sessions: { new1: { sessionId: 'new1', pinned: false, archived: false, seenTurnCount: 1 }, done1: { sessionId: 'done1', pinned: false, archived: false, seenTurnCount: 2 } } },
    ...over,
  });
}

beforeEach(() => {
  setMutationToken(TOKEN);
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
});

afterEach(() => {
  clearMutationToken();
  evictAll();
  resetGuard();
  resetLocalSeen();
  vi.unstubAllGlobals();
});

describe('AgentsScreen — the board', () => {
  it('groups every chat into four chips and opens Working first', async () => {
    routes();
    renderMobile(<AgentsScreen />);
    const chips = await screen.findByRole('group', { name: 'Show agents' });
    await waitFor(() => expect(within(chips).getByRole('button', { name: 'Working 1' })).toHaveAttribute('aria-pressed', 'true'));
    expect(within(chips).getByRole('button', { name: 'Needs you 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(chips).getByRole('button', { name: 'Review 1' })).toBeInTheDocument();
    expect(within(chips).getByRole('button', { name: 'Done 1' })).toBeInTheDocument();

    const row = screen.getByRole('button', { name: /Fix the flaky snapshot test/ });
    expect(row).toHaveTextContent('Claude Max · Opus 5 · hub');
    expect(row).toHaveTextContent(/Using Edit · \d+(m|h)/);
    expect(row).toHaveTextContent('Working');
    expect(screen.queryByText('Migrate the config')).not.toBeInTheDocument();
  });

  it('filters to one column per chip and says why each chat is there', async () => {
    const user = userEvent.setup();
    routes();
    renderMobile(<AgentsScreen />);
    await screen.findByRole('button', { name: /Fix the flaky snapshot test/ });

    await user.click(screen.getByRole('button', { name: 'Needs you 1' }));
    const failedRow = screen.getByRole('button', { name: /Migrate the config/ });
    expect(failedRow).toHaveTextContent('Failed');
    expect(screen.queryByText('Fix the flaky snapshot test')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Review 1' }));
    const reviewRow = screen.getByRole('button', { name: /Write the release notes/ });
    expect(reviewRow).toHaveTextContent('2 new turns');
    expect(reviewRow).toHaveTextContent('site');

    await user.click(screen.getByRole('button', { name: 'Done 1' }));
    expect(screen.getByRole('button', { name: /Untitled chat/ })).toHaveTextContent('Done');
  });

  it('opens the agent on tap', async () => {
    const user = userEvent.setup();
    routes();
    const { context } = renderMobile(<AgentsScreen />);
    await user.click(await screen.findByRole('button', { name: /Fix the flaky snapshot test/ }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'agent', id: 'run1', pane: 'transcript' });
  });

  it('defaults to Needs you when nothing is running', async () => {
    routes({ 'GET /api/verse/activity': activityResponse({ needsYou: [needsItem({ subject: { repo: null, pr: null, seatId: null, sessionId: 'new1', engine: 'claude' } })] }) }, [failed, unread]);
    renderMobile(<AgentsScreen />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Needs you 2' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.getByRole('button', { name: 'Working 0' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('+ New opens the new-agent screen', async () => {
    const user = userEvent.setup();
    routes();
    const { context } = renderMobile(<AgentsScreen />);
    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'new' });
  });
});

describe('AgentsScreen — states', () => {
  it('shows a list-shaped skeleton while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderMobile(<AgentsScreen />);
    expect(screen.getByRole('status', { name: 'Loading agents' })).toBeInTheDocument();
  });

  it('empty: says what would appear and offers to start one', async () => {
    const user = userEvent.setup();
    routes({}, []);
    const { context } = renderMobile(<AgentsScreen />);
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ New agent' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'new' });
  });

  it('error: the server’s reason and Try again', async () => {
    const user = userEvent.setup();
    let fail = true;
    routes({
      'GET /api/verse/sessions': () => (fail ? json({ error: 'The chat engine is not answering.' }, 503) : [running]),
      'GET /api/verse/bootstrap': json({ error: 'down' }, 503),
    });
    renderMobile(<AgentsScreen />);
    expect(await screen.findByText('The chat engine is not answering.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Fix the flaky snapshot test/ })).toBeInTheDocument();
  });

  it('offline: keeps the last list, says so, and disables starting an agent', async () => {
    routes();
    renderMobile(<AgentsScreen />, { reachability: 'offline' });
    expect(await screen.findByRole('button', { name: /Fix the flaky snapshot test/ })).toBeInTheDocument();
    expect(screen.getByText(/You’re offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled();
  });

  it('hides + New when this device cannot act', async () => {
    routes({}, []);
    renderMobile(<AgentsScreen />, { permissions: permissionsFor('unavailable') });
    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ New agent' })).not.toBeInTheDocument();
  });

  it('keeps + New visible when actions are merely locked', async () => {
    clearMutationToken();
    routes();
    renderMobile(<AgentsScreen />, { permissions: permissionsFor('locked') });
    expect(await screen.findByRole('button', { name: 'New agent' })).toBeEnabled();
  });
});

describe('agentStatusLine / agentBadge / defaultColumn', () => {
  const row = (over: Partial<SidebarRow>): SidebarRow => ({ session: session(), status: { kind: 'time', at: '2026-09-27T11:55:00Z' }, live: null, pinned: false, archived: false, needsYou: false, ...over });

  it('describes each status in a few words', () => {
    expect(agentStatusLine(row({ status: { kind: 'running', startedAt: '2026-09-27T11:57:00Z' }, live: { text: 'Edit', startedAt: null } }), runningRow(), NOW)).toBe('Using Edit · 3m');
    expect(agentStatusLine(row({ status: { kind: 'running', startedAt: null }, live: { text: 'Thinking', startedAt: null } }), undefined, NOW)).toBe('Thinking');
    expect(agentStatusLine(row({ status: { kind: 'failed' } }), undefined, NOW)).toBe('Failed');
    expect(agentStatusLine(row({ status: { kind: 'unread', newTurns: 1 } }), undefined, NOW)).toBe('1 new turn');
    expect(agentStatusLine(row({}), undefined, NOW)).toBe('5m ago');
    expect(agentStatusLine(row({ needsYou: true }), undefined, NOW)).toBe('Waiting on you');
    expect(agentStatusLine(row({ status: { kind: 'time', at: 'garbage' } }), undefined, NOW)).toBe('unknown');
  });

  it('badges by column', () => {
    expect(agentBadge(row({ status: { kind: 'failed' } }), 'needs-you')).toMatchObject({ tone: 'danger', label: 'Failed' });
    expect(agentBadge(row({ needsYou: true }), 'needs-you')).toMatchObject({ tone: 'warning', label: 'Needs you' });
    expect(agentBadge(row({}), 'working')).toMatchObject({ tone: 'running', pulse: true });
  });

  it('picks the first non-empty column, in order', () => {
    expect(defaultColumn({ working: 0, 'needs-you': 0, review: 2, done: 5 })).toBe('review');
    expect(defaultColumn({ working: 0, 'needs-you': 0, review: 0, done: 0 })).toBeNull();
  });
});
