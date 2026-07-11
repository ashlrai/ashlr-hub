/**
 * m49.fleet-status.test.ts — M49: fleet control plane + observability.
 *
 * Units under test:
 *   1. buildFleetStatus (src/core/fleet/status.ts) — READ-ONLY aggregation that
 *      NEVER throws. HOME is relocated to a fresh tmp dir per test so the whole
 *      ~/.ashlr surface (daemon state, quota ledger, backlog, inbox, kill
 *      switch) is isolated; restored afterward.
 *   2. formatFleetStatus (src/cli/fleet.ts) — the pure no-color formatter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, DaemonTick, EngineId, Goal, WorkItem } from '../src/core/types.js';
import {
  buildFleetStatus,
  buildSkillCorpusReadiness,
  type FleetReadinessSourceQuality,
} from '../src/core/fleet/status.js';
import { formatFleetStatus } from '../src/cli/fleet.js';
import { buildFleetLaneLocks } from '../src/core/fleet/lane-lock.js';
import { buildContextEfficiencyStatus } from '../src/core/fleet/context-efficiency.js';
import { ROUTER_POLICY_VERSION } from '../src/core/learning/causal.js';
import { recordUse } from '../src/core/fleet/quota.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { buildAutonomyEvidencePack, persistAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { evaluateAutonomyPolicy } from '../src/core/autonomy/policy.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { recordDispatchProduction, type DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { recordDispatchManifest } from '../src/core/fleet/dispatch-manifest.js';
import { recordAgentAction, type AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import { recordDecision } from '../src/core/fleet/decisions-ledger.js';
import { recordOutcome } from '../src/core/fleet/worked-ledger.js';
import {
  readSkillUseEvents,
  recordSkillCard,
  recordSkillUseEvent,
  sanitizeSkillCard,
} from '../src/core/fleet/skill-records.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import { armDaemonSpendGuard, clearDaemonSpendGuard } from '../src/core/daemon/state.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

async function withTemporaryEnv<T>(entries: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFakeNow<T>(now: Date, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

function makeEvidencePack(id: string, generatedAt: string) {
  const proposal: Proposal = {
    id,
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'summary',
    diff: [
      'diff --git a/docs/fleet.md b/docs/fleet.md',
      '--- /dev/null',
      '+++ b/docs/fleet.md',
      '@@ -0,0 +1 @@',
      '+fleet',
      '',
    ].join('\n'),
    diffHash: `sha256:${id}`,
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: generatedAt,
  };
  const pack = buildAutonomyEvidencePack({
    proposal,
    target: 'main',
    trustBasis: 'tier',
    remotePreferred: true,
    riskClass: 'low',
    authority: { ok: true, detail: 'authority ok' },
    provenance: { ok: true, detail: 'provenance ok' },
    verification: { passed: true, detail: 'verify ok', commandKinds: ['test'] },
    risk: { ok: true, detail: 'risk ok' },
    scope: { ok: true, detail: 'scope ok' },
  });
  pack.generatedAt = generatedAt;
  pack.policy = evaluateAutonomyPolicy(pack, baseConfig());
  return pack;
}

function docsDiff(body: string): string {
  return [
    'diff --git a/docs/fleet.md b/docs/fleet.md',
    '--- /dev/null',
    '+++ b/docs/fleet.md',
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
}

function makeBacklogItem(
  repo: string,
  id: string,
  title: string,
  score = 5,
  source: WorkItem['source'] = 'goal',
  tags: string[] = ['test'],
): WorkItem {
  return {
    id,
    repo,
    source,
    title,
    detail: 'detail',
    value: 5,
    effort: 1,
    score,
    tags,
    ts: '2026-07-03T00:00:00.000Z',
  };
}

function makeTrustedDiagnosticResliceItem(repo: string, hash = 'abcdef123456', score = 9): WorkItem {
  return {
    id: `repo:proposal-repair-nodiff:${hash}`,
    repo,
    source: 'self',
    title: 'Reslice no-diff dispatch for repo item repo:goal:stalled',
    detail:
      `Diagnostic reslice: a dispatch completed without file changes.\n` +
      `Original work item: repo:goal:stalled\n` +
      `Dispatch outcome: empty-diff\n` +
      `Action: reslice the work into a smaller concrete edit.`,
    value: 5,
    effort: 1,
    score,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff'],
    ts: '2026-07-03T00:00:00.000Z',
  };
}

function seedHealthyRepairRecoveryEvents(repo: string, now: string): void {
  const base: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: now,
    machineId: 'm49',
    itemId: 'repo:proposal-repair-nodiff:111111111111',
    source: 'self',
    repo,
    title: 'Reslice no-diff dispatch for repo item repo:goal:stalled',
    backend: 'codex',
    tier: 'frontier',
    model: 'gpt-5.5',
    assignedBy: 'daemon',
    routeReason: 'frontier: generated diagnostic no-diff reslice',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: 'prop-repair-1',
    spentUsd: 0,
    reason: 'proposal filed',
    basis: 'run-proposal-outcome',
  };
  recordDispatchProduction([
    base,
    { ...base, itemId: 'repo:proposal-repair-nodiff:222222222222', proposalId: 'prop-repair-2' },
    {
      ...base,
      itemId: 'repo:proposal-repair-nodiff:333333333333',
      proposalCreated: false,
      proposalId: undefined,
      outcome: 'empty-diff',
      reason: 'engine "codex" completed without file changes',
    },
  ]);
}

function makeGoalRecord(
  repo: string | null,
  id: string,
  status: Goal['status'] = 'active',
  milestoneStatus: Goal['milestones'][number]['status'] = 'pending',
): Goal {
  return {
    id,
    objective: `Close ${id}`,
    project: repo,
    status,
    milestones: status === 'planning'
      ? []
      : [
          {
            id: `${id}-m0`,
            title: 'Ship focused milestone',
            detail: 'Implement the focused milestone.',
            order: 0,
            status: milestoneStatus,
            specId: null,
            swarmId: null,
            proposalId: null,
            createdAt: '2026-07-03T00:00:00.000Z',
            updatedAt: '2026-07-03T00:00:00.000Z',
          },
        ],
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-03T00:00:00.000Z',
  };
}

function writeGoalRecords(home: string, goals: Goal[]): void {
  const dir = join(home, '.ashlr', 'goals');
  mkdirSync(dir, { recursive: true });
  for (const goal of goals) {
    writeFileSync(join(dir, `${goal.id}.json`), JSON.stringify(goal, null, 2), 'utf8');
  }
}

function writeBacklogSnapshot(
  home: string,
  repo: string,
  items: WorkItem[],
  generatedAt = '2026-07-03T00:00:00.000Z',
): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
  writeFileSync(
    join(ashlrDir, 'backlog.json'),
    JSON.stringify({
      generatedAt,
      repos: [repo],
      items,
    }),
    'utf8',
  );
}

function createSignedProposal(
  cfg: AshlrConfig,
  opts: {
    title: string;
    diff: string;
    verifyResult?: Proposal['verifyResult'];
    engineTier?: Proposal['engineTier'];
    engineModel?: string;
  },
): Proposal {
  const engineModel = opts.engineModel ?? 'codex:gpt-5.5';
  const engineTier = opts.engineTier ?? 'frontier';
  const diffHash = hashDiff(opts.diff);
  return createProposal(
    {
      repo: '/tmp/repo',
      origin: 'agent',
      kind: 'patch',
      title: opts.title,
      summary: opts.title,
      diff: opts.diff,
      diffHash,
      engineModel,
      engineTier,
      provenanceSig: signProvenance(engineModel, engineTier, diffHash),
      ...(opts.verifyResult ? { verifyResult: opts.verifyResult } : {}),
    },
    cfg,
  );
}

function writeRunningDaemon(home: string, ticks: DaemonTick[] = [], lastTickAt = '2026-07-03T00:05:00.000Z'): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(
    join(ashlrDir, 'daemon.json'),
    JSON.stringify({
      running: true,
      pid: process.pid,
      startedAt: '2026-07-03T00:00:00.000Z',
      lastTickAt,
      todayDate: lastTickAt.slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 1,
      ticks,
    }),
    'utf8',
  );
}

function writeDaemonLock(home: string, heartbeatAt: string, pid = process.pid): void {
  const ashlrDir = join(home, '.ashlr');
  mkdirSync(ashlrDir, { recursive: true });
  writeFileSync(
    join(ashlrDir, 'daemon.lock'),
    JSON.stringify({
      pid,
      token: 'test-token',
      hostname: hostname(),
      acquiredAt: '2026-07-03T00:00:00.000Z',
      heartbeatAt,
    }),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

describe('buildFleetStatus — read-only aggregation (M49)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevAshlrHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-'));
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevAshlrHome = process.env.ASHLR_HOME;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome; // win32 homedir()
    process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
  });

  afterEach(() => {
    // Always clear the kill switch we may have set (it lives under tmpHome, but
    // be explicit so a stray sentinel never leaks between tests).
    try {
      setKill(false);
    } catch {
      // best-effort
    }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = prevAshlrHome;
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns the full shape with sane fallbacks on an empty ~/.ashlr', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);

    // Shape
    expect(typeof s.generatedAt).toBe('string');
    expect(Date.parse(s.generatedAt)).not.toBeNaN();
    expect(s.daemon).toBeDefined();
    expect(s.backends).toBeInstanceOf(Array);
    expect(s.queue).toBeDefined();
    expect(s.proposals).toBeDefined();
    expect(s.merges).toBeDefined();

    // Fallbacks on a pristine HOME
    expect(s.killed).toBe(false);
    expect(s.daemon.running).toBe(false);
    expect(s.daemon.lastTickAt).toBeNull();
    expect(s.daemon.todaySpentUsd).toBe(0);
    expect(s.queue.backlogItems).toBe(0);
    expect(s.queue.next).toBeUndefined();
    expect(s.queue.shared).toBeUndefined();
    expect(s.proposals.pending).toBe(0);
    expect(s.proposals.frontierPending).toBe(0);
    expect(s.proposals.applied).toBe(0);
    expect(s.merges.recent).toBe(0);
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      counts: {
        backlogItems: 0,
        pendingProposals: 0,
        preflightReady: 0,
      },
    });
    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      confidence: 'low',
      topBlocker: { id: 'daemon-stopped' },
      sourceSummary: expect.objectContaining({
        blocked: expect.any(Number),
        unknown: expect.any(Number),
      }),
    });
    expect(s.autonomousShipReadiness?.sourceSummary.healthy)
      .toBeLessThan(s.autonomousShipReadiness?.sources.length ?? 0);
    expect(s.missionBrief).toMatchObject({
      directive: 'Start the daemon',
      confidence: 'low',
      blocker: { id: 'daemon-stopped' },
      action: { id: 'start-daemon' },
      evidence: {
        readinessVerdict: 'blocked',
        effectivenessPhase: 'control-blocked',
        queueBacklogItems: 0,
        pendingProposals: 0,
        preflightReady: 0,
      },
    });
    expect(s.missionBrief?.whyNow).toContain('daemon is stopped');
    const startDaemon = s.nextActions?.find((action) => action.id === 'start-daemon');
    expect(startDaemon?.commands?.[0]).toMatchObject({
      label: 'Start daemon',
      argv: ['ashlr', 'daemon', 'start'],
      shell: 'ashlr daemon start',
      safety: 'autonomous-dispatch',
    });
    expect(startDaemon?.commands?.[1]).toMatchObject({
      endpointPath: '/api/daemon/service/repair',
      tokenRequired: true,
      safety: 'control-plane',
    });
    expect(s.autonomy).toMatchObject({
      evidencePacks: 0,
      latestAt: null,
      allowed: 0,
      denied: 0,
    });
    expect(s.autonomyDirection).toMatchObject({
      confidence: expect.any(String),
      resources: {
        posture: expect.any(String),
        constrained: expect.any(Number),
        depleted: expect.any(Number),
      },
      guardHealth: {
        blocked: expect.any(Boolean),
        blocks: expect.any(Number),
      },
      budgets: {
        daemonBudgetLevel: expect.any(String),
        daemonSpentTodayUsd: 0,
      },
    });
    expect(['pause', 'local-only', 'verify-only', 'backlog-build', 'auto-merge-ready']).toContain(
      s.autonomyDirection?.mode,
    );
  });

  it('does not refresh, persist, or audit backlog while building a status snapshot', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);

    expect(s.queue.backlogItems).toBe(0);
    expect(existsSync(join(tmpHome, '.ashlr', 'backlog.json'))).toBe(false);
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('reports backlog count from the last persisted backlog snapshot only', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const item = {
      id: 'repo:goal:one',
      repo,
      source: 'goal',
      title: 'Advance goal one',
      detail: 'detail',
      value: 4,
      effort: 2,
      score: 2,
      tags: ['goal'],
      ts: '2026-07-01T00:00:00.000Z',
    };
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-01T00:00:00.000Z',
        repos: [repo],
        items: [
          item,
          { ...item, id: 'repo:goal:two', title: 'Advance goal two' },
          { ...item, id: 'stale:goal:tmp', repo: '/tmp/ashlr-deleted-fixture', title: 'Stale test fixture' },
        ],
      }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(2);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.pendingItems).toBe(0);
    expect(s.queue.nextEligibleAt).toBeNull();
    expect(s.queue.repos).toEqual({
      enrolled: 1,
      existing: 1,
      withBacklog: 1,
      silent: 0,
      executionProfiles: {
        reposWithProjects: 0,
        reposWithVerifyCommands: 0,
        reposMissingVerifyCommands: 1,
        reposWithVerifyContracts: 0,
        reposWithValidVerifyContracts: 0,
        reposWithExplicitMergeContracts: 0,
        reposMissingExplicitMergeContracts: 1,
        missingVerifyCommands: [
          {
            repo,
            name: 'repo',
            projectKinds: [],
            reason: 'no recognized project manifests or ashlr.verify.json',
          },
        ],
        missingExplicitMergeContracts: [
          {
            repo,
            name: 'repo',
            projectKinds: [],
            reason: 'missing ashlr.verify.json merge-profile contract',
          },
        ],
        packageManagers: [],
      },
      byTier: [{ tier: 'inventory', repos: 1, items: 2 }],
      top: [{ repo, items: 2 }],
    });
    expect(s.queue.next).toEqual([
      {
        id: 'repo:goal:one',
        title: 'Advance goal one',
        repo,
        source: 'goal',
        score: 2,
      },
      {
        id: 'repo:goal:two',
        title: 'Advance goal two',
        repo,
        source: 'goal',
        score: 2,
      },
    ]);
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      bottleneck: 'control',
      counts: {
        backlogItems: 2,
        pendingProposals: 0,
      },
    });
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('surfaces goal focus mode without refreshing or expanding backlog', async () => {
    const repo = join(tmpHome, 'repo-focus');
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo-focus:goal:one', 'Advance active goal', 5, 'goal'),
      makeBacklogItem(repo, 'repo-focus:invent:one', 'Invent broad feature', 4, 'invent'),
    ]);
    writeGoalRecords(tmpHome, [
      makeGoalRecord(repo, 'goal-focus-a'),
      makeGoalRecord(repo, 'goal-focus-b'),
      makeGoalRecord(repo, 'goal-focus-c'),
      makeGoalRecord(repo, 'goal-focus-d', 'active', 'in-progress'),
      makeGoalRecord(repo, 'goal-focus-planning', 'planning'),
    ]);

    const s = await buildFleetStatus(withFoundry({ goalFocusActiveThreshold: 4 }));

    expect(s.goalFocus).toMatchObject({
      enabled: true,
      activeThreshold: 4,
      activeGoalCount: 4,
      actionableActiveGoalCount: 4,
      planningGoalCount: 1,
      deferredNewGoalWork: true,
      reason: 'active-goal-work-in-flight',
      visibleGoalBacklogItems: 1,
      visibleInventBacklogItems: 1,
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'close-active-goals',
      label: 'Close active goals',
      detail: expect.stringContaining('holding new planning/invent work'),
    }));
    expect(formatFleetStatus(s)).toContain(
      'goal focus:    closing active goals (4/4 actionable active, 1 planning)',
    );
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('surfaces read-only lane locks from active goals, host handoffs, and unverified applied proposals', async () => {
    const repo = join(tmpHome, 'repo-lanes');
    const cfg = baseConfig();
    const applied = createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Applied without verification',
        summary: 'applied without verification',
        diff: docsDiff('unverified'),
      },
      cfg,
    );
    setStatus(applied.id, 'applied');
    const handoff = createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Awaiting host merge',
        summary: 'remote handoff',
        diff: docsDiff('handoff'),
      },
      cfg,
    );
    setStatus(handoff.id, 'awaiting-host-merge');
    const outsideRepo = join(tmpHome, 'outside-repo');
    const outsideApplied = createProposal(
      {
        repo: outsideRepo,
        origin: 'agent',
        kind: 'patch',
        title: 'Outside unverified applied',
        summary: 'outside repo',
        diff: docsDiff('outside'),
      },
      cfg,
    );
    setStatus(outsideApplied.id, 'applied');

    const staleGoal = makeGoalRecord(repo, 'goal-lane-a', 'active', 'in-progress');
    staleGoal.milestones[0]!.updatedAt = '2026-07-03T00:00:00.000Z';
    const proposedGoal = makeGoalRecord(repo, 'goal-lane-b', 'active', 'proposed');
    proposedGoal.milestones[0]!.proposalId = applied.id;
    const outsideGoal = makeGoalRecord(outsideRepo, 'goal-outside', 'active', 'pending');

    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, `goal:${staleGoal.id}:${staleGoal.milestones[0]!.id}`, 'Advance stale goal', 5, 'goal'),
      makeBacklogItem(
        repo,
        'repo-lanes:goal:abcdef0123',
        'Advance proposed goal',
        4,
        'goal',
        ['goal', proposedGoal.id, proposedGoal.milestones[0]!.id],
      ),
      makeBacklogItem(repo, 'invent:one', 'Invent unrelated thing', 3, 'invent'),
    ]);
    writeGoalRecords(tmpHome, [staleGoal, proposedGoal, outsideGoal]);

    const s = await buildFleetStatus(cfg);

    expect(s.laneLocks).toMatchObject({
      active: 2,
      staleInProgress: 1,
      awaitingHostMerge: 1,
      unverifiedApplied: 1,
      lockedVisibleItems: 2,
    });
    expect(s.laneLocks?.samples.map((sample) => sample.reason)).toEqual(
      expect.arrayContaining(['stale-in-progress', 'active-goal', 'awaiting-host-merge', 'unverified-applied']),
    );
    expect(s.laneLocks?.samples.every((sample) => !('diff' in sample))).toBe(true);
    expect(formatFleetStatus(s)).toContain(
      'lane locks:    2 active, 1 stale, 1 handoff, 1 unverified, 2 visible locked',
    );
    const action = s.nextActions?.find((candidate) => candidate.id === 'recover-stale-goal-lanes');
    expect(action).toMatchObject({
      priority: 'high',
      label: 'Recover stale goal lanes',
      target: repo,
    });
    expect(action?.commands?.map((command) => command.argv)).toEqual([
      ['ashlr', 'goals', 'show', 'goal-lane-a', '--json'],
      ['ashlr', 'goals', 'recover-stale'],
    ]);
  });

  it('surfaces missing verify repo names, project kinds, and reasons', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'make-repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'Makefile'), 'build:\n\t@true\n', 'utf8');
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({ generatedAt: '2026-07-03T00:00:00.000Z', repos: [repo], items: [] }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.repos?.executionProfiles).toMatchObject({
      reposWithProjects: 1,
      reposWithVerifyCommands: 0,
      reposMissingVerifyCommands: 1,
      reposWithVerifyContracts: 0,
      reposWithValidVerifyContracts: 0,
      reposWithExplicitMergeContracts: 0,
      reposMissingExplicitMergeContracts: 1,
      missingVerifyCommands: [
        {
          repo,
          name: 'make-repo',
          projectKinds: ['make'],
          reason: 'detected make project(s), but no verify command is configured',
        },
      ],
      missingExplicitMergeContracts: [
        {
          repo,
          name: 'make-repo',
          projectKinds: ['make'],
          reason: 'missing ashlr.verify.json merge-profile contract',
        },
      ],
    });
    expect(s.nextActions?.some((action) => action.detail.includes('make-repo'))).toBe(true);
    expect(s.nextActions?.some((action) => action.id === 'add-explicit-merge-verify-contracts')).toBe(true);
    const mergeContractAction = s.nextActions?.find((action) => action.id === 'add-explicit-merge-verify-contracts');
    expect(mergeContractAction?.priority).toBe('medium');
    expect(mergeContractAction?.detail).toContain(
      'make-repo [make: missing ashlr.verify.json merge-profile contract]',
    );
    expect(mergeContractAction?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Inspect merge contracts',
        argv: ['ashlr', 'fleet', 'status', '--json'],
        safety: 'read-only',
      }),
      expect.objectContaining({
        label: 'Edit verify contract',
        argv: ['vi', 'ashlr.verify.json'],
        cwd: repo,
        safety: 'manual',
      }),
    ]));
  });

  it('surfaces count-only scanner evidence quality separately from queue availability', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'scanner-evidence-repo');
    const observedAt = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(join(ashlrDir, 'backlog.json'), JSON.stringify({
      generatedAt: observedAt,
      repos: [repo],
      items: [],
      observations: [
        {
          schemaVersion: 1,
          observedAt,
          repo,
          scannerId: 'queued-autonomy',
          domain: 'local-queue',
          source: 'self',
          status: 'absent',
          reason: 'source-confirmed-empty',
        },
        {
          schemaVersion: 1,
          observedAt,
          repo,
          scannerId: 'github-issues',
          domain: 'github',
          source: 'issue',
          status: 'unavailable',
          reason: 'legacy-empty-result',
        },
      ],
    }), 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.scannerEvidence).toEqual({
      state: 'degraded',
      observations: 2,
      present: 0,
      absent: 1,
      unavailable: 1,
      scannerDomains: 2,
    });
    expect(formatFleetStatus(s)).toContain(
      'scan evidence: degraded (0 present, 1 absent, 1 unavailable across 2 scanner domain(s))',
    );
  });

  it('keeps scanner evidence degraded when malformed rows are filtered', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'malformed-evidence-repo');
    const observedAt = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const validAbsent = {
      schemaVersion: 1,
      observedAt,
      repo,
      scannerId: 'queued-autonomy',
      domain: 'local-queue',
      source: 'self',
      status: 'absent',
      reason: 'source-confirmed-empty',
    };
    writeFileSync(join(ashlrDir, 'backlog.json'), JSON.stringify({
      generatedAt: observedAt,
      repos: [repo],
      items: [],
      observations: [validAbsent, { ...validAbsent, status: 'present', reason: 'scanner-failed' }],
    }), 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.scannerEvidence).toMatchObject({
      state: 'degraded',
      observations: 1,
      absent: 1,
      unavailable: 0,
    });
  });

  it('reports a wholly malformed observation envelope as degraded, not unknown', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'all-malformed-evidence-repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(join(ashlrDir, 'backlog.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      repos: [repo],
      items: [],
      observations: [{ schemaVersion: 1, status: 'absent', reason: 'scanner-failed' }],
    }), 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.scannerEvidence).toMatchObject({
      state: 'degraded',
      observations: 0,
      present: 0,
      absent: 0,
      unavailable: 0,
    });
  });

  it('separates inferred verify commands from explicit merge-grade contracts', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const inferredRepo = join(tmpHome, 'inferred-repo');
    const contractRepo = join(tmpHome, 'contract-repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(inferredRepo, { recursive: true });
    mkdirSync(contractRepo, { recursive: true });
    writeFileSync(
      join(inferredRepo, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
      'utf8',
    );
    writeFileSync(
      join(contractRepo, 'ashlr.verify.json'),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'replace-detected',
        commands: [
          {
            id: 'merge-test',
            kind: 'test',
            cmd: ['npm', 'run', 'test'],
            required: true,
            profiles: ['merge'],
          },
        ],
      }),
      'utf8',
    );
    writeFileSync(
      join(ashlrDir, 'enrollment.json'),
      JSON.stringify({ repos: [inferredRepo, contractRepo] }),
      'utf8',
    );
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({ generatedAt: '2026-07-03T00:00:00.000Z', repos: [inferredRepo, contractRepo], items: [] }),
      'utf8',
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.repos?.executionProfiles).toMatchObject({
      reposWithVerifyCommands: 2,
      reposMissingVerifyCommands: 0,
      reposWithVerifyContracts: 1,
      reposWithValidVerifyContracts: 1,
      reposWithExplicitMergeContracts: 1,
      reposMissingExplicitMergeContracts: 1,
      missingExplicitMergeContracts: [
        {
          repo: inferredRepo,
          name: 'inferred-repo',
          projectKinds: ['node'],
          reason: 'missing ashlr.verify.json merge-profile contract',
        },
      ],
    });
  });

  it('does not suggest building backlog when all visible items are cooling', async () => {
    const repo = join(tmpHome, 'repo');
    const items = [
      makeBacklogItem(repo, 'repo:goal:cooling-one', 'Cooling one', 9),
      makeBacklogItem(repo, 'repo:goal:cooling-two', 'Cooling two', 5),
    ];
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
      },
    });
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, items);
    recordOutcome('repo:goal:cooling-one', 'empty', new Date().toISOString());
    recordOutcome('repo:goal:cooling-two', 'judged-review', new Date().toISOString());

    const s = await buildFleetStatus(cfg);

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.cooldownItems).toBe(2);
    expect(s.queue.pendingItems).toBe(0);
    expect(s.queue.nextEligibleAt).toMatch(/T/);
    expect(s.queue.next).toBeUndefined();
    expect(s.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
    expect(s.nextActions?.[0]).toMatchObject({
      id: 'cooldown-gated-backlog',
      priority: 'medium',
      label: 'Review cooldown gate',
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'wait-for-backlog-eligibility',
      detail: expect.stringContaining('next eligible at'),
    }));
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'cooldown-gated',
      bottleneck: 'cooldown',
      counts: {
        backlogItems: 2,
        eligibleBacklogItems: 0,
        cooldownItems: 2,
      },
    });
    expect(s.autonomyEffectiveness?.summary).toContain('Next eligible at');
    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'degraded',
      topBlocker: {
        id: 'backlog-cooldown-gated',
        source: 'queue',
      },
      primaryAction: {
        id: 'cooldown-gated-backlog',
      },
    });
  });

  it('does not suggest building backlog when visible items already have pending proposals', async () => {
    const repo = join(tmpHome, 'repo');
    const item = makeBacklogItem(repo, 'repo:goal:pending', 'Pending proposal work', 7);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [item]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Proposal for pending queue work',
        summary: 'This pending proposal covers the queued item without repeating its id.',
        diff: docsDiff('pending'),
        workItemId: item.id,
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(1);
    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next).toBeUndefined();
    expect(s.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'wait-for-backlog-eligibility',
      detail: expect.stringContaining('0 cooling, 1 pending'),
    }));
  });

  it('keeps backlog eligible when matching pending proposals are stale under production velocity', async () => {
    const repo = join(tmpHome, 'repo');
    const item = makeBacklogItem(repo, 'repo:goal:stale-pending', 'Stale pending proposal work', 7);
    const cfg = withFoundry({
      productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
    });
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [item]);
    await withFakeNow(new Date('2026-07-01T00:00:00.000Z'), async () => {
      createProposal(
        {
          repo,
          origin: 'agent',
          kind: 'patch',
          title: 'Old proposal for pending queue work',
          summary: 'This stale pending proposal covers the queued item.',
          diff: docsDiff('stale pending'),
          workItemId: item.id,
        },
        cfg,
      );
    });

    const s = await withFakeNow(new Date('2026-07-03T00:00:00.000Z'), () => buildFleetStatus(cfg));

    expect(s.proposals.pending).toBe(1);
    expect(s.queue.backlogItems).toBe(1);
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.pendingItems).toBe(0);
    expect(s.queue.next?.[0]).toMatchObject({ id: item.id, repo });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'build-backlog',
      detail: `Start with ${item.title}`,
      target: repo,
    }));
  });

  it('keeps unrelated backlog eligible when a workItemId proposal mentions another item', async () => {
    const repo = join(tmpHome, 'repo');
    const covered = makeBacklogItem(repo, 'repo:goal:covered', 'Covered proposal work', 7);
    const mentioned = makeBacklogItem(repo, 'repo:goal:mentioned', 'Mentioned but fresh work', 6);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [covered, mentioned]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: `Proposal text mentions ${mentioned.id}`,
        summary: `Stale context mentions ${mentioned.id}, but the causal work item is different.`,
        diff: docsDiff('pending causal item'),
        workItemId: covered.id,
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({ id: mentioned.id, repo });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'build-backlog',
      detail: `Start with ${mentioned.title}`,
      target: repo,
    }));
  });

  it('keeps legacy pending proposal matching for exact item-id mentions', async () => {
    const repo = join(tmpHome, 'repo');
    const item = makeBacklogItem(repo, 'repo:goal:legacy-pending', 'Legacy pending proposal work', 7);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [item]);
    createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: `Legacy proposal for ${item.id}`,
        summary: 'Legacy proposal has no workItemId.',
        diff: docsDiff('legacy pending'),
      },
      baseConfig(),
    );

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.eligibleBacklogItems).toBe(0);
    expect(s.queue.pendingItems).toBe(1);
    expect(s.queue.next).toBeUndefined();
  });

  it('builds queue.next and build-backlog from eligible items instead of higher-scored cooling items', async () => {
    const repo = join(tmpHome, 'repo');
    const cooled = makeBacklogItem(repo, 'repo:goal:cooled', 'High score but cooling', 10);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 2);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [cooled, fresh]);
    recordOutcome(cooled.id, 'empty', new Date().toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(2);
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({
      id: fresh.id,
      title: fresh.title,
      repo,
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'build-backlog',
      detail: `Start with ${fresh.title}`,
      target: repo,
    }));
  });

  it('summarizes proposal starvation when the daemon is running with backlog but no proposals', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(repo, { recursive: true });
    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 2,
      proposalsCreated: 0,
      spentUsd: 0.02,
      reason: 'ok',
      proposalProduction: {
        selected: 2,
        claimed: 2,
        dispatched: 2,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 2,
        reasons: [{ reason: 'gate-blocked: completeness gate blocked proposal: typecheck failed', count: 2 }],
      },
      dispatches: [
        {
          itemId: 'repo:self-heal:one',
          title: 'Fix broken test in repo',
          repo,
          source: 'self',
          backend: 'builtin',
          tier: 'local',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0.01,
          production: {
            outcome: 'gate-blocked',
            reason: 'completeness gate blocked proposal: typecheck failed',
          },
        },
        {
          itemId: 'repo:self-heal:two',
          title: 'Add missing verify command',
          repo,
          source: 'todo',
          backend: 'builtin',
          tier: 'local',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0.01,
          production: {
            outcome: 'gate-blocked',
            reason: 'completeness gate blocked proposal: typecheck failed',
          },
        },
      ],
    };
    const staleTick: DaemonTick = {
      ts: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      itemsConsidered: 99,
      proposalsCreated: 99,
      spentUsd: 0,
      reason: 'stale',
      proposalProduction: {
        selected: 99,
        claimed: 99,
        dispatched: 99,
        skipped: 0,
        errors: 99,
        proposalsCreated: 99,
        noProposalDispatches: 99,
        reasons: [{ reason: 'stale should be ignored', count: 99 }],
      },
    };
    writeRunningDaemon(tmpHome, [staleTick, recentTick]);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-03T00:00:00.000Z',
        repos: [repo],
        items: [{
          id: 'repo:self-heal:one',
          repo,
          source: 'self',
          title: 'Fix broken test in repo',
          detail: 'detail',
          value: 5,
          effort: 1,
          score: 5,
          tags: ['self-heal'],
          ts: '2026-07-03T00:00:00.000Z',
        }],
      }),
      'utf8',
    );

    const s = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));

    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      counts: {
        backlogItems: 1,
        pendingProposals: 0,
      },
    });
    expect(s.autonomyEffectiveness?.summary).toContain('no pending proposals');
    expect(s.proposalProduction).toMatchObject({
      selected: 2,
      claimed: 2,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 2,
      topReasons: [{ reason: 'gate-blocked: completeness gate blocked proposal: typecheck failed', count: 2 }],
    });
    expect(s.proposalProduction?.recentNoProposalDispatches).toHaveLength(2);
    expect(s.proposalProduction?.recentNoProposalDispatches[0]).toMatchObject({
      productionOutcome: 'gate-blocked',
      reason: 'completeness gate blocked proposal: typecheck failed',
    });
    expect(s.autonomyEffectiveness?.summary).toContain('2 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('top reason: gate-blocked: completeness gate blocked proposal: typecheck failed');
    expect(s.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inspect-proposal-production',
          label: 'Inspect proposal production',
          detail: expect.stringContaining('typecheck failed'),
        }),
      ]),
    );
  });

  it('keeps proposal-disabled attempts out of operator production diagnosis', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 4,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
      proposalProduction: {
        selected: 4,
        claimed: 4,
        dispatched: 4,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 4,
        reasons: [
          { reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt', count: 2 },
          { reason: 'proposal-disabled: proposal filing disabled for this api-model attempt', count: 1 },
          { reason: 'empty-diff: agent returned no diff', count: 1 },
        ],
      },
      dispatches: [
        {
          itemId: 'repo:goal:suppressed-one',
          title: 'Suppressed one',
          repo,
          source: 'goal',
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this sandboxed attempt',
          },
        },
        {
          itemId: 'repo:goal:suppressed-two',
          title: 'Suppressed two',
          repo,
          source: 'goal',
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this sandboxed attempt',
          },
        },
        {
          itemId: 'repo:goal:suppressed-api',
          title: 'Suppressed api model',
          repo,
          source: 'goal',
          backend: 'local-coder',
          tier: 'mid',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this api-model attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this api-model attempt',
          },
        },
        {
          itemId: 'repo:goal:empty',
          title: 'Empty diff',
          repo,
          source: 'goal',
          backend: 'claude',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'agent returned no diff',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'empty-diff',
            reason: 'agent returned no diff',
          },
        },
      ],
    };
    writeRunningDaemon(tmpHome, [recentTick]);
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5),
    ], new Date().toISOString());

    const s = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));

    expect(s.proposalProduction).toMatchObject({
      noProposalDispatches: 4,
      suppressedDispatches: 3,
      diagnosticNoProposalDispatches: 1,
      diagnosticTopReasons: [{ reason: 'empty-diff: agent returned no diff', count: 1 }],
    });
    expect(s.proposalProduction?.topReasons[0]?.reason).toContain('proposal-disabled');
    expect(s.proposalProduction?.topReasons.map((reason) => reason.reason)).toContain(
      'proposal-disabled: proposal filing disabled for this api-model attempt',
    );
    expect(s.proposalProduction?.recentNoProposalDispatches).toHaveLength(4);
    expect(s.proposalProduction?.recentDiagnosticNoProposalDispatches).toHaveLength(1);
    expect(s.proposalProduction?.recentDiagnosticNoProposalDispatches[0]).toMatchObject({
      itemId: 'repo:goal:empty',
      reason: 'agent returned no diff',
    });
    expect(s.autonomyEffectiveness?.summary).toContain('1 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('top reason: empty-diff: agent returned no diff');
    expect(s.autonomyEffectiveness?.summary).not.toContain('proposal-disabled');
    expect(s.contextEfficiency?.signals.suppressedNoProposalDispatches).toBe(3);
    expect(s.contextEfficiency?.risks.map((risk) => risk.id)).not.toContain('proposal-yield-low');
    expect(s.contextEfficiency?.recommendations.join('\n')).not.toContain('Reslice low-yield backlog items');
    const inspectAction = s.nextActions?.find((action) => action.id === 'inspect-proposal-production');
    expect(inspectAction?.detail).toContain('agent returned no diff');
    expect(inspectAction?.detail).not.toContain('proposal-disabled');
    const dispatchYieldAction = s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield');
    expect(dispatchYieldAction?.detail ?? '').not.toContain('proposal-disabled');
  });

  it('keeps all-suppressed proposal-production windows out of operator reason text', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 2,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
      proposalProduction: {
        selected: 2,
        claimed: 2,
        dispatched: 2,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 2,
        reasons: [
          { reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt', count: 1 },
          { reason: 'proposal-disabled: proposal filing disabled for this api-model attempt', count: 1 },
        ],
      },
      dispatches: [
        {
          itemId: 'repo:goal:suppressed-sandbox',
          title: 'Suppressed sandbox',
          repo,
          source: 'goal',
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this sandboxed attempt',
          },
        },
        {
          itemId: 'repo:goal:suppressed-api',
          title: 'Suppressed api model',
          repo,
          source: 'goal',
          backend: 'local-coder',
          tier: 'mid',
          assignedBy: 'router',
          reason: 'proposal-disabled: proposal filing disabled for this api-model attempt',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'proposal-disabled',
            reason: 'proposal filing disabled for this api-model attempt',
          },
        },
      ],
    };
    writeRunningDaemon(tmpHome, [recentTick]);
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5),
    ], new Date().toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.proposalProduction).toMatchObject({
      noProposalDispatches: 2,
      suppressedDispatches: 2,
      diagnosticNoProposalDispatches: 0,
      diagnosticTopReasons: [],
      recentDiagnosticNoProposalDispatches: [],
    });
    expect(s.proposalProduction?.topReasons.map((reason) => reason.reason)).toEqual([
      'proposal-disabled: proposal filing disabled for this api-model attempt',
      'proposal-disabled: proposal filing disabled for this sandboxed attempt',
    ]);
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('no-proposal 0, suppressed 2');
    expect(formatted).not.toContain('proposal-disabled');
    expect(formatted).not.toContain('proposal filing disabled');
    expect(s.autonomyEffectiveness?.summary).not.toContain('proposal-disabled');
    expect(s.autonomyEffectiveness?.summary).not.toContain('proposal filing disabled');
    expect(JSON.stringify(s.nextActions ?? [])).not.toContain('proposal filing disabled');
    expect(s.missionBrief?.whyNow ?? '').not.toContain('proposal filing disabled');
  });

  it('uses aggregate production reasons for diagnostics when dispatch samples are absent', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 10,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
      proposalProduction: {
        selected: 10,
        claimed: 10,
        dispatched: 10,
        skipped: 0,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 10,
        reasons: [
          { reason: 'proposal-disabled: proposal filing disabled for this sandboxed attempt', count: 7 },
          { reason: 'empty-diff: engine "local-coder" completed without file changes', count: 3 },
        ],
      },
      dispatches: [],
    };
    writeRunningDaemon(tmpHome, [recentTick]);
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5),
    ], new Date().toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.proposalProduction).toMatchObject({
      noProposalDispatches: 10,
      suppressedDispatches: 7,
      diagnosticNoProposalDispatches: 3,
      diagnosticTopReasons: [
        { reason: 'empty-diff: engine "local-coder" completed without file changes', count: 3 },
      ],
    });
    expect(s.proposalProduction?.topReasons[0]?.reason).toContain('proposal-disabled');
    expect(s.autonomyEffectiveness?.summary).toContain('3 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('empty-diff: engine "local-coder" completed without file changes');
    expect(s.autonomyEffectiveness?.summary).not.toContain('proposal-disabled');
    const productionAction = s.nextActions?.find((action) => action.id === 'inspect-proposal-production');
    expect(productionAction?.detail).toContain('empty-diff: engine "local-coder" completed without file changes');
    expect(productionAction?.detail).not.toContain('proposal-disabled');
  });

  it('keeps skipped not-attempted rows out of no-proposal diagnostics', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const recentTick: DaemonTick = {
      ts: new Date().toISOString(),
      itemsConsidered: 9,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'ok',
      proposalProduction: {
        selected: 9,
        claimed: 9,
        dispatched: 3,
        skipped: 6,
        errors: 0,
        proposalsCreated: 0,
        noProposalDispatches: 3,
        reasons: [
          { reason: 'not-attempted', count: 6 },
          { reason: 'empty-diff: engine "local-coder" completed without file changes', count: 3 },
        ],
      },
      dispatches: [
        ...Array.from({ length: 6 }, (_, idx) => ({
          itemId: `repo:goal:skip-${idx}`,
          title: `Skipped ${idx}`,
          repo,
          source: 'goal' as const,
          backend: null,
          tier: null,
          assignedBy: 'daemon',
          reason: 'not-attempted',
          dispatched: false,
          spentUsd: 0,
          skipReason: 'not-attempted',
        })),
        ...Array.from({ length: 3 }, (_, idx) => ({
          itemId: `repo:goal:empty-${idx}`,
          title: `Empty ${idx}`,
          repo,
          source: 'goal' as const,
          backend: 'local-coder' as const,
          tier: 'local' as const,
          assignedBy: 'router',
          reason: 'engine "local-coder" completed without file changes',
          dispatched: true,
          spentUsd: 0,
          production: {
            outcome: 'empty-diff' as const,
            reason: 'engine "local-coder" completed without file changes',
          },
        })),
      ],
    };
    writeRunningDaemon(tmpHome, [recentTick]);
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5),
    ], new Date().toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.proposalProduction?.topReasons[0]).toEqual({ reason: 'not-attempted', count: 6 });
    expect(s.proposalProduction?.skipReasons[0]).toEqual({ reason: 'not-attempted', count: 6 });
    expect(s.proposalProduction?.diagnosticTopReasons[0]).toEqual({
      reason: 'empty-diff: engine "local-coder" completed without file changes',
      count: 3,
    });
    expect(s.proposalProduction?.diagnosticTopReasons.map((reason) => reason.reason)).not.toContain('not-attempted');
    expect(s.autonomyEffectiveness?.summary).toContain('3 recent dispatch(es) produced no proposal');
    expect(s.autonomyEffectiveness?.summary).toContain('empty-diff: engine "local-coder" completed without file changes');

    const skipAction = s.nextActions?.find((action) => action.id === 'inspect-dispatch-skips');
    expect(skipAction?.detail).toContain('6 selected item(s) were not attempted');
    expect(skipAction?.detail).toContain('top skip: not-attempted');
    const productionAction = s.nextActions?.find((action) => action.id === 'inspect-proposal-production');
    expect(productionAction?.detail).toContain('empty-diff: engine "local-coder" completed without file changes');
    expect(productionAction?.detail).not.toContain('not-attempted');
  });

  it('reports durable dispatch-production yield from the append-only ledger', async () => {
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-a',
      source: 'todo',
      repo: '/repo/a',
      title: 'Improve proposal yield',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', outcome: 'gate-blocked', reason: 'completeness gate blocked proposal' },
      {
        ...baseEvent,
        itemId: 'repo:proposal-repair-capture:abcdef123456',
        title: 'Repair dispatch capture failure for repo item repo:self-heal:stalled',
        source: 'goal',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-c',
        reason: 'proposal filed',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      events: 3,
      attempts: 3,
      proposalsCreated: 1,
      noProposal: 2,
      proposalRate: 1 / 3,
      outcomes: {
        proposalCreated: 1,
        emptyDiff: 1,
        gateBlocked: 1,
      },
      generatedRepairAttempts: {
        attempts: 1,
        proposalsCreated: 1,
        noProposal: 0,
        proposalRate: 1,
        captureRepairs: 1,
        diagnosticReslices: 0,
        proposalRepairs: 0,
      },
    });
    expect(s.attemptCoverage?.production.generatedRepairAttempts).toMatchObject({
      attempts: 1,
      proposalsCreated: 1,
      captureRepairs: 1,
    });
    expect(s.dispatchProduction?.byBackend[0]).toMatchObject({
      backend: 'local-coder',
      attempts: 2,
      proposalsCreated: 0,
      proposalRate: 0,
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'healthy',
      action: 'keep-routing',
      sameTierOnly: true,
      minAttempts: 3,
      lowYieldRate: 0.2,
      diagnosticAttempts: 3,
      proposalsCreated: 1,
      generatedRepairAttempts: {
        attempts: 1,
        proposalsCreated: 1,
        noProposal: 0,
        proposalRate: 1,
        captureRepairs: 1,
        diagnosticReslices: 0,
        proposalRepairs: 0,
      },
      primaryCandidate: {
        scope: 'fleet',
        key: 'fleet',
        diagnosticAttempts: 3,
        proposalsCreated: 1,
      },
    });

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Dispatch yield:');
    expect(formatted).toContain('proposals 1/3');
    expect(formatted).toContain('shape:     no-diff 1, gate/capture 1, repairs 1, policy-off 0');
    expect(formatted).toContain('repair yield: capture 1 attempt; 1/1 converted (100%)');
    expect(formatted).toContain('diagnosis: healthy · fleet 1/3 33% · keep routing');
    expect(formatted).toContain('local-coder 0/2 0%');
    expect(formatted).toContain('codex 1/1 100%');
  });

  it('reports recent concurrent dispatch manifests from the append-only ledger', async () => {
    recordDispatchManifest({
      schemaVersion: 1,
      manifestId: 'dm-test-1',
      ts: '2026-07-10T00:00:00.000Z',
      machineId: 'machine-A',
      mode: 'concurrent',
      dryRun: false,
      claimedItemIds: ['item-a', 'item-b', 'item-c'],
      assignments: [
        {
          itemId: 'item-a',
          source: 'todo',
          repo: '/repo/a',
          title: 'First task',
          backend: 'codex',
        },
        {
          itemId: 'item-b',
          source: 'todo',
          repo: '/repo/a',
          title: 'Second task',
          backend: 'codex',
        },
      ],
      unassigned: [{ itemId: 'item-c', reason: 'no-slots' }],
      slots: { codex: 2 },
      backendCounts: { codex: 2 },
      resourceSnapshotAt: '2026-07-10T00:00:00.000Z',
      counts: { claimed: 3, assigned: 2, unassigned: 1 },
    });

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchManifests).toMatchObject({
      events: 1,
      latestAt: '2026-07-10T00:00:00.000Z',
      assigned: 2,
      unassigned: 1,
      byBackend: [{ backend: 'codex', assignments: 2 }],
    });
    expect(s.dispatchManifests?.recent[0]).toMatchObject({
      manifestId: 'dm-test-1',
      assigned: 2,
      unassigned: 1,
      backends: { codex: 2 },
    });

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('manifests: 1 event(s), assigned 2, unassigned 1');
    expect(formatted).toContain('manifest backends: codex:2');
  });

  it('reports durable global workspace action telemetry from the append-only ledger', async () => {
    const now = new Date().toISOString();
    const repo = join(tmpHome, 'repo-a');
    const staleFixtureRepo = join(tmpHome, 'deleted-fixture');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
    writeFileSync(join(tmpHome, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo, staleFixtureRepo] }), 'utf8');
    const genomeDir = join(tmpHome, '.ashlr', 'genome');
    mkdirSync(genomeDir, { recursive: true });
    writeFileSync(
      join(genomeDir, 'hub.jsonl'),
      [
        {
          id: 'ctx-one',
          project: 'ashlr-hub',
          source: 'hub',
          title: 'Context telemetry',
          text: 'Fleet context efficiency reads workspace attention without storing raw prompts.',
          tags: ['context'],
          ts: now,
        },
        {
          id: 'ctx-two',
          project: 'phantom-secrets',
          source: 'hub',
          title: 'Phantom boundary',
          text: 'Phantom owns real keys while Hub consumes only metadata and scrubbed outputs.',
          tags: ['phantom'],
          ts: now,
        },
      ].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    const baseEvent: AgentActionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'daemon:dispatch',
      summary: 'local-coder empty-diff for Improve proposal yield',
      repo,
      itemId: 'item-a',
      source: 'todo',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      reason: 'agent returned no diff',
      spentUsd: 0.001,
    };
    recordAgentAction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', kind: 'tick', outcome: 'ok', action: 'daemon:tick', summary: 'tick ok', backend: null, repo: undefined },
      {
        ...baseEvent,
        itemId: 'item-c',
        outcome: 'proposal-created',
        action: 'daemon:dispatch',
        proposalId: 'prop-c',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        summary: 'codex proposal-created for Improve proposal yield',
      },
      {
        ...baseEvent,
        repo: staleFixtureRepo,
        itemId: 'item-stale',
        outcome: 'failed',
        action: 'daemon:dispatch',
        summary: 'stale fixture repo should not shape fleet workspace attention',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.workspace).toMatchObject({
      eventCount: 3,
      proposalEvents: 1,
      noProposalEvents: 1,
      diagnosticNoProposalEvents: 1,
      policySuppressedEvents: 0,
      diagnosticProposalRate: 0.5,
      diagnosticNoProposalRate: 0.5,
      activeMachines: ['m49'],
    });
    expect(s.workspace?.byAction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'dispatch', count: 2 }),
        expect.objectContaining({ key: 'tick', count: 1 }),
      ]),
    );
    expect(s.workspace?.recentActions[0]).toMatchObject({ proposalId: 'prop-c' });
    expect(s.contextEfficiency).toMatchObject({
      posture: 'watch',
      signals: {
        workspaceEvents: 3,
        activeRepos: 1,
        memoryEntries: 2,
        hubMemoryEntries: 2,
        retrievalPosture: 'available',
        reflectionEvents: 0,
        proposalRate: null,
      },
      risks: [
        expect.objectContaining({ id: 'reflection-missing', severity: 'low' }),
      ],
    });
    expect(s.contextEfficiency?.recommendations[0]).toContain('compression');

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Global workspace:');
    expect(formatted).toContain('outcomes:  proposals 1, no-proposal 1, policy-suppressed 0');
    expect(formatted).toContain('learning:  diagnostic proposal rate 50%');
    expect(formatted).toContain('events:    3');
    expect(formatted).toContain('proposals 1, no-proposal 1');
    expect(formatted).toContain('Context efficiency:');
    expect(formatted).toContain('posture:   watch');
    expect(formatted).toContain('memory:    2 entries');
  });

  it('reports attempt coverage from joined metadata-only ledgers', async () => {
    const now = new Date().toISOString();
    const repo = join(tmpHome, 'repo-attempts');
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    const itemId = 'repo-attempts:goal:coverage';
    const proposal = createSignedProposal(cfg, {
      title: 'Attempt coverage docs change',
      diff: docsDiff('attempt coverage'),
      verifyResult: { passed: true, source: 'manual' },
    });

    writeRunningDaemon(tmpHome, [], now);
    writeBacklogSnapshot(tmpHome, repo, [], now);
    recordDispatchProduction({
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId,
      source: 'goal',
      repo,
      title: 'Attempt coverage docs change',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      assignedBy: 'daemon',
      routeReason: 'resource-aware codex route',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: proposal.id,
      runId: 'run-attempt-coverage',
      trajectoryId: 'traj-attempt-coverage',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        assignedBy: 'daemon',
        reason: 'resource-aware codex route',
        routerPolicyVersion: ROUTER_POLICY_VERSION,
      },
      runEventSummary: {
        runId: 'run-attempt-coverage',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: proposal.id,
        actionCounts: { proposalCreated: 1, diffFiles: 1 },
      },
      routerPolicyVersion: ROUTER_POLICY_VERSION,
      learningEpoch: now.slice(0, 10),
      spentUsd: 0.002,
      reason: 'proposal filed',
      basis: 'run-proposal-outcome',
    });
    recordAgentAction({
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'proposal-created',
      action: 'daemon:dispatch',
      summary: 'codex proposal-created for Attempt coverage docs change',
      repo,
      itemId,
      source: 'goal',
      proposalId: proposal.id,
      runId: 'run-attempt-coverage',
      trajectoryId: 'traj-attempt-coverage',
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      reason: 'proposal filed',
      spentUsd: 0.002,
    });
    recordDecision({
      ts: now,
      proposalId: proposal.id,
      workItemId: itemId,
      runId: 'run-attempt-coverage',
      trajectoryId: 'traj-attempt-coverage',
      action: 'judged',
      verdict: 'ship',
      reason: 'metadata-only approval',
    });
    expect(persistAutonomyEvidencePack(makeEvidencePack(proposal.id, now))).toBe(true);
    recordOutcome(itemId, 'diff', now);
    recordSkillUseEvent({
      schemaVersion: 1,
      eventId: 'skill-use:attempt-coverage-private',
      ts: now,
      skillId: 'skill.private.attempt-coverage',
      skillRevision: 1,
      contentHash: 'a'.repeat(64),
      selectedAt: now,
      skillPolicyVersion: 'verified-skills-v1',
      mode: 'shadow',
      stage: 'selected',
      outcome: 'unknown',
      rank: 0,
      score: 1,
      reason: 'private observe-only selection',
      proposalId: proposal.id,
      runId: 'run-attempt-coverage',
      trajectoryId: 'traj-attempt-coverage',
    });
    expect(readSkillUseEvents({ limit: 10 })).toHaveLength(1);

    const s = await buildFleetStatus(cfg);

    expect(s.attemptCoverage).toMatchObject({
      windowHours: 24,
      attempts: 1,
      coverage: {
        agentAction: { count: 1, rate: 1 },
        outcomeRecord: { count: 1, rate: 1 },
        decision: { count: 1, rate: 1 },
        evidence: { count: 1, rate: 1 },
        worked: { count: 1, rate: 1 },
      },
      causalCoverage: {
        trajectoryId: { count: 1, rate: 1 },
        routeSnapshot: { count: 1, rate: 1 },
        runEventSummary: { count: 1, rate: 1 },
        routerPolicyVersion: { count: 1, rate: 1 },
        currentRouterPolicyVersion: { count: 1, rate: 1 },
        learningEpoch: { count: 1, rate: 1 },
        currentLearningEpoch: { count: 1, rate: 1 },
        labelAuthoritative: { count: 1, rate: 1 },
        currentAuthoritativeLabel: { count: 1, rate: 1 },
      },
      causalWeak: {
        weak: false,
      },
      production: {
        attempts: 1,
        proposalCreated: 1,
        policySuppressed: 0,
        diagnosticAttempts: 1,
        diagnosticNoProposal: 0,
        diagnosticProposalRate: 1,
        diagnosticNoProposalRate: 0,
      },
      gaps: [],
    });
    expect(s.attemptCoverage?.recent[0]).toMatchObject({
      ref: expect.stringMatching(/^attempt:[a-f0-9]{12}$/),
      outcome: 'proposal-created',
      backend: 'codex',
      learningKind: 'proposal-created',
      diagnosticAttempt: true,
      policySuppressed: false,
      coverage: {
        agentAction: true,
        outcomeRecord: true,
        decision: true,
        evidence: true,
        worked: true,
      },
      causalCoverage: {
        trajectoryId: true,
        routeSnapshot: true,
        runEventSummary: true,
        routerPolicyVersion: true,
        currentRouterPolicyVersion: true,
        learningEpoch: true,
        currentLearningEpoch: true,
        labelAuthoritative: true,
        currentAuthoritativeLabel: true,
      },
    });
    expect(s.attemptCoverage?.recent[0]).not.toHaveProperty('repo');
    expect(s.attemptCoverage?.recent[0]).not.toHaveProperty('itemId');
    expect(s.attemptCoverage?.recent[0]).not.toHaveProperty('proposalId');
    expect(s.trajectoryLearning).toMatchObject({
      windowHours: 24,
      trajectories: 1,
      terminalOutcomes: {
        pending: 1,
      },
      coverage: {
        dispatch: { count: 1, rate: 1 },
        proposal: { count: 1, rate: 1 },
        evidence: { count: 1, rate: 1 },
        decision: { count: 1, rate: 1 },
        agentAction: { count: 1, rate: 1 },
      },
      routeSpine: {
        dispatchToDecision: { count: 1, rate: 1 },
        dispatchToEvidence: { count: 1, rate: 1 },
        dispatchToMerge: { count: 0, rate: 0 },
      },
      gaps: [],
      skillObservation: {
        sampleState: 'insufficient-sample',
      },
    });
    expect(s.trajectoryLearning?.coverage).not.toHaveProperty('skillUse');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('joined');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('unjoined');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('conflicting');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('observedTrajectoryCoverage');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('modeCounts');
    expect(s.trajectoryLearning?.skillObservation).not.toHaveProperty('stageCounts');
    expect(s.trajectoryLearning?.recent[0]).toMatchObject({
      ref: expect.stringMatching(/^trajectory:[a-f0-9]{12}$/),
      terminalOutcome: 'pending',
      backend: 'codex',
      source: 'goal',
      coverage: {
        dispatch: true,
        proposal: true,
        evidence: true,
        decision: true,
        agentAction: true,
      },
    });
    expect(s.trajectoryLearning?.recent[0]?.coverage).not.toHaveProperty('skillUse');
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(repo);
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(itemId);
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(proposal.id);
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Attempt coverage:');
    expect(formatted).toContain('attempts:  1 in 24h');
    expect(formatted).toContain('learning:  diagnostic 1/1 (100%), no-proposal 0, policy-suppressed 0');
    expect(formatted).toContain('joins:     actions 1 (100%), worked 1 (100%), decisions 1 (100%), evidence 1 (100%)');
    expect(formatted).toContain('metadata:  trajectory 1 (100%), route 1 (100%), run 1 (100%)');
    expect(formatted).toContain('policy:    version 1 (100%), current 1 (100%), epoch 1 (100%), current epoch 1 (100%)');
    expect(formatted).toContain('labels:    authoritative 1 (100%), current 1 (100%)');
    expect(formatted).toContain('Trajectory learning:');
    expect(formatted).toContain('trajectories: 1 in 24h');
    expect(formatted).toContain('outcomes:     merged 0, pending 1, no-proposal 0, failed 0');
    expect(formatted).toContain('spine:        dispatch->decision 1 (100%), dispatch->evidence 1 (100%), dispatch->merge 0 (0%)');
    expect(formatted).toContain('coverage:     dispatch 1 (100%), proposal 1 (100%), evidence 1 (100%), decision 1 (100%)');
    expect(formatted).toContain('skill observations:');
    expect(formatted).not.toContain('skill shadow:');
  });

  it('promotes weak causal attempt coverage into next actions', async () => {
    const now = new Date().toISOString();
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo-causal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeBacklogSnapshot(tmpHome, repo, [], now);
    recordDispatchProduction([
      {
        schemaVersion: 1,
        ts: now,
        machineId: 'm49',
        itemId: 'item-causal-a',
        source: 'goal',
        repo,
        title: 'Causal coverage A',
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        assignedBy: 'daemon',
        routeReason: 'local route missing snapshot',
        outcome: 'empty-diff',
        proposalCreated: false,
        runId: 'run-causal-a',
        trajectoryId: 'traj-causal-a',
        spentUsd: 0,
        reason: 'engine completed without file changes',
        basis: 'unknown',
      },
      {
        schemaVersion: 1,
        ts: now,
        machineId: 'm49',
        itemId: 'item-causal-b',
        source: 'goal',
        repo,
        title: 'Causal coverage B',
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        assignedBy: 'daemon',
        routeReason: 'local route missing snapshot',
        outcome: 'empty-diff',
        proposalCreated: false,
        runId: 'run-causal-b',
        trajectoryId: 'traj-causal-b',
        spentUsd: 0,
        reason: 'engine completed without file changes',
        basis: 'unknown',
      },
      {
        schemaVersion: 1,
        ts: now,
        machineId: 'm49',
        itemId: 'item-causal-c',
        source: 'goal',
        repo,
        title: 'Causal coverage C',
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        assignedBy: 'daemon',
        routeReason: 'local route missing snapshot',
        outcome: 'empty-diff',
        proposalCreated: false,
        runId: 'run-causal-c',
        trajectoryId: 'traj-causal-c',
        spentUsd: 0,
        reason: 'engine completed without file changes',
        basis: 'unknown',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());
    const action = s.nextActions?.find((candidate) => candidate.id === 'inspect-attempt-causal-coverage');

    expect(s.attemptCoverage?.causalWeak).toMatchObject({
      weak: true,
      reasons: expect.arrayContaining([
        expect.objectContaining({ kind: 'routeSnapshot', count: 0, rate: 0 }),
        expect.objectContaining({ kind: 'runEventSummary', count: 0, rate: 0 }),
      ]),
    });
    expect(s.attemptCoverage?.causalGapDiagnostics).toMatchObject({
      blockedCurrentLabels: 0,
      causes: expect.arrayContaining([
        expect.objectContaining({ cause: 'missing-route-snapshot', count: 3 }),
        expect.objectContaining({ cause: 'missing-run-summary', count: 3 }),
      ]),
      byLearningSource: [expect.objectContaining({ key: 'daemon-dispatch', count: 3 })],
      byLabelBasis: [expect.objectContaining({ key: 'dispatch-outcome', count: 3 })],
    });
    expect(action).toMatchObject({
      priority: 'medium',
      label: 'Inspect causal coverage',
      detail: expect.stringContaining('top cause: missing-route-snapshot on 3 attempts'),
      commands: expect.arrayContaining([
        expect.objectContaining({
          label: 'Evaluate attention',
          argv: ['ashlr', 'eval', 'attention', '--json'],
          safety: 'read-only',
        }),
      ]),
    });
    expect(s.nextActions?.[0]?.id).toBe('inspect-attempt-causal-coverage');
    expect(s.missionBrief).toMatchObject({
      directive: 'Inspect causal learning coverage',
      action: { id: 'inspect-attempt-causal-coverage' },
    });
  });

  it('does not report healthy context efficiency when genome health is unavailable', () => {
    const now = new Date().toISOString();
    const status = buildContextEfficiencyStatus(
      {
        workspace: {
          generatedAt: now,
          windowHours: 24,
          eventCount: 2,
          latestAt: now,
          activeMachines: ['m49'],
          spendUsd: 0,
          proposalEvents: 0,
          noProposalEvents: 0,
          repoEventCount: 2,
          repoDistinctCount: 1,
          topRepoCount: 2,
          attention: [],
          byAction: [{ key: 'reflection', count: 1 }],
          byOutcome: [],
          byRepo: [{ key: '/repo/a', count: 2 }],
          byBackend: [],
          entropy: { action: 0, outcome: 0, repo: 0 },
          recentActions: [],
        },
      },
      undefined,
      now,
      24 * 60 * 60 * 1000,
    );

    expect(status.posture).toBe('watch');
    expect(status.signals.retrievalPosture).toBe('unknown');
    expect(status.risks).toEqual([
      expect.objectContaining({ id: 'memory-unavailable', severity: 'medium' }),
    ]);
  });

  it('promotes degraded context efficiency into next actions', async () => {
    const now = new Date().toISOString();
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo-a');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeRunningDaemon(tmpHome, [], now);
    recordAgentAction({
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'daemon:dispatch',
      summary: 'local-coder empty-diff for Improve context',
      repo,
      itemId: 'item-a',
      source: 'todo',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      reason: 'agent returned no diff',
    });

    const s = await buildFleetStatus(baseConfig());

    expect(s.contextEfficiency).toMatchObject({
      posture: 'strained',
      risks: [
        expect.objectContaining({ id: 'memory-empty', severity: 'high' }),
        expect.objectContaining({ id: 'reflection-missing', severity: 'low' }),
      ],
    });
    expect(s.nextActions).toContainEqual(expect.objectContaining({
      id: 'improve-context-efficiency',
      priority: 'medium',
      label: 'Improve context efficiency',
      detail: expect.stringContaining('No hub genome memories'),
    }));
    const action = s.nextActions?.find((candidate) => candidate.id === 'improve-context-efficiency');
    expect(action?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Run reflection',
        argv: ['ashlr', 'reflect', 'playbooks', '--persist'],
        safety: 'control-plane',
      }),
      expect.objectContaining({
        label: 'Evaluate attention',
        argv: ['ashlr', 'eval', 'attention', '--json'],
        safety: 'read-only',
      }),
    ]));
    expect(action?.commands?.map((command) => command.label)).not.toContain('Drain reslice queue');
    expect(s.missionBrief).toMatchObject({
      directive: 'Run context reflection',
      action: {
        id: 'improve-context-efficiency',
      },
    });
  });

  it('adds a daemon monitor command to context-efficiency action when generated reslices are queued', async () => {
    const now = new Date().toISOString();
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo-a');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(
      join(ashlrDir, 'self-heal-queue.json'),
      JSON.stringify([
        {
          id: 'repo:proposal-repair-nodiff:123456789abc',
          repo,
          source: 'self',
          title: 'Reslice no-diff dispatch for repo item repo:goal:one',
          detail:
            'Diagnostic reslice: a dispatch completed without file changes.\n' +
            'Original work item: repo:goal:one\n' +
            'Dispatch outcome: empty-diff\n' +
            'Action: reslice the work into a smaller concrete edit.',
          value: 5,
          effort: 1,
          score: 5,
          tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
          ts: now,
        },
      ]),
      'utf8',
    );
    recordAgentAction({
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      actor: 'daemon',
      kind: 'dispatch',
      outcome: 'no-proposal',
      action: 'daemon:dispatch',
      summary: 'local-coder empty-diff for Improve context',
      repo,
      itemId: 'item-a',
      source: 'todo',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      reason: 'agent returned no diff',
    });

    const s = await buildFleetStatus(baseConfig());
    const action = s.nextActions?.find((candidate) => candidate.id === 'improve-context-efficiency');

    expect(s.queue.generatedWork).toMatchObject({
      diagnosticReslices: 1,
      proposalRepair: 1,
    });
    expect(action?.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        label: 'Inspect daemon status',
        argv: ['ashlr', 'daemon', 'status'],
        safety: 'read-only',
      }),
    ]));
    expect(action?.commands?.map((command) => command.label)).not.toContain('Drain reslice queue');
  });

  it('uses the reflection mission directive when low yield is the primary action', async () => {
    const now = new Date().toISOString();
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo-a');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeRunningDaemon(tmpHome, [
      {
        ts: now,
        itemsConsidered: 3,
        proposalsCreated: 0,
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        reason: 'engine completed without file changes',
        spentUsd: 0,
        proposalProduction: {
          selected: 3,
          claimed: 3,
          dispatched: 3,
          skipped: 0,
          errors: 0,
          proposalsCreated: 0,
          noProposalDispatches: 3,
          reasons: [
            { reason: 'empty-diff: engine completed without file changes', count: 3 },
          ],
        },
        dispatches: [
          {
            itemId: 'item-a',
            title: 'Improve context A',
            repo,
            source: 'todo',
            backend: 'local-coder',
            tier: 'mid',
            model: 'qwen',
            assignedBy: 'router',
            reason: 'engine completed without file changes',
            dispatched: true,
            spentUsd: 0,
            production: { outcome: 'empty-diff', reason: 'engine completed without file changes' },
          },
          {
            itemId: 'item-b',
            title: 'Improve context B',
            repo,
            source: 'todo',
            backend: 'local-coder',
            tier: 'mid',
            model: 'qwen',
            assignedBy: 'router',
            reason: 'engine completed without file changes',
            dispatched: true,
            spentUsd: 0,
            production: { outcome: 'empty-diff', reason: 'engine completed without file changes' },
          },
          {
            itemId: 'item-c',
            title: 'Improve context C',
            repo,
            source: 'todo',
            backend: 'local-coder',
            tier: 'mid',
            model: 'qwen',
            assignedBy: 'router',
            reason: 'engine completed without file changes',
            dispatched: true,
            spentUsd: 0,
            production: { outcome: 'empty-diff', reason: 'engine completed without file changes' },
          },
        ],
      },
    ], now);

    const s = await buildFleetStatus(baseConfig());
    const action = s.nextActions?.find((candidate) => candidate.id === 'improve-context-efficiency');

    expect(action?.commands?.map((command) => command.label)).not.toContain('Drain reslice queue');
    expect(action?.commands?.map((command) => command.label)).toContain('Inspect daemon status');
    expect(s.missionBrief).toMatchObject({
      directive: 'Run context reflection',
      action: {
        id: 'improve-context-efficiency',
      },
    });
  });

  it('promotes poor durable dispatch yield into next actions', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [
          {
            id: 'repo:goal:yield',
            repo,
            source: 'goal',
            title: 'Improve low-yield dispatch',
            detail: 'Investigate repeated no-proposal outcomes.',
            value: 5,
            effort: 1,
            score: 5,
            tags: ['yield'],
            ts: new Date().toISOString(),
          },
        ],
      }),
      'utf8',
    );
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-a',
      source: 'goal',
      repo,
      title: 'Improve low-yield dispatch',
      backend: 'nim',
      tier: 'mid',
      model: 'meta/llama-3.1-70b-instruct',
      assignedBy: 'daemon',
      routeReason: 'nim-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-b', outcome: 'gate-blocked', reason: 'completeness gate blocked proposal' },
      { ...baseEvent, itemId: 'item-c', outcome: 'engine-failed', reason: 'engine exited without diff' },
    ]);

    const cfg = withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
      allowedBackends: ['builtin', 'nim', 'kimi'],
      resourceOverrides: {
        nim: { availability: 'open', reason: 'nim test open' },
        kimi: { availability: 'open', reason: 'kimi test open' },
      },
    });
    const s = await withTemporaryEnv(
      {
        NVIDIA_NIM_API_KEY: 'test-nim-key',
        MOONSHOT_API_KEY: 'test-kimi-key',
      },
      () => buildFleetStatus(cfg),
    );

    expect(s.dispatchProduction).toMatchObject({
      attempts: 3,
      proposalsCreated: 0,
      proposalRate: 0,
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      action: 'route-same-tier-alternative',
      sameTierOnly: true,
      diagnosticAttempts: 3,
      proposalsCreated: 0,
      policyDisabled: 0,
      primaryCandidate: {
        scope: 'backend-source',
        backend: 'nim',
        source: 'goal',
        diagnosticAttempts: 3,
        proposalsCreated: 0,
        verdict: 'actionable',
        action: 'route-same-tier-alternative',
        sameTierOnly: true,
        topReason: 'agent returned no diff',
      },
    });
    expect(s.dispatchYieldDiagnostics?.recommendation).toContain('same-tier alternatives only');
    expect(s.dispatchYieldDiagnostics?.recommendation).toContain('avoid tier escalation');
    expect(s.nextActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'inspect-dispatch-yield',
          priority: 'medium',
          label: 'Inspect dispatch yield',
          detail: expect.stringContaining('nim/goal proposal yield 0/3 (0%)'),
          target: 'nim',
        }),
      ]),
    );
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('top reason: agent returned no diff');
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('shape: no-diff 1, gate/capture 1, repairs 0, policy-off 0');
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('sample-gated action: same-tier reroute');
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.commands)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          label: 'Inspect fleet status',
          argv: ['ashlr', 'fleet', 'status', '--json'],
          safety: 'read-only',
        }),
      ]));
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];
    expect(actionIds[0]).toBe('inspect-dispatch-yield');
    expect(actionIds.indexOf('inspect-dispatch-yield')).toBeLessThan(actionIds.indexOf('build-backlog'));
    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'degraded',
      topBlocker: {
        id: 'dispatch-yield-actionable',
        source: 'queue',
        detail: expect.stringContaining('nim/goal proposal yield 0/3 (0%)'),
      },
      primaryAction: {
        id: 'inspect-dispatch-yield',
      },
    });
    expect(s.missionBrief).toMatchObject({
      directive: 'Recover dispatch yield',
      blocker: {
        id: 'dispatch-yield-actionable',
      },
      action: {
        id: 'inspect-dispatch-yield',
      },
    });

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('[medium] Inspect dispatch yield [nim]');
    expect(formatted).toContain('cmd: Inspect fleet status: ashlr fleet status --json (read-only)');
    expect(formatted).toContain('nim/goal proposal yield 0/3 (0%)');
    expect(formatted).toContain('diagnosis: actionable · nim/goal 0/3 0% · same-tier reroute');
    expect(formatted).toContain('shape:     no-diff 1, gate/capture 1, repairs 0, policy-off 0');
  });

  it('does not recommend same-tier reroute when no open installed alternative is available', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [makeBacklogItem(repo, 'repo:goal:no-alt', 'Improve no-alt yield', 5)],
      }),
      'utf8',
    );
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-no-alt-a',
      source: 'goal',
      repo,
      title: 'Improve no-alt yield',
      backend: 'nim',
      tier: 'mid',
      model: 'meta/llama-3.1-70b-instruct',
      assignedBy: 'daemon',
      routeReason: 'nim-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-no-alt-b' },
      { ...baseEvent, itemId: 'item-no-alt-c' },
    ]);

    const cfg = withFoundry({
      allowedBackends: ['builtin', 'nim', 'kimi'],
      resourceOverrides: {
        nim: { availability: 'open', reason: 'nim test open' },
        kimi: { availability: 'throttled', reason: 'kimi test throttled' },
      },
    });
    const s = await withTemporaryEnv(
      {
        NVIDIA_NIM_API_KEY: 'test-nim-key',
        MOONSHOT_API_KEY: 'test-kimi-key',
      },
      () => buildFleetStatus(cfg),
    );

    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      action: 'tighten-context-or-reslice',
      actionReason: 'no open installed same-tier alternative is available',
      primaryCandidate: {
        scope: 'backend-source',
        backend: 'nim',
        source: 'goal',
        diagnosticAttempts: 3,
        proposalsCreated: 0,
        verdict: 'actionable',
        action: 'tighten-context-or-reslice',
        actionReason: 'no open installed same-tier alternative is available',
      },
    });
    expect(s.dispatchYieldDiagnostics?.recommendation)
      .toContain('no open installed same-tier alternative is available');
    const action = s.nextActions?.find((candidate) => candidate.id === 'inspect-dispatch-yield');
    expect(action?.detail).toContain('sample-gated action: tighten context/reslice');
    expect(action?.detail).toContain('action reason: no open installed same-tier alternative is available');
    expect(formatFleetStatus(s)).toContain('diagnosis: actionable · nim/goal 0/3 0% · tighten context/reslice');
  });

  it('promotes eligible capture repairs ahead of dispatch-yield inspection', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: now,
        repos: [repo],
        items: [
          makeBacklogItem(
            repo,
            'repo:proposal-repair-capture:abcdef123456',
            'Repair dispatch capture failure for repo item repo:self:gate',
            9,
            'self',
            ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
          ),
        ],
      }),
      'utf8',
    );
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-capture-repair-a',
      source: 'self',
      repo,
      title: 'Repair capture failure',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'gate-blocked',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'tests: still failing after 2 attempt(s)',
      diffFiles: 1,
      diffLines: 12,
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-capture-repair-b' },
      { ...baseEvent, itemId: 'item-capture-repair-c' },
      {
        ...baseEvent,
        itemId: 'repo:proposal-repair-capture:abcdef123456',
        title: 'Repair dispatch capture failure for repo item repo:self:gate',
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'prop-capture-repair',
        reason: 'proposal filed',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());
    const actionIds = s.nextActions?.map((candidate) => candidate.id) ?? [];
    const repairAction = s.nextActions?.find((candidate) => candidate.id === 'process-capture-repairs');
    const yieldAction = s.nextActions?.find((candidate) => candidate.id === 'inspect-dispatch-yield');

    expect(s.queue.generatedWork).toMatchObject({
      captureRepairs: 1,
      diagnosticReslices: 0,
      proposalRepair: 1,
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      action: 'tighten-context-or-reslice',
      primaryCandidate: {
        backend: 'local-coder',
        source: 'self',
      },
    });
    expect(actionIds[0]).toBe('process-capture-repairs');
    expect(actionIds).toContain('inspect-dispatch-yield');
    expect(repairAction).toMatchObject({
      priority: 'high',
      label: 'Monitor capture repairs',
      detail: expect.stringContaining('1 capture repair item(s) are eligible'),
      target: repo,
      commands: [
        expect.objectContaining({
          label: 'Inspect fleet status',
          argv: ['ashlr', 'fleet', 'status', '--json'],
          safety: 'read-only',
        }),
        expect.objectContaining({
          label: 'Inspect daemon status',
          argv: ['ashlr', 'daemon', 'status'],
          safety: 'read-only',
        }),
      ],
    });
    expect(repairAction?.detail).toContain('sample-gated action: tighten context/reslice');
    expect(repairAction?.detail)
      .toContain('repair recovery: generated repairs 1/1 converted (100%; capture 1)');
    expect(repairAction?.detail).toContain('queued repair coverage: 1 capture repair queued');
    expect(repairAction?.detail).toContain('First: Repair dispatch capture failure for repo item repo:self:gate.');
    expect(yieldAction?.detail).toContain('queued repair coverage: 1 capture repair queued');
    expect(yieldAction?.detail)
      .toContain('repair recovery: generated repairs 1/1 converted (100%; capture 1)');
    expect(s.autonomousShipReadiness).toMatchObject({
      primaryAction: {
        id: 'process-capture-repairs',
      },
    });
    expect(s.missionBrief).toMatchObject({
      directive: 'Monitor capture repairs',
      action: {
        id: 'process-capture-repairs',
      },
    });
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('[high] Monitor capture repairs');
    expect(formatted).toContain('cmd: Inspect fleet status: ashlr fleet status --json (read-only)');
    expect(repairAction?.commands?.map((command) => command.safety)).toEqual(['read-only', 'read-only']);
  });

  it('treats healthy generated repair conversion as active recovery', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [
      makeBacklogItem(
        repo,
        'repo:proposal-repair-capture:fedcba987654',
        'Repair dispatch capture failure for repo item repo:self:active',
        9,
        'self',
        ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
      ),
    ], now);
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'local-fail-a',
      source: 'self',
      repo,
      title: 'Local no-diff sample',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    };
    const generatedRepairEvents: DispatchProductionEvent[] = Array.from({ length: 5 }, (_, index) => ({
      ...baseEvent,
      itemId: `repo:proposal-repair-capture:abc123def45${index}`,
      title: `Repair dispatch capture failure for repo item repo:self:active-${index}`,
      backend: 'codex',
      tier: 'frontier',
      model: 'gpt-5.5',
      outcome: index === 4 ? 'empty-diff' : 'proposal-created',
      proposalCreated: index !== 4,
      proposalId: index === 4 ? undefined : `prop-repair-${index}`,
      reason: index === 4 ? 'engine "codex" completed without file changes' : 'proposal filed',
    }));
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'local-fail-b' },
      { ...baseEvent, itemId: 'local-fail-c' },
      { ...baseEvent, itemId: 'local-fail-d' },
      ...generatedRepairEvents,
    ]);

    const s = await buildFleetStatus(withFoundry({ autoMerge: { enabled: true, trustBasis: 'verification' } }));
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];

    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      primaryCandidate: {
        backend: 'local-coder',
        source: 'self',
        proposalsCreated: 0,
        diagnosticAttempts: 4,
      },
      generatedRepairAttempts: {
        attempts: 5,
        proposalsCreated: 4,
        noProposal: 1,
        proposalRate: 0.8,
        captureRepairs: 5,
      },
    });
    expect(s.autonomousShipReadiness?.topBlocker).toMatchObject({
      id: 'generated-repair-recovery-active',
      severity: 'low',
      detail: expect.stringContaining('generated repairs 4/5 converted (80%; capture 5)'),
    });
    expect(s.autonomousShipReadiness?.topBlocker?.id).not.toBe('dispatch-yield-actionable');
    expect(actionIds[0]).toBe('process-capture-repairs');
    expect(actionIds).not.toContain('inspect-dispatch-yield');
    expect(s.missionBrief).toMatchObject({
      blocker: { id: 'generated-repair-recovery-active' },
      action: { id: 'process-capture-repairs' },
    });
  });

  it('does not promote capture repairs when queued repairs are cooling', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    const repair = makeBacklogItem(
      repo,
      'repo:proposal-repair-capture:cooling123456',
      'Repair dispatch capture failure for repo item repo:self:cooling',
      9,
      'self',
      ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
    );
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [repair, fresh], now);
    recordOutcome(repair.id, 'empty', now);
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-cooling-capture-a',
      source: 'self',
      repo,
      title: 'Repair capture failure',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'gate-blocked',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'tests: still failing after 2 attempt(s)',
      diffFiles: 1,
      diffLines: 12,
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-cooling-capture-b' },
      { ...baseEvent, itemId: 'item-cooling-capture-c' },
    ]);

    const s = await buildFleetStatus(baseConfig());
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];

    expect(s.queue.generatedWork).toMatchObject({
      captureRepairs: 1,
      proposalRepair: 1,
    });
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({
      id: fresh.id,
      title: fresh.title,
    });
    expect(actionIds).not.toContain('process-capture-repairs');
    expect(actionIds[0]).toBe('inspect-dispatch-yield');
  });

  it('shortens cooldown for trusted empty generated repairs when recovery is healthy', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    const repair = makeTrustedDiagnosticResliceItem(repo, '444444444444', 9);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [repair, fresh], now);
    seedHealthyRepairRecoveryEvents(repo, now);
    const localFailure: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'local-empty-a',
      source: 'self',
      repo,
      title: 'Local no-diff sample',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      localFailure,
      { ...localFailure, itemId: 'local-empty-b' },
      { ...localFailure, itemId: 'local-empty-c' },
    ]);
    recordOutcome(repair.id, 'empty', new Date(Date.now() - 31 * 60 * 1000).toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      primaryCandidate: {
        backend: 'local-coder',
        source: 'self',
      },
    });
    expect(s.queue.eligibleBacklogItems).toBe(2);
    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.next?.[0]).toMatchObject({
      id: repair.id,
      title: repair.title,
    });
    expect(s.nextActions?.map((action) => action.id)).toContain('drain-diagnostic-reslices');
  });

  it('keeps judged generated repairs on the full cooldown even when recovery is healthy', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    const repair = makeTrustedDiagnosticResliceItem(repo, '555555555555', 9);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [repair, fresh], now);
    seedHealthyRepairRecoveryEvents(repo, now);
    recordOutcome(repair.id, 'judged-decline', new Date(Date.now() - 31 * 60 * 1000).toISOString());

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({
      id: fresh.id,
      title: fresh.title,
    });
    expect(s.nextActions?.map((action) => action.id)).not.toContain('drain-diagnostic-reslices');
  });

  it('promotes queued no-diff diagnostic reslices ahead of dispatch-yield inspection', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: now,
        repos: [repo],
        items: [
          makeBacklogItem(
            repo,
            'repo:proposal-repair-nodiff:abcdef123456',
            'Reslice no-diff dispatch for repo item repo:goal:no-alt',
            9,
            'self',
            ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
          ),
        ],
      }),
      'utf8',
    );
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-reslice-a',
      source: 'goal',
      repo,
      title: 'Improve no-alt yield',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-reslice-b' },
      { ...baseEvent, itemId: 'item-reslice-c' },
    ]);

    const s = await buildFleetStatus(baseConfig());
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];
    const drainAction = s.nextActions?.find((candidate) => candidate.id === 'drain-diagnostic-reslices');

    expect(s.queue.generatedWork).toMatchObject({
      diagnosticReslices: 1,
      proposalRepair: 1,
      captureRepairs: 0,
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      action: 'tighten-context-or-reslice',
      primaryCandidate: {
        backend: 'local-coder',
        source: 'goal',
        diagnosticAttempts: 3,
      },
    });
    expect(actionIds[0]).toBe('drain-diagnostic-reslices');
    expect(actionIds).toContain('inspect-dispatch-yield');
    expect(drainAction).toMatchObject({
      priority: 'high',
      label: 'Monitor diagnostic auto-drain',
      detail: expect.stringContaining('1 diagnostic no-diff reslice item(s) are eligible'),
      commands: [
        expect.objectContaining({
          label: 'Inspect fleet status',
          argv: ['ashlr', 'fleet', 'status', '--json'],
          safety: 'read-only',
        }),
        expect.objectContaining({
          label: 'Inspect daemon status',
          argv: ['ashlr', 'daemon', 'status'],
          safety: 'read-only',
        }),
      ],
    });
    expect(drainAction?.detail).toContain('sample-gated action: tighten context/reslice');
    expect(drainAction?.detail).toContain('queued repair coverage: 1 no-diff reslice queued');
    expect(drainAction?.detail).toContain('First: Reslice no-diff dispatch for repo item repo:goal:no-alt.');
    expect(s.autonomousShipReadiness).toMatchObject({
      primaryAction: {
        id: 'drain-diagnostic-reslices',
      },
    });
    expect(s.missionBrief).toMatchObject({
      directive: 'Monitor diagnostic auto-drain',
      action: {
        id: 'drain-diagnostic-reslices',
      },
    });
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('[high] Monitor diagnostic auto-drain');
    expect(formatted).toContain('cmd: Inspect fleet status: ashlr fleet status --json (read-only)');
    expect(formatted).not.toContain('cmd: Drain diagnostic reslices: ashlr daemon start --once --drain diagnostic-reslices --limit 3');

    writeRunningDaemon(tmpHome, [
      {
        ts: now,
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'ok',
        drain: {
          mode: 'diagnostic-reslices',
          available: 1,
          selected: 0,
          limit: 3,
          stalled: true,
        },
      },
    ], now);
    const stalledStatus = await buildFleetStatus(baseConfig());
    const stalledDrainAction = stalledStatus.nextActions?.find((candidate) => candidate.id === 'drain-diagnostic-reslices');
    expect(stalledStatus.queue.generatedWork).toMatchObject({
      diagnosticReslices: 1,
      diagnosticResliceDrainStalled: true,
    });
    expect(stalledStatus.queue.diagnosticResliceDrain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 0,
      limit: 3,
      stalled: true,
      proposalsCreated: 0,
      noProposalDispatches: 0,
    });
    expect(stalledDrainAction?.detail).toContain('reslice-drain-stalled');
  });

  it('does not promote diagnostic drain when queued reslices are cooling', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    const reslice = makeBacklogItem(
      repo,
      'repo:proposal-repair-nodiff:cooling123456',
      'Reslice no-diff dispatch for repo item repo:goal:cooling',
      9,
      'self',
      ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
    );
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [reslice, fresh], now);
    recordOutcome(reslice.id, 'empty', now);
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-cooling-reslice-a',
      source: 'goal',
      repo,
      title: 'Improve no-alt yield',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-cooling-reslice-b' },
      { ...baseEvent, itemId: 'item-cooling-reslice-c' },
    ]);

    const s = await buildFleetStatus(baseConfig());
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];

    expect(s.queue.generatedWork).toMatchObject({
      diagnosticReslices: 1,
      proposalRepair: 1,
      captureRepairs: 0,
    });
    expect(s.queue.eligibleBacklogItems).toBe(1);
    expect(s.queue.cooldownItems).toBe(1);
    expect(s.queue.next?.[0]).toMatchObject({
      id: fresh.id,
      title: fresh.title,
    });
    expect(actionIds).not.toContain('drain-diagnostic-reslices');
    expect(actionIds[0]).toBe('inspect-dispatch-yield');
  });

  it('keeps verification failure repair ahead of diagnostic drain while merge gate is blocked', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: now,
        repos: [repo],
        items: [
          makeBacklogItem(
            repo,
            'repo:proposal-repair-nodiff:abcdef123456',
            'Reslice no-diff dispatch for repo item repo:goal:no-alt',
            9,
            'self',
            ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice'],
          ),
        ],
      }),
      'utf8',
    );
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Failed verify docs change',
      diff: docsDiff('failed verify with reslices'),
      verifyResult: { passed: false, failed: ['npm test'], source: 'auto-merge-preflight' },
    });
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-reslice-a',
      source: 'goal',
      repo,
      title: 'Improve no-alt yield',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local-coder bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'item-reslice-b' },
      { ...baseEvent, itemId: 'item-reslice-c' },
    ]);

    const s = await buildFleetStatus(cfg);
    const actionIds = s.nextActions?.map((action) => action.id) ?? [];

    expect(s.autoMergeReadiness).toMatchObject({
      knownVerificationFailed: 1,
      blocked: 1,
    });
    expect(actionIds[0]).toBe('repair-verification-failures');
    expect(actionIds).toContain('drain-diagnostic-reslices');
    const failureAction = s.nextActions?.find((action) => action.id === 'repair-verification-failures');
    expect(failureAction).toMatchObject({
      label: 'Drain failed proposals',
      commands: expect.arrayContaining([
        expect.objectContaining({
          label: 'Run merge maintenance',
          argv: ['ashlr', 'daemon', 'start', '--once'],
        }),
      ]),
    });
    expect(s.autonomousShipReadiness?.topBlocker).toMatchObject({
      id: 'verification-failed',
    });
    expect(s.autonomousShipReadiness?.primaryAction).toMatchObject({
      id: 'repair-verification-failures',
    });
    expect(s.missionBrief).toMatchObject({
      directive: 'Drain failed proposal blockers',
      operatingMode: 'verify-only',
      blocker: { id: 'verification-failed' },
      action: { id: 'repair-verification-failures' },
    });
  });

  it('surfaces latest diagnostic reslice drain result even after queued generated work is gone', async () => {
    const now = new Date().toISOString();
    writeRunningDaemon(tmpHome, [
      {
        ts: now,
        itemsConsidered: 2,
        proposalsCreated: 1,
        spentUsd: 0.02,
        reason: 'ok',
        drain: {
          mode: 'diagnostic-reslices',
          available: 5,
          selected: 2,
          selectedItemIds: ['reslice-a', 'reslice-b'],
          limit: 3,
          capped: true,
          automatic: true,
        },
        proposalProduction: {
          selected: 2,
          claimed: 2,
          dispatched: 2,
          skipped: 0,
          errors: 0,
          proposalsCreated: 1,
          noProposalDispatches: 1,
          reasons: [{ reason: 'proposal-created', count: 1 }],
        },
      },
    ], now);

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.generatedWork).toBeUndefined();
    expect(s.queue.diagnosticResliceDrain).toMatchObject({
      mode: 'diagnostic-reslices',
      latestAt: now,
      available: 5,
      selected: 2,
      selectedItemIds: ['reslice-a', 'reslice-b'],
      limit: 3,
      capped: true,
      automatic: true,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 1,
      noProposalDispatches: 1,
      topReasons: [{ reason: 'proposal-created', count: 1 }],
    });
    expect(formatFleetStatus(s)).toContain('diag drain:    selected 2/3, available 5, proposals 1, no-proposal 1 (auto, capped)');
  });

  it('excludes proposal-disabled dispatch-production from weak-yield next action', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5)],
      }),
      'utf8',
    );
    const now = new Date().toISOString();
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now,
      machineId: 'm49',
      itemId: 'item-a',
      source: 'goal',
      repo,
      title: 'Improve low-yield dispatch',
      backend: 'codex',
      tier: 'frontier',
      assignedBy: 'daemon',
      routeReason: 'frontier route',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      spentUsd: 0,
      reason: 'proposal filing disabled for this sandboxed attempt',
      runEventSummary: {
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: { proposalDisabled: 1 },
      },
      basis: 'run-proposal-outcome',
    };
    const disabled = Array.from({ length: 16 }, (_, index) => ({
      ...baseEvent,
      itemId: `disabled-${index}`,
    }));
    const diagnostic = Array.from({ length: 3 }, (_, index) => ({
      ...baseEvent,
      itemId: `diagnostic-${index}`,
      backend: 'local-coder' as const,
      tier: 'mid' as const,
      routeReason: 'local route',
      outcome: 'empty-diff' as const,
      reason: 'agent returned no diff',
      spentUsd: 0.001,
      runEventSummary: {
        outcome: 'empty-diff',
        proposalCreated: false,
        actionCounts: { diffFiles: 0 },
      },
    }));
    recordDispatchProduction([...disabled, ...diagnostic]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction?.topReasons[0]?.reason).toContain('proposal filing disabled');
    expect(s.dispatchProduction?.diagnosticTopReasons?.[0]).toEqual({
      reason: 'agent returned no diff',
      count: 3,
    });
    expect(s.dispatchProduction?.byBackend[0]).toMatchObject({
      backend: 'codex',
      attempts: 16,
      outcomes: {
        proposalDisabled: 16,
      },
    });
    const action = s.nextActions?.find((candidate) => candidate.id === 'inspect-dispatch-yield');
    expect(action).toMatchObject({
      target: 'local-coder',
      detail: expect.stringContaining('local-coder/goal proposal yield 0/3 (0%)'),
    });
    expect(action?.detail).toContain('top reason: agent returned no diff');
    expect(action?.detail).toContain('shape: no-diff 3, gate/capture 0, repairs 0, policy-off 0');
    expect(action?.detail).not.toContain('proposal filing disabled');
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('reasons:   3x agent returned no diff');
    expect(formatted).not.toContain('reasons:   16x proposal filing disabled');
  });

  it('does not create weak-yield next action when every dispatch-production sample is proposal-disabled', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5)],
      }),
      'utf8',
    );
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      machineId: 'm49',
      itemId: 'disabled-a',
      source: 'goal',
      repo,
      title: 'Proposal filing disabled sample',
      backend: 'codex',
      tier: 'frontier',
      assignedBy: 'daemon',
      routeReason: 'frontier route',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      spentUsd: 0,
      reason: 'proposal filing disabled for this sandboxed attempt',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction(Array.from({ length: 4 }, (_, index) => ({
      ...baseEvent,
      itemId: `disabled-${index}`,
    })));

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      attempts: 4,
      proposalsCreated: 0,
      outcomes: {
        proposalDisabled: 4,
      },
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'policy-suppressed',
      action: 'keep-routing',
      sameTierOnly: true,
      diagnosticAttempts: 0,
      proposalsCreated: 0,
      policyDisabled: 4,
      primaryCandidate: {
        scope: 'fleet',
        key: 'fleet',
        diagnosticAttempts: 0,
        policyDisabled: 4,
        verdict: 'policy-suppressed',
      },
    });
    expect(s.dispatchYieldDiagnostics?.recommendation).toContain('do not treat them as backend weakness');
    expect(s.nextActions?.map((action) => action.id)).not.toContain('inspect-dispatch-yield');
    expect(s.attemptCoverage?.production).toMatchObject({
      attempts: 4,
      proposalCreated: 0,
      policySuppressed: 4,
      diagnosticAttempts: 0,
      diagnosticNoProposal: 0,
      diagnosticProposalRate: null,
      diagnosticNoProposalRate: null,
    });
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('diagnosis: policy-suppressed · fleet 0/0 0% · keep routing');
    expect(formatted).toContain('learning:  diagnostic 0/0 (—), no-proposal 0, policy-suppressed 4');
    expect(formatted).not.toContain('proposal filing disabled');
  });

  it('keeps daemon capture-missing rows diagnostic even with raw proposal-disabled counts', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5)],
      }),
      'utf8',
    );
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      machineId: 'm49',
      itemId: 'capture-missing-a',
      source: 'goal',
      repo,
      title: 'Capture missing sample',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'local route',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'capture-missing: required proposal dispatch ended before final capture',
      runEventSummary: {
        status: 'failed',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: {
          proposalDisabled: 1,
          proposalCaptureAttempts: 0,
        },
      },
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction(Array.from({ length: 3 }, (_, index) => ({
      ...baseEvent,
      itemId: `capture-missing-${index}`,
    })));

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      attempts: 3,
      proposalsCreated: 0,
      outcomes: {
        proposalCaptureError: 3,
        proposalDisabled: 0,
      },
      actionCounts: {
        proposalDisabled: 3,
      },
      attemptShape: {
        backendNoDiff: 0,
        captureOrGateBlocked: 3,
        policyDisabled: 0,
      },
      diagnosticTopReasons: [
        {
          reason: 'capture-missing: required proposal dispatch ended before final capture',
          count: 3,
        },
      ],
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'actionable',
      action: 'tighten-context-or-reslice',
      diagnosticAttempts: 3,
      proposalsCreated: 0,
      policyDisabled: 0,
      primaryCandidate: {
        scope: 'backend-source',
        backend: 'local-coder',
        source: 'goal',
        diagnosticAttempts: 3,
        verdict: 'actionable',
      },
    });
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('top reason: capture-missing: required proposal dispatch ended before final capture');
    expect(s.nextActions?.find((action) => action.id === 'inspect-dispatch-yield')?.detail)
      .toContain('shape: no-diff 0, gate/capture 3, repairs 0, policy-off 0');
    expect(s.attemptCoverage?.production).toMatchObject({
      attempts: 3,
      proposalCreated: 0,
      policySuppressed: 0,
      diagnosticAttempts: 3,
      diagnosticNoProposal: 3,
    });
    expect(formatFleetStatus(s)).toContain('diagnosis: actionable · local-coder/goal 0/3 0% · tighten context/reslice');
  });

  it('marks low dispatch-yield samples as insufficient before routing action', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        repos: [repo],
        items: [makeBacklogItem(repo, 'repo:goal:fresh', 'Fresh eligible work', 5)],
      }),
      'utf8',
    );
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      machineId: 'm49',
      itemId: 'sample-a',
      source: 'goal',
      repo,
      title: 'Tiny low-yield sample',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local route',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'sample-b' },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'insufficient-sample',
      action: 'collect-more-samples',
      sameTierOnly: true,
      diagnosticAttempts: 2,
      proposalsCreated: 0,
      primaryCandidate: {
        scope: 'backend-source',
        backend: 'local-coder',
        source: 'goal',
        diagnosticAttempts: 2,
        verdict: 'insufficient-sample',
      },
    });
    expect(s.dispatchYieldDiagnostics?.recommendation).toContain('Collect 1 more diagnostic attempt');
    expect(s.nextActions?.map((action) => action.id)).not.toContain('inspect-dispatch-yield');
    expect(formatFleetStatus(s)).toContain('diagnosis: insufficient-sample · local-coder/goal 0/2 0% · collect more samples');
  });

  it('includes queued self-heal work when the persisted backlog snapshot is stale', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const queued = {
      id: 'repo:self-heal:one',
      repo,
      source: 'self',
      title: 'Fix broken test in repo: FAIL src/repo.test.ts: expected true to be false',
      detail: 'Self-heal: test is RED.\nFirst failure: FAIL src/repo.test.ts: expected true to be false.\nInvestigate and verify the suite passes.',
      value: 5,
      effort: 1,
      score: 5,
      tags: ['self-heal', 'test'],
      ts: '2026-07-02T00:00:00.000Z',
    };
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: '2026-07-01T00:00:00.000Z',
        repos: ['/tmp/deleted-fixture'],
        items: [{ ...queued, id: 'stale-temp-item', repo: '/tmp/deleted-fixture' }],
      }),
      'utf8',
    );
    writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([queued]), 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.queue.backlogItems).toBe(1);
    expect(s.queue.generatedWork).toMatchObject({
      total: 1,
      selfHeal: 1,
      proposalRepair: 0,
      captureRepairs: 0,
      diagnosticReslices: 0,
      invent: 0,
    });
    expect(s.queue.repos).toMatchObject({
      enrolled: 1,
      existing: 1,
      withBacklog: 1,
      silent: 0,
    });
    expect(s.queue.next).toEqual([
      {
        id: 'repo:self-heal:one',
        title: 'Fix broken test in repo: FAIL src/repo.test.ts: expected true to be false',
        repo,
        source: 'self',
        score: 5,
      },
    ]);
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('reflects allowedBackends — defaults to [builtin] when no foundry', async () => {
    const cfg = baseConfig();
    const s = await buildFleetStatus(cfg);
    expect(s.backends.map((b) => b.backend)).toEqual(['builtin']);
    const builtin = s.backends.find((b) => b.backend === 'builtin')!;
    expect(builtin.dispatchesRecent).toBe(0);
    // No limit configured => unlimited.
    expect(builtin.quota).toBe('unlimited');
  });

  it("includes 'claude' with quota 'unlimited' when allowed but no limit set", async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'claude'] });
    const s = await buildFleetStatus(cfg);
    const names = s.backends.map((b) => b.backend);
    expect(names).toContain('claude');
    const claude = s.backends.find((b) => b.backend === 'claude')!;
    expect(claude.quota).toBe('unlimited');
    expect(claude.dispatchesRecent).toBe(0);
  });

  it('includes resource availability for allowed local backends', async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin', 'local-coder'] });
    const s = await buildFleetStatus(cfg);
    const builtin = s.backends.find((b) => b.backend === 'builtin')!;
    const localCoder = s.backends.find((b) => b.backend === 'local-coder')!;

    expect(builtin.resource?.availability).toBe('open');
    expect(builtin.resource?.reason).toMatch(/always available/i);
    expect(['open', 'near', 'unreachable']).toContain(localCoder.resource?.availability);
    expect(localCoder.resource?.availability).not.toBe('not-sensed');
    expect(localCoder.resource?.cap).toBe(1);
    expect(localCoder.resource?.capUnit).toBe('concurrent');
  });

  it('dispatchesRecent reflects recorded quota uses', async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({ allowedBackends: [backend] });

    recordUse(backend);
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(3);
  });

  it("evaluates quota status when a limit is configured", async () => {
    const backend: EngineId = 'claude';
    const cfg = withFoundry({
      allowedBackends: [backend],
      limits: { [backend]: { window: '1d', max: 2 } },
    });

    // 2 uses against a max of 2 => at/over the cap => 'over'.
    recordUse(backend);
    recordUse(backend);

    const s = await buildFleetStatus(cfg);
    const claude = s.backends.find((b) => b.backend === backend)!;
    expect(claude.dispatchesRecent).toBe(2);
    expect(claude.quota).toBe('over');
  });

  it('reports killed:true when the kill switch is set', async () => {
    setKill(true);
    const s = await buildFleetStatus(baseConfig());
    expect(s.killed).toBe(true);
  });

  it('includes shared queue health when filesystem coordination is enabled', async () => {
    const sharedPath = join(tmpHome, 'shared-queue');
    const store = new SharedStore(sharedPath, 20_000);
    expect(store.claimItems(['owned', 'other'], 1, 'machine-A')).toEqual(['owned']);
    expect(store.claimItems(['other'], 1, 'machine-B')).toEqual(['other']);

    const cfg: AshlrConfig = {
      ...baseConfig(),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'machine-A',
          leaseMs: 20_000,
        },
      },
    };

    const s = await buildFleetStatus(cfg);
    expect(s.queue.shared).toMatchObject({
      enabled: true,
      mode: 'filesystem',
      path: sharedPath,
      machineId: 'machine-A',
      leaseMs: 20_000,
      readable: true,
      activeClaims: 2,
      ownedClaims: 1,
      reclaimableClaims: 0,
    });
    expect(s.queue.shared?.claimsByMachine).toEqual([
      { machineId: 'machine-A', active: 1, expired: 0 },
      { machineId: 'machine-B', active: 1, expired: 0 },
    ]);
    expect(s.queue.shared?.claimSamples).toEqual([
      expect.objectContaining({
        itemId: 'owned',
        machineId: 'machine-A',
        state: 'active',
        owned: true,
      }),
      expect.objectContaining({
        itemId: 'other',
        machineId: 'machine-B',
        state: 'active',
        owned: false,
      }),
    ]);
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('claim sample:');
    expect(formatted).toContain('owned:active/owned');
    expect(formatted).toContain('other:active/machine-B');
  });

  it('surfaces daemon spend guard active work without exposing the guard token', async () => {
    await withFakeNow(new Date('2026-07-03T00:10:00.000Z'), async () => {
      const armed = armDaemonSpendGuard(['active-item-a', 'active-item-b']);
      expect(armed.ok).toBe(true);
      if (!armed.ok) return;
      vi.setSystemTime(new Date('2026-07-03T00:12:30.000Z'));

      const s = await buildFleetStatus(baseConfig());

      expect(s.queue.activeWork).toMatchObject({
        source: 'daemon-spend-guard',
        exists: true,
        malformed: false,
        pid: process.pid,
        hostname: hostname(),
        armedAt: '2026-07-03T00:10:00.000Z',
        ageMs: 150_000,
        itemCount: 2,
        itemIds: ['active-item-a', 'active-item-b'],
      });
      expect(JSON.stringify(s.queue.activeWork)).not.toContain(armed.guard.token);
      const formatted = formatFleetStatus(s);
      expect(formatted).toContain('active work:');
      expect(formatted).toContain('armed / 2 item(s) / age 2m');
      expect(formatted).toContain('active ids:    active-item-a, active-item-b');
      expect(clearDaemonSpendGuard(armed.guard.token).ok).toBe(true);
    });
  });

  it('includes autonomy evidence summary when packs exist', async () => {
    expect(persistAutonomyEvidencePack(makeEvidencePack('prop-old', '2026-07-01T00:00:00.000Z'))).toBe(true);
    expect(persistAutonomyEvidencePack(makeEvidencePack('prop-new', '2026-07-02T00:00:00.000Z'))).toBe(true);

    const s = await buildFleetStatus(baseConfig());
    expect(s.autonomy).toMatchObject({
      evidencePacks: 2,
      latestAt: '2026-07-02T00:00:00.000Z',
      allowed: 2,
      denied: 0,
    });
    expect(s.autonomy?.byTier).toMatchObject({ T4: 2 });
    expect(s.autonomy?.recent[0]).toMatchObject({
      proposalId: 'prop-new',
      tier: 'T4',
      action: 'merge-main',
      allowed: true,
      changedFiles: 1,
      changedLines: 1,
    });
  });

  it('includes read-only auto-merge readiness for pending proposals', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });

    createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready'),
      verifyResult: { passed: true, source: 'manual' },
    });
    createSignedProposal(cfg, {
      title: 'Needs verify docs change',
      diff: docsDiff('needs verify'),
    });
    createSignedProposal(cfg, {
      title: 'Failed verify docs change',
      diff: docsDiff('failed verify'),
      verifyResult: { passed: false, failed: ['npm test'], source: 'auto-merge-preflight' },
    });
    createProposal(
      {
        repo: '/tmp/repo',
        origin: 'agent',
        kind: 'patch',
        title: 'Unsigned docs change',
        summary: 'missing provenance',
        diff: docsDiff('unsigned'),
        engineModel: 'codex:gpt-5.5',
        engineTier: 'frontier',
      },
      cfg,
    );

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'verification',
      pending: 4,
      preflightReady: 1,
      needsVerification: 1,
      knownVerificationFailed: 1,
      blocked: 2,
    });
    expect(s.autoMergeReadiness?.byReason).toMatchObject({
      'known verification failure: npm test': 1,
      'provenance check failed: missing diffHash': 1,
    });
    expect(s.autoMergeReadiness?.recentBlockers.map((b) => b.title)).toEqual([
      'Unsigned docs change',
      'Failed verify docs change',
    ]);
    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      counts: {
        pendingProposals: 4,
        preflightReady: 1,
        needsVerification: 1,
        blocked: 2,
      },
    });
    const actionIds = s.nextActions?.map((a) => a.id) ?? [];
    expect(actionIds).toContain('start-daemon');
    expect(actionIds).not.toContain('drain-ready-auto-merges');
    expect(actionIds).not.toContain('verify-pending-proposals');
    expect(actionIds).not.toContain('repair-verification-failures');
  });

  it('marks running fleets with preflight-ready proposals as merge-ready', async () => {
    writeRunningDaemon(tmpHome);
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autonomyEffectiveness).toMatchObject({
      phase: 'merge-ready',
      canAutoMergeNow: true,
      bottleneck: 'merge-drain',
      counts: {
        pendingProposals: 1,
        preflightReady: 1,
      },
    });
  });

  it('marks autonomous ship readiness ready when fresh control, queue, and merge evidence agree', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready ship readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const s = await buildFleetStatus(cfg);
    const queueSource = s.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'ready',
      confidence: 'high',
      topBlocker: null,
      freshness: { overall: 'fresh' },
      sourceSummary: {
        healthy: 6,
        degraded: 0,
        blocked: 0,
        unavailable: 0,
        unknown: 0,
      },
    });
    expect(queueSource?.sourceQuality).toMatchObject({
      badge: 'healthy-zero',
      empty: true,
      sourcePresent: true,
    });
    expect(s.autonomousShipReadiness?.sourceQualitySummary?.['healthy-zero']).toBeGreaterThan(0);
    expect(s.autonomousShipReadiness?.primaryAction).toMatchObject({
      id: 'drain-ready-auto-merges',
    });
    expect(s.missionBrief).toMatchObject({
      directive: 'Drain ready auto-merges',
      confidence: 'high',
      blocker: null,
      action: { id: 'drain-ready-auto-merges' },
      evidence: {
        readinessVerdict: 'ready',
        effectivenessPhase: 'merge-ready',
        preflightReady: 1,
      },
    });
  });

  it('uses a live daemon heartbeat as fresh readiness evidence while a tick is in progress', async () => {
    await withFakeNow(new Date('2026-07-03T00:01:00.000Z'), async () => {
      writeRunningDaemon(tmpHome, [], '2026-07-02T23:55:00.000Z');
      writeDaemonLock(tmpHome, '2026-07-03T00:01:00.000Z');

      const s = await buildFleetStatus(baseConfig());
      const daemonSource = s.autonomousShipReadiness?.sources.find((source) => source.id === 'daemon');

      expect(s.daemon).toMatchObject({
        running: true,
        startedAt: '2026-07-03T00:00:00.000Z',
        lastTickAt: '2026-07-02T23:55:00.000Z',
        lockHeartbeatAt: '2026-07-03T00:01:00.000Z',
        tickInProgress: true,
      });
      expect(daemonSource).toMatchObject({
        status: 'healthy',
        freshness: 'fresh',
        observedAt: '2026-07-03T00:01:00.000Z',
        detail: 'daemon running; tick in progress since 2026-07-03T00:00:00.000Z; last completed tick 2026-07-02T23:55:00.000Z',
        sourceQuality: {
          badge: 'healthy-source',
          sourcePresent: true,
        },
      });
    });
  });

  it('degrades autonomous ship readiness when ready work depends on a stale source', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, []);
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready docs change with stale queue',
      diff: docsDiff('stale queue readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const s = await buildFleetStatus(cfg);
    const queueSource = s.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(s.autonomousShipReadiness).toMatchObject({
      verdict: 'degraded',
      confidence: 'medium',
      topBlocker: null,
      freshness: { overall: 'stale', staleSources: 1 },
    });
    expect(queueSource).toMatchObject({
      status: 'degraded',
      badge: 'degraded',
      freshness: 'stale',
      sourceQuality: {
        badge: 'stale-source',
        empty: true,
        sourcePresent: true,
      },
    });
    expect(s.autonomousShipReadiness?.sourceSummary.degraded).toBeGreaterThan(0);
    expect(s.autonomousShipReadiness?.sourceQualitySummary?.['stale-source']).toBeGreaterThan(0);
  });

  it('surfaces evidence trust basis in auto-merge readiness', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: ['ci/test'],
        },
      },
    });
    const diff = docsDiff('evidence');
    createSignedProposal(cfg, {
      title: 'Evidence docs change',
      diff,
      verifyResult: {
        passed: true,
        source: 'auto-merge-preflight',
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
        diffHash: hashDiff(diff),
      },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'evidence',
      pending: 1,
      preflightReady: 1,
      needsVerification: 0,
      blocked: 0,
    });
  });

  it('treats evidence-mode verification without current diff binding as needing reverify', async () => {
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: ['ci/test'],
        },
      },
    });
    createSignedProposal(cfg, {
      title: 'Evidence docs change without diff binding',
      diff: docsDiff('evidence stale'),
      verifyResult: {
        passed: true,
        source: 'auto-merge-preflight',
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
      },
    });

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'evidence',
      pending: 1,
      preflightReady: 0,
      needsVerification: 1,
      blocked: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Lane locks
// ---------------------------------------------------------------------------

describe('buildFleetLaneLocks — pure derived lane status', () => {
  it('skips a linked milestone whose applied proposal has passing verification', () => {
    const repo = '/tmp/repo-lanes';
    const goal = makeGoalRecord(repo, 'goal-verified', 'active', 'proposed');
    goal.milestones[0]!.proposalId = 'prop-verified';

    const status = buildFleetLaneLocks({
      generatedAt: '2026-07-03T12:00:00.000Z',
      goals: [goal],
      proposals: [{
        id: 'prop-verified',
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Verified applied',
        summary: 'metadata only',
        status: 'applied',
        createdAt: '2026-07-03T00:00:00.000Z',
        verifyResult: { passed: true },
      }],
      visibleQueueItems: [
        makeBacklogItem(repo, `goal:${goal.id}:${goal.milestones[0]!.id}`, 'Advance verified goal', 5, 'goal'),
      ],
    });

    expect(status).toMatchObject({
      active: 0,
      staleInProgress: 0,
      unverifiedApplied: 0,
      lockedVisibleItems: 0,
      samples: [],
    });
  });

  it('keeps old unverified applied proposals visible when they are linked from a goal', () => {
    const repo = '/tmp/repo-lanes';
    const goal = makeGoalRecord(repo, 'goal-linked-old', 'active', 'blocked');
    goal.milestones[0]!.proposalId = 'prop-old';
    goal.milestones.push({
      id: `${goal.id}-m1`,
      title: 'Next milestone',
      detail: 'next',
      order: 1,
      status: 'pending',
      specId: null,
      swarmId: null,
      proposalId: null,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    });

    const status = buildFleetLaneLocks({
      generatedAt: '2026-07-20T12:00:00.000Z',
      goals: [goal],
      proposals: [{
        id: 'prop-old',
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Old unverified applied',
        summary: 'metadata only',
        status: 'applied',
        createdAt: '2026-07-03T00:00:00.000Z',
      }],
      visibleQueueItems: [],
    });

    expect(status.unverifiedApplied).toBe(1);
    expect(status.samples).toContainEqual(expect.objectContaining({
      reason: 'unverified-applied',
      proposalId: 'prop-old',
    }));
  });
});

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------

describe('skill corpus readiness projection', () => {
  const quality = (
    badge: FleetReadinessSourceQuality['badge'],
  ): FleetReadinessSourceQuality => ({
    badge,
    label: badge,
    empty: badge === 'healthy-zero',
    sourcePresent: true,
    detail: 'metadata-only corpus diagnostic',
  });

  it('maps an absent corpus to an honest missing source', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-skill-corpus-'));
    const status = await withTemporaryEnv(
      { ASHLR_HOME: join(isolatedHome, '.ashlr') },
      () => buildFleetStatus(baseConfig()),
    );
    rmSync(isolatedHome, { recursive: true, force: true });

    expect(status.skillCorpusReadiness).toMatchObject({
      version: 1,
      mode: 'shadow',
      corpus: {
        state: 'no-cards',
        sourceQuality: {
          badge: 'missing-source',
          empty: true,
          sourcePresent: false,
        },
      },
      eligibleSignedCards: 'none',
      selectedObservations: 'none',
      learning: {
        state: 'blocked-no-cards',
        minimumObservedTrajectories: 3,
        sampleState: 'none',
      },
    });
    expect(status.skillCorpusReadiness?.learning).not.toHaveProperty('observedTrajectoryCoverage');
  });

  it('quarantines conflicting latest signed revisions as a degraded corpus', async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), 'ashlr-m49-skill-conflict-'));
    try {
      await withTemporaryEnv({ ASHLR_HOME: join(isolatedHome, '.ashlr') }, async () => {
        const makeCard = (name: string) => attestSkillCard(sanitizeSkillCard({
          schemaVersion: 1,
          skillId: 'skill.conflicting-latest',
          revision: 1,
          ts: '2026-07-10T12:00:00.000Z',
          name,
          summary: 'Metadata-only conflicting revision fixture.',
          status: 'verified',
          source: 'verified-proposal',
          taskKinds: ['typescript-change'],
          commandKinds: ['test'],
          verification: {
            passed: true,
            verifiedAt: '2026-07-10T11:59:00.000Z',
            commandKinds: ['test'],
            diffHash: 'a'.repeat(64),
            evidenceCount: 1,
          },
          proposalId: 'proposal-skill-conflict',
          learningEpoch: '2026-07-10',
        }));
        const first = makeCard('First signed payload');
        const second = makeCard('Second signed payload');
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        recordSkillCard([first!, second!]);

        const status = await buildFleetStatus(baseConfig());
        expect(status.skillCorpusReadiness).toMatchObject({
          corpus: {
            state: 'degraded',
            sourceQuality: {
              badge: 'degraded-source',
              sourcePresent: true,
            },
          },
          eligibleSignedCards: 'none',
          learning: { state: 'blocked-corpus-degraded' },
        });
        expect(status.skillCorpusReadiness?.corpus.sourceQuality.detail).toContain('conflicting current revisions');
      });
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'degraded corpus takes precedence',
      corpusState: 'degraded' as const,
      sourceQuality: quality('degraded-source'),
      eligibleSignedCards: 'available' as const,
      observation: { sampleState: 'observed' as const, observedTrajectoryCoverage: { count: 3, rate: 1 } },
      expected: 'blocked-corpus-degraded',
    },
    {
      name: 'empty corpus blocks learning',
      corpusState: 'no-cards' as const,
      sourceQuality: quality('healthy-zero'),
      eligibleSignedCards: 'none' as const,
      observation: { sampleState: 'none' as const },
      expected: 'blocked-no-cards',
    },
    {
      name: 'ineligible corpus awaits verified cards',
      corpusState: 'ready' as const,
      sourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'none' as const,
      observation: { sampleState: 'none' as const },
      expected: 'awaiting-eligible-cards',
    },
    {
      name: 'eligible corpus awaits selection',
      corpusState: 'ready' as const,
      sourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'available' as const,
      observation: { sampleState: 'none' as const },
      expected: 'awaiting-selection',
    },
    {
      name: 'private sample remains gated',
      corpusState: 'ready' as const,
      sourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'available' as const,
      observation: { sampleState: 'insufficient-sample' as const },
      expected: 'k-gated',
    },
    {
      name: 'threshold sample becomes observable',
      corpusState: 'ready' as const,
      sourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'available' as const,
      observation: { sampleState: 'observed' as const, observedTrajectoryCoverage: { count: 3, rate: 0.75 } },
      expected: 'observable',
    },
  ])('$name', ({ corpusState, sourceQuality, eligibleSignedCards, observation, expected }) => {
    const result = buildSkillCorpusReadiness({
      corpusState,
      corpusSourceQuality: sourceQuality,
      eligibleSignedCards,
      skillObservation: observation,
    });

    expect(result.learning.state).toBe(expected);
    expect(result.learning.minimumObservedTrajectories).toBe(3);
    expect(result.corpus.sourceQuality).toBe(sourceQuality);
    if (observation.sampleState === 'observed') {
      expect(result.learning.observedTrajectoryCoverage).toEqual(observation.observedTrajectoryCoverage);
    } else {
      expect(result.learning).not.toHaveProperty('observedTrajectoryCoverage');
    }
  });

  it('withholds exact sub-threshold observations in CLI output', () => {
    const skillCorpusReadiness = buildSkillCorpusReadiness({
      corpusState: 'ready',
      corpusSourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'available',
      skillObservation: { sampleState: 'insufficient-sample' },
    });
    const out = formatFleetStatus({
      generatedAt: '2026-07-10T13:00:00.000Z',
      daemon: { running: true, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      skillCorpusReadiness,
      killed: false,
    });

    expect(out).toContain('Skill corpus:');
    expect(out).toContain('corpus:       ready (healthy-source)');
    expect(out).toContain('eligible:     available');
    expect(out).toContain('observations: present');
    expect(out).toContain('learning:     k-gated (<3 trajectories; exact counts withheld)');
    expect(out).not.toMatch(/observations:.*\d/);
    expect(out).not.toContain('(0%)');
  });

  it('blocks learning categorically when the observation source is degraded', () => {
    const result = buildSkillCorpusReadiness({
      corpusState: 'ready',
      corpusSourceQuality: quality('healthy-source'),
      eligibleSignedCards: 'available',
      skillObservation: { eventState: 'present', sampleState: 'none' },
      observationState: 'degraded',
    });

    expect(result).toMatchObject({
      selectedObservations: 'degraded',
      learning: {
        state: 'blocked-observation-degraded',
        sampleState: 'unavailable',
      },
    });
    expect(result.learning).not.toHaveProperty('observedTrajectoryCoverage');
  });

  it('keeps legacy FleetStatus formatter inputs compatible', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-07-10T13:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });

    expect(out).not.toContain('Skill corpus:');
  });
});

describe('formatFleetStatus — pure formatter (M49)', () => {
  it('renders lane lock counts and a bounded sample', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 2 },
      proposals: { pending: 0, frontierPending: 0, applied: 1 },
      merges: { recent: 0 },
      laneLocks: {
        generatedAt: '2026-06-17T00:00:00.000Z',
        active: 2,
        staleInProgress: 1,
        awaitingHostMerge: 1,
        unverifiedApplied: 1,
        lockedVisibleItems: 2,
        samples: [{
          lane: '/repo/a#goal:goal-lane-a',
          repo: '/repo/a',
          reason: 'stale-in-progress',
          goalId: 'goal-lane-a',
          milestoneId: 'goal-lane-a-m0',
          status: 'in-progress',
          title: 'Stale milestone',
          ageMs: 1000,
        }],
      },
      killed: false,
    });

    expect(out).toContain(
      'lane locks:    2 active, 1 stale, 1 handoff, 1 unverified, 2 visible locked',
    );
    expect(out).toContain('lock sample:   stale-in-progress a /repo/a#goal:goal-lane-a');
  });

  it('renders generated queue work counts compactly', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: true, lastTickAt: '2026-06-17T00:00:00.000Z', todaySpentUsd: 0 },
      backends: [],
      queue: {
        backlogItems: 5,
        eligibleBacklogItems: 4,
        cooldownItems: 1,
        pendingItems: 0,
        generatedWork: {
          total: 3,
          selfHeal: 2,
          proposalRepair: 2,
          captureRepairs: 1,
          diagnosticReslices: 1,
          invent: 1,
        },
      },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });

    expect(out).toContain('generated:     3 total, 2 self-heal items, 2 proposal-repair items, 1 capture repair, 1 no-diff reslice, 1 invent item');
  });

  it('renders live daemon heartbeat and active tick state', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: {
        running: true,
        startedAt: '2026-06-17T00:01:00.000Z',
        lastTickAt: '2026-06-17T00:00:00.000Z',
        lockHeartbeatAt: '2026-06-17T00:02:00.000Z',
        tickInProgress: true,
        todaySpentUsd: 0,
      },
      backends: [],
      queue: { backlogItems: 0, eligibleBacklogItems: 0, cooldownItems: 0, pendingItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });

    expect(out).toContain('started:       2026-06-17T00:01:00.000Z');
    expect(out).toContain('last tick:     2026-06-17T00:00:00.000Z');
    expect(out).toContain('current tick:  in progress');
    expect(out).toContain('heartbeat:     2026-06-17T00:02:00.000Z');
  });

  it('renders dispatch-yield diagnostic reasons without falling back to raw policy-disabled reasons', () => {
    const base = {
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: true, lastTickAt: '2026-06-17T00:00:00.000Z', todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    };
    const dispatchProduction = {
      windowHours: 24,
      attempts: 4,
      events: 4,
      proposalsCreated: 0,
      noProposal: 4,
      proposalRate: 0,
      spentUsd: 0,
      generatedRepairAttempts: {
        attempts: 2,
        proposalsCreated: 1,
        noProposal: 1,
        proposalRate: 0.5,
        captureRepairs: 1,
        diagnosticReslices: 1,
        proposalRepairs: 0,
      },
      outcomes: {
        proposalCreated: 0,
        emptyDiff: 1,
        gateBlocked: 0,
        engineFailed: 0,
        sandboxFailed: 0,
        proposalCaptureError: 0,
        proposalDisabled: 3,
        unknown: 0,
      },
      topReasons: [
        { reason: 'proposal filing disabled for this api-model attempt', count: 3 },
        { reason: 'engine "local-coder" completed without file changes', count: 1 },
      ],
      diagnosticTopReasons: [
        { reason: 'engine "local-coder" completed without file changes', count: 1 },
      ],
      byBackend: [],
      bySource: [],
      byRepo: [],
      byBackendModel: [],
      byBackendSource: [],
    };

    const out = formatFleetStatus({ ...base, dispatchProduction });
    expect(out).toContain('reasons:   1x engine "local-coder" completed without file changes');
    expect(out).toContain('repair yield: capture 1 attempt, no-diff 1 attempt; 1/2 converted (50%)');
    expect(out).not.toContain('proposal filing disabled');

    const emptyDiagnosticOut = formatFleetStatus({
      ...base,
      dispatchProduction: {
        ...dispatchProduction,
        diagnosticTopReasons: [],
      },
    });
    expect(emptyDiagnosticOut).not.toContain('reasons:');
    expect(emptyDiagnosticOut).not.toContain('proposal filing disabled');
  });

  it('renders all sections and flags the paused banner when killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: true, lastTickAt: '2026-06-17T00:00:00.000Z', todaySpentUsd: 1.2345 },
      backends: [
        {
          backend: 'builtin',
          dispatchesRecent: 4,
          quota: 'unlimited',
          resource: {
            availability: 'open',
            usedPct: 0,
            cap: null,
            capUnit: null,
            capWindow: null,
            resetsAt: null,
            reason: 'builtin backend is always available',
            snapshotAt: '2026-06-17T00:00:00.000Z',
          },
        },
        {
          backend: 'claude',
          dispatchesRecent: 2,
          quota: 'warn',
          resource: {
            availability: 'not-sensed',
            usedPct: null,
            cap: null,
            capUnit: null,
            capWindow: null,
            resetsAt: null,
            reason: 'no resource sensor reported this allowed backend',
            snapshotAt: null,
          },
        },
      ],
      queue: {
        backlogItems: 7,
        eligibleBacklogItems: 5,
        cooldownItems: 1,
        pendingItems: 1,
        nextEligibleAt: '2026-06-17T01:00:00.000Z',
        repos: {
          enrolled: 3,
          existing: 3,
          withBacklog: 2,
          silent: 1,
          executionProfiles: {
            reposWithProjects: 3,
            reposWithVerifyCommands: 2,
            reposMissingVerifyCommands: 1,
            reposWithVerifyContracts: 1,
            reposWithValidVerifyContracts: 1,
            reposWithExplicitMergeContracts: 1,
            reposMissingExplicitMergeContracts: 2,
            missingVerifyCommands: [
              {
                repo: '/repo/c',
                name: 'c',
                projectKinds: ['python'],
                reason: 'detected python project(s), but no verify command is configured',
              },
            ],
            missingExplicitMergeContracts: [
              {
                repo: '/repo/b',
                name: 'b',
                projectKinds: ['rust'],
                reason: 'missing ashlr.verify.json merge-profile contract',
              },
              {
                repo: '/repo/c',
                name: 'c',
                projectKinds: ['python'],
                reason: 'detected python project(s), but no verify command is configured',
              },
            ],
            packageManagers: [
              { manager: 'bun', repos: 1 },
              { manager: 'cargo', repos: 1 },
            ],
          },
          byTier: [
            { tier: 'core-fleet', repos: 1, items: 5 },
            { tier: 'supporting', repos: 1, items: 2 },
          ],
          top: [
            { repo: '/repo/a', items: 5 },
            { repo: '/repo/b', items: 2 },
          ],
        },
        next: [
          {
            id: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            score: 5,
          },
        ],
        shared: {
          enabled: true,
          mode: 'filesystem',
          path: '/shared',
          machineId: 'machine-A',
          leaseMs: 300_000,
          readable: true,
          activeClaims: 2,
          ownedClaims: 1,
          expiredClaims: 1,
          reclaimableClaims: 1,
          claimsByMachine: [
            { machineId: 'machine-A', active: 1, expired: 0 },
            { machineId: 'machine-B', active: 1, expired: 1 },
          ],
          nextLeaseExpiryAt: '2026-06-17T00:05:00.000Z',
          oldestExpiredMs: 1_000,
          workedEvents: 4,
          cooldownItems: 2,
          usageEntries: 1,
          lock: { present: true, ageMs: 900_000, stale: true },
        },
      },
      proposals: { pending: 3, frontierPending: 1, applied: 5 },
      proposalProduction: {
        windowHours: 24,
        selected: 5,
        claimed: 4,
        dispatched: 3,
        skipped: 1,
        errors: 1,
        proposalsCreated: 2,
        noProposalDispatches: 1,
        suppressedDispatches: 0,
        diagnosticNoProposalDispatches: 1,
        topReasons: [
          { reason: 'agent returned no diff', count: 2 },
          { reason: 'tool timeout', count: 1 },
        ],
        diagnosticTopReasons: [
          { reason: 'agent returned no diff', count: 2 },
          { reason: 'tool timeout', count: 1 },
        ],
        skipReasons: [
          { reason: 'not-attempted', count: 1 },
        ],
        recentNoProposalDispatches: [
          {
            ts: '2026-06-17T00:03:00.000Z',
            itemId: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            backend: 'builtin',
            reason: 'agent returned no diff',
          },
        ],
        recentDiagnosticNoProposalDispatches: [
          {
            ts: '2026-06-17T00:03:00.000Z',
            itemId: 'item-a',
            title: 'Ship autonomy debugger',
            repo: '/repo/a',
            source: 'goal',
            backend: 'builtin',
            reason: 'agent returned no diff',
          },
        ],
      },
      dispatchProduction: {
        windowHours: 24,
        attempts: 3,
        events: 3,
        proposalsCreated: 1,
        noProposal: 2,
        proposalRate: 1 / 3,
        spentUsd: 0.003,
        outcomes: {
          proposalCreated: 1,
          emptyDiff: 1,
          gateBlocked: 1,
          engineFailed: 0,
          sandboxFailed: 0,
          proposalCaptureError: 0,
          proposalDisabled: 0,
          unknown: 0,
        },
        attemptShape: {
          backendNoDiff: 1,
          captureOrGateBlocked: 1,
          repairAttempts: 0,
          policyDisabled: 0,
        },
        topReasons: [
          { reason: 'agent returned no diff', count: 2 },
        ],
        byBackend: [
          {
            key: 'local-coder',
            backend: 'local-coder',
            attempts: 2,
            proposalsCreated: 0,
            noProposal: 2,
            proposalRate: 0,
            spentUsd: 0.002,
            outcomes: {
              proposalCreated: 0,
              emptyDiff: 1,
              gateBlocked: 1,
              engineFailed: 0,
              sandboxFailed: 0,
              proposalCaptureError: 0,
              proposalDisabled: 0,
              unknown: 0,
            },
            topReasons: [{ reason: 'agent returned no diff', count: 2 }],
          },
          {
            key: 'codex',
            backend: 'codex',
            attempts: 1,
            proposalsCreated: 1,
            noProposal: 0,
            proposalRate: 1,
            spentUsd: 0.001,
            outcomes: {
              proposalCreated: 1,
              emptyDiff: 0,
              gateBlocked: 0,
              engineFailed: 0,
              sandboxFailed: 0,
              proposalCaptureError: 0,
              proposalDisabled: 0,
              unknown: 0,
            },
            topReasons: [{ reason: 'proposal filed', count: 1 }],
          },
        ],
        bySource: [],
        byRepo: [],
        byBackendModel: [],
        byBackendSource: [],
      },
      merges: { recent: 2 },
      nextActions: [
        {
          id: 'drain-ready-auto-merges',
          priority: 'high',
          label: 'Drain ready auto-merges',
          detail: '1 pending proposal has cheap preflight-ready evidence.',
          commands: [{
            label: 'Run auto-merge pass',
            argv: ['ashlr', 'daemon', 'start', '--once'],
            shell: 'ashlr daemon start --once',
            safety: 'autonomous-dispatch',
          }],
        },
        {
          id: 'build-backlog',
          priority: 'medium',
          label: 'Build backlog proposals',
          detail: 'Start with Ship autonomy debugger',
          target: '/repo/a',
          commands: [{
            label: 'Run one proposal cycle',
            argv: ['ashlr', 'loop'],
            shell: 'ashlr loop',
            safety: 'autonomous-dispatch',
            cwd: '/repo/a',
          }],
        },
      ],
      autonomyEffectiveness: {
        phase: 'merge-ready',
        canAutoMergeNow: true,
        bottleneck: 'merge-drain',
        summary: '1 proposal is preflight-ready for the auto-merge drain.',
        counts: {
          backlogItems: 7,
          pendingProposals: 3,
          frontierPending: 1,
          awaitingHostMerge: 0,
          preflightReady: 1,
          needsVerification: 1,
          blocked: 2,
          knownVerificationFailed: 1,
          recentMerges: 2,
        },
      },
      autonomousShipReadiness: {
        verdict: 'ready',
        confidence: 'high',
        freshness: {
          generatedAt: '2026-06-17T00:02:00.000Z',
          overall: 'fresh',
          freshestAt: '2026-06-17T00:02:00.000Z',
          stalestAt: '2026-06-17T00:00:00.000Z',
          maxAgeMs: 120_000,
          staleSources: 0,
          unknownSources: 0,
        },
        topBlocker: null,
        primaryAction: {
          id: 'drain-ready-auto-merges',
          priority: 'high',
          label: 'Drain ready auto-merges',
          detail: '1 pending proposal has cheap preflight-ready evidence.',
        },
        sources: [
          {
            id: 'daemon',
            label: 'Daemon',
            status: 'healthy',
            badge: 'healthy',
            freshness: 'fresh',
            observedAt: '2026-06-17T00:00:00.000Z',
            ageMs: 120_000,
            detail: 'daemon running',
            sourceQuality: {
              badge: 'healthy-source',
              label: 'healthy source',
              empty: false,
              sourcePresent: true,
              detail: 'daemon running',
            },
          },
          {
            id: 'auto-merge',
            label: 'Auto-Merge Gate',
            status: 'healthy',
            badge: 'healthy',
            freshness: 'fresh',
            observedAt: '2026-06-17T00:02:00.000Z',
            ageMs: 0,
            detail: '1 ready',
            sourceQuality: {
              badge: 'healthy-zero',
              label: 'healthy zero',
              empty: true,
              sourcePresent: true,
              detail: '1 ready',
            },
          },
        ],
        sourceSummary: {
          healthy: 2,
          degraded: 0,
          blocked: 0,
          unavailable: 0,
          unknown: 0,
        },
        sourceQualitySummary: {
          'healthy-source': 1,
          'healthy-zero': 1,
          'degraded-source': 0,
          'missing-source': 0,
          'stale-source': 0,
          'unknown-source': 0,
        },
      },
      missionBrief: {
        generatedAt: '2026-06-17T00:00:00.000Z',
        directive: 'Drain ready auto-merges',
        confidence: 'high',
        operatingMode: 'local-only',
        blocker: null,
        action: {
          id: 'drain-ready-auto-merges',
          priority: 'high',
          label: 'Drain ready auto-merges',
          detail: '1 pending proposal has cheap preflight-ready evidence.',
        },
        whyNow: '1 proposal is preflight-ready for the auto-merge drain.',
        evidence: {
          readinessVerdict: 'ready',
          effectivenessPhase: 'merge-ready',
          bottleneck: 'merge-drain',
          queueBacklogItems: 7,
          eligibleBacklogItems: 5,
          pendingProposals: 3,
          preflightReady: 1,
          guardBlocked: false,
        },
      },
      autonomy: {
        evidencePacks: 3,
        latestAt: '2026-06-17T00:01:00.000Z',
        allowed: 2,
        denied: 1,
        byTier: { T4: 2, T0: 1 },
        recent: [],
      },
      autonomyControlMode: 'executable',
      autoMergeReadiness: {
        enabled: true,
        trustBasis: 'verification',
        pending: 4,
        preflightReady: 1,
        needsVerification: 1,
        knownVerificationFailed: 1,
        blocked: 2,
        byReason: {
          'known verification failure: npm test': 1,
          'provenance check failed: missing diffHash': 1,
        },
        recentBlockers: [],
        verifierContracts: {
          pendingNeedingVerification: 1,
          withoutVerifyCommands: 1,
          withoutExplicitMergeContract: 1,
          recentGaps: [
            {
              proposalId: 'prop-verify',
              title: 'Needs verification',
              repo: '/repo/c',
              name: 'c',
              withoutVerifyCommands: true,
              withoutExplicitMergeContract: true,
              reason: 'detected python project(s), but no verify command is configured',
            },
          ],
        },
      },
      autonomyDirection: {
        generatedAt: '2026-06-17T00:02:00.000Z',
        mode: 'local-only',
        confidence: 'medium',
        reasons: ['cloud/frontier resources are constrained while local capacity is available'],
        recommendedActions: ['prefer local or builtin engines for new work'],
        resources: { posture: 'constrained', constrained: 1, depleted: 0 },
        guardHealth: { blocked: false, blocks: 0 },
        budgets: { daemonBudgetLevel: 'near', daemonSpentTodayUsd: 1.2345 },
        productionVelocity: {
          enabled: false,
          profile: 'off',
          fillQueueToSlots: false,
          stalePendingTtlHours: Number.POSITIVE_INFINITY,
          maxSlotsPerBackend: 3,
          caps: { localMaxConcurrent: null, nimMaxConcurrent: null, kimiMaxConcurrent: null },
          flags: { gateway: false, resourceAware: false, concurrentDispatch: false, workhorseDispatch: false },
        },
      },
      killed: true,
    });

    expect(out).toContain('Fleet status');
    expect(out).toContain('[PAUSED');
    expect(out).toContain('Daemon:');
    expect(out).toContain('running');
    expect(out).toContain('$1.2345');
    expect(out).toContain('builtin');
    expect(out).toContain('claude');
    expect(out).toContain('quota=warn');
    expect(out).toContain('resource=open used=0%');
    expect(out).toContain('reason=builtin backend is always available');
    expect(out).toContain('resource=not-sensed');
    expect(out).toContain('7 backlog item(s)');
    expect(out).toContain('eligibility:   5 eligible, 1 cooling, 1 pending');
    expect(out).toContain('next eligible: 2026-06-17T01:00:00.000Z');
    expect(out).toContain('repos:         2/3 active (3 enrolled, 1 silent)');
    expect(out).toContain('top repos:     a:5, b:2');
    expect(out).toContain('focus tiers:   core-fleet:1r/5i, supporting:1r/2i');
    expect(out).toContain('verify roots:   2/3 repos (1 missing; bun:1, cargo:1)');
    expect(out).toContain('merge verify:   1/3 explicit (2 missing)');
    expect(out).toContain('missing verify: c [python: detected python project(s), but no verify command is configured]');
    expect(out).toContain(
      'missing merge:  b [rust: missing ashlr.verify.json merge-profile contract]; ' +
        'c [python: detected python project(s), but no verify command is configured]',
    );
    expect(out).toContain('next:          Ship autonomy debugger (goal, score 5)');
    expect(out).toContain('shared:        ok / 2 active / 1 owned / 1 reclaimable / 2 cooling / stale lock');
    expect(out).toContain('machine-A:1');
    expect(out).toContain('machine-B:1(+1 reclaimable)');
    expect(out).toContain('frontier pending:  1');
    expect(out).toContain('applied:           5');
    expect(out).toContain('Proposal production:');
    expect(out).toContain('window:    24h');
    expect(out).toContain('queue:     selected 5, claimed 4, dispatched 3, skipped 1');
    expect(out).toContain('output:    proposals 2, no-proposal 1, suppressed 0, errors 1');
    expect(out).toContain('2x agent returned no diff');
    expect(out).toContain('recent:    builtin a Ship autonomy debugger (agent returned no diff)');
    expect(out).toContain('Dispatch yield:');
    expect(out).toContain('output:    proposals 1/3 (33%), no-proposal 2');
    expect(out).toContain('backends:  local-coder 0/2 0%; codex 1/1 100%');
    expect(out).toContain('2 auto-merge(s)');
    expect(out).toContain('Mission brief:');
    expect(out).toContain('directive:  Drain ready auto-merges');
    expect(out).toContain('confidence: high');
    expect(out).toContain('blocker:    none');
    expect(out).toContain('action:     Drain ready auto-merges: 1 pending proposal has cheap preflight-ready evidence.');
    expect(out).toContain('why now:    1 proposal is preflight-ready for the auto-merge drain.');
    expect(out).toContain('evidence:   verdict ready, phase merge-ready, backlog 5/7, pending 3, ready 1');
    expect(out).toContain('Next actions:');
    expect(out).toContain('[high] Drain ready auto-merges');
    expect(out).toContain('cmd: Run auto-merge pass: ashlr daemon start --once (autonomous-dispatch)');
    expect(out).toContain('[medium] Build backlog proposals [a]: Start with Ship autonomy debugger');
    expect(out).toContain('cmd: Run one proposal cycle: ashlr loop @ a (autonomous-dispatch)');
    expect(out).toContain('Autonomy effectiveness:');
    expect(out).toContain('phase:      merge-ready');
    expect(out).toContain('bottleneck: merge-drain');
    expect(out).toContain('merge now:  yes');
    expect(out).toContain('counts:     backlog 7, pending 3, ready 1, verify 1, blocked 2, host 0');
    expect(out).toContain('Autonomous ship readiness:');
    expect(out).toContain('verdict:    ready (high confidence, fresh sources)');
    expect(out).toContain('top block:  none');
    expect(out).toContain('action:     Drain ready auto-merges: 1 pending proposal has cheap preflight-ready evidence.');
    expect(out).toContain('sources:    daemon:healthy-source, auto-merge:healthy-zero');
    expect(out).toContain('Autonomy evidence:');
    expect(out).toContain('packs:     3');
    expect(out).toContain('denied:    1');
    expect(out).toContain('T4:2');
    expect(out).toContain('Auto-merge readiness:');
    expect(out).toContain('enabled:   yes');
    expect(out).toContain('trust:     verification');
    expect(out).toContain('pending:   4 (preflight 1, verify 1, blocked 2)');
    expect(out).toContain('failed:    1 known verification failure(s)');
    expect(out).toContain('verifiers: 1 need verification (1 no commands, 1 no merge contract)');
    expect(out).toContain('verifier gaps: c: detected python project(s), but no verify command is configured');
    expect(out).toContain('1x known verification failure: npm test');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('control:    executable');
    expect(out).toContain('mode:       local-only');
    expect(out).toContain('confidence: medium');
    expect(out).toContain('resources:  constrained (1 constrained, 0 depleted)');
    expect(out).toContain('budget:     near');
  });

  it('omits the paused banner when not killed', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });
    expect(out).not.toContain('[PAUSED');
    expect(out).toContain('(none)');
    expect(out).toContain('Proposal production:');
    expect(out).toContain('unavailable');
    expect(out).toContain('Autonomy direction:');
    expect(out).toContain('unavailable');
  });
});
