/**
 * V3.10 B-U8 — Leader action policy, apply and veto (SPEC-310B §4, §7 U8 key
 * tests; addendum §6):
 *   - class C is refused (escalated, never applied);
 *   - class A applies at once and records an exact inverse on the ledger;
 *   - class B waits out its veto window, deferred past quiet hours when it
 *     raises spend; applies only when the ledger confirms its scheduled row
 *     and the grant still allows it;
 *   - all-in is capped at the grant's maxMode;
 *   - a veto restores the prior state byte-for-byte and writes a playbook delta;
 *   - the ledger failing closed stops every raise, never a lowering.
 *
 * Hermetic: tmp HOME, fake ledger, real goal + budget stores. No seat is prompted.
 */
import { resolveGoalPreferences, unavailableGoalPreferences } from '../src/core/goals/preferences.js';
import { resolveLeaderPreferences, unavailableLeaderPreferences } from '../src/core/vision/leader-preferences.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDueLeaderActions,
  buildPolicyContext,
  leaderActionsPath,
  classBApplyAfter,
  classifyLeaderAction,
  codexReadinessFromSnapshot,
  enactLeaderActions,
  goalLockPathFor,
  isLeaderDryRun,
  leaderDirectivesPath,
  listLeaderActions,
  planLeaderAction,
  readLeaderDirectives,
  readStandards,
  serializeDirectives,
  vetoLeaderAction,
  vetoLeaderMemo,
  type LeaderPolicyContext,
} from '../src/core/vision/leader-apply.js';
import { actionIdFor, readLeaderMemo, writeLeaderMemo, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import type { LeaderMemo } from '../src/core/vision/leader-types.js';
import * as goalsStore from '../src/core/goals/store.js';
import * as budgetStore from '../src/core/routing/budget-store.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../src/core/verse/preferences.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;
let savedTz: string | undefined;

beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
  savedTz = process.env['TZ'];
  // Quiet hours are LOCAL time; pin the zone so the window math is deterministic.
  process.env['TZ'] = 'UTC';
});

