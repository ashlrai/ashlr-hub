/**
 * V3.10 B-U8 — `/api/verse/leader*` and the Leader's Needs-you producer (R1).
 *
 * Drives the real handler in-process with a readable-stream request and a
 * recording response (the production mutation gate, body reader and sendJson
 * sanitizer all run) under a tmp HOME, with the Leader's deps injected: fake
 * ledger, fake units, a local seat whose model is a stub. No socket is bound,
 * nothing spawns, nothing is prompted.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLeaderNeedsYou,
  handleLeaderApi,
  latestMemoAt,
  needsYouItems,
  needsYouSourceState,
  refreshLeaderCache,
  resetLeaderApiCacheForTest,
  setLeaderApiHooksForTest,
} from '../src/core/verse/leader-api.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import { enactLeaderActions, readLeaderDirectives } from '../src/core/vision/leader-apply.js';
import { actionIdFor, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import type { LeaderRunDeps } from '../src/core/vision/leader.js';
import type { LeaderAction, LeaderStateV1 } from '../src/core/vision/leader-types.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const TOKEN = 'leader-test-token';
const home = useTmpHome();
let ctx: VerseApiContext;
let ledger: FakeLedger;
let runDeps: LeaderRunDeps;
const MEMO = 'lm-20260924120000-abcdef';

interface Reply { status: number; body: unknown }

/** One request through the real handler, no socket: a stream for the body, a recorder for the response. */
async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Object.assign(Readable.from(payload.length > 0 ? [Buffer.from(payload)] : []), {
    method,
    url,
    headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const recorder: { headersSent: boolean; writeHead(code: number): unknown; setHeader(): unknown; end(chunk?: string): unknown } = {
    headersSent: false,
    writeHead(code: number) { status = code; recorder.headersSent = true; return recorder; },
    setHeader() { return recorder; },
    end(chunk?: string) { text += chunk ?? ''; return recorder; },
  };
  const res = recorder as unknown as ServerResponse;
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleLeaderApi(ctx, req, res, path, method);
  if (!handled) return { status: 404, body: { error: 'fallthrough' } };
  return { status, body: text ? JSON.parse(text) : null };
}

beforeEach(() => {
  home.setup();
  resetLeaderApiCacheForTest();
  ledger = fakeLedger();
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  const { deps: apply } = makeApplyDeps({ ledger, policy: () => makePolicy() });
  runDeps = {
    cfg: {} as AshlrConfig,
    now: () => Date.now(),
    apply,
    sources: {
      standingPolicy: () => makePolicy(),
      budgetPolicy: () => defaultBudgetPolicy(),
      capacity: () => null,
      goals: () => ({ goals: [], complete: true }),
      readLedger: (o) => ledger.read(o),
      holds: () => [],
      quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: 0, acceptRate: 0, verifyPassRate: 0 }),
      models: () => [],
      reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }),
    },
    seat: {
      cfg: {} as AshlrConfig,
      now: () => Date.now(),
      candidates: async () => [],
      capacitySnapshot: () => null,
      budgetPolicy: () => defaultBudgetPolicy(),
      standingPolicy: () => makePolicy(),
      clampBudget: (p) => p,
      route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
      capacityFromSeat: (s) => capacityFromSeat(s),
      recordDecision: () => undefined,
      transports: {
        local: () => async () => '{}',
        grok: () => async () => { throw new Error('no'); },
        claude: () => async () => { throw new Error('no'); },
      },
    },
  };
  setLeaderApiHooksForTest({ loadRunDeps: async () => runDeps });
});

afterEach(() => {
  setLeaderApiHooksForTest({});
  home.teardown();
});

async function post<T>(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const r = await call('POST', '/api/verse/leader', body, headers);
  return { status: r.status, body: r.body as T };
}

async function getState(): Promise<{ status: number; body: LeaderStateV1 }> {
  const r = await call('GET', '/api/verse/leader');
  return { status: r.status, body: r.body as LeaderStateV1 };
}

