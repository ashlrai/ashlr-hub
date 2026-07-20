/**
 * loop.ts — The M24 daemon operator.
 *
 * Exports:
 *  - tick(cfg, opts): one operator cycle — check guards, load backlog, dispatch
 *    sandboxed swarms, create PENDING inbox proposals, record spend + state.
 *  - runDaemon(cfg, opts): loop ticks on an interval (or once); REFUSES when
 *    nested; marks running state; stops on kill switch; idles on budget exhaustion.
 *  - stopDaemon(): request shutdown by setting the kill switch.
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

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_CAPTURE_REPAIR_DRAIN_LIMIT,
  DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT,
} from '../types.js';
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
import {
  killSwitchOn,
  setKill,
  canonicalEnrollmentPath,
  recoverEnrollmentRegistry,
} from '../sandbox/policy.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../sandbox/mutation-fence.js';
import { audit as persistAudit } from '../sandbox/audit.js';
import { buildBacklog, loadBacklog } from '../portfolio/backlog.js';
import { loadQueuedAutonomyItems } from '../portfolio/queued-autonomy.js';
import {
  acquireDaemonLock,
  armDaemonSpendGuard,
  clearDaemonSpendGuard,
  daemonStatePath,
  loadDaemonState,
  loadDaemonStateStrict,
  readDaemonLockOwner,
  readDaemonSpendGuard,
  releaseDaemonLock,
  resetDayIfNeeded,
  saveDaemonStateResult,
} from './state.js';
import type { DaemonLock, SaveDaemonStateResult } from './state.js';
import {
  acquireLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import {
  readDaemonActivity,
  writeDaemonActivity,
  type DaemonActivityPhase,
} from './activity.js';
import { nullSink } from '../run/streaming.js';
import { createOuterAttemptIdentity } from '../fleet/attempt-identity.js';
import { runSwarm } from '../swarm/runner.js';
import { runGoal } from '../run/orchestrator.js';
import { scopeFromWorkItem } from '../run/delegation-scope.js';
import {
  generatedRepairCandidateAllowed,
  generatedRepairExecutionBackendAllowed,
  inspectGeneratedRepairRouteFeasibility,
  routeBackend,
  type GeneratedRepairRouteFeasibility,
  type GeneratedRepairRouteReason,
} from '../fleet/router.js';
import { withinLimit, recordUse } from '../fleet/quota.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import { resolveEngineSpec } from '../run/engine-registry.js';
import { subscriptionAllows, isSubscriptionEngine } from '../fleet/subscription-usage.js'; // M80
import { recommendRoute, recoverWithinBudget } from '../run/learned-router.js';
import { decide as gatewayDecide } from '../fabric/gateway.js'; // M247: InferenceGateway
import {
  buildConcurrentDispatchRouteItem,
  concurrentAssignedRouteReason,
  finalizeConcurrentDispatchRoute,
  planConcurrentDispatch,
  runConcurrentDispatch,
} from '../fabric/concurrent-dispatch.js'; // M255/M256
import { getResourceSnapshot } from '../fabric/resource-monitor.js'; // M255
import { estimateRun } from '../observability/estimate.js';
import { buildForecast } from '../observability/forecast.js';
import { emitTuningProposals } from '../learn/tuning.js';
import { runAutoMergePass, type AutoMergePassResult } from '../fleet/automerge-pass.js';
import {
  beginRejectedCaptureRecoveryDispatch,
  generatedRepairRootKey,
  generatedRepairProposalDispatchAuthority,
  isRejectedCaptureRecoveryAuthorized,
  queueProposalRepairWorkForPendingProposals,
  resolveDiagnosticResliceParents,
  type ProposalRepairWorkResult,
} from '../fleet/proposal-repair-work.js';
import { reconcileRemoteHandoffs, type RemoteHandoffReconcileResult } from '../inbox/remote-handoff.js';
import { runBestOfN } from '../run/best-of-n.js';
import { runSelfHealCycle, runSelfHealCycleForRepos } from '../fleet/self-heal.js';
import { runInventCycle } from '../generative/invent-cycle.js'; // M186
import { runCounterfactualReplay } from '../fleet/counterfactual.js'; // M187
import { detectRegression, bisectAndRevert } from '../fleet/regression-sentinel.js'; // M189
import { observePostMergeStability } from '../fleet/post-merge-stability-observer.js';
import {
  buildMonitoringCursor,
  loadMonitoringCursor,
  monitoringRepoDigest,
  saveMonitoringCursor,
  selectRegressionRepoSuccessors,
} from '../fleet/monitoring-cursor.js';
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
import { pendingCount, listProposals, listProposalsDetailed } from '../inbox/store.js';
import { authenticatedRealizedMergeOf, realizedMergeOf } from '../inbox/realized-merge.js';
import {
  dispatchProductionDir,
  readDispatchProductionFailureAttemptReceipts,
  readDispatchProductionEventsDetailed,
  readDispatchProductionAttemptProtocolQuality,
  recordDispatchProduction,
  readDispatchProductionYieldDetailed,
  resolveDispatchProductionFailureAttemptReceipt,
  resolveDispatchProductionAttemptReceiptWitnesses,
  type DispatchProductionBasis,
  type DispatchProductionEvent,
} from '../fleet/dispatch-production-ledger.js';
import { buildDispatchManifestEvent, recordDispatchManifest } from '../fleet/dispatch-manifest.js';
import {
  readRepairHandoffSchemaSummary,
  captureGateDispatchState,
  captureGateDispatchStates,
  recordRepairHandoffs,
  repairHandoffFromDispatchEvent,
  validRepairHandoffV2Activation,
} from '../fleet/repair-handoff-journal.js';
import { workItemObjectiveHash } from '../fleet/work-item-objective.js';
import {
  readAgentActions,
  recordAgentAction,
  recordAgentActionResult,
  type AgentActionEvent,
  type AgentActionOutcome,
} from '../fleet/agent-action-ledger.js';
import {
  decideContextRollup,
  type ContextRollupDecision,
} from '../fleet/context-rollup.js';
import {
  causalMetadata,
  evidenceOutcomeSummary,
  ROUTER_POLICY_VERSION,
  routeSnapshot,
  runEventSummary,
} from '../learning/causal.js';
import { productionAttemptLearningLabelFromSignals } from '../learning/attempt-shape.js';
import { readSkillCards } from '../fleet/skill-records.js';
import { observeShadowSkills } from '../fleet/skill-shadow-observer.js';
// worked-ledger is used transitively via LocalWorkQueueCoordinator (selectWorkQueueCoordinator).
import { selectWorkQueueCoordinator } from '../seams/work-queue-coordinator.js';
import type { QueueClaimCooldownPolicy } from '../fleet/shared-store.js';
// M220: verdict-feedback sweep — feed judge rejections back to the ledger so
// re-clogging items (e.g. "CI is failing") are suppressed for the cooldown window.
import {
  GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS,
  latestWorkedEventForKeys,
  recordOutcome as recordWorkedOutcome,
  sweepJudgedProposals,
  type WorkedEvent,
  type WorkedOutcome,
  workedEventIsCooling,
} from '../fleet/worked-ledger.js';
import {
  blockingPendingProposalsForBacklog,
  pendingProposalForWorkItem,
  pendingProposalItemKeysForBacklog,
  workItemCoverageKey,
  workItemExecutionKey,
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
  isTrustedCaptureRepairItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from '../fleet/self-heal-trust.js';
import {
  generatedRepairDispatchState,
  generatedRepairDispatchLineage,
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
  generatedRepairCooldownKey,
  generatedRepairCooldownKeys,
  generatedRepairRetryPolicy,
  readGeneratedRepairLifecycle,
  readGeneratedRepairQueueSnapshot,
  publishGeneratedRepairTreatmentOutcome,
  readPendingGeneratedRepairTreatmentOutcomes,
  recordGeneratedRepairLifecycle,
} from '../fleet/generated-repair-lifecycle.js';
import { generatedRepairLifecycleAttemptHash } from '../fleet/generated-repair-identity.js';
import {
  scheduleResolutionObserverChild,
  type ScheduledResolutionObserverChild,
} from './resolution-observer-scheduler.js';
import {
  CUTOFF_CAPTURE_DEADLINE_MS,
  scheduleCutoffCheckpointCapture,
  type ScheduledCutoffCapture,
} from './cutoff-checkpoint-scheduler.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { fsyncDirectory } from '../util/durability.js';

const GENERATED_REPAIR_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
const GENERATED_REPAIR_RESERVATION_SCHEMA_VERSION = 1;
const GENERATED_REPAIR_RESERVATION_MAX_BYTES = 2_048;
const GENERATED_REPAIR_RESERVATION_MAX_GENERATIONS = 8;
const GENERATED_REPAIR_ATTEMPT_READ_MAX_FILES = 3;
const GENERATED_REPAIR_ATTEMPT_READ_MAX_BYTES = 2 * 1024 * 1024;
const GENERATED_REPAIR_ATTEMPT_READ_MAX_ROWS = 4_096;
const GENERATED_REPAIR_ATTEMPT_READ_LIMIT = 256;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GENERATED_REPAIR_FAILED_OUTCOMES = new Set<DaemonDispatchProductionOutcome>([
  'engine-failed',
  'sandbox-failed',
  'proposal-capture-error',
  'gate-blocked',
]);

interface GeneratedRepairExecutionReservationRecord {
  schemaVersion: 1;
  reservationId: string;
  createdAt: string;
  generationIds: string[];
  itemIdHash: string;
  objectiveHash: string;
  repairRootId: string;
  repairDepth: 0 | 1;
  repairRootAuthorityItemIdHash: string;
  backend: EngineId;
  tier: EngineTier;
  repairAttemptOrdinal: 1 | 2;
  previousBackend: EngineId | null;
  attemptHash: string;
  phase: 'prepared' | 'launched';
}

interface GeneratedRepairExecutionReservation {
  markerPath: string;
  record: GeneratedRepairExecutionReservationRecord;
  locks: LocalStoreLock[];
}

interface GeneratedRepairAttemptHistory {
  available: boolean;
  failures: DispatchProductionEvent[];
}

function generatedRepairReceiptFreshAuthority(item: WorkItem): boolean {
  const generationIds = generatedRepairReservationFamily(item);
  if (!generationIds) return false;
  const failures = readDispatchProductionFailureAttemptReceipts(generationIds);
  if (failures.status !== 'resolved' || !failures.authoritative || failures.receipts.length > 0) {
    return false;
  }
  const terminals = resolveDispatchProductionAttemptReceiptWitnesses(
    generationIds.flatMap((repairGenerationId) => ([1, 2] as const).map(
      (repairAttemptOrdinal) => ({ repairGenerationId, repairAttemptOrdinal }),
    )),
  );
  return terminals.status === 'resolved' && terminals.resolutions.every(
    (resolution) => resolution.status === 'missing',
  );
}

function canonicalGeneratedRepairAttemptEvent(item: WorkItem, event: DispatchProductionEvent): boolean {
  if (
    event.itemId !== item.id ||
    event.source !== item.source ||
    event.objectiveHash !== workItemObjectiveHash(item) ||
    event.basis !== 'run-proposal-outcome' ||
    event.backend === null ||
    event.backend === 'builtin' ||
    event.tier === null
  ) return false;
  try {
    return resolve(event.repo) === resolve(item.repo);
  } catch {
    return false;
  }
}

function readGeneratedRepairAttemptEvents(
  item: WorkItem,
  sinceMs: number,
): { available: boolean; events: DispatchProductionEvent[] } {
  try {
    const read = readDispatchProductionEventsDetailed({
      sinceMs: Math.max(0, sinceMs),
      limit: GENERATED_REPAIR_ATTEMPT_READ_LIMIT,
      maxFiles: GENERATED_REPAIR_ATTEMPT_READ_MAX_FILES,
      maxBytes: GENERATED_REPAIR_ATTEMPT_READ_MAX_BYTES,
      maxRows: GENERATED_REPAIR_ATTEMPT_READ_MAX_ROWS,
    });
    if (!read.complete || read.sourceState === 'degraded') return { available: false, events: [] };
    return {
      available: true,
      events: read.events.filter((event) => canonicalGeneratedRepairAttemptEvent(item, event)),
    };
  } catch {
    return { available: false, events: [] };
  }
}

function readGeneratedRepairFailedAttempts(item: WorkItem): GeneratedRepairAttemptHistory {
  const generationIds = generatedRepairReservationFamily(item);
  if (!generationIds) return { available: false, failures: [] };
  const durable = readDispatchProductionFailureAttemptReceipts(generationIds);
  if (durable.status !== 'resolved') return { available: false, failures: [] };
  const itemMs = Date.parse(item.ts);
  const sinceMs = Number.isFinite(itemMs)
    ? Math.max(itemMs, Date.now() - GENERATED_REPAIR_RECOVERY_WINDOW_MS)
    : Date.now() - GENERATED_REPAIR_RECOVERY_WINDOW_MS;
  const read = readGeneratedRepairAttemptEvents(item, sinceMs);
  if (!read.available && !durable.authoritative) return { available: false, failures: [] };
  const byAttempt = new Map<string, DispatchProductionEvent>();
  for (const event of [...(read.available ? read.events : []), ...durable.receipts.map((receipt) => receipt.event)]) {
    if (!GENERATED_REPAIR_FAILED_OUTCOMES.has(event.outcome) || event.proposalCreated) continue;
    if (!canonicalGeneratedRepairAttemptEvent(item, event)) continue;
    const attemptId = event.trajectoryId ?? (event.runId ? `run:${event.runId}` : undefined);
    if (!attemptId) continue;
    const current = byAttempt.get(attemptId);
    if (!current || Date.parse(event.ts) > Date.parse(current.ts)) byAttempt.set(attemptId, event);
  }
  return {
    available: true,
    failures: [...byAttempt.values()]
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
      .slice(-2),
  };
}

function effectiveGeneratedRepairRetryPolicy(item: WorkItem): ReturnType<typeof generatedRepairRetryPolicy> {
  const lifecyclePolicy = generatedRepairRetryPolicy(item);
  if (!lifecyclePolicy.applies) return lifecyclePolicy;
  if (!lifecyclePolicy.available) return generatedRepairReceiptFreshAuthority(item)
    ? {
        applies: true,
        available: true,
        requireAlternative: false,
        excludedBackend: null,
        requiredTier: item.repairParentTier ?? null,
      }
    : lifecyclePolicy;
  const history = readGeneratedRepairFailedAttempts(item);
  if (!history.available) return { ...lifecyclePolicy, available: false };
  const lifecycle = readGeneratedRepairLifecycle(item);
  if (!lifecycle.available) return { ...lifecyclePolicy, available: false };
  const attempts = lifecycle.authoritativeEmptyRuns + history.failures.length;
  if (attempts >= 2) {
    return {
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: null,
    };
  }
  if (lifecyclePolicy.requireAlternative || history.failures.length === 0) return lifecyclePolicy;
  const failed = history.failures.at(-1)!;
  return {
    applies: true,
    available: failed.backend !== null && failed.tier !== null,
    requireAlternative: true,
    excludedBackend: failed.backend,
    requiredTier: failed.tier,
  };
}

function effectiveGeneratedRepairExecutionBackendAllowed(
  item: WorkItem,
  backend: EngineId,
  cfg: AshlrConfig,
): boolean {
  if (!generatedRepairExecutionBackendAllowed(item, backend, cfg)) return false;
  const policy = effectiveGeneratedRepairRetryPolicy(item);
  if (!policy.applies) return true;
  if (!policy.available || backend === 'builtin') return false;
  if (policy.requireAlternative && backend === policy.excludedBackend) return false;
  return policy.requiredTier === null || engineTierOf(backend, cfg) === policy.requiredTier;
}

function effectiveGeneratedRepairCandidateAllowed(
  item: WorkItem,
  backend: EngineId,
  cfg: AshlrConfig,
): boolean {
  return generatedRepairCandidateAllowed(item, backend, cfg) &&
    effectiveGeneratedRepairExecutionBackendAllowed(item, backend, cfg);
}

function generatedRepairAlternateBackend(
  item: WorkItem,
  excluded: EngineId,
  cfg: AshlrConfig,
): EngineId | null {
  const configured = cfg.foundry?.allowedBackends ?? [];
  for (const candidate of configured) {
    if (candidate === excluded || candidate === 'builtin') continue;
    if (!effectiveGeneratedRepairExecutionBackendAllowed(item, candidate, cfg)) continue;
    if (!withinLimit(candidate, cfg)) continue;
    return candidate;
  }
  return null;
}

function exactFailedAttemptReceiptMatchesReservation(
  item: WorkItem,
  event: DispatchProductionEvent,
  record: GeneratedRepairExecutionReservationRecord,
): boolean {
  if (
    !event.repairGenerationId ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
    !record.generationIds.includes(event.repairGenerationId)
  ) return false;
  const resolution = resolveDispatchProductionFailureAttemptReceipt({
    repairGenerationId: event.repairGenerationId,
    repairAttemptOrdinal: event.repairAttemptOrdinal,
    attemptHash: record.attemptHash,
  });
  if (resolution.status !== 'proven') return false;
  try {
    return resolution.proof.repairGenerationId === event.repairGenerationId &&
      resolution.proof.repairAttemptOrdinal === record.repairAttemptOrdinal &&
      resolution.proof.attemptHash === record.attemptHash &&
      resolution.proof.backend === record.backend &&
      resolution.proof.tier === record.tier &&
      resolution.proof.previousBackend === record.previousBackend &&
      resolution.event.itemId === item.id &&
      resolution.event.trajectoryId === `run:${record.reservationId}` &&
      resolution.event.objectiveHash === record.objectiveHash &&
      resolution.event.outcome === event.outcome &&
      resolution.event.proposalCreated === false &&
      resolution.event.repairRootId === record.repairRootId &&
      resolution.event.repairDepth === record.repairDepth &&
      resolve(resolution.event.repo) === resolve(item.repo);
  } catch {
    return false;
  }
}

function generatedRepairReservationDir(): string {
  return join(dirname(dispatchProductionDir()), 'repair-attempt-reservations');
}

function generatedRepairReservationFamily(item: WorkItem): string[] | null {
  const generationIds = [...new Set(generatedRepairGenerationIds(item))].sort();
  return generationIds.length > 0 &&
    generationIds.length <= GENERATED_REPAIR_RESERVATION_MAX_GENERATIONS &&
    generationIds.every((generationId) => SHA256_RE.test(generationId))
    ? generationIds
    : null;
}

function generatedRepairReservationRootId(item: WorkItem): string | null {
  return generatedRepairRootKey(item) !== null && SHA256_RE.test(item.repairRootId ?? '')
    ? item.repairRootId!
    : null;
}

function generatedRepairReservationPath(item: WorkItem): string | null {
  const rootId = generatedRepairReservationRootId(item);
  return rootId ? join(generatedRepairReservationDir(), `${rootId}.json`) : null;
}

function generatedRepairReservationItemIdHash(itemId: string): string {
  return createHash('sha256').update(JSON.stringify(['ashlr:repair-item:v1', itemId])).digest('hex');
}

function generatedRepairRootAuthorityId(item: WorkItem): string | null {
  return typeof item.repairRootAuthorityId === 'string' && item.repairRootAuthorityId
    ? item.repairRootAuthorityId
    : null;
}

function reservationPathState(path: string): 'missing' | 'present' | 'unavailable' {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable';
  }
}

function validGeneratedRepairReservationRecord(
  value: unknown,
  expectedGenerationIds?: readonly string[],
): value is GeneratedRepairExecutionReservationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  const expectedKeys = [
    'attemptHash', 'backend', 'createdAt', 'generationIds', 'itemIdHash', 'objectiveHash',
    'phase', 'previousBackend', 'repairAttemptOrdinal', 'repairDepth', 'repairRootAuthorityItemIdHash',
    'repairRootId', 'reservationId', 'schemaVersion', 'tier',
  ].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return false;
  const createdAtMs = typeof row['createdAt'] === 'string' ? Date.parse(row['createdAt']) : Number.NaN;
  const generations = row['generationIds'];
  return row['schemaVersion'] === GENERATED_REPAIR_RESERVATION_SCHEMA_VERSION &&
    typeof row['reservationId'] === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(row['reservationId']) &&
    Number.isFinite(createdAtMs) && new Date(createdAtMs).toISOString() === row['createdAt'] &&
    Array.isArray(generations) &&
    generations.length > 0 &&
    generations.length <= GENERATED_REPAIR_RESERVATION_MAX_GENERATIONS &&
    generations.every((generationId) => typeof generationId === 'string' && SHA256_RE.test(generationId)) &&
    new Set(generations).size === generations.length &&
    generations.every((generationId, index) => index === 0 || generations[index - 1]! < generationId) &&
    (expectedGenerationIds === undefined || (
      generations.length === expectedGenerationIds.length &&
      generations.every((generationId, index) => generationId === expectedGenerationIds[index])
    )) &&
    typeof row['itemIdHash'] === 'string' && SHA256_RE.test(row['itemIdHash']) &&
    typeof row['objectiveHash'] === 'string' && SHA256_RE.test(row['objectiveHash']) &&
    typeof row['repairRootId'] === 'string' && SHA256_RE.test(row['repairRootId']) &&
    (row['repairDepth'] === 0 || row['repairDepth'] === 1) &&
    typeof row['repairRootAuthorityItemIdHash'] === 'string' && SHA256_RE.test(row['repairRootAuthorityItemIdHash']) &&
    typeof row['backend'] === 'string' && row['backend'].length <= 64 &&
    typeof row['tier'] === 'string' && ['local', 'mid', 'frontier'].includes(row['tier']) &&
    (row['repairAttemptOrdinal'] === 1 || row['repairAttemptOrdinal'] === 2) &&
    (row['repairAttemptOrdinal'] === 1
      ? row['previousBackend'] === null
      : typeof row['previousBackend'] === 'string' && row['previousBackend'].length <= 64 &&
        row['previousBackend'] !== 'builtin' && row['previousBackend'] !== row['backend']) &&
    typeof row['attemptHash'] === 'string' && SHA256_RE.test(row['attemptHash']) &&
    (row['phase'] === 'prepared' || row['phase'] === 'launched');
}

function readGeneratedRepairReservationRecord(
  markerPath: string,
  generationIds?: readonly string[],
): GeneratedRepairExecutionReservationRecord | null {
  const read = readStableRegularFile(markerPath, {
    anchorPath: dirname(generatedRepairReservationDir()),
    maxFileBytes: GENERATED_REPAIR_RESERVATION_MAX_BYTES,
    remainingBytes: GENERATED_REPAIR_RESERVATION_MAX_BYTES,
  });
  if (!read.ok || read.bytesRead < 2) return null;
  try {
    const parsed: unknown = JSON.parse(read.text);
    return validGeneratedRepairReservationRecord(parsed, generationIds) ? parsed : null;
  } catch {
    return null;
  }
}

function writeGeneratedRepairReservationRecord(
  markerPath: string,
  record: GeneratedRepairExecutionReservationRecord,
): boolean {
  try {
    const bytes = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(bytes, 'utf8') > GENERATED_REPAIR_RESERVATION_MAX_BYTES) return false;
    writePrivateFileAtomically(
      `${markerPath}.${process.pid}.${randomUUID()}.tmp`,
      markerPath,
      bytes,
      { anchorPath: dirname(generatedRepairReservationDir()), label: 'generated repair execution reservation' },
    );
    const durable = readGeneratedRepairReservationRecord(markerPath, record.generationIds);
    return durable !== null && JSON.stringify(durable) === JSON.stringify(record);
  } catch {
    return false;
  }
}

function acquireGeneratedRepairReservationLocks(rootId: string): LocalStoreLock[] | null {
  if (!SHA256_RE.test(rootId)) return null;
  const lock = acquireLocalStoreLock(join(generatedRepairReservationDir(), `${rootId}.lock`), 0);
  return lock ? [lock] : null;
}

function releaseGeneratedRepairReservationLocks(locks: readonly LocalStoreLock[]): void {
  for (const lock of [...locks].reverse()) releaseLocalStoreLock(lock);
}

function clearGeneratedRepairReservationMarker(
  markerPath: string,
  expected: GeneratedRepairExecutionReservationRecord,
): boolean {
  try {
    const current = readGeneratedRepairReservationRecord(markerPath, expected.generationIds);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) return false;
    const stat = lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    unlinkSync(markerPath);
    fsyncDirectory(dirname(markerPath));
    return true;
  } catch {
    return false;
  }
}

function reconcilePreparedGeneratedRepairReservations(): void {
  let names: string[];
  try {
    names = readdirSync(generatedRepairReservationDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[ashlr] daemon: generated repair reservation startup reconciliation unavailable');
    }
    return;
  }
  for (const name of names) {
    const matched = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!matched) continue;
    const rootId = matched[1]!;
    const markerPath = join(generatedRepairReservationDir(), name);
    const locks = acquireGeneratedRepairReservationLocks(rootId);
    if (!locks) continue;
    try {
      const current = readGeneratedRepairReservationRecord(markerPath);
      if (current?.phase === 'prepared' && current.repairRootId === rootId) {
        clearGeneratedRepairReservationMarker(markerPath, current);
      }
    } finally {
      releaseGeneratedRepairReservationLocks(locks);
    }
  }
}

type GeneratedRepairReservationReconciliation =
  | 'missing'
  | 'cleared'
  | 'failure-cleared'
  | 'blocked';

function reconcileGeneratedRepairReservationForItem(
  item: WorkItem,
): GeneratedRepairReservationReconciliation {
  const markerPath = generatedRepairReservationPath(item);
  const rootId = generatedRepairReservationRootId(item);
  if (!markerPath || !rootId) return 'missing';
  const markerState = reservationPathState(markerPath);
  if (markerState === 'missing') return 'missing';
  if (markerState === 'unavailable') return 'blocked';
  const locks = acquireGeneratedRepairReservationLocks(rootId);
  if (!locks) return 'blocked';
  try {
    const record = readGeneratedRepairReservationRecord(markerPath);
    const rootAuthorityItemId = generatedRepairRootAuthorityId(item);
    if (!record ||
      record.repairRootId !== rootId ||
      record.itemIdHash !== generatedRepairReservationItemIdHash(item.id) ||
      record.objectiveHash !== workItemObjectiveHash(item) ||
      generatedRepairRootKey(item) === null ||
      !rootAuthorityItemId ||
      record.repairDepth !== item.repairDepth ||
      record.repairRootAuthorityItemIdHash !== generatedRepairReservationItemIdHash(rootAuthorityItemId)) return 'blocked';
    if (record.phase === 'prepared') {
      return clearGeneratedRepairReservationMarker(markerPath, record) ? 'cleared' : 'blocked';
    }

    const failureReceipts = record.generationIds.map((repairGenerationId) =>
      resolveDispatchProductionFailureAttemptReceipt({
        repairGenerationId,
        repairAttemptOrdinal: record.repairAttemptOrdinal,
        attemptHash: record.attemptHash,
      }));
    if (failureReceipts.some((resolution) =>
      resolution.status === 'degraded' || resolution.status === 'unproven')) return 'blocked';
    const exactFailures = failureReceipts.flatMap((resolution) => {
      if (resolution.status !== 'proven') return [];
      return resolution.proof.attemptHash === record.attemptHash &&
        resolution.proof.backend === record.backend &&
        resolution.proof.tier === record.tier &&
        resolution.proof.previousBackend === record.previousBackend &&
        resolution.proof.repairAttemptOrdinal === record.repairAttemptOrdinal &&
        record.generationIds.includes(resolution.proof.repairGenerationId) &&
        resolution.event.itemId === item.id &&
        resolve(resolution.event.repo) === resolve(item.repo) &&
        resolution.event.source === item.source &&
        resolution.event.objectiveHash === record.objectiveHash &&
        resolution.event.trajectoryId === `run:${record.reservationId}` &&
        resolution.event.repairRootId === record.repairRootId &&
        resolution.event.repairDepth === record.repairDepth &&
        GENERATED_REPAIR_FAILED_OUTCOMES.has(resolution.event.outcome) &&
        resolution.event.proposalCreated === false
        ? [resolution]
        : [];
    });
    if (failureReceipts.some((resolution) =>
      resolution.status === 'proven' && !exactFailures.includes(resolution))) return 'blocked';
    if (exactFailures.length > 0) {
      if (!recordWorkedOutcome(generatedRepairCooldownKey(item), 'dispatch-blocked')) return 'blocked';
      return clearGeneratedRepairReservationMarker(markerPath, record) ? 'failure-cleared' : 'blocked';
    }

    const receipts = resolveDispatchProductionAttemptReceiptWitnesses(
      record.generationIds.map((repairGenerationId) => ({
        repairGenerationId,
        repairAttemptOrdinal: record.repairAttemptOrdinal,
      })),
    );
    if (receipts.status !== 'resolved') return 'blocked';
    const exact = receipts.resolutions.flatMap((resolution) => {
      if (resolution.status !== 'proven') return [];
      const exactRootBinding = resolution.event.repairRootId === record.repairRootId &&
        resolution.event.repairDepth === record.repairDepth;
      const exactDiagnosticBinding = isTrustedDiagnosticResliceItem(item) &&
        resolution.event.repairRootId === undefined &&
        resolution.event.repairDepth === undefined &&
        resolution.event.repairTreatmentUnitId === item.repairTreatmentUnitId &&
        resolution.event.repairTreatment === item.repairTreatment;
      return resolution.proof.attemptHash === record.attemptHash &&
        resolution.proof.backend === record.backend &&
        resolution.proof.tier === record.tier &&
        resolution.proof.previousBackend === record.previousBackend &&
        resolution.proof.repairAttemptOrdinal === record.repairAttemptOrdinal &&
        record.generationIds.includes(resolution.proof.repairGenerationId) &&
        resolution.event.itemId === item.id &&
        resolve(resolution.event.repo) === resolve(item.repo) &&
        resolution.event.source === item.source &&
        resolution.event.objectiveHash === record.objectiveHash &&
        resolution.event.trajectoryId === `run:${record.reservationId}` &&
        (exactRootBinding || exactDiagnosticBinding)
        ? [resolution]
        : [];
    });
    if (receipts.resolutions.some((resolution) =>
      resolution.status === 'proven' && !exact.includes(resolution))) return 'blocked';
    const exactOutcomeKeys = new Set(exact.map((resolution) => JSON.stringify([
      resolution.event.ts,
      resolution.event.outcome,
      resolution.event.proposalId ?? null,
      resolution.event.proposalCreated,
      resolution.event.runId ?? null,
      resolution.event.trajectoryId ?? null,
      resolution.event.backend,
      resolution.event.tier,
      resolution.event.objectiveHash ?? null,
      resolution.event.repairRootId ?? null,
      resolution.event.repairDepth ?? null,
    ])));
    if (exactOutcomeKeys.size > 1) return 'blocked';
    if (exact.length > 0) {
      const event = exact[0]!.event;
      if (GENERATED_REPAIR_FAILED_OUTCOMES.has(event.outcome)) {
        if (!recordWorkedOutcome(generatedRepairCooldownKey(item), 'dispatch-blocked')) return 'blocked';
        return clearGeneratedRepairReservationMarker(markerPath, record) ? 'failure-cleared' : 'blocked';
      }
      if (event.outcome === 'empty-diff') {
        const diagnostic = isTrustedDiagnosticResliceItem(item);
        const treatmentCandidate = diagnostic && event.repairTreatmentUnitId && event.repairTreatment
          ? {
              ...event,
              basis: 'repair-lifecycle-candidate' as const,
              repairTreatmentAttemptHash: record.attemptHash,
            } satisfies DispatchProductionEvent
          : undefined;
        const transition = diagnostic
          ? recordGeneratedRepairLifecycle(item, {
              kind: 'dispatch-proof-empty-diff',
              eventTs: event.ts,
              ...(treatmentCandidate ? { treatmentCandidate } : {}),
            })
          : recordGeneratedRepairLifecycle(item, {
              kind: 'empty-diff',
              attemptId: event.trajectoryId!,
              backend: record.backend,
              tier: record.tier,
              ts: event.ts,
            });
        if (!transition.available || transition.authoritativeEmptyRuns < record.repairAttemptOrdinal) {
          return 'blocked';
        }
        if (!recordWorkedOutcome(generatedRepairCooldownKey(item), 'empty')) return 'blocked';
        return clearGeneratedRepairReservationMarker(markerPath, record) ? 'cleared' : 'blocked';
      }
      if (event.outcome === 'proposal-created' && event.proposalId) {
        const proposalRead = listProposalsDetailed({ requireComplete: true });
        const proposal = proposalRead.complete && proposalRead.sourceState !== 'degraded'
          ? proposalRead.proposals.find((candidate) =>
              candidate.id === event.proposalId &&
              candidate.workItemId === item.id &&
              candidate.workItemGenerationId !== undefined &&
              record.generationIds.includes(candidate.workItemGenerationId) &&
              candidate.runId === event.runId &&
              candidate.trajectoryId === `run:${record.reservationId}`)
          : undefined;
        if (!proposal) return 'blocked';
        const transition = recordGeneratedRepairLifecycle(item, {
          kind: 'proposal-created',
          attemptId: event.trajectoryId!,
          proposalId: proposal.id,
          ts: event.ts,
        });
        if (!transition.available || transition.disposition !== 'retired') return 'blocked';
        return clearGeneratedRepairReservationMarker(markerPath, record) ? 'cleared' : 'blocked';
      }
    }

    if (exact.length === 0 || receipts.resolutions.some((resolution) =>
      resolution.status === 'proven' && !exact.includes(resolution))) return 'blocked';

    const lifecycle = readGeneratedRepairLifecycle(item);
    if (!lifecycle.available) return 'blocked';
    const completed = exact.every((resolution) =>
      resolution.event.outcome === 'empty-diff'
        ? lifecycle.authoritativeEmptyRuns >= record.repairAttemptOrdinal
        : resolution.event.outcome === 'proposal-created' && lifecycle.disposition === 'retired');
    if (!completed) return 'blocked';
    if (
      exact.some((resolution) => resolution.event.outcome === 'empty-diff') &&
      !recordWorkedOutcome(generatedRepairCooldownKey(item), 'empty')
    ) return 'blocked';
    return clearGeneratedRepairReservationMarker(markerPath, record) ? 'cleared' : 'blocked';
  } catch {
    return 'blocked';
  } finally {
    releaseGeneratedRepairReservationLocks(locks);
  }
}

function acquireGeneratedRepairExecutionReservation(
  item: WorkItem,
  attemptId: string,
  backend: EngineId,
  tier: EngineTier | null,
  repairAttemptOrdinal: 1 | 2,
  previousBackend: EngineId | null,
): GeneratedRepairExecutionReservation | null {
  const generationIds = generatedRepairReservationFamily(item);
  const objectiveHash = workItemObjectiveHash(item);
  const rootAuthorityItemId = generatedRepairRootAuthorityId(item);
  const rootId = generatedRepairReservationRootId(item);
  if (!generationIds || !objectiveHash || !SHA256_RE.test(objectiveHash) || tier === null ||
    !rootId || !rootAuthorityItemId || (repairAttemptOrdinal === 1
      ? previousBackend !== null
      : previousBackend === null || previousBackend === 'builtin' || previousBackend === backend)) return null;
  const locks: LocalStoreLock[] = [];
  let retained = false;
  try {
    const acquired = acquireGeneratedRepairReservationLocks(rootId);
    if (!acquired) return null;
    locks.push(...acquired);
    const markerPath = generatedRepairReservationPath(item);
    if (!markerPath) return null;
    // Any durable marker, including malformed or unreadable state, represents
    // ambiguous paid-work authority and must remain operator-blocking.
    if (reservationPathState(markerPath) !== 'missing') return null;
    const record: GeneratedRepairExecutionReservationRecord = {
      schemaVersion: 1,
      reservationId: attemptId,
      createdAt: new Date().toISOString(),
      generationIds,
      itemIdHash: generatedRepairReservationItemIdHash(item.id),
      objectiveHash,
      repairRootId: item.repairRootId!,
      repairDepth: item.repairDepth!,
      repairRootAuthorityItemIdHash: generatedRepairReservationItemIdHash(rootAuthorityItemId),
      backend,
      tier,
      repairAttemptOrdinal,
      previousBackend,
      attemptHash: generatedRepairLifecycleAttemptHash(`run:${attemptId}`),
      phase: 'prepared',
    };
    if (!writeGeneratedRepairReservationRecord(markerPath, record)) return null;
    retained = true;
    return { markerPath, record, locks };
  } catch {
    return null;
  } finally {
    if (!retained) {
      for (const lock of locks.reverse()) releaseLocalStoreLock(lock);
    }
  }
}

function clearGeneratedRepairExecutionReservation(
  reservation: GeneratedRepairExecutionReservation,
): boolean {
  return clearGeneratedRepairReservationMarker(reservation.markerPath, reservation.record);
}

interface RepairTreatmentFlushResult {
  complete: boolean;
  publicationFailed: boolean;
}

function flushPendingRepairTreatmentOutcomes(): RepairTreatmentFlushResult {
  let complete = true;
  let publicationFailed = false;
  try {
    const pending = readPendingGeneratedRepairTreatmentOutcomes();
    if (!pending.available) return { complete: false, publicationFailed: false };
    for (const terminal of pending) {
      let published = false;
      try {
        published = publishGeneratedRepairTreatmentOutcome(terminal.generationId, terminal.attemptHash);
      } catch {
        // A thrown publisher is the same durable-outbox failure as a false ack.
      }
      if (!published) {
        complete = false;
        publicationFailed = true;
        console.warn('[ashlr] daemon: repair treatment witness persistence incomplete');
      }
    }
  } catch (err) {
    complete = false;
    console.warn('[ashlr] daemon: repair treatment witness reconciliation failed:', (err as Error)?.message ?? err);
  }
  return { complete, publicationFailed };
}

function generatedRepairShouldSkip(
  workedEvents: readonly WorkedEvent[],
  policy: QueueClaimCooldownPolicy,
): boolean {
  const latest = latestWorkedEventForKeys(workedEvents, policy.itemIds);
  if (!latest) return false;
  const override = policy.outcomeCooldownMs?.[latest.outcome];
  if (override !== undefined) {
    const eventMs = Date.parse(latest.ts);
    return !Number.isFinite(eventMs) || Date.now() - eventMs < override;
  }
  return workedEventIsCooling(latest, policy.cooldownMs);
}
const GENERATED_REPAIR_RECOVERY_MIN_ATTEMPTS = 3;
const RESOURCE_SNAPSHOT_MAX_AGE_MS = 30_000;
type DispatchPreflightState =
  | 'dispatchable'
  | 'route-unavailable'
  | 'capacity-or-route-unavailable'
  | 'resource-snapshot-unavailable';
const GENERATED_REPAIR_EMPTY_FAST_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_GENERATED_REPAIR_DECISION_EVENTS = 20;
const CONTEXT_ROLLUP_MAX_EVENTS = 5_000;
const DEFAULT_CONTEXT_ROLLUP_CADENCE_HOURS = 24;
const DEFAULT_CONTEXT_ROLLUP_MIN_TERMINAL_TRAJECTORIES = 50;
const audit = persistAudit;

// ---------------------------------------------------------------------------
// DaemonConfig defaults (conservative)
// ---------------------------------------------------------------------------

const DEFAULTS: DaemonConfig = {
  dailyBudgetUsd: 1.0,    // $1/day hard cap by default
  perTickItems: 3,         // at most 3 backlog items per tick
  parallel: 2,             // at most 2 concurrent sandboxed swarms per tick
  intervalMs: 5 * 60_000, // 5-minute tick interval in loop mode
};
const KILL_SWITCH_POLL_MS = 50;
const pendingDaemonTickEffects = new WeakMap<DaemonTick, Set<Promise<void>>>();

/** Register detached work that must settle before this tick can be called quiescent. */
export function trackDaemonTickEffect(
  tickResult: DaemonTick,
  effect: Promise<unknown>,
): Promise<void> {
  const tracked = Promise.resolve(effect).then(() => undefined, () => undefined);
  const pending = pendingDaemonTickEffects.get(tickResult) ?? new Set<Promise<void>>();
  pending.add(tracked);
  pendingDaemonTickEffects.set(tickResult, pending);
  void tracked.then(() => {
    pending.delete(tracked);
    if (pending.size === 0 && pendingDaemonTickEffects.get(tickResult) === pending) {
      pendingDaemonTickEffects.delete(tickResult);
    }
  });
  return tracked;
}

