/**
 * V3.10 B-U8 — Leader runs, cadence and accountability.
 *
 *   - a run writes a memo from deterministic evidence; with no grant it is a
 *     dry run (actions shown, none applied);
 *   - unchanged evidence ⇒ skipped; at most 3 model runs per local day;
 *   - no seat ⇒ a `no-seat` memo (not counted as a run); unparseable output ⇒
 *     `parse-failed` with no actions (one retry on free seats only);
 *   - daily 06:30 cadence + merge / revert / seat-reset / insight triggers;
 *   - moves are graded after 7 days against the measured metric → hit-rate;
 *   - the prompt carries every input inside UNTRUSTED DATA blocks and names
 *     no real person.
 *
 * Hermetic: tmp HOME, fake ledger / sources / seat; no model is called.
 */
import { resolveGoalPreferences } from '../src/core/goals/preferences.js';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../src/core/verse/preferences.js';
import { resolveLeaderPreferences } from '../src/core/vision/leader-preferences.js';
import { resolveLeaderCadence } from '../src/core/vision/leader-cadence.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEADER_SYSTEM_PROMPT,
  buildLeaderPrompt,
  buildLeaderSystemPrompt,
  buildLeaderState,
  computeHitRate,
  gatherLeaderEvidence,
  gradeLeaderOutcomes,
  gradeMove,
  leaderRunDue,
  leaderStatePath,
  leaderTick,
  readLeaderRunState,
  runLeader,
  scheduleSlots,
  type LeaderEvidenceSources,
  type LeaderRunDeps,
  type LeaderRunState,
} from '../src/core/vision/leader.js';
import type { LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import { readLeaderMemo } from '../src/core/vision/leader-memo.js';
import { readLeaderDirectives } from '../src/core/vision/leader-apply.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import * as goalsStore from '../src/core/goals/store.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig } from '../src/core/types.js';
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

function reply(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bottleneck: { statement: 'Too many open goals', metric: 'active-goals', evidence: ['21 open'] },
    move: { statement: 'Prune to four goals', why: 'focus', expectedDelta: { metric: 'active-goals', delta: -2, byDate: '2026-09-30' } },
    killList: [],
    questionsForMason: ['Should ashlr-cortex get a verify command?'],
    actions: [{ kind: 'lanes.grok', params: { slots: 1 }, summary: 'Fewer grok lanes', why: 'cost' }],
    ...extra,
  });
}

function world(opts: { now: () => number; policy?: () => EffectivePolicy | null; replies?: string[]; seat?: 'local' | 'none' | 'grok' }) {
  const replies = [...(opts.replies ?? [reply()])];
  const calls: string[] = [];
  const { deps: apply, units } = makeApplyDeps({ ledger, now: opts.now, policy: opts.policy ?? (() => null) });
  const sources: LeaderEvidenceSources = {
    standingPolicy: opts.policy ?? (() => null),
    budgetPolicy: () => defaultBudgetPolicy(),
    capacity: () => ({ publishedAt: new Date(opts.now()).toISOString(), seats: [] }),
    goals: () => {
      const read = goalsStore.listGoalsDetailed();
      return { goals: read.goals, complete: read.complete || read.sourceState === 'missing' };
    },
    readLedger: (o) => ledger.read(o),
    holds: () => [],
    quality7d: () => ({ proposalsCreated: 3, merged: 0, rejected: 1, pending: 2, emptyRate: 0, acceptRate: 0, verifyPassRate: 0.5 }),
    models: () => [],
    reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 10, sessions: 2, byEngine: {} }, insights: [], trends: [] }),
  };
  const local = {
    seat: {
      id: 'local:qwen3.8:27b-ctx64k', engine: 'local' as const, label: 'Qwen', accountId: 'local',
      models: [{ id: 'qwen3.8:27b-ctx64k', label: 'q', contextWindow: 65_536 }], contextWindow: 65_536,
      health: { state: 'ready' as const, summary: null, windows: [], observedAt: null },
    },
    launcher: null,
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  };
  const seat: LeaderSeatDeps = {
    cfg: {} as AshlrConfig,
    now: opts.now,
    candidates: async () => (opts.seat === 'none' ? [] : [local]),
    capacitySnapshot: () => null,
    budgetPolicy: () => defaultBudgetPolicy(),
    standingPolicy: opts.policy ?? (() => null),
    clampBudget: (p) => p,
    route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      local: () => async (system, user) => {
        calls.push(user);
        const current = deps.liveConfig?.() ?? deps.cfg;
        expect(system).toBe(buildLeaderSystemPrompt(deps.liveConfig ? resolveGoalPreferences(current) : deps.apply.goalPreferences?.() ?? resolveGoalPreferences(current), resolveLeaderPreferences(current, { checkinsEnabled: resolveLeaderCadence(current).checkinHours > 0 })));
        return replies.shift() ?? 'nope';
      },
      grok: () => async () => { throw new Error('grok must not be called'); },
      claude: () => async () => { throw new Error('claude must not be called'); },
    },
  };
  const deps: LeaderRunDeps = { cfg: {} as AshlrConfig, now: opts.now, sources, seat, apply };
  return { deps, calls, units };
}