afterEach(() => {
  home.teardown();
  if (savedTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = savedTz;
});

const MEMO = 'lm-20260924120000-abcdef';
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function draft<K extends AnyLeaderActionDraft['kind']>(kind: K, params: Extract<AnyLeaderActionDraft, { kind: K }>['params']): AnyLeaderActionDraft {
  return { kind, params, summary: `${kind} test`, why: 'because the data says so' } as AnyLeaderActionDraft;
}

function ctx(overrides: Partial<LeaderPolicyContext> = {}): LeaderPolicyContext {
  return {
    nowMs: NOW,
    policy: makePolicy(),
    budgetMode: 'balanced',
    directives: null,
    codex: { ready: null, resetsAt: null },
    openGoalCount: 2,
    goalCreatesLast24h: 0,
    hypothesisIds: [],
    ...overrides,
  };
}

function memoFile(id = MEMO, extra: Partial<LeaderMemo> = {}): void {
  writeLeaderMemo({
    v: 1, id, at: new Date(NOW).toISOString(), status: 'ok', statusReason: null, trigger: 'manual', dryRun: false,
    seatId: 'local:qwen', model: 'qwen', evidenceDigest: 'd'.repeat(64), bottleneck: null, move: null, killList: [],
    goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [], questionsForMason: [], actions: [],
    ...extra,
  });
}

describe('classifyLeaderAction — the pure policy check', () => {
  it('escalate is always class C', () => {
    expect(classifyLeaderAction(draft('escalate', { request: 'r', argument: 'a' }), ctx()).class).toBe('C');
  });

  it('budget toward reserve is class A; toward all-in is B only up to the grant maxMode', () => {
    expect(classifyLeaderAction(draft('budget.mode', { to: 'reserve' }), ctx()).class).toBe('A');
    const allIn = classifyLeaderAction(draft('budget.mode', { to: 'all-in' }), ctx({ budgetMode: 'balanced' }));
    // Grant maxMode is balanced → all-in is outside the grant.
    expect(allIn.class).toBe('C');
    expect(allIn.reason).toMatch(/above the grant's budget ceiling/);
    const within = classifyLeaderAction(draft('budget.mode', { to: 'balanced' }), ctx({ budgetMode: 'reserve' }));
    expect(within).toMatchObject({ class: 'B', verdict: 'ok', spendRaising: true });
    const grantAllIn = ctx({ policy: makePolicy({ spend: { ...makePolicy().spend, maxMode: 'all-in' } }) });
    expect(classifyLeaderAction(draft('budget.mode', { to: 'all-in' }), grantAllIn).class).toBe('B');
    expect(classifyLeaderAction(draft('budget.mode', { to: 'balanced' }), ctx()).verdict).toBe('refused');
  });

  it('grok lanes: at or below 2 is A, 3–4 is B, and nothing is raised when the grant lacks grok-cli', () => {
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 1 }), ctx()).class).toBe('A');
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 3 }), ctx()).class).toBe('B');
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 4 }), ctx()).class).toBe('B');
    const noGrok = ctx({ policy: makePolicy({ engines: ['local'] }) });
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 3 }), noGrok).class).toBe('C');
    // Lowering needs nothing, even without grok-cli.
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 1 }), { ...noGrok, directives: { v: 1, updatedAt: 'x', routerTuning: null, grokLanes: 3, codexEnabled: null } }).class).toBe('A');
  });

  it('codex lanes need the grant to list codex AND usage to have reset', () => {
    expect(classifyLeaderAction(draft('lanes.codex', { enabled: true }), ctx()).class).toBe('C');
    const withCodex = makePolicy({ engines: ['local', 'grok-cli', 'codex'] });
    const notReset = classifyLeaderAction(draft('lanes.codex', { enabled: true }), ctx({ policy: withCodex, codex: { ready: false, resetsAt: '2026-09-26T00:00:00.000Z' } }));
    expect(notReset).toMatchObject({ verdict: 'refused' });
    expect(notReset.reason).toMatch(/2026-09-26/);
    expect(classifyLeaderAction(draft('lanes.codex', { enabled: true }), ctx({ policy: withCodex, codex: { ready: true, resetsAt: null } }))).toMatchObject({ class: 'B', verdict: 'ok' });
  });

  it('goal.create is class B, capped at 3 a day and 4 open goals; unknown inventory fails closed', () => {
    const g = draft('goal.create', { goal: { objective: 'o', rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
    expect(classifyLeaderAction(g, ctx()).class).toBe('B');
    expect(classifyLeaderAction(g, ctx({ openGoalCount: 4 })).verdict).toBe('refused');
    expect(classifyLeaderAction(g, ctx({ goalCreatesLast24h: 3 })).verdict).toBe('refused');
    expect(classifyLeaderAction(g, ctx({ openGoalCount: null })).verdict).toBe('refused');
  });

  it('work.dispatch outside the current stage repos is class C', () => {
    const task = { repo: 'ashlrai/locus', source: 'leader' as const, title: 't', detail: '', difficulty: 'low' as const, value: 3, requestedBy: 'leader' as const };
    expect(classifyLeaderAction(draft('work.dispatch', { task }), ctx()).class).toBe('C');
    expect(classifyLeaderAction(draft('work.dispatch', { task: { ...task, repo: 'ashlrai/binshield' } }), ctx()).class).toBe('A');
  });
});

describe('planLeaderAction — windows, dry runs, grants', () => {
  it('no grant, a propose switch or a shadow stage is a dry run: nothing is scheduled', () => {
    expect(isLeaderDryRun(null)).toBe(true);
    expect(isLeaderDryRun(makePolicy({ switch: 'propose' }))).toBe(true);
    expect(isLeaderDryRun(makePolicy({ leader: { classes: [], vetoMinutes: 30 } }))).toBe(true);
    const a = planLeaderAction(draft('standard.add', { rule: 'r', appliesTo: '*', evidence: null }), { id: 'x', memoId: MEMO, createdAtMs: NOW }, ctx({ policy: null }));
    expect(a).toMatchObject({ status: 'refused', class: 'A' });
    expect(a.statusReason).toMatch(/^dry run/);
    // Class C still reaches Mason in a dry run.
    expect(planLeaderAction(draft('escalate', { request: 'r', argument: 'a' }), { id: 'y', memoId: MEMO, createdAtMs: NOW }, ctx({ policy: null })).status).toBe('escalated');
  });

  it('a class the current stage does not grant goes to Mason (class C)', () => {
    const stageA = makePolicy({ leader: { classes: ['A'], vetoMinutes: 30 }, rollout: { stageId: '2c', stageIndex: 3, stageCount: 5, enteredAt: 'x' } });
    const b = planLeaderAction(draft('lanes.grok', { slots: 3 }), { id: 'x', memoId: MEMO, createdAtMs: NOW }, ctx({ policy: stageA }));
    expect(b).toMatchObject({ class: 'C', status: 'escalated' });
    expect(b.statusReason).toMatch(/stage 2c/);
  });

  it('class B waits the grant veto window (≥ 30 min)', () => {
    const b = planLeaderAction(draft('harness.adopt', { versionId: 'h-0002', experimentId: 'exp-1' }), { id: 'x', memoId: MEMO, createdAtMs: NOW }, ctx());
    expect(b).toMatchObject({ class: 'B', status: 'scheduled', deferredForQuietHours: false });
    expect(Date.parse(b.applyAfter!) - NOW).toBe(30 * 60_000);
    const short = planLeaderAction(draft('harness.adopt', { versionId: 'h-0002', experimentId: 'exp-1' }), { id: 'x', memoId: MEMO, createdAtMs: NOW },
      ctx({ policy: makePolicy({ leader: { classes: ['A', 'B'], vetoMinutes: 5 } }) }));
    expect(Date.parse(short.applyAfter!) - NOW).toBe(30 * 60_000);
  });

  it('a spend-raising class-B action never auto-applies in quiet hours unless the budget is all-in', () => {
    const late = Date.parse('2026-09-24T23:50:00.000Z');
    const deferred = classBApplyAfter(late, 30, true, 'balanced');
    expect(deferred.deferred).toBe(true);
    expect(new Date(deferred.applyAfterMs).toISOString()).toBe('2026-09-25T07:00:00.000Z');
    expect(classBApplyAfter(late, 30, true, 'all-in')).toEqual({ applyAfterMs: late + 30 * 60_000, deferred: false });
    expect(classBApplyAfter(late, 30, false, 'balanced')).toEqual({ applyAfterMs: late + 30 * 60_000, deferred: false });
    // A window that ends after 07:00 is left alone.
    const early = Date.parse('2026-09-25T06:45:00.000Z');
    expect(classBApplyAfter(early, 30, true, 'balanced')).toEqual({ applyAfterMs: early + 30 * 60_000, deferred: false });
  });
});

describe('enact / apply / veto', () => {
  it('class C is refused: escalated, never applied, no inverse', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('budget.mode', { to: 'all-in' })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ class: 'C', status: 'escalated', inverse: null, appliedAt: null });
    expect(budgetStore.loadBudgetPolicy().mode).toBe('balanced');
    expect(existsSync(budgetStore.budgetPolicyPath())).toBe(false);
  });

  it('class A applies now and records its inverse on the ledger; veto restores the directives byte-for-byte', async () => {
    // Prior directives written with the Leader's own serializer.
    ensurePrivateDirectory(join(home.home(), '.ashlr'));
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision'));
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    const prior = serializeDirectives({ v: 1, updatedAt: '2026-09-20T00:00:00.000Z', routerTuning: { lambdaCost: 2 }, grokLanes: 2, codexEnabled: null });
    writePrivateFileAtomic(leaderDirectivesPath(), prior);
    const { deps, units } = makeApplyDeps({ ledger, now: () => NOW });

    const [a] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 1 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ class: 'A', status: 'applied' });
    expect(a!.inverse).toEqual({ op: 'restore-directives', before: JSON.parse(prior) });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
    const rows = ledger.rows('leader:action');
    expect(rows.map((r) => r.status)).toEqual(['scheduled', 'applied']);
    expect(rows[1]!.inverse).toEqual(a!.inverse);

    const veto = await vetoLeaderAction(deps, a!.id, 'too few lanes');
    expect(veto.ok).toBe(true);
    expect(veto.records[0]).toMatchObject({ restored: true, note: 'too few lanes' });
    expect(readFileSync(leaderDirectivesPath(), 'utf8')).toBe(prior);
    expect(units.playbook).toHaveLength(1);
    expect(units.playbook[0]).toMatch(/Mason vetoed the Leader's "lanes.grok test".*too few lanes/);
    expect(ledger.rows('leader:vetoed')).toHaveLength(1);
    expect(listLeaderActions()[0]).toMatchObject({ id: a!.id, status: 'vetoed', vetoNote: 'too few lanes' });
  });

  it('veto of a directive the Leader created removes the file again (it did not exist before)', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('router.tune', { tuning: { lambdaCost: 3 } })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a!.status).toBe('applied');
    expect(existsSync(leaderDirectivesPath())).toBe(true);
    await vetoLeaderAction(deps, a!.id, null);
    expect(existsSync(leaderDirectivesPath())).toBe(false);
  });

  it('budget toward reserve (class A) and its veto restore budget.json byte-for-byte', async () => {
    const seeded = budgetStore.updateBudgetPolicy({ seatId: 'claude', policy: { reservePercent: 55 } });
    const before = readFileSync(budgetStore.budgetPolicyPath(), 'utf8');
    expect(seeded.mode).toBe('balanced');
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('budget.mode', { to: 'reserve' })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ class: 'A', status: 'applied' });
    // The mode switch re-bases seat reserves, so only an exact snapshot can undo it.
    expect(budgetStore.loadBudgetPolicy().seats['claude']!.reservePercent).not.toBe(55);
    const veto = await vetoLeaderAction(deps, a!.id, null);
    expect(veto.records[0]!.restored).toBe(true);
    expect(readFileSync(budgetStore.budgetPolicyPath(), 'utf8')).toBe(before);
  });

  it('goal pause / archive and their veto restore the goal record byte-for-byte', async () => {
    const g1 = goalsStore.createGoal('Ship the pulse dashboard', { now: '2026-09-01T00:00:00.000Z' });
    const g2 = goalsStore.createGoal('Harden phantom sync', { now: '2026-09-02T00:00:00.000Z' });
    const goalPath = (id: string): string => join(home.home(), '.ashlr', 'goals', `${id}.json`);
    const before1 = readFileSync(goalPath(g1.id), 'utf8');
    const before2 = readFileSync(goalPath(g2.id), 'utf8');
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const actions = await enactLeaderActions(deps, MEMO, [
      draft('goal.pause', { goalId: g1.id, until: null }),
      draft('goal.archive', { goalId: g2.id }),
    ], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['applied', 'applied']);
    expect(goalsStore.loadGoal(g1.id)?.status).toBe('paused');
    expect(goalsStore.loadGoal(g2.id)?.status).toBe('archived');

    const veto = await vetoLeaderMemo(deps, MEMO, 'keep both');
    expect(veto.ok).toBe(true);
    expect(veto.records.every((r) => r.restored)).toBe(true);
    expect(readFileSync(goalPath(g1.id), 'utf8')).toBe(before1);
    expect(readFileSync(goalPath(g2.id), 'utf8')).toBe(before2);
  });

  it('goal.reorder saves goals so the first id is newest (top of the focus list), and veto restores all', async () => {
    const ids = ['Alpha goal', 'Beta goal', 'Gamma goal'].map((o, i) => goalsStore.createGoal(o, { now: `2026-09-0${i + 1}T00:00:00.000Z` }).id);
    const befores = ids.map((id) => readFileSync(join(home.home(), '.ashlr', 'goals', `${id}.json`), 'utf8'));
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const desired = [ids[0]!, ids[2]!, ids[1]!];
    const [a] = await enactLeaderActions(deps, MEMO, [draft('goal.reorder', { goalIds: desired })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a!.status).toBe('applied');
    expect(goalsStore.listGoals().map((g) => g.id)).toEqual(desired);
    await vetoLeaderAction(deps, a!.id, null);
    ids.forEach((id, i) => expect(readFileSync(join(home.home(), '.ashlr', 'goals', `${id}.json`), 'utf8')).toBe(befores[i]));
  });

  it('when the goal changed after the action, a veto restores the status only and says so', async () => {
    const g = goalsStore.createGoal('Mutating goal', { now: '2026-09-01T00:00:00.000Z' });
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('goal.pause', { goalId: g.id, until: null })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    // Someone else edits the goal (a planner adds a milestone).
    goalsStore.addMilestone(g.id, { title: 'm1', detail: 'd' });
    const veto = await vetoLeaderAction(deps, a!.id, null);
    expect(veto.records[0]).toMatchObject({ restored: false });
    expect(veto.records[0]!.detail).toMatch(/status put back to planning/);
    const after = goalsStore.loadGoal(g.id)!;
    expect(after.status).toBe('planning');
    expect(after.milestones).toHaveLength(1);
  });

  it('the store lock path is the goal store’s own (saveGoal waits on it)', () => {
    const g = goalsStore.createGoal('Locked goal');
    const lock = acquireLocalStoreLock(goalLockPathFor(g.id), 100);
    expect(lock).not.toBeNull();
    try {
      const copy = goalsStore.loadGoal(g.id)!;
      copy.status = 'paused';
      // saveGoal waits ~2 s for the lock and then gives up — proving it is the same lock.
      expect(goalsStore.saveGoal(copy)).toBe(false);
    } finally {
      releaseLocalStoreLock(lock);
    }
    const copy = goalsStore.loadGoal(g.id)!;
    copy.status = 'paused';
    expect(goalsStore.saveGoal(copy)).toBe(true);
  }, 10_000);

  it('the other class-A kinds apply through their units and their vetoes run the inverse', async () => {
    memoFile(MEMO, {
      hypotheses: [{
        v: 1, id: 'hyp-20260924120000-abcdef-0', source: { kind: 'leader', ref: MEMO }, target: 'effort',
        patch: { effort: { local: 'high' } }, statement: 's', metric: 'm', predictedDelta: 1, createdAt: 'x',
      }],
    });
    const { deps, units } = makeApplyDeps({ ledger, now: () => NOW });
    // runLeader records a memo's hypotheses in the harness registry before its actions run.
    deps.recordHypotheses(readLeaderMemo(MEMO)!.hypotheses);
    const task = { repo: 'ashlrai/binshield', source: 'leader' as const, title: 'Add tests', detail: '', difficulty: 'low' as const, value: 3, requestedBy: 'leader' as const };
    const actions = await enactLeaderActions(deps, MEMO, [
      draft('work.dispatch', { task }),
      draft('standard.add', { rule: 'Every fix ships a failing test first', appliesTo: 'producer', evidence: null }),
      draft('repo.pause', { repo: 'ashlrai/binshield', reason: 'red CI', until: null }),
      draft('pr.close', { repo: 'ashlrai/binshield', number: 12, reason: 'superseded' }),
      draft('experiment.start', { hypothesisId: 'hyp-20260924120000-abcdef-0' }),
    ], ['hyp-20260924120000-abcdef-0'], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => [a.kind, a.status])).toEqual([
      ['work.dispatch', 'applied'],
      ['standard.add', 'applied'],
      ['repo.pause', 'applied'],
      ['pr.close', 'applied'],
      ['experiment.start', 'applied'],
    ]);
    expect(units.tasks.get('task-1')?.status).toBe('queued');
    expect(readStandards()).toHaveLength(1);
    expect(units.holds.size).toBe(1);
    expect(units.prs.get('ashlrai/binshield#12')).toBe('closed');
    expect(units.experiments.get('exp-1')).toBe('queued');

    const veto = await vetoLeaderMemo(deps, MEMO, null);
    expect(veto.records).toHaveLength(5);
    expect(units.tasks.get('task-1')?.status).toBe('cancelled');
    expect(readStandards()[0]!.retiredAt).not.toBeNull();
    expect(units.holds.size).toBe(0);
    expect(units.prs.get('ashlrai/binshield#12')).toBe('open');
    expect(units.experiments.get('exp-1')).toBe('cancelled');
  });

  it('experiment.start starts only the harness registry\'s copy of the memo\'s hypothesis', async () => {
    const HID = 'hyp-20260924120000-abcdef-0';
    const hypothesis = {
      v: 1 as const, id: HID, source: { kind: 'leader' as const, ref: MEMO }, target: 'effort' as const,
      patch: { effort: { local: 'high' as const } }, statement: 's', metric: 'm', predictedDelta: 1, createdAt: 'x',
    };
    memoFile(MEMO, { hypotheses: [hypothesis] });
    const start = async (deps: ReturnType<typeof makeApplyDeps>['deps'], i: number) =>
      (await enactLeaderActions(deps, MEMO, [draft('experiment.start', { hypothesisId: HID })], [HID], { idFor: () => actionIdFor(MEMO, i) }))[0]!;

    // Never recorded (or refused when recorded) ⇒ refused, nothing started.
    const a = makeApplyDeps({ ledger, now: () => NOW });
    const unrecorded = await start(a.deps, 0);
    expect(unrecorded).toMatchObject({ status: 'refused' });
    expect(unrecorded.statusReason).toMatch(/harness registry has no record/);
    expect(a.units.started).toHaveLength(0);

    // A different claim under the same id ⇒ refused.
    const b = makeApplyDeps({ ledger, now: () => NOW });
    b.deps.recordHypotheses([{ ...hypothesis, patch: { effort: { local: 'low' } } }]);
    const mismatch = await start(b.deps, 1);
    expect(mismatch.statusReason).toMatch(/different hypothesis/);
    expect(b.units.started).toHaveLength(0);

    // Recorded ⇒ started from the registry copy; the inverse cancels it.
    const c = makeApplyDeps({ ledger, now: () => NOW });
    c.deps.recordHypotheses([hypothesis]);
    const ok = await start(c.deps, 2);
    expect(ok).toMatchObject({ status: 'applied', inverse: { op: 'cancel-experiment', experimentId: 'exp-1' } });
    expect(c.units.started).toEqual([hypothesis]);
  });

  it('harness.adopt adopts through the registry and its veto rolls back to the prior version', async () => {
    const { deps, units } = makeApplyDeps({ ledger, now: () => NOW });
    units.harness.active = 'h-0001';
    const [b] = await enactLeaderActions(deps, MEMO, [draft('harness.adopt', { versionId: 'h-0002', experimentId: 'x-0001' })], [], {
      idFor: (i) => actionIdFor(MEMO, i),
    });
    expect(b).toMatchObject({ class: 'B', status: 'scheduled' });
    const later = makeApplyDeps({ ledger, now: () => Date.parse(b!.applyAfter!) + 1 });
    later.units.harness.active = 'h-0001';
    const [applied] = await applyDueLeaderActions(later.deps);
    expect(applied).toMatchObject({ status: 'applied', inverse: { op: 'rollback-harness', toVersionId: 'h-0001' } });
    expect(later.units.harness.active).toBe('h-0002');
    const veto = await vetoLeaderAction(later.deps, b!.id, null);
    expect(veto.ok).toBe(true);
    expect(later.units.harness.active).toBe('h-0001');
  });

  it('with the ledger unavailable nothing is applied (fail closed)', async () => {
    ledger.failAppends = true;
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 1 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(a).toMatchObject({ status: 'refused', inverse: null });
    expect(a!.statusReason).toMatch(/ledger is unavailable/);
    expect(existsSync(leaderDirectivesPath())).toBe(false);
  });

  it('class B waits; it applies after the window only when the ledger confirms it', async () => {
    let now = NOW;
    const { deps, units } = makeApplyDeps({ ledger, now: () => now });
    const [b] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(b).toMatchObject({ class: 'B', status: 'scheduled' });
    expect(units.notified.map((a) => a.id)).toEqual([b!.id]);
    expect(readLeaderDirectives()).toBeNull();

    now = NOW + 29 * 60_000;
    expect(await applyDueLeaderActions(deps)).toEqual([]);
    expect(readLeaderDirectives()).toBeNull();

    now = NOW + 31 * 60_000;
    const [applied] = await applyDueLeaderActions(deps);
    expect(applied).toMatchObject({ status: 'applied' });
    expect(readLeaderDirectives()?.grokLanes).toBe(3);
  });

  it('a scheduled action the ledger does not hold (a forged store entry) is never applied', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const [b] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 4 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    // The working copy (actions.json) still says "scheduled", but the ledger has no such row —
    // exactly what a hand-planted store entry looks like.
    ledger.entries = ledger.entries.filter((e) => !(e.kind === 'leader:action' && e.data.id === b!.id));
    now = NOW + 31 * 60_000;
    const [refused] = await applyDueLeaderActions(deps);
    expect(refused).toMatchObject({ status: 'refused' });
    expect(refused!.statusReason).toMatch(/does not match its ledger record/);
    expect(readLeaderDirectives()).toBeNull();
  });

  it('a grant revoked during the veto window stops the class-B action', async () => {
    let now = NOW;
    let policy: ReturnType<typeof makePolicy> | null = makePolicy();
    const { deps } = makeApplyDeps({ ledger, now: () => now, policy: () => policy });
    const [b] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(b!.status).toBe('scheduled');
    policy = null; // revoked
    now = NOW + 31 * 60_000;
    const [refused] = await applyDueLeaderActions(deps);
    expect(refused).toMatchObject({ status: 'refused' });
    expect(refused!.statusReason).toMatch(/grant changed during the veto window/);
    expect(readLeaderDirectives()).toBeNull();
  });

  it('vetoing a scheduled class-B action cancels it without running anything', async () => {
    let now = NOW;
    const { deps, units } = makeApplyDeps({ ledger, now: () => now });
    const [b] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 3 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    const veto = await vetoLeaderAction(deps, b!.id, 'not tonight');
    expect(veto.records[0]).toMatchObject({ inverse: null, restored: true });
    expect(units.playbook).toHaveLength(1);
    now = NOW + 31 * 60_000;
    expect(await applyDueLeaderActions(deps)).toEqual([]);
    expect(readLeaderDirectives()).toBeNull();
    const again = await vetoLeaderAction(deps, b!.id, null);
    expect(again).toMatchObject({ ok: false, code: 409 });
  });

  it('when the ledger cannot vouch for a veto, it may lower but never raise', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const [low] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 1 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
    // Vetoing the LOWERING would raise lanes back to the default 2 — with the ledger unreadable it must not.
    ledger.failReads = true;
    const veto = await vetoLeaderAction(deps, low!.id, null);
    expect(veto.records[0]).toMatchObject({ restored: false });
    expect(readLeaderDirectives()?.grokLanes).toBe(1);
    now += 1;
  });

  it('pr.close veto without a ledger confirmation leaves the PR closed', async () => {
    const { deps, units } = makeApplyDeps({ ledger, now: () => NOW });
    const [a] = await enactLeaderActions(deps, MEMO, [draft('pr.close', { repo: 'ashlrai/binshield', number: 7, reason: 'dup' })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    ledger.failReads = true;
    const veto = await vetoLeaderAction(deps, a!.id, null);
    expect(veto.records[0]!.restored).toBe(false);
    expect(units.prs.get('ashlrai/binshield#7')).toBe('closed');
  });

  it('goal.create is refused while too many goals are open, and creates (then archives on veto) otherwise', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW, enrolled: ['/work/ashlrai__binshield'] });
    const goal = { objective: 'Make binshield a merge gate', rationale: 'r', targetRepo: 'ashlrai/binshield', deliverable: null, acceptanceEvidence: [] };
    let now = NOW;
    deps.now = () => now;
    const [b] = await enactLeaderActions(deps, MEMO, [draft('goal.create', { goal })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(b!.status).toBe('scheduled');
    now = NOW + 31 * 60_000;
    const [applied] = await applyDueLeaderActions(deps);
    expect(applied!.status).toBe('applied');
    const created = goalsStore.listGoals()[0]!;
    expect(created.project).toBe('/work/ashlrai__binshield');
    expect(applied!.inverse).toEqual({ op: 'archive-goal', goalId: created.id });
    await vetoLeaderAction(deps, applied!.id, null);
    expect(goalsStore.loadGoal(created.id)?.status).toBe('archived');

    for (const o of ['a1', 'a2', 'a3', 'a4']) goalsStore.createGoal(`Open ${o}`);
    const [tooMany] = await enactLeaderActions(deps, 'lm-20260924120001-abcdef', [draft('goal.create', { goal: { ...goal, objective: 'another' } })], [], {
      idFor: (i) => actionIdFor('lm-20260924120001-abcdef', i),
    });
    expect(tooMany!.status).toBe('refused');
  });
});

