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
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import type { AshlrConfig, DaemonTick, EngineId, Goal, WorkItem } from '../src/core/types.js';
import {
  buildFleetStatus,
  buildRepairHandoffRolloutStatus,
  repairHandoffProjectionTick,
  buildSkillCorpusReadiness,
  type FleetStatus,
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
import {
  hashDiff,
  signJudgeAttestation,
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
  signProvenance,
} from '../src/core/foundry/provenance.js';
import { recordDispatchProduction, type DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import { recordDispatchManifest } from '../src/core/fleet/dispatch-manifest.js';
import { recordBestOfN } from '../src/core/fleet/best-of-n-ledger.js';
import { recordAgentAction, type AgentActionEvent } from '../src/core/fleet/agent-action-ledger.js';
import { recordDecision } from '../src/core/fleet/decisions-ledger.js';
import { recordJudgeTrace } from '../src/core/fleet/judge-trace.js';
import { recordPostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import { recordOutcome } from '../src/core/fleet/worked-ledger.js';
import {
  generatedRepairCooldownKey,
  generatedRepairDispatchState,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import * as fleetRouter from '../src/core/fleet/router.js';
import {
  readRepairHandoffs,
  recordRepairHandoffs,
} from '../src/core/fleet/repair-handoff-journal.js';
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import {
  readSkillUseEvents,
  recordSkillCard,
  recordSkillUseEvent,
  sanitizeSkillCard,
} from '../src/core/fleet/skill-records.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import { armDaemonSpendGuard, clearDaemonSpendGuard } from '../src/core/daemon/state.js';
import { writeDaemonActivity } from '../src/core/daemon/activity.js';
import { loadQueuedAutonomyItemsDetailed } from '../src/core/portfolio/queued-autonomy.js';
import type { Proposal } from '../src/core/types.js';
import * as inboxMerge from '../src/core/inbox/merge.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function seedAuthenticatedRealizedProposal(
  home: string,
  id: string,
  observedAt: string,
  createdAt = '2026-07-14T08:00:00.000Z',
): Proposal {
  const repo = join(home, `repo-${id}`);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(repo, ['config', 'user.email', 'status-test@ashlr.test']);
  git(repo, ['config', 'user.name', 'Status Test']);
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'base']);
  const baseBeforeOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', '-b', 'proposal']);
  writeFileSync(join(repo, 'README.md'), '# landed\n', 'utf8');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'proposal']);
  const proposalHeadOid = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['checkout', 'main']);
  git(repo, ['merge', '--no-ff', 'proposal', '-m', 'merge proposal']);
  const mergeCommitOid = git(repo, ['rev-parse', 'HEAD']);
  const diffHash = 'a'.repeat(64);
  const unsignedIntent = {
    schemaVersion: 1 as const,
    branch: 'proposal',
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    diffHash,
    evidencePackDigest: 'b'.repeat(64),
    authorizationId: 'c'.repeat(32),
    authorizedAt: observedAt,
  };
  const intentAttestation = signLocalMergeIntent(id, repo, unsignedIntent);
  const localMergeIntent = { ...unsignedIntent, attestation: intentAttestation };
  const unsignedRealized = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    mergeCommitOid,
    observedAt,
    proposalId: id,
    diffHash,
    intentAttestation,
  };
  const attestation = signLocalRealizedMergeReceipt(id, repo, unsignedRealized);
  const inbox = join(home, '.ashlr', 'inbox');
  mkdirSync(inbox, { recursive: true });
  const proposal: Proposal = {
    id,
    repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Authenticated landed proposal',
    summary: 'Landed-work projection fixture',
    status: 'applied',
    createdAt,
    decidedAt: observedAt,
    diffHash,
    verifyResult: { passed: true, baseHead: baseBeforeOid, diffHash },
    localMergeIntent,
    realizedMerge: { ...unsignedRealized, attestation },
  };
  writeFileSync(join(inbox, `${id}.json`), JSON.stringify(proposal), 'utf8');
  return proposal;
}

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

function withRoutableMid(foundry: NonNullable<AshlrConfig['foundry']> = {}): AshlrConfig {
  return withFoundry({
    ...foundry,
    allowedBackends: ['local-coder'],
    resourceOverrides: {
      ...foundry.resourceOverrides,
      'local-coder': { availability: 'open', reason: 'm49 routable mid fixture' },
    },
    engines: {
      ...foundry.engines,
      'local-coder': {
        id: 'local-coder',
        kind: 'cli-agent',
        tier: 'mid',
        bin: 'node',
        bins: ['node'],
        argv: ['$GOAL'],
      },
    },
  });
}

function withRoutableFrontierAndMid(): AshlrConfig {
  const cfg = withRoutableMid();
  cfg.foundry!.allowedBackends = ['nim', 'local-coder'];
  cfg.foundry!.resourceOverrides = {
    ...cfg.foundry!.resourceOverrides,
    nim: { availability: 'open', reason: 'm49 routable frontier fixture' },
  };
  cfg.foundry!.engines = {
    ...cfg.foundry!.engines,
    nim: {
      id: 'nim',
      kind: 'cli-agent',
      tier: 'frontier',
      bin: 'node',
      bins: ['node'],
      argv: ['$GOAL'],
    },
  };
  return cfg;
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
  const parent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: '2026-07-03T00:00:00.000Z',
    machineId: 'm49',
    itemId: `repo:goal:diagnostic-retry:${hash}`,
    source: 'goal',
    repo,
    title: 'Repair a stalled objective',
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'router',
    routeReason: 'test parent route',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: 'attempt-12345678-1234-4123-8123-123456789abc',
    objectiveHash: hash.padEnd(64, 'a').slice(0, 64),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  recordRepairHandoffs(parent, {
    schemaVersion: 2,
    activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
  });
  const handoff = readRepairHandoffs().observations.find((row) =>
    row.schemaVersion === 2 && row.parentItemId === parent.itemId)!;
  return {
    id: handoff.childItemId,
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
    ts: parent.ts,
    repairHandoffId: handoff.eventId,
    repairGenerationId: handoff.generationId,
    repairTreatmentUnitId: handoff.repairTreatmentUnitId,
    repairTreatment: handoff.repairTreatment,
    repairParentItemId: parent.itemId,
    repairParentSource: parent.source,
    repairParentBackend: parent.backend,
    repairParentTier: parent.tier,
    repairParentObjectiveHash: parent.objectiveHash,
  };
}

function recordDiagnosticEmpty(
  item: WorkItem,
  attemptId: string,
  backend: 'local-coder' | 'kimi',
  ordinal: 1 | 2,
) {
  const ts = new Date(Date.now() - (3 - ordinal) * 1_000).toISOString();
  const routeReason = `m49 diagnostic attempt ${ordinal}`;
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend,
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend,
      tier: 'mid',
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: ROUTER_POLICY_VERSION,
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'empty-diff',
      proposalCreated: false,
      costUsd: 0,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: ROUTER_POLICY_VERSION,
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal: ordinal,
    ...(ordinal === 2 ? { repairPreviousBackend: 'local-coder' as const } : {}),
  };
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return recordGeneratedRepairLifecycle(item, { kind: 'dispatch-proof-empty-diff', eventTs: ts });
}

function makeTrustedProposalRepairItem(repo: string, id = 'repo:proposal-repair:abcdef123456'): WorkItem {
  return {
    id,
    repo,
    source: 'self',
    title: 'Proposal repair: complete the stalled scheduler fix',
    detail:
      'Proposal repair: produce a corrected proposal.\n' +
      'Proposal: prop-stalled\n' +
      'Original work item: repo:goal:stalled\n' +
      'Produce a fresh complete fix and verify it.',
    value: 4,
    effort: 1,
    score: 4,
    tags: ['self-heal', 'proposal-repair', 'verify'],
    ts: '2026-07-03T00:00:00.000Z',
  };
}