describe('runLeader', () => {
  it('forwards optional question forms from the actual model draft into the persisted memo', async () => {
    const questionForms = [{ index: 0, mode: 'single', options: ['Yes, add verification', 'First fix reliability'] }];
    const { deps, calls } = world({ now: () => T0, replies: [reply({ questionForms })] });
    const result = await runLeader(deps, 'manual');
    expect(result.outcome).toBe('ok');
    expect(result.memo?.questionForms).toEqual(questionForms);
    expect(readLeaderMemo(result.memo!.id)?.questionForms).toEqual(questionForms);
    expect(result.memo?.questionsForMason).toEqual(['Should ashlr-cortex get a verify command?']);
    expect(calls).toHaveLength(1);
    expect(result.memo?.dryRun).toBe(true);
    expect(readLeaderDirectives()).toBeNull();
  });

  it('writes a dry-run memo when there is no grant: actions are shown, never applied', async () => {
    const { deps, calls } = world({ now: () => T0 });
    const r = await runLeader(deps, 'manual');
    expect(r.outcome).toBe('ok');
    expect(r.memo).toMatchObject({ status: 'ok', dryRun: true, seatId: 'local:qwen3.8:27b-ctx64k', model: 'qwen3.8:27b-ctx64k' });
    expect(r.memo!.bottleneck?.statement).toBe('Too many open goals');
    expect(r.memo!.actions).toHaveLength(1);
    expect(r.memo!.actions[0]).toMatchObject({ kind: 'lanes.grok', status: 'refused' });
    expect(r.memo!.actions[0]!.statusReason).toMatch(/^dry run/);
    expect(readLeaderDirectives()).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/=== BEGIN UNTRUSTED DATA: GOALS AND FOCUS ===/);
    expect(calls[0]).toMatch(/DRY RUN/);
    expect(ledger.rows('leader:memo')).toHaveLength(1);
    const state = readLeaderRunState();
    expect(state.runDays['2026-09-24']).toBe(1);
    expect(state.baselines[r.memo!.id]).toMatchObject({ metric: 'active-goals', value: 0 });
  });

  it('applies class-A actions under a grant', async () => {
    const { deps } = world({ now: () => T0, policy: () => makePolicy() });
    const r = await runLeader(deps, 'manual');
    expect(r.memo).toMatchObject({ dryRun: false });
    expect(r.memo!.actions[0]).toMatchObject({ kind: 'lanes.grok', class: 'A', status: 'applied' });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
  });

  it('3.15: Jev class advice is asked only AFTER enactment and labels the memo; it never changes the class, status or effect', async () => {
    const { deps } = world({ now: () => T0, policy: () => makePolicy() });
    const seen: Array<{ status: string; cls: string; lanes: number | undefined }> = [];
    deps.adviseActionClass = async (action) => {
      // By the time Jev is asked, the deterministic plan has already applied it.
      seen.push({ status: action.status, cls: action.class, lanes: readLeaderDirectives()?.grokLanes });
      return { actionId: action.id, deterministic: action.class, suggested: 'C', stricter: true, confidence: 0.97, source: 'jev' };
    };
    const r = await runLeader(deps, 'manual');
    expect(seen).toEqual([{ status: 'applied', cls: 'A', lanes: 1 }]);
    expect(r.memo!.actions[0]).toMatchObject({ kind: 'lanes.grok', class: 'A', status: 'applied' });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
    expect(r.memo!.actionAdvice).toEqual([
      { actionId: r.memo!.actions[0]!.id, deterministic: 'A', suggested: 'C', stricter: true, confidence: 0.97, source: 'jev' },
    ]);
    // Persisted on the memo file Verse and the thread read.
    const { readLeaderMemo } = await import('../src/core/vision/leader-memo.js');
    expect(readLeaderMemo(r.memo!.id)?.actionAdvice).toEqual(r.memo!.actionAdvice);
    // The ledger saw the action exactly as planned: no row mentions the advice.
    expect(JSON.stringify(ledger.rows('leader:memo'))).not.toContain('actionAdvice');
  });

  it('3.15: a failing advisor leaves the memo without advice and the run ok', async () => {
    const failing = world({ now: () => T0, policy: () => makePolicy() });
    failing.deps.adviseActionClass = async () => { throw new Error('jev down'); };
    const r1 = await runLeader(failing.deps, 'manual');
    expect(r1.outcome).toBe('ok');
    expect(r1.memo!.actionAdvice).toBeUndefined();
    expect(r1.memo!.actions[0]).toMatchObject({ class: 'A', status: 'applied' });
  });

  it('skips when the evidence has not changed, and caps model runs at 3 per day', async () => {
    let now = T0;
    const { deps, calls } = world({ now: () => now, replies: [reply(), reply(), reply(), reply()] });
    expect((await runLeader(deps, 'schedule')).outcome).toBe('ok');
    now += 60_000;
    expect((await runLeader(deps, 'merges')).outcome).toBe('skipped-unchanged');
    expect(calls).toHaveLength(1);
    // Forced (manual) runs bypass the unchanged check but not the daily cap.
    expect((await runLeader(deps, 'manual', { force: true })).outcome).toBe('ok');
    expect((await runLeader(deps, 'manual', { force: true })).outcome).toBe('ok');
    const fourth = await runLeader(deps, 'manual', { force: true });
    expect(fourth.outcome).toBe('skipped-unchanged');
    expect(fourth.reason).toMatch(/3 times today/);
    expect(calls).toHaveLength(3);
  });

  it('no seat ⇒ a no-seat memo that does not count as a run', async () => {
    const { deps } = world({ now: () => T0, seat: 'none' });
    const r = await runLeader(deps, 'schedule');
    expect(r.outcome).toBe('no-seat');
    expect(r.memo).toMatchObject({ status: 'no-seat', actions: [] });
    expect(readLeaderRunState().runDays['2026-09-24']).toBeUndefined();
  });

  it('unparseable output fails closed with no actions after one free retry', async () => {
    const { deps, calls } = world({ now: () => T0, replies: ['not json', '{"move":{"statement":"x"}}'] });
    const r = await runLeader(deps, 'manual');
    expect(r.outcome).toBe('parse-failed');
    expect(r.memo).toMatchObject({ status: 'parse-failed', actions: [], bottleneck: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/could not be parsed/);
  });

  it('memo hypotheses are recorded in the harness registry; experiments start from the registry copy', async () => {
    const hyp = (statement: string, local: 'high' | 'low') => ({
      target: 'effort', patch: { effort: { local } }, statement, metric: 'local-eval.pass-rate', predictedDelta: 0.05,
    });
    const { deps, units } = world({
      now: () => T0,
      policy: () => makePolicy(),
      replies: [reply({ actions: [], hypotheses: [hyp('Higher effort helps', 'high'), hyp('Lower effort is enough', 'low')] })],
    });
    // The registry refuses the second one (as a real validation refusal would).
    const record = deps.apply.recordHypotheses.bind(deps.apply);
    deps.apply.recordHypotheses = async (hs) => {
      const res = await record(hs.slice(0, 1));
      return { accepted: res.accepted, refused: [...res.refused, { id: hs[1]!.id, reason: 'effort.local must differ from the base' }] };
    };
    const r = await runLeader(deps, 'manual');
    expect(r.outcome).toBe('ok');
    const [h0, h1] = r.memo!.hypotheses;
    expect([...units.hypotheses.keys()]).toEqual([h0!.id]);
    // Only the recorded hypothesis gets an experiment.start, and it starts the registry's copy.
    expect(r.memo!.actions.map((a) => [a.kind, a.status])).toEqual([['experiment.start', 'applied']]);
    expect(units.started).toHaveLength(1);
    expect(units.started[0]).toEqual(units.hypotheses.get(h0!.id));
    expect(r.memo!.statusReason).toContain(`Hypothesis ${h1!.id} was not recorded: effort.local must differ from the base`);
  });

  it('a dry run still records hypotheses (Growth lists them) but starts nothing', async () => {
    const { deps, units } = world({
      now: () => T0,
      replies: [reply({ actions: [], hypotheses: [{ target: 'effort', patch: { effort: { local: 'high' } }, statement: 's', metric: 'm', predictedDelta: 1 }] })],
    });
    const r = await runLeader(deps, 'manual');
    expect(units.hypotheses.size).toBe(1);
    expect(r.memo!.actions).toHaveLength(1);
    expect(r.memo!.actions[0]).toMatchObject({ kind: 'experiment.start', status: 'refused' });
    expect(units.started).toHaveLength(0);
  });

  it('prunes: with 21 open goals the prompt demands focus first', async () => {
    for (let i = 0; i < 21; i += 1) goalsStore.createGoal(`Goal number ${i}`);
    const { deps, calls } = world({ now: () => T0 });
    await runLeader(deps, 'schedule');
    expect(calls[0]).toMatch(/FOCUS FIRST: 21 goals are open; at most 4/);
  });
});

