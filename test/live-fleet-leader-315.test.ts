/**
 * 3.15 "the live fleet actually works" — Leader goal hygiene and Needs-you.
 *
 * Live evidence (Verse 3.14.0, 2026-09-27): grant #2 active, rollout stage
 * `shadow` (leaderClasses []), switch Autonomous. The Leader's memo proposed
 * focusing 3 in-grant goals and pausing/archiving 19 unreachable ones — all
 * 26 actions came back "dry run: stage shadow does not let the Leader act
 * yet", and a 3-day-old class-C ask from a superseded memo stayed in
 * Needs-you.
 *
 *   - goal hygiene (focus / pause / reorder / archive) applies whenever
 *     autonomy is on, independent of the rollout ladder;
 *   - everything else still waits for the ladder (work.dispatch, router,
 *     lanes, goal.create) and no grant / Propose is still a full dry run;
 *   - a class-C ask carried by an older memo is superseded by the newest ok
 *     memo; an approved ask leaves the drawer.
 *
 * Hermetic: tmp HOME, fake ledger, real goal store.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enactLeaderActions,
  isLeaderDryRun,
  leaderGoalHygieneApplies,
  planLeaderAction,
  type LeaderPolicyContext,
} from '../src/core/vision/leader-apply.js';
import { actionIdFor, type AnyLeaderActionDraft } from '../src/core/vision/leader-memo.js';
import { LEADER_GOAL_HYGIENE_KINDS, type LeaderAction, type LeaderMemo } from '../src/core/vision/leader-types.js';
import { memoSummaryText } from '../src/core/vision/leader-thread.js';
import { buildLeaderNeedsYou } from '../src/core/verse/leader-api.js';
import * as goalsStore from '../src/core/goals/store.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;

beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
});

afterEach(() => {
  home.teardown();
});

const MEMO = 'lm-20260927103029-ff2f14';
const NOW = Date.parse('2026-09-27T10:30:29.192Z');

/** The live shadow stage: autonomous switch, no leader classes. */
const SHADOW = makePolicy({
  leader: { classes: [], vetoMinutes: 30 },
  rollout: { stageId: 'shadow', stageIndex: 0, stageCount: 8, enteredAt: '2026-09-27T05:53:40.399Z' },
});

function draft<K extends AnyLeaderActionDraft['kind']>(kind: K, params: Extract<AnyLeaderActionDraft, { kind: K }>['params']): AnyLeaderActionDraft {
  return { kind, params, summary: `${kind} test`, why: 'the data says so' } as AnyLeaderActionDraft;
}

function ctx(overrides: Partial<LeaderPolicyContext> = {}): LeaderPolicyContext {
  return {
    nowMs: NOW,
    policy: SHADOW,
    budgetMode: 'balanced',
    directives: null,
    codex: { ready: null, resetsAt: null },
    openGoalCount: 21,
    goalCreatesLast24h: 0,
    hypothesisIds: [],
    ...overrides,
  };
}

const meta = { id: 'la-x', memoId: MEMO, createdAtMs: NOW };