function makeTrustedCaptureRepairItem(
  repo: string,
  id = 'repo:proposal-repair-capture:abcdef123456',
  score = 9,
): WorkItem {
  return {
    id,
    repo,
    source: 'self',
    title: 'Dispatch capture repair: complete the failed proposal capture',
    detail:
      'Dispatch capture repair: complete the failed proposal capture.\n' +
      'Original work item: repo:self:gate\n' +
      'Dispatch outcome: gate-blocked\n' +
      'Diff metadata: files=1 lines=12\n' +
      'Failure: proposal capture was incomplete.\n' +
      'Produce a fresh complete fix and verify it.',
    value: 5,
    effort: 1,
    score,
    tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate'],
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
  generatedAt = new Date().toISOString(),
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

function recordFrontierShipDecision(proposal: Proposal): void {
  const judgeEngine = 'claude-opus-4-5';
  recordDecision({
    ts: new Date().toISOString(),
    proposalId: proposal.id,
    action: 'judged',
    engine: judgeEngine,
    model: judgeEngine,
    verdict: 'ship',
    reason: 'frontier judge ship',
    detail: 'would-merge',
    judgeAttestation: signJudgeAttestation({
      proposalId: proposal.id,
      judgeEngine,
      verdict: 'ship',
      diffHash: hashDiff(proposal.diff ?? ''),
    }),
  });
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
    tmpHome = realpathSync.native(mkdtempSync(join(tmpdir(), 'ashlr-m49-')));
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
    expect(s.buildIdentity).toEqual({
      schemaVersion: 1,
      packageVersion: null,
      revision: null,
      dirty: null,
      provenance: 'unavailable',
    });
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
    expect(s.repairHandoffRollout).toMatchObject({
      writerEnabled: false,
      phase: 'reader-only',
      sourceState: 'missing',
      v1Authorities: 0,
      v2Authorities: 0,
      eligibleOrdinaryItems: null,
      action: 'inspect-source',
    });
    expect(s.proposals.pending).toBe(0);
    expect(s.proposals.frontierPending).toBe(0);
    expect(s.proposals.applied).toBe(0);
    expect(s.proposals.authority).toMatchObject({
      gate: 'unavailable',
      detail: expect.stringContaining('missing source is absent'),
    });
    expect(s.merges.recent).toBe(0);
    expect(s.merges).toMatchObject({
      reportedByTicks: 0,
      sourceQuality: {
        sourceState: 'missing',
        sourcePresent: false,
        complete: true,
      },
    });
    expect(s.judgeTraceSource).toMatchObject({
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
    });
    expect(s.postMergeCohort).toMatchObject({
      policyEligible: false,
      denominatorComplete: false,
      adverseObservations: 0,
      stability: { completeCohorts: 0, releasedWitnesses: 0 },
    });
    expect(s.autonomousShipReadiness?.evidenceMatrix?.sources.find(
      (source) => source.id === 'post-merge',
    )).toMatchObject({ evidenceRole: 'forensics', eligibility: 'observational' });
    expect(s.cutoffCheckpoints).toMatchObject({
      state: 'missing', freshness: 'unknown', releasedCheckpoints: 0,
      captureScheduler: { sourceState: 'missing', state: 'due' },
      authority: 'observation-only', evidenceRole: 'forensics', eligibility: 'observational',
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
      rollbackProtected: false, historicalAuthority: false,
    });
    expect(Object.keys(s.cutoffCheckpoints!).sort()).toEqual([
      'ageMs', 'authority', 'captureScheduler', 'complete', 'cutoffAuthority', 'denominatorComplete',
      'eligibility', 'evidenceRole', 'freshness', 'historicalAuthority', 'latestCapturedAt',
      'physicalRows', 'policyEligible', 'releasedCheckpoints', 'rollbackProtected', 'staleAfterMs',
      'state', 'stopReasons', 'unreleasedRows', 'version',
    ].sort());
    const cutoffPayload = JSON.stringify(s.cutoffCheckpoints);
    for (const forbidden of ['checkpoints', 'snapshot', 'entryDigest', 'rootDigest', 'repositoryIdentities']) {
      expect(cutoffPayload).not.toContain(`"${forbidden}"`);
    }
    expect(formatFleetStatus(s)).toContain('Cutoff checkpoints (observation only):');
    expect(formatFleetStatus(s)).toContain('cutoff=false, denominator=false, policy=false');
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
      authorityState: 'cold-start',
      protocols: { sealedV3: 0, legacy: 0 },
      sourceQuality: { sourceState: 'missing', sourcePresent: false, complete: true },
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

  it('derives recent landed work once from authenticated proposal evidence, never tick aggregates', async () => {
    await withFakeNow(new Date('2026-07-14T12:00:00.000Z'), async () => {
      seedAuthenticatedRealizedProposal(
        tmpHome,
        'prop-landed-current-0001',
        '2026-07-14T10:00:00.000Z',
      );
      seedAuthenticatedRealizedProposal(
        tmpHome,
        'prop-landed-future-0002',
        '2099-07-14T10:00:00.000Z',
      );
      writeRunningDaemon(tmpHome, [
        { ts: 'not-a-time', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'legacy', merged: 2 },
        { ts: '2099-07-14T10:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'future', merged: 3 },
        { ts: '2026-07-14T10:05:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'duplicate aggregate', merged: 4 },
      ], '2026-07-14T10:05:00.000Z');

      const status = await buildFleetStatus(baseConfig());
      expect(status.merges).toMatchObject({
        recent: 1,
        reportedByTicks: 9,
        sourceQuality: {
          sourceState: 'healthy',
          sourcePresent: true,
          complete: true,
          filesDiscovered: 2,
          filesRead: 2,
          invalidFiles: 0,
          unreadableFiles: 0,
        },
      });
    });
  });

  it('surfaces degraded proposal truth instead of presenting a healthy landed zero', async () => {
    const inbox = join(tmpHome, '.ashlr', 'inbox');
    mkdirSync(inbox, { recursive: true });
    const observed = createProposal({
      repo: '/tmp/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'Observed proposal from degraded source',
      summary: 'This row is visible but cannot establish complete proposal authority.',
    });
    writeFileSync(join(inbox, 'broken.json'), '{not-json', 'utf8');
    writeRunningDaemon(tmpHome, [
      { ts: '2026-07-14T10:00:00.000Z', itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'legacy', merged: 5 },
    ]);

    const status = await buildFleetStatus(withFoundry({ autoMerge: { enabled: true } }));
    expect(status.proposals).toMatchObject({
      pending: 1,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        invalidFiles: 1,
      },
      authority: { gate: 'unavailable' },
    });
    expect(status.proposals.sourceQuality?.stopReasons).toContain('invalid-file');
    expect(status.autoMergeReadiness).toBeUndefined();
    expect(status.autonomousShipReadiness?.sources.find((source) => source.id === 'auto-merge'))
      .toMatchObject({ status: 'unavailable' });
    expect(status.autonomyEffectiveness).toMatchObject({
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
    });
    expect(status.autonomyEffectiveness?.summary).toContain('complete healthy proposal source');
    expect(observed.status).toBe('pending');
    expect(status.merges.recent).toBe(0);
    expect(status.merges.reportedByTicks).toBe(5);
    expect(status.merges.sourceQuality).toMatchObject({
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      invalidFiles: 1,
    });
    expect(status.merges.sourceQuality?.stopReasons).toContain('invalid-file');
  });

  it('keeps auto-merge authority available for a complete 513-proposal source', async () => {
    const inbox = join(tmpHome, '.ashlr', 'inbox');
    const proposalRepo = join(tmpHome, 'proposal-file-bound-repo');
    mkdirSync(inbox, { recursive: true });
    mkdirSync(proposalRepo, { recursive: true });
    for (let index = 0; index < 513; index++) {
      const id = `proposal-partial-source-${String(index).padStart(4, '0')}`;
      const proposal: Proposal = {
        id,
        repo: proposalRepo,
        origin: 'agent',
        kind: 'patch',
        title: `Partial source proposal ${index}`,
        summary: 'Valid bounded proposal enumeration fixture.',
        status: 'pending',
        createdAt: '2026-07-14T10:00:00.000Z',
      };
      writeFileSync(join(inbox, `${id}.json`), JSON.stringify(proposal), 'utf8');
    }
    writeRunningDaemon(tmpHome, []);

    const status = await buildFleetStatus(withFoundry({ autoMerge: { enabled: true } }));

    expect(status.proposals.pending).toBe(513);
    expect(status.proposals.sourceQuality).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      filesDiscovered: 513,
      filesRead: 513,
      stopReasons: [],
    });
    expect(status.proposals.authority).toMatchObject({
      gate: 'ready',
      detail: expect.stringContaining('513/513 files read'),
    });
    expect(status.autoMergeReadiness).toMatchObject({ pending: 513 });
    expect(status.autonomousShipReadiness?.sources.find((source) => source.id === 'auto-merge'))
      .not.toMatchObject({ status: 'unavailable' });
  });

  it('keeps degraded cutoff observations structurally outside readiness and mission authority', async () => {
    const cfg = baseConfig();
    const missing = await buildFleetStatus(cfg);
    const fleetDir = join(process.env.ASHLR_HOME!, 'fleet');
    mkdirSync(fleetDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(fleetDir, 'cutoff-observation-checkpoints.jsonl'), 'broken\n', { mode: 0o600 });
    writeFileSync(join(fleetDir, 'cutoff-observation-checkpoints.root.json'), 'broken\n', { mode: 0o600 });
    writeFileSync(join(fleetDir, 'cutoff-observation-scheduler.json'), 'broken\n', { mode: 0o600 });

    const degraded = await buildFleetStatus(cfg);
    expect(degraded.cutoffCheckpoints).toMatchObject({
      state: 'degraded', freshness: 'unknown', complete: false,
      captureScheduler: { sourceState: 'degraded', state: 'degraded' },
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
    });
    const authorityProjection = (status: typeof missing) => JSON.parse(JSON.stringify({
      autoMergeReadiness: status.autoMergeReadiness,
      evidencePolicy: status.evidencePolicy,
      autonomyDirection: status.autonomyDirection,
      autonomyEffectiveness: status.autonomyEffectiveness,
      autonomousShipReadiness: status.autonomousShipReadiness,
      missionBrief: status.missionBrief,
      nextActions: status.nextActions,
    }, (key, value) => [
      'generatedAt', 'observedAt', 'ageMs', 'freshestAt', 'stalestAt', 'maxAgeMs',
    ].includes(key) ? undefined : value));
    expect(authorityProjection(degraded)).toEqual(authorityProjection(missing));
  });

  it('classifies repair handoff rollout phases and next actions deterministically', () => {
    const healthy = {
      sourceState: 'healthy' as const,
      v1Authorities: 22,
      v2Authorities: 0,
      v1PhysicalRows: 22,
      v2PhysicalRows: 0,
      invalidRows: 0,
      conflictingIds: 0,
      limitExceeded: false,
      aliasFamilies: 0,
      latestV2At: null,
      currentActivationV2Authorities: 0,
      unboundV2Authorities: 0,
      latestCurrentActivationV2At: null,
      authorityDigest: 'a'.repeat(64),
    };
    expect(buildRepairHandoffRolloutStatus(healthy, false, 0)).toMatchObject({
      phase: 'reader-only', action: 'wait-ordinary-parent', writerEnabled: false,
      eligibleOrdinaryItems: 0,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, false, null)).toMatchObject({
      phase: 'reader-only', action: 'inspect-source', writerEnabled: false,
      eligibleOrdinaryItems: null,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, false, 2)).toMatchObject({
      phase: 'reader-only', action: 'enable-canary', writerEnabled: false,
      eligibleOrdinaryItems: 2,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, true, 0)).toMatchObject({
      phase: 'awaiting-evidence', action: 'wait-ordinary-parent', writerEnabled: true,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, true, 2)).toMatchObject({
      phase: 'awaiting-evidence', action: 'observe-writer', eligibleOrdinaryItems: 2,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, true, null)).toMatchObject({
      phase: 'awaiting-evidence', action: 'inspect-source', eligibleOrdinaryItems: null,
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      v1Authorities: 0,
      v1PhysicalRows: 0,
      v2Authorities: 1,
      v2PhysicalRows: 1,
      latestV2At: '2026-07-11T15:00:00.000Z',
    }, true, 0)).toMatchObject({
      phase: 'v2-healthy', action: 'observe-projection', projectionObserved: false,
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      v2Authorities: 1,
      v2PhysicalRows: 1,
      aliasFamilies: 1,
      latestV2At: '2026-07-11T15:00:00.000Z',
    }, true, 0)).toMatchObject({
      phase: 'mixed-healthy', action: 'observe-projection', v2Authorities: 1,
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      v2Authorities: 1,
      v2PhysicalRows: 1,
      aliasFamilies: 1,
      latestV2At: '2026-07-11T15:00:00.000Z',
    }, true, 0, '2026-07-11T15:05:00.000Z')).toMatchObject({
      phase: 'mixed-healthy',
      action: 'retain-writer',
      projectionObserved: true,
      projectionTickAt: '2026-07-11T15:05:00.000Z',
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      sourceState: 'degraded',
      invalidRows: 1,
    }, true, 1)).toMatchObject({
      phase: 'degraded', action: 'rollback-writer', invalidRows: 1,
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      limitExceeded: true,
    }, false, 0)).toMatchObject({
      phase: 'degraded', action: 'inspect-source', limitExceeded: true,
    });
    expect(buildRepairHandoffRolloutStatus({
      ...healthy,
      v2Authorities: 4,
      v2PhysicalRows: 4,
      currentActivationV2Authorities: 0,
      unboundV2Authorities: 4,
      latestV2At: '2026-07-11T15:00:00.000Z',
    }, true, 2, null, {
      activationAware: true,
      effective: true,
      activation: {
        id: '11111111-1111-4111-8111-111111111111',
        activatedAt: '2026-07-12T15:00:00.000Z',
      },
    })).toMatchObject({
      phase: 'awaiting-evidence',
      action: 'observe-writer',
      v2Authorities: 4,
      currentActivationV2Authorities: 0,
      unboundV2Authorities: 4,
    });
    expect(buildRepairHandoffRolloutStatus(healthy, true, 2, null, {
      activationAware: true,
      effective: false,
      blockedReason: 'shared-queue-filesystem',
    })).toMatchObject({
      phase: 'blocked',
      action: 'repair-writer-config',
      writerConfigured: true,
      writerEffective: false,
      writerBlockedReason: 'shared-queue-filesystem',
    });
  });

  it('does not report absent ordinary work when writer-on queue evidence is missing', async () => {
    const status = await buildFleetStatus(withFoundry({ repairHandoffV2Write: true }));
    expect(status.repairHandoffRollout).toMatchObject({
      writerEnabled: true,
      writerEffective: false,
      writerBlockedReason: 'missing-activation',
      phase: 'blocked',
      eligibleOrdinaryItems: null,
      action: 'repair-writer-config',
    });
  });

  it('reports a configured v2 writer as ineffective in filesystem shared-queue mode', async () => {
    const sharedPath = join(tmpHome, 'shared-fleet');
    mkdirSync(sharedPath, { recursive: true });
    const cfg = withFoundry({
      repairHandoffV2Write: true,
      repairHandoffV2Activation: {
        id: '11111111-1111-4111-8111-111111111111',
        activatedAt: '2026-07-12T15:00:00.000Z',
      },
    });
    cfg.fleet = { sharedQueue: { mode: 'filesystem', path: sharedPath } };
    const status = await buildFleetStatus(cfg);
    expect(status.repairHandoffRollout).toMatchObject({
      writerConfigured: true,
      writerEnabled: true,
      writerEffective: false,
      writerBlockedReason: 'shared-queue-filesystem',
      phase: 'blocked',
      action: 'repair-writer-config',
    });
  });

  it('blocks a configured v2 writer whose activation timestamp is in the future', async () => {
    const status = await buildFleetStatus(withFoundry({
      repairHandoffV2Write: true,
      repairHandoffV2Activation: {
        id: '11111111-1111-4111-8111-111111111111',
        activatedAt: '2999-01-01T00:00:00.000Z',
      },
    }));
    expect(status.repairHandoffRollout).toMatchObject({
      writerConfigured: true,
      writerEffective: false,
      writerBlockedReason: 'activation-in-future',
      phase: 'blocked',
      action: 'repair-writer-config',
    });
  });

  it('requires an exact persisted authority digest for projection evidence', () => {
    const tick = (ts: string, digest: string, activationId?: string): DaemonTick => ({
      ts,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-backlog',
      producerMaintenance: {
        selfHeal: false,
        invent: false,
        ancillary: false,
        proposalRepair: true,
        repairHandoffSourceState: 'healthy',
        repairHandoffAuthorityDigest: digest,
        ...(activationId ? {
          repairHandoffActivationId: activationId,
          repairHandoffActivatedAt: '2026-07-11T15:00:00.000Z',
          repairHandoffActivationAuthorities: 1,
          repairHandoffActivationAuthorityDigest: 'c'.repeat(64),
        } : {}),
        repairHandoffInvalidRows: 0,
        repairHandoffConflictingIds: 0,
        dispatchRepairLifecycleUnavailable: 0,
        repairHandoffCompactionUnavailable: 0,
        proposalRepairInboxAvailable: true,
      },
    });
    expect(repairHandoffProjectionTick([
      tick('2026-07-11T16:00:00.000Z', 'a'.repeat(64)),
    ], 'b'.repeat(64))).toBeNull();
    expect(repairHandoffProjectionTick([
      tick('2026-07-10T13:00:00.000Z', 'b'.repeat(64)),
    ], 'b'.repeat(64))).toBe('2026-07-10T13:00:00.000Z');
    const proof = {
      id: '22222222-2222-4222-8222-222222222222',
      activatedAt: '2026-07-11T15:00:00.000Z',
      authorities: 1,
      authorityDigest: 'c'.repeat(64),
    };
    expect(repairHandoffProjectionTick([
      tick('2026-07-11T16:00:00.000Z', 'b'.repeat(64), '11111111-1111-4111-8111-111111111111'),
    ], 'b'.repeat(64), proof.activatedAt, proof)).toBeNull();
    expect(repairHandoffProjectionTick([
      tick('2026-07-11T16:00:00.000Z', 'b'.repeat(64), proof.id),
    ], 'b'.repeat(64), proof.activatedAt, proof)).toBe('2026-07-11T16:00:00.000Z');

    const retainedUnavailable = tick('2026-07-11T17:00:00.000Z', 'b'.repeat(64), proof.id);
    retainedUnavailable.producerMaintenance!.dispatchRepairLifecycleUnavailable = 2;
    expect(repairHandoffProjectionTick([
      retainedUnavailable,
    ], 'b'.repeat(64), proof.activatedAt, proof)).toBe('2026-07-11T17:00:00.000Z');

    const degradedProposals = tick('2026-07-11T18:00:00.000Z', 'b'.repeat(64), proof.id);
    degradedProposals.producerMaintenance!.proposalRepairInboxAvailable = false;
    expect(repairHandoffProjectionTick([
      degradedProposals,
    ], 'b'.repeat(64), proof.activatedAt, proof)).toBeNull();
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
        generatedAt: new Date().toISOString(),
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

  it('keeps applied and verified milestones actionable without a realized witness', async () => {
    const repo = join(tmpHome, 'repo-focus-complete');
    writeBacklogSnapshot(tmpHome, repo, []);
    const proposal = createProposal(
      {
        repo,
        origin: 'agent',
        kind: 'patch',
        title: 'Verified goal milestone',
        summary: 'verified goal milestone',
        diff: docsDiff('goal-focus-complete'),
        verifyResult: { passed: true, source: 'manual' },
      },
      baseConfig(),
    );
    setStatus(proposal.id, 'applied');
    const goal = makeGoalRecord(repo, 'goal-focus-complete');
    goal.milestones[0]!.proposalId = proposal.id;
    writeGoalRecords(tmpHome, [goal]);

    const s = await buildFleetStatus(withFoundry({ goalFocusActiveThreshold: 1 }));

    expect(s.goalFocus).toMatchObject({
      activeGoalCount: 1,
      actionableActiveGoalCount: 1,
      deferredNewGoalWork: true,
      reason: 'active-goal-work-in-flight',
    });
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

  it('projects ordinary work while retaining route-blocked generated work as visible inventory', async () => {
    const repo = join(tmpHome, 'repo');
    const ordinary = makeBacklogItem(repo, 'repo:goal:ordinary', 'Ordinary work', 5);
    const active = makeTrustedProposalRepairItem(repo);
    writeBacklogSnapshot(tmpHome, repo, [ordinary, active]);

    expect(generatedRepairDispatchState(ordinary)).toEqual({
      applies: false,
      state: 'not-applicable',
      dispatchable: true,
    });
    expect(generatedRepairDispatchState(active)).toEqual({
      applies: true,
      state: 'active',
      dispatchable: true,
      disposition: 'active',
    });

    writeRunningDaemon(tmpHome);
    const status = await buildFleetStatus(baseConfig());
    expect(status.queue).toMatchObject({
      backlogItems: 2,
      eligibleBacklogItems: 1,
      cooldownItems: 0,
      pendingItems: 0,
      repairRouteBlockedItems: 1,
    });
    expect(status.queue.repairControlBlockedItems).toBeUndefined();
    expect(status.queue.next?.map((item) => item.id)).toEqual([ordinary.id]);
    expect(status.queue.generatedRepairRoutes).toEqual({
      scope: 'eligible-claim-candidates',
      authority: 'observation-only',
      trustedItems: 1,
      feasibleItems: 0,
      unavailableItems: 1,
      requiresAlternativeItems: 0,
      byReason: [{ reason: 'editing-backend-unavailable', count: 1 }],
      blockedItems: [{ itemId: active.id, reason: 'editing-backend-unavailable' }],
    });
    const actionIds = status.nextActions?.map((action) => action.id) ?? [];
    expect(actionIds.indexOf('build-backlog')).toBeGreaterThanOrEqual(0);
    expect(actionIds.indexOf('build-backlog')).toBeLessThan(actionIds.indexOf('restore-repair-routes'));
  });

  it('projects a fresh trusted ordinary repair through deterministic frontier capacity', async () => {
    const repo = join(tmpHome, 'repo');
    const repair = makeTrustedProposalRepairItem(repo);
    writeBacklogSnapshot(tmpHome, repo, [repair]);
    writeRunningDaemon(tmpHome);

    const status = await buildFleetStatus(withRoutableFrontierAndMid());

    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 1,
      generatedRepairRoutes: {
        trustedItems: 1,
        feasibleItems: 1,
        unavailableItems: 0,
        requiresAlternativeItems: 0,
        byReason: [{ reason: 'feasible', count: 1 }],
      },
    });
    expect(status.queue.repairRouteBlockedItems).toBeUndefined();
    expect(status.queue.generatedRepairRoutes?.blockedItems).toBeUndefined();
    expect(status.queue.next?.map((item) => item.id)).toEqual([repair.id]);
  });

  it('pairs and sorts bounded row-level evidence for route-infeasible trusted repairs', async () => {
    const repo = join(tmpHome, 'repo-sensitive-path');
    const editingBlocked = {
      ...makeTrustedProposalRepairItem(repo, 'repo:proposal-repair:ffffffffffff'),
      title: 'Proposal repair: sensitive-title-evidence',
      detail:
        'Proposal repair: sensitive-detail-evidence.\n' +
        'Proposal: sensitive-goal-evidence\n' +
        'Original work item: repo:goal:sensitive\n' +
        'Produce a fresh complete fix and verify it.',
    };
    const provenanceBlocked = {
      ...makeTrustedProposalRepairItem(repo, 'repo:proposal-repair:aaaaaaaaaaaa'),
      title: 'Proposal repair: second-sensitive-title-evidence',
      detail:
        'Proposal repair: second-sensitive-detail-evidence.\n' +
        'Proposal: second-sensitive-goal-evidence\n' +
        'Original work item: repo:goal:second-sensitive\n' +
        'Produce a fresh complete fix and verify it.',
    };
    writeBacklogSnapshot(tmpHome, repo, [editingBlocked, provenanceBlocked]);
    writeRunningDaemon(tmpHome);
    const inspection = vi.spyOn(fleetRouter, 'inspectGeneratedRepairRouteFeasibility')
      .mockImplementation((item) => ({
        feasible: false,
        requiredTier: null,
        requiresAlternative: false,
        backend: null,
        reason: item.id === provenanceBlocked.id
          ? 'provenance-unavailable'
          : 'editing-backend-unavailable',
      }));

    try {
      const status = await buildFleetStatus(baseConfig());
      const routes = status.queue.generatedRepairRoutes;

      expect(status.queue.repairRouteBlockedItems).toBe(2);
      expect(status.queue.repairControlBlockedItems).toBeUndefined();
      expect(routes?.blockedItems).toEqual([
        { itemId: provenanceBlocked.id, reason: 'provenance-unavailable' },
        { itemId: editingBlocked.id, reason: 'editing-backend-unavailable' },
      ]);
      expect(routes?.blockedItems).toHaveLength(status.queue.repairRouteBlockedItems!);
      expect(routes?.blockedItems?.every((row) => row.reason !== 'feasible')).toBe(true);
      expect(routes?.blockedItems?.map((row) => Object.keys(row).sort())).toEqual([
        ['itemId', 'reason'],
        ['itemId', 'reason'],
      ]);
      const evidence = JSON.stringify(routes?.blockedItems);
      for (const raw of [
        repo,
        editingBlocked.title,
        editingBlocked.detail,
        provenanceBlocked.title,
        provenanceBlocked.detail,
        'sensitive-title-evidence',
        'sensitive-detail-evidence',
        'sensitive-goal-evidence',
        'local-coder',
        'mid',
        'lifecycle',
      ]) {
        expect(evidence).not.toContain(raw);
      }
    } finally {
      inspection.mockRestore();
    }
  });

  it('records bounded inspection-unavailable row evidence when route inspection fails', async () => {
    const repo = join(tmpHome, 'repo');
    const repair = makeTrustedProposalRepairItem(repo);
    writeBacklogSnapshot(tmpHome, repo, [repair]);
    writeRunningDaemon(tmpHome);
    const inspection = vi.spyOn(fleetRouter, 'inspectGeneratedRepairRouteFeasibility')
      .mockImplementation(() => { throw new Error('sensitive inspection failure'); });

    try {
      const status = await buildFleetStatus(withRoutableFrontierAndMid());

      expect(status.queue.repairRouteBlockedItems).toBe(1);
      expect(status.queue.generatedRepairRoutes?.blockedItems).toEqual([
        { itemId: repair.id, reason: 'inspection-unavailable' },
      ]);
      expect(status.queue.generatedRepairRoutes?.blockedItems).toHaveLength(
        status.queue.repairRouteBlockedItems!,
      );
      expect(JSON.stringify(status.queue.generatedRepairRoutes?.blockedItems))
        .not.toContain('sensitive inspection failure');
    } finally {
      inspection.mockRestore();
    }
  });

  it('caps route-block rows, reports omissions, and hashes oversized item ids', async () => {
    const repo = join(tmpHome, 'repo');
    const repairs = Array.from({ length: 52 }, (_, index) => {
      const prefix = index === 0 ? 'r'.repeat(220) : 'zrepo';
      return makeTrustedProposalRepairItem(
        repo,
        `${prefix}:proposal-repair:${index.toString(16).padStart(12, '0')}`,
      );
    });
    writeBacklogSnapshot(tmpHome, repo, repairs);
    writeRunningDaemon(tmpHome);

    const status = await buildFleetStatus(baseConfig());
    const routes = status.queue.generatedRepairRoutes;

    expect(status.queue.repairRouteBlockedItems).toBe(52);
    expect(routes?.blockedItems).toHaveLength(50);
    expect(routes?.blockedItemsOmitted).toBe(2);
    expect((routes?.blockedItems?.length ?? 0) + (routes?.blockedItemsOmitted ?? 0)).toBe(
      status.queue.repairRouteBlockedItems,
    );
    expect(routes?.blockedItems?.every((row) => row.itemId.length <= 160)).toBe(true);
    expect(routes?.blockedItems?.some((row) => /^sha256:[a-f0-9]{64}$/.test(row.itemId))).toBe(true);
  });

  it('withholds trusted repairs when proposal repair dispatch is disabled', async () => {
    const repo = join(tmpHome, 'repo');
    const repair = makeTrustedProposalRepairItem(repo);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [repair]);

    const status = await buildFleetStatus(withRoutableMid({ proposalRepair: false }));

    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 0,
      repairControlBlockedItems: 1,
    });
    expect(status.queue.next).toBeUndefined();
    expect(status.queue.repairRouteBlockedItems).toBeUndefined();
  });

  it('withholds trusted repairs in filesystem shared-queue mode', async () => {
    const repo = join(tmpHome, 'repo');
    const repair = makeTrustedProposalRepairItem(repo);
    writeRunningDaemon(tmpHome);
    writeBacklogSnapshot(tmpHome, repo, [repair]);
    const cfg = withRoutableMid();
    cfg.fleet = { sharedQueue: { mode: 'filesystem', path: join(tmpHome, 'shared-queue') } };

    const status = await buildFleetStatus(cfg);

    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 0,
      repairControlBlockedItems: 1,
    });
    expect(status.queue.next).toBeUndefined();
    expect(status.queue.repairRouteBlockedItems).toBeUndefined();
  });

  it('does not create lifecycle storage or a failure marker while building status', async () => {
    const repo = join(tmpHome, 'repo');
    const fleetDir = join(tmpHome, '.ashlr', 'fleet');
    const lifecyclePath = join(fleetDir, 'generated-repair-lifecycle.json');
    writeBacklogSnapshot(tmpHome, repo, [makeTrustedProposalRepairItem(repo)]);
    expect(existsSync(fleetDir)).toBe(false);

    const status = await buildFleetStatus(baseConfig());

    expect(status.queue.eligibleBacklogItems).toBe(0);
    expect(status.queue.repairRouteBlockedItems).toBe(1);
    expect(status.queue.next).toBeUndefined();
    expect(status.queue.generatedRepairRoutes).toMatchObject({
      authority: 'observation-only',
      trustedItems: 1,
      unavailableItems: 1,
    });
    expect(existsSync(fleetDir)).toBe(false);
    expect(existsSync(lifecyclePath)).toBe(false);
    expect(existsSync(`${lifecyclePath}.failed`)).toBe(false);
  });

  it('retains an active retry with no configured editing alternative without advertising it as eligible', async () => {
    const repo = join(tmpHome, 'repo');
    const retry = makeTrustedProposalRepairItem(repo, 'repo:proposal-repair:dddddddddddd');
    recordGeneratedRepairLifecycle(retry, {
      kind: 'empty-diff',
      attemptId: 'attempt-12345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
      tier: 'mid',
    });
    writeBacklogSnapshot(tmpHome, repo, [retry]);
    writeRunningDaemon(tmpHome);

    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));

    expect(status.queue.eligibleBacklogItems).toBe(0);
    expect(status.queue.repairRouteBlockedItems).toBe(1);
    expect(status.queue.next).toBeUndefined();
    expect(status.queue.generatedRepairRoutes).toEqual({
      scope: 'eligible-claim-candidates',
      authority: 'observation-only',
      trustedItems: 1,
      feasibleItems: 0,
      unavailableItems: 1,
      requiresAlternativeItems: 1,
      byReason: [{ reason: 'editing-backend-unavailable', count: 1 }],
      blockedItems: [{ itemId: retry.id, reason: 'editing-backend-unavailable' }],
    });
    expect(status.autonomyEffectiveness).toMatchObject({
      phase: 'route-gated',
      bottleneck: 'routing',
      counts: { repairRouteBlockedItems: 1 },
    });
    expect(status.nextActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'restore-repair-routes' }),
    ]));
    expect(status.autonomousShipReadiness?.topBlocker).toMatchObject({
      id: 'repair-route-unavailable',
      source: 'queue',
    });
  });

  it('does not chmod an existing lifecycle directory while building status', async () => {
    const repo = join(tmpHome, 'repo');
    const fleetDir = join(tmpHome, '.ashlr', 'fleet');
    writeBacklogSnapshot(tmpHome, repo, [makeTrustedProposalRepairItem(repo)]);
    mkdirSync(fleetDir, { recursive: true, mode: 0o750 });
    if (process.platform !== 'win32') chmodSync(fleetDir, 0o750);
    const beforeMode = statSync(fleetDir).mode & 0o777;

    await buildFleetStatus(baseConfig());

    expect(statSync(fleetDir).mode & 0o777).toBe(beforeMode);
    expect(existsSync(join(fleetDir, 'generated-repair-lifecycle.json.failed'))).toBe(false);
  });

  it('keeps lifecycle-unavailable generated repairs visible but ineligible', async () => {
    const repo = join(tmpHome, 'repo');
    const ordinary = makeBacklogItem(repo, 'repo:goal:ordinary', 'Ordinary work', 5);
    const unavailable = {
      ...makeTrustedProposalRepairItem(repo, 'repo:proposal-repair:bbbbbbbbbbbb'),
      repairHandoffId: 'a'.repeat(64),
      repairGenerationId: 'b'.repeat(64),
    };
    writeBacklogSnapshot(tmpHome, repo, [unavailable, ordinary]);

    expect(generatedRepairDispatchState(unavailable)).toEqual({
      applies: true,
      state: 'lifecycle-unavailable',
      dispatchable: false,
    });

    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));
    expect(status.queue).toMatchObject({
      backlogItems: 2,
      eligibleBacklogItems: 1,
      cooldownItems: 0,
      pendingItems: 0,
      repairControlBlockedItems: 1,
      repairLifecycleUnavailableItems: 1,
    });
    expect(status.queue.next?.map((item) => item.id)).toEqual([ordinary.id]);
    expect(status.queue.generatedRepairRoutes).toBeUndefined();
  });

  it('fails closed for an untrusted repair-shaped queue row', async () => {
    const repo = join(tmpHome, 'repo');
    const malformed = makeTrustedProposalRepairItem(repo, 'repo:manual-repair');
    writeBacklogSnapshot(tmpHome, repo, [malformed]);
    writeRunningDaemon(tmpHome);

    expect(generatedRepairDispatchState(malformed)).toEqual({
      applies: true,
      state: 'lifecycle-unavailable',
      dispatchable: false,
    });
    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));
    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 0,
      repairControlBlockedItems: 1,
      repairLifecycleUnavailableItems: 1,
    });
    expect(status.nextActions).toContainEqual(expect.objectContaining({
      id: 'inspect-repair-lifecycle-control',
    }));
    expect(status.autonomousShipReadiness?.topBlocker?.id).toBe('repair-lifecycle-control-blocked');
  });

  it('keeps quarantined generated repairs visible but terminal and ineligible', async () => {
    const repo = join(tmpHome, 'repo');
    const quarantined = makeTrustedDiagnosticResliceItem(repo, 'cccccccccccc');
    recordDiagnosticEmpty(
      quarantined,
      'attempt-22345678-1234-4123-8123-123456789abc',
      'local-coder',
      1,
    );
    expect(recordDiagnosticEmpty(
      quarantined,
      'attempt-32345678-1234-4123-8123-123456789abc',
      'kimi',
      2,
    )).toMatchObject({ disposition: 'quarantined' });
    writeBacklogSnapshot(tmpHome, repo, [quarantined]);
    writeRunningDaemon(tmpHome);

    expect(generatedRepairDispatchState(quarantined)).toEqual({
      applies: true,
      state: 'terminal',
      dispatchable: false,
      disposition: 'quarantined',
    });

    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification' },
    }));
    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 0,
      cooldownItems: 0,
      pendingItems: 0,
      repairControlBlockedItems: 1,
      repairTerminalItems: 1,
      repairQuarantinedItems: 1,
    });
    expect(status.queue.next).toBeUndefined();
    expect(status.queue.generatedRepairRoutes).toBeUndefined();
    expect(status.nextActions).toContainEqual(expect.objectContaining({
      id: 'inspect-repair-lifecycle-control',
    }));
    expect(status.autonomousShipReadiness?.topBlocker?.id).toBe('repair-lifecycle-control-blocked');
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
    writeBacklogSnapshot(tmpHome, repo, [item], '2026-07-03T00:00:00.000Z');
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
        generatedAt: new Date().toISOString(),
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

    const s = await buildFleetStatus(withRoutableMid());

    expect(s.dispatchProductionSource).toMatchObject({
      sourceState: 'healthy',
      sourcePresent: true,
      complete: true,
      filesRead: 1,
      invalidRows: 0,
    });
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
    expect(formatted).toContain('source:    healthy; files 1');
    expect(formatted).toContain('proposals 1/3');
    expect(formatted).toContain('shape:     no-diff 1, gate/capture 1, repairs 1, policy-off 0');
    expect(formatted).toContain('repair yield: capture 1 attempt; 1/1 converted (100%)');
    expect(formatted).toContain('diagnosis: healthy · fleet 1/3 33% · keep routing');
    expect(formatted).toContain('local-coder 0/2 0%');
    expect(formatted).toContain('codex 1/1 100%');
  });

  it('surfaces degraded dispatch source quality and withholds yield diagnosis', async () => {
    const now = new Date().toISOString();
    recordDispatchProduction({
      schemaVersion: 1,
      ts: now,
      itemId: 'valid-partial-source',
      source: 'goal',
      repo: '/repo/a',
      title: 'Valid partial source row',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'local-mid bulk',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0.001,
      basis: 'run-proposal-outcome',
    });
    const dir = join(process.env.ASHLR_HOME!, 'dispatch-production');
    const path = join(dir, `${now.slice(0, 10)}.jsonl`);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not-json\n`, 'utf8');

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({ events: 1 });
    expect(s.dispatchProductionSource).toMatchObject({
      sourceState: 'degraded',
      complete: false,
      invalidRows: 1,
    });
    expect(s.dispatchYieldDiagnostics).toBeUndefined();
    expect(formatFleetStatus(s)).toContain('source:    degraded (partial)');
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
    expect(s.dispatchManifestSource).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      rowsScanned: 1,
      invalidRows: 0,
    });
    expect(s.dispatchManifests?.recent[0]).toMatchObject({
      manifestId: 'dm-test-1',
      assigned: 2,
      unassigned: 1,
      backends: { codex: 2 },
    });

    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('manifests: 1 event(s), assigned 2, unassigned 1');
    expect(formatted).toContain('manifest source: healthy;');
    expect(formatted).toContain('manifest backends: codex:2');
    expect(s.autonomousShipReadiness?.evidenceMatrix?.sources.find(
      (source) => source.id === 'dispatch-manifests',
    )).toMatchObject({ eligibility: 'not-applicable', evidenceRole: 'forensics' });
  });

  it('marks complete Best-of-N evidence eligible only when candidate racing is enabled', async () => {
    const now = new Date().toISOString();
    recordBestOfN({
      ts: now,
      source: 'todo',
      repo: '/repo/a',
      n: 1,
      winnerIndex: 0,
      winnerProposalId: 'proposal-best',
      totalCostUsd: 0.01,
      candidates: [{
        index: 0,
        engine: 'codex',
        model: 'gpt-5.5',
        score: 1,
        proposalId: 'proposal-best',
        won: true,
      }],
    });

    const status = await buildFleetStatus(withFoundry({ bestOfN: 2 }));
    expect(status.bestOfNSource).toMatchObject({
      sourceState: 'healthy', complete: true, invalidRows: 0, rowsScanned: 1,
    });
    expect(status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
      (source) => source.id === 'best-of-n',
    )).toMatchObject({
      category: 'evidence', evidenceRole: 'learning', eligibility: 'eligible', applicability: 'optional',
      status: 'healthy', evidenceQuality: { complete: true, rowsScanned: 1, invalidRows: 0 },
    });
  });

  it('withholds stale Best-of-N evidence rather than refreshing it through the analytics window', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
    await withFakeNow(now, async () => {
      recordBestOfN({
        ts: staleAt,
        source: 'todo',
        repo: '/repo/stale-best-of-n',
        n: 1,
        winnerIndex: 0,
        winnerProposalId: 'proposal-stale-best-of-n',
        totalCostUsd: 0,
        candidates: [{
          index: 0, engine: 'codex', model: 'gpt-5.5', score: 1,
          proposalId: 'proposal-stale-best-of-n', won: true,
        }],
      });
      const status = await buildFleetStatus(withFoundry({ bestOfN: 2 }));
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'best-of-n',
      );

      expect(status.bestOfNSource).toMatchObject({ sourceState: 'healthy', complete: true, latestAt: staleAt });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'withheld', evidenceRole: 'learning',
        sourceQuality: { badge: 'stale-source' },
      });
    });
  });

  it('marks stale dispatch intent as observational rather than fresh evidence', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
    await withFakeNow(now, async () => {
      recordDispatchManifest({
        schemaVersion: 1,
        manifestId: 'dm-stale-observation',
        ts: staleAt,
        mode: 'concurrent',
        dryRun: false,
        claimedItemIds: ['item-stale'],
        assignments: [{ itemId: 'item-stale', source: 'todo', repo: '/repo/stale-manifest', title: 'Stale', backend: 'codex' }],
        unassigned: [],
        slots: { codex: 1 },
        backendCounts: { codex: 1 },
        counts: { claimed: 1, assigned: 1, unassigned: 0 },
      });
      const status = await buildFleetStatus(withFoundry({ fabric: { concurrentDispatch: true } }));
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'dispatch-manifests',
      );

      expect(status.dispatchManifestSource).toMatchObject({ sourceState: 'healthy', complete: true, latestAt: staleAt });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'observational', evidenceRole: 'forensics',
        sourceQuality: { badge: 'stale-source' },
      });
    });
  });

  it('withholds concurrent manifest aggregates when their source is partial', async () => {
    const event = {
      schemaVersion: 1 as const,
      manifestId: 'dm-partial',
      ts: '2026-07-10T00:00:00.000Z',
      mode: 'concurrent' as const,
      dryRun: false,
      claimedItemIds: ['item-a'],
      assignments: [{ itemId: 'item-a', source: 'todo' as const, repo: '/repo/a', title: 'A', backend: 'codex' as const }],
      unassigned: [],
      slots: { codex: 1 },
      backendCounts: { codex: 1 },
      counts: { claimed: 1, assigned: 1, unassigned: 0 },
    };
    recordDispatchManifest(event);
    const file = join(process.env.ASHLR_HOME!, 'dispatch-manifests', '2026-07-10.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}not-json\n`, 'utf8');

    const status = await buildFleetStatus(withFoundry({ fabric: { concurrentDispatch: true } }));
    expect(status.dispatchManifestSource).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(status.dispatchManifests).toBeUndefined();
    expect(formatFleetStatus(status)).toContain('manifest source: degraded (partial);');
    expect(status.autonomousShipReadiness?.evidenceMatrix).not.toMatchObject({ state: 'degraded' });
    expect(status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
      (source) => source.id === 'dispatch-manifests',
    )).toMatchObject({ evidenceRole: 'forensics', eligibility: 'observational', status: 'degraded' });
    expect(status.nextActions?.find((action) => action.id === 'inspect-learning-evidence'))
      .toBeUndefined();
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

  it('withholds stale agent-action evidence without treating an empty readable ledger as stale', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const repo = join(tmpHome, 'repo-agent-action-freshness');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(tmpHome, '.ashlr'), { recursive: true });
    writeFileSync(join(tmpHome, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');

    await withFakeNow(now, async () => {
      recordAgentAction({
        schemaVersion: 1,
        ts: new Date(now.getTime() - 31 * 60 * 1000).toISOString(),
        machineId: 'm49',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'daemon:dispatch',
        summary: 'stale action fixture',
        repo,
        itemId: 'stale-action',
        source: 'goal',
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        reason: 'fixture',
        spentUsd: 0,
      });

      const staleStatus = await buildFleetStatus(baseConfig());
      const staleEvidence = staleStatus.autonomousShipReadiness?.evidenceMatrix?.sources
        .find((source) => source.id === 'agent-actions');

      expect(staleStatus.workspace?.sourceQuality).toMatchObject({ sourceState: 'healthy', complete: true });
      expect(staleEvidence).toMatchObject({
        status: 'degraded',
        freshness: 'stale',
        eligibility: 'withheld',
        sourceQuality: { badge: 'stale-source' },
      });
      expect(staleStatus.autonomousShipReadiness?.evidenceMatrix?.state).toBe('degraded');
    });

    const freshNow = new Date('2026-07-20T13:00:00.000Z');
    await withFakeNow(freshNow, async () => {
      recordAgentAction({
        schemaVersion: 1,
        ts: freshNow.toISOString(),
        machineId: 'm49',
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'daemon:dispatch',
        summary: 'fresh action fixture',
        repo,
        itemId: 'fresh-action',
        source: 'goal',
        backend: 'local-coder',
        tier: 'mid',
        model: 'qwen',
        reason: 'fixture',
        spentUsd: 0,
      });

      const freshStatus = await buildFleetStatus(baseConfig());
      expect(freshStatus.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'agent-actions',
      )).toMatchObject({ status: 'healthy', freshness: 'fresh', eligibility: 'eligible' });
    });

    const emptyHome = tmpHome;
    const actionDir = join(emptyHome, '.ashlr', 'agent-actions');
    rmSync(actionDir, { recursive: true, force: true });
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(join(actionDir, '2026-07-21.jsonl'), '', 'utf8');
    await withFakeNow(new Date('2026-07-21T12:00:00.000Z'), async () => {
      const emptyStatus = await buildFleetStatus(baseConfig());
      expect(emptyStatus.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'agent-actions',
      )).toMatchObject({ status: 'healthy', freshness: 'fresh', eligibility: 'eligible', sourceQuality: { badge: 'healthy-zero' } });
    });
  });

  it('withholds stale decision authority while retaining its structural source health', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await withFakeNow(now, async () => {
      recordDecision({
        ts: new Date(now.getTime() - 31 * 60 * 1000).toISOString(),
        proposalId: 'stale-decision-authority',
        action: 'judged',
        verdict: 'ship',
        reason: 'fixture',
      });
      const status = await buildFleetStatus(baseConfig());
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'decisions',
      );

      expect(status.decisionsSource).toMatchObject({ sourceState: 'healthy', complete: true });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'withheld', applicability: 'required',
        sourceQuality: { badge: 'stale-source' },
      });
      expect(status.autonomousShipReadiness?.evidenceMatrix?.state).toBe('degraded');
    });
  });

  it('withholds stale judge outcomes while retaining their structural source health', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    await withFakeNow(now, async () => {
      recordJudgeTrace({
        proposalId: 'stale-judge-outcome',
        judgeEngine: 'claude',
        verdict: 'ship',
        scores: { value: 5, correctness: 5, scope: 5, alignment: 5 },
        ts: new Date(now.getTime() - 31 * 60 * 1000).toISOString(),
      });
      const status = await buildFleetStatus(baseConfig());
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'judge-traces',
      );

      expect(status.judgeTraceSource).toMatchObject({ sourceState: 'healthy', complete: true });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'withheld', evidenceRole: 'learning',
        sourceQuality: { badge: 'stale-source' },
      });
    });
  });

  it('marks stale post-merge evidence as observational rather than freshly generated', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 31 * 60 * 1000).toISOString();
    await withFakeNow(now, async () => {
      recordPostMergeObservation({
        observedAt: staleAt,
        outcome: 'regressed',
        basis: 'bisect-first-bad',
        confidence: 'heuristic',
        repo: join(tmpHome, 'post-merge-stale-repo'),
        proposalId: 'post-merge-stale-proposal',
        mergeCommit: 'a'.repeat(40),
        observedHead: 'b'.repeat(40),
      });
      const status = await buildFleetStatus(baseConfig());
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'post-merge',
      );

      expect(status.postMergeSource).toMatchObject({
        sourceState: 'healthy', complete: true, latestAt: staleAt,
      });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'observational', evidenceRole: 'forensics',
        sourceQuality: { badge: 'stale-source' },
      });
    });
  });

  it('withholds stale dispatch outcomes even when the rolling yield window is empty', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z');
    const staleAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    await withFakeNow(now, async () => {
      recordDispatchProduction({
        schemaVersion: 1,
        ts: staleAt,
        machineId: 'm49',
        itemId: 'stale-dispatch-outcome',
        source: 'goal',
        repo: '/repo/stale-dispatch',
        title: 'Stale dispatch fixture',
        backend: 'local-coder',
        tier: 'mid',
        assignedBy: 'daemon',
        routeReason: 'fixture',
        outcome: 'empty-diff',
        proposalCreated: false,
        spentUsd: 0,
        basis: 'run-proposal-outcome',
      });
      const status = await buildFleetStatus(baseConfig());
      const evidence = status.autonomousShipReadiness?.evidenceMatrix?.sources.find(
        (source) => source.id === 'dispatch-production',
      );

      expect(status.dispatchProduction).toBeUndefined();
      expect(status.dispatchProductionSource).toMatchObject({
        sourceState: 'healthy', complete: true,
        latestAt: staleAt,
      });
      expect(evidence).toMatchObject({
        status: 'degraded', freshness: 'stale', eligibility: 'withheld', evidenceRole: 'analytics',
        sourceQuality: { badge: 'stale-source' },
      });
    });
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
    expect(s.trajectoryLearning?.traces).toMatchObject({
      state: 'available',
      records: [expect.objectContaining({
        ref: expect.stringMatching(/^trajectory:[a-f0-9]{12}$/),
        sourceState: expect.stringMatching(/^(complete|incomplete|degraded)$/),
      })],
    });
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(repo);
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(itemId);
    expect(JSON.stringify(s.trajectoryLearning)).not.toContain(proposal.id);
    const formatted = formatFleetStatus(s);
    expect(formatted).toContain('Attempt coverage:');
    expect(formatted).toContain('attempts:  1 in 24h');
    expect(formatted).toContain('learning:  diagnostic 1/1 (100%), no-proposal 0, policy-suppressed 0, cancelled 0');
    expect(formatted).toContain('joins:     actions 1 (100%), worked 1 (100%), decisions 1 (100%), evidence 1 (100%)');
    expect(formatted).toContain('metadata:  trajectory 1 (100%), route 1 (100%), run 1 (100%)');
    expect(formatted).toContain('policy:    version 1 (100%), current 1 (100%), epoch 1 (100%), current epoch 1 (100%)');
    expect(formatted).toContain('labels:    authoritative 1 (100%), current 1 (100%)');
    expect(formatted).toContain('Trajectory learning:');
    expect(formatted).toContain('Recent trajectory traces:');
    expect(formatted).toContain('trajectories: 1 in 24h');
    expect(formatted).toContain(
      'outcomes:     merged 0, pending 1, no-proposal 0, cancelled 0, failed 0',
    );
    expect(formatted).toContain('spine:        dispatch->decision 1 (100%), dispatch->evidence 1 (100%), dispatch->merge 0 (0%)');
    expect(formatted).toContain('coverage:     dispatch 1 (100%), proposal 1 (100%), evidence 1 (100%), decision 1 (100%)');
    expect(formatted).toContain('skill observations:');
    expect(formatted).not.toContain('skill shadow:');
  });

  it('prints degraded trajectory traces as withheld dispatch history, never an empty trace list', () => {
    const formatted = formatFleetStatus({
      generatedAt: '2026-07-21T12:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      trajectoryLearning: {
        version: 1,
        windowHours: 24,
        trajectories: 0,
        terminalOutcomes: { merged: 0, rejected: 0, handoff: 0, pending: 0, 'no-proposal': 0, failed: 0, unknown: 0 },
        realizedOutcomes: { 'followed-up': 0, reverted: 0, regressed: 0 },
        coverage: {
          dispatch: { count: 0, rate: 0 },
          proposal: { count: 0, rate: 0 },
          evidence: { count: 0, rate: 0 },
          decision: { count: 0, rate: 0 },
          agentAction: { count: 0, rate: 0 },
        },
        routeSpine: {
          dispatchToDecision: { count: 0, rate: 0 },
          dispatchToEvidence: { count: 0, rate: 0 },
          dispatchToMerge: { count: 0, rate: 0 },
        },
        skillObservation: { eventState: 'none', sampleState: 'none' },
        traces: { state: 'degraded', records: [] },
        gaps: [],
        recent: [],
      },
      killed: false,
    } as any);
    expect(formatted).toContain('Recent trajectory traces: degraded (partial dispatch history withheld)');
    expect(formatted).not.toContain('Recent trajectory traces: none');
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
      diagnosticAttempts: 3,
      diagnosticNoProposal: 2,
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
        noProposal: 2,
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
          makeTrustedCaptureRepairItem(repo),
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

    const s = await buildFleetStatus(withRoutableMid());
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
    expect(repairAction?.detail).toContain('First: Dispatch capture repair: complete the failed proposal capture.');
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
      makeTrustedCaptureRepairItem(
        repo,
        'repo:proposal-repair-capture:fedcba987654',
        9,
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

    const s = await buildFleetStatus(withRoutableMid({ autoMerge: { enabled: true, trustBasis: 'verification' } }));
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
    const repair = makeTrustedCaptureRepairItem(
      repo,
      'repo:proposal-repair-capture:c0011a123456',
      9,
    );
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [repair, fresh], now);
    recordOutcome(generatedRepairCooldownKey(repair), 'empty', now);
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
    recordOutcome(generatedRepairCooldownKey(repair), 'empty', new Date(Date.now() - 31 * 60 * 1000).toISOString());

    const s = await buildFleetStatus(withRoutableMid());

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

  it('projects the same five-minute dispatch-blocked repair cooldown used by the daemon', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const now = new Date().toISOString();
    const repair = makeTrustedDiagnosticResliceItem(repo, '454545454545', 9);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-after-block', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [repair, fresh], now);
    recordOutcome(generatedRepairCooldownKey(repair), 'dispatch-blocked', new Date(Date.now() - 6 * 60 * 1000).toISOString());

    const s = await buildFleetStatus(withRoutableMid());

    expect(s.queue.cooldownItems).toBe(0);
    expect(s.queue.eligibleBacklogItems).toBe(2);
    expect(s.queue.next?.[0]).toMatchObject({ id: repair.id });
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
    recordOutcome(generatedRepairCooldownKey(repair), 'judged-decline', new Date(Date.now() - 31 * 60 * 1000).toISOString());

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
        items: [makeTrustedDiagnosticResliceItem(repo, '666666666666', 9)],
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

    const s = await buildFleetStatus(withRoutableMid());
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
    expect(drainAction?.detail).toContain('First: Reslice no-diff dispatch for repo item repo:goal:stalled.');
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
    const stalledStatus = await buildFleetStatus(withRoutableMid());
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
    const reslice = makeTrustedDiagnosticResliceItem(repo, '777777777777', 9);
    const fresh = makeBacklogItem(repo, 'repo:goal:fresh-generic', 'Fresh generic work', 2, 'goal');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], now);
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    writeBacklogSnapshot(tmpHome, repo, [reslice, fresh], now);
    recordOutcome(generatedRepairCooldownKey(reslice), 'empty', now);
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
        items: [makeTrustedDiagnosticResliceItem(repo, '888888888888', 9)],
      }),
      'utf8',
    );
    const cfg = withRoutableMid({
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
      backend: 'local-coder',
      diagnosticAttempts: 3,
      diagnosticNoProposal: 3,
    });
    expect(s.dispatchProduction?.byBackend.find((bucket) => bucket.backend === 'codex')).toMatchObject({
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
    expect(formatted).toContain('learning:  diagnostic 0/0 (—), no-proposal 0, policy-suppressed 4, cancelled 0');
    expect(formatted).not.toContain('proposal filing disabled');
  });

  it('subtracts cancelled outcomes from dispatch-yield diagnostic attempts', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(ashlrDir, 'enrollment.json'), JSON.stringify({ repos: [repo] }), 'utf8');
    const baseEvent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      machineId: 'm49',
      itemId: 'diagnostic-a',
      source: 'goal',
      repo,
      title: 'Mixed diagnostic and cancellation sample',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'local route',
      outcome: 'empty-diff',
      proposalCreated: false,
      spentUsd: 0,
      reason: 'agent returned no diff',
      basis: 'run-proposal-outcome',
    };
    recordDispatchProduction([
      baseEvent,
      { ...baseEvent, itemId: 'diagnostic-b' },
      {
        ...baseEvent,
        itemId: 'cancelled-a',
        outcome: 'cancelled',
        reason: 'selection cancelled after daemon lock ownership lost',
      },
    ]);

    const s = await buildFleetStatus(baseConfig());

    expect(s.dispatchProduction).toMatchObject({
      attempts: 3,
      outcomes: { cancelled: 1 },
    });
    expect(s.dispatchYieldDiagnostics).toMatchObject({
      verdict: 'insufficient-sample',
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
    expect(s.attemptCoverage?.production).toMatchObject({
      attempts: 3,
      cancelled: 1,
      diagnosticAttempts: 2,
      diagnosticNoProposal: 2,
      diagnosticProposalRate: 0,
      diagnosticNoProposalRate: 1,
    });
    expect(s.nextActions?.map((action) => action.id)).not.toContain('inspect-dispatch-yield');
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
      outcome: 'proposal-disabled',
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
      diagnosticAttempts: 3,
      diagnosticNoProposal: 3,
      outcomes: {
        proposalCaptureError: 0,
        proposalDisabled: 3,
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
    const now = new Date('2026-07-16T00:30:00.000Z');
    const queuedAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const staleSnapshotAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
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
      ts: queuedAt,
    };
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({
        generatedAt: staleSnapshotAt,
        repos: ['/tmp/deleted-fixture'],
        items: [{ ...queued, id: 'stale-temp-item', repo: '/tmp/deleted-fixture' }],
      }),
      'utf8',
    );
    writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([queued]), 'utf8');
    writeRunningDaemon(tmpHome, [], now.toISOString());

    const s = await withFakeNow(now, () => buildFleetStatus(baseConfig()));

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
    expect(s.queue.sources).toMatchObject({
      cachedBacklog: {
        provenance: 'persisted-backlog',
        sourceState: 'complete',
        freshness: 'stale',
        visibleItems: 0,
        actionableItems: 0,
      },
      queuedAutonomy: {
        provenance: 'queued-autonomy',
        sourceState: 'complete',
        freshness: 'fresh',
        visibleItems: 1,
        actionableItems: 1,
      },
    });
    expect(s.nextActions?.find((action) => action.id === 'build-backlog')).toMatchObject({
      target: repo,
      detail: expect.stringContaining('Fix broken test in repo'),
    });
    expect(existsSync(join(tmpHome, '.ashlr', 'audit'))).toBe(false);
  });

  it('keeps stale cached inventory visible without granting queue or action authority', async () => {
    const repo = join(tmpHome, 'repo');
    const stale = makeBacklogItem(repo, 'repo:goal:stale-visible', 'Stale visible work', 9);
    writeBacklogSnapshot(tmpHome, repo, [stale], '2026-07-01T00:00:00.000Z');
    writeRunningDaemon(tmpHome, [], new Date().toISOString());

    const status = await buildFleetStatus(baseConfig());
    const queueSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(status.queue).toMatchObject({
      backlogItems: 1,
      eligibleBacklogItems: 0,
      sources: {
        cachedBacklog: {
          provenance: 'persisted-backlog',
          sourceState: 'complete',
          freshness: 'stale',
          observedAt: '2026-07-01T00:00:00.000Z',
          visibleItems: 1,
          actionableItems: 0,
        },
        queuedAutonomy: {
          provenance: 'queued-autonomy',
          sourceState: 'complete',
          freshness: 'empty',
          visibleItems: 0,
          actionableItems: 0,
        },
      },
    });
    expect(status.queue.next).toBeUndefined();
    expect(status.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
    expect(queueSource).toMatchObject({
      status: 'degraded',
      freshness: 'stale',
      sourceQuality: { badge: 'stale-source', sourcePresent: true },
    });
  });

  it('keeps fresh queued autonomy actionable independently of a stale cached backlog', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    const stale = makeBacklogItem(repo, 'repo:goal:stale-shadow', 'Stale cached work', 10);
    const freshQueued: WorkItem = {
      id: 'repo:self-heal:fresh-authority',
      repo,
      source: 'self',
      title: 'Fix broken test in repo: FAIL src/fresh.test.ts: expected true to be false',
      detail:
        'Self-heal: test is RED.\n' +
        'First failure: FAIL src/fresh.test.ts: expected true to be false.\n' +
        'Investigate and verify the suite passes.',
      value: 5,
      effort: 1,
      score: 7,
      tags: ['self-heal', 'test'],
      ts: new Date().toISOString(),
    };
    writeBacklogSnapshot(tmpHome, repo, [stale], '2026-07-01T00:00:00.000Z');
    writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([freshQueued]), 'utf8');
    writeRunningDaemon(tmpHome, [], new Date().toISOString());

    const status = await buildFleetStatus(baseConfig());
    const queueSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(status.queue).toMatchObject({
      backlogItems: 2,
      eligibleBacklogItems: 1,
      sources: {
        cachedBacklog: { freshness: 'stale', visibleItems: 1, actionableItems: 0 },
        queuedAutonomy: {
          provenance: 'queued-autonomy',
          sourceState: 'complete',
          freshness: 'fresh',
          visibleItems: 1,
          actionableItems: 1,
        },
      },
    });
    expect(status.queue.next?.map((item) => item.id)).toEqual([freshQueued.id]);
    expect(status.queue.next?.map((item) => item.id)).not.toContain(stale.id);
    expect(status.nextActions?.find((action) => action.id === 'build-backlog')).toMatchObject({
      target: repo,
      detail: expect.stringContaining('Fix broken test in repo'),
    });
    expect(queueSource).toMatchObject({
      status: 'degraded',
      freshness: 'fresh',
      sourceQuality: { badge: 'degraded-source', sourcePresent: true },
    });
  });

  it('keeps an old durable generated repair actionable from a fresh queued-autonomy observation', async () => {
    await withFakeNow(new Date('2026-07-15T12:00:00.000Z'), async () => {
      const ashlrDir = join(tmpHome, '.ashlr');
      const repo = join(tmpHome, 'repo');
      const repair = makeTrustedDiagnosticResliceItem(repo, 'feedfacecafe');
      expect(Date.now() - Date.parse(repair.ts)).toBeGreaterThan(24 * 60 * 60 * 1000);
      expect(generatedRepairDispatchState(repair)).toMatchObject({
        applies: true,
        state: 'active',
        dispatchable: true,
      });
      writeBacklogSnapshot(tmpHome, repo, [], '2026-07-01T00:00:00.000Z');
      writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([repair]), 'utf8');
      writeRunningDaemon(tmpHome, [], new Date().toISOString());

      const status = await buildFleetStatus(withRoutableFrontierAndMid());
      const queueSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

      expect(status.queue).toMatchObject({
        backlogItems: 1,
        eligibleBacklogItems: 1,
        sources: {
          cachedBacklog: { freshness: 'stale', visibleItems: 0, actionableItems: 0 },
          queuedAutonomy: {
            sourceState: 'complete',
            freshness: 'fresh',
            observedAt: '2026-07-15T12:00:00.000Z',
            visibleItems: 1,
            actionableItems: 1,
          },
        },
      });
      expect(status.queue.next?.map((item) => item.id)).toEqual([repair.id]);
      expect(status.nextActions).toContainEqual(expect.objectContaining({
        id: 'build-backlog',
        target: repo,
      }));
      expect(queueSource).toMatchObject({ status: 'degraded', freshness: 'fresh' });
    });
  });

  it('keeps expired ordinary queued autonomy out while stale cached inventory stays non-actionable', async () => {
    await withFakeNow(new Date('2026-07-15T12:00:00.000Z'), async () => {
      const ashlrDir = join(tmpHome, '.ashlr');
      const repo = join(tmpHome, 'repo');
      const staleCached = makeBacklogItem(repo, 'repo:goal:stale-cached', 'Stale cached work', 9);
      const expiredOrdinary: WorkItem = {
        id: 'repo:self-heal:expired-ordinary',
        repo,
        source: 'self',
        title: 'Fix broken test in repo: FAIL src/expired.test.ts: expected true to be false',
        detail:
          'Self-heal: test is RED.\n' +
          'First failure: FAIL src/expired.test.ts: expected true to be false.\n' +
          'Investigate and verify the suite passes.',
        value: 5,
        effort: 1,
        score: 8,
        tags: ['self-heal', 'test'],
        ts: '2026-06-30T12:00:00.000Z',
      };
      writeBacklogSnapshot(tmpHome, repo, [staleCached], '2026-07-01T00:00:00.000Z');
      writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([expiredOrdinary]), 'utf8');
      writeRunningDaemon(tmpHome, [], new Date().toISOString());

      const status = await buildFleetStatus(baseConfig());
      const queueSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

      expect(status.queue).toMatchObject({
        backlogItems: 1,
        eligibleBacklogItems: 0,
        sources: {
          cachedBacklog: {
            freshness: 'stale',
            visibleItems: 1,
            actionableItems: 0,
          },
          queuedAutonomy: {
            sourceState: 'complete',
            freshness: 'empty',
            visibleItems: 0,
            actionableItems: 0,
          },
        },
      });
      expect(status.queue.next).toBeUndefined();
      expect(status.nextActions?.map((action) => action.id)).not.toContain('build-backlog');
      expect(queueSource).toMatchObject({
        status: 'degraded',
        freshness: 'stale',
        sourceQuality: { badge: 'stale-source', sourcePresent: true },
      });
    });
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
          trustedCoherentStorage: true,
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
      trustedCoherentStorage: true,
      authorityReady: true,
      capability: expect.objectContaining({
        scope: 'local-primitives-only',
        verified: true,
      }),
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

  it('fails shared queue authority closed without removing hardlink recovery residue', async () => {
    const sharedPath = join(tmpHome, 'shared-queue-recovery');
    const store = new SharedStore(sharedPath, 20_000);
    expect(store.claimItems(['attested'], 1, 'machine-A')).toEqual(['attested']);

    const lockPath = join(sharedPath, 'ashlr-fleet-queue.json.lock');
    const recoveryPath = join(sharedPath, 'ashlr-fleet-queue.json.lock.recovery');
    const residue = 'operator recovery required\n';
    writeFileSync(lockPath, residue, 'utf8');
    linkSync(lockPath, recoveryPath);
    expect(statSync(lockPath).nlink).toBe(2);

    const cfg: AshlrConfig = {
      ...baseConfig(),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'machine-A',
          leaseMs: 20_000,
          trustedCoherentStorage: true,
        },
      },
    };

    const status = await buildFleetStatus(cfg);

    expect(status.queue.shared).toMatchObject({
      readable: true,
      trustedCoherentStorage: true,
      authorityReady: false,
      capability: { checked: true, verified: true, failure: null },
      lock: {
        present: true,
        links: 2,
        recoveryRequired: true,
      },
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(residue);
    expect(readFileSync(recoveryPath, 'utf8')).toBe(residue);
    expect(statSync(lockPath).nlink).toBe(2);
    expect(statSync(recoveryPath).nlink).toBe(2);
  });

  it('reports an absent configured shared queue as unverified without creating its path', async () => {
    const sharedPath = join(tmpHome, 'missing-shared-queue');
    expect(existsSync(sharedPath)).toBe(false);

    const cfg: AshlrConfig = {
      ...baseConfig(),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'machine-A',
          trustedCoherentStorage: true,
        },
      },
    };

    const status = await buildFleetStatus(cfg);

    expect(status.queue.shared).toMatchObject({
      path: sharedPath,
      readable: true,
      trustedCoherentStorage: true,
      authorityReady: false,
      capability: {
        scope: 'local-primitives-only',
        checked: false,
        verified: false,
        failure: 'unavailable',
      },
      lock: { present: false },
    });
    expect(existsSync(sharedPath)).toBe(false);
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
      authorityState: 'ready',
      protocols: { sealedV3: 0, legacy: 2 },
      sourceQuality: { sourceState: 'healthy', complete: true, invalidFiles: 0, unreadableFiles: 0 },
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

  it('counts the complete bounded evidence corpus instead of truncating totals at the recent display limit', async () => {
    const evidenceDir = join(tmpHome, '.ashlr', 'evidence');
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 205; index++) {
      const id = `prop-corpus-${String(index).padStart(3, '0')}`;
      const pack = makeEvidencePack(id, `2026-07-02T00:${String(index % 60).padStart(2, '0')}:00.000Z`);
      writeFileSync(join(evidenceDir, `${id}.json`), `${JSON.stringify(pack, null, 2)}\n`, { mode: 0o600 });
    }

    const status = await buildFleetStatus(baseConfig());
    expect(status.autonomy).toMatchObject({
      evidencePacks: 205,
      authorityState: 'ready',
      protocols: { sealedV3: 0, legacy: 205 },
      sourceQuality: { sourceState: 'healthy', complete: true, filesRead: 205 },
    });
    expect(status.autonomy?.recent).toHaveLength(8);
  });

  it('surfaces degraded signed evidence as merge authority instead of a healthy zero', async () => {
    const repo = join(tmpHome, 'signed-evidence-degraded-repo');
    mkdirSync(repo, { recursive: true });
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const proposal = createProposal({
      repo,
      origin: 'agent',
      kind: 'patch',
      title: 'Pending evidence-bound change',
      summary: 'summary',
      diff: docsDiff('pending'),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    expect(proposal.status).toBe('pending');
    const evidenceDir = join(tmpHome, '.ashlr', 'evidence');
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(evidenceDir, 'corrupt.json'), '{not-json\n', { mode: 0o600 });

    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification', maxRisk: 'low' },
    }));

    expect(status.autonomy).toMatchObject({
      evidencePacks: 0,
      authorityState: 'degraded',
      protocols: { sealedV3: 0, legacy: 0 },
      sourceQuality: { sourceState: 'degraded', complete: false, invalidFiles: 1 },
    });
    expect(status.autonomousShipReadiness?.evidenceMatrix?.sources)
      .toContainEqual(expect.objectContaining({
        id: 'autonomy-packs',
        label: 'Signed Evidence Authority',
        eligibility: 'withheld',
        status: 'degraded',
      }));
    expect(status.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      topBlocker: { id: 'signed-evidence-degraded', source: 'autonomy-packs' },
      primaryAction: { id: 'inspect-signed-evidence', priority: 'high' },
    });
    expect(status.autonomousShipReadiness?.primaryAction?.commands?.[0]?.argv)
      .toEqual(['ashlr', 'fleet', 'evidence', 'doctor', 'autonomy-packs', '--json']);
  });

  it('keeps disabled auto-merge with pending proposals merge-blocked and inspection-only', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(
      tmpHome,
      repo,
      [makeBacklogItem(repo, 'repo:goal:queued-behind-proposals', 'Queued behind pending proposals', 8)],
      new Date().toISOString(),
    );
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: false,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    createSignedProposal(cfg, {
      title: 'Pending while auto-merge is intentionally disabled',
      diff: docsDiff('inspect only'),
      verifyResult: { passed: true, source: 'manual' },
    });

    const status = await buildFleetStatus(cfg);
    const inspection = status.nextActions?.find((action) => action.id === 'inspect-pending-proposals');

    expect(status.autonomyEffectiveness).toMatchObject({
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      counts: { pendingProposals: 1, backlogItems: 1, eligibleBacklogItems: 1 },
    });
    expect(status.autonomyEffectiveness?.summary).toContain('auto-merge disabled');
    expect(inspection).toMatchObject({
      priority: 'high',
      commands: [
        { argv: ['ashlr', 'inbox', '--json'], safety: 'read-only' },
        { argv: ['ashlr', 'fleet', 'status', '--json'], safety: 'read-only' },
      ],
    });
    expect(status.nextActions?.map((action) => action.id)).not.toContain('enable-auto-merge');
    expect(status.autonomousShipReadiness).toMatchObject({
      topBlocker: { id: 'auto-merge-disabled' },
      primaryAction: { id: 'inspect-pending-proposals' },
    });
    expect(status.autonomousShipReadiness?.primaryAction?.id).not.toBe('build-backlog');
    expect(status.missionBrief?.action).toMatchObject({ id: 'inspect-pending-proposals' });
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
      authorityReady: 0,
      authorityBlocked: 1,
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

  it('does not present cheap verification preflight as merge-ready without judge authority', async () => {
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
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      counts: {
        pendingProposals: 1,
        preflightReady: 1,
        authorityReady: 0,
      },
    });
    expect(s.autoMergeReadiness).toMatchObject({
      preflightReady: 1,
      authorityReady: 0,
      authorityBlocked: 1,
    });
    expect(s.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
  });

  it('marks autonomous ship readiness ready when fresh control, queue, and merge evidence agree', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    expect(writeDaemonActivity({
      instanceId: '123e4567-e89b-42d3-a456-426614174000',
      daemonStartedAt: '2026-07-03T00:00:00.000Z',
      phase: 'idle',
    })).toBe(true);
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Ready docs change',
      diff: docsDiff('ready ship readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });
    recordFrontierShipDecision(proposal);

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
    expect(s.queue.repos?.registry).toBeUndefined();
    expect(s.autonomousShipReadiness?.sourceQualitySummary?.['healthy-zero']).toBeGreaterThan(0);
    expect(s.autonomousShipReadiness?.evidenceMatrix).toMatchObject({
      version: 1,
      state: 'cold-start',
      summary: {
        eligible: 1,
        'cold-start': 4,
        withheld: 0,
        observational: 1,
        'not-applicable': 2,
      },
    });
    expect(s.autonomousShipReadiness?.evidenceMatrix?.sources.map((source) => source.id)).toEqual([
      'autonomy-packs', 'decisions', 'judge-traces', 'agent-actions', 'dispatch-production', 'dispatch-manifests', 'best-of-n',
      'post-merge',
    ]);
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

  it('fails fleet status closed when the enrollment registry is malformed', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    const repo = join(tmpHome, 'repo');
    mkdirSync(ashlrDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cached = makeBacklogItem(repo, 'repo:goal:withheld', 'Withheld cached work');
    const queued: WorkItem = {
      ...makeBacklogItem(repo, 'repo:self:withheld', 'FAIL src/withheld.test.ts: expected true', 8, 'self'),
      detail: 'Self-heal: test is RED.\nFAIL src/withheld.test.ts: expected true to be false.',
      tags: ['self-heal', 'test'],
      ts: new Date().toISOString(),
    };
    writeFileSync(join(ashlrDir, 'enrollment.json'), '{', 'utf8');
    writeFileSync(
      join(ashlrDir, 'backlog.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), repos: [repo], items: [cached] }),
      'utf8',
    );
    writeFileSync(join(ashlrDir, 'self-heal-queue.json'), JSON.stringify([queued]), 'utf8');
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    const mergeReady = createSignedProposal(cfg, {
      title: 'Ready proposal withheld by enrollment authority',
      diff: docsDiff('withheld ready proposal'),
      verifyResult: { passed: true, source: 'manual' },
    });
    recordFrontierShipDecision(mergeReady);
    const awaitingHost = createSignedProposal(cfg, {
      title: 'Host handoff withheld by enrollment authority',
      diff: docsDiff('withheld host handoff'),
      verifyResult: { passed: true, source: 'manual' },
    });
    setStatus(awaitingHost.id, 'awaiting-host-merge');

    expect(loadQueuedAutonomyItemsDetailed()).toMatchObject({
      sourceState: 'complete',
      items: [expect.objectContaining({ id: queued.id })],
    });

    const status = await buildFleetStatus(cfg);
    const queueSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'queue');

    expect(status.queue.repos).toMatchObject({
      enrolled: 0,
      existing: 0,
      withBacklog: 0,
      silent: 0,
      registry: {
        state: 'degraded',
        reason: expect.any(String),
      },
    });
    expect(status.queue).toMatchObject({ backlogItems: 0, eligibleBacklogItems: 0 });
    expect(status.queue.next).toBeUndefined();
    expect(queueSource).toMatchObject({
      status: 'degraded',
      freshness: 'fresh',
      sourceQuality: {
        badge: 'degraded-source',
        empty: true,
        sourcePresent: true,
      },
    });
    expect(status.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      topBlocker: {
        id: 'enrollment-registry-degraded',
        source: 'queue',
        severity: 'high',
      },
      primaryAction: { id: 'repair-enrollment-registry' },
    });
    expect(status.autonomyEffectiveness).toMatchObject({
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      counts: {
        pendingProposals: 1,
        awaitingHostMerge: 1,
        preflightReady: 0,
        authorityReady: 0,
      },
    });
    expect(status.autoMergeReadiness).toMatchObject({
      pending: 1,
      preflightReady: 0,
      authorityReady: 0,
      branchAuthorityReady: 0,
      remoteMainAuthorityReady: 0,
      authorityBlocked: 1,
      blocked: 1,
    });
    expect(status.nextActions).toEqual([
      expect.objectContaining({
        id: 'repair-enrollment-registry',
        commands: expect.arrayContaining([
          expect.objectContaining({
            argv: ['ashlr', 'enroll', 'list', '--json'],
            safety: 'read-only',
          }),
        ]),
      }),
    ]);
    expect(status.nextActions?.flatMap((action) => action.commands).every((command) =>
      command.safety === 'read-only'
    )).toBe(true);
    expect(status.nextActions?.map((action) => action.id)).not.toEqual(expect.arrayContaining([
      'start-daemon',
      'reconcile-host-prs',
      'drain-ready-auto-merges',
      'verify-pending-proposals',
      'build-backlog',
    ]));
    expect(status.missionBrief).toMatchObject({
      directive: 'Repair enrollment authority',
      blocker: { id: 'enrollment-registry-degraded' },
      action: { id: 'repair-enrollment-registry' },
      whyNow: expect.stringContaining('Enrollment authority could not be proven'),
    });
    expect(readFileSync(join(ashlrDir, 'enrollment.json'), 'utf8')).toBe('{');
  });

  it('fails ship readiness closed when verification authority evidence is degraded', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification', maxRisk: 'low' },
    });
    createSignedProposal(cfg, {
      title: 'Ready despite unavailable decision cache',
      diff: docsDiff('evidence matrix'),
      verifyResult: { passed: true, source: 'manual' },
    });
    const decisions = join(process.env.ASHLR_HOME!, 'decisions');
    mkdirSync(decisions, { recursive: true, mode: 0o700 });
    writeFileSync(join(decisions, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'not-json\n', { mode: 0o600 });

    const status = await buildFleetStatus(cfg);
    const decisionEvidence = status.autonomousShipReadiness?.evidenceMatrix?.sources
      .find((source) => source.id === 'decisions');
    const action = status.nextActions?.find((candidate) => candidate.id === 'inspect-learning-evidence');

    expect(status.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      topBlocker: { id: 'merge-authority-incomplete' },
      evidenceMatrix: {
        state: 'degraded',
        summary: { withheld: 1 },
      },
    });
    expect(status.autoMergeReadiness).toMatchObject({
      preflightReady: 1,
      authorityReady: 0,
      authorityBlocked: 1,
      authorityByReason: {
        'decisions ledger source is degraded or incomplete': 1,
      },
    });
    expect(decisionEvidence).toMatchObject({
      category: 'evidence',
      evidenceRole: 'merge-authority',
      eligibility: 'withheld',
      applicability: 'required',
      status: 'degraded',
      evidenceQuality: { complete: false, invalidRows: 1 },
      sourceQuality: { badge: 'degraded-source' },
    });
    expect(action).toMatchObject({
      priority: 'medium',
      commands: [
        {
          argv: ['ashlr', 'fleet', 'evidence', 'doctor', 'decisions', '--json'],
          safety: 'read-only',
        },
        {
          argv: ['ashlr', 'fleet', 'evidence', 'doctor', 'decisions', '--deep', '--json'],
          safety: 'read-only',
        },
        { argv: ['ashlr', 'fleet', 'status', '--json'], safety: 'read-only' },
      ],
    });
    expect(action?.commands?.every((command) => command.endpointPath === undefined)).toBe(true);
    expect(status.autonomousShipReadiness?.primaryAction).not.toMatchObject({ id: 'drain-ready-auto-merges' });
    expect(status.nextActions?.map((candidate) => candidate.id)).not.toContain('drain-ready-auto-merges');
  });

  it('keeps evidence diagnosis secondary to eligible operational backlog work', async () => {
    const repo = join(tmpHome, 'repo');
    mkdirSync(repo, { recursive: true });
    writeBacklogSnapshot(tmpHome, repo, [makeBacklogItem(repo, 'repo:goal:evidence-order', 'Ship useful work', 5)], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const decisions = join(process.env.ASHLR_HOME!, 'decisions');
    mkdirSync(decisions, { recursive: true, mode: 0o700 });
    writeFileSync(join(decisions, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'not-json\n', { mode: 0o600 });

    const status = await buildFleetStatus(withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification', maxRisk: 'low' },
    }));
    expect(status.nextActions?.map((action) => action.id)).toEqual(expect.arrayContaining([
      'build-backlog', 'inspect-learning-evidence',
    ]));
    expect(status.autonomousShipReadiness?.primaryAction).toMatchObject({ id: 'build-backlog' });
    expect(status.missionBrief?.directive).toBe('Build the highest-value backlog proposal');
  });

  it('uses a live daemon heartbeat as fresh readiness evidence while a tick is in progress', async () => {
    await withFakeNow(new Date('2026-07-03T00:01:00.000Z'), async () => {
      writeRunningDaemon(tmpHome, [], '2026-07-02T23:55:00.000Z');
      writeDaemonLock(tmpHome, '2026-07-03T00:01:00.000Z');
      expect(writeDaemonActivity({
        instanceId: '123e4567-e89b-42d3-a456-426614174001',
        daemonStartedAt: '2026-07-03T00:00:00.000Z',
        phase: 'tick',
      })).toBe(true);

      const s = await buildFleetStatus(baseConfig());
      const daemonSource = s.autonomousShipReadiness?.sources.find((source) => source.id === 'daemon');

      expect(s.daemon).toMatchObject({
        running: true,
        startedAt: '2026-07-03T00:00:00.000Z',
        lastTickAt: '2026-07-02T23:55:00.000Z',
        lockHeartbeatAt: '2026-07-03T00:01:00.000Z',
        tickInProgress: true,
        activity: {
          sourceState: 'healthy',
          phase: 'tick',
          ownerMatches: true,
        },
      });
      expect(daemonSource).toMatchObject({
        status: 'healthy',
        freshness: 'fresh',
        observedAt: '2026-07-03T00:01:00.000Z',
        detail: 'daemon running; last tick 2026-07-02T23:55:00.000Z',
        sourceQuality: {
          badge: 'healthy-source',
          sourcePresent: true,
        },
      });
    });
  });

  it('does not infer tick progress or change readiness from missing activity evidence', async () => {
    await withFakeNow(new Date('2026-07-03T00:01:00.000Z'), async () => {
      writeRunningDaemon(tmpHome, [], '2026-07-02T23:55:00.000Z');
      writeDaemonLock(tmpHome, '2026-07-03T00:01:00.000Z');

      const status = await buildFleetStatus(baseConfig());
      const daemonSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'daemon');

      expect(status.daemon.tickInProgress).toBeUndefined();
      expect(status.daemon.activity).toMatchObject({
        sourceState: 'missing',
        phase: null,
        ownerMatches: false,
      });
      expect(daemonSource).toMatchObject({
        status: 'healthy',
        freshness: 'fresh',
        detail: 'daemon running; last tick 2026-07-02T23:55:00.000Z',
        sourceQuality: { badge: 'healthy-source', sourcePresent: true },
      });
    });
  });

  it('keeps forged owner activity outside readiness, actions, and learning authority', async () => {
    await withFakeNow(new Date('2026-07-03T00:01:00.000Z'), async () => {
      writeRunningDaemon(tmpHome, [], '2026-07-02T23:55:00.000Z');
      writeDaemonLock(tmpHome, '2026-07-03T00:01:00.000Z');
      const baseline = await buildFleetStatus(baseConfig());

      expect(writeDaemonActivity({
        instanceId: '123e4567-e89b-42d3-a456-426614174003',
        daemonStartedAt: '2026-07-02T00:00:00.000Z',
        phase: 'tick',
      })).toBe(true);
      const forged = await buildFleetStatus(baseConfig());

      expect(forged.daemon.activity).toMatchObject({ sourceState: 'healthy', ownerMatches: false });
      expect(forged.daemon.tickInProgress).toBeUndefined();
      const readinessAuthority = (value: FleetStatus) => ({
        verdict: value.autonomousShipReadiness?.verdict,
        confidence: value.autonomousShipReadiness?.confidence,
        topBlocker: value.autonomousShipReadiness?.topBlocker,
        primaryAction: value.autonomousShipReadiness?.primaryAction,
        daemonSource: value.autonomousShipReadiness?.sources.find((source) => source.id === 'daemon'),
      });
      expect(readinessAuthority(forged)).toEqual(readinessAuthority(baseline));
      expect(forged.missionBrief).toEqual(baseline.missionBrief);
      expect(forged.nextActions).toEqual(baseline.nextActions);
      expect(forged.learning).toEqual(baseline.learning);
    });
  });

  it('reports explicit post-tick child activity without calling it an active tick', async () => {
    await withFakeNow(new Date('2026-07-03T00:01:00.000Z'), async () => {
      writeRunningDaemon(tmpHome, [], '2026-07-03T00:00:30.000Z');
      writeDaemonLock(tmpHome, '2026-07-03T00:01:00.000Z');
      expect(writeDaemonActivity({
        instanceId: '123e4567-e89b-42d3-a456-426614174002',
        daemonStartedAt: '2026-07-03T00:00:00.000Z',
        phase: 'post-tick',
        activeChildren: 2,
      })).toBe(true);

      const status = await buildFleetStatus(baseConfig());
      const daemonSource = status.autonomousShipReadiness?.sources.find((source) => source.id === 'daemon');
      expect(status.daemon.tickInProgress).toBeUndefined();
      expect(status.daemon.childActivity).toBe(true);
      expect(status.daemon.activity).toMatchObject({
        sourceState: 'healthy', phase: 'post-tick', activeChildren: 2, ownerMatches: true,
      });
      expect(daemonSource).toMatchObject({
        status: 'healthy',
        detail: 'daemon running; last tick 2026-07-03T00:00:30.000Z',
      });
    });
  });

  it('degrades autonomous ship readiness when ready work depends on a stale source', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], '2026-07-01T00:00:00.000Z');
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
      },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Ready docs change with stale queue',
      diff: docsDiff('stale queue readiness'),
      verifyResult: { passed: true, source: 'manual' },
    });
    recordFrontierShipDecision(proposal);

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
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
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
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
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
      authorityReady: 0,
      authorityBlocked: 1,
      authorityByReason: {
        'fresh isolated verification is required by the mutating evidence-mode gate': 1,
      },
      needsVerification: 0,
      blocked: 0,
    });
  });

  it('blocks zero-proposal ship readiness when an enrolled remote cannot be attested', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });

    const remoteHeadSpy = vi.spyOn(inboxMerge, 'resolveRemoteBranchHead')
      .mockReturnValue('0123456789abcdef0123456789abcdef01234567');
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({ authorized: false, reason: 'live branch protection unavailable: fixture' });
    const status = await buildFleetStatus(cfg);
    remoteHeadSpy.mockRestore();
    protectionSpy.mockRestore();

    expect(status.proposals.pending).toBe(0);
    expect(status.autoMergeReadiness).toMatchObject({
      enabled: true,
      pending: 0,
      remoteProtection: {
        required: true,
        configured: 'exact',
        live: 'unavailable',
        coverage: 'complete',
        observedAt: null,
        reposObserved: 1,
        reposRequired: 1,
      },
    });
    expect(status.autonomousShipReadiness).toMatchObject({
      verdict: 'blocked',
      topBlocker: {
        id: 'protected-remote-unavailable',
        source: 'auto-merge',
      },
    });
    const autoMergeSource = status.autonomousShipReadiness?.sources
      .find((source) => source.id === 'auto-merge');
    expect(autoMergeSource).toMatchObject({ status: 'blocked' });
    expect(autoMergeSource?.sourceQuality?.badge).not.toBe('healthy-zero');
    expect(status.nextActions?.map((action) => action.id)).toContain('inspect-protected-remote');
    expect(status.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
    expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    expect(status.autonomousShipReadiness?.primaryAction).toMatchObject({
      id: 'inspect-protected-remote',
    });
  });

  it('projects an unsafe safe-minimum policy as unavailable protected-remote authority', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    const remoteHeadSpy = vi.spyOn(inboxMerge, 'resolveRemoteBranchHead')
      .mockReturnValue('0123456789abcdef0123456789abcdef01234567');
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({
        authorized: false,
        reason: 'live safe-minimum protected-remote policy unavailable (classic-admin-enforcement-missing): fixture',
      });

    try {
      const status = await buildFleetStatus(cfg);

      expect(status.autoMergeReadiness?.remoteProtection).toMatchObject({
        required: true,
        configured: 'exact',
        live: 'unavailable',
        coverage: 'complete',
        observedAt: null,
      });
      expect(status.autoMergeReadiness?.remoteProtection?.detail)
        .toContain('classic-admin-enforcement-missing');
      expect(status.autonomousShipReadiness?.topBlocker).toMatchObject({
        id: 'protected-remote-unavailable',
        source: 'auto-merge',
      });
      expect(status.nextActions?.map((action) => action.id)).toContain('inspect-protected-remote');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    } finally {
      remoteHeadSpy.mockRestore();
      protectionSpy.mockRestore();
    }
  });

  it('fails closed on an unknown auto-merge trust basis even with an empty inbox', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'future-unsafe-mode' as never,
        maxRisk: 'low',
      },
    });

    const status = await buildFleetStatus(cfg);

    expect(status.autoMergeReadiness).toMatchObject({
      enabled: true,
      trustBasis: 'tier',
      configurationBlocker: "invalid auto-merge trustBasis 'future-unsafe-mode'",
    });
    expect(status.autonomousShipReadiness?.topBlocker).toMatchObject({
      id: 'auto-merge-configuration-invalid',
      source: 'auto-merge',
    });
    expect(status.nextActions?.map((action) => action.id)).toContain('inspect-auto-merge-configuration');
    expect(status.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
    expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
  });

  it('fails closed on an unknown auto-merge maxRisk value', async () => {
    writeRunningDaemon(tmpHome);
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'extreme' as never,
      },
    });

    const status = await buildFleetStatus(cfg);

    expect(status.autoMergeReadiness?.configurationBlocker).toBe("invalid auto-merge maxRisk 'extreme'");
    expect(status.autonomousShipReadiness?.topBlocker?.id).toBe('auto-merge-configuration-invalid');
    expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
  });

  it('withholds drain authority when a ready proposal cannot observe live protection', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const baseHead = '0123456789abcdef0123456789abcdef01234567';
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Ready but remote protection unavailable',
      diff: docsDiff('remote unavailable'),
      verifyResult: { passed: true, source: 'manual', baseBranch: 'main', baseHead },
    });
    recordFrontierShipDecision(proposal);
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({ authorized: false, reason: 'live branch protection unavailable: fixture' });

    try {
      const status = await buildFleetStatus(cfg);

      expect(status.autoMergeReadiness).toMatchObject({
        authorityReady: 0,
        remoteMainAuthorityReady: 1,
        authorityBlocked: 1,
        remoteProtection: {
          required: true,
          configured: 'exact',
          live: 'unavailable',
          coverage: 'complete',
          observedAt: null,
          reposObserved: 1,
          reposRequired: 1,
        },
      });
      expect(status.autonomousShipReadiness?.topBlocker).toMatchObject({
        id: 'protected-remote-unavailable',
        source: 'auto-merge',
      });
      expect(status.nextActions?.map((action) => action.id)).toContain('inspect-protected-remote');
      expect(status.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    } finally {
      protectionSpy.mockRestore();
    }
  });

  it('does not require protected-main authority for a tier branch-only delivery', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'tier',
        maxRisk: 'low',
        pushToRemote: true,
        midToBranch: true,
      },
    });
    createSignedProposal(cfg, {
      title: 'Mid-tier branch delivery',
      diff: docsDiff('branch only'),
      engineTier: 'mid',
      engineModel: 'local-coder:qwen2.5-coder',
    });
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({ authorized: false, reason: 'must not be consulted for branch-only delivery' });

    try {
      const status = await buildFleetStatus(cfg);

      expect(protectionSpy).not.toHaveBeenCalled();
      expect(status.autoMergeReadiness).toMatchObject({
        authorityReady: 1,
        remoteProtection: { required: false, configured: 'missing' },
      });
      expect(status.nextActions?.map((action) => action.id)).toContain('drain-ready-auto-merges');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(true);
    } finally {
      protectionSpy.mockRestore();
    }
  });

  it('keeps a ready branch lane drainable when an unrelated main lane lacks protection', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const baseHead = '0123456789abcdef0123456789abcdef01234567';
    const cfg = withFoundry({
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        trustBasis: 'tier',
        maxRisk: 'low',
        pushToRemote: true,
        midToBranch: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    createSignedProposal(cfg, {
      title: 'Ready branch lane',
      diff: docsDiff('mixed branch'),
      engineTier: 'mid',
      engineModel: 'local-coder:qwen2.5-coder',
    });
    createSignedProposal(cfg, {
      title: 'Blocked main lane',
      diff: docsDiff('mixed main'),
      verifyResult: { passed: true, source: 'manual', baseBranch: 'main', baseHead },
    });
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({ authorized: false, reason: 'live branch protection unavailable: fixture' });

    try {
      const status = await buildFleetStatus(cfg);

      expect(status.autoMergeReadiness).toMatchObject({
        authorityReady: 1,
        branchAuthorityReady: 1,
        remoteMainAuthorityReady: 1,
        authorityBlocked: 1,
      });
      expect(status.nextActions?.map((action) => action.id)).toContain('drain-ready-auto-merges');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(true);
      expect(status.autonomousShipReadiness?.topBlocker?.id).not.toBe('protected-remote-unavailable');
    } finally {
      protectionSpy.mockRestore();
    }
  });

  it('projects reachable protected-complete authority for a ready main target', async () => {
    const repo = join(tmpHome, 'repo');
    writeBacklogSnapshot(tmpHome, repo, [], new Date().toISOString());
    writeRunningDaemon(tmpHome, [], new Date().toISOString());
    const baseHead = '0123456789abcdef0123456789abcdef01234567';
    const observedAt = new Date().toISOString();
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Ready with protected remote',
      diff: docsDiff('protected complete'),
      verifyResult: { passed: true, source: 'manual', baseBranch: 'main', baseHead },
    });
    recordFrontierShipDecision(proposal);
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({
        authorized: true,
        evidence: {
          ok: true,
          live: true,
          detail: 'Live branch protection confirmed',
          nameWithOwner: 'ashlrai/fixture',
          repositoryId: 'R_fixture',
          branch: 'main',
          baseHead,
          observedAt,
          requirements: ['required_status_checks'],
          requiredChecks: ['ci/test'],
          requiredCheckBindings: [{ context: 'ci/test', appId: '15368' }],
          policySources: ['classic'],
          policyHash: 'a'.repeat(64),
        },
      });

    try {
      const status = await buildFleetStatus(cfg);

      expect(status.autoMergeReadiness).toMatchObject({
        authorityReady: 1,
        remoteProtection: {
          required: true,
          configured: 'exact',
          live: 'protected',
          coverage: 'complete',
          observedAt,
          reposObserved: 1,
          reposRequired: 1,
        },
      });
      expect(status.autonomousShipReadiness).toMatchObject({ verdict: 'ready', topBlocker: null });
      expect(status.nextActions?.map((action) => action.id)).toContain('drain-ready-auto-merges');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(true);
    } finally {
      protectionSpy.mockRestore();
    }
  });

  it('reports same-family reviewer correlation as a merge-authority blocker', async () => {
    const cfg = withFoundry({
      autoMerge: { enabled: true, trustBasis: 'verification', maxRisk: 'low' },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Correlated Claude review',
      diff: docsDiff('correlated reviewer'),
      engineModel: 'claude:claude-sonnet-4-6',
      engineTier: 'frontier',
      verifyResult: { passed: true, source: 'manual' },
    });
    recordFrontierShipDecision(proposal);
    recordDecision({
      ts: new Date().toISOString(),
      proposalId: proposal.id,
      action: 'verified',
      verdict: 'approved',
      reason: 'EDV confirmed',
    });

    const status = await buildFleetStatus(cfg);

    expect(status.autoMergeReadiness).toMatchObject({
      preflightReady: 1,
      authorityReady: 0,
      authorityBlocked: 1,
      authorityByReason: {
        'verification gate: reviewer independence denied: producer and reviewer are both claude family': 1,
      },
    });
    expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
  });

  it('expires stale live-protection observations before granting drain authority', async () => {
    const baseHead = '0123456789abcdef0123456789abcdef01234567';
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    const proposal = createSignedProposal(cfg, {
      title: 'Ready with stale protection',
      diff: docsDiff('stale protection'),
      verifyResult: { passed: true, source: 'manual', baseBranch: 'main', baseHead },
    });
    recordFrontierShipDecision(proposal);
    const protectionSpy = vi.spyOn(inboxMerge, 'evaluateLiveProtectedRemoteAuthority')
      .mockResolvedValue({
        authorized: true,
        evidence: {
          ok: true,
          live: true,
          detail: 'stale fixture',
          nameWithOwner: 'ashlrai/fixture',
          repositoryId: 'R_fixture',
          branch: 'main',
          baseHead,
          observedAt: '2026-01-01T00:00:00.000Z',
          requirements: ['required_status_checks'],
          requiredChecks: ['ci/test'],
          requiredCheckBindings: [{ context: 'ci/test', appId: '15368' }],
          policySources: ['classic'],
          policyHash: 'a'.repeat(64),
        },
      });

    try {
      const status = await buildFleetStatus(cfg);
      expect(status.autoMergeReadiness).toMatchObject({
        authorityReady: 0,
        remoteMainAuthorityReady: 1,
        authorityBlocked: 1,
        remoteProtection: { live: 'unavailable', detail: 'live protected-remote observation is missing or stale' },
      });
      expect(status.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
      expect(status.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    } finally {
      protectionSpy.mockRestore();
    }
  });

  it('withholds evidence-mode drain readiness when the decisions source is degraded', async () => {
    writeRunningDaemon(tmpHome);
    const cfg = withFoundry({
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
        },
      },
    });
    const diff = docsDiff('degraded evidence source');
    createSignedProposal(cfg, {
      title: 'Evidence docs change with degraded decisions',
      diff,
      verifyResult: {
        passed: true,
        source: 'auto-merge-preflight',
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
        baseBranch: 'main',
        baseHead: '0123456789abcdef0123456789abcdef01234567',
        diffHash: hashDiff(diff),
      },
    });
    const decisions = join(process.env.ASHLR_HOME!, 'decisions');
    mkdirSync(decisions, { recursive: true, mode: 0o700 });
    writeFileSync(join(decisions, `${new Date().toISOString().slice(0, 10)}.jsonl`), 'not-json\n', { mode: 0o600 });

    const s = await buildFleetStatus(cfg);

    expect(s.autoMergeReadiness).toMatchObject({
      trustBasis: 'evidence',
      preflightReady: 1,
      authorityReady: 0,
      authorityBlocked: 1,
      authorityByReason: {
        'fresh isolated verification is required by the mutating evidence-mode gate': 1,
      },
    });
    expect(s.decisionsSource).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(s.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    expect(s.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
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
          requiredChecks: [{ context: 'ci/test', appId: '15368' }],
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
      authorityReady: 0,
      authorityBlocked: 0,
      needsVerification: 1,
      blocked: 0,
    });
    expect(s.autonomyEffectiveness?.canAutoMergeNow).toBe(false);
    expect(s.nextActions?.map((action) => action.id)).not.toContain('drain-ready-auto-merges');
  });
});