describe('prompt', () => {
  it('names no real person and wraps all evidence as untrusted data', async () => {
    expect(LEADER_SYSTEM_PROMPT).not.toMatch(/elon|musk/i);
    expect(LEADER_SYSTEM_PROMPT).toMatch(/Visionary/);
    const state: LeaderRunState = { v: 1, lastRun: null, runDays: {}, lastEvidenceDigest: null, lastDeepRunAt: null, lastMemoAt: null, baselines: {}, outcomes: [] };
    const { deps } = world({ now: () => T0 });
    const evidence = await gatherLeaderEvidence(deps.sources, T0, state);
    const prompt = buildLeaderPrompt(evidence, { dryRun: true, nowIso: new Date(T0).toISOString() });
    const outside = prompt.replace(/=== BEGIN UNTRUSTED DATA[\s\S]*?=== END UNTRUSTED DATA: [^\n]*===/g, '');
    expect(outside).not.toMatch(/Should ashlr-cortex/);
    expect(prompt.match(/=== BEGIN UNTRUSTED DATA/g)!.length).toBeGreaterThanOrEqual(10);
    // A failing source is reported as unknown, not as zero.
    const broken = { ...deps.sources, holds: () => { throw new Error('x'); } };
    expect((await gatherLeaderEvidence(broken, T0, state)).unknown).toContain('holds');
  });
});

