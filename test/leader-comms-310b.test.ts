/**
 * V3.10 B-U8 — the `leader-veto` comms handler: a class-B Leader action can be
 * vetoed from Mason's message channel (Telegram / iMessage). A veto only
 * lowers what autonomy is doing, so a reply is enough. Transports are mocked:
 * nothing is sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as string[] }));

vi.mock('../src/core/integrations/imessage.js', () => ({
  sendIMessage: vi.fn(async (text: string) => { sent.push(text); return true; }),
}));
vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async (text: string) => { sent.push(text); return true; }),
  telegramEnabled: () => false,
  pollTelegramUpdates: vi.fn(async () => []),
  answerCallbackQuery: vi.fn(async () => undefined),
}));

import * as dispatchModule from '../src/core/comms/dispatch.js';
import { registerCommsHandlers } from '../src/core/comms/handlers.js';
import type { CommsRequest } from '../src/core/comms/requests.js';
import { enactLeaderActions, findStoredAction } from '../src/core/vision/leader-apply.js';
import { actionIdFor, writeLeaderMemo } from '../src/core/vision/leader-memo.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { fakeLedger, makeApplyDeps, useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
beforeEach(() => { home.setup(); sent.length = 0; });
afterEach(() => home.teardown());

const MEMO = 'lm-20260924120000-abcdef';

function captureHandler(want = 'leader-veto'): (req: CommsRequest) => Promise<void> {
  let captured: ((req: CommsRequest) => void | Promise<void>) | undefined;
  const spy = vi.spyOn(dispatchModule, 'registerResolutionHandler').mockImplementation((kind, fn) => {
    if (kind === want) captured = fn as typeof captured;
  });
  registerCommsHandlers({} as AshlrConfig);
  spy.mockRestore();
  if (!captured) throw new Error(`${want} handler not registered`);
  const fn = captured;
  return async (req) => { await fn(req); };
}

function request(answerIndex: number, actionId: unknown): CommsRequest {
  return {
    id: 'r1', kind: 'leader-veto', type: 'question', text: 't', options: ['Veto', 'Let it apply'],
    meta: { actionId }, status: 'answered', answerIndex, createdAt: new Date().toISOString(),
  };
}

describe('leader-veto comms handler', () => {
  it('reply 1 (Veto) cancels a scheduled class-B action and confirms; reply 2 does nothing', async () => {
    const { deps } = makeApplyDeps({ ledger: fakeLedger() });
    const [b] = await enactLeaderActions(deps, MEMO, [{ kind: 'lanes.grok', params: { slots: 3 }, summary: 'Raise grok', why: 'w' }], [], {
      idFor: (i) => actionIdFor(MEMO, i),
    });
    expect(b!.status).toBe('scheduled');
    const handler = captureHandler();

    await handler(request(1, b!.id));
    expect(findStoredAction(b!.id)?.action.status).toBe('scheduled');
    expect(sent).toEqual([]);

    await handler(request(0, b!.id));
    expect(findStoredAction(b!.id)?.action.status).toBe('vetoed');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^Vetoed:/);
  });

  it('ignores a malformed action id', async () => {
    const handler = captureHandler();
    await handler(request(0, '../../etc/passwd'));
    expect(sent).toEqual([]);
  });
});

describe('Leader memo replies (the \'elon-vision\' wire kind, meta.source leader)', () => {
  function memoRequest(answerIndex: number, memoId: unknown): CommsRequest {
    return {
      id: 'r2', kind: 'elon-vision', type: 'question', text: 't', options: ['Keep it', 'Veto this memo', 'Show full memo'],
      meta: { source: 'leader', memoId }, status: 'answered', answerIndex, createdAt: new Date().toISOString(),
    };
  }

  function writeMemo(actions: LeaderMemo['actions']): void {
    writeLeaderMemo({
      v: 1, id: MEMO, at: '2026-09-24T12:00:00.000Z', trigger: 'manual', status: 'ok', statusReason: null, dryRun: false,
      seatId: 'local:q', model: 'q', evidenceDigest: 'd',
      bottleneck: { statement: 'Too many open goals', metric: 'active-goals', evidence: [] },
      move: { statement: 'Prune to four goals', why: 'focus', expectedDelta: { metric: 'active-goals', delta: -2, byDate: '2026-09-30' } },
      killList: [], goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [],
      questionsForMason: ['Team plan or local enforcement?'], actions,
    } as unknown as LeaderMemo);
  }

  it('Keep it does nothing; Veto this memo undoes its live actions; Show sends the memo as text', async () => {
    const { deps } = makeApplyDeps({ ledger: fakeLedger() });
    const actions = await enactLeaderActions(deps, MEMO, [{ kind: 'lanes.grok', params: { slots: 3 }, summary: 'Raise grok', why: 'w' }], [], {
      idFor: (i) => actionIdFor(MEMO, i),
    });
    writeMemo(actions);
    const handler = captureHandler('elon-vision');

    await handler(memoRequest(0, MEMO));
    expect(sent).toEqual([]);
    expect(findStoredAction(actions[0]!.id)?.action.status).toBe('scheduled');

    await handler(memoRequest(2, MEMO));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('BOTTLENECK: Too many open goals');
    expect(sent[0]).toContain('MOVE: Prune to four goals (active-goals -2 by 2026-09-30)');
    expect(sent[0]).toContain('[B] scheduled — Raise grok');
    expect(sent[0]).not.toMatch(/elon|musk/i);

    await handler(memoRequest(1, MEMO));
    expect(findStoredAction(actions[0]!.id)?.action.status).toBe('vetoed');
    expect(sent[1]).toMatch(/^Vetoed:/);
  });

  it('ignores a malformed memo id', async () => {
    const handler = captureHandler('elon-vision');
    await handler(memoRequest(2, '../../etc/passwd'));
    await handler(memoRequest(1, 'lm-1'));
    expect(sent).toEqual([]);
  });
});
