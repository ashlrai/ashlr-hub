import { describe, expect, it } from 'vitest';
import {
  answeredQuestions,
  AWAIT_REPLY_MS,
  awaitingReply,
  dayLabel,
  findQuestion,
  groupThread,
  latestLeaderMessage,
  mergeThread,
  narrowDirectives,
  narrowMessage,
  narrowSendResult,
  narrowThreadPage,
  parseNeedsYouQuestion,
  previewText,
  type PendingMessage,
  type ThreadEntry,
} from './thread-model.js';
import { needsYouQuestionText } from './question-id.js';
import { msg, QUESTION_TEXT, threadMessages } from './thread-fixtures.test-support.js';

const NOW = Date.parse('2026-09-26T15:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const MIN = 60_000;

function pending(over: Partial<PendingMessage> = {}): PendingMessage {
  return { clientId: 'local-1', kind: 'message', text: 'Ship it?', at: iso(NOW), replyTo: null, questionId: null, state: 'sending', error: null, ...over };
}

const keys = (entries: ThreadEntry[]) => entries.map((e) => e.key);

describe('narrowing', () => {
  it('reads a contract message and keeps the optional fields it can trust', () => {
    const m = narrowMessage({ id: 'x', at: iso(NOW), from: 'leader', channel: 'telegram', kind: 'memo', text: 'hi', memoId: 'm1', actionIds: ['a1', 3, ''], delivery: { telegram: 'sent', n: 2 } });
    expect(m).toMatchObject({ id: 'x', channel: 'telegram', kind: 'memo', memoId: 'm1', actionIds: ['a1'], delivery: { telegram: 'sent' } });
  });

  it('drops a message it cannot read — never guesses a sender or a time', () => {
    expect(narrowMessage({ id: 'x', at: 'yesterday', from: 'leader', text: 'hi' })).toBeNull();
    expect(narrowMessage({ id: 'x', at: iso(NOW), from: 'robot', text: 'hi' })).toBeNull();
    expect(narrowMessage({ id: '', at: iso(NOW), from: 'leader', text: 'hi' })).toBeNull();
    expect(narrowMessage(null)).toBeNull();
  });

  it('reads an unknown channel or kind from a newer server as a plain Verse message', () => {
    expect(narrowMessage({ id: 'x', at: iso(NOW), from: 'leader', channel: 'slack', kind: 'poll', text: 'hi' })).toMatchObject({ channel: 'verse', kind: 'message' });
  });

  it('reads a page, dropping only the unreadable messages', () => {
    const page = narrowThreadPage({ messages: [{ id: 'a', at: iso(NOW), from: 'mason', text: 'ok' }, { nope: true }] });
    expect(page?.messages.map((m) => m.id)).toEqual(['a']);
    expect(narrowThreadPage({ items: [] })).toBeNull();
  });

  it('reads a send result; an unreadable reply is null, not an error', () => {
    const r = narrowSendResult({ message: { id: 'a', at: iso(NOW), from: 'mason', text: 'ok' }, reply: { bad: 1 } });
    expect(r).toMatchObject({ message: { id: 'a' }, reply: null, directive: null });
    expect(narrowSendResult({ reply: null })).toBeNull();
  });

  it('keeps only ACTIVE directives, oldest first, whatever the server calls the time', () => {
    const list = narrowDirectives({
      directives: [
        { id: 'd2', text: 'Second', addedAt: iso(NOW) },
        { id: 'd1', text: ' First ', at: iso(NOW - MIN), source: 'telegram' },
        { id: 'd0', text: 'Gone', at: iso(NOW - 2 * MIN), retiredAt: iso(NOW) },
        { id: 'd3', text: '   ' },
      ],
    });
    expect(list?.map((d) => [d.id, d.text, d.channel])).toEqual([
      ['d1', 'First', 'telegram'],
      ['d2', 'Second', null],
    ]);
  });
});

describe('mergeThread', () => {
  it('orders every message by time and shows each once, the server read winning over a send echo', () => {
    const a = msg({ id: 'a', at: iso(NOW - 2 * MIN), text: 'old' });
    const b = msg({ id: 'b', at: iso(NOW - MIN), text: 'server copy' });
    const echo = msg({ id: 'b', at: iso(NOW - MIN), text: 'echo' });
    const older = msg({ id: 'z', at: iso(NOW - 10 * MIN) });
    const entries = mergeThread([[a, b], [older]], [echo]);
    expect(keys(entries)).toEqual(['z', 'a', 'b']);
    expect(entries[2]!.type === 'message' && entries[2]!.message.text).toBe('server copy');
  });

  it('drops an optimistic send the moment its server copy is in any list (even before the POST returns)', () => {
    const copy = msg({ id: 's1', at: iso(NOW + 1_000), from: 'mason', text: 'Ship  it?' });
    expect(keys(mergeThread([[copy]], [], [pending()]))).toEqual(['s1']);
    // Not yet on the server: the pending bubble stays, after what came before it.
    const before = msg({ id: 'p', at: iso(NOW - MIN) });
    expect(keys(mergeThread([[before]], [], [pending()]))).toEqual(['p', 'local-1']);
  });

  it('never lets one server message absorb two sends, nor an older message absorb a new send', () => {
    const copy = msg({ id: 's1', at: iso(NOW), from: 'mason', text: 'Ship it?' });
    const twice = [pending({ clientId: 'local-1' }), pending({ clientId: 'local-2', at: iso(NOW + 1) })];
    expect(keys(mergeThread([[copy]], [], twice))).toEqual(['s1', 'local-2']);
    const yesterday = msg({ id: 'y', at: iso(NOW - 86_400_000), from: 'mason', text: 'Ship it?' });
    expect(keys(mergeThread([[yesterday]], [], [pending()]))).toEqual(['y', 'local-1']);
  });

  it('keeps a failed send even when the same words arrived (it is a separate attempt the operator must settle)', () => {
    const copy = msg({ id: 's1', at: iso(NOW), from: 'mason', text: 'Ship it?' });
    expect(keys(mergeThread([[copy]], [], [pending({ state: 'failed', error: 'No.' })]))).toEqual(['s1', 'local-1']);
  });
});

describe('groupThread', () => {
  it('folds consecutive messages from one sender on one channel into one run, with day separators', () => {
    const t = Date.parse('2026-09-26T14:00:00');
    const rows = groupThread(
      [
        msg({ id: 'y', at: iso(t - 86_400_000) }),
        msg({ id: 'a', at: iso(t) }),
        msg({ id: 'b', at: iso(t + MIN) }),
        msg({ id: 'c', at: iso(t + 2 * MIN), channel: 'telegram' }),
        msg({ id: 'd', at: iso(t + 3 * MIN), from: 'mason' }),
        msg({ id: 'e', at: iso(t + 20 * MIN), from: 'mason' }),
      ].map((m) => ({ type: 'message' as const, key: m.id, at: m.at, message: m })),
      t + 30 * MIN,
    );
    expect(rows.map((r) => (r.type === 'day' ? r.label : r.type === 'group' ? r.entries.map((e) => e.key).join('+') : r.key))).toEqual([
      'Yesterday',
      'y',
      'Today',
      'a+b',
      'c',
      'd',
      // More than GROUP_GAP_MS later: a new run with its own header.
      'e',
    ]);
  });

  it('gives memos and directives a run of their own and system lines their own row', () => {
    const entries = threadMessages(NOW).map((m) => ({ type: 'message' as const, key: m.id, at: m.at, message: m }));
    const rows = groupThread(entries, NOW).filter((r) => r.type !== 'day');
    expect(rows.map((r) => (r.type === 'group' ? `${r.from}:${r.entries.map((e) => e.key).join('+')}` : `${r.type}:${r.key}`))).toEqual([
      'mason:t1',
      'leader:t2',
      'leader:t3',
      'leader:t4',
      'mason:t5',
      'system:t6',
      'mason:t7',
      'leader:t8',
    ]);
  });

  it('labels days in words', () => {
    const now = Date.parse('2026-09-26T12:00:00');
    expect(dayLabel(iso(now), now)).toBe('Today');
    expect(dayLabel(iso(now - 86_400_000), now)).toBe('Yesterday');
    expect(dayLabel('2026-09-21T12:00:00', now)).toBe('Mon, Sep 21');
    expect(dayLabel('2025-12-31T12:00:00', now)).toBe('Wed, Dec 31, 2025');
  });
});

describe('questions', () => {
  const list = threadMessages(NOW);

  it('marks a question answered by its question id or by a reply to it', () => {
    expect(answeredQuestions(list).size).toBe(0);
    const byId = [...list, msg({ id: 'a1', from: 'mason', kind: 'answer', questionId: 'q-memo-0924-0', text: 'Propose-only.' })];
    expect(answeredQuestions(byId).get('t4')?.id).toBe('a1');
    const byReply = [...list, msg({ id: 'a2', from: 'mason', replyTo: 't4', text: 'Propose-only.' })];
    expect(answeredQuestions(byReply).get('t4')?.id).toBe('a2');
  });

  it('finds the question a Needs-you row means, most certain match first', () => {
    const needsYouId = 'leader:leader-question:memo-0924:0';
    expect(parseNeedsYouQuestion(needsYouId)).toEqual({ memoId: 'memo-0924', index: 0 });
    expect(parseNeedsYouQuestion('leader:class-c:a4')).toBeNull();
    // The server reused the Needs-you id as its question id.
    expect(findQuestion([...list, msg({ id: 'q9', kind: 'question', questionId: needsYouId, text: 'x' })], { questionId: needsYouId })?.id).toBe('q9');
    // A `<memoId>:<index>` spelling.
    expect(findQuestion([msg({ id: 'q8', kind: 'question', questionId: 'lq:memo-0924:0', text: 'x' })], { questionId: needsYouId })?.id).toBe('q8');
    // The memo's question with the same words.
    expect(findQuestion(list, { questionId: needsYouId, text: QUESTION_TEXT.slice(0, 40) })?.id).toBe('t4');
    // The memo's index-th question.
    expect(findQuestion(list, { memoId: 'memo-0924', index: 0 })?.id).toBe('t4');
    expect(findQuestion(list, { memoId: 'memo-0924', index: 3 })).toBeNull();
  });

  it('reads the question text from a Needs-you row', () => {
    expect(needsYouQuestionText({ title: 'Leader question: Keep it?', detail: null })).toBe('Keep it?');
    expect(needsYouQuestionText({ title: 'Leader question: Keep…', detail: 'Keep it all?' })).toBe('Keep it all?');
  });
});

describe('awaitingReply', () => {
  const entry = (m: ReturnType<typeof msg>): ThreadEntry => ({ type: 'message', key: m.id, at: m.at, message: m });

  it('is true while a send is in flight', () => {
    expect(awaitingReply([{ type: 'pending', key: 'l', at: iso(NOW), pending: pending() }], new Set(), NOW)).toBe(true);
    expect(awaitingReply([{ type: 'pending', key: 'l', at: iso(NOW), pending: pending({ state: 'failed' }) }], new Set(), NOW)).toBe(false);
  });

  it('waits for the Leader after a send it will answer later — only for this tab’s send, and not forever', () => {
    const sent = msg({ id: 's', at: iso(NOW), from: 'mason', text: 'Hi' });
    expect(awaitingReply([entry(sent)], new Set(['s']), NOW + 1_000)).toBe(true);
    expect(awaitingReply([entry(sent)], new Set(), NOW + 1_000)).toBe(false);
    expect(awaitingReply([entry(sent)], new Set(['s']), NOW + AWAIT_REPLY_MS + 1)).toBe(false);
    const reply = msg({ id: 'r', at: iso(NOW + 2_000), text: 'Hello' });
    expect(awaitingReply([entry(sent), entry(reply)], new Set(['s']), NOW + 3_000)).toBe(false);
    // A system line after the send does not count as the Leader's answer.
    const system = msg({ id: 'x', at: iso(NOW + 2_000), channel: 'system', text: 'Telegram connected.' });
    expect(awaitingReply([entry(sent), entry(system)], new Set(['s']), NOW + 3_000)).toBe(true);
  });
});

describe('preview', () => {
  it('finds the newest Leader message on any channel, never a system line', () => {
    const list = threadMessages(NOW);
    expect(latestLeaderMessage(list)?.id).toBe('t8');
    expect(latestLeaderMessage([msg({ id: 's', channel: 'system' }), msg({ id: 'm', from: 'mason' })])).toBeNull();
  });

  it('turns Markdown into one plain line clipped on a word', () => {
    expect(previewText('## Plan\n\n- **Raise** Grok to `3` lanes\n- see [the memo](https://x)')).toBe('Plan Raise Grok to 3 lanes see the memo');
    expect(previewText('```ts\nconst x = 1;\n```\nDone.')).toBe('Done.');
    const long = previewText('word '.repeat(60), 40);
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).not.toMatch(/\s…$/);
  });
});