/** Drain a tick to a fixed point, including effects registered during the wait. */
export async function drainDaemonTickEffects(tickResult: DaemonTick): Promise<void> {
  while (true) {
    const pending = pendingDaemonTickEffects.get(tickResult);
    if (!pending || pending.size === 0) return;
    await Promise.all([...pending]);
  }
}

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
  signal?: AbortSignal;
  /** Resident ownership fence for asynchronous state callbacks. */
  ownerLock?: DaemonLock;
  onOwnershipLost?: () => void;
}
interface DaemonRunOptions extends TickOptions {
  once: boolean;
  maxCycles?: number;
}

/** Schedule advisory post-state work only after a durable resident tick returns. */
export function scheduleResolutionObserverAfterTick(
  tickResult: DaemonTick,
  opts: Pick<DaemonRunOptions, 'dryRun' | 'once'>,
  schedule: typeof scheduleResolutionObserverChild = scheduleResolutionObserverChild,
  killIsOn: typeof killSwitchOn = killSwitchOn,
): ScheduledResolutionObserverChild | null {
  if (opts.dryRun || opts.once || tickResult.reason === 'state-persistence-failed' ||
    !tickResult.backlogSnapshotAt || !tickResult.backlogSnapshotId || killIsOn()) return null;
  return schedule({
    completedTickAt: tickResult.ts,
    expectedBacklogGeneratedAt: tickResult.backlogSnapshotAt,
    expectedBacklogSnapshotId: tickResult.backlogSnapshotId,
  });
}

/** Schedule cutoff observation only after a durable resident daemon tick. */
export function scheduleCutoffCheckpointAfterTick(
  tickResult: DaemonTick,
  opts: Pick<DaemonRunOptions, 'dryRun' | 'once'>,
  schedule: typeof scheduleCutoffCheckpointCapture = scheduleCutoffCheckpointCapture,
): ScheduledCutoffCapture | null {
  if (opts.dryRun || opts.once || tickResult.reason === 'state-persistence-failed' ||
    !tickResult.backlogSnapshotAt || !tickResult.backlogSnapshotId || killSwitchOn()) return null;
  return schedule();
}

interface ResolvedContextRollupConfig {
  enabled: boolean;
  cadenceMs: number;
  minimumTerminalTrajectories: number;
}

function resolveContextRollupConfig(cfg: AshlrConfig): ResolvedContextRollupConfig {
  const raw = cfg.daemon?.contextRollup;
  const cadenceHours = typeof raw?.cadenceHours === 'number' && Number.isFinite(raw.cadenceHours) &&
    raw.cadenceHours > 0
    ? Math.min(168, Math.max(1, raw.cadenceHours))
    : DEFAULT_CONTEXT_ROLLUP_CADENCE_HOURS;
  const minimumTerminalTrajectories = typeof raw?.minTerminalTrajectories === 'number' &&
    Number.isFinite(raw.minTerminalTrajectories) && raw.minTerminalTrajectories > 0
    ? Math.min(5_000, Math.max(25, Math.floor(raw.minTerminalTrajectories)))
    : DEFAULT_CONTEXT_ROLLUP_MIN_TERMINAL_TRAJECTORIES;
  return {
    enabled: raw?.enabled !== false,
    cadenceMs: Math.floor(cadenceHours * 60 * 60 * 1_000),
    minimumTerminalTrajectories,
  };
}

export type ContextRollupAfterTickResult = ContextRollupDecision | {
  disposition: 'noop';
  reason: 'disabled' | 'dry-run' | 'tick-not-ok' | 'truncated' | 'unavailable';
};

function isEligibleContextRollupTerminal(event: AgentActionEvent): boolean {
  return event.actor === 'daemon' &&
    event.kind === 'dispatch' &&
    event.action === 'daemon:dispatch' &&
    event.learningSource === 'daemon-dispatch' &&
    event.learningLabel?.authoritative === true &&
    typeof event.runId === 'string' &&
    event.trajectoryId === `run:${event.runId}` &&
    event.runEventSummary?.runId === event.runId;
}

