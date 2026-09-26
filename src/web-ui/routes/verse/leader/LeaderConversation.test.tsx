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
import { LeaderConversation } from './LeaderConversation.js';
import { getLeaderFocus, requestLeaderFocus, resetLeaderFocus } from './leader-focus.js';
import { directives, msg, QUESTION_TEXT, threadMessages } from './thread-fixtures.test-support.js';
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
          ? json({ message: msg({ id: 'a1', from: 'mason', kind: 'answer', questionId: 'q-memo-0924-0', replyTo: 't4', at: now(), text: String(body['text']) }), reply: msg({ id: 'r4', at: now(), text: 'Understood: propose-only.' }) })
          : undefined,
    });
    const log = await mount();
    const q = await within(log).findByRole('article', { name: 'Leader question' });
    await userEvent.type(within(q).getByRole('textbox'), 'Propose-only until CI{Enter}');
    await waitFor(() => expect(s.posts()).toEqual([{ url: '/api/verse/leader/questions/q-memo-0924-0/answer', method: 'POST', body: { text: 'Propose-only until CI' } }]));
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
    const s = stub({ onPost: (_u, body) => json({ directive: { id: 'd9', text: body['text'], at: now() } }) });
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
    requestLeaderFocus({ kind: 'question', questionId: 'leader:leader-question:memo-0924:0', memoId: 'memo-0924', index: 0, text: QUESTION_TEXT });
    const log = await mount();
    const q = await within(log).findByRole('article', { name: 'Leader question' });
    await waitFor(() => expect(within(q).getByRole('textbox')).toHaveFocus());
    expect(getLeaderFocus()).toBeNull();
  });

  it('a question the thread does not carry is answered as a quoted message', async () => {
    setMutationToken(TOKEN);
    const s = stub({ thread: threadMessages().filter((m) => m.kind !== 'question') });
    await mount();
    await screen.findByText('Status?');
    act(() => requestLeaderFocus({ kind: 'question', questionId: 'leader:leader-question:memo-0924:1', memoId: 'memo-0924', index: 1, text: 'Keep Codex off?' }));
    await screen.findByText('Answering: Keep Codex off?');
    await waitFor(() => expect(composer()).toHaveFocus());
    await userEvent.type(composer(), 'Yes{Enter}');
    await waitFor(() => expect(s.posts()[0]?.body).toEqual({ text: '> Keep Codex off?\n\nYes' }));
    expect(screen.queryByText('Answering: Keep Codex off?')).toBeNull();
  });
});
