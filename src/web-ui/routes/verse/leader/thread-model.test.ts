import { narrowQuestionProjection, narrowQuestionSubmitResult, matchesQuestionAcceptance } from './question-model.js';
import { describe, expect, it } from 'vitest';
import {
  answeredQuestions,
  AWAIT_REPLY_MS,
  awaitingReply,
  dayLabel,
  displayThreadText,
  findQuestion,
  groupThread,
  latestLeaderMessage,
  mergeThread,
  narrowDirectives,
  narrowApprovalThread,
  narrowMessage,
  narrowQuestionForm,
  narrowSendResult,
  narrowThreadPage,
  previewText,
  type PendingMessage,
  type ThreadEntry,
} from './thread-model.js';
import { needsYouQuestionText, questionIdOfNeedsYouItem } from './question-id.js';
import { directive, msg, threadMessages } from './thread-fixtures.test-support.js';

const NOW = Date.parse('2026-09-26T15:00:00Z');
const iso = (t: number) => new Date(t).toISOString();
const MIN = 60_000;

function pending(over: Partial<PendingMessage> = {}): PendingMessage {
  return { clientId: 'local-1', kind: 'message', text: 'Ship it?', at: iso(NOW), replyTo: null, questionId: null, state: 'sending', error: null, ...over };
}

const keys = (entries: ThreadEntry[]) => entries.map((e) => e.key);