describe('cadence', () => {
  const empty: LeaderRunState = { v: 1, lastRun: null, runDays: {}, lastEvidenceDigest: null, lastDeepRunAt: null, lastMemoAt: null, baselines: {}, outcomes: [] };
  const quiet = { mergesSinceLastRun: 0, revertsSinceLastRun: 0, seatResetSinceLastRun: false, highInsightSinceLastRun: false };

  it('the daily 06:30 run, then triggers', () => {
    const slots = scheduleSlots(Date.parse('2026-09-24T06:00:00.000Z'));
    expect(new Date(slots.previous).toISOString()).toBe('2026-09-23T06:30:00.000Z');
    expect(new Date(slots.next).toISOString()).toBe('2026-09-24T06:30:00.000Z');
    expect(leaderRunDue(Date.parse('2026-09-24T07:00:00.000Z'), empty, quiet)).toMatchObject({ due: true, trigger: 'schedule' });
    const ranToday = { ...empty, lastRun: { at: '2026-09-24T06:31:00.000Z', outcome: 'ok' as const, reason: null, memoId: null, trigger: 'schedule' as const } };
    const at = Date.parse('2026-09-24T12:00:00.000Z');
    expect(leaderRunDue(at, ranToday, quiet).due).toBe(false);
    expect(leaderRunDue(at, ranToday, { ...quiet, mergesSinceLastRun: 10 })).toMatchObject({ due: true, trigger: 'merges' });
    expect(leaderRunDue(at, ranToday, { ...quiet, mergesSinceLastRun: 9 }).due).toBe(false);
    expect(leaderRunDue(at, ranToday, { ...quiet, revertsSinceLastRun: 1 })).toMatchObject({ trigger: 'revert' });
    expect(leaderRunDue(at, ranToday, { ...quiet, seatResetSinceLastRun: true })).toMatchObject({ trigger: 'seat-reset' });
    expect(leaderRunDue(at, ranToday, { ...quiet, highInsightSinceLastRun: true })).toMatchObject({ trigger: 'insight' });
    expect(leaderRunDue(at, { ...ranToday, runDays: { '2026-09-24': 3 } }, { ...quiet, revertsSinceLastRun: 4 }).due).toBe(false);
  });

  it('leaderTick counts ledger merges since the last run and starts a run', async () => {
    let now = Date.parse('2026-09-24T06:40:00.000Z');
    const { deps, calls } = world({ now: () => now, replies: [reply(), reply({ killList: [{ target: { kind: 'goal', id: 'g' }, why: 'w' }] })] });
    const first = await leaderTick(deps, { awaitRun: true });
    expect(first).toMatchObject({ started: true, due: { trigger: 'schedule' } });
    now += 3_600_000;
    expect((await leaderTick(deps, { awaitRun: true })).started).toBe(false);
    for (let i = 0; i < 10; i += 1) {
      ledger.append({ kind: 'note', data: { topic: 't', detail: 'd' }, actor: 'daemon', grantId: null, repo: null });
      ledger.entries[ledger.entries.length - 1]!.kind = 'merge:landed' as never;
    }
    const third = await leaderTick(deps, { awaitRun: true });
    expect(third).toMatchObject({ started: true, due: { trigger: 'merges' } });
    expect(calls).toHaveLength(2);
  });
});