describe('directives and codex readiness readers', () => {
  it('readLeaderDirectives clamps a hand-edited file', () => {
    ensurePrivateDirectory(join(home.home(), '.ashlr'));
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision'));
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    writePrivateFileAtomic(leaderDirectivesPath(), JSON.stringify({ v: 1, updatedAt: '2026-09-24T00:00:00.000Z', routerTuning: null, grokLanes: Number.MAX_SAFE_INTEGER + 1, codexEnabled: 'yes' }));
    expect(readLeaderDirectives()).toEqual({ v: 1, updatedAt: '2026-09-24T00:00:00.000Z', routerTuning: null, grokLanes: null, codexEnabled: null });
    writePrivateFileAtomic(leaderDirectivesPath(), JSON.stringify({ v: 1, updatedAt: '2026-09-24T00:00:00.000Z', routerTuning: { lambdaCost: 99 }, grokLanes: 2, codexEnabled: true }));
    expect(readLeaderDirectives()).toBeNull();
  });

  it('codex is ready only when a window is readable and not spent (unknown fails closed)', () => {
    const t = Date.parse('2026-09-24T12:00:00.000Z');
    expect(codexReadinessFromSnapshot(null, t)).toEqual({ ready: null, resetsAt: null });
    expect(codexReadinessFromSnapshot([{ engine: 'codex', windows: [{ usedPercent: 100, resetsAt: '2026-09-26T00:00:00.000Z', limitReached: true }] }], t))
      .toEqual({ ready: false, resetsAt: '2026-09-26T00:00:00.000Z' });
    expect(codexReadinessFromSnapshot([{ engine: 'codex', windows: [{ usedPercent: 100, resetsAt: '2026-09-23T00:00:00.000Z', limitReached: true }] }], t).ready).toBe(true);
    expect(codexReadinessFromSnapshot([{ engine: 'codex', windows: [{ usedPercent: null, resetsAt: null, limitReached: false }] }], t).ready).toBe(false);
    expect(codexReadinessFromSnapshot([{ engine: 'codex', windows: [{ usedPercent: 12, resetsAt: null, limitReached: false }] }], t).ready).toBe(true);
    // A reading older than 15 minutes is unknown, never "reset".
    const fresh = new Date(t - 60_000).toISOString();
    const stale = new Date(t - 3_600_000).toISOString();
    expect(codexReadinessFromSnapshot([{ engine: 'codex', observedAt: fresh, windows: [{ usedPercent: 12, resetsAt: null, limitReached: false }] }], t).ready).toBe(true);
    expect(codexReadinessFromSnapshot([{ engine: 'codex', observedAt: stale, windows: [{ usedPercent: 12, resetsAt: null, limitReached: false }] }], t).ready).toBe(false);
    expect(codexReadinessFromSnapshot([{ engine: 'codex', observedAt: null, windows: [{ usedPercent: 12, resetsAt: null, limitReached: false }] }], t).ready).toBe(false);
  });
});


