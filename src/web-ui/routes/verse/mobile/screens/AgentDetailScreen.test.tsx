/**
 * One agent on the phone: the transcript from the chat's own detail + stream
 * (bubbles, one-line tool chips that expand, "Thought for 12s", system
 * lines), Stop behind a confirmation, Send while idle, Interject / Queue
 * while running, the read-only Changes pane, and every state (loading, not
 * found, empty, reconnecting, offline, read-only device).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerseCheckpointDiffResponse, VerseCheckpointListResponse } from '../../../../../core/verse/checkpoint-types.js';
import type { VerseEvent } from '../../../../data/api-types.js';
import { clearMutationToken, markCheckComplete, setMutationToken } from '../../../../data/auth-store.js';
import { evictAll } from '../../../../data/cache.js';
import { resetLocalSeen } from '../../chat/use-chat-activity.js';
import { bootstrap, detail, ev, MockEventSource } from '../../fixtures.test-support.js';
import { closeAllVerseSessionStreams } from '../../session-stream.js';
import { resetGuard } from '../../shell/guard-store.js';
import { applyVerseEvents, resetVerseStore, setVerseStreamState } from '../../verse-store.js';
import { MobileGuardSheet } from '../MobileGuardSheet.js';
import { json, permissionsFor, renderMobile, stubFetch, TOKEN, type FetchCall } from '../mobile.test-support.js';
import type { AgentPane } from '../mobile-router.js';
import { resetMobileToastsForTest } from '../mobile-toast.js';
import { AgentDetailScreen, STOP_CONSEQUENCES } from './AgentDetailScreen.js';

const DETAIL = '/api/verse/sessions/vs_1';

const DONE_TURN: VerseEvent[] = [
  ev(1, 'user-message', { turnId: 't1', text: 'run the tests' }),
  ev(2, 'turn-started', { turnId: 't1', pid: 1 }),
  ev(3, 'thinking', { turnId: 't1', text: 'Checking the runner first.', durationMs: 12_000 }),
  ev(4, 'tool-use', { turnId: 't1', toolUseId: 'u1', name: 'Bash', input: { command: 'npm test' } }),
  ev(5, 'tool-result', { turnId: 't1', toolUseId: 'u1', output: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'), isError: false }),
  ev(6, 'tool-use', { turnId: 't1', toolUseId: 'u2', name: 'Edit', input: { file_path: '/Users/mason/dev/hub/src/core/a.ts', old_string: 'x', new_string: 'y' } }),
  ev(7, 'tool-result', { turnId: 't1', toolUseId: 'u2', output: 'ok', isError: false }),
  ev(8, 'assistant-message', { turnId: 't1', text: 'All green.\n```ts\nconst answer = 42;\n```' }),
  ev(9, 'turn-done', { turnId: 't1', ok: true, nativeSessionId: null, durationMs: 65_000 }),
];

const RUNNING_TURN: VerseEvent[] = [
  ev(1, 'user-message', { turnId: 't1', text: 'refactor the loader' }),
  { ...ev(2, 'turn-started', { turnId: 't1', pid: 1 }), at: new Date(Date.now() - 5_000).toISOString() },
];

function checkpoints(): VerseCheckpointListResponse {
  const snap = { commit: 'abc123', error: null, skipped: 0, at: '2026-09-27T11:00:00Z', ms: 3 };
  return {
    chatId: 'vs_1',
    running: false,
    roots: [{ rootId: 'r1', path: '~/dev/hub', name: 'hub' }],
    turns: [
      { turnId: 't0', index: 1, startedAt: '2026-09-27T10:00:00Z', endedAt: null, outcome: null, state: 'done', roots: [{ rootId: 'r1', pre: null, post: null }], filesChanged: null },
      { turnId: 't1', index: 2, startedAt: '2026-09-27T11:00:00Z', endedAt: null, outcome: null, state: 'done', roots: [{ rootId: 'r1', pre: snap, post: snap }], filesChanged: 2 },
      { turnId: 't2', index: 3, startedAt: '2026-09-27T11:30:00Z', endedAt: null, outcome: null, state: 'done', roots: [{ rootId: 'r1', pre: snap, post: snap }], filesChanged: 1 },
    ],
    redo: null,
  };
}

const PATCH = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n export { a };\n';

function diffFor(call: FetchCall): VerseCheckpointDiffResponse {
  const file = new URL(call.url, 'http://x').searchParams.get('file');
  return {
    chatId: 'vs_1',
    turnId: 't1',
    rootId: 'r1',
    mode: 'since',
    base: 'abc123',
    target: 'def456',
    files: [
      { path: 'src/a.ts', oldPath: null, status: 'M', additions: 2, deletions: 1, binary: false, captured: true, editedAfterTurn: false, accepted: false },
      { path: 'docs/new.md', oldPath: null, status: 'A', additions: 10, deletions: 0, binary: false, captured: true, editedAfterTurn: false, accepted: false },
    ],
    patch: file ? { path: file, text: PATCH, truncated: true, binary: false, hunks: [] } : null,
    actionable: true,
  };
}

function routes(events: VerseEvent[], over: Record<string, unknown> = {}, sessionOver: Parameters<typeof detail>[1] = {}) {
  return stubFetch({
    [`GET ${DETAIL}`]: detail(events, { id: 'vs_1', title: 'Fix the login bug', ...sessionOver }),
    'GET /api/verse/bootstrap': bootstrap(),
    'POST /api/verse/activity/seen': { ok: true },
    [`POST ${DETAIL}/cancel`]: { ok: true },
    [`POST ${DETAIL}/turns`]: { turnId: 't9', session: detail([], { id: 'vs_1' }).session },
    'POST /api/verse/queue/vs_1': { sessionId: 'vs_1', items: [], held: false, heldReason: null, sentTurnId: 't9' },
    'GET /api/verse/checkpoints': checkpoints(),
    'GET /api/verse/checkpoints/diff': (_body: unknown, call: FetchCall) => diffFor(call),
    ...over,
  });
}

function show(pane: AgentPane = 'transcript', overrides: Parameters<typeof renderMobile>[1] = {}) {
  return renderMobile(
    <>
      <AgentDetailScreen sessionId="vs_1" pane={pane} />
      <MobileGuardSheet />
    </>,
    overrides,
  );
}

const writes = (calls: FetchCall[]) => calls.filter((c) => c.method === 'POST' && !c.url.startsWith('/api/verse/activity/seen'));

beforeEach(() => {
  // EventSource first: authenticating opens the app-wide /api/events channel too.
  MockEventSource.reset();
  vi.stubGlobal('EventSource', MockEventSource);
  markCheckComplete(true);
  setMutationToken(TOKEN);
});

afterEach(() => {
  closeAllVerseSessionStreams();
  clearMutationToken();
  markCheckComplete(false);
  evictAll();
  resetGuard();
  resetVerseStore();
  resetLocalSeen();
  resetMobileToastsForTest();
  vi.unstubAllGlobals();
});

describe('AgentDetailScreen — transcript', () => {
  it('renders the chat from its detail: bubbles, tool chips, thinking, code, system lines', async () => {
    routes(DONE_TURN);
    show();
    expect(await screen.findByText('run the tests')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fix the login bug' })).toBeInTheDocument();
    expect(screen.getByText('Claude Max · Opus 5')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /Bash npm test/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /Edit …\/src\/core\/a\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thought for 12s' })).toBeInTheDocument();
    expect(screen.getByText('All green.')).toBeInTheDocument();
    expect(screen.getByLabelText('ts code')).toHaveTextContent('const answer = 42;');
    expect(screen.getByText('Done in 1m')).toBeInTheDocument();
    // The stream attached after the detail seeded the store.
    await waitFor(() => expect(MockEventSource.forSession('vs_1').url).toContain('after=9'));
  });

  it('expands a tool chip to its output, clipped to 40 lines', async () => {
    const user = userEvent.setup();
    routes(DONE_TURN);
    show();
    const chip = await screen.findByRole('button', { name: /Bash npm test/ });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/line 40$/)).toBeInTheDocument();
    expect(screen.queryByText(/line 41/)).not.toBeInTheDocument();
    expect(screen.getByText(/10 more lines/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Thought for 12s' }));
    expect(screen.getByText('Checking the runner first.')).toBeInTheDocument();
  });

  it('streams: new events append, the typing line shows the running tool', async () => {
    routes(RUNNING_TURN, {}, { status: 'running' });
    show();
    expect(await screen.findByText('refactor the loader')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    act(() => {
      applyVerseEvents('vs_1', [
        { seq: 2, at: new Date().toISOString(), type: 'progress', turnId: 't1', phase: 'tool', tool: 'Edit', elapsedMs: 5_000 } as VerseEvent,
        ev(3, 'text-delta', { turnId: 't1', text: 'Splitting the loader into two…' }),
      ]);
    });
    expect(screen.getByText('Splitting the loader into two…')).toBeInTheDocument();
    expect(screen.getAllByRole('status').some((el) => /^Using Edit · \d+s$/.test(el.textContent ?? ''))).toBe(true);
  });

  it('only draws the last 60 items, with Show earlier', async () => {
    const user = userEvent.setup();
    const many: VerseEvent[] = [];
    for (let i = 0; i < 70; i += 1) many.push(ev(i + 1, 'user-message', { turnId: `t${i}`, text: `message ${i}` }));
    routes(many);
    show();
    expect(await screen.findByText('message 69')).toBeInTheDocument();
    expect(screen.queryByText('message 9')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show earlier (10)' }));
    expect(screen.getByText('message 0')).toBeInTheDocument();
  });

  it('marks the chat seen at its turn count', async () => {
    const { calls } = routes(DONE_TURN, {}, { turnCount: 1 });
    show();
    await screen.findByText('run the tests');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/verse/activity/seen' && c.body?.['turnCount'] === 1)).toBe(true));
  });
});

describe('AgentDetailScreen — actions', () => {
  it('Stop asks first, says what happens, then POSTs cancel', async () => {
    const user = userEvent.setup();
    const { calls } = routes(RUNNING_TURN, {}, { status: 'running' });
    show();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const sheet = await screen.findByRole('alertdialog', { name: 'Stop this turn?' });
    expect(sheet).toHaveTextContent(STOP_CONSEQUENCES);
    expect(writes(calls)).toEqual([]);
    await user.click(within(sheet).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(writes(calls).map((c) => c.url)).toEqual([`${DETAIL}/cancel`]));
  });

  it('Send while idle POSTs a turn and clears the box', async () => {
    const user = userEvent.setup();
    const { calls } = routes(DONE_TURN);
    show();
    await screen.findByText('run the tests');
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await user.type(box, 'now the docs');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ url: `${DETAIL}/turns`, body: { text: 'now the docs' } });
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('Interject while running queues with sendNow; Queue without it', async () => {
    const user = userEvent.setup();
    const { calls } = routes(RUNNING_TURN, {}, { status: 'running' });
    show();
    await screen.findByText('refactor the loader');
    expect(screen.getByText('Interject stops the current turn and sends this next.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'use the new API');
    await user.click(screen.getByRole('button', { name: 'Interject' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    expect(writes(calls)[0]).toMatchObject({ url: '/api/verse/queue/vs_1', body: { text: 'use the new API', sendNow: true } });
    // No confirmation sheet for a message.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Queue for after' }));
    expect(screen.getByText('Queue sends this after the current turn finishes.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'then commit');
    await user.click(screen.getByRole('button', { name: 'Queue' }));
    await waitFor(() => expect(writes(calls)).toHaveLength(2));
    expect(writes(calls)[1]!.body).toEqual({ text: 'then commit' });
  });

  it('asks for the token before sending when actions are locked', async () => {
    const user = userEvent.setup();
    clearMutationToken();
    const { calls } = routes(DONE_TURN);
    show('transcript', { permissions: permissionsFor('locked') });
    await screen.findByText('run the tests');
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const sheet = await screen.findByRole('dialog');
    expect(writes(calls)).toEqual([]);
    await user.type(within(sheet).getByLabelText('Mutation token'), TOKEN);
    await user.click(within(sheet).getByRole('button', { name: /Unlock/ }));
    await waitFor(() => expect(writes(calls).map((c) => c.url)).toEqual([`${DETAIL}/turns`]));
  });

  it('hides the composer and Stop when this device cannot act, and says why', async () => {
    routes(RUNNING_TURN, {}, { status: 'running' });
    show('transcript', { permissions: permissionsFor('unavailable') });
    await screen.findByText('refactor the loader');
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.getByText('Your Mac started Verse without dispatch.')).toBeInTheDocument();
  });

  it('a Devin chat stops the same way and offers no terminate', async () => {
    const user = userEvent.setup();
    const { calls } = routes(RUNNING_TURN, {}, { status: 'running', engine: 'devin', seatId: 'devin' });
    show();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const sheet = await screen.findByRole('alertdialog');
    expect(within(sheet).queryByText(/terminate|end the devin session/i)).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(writes(calls).map((c) => c.url)).toEqual([`${DETAIL}/cancel`]));
  });

  it('switches panes with replace navigation', async () => {
    const user = userEvent.setup();
    routes(DONE_TURN);
    const { context } = show();
    await screen.findByText('run the tests');
    expect(screen.getByRole('button', { name: 'Transcript' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Changes' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'agent', id: 'vs_1', pane: 'changes' }, { replace: true });
    await user.click(screen.getByRole('button', { name: 'Agents' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'agents' });
  });
});

describe('AgentDetailScreen — states', () => {
  it('loading: a skeleton until the detail lands', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    show();
    expect(screen.getByRole('status', { name: 'Loading the conversation' })).toBeInTheDocument();
  });

  it('not found: says so, with Try again and a way back', async () => {
    const user = userEvent.setup();
    routes([], { [`GET ${DETAIL}`]: json({ error: 'not found', code: 'VERSE_SESSION_NOT_FOUND' }, 404) });
    const { context } = show();
    expect(await screen.findByText('Chat not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to Agents' }));
    expect(context.navigate).toHaveBeenCalledWith({ screen: 'agents' });
  });

  it('empty: no messages yet', async () => {
    routes([]);
    show();
    expect(await screen.findByText('No messages yet')).toBeInTheDocument();
  });

  it('shows when the live stream is reconnecting', async () => {
    routes(DONE_TURN);
    show();
    await screen.findByText('run the tests');
    act(() => setVerseStreamState('vs_1', 'reconnecting'));
    expect(screen.getByText('Reconnecting to the live stream…')).toBeInTheDocument();
  });

  it('offline: keeps the transcript, says so, and disables sending and Stop', async () => {
    routes(RUNNING_TURN, {}, { status: 'running' });
    show('transcript', { reachability: 'offline' });
    expect(await screen.findByText('refactor the loader')).toBeInTheDocument();
    expect(screen.getByText(/You’re offline/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByText('Sending is paused until your Mac is reachable.')).toBeInTheDocument();
  });
});

describe('AgentDetailScreen — Changes', () => {
  it('lists everything the chat changed since its first checkpoint', async () => {
    const { calls } = routes(DONE_TURN);
    show('changes');
    expect(await screen.findByText('2 files · +12 −1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/a\.ts/ })).toHaveTextContent('+2 −1');
    expect(screen.getByRole('button', { name: /docs\/new\.md/ })).toHaveTextContent('A');
    expect(screen.getByText('Read-only here. Review and undo on your Mac.')).toBeInTheDocument();
    const diffCall = calls.find((c) => c.url.startsWith('/api/verse/checkpoints/diff'))!;
    const q = new URL(diffCall.url, 'http://x').searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ chatId: 'vs_1', turnId: 't1', rootId: 'r1', mode: 'since' });
    // No composer on the Changes pane, and nothing written.
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
  });

  it('opens a file as a wrapped, line-coloured unified diff', async () => {
    const user = userEvent.setup();
    routes(DONE_TURN);
    const { container } = show('changes');
    await user.click(await screen.findByRole('button', { name: /src\/a\.ts/ }));
    const patch = await screen.findByLabelText('Diff of src/a.ts');
    const kinds = [...patch.querySelectorAll('[data-kind]')].map((el) => `${el.getAttribute('data-kind')}:${el.textContent}`);
    expect(kinds).toEqual([
      'meta:diff --git a/src/a.ts b/src/a.ts',
      'meta:--- a/src/a.ts',
      'meta:+++ b/src/a.ts',
      'hunk:@@ -1,2 +1,3 @@',
      'del:-const a = 1;',
      'add:+const a = 2;',
      'add:+const b = 3;',
      'context: export { a };',
    ]);
    expect(screen.getByText(/This diff was cut short/)).toBeInTheDocument();
    // No inline style opens a horizontal scroller…
    for (const el of container.querySelectorAll<HTMLElement>('[style]')) expect(el.style.overflowX).not.toMatch(/auto|scroll/);
    // …and the stylesheet wraps diff lines instead.
    const css = await readFile(resolve(process.cwd(), 'src/web-ui/routes/verse/mobile/screens/AgentDetailScreen.module.css'), 'utf8');
    expect(css).not.toMatch(/overflow(-x)?\s*:\s*(auto|scroll)/);
    const line = /\.line\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(line).toMatch(/white-space:\s*pre-wrap/);
    expect(line).toMatch(/word-break:\s*break-word/);
  });

  it('no checkpoint yet (409) is an empty state, not an error', async () => {
    routes(DONE_TURN, { 'GET /api/verse/checkpoints': json({ error: 'No checkpoint.', code: 'VERSE_CHECKPOINT_UNAVAILABLE' }, 409) });
    show('changes');
    expect(await screen.findByText('No checkpoint for this chat yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failure says why, with Try again', async () => {
    routes(DONE_TURN, { 'GET /api/verse/checkpoints': json({ error: 'git could not read the repository.' }, 500) });
    show('changes');
    expect(await screen.findByText('git could not read the repository.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