describe('Leader goal hygiene applies whenever autonomy is on', () => {
  it('names exactly the four goal-list kinds', () => {
    expect([...LEADER_GOAL_HYGIENE_KINDS].sort()).toEqual(['goal.archive', 'goal.focus', 'goal.pause', 'goal.reorder']);
  });

  it('shadow stage + Autonomous: goal hygiene is scheduled (class A, applies at once)', () => {
    expect(isLeaderDryRun(SHADOW)).toBe(true);
    expect(leaderGoalHygieneApplies(SHADOW)).toBe(true);
    for (const d of [
      draft('goal.focus', { goalId: 'g-a-111111' }),
      draft('goal.pause', { goalId: 'g-a-111111', until: null }),
      draft('goal.archive', { goalId: 'g-a-111111' }),
      draft('goal.reorder', { goalIds: ['g-a-111111', 'g-b-222222'] }),
    ]) {
      const a = planLeaderAction(d, meta, ctx());
      expect(a).toMatchObject({ class: 'A', status: 'scheduled', applyAfter: new Date(NOW).toISOString() });
    }
  });

  it('everything else still waits for the ladder in shadow', () => {
    const task = { repo: 'ashlrai/binshield', source: 'leader' as const, title: 't', detail: '', difficulty: 'low' as const, value: 3, requestedBy: 'leader' as const };
    for (const d of [
      draft('work.dispatch', { task }),
      draft('standard.add', { rule: 'r', appliesTo: '*', evidence: null }),
      draft('router.tune', { tuning: { lambdaCost: 2 } }),
    ]) {
      const a = planLeaderAction(d, meta, ctx());
      expect(a.status).toBe('refused');
      expect(a.statusReason).toBe('dry run: stage shadow does not let the Leader act yet.');
    }
  });

  it('no grant or a Propose switch is still a full dry run — goal hygiene included', () => {
    expect(leaderGoalHygieneApplies(null)).toBe(false);
    expect(leaderGoalHygieneApplies(makePolicy({ switch: 'propose', leader: { classes: [], vetoMinutes: 30 } }))).toBe(false);
    const none = planLeaderAction(draft('goal.pause', { goalId: 'g-a-111111', until: null }), meta, ctx({ policy: null }));
    expect(none).toMatchObject({ status: 'refused' });
    expect(none.statusReason).toMatch(/^dry run: no standing grant/);
    const propose = planLeaderAction(draft('goal.archive', { goalId: 'g-a-111111' }), meta,
      ctx({ policy: makePolicy({ switch: 'propose', leader: { classes: [], vetoMinutes: 30 } }) }));
    expect(propose.statusReason).toMatch(/^dry run: the autonomy switch is on Propose/);
  });

  it('goal.create is not hygiene: it stays class B and still meets the focus limit', () => {
    // goal.create is class B and not hygiene: refused by the focus limit, never scheduled.
    const g = draft('goal.create', { goal: { objective: 'o', rationale: '', targetRepo: null, deliverable: null, acceptanceEvidence: [] } });
    expect(planLeaderAction(g, meta, ctx()).status).toBe('refused');
  });

  it('enacts in shadow: the goal is really paused / archived, with a ledger row and an inverse', async () => {
    const g1 = goalsStore.createGoal('Out-of-grant goal on ashlr-md', { now: '2026-08-18T00:00:00.000Z' });
    const g2 = goalsStore.createGoal('Meta goal superseded by the focus limit', { now: '2026-08-18T00:00:00.000Z' });
    const { deps } = makeApplyDeps({ ledger, now: () => NOW, policy: () => SHADOW });
    const actions = await enactLeaderActions(deps, MEMO, [
      draft('goal.pause', { goalId: g1.id, until: null }),
      draft('goal.archive', { goalId: g2.id }),
      draft('router.tune', { tuning: { lambdaCost: 2 } }),
    ], [], { idFor: (i) => actionIdFor(MEMO, i) });
    expect(actions.map((a) => a.status)).toEqual(['applied', 'applied', 'refused']);
    expect(goalsStore.loadGoal(g1.id)?.status).toBe('paused');
    expect(goalsStore.loadGoal(g2.id)?.status).toBe('archived');
    expect(actions[0]!.inverse).toMatchObject({ op: 'restore-goals' });
    const rows = ledger.rows('leader:action');
    expect(rows.filter((r) => r.status === 'applied').map((r) => r.kind)).toEqual(['goal.pause', 'goal.archive']);
  });

  it('the memo summary says goal hygiene applied instead of "nothing applies"', () => {
    const base = {
      v: 1, id: MEMO, at: new Date(NOW).toISOString(), status: 'ok', statusReason: null, trigger: 'schedule', dryRun: true,
      seatId: 'claude', model: 'm', evidenceDigest: 'd'.repeat(64), bottleneck: null, move: null, killList: [],
      goals: [], priorityChanges: [], standards: [], critiques: [], seatPlan: [], hypotheses: [], questionsForMason: [],
    } as unknown as LeaderMemo;
    expect(memoSummaryText({ ...base, actions: [] })).toContain('(dry run — nothing applies without a grant)');
    const applied = { kind: 'goal.pause', status: 'applied', class: 'A', summary: 's', id: 'la-1' } as unknown as LeaderAction;
    expect(memoSummaryText({ ...base, actions: [applied] })).toContain('goal hygiene applied');
  });
});

describe('Needs-you: superseded and approved class-C asks leave the drawer', () => {
  const OLD_MEMO = 'lm-20260924231529-38eb88';
  const DRIVE = 'lm-20260926120000-aaaaaa';
  const now = Date.parse('2026-09-27T21:20:00.000Z');
  function escalated(id: string, memoId: string, createdAt: string): LeaderAction {
    return {
      v: 1, id, memoId, kind: 'escalate', class: 'C', status: 'escalated', statusReason: 'The Leader asked Mason directly.',
      params: { request: 'Designate a target repository for the fleet\'s first goal', argument: 'targetRepo is null' },
      summary: 'Ask Mason', why: null, createdAt, appliedAt: null, vetoedAt: null, vetoNote: null, inverse: null,
      applyAfter: null, deferredForQuietHours: false,
    } as unknown as LeaderAction;
  }
  const latest = { id: MEMO, at: '2026-09-27T10:30:29.192Z', status: 'ok' as const, questionsForMason: [] };

  it('an ask from an older memo is superseded by the newest ok memo (live: the 09-24 target-repo ask)', () => {
    const stale = escalated('la-20260924231529-38eb88-3', OLD_MEMO, '2026-09-24T23:17:47.483Z');
    const current = escalated(`${MEMO}-9`, MEMO, '2026-09-27T10:32:27.000Z');
    const memoIds = new Set([OLD_MEMO, MEMO]);
    const items = buildLeaderNeedsYou([stale, current], latest, new Set(), now, new Set(), { memoIds });
    expect(items.map((i) => i.id)).toEqual([`leader:class-c:${MEMO}-9`]);
    // Without the memo inventory (older callers) nothing is superseded — the plain 7-day window.
    expect(buildLeaderNeedsYou([stale, current], latest, new Set(), now).map((i) => i.id)).toHaveLength(2);
  });

  it('an ask that no memo carried (a Leader-drive pick) keeps the 7-day window', () => {
    const drive = escalated('la-drive-1', DRIVE, '2026-09-26T12:00:00.000Z');
    const items = buildLeaderNeedsYou([drive], latest, new Set(), now, new Set(), { memoIds: new Set([MEMO]) });
    expect(items.map((i) => i.id)).toEqual(['leader:class-c:la-drive-1']);
  });

  it('an approved ask is done', () => {
    const current = escalated(`${MEMO}-9`, MEMO, '2026-09-27T10:32:27.000Z');
    const items = buildLeaderNeedsYou([current], latest, new Set(), now, new Set(), {
      memoIds: new Set([MEMO]),
      approvedActionIds: new Set([`${MEMO}-9`]),
    });
    expect(items).toEqual([]);
  });
});