describe('accountability', () => {
  it('gradeMove: direction and at least half the promised size', () => {
    expect(gradeMove(4, 2)).toBe(true);
    expect(gradeMove(4, 1)).toBe(false);
    expect(gradeMove(-2, -1)).toBe(true);
    expect(gradeMove(-2, 0)).toBe(false);
    expect(gradeMove(0, 1)).toBe(true);
    expect(gradeMove(3, null)).toBeNull();
    expect(computeHitRate([], 0)).toEqual({ windowDays: 30, graded: 0, hits: 0, rate: null });
  });

  it('grades a move after 7 days against the measured metric and feeds the hit-rate', async () => {
    let now = T0;
    for (let i = 0; i < 6; i += 1) goalsStore.createGoal(`Open goal ${i}`);
    const { deps } = world({ now: () => now });
    const r = await runLeader(deps, 'manual');
    expect(readLeaderRunState().baselines[r.memo!.id]!.value).toBe(6);
    // Nothing graded before 7 days.
    now = T0 + 6 * 86_400_000;
    expect(await gradeLeaderOutcomes(deps)).toEqual([]);
    // Two goals archived by then: active-goals moved -2 as promised.
    const [a, b] = goalsStore.listGoals();
    for (const g of [a!, b!]) { g.status = 'archived'; goalsStore.saveGoal(g); }
    now = T0 + 8 * 86_400_000;
    const graded = await gradeLeaderOutcomes(deps);
    expect(graded).toEqual([expect.objectContaining({ memoId: r.memo!.id, metric: 'active-goals', expectedDelta: -2, actualDelta: -2, hit: true })]);
    expect(ledger.rows('leader:outcome')).toHaveLength(1);
    expect(await gradeLeaderOutcomes(deps)).toEqual([]);
    const state = buildLeaderState(now);
    expect(state.hitRate).toMatchObject({ graded: 1, hits: 1, rate: 1 });
    expect(state.timeline[0]!.outcome?.hit).toBe(true);
    expect(state.latest?.id).toBe(r.memo!.id);
  });
});


