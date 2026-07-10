/**
 * loop.ts — The M24 daemon operator.
 *
 * Exports:
 *  - tick(cfg, opts): one operator cycle — check guards, load backlog, dispatch
 *    sandboxed swarms, create PENDING inbox proposals, record spend + state.
 *  - runDaemon(cfg, opts): loop ticks on an interval (or once); REFUSES when
 *    nested; marks running state; stops on kill switch; idles on budget exhaustion.
 *  - stopDaemon(): set kill switch + clear running state.
 *
 * NON-NEGOTIABLE GUARDRAILS (enforced here, grep-provable):
 *  1. PROPOSAL-FIRST (proposal-only by default): every dispatch produces a
 *     PENDING inbox proposal (via the swarm runner or a sandboxed engine, with
 *     { propose: true }) — applied LATER only by explicit human approval. This
 *     file itself imports NO apply / push / PR-create / deploy primitive (the
 *     `daemon-no-primitive` contract). M48: an OPT-IN auto-merge pass
 *     (cfg.foundry.autoMerge.enabled, DEFAULT OFF) is delegated to a SEPARATE
 *     module (fleet/automerge-pass) and may merge a proposal to main ONLY
 *     through the M47 tiered-trust gate (frontier merge-authority + risk ≤
 *     maxRisk + full verify + kill-switch + enrollment). With autoMerge disabled
 *     the daemon stays strictly proposal-only.
 *  2. ENROLLMENT-ONLY: operates exclusively on listEnrolled() repos.
 *     DEFAULT EMPTY => the daemon does NOTHING.
 *  3. SANDBOXED: every runSwarm call sets opts.sandbox = true so all
 *     swarm work runs in an isolated git-worktree (M21).
 *  4. BOUNDED: hard daily USD cap + per-tick item cap + concurrency cap.
 *     Resets per calendar day. NO unbounded loop — every iteration
 *     re-checks kill switch + budget.
 *  5. RE-ENTRANCY: runDaemon REFUSES if ASHLR_IN_DAEMON or ASHLR_IN_SWARM
 *     is already set (no daemon-inside-daemon / daemon-inside-swarm fork bomb).
 *     Sets ASHLR_IN_DAEMON=1 on this process so child spawns inherit it.
 *
 * No new runtime deps; node builtins only; never throws out of public API.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT } from '../types.js';
import type {
  AshlrConfig,
  DaemonConfig,
  DaemonDrainMode,
  DaemonDrainSummary,
  DaemonDispatchProduction,
  DaemonDispatchProductionOutcome,
  DaemonDispatchTrace,
  DaemonState,
  DaemonTick,
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  Proposal,
  RunEventSummary,
  RunProposalOutcome,
  SkillCard,
  WorkItem,
} from '../types.js';
import { resolveAutonomyControlMode, type FleetStatus } from '../fleet/status.js';
import type { EcosystemDoctorReport } from '../ecosystem/doctor.js';
import { killSwitchOn, setKill, listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { buildBacklog, loadBacklog } from '../portfolio/backlog.js';
import { loadQueuedAutonomyItems } from '../portfolio/queued-autonomy.js';
import {
  acquireDaemonLock,
  armDaemonSpendGuard,
  clearDaemonSpendGuard,
  heartbeatDaemonLock,
  loadDaemonState,
  loadDaemonStateStrict,
  readDaemonSpendGuard,
  releaseDaemonLock,
  resetDayIfNeeded,
  saveDaemonState,
  saveDaemonStateResult,
} from './state.js';
import type { DaemonLock } from './state.js';
import { nullSink } from '../run/streaming.js';
import { createOuterAttemptIdentity } from '../fleet/attempt-identity.js';
import { runSwarm } from '../swarm/runner.js';
import { runGoal } from '../run/orchestrator.js';
import { scopeFromWorkItem } from '../run/delegation-scope.js';
import { routeBackend } from '../fleet/router.js';
import { withinLimit, recordUse } from '../fleet/quota.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import { resolveEngineSpec } from '../run/engine-registry.js';
import { subscriptionAllows, isSubscriptionEngine } from '../fleet/subscription-usage.js'; // M80
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.js';
import { decide as gatewayDecide } from '../fabric/gateway.js'; // M247: InferenceGateway
import { buildConcurrentDispatchRouteItem, planConcurrentDispatch, runConcurrentDispatch } from '../fabric/concurrent-dispatch.js'; // M255/M256
import { getResourceSnapshot } from '../fabric/resource-monitor.js'; // M255
import { estimateRun } from '../observability/estimate.js';
import { buildForecast } from '../observability/forecast.js';
import { emitTuningProposals } from '../learn/tuning.js';
import { runAutoMergePass, type AutoMergePassResult } from '../fleet/automerge-pass.js';
import {
  queueProposalRepairWorkForPendingProposals,
  type ProposalRepairWorkResult,
} from '../fleet/proposal-repair-work.js';
import { reconcileRemoteHandoffs, type RemoteHandoffReconcileResult } from '../inbox/remote-handoff.js';
import { runBestOfN } from '../run/best-of-n.js';
import { runSelfHealCycle, runSelfHealCycleForRepos } from '../fleet/self-heal.js';
import { runInventCycle } from '../generative/invent-cycle.js'; // M186
import { runCounterfactualReplay } from '../fleet/counterfactual.js'; // M187
import { detectRegression, bisectAndRevert } from '../fleet/regression-sentinel.js'; // M189
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
import { pendingCount, listProposals } from '../inbox/store.js';
import {
  recordDispatchProduction,
  readDispatchProductionYield,
  type DispatchProductionBasis,
  type DispatchProductionEvent,
} from '../fleet/dispatch-production-ledger.js';
import { buildDispatchManifestEvent, recordDispatchManifest } from '../fleet/dispatch-manifest.js';
import { recordRepairHandoffs, repairHandoffFromDispatchEvent } from '../fleet/repair-handoff-journal.js';
import {
  recordAgentAction,
  type AgentActionEvent,
  type AgentActionOutcome,
} from '../fleet/agent-action-ledger.js';
import {
  causalMetadata,
  evidenceOutcomeSummary,
  routeSnapshot,
  runEventSummary,
} from '../learning/causal.js';
import { productionAttemptLearningLabelFromSignals } from '../learning/attempt-shape.js';
import { readSkillCards } from '../fleet/skill-records.js';
import { observeShadowSkills } from '../fleet/skill-shadow-observer.js';
// worked-ledger is used transitively via LocalWorkQueueCoordinator (selectWorkQueueCoordinator).
import { selectWorkQueueCoordinator, type WorkQueueCoordinator } from '../seams/work-queue-coordinator.js';
// M220: verdict-feedback sweep — feed judge rejections back to the ledger so
// re-clogging items (e.g. "CI is failing") are suppressed for the cooldown window.
import {
  latestWorkedEvent,
  sweepJudgedProposals,
} from '../fleet/worked-ledger.js';
import {
  blockingPendingProposalsForBacklog,
  pendingProposalItemKeysForBacklog,
  workItemCoverageKey,
} from '../fleet/proposal-matching.js';
import { loadConfig } from '../config.js';
import { hostname as osHostname } from 'node:os';
import {
  buildResourceStrategyReport,
  resourceStrategyToDaemonPlan,
  type AutonomousDirectionMode,
  type ResourceStrategyDaemonPlan,
} from '../autonomy/resource-strategy.js';
import {
  applyProductionVelocityProfile,
  availableSlotsForResourceSnapshot,
  daemonQueueSelectionLimit,
  resolveProductionVelocityProfile,
} from '../fabric/production-velocity.js';
import { listOutcomeRecords, listReadyEvidenceOutcomeRecords } from '../autonomy/outcome-records.js';
import { compareReposByStrategicFocus } from '../ecosystem/focus.js';
import {
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from '../fleet/self-heal-trust.js';
import {
  generatedRepairGenerationId,
  generatedRepairCooldownKey,
  recordGeneratedRepairLifecycle,
} from '../fleet/generated-repair-lifecycle.js';

const GENERATED_REPAIR_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GENERATED_REPAIR_RECOVERY_MIN_ATTEMPTS = 3;
const GENERATED_REPAIR_EMPTY_FAST_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_GENERATED_REPAIR_DECISION_EVENTS = 20;

// ---------------------------------------------------------------------------
// DaemonConfig defaults (conservative)
// ---------------------------------------------------------------------------

const DEFAULTS: DaemonConfig = {
  dailyBudgetUsd: 1.0,    // $1/day hard cap by default
  perTickItems: 3,         // at most 3 backlog items per tick
  parallel: 2,             // at most 2 concurrent sandboxed swarms per tick
  intervalMs: 5 * 60_000, // 5-minute tick interval in loop mode
};

const LOCAL_ONLY_BACKENDS = new Set<EngineId>(['builtin', 'local-coder', 'ashlrcode', 'aw']);
const DRAIN_MODE_TAG_PREFIX = 'drain:';
const MAX_DRAIN_SELECTED_IDS = 12;
const MAX_DIAGNOSTIC_RESLICE_DRAIN_LIMIT = 50;
type TickItemOutcome = { item: WorkItem; spentUsd: number; dispatched: boolean; dispatch?: DaemonDispatchTrace };
type BestOfNRunResult = Awaited<ReturnType<typeof runBestOfN>>;
interface TickOptions {
  dryRun: boolean;
  drain?: DaemonDrainMode;
  drainLimit?: number;
}
interface DaemonRunOptions extends TickOptions {
  once: boolean;
  maxCycles?: number;
}

function autonomyControlEnabled(cfg: AshlrConfig): boolean {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (!foundry) return false;
  return foundry['autonomyControlLoop'] !== false;
}

function reloadLiveConfigForDaemon(fallbackCfg: AshlrConfig): AshlrConfig {
  try {
    return loadConfig();
  } catch {
    return fallbackCfg;
  }
}

function cachedBacklogCountForEnrolledRepos(enrolled: string[]): number {
  try {
    const enrolledRepos = new Set(enrolled.map((repo) => resolve(repo)).filter((repo) => existsSync(repo)));
    if (enrolledRepos.size === 0) return 0;
    const backlog = loadBacklog();
    const items = [
      ...(Array.isArray(backlog?.items) ? backlog.items : []),
      ...loadQueuedAutonomyItems(),
    ];
    const seen = new Set<string>();
    let count = 0;
    for (const item of items) {
      const repo = resolve(item.repo);
      if (!enrolledRepos.has(repo)) continue;
      const key = `${repo}\0${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function constrainToLocalBackends(cfg: AshlrConfig): AshlrConfig {
  const foundry = cfg.foundry;
  if (!foundry) {
    return { ...cfg, foundry: { allowedBackends: ['builtin'] } };
  }
  const current: EngineId[] = foundry.allowedBackends?.length ? foundry.allowedBackends : ['builtin'];
  const allowedBackends = current.filter((backend) => LOCAL_ONLY_BACKENDS.has(backend));
  return {
    ...cfg,
    foundry: {
      ...foundry,
      allowedBackends: allowedBackends.length > 0 ? allowedBackends : ['builtin'],
    },
  };
}

function enforceLocalBackend(backend: EngineId, plan: ResourceStrategyDaemonPlan | null): EngineId {
  return plan?.forceLocalOnly === true && !LOCAL_ONLY_BACKENDS.has(backend) ? 'builtin' : backend;
}

function configuredModelForBackend(backend: EngineId, cfg: AshlrConfig): string | null {
  const model = cfg.foundry?.models?.[backend];
  return typeof model === 'string' && model.trim() ? model : null;
}

function startDaemonLockHeartbeat(lock: DaemonLock): () => void {
  const interval = setInterval(() => {
    heartbeatDaemonLock(lock);
  }, 30_000);
  (interval as { unref?: () => void }).unref?.();
  return () => clearInterval(interval);
}

function lastProducerMaintenanceAtMs(state: DaemonState): number | null {
  for (let i = state.ticks.length - 1; i >= 0; i--) {
    const tick = state.ticks[i];
    if (!tick) continue;
    const maintenance = tick.producerMaintenance;
    if (!maintenance) continue;
    if (!maintenance.selfHeal && !maintenance.invent && !maintenance.ancillary) continue;
    const parsed = Date.parse(tick.ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function lightweightEcosystemReport(now: Date | undefined, root: string | undefined): EcosystemDoctorReport {
  return {
    generatedAt: (now ?? new Date()).toISOString(),
    root: root ?? process.cwd(),
    summary: { pass: 0, warn: 1, fail: 0, total: 1, repos: 0 },
    checks: [{
      id: 'ecosystem-doctor',
      label: 'Ecosystem doctor',
      status: 'warn',
      detail: 'skipped during daemon autonomy control tick; run `ashlr fleet direction` for full report',
    }],
    repos: [],
  };
}

function buildTickFleetStatus(
  cfg: AshlrConfig,
  state: DaemonState,
  backlogItems: number,
  guardHealth: FleetStatus['guardHealth'],
): FleetStatus {
  let pending = 0;
  let frontierPending = 0;
  let awaitingHostMerge = 0;
  let applied = 0;
  try {
    for (const proposal of listProposals()) {
      if (proposal.status === 'pending') {
        pending++;
        if (proposal.engineTier === 'frontier') frontierPending++;
      } else if (proposal.status === 'applied') {
        applied++;
      } else if (proposal.status === 'awaiting-host-merge') {
        awaitingHostMerge++;
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    awaitingHostMerge = 0;
    applied = 0;
  }

  const recentTicks = Array.isArray(state.ticks) ? state.ticks : [];
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  let recentMerges = 0;
  for (const tickRecord of recentTicks) {
    if (typeof tickRecord.merged !== 'number' || tickRecord.merged <= 0) continue;
    const tickMs = Date.parse(tickRecord.ts);
    if (Number.isNaN(tickMs) || tickMs >= recentCutoff) recentMerges += tickRecord.merged;
  }

  return {
    generatedAt: new Date().toISOString(),
    daemon: {
      running: state.running === true,
      lastTickAt: state.lastTickAt ?? null,
      todaySpentUsd: typeof state.todaySpentUsd === 'number' ? state.todaySpentUsd : 0,
    },
    backends: (cfg.foundry?.allowedBackends ?? ['builtin']).map((backend) => ({
      backend,
      dispatchesRecent: 0,
      quota: 'unlimited',
    })),
    queue: { backlogItems },
    proposals: { pending, frontierPending, ...(awaitingHostMerge > 0 ? { awaitingHostMerge } : {}), applied },
    merges: { recent: recentMerges },
    autonomyControlMode: resolveAutonomyControlMode(cfg),
    ...(guardHealth !== undefined ? { guardHealth } : {}),
    killed: false,
  };
}

async function buildDaemonStrategyPlan(
  cfg: AshlrConfig,
  state: DaemonState,
  backlogItems: number,
): Promise<ResourceStrategyDaemonPlan> {
  const { diagnoseGuardHealth } = await import('./guard-health.js');
  const guardHealth = diagnoseGuardHealth();
  const productionVelocity = resolveProductionVelocityProfile(cfg);
  const report = await buildResourceStrategyReport(cfg, {
	    maxOutcomes: 6,
	    maxChecks: 1,
	    deps: {
      buildFleetStatus: async () => buildTickFleetStatus(cfg, state, backlogItems, guardHealth),
      runEcosystemDoctor: async (opts) => lightweightEcosystemReport(opts?.now, opts?.root),
      diagnoseGuardHealth: () => guardHealth,
      listOutcomeRecords: cfg.foundry?.autoMerge?.enabled === true
        ? (opts) => listReadyEvidenceOutcomeRecords({ limit: Math.min(opts?.limit ?? 6, 6) })
        : productionVelocity.enabled
          ? (opts) => listOutcomeRecords({
              limit: Math.min(opts?.limit ?? 6, 6),
              deps: { loadWorkedLedger: () => ({ events: [] }) },
            })
        : () => [],
    },
  });
  return resourceStrategyToDaemonPlan(report);
}

function autoMergeTickSummary(result: AutoMergePassResult | null): DaemonTick['autoMerge'] | undefined {
  if (!result) return undefined;
  const attempted = typeof result.attempted === 'number' ? result.attempted : 0;
  const judgePerPass = typeof result.judgePerPass === 'number' ? result.judgePerPass : 0;
  const judged = typeof result.judged === 'number' ? result.judged : 0;
  const judgeCapped = typeof result.judgeCapped === 'number' ? result.judgeCapped : 0;
  const verifyBeforeJudgePerPass = typeof result.verifyBeforeJudgePerPass === 'number'
    ? result.verifyBeforeJudgePerPass
    : 0;
  const verifyBeforeJudgeRan = typeof result.verifyBeforeJudgeRan === 'number' ? result.verifyBeforeJudgeRan : 0;
  const verifyBeforeJudgeCapped = typeof result.verifyBeforeJudgeCapped === 'number' ? result.verifyBeforeJudgeCapped : 0;
  const judgeEstimatedSpendUsd = typeof result.judgeEstimatedSpendUsd === 'number'
    ? Math.max(0, result.judgeEstimatedSpendUsd)
    : 0;
  const merged = typeof result.merged === 'number' ? result.merged : 0;
  const handoffs = typeof result.handoffs === 'number' ? result.handoffs : 0;
  const autoArchived = typeof result.autoArchived === 'number' ? result.autoArchived : 0;
  const ttlRejected = typeof result.ttlRejected === 'number' ? result.ttlRejected : 0;
  const invalidRejected = typeof result.invalidRejected === 'number' ? result.invalidRejected : 0;
  if (
    attempted <= 0 &&
    judged <= 0 &&
    judgeCapped <= 0 &&
    verifyBeforeJudgeRan <= 0 &&
    verifyBeforeJudgeCapped <= 0 &&
    merged <= 0 &&
    handoffs <= 0 &&
    autoArchived <= 0 &&
    ttlRejected <= 0 &&
    invalidRejected <= 0
  ) return undefined;
  return {
    attempted,
    ...(judgePerPass > 0 ? { judgePerPass } : {}),
    judged,
    ...(judgeCapped > 0 ? { judgeCapped } : {}),
    ...(verifyBeforeJudgePerPass > 0 ? { verifyBeforeJudgePerPass } : {}),
    ...(verifyBeforeJudgeRan > 0 ? { verifyBeforeJudgeRan } : {}),
    ...(verifyBeforeJudgeCapped > 0 ? { verifyBeforeJudgeCapped } : {}),
    ...(judgeEstimatedSpendUsd > 0 ? { judgeEstimatedSpendUsd } : {}),
    merged,
    ...(handoffs > 0 ? { handoffs } : {}),
    ...(autoArchived > 0 ? { autoArchived } : {}),
    ...(ttlRejected > 0 ? { ttlRejected } : {}),
    ...(invalidRejected > 0 ? { invalidRejected } : {}),
  };
}

function remoteHandoffTickSummary(
  result: RemoteHandoffReconcileResult | null,
): DaemonTick['remoteHandoff'] | undefined {
  if (!result) return undefined;
  const checked = typeof result.checked === 'number' ? result.checked : 0;
  const merged = typeof result.merged === 'number' ? result.merged : 0;
  const closed = typeof result.closed === 'number' ? result.closed : 0;
  const open = typeof result.open === 'number' ? result.open : 0;
  const unknown = typeof result.unknown === 'number' ? result.unknown : 0;
  if (checked <= 0 && merged <= 0 && closed <= 0 && open <= 0 && unknown <= 0) return undefined;
  return { checked, merged, closed, open, unknown };
}

function boundedText(value: string, max = 220): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function drainTag(mode: DaemonDrainMode): string {
  return `${DRAIN_MODE_TAG_PREFIX}${mode}`;
}

function isDrainCandidate(item: WorkItem, mode: DaemonDrainMode): boolean {
  switch (mode) {
    case 'diagnostic-reslices':
      return isTrustedDiagnosticResliceItem(item);
  }
}

function normalizeDrainLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.max(1, Math.min(MAX_DIAGNOSTIC_RESLICE_DRAIN_LIMIT, Math.floor(value)));
}

function resolveDrainLimit(
  cfg: AshlrConfig,
  mode: DaemonDrainMode | undefined,
  explicitLimit?: number,
): number | undefined {
  if (!mode) return undefined;
  const explicit = normalizeDrainLimit(explicitLimit);
  if (explicit !== undefined) return explicit;
  switch (mode) {
    case 'diagnostic-reslices': {
      const configured = normalizeDrainLimit(cfg.daemon?.drainLimits?.diagnosticReslices);
      return configured ?? DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT;
    }
  }
}

function canAutoDrainDiagnosticReslices(
  opts: TickOptions,
  plan: ResourceStrategyDaemonPlan | null,
): boolean {
  if (opts.drain !== undefined) return false;
  if (opts.dryRun) return false;
  if (!plan) return true;
  if (!plan.allowDispatch) return false;
  return plan.mode === 'backlog-build' || plan.mode === 'local-only';
}

function drainSummary(
  mode: DaemonDrainMode,
  availableItems: WorkItem[],
  selectedItems: WorkItem[],
  limit?: number,
  automatic?: boolean,
): DaemonDrainSummary {
  const selectedItemIds = selectedItems
    .map((item) => boundedText(item.id, 120))
    .slice(0, MAX_DRAIN_SELECTED_IDS);
  const capped = typeof limit === 'number' && availableItems.length > selectedItems.length && selectedItems.length >= limit;
  return {
    mode,
    available: availableItems.length,
    selected: selectedItems.length,
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(capped ? { capped: true } : {}),
    ...(automatic ? { automatic: true } : {}),
    ...(selectedItemIds.length > 0 ? { selectedItemIds } : {}),
    ...(availableItems.length > 0 && selectedItems.length === 0 ? { stalled: true } : {}),
  };
}

function recordDrainSelectionAgentAction(fields: {
  ts: string;
  mode: DaemonDrainMode;
  available: number;
  selectedItems: WorkItem[];
  limit?: number;
  capped?: boolean;
  machineId: string;
  dryRun: boolean;
  automatic?: boolean;
}): void {
  const selectedIds = fields.selectedItems.map((item) => boundedText(item.id, 120));
  const selectedSummary = selectedIds.length > 0
    ? ` ids=${selectedIds.slice(0, MAX_DRAIN_SELECTED_IDS).join(',')}`
    : '';
  const limitSummary = typeof fields.limit === 'number' ? ` limit=${fields.limit}` : '';
  recordAgentAction({
    schemaVersion: 1,
    ts: fields.ts,
    machineId: fields.machineId,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: fields.selectedItems.length > 0 ? 'ok' : 'skipped',
    action: 'daemon:drain-select',
    summary:
      `drain ${fields.mode}: selected ${fields.selectedItems.length}/` +
      `${fields.available}${limitSummary}${selectedSummary}`,
    reason: fields.dryRun ? 'dry-run' : fields.automatic ? 'auto-live' : 'live',
    ...(selectedIds[0] ? { itemId: selectedIds[0] } : {}),
    tags: [
      'drain-select',
      drainTag(fields.mode),
      fields.automatic ? 'auto-drain' : 'explicit-drain',
      fields.selectedItems.length > 0 ? 'selected' : 'none-selected',
      ...(fields.capped ? ['capped'] : []),
      ...(fields.dryRun ? ['dry-run'] : []),
    ],
    counts: {
      available: fields.available,
      selected: fields.selectedItems.length,
      ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}),
      ...(fields.capped ? { capped: 1 } : {}),
      ...(fields.automatic ? { automatic: 1 } : {}),
    },
  });
}

function recordQueueSelectionAgentAction(fields: {
  ts: string;
  machineId: string;
  dryRun: boolean;
  drainMode?: DaemonDrainMode;
  automaticDrain: boolean;
  backlogItems: number;
  eligibleItems: number;
  pendingBlocked: number;
  cooldownBlocked: number;
  fastRepairCooldown: number;
  rawSelectCount: number;
  selectCount: number;
  selectedItems: WorkItem[];
  claimedItems: WorkItem[];
}): void {
  const first = fields.claimedItems[0] ?? fields.selectedItems[0];
  const lane = fields.drainMode ? `drain ${fields.drainMode}` : 'normal';
  recordAgentAction({
    schemaVersion: 1,
    ts: fields.ts,
    machineId: fields.machineId,
    actor: 'daemon',
    kind: 'selection',
    outcome: fields.claimedItems.length > 0
      ? 'ok'
      : fields.eligibleItems > 0
        ? 'blocked'
        : 'skipped',
    action: 'daemon:selection',
    summary:
      `${lane}: claimed ${fields.claimedItems.length}/${fields.selectedItems.length} ` +
      `from ${fields.eligibleItems}/${fields.backlogItems} eligible; ` +
      `cooldown ${fields.cooldownBlocked}, pending ${fields.pendingBlocked}`,
    reason: fields.dryRun ? 'dry-run' : fields.claimedItems.length > 0 ? 'selected' : 'no-claim',
    ...(first?.repo ? { repo: first.repo } : {}),
    ...(first?.id ? { itemId: boundedText(first.id, 120) } : {}),
    ...(first?.source ? { source: first.source } : {}),
    tags: [
      'selection',
      fields.drainMode ? drainTag(fields.drainMode) : 'normal-selection',
      fields.automaticDrain ? 'auto-drain' : 'regular',
      fields.dryRun ? 'dry-run' : 'live',
      fields.claimedItems.length > 0 ? 'claimed' : 'none-claimed',
      fields.fastRepairCooldown > 0 ? 'fast-repair-cooldown' : 'standard-cooldown',
    ],
    counts: {
      backlogItems: fields.backlogItems,
      eligibleItems: fields.eligibleItems,
      pendingBlocked: fields.pendingBlocked,
      cooldownBlocked: fields.cooldownBlocked,
      fastRepairCooldown: fields.fastRepairCooldown,
      rawSelectCount: fields.rawSelectCount,
      selectCount: fields.selectCount,
      selected: fields.selectedItems.length,
      claimed: fields.claimedItems.length,
    },
  });
}

function recordGeneratedRepairDecisionAgentActions(fields: {
  ts: string;
  machineId: string;
  dryRun: boolean;
  items: WorkItem[];
  selectedItems: WorkItem[];
  claimedItems: WorkItem[];
  pendingItemKeys: Set<string>;
  coordinator: WorkQueueCoordinator;
  baseCooldownMs: number;
  repairRecoveryHealthy: boolean;
}): void {
  const selectedIds = new Set(fields.selectedItems.map((item) => item.id));
  const claimedIds = new Set(fields.claimedItems.map((item) => item.id));
  const generatedItems = fields.items
    .filter((item) => isTrustedGeneratedRepairItem(item))
    .slice(0, MAX_GENERATED_REPAIR_DECISION_EVENTS);
  if (generatedItems.length === 0) return;
  recordAgentAction(generatedItems.map((item): AgentActionEvent => {
    const pendingBlocked = fields.pendingItemKeys.has(workItemCoverageKey(item));
    const effectiveCooldownMs = cooldownMsForSelectionItem(
      item,
      fields.baseCooldownMs,
      fields.repairRecoveryHealthy,
    );
    const cooldownKey = generatedRepairCooldownKey(item);
    const cooldownBlocked = fields.coordinator.shouldSkip(cooldownKey, effectiveCooldownMs);
    const selected = selectedIds.has(item.id);
    const claimed = claimedIds.has(item.id);
    const latest = latestWorkedEvent(cooldownKey);
    const fastRepairCooldown = effectiveCooldownMs < fields.baseCooldownMs;
    const reason = claimed
      ? 'claimed'
      : selected
        ? 'claim-missed'
        : pendingBlocked
          ? 'pending-proposal'
          : cooldownBlocked
            ? `cooldown: latest=${latest?.outcome ?? 'unknown'}`
            : 'not-selected';
    const outcome: AgentActionOutcome = claimed
      ? 'ok'
      : (selected || pendingBlocked || cooldownBlocked)
        ? 'blocked'
        : 'skipped';
    return {
      schemaVersion: 1,
      ts: fields.ts,
      machineId: fields.machineId,
      actor: 'daemon',
      kind: 'selection',
      outcome,
      action: 'daemon:generated-repair-decision',
      summary:
        `generated repair ${reason}; selected ${selected ? 1 : 0}, ` +
        `claimed ${claimed ? 1 : 0}, pending ${pendingBlocked ? 1 : 0}, ` +
        `cooldown ${cooldownBlocked ? 1 : 0}`,
      reason,
      repo: item.repo,
      itemId: boundedText(item.id, 120),
      source: item.source,
      tags: [
        'generated-repair-decision',
        selected ? 'selected' : 'not-selected',
        claimed ? 'claimed' : 'not-claimed',
        pendingBlocked ? 'pending-blocked' : 'pending-clear',
        cooldownBlocked ? 'cooldown-blocked' : 'cooldown-clear',
        fastRepairCooldown ? 'fast-repair-cooldown' : 'standard-cooldown',
        fields.dryRun ? 'dry-run' : 'live',
        ...(latest?.outcome ? [`latest-${latest.outcome}`] : ['latest-none']),
      ],
      counts: {
        baseCooldownMs: fields.baseCooldownMs,
        effectiveCooldownMs,
        fastRepairCooldown: fastRepairCooldown ? 1 : 0,
        pendingBlocked: pendingBlocked ? 1 : 0,
        cooldownBlocked: cooldownBlocked ? 1 : 0,
        selected: selected ? 1 : 0,
        claimed: claimed ? 1 : 0,
      },
    };
  }));
}

function productionOutcomeFromRunProposalOutcome(kind: RunProposalOutcome['kind']): DaemonDispatchProductionOutcome {
  switch (kind) {
    case 'filed':
      return 'proposal-created';
    case 'empty-diff':
      return 'empty-diff';
    case 'trivial-proposal':
    case 'completeness-gate':
    case 'partial-completeness-gate':
      return 'gate-blocked';
    case 'sandbox-unavailable':
    case 'kill-switch':
      return 'sandbox-failed';
    case 'proposal-capture-error':
      return 'proposal-capture-error';
    case 'proposal-disabled':
      return 'proposal-disabled';
    case 'api-model-task-failed':
    case 'engine-command-missing':
    case 'engine-failed-no-diff':
    case 'engine-unsupported':
      return 'engine-failed';
    default:
      return 'unknown';
  }
}

function dispatchProductionFromProposalOutcome(
  outcome: RunProposalOutcome | undefined,
  runId?: string,
  summary?: RunEventSummary,
  options: { proposalRequired?: boolean; evidenceOutcome?: EvidenceOutcomeSummary } = {},
): DaemonDispatchProduction | undefined {
  if (!outcome) return undefined;
  const diffFiles =
    nonNegativeCount(outcome.files) ??
    nonNegativeCount(summary?.diffFiles) ??
    nonNegativeCount(summary?.actionCounts?.diffFiles);
  const diffLines =
    typeof outcome.insertions === 'number' || typeof outcome.deletions === 'number'
      ? Math.max(0, Math.trunc((outcome.insertions ?? 0) + (outcome.deletions ?? 0)))
      : nonNegativeCount(summary?.diffLines) ?? nonNegativeCount(summary?.actionCounts?.diffLines);
  const captureMissingReason = requiredProposalCaptureMissingReason(outcome, summary, options);
  const failedPartialArtifact = outcome.kind === 'filed' && outcome.isPartial === true;
  const productionOutcome: DaemonDispatchProductionOutcome = captureMissingReason
    ? 'proposal-capture-error'
    : failedPartialArtifact
      ? 'gate-blocked'
      : productionOutcomeFromRunProposalOutcome(outcome.kind);
  const reason = captureMissingReason
    ? captureMissingReason
    : failedPartialArtifact
      ? `partial artifact filed after ${summary?.status ?? 'unknown'} producer: ${outcome.reason}`
      : outcome.reason;
  const evidence = evidenceOutcomeSummary(options.evidenceOutcome);
  return {
    outcome: productionOutcome,
    ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...(summary ? { runEventSummary: summary } : {}),
    ...(evidence ? { evidenceOutcome: evidence } : {}),
    ...(reason ? { reason: boundedText(reason, 220) } : {}),
    ...(typeof diffFiles === 'number' ? { diffFiles } : {}),
    ...(typeof diffLines === 'number' ? { diffLines } : {}),
  };
}

function nonNegativeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function positiveCount(value: unknown): number {
  return nonNegativeCount(value) ?? 0;
}

function hasDiffMetadata(outcome: RunProposalOutcome, summary: RunEventSummary | undefined): boolean {
  const counts = summary?.actionCounts;
  const outcomeLines = (outcome.insertions ?? 0) + (outcome.deletions ?? 0);
  return positiveCount(outcome.files) > 0 ||
    positiveCount(outcomeLines) > 0 ||
    positiveCount(summary?.diffFiles) > 0 ||
    positiveCount(summary?.diffLines) > 0 ||
    positiveCount(counts?.diffFiles) > 0 ||
    positiveCount(counts?.diffLines) > 0;
}

function requiredProposalCaptureMissingReason(
  outcome: RunProposalOutcome,
  summary: RunEventSummary | undefined,
  options: { proposalRequired?: boolean },
): string | undefined {
  if (options.proposalRequired !== true) return undefined;
  if (outcome.kind !== 'proposal-disabled') return undefined;
  const counts = summary?.actionCounts;
  const captureAttempts = positiveCount(counts?.proposalCaptureAttempts);
  if (captureAttempts > 0) return undefined;
  if (summary?.proposalCreated === true) return undefined;
  if (summary?.status !== undefined && summary.status !== 'done') {
    return 'capture-missing: required proposal dispatch ended before final capture';
  }
  if (hasDiffMetadata(outcome, summary)) {
    return 'capture-missing: required proposal dispatch produced changes without proposal filing';
  }
  return undefined;
}

export function workedOutcomeFromDispatchProduction(
  production: DaemonDispatchProduction | undefined,
): 'diff' | 'empty' | undefined {
  if (!production) return undefined;
  if (production.outcome === 'proposal-disabled') return undefined;
  return production.outcome === 'proposal-created' ? 'diff' : 'empty';
}

function productionReason(production: DaemonDispatchProduction): string {
  return production.reason
    ? `${production.outcome}: ${production.reason}`
    : production.outcome;
}

function noProposalProductionReason(production: DaemonDispatchProduction | undefined): string | undefined {
  if (!production || production.outcome === 'proposal-created') return undefined;
  return boundedText(productionReason(production), 160);
}

function noProposalOutcomeFromReason(reason: string): DaemonDispatchProductionOutcome {
  if (/\bempty-diff\b/i.test(reason)) return 'empty-diff';
  if (/\b(trivial-proposal|trivial|completeness-gate|gate-blocked|gate)\b/i.test(reason)) return 'gate-blocked';
  if (/\b(sandbox-unavailable|sandbox)\b/i.test(reason)) return 'sandbox-failed';
  if (/\b(proposal-capture-error|capture)\b/i.test(reason)) return 'proposal-capture-error';
  if (/\b(proposal-disabled)\b/i.test(reason)) return 'proposal-disabled';
  if (/\b(engine|api-model-task-failed|command-missing|unsupported|failed)\b/i.test(reason)) return 'engine-failed';
  return 'unknown';
}

function bestOfNNoWinnerProduction(result: BestOfNRunResult, n: number): DaemonDispatchProduction {
  const top = result.critique.noProposalReasons?.[0]?.reason;
  const reason = top
    ? `best-of-${n}: ${top}`
    : `best-of-${n}: all candidates failed to produce a proposal`;
  return {
    outcome: noProposalOutcomeFromReason(reason),
    reason: boundedText(reason, 220),
  };
}

function dispatchProductionBasis(
  production: DaemonDispatchProduction | undefined,
  proposal: Proposal | undefined,
): DispatchProductionBasis {
  if (production) {
    if (production.reason?.startsWith('best-of-')) return 'best-of-n-summary';
    return 'run-proposal-outcome';
  }
  if (proposal) return 'pending-proposal-delta';
  return 'unknown';
}

function dispatchProductionEventFromOutcome(
  value: TickItemOutcome,
  proposal: Proposal | undefined,
  machineId: string,
  ts: string,
): DispatchProductionEvent | null {
  if (!value.dispatched) return null;
  const trace = value.dispatch;
  if (!trace) return null;
  const production = trace.production;
  const outcome: DaemonDispatchProductionOutcome =
    production?.outcome ?? (proposal ? 'proposal-created' : 'unknown');
  const allowProposalFallback = !production || production.outcome === 'proposal-created';
  const proposalId = production?.proposalId ?? (allowProposalFallback ? proposal?.id : undefined);
  const runId = production?.runId ?? (allowProposalFallback ? proposal?.runId : undefined) ?? trace.runId;
  const proposalCreated = outcome === 'proposal-created';
  const eventRunSummary = runEventSummary({
    ...(trace.runEventSummary ?? {}),
    runId,
    outcome,
    proposalCreated,
    proposalId,
    diffFiles: production?.diffFiles ?? trace.runEventSummary?.diffFiles,
    diffLines: production?.diffLines ?? trace.runEventSummary?.diffLines,
    costUsd: value.spentUsd,
  });
  const learningLabel = productionAttemptLearningLabelFromSignals({
    outcome,
    proposalCreated,
    actionCounts: eventRunSummary?.actionCounts,
    reason: production?.reason ?? trace.skipReason,
    itemId: value.item.id,
    title: value.item.title,
    source: value.item.source,
  });
  return {
    schemaVersion: 1,
    ts,
    machineId,
    itemId: value.item.id,
    source: value.item.source,
    repo: value.item.repo,
    title: value.item.title,
    backend: trace.backend,
    tier: trace.tier,
    ...(trace.model !== undefined ? { model: trace.model } : {}),
    assignedBy: trace.assignedBy,
    routeReason: trace.reason,
    outcome,
    proposalCreated,
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...(trace.trajectoryId ? { trajectoryId: trace.trajectoryId } : {}),
    ...(trace.routeSnapshot ? { routeSnapshot: trace.routeSnapshot } : {}),
    ...(eventRunSummary ? { runEventSummary: eventRunSummary } : {}),
    ...(production?.evidenceOutcome ? { evidenceOutcome: production.evidenceOutcome } : {}),
    ...(trace.learningSource ? { learningSource: trace.learningSource } : {}),
    ...(trace.labelBasis ? { labelBasis: trace.labelBasis } : {}),
    ...(trace.routerPolicyVersion ? { routerPolicyVersion: trace.routerPolicyVersion } : {}),
    ...(trace.learningEpoch ? { learningEpoch: trace.learningEpoch } : {}),
    learningLabel,
    spentUsd: value.spentUsd,
    ...(typeof production?.diffFiles === 'number' ? { diffFiles: production.diffFiles } : {}),
    ...(typeof production?.diffLines === 'number' ? { diffLines: production.diffLines } : {}),
    ...(production?.reason ? { reason: production.reason } : trace.skipReason ? { reason: trace.skipReason } : {}),
    basis: dispatchProductionBasis(production, proposal),
  };
}

function agentOutcomeFromDispatchEvent(event: DispatchProductionEvent): AgentActionOutcome {
  if (event.proposalCreated) return 'proposal-created';
  switch (event.outcome) {
    case 'empty-diff':
    case 'gate-blocked':
    case 'proposal-disabled':
      return 'no-proposal';
    case 'engine-failed':
    case 'sandbox-failed':
    case 'proposal-capture-error':
      return 'failed';
    case 'proposal-created':
      return 'proposal-created';
    default:
      return 'unknown';
  }
}

function agentActionFromDispatchEvent(event: DispatchProductionEvent): AgentActionEvent {
  const outcome = agentOutcomeFromDispatchEvent(event);
  return {
    schemaVersion: 1,
    ts: event.ts,
    ...(event.machineId ? { machineId: event.machineId } : {}),
    actor: 'daemon',
    kind: 'dispatch',
    outcome,
    action: 'daemon:dispatch',
    summary: `${event.backend ?? 'unknown'} ${event.outcome} for ${event.title}`,
    repo: event.repo,
    itemId: event.itemId,
    source: event.source,
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.trajectoryId ? { trajectoryId: event.trajectoryId } : {}),
    ...(event.routeSnapshot ? { routeSnapshot: event.routeSnapshot } : {}),
    ...(event.runEventSummary ? { runEventSummary: event.runEventSummary } : {}),
    ...(event.evidenceOutcome ? { evidenceOutcome: event.evidenceOutcome } : {}),
    ...(event.learningSource ? { learningSource: event.learningSource } : {}),
    ...(event.labelBasis ? { labelBasis: event.labelBasis } : {}),
    ...(event.routerPolicyVersion ? { routerPolicyVersion: event.routerPolicyVersion } : {}),
    ...(event.learningEpoch ? { learningEpoch: event.learningEpoch } : {}),
    ...(event.learningLabel ? { learningLabel: event.learningLabel } : {}),
    backend: event.backend,
    tier: event.tier,
    ...(event.model !== undefined ? { model: event.model } : {}),
    reason: event.reason ?? event.routeReason,
    spentUsd: event.spentUsd,
    tags: [event.source, event.outcome, event.basis],
    counts: {
      ...(typeof event.diffFiles === 'number' ? { diffFiles: event.diffFiles } : {}),
      ...(typeof event.diffLines === 'number' ? { diffLines: event.diffLines } : {}),
      proposalCreated: event.proposalCreated ? 1 : 0,
    },
  };
}

function agentActionFromDispatchSkip(
  value: TickItemOutcome,
  ts: string,
  machineId: string,
): AgentActionEvent | null {
  if (value.dispatched) return null;
  const trace = value.dispatch;
  if (!trace) return null;
  const skipReason = trace.skipReason ?? trace.reason ?? 'skipped-before-dispatch';
  return {
    schemaVersion: 1,
    ts,
    machineId,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'skipped',
    action: 'daemon:dispatch-skip',
    summary: `dispatch skipped: ${boundedText(skipReason, 120)}`,
    repo: value.item.repo,
    itemId: value.item.id,
    source: value.item.source,
    ...(trace.trajectoryId ? { trajectoryId: trace.trajectoryId } : {}),
    ...(trace.routeSnapshot ? { routeSnapshot: trace.routeSnapshot } : {}),
    ...(trace.runEventSummary ? { runEventSummary: trace.runEventSummary } : {}),
    ...(trace.learningSource ? { learningSource: trace.learningSource } : {}),
    ...(trace.labelBasis ? { labelBasis: trace.labelBasis } : {}),
    ...(trace.routerPolicyVersion ? { routerPolicyVersion: trace.routerPolicyVersion } : {}),
    ...(trace.learningEpoch ? { learningEpoch: trace.learningEpoch } : {}),
    backend: trace.backend,
    tier: trace.tier,
    ...(trace.model !== undefined ? { model: trace.model } : {}),
    reason: skipReason,
    spentUsd: 0,
    tags: [
      'dispatch-skip',
      value.item.source,
      boundedText(skipReason, 48),
      ...(isTrustedGeneratedRepairItem(value.item) ? ['generated-repair'] : []),
    ],
    counts: {
      dispatched: 0,
      selected: 1,
    },
  };
}

function tickAgentOutcome(tick: DaemonTick): AgentActionOutcome {
  if (tick.reason === 'ok') return 'ok';
  if (tick.reason === 'state-persistence-failed') return 'failed';
  if (tick.reason === 'kill-switch' || tick.reason === 'pause' || tick.reason === 'verify-only') return 'blocked';
  if (tick.reason === 'no-backlog' || tick.reason === 'no-enrolled-repos' || tick.reason === 'budget-exhausted' || tick.reason === 'dry-run') {
    return 'skipped';
  }
  return 'unknown';
}

function recordTickAgentAction(tick: DaemonTick, machineId?: string): void {
  recordAgentAction({
    schemaVersion: 1,
    ts: tick.ts,
    machineId: machineId ?? osHostname(),
    actor: 'daemon',
    kind: 'tick',
    outcome: tickAgentOutcome(tick),
    action: 'daemon:tick',
    summary:
      `${tick.reason}: considered ${tick.itemsConsidered}, proposals ${tick.proposalsCreated}, ` +
      `spent $${tick.spentUsd.toFixed(4)}`,
    reason: tick.directionReason ?? tick.reason,
    durationMs: tick.durationMs,
    spentUsd: tick.spentUsd,
    tags: [
      tick.reason,
      ...(tick.directionMode ? [tick.directionMode] : []),
      ...(tick.dryRun ? ['dry-run'] : []),
      ...(tick.drain ? [drainTag(tick.drain.mode)] : []),
      ...(tick.drain?.stalled ? ['drain-stalled'] : []),
    ],
    counts: {
      itemsConsidered: tick.itemsConsidered,
      proposalsCreated: tick.proposalsCreated,
      ...(typeof tick.merged === 'number' ? { merged: tick.merged } : {}),
      ...(tick.proposalProduction ? { dispatched: tick.proposalProduction.dispatched } : {}),
      ...(tick.proposalProduction ? { noProposal: tick.proposalProduction.noProposalDispatches } : {}),
      ...(tick.drain ? { drainAvailable: tick.drain.available, drainSelected: tick.drain.selected } : {}),
    },
  });
}

function recordTickStartAgentAction(fields: {
  ts: string;
  dryRun: boolean;
  dailyBudgetUsd: number;
  perTickItems: number;
  parallel: number;
  mode?: string;
  drain?: DaemonDrainMode;
  machineId?: string;
}): void {
  recordAgentAction({
    schemaVersion: 1,
    ts: fields.ts,
    machineId: fields.machineId ?? osHostname(),
    actor: 'daemon',
    kind: 'tick',
    outcome: 'started',
    action: 'daemon:tick-start',
    summary:
      `start: budget $${fields.dailyBudgetUsd.toFixed(2)}, ` +
      `perTick ${fields.perTickItems}, parallel ${fields.parallel}`,
    reason: fields.dryRun ? 'dry-run' : 'live',
    tags: [
      'tick-start',
      fields.dryRun ? 'dry-run' : 'live',
      ...(fields.mode ? [fields.mode] : []),
      ...(fields.drain ? [drainTag(fields.drain)] : []),
    ],
    counts: {
      perTickItems: fields.perTickItems,
      parallel: fields.parallel,
      ...(fields.drain ? { drainRequested: 1 } : {}),
    },
  });
}

function dispatchTrace(
  item: WorkItem,
  fields: {
    backend?: EngineId | null;
    tier?: EngineTier | null;
    model?: string | null;
    assignedBy: string;
    reason: string;
    dispatched: boolean;
    spentUsd?: number;
    runId?: string;
    trajectoryId?: string;
    skipReason?: string;
    production?: DaemonDispatchProduction;
  },
): DaemonDispatchTrace {
  const rs = routeSnapshot({
    backend: fields.backend ?? null,
    tier: fields.tier ?? null,
    model: fields.model,
    assignedBy: fields.assignedBy,
    reason: fields.reason,
  });
  const runId = fields.production?.runId ?? fields.runId;
  const summary = runEventSummary({
    ...(fields.production?.runEventSummary ?? {}),
    runId,
    status: fields.production?.runEventSummary?.status ?? (fields.dispatched ? 'done' : 'skipped'),
    outcome: fields.production?.outcome ?? (fields.dispatched ? 'unknown' : 'skipped'),
    proposalCreated: fields.production?.outcome === 'proposal-created',
    proposalId: fields.production?.proposalId,
    diffFiles: fields.production?.diffFiles ?? fields.production?.runEventSummary?.diffFiles,
    diffLines: fields.production?.diffLines ?? fields.production?.runEventSummary?.diffLines,
    costUsd: fields.spentUsd ?? 0,
  });
  const causal = causalMetadata({
    trajectoryId: fields.trajectoryId,
    itemId: item.id,
    proposalId: fields.production?.proposalId,
    runId,
    routeSnapshot: rs,
    runEventSummary: summary,
    learningSource: 'daemon-dispatch',
    labelBasis: 'dispatch-outcome',
  });
  return {
    itemId: item.id,
    title: boundedText(item.title, 120),
    repo: item.repo,
    source: item.source,
    backend: fields.backend ?? null,
    tier: fields.tier ?? null,
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    assignedBy: fields.assignedBy,
    reason: boundedText(fields.reason),
    dispatched: fields.dispatched,
    spentUsd: fields.spentUsd ?? 0,
    ...(runId ? { runId } : {}),
    ...causal,
    ...(fields.skipReason ? { skipReason: boundedText(fields.skipReason, 160) } : {}),
    ...(fields.production
      ? {
          production: {
            ...fields.production,
            trajectoryId: causal.trajectoryId,
            runEventSummary: summary,
            learningSource: 'daemon-dispatch',
            labelBasis: 'dispatch-outcome',
            routerPolicyVersion: causal.routerPolicyVersion,
            learningEpoch: causal.learningEpoch,
            ...(fields.production.reason ? { reason: boundedText(fields.production.reason, 220) } : {}),
          },
        }
      : {}),
  };
}

function recordDispatchStartAgentAction(
  item: WorkItem,
  fields: {
    ts: string;
    machineId: string;
    runId: string;
    backend: EngineId;
    tier: EngineTier | null;
    model?: string | null;
    assignedBy: string;
    reason: string;
    mode: 'swarm' | 'single' | 'best-of-n';
  },
): void {
  const rs = routeSnapshot({
    backend: fields.backend,
    tier: fields.tier,
    model: fields.model,
    assignedBy: fields.assignedBy,
    reason: fields.reason,
  });
  const summary = runEventSummary({
    runId: fields.runId,
    status: 'running',
    outcome: 'started',
    costUsd: 0,
  });
  const causal = causalMetadata({
    trajectoryId: `run:${fields.runId}`,
    itemId: item.id,
    runId: fields.runId,
    routeSnapshot: rs,
    runEventSummary: summary,
    learningSource: 'agent-action',
    labelBasis: 'unknown',
    ts: fields.ts,
  });
  recordAgentAction({
    schemaVersion: 1,
    ts: fields.ts,
    machineId: fields.machineId,
    actor: 'daemon',
    kind: 'dispatch',
    outcome: 'started',
    action: 'daemon:dispatch-start',
    summary: `${fields.backend} ${fields.mode} dispatch started`,
    repo: item.repo,
    itemId: item.id,
    source: item.source,
    runId: fields.runId,
    ...causal,
    backend: fields.backend,
    tier: fields.tier,
    ...(fields.model !== undefined ? { model: fields.model } : {}),
    reason: fields.reason,
    tags: ['dispatch-start', fields.mode, item.source],
    counts: { selected: 1, dispatched: 1 },
  });
}

function dispatchesFromOutcomes(outcomes: PromiseSettledResult<TickItemOutcome>[]): DaemonDispatchTrace[] | undefined {
  const dispatches = outcomes.flatMap((outcome) =>
    outcome.status === 'fulfilled' && outcome.value.dispatch ? [outcome.value.dispatch] : [],
  );
  return dispatches.length > 0 ? dispatches.slice(0, 20) : undefined;
}

function proposalProductionSummary(
  selectedCount: number,
  claimedCount: number,
  outcomes: PromiseSettledResult<TickItemOutcome>[],
  proposalsCreated: number,
): DaemonTick['proposalProduction'] | undefined {
  if (selectedCount <= 0 && claimedCount <= 0 && outcomes.length === 0 && proposalsCreated <= 0) {
    return undefined;
  }

  let dispatched = 0;
  let skipped = 0;
  let errors = 0;
  const reasonCounts = new Map<string, number>();
  const countReason = (reason: string) => {
    const key = boundedText(reason || 'unknown', 120);
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  };

  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') {
      errors++;
      countReason('task-error');
      continue;
    }
    const trace = outcome.value.dispatch;
    if (outcome.value.dispatched) dispatched++;
    else skipped++;
    const production = trace?.production;
    countReason(
      production && production.outcome !== 'proposal-created'
        ? productionReason(production)
        : trace?.skipReason ?? trace?.reason ?? (outcome.value.dispatched ? 'dispatched' : 'skipped'),
    );
  }

  const reasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));

  return {
    selected: selectedCount,
    claimed: claimedCount,
    dispatched,
    skipped,
    errors,
    proposalsCreated,
    noProposalDispatches: Math.max(0, dispatched - proposalsCreated),
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}

/**
 * Merge the hard-coded defaults with any partial overrides in cfg.daemon.
 * cfg.daemon grants NO authority — it only tunes caps.
 */
