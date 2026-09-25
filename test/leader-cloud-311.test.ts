/**
 * 3.11 C5 — Leader code-change actions become cloud backlog suggestions.
 *
 *   - `work.dispatch` actions for a GitHub repo, in class A/B and not vetoed,
 *     convert to CloudBacklogItems (`leader-<memoId>-<n>`, priority from the
 *     class, prompt = action text + the memo's bottleneck context);
 *   - class C (escalated) actions stay Needs-you items — never backlogged;
 *   - duplicates within a memo are dropped (by id and normalised title);
 *   - no backlog write at all when the memo has no code-change actions;
 *   - a backlog failure is noted on the memo, never fatal.
 *
 * Hermetic: tmp HOME / ASHLR_HOME, fake ledger / sources / seat, injected
 * backlog; no model is called and no real ~/.ashlr is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEADER_CLOUD_AREA,
  LEADER_CLOUD_PROMPT_MAX,
  leaderBacklogItemId,
  leaderMemoToCloudBacklog,
  suggestLeaderCloudBacklog,
  type LeaderCloudBacklogDeps,
} from '../src/core/vision/leader-cloud.js';
import { runLeader, type LeaderEvidenceSources, type LeaderRunDeps } from '../src/core/vision/leader.js';
import type { LeaderSeatDeps } from '../src/core/vision/leader-seat.js';
import type { LeaderAction, LeaderActionClass, LeaderActionStatus, LeaderMemo } from '../src/core/vision/leader-types.js';
import type { CloudBacklogItem } from '../src/core/cloud/types.js';
import { routeSeat } from '../src/core/routing/router.js';
import { capacityFromSeat } from '../src/core/routing/headroom.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { fakeLedger, makeApplyDeps, makePolicy, useTmpHome, type FakeLedger } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
let ledger: FakeLedger;
let savedAshlrHome: string | undefined;
beforeEach(() => {
  home.setup();
  ledger = fakeLedger();
  savedAshlrHome = process.env['ASHLR_HOME'];
  process.env['ASHLR_HOME'] = `${home.home()}/.ashlr`;
});
afterEach(() => {
  if (savedAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = savedAshlrHome;
  home.teardown();
});

const T0 = Date.parse('2026-09-24T09:00:00.000Z');
const MEMO_ID = 'lm-20260924090000-abc123';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function dispatch(i: number, over: {
  repo?: string;
  title?: string;
  detail?: string;
  cls?: LeaderActionClass;
  status?: LeaderActionStatus;
  why?: string;
} = {}): LeaderAction {
  return {
    v: 1,
    id: `la-${MEMO_ID.slice(3)}-${i}`,
    memoId: MEMO_ID,
    kind: 'work.dispatch',
    class: over.cls ?? 'A',
    params: {
      task: {
        repo: over.repo ?? 'ashlrai/ashlr-hub',
        source: 'leader',
        title: over.title ?? `Fix thing ${i}`,
        detail: over.detail ?? `Detail for thing ${i}.`,
        difficulty: 'medium',
        value: 3,
        requestedBy: 'leader',
        goalId: null,
        dedupeKey: null,
      },
    },
    summary: `Dispatch: Fix thing ${i}`,
    why: over.why ?? 'It is the bottleneck.',
    createdAt: '2026-09-24T09:00:00.000Z',
    applyAfter: null,
    deferredForQuietHours: false,
    status: over.status ?? 'applied',
    statusReason: null,
    appliedAt: null,
    vetoedAt: null,
    vetoNote: null,
    inverse: null,
  };
}

function other(i: number, kind: 'lanes.grok' | 'escalate' | 'goal.create'): LeaderAction {
  const base = {
    v: 1 as const, id: `la-x-${i}`, memoId: MEMO_ID, summary: 's', why: 'w', createdAt: '2026-09-24T09:00:00.000Z',
    applyAfter: null, deferredForQuietHours: false, statusReason: null, appliedAt: null, vetoedAt: null, vetoNote: null, inverse: null,
  };
  if (kind === 'lanes.grok') return { ...base, kind, class: 'A', status: 'applied', params: { slots: 1 } };
  if (kind === 'escalate') return { ...base, kind, class: 'C', status: 'escalated', params: { request: 'Rewrite the router in ashlrai/ashlr-hub', argument: 'because' } };
  return {
    ...base, kind, class: 'B', status: 'scheduled',
    params: { goal: { objective: 'Ship it', rationale: 'r', targetRepo: 'ashlrai/ashlr-hub', deliverable: 'a PR', acceptanceEvidence: [] } },
  };
}

type MemoInput = Pick<LeaderMemo, 'id' | 'status' | 'bottleneck' | 'move' | 'actions'>;

function memo(actions: LeaderAction[], over: Partial<MemoInput> = {}): MemoInput {
  return {
    id: MEMO_ID,
    status: 'ok',
    bottleneck: { statement: 'Flaky recovery tests hide real regressions', metric: 'verify-pass-rate', evidence: ['8 known failures', '3 reverts this week'] },
    move: { statement: 'Fix the recovery fixtures first', why: 'trust', expectedDelta: null },
    actions,
    ...over,
  };
}

function recordingBacklog(result?: number | (() => number)): LeaderCloudBacklogDeps & { calls: CloudBacklogItem[][] } {
  const calls: CloudBacklogItem[][] = [];
  return {
    calls,
    append: (items) => {
      calls.push([...items]);
      if (typeof result === 'function') return result();
      return result ?? items.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

describe('leaderMemoToCloudBacklog', () => {
  it('converts a code-change action into a backlog item with the memo context', () => {
    const items = leaderMemoToCloudBacklog(memo([other(0, 'lanes.grok'), dispatch(1, { detail: 'Update the fixtures in test/universe-*.test.ts.' })]));
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({
      id: `leader-${MEMO_ID}-1`,
      title: 'Fix thing 1',
      area: LEADER_CLOUD_AREA,
      priority: 1,
      repo: 'ashlrai/ashlr-hub',
    });
    expect(item.id).toBe(leaderBacklogItemId(MEMO_ID, 1));
    expect(item.prompt).toMatch(/^Task for ashlrai\/ashlr-hub: Fix thing 1\n\nUpdate the fixtures in test\/universe-\*\.test\.ts\./);
    expect(item.prompt).toContain('Why the Leader proposed it: It is the bottleneck.');
    expect(item.prompt).toContain(`Context from the Leader's memo ${MEMO_ID}:`);
    expect(item.prompt).toContain('Bottleneck: Flaky recovery tests hide real regressions');
    expect(item.prompt).toContain('Metric: verify-pass-rate');
    expect(item.prompt).toContain('- 8 known failures\n- 3 reverts this week');
    expect(item.prompt).toContain("The Leader's move against it: Fix the recovery fixtures first");
    expect(item.prompt).toMatch(/Verify each claim against the code/);
  });

  it('takes priority from the action class (A → 1, B → 2)', () => {
    const items = leaderMemoToCloudBacklog(memo([dispatch(0, { cls: 'A' }), dispatch(1, { cls: 'B', status: 'scheduled' })]));
    expect(items.map((i) => [i.id, i.priority])).toEqual([
      [`leader-${MEMO_ID}-0`, 1],
      [`leader-${MEMO_ID}-1`, 2],
    ]);
  });

  it('keeps class-C, escalated and vetoed actions out of the backlog', () => {
    const items = leaderMemoToCloudBacklog(memo([
      dispatch(0, { cls: 'C', status: 'escalated' }),
      dispatch(1, { status: 'vetoed' }),
      other(2, 'escalate'),
      dispatch(3),
    ]));
    expect(items.map((i) => i.id)).toEqual([`leader-${MEMO_ID}-3`]);
  });

  it('converts dry-run (refused) and scheduled class-A/B dispatches — the cloud budget is the gate', () => {
    const items = leaderMemoToCloudBacklog(memo([dispatch(0, { status: 'refused' }), dispatch(1, { status: 'scheduled' }), dispatch(2, { status: 'failed' })]));
    expect(items).toHaveLength(3);
  });

  it('ignores kinds that are not a single code change and repos that are not GitHub owner/name', () => {
    const items = leaderMemoToCloudBacklog(memo([
      other(0, 'goal.create'),
      other(1, 'lanes.grok'),
      dispatch(2, { repo: 'not a repo' }),
      dispatch(3, { repo: '../../etc' }),
    ]));
    expect(items).toEqual([]);
  });

  it('dedupes within a memo by normalised title', () => {
    const items = leaderMemoToCloudBacklog(memo([
      dispatch(0, { title: 'Fix the Router' }),
      dispatch(1, { title: '  fix   the router ' }),
      dispatch(2, { title: 'Fix the router', repo: 'ashlrai/binshield' }),
      dispatch(3, { title: 'Something else' }),
    ]));
    expect(items.map((i) => i.id)).toEqual([`leader-${MEMO_ID}-0`, `leader-${MEMO_ID}-3`]);
  });

  it('returns nothing for a memo that did not complete', () => {
    for (const status of ['failed', 'parse-failed', 'no-seat', 'skipped-unchanged'] as const) {
      expect(leaderMemoToCloudBacklog(memo([dispatch(0)], { status }))).toEqual([]);
    }
  });

  it('omits the memo context when the memo names no bottleneck or move', () => {
    const [item] = leaderMemoToCloudBacklog(memo([dispatch(0)], { bottleneck: null, move: null }));
    expect(item!.prompt).not.toContain('Context from the Leader');
    expect(item!.prompt).toMatch(/^Task for ashlrai\/ashlr-hub: Fix thing 0/);
  });

  it('bounds the title and the prompt, and scrubs control characters', () => {
    const [item] = leaderMemoToCloudBacklog(memo([dispatch(0, {
      title: `Refactor ${'x'.repeat(200)}`,
      detail: `line\u0007one ${'d'.repeat(20_000)}`,
    })]));
    expect(item!.title.length).toBeLessThanOrEqual(80);
    expect(item!.title.endsWith('…')).toBe(true);
    expect(item!.prompt.length).toBeLessThanOrEqual(LEADER_CLOUD_PROMPT_MAX);
    expect(item!.prompt).not.toContain('\u0007');
  });
});

// ---------------------------------------------------------------------------
// Backlog write
// ---------------------------------------------------------------------------

describe('suggestLeaderCloudBacklog', () => {
  it('appends the converted items and reports how many were new', () => {
    const backlog = recordingBacklog(1);
    const r = suggestLeaderCloudBacklog(backlog, memo([dispatch(0), dispatch(1)]));
    expect(r).toEqual({ proposed: 2, added: 1, error: null });
    expect(backlog.calls).toHaveLength(1);
    expect(backlog.calls[0]!.map((i) => i.id)).toEqual([`leader-${MEMO_ID}-0`, `leader-${MEMO_ID}-1`]);
  });

  it('does not write at all when the memo has no code-change actions', () => {
    const backlog = recordingBacklog();
    expect(suggestLeaderCloudBacklog(backlog, memo([other(0, 'lanes.grok'), other(1, 'escalate')]))).toEqual({ proposed: 0, added: 0, error: null });
    expect(suggestLeaderCloudBacklog(backlog, memo([]))).toEqual({ proposed: 0, added: 0, error: null });
    expect(backlog.calls).toHaveLength(0);
  });

  it('turns a backlog failure into a plain sentence instead of throwing', () => {
    const backlog = recordingBacklog(() => { throw new Error('backlog.json is not writable'); });
    const r = suggestLeaderCloudBacklog(backlog, memo([dispatch(0)]));
    expect(r.proposed).toBe(1);
    expect(r.added).toBe(0);
    expect(r.error).toBe("The cloud backlog did not accept the Leader's tasks: backlog.json is not writable");
  });

  it('dedupes across memos through the backlog (the same memo twice adds nothing new)', () => {
    const seen = new Set<string>();
    const backlog: LeaderCloudBacklogDeps = {
      append: (items) => items.filter((i) => !seen.has(i.id) && (seen.add(i.id), true)).length,
    };
    const m = memo([dispatch(0), dispatch(1)]);
    expect(suggestLeaderCloudBacklog(backlog, m).added).toBe(2);
    expect(suggestLeaderCloudBacklog(backlog, m).added).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runLeader integration
// ---------------------------------------------------------------------------

function reply(actions: unknown[]): string {
  return JSON.stringify({
    bottleneck: { statement: 'Recovery tests are red', metric: 'active-goals', evidence: ['8 failing'] },
    move: { statement: 'Fix the fixtures', why: 'trust', expectedDelta: null },
    killList: [],
    questionsForMason: [],
    actions,
  });
}

const DISPATCH_GRANTED = { kind: 'work.dispatch', params: { task: { repo: 'ashlrai/binshield', title: 'Fix the flaky parser test', detail: 'See test/parser.test.ts', difficulty: 'low', value: 3 } }, summary: 'Fix parser test', why: 'red CI' };
const DISPATCH_OUTSIDE = { kind: 'work.dispatch', params: { task: { repo: 'ashlrai/other', title: 'Outside the grant', difficulty: 'low', value: 2 } }, summary: 'Outside', why: 'x' };

function world(opts: { reply: string; policy: () => EffectivePolicy | null; backlog?: LeaderCloudBacklogDeps }): LeaderRunDeps {
  const now = (): number => T0;
  const { deps: apply } = makeApplyDeps({ ledger, now, policy: opts.policy });
  const sources: LeaderEvidenceSources = {
    standingPolicy: opts.policy,
    budgetPolicy: () => defaultBudgetPolicy(),
    capacity: () => ({ publishedAt: new Date(T0).toISOString(), seats: [] }),
    goals: () => ({ goals: [], complete: true }),
    readLedger: (o) => ledger.read(o),
    holds: () => [],
    quality7d: () => ({ proposalsCreated: 0, merged: 0, rejected: 0, pending: 0, emptyRate: 0, acceptRate: 0, verifyPassRate: 0 }),
    models: () => [],
    reasoning: async () => ({ generatedAt: 'x', window: { from: 'a', to: 'b' }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] }),
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
    now,
    candidates: async () => [local],
    capacitySnapshot: () => null,
    budgetPolicy: () => defaultBudgetPolicy(),
    standingPolicy: opts.policy,
    clampBudget: (p) => p,
    route: (req, cap, pol, nowMs) => routeSeat(req, cap, pol, { nowMs }),
    capacityFromSeat: (s) => capacityFromSeat(s),
    recordDecision: () => undefined,
    transports: {
      local: () => async () => opts.reply,
      grok: () => async () => { throw new Error('grok must not be called'); },
      claude: () => async () => { throw new Error('claude must not be called'); },
    },
  };
  return { cfg: {} as AshlrConfig, now, sources, seat, apply, ...(opts.backlog ? { cloudBacklog: opts.backlog } : {}) };
}

describe('runLeader → cloud backlog', () => {
  it('suggests granted dispatches and keeps out-of-grant (class C) ones as escalations', async () => {
    const backlog = recordingBacklog();
    const r = await runLeader(world({ reply: reply([DISPATCH_GRANTED, DISPATCH_OUTSIDE]), policy: () => makePolicy(), backlog }), 'manual');
    expect(r.outcome).toBe('ok');
    expect(r.memo!.actions.map((a) => [a.kind, a.class, a.status])).toEqual([
      ['work.dispatch', 'A', 'applied'],
      ['work.dispatch', 'C', 'escalated'],
    ]);
    expect(backlog.calls).toHaveLength(1);
    expect(backlog.calls[0]).toHaveLength(1);
    expect(backlog.calls[0]![0]).toMatchObject({
      id: `leader-${r.memo!.id}-0`,
      title: 'Fix the flaky parser test',
      repo: 'ashlrai/binshield',
      priority: 1,
      area: 'leader',
    });
    expect(backlog.calls[0]![0]!.prompt).toContain('Bottleneck: Recovery tests are red');
    expect(r.memo!.statusReason).toBeNull();
  });

  it('suggests dispatches from a dry-run memo (no grant): only the cloud budget launches them', async () => {
    const backlog = recordingBacklog();
    const r = await runLeader(world({ reply: reply([DISPATCH_GRANTED]), policy: () => null, backlog }), 'manual');
    expect(r.memo!.dryRun).toBe(true);
    expect(r.memo!.actions[0]).toMatchObject({ kind: 'work.dispatch', status: 'refused' });
    expect(backlog.calls).toHaveLength(1);
    expect(backlog.calls[0]!.map((i) => i.repo)).toEqual(['ashlrai/binshield']);
  });

  it('does not touch the backlog when the memo has no code-change actions', async () => {
    const backlog = recordingBacklog();
    const r = await runLeader(world({ reply: reply([{ kind: 'lanes.grok', params: { slots: 1 }, summary: 'Fewer', why: 'cost' }]), policy: () => makePolicy(), backlog }), 'manual');
    expect(r.outcome).toBe('ok');
    expect(backlog.calls).toHaveLength(0);
  });

  it('keeps the memo when the backlog write fails, and says why', async () => {
    const backlog = recordingBacklog(() => { throw new Error('cloud lane: appendUserBacklogItems is not implemented yet'); });
    const r = await runLeader(world({ reply: reply([DISPATCH_GRANTED]), policy: () => makePolicy(), backlog }), 'manual');
    expect(r.outcome).toBe('ok');
    expect(r.memo!.status).toBe('ok');
    expect(r.memo!.actions).toHaveLength(1);
    expect(r.memo!.statusReason).toMatch(/The cloud backlog did not accept the Leader's tasks: cloud lane: appendUserBacklogItems is not implemented yet/);
  });

  it('runs exactly as before when no cloud backlog is wired', async () => {
    const r = await runLeader(world({ reply: reply([DISPATCH_GRANTED]), policy: () => makePolicy() }), 'manual');
    expect(r.outcome).toBe('ok');
    expect(r.memo!.statusReason).toBeNull();
  });
});
