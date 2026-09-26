/**
 * routes/verse/command/fixtures.test-support.ts — hand-built payloads for the
 * four 3.10 surfaces, typed by the REAL Track A/B contracts so a contract
 * change fails the typecheck here instead of degrading silently in the
 * browser (unit C7). Three shapes, per SPEC-310C §7 "Dark, sparse and live
 * fixtures":
 *
 *   live   — a working fleet: grant active, runs in flight, a memo with a
 *            class-B action inside its veto window, experiments, insights.
 *   sparse — the honest early state: a few days of data, many unknowns.
 *   dark   — no grant, nothing since Sep 1 ("Fleet dark since Sep 1").
 *
 * Pure data (no vitest import) so the scratch screenshot harness can load
 * it too. Times are relative to `now` so a fixture never goes stale.
 */
import type {
  AuthorityGrantDraft,
  AuthorityStatusV1,
  RolloutStage,
  StandingGrantV1,
} from '../../../../core/authority/types.js';
import type {
  FleetLiveRun,
  FleetLiveSnapshotV1,
  FleetRepoRow,
} from '../../../../core/fleet/fleet-types.js';
import type { LeaderAction, LeaderMemo, LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import type { ExperimentResultV1, HarnessConfigV1, HarnessVersion, LearningStateV1 } from '../../../../core/learn/harness-types.js';
import type { NeedsYouItem, VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import type { FleetHistoryDay, FleetHistoryResponse, FleetHistorySource } from '../../../../core/verse/fleet-history-types.js';
import type { ReasoningDigest } from '../../../../core/reasoning/types.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { CapacityHistoryResponse, CapacityHistorySeries } from '../../../../core/routing/capacity-history-types.js';
import type { SeatDecision } from '../../../../core/routing/types.js';

export type FixtureKind = 'live' | 'sparse' | 'dark';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const hex = (seed: string, len: number) => Array.from({ length: len }, (_, i) => '0123456789abcdef'[(seed.charCodeAt(i % seed.length) + i * 7) % 16]).join('');

export const DARK_SINCE = '2026-09-01T19:10:00.000Z';

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

function stage(id: string, repos: RolloutStage['repos'], over: Partial<RolloutStage> = {}): RolloutStage {
  return {
    id,
    repos,
    engines: ['local', 'grok-cli', 'claude-cli'],
    maxRisk: 'low',
    maxFiles: 4,
    maxLines: 150,
    maxMergesPerRepoPerDay: 6,
    leaderClasses: ['A'],
    criteria: { minMerges: 3, minPostMergeGreenPct: 95, maxRevertRatePct: 10, minHours: 8, maxSandboxViolations: 0, reserveBreaches: 0 },
    ...over,
  };
}

export function grantPayload(now = Date.now()): StandingGrantV1 {
  return {
    v: 1,
    grantId: hex('grant', 32),
    grantSeq: 3,
    keyId: 'mason-se-p256',
    issuedAt: iso(now - 7 * DAY),
    expiresAt: iso(now + 23 * DAY),
    hostBinding: hex('host', 64),
    authoritySurfaceDigest: hex('surface', 64),
    repos: [
      { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 },
      { nameWithOwner: 'ashlrai/binshield', stage: 'merge', enforcement: 'server', maxRisk: 'medium', maxMergesPerDay: 12 },
      { nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge', enforcement: 'server', maxRisk: 'low', maxMergesPerDay: 24 },
      { nameWithOwner: 'ashlrai/measurably', stage: 'merge', enforcement: 'local', maxRisk: 'low', maxMergesPerDay: 4 },
    ],
    merge: { maxFiles: 10, maxLines: 300, selfRepo: 'propose-only' },
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        'claude-a': { enabled: true, reserveFloorPercent: 40, maxSessionWindowPercent: 70, roles: ['judge', 'leader'] },
        'grok-a': { enabled: true, reserveFloorPercent: 0, roles: ['producer', 'judge', 'leader'] },
        'local-qwen': { enabled: true, reserveFloorPercent: 0, roles: ['producer'] },
        'codex-a': { enabled: true, reserveFloorPercent: 20, roles: ['producer'] },
      },
    },
    engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
    leader: { classes: ['A', 'B'], vetoMinutes: 30 },
    conductorGoals: true,
    rollout: {
      autoAdvance: true,
      stages: [
        stage('shadow', [{ nameWithOwner: 'ashlrai/fleet-canary', stage: 'merge' }, { nameWithOwner: 'ashlrai/ashlrcode', stage: 'propose' }], { leaderClasses: [], criteria: { minMerges: 5, minPostMergeGreenPct: 0, maxRevertRatePct: 100, minHours: 12, maxSandboxViolations: 0, reserveBreaches: 0 } }),
        stage('2a', [{ nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge' }]),
        stage('2b', [{ nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge' }, { nameWithOwner: 'ashlrai/binshield', stage: 'merge' }], { criteria: { minMerges: 8, minPostMergeGreenPct: 95, maxRevertRatePct: 10, minHours: 24, maxSandboxViolations: 0, reserveBreaches: 0 } }),
        stage('full', [
          { nameWithOwner: 'ashlrai/ashlrcode', stage: 'merge' },
          { nameWithOwner: 'ashlrai/binshield', stage: 'merge' },
          { nameWithOwner: 'ashlrai/measurably', stage: 'merge' },
        ], { maxRisk: 'medium', maxFiles: 10, maxLines: 300, leaderClasses: ['A', 'B'], criteria: { minMerges: 25, minPostMergeGreenPct: 95, maxRevertRatePct: 5, minHours: 48, maxSandboxViolations: 0, reserveBreaches: 0 } }),
      ],
    },
  };
}

export function grantDraft(now = Date.now()): AuthorityGrantDraft {
  const payload = grantPayload(now);
  return { payload: { ...payload, issuedAt: iso(now), expiresAt: iso(now + 30 * DAY), grantSeq: 4 }, digest: hex('draft', 64) };
}

export function authorityStatus(kind: FixtureKind = 'live', now = Date.now(), over: Partial<AuthorityStatusV1> = {}): AuthorityStatusV1 {
  const g = grantPayload(now);
  const custody = { installed: true, keyInitialized: true, githubApp: true, claudeToken: true };
  if (kind === 'dark') {
    return {
      v: 1,
      checkedAt: iso(now),
      switch: 'off',
      effectiveSwitch: 'off',
      maxSwitchWithoutGrant: 'propose',
      kill: false,
      grant: { state: 'none', reason: null, grantId: null, grantSeq: null, keyId: null, issuedAt: null, expiresAt: null, repos: [], engines: [], maxMode: null, stageIds: [] },
      rollout: null,
      policy: null,
      ledger: { state: 'empty', head: null, reason: null },
      custody: { installed: null, keyInitialized: null, githubApp: null, claudeToken: null },
      ...over,
    };
  }
  const sparse = kind === 'sparse';
  return {
    v: 1,
    checkedAt: iso(now),
    switch: sparse ? 'propose' : 'autonomous',
    effectiveSwitch: sparse ? 'propose' : 'autonomous',
    maxSwitchWithoutGrant: sparse ? 'propose' : 'autonomous',
    kill: false,
    grant: {
      state: 'active',
      reason: null,
      grantId: g.grantId,
      grantSeq: g.grantSeq,
      keyId: g.keyId,
      issuedAt: g.issuedAt,
      expiresAt: g.expiresAt,
      repos: g.repos,
      engines: g.engines,
      maxMode: g.spend.maxMode,
      stageIds: g.rollout.stages.map((s) => s.id),
    },
    rollout: {
      stageId: sparse ? 'shadow' : '2b',
      stageIndex: sparse ? 0 : 2,
      stageCount: 4,
      enteredAt: iso(now - (sparse ? 6 : 30) * HOUR),
      hoursInStage: sparse ? 6 : 30,
      merges: sparse ? 2 : 6,
      postMergeGreenPct: sparse ? null : 100,
      revertRatePct: sparse ? null : 0,
      sandboxViolations: 0,
      reserveBreaches: 0,
      criteria: g.rollout.stages[sparse ? 0 : 2]!.criteria,
      nextStageId: sparse ? '2a' : 'full',
      met: false,
      unmet: sparse ? ['2 of 5 would-merge digests', '6 h of 12 h'] : ['6 of 8 merges'],
    },
    policy: null,
    ledger: { state: 'ok', head: { seq: 412, hash: hex('head', 64), at: iso(now - 2 * MIN) }, reason: null },
    custody,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fleet live
// ---------------------------------------------------------------------------

function run(id: string, over: Partial<FleetLiveRun>, now: number): FleetLiveRun {
  return {
    id,
    taskId: `t-${id}`,
    repo: 'ashlrai/ashlrcode',
    title: 'Add tests for the tokenizer edge cases',
    lane: 'local',
    seatId: 'local-qwen',
    engine: 'local-coder',
    model: 'qwen3.8:27b',
    phase: 'producing',
    startedAt: iso(now - 40 * MIN),
    phaseStartedAt: iso(now - 12 * MIN),
    endedAt: null,
    outcome: null,
    prNumber: null,
    hold: null,
    seatDecision: null,
    ...over,
  };
}

const decision: SeatDecision = {
  seatId: 'grok-a',
  candidates: ['grok-a', 'local-qwen'],
  exclusions: [
    { seatId: 'claude-a', reasons: ['5-hour window at 74% — above autonomy’s 70% stop line'], nextEligibleAt: null },
    { seatId: 'codex-a', reasons: ['weekly window exhausted; resets Thu 09:00'], nextEligibleAt: '2026-09-26T09:00:00.000Z' },
  ],
  why: 'grok-a has the most headroom for medium code work (0% reserve, 31% used this week); local-qwen is the fallback.',
  mode: 'balanced',
};

function repoRow(repo: string, over: Partial<FleetRepoRow>): FleetRepoRow {
  return {
    repo,
    stage: 'merge',
    enforcement: 'server',
    lastMergeAt: null,
    mergesToday: 0,
    maxMergesPerDay: 6,
    greenPct7d: null,
    greenTrend: Array.from({ length: 14 }, () => null),
    openFleetPrs: 0,
    holds: [],
    ...over,
  };
}

export function fleetLive(kind: FixtureKind = 'live', now = Date.now()): FleetLiveSnapshotV1 {
  if (kind === 'dark') {
    return {
      v: 1,
      generatedAt: iso(now),
      state: 'dark',
      stateReason: 'No standing grant is installed, so the daemon runs nothing autonomous.',
      lastActivityAt: DARK_SINCE,
      summary: { building: 0, queued: 0, parked: 0, waitingVerify: 0, mergedToday: 0, revertsToday: 0, merged7d: 0, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null },
      lanes: [
        { lane: 'local', slots: 0, busy: 0, capReason: 'no grant' },
        { lane: 'grok-cli', slots: 0, busy: 0, capReason: 'no grant' },
        { lane: 'claude-cli', slots: 0, busy: 0, capReason: 'no grant' },
        { lane: 'codex', slots: 0, busy: 0, capReason: 'off until its window resets' },
      ],
      runs: [],
      funnel: null,
      repos: [repoRow('ashlrai/ashlrcode', { stage: null, enforcement: null, mergesToday: null, maxMergesPerDay: null, openFleetPrs: null })],
    };
  }
  const sparse = kind === 'sparse';
  const runs: FleetLiveRun[] = sparse
    ? [
        run('r1', { phase: 'verifying', lane: 'local', startedAt: iso(now - 50 * MIN), phaseStartedAt: iso(now - 5 * MIN) }, now),
        run('r2', { phase: 'watching', outcome: 'proposed', lane: 'grok-cli', seatId: 'grok-a', engine: 'grok-cli', model: 'grok-4.7', repo: 'ashlrai/fleet-canary', title: 'Bump the canary fixture', startedAt: iso(now - 5 * HOUR), endedAt: iso(now - 4 * HOUR), prNumber: 12, seatDecision: decision }, now),
      ]
    : [
        run('r1', { phase: 'producing', lane: 'local', startedAt: iso(now - 32 * MIN), phaseStartedAt: iso(now - 32 * MIN) }, now),
        run('r2', { phase: 'verifying', lane: 'local', repo: 'ashlrai/binshield', title: 'Tighten the ELF section parser', startedAt: iso(now - 70 * MIN), phaseStartedAt: iso(now - 9 * MIN) }, now),
        run('r3', { phase: 'judging', lane: 'grok-cli', seatId: 'grok-a', engine: 'grok-cli', model: 'grok-4.7', title: 'Split the router into modules', startedAt: iso(now - 95 * MIN), phaseStartedAt: iso(now - 4 * MIN), seatDecision: decision }, now),
        run('r4', { phase: 'producing', lane: 'grok-cli', seatId: 'grok-a', engine: 'grok-cli', model: 'grok-4.7', repo: 'ashlrai/binshield', title: 'Fuzz the header decoder', startedAt: iso(now - 20 * MIN), phaseStartedAt: iso(now - 20 * MIN), seatDecision: decision }, now),
        run('r5', { phase: 'landing', lane: 'grok-cli', seatId: 'grok-a', engine: 'grok-cli', model: 'grok-4.7', repo: 'ashlrai/ashlrcode', title: 'Cache the grammar table', startedAt: iso(now - 3 * HOUR), phaseStartedAt: iso(now - 2 * MIN), prNumber: 88, seatDecision: decision }, now),
        run('r6', { phase: 'watching', outcome: 'merged', lane: 'local', startedAt: iso(now - 6 * HOUR), endedAt: iso(now - 4.5 * HOUR), prNumber: 84, title: 'Remove the dead flag parser' }, now),
        run('r7', { phase: 'watching', outcome: 'merged', lane: 'grok-cli', seatId: 'grok-a', engine: 'grok-cli', model: 'grok-4.7', repo: 'ashlrai/binshield', startedAt: iso(now - 9 * HOUR), endedAt: iso(now - 8 * HOUR), prNumber: 51, title: 'Docs for the CLI flags' }, now),
        run('r8', { phase: 'reverting', outcome: 'reverted', lane: 'local', repo: 'ashlrai/measurably', startedAt: iso(now - 11 * HOUR), endedAt: iso(now - 10 * HOUR), prNumber: 19, title: 'Inline the score cache' }, now),
        run('r9', { phase: 'watching', outcome: 'refused', lane: 'local', startedAt: iso(now - 7 * HOUR), endedAt: iso(now - 6.8 * HOUR), title: 'Rename internal helpers' }, now),
        run('r10', { phase: 'queued', lane: 'grok-cli', startedAt: null, phaseStartedAt: iso(now - 15 * MIN), title: 'Add a --json flag to status' }, now),
        run('r11', {
          phase: 'parked',
          lane: 'claude-cli',
          seatId: null,
          engine: null,
          model: null,
          startedAt: null,
          phaseStartedAt: iso(now - 2 * HOUR),
          title: 'Judge: Split the router into modules',
          hold: { kind: 'park', reason: 'claude-a 5-hour window at 74% — above autonomy’s 70% stop line', nextEligibleAt: iso(now + 95 * MIN) },
        }, now),
        run('r12', {
          phase: 'parked',
          lane: 'codex',
          seatId: null,
          engine: null,
          model: null,
          startedAt: null,
          phaseStartedAt: iso(now - 5 * HOUR),
          title: 'Port the lexer to the new API',
          hold: { kind: 'park', reason: 'codex-a weekly window exhausted; resets Thu 09:00', nextEligibleAt: iso(now + 42 * HOUR) },
        }, now),
      ];
  const trend = (base: number) => Array.from({ length: 14 }, (_, i) => (sparse && i < 10 ? null : Math.min(100, base + ((i * 7) % 5))));
  return {
    v: 1,
    generatedAt: iso(now),
    state: 'running',
    stateReason: null,
    lastActivityAt: iso(now - 2 * MIN),
    summary: sparse
      ? { building: 1, queued: 0, parked: 0, waitingVerify: 1, mergedToday: 0, revertsToday: 0, merged7d: 2, postMergeGreenPct7d: null, cycleTimeP50Ms7d: null }
      : { building: 5, queued: 1, parked: 2, waitingVerify: 1, mergedToday: 7, revertsToday: 1, merged7d: 23, postMergeGreenPct7d: 96, cycleTimeP50Ms7d: 2 * HOUR + 14 * MIN },
    lanes: [
      { lane: 'local', slots: sparse ? 4 : 2, busy: sparse ? 1 : 2, capReason: sparse ? null : 'you are present (live chat) — 2 of 4 slots' },
      { lane: 'grok-cli', slots: 2, busy: sparse ? 0 : 2, capReason: null },
      { lane: 'claude-cli', slots: 1, busy: 0, capReason: 'judge only; 5-hour window above 70%' },
      { lane: 'codex', slots: 0, busy: 0, capReason: 'off until its window resets Thu 09:00' },
    ],
    runs,
    funnel: sparse
      ? null
      : {
          from: iso(now - 7 * DAY),
          to: iso(now),
          stages: [
            { gate: 'G0', entered: 64, passed: 61, refusals: [{ code: 'daily-cap', reason: 'Repo hit its daily merge cap', count: 3 }] },
            { gate: 'G1', entered: 61, passed: 55, refusals: [{ code: 'protected-path', reason: 'Touched a protected path (owner lane)', count: 6 }] },
            { gate: 'G1b', entered: 55, passed: 53, refusals: [{ code: 'tamper', reason: 'Removed or skipped tests', count: 2 }] },
            { gate: 'G2', entered: 53, passed: 45, refusals: [{ code: 'risk-over-cap', reason: 'Risk above the repo cap', count: 5 }, { code: 'size-over-cap', reason: 'More files or lines than the cap', count: 3 }] },
            { gate: 'G3', entered: 45, passed: 36, refusals: [{ code: 'tests-failed', reason: 'Tests failed on the base head', count: 7 }, { code: 'typecheck', reason: 'Typecheck failed', count: 2 }] },
            { gate: 'G4', entered: 36, passed: 33, refusals: [{ code: 'claim-mismatch', reason: 'Claimed a change the diff does not make', count: 3 }] },
            { gate: 'G5', entered: 33, passed: 33, refusals: [] },
            { gate: 'G6', entered: 33, passed: 26, refusals: [{ code: 'judge-reject', reason: 'Judge said not worth shipping', count: 5 }, { code: 'no-judge-seat', reason: 'No different-family judge had headroom', count: 2 }] },
            { gate: 'G7', entered: 26, passed: 23, refusals: [{ code: 'checks-red', reason: 'Required checks red on the head SHA', count: 3 }] },
          ],
        },
    repos: [
      repoRow('ashlrai/ashlrcode', { lastMergeAt: iso(now - 4.5 * HOUR), mergesToday: sparse ? 0 : 4, greenPct7d: sparse ? null : 100, greenTrend: trend(96), openFleetPrs: 2 }),
      repoRow('ashlrai/binshield', { lastMergeAt: iso(now - 8 * HOUR), mergesToday: sparse ? 0 : 3, greenPct7d: sparse ? null : 94, greenTrend: trend(90), openFleetPrs: 1 }),
      repoRow('ashlrai/measurably', {
        enforcement: 'local',
        maxMergesPerDay: 4,
        lastMergeAt: iso(now - 11 * HOUR),
        mergesToday: 0,
        greenPct7d: sparse ? null : 80,
        greenTrend: trend(78),
        holds: sparse ? [] : [{ v: 1, repo: 'ashlrai/measurably', kind: 'quarantine', reason: 'Post-merge suite failed on 3f2a9c1; reverted', since: iso(now - 10 * HOUR), until: iso(now + 20 * MIN), setBy: 'post-merge-watch', landingId: 'ashlrai/measurably#19@3f2a9c1e0000' }],
      }),
      repoRow('ashlrai/fleet-canary', { stage: sparse ? 'merge' : 'propose', maxMergesPerDay: 24, lastMergeAt: sparse ? iso(now - 4 * HOUR) : null, mergesToday: sparse ? 1 : 0, openFleetPrs: 0 }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Leader
// ---------------------------------------------------------------------------

function action<K extends LeaderAction['kind']>(a: Extract<LeaderAction, { kind: K }>): LeaderAction {
  return a as LeaderAction;
}

export function leaderState(kind: FixtureKind = 'live', now = Date.now()): LeaderStateV1 {
  if (kind === 'dark') {
    return {
      v: 1,
      generatedAt: iso(now),
      lastRun: { at: iso(now - 3 * DAY), outcome: 'no-seat', reason: 'No eligible seat for the Leader: grok-a signed out, local Qwen offline.' },
      nextRunAt: null,
      runsToday: 0,
      latest: null,
      timeline: [],
      actions: [],
      hitRate: { windowDays: 30, graded: 0, hits: 0, rate: null },
      standards: [],
      directives: null,
    };
  }
  const memoId = 'memo-0924';
  const actions: LeaderAction[] = [
    action<'goal.archive'>({
      v: 1, id: 'a1', memoId, kind: 'goal.archive', class: 'A', params: { goalId: 'g-router-cleanup' },
      summary: 'Archive goal ‘Router cleanup’ (no merges in 21 days)', why: 'It has produced no merge in 21 days and blocks two lanes.',
      createdAt: iso(now - 50 * MIN), applyAfter: iso(now - 50 * MIN), deferredForQuietHours: false, status: 'applied', statusReason: null,
      appliedAt: iso(now - 50 * MIN), vetoedAt: null, vetoNote: null, inverse: { op: 'restore-goals', before: [{ goalId: 'g-router-cleanup', record: '{}' }] },
    }),
    action<'lanes.grok'>({
      v: 1, id: 'a2', memoId, kind: 'lanes.grok', class: 'B', params: { slots: 3 },
      summary: 'Raise Grok to 3 lanes', why: 'The judge queue is the bottleneck and grok-a has 69% weekly headroom.',
      createdAt: iso(now - 12 * MIN), applyAfter: iso(now + 18 * MIN), deferredForQuietHours: false, status: 'scheduled', statusReason: null,
      appliedAt: null, vetoedAt: null, vetoNote: null, inverse: null,
    }),
    action<'work.dispatch'>({
      v: 1, id: 'a3', memoId, kind: 'work.dispatch', class: 'A',
      params: { task: { repo: 'ashlrai/binshield', source: 'leader', title: 'Add tests for the section parser', detail: '', difficulty: 'low', value: 4, requestedBy: 'leader' } },
      summary: 'Dispatch: add tests for the binshield section parser', why: 'A7 found edits without tests in this module three times this week.',
      createdAt: iso(now - 50 * MIN), applyAfter: iso(now - 50 * MIN), deferredForQuietHours: false, status: 'applied', statusReason: null,
      appliedAt: iso(now - 49 * MIN), vetoedAt: null, vetoNote: null, inverse: { op: 'cancel-task', taskId: 't-99' },
    }),
    action<'escalate'>({
      v: 1, id: 'a4', memoId, kind: 'escalate', class: 'C', params: { request: 'Enable merges on ashlr-hub (non-authority paths)', argument: 'Six clean proposals this week were withheld only by propose-only.' },
      summary: 'Asks: enable merges on ashlr-hub (non-authority paths)', why: 'Six clean proposals this week were withheld only by propose-only.',
      createdAt: iso(now - 50 * MIN), applyAfter: null, deferredForQuietHours: false, status: 'escalated', statusReason: 'Outside the grant — needs you.',
      appliedAt: null, vetoedAt: null, vetoNote: null, inverse: null,
    }),
  ];
  const latest: LeaderMemo = {
    v: 1,
    id: memoId,
    at: iso(now - 50 * MIN),
    status: 'ok',
    statusReason: null,
    trigger: 'schedule',
    dryRun: kind === 'sparse',
    seatId: 'grok-a',
    model: 'grok-4.7',
    evidenceDigest: hex('evidence', 64),
    bottleneck: { statement: 'Judge queue on grok-a: 9 proposals waited more than 2 h for a verdict.', metric: 'judge-wait-p50', evidence: ['G6 wait p50 2h 40m'] },
    move: { statement: 'Raise Grok to 3 lanes and archive the stalled router goal.', why: 'Frees a judge slot without touching your Claude reserve.', expectedDelta: { metric: 'merges/day', delta: 4, byDate: iso(now + 3 * DAY) } },
    killList: [{ target: { kind: 'goal', id: 'g-router-cleanup' }, why: 'No merges in 21 days' }],
    goals: [],
    priorityChanges: [],
    standards: [],
    critiques: [],
    seatPlan: [],
    hypotheses: [],
    questionsForMason: ['Should measurably stay at local enforcement, or move to propose-only until it has CI?'],
    actions,
  };
  const graded = kind === 'sparse' ? 1 : 9;
  const hits = kind === 'sparse' ? 1 : 6;
  return {
    v: 1,
    generatedAt: iso(now),
    lastRun: { at: latest.at, outcome: 'ok', reason: null },
    nextRunAt: iso(now + 15 * HOUR),
    runsToday: 1,
    latest,
    timeline: [
      { id: memoId, at: latest.at, status: 'ok', bottleneck: latest.bottleneck!.statement, move: latest.move!.statement, expectedDelta: latest.move!.expectedDelta, outcome: null, actionCount: actions.length },
      ...(kind === 'sparse'
        ? [{ id: 'memo-0916', at: iso(now - 8 * DAY), status: 'ok' as const, bottleneck: 'Too many active goals (21).', move: 'Prune to 4 goals.', expectedDelta: { metric: 'merges/day', delta: 2, byDate: iso(now - DAY) }, outcome: { memoId: 'memo-0916', metric: 'merges/day', expectedDelta: 2, actualDelta: 2.5, byDate: iso(now - DAY), hit: true, gradedAt: iso(now - DAY) }, actionCount: 5 }]
        : Array.from({ length: 6 }, (_, i) => {
            const at = now - (i + 1) * 2 * DAY;
            const hit = i % 3 !== 1;
            return {
              id: `memo-${i}`,
              at: iso(at),
              status: (i === 4 ? 'skipped-unchanged' : 'ok') as LeaderMemo['status'],
              bottleneck: ['Verify queue on local slots.', 'Codex exhausted; lanes idle.', 'Flaky binshield CI.', 'Judge refusals on medium risk.', 'Evidence unchanged.', 'Too many active goals (21).'][i]!,
              move: ['Cap verify to 1 per repo.', 'Shift producers to Grok until Thursday.', 'Quarantine the flaky suite.', 'Tighten medium-risk slicing.', 'No move (evidence unchanged).', 'Prune to 4 goals.'][i]!,
              expectedDelta: i === 4 ? null : { metric: 'merges/day', delta: [2, 3, 1, 2, 0, 3][i]!, byDate: iso(at + 7 * DAY) },
              outcome: i === 0 || i === 4 ? null : { memoId: `memo-${i}`, metric: 'merges/day', expectedDelta: [2, 3, 1, 2, 0, 3][i]!, actualDelta: hit ? [2, 3, 1.5, 2.4, 0, 3.2][i]! : 0.5, byDate: iso(at + 7 * DAY), hit, gradedAt: iso(at + 7 * DAY) },
              actionCount: [3, 4, 2, 3, 0, 6][i]!,
            };
          })),
    ],
    actions,
    hitRate: { windowDays: 30, graded, hits, rate: hits / graded },
    standards: [
      { id: 's1', rule: 'Every producer change that edits a parser adds a test in the same PR.', appliesTo: 'producer', evidence: 'A7: 3 verification gaps in binshield', source: 'leader', addedAt: iso(now - 6 * DAY), retiredAt: null },
      { id: 's2', rule: 'Judges refuse diffs that remove assertions without replacing them.', appliesTo: 'judge', evidence: null, source: 'mason', addedAt: iso(now - 20 * DAY), retiredAt: null },
    ],
    directives: { v: 1, updatedAt: iso(now - 50 * MIN), routerTuning: null, grokLanes: 2, codexEnabled: null },
  };
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

const baseConfig: HarnessConfigV1 = {
  v: 1,
  prompts: {},
  effort: {},
  sampling: {},
  routing: { lambdaCost: 1, lambdaPressure: 1, lambdaLatency: 0.5, bonThreshold: 'high' },
  skills: [],
};

function version(id: string, seq: number, over: Partial<HarnessVersion>): HarnessVersion {
  return {
    v: 1, id, seq, parentId: seq === 0 ? null : `h-${String(seq - 1).padStart(4, '0')}`, createdAt: iso(0), status: 'adopted',
    config: baseConfig, configDigest: hex(id, 64), source: { kind: seq === 0 ? 'baseline' : 'hypothesis', hypothesisId: null },
    experimentId: null, adoptedAt: null, canaryUntil: null, rolledBackAt: null, rollbackReason: null, ...over,
  };
}

function experiment(id: string, over: Partial<ExperimentResultV1>): ExperimentResultV1 {
  return {
    v: 1, id, hypothesisId: null, baseVersionId: 'h-0000', candidateVersionId: 'h-0001', taskSet: { id: 'heldout-v1', digest: hex('tasks', 64) },
    status: 'done', pairs: 12, wins: 7, losses: 2, ties: 3, lift: { mean: 4.2, ciLow: 1.1, ciHigh: 7.3, level: 0.95 },
    refuseRegression: false, claimedChangeNoneMadeDelta: 0, costDeltaPct: 6, verdict: 'adopt', reasons: ['CI low above 0'],
    startedAt: iso(0), finishedAt: iso(0), ...over,
  };
}

export function learningState(kind: FixtureKind = 'live', now = Date.now()): LearningStateV1 {
  if (kind === 'dark') return { v: 1, generatedAt: iso(now), active: null, canary: null, versions: [], experiments: [], hypotheses: [] };
  const t = (d: number) => iso(now - d * DAY);
  const experiments: ExperimentResultV1[] = kind === 'sparse'
    ? [experiment('e1', { status: 'running', pairs: 3, wins: 2, losses: 1, ties: 0, lift: null, verdict: null, finishedAt: null, startedAt: t(1) })]
    : [
        experiment('e4', { baseVersionId: 'h-0001', candidateVersionId: 'h-0004', status: 'running', pairs: 5, wins: 3, losses: 1, ties: 1, lift: null, verdict: null, finishedAt: null, startedAt: t(1) }),
        experiment('e3', { baseVersionId: 'h-0001', candidateVersionId: 'h-0003', lift: { mean: 0.8, ciLow: -1.2, ciHigh: 2.8, level: 0.95 }, verdict: 'inconclusive', startedAt: t(9), finishedAt: t(8) }),
        experiment('e2', { baseVersionId: 'h-0001', candidateVersionId: 'h-0002', lift: { mean: -3, ciLow: -5.5, ciHigh: -0.5, level: 0.95 }, verdict: 'reject', startedAt: t(14), finishedAt: t(13) }),
        experiment('e1', { candidateVersionId: 'h-0001', startedAt: t(20), finishedAt: t(19) }),
      ];
  const versions: HarnessVersion[] = kind === 'sparse'
    ? [version('h-0000', 0, { status: 'baseline', createdAt: t(30) })]
    : [
        version('h-0000', 0, { status: 'baseline', createdAt: t(30) }),
        version('h-0001', 1, { status: 'adopted', createdAt: t(20), experimentId: 'e1', adoptedAt: t(18) }),
        version('h-0002', 2, { status: 'rolled-back', createdAt: t(14), experimentId: 'e2', adoptedAt: t(12), rolledBackAt: t(10), rollbackReason: 'Canary fell below baseline − 1 SE' }),
        version('h-0003', 3, { status: 'rejected', createdAt: t(9), experimentId: 'e3' }),
        version('h-0004', 4, { status: 'candidate', createdAt: t(1) }),
      ];
  return {
    v: 1,
    generatedAt: iso(now),
    active: kind === 'sparse' ? null : versions[1]!,
    canary: null,
    versions,
    experiments,
    hypotheses: [],
  };
}

// ---------------------------------------------------------------------------
// Activity (Needs you)
// ---------------------------------------------------------------------------

export function needsYouItems(now = Date.now()): NeedsYouItem[] {
  return [
    {
      id: 'fleet:owner-lane-pr:ashlrai/ashlrcode#81',
      source: 'fleet',
      kind: 'owner-lane-pr',
      severity: 'warn',
      title: 'PR #81 touches a protected path — owner lane',
      detail: 'Edits .github/workflows/ci.yml; never auto-merged.',
      since: iso(now - 3 * HOUR),
      expiresAt: null,
      subject: { repo: 'ashlrai/ashlrcode', pr: 81, seatId: null, sessionId: null, engine: null },
      target: { kind: 'url', url: 'https://github.com/ashlrai/ashlrcode/pull/81' },
      actions: [],
    },
    {
      id: 'leader:veto-window:a2',
      source: 'leader',
      kind: 'veto-window',
      severity: 'info',
      title: 'Leader will raise Grok to 3 lanes in 18m',
      detail: 'The judge queue is the bottleneck and grok-a has 69% weekly headroom.',
      since: iso(now - 12 * MIN),
      expiresAt: iso(now + 18 * MIN),
      subject: { repo: null, pr: null, seatId: 'grok-a', sessionId: null, engine: 'grok' },
      target: { kind: 'section', section: 'mind', anchor: 'action-a2' },
      actions: [{ kind: 'veto', label: 'Veto', request: { method: 'POST', path: '/api/verse/leader', body: { action: 'veto', actionId: 'a2' } }, confirm: null, destructive: true }],
    },
    {
      id: 'fleet:quarantine:ashlrai/measurably',
      source: 'fleet',
      kind: 'quarantine',
      severity: 'high',
      title: 'measurably quarantined — post-merge suite failed, reverted',
      detail: 'Lifts in 20m; a repair task is queued.',
      since: iso(now - 10 * HOUR),
      expiresAt: iso(now + 20 * MIN),
      subject: { repo: 'ashlrai/measurably', pr: 19, seatId: null, sessionId: null, engine: null },
      target: { kind: 'section', section: 'fleet', anchor: 'repo-ashlrai/measurably' },
      actions: [{ kind: 'resume', label: 'Resume repo', request: { method: 'POST', path: '/api/verse/fleet/live', body: { action: 'resume-repo', repo: 'ashlrai/measurably', kind: 'quarantine' } }, confirm: { title: 'Resume measurably now?', body: 'The quarantine lifts early; the repair task stays queued.', confirmLabel: 'Resume' }, destructive: false }],
    },
    {
      id: 'accounts:reconnect:codex-b',
      source: 'accounts',
      kind: 'reconnect',
      severity: 'warn',
      title: 'codex-b signed out — reconnect',
      detail: null,
      since: iso(now - DAY),
      expiresAt: null,
      subject: { repo: null, pr: null, seatId: 'codex-b', sessionId: null, engine: 'codex' },
      target: { kind: 'seat', seatId: 'codex-b' },
      actions: [],
    },
  ];
}

export function activitySnapshot(kind: FixtureKind = 'live', now = Date.now()): VerseActivityResponse {
  const items = kind === 'live' ? needsYouItems(now) : [];
  return {
    cursor: 'boot-1:0',
    generatedAt: iso(now),
    running: kind === 'live' ? [{ sessionId: 's1', title: 'Refactor the ledger reader', engine: 'claude', seatId: 'claude-a', startedAt: iso(now - 4 * MIN), live: { phase: 'tool', tool: 'npm test', elapsedMs: 62_000, thinkingTail: null } }] : [],
    needsYou: items,
    completions: [],
    counts: { running: kind === 'live' ? 1 : 0, needsYou: items.length, unread: 0 },
    sources: { approvals: 'ok', authority: 'ok', fleet: 'ok', leader: 'ok', chats: 'ok', accounts: 'ok' },
    autonomy: null,
    capacity: null,
    mind: null,
  };
}

// ---------------------------------------------------------------------------
// Fleet history (A8)
// ---------------------------------------------------------------------------

const healthy = (n: number): FleetHistorySource => ({ state: 'healthy', complete: true, reasons: [], recordsRead: n, recordsSkipped: 0, lastRecordAt: null });

export function fleetHistory(kind: FixtureKind = 'live', now = Date.now()): FleetHistoryResponse {
  const days = 90;
  const start = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate()) - (days - 1) * DAY;
  const rows: FleetHistoryDay[] = Array.from({ length: days }, (_, i) => {
    const ms = start + i * DAY;
    const recent = i >= days - (kind === 'sparse' ? 6 : 40);
    const active = kind !== 'dark' || ms < Date.parse(DARK_SINCE);
    const merges = !active ? 0 : recent ? (kind === 'sparse' ? i % 2 : 1 + ((i * 5) % 7)) : kind === 'sparse' ? 0 : (i * 3) % 3;
    const unknownDay = kind === 'sparse' && i === days - 3;
    return {
      day: new Date(ms).toISOString().slice(0, 10),
      runs: { started: active ? merges * 3 + 2 : 0, done: active ? merges * 2 + 1 : 0, failed: active ? 1 : 0, aborted: 0, unfinished: 0 },
      proposals: { filed: active ? merges * 2 + 1 : 0, withDiff: active ? merges * 2 : 0 },
      judged: { total: active ? merges * 2 : 0, ship: merges, review: active ? 1 : 0, noise: 0, harmful: 0, failed: 0 },
      verification: { passed: merges, failedCode: active ? 1 : 0, failedInfra: 0, failedUnknown: 0, withTests: merges },
      merges: { realized: unknownDay ? null : merges },
      claimCheck: { passed: null, flagged: null },
      estCostUsd: unknownDay ? null : active ? Number((merges * 0.35).toFixed(2)) : 0,
    };
  });
  const sum = (pick: (d: FleetHistoryDay) => number | null) => rows.reduce((s, d) => s + (pick(d) ?? 0), 0);
  return {
    generatedAt: iso(now),
    window: { from: iso(start), to: iso(now), days, tzOffsetMinutes: 0 },
    days: rows,
    totals: {
      runsStarted: sum((d) => d.runs.started),
      proposalsFiled: sum((d) => d.proposals.filed),
      judged: sum((d) => d.judged.total),
      verificationPassed: sum((d) => d.verification.passed),
      mergesRealized: sum((d) => d.merges.realized),
      estCostUsd: sum((d) => d.estCostUsd),
    },
    funnel: { filed: 180, verified: 150, verificationPassed: 122, judgedShip: 96, merged: 81 },
    swimlanes: [],
    swimlanesTruncated: false,
    lastActivityAt: kind === 'dark' ? DARK_SINCE : iso(now - 2 * MIN),
    darkSince: kind === 'dark' ? DARK_SINCE : null,
    sources: { runs: healthy(120), proposals: healthy(180), decisions: healthy(400), claimCheck: { state: 'not-recorded', complete: false, reasons: ['claim-integrity-verdicts-not-persisted'], recordsRead: 0, recordsSkipped: 0, lastRecordAt: null } },
    scorecard: { trend7d: [], trend30d: [], source: healthy(0), snapshot: { mode: 'inline', lastAttemptAt: null, lastWroteAt: null } },
  };
}

// ---------------------------------------------------------------------------
// Reasoning digest (A7)
// ---------------------------------------------------------------------------

export function reasoningDigest(kind: FixtureKind = 'live', now = Date.now()): ReasoningDigest {
  if (kind === 'dark') {
    return { generatedAt: iso(now), window: { from: iso(now - 30 * DAY), to: iso(now) }, totals: { steps: 0, sessions: 0, byEngine: {} }, insights: [], trends: [] };
  }
  const trends = Array.from({ length: 30 }, (_, i) => ({
    day: new Date(now - (29 - i) * DAY).toISOString().slice(0, 10),
    steps: kind === 'sparse' && i < 24 ? 0 : 40 + ((i * 13) % 30),
    struggles: kind === 'sparse' && i < 24 ? 0 : (i * 7) % 5,
    wins: kind === 'sparse' && i < 24 ? 0 : 2 + ((i * 3) % 6),
  }));
  return {
    generatedAt: iso(now),
    window: { from: iso(now - 30 * DAY), to: iso(now) },
    totals: { steps: 1840, sessions: 64, byEngine: kind === 'sparse' ? { claude: 120 } : { claude: 900, grok: 610, local: 330 } },
    insights: [
      { id: 'i1', kind: 'loop', repo: 'ashlr-hub', engine: 'claude', severity: 'high', title: 'Ran `npm test` 6 times without changing a file', evidence: [{ ref: 'session:s1#44', at: iso(now - 20 * MIN) }], count: 6, firstAt: iso(now - HOUR), lastAt: iso(now - 20 * MIN) },
      { id: 'i2', kind: 'verification-gap', repo: 'binshield', engine: 'grok', severity: 'warn', title: 'Edited the section parser three times without running tests', evidence: [{ ref: 'fleet:r2#3', at: iso(now - 2 * HOUR) }], count: 3, firstAt: iso(now - 3 * DAY), lastAt: iso(now - 2 * HOUR) },
      { id: 'i3', kind: 'struggle', repo: 'ashlr-hub', engine: 'claude', severity: 'warn', title: 'Typecheck failed 4 times on the same import', evidence: [{ ref: 'verse:s2:12', at: iso(now - 5 * HOUR) }], count: 4, firstAt: iso(now - 6 * HOUR), lastAt: iso(now - 5 * HOUR) },
      { id: 'i4', kind: 'win', repo: 'binshield', engine: 'local', severity: 'info', title: 'Tests passed right after the fuzz fix', evidence: [], count: 2, firstAt: iso(now - DAY), lastAt: iso(now - 12 * HOUR) },
      { id: 'i5', kind: 'backtrack', repo: 'ashlrcode', engine: 'grok', severity: 'info', title: 'Reverted its own refactor twice', evidence: [], count: 2, firstAt: iso(now - 2 * DAY), lastAt: iso(now - DAY) },
      { id: 'i6', kind: 'uncertainty', repo: 'ashlr-hub', engine: 'local', severity: 'info', title: 'Said “not sure” about the ledger format 5 times', evidence: [], count: 5, firstAt: iso(now - 2 * DAY), lastAt: iso(now - DAY) },
    ].slice(0, kind === 'sparse' ? 1 : 6) as ReasoningDigest['insights'],
    trends,
  };
}

// ---------------------------------------------------------------------------
// Budget (A9)
// ---------------------------------------------------------------------------

export function budgetView(kind: FixtureKind = 'live', now = Date.now()): BudgetView {
  const sampledAt = iso(now - 30_000);
  return {
    mode: 'balanced',
    seats: {},
    updatedAt: iso(now - DAY),
    headroom: [
      // Consistent with core/routing/headroom.ts under balanced (reserve 40,
      // 5-hour cap 70): weekly room 60−54 = 6, 5-hour room 70−74 = −4, so the
      // 5-HOUR window binds (it used to say 'weekly', which hid review 3.10 d2).
      { seatId: 'claude-a', sessionUsedPercent: 74, weeklyUsedPercent: kind === 'dark' ? null : 54, bindingWindow: 'session', autonomyHeadroomPercent: 0, resetAt: iso(now + 2 * HOUR), eligibleForAutonomy: false, reasons: ['5-hour window at 74% — above autonomy’s 70% stop line'] },
      { seatId: 'grok-a', sessionUsedPercent: null, weeklyUsedPercent: 31, bindingWindow: 'weekly', autonomyHeadroomPercent: 69, resetAt: iso(now + 4 * DAY), eligibleForAutonomy: true, reasons: ['69% of the weekly window is free for autonomy'] },
      { seatId: 'codex-a', sessionUsedPercent: null, weeklyUsedPercent: 100, bindingWindow: 'weekly', autonomyHeadroomPercent: 0, resetAt: iso(now + 42 * HOUR), eligibleForAutonomy: false, reasons: ['weekly window exhausted'] },
      { seatId: 'local-qwen', sessionUsedPercent: null, weeklyUsedPercent: null, bindingWindow: null, autonomyHeadroomPercent: null, resetAt: null, eligibleForAutonomy: true, reasons: ['local: free, no provider window'] },
    ],
    seatInfo: [
      { seatId: 'claude-a', label: 'Claude (claude-a)', engine: 'claude', free: false },
      { seatId: 'grok-a', label: 'Grok (grok-a)', engine: 'grok', free: false },
      { seatId: 'codex-a', label: 'Codex (codex-a)', engine: 'codex', free: false },
      { seatId: 'local-qwen', label: 'Local Qwen', engine: 'local', free: true },
    ],
    effective: {
      'claude-a': { seatId: 'claude-a', enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 },
      'grok-a': { seatId: 'grok-a', enabled: true, reservePercent: 0 },
      'codex-a': { seatId: 'codex-a', enabled: false, reservePercent: 20 },
      'local-qwen': { seatId: 'local-qwen', enabled: true, reservePercent: 0 },
    },
    readingMaxAgeMs: 10 * MIN,
    sampledAt,
  };
}

/**
 * Recorded seat window history (GET /api/verse/budget/history), consistent
 * with `budgetView`: each line rises to the budget view's current reading
 * from its window's start (reset − length). live — the whole window; sparse —
 * the last three hours only (history began recently); dark — nothing yet.
 */
export function seatHistory(kind: FixtureKind = 'live', now = Date.now()): CapacityHistoryResponse {
  const line = (seatId: string, window: 'session' | 'weekly', from: number, to: number, fromUsed: number, toUsed: number, steps: number): CapacityHistorySeries => ({
    seatId,
    window,
    points: Array.from({ length: steps + 1 }, (_, i): [number, number] => [
      Math.round(from + ((to - from) * i) / steps),
      Math.round(fromUsed + ((toUsed - fromUsed) * i) / steps),
    ]),
    resetsAt: null,
    thinned: false,
  });
  const recent = now - 2 * MIN;
  const series: CapacityHistorySeries[] =
    kind === 'dark'
      ? []
      : kind === 'sparse'
        ? [line('grok-a', 'weekly', now - 3 * HOUR, recent, 29, 31, 6)]
        : [
            // 5-hour window resetting at now + 2 h → opened now − 3 h.
            line('claude-a', 'session', now - 3 * HOUR + 5 * MIN, recent, 8, 74, 12),
            line('claude-a', 'weekly', now - 5 * DAY, recent, 12, 54, 20),
            // Weekly windows: grok resets in 4 days (opened 3 days ago), codex in 42 h.
            line('grok-a', 'weekly', now - 3 * DAY + 10 * MIN, recent, 2, 31, 18),
            line('codex-a', 'weekly', now - 5 * DAY, recent, 30, 100, 20),
          ];
  const oldest = series.length ? Math.min(...series.map((s) => s.points[0]![0])) : null;
  return {
    v: 1,
    generatedAt: iso(now),
    days: 8,
    since: iso(now - 8 * DAY),
    oldestAt: oldest === null ? null : iso(oldest),
    series,
    truncated: false,
  };
}

export const SEAT_DECISION_FIXTURE: SeatDecision = decision;