describe('Leader preference evidence and prompt agree', () => {
  it('does not demand archiving21 goals solely to meet a removed open-goal preference', async () => {
    for (let i = 0; i < 21; i += 1) goalsStore.createGoal(`Uncapped goal ${i}`);
    const { deps, calls } = world({ now: () => T0 });
    deps.cfg.foundry = { ...(deps.cfg.foundry ?? {}), goalPreferences: { maxOpenGoals: null } };
    const preferences = resolveGoalPreferences(deps.cfg);
    await runLeader(deps, 'schedule');
    expect(calls[0]).not.toContain('FOCUS FIRST');
    expect(calls[0]).toMatch(/"focusLimit":\s*null/);
    expect(buildLeaderSystemPrompt(preferences)).toContain('do not pause or archive goals solely');
    expect(buildLeaderSystemPrompt(preferences)).not.toContain('at most 4 active goals');
  });
});


describe('fresh manual Leader planning preferences', () => {
  it('uses a current injected preference snapshot rather than a stale serve-start config', async () => {
    const { deps, calls } = world({ now: () => T0, replies: [reply({ goals: Array.from({ length: 5 }, (_, i) => ({ objective: `Fresh preference goal ${i}`, rationale: 'r', targetRepo: 'ashlrai/binshield' })) })] });
    expect(resolveGoalPreferences(deps.cfg).maxGoalProposalsPerMemo).toBe(3);
    deps.apply.goalPreferences = () => resolveGoalPreferences({ foundry: { goalPreferences: { maxGoalProposalsPerMemo: 5, maxOpenGoals: null, maxNewGoalsPerDay: null } } });
    const result = await runLeader(deps, 'manual');
    expect(calls[0]).toContain('Propose at most 5 goals');
    expect(result.memo?.goals).toHaveLength(5);
  });
});