function draft(kind: AnyLeaderActionDraft['kind'], params: unknown, summary = `${kind} now`): AnyLeaderActionDraft {
  return { kind, params, summary, why: 'argument' } as AnyLeaderActionDraft;
}

describe('GET', () => {
  it('serves LeaderStateV1 even before any memo exists', async () => {
    const { status, body } = await getState();
    expect(status).toBe(200);
    expect(body).toMatchObject({ v: 1, latest: null, timeline: [], actions: [], runsToday: 0, hitRate: { rate: null } });
    expect(typeof body.nextRunAt).toBe('string');
  });

  it('refuses query parameters and unknown sub-paths', async () => {
    expect((await call('GET', '/api/verse/leader?x=1')).status).toBe(400);
    expect((await call('GET', '/api/verse/leader/memos/lm-20260924120000-zzzzzz')).status).toBe(404);
    expect((await call('GET', '/api/verse/leader/other')).status).toBe(404);
    expect((await call('GET', '/api/verse/leaderboard')).status).toBe(404);
  });
});

describe('POST', () => {
  it('needs the mutation token and dispatch permission', async () => {
    expect((await post({ action: 'run' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    ctx = { ...ctx, allowDispatch: false };
    expect((await post({ action: 'run' })).status).toBe(404);
  });

  it('rejects unknown actions, unknown keys and malformed ids', async () => {
    expect((await post({ action: 'apply', actionId: 'x' })).status).toBe(400);
    expect((await post({ action: 'veto', actionId: 'la-20260924120000-abcdef-0', force: true })).status).toBe(400);
    expect((await post({ action: 'veto', actionId: '../../x' })).status).toBe(400);
    expect((await post({ action: 'veto', actionId: 'la-20260924120000-abcdef-0', note: 'x'.repeat(501) })).status).toBe(400);
    expect((await post({ action: 'dismiss', itemId: 'leader:veto-window:x' })).status).toBe(400);
  });

  it('veto undoes an applied action; a second veto is 409; unknown is 404', async () => {
    const [a] = await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 1 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
    const res = await post<{ result: { records: { restored: boolean }[] }; state: LeaderStateV1 }>({ action: 'veto', actionId: a!.id, note: 'no' });
    expect(res.status).toBe(200);
    expect(res.body.result.records[0]!.restored).toBe(true);
    expect(res.body.state.actions[0]).toMatchObject({ id: a!.id, status: 'vetoed' });
    expect(readLeaderDirectives()).toBeNull();
    expect((await post({ action: 'veto', actionId: a!.id })).status).toBe(409);
    expect((await post({ action: 'veto', actionId: 'la-20260924120000-abcdef-9' })).status).toBe(404);
  });

  it('veto-memo undoes the whole memo', async () => {
    await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 1 }), draft('router.tune', { tuning: { lambdaCost: 2 } })], [], {
      idFor: (i) => actionIdFor(MEMO, i),
    });
    const res = await post<{ result: { records: unknown[] } }>({ action: 'veto-memo', memoId: MEMO });
    expect(res.status).toBe(200);
    expect(res.body.result.records).toHaveLength(2);
    expect(readLeaderDirectives()).toBeNull();
  });

  it('run starts in the background (202) and reports no-seat honestly', async () => {
    const res = await post<{ accepted: boolean }>({ action: 'run' });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    // The run finishes quickly here (no seat) — poll the state.
    let state: LeaderStateV1 | null = null;
    for (let i = 0; i < 50; i += 1) {
      state = (await getState()).body;
      if (state.lastRun) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(state?.lastRun).toMatchObject({ outcome: 'no-seat' });
    expect(state?.timeline[0]).toMatchObject({ status: 'no-seat' });
  });
});

describe('needsYouItems (R1)', () => {
  it('never throws on a cold poll: [] and a warming state, then answers from memory', async () => {
    resetLeaderApiCacheForTest();
    expect(needsYouSourceState()).toBe('warming');
    expect(needsYouItems()).toEqual([]);
    await refreshLeaderCache();
    expect(needsYouSourceState()).toBe('ok');
    expect(needsYouItems()).toEqual([]);
    expect(latestMemoAt()).toBeNull();
  });

  it('the first poll after a fresh import already serves real items (the import awaits the warm-up)', async () => {
    await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 3 }, 'Raise grok to 3 lanes')], [], { idFor: (i) => actionIdFor(MEMO, i) });
    vi.resetModules();
    const fresh = await import('../src/core/verse/leader-api.js');
    expect(fresh.needsYouSourceState()).toBe('ok');
    expect(fresh.needsYouItems().map((i) => i.kind)).toEqual(['veto-window']);
  });

  it('a cache loaded for another HOME is never served', async () => {
    await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 3 }, 'Raise grok to 3 lanes')], [], { idFor: (i) => actionIdFor(MEMO, i) });
    await refreshLeaderCache();
    expect(needsYouItems()).toHaveLength(1);
    const saved = process.env['HOME'];
    const other = mkdtempSync(join(tmpdir(), 'ashlr-leader-api-other-'));
    process.env['HOME'] = other;
    try {
      expect(needsYouSourceState()).toBe('warming');
      expect(needsYouItems()).toEqual([]);
      await refreshLeaderCache();
      expect(needsYouItems()).toEqual([]);
      expect(needsYouSourceState()).toBe('ok');
    } finally {
      process.env['HOME'] = saved;
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('lists class-B windows with Veto, class-C asks and questions with Dismiss — all valid NeedsYouItems', async () => {
    const actions = await enactLeaderActions(runDeps.apply, MEMO, [
      draft('lanes.grok', { slots: 3 }, 'Raise grok to 3 lanes'),
      draft('escalate', { request: 'Add ashlrai/locus to the grant', argument: 'It is ready' }),
      draft('budget.mode', { to: 'all-in' }),
    ], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['scheduled', 'escalated', 'escalated']);
    await refreshLeaderCache();
    const items = needsYouItems();
    expect(items.map((i) => i.kind)).toEqual(['veto-window', 'class-c', 'class-c']);
    for (const item of items) expect(isNeedsYouItem(item)).toBe(true);
    const veto = items[0]!;
    expect(veto).toMatchObject({ severity: 'high', expiresAt: actions[0]!.applyAfter, source: 'leader' });
    expect(veto.actions[0]).toMatchObject({ kind: 'veto', destructive: true, request: { path: '/api/verse/leader', body: { action: 'veto', actionId: actions[0]!.id } } });

    // Veto it through the drawer's own request, then dismiss an ask.
    const vetoRes = await post(veto.actions[0]!.request!.body);
    expect(vetoRes.status).toBe(200);
    const ask = items[1]!;
    expect((await post(ask.actions[0]!.request!.body)).status).toBe(200);
    const after = needsYouItems();
    expect(after.map((i) => i.id)).toEqual([items[2]!.id]);
  });

  it('buildLeaderNeedsYou: windows expire, questions come from the newest ok memo for 7 days', () => {
    const now = Date.parse('2026-09-24T12:00:00.000Z');
    const expired = { id: 'la-1', class: 'B', status: 'scheduled', applyAfter: '2026-09-24T11:00:00.000Z', createdAt: '2026-09-24T10:30:00.000Z',
      kind: 'harness.adopt', params: {}, summary: 's', why: 'w', statusReason: null } as unknown as LeaderAction;
    const memo = { id: MEMO, at: '2026-09-20T00:00:00.000Z', status: 'ok' as const, questionsForMason: ['Team plan or local enforcement?'] };
    const items = buildLeaderNeedsYou([expired], memo, new Set(), now);
    expect(items.map((i) => i.kind)).toEqual(['leader-question']);
    expect(items[0]).toMatchObject({ target: { kind: 'section', section: 'mind', anchor: MEMO } });
    expect(isNeedsYouItem(items[0])).toBe(true);
    expect(buildLeaderNeedsYou([], memo, new Set([`leader:leader-question:${MEMO}:0`]), now)).toEqual([]);
    expect(buildLeaderNeedsYou([], memo, new Set(), now + 8 * 86_400_000)).toEqual([]);
  });
});
