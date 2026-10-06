/**
 * The Leader conversation on Mind: every message kind draws, sends are
 * optimistic and deduped, the token comes first, failures keep the words
 * with Retry / Discard, answers / approvals / vetoes / directives reach
 * their routes, the thread polls, and ⌘K / Needs-you focus requests land.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { useQuery } from '../../../data/hooks.js';
import { loadMarkdownRenderer } from '../MessageMarkdown.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { leaderState } from '../command/fixtures.test-support.js';
import { leaderQuery } from '../command/surface-data.js';
import { getVerseUiState, resetVerseUi } from '../verse-ui-store.js';
import LeaderQuestionForm, { type QuestionFormStore } from './LeaderQuestionForm.js';
import type { LeaderQuestionProjection, LeaderQuestionForm as QuestionForm } from './thread-types.js';
import { LeaderComposer, type LeaderComposerProps } from './LeaderComposer.js';
import { LeaderConversation } from './LeaderConversation.js';
import { getLeaderFocus, requestLeaderFocus, resetLeaderFocus } from './leader-focus.js';
import { directive, directives, msg, QUESTION_TEXT, threadMessages } from './thread-fixtures.test-support.js';
import type { LeaderThreadMessage, OperatorDirective } from './thread-types.js';

const TOKEN = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stub {
  calls: Call[];
  thread: LeaderThreadMessage[];
  directives: OperatorDirective[];
  posts: () => Call[];
  reads: (path: string) => number;
}

function stub(
  opts: {
    thread?: LeaderThreadMessage[] | null;
    leader?: LeaderStateV1;
    directives?: OperatorDirective[];
    onGet?: (url: string) => Response | Promise<Response> | undefined;
    onPost?: (url: string, body: Record<string, unknown>) => Response | Promise<Response> | undefined;
  } = {},
): Stub {
  const state: Stub = {
    calls: [],
    thread: opts.thread === null ? [] : (opts.thread ?? threadMessages()),
    directives: opts.directives ?? directives(),
    posts: () => state.calls.filter((c) => c.method !== 'GET'),
    reads: (path) => state.calls.filter((c) => c.method === 'GET' && c.url.split('?')[0] === path).length,
  };
  const leader = opts.leader ?? leaderState('live');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      state.calls.push({ url, method, body });
      if (method === 'POST') return (await opts.onPost?.(url, body ?? {})) ?? json({ ok: true });
      if (method === 'DELETE') return json({ ok: true });
      const customRead = await opts.onGet?.(url);
      if (customRead) return customRead;
      const path = url.split('?')[0];
      if (path === '/api/verse/leader/thread') return opts.thread === null ? json({ error: 'not found' }, 404) : json({ messages: state.thread });
      if (path === '/api/verse/leader/directives') return json({ directives: state.directives });
      if (path === '/api/verse/leader') return json(leader);
      return json({ error: 'not found' }, 404);
    }),
  );
  return state;
}

function Harness({ dormant = false }: { dormant?: boolean }) {
  const leader = useQuery(leaderQuery);
  const actions = useSurfaceActions();
  return (
    <>
      <ActionStatus actions={actions} />
      <LeaderConversation leader={leader.data} actions={actions} dormant={dormant} />
      {actions.dialogs}
    </>
  );
}

async function mount(dormant = false) {
  render(<Harness dormant={dormant} />);
  const log = await screen.findByRole('log', { name: 'Conversation with the Leader' });
  return log;
}

const composer = () => screen.getByRole('textbox', { name: 'Message the Leader' });
const now = () => new Date().toISOString();

beforeAll(async () => {
  // Markdown renders synchronously once its chunk is in.
  await loadMarkdownRenderer();
});

beforeEach(() => {
  evictAll();
  clearMutationToken();
  resetLeaderFocus();
  resetVerseUi();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearMutationToken();
});

describe('LeaderConversation — rendering', () => {
  it('draws every kind of message with its channel, in one threaded log', async () => {
    // The fixture reaches back an hour. Pin a local midday so its Today
    // assertion does not become Yesterday when this suite runs after midnight.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 2, 12));
    stub();
    const log = await mount();
    // Leader prose is Markdown; Mason's words are plain text.
    await within(log).findByText('judge queue', { selector: 'strong' });
    expect(within(log).getByText('What is slowing merges this week?')).toBeInTheDocument();
    // Channel badges: Telegram and the CLI show here too.
    expect(within(log).getAllByText('Telegram').length).toBeGreaterThanOrEqual(2);
    expect(within(log).getAllByText('CLI').length).toBe(2);
    // A directive is a pinned chip; a system line is a quiet line of its own.
    expect(within(log).getByText('No spend raises overnight.')).toBeInTheDocument();
    expect(within(log).getByText(/Telegram connected\./)).toBeInTheDocument();
    expect(within(log).getByText('Also sent to Telegram')).toBeInTheDocument();
    // Day separators.
    expect(within(log).getByRole('separator', { name: 'Today' })).toBeInTheDocument();
  });

  it.each([
    { boundary: 'local midnight', at: new Date(2026, 9, 2, 0, 10) },
    { boundary: 'local New Year', at: new Date(2027, 0, 1, 0, 10) },
  ])('separates Yesterday and Today across $boundary', async ({ at }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    stub({ thread: [
      msg({ id: 'before-midnight', at: new Date(at.getTime() - 50 * 60_000).toISOString(), text: 'Before midnight.' }),
      msg({ id: 'after-midnight', at: new Date(at.getTime() - 60_000).toISOString(), text: 'After midnight.' }),
    ] });
    const log = await mount();
    await within(log).findByText('After midnight.');
    expect(within(log).getAllByRole('separator').map(row => row.getAttribute('aria-label'))).toEqual(['Yesterday', 'Today']);
    expect(within(log).getByText('Before midnight.')).toBeInTheDocument();
    expect(within(log).getByText('After midnight.')).toBeInTheDocument();
  });

  it('draws a memo as a card: bottleneck, the move, and each action with its class, countdown, Approve and Veto', async () => {
    stub();
    const log = await mount();
    const memo = await within(log).findByRole('article', { name: 'Leader memo' });
    await within(memo).findByText(/Judge queue on grok-a/);
    expect(within(memo).getByText(/Raise Grok to 3 lanes and archive the stalled router goal/)).toBeInTheDocument();
    expect(within(memo).getByText(/\+4 merges\/day by/)).toBeInTheDocument();
    const rows = within(within(memo).getByRole('list', { name: 'Memo actions' })).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('[title^="Class"]')?.textContent)).toEqual(['A', 'A', 'B', 'C']);
    // Approve: the class-B action in its window and the class-C ask. Veto: everything applied or scheduled.
    expect(within(memo).getAllByRole('button', { name: /^Approve:/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Approve: Raise Grok to 3 lanes',
      'Approve: Asks: enable merges on ashlr-hub (non-authority paths)',
    ]);
    expect(within(memo).getAllByRole('button', { name: /^Veto:/ })).toHaveLength(3);
    expect(within(memo).getByRole('timer')).toHaveAccessibleName(/Applies in \d+m unless vetoed/);
  });

  it('says a dry-run memo is a dry run — and offers neither Approve nor Veto', async () => {
    stub({ leader: leaderState('sparse') });
    const log = await mount(true);
    const memo = await within(log).findByRole('article', { name: 'Leader memo' });
    await within(memo).findByText(/Judge queue on grok-a/);
    expect(within(memo).queryByRole('button', { name: /^(Approve|Veto):/ })).toBeNull();
    expect(memo).toHaveTextContent('Autonomy is off, so this memo is a dry run');
    expect(screen.getByText('Autonomy off · memos are dry runs')).toBeInTheDocument();
  });

  it('shows a question with its answer box until it is answered', async () => {
    stub();
    const log = await mount();
    const q = await within(log).findByRole('article', { name: 'Leader question' });
    expect(q).toHaveTextContent(QUESTION_TEXT);
    expect(within(q).getByRole('textbox', { name: /^Answer the Leader:/ })).toBeInTheDocument();
  });

  it('shows standing directives as chips', async () => {
    stub();
    await mount();
    const strip = screen.getByRole('group', { name: 'Directives' });
    await within(strip).findByText('Ship binshield before new goals');
    expect(within(strip).getByRole('button', { name: 'Retire directive: No spend raises overnight' })).toBeInTheDocument();
  });

  it('is honest when the conversation route is absent: the reason, and a composer that cannot send', async () => {
    stub({ thread: null });
    const log = await mount();
    await within(log).findByText(/The Leader conversation is not in this build yet/);
    expect(composer()).toBeDisabled();
  });

  it('loads earlier messages on request, from before the oldest one on screen', async () => {
    const base = Date.now() - 100 * 60_000;
    const page = Array.from({ length: 50 }, (_, i) => msg({ id: `p${i}`, at: new Date(base + (i + 10) * 60_000).toISOString(), text: `Page message ${i}` }));
    const s = stub({ thread: page });
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('before=')) {
        s.calls.push({ url, method: 'GET', body: null });
        return json({ messages: [msg({ id: 'old1', at: new Date(base).toISOString(), text: 'From last week.' })] });
      }
      return original(input, init);
    });
    const log = await mount();
    await within(log).findByText('Page message 49');
    await userEvent.click(within(log).getByRole('button', { name: 'Load earlier messages' }));
    await within(log).findByText('From last week.');
    expect(s.calls.some((c) => c.url === '/api/verse/leader/thread?limit=50&before=p0')).toBe(true);
    // Fewer than a page came back: that was the start of the thread.
    expect(within(log).queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  it('offers starting points on an empty thread', async () => {
    stub({ thread: [] });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: 'What is the bottleneck right now?' }));
    expect(composer()).toHaveValue('What is the bottleneck right now?');
  });
});

describe('LeaderConversation — sending', () => {
  it('shows the message at once, then the reply, and each message once', async () => {
    setMutationToken(TOKEN);
    let release!: (r: Response) => void;
    const s = stub({ onPost: () => new Promise<Response>((resolve) => (release = resolve)) });
    const log = await mount();
    await within(log).findByText('Status?');
    await userEvent.type(composer(), 'Hello Leader{Enter}');
    // Optimistic: in the log before the server answered, the box cleared, the Leader "thinking".
    expect(within(log).getByText('Hello Leader')).toBeInTheDocument();
    expect(within(log).getByText('Sending…')).toBeInTheDocument();
    expect(screen.getByText('Leader is thinking…')).toBeInTheDocument();
    expect(composer()).toHaveValue('');
    expect(s.posts()).toEqual([{ url: '/api/verse/leader/thread', method: 'POST', body: { text: 'Hello Leader' } }]);
    // The next read already carries the message (it landed before the POST returned).
    const sent = msg({ id: 's1', at: now(), from: 'mason', text: 'Hello Leader' });
    const reply = msg({ id: 'r1', at: now(), text: 'Hi Mason. The judge queue is clearing.' });
    s.thread = [...s.thread, sent];
    await act(async () => release(json({ message: sent, reply })));
    await within(log).findByText('Hi Mason. The judge queue is clearing.');
    expect(within(log).getAllByText('Hello Leader')).toHaveLength(1);
    expect(within(log).queryByText('Sending…')).toBeNull();
    await waitFor(() => expect(screen.queryByText('Leader is thinking…')).toBeNull());
  });

  it('never sends an empty box, and Shift+Enter is a new line', async () => {
    setMutationToken(TOKEN);
    const s = stub();
    await mount();
    await userEvent.type(composer(), '   {Enter}');
    await userEvent.clear(composer());
    await userEvent.type(composer(), 'one{Shift>}{Enter}{/Shift}two');
    expect(composer()).toHaveValue('one\ntwo');
    expect(s.posts()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Send to the Leader' })).toBeEnabled();
  });

  it('asks for the token FIRST and keeps the draft until it is given', async () => {
    const s = stub({ onPost: (_u, body) => json({ message: msg({ id: 's1', from: 'mason', at: now(), text: String(body['text']) }), reply: null }) });
    await mount();
    await userEvent.type(composer(), 'Pause binshield{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Unlock actions' });
    expect(dialog).toHaveTextContent('Messaging the Leader requires the dispatch token.');
    expect(composer()).toHaveValue('Pause binshield');
    expect(s.posts()).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Mutation token'), `${TOKEN}{Enter}`);
    await waitFor(() => expect(s.posts().map((c) => c.body)).toEqual([{ text: 'Pause binshield' }]));
    expect(composer()).toHaveValue('');
  });

  it('keeps a failed message with the server’s reason; Retry sends it again, Discard drops it', async () => {
    setMutationToken(TOKEN);
    let fail = true;
    const s = stub({
      onPost: (_u, body) =>
        fail ? json({ error: 'The Leader is mid-run; try again in a minute.' }, 409) : json({ message: msg({ id: 's2', from: 'mason', at: now(), text: String(body['text']) }), reply: msg({ id: 'r2', at: now(), text: 'Done.' }) }),
    });
    const log = await mount();
    await userEvent.type(composer(), 'First try{Enter}');
    const alert = await within(log).findByRole('alert');
    expect(alert).toHaveTextContent('Not sent — The Leader is mid-run; try again in a minute.');
    expect(within(log).getByText('First try')).toBeInTheDocument();
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await within(log).findByText('Done.');
    expect(within(log).queryByRole('alert')).toBeNull();
    expect(s.posts()).toHaveLength(2);

    fail = true;
    await userEvent.type(composer(), 'Second{Enter}');
    const again = await within(log).findByRole('alert');
    await userEvent.click(within(again).getByRole('button', { name: 'Discard' }));
    expect(within(log).queryByText('Second')).toBeNull();
  });

  it('keeps "thinking" while the Leader replies later, polling faster, until its reply arrives', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setMutationToken(TOKEN);
    const s = stub({ onPost: (_u, body) => json({ message: msg({ id: 's3', from: 'mason', at: now(), text: String(body['text']) }), reply: null }) });
    const log = await mount();
    await within(log).findByText('Status?');
    fireEvent.change(composer(), { target: { value: 'Think about lanes' } });
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await waitFor(() => expect(s.posts()).toHaveLength(1));
    await waitFor(() => expect(within(log).queryByText('Sending…')).toBeNull());
    expect(screen.getByText('Leader is thinking…')).toBeInTheDocument();
    const before = s.reads('/api/verse/leader/thread');
    s.thread = [...s.thread, msg({ id: 's3', from: 'mason', at: now(), text: 'Think about lanes' }), msg({ id: 'r3', at: now(), text: 'Three lanes, then.' })];
    // 3 s, not 10: the thread polls faster while the Leader is thinking.
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await within(log).findByText('Three lanes, then.');
    expect(s.reads('/api/verse/leader/thread')).toBeGreaterThan(before);
    expect(screen.queryByText('Leader is thinking…')).toBeNull();
  });

  it('polls the thread every 10 s while visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s = stub();
    const log = await mount();
    await within(log).findByText('Status?');
    const before = s.reads('/api/verse/leader/thread');
    s.thread = [...s.thread, msg({ id: 'n1', at: now(), channel: 'telegram', text: 'New from Telegram.' })];
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(s.reads('/api/verse/leader/thread')).toBe(before);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    await within(log).findByText('New from Telegram.');
  });
});

describe('LeaderConversation — answers, approvals, vetoes, directives', () => {
  it('answers a question on its own route and marks it answered', async () => {
    setMutationToken(TOKEN);
    const s = stub({
      onPost: (url, body) =>
        url.includes('/questions/')
          ? json({ message: msg({ id: 'a1', from: 'mason', kind: 'answer', questionId: 'memo-0924:0', replyTo: 't4', at: now(), text: String(body['text']) }), reply: msg({ id: 'r4', at: now(), text: 'Understood: propose-only.' }) })
          : undefined,
    });
    const log = await mount();
    const q = await within(log).findByRole('article', { name: 'Leader question' });
    await userEvent.type(within(q).getByRole('textbox'), 'Propose-only until CI{Enter}');
    await waitFor(() => expect(s.posts()).toEqual([{ url: '/api/verse/leader/questions/memo-0924:0/answer', method: 'POST', body: { text: 'Propose-only until CI' } }]));
    await within(q).findByText(/Answered/);
    expect(within(q).queryByRole('textbox')).toBeNull();
    await within(log).findByText('Understood: propose-only.');
  });

  it('approves a class-B action after confirmation', async () => {
    setMutationToken(TOKEN);
    const s = stub();
    const log = await mount();
    const memo = await within(log).findByRole('article', { name: 'Leader memo' });
    await userEvent.click(await within(memo).findByRole('button', { name: 'Approve: Raise Grok to 3 lanes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this action?' });
    expect(dialog).toHaveTextContent('applies now instead of waiting out its veto window');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(s.posts()).toEqual([{ url: '/api/verse/leader/actions/a2/approve', method: 'POST', body: {} }]));
  });

  it('vetoes an action after confirmation', async () => {
    setMutationToken(TOKEN);
    const s = stub();
    const log = await mount();
    const memo = await within(log).findByRole('article', { name: 'Leader memo' });
    await userEvent.click(await within(memo).findByRole('button', { name: 'Veto: Raise Grok to 3 lanes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Veto this action?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Veto' }));
    await waitFor(() => expect(s.posts()).toEqual([{ url: '/api/verse/leader', method: 'POST', body: { action: 'veto', actionId: 'a2' } }]));
  });

  it('retires a directive and adds one', async () => {
    setMutationToken(TOKEN);
    const s = stub({ onPost: (_u, body) => json({ directive: directive({ id: 'd9', text: String(body['text']) }), duplicate: false }, 201) });
    await mount();
    const strip = screen.getByRole('group', { name: 'Directives' });
    await userEvent.click(await within(strip).findByRole('button', { name: 'Retire directive: Ship binshield before new goals' }));
    await waitFor(() => expect(s.posts()).toEqual([{ url: '/api/verse/leader/directives/d1', method: 'DELETE', body: null }]));
    await userEvent.click(within(strip).getByRole('button', { name: /Add directive/ }));
    await userEvent.type(within(strip).getByRole('textbox', { name: 'New directive' }), 'Keep Claude for Mason{Enter}');
    await waitFor(() => expect(s.posts()[1]).toEqual({ url: '/api/verse/leader/directives', method: 'POST', body: { text: 'Keep Claude for Mason' } }));
    await waitFor(() => expect(within(strip).queryByRole('textbox', { name: 'New directive' })).toBeNull());
  });
});

describe('LeaderConversation — focus requests', () => {
  it('⌘K "Message the Leader…" lands in the composer', async () => {
    stub();
    await mount();
    await screen.findByText('Status?');
    act(() => requestLeaderFocus({ kind: 'composer' }));
    await waitFor(() => expect(composer()).toHaveFocus());
    expect(getVerseUiState().section).toBe('mind');
    expect(getLeaderFocus()).toBeNull();
  });

  it('⌘K "Add Leader directive…" opens the directive box', async () => {
    stub();
    await mount();
    act(() => requestLeaderFocus({ kind: 'directive' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'New directive' })).toHaveFocus());
  });

  it('a Needs-you "Answer" opens that question’s answer box', async () => {
    stub();
    // Asked before the panel mounted (the drawer closes, Mind's chunk loads).
    requestLeaderFocus({ kind: 'question', questionId: 'memo-0924:0', text: QUESTION_TEXT });
    const log = await mount();
    const q = await within(log).findByRole('article', { name: 'Leader question' });
    await waitFor(() => expect(within(q).getByRole('textbox')).toHaveFocus());
    expect(getLeaderFocus()).toBeNull();
  });

  it('uses a quoted message only when the server explicitly reports typed questions unsupported', async () => {
    setMutationToken(TOKEN);
    const s = stub({ thread: threadMessages().filter((m) => m.kind !== 'question'),
      onGet: url => url.includes('/questions/') ? json({ typedQuestionsSupported: false }) : undefined });
    await mount();
    await screen.findByText('Status?');
    act(() => requestLeaderFocus({ kind: 'question', questionId: 'memo-0924:1', text: 'Keep Codex off?' }));
    await screen.findByText('Answering: Keep Codex off?');
    await waitFor(() => expect(composer()).toHaveFocus());
    await userEvent.type(composer(), 'Yes{Enter}');
    await waitFor(() => expect(s.posts()[0]?.body).toEqual({ text: '> Keep Codex off?\n\nYes' }));
    expect(screen.queryByText('Answering: Keep Codex off?')).toBeNull();
  });
});


describe('generated Leader notes remain readable with exact action controls', () => {
  it('projects the expanded memo note while preserving control IDs and human/question literals', async () => {
    const memoId = 'lm-20261005153000-abcdef';
    const actionId = 'la-20261005153000-abcdef-1';
    const state = leaderState('live');
    state.latest!.id = memoId;
    state.actions[1]!.id = actionId;
    state.actions[1]!.memoId = memoId;
    state.latest!.actions = state.actions;
    const raw = `Memo ${memoId}\n• [B] Read "file(${actionId}).ts" — scheduled (${actionId})\nApprove or veto any of them by id.`;
    const net = stub({ leader: state, thread: [
      msg({ id: 'memo-visible', kind: 'memo', memoId, actionIds: [actionId], text: raw }),
      msg({ id: 'human-literal', from: 'mason', text: `Please keep Memo ${memoId} exactly.` }),
      msg({ id: 'question-literal', kind: 'question', questionId: `${memoId}:0`, text: `Does Memo ${memoId} name the file?` }),
      msg({ id: 'system-memo', kind: 'memo', channel: 'system', text: `Memo ${memoId}` }),
    ] });
    const log = await mount();
    const card = await within(log).findByRole('article', { name: 'Leader memo' });
    await userEvent.click(within(card).getByText('The Leader’s note'));
    expect(within(card).getByText(/Review these actions before deciding\./)).toHaveTextContent('Review these actions before deciding.');
    expect(within(card).getByText(/file\(/)).toHaveTextContent(`file(${actionId}).ts`);
    expect(within(card).queryByText(`Memo ${memoId}`)).toBeNull();
    expect(within(log).getByText(`Please keep Memo ${memoId} exactly.`)).toBeInTheDocument();
    expect(within(log).getByText(`Does Memo ${memoId} name the file?`)).toBeInTheDocument();
    const system = log.querySelector('[data-message-id="system-memo"]');
    expect(system).toHaveTextContent('Memo');
    expect(system).not.toHaveTextContent(memoId);
    setMutationToken(TOKEN);
    await userEvent.click(within(card).getByRole('button', { name: 'Approve: Raise Grok to 3 lanes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this action?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(net.posts().some((call) => call.url === `/api/verse/leader/actions/${actionId}/approve`)).toBe(true));
    expect(net.thread[0]!.text).toBe(raw);
  });
});


describe('shared typed Leader question controls', () => {
  const revision = Array(8).fill('a'.repeat(8)).join('-');
  const question = (mode: QuestionForm['mode'] = 'multiple', questionId = 'memo:0'): LeaderQuestionProjection => ({
    questionId, text: 'Which improvements matter most?', askedAt: new Date().toISOString(), messageId: 'q-message', answered: false, answer: null,
    questionForm: { schemaVersion: 1, revision, mode, ...(mode !== 'short-answer' ? { options: ['Startup speed', 'Reliable agents'] } : {}),
      expiresAt: new Date(Date.now() + 86400000).toISOString() },
  });
  const saved = (q: LeaderQuestionProjection, indices = [0]): LeaderQuestionProjection => {
    const text = indices.map(index => q.questionForm!.options![index]).join('; '); const at = new Date().toISOString();
    return { ...q, answered: true, answer: { text, at, channel: 'verse', messageId: 'a-message',
      typedAcceptance: { schemaVersion: 1, formRevision: q.questionForm!.revision, kind: 'options', optionIndices: indices, text, at, messageId: 'a-message' } } };
  };
  function mountForm(q: LeaderQuestionProjection, store: QuestionFormStore = new Map(), disabledReason: string | null = null) {
    const legacy = vi.fn(async () => true); const result = vi.fn();
    const writtenComposer = vi.fn((props: LeaderComposerProps) => <LeaderComposer {...props} />);
    const props = { questionId: q.questionId, store, disabledReason, fallbackText: q.text, requestSubmit: (run: () => Promise<void>) => { void run(); },
      onLegacyAnswer: legacy, onResult: result, showQuestion: true, renderWrittenAnswer: writtenComposer };
    return { ...render(<LeaderQuestionForm {...props} />), props, legacy, result, store, writtenComposer };
  }
  it('single choice and Select all/Clear change only local accessible controls; Submit sends stable indices once', async () => {
    setMutationToken(TOKEN); const q = question(); let current = q;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined,
      onPost: (_url, body) => { expect(body).toEqual({ submission: { schemaVersion: 1, formRevision: revision, kind: 'options', optionIndices: [0, 1] } });
        current = saved(q, [0, 1]); return json({ outcome: 'recorded', question: current, message: null, reply: null }); } });
    mountForm(q); await screen.findByRole('checkbox', { name: 'Startup speed' });
    await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByRole('checkbox', { name: 'Reliable agents' })).toBeChecked(); expect(net.posts()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' })); expect(screen.getByRole('checkbox', { name: 'Startup speed' })).not.toBeChecked();
    expect(net.posts()).toHaveLength(0); await userEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' })); await waitFor(() => expect(net.posts()).toHaveLength(1));
    await screen.findByText(/Your answer is saved/); expect(net.posts()[0]!.body).not.toHaveProperty('text');
  });
  it('keeps radio selection and a separately keyed revised draft across rerenders', async () => {
    const q = question('single'); let current = q;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined });
    const view = mountForm(q); const radio = await screen.findByRole('radio', { name: 'Reliable agents' }); await userEvent.click(radio);
    view.rerender(<LeaderQuestionForm {...view.props} revisionHint={revision} />); expect(radio).toBeChecked(); expect(net.posts()).toHaveLength(0);
    current = { ...q, questionForm: { ...q.questionForm!, revision: Array(8).fill('b'.repeat(8)).join('-'), options: ['New first', 'New second'] } };
    view.rerender(<LeaderQuestionForm {...view.props} revisionHint={Array(8).fill('b'.repeat(8)).join('-')} />);
    expect(await screen.findByRole('radio', { name: 'New second' })).not.toBeChecked();
    expect(view.store.get(q.questionId)?.drafts[revision]?.indices).toEqual([1]); expect(net.posts()).toHaveLength(0);
  });
  it('makes Write an answer an explicit legacy send, never a choice-form typed text submission', async () => {
    const q = question('single'); const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: q, typedQuestionsSupported: true }) : undefined });
    const view = mountForm(q); await screen.findByRole('radio', { name: 'Startup speed' });
    await userEvent.click(screen.getByRole('button', { name: 'Write an answer' }));
    expect(view.writtenComposer).toHaveBeenCalled();
    const text = screen.getByRole('textbox', { name: 'Your answer' });
    await userEvent.type(text, 'My own direction');
    fireEvent.keyDown(text, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(text, { key: 'Enter', shiftKey: true });
    expect(view.legacy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(view.legacy).toHaveBeenCalledWith('My own direction')); expect(net.posts()).toHaveLength(0);
  });
  it.each([401, 404, 409, 503])('holds HTTP%s exact reads instead of exposing a legacy fallback', async status => {
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ error: 'Question unavailable', code: 'VERSE_NOT_FOUND' }, status) : undefined });
    mountForm(question()); await screen.findByText(/Your draft is kept/);
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull(); expect(net.posts()).toHaveLength(0);
  });
  it.each([null, { schemaVersion: 2 }, { schemaVersion: 1, revision: 'invalid' }])('holds malformed supplied authoritative form metadata instead of enabling a legacy composer', async questionForm => {
    const q = { ...question(), questionForm };
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: q, typedQuestionsSupported: true }) : undefined });
    mountForm(question()); await screen.findByText(/Your draft is kept/);
    expect(screen.queryByRole('textbox')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull(); expect(net.posts()).toHaveLength(0);
  });
  it('reconciles lost responses only against exact accepted revision/value and never resends automatically', async () => {
    setMutationToken(TOKEN); const q = question(); let current = q;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined,
      onPost: () => { current = saved(q); throw new TypeError('lost response'); } });
    mountForm(q); await userEvent.click(await screen.findByRole('checkbox', { name: 'Startup speed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await screen.findByText(/Your submitted answer is saved/); expect(net.posts()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' })); expect(net.posts()).toHaveLength(1);
  });
  it('does not call an answer from another device this request saved', async () => {
    setMutationToken(TOKEN); const q = question(); let current = q;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined,
      onPost: () => { current = saved(q, [1]); throw new TypeError('lost'); } });
    mountForm(q); await userEvent.click(await screen.findByRole('checkbox', { name: 'Startup speed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await screen.findByText(/revision or value differs from this request/); expect(screen.queryByText(/Your submitted answer is saved/)).toBeNull(); expect(net.posts()).toHaveLength(1);
  });
  it('keeps text typed while a short-answer request is in flight', async () => {
    setMutationToken(TOKEN); const q = question('short-answer'); let release!: (response: Response) => void;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: q, typedQuestionsSupported: true }) : undefined,
      onPost: () => new Promise<Response>(resolve => { release = resolve; }) });
    const view = mountForm(q); const text = await screen.findByRole('textbox', { name: 'Your answer' });
    await userEvent.type(text, 'First'); await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await waitFor(() => expect(net.posts()).toHaveLength(1)); await userEvent.type(text, ' and next');
    const at = new Date().toISOString(); const answered = { ...q, answered: true, answer: { text: 'First', at, channel: 'verse', messageId: 'a',
      typedAcceptance: { schemaVersion: 1, formRevision: revision, kind: 'text', text: 'First', at, messageId: 'a' } } };
    await act(async () => release(json({ outcome: 'recorded', question: answered, message: null, reply: null })));
    await screen.findByText(/Your answer is saved/); expect(view.store.get(q.questionId)?.drafts[revision]?.text).toBe('First and next');
  });
  it('does not let an earlier display GET overwrite a subsequently recorded submission', async () => {
    setMutationToken(TOKEN); const q = question(); let reads = 0; let old!: (response: Response) => void;
    const net = stub({ onGet: url => url.includes('/questions/') ? ++reads === 2
      ? new Promise<Response>(resolve => { old = resolve; }) : json({ question: q, typedQuestionsSupported: true }) : undefined,
      onPost: () => json({ outcome: 'recorded', question: saved(q), message: null, reply: null }) });
    mountForm(q); await userEvent.click(await screen.findByRole('checkbox', { name: 'Startup speed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' })); await waitFor(() => expect(old).toBeTypeOf('function'));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' })); await screen.findByText(/Your answer is saved/);
    await act(async () => old(json({ question: q, typedQuestionsSupported: true })));
    expect(screen.getByText(/Answered · Startup speed/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(net.posts()).toHaveLength(1);
  });
  it('keeps a newer form revision visible when an older submission response settles', async () => {
    setMutationToken(TOKEN); const q = question(); let current = q; let release!: (response: Response) => void;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined,
      onPost: () => new Promise<Response>(resolve => { release = resolve; }) });
    const view = mountForm(q); await userEvent.click(await screen.findByRole('checkbox', { name: 'Startup speed' }));
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' })); await waitFor(() => expect(net.posts()).toHaveLength(1));
    current = { ...q, questionForm: { ...q.questionForm!, revision: Array(8).fill('b'.repeat(8)).join('-'), options: ['Current choice'] } };
    view.rerender(<LeaderQuestionForm {...view.props} revisionHint={current.questionForm!.revision} />);
    await screen.findByRole('checkbox', { name: 'Current choice' });
    await act(async () => release(json({ outcome: 'recorded', question: saved(q), message: null, reply: null })));
    expect(screen.getByRole('checkbox', { name: 'Current choice' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Startup speed' })).toBeNull(); expect(net.posts()).toHaveLength(1);
    expect(view.result).not.toHaveBeenCalled();
  });
  it('fences a delayed earlier-revision GET for the same question identity', async () => {
    let old!: (response: Response) => void; const first = question(); let reads = 0;
    const second = { ...first, text: 'Revised question?', questionForm: { ...first.questionForm!, revision: Array(8).fill('b'.repeat(8)).join('-'), options: ['Current choice'] } };
    const net = stub({ onGet: url => url.includes('/questions/') ? ++reads === 1
      ? new Promise<Response>(resolve => { old = resolve; }) : json({ question: second, typedQuestionsSupported: true }) : undefined });
    const view = mountForm(first); await waitFor(() => expect(old).toBeTypeOf('function'));
    view.rerender(<LeaderQuestionForm {...view.props} revisionHint={second.questionForm.revision} />);
    await screen.findByRole('checkbox', { name: 'Current choice' });
    await act(async () => old(json({ question: first, typedQuestionsSupported: true })));
    expect(screen.getByText('Revised question?')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Startup speed' })).toBeNull(); expect(net.posts()).toHaveLength(0);
  });
  it('shows a canonically normalized saved text without attributing a different value to this request', async () => {
    setMutationToken(TOKEN); const q = question('short-answer'); let current = q;
    const net = stub({ onGet: url => url.includes('/questions/') ? json({ question: current, typedQuestionsSupported: true }) : undefined,
      onPost: () => { const at = new Date().toISOString(); current = { ...q, answered: true, answer: { text: '[email]', at, channel: 'verse', messageId: 'a',
        typedAcceptance: { schemaVersion: 1, formRevision: revision, kind: 'text', text: '[email]', at, messageId: 'a' } } };
        return json({ outcome: 'recorded', question: current, message: null, reply: null }); } });
    const view = mountForm(q); await userEvent.type(await screen.findByRole('textbox', { name: 'Your answer' }), 'person@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Submit answer' }));
    await screen.findByText(/Delivery is uncertain/); await userEvent.click(screen.getByRole('button', { name: 'Check saved answer' }));
    await screen.findByText(/A saved answer is visible, but its revision or value differs/);
    expect(view.store.get(q.questionId)?.drafts[revision]?.text).toBe('person@example.com');
    expect(screen.queryByRole('button', { name: 'Retry the same submission' })).toBeNull(); expect(net.posts()).toHaveLength(1);
  });
  it('fences a delayed old-question GET when the same mounted form changes question ID', async () => {
    let old!: (response: Response) => void; const first = question(); const second = { ...question('single', 'memo:1'), text: 'Second question?' };
    stub({ onGet: url => url.endsWith('/memo:0') ? new Promise<Response>(resolve => { old = resolve; }) :
      url.endsWith('/memo:1') ? json({ question: second, typedQuestionsSupported: true }) : undefined });
    const view = mountForm(first); await waitFor(() => expect(old).toBeTypeOf('function'));
    view.rerender(<LeaderQuestionForm {...view.props} questionId={second.questionId} />);
    await screen.findByText('Second question?'); await act(async () => old(json({ question: first, typedQuestionsSupported: true })));
    expect(screen.getByText('Second question?')).toBeInTheDocument(); expect(screen.queryByText(first.text)).toBeNull();
  });
});


it('opens a canonical typed question outside the thread page without converting its clipped title into a message', async () => {
  setMutationToken(TOKEN);
  const revision = Array(8).fill('c'.repeat(8)).join('-');
  const question = { questionId: 'memo-0924:8', text: 'Complete canonical question, including all context?', askedAt: new Date().toISOString(),
    messageId: 'q-old', answered: false, answer: null, questionForm: { schemaVersion: 1, revision, mode: 'multiple',
      options: ['Startup speed', 'Phone controls'], expiresAt: new Date(Date.now() + 86400000).toISOString() } };
  const net = stub({ thread: threadMessages().filter(message => message.kind !== 'question'),
    onGet: url => url.endsWith('/memo-0924:8') ? json({ question, typedQuestionsSupported: true }) : undefined,
    onPost: (_url, body) => json({ message: msg({ id: 'interjection', from: 'mason', text: String(body['text']), at: now() }), reply: null }) });
  await mount(); await screen.findByText('Status?');
  act(() => requestLeaderFocus({ kind: 'question', questionId: question.questionId, text: 'Clipped summary…' }));
  await screen.findByText(question.text); await userEvent.click(screen.getByRole('checkbox', { name: 'Phone controls' }));
  expect(net.posts()).toHaveLength(0); expect(screen.queryByText('Answering: Clipped summary…')).toBeNull();
  await userEvent.type(composer(), 'Also inspect the tests{Enter}');
  await waitFor(() => expect(net.posts()).toHaveLength(1));
  expect(net.posts()[0]!.body).toEqual({ text: 'Also inspect the tests' });
  expect(screen.getByRole('checkbox', { name: 'Phone controls' })).toBeChecked();
});
