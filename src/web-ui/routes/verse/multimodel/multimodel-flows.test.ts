/**
 * multimodel/multimodel-flows.test.ts — every multi-model action is a
 * sequence of ORDINARY session calls (create, zero-spend note, send, open):
 * Auto re-route, one-click handoff (plan carried, nothing sent), Compare
 * fan-out with fake seats, the Compare pick, cross-family review, and
 * cheap-first escalation.
 */
import { describe, expect, it, vi } from 'vitest';
import type { VerseCreateSessionRequest, VerseSession } from '../../../../core/verse/types.js';
import type { HandoffSessionInput } from '../context/context-queries.js';
import { escalate, looksLikePlan, pickWinner, quickHandoff, routeMessage, siblingRequest, startCompare, startReview, type FlowApi } from './multimodel-flows.js';

function session(over: Partial<VerseSession> = {}): VerseSession {
  return {
    id: 'src', title: 'Fix upload', projectPath: '/repo', extraRoots: ['/repo', '/lib'], workspaceId: 'ws', engine: 'claude', accountId: 'claude', seatId: 'claude', model: 'claude-opus-5-5',
    nativeSessionId: null, createdAt: '', updatedAt: '', status: 'idle', turnCount: 3,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null }, lastError: null, ...over,
  };
}

function fakeApi(opts: { failSeat?: string } = {}) {
  const calls: string[] = [];
  let n = 0;
  const api: FlowApi & { calls: string[] } = {
    calls,
    createSession: vi.fn(async (req: VerseCreateSessionRequest) => {
      calls.push(`create:${req.seatId}`);
      if (req.seatId === opts.failSeat) throw new Error('Signed out — reconnect this account.');
      n += 1;
      return session({ id: `new${n}`, seatId: req.seatId, turnCount: 0 });
    }),
    createHandoffSession: vi.fn(async (input: HandoffSessionInput) => {
      calls.push(`handoff:${input.seatId}`);
      if (input.seatId === opts.failSeat) throw new Error('Signed out — reconnect this account.');
      n += 1;
      return session({ id: `new${n}`, seatId: input.seatId, turnCount: 0, handoffFrom: { sessionId: input.source.id, title: input.source.title } });
    }),
    fetchHandoffPreview: vi.fn(async (id: string, req?: { includeLastAssistant?: boolean }) => {
      calls.push(`preview:${id}${req?.includeLastAssistant ? '+last' : ''}`);
      return { sourceSessionId: id, sourceTitle: 'Fix upload', text: 'HANDOFF NOTE', stats: { chars: 12, estTokens: 3, turnsCovered: 3, filesTouched: 2, truncated: [] } };
    }),
    sendTurn: vi.fn(async (id: string) => { calls.push(`send:${id}`); return { turnId: 't', session: session({ id }) }; }),
    link: vi.fn(async (req) => { calls.push(`link:${req.parentSessionId}->${req.childSessionId}:${req.relation}`); return true; }),
    outcome: vi.fn(async (req) => { calls.push(`outcome:${req.seatId}:${req.signal}`); return true; }),
    saveDraft: vi.fn((id: string) => { calls.push(`draft:${id}`); }),
    open: vi.fn((id: string) => { calls.push(`open:${id}`); }),
  };
  return api;
}

const CODEX = { seatId: 'codex-personal', model: 'gpt-5.5', label: 'Personal Codex', engine: 'codex' };
const LOCAL = { seatId: 'local:q', model: 'q', label: 'Qwen (local)', engine: 'local' };

describe('routeMessage — Auto sends this message to another seat', () => {
  it('mid-thread: zero-spend note, handoff chat, ONE turn (note + message), then open it', async () => {
    const api = fakeApi();
    const created = await routeMessage(api, { source: session(), target: CODEX, text: 'review it', kind: 'review' });
    expect(created.id).toBe('new1');
    expect(api.calls).toEqual(['preview:src', 'handoff:codex-personal', 'send:new1', 'outcome:codex-personal:auto-followed', 'open:new1']);
    expect(api.sendTurn).toHaveBeenCalledWith('new1', 'HANDOFF NOTE\n\n---\n\nThe request to answer now:\n\nreview it');
  });

  it('a chat with no turns yet: a plain chat on the same pinned roots, the message as-is', async () => {
    const api = fakeApi();
    await routeMessage(api, { source: session({ turnCount: 0 }), target: CODEX, text: 'hi', kind: 'question' });
    expect(api.fetchHandoffPreview).not.toHaveBeenCalled();
    expect(api.createSession).toHaveBeenCalledWith({ projectPath: '/repo', seatId: 'codex-personal', extraRoots: ['/lib'], model: 'gpt-5.5' });
    expect(api.sendTurn).toHaveBeenCalledWith('new1', 'hi');
  });

  it('an override is learned from: the chosen seat gets switch-to, the passed-over Auto choice auto-overridden', async () => {
    const api = fakeApi();
    await routeMessage(api, { source: session(), target: CODEX, text: 'x', kind: 'code', overridden: { seatId: 'local:q' } });
    expect(api.calls).toContain('outcome:codex-personal:switch-to');
    expect(api.calls).toContain('outcome:local:q:auto-overridden');
  });

  it('a refused turn surfaces as an error and nothing is opened', async () => {
    const api = fakeApi();
    api.sendTurn = vi.fn(async () => { throw new Error('seat-not-ready'); });
    await expect(routeMessage(api, { source: session(), target: CODEX, text: 'x', kind: 'code' })).rejects.toThrow('seat-not-ready');
    expect(api.open).not.toHaveBeenCalled();
  });
});

