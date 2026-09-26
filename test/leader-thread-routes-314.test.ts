/**
 * 3.14 — the Leader thread's HTTP routes, Needs-you actions and CLI.
 *
 * Drives the real `/api/verse/leader*` handler in-process (production
 * mutation gate, body reader and sendJson sanitizer) and the real
 * `ashlr leader` CLI, under a tmp HOME with a fake local seat. No socket,
 * no model, no network, nothing sent.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildLeaderNeedsYou,
  handleLeaderApi,
  needsYouItems,
  refreshLeaderCache,
  resetLeaderApiCacheForTest,
  setLeaderApiHooksForTest,
} from '../src/core/verse/leader-api.js';
import { isNeedsYouItem } from '../src/core/verse/workbench-types.js';
import { setLeaderThreadDepsForTest, listThread, syncLeaderMemosToThread } from '../src/core/vision/leader-thread.js';
import { listOperatorDirectives, questionIdFor } from '../src/core/vision/leader-operator.js';
import { LEADER_QUESTION_ITEM_PREFIX } from '../src/core/vision/leader-thread-types.js';
import { enactLeaderActions, findStoredAction, readLeaderDirectives } from '../src/core/vision/leader-apply.js';
import { actionIdFor, writeLeaderMemo, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import type { LeaderRunDeps } from '../src/core/vision/leader.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import { runLeaderCli } from '../src/cli/leader.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const TOKEN = 'leader-thread-test-token';
const MEMO = 'lm-20260926120000-abcdef';
const home = useTmpHome();
let ctx: VerseApiContext;
let ledger: FakeLedger;
let runDeps: LeaderRunDeps;
let replies: string[];
let policy: EffectivePolicy | null;

interface Reply { status: number; body: any }

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
  const path = new URL(url, 'http://localhost').pathname;
  const handled = await handleLeaderApi(ctx, req, recorder as unknown as ServerResponse, path, method);
  if (!handled) return { status: 404, body: { error: 'fallthrough' } };
  return { status, body: text ? JSON.parse(text) : null };
}

function draft(kind: AnyLeaderActionDraft['kind'], params: unknown, summary = `${kind} now`): AnyLeaderActionDraft {
  return { kind, params, summary, why: 'argument' } as AnyLeaderActionDraft;
}

function memo(): LeaderMemo {
  return {
    v: 1, id: `lm-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-fedcba`, at: new Date().toISOString(), status: 'ok',
    statusReason: null, trigger: 'manual', dryRun: true, seatId: null, model: null, evidenceDigest: 'd',
    bottleneck: { statement: 'Review latency', metric: null, evidence: [] }, move: { statement: 'Cut the queue', why: 'w', expectedDelta: null },
    killList: [], goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [],
    questionsForMason: ['Team plan for binshield?'], actions: [],
  };
}

beforeEach(() => {
  home.setup();
  resetLeaderApiCacheForTest();
  ledger = fakeLedger();
  replies = [];
  policy = null;
  ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true };
  const { deps: apply } = makeApplyDeps({ ledger, policy: () => policy });
  const local = {
    seat: {
      id: 'local:qwen', engine: 'local' as const, label: 'Qwen', accountId: 'local',
      models: [{ id: 'qwen', label: 'q', contextWindow: 65_536 }], contextWindow: 65_536,
      health: { state: 'ready' as const, summary: null, windows: [], observedAt: null },
    },
    launcher: null,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  };
  runDeps = {
    cfg: {} as AshlrConfig,
    now: () => Date.now(),
    apply,
    sources: {
      standingPolicy: () => policy,
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
      candidates: async () => [local],
      capacitySnapshot: () => null,
      budgetPolicy: () => defaultBudgetPolicy(),
      standingPolicy: () => policy,
      clampBudget: (p) => p,
      route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
      capacityFromSeat: (s) => capacityFromSeat(s),
      recordDecision: () => undefined,
      transports: {
        local: () => async () => {
          const next = replies.shift();
          if (next === undefined) throw new Error('no reply queued');
          return next;
        },
        grok: () => async () => { throw new Error('grok must not be called'); },
        claude: () => async () => { throw new Error('claude must not be called'); },
      },
    },
  };
  setLeaderApiHooksForTest({ loadRunDeps: async () => runDeps });
  setLeaderThreadDepsForTest({ loadRunDeps: async () => runDeps });
});

afterEach(() => {
  setLeaderApiHooksForTest({});
  setLeaderThreadDepsForTest(null);
  vi.restoreAllMocks();
  home.teardown();
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('thread routes', () => {
  it('POST /thread → {message, reply}; GET /thread lists it oldest first', async () => {
    replies.push(JSON.stringify({ reply: 'Ship billing. Everything else waits.' }));
    const res = await call('POST', '/api/verse/leader/thread', { text: 'What now?' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ from: 'mason', channel: 'verse', text: 'What now?' });
    expect(res.body.reply).toMatchObject({ from: 'leader', text: 'Ship billing. Everything else waits.', replyTo: res.body.message.id });
    expect(res.body.directive).toBeUndefined();
    const list = await call('GET', '/api/verse/leader/thread?limit=10');
    expect(list.status).toBe(200);
    expect(list.body.messages.map((m: { id: string }) => m.id)).toEqual([res.body.message.id, res.body.reply.id]);
    const before = await call('GET', `/api/verse/leader/thread?before=${res.body.reply.id}`);
    expect(before.body.messages.map((m: { id: string }) => m.id)).toEqual([res.body.message.id]);
  });

  it('POST /thread with a directive prefix returns the directive', async () => {
    replies.push(JSON.stringify({ reply: 'Understood.' }));
    const res = await call('POST', '/api/verse/leader/thread', { text: 'stop: dispatching to cortex' });
    expect(res.status).toBe(200);
    expect(res.body.directive).toMatchObject({ kind: 'stop', text: 'Stop dispatching to cortex', channel: 'verse' });
  });

  it('validates input, query and the mutation gate', async () => {
    expect((await call('POST', '/api/verse/leader/thread', { text: 'hi' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await call('POST', '/api/verse/leader/thread', { text: 'hi' }, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await call('POST', '/api/verse/leader/thread', { text: '' })).status).toBe(400);
    expect((await call('POST', '/api/verse/leader/thread', { text: 7 })).status).toBe(400);
    expect((await call('POST', '/api/verse/leader/thread', { text: 'hi', force: true })).status).toBe(400);
    expect((await call('POST', '/api/verse/leader/thread', { text: 'hi', replyTo: '../x' })).status).toBe(400);
    expect((await call('GET', '/api/verse/leader/thread?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/verse/leader/thread?limit=201')).status).toBe(400);
    expect((await call('GET', '/api/verse/leader/thread?x=1')).status).toBe(400);
    expect((await call('GET', '/api/verse/leader/thread?before=garbage')).status).toBe(400);
    ctx = { ...ctx, allowDispatch: false };
    expect((await call('POST', '/api/verse/leader/thread', { text: 'hi' })).status).toBe(404);
  });

  it('POST /questions/<id>/answer records the answer and hides the Needs-you question', async () => {
    const m = memo();
    writeLeaderMemo(m);
    syncLeaderMemosToThread();
    await refreshLeaderCache();
    expect(needsYouItems().map((i) => i.kind)).toEqual(['leader-question']);
    const qid = questionIdFor(m.id, 0)!;
    replies.push(JSON.stringify({ reply: 'Good. Team plan goes in the next memo.' }));
    const res = await call('POST', `/api/verse/leader/questions/${qid}/answer`, { text: 'Yes, team plan.' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatchObject({ kind: 'answer', questionId: qid });
    expect(res.body.reply.text).toBe('Good. Team plan goes in the next memo.');
    expect(needsYouItems()).toEqual([]);
    expect((await call('POST', '/api/verse/leader/questions/lm-20260101000000-abcdef:0/answer', { text: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/verse/leader/questions/nope/answer', { text: 'x' })).status).toBe(400);
    expect((await call('POST', `/api/verse/leader/questions/${qid}/answer`, { text: 'x', extra: 1 })).status).toBe(400);
  });

  it('POST /actions/<id>/approve applies a class-B action early through the grant checks', async () => {
    policy = makePolicy();
    const [action] = await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 3 }, 'Raise grok to 3 lanes')], [], { idFor: (i) => actionIdFor(MEMO, i) });
    await refreshLeaderCache();
    const window = needsYouItems().find((i) => i.kind === 'veto-window')!;
    const approve = window.actions.find((a) => a.kind === 'approve')!;
    expect(approve).toMatchObject({ label: 'Approve now', request: { method: 'POST', path: `/api/verse/leader/actions/${action!.id}/approve`, body: {} } });
    const res = await call('POST', approve.request!.path, approve.request!.body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: 'applied' });
    expect(readLeaderDirectives()!.grokLanes).toBe(3);
    expect(needsYouItems().filter((i) => i.kind === 'veto-window')).toEqual([]);
    expect((await call('POST', approve.request!.path, {})).status).toBe(409);
    expect((await call('POST', '/api/verse/leader/actions/la-20260101000000-abcdef-1/approve', {})).status).toBe(404);
    expect((await call('POST', '/api/verse/leader/actions/bad/approve', {})).status).toBe(400);
    expect((await call('POST', approve.request!.path, { force: true })).status).toBe(400);
  });

  it('approve in dry run records, never applies', async () => {
    const [action] = await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    const res = await call('POST', `/api/verse/leader/actions/${action!.id}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('recorded-dry-run');
    expect(findStoredAction(action!.id)!.action.status).toBe('refused');
    expect(readLeaderDirectives()).toBeNull();
  });

  it('directives: GET / POST / DELETE', async () => {
    expect((await call('GET', '/api/verse/leader/directives')).body).toEqual({ directives: [], retired: [] });
    const add = await call('POST', '/api/verse/leader/directives', { text: 'Revenue over polish', kind: 'priority' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ duplicate: false, directive: { kind: 'priority', text: 'Revenue over polish', source: 'direct' } });
    expect((await call('POST', '/api/verse/leader/directives', { text: 'revenue over polish' })).status).toBe(200);
    expect((await call('POST', '/api/verse/leader/directives', { text: 'x y z', kind: 'nope' })).status).toBe(400);
    expect((await call('POST', '/api/verse/leader/directives', { text: 'x y z', extra: 1 })).status).toBe(400);
    const id = add.body.directive.id as string;
    expect((await call('DELETE', `/api/verse/leader/directives/${id}`, undefined, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    const del = await call('DELETE', `/api/verse/leader/directives/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.directive.retiredAt).not.toBeNull();
    expect((await call('DELETE', `/api/verse/leader/directives/${id}`)).status).toBe(409);
    expect((await call('DELETE', '/api/verse/leader/directives/od-20260101000000-abcdef')).status).toBe(404);
    expect((await call('DELETE', '/api/verse/leader/directives/bad')).status).toBe(400);
    const list = await call('GET', '/api/verse/leader/directives');
    expect(list.body.directives).toEqual([]);
    expect(list.body.retired.map((d: { id: string }) => d.id)).toEqual([id]);
  });

  it('keeps the existing routes working', async () => {
    expect((await call('GET', '/api/verse/leader')).status).toBe(200);
    expect((await call('GET', '/api/verse/leader?x=1')).status).toBe(400);
    expect((await call('POST', '/api/verse/leader', { action: 'nope' })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Needs-you
// ---------------------------------------------------------------------------

describe('Needs-you actions (3.14)', () => {
  it('questions get Answer (a button-only fix action, no request) next to Dismiss; answered ones drop out', () => {
    const now = Date.now();
    const m = { id: MEMO, at: new Date(now - 60_000).toISOString(), status: 'ok' as const, questionsForMason: ['A?', 'B?'] };
    const items = buildLeaderNeedsYou([], m, new Set(), now);
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(isNeedsYouItem(item)).toBe(true);
      expect(item.actions.map((a) => [a.kind, a.label])).toEqual([['done', 'Dismiss'], ['fix', 'Answer']]);
      expect(item.actions[1]!.request).toBeNull();
    }
    const answered = buildLeaderNeedsYou([], m, new Set(), now, new Set([questionIdFor(MEMO, 0)!]));
    expect(answered.map((i) => i.id)).toEqual([`leader:leader-question:${MEMO}:1`]);
    // The questionId IS the item id's tail: the UI matches Needs-you → thread exactly.
    for (const [index, item] of items.entries()) {
      expect(item.id).toBe(`${LEADER_QUESTION_ITEM_PREFIX}${questionIdFor(MEMO, index)}`);
    }
  });

  it('the contract types module is browser-safe (no node: imports, type-only core imports)', () => {
    const src = readFileSync(new URL('../src/core/vision/leader-thread-types.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    for (const m of src.matchAll(/^import (.*) from '(.*)';$/gm)) expect(m[1]).toMatch(/^type /);
  });

  it('class-C asks keep Dismiss first and gain an Approve that records', async () => {
    policy = makePolicy();
    await enactLeaderActions(runDeps.apply, MEMO, [draft('escalate', { request: 'Add locus', argument: 'ready' })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    await refreshLeaderCache();
    const [ask] = needsYouItems();
    expect(isNeedsYouItem(ask)).toBe(true);
    expect(ask!.actions.map((a) => a.kind)).toEqual(['done', 'approve']);
    expect(ask!.actions[1]!.confirm!.body).toMatch(/outside the standing grant, so nothing is applied/);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('ashlr leader say / thread / answer / approve / directives', () => {
  function capture(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    return { out, err };
  }

  it('say prints the reply; thread lists the conversation', async () => {
    const io = capture();
    replies.push(JSON.stringify({ reply: 'Cut scope.' }));
    expect(await runLeaderCli(['say', 'What', 'now?'])).toBe(0);
    expect(io.out).toContain('Cut scope.');
    expect(listThread().map((m) => m.channel)).toEqual(['cli', 'cli']);
    expect(await runLeaderCli(['thread', '--limit', '5'])).toBe(0);
    expect(io.out.join('\n')).toMatch(/You \(cli\)[\s\S]*What now\?[\s\S]*Leader \(cli\)[\s\S]*Cut scope\./);
    expect(await runLeaderCli(['thread', '--json'])).toBe(0);
    expect(JSON.parse(io.out[io.out.length - 1]!).messages).toHaveLength(2);
    expect(await runLeaderCli(['say'])).toBe(2);
    expect(await runLeaderCli(['thread', '--limit'])).toBe(2);
  });

  it('say with a directive prefix reports the directive', async () => {
    const io = capture();
    replies.push(JSON.stringify({ reply: 'Noted.' }));
    expect(await runLeaderCli(['say', 'focus: billing'])).toBe(0);
    expect(io.out.join('\n')).toMatch(/Standing directive recorded: od-\d{14}-[a-f0-9]{6} \(focus\) Focus on billing/);
  });

  it('answer records; unknown / malformed ids fail with the right exit code', async () => {
    const io = capture();
    const m = memo();
    writeLeaderMemo(m);
    syncLeaderMemosToThread();
    replies.push(JSON.stringify({ reply: 'Thanks.' }));
    const qid = questionIdFor(m.id, 0)!;
    expect(await runLeaderCli(['answer', qid, 'Yes,', 'team', 'plan'])).toBe(0);
    expect(io.out).toContain(`Answer recorded for ${qid}.`);
    expect(await runLeaderCli(['answer', 'lm-20260101000000-abcdef:0', 'x'])).toBe(1);
    expect(await runLeaderCli(['answer', 'nope', 'x'])).toBe(2);
    expect(await runLeaderCli(['answer', qid])).toBe(2);
  });

  it('approve: dry run records (exit 0); not pending exits 1', async () => {
    const io = capture();
    const [action] = await enactLeaderActions(runDeps.apply, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(await runLeaderCli(['approve', action!.id])).toBe(0);
    expect(io.out.join('\n')).toMatch(/Recorded your approval/);
    expect(await runLeaderCli(['approve', 'la-20260101000000-abcdef-9'])).toBe(1);
    expect(await runLeaderCli(['approve'])).toBe(2);
  });

  it('directives add / list / retire', async () => {
    const io = capture();
    expect(await runLeaderCli(['directives', 'add', 'Revenue', 'over', 'polish', '--kind', 'priority'])).toBe(0);
    const [d] = listOperatorDirectives();
    expect(d).toMatchObject({ kind: 'priority', text: 'Revenue over polish', channel: 'cli' });
    expect(await runLeaderCli(['directives'])).toBe(0);
    expect(io.out.join('\n')).toContain(`${d!.id} [priority] Revenue over polish`);
    expect(await runLeaderCli(['directives', 'retire', d!.id])).toBe(0);
    expect(await runLeaderCli(['directives', 'retire', d!.id])).toBe(1);
    expect(await runLeaderCli(['directives', 'retire', 'bad'])).toBe(2);
    expect(await runLeaderCli(['directives', 'add', 'x y z', '--kind', 'nope'])).toBe(2);
    expect(await runLeaderCli(['directives', 'frobnicate'])).toBe(2);
    expect(await runLeaderCli(['directives', 'list', '--all', '--json'])).toBe(0);
    expect(JSON.parse(io.out[io.out.length - 1]!).directives).toHaveLength(1);
  });
});
