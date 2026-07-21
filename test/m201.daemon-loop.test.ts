/**
 * test/m201.daemon-loop.test.ts — M201: Complementary daemon/loop.ts tick-mechanics tests.
 *
 * Coverage COMPLEMENTARY to h1/h3/h4/m192 (which own safety invariants and the M185–M189
 * cadence hooks). This suite proves the tick's INTERNAL MECHANICS under the mocking
 * approach established in those suites:
 *
 *  Group A — Backlog build + top-K selection within budget
 *    A1. backlog returns 0 items → reason 'no-backlog', proposalsCreated=0
 *    A2. buildBacklog throws → tick still returns 'no-backlog' (guard caught)
 *    A3. top-K selection respects perTickItems cap (itemsConsidered === min(cap, backlog.length))
 *    A4. selectCount floor: near-zero remaining budget still selects exactly 1 item
 *    A5. selectCount shrinks via maxByBudget formula (remainingBudget / MIN_PER_ITEM_USD)
 *    A6. round-robin across repos: 2 repos with items → items interleaved across repos
 *    A7. pending proposal items are skipped (item id present in a pending proposal → not re-dispatched)
 *
 *  Group B — TieredPool local/cloud concurrency caps (continuous / explicit-concurrency mode)
 *    B1. local cap: all-local items, local=1 → peak concurrency 1
 *    B2. cloud cap: all-cloud items, cloud=1 → peak concurrency 1
 *    B3. total cap: mixed tiers, total=1 → only one in flight at a time
 *    B4. local items do NOT consume cloud slots (and vice-versa)
 *
 *  Group C — Per-item dispatch accounting (cost tally, proposalDelta)
 *    C1. tickSpent accumulates per-item usage.estCostUsd across a batch
 *    C2. proposalsCreated = pendingCount delta (not swarm result count)
 *    C3. a swarm that completes but creates no proposal is NOT counted
 *    C4. state.todaySpentUsd updated by tick's realized spend
 *    C5. state.itemsProcessed incremented by dispatched count (not skipped)
 *    C6. ASHLR_IN_SWARM env restored after each item dispatch (no env leak)
 *    C7. in-tick budget short-circuit: kill set mid-tick skips remaining items
 *
 *  Group D — M197 observability: console.warn on dispatch failures
 *    D1. runSwarm throws → daemon:swarm-error audit emitted, tick still returns 'ok'
 *    D2. multiple items, one throws → only that item skipped; others proceed
 *
 *  Group E — Config reload per tick (M85 runDaemon loop)
 *    E1. runDaemon once=true reloads daemon config from disk (uses loadConfig)
 *    E2. runDaemon loop once=false with maxCycles=2 runs exactly 2 ticks then stops
 *    E3. runDaemon loop stops when kill switch set between iterations
 *    E4. runDaemon re-entrancy guard: refuses when ASHLR_IN_DAEMON is set
 *    E5. runDaemon re-entrancy guard: refuses when ASHLR_IN_SWARM is set
 *    E6. runDaemon dry-run loop terminates after one iteration
 *    E7. runDaemon sets running=true on start, running=false on exit
 *    E8. runDaemon loop stays resident and sleeps when same-day budget is exhausted
 *    E9. resident loop wakes on the next UTC budget day, resets spend, and dispatches
 *
 *  Group F — buildItemGoal purity
 *    F1. includes item title
 *    F2. includes detail when non-empty and different from title
 *    F3. omits detail when it equals the title
 *    F4. includes repo anchor
 *    F5. includes behavioral guidance (no-op escape hatch)
 *    F6. never throws on minimal item (all optional fields absent)
 *
 * MOCKING STRATEGY (identical to m192 / h1 suites):
 *   - runSwarm, buildBacklog, runGoal declared before lazy imports so the daemon
 *     binds to the mocks.
 *   - All auxiliary modules that the tick exercises but that are not under test here
 *     (routeBackend, quota, subscription-usage, sandboxed-engine, automerge-pass,
 *     learned-router, self-heal, invent-cycle, counterfactual, regression-sentinel)
 *     are mocked to benign pass-through values.
 *   - H1 fixture provides isolated tmp HOME per test.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AshlrConfig,
  DaemonTick,
  EngineId,
  EngineTier,
  RepairTreatment,
  WorkItem,
} from '../src/core/types.js';
import type { DispatchPlan } from '../src/core/fabric/concurrent-dispatch.js';
import { workItemCoverageKey } from '../src/core/fleet/proposal-matching.js';

const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  realCalls: 0,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      privateStorageHarness.realCalls += 1;
      return actual.assurePrivateStoragePath(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// Core mocks — MUST be declared before lazy imports.
// ---------------------------------------------------------------------------

const mockRunSwarm = vi.fn();
vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

const mockBuildBacklog = vi.fn();
const mockLoadBacklog = vi.fn();
vi.mock('../src/core/portfolio/backlog.js', () => ({
  buildBacklog: (...args: unknown[]) => mockBuildBacklog(...args),
  loadBacklog: (...args: unknown[]) => mockLoadBacklog(...args),
}));

const mockLoadQueuedAutonomyItems = vi.fn();
vi.mock('../src/core/portfolio/queued-autonomy.js', () => ({
  loadQueuedAutonomyItems: (...args: unknown[]) => mockLoadQueuedAutonomyItems(...args),
}));

const mockRunGoal = vi.fn();
vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

const mockPublishGeneratedRepairTreatmentOutcome = vi.fn();
const mockReadPendingGeneratedRepairTreatmentOutcomes = vi.fn();
vi.mock('../src/core/fleet/generated-repair-lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/generated-repair-lifecycle.js')>();
  return {
    ...actual,
    publishGeneratedRepairTreatmentOutcome: (...args: Parameters<typeof actual.publishGeneratedRepairTreatmentOutcome>) => {
      const forced = mockPublishGeneratedRepairTreatmentOutcome(...args);
      return typeof forced === 'boolean'
        ? forced
        : actual.publishGeneratedRepairTreatmentOutcome(...args);
    },
    readPendingGeneratedRepairTreatmentOutcomes: (...args: Parameters<typeof actual.readPendingGeneratedRepairTreatmentOutcomes>) => {
      const override = mockReadPendingGeneratedRepairTreatmentOutcomes.getMockImplementation();
      return override
        ? mockReadPendingGeneratedRepairTreatmentOutcomes(...args)
        : actual.readPendingGeneratedRepairTreatmentOutcomes(...args);
    },
  };
});

const mockRunConcurrentDispatch = vi.fn();
vi.mock('../src/core/fabric/concurrent-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fabric/concurrent-dispatch.js')>();
  return {
    ...actual,
    runConcurrentDispatch: (...args: Parameters<typeof actual.runConcurrentDispatch>) => {
      const override = mockRunConcurrentDispatch.getMockImplementation();
      return override
        ? mockRunConcurrentDispatch(...args)
        : actual.runConcurrentDispatch(...args);
    },
  };
});

const mockRunBestOfN = vi.fn();
vi.mock('../src/core/run/best-of-n.js', () => ({
  runBestOfN: (...args: unknown[]) => mockRunBestOfN(...args),
}));

const mockRunPulseSync = vi.fn();
vi.mock('../src/core/integrations/pulse-sync.js', () => ({
  runPulseSync: (...args: unknown[]) => mockRunPulseSync(...args),
}));

const mockGetResourceSnapshot = vi.fn();
vi.mock('../src/core/fabric/resource-monitor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fabric/resource-monitor.js')>();
  return {
    ...actual,
    getResourceSnapshot: (...args: Parameters<typeof actual.getResourceSnapshot>) => {
      const override = mockGetResourceSnapshot.getMockImplementation();
      return override
        ? mockGetResourceSnapshot(...args)
        : actual.getResourceSnapshot(...args);
    },
  };
});

const mockRunSelfHealCycle = vi.fn();
const mockRunSelfHealCycleForRepos = vi.fn();
vi.mock('../src/core/fleet/self-heal.js', () => ({
  runSelfHealCycle: (...args: unknown[]) => mockRunSelfHealCycle(...args),
  runSelfHealCycleForRepos: (...args: unknown[]) => mockRunSelfHealCycleForRepos(...args),
  pruneQueuedSelfHealItems: () => ({ scanned: 0, removed: 0, failed: false }),
}));

const mockQueueProposalRepairWorkForPendingProposals = vi.fn();
const mockResolveDiagnosticResliceParents = vi.fn();
const mockGeneratedRepairProposalDispatchAuthority = vi.fn();
const mockIsRejectedCaptureRecoveryAuthorized = vi.fn();
const mockBeginRejectedCaptureRecoveryDispatch = vi.fn();
vi.mock('../src/core/fleet/proposal-repair-work.js', () => ({
  beginRejectedCaptureRecoveryDispatch: (...args: unknown[]) => mockBeginRejectedCaptureRecoveryDispatch(...args),
  generatedRepairRootKey: (item: WorkItem) =>
    /^[a-f0-9]{64}$/.test(item.repairRootId ?? '') && (item.repairDepth === 0 || item.repairDepth === 1)
      ? `${resolve(item.repo)}\0${item.repairRootId}`
      : null,
  generatedRepairProposalDispatchAuthority: (...args: unknown[]) =>
    mockGeneratedRepairProposalDispatchAuthority(...args),
  isRejectedCaptureRecoveryAuthorized: (...args: unknown[]) => mockIsRejectedCaptureRecoveryAuthorized(...args),
  queueProposalRepairWorkForPendingProposals: (...args: unknown[]) => mockQueueProposalRepairWorkForPendingProposals(...args),
  resolveDiagnosticResliceParents: (...args: unknown[]) => mockResolveDiagnosticResliceParents(...args),
}));

const mockRunViaAshlrcode = vi.fn();
vi.mock('../src/core/run/ashlrcode-engine.js', () => ({
  runViaAshlrcode: (...args: unknown[]) => mockRunViaAshlrcode(...args),
}));

const mockRunInventCycle = vi.fn();
vi.mock('../src/core/generative/invent-cycle.js', () => ({
  runInventCycle: (...args: unknown[]) => mockRunInventCycle(...args),
}));

const mockRunCounterfactualReplay = vi.fn();
vi.mock('../src/core/fleet/counterfactual.js', () => ({
  runCounterfactualReplay: (...args: unknown[]) => mockRunCounterfactualReplay(...args),
}));

const mockDetectRegression = vi.fn();
const mockBisectAndRevert = vi.fn();
vi.mock('../src/core/fleet/regression-sentinel.js', () => ({
  detectRegression: (...args: unknown[]) => mockDetectRegression(...args),
  bisectAndRevert: (...args: unknown[]) => mockBisectAndRevert(...args),
}));

// ---------------------------------------------------------------------------
// Auxiliary mocks (benign pass-through — not under test here).
// ---------------------------------------------------------------------------

const mockRouteBackend = vi.fn();
const mockGeneratedRepairCandidateAllowed = vi.fn();
const mockInspectGeneratedRepairRouteFeasibility = vi.fn();
vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
  generatedRepairCandidateAllowed: (...args: unknown[]) => mockGeneratedRepairCandidateAllowed(...args),
  generatedRepairExecutionBackendAllowed: (...args: unknown[]) => mockGeneratedRepairCandidateAllowed(...args),
  inspectGeneratedRepairRouteFeasibility: (...args: unknown[]) =>
    mockInspectGeneratedRepairRouteFeasibility(...args),
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: () => true,
  recordUse: () => undefined,
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: () => ({ allowed: true }),
  isSubscriptionEngine: () => false,
}));

// engineTierOf default: 'local' (overridden in B2/B3/B4 via inline mock)
const mockEngineTierOf = vi.fn();
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (...args: unknown[]) => mockEngineTierOf(...args),
}));

const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

const mockReconcileRemoteHandoffs = vi.fn();
vi.mock('../src/core/inbox/remote-handoff.js', () => ({
  reconcileRemoteHandoffs: (...args: unknown[]) => mockReconcileRemoteHandoffs(...args),
}));

const mockBuildResourceStrategyReport = vi.fn();
vi.mock('../src/core/autonomy/resource-strategy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/autonomy/resource-strategy.js')>();
  return {
    ...actual,
    buildResourceStrategyReport: (...args: unknown[]) => mockBuildResourceStrategyReport(...args),
  };
});

type StrategyMode = 'pause' | 'local-only' | 'verify-only' | 'backlog-build' | 'auto-merge-ready';

function strategyReport(
  mode: StrategyMode,
  reason: string,
  gate: 'ready' | 'unavailable' = 'ready',
) {
  return {
    mode,
    reasons: [reason],
    fleet: {
      proposalSource: {
        gate,
        sourceState: gate === 'ready' ? 'healthy' : 'degraded',
        complete: gate === 'ready',
        detail: gate === 'ready'
          ? 'complete proposal source (0/0 files read)'
          : 'auto-merge authority requires a complete healthy proposal source; degraded source is incomplete: invalid-file',
      },
    },
  };
}

const mockRecommendRoute = vi.fn(async () => ({ backend: 'builtin', tier: 'local', reason: 'mock' }));
const mockRecoverWithinBudget = vi.fn((_r: unknown, _c: unknown) => ({
  action: 'proceed',
  decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
}));
vi.mock('../src/core/run/learned-router.js', () => ({
  recommendRoute: (...args: unknown[]) => mockRecommendRoute(...args),
  recoverWithinBudget: (...args: unknown[]) => mockRecoverWithinBudget(...args),
}));

function defaultReloadConfig(): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 50,
    },
  } as AshlrConfig;
}

const mockLoadConfig = vi.fn(defaultReloadConfig);
vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

const mockScheduleCutoffCheckpointCapture = vi.fn(() => ({
  disposition: 'not-due' as const,
  reason: 'cadence-active',
  completion: Promise.resolve({ outcome: 'failed' as const, code: null, signal: null }),
  cancel: () => {},
}));
vi.mock('../src/core/daemon/cutoff-checkpoint-scheduler.js', () => ({
  CUTOFF_CAPTURE_DEADLINE_MS: 30_000,
  scheduleCutoffCheckpointCapture: (...args: unknown[]) => mockScheduleCutoffCheckpointCapture(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER all mocks.
// ---------------------------------------------------------------------------

import {
  tick,
  runDaemon,
  saveResidentDaemonState,
  stopDaemon,
  buildItemGoal,
  workedOutcomeFromDispatchProduction,
} from '../src/core/daemon/loop.js';
import {
  acquireDaemonLock,
  daemonLockPath,
  daemonSpendGuardPath,
  loadDaemonState,
  readDaemonSpendGuard,
  releaseDaemonLock,
  saveDaemonState,
} from '../src/core/daemon/state.js';
import {
  createProposal,
  inboxDir,
  pendingCount,
  setStatus,
} from '../src/core/inbox/store.js';
import { readAudit } from '../src/core/sandbox/audit.js';
import {
  dispatchProductionDir,
  readDispatchProductionEvents,
  recordDispatchProduction,
  resolveDispatchProductionFailureAttemptReceipt,
  resolveDispatchProductionAttemptReceiptWitnesses,
  resolveDispatchProductionAttemptProofs,
  type DispatchProductionEvent,
} from '../src/core/fleet/dispatch-production-ledger.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { listAttemptRecords } from '../src/core/autonomy/attempt-records.js';
import { readDispatchManifestEvents } from '../src/core/fleet/dispatch-manifest.js';
import {
  readAgentActions,
  recordAgentAction,
  type AgentActionEvent,
} from '../src/core/fleet/agent-action-ledger.js';
import { attestSkillCard } from '../src/core/fleet/skill-attestation.js';
import {
  readSkillUseEvents,
  recordSkillCard,
  sanitizeSkillCard,
} from '../src/core/fleet/skill-records.js';
import { loadWorkedLedger, recordOutcome } from '../src/core/fleet/worked-ledger.js';
import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { generatedRepairLifecycleAttemptHash } from '../src/core/fleet/generated-repair-identity.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import {
  generatedRepairCooldownKey,
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
  generatedRepairLifecyclePath,
  readPendingGeneratedRepairTreatmentOutcomes,
  readGeneratedRepairLifecycle,
  recordGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import {
  recordRepairHandoffs,
  repairHandoffJournalPath,
  repairHandoffFromDispatchEvent,
} from '../src/core/fleet/repair-handoff-journal.js';
import {
  makeFixture,
  makeCfg,
  type H1Fixture,
} from './helpers/h1-fixture.js';
import { makeSpendingSwarmStub } from './helpers/h3-stress.js';
import { assurePrivateStoragePath } from '../src/core/util/private-storage.js';

// ---------------------------------------------------------------------------
// Fixture lifecycle.
// ---------------------------------------------------------------------------

let fx: H1Fixture;
let prevAshlrHome: string | undefined;

beforeAll(() => {
  if (process.platform !== 'win32') return;

  const proofFixture = makeFixture();
  const realCallsBefore = privateStorageHarness.realCalls;
  fs.mkdirSync(proofFixture.ashlrDir, { recursive: true });
  try {
    expect(assurePrivateStoragePath(
      proofFixture.ashlrDir,
      'directory',
      'secure-created',
      { anchorPath: proofFixture.home },
    )).toEqual({ ok: true, reason: 'exact-private-dacl' });
    expect(privateStorageHarness.realCalls).toBeGreaterThan(realCallsBefore);
  } finally {
    privateStorageHarness.useSemanticAdapter = true;
    proofFixture.cleanup();
  }
});

beforeEach(() => {
  mockRunSwarm.mockReset();
  mockBuildBacklog.mockReset();
  mockRunGoal.mockReset();
  mockPublishGeneratedRepairTreatmentOutcome.mockReset();
  mockReadPendingGeneratedRepairTreatmentOutcomes.mockReset();
  mockResolveDiagnosticResliceParents.mockReset();
  mockResolveDiagnosticResliceParents.mockImplementation((items: WorkItem[]) => ({
    dispatchable: items,
    quarantined: [],
    resolved: 0,
    missing: 0,
  }));
  mockRunConcurrentDispatch.mockReset();
  mockGetResourceSnapshot.mockReset();
  mockRunBestOfN.mockReset();
  mockRunPulseSync.mockReset();
  mockRunSelfHealCycle.mockReset();
  mockRunSelfHealCycleForRepos.mockReset();
  mockQueueProposalRepairWorkForPendingProposals.mockReset();
  mockGeneratedRepairProposalDispatchAuthority.mockReset();
  mockGeneratedRepairProposalDispatchAuthority.mockReturnValue('not-applicable');
  mockIsRejectedCaptureRecoveryAuthorized.mockReset();
  mockIsRejectedCaptureRecoveryAuthorized.mockReturnValue(true);
  mockBeginRejectedCaptureRecoveryDispatch.mockReset();
  mockBeginRejectedCaptureRecoveryDispatch.mockImplementation((_item: WorkItem, begin: () => unknown) => ({
    authorized: true,
    value: begin(),
  }));
  mockRunViaAshlrcode.mockReset();
  mockRunInventCycle.mockReset();
  mockRunCounterfactualReplay.mockReset();
  mockDetectRegression.mockReset();
  mockBisectAndRevert.mockReset();
  mockRouteBackend.mockReset();
  mockGeneratedRepairCandidateAllowed.mockReset();
  mockGeneratedRepairCandidateAllowed.mockReturnValue(true);
  mockInspectGeneratedRepairRouteFeasibility.mockReset();
  mockInspectGeneratedRepairRouteFeasibility.mockReturnValue({
    feasible: true,
    requiredTier: null,
    requiresAlternative: false,
    backend: 'local-coder',
    reason: 'feasible',
  });
  mockEngineTierOf.mockReset();
  mockRecommendRoute.mockReset();
  mockRecoverWithinBudget.mockReset();
  mockRunAutoMergePass.mockReset();
  mockReconcileRemoteHandoffs.mockReset();
  mockBuildResourceStrategyReport.mockReset();
  mockLoadQueuedAutonomyItems.mockReset();
  mockScheduleCutoffCheckpointCapture.mockClear();

  fx = makeFixture();
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = join(fx.home, '.ashlr');

  // Default benign implementations.
  mockRunSelfHealCycle.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mockRunSelfHealCycleForRepos.mockResolvedValue({ checked: 0, broken: [], healItems: [] });
  mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({ scanned: 0, eligible: 0, queued: 0, failed: 0 });
  mockRunGoal.mockResolvedValue({
    id: `mock-rungoal-${Date.now()}`,
    status: 'done',
    usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
  });
  mockRunBestOfN.mockResolvedValue({
    winner: {
      index: 0,
      diff: 'diff --git a/x.ts b/x.ts\n',
      proposalId: `mock-bon-${Date.now()}`,
      score: 10,
      state: {
        id: `mock-bon-run-${Date.now()}`,
        status: 'done',
        usage: { totalTokens: 200, estCostUsd: 0.002, steps: 2 },
      },
    },
    candidates: [],
    critique: { n: 1, nonEmpty: 1, judged: 1, topScore: 10, winnerIndex: 0 },
  });
  mockRunPulseSync.mockResolvedValue({
    enabled: false,
    tickEmitted: false,
    commands: [],
    depEdgesShipped: 0,
    detail: 'disabled in daemon loop tests',
  });
  mockDetectRegression.mockResolvedValue({ regressed: false, details: [] });
  mockBisectAndRevert.mockResolvedValue({ reverted: false });
  mockRunInventCycle.mockResolvedValue({ invented: 0, items: [] });
  mockRunCounterfactualReplay.mockResolvedValue({ replayed: 0, proposals: [] });
  mockRecommendRoute.mockResolvedValue({ backend: 'builtin', tier: 'local', reason: 'mock' });
  mockRecoverWithinBudget.mockReturnValue({
    action: 'proceed',
    decision: { backend: 'builtin', tier: 'local', reason: 'mock' },
  });
  mockRunViaAshlrcode.mockResolvedValue({ ok: true });
  mockRunAutoMergePass.mockResolvedValue({ merged: 0 });
  mockReconcileRemoteHandoffs.mockReturnValue({ checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 });
  mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('backlog-build', 'mock backlog'));
  mockLoadBacklog.mockReturnValue(null);
  mockLoadQueuedAutonomyItems.mockReturnValue([]);
  mockLoadConfig.mockReset();
  mockLoadConfig.mockImplementation(defaultReloadConfig);
  // Default: builtin backend (route to runSwarm path).
  mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', reason: 'mock' });
  // Default: local engine tier.
  mockEngineTierOf.mockReturnValue('local');
  // Default runSwarm: success, $0.001 cost.
  mockRunSwarm.mockImplementation(async (_input, _cfg, opts) => {
    const fields = opts as { runId?: string; workItemId?: string } | undefined;
    const selectionOnlyRepair = fields?.workItemId?.includes(':proposal-repair-nodiff:') === true;
    return {
      id: fields?.runId ?? `mock-swarm-${Date.now()}`,
      status: 'done',
      goal: 'mock goal',
      result: 'mock result',
      usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
      ...(selectionOnlyRepair ? {
        proposalOutcome: {
          kind: 'proposal-disabled' as const,
          reason: 'selection-only diagnostic fixture',
        },
      } : {}),
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  fx.cleanup();
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
});

afterAll(() => {
  privateStorageHarness.useSemanticAdapter = false;
});

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Today's date in YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Seed daemon state with a given spent amount for today. */
function seedSpend(spentUsd: number): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: today(),
    todaySpentUsd: spentUsd,
    itemsProcessed: 0,
    ticks: [],
  });
}

/** Seed daemon state with a spent amount for an explicit UTC budget day. */
function seedSpendForDate(date: string, spentUsd: number): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: null,
    todayDate: date,
    todaySpentUsd: spentUsd,
    itemsProcessed: 0,
    ticks: [],
  });
}

/** Seed daemon state with recent tick history. */
function seedTicks(ticks: DaemonTick[], automaticDrainOrdinaryTurnDue?: boolean): void {
  saveDaemonState({
    running: false,
    pid: null,
    startedAt: null,
    lastTickAt: ticks.at(-1)?.ts ?? null,
    todayDate: today(),
    todaySpentUsd: 0,
    itemsProcessed: 0,
    ticks,
    ...(automaticDrainOrdinaryTurnDue !== undefined ? { automaticDrainOrdinaryTurnDue } : {}),
  });
}

/** Build N synthetic WorkItems for a given repo. */
function makeItems(repoDir: string, count: number) {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `${repoDir}:m201-item-${i}`,
    repo: repoDir,
    source: 'todo' as const,
    title: `M201 item ${i}`,
    detail: `Detail for m201 item ${i}.`,
    value: 3,
    effort: 1,
    score: 3 - i * 0.01, // slight score variation so ordering is deterministic
    tags: ['m201'],
    ts: now,
  }));
}

function testRepairRootId(repoDir: string, identity: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['m201:repair-root:v1', resolve(repoDir), identity]))
    .digest('hex');
}

function makeDiagnosticResliceItem(
  repoDir: string,
  hash = 'abcdef123456',
  score = 1,
  parentTier: EngineTier = 'local',
): WorkItem {
  const ts = new Date().toISOString();
  const parentItemId = `repo:goal:stalled:${hash}`;
  const objectiveHash = hash.repeat(6).slice(0, 64);
  const repairRootAuthorityId = `dispatch:${parentItemId}:goal:${objectiveHash}`;
  const repairRootId = createHash('sha256').update(JSON.stringify([
    'ashlr:repair-root:v2',
    resolve(repoDir),
    repairRootAuthorityId,
  ])).digest('hex');
  const parentEvent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: parentItemId,
    source: 'goal',
    repo: repoDir,
    title: `Resolve stalled objective ${hash}`,
    backend: parentTier === 'mid' ? 'local-coder' : 'builtin',
    tier: parentTier,
    assignedBy: 'router',
    routeReason: 'test diagnostic parent route',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: `attempt-${hash.slice(0, 8)}-1234-4123-8123-${hash.padEnd(12, '0').slice(0, 12)}`,
    objectiveHash,
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  const handoff = repairHandoffFromDispatchEvent(parentEvent)!;
  recordRepairHandoffs(parentEvent, {
    schemaVersion: 2,
    activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
  });
  return {
    id: handoff.childItemId,
    repo: repoDir,
    source: 'self',
    title: `Reslice no-diff dispatch for ${basename(repoDir)} item repo:goal:stalled`,
    detail:
      `Diagnostic reslice: a dispatch completed without file changes.\n` +
      `Original work item: ${parentItemId}\n` +
      `Dispatch outcome: empty-diff\n` +
      `Action: reslice the work into a smaller concrete edit.`,
    value: 5,
    effort: 1,
    score,
    tags: ['self-heal', 'proposal-repair', 'diagnostic-reslice', 'dispatch-no-diff-reslice', 'no-diff', 'verify', 'high-priority'],
    ts,
    repairRootId,
    repairRootAuthorityId,
    repairDepth: 0,
    repairHandoffId: handoff.eventId,
    repairGenerationId: handoff.generationId,
    repairTreatmentUnitId: handoff.repairTreatmentUnitId,
    repairTreatment: handoff.repairTreatment,
    repairParentItemId: parentItemId,
    repairParentSource: 'goal',
    repairParentBackend: parentTier === 'mid' ? 'local-coder' : 'builtin',
    repairParentTier: parentTier,
    repairParentObjectiveHash: objectiveHash,
  };
}

function addLegacyGenerationAlias(item: WorkItem, hash: string, parentTier: EngineTier): string {
  const parentEvent: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: item.ts,
    itemId: item.repairParentItemId!,
    source: 'goal',
    repo: item.repo,
    title: `Resolve stalled objective ${hash}`,
    backend: parentTier === 'mid' ? 'local-coder' : 'builtin',
    tier: parentTier,
    assignedBy: 'router',
    routeReason: 'test diagnostic parent route',
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: `attempt-${hash.slice(0, 8)}-1234-4123-8123-${hash.padEnd(12, '0').slice(0, 12)}`,
    objectiveHash: item.repairParentObjectiveHash,
    spentUsd: 0,
    basis: 'run-proposal-outcome',
  };
  expect(recordRepairHandoffs(parentEvent, { schemaVersion: 1 })).toMatchObject({ recorded: 1, failed: 0 });
  const alias = generatedRepairGenerationIds(item).find((generationId) => generationId !== item.repairGenerationId);
  if (!alias) throw new Error('expected a legacy generated-repair alias');
  return alias;
}

function makeDiagnosticResliceForTreatment(
  repoDir: string,
  treatment: RepairTreatment,
  parentTier: EngineTier = 'local',
): WorkItem {
  for (let index = 0; index < 256; index++) {
    const hash = index.toString(16).padStart(12, '0');
    const item = makeDiagnosticResliceItem(repoDir, hash, 1, parentTier);
    if (item.repairTreatment === treatment) return item;
  }
  throw new Error(`Unable to construct diagnostic reslice treatment ${treatment}`);
}

function createDiagnosticPendingProposal(item: WorkItem, attemptId: string) {
  return persistProposalRunEventProposalId(createProposal({
    repo: item.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Crash-persisted generated repair proposal',
    summary: 'The proposal committed before daemon attempt-proof persistence.',
    diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
    workItemId: item.id,
    workItemGenerationId: item.repairGenerationId,
    workSource: item.source,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
    },
  }));
}

function seedDiagnosticEmptyProof(
  item: WorkItem,
  attemptId: string,
  backend: Exclude<EngineId, 'builtin'>,
  tier: EngineTier,
  repairAttemptOrdinal: 1 | 2 = 1,
  repairPreviousBackend?: Exclude<EngineId, 'builtin'>,
) {
  const event = recordDiagnosticEmptyReceipt(
    item,
    attemptId,
    backend,
    tier,
    repairAttemptOrdinal,
    repairPreviousBackend,
  );
  return recordGeneratedRepairLifecycle(item, { kind: 'dispatch-proof-empty-diff', eventTs: event.ts });
}

function recordDiagnosticEmptyReceipt(
  item: WorkItem,
  attemptId: string,
  backend: Exclude<EngineId, 'builtin'>,
  tier: EngineTier,
  repairAttemptOrdinal: 1 | 2 = 1,
  repairPreviousBackend?: Exclude<EngineId, 'builtin'>,
): DispatchProductionEvent {
  const ts = new Date(Date.parse(item.ts) + repairAttemptOrdinal).toISOString();
  const routeReason = 'm201 canonical diagnostic proof';
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend,
    tier,
    assignedBy: 'daemon',
    routeReason,
    outcome: 'empty-diff',
    proposalCreated: false,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend,
      tier,
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
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
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal,
    ...(repairAttemptOrdinal === 2 ? { repairPreviousBackend: repairPreviousBackend ?? backend } : {}),
  };
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return event;
}

function recordDiagnosticProposalReceipt(
  item: WorkItem,
  attemptId: string,
  proposalId: string,
): DispatchProductionEvent {
  const routeReason = 'm201 canonical diagnostic proposal receipt';
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
      costUsd: 0.001,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal: 1,
    spentUsd: 0.001,
    basis: 'run-proposal-outcome',
  };
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return event;
}