describe('operator goal preferences preserve authority and observation quality', () => {
  const create = (objective = 'New bounded goal') => draft('goal.create', { goal: { objective, rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
  const preferences = (values: Record<string, number | null>) => resolveGoalPreferences({ foundry: { goalPreferences: values } });
  it('supports higher finite limits, and skips only the matching business comparison under explicit null', () => {
    expect(classifyLeaderAction(create(), ctx({ openGoalCount: 21, goalCreatesLast24h: 8,
      goalPreferences: preferences({ maxOpenGoals: 30, maxNewGoalsPerDay: 12 }) })).verdict).toBe('ok');
    expect(classifyLeaderAction(create(), ctx({ openGoalCount: null, goalCreatesLast24h: null,
      goalPreferences: preferences({ maxOpenGoals: null, maxNewGoalsPerDay: null }) })).verdict).toBe('ok');
    for (const limits of [{ maxOpenGoals: 30, maxNewGoalsPerDay: null }, { maxOpenGoals: null, maxNewGoalsPerDay: 12 }]) {
      expect(classifyLeaderAction(create(), ctx({ openGoalCount: null, goalCreatesLast24h: null,
        goalPreferences: preferences(limits) })).verdict).toBe('refused');
    }
    expect(classifyLeaderAction(create(), ctx({ goalPreferences: unavailableGoalPreferences() })).verdict).toBe('refused');
  });
  it('counts scheduled siblings against a finite daily preference beyond legacy3', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    deps.goalPreferences = () => preferences({ maxOpenGoals: null, maxNewGoalsPerDay: 5 });
    const actions = await enactLeaderActions(deps, MEMO, Array.from({ length: 6 }, (_, i) => create(`Sibling ${i}`)), [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['scheduled', 'scheduled', 'scheduled', 'scheduled', 'scheduled', 'refused']);
  });
  it('unknown/pruned history is never synthesized into a quota count; null skips only that metric', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    for (const raw of [
      { v: 1, updatedAt: new Date(NOW).toISOString(), actions: [], dismissed: [] },
      { v: 1, updatedAt: new Date(0).toISOString(), goalCreateHistoryCompleteFrom: 'bad', actions: [], dismissed: [] },
      { v: 1, updatedAt: new Date(0).toISOString(), goalCreateHistoryCompleteFrom: 0, actions: [null], dismissed: [] },
    ]) {
      writePrivateFileAtomic(leaderActionsPath(), JSON.stringify(raw));
      const context = buildPolicyContext(deps, []);
      expect(context.goalCreatesLast24h).toBeNull();
      expect(classifyLeaderAction(create(), context).verdict).toBe('refused');
      expect(classifyLeaderAction(create(), { ...context, goalPreferences: preferences({ maxNewGoalsPerDay: null }) }).verdict).toBe('ok');
    }
  });
  it('reloads at delayed apply and at the synchronous mutation fence, including daily tightening', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    const unlimited = preferences({ maxOpenGoals: null, maxNewGoalsPerDay: null });
    deps.goalPreferences = () => unlimited;
    memoFile();
    const actions = await enactLeaderActions(deps, MEMO, [create('First proposal'), create('Second proposal')], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['scheduled', 'scheduled']);
    now += 31 * 60_000;
    // First classification sees null; the mutation fence sees a newly finite daily quota.
    let reads = 0;
    deps.goalPreferences = () => ++reads === 1 ? unlimited : preferences({ maxOpenGoals: null, maxNewGoalsPerDay: 1 });
    const result = await applyDueLeaderActions(deps);
    expect(result.map((a) => a.status)).toEqual(['refused', 'applied']);
    expect(goalsStore.listGoals()).toHaveLength(1);
  });
  it('explicit null does not bypass a missing classB grant or veto', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    deps.goalPreferences = () => preferences({ maxOpenGoals: null, maxNewGoalsPerDay: null });
    memoFile();
    const [action] = await enactLeaderActions(deps, MEMO, [create('Keep veto effective')], [], { idFor: (i) => actionIdFor(MEMO, i) });
    now += 31 * 60_000;
    const [applied] = await applyDueLeaderActions(deps);
    expect(applied?.status).toBe('applied');
    expect(goalsStore.listGoals()).toHaveLength(1);
    await vetoLeaderAction(deps, action!.id, 'Stop this goal');
    expect(goalsStore.listGoals()[0]?.status).toBe('archived');
    const denied = makeApplyDeps({ ledger, now: () => now, policy: () => makePolicy({ leader: { classes: ['A'], vetoMinutes: 30 } }) });
    denied.deps.goalPreferences = deps.goalPreferences;
    const [outside] = await enactLeaderActions(denied.deps, MEMO, [create('No B authority')], [], { idFor: () => actionIdFor(MEMO, 9) });
    expect(outside?.status).toBe('escalated');
  });
});


