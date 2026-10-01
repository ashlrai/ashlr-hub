/**
 * The Agents board (3.16) against a stubbed server: four columns with each
 * card's seat, repo/branch, spend and reason; keyboard movement across and
 * within columns; "Mark all read" never sending a Needs-you card; bulk
 * selection; the ⌘N / ⇧⌘N hand-off opening New agent; the one-action spawn
 * (workspace → chat → bind); plan approval with the operator's edits.
 * Plus the pure model (movement, filters, labels, the spawn form).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentBoardResponse, AgentCard } from '../../../../core/verse/agents/types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { CLAUDE_SEAT, CODEX_SEAT, installFetch, json, TEST_TOKEN, type RecordedCall } from '../context/context-fixtures.test-support.js';
import { resetVerseUi } from '../verse-ui-store.js';
import { AgentsBoard } from './AgentsBoard.js';
import { requestAgentsFocus } from './agents-focus.js';
import {
  checkSpawnForm,
  DEFAULT_FILTER,
  elapsedLabel,
  filterCards,
  groupByColumn,
  markReadTargets,
  moveCursor,
  spendLabel,
  titleFromPrompt,
} from './agents-model.js';

const NOW = Date.parse('2026-09-27T12:00:00Z');

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    id: 'ag_aaaaaaaaaaaaaaaa',
    agentId: 'ag_aaaaaaaaaaaaaaaa',
    sessionId: 'vs_a',
    title: 'Fix login',
    column: 'working',
    reason: 'running',
    reasonText: 'Working',
    seatId: 'claude',
    engine: 'claude',
    model: 'claude-sonnet-5',
    repo: 'app',
    branch: 'verse/fix-login',
    workspacePath: '~/.ashlr-worktrees/app/fix-login',
    status: 'running',
    unread: false,
    pinned: false,
    createdAt: '2026-09-27T11:00:00Z',
    updatedAt: '2026-09-27T11:59:00Z',
    startedAt: '2026-09-27T11:58:00Z',
    lastActivity: 'Running npm test',
    turnCount: 1,
    spend: { usd: 1.24, capUsd: 5, fraction: 0.248, tokens: 100_000 },
    checks: null,
    autoFix: false,
    autoMerge: false,
    plan: null,
    ports: { base: 41000, count: 10 },
    runScripts: ['Dev'],
    scripts: [],
    loopNote: null,
    heldPrompt: false,
    archived: false,
    restorable: false,
    ...over,
  };
}

const CARDS: AgentCard[] = [
  card(),
  card({ id: 'ag_bbbbbbbbbbbbbbbb', agentId: 'ag_bbbbbbbbbbbbbbbb', sessionId: 'vs_b', title: 'Plan the refactor', column: 'needs-you', reason: 'plan-ready', reasonText: 'Plan ready for your approval', status: 'idle', unread: true, startedAt: null, plan: { enabled: true, state: 'awaiting-approval', text: '1. Split module', turn: 0 } }),
  card({ id: 'chat:vs_c', agentId: null, sessionId: 'vs_c', title: 'Docs question', column: 'review', reason: 'unread', reasonText: 'Finished — unread', status: 'idle', unread: true, startedAt: null, repo: 'site', branch: null, engine: 'codex', model: 'gpt-6', spend: { usd: null, capUsd: null, fraction: null, tokens: 12_400 } }),
  card({ id: 'chat:vs_d', agentId: null, sessionId: 'vs_d', title: 'Old chat', column: 'done', reason: 'idle', reasonText: 'Idle', status: 'idle', startedAt: null }),
];

function board(cards = CARDS): AgentBoardResponse {
  const counts = { working: 0, 'needs-you': 0, review: 0, done: 0 };
  for (const c of cards) counts[c.column] += 1;
  return { generatedAt: new Date(NOW).toISOString(), cards, counts, cap: 25, liveWorkspaces: 2, supervisor: true };
}

function server(onPost?: (c: RecordedCall) => Response | undefined) {
  return installFetch((call) => {
    if (call.method === 'POST') {
      const res = onPost?.(call);
      if (res) return res;
    }
    if (call.path === '/api/verse/agents' && call.method === 'GET') return json(board());
    if (call.path.startsWith('/api/verse/bootstrap')) {
      return json({ seats: [CLAUDE_SEAT, CODEX_SEAT], projects: [{ path: '/Users/x/code/app', name: 'app', enrolled: true }], sessions: [], dispatchEnabled: true, localRuntime: { available: false } });
    }
    if (call.path.startsWith('/api/verse/agents/config')) return json({ config: { setup: 'npm ci', run: [], archive: null, copy: ['.env'], ports: 10 }, source: 'file', warnings: [] });
    if (call.path === '/api/verse/agents/bulk') return json({ results: ((call.body as { ids: string[] }).ids).map((id) => ({ id, ok: true })) });
    return json({ error: 'not found' }, 404);
  });
}

beforeEach(() => {
  evictAll();
  resetVerseUi();
  setMutationToken(TEST_TOKEN);
});

afterEach(() => {
  clearMutationToken();
  vi.unstubAllGlobals();
});

describe('agents-model', () => {
  const cols = groupByColumn(CARDS);

  it('moves within a column and across non-empty columns, clamping the row', () => {
    expect(moveCursor(cols, null, 'down')).toEqual({ column: 'working', index: 0 });
    expect(moveCursor(cols, { column: 'working', index: 0 }, 'right')).toEqual({ column: 'needs-you', index: 0 });
    expect(moveCursor(cols, { column: 'done', index: 0 }, 'right')).toEqual({ column: 'done', index: 0 });
    expect(moveCursor(cols, { column: 'working', index: 0 }, 'up')).toEqual({ column: 'working', index: 0 });
    const sparse = groupByColumn([CARDS[0]!, CARDS[3]!]);
    expect(moveCursor(sparse, { column: 'working', index: 0 }, 'right')).toEqual({ column: 'done', index: 0 });
  });

  it('never targets a Needs-you card for "mark read"', () => {
    expect(markReadTargets(CARDS)).toEqual(['chat:vs_c']);
    expect(markReadTargets(CARDS, new Set(['ag_bbbbbbbbbbbbbbbb']))).toEqual([]);
  });

  it('filters by repo, text and stale Done cards', () => {
    expect(filterCards(CARDS, { ...DEFAULT_FILTER, repo: 'site' }, NOW).map((c) => c.id)).toEqual(['chat:vs_c']);
    expect(filterCards(CARDS, { ...DEFAULT_FILTER, query: 'refactor' }, NOW).map((c) => c.id)).toEqual(['ag_bbbbbbbbbbbbbbbb']);
    expect(filterCards(CARDS, DEFAULT_FILTER, NOW + 10 * 86_400_000).some((c) => c.column === 'done')).toBe(false);
  });

  it('words time and spend, and validates the spawn form', () => {
    expect(elapsedLabel('2026-09-27T11:58:00Z', NOW)).toBe('2m 00s');
    expect(spendLabel(CARDS[0]!.spend)).toBe('$1.24 of $5.00');
    expect(spendLabel(CARDS[2]!.spend)).toBe('12k tokens');
    const form = { root: '/r', title: '', prompt: 'Fix it', seats: [{ seatId: 'claude', model: 'm' }], isolate: true, planFirst: false, capText: '', autoFix: false, autoMerge: false };
    expect(checkSpawnForm(form)).toEqual({ ok: true, cap: null });
    expect(checkSpawnForm({ ...form, capText: '$7.5' })).toEqual({ ok: true, cap: 7.5 });
    expect(checkSpawnForm({ ...form, capText: 'lots' }).ok).toBe(false);
    expect(checkSpawnForm({ ...form, prompt: ' ' }).ok).toBe(false);
    expect(checkSpawnForm({ ...form, isolate: false, seats: [...form.seats, { seatId: 'codex', model: 'g' }] }).ok).toBe(false);
    expect(checkSpawnForm({ ...form, isolate: false, autoMerge: true }).ok).toBe(false);
    // Available seats, workspace admission and provider capacity govern fan-out;
    // a fixed UI count must not reject an otherwise valid isolated task.
    const manySeats = Array.from({ length: 32 }, (_, i) => ({ seatId: `seat-${i}`, model: 'm' }));
    expect(checkSpawnForm({ ...form, seats: manySeats })).toEqual({ ok: true, cap: null });
    expect(checkSpawnForm({ ...form, seats: manySeats, isolate: false }).ok).toBe(false);
    expect(titleFromPrompt('## Fix the **login** redirect\nmore')).toBe('Fix the login redirect');
  });
});

describe('<AgentsBoard>', () => {
  it('draws four columns of cards with seat, branch, reason and spend', async () => {
    server();
    render(<AgentsBoard />);
    const working = await screen.findByRole('region', { name: /^Working, 1/ });
    const c = within(working).getByRole('button', { name: /Fix login/ });
    expect(within(c).getByText('Claude · claude-sonnet-5')).toBeTruthy();
    expect(within(c).getByText('app · verse/fix-login')).toBeTruthy();
    expect(within(c).getByText('$1.24 of $5.00')).toBeTruthy();
    expect(within(c).getByText('Running npm test')).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Needs you, 1/ })).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Ready for review, 1/ })).toBeTruthy();
    expect(screen.getByText(/1 working · 1 need you · 1 ready for review · 2 of 25 workspaces/)).toBeTruthy();
  });

  it('moves with the arrow keys and opens details with Space', async () => {
    server();
    render(<AgentsBoard />);
    const first = await screen.findByRole('button', { name: /Fix login/ });
    first.focus();
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    const planCard = screen.getByRole('button', { name: /Plan the refactor/ });
    await waitFor(() => expect(planCard.getAttribute('data-active')).toBe('true'));
    fireEvent.keyDown(planCard, { key: ' ' });
    const details = await screen.findByRole('complementary', { name: /Details: Plan the refactor/ });
    expect(within(details).getByDisplayValue('1. Split module')).toBeTruthy();
  });

  it('"Mark all read" never sends a Needs-you card', async () => {
    const { calls } = server();
    render(<AgentsBoard />);
    await screen.findByRole('button', { name: /Fix login/ });
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/verse/agents/bulk')).toBe(true));
    const bulk = calls.find((c) => c.path === '/api/verse/agents/bulk')!;
    expect(bulk.body).toEqual({ action: 'read', ids: ['chat:vs_c'] });
    expect(bulk.headers['x-ashlr-token']).toBe(TEST_TOKEN);
  });

  it('approves the plan with the operator’s edits', async () => {
    const { calls } = server((call) => (call.path.endsWith('/plan') ? json({ agent: {} }) : undefined));
    render(<AgentsBoard />);
    fireEvent.click(await screen.findByRole('button', { name: /Plan the refactor/ }));
    const details = await screen.findByRole('complementary', { name: /Details: Plan the refactor/ });
    fireEvent.change(within(details).getByDisplayValue('1. Split module'), { target: { value: '1. Split module\n2. Keep the API' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Approve and run' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/verse/agents/ag_bbbbbbbbbbbbbbbb/plan')).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/plan'))!.body).toEqual({ action: 'approve', text: '1. Split module\n2. Keep the API' });
  });

  it('opens New agent from ⇧⌘N’s hand-off and spawns: workspace → chat → bind with the prompt', async () => {
    const { calls } = server((call) => {
      if (call.path === '/api/verse/agents/workspaces') {
        return json({ agent: { id: 'ag_cccccccccccccccc', workspace: { path: '~/.ashlr-worktrees/app/fix-it' } }, config: { config: {}, source: 'default', warnings: [] }, archivedForCap: [] }, 201);
      }
      if (call.path === '/api/verse/sessions') return json({ id: `vs_${(call.body as { seatId: string }).seatId}` }, 201);
      if (call.path.endsWith('/bind')) return json({ agent: { id: 'ag_cccccccccccccccc' }, held: true });
      return undefined;
    });
    render(<AgentsBoard />);
    await screen.findByRole('button', { name: /Fix login/ });
    requestAgentsFocus('new-multi');
    const dialog = await screen.findByRole('dialog', { name: 'Same task on several seats' });
    await waitFor(() => expect(within(dialog).getByText(/setup: npm ci/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Codex/ }));
    fireEvent.change(within(dialog).getByLabelText(/What should/), { target: { value: 'Fix it' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start 2 agents' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/bind')).length).toBe(2));
    const made = calls.filter((c) => c.path === '/api/verse/agents/workspaces');
    expect(made.map((c) => (c.body as { root: string }).root)).toEqual(['/Users/x/code/app', '/Users/x/code/app']);
    const sessions = calls.filter((c) => c.path === '/api/verse/sessions');
    expect(sessions.map((c) => (c.body as { projectPath: string }).projectPath)).toEqual(['~/.ashlr-worktrees/app/fix-it', '~/.ashlr-worktrees/app/fix-it']);
    expect(calls.filter((c) => c.path.endsWith('/bind')).map((c) => c.body)).toEqual([
      { sessionId: `vs_${CLAUDE_SEAT.id}`, prompt: 'Fix it' },
      { sessionId: `vs_${CODEX_SEAT.id}`, prompt: 'Fix it' },
    ]);
    await screen.findByText(/Started 2 agents/);
  });
});