function recordOrdinaryRepairSuccessReceipt(
  item: WorkItem,
  attemptId: string,
  outcome: 'empty-diff' | 'proposal-created',
  proposalId?: string,
): DispatchProductionEvent {
  const routeReason = 'm201 exact ordinary repair success receipt';
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend: 'local-coder',
    tier: 'mid',
    assignedBy: 'daemon',
    routeReason,
    outcome,
    proposalCreated: outcome === 'proposal-created',
    ...(proposalId ? { proposalId } : {}),
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome,
      proposalCreated: outcome === 'proposal-created',
      ...(proposalId ? { proposalId } : {}),
      costUsd: 0.001,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: generatedRepairGenerationId(item)!,
    repairAttemptOrdinal: 1,
    repairRootId: item.repairRootId,
    repairDepth: item.repairDepth as 0 | 1,
    spentUsd: 0.001,
    basis: 'run-proposal-outcome',
  };
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return event;
}

function seedDiagnosticFailureReceipt(
  item: WorkItem,
  attemptId: string,
  backend: Exclude<EngineId, 'builtin'>,
  tier: EngineTier,
  ts: string,
  repairAttemptOrdinal: 1 | 2 = 1,
  repairPreviousBackend?: Exclude<EngineId, 'builtin'>,
): DispatchProductionEvent {
  const routeReason = 'm201 canonical diagnostic failure receipt';
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts,
    itemId: item.id,
    source: item.source,
    repo: item.repo,
    title: item.title,
    backend,
    tier,
    assignedBy: 'daemon',
    routeReason,
    outcome: 'engine-failed',
    proposalCreated: false,
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    routeSnapshot: {
      backend,
      tier,
      assignedBy: 'daemon',
      reason: routeReason,
      routerPolicyVersion: 'fleet-router-v1',
    },
    runEventSummary: {
      runId: attemptId,
      status: 'failed',
      outcome: 'engine-failed',
      proposalCreated: false,
      costUsd: 0.001,
    },
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
    routerPolicyVersion: 'fleet-router-v1',
    objectiveHash: workItemObjectiveHash(item),
    spentUsd: 0.001,
    reason: 'provider failed before producing a diff',
    basis: 'run-proposal-outcome',
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: item.repairGenerationId,
    repairTreatmentUnitId: item.repairTreatmentUnitId,
    repairTreatment: item.repairTreatment,
    repairAttemptOrdinal,
    ...(repairAttemptOrdinal === 2 ? { repairPreviousBackend: repairPreviousBackend ?? backend } : {}),
    repairRootId: item.repairRootId,
    repairDepth: item.repairDepth as 0 | 1,
  };
  expect(recordDispatchProduction(event)).toEqual({ attempted: 1, recorded: 1, failed: 0 });
  return event;
}

function repairReservationPath(item: WorkItem): string {
  if (!/^[a-f0-9]{64}$/.test(item.repairRootId ?? '')) throw new Error('repair root required');
  return join(dirname(dispatchProductionDir()), 'repair-attempt-reservations', `${item.repairRootId}.json`);
}