describe('goal daily quota observation window', () => {
  const proposal = (objective: string) => draft('goal.create', { goal: { objective, rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
  it('does not discount an old scheduled action absent from the current24h tally', async () => {
    let now = NOW - 2 * 86_400_000;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    deps.goalPreferences = () => resolveGoalPreferences({ foundry: { goalPreferences: { maxOpenGoals: null, maxNewGoalsPerDay: 1 } } });
    memoFile();
    const [old] = await enactLeaderActions(deps, MEMO, [proposal('Old scheduled goal')], [], { idFor: () => actionIdFor(MEMO, 0) });
    expect(old?.status).toBe('scheduled');
    now = NOW;
    const [fresh] = await enactLeaderActions(deps, MEMO, [proposal('Current reservation')], [], { idFor: () => actionIdFor(MEMO, 1) });
    expect(fresh?.status).toBe('scheduled');
    const [oldResult] = await applyDueLeaderActions(deps);
    expect(oldResult?.status).toBe('refused');
    expect(goalsStore.listGoals()).toHaveLength(0);
    now += 31 * 60_000;
    const [freshResult] = await applyDueLeaderActions(deps);
    expect(freshResult?.status).toBe('applied');
    expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBe(1);
  });
  it('count-trim records missing recent history rather than allowing a finite quota to undercount', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const action = planLeaderAction(proposal('Retained history'), { id: 'past', memoId: MEMO, createdAtMs: NOW }, ctx());
    const actions = Array.from({ length: 400 }, (_, i) => ({ action: { ...action, id: `past-${i}`, status: 'applied', appliedAt: new Date(NOW).toISOString() }, restore: [] }));
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    writePrivateFileAtomic(leaderActionsPath(), JSON.stringify({ v: 1, updatedAt: new Date(NOW).toISOString(), goalCreateHistoryCompleteFrom: 0, actions, dismissed: [] }));
    await enactLeaderActions(deps, MEMO, [draft('standard.add', { rule: 'Keep measured evidence', appliesTo: '*', evidence: null })], [], { idFor: () => actionIdFor(MEMO, 9) });
    const context = buildPolicyContext(deps, []);
    expect(context.goalCreatesLast24h).toBeNull();
    expect(classifyLeaderAction(proposal('Finite quota'), context).verdict).toBe('refused');
    expect(classifyLeaderAction(proposal('No quota'), { ...context, goalPreferences: resolveGoalPreferences({ foundry: { goalPreferences: { maxNewGoalsPerDay: null } } }) }).verdict).toBe('ok');
  });
});


describe('no-limit goal preferences retain mutation refusal boundaries', () => {
  const proposal = (objective: string) => draft('goal.create', { goal: { objective, rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
  const unlimited = () => resolveGoalPreferences({ foundry: { goalPreferences: { maxOpenGoals: null, maxNewGoalsPerDay: null } } });
  it('rechecks class B at the final synchronous fence', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    deps.goalPreferences = unlimited;
    memoFile();
    await enactLeaderActions(deps, MEMO, [proposal('Fresh authority fence')], [], { idFor: () => actionIdFor(MEMO, 0) });
    now += 31 * 60_000;
    let policyReads = 0;
    deps.standingPolicy = () => ++policyReads === 1 ? makePolicy() : makePolicy({ leader: { classes: ['A'], vetoMinutes: 30 } });
    expect((await applyDueLeaderActions(deps))[0]?.status).toBe('refused');
    expect(policyReads).toBeGreaterThanOrEqual(2);
    expect(goalsStore.listGoals()).toHaveLength(0);
  });
  it('ledger refusal and deterministic goal duplication still prevent creation', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    deps.goalPreferences = unlimited;
    ledger.failAppends = true;
    const [failed] = await enactLeaderActions(deps, MEMO, [proposal('Ledger must accept')], [], { idFor: () => actionIdFor(MEMO, 0) });
    expect(failed?.status).toBe('refused');
    expect(goalsStore.listGoals()).toHaveLength(0);
    ledger.failAppends = false;
    goalsStore.createGoal('Already exists');
    memoFile();
    await enactLeaderActions(deps, MEMO, [proposal('Already exists')], [], { idFor: () => actionIdFor(MEMO, 1) });
    now += 31 * 60_000;
    const [duplicate] = await applyDueLeaderActions(deps);
    expect(duplicate?.status).toBe('refused');
    expect(duplicate?.statusReason).toMatch(/already exists/);
    expect(goalsStore.listGoals()).toHaveLength(1);
  });
  it('does not infer applied-time history from an old proposal timestamp', () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const action = planLeaderAction(proposal('Unknown apply time'), { id: 'past', memoId: MEMO, createdAtMs: NOW - 2 * 86_400_000 }, ctx());
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    writePrivateFileAtomic(leaderActionsPath(), JSON.stringify({ v: 1, updatedAt: new Date(NOW).toISOString(), goalCreateHistoryCompleteFrom: 0,
      actions: [{ action: { ...action, status: 'applied', appliedAt: null }, restore: [] }], dismissed: [] }));
    expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBeNull();
  });
});


describe('goal-history retention does not invent finite-quota capacity', () => {
  const create = draft('goal.create', { goal: { objective: 'Observe history', rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
  it('pruning refused goal proposals does not erase valid creation-count coverage', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    const action = planLeaderAction(create, { id: 'past', memoId: MEMO, createdAtMs: NOW }, ctx());
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    writePrivateFileAtomic(leaderActionsPath(), JSON.stringify({ v: 1, updatedAt: new Date(NOW).toISOString(), goalCreateHistoryCompleteFrom: 0,
      actions: Array.from({ length: 400 }, (_, i) => ({ action: { ...action, id: `refused-${i}`, status: 'refused' }, restore: [] })), dismissed: [] }));
    await enactLeaderActions(deps, MEMO, [draft('standard.add', { rule: 'Measure outcomes', appliesTo: '*', evidence: null })], [], { idFor: () => actionIdFor(MEMO, 10) });
    expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBe(0);
  });
  it('repairing garbled storage never resets retained-history coverage to epoch zero', async () => {
    const { deps } = makeApplyDeps({ ledger, now: () => NOW });
    ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
    writePrivateFileAtomic(leaderActionsPath(), '{garbled');
    await enactLeaderActions(deps, MEMO, [draft('standard.add', { rule: 'Do not fabricate quota state', appliesTo: '*', evidence: null })], [], { idFor: () => actionIdFor(MEMO, 11) });
    const context = buildPolicyContext(deps, []);
    expect(context.goalCreatesLast24h).toBeNull();
    expect(classifyLeaderAction(create, context).verdict).toBe('refused');
    expect(classifyLeaderAction(create, { ...context, goalPreferences: resolveGoalPreferences({ foundry: { goalPreferences: { maxNewGoalsPerDay: null } } }) }).verdict).toBe('ok');
  });
});


describe('live operator Grok maximum preference', () => {
  it('defaults to no preference cap, honors a finite maximum, and preserves authority', () => {
    const change = draft('lanes.grok', { slots: 17 });
    expect(classifyLeaderAction(change, ctx())).toMatchObject({ class: 'B', verdict: 'ok' });
    const finite = resolveLeaderPreferences({ foundry: { leaderPreferences: { maxGrokLanes: 4 } } });
    expect(classifyLeaderAction(change, ctx({ leaderPreferences: finite })).verdict).toBe('refused');
    for (const maxGrokLanes of [20, null]) {
      const leaderPreferences = resolveLeaderPreferences({ foundry: { leaderPreferences: { maxGrokLanes } } });
      expect(classifyLeaderAction(change, ctx({ leaderPreferences }))).toMatchObject({ class: 'B', verdict: 'ok' });
      const excluded = ctx({ leaderPreferences, policy: makePolicy({ engines: ['local'] }) });
      expect(classifyLeaderAction(change, excluded)).toMatchObject({ class: 'C' });
      expect(planLeaderAction(change, { id: 'excluded-lane', memoId: MEMO, createdAtMs: NOW }, excluded).status).toBe('escalated');
    }
    expect(classifyLeaderAction(change, ctx({ leaderPreferences: unavailableLeaderPreferences() })).verdict).toBe('refused');
    expect(classifyLeaderAction(draft('lanes.grok', { slots: 1 }), ctx({ leaderPreferences: unavailableLeaderPreferences() }))).toMatchObject({ class: 'A', verdict: 'ok' });
  });
  it('never installs a delayed Grok directive reclassified outside the grant at its final fence', async () => {
    let now = NOW;
    const { deps } = makeApplyDeps({ ledger, now: () => now });
    deps.leaderPreferences = () => resolveLeaderPreferences({ foundry: { leaderPreferences: { maxGrokLanes: null } } });
    const [scheduled] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 17 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(scheduled).toMatchObject({ class: 'B', status: 'scheduled' });
    now = Date.parse(scheduled!.applyAfter!) + 1;
    let policyReads = 0;
    // Delayed classification admits B; the immediately subsequent mutation
    // fence sees Grok removed and classifies C, which is never granted.
    deps.standingPolicy = () => ++policyReads === 1 ? makePolicy() : makePolicy({ engines: ['local'] });
    expect((await applyDueLeaderActions(deps))[0]?.status).toBe('refused');
    // Two admission snapshots, then the refusal's audit-ledger policy read.
    expect(policyReads).toBe(3);
    expect(readLeaderDirectives()?.grokLanes ?? null).toBeNull();
  });

  it('rechecks a tightened maximum before a delayed B directive is installed', async () => {
    let now = NOW;
    let maxGrokLanes: number | null = null;
    const { deps } = makeApplyDeps({ ledger, now: () => now, policy: () => makePolicy() });
    deps.leaderPreferences = () => resolveLeaderPreferences({ foundry: { leaderPreferences: { maxGrokLanes } } });
    const [scheduled] = await enactLeaderActions(deps, MEMO, [draft('lanes.grok', { slots: 17 })], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(scheduled?.status).toBe('scheduled');
    now = Date.parse(scheduled!.applyAfter!) + 1;
    maxGrokLanes = 4;
    const applied = await applyDueLeaderActions(deps);
    expect(applied[0]?.status).toBe('refused');
    expect(readLeaderDirectives()?.grokLanes ?? null).toBeNull();
  });
});


it('recovers finite rolling quota evidence only after a clean persisted24h observation window', async () => {
  let now = Date.now();
  const { deps } = makeApplyDeps({ ledger, now: () => now });
  ensurePrivateDirectory(join(home.home(), '.ashlr', 'vision', 'leader'));
  writePrivateFileAtomic(leaderActionsPath(), JSON.stringify({ v: 1, updatedAt: new Date(now).toISOString(), goalCreateHistoryCompleteFrom: 'bad', actions: [], dismissed: [] }));
  expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBeNull();
  await enactLeaderActions(deps, MEMO, [draft('standard.add', { rule: 'Use tests', appliesTo: 'all', evidence: 'observed' })], [], { idFor: (i) => actionIdFor(MEMO, i) });
  const persisted = JSON.parse(readFileSync(leaderActionsPath(), 'utf8'));
  expect(persisted.goalCreateHistoryCompleteFrom).toBeGreaterThanOrEqual(now);
  now = persisted.goalCreateHistoryCompleteFrom;
  expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBeNull();
  now += 86_400_001;
  expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBe(0);
  const nextMemo = 'lm-20260925120000-abcdef';
  const [reserved] = await enactLeaderActions(deps, nextMemo, [draft('goal.create', { goal: { objective: 'After known recovery', rationale: 'r', targetRepo: 'ashlrai/binshield', deliverable: null, acceptanceEvidence: [] } })], [], { idFor: (i) => actionIdFor(nextMemo, i) });
  expect(reserved?.status).toBe('scheduled');
  now = Date.parse(reserved!.applyAfter!) + 1;
  expect((await applyDueLeaderActions(deps))[0]?.status).toBe('applied');
  expect(buildPolicyContext(deps, []).goalCreatesLast24h).toBe(1);
});