describe('quickHandoff — one click from the seat chip', () => {
  it('builds the note, creates the chat, PREFILLS the note and opens it — sends nothing', async () => {
    const api = fakeApi();
    await quickHandoff(api, { source: session(), target: CODEX, lastAssistant: 'Done.', kind: 'code' });
    expect(api.calls).toEqual(['preview:src', 'handoff:codex-personal', 'draft:new1', 'outcome:claude:switch-away', 'outcome:codex-personal:switch-to', 'open:new1']);
    expect(api.saveDraft).toHaveBeenCalledWith('new1', 'HANDOFF NOTE');
    expect(api.sendTurn).not.toHaveBeenCalled();
  });

  it('carries the last answer verbatim when it is a plan', async () => {
    const api = fakeApi();
    await quickHandoff(api, { source: session(), target: CODEX, lastAssistant: '## Plan\n1. a\n2. b', kind: 'plan' });
    expect(api.calls[0]).toBe('preview:src+last');
    expect(looksLikePlan('1. read\n2. write\n3. test')).toBe(true);
    expect(looksLikePlan('- [ ] a\n- [x] b\n- [ ] c')).toBe(true);
    expect(looksLikePlan('I changed two files.')).toBe(false);
    expect(looksLikePlan(null)).toBe(false);
  });
});

describe('startCompare — the same prompt to several seats', () => {
  it('fans out with fake seats: one note, a linked chat per seat, one failure isolated', async () => {
    const api = fakeApi({ failSeat: 'codex-personal' });
    const entries = await startCompare(api, { source: session(), targets: [{ seatId: 'claude-b', model: null, label: 'Claude B', engine: 'claude' }, CODEX, LOCAL], text: 'why is CI slow?' });
    expect(api.fetchHandoffPreview).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => [e.target.seatId, e.ok])).toEqual([['claude-b', true], ['codex-personal', false], ['local:q', true]]);
    expect(api.calls.filter((c) => c.startsWith('link:'))).toEqual(['link:src->new1:compare', 'link:src->new2:compare']);
    expect(api.createHandoffSession).toHaveBeenCalledWith(expect.objectContaining({ seatId: 'local:q', title: 'Fix upload · Qwen (local)' }));
    for (const call of (api.sendTurn as ReturnType<typeof vi.fn>).mock.calls) expect(call[1]).toBe('HANDOFF NOTE\n\n---\n\nThe request to answer now:\n\nwhy is CI slow?');
  });

  it('from a fresh chat there is no note and chats are plain siblings', async () => {
    const api = fakeApi();
    await startCompare(api, { source: session({ turnCount: 0 }), targets: [CODEX, LOCAL], text: 'hello' });
    expect(api.fetchHandoffPreview).not.toHaveBeenCalled();
    expect(api.createSession).toHaveBeenCalledTimes(2);
    expect((api.sendTurn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])).toEqual(['hello', 'hello']);
  });

  it('pickWinner records one win and the losses, then opens the winner', async () => {
    const api = fakeApi();
    await pickWinner(api, { winnerSessionId: 'b', entries: [{ sessionId: 'a', seatId: 'claude', engine: 'claude' }, { sessionId: 'b', seatId: 'local:q', engine: 'local' }], kind: 'code' });
    expect(api.calls).toEqual(['outcome:claude:compare-lost', 'outcome:local:q:compare-won', 'open:b']);
  });
});

describe('startReview — cross-family review in one click', () => {
  it('a sibling chat on the reviewer, linked as a review, with the answer quoted', async () => {
    const api = fakeApi();
    const created = await startReview(api, { source: session(), reviewer: CODEX, question: 'add a cache', answer: 'Added an LRU.', authorLabel: 'Claude Max' });
    expect(created.id).toBe('new1');
    expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ seatId: 'codex-personal', title: 'Review · Fix upload' }));
    expect(api.calls).toContain('link:src->new1:review');
    const text = (api.sendTurn as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(text).toContain('another model (Claude Max)');
    expect(text).toContain('Added an LRU.');
    expect(api.open).not.toHaveBeenCalled(); // shown side by side, not navigated to
  });
});

describe('escalate — cheap-first', () => {
  it('continues on the frontier seat with the draft quoted, links it, and marks the local seat escalated', async () => {
    const api = fakeApi();
    const source = session({ id: 'loc', seatId: 'local:q', engine: 'local', turnCount: 1 });
    await escalate(api, { source, target: { seatId: 'claude', model: null, label: 'Claude Max', engine: 'claude' }, question: 'add a retry', draft: 'maybe a loop?', verdict: { escalate: true, confidence: 0.3, reasons: ['The answer hedges.'] }, draftLabel: 'Qwen (local)', kind: 'code' });
    expect(api.calls).toEqual(['preview:loc', 'handoff:claude', 'link:loc->new1:escalate', 'send:new1', 'outcome:local:q:escalated', 'open:new1']);
    const text = (api.sendTurn as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(text.startsWith('HANDOFF NOTE')).toBe(true);
    expect(text).toContain('> maybe a loop?');
  });
});

describe('siblingRequest', () => {
  it('reuses the pinned roots, never the workspace id, and caps the title', () => {
    const req = siblingRequest(session(), CODEX, 'x'.repeat(200));
    expect(req).toMatchObject({ projectPath: '/repo', extraRoots: ['/lib'], seatId: 'codex-personal', model: 'gpt-5.5' });
    expect(req).not.toHaveProperty('workspaceId');
    expect(req.title).toHaveLength(120);
  });
});