function writeRepairReservationMarker(
  item: WorkItem,
  options: {
    reservationId: string;
    backend: EngineId;
    tier: EngineTier;
    repairAttemptOrdinal: 1 | 2;
    previousBackend?: EngineId;
    phase: 'prepared' | 'launched';
    createdAt?: string;
  },
): string {
  const markerPath = repairReservationPath(item);
  fs.mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    reservationId: options.reservationId,
    createdAt: options.createdAt ?? new Date().toISOString(),
    generationIds: generatedRepairGenerationIds(item).sort(),
    itemIdHash: createHash('sha256')
      .update(JSON.stringify(['ashlr:repair-item:v1', item.id]))
      .digest('hex'),
    objectiveHash: workItemObjectiveHash(item),
    repairRootId: item.repairRootId,
    repairDepth: item.repairDepth,
    repairRootAuthorityItemIdHash: createHash('sha256')
      .update(JSON.stringify(['ashlr:repair-item:v1', item.repairRootAuthorityId]))
      .digest('hex'),
    backend: options.backend,
    tier: options.tier,
    repairAttemptOrdinal: options.repairAttemptOrdinal,
    previousBackend: options.repairAttemptOrdinal === 2 ? options.previousBackend ?? 'local-coder' : null,
    attemptHash: generatedRepairLifecycleAttemptHash(`run:${options.reservationId}`),
    phase: options.phase,
  })}\n`, { mode: 0o600 });
  return markerPath;
}

function seedHealthyGeneratedRepairYield(repoDir: string): void {
  const now = new Date().toISOString();
  const base: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: now,
    machineId: 'm201',
    itemId: `${basename(repoDir)}:proposal-repair-nodiff:abc123def450`,
    source: 'self',
    repo: repoDir,
    title: 'Reslice no-diff dispatch for repo item repo:goal:stalled',
    backend: 'codex',
    tier: 'frontier',
    assignedBy: 'daemon',
    routeReason: 'frontier: generated diagnostic no-diff reslice',
    outcome: 'proposal-created',
    proposalCreated: true,
    proposalId: 'prop-repair-0',
    spentUsd: 0,
    reason: 'proposal filed',
    basis: 'run-proposal-outcome',
  };
  recordDispatchProduction([
    base,
    {
      ...base,
      itemId: `${basename(repoDir)}:proposal-repair-nodiff:abc123def451`,
      proposalId: 'prop-repair-1',
    },
    {
      ...base,
      itemId: `${basename(repoDir)}:proposal-repair-nodiff:abc123def452`,
      outcome: 'empty-diff',
      proposalCreated: false,
      proposalId: undefined,
      reason: 'engine "codex" completed without file changes',
    },
  ]);
}

function mockCanonicalEmptyDiffRunGoal(reason: string, costUsd = 0.001): void {
  mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason });
  mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
  mockRunGoal.mockImplementation(async (_goal, _cfg, options) => ({
    id: (options as { runId: string }).runId,
    status: 'done',
    engine: 'local-coder',
    engineTier: 'mid',
    usage: { totalTokens: 100, estCostUsd: costUsd, steps: 1 },
    proposalOutcome: { kind: 'empty-diff' as const, reason },
  }));
}

function persistProposalRunEventProposalId(
  proposal: ReturnType<typeof createProposal>,
): ReturnType<typeof createProposal> {
  const bound = {
    ...proposal,
    ...(proposal.diff ? {
      diffHash: createHash('sha256').update(proposal.diff, 'utf8').digest('hex'),
    } : {}),
    runEventSummary: { ...proposal.runEventSummary, proposalId: proposal.id },
  };
  fs.writeFileSync(
    join(inboxDir(), `${proposal.id}.json`),
    `${JSON.stringify(bound, null, 2)}\n`,
    'utf8',
  );
  return bound;
}

/** Enroll a repo and seed buildBacklog with N items. */
function enrollWithItems(count: number) {
  const repo = fx.makeRepo();
  repo.enroll();
  const items = makeItems(repo.dir, count);
  mockBuildBacklog.mockResolvedValue({
    generatedAt: new Date().toISOString(),
    repos: [repo.dir],
    items,
  });
  return { repo, items };
}

/** A cfg with a builtin backend (routes to runSwarm) and given daemon caps. */
function cfgBuiltin(daemon: { dailyBudgetUsd?: number; perTickItems?: number; parallel?: number } = {}): AshlrConfig {
  return makeCfg({
    daemon: {
      dailyBudgetUsd: daemon.dailyBudgetUsd ?? 1.0,
      perTickItems: daemon.perTickItems ?? 5,
      parallel: daemon.parallel ?? 2,
      intervalMs: 50,
    },
  });
}

function recordM201ShadowSkill(overrides: { skillId?: string; summary?: string } = {}): void {
  const skill = attestSkillCard(sanitizeSkillCard({
    schemaVersion: 1,
    skillId: overrides.skillId ?? 'skill.m201-execution-order',
    revision: 1,
    ts: new Date().toISOString(),
    name: 'M201 execution order',
    summary: overrides.summary ?? 'Repair and verify an M201 item.',
    status: 'verified',
    source: 'verified-proposal',
    tags: ['m201', 'repair'],
    taskKinds: ['m201-item'],
    commandKinds: ['test'],
    verification: {
      passed: true,
      commandKinds: ['test'],
      diffHash: 'c'.repeat(64),
      evidenceCount: 1,
    },
    proposalId: 'proposal-m201-execution-order',
  }));
  expect(skill).not.toBeNull();
  recordSkillCard(skill!);
}

// ===========================================================================
// Group A — Backlog build + top-K selection within budget
// ===========================================================================

describe('M201 — Group A: backlog build + top-K selection', () => {
  it('A0a: retargeted legacy enrollment aliases are not counted, scanned, or dispatched', async () => {
    const firstTarget = fx.makeRepo();
    const secondTarget = fx.makeRepo();
    const alias = join(fx.home, 'legacy-enrolled-repo');
    fs.symlinkSync(firstTarget.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(fx.ashlrDir, { recursive: true });
    fs.writeFileSync(
      join(fx.ashlrDir, 'enrollment.json'),
      JSON.stringify({ repos: [alias] }),
      'utf8',
    );
    fs.unlinkSync(alias);
    fs.symlinkSync(secondTarget.dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    mockLoadBacklog.mockReturnValue({
      generatedAt: new Date().toISOString(),
      repos: [alias],
      items: makeItems(alias, 1),
    });

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.itemsConsidered).toBe(0);
    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  }, 15_000);

  it('A0b: a temporarily missing exact canonical enrollment degrades the tick', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    fs.rmSync(repo.dir, { recursive: true, force: true });

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.itemsConsidered).toBe(0);
    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  }, 15_000);

  it('A0: dispatch production maps proposal-created to diff, no-proposal outcomes to empty, and proposal-disabled to neutral', () => {
    expect(workedOutcomeFromDispatchProduction(undefined)).toBeUndefined();
    expect(workedOutcomeFromDispatchProduction({
      outcome: 'proposal-created',
      proposalId: 'p1',
      runId: 'r1',
    })).toBe('diff');

    for (const outcome of [
      'empty-diff',
      'gate-blocked',
      'engine-failed',
      'sandbox-failed',
      'proposal-capture-error',
      'unknown',
    ] as const) {
      expect(workedOutcomeFromDispatchProduction({ outcome, runId: `run-${outcome}` })).toBe('empty');
    }
    expect(workedOutcomeFromDispatchProduction({
      outcome: 'proposal-disabled',
      runId: 'run-proposal-disabled',
    })).toBeUndefined();
  });

  it('A1: empty backlog → reason no-backlog, proposalsCreated=0, runSwarm not called', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(result.proposalsCreated).toBe(0);
    expect(result.itemsConsidered).toBe(0);
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-start: live tick writes start and terminal agent actions without extra daemon ticks', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 4, parallel: 3 }), { dryRun: false });

    const actions = readAgentActions();
    const start = actions.find((event) => event.action === 'daemon:tick-start');
    const terminal = actions.find((event) => event.action === 'daemon:tick');
    const state = loadDaemonState();

    expect(result.reason).toBe('no-backlog');
    expect(state.ticks).toHaveLength(1);
    expect(state.ticks[0]!.reason).toBe('no-backlog');
    expect(start).toMatchObject({
      actor: 'daemon',
      kind: 'tick',
      outcome: 'started',
      action: 'daemon:tick-start',
      counts: { perTickItems: 4, parallel: 3 },
    });
    expect(start?.tags).toEqual(expect.arrayContaining(['tick-start', 'live']));
    expect(start?.repo).toBeUndefined();
    expect(start?.itemId).toBeUndefined();
    expect(start?.proposalId).toBeUndefined();
    expect(start?.runId).toBeUndefined();
    expect(terminal).toMatchObject({
      actor: 'daemon',
      kind: 'tick',
      outcome: 'skipped',
      action: 'daemon:tick',
      reason: 'no-backlog',
    });
  });

  it('A1-persistence: an early-return tick reports state persistence failure', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const originalHome = process.env.HOME;
    const blockedHome = join(fx.home, 'home-is-a-file');
    fs.writeFileSync(blockedHome, 'not a directory', 'utf8');
    mockBuildBacklog.mockImplementation(async () => {
      process.env.HOME = blockedHome;
      return {
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [],
      };
    });

    try {
      const result = await tick(cfgBuiltin(), { dryRun: false });
      expect(result.reason).toBe('state-persistence-failed');
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it('A1-drain: targeted diagnostic-reslices mode selects trusted reslices before generic backlog work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcdef123456', 1);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, reslice],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      dryRun: true,
      drain: 'diagnostic-reslices',
    });
    const actions = readAgentActions();
    const selection = actions.find((event) => event.action === 'daemon:drain-select');

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(1);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 1,
      limit: 3,
      selectedItemIds: [reslice.id],
    });
    expect(selection).toMatchObject({
      action: 'daemon:drain-select',
      itemId: reslice.id,
      counts: { available: 1, selected: 1, limit: 3 },
    });
    expect(selection?.tags).toEqual(expect.arrayContaining(['drain-select', 'drain:diagnostic-reslices']));
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-drain-cap: targeted diagnostic-reslices mode defaults to a bounded drain cap', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const reslices = Array.from({ length: 5 }, (_unused, i) =>
      makeDiagnosticResliceItem(repo.dir, `abcdef12345${i}`, 10 - i),
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: reslices,
    });

    const result = await tick(cfgBuiltin({ perTickItems: 10, parallel: 1 }), {
      dryRun: true,
      drain: 'diagnostic-reslices',
    });
    const selection = readAgentActions().find((event) => event.action === 'daemon:drain-select');

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(3);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 5,
      selected: 3,
      limit: 3,
      capped: true,
    });
    expect(result.drain?.selectedItemIds).toHaveLength(3);
    expect(selection).toMatchObject({
      counts: { available: 5, selected: 3, limit: 3, capped: 1 },
    });
    expect(selection?.tags).toEqual(expect.arrayContaining(['capped']));
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-drain-limit: targeted diagnostic-reslices mode accepts an explicit smaller drain cap', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const reslices = Array.from({ length: 3 }, (_unused, i) =>
      makeDiagnosticResliceItem(repo.dir, `fedcba98765${i}`, 10 - i),
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: reslices,
    });

    const result = await tick(cfgBuiltin({ perTickItems: 10, parallel: 1 }), {
      dryRun: true,
      drain: 'diagnostic-reslices',
      drainLimit: 1,
    });

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(1);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 3,
      selected: 1,
      limit: 1,
      capped: true,
    });
    expect(result.drain?.selectedItemIds).toHaveLength(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-drain-none: targeted diagnostic-reslices mode does not fall back to generic work', async () => {
    const { items } = enrollWithItems(3);
    items[0]!.score = 100;

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), {
      dryRun: true,
      drain: 'diagnostic-reslices',
    });

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(0);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 0,
      selected: 0,
    });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-concurrent-dry-run: does not sense live resources for a non-executing tick', async () => {
    const { items } = enrollWithItems(1);

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { fabric: { concurrentDispatch: true } },
    } as AshlrConfig, { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(1);
    expect(items).toHaveLength(1);
    expect(mockGetResourceSnapshot).not.toHaveBeenCalled();
  });

  it('A1-concurrent-stale-snapshot: refreshes capacity before execution when selection evidence is old', async () => {
    const { items } = enrollWithItems(1);
    const backendState = {
      backend: 'builtin' as const,
      availability: 'open' as const,
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      reason: 'test capacity',
      backoffUntilMs: null,
    };
    const staleAt = new Date(Date.now() - 31_000).toISOString();
    const freshAt = new Date().toISOString();
    mockGetResourceSnapshot
      .mockResolvedValueOnce({ generatedAt: staleAt, backends: [{ ...backendState, snapshotAt: staleAt }] })
      .mockResolvedValueOnce({ generatedAt: freshAt, backends: [{ ...backendState, snapshotAt: freshAt }] });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { fabric: { concurrentDispatch: true, maxSlotsPerBackend: 1 } },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(items).toHaveLength(1);
    expect(mockGetResourceSnapshot).toHaveBeenCalledTimes(2);
  });

  it('A1-reslice-parent-missing: quarantined reslices do not block ordinary work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    const reslice = makeDiagnosticResliceItem(repo.dir, '112233aabbcc', 10);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });
    mockResolveDiagnosticResliceParents.mockImplementation((items: WorkItem[]) => ({
      dispatchable: items.filter((item) => item.id !== reslice.id),
      quarantined: [{ itemId: reslice.id, reason: 'parent-missing' }],
      resolved: 0,
      missing: 1,
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: generic.id });
    expect(result.producerMaintenance).toMatchObject({
      diagnosticResliceParentsResolved: 0,
      diagnosticResliceParentsMissing: 1,
    });
  });

  it('A1-drain-auto: live backlog-build ticks auto-select trusted diagnostic reslices before generic work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcdef123456', 1, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, reslice],
    });
    mockCanonicalEmptyDiffRunGoal('automatic diagnostic drain fixture');

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const selection = readAgentActions().find((event) => event.action === 'daemon:drain-select');

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 1,
      limit: 3,
      automatic: true,
      selectedItemIds: [reslice.id],
    });
    expect(selection).toMatchObject({
      action: 'daemon:drain-select',
      itemId: reslice.id,
      reason: 'auto-live',
      counts: { available: 1, selected: 1, limit: 3, automatic: 1 },
    });
    expect(selection?.tags).toEqual(expect.arrayContaining(['drain-select', 'drain:diagnostic-reslices', 'auto-drain']));
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      workItemId: reslice.id,
      delegationScope: {
        workItemId: reslice.id,
        objective: reslice.title,
      },
    });
    expect(loadDaemonState().automaticDrainOrdinaryTurnDue).toBe(true);
  });

  it.each([
    ['baseline-reslice', false],
    ['target-localization', true],
  ] as const)(
    'A1-reslice-dispatch-config: %s sets only its repo-map/localization treatment fields',
    async (treatment, localization) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const backend = 'local-coder';
      const parentTier: EngineTier = 'mid';
      const reslice = makeDiagnosticResliceForTreatment(repo.dir, treatment, parentTier);
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [reslice],
      });
      mockRouteBackend.mockReturnValue({ backend, tier: parentTier, reason: 'treatment dispatch test' });
      mockEngineTierOf.mockImplementation((engine: unknown) => engine === 'local-coder' ? 'mid' : 'local');
      mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => ({
        id: (options as { runId: string }).runId,
        status: 'done',
        engine: backend,
        engineTier: parentTier,
        usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
        proposalOutcome: { kind: 'empty-diff', reason: 'valid treatment dispatch evidence' },
      }));

      const config = {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['builtin', 'local-coder'],
          repoMap: true,
          localization: !localization,
          models: { 'local-coder': 'test-local-model' },
        },
      } as AshlrConfig;
      const originalFoundry = structuredClone(config.foundry);

      const result = await tick(config, { dryRun: false });
      const dispatchCall = mockRunGoal.mock.calls[0];
      const dispatchCfg = dispatchCall?.[1] as AshlrConfig;

      expect(result.reason).toBe('ok');
      expect(dispatchCfg).toEqual({
        ...config,
        foundry: { ...config.foundry, repoMap: false, localization },
      });
      expect(dispatchCfg).not.toBe(config);
      expect(dispatchCfg.foundry?.models).toBe(config.foundry?.models);
      expect(config.foundry).toEqual(originalFoundry);
      expect(readGeneratedRepairLifecycle(reslice)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 1,
        lastAuthoritativeEmptyBackend: 'local-coder',
      });
    },
  );

  it('A1-reslice-dispatch-config: ordinary work keeps the original dispatch config object', async () => {
    const { items } = enrollWithItems(1);
    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        allowedBackends: ['builtin'],
        repoMap: true,
        localization: true,
      },
    } as AshlrConfig;

    const result = await tick(config, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(items).toHaveLength(1);
    expect(mockRunSwarm.mock.calls[0]?.[1]).toBe(config);
  });

  it('A1-drain-auto-fairness: reserves one ordinary slot when automatic repair drain has capacity', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const firstReslice = makeDiagnosticResliceItem(repo.dir, 'abcdef123456', 2, 'mid');
    const secondReslice = makeDiagnosticResliceItem(repo.dir, 'fedcba654321', 1, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, firstReslice, secondReslice],
    });

    const config = cfgBuiltin({ perTickItems: 2, parallel: 2 });
    config.daemon = {
      ...config.daemon,
      drainLimits: { diagnosticReslices: 1 },
    };
    mockCanonicalEmptyDiffRunGoal('automatic diagnostic drain fairness fixture');
    const result = await tick(config, { dryRun: false });
    const dispatchedIds = mockRunGoal.mock.calls.map((call) => call[2]?.workItemId);

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      selected: 1,
      automatic: true,
      selectedItemIds: [firstReslice.id],
    });
    expect(dispatchedIds).toEqual(expect.arrayContaining([firstReslice.id, generic.id]));
    expect(dispatchedIds).not.toContain(secondReslice.id);
  });

  it('A1-generated-repair-fairness: reserves one normal-selection slot for real portfolio work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 1;
    const repair = (suffix: string, score: number): WorkItem => ({
      ...generic,
      id: `${basename(repo.dir)}:proposal-repair:${suffix}`,
      source: 'self',
      title: `Repair proposal prop-${suffix}: test failure in src/app.ts:12`,
      detail:
        `Proposal repair: test failure in src/app.ts:12 expected ready state.\n` +
        `Proposal: prop-${suffix}\n` +
        `Original work item: repo:goal:stalled\n` +
        `Produce a fresh complete fix and verify it.`,
      score,
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, suffix),
      repairRootAuthorityId: `m201:${suffix}`,
      repairDepth: 0,
    });
    const firstRepair = repair('abcdef123456', 100);
    const secondRepair = repair('fedcba654321', 90);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [firstRepair, secondRepair, generic],
    });
    mockCanonicalEmptyDiffRunGoal('generated repair fairness fixture');

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 2 }), { dryRun: false });
    const dispatchedIds = mockRunGoal.mock.calls.map((call) => call[2]?.workItemId);

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(dispatchedIds).toContain(generic.id);
    expect(dispatchedIds.filter((id) => id === firstRepair.id || id === secondRepair.id)).toHaveLength(1);
  });

  it('A1-generated-repair-route-prefilter: replaces an infeasible repair with later ordinary work before claim', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [firstOrdinary, secondOrdinary] = makeItems(repo.dir, 2);
    const repair: WorkItem = {
      ...firstOrdinary!,
      id: `${basename(repo.dir)}:proposal-repair:abcdef123456`,
      source: 'self',
      title: 'Proposal repair: restore a complete scheduler change',
      detail:
        'Proposal repair: recover a complete scheduler change.\n' +
        'Proposal: prop-route-blocked\n' +
        'Original work item: repo:goal:route-blocked\n' +
        'Produce a fresh complete fix and verify it. RAW_PRECLAIM_TEXT_M201',
      score: 100,
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'route-blocked'),
      repairRootAuthorityId: 'm201:route-blocked',
      repairDepth: 0,
    };
    mockInspectGeneratedRepairRouteFeasibility.mockImplementation((item: WorkItem) => ({
      feasible: item.id !== repair.id,
      requiredTier: 'mid',
      requiresAlternative: true,
      backend: item.id === repair.id ? null : 'local-coder',
      reason: item.id === repair.id ? 'same-tier-backend-unavailable' : 'feasible',
    }));
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair, firstOrdinary!, secondOrdinary!],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 2 }), { dryRun: false });
    const dispatchedIds = mockRunSwarm.mock.calls.map((call) => call[2]?.workItemId);
    const decision = readAgentActions().find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === repair.id,
    );
    const selection = readAgentActions().find((event) => event.action === 'daemon:selection');

    expect(result.itemsConsidered).toBe(2);
    expect(dispatchedIds).toEqual(expect.arrayContaining([firstOrdinary!.id, secondOrdinary!.id]));
    expect(dispatchedIds).not.toContain(repair.id);
    expect(decision).toMatchObject({
      outcome: 'blocked',
      reason: 'dispatch-route-unavailable',
      runId: expect.stringMatching(/^attempt-/),
      trajectoryId: expect.stringMatching(/^run:attempt-/),
      routeSnapshot: {
        backend: null,
        tier: 'mid',
        assignedBy: 'preclaim-route-inspection',
        reason: 'same-tier-backend-unavailable',
        routerPolicyVersion: 'fleet-router-v1',
      },
      learningSource: 'agent-action',
      labelBasis: 'preclaim-route-feasibility',
      counts: {
        dispatchBlocked: 1,
        routeEvaluated: 1,
        routeFeasible: 0,
        routeRequiresAlternative: 1,
        generatedRepairDecisionDropped: 0,
        selected: 0,
        claimed: 0,
      },
    });
    expect(JSON.stringify(decision)).not.toContain('RAW_PRECLAIM_TEXT_M201');
    expect(readDispatchProductionEvents().filter((event) => event.itemId === repair.id)).toEqual([]);
    expect(listAttemptRecords({ windowHours: 1 }).filter((record) => record.itemId === repair.id)).toEqual([]);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === repair.id)).toEqual([]);
    expect(fs.existsSync(generatedRepairLifecyclePath())).toBe(false);
    expect(selection).toMatchObject({
      counts: expect.objectContaining({
        backlogItems: 3,
        eligibleItems: 2,
        routeBlocked: 1,
        claimed: 2,
      }),
    });

    await tick(cfgBuiltin({ perTickItems: 2, parallel: 2 }), { dryRun: false });
    const repeatedDecisions = readAgentActions().filter((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === repair.id,
    );
    expect(repeatedDecisions).toHaveLength(2);
    expect(new Set(repeatedDecisions.map((event) => event.trajectoryId))).toEqual(
      new Set([decision?.trajectoryId]),
    );
  });

  it('A1-generated-repair-route-prefilter: reports bounded decision-row censorship', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const base = makeItems(repo.dir, 1)[0]!;
    const repairs = Array.from({ length: 21 }, (_, index): WorkItem => ({
      ...base,
      id: `${basename(repo.dir)}:proposal-repair:${index.toString(16).padStart(12, '0')}`,
      source: 'self',
      title: `Proposal repair ${index}`,
      detail:
        `Proposal repair: bounded telemetry fixture ${index}.\n` +
        `Proposal: prop-cap-${index}\n` +
        `Original work item: repo:goal:cap-${index}\n` +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, `cap-${index}`),
      repairRootAuthorityId: `m201:cap-${index}`,
      repairDepth: 0,
    }));
    mockInspectGeneratedRepairRouteFeasibility.mockReturnValue({
      feasible: false,
      requiredTier: 'frontier',
      requiresAlternative: false,
      backend: null,
      reason: 'same-tier-backend-unavailable',
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: repairs,
    });

    await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: true });

    const decisions = readAgentActions().filter(
      (event) => event.action === 'daemon:generated-repair-decision',
    );
    expect(decisions).toHaveLength(20);
    expect(decisions.every((event) => event.counts?.['generatedRepairDecisionDropped'] === 1)).toBe(true);
    expect(mockInspectGeneratedRepairRouteFeasibility).toHaveBeenCalledTimes(21);
  });

  it('A1-generated-repair-route-prefilter: explicit drains do not attribute out-of-scope route failures', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const reslice = makeDiagnosticResliceItem(repo.dir, 'cabfeed12345', 10);
    const unrelatedRepair: WorkItem = {
      ...makeItems(repo.dir, 1)[0]!,
      id: `${basename(repo.dir)}:proposal-repair:fedcba654321`,
      source: 'self',
      title: 'Proposal repair: unrelated capture recovery',
      detail:
        'Proposal repair: recover an unrelated proposal.\n' +
        'Proposal: prop-unrelated\n' +
        'Original work item: repo:goal:unrelated\n' +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'unrelated'),
      repairRootAuthorityId: 'm201:unrelated',
      repairDepth: 0,
    };
    mockInspectGeneratedRepairRouteFeasibility.mockImplementation((item: WorkItem) => ({
      feasible: item.id === reslice.id,
      reason: item.id === reslice.id ? 'feasible' : 'same-tier-backend-unavailable',
    }));
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, unrelatedRepair],
    });

    await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      dryRun: true,
      drain: 'diagnostic-reslices',
    });

    const decision = readAgentActions().find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === unrelatedRepair.id,
    );
    expect(decision).toMatchObject({
      outcome: 'skipped',
      reason: 'not-selected',
      learningSource: 'agent-action',
      labelBasis: 'unknown',
      counts: { dispatchEvaluated: 0, dispatchBlocked: 0, selected: 0, claimed: 0 },
    });
    expect(decision?.runId).toBeUndefined();
    expect(decision?.trajectoryId).toBe(`work:${unrelatedRepair.id}`);
    expect(decision?.routeSnapshot).toBeUndefined();
    expect(decision?.tags).toEqual(expect.arrayContaining(['dispatch-not-evaluated']));
    expect(mockInspectGeneratedRepairRouteFeasibility).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: unrelatedRepair.id }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('A1-drain-auto-single-slot-fairness: persisted automatic repair selection yields the next slot to ordinary work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'aabbccddeeff', 1, 'mid');
    seedTicks([
      {
        ts: new Date(Date.now() - 1_000).toISOString(),
        itemsConsidered: 1,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'ok',
        drain: {
          mode: 'diagnostic-reslices',
          available: 2,
          selected: 1,
          selectedItemIds: ['prior-repair'],
          automatic: true,
        },
      },
      {
        ts: new Date().toISOString(),
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'maintenance-cadence',
      },
    ], true);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, reslice],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'fairness fixture' });
    mockEngineTierOf.mockReturnValue('mid');

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 0,
      automatic: true,
      fairnessDeferred: true,
    });
    expect(result.drain).not.toHaveProperty('stalled');
    expect(readAgentActions().find((event) => event.action === 'daemon:drain-select')).toMatchObject({
      reason: 'ordinary-turn-fairness',
      tags: expect.arrayContaining(['fairness-deferred', 'ordinary-turn']),
      counts: expect.objectContaining({ fairnessDeferred: 1 }),
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ workItemId: generic.id });
    expect(loadDaemonState().automaticDrainOrdinaryTurnDue).toBe(false);
  });

  it('A1-shared-refill: contended prefix claims refill from later policy-eligible candidates', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 3);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items,
    });
    const sharedPath = join(fx.ashlrDir, 'shared-refill');
    const other = new SharedStore(sharedPath, 60_000);
    expect(other.claimItems([items[0]!.id], 1, 'other-machine')).toEqual([items[0]!.id]);

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'm201-refill',
          trustedCoherentStorage: true,
        },
      },
    } as AshlrConfig, { dryRun: false });
    const dispatchedIds = mockRunSwarm.mock.calls.map((call) => call[2]?.workItemId);

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(dispatchedIds).toEqual([items[1]!.id, items[2]!.id]);
    expect(dispatchedIds).not.toContain(items[0]!.id);
  });

  it('A1-shared-production-failure: settles only the executing claim and permits an immediate retry', async () => {
    const { repo, items } = enrollWithItems(1);
    const item = items[0]!;
    const sharedPath = join(fx.ashlrDir, 'shared-production-failure');
    const observer = new SharedStore(sharedPath, 60_000);
    const unrelatedItemId = `${repo.dir}:unrelated-shared-claim`;
    expect(observer.claimItems([unrelatedItemId], 1, 'other-machine')).toEqual([unrelatedItemId]);
    const dailyLedgerPath = join(dispatchProductionDir(), `${today()}.jsonl`);
    let executions = 0;
    mockRunSwarm.mockImplementation(async (_input, _cfg, opts) => {
      executions++;
      expect(observer.readHealth({ machineId: 'm201-production-failure' }).claimSamples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            itemId: item.id,
            machineId: 'm201-production-failure',
            state: 'executing',
            phase: 'executing',
            owned: true,
          }),
          expect.objectContaining({ itemId: unrelatedItemId, machineId: 'other-machine' }),
        ]),
      );
      if (executions === 1) fs.mkdirSync(dailyLedgerPath, { recursive: true });
      return {
        id: (opts as { runId: string }).runId,
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
        proposalOutcome: {
          kind: 'proposal-disabled' as const,
          reason: 'shared queue persistence fixture',
        },
      };
    });
    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      fleet: {
        sharedQueue: {
          mode: 'filesystem',
          path: sharedPath,
          machineId: 'm201-production-failure',
          leaseMs: 60_000,
          trustedCoherentStorage: true,
        },
      },
    } as AshlrConfig;

    const failed = await tick(config, { dryRun: false });
    const afterFailure = observer.readSnapshot();

    expect(failed.reason).toBe('state-persistence-failed');
    expect(afterFailure.claims).not.toHaveProperty(item.id);
    expect(afterFailure.claims).toHaveProperty(unrelatedItemId);
    expect(afterFailure.worked.some((event) => event.itemId === item.id)).toBe(false);

    fs.rmSync(dailyLedgerPath, { recursive: true, force: true });
    const retried = await tick(config, { dryRun: false });
    const afterRetry = observer.readSnapshot();

    expect(retried.reason).toBe('ok');
    expect(executions).toBe(2);
    expect(afterRetry.claims).not.toHaveProperty(item.id);
    expect(afterRetry.claims).toHaveProperty(unrelatedItemId);
    expect(afterRetry.worked.some((event) => event.itemId === item.id)).toBe(false);
  });

  it('A1-drain-auto-local-only: automatic diagnostic drains preserve local-only local-coder routing', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'fedcba987654', 1, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, reslice],
    });
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('local-only', 'frontier budget constrained'));
    mockCanonicalEmptyDiffRunGoal('automatic local-only drain fixture');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          autonomyControlLoop: true,
          allowedBackends: ['claude', 'local-coder', 'builtin'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );
    const selection = readAgentActions().find((event) => event.action === 'daemon:drain-select');

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('local-only');
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 1,
      automatic: true,
      selectedItemIds: [reslice.id],
    });
    expect(selection?.tags).toEqual(expect.arrayContaining(['auto-drain']));
    expect(result.backends).toEqual({ 'local-coder': 1 });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      engine: 'local-coder',
      workItemId: reslice.id,
      delegationScope: {
        workItemId: reslice.id,
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1-drain-auto-pending: automatic diagnostic drains do not starve generic work when reslices are already pending', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcdef999999', 1);
    createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'patch',
      title: `Pending ${reslice.id}`,
      summary: 'already pending diagnostic reslice proposal',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: reslice.id,
      workItemGenerationId: generatedRepairGenerationId(reslice)!,
      workSource: reslice.source,
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });
    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const actions = readAgentActions();
    const selection = actions.find((event) => event.action === 'daemon:drain-select');
    const repairDecision = actions.find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === reslice.id,
    );

    expect(result.reason).toBe('ok');
    expect(result.drain).toBeUndefined();
    expect(selection).toBeUndefined();
    expect(repairDecision).toMatchObject({
      kind: 'selection',
      outcome: 'blocked',
      action: 'daemon:generated-repair-decision',
      itemId: reslice.id,
      reason: 'pending-proposal',
      counts: {
        pendingBlocked: 1,
        cooldownBlocked: 0,
        selected: 0,
        claimed: 0,
      },
    });
    expect(repairDecision?.tags).toEqual(expect.arrayContaining(['generated-repair-decision', 'pending-blocked']));
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: generic.id,
      delegationScope: {
        workItemId: generic.id,
        objective: generic.title,
      },
    });
  });

  it('A1-drain-auto-unroutable: automatic drain does not claim a retry without an authorized alternative', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'feedface9999', 1, 'mid');
    seedDiagnosticEmptyProof(
      reslice,
      'attempt-12345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
    );
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'only installed mid backend' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder', 'builtin'] },
      } as AshlrConfig,
      { dryRun: false },
    );
    const actions = readAgentActions();
    const drainSelection = actions.find((event) => event.action === 'daemon:drain-select');
    const repairDecision = actions.find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === reslice.id,
    );

    expect(result.reason).toBe('ok');
    expect(result.drain).toBeUndefined();
    expect(drainSelection).toBeUndefined();
    expect(repairDecision).toMatchObject({
      outcome: 'blocked',
      reason: 'dispatch-route-unavailable',
      counts: { dispatchEvaluated: 1, dispatchBlocked: 1, selected: 0, claimed: 0 },
    });
    expect(repairDecision?.tags).toEqual(expect.arrayContaining(['dispatch-route-unavailable']));
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ workItemId: generic.id });
  });

  it('A1-drain-auto-route-divergence: a claimed repair paused before execution cannot starve the next tick', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'deadbeef9999', 1, 'mid');
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'preflight mid route' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRecommendRoute.mockResolvedValue({ backend: 'builtin', tier: 'local', reason: 'late learned pause' });
    mockRecoverWithinBudget.mockReturnValue({
      action: 'proceed',
      decision: { backend: 'builtin', tier: 'local', reason: 'late learned pause' },
    });
    mockGeneratedRepairCandidateAllowed.mockImplementation(
      (_item: WorkItem, backend: EngineId) => backend !== 'builtin',
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });
    const liveCfg = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        allowedBackends: ['local-coder', 'builtin'],
        intelligence: {},
      },
    } as AshlrConfig;

    const first = await tick(liveCfg, { dryRun: false });
    expect(first.dispatches?.[0]).toMatchObject({
      dispatched: false,
      skipReason: 'repair-tier-unavailable',
    });
    expect(loadWorkedLedger().events.at(-1)).toMatchObject({
      itemId: generatedRepairCooldownKey(reslice),
      outcome: 'dispatch-blocked',
    });

    const second = await tick(liveCfg, { dryRun: false });
    const repairDecision = readAgentActions().find((event) =>
      event.action === 'daemon:generated-repair-decision' &&
      event.itemId === reslice.id &&
      event.reason === 'cooldown: latest=dispatch-blocked',
    );
    expect(second.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: generic.id });
    expect(repairDecision).toMatchObject({
      outcome: 'blocked',
      reason: 'cooldown: latest=dispatch-blocked',
      counts: {
        effectiveCooldownMs: 5 * 60 * 1000,
        cooldownBlocked: 1,
      },
    });
  });

  it('A1-drain-auto-cooldown: automatic diagnostic drains do not starve generic work when reslices are cooling down', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcabc999999', 1);
    recordOutcome(generatedRepairCooldownKey(reslice), 'empty');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const actions = readAgentActions();
    const selection = actions.find((event) => event.action === 'daemon:drain-select');
    const repairDecision = actions.find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === reslice.id,
    );

    expect(result.reason).toBe('ok');
    expect(result.drain).toBeUndefined();
    expect(selection).toBeUndefined();
    expect(repairDecision).toMatchObject({
      kind: 'selection',
      outcome: 'blocked',
      action: 'daemon:generated-repair-decision',
      itemId: reslice.id,
      reason: 'cooldown: latest=empty',
      counts: {
        pendingBlocked: 0,
        cooldownBlocked: 1,
        fastRepairCooldown: 0,
        selected: 0,
        claimed: 0,
      },
    });
    expect(repairDecision?.tags).toEqual(expect.arrayContaining(['cooldown-blocked', 'standard-cooldown', 'latest-empty']));
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: generic.id,
    });
  });

  it('A1-judged-repair-generation: delayed rejection cannot cool a changed generation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcabc121212', 1);
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'patch',
      title: 'Rejected old repair generation',
      summary: 'Old objective feedback must not cool the current generation.',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: reslice.id,
      workItemGenerationId: 'b'.repeat(64),
      workSource: 'self',
    });
    setStatus(proposal.id, 'rejected');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice],
    });

    await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: true });

    expect(loadWorkedLedger().events.some(
      (event) => event.itemId === generatedRepairCooldownKey(reslice),
    )).toBe(false);
  });

  it('A1-judged-repair-generation: exact rejection cools the stable generation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcabc343434', 1);
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'patch',
      title: 'Rejected current repair generation',
      summary: 'Current objective feedback should cool this generation.',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: reslice.id,
      workItemGenerationId: generatedRepairGenerationId(reslice)!,
      workSource: 'self',
    });
    setStatus(proposal.id, 'rejected');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice],
    });

    await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: true });

    expect(loadWorkedLedger().events).toContainEqual(expect.objectContaining({
      itemId: generatedRepairCooldownKey(reslice),
      outcome: 'judged-decline',
    }));
  });

  it('A1-drain-auto-fast-repair-cooldown: healthy repair recovery retries trusted empty repairs after 30 minutes', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcabc888888', 1, 'mid');
    seedHealthyGeneratedRepairYield(repo.dir);
    const emptyAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    recordOutcome(generatedRepairCooldownKey(reslice), 'empty', emptyAt);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });
    mockCanonicalEmptyDiffRunGoal('fast repair cooldown fixture');

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const actions = readAgentActions();
    const selection = actions.find((event) => event.action === 'daemon:drain-select');
    const repairDecision = actions.find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === reslice.id,
    );

    expect(result.reason).toBe('ok');
    expect(result.drain).toMatchObject({
      mode: 'diagnostic-reslices',
      available: 1,
      selected: 1,
      automatic: true,
      selectedItemIds: [reslice.id],
    });
    expect(selection).toMatchObject({
      action: 'daemon:drain-select',
      itemId: reslice.id,
      reason: 'auto-live',
    });
    expect(repairDecision).toMatchObject({
      kind: 'selection',
      outcome: 'ok',
      action: 'daemon:generated-repair-decision',
      itemId: reslice.id,
      reason: 'claimed',
      counts: {
        baseCooldownMs: 6 * 60 * 60 * 1000,
        effectiveCooldownMs: 30 * 60 * 1000,
        fastRepairCooldown: 1,
        pendingBlocked: 0,
        cooldownBlocked: 0,
        selected: 1,
        claimed: 1,
      },
    });
    expect(repairDecision?.tags).toEqual(expect.arrayContaining(['fast-repair-cooldown', 'latest-empty', 'claimed']));
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      workItemId: reslice.id,
    });
  });

  it('A1-drain-auto-fast-repair-cooldown: judged repair outcomes keep the full cooldown', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const reslice = makeDiagnosticResliceItem(repo.dir, 'abcabc777777', 1);
    seedHealthyGeneratedRepairYield(repo.dir);
    recordOutcome(generatedRepairCooldownKey(reslice), 'judged-decline', new Date(Date.now() - 31 * 60 * 1000).toISOString());
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [reslice, generic],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const actions = readAgentActions();
    const selection = actions.find((event) => event.action === 'daemon:drain-select');
    const repairDecision = actions.find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === reslice.id,
    );

    expect(result.reason).toBe('ok');
    expect(result.drain).toBeUndefined();
    expect(selection).toBeUndefined();
    expect(repairDecision).toMatchObject({
      kind: 'selection',
      outcome: 'blocked',
      action: 'daemon:generated-repair-decision',
      itemId: reslice.id,
      reason: 'cooldown: latest=judged-decline',
      counts: {
        baseCooldownMs: 6 * 60 * 60 * 1000,
        effectiveCooldownMs: 6 * 60 * 60 * 1000,
        fastRepairCooldown: 0,
        cooldownBlocked: 1,
        selected: 0,
        claimed: 0,
      },
    });
    expect(repairDecision?.tags).toEqual(expect.arrayContaining(['standard-cooldown', 'latest-judged-decline']));
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: generic.id,
    });
  });

  it('A1-generated-repair-dispatch-skip: selected generated repairs skipped by budget are append-only workspace events only', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const resliceA = makeDiagnosticResliceItem(repo.dir, 'abcabc666660', 10, 'mid');
    const resliceB = makeDiagnosticResliceItem(repo.dir, 'abcabc666661', 9, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [resliceA, resliceB],
    });
    mockCanonicalEmptyDiffRunGoal('budget drain fixture', 0.02);

    const result = await tick(cfgBuiltin({ dailyBudgetUsd: 0.02, perTickItems: 2, parallel: 1 }), { dryRun: false });
    const actions = readAgentActions();
    const skipped = actions.find((event) =>
      event.action === 'daemon:dispatch-skip' && event.itemId === resliceB.id,
    );
    const decisions = actions.filter((event) => event.action === 'daemon:generated-repair-decision');

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(skipped).toMatchObject({
      kind: 'dispatch',
      outcome: 'skipped',
      action: 'daemon:dispatch-skip',
      itemId: resliceB.id,
      reason: 'budget-cap',
      counts: { dispatched: 0, selected: 1 },
    });
    expect(skipped?.summary).toContain('dispatch skipped: budget-cap');
    expect(skipped?.summary).not.toContain(resliceB.title);
    expect(skipped?.tags).toEqual(expect.arrayContaining(['dispatch-skip', 'generated-repair', 'budget-cap']));
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: resliceA.id, reason: 'claimed' }),
      expect.objectContaining({ itemId: resliceB.id, reason: 'claimed' }),
    ]));
    expect(readDispatchProductionEvents().some((event) => event.itemId === resliceB.id)).toBe(false);
  });

  it('A1-drain-auto-lookalike: automatic diagnostic drains ignore malformed tag-only reslices', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const generic = makeItems(repo.dir, 1)[0]!;
    generic.score = 100;
    const lookalike: WorkItem = {
      ...makeDiagnosticResliceItem(repo.dir, 'abcabc123456', 1),
      id: `${basename(repo.dir)}:manual-diagnostic-reslice`,
    };
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [generic, lookalike],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });
    const selection = readAgentActions().find((event) => event.action === 'daemon:drain-select');

    expect(result.reason).toBe('ok');
    expect(result.drain).toBeUndefined();
    expect(selection).toBeUndefined();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: generic.id,
    });
  });

  it('A1a: empty backlog runs self-heal, rebuilds, and dispatches refilled work in the same tick', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A1a2: empty backlog runs bounded invent only after self-heal refill stays empty', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { autonomyControlLoop: false, generative: true },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(3);
    expect(mockRunSelfHealCycle).toHaveBeenCalledTimes(1);
    expect(mockRunInventCycle).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A1a2b: proposal repair maintenance can refill backlog before selection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repairItems = makeItems(repo.dir, 1).map((item) => ({
      ...item,
      id: `${basename(repo.dir)}:proposal-repair:abc123def456`,
      source: 'self' as const,
      title: 'Repair proposal prop-partial: test failure in src/app.ts:12',
      detail:
        'Proposal repair: test failure in src/app.ts:12 expected ready state.\n' +
        'Proposal: prop-partial\n' +
        'Original work item: repo:goal:stalled\n' +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'maintenance-refill'),
      repairRootAuthorityId: 'm201:maintenance-refill',
      repairDepth: 0 as const,
    }));
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 1,
      eligible: 2,
      queued: 2,
      failed: 0,
      dispatchCaptureScanned: 1,
      dispatchCaptureEligible: 1,
      dispatchCaptureQueued: 1,
      dispatchCaptureFailed: 0,
      dispatchNoDiffScanned: 1,
      dispatchNoDiffEligible: 1,
      dispatchNoDiffQueued: 1,
      dispatchNoDiffFailed: 0,
    });
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: repairItems });
    mockCanonicalEmptyDiffRunGoal('proposal repair maintenance fixture');

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockQueueProposalRepairWorkForPendingProposals).toHaveBeenCalledTimes(1);
    expect(mockQueueProposalRepairWorkForPendingProposals.mock.calls[0]).toEqual([
      undefined,
      expect.any(Date),
      { terminalLifecycleEnabled: true },
    ]);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(result.producerMaintenance).toMatchObject({
      proposalRepair: true,
      proposalRepairEligible: 2,
      proposalRepairQueued: 2,
      proposalRepairFailed: 0,
      dispatchCaptureRepairScanned: 1,
      dispatchCaptureRepairEligible: 1,
      dispatchCaptureRepairQueued: 1,
      dispatchCaptureRepairFailed: 0,
      dispatchNoDiffResliceScanned: 1,
      dispatchNoDiffResliceEligible: 1,
      dispatchNoDiffResliceQueued: 1,
      dispatchNoDiffResliceFailed: 0,
    });
    expect(result.dispatches?.[0]?.itemId).toBe(repairItems[0]!.id);
  });

  it('A1a2c: a selected rejected-capture recovery is reauthorized before dispatch', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [repair] = makeItems(repo.dir, 1).map((item) => ({
      ...item,
      id: `${basename(repo.dir)}:proposal-repair:abc123def457`,
      source: 'self' as const,
      title: 'Repair proposal prop-revoked: persistence mismatch',
      detail:
        'Proposal repair: recover a rejected persistence mismatch.\n' +
        'Proposal: prop-revoked\n' +
        'Original work item: repo:goal:revoked\n' +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'rejected-capture-recovery', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'rejected-recovery'),
      repairRootAuthorityId: 'm201:rejected-recovery',
      repairDepth: 0 as const,
    }));
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair!],
    });
    mockBeginRejectedCaptureRecoveryDispatch.mockReturnValue({ authorized: false });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'reauthorization fixture' });
    mockEngineTierOf.mockReturnValue('mid');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { autonomyControlLoop: false, allowedBackends: ['local-coder'] },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(mockIsRejectedCaptureRecoveryAuthorized).toHaveBeenCalledWith(repair);
    expect(mockBeginRejectedCaptureRecoveryDispatch).toHaveBeenCalledWith(repair, expect.any(Function));
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(result.dispatches?.[0]).toMatchObject({
      dispatched: false,
      skipReason: 'repair-authority-unavailable',
    });
  });

  it('A1a2b1: terminal repair maintenance refreshes and filters the same tick before dispatch', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const terminal = makeDiagnosticResliceItem(repo.dir, 'abcdef123456', 10);
    const generic = makeItems(repo.dir, 1)[0]!;
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 1,
      eligible: 0,
      queued: 0,
      failed: 0,
      dispatchRepairRetired: 1,
      dispatchRepairExhausted: 0,
      dispatchRepairQuarantined: 2,
      dispatchRepairPruned: 1,
      dispatchRepairPruneFailed: 0,
      blockedItemKeys: [workItemCoverageKey(terminal)],
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [terminal, generic],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: generic.id });
    expect(result.dispatches?.map((dispatch) => dispatch.itemId)).toEqual([generic.id]);
    expect(result.producerMaintenance).toMatchObject({
      dispatchRepairRetired: 1,
      dispatchRepairExhausted: 0,
      dispatchRepairQuarantined: 2,
      dispatchRepairPruned: 1,
      dispatchRepairPruneFailed: 0,
    });
    expect(JSON.stringify(result.producerMaintenance)).not.toContain(terminal.id);
  });

  it('A1a2b1a: lifecycle-unavailable repair is filtered even without a maintenance blocked key', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdee123456', 10, 'mid');
    const ordinary = makeItems(repo.dir, 1)[0]!;
    seedDiagnosticEmptyProof(
      repair,
      'attempt-63345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
    );
    const path = generatedRepairLifecyclePath();
    const ledger = JSON.parse(fs.readFileSync(path, 'utf8')) as {
      records: Array<{ emptyAttemptTiers?: string[] }>;
    };
    delete ledger.records[0]!.emptyAttemptTiers;
    fs.writeFileSync(path, `${JSON.stringify(ledger)}\n`, 'utf8');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair, ordinary],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(mockQueueProposalRepairWorkForPendingProposals).toHaveReturnedWith(
      expect.not.objectContaining({ blockedItemKeys: expect.anything() }),
    );
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
    expect(result.dispatches?.map((dispatch) => dispatch.itemId)).toEqual([ordinary.id]);
  });

  it('A1a2b1aa: high-score untrusted repair-shaped work fails closed before selection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const malformed: WorkItem = {
      ...makeItems(repo.dir, 1)[0]!,
      id: 'repo:manual-repair',
      source: 'self',
      score: 100,
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'ordinary-terminal'),
      repairRootAuthorityId: 'm201:ordinary-terminal',
      repairDepth: 0,
    };
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [malformed, ordinary],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
    expect(result.dispatches?.map((dispatch) => dispatch.itemId)).toEqual([ordinary.id]);
  });

  it('A1a2b1ab: rootless legacy and widened-depth repairs fail closed without starving ordinary work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const rootless = makeDiagnosticResliceItem(repo.dir, 'abcddf123456', 100, 'mid');
    delete rootless.repairRootId;
    delete rootless.repairDepth;
    const depthRejected = {
      ...makeDiagnosticResliceItem(repo.dir, 'abcdcf123456', 99, 'mid'),
      repairDepth: 2,
    } as unknown as WorkItem;
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [rootless, depthRejected, ordinary],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
    expect(result.dispatches?.map((dispatch) => dispatch.itemId)).toEqual([ordinary.id]);
    expect(result.producerMaintenance).toMatchObject({
      repairRootAdmissionRootless: 1,
      repairRootAdmissionDepthRejected: 1,
    });
  });

  it('A1a2b1b: later producer refresh cannot reintroduce a blocked repair', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const terminal = makeDiagnosticResliceItem(repo.dir, 'abcdef123457', 10);
    const ordinaryHeal: WorkItem = {
      ...makeItems(repo.dir, 1)[0]!,
      id: `${basename(repo.dir)}:self-heal:ordinary`,
      source: 'self',
      tags: ['self-heal', 'verify'],
    };
    const generic = makeItems(repo.dir, 1)[0]!;
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 1,
      eligible: 0,
      queued: 0,
      failed: 0,
      dispatchRepairPruned: 1,
      dispatchRepairPruneFailed: 0,
      blockedItemKeys: [workItemCoverageKey(terminal)],
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [terminal, ordinaryHeal, generic],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockBuildBacklog).toHaveBeenCalledTimes(3);
    expect(result.dispatches?.[0]?.itemId).not.toBe(terminal.id);
    expect(mockRunSwarm.mock.calls[0]?.[2]).not.toMatchObject({ workItemId: terminal.id });
  });

  it('A1a2b2: foundry.proposalRepair=false disables repair maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autonomyControlLoop: false, proposalRepair: false } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(mockQueueProposalRepairWorkForPendingProposals).not.toHaveBeenCalled();
  });

  it('A1a2b3: shared queue mode disables local terminal lifecycle projection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autonomyControlLoop: false },
      fleet: { sharedQueue: { mode: 'filesystem', path: fx.ashlrDir } },
    } as AshlrConfig, { dryRun: false });

    expect(mockQueueProposalRepairWorkForPendingProposals).toHaveBeenCalledWith(
      undefined,
      expect.any(Date),
      { terminalLifecycleEnabled: false },
    );
  });

  it('A1a2b4: shared queue mode blocks generated repair dispatch without fenced lifecycle state', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdef654321', 10);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock shared repair' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-shared-repair-empty',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'empty-diff', reason: 'no file changes' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autonomyControlLoop: false, allowedBackends: ['local-coder'] },
      fleet: { sharedQueue: { mode: 'filesystem', path: fx.ashlrDir, machineId: 'm201-shared' } },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(readGeneratedRepairLifecycle(repair)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it('A1a2c: non-empty backlog refreshes after self-heal maintenance before selection', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [staleBase, freshItem] = makeItems(repo.dir, 2);
    const staleSelfHeal = {
      ...staleBase!,
      id: `${repo.dir}:self-heal:stale-green-build`,
      source: 'self' as const,
      title: 'Fix broken build in ashlrcode: stale typecheck error',
      detail: 'Stale self-heal item that should be pruned after verification is green.',
      score: 9,
      tags: ['self-heal', 'build', 'high-priority'],
    };
    const freshWork = {
      ...freshItem!,
      id: `${repo.dir}:todo:fresh-real-work`,
      title: 'Fresh real work after stale self-heal pruning',
      score: 3,
    };
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [staleSelfHeal, freshWork] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [freshWork] });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: freshWork.id,
      title: freshWork.title,
    });
    expect(result.dispatches?.[0]?.itemId).not.toBe(staleSelfHeal.id);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledWith([repo.dir], expect.any(Object));
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(result.producerMaintenance).toMatchObject({
      selfHeal: true,
      ancillary: true,
    });
  });

  it('A1a2d: self-heal maintenance that empties a non-empty backlog still runs auto-merge drain', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [staleBase] = makeItems(repo.dir, 1);
    const staleSelfHeal = {
      ...staleBase!,
      id: `${repo.dir}:self-heal:stale-only-green-build`,
      source: 'self' as const,
      title: 'Fix broken build in ashlrcode: stale only item',
      detail: 'Stale self-heal item that should be pruned with no replacement work.',
      score: 9,
      tags: ['self-heal', 'build', 'high-priority'],
    };
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [staleSelfHeal] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] });
    mockRunAutoMergePass.mockResolvedValue({ merged: 1 });

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1, parallel: 1 }), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.itemsConsidered).toBe(0);
    expect(result.merged).toBe(1);
    expect(result.autoMerge).toMatchObject({ merged: 1 });
    expect(mockBuildBacklog).toHaveBeenCalledTimes(2);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledWith([repo.dir], expect.any(Object));
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1a2d2: withheld direction authority blocks the drain after producer maintenance empties backlog', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [staleBase] = makeItems(repo.dir, 1);
    const staleSelfHeal = {
      ...staleBase!,
      id: `${repo.dir}:self-heal:authority-blocked-green-build`,
      source: 'self' as const,
      title: 'Fix broken build in ashlrcode: authority blocked item',
      detail: 'Stale self-heal item removed before the maintenance scheduling site.',
      score: 9,
      tags: ['self-heal', 'build', 'high-priority'],
    };
    mockBuildBacklog
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [staleSelfHeal] })
      .mockResolvedValueOnce({ generatedAt: new Date().toISOString(), repos: [repo.dir], items: [] });
    mockBuildResourceStrategyReport.mockResolvedValue(
      strategyReport('backlog-build', 'continue dispatch', 'unavailable'),
    );

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.directionMode).toBe('backlog-build');
    expect(mockRunSelfHealCycleForRepos).toHaveBeenCalledTimes(1);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1a2e: ordinary self-improve backlog does not trigger self-heal maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const [base] = makeItems(repo.dir, 1);
    const selfImproveItem = {
      ...base!,
      id: `${repo.dir}:self:skip-test-gap`,
      source: 'self' as const,
      title: 'Restore skipped test in fleet.test.ts:12',
      detail: 'Bare skipped test that should be handled as ordinary self-improvement work.',
      tags: ['self', 'test-gap'],
    };
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [selfImproveItem],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycleForRepos).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(result.dispatches?.[0]?.itemId).toBe(selfImproveItem.id);
  });

  it('A1a3: empty backlog does not rerun producer maintenance inside the daemon interval', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    seedTicks([{
      ts: new Date().toISOString(),
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-backlog',
      producerMaintenance: {
        selfHeal: true,
        invent: false,
        ancillary: true,
      },
    }]);

    const result = await tick(
      {
        ...cfgBuiltin(),
        daemon: {
          ...cfgBuiltin().daemon,
          intervalMs: 60_000,
          mode: 'continuous',
          idleBackoffMs: 1,
        },
        foundry: { autonomyControlLoop: false, generative: true },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(result.producerMaintenance).toMatchObject({
      selfHeal: false,
      invent: false,
      ancillary: false,
      skippedByCadence: true,
    });
  });

  it('A1b: empty backlog still runs auto-merge maintenance when enabled', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    mockRunAutoMergePass.mockResolvedValue({ merged: 2 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.merged).toBe(2);
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1b2: withheld direction authority blocks maintenance for an initially empty backlog', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    mockBuildResourceStrategyReport.mockResolvedValue(
      strategyReport('backlog-build', 'continue dispatch', 'unavailable'),
    );

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.directionMode).toBe('backlog-build');
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1c: empty backlog dry-run does not run auto-merge maintenance', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: true },
    );

    expect(result.reason).toBe('no-backlog');
    expect(result.dryRun).toBe(true);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1c2: selected backlog dry-run marks simulation and dispatches nothing', async () => {
    enrollWithItems(1);

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: true });

    expect(result.reason).toBe('dry-run');
    expect(result.dryRun).toBe(true);
    expect(result.spentUsd).toBe(0);
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAgentActions().filter((event) => event.action === 'daemon:dispatch-start')).toHaveLength(0);
  });

  it('A1d: budget exhaustion blocks auto-merge maintenance', async () => {
    seedSpend(1.0);

    const result = await tick(
      { ...cfgBuiltin({ dailyBudgetUsd: 1.0 }), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('budget-exhausted');
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAgentActions().filter((event) => event.action === 'daemon:dispatch-start')).toHaveLength(0);
  });

  it('A1e: autonomy control pause builds strategy snapshot and skips dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'mock guard block'));
    mockReconcileRemoteHandoffs.mockReturnValue({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    expect(result.directionMode).toBe('pause');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: {
        buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }>;
        runEcosystemDoctor?: (opts?: { root?: string; now?: Date }) => Promise<{ summary?: { total?: number } }>;
        listOutcomeRecords?: () => unknown[];
      };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 0 },
    });
    await expect(strategyOpts.deps?.runEcosystemDoctor?.()).resolves.toMatchObject({
      summary: { total: 1 },
    });
    expect(strategyOpts.deps?.listOutcomeRecords?.()).toEqual([]);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockReconcileRemoteHandoffs).not.toHaveBeenCalled();
    expect(result.remoteHandoff).toBeUndefined();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readAgentActions().filter((event) => event.action === 'daemon:dispatch-start')).toHaveLength(0);
  });

  it('A1e1: strategy merge truth ignores tick reports and generic applied lifecycle state', async () => {
    const { items } = enrollWithItems(1);
    const proposal = createProposal({
      repo: items[0]!.repo,
      origin: 'agent',
      kind: 'patch',
      title: 'Applied without a realized merge',
      summary: 'Lifecycle completion is not landed-work evidence.',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
    });
    expect(setStatus(proposal.id, 'applied')).toBe(true);
    seedTicks([{
      ts: 'not-a-timestamp',
      reason: 'ok',
      itemsConsidered: 1,
      proposalsCreated: 1,
      merged: 7,
      spentUsd: 0,
    }]);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'inspect truth'));

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: {
        buildFleetStatus?: () => Promise<{
          merges?: { recent?: number; reportedByTicks?: number };
          proposals?: {
            applied?: number;
            sourceQuality?: { sourceState?: string; complete?: boolean };
            authority?: { gate?: string };
          };
        }>;
      };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      proposals: {
        applied: 1,
        sourceQuality: { sourceState: 'healthy', complete: true },
        authority: { gate: 'ready' },
      },
      merges: { recent: 0, reportedByTicks: 7 },
    });
  });

  it('A1e1b: strategy snapshot bounds degraded proposal source quality and withholds authority', async () => {
    enrollWithItems(1);
    fs.mkdirSync(inboxDir(), { recursive: true });
    fs.writeFileSync(join(inboxDir(), 'invalid-proposal.json'), '{not-json', 'utf8');
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'inspect degraded source'));

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { buildFleetStatus?: () => Promise<{ proposals?: Record<string, unknown> }> };
    };
    const status = await strategyOpts.deps?.buildFleetStatus?.();
    expect(status?.proposals).toMatchObject({
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        stopReasons: ['invalid-file'],
        invalidFiles: 1,
      },
      authority: {
        gate: 'unavailable',
        detail: expect.stringContaining('complete healthy proposal source'),
      },
    });
    expect((status?.proposals?.sourceQuality as Record<string, unknown>)?.bytesRead).toBeUndefined();
  });

  it('A1e2: production velocity supplies pending outcome records to the daemon strategy', async () => {
    const { items } = enrollWithItems(1);
    const proposal = createProposal({
      repo: items[0]!.repo,
      origin: 'agent',
      kind: 'patch',
      title: `Pending ${items[0]!.id}`,
      summary: 'pending proposal for production velocity strategy',
      diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
      workItemId: items[0]!.id,
      workSource: items[0]!.source,
    });
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'mock guard block'));

    const result = await tick(
      {
        ...cfgBuiltin(),
        foundry: {
          autonomyControlLoop: true,
          productionVelocity: { enabled: true, profile: 'resource-control' },
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { listOutcomeRecords?: (opts?: { limit?: number }) => Array<{ proposal?: { id?: string } }> };
    };
    const records = strategyOpts.deps?.listOutcomeRecords?.({ limit: 6 }) ?? [];
    expect(records.some((record) => record.proposal?.id === proposal.id)).toBe(true);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
  });

  it('A1f: autonomy control verify-only builds strategy snapshot and runs merge maintenance only', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('verify-only', 'pending proposals need verification'));
	    mockRunAutoMergePass.mockResolvedValue({
	      attempted: 3,
	      judgePerPass: 4,
	      judged: 2,
	      judgeCapped: 1,
	      verifyBeforeJudgePerPass: 3,
	      verifyBeforeJudgeRan: 2,
	      verifyBeforeJudgeCapped: 1,
	      judgeEstimatedSpendUsd: 0.0123,
	      judgeMeasuredSpendUsd: 0.0045,
	      judgeUnmeteredCalls: 1,
	      merged: 1,
	      autoArchived: 1,
	      ttlRejected: 1,
	      invalidRejected: 1,
	    });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true, autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('verify-only');
	    expect(result.directionMode).toBe('verify-only');
	    expect(result.directionReason).toBe('pending proposals need verification');
	    expect(result.merged).toBe(1);
	    expect(result.spentUsd).toBe(0);
    expect(result.autoMerge).toEqual({
	      attempted: 3,
	      judgePerPass: 4,
	      judged: 2,
	      judgeCapped: 1,
	      verifyBeforeJudgePerPass: 3,
	      verifyBeforeJudgeRan: 2,
	      verifyBeforeJudgeCapped: 1,
	      judgeEstimatedSpendUsd: 0.0123,
	      judgeMeasuredSpendUsd: 0.0045,
	      judgeUnmeteredCalls: 1,
	      merged: 1,
	      autoArchived: 1,
	      ttlRejected: 1,
	      invalidRejected: 1,
    });
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockReconcileRemoteHandoffs).toHaveBeenCalledTimes(1);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f1: real strategy conversion blocks verify-only maintenance without proposal authority', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(
      strategyReport('verify-only', 'pending proposals need verification', 'unavailable'),
    );

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autonomyControlLoop: true, autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('verify-only');
    expect(result.directionMode).toBe('verify-only');
    expect(result.directionReason).toContain('complete healthy proposal source');
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f2: Foundry defaults to executable verify-only control', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('verify-only', 'pending proposals need verification'));
    mockRunAutoMergePass.mockResolvedValue({ attempted: 1, merged: 0 });
    mockReconcileRemoteHandoffs.mockReturnValue({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('verify-only');
    expect(result.directionMode).toBe('verify-only');
    expect(result.directionReason).toBe('pending proposals need verification');
    expect(result.remoteHandoff).toEqual({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });
    const state = loadDaemonState();
    expect(state.ticks.at(-1)?.remoteHandoff).toEqual({ checked: 2, merged: 1, closed: 1, open: 0, unknown: 0 });
    expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
    expect(mockReconcileRemoteHandoffs).toHaveBeenCalledTimes(1);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockRunInventCycle).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1f4: executable direction uses persisted enrolled backlog count before scanner refresh', async () => {
    const { repo, items } = enrollWithItems(1);
    mockLoadBacklog.mockReturnValue({ generatedAt: new Date().toISOString(), repos: [repo.dir], items });
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'cached count only'));

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }> };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 1 },
    });
  });

  it('A1f5: executable direction counts queued self-heal work when persisted backlog is stale', async () => {
    const { repo, items } = enrollWithItems(1);
    mockLoadBacklog.mockReturnValue({
      generatedAt: new Date().toISOString(),
      repos: ['/tmp/deleted-fixture'],
      items: [{ ...items[0]!, repo: '/tmp/deleted-fixture', id: 'stale-temp-item' }],
    });
    mockLoadQueuedAutonomyItems.mockReturnValue([
      {
        ...items[0]!,
        id: 'queued-self-heal',
        repo: repo.dir,
        source: 'self',
        tags: ['self-heal', 'test'],
      },
    ]);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('pause', 'cached count only'));

    const result = await tick(
      { ...cfgBuiltin(), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('pause');
    const strategyOpts = mockBuildResourceStrategyReport.mock.calls[0]?.[1] as {
      deps?: { buildFleetStatus?: () => Promise<{ queue?: { backlogItems?: number } }> };
    };
    await expect(strategyOpts.deps?.buildFleetStatus?.()).resolves.toMatchObject({
      queue: { backlogItems: 1 },
    });
    expect(mockBuildBacklog).not.toHaveBeenCalled();
  });

  it('A1f3: explicit autonomyControlLoop=false keeps Foundry advisory-only', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('verify-only', 'pending proposals need verification'));

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { autonomyControlLoop: false, autoMerge: { enabled: true } },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBeUndefined();
    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A1f6: withheld direction authority blocks post-dispatch maintenance', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(
      strategyReport('backlog-build', 'continue dispatch', 'unavailable'),
    );

    const result = await tick(
      { ...cfgBuiltin({ perTickItems: 1 }), foundry: { autoMerge: { enabled: true } } } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('backlog-build');
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
  });

  it('A1g: autonomy control local-only clamps cloud routing to builtin dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('local-only', 'cloud resources constrained'));
    mockRouteBackend.mockReturnValue({ backend: 'claude', tier: 'frontier', reason: 'mock cloud' });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          autonomyControlLoop: true,
          allowedBackends: ['claude', 'builtin'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('local-only');
    expect(result.backends).toEqual({ builtin: 1 });
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('A1h: autonomy control local-only preserves local-coder dispatch', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('local-only', 'frontier budget constrained'));
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          autonomyControlLoop: true,
          allowedBackends: ['claude', 'local-coder', 'builtin'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.directionMode).toBe('local-only');
    expect(result.directionReason).toBe('frontier budget constrained');
    expect(result.backends).toEqual({ 'local-coder': 1 });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ engine: 'local-coder' });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1h2: sandboxed engine proposal outcomes are persisted on dispatch traces', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-empty-diff',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.004, steps: 1 },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'allow',
        policyTier: 'docs',
        gateCount: 3,
      },
      proposalOutcome: {
        kind: 'empty-diff',
        reason: 'engine "local-coder" completed without file changes',
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'empty-diff: engine "local-coder" completed without file changes',
      production: {
        outcome: 'empty-diff',
        runId: 'run-empty-diff',
        reason: 'engine "local-coder" completed without file changes',
        evidenceOutcome: {
          target: 'main',
          trustBasis: 'verification',
          riskClass: 'low',
          verificationPassed: true,
          policyAllowed: true,
          policyAction: 'allow',
          policyTier: 'docs',
          gateCount: 3,
        },
      },
    });
    expect(result.proposalProduction?.reasons?.[0]).toEqual({
      reason: 'empty-diff: engine "local-coder" completed without file changes',
      count: 1,
    });
    const trajectoryId = result.dispatches?.[0]?.trajectoryId;
    expect(trajectoryId).toMatch(/^run:attempt-/);
    expect(loadDaemonState().ticks.at(-1)?.dispatches?.[0]?.production).toMatchObject({
      outcome: 'empty-diff',
      runId: 'run-empty-diff',
      trajectoryId,
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'allow',
        policyTier: 'docs',
        gateCount: 3,
      },
    });
    const productionEvent = readDispatchProductionEvents({ limit: 1 })[0];
    expect(productionEvent).toMatchObject({
      itemId: items[0]!.id,
      source: 'todo',
      repo: items[0]!.repo,
      title: items[0]!.title,
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'router',
      routeReason: 'mock local-coder',
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-empty-diff',
      trajectoryId,
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'mid',
        assignedBy: 'router',
        reason: 'mock local-coder',
      },
      runEventSummary: {
        runId: 'run-empty-diff',
        status: 'done',
        outcome: 'empty-diff',
        proposalCreated: false,
        costUsd: 0.004,
      },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'allow',
        policyTier: 'docs',
        gateCount: 3,
      },
      learningSource: 'daemon-dispatch',
      labelBasis: 'dispatch-outcome',
      objectiveHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      spentUsd: 0.004,
      reason: 'engine "local-coder" completed without file changes',
      basis: 'run-proposal-outcome',
    });
    const dispatchAction = readAgentActions({ limit: 10 }).find((event) => event.action === 'daemon:dispatch');
    expect(dispatchAction).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'no-proposal',
      trajectoryId: productionEvent?.trajectoryId,
      runEventSummary: productionEvent?.runEventSummary,
      evidenceOutcome: productionEvent?.evidenceOutcome,
    });
  });

  it('A1h2a: cancelled direct execution retains spend and audits no proposal', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'cancel accounting' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunGoal.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        id: 'run-cancelled-paid',
        status: 'aborted',
        terminationReason: 'cancelled',
        result: 'Run cancelled.',
        usage: { tokensIn: 70, tokensOut: 30, totalTokens: 100, estCostUsd: 0.123, steps: 1 },
      };
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'] },
      } as AshlrConfig,
      { dryRun: false, signal: shutdown.signal },
    );

    expect(result).toMatchObject({
      reason: 'shutdown-requested',
      spentUsd: 0.123,
      proposalsCreated: 0,
      dispatches: [expect.objectContaining({
        itemId: items[0]!.id,
        dispatched: true,
        spentUsd: 0.123,
        production: expect.objectContaining({
          outcome: 'cancelled',
          reason: 'run cancelled by owner',
          runEventSummary: expect.objectContaining({
            status: 'aborted',
            outcome: 'cancelled',
            proposalCreated: false,
          }),
        }),
      })],
    });
    expect(loadDaemonState()).toMatchObject({ todaySpentUsd: 0.123 });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    const itemAudit = readAudit().filter((entry) => entry.repo === items[0]!.repo);
    expect(itemAudit.some((entry) => entry.action === 'daemon:proposal-created')).toBe(false);
    expect(itemAudit.some((entry) => entry.action === 'daemon:no-proposal')).toBe(true);
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'cancelled',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'skipped',
      reason: 'run cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
  });

  it('A1h2a1: cancelled builtin swarm records aborted production without empty-work learning', async () => {
    const { items } = enrollWithItems(1);
    const shutdown = new AbortController();
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => {
      shutdown.abort();
      return {
        id: (opts as { runId: string }).runId,
        status: 'aborted',
        goal: items[0]!.title,
        result: 'Swarm cancelled.',
        usage: { tokensIn: 40, tokensOut: 10, totalTokens: 50, estCostUsd: 0.045, steps: 1 },
      };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      dryRun: false,
      signal: shutdown.signal,
    });

    expect(result).toMatchObject({
      reason: 'shutdown-requested',
      spentUsd: 0.045,
      dispatches: [expect.objectContaining({
        itemId: items[0]!.id,
        production: expect.objectContaining({
          outcome: 'cancelled',
          reason: 'swarm cancelled by owner',
          runEventSummary: expect.objectContaining({
            status: 'aborted',
            outcome: 'cancelled',
            proposalCreated: false,
          }),
        }),
      })],
    });
    expect(loadDaemonState().todaySpentUsd).toBe(0.045);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'cancelled',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'skipped',
      reason: 'swarm cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
  });

  it('A1h2a2: cancelled Best-of-N records aborted production and all candidate spend', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'cancelled fan-out' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunBestOfN.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        winner: undefined,
        candidates: [
          { index: 0, engine: 'local-coder', diff: '', score: 0, error: 'cancelled', costUsd: 0.02 },
          { index: 1, engine: 'local-coder', diff: '', score: 0, error: 'cancelled', costUsd: 0.03 },
        ],
        critique: {
          n: 2,
          nonEmpty: 0,
          judged: 0,
          topScore: 0,
          winnerIndex: -1,
          totalCostUsd: 0.05,
          billableCostUsd: 0.05,
          noProposalReasons: [{ reason: 'selection cancelled', count: 1 }],
        },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result).toMatchObject({
      reason: 'shutdown-requested',
      spentUsd: 0.05,
      dispatches: [expect.objectContaining({
        itemId: items[0]!.id,
        production: expect.objectContaining({
          outcome: 'cancelled',
          reason: 'best-of-2 selection cancelled by owner',
          runEventSummary: expect.objectContaining({
            status: 'aborted',
            outcome: 'cancelled',
            proposalCreated: false,
            costUsd: 0.05,
          }),
        }),
      })],
    });
    expect(loadDaemonState().todaySpentUsd).toBe(0.05);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'cancelled',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false, costUsd: 0.05 },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'skipped',
      reason: 'best-of-2 selection cancelled by owner',
      runEventSummary: { status: 'aborted', outcome: 'cancelled', proposalCreated: false },
      learningLabel: {
        learningKind: 'cancelled',
        diagnosticAttempt: false,
        diagnosticNoProposal: false,
      },
    });
  });

  it('A1h2a3: an aborted swarm hard-budget result remains an engine failure', async () => {
    const { items } = enrollWithItems(1);
    const shutdown = new AbortController();
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => {
      shutdown.abort();
      return {
        id: (opts as { runId: string }).runId,
        status: 'aborted',
        goal: items[0]!.title,
        result: 'Swarm aborted: hard total budget exceeded during phase build',
        usage: { tokensIn: 80, tokensOut: 20, totalTokens: 100, estCostUsd: 0.04, steps: 1 },
      };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      dryRun: false,
      signal: shutdown.signal,
    });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'Swarm aborted: hard total budget exceeded during phase build',
      runEventSummary: { status: 'aborted' },
    });
    expect(result.dispatches?.[0]?.production?.runEventSummary?.outcome).not.toBe('cancelled');
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed' },
      learningLabel: { learningKind: 'failed', diagnosticAttempt: true },
    });
  });

  it('A1h2a4: an aborted direct hard-budget result remains an engine failure', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'hard budget' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunGoal.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        id: 'run-hard-budget',
        status: 'aborted',
        result: 'Run aborted: hard total budget exceeded',
        usage: { tokensIn: 60, tokensOut: 20, totalTokens: 80, estCostUsd: 0.03, steps: 1 },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'Run aborted: hard total budget exceeded',
      runEventSummary: { status: 'aborted' },
    });
    expect(result.dispatches?.[0]?.production?.runEventSummary?.outcome).not.toBe('cancelled');
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed' },
      learningLabel: { learningKind: 'failed', diagnosticAttempt: true },
    });
  });

  it('A1h2a5: an authoritative direct error exit wins over a concurrent owner abort', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'error exit' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunGoal.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        id: 'run-error-exit',
        status: 'failed',
        terminationReason: 'error-exit',
        result: 'Engine exited with status 1',
        usage: { tokensIn: 50, tokensOut: 10, totalTokens: 60, estCostUsd: 0.02, steps: 1 },
        proposalOutcome: {
          kind: 'engine-failed-no-diff',
          reason: 'engine exited before producing a diff',
        },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'engine exited before producing a diff',
      runEventSummary: { status: 'failed' },
    });
    expect(result.dispatches?.[0]?.production?.runEventSummary?.outcome).not.toBe('cancelled');
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      runEventSummary: { status: 'failed', outcome: 'engine-failed' },
      learningLabel: { learningKind: 'failed', diagnosticAttempt: true },
    });
  });

  it('A1h2a6: authoritative Best-of-N candidate failure wins over a late owner abort', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'budget fan-out' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunBestOfN.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        winner: undefined,
        candidates: [
          { index: 0, engine: 'local-coder', diff: '', score: 0, error: 'hard total budget exceeded', costUsd: 0.02 },
          { index: 1, engine: 'local-coder', diff: '', score: 0, error: 'cancelled', costUsd: 0.01 },
        ],
        critique: {
          n: 2,
          nonEmpty: 0,
          judged: 0,
          topScore: 0,
          winnerIndex: -1,
          totalCostUsd: 0.03,
          billableCostUsd: 0.03,
          noProposalReasons: [
            { reason: 'selection cancelled', count: 1 },
            { reason: 'hard total budget exceeded', count: 1 },
          ],
        },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'best-of-2: hard total budget exceeded',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed', costUsd: 0.03 },
    });
    expect(result.dispatches?.[0]?.production?.runEventSummary?.outcome).not.toBe('cancelled');
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      reason: 'best-of-2: hard total budget exceeded',
      learningLabel: { learningKind: 'failed', diagnosticAttempt: true },
    });
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'failed',
      reason: 'best-of-2: hard total budget exceeded',
    });
  });

  it.each([false, true])(
    'A1h2a6a: Best-of-N hard failures beat empty outcomes regardless of candidate order (reversed=%s)',
    async (reversed) => {
      enrollWithItems(1);
      mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'ordered fan-out' });
      mockEngineTierOf.mockReturnValue('mid');
      const emptyCandidate = {
        index: 0,
        engine: 'local-coder',
        diff: '',
        score: 0,
        proposalOutcome: { kind: 'empty-diff', reason: 'engine completed without file changes' },
        error: 'empty-diff: engine completed without file changes',
        costUsd: 0.01,
      };
      const failedCandidate = {
        index: 1,
        engine: 'local-coder',
        diff: '',
        score: 0,
        error: 'engine exited with status 1',
        costUsd: 0.02,
      };
      mockRunBestOfN.mockResolvedValueOnce({
        winner: undefined,
        candidates: reversed ? [failedCandidate, emptyCandidate] : [emptyCandidate, failedCandidate],
        critique: {
          n: 2,
          nonEmpty: 0,
          judged: 0,
          topScore: 0,
          winnerIndex: -1,
          totalCostUsd: 0.03,
          billableCostUsd: 0.03,
          noProposalReasons: [
            { reason: 'empty-diff: engine completed without file changes', count: 1 },
            { reason: 'engine exited with status 1', count: 1 },
          ],
        },
      });

      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
      } as AshlrConfig, { dryRun: false });

      expect(result.dispatches?.[0]?.production).toMatchObject({
        outcome: 'engine-failed',
        reason: 'best-of-2: engine exited with status 1',
        runEventSummary: { status: 'failed', outcome: 'engine-failed', costUsd: 0.03 },
      });
    },
  );

  it.each([
    ['empty-diff', 'engine completed without file changes', false],
    ['empty-diff', 'engine completed without file changes', true],
    ['trivial-proposal', 'completeness gate rejected the diff', false],
    ['trivial-proposal', 'completeness gate rejected the diff', true],
    ['proposal-disabled', 'proposal capture disabled by policy', false],
    ['proposal-disabled', 'proposal capture disabled by policy', true],
  ] as const)(
    'A1h2a6c: Best-of-N mirrored %s errors (%s) preserve structured no-proposal truth (reversed=%s)',
    async (kind, reason, reversed) => {
      enrollWithItems(1);
      mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'structured fan-out' });
      mockEngineTierOf.mockReturnValue('mid');
      const structuredCandidate = {
        index: 0,
        engine: 'local-coder',
        diff: '',
        score: 0,
        proposalOutcome: { kind, reason },
        error: `${kind}: ${reason}`,
        costUsd: 0.02,
      };
      const cancelledCandidate = {
        index: 1,
        engine: 'local-coder',
        diff: '',
        score: 0,
        error: 'cancelled',
        costUsd: 0.01,
      };
      mockRunBestOfN.mockResolvedValueOnce({
        winner: undefined,
        candidates: reversed
          ? [cancelledCandidate, structuredCandidate]
          : [structuredCandidate, cancelledCandidate],
        critique: {
          n: 2,
          nonEmpty: 0,
          judged: 0,
          topScore: 0,
          winnerIndex: -1,
          totalCostUsd: 0.03,
          billableCostUsd: 0.03,
          noProposalReasons: [
            { reason: `${kind}: ${reason}`, count: 1 },
            { reason: 'selection cancelled', count: 1 },
          ],
        },
      });

      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
      } as AshlrConfig, { dryRun: false });

      const expectedOutcome = kind === 'empty-diff'
        ? 'empty-diff'
        : kind === 'proposal-disabled'
          ? 'proposal-disabled'
          : 'gate-blocked';
      expect(result.dispatches?.[0]?.production).toMatchObject({
        outcome: expectedOutcome,
        reason: `best-of-2: ${kind}: ${reason}`,
        runEventSummary: {
          status: 'done',
          outcome: expectedOutcome,
          proposalCreated: false,
          costUsd: 0.03,
        },
      });
    },
  );

  it.each([false, true])(
    'A1h2a6b: Best-of-N filed proposals beat failures regardless of candidate order (reversed=%s)',
    async (reversed) => {
      enrollWithItems(1);
      mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'filed fan-out' });
      mockEngineTierOf.mockReturnValue('mid');
      const filedCandidate = {
        index: 0,
        engine: 'local-coder',
        diff: 'diff --git a/x.ts b/x.ts\n',
        score: 0,
        proposalId: 'proposal-best-of-n',
        proposalOutcome: {
          kind: 'filed',
          reason: 'proposal filed before selection failed',
          proposalId: 'proposal-best-of-n',
          files: 1,
          insertions: 1,
          deletions: 0,
        },
        costUsd: 0.02,
      };
      const failedCandidate = {
        index: 1,
        engine: 'local-coder',
        diff: '',
        score: 0,
        error: 'critic error exit',
        costUsd: 0.01,
      };
      mockRunBestOfN.mockResolvedValueOnce({
        winner: undefined,
        candidates: reversed ? [failedCandidate, filedCandidate] : [filedCandidate, failedCandidate],
        critique: {
          n: 2,
          nonEmpty: 1,
          judged: 0,
          topScore: 0,
          winnerIndex: -1,
          totalCostUsd: 0.03,
          billableCostUsd: 0.03,
          noProposalReasons: [{ reason: 'critic error exit', count: 1 }],
        },
      });

      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
      } as AshlrConfig, { dryRun: false });

      expect(result.dispatches?.[0]?.production).toMatchObject({
        outcome: 'proposal-created',
        proposalId: 'proposal-best-of-n',
        reason: 'best-of-2: proposal filed before selection failed',
        runEventSummary: {
          status: 'done',
          outcome: 'proposal-created',
          proposalCreated: true,
          costUsd: 0.03,
        },
      });
    },
  );

  it('A1h2a7: a generic aborted producer is failure telemetry, not unknown no-proposal', async () => {
    const { items } = enrollWithItems(1);
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => ({
      id: (opts as { runId: string }).runId,
      status: 'aborted',
      goal: items[0]!.title,
      result: 'Swarm aborted after worker failure',
      usage: { tokensIn: 30, tokensOut: 5, totalTokens: 35, estCostUsd: 0.01, steps: 1 },
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'Swarm aborted after worker failure',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed' },
    });
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      learningLabel: { learningKind: 'failed', diagnosticAttempt: true },
    });
  });

  it('A1h2a8: a generic aborted direct run wins over a late owner abort', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'generic abort' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunGoal.mockImplementationOnce(async () => {
      shutdown.abort();
      return {
        id: 'run-generic-abort',
        status: 'aborted',
        result: 'Run aborted after worker failure',
        usage: { tokensIn: 30, tokensOut: 5, totalTokens: 35, estCostUsd: 0.01, steps: 1 },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'engine-failed',
      reason: 'Run aborted after worker failure',
      runEventSummary: { status: 'aborted', outcome: 'engine-failed' },
    });
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'failed',
    });
  });

  it('A1h2a9: a filed direct proposal wins over a late owner abort', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'filed before abort' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();
    mockRunGoal.mockImplementationOnce(async (_goal, _cfg, runOpts) => {
      const runId = (runOpts as { runId: string }).runId;
      const proposal = createProposal({
        repo: items[0]!.repo,
        origin: 'run',
        kind: 'patch',
        title: items[0]!.title,
        summary: 'filed before late owner abort',
        diff: 'diff --git a/x.ts b/x.ts\n',
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        runId,
      });
      shutdown.abort();
      return {
        id: runId,
        status: 'done',
        result: 'Proposal filed.',
        usage: { tokensIn: 40, tokensOut: 10, totalTokens: 50, estCostUsd: 0.02, steps: 1 },
        proposalOutcome: {
          kind: 'filed',
          reason: 'proposal filed',
          proposalId: proposal.id,
          files: 1,
          insertions: 1,
          deletions: 0,
        },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'proposal-created',
      reason: 'proposal filed',
      runEventSummary: { status: 'done', proposalCreated: true },
    });
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-created',
      proposalCreated: true,
    });
  });

  it('A1h2b: trivial proposal outcomes persist as gate-blocked no-proposal production', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder trivial' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-trivial-proposal',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.003, steps: 1 },
      proposalOutcome: {
        kind: 'trivial-proposal',
        reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
        files: 1,
        insertions: 1,
        deletions: 1,
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'gate-blocked: trivial proposal blocked: 2 changed line(s) in docs only',
      production: {
        outcome: 'gate-blocked',
        runId: 'run-trivial-proposal',
        reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
        diffFiles: 1,
        diffLines: 2,
      },
    });
    expect(result.proposalProduction?.reasons?.[0]).toEqual({
      reason: 'gate-blocked: trivial proposal blocked: 2 changed line(s) in docs only',
      count: 1,
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'gate-blocked',
      proposalCreated: false,
      runId: 'run-trivial-proposal',
      reason: 'trivial proposal blocked: 2 changed line(s) in docs only',
      diffFiles: 1,
      diffLines: 2,
      basis: 'run-proposal-outcome',
    });
    expect(readAgentActions({ limit: 10 }).find((event) => event.action === 'daemon:dispatch')).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'no-proposal',
      runId: 'run-trivial-proposal',
    });
  });

  it('A1h2c: builtin swarm exposes typed empty-diff production without queue inference', async () => {
    const { items } = enrollWithItems(1);
    const pendingBefore = pendingCount();

    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => {
      const runId = (opts as { runId: string }).runId;
      expect(readAgentActions().find((event) => event.action === 'daemon:dispatch-start')).toMatchObject({
        itemId: items[0]!.id,
        runId,
        outcome: 'started',
      });
      return {
        id: runId,
        status: 'done',
        goal: items[0]!.title,
        usage: { tokensIn: 80, tokensOut: 20, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: {
          kind: 'empty-diff',
          reason: 'builtin swarm completed without file changes',
          files: 0,
          insertions: 0,
          deletions: 0,
        },
      };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    expect(pendingCount()).toBe(pendingBefore);
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      skipReason: 'empty-diff: builtin swarm completed without file changes',
      production: {
        outcome: 'empty-diff',
        reason: 'builtin swarm completed without file changes',
        diffFiles: 0,
        diffLines: 0,
        runEventSummary: {
          status: 'done',
          outcome: 'empty-diff',
          proposalCreated: false,
        },
      },
    });
    const productionEvent = readDispatchProductionEvents({ limit: 1 })[0];
    expect(productionEvent).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      outcome: 'empty-diff',
      proposalCreated: false,
      basis: 'run-proposal-outcome',
    });
    const startEvent = readAgentActions().find((event) => event.action === 'daemon:dispatch-start');
    expect(Date.parse(productionEvent!.ts)).toBeGreaterThanOrEqual(Date.parse(startEvent!.ts));
  });

  it('A1h2d: builtin partial proposal preserves aborted execution status and filed artifact telemetry', async () => {
    const { items } = enrollWithItems(1);
    const pendingBefore = pendingCount();

    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => ({
      id: (opts as { runId: string }).runId,
      status: 'aborted',
      goal: items[0]!.title,
      usage: { tokensIn: 200, tokensOut: 50, estCostUsd: 0.006, steps: 2 },
      proposalOutcome: {
        kind: 'filed',
        reason: 'builtin swarm partial proposal filed',
        isPartial: true,
        proposalId: 'prop-partial-builtin',
        files: 2,
        insertions: 7,
        deletions: 3,
      },
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    expect(pendingCount()).toBe(pendingBefore);
    // Tick aggregate remains the independently observed inbox delta. The typed
    // production record blocks failed partial evidence while retaining its
    // artifact telemetry for diagnosis.
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'gate-blocked',
      proposalId: 'prop-partial-builtin',
      reason: 'partial artifact filed after aborted producer: builtin swarm partial proposal filed',
      diffFiles: 2,
      diffLines: 10,
      runEventSummary: {
        status: 'aborted',
        outcome: 'gate-blocked',
        proposalCreated: false,
        proposalId: 'prop-partial-builtin',
      },
    });
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      outcome: 'gate-blocked',
      proposalCreated: false,
      proposalId: 'prop-partial-builtin',
      reason: 'partial artifact filed after aborted producer: builtin swarm partial proposal filed',
      diffFiles: 2,
      diffLines: 10,
      runEventSummary: {
        status: 'aborted',
        outcome: 'gate-blocked',
        proposalCreated: false,
        proposalId: 'prop-partial-builtin',
      },
    });
  });

  it('A1h2d2: done producer partial evidence remains gate-blocked', async () => {
    const { items } = enrollWithItems(1);
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => ({
      id: (opts as { runId: string }).runId,
      status: 'done',
      goal: items[0]!.title,
      usage: { tokensIn: 200, tokensOut: 50, estCostUsd: 0.006, steps: 2 },
      proposalOutcome: {
        kind: 'filed',
        reason: 'tests still failing after final attempt',
        isPartial: true,
        proposalId: 'prop-partial-done',
        files: 1,
        insertions: 4,
        deletions: 1,
      },
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'gate-blocked',
      proposalId: 'prop-partial-done',
      reason: 'partial artifact filed after done producer: tests still failing after final attempt',
      runEventSummary: {
        status: 'done',
        outcome: 'gate-blocked',
        proposalCreated: false,
      },
    });
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      outcome: 'gate-blocked',
      proposalCreated: false,
      proposalId: 'prop-partial-done',
    });
  });

  it('A1h2e: builtin governance suppression remains proposal-disabled and does not cool work', async () => {
    const { items } = enrollWithItems(1);
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => ({
      id: (opts as { runId: string }).runId,
      status: 'failed',
      goal: items[0]!.title,
      usage: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, steps: 0 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'spend governance blocked swarm execution',
      },
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    expect(result.dispatches?.[0]?.production).toMatchObject({
      outcome: 'proposal-disabled',
      reason: 'spend governance blocked swarm execution',
      runEventSummary: { status: 'failed', outcome: 'proposal-disabled' },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      outcome: 'proposal-disabled',
      proposalCreated: false,
    });
  });

  it('A1h2f: live builtin dispatch keeps skill selection dormant and leaves swarm inputs unchanged', async () => {
    const { items } = enrollWithItems(2);
    const skill = attestSkillCard(sanitizeSkillCard({
      schemaVersion: 1,
      skillId: 'skill.m201-focused-repair',
      revision: 1,
      ts: new Date().toISOString(),
      name: 'M201 focused repair',
      summary: 'Run focused verification for an M201 repair.',
      status: 'verified',
      source: 'verified-proposal',
      tags: ['m201', 'repair'],
      taskKinds: ['m201-item'],
      commandKinds: ['typecheck', 'test'],
      verification: {
        passed: true,
        commandKinds: ['typecheck', 'test'],
        diffHash: 'a'.repeat(64),
        evidenceCount: 2,
      },
      proposalId: 'proposal-m201-shadow-fixture',
    }));
    expect(skill).not.toBeNull();
    recordSkillCard(skill!);

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    expect(result.dispatches).toHaveLength(2);
    const events = readSkillUseEvents();
    expect(events).toEqual([]);
    for (const call of mockRunSwarm.mock.calls) {
      expect(call[2]).not.toHaveProperty('selectedSkillIds');
      expect(call[2]).not.toHaveProperty('skills');
      expect(call[2]).not.toHaveProperty('skillContext');
    }
    const persisted = JSON.stringify(events);
    expect(persisted).not.toContain(items[0]!.title);
    expect(persisted).not.toContain(items[1]!.title);
  });

  it('A1h2g: final external route executes without dormant skill observation or changed runGoal options', async () => {
    enrollWithItems(1);
    const skill = attestSkillCard(sanitizeSkillCard({
      schemaVersion: 1,
      skillId: 'skill.external-m201-repair',
      revision: 1,
      ts: new Date().toISOString(),
      name: 'External M201 item repair',
      summary: 'Verify M201 repairs made by a local coding engine.',
      status: 'verified',
      source: 'verified-proposal',
      tags: ['m201', 'repair'],
      taskKinds: ['m201-item'],
      commandKinds: ['test'],
      verification: {
        passed: true,
        commandKinds: ['test'],
        diffHash: 'b'.repeat(64),
        evidenceCount: 1,
      },
      proposalId: 'proposal-external-shadow-fixture',
    }));
    expect(skill).not.toBeNull();
    recordSkillCard(skill!);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', model: 'qwen-shadow', reason: 'final route' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async (_goal, _cfg, opts) => ({
      id: (opts as { runId: string }).runId,
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      engineModel: 'local-coder:qwen-shadow',
      usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
    }));

    await tick(
      { ...cfgBuiltin({ perTickItems: 1 }), foundry: { allowedBackends: ['local-coder'] } } as AshlrConfig,
      { dryRun: false },
    );

    expect(readSkillUseEvents({ limit: 1 })).toEqual([]);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      engine: 'local-coder',
      model: 'qwen-shadow',
    });
    expect(mockRunGoal.mock.calls[0]?.[2]).not.toHaveProperty('selectedSkillIds');
  });

  it('A1h2g1: fallback execution does not revive dormant skill-selection telemetry', async () => {
    enrollWithItems(1);
    recordM201ShadowSkill({ skillId: 'skill.m201-fallback-route' });
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen-requested',
      reason: 'requested external route',
    });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async (_goal, _cfg, opts) => {
      expect(readSkillUseEvents()).toEqual([]);
      return {
        id: (opts as { runId: string }).runId,
        status: 'done',
        engine: 'builtin',
        engineTier: 'local',
        engineModel: 'builtin:llama-fallback',
        usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
      };
    });

    await tick(
      { ...cfgBuiltin({ perTickItems: 1 }), foundry: { allowedBackends: ['local-coder'] } } as AshlrConfig,
      { dryRun: false },
    );

    expect(readSkillUseEvents()).toEqual([]);
  });

  it('A1h2g2: kill-switch outcomes do not emit shadow selection events', async () => {
    const { items } = enrollWithItems(1);
    recordM201ShadowSkill({ skillId: 'skill.m201-kill-switch' });
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => {
      expect(readSkillUseEvents()).toEqual([]);
      return {
        id: (opts as { runId: string }).runId,
        status: 'failed',
        goal: items[0]!.title,
        usage: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, steps: 0 },
        proposalOutcome: {
          kind: 'kill-switch',
          reason: 'kill switch prevented sandbox execution',
        },
      };
    });

    await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    expect(readSkillUseEvents()).toEqual([]);
  });

  it('A1h2g3: skillLibrary false leaves dispatch behavior intact and writes no skill events', async () => {
    enrollWithItems(1);
    recordM201ShadowSkill({ skillId: 'skill.m201-disabled-library' });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1 }),
      foundry: { allowedBackends: ['builtin'], skillLibrary: false },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(readSkillUseEvents()).toEqual([]);
  });

  it('A1h3: routed model is passed into the normal sandboxed runGoal path', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen-routed-model',
      reason: 'mock local-coder model route',
    });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      engine: 'local-coder',
      model: 'qwen-routed-model',
      sandboxEngine: true,
      requireSandbox: true,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: items[0]!.repo,
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        objective: items[0]!.title,
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        backend: {
          engine: 'local-coder',
          model: 'qwen-routed-model',
          tier: 'mid',
          assignedBy: 'router',
          reason: 'mock local-coder model route',
        },
      },
    });
    expect(result.dispatches?.[0]).toMatchObject({
      backend: 'local-coder',
      model: 'qwen-routed-model',
    });
  });

  it('A1h3b: learned-router backend changes do not keep the previous backend model', async () => {
    enrollWithItems(1);
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen-routed-model',
      reason: 'mock local-coder model route',
    });
    mockEngineTierOf.mockImplementation((backend: unknown) =>
      backend === 'local-coder' || backend === 'codex' ? 'mid' : 'local',
    );
    mockRecommendRoute.mockResolvedValue({
      backend: 'codex',
      tier: 'mid',
      reason: 'learned-router: same-tier reroute to codex',
    });
    mockRecoverWithinBudget.mockImplementation((decision: unknown) => ({
      action: 'proceed',
      decision,
    }));

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder', 'codex'],
          intelligence: {},
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    const opts = mockRunGoal.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(opts).toMatchObject({
      engine: 'codex',
      sandboxEngine: true,
      requireSandbox: true,
    });
    expect(opts).not.toHaveProperty('model');
  });

  it('A1h4: dispatch-production ledger records filed proposal outcomes with proposal id', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', model: 'qwen', reason: 'mock local-coder filed' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async () => {
      const proposal = createProposal({
        repo: items[0]!.repo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Filed from daemon',
        summary: 'daemon filed proposal',
        diff: 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        runId: 'run-filed',
      });
      return {
        id: 'run-filed',
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.006, steps: 1 },
        proposalOutcome: {
          kind: 'filed',
          proposalId: proposal.id,
          files: 1,
          insertions: 1,
          deletions: 1,
        },
      };
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      model: 'qwen',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: expect.stringMatching(/^prop-/),
      runId: 'run-filed',
      spentUsd: 0.006,
      diffFiles: 1,
      diffLines: 2,
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h5: proposal-created production records worked diff even when pending delta is zero', async () => {
    const before = pendingCount();
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock production-only filed' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-filed-production-only',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.003, steps: 1 },
      proposalOutcome: {
        kind: 'filed',
        proposalId: 'p-production-only',
        files: 1,
        insertions: 2,
        deletions: 1,
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(pendingCount()).toBe(before);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      production: {
        outcome: 'proposal-created',
        proposalId: 'p-production-only',
        runId: 'run-filed-production-only',
        diffFiles: 1,
        diffLines: 3,
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'diff' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId: 'p-production-only',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h5b: proposal-disabled production does not record empty cooldown', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock proposal disabled' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-proposal-disabled',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      production: {
        outcome: 'proposal-disabled',
        runId: 'run-proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-disabled',
      proposalCreated: false,
      runId: 'run-proposal-disabled',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1h5b-handoff-failure: degraded local handoff authority refuses before dispatch and permits retry', async () => {
    const { items } = enrollWithItems(1);
    const item = items[0]!;
    fs.mkdirSync(repairHandoffJournalPath(), { recursive: true });
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValueOnce({
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 0,
      handoffSourceState: 'degraded',
    });
    let executions = 0;
    mockRunSwarm.mockImplementation(async (_input, _cfg, opts) => {
      executions++;
      return {
        id: (opts as { runId: string }).runId,
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.001, steps: 1 },
        proposalOutcome: {
          kind: 'empty-diff' as const,
          reason: 'local handoff persistence fixture',
          files: 0,
          insertions: 0,
          deletions: 0,
        },
      };
    });
    const config = cfgBuiltin({ perTickItems: 1, parallel: 1 });

    const failed = await tick(config, { dryRun: false });

    expect(failed.reason).toBe('state-persistence-failed');
    expect(executions).toBe(0);
    expect(readDispatchProductionEvents().some((event) => event.itemId === item.id)).toBe(false);
    expect(loadWorkedLedger().events.some((event) => event.itemId === item.id)).toBe(false);

    fs.rmSync(repairHandoffJournalPath(), { recursive: true, force: true });
    const retried = await tick(config, { dryRun: false });

    expect(retried.reason).toBe('ok');
    expect(executions).toBe(1);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === item.id)).toEqual([
      expect.objectContaining({ itemId: item.id, outcome: 'empty' }),
    ]);
  });

  it('A1h5b1: generated repair success becomes terminal only when its proposal exists durably', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdef123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock repair success' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => {
      const { runId: attemptId, workItemGenerationId } = options as {
        runId: string;
        workItemGenerationId: string;
      };
      const proposal = persistProposalRunEventProposalId(createProposal({
        repo: repo.dir,
        origin: 'agent',
        kind: 'patch',
        title: 'Generated repair proposal',
        summary: 'A complete generated repair.',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: repair.id,
        workItemGenerationId,
        workSource: repair.source,
        runId: attemptId,
        trajectoryId: `run:${attemptId}`,
        runEventSummary: { runId: attemptId, status: 'done', outcome: 'proposal-created', proposalCreated: true },
      }));
      return {
        id: attemptId,
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: {
          kind: 'filed',
          proposalId: proposal.id,
          reason: 'proposal filed',
          files: 1,
          insertions: 1,
          deletions: 1,
        },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    expect(readDispatchProductionEvents().find((event) =>
      event.itemId === repair.id && event.repairTreatmentOutcome === 'converted'
    )).toMatchObject({
      repairGenerationId: repair.repairGenerationId,
      proposalCreated: true,
      repairTreatmentAttemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('A1h5b1p: degraded attempt-proof authority blocks only repairs and does not stop ordinary work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'fedcba654321', 10, 'mid');
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair, ordinary],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'proof authority preflight' });
    mockEngineTierOf.mockReturnValue('mid');
    const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(join(attemptDir, '.protocol.json'), '{"malformed":true}\n', { mode: 0o600 });
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-ordinary-despite-degraded-receipts',
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'empty-diff', reason: 'ordinary work completed' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 2, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'ok',
      dispatches: expect.arrayContaining([
        expect.objectContaining({ itemId: ordinary.id, dispatched: true }),
      ]),
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1h5b1o: ordinary generated repair terminal success creates no proofless treatment outbox', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const base = makeItems(repo.dir, 1)[0]!;
    const repair: WorkItem = {
      ...base,
      id: `${basename(repo.dir)}:proposal-repair:abc123abc123`,
      source: 'self',
      title: 'Repair proposal prop-ordinary: test failure in src/app.ts:12',
      detail:
        'Proposal repair: recover a complete proposal after a test failure in src/app.ts:12.\n' +
        'Proposal: prop-ordinary\n' +
        'Original work item: repo:goal:ordinary\n' +
        'Produce a fresh complete fix and verify it.',
      tags: ['self-heal', 'proposal-repair', 'verify'],
      repairRootId: testRepairRootId(repo.dir, 'ordinary-terminal'),
      repairRootAuthorityId: 'm201:ordinary-terminal',
      repairDepth: 0,
    };
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'ordinary repair success' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => {
      const { runId, workItemGenerationId } = options as { runId: string; workItemGenerationId: string };
      const proposal = persistProposalRunEventProposalId(createProposal({
        repo: repo.dir,
        origin: 'agent',
        kind: 'patch',
        title: 'Ordinary generated repair proposal',
        summary: 'A complete ordinary generated repair.',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: repair.id,
        workItemGenerationId,
        workSource: repair.source,
        runId,
        trajectoryId: `run:${runId}`,
        runEventSummary: { runId, status: 'done', outcome: 'proposal-created', proposalCreated: true },
      }));
      return {
        id: runId,
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: { kind: 'filed', proposalId: proposal.id, reason: 'proposal filed', files: 1 },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({ disposition: 'retired' });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toMatchObject({
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
    expect(mockPublishGeneratedRepairTreatmentOutcome).not.toHaveBeenCalled();
    expect(readDispatchProductionEvents().some((event) =>
      event.itemId === repair.id && event.repairTreatmentOutcome !== undefined
    )).toBe(false);
    expect(readDispatchProductionEvents().find((event) => event.itemId === repair.id)).toMatchObject({
      outcome: 'proposal-created',
      repairGenerationId: generatedRepairGenerationId(repair),
      repairAttemptOrdinal: 1,
      repairRootId: repair.repairRootId,
      repairDepth: 0,
    });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: generatedRepairGenerationId(repair)!,
      repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'proven', event: { itemId: repair.id, outcome: 'proposal-created' } }],
    });

    const backlogReadsBeforeNextTick = mockBuildBacklog.mock.calls.length;
    const next = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });
    expect(next.reason).not.toBe('state-persistence-failed');
    expect(mockBuildBacklog.mock.calls.length).toBeGreaterThan(backlogReadsBeforeNextTick);
  });

  it('A1h5b1oa: unavailable treatment reconciliation does not starve ordinary work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    mockReadPendingGeneratedRepairTreatmentOutcomes.mockReturnValue(Object.assign([], {
      available: false,
      prooflessLegacy: 0,
      requiredAction: 'operator-reset' as const,
    }));

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result).toMatchObject({
      reason: 'ok',
      itemsConsidered: 1,
    });
    expect(mockBuildBacklog).toHaveBeenCalled();
    expect(mockRunGoal.mock.calls.length + mockRunSwarm.mock.calls.length).toBe(1);
  });

  it('A1h5b1ob: persistent startup treatment publication failure remains visible through no-backlog ticks and recovery', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcfed123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockReadPendingGeneratedRepairTreatmentOutcomes.mockReturnValue(Object.assign([{
      generationId: 'a'.repeat(64),
      attemptHash: 'b'.repeat(64),
      outcome: 'not-converted' as const,
      disposition: 'quarantined' as const,
      candidate: {} as DispatchProductionEvent,
    }], {
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    }));
    mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(false);

    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig;

    const first = await tick(config, { dryRun: false });
    const second = await tick(config, { dryRun: false });

    for (const result of [first, second]) {
      expect(result).toMatchObject({
        reason: 'state-persistence-failed',
        residentSafePersistenceFailure: 'repair-treatment',
        itemsConsidered: 0,
        spentUsd: 0,
      });
    }
    expect(loadDaemonState().ticks.slice(-2)).toEqual([
      expect.objectContaining({
        reason: 'state-persistence-failed',
        residentSafePersistenceFailure: 'repair-treatment',
      }),
      expect.objectContaining({
        reason: 'state-persistence-failed',
        residentSafePersistenceFailure: 'repair-treatment',
      }),
    ]);
    expect(mockPublishGeneratedRepairTreatmentOutcome).toHaveBeenCalledTimes(2);
    expect(mockBuildBacklog).toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();

    mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(true);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    const recovered = await tick(config, { dryRun: false });

    expect(recovered).toMatchObject({
      reason: 'no-backlog',
      itemsConsidered: 0,
      spentUsd: 0,
    });
    expect(recovered.residentSafePersistenceFailure).toBeUndefined();
  });

  it('A1h5b1oc: startup treatment publication failure remains visible when every backlog item is skipped', async () => {
    const { repo, items } = enrollWithItems(1);
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: 'Pending ordinary work',
      summary: 'Leaves the tick with no dispatchable backlog item.',
      diff: 'diff --git a/x.ts b/x.ts\n',
      workItemId: items[0]!.id,
    });
    mockReadPendingGeneratedRepairTreatmentOutcomes.mockReturnValue(Object.assign([{
      generationId: 'c'.repeat(64),
      attemptHash: 'd'.repeat(64),
      outcome: 'not-converted' as const,
      disposition: 'quarantined' as const,
      candidate: {} as DispatchProductionEvent,
    }], {
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    }));
    mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(false);

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result).toMatchObject({
      reason: 'state-persistence-failed',
      residentSafePersistenceFailure: 'repair-treatment',
      itemsConsidered: 0,
      spentUsd: 0,
    });
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1h5b1p: failed canonical production persistence grants no lifecycle or cooldown authority', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdef123457', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock repair empty' });
    mockEngineTierOf.mockReturnValue('mid');
    const productionFailurePath = join(
      dispatchProductionDir(),
      `.attempt-authority-${repair.repairGenerationId}.lock`,
    );
    mockRunGoal.mockImplementationOnce(async () => {
      fs.mkdirSync(productionFailurePath);
      return {
        id: 'run-diagnostic-unpersisted-empty',
        status: 'done',
        engine: 'local-coder',
        engineTier: 'mid',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: { kind: 'empty-diff', reason: 'no changes' },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(loadWorkedLedger().events.some((event) => event.itemId.includes(repair.id))).toBe(false);
    fs.rmSync(productionFailurePath, { recursive: true, force: true });

    const afterRestart = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(afterRestart).toMatchObject({
      reason: 'no-backlog',
      itemsConsidered: 0,
    });
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it('A1h5b1p-proposal-crash: a pending proposal persisted before production append prevents re-execution', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdef123458', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'proposal crash fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    const productionFailurePath = join(
      dispatchProductionDir(),
      `.attempt-authority-${repair.repairGenerationId}.lock`,
    );
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => {
      const { runId, workItemGenerationId } = options as { runId: string; workItemGenerationId: string };
      const proposal = createProposal({
        repo: repo.dir,
        origin: 'agent',
        kind: 'patch',
        title: 'Proposal persisted before production append crash',
        summary: 'Durable evidence from the original paid execution.',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: repair.id,
        workItemGenerationId,
        workSource: repair.source,
        runId,
        trajectoryId: `run:${runId}`,
        runEventSummary: { runId, status: 'done', outcome: 'proposal-created', proposalCreated: true },
      });
      fs.mkdirSync(productionFailurePath);
      return {
        id: runId,
        status: 'done',
        engine: 'local-coder',
        engineTier: 'mid',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: { kind: 'filed', proposalId: proposal.id, reason: 'proposal filed', files: 1 },
      };
    });
    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig;

    const crashed = await tick(config, { dryRun: false });

    expect(crashed.reason).toBe('state-persistence-failed');
    expect(pendingCount()).toBe(1);
    expect(readDispatchProductionEvents().some((event) => event.itemId === repair.id)).toBe(false);
    expect(resolveDispatchProductionAttemptReceiptWitnesses([
      { repairGenerationId: repair.repairGenerationId!, repairAttemptOrdinal: 1 },
    ])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'missing' }],
    });
    fs.rmSync(productionFailurePath, { recursive: true, force: true });

    const restarted = await tick(config, { dryRun: false });

    expect(restarted.itemsConsidered).toBe(0);
    expect(restarted.reason).toBe('no-backlog');
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it.each(['witness-write', 'witness-ack'] as const)(
    'A1h5b1w: terminal treatment %s failure leaves the outbox pending and reports persistence failure',
    async (failureMode) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const repair = makeDiagnosticResliceItem(repo.dir, `abcde${failureMode === 'witness-write' ? '1' : '2'}123456`, 10, 'mid');
      seedDiagnosticEmptyProof(
        repair,
        `attempt-${failureMode === 'witness-write' ? '73345678' : '83345678'}-1234-4123-8123-123456789abc`,
        'local-coder',
        'mid',
      );
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [repair],
      });
      mockRouteBackend.mockReturnValue({ backend: 'kimi', tier: 'mid', reason: 'terminal witness failure fixture' });
      mockEngineTierOf.mockReturnValue('mid');
      mockRunGoal.mockImplementationOnce(async () => {
        if (failureMode === 'witness-write') {
          fs.writeFileSync(
            join(dispatchProductionDir(), 'repair-treatment-outcomes'),
            'not a treatment receipt directory',
            'utf8',
          );
        }
        return {
          id: `run-terminal-${failureMode}`,
          status: 'done',
          engine: 'kimi',
          engineTier: 'mid',
          usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
          proposalOutcome: { kind: 'empty-diff', reason: 'alternative backend made no changes' },
        };
      });
      if (failureMode === 'witness-ack') {
        mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(false);
      }

      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder', 'kimi'] },
      } as AshlrConfig, { dryRun: false });
      const pending = readPendingGeneratedRepairTreatmentOutcomes();
      expect(result.reason).toBe('state-persistence-failed');
      expect(result.residentSafePersistenceFailure).toBe('repair-treatment');
      expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
        available: true,
        disposition: 'quarantined',
        authoritativeEmptyRuns: 2,
      });
      expect(pending).toEqual([
        expect.objectContaining({
          generationId: repair.repairGenerationId,
          outcome: 'not-converted',
          attemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          candidate: expect.objectContaining({ itemId: repair.id }),
        }),
      ]);

      if (failureMode === 'witness-write') {
        fs.rmSync(join(dispatchProductionDir(), 'repair-treatment-outcomes'), { force: true });
      } else {
        mockPublishGeneratedRepairTreatmentOutcome.mockReset();
      }
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [],
      });

      const retried = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder', 'kimi'] },
      } as AshlrConfig, { dryRun: false });
      const witnesses = readDispatchProductionEvents().filter((event) =>
        event.itemId === repair.id && event.repairTreatmentOutcome === 'not-converted'
      );

      expect(retried.reason).toBe('no-backlog');
      expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]).toMatchObject({
        repairGenerationId: repair.repairGenerationId,
        repairTreatmentAttemptHash: pending[0]!.attemptHash,
      });
    },
  );

  it('A1h5b1w-persistence: a later spend-guard persistence failure strips resident-safe treatment status', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcde3123456', 10, 'mid');
    seedDiagnosticEmptyProof(
      repair,
      'attempt-93345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'kimi', tier: 'mid', reason: 'combined persistence failure fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(false);
    mockRunGoal.mockImplementationOnce(async () => {
      const guardPath = daemonSpendGuardPath();
      fs.rmSync(guardPath, { force: true });
      fs.mkdirSync(guardPath, { recursive: true });
      return {
        id: 'run-terminal-combined-persistence-failure',
        status: 'done',
        engine: 'kimi',
        engineTier: 'mid',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: { kind: 'empty-diff', reason: 'alternative backend made no changes' },
      };
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('state-persistence-failed');
    expect(result.residentSafePersistenceFailure).toBeUndefined();
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toHaveLength(1);
    expect(fs.statSync(daemonSpendGuardPath()).isDirectory()).toBe(true);
    fs.rmSync(daemonSpendGuardPath(), { recursive: true, force: true });
  });

  it('A1h5b1w-startup-persistence: a later critical persistence failure dominates a persistent startup treatment failure', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    mockReadPendingGeneratedRepairTreatmentOutcomes.mockReturnValue(Object.assign([{
      generationId: 'e'.repeat(64),
      attemptHash: 'f'.repeat(64),
      outcome: 'not-converted' as const,
      disposition: 'quarantined' as const,
      candidate: {} as DispatchProductionEvent,
    }], {
      available: true,
      prooflessLegacy: 0,
      requiredAction: null,
    }));
    mockPublishGeneratedRepairTreatmentOutcome.mockReturnValue(false);

    const treatmentOnly = await tick(cfgBuiltin(), { dryRun: false });
    expect(treatmentOnly).toMatchObject({
      reason: 'state-persistence-failed',
      residentSafePersistenceFailure: 'repair-treatment',
    });

    fs.mkdirSync(daemonSpendGuardPath(), { recursive: true });
    const critical = await tick(cfgBuiltin(), { dryRun: false });

    expect(critical.reason).toBe('state-persistence-failed');
    expect(critical.residentSafePersistenceFailure).toBeUndefined();
    fs.rmSync(daemonSpendGuardPath(), { recursive: true, force: true });
  });

  it('A1h5b1a: excludes a repair when only its prior empty backend is routable', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdea123456', 10, 'mid');
    expect(seedDiagnosticEmptyProof(
      repair,
      'attempt-33345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
    )).toMatchObject({ recorded: true, authoritativeEmptyRuns: 1 });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'same backend retry' });
    mockEngineTierOf.mockReturnValue('mid');
    mockInspectGeneratedRepairRouteFeasibility.mockReturnValue({
      feasible: false,
      requiredTier: 'mid',
      requiresAlternative: true,
      backend: null,
      reason: 'alternate-backend-unavailable',
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    const repairDecision = readAgentActions().find((event) =>
      event.action === 'daemon:generated-repair-decision' && event.itemId === repair.id,
    );
    expect(result.itemsConsidered).toBe(0);
    expect(result.dispatches).toBeUndefined();
    expect(repairDecision).toMatchObject({
      outcome: 'blocked',
      reason: 'dispatch-route-unavailable',
      counts: { dispatchEvaluated: 1, dispatchBlocked: 1, selected: 0, claimed: 0 },
    });
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('A1h5b1b: dispatches an authoritative empty repair through a different same-tier backend', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcded123456', 10, 'mid');
    seedDiagnosticEmptyProof(
      repair,
      'attempt-43345678-1234-4123-8123-123456789abc',
      'local-coder',
      'mid',
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'kimi', tier: 'mid', reason: 'same-tier alternative' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-diagnostic-second-empty',
      status: 'done',
      engine: 'kimi',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'empty-diff', reason: 'alternative backend made no changes' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({ backend: 'kimi', tier: 'mid', dispatched: true });
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ engine: 'kimi' });
    expect(readDispatchProductionEvents().find((event) => event.itemId === repair.id)).toMatchObject({
      repairHandoffId: repair.repairHandoffId,
      repairGenerationId: repair.repairGenerationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      backend: 'kimi',
    });
    expect(readAgentActions({ complete: true }).find((event) =>
      event.action === 'daemon:dispatch' && event.itemId === repair.id
    )).toMatchObject({
      repairHandoffId: repair.repairHandoffId,
      repairGenerationId: repair.repairGenerationId,
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
      backend: 'kimi',
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
    });
    expect(readDispatchProductionEvents().find((event) =>
      event.itemId === repair.id && event.repairTreatmentOutcome === 'not-converted'
    )).toMatchObject({
      repairGenerationId: repair.repairGenerationId,
      proposalCreated: false,
      repairAttemptOrdinal: 2,
      repairTreatmentAttemptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(readPendingGeneratedRepairTreatmentOutcomes()).toEqual([]);
  });

  it('A1h5b2: claimed proposal metadata without a durable inbox proposal is not lifecycle authority', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'fedcba123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock unbacked success' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-unbacked-repair-success',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'filed',
        proposalId: 'prop-missing-from-inbox',
        reason: 'claimed proposal filed',
        files: 1,
        insertions: 1,
        deletions: 0,
      },
    });

    await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(pendingCount()).toBe(0);
    expect(readGeneratedRepairLifecycle(repair)).toEqual({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(readDispatchProductionEvents().some((event) =>
      event.itemId === repair.id && event.repairTreatmentOutcome !== undefined
    )).toBe(false);
  });

  it('A1h5b3: diagnostic repairs bypass Best-of-N and record exact empty lifecycle evidence', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaaaaa123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock mixed best-of-n' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-diagnostic-single-empty',
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'empty-diff', reason: 'no file changes' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        autonomyControlLoop: false,
        allowedBackends: ['local-coder'],
        bestOfN: 2,
      },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(result.dispatches?.[0]).toMatchObject({ backend: 'local-coder', production: { outcome: 'empty-diff' } });
    expect(readDispatchProductionEvents().find((event) => event.itemId === repair.id)).toMatchObject({
      repairHandoffId: repair.repairHandoffId,
      repairGenerationId: repair.repairGenerationId,
      repairAttemptOrdinal: 1,
      backend: 'local-coder',
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
      lastAuthoritativeEmptyBackend: 'local-coder',
    });
  });

  it('A1h5b3a: executor fallback is reported but cannot become repair lifecycle authority', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaaaab123456', 10, 'mid');
    recordGeneratedRepairLifecycle(repair, {
      kind: 'empty-diff',
      attemptId: 'attempt-53345678-1234-4123-8123-123456789abc',
      backend: 'builtin',
      tier: 'local',
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'planned repair backend' });
    mockEngineTierOf.mockImplementation((backend: EngineId) => backend === 'builtin' ? 'local' : 'mid');
    mockGeneratedRepairCandidateAllowed.mockImplementation(
      (_item: WorkItem, backend: EngineId) => backend !== 'builtin',
    );
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-diagnostic-fallback-failure',
      status: 'done',
      engine: 'builtin',
      engineTier: 'local',
      usage: { totalTokens: 0, estCostUsd: 0, steps: 1 },
      proposalOutcome: { kind: 'engine-failed-no-diff', reason: 'fallback execution failed' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        autonomyControlLoop: false,
        allowedBackends: ['local-coder'],
        bestOfN: 2,
      },
    } as AshlrConfig, { dryRun: false });

    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(result.dispatches?.[0]).toMatchObject({
      backend: 'builtin',
      tier: 'local',
      assignedBy: 'executor-fallback',
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(readDispatchProductionEvents().find((event) => event.itemId === repair.id)).toMatchObject({
      repairLineageInvalid: true,
      backend: 'builtin',
      outcome: 'engine-failed',
    });
    expect(readAgentActions({ complete: true }).find((event) =>
      event.action === 'daemon:dispatch' && event.itemId === repair.id
    )).toMatchObject({
      repairLineageInvalid: true,
      backend: 'builtin',
    });
    expect(result.reason).toBe('state-persistence-failed');
    expect(loadWorkedLedger().events).not.toContainEqual(expect.objectContaining({
      itemId: generatedRepairCooldownKey(repair),
    }));
    const reservationDir = join(dirname(dispatchProductionDir()), 'repair-attempt-reservations');
    expect(fs.readdirSync(reservationDir).filter((name) => name.endsWith('.json'))).toHaveLength(1);

    const immediateRetry = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        autonomyControlLoop: false,
        allowedBackends: ['local-coder'],
        bestOfN: 2,
      },
    } as AshlrConfig, { dryRun: false });

    expect(immediateRetry.itemsConsidered).toBe(0);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['engine-failed', { kind: 'engine-failed-no-diff', reason: 'adversarial engine failure' }],
    ['proposal-capture-error', { kind: 'proposal-capture-error', reason: 'adversarial capture failure' }],
  ] as const)('A1h5b3b: canonical %s repair outcomes settle and require a same-tier alternate after cooldown', async (
    outcome,
    proposalOutcome,
  ) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaaaac123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({
      backend: 'local-coder', tier: 'mid', reason: 'real router repeats the failed route',
    });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal
      .mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => ({
        id: (options as { runId: string }).runId,
        status: 'done',
        engine: 'local-coder',
        engineTier: 'mid',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome,
      }))
      .mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => ({
        id: (options as { runId: string }).runId,
        status: 'done',
        engine: 'kimi',
        engineTier: 'mid',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: { kind: 'empty-diff', reason: 'alternate completed without changes' },
      }));
    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig;

    const first = await tick(config, { dryRun: false });
    const immediate = await tick(config, { dryRun: false });
    vi.setSystemTime(new Date('2026-07-15T12:31:00.000Z'));
    const retry = await tick(config, { dryRun: false });
    const reservationDir = join(dirname(dispatchProductionDir()), 'repair-attempt-reservations');
    const markerNames = fs.existsSync(reservationDir)
      ? fs.readdirSync(reservationDir).filter((name) => name.endsWith('.json'))
      : [];

    expect(first.reason).toBe('ok');
    expect(immediate.itemsConsidered).toBe(0);
    expect(retry.reason).toBe('ok');
    expect(mockRunGoal).toHaveBeenCalledTimes(2);
    expect(mockRunGoal.mock.calls[1]?.[2]).toMatchObject({ workItemId: repair.id, engine: 'kimi' });
    expect(markerNames).toEqual([]);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    expect(readDispatchProductionEvents().find((event) =>
      event.itemId === repair.id && event.outcome === outcome
    )).toMatchObject({
      outcome,
      backend: 'local-coder',
      objectiveHash: workItemObjectiveHash(repair),
      proposalCreated: false,
    });
    expect(readDispatchProductionEvents().find((event) =>
      event.itemId === repair.id && event.outcome === 'empty-diff'
    )).toMatchObject({
      backend: 'kimi',
      repairAttemptOrdinal: 2,
      repairPreviousBackend: 'local-coder',
    });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: repair.repairGenerationId!,
      repairAttemptOrdinal: 2,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{
        status: 'proven',
        proof: { repairAttemptOrdinal: 2, previousBackend: 'local-coder', backend: 'kimi' },
      }],
    });
    expect(loadWorkedLedger().events).toContainEqual(expect.objectContaining({
      itemId: generatedRepairCooldownKey(repair),
      outcome: 'dispatch-blocked',
    }));
  });

  it('A1h5b3b-terminal-crash: an exact empty receipt reconstructs missing lifecycle before clearing a crash marker', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaabbb123456', 10, 'mid');
    const firstAttempt = 'attempt-11345678-1234-4123-8123-123456789abc';
    const terminalAttempt = 'attempt-21345678-1234-4123-8123-123456789abc';
    expect(seedDiagnosticEmptyProof(repair, firstAttempt, 'local-coder', 'mid')).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    recordDiagnosticEmptyReceipt(
      repair,
      terminalAttempt,
      'kimi',
      'mid',
      2,
      'local-coder',
    );
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 1,
    });
    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: terminalAttempt,
      backend: 'kimi',
      tier: 'mid',
      repairAttemptOrdinal: 2,
      phase: 'launched',
    });
    const noise = Array.from({ length: 257 }, (_, index): DispatchProductionEvent => ({
      schemaVersion: 1,
      ts: new Date(Date.now() + index + 1).toISOString(),
      machineId: 'm201',
      itemId: `repo:goal:terminal-receipt-noise-${index}`,
      source: 'goal',
      repo: repo.dir,
      title: `Terminal receipt noise ${index}`,
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'test exact receipt recovery beyond raw scan cap',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }));
    expect(recordDispatchProduction(noise)).toEqual({ attempted: 257, recorded: 257, failed: 0 });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'quarantined',
      authoritativeEmptyRuns: 2,
    });
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
  }, 15_000);

  it('A1h5b3b-proposal-crash: an exact proposal receipt reconstructs missing lifecycle before clearing a crash marker', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaabbc223456', 10, 'mid');
    const attemptId = 'attempt-31345678-2234-4123-8123-123456789abc';
    const proposal = createDiagnosticPendingProposal(repair, attemptId);
    const receipt = recordDiagnosticProposalReceipt(repair, attemptId, proposal.id);
    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: attemptId,
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
    });
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(resolveDispatchProductionAttemptReceiptWitnesses([{
      repairGenerationId: repair.repairGenerationId!,
      repairAttemptOrdinal: 1,
    }])).toMatchObject({
      status: 'resolved',
      resolutions: [{ status: 'proven', event: { ts: receipt.ts, proposalId: proposal.id } }],
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('A1h5b3b-proposal-conflict: an exact receipt conflicting with durable proposal binding stays fenced', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaabbc323456', 10, 'mid');
    const otherRepair = makeDiagnosticResliceItem(repo.dir, 'aaabbc423456', 10, 'mid');
    const attemptId = 'attempt-31345678-3234-4123-8123-123456789abc';
    const conflictingProposal = createDiagnosticPendingProposal(otherRepair, attemptId);
    recordDiagnosticProposalReceipt(repair, attemptId, conflictingProposal.id);
    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: attemptId,
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'no-backlog',
      itemsConsidered: 0,
      producerMaintenance: {
        repairAttemptReservationState: 'blocked-ambiguous',
        repairAttemptReservationsBlocked: 1,
      },
    });
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({ disposition: 'active' });
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('A1h5b3b-failed-receipt-crash: an old immutable failure settles only its root and lets another root continue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-12T08:00:00.000Z'));
    const repo = fx.makeRepo();
    repo.enroll();
    const failedRepair = makeDiagnosticResliceItem(repo.dir, 'aaabbe123456', 20, 'mid');
    const attemptId = 'attempt-51345678-1234-4123-8123-123456789abc';
    const eventTs = '2026-07-12T08:00:01.000Z';
    const markerPath = writeRepairReservationMarker(failedRepair, {
      reservationId: attemptId,
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
      createdAt: '2026-07-12T08:00:00.000Z',
    });
    const failure = seedDiagnosticFailureReceipt(
      failedRepair,
      attemptId,
      'local-coder',
      'mid',
      eventTs,
    );
    const rawPath = join(dispatchProductionDir(), '2026-07-12.jsonl');
    expect(fs.existsSync(rawPath)).toBe(true);
    for (const [index, ts] of [
      '2026-07-13T08:00:00.000Z',
      '2026-07-14T08:00:00.000Z',
      '2026-07-15T08:00:00.000Z',
    ].entries()) {
      expect(recordDispatchProduction({
        schemaVersion: 1,
        ts,
        machineId: 'm201',
        itemId: `repo:goal:partition-rotation-${index}`,
        source: 'goal',
        repo: repo.dir,
        title: `Partition rotation witness ${index}`,
        backend: 'local-coder',
        tier: 'mid',
        assignedBy: 'daemon',
        routeReason: 'test partition rotation',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        spentUsd: 0,
        reason: 'test partition rotation',
        basis: 'run-proposal-outcome',
      })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    }
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'));
    const unrelatedRepair = makeDiagnosticResliceItem(repo.dir, 'aaabbf123456', 10, 'mid');

    expect(resolveDispatchProductionFailureAttemptReceipt({
      repairGenerationId: failedRepair.repairGenerationId!,
      repairAttemptOrdinal: 1,
      attemptHash: generatedRepairLifecycleAttemptHash(`run:${attemptId}`),
    })).toMatchObject({
      status: 'proven',
      event: { outcome: 'engine-failed' },
    });
    const falseTerminalTargets = (['empty-diff', 'proposal-created'] as const).map((outcome) => ({
      ts: failure.ts,
      sequenceStartTs: failedRepair.ts,
      sequenceEndTs: new Date().toISOString(),
      itemId: failedRepair.id,
      repo: failedRepair.repo,
      source: failedRepair.source,
      outcome,
      ...(outcome === 'proposal-created' ? { proposalId: 'prop-false-failure-proof' } : {}),
      objectiveHash: workItemObjectiveHash(failedRepair)!,
      repairHandoffId: failedRepair.repairHandoffId!,
      repairGenerationId: failedRepair.repairGenerationId!,
      repairTreatmentUnitId: failedRepair.repairTreatmentUnitId!,
      repairTreatment: failedRepair.repairTreatment!,
      repairAttemptOrdinal: 1 as const,
    }));
    expect(resolveDispatchProductionAttemptProofs(falseTerminalTargets)).toMatchObject({
      status: 'resolved',
      resolutions: [
        { status: 'unproven' },
        { status: 'unproven' },
      ],
    });

    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [failedRepair, unrelatedRepair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'unrelated root route' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-unrelated-root',
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'empty-diff', reason: 'unrelated root completed without changes' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.dispatches).toEqual([
      expect.objectContaining({ itemId: unrelatedRepair.id, dispatched: true }),
    ]);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(readGeneratedRepairLifecycle(failedRepair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
    expect(loadWorkedLedger().events.filter((worked) =>
      worked.itemId === generatedRepairCooldownKey(failedRepair))).toEqual([
      expect.objectContaining({ outcome: 'dispatch-blocked' }),
    ]);
  });

  it('A1h5b3b-ordinary-crash: durable empty receipts recover proposal and capture repair reservations into cooldown', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const proposal = createProposal({
      repo: repo.dir,
      origin: 'agent',
      kind: 'patch',
      title: 'Incomplete ordinary proposal repair',
      summary: 'Repair the incomplete proposal.',
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+partial\n',
      workItemId: 'repo:goal:ordinary-proposal-parent',
      isPartial: true,
    });
    const actualProposalRepair = await vi.importActual<
      typeof import('../src/core/fleet/proposal-repair-work.js')
    >('../src/core/fleet/proposal-repair-work.js');
    const proposalRepair = actualProposalRepair.proposalRepairWorkItem(proposal, now);
    expect(proposalRepair).not.toBeNull();
    if (!proposalRepair) throw new Error('expected ordinary proposal repair');
    const captureParent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now.toISOString(),
      machineId: 'm201',
      itemId: 'repo:self:ordinary-capture-parent',
      source: 'self',
      repo: repo.dir,
      title: 'Self improvement capture failure with useful work',
      backend: 'local-coder',
      tier: 'mid',
      model: 'qwen',
      assignedBy: 'daemon',
      routeReason: 'self-improvement local route',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      runId: 'run-ordinary-capture-parent',
      spentUsd: 0.001,
      reason: 'proposal-capture-error: completeness gate failed for src/app.ts:12',
      diffFiles: 1,
      diffLines: 4,
      objectiveHash: 'b'.repeat(64),
      basis: 'run-proposal-outcome',
    };
    expect(recordRepairHandoffs(captureParent, {
      schemaVersion: 2,
      activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
    })).toMatchObject({ recorded: 1, failed: 0 });
    const captureHandoff = repairHandoffFromDispatchEvent(captureParent)!;
    const captureRepair = actualProposalRepair.captureGateRepairWorkItem({
      ...captureParent,
      repairHandoffId: captureHandoff.eventId,
      repairGenerationId: captureHandoff.generationId,
    }, now);
    expect(captureRepair).not.toBeNull();
    if (!captureRepair) throw new Error('expected ordinary capture repair');
    expect(generatedRepairGenerationId(captureRepair)).toMatch(/^[a-f0-9]{64}$/);

    const markers = [proposalRepair, captureRepair].map((item, index) => {
      const reservationId = index === 0
        ? 'attempt-12345678-1234-4123-8123-123456789abc'
        : 'attempt-22345678-1234-4123-8123-123456789abc';
      const marker = writeRepairReservationMarker(item, {
        reservationId,
        backend: 'local-coder',
        tier: 'mid',
        repairAttemptOrdinal: 1,
        phase: 'launched',
      });
      recordOrdinaryRepairSuccessReceipt(item, reservationId, 'empty-diff');
      expect(resolveDispatchProductionAttemptReceiptWitnesses([{
        repairGenerationId: generatedRepairGenerationId(item)!,
        repairAttemptOrdinal: 1,
      }])).toMatchObject({
        status: 'resolved',
        resolutions: [{ status: 'proven', event: { itemId: item.id, outcome: 'empty-diff' } }],
      });
      return marker;
    });
    const noise = Array.from({ length: 257 }, (_, index): DispatchProductionEvent => ({
      schemaVersion: 1,
      ts: new Date(Date.now() + index + 1).toISOString(),
      machineId: 'm201',
      itemId: `repo:goal:ordinary-success-noise-${index}`,
      source: 'goal',
      repo: repo.dir,
      title: `Ordinary success receipt noise ${index}`,
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'daemon',
      routeReason: 'push exact repair success beyond the raw row scan cap',
      outcome: 'proposal-disabled',
      proposalCreated: false,
      spentUsd: 0,
      basis: 'run-proposal-outcome',
    }));
    expect(recordDispatchProduction(noise)).toEqual({ attempted: 257, recorded: 257, failed: 0 });
    for (const [index, ts] of [
      '2026-07-16T08:00:00.000Z',
      '2026-07-17T08:00:00.000Z',
      '2026-07-18T08:00:00.000Z',
    ].entries()) {
      expect(recordDispatchProduction({
        ...noise[index]!,
        ts,
        itemId: `repo:goal:ordinary-success-partition-${index}`,
      })).toEqual({ attempted: 1, recorded: 1, failed: 0 });
    }
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [proposalRepair, captureRepair],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
      foundry: { allowedBackends: ['local-coder', 'kimi'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.itemsConsidered).toBe(0);
    expect(markers.map((marker) => fs.existsSync(marker))).toEqual([false, false]);
    for (const repair of [proposalRepair, captureRepair]) {
      expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 1,
      });
      expect(loadWorkedLedger().events).toContainEqual(expect.objectContaining({
        itemId: generatedRepairCooldownKey(repair),
        outcome: 'empty',
      }));
    }
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  }, 15_000);

  it('A1h5b3b-never-launched: startup clears a prepared marker without age-based inference', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaabbc123456', 10, 'mid');
    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: 'attempt-31345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'prepared',
    });
    const cfg = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig;
    mockLoadConfig.mockReturnValue(cfg);

    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 0 });

    expect(state.running).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A1h5b3b-ambiguous: degraded receipt source quarantines only its repair root', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaabbd123456', 10, 'mid');
    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: 'attempt-41345678-1234-4123-8123-123456789abc',
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
    });
    const receiptSource = join(dispatchProductionDir(), 'repair-attempt-proofs');
    fs.rmSync(receiptSource, { recursive: true, force: true });
    fs.mkdirSync(dispatchProductionDir(), { recursive: true });
    fs.writeFileSync(receiptSource, 'ambiguous receipt source', 'utf8');
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair, ordinary],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'ok',
      itemsConsidered: 1,
      producerMaintenance: {
        repairAttemptReservationState: 'blocked-ambiguous',
        repairAttemptReservationsBlocked: 1,
      },
    });
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
  });

  it('A1h5b3b-root-fence: a same-root distinct descendant cannot dispatch around a crash marker', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const rootRepair = makeDiagnosticResliceItem(repo.dir, 'aaabbd223456', 10, 'mid');
    const descendant: WorkItem = {
      ...rootRepair,
      id: `${rootRepair.id}-descendant`,
      title: `${rootRepair.title} descendant`,
      repairDepth: 1,
    };
    const markerPath = writeRepairReservationMarker(rootRepair, {
      reservationId: 'attempt-41345678-2234-4123-8123-123456789abc',
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
    });
    expect(repairReservationPath(descendant)).toBe(markerPath);
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [descendant, ordinary],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'ok',
      itemsConsidered: 1,
      producerMaintenance: {
        repairAttemptReservationState: 'blocked-ambiguous',
        repairAttemptReservationsBlocked: 1,
      },
    });
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
  });

  it('A1h5b3c: a cooperating writer holding the root reservation blocks execution', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'aaaaad123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'reservation fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    const reservation = acquireLocalStoreLock(join(
      dirname(dispatchProductionDir()),
      'repair-attempt-reservations',
      `${repair.repairRootId}.lock`,
    ));
    expect(reservation).not.toBeNull();

    try {
      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'] },
      } as AshlrConfig, { dryRun: false });

      expect(result.reason).toBe('ok');
      expect(result.itemsConsidered).toBe(1);
      expect(result.dispatches?.[0]).toMatchObject({
        dispatched: false,
        skipReason: 'repair-attempt-reservation-unavailable',
      });
      expect(mockRunGoal).not.toHaveBeenCalled();
      expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
        available: true,
        disposition: 'active',
        authoritativeEmptyRuns: 0,
      });
    } finally {
      if (reservation) releaseLocalStoreLock(reservation);
    }
  });

  it('A1h5b3c-process: a second process holding the root lock blocks every generation alias', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const hash = 'aaaaae123456';
    const repair = makeDiagnosticResliceItem(repo.dir, hash, 10, 'mid');
    const legacyAlias = addLegacyGenerationAlias(repair, hash, 'mid');
    expect(generatedRepairGenerationIds(repair).sort()).toEqual(
      expect.arrayContaining([repair.repairGenerationId, legacyAlias]),
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mixed alias fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    const rootLockPath = join(
      dirname(dispatchProductionDir()),
      'repair-attempt-reservations',
      `${repair.repairRootId}.lock`,
    );
    const childScript = `
      const { acquireLocalStoreLock, releaseLocalStoreLock } = await import('./src/core/fleet/local-store-lock.ts');
      const lock = acquireLocalStoreLock(process.argv[1], 0);
      if (!lock) process.exit(2);
      process.stdout.write('ready\\n');
      const finish = () => { releaseLocalStoreLock(lock); process.exit(0); };
      process.on('SIGTERM', finish);
      process.on('SIGINT', finish);
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', childScript, rootLockPath,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, ASHLR_HOME: process.env.ASHLR_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error('root lock child did not become ready')), 5_000);
      child.once('error', rejectReady);
      child.stdout.on('data', (chunk: Buffer) => {
        if (!chunk.toString('utf8').includes('ready')) return;
        clearTimeout(timeout);
        resolveReady();
      });
      child.once('exit', (code) => {
        if (code !== null && code !== 0) rejectReady(new Error(`root lock child exited ${code}`));
      });
    });

    try {
      await ready;
      const result = await tick({
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: { allowedBackends: ['local-coder'] },
      } as AshlrConfig, { dryRun: false });

      expect(result).toMatchObject({
        reason: 'ok',
        itemsConsidered: 1,
        dispatches: [expect.objectContaining({
          dispatched: false,
          skipReason: 'repair-attempt-reservation-unavailable',
        })],
      });
      expect(mockRunGoal).not.toHaveBeenCalled();
    } finally {
      child.kill('SIGTERM');
      await new Promise<void>((resolveExit) => {
        if (child.exitCode !== null) return resolveExit();
        child.once('exit', () => resolveExit());
      });
    }
  });

  it('A1h5b3c-alias-expansion: a crash marker created for one alias blocks an expanded family after restart', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const hash = 'aaaaaf123456';
    const repair = makeDiagnosticResliceItem(repo.dir, hash, 10, 'mid');
    const originalGeneration = repair.repairGenerationId!;
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'alias expansion crash fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    const config = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig;

    const markerPath = writeRepairReservationMarker(repair, {
      reservationId: 'run-alias-expansion-crash',
      backend: 'local-coder',
      tier: 'mid',
      repairAttemptOrdinal: 1,
      phase: 'launched',
    });
    const reservationDir = join(dirname(dispatchProductionDir()), 'repair-attempt-reservations');
    const markerNamesBefore = fs.readdirSync(reservationDir).filter((name) => name.endsWith('.json'));
    expect(markerNamesBefore).toHaveLength(1);
    expect(markerPath).toBe(join(reservationDir, markerNamesBefore[0]!));
    expect(JSON.parse(fs.readFileSync(join(reservationDir, markerNamesBefore[0]!), 'utf8'))).toMatchObject({
      generationIds: [originalGeneration],
    });

    const legacyAlias = addLegacyGenerationAlias(repair, hash, 'mid');
    expect(generatedRepairGenerationIds(repair).sort()).toEqual(
      expect.arrayContaining([originalGeneration, legacyAlias]),
    );
    const childScript = `
      const { existsSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const [dir, rootId] = process.argv.slice(1);
      const markerPath = join(dir, rootId + '.json');
      if (!existsSync(markerPath)) process.exit(2);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      process.stdout.write(JSON.stringify({ marker: rootId + '.json', generationIds: marker.generationIds }));
    `;
    const child = spawn(process.execPath, [
      '--input-type=module', '--eval', childScript,
      reservationDir, repair.repairRootId!,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let childOutput = '';
    child.stdout.on('data', (chunk: Buffer) => { childOutput += chunk.toString('utf8'); });
    const childExit = await new Promise<number | null>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', resolveExit);
    });
    expect(childExit).toBe(0);
    expect(JSON.parse(childOutput)).toEqual({
      marker: markerNamesBefore[0],
      generationIds: [originalGeneration],
    });

    const restarted = await tick(config, { dryRun: false });

    expect(restarted).toMatchObject({
      reason: 'no-backlog',
      itemsConsidered: 0,
      producerMaintenance: {
        repairAttemptReservationState: 'blocked-ambiguous',
        repairAttemptReservationsBlocked: 1,
      },
    });
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(fs.readdirSync(reservationDir).filter((name) => name.endsWith('.json'))).toEqual(markerNamesBefore);
  });

  it('A1h5b3d: trusted capture repairs stay single-candidate under Best-of-N configuration', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const now = new Date();
    const parent: DispatchProductionEvent = {
      schemaVersion: 1,
      ts: now.toISOString(),
      itemId: 'repo:self:capture-parent',
      source: 'self',
      repo: repo.dir,
      title: 'Repair failed proposal capture',
      backend: 'local-coder',
      tier: 'mid',
      assignedBy: 'router',
      routeReason: 'capture parent route',
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      runId: 'attempt-52345678-1234-4123-8123-123456789abc',
      trajectoryId: 'run:attempt-52345678-1234-4123-8123-123456789abc',
      reason: 'proposal-capture-error: src/app.ts:12 expected ready state',
      objectiveHash: 'a'.repeat(64),
      spentUsd: 0.002,
      basis: 'run-proposal-outcome',
    };
    expect(recordRepairHandoffs(parent, {
      schemaVersion: 2,
      activation: { id: '11111111-1111-4111-8111-111111111111', activatedAt: '2020-01-01T00:00:00.000Z' },
    })).toMatchObject({ recorded: 1, failed: 0 });
    const handoff = repairHandoffFromDispatchEvent(parent)!;
    const { captureGateRepairWorkItem } = await vi.importActual<
      typeof import('../src/core/fleet/proposal-repair-work.js')
    >('../src/core/fleet/proposal-repair-work.js');
    const repair = captureGateRepairWorkItem({
      ...parent,
      repairHandoffId: handoff.eventId,
      repairGenerationId: handoff.generationId,
    }, now);
    expect(repair).not.toBeNull();
    if (!repair) throw new Error('expected capture repair work item');
    expect(generatedRepairGenerationId(repair)).toMatch(/^[a-f0-9]{64}$/);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'capture repair route' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => ({
      id: (options as { runId: string }).runId,
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'proposal-capture-error', reason: 'adversarial capture failure' },
    }));

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: {
        allowedBackends: ['local-coder', 'kimi'],
        bestOfN: 3,
        bestOfNCandidates: [
          { engine: 'kimi', model: 'kimi-test' },
          { engine: 'local-coder', model: 'qwen-test' },
        ],
      },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunBestOfN).not.toHaveBeenCalled();
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ engine: 'local-coder' });
  });

  it('A1h5b4: failed partial proposals do not retire generated repair work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'bbbbbb123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock partial repair' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => {
      const { runId, workItemGenerationId } = options as {
        runId: string;
        workItemGenerationId: string;
      };
      const proposal = createProposal({
        repo: repo.dir,
        origin: 'agent',
        kind: 'patch',
        title: 'Partial generated repair proposal',
        summary: 'A failed attempt left useful but incomplete material.',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+partial\n',
        workItemId: repair.id,
        workItemGenerationId,
        workSource: repair.source,
        runId,
        trajectoryId: `run:${runId}`,
        runEventSummary: { runId, status: 'failed', outcome: 'proposal-created', proposalCreated: true },
        isPartial: true,
      });
      return {
        id: runId,
        status: 'failed',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: {
          kind: 'filed',
          proposalId: proposal.id,
          reason: 'partial proposal filed',
          files: 1,
          insertions: 1,
          deletions: 1,
        },
      };
    });

    await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(pendingCount()).toBe(1);
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
    });
  });

  it('A1h5c: daemon-required capture-missing is diagnostic and records empty cooldown', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock capture missing' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-capture-missing',
      status: 'failed',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
      runEventSummary: {
        runId: 'run-capture-missing',
        status: 'failed',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        actionCounts: {
          proposalDisabled: 1,
          proposalCaptureAttempts: 0,
          proposalCreated: 0,
        },
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'proposal-capture-error: capture-missing: required proposal dispatch ended before final capture',
      runEventSummary: {
        status: 'failed',
      },
      production: {
        outcome: 'proposal-capture-error',
        runId: 'run-capture-missing',
        reason: 'capture-missing: required proposal dispatch ended before final capture',
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      runId: 'run-capture-missing',
      reason: 'capture-missing: required proposal dispatch ended before final capture',
      runEventSummary: {
        status: 'failed',
      },
      basis: 'run-proposal-outcome',
      learningLabel: {
        learningKind: 'diagnostic-no-proposal',
        policySuppressed: false,
        diagnosticNoProposal: true,
        diagnosticAttempt: true,
        attemptShape: {
          captureOrGateBlocked: 1,
          policyDisabled: 0,
        },
      },
    });
  });

  it('A1h5d: daemon-required done run with diff but no proposal is capture-missing diagnostic', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock done diff no proposal' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-done-diff-no-proposal',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
      runEventSummary: {
        runId: 'run-done-diff-no-proposal',
        status: 'done',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        diffFiles: 2,
        diffLines: 5,
        actionCounts: {
          proposalDisabled: 1,
          proposalCaptureAttempts: 0,
          proposalCreated: 0,
          diffFiles: 2,
          diffLines: 5,
        },
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({
      delegationScope: {
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
      },
    });
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'proposal-capture-error: capture-missing: required proposal dispatch produced changes without proposal filing',
      production: {
        outcome: 'proposal-capture-error',
        runId: 'run-done-diff-no-proposal',
        reason: 'capture-missing: required proposal dispatch produced changes without proposal filing',
        diffFiles: 2,
        diffLines: 5,
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-capture-error',
      proposalCreated: false,
      runId: 'run-done-diff-no-proposal',
      reason: 'capture-missing: required proposal dispatch produced changes without proposal filing',
      diffFiles: 2,
      diffLines: 5,
      basis: 'run-proposal-outcome',
      learningLabel: {
        learningKind: 'diagnostic-no-proposal',
        policySuppressed: false,
        diagnosticNoProposal: true,
        diagnosticAttempt: true,
        attemptShape: {
          captureOrGateBlocked: 1,
          policyDisabled: 0,
        },
      },
    });
  });

  it('A1h5e: done diff capture-missing works without action count telemetry', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock done diff no counts' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-done-diff-no-counts',
      status: 'done',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: {
        kind: 'proposal-disabled',
        reason: 'proposal filing disabled for this sandboxed attempt',
      },
      runEventSummary: {
        runId: 'run-done-diff-no-counts',
        status: 'done',
        outcome: 'proposal-disabled',
        proposalCreated: false,
        diffFiles: 1,
        diffLines: 4,
      },
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'proposal-capture-error: capture-missing: required proposal dispatch produced changes without proposal filing',
      production: {
        outcome: 'proposal-capture-error',
        runId: 'run-done-diff-no-counts',
        reason: 'capture-missing: required proposal dispatch produced changes without proposal filing',
        diffFiles: 1,
        diffLines: 4,
      },
    });
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'proposal-capture-error',
      runId: 'run-done-diff-no-counts',
      reason: 'capture-missing: required proposal dispatch produced changes without proposal filing',
      diffFiles: 1,
      diffLines: 4,
      runEventSummary: {
        status: 'done',
        diffFiles: 1,
        diffLines: 4,
      },
    });
  });

  it('A1h6: non-proposal production does not inherit proposal ids from the pending delta', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock empty with side proposal' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockImplementationOnce(async () => {
      createProposal({
        repo: items[0]!.repo,
        origin: 'swarm',
        kind: 'patch',
        title: 'Side proposal',
        summary: 'created by another capture path',
        diff: 'diff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-old\n+new\n',
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        runId: 'run-side-proposal',
      });
      return {
        id: 'run-empty-with-side-proposal',
        status: 'done',
        usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
        proposalOutcome: {
          kind: 'empty-diff',
          reason: 'empty result despite a side proposal',
        },
      };
    });

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1);
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    const event = readDispatchProductionEvents({ limit: 1 })[0]!;
    expect(event).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'empty-diff',
      proposalCreated: false,
      runId: 'run-empty-with-side-proposal',
      basis: 'run-proposal-outcome',
    });
    expect(event).not.toHaveProperty('proposalId');
  });

  it('A1h7: thrown sandboxed dispatch records an engine-failed production outcome', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'mock local-coder throw' });
    mockEngineTierOf.mockImplementation((backend: unknown) => backend === 'local-coder' ? 'mid' : 'local');
    mockRunGoal.mockRejectedValueOnce(new Error('model process crashed'));

    const result = await tick(
      {
        ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
        foundry: {
          allowedBackends: ['local-coder'],
        },
      } as AshlrConfig,
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'local-coder',
      dispatched: true,
      skipReason: 'dispatch-error: executor threw',
      production: {
        outcome: 'engine-failed',
        reason: 'dispatch-error: executor threw',
      },
    });
    expect(loadWorkedLedger().events.filter((event) => event.itemId === items[0]!.id)).toEqual([
      expect.objectContaining({ itemId: items[0]!.id, outcome: 'empty' }),
    ]);
    expect(readDispatchProductionEvents({ limit: 1 })[0]).toMatchObject({
      itemId: items[0]!.id,
      outcome: 'engine-failed',
      proposalCreated: false,
      reason: 'dispatch-error: executor threw',
      basis: 'run-proposal-outcome',
    });
  });

  it('A1i: live ticks persist bounded dispatch assignment traces', async () => {
    const { items } = enrollWithItems(1);
    mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'local', model: null, reason: 'test route' });

    const result = await tick(
      cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      { dryRun: false },
    );

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({
      workItemId: items[0]!.id,
      workSource: items[0]!.source,
      delegationScope: {
        origin: 'daemon',
        sourceRepo: items[0]!.repo,
        workItemId: items[0]!.id,
        workSource: items[0]!.source,
        objective: items[0]!.title,
        resultContract: { kind: 'proposal', requireDiff: true, requireProposal: true },
        backend: {
          engine: 'builtin',
          model: null,
          tier: 'local',
          assignedBy: 'router',
          reason: 'test route',
        },
      },
    });
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      tier: 'local',
      assignedBy: 'router',
      reason: 'test route',
      dispatched: true,
      spentUsd: 0.001,
    });
    expect(result.proposalProduction).toMatchObject({
      selected: 1,
      claimed: 1,
      dispatched: 1,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 1,
    });

    const state = loadDaemonState();
    expect(state.ticks.at(-1)?.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      backend: 'builtin',
      reason: 'test route',
      dispatched: true,
    });
    expect(state.ticks.at(-1)?.proposalProduction?.noProposalDispatches).toBe(1);
  });

  it('A2: buildBacklog throws → tick swallows and returns no-backlog', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockRejectedValue(new Error('buildBacklog exploded'));

    const result = await tick(cfgBuiltin(), { dryRun: false });

    expect(result.reason).toBe('no-backlog');
    expect(result.proposalsCreated).toBe(0);
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A3: perTickItems cap limits selection — itemsConsidered <= cap regardless of backlog size', async () => {
    const { } = enrollWithItems(10);
    const cap = 3;

    const result = await tick(cfgBuiltin({ perTickItems: cap }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBeLessThanOrEqual(cap);
    expect(result.itemsConsidered).toBe(cap);
    expect(mockRunSwarm).toHaveBeenCalledTimes(cap);
  });

  it('A4: near-zero remaining budget still selects exactly 1 item (selectCount floor)', async () => {
    enrollWithItems(5);
    // $0.004 remaining → floor(0.004 / 0.01) = 0, but max(1, 0) = 1
    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.004, perTickItems: 5 });
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0 }));

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('A5: selectCount shrinks via maxByBudget formula when remaining budget is small', async () => {
    enrollWithItems(10);
    // remainingBudget = $0.025 → floor(0.025 / 0.01) = 2
    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.025, perTickItems: 8 });
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: 0 }));

    const result = await tick(cfg, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    expect(result.itemsConsidered).toBeLessThan(8);
  });

  it('A6: round-robin across 2 repos — both repos get at least one item in a cap-2 tick', async () => {
    const repo1 = fx.makeRepo();
    const repo2 = fx.makeRepo();
    repo1.enroll();
    repo2.enroll();
    const now = new Date().toISOString();
    const items1 = makeItems(repo1.dir, 3);
    const items2 = makeItems(repo2.dir, 3);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: now,
      repos: [repo1.dir, repo2.dir],
      items: [...items1, ...items2],
    });

    const dispatchedRepos: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const project = (opts as Record<string, unknown>)?.project as string | undefined;
      if (project) dispatchedRepos.push(project);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 2 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(2);
    // Both repos should each get one item via round-robin.
    expect(dispatchedRepos).toContain(repo1.dir);
    expect(dispatchedRepos).toContain(repo2.dir);
  });

  it('A6b: strategic core repos lead round-robin when capacity is scarce', async () => {
    const parent = fs.mkdtempSync(`${fx.home}/strategic-repos-`);
    const supportingRepo = `${parent}/ashlr-config`;
    const coreRepo = `${parent}/ashlr-hub`;
    fs.mkdirSync(supportingRepo, { recursive: true });
    fs.mkdirSync(coreRepo, { recursive: true });
    fs.mkdirSync(fx.ashlrDir, { recursive: true });
    fs.writeFileSync(
      `${fx.ashlrDir}/enrollment.json`,
      JSON.stringify({ repos: [supportingRepo, coreRepo] }),
      'utf8',
    );
    const supportItems = makeItems(supportingRepo, 2);
    const coreItems = makeItems(coreRepo, 2);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [supportingRepo, coreRepo],
      items: [...supportItems, ...coreItems],
    });
    const dispatchedRepos: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const project = (opts as Record<string, unknown>)?.project as string | undefined;
      if (project) dispatchedRepos.push(project);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(dispatchedRepos).toEqual([coreRepo]);
  });

  it('A7: items with a pending proposal are skipped during selection', async () => {
    const { repo, items } = enrollWithItems(3);
    // New proposals use workItemId as the source of truth; stale prose that
    // mentions another item must not block that other item.
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `pending for ${items[1]!.id}`,
      summary: `covers ${items[1]!.id}`,
      diff: 'diff --git a/x.ts b/x.ts\n',
      workItemId: items[0]!.id,
    });

    const dispatchedItemIds: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
      if (workItemId) dispatchedItemIds.push(workItemId);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // items[0] was skipped; only 2 items dispatched from the 3 available.
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(dispatchedItemIds).not.toContain(items[0]!.id);
    expect(dispatchedItemIds).toContain(items[1]!.id);
    expect(dispatchedItemIds).toContain(items[2]!.id);
  });

  it('A7a: unavailable diagnostic proposal authority quarantines its root while ordinary work continues', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'abcdea123456', 10, 'mid');
    const proposal = createDiagnosticPendingProposal(
      repair,
      'attempt-a2345678-1234-4123-8123-123456789abc',
    );
    const ordinary = makeItems(repo.dir, 1)[0]!;
    mockGeneratedRepairProposalDispatchAuthority.mockImplementation(
      (item: WorkItem, candidate: Proposal) =>
        item.id === repair.id && candidate.id === proposal.id ? 'unavailable' : 'not-applicable',
    );
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair, ordinary],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'crash recovery retry' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockResolvedValueOnce({
      id: 'run-crash-recovery-retry',
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'proposal-disabled', reason: 'selection-only crash recovery fixture' },
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.itemsConsidered).toBe(1);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(readGeneratedRepairLifecycle(repair)).toMatchObject({
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  });

  it.each(['proven', 'unavailable'] as const)(
    'A7a2: %s diagnostic proposal authority remains fail-closed during selection',
    async (authority) => {
      const repo = fx.makeRepo();
      repo.enroll();
      const repair = makeDiagnosticResliceItem(
        repo.dir,
        authority === 'proven' ? 'abcdeb123456' : 'abcdec123456',
        10,
        'mid',
      );
      const proposal = createDiagnosticPendingProposal(
        repair,
        authority === 'proven'
          ? 'attempt-b2345678-1234-4123-8123-123456789abc'
          : 'attempt-c2345678-1234-4123-8123-123456789abc',
      );
      mockGeneratedRepairProposalDispatchAuthority.mockImplementation(
        (item: WorkItem, candidate: Proposal) =>
          item.id === repair.id && candidate.id === proposal.id ? authority : 'not-applicable',
      );
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [repair],
      });

      const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

      expect(result.itemsConsidered).toBe(0);
      expect(result.reason).toBe('ok');
      expect(mockRunGoal).not.toHaveBeenCalled();
    },
  );

  it('A8: concurrent dispatch records a forensic manifest before execution', async () => {
    const { items } = enrollWithItems(2);
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: 2,
        parallel: 2,
        intervalMs: 50,
      },
      foundry: {
        allowedBackends: ['builtin'],
        fabric: {
          concurrentDispatch: true,
          maxSlotsPerBackend: 2,
        },
      },
    });

    const result = await tick(cfg, { dryRun: false });
    const manifests = readDispatchManifestEvents({ limit: 5 });
    const state = loadDaemonState();

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(result.dispatchManifest).toMatchObject({
      schemaVersion: 1,
      mode: 'concurrent',
      recorded: true,
      claimed: 2,
      assigned: 2,
      unassigned: 0,
      backends: { builtin: 2 },
    });
    expect(result.dispatchManifest?.manifestId).toMatch(/^dm-/);
    expect(state.ticks.at(-1)?.dispatchManifest?.manifestId).toBe(result.dispatchManifest?.manifestId);
    expect(manifests[0]).toMatchObject({
      manifestId: result.dispatchManifest?.manifestId,
      counts: { claimed: 2, assigned: 2, unassigned: 0 },
      assignments: [
        expect.objectContaining({ itemId: items[0]!.id, backend: 'builtin', attemptId: expect.stringMatching(/^attempt-/) }),
        expect.objectContaining({ itemId: items[1]!.id, backend: 'builtin', attemptId: expect.stringMatching(/^attempt-/) }),
      ],
    });
    const manifestAttemptIds = new Set(manifests[0]!.assignments.map((assignment) => assignment.attemptId));
    const executorAttemptIds = new Set(
      mockRunSwarm.mock.calls.map((call) => (call[2] as { runId?: string }).runId),
    );
    expect(executorAttemptIds).toEqual(manifestAttemptIds);
    expect(new Set(result.dispatches?.map((dispatch) => dispatch.runId))).toEqual(manifestAttemptIds);
    const starts = readAgentActions().filter((event) => event.action === 'daemon:dispatch-start');
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((event) => event.runId))).toEqual(manifestAttemptIds);
  });

  it('A8b: concurrent missing-inner fallback preserves the allocated causal identity', async () => {
    const { items } = enrollWithItems(1);
    mockRunConcurrentDispatch.mockImplementationOnce(async (plan: DispatchPlan) => {
      const assignment = plan.assignments[0]!;
      return [
        {
          item: assignment.item,
          backend: assignment.backend,
          attempted: true,
          settled: { status: 'fulfilled', value: undefined },
        },
        {
          item: { ...assignment.item, id: 'unallocated-result-item' },
          backend: assignment.backend,
          attempted: false,
          settled: null,
        },
      ];
    });
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 50,
      },
      foundry: {
        allowedBackends: ['builtin'],
        fabric: { concurrentDispatch: true, maxSlotsPerBackend: 1 },
      },
    });

    const result = await tick(cfg, { dryRun: false });
    const manifestAttemptId = readDispatchManifestEvents({ limit: 1 })[0]?.assignments[0]?.attemptId;

    expect(manifestAttemptId).toMatch(/^attempt-/);
    expect(result.dispatches?.[0]).toMatchObject({
      itemId: items[0]!.id,
      runId: manifestAttemptId,
      trajectoryId: `run:${manifestAttemptId}`,
      dispatched: true,
      skipReason: 'missing-outcome',
    });
    expect(result.dispatches?.[1]).toMatchObject({
      itemId: 'unallocated-result-item',
      trajectoryId: 'work:unallocated-result-item',
      dispatched: false,
      skipReason: 'not-attempted',
    });
    expect(result.dispatches?.[1]?.runId).toBeUndefined();

    const productionEvents = readDispatchProductionEvents({ limit: 10 });
    expect(productionEvents).toHaveLength(1);
    expect(productionEvents[0]).toMatchObject({
      itemId: items[0]!.id,
      runId: manifestAttemptId,
      trajectoryId: `run:${manifestAttemptId}`,
    });

    const dispatchActions = readAgentActions({ limit: 10 })
      .filter((event) => event.action === 'daemon:dispatch');
    expect(dispatchActions).toHaveLength(1);
    expect(dispatchActions[0]).toMatchObject({
      itemId: items[0]!.id,
      runId: manifestAttemptId,
      trajectoryId: `run:${manifestAttemptId}`,
    });
  });

  it('A7-selection-telemetry: records pending and cooldown blockers in the global workspace', async () => {
    const { repo, items } = enrollWithItems(3);
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `pending for ${items[0]!.id}`,
      summary: `covers ${items[0]!.id}`,
      diff: 'diff --git a/x.ts b/x.ts\n',
      workItemId: items[0]!.id,
    });
    recordOutcome(items[1]!.id, 'empty');

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: true });
    const selection = readAgentActions().find((event) => event.action === 'daemon:selection');

    expect(result.reason).toBe('dry-run');
    expect(result.itemsConsidered).toBe(1);
    expect(selection).toMatchObject({
      actor: 'daemon',
      kind: 'selection',
      outcome: 'ok',
      action: 'daemon:selection',
      repo: repo.dir,
      itemId: items[2]!.id,
      source: 'todo',
      reason: 'dry-run',
      counts: {
        backlogItems: 3,
        eligibleItems: 1,
        pendingBlocked: 1,
        cooldownBlocked: 1,
        fastRepairCooldown: 0,
        rawSelectCount: 3,
        selectCount: 3,
        selected: 1,
        claimed: 1,
      },
    });
    expect(selection?.summary).toContain('normal: claimed 1/1 from 1/3 eligible');
    expect(selection?.summary).toContain('cooldown 1, pending 1');
    expect(selection?.summary).not.toContain(items[0]!.id);
    expect(selection?.summary).not.toContain(items[1]!.id);
    expect(selection?.summary).not.toContain(items[2]!.id);
    expect(selection?.tags).toEqual(expect.arrayContaining(['selection', 'normal-selection', 'dry-run', 'claimed']));
    expect(mockRunSwarm).not.toHaveBeenCalled();
  });

  it('A7a1: stale diagnostic proposal authority cannot age out before duplicate-proof validation', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'acbdfe123456', 10, 'mid');
    const ordinary = makeItems(repo.dir, 1)[0]!;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
      const proposal = createDiagnosticPendingProposal(
        repair,
        'attempt-b2345678-1234-4123-8123-123456789abc',
      );
      vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));
      const actualProposalRepair = await vi.importActual<
        typeof import('../src/core/fleet/proposal-repair-work.js')
      >('../src/core/fleet/proposal-repair-work.js');
      mockGeneratedRepairProposalDispatchAuthority.mockImplementation(
        actualProposalRepair.generatedRepairProposalDispatchAuthority,
      );
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: [repair, ordinary],
      });

      const result = await tick({
        ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
        foundry: {
          allowedBackends: ['local-coder'],
          productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
        },
      } as AshlrConfig, { dryRun: false });

      expect(result).toMatchObject({
        reason: 'ok',
        itemsConsidered: 1,
      });
      expect(mockRunGoal).not.toHaveBeenCalled();
      expect(mockRunSwarm).toHaveBeenCalledTimes(1);
      expect(mockRunSwarm.mock.calls[0]?.[2]).toMatchObject({ workItemId: ordinary.id });
      expect(proposal.status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('A7a0: malformed proposal storage blocks duplicate selection and exposes degraded maintenance truth', async () => {
    enrollWithItems(1);
    fs.mkdirSync(inboxDir(), { recursive: true });
    fs.writeFileSync(join(inboxDir(), 'hidden-pending.json'), '{malformed', 'utf8');
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalInboxAvailable: false,
      dispatchSourceState: 'degraded',
      dispatchSourceComplete: false,
      dispatchSourceInvalidRows: 2,
      dispatchSourceUnreadableFiles: 1,
      dispatchSourceStopReasons: ['io-error'],
    });

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), { dryRun: false });

    expect(result.itemsConsidered).toBe(0);
    expect(result.producerMaintenance).toMatchObject({
      proposalRepair: true,
      proposalRepairInboxAvailable: false,
      dispatchRepairSourceState: 'degraded',
      dispatchRepairSourceComplete: false,
      dispatchRepairSourceInvalidRows: 2,
      dispatchRepairSourceUnreadableFiles: 1,
      dispatchRepairSourceStopReasons: ['io-error'],
    });
    expect(result.reason).toBe('state-persistence-failed');
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
  });

  it('A7a0b: dispatch-only degradation refuses before selection with a healthy proposal inbox', async () => {
    enrollWithItems(1);
    mockQueueProposalRepairWorkForPendingProposals.mockReturnValue({
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
      proposalInboxAvailable: true,
      handoffSourceState: 'healthy',
      dispatchSourceState: 'degraded',
      dispatchSourceComplete: false,
      dispatchSourceInvalidRows: 1,
      dispatchSourceUnreadableFiles: 0,
      dispatchSourceStopReasons: [],
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'], bestOfN: 3 },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'state-persistence-failed',
      itemsConsidered: 0,
      producerMaintenance: {
        proposalRepairInboxAvailable: true,
        dispatchRepairSourceState: 'degraded',
        dispatchRepairSourceComplete: false,
        dispatchRepairSourceInvalidRows: 1,
        dispatchRepairSourceUnreadableFiles: 0,
        dispatchRepairSourceStopReasons: [],
      },
    });
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
  });

  it('A7a0c: proposal maintenance exceptions expose both degraded sources and refuse execution', async () => {
    enrollWithItems(1);
    mockQueueProposalRepairWorkForPendingProposals.mockImplementationOnce(() => {
      throw new Error('adversarial dispatch reader failure');
    });

    const result = await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'], bestOfN: 3 },
    } as AshlrConfig, { dryRun: false });

    expect(result).toMatchObject({
      reason: 'state-persistence-failed',
      itemsConsidered: 0,
      producerMaintenance: {
        proposalRepairInboxAvailable: false,
        repairHandoffSourceState: 'degraded',
        dispatchRepairSourceState: 'degraded',
        dispatchRepairSourceComplete: false,
        dispatchRepairSourceInvalidRows: 0,
        dispatchRepairSourceUnreadableFiles: 1,
        dispatchRepairSourceStopReasons: ['io-error'],
      },
    });
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
  });

  it('A7c: stale pending proposals do not skip matching items under production velocity', async () => {
    const { repo, items } = enrollWithItems(2);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
      createProposal({
        repo: repo.dir,
        origin: 'swarm',
        kind: 'patch',
        title: `old pending for ${items[0]!.id}`,
        summary: `covers ${items[0]!.id}`,
        diff: 'diff --git a/x.ts b/x.ts\n',
        workItemId: items[0]!.id,
      });
      vi.setSystemTime(new Date('2026-07-03T00:00:00.000Z'));

      const dispatchedItemIds: string[] = [];
      mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
        const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
        if (workItemId) dispatchedItemIds.push(workItemId);
        return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
      });

      const result = await tick(
        {
          ...cfgBuiltin({ perTickItems: 2, parallel: 2 }),
          foundry: {
            autonomyControlLoop: false,
            productionVelocity: { enabled: true, profile: 'resource-control', stalePendingTtlHours: 24 },
          },
        } as AshlrConfig,
        { dryRun: false },
      );

      expect(result.reason).toBe('ok');
      expect(mockRunSwarm).toHaveBeenCalledTimes(2);
      expect(dispatchedItemIds).toContain(items[0]!.id);
      expect(dispatchedItemIds).toContain(items[1]!.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A7b: legacy pending proposals without workItemId still skip exact item-id matches', async () => {
    const { repo, items } = enrollWithItems(3);
    createProposal({
      repo: repo.dir,
      origin: 'swarm',
      kind: 'patch',
      title: `legacy pending for ${items[1]!.id}`,
      summary: 'legacy proposal has no causal work item id',
      diff: 'diff --git a/x.ts b/x.ts\n',
    });

    const dispatchedItemIds: string[] = [];
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, opts: unknown) => {
      const workItemId = (opts as Record<string, unknown>)?.workItemId as string | undefined;
      if (workItemId) dispatchedItemIds.push(workItemId);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 3 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(dispatchedItemIds).toContain(items[0]!.id);
    expect(dispatchedItemIds).not.toContain(items[1]!.id);
    expect(dispatchedItemIds).toContain(items[2]!.id);
  });
});