function resolveCfg(cfg: AshlrConfig): DaemonConfig {
  const o = cfg.daemon ?? {};
  // M116: tiered concurrency caps — defaults chosen for M5 Max (18 cores, 137GB RAM):
  // local=2 (GPU/RAM bound), cloud=6 (I/O bound), total=8. Configurable upward.
  const concLocal = typeof o.concurrency?.local === 'number' && o.concurrency.local > 0
    ? Math.floor(o.concurrency.local) : 2;
  const concCloud = typeof o.concurrency?.cloud === 'number' && o.concurrency.cloud > 0
    ? Math.floor(o.concurrency.cloud) : 6;
  const concTotal = typeof o.concurrency?.total === 'number' && o.concurrency.total > 0
    ? Math.floor(o.concurrency.total) : 8;
  // maxConcurrent: explicit override > concurrency.total > 8
  const maxConcurrent = typeof o.maxConcurrent === 'number' && o.maxConcurrent > 0
    ? Math.floor(o.maxConcurrent)
    : (typeof o.concurrency?.total === 'number' && o.concurrency.total > 0
        ? Math.floor(o.concurrency.total) : 8);
  return {
    dailyBudgetUsd: typeof o.dailyBudgetUsd === 'number' && o.dailyBudgetUsd > 0
      ? o.dailyBudgetUsd
      : DEFAULTS.dailyBudgetUsd,
    perTickItems: typeof o.perTickItems === 'number' && o.perTickItems > 0
      ? Math.floor(o.perTickItems)
      : DEFAULTS.perTickItems,
    parallel: typeof o.parallel === 'number' && o.parallel > 0
      ? Math.min(Math.floor(o.parallel), 8) // hard upper bound at 8 (batch mode)
      : DEFAULTS.parallel,
    intervalMs: typeof o.intervalMs === 'number' && o.intervalMs > 0
      ? o.intervalMs
      : DEFAULTS.intervalMs,
    // M116: new fields — undefined/absent ⇒ undefined in returned config (backward-compat)
    mode: o.mode === 'continuous' ? 'continuous' : o.mode === 'batch' ? 'batch' : undefined,
    maxConcurrent,
    concurrency: { local: concLocal, cloud: concCloud, total: concTotal },
    idleBackoffMs: typeof o.idleBackoffMs === 'number' && o.idleBackoffMs > 0
      ? o.idleBackoffMs : 5_000,
  };
}

