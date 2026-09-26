/**
 * 3.14 — Leader reliability: accurate evidence, a fallback seat, health and a
 * useful cadence.
 *
 *   1. Goal evidence: an incomplete goal-store read (a goal file with a 1970
 *      `updatedAt`, as on 2026-09-25) is a LOWER BOUND with a caveat — never
 *      `null` (which the model read as "zero active goals" while the digest
 *      showed 21) — and the Leader and the digest count the same open goals.
 *   2. Seat chain: router-approved seats in order grok → fast local → large
 *      local → (opt-in) Claude; never codex; per-attempt timeouts sized to the
 *      model; the memo records every attempt; a failed full run schedules a
 *      bounded retry.
 *   3. Health: GET-state carries `health` (healthy / degraded / down + why).
 *   4. Cadence: working-hours check-ins (advisory, cheap, material change
 *      only) under a total cap, and the poller's cheap wake check.
 *   (The streamed local transport is covered in leader-local-transport-314, real-io lane.)
 *
 * Hermetic: tmp HOME, fake ledger / sources / seats; no model is called.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildLeaderState,
  gatherLeaderEvidence,
  leaderRunDue,
  leaderWakeDue,
  measureLeaderMetric,
  readLeaderRunState,
  runLeader,
  type LeaderEvidenceSources,
  type LeaderRunDeps,
  type LeaderRunState,
} from '../src/core/vision/leader.js';
import {
  LeaderTimeoutError,
  planLeaderSeats,
  type LeaderCallOptions,
  type LeaderSeatCandidate,
  type LeaderSeatDeps,
} from '../src/core/vision/leader-seat.js';
import { leaderCallBudget, leaderContextTokens, localSpeedClass, orderLocalModels } from '../src/core/vision/leader-seat-plan.js';
import {
  LEADER_CHECKIN_SUFFIX,
  materialEvidenceDigest,
  resolveLeaderCadence,
  type MaterialEvidenceInput,
} from '../src/core/vision/leader-cadence.js';
import { buildLeaderHealth } from '../src/core/vision/leader-health.js';
import { isOpenGoal, summarizeOpenGoals } from '../src/core/goals/open-goals.js';
import { wakeLeaderIfDue, LEADER_WAKE_THROTTLE_MS } from '../src/cli/leader.js';
import * as goalsStore from '../src/core/goals/store.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { AshlrConfig, Goal } from '../src/core/types.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;
let savedTz: string | undefined;
beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
  savedTz = process.env['TZ'];
  process.env['TZ'] = 'UTC';
});
afterEach(() => {
  home.teardown();
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

const T0 = Date.parse('2026-09-24T09:00:00.000Z');
const MIN = 60_000;
const OBSERVED = new Date(T0 - MIN).toISOString();

function reply(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bottleneck: { statement: 'Too many open goals', metric: 'active-goals', evidence: ['21 open'] },
    move: { statement: 'Prune to four goals', why: 'focus', expectedDelta: { metric: 'active-goals', delta: -2, byDate: '2026-09-30' } },
    killList: [],
    questionsForMason: [],
    actions: [{ kind: 'lanes.grok', params: { slots: 1 }, summary: 'Fewer grok lanes', why: 'cost' }],
    ...extra,
  });
}

function seat(id: string, engine: VerseSeat['engine'], model: string, contextWindow = 65_536): VerseSeat {
  return {
    id, engine, label: id, accountId: engine === 'local' ? 'local' : id,
    models: [{ id: model, label: model, contextWindow }],
    contextWindow,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

const LOCAL_27B: LeaderSeatCandidate = { seat: seat('local:qwen3.8:27b-ctx64k', 'local', 'qwen3.8:27b-ctx64k'), launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
const LOCAL_FAST: LeaderSeatCandidate = { seat: seat('local:gpt-oss:20b', 'local', 'gpt-oss:20b'), launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' };
const GROK: LeaderSeatCandidate = { seat: seat('grok', 'grok', 'grok-4.7', 200_000), launcher: ['node', '/profiles/grok/launcher.js'], ollamaBaseUrl: null };
const CLAUDE: LeaderSeatCandidate = { seat: seat('claude', 'claude', 'claude-opus-5-5', 200_000), launcher: ['node', '/profiles/claude/launcher.js'], ollamaBaseUrl: null };
const CODEX: LeaderSeatCandidate = { seat: seat('codex-personal', 'codex', 'gpt-5.5', 200_000), launcher: ['node', '/profiles/codex/launcher.js'], ollamaBaseUrl: null };

function paidCapacity(id: string, engine: SeatCapacity['engine'], windows: SeatCapacity['windows']): SeatCapacity {
  return { seatId: id, engine, label: id, free: false, windows, signedOut: false, reachable: null, contextWindow: 200_000, observedAt: OBSERVED, spentTodayUsd: null };
}
const GROK_OK = paidCapacity('grok', 'grok', [{ id: 'weekly', usedPercent: 20, resetsAt: '2026-09-28T00:00:00.000Z', resetDescription: null, limitReached: false }]);
const CLAUDE_OK = paidCapacity('claude', 'claude', [
  { id: 'five_hour', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
  { id: 'seven_day', usedPercent: 5, resetsAt: null, resetDescription: null, limitReached: false },
]);

type Behaviour = (system: string, user: string) => Promise<string>;

interface SeatWorld {
  deps: LeaderSeatDeps;
  calls: string[];
  opts: Record<string, LeaderCallOptions | undefined>;
}

function seatDeps(o: {
  candidates: LeaderSeatCandidate[];
  standing?: EffectivePolicy | null;
  snapshot?: SeatCapacity[];
  cfg?: AshlrConfig;
  budget?: () => BudgetPolicy;
  now?: () => number;
  behave?: Record<string, Behaviour>;
}): SeatWorld {
  const calls: string[] = [];
  const opts: Record<string, LeaderCallOptions | undefined> = {};
  const run = (key: string, fallback: Behaviour): Behaviour => async (system, user) => {
    calls.push(key);
    return (o.behave?.[key] ?? fallback)(system, user);
  };
  const deps: LeaderSeatDeps = {
    cfg: o.cfg ?? ({} as AshlrConfig),
    now: o.now ?? (() => T0),
    candidates: async () => o.candidates,
    capacitySnapshot: () => ({ publishedAt: OBSERVED, seats: o.snapshot ?? [] }),
    budgetPolicy: o.budget ?? (() => defaultBudgetPolicy()),
    standingPolicy: () => (o.standing === undefined ? makePolicy() : o.standing),
    clampBudget: (p) => p,
    route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      local: (_base, model, callOpts) => { opts[`local ${model}`] = callOpts; return run(`local ${model}`, async () => reply()); },
      grok: (_l, model, callOpts) => { opts[`grok ${model}`] = callOpts; return run(`grok ${model}`, async () => reply()); },
      claude: (_l, model, _c, callOpts) => { opts[`claude ${model}`] = callOpts; return run(`claude ${model}`, async () => reply()); },
    },
    claudeCredential: async () => undefined,
  };
  return { deps, calls, opts };
}

function world(o: {
  now: () => number;
  candidates?: LeaderSeatCandidate[];
  behave?: Record<string, Behaviour>;
  cfg?: AshlrConfig;
  policy?: () => EffectivePolicy | null;
}) {
  const { deps: apply } = makeApplyDeps({ ledger, now: o.now, policy: o.policy ?? (() => null) });
  const sources: LeaderEvidenceSources = {
    standingPolicy: o.policy ?? (() => null),
    budgetPolicy: () => defaultBudgetPolicy(),
    capacity: () => ({ publishedAt: new Date(o.now()).toISOString(), seats: [] }),
    goals: () => {
      const read = goalsStore.listGoalsDetailed();
      return { goals: read.goals, complete: read.complete || read.sourceState === 'missing', unreadable: read.unreadableFiles };
    },
    readLedger: (opts) => ledger.read(opts),
    holds: () => [],
    quality7d: () => ({ proposalsCreated: 3, merged: 0, rejected: 1, pending: 2, emptyRate: 0, acceptRate: 0, verifyPassRate: 0.5 }),
    models: () => [],
    reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 10, sessions: 2, byEngine: {} }, insights: [], trends: [] }),
  };
  const s = seatDeps({ candidates: o.candidates ?? [LOCAL_27B, LOCAL_FAST], standing: o.policy ? o.policy() : null, now: o.now, behave: o.behave, cfg: o.cfg });
  const deps: LeaderRunDeps = { cfg: o.cfg ?? ({} as AshlrConfig), now: o.now, sources, seat: s.deps, apply };
  return { deps, calls: s.calls, opts: s.opts };
}

const EMPTY_STATE: LeaderRunState = { v: 1, lastRun: null, runDays: {}, lastEvidenceDigest: null, lastDeepRunAt: null, lastMemoAt: null, baselines: {}, outcomes: [] };

// ---------------------------------------------------------------------------
// 1. Goal evidence
// ---------------------------------------------------------------------------

function corruptTimestamps(goal: Goal): void {
  // The 2026-09 defect: a 1970 updatedAt (earlier than createdAt) — the store's
  // record guard rejects the file, so every read is "incomplete".
  const file = join(goalsStore.goalsDir(), `${goal.id}.json`);
  const record = JSON.parse(readFileSync(file, 'utf8')) as Goal;
  writeFileSync(file, JSON.stringify({ ...record, updatedAt: '1970-01-01T00:00:00.000Z' }));
}

describe('goal evidence (the "zero active goals" bug)', () => {
  it('summarizeOpenGoals: one open-goal rule (active + planning); an incomplete read is a lower bound', () => {
    const g = (id: string, status: Goal['status']): Goal => ({ id, objective: id, project: null, status, milestones: [], createdAt: OBSERVED, updatedAt: OBSERVED });
    const goals = [g('a', 'active'), g('b', 'planning'), g('c', 'paused'), g('d', 'done'), g('e', 'archived')];
    expect(goals.filter(isOpenGoal).map((x) => x.id)).toEqual(['a', 'b']);
    expect(summarizeOpenGoals({ goals, complete: true })).toMatchObject({ open: 2, active: 1, planning: 1, paused: 1, total: 5, complete: true, unreadable: 0 });
    expect(summarizeOpenGoals({ goals, complete: false, unreadable: 3 })).toMatchObject({ open: 2, complete: false, unreadable: 3 });
    expect(summarizeOpenGoals({ goals, complete: false }).unreadable).toBeNull();
  });

  it('an unreadable goal file no longer blanks the goals block: the Leader and the digest agree', async () => {
    const created = [0, 1, 2, 3].map((i) => goalsStore.createGoal(`Open goal ${i}`));
    corruptTimestamps(created[3]!);
    const read = goalsStore.listGoalsDetailed();
    expect(read.complete).toBe(false);
    expect(read.unreadableFiles).toBe(1);

    const { deps } = world({ now: () => T0 });
    const evidence = await gatherLeaderEvidence(deps.sources, T0, EMPTY_STATE);
    // Before 3.14: evidence.goals === null and the memo said "zero active goals".
    expect(evidence.goals).not.toBeNull();
    expect(evidence.goals).toMatchObject({ open: 3, total: 3, complete: false, unreadableGoalFiles: 1 });
    expect(evidence.goals!.note).toMatch(/could not read 1 goal file\(s\): at least 3 goals are open/);
    expect(evidence.unknown).toContain('goals-partial');
    expect(evidence.unknown).not.toContain('goals');
    // The digest's "goals in flight" uses the same rule over the same readable goals.
    expect(goalsStore.listGoals().filter(isOpenGoal).length).toBe(evidence.goals!.open);
    // Grading needs an exact count: the metric stays unknown on an incomplete read.
    expect(await measureLeaderMetric('active-goals', deps.sources, T0)).toBeNull();
  });

  it('a complete read reports the exact count with no caveat', async () => {
    for (let i = 0; i < 5; i += 1) goalsStore.createGoal(`Goal ${i}`);
    const { deps } = world({ now: () => T0 });
    const evidence = await gatherLeaderEvidence(deps.sources, T0, EMPTY_STATE);
    expect(evidence.goals).toMatchObject({ open: 5, complete: true, unreadableGoalFiles: 0, note: null });
    expect(await measureLeaderMetric('active-goals', deps.sources, T0)).toBe(5);
  });

  it('only a source that throws is null (and reported unknown)', async () => {
    const { deps } = world({ now: () => T0 });
    const broken = { ...deps.sources, goals: () => { throw new Error('boom'); } };
    const evidence = await gatherLeaderEvidence(broken, T0, EMPTY_STATE);
    expect(evidence.goals).toBeNull();
    expect(evidence.unknown).toContain('goals');
  });
});

// ---------------------------------------------------------------------------
// 2. Seat plan + chain
// ---------------------------------------------------------------------------

describe('seat plan (pure policy)', () => {
  it('speed classes and local order: operator-named, then fast before large', () => {
    expect(localSpeedClass('gpt-oss:20b')).toBe('fast');
    expect(localSpeedClass('qwen3:30b-a3b')).toBe('fast');
    expect(localSpeedClass('llama3.2:3b')).toBe('fast');
    expect(localSpeedClass('qwen3.8:27b-ctx64k')).toBe('large');
    expect(localSpeedClass('qwen3.8:27b-q8_0')).toBe('large');
    expect(localSpeedClass('mystery')).toBe('unknown');
    const tags = ['qwen3.8:27b-ctx64k', 'mystery', 'gpt-oss:20b'];
    expect(orderLocalModels(tags, (t) => t, undefined)).toEqual(['gpt-oss:20b', 'mystery', 'qwen3.8:27b-ctx64k']);
    const cfg = { foundry: { leader: { localModel: 'qwen3.8:27b-ctx64k' } } } as unknown as AshlrConfig;
    expect(orderLocalModels(tags, (t) => t, cfg)[0]).toBe('qwen3.8:27b-ctx64k');
  });

  it('budgets: per-attempt timeouts by speed and mode; the request context is capped', () => {
    const fast = leaderCallBudget('local', 'gpt-oss:20b', 'full', 20_000);
    const large = leaderCallBudget('local', 'qwen3.8:27b-ctx64k', 'full', 20_000);
    const checkin = leaderCallBudget('local', 'qwen3.8:27b-ctx64k', 'checkin', 20_000);
    expect(fast.timeoutMs).toBeLessThan(large.timeoutMs);
    expect(checkin.timeoutMs).toBeLessThan(large.timeoutMs);
    expect(checkin.maxOutputTokens).toBeLessThan(large.maxOutputTokens);
    // ~5k-token prompt: 12k context, not the model tag's 64k or llama-server's 262k.
    expect(large.contextTokens).toBe(12_288);
    expect(leaderContextTokens(1_000, 'checkin')).toBe(8_192);
    expect(leaderContextTokens(1_000_000, 'full')).toBe(32_768);
    expect(leaderCallBudget('grok', 'grok-4.7', 'full', 20_000).contextTokens).toBeNull();
  });
});

describe('planLeaderSeats', () => {
  it('with a grant: grok → fast local → large local; Claude and codex are passed over with reasons', async () => {
    const { deps } = seatDeps({ candidates: [LOCAL_27B, CODEX, CLAUDE, LOCAL_FAST, GROK], snapshot: [GROK_OK, CLAUDE_OK] });
    const plan = await planLeaderSeats(deps, { deep: false, promptChars: 20_000, mode: 'full' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps.map((s) => s.choice.seatId)).toEqual(['grok', 'local:gpt-oss:20b', 'local:qwen3.8:27b-ctx64k']);
    const why = Object.fromEntries(plan.skipped.map((s) => [s.seatId, s.reason]));
    expect(why['claude']).toMatch(/only for the weekly deep run/);
    expect(why['codex-personal']).toMatch(/never uses codex/);
    expect(plan.steps[0]!.budget.timeoutMs).toBeGreaterThan(0);
  });

  it('with no grant: local models only, fast first — no paid seat, no cloud fallback', async () => {
    const { deps } = seatDeps({ candidates: [GROK, LOCAL_27B, LOCAL_FAST], standing: null, snapshot: [GROK_OK] });
    const plan = await planLeaderSeats(deps, { deep: true, promptChars: 20_000, mode: 'full' });
    expect(plan.ok && plan.steps.map((s) => s.choice.seatId)).toEqual(['local:gpt-oss:20b', 'local:qwen3.8:27b-ctx64k']);
    if (plan.ok) expect(plan.skipped.find((s) => s.seatId === 'grok')?.reason).toMatch(/No standing grant/);
  });

  it('the weekly deep run keeps Claude first (the router pick), then falls back to grok and local', async () => {
    const { deps } = seatDeps({ candidates: [CLAUDE, GROK, LOCAL_27B, LOCAL_FAST], snapshot: [GROK_OK, CLAUDE_OK] });
    const plan = await planLeaderSeats(deps, { deep: true, promptChars: 20_000, mode: 'full' });
    expect(plan.ok && plan.steps.map((s) => s.choice.seatId)).toEqual(['claude', 'grok', 'local:gpt-oss:20b', 'local:qwen3.8:27b-ctx64k']);
  });

  it('Claude as the LAST fallback only when opted in, never in reserve mode, never on a check-in', async () => {
    const cfg = { foundry: { leader: { claudeFallback: true } } } as unknown as AshlrConfig;
    const on = seatDeps({ candidates: [CLAUDE, GROK, LOCAL_FAST], snapshot: [GROK_OK, CLAUDE_OK], cfg });
    const plan = await planLeaderSeats(on.deps, { deep: false, promptChars: 20_000, mode: 'full' });
    expect(plan.ok && plan.steps.map((s) => s.choice.seatId)).toEqual(['grok', 'local:gpt-oss:20b', 'claude']);

    const reserve = seatDeps({ candidates: [CLAUDE, GROK, LOCAL_FAST], snapshot: [GROK_OK, CLAUDE_OK], cfg, budget: () => ({ ...defaultBudgetPolicy(), mode: 'reserve' }) });
    const r = await planLeaderSeats(reserve.deps, { deep: false, promptChars: 20_000, mode: 'full' });
    expect(r.ok && r.steps.map((s) => s.choice.engine)).not.toContain('claude');
    if (r.ok) expect(r.skipped.find((s) => s.seatId === 'claude')?.reason).toMatch(/reserve/);

    const checkin = await planLeaderSeats(on.deps, { deep: true, promptChars: 20_000, mode: 'checkin' });
    expect(checkin.ok && checkin.steps.map((s) => s.choice.engine)).not.toContain('claude');
    if (checkin.ok) expect(checkin.skipped.find((s) => s.seatId === 'claude')?.reason).toMatch(/check-in never uses Claude/);
  });

  it('localOnly (a check-in in reserve mode) passes over grok', async () => {
    const { deps } = seatDeps({ candidates: [GROK, LOCAL_FAST], snapshot: [GROK_OK] });
    const plan = await planLeaderSeats(deps, { deep: false, promptChars: 20_000, mode: 'checkin', localOnly: true });
    expect(plan.ok && plan.steps.map((s) => s.choice.seatId)).toEqual(['local:gpt-oss:20b']);
  });

  it('each transport gets its own per-attempt budget', async () => {
    const w = seatDeps({ candidates: [LOCAL_27B, LOCAL_FAST, GROK], snapshot: [GROK_OK] });
    await planLeaderSeats(w.deps, { deep: false, promptChars: 20_000, mode: 'full' });
    expect(w.opts['local gpt-oss:20b']).toMatchObject({ timeoutMs: 6 * MIN, maxOutputTokens: 3_072, contextTokens: 12_288 });
    expect(w.opts['local qwen3.8:27b-ctx64k']).toMatchObject({ timeoutMs: 18 * MIN });
    expect(w.opts['grok grok-4.7']).toMatchObject({ timeoutMs: 8 * MIN, contextTokens: null });
  });
});

describe('the fallback chain in a run', () => {
  it('a failing first seat falls through to the next; the memo records who served and why others did not', async () => {
    const { deps, calls } = world({
      now: () => T0,
      behave: { 'local gpt-oss:20b': async () => { throw new TypeError('fetch failed', { cause: new Error('Headers Timeout Error') }); } },
    });
    const r = await runLeader(deps, 'schedule');
    expect(r.outcome).toBe('ok');
    expect(calls).toEqual(['local gpt-oss:20b', 'local qwen3.8:27b-ctx64k']);
    expect(r.memo).toMatchObject({ seatId: 'local:qwen3.8:27b-ctx64k', mode: 'full' });
    expect(r.memo!.attempts!.map((a) => [a.seatId, a.outcome])).toEqual([
      ['local:gpt-oss:20b', 'failed'],
      ['local:qwen3.8:27b-ctx64k', 'served'],
    ]);
    expect(r.memo!.attempts![0]!.reason).toMatch(/fetch failed \(Headers Timeout Error\)/);
    const state = readLeaderRunState();
    expect(state.lastServed).toMatchObject({ seatId: 'local:qwen3.8:27b-ctx64k' });
    expect(state.retry).toBeNull();
    // Health: served, but only after a fallback ⇒ degraded, and it says why.
    const health = buildLeaderState(T0).health!;
    expect(health.status).toBe('degraded');
    expect(health.summary).toMatch(/after a fallback: local:gpt-oss:20b failed/);
  });

  it('a per-attempt timeout is recorded as a timeout', async () => {
    const { deps } = world({
      now: () => T0,
      behave: { 'local gpt-oss:20b': async () => { throw new LeaderTimeoutError(6 * MIN); } },
    });
    const r = await runLeader(deps, 'manual');
    expect(r.memo!.attempts![0]).toMatchObject({ outcome: 'timeout', timeoutMs: 6 * MIN });
  });

  it('an unparseable answer moves on to the next FREE seat', async () => {
    const { deps, calls } = world({ now: () => T0, behave: { 'local gpt-oss:20b': async () => 'not json' } });
    const r = await runLeader(deps, 'manual');
    expect(r.outcome).toBe('ok');
    // one free re-ask on the same seat, then the next local seat
    expect(calls).toEqual(['local gpt-oss:20b', 'local gpt-oss:20b', 'local qwen3.8:27b-ctx64k']);
    expect(r.memo!.attempts!.map((a) => a.outcome)).toEqual(['parse-failed', 'served']);
  });

  it('every seat failing ⇒ a failed memo and a bounded, backed-off retry (not tomorrow)', async () => {
    let now = Date.parse('2026-09-26T06:30:05.000Z');
    const fail: Behaviour = async () => { throw new TypeError('fetch failed'); };
    const { deps, calls } = world({ now: () => now, behave: { 'local gpt-oss:20b': fail, 'local qwen3.8:27b-ctx64k': fail } });
    const quiet = { mergesSinceLastRun: 0, revertsSinceLastRun: 0, seatResetSinceLastRun: false, highInsightSinceLastRun: false };

    const first = await runLeader(deps, 'schedule');
    expect(first.outcome).toBe('failed');
    expect(first.reason).toMatch(/^Every seat failed: local:gpt-oss:20b failed; local:qwen3.8:27b-ctx64k failed/);
    expect(calls).toHaveLength(2);
    let state = readLeaderRunState();
    expect(state.retry).toMatchObject({ attempt: 1, of: 'schedule', at: new Date(now + 15 * MIN).toISOString() });
    expect(buildLeaderState(now).health).toMatchObject({ status: 'degraded', consecutiveFailures: 1, retry: { attempt: 1, maxAttempts: 3 } });
    expect(buildLeaderState(now).health!.nextDueAt).toBe(new Date(now + 15 * MIN).toISOString());

    // Not yet due before the backoff, due after it.
    expect(leaderRunDue(now + 14 * MIN, state, quiet).due).toBe(false);
    now += 16 * MIN;
    expect(leaderRunDue(now, state, quiet)).toMatchObject({ due: true, trigger: 'retry' });

    expect((await runLeader(deps, 'retry')).outcome).toBe('failed');
    state = readLeaderRunState();
    expect(state.retry).toMatchObject({ attempt: 2, of: 'schedule', at: new Date(now + 45 * MIN).toISOString() });
    // Retries count toward the 3 full runs a day: the third run is the last one today.
    now += 46 * MIN;
    expect((await runLeader(deps, 'retry')).outcome).toBe('failed');
    state = readLeaderRunState();
    expect(state.runDays['2026-09-26']).toBe(3);
    expect(leaderRunDue(now + 3 * 60 * MIN, state, quiet).due).toBe(false);
  });

  it('the retries are bounded: after the third retry fails, the Leader is down until the next slot', async () => {
    let now = Date.parse('2026-09-26T06:30:05.000Z');
    const fail: Behaviour = async () => { throw new TypeError('fetch failed'); };
    const { deps } = world({ now: () => now, behave: { 'local gpt-oss:20b': fail, 'local qwen3.8:27b-ctx64k': fail } });
    // `no-seat`-free failures, run through the retries (manual runs are not capped by evidence).
    await runLeader(deps, 'schedule');
    for (const gap of [16, 46, 121]) {
      now += gap * MIN;
      // The cap would stop the third retry; lift it for this bound check by clearing today's count.
      const s = readLeaderRunState();
      s.runDays = {};
      writeFileSync(join(home.home(), '.ashlr', 'vision', 'leader', 'state.json'), `${JSON.stringify(s)}\n`);
      await runLeader(deps, 'retry');
    }
    const state = readLeaderRunState();
    expect(state.retry).toBeNull();
    expect(state.consecutiveFailures).toBe(4);
    expect(buildLeaderState(now).health).toMatchObject({ status: 'down', retry: null });
  });

  it('no seat at all ⇒ no-seat (not counted), a retry, and health says down with the reason', async () => {
    const { deps } = world({ now: () => T0, candidates: [] });
    const r = await runLeader(deps, 'schedule');
    expect(r.outcome).toBe('no-seat');
    const state = readLeaderRunState();
    expect(state.runDays['2026-09-24']).toBeUndefined();
    expect(state.retry).toMatchObject({ attempt: 1 });
    expect(buildLeaderState(T0).health).toMatchObject({ status: 'down' });
    expect(buildLeaderState(T0).health!.summary).toMatch(/No seat can serve the Leader/);
  });
});

// ---------------------------------------------------------------------------
// 3. Health
// ---------------------------------------------------------------------------

describe('health', () => {
  it('healthy after a first-seat memo; unknown before any run', async () => {
    expect(buildLeaderState(T0).health).toMatchObject({ status: 'unknown', lastRunAt: null });
    const { deps } = world({ now: () => T0 });
    await runLeader(deps, 'schedule');
    const h = buildLeaderState(T0 + MIN).health!;
    expect(h).toMatchObject({ status: 'healthy', lastRunOutcome: 'ok', consecutiveFailures: 0, lastFailure: null });
    expect(h.servedBy).toMatchObject({ seatId: 'local:gpt-oss:20b' });
    expect(h.seats.map((s) => s.outcome)).toEqual(['served']);
    expect(h.lastSuccessAt).toBe(new Date(T0).toISOString());
  });

  it('a pre-3.14 state file whose last run failed reads degraded, not healthy (the live 2026-09-26 state)', () => {
    const h = buildLeaderHealth(
      { lastRun: { at: '2026-09-26T11:00:06.724Z', outcome: 'failed', reason: 'The local call failed: fetch failed', trigger: 'schedule' }, lastMemoAt: '2026-09-26T11:00:06.724Z', lastSuccessAt: '2026-09-25T11:00:06.494Z' },
      Date.parse('2026-09-26T12:00:00.000Z'),
      { cadence: resolveLeaderCadence(undefined), nextScheduledAt: Date.parse('2026-09-27T06:30:00.000Z'), runsToday: 1, checkinsToday: 0 },
    );
    expect(h.status).toBe('degraded');
    expect(h.summary).toMatch(/fetch failed/);
    expect(h.lastFailure).toMatchObject({ outcome: 'failed' });
  });

  it('a stale last memo (> 36 h) is degraded', () => {
    const h = buildLeaderHealth(
      { lastRun: { at: '2026-09-20T06:30:00.000Z', outcome: 'ok', reason: null, trigger: 'schedule' }, lastMemoAt: '2026-09-20T06:30:00.000Z', lastSuccessAt: '2026-09-20T06:30:00.000Z', consecutiveFailures: 0 },
      Date.parse('2026-09-24T12:00:00.000Z'),
      { cadence: resolveLeaderCadence(undefined), nextScheduledAt: Date.parse('2026-09-25T06:30:00.000Z'), runsToday: 0, checkinsToday: 0 },
    );
    expect(h.status).toBe('degraded');
    expect(h.summary).toMatch(/h old/);
  });
});

// ---------------------------------------------------------------------------
// 4. Cadence
// ---------------------------------------------------------------------------

describe('cadence: check-ins, caps and the wake check', () => {
  const quiet = { mergesSinceLastRun: 0, revertsSinceLastRun: 0, seatResetSinceLastRun: false, highInsightSinceLastRun: false };

  it('config: default every 2 h in 08–22; 0 disables; values are clamped', () => {
    expect(resolveLeaderCadence(undefined)).toMatchObject({ checkinHours: 2, workingHours: { start: 8, end: 22 }, maxRunsPerDay: 3, maxRunsPerDayTotal: 8 });
    const off = resolveLeaderCadence({ foundry: { leader: { checkinHours: 0 } } } as unknown as AshlrConfig);
    expect(off).toMatchObject({ checkinHours: 0, maxRunsPerDayTotal: 3 });
    expect(resolveLeaderCadence({ foundry: { leader: { checkinHours: 0.1 } } } as unknown as AshlrConfig).checkinHours).toBe(1);
    expect(resolveLeaderCadence({ foundry: { leader: { checkinHours: 99, workingHours: { start: 9, end: 18 } } } } as unknown as AshlrConfig))
      .toMatchObject({ checkinHours: 24, workingHours: { start: 9, end: 18 } });
    expect(resolveLeaderCadence({ foundry: { leader: { workingHours: { start: 20, end: 8 } } } } as unknown as AshlrConfig).workingHours).toEqual({ start: 8, end: 22 });
  });

  it('a check-in is due 2 h after the last memo, in working hours only, and not when disabled', () => {
    const cadence = resolveLeaderCadence(undefined);
    const ranAt = '2026-09-24T06:30:10.000Z';
    const state: LeaderRunState = { ...EMPTY_STATE, lastRun: { at: ranAt, outcome: 'ok', reason: null, memoId: null, trigger: 'schedule' }, lastMemoAt: ranAt, runDays: { '2026-09-24': 1 } };
    expect(leaderRunDue(Date.parse('2026-09-24T08:00:00.000Z'), state, quiet, cadence).due).toBe(false);
    expect(leaderRunDue(Date.parse('2026-09-24T08:31:00.000Z'), state, quiet, cadence)).toMatchObject({ due: true, trigger: 'checkin' });
    // Outside working hours.
    const late: LeaderRunState = { ...state, lastRun: { ...state.lastRun!, at: '2026-09-24T21:00:00.000Z' }, lastMemoAt: '2026-09-24T21:00:00.000Z' };
    expect(leaderRunDue(Date.parse('2026-09-24T23:30:00.000Z'), late, quiet, cadence).due).toBe(false);
    // Disabled, and the legacy (no-cadence) signature.
    const off = resolveLeaderCadence({ foundry: { leader: { checkinHours: 0 } } } as unknown as AshlrConfig);
    expect(leaderRunDue(Date.parse('2026-09-24T08:31:00.000Z'), state, quiet, off).due).toBe(false);
    expect(leaderRunDue(Date.parse('2026-09-24T08:31:00.000Z'), state, quiet).due).toBe(false);
    // A check-in that found nothing material waits 30 min before looking again.
    const looked: LeaderRunState = { ...state, lastCheckinEvalAt: '2026-09-24T08:31:00.000Z' };
    expect(leaderRunDue(Date.parse('2026-09-24T08:50:00.000Z'), looked, quiet, cadence).due).toBe(false);
    expect(leaderRunDue(Date.parse('2026-09-24T09:02:00.000Z'), looked, quiet, cadence).trigger).toBe('checkin');
  });

  it('check-ins have their own room: 3 full runs a day, 8 in total', () => {
    const cadence = resolveLeaderCadence(undefined);
    const at = Date.parse('2026-09-24T15:00:00.000Z');
    const base: LeaderRunState = { ...EMPTY_STATE, lastRun: { at: '2026-09-24T12:00:00.000Z', outcome: 'ok', reason: null, memoId: null, trigger: 'merges' }, lastMemoAt: '2026-09-24T12:00:00.000Z' };
    const fullSpent = { ...base, runDays: { '2026-09-24': 3 } };
    expect(leaderRunDue(at, fullSpent, { ...quiet, revertsSinceLastRun: 2 }, cadence)).toMatchObject({ due: true, trigger: 'checkin' });
    const allSpent = { ...base, runDays: { '2026-09-24': 8 }, checkinDays: { '2026-09-24': 5 } };
    expect(leaderRunDue(at, allSpent, quiet, cadence)).toMatchObject({ due: false, reason: 'The Leader already ran 8 times today.' });
    // With check-ins counted separately, full runs still have room after 5 check-ins.
    const checkinsOnly = { ...base, runDays: { '2026-09-24': 5 }, checkinDays: { '2026-09-24': 5 } };
    expect(leaderRunDue(at, checkinsOnly, { ...quiet, revertsSinceLastRun: 1 }, cadence)).toMatchObject({ due: true, trigger: 'revert' });
  });

  it('material change: drifting counts do not wake a check-in; a new hold or goal does', () => {
    const e: MaterialEvidenceInput = {
      grant: null, budget: { mode: 'balanced' }, seats: [], goals: { open: 21, complete: true },
      fleet: { merges7d: 11, reverts7d: 0, holds: [], quality7d: { proposalsCreated: 21, merged: 4, rejected: 1 } },
      reasoning: { insights: [{ severity: 'low', title: 'x' }] }, unknown: [],
    };
    const d = materialEvidenceDigest(e);
    expect(materialEvidenceDigest({ ...e, fleet: { ...e.fleet, merges7d: 13 } })).toBe(d);
    expect(materialEvidenceDigest({ ...e, reasoning: { insights: [{ severity: 'low', title: 'y' }] } })).toBe(d);
    expect(materialEvidenceDigest({ ...e, fleet: { ...e.fleet, holds: [{ repo: 'a/b', kind: 'leader-pause' }] } })).not.toBe(d);
    expect(materialEvidenceDigest({ ...e, goals: { open: 20, complete: true } })).not.toBe(d);
    expect(materialEvidenceDigest({ ...e, fleet: { ...e.fleet, reverts7d: 1 } })).not.toBe(d);
  });

  it('a check-in runs only on material change, is advisory (nothing enacted) and is counted as a check-in', async () => {
    let now = Date.parse('2026-09-24T06:30:10.000Z');
    const { deps, calls } = world({ now: () => now, policy: () => makePolicy() });
    expect((await runLeader(deps, 'schedule')).outcome).toBe('ok');
    expect(calls).toHaveLength(1);

    // Nothing material changed ⇒ no model call; the recheck clock starts.
    now = Date.parse('2026-09-24T08:40:00.000Z');
    const skipped = await runLeader(deps, 'checkin');
    expect(skipped.outcome).toBe('skipped-unchanged');
    expect(skipped.reason).toMatch(/nothing material/);
    expect(calls).toHaveLength(1);
    expect(readLeaderRunState().lastCheckinEvalAt).toBe(new Date(now).toISOString());

    // A new goal is material ⇒ the check-in runs, with the CHECK-IN ask.
    goalsStore.createGoal('A brand new goal');
    now = Date.parse('2026-09-24T09:20:00.000Z');
    const r = await runLeader(deps, 'checkin');
    expect(r.outcome).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(r.memo).toMatchObject({ mode: 'checkin', trigger: 'checkin', actions: [], goals: [], hypotheses: [] });
    expect(r.memo!.statusReason).toMatch(/not enacted \(check-ins are advisory\)/);
    const state = readLeaderRunState();
    expect(state.runDays['2026-09-24']).toBe(2);
    expect(state.checkinDays!['2026-09-24']).toBe(1);
  });

  it('the check-in prompt carries the CHECK-IN ask; the daily prompt does not', async () => {
    const seen: string[] = [];
    let now = Date.parse('2026-09-24T06:30:10.000Z');
    const capture: Behaviour = async (_s, u) => { seen.push(u); return reply(); };
    const { deps } = world({ now: () => now, behave: { 'local gpt-oss:20b': capture } });
    await runLeader(deps, 'schedule');
    goalsStore.createGoal('Material change');
    now += 3 * 60 * MIN;
    await runLeader(deps, 'checkin');
    expect(seen[0]).not.toContain('=== CHECK-IN ===');
    expect(seen[1]).toContain(LEADER_CHECKIN_SUFFIX);
    expect(seen[0]!.startsWith(`Today is`)).toBe(true);
  });

  it('check-in moves are not graded into the hit-rate', async () => {
    let now = Date.parse('2026-09-24T06:30:10.000Z');
    const { deps } = world({ now: () => now });
    await runLeader(deps, 'schedule');
    goalsStore.createGoal('Material change');
    now += 3 * 60 * MIN;
    await runLeader(deps, 'checkin');
    const { gradeLeaderOutcomes } = await import('../src/core/vision/leader.js');
    now += 30 * 86_400_000;
    const graded = await gradeLeaderOutcomes(deps);
    expect(graded).toHaveLength(1);
  });

  it('leaderWakeDue: only time reasons (slot, retry, check-in window), from the state file alone', () => {
    const cadence = resolveLeaderCadence(undefined);
    expect(leaderWakeDue(T0, EMPTY_STATE, cadence)).toMatchObject({ due: true, why: 'the daily run has not happened' });
    const ran: LeaderRunState = { ...EMPTY_STATE, lastRun: { at: '2026-09-24T08:30:00.000Z', outcome: 'ok', reason: null, memoId: null, trigger: 'schedule' }, lastMemoAt: '2026-09-24T08:30:00.000Z', runDays: { '2026-09-24': 1 } };
    expect(leaderWakeDue(T0, ran, cadence).due).toBe(false);
    expect(leaderWakeDue(Date.parse('2026-09-24T10:31:00.000Z'), ran, cadence)).toMatchObject({ due: true, why: 'a check-in window is open' });
    const failed: LeaderRunState = { ...ran, retry: { attempt: 1, at: '2026-09-24T08:45:00.000Z', of: 'schedule', reason: 'x' } };
    expect(leaderWakeDue(T0, failed, cadence)).toMatchObject({ due: true, why: 'retry 1 is due' });
    expect(leaderWakeDue(T0, { ...ran, runDays: { '2026-09-24': 8 } }, cadence).due).toBe(false);
  });

  it('wakeLeaderIfDue: throttled, spawns one background tick when due, never throws', async () => {
    let last = 0;
    let spawned = 0;
    let now = T0;
    const deps = {
      now: () => now,
      spawnTick: () => { spawned += 1; return true; },
      readLastWake: () => last,
      writeLastWake: (ms: number) => { last = ms; },
    };
    const cfg = {} as AshlrConfig;
    expect(await wakeLeaderIfDue(cfg, deps)).toMatchObject({ started: true });
    expect(spawned).toBe(1);
    now += LEADER_WAKE_THROTTLE_MS - 1;
    expect(await wakeLeaderIfDue(cfg, deps)).toMatchObject({ started: false, why: 'woke the Leader recently' });
    now += 2;
    expect(await wakeLeaderIfDue(cfg, deps)).toMatchObject({ started: true });
    expect(spawned).toBe(2);
    const broken = { ...deps, now: () => now + LEADER_WAKE_THROTTLE_MS * 2, spawnTick: () => { throw new Error('x'); } };
    expect(await wakeLeaderIfDue(cfg, broken)).toMatchObject({ started: false, why: 'error' });
  });
});