// ---------------------------------------------------------------------------
// Lane locks
// ---------------------------------------------------------------------------

describe('buildFleetLaneLocks — pure derived lane status', () => {
  it('skips a linked milestone whose applied proposal has passing verification', () => {
    const home = mkdtempSync(join(tmpdir(), 'ashlr-m49-lane-'));
    const previousHome = process.env.HOME;
    const previousAshlrHome = process.env.ASHLR_HOME;
    try {
      process.env.HOME = home;
      process.env.ASHLR_HOME = join(home, '.ashlr');
      const proposal = seedAuthenticatedRealizedProposal(
        home,
        'prop-verified',
        '2026-07-03T01:00:00.000Z',
        '2026-07-03T00:00:00.000Z',
      );
      const repo = proposal.repo!;
      const goal = makeGoalRecord(repo, 'goal-verified', 'active', 'proposed');
      goal.milestones[0]!.proposalId = proposal.id;

      const status = buildFleetLaneLocks({
        generatedAt: '2026-07-03T12:00:00.000Z',
        goals: [goal],
        proposals: [proposal],
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
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previousAshlrHome;
      rmSync(home, { recursive: true, force: true });
    }
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
  it('renders compact build identity and omits it for legacy snapshots', () => {
    const base = {
      generatedAt: '2026-07-11T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    };
    const current = formatFleetStatus({
      ...base,
      buildIdentity: {
        schemaVersion: 1,
        packageVersion: '3.1.0',
        revision: 'abcdef0123456789abcdef0123456789abcdef01',
        dirty: true,
        provenance: 'git',
      },
    });

    expect(current).toContain('Build: 3.1.0 @ abcdef012345 (dirty)');
    expect(formatFleetStatus(base)).not.toContain('Build:');
  });

  it('renders repair handoff rollout status and omits it for legacy snapshots', () => {
    const base = {
      generatedAt: '2026-07-11T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    };

    const currentRollout = {
      summaryAvailable: true,
      writerEnabled: true,
      phase: 'mixed-healthy' as const,
      sourceState: 'healthy' as const,
      v1Authorities: 7,
      v2Authorities: 3,
      v1PhysicalRows: 7,
      v2PhysicalRows: 3,
      aliasFamilies: 2,
      latestV2At: '2026-07-11T00:00:00.000Z',
      authorityDigest: 'a'.repeat(64),
      projectionObserved: false,
      projectionTickAt: null,
      invalidRows: 0,
      conflictingIds: 0,
      limitExceeded: false,
      eligibleOrdinaryItems: 4,
      action: 'observe-projection' as const,
    };
    const current = formatFleetStatus({
      ...base,
      repairHandoffRollout: currentRollout,
    });
    expect(current).toContain(
      'Repair handoff: phase=mixed-healthy, writer=configured/effective, authorities v1/v2=7/3, ' +
        'current activation=unknown, aliases=2, ordinary eligible=4, action=observe-projection',
    );

    const failClosed = formatFleetStatus({
      ...base,
      repairHandoffRollout: {
        ...currentRollout,
        writerConfigured: false,
        writerEnabled: false,
        writerEffective: false,
        phase: 'reader-only',
        eligibleOrdinaryItems: 0,
        action: 'wait-ordinary-parent',
      },
    });
    expect(failClosed).toContain(
      'writer=off/inactive, authorities v1/v2=7/3, current activation=unknown, aliases=2, ordinary eligible=0, ' +
        'action=wait-ordinary-parent',
    );

    const legacy = formatFleetStatus(base);
    expect(legacy).not.toContain('Repair handoff:');
  });

  it('labels unhealthy workspace sources and qualifies observed zero values', () => {
    const base = {
      generatedAt: '2026-07-11T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    };
    const workspace = {
      generatedAt: base.generatedAt,
      windowHours: 24,
      eventCount: 0,
      latestAt: null,
      activeMachines: [],
      spendUsd: 0,
      proposalEvents: 0,
      noProposalEvents: 0,
      diagnosticNoProposalEvents: 0,
      policySuppressedEvents: 0,
      diagnosticProposalRate: 0,
      repoEventCount: 0,
      repoDistinctCount: 0,
      topRepoCount: 0,
      attention: [],
      byAction: [],
      byOutcome: [],
      byRepo: [],
      byBackend: [],
      entropy: { action: 0, outcome: 0, repo: 0 },
      recentActions: [],
    };

    const degraded = formatFleetStatus({
      ...base,
      workspace: {
        ...workspace,
        sourceQuality: {
          sourceState: 'degraded', sourcePresent: true, complete: false,
          stopReasons: ['byte-limit'], filesRead: 1, bytesRead: 1024,
          rowsScanned: 0, invalidRows: 0, unreadableFiles: 0,
        },
      },
    });
    expect(degraded).toContain('source:    degraded (partial); files 1, bytes 1024, rows 0');
    expect(degraded).toContain('stopped:   byte-limit');
    expect(degraded).toContain('events:    0 observed (partial)');
    expect(degraded).toContain('diagnostic proposal rate partial');
    expect(degraded).not.toContain('diagnostic proposal rate 0%');

    const missing = formatFleetStatus({
      ...base,
      workspace: {
        ...workspace,
        sourceQuality: {
          sourceState: 'missing', sourcePresent: false, complete: true,
          stopReasons: [], filesRead: 0, bytesRead: 0,
          rowsScanned: 0, invalidRows: 0, unreadableFiles: 0,
        },
      },
    });
    expect(missing).toContain('source:    missing');
    expect(missing).toContain('events:    unavailable');
    expect(missing).toContain('diagnostic proposal rate unavailable');
  });

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
        activity: {
          source: 'daemon-activity',
          sourceState: 'healthy',
          freshness: 'fresh',
          ownerState: 'alive',
          phase: 'tick',
          phaseStartedAt: '2026-06-17T00:01:30.000Z',
          observedAt: '2026-06-17T00:02:00.000Z',
          ageMs: 0,
          activeChildren: null,
          ownerMatches: true,
        },
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
    expect(out).toContain('activity:      tick active');
    expect(out).toContain('heartbeat:     2026-06-17T00:02:00.000Z');
  });

  it('renders post-tick child activity separately from tick progress', () => {
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:03:00.000Z',
      daemon: {
        running: true,
        lastTickAt: '2026-06-17T00:02:00.000Z',
        childActivity: true,
        activity: {
          source: 'daemon-activity', sourceState: 'healthy', freshness: 'fresh', ownerState: 'alive', phase: 'post-tick',
          phaseStartedAt: '2026-06-17T00:02:01.000Z', observedAt: '2026-06-17T00:02:30.000Z',
          ageMs: 30_000, activeChildren: 2, ownerMatches: true,
        },
        todaySpentUsd: 0,
      },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });

    expect(out).toContain('child work:    2 active');
    expect(out).toContain('activity:      2 children active');
    expect(out).not.toContain('current tick:  in progress');
  });

  it('labels stale, missing, and owner-mismatched activity without false zeroes', () => {
    const base = {
      generatedAt: '2026-06-17T00:03:00.000Z',
      backends: [], queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 }, killed: false,
    };
    const activityBase = {
      source: 'daemon-activity' as const,
      phase: 'idle' as const,
      phaseStartedAt: '2026-06-17T00:02:01.000Z',
      observedAt: '2026-06-17T00:02:30.000Z',
      ageMs: 30_000,
      activeChildren: null,
      ownerMatches: true,
      ownerState: 'alive' as const,
    };
    const render = (activity: FleetStatus['daemon']['activity']) => formatFleetStatus({
      ...base,
      daemon: { running: true, lastTickAt: null, todaySpentUsd: 0, activity },
    });

    expect(render({ ...activityBase, sourceState: 'healthy', freshness: 'stale' }))
      .toContain('activity:      activity stale');
    expect(render({ ...activityBase, sourceState: 'missing', freshness: 'unknown' }))
      .toContain('activity:      activity unavailable');
    expect(render({
      ...activityBase, sourceState: 'healthy', freshness: 'fresh', ownerMatches: false,
    })).toContain('activity:      activity owner unavailable');
    expect(render({ ...activityBase, sourceState: 'missing', freshness: 'unknown' }))
      .not.toMatch(/child work:|0 active/);
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

  it('renders bounded per-arm treatment progress without exposing raw metadata', () => {
    const rawId = 'RAW_TREATMENT_ID_CANARY_M49';
    const rawPayload = 'RAW_TREATMENT_PAYLOAD_CANARY_M49';
    const dispatchProduction: NonNullable<FleetStatus['dispatchProduction']> = {
      windowHours: 24,
      attempts: 5,
      events: 5,
      proposalsCreated: 2,
      noProposal: 3,
      proposalRate: 0.4,
      spentUsd: 0,
      generatedRepairAttempts: {
        attempts: 5,
        proposalsCreated: 2,
        noProposal: 3,
        proposalRate: 0.4,
        captureRepairs: 0,
        diagnosticReslices: 5,
        proposalRepairs: 0,
        treatmentAttribution: {
          eligibleEvents: 7,
          attributedEvents: 5,
          unattributedEvents: 1,
          distinctUnits: 5,
          replayedEvents: 1,
          minimumTerminalUnitsPerArm: 3,
          arms: [
            { repairTreatment: 'target-localization', attributedUnits: 3, terminalUnits: 2, remaining: 1 },
            { repairTreatment: 'baseline-reslice', attributedUnits: 2, terminalUnits: 1, remaining: 2 },
          ],
          gate: 'withheld',
          blockers: ['in-flight', 'unmatched-terminal', 'unattributed', 'replayed', 'source-incomplete'],
          ...{ rawId, rawPayload },
        },
      },
      outcomes: {
        proposalCreated: 2,
        emptyDiff: 3,
        gateBlocked: 0,
        engineFailed: 0,
        sandboxFailed: 0,
        proposalCaptureError: 0,
        proposalDisabled: 0,
        unknown: 0,
      },
      topReasons: [],
      diagnosticTopReasons: [],
      byBackend: [],
      bySource: [],
      byRepo: [],
      byBackendModel: [],
      byBackendSource: [],
    };
    const base = {
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    };

    const out = formatFleetStatus({ ...base, dispatchProduction });

    expect(out).toContain(
      'treatment: baseline-reslice 1/3 terminal, target-localization 2/3 terminal; ' +
        'gate withheld; blockers in-flight, unmatched-terminal, unattributed (+2 more)',
    );
    expect(out).not.toContain(rawId);
    expect(out).not.toContain(rawPayload);

    const withoutTreatment = formatFleetStatus({
      ...base,
      dispatchProduction: {
        ...dispatchProduction,
        generatedRepairAttempts: {
          ...dispatchProduction.generatedRepairAttempts!,
          treatmentAttribution: undefined,
        },
      },
    });
    expect(withoutTreatment).not.toContain('  treatment:');
  });

  it('labels treatment rates as proposal conversion only', () => {
    const dispatchProduction: NonNullable<FleetStatus['dispatchProduction']> = {
      windowHours: 24,
      attempts: 6,
      events: 6,
      proposalsCreated: 3,
      noProposal: 3,
      proposalRate: 0.5,
      spentUsd: 0,
      generatedRepairAttempts: {
        attempts: 6,
        proposalsCreated: 3,
        noProposal: 3,
        proposalRate: 0.5,
        captureRepairs: 0,
        diagnosticReslices: 6,
        proposalRepairs: 0,
        treatmentAttribution: {
          eligibleEvents: 6,
          attributedEvents: 6,
          unattributedEvents: 0,
          distinctUnits: 6,
          replayedEvents: 0,
          minimumTerminalUnitsPerArm: 3,
          arms: [
            { repairTreatment: 'target-localization', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
            { repairTreatment: 'baseline-reslice', attributedUnits: 3, terminalUnits: 3, remaining: 0 },
          ],
          gate: 'ready',
          blockers: [],
        },
        treatmentConversions: [
          { repairTreatment: 'target-localization', attempts: 3, proposalsCreated: 2, noProposal: 1, proposalRate: 2 / 3 },
          { repairTreatment: 'baseline-reslice', attempts: 3, proposalsCreated: 1, noProposal: 2, proposalRate: 1 / 3 },
        ],
      },
      outcomes: {
        proposalCreated: 3,
        emptyDiff: 3,
        gateBlocked: 0,
        engineFailed: 0,
        sandboxFailed: 0,
        proposalCaptureError: 0,
        proposalDisabled: 0,
        unknown: 0,
      },
      topReasons: [],
      diagnosticTopReasons: [],
      byBackend: [],
      bySource: [],
      byRepo: [],
      byBackendModel: [],
      byBackendSource: [],
    };
    const out = formatFleetStatus({
      generatedAt: '2026-06-17T00:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      dispatchProduction,
      merges: { recent: 0 },
      killed: false,
    });

    expect(out).toContain(
      'treatment: baseline-reslice 3/3 terminal, target-localization 3/3 terminal; gate ready; blockers none; ' +
        'proposal conversion baseline-reslice 1/3 (33%), target-localization 2/3 (67%)',
    );
    expect(out).not.toMatch(/treatment:.*(?:verified|verification|merged|merge quality)/i);
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
          capability: {
            scope: 'local-primitives-only',
            durabilityPolicy: 'posix-file-and-directory-fsync',
            checked: true,
            verified: true,
            failure: null,
          },
          trustedCoherentStorage: true,
          authorityReady: true,
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
        authorityState: 'ready',
        protocols: { sealedV3: 2, legacy: 1 },
        sourceQuality: {
          sourceState: 'healthy', sourcePresent: true, complete: true,
          filesRead: 3, bytesRead: 1024, invalidFiles: 0, unreadableFiles: 0, limitExceeded: false,
        },
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
    expect(out).toContain('shared:        authority-ready / 2 active / 1 owned / 1 reclaimable / 2 cooling / stale lock');
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