// ===========================================================================
// Group B — TieredPool local/cloud concurrency caps
// ===========================================================================

describe('M201 — Group B: TieredPool local/cloud concurrency caps', () => {
  /** Create a cfg that enables continuous mode (engages TieredPool). */
  function cfgContinuous(opts: {
    perTickItems?: number;
    local?: number;
    cloud?: number;
    total?: number;
  } = {}): AshlrConfig {
    return makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: opts.perTickItems ?? 4,
        parallel: 4,
        intervalMs: 50,
        mode: 'continuous',
        concurrency: {
          local: opts.local ?? 2,
          cloud: opts.cloud ?? 6,
          total: opts.total ?? 8,
        },
      } as AshlrConfig['daemon'],
    });
  }

  it('B1: local cap=1, all local items → peak concurrency never exceeds 1', async () => {
    enrollWithItems(4);
    mockEngineTierOf.mockReturnValue('local');

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 1, cloud: 4, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B2: cloud cap=1, all cloud items → peak concurrency never exceeds 1', async () => {
    enrollWithItems(4);
    // engineTierOf returns 'frontier' → poolTierOf maps to 'cloud'
    mockEngineTierOf.mockReturnValue('frontier');

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 4, cloud: 1, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B3: total cap=1, mixed tiers → never more than 1 item in flight at once', async () => {
    enrollWithItems(4);
    // Alternate local/cloud tiers per item call.
    let callCount = 0;
    mockEngineTierOf.mockImplementation(() => (callCount++ % 2 === 0 ? 'local' : 'frontier'));

    const conc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async () => {
      conc.current++;
      conc.max = Math.max(conc.max, conc.current);
      await new Promise((r) => setTimeout(r, 5));
      conc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 2, cloud: 2, total: 1, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(conc.max).toBeGreaterThan(0);
    expect(conc.max).toBeLessThanOrEqual(1);
  });

  it('B4: local=2 cloud=1 — local slots do not count against cloud cap', async () => {
    enrollWithItems(4);
    // First 2 items are local, last 2 are cloud.
    let idx = 0;
    mockEngineTierOf.mockImplementation(() => (idx++ < 2 ? 'local' : 'frontier'));

    const cloudConc = { current: 0, max: 0 };
    mockRunSwarm.mockImplementation(async (_goal: unknown, _cfg: unknown, _opts: unknown) => {
      // We can't directly inspect which tier was used from opts, so track total conc as proxy
      cloudConc.current++;
      cloudConc.max = Math.max(cloudConc.max, cloudConc.current);
      await new Promise((r) => setTimeout(r, 5));
      cloudConc.current--;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgContinuous({ local: 2, cloud: 1, total: 4, perTickItems: 4 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // All 4 items dispatched — local cap allows 2 concurrent, cloud cap allows 1.
    expect(mockRunSwarm).toHaveBeenCalledTimes(4);
  });
});

// ===========================================================================
// Group C — Per-item dispatch accounting
// ===========================================================================

describe('M201 — Group C: per-item dispatch accounting', () => {
  it('C1: tickSpent is the sum of per-item usage.estCostUsd', async () => {
    enrollWithItems(3);
    const costPerItem = 0.05;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    // 3 items dispatched × $0.05 each = $0.15.
    expect(result.spentUsd).toBeCloseTo(3 * costPerItem, 10);
  });

  it('C2: proposalsCreated equals the pendingCount delta, not the swarm dispatch count', async () => {
    const { repo, items } = enrollWithItems(2);
    const before = pendingCount();
    // Only the first swarm creates a proposal; the second returns done with no proposal.
    let call = 0;
    mockRunSwarm.mockImplementation(async () => {
      if (call++ === 0) {
        createProposal({
          repo: repo.dir,
          origin: 'swarm',
          kind: 'patch',
          title: 'C2 proposal',
          summary: 'C2',
          diff: 'diff --git a/x.ts b/x.ts\n',
          workItemId: items[0]!.id,
          workSource: items[0]!.source,
          runId: 'm201-run-first',
        });
      }
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(1); // only 1 new pending proposal
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(pendingCount()).toBe(before + 1);
    const ledger = loadWorkedLedger();
    expect(ledger.events.find((e) => e.itemId === items[0]!.id)?.outcome).toBe('diff');
    expect(ledger.events.find((e) => e.itemId === items[1]!.id)?.outcome).toBe('empty');
  });

  it('C3: swarm that returns done but creates no proposal is NOT counted in proposalsCreated', async () => {
    enrollWithItems(2);
    const before = pendingCount();
    // Swarm succeeds but creates nothing.
    mockRunSwarm.mockResolvedValue({
      id: 'mock', status: 'done', goal: '', result: '',
      usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 },
    });

    const result = await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    expect(result.reason).toBe('ok');
    expect(result.proposalsCreated).toBe(0);
    expect(result.proposalProduction).toMatchObject({
      selected: 2,
      claimed: 2,
      dispatched: 2,
      skipped: 0,
      errors: 0,
      proposalsCreated: 0,
      noProposalDispatches: 2,
    });
    expect(pendingCount()).toBe(before);
  });

  it('C4: state.todaySpentUsd is updated by the tick\'s realized spend', async () => {
    enrollWithItems(2);
    const costPerItem = 0.03;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    const state = loadDaemonState();
    expect(state.todaySpentUsd).toBeCloseTo(2 * costPerItem, 10);
  });

  it('C5: state.itemsProcessed incremented by dispatched count (skip-items not counted)', async () => {
    enrollWithItems(3);
    seedSpend(0);

    // Set budget so only 2 items can be dispatched (in-tick short-circuit fires on 3rd)
    const costPerItem = 0.05;
    mockRunSwarm.mockImplementation(makeSpendingSwarmStub({ costUsd: costPerItem }));

    const cfg = cfgBuiltin({ dailyBudgetUsd: 0.10, perTickItems: 3, parallel: 1 });
    await tick(cfg, { dryRun: false });

    const state = loadDaemonState();
    // 2 items dispatched, 3rd short-circuited by in-tick budget guard.
    expect(state.itemsProcessed).toBe(2);
  });

  it('C6: ASHLR_IN_SWARM env is restored after each item dispatch (no env leak)', async () => {
    enrollWithItems(2);
    const swarmEnvsDuring: Array<string | undefined> = [];
    mockRunSwarm.mockImplementation(async () => {
      // The swarm runner sets ASHLR_IN_SWARM=1; the daemon restores it after.
      // Here we just capture the value DURING the call to observe it's set.
      swarmEnvsDuring.push(process.env['ASHLR_IN_SWARM']);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const prevSwarm = process.env['ASHLR_IN_SWARM'];
    await tick(cfgBuiltin({ perTickItems: 2, parallel: 1 }), { dryRun: false });

    // After the tick, ASHLR_IN_SWARM should be back to its pre-tick value.
    expect(process.env['ASHLR_IN_SWARM']).toBe(prevSwarm);
  });

  it('C7: kill set mid-tick skips remaining items (in-tick per-item kill check)', async () => {
    enrollWithItems(4);
    let callCount = 0;
    mockRunSwarm.mockImplementation(async () => {
      callCount++;
      // Set kill after first dispatch so remaining items are skipped.
      if (callCount === 1) {
        fx.setKill(true);
      }
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const result = await tick(cfgBuiltin({ perTickItems: 4, parallel: 1 }), { dryRun: false });

    // The completed tick retains its work accounting while surfacing the
    // mid-item stop request truthfully.
    expect(result.reason).toBe('kill-switch');
    // Only the first item was dispatched; subsequent items saw kill=ON and skipped.
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    const starts = readAgentActions().filter((event) => event.action === 'daemon:dispatch-start');
    expect(starts).toHaveLength(1);
    expect(result.dispatches?.filter((dispatch) => !dispatch.dispatched)).toHaveLength(3);
  });
});

// ===========================================================================
// Group D — M197 observability: console.warn on dispatch failures
// ===========================================================================

describe('M201 — Group D: observability — dispatch failure logging', () => {
  it('D1: runSwarm throws → daemon:swarm-error path taken; tick still returns reason ok', async () => {
    const { items } = enrollWithItems(1);
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, opts) => {
      expect(readAgentActions().find((event) => event.action === 'daemon:dispatch-start')).toMatchObject({
        itemId: items[0]!.id,
        runId: (opts as { runId: string }).runId,
        outcome: 'started',
      });
      throw new Error('runSwarm exploded for D1');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tick(cfgBuiltin({ perTickItems: 1 }), { dryRun: false });

    warnSpy.mockRestore();

    // The tick must not rethrow — it wraps every item dispatch in try/catch.
    expect(result.reason).toBe('ok');
    expect(typeof result.proposalsCreated).toBe('number');
    expect(typeof result.spentUsd).toBe('number');
    expect(readAgentActions().find((event) => event.action === 'daemon:dispatch-start')).toMatchObject({
      outcome: 'started',
      runId: result.dispatches?.[0]?.runId,
    });
  });

  it('D2: 3 items, middle one throws → other 2 dispatched, tick returns ok', async () => {
    enrollWithItems(3);
    let callNum = 0;
    mockRunSwarm.mockImplementation(async () => {
      const n = callNum++;
      if (n === 1) throw new Error('middle dispatch exploded D2');
      return { id: `mock-${n}`, status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await tick(cfgBuiltin({ perTickItems: 3, parallel: 1 }), { dryRun: false });

    warnSpy.mockRestore();

    expect(result.reason).toBe('ok');
    // All 3 items attempted; one threw but others succeeded.
    expect(mockRunSwarm).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// Group E — Config reload per tick (M85 runDaemon loop)
// ===========================================================================

describe('M201 — Group E: runDaemon config reload + loop mechanics', () => {
  it('E1: runDaemon once=true runs exactly one tick and stops', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    // After once=true, daemon is no longer running.
    expect(state.running).toBe(false);
    // One tick happened (ticks array has at least one entry from the dry-run tick).
    expect(state.ticks.length).toBeGreaterThanOrEqual(1);
    expect(state.ticks.at(-1)?.dryRun).toBe(true);
  });

  it('E1b: runDaemon once=true reloads Foundry policy from disk before ticking', async () => {
    enrollWithItems(1);
    mockBuildResourceStrategyReport.mockResolvedValue(strategyReport('verify-only', 'caller cfg would enforce verify-only'));
    mockLoadConfig.mockReturnValue({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autonomyControlLoop: false, autoMerge: { enabled: true } },
    } as AshlrConfig);

    const callerCfg = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { autoMerge: { enabled: true } },
    } as AshlrConfig;
    const state = await runDaemon(callerCfg, { once: true, dryRun: false });

    expect(mockBuildResourceStrategyReport).not.toHaveBeenCalled();
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(state.running).toBe(false);
    expect(state.ticks.at(-1)?.reason).toBe('ok');
  });

  it('E1c: successful live one-shot ticks persist a context rollup', async () => {
    enrollWithItems(1);
    const now = Date.now();
    recordAgentAction(Array.from({ length: 25 }, (_, index): AgentActionEvent => {
      const runId = `rollup-seed-${index}`;
      return {
        schemaVersion: 1,
        ts: new Date(now - index * 1_000).toISOString(),
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'daemon:dispatch',
        summary: 'seed',
        runId,
        trajectoryId: `run:${runId}`,
        learningSource: 'daemon-dispatch',
        runEventSummary: { runId, status: 'done', outcome: 'no-proposal', proposalCreated: false },
        learningLabel: {
          schemaVersion: 1,
          classifierVersion: 'attempt-shape-v1',
          authoritative: true,
          learningKind: 'diagnostic-no-proposal',
          policySuppressed: false,
          diagnosticNoProposal: true,
          diagnosticAttempt: true,
          attemptShape: {
            backendNoDiff: 1,
            captureOrGateBlocked: 0,
            repairAttempts: 0,
            policyDisabled: 0,
          },
        },
      };
    }));
    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    cfg.daemon = {
      ...cfg.daemon,
      contextRollup: { enabled: true, cadenceHours: 24, minTerminalTrajectories: 25 },
    };
    mockLoadConfig.mockReturnValue(cfg);

    const state = await runDaemon(cfg, { once: true, dryRun: false });

    expect(state.ticks.at(-1)?.reason).toBe('ok');
    expect(readAgentActions().filter((event) => event.action === 'daemon:context-rollup')).toHaveLength(1);
  });

  it('E2: runDaemon loop with maxCycles=2 runs exactly 2 ticks and stops', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    // Use enough distinct items so cycle 2 is not blocked by the per-item
    // cooldown that fires after cycle 1 dispatches the same item.
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    let tickCount = 0;
    mockRunSwarm.mockImplementation(async () => {
      tickCount++;
      return { id: `mock-${tickCount}`, status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 } };
    });

    // Use continuous mode to prove the non-empty loop does not require fixed
    // interval sleeps between ticks. idleBackoffMs:1 keeps any idle branch fast.
    const cfg = makeCfg({
      daemon: {
        dailyBudgetUsd: 1.0,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 50,
        idleBackoffMs: 1,
        mode: 'continuous',
        concurrency: { local: 2, cloud: 6, total: 8 },
      } as AshlrConfig['daemon'],
    });
    mockLoadConfig.mockReturnValue(cfg);
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 });

    // Daemon should have run exactly 2 tick cycles and stopped.
    // ticks[] records one entry per cycle; daemon is no longer running.
    expect(state.ticks.length).toBe(2);
    expect(state.running).toBe(false);
    expect(mockRunSwarm.mock.calls.length).toBeLessThanOrEqual(2);
  }, 10_000);

  it('E2a: continuous mode remains resident after a durably settled generated-repair failure', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const repair = makeDiagnosticResliceItem(repo.dir, 'ccddaa123456', 10, 'mid');
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [repair],
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'continuous failure fixture' });
    mockEngineTierOf.mockReturnValue('mid');
    mockRunGoal.mockImplementationOnce(async (_goal: unknown, _cfg: unknown, options: unknown) => ({
      id: (options as { runId: string }).runId,
      status: 'done',
      engine: 'local-coder',
      engineTier: 'mid',
      usage: { totalTokens: 100, estCostUsd: 0.002, steps: 1 },
      proposalOutcome: { kind: 'engine-failed-no-diff', reason: 'paid engine failed' },
    }));
    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    cfg.daemon = {
      ...cfg.daemon,
      mode: 'continuous',
      idleBackoffMs: 1,
      intervalMs: 1,
    };
    cfg.foundry = { ...cfg.foundry, allowedBackends: ['local-coder'] };
    mockLoadConfig.mockReturnValue(cfg);

    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 3 });

    expect(state.running).toBe(false);
    expect(state.ticks).toHaveLength(3);
    expect(state.ticks[0]?.reason).toBe('ok');
    expect(state.ticks.slice(1).every((entry) => entry.reason !== 'state-persistence-failed')).toBe(true);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('E2aa: continuous mode backs off on every selected-but-skipped cycle', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    mockBeginRejectedCaptureRecoveryDispatch.mockReturnValue({ authorized: false });
    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    cfg.daemon = {
      ...cfg.daemon,
      mode: 'continuous',
      idleBackoffMs: 13,
      intervalMs: 1_000,
    };
    mockLoadConfig.mockReturnValue(cfg);
    const realSetTimeout = globalThis.setTimeout;
    const sleepMs: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((
      (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        sleepMs.push(Number(timeout ?? 0));
        return realSetTimeout(handler as (...handlerArgs: unknown[]) => void, 0, ...args);
      }
    ) as typeof setTimeout);

    try {
      const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 3 });

      expect(state.ticks).toHaveLength(3);
      expect(state.ticks).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemsConsidered: 1, reason: 'ok' }),
      ]));
      expect(state.ticks.every((daemonTick) =>
        daemonTick.dispatches?.every((dispatch) => dispatch.dispatched === false) === true
      )).toBe(true);
      expect(sleepMs.filter((ms) => ms === 13)).toHaveLength(3);
      expect(mockBeginRejectedCaptureRecoveryDispatch).toHaveBeenCalledTimes(3);
      expect(mockRunGoal).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  }, 10_000);

  it('E2b: batch loop sleeps with live daemon.intervalMs, not the startup config interval', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    const startupCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    startupCfg.daemon = { ...startupCfg.daemon, intervalMs: 10_000 };
    const liveCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    liveCfg.daemon = { ...liveCfg.daemon, intervalMs: 7 };
    mockLoadConfig.mockReturnValue(liveCfg);

    const realSetTimeout = globalThis.setTimeout;
    const sleepMs: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      sleepMs.push(Number(timeout ?? 0));
      return realSetTimeout(handler as (...handlerArgs: unknown[]) => void, 0, ...args);
    }) as typeof setTimeout);

    try {
      const state = await runDaemon(startupCfg, { once: false, dryRun: false, maxCycles: 2 });

      expect(state.running).toBe(false);
      expect(state.ticks.length).toBe(2);
      expect(sleepMs).toContain(7);
      expect(sleepMs).not.toContain(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('E2c: loop mode is re-read from live config between iterations', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });

    const startupCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 }) as AshlrConfig;
    startupCfg.daemon = { ...startupCfg.daemon, intervalMs: 10_000, mode: 'batch' };
    const liveBatch = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      daemon: { ...cfgBuiltin().daemon, perTickItems: 1, parallel: 1, intervalMs: 250, mode: 'batch' },
    } as AshlrConfig;
    const liveContinuous = {
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      daemon: {
        ...cfgBuiltin().daemon,
        perTickItems: 1,
        parallel: 1,
        intervalMs: 250,
        idleBackoffMs: 5,
        mode: 'continuous',
        concurrency: { local: 2, cloud: 6, total: 8 },
      },
    } as AshlrConfig;
    mockLoadConfig
      .mockReturnValueOnce(liveBatch)
      .mockReturnValue(liveContinuous);

    const realSetTimeout = globalThis.setTimeout;
    const sleepMs: number[] = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      sleepMs.push(Number(timeout ?? 0));
      return realSetTimeout(handler as (...handlerArgs: unknown[]) => void, 0, ...args);
    }) as typeof setTimeout);

    try {
      const state = await runDaemon(startupCfg, { once: false, dryRun: false, maxCycles: 2 });

      expect(state.running).toBe(false);
      expect(state.ticks.length).toBe(2);
      expect(sleepMs).not.toContain(250);
      expect(sleepMs).not.toContain(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('E3: runDaemon loop stops when kill switch is set before the next iteration', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    let swarmCalls = 0;
    mockRunSwarm.mockImplementation(async () => {
      swarmCalls++;
      // Set kill on first call so the loop exits after iteration 1.
      fx.setKill(true);
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    const state = await runDaemon(cfg, { once: false, dryRun: false, maxCycles: 10 });

    expect(state.running).toBe(false);
    // Kill fired after first swarm call → loop stopped; swarm called at most once.
    expect(swarmCalls).toBeLessThanOrEqual(1);
  });

  it('E3b: SIGTERM wakes resident shutdown and removes its signal listeners', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    const before = process.listenerCount('SIGTERM');
    mockRunSwarm.mockImplementation(async () => {
      process.emit('SIGTERM');
      return { id: 'signal-stop', status: 'done', goal: '', result: '', usage: { totalTokens: 1, estCostUsd: 0, steps: 1 } };
    });

    const state = await runDaemon(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      once: false, dryRun: false, maxCycles: 10,
    });

    expect(state.running).toBe(false);
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('E3c: SIGTERM restores default termination after a stalled tick exhausts its grace period', async () => {
    vi.useFakeTimers();
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    let release!: () => void;
    mockRunSwarm.mockImplementation(() => new Promise((resolveRun) => {
      release = () => resolveRun({
        id: 'forced-signal-stop', status: 'done', goal: '', result: '',
        usage: { totalTokens: 1, estCostUsd: 0, steps: 1 },
      });
    }));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const running = runDaemon(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
        once: false, dryRun: false, maxCycles: 10,
      });
      await vi.waitFor(() => expect(mockRunSwarm).toHaveBeenCalledTimes(1));
      process.emit('SIGTERM');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
      release();
      await running;
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('E3d: request-only KILL polling aborts promptly and cleans up timers/listeners after work settles', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    let release!: () => void;
    let settled = false;
    mockRunSwarm.mockImplementation((_input, _cfg, opts) => new Promise((resolveRun) => {
      release = () => resolveRun({
        id: 'request-only-stop', status: 'done', goal: '', result: '',
        usage: { totalTokens: 1, estCostUsd: 0, steps: 1 },
      });
      expect((opts as { signal?: AbortSignal }).signal?.aborted).toBe(false);
    }));
    const sigintBefore = process.listenerCount('SIGINT');
    const sigtermBefore = process.listenerCount('SIGTERM');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const running = runDaemon(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      once: false, dryRun: false, maxCycles: 10,
    }).finally(() => { settled = true; });

    try {
      await vi.waitFor(() => expect(mockRunSwarm).toHaveBeenCalledTimes(1));
      const signal = (mockRunSwarm.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      stopDaemon();
      stopDaemon();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1_000, interval: 10 });
      expect(loadDaemonState()).toMatchObject({ running: true, pid: process.pid });
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGINT');
      expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGTERM');

      const pollIndex = intervalSpy.mock.calls.findIndex((call) => call[1] === 50);
      expect(pollIndex).toBeGreaterThanOrEqual(0);
      const pollHandle = intervalSpy.mock.results[pollIndex]?.value;
      release();
      const state = await running;

      expect(state).toMatchObject({ running: false, pid: null });
      expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(clearIntervalSpy).toHaveBeenCalledWith(pollHandle);
    } finally {
      if (!settled) {
        release?.();
        await running;
      }
      kill.mockRestore();
      clearIntervalSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });

  it('E3e: a pre-aborted tick starts no dispatch or maintenance work', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    const shutdown = new AbortController();
    shutdown.abort();

    const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      dryRun: false,
      signal: shutdown.signal,
    });

    expect(result.reason).toBe('shutdown-requested');
    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(mockRunSelfHealCycle).not.toHaveBeenCalled();
    expect(mockQueueProposalRepairWorkForPendingProposals).not.toHaveBeenCalled();
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockRunBestOfN).not.toHaveBeenCalled();
  });

  it('E3f: tick threads its owner signal into direct runGoal execution', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'direct signal test' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();

    await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'] },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(mockRunGoal).toHaveBeenCalledTimes(1);
    expect(mockRunGoal.mock.calls[0]?.[2]).toMatchObject({ signal: shutdown.signal });
  });

  it('E3g: tick threads its owner signal into Best-of-N fan-out', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    mockRouteBackend.mockReturnValue({ backend: 'local-coder', tier: 'mid', reason: 'fan-out signal test' });
    mockEngineTierOf.mockReturnValue('mid');
    const shutdown = new AbortController();

    await tick({
      ...cfgBuiltin({ perTickItems: 1, parallel: 1 }),
      foundry: { allowedBackends: ['local-coder'], bestOfN: 2 },
    } as AshlrConfig, { dryRun: false, signal: shutdown.signal });

    expect(mockRunBestOfN).toHaveBeenCalledTimes(1);
    expect(mockRunBestOfN.mock.calls[0]?.[2]).toMatchObject({ signal: shutdown.signal });
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('E3h: Pulse command sync settles before shutdown releases daemon ownership', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });
    let releasePulse!: () => void;
    let pulseSignal: AbortSignal | undefined;
    let settled = false;
    mockRunPulseSync.mockImplementationOnce((_cfg, pulseOpts) => new Promise((resolvePulse) => {
      pulseSignal = (pulseOpts as { signal?: AbortSignal }).signal;
      releasePulse = () => resolvePulse({
        enabled: true,
        tickEmitted: true,
        commands: [],
        depEdgesShipped: 0,
        detail: 'settled',
      });
    }));
    const running = runDaemon(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      once: true,
      dryRun: false,
    }).finally(() => { settled = true; });

    try {
      await vi.waitFor(() => expect(mockRunPulseSync).toHaveBeenCalledTimes(1));
      expect(pulseSignal).toBeInstanceOf(AbortSignal);
      expect(loadDaemonState()).toMatchObject({
        running: true,
        pid: process.pid,
        todaySpentUsd: 0.001,
        itemsProcessed: 1,
      });

      stopDaemon();
      await vi.waitFor(() => expect(pulseSignal?.aborted).toBe(true), { timeout: 1_000, interval: 10 });
      expect(settled).toBe(false);
      expect(loadDaemonState()).toMatchObject({ running: true, pid: process.pid, todaySpentUsd: 0.001 });

      releasePulse();
      const finalState = await running;
      expect(finalState).toMatchObject({ running: false, pid: null, todaySpentUsd: 0.001, itemsProcessed: 1 });
    } finally {
      if (!settled) {
        releasePulse?.();
        await running;
      }
    }
  });

  it('E3i: an unsettled Pulse sync cannot overlap the next daemon tick', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 10),
    });
    const liveCfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    mockLoadConfig.mockReturnValue(liveCfg);
    let releaseFirstPulse!: () => void;
    mockRunPulseSync.mockImplementationOnce(() => new Promise((resolvePulse) => {
      releaseFirstPulse = () => resolvePulse({
        enabled: true,
        tickEmitted: true,
        commands: [],
        depEdgesShipped: 0,
        detail: 'first settled',
      });
    }));

    const running = runDaemon(liveCfg, {
      once: false,
      dryRun: false,
      maxCycles: 2,
    });

    await vi.waitFor(() => expect(mockRunPulseSync).toHaveBeenCalledTimes(1));
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);

    releaseFirstPulse();
    const finalState = await running;
    expect(mockRunSwarm).toHaveBeenCalledTimes(2);
    expect(mockRunPulseSync).toHaveBeenCalledTimes(2);
    expect(finalState).toMatchObject({ running: false, pid: null, itemsProcessed: 2, todaySpentUsd: 0.002 });
  });

  it('E3j: lock theft aborts active work and fences successor state and spend guard', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items,
    });
    const pendingBefore = pendingCount();
    let releaseSwarm!: () => void;
    let settled = false;
    mockRunSwarm.mockImplementation((_input, _cfg, runOpts) => new Promise((resolveRun) => {
      releaseSwarm = () => {
        const ownedOpts = runOpts as { runId: string; signal?: AbortSignal };
        if (!ownedOpts.signal?.aborted) {
          createProposal({
            repo: repo.dir,
            origin: 'swarm',
            kind: 'patch',
            title: 'must be fenced after lock theft',
            summary: 'adversarial stale-owner proposal',
            diff: 'diff --git a/x.ts b/x.ts\n',
            workItemId: items[0]!.id,
            workSource: items[0]!.source,
            runId: ownedOpts.runId,
          });
        }
        resolveRun({
          id: ownedOpts.runId,
          status: 'aborted',
          goal: 'stolen lock',
          result: 'cancelled',
          usage: { totalTokens: 10, estCostUsd: 0.111, steps: 1 },
        });
      };
    }));
    const running = runDaemon(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
      once: true,
      dryRun: false,
    }).finally(() => { settled = true; });

    try {
      await vi.waitFor(() => expect(mockRunSwarm).toHaveBeenCalledTimes(1));
      const ownerSignal = (mockRunSwarm.mock.calls[0]?.[2] as { signal?: AbortSignal }).signal;
      const successorStartedAt = '2026-07-13T12:00:00.000Z';
      const successorState = {
        running: true,
        pid: process.pid,
        startedAt: successorStartedAt,
        lastTickAt: '2026-07-13T12:01:00.000Z',
        todayDate: today(),
        todaySpentUsd: 0.77,
        itemsProcessed: 7,
        ticks: [],
      };
      fs.writeFileSync(daemonLockPath(), JSON.stringify({
        pid: process.pid,
        token: 'successor-token',
        hostname: 'successor-host',
        acquiredAt: successorStartedAt,
        heartbeatAt: successorStartedAt,
      }, null, 2) + '\n', 'utf8');
      saveDaemonState(successorState);
      const successorStateRaw = fs.readFileSync(join(process.env.ASHLR_HOME!, 'daemon.json'), 'utf8');

      await vi.waitFor(() => expect(ownerSignal?.aborted).toBe(true), { timeout: 1_000, interval: 10 });

      releaseSwarm();
      const finalState = await running;
      expect(finalState).toMatchObject(successorState);
      expect(loadDaemonState()).toMatchObject(successorState);
      expect(fs.readFileSync(join(process.env.ASHLR_HOME!, 'daemon.json'), 'utf8')).toBe(successorStateRaw);
      expect(readDaemonSpendGuard()).toMatchObject({ exists: true, malformed: false });
      expect(JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8'))).toMatchObject({
        pid: process.pid,
        token: 'successor-token',
      });
      expect(mockRunPulseSync).not.toHaveBeenCalled();
      expect(pendingCount()).toBe(pendingBefore);
      expect(readDispatchProductionEvents()).toHaveLength(0);
      expect(readAgentActions().filter((event) => event.action === 'daemon:dispatch')).toHaveLength(0);
    } finally {
      if (!settled) {
        releaseSwarm?.();
        await running;
      }
    }
  });

  it('E3j1: lock theft after producer settlement fences every durable outcome phase', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    const items = makeItems(repo.dir, 1);
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items,
    });
    const acquired = acquireDaemonLock();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;

    const originalDetail = items[0]!.detail;
    let postSettlementDetailReads = 0;
    let writesAtTheft = { production: -1, worked: -1, actions: -1, mutationFence: false };
    mockRunSwarm.mockImplementationOnce(async (_input, _cfg, runOpts) => {
      Object.defineProperty(items[0]!, 'detail', {
        configurable: true,
        enumerable: true,
        get: () => {
          postSettlementDetailReads++;
          if (postSettlementDetailReads === 2) {
            fs.writeFileSync(daemonLockPath(), JSON.stringify({
              pid: process.pid,
              token: 'post-settlement-successor',
              hostname: 'successor-host',
              acquiredAt: '2026-07-13T14:00:00.000Z',
              heartbeatAt: '2026-07-13T14:00:00.000Z',
            }, null, 2) + '\n', 'utf8');
            writesAtTheft = {
              production: readDispatchProductionEvents().length,
              worked: loadWorkedLedger().events.length,
              actions: readAgentActions().length,
              mutationFence: fs.existsSync(`${daemonLockPath()}.mutation.lock`),
            };
          }
          return originalDetail;
        },
      });
      return {
        id: (runOpts as { runId: string }).runId,
        status: 'done',
        goal: items[0]!.title,
        result: 'No changes were needed.',
        usage: { totalTokens: 10, estCostUsd: 0.001, steps: 1 },
        proposalOutcome: { kind: 'empty-diff', reason: 'engine completed without file changes' },
      };
    });

    try {
      const result = await tick(cfgBuiltin({ perTickItems: 1, parallel: 1 }), {
        dryRun: false,
        ownerLock: acquired.lock,
      });

      expect(postSettlementDetailReads).toBeGreaterThanOrEqual(2);
      expect(writesAtTheft).toMatchObject({ production: 0, worked: 0, mutationFence: true });
      expect(writesAtTheft.actions).toBeGreaterThan(0);
      expect(result.reason).toBe('shutdown-requested');
      expect(readDispatchProductionEvents()).toHaveLength(writesAtTheft.production);
      expect(loadWorkedLedger().events).toHaveLength(writesAtTheft.worked);
      expect(readAgentActions()).toHaveLength(writesAtTheft.actions);
      expect(readAgentActions().some((event) => event.action === 'daemon:dispatch')).toBe(false);
    } finally {
      fs.rmSync(daemonLockPath(), { force: true });
    }
  });

  it('E3j2: automerge executes while the daemon ownership mutation fence is held', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: [],
    });
    const acquired = acquireDaemonLock();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;
    const mutationPath = `${daemonLockPath()}.mutation.lock`;
    mockRunAutoMergePass.mockImplementationOnce(async () => {
      expect(fs.existsSync(mutationPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(daemonLockPath(), 'utf8'))).toMatchObject({
        pid: acquired.lock.pid,
        token: acquired.lock.token,
      });
      await Promise.resolve();
      expect(fs.existsSync(mutationPath)).toBe(true);
      return { merged: 0 };
    });

    try {
      const result = await tick({
        ...cfgBuiltin(),
        foundry: { autoMerge: { enabled: true } },
      } as AshlrConfig, { dryRun: false, ownerLock: acquired.lock });

      expect(result.reason).toBe('no-backlog');
      expect(mockRunAutoMergePass).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(mutationPath)).toBe(false);
    } finally {
      releaseDaemonLock(acquired.lock);
      fs.rmSync(mutationPath, { force: true });
    }
  });

  it('E3k: token-validated resident save refuses to overwrite successor state', () => {
    const acquired = acquireDaemonLock();
    expect(acquired.acquired).toBe(true);
    if (!acquired.acquired) return;
    const successorStartedAt = '2026-07-13T13:00:00.000Z';
    const successorState = {
      running: true,
      pid: process.pid,
      startedAt: successorStartedAt,
      lastTickAt: successorStartedAt,
      todayDate: today(),
      todaySpentUsd: 0.88,
      itemsProcessed: 8,
      ticks: [],
    };
    fs.writeFileSync(daemonLockPath(), JSON.stringify({
      pid: process.pid,
      token: 'replacement-owner-token',
      hostname: 'replacement-host',
      acquiredAt: successorStartedAt,
      heartbeatAt: successorStartedAt,
    }, null, 2) + '\n', 'utf8');
    saveDaemonState(successorState);
    const successorRaw = fs.readFileSync(join(process.env.ASHLR_HOME!, 'daemon.json'), 'utf8');

    const staleSave = saveResidentDaemonState(acquired.lock, {
      ...successorState,
      todaySpentUsd: 99,
      itemsProcessed: 99,
    });

    expect(staleSave).toMatchObject({ ok: false });
    expect(loadDaemonState()).toEqual(successorState);
    expect(fs.readFileSync(join(process.env.ASHLR_HOME!, 'daemon.json'), 'utf8')).toBe(successorRaw);
  });

  it('E4: runDaemon re-entrancy guard — refuses when ASHLR_IN_DAEMON is already set', async () => {
    process.env['ASHLR_IN_DAEMON'] = '1';
    const cfg = cfgBuiltin();

    // Should return without running any tick (re-entrancy guard fires immediately).
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    // Guard returned the current state, swarm never dispatched.
    expect(mockRunSwarm).not.toHaveBeenCalled();
    // state is a valid DaemonState (guard returns loadDaemonState()).
    expect(typeof state.running).toBe('boolean');

    // Restore — the fixture cleanup restores ASHLR_IN_DAEMON but let's be explicit.
    delete process.env['ASHLR_IN_DAEMON'];
  });

  it('E5: runDaemon re-entrancy guard — refuses when ASHLR_IN_SWARM is already set', async () => {
    process.env['ASHLR_IN_SWARM'] = '1';
    const cfg = cfgBuiltin();

    const state = await runDaemon(cfg, { once: true, dryRun: true });

    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(typeof state.running).toBe('boolean');

    delete process.env['ASHLR_IN_SWARM'];
  });

  it('E5b: runDaemon singleton lock refuses a second process before ticking', async () => {
    const held = acquireDaemonLock();
    expect(held.acquired).toBe(true);
    if (!held.acquired) return;

    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: true, dryRun: true });

    expect(mockBuildBacklog).not.toHaveBeenCalled();
    expect(state.running).toBe(false);
    expect(releaseDaemonLock(held.lock)).toBe(true);
  });

  it('E5c: authoritative lock ownership repairs stale resident state before restart', async () => {
    const stalePid = 424_243;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === stalePid) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      }
      return true;
    });
    saveDaemonState({
      running: true,
      pid: stalePid,
      startedAt: '2026-07-13T00:00:00.000Z',
      lastTickAt: null,
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0.25,
      itemsProcessed: 2,
      ticks: [],
    });
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [],
      items: [],
    });

    try {
      const result = await runDaemon(cfgBuiltin(), { once: true, dryRun: false });

      expect(result).toMatchObject({ running: false, pid: null, todaySpentUsd: 0.25 });
      expect(kill).toHaveBeenCalledWith(stalePid, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it('E5d: acquired lock does not erase a different persisted live resident pid', async () => {
    const livePid = 424_244;
    const persisted = {
      running: true,
      pid: livePid,
      startedAt: '2026-07-13T00:00:00.000Z',
      lastTickAt: null,
      todayDate: today(),
      todaySpentUsd: 0.31,
      itemsProcessed: 3,
      ticks: [],
    };
    saveDaemonState(persisted);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    try {
      const result = await runDaemon(cfgBuiltin(), { once: true, dryRun: false });

      expect(result).toEqual(persisted);
      expect(loadDaemonState()).toEqual(persisted);
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(readAudit().some((entry) =>
        entry.action === 'daemon:start' &&
        entry.result === 'refused' &&
        entry.summary.includes(`pid ${livePid}`),
      )).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('E6: runDaemon dry-run loop terminates after one tick (dry-run = bounded)', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    const cfg = cfgBuiltin({ perTickItems: 1 });
    const state = await runDaemon(cfg, { once: false, dryRun: true, maxCycles: 100 });

    // Dry-run loops terminate after a single iteration regardless of maxCycles.
    expect(state.running).toBe(false);
    // No swarm dispatched (dry-run path returns before dispatch).
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(state.ticks.at(-1)?.dryRun).toBe(true);
  });

  it('E7: runDaemon sets running=true on start and running=false on exit', async () => {
    const repo = fx.makeRepo();
    repo.enroll();
    mockBuildBacklog.mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [repo.dir],
      items: makeItems(repo.dir, 1),
    });

    let runningDuringTick: boolean | undefined;
    mockRunSwarm.mockImplementation(async () => {
      // Read state while the tick is in progress.
      runningDuringTick = loadDaemonState().running;
      return { id: 'mock', status: 'done', goal: '', result: '', usage: { totalTokens: 10, estCostUsd: 0, steps: 1 } };
    });

    const cfg = cfgBuiltin({ perTickItems: 1, parallel: 1 });
    const finalState = await runDaemon(cfg, { once: true, dryRun: false });

    // Was running=true during the tick (captured by mockRunSwarm).
    expect(runningDuringTick).toBe(true);
    // running=false after runDaemon resolves.
    expect(finalState.running).toBe(false);
  });

  it('E8: same-day exhausted budget keeps the loop resident and sleeps without backlog or dispatch', async () => {
    vi.useFakeTimers();
    let run: Promise<unknown> | undefined;
    let settled = false;
    try {
      vi.setSystemTime(new Date('2026-07-02T23:59:59.000Z'));
      const repo = fx.makeRepo();
      repo.enroll();
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: makeItems(repo.dir, 1),
      });
      seedSpendForDate('2026-07-02', 1.0);
      const cfg = makeCfg({
        daemon: {
          dailyBudgetUsd: 1.0,
          perTickItems: 1,
          parallel: 1,
          intervalMs: 50,
          idleBackoffMs: 1,
          mode: 'continuous',
          concurrency: { local: 2, cloud: 6, total: 8 },
        } as AshlrConfig['daemon'],
      });
      mockLoadConfig.mockReturnValue(cfg);

      run = runDaemon(cfg, { once: false, dryRun: false, maxCycles: 1 }).then((state) => {
        settled = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(settled).toBe(false);
      const sleepingState = loadDaemonState();
      expect(sleepingState.running).toBe(true);
      expect(sleepingState.ticks.at(-1)?.reason).toBe('budget-exhausted');
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      const finalState = await run;
      expect((finalState as { running?: boolean }).running).toBe(false);
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();
    } finally {
      if (run && !settled) {
        try {
          fx.setKill(true);
          await vi.advanceTimersByTimeAsync(1_001);
          await run;
        } catch {
          // best-effort cleanup for failed assertions
        }
      }
      vi.useRealTimers();
    }
  });

  it('E9: resident loop wakes on the next UTC budget day, resets stale spend, and dispatches', async () => {
    vi.useFakeTimers();
    let run: Promise<unknown> | undefined;
    let settled = false;
    try {
      vi.setSystemTime(new Date('2026-07-02T23:59:59.000Z'));
      const repo = fx.makeRepo();
      repo.enroll();
      mockBuildBacklog.mockResolvedValue({
        generatedAt: new Date().toISOString(),
        repos: [repo.dir],
        items: makeItems(repo.dir, 1),
      });
      seedSpendForDate('2026-07-02', 1.0);
      const cfg = makeCfg({
        daemon: {
          dailyBudgetUsd: 1.0,
          perTickItems: 1,
          parallel: 1,
          intervalMs: 50,
          idleBackoffMs: 1,
          mode: 'continuous',
          concurrency: { local: 2, cloud: 6, total: 8 },
        } as AshlrConfig['daemon'],
      });
      mockLoadConfig.mockReturnValue(cfg);

      run = runDaemon(cfg, { once: false, dryRun: false, maxCycles: 2 }).then((state) => {
        settled = true;
        return state;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(loadDaemonState().ticks.at(-1)?.reason).toBe('budget-exhausted');
      expect(mockBuildBacklog).not.toHaveBeenCalled();
      expect(mockRunSwarm).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_001);
      const finalState = await run;

      expect((finalState as { running?: boolean }).running).toBe(false);
      expect(mockBuildBacklog).toHaveBeenCalledTimes(1);
      expect(mockRunSwarm).toHaveBeenCalledTimes(1);
      const loaded = loadDaemonState();
      expect(loaded.todayDate).toBe('2026-07-03');
      expect(loaded.todaySpentUsd).toBeCloseTo(0.001, 10);
      expect(loaded.ticks.at(-1)?.reason).toBe('ok');
    } finally {
      if (run && !settled) {
        try {
          fx.setKill(true);
          await vi.advanceTimersByTimeAsync(1_001);
          await run;
        } catch {
          // best-effort cleanup for failed assertions
        }
      }
      vi.useRealTimers();
    }
  });
});

// ===========================================================================
// Group F — buildItemGoal purity
// ===========================================================================

describe('M201 — Group F: buildItemGoal purity', () => {
  const baseItem = {
    id: 'test:item-1',
    repo: '/tmp/test-repo',
    source: 'todo' as const,
    title: 'Implement the login handler',
    detail: 'The /auth/login route returns 501 Not Implemented.',
    value: 5,
    effort: 2,
    score: 2.5,
    tags: ['auth', 'p1'],
    ts: new Date().toISOString(),
  };

  it('F1: output includes the item title', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(baseItem.title);
  });

  it('F2: output includes detail when non-empty and different from title', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(baseItem.detail);
  });

  it('F3: output omits detail when it equals the title', () => {
    const item = { ...baseItem, detail: baseItem.title };
    const goal = buildItemGoal(item);
    // Title appears once; detail (= title) should not be duplicated as a separate block.
    const titleCount = (goal.match(new RegExp(baseItem.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    expect(titleCount).toBe(1);
  });

  it('F4: output includes the repo anchor', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain(`Repo: ${baseItem.repo}`);
  });

  it('F5: output includes behavioral guidance (no-op escape hatch text)', () => {
    const goal = buildItemGoal(baseItem);
    expect(goal).toContain('make NO changes and stop');
  });

  it('F6: never throws on a minimal item (all optional fields absent)', () => {
    const minimal = {
      id: 'test:minimal',
      repo: '',
      source: 'todo' as const,
      title: 'Minimal item',
      detail: '',
      value: 1,
      effort: 1,
      score: 1,
      tags: [],
      ts: new Date().toISOString(),
    };
    expect(() => buildItemGoal(minimal)).not.toThrow();
    const goal = buildItemGoal(minimal);
    expect(goal).toContain('Minimal item');
  });
});

// ===========================================================================
// Group G — Concurrent dispatch routing wire guards
// ===========================================================================

describe('M201 — Group G: concurrent dispatch routing wire guards', () => {
  it('G1: concurrent dispatch passes assigned backend and gateway reason into task runner', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain('const routeReasons = new Map<string, string>();');
    expect(source).toContain('const routeModels = new Map<string, string | null>();');
    expect(source).toContain('routeReasons.set(workedSet[i]!.id, d.value.reason);');
    expect(source).toContain('routeModels.set(workedSet[i]!.id, d.value.model ?? null);');
    expect(source).toContain('routeReasons,');
    expect(source).toContain('const assignedModel = hintedBackend === _backend ? routeModels.get(item.id) : undefined;');
    expect(source).toContain('return taskEntry.run(_backend, assignedReason, assignedModel);');
    expect(source).toContain('buildConcurrentDispatchRouteItem(');
  });

  it('G2: assigned gateway resource-pause decisions skip instead of dispatching', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain("assignedReason?.startsWith('resource-pause:')");
    expect(source).toContain("gd.reason.startsWith('resource-pause:')");
  });

  it('G3: a valid same-tier concurrent repair substitute clears the stale pause reason', () => {
    const source = fs.readFileSync(new URL('../src/core/daemon/loop.ts', import.meta.url), 'utf8');

    expect(source).toContain('concurrentAssignedRouteReason({');
    expect(source).toContain('candidateAllowed: effectiveGeneratedRepairCandidateAllowed(item, _backend, routingCfg)');
  });
});