// ---------------------------------------------------------------------------
// Bounded concurrency helpers
// ---------------------------------------------------------------------------

/**
 * M116: map an EngineTier to the two-bucket pool tier used for concurrency accounting.
 * 'frontier' and 'mid' are I/O-bound subscription engines → 'cloud' bucket.
 * 'local' (on-device models) is GPU/RAM-bound → 'local' bucket.
 */
function poolTierOf(engineTier: import('../types.js').EngineTier): 'local' | 'cloud' {
  return engineTier === 'local' ? 'local' : 'cloud';
}

/**
 * M116: TieredPool — a mutable concurrency gate that enforces per-tier AND total
 * in-flight caps. Used by both batch (to add per-tier awareness) and continuous
 * (to gate refills).
 *
 * All methods are synchronous; callers await the task themselves. The pool only
 * counts slots — it does NOT run tasks. Usage:
 *   if (pool.canStart(tier)) { pool.start(tier); try { await task(); } finally { pool.finish(tier); } }
 */
class TieredPool {
  private readonly _localCap: number;
  private readonly _cloudCap: number;
  private readonly _totalCap: number;
  private _localInFlight = 0;
  private _cloudInFlight = 0;

  constructor(opts: { local: number; cloud: number; total: number }) {
    this._localCap = Math.max(1, opts.local);
    this._cloudCap = Math.max(1, opts.cloud);
    this._totalCap = Math.max(1, opts.total);
  }

  get totalInFlight(): number { return this._localInFlight + this._cloudInFlight; }
  get localInFlight(): number { return this._localInFlight; }
  get cloudInFlight(): number { return this._cloudInFlight; }

  canStart(tier: 'local' | 'cloud'): boolean {
    if (this.totalInFlight >= this._totalCap) return false;
    if (tier === 'local') return this._localInFlight < this._localCap;
    return this._cloudInFlight < this._cloudCap;
  }

  start(tier: 'local' | 'cloud'): void {
    if (tier === 'local') this._localInFlight++;
    else this._cloudInFlight++;
  }

  finish(tier: 'local' | 'cloud'): void {
    if (tier === 'local') this._localInFlight = Math.max(0, this._localInFlight - 1);
    else this._cloudInFlight = Math.max(0, this._cloudInFlight - 1);
  }
}

/**
 * Pre-M116 bounded worker-pool: run `tasks` with at most `limit` concurrent.
 * Used for BATCH mode (default) to preserve byte-identical dispatch + budget
 * short-circuit semantics (H3 budget-overshoot bound = (parallel-1)×cost).
 */
async function bounded<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      const fn = tasks[idx];
      if (fn === undefined) break;
      try {
        results[idx] = { status: 'fulfilled', value: await fn() };
      } catch (err) {
        results[idx] = { status: 'rejected', reason: err };
      }
    }
  }

  const slots = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: slots }, () => worker()));
  return results;
}

/**
 * M116: run `tasks` with tiered concurrency caps.
 * Each task carries a pre-determined tier ('local' | 'cloud').
 * Returns all settled results in input order. Never throws.
 *
 * Algorithm: maintain a set of pending task indices. Each time a task
 * completes, immediately try to start more tasks (up to pool caps). A
 * Promise resolves only after ALL tasks have completed. No shared mutable
 * wake/resolve — each completion schedules the next batch synchronously
 * via the microtask queue, avoiding any lost-wake races.
 */
async function tieredBounded<T>(
  tasks: Array<{ tier: 'local' | 'cloud'; run: () => Promise<T> }>,
  pool: TieredPool,
): Promise<PromiseSettledResult<T>[]> {
  if (tasks.length === 0) return [];

  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIdx = 0;      // index of next task not yet started
  let completed = 0;    // count of tasks that have fully settled

  return new Promise<PromiseSettledResult<T>[]>((resolve) => {
    // Attempt to start as many tasks as the pool currently allows.
    function drain(): void {
      while (nextIdx < tasks.length) {
        const idx = nextIdx;
        const task = tasks[idx];
        if (task === undefined) break;
        if (!pool.canStart(task.tier)) break; // pool full for this tier or total
        nextIdx++;
        pool.start(task.tier);
        const tier = task.tier;
        task.run().then(
          (value) => {
            results[idx] = { status: 'fulfilled', value };
            pool.finish(tier);
            completed++;
            if (completed === tasks.length) resolve(results);
            else drain(); // slot freed — try to start more
          },
          (reason) => {
            results[idx] = { status: 'rejected', reason };
            pool.finish(tier);
            completed++;
            if (completed === tasks.length) resolve(results);
            else drain();
          },
        );
      }
    }

    drain(); // initial fill
  });
}

// ---------------------------------------------------------------------------
// tick — one operator cycle
// ---------------------------------------------------------------------------

function configuredLowRepairYieldRate(cfg: AshlrConfig): number {
  const raw = cfg.foundry?.intelligence?.minProposalYieldRate;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.2;
  return Math.max(0, Math.min(1, raw));
}

function generatedRepairRecoveryHealthy(cfg: AshlrConfig): boolean {
  try {
    const yieldSummary = readDispatchProductionYield({
      windowMs: GENERATED_REPAIR_RECOVERY_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 1,
    });
    const generated = yieldSummary?.generatedRepairAttempts;
    if (!generated || generated.attempts < GENERATED_REPAIR_RECOVERY_MIN_ATTEMPTS) return false;
    return generated.proposalRate >= Math.max(configuredLowRepairYieldRate(cfg), 0.5);
  } catch {
    return false;
  }
}

function cooldownMsForSelectionItem(
  item: WorkItem,
  baseCooldownMs: number,
  repairRecoveryHealthy: boolean,
): number {
  const latest = latestWorkedEvent(item.id);
  if (
    repairRecoveryHealthy &&
    latest?.outcome === 'empty' &&
    isTrustedGeneratedRepairItem(item)
  ) {
    return Math.min(baseCooldownMs, GENERATED_REPAIR_EMPTY_FAST_COOLDOWN_MS);
  }
  return baseCooldownMs;
}

/**
 * One operator cycle. In order:
 *  1. Kill-switch check.
 *  2. Load + resetDayIfNeeded state; budget exhaustion check.
 *  3. Enrollment check (DEFAULT EMPTY => do nothing).
 *  4. Build/load backlog for enrolled repos.
 *  5. Select top-K items within remaining budget.
 *  6a. dryRun: describe what WOULD be worked; create NO proposals.
 *  6b. else: for each selected item (bounded concurrency):
 *       runSwarm({ sandbox:true, propose:true }) => a PENDING inbox proposal
 *       is produced by the runner + tally spend.
 *  7. Persist updated state; return tick record.
 *
 * Has NO outward-action path (no apply, no push, no PR, no deploy).
 * Never throws.
 */