describe('narrowing', () => {
  it('reads a contract message and keeps the optional fields it can trust', () => {
    const m = narrowMessage({ id: 'x', at: iso(NOW), from: 'leader', channel: 'telegram', kind: 'memo', text: 'hi', memoId: 'm1', questionId: '', actionIds: ['a1', 3, ''], delivery: { telegram: 'sent', sentAt: iso(NOW), n: 2 } });
    expect(m).toEqual({ id: 'x', at: iso(NOW), from: 'leader', channel: 'telegram', kind: 'memo', text: 'hi', memoId: 'm1', actionIds: ['a1'], delivery: { telegram: 'sent', sentAt: iso(NOW) } });
    // Only the contract's delivery states are kept.
    expect(narrowMessage({ id: 'y', at: iso(NOW), from: 'mason', text: 'ok', delivery: { telegram: 'maybe' } })).not.toHaveProperty('delivery');
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

  it('reads `{ directives, retired }` as the directives in force, oldest first', () => {
    const list = narrowDirectives({
      directives: [
        directive({ id: 'd2', text: 'Second', createdAt: iso(NOW) }),
        directive({ id: 'd1', text: ' First ', createdAt: iso(NOW - MIN), channel: 'telegram' }),
        // A retired one in the live list (a stale read) is still not a chip.
        directive({ id: 'd0', text: 'Gone', createdAt: iso(NOW - 2 * MIN), retiredAt: iso(NOW) }),
        { id: 'd3', text: '   ' },
      ],
      retired: [directive({ id: 'd9', text: 'Old', retiredAt: iso(NOW) })],
    });
    expect(list?.map((d) => [d.id, d.text, d.channel])).toEqual([
      ['d1', 'First', 'telegram'],
      ['d2', 'Second', 'verse'],
    ]);
    expect(narrowDirectives([directive({ id: 'd1', text: 'x' })])).toBeNull();
  });

  it('reads an approval’s thread messages; a body without them is empty', () => {
    const message = msg({ id: 'ap', from: 'mason', kind: 'action', actionIds: ['a2'], text: 'Approved.' });
    const reply = msg({ id: 'ack', kind: 'action', actionIds: ['a2'], text: 'Applied now.' });
    expect(narrowApprovalThread({ ok: true, code: 200, outcome: 'applied', message: 'Applied.', action: null, thread: { message, reply } }).map((m) => m.id)).toEqual(['ap', 'ack']);
    expect(narrowApprovalThread({ ok: false, code: 404, outcome: null, message: 'Unknown.', action: null, thread: null })).toEqual([]);
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
    const byId = [...list, msg({ id: 'a1', from: 'mason', kind: 'answer', questionId: 'memo-0924:0', text: 'Propose-only.' })];
    expect(answeredQuestions(byId).get('t4')?.id).toBe('a1');
    const byReply = [...list, msg({ id: 'a2', from: 'mason', replyTo: 't4', text: 'Propose-only.' })];
    expect(answeredQuestions(byReply).get('t4')?.id).toBe('a2');
  });

  it('finds the question a Needs-you row means — exactly: the item id minus its prefix is the questionId', () => {
    const questionId = questionIdOfNeedsYouItem('leader:leader-question:memo-0924:0');
    expect(questionId).toBe('memo-0924:0');
    expect(questionIdOfNeedsYouItem('leader:class-c:a4')).toBeNull();
    expect(questionIdOfNeedsYouItem('leader:leader-question:memo-0924')).toBeNull();
    expect(findQuestion(list, { questionId })?.id).toBe('t4');
    // No fuzzy fallbacks: another question of the same memo is not this one.
    expect(findQuestion(list, { questionId: 'memo-0924:1' })).toBeNull();
    expect(findQuestion(list, { questionId: null })).toBeNull();
    // An answer carries the questionId too; only a question matches.
    expect(findQuestion([msg({ id: 'a', from: 'mason', kind: 'answer', questionId: 'memo-0924:0' })], { questionId })).toBeNull();
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


describe('generated Leader display projection', () => {
  const memoId = 'lm-20261005153000-abcdef';
  const actionId = 'la-20261005153000-abcdef-1';
  const raw = `Memo ${memoId}\n• [B] Read "file(${actionId}).ts" — scheduled (${actionId})\nApprove or veto any of them by id.`;

  it('hides generated metadata only, retaining the literal summary, amounts and immutable identity', () => {
    const source = Object.freeze(msg({ id: 'stable-message', from: 'leader', kind: 'memo', memoId, actionIds: [actionId], text: raw }));
    expect(displayThreadText(source)).toBe(`Memo\n• [B] Read "file(${actionId}).ts" — scheduled\nReview these actions before deciding.`);
    expect(source.text).toBe(raw);
    expect(source.memoId).toBe(memoId);
    expect(source.actionIds).toEqual([actionId]);
    expect(displayThreadText(msg({ id: 'action', kind: 'action', text: `Approved ${actionId}: $12.50, 1018.63 credits, 15000 tokens, v3.24.3` })))
      .toBe('Approved action: $12.50, 1018.63 credits, 15000 tokens, v3.24.3');
  });

  it('keeps model questions, updates, directives, ordinary conversation and every Mason kind exact', () => {
    for (const kind of ['question', 'update', 'directive', 'message', 'answer'] as const) {
      expect(displayThreadText(msg({ id: kind, from: 'leader', kind, text: raw }))).toBe(raw);
    }
    for (const kind of ['memo', 'action', 'question', 'answer', 'message', 'update', 'directive'] as const) {
      expect(displayThreadText(msg({ id: kind, from: 'mason', kind, text: raw }))).toBe(raw);
    }
  });

  it('preserves code, quoted action-shaped lines, links and footer literals without altering timestamps', () => {
    const literal = `\`Memo ${memoId}\` https://example.com/${actionId}\n\`\`\`\n• [B] literal — scheduled (${actionId})\nApprove or veto any of them by id.\n\`\`\`\n"Approve or veto any of them by id."\n"quoted"Approve or veto any of them by id.\n2026-10-05T15:30:00.000Z`;
    expect(displayThreadText(msg({ id: 'literal', kind: 'memo', text: literal }))).toBe(literal);
  });
});


describe('typed question projections', () => {
  const revision = Array(8).fill('a'.repeat(8)).join('-');
  const form = { schemaVersion: 1, revision, mode: 'multiple', options: ['Speed', 'Reliability'], expiresAt: '2027-01-01T00:00:00Z' };
  const question = { questionId: 'memo:0', text: 'Which improvements?', askedAt: '2026-10-01T00:00:00Z', messageId: 'question-message',
    questionForm: form, answered: false, answer: null };
  it('retains readable questions but drops unknown/invalid optional form metadata', () => {
    expect(narrowMessage({ ...msg({ id: 'question-valid-form', kind: 'question' }), questionForm: form })?.questionForm).toEqual(form);
    expect(narrowMessage({ ...msg({ id: 'question-newer-form', kind: 'question', text: 'Literal question' }), questionForm: { ...form, schemaVersion: 2 } }))
      .toMatchObject({ text: 'Literal question' });
    expect(narrowQuestionForm({ ...form, options: ['duplicate', 'duplicate'] })).toBeNull();
    expect(narrowQuestionForm({ ...form, mode: 'short-answer' })).toBeNull();
    expect(narrowQuestionForm({ ...form, options: [2001] })).toBeNull();
    expect(narrowQuestionForm({ ...form, expiresAt: 'unknown' })).toBeNull();
    expect(narrowQuestionForm({ ...form, options: ['Only one'] })?.options).toEqual(['Only one']);
  });
  it('narrows recorded-once outcomes without requiring a thread reply or inventing success', () => {
    expect(narrowQuestionSubmitResult({ outcome: 'held', question: null, message: null, reply: null })?.outcome).toBe('held');
    expect(narrowQuestionSubmitResult({ outcome: 'stale', question, message: null, reply: null })?.message).toBeNull();
    expect(narrowQuestionSubmitResult({ outcome: 'ok', question })).toBeNull();
    expect(narrowQuestionProjection({ ...question, answered: true, answer: null })).toBeNull();
  });
  it('holds an explicitly malformed authoritative form but keeps a genuinely legacy form-less projection', () => {
    expect(narrowQuestionProjection({ ...question, questionForm: undefined })).not.toBeNull();
    expect(narrowQuestionProjection({ ...question, questionForm: null })).toBeNull();
    expect(narrowQuestionProjection({ ...question, questionForm: { ...form, schemaVersion: 2 } })).toBeNull();
    expect(narrowQuestionForm({ ...form, revision: 'a'.repeat(64) })).toBeNull();
  });
  it('requires exact revision and value, independent of answered state and channel', () => {
    const submission = { schemaVersion: 1 as const, formRevision: revision, kind: 'options' as const, optionIndices: [1, 0] };
    const answer = { text: 'Speed; Reliability', at: '2026-10-02T00:00:00Z', channel: 'telegram', messageId: 'answer-message',
      typedAcceptance: { schemaVersion: 1, formRevision: revision, kind: 'options', optionIndices: [0, 1], text: 'Speed; Reliability',
        at: '2026-10-02T00:00:00Z', messageId: 'answer-message' } };
    const accepted = narrowQuestionProjection({ ...question, answered: true, answer })!;
    expect(matchesQuestionAcceptance(accepted, submission)).toBe(true);
    expect(narrowQuestionProjection({ ...question, answered: true, answer: { ...answer, typedAcceptance: { ...answer.typedAcceptance,
      kind: 'text', optionIndices: undefined } } })?.answer).not.toHaveProperty('typedAcceptance');
    expect(matchesQuestionAcceptance(accepted, { ...submission, optionIndices: [0] })).toBe(false);
    expect(matchesQuestionAcceptance(accepted, { ...submission, formRevision: Array(8).fill('b'.repeat(8)).join('-') })).toBe(false);
    expect(matchesQuestionAcceptance(narrowQuestionProjection({ ...question, answered: true, answer: { ...answer, typedAcceptance: undefined } })!, submission)).toBe(false);
    expect(narrowQuestionProjection({ ...question, answered: true, answer: { ...answer,
      typedAcceptance: { ...answer.typedAcceptance, messageId: 'forged' } } })?.answer).not.toHaveProperty('typedAcceptance');
  });
});