describe('operator daily Leader preferences use current observations and live policy', () => {
  it('allows5 explicit full runs, retains the default3 ceiling, and strict config failure calls no model', async () => {
    const { deps, calls } = world({ now: () => T0, replies: Array.from({ length: 6 }, () => reply()) });
    deps.liveConfig = () => ({ foundry: { leaderPreferences: { maxFullRunsPerDay: 5, maxTotalRunsPerDay: 5 } } } as AshlrConfig);
    for (let i = 0; i < 5; i += 1) expect((await runLeader(deps, 'manual', { force: true })).outcome).toBe('ok');
    expect((await runLeader(deps, 'manual', { force: true })).reason).toMatch(/5 times today/);
    expect(calls).toHaveLength(5);
    deps.liveConfig = () => { throw new Error('private config error'); };
    const failed = await runLeader(deps, 'manual', { force: true });
    expect(failed.reason).toBe('Live Leader configuration is invalid or unavailable.');
    expect(calls).toHaveLength(5);
    expect(buildLeaderState(T0).dailyRunCounts).toMatchObject({ total: 5, full: 5, sourceState: 'ready' });
  });
  it('keeps corrupt current-day history unknown, permits explicitnull metrics, and recovers next local day', async () => {
    let now = T0;
    ensurePrivateDirectory(dirname(leaderStatePath()));
    writePrivateFileAtomic(leaderStatePath(), '{broken');
    const { deps, calls } = world({ now: () => now, replies: [reply(), reply()] });
    expect((await runLeader(deps, 'manual', { force: true })).reason).toMatch(/required run counts/);
    expect(calls).toHaveLength(0);
    deps.cfg.foundry = { leaderPreferences: { maxFullRunsPerDay: null, maxTotalRunsPerDay: null } };
    expect((await runLeader(deps, 'manual', { force: true })).outcome).toBe('ok');
    const recovered = readLeaderRunState(now);
    expect(recovered.dailyCountsComplete).toBe(false);
    expect(recovered.dailyCountsUnknownThroughDay).toBe('2026-09-24');
    expect(buildLeaderState(now).dailyRunCounts).toMatchObject({ total: null, full: null, sourceState: 'unavailable' });
    deps.cfg.foundry = {};
    expect((await runLeader(deps, 'manual', { force: true })).reason).toMatch(/required run counts/);
    now += 86_400_000;
    expect((await runLeader(deps, 'manual', { force: true })).outcome).toBe('ok');
    expect(buildLeaderState(now).dailyRunCounts).toMatchObject({ total: 1, full: 1, sourceState: 'ready' });
  });
  it('does not reinterpret malformed current-day numeric counts as zero', async () => {
    ensurePrivateDirectory(dirname(leaderStatePath()));
    writePrivateFileAtomic(leaderStatePath(), JSON.stringify({ v: 1, runDays: { '2026-09-24': 'bad' }, checkinDays: {} }));
    const { deps, calls } = world({ now: () => T0 });
    expect((await runLeader(deps, 'manual', { force: true })).reason).toMatch(/required run counts/);
    expect(calls).toHaveLength(0);
    expect(buildLeaderState(T0).dailyRunCounts).toMatchObject({ total: null, full: null, sourceState: 'unavailable' });
    expect(buildLeaderState(T0).health.status).toBe('degraded');
  });
});


it('does not present a historical ready Leader policy as current when live config is corrupt', async () => {
  const { deps } = world({ now: () => T0 });
  expect((await runLeader(deps, 'manual')).outcome).toBe('ok');
  const config = join(home.home(), '.ashlr', 'config.json');
  ensurePrivateDirectory(dirname(config));
  writePrivateFileAtomic(config, '{broken private configuration');
  const original = readFileSync(config);
  const mtime = statSync(config).mtimeMs;
  const state = buildLeaderState(T0);
  expect(state.health).toMatchObject({ status: 'degraded', nextDueAt: null });
  expect(state.health?.summary).toMatch(/preferences.*could not be checked/);
  expect(readFileSync(config)).toEqual(original);
  expect(statSync(config).mtimeMs).toBe(mtime);
});


it('requires finite full-run history for full runs, not for an explicit admitted check-in', async () => {
  ensurePrivateDirectory(dirname(leaderStatePath()));
  writePrivateFileAtomic(leaderStatePath(), JSON.stringify({ v: 1, runDays: { '2026-09-24': 2 }, checkinDays: { '2026-09-24': 'bad' } }));
  const { deps, calls } = world({ now: () => T0 });
  deps.cfg.foundry = { leaderPreferences: { maxFullRunsPerDay: 3, maxTotalRunsPerDay: 10 } };
  expect((await runLeader(deps, 'manual', { force: true })).reason).toMatch(/required run counts/);
  expect(calls).toHaveLength(0);
  expect((await runLeader(deps, 'checkin', { force: true })).outcome).toBe('ok');
  expect(buildLeaderState(T0).dailyRunCounts).toMatchObject({ total: 3, full: null });
});