export async function tick(
  cfg: AshlrConfig,
  opts: TickOptions,
): Promise<DaemonTick> {
  const now = new Date().toISOString();
  // tick() respects the cfg it is GIVEN — tests and callers inject it directly.
  // M85 live-reload happens in runDaemon's LOOP (it reloads config from disk
  // before each tick and passes the fresh cfg in here), so on-disk daemon tuning
  // (budget/parallel/interval/cooldown) still takes effect without a restart
  // WITHOUT this function clobbering an explicitly-supplied cfg.
  const liveCfg = applyProductionVelocityProfile(cfg);
  const dcfg = resolveCfg(liveCfg);
  let routingCfg = liveCfg;
  let directionPlan: ResourceStrategyDaemonPlan | null = null;
  let directionMode: AutonomousDirectionMode | undefined;

  // Append a tick record to persisted state so every operator cycle (including
  // no-op reasons like kill-switch / no-enrolled-repos / dry-run) is visible to
  // `daemon status`, the TUI, and the web dashboard. Never throws.
  // M334: every return path funnels through recordTick, so stamping the
  // wall-clock here covers all of them — the stage-2 soak compares tick
  // p50/p95 before/after enabling concurrent dispatch.
  const _tickStartMs = Date.now();
  recordTickStartAgentAction({
    ts: now,
    dryRun: opts.dryRun,
    dailyBudgetUsd: dcfg.dailyBudgetUsd,
    perTickItems: dcfg.perTickItems,
    parallel: dcfg.parallel,
    mode: dcfg.mode,
    ...(opts.drain ? { drain: opts.drain } : {}),
  });
  const recordTick = (t: DaemonTick): DaemonTick => {
    const tick: DaemonTick = {
      ...(opts.dryRun ? { ...t, dryRun: true } : t),
      durationMs: t.durationMs ?? Date.now() - _tickStartMs,
    };
    try {
      const loaded = loadDaemonStateStrict();
      if (!loaded.ok) return tick;
      let s = loaded.state;
      s = resetDayIfNeeded(s);
      s.lastTickAt = tick.ts;
      s.ticks = [...s.ticks, tick];
      saveDaemonStateResult(s);
    } catch (err) {
      // persistence best-effort — never let observability crash a tick
      console.warn('[ashlr] daemon:recordTick persistence failed:', (err as Error)?.message ?? err);
    }
    recordTickAgentAction(tick);
    return tick;
  };
  const persistenceRefusal = (summary: string, result: 'refused' | 'error' = 'refused'): DaemonTick => {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary,
      result,
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'state-persistence-failed',
    });
  };
  const runAutoMergeMaintenancePass = async (): Promise<AutoMergePassResult | null> => {
    if (opts.dryRun) return null;
    try {
      return await runAutoMergePass(liveCfg);
    } catch (err) {
      console.warn('[ashlr] daemon:tick runAutoMergePass failed:', (err as Error)?.message ?? err);
      return null;
    }
  };
  let preDispatchAutoMergePassResult: AutoMergePassResult | null = null;
  let preDispatchAutoMergePassRan = false;
  let remoteHandoffReconcileResult: RemoteHandoffReconcileResult | null = null;
  let remoteHandoff: DaemonTick['remoteHandoff'] | undefined;
  const runRemoteHandoffReconciliation = (): RemoteHandoffReconcileResult | null => {
    if (opts.dryRun || remoteHandoffReconcileResult !== null) return remoteHandoffReconcileResult;
    try {
      remoteHandoffReconcileResult = reconcileRemoteHandoffs();
      const summary = remoteHandoffTickSummary(remoteHandoffReconcileResult);
      if (summary) {
        audit({
          action: 'daemon:tick',
          repo: null,
          sandboxId: null,
          summary:
            `remote handoff reconciliation checked=${summary.checked}, merged=${summary.merged}, ` +
            `closed=${summary.closed}, open=${summary.open}, unknown=${summary.unknown}`,
          result: 'ok',
        });
      }
      return remoteHandoffReconcileResult;
    } catch (err) {
      console.warn('[ashlr] daemon:tick reconcileRemoteHandoffs failed:', (err as Error)?.message ?? err);
      remoteHandoffReconcileResult = null;
      return null;
    }
  };
  let selfHealMaintenanceRan = false;
  let inventMaintenanceRan = false;
  let ancillaryMaintenanceRan = false;
  let proposalRepairMaintenanceRan = false;
  let proposalRepairMaintenanceResult: ProposalRepairWorkResult | null = null;
  let skipInventAfterSelfHealRefill = false;
  let producerMaintenanceBeforeSelection = false;
  let producerMaintenanceSkippedByCadence = false;
  let producerMaintenanceNextAfter: string | undefined;
  const generatedRepairDispatchEnabled =
    (liveCfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'] !== false &&
    liveCfg.fleet?.sharedQueue?.mode !== 'filesystem';
  const blockedRepairKeys = new Set<string>();
  let repairHandoffControlAvailable = true;
  const filterGeneratedRepairDispatch = (items: WorkItem[]): WorkItem[] => items.filter((item) => {
    if (!item.tags.includes('proposal-repair')) return true;
    if (!generatedRepairDispatchEnabled) return false;
    if (!repairHandoffControlAvailable) return false;
    try {
      return !blockedRepairKeys.has(workItemCoverageKey(item));
    } catch {
      return false;
    }
  });
  const producerMaintenanceSummary = (): DaemonTick['producerMaintenance'] | undefined => {
    if (
      !selfHealMaintenanceRan &&
      !inventMaintenanceRan &&
      !ancillaryMaintenanceRan &&
      !proposalRepairMaintenanceRan &&
      !producerMaintenanceSkippedByCadence
    ) {
      return undefined;
    }
    return {
      selfHeal: selfHealMaintenanceRan,
      invent: inventMaintenanceRan,
      ancillary: ancillaryMaintenanceRan,
      proposalRepair: proposalRepairMaintenanceRan,
      ...(proposalRepairMaintenanceResult
        ? {
          proposalRepairEligible: proposalRepairMaintenanceResult.eligible,
          proposalRepairQueued: proposalRepairMaintenanceResult.queued,
          proposalRepairFailed: proposalRepairMaintenanceResult.failed,
          ...(proposalRepairMaintenanceResult.dispatchCaptureScanned !== undefined
            ? { dispatchCaptureRepairScanned: proposalRepairMaintenanceResult.dispatchCaptureScanned }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchCaptureEligible !== undefined
            ? { dispatchCaptureRepairEligible: proposalRepairMaintenanceResult.dispatchCaptureEligible }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchCaptureQueued !== undefined
            ? { dispatchCaptureRepairQueued: proposalRepairMaintenanceResult.dispatchCaptureQueued }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchCaptureFailed !== undefined
            ? { dispatchCaptureRepairFailed: proposalRepairMaintenanceResult.dispatchCaptureFailed }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchNoDiffScanned !== undefined
            ? { dispatchNoDiffResliceScanned: proposalRepairMaintenanceResult.dispatchNoDiffScanned }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchNoDiffEligible !== undefined
            ? { dispatchNoDiffResliceEligible: proposalRepairMaintenanceResult.dispatchNoDiffEligible }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchNoDiffQueued !== undefined
            ? { dispatchNoDiffResliceQueued: proposalRepairMaintenanceResult.dispatchNoDiffQueued }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchNoDiffFailed !== undefined
            ? { dispatchNoDiffResliceFailed: proposalRepairMaintenanceResult.dispatchNoDiffFailed }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchRepairRetired !== undefined
            ? { dispatchRepairRetired: proposalRepairMaintenanceResult.dispatchRepairRetired }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchRepairExhausted !== undefined
            ? { dispatchRepairExhausted: proposalRepairMaintenanceResult.dispatchRepairExhausted }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchRepairPruned !== undefined
            ? { dispatchRepairPruned: proposalRepairMaintenanceResult.dispatchRepairPruned }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchRepairPruneFailed !== undefined
            ? { dispatchRepairPruneFailed: proposalRepairMaintenanceResult.dispatchRepairPruneFailed }
            : {}),
          ...(proposalRepairMaintenanceResult.dispatchRepairLifecycleUnavailable !== undefined
            ? { dispatchRepairLifecycleUnavailable: proposalRepairMaintenanceResult.dispatchRepairLifecycleUnavailable }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffObservations !== undefined
            ? { repairHandoffObservations: proposalRepairMaintenanceResult.handoffObservations }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffInvalidRows !== undefined
            ? { repairHandoffInvalidRows: proposalRepairMaintenanceResult.handoffInvalidRows }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffConflictingIds !== undefined
            ? { repairHandoffConflictingIds: proposalRepairMaintenanceResult.handoffConflictingIds }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffSourceState !== undefined
            ? { repairHandoffSourceState: proposalRepairMaintenanceResult.handoffSourceState }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffCompacted !== undefined
            ? { repairHandoffCompacted: proposalRepairMaintenanceResult.handoffCompacted }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffCompactionUnavailable !== undefined
            ? { repairHandoffCompactionUnavailable: proposalRepairMaintenanceResult.handoffCompactionUnavailable }
            : {}),
          ...(proposalRepairMaintenanceResult.proposalInboxAvailable !== undefined
            ? { proposalRepairInboxAvailable: proposalRepairMaintenanceResult.proposalInboxAvailable }
            : {}),
        }
        : {}),
      ...(producerMaintenanceSkippedByCadence ? { skippedByCadence: true } : {}),
      ...(producerMaintenanceNextAfter ? { nextAfter: producerMaintenanceNextAfter } : {}),
    };
  };
  const shouldRunProducerMaintenance = (currentState: DaemonState): boolean => {
    const lastRanAt = lastProducerMaintenanceAtMs(currentState);
    if (lastRanAt === null) return true;
    const nextRunAt = lastRanAt + Math.max(1, dcfg.intervalMs);
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs) || nowMs >= nextRunAt) return true;
    producerMaintenanceSkippedByCadence = true;
    producerMaintenanceNextAfter = new Date(nextRunAt).toISOString();
    return false;
  };
  const runSelfHealMaintenance = async (targetRepos?: string[]): Promise<void> => {
    if (opts.dryRun || selfHealMaintenanceRan) return;
    selfHealMaintenanceRan = true;
    try {
      if (targetRepos && targetRepos.length > 0) {
        await runSelfHealCycleForRepos(targetRepos, liveCfg);
      } else {
        await runSelfHealCycle(liveCfg);
      }
    } catch (err) {
      // Best-effort — self-heal must never crash the tick.
      console.warn('[ashlr] daemon:tick runSelfHealCycle failed:', (err as Error)?.message ?? err);
    }
  };
  const runProposalRepairMaintenance = async (): Promise<ProposalRepairWorkResult | null> => {
    if (opts.dryRun || proposalRepairMaintenanceRan) return proposalRepairMaintenanceResult;
    if ((liveCfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'] === false) return null;
    proposalRepairMaintenanceRan = true;
    try {
      proposalRepairMaintenanceResult = queueProposalRepairWorkForPendingProposals(
        undefined,
        new Date(now),
        { terminalLifecycleEnabled: liveCfg.fleet?.sharedQueue?.mode !== 'filesystem' },
      );
      return proposalRepairMaintenanceResult;
    } catch (err) {
      proposalRepairMaintenanceResult = { scanned: 0, eligible: 0, queued: 0, failed: 1 };
      console.warn('[ashlr] daemon:tick proposal repair queue failed:', (err as Error)?.message ?? err);
      return proposalRepairMaintenanceResult;
    }
  };
  const runInventMaintenance = async (): Promise<boolean> => {
    if (opts.dryRun || inventMaintenanceRan || skipInventAfterSelfHealRefill) return false;
    if (directionPlan?.forceLocalOnly === true) return false;
    if ((liveCfg.foundry as Record<string, unknown>)?.generative !== true) return false;
    inventMaintenanceRan = true;
    try {
      await runInventCycle(liveCfg);
      return true;
    } catch (err) {
      console.warn('[ashlr] daemon:tick runInventCycle failed:', (err as Error)?.message ?? err);
      return false;
    }
  };
  const runAncillaryMaintenance = async (): Promise<void> => {
    if (opts.dryRun || ancillaryMaintenanceRan) return;
    ancillaryMaintenanceRan = true;

    // M187: Counterfactual replay — low-cadence judge calibration.
    if (
      (liveCfg.foundry as Record<string, unknown>)?.counterfactual === true &&
      state.ticks.length % 20 === 0
    ) {
      try { await runCounterfactualReplay(liveCfg); } catch (err) { console.warn('[ashlr] daemon:tick runCounterfactualReplay failed:', (err as Error)?.message ?? err); }
    }

    // M332: outcome watcher — link real-world reverts / follow-up fixes back
    // onto judge traces so calibration + learned routing see post-merge truth.
    // READ-ONLY on repos; ledger writes go through linkOutcome IN THIS SERIAL
    // maintenance phase only (its in-place JSONL rewrite must never run inside
    // the concurrent dispatch closure). Internal 6h throttle; opt out with
    // cfg.foundry.outcomeWatcher === false.
    if ((liveCfg.foundry as Record<string, unknown>)?.['outcomeWatcher'] !== false) {
      try {
        const { scanRealWorldOutcomes } = await import('../fleet/outcome-watcher.js');
        await scanRealWorldOutcomes(liveCfg);
      } catch (err) {
        console.warn('[ashlr] daemon:tick outcomeWatcher failed:', (err as Error)?.message ?? err);
      }
    }

    // M189: Regression sentinel — detect regressions introduced by auto-merge and bisect/revert.
    if ((liveCfg.foundry as Record<string, unknown>)?.regressionSentinel === true) {
      try {
        const r = await detectRegression(liveCfg);
        if (r.regressed) {
          await bisectAndRevert(liveCfg);
          // M212: fire-and-forget anomaly notification — additive, never throws.
          void notifyFleetEvent('anomaly', { detail: 'Regression detected — bisect/revert triggered' }, liveCfg);
          // M241: fire-and-forget fleet event-bus emit — additive, never throws, no control-flow change.
          void import('../fleet/event-bus.js').then(({ emit }) => emit('regression:detected', { signal: r.signal, repo: process.cwd() }, liveCfg)).catch(() => {});
        }
      } catch (err) { console.warn('[ashlr] daemon:tick regressionSentinel failed:', (err as Error)?.message ?? err); }
    }
  };
  const refreshBacklogForTick = async (): Promise<WorkItem[]> => {
    try {
      const backlog = await buildBacklog({ repos: enrolled });
      return filterGeneratedRepairDispatch(backlog.items);
    } catch (err) {
      // buildBacklog never throws by contract; extra guard
      console.warn('[ashlr] daemon:tick buildBacklog guard caught:', (err as Error)?.message ?? err);
      return [];
    }
  };
  const prunableSelfHealRepos = (items: WorkItem[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of items) {
      if (
        item.source !== 'self' ||
        !item.tags.includes('self-heal') ||
        item.tags.includes('proposal-repair')
      ) continue;
      if (seen.has(item.repo)) continue;
      seen.add(item.repo);
      out.push(item.repo);
    }
    return out;
  };

  // -------------------------------------------------------------------------
  // 1. Kill-switch check.
  // -------------------------------------------------------------------------
  if (killSwitchOn()) {
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: 'tick skipped: kill switch is ON',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'kill-switch',
    });
  }

  // -------------------------------------------------------------------------
  // 2. Load state + daily reset + budget exhaustion check.
  // -------------------------------------------------------------------------
  const loadedState = loadDaemonStateStrict();
  if (!loadedState.ok) {
    return persistenceRefusal(`tick refused: daemon state ${loadedState.reason} (${loadedState.error})`);
  }
  const existingSpendGuard = readDaemonSpendGuard();
  if (existingSpendGuard.exists) {
    return persistenceRefusal(
      existingSpendGuard.guard
        ? `tick refused: unresolved spend guard from ${existingSpendGuard.guard.armedAt} (${existingSpendGuard.guard.itemIds.length} item(s))`
        : `tick refused: malformed or unreadable spend guard at ${existingSpendGuard.path}`,
    );
  }
  let state = loadedState.state;
  state = resetDayIfNeeded(state);
  const initialSave = saveDaemonStateResult(state);
  if (!initialSave.ok) {
    return persistenceRefusal(`tick refused: failed to persist daemon state before dispatch (${initialSave.error})`, 'error');
  }

  const remainingBudget = dcfg.dailyBudgetUsd - state.todaySpentUsd;
  if (remainingBudget <= 0) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: `tick skipped: daily budget exhausted ($${state.todaySpentUsd.toFixed(4)} >= $${dcfg.dailyBudgetUsd})`,
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'budget-exhausted',
    });
  }

  // -------------------------------------------------------------------------
  // 3. Enrollment check — NEVER touch non-enrolled repos.
  // -------------------------------------------------------------------------
  const enrolled = listEnrolled();
  if (enrolled.length === 0) {
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: 'tick skipped: no repos enrolled (DEFAULT EMPTY)',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'no-enrolled-repos',
    });
  }

  // -------------------------------------------------------------------------
  // 4. Resource direction check before expensive scanner/planner refresh.
  // -------------------------------------------------------------------------
  if (autonomyControlEnabled(liveCfg)) {
    try {
      directionPlan = await buildDaemonStrategyPlan(liveCfg, state, cachedBacklogCountForEnrolledRepos(enrolled));
      directionMode = directionPlan.mode;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      directionPlan = {
        mode: 'pause',
        allowDispatch: false,
        forceLocalOnly: false,
        runAutoMergeMaintenance: false,
        reason: `resource strategy failed: ${msg.slice(0, 160)}`,
      };
      directionMode = directionPlan.mode;
    }

    routingCfg = directionPlan.forceLocalOnly ? constrainToLocalBackends(liveCfg) : liveCfg;
    if (directionPlan.mode !== 'pause') {
      runRemoteHandoffReconciliation();
      remoteHandoff = remoteHandoffTickSummary(remoteHandoffReconcileResult);
    }

    if (!directionPlan.allowDispatch) {
      const autoMergePassResult = directionPlan.runAutoMergeMaintenance
        ? await runAutoMergeMaintenancePass()
        : null;
      const autoMerge = autoMergeTickSummary(autoMergePassResult);
      const merged = autoMergePassResult?.merged ?? 0;
      saveDaemonState(state);
      audit({
        action: 'daemon:tick',
        repo: null,
        sandboxId: null,
        summary: `tick ${directionPlan.mode}: ${directionPlan.reason}${
          merged > 0 ? `; auto-merged ${merged} proposal(s)` : ''
        }`,
        result: 'ok',
      });
      return recordTick({
        ts: now,
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: directionPlan.mode,
        directionMode,
        directionReason: directionPlan.reason,
        ...(autoMerge ? { autoMerge } : {}),
        ...(remoteHandoff ? { remoteHandoff } : {}),
        ...(merged > 0 ? { merged } : {}),
      });
    }
  }
  if (!directionPlan) {
    runRemoteHandoffReconciliation();
    remoteHandoff = remoteHandoffTickSummary(remoteHandoffReconcileResult);
  }

  // -------------------------------------------------------------------------
  // 5. Build / refresh backlog for ENROLLED repos only.
  // -------------------------------------------------------------------------
  let backlogItems: WorkItem[] = await refreshBacklogForTick();
  const proposalRepairResult = await runProposalRepairMaintenance();
  if (
    (proposalRepairResult?.queued ?? 0) > 0 ||
    (proposalRepairResult?.dispatchRepairPruned ?? 0) > 0
  ) {
    backlogItems = await refreshBacklogForTick();
  }
  for (const key of proposalRepairResult?.blockedItemKeys ?? []) blockedRepairKeys.add(key);
  if (
    proposalRepairResult?.handoffSourceState === 'degraded' ||
    proposalRepairResult?.proposalInboxAvailable === false
  ) repairHandoffControlAvailable = false;
  backlogItems = filterGeneratedRepairDispatch(backlogItems);

  if (backlogItems.length === 0) {
    const autoMergePassResult = await runAutoMergeMaintenancePass();
    preDispatchAutoMergePassResult = autoMergePassResult;
    preDispatchAutoMergePassRan = true;
    const autoMerge = autoMergeTickSummary(autoMergePassResult);
    const merged = autoMergePassResult?.merged ?? 0;

    if (!opts.dryRun && shouldRunProducerMaintenance(state)) {
      producerMaintenanceBeforeSelection = true;
      await runSelfHealMaintenance();
      backlogItems = filterGeneratedRepairDispatch(await refreshBacklogForTick());
      if (backlogItems.length > 0) {
        skipInventAfterSelfHealRefill = true;
      } else {
        const invented = await runInventMaintenance();
        if (invented) backlogItems = filterGeneratedRepairDispatch(await refreshBacklogForTick());
      }
      await runAncillaryMaintenance();
    }

    if (backlogItems.length > 0) {
      audit({
        action: 'daemon:tick',
        repo: null,
        sandboxId: null,
        summary: `backlog refilled after empty scan: ${backlogItems.length} item(s)`,
        result: 'ok',
      });
    } else {
      saveDaemonState(state);
      audit({
        action: 'daemon:tick',
        repo: null,
        sandboxId: null,
        summary: `tick skipped: backlog is empty for enrolled repos${
          merged > 0 ? `; auto-merged ${merged} proposal(s)` : ''
        }`,
        result: 'ok',
      });
      return recordTick({
        ts: now,
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'no-backlog',
        ...(directionMode ? { directionMode } : {}),
        ...(directionPlan ? { directionReason: directionPlan.reason } : {}),
        ...(autoMerge ? { autoMerge } : {}),
        ...(remoteHandoff ? { remoteHandoff } : {}),
        ...(producerMaintenanceSummary() ? { producerMaintenance: producerMaintenanceSummary() } : {}),
        ...(merged > 0 ? { merged } : {}),
      });
    }
  }

  // M201: run producer maintenance before selecting live work even when the
  // backlog was non-empty and contains self-heal work. Self-heal maintenance
  // can prune generated repair items that were valid in the cached backlog
  // moments earlier; the same tick must refresh and select from the
  // post-maintenance view.
  const selfHealReposBeforeSelection = prunableSelfHealRepos(backlogItems);
  if (
    backlogItems.length > 0 &&
    !opts.dryRun &&
    !selfHealMaintenanceRan &&
    selfHealReposBeforeSelection.length > 0 &&
    shouldRunProducerMaintenance(state)
  ) {
    producerMaintenanceBeforeSelection = true;
    await runSelfHealMaintenance(selfHealReposBeforeSelection);
    backlogItems = filterGeneratedRepairDispatch(await refreshBacklogForTick());
    const invented = await runInventMaintenance();
    if (invented) backlogItems = filterGeneratedRepairDispatch(await refreshBacklogForTick());
    await runAncillaryMaintenance();

    if (backlogItems.length === 0) {
      const autoMergePassResult = await runAutoMergeMaintenancePass();
      preDispatchAutoMergePassResult = autoMergePassResult;
      preDispatchAutoMergePassRan = true;
      const autoMerge = autoMergeTickSummary(autoMergePassResult);
      const merged = autoMergePassResult?.merged ?? 0;

      saveDaemonState(state);
      audit({
        action: 'daemon:tick',
        repo: null,
        sandboxId: null,
        summary: `tick skipped: backlog emptied after producer maintenance${
          merged > 0 ? `; auto-merged ${merged} proposal(s)` : ''
        }`,
        result: 'ok',
      });
      return recordTick({
        ts: now,
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'no-backlog',
        ...(directionMode ? { directionMode } : {}),
        ...(directionPlan ? { directionReason: directionPlan.reason } : {}),
        ...(autoMerge ? { autoMerge } : {}),
        ...(remoteHandoff ? { remoteHandoff } : {}),
        ...(producerMaintenanceSummary() ? { producerMaintenance: producerMaintenanceSummary() } : {}),
        ...(merged > 0 ? { merged } : {}),
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Select top-K items within the per-tick cap and remaining budget.
  //
  //    M85 FAIRNESS: round-robin across repos so every enrolled repo gets a
  //    turn instead of a single high-scoring repo monopolising every tick.
  //    Within each repo, items are already sorted highest-score-first by
  //    buildBacklog, so we always pick the most valuable open item per repo.
  //    Selection algorithm:
  //      a. Group items by repo (preserving within-repo score order).
  //      b. Walk repos in round-robin until selectCount is reached.
  //      c. Skip any item that is recentlyDeclined (cooldown window) OR already
  //         has an open PENDING proposal (best-effort match via item.id in the
  //         proposal title/summary — if no clean match, ledger alone governs).
  //
  //    The real budget controls remain: (a) perTickItems cap, (b) remaining
  //    daily USD budget, (c) the swarm's own internal token budget.
  // -------------------------------------------------------------------------
  const MIN_PER_ITEM_USD = 0.01; // floor on a per-item slice for selection math
  const productionVelocity = resolveProductionVelocityProfile(routingCfg);
  let selectionResourceSnapshot: Awaited<ReturnType<typeof getResourceSnapshot>> | null = null;
  let availableSlotsForSelection: number | null = null;
  if (
    productionVelocity.enabled &&
    productionVelocity.fillQueueToSlots &&
    routingCfg.foundry?.fabric?.concurrentDispatch === true
  ) {
    selectionResourceSnapshot = await getResourceSnapshot(routingCfg).catch(() => null);
    if (selectionResourceSnapshot) {
      availableSlotsForSelection = availableSlotsForResourceSnapshot(
        selectionResourceSnapshot,
        productionVelocity.maxSlotsPerBackend,
      );
    }
  }
  // M85: read the cooldown window from liveCfg defensively (no types.ts change).
  const cooldownMs: number =
    typeof (liveCfg.daemon as Record<string, unknown> | undefined)?.['cooldownMs'] === 'number' &&
    ((liveCfg.daemon as Record<string, unknown>)['cooldownMs'] as number) > 0
      ? (liveCfg.daemon as Record<string, unknown>)['cooldownMs'] as number
      : 6 * 60 * 60 * 1000; // default 6h

  // M113: coordinator seam — once per tick. Local (default) = today's behavior;
  // Shared = multi-machine atomic claim (cfg.fleet.sharedQueue.mode==='filesystem').
  const coordinator = selectWorkQueueCoordinator(liveCfg);
  const machineId: string =
    (liveCfg.fleet as Record<string, unknown> | undefined)?.['sharedQueue'] &&
    typeof ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)?.['machineId'] === 'string'
      ? ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['machineId'] as string
      : osHostname();
  const sharedQueueLeaseMs: number =
    (liveCfg.fleet as Record<string, unknown> | undefined)?.['sharedQueue'] &&
    typeof ((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)?.['leaseMs'] === 'number' &&
    (((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['leaseMs'] as number) > 0
      ? Math.floor(((liveCfg.fleet as Record<string, unknown>)['sharedQueue'] as Record<string, unknown>)['leaseMs'] as number)
      : 5 * 60 * 1000;

  // M220: verdict-feedback sweep — feed judge rejections back to the worked ledger
  // BEFORE selection so items whose proposals were judged review/noise/harmful are
  // suppressed this tick. Gated: cfg.foundry?.antiClog !== false (DEFAULT ON).
  // Flag-off (antiClog:false) = skip the sweep = exact pre-M220 behavior.
  if ((liveCfg.foundry as Record<string, unknown> | undefined)?.['antiClog'] !== false) {
    try {
      const rejected = listProposals({ status: 'rejected' });
      if (rejected.length > 0) {
        sweepJudgedProposals(
          rejected,
          backlogItems,
          undefined,
          (itemId, outcome) => {
            const item = backlogItems.find((candidate) => candidate.id === itemId);
            coordinator.recordOutcome(item ? generatedRepairCooldownKey(item) : itemId, outcome, machineId);
          },
        );
      }
    } catch (err) {
      // Best-effort — sweep must never crash selection.
      console.warn('[ashlr] daemon:tick sweepJudgedProposals failed:', (err as Error)?.message ?? err);
    }
  }

  // Build a set of repo+item keys that already have an open PENDING proposal
  // so we can skip duplicating work. New proposals use workItemId as the source
  // of truth; legacy proposals without it fall back to exact item-id text
  // matching. Never throws.
  let pendingItemKeys = new Set<string>();
  try {
    const blockingPendingProposals = blockingPendingProposalsForBacklog(
      listProposals({ status: 'pending' }),
      routingCfg,
    );
    pendingItemKeys = pendingProposalItemKeysForBacklog(backlogItems, blockingPendingProposals);
  } catch (err) {
    // Best-effort — never block selection on inbox read failure.
    console.warn('[ashlr] daemon:tick inbox pendingItemIds read failed:', (err as Error)?.message ?? err);
  }

  const repairRecoveryHealthy = generatedRepairRecoveryHealthy(liveCfg);
  const isSelectionBlocked = (item: WorkItem): boolean =>
    coordinator.shouldSkip(
      generatedRepairCooldownKey(item),
      cooldownMsForSelectionItem(item, cooldownMs, repairRecoveryHealthy),
    ) ||
    pendingItemKeys.has(workItemCoverageKey(item));

  const explicitDrainMode = opts.drain;
  const autoDrainMode: DaemonDrainMode | undefined =
    canAutoDrainDiagnosticReslices(opts, directionPlan) ? 'diagnostic-reslices' : undefined;
  const autoDrainAvailableItems = autoDrainMode
    ? backlogItems.filter((item) => isDrainCandidate(item, autoDrainMode))
    : [];
  const autoDrainEligibleItems = autoDrainAvailableItems.filter((item) => !isSelectionBlocked(item));
  const drainMode = explicitDrainMode ?? (autoDrainEligibleItems.length > 0 ? autoDrainMode : undefined);
  const automaticDrain = explicitDrainMode === undefined && drainMode !== undefined;
  const drainAvailableItems = drainMode
    ? automaticDrain
      ? autoDrainAvailableItems
      : backlogItems.filter((item) => isDrainCandidate(item, drainMode))
    : [];
  const selectionItems = drainMode ? drainAvailableItems : backlogItems;
  const rawSelectCount = daemonQueueSelectionLimit({
    perTickItems: dcfg.perTickItems,
    remainingBudgetUsd: remainingBudget,
    backlogItems: selectionItems.length,
    fillQueueToSlots: productionVelocity.fillQueueToSlots,
    availableSlots: availableSlotsForSelection,
    minPerItemUsd: MIN_PER_ITEM_USD,
  });
  const drainLimit = resolveDrainLimit(liveCfg, drainMode, opts.drainLimit);
  const selectCount = typeof drainLimit === 'number'
    ? Math.min(rawSelectCount, drainLimit)
    : rawSelectCount;
  const summarizeSelectionBlockers = (items: WorkItem[]) => {
    let eligibleItems = 0;
    let pendingBlocked = 0;
    let cooldownBlocked = 0;
    let fastRepairCooldown = 0;
    for (const item of items) {
      const pending = pendingItemKeys.has(workItemCoverageKey(item));
      const itemCooldownMs = cooldownMsForSelectionItem(item, cooldownMs, repairRecoveryHealthy);
      const cooling = coordinator.shouldSkip(generatedRepairCooldownKey(item), itemCooldownMs);
      if (pending) pendingBlocked++;
      if (cooling) cooldownBlocked++;
      if (!pending && !cooling) eligibleItems++;
      if (
        repairRecoveryHealthy &&
        itemCooldownMs < cooldownMs &&
        isTrustedGeneratedRepairItem(item)
      ) {
        fastRepairCooldown++;
      }
    }
    return { eligibleItems, pendingBlocked, cooldownBlocked, fastRepairCooldown };
  };

  const selectRoundRobinCandidates = (items: WorkItem[], count: number): WorkItem[] => {
    // Group selectable items by repo (score-sorted within each group by buildBacklog).
    const byRepo = new Map<string, WorkItem[]>();
    for (const item of items) {
      let group = byRepo.get(item.repo);
      if (!group) { group = []; byRepo.set(item.repo, group); }
      group.push(item);
    }
    // Per-repo cursors (index into each repo's item array).
    const repoCursors = new Map<string, number>();
    for (const repo of byRepo.keys()) repoCursors.set(repo, 0);
    const repoOrder = [...byRepo.keys()].sort(compareReposByStrategicFocus);

    const out: WorkItem[] = [];
    // Guard: if no repos were grouped (shouldn't happen given backlogItems > 0,
    // but belt-and-suspenders) skip the loop entirely.
    if (repoOrder.length > 0) {
      let rri = 0; // round-robin index
      let scanned = 0; // safety: never loop more than total items
      const totalItems = items.length;
      while (out.length < count && scanned < totalItems * repoOrder.length + 1) {
        scanned++;
        const repo = repoOrder[rri % repoOrder.length];
        if (repo === undefined) break;
        rri++;
        const group = byRepo.get(repo) ?? [];
        const cursor = repoCursors.get(repo) ?? 0;
        // Advance cursor past declined/pending items.
        let advance = cursor;
        while (advance < group.length) {
          const candidate = group[advance]!;
          if (!isSelectionBlocked(candidate)) break;
          advance++;
        }
        repoCursors.set(repo, advance);
        if (advance < group.length) {
          out.push(group[advance]!);
          repoCursors.set(repo, advance + 1);
        }
        // Check on EVERY iteration whether any repo still has selectable items;
        // stop as soon as none do to avoid spinning through a fully-skipped backlog.
        // (Previously only checked at modulo-repoOrder.length boundaries, which
        // could miss exhaustion mid-pass and spin needlessly.)
        let anyLeft = false;
        for (const [r, g] of byRepo) {
          const c = repoCursors.get(r) ?? 0;
          if (c < g.length) { anyLeft = true; break; }
        }
        if (!anyLeft) break;
      }
    }
    return out;
  };

  let selected = selectRoundRobinCandidates(selectionItems, selectCount);
  let selectionTelemetryItems = selectionItems;
  let selectionTelemetryRawSelectCount = rawSelectCount;
  let selectionTelemetrySelectCount = selectCount;
  let selectionTelemetryDrainMode = drainMode;
  let selectionTelemetryAutomaticDrain = automaticDrain;

  // M113: claimItems — Local returns top-selectCount (identical to today's raw
  // slice); Shared atomically claims items so two machines get disjoint work.
  let workedSet = coordinator.claimItems(selected, selectCount, machineId);
  let drainSelectedItems = drainMode
    ? workedSet.filter((item) => isDrainCandidate(item, drainMode))
    : [];
  if (automaticDrain && drainMode && workedSet.length === 0) {
    const fallbackItems = backlogItems.filter((item) => !isDrainCandidate(item, drainMode));
    const fallbackSelectCount = daemonQueueSelectionLimit({
      perTickItems: dcfg.perTickItems,
      remainingBudgetUsd: remainingBudget,
      backlogItems: fallbackItems.length,
      fillQueueToSlots: productionVelocity.fillQueueToSlots,
      availableSlots: availableSlotsForSelection,
      minPerItemUsd: MIN_PER_ITEM_USD,
    });
    const fallbackSelected = selectRoundRobinCandidates(fallbackItems, fallbackSelectCount);
    const fallbackWorkedSet = coordinator.claimItems(fallbackSelected, fallbackSelectCount, machineId);
    if (fallbackWorkedSet.length > 0) {
      selected = fallbackSelected;
      workedSet = fallbackWorkedSet;
      drainSelectedItems = [];
      selectionTelemetryItems = fallbackItems;
      selectionTelemetryRawSelectCount = fallbackSelectCount;
      selectionTelemetrySelectCount = fallbackSelectCount;
      selectionTelemetryDrainMode = undefined;
      selectionTelemetryAutomaticDrain = false;
    }
  }
  const selectionBlockers = summarizeSelectionBlockers(selectionTelemetryItems);
  recordQueueSelectionAgentAction({
    ts: now,
    machineId,
    dryRun: opts.dryRun,
    ...(selectionTelemetryDrainMode ? { drainMode: selectionTelemetryDrainMode } : {}),
    automaticDrain: selectionTelemetryAutomaticDrain,
    backlogItems: selectionTelemetryItems.length,
    eligibleItems: selectionBlockers.eligibleItems,
    pendingBlocked: selectionBlockers.pendingBlocked,
    cooldownBlocked: selectionBlockers.cooldownBlocked,
    fastRepairCooldown: selectionBlockers.fastRepairCooldown,
    rawSelectCount: selectionTelemetryRawSelectCount,
    selectCount: selectionTelemetrySelectCount,
    selectedItems: selected,
    claimedItems: workedSet,
  });
  recordGeneratedRepairDecisionAgentActions({
    ts: now,
    machineId,
    dryRun: opts.dryRun,
    items: backlogItems,
    selectedItems: selected,
    claimedItems: workedSet,
    pendingItemKeys,
    coordinator,
    baseCooldownMs: cooldownMs,
    repairRecoveryHealthy,
  });
  const drain = drainMode
    ? drainSummary(drainMode, drainAvailableItems, drainSelectedItems, drainLimit, automaticDrain)
    : undefined;
  if (drainMode) {
    recordDrainSelectionAgentAction({
      ts: now,
      mode: drainMode,
      available: drainAvailableItems.length,
      selectedItems: drainSelectedItems,
      ...(typeof drainLimit === 'number' ? { limit: drainLimit } : {}),
      ...(drain?.capped ? { capped: true } : {}),
      machineId,
      dryRun: opts.dryRun,
      automatic: automaticDrain,
    });
  }

  // -------------------------------------------------------------------------
  // 6a. Dry-run mode: report what WOULD be worked; NO swarms, NO proposals.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    try {
      const claimedIds = workedSet.map((i) => i.id);
      if (claimedIds.length > 0) coordinator.release(claimedIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick dry-run coordinator release failed:', (err as Error)?.message ?? err);
    }
    saveDaemonState(state);
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: `dry-run: would work ${workedSet.length} item(s): ${workedSet.map(i => i.title).join(', ')}`,
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: workedSet.length,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'dry-run',
      ...(directionMode ? { directionMode } : {}),
      ...(drain ? { drain } : {}),
    });
  }

  // M170/M186/M187/M189 live maintenance cadence. Keep it outside the spend
  // guard so queued work discovery and regression watches do not extend an
  // in-flight accounting guard for selected dispatches.
  if (!producerMaintenanceBeforeSelection && shouldRunProducerMaintenance(state)) {
    await runSelfHealMaintenance();
    await runInventMaintenance();
    await runAncillaryMaintenance();
  }

  const workedSetIds = workedSet.map((i) => i.id);
  const spendGuard = armDaemonSpendGuard(workedSetIds);
  if (!spendGuard.ok) {
    try {
      if (workedSetIds.length > 0) coordinator.release(workedSetIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator release after spend-guard failure failed:', (err as Error)?.message ?? err);
    }
    return persistenceRefusal(`tick refused: failed to arm spend guard (${spendGuard.error})`);
  }
  let leaseRenewInterval: ReturnType<typeof setInterval> | null = null;
  const renewClaimLeases = (): void => {
    if (workedSetIds.length === 0) return;
    try {
      coordinator.renew(workedSetIds, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator renew failed:', (err as Error)?.message ?? err);
    }
  };
  const startLeaseRenewer = (): void => {
    if (workedSetIds.length === 0) return;
    renewClaimLeases();
    const intervalMs = Math.max(1, Math.min(60_000, Math.floor(sharedQueueLeaseMs / 3)));
    leaseRenewInterval = setInterval(renewClaimLeases, intervalMs);
    (leaseRenewInterval as { unref?: () => void }).unref?.();
  };
  const stopLeaseRenewer = (): void => {
    if (leaseRenewInterval) {
      clearInterval(leaseRenewInterval);
      leaseRenewInterval = null;
    }
  };
  startLeaseRenewer();

  const shadowSkillSelectedAt = new Date().toISOString();
  let shadowSkillCards: readonly SkillCard[] = [];
  if (routingCfg.foundry?.skillLibrary !== false) {
    try {
      shadowSkillCards = Object.freeze([...readSkillCards({ complete: true })]);
    } catch {
      shadowSkillCards = [];
    }
  }

  // -------------------------------------------------------------------------
  // 6b. Live mode: for each selected item (bounded concurrency), run a
  //     sandboxed swarm that records a PENDING inbox proposal.
  //
  //     GUARDRAIL: each swarm call uses opts.sandbox=true (M21 worktree) so
  //     swarm work NEVER touches the user's working tree, plus opts.propose=true
  //     so the runner records the captured diff as a PENDING inbox proposal.
  //     This file has NO outward-action primitive of any kind; a PENDING
  //     proposal is applied LATER only by an explicit human inbox approve.
  // -------------------------------------------------------------------------

  // Shared, mutable in-tick spend tally. Read+incremented by each concurrent
  // task so later dispatches can short-circuit once cumulative realized spend
  // reaches the remaining daily headroom (the USD daily cap is otherwise only
  // enforced BETWEEN ticks — this keeps a single tick from overshooting it).
  let tickSpent = 0;
  // M48: per-backend dispatch tally for this tick (observability only).
  const backendDispatch: Record<string, number> = {};

  // Per-item USD budget slice: divide remaining budget evenly across items.
  const perItemUsdSlice = remainingBudget / Math.max(1, workedSet.length);

  // Convert USD slice to a rough token count for the swarm budget.
  // Using a conservative $15/M-output estimate as the binding constraint.
  // This is best-effort estimation — the daemon's HARD cap is the USD daily budget.
  const usdPerMTokenOut = 15.0;
  const perItemMaxTokens = Math.max(
    1000,
    Math.floor((perItemUsdSlice / usdPerMTokenOut) * 1_000_000),
  );

  // Count proposals by the ACTUAL change in the inbox's PENDING count across the
  // whole batch — NOT by inferring from swarmRun.status==='done'. A swarm that
  // finished but recorded no proposal (e.g. a strict-sandbox abort, or an empty
  // diff) must NEVER be mis-counted as a proposal. pendingCount() is read-only.
  let pendingBefore = 0;
  try { pendingBefore = pendingCount(); } catch { pendingBefore = 0; }
  let pendingBeforeIds = new Set<string>();
  try {
    pendingBeforeIds = new Set(listProposals({ status: 'pending' }).map((p) => p.id));
  } catch {
    pendingBeforeIds = new Set<string>();
  }

  // `dispatched` = a swarm was actually invoked for this item (kill switch /
  // budget short-circuit did NOT skip it). Drives itemsProcessed so `daemon
  // status` reflects real work, not merely items considered.
  type ItemOutcome = TickItemOutcome;

  // M116: build TieredPool from resolved config.
  // In batch mode (default), cap each tier at parallel to preserve identical behavior.
  // In continuous mode (or when concurrency is configured), use the per-tier caps.
  const isContinuousMode = dcfg.mode === 'continuous';
  const tierPool = new TieredPool(
    isContinuousMode || dcfg.concurrency !== undefined
      ? {
          local: dcfg.concurrency?.local ?? 2,
          cloud: dcfg.concurrency?.cloud ?? 6,
          total: dcfg.maxConcurrent ?? dcfg.concurrency?.total ?? 8,
        }
      : {
          // Batch mode default: mirror old bounded(tasks, dcfg.parallel) — all tiers share parallel
          local: dcfg.parallel,
          cloud: dcfg.parallel,
          total: dcfg.parallel,
        },
  );

  // Determine each item's pool tier BEFORE building the task array so the
  // tieredBounded dispatcher knows which slot to request.
  const itemTiers: Array<'local' | 'cloud'> = workedSet.map((item) => {
    const routed = routeBackend(item, routingCfg);
    let backend = routed.backend;
    if (backend !== 'builtin' && !withinLimit(backend, routingCfg)) backend = 'builtin';
    const engineTier = engineTierOf(backend, routingCfg);
    return poolTierOf(engineTier);
  });

  const attemptIds = new Map(workedSet.map((item) => [item.id, createOuterAttemptIdentity()] as const));
  const tasks: Array<{ tier: 'local' | 'cloud'; run: (assignedBackend?: EngineId, assignedReason?: string, assignedModel?: string | null) => Promise<ItemOutcome> }> = workedSet.map((item, _taskIdx) => {
    const attemptId = attemptIds.get(item.id)!;
    return ({
    tier: itemTiers[_taskIdx] ?? 'local',
    run: async (assignedBackend?: EngineId, assignedReason?: string, assignedModel?: string | null): Promise<ItemOutcome> => {
      // Re-check kill switch before each item dispatch.
      if (killSwitchOn()) {
        return {
          item,
          spentUsd: 0,
          dispatched: false,
          dispatch: dispatchTrace(item, {
            assignedBy: 'preflight',
            reason: 'kill switch is ON',
            dispatched: false,
            runId: attemptId,
            trajectoryId: `run:${attemptId}`,
            skipReason: 'kill-switch',
          }),
        };
      }
      // In-tick budget short-circuit: if cumulative realized spend has already
      // reached the remaining daily headroom, do NOT dispatch further items.
      if (tickSpent >= remainingBudget) {
        return {
          item,
          spentUsd: 0,
          dispatched: false,
          dispatch: dispatchTrace(item, {
            assignedBy: 'preflight',
            reason: `in-tick budget cap reached ($${tickSpent.toFixed(4)} >= $${remainingBudget.toFixed(4)})`,
            dispatched: false,
            runId: attemptId,
            trajectoryId: `run:${attemptId}`,
            skipReason: 'budget-cap',
          }),
        };
      }

      let swarmSpent = 0;
      let dispatched = false;
      let backend: EngineId | undefined;
      let backendTier: EngineTier | null = null;
      let assignmentReason = 'not routed';
      let assignedBy = 'preflight';
      let selectedModel: string | null | undefined;
      let dispatch: DaemonDispatchTrace | undefined;

      // M334 stage 1: observe-only gateway shadow. Runs the M247 gateway
      // BESIDE the live legacy decision and records the comparison — THE
      // LEGACY RESULT ALWAYS WINS. Called at the legacy subscription-throttle
      // block and just before dispatch (M53 intelligence-pause returns are not
      // shadowed — rare, intelligence-block-gated). Any failure is swallowed.
      const shadowGateway = async (legacyOutcome: {
        backend: string;
        tier: string | null;
        model?: string | null;
        dispatched: boolean;
      }): Promise<void> => {
        if (routingCfg.foundry?.fabric?.gatewayShadow !== true) return;
        if (routingCfg.foundry?.fabric?.gateway === true) return;
        try {
          const shadowCfg = {
            ...routingCfg,
            foundry: {
              ...routingCfg.foundry,
              fabric: { ...routingCfg.foundry?.fabric, gateway: true },
            },
          } as typeof routingCfg;
          const gd = await gatewayDecide(item, shadowCfg, {
            spentUsd: tickSpent + state.todaySpentUsd,
          });
          const { recordGatewayShadow, compareDecisions } = await import(
            '../fabric/gateway-shadow.js'
          );
          const gw = {
            backend: String(gd.backend),
            tier: gd.tier === null || gd.tier === undefined ? null : String(gd.tier),
            model: gd.model ?? null,
            wouldDispatch: !/^(throttled|budget-pause|resource-pause):/.test(gd.reason),
          };
          recordGatewayShadow({
            ts: new Date().toISOString(),
            workItemId: item.id,
            source: String(item.source ?? ''),
            legacy: legacyOutcome,
            gateway: gw,
            ...compareDecisions(legacyOutcome, gw),
          });
        } catch {
          // shadow is observe-only — never affects the dispatch
        }
      };

      // M247: InferenceGateway — consolidates routing into one traceable decision.
      // FLAG-GATED: when cfg.foundry.fabric?.gateway === true, a single
      // gateway.decide() call replaces the double routeBackend + quota guard +
      // subscription throttle + M53 block below. Default false → old path runs
      // byte-identical. The gateway's flag-off path is itself a thin pass-through
      // to routeBackend, so both branches produce the same result when flag is off.
      //
      // Hoisted so both the gateway branch and the legacy branch can assign it,
      // and subsequent dispatch code sees the same name regardless of path.
      if (assignedBackend !== undefined) {
        if (assignedReason?.startsWith('throttled:') || assignedReason?.startsWith('resource-pause:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: assignedReason,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend: assignedBackend,
              tier: engineTierOf(assignedBackend, routingCfg),
              assignedBy: 'concurrent-planner',
              reason: assignedReason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: assignedReason.split(':')[0] ?? 'concurrent-skip',
            }),
          };
        }
        if (assignedReason?.startsWith('budget-pause:')) {
          audit({
            action: 'daemon:budget-cascade',
            repo: item.repo,
            sandboxId: null,
            summary: `M255 concurrent dispatch: pausing "${item.title}" — ${assignedReason}`,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend: assignedBackend,
              tier: engineTierOf(assignedBackend, routingCfg),
              assignedBy: 'concurrent-planner',
              reason: assignedReason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'budget-pause',
            }),
          };
        }
        backend = assignedBackend;
        backendTier = engineTierOf(backend, routingCfg);
        selectedModel = assignedModel;
        assignmentReason = assignedReason ?? `concurrent planner assigned ${backend}`;
        assignedBy = 'concurrent-planner';
      } else if (routingCfg.foundry?.fabric?.gateway === true) {
        const forecast = buildForecast('7d', routingCfg);
        const gd = await gatewayDecide(item, routingCfg, {
          spentUsd: tickSpent + state.todaySpentUsd,
          forecast,
        });
        // Throttled: subscription window at cap — skip item, same as old path.
        if (gd.reason.startsWith('throttled:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: gd.reason,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend: gd.backend,
              tier: gd.tier,
              model: gd.model,
              assignedBy: 'gateway',
              reason: gd.reason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'throttled',
            }),
          };
        }
        // Budget pause: step down exhausted budget — skip item, same as old path.
        if (gd.reason.startsWith('budget-pause:')) {
          audit({
            action: 'daemon:budget-cascade',
            repo: item.repo,
            sandboxId: null,
            summary: `M247 gateway budget cascade: pausing dispatch for "${item.title}" — ${gd.reason}`,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend: gd.backend,
              tier: gd.tier,
              model: gd.model,
              assignedBy: 'gateway',
              reason: gd.reason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'budget-pause',
            }),
          };
        }
        if (gd.reason.startsWith('resource-pause:')) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: gd.reason,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend: gd.backend,
              tier: gd.tier,
              model: gd.model,
              assignedBy: 'gateway',
              reason: gd.reason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'resource-pause',
            }),
          };
        }
        // Normal dispatch: use gateway decision's backend directly.
        backend = gd.backend;
        backendTier = gd.tier;
        selectedModel = gd.model;
        assignmentReason = gd.reason;
        assignedBy = 'gateway';
      } else {
        // M48: route this item to a backend (M46). Default (no cfg.foundry) →
        // 'builtin'. A frontier backend over its rolling rate quota falls back to
        // local so work keeps flowing without exceeding the subscription's limit.
        // M85: use liveCfg (reloaded per-tick) for routing + quota checks.
        const routed = routeBackend(item, routingCfg);
        backend = routed.backend;
        backendTier = routed.tier;
        selectedModel = routed.model;
        assignmentReason = routed.reason;
        assignedBy = 'router';
        if (backend !== 'builtin' && !withinLimit(backend, routingCfg)) {
          assignmentReason = `${assignmentReason}; quota fallback to builtin`;
          assignedBy = 'quota-fallback';
          backend = 'builtin';
          backendTier = engineTierOf(backend, routingCfg);
          selectedModel = null;
        }

        // M80: subscription-window throttle — skip this item (not crash) when a
        // KNOWN subscription window is at or above the cap (default 90%). Reads
        // cfg.foundry.subscriptionMaxPercent defensively with a fallback default.
        // allowed:true when usage is unknown (claude) or under the cap.
        if (isSubscriptionEngine(backend)) {
          // Read maxPercent from liveCfg.foundry defensively — no types.ts change.
          // Clamp to [1,100]: a negative or zero value would disable the throttle
          // (anything is "under 0%"), and >100 could never fire (nothing is ">100%").
          const rawPct = (liveCfg.foundry as Record<string, unknown> | undefined
            )?.['subscriptionMaxPercent'];
          const maxPct: number = typeof rawPct === 'number'
            ? Math.min(100, Math.max(1, rawPct))
            : 90;
          const subCheck = subscriptionAllows(backend, { maxPercent: maxPct });
          if (!subCheck.allowed) {
            // M334: shadow the BLOCKED legacy decision — a gateway that would
            // have dispatched here is the safety-relevant divergence class.
            await shadowGateway({
              backend: String(backend),
              tier: backendTier === null ? null : String(backendTier),
              model: selectedModel ?? null,
              dispatched: false,
            });
            audit({
              action: 'daemon:tick',
              repo: item.repo,
              sandboxId: null,
              summary: `throttled: ${backend} subscription window — ${subCheck.reason}`,
              result: 'ok',
            });
            return {
              item,
              spentUsd: 0,
              dispatched: false,
              dispatch: dispatchTrace(item, {
                backend,
                tier: engineTierOf(backend, routingCfg),
                model: selectedModel,
                assignedBy: 'subscription-throttle',
                reason: `throttled: ${backend} subscription window — ${subCheck.reason}`,
                dispatched: false,
                runId: attemptId,
                trajectoryId: `run:${attemptId}`,
                skipReason: 'subscription-throttle',
              }),
            };
          }
        }

        // M53: learned-router recommend + budget cascade (flag-off: no-op when
        // cfg.foundry.intelligence is absent). recoverWithinBudget is PURE and
        // may only return a tier choice or a pause signal — no outward action.
        // This file imports NO apply/merge/push/deploy primitive.
        // M85: use liveCfg for intelligence config.
        {
          const intelRaw = routingCfg.foundry?.intelligence;
          if (intelRaw !== undefined && intelRaw !== null) {
            const forecast = buildForecast('7d', routingCfg);
            const goal = buildItemGoal(item);
            const est = await estimateRun(goal, { maxTokens: perItemMaxTokens }, routingCfg);
            const recommended = await recommendRoute(item, routingCfg, { estimate: est });
            // Only override when the recommend result doesn't escalate a local decision.
            if (routed.tier !== 'local' || recommended.tier === 'local') {
              backend = recommended.backend;
              backendTier = recommended.tier;
              if (backend !== routed.backend) {
                selectedModel = configuredModelForBackend(backend, routingCfg);
              }
              assignmentReason = recommended.reason;
              assignedBy = 'learned-router';
            }
            // Budget cascade: step down tier when near cap.
            const recovery = recoverWithinBudget(
              { backend, tier: recommended.tier, reason: recommended.reason },
              routingCfg,
              tickSpent + state.todaySpentUsd,
              forecast,
            );
            if (recovery.action === 'pause') {
              audit({
                action: 'daemon:budget-cascade',
                repo: item.repo,
                sandboxId: null,
                summary: `M53 budget cascade: pausing dispatch for "${item.title}" — ${recovery.reason}`,
                result: 'ok',
              });
              return {
                item,
                spentUsd: 0,
                dispatched: false,
                dispatch: dispatchTrace(item, {
                  backend,
                  tier: backendTier ?? engineTierOf(backend, routingCfg),
                  model: selectedModel,
                  assignedBy: 'budget-cascade',
                  reason: recovery.reason,
                  dispatched: false,
                  runId: attemptId,
                  trajectoryId: `run:${attemptId}`,
                  skipReason: 'budget-pause',
                }),
              };
            } else {
              const previousBackend = backend;
              backend = recovery.decision.backend;
              backendTier = recovery.decision.tier;
              if (backend !== previousBackend) {
                selectedModel = configuredModelForBackend(backend, routingCfg);
              }
              assignmentReason = recovery.reason;
              assignedBy = 'budget-cascade';
            }
          }
        }
      } // end flag-off path

      const beforeLocalClamp = backend;
      backend = enforceLocalBackend(backend, directionPlan);
      if (backend !== beforeLocalClamp) {
        assignmentReason = `${assignmentReason}; autonomy local-only fallback to ${backend}`;
        assignedBy = 'local-only';
        selectedModel = configuredModelForBackend(backend, routingCfg);
      }
      backendTier = engineTierOf(backend, routingCfg);
      if (backend !== 'builtin' && !withinLimit(backend, routingCfg)) {
        assignmentReason = `${assignmentReason}; final quota fallback to builtin`;
        assignedBy = 'quota-fallback';
        backend = 'builtin';
        backendTier = engineTierOf(backend, routingCfg);
        selectedModel = null;
      }
      if (isSubscriptionEngine(backend)) {
        const rawPct = (routingCfg.foundry as Record<string, unknown> | undefined
          )?.['subscriptionMaxPercent'];
        const maxPct: number = typeof rawPct === 'number'
          ? Math.min(100, Math.max(1, rawPct))
          : 90;
        const subCheck = subscriptionAllows(backend, { maxPercent: maxPct });
        if (!subCheck.allowed) {
          audit({
            action: 'daemon:tick',
            repo: item.repo,
            sandboxId: null,
            summary: `throttled: ${backend} subscription window — ${subCheck.reason}`,
            result: 'ok',
          });
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend,
              tier: backendTier,
              model: selectedModel,
              assignedBy: 'subscription-throttle',
              reason: `throttled: ${backend} subscription window — ${subCheck.reason}`,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'subscription-throttle',
            }),
          };
        }
      }
      const goal = buildItemGoal(item);
      const itemBudget = { maxTokens: perItemMaxTokens, maxSteps: 100, allowCloud: false };
      const workItemGenerationId = generatedRepairGenerationId(item) ?? undefined;
      const delegationScope = scopeFromWorkItem(item, {
        runId: attemptId,
        budget: itemBudget,
        backend: {
          engine: backend,
          model: selectedModel ?? null,
          tier: backendTier,
          assignedBy,
          reason: assignmentReason,
        },
      });

    // Snapshot ASHLR_IN_SWARM and restore it after the call. The swarm runner
    // sets ASHLR_IN_SWARM=1 on THIS (long-lived) process and does not unwind it;
    // restoring keeps each subsequent dispatch / tick from hitting the recursion
    // guard while the runner's own child-spawn inheritance still works mid-call.
    const prevInSwarm = process.env['ASHLR_IN_SWARM'];
    let dispatchProduction: DaemonDispatchProduction | undefined;
    let dispatchSkipReason: string | undefined;

    try {
      const sink = nullSink();
      dispatched = true;
      backendDispatch[backend] = (backendDispatch[backend] ?? 0) + 1;

      if (backend === 'builtin') {
        recordDispatchStartAgentAction(item, {
          ts: new Date().toISOString(),
          machineId,
          runId: attemptId,
          backend,
          tier: backendTier,
          model: selectedModel,
          assignedBy,
          reason: assignmentReason,
          mode: 'swarm',
        });
        const swarmRun = await runSwarm(
          { goal },
          routingCfg,
          {
            sandbox: true,             // M21: isolated git-worktree — NEVER user's tree
            requireSandbox: true,      // M24: sandbox MANDATORY — abort if it can't be created
            propose: true,             // M24: swarm records its diff as a PENDING inbox proposal
            project: item.repo,
            budget: itemBudget,
            parallel: 1,
            dryRun: false,
            noCapture: true,
            runId: attemptId,
            workItemId: item.id,
            workItemGenerationId,
            workSource: item.source,
            delegationScope,
          },
          sink,
        );

        const swarmExecuted = swarmRun.status === 'done';
        if (swarmExecuted && swarmRun.proposalOutcome?.kind !== 'kill-switch') {
          observeShadowSkills({
            cards: shadowSkillCards,
            query: {
              title: item.title,
              detail: item.detail,
              source: item.source,
              tags: item.tags,
              route: { backend, tier: backendTier, model: selectedModel, reason: assignmentReason },
            },
            identity: { trajectoryId: `run:${attemptId}`, runId: attemptId },
            selectedAt: shadowSkillSelectedAt,
            route: { backend, tier: backendTier, model: selectedModel },
          });
        }

        const swarmRunSummary = runEventSummary({
          runId: swarmRun.id,
          status: swarmRun.status,
          outcome: swarmRun.proposalOutcome?.kind ?? swarmRun.status,
          proposalCreated: swarmRun.proposalOutcome?.kind === 'filed',
          proposalId: swarmRun.proposalOutcome?.proposalId,
          diffFiles: swarmRun.proposalOutcome?.files,
          diffLines:
            typeof swarmRun.proposalOutcome?.insertions === 'number' ||
            typeof swarmRun.proposalOutcome?.deletions === 'number'
              ? (swarmRun.proposalOutcome?.insertions ?? 0) + (swarmRun.proposalOutcome?.deletions ?? 0)
              : undefined,
          tokensIn: swarmRun.usage?.tokensIn,
          tokensOut: swarmRun.usage?.tokensOut,
          costUsd: swarmRun.usage?.estCostUsd,
        });
        dispatchProduction = dispatchProductionFromProposalOutcome(
          swarmRun.proposalOutcome,
          swarmRun.id,
          swarmRunSummary,
          { proposalRequired: swarmRun.proposalOutcome?.kind !== 'proposal-disabled' },
        );
        dispatchSkipReason = noProposalProductionReason(dispatchProduction);

        swarmSpent = swarmRun.usage?.estCostUsd ?? 0;
        tickSpent += swarmSpent;

        audit({
          action: dispatchProduction?.outcome === 'proposal-created'
            ? 'daemon:proposal-created'
            : 'daemon:no-proposal',
          repo: item.repo,
          sandboxId: null,
          summary:
            `swarm ${swarmRun.id} finished (status=${swarmRun.status}, ` +
            `production=${dispatchProduction?.outcome ?? 'unknown'}, spent=$${swarmSpent.toFixed(4)}) for "${item.title}"`,
          result: 'ok',
        });
      } else {
        // M48: a frontier backend (claude/codex) is itself a full agent — run
        // the WHOLE item as ONE sandboxed-external run (M45): worktree → agent →
        // diff → PENDING proposal. No nested swarm. M45 containment (severed git
        // push, scrubbed diff) + the M47 merge gate still apply downstream.
        const allowedBackends = routingCfg.foundry?.allowedBackends;
        const ashlrcodeExecutorAllowed = Array.isArray(allowedBackends)
          ? allowedBackends.includes('ashlrcode')
          : false;
        if (
          (routingCfg.foundry as Record<string, unknown>)?.['ashlrcodeExecutor'] === true &&
          ashlrcodeExecutorAllowed &&
          backend !== 'ashlrcode' &&
          poolTierOf(engineTierOf(backend, routingCfg)) === 'local'
        ) {
          const previousBackend = backend;
          backend = 'ashlrcode';
          backendTier = engineTierOf(backend, routingCfg);
          selectedModel = routingCfg.foundry?.models?.[backend] ?? null;
          assignedBy = 'ashlrcode-executor';
          assignmentReason = `${assignmentReason}; ashlrcodeExecutor sandboxed ${previousBackend} via ashlrcode`;
        }
        recordUse(backend);

        // M334: shadow the about-to-dispatch legacy decision (observe-only).
        await shadowGateway({
          backend: String(backend ?? 'builtin'),
          tier: backendTier === null ? null : String(backendTier),
          model: selectedModel ?? null,
          dispatched: true,
        });

        // M170: best-of-N dispatch — when cfg.foundry.bestOfN > 1, generate N
        // candidates and let the critic pick the winner. Flag-off: bestOfN absent
        // or 1 → single runGoal call, byte-identical to pre-M170 behavior.
        const bestOfN: number =
          typeof (routingCfg.foundry as Record<string, unknown> | undefined)?.['bestOfN'] === 'number' &&
          ((routingCfg.foundry as Record<string, unknown>)['bestOfN'] as number) > 1
            ? Math.floor((routingCfg.foundry as Record<string, unknown>)['bestOfN'] as number)
            : 1;

        // M333: fan-out gating + multi-model candidate specs + full-cost
        // accounting. bestOfNMinItemScore (absent ⇒ every item, M170 behavior)
        // keeps N× generation for high-value items only; bestOfNCandidates are
        // filtered to allowedBackends; billableCostUsd (ALL candidates,
        // subscription-aware) replaces the winner-only spend accounting.
        const _bonCfg = routingCfg.foundry as Record<string, unknown> | undefined;
        const _bonMinScore = _bonCfg?.['bestOfNMinItemScore'];
        const _bonRawCandidates = _bonCfg?.['bestOfNCandidates'];
        const _bonCandidates = Array.isArray(_bonRawCandidates)
          ? (_bonRawCandidates as Array<{ engine?: unknown; model?: unknown }>)
              .filter((c): c is { engine: string; model?: string | null } =>
                !!c && typeof c.engine === 'string')
              .filter((c) =>
                ((routingCfg.foundry?.allowedBackends ?? []) as string[]).includes(c.engine))
          : undefined;
        const fanOut =
          bestOfN > 1 &&
          (typeof _bonMinScore !== 'number' || (item.score ?? 0) >= _bonMinScore);
        let bonBillable: number | null = null;

        let runState: Awaited<ReturnType<typeof runGoal>>;
        if (fanOut) {
          // Route through runBestOfN; use its winner's underlying runState.
          // runBestOfN never throws; if all candidates fail, winner is undefined
          // and we fall through to a zero-cost no-proposal outcome.
          recordDispatchStartAgentAction(item, {
            ts: new Date().toISOString(),
            machineId,
            runId: attemptId,
            backend,
            tier: backendTier,
            model: selectedModel,
            assignedBy,
            reason: assignmentReason,
            mode: 'best-of-n',
          });
          const bonResult = await runBestOfN(item, routingCfg, {
            n: bestOfN,
            engine: backend,
            model: selectedModel,
            ...(_bonCandidates && _bonCandidates.length > 0
              ? { candidates: _bonCandidates as never }
              : {}),
            workItemId: item.id,
            workItemGenerationId,
            workSource: item.source,
            delegationScope,
            attemptId,
            shadowSkillCards,
            shadowSkillSelectedAt,
          });
          bonBillable = bonResult.critique.billableCostUsd ?? 0;
          if (!bonResult.winner) {
            // All candidates were empty/failing — still count what the fan-out
            // actually spent (M333: the pre-M333 $0 under-reported real spend).
            swarmSpent = bonBillable;
            tickSpent += swarmSpent;
            const production = bestOfNNoWinnerProduction(bonResult, bestOfN);
            audit({
              action: 'daemon:no-proposal',
              repo: item.repo,
              sandboxId: null,
              summary: `${production.reason ?? `best-of-${bestOfN}: no proposal`} for "${item.title}"`,
              result: 'ok',
            });
            return {
              item,
              spentUsd: swarmSpent,
              dispatched: true,
              dispatch: dispatchTrace(item, {
                backend,
                tier: backendTier,
                model: selectedModel,
                assignedBy,
                reason: `${assignmentReason}; best-of-${bestOfN}: all candidates empty`,
                dispatched: true,
                spentUsd: swarmSpent,
                runId: attemptId,
                trajectoryId: `run:${attemptId}`,
                skipReason: noProposalProductionReason(production) ?? 'empty-best-of-n',
                production,
              }),
            };
          }
          // Winner's underlying run state lives in the candidate's state field.
          // Cast to the shape runGoal returns (id, status, usage).
          runState = (bonResult.winner as unknown as { state: Awaited<ReturnType<typeof runGoal>> }).state
            ?? { id: bonResult.winner.proposalId ?? `bon-${Date.now()}`, status: 'done' as const, usage: undefined };
        } else {
          recordDispatchStartAgentAction(item, {
            ts: new Date().toISOString(),
            machineId,
            runId: attemptId,
            backend,
            tier: backendTier,
            model: selectedModel,
            assignedBy,
            reason: assignmentReason,
            mode: 'single',
          });
          runState = await runGoal(goal, routingCfg, {
            engine: backend,
            sandboxEngine: true,
            requireSandbox: true,
            cwd: item.repo,
            budget: itemBudget,
            tools: true,
            noMemory: false,
            runId: attemptId,
            ...(selectedModel ? { model: selectedModel } : {}),
            workItemId: item.id,
            workItemGenerationId,
            workSource: item.source,
            delegationScope,
          });
          const runActionCounts = runState.runEventSummary?.actionCounts;
          const runExecuted = runState.status === 'done' || [
            runActionCounts?.spawnAttempts,
            runActionCounts?.modelSteps,
            runActionCounts?.toolSteps,
            runActionCounts?.totalSteps,
          ].some((count) => typeof count === 'number' && count > 0);
          if (runExecuted && runState.proposalOutcome?.kind !== 'kill-switch') {
            const executedBackend = runState.engine || backend;
            const engineModelPrefix = `${executedBackend}:`;
            const reportedModel = runState.engineModel?.startsWith(engineModelPrefix)
              ? runState.engineModel.slice(engineModelPrefix.length)
              : executedBackend === backend ? selectedModel : null;
            const executedSpec = resolveEngineSpec(executedBackend, routingCfg);
            const allowedModels = new Set([
              executedBackend === backend ? selectedModel : null,
              routingCfg.foundry?.models?.[executedBackend as EngineId],
              executedSpec?.defaultModel,
              executedSpec?.api?.defaultModel,
            ].filter((model): model is string => typeof model === 'string' && model.length > 0));
            const executedModel = reportedModel && allowedModels.has(reportedModel)
              ? reportedModel
              : null;
            const executedTier = runState.engineTier
              ?? (executedBackend === backend ? backendTier : null);
            observeShadowSkills({
              cards: shadowSkillCards,
              query: {
                title: item.title,
                detail: item.detail,
                source: item.source,
                tags: item.tags,
                route: {
                  backend: executedBackend,
                  tier: executedTier,
                  model: executedModel,
                  reason: assignmentReason,
                },
              },
              identity: { trajectoryId: `run:${attemptId}`, runId: runState.id },
              selectedAt: shadowSkillSelectedAt,
              route: {
                backend: executedBackend,
                tier: executedTier,
                model: executedModel,
              },
            });
          }
        }
        dispatchProduction = dispatchProductionFromProposalOutcome(runState.proposalOutcome, runState.id, runState.runEventSummary, {
          proposalRequired: true,
          evidenceOutcome: runState.evidenceOutcome,
        });
        dispatchSkipReason = noProposalProductionReason(dispatchProduction);

        // M80: subscription-tier runs are not dollar-billed — count $0 toward
        // dailyBudgetUsd so they don't exhaust the daily cap. The subscription-
        // window guard (subscriptionAllows above) governs their pacing instead.
        // API-model / builtin paths are unaffected (their isSubscriptionEngine is false).
        // M333: a fan-out counts EVERY candidate's billable spend (subscription
        // rule applied per-candidate inside runBestOfN); single dispatch keeps
        // the M80 winner-path accounting byte-identically.
        swarmSpent = bonBillable !== null
          ? bonBillable
          : isSubscriptionEngine(backend)
            ? 0
            : (runState.usage?.estCostUsd ?? 0);
        tickSpent += swarmSpent;

        audit({
          action: 'daemon:proposal-created',
          repo: item.repo,
          sandboxId: null,
          summary: `${backend} run ${runState.id} finished (status=${runState.status}, spent=$${swarmSpent.toFixed(4)}) for "${item.title}"`,
          result: 'ok',
        });
      }
		    } catch (err) {
		      const msg = err instanceof Error ? err.message : String(err);
		      const errorReason = 'dispatch-error: executor threw';
		      dispatch = dispatchTrace(item, {
		        backend: backend ?? null,
		        tier: backendTier,
		        model: selectedModel,
		        assignedBy,
		        reason: assignmentReason,
		        dispatched,
		        spentUsd: swarmSpent,
		        runId: attemptId,
		        trajectoryId: `run:${attemptId}`,
		        skipReason: errorReason,
		        production: {
		          outcome: 'engine-failed',
		          reason: errorReason,
		        },
		      });
	      audit({
	        action: 'daemon:swarm-error',
        repo: item.repo,
        sandboxId: null,
        summary: `${backend} dispatch failed for "${item.title}": ${msg.slice(0, 200)}`,
        result: 'error',
      });
	    } finally {
	      if (prevInSwarm === undefined) delete process.env['ASHLR_IN_SWARM'];
	      else process.env['ASHLR_IN_SWARM'] = prevInSwarm;
	    }

	    dispatch ??= dispatchTrace(item, {
	      backend,
	      tier: backendTier,
	      model: selectedModel,
	      assignedBy,
	      reason: assignmentReason,
	      dispatched,
	      spentUsd: swarmSpent,
	      runId: attemptId,
	      trajectoryId: `run:${attemptId}`,
	      ...(dispatchSkipReason ? { skipReason: dispatchSkipReason } : {}),
	      ...(dispatchProduction ? { production: dispatchProduction } : {}),
	    });

    // M53: anomaly-hold — if run cost > k×p50, hold the proposal PENDING and
    // file a TuningProposal. NEVER auto-apply. This block imports NO
    // apply/merge/push/deploy primitive.
    if (dispatched && swarmSpent > 0) {
      const intelRaw2 = routingCfg.foundry?.intelligence;
      if (intelRaw2 !== undefined && intelRaw2 !== null) {
        const intelCfg2 = intelRaw2 as { anomalyK?: number };
        const anomalyK = typeof intelCfg2.anomalyK === 'number' && intelCfg2.anomalyK > 0
          ? intelCfg2.anomalyK : 4;
        const goal2 = buildItemGoal(item);
        const est2 = await estimateRun(goal2, { maxTokens: perItemMaxTokens }, routingCfg).catch((err) => { console.warn('[ashlr] daemon:tick estimateRun failed:', (err as Error)?.message ?? err); return null; });
        const p50 = est2?.estCostUsd.median ?? 0;
        if (p50 > 0 && swarmSpent > anomalyK * p50) {
          audit({
            action: 'daemon:anomaly-hold',
            repo: item.repo,
            sandboxId: null,
            summary:
              `M53 anomaly hold: "${item.title}" cost $${swarmSpent.toFixed(4)} ` +
              `> ${anomalyK}×p50 ($${(anomalyK * p50).toFixed(4)}) — proposal stays PENDING`,
            result: 'ok',
          });
          // File a TuningProposal describing the anomaly (proposal-only, never auto-applied).
          try {
            emitTuningProposals([{
              key: `anomaly.cost.${item.id.replace(/[^a-z0-9]/gi, '-').slice(0, 40)}`,
              area: 'policy',
              title: `Cost anomaly hold: "${item.title.slice(0, 60)}"`,
              rationale:
                `Run cost $${swarmSpent.toFixed(4)} exceeded ${anomalyK}×p50 ` +
                `($${(anomalyK * p50).toFixed(4)}) for "${item.title}". ` +
                `Proposal held PENDING for human review.`,
              confidence: Math.min(0.9, 0.5 + (swarmSpent / (anomalyK * p50) - 1) / 10),
            }]);
          } catch (err) {
            // Emission must never crash the tick.
            console.warn('[ashlr] daemon:tick emitTuningProposals failed:', (err as Error)?.message ?? err);
          }
        }
      }
    }

	    return { item, spentUsd: swarmSpent, dispatched, dispatch };
    }, // end run:
    });
  });  // end tasks.map

  // M255: Concurrent Multi-Backend Dispatcher — flag-gated.
  // When fabric.concurrentDispatch === true, replace the serial per-item loop
  // with planConcurrentDispatch + runConcurrentDispatch across ALL backends with
  // headroom in PARALLEL. Each backend is bounded to its slot cap from the
  // resource monitor; protected gateway route hints are preserved while
  // local-mid bulk items can spread across workhorse backends. Results are
  // converted to the same PromiseSettledResult<ItemOutcome>[]
  // shape as the existing paths so all downstream accounting (dispatchedCount,
  // proposalDelta, ledger recording) is byte-identical.
  //
  // FLAG-OFF (default): falls through to the existing batch/tieredBounded paths —
  // byte-identical to pre-M255 behavior.
  const useConcurrentDispatch = routingCfg.foundry?.fabric?.concurrentDispatch === true;

  let outcomes: PromiseSettledResult<ItemOutcome>[];
  let dispatchManifest: DaemonTick['dispatchManifest'] | undefined;

  try {
  if (useConcurrentDispatch) {
    // Re-sense headroom before planning (cached 30s; no extra cost in practice).
    const concurrentSnap = selectionResourceSnapshot ?? (await getResourceSnapshot(routingCfg).catch(() => ({
      generatedAt: new Date().toISOString(),
      backends: [{ backend: 'builtin' as const, availability: 'open' as const, usedPct: null, cap: null, capUnit: null, capWindow: null, resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: new Date().toISOString(), reason: 'snapshot-failed', backoffUntilMs: null }],
    })));

    const maxSlotsPerBackend: number =
      typeof (routingCfg.foundry?.fabric as Record<string, unknown> | undefined)?.['maxSlotsPerBackend'] === 'number'
        ? Math.max(1, (routingCfg.foundry!.fabric as Record<string, unknown>)['maxSlotsPerBackend'] as number)
        : 3;

    const concurrentCfg = { maxSlotsPerBackend };

    // planConcurrentDispatch: pure, uses gateway routing hints for suitability.
    // Build routing hints in parallel via gateway.decide, then call the pure planner.
    const routeHints = new Map<string, EngineId>();
    const routeReasons = new Map<string, string>();
    const routeModels = new Map<string, string | null>();
    if (routingCfg.foundry?.fabric?.gateway === true) {
      const gds = await Promise.allSettled(
        workedSet.map((item) => gatewayDecide(item, routingCfg, { spentUsd: tickSpent + state.todaySpentUsd }))
      );
      for (let i = 0; i < workedSet.length; i++) {
        const d = gds[i];
        if (d?.status === 'fulfilled') {
          routeHints.set(workedSet[i]!.id, d.value.backend);
          routeReasons.set(workedSet[i]!.id, d.value.reason);
          routeModels.set(workedSet[i]!.id, d.value.model ?? null);
        }
      }
    }
    const routeItem = buildConcurrentDispatchRouteItem(
      concurrentSnap,
      concurrentCfg,
      routingCfg,
      routeHints,
      routeReasons,
    );
    const concurrentPlan = planConcurrentDispatch(
      workedSet,
      concurrentSnap,
      concurrentCfg,
      routeItem,
    );
    const dispatchManifestEvent = buildDispatchManifestEvent({
      ts: now,
      machineId,
      plan: concurrentPlan,
      routeReasons,
      routeModels,
      attemptIds,
      resourceSnapshotAt: concurrentSnap.generatedAt,
      dryRun: false,
    });
    dispatchManifest = recordDispatchManifest(dispatchManifestEvent);

    // runConcurrentDispatch: executes plan with full cross-backend parallelism.
    const concurrentResults = await runConcurrentDispatch(
      concurrentPlan,
      async (item, _backend): Promise<unknown> => {
        // Each dispatched item flows through the FULL task run function.
        // Find the pre-built task for this item (same gate logic: kill-switch,
        // budget short-circuit, gateway/serial routing, sandbox, judge, etc.).
        // We look up by item.id to reuse the existing tasks[] entries which
        // already capture tickSpent/state/liveCfg via closure.
        const taskEntry = tasks.find((_t, idx) => workedSet[idx]?.id === item.id);
        if (taskEntry) {
          const hintedBackend = routeHints.get(item.id);
          const baseReason = routeReasons.get(item.id);
          const assignedReason = (
            hintedBackend !== undefined &&
            hintedBackend !== _backend &&
            baseReason &&
            !baseReason.startsWith('throttled:') &&
            !baseReason.startsWith('budget-pause:') &&
            !baseReason.startsWith('resource-pause:')
          )
            ? `${baseReason}; concurrent planner assigned ${_backend}`
            : baseReason;
          const assignedModel = hintedBackend === _backend ? routeModels.get(item.id) : undefined;
          return taskEntry.run(_backend, assignedReason, assignedModel);
        }
	        // Fallback: build a minimal no-op outcome (item not in tasks — shouldn't happen).
	        return {
	          item,
	          spentUsd: 0,
	          dispatched: false,
	          dispatch: dispatchTrace(item, {
	            backend: _backend,
	            tier: engineTierOf(_backend, routingCfg),
	            assignedBy: 'concurrent-planner',
	            reason: 'concurrent planner assigned item with no task entry',
	            dispatched: false,
	            skipReason: 'missing-task-entry',
	          }),
	        } satisfies ItemOutcome;
	      },
      killSwitchOn,
      concurrentCfg,
    );

    // Convert DispatchResult[] → PromiseSettledResult<ItemOutcome>[] for downstream.
    outcomes = concurrentResults.map((r): PromiseSettledResult<ItemOutcome> => {
      if (r.settled?.status === 'rejected') {
        return { status: 'rejected', reason: r.settled.reason };
      }
      const inner = r.settled?.status === 'fulfilled'
        ? (r.settled.value as ItemOutcome | undefined)
        : undefined;
	      const attemptId = attemptIds.get(r.item.id);
	      return {
	        status: 'fulfilled',
	        value: inner ?? {
	          item: r.item,
	          spentUsd: 0,
	          dispatched: r.attempted,
	          dispatch: dispatchTrace(r.item, {
	            backend: r.backend,
	            tier: engineTierOf(r.backend, routingCfg),
	            assignedBy: 'concurrent-planner',
	            reason: 'concurrent dispatch result missing inner outcome',
	            dispatched: r.attempted,
	            skipReason: r.attempted ? 'missing-outcome' : 'not-attempted',
	            ...(attemptId ? { runId: attemptId, trajectoryId: `run:${attemptId}` } : {}),
	          }),
	        },
	      };
	    });

	    // Add unassigned items as non-dispatched fulfilled outcomes.
	    for (const item of concurrentPlan.unassigned) {
	      outcomes.push({
	        status: 'fulfilled',
	        value: {
	          item,
	          spentUsd: 0,
	          dispatched: false,
	          dispatch: dispatchTrace(item, {
	            assignedBy: 'concurrent-planner',
	            reason: 'no concurrent dispatch slot assigned',
	            dispatched: false,
	            skipReason: 'unassigned',
	          }),
	        },
	      });
	    }
  } else {
    // Batch mode (default — no continuous mode, no explicit concurrency config):
    // use the exact pre-M116 bounded worker-pool so dispatch + the in-tick budget
    // short-circuit are byte-identical (preserves the H3 overshoot bound). The
    // tiered pool only engages for continuous mode or explicit daemon.concurrency.
    // Detect batch mode from the RAW user config — resolveCfg ALWAYS populates
    // dcfg.concurrency with defaults, so checking dcfg would never be batch.
    const explicitConcurrency =
      liveCfg.daemon?.concurrency !== undefined || liveCfg.daemon?.maxConcurrent !== undefined;
    const useBatchPool = !isContinuousMode && !explicitConcurrency;
    outcomes = useBatchPool
      ? await bounded(tasks.map((t) => t.run), dcfg.parallel)
      : await tieredBounded(tasks, tierPool);
  }
  } finally {
    stopLeaseRenewer();
  }

  // itemsProcessed counts items whose swarm was actually dispatched (not those
  // skipped by the kill switch or the in-tick budget short-circuit).
  let dispatchedCount = 0;
	  for (const outcome of outcomes) {
	    if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
	      dispatchedCount++;
	    }
	  }
	  const dispatches = dispatchesFromOutcomes(outcomes);

  // Proposals actually recorded this tick = the PENDING-count delta (clamped >=0).
  let proposalsCreated = 0;
  try { proposalsCreated = Math.max(0, pendingCount() - pendingBefore); } catch (err) { console.warn('[ashlr] daemon:tick proposalDelta count failed:', (err as Error)?.message ?? err); proposalsCreated = 0; }
  const proposalProduction = proposalProductionSummary(selected.length, workedSet.length, outcomes, proposalsCreated);

  const newPendingProposalsByItemId = new Map<string, Proposal>();
  let pendingProposalDeltaReadFailed = false;
  try {
    for (const proposal of listProposals({ status: 'pending' })) {
      if (pendingBeforeIds.has(proposal.id)) continue;
      if (proposal.workItemId && !newPendingProposalsByItemId.has(proposal.workItemId)) {
        newPendingProposalsByItemId.set(proposal.workItemId, proposal);
      }
    }
  } catch {
    pendingProposalDeltaReadFailed = true;
  }

  const productionCompletedAt = new Date().toISOString();
  const productionEvents = outcomes.flatMap((outcome): DispatchProductionEvent[] => {
    if (outcome.status !== 'fulfilled' || !outcome.value.dispatched) return [];
    const event = dispatchProductionEventFromOutcome(
      outcome.value,
      newPendingProposalsByItemId.get(outcome.value.item.id),
      machineId,
      productionCompletedAt,
    );
    return event ? [event] : [];
  });
  const handoffFailedItemIds = new Set<string>();
  for (const event of productionEvents) {
    const repairable = repairHandoffFromDispatchEvent(event) !== null;
    if (liveCfg.fleet?.sharedQueue?.mode === 'filesystem') {
      if (repairable) handoffFailedItemIds.add(event.itemId);
    } else {
      const handoff = recordRepairHandoffs(event);
      if (handoff.failed > 0) handoffFailedItemIds.add(event.itemId);
    }
  }

  // M85/M305: record item-accurate outcomes to the worked ledger. New proposals
  // carry workItemId, so a multi-item tick can tell which dispatched item filed
  // a patch instead of relying on the old aggregate pending-count heuristic.
  // Non-dispatched items (kill-switch / budget skip) are NOT recorded — they
  // were never run, so they should not trigger a cooldown.
  if (dispatchedCount > 0) {
    try {
      const proposalItemIds = new Set<string>(newPendingProposalsByItemId.keys());
      if (pendingProposalDeltaReadFailed) {
        // Fallback preserves the old conservative behavior if the inbox cannot
        // be read after dispatch.
        if (proposalsCreated >= dispatchedCount) {
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
              proposalItemIds.add(outcome.value.item.id);
            }
          }
        }
      }
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
          if (handoffFailedItemIds.has(outcome.value.item.id)) continue;
          if (outcome.value.dispatch?.production?.outcome === 'proposal-disabled') {
            continue;
          }
          const outcomeLabel =
            workedOutcomeFromDispatchProduction(outcome.value.dispatch?.production) ??
            (proposalItemIds.has(outcome.value.item.id) ? 'diff' : 'empty');
          // M113: route through coordinator (Local → worked-ledger; Shared → global store).
          coordinator.recordOutcome(generatedRepairCooldownKey(outcome.value.item), outcomeLabel, machineId);
        }
      }
    } catch (err) {
      // Ledger recording must never crash the tick.
      console.warn('[ashlr] daemon:tick ledger recordOutcome failed:', (err as Error)?.message ?? err);
    }
  }

  // Generated-repair lifecycle is a local, atomic control store. Shared-queue
  // mode stays fail-closed until claim fencing can bind late outcomes safely.
  if (dispatchedCount > 0 && liveCfg.fleet?.sharedQueue?.mode !== 'filesystem') {
    try {
      for (const outcome of outcomes) {
        if (
          outcome.status !== 'fulfilled' ||
          !outcome.value.dispatched ||
          !isTrustedGeneratedRepairItem(outcome.value.item)
        ) continue;
        const trace = outcome.value.dispatch;
        const production = trace?.production;
        const attemptId = trace?.trajectoryId ?? trace?.runId ?? production?.runId;
        if (!production || !attemptId) continue;
        if (
          production.outcome === 'empty-diff' &&
          !production.reason?.startsWith('best-of-')
        ) {
          recordGeneratedRepairLifecycle(outcome.value.item, {
            kind: 'empty-diff',
            attemptId,
          });
          continue;
        }
        if (production.outcome !== 'proposal-created') continue;
        const proposal = newPendingProposalsByItemId.get(outcome.value.item.id);
        if (
          !proposal ||
          proposal.status !== 'pending' ||
          proposal.workItemId !== outcome.value.item.id ||
          proposal.workItemGenerationId !== generatedRepairGenerationId(outcome.value.item) ||
          !proposal.repo ||
          resolve(proposal.repo) !== resolve(outcome.value.item.repo) ||
          !production.proposalId ||
          production.proposalId !== proposal.id ||
          !production.runId ||
          !proposal.runId ||
          production.runId !== proposal.runId ||
          proposal.runEventSummary?.status !== 'done' ||
          proposal.isPartial === true ||
          !trace?.trajectoryId ||
          !proposal.trajectoryId ||
          trace.trajectoryId !== proposal.trajectoryId
        ) continue;
        recordGeneratedRepairLifecycle(outcome.value.item, {
          kind: 'proposal-created',
          attemptId,
          proposalId: proposal.id,
        });
      }
    } catch (err) {
      console.warn('[ashlr] daemon:tick generated repair lifecycle failed:', (err as Error)?.message ?? err);
    }
  }

  if (dispatchedCount > 0) {
    try {
      recordDispatchProduction(productionEvents);
      recordAgentAction(productionEvents.map(agentActionFromDispatchEvent));
    } catch (err) {
      console.warn('[ashlr] daemon:tick dispatch production ledger failed:', (err as Error)?.message ?? err);
    }
  }
  try {
    const completedAt = new Date().toISOString();
    const skipActions = outcomes.flatMap((outcome): AgentActionEvent[] => {
      if (outcome.status !== 'fulfilled') return [];
      const event = agentActionFromDispatchSkip(outcome.value, completedAt, machineId);
      return event ? [event] : [];
    });
    recordAgentAction(skipActions);
  } catch (err) {
    console.warn('[ashlr] daemon:tick dispatch skip ledger failed:', (err as Error)?.message ?? err);
  }

  // M113: release any claimed-but-not-dispatched items so they're free for
  // the next machine or tick (no-op for LocalWorkQueueCoordinator).
  try {
    const dispatchedIds = new Set(
      outcomes
        .filter((o): o is PromiseFulfilledResult<ItemOutcome> => o.status === 'fulfilled' && o.value.dispatched)
        .map(o => o.value.item.id),
    );
    const unworkedIds = workedSet.map(i => i.id).filter(id => !dispatchedIds.has(id));
    if (unworkedIds.length > 0) coordinator.release(unworkedIds, machineId);
  } catch (err) {
    // Release must never crash the tick.
    console.warn('[ashlr] daemon:tick coordinator release failed:', (err as Error)?.message ?? err);
  }

  // M48: OPT-IN auto-merge pass (cfg.foundry.autoMerge.enabled, DEFAULT OFF).
  // Delegated to fleet/automerge-pass so THIS file imports no merge primitive.
  // Every merge runs the M47 tiered-trust gate (frontier authority + risk ≤
  // maxRisk + full verify + kill-switch + enrollment); unauthorized proposals
  // stay PENDING. With autoMerge disabled this is a no-op — the daemon stays
  // strictly proposal-only.
  let merged = 0;
  let autoMergePassResult: AutoMergePassResult | null = null;
  autoMergePassResult = preDispatchAutoMergePassRan ? preDispatchAutoMergePassResult : await runAutoMergeMaintenancePass();
  const autoMerge = autoMergeTickSummary(autoMergePassResult);
  merged = autoMergePassResult?.merged ?? 0;
  const producerMaintenance = producerMaintenanceSummary();

  // -------------------------------------------------------------------------
  // 7. Update + persist state with this tick's accounting.
  // -------------------------------------------------------------------------
  const finalLoadedState = loadDaemonStateStrict(); // reload in case of concurrent writes
  if (!finalLoadedState.ok) {
    const failedTick: DaemonTick = {
      ts: now,
      itemsConsidered: selected.length,
      proposalsCreated,
      spentUsd: tickSpent,
	      reason: 'state-persistence-failed',
	      ...(Object.keys(backendDispatch).length > 0 ? { backends: backendDispatch } : {}),
	      ...(directionMode ? { directionMode } : {}),
	      ...(directionPlan ? { directionReason: directionPlan.reason } : {}),
	      ...(autoMerge ? { autoMerge } : {}),
	      ...(remoteHandoff ? { remoteHandoff } : {}),
	      ...(producerMaintenance ? { producerMaintenance } : {}),
	      ...(proposalProduction ? { proposalProduction } : {}),
	      ...(dispatchManifest ? { dispatchManifest } : {}),
	      ...(drain ? { drain } : {}),
	      ...(dispatches ? { dispatches } : {}),
	      ...(merged > 0 ? { merged } : {}),
	    };
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend accounting refused: daemon state ${finalLoadedState.reason} (${finalLoadedState.error}); spend guard remains armed`,
      result: 'error',
    });
    recordTickAgentAction(failedTick, machineId);
    return failedTick;
  }
  state = finalLoadedState.state;
  state = resetDayIfNeeded(state);         // re-check day rollover after async work
  state.todaySpentUsd += tickSpent;
  state.itemsProcessed += dispatchedCount;
  state.lastTickAt = now;

  const tickRecord: DaemonTick = {
    ts: now,
    itemsConsidered: selected.length,
    proposalsCreated,
    spentUsd: tickSpent,
    reason: 'ok',
	    ...(Object.keys(backendDispatch).length > 0 ? { backends: backendDispatch } : {}),
	    ...(directionMode ? { directionMode } : {}),
	    ...(directionPlan ? { directionReason: directionPlan.reason } : {}),
	    ...(autoMerge ? { autoMerge } : {}),
	    ...(remoteHandoff ? { remoteHandoff } : {}),
	    ...(producerMaintenance ? { producerMaintenance } : {}),
	    ...(proposalProduction ? { proposalProduction } : {}),
	    ...(dispatchManifest ? { dispatchManifest } : {}),
	    ...(drain ? { drain } : {}),
	    ...(dispatches ? { dispatches } : {}),
	    ...(merged > 0 ? { merged } : {}),
	  };
  state.ticks = [...state.ticks, tickRecord];
  const saveResult = saveDaemonStateResult(state);
  if (!saveResult.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend accounting save failed (${saveResult.error}); spend guard remains armed`,
      result: 'error',
    });
    const failedTick = { ...tickRecord, reason: 'state-persistence-failed' };
    recordTickAgentAction(failedTick, machineId);
    return failedTick;
  }
  const clearGuardResult = clearDaemonSpendGuard(spendGuard.guard.token);
  if (!clearGuardResult.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend guard clear failed (${clearGuardResult.error}); future ticks will refuse`,
      result: 'error',
    });
    const failedTick = { ...tickRecord, reason: 'state-persistence-failed' };
    recordTickAgentAction(failedTick, machineId);
    return failedTick;
  }

  recordTickAgentAction(tickRecord, machineId);

  // M89/M91: best-effort fleet→pulse telemetry export. Runs OUTSIDE the proposal
  // guarantees — only reads state + POSTs telemetry; never mutates repos.
  // M91 incremental: pass lastPulseExportAt as sinceTs so only NEW events are
  // sent each tick. On a 2xx response, advance the watermark and persist it;
  // on failure leave the watermark unchanged so events retry next tick.
  // Never throws.
  // M89/M91 pulse export: sinceTs is captured synchronously from the state we
  // just saved so the async export reads a stable, already-persisted watermark.
  // The watermark advance is done via a narrow read-modify-write that re-loads
  // the LATEST state immediately before writing, touching ONLY lastPulseExportAt,
  // so it cannot clobber a concurrent tick's todaySpentUsd / itemsProcessed /
  // ticks accounting.
  if (cfg.pulse?.enabled) {
    const sinceTs = state.lastPulseExportAt; // captured from the state we already saved
    void import('../fleet/pulse-export.js').then(async ({ exportToPulse }) => {
      try {
        const ok = await exportToPulse(cfg, { sinceTs });
        if (ok) {
          // Narrow read-modify-write: reload freshest state, touch ONLY the
          // watermark, then save — never clobbers concurrent tick accounting.
          const fresh = loadDaemonState();
          fresh.lastPulseExportAt = tickRecord.ts;
          saveDaemonState(fresh);
        }
      } catch (err) {
        // Best-effort — telemetry must never crash the daemon.
        console.warn('[ashlr] daemon:tick pulse export failed:', (err as Error)?.message ?? err);
      }
    }).catch((err) => { console.warn('[ashlr] daemon:tick pulse-export lazy-import failed:', (err as Error)?.message ?? err); return undefined; });
  }

  // ── Phase H: fleet→pulse ROUND-TRIP (cloud orchestrates, local executes). ──
  // On each live tick: emit a 'tick' heartbeat span, then POLL the cloud's
  // fleet_command queue (read-scoped PAT), CLAIM + APPLY each pending command
  // LOCALLY (assign_goal→createGoal / approve|reject_proposal→inbox setStatus /
  // enroll_repo→enrollment), PATCH the metadata-only outcome back, and ship
  // enrolled-repo dependency edges as `deps` spans.
  //
  // FULLY GATED + NO-THROW: pulse-sync is a complete no-op unless BOTH a Pulse
  // endpoint (PULSE_URL / cfg.pulse.endpoint) AND a PAT (PULSE_FLEET_PAT /
  // ASHLR_PULSE_*) are configured. It performs NO outward git action of its own
  // — assign_goal only PLANS, approve_proposal only flips a proposal's STATUS
  // (the diff is NOT applied here), enroll_repo only adds to the registry — so
  // the daemon's enrollment / kill-switch / proposal-only floor is unweakened.
  // LAZY-imported (keeps loop.ts's static outward-primitive grep-guards intact)
  // and fire-and-forget so a Pulse outage never blocks or breaks the tick.
  // DRY-RUN never reaches here (it returns earlier), so this only runs live.
  void import('../integrations/pulse-sync.js').then(async ({ runPulseSync }) => {
    try {
      await runPulseSync(cfg, { tickTs: tickRecord.ts });
    } catch (err) {
      // Best-effort — the round-trip must never crash the daemon.
      console.warn('[ashlr] daemon:tick pulse-sync failed:', (err as Error)?.message ?? err);
    }
  }).catch((err) => { console.warn('[ashlr] daemon:tick pulse-sync lazy-import failed:', (err as Error)?.message ?? err); return undefined; });

  // M214: fire-and-forget tick-cost emit to Pulse OTLP — additive, never throws, no control-flow change.
  // Lazy-imported (mirrors the pulse-sync pattern) so loop.ts's static grep-guards stay intact.
  void import('../integrations/fleet-pulse-emit.js').then(async ({ emitTickCost }) => {
    try {
      await emitTickCost(cfg, tickRecord.ts, tickRecord.spentUsd, tickRecord.proposalsCreated, merged);
    } catch {
      // Best-effort — telemetry must never crash the daemon.
    }
  }).catch(() => { /* lazy-import best-effort */ });

  // ── M257 Director cycle — gated, additive, fire-and-forget ─────────────────
  // Runs at most once every 15 minutes (tracked in process memory; dormant when
  // cfg.comms.director is absent/false — byte-identical to absent).
  // SAFETY: director is READ-ONLY god-view access in M257. No goal mutations,
  // no merge/push/apply, no bypass of any safety gate.
  void (() => {
    try {
      const directorEnabled =
        (cfg.comms as Record<string, unknown> | undefined)?.['director'] === true;
      if (!directorEnabled) return;

      const DIRECTOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
      const now = Date.now();
      const proc = process as unknown as Record<string, unknown>;
      const last = proc['__ashlrDirectorLastRunMs'];
      const lastMs = typeof last === 'number' ? last : 0;
      if (now - lastMs < DIRECTOR_INTERVAL_MS) return;
      proc['__ashlrDirectorLastRunMs'] = now;

      void import('../comms/director.js').then(async ({ runDirectorCycle }) => {
        try {
          await runDirectorCycle(cfg);
        } catch {
          // Fire-and-forget — director must never crash the daemon.
        }
      }).catch(() => { /* lazy-import best-effort */ });
    } catch {
      // Gate check must never crash the daemon.
    }
  })();

  audit({
    action: 'daemon:tick',
    repo: null,
    sandboxId: null,
    summary: `tick ok: ${selected.length} item(s) considered, ${proposalsCreated} proposal(s) created, ${merged} merged, $${tickSpent.toFixed(4)} spent`,
    result: 'ok',
  });

  return tickRecord;
}

// ---------------------------------------------------------------------------
// runDaemon — the operator loop
// ---------------------------------------------------------------------------

/**
 * Start the daemon operator.
 *
 * REFUSES (returns unchanged state) if ASHLR_IN_DAEMON or ASHLR_IN_SWARM is
 * set — prevents daemon-inside-daemon and daemon-inside-swarm fork bombs.
 *
 * Sets ASHLR_IN_DAEMON=1 on this process.env so all child spawns inherit it.
 *
 * opts.once = true  => run exactly one tick then stop.
 * opts.once = false => loop: tick → sleep intervalMs → tick → ... until kill
 *                      switch is set. Same-day budget exhaustion keeps the
 *                      resident daemon alive and paused until the next UTC
 *                      budget day, then tick() resets/guards spend before work.
 *                      NO unbounded dispatch — every iteration re-checks both.
 *
 * Never throws.
 */
export async function runDaemon(
  cfg: AshlrConfig,
  opts: DaemonRunOptions,
): Promise<DaemonState> {
  // -------------------------------------------------------------------------
  // RE-ENTRANCY GUARD — must be the very first check.
  // -------------------------------------------------------------------------
  if (process.env['ASHLR_IN_DAEMON'] || process.env['ASHLR_IN_SWARM']) {
    // Refuse silently — do not start; return current state unchanged.
    return loadDaemonState();
  }

  const lockAttempt = acquireDaemonLock();
  if (!lockAttempt.acquired) {
    audit({
      action: 'daemon:start',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: singleton lock busy${lockAttempt.owner ? ` (pid ${lockAttempt.owner.pid})` : ''}`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  const daemonLock = lockAttempt.lock;

  const startLoadedState = loadDaemonStateStrict();
  if (!startLoadedState.ok) {
    releaseDaemonLock(daemonLock);
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: daemon state ${startLoadedState.reason} (${startLoadedState.error})`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  let state = startLoadedState.state;
  if (state.running === true && typeof state.pid === 'number' && state.pid !== process.pid) {
    releaseDaemonLock(daemonLock);
    audit({
      action: 'daemon:start',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: existing live daemon state pid ${state.pid}`,
      result: 'refused',
    });
    return state;
  }

  // -------------------------------------------------------------------------
  // Set ASHLR_IN_DAEMON=1 on THIS process so all child engine spawns inherit it.
  // Snapshot the prior value so it can be restored on exit — without this a
  // second in-process runDaemon call (programmatic reuse / tests) would hit the
  // re-entrancy guard above and silently refuse forever.
  // -------------------------------------------------------------------------
  const prevInDaemon = process.env['ASHLR_IN_DAEMON'];
  process.env['ASHLR_IN_DAEMON'] = '1';

  const dcfg = resolveCfg(cfg);

  // -------------------------------------------------------------------------
  // Mark daemon as running.
  // -------------------------------------------------------------------------
  state = resetDayIfNeeded(state);
  state.running = true;
  state.pid = process.pid;
  state.startedAt = new Date().toISOString();
  const startSave = saveDaemonStateResult(state);
  if (!startSave.ok) {
    releaseDaemonLock(daemonLock);
    if (prevInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
    else process.env['ASHLR_IN_DAEMON'] = prevInDaemon;
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon start refused: failed to persist running state (${startSave.error})`,
      result: 'refused',
    });
    return loadDaemonState();
  }
  heartbeatDaemonLock(daemonLock);
  const stopLockHeartbeat = startDaemonLockHeartbeat(daemonLock);

  audit({
    action: 'daemon:start',
    repo: null,
    sandboxId: null,
    summary:
      `daemon started: once=${opts.once}, dryRun=${opts.dryRun}, budget=$${dcfg.dailyBudgetUsd}, ` +
      `intervalMs=${dcfg.intervalMs}${opts.drain ? `, drain=${opts.drain}` : ''}` +
      `${opts.drainLimit ? `, drainLimit=${opts.drainLimit}` : ''}`,
    result: 'ok',
  });

  // -------------------------------------------------------------------------
  // H5 CHANGE 1 — WIRE THE ORPHAN SWEEP (crash-leftover reclaim).
  // On daemon start, BEFORE the first tick, reclaim crash-leftover worktrees with
  // a conservative staleMs GREATER than the max swarm wall-clock (ORPHAN_STALE_MS,
  // shared from worktree.ts) so a LIVE in-flight worktree younger than staleMs is
  // NEVER reclaimed — only genuine crash leftovers are swept. Inward cleanup only:
  // sweepOrphanSandboxes routes every removal through removeSandbox, inheriting its
  // containment guards verbatim (re-derived safe path + branch; a tampered/out-of-
  // namespace entry falls through to local-dir cleanup only). It pushes nothing,
  // opens no PR, applies no proposal — it is purely inward worktree reclaim. The
  // worktree module is LAZY-imported so the daemon's STATIC outward-primitive
  // grep-guards stay intact, and the whole thing is wrapped so a sweep failure
  // NEVER throws out of runDaemon. Audited via the daemon:start surface.
  //
  // DRY-RUN = ZERO SIDE EFFECTS: the sweep performs real destructive on-disk git
  // ops (`git worktree remove --force` / `git branch -D` via removeSandbox), so
  // in dry-run mode we SKIP the actual reclaim and instead audit a PREVIEW of
  // what WOULD be reclaimed (count only, via a guarded staleMs-eligible probe),
  // honoring the strict 'dry-run mutates nothing' expectation that the rest of
  // loop.ts upholds (it creates no proposals / makes no outward changes). A
  // normal (non-dry) start reclaims for real. Documented in docs/contracts/CONTRACT-H5.md.
  if (opts.dryRun) {
    // Dry-run previews the loop WITHOUT mutating disk: skip the real reclaim and
    // audit only the count that WOULD be reclaimed (a read-only listSandboxes()
    // count; the actual liveness/age filtering happens for real on a non-dry
    // start). This keeps `daemon start --dry-run` side-effect-free.
    try {
      const wt = await import('../sandbox/worktree.js');
      const wouldConsider = wt.listSandboxes().length;
      audit({
        action: 'daemon:start',
        repo: null,
        sandboxId: null,
        summary: `dry-run: orphan sweep skipped (${wouldConsider} sandbox(es) on disk; none swept)`,
        result: 'ok',
      });
    } catch {
      // Best-effort: a preview failure must never crash daemon start.
    }
  } else {
    try {
      const wt = await import('../sandbox/worktree.js');
      const sweep = wt.sweepOrphanSandboxesDetailed({ staleMs: wt.ORPHAN_STALE_MS });
      const incomplete = sweep.residual.length + sweep.refused.length + sweep.unavailable.length +
        sweep.unexpectedErrors.length + sweep.inventory.malformedHomes + sweep.inventory.unsafeEntries;
      audit({
        action: 'daemon:start',
        repo: null,
        sandboxId: null,
        summary: `orphan sweep complete=${sweep.completed.length} incomplete=${incomplete}`,
        result: incomplete === 0 ? 'ok' : 'error',
      });
    } catch {
      // Best-effort: a sweep failure must never crash daemon start.
    }
  }

  try {
    if (opts.once) {
      // Single-tick mode — reload full config so a manual tick picks up disk changes.
      const liveCfg = reloadLiveConfigForDaemon(cfg);
      if (heartbeatDaemonLock(daemonLock)) {
        await tick(liveCfg, {
          dryRun: opts.dryRun,
          ...(opts.drain ? { drain: opts.drain } : {}),
          ...(opts.drainLimit ? { drainLimit: opts.drainLimit } : {}),
        });
      }
    } else {
      // M85/M116/M309: choose loop strategy from live config every iteration.
      // Batch mode sleeps between ticks; continuous mode loops immediately while
      // work is flowing and only sleeps on idle/no-op ticks.
      let cyclesLeft = opts.maxCycles ?? Infinity;
      while (true) {
        if (!heartbeatDaemonLock(daemonLock)) break;
        if (cyclesLeft-- <= 0) break;
        if (killSwitchOn()) break;

        const liveCfg = reloadLiveConfigForDaemon(cfg);

        const currentLoaded = loadDaemonStateStrict();
        if (!currentLoaded.ok) {
          audit({
            action: 'daemon:persistence-failed',
            repo: null,
            sandboxId: null,
            summary: `daemon loop stopped: daemon state ${currentLoaded.reason} (${currentLoaded.error})`,
            result: 'refused',
          });
          break;
        }
        const tickResult = await tick(liveCfg, {
          dryRun: opts.dryRun,
          ...(opts.drain ? { drain: opts.drain } : {}),
          ...(opts.drainLimit ? { drainLimit: opts.drainLimit } : {}),
        });

        // Dry-run is inherently a one-shot PLAN: it records spentUsd:0 forever,
        // so the budget break can never fire. Terminate after a single iteration
        // (matching --once semantics) so a dry-run loop is BOUNDED, not endless.
        if (opts.dryRun) break;

        if (killSwitchOn()) break;
        const afterTickLoaded = loadDaemonStateStrict();
        if (!afterTickLoaded.ok) {
          audit({
            action: 'daemon:persistence-failed',
            repo: null,
            sandboxId: null,
            summary: `daemon loop stopped after tick: daemon state ${afterTickLoaded.reason} (${afterTickLoaded.error})`,
            result: 'refused',
          });
          break;
        }

        // Re-read config before post-tick controls so budget caps, mode, idle
        // backoff, and batch interval changes can take effect without restart.
        const afterTickCfg = reloadLiveConfigForDaemon(liveCfg);
        const afterLoopCfg = resolveCfg(afterTickCfg);
        const afterTick = afterTickLoaded.state;
        if (budgetExhaustedForCurrentUtcDay(afterTick, afterLoopCfg)) {
          audit({
            action: 'daemon:tick',
            repo: null,
            sandboxId: null,
            summary: 'daily budget exhausted; daemon sleeping until the next UTC budget day',
            result: 'ok',
          });
          if (!(await sleepUntilNextUtcBudgetDay(daemonLock))) break;
          continue;
        }

        const noWorkDispatched =
          tickResult.itemsConsidered === 0 ||
          tickResult.reason === 'no-backlog' ||
          tickResult.reason === 'no-enrolled-repos';

        if (afterLoopCfg.mode === 'continuous') {
          if (noWorkDispatched) {
            await sleep(afterLoopCfg.idleBackoffMs ?? 5_000);
          }
        } else {
          await sleep(afterLoopCfg.intervalMs);
        }

        if (!heartbeatDaemonLock(daemonLock)) break;
        if (killSwitchOn()) break;
      }
    }
  } catch {
    // Unexpected error — swallow; still clean up running state below.
  }
  stopLockHeartbeat();

  // -------------------------------------------------------------------------
  // Clear running state on exit.
  // -------------------------------------------------------------------------
  const stillOwnsLock = heartbeatDaemonLock(daemonLock);
  const stopLoadedState = loadDaemonStateStrict();
  state = stopLoadedState.ok ? stopLoadedState.state : loadDaemonState();
  if (stillOwnsLock && stopLoadedState.ok && state.pid === process.pid) {
    state.running = false;
    state.pid = null;
    const stopSave = saveDaemonStateResult(state);
    if (!stopSave.ok) {
      audit({
        action: 'daemon:persistence-failed',
        repo: null,
        sandboxId: null,
        summary: `daemon stop could not persist stopped state (${stopSave.error})`,
        result: 'error',
      });
    }
  } else if (stillOwnsLock && !stopLoadedState.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `daemon stop skipped state update: daemon state ${stopLoadedState.reason} (${stopLoadedState.error})`,
      result: 'error',
    });
  }

  audit({
    action: 'daemon:stop',
    repo: null,
    sandboxId: null,
    summary: 'daemon stopped',
    result: 'ok',
  });

  // Restore ASHLR_IN_DAEMON to its prior value so a fresh runDaemon can run
  // again in the same process (a CLI process exits anyway; this matters for
  // programmatic reuse / tests). Child spawns already inherited it during the run.
  if (prevInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
  else process.env['ASHLR_IN_DAEMON'] = prevInDaemon;

  releaseDaemonLock(daemonLock);

  return loadDaemonState();
}

// ---------------------------------------------------------------------------
// stopDaemon — halt the operator
// ---------------------------------------------------------------------------

/**
 * Set the kill switch (M21 ~/.ashlr/KILL) AND mark running=false, pid=null in
 * persisted state. Idempotent; never throws. A running loop sees the kill
 * switch on the next iteration and stops cleanly.
 */
export function stopDaemon(): void {
  try {
    setKill(true);
  } catch {
    // setKill is idempotent + never throws by contract; extra guard
  }
  try {
    const state = loadDaemonState();
    state.running = false;
    state.pid = null;
    saveDaemonState(state);
  } catch {
    // Persistence failure — swallow; kill switch was already set above
  }
  try {
    audit({
      action: 'daemon:stop',
      repo: null,
      sandboxId: null,
      summary: 'stopDaemon() called: kill switch set + running=false',
      result: 'ok',
    });
  } catch {
    // Audit best-effort
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Promise-based sleep (bounded; never less than 0ms). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function currentUtcBudgetDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcBudgetDayStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function msUntilUtcTimestamp(targetMs: number, nowMs = Date.now()): number {
  return Math.max(0, targetMs - nowMs);
}

function budgetExhaustedForCurrentUtcDay(state: DaemonState, dcfg: DaemonConfig): boolean {
  return state.todayDate === currentUtcBudgetDay() && state.todaySpentUsd >= dcfg.dailyBudgetUsd;
}

async function sleepUntilNextUtcBudgetDay(lock: DaemonLock): Promise<boolean> {
  const maxChunkMs = 60_000;
  const wakeAtMs = nextUtcBudgetDayStartMs();
  while (true) {
    if (killSwitchOn()) return false;
    const remainingMs = msUntilUtcTimestamp(wakeAtMs);
    if (remainingMs <= 0) return true;
    await sleep(Math.min(maxChunkMs, remainingMs + 1));
    if (!heartbeatDaemonLock(lock)) return false;
  }
}

/**
 * Build a focused, actionable engine prompt from a WorkItem.
 *
 * Framing goals:
 *  - Lead with the concrete objective so the engine can orient immediately.
 *  - Add scoped context (repo path, source/tags) so it doesn't guess location.
 *  - Append a clean no-op escape hatch so frontier models produce a focused diff
 *    OR cleanly stop — not a forced/garbage edit.
 *
 * Pure: never throws, never mutates item.
 */
export function buildItemGoal(item: WorkItem): string {
  const parts: string[] = [];

  // Objective — always present.
  parts.push(item.title.trim());

  // Detail / context — include when non-empty and not a duplicate of title.
  const detail = (item.detail ?? '').trim();
  if (detail && detail !== item.title.trim()) {
    parts.push(detail);
  }

  // Repo + source anchoring so the engine knows exactly where to look.
  const anchor: string[] = [];
  if (item.repo) anchor.push(`Repo: ${item.repo}`);
  if (item.source) anchor.push(`Source: ${item.source}`);
  if (item.tags && item.tags.length > 0) anchor.push(`Tags: ${item.tags.join(', ')}`);
  if (anchor.length > 0) parts.push(anchor.join(' | '));


  // Behavioral guidance — focused diff OR clean no-op. Keep it tight; the
  // executor role and TITRR already provide broader context.
  parts.push(
    'Make the smallest focused change that fully addresses this. ' +
    'Match existing conventions. Run/keep tests green. ' +
    'If on inspection this is NOT actionable as a code change ' +
    '(e.g. a platform-gated or intentionally-skipped test, an issue requiring ' +
    'product decisions, or already done), make NO changes and stop — ' +
    'do not force an edit.',
  );

  return parts.join('\n\n');
}