/** Record one bounded observational rollup after a durable resident tick. */
export function recordContextRollupAfterTick(
  tickResult: DaemonTick,
  opts: Pick<DaemonRunOptions, 'dryRun'>,
  cfg: AshlrConfig,
  deps: {
    now?: () => Date;
    read?: typeof readAgentActions;
    record?: (event: AgentActionEvent) => boolean;
  } = {},
): ContextRollupAfterTickResult {
  if (opts.dryRun) return { disposition: 'noop', reason: 'dry-run' };
  if (tickResult.reason !== 'ok') return { disposition: 'noop', reason: 'tick-not-ok' };
  const contract = resolveContextRollupConfig(cfg);
  if (!contract.enabled) return { disposition: 'noop', reason: 'disabled' };

  try {
    const observedAt = (deps.now ?? (() => new Date()))().toISOString();
    const cadenceWindowStart = Date.parse(observedAt) - contract.cadenceMs;
    const sinceMs = Date.parse(observedAt) - (2 * contract.cadenceMs);
    const events = (deps.read ?? readAgentActions)({
      sinceMs,
      limit: CONTEXT_ROLLUP_MAX_EVENTS + 1,
      maxFiles: 16,
      requireComplete: true,
      filter: (event) => event.action === 'daemon:context-rollup' ||
        isEligibleContextRollupTerminal(event),
    });
    if (events.length > CONTEXT_ROLLUP_MAX_EVENTS) {
      return { disposition: 'noop', reason: 'truncated' };
    }

    const rollupsById = new Map<string, AgentActionEvent>();
    for (const event of events) {
      if (event.actor === 'daemon' && event.kind === 'context-rollup' && event.outcome === 'ok' &&
        event.action === 'daemon:context-rollup' && event.contextRollupId) {
        rollupsById.set(event.contextRollupId, event);
      }
    }
    const rollups = [...rollupsById.values()].filter((event) =>
      event.actor === 'daemon' &&
      event.kind === 'context-rollup' &&
      event.outcome === 'ok' &&
      event.action === 'daemon:context-rollup');
    const terminalByTrajectory = new Map<string, AgentActionEvent>();
    for (const event of events) {
      const eventMs = Date.parse(event.ts);
      const trajectoryId = event.trajectoryId;
      if (eventMs < cadenceWindowStart || !trajectoryId ||
        !isEligibleContextRollupTerminal(event)) continue;
      const existing = terminalByTrajectory.get(trajectoryId);
      if (!existing || existing.ts < event.ts) terminalByTrajectory.set(trajectoryId, event);
    }
    const workspace = [...terminalByTrajectory.values()];
    const latestSourceAt = workspace.reduce(
      (latest, event) => event.ts > latest ? event.ts : latest,
      workspace[0]?.ts ?? observedAt,
    );
    const decision = decideContextRollup({
      observedAt,
      eligibleEventCount: workspace.length,
      latestSourceAt,
      persistedRollupEvents: rollups,
      counts: {
        uniqueTrajectories: workspace.length,
        proposalCreated: workspace.filter((event) =>
          event.runEventSummary?.proposalCreated === true || event.outcome === 'proposal-created').length,
        diagnosticNoProposal: workspace.filter((event) => event.outcome === 'no-proposal').length,
        policySuppressed: workspace.filter((event) => event.learningLabel?.policySuppressed === true).length,
        blocked: workspace.filter((event) => event.outcome === 'blocked').length,
        failed: workspace.filter((event) => event.outcome === 'failed').length,
      },
    }, {
      defaultContract: {
        cadenceMs: contract.cadenceMs,
        minimumTerminalTrajectories: contract.minimumTerminalTrajectories,
      },
    });
    if (decision.disposition === 'emit') {
      const persisted = deps.record
        ? deps.record(decision.event)
        : recordAgentActionResult(decision.event, { sync: true }).recorded === 1;
      if (!persisted) return { disposition: 'noop', reason: 'unavailable' };
    }
    return decision;
  } catch {
    return { disposition: 'noop', reason: 'unavailable' };
  }
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

interface CanonicalEnrollmentSelection {
  repos: string[];
  missingExact: boolean;
}

/** Reject aliases while retaining incompleteness when an exact enrolled path is missing. */
function exactCanonicalEnrolledRepos(repos: readonly string[]): CanonicalEnrollmentSelection {
  const exact = new Set<string>();
  let missingExact = false;
  for (const repo of repos) {
    if (canonicalEnrollmentPath(repo) !== repo) {
      missingExact = true;
      continue;
    }
    if (!existsSync(repo)) {
      missingExact = true;
      continue;
    }
    exact.add(repo);
  }
  return { repos: [...exact], missingExact };
}

function cachedBacklogCountForEnrolledRepos(enrolled: string[]): number {
  try {
    const enrolledRepos = new Set(exactCanonicalEnrolledRepos(enrolled).repos);
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

function startDaemonLockHeartbeat(
  lock: DaemonLock,
  afterHeartbeat?: () => void,
  onOwnershipLost?: () => void,
): () => void {
  const interval = setInterval(() => {
    if (daemonLockOwned(lock)) afterHeartbeat?.();
    else onOwnershipLost?.();
  }, 30_000);
  (interval as { unref?: () => void }).unref?.();
  return () => clearInterval(interval);
}

function daemonLockOwned(lock: DaemonLock): boolean {
  const owner = readDaemonLockOwner();
  return owner?.pid === lock.pid && owner.token === lock.token;
}

function updateResidentDaemonState(
  lock: DaemonLock,
  update: (current: DaemonState) => DaemonState | null,
): SaveDaemonStateResult {
  const path = daemonStatePath();
  const stateLock = acquireLocalStoreLock(`${path}.resident.lock`);
  if (!stateLock) return { ok: false, path, error: 'could not acquire resident state lock' };
  try {
    if (!daemonLockOwned(lock)) {
      return { ok: false, path, error: 'daemon lock ownership lost before state save' };
    }
    const loaded = loadDaemonStateStrict();
    if (!loaded.ok) return { ok: false, path, error: loaded.error };
    const next = update(loaded.state);
    return next === null ? { ok: true, path } : saveDaemonStateResult(next);
  } finally {
    releaseLocalStoreLock(stateLock);
  }
}

/** Serialize resident state writes and validate the exact daemon token in-lock. */
export function saveResidentDaemonState(
  lock: DaemonLock,
  state: DaemonState,
): SaveDaemonStateResult {
  return updateResidentDaemonState(lock, () => state);
}

function staleResidentProof(state: DaemonState): 'dead' | 'reused' | null {
  if (state.running !== true || typeof state.pid !== 'number' || state.pid === process.pid) return null;
  try {
    process.kill(state.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH' ? 'dead' : null;
  }
  const activity = readDaemonActivity();
  return activity.ownerState === 'reused' &&
    activity.activity?.pid === state.pid &&
    activity.activity.daemonStartedAt === state.startedAt
    ? 'reused'
    : null;
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

function boundedProposalSourceQuality(
  quality: NonNullable<FleetStatus['proposals']['sourceQuality']>,
): NonNullable<FleetStatus['proposals']['sourceQuality']> {
  const count = (value: number): number =>
    Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
  return {
    sourceState: quality.sourceState,
    sourcePresent: quality.sourcePresent === true,
    complete: quality.complete === true,
    stopReasons: quality.stopReasons.slice(0, 5),
    filesDiscovered: count(quality.filesDiscovered),
    filesRead: count(quality.filesRead),
    invalidFiles: count(quality.invalidFiles),
    unreadableFiles: count(quality.unreadableFiles),
  };
}

function tickProposalAuthority(
  quality: NonNullable<FleetStatus['proposals']['sourceQuality']>,
): NonNullable<FleetStatus['proposals']['authority']> {
  if (quality.sourceState !== 'degraded' && quality.complete) {
    return {
      gate: 'ready',
      detail: quality.sourceState === 'missing'
        ? 'complete empty proposal source'
        : `complete proposal source (${quality.filesRead}/${quality.filesDiscovered} files read)`,
    };
  }
  const reasons = quality.stopReasons.length > 0 ? `: ${quality.stopReasons.join(', ')}` : '';
  return {
    gate: 'unavailable',
    detail: `auto-merge authority requires a complete healthy proposal source; ` +
      `${quality.sourceState} source is ${quality.complete ? 'complete' : 'incomplete'}${reasons}`,
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
  let recentMerges = 0;
  let proposalSourceQuality: NonNullable<FleetStatus['merges']['sourceQuality']> = {
    sourceState: 'degraded',
    sourcePresent: false,
    complete: false,
    stopReasons: ['source-not-read'],
    filesDiscovered: 0,
    filesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
  };
  try {
    const read = listProposalsDetailed();
    proposalSourceQuality = boundedProposalSourceQuality({
      sourceState: read.sourceState,
      sourcePresent: read.sourcePresent,
      complete: read.complete,
      stopReasons: [...read.stopReasons],
      filesDiscovered: read.filesDiscovered,
      filesRead: read.filesRead,
      invalidFiles: read.invalidFiles,
      unreadableFiles: read.unreadableFiles,
    });
    const now = Date.now();
    const recentCutoff = now - 24 * 60 * 60 * 1000;
    const counted = new Set<string>();
    for (const proposal of read.proposals) {
      if (proposal.status === 'pending') {
        pending++;
        if (proposal.engineTier === 'frontier') frontierPending++;
      } else if (proposal.status === 'applied') {
        applied++;
      } else if (proposal.status === 'awaiting-host-merge') {
        awaitingHostMerge++;
      }
      if (!read.complete || counted.has(proposal.id)) continue;
      const evidence = realizedMergeOf(proposal);
      if (!evidence) continue;
      const observedAt = evidence.source === 'local-default-branch'
        ? evidence.observedAt
        : evidence.reconciliation.observedAt;
      const observedMs = Date.parse(observedAt);
      if (!Number.isFinite(observedMs) || observedMs < recentCutoff || observedMs > now) continue;
      counted.add(proposal.id);
      recentMerges++;
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    awaitingHostMerge = 0;
    applied = 0;
    recentMerges = 0;
    proposalSourceQuality = {
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      stopReasons: ['source-read-failed'],
      filesDiscovered: 0,
      filesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
    };
  }

  const proposalAuthority = tickProposalAuthority(proposalSourceQuality);

  const recentTicks = Array.isArray(state.ticks) ? state.ticks : [];
  let reportedByTicks = 0;
  for (const tickRecord of recentTicks) {
    if (typeof tickRecord.merged !== 'number' || !Number.isFinite(tickRecord.merged) || tickRecord.merged <= 0) continue;
    reportedByTicks = Math.min(Number.MAX_SAFE_INTEGER, reportedByTicks + Math.floor(tickRecord.merged));
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
    proposals: {
      pending,
      frontierPending,
      ...(awaitingHostMerge > 0 ? { awaitingHostMerge } : {}),
      applied,
      sourceQuality: proposalSourceQuality,
      authority: proposalAuthority,
    },
    merges: { recent: recentMerges, reportedByTicks, sourceQuality: proposalSourceQuality },
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

function dispatchConfigForItem(item: WorkItem, cfg: AshlrConfig): AshlrConfig {
  if (!isTrustedDiagnosticResliceItem(item)) return cfg;
  if (item.repairTreatment !== 'baseline-reslice' && item.repairTreatment !== 'target-localization') {
    return cfg;
  }
  return {
    ...cfg,
    foundry: {
      ...cfg.foundry,
      repoMap: false,
      localization: item.repairTreatment === 'target-localization',
    },
  } as AshlrConfig;
}

interface GeneratedRepairRouteEvaluation {
  attemptId?: string;
  feasibility: GeneratedRepairRouteFeasibility;
}

function preclaimRouteAttemptId(itemId: string, reason: GeneratedRepairRouteReason): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      'ashlr:preclaim-route-attempt:v1',
      itemId,
      reason,
      ROUTER_POLICY_VERSION,
    ]))
    .digest('hex')
    .slice(0, 32);
  return `attempt-${digest}`;
}

function generatedRepairRouteReason(value: unknown): GeneratedRepairRouteReason {
  switch (value) {
    case 'feasible':
    case 'provenance-unavailable':
    case 'lifecycle-unavailable':
    case 'editing-backend-unavailable':
    case 'same-tier-backend-unavailable':
    case 'same-tier-alternative-unavailable':
    case 'inspection-unavailable':
    case 'route-capacity-unavailable':
      return value;
    default:
      return 'inspection-unavailable';
  }
}

function drainTag(mode: DaemonDrainMode): string {
  return `${DRAIN_MODE_TAG_PREFIX}${mode}`;
}

function isDrainCandidate(item: WorkItem, mode: DaemonDrainMode): boolean {
  switch (mode) {
    case 'capture-repairs':
      return isTrustedCaptureRepairItem(item);
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
    case 'capture-repairs': {
      const configured = normalizeDrainLimit(cfg.daemon?.drainLimits?.captureRepairs);
      return configured ?? DEFAULT_CAPTURE_REPAIR_DRAIN_LIMIT;
    }
    case 'diagnostic-reslices': {
      const configured = normalizeDrainLimit(cfg.daemon?.drainLimits?.diagnosticReslices);
      return configured ?? DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT;
    }
  }
}

function canAutoDrainRepairs(
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
  fairnessDeferred?: boolean,
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
    ...(fairnessDeferred ? { fairnessDeferred: true } : {}),
    ...(selectedItemIds.length > 0 ? { selectedItemIds } : {}),
    ...(availableItems.length > 0 && selectedItems.length === 0 && !fairnessDeferred ? { stalled: true } : {}),
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
  fairnessDeferred?: boolean;
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
    reason: fields.dryRun
      ? 'dry-run'
      : fields.fairnessDeferred
        ? 'ordinary-turn-fairness'
        : fields.automatic ? 'auto-live' : 'live',
    ...(selectedIds[0] ? { itemId: selectedIds[0] } : {}),
    tags: [
      'drain-select',
      drainTag(fields.mode),
      fields.automatic ? 'auto-drain' : 'explicit-drain',
      fields.selectedItems.length > 0 ? 'selected' : 'none-selected',
      ...(fields.capped ? ['capped'] : []),
      ...(fields.fairnessDeferred ? ['fairness-deferred', 'ordinary-turn'] : []),
      ...(fields.dryRun ? ['dry-run'] : []),
    ],
    counts: {
      available: fields.available,
      selected: fields.selectedItems.length,
      ...(typeof fields.limit === 'number' ? { limit: fields.limit } : {}),
      ...(fields.capped ? { capped: 1 } : {}),
      ...(fields.automatic ? { automatic: 1 } : {}),
      ...(fields.fairnessDeferred ? { fairnessDeferred: 1 } : {}),
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
  routeBlocked: number;
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
      `cooldown ${fields.cooldownBlocked}, pending ${fields.pendingBlocked}, route ${fields.routeBlocked}`,
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
      routeBlocked: fields.routeBlocked,
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
  workedEvents: readonly WorkedEvent[];
  baseCooldownMs: number;
  repairRecoveryHealthy: boolean;
  cooldownPolicies: ReadonlyMap<string, QueueClaimCooldownPolicy>;
  dispatchPreflightByItemId?: Map<string, DispatchPreflightState>;
  routeEvaluationByItem?: Map<WorkItem, GeneratedRepairRouteEvaluation>;
}): void {
  const selectedKeys = new Set(fields.selectedItems.map(workItemCoverageKey));
  const claimedKeys = new Set(fields.claimedItems.map(workItemCoverageKey));
  const allGeneratedItems = fields.items.filter((item) => isTrustedGeneratedRepairItem(item));
  const generatedItems = allGeneratedItems.slice(0, MAX_GENERATED_REPAIR_DECISION_EVENTS);
  const droppedDecisionCount = Math.max(0, allGeneratedItems.length - generatedItems.length);
  if (generatedItems.length === 0) return;
  recordAgentAction(generatedItems.map((item): AgentActionEvent => {
    const pendingBlocked = fields.pendingItemKeys.has(workItemCoverageKey(item));
    const itemKey = workItemExecutionKey(item) ?? workItemCoverageKey(item);
    const policy = fields.cooldownPolicies.get(itemKey) ??
      claimCooldownPolicyForSelectionItem(item, fields.baseCooldownMs, fields.repairRecoveryHealthy);
    const effectiveCooldownMs = cooldownMsForSelectionItem(fields.workedEvents, policy);
    const cooldownBlocked = generatedRepairShouldSkip(fields.workedEvents, policy);
    const selected = selectedKeys.has(itemKey);
    const claimed = claimedKeys.has(itemKey);
    const dispatchPreflight = fields.dispatchPreflightByItemId?.get(workItemCoverageKey(item));
    const routeEvaluation = fields.routeEvaluationByItem?.get(item);
    const inspectedRoute = routeEvaluation?.feasibility;
    const blockedRouteEvaluation = inspectedRoute && !inspectedRoute.feasible
      ? routeEvaluation
      : undefined;
    const inspectedRouteReason = generatedRepairRouteReason(inspectedRoute?.reason);
    const inspectedRouteSnapshot = inspectedRoute
      ? routeSnapshot({
          backend: inspectedRoute.feasible ? inspectedRoute.backend : null,
          tier: inspectedRoute.requiredTier,
          assignedBy: 'preclaim-route-inspection',
          reason: inspectedRouteReason,
        })
      : undefined;
    const dispatchBlocked = dispatchPreflight !== undefined && dispatchPreflight !== 'dispatchable';
    const latest = latestWorkedEventForKeys(fields.workedEvents, policy.itemIds);
    const fastRepairCooldown = effectiveCooldownMs < fields.baseCooldownMs;
    const reason = claimed
      ? 'claimed'
      : selected
        ? 'claim-missed'
        : pendingBlocked
          ? 'pending-proposal'
          : cooldownBlocked
            ? `cooldown: latest=${latest?.outcome ?? 'unknown'}`
            : dispatchBlocked
              ? `dispatch-${dispatchPreflight}`
            : 'not-selected';
    const outcome: AgentActionOutcome = claimed
      ? 'ok'
      : (selected || pendingBlocked || cooldownBlocked || dispatchBlocked)
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
      ...(blockedRouteEvaluation?.attemptId
        ? {
            runId: blockedRouteEvaluation.attemptId,
            trajectoryId: `run:${blockedRouteEvaluation.attemptId}`,
          }
        : {}),
      ...(blockedRouteEvaluation && inspectedRouteSnapshot ? { routeSnapshot: inspectedRouteSnapshot } : {}),
      learningSource: 'agent-action',
      ...(inspectedRoute ? { labelBasis: 'preclaim-route-feasibility' } : {}),
      tags: [
        'generated-repair-decision',
        selected ? 'selected' : 'not-selected',
        claimed ? 'claimed' : 'not-claimed',
        pendingBlocked ? 'pending-blocked' : 'pending-clear',
        cooldownBlocked ? 'cooldown-blocked' : 'cooldown-clear',
        dispatchPreflight ? `dispatch-${dispatchPreflight}` : 'dispatch-not-evaluated',
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
        dispatchEvaluated: dispatchPreflight ? 1 : 0,
        dispatchBlocked: dispatchBlocked ? 1 : 0,
        routeEvaluated: inspectedRoute ? 1 : 0,
        routeFeasible: inspectedRoute?.feasible ? 1 : 0,
        routeRequiresAlternative: inspectedRoute?.requiresAlternative ? 1 : 0,
        generatedRepairDecisionDropped: droppedDecisionCount,
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
  if (production.runEventSummary?.status === 'aborted') return undefined;
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
  if (/\bempty[- ]diff\b/i.test(reason)) return 'empty-diff';
  if (/\b(trivial-proposal|trivial|completeness-gate|gate-blocked|gate)\b/i.test(reason)) return 'gate-blocked';
  if (/\b(sandbox-unavailable|sandbox)\b/i.test(reason)) return 'sandbox-failed';
  if (/\b(proposal-capture-error|capture)\b/i.test(reason)) return 'proposal-capture-error';
  if (/\b(proposal-disabled)\b/i.test(reason)) return 'proposal-disabled';
  if (/\b(engine|api-model-task-failed|command-missing|unsupported|failed|error|aborted|budget)\b/i.test(reason)) return 'engine-failed';
  return 'unknown';
}

function normalizeBestOfNSignal(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function candidateErrorDuplicatesProposalOutcome(
  error: string,
  outcome: RunProposalOutcome | undefined,
): boolean {
  if (!outcome) return false;
  const normalizedError = normalizeBestOfNSignal(error);
  const reason = outcome.reason?.trim();
  if (normalizedError === normalizeBestOfNSignal(outcome.kind)) return true;
  if (!reason) return false;
  return normalizedError === normalizeBestOfNSignal(reason) ||
    normalizedError === normalizeBestOfNSignal(`${outcome.kind}: ${reason}`);
}

function bestOfNAuthoritativeNoWinnerProduction(
  result: BestOfNRunResult,
  n: number,
  runId: string,
  costUsd: number,
): DaemonDispatchProduction | undefined {
  const authorityRank: Record<DaemonDispatchProductionOutcome, number> = {
    'proposal-created': 700,
    'proposal-capture-error': 650,
    'engine-failed': 600,
    'sandbox-failed': 550,
    'gate-blocked': 400,
    'empty-diff': 300,
    'proposal-disabled': 200,
    cancelled: 0,
    unknown: 100,
  };
  const authorities: Array<{
    production: DaemonDispatchProduction;
    rank: number;
    tieBreak: string;
  }> = [];
  const addAuthority = (production: DaemonDispatchProduction, tieBreak: string): void => {
    authorities.push({ production, rank: authorityRank[production.outcome], tieBreak });
  };
  const structuredErrorAuthorities = new Map<string, DaemonDispatchProduction>();

  for (const candidate of result.candidates) {
    // A Best-of-N candidate can finish with a real diff even when proposal
    // filing was disabled. Preserve the direct-run capture contract here so a
    // changed-but-unfiled candidate reaches capture repair instead of being
    // mistaken for a harmless policy suppression.
    const candidateProduction = dispatchProductionFromProposalOutcome(
      candidate.proposalOutcome,
      undefined,
      undefined,
      { proposalRequired: true },
    );
    if (candidateProduction) {
      addAuthority(candidateProduction, `outcome:${candidateProduction.outcome}:${candidateProduction.reason ?? ''}`);
    }
    const error = candidate.error?.trim();
    if (error && candidateProduction && candidateErrorDuplicatesProposalOutcome(error, candidate.proposalOutcome)) {
      structuredErrorAuthorities.set(normalizeBestOfNSignal(error), candidateProduction);
    }
    if (
      error &&
      error !== 'cancelled' &&
      !candidateErrorDuplicatesProposalOutcome(error, candidate.proposalOutcome)
    ) {
      addAuthority({ outcome: 'engine-failed', reason: error }, `error:${error}`);
    }
  }
  for (const entry of result.critique.noProposalReasons ?? []) {
    const reason = entry.reason.trim();
    if (!reason || reason === 'selection cancelled' || reason === 'cancelled') continue;
    const structuredAuthority = structuredErrorAuthorities.get(normalizeBestOfNSignal(reason));
    const outcome = structuredAuthority?.outcome ?? noProposalOutcomeFromReason(reason);
    const authoritativeReason = structuredAuthority?.outcome === 'proposal-capture-error'
      ? structuredAuthority.reason ?? reason
      : reason;
    addAuthority(
      { ...(structuredAuthority ?? { outcome }), reason: authoritativeReason },
      `critique:${outcome}:${authoritativeReason}`,
    );
  }

  const selected = authorities.sort((left, right) =>
    right.rank - left.rank || left.tieBreak.localeCompare(right.tieBreak)
  )[0]?.production;
  if (!selected) return undefined;
  const reason = selected.reason ?? selected.outcome;
  const failed = selected.outcome === 'engine-failed' || selected.outcome === 'sandbox-failed' ||
    selected.outcome === 'proposal-capture-error';
  return {
    ...selected,
    runId,
    reason: boundedText(`best-of-${n}: ${reason}`, 220),
    runEventSummary: runEventSummary({
      runId,
      status: failed
        ? /\b(aborted|budget)\b/i.test(reason) ? 'aborted' : 'failed'
        : 'done',
      outcome: selected.outcome,
      proposalCreated: selected.outcome === 'proposal-created',
      proposalId: selected.proposalId,
      costUsd,
    }),
  };
}

function bestOfNNoWinnerProduction(n: number): DaemonDispatchProduction {
  return {
    outcome: 'unknown',
    reason: `best-of-${n}: all candidates failed to produce a proposal`,
  };
}

function bestOfNWasCancelled(result: BestOfNRunResult): boolean {
  return result.critique.noProposalReasons?.some((entry) => entry.reason === 'selection cancelled') === true ||
    (result.candidates.length > 0 && result.candidates.every((candidate) => candidate.error === 'cancelled'));
}

function cancelledDispatchProduction(
  runId: string,
  reason: string,
  costUsd: number,
  summary?: RunEventSummary,
  evidenceOutcome?: EvidenceOutcomeSummary,
): DaemonDispatchProduction {
  const evidence = evidenceOutcomeSummary(evidenceOutcome);
  return {
    outcome: 'cancelled',
    runId,
    reason,
    runEventSummary: runEventSummary({
      ...(summary ?? {}),
      runId,
      status: 'aborted',
      outcome: 'cancelled',
      proposalCreated: false,
      costUsd,
    }),
    ...(evidence ? { evidenceOutcome: evidence } : {}),
  };
}

function failedProducerDispatchProduction(fields: {
  runId: string;
  producer: string;
  status: 'aborted' | 'failed';
  result?: string;
  costUsd: number;
  summary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
}): DaemonDispatchProduction {
  const evidence = evidenceOutcomeSummary(fields.evidenceOutcome);
  const result = fields.result?.trim();
  const reason = boundedText(
    result || `${fields.producer} ${fields.status} without a proposal outcome`,
    220,
  );
  return {
    outcome: 'engine-failed',
    runId: fields.runId,
    reason,
    runEventSummary: runEventSummary({
      ...(fields.summary ?? {}),
      runId: fields.runId,
      status: fields.status,
      outcome: 'engine-failed',
      proposalCreated: false,
      costUsd: fields.costUsd,
    }),
    ...(evidence ? { evidenceOutcome: evidence } : {}),
  };
}

function resultDescribesCancellation(result: string | undefined): boolean {
  return typeof result === 'string' && /\bcancel(?:led|ed|lation)?\b/i.test(result);
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
  cfg: AshlrConfig,
  reservation?: GeneratedRepairExecutionReservationRecord,
): DispatchProductionEvent | null {
  if (!value.dispatched) return null;
  const trace = value.dispatch;
  if (!trace) return null;
  const production = trace.production;
  const objectiveHash = workItemObjectiveHash(value.item);
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
  const proofCapableRepairOutcome = outcome === 'empty-diff' || outcome === 'proposal-created';
  const failedRepairOutcome = GENERATED_REPAIR_FAILED_OUTCOMES.has(outcome) && !proposalCreated;
  const effectiveRetryPolicy = effectiveGeneratedRepairRetryPolicy(value.item);
  const failureReservation = reservation;
  const diagnosticFailureLineage = generatedRepairDispatchLineage(value.item, trace.backend);
  const genericFailureLineage = isTrustedGeneratedRepairItem(value.item) &&
    typeof value.item.repairHandoffId === 'string' &&
    typeof value.item.repairGenerationId === 'string'
    ? {
        repairHandoffId: value.item.repairHandoffId,
        repairGenerationId: value.item.repairGenerationId,
      }
    : null;
  const failureReceiptLineage = failedRepairOutcome && failureReservation
    ? (diagnosticFailureLineage ?? genericFailureLineage)
    : null;
  const exactFailureReceiptLineage = failureReceiptLineage &&
    failureReservation !== undefined &&
    failureReservation.generationIds.includes(failureReceiptLineage.repairGenerationId) &&
    failureReservation.backend === trace.backend && failureReservation.tier === trace.tier &&
    failureReservation.repairRootId === value.item.repairRootId &&
    failureReservation.repairDepth === value.item.repairDepth &&
    (failureReservation.repairAttemptOrdinal === 1 || failureReservation.previousBackend !== null)
    ? {
        ...failureReceiptLineage,
        repairAttemptOrdinal: failureReservation.repairAttemptOrdinal,
        ...(failureReservation.repairAttemptOrdinal === 2
          ? { repairPreviousBackend: failureReservation.previousBackend! }
          : {}),
        repairRootId: failureReservation.repairRootId,
        repairDepth: failureReservation.repairDepth,
      }
    : null;
  const successGenerationId = proofCapableRepairOutcome ? generatedRepairGenerationId(value.item) : null;
  const diagnosticSuccessLineage = proofCapableRepairOutcome
    ? generatedRepairDispatchLineage(value.item, trace.backend)
    : null;
  const exactSuccessReceiptLineage = proofCapableRepairOutcome && failureReservation &&
    isTrustedGeneratedRepairItem(value.item) &&
    successGenerationId !== null && failureReservation.generationIds.includes(successGenerationId) &&
    failureReservation.backend === trace.backend && failureReservation.tier === trace.tier &&
    trace.trajectoryId === `run:${failureReservation.reservationId}` &&
    failureReservation.objectiveHash === objectiveHash &&
    failureReservation.repairRootId === value.item.repairRootId &&
    failureReservation.repairDepth === value.item.repairDepth &&
    (failureReservation.repairAttemptOrdinal === 1 || failureReservation.previousBackend !== null) &&
    (!isTrustedDiagnosticResliceItem(value.item) || (
      diagnosticSuccessLineage !== null &&
      diagnosticSuccessLineage.repairGenerationId === successGenerationId
    ))
    ? {
        ...(typeof value.item.repairHandoffId === 'string'
          ? { repairHandoffId: value.item.repairHandoffId }
          : {}),
        repairGenerationId: successGenerationId,
        ...(diagnosticSuccessLineage
          ? {
              repairTreatmentUnitId: diagnosticSuccessLineage.repairTreatmentUnitId,
              repairTreatment: diagnosticSuccessLineage.repairTreatment,
            }
          : {}),
        repairAttemptOrdinal: failureReservation.repairAttemptOrdinal,
        ...(failureReservation.repairAttemptOrdinal === 2
          ? { repairPreviousBackend: failureReservation.previousBackend! }
          : {}),
        ...(!diagnosticSuccessLineage
          ? {
              repairRootId: failureReservation.repairRootId,
              repairDepth: failureReservation.repairDepth,
            }
          : {}),
      }
    : null;
  const repairParentTierBound = isTrustedDiagnosticResliceItem(value.item) || (
    isTrustedCaptureRepairItem(value.item) &&
    (value.item.repairParentSource === 'issue' || value.item.repairParentSource === 'goal')
  );
  const repairRequiredTier = effectiveRetryPolicy.requiredTier ?? (
    repairParentTierBound ? value.item.repairParentTier ?? null : null
  );
  const repairLineageInvalid = (proofCapableRepairOutcome || failedRepairOutcome) &&
    isTrustedGeneratedRepairItem(value.item) && (
    !effectiveRetryPolicy.available ||
    trace.backend === null ||
    trace.backend === 'builtin' ||
    !effectiveGeneratedRepairExecutionBackendAllowed(value.item, trace.backend, cfg) ||
    (repairRequiredTier !== null && trace.tier !== repairRequiredTier) ||
    (failedRepairOutcome
      ? exactFailureReceiptLineage === null
      : exactSuccessReceiptLineage === null)
  );
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
    ...(objectiveHash ? { objectiveHash } : {}),
    ...(repairLineageInvalid
      ? { repairLineageInvalid: true as const }
      : (exactFailureReceiptLineage ?? exactSuccessReceiptLineage ?? {})),
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
    case 'cancelled':
      return 'skipped';
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
    ...(event.repairHandoffId ? { repairHandoffId: event.repairHandoffId } : {}),
    ...(event.repairGenerationId ? { repairGenerationId: event.repairGenerationId } : {}),
    ...(event.repairTreatmentUnitId ? { repairTreatmentUnitId: event.repairTreatmentUnitId } : {}),
    ...(event.repairTreatment ? { repairTreatment: event.repairTreatment } : {}),
    ...(event.repairLineageInvalid ? { repairLineageInvalid: true as const } : {}),
    ...(event.repairAttemptOrdinal ? { repairAttemptOrdinal: event.repairAttemptOrdinal } : {}),
    ...(event.repairPreviousBackend ? { repairPreviousBackend: event.repairPreviousBackend } : {}),
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
    const read = readDispatchProductionYieldDetailed({
      windowMs: GENERATED_REPAIR_RECOVERY_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 1,
    });
    if (read.sourceQuality.sourceState !== 'healthy' || !read.sourceQuality.complete) return false;
    const yieldSummary = read.summary;
    const generated = yieldSummary?.generatedRepairAttempts;
    if (!generated || generated.attempts < GENERATED_REPAIR_RECOVERY_MIN_ATTEMPTS) return false;
    return generated.proposalRate >= Math.max(configuredLowRepairYieldRate(cfg), 0.5);
  } catch {
    return false;
  }
}

function cooldownMsForSelectionItem(
  workedEvents: readonly WorkedEvent[],
  policy: QueueClaimCooldownPolicy,
): number {
  const latest = latestWorkedEventForKeys(workedEvents, policy.itemIds);
  return latest ? policy.outcomeCooldownMs?.[latest.outcome] ?? policy.cooldownMs : policy.cooldownMs;
}

function claimCooldownPolicyForSelectionItem(
  item: WorkItem,
  baseCooldownMs: number,
  repairRecoveryHealthy: boolean,
): QueueClaimCooldownPolicy {
  const outcomeCooldownMs: Partial<Record<WorkedOutcome, number>> = {};
  outcomeCooldownMs.diff = baseCooldownMs;
  if (isTrustedGeneratedRepairItem(item)) {
    outcomeCooldownMs['dispatch-blocked'] = Math.min(
      baseCooldownMs,
      GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS,
    );
    if (repairRecoveryHealthy) {
      outcomeCooldownMs.empty = Math.min(baseCooldownMs, GENERATED_REPAIR_EMPTY_FAST_COOLDOWN_MS);
    }
  }
  return {
    itemIds: generatedRepairCooldownKeys(item),
    cooldownMs: baseCooldownMs,
    ...(Object.keys(outcomeCooldownMs).length > 0 ? { outcomeCooldownMs } : {}),
  };
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
  let ownershipLost = false;
  const stillOwnsTick = (): boolean => {
    if (!opts.ownerLock) return true;
    if (ownershipLost) return false;
    if (daemonLockOwned(opts.ownerLock)) return true;
    ownershipLost = true;
    opts.onOwnershipLost?.();
    return false;
  };
  const saveTickState = (nextState: DaemonState): SaveDaemonStateResult =>
    opts.ownerLock
      ? saveResidentDaemonState(opts.ownerLock, nextState)
      : saveDaemonStateResult(nextState);
  const stopRequested = (): boolean =>
    opts.signal?.aborted === true || killSwitchOn() || !stillOwnsTick();
  const audit = (entry: Parameters<typeof persistAudit>[0]): void => {
    if (stillOwnsTick()) persistAudit(entry);
  };
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
  let backlogSnapshotAt: string | undefined;
  let backlogSnapshotId: string | undefined;
  const ownershipLostTick = (t: DaemonTick): DaemonTick => ({
    ...t,
    reason: 'shutdown-requested',
    durationMs: t.durationMs ?? Date.now() - _tickStartMs,
  });
  const nonResidentPersistenceFailureTick = (tick: DaemonTick): DaemonTick => {
    const { residentSafePersistenceFailure: _residentSafePersistenceFailure, ...failed } = tick;
    return { ...failed, reason: 'state-persistence-failed' };
  };
  if (!stillOwnsTick()) {
    return ownershipLostTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'shutdown-requested',
    });
  }
  recordTickStartAgentAction({
    ts: now,
    dryRun: opts.dryRun,
    dailyBudgetUsd: dcfg.dailyBudgetUsd,
    perTickItems: dcfg.perTickItems,
    parallel: dcfg.parallel,
    mode: dcfg.mode,
    ...(opts.drain ? { drain: opts.drain } : {}),
  });
  const startupTreatmentFlush = !opts.dryRun && !stopRequested()
    ? flushPendingRepairTreatmentOutcomes()
    : { complete: true, publicationFailed: false };
  let repairTreatmentWitnessPersistenceFailed = !startupTreatmentFlush.complete;
  let repairTreatmentPublicationFailed = startupTreatmentFlush.publicationFailed;
  let proposalDuplicateAuthorityUnavailable = false;
  const withRepairTreatmentPublicationFailure = (tick: DaemonTick): DaemonTick => {
    if (!repairTreatmentPublicationFailed) return tick;
    if (tick.reason === 'state-persistence-failed') {
      return nonResidentPersistenceFailureTick(tick);
    }
    return {
      ...tick,
      reason: 'state-persistence-failed',
      residentSafePersistenceFailure: 'repair-treatment',
    };
  };
  const recordTick = (t: DaemonTick): DaemonTick => {
    const tick = withRepairTreatmentPublicationFailure({
      ...(opts.dryRun ? { ...t, dryRun: true } : t),
      ...(proposalDuplicateAuthorityUnavailable
        ? { reason: 'state-persistence-failed' as const }
        : {}),
      ...(backlogSnapshotAt ? { backlogSnapshotAt } : {}),
      ...(backlogSnapshotId ? { backlogSnapshotId } : {}),
      durationMs: t.durationMs ?? Date.now() - _tickStartMs,
    });
    if (!stillOwnsTick()) return ownershipLostTick(tick);
    try {
      const loaded = loadDaemonStateStrict();
      if (!loaded.ok) {
        const failedTick = nonResidentPersistenceFailureTick(tick);
        recordTickAgentAction(failedTick);
        return failedTick;
      }
      let s = loaded.state;
      s = resetDayIfNeeded(s);
      s.lastTickAt = tick.ts;
      s.ticks = [...s.ticks, tick];
      const saveResult = saveTickState(s);
      if (!saveResult.ok) {
        console.warn('[ashlr] daemon:recordTick persistence failed:', saveResult.error);
        const failedTick = nonResidentPersistenceFailureTick(tick);
        recordTickAgentAction(failedTick);
        return failedTick;
      }
    } catch (err) {
      console.warn('[ashlr] daemon:recordTick persistence failed:', (err as Error)?.message ?? err);
      const failedTick = nonResidentPersistenceFailureTick(tick);
      recordTickAgentAction(failedTick);
      return failedTick;
    }
    recordTickAgentAction(tick);
    return tick;
  };
  const persistenceRefusal = (summary: string, result: 'refused' | 'error' = 'refused'): DaemonTick => {
    if (!stillOwnsTick()) {
      return ownershipLostTick({
        ts: now,
        itemsConsidered: 0,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'shutdown-requested',
      });
    }
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
  const acquireTickMutationFence = () => {
    if (!opts.ownerLock) return undefined;
    const fence = acquireLocalStoreLock(`${opts.ownerLock.path}.mutation.lock`);
    if (!fence) return null;
    if (daemonLockOwned(opts.ownerLock)) return fence;
    releaseLocalStoreLock(fence);
    stillOwnsTick();
    return null;
  };
  const runAutoMergeMaintenancePass = async (
    ownershipAlreadyFenced = false,
  ): Promise<AutoMergePassResult | null> => {
    if (directionPlan?.runAutoMergeMaintenance === false || opts.dryRun || stopRequested()) return null;
    const fence = ownershipAlreadyFenced ? undefined : acquireTickMutationFence();
    if (!ownershipAlreadyFenced && opts.ownerLock && !fence) return null;
    try {
      if (!stillOwnsTick()) return null;
      const result = await runAutoMergePass(liveCfg);
      return stillOwnsTick() ? result : null;
    } catch (err) {
      console.warn('[ashlr] daemon:tick runAutoMergePass failed:', (err as Error)?.message ?? err);
      return null;
    } finally {
      releaseLocalStoreLock(fence);
    }
  };
  let preDispatchAutoMergePassResult: AutoMergePassResult | null = null;
  let preDispatchAutoMergePassRan = false;
  let remoteHandoffReconcileResult: RemoteHandoffReconcileResult | null = null;
  let remoteHandoff: DaemonTick['remoteHandoff'] | undefined;
  const runRemoteHandoffReconciliation = (): RemoteHandoffReconcileResult | null => {
    if (opts.dryRun || stopRequested() || remoteHandoffReconcileResult !== null) return remoteHandoffReconcileResult;
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
  const blockedRepairRootKeys = new Set<string>();
  const ambiguousRepairReservationKeys = new Set<string>();
  const rootlessRepairKeys = new Set<string>();
  const depthRejectedRepairKeys = new Set<string>();
  let repairHandoffControlAvailable = true;
  let diagnosticResliceParentsResolved = 0;
  let diagnosticResliceParentsMissing = 0;
  const filterGeneratedRepairDispatch = (items: WorkItem[]): WorkItem[] => {
    const winnersByRoot = new Map<string, WorkItem>();
    for (const item of items) {
      if (!item.tags.includes('proposal-repair')) {
        continue;
      }
      const reservationPath = generatedRepairReservationPath(item);
      const initialReservationState = reservationPath
        ? reservationPathState(reservationPath)
        : 'missing';
      if (initialReservationState !== 'missing') {
        const reservation = opts.dryRun
          ? 'blocked'
          : reconcileGeneratedRepairReservationForItem(item);
        if (reservation === 'failure-cleared') {
          continue;
        }
        if (reservation === 'blocked') {
          const blockedRoot = generatedRepairRootKey(item);
          if (blockedRoot) {
            ambiguousRepairReservationKeys.add(blockedRoot);
            blockedRepairRootKeys.add(blockedRoot);
          }
          continue;
        }
      }
      if (repairTreatmentWitnessPersistenceFailed) {
        continue;
      }
      let coverageKey: string;
      try { coverageKey = workItemCoverageKey(item); } catch { continue; }
      if (!SHA256_RE.test(item.repairRootId ?? '')) {
        rootlessRepairKeys.add(coverageKey);
        continue;
      }
      if (item.repairDepth !== 0 && item.repairDepth !== 1) {
        depthRejectedRepairKeys.add(coverageKey);
        continue;
      }
      const rootKey = generatedRepairRootKey(item);
      if (!rootKey) {
        rootlessRepairKeys.add(coverageKey);
        continue;
      }
      try {
        const markerPath = generatedRepairReservationPath(item);
        const reservation = opts.dryRun && markerPath && reservationPathState(markerPath) !== 'missing'
          ? 'blocked'
          : reconcileGeneratedRepairReservationForItem(item);
        if (reservation === 'failure-cleared') {
          continue;
        }
        if (reservation === 'blocked') {
          ambiguousRepairReservationKeys.add(rootKey);
          blockedRepairRootKeys.add(rootKey);
          winnersByRoot.delete(rootKey);
          continue;
        }
        if (blockedRepairRootKeys.has(rootKey) || blockedRepairKeys.has(coverageKey)) continue;
        if (!generatedRepairDispatchEnabled || !repairHandoffControlAvailable) continue;
        const dispatchState = generatedRepairDispatchState(item);
        if (!dispatchState.dispatchable && !(
          dispatchState.state === 'lifecycle-unavailable' && generatedRepairReceiptFreshAuthority(item)
        )) continue;
        const current = winnersByRoot.get(rootKey);
        if (!current || item.repairDepth > current.repairDepth! || (
          item.repairDepth === current.repairDepth && Date.parse(item.ts) > Date.parse(current.ts)
        )) winnersByRoot.set(rootKey, item);
      } catch {
        blockedRepairRootKeys.add(rootKey);
        winnersByRoot.delete(rootKey);
      }
    }
    const winners = new Set(winnersByRoot.values());
    return items.filter((item) => !item.tags.includes('proposal-repair') || winners.has(item));
  };
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
          ...(proposalRepairMaintenanceResult.dispatchRepairQuarantined !== undefined
            ? { dispatchRepairQuarantined: proposalRepairMaintenanceResult.dispatchRepairQuarantined }
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
          repairRootAdmissionConsidered: Math.min(10_000, proposalRepairMaintenanceResult.repairRootAdmissionConsidered ?? 0),
          repairRootAdmissionAdmitted: Math.min(10_000, proposalRepairMaintenanceResult.repairRootAdmissionAdmitted ?? 0),
          repairRootAdmissionAlreadyActive: Math.min(10_000, proposalRepairMaintenanceResult.repairRootAdmissionAlreadyActive ?? 0),
          repairRootAdmissionRootless: Math.min(
            10_000,
            (proposalRepairMaintenanceResult.repairRootAdmissionRootless ?? 0) + rootlessRepairKeys.size,
          ),
          repairRootAdmissionDepthRejected: Math.min(
            10_000,
            (proposalRepairMaintenanceResult.repairRootAdmissionDepthRejected ?? 0) + depthRejectedRepairKeys.size,
          ),
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
          ...(proposalRepairMaintenanceResult.handoffAuthorityDigest !== undefined
            ? { repairHandoffAuthorityDigest: proposalRepairMaintenanceResult.handoffAuthorityDigest }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffActivationId !== undefined
            ? { repairHandoffActivationId: proposalRepairMaintenanceResult.handoffActivationId }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffActivatedAt !== undefined
            ? { repairHandoffActivatedAt: proposalRepairMaintenanceResult.handoffActivatedAt }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffActivationAuthorities !== undefined
            ? { repairHandoffActivationAuthorities: proposalRepairMaintenanceResult.handoffActivationAuthorities }
            : {}),
          ...(proposalRepairMaintenanceResult.handoffActivationAuthorityDigest !== undefined
            ? { repairHandoffActivationAuthorityDigest: proposalRepairMaintenanceResult.handoffActivationAuthorityDigest }
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
          ...(proposalRepairMaintenanceResult.dispatchSourceState !== undefined
            ? {
                dispatchRepairSourceState: proposalRepairMaintenanceResult.dispatchSourceState,
                dispatchRepairSourceComplete: proposalRepairMaintenanceResult.dispatchSourceComplete,
                dispatchRepairSourceInvalidRows: proposalRepairMaintenanceResult.dispatchSourceInvalidRows,
                dispatchRepairSourceUnreadableFiles: proposalRepairMaintenanceResult.dispatchSourceUnreadableFiles,
                dispatchRepairSourceStopReasons: proposalRepairMaintenanceResult.dispatchSourceStopReasons?.slice(0, 5),
              }
            : {}),
        }
        : {}),
      ...(producerMaintenanceSkippedByCadence ? { skippedByCadence: true } : {}),
      ...(producerMaintenanceNextAfter ? { nextAfter: producerMaintenanceNextAfter } : {}),
      ...(ambiguousRepairReservationKeys.size > 0 ? {
        repairAttemptReservationState: 'blocked-ambiguous',
        repairAttemptReservationsBlocked: ambiguousRepairReservationKeys.size,
      } : {}),
      diagnosticResliceParentsResolved,
      diagnosticResliceParentsMissing,
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
    if (opts.dryRun || stopRequested() || selfHealMaintenanceRan) return;
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
    if (opts.dryRun || stopRequested() || proposalRepairMaintenanceRan) return proposalRepairMaintenanceResult;
    if ((liveCfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'] === false) return null;
    proposalRepairMaintenanceRan = true;
    try {
      proposalRepairMaintenanceResult = queueProposalRepairWorkForPendingProposals(
        undefined,
        new Date(now),
        { terminalLifecycleEnabled: liveCfg.fleet?.sharedQueue?.mode !== 'filesystem' },
      );
      const activationRaw = (liveCfg.foundry as Record<string, unknown> | undefined)?.['repairHandoffV2Activation'];
      if (validRepairHandoffV2Activation(activationRaw)) {
        const activationSummary = readRepairHandoffSchemaSummary(activationRaw);
        proposalRepairMaintenanceResult.handoffActivationId = activationRaw.id;
        proposalRepairMaintenanceResult.handoffActivatedAt = activationRaw.activatedAt;
        proposalRepairMaintenanceResult.handoffActivationAuthorities = activationSummary.currentActivationV2Authorities;
        if (activationSummary.currentActivationAuthorityDigest) {
          proposalRepairMaintenanceResult.handoffActivationAuthorityDigest = activationSummary.currentActivationAuthorityDigest;
        }
      }
      return proposalRepairMaintenanceResult;
    } catch (err) {
      proposalRepairMaintenanceResult = {
        scanned: 0,
        eligible: 0,
        queued: 0,
        failed: 1,
        proposalInboxAvailable: false,
        handoffSourceState: 'degraded',
        dispatchSourceState: 'degraded',
        dispatchSourceComplete: false,
        dispatchSourceInvalidRows: 0,
        dispatchSourceUnreadableFiles: 1,
        dispatchSourceStopReasons: ['io-error'],
      };
      console.warn('[ashlr] daemon:tick proposal repair queue failed:', (err as Error)?.message ?? err);
      return proposalRepairMaintenanceResult;
    }
  };
  const runInventMaintenance = async (): Promise<boolean> => {
    if (opts.dryRun || stopRequested() || inventMaintenanceRan || skipInventAfterSelfHealRefill) return false;
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
    if (opts.dryRun || stopRequested() || ancillaryMaintenanceRan) return;
    ancillaryMaintenanceRan = true;

    // M187: Counterfactual replay — low-cadence judge calibration.
    if (
      !stopRequested() &&
      (liveCfg.foundry as Record<string, unknown>)?.counterfactual === true &&
      state.ticks.length % 20 === 0
    ) {
      try { await runCounterfactualReplay(liveCfg); } catch (err) { console.warn('[ashlr] daemon:tick runCounterfactualReplay failed:', (err as Error)?.message ?? err); }
    }

    // Outcome findings remain signed observation-only evidence. They are not
    // allowed to rewrite judge labels or skill lifecycle state while cohort
    // enumeration is incomplete.
    if (!stopRequested() && (liveCfg.foundry as Record<string, unknown>)?.['outcomeWatcher'] !== false) {
      try {
        const { scanRealWorldOutcomes } = await import('../fleet/outcome-watcher.js');
        await scanRealWorldOutcomes(liveCfg, { enrolledRepos: enrolled });
      } catch (err) {
        console.warn('[ashlr] daemon:tick outcomeWatcher failed:', (err as Error)?.message ?? err);
      }
    }

    // M189: Regression sentinel — detect regressions introduced by auto-merge and bisect/revert.
    const regressionSentinel = (liveCfg.foundry as Record<string, unknown>)?.regressionSentinel;
    if (!stopRequested() &&
      (regressionSentinel === true || (typeof regressionSentinel === 'object' && regressionSentinel !== null))) {
      let attemptedCursor: ReturnType<typeof buildMonitoringCursor> = null;
      let attemptedExpectedCursor: ReturnType<typeof buildMonitoringCursor> = null;
      let attemptedRepo: string | undefined;
      let attemptedStabilityCandidatesAfter: NonNullable<ReturnType<typeof buildMonitoringCursor>>['stabilityCandidatesAfter'];
      let enrollmentRepos: string[] = [];
      let regressionAuthority: ReturnType<typeof acquireOutwardMutationFence> = null;
      try {
        const retainedAuthority = acquireOutwardMutationFence();
        regressionAuthority = retainedAuthority;
        if (retainedAuthority === null || !ownsOutwardMutationFence(retainedAuthority) || stopRequested()) {
          throw new Error('regression sentinel outward mutation authority unavailable');
        }
        enrollmentRepos = [...enrolled].sort();
        const availableRepos = enrollmentRepos;
        const cursorRead = loadMonitoringCursor(enrollmentRepos);
        if (cursorRead.sourceState === 'degraded') {
          throw new Error('monitoring cursor is degraded');
        }
        const cursor = cursorRead.cursor ?? buildMonitoringCursor(enrollmentRepos);
        const monitoredRepo = cursor
          ? selectRegressionRepoSuccessors(availableRepos, cursor.regressionRepoAfter, 1).selected[0]
          : undefined;
        if (!cursor || !monitoredRepo) return;
        attemptedCursor = cursor;
        attemptedExpectedCursor = cursorRead.storedCursor;
        attemptedRepo = monitoredRepo;
        attemptedStabilityCandidatesAfter = cursor.stabilityCandidatesAfter;
        const r = await detectRegression(liveCfg, monitoredRepo, { authority: retainedAuthority });
        if (stopRequested() || !ownsOutwardMutationFence(regressionAuthority)) {
          throw new Error('regression sentinel stopped after verification');
        }
        if (r.greenObservation) {
          const repoDigest = monitoringRepoDigest(monitoredRepo);
          const priorCandidate = cursor.stabilityCandidatesAfter?.find((entry) => entry.repoDigest === repoDigest)?.candidateAfter;
          const observation = observePostMergeStability({
            repo: monitoredRepo,
            enrolledRepos: enrollmentRepos,
            greenObservation: r.greenObservation,
            ...(priorCandidate ? { candidateAfter: priorCandidate } : {}),
          });
          if (repoDigest && observation.candidateAfter) {
            attemptedStabilityCandidatesAfter = [
              ...(cursor.stabilityCandidatesAfter ?? []).filter((entry) => entry.repoDigest !== repoDigest),
              { repoDigest, candidateAfter: observation.candidateAfter },
            ].sort((left, right) => left.repoDigest.localeCompare(right.repoDigest));
          }
        }
        if (r.regressed && !stopRequested()) {
          const bisect = await bisectAndRevert(liveCfg, monitoredRepo, { authority: retainedAuthority });
          if (stopRequested() || !ownsOutwardMutationFence(regressionAuthority)) {
            throw new Error('regression sentinel stopped after bisect');
          }
          const culpritProposalId = bisect.revertProposal?.culpritProposalId;
          const gitOid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
          if (
            culpritProposalId && bisect.culprit && bisect.observedHead &&
            gitOid.test(bisect.culprit) && gitOid.test(bisect.observedHead)
          ) {
            const [{ loadProposal }, { recordPostMergeObservation }] = await Promise.all([
              import('../inbox/store.js'),
              import('../fleet/post-merge-observations.js'),
            ]);
            if (stopRequested() || !ownsOutwardMutationFence(regressionAuthority)) {
              throw new Error('regression sentinel stopped before observation persistence');
            }
            const culpritProposal = loadProposal(culpritProposalId);
            const realizedMerge = authenticatedRealizedMergeOf(culpritProposal);
            const deterministicIdentity = typeof culpritProposal?.repo === 'string' &&
              realizedMerge?.mergeCommitOid === bisect.culprit &&
              typeof bisect.repo === 'string' && resolve(culpritProposal.repo) === bisect.repo;
            if (culpritProposal?.repo) {
              recordPostMergeObservation({
                observedAt: new Date().toISOString(),
                outcome: 'regressed',
                basis: 'bisect-first-bad',
                confidence: deterministicIdentity && bisect.attributionConfidence === 'deterministic' &&
                  bisect.parentGreen === true && bisect.culpritRed === true
                  ? 'deterministic'
                  : 'heuristic',
                repo: culpritProposal.repo,
                proposalId: culpritProposalId,
                ...(culpritProposal.runId ? { runId: culpritProposal.runId } : {}),
                ...(culpritProposal.trajectoryId ? { trajectoryId: culpritProposal.trajectoryId } : {}),
                ...(culpritProposal.workItemId ? { workItemId: culpritProposal.workItemId } : {}),
                mergeCommit: bisect.culprit,
                observedHead: bisect.observedHead,
                ...((deterministicIdentity && bisect.attributionConfidence === 'deterministic'
                  ? bisect.parentHead
                  : bisect.baselineHead) &&
                gitOid.test((deterministicIdentity && bisect.attributionConfidence === 'deterministic'
                  ? bisect.parentHead
                  : bisect.baselineHead)!)
                  ? { baselineHead: (deterministicIdentity && bisect.attributionConfidence === 'deterministic'
                    ? bisect.parentHead
                    : bisect.baselineHead)! }
                  : {}),
                ...(bisect.candidateCount ? { candidateCount: bisect.candidateCount } : {}),
                ...(culpritProposal.verifyResult?.ran?.length
                  ? { commandKinds: [...new Set(culpritProposal.verifyResult.ran.map((command) => command.kind))].sort() }
                  : {}),
              });
            }
          }
          await Promise.allSettled([
            notifyFleetEvent('anomaly', {
              detail: bisect.culprit
                ? `Regression detected; isolated fleet merge ${bisect.culprit.slice(0, 12)} and proposed a revert`
                : 'Regression detected; no fleet merge culprit was isolated',
            }, liveCfg),
            import('../fleet/event-bus.js').then(({ emit }) =>
              emit('regression:detected', { signal: r.signal, repo: monitoredRepo }, liveCfg)),
          ]);
          if (stopRequested() || !ownsOutwardMutationFence(regressionAuthority)) {
            throw new Error('regression sentinel stopped after event handlers drained');
          }
        }
        const advancedCursor = {
          ...cursor,
          regressionRepoAfter: monitoredRepo,
          ...(attemptedStabilityCandidatesAfter !== undefined
            ? { stabilityCandidatesAfter: attemptedStabilityCandidatesAfter }
            : {}),
        };
        if (!saveMonitoringCursor(advancedCursor, {
          enrolledRepos: enrollmentRepos,
          expectedCursor: cursorRead.storedCursor,
        })) {
          throw new Error('failed to persist monitoring cursor advancement');
        }
      } catch (err) {
        if (
          !stopRequested() && ownsOutwardMutationFence(regressionAuthority) &&
          attemptedCursor && attemptedRepo
        ) {
          saveMonitoringCursor(
            {
              ...attemptedCursor,
              regressionRepoAfter: attemptedRepo,
              ...(attemptedStabilityCandidatesAfter !== undefined
                ? { stabilityCandidatesAfter: attemptedStabilityCandidatesAfter }
                : {}),
            },
            { enrolledRepos: enrollmentRepos, expectedCursor: attemptedExpectedCursor },
          );
        }
        console.warn('[ashlr] daemon:tick regressionSentinel failed:', (err as Error)?.message ?? err);
      } finally {
        releaseOutwardMutationFence(regressionAuthority);
      }
    }
  };
  const refreshBacklogForTick = async (): Promise<WorkItem[]> => {
    if (stopRequested()) return [];
    try {
      const backlog = await buildBacklog({ repos: enrolled });
      backlogSnapshotAt = backlog.generatedAt;
      backlogSnapshotId = backlog.snapshotId;
      const resolution = resolveDiagnosticResliceParents(backlog.items);
      diagnosticResliceParentsResolved = resolution.resolved;
      diagnosticResliceParentsMissing = resolution.missing;
      return filterGeneratedRepairDispatch(resolution.dispatchable);
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
  if (stopRequested()) {
    audit({
      action: 'daemon:tick',
      repo: null,
      sandboxId: null,
      summary: killSwitchOn() ? 'tick skipped: kill switch is ON' : 'tick skipped: shutdown requested',
      result: 'ok',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: killSwitchOn() ? 'kill-switch' : 'shutdown-requested',
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
  if (!stillOwnsTick()) {
    return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
  }
  const initialSave = saveTickState(state);
  if (!initialSave.ok) {
    return persistenceRefusal(`tick refused: failed to persist daemon state before dispatch (${initialSave.error})`, 'error');
  }

  const remainingBudget = dcfg.dailyBudgetUsd - state.todaySpentUsd;
  if (remainingBudget <= 0) {
    if (!stillOwnsTick()) {
      return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
    }
    saveTickState(state);
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
  const enrollmentReadiness = recoverEnrollmentRegistry();
  if (enrollmentReadiness.state === 'degraded') {
    return persistenceRefusal(
      `tick refused: enrollment registry degraded (${enrollmentReadiness.reason})`,
      'error',
    );
  }
  const canonicalEnrollment = exactCanonicalEnrolledRepos(enrollmentReadiness.repos);
  if (canonicalEnrollment.missingExact) {
    return persistenceRefusal(
      'tick refused: canonical enrolled repository is temporarily unavailable',
      'error',
    );
  }
  const enrolled = canonicalEnrollment.repos;
  if (enrolled.length === 0) {
    if (!stillOwnsTick()) {
      return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
    }
    saveTickState(state);
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
    if (!stillOwnsTick()) {
      return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
    }
    if (directionPlan.mode !== 'pause') {
      runRemoteHandoffReconciliation();
      remoteHandoff = remoteHandoffTickSummary(remoteHandoffReconcileResult);
    }

    if (!directionPlan.allowDispatch) {
      const autoMergePassResult = await runAutoMergeMaintenancePass();
      const autoMerge = autoMergeTickSummary(autoMergePassResult);
      const merged = autoMergePassResult?.merged ?? 0;
      if (!stillOwnsTick()) {
        return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
      }
      saveTickState(state);
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
  for (const key of proposalRepairResult?.blockedRootKeys ?? []) blockedRepairRootKeys.add(key);
  if (
    proposalRepairResult?.handoffSourceState === 'degraded' ||
    proposalRepairResult?.proposalInboxAvailable === false ||
    proposalRepairResult?.dispatchSourceState === 'degraded' ||
    proposalRepairResult?.dispatchSourceComplete === false
  ) repairHandoffControlAvailable = false;
  if (proposalRepairResult?.handoffSourceState === 'degraded') {
    proposalDuplicateAuthorityUnavailable = true;
  }
  if (
    proposalRepairResult?.proposalInboxAvailable === false ||
    proposalRepairResult?.dispatchSourceState === 'degraded' ||
    proposalRepairResult?.dispatchSourceComplete === false
  ) {
    proposalDuplicateAuthorityUnavailable = true;
  }
  if (proposalDuplicateAuthorityUnavailable) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: 'proposal or dispatch duplicate-suppression authority is degraded; refusing selection',
      result: 'refused',
    });
    return recordTick({
      ts: now,
      itemsConsidered: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      reason: 'state-persistence-failed',
      ...(producerMaintenanceSummary() ? { producerMaintenance: producerMaintenanceSummary() } : {}),
    });
  }
  backlogItems = filterGeneratedRepairDispatch(backlogItems);
  if (!stillOwnsTick()) {
    return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
  }

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
      if (!stillOwnsTick()) {
        return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
      }
      saveTickState(state);
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

      if (!stillOwnsTick()) {
        return ownershipLostTick({ ts: now, itemsConsidered: 0, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
      }
      saveTickState(state);
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
  if (!opts.dryRun && routingCfg.foundry?.fabric?.concurrentDispatch === true) {
    selectionResourceSnapshot = await getResourceSnapshot(routingCfg).catch(() => null);
    if (
      selectionResourceSnapshot &&
      productionVelocity.enabled &&
      productionVelocity.fillQueueToSlots
    ) {
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
          (_itemId, outcome, _ts, proposalGenerationId, item) => {
            // A repository-qualified backlog match is required before feedback
            // can become a cooldown. Missing or ambiguous historical proposal
            // identity must not suppress an equal-id item in another repo.
            if (!item) return;
            const currentGenerationId = generatedRepairGenerationId(item);
            if (currentGenerationId !== null) {
              if (!generatedRepairGenerationIds(item).includes(proposalGenerationId ?? '')) return;
              coordinator.recordOutcome(generatedRepairCooldownKey(item), outcome, machineId);
              return;
            }
            // A generation-bearing proposal with no exact current authority is
            // stale feedback; never project it onto a new objective by child ID.
            if (proposalGenerationId !== undefined) return;
            coordinator.recordOutcome(generatedRepairCooldownKey(item), outcome, machineId);
          },
        );
      }
    } catch (err) {
      // Best-effort — sweep must never crash selection.
      console.warn('[ashlr] daemon:tick sweepJudgedProposals failed:', (err as Error)?.message ?? err);
    }
  }
  const selectionWorkedEvents = coordinator.readWorkedEvents();

  // Build a set of repo+item keys that already have an open PENDING proposal
  // so we can skip duplicating work. New proposals use workItemId as the source
  // of truth; legacy proposals without it fall back to exact item-id text
  // matching. Never throws.
  let pendingItemKeys = new Set<string>();
  try {
    const proposalRead = listProposalsDetailed({ status: 'pending', requireComplete: true });
    if (!proposalRead.complete || proposalRead.sourceState === 'degraded') {
      proposalDuplicateAuthorityUnavailable = true;
      for (const item of backlogItems) pendingItemKeys.add(workItemCoverageKey(item));
      console.warn('[ashlr] daemon:tick proposal duplicate authority unavailable');
    }
    const blockingPendingProposals = blockingPendingProposalsForBacklog(
      proposalRead.proposals,
      routingCfg,
    );
    if (proposalRead.complete && proposalRead.sourceState !== 'degraded') {
      pendingItemKeys = pendingProposalItemKeysForBacklog(backlogItems, blockingPendingProposals);
    }
    for (const item of backlogItems) {
      if (!isTrustedDiagnosticResliceItem(item)) continue;
      const key = workItemCoverageKey(item);
      const authorities = proposalRead.proposals
        .map((proposal) => generatedRepairProposalDispatchAuthority(item, proposal))
        .filter((authority) => authority !== 'not-applicable');
      if (authorities.some((authority) => authority === 'unavailable')) {
        pendingItemKeys.add(key);
        const rootKey = generatedRepairRootKey(item);
        if (rootKey) blockedRepairRootKeys.add(rootKey);
      }
      if (authorities.some((authority) => authority === 'proven')) {
        pendingItemKeys.add(key);
      }
    }
  } catch (err) {
    proposalDuplicateAuthorityUnavailable = true;
    for (const item of backlogItems) {
      try { pendingItemKeys.add(workItemCoverageKey(item)); } catch { /* invalid items are blocked elsewhere */ }
    }
    console.warn('[ashlr] daemon:tick inbox pendingItemIds read failed:', (err as Error)?.message ?? err);
  }
  if (proposalDuplicateAuthorityUnavailable) {
    return persistenceRefusal(
      'tick refused before selection: proposal duplicate authority could not be established',
    );
  }

  const repairRecoveryHealthy = generatedRepairRecoveryHealthy(liveCfg);
  const claimKeyForItem = (item: WorkItem): string =>
    workItemExecutionKey(item) ?? workItemCoverageKey(item);
  const claimCooldownPolicies = new Map<string, QueueClaimCooldownPolicy>(
    backlogItems.map((item) => [
      claimKeyForItem(item),
      claimCooldownPolicyForSelectionItem(item, cooldownMs, repairRecoveryHealthy),
    ]),
  );
  const frozenWorkedItemId = (item: WorkItem): string =>
    claimCooldownPolicies.get(claimKeyForItem(item))?.itemIds[0] ?? workItemCoverageKey(item);
  const captureGateStateByItemKey = new Map<string, ReturnType<typeof captureGateDispatchState>>();
  for (const [item, state] of captureGateDispatchStates(backlogItems)) {
    try { captureGateStateByItemKey.set(workItemCoverageKey(item), state); } catch { /* invalid items fail open here */ }
  }
  const captureGateParentTerminal = (item: WorkItem): boolean => {
    if (isTrustedGeneratedRepairItem(item)) return false;
    let key: string;
    try { key = workItemCoverageKey(item); } catch { return false; }
    const state = captureGateStateByItemKey.get(key) ?? captureGateDispatchState(item);
    captureGateStateByItemKey.set(key, state);
    return state.state === 'terminal';
  };
  const isSelectionBlocked = (item: WorkItem): boolean =>
    generatedRepairShouldSkip(selectionWorkedEvents, claimCooldownPolicies.get(claimKeyForItem(item))!) ||
    pendingItemKeys.has(workItemCoverageKey(item)) ||
    captureGateParentTerminal(item);
  const claimRepairQueue = (() => {
    try {
      return readGeneratedRepairQueueSnapshot();
    } catch {
      return null;
    }
  })();
  const claimRouteEvaluations = new Map<WorkItem, GeneratedRepairRouteEvaluation>();
  const claimRouteUnavailableIds = new Set<string>();
  const hasFeasibleClaimRoute = (item: WorkItem): boolean => {
    if (!isTrustedGeneratedRepairItem(item)) return true;
    const cached = claimRouteEvaluations.get(item);
    if (cached !== undefined) return cached.feasibility.feasible;
    const fallbackPolicy = effectiveGeneratedRepairRetryPolicy(item);
    let feasibility: GeneratedRepairRouteFeasibility = {
      feasible: false,
      requiredTier: fallbackPolicy.requiredTier ?? null,
      requiresAlternative: fallbackPolicy.requireAlternative,
      backend: null,
      reason: 'inspection-unavailable',
    };
    try {
      if (claimRepairQueue !== null) {
        feasibility = inspectGeneratedRepairRouteFeasibility(
          item,
          routingCfg,
          effectiveGeneratedRepairRetryPolicy(item),
        );
      }
    } catch {
      // Keep the categorical inspection-unavailable snapshot above.
    }
    claimRouteEvaluations.set(item, {
      ...(!feasibility.feasible
        ? { attemptId: preclaimRouteAttemptId(item.id, feasibility.reason) }
        : {}),
      feasibility,
    });
    if (!feasibility.feasible) claimRouteUnavailableIds.add(workItemCoverageKey(item));
    return feasibility.feasible;
  };
  const isClaimEligible = (item: WorkItem): boolean =>
    !isSelectionBlocked(item) && hasFeasibleClaimRoute(item);

  const explicitDrainMode = opts.drain;
  const canAutoDrain = explicitDrainMode === undefined && canAutoDrainRepairs(opts, directionPlan);
  // Capture failures are the production-yield recovery lane. Prefer them to
  // diagnostic reslices, but retain the existing single-lane cap and ordinary
  // work fairness below so recovery cannot consume all available capacity.
  const autoDrainMode: DaemonDrainMode | undefined = canAutoDrain &&
    backlogItems.some((item) => isDrainCandidate(item, 'capture-repairs'))
    ? 'capture-repairs'
    : canAutoDrain && backlogItems.some((item) => isDrainCandidate(item, 'diagnostic-reslices'))
      ? 'diagnostic-reslices'
      : undefined;
  const autoDrainAvailableItems = autoDrainMode
    ? backlogItems.filter((item) => isDrainCandidate(item, autoDrainMode))
    : [];
  const autoDrainEligibleItems = autoDrainAvailableItems.filter(isClaimEligible);
  const diagnosticRoute = (item: WorkItem): { backend: EngineId; tier: EngineTier | null } => {
    const routed = routeBackend(item, routingCfg);
    let backend = enforceLocalBackend(routed.backend, directionPlan);
    const retryPolicy = effectiveGeneratedRepairRetryPolicy(item);
    if (retryPolicy.available && retryPolicy.requireAlternative &&
      retryPolicy.excludedBackend !== null && backend === retryPolicy.excludedBackend) {
      backend = generatedRepairAlternateBackend(item, retryPolicy.excludedBackend, routingCfg) ?? backend;
    }
    return { backend, tier: engineTierOf(backend, routingCfg) };
  };
  const serialDispatchableRepairs = autoDrainEligibleItems.filter((item) => {
    const route = diagnosticRoute(item);
    return route.tier === item.repairParentTier &&
      effectiveGeneratedRepairCandidateAllowed(item, route.backend, routingCfg) &&
      (route.backend === 'builtin' || withinLimit(route.backend, routingCfg));
  });
  const concurrentDispatchEnabled = routingCfg.foundry?.fabric?.concurrentDispatch === true;
  const autoDrainDispatchableItems = concurrentDispatchEnabled
    ? selectionResourceSnapshot
      ? planConcurrentDispatch(
          autoDrainEligibleItems,
          selectionResourceSnapshot,
          { maxSlotsPerBackend: productionVelocity.maxSlotsPerBackend },
          (item) => diagnosticRoute(item).backend,
          (item, backend) => effectiveGeneratedRepairCandidateAllowed(item, backend, routingCfg) &&
            (backend === 'builtin' || withinLimit(backend, routingCfg)),
          (backend) => engineTierOf(backend, routingCfg),
        ).assignments.map((assignment) => assignment.item)
      : []
    : serialDispatchableRepairs;
  const autoDrainDispatchableIds = new Set(autoDrainDispatchableItems.map(workItemCoverageKey));
  const dispatchPreflightByItemId = new Map<string, DispatchPreflightState>();
  for (const item of autoDrainAvailableItems) {
    if (isSelectionBlocked(item)) continue;
    dispatchPreflightByItemId.set(
      workItemCoverageKey(item),
      claimRouteUnavailableIds.has(workItemCoverageKey(item))
        ? 'route-unavailable'
        : autoDrainDispatchableIds.has(workItemCoverageKey(item))
        ? 'dispatchable'
        : concurrentDispatchEnabled
          ? selectionResourceSnapshot
            ? 'capacity-or-route-unavailable'
            : 'resource-snapshot-unavailable'
          : 'route-unavailable',
    );
  }
  const drainMode = explicitDrainMode ?? (autoDrainDispatchableItems.length > 0 ? autoDrainMode : undefined);
  const automaticDrain = explicitDrainMode === undefined && drainMode !== undefined;
  const claimRouteCandidateItems = explicitDrainMode && drainMode
    ? backlogItems.filter((item) => isDrainCandidate(item, drainMode))
    : backlogItems;
  for (const item of claimRouteCandidateItems) {
    if (isTrustedGeneratedRepairItem(item) && !isSelectionBlocked(item)) hasFeasibleClaimRoute(item);
  }
  for (const item of claimRouteCandidateItems) {
    if (
      claimRouteUnavailableIds.has(workItemCoverageKey(item)) &&
      !dispatchPreflightByItemId.has(workItemCoverageKey(item))
    ) dispatchPreflightByItemId.set(workItemCoverageKey(item), 'route-unavailable');
  }
  const dispatchBlockedRepairIds = new Set([
    ...autoDrainEligibleItems
      .filter((item) => !autoDrainDispatchableIds.has(workItemCoverageKey(item)))
      .map(workItemCoverageKey),
    ...claimRouteUnavailableIds,
  ]);
  const drainAvailableItems = drainMode
    ? automaticDrain
      ? autoDrainDispatchableItems
      : backlogItems.filter((item) => isDrainCandidate(item, drainMode))
    : [];
  const ordinarySelectionItems = dispatchBlockedRepairIds.size > 0
    ? backlogItems.filter((item) => !dispatchBlockedRepairIds.has(workItemCoverageKey(item)))
    : backlogItems;
  const automaticOrdinarySelectionItems = automaticDrain && drainMode
    ? ordinarySelectionItems.filter((item) => !isDrainCandidate(item, drainMode))
    : [];
  const automaticOrdinaryEligibleItems = automaticOrdinarySelectionItems.filter(
    isClaimEligible,
  );
  const selectionItems = automaticDrain
    ? [...drainAvailableItems, ...automaticOrdinarySelectionItems]
    : drainMode
      ? drainAvailableItems
      : ordinarySelectionItems;
  const selectionTelemetryItems = automaticDrain && drainMode
    ? [
        ...autoDrainAvailableItems,
        ...backlogItems.filter((item) => !isDrainCandidate(item, drainMode)),
      ]
    : drainMode
      ? backlogItems.filter((item) => isDrainCandidate(item, drainMode))
      : backlogItems;
  const rawSelectCount = daemonQueueSelectionLimit({
    perTickItems: dcfg.perTickItems,
    remainingBudgetUsd: remainingBudget,
    backlogItems: selectionItems.length,
    fillQueueToSlots: productionVelocity.fillQueueToSlots,
    availableSlots: availableSlotsForSelection,
    minPerItemUsd: MIN_PER_ITEM_USD,
  });
  const drainLimit = resolveDrainLimit(liveCfg, drainMode, opts.drainLimit);
  const selectCount = !automaticDrain && typeof drainLimit === 'number'
    ? Math.min(rawSelectCount, drainLimit)
    : rawSelectCount;
  const summarizeSelectionBlockers = (items: WorkItem[]) => {
    let eligibleItems = 0;
    let pendingBlocked = 0;
    let cooldownBlocked = 0;
    let routeBlocked = 0;
    let fastRepairCooldown = 0;
    for (const item of items) {
      const pending = pendingItemKeys.has(workItemCoverageKey(item));
      const itemPolicy = claimCooldownPolicies.get(claimKeyForItem(item))!;
      const itemCooldownMs = cooldownMsForSelectionItem(selectionWorkedEvents, itemPolicy);
      const cooling = generatedRepairShouldSkip(selectionWorkedEvents, itemPolicy);
      if (pending) pendingBlocked++;
      if (cooling) cooldownBlocked++;
      const routeUnavailable = !pending && !cooling && !hasFeasibleClaimRoute(item);
      if (routeUnavailable) routeBlocked++;
      if (!pending && !cooling && !routeUnavailable) eligibleItems++;
      if (
        repairRecoveryHealthy &&
        itemCooldownMs < cooldownMs &&
        isTrustedGeneratedRepairItem(item)
      ) {
        fastRepairCooldown++;
      }
    }
    return { eligibleItems, pendingBlocked, cooldownBlocked, routeBlocked, fastRepairCooldown };
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
          if (isClaimEligible(candidate)) break;
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

  const normalOrdinaryEligibleItems = selectionItems.filter((item) =>
    !isTrustedGeneratedRepairItem(item) && isClaimEligible(item));
  const normalGeneratedEligibleItems = selectionItems.filter((item) =>
    isTrustedGeneratedRepairItem(item) && isClaimEligible(item));
  const normalRepairFairness = !automaticDrain && explicitDrainMode === undefined && selectCount > 1 &&
    normalOrdinaryEligibleItems.length > 0 && normalGeneratedEligibleItems.length > 0;

  let selected: WorkItem[];
  let automaticDrainOrdinaryTurnDue = state.automaticDrainOrdinaryTurnDue === true;
  const singleSlotOrdinaryTurn = automaticDrain && selectCount === 1 &&
    automaticOrdinaryEligibleItems.length > 0 &&
    automaticDrainOrdinaryTurnDue;
  if (singleSlotOrdinaryTurn) {
    selected = selectRoundRobinCandidates(automaticOrdinaryEligibleItems, 1);
  } else if (automaticDrain && selectCount > 1 && automaticOrdinaryEligibleItems.length > 0) {
    const repairSlots = Math.min(
      selectCount - 1,
      typeof drainLimit === 'number' ? drainLimit : selectCount - 1,
    );
    const repairs = selectRoundRobinCandidates(drainAvailableItems, repairSlots);
    const ordinary = selectRoundRobinCandidates(
      automaticOrdinaryEligibleItems,
      selectCount - repairs.length,
    );
    selected = [
      ...repairs,
      ...ordinary,
    ];
  } else {
    const automaticRepairCount = automaticDrain && typeof drainLimit === 'number'
      ? Math.min(selectCount, drainLimit)
      : selectCount;
    selected = selectRoundRobinCandidates(selectionItems, automaticRepairCount);
  }
  // Generated proposal repairs are not ordinary work merely because they are
  // outside the diagnostic-reslice drain. In a normal multi-slot tick, keep
  // one slot available for a real portfolio item so a deep repair backlog
  // cannot indefinitely prevent fresh goals/issues/todos from running.
  if (normalRepairFairness) {
    if (!selected.some((item) => !isTrustedGeneratedRepairItem(item))) {
      const ordinary = selectRoundRobinCandidates(normalOrdinaryEligibleItems, 1)[0];
      if (ordinary) selected = [...selected.slice(0, Math.max(0, selectCount - 1)), ordinary];
    }
  }
  const selectionTelemetryRawSelectCount = rawSelectCount;
  const selectionTelemetrySelectCount = selectCount;
  const selectionTelemetryDrainMode = drainMode;
  const selectionTelemetryAutomaticDrain = automaticDrain;

  const repairClaimLimit = automaticDrain
    ? singleSlotOrdinaryTurn
      ? 1
      : Math.min(
          selectCount,
          typeof drainLimit === 'number' ? drainLimit : selectCount,
          automaticOrdinaryEligibleItems.length > 0 && selectCount > 1 ? selectCount - 1 : selectCount,
        )
    : 0;
  const claimLanes = automaticDrain
    ? singleSlotOrdinaryTurn
      ? [
          {
            candidates: selectRoundRobinCandidates(
              automaticOrdinaryEligibleItems,
              automaticOrdinaryEligibleItems.length,
            ),
            limit: 1,
          },
          {
            candidates: selectRoundRobinCandidates(drainAvailableItems, drainAvailableItems.length),
            limit: 1,
          },
        ]
      : [
        ...(repairClaimLimit > 0
          ? [{ candidates: selectRoundRobinCandidates(drainAvailableItems, drainAvailableItems.length), limit: repairClaimLimit }]
          : []),
        ...(automaticOrdinaryEligibleItems.length > 0
          ? [{
            candidates: selectRoundRobinCandidates(
              automaticOrdinaryEligibleItems,
              automaticOrdinaryEligibleItems.length,
            ),
            limit: selectCount,
          }]
          : []),
      ]
    : normalRepairFairness
      ? [
          {
            candidates: selectRoundRobinCandidates(normalOrdinaryEligibleItems, normalOrdinaryEligibleItems.length),
            limit: 1,
          },
          {
            candidates: selectRoundRobinCandidates(selectionItems, selectionItems.length),
            limit: selectCount,
          },
        ]
      : [{
          candidates: selectRoundRobinCandidates(selectionItems, selectionItems.length),
          limit: selectCount,
        }];
  // One atomic claim preserves total capacity and per-lane quotas under
  // cross-machine contention. Cooldown evidence is re-read under the same lock
  // so a completion that raced selection cannot be immediately reclaimed.
  for (const item of claimLanes.flatMap((lane) => lane.candidates)) {
    const itemKey = claimKeyForItem(item);
    if (!claimCooldownPolicies.has(itemKey)) {
      claimCooldownPolicies.set(
        itemKey,
        claimCooldownPolicyForSelectionItem(item, cooldownMs, repairRecoveryHealthy),
      );
    }
  }
  const workedSet = coordinator.claimItemsByLane(
    claimLanes,
    selectCount,
    machineId,
    claimCooldownPolicies,
  );
  selected = workedSet;
  const drainSelectedItems = drainMode
    ? workedSet.filter((item) => isDrainCandidate(item, drainMode))
    : [];
  if (automaticDrain) {
    const claimedIds = new Set(workedSet.map(workItemCoverageKey));
    const claimedOrdinary = automaticOrdinaryEligibleItems.some((item) =>
      claimedIds.has(workItemCoverageKey(item)),
    );
    const claimedRepair = drainSelectedItems.length > 0;
    if (claimedOrdinary) {
      automaticDrainOrdinaryTurnDue = false;
    } else if (
      !automaticDrainOrdinaryTurnDue &&
      selectCount === 1 &&
      automaticOrdinaryEligibleItems.length > 0 &&
      claimedRepair
    ) {
      automaticDrainOrdinaryTurnDue = true;
    }
  }
  const selectionBlockers = summarizeSelectionBlockers(selectionTelemetryItems);
  if (!stillOwnsTick()) {
    return ownershipLostTick({ ts: now, itemsConsidered: selected.length, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
  }
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
    routeBlocked: selectionBlockers.routeBlocked,
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
    workedEvents: selectionWorkedEvents,
    baseCooldownMs: cooldownMs,
    repairRecoveryHealthy,
    cooldownPolicies: claimCooldownPolicies,
    dispatchPreflightByItemId,
    routeEvaluationByItem: claimRouteEvaluations,
  });
  const drain = drainMode
    ? drainSummary(
        drainMode,
        drainAvailableItems,
        drainSelectedItems,
        drainLimit,
        automaticDrain,
        singleSlotOrdinaryTurn && drainSelectedItems.length === 0,
      )
    : undefined;
  if (drainMode) {
    recordDrainSelectionAgentAction({
      ts: now,
      mode: drainMode,
      available: drainAvailableItems.length,
      selectedItems: drainSelectedItems,
      ...(typeof drainLimit === 'number' ? { limit: drainLimit } : {}),
      ...(drain?.capped ? { capped: true } : {}),
      ...(singleSlotOrdinaryTurn && drainSelectedItems.length === 0 ? { fairnessDeferred: true } : {}),
      machineId,
      dryRun: opts.dryRun,
      automatic: automaticDrain,
    });
  }

  // -------------------------------------------------------------------------
  // 6a. Dry-run mode: report what WOULD be worked; NO swarms, NO proposals.
  // -------------------------------------------------------------------------
  if (opts.dryRun) {
    if (!stillOwnsTick()) {
      return ownershipLostTick({ ts: now, itemsConsidered: workedSet.length, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
    }
    try {
      if (workedSet.length > 0) coordinator.release(workedSet, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick dry-run coordinator release failed:', (err as Error)?.message ?? err);
    }
    saveTickState(state);
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

  const workedSetIds = workedSet.map((i) => i.id);
  const leaseKey = (item: WorkItem): string => workItemCoverageKey(item);
  const leaseAbortControllers = new Map(
    workedSet.map((item) => [leaseKey(item), new AbortController()] as const),
  );
  let leaseRenewInterval: ReturnType<typeof setInterval> | null = null;
  const abortLostClaims = (renewedItems: WorkItem[]): void => {
    const renewed = new Set(renewedItems.map(leaseKey));
    for (const item of workedSet) {
      const key = leaseKey(item);
      if (renewed.has(key)) continue;
      const controller = leaseAbortControllers.get(key);
      if (controller && !controller.signal.aborted) {
        controller.abort(new Error(`shared queue claim authority lost for ${item.id}`));
      }
    }
  };
  const renewClaimLeases = (): WorkItem[] => {
    if (workedSetIds.length === 0 || !stillOwnsTick()) return [];
    try {
      const renewed = coordinator.fence(workedSet, machineId);
      abortLostClaims(renewed);
      return renewed;
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator fence failed:', (err as Error)?.message ?? err);
      abortLostClaims([]);
      return [];
    }
  };
  const startLeaseRenewer = (): WorkItem[] => {
    if (workedSetIds.length === 0) return [];
    const renewed = renewClaimLeases();
    const intervalMs = Math.max(1, Math.min(60_000, Math.floor(sharedQueueLeaseMs / 3)));
    leaseRenewInterval = setInterval(renewClaimLeases, intervalMs);
    (leaseRenewInterval as { unref?: () => void }).unref?.();
    return renewed;
  };
  const stopLeaseRenewer = (): void => {
    if (leaseRenewInterval) {
      clearInterval(leaseRenewInterval);
      leaseRenewInterval = null;
    }
  };
  const generatedRepairReservations = new Map<string, GeneratedRepairExecutionReservation>();
  const settledGeneratedRepairReservationItemIds = new Set<string>();
  const releaseGeneratedRepairReservations = (): void => {
    for (const reservation of generatedRepairReservations.values()) {
      for (const lock of [...reservation.locks].reverse()) releaseLocalStoreLock(lock);
    }
    generatedRepairReservations.clear();
  };
  const reserveGeneratedRepairExecution = (
    item: WorkItem,
    attemptId: string,
    backend: EngineId,
    tier: EngineTier | null,
  ): boolean => {
    if (!isTrustedGeneratedRepairItem(item)) return true;
    const itemKey = workItemCoverageKey(item);
    if (generatedRepairReservations.has(itemKey)) return false;
    if (readDispatchProductionAttemptProtocolQuality().status !== 'healthy') {
      return false;
    }
    const retryPolicy = effectiveGeneratedRepairRetryPolicy(item);
    if (!retryPolicy.available || !effectiveGeneratedRepairExecutionBackendAllowed(item, backend, routingCfg)) return false;
    const reservation = acquireGeneratedRepairExecutionReservation(
      item,
      attemptId,
      backend,
      tier,
      retryPolicy.requireAlternative ? 2 : 1,
      retryPolicy.requireAlternative ? retryPolicy.excludedBackend : null,
    );
    if (!reservation) return false;
    generatedRepairReservations.set(itemKey, reservation);
    return true;
  };
  const settleGeneratedRepairExecution = (item: WorkItem): boolean => {
    const itemKey = workItemCoverageKey(item);
    const reservation = generatedRepairReservations.get(itemKey);
    if (!reservation) return false;
    if (!clearGeneratedRepairExecutionReservation(reservation)) return false;
    settledGeneratedRepairReservationItemIds.add(itemKey);
    return true;
  };
  const markGeneratedRepairExecutionLaunched = (item: WorkItem): boolean => {
    if (!isTrustedGeneratedRepairItem(item)) return true;
    const reservation = generatedRepairReservations.get(workItemCoverageKey(item));
    if (!reservation || reservation.record.phase !== 'prepared') return false;
    const launched: GeneratedRepairExecutionReservationRecord = {
      ...reservation.record,
      phase: 'launched',
    };
    if (!writeGeneratedRepairReservationRecord(reservation.markerPath, launched)) return false;
    reservation.record = launched;
    return true;
  };
  try {
  const initiallyRenewed = startLeaseRenewer();
  if (workedSetIds.length > 0 && initiallyRenewed.length === 0) {
    try { coordinator.release(workedSet, machineId); } catch { /* exact release is best effort */ }
    return persistenceRefusal('tick refused: shared queue claim authority unavailable after selection');
  }

  // M170/M186/M187/M189 live maintenance cadence. Keep it outside the spend
  // guard so queued work discovery and regression watches do not extend an
  // in-flight accounting guard for selected dispatches.
  if (!producerMaintenanceBeforeSelection && shouldRunProducerMaintenance(state)) {
    await runSelfHealMaintenance();
    await runInventMaintenance();
    await runAncillaryMaintenance();
  }

  if (!stillOwnsTick()) {
    stopLeaseRenewer();
    try { coordinator.release(workedSet, machineId); } catch { /* exact release is best effort */ }
    return ownershipLostTick({ ts: now, itemsConsidered: workedSet.length, proposalsCreated: 0, spentUsd: 0, reason: 'shutdown-requested' });
  }

  const spendGuard = armDaemonSpendGuard(workedSetIds);
  if (!spendGuard.ok) {
    stopLeaseRenewer();
    try {
      if (workedSet.length > 0) coordinator.release(workedSet, machineId);
    } catch (err) {
      console.warn('[ashlr] daemon:tick coordinator release after spend-guard failure failed:', (err as Error)?.message ?? err);
    }
    return persistenceRefusal(`tick refused: failed to arm spend guard (${spendGuard.error})`);
  }

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

  const attemptIds = new Map(workedSet.map((item) => [leaseKey(item), createOuterAttemptIdentity()] as const));
  class QueueClaimAuthorityError extends Error {
    constructor(itemId: string) {
      super(`shared queue claim authority unavailable for ${itemId}`);
      this.name = 'QueueClaimAuthorityError';
    }
  }
  const authorityUnavailableOutcome = (item: WorkItem, attemptId: string): ItemOutcome => ({
    item,
    spentUsd: 0,
    dispatched: false,
    dispatch: dispatchTrace(item, {
      assignedBy: 'preflight',
      reason: 'rejected capture recovery authority was revoked or unavailable',
      dispatched: false,
      runId: attemptId,
      trajectoryId: `run:${attemptId}`,
      skipReason: 'repair-authority-unavailable',
    }),
  });
  const stopRequestedOutcome = (item: WorkItem, attemptId: string): ItemOutcome => {
    const killed = killSwitchOn();
    return {
      item,
      spentUsd: 0,
      dispatched: false,
      dispatch: dispatchTrace(item, {
        assignedBy: 'preflight',
        reason: killed ? 'kill switch is ON' : 'shutdown requested',
        dispatched: false,
        runId: attemptId,
        trajectoryId: `run:${attemptId}`,
        skipReason: killed ? 'kill-switch' : 'shutdown-requested',
      }),
    };
  };
  const queueLeaseLostOutcome = (item: WorkItem, attemptId: string): ItemOutcome => ({
    item,
    spentUsd: 0,
    dispatched: false,
    dispatch: dispatchTrace(item, {
      assignedBy: 'queue-lease',
      reason: 'shared queue claim generation is expired, superseded, or unavailable',
      dispatched: false,
      runId: attemptId,
      trajectoryId: `run:${attemptId}`,
      skipReason: 'queue-lease-lost',
    }),
  });
  const tasks: Array<{ tier: 'local' | 'cloud'; run: (assignedBackend?: EngineId, assignedReason?: string, assignedModel?: string | null) => Promise<ItemOutcome> }> = workedSet.map((item, _taskIdx) => {
    const attemptId = attemptIds.get(leaseKey(item))!;
    const leaseController = leaseAbortControllers.get(leaseKey(item))!;
    const dispatchSignal = opts.signal
      ? AbortSignal.any([opts.signal, leaseController.signal])
      : leaseController.signal;
    const beginQueueExecution = (): void => {
      if (dispatchSignal.aborted || !coordinator.beginExecution(item, machineId)) {
        if (!leaseController.signal.aborted) {
          leaseController.abort(new Error(`shared queue claim authority lost for ${item.id}`));
        }
        throw new QueueClaimAuthorityError(item.id);
      }
    };
    return ({
    tier: itemTiers[_taskIdx] ?? 'local',
    run: async (assignedBackend?: EngineId, assignedReason?: string, assignedModel?: string | null): Promise<ItemOutcome> => {
      // Re-check kill switch before each item dispatch.
      if (stopRequested()) return stopRequestedOutcome(item, attemptId);
      if (leaseController.signal.aborted) return queueLeaseLostOutcome(item, attemptId);
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
      if (!isRejectedCaptureRecoveryAuthorized(item)) {
        return {
          item,
          spentUsd: 0,
          dispatched: false,
          dispatch: dispatchTrace(item, {
            assignedBy: 'preflight',
            reason: 'rejected capture recovery authority was revoked or unavailable',
            dispatched: false,
            runId: attemptId,
            trajectoryId: `run:${attemptId}`,
            skipReason: 'repair-authority-unavailable',
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
      if (isTrustedGeneratedRepairItem(item)) {
        let retryPolicy = effectiveGeneratedRepairRetryPolicy(item);
        if (retryPolicy.available && retryPolicy.requireAlternative &&
          retryPolicy.excludedBackend !== null && backend === retryPolicy.excludedBackend) {
          const alternate = generatedRepairAlternateBackend(
            item,
            retryPolicy.excludedBackend,
            routingCfg,
          );
          if (alternate !== null) {
            backend = alternate;
            backendTier = engineTierOf(backend, routingCfg);
            selectedModel = configuredModelForBackend(backend, routingCfg);
            assignmentReason = `${assignmentReason}; repair retry routed to ${backend}`;
            assignedBy = 'repair-retry-router';
            retryPolicy = effectiveGeneratedRepairRetryPolicy(item);
          }
        }
        const requiredTier = retryPolicy.requiredTier ?? item.repairParentTier ?? null;
        const invalidRetryBackend = !effectiveGeneratedRepairExecutionBackendAllowed(item, backend, routingCfg);
        if (invalidRetryBackend) {
          const reason = !retryPolicy.available
            ? 'repair-lifecycle-unavailable: retry authority unavailable'
            : retryPolicy.requireAlternative && backend === retryPolicy.excludedBackend
              ? `repair-alternative-unavailable: refusing repeat dispatch to ${backend}; no open installed same-tier alternative is available`
              : requiredTier
                ? `repair-tier-unavailable: required ${requiredTier}, resolved ${backendTier ?? 'unknown'} via ${backend}`
                : 'repair-provenance-missing: durable parent tier unavailable';
          return {
            item,
            spentUsd: 0,
            dispatched: false,
            dispatch: dispatchTrace(item, {
              backend,
              tier: backendTier,
              model: selectedModel,
              assignedBy: retryPolicy.requireAlternative ? 'repair-retry-guard' : 'repair-tier-guard',
              reason,
              dispatched: false,
              runId: attemptId,
              trajectoryId: `run:${attemptId}`,
              skipReason: !retryPolicy.available
                ? 'repair-lifecycle-unavailable'
                : retryPolicy.requireAlternative && backend === retryPolicy.excludedBackend
                  ? 'repair-alternative-unavailable'
                  : requiredTier ? 'repair-tier-unavailable' : 'repair-provenance-missing',
            }),
          };
        }
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
      if (isTrustedGeneratedRepairItem(item) &&
        !reserveGeneratedRepairExecution(item, attemptId, backend, backendTier)) {
        return {
          item,
          spentUsd: 0,
          dispatched: false,
          dispatch: dispatchTrace(item, {
            backend,
            tier: backendTier,
            model: selectedModel,
            assignedBy: 'repair-attempt-reservation',
            reason: 'durable repair generation attempt reservation is unavailable or already active',
            dispatched: false,
            runId: attemptId,
            trajectoryId: `run:${attemptId}`,
            skipReason: 'repair-attempt-reservation-unavailable',
          }),
        };
      }
      const goal = buildItemGoal(item);
      const dispatchCfg = dispatchConfigForItem(item, routingCfg);
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

      if (backend === 'builtin') {
        if (stopRequested()) return stopRequestedOutcome(item, attemptId);
        const launch = beginRejectedCaptureRecoveryDispatch(item, () => {
          if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before swarm launch');
          beginQueueExecution();
          recordDispatchStartAgentAction(item, {
            ts: new Date().toISOString(), machineId, runId: attemptId, backend: backend!,
            tier: backendTier, model: selectedModel, assignedBy, reason: assignmentReason, mode: 'swarm',
          });
          if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before swarm producer start');
          if (!markGeneratedRepairExecutionLaunched(item)) {
            throw new Error('generated repair launch reservation could not be persisted');
          }
          return runSwarm(
            { goal }, dispatchCfg,
            {
              sandbox: true, requireSandbox: true, propose: true, project: item.repo,
              budget: itemBudget, parallel: 1, dryRun: false, noCapture: true,
              runId: attemptId, workItemId: item.id, workItemGenerationId,
              workSource: item.source, delegationScope,
              signal: dispatchSignal,
            },
            sink,
          );
        });
        if (!launch.authorized) return authorityUnavailableOutcome(item, attemptId);
        dispatched = true;
        backendDispatch[backend!] = (backendDispatch[backend!] ?? 0) + 1;
        const swarmRun = await launch.value;
        if (!stillOwnsTick()) {
          swarmSpent = swarmRun.usage?.estCostUsd ?? 0;
          tickSpent += swarmSpent;
          return {
            item,
            spentUsd: swarmSpent,
            dispatched: true,
            dispatch: dispatchTrace(item, {
              backend,
              tier: backendTier,
              model: selectedModel,
              assignedBy,
              reason: assignmentReason,
              dispatched: true,
              spentUsd: swarmSpent,
              runId: swarmRun.id,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'daemon-lock-lost',
              production: cancelledDispatchProduction(swarmRun.id, 'daemon lock ownership lost', swarmSpent),
            }),
          };
        }
        const effectiveSwarmOutcome = swarmRun.proposalOutcome;
        const swarmCancelled = effectiveSwarmOutcome === undefined &&
          swarmRun.status === 'aborted' &&
          dispatchSignal.aborted === true &&
          resultDescribesCancellation(swarmRun.result);
        const swarmFailed = effectiveSwarmOutcome === undefined &&
          (swarmRun.status === 'aborted' || swarmRun.status === 'failed');

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
          status: swarmCancelled ? 'aborted' : swarmRun.status,
          outcome: swarmCancelled
            ? 'cancelled'
            : swarmFailed
              ? 'engine-failed'
              : effectiveSwarmOutcome?.kind ?? swarmRun.status,
          proposalCreated: effectiveSwarmOutcome?.kind === 'filed',
          proposalId: effectiveSwarmOutcome?.proposalId,
          diffFiles: effectiveSwarmOutcome?.files,
          diffLines:
            typeof effectiveSwarmOutcome?.insertions === 'number' ||
            typeof effectiveSwarmOutcome?.deletions === 'number'
              ? (effectiveSwarmOutcome?.insertions ?? 0) + (effectiveSwarmOutcome?.deletions ?? 0)
              : undefined,
          tokensIn: swarmRun.usage?.tokensIn,
          tokensOut: swarmRun.usage?.tokensOut,
          costUsd: swarmRun.usage?.estCostUsd,
        });
        dispatchProduction = swarmCancelled
          ? cancelledDispatchProduction(
              swarmRun.id,
              'swarm cancelled by owner',
              swarmRun.usage?.estCostUsd ?? 0,
              swarmRunSummary,
            )
          : swarmFailed
            ? failedProducerDispatchProduction({
                runId: swarmRun.id,
                producer: 'swarm',
                status: swarmRun.status === 'failed' ? 'failed' : 'aborted',
                result: swarmRun.result,
                costUsd: swarmRun.usage?.estCostUsd ?? 0,
                summary: swarmRunSummary,
              })
          : dispatchProductionFromProposalOutcome(
              effectiveSwarmOutcome,
              swarmRun.id,
              swarmRunSummary,
              { proposalRequired: effectiveSwarmOutcome?.kind !== 'proposal-disabled' },
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
          !isTrustedGeneratedRepairItem(item) &&
          poolTierOf(engineTierOf(backend, routingCfg)) === 'local'
        ) {
          const previousBackend = backend;
          backend = 'ashlrcode';
          backendTier = engineTierOf(backend, routingCfg);
          selectedModel = routingCfg.foundry?.models?.[backend] ?? null;
          assignedBy = 'ashlrcode-executor';
          assignmentReason = `${assignmentReason}; ashlrcodeExecutor sandboxed ${previousBackend} via ashlrcode`;
        }
        // M334: shadow the about-to-dispatch legacy decision (observe-only).
        await shadowGateway({
          backend: String(backend ?? 'builtin'),
          tier: backendTier === null ? null : String(backendTier),
          model: selectedModel ?? null,
          dispatched: true,
        });
        if (stopRequested()) return stopRequestedOutcome(item, attemptId);

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
              .filter((c) =>
                !isTrustedGeneratedRepairItem(item) ||
                effectiveGeneratedRepairCandidateAllowed(item, c.engine as EngineId, routingCfg))
          : undefined;
        const fanOut =
          bestOfN > 1 &&
          !isTrustedGeneratedRepairItem(item) &&
          (typeof _bonMinScore !== 'number' || (item.score ?? 0) >= _bonMinScore);
        let bonBillable: number | null = null;

        let runState: Awaited<ReturnType<typeof runGoal>>;
        if (fanOut) {
          // Route through runBestOfN; use its winner's underlying runState.
          // runBestOfN never throws; if all candidates fail, winner is undefined
          // and we fall through to a zero-cost no-proposal outcome.
          if (stopRequested()) return stopRequestedOutcome(item, attemptId);
          const launch = beginRejectedCaptureRecoveryDispatch(item, () => {
            if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before best-of-n launch');
            beginQueueExecution();
            recordUse(backend!);
            recordDispatchStartAgentAction(item, {
              ts: new Date().toISOString(), machineId, runId: attemptId, backend: backend!,
              tier: backendTier, model: selectedModel, assignedBy, reason: assignmentReason, mode: 'best-of-n',
            });
            if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before best-of-n producer start');
            if (!markGeneratedRepairExecutionLaunched(item)) {
              throw new Error('generated repair launch reservation could not be persisted');
            }
            return runBestOfN(item, routingCfg, {
              n: bestOfN, engine: backend, model: selectedModel,
              ...(_bonCandidates && _bonCandidates.length > 0 ? { candidates: _bonCandidates as never } : {}),
              workItemId: item.id, workItemGenerationId, workSource: item.source,
              delegationScope, attemptId, shadowSkillCards, shadowSkillSelectedAt,
              signal: dispatchSignal,
            });
          });
          if (!launch.authorized) return authorityUnavailableOutcome(item, attemptId);
          dispatched = true;
          backendDispatch[backend!] = (backendDispatch[backend!] ?? 0) + 1;
          const bonResult = await launch.value;
          bonBillable = bonResult.critique.billableCostUsd ?? 0;
          if (!stillOwnsTick()) {
            swarmSpent = bonBillable;
            tickSpent += swarmSpent;
            return {
              item,
              spentUsd: swarmSpent,
              dispatched: true,
              dispatch: dispatchTrace(item, {
                backend,
                tier: backendTier,
                model: selectedModel,
                assignedBy,
                reason: assignmentReason,
                dispatched: true,
                spentUsd: swarmSpent,
                runId: attemptId,
                trajectoryId: `run:${attemptId}`,
                skipReason: 'daemon-lock-lost',
                production: cancelledDispatchProduction(attemptId, 'daemon lock ownership lost', swarmSpent),
              }),
            };
          }
          if (!bonResult.winner) {
            // All candidates were empty/failing — still count what the fan-out
            // actually spent (M333: the pre-M333 $0 under-reported real spend).
            swarmSpent = bonBillable;
            tickSpent += swarmSpent;
            const authoritativeProduction = bestOfNAuthoritativeNoWinnerProduction(
              bonResult,
              bestOfN,
              attemptId,
              swarmSpent,
            );
            const cancelled = authoritativeProduction === undefined &&
              (dispatchSignal.aborted === true || bestOfNWasCancelled(bonResult));
            const production = authoritativeProduction ?? (cancelled
              ? cancelledDispatchProduction(attemptId, `best-of-${bestOfN} selection cancelled by owner`, swarmSpent)
              : bestOfNNoWinnerProduction(bestOfN));
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
          if (stopRequested()) return stopRequestedOutcome(item, attemptId);
          const launch = beginRejectedCaptureRecoveryDispatch(item, () => {
            if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before direct launch');
            beginQueueExecution();
            recordUse(backend!);
            recordDispatchStartAgentAction(item, {
              ts: new Date().toISOString(), machineId, runId: attemptId, backend: backend!,
              tier: backendTier, model: selectedModel, assignedBy, reason: assignmentReason, mode: 'single',
            });
            if (!stillOwnsTick()) throw new Error('daemon lock ownership lost before direct producer start');
            if (!markGeneratedRepairExecutionLaunched(item)) {
              throw new Error('generated repair launch reservation could not be persisted');
            }
            return runGoal(goal, dispatchCfg, {
              engine: backend, sandboxEngine: true, requireSandbox: true, cwd: item.repo,
              budget: itemBudget, tools: true, noMemory: false, runId: attemptId,
              ...(selectedModel ? { model: selectedModel } : {}),
              workItemId: item.id, workItemGenerationId, workSource: item.source, delegationScope,
              signal: dispatchSignal,
            });
          });
          if (!launch.authorized) return authorityUnavailableOutcome(item, attemptId);
          dispatched = true;
          backendDispatch[backend!] = (backendDispatch[backend!] ?? 0) + 1;
          runState = await launch.value;
          if (!stillOwnsTick()) {
            swarmSpent = isSubscriptionEngine(backend ?? 'builtin') ? 0 : (runState.usage?.estCostUsd ?? 0);
            tickSpent += swarmSpent;
            return {
              item,
              spentUsd: swarmSpent,
              dispatched: true,
              dispatch: dispatchTrace(item, {
                backend,
                tier: backendTier,
                model: selectedModel,
                assignedBy,
                reason: assignmentReason,
                dispatched: true,
                spentUsd: swarmSpent,
                runId: runState.id,
                trajectoryId: `run:${attemptId}`,
                skipReason: 'daemon-lock-lost',
                production: cancelledDispatchProduction(runState.id, 'daemon lock ownership lost', swarmSpent),
              }),
            };
          }
          const runActionCounts = runState.runEventSummary?.actionCounts;
          const runExecuted = runState.status === 'done' || [
            runActionCounts?.spawnAttempts,
            runActionCounts?.modelSteps,
            runActionCounts?.toolSteps,
            runActionCounts?.totalSteps,
          ].some((count) => typeof count === 'number' && count > 0);
          if (runExecuted && runState.proposalOutcome?.kind !== 'kill-switch') {
            const plannedBackend = backend ?? 'builtin';
            const reportedBackend = runState.engine as EngineId | undefined;
            const executedBackend = reportedBackend && resolveEngineSpec(reportedBackend, routingCfg)
              ? reportedBackend
              : plannedBackend;
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
              ?? (executedBackend === backend ? backendTier : engineTierOf(executedBackend, routingCfg));
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
            if (executedBackend !== backend) {
              backend = executedBackend;
              backendTier = executedTier;
              selectedModel = executedModel;
              assignedBy = 'executor-fallback';
              assignmentReason = `${assignmentReason}; executor ran ${backend} instead of planned ${plannedBackend}`;
            }
          }
        }
        const directOutcome = runState.proposalOutcome;
        const directCancelled = directOutcome === undefined && runState.status === 'aborted' && (
          runState.terminationReason === 'cancelled' || (
            dispatchSignal.aborted === true && resultDescribesCancellation(runState.result)
          )
        );
        const directFailed = directOutcome === undefined &&
          (runState.status === 'aborted' || runState.status === 'failed');
        const directCancellationReason = runState.terminationReason === 'cancelled'
          ? 'run cancelled by owner'
          : 'run aborted without a proposal';
        const directRunSummary = runEventSummary({
          ...(runState.runEventSummary ?? {}),
          runId: runState.id,
          status: directCancelled ? 'aborted' : runState.status,
          outcome: directCancelled
            ? 'cancelled'
            : directFailed
              ? 'engine-failed'
              : directOutcome?.kind ?? runState.status,
          proposalCreated: directCancelled ? false : directOutcome?.kind === 'filed',
          proposalId: directCancelled ? undefined : directOutcome?.proposalId,
          tokensIn: runState.usage?.tokensIn,
          tokensOut: runState.usage?.tokensOut,
          costUsd: runState.usage?.estCostUsd,
        });
        dispatchProduction = directCancelled
          ? cancelledDispatchProduction(
              runState.id,
              directCancellationReason,
              runState.usage?.estCostUsd ?? 0,
              directRunSummary,
              runState.evidenceOutcome,
            )
          : directFailed
            ? failedProducerDispatchProduction({
                runId: runState.id,
                producer: 'run',
                status: runState.status === 'failed' ? 'failed' : 'aborted',
                result: runState.result,
                costUsd: runState.usage?.estCostUsd ?? 0,
                summary: directRunSummary,
                evidenceOutcome: runState.evidenceOutcome,
              })
          : dispatchProductionFromProposalOutcome(directOutcome, runState.id, directRunSummary, {
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
          : isSubscriptionEngine(backend ?? 'builtin')
            ? 0
            : (runState.usage?.estCostUsd ?? 0);
        tickSpent += swarmSpent;

        if (!stillOwnsTick()) {
          return {
            item,
            spentUsd: swarmSpent,
            dispatched: true,
            dispatch: dispatchTrace(item, {
              backend,
              tier: backendTier,
              model: selectedModel,
              assignedBy,
              reason: assignmentReason,
              dispatched: true,
              spentUsd: swarmSpent,
              runId: runState.id,
              trajectoryId: `run:${attemptId}`,
              skipReason: 'daemon-lock-lost',
              production: cancelledDispatchProduction(runState.id, 'daemon lock ownership lost', swarmSpent),
            }),
          };
        }

        audit({
          action: dispatchProduction?.outcome === 'proposal-created'
            ? 'daemon:proposal-created'
            : 'daemon:no-proposal',
          repo: item.repo,
          sandboxId: null,
          summary: `${backend} run ${runState.id} finished (status=${runState.status}, spent=$${swarmSpent.toFixed(4)}) for "${item.title}"`,
          result: 'ok',
        });
      }
		    } catch (err) {
		      if (err instanceof QueueClaimAuthorityError) {
		        return queueLeaseLostOutcome(item, attemptId);
		      }
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
    if (dispatched && swarmSpent > 0 && !stopRequested()) {
      const intelRaw2 = routingCfg.foundry?.intelligence;
      if (intelRaw2 !== undefined && intelRaw2 !== null) {
        const intelCfg2 = intelRaw2 as { anomalyK?: number };
        const anomalyK = typeof intelCfg2.anomalyK === 'number' && intelCfg2.anomalyK > 0
          ? intelCfg2.anomalyK : 4;
        const goal2 = buildItemGoal(item);
        const est2 = await estimateRun(goal2, { maxTokens: perItemMaxTokens }, routingCfg).catch((err) => { console.warn('[ashlr] daemon:tick estimateRun failed:', (err as Error)?.message ?? err); return null; });
        const p50 = est2?.estCostUsd.median ?? 0;
        if (p50 > 0 && swarmSpent > anomalyK * p50 && !stopRequested()) {
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
    const selectionSnapshotAt = selectionResourceSnapshot
      ? Date.parse(selectionResourceSnapshot.generatedAt)
      : Number.NaN;
    const selectionSnapshotAgeMs = Date.now() - selectionSnapshotAt;
    const reusableSelectionSnapshot = selectionResourceSnapshot &&
      Number.isFinite(selectionSnapshotAgeMs) &&
      selectionSnapshotAgeMs >= 0 &&
      selectionSnapshotAgeMs <= RESOURCE_SNAPSHOT_MAX_AGE_MS
      ? selectionResourceSnapshot
      : null;
    const concurrentSnap = reusableSelectionSnapshot ?? (await getResourceSnapshot(routingCfg).catch(() => ({
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
    const routeTiers = new Map<string, EngineTier | null>();
    if (routingCfg.foundry?.fabric?.gateway === true) {
      const gds = await Promise.allSettled(
        workedSet.map((item) => gatewayDecide(item, routingCfg, { spentUsd: tickSpent + state.todaySpentUsd }))
      );
      for (let i = 0; i < workedSet.length; i++) {
        const d = gds[i];
        if (d?.status === 'fulfilled') {
          const itemKey = workItemCoverageKey(workedSet[i]!);
          routeHints.set(itemKey, d.value.backend);
          routeReasons.set(itemKey, d.value.reason);
          routeModels.set(itemKey, d.value.model ?? null);
          routeTiers.set(itemKey, d.value.tier);
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
      (item, backend) => effectiveGeneratedRepairCandidateAllowed(item, backend, routingCfg),
      (backend) => engineTierOf(backend, routingCfg),
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
    if (!stillOwnsTick()) {
      stopLeaseRenewer();
      return ownershipLostTick({
        ts: now,
        itemsConsidered: workedSet.length,
        proposalsCreated: 0,
        spentUsd: tickSpent,
        reason: 'shutdown-requested',
      });
    }
    dispatchManifest = recordDispatchManifest(dispatchManifestEvent);

    // runConcurrentDispatch: executes plan with full cross-backend parallelism.
    const concurrentResults = await runConcurrentDispatch(
      concurrentPlan,
      async (item, _backend): Promise<unknown> => {
        // Each dispatched item flows through the FULL task run function.
        // Find the pre-built task for this item (same gate logic: kill-switch,
        // budget short-circuit, gateway/serial routing, sandbox, judge, etc.).
        // We look up by repository-qualified work identity to reuse the existing tasks[] entries which
        // already capture tickSpent/state/liveCfg via closure.
        const itemKey = workItemCoverageKey(item);
        const taskEntry = tasks.find((_t, idx) =>
          workedSet[idx] !== undefined && workItemCoverageKey(workedSet[idx]!) === itemKey,
        );
        if (taskEntry) {
          const hintedBackend = routeHints.get(itemKey);
          const baseReason = routeReasons.get(itemKey);
          const assignedReason = concurrentAssignedRouteReason({
            baseReason,
            hintedBackend,
            assignedBackend: _backend,
            diagnosticRepair: isTrustedDiagnosticResliceItem(item),
            candidateAllowed: effectiveGeneratedRepairCandidateAllowed(item, _backend, routingCfg),
          });
          const finalRoute = finalizeConcurrentDispatchRoute({
            assignedBackend: _backend,
            assignedTier: engineTierOf(_backend, routingCfg),
            ...(hintedBackend !== undefined ? { hintedBackend } : {}),
            ...(routeTiers.has(itemKey) ? { hintedTier: routeTiers.get(itemKey) } : {}),
            ...(routeModels.has(itemKey) ? { hintedModel: routeModels.get(itemKey) } : {}),
            ...(assignedReason !== undefined ? { reason: assignedReason } : {}),
          });
          return taskEntry.run(finalRoute.backend, finalRoute.reason, finalRoute.model);
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
	      const attemptId = attemptIds.get(workItemCoverageKey(r.item));
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
  } catch (err) {
    stopLeaseRenewer();
    throw err;
  }

  const postDispatchOwnershipLost = (): DaemonTick | null => {
    if (stillOwnsTick()) return null;
    return ownershipLostTick({
      ts: now,
      itemsConsidered: workedSet.length,
      proposalsCreated: 0,
      spentUsd: tickSpent,
      reason: 'shutdown-requested',
      ...(dispatchesFromOutcomes(outcomes) ? { dispatches: dispatchesFromOutcomes(outcomes) } : {}),
    });
  };
  const postSettlementFence = acquireTickMutationFence();
  if (opts.ownerLock && !postSettlementFence) {
    stopLeaseRenewer();
    return postDispatchOwnershipLost() ?? {
      ts: now,
      itemsConsidered: workedSet.length,
      proposalsCreated: 0,
      spentUsd: tickSpent,
      reason: 'state-persistence-failed',
      ...(dispatchesFromOutcomes(outcomes) ? { dispatches: dispatchesFromOutcomes(outcomes) } : {}),
    };
  }
  try {
  const ownershipLostAfterSettlement = postDispatchOwnershipLost();
  if (ownershipLostAfterSettlement) {
    return ownershipLostAfterSettlement;
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

  // A preflighted automatic drain can still be paused by a later gateway,
  // learned-router, budget, or resource decision. Cool only the claimed repair
  // generation briefly so ordinary work can progress on the next tick. This is
  // selection evidence, not execution or empty-diff lifecycle authority.
  const ownershipLostBeforeCooldown = postDispatchOwnershipLost();
  if (ownershipLostBeforeCooldown) return ownershipLostBeforeCooldown;
  if (automaticDrain && drainSelectedItems.length > 0) {
    const dispatchedItemKeys = new Set(
      outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' && outcome.value.dispatched
          ? [leaseKey(outcome.value.item)]
          : [],
      ),
    );
    try {
      for (const item of drainSelectedItems) {
        if (dispatchedItemKeys.has(leaseKey(item))) continue;
        coordinator.recordClaimOutcome(
          item,
          frozenWorkedItemId(item),
          'dispatch-blocked',
          machineId,
        );
      }
    } catch (err) {
      console.warn('[ashlr] daemon:tick dispatch-blocked cooldown failed:', (err as Error)?.message ?? err);
    }
  }

  // Proposals actually recorded this tick = the PENDING-count delta (clamped >=0).
  let proposalsCreated = 0;
  try { proposalsCreated = Math.max(0, pendingCount() - pendingBefore); } catch (err) { console.warn('[ashlr] daemon:tick proposalDelta count failed:', (err as Error)?.message ?? err); proposalsCreated = 0; }
  const proposalProduction = proposalProductionSummary(selected.length, workedSet.length, outcomes, proposalsCreated);

  const newPendingProposals: Proposal[] = [];
  let pendingProposalDeltaReadFailed = false;
  try {
    for (const proposal of listProposals({ status: 'pending' })) {
      if (pendingBeforeIds.has(proposal.id)) continue;
      newPendingProposals.push(proposal);
    }
  } catch {
    pendingProposalDeltaReadFailed = true;
  }

  const productionCompletedAt = new Date().toISOString();
  const productionEventItemKeys = new Map<DispatchProductionEvent, string>();
  const productionEventsByItemKey = new Map<string, DispatchProductionEvent>();
  const productionEvents = outcomes.flatMap((outcome): DispatchProductionEvent[] => {
    if (outcome.status !== 'fulfilled' || !outcome.value.dispatched) return [];
    const itemKey = workItemCoverageKey(outcome.value.item);
    const event = dispatchProductionEventFromOutcome(
      outcome.value,
      pendingProposalForWorkItem(outcome.value.item, newPendingProposals),
      machineId,
      productionCompletedAt,
      routingCfg,
      generatedRepairReservations.get(itemKey)?.record,
    );
    if (event) {
      productionEventItemKeys.set(event, itemKey);
      productionEventsByItemKey.set(itemKey, event);
    }
    return event ? [event] : [];
  });
  const handoffFailedItemKeys = new Set<string>();
  const productionWriteFailedItemKeys = new Set<string>();
  const workedOutcomeFailedItemKeys = new Set<string>();
  const generatedRepairLifecycleSucceededItemKeys = new Set<string>();
  const generatedRepairCooldownItemKeys = new Set<string>();
  const generatedRepairFailedAttemptWitnessItemKeys = new Set<string>();
  const generatedRepairItemsById = new Map(
    outcomes.flatMap((outcome) => outcome.status === 'fulfilled' &&
      isTrustedGeneratedRepairItem(outcome.value.item)
      ? [[workItemCoverageKey(outcome.value.item), outcome.value.item] as const]
      : []),
  );
  const sharedQueueMode = liveCfg.fleet?.sharedQueue?.mode === 'filesystem';
  const ownershipLostBeforeDispatchWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeDispatchWrites) return ownershipLostBeforeDispatchWrites;
  for (const event of productionEvents) {
    const itemKey = productionEventItemKeys.get(event);
    if (!itemKey) continue;
    const repairable = repairHandoffFromDispatchEvent(event) !== null;
    let canonicalProductionRecorded = false;
    if (sharedQueueMode) {
      const parentWrite = recordDispatchProduction(event);
      canonicalProductionRecorded = parentWrite.recorded === 1;
      if (parentWrite.recorded !== 1) productionWriteFailedItemKeys.add(itemKey);
      if (parentWrite.recorded !== 1 && repairable) handoffFailedItemKeys.add(itemKey);
      if (repairable) handoffFailedItemKeys.add(itemKey);
    } else if (repairable) {
      const v2Requested = liveCfg.foundry?.repairHandoffV2Write === true;
      const activationRaw = (liveCfg.foundry as Record<string, unknown> | undefined)?.['repairHandoffV2Activation'];
      const activation = validRepairHandoffV2Activation(activationRaw) ? activationRaw : undefined;
      let handoff: { attempted: number; recorded: number; failed: number };
      if (v2Requested) {
        if (!activation) {
          const parentWrite = recordDispatchProduction(event);
          if (parentWrite.recorded !== 1) productionWriteFailedItemKeys.add(itemKey);
          handoff = { attempted: 1, recorded: 0, failed: 1 };
        } else {
          handoff = recordRepairHandoffs(event, { schemaVersion: 2, activation });
        }
      } else {
        handoff = recordRepairHandoffs(event, { schemaVersion: 1 });
      }
      canonicalProductionRecorded = handoff.recorded === 1 && handoff.failed === 0;
      if (handoff.failed > 0) handoffFailedItemKeys.add(itemKey);
    } else {
      const productionWrite = recordDispatchProduction(event);
      canonicalProductionRecorded = productionWrite.recorded === 1;
      if (productionWrite.recorded !== 1) {
        productionWriteFailedItemKeys.add(itemKey);
        console.warn(
          '[ashlr] daemon:tick canonical dispatch production persistence unavailable',
          productionWrite.failureReasons,
        );
      }
    }
    if (
      !sharedQueueMode &&
      repairable &&
      generatedRepairItemsById.has(itemKey) &&
      !canonicalProductionRecorded
    ) {
      const witnessWrite = recordDispatchProduction(event);
      canonicalProductionRecorded = witnessWrite.recorded === 1;
      if (!canonicalProductionRecorded) {
        productionWriteFailedItemKeys.add(itemKey);
        console.warn('[ashlr] daemon:tick failed-attempt witness persistence unavailable', witnessWrite.failureReasons);
      }
    }
    const failedRepairItem = generatedRepairItemsById.get(itemKey);
    const failedRepairReservation = generatedRepairReservations.get(itemKey)?.record;
    if (
      canonicalProductionRecorded &&
      failedRepairItem !== undefined &&
      failedRepairReservation !== undefined &&
      GENERATED_REPAIR_FAILED_OUTCOMES.has(event.outcome) &&
      event.proposalCreated === false &&
      exactFailedAttemptReceiptMatchesReservation(failedRepairItem, event, failedRepairReservation)
    ) generatedRepairFailedAttemptWitnessItemKeys.add(itemKey);
  }

  // M85/M305: record item-accurate outcomes to the worked ledger. New proposals
  // carry workItemId, so a multi-item tick can tell which dispatched item filed
  // a patch instead of relying on the old aggregate pending-count heuristic.
  // Non-dispatched items (kill-switch / budget skip) are NOT recorded — they
  // were never run, so they should not trigger a cooldown.
  const ownershipLostBeforeWorkedWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeWorkedWrites) return ownershipLostBeforeWorkedWrites;
  if (dispatchedCount > 0) {
    try {
      const proposalItemKeys = new Set<string>();
      for (const outcome of outcomes) {
        if (outcome.status !== 'fulfilled' || !outcome.value.dispatched) continue;
        if (pendingProposalForWorkItem(outcome.value.item, newPendingProposals)) {
          proposalItemKeys.add(workItemCoverageKey(outcome.value.item));
        }
      }
      if (pendingProposalDeltaReadFailed) {
        // Fallback preserves the old conservative behavior if the inbox cannot
        // be read after dispatch.
        if (proposalsCreated >= dispatchedCount) {
          for (const outcome of outcomes) {
            if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
              proposalItemKeys.add(workItemCoverageKey(outcome.value.item));
            }
          }
        }
      }
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
          const itemKey = workItemCoverageKey(outcome.value.item);
          if (productionWriteFailedItemKeys.has(itemKey)) {
            if (sharedQueueMode) coordinator.settleClaim(outcome.value.item, machineId);
            workedOutcomeFailedItemKeys.add(itemKey);
            continue;
          }
          if (isTrustedGeneratedRepairItem(outcome.value.item)) continue;
          if (handoffFailedItemKeys.has(itemKey)) {
            // The parent attempt is terminal, but failed repair projection grants
            // no cooldown authority. Clear only this exact executing generation
            // and keep the parent immediately retryable.
            if (sharedQueueMode) coordinator.settleClaim(outcome.value.item, machineId);
            workedOutcomeFailedItemKeys.add(itemKey);
            continue;
          }
          const production = outcome.value.dispatch?.production;
          const duplicateDiff = production?.outcome === 'proposal-disabled' &&
            production.reason?.startsWith('duplicate diff skipped;') === true;
          if (production?.runEventSummary?.status === 'aborted') continue;
          if (production?.outcome === 'proposal-disabled' && !duplicateDiff) {
            if (!coordinator.settleClaim(outcome.value.item, machineId)) {
              workedOutcomeFailedItemKeys.add(itemKey);
            }
            continue;
          }
          const outcomeLabel =
            (duplicateDiff ? 'empty' : workedOutcomeFromDispatchProduction(production)) ??
            (proposalItemKeys.has(itemKey) ? 'diff' : 'empty');
          // M113: route through coordinator (Local → worked-ledger; Shared → global store).
          if (!coordinator.recordClaimOutcome(
            outcome.value.item,
            frozenWorkedItemId(outcome.value.item),
            outcomeLabel,
            machineId,
          )) workedOutcomeFailedItemKeys.add(itemKey);
        }
      }
    } catch (err) {
      // Ledger recording must never crash the tick.
      console.warn('[ashlr] daemon:tick ledger recordOutcome failed:', (err as Error)?.message ?? err);
      for (const outcome of outcomes) {
        if (outcome.status === 'fulfilled' && outcome.value.dispatched) {
          workedOutcomeFailedItemKeys.add(workItemCoverageKey(outcome.value.item));
        }
      }
    }
  }

  // Generated-repair lifecycle is a local, atomic control store. Shared-queue
  // mode stays fail-closed until claim fencing can bind late outcomes safely.
  const repairTreatmentOutcomeWitnesses: DispatchProductionEvent[] = [];
  const ownershipLostBeforeLifecycleWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeLifecycleWrites) return ownershipLostBeforeLifecycleWrites;
  if (dispatchedCount > 0 && liveCfg.fleet?.sharedQueue?.mode !== 'filesystem') {
    try {
      for (const outcome of outcomes) {
        if (
          outcome.status !== 'fulfilled' ||
          !outcome.value.dispatched ||
          handoffFailedItemKeys.has(workItemCoverageKey(outcome.value.item)) ||
          productionWriteFailedItemKeys.has(workItemCoverageKey(outcome.value.item)) ||
          workedOutcomeFailedItemKeys.has(workItemCoverageKey(outcome.value.item)) ||
          !isTrustedGeneratedRepairItem(outcome.value.item)
        ) continue;
        const trace = outcome.value.dispatch;
        const production = trace?.production;
        const attemptId = trace?.trajectoryId ?? trace?.runId ?? production?.runId;
        if (!production || !attemptId) continue;
        const itemKey = workItemCoverageKey(outcome.value.item);
        const productionEvent = productionEventsByItemKey.get(itemKey);
        if (!productionEvent) continue;
        const proofCapableDiagnostic = isTrustedDiagnosticResliceItem(outcome.value.item);
        const treatmentCandidate = proofCapableDiagnostic &&
          productionEvent.repairTreatmentUnitId && productionEvent.repairTreatment
          ? {
              ...productionEvent,
              basis: 'repair-lifecycle-candidate' as const,
              repairTreatmentAttemptHash: generatedRepairLifecycleAttemptHash(attemptId),
            } satisfies DispatchProductionEvent
          : undefined;
        if (production.outcome !== 'empty-diff' && production.outcome !== 'proposal-created') {
          generatedRepairCooldownItemKeys.add(itemKey);
          continue;
        }
        if (
          production.outcome === 'empty-diff' &&
          !production.reason?.startsWith('best-of-') &&
          trace.backend &&
          trace.tier &&
          generatedRepairExecutionBackendAllowed(outcome.value.item, trace.backend, routingCfg)
        ) {
          const transition = proofCapableDiagnostic
            ? recordGeneratedRepairLifecycle(outcome.value.item, {
                kind: 'dispatch-proof-empty-diff',
                eventTs: productionEvent.ts,
                ...(treatmentCandidate ? { treatmentCandidate } : {}),
              })
            : recordGeneratedRepairLifecycle(outcome.value.item, {
                kind: 'empty-diff',
                attemptId,
                backend: trace.backend,
                tier: trace.tier,
                ...(treatmentCandidate ? { treatmentCandidate } : {}),
              });
          if (
            transition.available &&
            transition.authoritativeEmptyRuns >= (productionEvent.repairAttemptOrdinal ?? 1)
          ) generatedRepairLifecycleSucceededItemKeys.add(itemKey);
          const witness = transition.treatmentOutcomeWitness;
          if (
            witness && proofCapableDiagnostic &&
            productionEvent?.repairTreatmentUnitId && productionEvent.repairTreatment
          ) {
            repairTreatmentOutcomeWitnesses.push({
              ...productionEvent,
              basis: 'repair-lifecycle-outcome',
              repairTreatmentOutcome: witness.outcome,
              repairTreatmentAttemptHash: witness.attemptHash,
            });
          }
          continue;
        }
        if (production.outcome !== 'proposal-created') {
          generatedRepairCooldownItemKeys.add(itemKey);
          continue;
        }
        const proposal = pendingProposalForWorkItem(outcome.value.item, newPendingProposals);
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
        ) {
          generatedRepairCooldownItemKeys.add(itemKey);
          continue;
        }
        const transition = recordGeneratedRepairLifecycle(outcome.value.item, {
          kind: 'proposal-created',
          attemptId,
          proposalId: proposal.id,
          ts: productionEvent.ts,
          ...(treatmentCandidate ? { treatmentCandidate } : {}),
        });
        if (transition.available && transition.disposition === 'retired') {
          generatedRepairLifecycleSucceededItemKeys.add(itemKey);
        }
        const witness = transition.treatmentOutcomeWitness;
        if (
          witness && proofCapableDiagnostic &&
          productionEvent.repairTreatmentUnitId && productionEvent.repairTreatment
        ) {
          repairTreatmentOutcomeWitnesses.push({
            ...productionEvent,
            basis: 'repair-lifecycle-outcome',
            repairTreatmentOutcome: witness.outcome,
            repairTreatmentAttemptHash: witness.attemptHash,
          });
        }
      }
    } catch (err) {
      console.warn('[ashlr] daemon:tick generated repair lifecycle failed:', (err as Error)?.message ?? err);
    }
  }

  // Authoritative generated-repair outcomes never mint worked authority. A
  // canonical nonterminal row gets only a generation-scoped blocked cooldown;
  // lifecycle proof and worked state are therefore never raced for one outcome.
  // Shared claims settle after the selected control-plane transition.
  const ownershipLostBeforeGeneratedRepairWorkedWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeGeneratedRepairWorkedWrites) return ownershipLostBeforeGeneratedRepairWorkedWrites;
  if (dispatchedCount > 0) {
    for (const outcome of outcomes) {
      if (
        outcome.status !== 'fulfilled' ||
        !outcome.value.dispatched ||
        !isTrustedGeneratedRepairItem(outcome.value.item)
      ) continue;
      const itemKey = workItemCoverageKey(outcome.value.item);
      if (
        productionWriteFailedItemKeys.has(itemKey) ||
        (handoffFailedItemKeys.has(itemKey) && !generatedRepairFailedAttemptWitnessItemKeys.has(itemKey))
      ) {
        console.warn('[ashlr] daemon:tick generated repair authority incomplete', {
          production: productionWriteFailedItemKeys.has(itemKey),
          handoff: handoffFailedItemKeys.has(itemKey),
          lifecycle: generatedRepairLifecycleSucceededItemKeys.has(itemKey),
        });
        workedOutcomeFailedItemKeys.add(itemKey);
        continue;
      }
      if (generatedRepairCooldownItemKeys.has(itemKey)) {
        if (!generatedRepairFailedAttemptWitnessItemKeys.has(itemKey)) {
          console.warn('[ashlr] daemon:tick failed repair attempt receipt unavailable');
          workedOutcomeFailedItemKeys.add(itemKey);
          continue;
        }
        if (!coordinator.recordClaimOutcome(
          outcome.value.item,
          frozenWorkedItemId(outcome.value.item),
          'dispatch-blocked',
          machineId,
        )) workedOutcomeFailedItemKeys.add(itemKey);
        if (
          generatedRepairFailedAttemptWitnessItemKeys.has(itemKey) &&
          !settleGeneratedRepairExecution(outcome.value.item)
        ) {
          console.warn('[ashlr] daemon:tick failed repair attempt reservation settlement incomplete');
          workedOutcomeFailedItemKeys.add(itemKey);
        }
        continue;
      }
      if (!generatedRepairLifecycleSucceededItemKeys.has(itemKey)) {
        console.warn('[ashlr] daemon:tick generated repair lifecycle persistence incomplete');
        workedOutcomeFailedItemKeys.add(itemKey);
        continue;
      }
      if (sharedQueueMode && !coordinator.settleClaim(outcome.value.item, machineId)) {
        workedOutcomeFailedItemKeys.add(itemKey);
        continue;
      }
      if (!settleGeneratedRepairExecution(outcome.value.item)) {
        console.warn('[ashlr] daemon:tick generated repair durable reservation settlement incomplete');
        workedOutcomeFailedItemKeys.add(itemKey);
      }
    }
  }

  const ownershipLostBeforeLifecycleWitnessWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeLifecycleWitnessWrites) return ownershipLostBeforeLifecycleWitnessWrites;
  if (repairTreatmentOutcomeWitnesses.length > 0) {
    for (const witness of repairTreatmentOutcomeWitnesses) {
      if (
        !witness.repairGenerationId ||
        !witness.repairTreatmentAttemptHash ||
        !publishGeneratedRepairTreatmentOutcome(
          witness.repairGenerationId,
          witness.repairTreatmentAttemptHash,
        )
      ) {
        repairTreatmentWitnessPersistenceFailed = true;
        repairTreatmentPublicationFailed = true;
        console.warn('[ashlr] daemon:tick repair treatment witness persistence incomplete');
      }
    }
  }
  const ownershipLostBeforeTreatmentFlush = postDispatchOwnershipLost();
  if (ownershipLostBeforeTreatmentFlush) return ownershipLostBeforeTreatmentFlush;
  if (!stopRequested()) {
    const finalTreatmentFlush = flushPendingRepairTreatmentOutcomes();
    if (!finalTreatmentFlush.complete) repairTreatmentWitnessPersistenceFailed = true;
    if (finalTreatmentFlush.complete) {
      repairTreatmentPublicationFailed = false;
    } else if (finalTreatmentFlush.publicationFailed) {
      repairTreatmentPublicationFailed = true;
    }
  }

  const ownershipLostBeforeActionWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeActionWrites) return ownershipLostBeforeActionWrites;
  if (dispatchedCount > 0) {
    try {
      recordAgentAction(productionEvents.map(agentActionFromDispatchEvent));
    } catch (err) {
      console.warn('[ashlr] daemon:tick dispatch production ledger failed:', (err as Error)?.message ?? err);
    }
  }
  const ownershipLostBeforeSkipActionWrites = postDispatchOwnershipLost();
  if (ownershipLostBeforeSkipActionWrites) return ownershipLostBeforeSkipActionWrites;
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
  const ownershipLostBeforeClaimRelease = postDispatchOwnershipLost();
  if (ownershipLostBeforeClaimRelease) return ownershipLostBeforeClaimRelease;
  try {
    const dispatchedKeys = new Set(
      outcomes
        .filter((o): o is PromiseFulfilledResult<ItemOutcome> => o.status === 'fulfilled' && o.value.dispatched)
        .map(o => leaseKey(o.value.item)),
    );
    const unworkedItems = workedSet.filter((item) => !dispatchedKeys.has(leaseKey(item)));
    if (unworkedItems.length > 0) coordinator.release(unworkedItems, machineId);
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
  autoMergePassResult = preDispatchAutoMergePassRan ? preDispatchAutoMergePassResult : await runAutoMergeMaintenancePass(true);
  const autoMerge = autoMergeTickSummary(autoMergePassResult);
  merged = autoMergePassResult?.merged ?? 0;
  const producerMaintenance = producerMaintenanceSummary();

  if (!stillOwnsTick()) {
    return ownershipLostTick({
      ts: now,
      itemsConsidered: selected.length,
      proposalsCreated,
      spentUsd: tickSpent,
      reason: 'shutdown-requested',
      ...(dispatches ? { dispatches } : {}),
    });
  }

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
  state.automaticDrainOrdinaryTurnDue = automaticDrainOrdinaryTurnDue;
  state.todaySpentUsd += tickSpent;
  state.itemsProcessed += dispatchedCount;
  state.lastTickAt = now;

  const hasUnsettledGeneratedRepairReservation = [...generatedRepairReservations.keys()].some(
    (itemId) => !settledGeneratedRepairReservationItemIds.has(itemId),
  );
  const residentSafeTreatmentFailure = repairTreatmentPublicationFailed &&
    workedOutcomeFailedItemKeys.size === 0 &&
    !proposalDuplicateAuthorityUnavailable &&
    !hasUnsettledGeneratedRepairReservation;
  const tickRecord: DaemonTick = {
    ts: now,
    itemsConsidered: selected.length,
    proposalsCreated,
    spentUsd: tickSpent,
    reason: stopRequested()
      ? (killSwitchOn() ? 'kill-switch' : 'shutdown-requested')
      : workedOutcomeFailedItemKeys.size > 0 ||
          repairTreatmentPublicationFailed ||
          proposalDuplicateAuthorityUnavailable ||
          hasUnsettledGeneratedRepairReservation
        ? 'state-persistence-failed'
        : 'ok',
	    ...(residentSafeTreatmentFailure
	      ? { residentSafePersistenceFailure: 'repair-treatment' as const }
	      : {}),
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
  const saveResult = saveTickState(state);
  if (!saveResult.ok) {
    audit({
      action: 'daemon:persistence-failed',
      repo: null,
      sandboxId: null,
      summary: `tick completed but spend accounting save failed (${saveResult.error}); spend guard remains armed`,
      result: 'error',
    });
    const failedTick = nonResidentPersistenceFailureTick(tickRecord);
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
    const failedTick = nonResidentPersistenceFailureTick(tickRecord);
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
  if (!stopRequested() && cfg.pulse?.enabled) {
    trackDaemonTickEffect(
      tickRecord,
      runLegacyPulseExport(cfg, tickRecord, {
        sinceTs: state.lastPulseExportAt,
        startedAt: state.startedAt,
        signal: opts.signal,
        ownerLock: opts.ownerLock,
      }),
    );
  }

  // M214: fire-and-forget tick-cost emit to Pulse OTLP — additive, never throws, no control-flow change.
  // Lazy-imported (mirrors the pulse-sync pattern) so loop.ts's static grep-guards stay intact.
  if (!stopRequested()) {
    trackDaemonTickEffect(
      tickRecord,
      import('../integrations/fleet-pulse-emit.js').then(async ({ emitTickCost }) => {
        try {
          await emitTickCost(cfg, tickRecord.ts, tickRecord.spentUsd, tickRecord.proposalsCreated, merged);
        } catch {
          // Best-effort — telemetry must never crash the daemon.
        }
      }).catch(() => { /* lazy-import best-effort */ }),
    );
  }

  // ── M257 Director cycle — gated, additive, fire-and-forget ─────────────────
  // Runs at most once every 15 minutes (tracked in process memory; dormant when
  // cfg.comms.director is absent/false — byte-identical to absent).
  // SAFETY: director is READ-ONLY god-view access in M257. No goal mutations,
  // no merge/push/apply, no bypass of any safety gate.
  if (!stopRequested()) void (() => {
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

      trackDaemonTickEffect(
        tickRecord,
        import('../comms/director.js').then(async ({ runDirectorCycle }) => {
          try {
            await runDirectorCycle(cfg, { signal: opts.signal });
          } catch {
            // Fire-and-forget — director must never crash the daemon.
          }
        }).catch(() => { /* lazy-import best-effort */ }),
      );
    } catch {
      // Gate check must never crash the daemon.
    }
  })();

  audit({
    action: 'daemon:tick',
    repo: null,
    sandboxId: null,
    summary: `tick ${tickRecord.reason}: ${selected.length} item(s) considered, ${proposalsCreated} proposal(s) created, ${merged} merged, $${tickSpent.toFixed(4)} spent`,
    result: tickRecord.reason === 'state-persistence-failed' ? 'error' : 'ok',
  });

  return tickRecord;
  } finally {
    releaseLocalStoreLock(postSettlementFence);
  }
  } finally {
    releaseGeneratedRepairReservations();
    stopLeaseRenewer();
  }
}

export async function runLegacyPulseExport(
  cfg: AshlrConfig,
  tickRecord: DaemonTick,
  opts: {
    sinceTs?: string;
    startedAt: string | null;
    signal?: AbortSignal;
    ownerLock?: DaemonLock;
  },
): Promise<void> {
  try {
    const { withPulseAuthority } = await import('../integrations/pulse-sync.js');
    await withPulseAuthority(
      opts.signal,
      () => undefined,
      async (authority, signal) => {
        if (signal?.aborted || killSwitchOn()) return;
        const { exportToPulse } = await import('../fleet/pulse-export.js');
        const ok = await exportToPulse(cfg, {
          sinceTs: opts.sinceTs,
          signal,
          authority: authority.fence,
        });
        if (!ok || signal?.aborted || killSwitchOn() || !opts.ownerLock) return;
        updateResidentDaemonState(opts.ownerLock, (fresh) => {
          if (
            fresh.running !== true ||
            fresh.pid !== opts.ownerLock!.pid ||
            fresh.startedAt !== opts.startedAt ||
            fresh.lastTickAt !== tickRecord.ts
          ) return null;
          return { ...fresh, lastPulseExportAt: tickRecord.ts };
        });
      },
    );
  } catch (err) {
    console.warn('[ashlr] daemon:tick pulse export failed:', (err as Error)?.message ?? err);
  }
}

async function runOwnedPulseSync(
  cfg: AshlrConfig,
  tickResult: DaemonTick,
  lock: DaemonLock,
  signal: AbortSignal,
  onOwnershipLost: () => void,
): Promise<void> {
  await drainDaemonTickEffects(tickResult);
  if (signal.aborted || tickResult.dryRun || tickResult.reason !== 'ok') return;
  if (!daemonLockOwned(lock)) {
    onOwnershipLost();
    return;
  }
  try {
    const { runPulseSync } = await import('../integrations/pulse-sync.js');
    if (signal.aborted || !daemonLockOwned(lock)) {
      if (!signal.aborted) onOwnershipLost();
      return;
    }
    await runPulseSync(cfg, { tickTs: tickResult.ts, signal });
  } catch (err) {
    console.warn('[ashlr] daemon: pulse-sync failed:', (err as Error)?.message ?? err);
  }
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
    const takeoverProof = staleResidentProof(state);
    if (!takeoverProof) {
      releaseDaemonLock(daemonLock);
      audit({
        action: 'daemon:start',
        repo: null,
        sandboxId: null,
        summary: `daemon start refused: persisted resident pid ${state.pid} is still live or cannot be disproved`,
        result: 'refused',
      });
      return loadDaemonState();
    }
    audit({
      action: 'daemon:stale-state-recovered',
      repo: null,
      sandboxId: null,
      summary: `authoritative lock acquired; clearing ${takeoverProof} resident state pid ${state.pid}`,
      result: 'ok',
    });
    state.running = false;
    state.pid = null;
    const recovered = saveResidentDaemonState(daemonLock, state);
    if (!recovered.ok) {
      releaseDaemonLock(daemonLock);
      return loadDaemonState();
    }
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
  const startSave = saveResidentDaemonState(daemonLock, state);
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
  const daemonStartedAt = state.startedAt;
  const daemonActivityInstanceId = randomUUID();
  const shutdown = new AbortController();
  let ownershipLost = false;
  let activityPhase: DaemonActivityPhase = 'starting';
  let activityActiveChildren: number | null = null;
  let activityEpoch = 0;
  const refreshActivity = (): void => {
    if (ownershipLost) return;
    writeDaemonActivity({
      instanceId: daemonActivityInstanceId,
      daemonStartedAt,
      phase: activityPhase,
      ...(activityPhase === 'post-tick' ? { activeChildren: activityActiveChildren ?? 0 } : {}),
    });
  };
  const transitionActivity = (phase: DaemonActivityPhase, activeChildren: number | null = null): number => {
    activityPhase = phase;
    activityActiveChildren = phase === 'post-tick' ? Math.max(0, activeChildren ?? 0) : null;
    activityEpoch++;
    refreshActivity();
    return activityEpoch;
  };
  refreshActivity();
  let scheduledResolutionObserver: ScheduledResolutionObserverChild | null = null;
  let scheduledCutoffCapture: ScheduledCutoffCapture | null = null;
  let forcedShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  const transitionToStopping = (): void => {
    if (ownershipLost) return;
    if (activityPhase !== 'stopping') transitionActivity('stopping');
  };
  const requestShutdown = (signal?: 'SIGINT' | 'SIGTERM'): void => {
    transitionToStopping();
    if (!shutdown.signal.aborted) shutdown.abort();
    scheduledResolutionObserver?.cancel();
    scheduledCutoffCapture?.cancel();
    if (forcedShutdownTimer === null) {
      const finalSignal = signal ?? 'SIGTERM';
      forcedShutdownTimer = setTimeout(() => {
        process.removeListener('SIGINT', requestSigint);
        process.removeListener('SIGTERM', requestSigterm);
        process.kill(process.pid, finalSignal);
      }, CUTOFF_CAPTURE_DEADLINE_MS);
      forcedShutdownTimer.unref?.();
    }
  };
  const requestSigint = (): void => requestShutdown('SIGINT');
  const requestSigterm = (): void => requestShutdown('SIGTERM');
  const requestOwnershipLoss = (): void => {
    if (ownershipLost) return;
    ownershipLost = true;
    if (!shutdown.signal.aborted) shutdown.abort();
    scheduledResolutionObserver?.cancel();
    scheduledCutoffCapture?.cancel();
  };
  const ownsDaemonLock = (): boolean => {
    if (ownershipLost) return false;
    if (daemonLockOwned(daemonLock)) return true;
    requestOwnershipLoss();
    return false;
  };
  const stopLockHeartbeat = startDaemonLockHeartbeat(
    daemonLock,
    refreshActivity,
    requestOwnershipLoss,
  );
  process.once('SIGINT', requestSigint);
  process.once('SIGTERM', requestSigterm);
  const killSwitchPoll = setInterval(() => {
    if (killSwitchOn()) requestShutdown();
    else if (!daemonLockOwned(daemonLock)) requestOwnershipLoss();
  }, KILL_SWITCH_POLL_MS);
  killSwitchPoll.unref?.();

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

  if (!opts.dryRun) reconcilePreparedGeneratedRepairReservations();

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
  } else if (killSwitchOn()) {
    requestShutdown();
    audit({
      action: 'daemon:start',
      repo: null,
      sandboxId: null,
      summary: 'orphan sweep deferred: autonomy kill switch is ON',
      result: 'refused',
    });
  } else {
    try {
      const wt = await import('../sandbox/worktree.js');
      // The sweep acquires the global outward-mutation fence once and rechecks
      // KILL after acquisition, closing the race with the check above.
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
      if (killSwitchOn()) requestShutdown();
      if (!shutdown.signal.aborted && ownsDaemonLock()) {
        transitionActivity('tick');
        const tickResult = await tick(liveCfg, {
          dryRun: opts.dryRun,
          ...(opts.drain ? { drain: opts.drain } : {}),
          ...(opts.drainLimit ? { drainLimit: opts.drainLimit } : {}),
          signal: shutdown.signal,
          ownerLock: daemonLock,
          onOwnershipLost: requestOwnershipLoss,
        });
        await runOwnedPulseSync(liveCfg, tickResult, daemonLock, shutdown.signal, requestOwnershipLoss);
        if (!shutdown.signal.aborted && ownsDaemonLock()) {
          recordContextRollupAfterTick(
            tickResult,
            opts,
            reloadLiveConfigForDaemon(liveCfg),
          );
        }
        if (!shutdown.signal.aborted) transitionActivity('idle');
      }
    } else {
      // M85/M116/M309: choose loop strategy from live config every iteration.
      // Batch mode sleeps between ticks; continuous mode loops immediately while
      // work is flowing and only sleeps on idle/no-op ticks.
      let cyclesLeft = opts.maxCycles ?? Infinity;
      while (true) {
        if (shutdown.signal.aborted) break;
        if (!ownsDaemonLock()) break;
        if (cyclesLeft-- <= 0) break;
        if (killSwitchOn() || shutdown.signal.aborted) break;

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
        transitionActivity('tick');
        const tickResult = await tick(liveCfg, {
          dryRun: opts.dryRun,
          ...(opts.drain ? { drain: opts.drain } : {}),
          ...(opts.drainLimit ? { drainLimit: opts.drainLimit } : {}),
          signal: shutdown.signal,
          ownerLock: daemonLock,
          onOwnershipLost: requestOwnershipLoss,
        });
        await runOwnedPulseSync(liveCfg, tickResult, daemonLock, shutdown.signal, requestOwnershipLoss);
        // Dry-run is inherently a one-shot PLAN: it records spentUsd:0 forever,
        // so the budget break can never fire. Terminate after a single iteration
        // (matching --once semantics) so a dry-run loop is BOUNDED, not endless.
        if (opts.dryRun) break;

        if (tickResult.reason === 'state-persistence-failed' &&
          tickResult.residentSafePersistenceFailure !== 'repair-treatment') {
          audit({
            action: 'daemon:persistence-failed',
            repo: null,
            sandboxId: null,
            summary: 'continuous daemon stopped after persistence authority failed; paid work remains dispatch-blocked',
            result: 'refused',
          });
          break;
        }

        if (killSwitchOn() || shutdown.signal.aborted || !ownsDaemonLock()) break;
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
        scheduledResolutionObserver = scheduleResolutionObserverAfterTick(tickResult, opts);
        scheduledCutoffCapture = scheduleCutoffCheckpointAfterTick(tickResult, opts);
        const postTickChildren: Promise<unknown>[] = [];
        if (scheduledResolutionObserver?.disposition === 'scheduled' ||
          scheduledResolutionObserver?.disposition === 'overlap-suppressed') {
          postTickChildren.push(scheduledResolutionObserver.completion);
        }
        if (scheduledCutoffCapture?.disposition === 'scheduled' ||
          scheduledCutoffCapture?.disposition === 'overlap-suppressed') {
          postTickChildren.push(scheduledCutoffCapture.completion);
        }
        if (postTickChildren.length > 0) {
          const postTickEpoch = transitionActivity('post-tick', postTickChildren.length);
          void Promise.allSettled(postTickChildren).then(() => {
            if (activityEpoch === postTickEpoch) transitionActivity('idle');
          });
        } else {
          transitionActivity('idle');
        }
        recordContextRollupAfterTick(tickResult, opts, afterTickCfg);
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
          if (!(await sleepUntilNextUtcBudgetDay(daemonLock, shutdown.signal))) break;
          continue;
        }

        const noWorkDispatched = !tickResult.dispatches?.some((dispatch) => dispatch.dispatched);

        if (afterLoopCfg.mode === 'continuous') {
          if (noWorkDispatched) {
            if (!(await sleep(afterLoopCfg.idleBackoffMs ?? 5_000, shutdown.signal))) break;
          }
        } else {
          if (!(await sleep(afterLoopCfg.intervalMs, shutdown.signal))) break;
        }

        if (!ownsDaemonLock()) break;
        if (killSwitchOn() || shutdown.signal.aborted) break;
      }
    }
  } catch {
    // Unexpected error — swallow; still clean up running state below.
  }
  transitionToStopping();
  clearInterval(killSwitchPoll);
  await cancelDaemonPostTickChildren(scheduledResolutionObserver, scheduledCutoffCapture);
  if (forcedShutdownTimer !== null) clearTimeout(forcedShutdownTimer);
  process.removeListener('SIGINT', requestSigint);
  process.removeListener('SIGTERM', requestSigterm);
  stopLockHeartbeat();

  // -------------------------------------------------------------------------
  // Clear running state on exit.
  // -------------------------------------------------------------------------
  const stillOwnsLock = ownsDaemonLock();
  if (stillOwnsLock) {
    const stopSave = updateResidentDaemonState(daemonLock, (current) =>
      current.pid === daemonLock.pid
        ? { ...current, running: false, pid: null }
        : null);
    if (!stopSave.ok) {
      audit({
        action: 'daemon:persistence-failed',
        repo: null,
        sandboxId: null,
        summary: `daemon stop could not persist stopped state (${stopSave.error})`,
        result: 'error',
      });
    }
  }
  state = loadDaemonState();

  if (stillOwnsLock) {
    audit({
      action: 'daemon:stop',
      repo: null,
      sandboxId: null,
      summary: 'daemon stopped',
      result: 'ok',
    });
  }

  // Restore ASHLR_IN_DAEMON to its prior value so a fresh runDaemon can run
  // again in the same process (a CLI process exits anyway; this matters for
  // programmatic reuse / tests). Child spawns already inherited it during the run.
  if (prevInDaemon === undefined) delete process.env['ASHLR_IN_DAEMON'];
  else process.env['ASHLR_IN_DAEMON'] = prevInDaemon;

  releaseDaemonLock(daemonLock);

  return loadDaemonState();
}

export async function cancelResolutionObserverBeforeShutdown(
  scheduled: ScheduledResolutionObserverChild | null,
): Promise<void> {
  if (!scheduled) return;
  scheduled.cancel();
  await scheduled.completion;
}

export async function cancelDaemonPostTickChildren(
  observer: ScheduledResolutionObserverChild | null,
  cutoff: ScheduledCutoffCapture | null,
): Promise<void> {
  observer?.cancel();
  cutoff?.cancel();
  await Promise.allSettled([
    ...(observer ? [observer.completion] : []),
    ...(cutoff ? [cutoff.completion] : []),
  ]);
}

// ---------------------------------------------------------------------------
// stopDaemon — request an orderly halt
// ---------------------------------------------------------------------------

/**
 * Set the kill switch (M21 ~/.ashlr/KILL). Idempotent; never throws. The
 * resident loop observes the request, aborts in-flight work, and remains the
 * sole authority that clears running/pid after the current tick settles.
 */
export function stopDaemon(): ReturnType<typeof setKill> {
  let result: ReturnType<typeof setKill>;
  try {
    result = setKill(true);
  } catch (err) {
    // setKill is idempotent + never throws by contract; extra guard
    result = {
      ok: false,
      changed: false,
      quiesced: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    audit({
      action: 'daemon:stop',
      repo: null,
      sandboxId: null,
      summary: result.ok && result.quiesced
        ? 'stopDaemon() called: stop requested via kill switch and outward mutations quiesced'
        : `stopDaemon() could not confirm stop: ${result.reason}`,
      result: result.ok && result.quiesced ? 'ok' : 'error',
    });
  } catch {
    // Audit best-effort
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Promise-based sleep that wakes promptly for an orderly daemon shutdown. */
function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) { resolveSleep(false); return; }
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolveSleep(completed);
    };
    const timer = setTimeout(() => finish(true), Math.max(0, ms));
    const onAbort = (): void => { clearTimeout(timer); finish(false); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

async function sleepUntilNextUtcBudgetDay(lock: DaemonLock, signal?: AbortSignal): Promise<boolean> {
  const maxChunkMs = 60_000;
  const wakeAtMs = nextUtcBudgetDayStartMs();
  while (true) {
    if (killSwitchOn()) return false;
    const remainingMs = msUntilUtcTimestamp(wakeAtMs);
    if (remainingMs <= 0) return true;
    if (!(await sleep(Math.min(maxChunkMs, remainingMs + 1), signal))) return false;
    if (!daemonLockOwned(lock)) return false;
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
