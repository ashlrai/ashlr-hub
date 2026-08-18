/**
 * M49: fleet control plane + observability — read-only aggregation.
 *
 * `buildFleetStatus(cfg)` is a single READ-ONLY snapshot of the whole fleet:
 * the daemon's liveness + today's spend, per-backend recent dispatch counts and
 * quota status, the backlog queue size, the inbox proposal counts (pending /
 * frontier-pending / applied), recent auto-merges, and whether the global kill
 * switch is engaged.
 *
 * SAFETY: this NEVER mutates anything and NEVER throws. Every underlying source
 * is wrapped in its own try/catch with a sane fallback, so a single broken
 * source (corrupt daemon state, absent backlog, etc.) degrades only its own
 * slice — the rest of the snapshot still resolves. It adds NO capability: it
 * only reads what the daemon/quota/inbox/backlog modules already persist.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { readBuildIdentity, type BuildIdentity } from '../build-identity.js';
import type {
  AshlrConfig,
  AutoMergeTrustBasis,
  DaemonDispatchTrace,
  DaemonTick,
  EngineId,
  EngineTier,
  PhantomAgentReportRollup,
  Proposal,
  WorkItem,
} from '../types.js';
import { realizedMergeOf } from '../inbox/realized-merge.js';
import type { SharedQueueHealth } from './shared-store.js';
import type {
  AutonomyEvidencePack,
  AutonomyEvidencePacksReadResult,
  AutonomyEvidenceSourceQuality,
} from '../autonomy/evidence-pack.js';
import type { ResourceStrategyReport } from '../autonomy/resource-strategy.js';
import { goalFocusSnapshot } from '../goals/focus.js';
import { createProposalMilestoneCompletionPredicate } from '../goals/completion.js';
import { listGoalsDetailed, type ListGoalsDetailedResult } from '../goals/store.js';
import {
  listAttemptRecords,
  summarizeAttemptCoverage,
  type AttemptRecordCoverage,
  type AttemptCoverageStatus,
} from '../autonomy/attempt-records.js';
import { listOutcomeRecords, type OutcomeRecord } from '../autonomy/outcome-records.js';
import {
  readGeneratedRepairQueueSnapshot,
  type GeneratedRepairDispatchState,
} from './generated-repair-lifecycle.js';
import {
  inspectGeneratedRepairRouteFeasibility,
  type GeneratedRepairRouteFeasibility,
  type GeneratedRepairRouteReason,
} from './router.js';
import {
  readRepairHandoffs,
  readRepairHandoffSchemaSummary,
  validRepairHandoffV2Activation,
  type RepairHandoffV2Activation,
  type RepairHandoffSchemaSummary,
} from './repair-handoff-journal.js';
import {
  listTrajectoryRecords,
  MIN_SKILL_OBSERVED_TRAJECTORIES,
  suppressDegradedSkillObservation,
  summarizeTrajectoryLearning,
  type TrajectoryRecordCoverage,
  type TrajectoryLearningStatus,
} from '../autonomy/trajectory-records.js';
import {
  inspectVerifiedSkillCorpus,
  SKILL_RETRIEVAL_POLICY_VERSION,
} from './skill-retrieval.js';
import { readSkillCardCorpus, readSkillUseEventsWithDiagnostics } from './skill-records.js';
import type { GuardHealthDiagnosis } from '../daemon/guard-health.js';
import type { DaemonActivationReadiness } from '../daemon/activation-permit.js';
import type { EcosystemDoctorReport } from '../ecosystem/doctor.js';
import type { BackendAvailability, BackendResourceState } from '../fabric/resource-monitor.js';
import { strategicTierOfRepo, type StrategicTier } from '../ecosystem/focus.js';
import { readEnrollmentRegistry } from '../sandbox/policy.js';
import { loadQueuedAutonomyItemsDetailed } from '../portfolio/queued-autonomy.js';
import {
  detectRepoExecutionProfile,
  type RepoPackageManager,
  type RepoProjectKind,
} from '../run/repo-profile.js';
import { engineInstalled } from '../run/engines.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import type { RoutingLearningAuthority } from '../run/learned-router.js';
import {
  DEFAULT_COOLDOWN_MS,
  GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS,
  isSuppressibleWorkedOutcome,
  latestWorkedEventForKeys,
  loadWorkedLedgerDetailed,
  type WorkedEvent,
  type WorkedLedgerReadResult,
} from './worked-ledger.js';
import { selectWorkQueueCoordinator } from '../seams/work-queue-coordinator.js';
import {
  blockingPendingProposalsForBacklog,
  pendingProposalItemKeysForBacklog,
  workItemCoverageKey,
} from './proposal-matching.js';
import {
  readDispatchProductionYieldDetailed,
  type DispatchProductionEvent,
  type DispatchProductionSourceQuality,
  type DispatchProductionYieldBucket,
  type DispatchProductionYieldSummary,
} from './dispatch-production-ledger.js';
import {
  buildProposalFunnelObservability,
  withholdProposalFunnelForUnstableSnapshot,
  type ProposalFunnelObservability,
} from './proposal-funnel-observability.js';
import { readDecisionsDetailed, type DecisionSourceQuality } from './decisions-ledger.js';
import { readJudgeTracesDetailed, type JudgeTraceSourceQuality } from './judge-trace.js';
import type { DispatchManifestSourceQuality } from './dispatch-manifest.js';
import {
  readBestOfNRecordsDetailed,
  type BestOfNSourceQuality,
} from './best-of-n-ledger.js';
import {
  readAgentWorkspaceDetailed,
  type AgentWorkspaceReadResult,
  type AgentWorkspaceStatus,
} from './agent-action-ledger.js';
import {
  buildContextEfficiencyStatus,
  type FleetContextEfficiencyStatus,
} from './context-efficiency.js';
import {
  buildFleetLaneLocks,
  type FleetLaneLocksStatus,
  type FleetLaneLockSourceQualityPart,
  type FleetLaneLockSourceReason,
} from './lane-lock.js';
import { isTrustedGeneratedRepairItem } from './self-heal-trust.js';
import { defaultBranch } from '../git.js';
import {
  readResolutionObserverStatus,
  type ResolutionObserverStatus,
} from './resolution-observer.js';
import {
  readPostMergeObservations,
  type PostMergeObservationReadResult,
} from './post-merge-observations.js';
import {
  postMergeStabilityRepoDigest,
  readPostMergeStability,
  type PostMergeStabilityCohortSummary,
  type PostMergeStabilityReadResult,
} from './post-merge-stability.js';
import {
  readDetachedPostMergeVerificationCohorts,
  type DetachedPostMergeVerificationSummary,
} from './detached-post-merge-verification.js';
import {
  projectDetachedPostMergeDenominator,
  readCurrentDetachedPostMergeDenominator,
  readDetachedPostMergeWorkTickets,
  type DetachedPostMergeWorkTicketReadResult,
} from './detached-post-merge-orchestrator.js';
import {
  readFleetCutoffCheckpointStatus,
  type FleetCutoffCheckpointStatus,
} from './cutoff-observation-status.js';
import {
  AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
  type AutoMergeCanaryBlockerV1,
  type AutoMergeCanaryBudgetsV1,
  type AutoMergeCanaryCountersV1,
  type AutoMergeCanaryReadResult,
  type AutoMergeCanaryShadowCountersV1,
  type AutoMergeCanaryShadowEvidenceV1,
} from './automerge-canary-store.js';
import {
  evaluateAutoMergeCanaryPromotionReadiness,
  type AutoMergeCanaryPromotionReadiness,
  type AutoMergeCanaryPromotionReadinessInput,
} from './automerge-canary-promotion-readiness.js';
import {
  autoMergeCanaryConfigDigest,
  autoMergeCanaryPolicyDigest,
} from './automerge-canary-observer.js';
import { resolveAutoMergeScopePolicy } from '../foundry/automerge-scope-policy.js';

export interface FleetBackendResourceStatus {
  availability: BackendAvailability | 'not-sensed';
  usedPct: number | null;
  cap: number | null;
  capUnit: BackendResourceState['capUnit'];
  capWindow: string | null;
  resetsAt: number | null;
  reason: string;
  snapshotAt: string | null;
}

/** A single backend's recent activity + quota standing. */
export interface FleetBackendStatus {
  /** The backend id (e.g. 'builtin', 'claude', 'codex'). */
  backend: EngineId;
  /** Dispatches recorded for this backend in the recent window (last 24h). */
  dispatchesRecent: number;
  /** Quota standing: 'unlimited' when no rate limit is configured. */
  quota: 'ok' | 'warn' | 'over' | 'unlimited';
  /** Resource availability for the allowed backend, when sensed or explicitly unsensed. */
  resource?: FleetBackendResourceStatus;
}

export interface FleetGoalFocusStatus {
  enabled: boolean;
  activeThreshold: number;
  activeGoalCount: number;
  actionableActiveGoalCount: number;
  planningGoalCount: number;
  deferredNewGoalWork: boolean;
  reason: 'disabled' | 'below-threshold' | 'active-goal-work-in-flight';
  visibleGoalBacklogItems: number;
  visibleInventBacklogItems: number;
}

/** Shared filesystem queue health, when multi-machine queueing is enabled. */
export interface FleetSharedQueueStatus extends SharedQueueHealth {
  enabled: boolean;
  mode: 'filesystem';
  machineId: string;
  trustedCoherentStorage: boolean;
  authorityReady: boolean;
}

export type FleetPhantomState = 'ready' | 'not-installed' | 'not-initialized' | 'degraded';

export interface FleetPhantomStatus {
  observedAt: string;
  state: FleetPhantomState;
  installed: boolean;
  initialized: boolean;
  version: string | null;
  valueMode: 'metadata-and-names-only';
  secretCount: number;
  knownFleetSecrets: {
    total: number;
    presentCount: number;
    missingCount: number;
    pulseCredentialPresent: boolean;
    nimApiKeyPresent: boolean;
  };
  capabilities: {
    metadataStatus: boolean;
    childEnvInjectionAvailable: boolean;
    mcpServerAvailable: boolean;
    mutationRequiresHumanApproval: boolean;
  };
  commands: {
    commandsKnown: boolean;
    setupAvailable: boolean;
    execAvailable: boolean;
    mcpAvailable: boolean;
    agentAvailable: boolean;
  };
  agentReport?: PhantomAgentReportRollup;
  config: {
    phantomExecEnabled: boolean;
    fleetSecretInjectionEnabled: boolean;
  };
  mcp: {
    configured: boolean;
  };
  error?: string;
}

export interface FleetAutonomyEvidenceSummary {
  proposalId: string;
  generatedAt: string;
  title: string;
  tier: string | null;
  action: string | null;
  allowed: boolean | null;
  target: AutonomyEvidencePack['target'];
  riskClass: AutonomyEvidencePack['riskClass'];
  verificationPassed: boolean;
  changedFiles: number;
  changedLines: number;
  reason: string | null;
}

export interface FleetAutonomyStatus {
  evidencePacks: number;
  latestAt: string | null;
  allowed: number;
  denied: number;
  byTier: Record<string, number>;
  recent: FleetAutonomyEvidenceSummary[];
  /** Fail-closed health of the signed evidence authority store. */
  authorityState: 'ready' | 'cold-start' | 'degraded';
  protocols: {
    sealedV3: number;
    legacy: number;
  };
  sourceQuality: AutonomyEvidenceSourceQuality;
}

export interface FleetAutonomyDirectionSummary {
  generatedAt: string;
  mode: ResourceStrategyReport['mode'];
  confidence: ResourceStrategyReport['confidence'];
  reasons: string[];
  recommendedActions: string[];
  resources: Pick<ResourceStrategyReport['resources'], 'posture' | 'constrained' | 'depleted'>;
  guardHealth: {
    blocked: boolean;
    blocks: number;
  };
  budgets: Pick<ResourceStrategyReport['budgets'], 'daemonBudgetLevel' | 'daemonSpentTodayUsd'>;
  productionVelocity: Pick<
    ResourceStrategyReport['productionVelocity'],
    'enabled' | 'profile' | 'fillQueueToSlots' | 'stalePendingTtlHours' | 'maxSlotsPerBackend' | 'caps' | 'flags'
  >;
}

export type FleetAutonomyControlMode = 'disabled' | 'advisory' | 'executable';

export interface FleetAutoMergeBlockerSummary {
  proposalId: string;
  title: string;
  tier: string | null;
  reason: string;
  riskClass: string | null;
}

export interface FleetAutoMergeVerifierContractGap {
  proposalId: string;
  title: string;
  repo: string;
  name: string;
  withoutVerifyCommands: boolean;
  withoutExplicitMergeContract: boolean;
  reason: string;
}

export interface FleetAutoMergeVerifierContractStatus {
  pendingNeedingVerification: number;
  withoutVerifyCommands: number;
  withoutExplicitMergeContract: number;
  recentGaps: FleetAutoMergeVerifierContractGap[];
}

export interface FleetAutoMergeReadinessStatus {
  enabled: boolean;
  trustBasis: AutoMergeTrustBasis;
  pending: number;
  /** Cheap static candidates; this is observational and does not imply merge authority. */
  preflightReady: number;
  /** Candidates whose currently persisted evidence clears the read-only authority gate. */
  authorityReady?: number;
  /** Authority-ready branch-only candidates, which do not depend on protected-main state. */
  branchAuthorityReady?: number;
  /** Main-target candidates before protected-remote status is applied. */
  remoteMainAuthorityReady?: number;
  /** Cheap candidates withheld because authority evidence is absent or untrustworthy. */
  authorityBlocked?: number;
  authorityByReason?: Record<string, number>;
  needsVerification: number;
  knownVerificationFailed: number;
  blocked: number;
  byReason: Record<string, number>;
  recentBlockers: FleetAutoMergeBlockerSummary[];
  verifierContracts?: FleetAutoMergeVerifierContractStatus;
  configurationBlocker?: string;
  remoteProtection?: {
    required: boolean;
    configured: 'exact' | 'legacy' | 'invalid' | 'missing';
    live: 'protected' | 'unprotected' | 'unavailable' | 'unobserved';
    coverage: 'complete' | 'partial' | 'unscoped';
    observedAt: string | null;
    reposObserved: number;
    reposRequired: number;
    detail: string;
  };
}

export interface FleetProposalSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: string[];
  filesDiscovered: number;
  filesRead: number;
  invalidFiles: number;
  unreadableFiles: number;
}

export interface FleetProposalAuthoritySource {
  gate: 'ready' | 'unavailable';
  detail: string;
}

function proposalAuthoritySource(
  quality: FleetProposalSourceQuality,
): FleetProposalAuthoritySource {
  if (quality.sourceState === 'healthy' && quality.sourcePresent && quality.complete) {
    return {
      gate: 'ready',
      detail: `complete proposal source (${quality.filesRead}/${quality.filesDiscovered} files read)`,
    };
  }
  const reasons = quality.stopReasons.length > 0
    ? `: ${quality.stopReasons.join(', ')}`
    : '';
  return {
    gate: 'unavailable',
    detail: `auto-merge authority requires a complete healthy proposal source; ` +
      `${quality.sourceState} source is ${quality.sourcePresent ? 'present' : 'absent'} and ` +
      `${quality.complete ? 'complete' : 'incomplete'}${reasons}`,
  };
}

function remoteProtectionAuthorityReady(readiness: FleetAutoMergeReadinessStatus): boolean {
  const protection = readiness.remoteProtection;
  return !protection || !protection.required || (
    protection.configured === 'exact' &&
    protection.live === 'protected' &&
    protection.coverage === 'complete' &&
    protection.observedAt !== null &&
    Number.isFinite(Date.parse(protection.observedAt)) &&
    Date.now() - Date.parse(protection.observedAt) <= READINESS_REMOTE_PROTECTION_STALE_MS
  );
}

export type FleetNextActionCommandSafety =
  | 'read-only'
  | 'control-plane'
  | 'autonomous-dispatch'
  | 'manual';

export interface FleetNextActionCommand {
  label: string;
  argv: string[];
  shell: string;
  safety: FleetNextActionCommandSafety;
  cwd?: string;
  endpointMethod?: 'GET' | 'POST';
  endpointPath?: string;
  tokenRequired?: boolean;
  note?: string;
}

export interface FleetNextAction {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  label: string;
  detail: string;
  target?: string;
  commands?: FleetNextActionCommand[];
}

export type FleetAutonomyEffectivenessPhase =
  | 'control-blocked'
  | 'host-handoff'
  | 'merge-ready'
  | 'verification-needed'
  | 'merge-blocked'
  | 'proposal-starved'
  | 'route-gated'
  | 'cooldown-gated'
  | 'idle';

export interface FleetAutonomyEffectivenessStatus {
  phase: FleetAutonomyEffectivenessPhase;
  canAutoMergeNow: boolean;
  bottleneck:
    | 'control'
    | 'host-handoff'
    | 'merge-drain'
    | 'verification'
    | 'merge-gate'
    | 'proposal-production'
    | 'routing'
    | 'cooldown'
    | 'none';
  summary: string;
  counts: {
    backlogItems: number;
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    repairRouteBlockedItems?: number;
    nextEligibleAt?: string | null;
    pendingProposals: number;
    frontierPending: number;
    awaitingHostMerge: number;
    preflightReady: number;
    authorityReady?: number;
    needsVerification: number;
    blocked: number;
    knownVerificationFailed: number;
    recentMerges: number;
  };
}

export type FleetAutonomousShipReadinessVerdict = 'ready' | 'blocked' | 'degraded' | 'idle' | 'unknown';
export type FleetAutonomousShipReadinessConfidence = 'high' | 'medium' | 'low';
export type FleetReadinessSourceStatus = 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';
export type FleetReadinessFreshness = 'fresh' | 'stale' | 'unknown' | 'not-applicable';
export type FleetReadinessSourceQualityBadge =
  | 'healthy-source'
  | 'healthy-zero'
  | 'degraded-source'
  | 'missing-source'
  | 'stale-source'
  | 'unknown-source';
export type FleetReadinessSourceCategory = 'operations' | 'evidence';
export type FleetReadinessEvidenceEligibility =
  | 'eligible' | 'cold-start' | 'withheld' | 'observational' | 'not-applicable';
export type FleetReadinessEvidenceRole =
  | 'merge-authority' | 'merge-gate' | 'learning' | 'analytics' | 'forensics';
export type FleetReadinessEvidenceApplicability = 'required' | 'optional' | 'disabled';

export interface FleetReadinessEvidenceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: readonly string[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface FleetDetachedPostMergeVerificationReadiness {
  version: 1;
  authority: 'observation-only';
  policyEligible: false;
  mergePermitted: false;
  rollbackPermitted: false;
  deployPermitted: false;
  state: 'missing' | 'degraded' | 'awaiting-observations' | 'incomplete' | 'conclusive';
  latestObservedAt: string | null;
  passRate: number | null;
  denominator: {
    candidateSetDigest: string | null;
    eligibleCandidates: number;
    observedCandidates: number;
    conclusiveCandidates: number;
    unobservedCandidates: number;
    pass: number;
    fail: number;
    unknown: number;
    queuedCandidates: number;
  };
  summary: DetachedPostMergeVerificationSummary;
}

export interface FleetPostMergeCompositeProjection {
  source: FleetReadinessEvidenceQuality;
  cohort?: NonNullable<FleetStatus['postMergeCohort']>;
}

export interface FleetReadinessSourceQuality {
  badge: FleetReadinessSourceQualityBadge;
  label: string;
  empty: boolean;
  sourcePresent: boolean;
  detail: string;
}

export interface FleetSkillCorpusReadiness {
  version: 1;
  mode: 'shadow';
  policyVersion: string;
  corpus: {
    state: 'no-cards' | 'degraded' | 'ready';
    sourceQuality: FleetReadinessSourceQuality;
  };
  eligibleSignedCards: 'none' | 'available';
  selectedObservations: 'none' | 'present' | 'degraded';
  learning: {
    state:
      | 'blocked-no-cards'
      | 'blocked-corpus-degraded'
      | 'blocked-observation-degraded'
      | 'awaiting-eligible-cards'
      | 'awaiting-selection'
      | 'k-gated'
      | 'observable';
    minimumObservedTrajectories: number;
    sampleState: 'none' | 'unavailable' | 'insufficient-sample' | 'observed';
    observedTrajectoryCoverage?: { count: number; rate: number };
  };
}

export interface FleetSkillCorpusReadinessInput {
  corpusState: FleetSkillCorpusReadiness['corpus']['state'];
  corpusSourceQuality: FleetReadinessSourceQuality;
  eligibleSignedCards: FleetSkillCorpusReadiness['eligibleSignedCards'];
  skillObservation?: TrajectoryLearningStatus['skillObservation'];
  observationState?: 'none' | 'present' | 'degraded';
  policyVersion?: string;
}

export function buildSkillCorpusReadiness(
  input: FleetSkillCorpusReadinessInput,
): FleetSkillCorpusReadiness {
  const observedCoverage = input.skillObservation?.observedTrajectoryCoverage;
  const selectedObservations = input.observationState === 'degraded'
    ? 'degraded'
    : input.observationState === 'present' || input.skillObservation?.eventState === 'present'
      ? 'present'
      : input.skillObservation?.sampleState === 'none' || input.skillObservation === undefined
        ? 'none'
        : 'present';
  const sampleState = selectedObservations === 'degraded'
    ? 'unavailable'
    : selectedObservations === 'none'
      ? 'none'
      : input.skillObservation?.sampleState === 'observed'
        ? 'observed'
        : 'insufficient-sample';
  const state: FleetSkillCorpusReadiness['learning']['state'] =
    input.corpusState === 'degraded'
      ? 'blocked-corpus-degraded'
      : selectedObservations === 'degraded'
        ? 'blocked-observation-degraded'
        : input.corpusState === 'no-cards'
          ? 'blocked-no-cards'
          : input.eligibleSignedCards === 'none'
            ? 'awaiting-eligible-cards'
            : selectedObservations === 'none'
              ? 'awaiting-selection'
              : sampleState === 'observed'
                ? 'observable'
                : 'k-gated';

  return {
    version: 1,
    mode: 'shadow',
    policyVersion: input.policyVersion ?? SKILL_RETRIEVAL_POLICY_VERSION,
    corpus: {
      state: input.corpusState,
      sourceQuality: input.corpusSourceQuality,
    },
    eligibleSignedCards: input.eligibleSignedCards,
    selectedObservations,
    learning: {
      state,
      minimumObservedTrajectories: MIN_SKILL_OBSERVED_TRAJECTORIES,
      sampleState,
      ...(sampleState === 'observed' && observedCoverage
        ? { observedTrajectoryCoverage: observedCoverage }
        : {}),
    },
  };
}

async function readSkillCorpusReadiness(
  skillObservation: TrajectoryLearningStatus['skillObservation'] | undefined,
  observationState: 'none' | 'present' | 'degraded',
): Promise<FleetSkillCorpusReadiness> {
  try {
    const corpusResult = readSkillCardCorpus();
    const inspection = inspectVerifiedSkillCorpus(corpusResult.cards);
    const degraded = corpusResult.sourceState === 'degraded' || inspection.conflicting > 0;
    const corpusState: FleetSkillCorpusReadiness['corpus']['state'] = degraded
      ? 'degraded'
      : corpusResult.cards.length === 0
        ? 'no-cards'
        : 'ready';
    const detail = corpusState === 'degraded'
      ? corpusResult.limitExceeded
        ? 'signed skill corpus exceeds bounded read limits'
        : inspection.conflicting > 0
          ? 'signed skill corpus has conflicting current revisions'
          : corpusResult.invalidRows > 0
            ? 'signed skill corpus contains invalid lifecycle rows'
            : `signed skill corpus is incomplete (${corpusResult.unreadableFiles} unreadable partition(s))`
      : corpusState === 'no-cards'
        ? corpusResult.sourceState === 'missing'
          ? 'no signed skill card ledger exists yet'
          : 'signed skill corpus is readable and contains no cards'
        : 'signed skill corpus is readable';
    const sourceQuality = readinessSourceQuality({
      status: degraded ? 'degraded' : corpusResult.sourceState === 'missing' ? 'unavailable' : 'healthy',
      freshness: 'fresh',
      empty: corpusState === 'no-cards',
      sourcePresent: corpusResult.sourcePresent,
      sourceDegraded: degraded,
      detail,
    });

    return buildSkillCorpusReadiness({
      corpusState,
      corpusSourceQuality: sourceQuality,
      eligibleSignedCards: inspection.eligible > 0 ? 'available' : 'none',
      skillObservation,
      observationState,
      policyVersion: SKILL_RETRIEVAL_POLICY_VERSION,
    });
  } catch {
    return buildSkillCorpusReadiness({
      corpusState: 'degraded',
      corpusSourceQuality: readinessSourceQuality({
        status: 'degraded',
        freshness: 'fresh',
        empty: false,
        sourcePresent: true,
        sourceDegraded: true,
        detail: 'signed skill corpus diagnostics are unavailable',
      }),
      eligibleSignedCards: 'none',
      skillObservation,
      observationState: 'degraded',
    });
  }
}

export interface FleetReadinessSourceHealth {
  id:
    | 'daemon' | 'guard' | 'auto-merge' | 'queue' | 'lane-locks' | 'resources' | 'direction' | 'phantom'
    | 'decisions' | 'judge-traces' | 'agent-actions' | 'dispatch-production'
    | 'dispatch-manifests' | 'best-of-n' | 'post-merge' | 'autonomy-packs';
  label: string;
  status: FleetReadinessSourceStatus;
  badge: 'healthy' | 'degraded' | 'blocked' | 'unavailable' | 'unknown';
  freshness: FleetReadinessFreshness;
  observedAt: string | null;
  ageMs: number | null;
  detail: string;
  sourceQuality?: FleetReadinessSourceQuality;
  category?: FleetReadinessSourceCategory;
  evidenceRole?: FleetReadinessEvidenceRole;
  eligibility?: FleetReadinessEvidenceEligibility;
  applicability?: FleetReadinessEvidenceApplicability;
  actionSynthesis?: 'eligible' | 'observational-only';
  evidenceQuality?: FleetReadinessEvidenceQuality;
}

export interface FleetAutonomousShipReadinessBlocker {
  id: string;
  label: string;
  detail: string;
  severity: FleetNextAction['priority'];
  source: FleetReadinessSourceHealth['id'] | 'fleet';
}

export interface FleetAutonomousShipReadinessStatus {
  verdict: FleetAutonomousShipReadinessVerdict;
  confidence: FleetAutonomousShipReadinessConfidence;
  freshness: {
    generatedAt: string;
    overall: Exclude<FleetReadinessFreshness, 'not-applicable'>;
    freshestAt: string | null;
    stalestAt: string | null;
    maxAgeMs: number | null;
    staleSources: number;
    unknownSources: number;
  };
  topBlocker: FleetAutonomousShipReadinessBlocker | null;
  primaryAction: FleetNextAction | null;
  sources: FleetReadinessSourceHealth[];
  sourceSummary: Record<FleetReadinessSourceStatus, number>;
  sourceQualitySummary?: Record<FleetReadinessSourceQualityBadge, number>;
  evidenceMatrix?: {
    version: 1;
    state: 'eligible' | 'cold-start' | 'degraded';
    sources: FleetReadinessSourceHealth[];
    summary: Record<FleetReadinessEvidenceEligibility, number>;
  };
}

export interface FleetMissionBriefEvidence {
  readinessVerdict: FleetAutonomousShipReadinessVerdict | null;
  effectivenessPhase: FleetAutonomyEffectivenessPhase | null;
  bottleneck: FleetAutonomyEffectivenessStatus['bottleneck'] | null;
  queueBacklogItems: number;
  eligibleBacklogItems: number;
  pendingProposals: number;
  preflightReady: number;
  guardBlocked: boolean;
}

export interface FleetMissionBrief {
  generatedAt: string;
  directive: string;
  confidence: FleetAutonomousShipReadinessConfidence;
  operatingMode: string;
  blocker: FleetAutonomousShipReadinessBlocker | null;
  action: FleetNextAction | null;
  whyNow: string;
  evidence: FleetMissionBriefEvidence;
}

export interface FleetProposalProductionReasonSummary {
  reason: string;
  count: number;
}

export interface FleetProposalProductionDispatchSummary {
  ts: string;
  itemId: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  backend: EngineId | null;
  productionOutcome?: string;
  reason: string;
}

export interface FleetProposalProductionStatus {
  windowHours: number;
  selected: number;
  claimed: number;
  dispatched: number;
  skipped: number;
  errors: number;
  proposalsCreated: number;
  noProposalDispatches: number;
  suppressedDispatches: number;
  diagnosticNoProposalDispatches: number;
  topReasons: FleetProposalProductionReasonSummary[];
  diagnosticTopReasons: FleetProposalProductionReasonSummary[];
  skipReasons: FleetProposalProductionReasonSummary[];
  recentNoProposalDispatches: FleetProposalProductionDispatchSummary[];
  recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[];
}

export type FleetDispatchYieldDiagnosticVerdict =
  | 'actionable'
  | 'healthy'
  | 'insufficient-sample'
  | 'policy-suppressed';

export type FleetDispatchYieldDiagnosticAction =
  | 'route-same-tier-alternative'
  | 'tighten-context-or-reslice'
  | 'collect-more-samples'
  | 'keep-routing';

export interface FleetDispatchYieldDiagnosticCandidate {
  scope: 'fleet' | 'backend' | 'backend-model' | 'backend-source';
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  model?: string | null;
  diagnosticAttempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  policyDisabled: number;
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  sameTierOnly: boolean;
  topReason?: string;
  attemptShape?: DispatchProductionYieldSummary['attemptShape'];
  generatedRepairAttempts?: DispatchProductionYieldSummary['generatedRepairAttempts'];
}

export interface FleetDispatchYieldDiagnostics {
  windowHours: number;
  minAttempts: number;
  lowYieldRate: number;
  diagnosticAttempts: number;
  proposalsCreated: number;
  proposalRate: number;
  policyDisabled: number;
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  sameTierOnly: boolean;
  recommendation: string;
  topReason?: string;
  attemptShape?: DispatchProductionYieldSummary['attemptShape'];
  generatedRepairAttempts?: DispatchProductionYieldSummary['generatedRepairAttempts'];
  primaryCandidate?: FleetDispatchYieldDiagnosticCandidate;
  candidates: FleetDispatchYieldDiagnosticCandidate[];
}

export interface FleetDispatchManifestRecent {
  manifestId: string;
  ts: string;
  assigned: number;
  unassigned: number;
  backends: Record<string, number>;
  resourceSnapshotAt?: string;
}

export interface FleetDispatchManifestStatus {
  events: number;
  latestAt: string | null;
  assigned: number;
  unassigned: number;
  byBackend: Array<{ backend: string; assignments: number }>;
  recent: FleetDispatchManifestRecent[];
}

export interface FleetQueueNextItem {
  id: string;
  title: string;
  repo: string;
  source: WorkItem['source'];
  score: number;
}

export interface FleetQueueInventorySourceStatus {
  provenance: 'persisted-backlog' | 'queued-autonomy';
  sourceState: 'complete' | 'missing' | 'unavailable';
  freshness: 'fresh' | 'stale' | 'unknown' | 'empty';
  observedAt: string | null;
  visibleItems: number;
  actionableItems: number;
  detail: string;
}

export interface FleetQueueGeneratedWorkStatus {
  total: number;
  selfHeal: number;
  proposalRepair: number;
  captureRepairs: number;
  diagnosticReslices: number;
  diagnosticResliceDrainStalled?: boolean;
  invent: number;
}

export interface FleetGeneratedRepairRouteStatus {
  scope: 'eligible-claim-candidates';
  authority: 'observation-only';
  trustedItems: number;
  feasibleItems: number;
  unavailableItems: number;
  requiresAlternativeItems: number;
  byReason: Array<{ reason: GeneratedRepairRouteReason; count: number }>;
  blockedItems?: Array<{
    itemId: string;
    reason: Exclude<GeneratedRepairRouteReason, 'feasible'>;
  }>;
  blockedItemsOmitted?: number;
}

const MAX_GENERATED_REPAIR_ROUTE_BLOCKED_ITEMS = 50;
const MAX_GENERATED_REPAIR_ROUTE_ITEM_ID = 160;

function boundedRepairRouteItemId(itemId: string): string {
  if (itemId.length <= MAX_GENERATED_REPAIR_ROUTE_ITEM_ID) return itemId;
  const digest = createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-route-item:v1', itemId]))
    .digest('hex');
  return `sha256:${digest}`;
}

export interface FleetQueueScannerEvidenceStatus {
  state: 'healthy' | 'degraded' | 'unknown';
  observations: number;
  present: number;
  absent: number;
  unavailable: number;
  scannerDomains: number;
}

export interface FleetResolutionObserverStatus extends ResolutionObserverStatus {
  freshness: 'missing' | 'current' | 'stale' | 'degraded';
  lagMs: number | null;
}

export interface FleetActiveWorkStatus {
  source: 'daemon-spend-guard';
  path: string;
  exists: true;
  malformed: boolean;
  pid: number | null;
  hostname: string | null;
  armedAt: string | null;
  ageMs: number | null;
  itemCount: number;
  itemIds: string[];
  error?: string;
}

export interface FleetDiagnosticResliceDrainStatus {
  mode: 'diagnostic-reslices';
  latestAt: string;
  available: number;
  selected: number;
  limit?: number;
  capped?: boolean;
  automatic?: boolean;
  selectedItemIds?: string[];
  stalled?: boolean;
  dispatched: number;
  skipped: number;
  errors: number;
  proposalsCreated: number;
  noProposalDispatches: number;
  topReasons?: Array<{ reason: string; count: number }>;
}

export interface FleetRepairHandoffRolloutStatus {
  summaryAvailable: boolean;
  writerConfigured: boolean;
  writerEnabled: boolean;
  writerEffective: boolean;
  writerBlockedReason: 'missing-activation' | 'activation-in-future' | 'shared-queue-filesystem' | 'source-degraded' | null;
  activationId: string | null;
  activatedAt: string | null;
  phase: 'reader-only' | 'awaiting-evidence' | 'v2-healthy' | 'mixed-healthy' | 'blocked' | 'degraded';
  sourceState: 'missing' | 'healthy' | 'degraded';
  v1Authorities: number | null;
  v2Authorities: number | null;
  v1PhysicalRows: number | null;
  v2PhysicalRows: number | null;
  aliasFamilies: number | null;
  latestV2At: string | null;
  currentActivationV2Authorities: number | null;
  unboundV2Authorities: number | null;
  latestCurrentActivationV2At: string | null;
  authorityDigest: string | null;
  projectionObserved: boolean;
  projectionTickAt: string | null;
  invalidRows: number | null;
  conflictingIds: number | null;
  limitExceeded: boolean | null;
  eligibleOrdinaryItems: number | null;
  action: 'enable-canary' | 'wait-ordinary-parent' | 'observe-writer' | 'observe-projection' | 'retain-writer' | 'inspect-source' | 'repair-writer-config' | 'rollback-writer';
}

interface RepairHandoffWriterRuntime {
  activationAware?: boolean;
  effective?: boolean;
  blockedReason?: FleetRepairHandoffRolloutStatus['writerBlockedReason'];
  activation?: RepairHandoffV2Activation;
}

export function buildRepairHandoffRolloutStatus(
  summary: RepairHandoffSchemaSummary,
  writerEnabled: boolean,
  eligibleOrdinaryItems: number | null,
  projectionTickAt: string | null = null,
  runtime: RepairHandoffWriterRuntime = {},
): FleetRepairHandoffRolloutStatus {
  const writerEffective = runtime.effective ?? writerEnabled;
  const activationV2Authorities = runtime.activationAware
    ? summary.currentActivationV2Authorities
    : summary.v2Authorities;
  const phase: FleetRepairHandoffRolloutStatus['phase'] = summary.sourceState === 'degraded' || summary.limitExceeded
    ? 'degraded'
    : !writerEnabled
      ? 'reader-only'
      : !writerEffective
        ? 'blocked'
      : activationV2Authorities === 0
        ? 'awaiting-evidence'
        : summary.v1Authorities > 0 ? 'mixed-healthy' : 'v2-healthy';
  const action: FleetRepairHandoffRolloutStatus['action'] = phase === 'degraded'
    ? writerEnabled ? 'rollback-writer' : 'inspect-source'
    : phase === 'blocked'
      ? 'repair-writer-config'
    : phase === 'reader-only'
      ? eligibleOrdinaryItems === null
        ? 'inspect-source'
        : eligibleOrdinaryItems > 0
          ? 'enable-canary'
          : 'wait-ordinary-parent'
      : phase === 'mixed-healthy' || phase === 'v2-healthy'
        ? projectionTickAt ? 'retain-writer' : 'observe-projection'
        : eligibleOrdinaryItems === null
          ? 'inspect-source'
        : eligibleOrdinaryItems > 0
          ? 'observe-writer'
          : 'wait-ordinary-parent';
  return {
    summaryAvailable: true,
    writerConfigured: writerEnabled,
    writerEnabled,
    writerEffective,
    writerBlockedReason: runtime.blockedReason ?? null,
    activationId: runtime.activation?.id ?? null,
    activatedAt: runtime.activation?.activatedAt ?? null,
    phase,
    sourceState: summary.sourceState,
    v1Authorities: summary.v1Authorities,
    v2Authorities: summary.v2Authorities,
    v1PhysicalRows: summary.v1PhysicalRows,
    v2PhysicalRows: summary.v2PhysicalRows,
    aliasFamilies: summary.aliasFamilies,
    latestV2At: summary.latestV2At,
    currentActivationV2Authorities: summary.currentActivationV2Authorities,
    unboundV2Authorities: summary.unboundV2Authorities,
    latestCurrentActivationV2At: summary.latestCurrentActivationV2At,
    authorityDigest: summary.authorityDigest,
    projectionObserved: projectionTickAt !== null,
    projectionTickAt,
    invalidRows: summary.invalidRows,
    conflictingIds: summary.conflictingIds,
    limitExceeded: summary.limitExceeded,
    eligibleOrdinaryItems,
    action,
  };
}

export function repairHandoffProjectionTick(
  recentTicks: readonly DaemonTick[],
  authorityDigest: string,
  notBefore: string | null = null,
  activationProof?: {
    id: string;
    activatedAt: string;
    authorities: number;
    authorityDigest: string;
  },
): string | null {
  const notBeforeMs = notBefore === null ? null : Date.parse(notBefore);
  for (let index = recentTicks.length - 1; index >= 0; index--) {
    const tick = recentTicks[index]!;
    if (notBeforeMs !== null && (!Number.isFinite(Date.parse(tick.ts)) || Date.parse(tick.ts) < notBeforeMs)) continue;
    const maintenance = tick.producerMaintenance;
    // Lifecycle-unavailable repairs are retained, dispatch-blocked inventory;
    // they do not weaken an exact healthy authority-journal projection.
    if (
      maintenance?.proposalRepair === true &&
      maintenance.repairHandoffSourceState === 'healthy' &&
      maintenance.repairHandoffAuthorityDigest === authorityDigest &&
      (maintenance.repairHandoffInvalidRows ?? 0) === 0 &&
      (maintenance.repairHandoffConflictingIds ?? 0) === 0 &&
      (maintenance.repairHandoffCompactionUnavailable ?? 0) === 0 &&
      maintenance.proposalRepairInboxAvailable === true
      && (!activationProof || (
        maintenance.repairHandoffActivationId === activationProof.id &&
        maintenance.repairHandoffActivatedAt === activationProof.activatedAt &&
        maintenance.repairHandoffActivationAuthorities === activationProof.authorities &&
        maintenance.repairHandoffActivationAuthorityDigest === activationProof.authorityDigest &&
        activationProof.authorities > 0
      ))
    ) return tick.ts;
  }
  return null;
}

export interface FleetQueueRepoCoverage {
  enrolled: number;
  existing: number;
  withBacklog: number;
  silent: number;
  /** Present only when the read-only enrollment authority could not be proven. */
  registry?: {
    state: 'degraded';
    reason: string;
  };
  executionProfiles?: {
    reposWithProjects: number;
    reposWithVerifyCommands: number;
    reposMissingVerifyCommands: number;
    reposWithVerifyContracts: number;
    reposWithValidVerifyContracts: number;
    reposWithExplicitMergeContracts: number;
    reposMissingExplicitMergeContracts: number;
    missingVerifyCommands?: Array<{
      repo: string;
      name: string;
      projectKinds: RepoProjectKind[];
      reason: string;
    }>;
    missingExplicitMergeContracts?: Array<{
      repo: string;
      name: string;
      projectKinds: RepoProjectKind[];
      reason: string;
    }>;
    packageManagers: Array<{ manager: RepoPackageManager; repos: number }>;
  };
  top: Array<{ repo: string; items: number }>;
  byTier: Array<{ tier: StrategicTier; repos: number; items: number }>;
}

/** Bounded non-authoritative projection of the shadow canary store. */
export interface FleetAutoMergeCanaryTelemetry {
  shadowCounters: AutoMergeCanaryShadowCountersV1 | null;
  outcomeRates: {
    eligible: number | null;
    rejected: number | null;
    bindingMismatch: number | null;
    inspectionError: number | null;
  };
  casRetries: number | null;
  revisionCapacity: {
    maximum: number;
    used: number | null;
    remaining: number | null;
    reservedForTerminal: 1;
    observationWritesRemaining: number | null;
  };
  epochAgeMs: number | null;
  observationDeadlineRemainingMs: number | null;
  lastShadowEvidence: {
    observedAt: string;
    outcome: AutoMergeCanaryShadowEvidenceV1['outcome'];
    mismatchFields: AutoMergeCanaryShadowEvidenceV1['mismatchFields'];
    fileCount: number;
    lineCount: number;
  } | null;
}

export interface FleetAutoMergeCanaryStatus {
  authority: 'observation-only';
  policyEligible: false;
  enforceSupported: false;
  hostCancellationProven: false;
  sourceState: AutoMergeCanaryReadResult['sourceState'];
  severity: AutoMergeCanaryReadResult['severity'];
  status: AutoMergeCanaryReadResult['status'];
  active: boolean;
  current: {
    epochId: string;
    revision: number;
    mode: 'shadow';
    state: 'shadow' | 'halt-requested' | 'halted';
    activatedAt: string;
    updatedAt: string;
    budgets: AutoMergeCanaryBudgetsV1;
    counters: AutoMergeCanaryCountersV1;
    blocker: AutoMergeCanaryBlockerV1 | null;
  } | null;
  telemetry: FleetAutoMergeCanaryTelemetry;
  revisionCount: number | null;
  terminalEpochCount: number | null;
  diagnostics: AutoMergeCanaryReadResult['diagnostics'];
  limitExceeded: boolean;
}

function unknownAutoMergeCanaryTelemetry(): FleetAutoMergeCanaryTelemetry {
  return {
    shadowCounters: null,
    outcomeRates: {
      eligible: null,
      rejected: null,
      bindingMismatch: null,
      inspectionError: null,
    },
    casRetries: null,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: null,
      remaining: null,
      reservedForTerminal: 1,
      observationWritesRemaining: null,
    },
    epochAgeMs: null,
    observationDeadlineRemainingMs: null,
    lastShadowEvidence: null,
  };
}

function fleetAutoMergeCanaryTelemetry(
  read: AutoMergeCanaryReadResult,
  now: Date,
): FleetAutoMergeCanaryTelemetry {
  if (read.sourceState !== 'healthy' || !read.state) return unknownAutoMergeCanaryTelemetry();
  const state = read.state;
  const attempts = state.shadowCounters.attempts;
  const nowMs = now.getTime();
  const activatedMs = Date.parse(state.activatedAt);
  const deadlineMs = state.observation.deadlineAt === null
    ? null
    : Date.parse(state.observation.deadlineAt);
  const rate = (count: number): number | null => attempts === 0
    ? null
    : Math.min(1, Math.max(0, count / attempts));
  const last = state.lastShadowEvidence;
  return {
    shadowCounters: { ...state.shadowCounters },
    outcomeRates: {
      eligible: rate(state.shadowCounters.eligible),
      rejected: rate(state.shadowCounters.rejected),
      bindingMismatch: rate(state.shadowCounters.bindingMismatches),
      inspectionError: rate(state.shadowCounters.inspectionErrors),
    },
    casRetries: state.shadowCounters.casRetries,
    revisionCapacity: {
      maximum: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH,
      used: state.revision,
      remaining: AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision,
      reservedForTerminal: 1,
      observationWritesRemaining: Math.max(
        0,
        AUTOMERGE_CANARY_MAX_REVISIONS_PER_EPOCH - state.revision - 1,
      ),
    },
    epochAgeMs: Number.isFinite(nowMs) && activatedMs <= nowMs ? nowMs - activatedMs : null,
    observationDeadlineRemainingMs: Number.isFinite(nowMs) && deadlineMs !== null &&
      state.observation.completedAt === null
      ? Math.max(0, deadlineMs - nowMs)
      : null,
    lastShadowEvidence: last === null ? null : {
      observedAt: last.observedAt,
      outcome: last.outcome,
      mismatchFields: [...last.mismatchFields],
      fileCount: last.fileCount,
      lineCount: last.lineCount,
    },
  };
}

function conciseAutoMergeCanaryState(
  state: AutoMergeCanaryReadResult['state'],
): FleetAutoMergeCanaryStatus['current'] {
  if (!state) return null;
  return {
    epochId: state.epochId,
    revision: state.revision,
    mode: state.mode,
    state: state.state,
    activatedAt: state.activatedAt,
    updatedAt: state.updatedAt,
    budgets: { ...state.budgets },
    counters: { ...state.counters },
    blocker: state.blocker === null ? null : { ...state.blocker },
  };
}

export function projectAutoMergeCanaryStatus(
  read: AutoMergeCanaryReadResult,
  now = new Date(),
): FleetAutoMergeCanaryStatus {
  return {
    authority: 'observation-only',
    policyEligible: false,
    enforceSupported: false,
    hostCancellationProven: false,
    sourceState: read.sourceState,
    severity: read.severity,
    status: read.status,
    active: read.active,
    current: read.sourceState === 'healthy' ? conciseAutoMergeCanaryState(read.state) : null,
    telemetry: fleetAutoMergeCanaryTelemetry(read, now),
    revisionCount: read.sourceState === 'healthy' ? read.revisions.length : null,
    terminalEpochCount: read.sourceState === 'healthy' ? read.terminalEpochs.length : null,
    diagnostics: [...read.diagnostics],
    limitExceeded: read.limitExceeded,
  };
}

function degradedAutoMergeCanaryStatus(): FleetAutoMergeCanaryStatus {
  return {
    authority: 'observation-only',
    policyEligible: false,
    enforceSupported: false,
    hostCancellationProven: false,
    sourceState: 'degraded',
    severity: 'critical',
    status: 'critical',
    active: false,
    current: null,
    telemetry: unknownAutoMergeCanaryTelemetry(),
    revisionCount: null,
    terminalEpochCount: null,
    diagnostics: ['storage-unsafe'],
    limitExceeded: false,
  };
}

export function buildAutoMergeCanaryPromotionReadiness(
  status: FleetStatus,
  cfg: AshlrConfig,
  read: AutoMergeCanaryReadResult,
  observedAtMs: number,
): AutoMergeCanaryPromotionReadiness {
  const state = read.sourceState === 'healthy' ? read.state : null;
  const counters = state?.shadowCounters;
  const remote = status.autoMergeReadiness?.remoteProtection;
  const coverage = status.queue.repos?.executionProfiles;
  const registryDegraded = status.queue.repos?.registry?.state === 'degraded';
  const detached = status.detachedPostMergeVerificationReadiness;
  const detachedSource = status.detachedPostMergeVerificationSource;
  const detachedDenominatorSource = status.detachedPostMergeDenominatorSource;
  const detachedComplete = detachedSource?.sourceState === 'healthy' &&
    detachedSource.complete === true &&
    detachedDenominatorSource?.sourceState === 'healthy' &&
    detachedDenominatorSource.complete === true &&
    detached !== undefined &&
    detached.state === 'conclusive' &&
    detached.denominator.eligibleCandidates > 0 &&
    detached.denominator.observedCandidates === detached.denominator.eligibleCandidates &&
    detached.denominator.conclusiveCandidates === detached.denominator.eligibleCandidates;
  const autoMerge = cfg.foundry?.autoMerge;
  const autoMergeRecord = autoMerge as Record<string, unknown> | undefined;
  const configuredScopeCap = (key: 'maxAutomergeFiles' | 'maxAutomergeLines'): number | null | undefined => {
    if (!autoMergeRecord || !Object.prototype.hasOwnProperty.call(autoMergeRecord, key)) return undefined;
    const value = autoMergeRecord[key];
    return typeof value === 'number' ? value : null;
  };
  const maxAutomergeFiles = configuredScopeCap('maxAutomergeFiles');
  const maxAutomergeLines = configuredScopeCap('maxAutomergeLines');
  const currentScopePolicy = resolveAutoMergeScopePolicy(autoMerge);
  const lastShadowEvidence = state?.lastShadowEvidence ?? null;
  const input: AutoMergeCanaryPromotionReadinessInput = {
    observedAtMs,
    canary: {
      sourceState: read.sourceState,
      active: read.active === true && state?.mode === 'shadow',
      state: state?.state ?? (read.status === 'critical' ? 'critical' : 'inactive'),
      observationCompletedAt: state?.observation.completedAt ?? null,
      attempts: counters?.attempts ?? 0,
      eligible: counters?.eligible ?? 0,
      rejected: counters?.rejected ?? 0,
      requiredAttempts: 1,
      requiredEligible: 1,
      // No current configuration field binds a minimum promotion sample.
      requirementsBound: false,
      bindingMismatches: counters?.bindingMismatches ?? 0,
      inspectionErrors: counters?.inspectionErrors ?? 0,
    },
    remoteProtection: {
      configured: remote?.configured === 'exact'
        ? 'exact'
        : remote?.configured === 'missing' || remote === undefined ? 'missing' : 'partial',
      live: remote?.live === 'protected' || remote?.live === 'unprotected'
        ? remote.live
        : 'unavailable',
      coverage: remote?.coverage === 'complete'
        ? 'complete'
        : remote?.coverage === 'partial' ? 'partial' : 'none',
      observedAt: remote?.observedAt ?? null,
    },
    verification: {
      sourceState: registryDegraded ? 'degraded' : coverage ? 'healthy' : 'missing',
      enrolledRepos: status.queue.repos?.enrolled ?? 0,
      mergeGradeRepos: coverage?.reposWithExplicitMergeContracts ?? 0,
      noCommandRepos: coverage?.reposMissingVerifyCommands ?? 0,
    },
    // Current Fleet Status has no release-scoped signing or rollback authority
    // source. Missing evidence must remain explicit rather than inferred.
    evidenceSigning: {
      sourceState: 'missing',
      signed: false,
      writable: false,
      expiresAt: null,
    },
    release: {
      sourceState: 'missing',
      signatureVerified: false,
      manifestComplete: false,
      artifactBound: false,
      serviceInvocationBound: false,
      configurationBound: false,
      expiresAt: null,
      rollbackBound: false,
    },
    postMerge: {
      sourceState: detachedSource?.sourceState ?? 'missing',
      complete: detachedComplete,
      denominatorComplete: detachedComplete,
      releasedCohorts: detached?.denominator.conclusiveCandidates ?? 0,
      adverseObservations: (detached?.denominator.fail ?? 0) +
        (detached?.denominator.unknown ?? 0),
      latestCompletedAt: detached?.latestObservedAt ?? null,
    },
    policy: {
      allowSelfMerge: autoMerge?.allowSelfMerge === true,
      allowWithoutVerification: autoMerge?.allowWithoutVerification === true,
      localMergeFallback: autoMerge?.enabled === true && autoMerge.pushToRemote !== true,
      ...(maxAutomergeFiles !== undefined ? { maxAutomergeFiles } : {}),
      ...(maxAutomergeLines !== undefined ? { maxAutomergeLines } : {}),
    },
    scopeIdentity: {
      sourceState: read.sourceState,
      expectedPolicyDigest: state?.policyDigest ?? null,
      expectedConfigDigest: state?.configDigest ?? null,
      evidencePolicyDigest: lastShadowEvidence?.policyDigest ?? null,
      evidenceConfigDigest: lastShadowEvidence?.configDigest ?? null,
      currentPolicyDigest: autoMergeCanaryPolicyDigest(),
      currentConfigDigest: autoMergeCanaryConfigDigest(cfg),
      currentScopePolicyDigest: currentScopePolicy.ok ? currentScopePolicy.policy.digest : null,
      observedAt: lastShadowEvidence?.observedAt ?? null,
    },
  };
  return evaluateAutoMergeCanaryPromotionReadiness(input);
}

export type FleetLearningSourceName =
  | 'dispatch-production'
  | 'agent-actions'
  | 'outcomes'
  | 'decisions'
  | 'evidence'
  | 'worked'
  | 'post-merge'
  | 'judge-traces'
  | 'skill-use';

export type FleetLearningWithholdingReason = `${FleetLearningSourceName}-source-missing` |
  `${FleetLearningSourceName}-source-degraded`;

export interface FleetLearningSourceAvailability {
  source: FleetLearningSourceName;
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
}

export interface FleetLearningMetricAvailability {
  state: 'available' | 'partial' | 'withheld';
  reasons: FleetLearningWithholdingReason[];
  sources: FleetLearningSourceAvailability[];
  withheldMetrics: string[];
}

/** One whole-fleet read-only snapshot. */
export interface FleetStatus {
  /** ISO timestamp this snapshot was generated. */
  generatedAt: string;
  /** Canonical build-produced identity. Optional for legacy serialized snapshots. */
  buildIdentity?: BuildIdentity;
  daemon: {
    running: boolean;
    sourceQuality?: {
      sourceState: 'healthy' | 'degraded';
      complete: boolean;
      reason: 'healthy' | 'missing' | 'malformed' | 'unreadable' | 'inconsistent' | 'unavailable';
    };
    pid?: number | null;
    startedAt?: string | null;
    lastTickAt: string | null;
    lockHeartbeatAt?: string | null;
    tickInProgress?: boolean;
    childActivity?: boolean;
    activity?: {
      source: 'daemon-activity';
      sourceState: 'missing' | 'healthy' | 'degraded';
      freshness: 'fresh' | 'stale' | 'future' | 'unknown';
      ownerState: 'alive' | 'dead' | 'reused' | 'unknown';
      phase: 'starting' | 'tick' | 'post-tick' | 'idle' | 'stopping' | null;
      phaseStartedAt: string | null;
      observedAt: string | null;
      ageMs: number | null;
      activeChildren: number | null;
      ownerMatches: boolean;
    };
    todaySpentUsd: number;
    activation?: DaemonActivationReadiness;
  };
  backends: FleetBackendStatus[];
  queue: {
    backlogItems: number;
    eligibleBacklogItems?: number;
    cooldownItems?: number;
    pendingItems?: number;
    repairRouteBlockedItems?: number;
    repairControlBlockedItems?: number;
    repairLifecycleUnavailableItems?: number;
    repairTerminalItems?: number;
    repairQuarantinedItems?: number;
    nextEligibleAt?: string | null;
    repos?: FleetQueueRepoCoverage;
    next?: FleetQueueNextItem[];
    sources?: {
      cachedBacklog: FleetQueueInventorySourceStatus;
      queuedAutonomy: FleetQueueInventorySourceStatus;
    };
    shared?: FleetSharedQueueStatus;
    activeWork?: FleetActiveWorkStatus;
    generatedWork?: FleetQueueGeneratedWorkStatus;
    generatedRepairRoutes?: FleetGeneratedRepairRouteStatus;
    scannerEvidence?: FleetQueueScannerEvidenceStatus;
    resolutionObserver?: FleetResolutionObserverStatus;
    diagnosticResliceDrain?: FleetDiagnosticResliceDrainStatus;
  };
  repairHandoffRollout?: FleetRepairHandoffRolloutStatus;
  proposals: {
    /** Observed inventory only; authority consumers must also require `authority.gate === 'ready'`. */
    pending: number;
    frontierPending: number;
    awaitingHostMerge?: number;
    applied: number;
    sourceQuality?: FleetProposalSourceQuality;
    authority?: FleetProposalAuthoritySource;
  };
  merges: {
    recent: number;
    /** Legacy daemon-reported merge activity. Forensics only; never landed-work authority. */
    reportedByTicks?: number;
    /** Completeness of the proposal source that backs `recent`. */
    sourceQuality?: FleetProposalSourceQuality;
  };
  /** Values-free Phantom readiness for fleet secret operations. */
  phantom?: FleetPhantomStatus;
  autonomy?: FleetAutonomyStatus;
  /** Effective autonomy control authority for daemon dispatch decisions. */
  autonomyControlMode: FleetAutonomyControlMode;
  /** Read-only static readiness summary for pending auto-merge candidates. */
  autoMergeReadiness?: FleetAutoMergeReadinessStatus;
  /** Observation-only shadow canary state; never consumed by fleet policy. */
  autoMergeCanary?: FleetAutoMergeCanaryStatus;
  /** Observation-only explanation of future canary promotion prerequisites. */
  autoMergeCanaryPromotionReadiness?: AutoMergeCanaryPromotionReadiness;
  /** Read-only resource-aware autonomous operating recommendation. */
  autonomyDirection?: FleetAutonomyDirectionSummary;
  /** Read-only diagnosis of guard state that can block autonomous work. */
  guardHealth?: GuardHealthDiagnosis;
  /** Ranked read-only operator/agent actions derived from the snapshot. */
  nextActions?: FleetNextAction[];
  /** Read-only focus policy summary for active goal closure over queue widening. */
  goalFocus?: FleetGoalFocusStatus;
  /** Read-only derived view of occupied work lanes; does not affect dispatch. */
  laneLocks?: FleetLaneLocksStatus;
  /** Read-only explanation of whether the autonomous loop can merge right now. */
  autonomyEffectiveness?: FleetAutonomyEffectivenessStatus;
  /** Read-only Fleet OS verdict for whether autonomous shipping is ready now. */
  autonomousShipReadiness?: FleetAutonomousShipReadinessStatus;
  /** Single-command operating brief derived from readiness, effectiveness, and next actions. */
  missionBrief?: FleetMissionBrief;
  /** Read-only diagnosis of recent proposal production from daemon ticks. */
  proposalProduction?: FleetProposalProductionStatus;
  /** Durable 24h dispatch-production yield summary from the append-only ledger. */
  dispatchProduction?: DispatchProductionYieldSummary;
  /** Storage/read completeness for dispatch-production analytics. */
  dispatchProductionSource?: DispatchProductionSourceQuality;
  /** Metadata-only proposal-funnel rates; withheld whenever the bounded source is incomplete. */
  proposalFunnel?: ProposalFunnelObservability;
  /** Whether dispatch-backed learning metrics have a complete denominator. */
  learningMetrics?: {
    state: 'available' | 'withheld';
    denominator: 'dispatch-production';
    reason?:
      | 'dispatch-source-missing'
      | 'dispatch-source-degraded'
      | 'learning-snapshot-settling'
      | 'learning-snapshot-unstable';
    /** Exact upper timestamp bound shared by every joined learning source. */
    settledThrough?: string;
    /** Valid rows intentionally excluded because they are newer than settledThrough. */
    excludedRows?: number;
    sourceQuality: DispatchProductionSourceQuality;
    dispatchProduction: FleetLearningMetricAvailability;
    attemptCoverage?: FleetLearningMetricAvailability;
    trajectoryLearning?: FleetLearningMetricAvailability;
  };
  /** Fail-closed authority projection for whether learned history may steer live routing. */
  routingLearningAuthority?: RoutingLearningAuthority;
  /** Storage/read completeness for cached judge and merge-authority evidence. */
  decisionsSource?: DecisionSourceQuality;
  /** Storage/read completeness for judge calibration and real-world outcome labels. */
  judgeTraceSource?: JudgeTraceSourceQuality;
  /** Recent forensic concurrent dispatch intent summaries from the append-only manifest ledger. */
  dispatchManifests?: FleetDispatchManifestStatus;
  /** Storage/read completeness for forensic concurrent dispatch intent. */
  dispatchManifestSource?: DispatchManifestSourceQuality;
  /** Bounded candidate-economics evidence used only when complete. */
  bestOfNSource?: BestOfNSourceQuality;
  /** Observation-only post-merge evidence. Never grants routing or merge authority. */
  postMergeSource?: FleetReadinessEvidenceQuality;
  postMergeCohort?: {
    policyEligible: false;
    denominatorComplete: false;
    adverseObservations: number;
    stability: PostMergeStabilityCohortSummary;
  };
  /** Authenticated metadata from detached post-merge verification runners. */
  detachedPostMergeVerificationSource?: FleetReadinessEvidenceQuality;
  /** Authenticated current candidate denominator for detached verification. */
  detachedPostMergeDenominatorSource?: FleetReadinessEvidenceQuality;
  /** Immutable data-only work tickets. Queue state grants no execution or readiness authority. */
  detachedPostMergeWorkTicketSource?: FleetReadinessEvidenceQuality;
  /** Read-only detached cohort quality. It is excluded from policy authority. */
  detachedPostMergeVerificationReadiness?: FleetDetachedPostMergeVerificationReadiness;
  /** Authenticated checkpoint availability. Excluded from readiness and policy inputs. */
  cutoffCheckpoints?: FleetCutoffCheckpointStatus;
  /** Effective applicability for optional evidence producers. */
  evidencePolicy?: {
    concurrentDispatchEnabled: boolean;
    bestOfNEnabled: boolean;
  };
  /** Sample-gated diagnosis of dispatch-production yield; no raw prompts/diffs/stdout. */
  dispatchYieldDiagnostics?: FleetDispatchYieldDiagnostics;
  /** Durable 24h agent-action global workspace summary from append-only telemetry. */
  workspace?: AgentWorkspaceStatus;
  /** Read-only joined attempt coverage summary; metadata only, no raw prompts/diffs/output. */
  attemptCoverage?: AttemptCoverageStatus;
  /** Read-only route-to-outcome trajectory reconstruction summary; metadata only. */
  trajectoryLearning?: TrajectoryLearningStatus;
  /** Read-only signed skill-corpus health and privacy-gated observation state. */
  skillCorpusReadiness?: FleetSkillCorpusReadiness;
  /** Read-only context discipline signal for long-running multi-agent work. */
  contextEfficiency?: FleetContextEfficiencyStatus;
  /** True when the global kill switch is engaged (fleet paused). */
  killed: boolean;
  /** Exact observation of kill-switch authority. Legacy `killed` stays restrictive. */
  killSwitch?: {
    state: 'active' | 'inactive' | 'unknown';
    sourceState: 'healthy' | 'degraded';
    reason: 'present' | 'missing' | 'uninspectable' | 'unsafe' | 'unavailable';
  };
}

/** Recent window for dispatch + merge counting: the last 24 hours. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Keep concurrently appended rows outside exact cross-source joins until settled. */
const LEARNING_SNAPSHOT_SETTLE_MS = 2 * 60 * 1000;
const QUEUE_SOURCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

function processExists(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const LEARNING_SNAPSHOT_TEXT_KEYS = new Set([
  'argv',
  'cmd',
  'content',
  'contents',
  'detail',
  'diff',
  'env',
  'fileContents',
  'fullReasoning',
  'promptContext',
  'reason',
  'stderr',
  'stdout',
  'summary',
  'title',
]);

/**
 * Produce a deterministic metadata-only projection for an in-memory stability
 * digest. The digest is never returned or persisted.
 */
function learningSnapshotMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(learningSnapshotMetadata);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        LEARNING_SNAPSHOT_TEXT_KEYS.has(key)
          ? `sha256:${createHash('sha256').update(JSON.stringify(entry) ?? 'undefined').digest('hex')}`
          : learningSnapshotMetadata(entry),
      ]),
  );
}

function learningSnapshotDigest(source: unknown, rows: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(learningSnapshotMetadata({ source, rows })))
    .digest('hex');
}

function learningSnapshotSourceQuality(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') return { sourceState: 'degraded', complete: false };
  const source = value as Record<string, unknown>;
  return {
    sourceState: source.sourceState,
    sourcePresent: source.sourcePresent,
    complete: source.complete,
    stopReasons: source.stopReasons,
    reasons: source.reasons,
    invalidFiles: source.invalidFiles,
    invalidRows: source.invalidRows,
    conflictingEvents: source.conflictingEvents,
    duplicateRows: source.duplicateRows,
    supersededRows: source.supersededRows,
    semanticRejectedRows: source.semanticRejectedRows,
    unreadableFiles: source.unreadableFiles,
    limitExceeded: source.limitExceeded,
  };
}

function invalidatedDispatchProductionSource(
  source: DispatchProductionSourceQuality | undefined,
  stopReason?: 'io-error',
): DispatchProductionSourceQuality {
  const fallback: DispatchProductionSourceQuality = {
    sourceState: 'degraded',
    sourcePresent: true,
    complete: false,
    stopReasons: [],
    filesRead: 0,
    datedFilesRead: 0,
    looseFilesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
  };
  const base = source ?? fallback;
  return {
    ...base,
    sourceState: base.sourceState === 'missing' ? 'missing' : 'degraded',
    complete: false,
    stopReasons: [...new Set([...base.stopReasons, ...(stopReason ? [stopReason] : [])])],
    unreadableFiles: base.unreadableFiles + (stopReason ? 1 : 0),
  };
}

function learningSnapshotTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const timestampMs = Date.parse(value);
    if (Number.isFinite(timestampMs) && timestampMs > latestMs) {
      latest = value;
      latestMs = timestampMs;
    }
  }
  return latest;
}

function settledLearningRows<T>(
  rows: readonly T[],
  cutoffMs: number,
  timestamp: (row: T) => string | undefined,
): T[] {
  return rows.filter((row) => {
    const timestampMs = Date.parse(timestamp(row) ?? '');
    return Number.isFinite(timestampMs) && timestampMs <= cutoffMs;
  });
}

function queueInventoryFreshness(
  observedAt: string | null,
  nowMs = Date.now(),
): FleetQueueInventorySourceStatus['freshness'] {
  if (!observedAt) return 'unknown';
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + QUEUE_SOURCE_FUTURE_SKEW_MS) return 'unknown';
  return nowMs - observedMs <= READINESS_QUEUE_STALE_MS ? 'fresh' : 'stale';
}

function isVisibleBacklogItem(item: WorkItem, enrolledRepos: Set<string>): boolean {
  if (enrolledRepos.size === 0) return false;
  return enrolledRepos.has(resolve(item.repo));
}

function mergeVisibleQueueItems(items: WorkItem[], enrolledRepos: Set<string>): WorkItem[] {
  const seen = new Set<string>();
  const merged: WorkItem[] = [];
  for (const item of items) {
    if (!isVisibleBacklogItem(item, enrolledRepos)) continue;
    const key = `${resolve(item.repo)}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function buildQueueGeneratedWorkStatus(items: WorkItem[]): FleetQueueGeneratedWorkStatus | undefined {
  let selfHeal = 0;
  let proposalRepair = 0;
  let captureRepairs = 0;
  let diagnosticReslices = 0;
  let invent = 0;
  for (const item of items) {
    if (item.source === 'invent') invent++;
    if (item.tags.includes('self-heal')) selfHeal++;
    if (item.tags.includes('proposal-repair')) proposalRepair++;
    if (item.tags.includes('dispatch-capture-repair')) captureRepairs++;
    if (item.tags.includes('dispatch-no-diff-reslice')) diagnosticReslices++;
  }
  const total = items.filter((item) =>
    item.source === 'invent' ||
    item.tags.includes('self-heal') ||
    item.tags.includes('proposal-repair') ||
    item.tags.includes('dispatch-capture-repair') ||
    item.tags.includes('dispatch-no-diff-reslice')
  ).length;
  if (total === 0) return undefined;
  return { total, selfHeal, proposalRepair, captureRepairs, diagnosticReslices, invent };
}

function latestRecentDiagnosticResliceDrainTick(ticks: DaemonTick[], nowMs = Date.now()): DaemonTick | null {
  const cutoff = nowMs - RECENT_WINDOW_MS;
  let latestTargeted: DaemonTick | null = null;
  let latestTargetedMs = Number.NEGATIVE_INFINITY;
  for (const tick of ticks) {
    if (tick.drain?.mode !== 'diagnostic-reslices') continue;
    const ts = Date.parse(tick.ts);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const safeTs = Number.isFinite(ts) ? ts : nowMs;
    if (!latestTargeted || safeTs >= latestTargetedMs) {
      latestTargeted = tick;
      latestTargetedMs = safeTs;
    }
  }
  return latestTargeted;
}

function buildDiagnosticResliceDrainStatus(
  ticks: DaemonTick[],
  nowMs = Date.now(),
): FleetDiagnosticResliceDrainStatus | undefined {
  const latest = latestRecentDiagnosticResliceDrainTick(ticks, nowMs);
  const drain = latest?.drain;
  if (!latest || drain?.mode !== 'diagnostic-reslices') return undefined;
  const production = latest.proposalProduction;
  const topReasons = production?.reasons
    ?.filter((reason) => reason.count > 0)
    .slice(0, 5)
    .map((reason) => ({ reason: reason.reason, count: reason.count }));
  return {
    mode: drain.mode,
    latestAt: latest.ts,
    available: drain.available,
    selected: drain.selected,
    ...(typeof drain.limit === 'number' ? { limit: drain.limit } : {}),
    ...(drain.capped ? { capped: true } : {}),
    ...(drain.automatic ? { automatic: true } : {}),
    ...(drain.selectedItemIds?.length ? { selectedItemIds: drain.selectedItemIds.slice(0, 12) } : {}),
    ...(drain.stalled || (drain.available > 0 && drain.selected === 0) ? { stalled: true } : {}),
    dispatched: production?.dispatched ?? 0,
    skipped: production?.skipped ?? 0,
    errors: production?.errors ?? 0,
    proposalsCreated: production?.proposalsCreated ?? latest.proposalsCreated ?? 0,
    noProposalDispatches: production?.noProposalDispatches ?? 0,
    ...(topReasons && topReasons.length > 0 ? { topReasons } : {}),
  };
}

interface FleetQueueEligibility {
  eligibleItems: WorkItem[];
  cooldownItems: number;
  pendingItems: number;
  repairRouteBlockedItems: number;
  repairControlBlockedItems: number;
  repairLifecycleUnavailableItems: number;
  repairTerminalItems: number;
  repairQuarantinedItems: number;
  generatedRepairRoutes?: FleetGeneratedRepairRouteStatus;
  nextEligibleAt: string | null;
}

function isoFromMs(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function buildQueueEligibility(
  items: WorkItem[],
  pendingProposals: Proposal[],
  cfg: AshlrConfig,
  repairControlAvailable: boolean = readRepairHandoffs().sourceState !== 'degraded',
): FleetQueueEligibility {
  const cooldownMs = configCooldownMs(cfg) ?? DEFAULT_COOLDOWN_MS;
  const nowMs = Date.now();
  const workedEvents = selectWorkQueueCoordinator(cfg).readWorkedEvents();
  const repairQueue = (() => {
    try {
      return readGeneratedRepairQueueSnapshot();
    } catch {
      return null;
    }
  })();

  const blockingPendingProposals = blockingPendingProposalsForBacklog(pendingProposals, cfg);
  const pendingItemKeys = pendingProposalItemKeysForBacklog(items, blockingPendingProposals);
  const eligibleItems: WorkItem[] = [];
  let cooldownItems = 0;
  let pendingItems = 0;
  let repairRouteBlockedItems = 0;
  let repairControlBlockedItems = 0;
  let repairLifecycleUnavailableItems = 0;
  let repairTerminalItems = 0;
  let repairQuarantinedItems = 0;
  let trustedRouteItems = 0;
  let feasibleRouteItems = 0;
  let requiresAlternativeItems = 0;
  const routeReasons = new Map<GeneratedRepairRouteReason, number>();
  const blockedRouteItems: NonNullable<FleetGeneratedRepairRouteStatus['blockedItems']> = [];
  const recordRouteBlock = (
    item: WorkItem,
    reason: Exclude<GeneratedRepairRouteReason, 'feasible'>,
  ): void => {
    repairRouteBlockedItems++;
    routeReasons.set(reason, (routeReasons.get(reason) ?? 0) + 1);
    blockedRouteItems.push({ itemId: boundedRepairRouteItemId(item.id), reason });
  };
  const recordInspectionUnavailable = (item: WorkItem): void => {
    trustedRouteItems++;
    recordRouteBlock(item, 'inspection-unavailable');
  };
  let nextEligibleMs: number | null = null;
  for (const item of items) {
    if (!repairControlAvailable && item.tags.includes('proposal-repair')) {
      repairControlBlockedItems++;
      continue;
    }
    let repairDispatch: GeneratedRepairDispatchState | undefined;
    try {
      repairDispatch = repairQueue?.dispatchState(item);
    } catch {
      if (isTrustedGeneratedRepairItem(item)) {
        recordInspectionUnavailable(item);
        continue;
      }
      if (item.tags.includes('proposal-repair')) {
        repairControlBlockedItems++;
        continue;
      }
    }
    if (repairDispatch?.applies && !repairDispatch.dispatchable) {
      repairControlBlockedItems++;
      if (repairDispatch.state === 'lifecycle-unavailable') {
        repairLifecycleUnavailableItems++;
      } else {
        repairTerminalItems++;
        if (repairDispatch.disposition === 'quarantined') repairQuarantinedItems++;
      }
      continue;
    }
    if (pendingItemKeys.has(workItemCoverageKey(item))) {
      pendingItems++;
      continue;
    }
    let cooldownKeys: string[];
    try {
      cooldownKeys = repairQueue?.cooldownKeys(item) ?? [item.id];
    } catch {
      if (isTrustedGeneratedRepairItem(item)) {
        recordInspectionUnavailable(item);
        continue;
      }
      if (item.tags.includes('proposal-repair')) {
        repairControlBlockedItems++;
        continue;
      }
      cooldownKeys = [item.id];
    }
    const lastEvent = latestWorkedEventForKeys(workedEvents, cooldownKeys);
    const lastMs = lastEvent ? Date.parse(lastEvent.ts) : Number.NaN;
    const last = lastEvent && Number.isFinite(lastMs)
      ? { event: lastEvent, tsMs: lastMs, suppressible: isSuppressibleWorkedOutcome(lastEvent.outcome) }
      : undefined;
    const itemCooldownMs = cooldownMsForWorkItem(item, cooldownMs, last?.event);
    const cooldownUntil = last && last.suppressible ? last.tsMs + itemCooldownMs : null;
    if (cooldownUntil !== null && cooldownUntil > nowMs) {
      cooldownItems++;
      if (nextEligibleMs === null || cooldownUntil < nextEligibleMs) {
        nextEligibleMs = cooldownUntil;
      }
      continue;
    }
    if (isTrustedGeneratedRepairItem(item)) {
      trustedRouteItems++;
      if (repairQueue === null) {
        recordRouteBlock(item, 'inspection-unavailable');
        continue;
      }
      let route: GeneratedRepairRouteFeasibility;
      try {
        const policy = repairQueue.retryPolicy(item);
        route = inspectGeneratedRepairRouteFeasibility(item, cfg, policy);
      } catch {
        recordRouteBlock(item, 'inspection-unavailable');
        continue;
      }
      if (route.requiresAlternative) requiresAlternativeItems++;
      if (!route.feasible) {
        const reason = route.reason === 'feasible' ? 'inspection-unavailable' : route.reason;
        recordRouteBlock(item, reason);
        continue;
      }
      feasibleRouteItems++;
      routeReasons.set(route.reason, (routeReasons.get(route.reason) ?? 0) + 1);
    }
    eligibleItems.push(item);
  }

  const sortedBlockedRouteItems = blockedRouteItems
    .sort((left, right) => left.itemId.localeCompare(right.itemId));
  const visibleBlockedRouteItems = sortedBlockedRouteItems
    .slice(0, MAX_GENERATED_REPAIR_ROUTE_BLOCKED_ITEMS);
  const blockedItemsOmitted = sortedBlockedRouteItems.length - visibleBlockedRouteItems.length;

  return {
    eligibleItems,
    cooldownItems,
    pendingItems,
    repairRouteBlockedItems,
    repairControlBlockedItems,
    repairLifecycleUnavailableItems,
    repairTerminalItems,
    repairQuarantinedItems,
    ...(trustedRouteItems > 0 ? {
      generatedRepairRoutes: {
        scope: 'eligible-claim-candidates' as const,
        authority: 'observation-only' as const,
        trustedItems: trustedRouteItems,
        feasibleItems: feasibleRouteItems,
        unavailableItems: trustedRouteItems - feasibleRouteItems,
        requiresAlternativeItems,
        byReason: [...routeReasons.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
        ...(visibleBlockedRouteItems.length > 0 ? {
          blockedItems: visibleBlockedRouteItems,
        } : {}),
        ...(blockedItemsOmitted > 0 ? { blockedItemsOmitted } : {}),
      },
    } : {}),
    nextEligibleAt: isoFromMs(nextEligibleMs),
  };
}

function cooldownMsForWorkItem(
  item: WorkItem,
  baseCooldownMs: number,
  latestEvent?: WorkedEvent,
): number {
  if (latestEvent?.outcome === 'dispatch-blocked' && isTrustedGeneratedRepairItem(item)) {
    return Math.min(baseCooldownMs, GENERATED_REPAIR_DISPATCH_BLOCKED_COOLDOWN_MS);
  }
  return baseCooldownMs;
}

export function resolveAutonomyControlMode(cfg: AshlrConfig): FleetAutonomyControlMode {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  if (!foundry) return 'disabled';
  return foundry['autonomyControlLoop'] === false ? 'advisory' : 'executable';
}

function backendResourceStatus(
  state: BackendResourceState | undefined,
  fallbackReason = 'no resource sensor reported this allowed backend',
): FleetBackendResourceStatus {
  if (!state) {
    return {
      availability: 'not-sensed',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      reason: fallbackReason,
      snapshotAt: null,
    };
  }
  return {
    availability: state.availability,
    usedPct: state.usedPct,
    cap: state.cap,
    capUnit: state.capUnit,
    capWindow: state.capWindow,
    resetsAt: state.resetsAt,
    reason: state.reason,
    snapshotAt: state.snapshotAt,
  };
}

async function attachBackendResources(backends: FleetBackendStatus[], cfg: AshlrConfig): Promise<void> {
  const byBackend = new Map<EngineId, BackendResourceState>();
  let fallbackReason = 'no resource sensor reported this allowed backend';
  try {
    const { getResourceSnapshot } = await import('../fabric/resource-monitor.js');
    const snapshot = await getResourceSnapshot(cfg);
    for (const state of snapshot.backends) byBackend.set(state.backend, state);
  } catch {
    fallbackReason = 'resource snapshot unavailable';
  }
  for (const backend of backends) {
    backend.resource = backendResourceStatus(byBackend.get(backend.backend), fallbackReason);
  }
}

const MAX_LEARNING_WITHHOLDING_REASONS = 12;
const MAX_LEARNING_WITHHELD_METRICS = 24;

type LearningSourceQualityLike = {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
};

function learningSourceAvailability(
  source: FleetLearningSourceName,
  quality: LearningSourceQualityLike | undefined,
): FleetLearningSourceAvailability {
  return {
    source,
    sourceState: quality?.sourceState ?? 'degraded',
    complete: quality?.complete === true,
  };
}

function learningSourceAvailable(source: FleetLearningSourceAvailability): boolean {
  return source.sourceState === 'healthy' && source.complete;
}

function learningMetricAvailability(
  sources: FleetLearningSourceAvailability[],
  withheldMetrics: string[],
  totalMetrics: number,
): FleetLearningMetricAvailability {
  const reasons = sources
    .filter((source) => !learningSourceAvailable(source))
    .map((source): FleetLearningWithholdingReason =>
      `${source.source}-source-${source.sourceState === 'missing' ? 'missing' : 'degraded'}`)
    .slice(0, MAX_LEARNING_WITHHOLDING_REASONS);
  const boundedMetrics = [...new Set(withheldMetrics)].slice(0, MAX_LEARNING_WITHHELD_METRICS);
  return {
    state: boundedMetrics.length === 0 ? 'available' : boundedMetrics.length >= totalMetrics ? 'withheld' : 'partial',
    reasons,
    sources: sources.slice(0, MAX_LEARNING_WITHHOLDING_REASONS),
    withheldMetrics: boundedMetrics,
  };
}

function withholdAttemptJoinMetrics(
  summary: AttemptCoverageStatus,
  unavailable: Set<keyof AttemptRecordCoverage>,
): AttemptCoverageStatus {
  if (unavailable.size === 0) return summary;
  const coverage = { ...summary.coverage };
  for (const key of unavailable) delete coverage[key];
  return {
    ...summary,
    coverage,
    gaps: summary.gaps.filter((gap) => !unavailable.has(gap.kind)),
    recent: summary.recent.map((record) => {
      const recordCoverage = { ...record.coverage };
      for (const key of unavailable) delete recordCoverage[key];
      return { ...record, coverage: recordCoverage };
    }),
  };
}

function withholdTrajectoryMetrics(
  summary: TrajectoryLearningStatus,
  unavailable: Set<keyof TrajectoryRecordCoverage>,
  options: { terminal: boolean; realized: boolean; traces: boolean },
): TrajectoryLearningStatus {
  const coverage = { ...summary.coverage };
  for (const key of unavailable) delete coverage[key];
  const routeSpine = { ...summary.routeSpine };
  if (unavailable.has('decision')) delete routeSpine.dispatchToDecision;
  if (unavailable.has('evidence')) delete routeSpine.dispatchToEvidence;
  if (!options.terminal) delete routeSpine.dispatchToMerge;
  return {
    ...summary,
    coverage,
    routeSpine,
    ...(!options.terminal ? { terminalOutcomes: undefined, recent: undefined } : {}),
    ...(!options.realized ? { realizedOutcomes: undefined } : {}),
    ...(!options.traces ? { traces: { state: 'degraded', records: [] } } : {}),
    gaps: summary.gaps.filter((gap) => !unavailable.has(gap.kind)),
    ...(summary.recent && options.terminal
      ? {
          recent: summary.recent.map((record) => {
            const recordCoverage = { ...record.coverage };
            for (const key of unavailable) delete recordCoverage[key];
            return { ...record, coverage: recordCoverage };
          }),
        }
      : {}),
  };
}

export function projectPostMergeComposite(
  adverse: PostMergeObservationReadResult,
  stability: PostMergeStabilityReadResult,
): FleetPostMergeCompositeProjection {
  const bothMissing = adverse.sourceState === 'missing' && stability.sourceState === 'missing';
  const complete = adverse.sourceState === 'healthy' && adverse.complete &&
    stability.sourceState === 'healthy' && stability.complete;
  const source: FleetReadinessEvidenceQuality = {
    sourceState: complete ? 'healthy' : bothMissing ? 'missing' : 'degraded',
    sourcePresent: adverse.sourcePresent || stability.sourcePresent,
    complete,
    stopReasons: [...new Set([
      ...adverse.stopReasons,
      ...stability.stopReasons,
      ...(adverse.sourceState === 'missing' ? ['adverse-source-missing'] : []),
      ...(stability.sourceState === 'missing' ? ['stability-source-missing'] : []),
    ])],
    filesRead: adverse.filesRead + stability.filesRead,
    bytesRead: adverse.bytesRead + stability.bytesRead,
    rowsScanned: adverse.physicalRows + stability.physicalRows,
    invalidRows: adverse.invalidRows + stability.invalidRows,
    unreadableFiles: 0,
  };
  if (!complete) return { source };

  const adverseMembers = new Set(adverse.observations.flatMap((row) => {
    const digest = postMergeStabilityRepoDigest(row.repo);
    return digest ? [JSON.stringify([digest, row.proposalId, row.mergeCommit])] : [];
  }));
  const effectiveStability = stability.witnesses.filter((row) => !adverseMembers.has(JSON.stringify([
    row.repoDigest, row.proposalId, row.mergeCommit,
  ])));
  const effectiveSummary: PostMergeStabilityCohortSummary = {
    completeCohorts: new Set(effectiveStability.map((row) => row.cohortId)).size,
    releasedWitnesses: effectiveStability.length,
    distinctRepoDigests: new Set(effectiveStability.map((row) => row.repoDigest)).size,
    ...(effectiveStability.length > 0
      ? { latestCompletedAt: effectiveStability.map((row) => row.stableAt).sort().at(-1) }
      : {}),
  };
  return {
    source,
    cohort: {
      policyEligible: false,
      denominatorComplete: false,
      adverseObservations: adverse.observations.length,
      stability: effectiveSummary,
    },
  };
}

export interface FleetDaemonStatusRead {
  daemon: FleetStatus['daemon'];
  recentTicks: DaemonTick[];
}

/** Read daemon ledger, lock, and activity as one fail-closed observation. */
export async function readFleetDaemonStatus(): Promise<FleetDaemonStatusRead> {
  let daemon: FleetStatus['daemon'] = {
    running: false,
    sourceQuality: {
      sourceState: 'degraded',
      complete: false,
      reason: 'unavailable',
    },
    startedAt: null,
    lastTickAt: null,
    todaySpentUsd: 0,
  };
  let recentTicks: DaemonTick[] = [];
  try {
    const { loadDaemonStateStrict, readDaemonLockOwner } = await import('../daemon/state.js');
    const { readDaemonActivity } = await import('../daemon/activity.js');
    const daemonState = loadDaemonStateStrict();
    if (!daemonState.ok) {
      daemon.sourceQuality = {
        sourceState: 'degraded',
        complete: false,
        reason: daemonState.reason,
      };
      throw new Error(`daemon-state-${daemonState.reason}`);
    }
    const ds = daemonState.state;
    const startedAt = ds.startedAt ?? null;
    const lastTickAt = ds.lastTickAt ?? null;
    const lockOwner = readDaemonLockOwner();
    const lockHeartbeatAt = ds.running === true && lockOwner?.pid === ds.pid
      ? lockOwner.heartbeatAt
      : null;
    const activityRead = readDaemonActivity();
    const activity = activityRead.activity;
    const ownerMatches = ds.running === true && activity !== null && activity.pid === ds.pid &&
      activity.daemonStartedAt === startedAt;
    const activityHealthy = ownerMatches && activityRead.sourceState === 'healthy' &&
      activityRead.freshness === 'fresh' && activityRead.ownerState === 'alive';
    const lockOwnerAlive = processExists(lockOwner?.pid);
    const liveLockContradiction = lockOwnerAlive && (
      daemonState.fresh ||
      ds.running !== true ||
      lockOwner?.pid !== ds.pid
    );
    const stateConsistent =
      activityRead.sourceState !== 'degraded' &&
      !liveLockContradiction;
    const tickInProgress = activityHealthy && activity?.phase === 'tick';
    const childActivity = activityHealthy && activity?.phase === 'post-tick' &&
      typeof activity.activeChildren === 'number' && activity.activeChildren > 0;
    daemon = {
      running: ds.running === true,
      sourceQuality: {
        sourceState: stateConsistent ? 'healthy' : 'degraded',
        complete: stateConsistent,
        reason: stateConsistent
          ? daemonState.fresh ? 'missing' : 'healthy'
          : 'inconsistent',
      },
      pid: ds.pid ?? null,
      startedAt,
      lastTickAt,
      ...(lockHeartbeatAt ? { lockHeartbeatAt } : {}),
      ...(tickInProgress ? { tickInProgress } : {}),
      ...(childActivity ? { childActivity } : {}),
      activity: {
        source: 'daemon-activity',
        sourceState: activityRead.sourceState,
        freshness: activityRead.freshness,
        ownerState: activityRead.ownerState,
        phase: activity?.phase ?? null,
        phaseStartedAt: activityRead.phaseStartedAt,
        observedAt: activity?.observedAt ?? null,
        ageMs: activityRead.ageMs,
        activeChildren: activity?.activeChildren ?? null,
        ownerMatches,
      },
      todaySpentUsd: typeof ds.todaySpentUsd === 'number' ? ds.todaySpentUsd : 0,
    };
    recentTicks = Array.isArray(ds.ticks) ? ds.ticks : [];
  } catch {
    // leave fallback
  }
  return { daemon, recentTicks };
}

/**
 * Build a read-only snapshot of the fleet. Async because the backlog scan is
 * async. NEVER throws — each source is independently guarded.
 */
function laneGoalSourceQuality(read: ListGoalsDetailedResult): FleetLaneLockSourceQualityPart {
  const reasons: FleetLaneLockSourceReason[] = [];
  if (!read.complete) reasons.push('goals-incomplete');
  if (read.unreadableFiles > 0) reasons.push('goals-unreadable');
  if (read.limitExceeded) reasons.push('goals-limit-exceeded');
  const complete = read.complete && read.unreadableFiles === 0 && !read.limitExceeded;
  return {
    // The goal store defines an absent directory as an authoritative empty read.
    sourceState: complete ? 'healthy' : 'degraded',
    complete,
    reasons,
  };
}

function laneEnrollmentSourceQuality(
  state: 'ready' | 'degraded',
): FleetLaneLockSourceQualityPart {
  return state === 'ready'
    ? { sourceState: 'healthy', complete: true, reasons: [] }
    : { sourceState: 'degraded', complete: false, reasons: ['enrollment-degraded'] };
}

function laneProposalSourceQuality(
  read: NonNullable<FleetStatus['proposals']['sourceQuality']>,
): FleetLaneLockSourceQualityPart {
  const reasons: FleetLaneLockSourceReason[] = [];
  if (!read.complete) reasons.push('proposals-incomplete');
  if (read.invalidFiles > 0) reasons.push('proposals-invalid');
  if (read.unreadableFiles > 0) reasons.push('proposals-unreadable');
  if (read.stopReasons.some((reason) => reason.includes('limit'))) reasons.push('proposals-limit-exceeded');
  const complete = read.complete && read.invalidFiles === 0 && read.unreadableFiles === 0 &&
    !read.stopReasons.some((reason) => reason.includes('limit'));
  return {
    // The inbox store also defines an absent directory as an authoritative empty read.
    sourceState: complete ? 'healthy' : 'degraded',
    complete,
    reasons,
  };
}

function laneQueueSourceQuality(
  status: FleetReadinessSourceStatus,
  sources: FleetStatus['queue']['sources'],
  enrollmentState: 'ready' | 'degraded',
  enrolledRepoCount: number,
): FleetLaneLockSourceQualityPart {
  if (enrollmentState === 'degraded') {
    return {
      sourceState: 'degraded',
      complete: false,
      reasons: ['queue-incomplete', 'queue-unavailable'],
    };
  }
  if (enrolledRepoCount === 0) {
    return { sourceState: 'healthy', complete: true, reasons: [] };
  }
  const reasons: FleetLaneLockSourceReason[] = [];
  const parts = sources ? [sources.cachedBacklog, sources.queuedAutonomy] : [];
  if (parts.length === 0 || parts.some((part) => part.sourceState === 'missing')) reasons.push('queue-missing');
  if (status === 'degraded') reasons.push('queue-incomplete');
  if (parts.some((part) => part.sourceState === 'unavailable')) reasons.push('queue-unavailable');
  if (parts.some((part) => part.freshness === 'stale')) reasons.push('queue-stale');
  const sourceState: FleetLaneLockSourceQualityPart['sourceState'] =
    status === 'degraded' || reasons.includes('queue-unavailable') || reasons.includes('queue-stale')
      ? 'degraded'
      : status === 'healthy' && !reasons.includes('queue-missing')
        ? 'healthy'
        : 'missing';
  return {
    sourceState,
    complete: sourceState === 'healthy',
    reasons,
  };
}

export async function buildFleetStatus(cfg: AshlrConfig): Promise<FleetStatus> {
  const generatedAt = new Date().toISOString();
  let dispatchLearningEvents: DispatchProductionEvent[] | undefined;
  let initialDispatchRead: ReturnType<typeof readDispatchProductionYieldDetailed> | undefined;
  let queueSnapshotAt: string | null = null;
  let queueAuthorityObservedAt: string | null = null;
  let queueSourceStatus: FleetReadinessSourceStatus = 'unknown';
  let queueSourceDetail = 'backlog snapshot has not been read yet';

  // ── daemon ────────────────────────────────────────────────────────────────
  const daemonRead = await readFleetDaemonStatus();
  const daemon = daemonRead.daemon;
  // Recent ticks are reused for merge counting below.
  const recentTicks = daemonRead.recentTicks;
  try {
    const { inspectDaemonActivationPermit } = await import('../daemon/activation-permit.js');
    daemon.activation = inspectDaemonActivationPermit(cfg, {
      once: true,
      dryRun: false,
    });
  } catch {
    daemon.activation = {
      schemaVersion: 1,
      policyVersion: 'm461-proposal-once-v1',
      authority: 'observation-only',
      sourceState: 'degraded',
      state: 'degraded',
      commandEligible: false,
      requestedShape: 'proposal-once',
      trustRootCount: 0,
      residentAuthorized: false,
      residentStandingAuthorized: false,
      installAuthorized: false,
      repairAuthorized: false,
      reason: 'activation-readiness-unavailable',
    };
  }
  const diagnosticResliceDrain = buildDiagnosticResliceDrainStatus(recentTicks);
  const activeWork = await buildActiveWorkStatus();

  // ── backends ────────────────────────────────────────────────────────────────
  const allowed: EngineId[] = cfg.foundry?.allowedBackends ?? ['builtin'];
  const backends: FleetBackendStatus[] = [];
  for (const backend of allowed) {
    let dispatchesRecent = 0;
    let quota: FleetBackendStatus['quota'] = 'unlimited';
    try {
      const { usesInWindow, evalFleetQuotaAuthority } = await import('./quota.js');
      // quota.json is actual-attempt telemetry; quota-reservations.json is the
      // separate fail-closed launch authority. Never report a healthy quota
      // when strict authority state/config would refuse provider contact.
      dispatchesRecent = usesInWindow(backend, RECENT_WINDOW_MS);
      // Quota standing: 'unlimited' when no limit is configured for this backend.
      quota = evalFleetQuotaAuthority(backend, cfg);
    } catch {
      // Ledger unavailable — fall back to summing recent tick.backends counts.
      try {
        dispatchesRecent = sumRecentBackend(recentTicks, backend);
      } catch {
        dispatchesRecent = 0;
      }
      quota = cfg.foundry?.limits?.[backend] ? 'over' : 'unlimited';
    }
    backends.push({ backend, dispatchesRecent, quota });
  }
  try {
    await attachBackendResources(backends, cfg);
  } catch {
    // Optional observability only; backend rows remain useful without resources.
  }

  // ── queue (backlog size) ──────────────────────────────────────────────────
  let backlogItems = 0;
  let visibleQueueItems: WorkItem[] = [];
  let actionableQueueItems: WorkItem[] = [];
  let nextQueueItems: FleetQueueNextItem[] = [];
  let eligibleBacklogItems = 0;
  let cooldownItems = 0;
  let pendingItems = 0;
  let repairRouteBlockedItems = 0;
  let repairControlBlockedItems = 0;
  let repairLifecycleUnavailableItems = 0;
  let repairTerminalItems = 0;
  let repairQuarantinedItems = 0;
  let generatedRepairRoutes: FleetGeneratedRepairRouteStatus | undefined;
  let eligibleOrdinaryItems: number | null = null;
  let nextEligibleAt: string | null = null;
  let queueRepos: FleetQueueRepoCoverage | undefined;
  let generatedWork: FleetQueueGeneratedWorkStatus | undefined;
  let queueInventorySources: FleetStatus['queue']['sources'];
  let scannerEvidence: FleetQueueScannerEvidenceStatus | undefined;
  let resolutionObserver: FleetResolutionObserverStatus | undefined;
  let enrolledExistingRepos: string[] = [];
  const enrollmentRegistry: {
    state: 'ready';
    repos: string[];
    reason: string;
  } | {
    state: 'degraded';
    reason: string;
  } = (() => {
    try {
      return readEnrollmentRegistry();
    } catch {
      return { state: 'degraded', reason: 'enrollment registry read failed' };
    }
  })();
  const repairHandoffWriterConfigured = cfg.foundry?.repairHandoffV2Write === true;
  const repairHandoffActivationRaw = (cfg.foundry as Record<string, unknown> | undefined)?.['repairHandoffV2Activation'];
  const repairHandoffActivation = validRepairHandoffV2Activation(repairHandoffActivationRaw)
    ? repairHandoffActivationRaw
    : undefined;
  let repairHandoffSummary: RepairHandoffSchemaSummary | undefined;
  try {
    repairHandoffSummary = readRepairHandoffSchemaSummary(repairHandoffActivation);
  } catch {
    repairHandoffSummary = undefined;
  }
  try {
    // Status must be observational. A full buildBacklog() refresh can run
    // scanners, expand planning goals, persist ~/.ashlr/backlog.json, and audit.
    // Read the last persisted snapshot only; the daemon/backlog CLI owns refresh.
    const { loadBacklog } = await import('../portfolio/backlog.js');
    const backlog = loadBacklog();
    queueSnapshotAt = typeof backlog?.generatedAt === 'string' ? backlog.generatedAt : null;
    if (Array.isArray(backlog?.observations)) {
      const present = backlog.observations.filter((observation) => observation.status === 'present').length;
      const absent = backlog.observations.filter((observation) => observation.status === 'absent').length;
      const unavailable = backlog.observations.filter((observation) => observation.status === 'unavailable').length;
      scannerEvidence = {
        state: backlog.observationSourceState === 'degraded' || backlog.observationsTruncated === true
          ? 'degraded'
          : backlog.observations.length === 0
            ? 'unknown'
            : unavailable > 0 ? 'degraded' : 'healthy',
        observations: backlog.observations.length,
        present,
        absent,
        unavailable,
        scannerDomains: new Set(backlog.observations.map((observation) => observation.scannerId)).size,
      };
    }
    const enrolledRaw = enrollmentRegistry.state === 'ready'
      ? enrollmentRegistry.repos.map((repo) => resolve(repo))
      : [];
    const enrolledRepos = new Set(enrolledRaw.filter((repo) => existsSync(repo)));
    enrolledExistingRepos = [...enrolledRepos];
    const nowMs = Date.now();
    const cachedItems = mergeVisibleQueueItems(
      Array.isArray(backlog?.items) ? backlog.items : [],
      enrolledRepos,
    );
    const cachedFreshness = backlog
      ? queueInventoryFreshness(queueSnapshotAt, nowMs)
      : 'unknown';
    const queuedRead = loadQueuedAutonomyItemsDetailed();
    const queuedItems = mergeVisibleQueueItems(queuedRead.items, enrolledRepos);
    // The strict queued-autonomy read is a live observation. Its loader already
    // applies daemon-equivalent intrinsic expiry while retaining generation-bound
    // repairs for their durable lifecycle, so item.ts must not become a second
    // source-freshness gate here.
    const queuedObservedAt = queuedRead.sourceState === 'complete' && queuedItems.length > 0
      ? generatedAt
      : null;
    const actionableQueuedItems = queuedRead.sourceState === 'complete' ? queuedItems : [];
    const queuedFreshness: FleetQueueInventorySourceStatus['freshness'] = queuedItems.length === 0
      ? queuedRead.sourceState === 'complete' ? 'empty' : 'unknown'
      : queuedRead.sourceState === 'complete' ? 'fresh' : 'unknown';
    const freshCachedItems = cachedFreshness === 'fresh' ? cachedItems : [];
    actionableQueueItems = mergeVisibleQueueItems(
      [...freshCachedItems, ...actionableQueuedItems],
      enrolledRepos,
    );
    const items = mergeVisibleQueueItems([...cachedItems, ...queuedItems], enrolledRepos);
    visibleQueueItems = items;
    backlogItems = items.length;
    generatedWork = buildQueueGeneratedWorkStatus(items);
    queueInventorySources = {
      cachedBacklog: {
        provenance: 'persisted-backlog',
        sourceState: backlog ? 'complete' : 'missing',
        freshness: backlog ? cachedFreshness : 'unknown',
        observedAt: queueSnapshotAt,
        visibleItems: cachedItems.length,
        actionableItems: freshCachedItems.length,
        detail: backlog
          ? `${cachedItems.length} enrolled item(s) in persisted backlog snapshot`
          : 'persisted backlog snapshot is missing or unreadable',
      },
      queuedAutonomy: {
        provenance: 'queued-autonomy',
        sourceState: queuedRead.sourceState,
        freshness: queuedFreshness,
        observedAt: queuedObservedAt,
        visibleItems: queuedItems.length,
        actionableItems: actionableQueuedItems.length,
        detail: queuedRead.sourceState === 'complete'
          ? `${actionableQueuedItems.length}/${queuedItems.length} queued autonomy item(s) passed daemon queue admission`
          : `queued autonomy source is unavailable (${queuedRead.filesUnavailable} file(s) unavailable)`,
      },
    };
    const observedTimestamps = [
      queueSnapshotAt,
      queuedObservedAt,
    ].filter((ts): ts is string => ts !== null && Number.isFinite(Date.parse(ts)));
    queueAuthorityObservedAt = observedTimestamps
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    const hasDegradedInventory =
      enrollmentRegistry.state === 'degraded' ||
      (Boolean(backlog) && cachedFreshness !== 'fresh') ||
      queuedRead.sourceState === 'unavailable';
    if (hasDegradedInventory) {
      queueSourceStatus = 'degraded';
    } else if (backlog || queuedItems.length > 0) {
      queueSourceStatus = 'healthy';
    } else if (queuedRead.sourceState === 'complete') {
      queueSourceStatus = 'unknown';
    } else {
      queueSourceStatus = 'unavailable';
    }
    queueSourceDetail = enrollmentRegistry.state === 'degraded'
      ? `enrollment authority degraded: ${enrollmentRegistry.reason}; queue inventory withheld`
      : `${items.length} visible queue item(s); ${actionableQueueItems.length} actionable from fresh sources; ` +
        `cached backlog ${queueInventorySources.cachedBacklog.freshness}; ` +
        `queued autonomy ${queueInventorySources.queuedAutonomy.freshness}`;
    if (enrollmentRegistry.state === 'degraded') {
      // The registry itself was observed during this snapshot. Its current
      // degraded result must not be mislabeled as an unknown or healthy-zero source.
      queueAuthorityObservedAt = generatedAt;
    }
    if (
      generatedWork &&
      generatedWork.diagnosticReslices > 0 &&
      diagnosticResliceDrain?.stalled === true
    ) {
      generatedWork = { ...generatedWork, diagnosticResliceDrainStalled: true };
    }
    const byRepo = new Map<string, number>();
    const byTier = new Map<StrategicTier, { repos: Set<string>; items: number }>();
    for (const item of items) {
      const key = resolve(item.repo);
      byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
      const tier = strategicTierOfRepo(key);
      const tierRow = byTier.get(tier) ?? { repos: new Set<string>(), items: 0 };
      tierRow.repos.add(key);
      tierRow.items++;
      byTier.set(tier, tierRow);
    }
    queueRepos = {
      enrolled: enrolledRaw.length,
      existing: enrolledRepos.size,
      withBacklog: byRepo.size,
      silent: Math.max(0, enrolledRepos.size - byRepo.size),
      ...(enrollmentRegistry.state === 'degraded'
        ? { registry: { state: 'degraded' as const, reason: enrollmentRegistry.reason } }
        : {}),
      executionProfiles: buildRepoExecutionCoverage(enrolledRepos),
      byTier: (['core-fleet', 'force-multiplier', 'inventory', 'supporting'] as StrategicTier[])
        .flatMap((tier) => {
          const row = byTier.get(tier);
          return row ? [{ tier, repos: row.repos.size, items: row.items }] : [];
        }),
      top: [...byRepo.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 8)
        .map(([repo, itemCount]) => ({ repo, items: itemCount })),
    };
  } catch {
    backlogItems = 0;
    visibleQueueItems = [];
    actionableQueueItems = [];
    nextQueueItems = [];
    queueSnapshotAt = null;
    queueAuthorityObservedAt = enrollmentRegistry.state === 'degraded' ? generatedAt : null;
    queueSourceStatus = enrollmentRegistry.state === 'degraded' ? 'degraded' : 'unavailable';
    queueSourceDetail = enrollmentRegistry.state === 'degraded'
      ? `enrollment authority degraded: ${enrollmentRegistry.reason}; queue inventory withheld`
      : 'queue source could not be read';
    queueRepos = enrollmentRegistry.state === 'degraded'
      ? {
          enrolled: 0,
          existing: 0,
          withBacklog: 0,
          silent: 0,
          registry: { state: 'degraded', reason: enrollmentRegistry.reason },
          top: [],
          byTier: [],
        }
      : undefined;
    queueInventorySources = {
      cachedBacklog: {
        provenance: 'persisted-backlog',
        sourceState: 'unavailable',
        freshness: 'unknown',
        observedAt: null,
        visibleItems: 0,
        actionableItems: 0,
        detail: 'persisted backlog source could not be read',
      },
      queuedAutonomy: {
        provenance: 'queued-autonomy',
        sourceState: 'unavailable',
        freshness: 'unknown',
        observedAt: null,
        visibleItems: 0,
        actionableItems: 0,
        detail: 'queued autonomy source could not be read',
      },
    };
  }

  try {
    const observer = readResolutionObserverStatus();
    const queueMs = queueSnapshotAt ? Date.parse(queueSnapshotAt) : NaN;
    const observerMs = observer.lastBacklogAt ? Date.parse(observer.lastBacklogAt) : NaN;
    const lagMs = Number.isFinite(queueMs) && Number.isFinite(observerMs)
      ? Math.max(0, queueMs - observerMs)
      : null;
    const freshness: FleetResolutionObserverStatus['freshness'] =
      observer.state === 'degraded'
        ? 'degraded'
        : observer.state === 'missing' || !queueSnapshotAt || !observer.lastBacklogAt
          ? 'missing'
          : observerMs > queueMs
            ? 'degraded'
            : observer.lastBacklogAt === queueSnapshotAt
            ? 'current'
            : 'stale';
    resolutionObserver = { ...observer, freshness, lagMs };
  } catch {
    resolutionObserver = {
      state: 'degraded',
      checkpointState: 'degraded',
      runState: 'degraded',
      witnessState: 'degraded',
      freshness: 'degraded',
      lagMs: null,
      lastRunAt: null,
      lastBacklogAt: null,
      lastOutcome: null,
      pendingObjectives: 0,
      witnesses: 0,
      latestWitnessAt: null,
      invalidRows: 1,
      conflictingWitnesses: 0,
    };
  }

  let sharedQueue: FleetSharedQueueStatus | undefined;
  try {
    sharedQueue = await buildSharedQueueStatus(cfg);
  } catch {
    sharedQueue = undefined;
  }

  // ── proposals (pending / frontier-pending / applied) ──────────────────────
  let pending = 0;
  let frontierPending = 0;
  let awaitingHostMerge = 0;
  let applied = 0;
  const allProposals: Proposal[] = [];
  const pendingProposals: Proposal[] = [];
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
  let proposalsSnapshotForLearning:
    ReturnType<typeof import('../inbox/store.js')['listProposalsDetailed']> | undefined;
  try {
    const { listProposalsDetailed } = await import('../inbox/store.js');
    const read = listProposalsDetailed();
    // Retained for the learning-authority inspection below: it must see the
    // SAME proposals snapshot this status build projected, not issue its own
    // mid-snapshot read (which tears the stability contract and doubles I/O).
    proposalsSnapshotForLearning = read;
    proposalSourceQuality = {
      sourceState: read.sourceState,
      sourcePresent: read.sourcePresent,
      complete: read.complete,
      stopReasons: [...read.stopReasons],
      filesDiscovered: read.filesDiscovered,
      filesRead: read.filesRead,
      invalidFiles: read.invalidFiles,
      unreadableFiles: read.unreadableFiles,
    };
    const all = read.proposals;
    for (const p of all) {
      allProposals.push(p);
      if (p.status === 'pending') {
        pending++;
        pendingProposals.push(p);
        if (p.engineTier === 'frontier') frontierPending++;
      } else if (p.status === 'applied') {
        applied++;
      } else if (p.status === 'awaiting-host-merge') {
        awaitingHostMerge++;
      }
    }
  } catch {
    pending = 0;
    frontierPending = 0;
    awaitingHostMerge = 0;
    applied = 0;
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

  try {
    const eligibility = buildQueueEligibility(
      actionableQueueItems,
      pendingProposals,
      cfg,
      repairHandoffSummary !== undefined &&
        repairHandoffSummary.sourceState !== 'degraded' &&
        (cfg.foundry as Record<string, unknown> | undefined)?.['proposalRepair'] !== false &&
        cfg.fleet?.sharedQueue?.mode !== 'filesystem',
    );
    eligibleBacklogItems = eligibility.eligibleItems.length;
    cooldownItems = eligibility.cooldownItems;
    pendingItems = eligibility.pendingItems;
    repairRouteBlockedItems = eligibility.repairRouteBlockedItems;
    repairControlBlockedItems = eligibility.repairControlBlockedItems;
    repairLifecycleUnavailableItems = eligibility.repairLifecycleUnavailableItems;
    repairTerminalItems = eligibility.repairTerminalItems;
    repairQuarantinedItems = eligibility.repairQuarantinedItems;
    generatedRepairRoutes = eligibility.generatedRepairRoutes;
    eligibleOrdinaryItems = queueSourceStatus === 'unknown' || queueSourceStatus === 'unavailable'
      ? null
      : eligibility.eligibleItems.filter((item) => !item.tags.includes('proposal-repair')).length;
    nextEligibleAt = eligibility.nextEligibleAt;
    nextQueueItems = eligibility.eligibleItems
      .slice()
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, 5)
      .map((item) => ({
        id: item.id,
        title: item.title,
        repo: item.repo,
        source: item.source,
        score: item.score,
      }));
  } catch {
    eligibleBacklogItems = 0;
    cooldownItems = 0;
    pendingItems = 0;
    nextEligibleAt = null;
  }

  // ── merges (authenticated realized proposal witnesses only) ───────────────
  let mergesRecent = 0;
  let mergesReportedByTicks = 0;
  try {
    const now = Date.now();
    const cutoff = now - RECENT_WINDOW_MS;
    const counted = new Set<string>();
    for (const proposal of allProposals) {
      if (counted.has(proposal.id)) continue;
      const evidence = realizedMergeOf(proposal);
      if (!evidence) continue;
      const observedAt = evidence.source === 'local-default-branch'
        ? evidence.observedAt
        : evidence.reconciliation.observedAt;
      const observedMs = Date.parse(observedAt);
      if (!Number.isFinite(observedMs) || observedMs < cutoff || observedMs > now) continue;
      counted.add(proposal.id);
      mergesRecent++;
    }

    // Preserve tick aggregates as explicitly non-authoritative forensic data.
    for (const t of recentTicks) {
      if (typeof t.merged !== 'number' || t.merged <= 0) continue;
      mergesReportedByTicks = Math.min(
        Number.MAX_SAFE_INTEGER,
        mergesReportedByTicks + Math.floor(t.merged),
      );
    }
  } catch {
    mergesRecent = 0;
    mergesReportedByTicks = 0;
  }

  // ── kill switch ───────────────────────────────────────────────────────────
  let killed = true;
  let killSwitch: NonNullable<FleetStatus['killSwitch']> = {
    state: 'unknown',
    sourceState: 'degraded',
    reason: 'unavailable',
  };
  try {
    const { readKillSwitch } = await import('../sandbox/policy.js');
    const read = readKillSwitch();
    killSwitch = {
      state: read.state,
      sourceState: read.sourceState,
      reason: read.reason,
    };
    killed = read.state !== 'inactive';
  } catch {
    // Restrictive fallback: unobservable authority remains paused.
  }

  // ── guard health / state repair UX ──────────────────────────────────────
  let guardHealth: GuardHealthDiagnosis | undefined;
  try {
    const { diagnoseGuardHealth } = await import('../daemon/guard-health.js');
    guardHealth = diagnoseGuardHealth();
  } catch {
    guardHealth = {
      generatedAt,
      blocked: true,
      blocks: [],
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reasons: ['guard-health-unavailable'],
      },
    };
  }

  // ── autonomy evidence packs ──────────────────────────────────────────────
  let autonomy: FleetAutonomyStatus = {
    evidencePacks: 0,
    latestAt: null,
    allowed: 0,
    denied: 0,
    byTier: {},
    recent: [],
    authorityState: 'degraded',
    protocols: { sealedV3: 0, legacy: 0 },
    sourceQuality: {
      sourceState: 'degraded',
      sourcePresent: false,
      complete: false,
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
      limitExceeded: false,
    },
  };
  let learningEvidenceRead: AutonomyEvidencePacksReadResult | undefined;
  try {
    const { readAutonomyEvidencePacksDetailed } = await import('../autonomy/evidence-pack.js');
    const evidenceRead = readAutonomyEvidencePacksDetailed(Number.MAX_SAFE_INTEGER);
    learningEvidenceRead = evidenceRead;
    autonomy = buildAutonomyStatus(evidenceRead.packs, evidenceRead);
  } catch {
    // leave fallback
  }

  let autoMergeReadiness: FleetAutoMergeReadinessStatus | undefined;
  const proposalAuthority = proposalAuthoritySource(proposalSourceQuality);
  // Preserve configuration/protection diagnostics for a pristine empty store,
  // while keeping its proposal authority explicitly unavailable. Degraded or
  // partial stores with observed rows remain fully withheld.
  if (proposalAuthority.gate === 'ready' || proposalSourceQuality.sourceState === 'missing') {
    try {
      autoMergeReadiness = await buildAutoMergeReadinessStatus(
        cfg,
        pendingProposals,
        enrolledExistingRepos,
        enrollmentRegistry,
      );
    } catch {
      autoMergeReadiness = undefined;
    }
  }

  let goalFocus: FleetGoalFocusStatus | undefined;
  let goalRead: ListGoalsDetailedResult = {
    goals: [],
    sourceState: 'degraded',
    sourcePresent: false,
    complete: false,
    scannedFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
  };
  try {
    goalRead = listGoalsDetailed();
    const goals = goalRead.goals.filter((goal) => goal.status === 'active' || goal.status === 'planning');
    const snapshot = goalFocusSnapshot(goals, cfg, {
      repos: enrolledExistingRepos,
      isMilestoneComplete: createProposalMilestoneCompletionPredicate(),
    });
    goalFocus = {
      enabled: snapshot.enabled,
      activeThreshold: snapshot.activeThreshold,
      activeGoalCount: snapshot.activeGoalCount,
      actionableActiveGoalCount: snapshot.actionableActiveGoalCount,
      planningGoalCount: snapshot.planningGoalCount,
      deferredNewGoalWork: snapshot.shouldDeferNewGoalWork,
      reason: snapshot.reason,
      visibleGoalBacklogItems: visibleQueueItems.filter((item) => item.source === 'goal').length,
      visibleInventBacklogItems: visibleQueueItems.filter((item) => item.source === 'invent').length,
    };
  } catch {
    goalFocus = undefined;
  }

  let laneLocks: FleetLaneLocksStatus | undefined;
  try {
    const enrolledRepoSet = new Set(enrolledExistingRepos);
    const laneGoals = goalRead.goals.filter(
      (goal) => goal.project !== null && enrolledRepoSet.has(resolve(goal.project)),
    );
    const laneProposals = allProposals.filter(
      (proposal) => proposal.repo === null || enrolledRepoSet.has(resolve(proposal.repo)),
    );
    laneLocks = buildFleetLaneLocks({
      goals: laneGoals,
      proposals: laneProposals,
      visibleQueueItems,
      generatedAt,
      sourceQuality: {
        enrollment: laneEnrollmentSourceQuality(enrollmentRegistry.state),
        goals: laneGoalSourceQuality(goalRead),
        proposals: laneProposalSourceQuality(proposalSourceQuality),
        queue: laneQueueSourceQuality(
          queueSourceStatus,
          queueInventorySources,
          enrollmentRegistry.state,
          enrolledExistingRepos.length,
        ),
      },
    });
  } catch {
    laneLocks = buildFleetLaneLocks({
      goals: [],
      proposals: [],
      visibleQueueItems: [],
      generatedAt,
      sourceQuality: {
        enrollment: { sourceState: 'degraded', complete: false, reasons: ['enrollment-degraded'] },
        goals: { sourceState: 'degraded', complete: false, reasons: ['goals-incomplete'] },
        proposals: { sourceState: 'degraded', complete: false, reasons: ['proposals-incomplete'] },
        queue: { sourceState: 'degraded', complete: false, reasons: ['queue-unavailable'] },
      },
    });
  }

  const phantom = await buildFleetPhantomStatus(cfg);

  let repairHandoffRollout: FleetRepairHandoffRolloutStatus;
  if (repairHandoffSummary !== undefined) {
    const summary = repairHandoffSummary;
    const sharedQueueIncompatible = cfg.fleet?.sharedQueue?.mode === 'filesystem';
    const writerBlockedReason: FleetRepairHandoffRolloutStatus['writerBlockedReason'] = !repairHandoffWriterConfigured
      ? null
      : !repairHandoffActivation
        ? 'missing-activation'
        : Date.parse(repairHandoffActivation.activatedAt) > Date.parse(generatedAt)
          ? 'activation-in-future'
        : sharedQueueIncompatible
          ? 'shared-queue-filesystem'
          : summary.sourceState === 'degraded' || summary.limitExceeded
            ? 'source-degraded'
            : null;
    const writerEffective = repairHandoffWriterConfigured && writerBlockedReason === null;
    const projectionTickAt = writerEffective && summary.currentActivationV2Authorities > 0
      ? repairHandoffProjectionTick(
          recentTicks,
          summary.authorityDigest,
          summary.latestCurrentActivationV2At ?? repairHandoffActivation!.activatedAt,
          {
            id: repairHandoffActivation!.id,
            activatedAt: repairHandoffActivation!.activatedAt,
            authorities: summary.currentActivationV2Authorities,
            authorityDigest: summary.currentActivationAuthorityDigest!,
          },
        )
      : null;
    repairHandoffRollout = buildRepairHandoffRolloutStatus(
      summary,
      repairHandoffWriterConfigured,
      eligibleOrdinaryItems,
      projectionTickAt,
      {
        activationAware: true,
        effective: writerEffective,
        blockedReason: writerBlockedReason,
        ...(repairHandoffActivation ? { activation: repairHandoffActivation } : {}),
      },
    );
  } else {
    repairHandoffRollout = {
      summaryAvailable: false,
      writerConfigured: repairHandoffWriterConfigured,
      writerEnabled: repairHandoffWriterConfigured,
      writerEffective: false,
      writerBlockedReason: 'source-degraded',
      activationId: repairHandoffActivation?.id ?? null,
      activatedAt: repairHandoffActivation?.activatedAt ?? null,
      phase: 'degraded',
      sourceState: 'degraded',
      v1Authorities: null,
      v2Authorities: null,
      v1PhysicalRows: null,
      v2PhysicalRows: null,
      invalidRows: null,
      conflictingIds: null,
      limitExceeded: null,
      aliasFamilies: null,
      latestV2At: null,
      currentActivationV2Authorities: null,
      unboundV2Authorities: null,
      latestCurrentActivationV2At: null,
      authorityDigest: null,
      projectionObserved: false,
      projectionTickAt: null,
      eligibleOrdinaryItems,
      action: repairHandoffWriterConfigured ? 'rollback-writer' : 'inspect-source',
    };
  }

  const status: FleetStatus = {
    generatedAt,
    buildIdentity: readBuildIdentity(),
    daemon,
    backends,
    queue: {
      backlogItems,
      eligibleBacklogItems,
      cooldownItems,
      pendingItems,
      ...(repairRouteBlockedItems > 0 ? { repairRouteBlockedItems } : {}),
      ...(repairControlBlockedItems > 0 ? { repairControlBlockedItems } : {}),
      ...(repairLifecycleUnavailableItems > 0 ? { repairLifecycleUnavailableItems } : {}),
      ...(repairTerminalItems > 0 ? { repairTerminalItems } : {}),
      ...(repairQuarantinedItems > 0 ? { repairQuarantinedItems } : {}),
      nextEligibleAt,
      ...(queueRepos !== undefined ? { repos: queueRepos } : {}),
      ...(nextQueueItems.length > 0 ? { next: nextQueueItems } : {}),
      ...(queueInventorySources !== undefined ? { sources: queueInventorySources } : {}),
      ...(sharedQueue !== undefined ? { shared: sharedQueue } : {}),
      ...(activeWork !== undefined ? { activeWork } : {}),
      ...(generatedWork !== undefined ? { generatedWork } : {}),
      ...(generatedRepairRoutes !== undefined ? { generatedRepairRoutes } : {}),
      ...(scannerEvidence !== undefined ? { scannerEvidence } : {}),
      ...(resolutionObserver !== undefined ? { resolutionObserver } : {}),
      ...(diagnosticResliceDrain !== undefined ? { diagnosticResliceDrain } : {}),
    },
    ...(repairHandoffRollout !== undefined ? { repairHandoffRollout } : {}),
    proposals: {
      pending,
      frontierPending,
      ...(awaitingHostMerge > 0 ? { awaitingHostMerge } : {}),
      applied,
      sourceQuality: proposalSourceQuality,
      authority: proposalAuthority,
    },
    merges: {
      recent: mergesRecent,
      reportedByTicks: mergesReportedByTicks,
      sourceQuality: proposalSourceQuality,
    },
    ...(phantom !== undefined ? { phantom } : {}),
    autonomy,
    autonomyControlMode: resolveAutonomyControlMode(cfg),
    evidencePolicy: {
      concurrentDispatchEnabled: cfg.foundry?.fabric?.concurrentDispatch === true,
      bestOfNEnabled: (cfg.foundry?.bestOfN ?? 1) > 1,
    },
    ...(autoMergeReadiness !== undefined ? { autoMergeReadiness } : {}),
    ...(guardHealth !== undefined ? { guardHealth } : {}),
    ...(goalFocus !== undefined ? { goalFocus } : {}),
    ...(laneLocks !== undefined ? { laneLocks } : {}),
    killed,
    killSwitch,
  };
  const proposalProduction = buildProposalProductionStatus(recentTicks);
  if (proposalProduction) status.proposalProduction = proposalProduction;
  let learningDecisionsRead: ReturnType<typeof readDecisionsDetailed> | undefined;
  try {
    const decisionsRead = readDecisionsDetailed();
    learningDecisionsRead = decisionsRead;
    status.decisionsSource = {
      sourceState: decisionsRead.sourceState,
      sourcePresent: decisionsRead.sourcePresent,
      complete: decisionsRead.complete,
      stopReasons: decisionsRead.stopReasons,
      filesRead: decisionsRead.filesRead,
      bytesRead: decisionsRead.bytesRead,
      rowsScanned: decisionsRead.rowsScanned,
      invalidRows: decisionsRead.invalidRows,
      unreadableFiles: decisionsRead.unreadableFiles,
    };
  } catch {
    status.decisionsSource = {
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
      filesRead: 0,
      bytesRead: 0,
      rowsScanned: 0,
      invalidRows: 0,
      unreadableFiles: 1,
    };
  }
  try {
    const { inspectRoutingLearningAuthority } = await import('../run/learned-router.js');
    status.routingLearningAuthority = inspectRoutingLearningAuthority(
      undefined,
      undefined,
      { proposalsRead: proposalsSnapshotForLearning },
    );
  } catch {
    status.routingLearningAuthority = {
      version: 1,
      state: 'inactive',
      operationalSteering: false,
      sourceQuality: {
        decisions: {
          sourceState: 'degraded', sourcePresent: true, complete: false, authenticated: false,
        },
        assignments: {
          sourceState: 'degraded', sourcePresent: true, complete: false,
          denominatorComplete: false, authenticated: false,
        },
      },
      samples: { observed: 0, eligible: 0, minimumPerStratum: 5 },
      cohort: { policyVersion: null, learningEpoch: null },
      blockerCodes: [
        'assignment-authenticity-unavailable',
        'assignment-denominator-incomplete',
        'assignment-source-degraded',
        'decision-authenticity-unavailable',
        'decision-source-degraded',
        'sample-floor-unmet',
      ],
    };
  }
  let learningJudgeTracesRead: ReturnType<typeof readJudgeTracesDetailed> | undefined;
  try {
    const traceRead = readJudgeTracesDetailed();
    learningJudgeTracesRead = traceRead;
    status.judgeTraceSource = {
      sourceState: traceRead.sourceState,
      sourcePresent: traceRead.sourcePresent,
      complete: traceRead.complete,
      stopReasons: traceRead.stopReasons,
      filesRead: traceRead.filesRead,
      bytesRead: traceRead.bytesRead,
      rowsScanned: traceRead.rowsScanned,
      invalidRows: traceRead.invalidRows,
      unreadableFiles: traceRead.unreadableFiles,
    };
  } catch {
    status.judgeTraceSource = {
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['io-error'],
      filesRead: 0,
      bytesRead: 0,
      rowsScanned: 0,
      invalidRows: 0,
      unreadableFiles: 1,
    };
  }
  try {
    const dispatchRead = readDispatchProductionYieldDetailed({
      windowMs: RECENT_WINDOW_MS,
      limit: 1200,
      limitPerDimension: 8,
    });
    initialDispatchRead = dispatchRead;
    status.dispatchProductionSource = dispatchRead.sourceQuality;
    status.proposalFunnel = buildProposalFunnelObservability({
      events: dispatchRead.events,
      sourceQuality: dispatchRead.sourceQuality,
      windowMs: RECENT_WINDOW_MS,
      eventLimit: 1200,
    });
    const dispatchAvailabilitySource = learningSourceAvailability(
      'dispatch-production', dispatchRead.sourceQuality,
    );
    const dispatchProductionAvailability = learningMetricAvailability(
      [dispatchAvailabilitySource],
      learningSourceAvailable(dispatchAvailabilitySource) ? [] : ['dispatchProduction'],
      1,
    );
    status.learningMetrics = dispatchRead.sourceQuality.sourceState === 'healthy' && dispatchRead.sourceQuality.complete
      ? {
          state: 'available',
          denominator: 'dispatch-production',
          sourceQuality: dispatchRead.sourceQuality,
          dispatchProduction: dispatchProductionAvailability,
        }
      : {
          state: 'withheld',
          denominator: 'dispatch-production',
          reason: dispatchRead.sourceQuality.sourceState === 'missing'
            ? 'dispatch-source-missing'
            : 'dispatch-source-degraded',
          sourceQuality: dispatchRead.sourceQuality,
          dispatchProduction: dispatchProductionAvailability,
        };
    if (status.learningMetrics.state === 'available') {
      dispatchLearningEvents = dispatchRead.events;
    }
    const dispatchProduction = dispatchRead.summary;
    if (dispatchProduction) {
      status.dispatchProduction = dispatchProduction;
      if (dispatchRead.sourceQuality.sourceState === 'healthy' && dispatchRead.sourceQuality.complete) {
        status.dispatchYieldDiagnostics = buildDispatchYieldDiagnostics(dispatchProduction, cfg, backends);
      }
    }
  } catch {
    const sourceQuality: DispatchProductionSourceQuality = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, datedFilesRead: 0, looseFilesRead: 0,
      bytesRead: 0, rowsScanned: 0, invalidRows: 0, unreadableFiles: 1,
    };
    status.dispatchProductionSource = sourceQuality;
    status.proposalFunnel = buildProposalFunnelObservability({
      events: [],
      sourceQuality,
      windowMs: RECENT_WINDOW_MS,
      eventLimit: 1200,
    });
    status.learningMetrics = {
      state: 'withheld',
      denominator: 'dispatch-production',
      reason: 'dispatch-source-degraded',
      sourceQuality,
      dispatchProduction: learningMetricAvailability(
        [learningSourceAvailability('dispatch-production', sourceQuality)],
        ['dispatchProduction'],
        1,
      ),
    };
  }
  try {
    const dispatchManifests = await buildDispatchManifestStatus();
    status.dispatchManifestSource = dispatchManifests.sourceQuality;
    if (dispatchManifests.summary) status.dispatchManifests = dispatchManifests.summary;
  } catch {
    // Optional forensic manifest surface only.
  }
  if (status.evidencePolicy?.bestOfNEnabled === true) {
    try {
      const bestOfN = readBestOfNRecordsDetailed({
        sinceMs: Date.parse(generatedAt) - 30 * 24 * 60 * 60 * 1000,
        limit: 100_000,
        maxFiles: 31,
        maxBytes: 32 * 1024 * 1024,
        maxRows: 100_000,
      });
      status.bestOfNSource = {
        sourceState: bestOfN.sourceState,
        sourcePresent: bestOfN.sourcePresent,
        complete: bestOfN.complete,
        stopReasons: bestOfN.stopReasons,
        filesRead: bestOfN.filesRead,
        bytesRead: bestOfN.bytesRead,
        rowsScanned: bestOfN.rowsScanned,
        invalidRows: bestOfN.invalidRows,
        unreadableFiles: bestOfN.unreadableFiles,
      };
    } catch {
      status.bestOfNSource = {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
        invalidRows: 0, unreadableFiles: 1,
      };
    }
  }
  let learningPostMergeRead: PostMergeObservationReadResult | undefined;
  try {
    const adverse = readPostMergeObservations({ requireComplete: true });
    learningPostMergeRead = adverse;
    const stability = readPostMergeStability({ requireComplete: true });
    const projection = projectPostMergeComposite(adverse, stability);
    status.postMergeSource = projection.source;
    if (projection.cohort) status.postMergeCohort = projection.cohort;
  } catch {
    status.postMergeSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
  }
  let detachedTickets: DetachedPostMergeWorkTicketReadResult | null = null;
  try {
    detachedTickets = readDetachedPostMergeWorkTickets({ requireComplete: true });
    status.detachedPostMergeWorkTicketSource = {
      sourceState: detachedTickets.sourceState,
      sourcePresent: detachedTickets.sourcePresent,
      complete: detachedTickets.complete,
      stopReasons: detachedTickets.stopReasons,
      filesRead: detachedTickets.filesRead,
      bytesRead: detachedTickets.bytesRead,
      rowsScanned: detachedTickets.tickets.length,
      invalidRows: detachedTickets.invalidFiles,
      unreadableFiles: detachedTickets.stopReasons.includes('io-error') ? 1 : 0,
    };
  } catch {
    status.detachedPostMergeWorkTicketSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
  }
  try {
    const detached = readDetachedPostMergeVerificationCohorts({ requireComplete: true });
    const denominator = readCurrentDetachedPostMergeDenominator();
    const denominatorProjection = projectDetachedPostMergeDenominator(
      denominator,
      detached,
      detachedTickets,
    );
    status.detachedPostMergeVerificationSource = {
      sourceState: detached.sourceState,
      sourcePresent: detached.sourcePresent,
      complete: detached.complete,
      stopReasons: detached.stopReasons,
      filesRead: detached.filesRead,
      bytesRead: detached.bytesRead,
      rowsScanned: detached.filesRead,
      invalidRows: detached.invalidFiles,
      unreadableFiles: detached.stopReasons.includes('io-error') ? 1 : 0,
    };
    status.detachedPostMergeDenominatorSource = {
      sourceState: denominator.sourceState,
      sourcePresent: denominator.sourcePresent,
      complete: denominator.complete,
      stopReasons: denominator.stopReasons,
      filesRead: denominator.filesRead,
      bytesRead: denominator.bytesRead,
      rowsScanned: denominator.receipt ? 1 : 0,
      invalidRows: denominator.invalidFiles,
      unreadableFiles: denominator.stopReasons.some((reason) =>
        ['io-error', 'unsafe-file', 'unsafe-path'].includes(reason)) ? 1 : 0,
    };
    const state: FleetDetachedPostMergeVerificationReadiness['state'] =
      denominator.sourceState === 'missing'
        ? 'missing'
        : denominator.sourceState === 'degraded' || !denominator.complete ||
            detached.sourceState === 'degraded' || !detached.complete
          ? 'degraded'
          : denominatorProjection.eligibleCandidates === 0
            ? 'conclusive'
            : denominatorProjection.observedCandidates === 0
            ? 'awaiting-observations'
            : denominatorProjection.observedCandidates !== denominatorProjection.eligibleCandidates ||
                denominatorProjection.conclusiveCandidates !== denominatorProjection.eligibleCandidates
              ? 'incomplete'
              : 'conclusive';
    status.detachedPostMergeVerificationReadiness = {
      version: 1,
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      state,
      latestObservedAt: denominatorProjection.latestObservedAt,
      passRate: denominatorProjection.passRate,
      denominator: {
        candidateSetDigest: denominator.receipt?.candidateSetDigest ?? null,
        eligibleCandidates: denominatorProjection.eligibleCandidates,
        observedCandidates: denominatorProjection.observedCandidates,
        conclusiveCandidates: denominatorProjection.conclusiveCandidates,
        unobservedCandidates: denominatorProjection.unobservedCandidates,
        pass: denominatorProjection.pass,
        fail: denominatorProjection.fail,
        unknown: denominatorProjection.unknown,
        queuedCandidates: denominatorProjection.queuedCandidates,
      },
      summary: detached.summary,
    };
  } catch {
    status.detachedPostMergeVerificationSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
    status.detachedPostMergeDenominatorSource = {
      sourceState: 'degraded', sourcePresent: true, complete: false,
      stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, rowsScanned: 0,
      invalidRows: 0, unreadableFiles: 1,
    };
    status.detachedPostMergeVerificationReadiness = {
      version: 1,
      authority: 'observation-only',
      policyEligible: false,
      mergePermitted: false,
      rollbackPermitted: false,
      deployPermitted: false,
      state: 'degraded',
      latestObservedAt: null,
      passRate: null,
      denominator: {
        candidateSetDigest: null,
        eligibleCandidates: 0,
        observedCandidates: 0,
        conclusiveCandidates: 0,
        unobservedCandidates: 0,
        pass: 0,
        fail: 0,
        unknown: 0,
        queuedCandidates: 0,
      },
      summary: {
        cohorts: 0,
        denominatorCompleteCohorts: 0,
        conclusiveCompleteCohorts: 0,
        expectedMembers: 0,
        observedMembers: 0,
        pass: 0,
        fail: 0,
        unknown: 0,
      },
    };
  }
  let workedLearningRead: WorkedLedgerReadResult;
  try {
    workedLearningRead = loadWorkedLedgerDetailed();
  } catch {
    workedLearningRead = {
      ledger: { events: [] },
      sourceQuality: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        reasons: ['unstable-read'], bytesRead: 0,
      },
    };
  }
  let workspaceRead: AgentWorkspaceReadResult | undefined;
  try {
    workspaceRead = readAgentWorkspaceDetailed({
      windowMs: RECENT_WINDOW_MS,
      limit: 5000,
      limitPerDimension: 8,
      recentLimit: 8,
    });
    status.workspace = workspaceRead.workspace;
  } catch {
    // Optional history/analytics surface only.
  }
  const learningCutoffMs = Date.parse(generatedAt) - LEARNING_SNAPSHOT_SETTLE_MS;
  let learningProposals = settledLearningRows(
    allProposals,
    learningCutoffMs,
    (proposal) => learningSnapshotTimestamp(proposal.createdAt, proposal.decidedAt),
  );
  let learningDispatchEvents = settledLearningRows(
    dispatchLearningEvents ?? [],
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningActions = settledLearningRows(
    workspaceRead?.events ?? [],
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningDecisions = settledLearningRows(
    learningDecisionsRead?.decisions ?? [],
    learningCutoffMs,
    (decision) => decision.ts,
  );
  let learningJudgeTraces = settledLearningRows(
    learningJudgeTracesRead?.traces ?? [],
    learningCutoffMs,
    (trace) => learningSnapshotTimestamp(trace.ts, trace.outcomeAt),
  );
  let learningEvidencePacks = settledLearningRows(
    learningEvidenceRead?.packs ?? [],
    learningCutoffMs,
    (pack) => pack.generatedAt,
  );
  let learningWorkedEvents = settledLearningRows(
    workedLearningRead.ledger.events,
    learningCutoffMs,
    (event) => event.ts,
  );
  let learningPostMergeObservations = settledLearningRows(
    learningPostMergeRead?.observations ?? [],
    learningCutoffMs,
    (observation) => observation.observedAt,
  );
  if (status.learningMetrics) {
    const rawLearningRows =
      allProposals.length +
      (dispatchLearningEvents?.length ?? 0) +
      (workspaceRead?.events.length ?? 0) +
      (learningDecisionsRead?.decisions.length ?? 0) +
      (learningJudgeTracesRead?.traces.length ?? 0) +
      (learningEvidenceRead?.packs.length ?? 0) +
      workedLearningRead.ledger.events.length +
      (learningPostMergeRead?.observations.length ?? 0);
    const settledLearningRowCount =
      learningProposals.length +
      learningDispatchEvents.length +
      learningActions.length +
      learningDecisions.length +
      learningJudgeTraces.length +
      learningEvidencePacks.length +
      learningWorkedEvents.length +
      learningPostMergeObservations.length;
    status.learningMetrics = {
      ...status.learningMetrics,
      settledThrough: new Date(learningCutoffMs).toISOString(),
      excludedRows: Math.max(0, rawLearningRows - settledLearningRowCount),
    };
    if ((dispatchLearningEvents?.length ?? 0) > 0 && learningDispatchEvents.length === 0) {
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-settling',
      };
    }
  }
  if (status.learningMetrics?.state === 'available') {
    try {
      const { listProposalsDetailed } = await import('../inbox/store.js');
      const proposalReadAfter = listProposalsDetailed();
      const dispatchReadAfter = readDispatchProductionYieldDetailed({
        windowMs: RECENT_WINDOW_MS,
        limit: 1200,
        limitPerDimension: 8,
      });
      const actionReadAfter = readAgentWorkspaceDetailed({
        windowMs: RECENT_WINDOW_MS,
        limit: 5000,
        limitPerDimension: 8,
        recentLimit: 8,
      });
      const decisionReadAfter = readDecisionsDetailed();
      const judgeTraceReadAfter = readJudgeTracesDetailed();
      const evidenceReadAfter = (await import('../autonomy/evidence-pack.js'))
        .readAutonomyEvidencePacksDetailed(Number.MAX_SAFE_INTEGER);
      const workedReadAfter = loadWorkedLedgerDetailed();
      const postMergeReadAfter = readPostMergeObservations({ requireComplete: true });

      const proposalRowsAfter = settledLearningRows(
        proposalReadAfter.proposals,
        learningCutoffMs,
        (proposal) => learningSnapshotTimestamp(proposal.createdAt, proposal.decidedAt),
      );
      const dispatchRowsAfter = settledLearningRows(
        dispatchReadAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const actionRowsAfter = settledLearningRows(
        actionReadAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const decisionRowsAfter = settledLearningRows(
        decisionReadAfter.decisions,
        learningCutoffMs,
        (decision) => decision.ts,
      );
      const judgeTraceRowsAfter = settledLearningRows(
        judgeTraceReadAfter.traces,
        learningCutoffMs,
        (trace) => learningSnapshotTimestamp(trace.ts, trace.outcomeAt),
      );
      const evidenceRowsAfter = settledLearningRows(
        evidenceReadAfter.packs,
        learningCutoffMs,
        (pack) => pack.generatedAt,
      );
      const workedRowsAfter = settledLearningRows(
        workedReadAfter.ledger.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const postMergeRowsAfter = settledLearningRows(
        postMergeReadAfter.observations,
        learningCutoffMs,
        (observation) => observation.observedAt,
      );

      const dispatchSnapshotStable = initialDispatchRead !== undefined &&
        learningSnapshotDigest(
          learningSnapshotSourceQuality(initialDispatchRead.sourceQuality),
          initialDispatchRead.events,
        ) === learningSnapshotDigest(
          learningSnapshotSourceQuality(dispatchReadAfter.sourceQuality),
          dispatchReadAfter.events,
        );

      const stable = [
        learningSnapshotDigest(learningSnapshotSourceQuality(proposalSourceQuality), learningProposals) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(proposalReadAfter), proposalRowsAfter),
        dispatchSnapshotStable,
        learningSnapshotDigest(learningSnapshotSourceQuality(workspaceRead?.sourceQuality), learningActions) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(actionReadAfter.sourceQuality), actionRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningDecisionsRead), learningDecisions) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(decisionReadAfter), decisionRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningJudgeTracesRead), learningJudgeTraces) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(judgeTraceReadAfter), judgeTraceRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningEvidenceRead), learningEvidencePacks) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(evidenceReadAfter), evidenceRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(workedLearningRead.sourceQuality), learningWorkedEvents) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(workedReadAfter.sourceQuality), workedRowsAfter),
        learningSnapshotDigest(learningSnapshotSourceQuality(learningPostMergeRead), learningPostMergeObservations) ===
          learningSnapshotDigest(learningSnapshotSourceQuality(postMergeReadAfter), postMergeRowsAfter),
      ].every(Boolean);

      if (stable) {
        status.dispatchProductionSource = dispatchReadAfter.sourceQuality;
        const dispatchAvailabilitySource = learningSourceAvailability(
          'dispatch-production',
          dispatchReadAfter.sourceQuality,
        );
        status.learningMetrics = {
          ...status.learningMetrics,
          sourceQuality: dispatchReadAfter.sourceQuality,
          dispatchProduction: learningMetricAvailability(
            [dispatchAvailabilitySource],
            [],
            1,
          ),
        };
        if (dispatchReadAfter.summary) {
          status.dispatchProduction = dispatchReadAfter.summary;
          status.dispatchYieldDiagnostics = buildDispatchYieldDiagnostics(
            dispatchReadAfter.summary,
            cfg,
            backends,
          );
        } else {
          delete status.dispatchProduction;
          delete status.dispatchYieldDiagnostics;
        }
        status.proposalFunnel = buildProposalFunnelObservability({
          events: dispatchReadAfter.events,
          sourceQuality: dispatchReadAfter.sourceQuality,
          windowMs: RECENT_WINDOW_MS,
          eventLimit: 1200,
        });
        learningProposals = proposalRowsAfter;
        learningDispatchEvents = dispatchRowsAfter;
        learningActions = actionRowsAfter;
        learningDecisions = decisionRowsAfter;
        learningJudgeTraces = judgeTraceRowsAfter;
        learningEvidencePacks = evidenceRowsAfter;
        learningWorkedEvents = workedRowsAfter;
        learningPostMergeObservations = postMergeRowsAfter;
      } else {
        if (!dispatchSnapshotStable) {
          const invalidatingSource = invalidatedDispatchProductionSource(
            dispatchReadAfter.sourceQuality,
          );
          status.dispatchProductionSource = invalidatingSource;
          delete status.dispatchProduction;
          delete status.dispatchYieldDiagnostics;
          const dispatchAvailabilitySource = learningSourceAvailability(
            'dispatch-production',
            invalidatingSource,
          );
          status.learningMetrics = {
            ...status.learningMetrics,
            sourceQuality: invalidatingSource,
            dispatchProduction: learningMetricAvailability(
              [dispatchAvailabilitySource],
              ['dispatchProduction'],
              1,
            ),
          };
        }
        if (status.proposalFunnel) {
          status.proposalFunnel = withholdProposalFunnelForUnstableSnapshot(
            status.proposalFunnel,
            !dispatchSnapshotStable ? status.dispatchProductionSource : undefined,
          );
        }
        status.learningMetrics = {
          ...status.learningMetrics,
          state: 'withheld',
          reason: 'learning-snapshot-unstable',
        };
      }
    } catch {
      const invalidatingSource = invalidatedDispatchProductionSource(
        status.dispatchProductionSource,
        'io-error',
      );
      status.dispatchProductionSource = invalidatingSource;
      delete status.dispatchProduction;
      delete status.dispatchYieldDiagnostics;
      if (status.proposalFunnel) {
        status.proposalFunnel = withholdProposalFunnelForUnstableSnapshot(
          status.proposalFunnel,
          invalidatingSource,
        );
      }
      const dispatchAvailabilitySource = learningSourceAvailability(
        'dispatch-production',
        invalidatingSource,
      );
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-unstable',
        sourceQuality: invalidatingSource,
        dispatchProduction: learningMetricAvailability(
          [dispatchAvailabilitySource],
          ['dispatchProduction'],
          1,
        ),
      };
    }
  }
  const workspaceSource = status.workspace?.sourceQuality;
  if (workspaceSource) {
    Object.defineProperty(learningActions, 'sourceQuality', {
      value: workspaceSource,
      enumerable: false,
    });
  }
  const dispatchSource = learningSourceAvailability('dispatch-production', status.dispatchProductionSource);
  const actionSource = learningSourceAvailability('agent-actions', workspaceSource);
  const outcomeSource = learningSourceAvailability('outcomes', proposalSourceQuality);
  const decisionSource = learningSourceAvailability('decisions', status.decisionsSource);
  const evidenceSource = learningSourceAvailability('evidence', learningEvidenceRead);
  const workedSource = learningSourceAvailability('worked', workedLearningRead.sourceQuality);
  const postMergeSource = learningSourceAvailability('post-merge', learningPostMergeRead);
  const proposalById = new Map(learningProposals.map((proposal) => [proposal.id, proposal]));
  const evidencePacks = learningEvidencePacks;
  const evidenceByProposal = new Map(evidencePacks.map((pack) => [pack.proposal.id, pack]));
  const unavailablePostMerge: PostMergeObservationReadResult = {
    observations: [], sourceState: 'degraded', sourcePresent: true, complete: false,
    stopReasons: ['io-error'], filesRead: 0, bytesRead: 0, physicalRows: 0,
    invalidRows: 0, conflictingEvents: 0, duplicateRows: 0, supersededRows: 0,
    limitExceeded: false,
  };
  let outcomeRecords: OutcomeRecord[] = [];
  if (status.learningMetrics?.state === 'available') {
    try {
      outcomeRecords = listOutcomeRecords({
        limit: 1000,
        deps: {
          listProposals: () => learningProposals,
          readDecisions: () => learningDecisions,
          readJudgeTraces: () => learningJudgeTraces,
          listAutonomyEvidencePacks: () => evidencePacks,
          loadWorkedLedger: () => ({ events: learningWorkedEvents }),
          readPostMergeObservations: () => learningPostMergeRead
            ? { ...learningPostMergeRead, observations: learningPostMergeObservations }
            : unavailablePostMerge,
        },
      });
      const attemptRecords = listAttemptRecords({
        windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
        limit: 500,
        deps: {
          readDispatchProductionEvents: () => learningDispatchEvents,
          readAgentActions: () => learningActions,
          listOutcomeRecords: () => outcomeRecords,
          loadProposal: (id) => proposalById.get(id) ?? null,
          readDecisions: () => learningDecisions,
          listAutonomyEvidencePacks: () => evidencePacks,
          readAutonomyEvidencePack: (id) => evidenceByProposal.get(id) ?? null,
          loadWorkedLedger: () => ({ events: learningWorkedEvents }),
        },
        useDefaultReaders: false,
      });
      const unavailable = new Set<keyof AttemptRecordCoverage>();
      if (!learningSourceAvailable(actionSource)) unavailable.add('agentAction');
      if (!learningSourceAvailable(outcomeSource)) unavailable.add('outcomeRecord');
      if (!learningSourceAvailable(decisionSource)) unavailable.add('decision');
      if (!learningSourceAvailable(evidenceSource)) unavailable.add('evidence');
      if (!learningSourceAvailable(workedSource)) unavailable.add('worked');
      status.attemptCoverage = withholdAttemptJoinMetrics(
        summarizeAttemptCoverage(attemptRecords, RECENT_WINDOW_MS / (60 * 60 * 1000)),
        unavailable,
      );
      if (workspaceSource) status.attemptCoverage.agentActionSource = workspaceSource;
      status.learningMetrics.attemptCoverage = learningMetricAvailability(
        [dispatchSource, actionSource, outcomeSource, decisionSource, evidenceSource, workedSource],
        [...unavailable].map((metric) => `coverage.${metric}`),
        6,
      );
    } catch {
      status.learningMetrics.attemptCoverage = learningMetricAvailability(
        [dispatchSource, { source: 'outcomes', sourceState: 'degraded', complete: false }],
        ['coverage.agentAction', 'coverage.outcomeRecord', 'coverage.decision', 'coverage.evidence', 'coverage.worked'],
        5,
      );
    }
  }
  const windowHours = RECENT_WINDOW_MS / (60 * 60 * 1000);
  const skillUseSource = readSkillUseEventsWithDiagnostics({
    sinceMs: Date.parse(generatedAt) - RECENT_WINDOW_MS,
    limit: Math.max(500 * 8, 400),
    maxFiles: 3,
  });
  let learningSkillUseEvents = settledLearningRows(
    skillUseSource.events,
    learningCutoffMs,
    (event) => event.ts,
  );
  if (status.learningMetrics) {
    status.learningMetrics.excludedRows =
      (status.learningMetrics.excludedRows ?? 0) +
      Math.max(0, skillUseSource.events.length - learningSkillUseEvents.length);
  }
  if (status.learningMetrics?.state === 'available') {
    try {
      const skillUseSourceAfter = readSkillUseEventsWithDiagnostics({
        sinceMs: Date.parse(generatedAt) - RECENT_WINDOW_MS,
        limit: Math.max(500 * 8, 400),
        maxFiles: 3,
      });
      const skillRowsAfter = settledLearningRows(
        skillUseSourceAfter.events,
        learningCutoffMs,
        (event) => event.ts,
      );
      const skillQuality = {
        sourceState: skillUseSource.sourceState,
        sourcePresent: skillUseSource.sourcePresent,
        eventState: skillUseSource.eventState,
      };
      const skillQualityAfter = {
        sourceState: skillUseSourceAfter.sourceState,
        sourcePresent: skillUseSourceAfter.sourcePresent,
        eventState: skillUseSourceAfter.eventState,
      };
      if (learningSnapshotDigest(skillQuality, learningSkillUseEvents) ===
          learningSnapshotDigest(skillQualityAfter, skillRowsAfter)) {
        learningSkillUseEvents = skillRowsAfter;
      } else {
        status.learningMetrics = {
          ...status.learningMetrics,
          state: 'withheld',
          reason: 'learning-snapshot-unstable',
        };
        status.attemptCoverage = undefined;
      }
    } catch {
      status.learningMetrics = {
        ...status.learningMetrics,
        state: 'withheld',
        reason: 'learning-snapshot-unstable',
      };
      status.attemptCoverage = undefined;
    }
  }
  const skillSource = learningSourceAvailability('skill-use', {
    sourceState: skillUseSource.sourceState,
    complete: skillUseSource.sourceState === 'healthy',
  });
  if (status.learningMetrics?.state === 'available') {
    try {
      const trajectoryRecords = listTrajectoryRecords({
        windowHours,
        limit: 500,
        deps: {
          readDispatchProductionEvents: () => learningDispatchEvents,
          readAgentActions: () => learningActions,
          readSkillUseEvents: () => learningSkillUseEvents,
          listOutcomeRecords: () => outcomeRecords,
          loadProposal: (id) => proposalById.get(id) ?? null,
        },
      });
      const unavailable = new Set<keyof TrajectoryRecordCoverage>();
      if (!learningSourceAvailable(outcomeSource)) unavailable.add('proposal');
      if (!learningSourceAvailable(evidenceSource)) unavailable.add('evidence');
      if (!learningSourceAvailable(decisionSource)) unavailable.add('decision');
      if (!learningSourceAvailable(actionSource)) unavailable.add('agentAction');
      if (!learningSourceAvailable(skillSource)) unavailable.add('skillUse');
      const terminalAvailable = learningSourceAvailable(outcomeSource) &&
        learningSourceAvailable(decisionSource);
      const realizedAvailable = terminalAvailable && learningSourceAvailable(postMergeSource);
      const tracesAvailable = terminalAvailable && learningSourceAvailable(evidenceSource) &&
        learningSourceAvailable(actionSource) && learningSourceAvailable(workedSource) &&
        learningSourceAvailable(postMergeSource);
      status.trajectoryLearning = withholdTrajectoryMetrics(
        summarizeTrajectoryLearning(trajectoryRecords, windowHours),
        unavailable,
        { terminal: terminalAvailable, realized: realizedAvailable, traces: tracesAvailable },
      );
      const withheldMetrics = [
        ...[...unavailable].map((metric) => `coverage.${metric}`),
        ...(!terminalAvailable ? ['terminalOutcomes', 'routeSpine.dispatchToMerge'] : []),
        ...(!realizedAvailable ? ['realizedOutcomes'] : []),
        ...(!learningSourceAvailable(decisionSource) ? ['routeSpine.dispatchToDecision'] : []),
        ...(!learningSourceAvailable(evidenceSource) ? ['routeSpine.dispatchToEvidence'] : []),
        ...(!tracesAvailable ? ['traces'] : []),
      ];
      status.learningMetrics.trajectoryLearning = learningMetricAvailability(
        [
          dispatchSource, actionSource, outcomeSource, decisionSource, evidenceSource,
          workedSource, postMergeSource, skillSource,
        ],
        withheldMetrics,
        12,
      );
    } catch {
      status.learningMetrics.trajectoryLearning = learningMetricAvailability(
        [dispatchSource, { source: 'outcomes', sourceState: 'degraded', complete: false }],
        [
          'terminalOutcomes', 'realizedOutcomes', 'coverage.proposal', 'coverage.evidence',
          'coverage.decision', 'coverage.agentAction', 'coverage.skillUse', 'routeSpine', 'traces', 'recent',
        ],
        10,
      );
    }
  }
  if (status.trajectoryLearning && !learningSourceAvailable(skillSource)) {
    status.trajectoryLearning = suppressDegradedSkillObservation(
      status.trajectoryLearning,
      skillUseSource.events.length > 0 ? 'present' : 'none',
    );
  }
  if (status.learningMetrics?.state === 'withheld') {
    status.learningMetrics.attemptCoverage = learningMetricAvailability(
      [dispatchSource],
      ['production', 'coverage.agentAction', 'coverage.outcomeRecord', 'coverage.decision', 'coverage.evidence', 'coverage.worked'],
      6,
    );
    status.learningMetrics.trajectoryLearning = learningMetricAvailability(
      [dispatchSource],
      [
        'trajectories', 'terminalOutcomes', 'realizedOutcomes', 'coverage.dispatch',
        'coverage.proposal', 'coverage.evidence', 'coverage.decision', 'coverage.agentAction',
        'coverage.skillUse', 'routeSpine', 'traces', 'recent',
      ],
      12,
    );
  }
  status.skillCorpusReadiness = await readSkillCorpusReadiness(
    status.trajectoryLearning?.skillObservation,
    skillUseSource.eventState,
  );
  const contextInput = status.workspace?.sourceQuality &&
    (status.workspace.sourceQuality.sourceState !== 'healthy' || !status.workspace.sourceQuality.complete)
    ? { ...status, workspace: undefined }
    : status;
  try {
    const { genomeHubHealth } = await import('../genome/store.js');
    status.contextEfficiency = buildContextEfficiencyStatus(contextInput, genomeHubHealth(), generatedAt, RECENT_WINDOW_MS);
  } catch {
    status.contextEfficiency = buildContextEfficiencyStatus(contextInput, undefined, generatedAt, RECENT_WINDOW_MS);
  }

  try {
    const { buildResourceStrategyReport } = await import('../autonomy/resource-strategy.js');
    const report = await buildResourceStrategyReport(cfg, {
      maxOutcomes: 3,
      maxChecks: 3,
      deps: {
        buildFleetStatus: async () => status,
        runEcosystemDoctor: async (opts) => lightweightEcosystemReport(opts?.now, opts?.root),
        ...(guardHealth !== undefined ? { diagnoseGuardHealth: () => guardHealth } : {}),
      },
    });
    status.autonomyDirection = buildAutonomyDirectionSummary(report);
  } catch {
    // Optional advisory surface only. Fleet status remains available if any
    // strategy signal source is unavailable.
  }

  status.autonomyEffectiveness = buildAutonomyEffectiveness(status);
  status.nextActions = buildNextActions(status);
  status.autonomousShipReadiness = buildAutonomousShipReadiness(status, {
    generatedAt,
    queueSnapshotAt: queueAuthorityObservedAt,
    queueSourceStatus,
    queueSourceDetail,
  });
  status.missionBrief = buildMissionBrief(status);

  // Construct this forensic projection only after every operational and
  // authority-bearing status has been derived.
  status.cutoffCheckpoints = readFleetCutoffCheckpointStatus(generatedAt);
  try {
    const { automergeCanaryStatus } = await import('./automerge-canary-store.js');
    const canaryRead = automergeCanaryStatus();
    status.autoMergeCanary = projectAutoMergeCanaryStatus(canaryRead);
    status.autoMergeCanaryPromotionReadiness = buildAutoMergeCanaryPromotionReadiness(
      status,
      cfg,
      canaryRead,
      Date.parse(generatedAt),
    );
  } catch {
    status.autoMergeCanary = degradedAutoMergeCanaryStatus();
    status.autoMergeCanaryPromotionReadiness = evaluateAutoMergeCanaryPromotionReadiness({
      observedAtMs: Date.parse(generatedAt),
      canary: {
        sourceState: 'degraded', active: false, state: 'critical',
        observationCompletedAt: null, attempts: 0, eligible: 0, rejected: 0,
        requiredAttempts: 1, requiredEligible: 1, requirementsBound: false,
        bindingMismatches: 0, inspectionErrors: 1,
      },
      remoteProtection: {
        configured: 'missing', live: 'unavailable', coverage: 'none', observedAt: null,
      },
      verification: {
        sourceState: 'degraded', enrolledRepos: 0, mergeGradeRepos: 0, noCommandRepos: 0,
      },
      evidenceSigning: {
        sourceState: 'missing', signed: false, writable: false, expiresAt: null,
      },
      release: {
        sourceState: 'missing', signatureVerified: false, manifestComplete: false,
        artifactBound: false, serviceInvocationBound: false, configurationBound: false,
        expiresAt: null, rollbackBound: false,
      },
      postMerge: {
        sourceState: 'degraded', complete: false, denominatorComplete: false,
        releasedCohorts: 0, adverseObservations: 0, latestCompletedAt: null,
      },
      policy: {
        allowSelfMerge: true, allowWithoutVerification: true, localMergeFallback: true,
        maxAutomergeFiles: null, maxAutomergeLines: null,
      },
      scopeIdentity: {
        sourceState: 'degraded',
        expectedPolicyDigest: null, expectedConfigDigest: null,
        evidencePolicyDigest: null, evidenceConfigDigest: null,
        currentPolicyDigest: null, currentConfigDigest: null,
        currentScopePolicyDigest: null, observedAt: null,
      },
    });
  }

  return status;
}

async function buildDispatchManifestStatus(): Promise<{
  summary?: FleetDispatchManifestStatus;
  sourceQuality: DispatchManifestSourceQuality;
}> {
  const { readDispatchManifestEventsDetailed } = await import('./dispatch-manifest.js');
  const read = readDispatchManifestEventsDetailed({ limit: 1000 });
  const events = read.events;
  const sourceQuality: DispatchManifestSourceQuality = {
    sourceState: read.sourceState,
    sourcePresent: read.sourcePresent,
    complete: read.complete,
    stopReasons: read.stopReasons,
    filesRead: read.filesRead,
    bytesRead: read.bytesRead,
    rowsScanned: read.rowsScanned,
    invalidRows: read.invalidRows,
    unreadableFiles: read.unreadableFiles,
  };
  if (events.length === 0 || sourceQuality.sourceState !== 'healthy' || !sourceQuality.complete) {
    return { sourceQuality };
  }

  const byBackend = new Map<string, number>();
  let assigned = 0;
  let unassigned = 0;
  let latestAt: string | null = null;
  for (const event of events) {
    assigned += event.counts.assigned;
    unassigned += event.counts.unassigned;
    if (!latestAt || Date.parse(event.ts) > Date.parse(latestAt)) latestAt = event.ts;
    for (const [backend, count] of Object.entries(event.backendCounts)) {
      byBackend.set(backend, (byBackend.get(backend) ?? 0) + count);
    }
  }

  return { sourceQuality, summary: {
    events: events.length,
    latestAt,
    assigned,
    unassigned,
    byBackend: [...byBackend.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([backend, assignments]) => ({ backend, assignments })),
    recent: events.slice(0, 8).map((event) => ({
      manifestId: event.manifestId,
      ts: event.ts,
      assigned: event.counts.assigned,
      unassigned: event.counts.unassigned,
      backends: event.backendCounts,
      ...(event.resourceSnapshotAt ? { resourceSnapshotAt: event.resourceSnapshotAt } : {}),
    })),
  } };
}

async function buildFleetPhantomStatus(cfg: AshlrConfig): Promise<FleetPhantomStatus | undefined> {
  const observedAt = new Date().toISOString();
  try {
    const { getCachedFleetPhantomStatus } = await import('../phantom.js');
    const includeAgentReport = cfg.phantom?.agentReportRollup?.enabled === true;
    const status = getCachedFleetPhantomStatus({
      includeAgentReport,
      ...(cfg.phantom?.agentReportRollup?.timeoutMs ? { timeoutMs: cfg.phantom.agentReportRollup.timeoutMs } : {}),
      ...(cfg.phantom?.agentReportRollup?.cacheTtlMs ? { ttlMs: cfg.phantom.agentReportRollup.cacheTtlMs } : {}),
    });
    const known = status.capability.knownFleetSecrets;
    const state: FleetPhantomState = status.error
      ? 'degraded'
      : !status.installed
        ? 'not-installed'
        : !status.initialized
          ? 'not-initialized'
          : 'ready';
    const agentReport = status.capability.commands.agentAvailable && status.agentReport
      ? sanitizeFleetPhantomAgentReport(status.agentReport)
      : undefined;
    return {
      observedAt,
      state,
      installed: status.installed,
      initialized: status.initialized,
      version: status.version,
      valueMode: status.capability.valueMode,
      secretCount: status.capability.secretCount,
      knownFleetSecrets: {
        total: known.names.length,
        presentCount: known.present.length,
        missingCount: known.missing.length,
        pulseCredentialPresent: known.pulseCredentialPresent,
        nimApiKeyPresent: known.present.includes('NVIDIA_NIM_API_KEY'),
      },
      capabilities: status.capability.modes,
      commands: status.capability.commands,
      config: {
        phantomExecEnabled: cfg.phantom?.enabled === true,
        fleetSecretInjectionEnabled: cfg.foundry?.usePhantom === true,
      },
      mcp: {
        configured: await phantomMcpConfigured(),
      },
      ...(agentReport ? { agentReport } : {}),
      ...(status.error ? { error: sanitizeFleetPhantomError(status.error) } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      observedAt,
      state: 'degraded',
      installed: false,
      initialized: false,
      version: null,
      valueMode: 'metadata-and-names-only',
      secretCount: 0,
      knownFleetSecrets: {
        total: 0,
        presentCount: 0,
        missingCount: 0,
        pulseCredentialPresent: false,
        nimApiKeyPresent: false,
      },
      capabilities: {
        metadataStatus: false,
        childEnvInjectionAvailable: false,
        mcpServerAvailable: false,
        mutationRequiresHumanApproval: false,
      },
      commands: {
        commandsKnown: false,
        setupAvailable: false,
        execAvailable: false,
        mcpAvailable: false,
        agentAvailable: false,
      },
      config: {
        phantomExecEnabled: cfg.phantom?.enabled === true,
        fleetSecretInjectionEnabled: cfg.foundry?.usePhantom === true,
      },
      mcp: { configured: false },
      error: sanitizeFleetPhantomError(message),
    };
  }
}

const PHANTOM_AGENT_STATUS_COUNT_KEYS = new Set([
  'ok',
  'warning',
  'review',
  'requires-approval',
  'failed',
  'blocked',
  'skipped',
  'unknown',
  'other',
]);
const PHANTOM_AGENT_RISK_COUNT_KEYS = new Set(['none', 'low', 'medium', 'high', 'critical', 'unknown', 'other']);
const PHANTOM_AGENT_SEVERITY_COUNT_KEYS = new Set(['info', 'low', 'medium', 'high', 'critical', 'unknown', 'other']);
const PHANTOM_AGENT_DELEGATION_STATUS_COUNT_KEYS = new Set([
  'ok',
  'warning',
  'review',
  'requires-approval',
  'failed',
  'blocked',
  'skipped',
  'unknown',
  'other',
]);
const PHANTOM_AGENT_DELEGATION_ACTION_COUNT_KEYS = new Set([
  'delegate',
  'review',
  'approve',
  'block',
  'initialize',
  'configure',
  'none',
  'unknown',
  'other',
]);

function sanitizeFleetPhantomAgentReport(report: PhantomAgentReportRollup): PhantomAgentReportRollup {
  const delegationSafety = sanitizeFleetPhantomDelegationSafety(report.delegationSafety);
  return {
    valuesHidden: true,
    scannedRepos: safeFleetPhantomCount(report.scannedRepos),
    validReports: safeFleetPhantomCount(report.validReports),
    failedReports: safeFleetPhantomCount(report.failedReports),
    statusCounts: safeFleetPhantomCountMap(report.statusCounts, PHANTOM_AGENT_STATUS_COUNT_KEYS),
    riskCounts: safeFleetPhantomCountMap(report.riskCounts, PHANTOM_AGENT_RISK_COUNT_KEYS),
    severityCounts: safeFleetPhantomCountMap(report.severityCounts, PHANTOM_AGENT_SEVERITY_COUNT_KEYS),
    requiresApprovalCount: safeFleetPhantomCount(report.requiresApprovalCount),
    ...(delegationSafety ? { delegationSafety } : {}),
  };
}

function sanitizeFleetPhantomDelegationSafety(
  input: PhantomAgentReportRollup['delegationSafety'],
): PhantomAgentReportRollup['delegationSafety'] | undefined {
  if (!input) return undefined;
  const rawSafetyCounts = input.safetyCounts ?? { safe: 0, unsafe: 0, unknown: 0 };
  const safetyCounts = {
    safe: safeFleetPhantomCount(rawSafetyCounts.safe),
    unsafe: safeFleetPhantomCount(rawSafetyCounts.unsafe),
    unknown: safeFleetPhantomCount(rawSafetyCounts.unknown),
  };
  const statusCounts = safeFleetPhantomCountMap(
    input.statusCounts,
    PHANTOM_AGENT_DELEGATION_STATUS_COUNT_KEYS,
  );
  const primaryActionCounts = safeFleetPhantomCountMap(
    input.primaryActionCounts,
    PHANTOM_AGENT_DELEGATION_ACTION_COUNT_KEYS,
  );
  const hasSafety = safetyCounts.safe > 0 || safetyCounts.unsafe > 0 || safetyCounts.unknown > 0;
  if (!hasSafety && Object.keys(statusCounts).length === 0 && Object.keys(primaryActionCounts).length === 0) {
    return undefined;
  }
  return { safetyCounts, statusCounts, primaryActionCounts };
}

function safeFleetPhantomCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(Math.min(value, Number.MAX_SAFE_INTEGER));
}

function safeFleetPhantomCountMap(
  counts: Record<string, number> | undefined,
  allowedKeys: Set<string>,
): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts ?? {})) {
    if (!allowedKeys.has(key)) continue;
    const count = safeFleetPhantomCount(value);
    if (count > 0) safe[key] = count;
  }
  return safe;
}

async function phantomMcpConfigured(): Promise<boolean> {
  try {
    const { discoverMcpServers } = await import('../mcp-registry.js');
    const registry = discoverMcpServers();
    return registry.servers.some((candidate) =>
      candidate.name === 'phantom-secrets' ||
      (candidate.command === 'phantom' && candidate.args[0] === 'mcp')
    );
  } catch {
    return false;
  }
}

function sanitizeFleetPhantomError(error: string): string {
  const home = homedir();
  const clean = error
    .replaceAll(home, '~')
    .replace(/\/Users\/[^/\s]+/g, '~')
    .replace(/\/home\/[^/\s]+/g, '~')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 180 ? `${clean.slice(0, 177)}...` : clean;
}

function buildProposalProductionStatus(ticks: DaemonTick[]): FleetProposalProductionStatus | undefined {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const recent = ticks.filter((tick) => {
    if (!tick.proposalProduction) return false;
    const ts = Date.parse(tick.ts);
    return Number.isNaN(ts) || ts >= cutoff;
  });
  if (recent.length === 0) return undefined;

  const reasons = new Map<string, number>();
  const diagnosticReasons = new Map<string, number>();
  const skipReasons = new Map<string, number>();
  const recentNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  const recentDiagnosticNoProposalDispatches: FleetProposalProductionDispatchSummary[] = [];
  let selected = 0;
  let claimed = 0;
  let dispatched = 0;
  let skipped = 0;
  let errors = 0;
  let proposalsCreated = 0;
  let noProposalDispatches = 0;
  let suppressedDispatches = 0;

  const addReason = (reason: string, count = 1): void => {
    const key = reason.trim() || 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + count);
  };

  const addDiagnosticReason = (reason: string | undefined, count = 1): boolean => {
    const key = (reason ?? '').trim() || 'unknown';
    if (!isSuppressedProposalProductionReason(key) && !isSkippedProposalProductionReason(key)) {
      diagnosticReasons.set(key, (diagnosticReasons.get(key) ?? 0) + count);
      return true;
    }
    return false;
  };

  const addSkipReason = (reason: string | undefined, count = 1): void => {
    const key = (reason ?? '').trim() || 'unknown';
    skipReasons.set(key, (skipReasons.get(key) ?? 0) + count);
  };

  for (const tick of recent) {
    const production = tick.proposalProduction;
    if (!production) continue;
    selected += production.selected;
    claimed += production.claimed;
    dispatched += production.dispatched;
    skipped += production.skipped;
    errors += production.errors;
    proposalsCreated += production.proposalsCreated;
    noProposalDispatches += production.noProposalDispatches;
    let hasAggregateDiagnosticReason = false;
    let sawSkippedDispatchReason = false;
    for (const reason of production.reasons ?? []) {
      addReason(reason.reason, reason.count);
      if (isSkippedProposalProductionReason(reason.reason)) continue;
      hasAggregateDiagnosticReason = addDiagnosticReason(reason.reason, reason.count) || hasAggregateDiagnosticReason;
    }
    for (const dispatch of tick.dispatches ?? []) {
      if (dispatch.dispatched) continue;
      addSkipReason(dispatch.skipReason ?? dispatch.reason);
      sawSkippedDispatchReason = true;
    }
    if (!sawSkippedDispatchReason) {
      for (const reason of production.reasons ?? []) {
        if (isSkippedProposalProductionReason(reason.reason)) {
          addSkipReason(reason.reason, reason.count);
        }
      }
    }
    if (production.noProposalDispatches > 0 && recentNoProposalDispatches.length < 8) {
      const knownNoProposalDispatches = (tick.dispatches ?? []).filter((dispatch) =>
        dispatch.dispatched &&
        dispatch.production !== undefined &&
        dispatch.production.outcome !== 'proposal-created',
      );
      let suppressedByReason = 0;
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedByReason += reason.count;
        }
      }
      const suppressedByDispatch = knownNoProposalDispatches
        .filter(isSuppressedProposalProductionDispatch)
        .length;
      suppressedDispatches += Math.max(suppressedByReason, suppressedByDispatch);
      const sample = knownNoProposalDispatches.length > 0
        ? knownNoProposalDispatches
        : (tick.dispatches ?? []).filter((dispatch) => dispatch.dispatched).slice(0, production.noProposalDispatches);
      for (const dispatch of sample) {
        if (recentNoProposalDispatches.length >= 8) break;
        const summary = proposalProductionDispatchSummary(tick.ts, dispatch);
        recentNoProposalDispatches.push(summary);
        if (isSuppressedProposalProductionDispatch(dispatch)) {
          continue;
        }
        if (!hasAggregateDiagnosticReason) {
          addDiagnosticReason(proposalProductionDiagnosticReason(dispatch));
        }
        if (recentDiagnosticNoProposalDispatches.length < 8) {
          recentDiagnosticNoProposalDispatches.push(summary);
        }
      }
    } else {
      for (const reason of production.reasons ?? []) {
        if (isSuppressedProposalProductionReason(reason.reason)) {
          suppressedDispatches += reason.count;
        }
      }
    }
  }

  const diagnosticNoProposalDispatches = Math.max(0, noProposalDispatches - suppressedDispatches);
  return {
    windowHours: RECENT_WINDOW_MS / (60 * 60 * 1000),
    selected,
    claimed,
    dispatched,
    skipped,
    errors,
    proposalsCreated,
    noProposalDispatches,
    suppressedDispatches,
    diagnosticNoProposalDispatches,
    topReasons: [...reasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    diagnosticTopReasons: [...diagnosticReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    skipReasons: [...skipReasons.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([reason, count]) => ({ reason, count })),
    recentNoProposalDispatches,
    recentDiagnosticNoProposalDispatches,
  };
}

function isSuppressedProposalProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled');
}

function isSkippedProposalProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  return normalized === 'not-attempted' ||
    normalized.startsWith('not-attempted:') ||
    normalized.includes('selected item(s) were not attempted');
}

function isSuppressedProposalProductionDispatch(dispatch: DaemonDispatchTrace): boolean {
  return dispatch.production?.outcome === 'proposal-disabled' ||
    isSuppressedProposalProductionReason(dispatch.production?.reason) ||
    isSuppressedProposalProductionReason(dispatch.reason);
}

function proposalProductionDiagnosticReason(dispatch: DaemonDispatchTrace): string {
  const reason = (dispatch.production?.reason ?? dispatch.reason ?? 'unknown').trim() || 'unknown';
  const outcome = dispatch.production?.outcome;
  if (!outcome || outcome === 'unknown' || outcome === 'proposal-created') return reason;
  return reason.startsWith(`${outcome}:`) ? reason : `${outcome}: ${reason}`;
}

function proposalProductionDispatchSummary(
  ts: string,
  dispatch: DaemonDispatchTrace,
): FleetProposalProductionDispatchSummary {
  return {
    ts,
    itemId: dispatch.itemId,
    title: dispatch.title,
    repo: dispatch.repo,
    source: dispatch.source,
    backend: dispatch.backend,
    ...(dispatch.production?.outcome ? { productionOutcome: dispatch.production.outcome } : {}),
    reason: dispatch.production?.reason ?? dispatch.skipReason ?? dispatch.reason,
  };
}

function proposalProductionDiagnosis(production: FleetProposalProductionStatus): string {
  const diagnosticTopReason = production.diagnosticTopReasons[0];
  const topReason = diagnosticTopReason ??
    production.topReasons.find((reason) =>
      !isSuppressedProposalProductionReason(reason.reason) &&
      !isSkippedProposalProductionReason(reason.reason)
    );
  const diagnosticNoProposalDispatches = production.diagnosticNoProposalDispatches ?? production.noProposalDispatches;
  if (production.errors > 0) {
    return `recent production saw ${production.errors} error(s)${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (diagnosticNoProposalDispatches > 0) {
    return `${diagnosticNoProposalDispatches} recent dispatch(es) produced no proposal${diagnosticTopReason ? `; top reason: ${diagnosticTopReason.reason}` : ''}`;
  }
  if (production.skipped > 0) {
    const topSkip = production.skipReasons[0];
    return `${production.skipped} selected item(s) were not attempted${topSkip ? `; top skip: ${topSkip.reason}` : ''}`;
  }
  if (production.suppressedDispatches > 0) {
    return `${production.suppressedDispatches} recent dispatch(es) were suppressed by internal proposal filing policy`;
  }
  if (production.selected > 0 && production.dispatched === 0) {
    return `${production.selected} item(s) were selected but none dispatched${topReason ? `; top reason: ${topReason.reason}` : ''}`;
  }
  if (production.dispatched > 0 && production.proposalsCreated > 0) {
    return `${production.dispatched} dispatch(es) produced ${production.proposalsCreated} proposal(s)`;
  }
  return topReason ? `recent production top reason: ${topReason.reason}` : 'no recent proposal-production diagnosis is available';
}

const MIN_DISPATCH_YIELD_ACTION_ATTEMPTS = 3;
const LOW_DISPATCH_YIELD_ACTION_RATE = 0.2;

function configuredLowDispatchYieldRate(cfg: AshlrConfig): number {
  const raw = cfg.foundry?.intelligence?.minProposalYieldRate;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return LOW_DISPATCH_YIELD_ACTION_RATE;
  return Math.max(0, Math.min(1, raw));
}

function formatActionPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, rate)) * 100)}%`;
}

function diagnosticPolicyDisabled(
  value: Pick<DispatchProductionYieldSummary, 'outcomes' | 'attemptShape'>,
): number {
  const classified = value.attemptShape?.policyDisabled;
  if (classified !== undefined && Number.isFinite(classified)) {
    return Math.max(0, Math.floor(classified));
  }
  return Math.max(0, value.outcomes.proposalDisabled);
}

function diagnosticCancelled(
  value: Pick<DispatchProductionYieldSummary, 'outcomes'>,
): number {
  return value.outcomes.cancelled ?? 0;
}

function diagnosticAttemptsForDispatchBucket(bucket: DispatchProductionYieldBucket): number {
  if (bucket.diagnosticAttempts !== undefined && Number.isFinite(bucket.diagnosticAttempts)) {
    return Math.max(0, Math.floor(bucket.diagnosticAttempts));
  }
  return Math.max(0, bucket.attempts - diagnosticPolicyDisabled(bucket) - diagnosticCancelled(bucket));
}

function diagnosticAttemptsForDispatchSummary(summary: DispatchProductionYieldSummary): number {
  if (summary.diagnosticAttempts !== undefined && Number.isFinite(summary.diagnosticAttempts)) {
    return Math.max(0, Math.floor(summary.diagnosticAttempts));
  }
  return Math.max(0, summary.attempts - diagnosticPolicyDisabled(summary) - diagnosticCancelled(summary));
}

function diagnosticNoProposalForDispatchBucket(
  bucket: DispatchProductionYieldBucket,
  diagnosticAttempts: number,
): number {
  if (bucket.diagnosticNoProposal !== undefined && Number.isFinite(bucket.diagnosticNoProposal)) {
    return Math.max(0, Math.floor(bucket.diagnosticNoProposal));
  }
  return Math.max(0, diagnosticAttempts - bucket.proposalsCreated);
}

function diagnosticNoProposalForDispatchSummary(
  summary: DispatchProductionYieldSummary,
  diagnosticAttempts: number,
): number {
  if (summary.diagnosticNoProposal !== undefined && Number.isFinite(summary.diagnosticNoProposal)) {
    return Math.max(0, Math.floor(summary.diagnosticNoProposal));
  }
  return Math.max(0, diagnosticAttempts - summary.proposalsCreated);
}

function diagnosticTopReason(bucket: DispatchProductionYieldBucket): string | undefined {
  if (bucket.diagnosticTopReasons !== undefined) {
    return bucket.diagnosticTopReasons[0]?.reason;
  }
  return bucket.topReasons.find((reason) => !isSuppressedProposalProductionReason(reason.reason))?.reason;
}

function diagnosticTopReasonForDispatchSummary(summary: DispatchProductionYieldSummary): string | undefined {
  if (summary.diagnosticTopReasons !== undefined) {
    return summary.diagnosticTopReasons[0]?.reason;
  }
  return summary.topReasons.find((reason) => !isSuppressedProposalProductionReason(reason.reason))?.reason;
}

function dispatchYieldVerdict(
  diagnosticAttempts: number,
  proposalRate: number,
  policyDisabled: number,
  lowYieldRate: number,
): FleetDispatchYieldDiagnosticVerdict {
  if (diagnosticAttempts === 0 && policyDisabled > 0) return 'policy-suppressed';
  if (
    diagnosticAttempts < MIN_DISPATCH_YIELD_ACTION_ATTEMPTS ||
    !Number.isFinite(proposalRate)
  ) {
    return 'insufficient-sample';
  }
  return proposalRate < lowYieldRate ? 'actionable' : 'healthy';
}

function dispatchYieldActionFor(
  verdict: FleetDispatchYieldDiagnosticVerdict,
  shape: DispatchProductionYieldSummary['attemptShape'],
): FleetDispatchYieldDiagnosticAction {
  if (verdict === 'insufficient-sample') return 'collect-more-samples';
  if (verdict !== 'actionable') return 'keep-routing';
  const noDiff = shape?.backendNoDiff ?? 0;
  const gate = shape?.captureOrGateBlocked ?? 0;
  return noDiff > 0 && noDiff >= gate
    ? 'route-same-tier-alternative'
    : 'tighten-context-or-reslice';
}

function dispatchYieldHasTrustedCapacity(backend: FleetBackendStatus): boolean {
  const availability = backend.resource?.availability;
  return availability === 'open';
}

function dispatchYieldInstalledForStatus(backend: FleetBackendStatus, cfg: AshlrConfig): boolean {
  if (backend.backend === 'builtin') return false;
  if (backend.backend === 'local-coder' && dispatchYieldHasTrustedCapacity(backend)) {
    return true;
  }
  try {
    return engineInstalled(backend.backend, cfg);
  } catch {
    return false;
  }
}

function hasDispatchYieldSameTierAlternative(
  candidate: FleetDispatchYieldDiagnosticCandidate,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): boolean {
  if (!candidate.backend) return false;
  let currentTier: EngineTier;
  try {
    currentTier = engineTierOf(candidate.backend, cfg);
  } catch {
    return false;
  }
  for (const backend of backends) {
    if (backend.backend === candidate.backend) continue;
    if (backend.backend === 'builtin') continue;
    if (!dispatchYieldHasTrustedCapacity(backend)) continue;
    try {
      if (engineTierOf(backend.backend, cfg) !== currentTier) continue;
    } catch {
      continue;
    }
    if (!dispatchYieldInstalledForStatus(backend, cfg)) continue;
    return true;
  }
  return false;
}

function effectiveDispatchYieldCandidate(
  candidate: FleetDispatchYieldDiagnosticCandidate,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): FleetDispatchYieldDiagnosticCandidate {
  if (candidate.action !== 'route-same-tier-alternative') return candidate;
  if (hasDispatchYieldSameTierAlternative(candidate, cfg, backends)) return candidate;
  return {
    ...candidate,
    action: 'tighten-context-or-reslice',
    actionReason: 'no open installed same-tier alternative is available',
  };
}

function dispatchYieldCandidate(
  bucket: DispatchProductionYieldBucket,
  scope: FleetDispatchYieldDiagnosticCandidate['scope'],
  lowYieldRate: number,
): FleetDispatchYieldDiagnosticCandidate {
  const diagnosticAttempts = diagnosticAttemptsForDispatchBucket(bucket);
  const proposalsCreated = bucket.proposalsCreated;
  const proposalRate = diagnosticAttempts > 0 ? proposalsCreated / diagnosticAttempts : 0;
  const policyDisabled = diagnosticPolicyDisabled(bucket);
  const verdict = dispatchYieldVerdict(diagnosticAttempts, proposalRate, policyDisabled, lowYieldRate);
  return {
    scope,
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    diagnosticAttempts,
    proposalsCreated,
    noProposal: diagnosticNoProposalForDispatchBucket(bucket, diagnosticAttempts),
    proposalRate,
    policyDisabled,
    verdict,
    action: dispatchYieldActionFor(verdict, bucket.attemptShape),
    sameTierOnly: true,
    ...(diagnosticTopReason(bucket) ? { topReason: diagnosticTopReason(bucket) } : {}),
    ...(bucket.attemptShape ? { attemptShape: bucket.attemptShape } : {}),
    ...(bucket.generatedRepairAttempts ? { generatedRepairAttempts: bucket.generatedRepairAttempts } : {}),
  };
}

function dispatchYieldSubject(candidate: FleetDispatchYieldDiagnosticCandidate): string {
  if (candidate.backend && candidate.source) return `${candidate.backend}/${candidate.source}`;
  if (candidate.backend) return candidate.backend;
  return candidate.key === 'fleet' ? 'dispatches' : candidate.key;
}

function sortDispatchYieldCandidates(
  candidates: FleetDispatchYieldDiagnosticCandidate[],
): FleetDispatchYieldDiagnosticCandidate[] {
  const verdictRank: Record<FleetDispatchYieldDiagnosticVerdict, number> = {
    actionable: 0,
    'insufficient-sample': 1,
    healthy: 2,
    'policy-suppressed': 3,
  };
  return candidates
    .slice()
    .sort((a, b) =>
      verdictRank[a.verdict] - verdictRank[b.verdict] ||
      b.noProposal - a.noProposal ||
      a.proposalRate - b.proposalRate ||
      b.diagnosticAttempts - a.diagnosticAttempts ||
      a.key.localeCompare(b.key),
    );
}

function buildDispatchYieldDiagnostics(
  dispatchProduction: DispatchProductionYieldSummary,
  cfg: AshlrConfig,
  backends: FleetBackendStatus[],
): FleetDispatchYieldDiagnostics {
  const lowYieldRate = configuredLowDispatchYieldRate(cfg);
  const diagnosticAttempts = diagnosticAttemptsForDispatchSummary(dispatchProduction);
  const proposalsCreated = dispatchProduction.proposalsCreated;
  const proposalRate = diagnosticAttempts > 0 ? proposalsCreated / diagnosticAttempts : 0;
  const policyDisabled = diagnosticPolicyDisabled(dispatchProduction);
  const overallVerdict = dispatchYieldVerdict(diagnosticAttempts, proposalRate, policyDisabled, lowYieldRate);
  const byBackendSource = dispatchProduction.byBackendSource ?? [];
  const bucketSource = byBackendSource.length > 0
    ? byBackendSource.map((bucket) => dispatchYieldCandidate(bucket, 'backend-source', lowYieldRate))
    : dispatchProduction.byBackendModel.length > 0
      ? dispatchProduction.byBackendModel.map((bucket) => dispatchYieldCandidate(bucket, 'backend-model', lowYieldRate))
      : dispatchProduction.byBackend.map((bucket) => dispatchYieldCandidate(bucket, 'backend', lowYieldRate));
  const candidates = sortDispatchYieldCandidates(
    bucketSource.map((candidate) => effectiveDispatchYieldCandidate(candidate, cfg, backends)),
  ).slice(0, 5);
  const fleetTopReason = diagnosticTopReasonForDispatchSummary(dispatchProduction);
  const fleetCandidate = effectiveDispatchYieldCandidate({
    scope: 'fleet',
    key: 'fleet',
    diagnosticAttempts,
    proposalsCreated,
    noProposal: diagnosticNoProposalForDispatchSummary(dispatchProduction, diagnosticAttempts),
    proposalRate,
    policyDisabled,
    verdict: overallVerdict,
    action: dispatchYieldActionFor(overallVerdict, dispatchProduction.attemptShape),
    sameTierOnly: true,
    ...(fleetTopReason ? { topReason: fleetTopReason } : {}),
    ...(dispatchProduction.attemptShape ? { attemptShape: dispatchProduction.attemptShape } : {}),
    ...(dispatchProduction.generatedRepairAttempts
      ? { generatedRepairAttempts: dispatchProduction.generatedRepairAttempts }
      : {}),
  }, cfg, backends);
  const actionableCandidate = candidates.find((candidate) => candidate.verdict === 'actionable');
  const primaryCandidate = actionableCandidate ??
    (overallVerdict === 'healthy' || overallVerdict === 'policy-suppressed'
      ? fleetCandidate
      : candidates.find((candidate) => candidate.verdict === overallVerdict) ?? fleetCandidate);
  const verdict = primaryCandidate?.verdict === 'actionable' ? 'actionable' : overallVerdict;
  const action = primaryCandidate?.verdict === 'actionable'
    ? primaryCandidate.action
    : dispatchYieldActionFor(verdict, dispatchProduction.attemptShape);
  const topReason = primaryCandidate?.topReason ?? diagnosticTopReasonForDispatchSummary(dispatchProduction);
  const actionReason = primaryCandidate?.actionReason;
  return {
    windowHours: dispatchProduction.windowHours,
    minAttempts: MIN_DISPATCH_YIELD_ACTION_ATTEMPTS,
    lowYieldRate,
    diagnosticAttempts,
    proposalsCreated,
    proposalRate,
    policyDisabled,
    verdict,
    action,
    ...(actionReason ? { actionReason } : {}),
    sameTierOnly: true,
    recommendation: dispatchYieldRecommendation({
      verdict,
      action,
      actionReason,
      diagnosticAttempts,
      proposalRate,
      policyDisabled,
      primaryCandidate,
    }),
    ...(topReason ? { topReason } : {}),
    ...(dispatchProduction.attemptShape ? { attemptShape: dispatchProduction.attemptShape } : {}),
    ...(dispatchProduction.generatedRepairAttempts
      ? { generatedRepairAttempts: dispatchProduction.generatedRepairAttempts }
      : {}),
    ...(primaryCandidate ? { primaryCandidate } : {}),
    candidates,
  };
}

function dispatchYieldRecommendation(input: {
  verdict: FleetDispatchYieldDiagnosticVerdict;
  action: FleetDispatchYieldDiagnosticAction;
  actionReason?: string;
  diagnosticAttempts: number;
  proposalRate: number;
  policyDisabled: number;
  primaryCandidate?: FleetDispatchYieldDiagnosticCandidate;
}): string {
  if (input.verdict === 'policy-suppressed') {
    return `${input.policyDisabled} attempt(s) were proposal-disabled by policy; do not treat them as backend weakness.`;
  }
  if (input.verdict === 'insufficient-sample') {
    const needed = Math.max(0, MIN_DISPATCH_YIELD_ACTION_ATTEMPTS - input.diagnosticAttempts);
    return `Collect ${needed} more diagnostic attempt(s) before changing routing.`;
  }
  if (input.verdict === 'healthy') {
    return `Keep current routing; diagnostic proposal yield is ${formatActionPercent(input.proposalRate)}.`;
  }
  const subject = input.primaryCandidate ? dispatchYieldSubject(input.primaryCandidate) : 'dispatches';
  if (input.action === 'route-same-tier-alternative') {
    return `Inspect ${subject} with same-tier alternatives only; avoid tier escalation until deterministic evidence supports it.`;
  }
  if (input.actionReason) {
    return `Tighten context or reslice ${subject}; ${input.actionReason}.`;
  }
  return `Tighten context or reslice ${subject}; capture/gate blocking dominates the low-yield sample.`;
}

function buildAutonomyEffectiveness(status: FleetStatus): FleetAutonomyEffectivenessStatus {
  const readiness = status.autoMergeReadiness;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  const counts: FleetAutonomyEffectivenessStatus['counts'] = {
    backlogItems: status.queue.backlogItems,
    eligibleBacklogItems,
    cooldownItems: status.queue.cooldownItems ?? 0,
    pendingItems: status.queue.pendingItems ?? 0,
    repairRouteBlockedItems: status.queue.repairRouteBlockedItems ?? 0,
    nextEligibleAt: status.queue.nextEligibleAt ?? null,
    pendingProposals: status.proposals.pending,
    frontierPending: status.proposals.frontierPending,
    awaitingHostMerge: status.proposals.awaitingHostMerge ?? 0,
    preflightReady: readiness?.preflightReady ?? 0,
    authorityReady: readiness?.authorityReady ?? 0,
    needsVerification: readiness?.needsVerification ?? 0,
    blocked: readiness?.blocked ?? 0,
    knownVerificationFailed: readiness?.knownVerificationFailed ?? 0,
    recentMerges: status.merges.recent,
  };
  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: enrollment authority degraded (${enrollmentRegistry.reason}).`,
      counts,
    };
  }
  if (status.killSwitch?.state === 'unknown' ||
      status.daemon.sourceQuality?.sourceState !== 'healthy' ||
      status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    const reason = status.killSwitch?.state === 'unknown'
      ? 'kill switch source is uninspectable'
      : status.daemon.sourceQuality?.sourceState !== 'healthy'
        ? `daemon state source is degraded (${status.daemon.sourceQuality?.reason ?? 'unavailable'})`
        : 'guard health source is degraded';
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: ${reason}.`,
      counts,
    };
  }
  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (status.killed || !status.daemon.running || firstGuardBlock) {
    const reason = status.killed
      ? 'kill switch is engaged'
      : !status.daemon.running
        ? status.daemon.activation?.commandEligible === true
          ? 'daemon is stopped with one exact proposal activation eligible'
          : `daemon activation is blocked (${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'})`
        : firstGuardBlock?.detail ?? 'guard is blocking';
    return {
      phase: 'control-blocked',
      canAutoMergeNow: false,
      bottleneck: 'control',
      summary: `Autonomy is control-blocked: ${reason}.`,
      counts,
    };
  }
  if (status.proposals.authority?.gate === 'unavailable' && (
    counts.pendingProposals > 0 || status.proposals.sourceQuality?.sourceState !== 'missing'
  )) {
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: `Auto-merge authority is unavailable: ${status.proposals.authority.detail}.`,
      counts,
    };
  }
  if (counts.awaitingHostMerge > 0) {
    return {
      phase: 'host-handoff',
      canAutoMergeNow: false,
      bottleneck: 'host-handoff',
      summary: `${counts.awaitingHostMerge} proposal(s) are waiting for host PR merge confirmation.`,
      counts,
    };
  }
  if (
    readiness?.enabled &&
    readiness.configurationBlocker === undefined &&
    (counts.authorityReady ?? 0) > 0
  ) {
    return {
      phase: 'merge-ready',
      canAutoMergeNow: true,
      bottleneck: 'merge-drain',
      summary: `${counts.authorityReady} proposal(s) have complete authority evidence for the auto-merge drain.`,
      counts,
    };
  }
  if (readiness?.enabled && counts.needsVerification > 0) {
    return {
      phase: 'verification-needed',
      canAutoMergeNow: false,
      bottleneck: 'verification',
      summary: `${counts.needsVerification} proposal(s) need verification before judge or merge spend.`,
      counts,
    };
  }
  if (readiness?.enabled && (readiness.authorityBlocked ?? 0) > 0) {
    const topReason = Object.entries(readiness.authorityByReason ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: topReason
        ? `${readiness.authorityBlocked} proposal(s) lack complete merge authority; top blocker: ${topReason}.`
        : `${readiness.authorityBlocked} proposal(s) lack complete merge authority.`,
      counts,
    };
  }
  if (readiness && counts.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary: topReason
        ? `${counts.blocked} proposal(s) are blocked at the merge gate; top blocker: ${topReason}.`
        : `${counts.blocked} proposal(s) are blocked at the merge gate.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && eligibleBacklogItems > 0) {
    const production = status.proposalProduction;
    const productionDetail = production ? proposalProductionDiagnosis(production) : null;
    const backlogDetail = eligibleBacklogItems === counts.backlogItems
      ? `${counts.backlogItems} backlog item(s) are available`
      : `${eligibleBacklogItems}/${counts.backlogItems} backlog item(s) are eligible now`;
    return {
      phase: 'proposal-starved',
      canAutoMergeNow: false,
      bottleneck: 'proposal-production',
      summary: productionDetail
        ? `${backlogDetail}, but there are no pending proposals for auto-merge; ${productionDetail}.`
        : `${backlogDetail}, but there are no pending proposals for auto-merge.`,
      counts,
    };
  }
  if (counts.pendingProposals === 0 && counts.backlogItems > 0 && eligibleBacklogItems === 0) {
    if ((counts.repairRouteBlockedItems ?? 0) > 0) {
      return {
        phase: 'route-gated',
        canAutoMergeNow: false,
        bottleneck: 'routing',
        summary:
          `No claimable backlog work is visible; ${counts.repairRouteBlockedItems} generated repair item(s) ` +
          `lack an authorized route and remain queued for reevaluation.`,
        counts,
      };
    }
    const nextEligible = counts.nextEligibleAt ? ` Next eligible at ${counts.nextEligibleAt}.` : '';
    return {
      phase: 'cooldown-gated',
      canAutoMergeNow: false,
      bottleneck: 'cooldown',
      summary: `No eligible backlog work is visible; ${counts.cooldownItems ?? 0} item(s) are cooling and ${counts.pendingItems ?? 0} already have pending proposals.${nextEligible}`,
      counts,
    };
  }
  if (
    counts.pendingProposals > 0 ||
    counts.backlogItems > 0 ||
    counts.awaitingHostMerge > 0
  ) {
    return {
      phase: 'merge-blocked',
      canAutoMergeNow: false,
      bottleneck: 'merge-gate',
      summary:
        'Work inventory remains visible, but no complete action authority classification is available; ' +
        'inspect queue and proposal source state.',
      counts,
    };
  }
  return {
    phase: 'idle',
    canAutoMergeNow: false,
    bottleneck: 'none',
    summary: counts.recentMerges > 0
      ? `No pending merge work is visible; ${counts.recentMerges} auto-merge(s) landed in the last 24h.`
      : 'No pending proposals or backlog work are visible.',
    counts,
  };
}

function buildNextActions(status: FleetStatus): FleetNextAction[] {
  const actions: FleetNextAction[] = [];
  const add = (action: FleetNextAction): void => {
    if (actions.some((existing) => existing.id === action.id)) return;
    actions.push(action);
  };

  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    add({
      id: 'repair-enrollment-registry',
      priority: 'high',
      label: 'Repair enrollment registry',
      detail:
        `Enrollment authority is degraded (${enrollmentRegistry.reason}); queue inventory and autonomous work are withheld.`,
      commands: [
        nextActionCommand('Inspect enrollment', ['ashlr', 'enroll', 'list', '--json'], 'read-only'),
        nextActionCommand('Run preflight', ['ashlr', 'preflight', '--json'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.killSwitch?.state === 'unknown') {
    add({
      id: 'inspect-kill-switch-source',
      priority: 'critical',
      label: 'Inspect kill switch source',
      detail: 'Kill switch authority is uninspectable; the fleet remains paused until exact state is proven.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.daemon.sourceQuality?.sourceState !== 'healthy') {
    add({
      id: 'inspect-daemon-state-source',
      priority: 'critical',
      label: 'Inspect daemon state source',
      detail:
        `Daemon state is ${status.daemon.sourceQuality?.reason ?? 'unavailable'}; ` +
          'stopped/running state and spend are withheld.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    add({
      id: 'inspect-guard-health-source',
      priority: 'critical',
      label: 'Inspect guard health source',
      detail: 'Guard health is incomplete; autonomous work remains paused until all guard sources are readable.',
      commands: [
        nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status', '--json'], 'read-only'),
        nextActionCommand('Run diagnostics', ['ashlr', 'doctor'], 'read-only'),
      ],
    });
    return actions;
  }

  if (status.killed) {
    add({
      id: 'resume-fleet',
      priority: 'critical',
      label: 'Clear kill switch',
      detail:
        'The global kill switch is engaged. Clearing it does not authorize or start the daemon.',
      commands: [
        nextActionCommand('Clear kill switch', ['ashlr', 'fleet', 'resume'], 'control-plane', {
          endpointMethod: 'POST',
          endpointPath: '/api/fleet/resume',
          tokenRequired: true,
        }),
      ],
    });
  }

  if (!status.daemon.running) {
    const activation = status.daemon.activation;
    if (activation?.commandEligible === true) {
      add({
        id: 'start-daemon',
        priority: 'critical',
        label: 'Start one proposal cycle',
        detail:
          'A runtime-bound one-use proposal permit is currently valid; daemon start will revalidate and consume it.',
        commands: [
          nextActionCommand(
            'Start one proposal cycle',
            ['ashlr', 'daemon', 'start', '--once'],
            'autonomous-dispatch',
            { note: 'Snapshot-only recommendation; daemon start owns final authority and consumption.' },
          ),
        ],
      });
    } else {
      add({
        id: 'inspect-daemon-activation',
        priority: 'critical',
        label: 'Inspect daemon activation authority',
        detail:
          `The daemon is stopped and no exact one-shot proposal activation is currently eligible ` +
          `(${activation?.reason ?? 'activation-readiness-unavailable'}).`,
        commands: [
          nextActionCommand('Inspect daemon status', ['ashlr', 'daemon', 'status'], 'read-only'),
        ],
      });
    }
  }

  const firstGuardBlock = status.guardHealth?.blocks?.[0];
  if (firstGuardBlock) {
    add({
      id: 'repair-guard',
      priority: 'critical',
      label: 'Repair guard block',
      detail: firstGuardBlock.detail,
      target: firstGuardBlock.path,
      commands: [
        nextActionCommand('Inspect guard', ['ashlr', 'daemon', 'status'], 'read-only', {
          note: 'Repair commands are exposed on guardHealth.blocks[].repairCommands.',
        }),
      ],
    });
  }
  const controlBlocked = status.killed || !status.daemon.running || Boolean(firstGuardBlock);

  const phantomAuditAction = phantomAuditNextAction(status.phantom?.agentReport);
  if (phantomAuditAction) add(phantomAuditAction);

  const unhealthyEvidence = learningEvidenceReadinessSources(status, status.generatedAt)
    .filter((source) => source.actionSynthesis === 'eligible' &&
      source.eligibility !== 'observational' &&
      (source.eligibility === 'withheld' || source.status === 'degraded'));
  if (unhealthyEvidence.length > 0) {
    const labels = unhealthyEvidence.slice(0, 3).map((source) => source.label).join(', ');
    const firstSource = unhealthyEvidence[0]!.id;
    const signedEvidenceBlocked = unhealthyEvidence.some((source) => source.id === 'autonomy-packs') &&
      status.proposals.pending > 0;
    add({
      id: signedEvidenceBlocked ? 'inspect-signed-evidence' : 'inspect-learning-evidence',
      priority: signedEvidenceBlocked ? 'high' : 'medium',
      label: signedEvidenceBlocked ? 'Inspect signed evidence authority' : 'Inspect withheld evidence',
      detail:
        `${unhealthyEvidence.length} evidence source(s) are incomplete or degraded, so dependent ` +
        `authority, learning, or analytics remain fail-closed.${labels ? ` Sources: ${labels}.` : ''}`,
      commands: [
        nextActionCommand('Diagnose first withheld source', [
          'ashlr', 'fleet', 'evidence', 'doctor', firstSource, '--json',
        ], 'read-only', {
          note: 'Bounded diagnosis only; never deletes, rewrites, truncates, or bypasses an evidence ledger.',
        }),
        nextActionCommand('Run deep bounded diagnosis', [
          'ashlr', 'fleet', 'evidence', 'doctor', firstSource, '--deep', '--json',
        ], 'read-only', {
          note: 'Uses finite reader hard caps and performs no durable repair.',
        }),
        nextActionCommand('Inspect evidence matrix', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const awaitingHostMerge = status.proposals.awaitingHostMerge ?? 0;
  if (awaitingHostMerge > 0) {
    add({
      id: 'reconcile-host-prs',
      priority: 'high',
      label: 'Inspect host PR reconciliation',
      detail:
        `${awaitingHostMerge} proposal(s) are waiting for GitHub/host merge confirmation. ` +
        'Daemon activation remains governed by the separate one-shot action.',
      commands: [
        nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const readiness = status.autoMergeReadiness;
  const pendingProposalsBlockedByDisabledAutoMerge = Boolean(
    readiness && !readiness.enabled && status.proposals.pending > 0,
  );
  if (pendingProposalsBlockedByDisabledAutoMerge && !controlBlocked) {
    add({
      id: 'inspect-pending-proposals',
      priority: 'high',
      label: 'Inspect pending proposals',
      detail:
        `${status.proposals.pending} proposal(s) are pending while auto-merge is intentionally disabled; ` +
        'inspect their evidence and blockers without changing merge policy.',
      commands: [
        nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }
  if (readiness?.enabled && !controlBlocked) {
    const configurationReady = readiness.configurationBlocker === undefined;
    const remoteProtectionReady = remoteProtectionAuthorityReady(readiness);
    if (!configurationReady) {
      add({
        id: 'inspect-auto-merge-configuration',
        priority: 'high',
        label: 'Inspect auto-merge configuration',
        detail: readiness.configurationBlocker!,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    } else if (!remoteProtectionReady && readiness.remoteProtection) {
      add({
        id: 'inspect-protected-remote',
        priority: (readiness.branchAuthorityReady ?? 0) > 0 ? 'medium' : 'high',
        label: 'Inspect protected remote authority',
        detail: readiness.remoteProtection.detail,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only', {
            note: 'Remote-main automation remains blocked until exact live fleet coverage is available.',
          }),
        ],
      });
    }
    if (configurationReady && (readiness.authorityReady ?? 0) > 0) {
      add({
        id: 'drain-ready-auto-merges',
        priority: 'high',
        label: 'Drain ready auto-merges',
        detail:
          `${readiness.authorityReady} pending proposal(s) have complete read-only authority evidence. ` +
          'The running daemon owns scheduling; monitor the evidence without starting a second process.',
        commands: [
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (
      (readiness.authorityBlocked ?? 0) > 0 &&
      (readiness.authorityReady ?? 0) === 0 &&
      readiness.needsVerification === 0
    ) {
      const topReason = Object.entries(readiness.authorityByReason ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      add({
        id: 'inspect-auto-merge-authority',
        priority: 'high',
        label: 'Inspect merge authority',
        detail: topReason
          ? `${topReason[1]}x ${topReason[0]}`
          : `${readiness.authorityBlocked} proposal(s) lack complete authority evidence.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.needsVerification > 0) {
      add({
        id: 'verify-pending-proposals',
        priority: 'high',
        label: 'Verify pending proposals',
        detail:
          `${readiness.needsVerification} proposal(s) need verification before judge or merge spend. ` +
          'The running daemon owns scheduling; monitor verification without starting a second process.',
        commands: [
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.knownVerificationFailed > 0) {
      add({
        id: 'repair-verification-failures',
        priority: 'high',
        label: 'Drain failed proposals',
        detail:
          `${readiness.knownVerificationFailed} proposal(s) have permanent verification blockers. ` +
          'The running daemon owns maintenance scheduling; inspect the failures without starting a second process.',
        commands: [
          nextActionCommand('Inspect failed proposals', ['ashlr', 'inbox', '--json'], 'read-only'),
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    }
    if (readiness.blocked > 0 && readiness.preflightReady === 0 && readiness.needsVerification === 0) {
      const topReason = Object.entries(readiness.byReason)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      add({
        id: 'inspect-auto-merge-blockers',
        priority: 'medium',
        label: 'Inspect merge blockers',
        detail: topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Inspect inbox', ['ashlr', 'inbox', '--json'], 'read-only'),
        ],
      });
    }
  }

  const constrained = status.backends.find((backend) => {
    const availability = backend.resource?.availability;
    return availability === 'exhausted' || availability === 'throttled' || availability === 'unreachable';
  });
  if (constrained?.resource) {
    add({
      id: `resource-${constrained.backend}`,
      priority: constrained.resource.availability === 'exhausted' ? 'high' : 'medium',
      label: `Route around ${constrained.backend}`,
      detail: constrained.resource.reason,
      target: constrained.backend,
      commands: [
        nextActionCommand('Inspect resources', ['ashlr', 'resources', '--json'], 'read-only'),
        nextActionCommand('Inspect direction', ['ashlr', 'fleet', 'direction', '--json'], 'read-only'),
      ],
    });
  }

  const goalFocus = status.goalFocus;
  const staleLane = status.laneLocks?.samples.find(
    (sample) => sample.reason === 'stale-in-progress' && sample.goalId && sample.milestoneId,
  );
  if (status.laneLocks && status.laneLocks.staleInProgress > 0) {
    const staleCount = status.laneLocks.staleInProgress;
    add({
      id: 'recover-stale-goal-lanes',
      priority: 'high',
      label: 'Recover stale goal lanes',
      detail:
        `${staleCount} in-progress goal milestone(s) are stale.` +
        `${staleLane?.title ? ` First: ${staleLane.title}.` : ''}`,
      ...(staleLane?.repo ? { target: staleLane.repo } : {}),
      commands: [
        ...(staleLane?.goalId
          ? [nextActionCommand('Inspect goal', ['ashlr', 'goals', 'show', staleLane.goalId, '--json'], 'read-only')]
          : [nextActionCommand('List goals', ['ashlr', 'goals', 'list', '--json'], 'read-only')]),
        nextActionCommand('Recover stale lanes', ['ashlr', 'goals', 'recover-stale'], 'control-plane', {
          note: 'Goal-store only; resets stale proposal-less in-progress milestones back to pending.',
        }),
      ],
    });
  }
  if (goalFocus?.deferredNewGoalWork) {
    add({
      id: 'close-active-goals',
      priority: 'medium',
      label: 'Close active goals',
      detail:
        `Goal focus is holding new planning/invent work: ` +
        `${goalFocus.actionableActiveGoalCount}/${goalFocus.activeThreshold} active goal(s) have actionable milestones. ` +
        `Cached queue has ${goalFocus.visibleGoalBacklogItems} goal item(s) and ${goalFocus.visibleInventBacklogItems} invent item(s).`,
      commands: [
        nextActionCommand('List goals', ['ashlr', 'goals', 'list', '--json'], 'read-only'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const routeBlockedItems = status.queue.repairRouteBlockedItems ?? 0;
  const addRestoreRepairRoutes = (): void => {
    if (routeBlockedItems === 0 || controlBlocked) return;
    const topReason = status.queue.generatedRepairRoutes?.byReason.find((entry) => entry.reason !== 'feasible');
    add({
      id: 'restore-repair-routes',
      priority: 'medium',
      label: 'Restore repair routes',
      detail:
        `${routeBlockedItems} generated repair item(s) remain queued but cannot be claimed` +
        `${topReason ? `; top reason: ${topReason.reason} (${topReason.count})` : ''}.`,
      commands: [
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        nextActionCommand('Inspect resources', ['ashlr', 'resources', '--json'], 'read-only'),
        nextActionCommand('Inspect direction', ['ashlr', 'fleet', 'direction', '--json'], 'read-only'),
      ],
    });
  };

  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (eligibleBacklogItems === 0) addRestoreRepairRoutes();
  if (eligibleBacklogItems > 0 && !controlBlocked) {
    const top = status.queue.next?.[0];
    add({
      id: 'build-backlog',
      priority: 'medium',
      label: 'Build backlog proposals',
      detail: top
        ? `Start with ${top.title}`
        : `${eligibleBacklogItems} backlog item(s) are eligible.`,
      ...(top?.repo ? { target: top.repo } : {}),
      commands: [
        nextActionCommand('Run one proposal cycle', ['ashlr', 'loop'], 'autonomous-dispatch', {
          ...(top?.repo ? { cwd: top.repo } : {}),
          note: 'Proposal-only; respects daemon singleton, kill switch, enrollment, and budget guards.',
        }),
      ],
    });
    addRestoreRepairRoutes();
  } else if (status.queue.backlogItems > 0 && !controlBlocked) {
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const repairBlocked = status.queue.repairControlBlockedItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt;
    if (repairBlocked > 0) {
      const unavailable = status.queue.repairLifecycleUnavailableItems ?? 0;
      const terminal = status.queue.repairTerminalItems ?? 0;
      add({
        id: 'inspect-repair-lifecycle-control',
        priority: 'medium',
        label: 'Inspect repair lifecycle control',
        detail: `${repairBlocked} generated repair item(s) are lifecycle/control blocked ` +
          `(${unavailable} unavailable, ${terminal} terminal).`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        ],
      });
    } else if (cooling > 0 && eligibleBacklogItems === 0) {
      add({
        id: 'cooldown-gated-backlog',
        priority: 'medium',
        label: 'Review cooldown gate',
        detail: nextEligible
          ? `${status.queue.backlogItems} backlog item(s) are cooling; next eligible at ${nextEligible}. Decide whether to wait, lower cooldown policy, or dispatch a targeted high-value item.`
          : `${status.queue.backlogItems} backlog item(s) are visible but none are eligible. Decide whether to wait, inspect worked-ledger cooldowns, or dispatch a targeted high-value item.`,
        commands: [
          nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
          nextActionCommand('Dry-run loop', ['ashlr', 'loop', '--dry-run'], 'read-only'),
        ],
      });
    }
    if (repairBlocked === 0) {
      add({
        id: 'wait-for-backlog-eligibility',
        priority: 'low',
        label: 'Wait for backlog eligibility',
        detail: nextEligible
          ? `${status.queue.backlogItems} backlog item(s) are present, but ${cooling} are cooling and ${pending} already have pending proposals; next eligible at ${nextEligible}.`
          : `${status.queue.backlogItems} backlog item(s) are present, but none are currently eligible (${cooling} cooling, ${pending} pending).`,
        commands: [
          nextActionCommand('Watch fleet', ['ashlr', 'fleet', 'watch'], 'read-only'),
        ],
      });
    }
  }

  const missingVerify = status.queue.repos?.executionProfiles?.reposMissingVerifyCommands ?? 0;
  if (missingVerify > 0) {
    const missingRepos = status.queue.repos?.executionProfiles?.missingVerifyCommands ?? [];
    const sample = missingRepos.slice(0, 3).map(formatExecutionProfileSample).join(', ');
    add({
      id: 'add-repo-verify-contracts',
      priority: 'low',
      label: 'Add repo verify contracts',
      detail: `${missingVerify} enrolled repo(s) have no detected verify commands.${sample ? ` First: ${sample}.` : ''}`,
      commands: [
        nextActionCommand('Inspect missing verifiers', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }
  const missingExplicitMergeContracts =
    status.queue.repos?.executionProfiles?.reposMissingExplicitMergeContracts ?? 0;
  if (missingExplicitMergeContracts > 0) {
    const missingRepos = status.queue.repos?.executionProfiles?.missingExplicitMergeContracts ?? [];
    const sample = missingRepos.slice(0, 3).map(formatExecutionProfileSample).join(', ');
    add({
      id: 'add-explicit-merge-verify-contracts',
      priority: 'medium',
      label: 'Add explicit merge verify contracts',
      detail:
        `${missingExplicitMergeContracts} enrolled repo(s) rely on inferred or non-merge verification.` +
        `${sample ? ` First: ${sample}.` : ''}`,
      commands: [
        nextActionCommand('Inspect merge contracts', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
        nextActionCommand('Edit verify contract', ['vi', 'ashlr.verify.json'], 'manual', {
          ...(missingRepos[0]?.repo && existsSync(missingRepos[0].repo) ? { cwd: missingRepos[0].repo } : {}),
          note: 'Create a required merge-profile repo-owned verification contract.',
        }),
      ],
    });
  }

  if (actions.length === 0) {
    add({
      id: 'refresh-backlog',
      priority: 'low',
      label: 'Refresh backlog',
      detail: 'No immediate blockers or ready work are visible in the current snapshot.',
      commands: [
        nextActionCommand('Refresh backlog', ['ashlr', 'backlog', 'refresh'], 'control-plane'),
        nextActionCommand('Inspect fleet status', ['ashlr', 'fleet', 'status', '--json'], 'read-only'),
      ],
    });
  }

  const priorityRank: Record<FleetNextAction['priority'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const actionRank = (action: FleetNextAction): number => {
    if (action.id === 'repair-verification-failures' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) > 0) return -1.4;
    if (action.id === 'review-phantom-audit') return -1.3;
    if (action.id === 'drain-diagnostic-reslices' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) === 0) return -1.2;
    if (action.id === 'process-capture-repairs' && (status.autoMergeReadiness?.knownVerificationFailed ?? 0) === 0) return -1.1;
    if (action.id === 'inspect-dispatch-yield') return -1;
    if (action.id === 'inspect-learning-evidence') return 1;
    if (action.id === 'add-explicit-merge-verify-contracts') return 0.5;
    return 0;
  };
  return actions
    .sort((a, b) =>
      priorityRank[a.priority] - priorityRank[b.priority] ||
      actionRank(a) - actionRank(b) ||
      a.id.localeCompare(b.id),
    )
    .slice(0, 6);
}

function formatExecutionProfileSample(row: {
  name: string;
  projectKinds: RepoProjectKind[];
  reason: string;
}): string {
  const kind = row.projectKinds.length > 0 ? row.projectKinds.join('+') : 'unknown';
  return `${row.name} [${kind}: ${row.reason}]`;
}

interface PhantomAuditSignalSummary {
  detail: string;
  signals: string[];
}

function phantomAuditSignalSummary(report: PhantomAgentReportRollup | undefined): PhantomAuditSignalSummary | null {
  if (!report) return null;

  const approvalReports = Math.max(report.requiresApprovalCount, report.statusCounts['requires-approval'] ?? 0);
  const failedReports = Math.max(report.failedReports, report.statusCounts.failed ?? 0);
  const highRiskSignals = (report.riskCounts.high ?? 0) + (report.riskCounts.critical ?? 0);
  const highSeveritySignals = (report.severityCounts.high ?? 0) + (report.severityCounts.critical ?? 0);
  const delegation = report.delegationSafety;
  const unsafeDelegations = delegation?.safetyCounts.unsafe ?? 0;
  const blockedDelegations =
    (delegation?.statusCounts.blocked ?? 0) +
    (delegation?.statusCounts.failed ?? 0);
  const reviewDelegations =
    (delegation?.statusCounts.review ?? 0) +
    (delegation?.statusCounts['requires-approval'] ?? 0) +
    (delegation?.primaryActionCounts.review ?? 0) +
    (delegation?.primaryActionCounts.approve ?? 0) +
    (delegation?.primaryActionCounts.block ?? 0);

  const signals = [
    countSignal(approvalReports, 'approval-required report'),
    countSignal(failedReports, 'failed report'),
    countSignal(highRiskSignals, 'high/critical risk signal'),
    countSignal(highSeveritySignals, 'high/critical severity signal'),
    countSignal(unsafeDelegations, 'unsafe delegation'),
    countSignal(blockedDelegations, 'blocked delegation'),
    countSignal(reviewDelegations, 'delegation review signal'),
  ].filter((signal): signal is string => signal !== null);

  if (signals.length === 0) return null;

  const scope = report.scannedRepos > 0 ? ` across ${countPhrase(report.scannedRepos, 'scanned repo')}` : '';
  return {
    signals,
    detail: `Phantom audit rollup needs review${scope}: ${signals.join(', ')}. Values hidden; only aggregate counts are shown.`,
  };
}

function phantomAuditNextAction(report: PhantomAgentReportRollup | undefined): FleetNextAction | null {
  const summary = phantomAuditSignalSummary(report);
  if (!summary) return null;

  return {
    id: 'review-phantom-audit',
    priority: 'high',
    label: 'Review Phantom audit',
    detail: summary.detail,
  };
}

function phantomAuditReadinessSource(
  report: PhantomAgentReportRollup,
  generatedAt: string,
): FleetReadinessSourceHealth {
  const summary = phantomAuditSignalSummary(report);
  if (summary) {
    return readinessSource(
      'phantom',
      'Phantom Audit',
      'blocked',
      generatedAt,
      READINESS_STATUS_STALE_MS,
      summary.detail,
      { sourcePresent: true, sourceDegraded: true },
    );
  }

  const scope = report.scannedRepos > 0 ? ` across ${countPhrase(report.scannedRepos, 'scanned repo')}` : '';
  return readinessSource(
    'phantom',
    'Phantom Audit',
    'healthy',
    generatedAt,
    READINESS_STATUS_STALE_MS,
    `Phantom audit rollup is clear${scope}. Values hidden; only aggregate counts are shown.`,
    {
      empty: report.scannedRepos === 0 && report.validReports === 0 && report.failedReports === 0,
      sourcePresent: true,
    },
  );
}

function countSignal(count: number, singular: string): string | null {
  return count > 0 ? countPhrase(count, singular) : null;
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

interface AutonomousShipReadinessInputs {
  generatedAt: string;
  queueSnapshotAt: string | null;
  queueSourceStatus: FleetReadinessSourceStatus;
  queueSourceDetail: string;
}

const READINESS_DAEMON_STALE_MS = 30 * 60 * 1000;
const READINESS_QUEUE_STALE_MS = 24 * 60 * 60 * 1000;
const READINESS_STATUS_STALE_MS = 30 * 60 * 1000;
const READINESS_REMOTE_PROTECTION_STALE_MS = 5 * 60 * 1000;
const MAX_REMOTE_PROTECTION_STATUS_REPOS = 32;

function readinessPriorityRank(priority: FleetNextAction['priority']): number {
  switch (priority) {
    case 'critical': return 0;
    case 'high': return 1;
    case 'medium': return 2;
    case 'low': return 3;
  }
}

function readinessFreshness(
  observedAt: string | null,
  staleMs: number,
): { freshness: FleetReadinessFreshness; ageMs: number | null } {
  if (!observedAt) return { freshness: 'unknown', ageMs: null };
  const parsed = Date.parse(observedAt);
  if (!Number.isFinite(parsed)) return { freshness: 'unknown', ageMs: null };
  const ageMs = Math.max(0, Date.now() - parsed);
  return { freshness: ageMs > staleMs ? 'stale' : 'fresh', ageMs };
}

function readinessBadge(status: FleetReadinessSourceStatus): FleetReadinessSourceHealth['badge'] {
  return status;
}

const READINESS_SOURCE_QUALITY_LABELS: Record<FleetReadinessSourceQualityBadge, string> = {
  'healthy-source': 'healthy source',
  'healthy-zero': 'healthy zero',
  'degraded-source': 'degraded source',
  'missing-source': 'missing source',
  'stale-source': 'stale source',
  'unknown-source': 'unknown source',
};

function readinessSourceQuality(input: {
  status: FleetReadinessSourceStatus;
  freshness: FleetReadinessFreshness;
  empty: boolean;
  sourcePresent: boolean;
  sourceDegraded: boolean;
  detail: string;
}): FleetReadinessSourceQuality {
  let badge: FleetReadinessSourceQualityBadge;
  if (!input.sourcePresent || input.status === 'unavailable') {
    badge = 'missing-source';
  } else if (input.freshness === 'stale') {
    badge = 'stale-source';
  } else if (input.freshness === 'unknown') {
    badge = 'unknown-source';
  } else if (input.sourceDegraded || input.status === 'degraded') {
    badge = 'degraded-source';
  } else if (input.empty) {
    badge = 'healthy-zero';
  } else {
    badge = 'healthy-source';
  }
  return {
    badge,
    label: READINESS_SOURCE_QUALITY_LABELS[badge],
    empty: input.empty,
    sourcePresent: input.sourcePresent,
    detail: input.detail,
  };
}

function readinessSource(
  id: FleetReadinessSourceHealth['id'],
  label: string,
  status: FleetReadinessSourceStatus,
  observedAt: string | null,
  staleMs: number,
  detail: string,
  opts?: {
    freshness?: FleetReadinessFreshness;
    empty?: boolean;
    sourcePresent?: boolean;
    sourceDegraded?: boolean;
  },
): FleetReadinessSourceHealth {
  const measured = opts?.freshness
    ? { freshness: opts.freshness, ageMs: null }
    : readinessFreshness(observedAt, staleMs);
  let effectiveStatus = status;
  if (measured.freshness === 'stale' && effectiveStatus === 'healthy') {
    effectiveStatus = 'degraded';
  } else if (measured.freshness === 'unknown' && effectiveStatus === 'healthy') {
    effectiveStatus = 'unknown';
  }
  return {
    id,
    label,
    status: effectiveStatus,
    badge: readinessBadge(effectiveStatus),
    freshness: measured.freshness,
    observedAt,
    ageMs: measured.ageMs,
    detail,
    sourceQuality: readinessSourceQuality({
      status: effectiveStatus,
      freshness: measured.freshness,
      empty: opts?.empty === true,
      sourcePresent: opts?.sourcePresent ?? status !== 'unavailable',
      sourceDegraded: opts?.sourceDegraded === true,
      detail,
    }),
  };
}

function evidenceReadinessSource(input: {
  id: FleetReadinessSourceHealth['id'];
  label: string;
  role: FleetReadinessEvidenceRole;
  quality: FleetReadinessEvidenceQuality | undefined;
  generatedAt: string;
  applicable?: boolean;
  applicability?: Exclude<FleetReadinessEvidenceApplicability, 'disabled'>;
  /** Whether source degradation may synthesize FleetNextAction records. */
  actionSynthesis?: 'eligible' | 'observational-only';
}): FleetReadinessSourceHealth {
  const actionSynthesis = input.role === 'forensics' || input.actionSynthesis === 'observational-only'
    ? 'observational-only'
    : 'eligible';
  if (input.applicable === false) {
    const source = readinessSource(
      input.id,
      input.label,
      'healthy',
      null,
      READINESS_STATUS_STALE_MS,
      `${input.role} evidence is not applicable under the effective fleet policy`,
      { freshness: 'not-applicable', empty: true, sourcePresent: false },
    );
    return {
      ...source,
      category: 'evidence',
      evidenceRole: input.role,
      eligibility: 'not-applicable',
      applicability: 'disabled',
      actionSynthesis,
    };
  }
  const quality = input.quality;
  const gateRole = input.role === 'merge-authority' || input.role === 'merge-gate';
  const observational = !gateRole && actionSynthesis === 'observational-only';
  const degraded = !quality || quality.sourceState === 'degraded' || !quality.complete;
  const missing = quality?.sourceState === 'missing';
  const eligibility: FleetReadinessEvidenceEligibility = observational
    ? 'observational'
    : degraded
      ? 'withheld'
      : missing
        ? 'cold-start'
        : 'eligible';
  const status: FleetReadinessSourceStatus = degraded ? 'degraded' : missing ? 'unavailable' : 'healthy';
  const stop = quality && quality.stopReasons.length > 0 ? `; stopped: ${quality.stopReasons.join(', ')}` : '';
  const detail = quality
    ? missing
      ? `${input.role} evidence has no ledger yet; consumers remain in cold-start mode`
      : `${input.role} evidence ${eligibility}; ${quality.filesRead} file(s), ${quality.rowsScanned} row(s), ` +
        `${quality.invalidRows} invalid, ${quality.unreadableFiles} unreadable${stop}`
    : `${input.role} evidence diagnostics are unavailable; consumers fail closed`;
  const sourceDetail = input.role === 'merge-gate' && degraded
    ? `${detail}; recovery: ashlr fleet evidence doctor ${input.id} --json (read-only); ` +
      'unsigned evidence cannot grant merge authority'
    : detail;
  const source = readinessSource(
    input.id,
    input.label,
    status,
    input.generatedAt,
    READINESS_STATUS_STALE_MS,
    sourceDetail,
    {
      empty: missing || (quality?.rowsScanned ?? 0) === 0,
      sourcePresent: quality?.sourcePresent ?? false,
      sourceDegraded: degraded,
    },
  );
  return {
    ...source,
    category: 'evidence',
    evidenceRole: input.role,
    eligibility,
    applicability: input.applicability ?? 'optional',
    actionSynthesis,
    ...(quality ? { evidenceQuality: { ...quality, stopReasons: [...quality.stopReasons] } } : {}),
  };
}

function learningEvidenceReadinessSources(
  status: FleetStatus,
  generatedAt: string,
): FleetReadinessSourceHealth[] {
  const autonomyQuality = status.autonomy?.sourceQuality;
  const autonomyEvidenceQuality: FleetReadinessEvidenceQuality | undefined = autonomyQuality
    ? {
        sourceState: autonomyQuality.sourceState,
        sourcePresent: autonomyQuality.sourcePresent,
        complete: autonomyQuality.complete,
        stopReasons: [
          ...(autonomyQuality.limitExceeded ? ['bounded-limit'] : []),
          ...(autonomyQuality.invalidFiles > 0 ? ['invalid-file'] : []),
          ...(autonomyQuality.unreadableFiles > 0 ? ['unreadable-file'] : []),
        ],
        filesRead: autonomyQuality.filesRead,
        bytesRead: autonomyQuality.bytesRead,
        rowsScanned: autonomyQuality.filesRead,
        invalidRows: autonomyQuality.invalidFiles,
        unreadableFiles: autonomyQuality.unreadableFiles,
      }
    : undefined;
  return [
    evidenceReadinessSource({
      id: 'autonomy-packs', label: 'Signed Evidence Authority', role: 'merge-authority',
      quality: autonomyEvidenceQuality, generatedAt, applicability: 'required',
    }),
    evidenceReadinessSource({
      id: 'decisions', label: 'Unsigned Decision Merge Gate', role: 'merge-gate',
      quality: status.decisionsSource, generatedAt, applicability: 'required',
      actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'judge-traces', label: 'Judge Outcomes', role: 'learning',
      quality: status.judgeTraceSource, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'agent-actions', label: 'Agent Actions', role: 'learning',
      quality: status.workspace?.sourceQuality, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'dispatch-production', label: 'Dispatch Outcomes', role: 'analytics',
      quality: status.dispatchProductionSource, generatedAt, actionSynthesis: 'observational-only',
    }),
    evidenceReadinessSource({
      id: 'dispatch-manifests', label: 'Dispatch Intent', role: 'forensics',
      quality: status.dispatchManifestSource, generatedAt,
      applicable: status.evidencePolicy?.concurrentDispatchEnabled !== false,
    }),
    evidenceReadinessSource({
      id: 'best-of-n', label: 'Candidate Races', role: 'learning',
      quality: status.bestOfNSource, generatedAt, actionSynthesis: 'observational-only',
      applicable: status.evidencePolicy?.bestOfNEnabled !== false,
    }),
    evidenceReadinessSource({
      id: 'post-merge', label: 'Post-Merge Cohort', role: 'forensics',
      quality: status.postMergeSource, generatedAt,
    }),
  ];
}

function readinessBlocker(
  id: string,
  label: string,
  detail: string,
  severity: FleetNextAction['priority'],
  source: FleetAutonomousShipReadinessBlocker['source'],
): FleetAutonomousShipReadinessBlocker {
  return { id, label, detail, severity, source };
}

function resourceReadinessSource(status: FleetStatus, generatedAt: string): FleetReadinessSourceHealth {
  const backends = Array.isArray(status.backends) ? status.backends : [];
  if (backends.length === 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unavailable',
      null,
      READINESS_STATUS_STALE_MS,
      'no allowed backends are visible in fleet status',
      { empty: true, sourcePresent: false },
    );
  }

  const unavailable = new Set(['exhausted', 'throttled', 'unreachable']);
  const resources = backends.map((backend) => backend.resource).filter(Boolean);
  const hardBlocked = backends.filter((backend) => unavailable.has(String(backend.resource?.availability ?? 'unknown')));
  const notSensed = backends.filter((backend) => backend.resource?.availability === 'not-sensed');
  const unknown = backends.filter((backend) => backend.resource?.availability === 'unknown' || !backend.resource);
  const openish = backends.filter((backend) =>
    backend.resource?.availability === 'open' || backend.resource?.availability === 'near',
  );
  const latestObservedAt = resources
    .map((resource) => resource?.snapshotAt ?? null)
    .filter((ts): ts is string => typeof ts === 'string')
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? generatedAt;

  if (hardBlocked.length === backends.length) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'blocked',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `all ${backends.length} backend resource signal(s) are constrained`,
      { sourcePresent: true },
    );
  }
  if (hardBlocked.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${hardBlocked.length}/${backends.length} backend resource signal(s) are constrained`,
      { sourcePresent: true, sourceDegraded: true },
    );
  }
  if (openish.length === 0 && (notSensed.length > 0 || unknown.length > 0)) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'unknown',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      'backend capacity exists but no sensed open resource signal is available',
      { sourcePresent: true },
    );
  }
  if (notSensed.length > 0 || unknown.length > 0) {
    return readinessSource(
      'resources',
      'Resource Signals',
      'degraded',
      latestObservedAt,
      READINESS_STATUS_STALE_MS,
      `${notSensed.length + unknown.length}/${backends.length} backend resource signal(s) are unsensed or unknown`,
      { sourcePresent: true, sourceDegraded: true },
    );
  }
  return readinessSource(
    'resources',
    'Resource Signals',
    'healthy',
    latestObservedAt,
    READINESS_STATUS_STALE_MS,
    `${openish.length}/${backends.length} backend resource signal(s) are open or near capacity`,
    { sourcePresent: true },
  );
}

function shipReadinessSources(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetReadinessSourceHealth[] {
  const daemonObservedAt = status.daemon.lockHeartbeatAt ?? status.daemon.lastTickAt;
  const daemonSourceDegraded = status.daemon.sourceQuality?.sourceState !== 'healthy';
  const daemonDetail = daemonSourceDegraded
    ? `daemon state source is degraded (${status.daemon.sourceQuality?.reason ?? 'unavailable'})`
    : status.daemon.running
    ? `daemon running; last tick ${status.daemon.lastTickAt ?? 'unknown'}`
    : status.daemon.activation?.commandEligible === true
      ? 'daemon is stopped; one exact proposal activation is snapshot-eligible'
      : `daemon is stopped; activation blocked (${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'})`;
  const daemonSource = readinessSource(
    'daemon',
    'Daemon',
    daemonSourceDegraded ? 'unknown' : status.daemon.running ? 'healthy' : 'blocked',
    daemonObservedAt,
    READINESS_DAEMON_STALE_MS,
    daemonDetail,
  );

  const guardHealth = status.guardHealth;
  const guardSource = guardHealth
    ? readinessSource(
        'guard',
        'Guard Health',
        guardHealth.sourceQuality?.sourceState !== 'healthy'
          ? 'degraded'
          : guardHealth.blocks.length > 0
            ? 'blocked'
            : 'healthy',
        guardHealth.generatedAt,
        READINESS_STATUS_STALE_MS,
      guardHealth.sourceQuality?.sourceState !== 'healthy'
        ? `guard health source is degraded (${guardHealth.sourceQuality?.reasons.join(', ') || 'incomplete'})`
        : guardHealth.blocks.length > 0
        ? guardHealth.blocks[0]?.detail ?? 'guard health is blocking autonomous work'
        : 'guard health is clear',
      {
        empty: guardHealth.blocks.length === 0,
        sourcePresent: true,
        sourceDegraded: guardHealth.sourceQuality?.sourceState !== 'healthy',
      },
      )
    : readinessSource(
        'guard',
        'Guard Health',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'guard health diagnosis is unavailable',
        { sourcePresent: false },
      );

  const readiness = status.autoMergeReadiness;
  const autoMergeSource = readiness
    ? readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        readiness.enabled && readiness.configurationBlocker === undefined
          ? (readiness.authorityBlocked ?? 0) === 0 && remoteProtectionAuthorityReady(readiness)
            ? 'healthy'
            : (readiness.branchAuthorityReady ?? 0) > 0
              ? 'degraded'
              : 'blocked'
          : 'blocked',
        readiness.remoteProtection?.required
          ? readiness.remoteProtection.observedAt
          : inputs.generatedAt,
        readiness.remoteProtection?.required
          ? READINESS_REMOTE_PROTECTION_STALE_MS
          : READINESS_STATUS_STALE_MS,
        readiness.enabled
          ? `${readiness.authorityReady ?? 0} authority-ready, ${readiness.preflightReady} preflight-ready, ${readiness.needsVerification} need verification, ${readiness.blocked} statically blocked; ${readiness.remoteProtection?.detail ?? 'remote protection status unavailable'}`
          : 'auto-merge is disabled',
        {
          empty:
            readiness.pending === 0 &&
            readiness.preflightReady === 0 &&
            readiness.needsVerification === 0 &&
            readiness.blocked === 0 &&
            readiness.knownVerificationFailed === 0 &&
            readiness.remoteProtection?.required !== true,
          sourcePresent: true,
        },
      )
    : readinessSource(
        'auto-merge',
        'Auto-Merge Gate',
        'unavailable',
        null,
        READINESS_STATUS_STALE_MS,
        status.proposals.authority?.detail ?? 'auto-merge readiness source is unavailable',
        { sourcePresent: false },
      );

  const queueSource = readinessSource(
    'queue',
    'Queue Snapshot',
    inputs.queueSourceStatus,
    inputs.queueSnapshotAt,
    READINESS_QUEUE_STALE_MS,
    inputs.queueSourceDetail,
    {
      empty: status.queue.backlogItems === 0,
      sourcePresent: inputs.queueSourceStatus !== 'unavailable' && inputs.queueSourceStatus !== 'unknown',
      sourceDegraded: inputs.queueSourceStatus === 'degraded',
    },
  );

  const laneLocks = status.laneLocks;
  const laneQuality = laneLocks?.sourceQuality;
  const laneSource = laneLocks
    ? readinessSource(
        'lane-locks',
        'Autonomy Lanes',
        laneLocks.unverifiedApplied > 0
          ? 'blocked'
          : laneQuality?.sourceState === 'healthy' && laneQuality.complete
            ? 'healthy'
            : laneQuality?.sourceState === 'degraded'
              ? 'degraded'
              : 'unavailable',
        laneLocks.generatedAt,
        READINESS_STATUS_STALE_MS,
        laneLocks.unverifiedApplied > 0
          ? `${laneLocks.unverifiedApplied} applied proposal(s) lack verification`
          : laneQuality?.sourceState === 'healthy' && laneQuality.complete
            ? `${laneLocks.active} active lane(s); no unverified applied work`
            : `autonomy lane evidence is incomplete (${laneQuality?.reasons.join(', ') || 'source unavailable'})`,
        {
          empty: laneLocks.active === 0 && laneLocks.awaitingHostMerge === 0 && laneLocks.unverifiedApplied === 0,
          sourcePresent: laneQuality !== undefined && laneQuality.sourceState !== 'missing',
          sourceDegraded: laneQuality?.sourceState !== 'healthy' || laneQuality.complete !== true,
        },
      )
    : readinessSource(
        'lane-locks',
        'Autonomy Lanes',
        'unavailable',
        null,
        READINESS_STATUS_STALE_MS,
        'autonomy lane evidence is unavailable',
        { sourcePresent: false },
      );

  const resourcesSource = resourceReadinessSource(status, inputs.generatedAt);

  const direction = status.autonomyDirection;
  const directionSource = direction
    ? readinessSource(
        'direction',
        'Autonomy Direction',
        'healthy',
        direction.generatedAt,
        READINESS_STATUS_STALE_MS,
        `${direction.mode} recommendation with ${direction.confidence} confidence`,
        { sourcePresent: true },
      )
    : readinessSource(
        'direction',
        'Autonomy Direction',
        'unknown',
        null,
        READINESS_STATUS_STALE_MS,
        'autonomy direction summary is unavailable',
        { sourcePresent: false },
      );

  const phantomSource = status.phantom?.agentReport
    ? phantomAuditReadinessSource(status.phantom.agentReport, inputs.generatedAt)
    : null;

  return [
    daemonSource,
    guardSource,
    autoMergeSource,
    queueSource,
    laneSource,
    resourcesSource,
    directionSource,
    ...(phantomSource ? [phantomSource] : []),
  ];
}

function readinessSourceSummary(sources: FleetReadinessSourceHealth[]): Record<FleetReadinessSourceStatus, number> {
  const summary: Record<FleetReadinessSourceStatus, number> = {
    healthy: 0,
    degraded: 0,
    blocked: 0,
    unavailable: 0,
    unknown: 0,
  };
  for (const source of sources) summary[source.status]++;
  return summary;
}

function readinessSourceQualitySummary(
  sources: FleetReadinessSourceHealth[],
): Record<FleetReadinessSourceQualityBadge, number> {
  const summary: Record<FleetReadinessSourceQualityBadge, number> = {
    'healthy-source': 0,
    'healthy-zero': 0,
    'degraded-source': 0,
    'missing-source': 0,
    'stale-source': 0,
    'unknown-source': 0,
  };
  for (const source of sources) {
    const badge = source.sourceQuality?.badge ?? 'unknown-source';
    summary[badge]++;
  }
  return summary;
}

function readinessEvidenceSummary(
  sources: FleetReadinessSourceHealth[],
): Record<FleetReadinessEvidenceEligibility, number> {
  const summary: Record<FleetReadinessEvidenceEligibility, number> = {
    eligible: 0,
    'cold-start': 0,
    withheld: 0,
    observational: 0,
    'not-applicable': 0,
  };
  for (const source of sources) {
    if (source.category === 'evidence' && source.eligibility) summary[source.eligibility]++;
  }
  return summary;
}

function readinessFreshnessSummary(
  generatedAt: string,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessStatus['freshness'] {
  const observed = sources
    .map((source) => source.observedAt)
    .filter((ts): ts is string => typeof ts === 'string' && Number.isFinite(Date.parse(ts)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const ageValues = sources
    .map((source) => source.ageMs)
    .filter((age): age is number => typeof age === 'number' && Number.isFinite(age));
  const staleSources = sources.filter((source) => source.freshness === 'stale').length;
  const unknownSources = sources.filter((source) => source.freshness === 'unknown').length;
  return {
    generatedAt,
    overall: staleSources > 0 ? 'stale' : unknownSources > 0 ? 'unknown' : 'fresh',
    freshestAt: observed.length > 0 ? observed[observed.length - 1]! : null,
    stalestAt: observed.length > 0 ? observed[0]! : null,
    maxAgeMs: ageValues.length > 0 ? Math.max(...ageValues) : null,
    staleSources,
    unknownSources,
  };
}

function chooseReadinessBlocker(
  status: FleetStatus,
  sources: FleetReadinessSourceHealth[],
): FleetAutonomousShipReadinessBlocker | null {
  const enrollmentRegistry = status.queue.repos?.registry;
  if (enrollmentRegistry?.state === 'degraded') {
    return readinessBlocker(
      'enrollment-registry-degraded',
      'Enrollment registry degraded',
      `Enrollment authority could not be proven (${enrollmentRegistry.reason}); queue inventory and autonomous work are withheld.`,
      'high',
      'queue',
    );
  }
  if (status.killSwitch?.state === 'unknown') {
    return readinessBlocker(
      'kill-switch-source-unknown',
      'Kill switch source unknown',
      'The global kill switch cannot be inspected, so autonomous shipping remains paused.',
      'critical',
      'fleet',
    );
  }
  if (status.killed) {
    return readinessBlocker(
      'kill-switch',
      'Fleet paused',
      'The global kill switch is engaged, so autonomous shipping is paused.',
      'critical',
      'fleet',
    );
  }
  if (status.daemon.sourceQuality?.sourceState !== 'healthy') {
    return readinessBlocker(
      'daemon-source-degraded',
      'Daemon state source degraded',
      `Daemon state is ${status.daemon.sourceQuality?.reason ?? 'unavailable'}; ` +
        'running state and spend cannot be trusted.',
      'critical',
      'daemon',
    );
  }
  if (!status.daemon.running) {
    if (status.daemon.activation?.commandEligible !== true) {
      return readinessBlocker(
        'daemon-activation-blocked',
        'Daemon activation blocked',
        `The daemon is stopped and no exact one-shot proposal activation is currently eligible ` +
          `(${status.daemon.activation?.reason ?? 'activation-readiness-unavailable'}).`,
        'critical',
        'daemon',
      );
    }
    return readinessBlocker(
      'daemon-stopped',
      'Daemon stopped',
      'The daemon is stopped; an exact one-shot proposal activation is eligible but must be revalidated at execution.',
      'critical',
      'daemon',
    );
  }
  const guardBlock = status.guardHealth?.blocks?.[0];
  if (status.guardHealth?.sourceQuality?.sourceState !== 'healthy') {
    return readinessBlocker(
      'guard-source-degraded',
      'Guard health source degraded',
      'Guard health is incomplete, so autonomous shipping remains paused.',
      'critical',
      'guard',
    );
  }
  if (guardBlock) {
    return readinessBlocker('guard-block', 'Guard block', guardBlock.detail, 'critical', 'guard');
  }
  if (status.proposals.pending > 0 && status.autonomy?.authorityState === 'degraded') {
    const quality = status.autonomy.sourceQuality;
    return readinessBlocker(
      'signed-evidence-degraded',
      'Signed evidence authority degraded',
      `The signed evidence store is incomplete (${quality.invalidFiles} invalid, ` +
        `${quality.unreadableFiles} unreadable${quality.limitExceeded ? ', bounded read limit exceeded' : ''}); ` +
        `${status.proposals.pending} pending proposal(s) remain fail-closed.`,
      'high',
      'autonomy-packs',
    );
  }
  const sharedQueue = status.queue.shared;
  if (sharedQueue && !sharedQueue.authorityReady) {
    const detail = !sharedQueue.trustedCoherentStorage
      ? 'Filesystem queue authority requires trustedCoherentStorage:true after the operator verifies one coherent cross-host mount.'
      : !sharedQueue.capability.verified
        ? `Local filesystem primitive probe failed at ${sharedQueue.capability.failure ?? 'an unknown step'}.`
        : 'The shared queue is configured but its authority source is unavailable.';
    return readinessBlocker(
      'shared-queue-authority-unavailable',
      'Shared queue authority unavailable',
      detail,
      'high',
      'queue',
    );
  }
  const readiness = status.autoMergeReadiness;
  if (!readiness) {
    return readinessBlocker(
      'auto-merge-readiness-unavailable',
      'Auto-merge status unavailable',
      status.proposals.authority?.detail ?? 'The auto-merge readiness source could not be read.',
      'high',
      'auto-merge',
    );
  }
  if (!readiness.enabled) {
    return readinessBlocker(
      'auto-merge-disabled',
      'Auto-merge disabled',
      'Autonomous shipping cannot drain proposals while auto-merge is disabled.',
      'high',
      'auto-merge',
    );
  }
  if (readiness.configurationBlocker) {
    return readinessBlocker(
      'auto-merge-configuration-invalid',
      'Auto-merge configuration invalid',
      readiness.configurationBlocker,
      'high',
      'auto-merge',
    );
  }
  if (
    readiness.remoteProtection &&
    !remoteProtectionAuthorityReady(readiness) &&
    (readiness.branchAuthorityReady ?? 0) === 0
  ) {
    return readinessBlocker(
      'protected-remote-unavailable',
      'Protected remote authority unavailable',
      readiness.remoteProtection.detail,
      'high',
      'auto-merge',
    );
  }
  if ((status.proposals.awaitingHostMerge ?? 0) > 0) {
    return readinessBlocker(
      'host-handoff',
      'Host PR handoff',
      `${status.proposals.awaitingHostMerge} proposal(s) are waiting for host merge reconciliation.`,
      'high',
      'auto-merge',
    );
  }
  if ((status.laneLocks?.unverifiedApplied ?? 0) > 0) {
    return readinessBlocker(
      'unverified-applied-work',
      'Applied work lacks verification',
      `${status.laneLocks!.unverifiedApplied} applied proposal(s) are recent or goal-linked but lack verification.`,
      'high',
      'lane-locks',
    );
  }
  const phantomAudit = phantomAuditSignalSummary(status.phantom?.agentReport);
  if (phantomAudit) {
    return readinessBlocker(
      'phantom-audit-risk',
      'Phantom audit needs review',
      phantomAudit.detail,
      'high',
      'phantom',
    );
  }
  if ((readiness.authorityReady ?? 0) > 0) {
    return null;
  }
  if ((readiness.authorityBlocked ?? 0) > 0) {
    const topReason = Object.entries(readiness.authorityByReason ?? {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return readinessBlocker(
      'merge-authority-incomplete',
      'Merge authority incomplete',
      topReason
        ? `${topReason[1]}x ${topReason[0]}`
        : `${readiness.authorityBlocked} proposal(s) lack complete authority evidence.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.needsVerification > 0) {
    return readinessBlocker(
      'verification-needed',
      'Verification needed',
      `${readiness.needsVerification} proposal(s) need verification before autonomous ship can proceed.`,
      'high',
      'auto-merge',
    );
  }
  if (readiness.knownVerificationFailed > 0) {
    return readinessBlocker(
      'verification-failed',
      'Verification failed',
      `${readiness.knownVerificationFailed} proposal(s) have known verification failures.`,
      'medium',
      'auto-merge',
    );
  }
  if (readiness.blocked > 0) {
    const topReason = Object.entries(readiness.byReason)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return readinessBlocker(
      'merge-gate-blocked',
      'Merge gate blocked',
      topReason ? `${topReason[1]}x ${topReason[0]}` : `${readiness.blocked} proposal(s) are blocked.`,
      'medium',
      'auto-merge',
    );
  }
  const queueSource = sources.find((source) => source.id === 'queue');
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    queueSource &&
    (queueSource.status === 'unknown' || queueSource.status === 'unavailable')
  ) {
    return readinessBlocker(
      'queue-source-unavailable',
      'Queue source unavailable',
      queueSource.detail,
      'medium',
      'queue',
    );
  }
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (status.queue.backlogItems > 0 && eligibleBacklogItems === 0 && status.proposals.pending === 0) {
    const routeBlocked = status.queue.repairRouteBlockedItems ?? 0;
    if (routeBlocked > 0) {
      const topReason = status.queue.generatedRepairRoutes?.byReason.find((entry) => entry.reason !== 'feasible');
      return readinessBlocker(
        'repair-route-unavailable',
        'Repair routes unavailable',
        `${routeBlocked} generated repair item(s) remain queued but cannot be claimed` +
          `${topReason ? `; top reason: ${topReason.reason} (${topReason.count})` : ''}.`,
        'medium',
        'queue',
      );
    }
    const repairBlocked = status.queue.repairControlBlockedItems ?? 0;
    if (repairBlocked > 0) {
      const unavailable = status.queue.repairLifecycleUnavailableItems ?? 0;
      const terminal = status.queue.repairTerminalItems ?? 0;
      const quarantined = status.queue.repairQuarantinedItems ?? 0;
      return readinessBlocker(
        'repair-lifecycle-control-blocked',
        'Repair lifecycle control blocked',
        `${repairBlocked} generated repair item(s) are withheld ` +
          `(${unavailable} lifecycle unavailable, ${terminal} terminal, ${quarantined} quarantined).`,
        'medium',
        'queue',
      );
    }
    const cooling = status.queue.cooldownItems ?? 0;
    const pending = status.queue.pendingItems ?? 0;
    const nextEligible = status.queue.nextEligibleAt ? ` Next eligible at ${status.queue.nextEligibleAt}.` : '';
    return readinessBlocker(
      'backlog-cooldown-gated',
      'Backlog cooling',
      `Backlog exists, but no items are currently daemon-eligible (${cooling} cooling, ${pending} already covered by pending proposals).${nextEligible}`,
      'medium',
      'queue',
    );
  }
  const resourceSource = sources.find((source) => source.id === 'resources');
  if (resourceSource?.status === 'blocked' || resourceSource?.status === 'unavailable') {
    return readinessBlocker(
      'resources-blocked',
      'Resources blocked',
      resourceSource.detail,
      'medium',
      'resources',
    );
  }
  if (eligibleBacklogItems > 0 && status.proposals.pending === 0) {
    return readinessBlocker(
      'proposal-production-needed',
      'Proposal production needed',
      'Backlog work is visible, but there are no pending proposals ready to ship.',
      'medium',
      'queue',
    );
  }
  return null;
}

function readinessConfidence(summary: Record<FleetReadinessSourceStatus, number>): FleetAutonomousShipReadinessConfidence {
  if (summary.unavailable > 0 || summary.unknown > 0) return 'low';
  if (summary.degraded > 0) return 'medium';
  return 'high';
}

function readinessVerdict(
  status: FleetStatus,
  summary: Record<FleetReadinessSourceStatus, number>,
  topBlocker: FleetAutonomousShipReadinessBlocker | null,
): FleetAutonomousShipReadinessVerdict {
  if (topBlocker && readinessPriorityRank(topBlocker.severity) <= readinessPriorityRank('high')) {
    return 'blocked';
  }
  if ((status.autoMergeReadiness?.authorityReady ?? 0) > 0) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'degraded' : 'ready';
  }
  if (
    status.queue.backlogItems === 0 &&
    status.proposals.pending === 0 &&
    (status.proposals.awaitingHostMerge ?? 0) === 0
  ) {
    return summary.degraded > 0 || summary.unavailable > 0 || summary.unknown > 0 ? 'unknown' : 'idle';
  }
  return 'degraded';
}

function buildAutonomousShipReadiness(
  status: FleetStatus,
  inputs: AutonomousShipReadinessInputs,
): FleetAutonomousShipReadinessStatus {
  const sources = shipReadinessSources(status, inputs);
  const sourceSummary = readinessSourceSummary(sources);
  const sourceQualitySummary = readinessSourceQualitySummary(sources);
  const evidenceSources = learningEvidenceReadinessSources(status, inputs.generatedAt);
  const evidenceSummary = readinessEvidenceSummary(evidenceSources);
  const requiredSources = evidenceSources.filter((source) => source.applicability === 'required');
  const evidenceState = evidenceSummary.withheld > 0 || requiredSources.some((source) => source.status === 'degraded')
    ? 'degraded'
    : evidenceSummary['cold-start'] > 0
      ? 'cold-start'
      : 'eligible';
  const topBlocker = chooseReadinessBlocker(status, sources);
  const nextActions = status.nextActions ?? [];
  const primaryAction =
    topBlocker?.id === 'phantom-audit-risk'
      ? nextActions.find((action) => action.id === 'review-phantom-audit') ?? nextActions[0] ?? null
      : topBlocker?.id === 'signed-evidence-degraded'
        ? nextActions.find((action) => action.id === 'inspect-signed-evidence') ?? nextActions[0] ?? null
      : topBlocker?.id === 'enrollment-registry-degraded'
        ? nextActions.find((action) => action.id === 'repair-enrollment-registry') ?? nextActions[0] ?? null
      : topBlocker?.id === 'auto-merge-disabled' && status.proposals.pending > 0
        ? nextActions.find((action) => action.id === 'inspect-pending-proposals') ?? nextActions[0] ?? null
      : nextActions[0] ?? null;
  return {
    verdict: readinessVerdict(status, sourceSummary, topBlocker),
    confidence: readinessConfidence(sourceSummary),
    freshness: readinessFreshnessSummary(inputs.generatedAt, sources),
    topBlocker,
    primaryAction,
    sources,
    sourceSummary,
    sourceQualitySummary,
    evidenceMatrix: {
      version: 1,
      state: evidenceState,
      sources: evidenceSources,
      summary: evidenceSummary,
    },
  };
}

function buildMissionBrief(status: FleetStatus): FleetMissionBrief {
  const readiness = status.autonomousShipReadiness ?? null;
  const effectiveness = status.autonomyEffectiveness ?? null;
  const action = readiness?.primaryAction ?? (status.nextActions ?? [])[0] ?? null;
  const blocker = readiness?.topBlocker ?? null;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  const preflightReady = status.autoMergeReadiness?.preflightReady ?? effectiveness?.counts.preflightReady ?? 0;
  const guardBlocked = status.guardHealth?.blocked ?? (status.guardHealth?.blocks?.length ?? 0) > 0;

  return {
    generatedAt: status.generatedAt,
    directive: missionDirective(status, action, effectiveness),
    confidence: readiness?.confidence ?? 'low',
    operatingMode: status.autonomyDirection?.mode ?? effectiveness?.phase ?? 'unknown',
    blocker,
    action,
    whyNow: missionWhyNow(status, blocker, action, effectiveness),
    evidence: {
      readinessVerdict: readiness?.verdict ?? null,
      effectivenessPhase: effectiveness?.phase ?? null,
      bottleneck: effectiveness?.bottleneck ?? null,
      queueBacklogItems: status.queue.backlogItems,
      eligibleBacklogItems,
      pendingProposals: status.proposals.pending,
      preflightReady,
      guardBlocked,
    },
  };
}

function missionDirective(
  status: FleetStatus,
  action: FleetNextAction | null,
  effectiveness: FleetAutonomyEffectivenessStatus | null,
): string {
  if (action?.id === 'repair-enrollment-registry') return 'Repair enrollment authority';
  if (action?.id === 'inspect-kill-switch-source') return 'Inspect kill switch authority';
  if (action?.id === 'inspect-daemon-state-source') return 'Inspect daemon state';
  if (action?.id === 'inspect-guard-health-source') return 'Inspect guard health';
  if (status.killed) return 'Clear the kill switch';
  if (action?.id === 'inspect-daemon-activation') return 'Inspect daemon activation authority';
  if (!status.daemon.running) return 'Start one proposal cycle';
  if (status.guardHealth?.blocked) return 'Repair the guard block';

  switch (action?.id) {
    case 'reconcile-host-prs':
      return 'Reconcile host PRs';
    case 'drain-ready-auto-merges':
      return 'Drain ready auto-merges';
    case 'verify-pending-proposals':
      return 'Verify pending proposals';
    case 'repair-verification-failures':
      return 'Drain failed proposal blockers';
    case 'inspect-auto-merge-blockers':
      return 'Inspect merge blockers';
    case 'review-phantom-audit':
      return 'Review Phantom audit';
    case 'repair-enrollment-registry':
      return 'Repair enrollment authority';
    case 'inspect-learning-evidence':
      return 'Diagnose withheld evidence';
    case 'build-backlog':
      return 'Build the highest-value backlog proposal';
    case 'cooldown-gated-backlog':
      return 'Review the backlog cooldown gate';
    case 'add-repo-verify-contracts':
      return 'Add missing repo verification contracts';
    case 'add-explicit-merge-verify-contracts':
      return 'Add explicit merge verification contracts';
  }

  switch (effectiveness?.phase) {
    case 'host-handoff':
      return 'Reconcile host PRs';
    case 'merge-ready':
      return 'Drain ready auto-merges';
    case 'verification-needed':
      return 'Verify pending proposals';
    case 'merge-blocked':
      return 'Inspect merge blockers';
    case 'proposal-starved':
      return 'Convert eligible backlog into proposals';
    case 'cooldown-gated':
      return 'Wait for backlog eligibility';
    case 'idle':
      return status.merges.recent > 0 ? 'Refill the backlog after recent merges' : 'Discover high-value backlog work';
    case 'control-blocked':
      return 'Restore autonomous control';
  }

  return 'Refresh fleet status and backlog';
}

function missionWhyNow(
  status: FleetStatus,
  blocker: FleetAutonomousShipReadinessBlocker | null,
  action: FleetNextAction | null,
  effectiveness: FleetAutonomyEffectivenessStatus | null,
): string {
  if (action?.id === 'review-phantom-audit' && action.detail) return action.detail;
  if (blocker?.detail) return blocker.detail;
  if (effectiveness?.summary) return effectiveness.summary;
  if (action?.detail) return action.detail;
  const eligibleBacklogItems = status.queue.eligibleBacklogItems ?? status.queue.backlogItems;
  if (eligibleBacklogItems > 0) {
    return `${eligibleBacklogItems} eligible backlog item(s) are visible.`;
  }
  return 'No higher-confidence autonomous action is visible in the current snapshot.';
}

async function buildAutoMergeReadinessStatus(
  cfg: AshlrConfig,
  pendingProposals: Proposal[],
  enrolledRepos: string[],
  enrollmentRegistry: { state: 'ready' } | { state: 'degraded'; reason: string },
): Promise<FleetAutoMergeReadinessStatus> {
  const autoMerge = cfg.foundry?.autoMerge;
  const enabled = autoMerge?.enabled === true;
  const trustBasis: AutoMergeTrustBasis =
    autoMerge?.trustBasis === 'verification' || autoMerge?.trustBasis === 'evidence'
      ? autoMerge.trustBasis
      : 'tier';
  const rawTrustBasis = autoMerge?.trustBasis;
  const rawMaxRisk = (autoMerge as Record<string, unknown> | undefined)?.['maxRisk'];
  const trustBasisBlocker =
    rawTrustBasis !== undefined &&
    rawTrustBasis !== 'tier' &&
    rawTrustBasis !== 'verification' &&
    rawTrustBasis !== 'evidence'
      ? `invalid auto-merge trustBasis '${String(rawTrustBasis)}'`
      : undefined;
  const maxRiskBlocker = rawMaxRisk !== undefined &&
    rawMaxRisk !== 'low' && rawMaxRisk !== 'medium' && rawMaxRisk !== 'high'
    ? `invalid auto-merge maxRisk '${String(rawMaxRisk)}'`
    : undefined;
  const configurationBlocker = trustBasisBlocker ?? maxRiskBlocker;
  const maxRisk = rawMaxRisk === 'medium' || rawMaxRisk === 'high' ? rawMaxRisk : 'low';

  const byReason: Record<string, number> = {};
  const recentBlockers: FleetAutoMergeBlockerSummary[] = [];
  let preflightReady = 0;
  let branchAuthorityReady = 0;
  let remoteMainAuthorityReady = 0;
  let authorityBlocked = 0;
  const authorityByReason: Record<string, number> = {};
  let needsVerification = 0;
  let knownVerificationFailed = 0;
  let blocked = 0;
  const verifierContracts: FleetAutoMergeVerifierContractStatus = {
    pendingNeedingVerification: 0,
    withoutVerifyCommands: 0,
    withoutExplicitMergeContract: 0,
    recentGaps: [],
  };
  const profileCache = new Map<string, ReturnType<typeof detectRepoExecutionProfile> | null>();

  const {
    classifyRisk,
    evaluateBranchAuthority,
    evaluateAutoMergeReadinessPreflight,
    evaluateEvidenceRemoteProtectionSignal,
    evaluateLiveProtectedRemoteAuthority,
    evaluateMergeAuthority,
    explainAutoMergeGate,
    mergeTargetForTier,
    resolveRemoteBranchHead,
  } = await import('../inbox/merge.js');
  const { hashDiff } = await import('../foundry/provenance.js');
  const riskOrder: Record<string, number> = { low: 0, medium: 1, high: 2 };
  const remoteProtectionSignal = evaluateEvidenceRemoteProtectionSignal(cfg);
  const remoteMainProposals = pendingProposals.filter((proposal) =>
    trustBasis !== 'tier' || mergeTargetForTier(proposal.engineTier) === 'main');
  const remoteMainRepos = new Set(
    (pendingProposals.length === 0 ? enrolledRepos : remoteMainProposals.map((proposal) => proposal.repo))
      .filter((repo): repo is string => typeof repo === 'string' && repo.length > 0)
      .map((repo) => resolve(repo)),
  );
  const remoteDeliveryEnabled = enabled && autoMerge?.pushToRemote === true;
  const remoteProtectionRequired = remoteDeliveryEnabled && (
    pendingProposals.length === 0 || remoteMainProposals.length > 0
  );
  const remoteProtection: FleetAutoMergeReadinessStatus['remoteProtection'] = {
    required: remoteProtectionRequired,
    configured: remoteProtectionSignal.expectationMode,
    live: 'unobserved',
    coverage: 'unscoped',
    observedAt: null,
    reposObserved: 0,
    reposRequired: remoteMainRepos.size,
    detail: remoteProtectionRequired
      ? remoteProtectionSignal.ok
        ? 'protected remote configuration is exact, but fleetwide live protection has not been observed'
        : `protected remote configuration is not authoritative: ${remoteProtectionSignal.detail}`
      : 'protected remote authority is not required because remote main delivery is disabled',
  };
  if (enrollmentRegistry.state === 'degraded') {
    const reason = `enrollment authority degraded: ${enrollmentRegistry.reason}`;
    const withheld = pendingProposals.length;
    remoteProtection.detail = `${reason}; protected remote authority is withheld`;
    return {
      enabled,
      trustBasis,
      pending: withheld,
      preflightReady: 0,
      authorityReady: 0,
      branchAuthorityReady: 0,
      remoteMainAuthorityReady: 0,
      authorityBlocked: withheld,
      authorityByReason: withheld > 0 ? { [reason]: withheld } : {},
      needsVerification: 0,
      knownVerificationFailed: 0,
      blocked: withheld,
      byReason: withheld > 0 ? { [reason]: withheld } : {},
      recentBlockers: pendingProposals.slice(0, 8).map((proposal) => ({
        proposalId: proposal.id,
        title: proposal.title,
        tier: proposal.engineTier ?? null,
        reason,
        riskClass: null,
      })),
      verifierContracts,
      ...(configurationBlocker ? { configurationBlocker } : {}),
      remoteProtection,
    };
  }
  if (remoteProtectionRequired && remoteProtectionSignal.ok && remoteMainRepos.size > 0) {
    const targets = new Map<string, {
      repo: string;
      bindings: Map<string, { branch: string; baseHead: string | null }>;
    }>();
    for (const repo of remoteMainRepos) {
      targets.set(repo, { repo, bindings: new Map() });
    }
    for (const proposal of remoteMainProposals) {
      const repo = proposal.repo;
      const branch = proposal.verifyResult?.baseBranch;
      const baseHead = proposal.verifyResult?.baseHead;
      if (!repo || !branch || !baseHead) continue;
      const target = targets.get(resolve(repo));
      target?.bindings.set(`${branch}\0${baseHead}`, { branch, baseHead });
    }
    if (pendingProposals.length === 0) {
      for (const repo of enrolledRepos) {
        const branch = defaultBranch(repo);
        targets.get(resolve(repo))?.bindings.set(branch, {
          branch,
          baseHead: resolveRemoteBranchHead(repo, branch),
        });
      }
    }
    const boundedTargets = [...targets.values()].slice(0, MAX_REMOTE_PROTECTION_STATUS_REPOS);
    const observations: Array<Awaited<ReturnType<typeof evaluateLiveProtectedRemoteAuthority>>> = [];
    for (let offset = 0; offset < boundedTargets.length; offset += 4) {
      const batch = boundedTargets.slice(offset, offset + 4);
      observations.push(...await Promise.all(batch.map((target) => {
        const bindings = [...target.bindings.values()];
        if (bindings.length !== 1) {
          return Promise.resolve({
            authorized: false as const,
            reason: bindings.length === 0
              ? `protected remote base binding unavailable for ${basename(target.repo)}`
              : `conflicting protected remote base bindings for ${basename(target.repo)}`,
          });
        }
        const binding = bindings[0]!;
        return binding.baseHead
          ? evaluateLiveProtectedRemoteAuthority(target.repo, binding.branch, binding.baseHead, cfg)
          : Promise.resolve({
              authorized: false as const,
              reason: `protected remote base head unavailable for ${basename(target.repo)}:${binding.branch}`,
            });
      })));
    }
    remoteProtection.reposObserved = observations.length;
    remoteProtection.coverage =
      targets.size === remoteMainRepos.size && observations.length === remoteMainRepos.size
        ? 'complete'
        : observations.length > 0
          ? 'partial'
          : 'unscoped';
    const failures = observations.filter((observation) => !observation.authorized);
    if (failures.length > 0) {
      remoteProtection.live = failures.some((failure) => failure.reason.includes('unavailable'))
        ? 'unavailable'
        : 'unprotected';
      remoteProtection.detail = failures[0]!.reason;
    } else if (observations.length > 0) {
      remoteProtection.live = 'protected';
      remoteProtection.observedAt = observations
        .map((observation) => observation.authorized ? observation.evidence.observedAt : '')
        .filter(Boolean)
        .sort()
        .at(0) ?? null;
      const observedMs = remoteProtection.observedAt ? Date.parse(remoteProtection.observedAt) : NaN;
      if (!Number.isFinite(observedMs) || Date.now() - observedMs > READINESS_REMOTE_PROTECTION_STALE_MS) {
        remoteProtection.live = 'unavailable';
        remoteProtection.detail = 'live protected-remote observation is missing or stale';
      } else {
        remoteProtection.detail = remoteProtection.coverage === 'complete'
          ? `live protected-remote authority confirmed for ${observations.length} remote main target(s)`
          : `live protection confirmed for ${observations.length}/${remoteMainRepos.size} remote main target(s)`;
      }
    }
  }

  const noteBlocker = (proposal: Proposal, reason: string, riskClass: string | null): void => {
    blocked++;
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (recentBlockers.length < 8) {
      recentBlockers.push({
        proposalId: proposal.id,
        title: proposal.title,
        tier: proposal.engineTier ?? null,
        reason,
        riskClass,
      });
    }
  };
  const noteAuthorityBlocker = (reason: string): void => {
    authorityBlocked++;
    authorityByReason[reason] = (authorityByReason[reason] ?? 0) + 1;
  };
  const profileForRepo = (repo: string): ReturnType<typeof detectRepoExecutionProfile> | null => {
    const key = resolve(repo);
    if (profileCache.has(key)) return profileCache.get(key) ?? null;
    try {
      const profile = detectRepoExecutionProfile(repo);
      profileCache.set(key, profile);
      return profile;
    } catch {
      profileCache.set(key, null);
      return null;
    }
  };
  const noteVerifierContractGap = (proposal: Proposal): void => {
    if (trustBasis !== 'verification' && trustBasis !== 'evidence') return;
    if (!proposal.repo) return;
    verifierContracts.pendingNeedingVerification++;
    const profile = profileForRepo(proposal.repo);
    const withoutVerifyCommands = !profile || profile.verifyCommands.length === 0;
    const withoutExplicitMergeContract = profile?.verifyContract?.mergeGradeExplicit !== true ||
      profile.verifyContractSource !== 'tracked-clean';
    if (!withoutVerifyCommands && !withoutExplicitMergeContract) return;
    if (withoutVerifyCommands) verifierContracts.withoutVerifyCommands++;
    if (withoutExplicitMergeContract) verifierContracts.withoutExplicitMergeContract++;
    if (verifierContracts.recentGaps.length < 8) {
      verifierContracts.recentGaps.push({
        proposalId: proposal.id,
        title: proposal.title,
        repo: proposal.repo,
        name: basename(proposal.repo),
        withoutVerifyCommands,
        withoutExplicitMergeContract,
        reason:
          profile?.noVerifyReason ??
          (profile?.verifyContract?.mergeGradeExplicit && profile.verifyContractSource !== 'tracked-clean'
            ? `ashlr.verify.json is ${profile.verifyContractSource}; merge contract must be tracked-clean`
            : profile?.verifyContract?.mergeGradeReason) ??
          'missing explicit merge-profile verification contract',
      });
    }
  };

  for (const proposal of pendingProposals) {
    let riskClass: string | null = null;

    if (!enabled) {
      noteBlocker(proposal, 'auto-merge disabled', riskClass);
      continue;
    }
    if (proposal.kind !== 'patch' && proposal.kind !== 'pr') {
      noteBlocker(proposal, `proposal kind '${proposal.kind}' is not mergeable`, riskClass);
      continue;
    }
    if (!proposal.diff?.trim()) {
      noteBlocker(proposal, 'proposal has no diff', riskClass);
      continue;
    }
    if (!proposal.repo) {
      noteBlocker(proposal, 'proposal has no repo', riskClass);
      continue;
    }
    if (proposal.verifyResult?.passed === false) {
      knownVerificationFailed++;
      const failed = proposal.verifyResult.failed?.filter(Boolean).join('; ');
      noteBlocker(
        proposal,
        failed ? `known verification failure: ${failed}` : 'known verification failure',
        riskClass,
      );
      continue;
    }

    const readiness = evaluateAutoMergeReadinessPreflight(proposal, cfg);
    if (!readiness.ready) {
      noteBlocker(proposal, readiness.reason ?? 'not ready for auto-merge', riskClass);
      continue;
    }

    if (trustBasis === 'tier') {
      const target = mergeTargetForTier(proposal.engineTier);
      const authority =
        target === 'main'
          ? evaluateMergeAuthority(proposal, cfg)
          : target === 'branch'
            ? evaluateBranchAuthority(proposal, cfg)
            : { authorized: false, reason: `engineTier '${proposal.engineTier ?? 'unset'}' is proposal-only` };
      if (!authority.authorized) {
        noteBlocker(proposal, `merge authority denied: ${authority.reason}`, riskClass);
        continue;
      }
    }

    if (!proposal.engineModel) {
      noteBlocker(proposal, 'provenance check failed: missing engineModel', riskClass);
      continue;
    }
    if (!proposal.engineTier) {
      noteBlocker(proposal, 'provenance check failed: missing engineTier', riskClass);
      continue;
    }
    if (!proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: missing diffHash', riskClass);
      continue;
    }
    if (!proposal.provenanceSig) {
      noteBlocker(proposal, 'provenance check failed: missing provenanceSig', riskClass);
      continue;
    }
    if (hashDiff(proposal.diff) !== proposal.diffHash) {
      noteBlocker(proposal, 'provenance check failed: diff hash mismatch', riskClass);
      continue;
    }

    riskClass = classifyRisk(proposal);
    if ((riskOrder[riskClass] ?? Number.POSITIVE_INFINITY) > (riskOrder[maxRisk] ?? 0)) {
      noteBlocker(proposal, `risk class '${riskClass}' exceeds maxRisk '${maxRisk}'`, riskClass);
      continue;
    }

    if (trustBasis === 'verification' && proposal.verifyResult?.passed !== true) {
      noteVerifierContractGap(proposal);
      needsVerification++;
      continue;
    }

    if (trustBasis === 'evidence') {
      const verify = proposal.verifyResult;
      const hasBaseBinding =
        verify?.passed === true &&
        typeof verify.baseBranch === 'string' &&
        verify.baseBranch.length > 0 &&
        typeof verify.baseHead === 'string' &&
        verify.baseHead.length > 0;
      const hasCurrentDiffBinding =
        hasBaseBinding &&
        typeof verify.diffHash === 'string' &&
        verify.diffHash === hashDiff(proposal.diff);
      if (!hasCurrentDiffBinding) {
        noteVerifierContractGap(proposal);
        needsVerification++;
        continue;
      }
    }

    preflightReady++;

    if (trustBasis === 'tier') {
      if (mergeTargetForTier(proposal.engineTier) === 'branch') branchAuthorityReady++;
      else remoteMainAuthorityReady++;
      continue;
    }

    if (trustBasis === 'evidence') {
      noteAuthorityBlocker('fresh isolated verification is required by the mutating evidence-mode gate');
      continue;
    }

    const proposalCreatedMs = Date.parse(proposal.createdAt);
    const decisionsRead = readDecisionsDetailed({
      proposalId: proposal.id,
      ...(Number.isFinite(proposalCreatedMs) ? { sinceMs: proposalCreatedMs - 60_000 } : {}),
    });
    if (decisionsRead.sourceState === 'degraded' || !decisionsRead.complete) {
      noteAuthorityBlocker('decisions ledger source is degraded or incomplete');
      continue;
    }
    const authority = explainAutoMergeGate(proposal, cfg, {
      decisionsForProposal: decisionsRead.decisions,
    });
    if (!authority.mergeable) {
      noteAuthorityBlocker(authority.reason);
      continue;
    }
    remoteMainAuthorityReady++;
  }

  const remoteMainReady = remoteProtectionAuthorityReady({
    enabled,
    trustBasis,
    pending: pendingProposals.length,
    preflightReady,
    needsVerification,
    knownVerificationFailed,
    blocked,
    byReason,
    recentBlockers,
    remoteProtection,
  });
  if (!remoteMainReady && remoteMainAuthorityReady > 0) {
    const reason = remoteProtection?.detail ?? 'protected remote authority is unavailable';
    authorityBlocked += remoteMainAuthorityReady;
    authorityByReason[reason] = (authorityByReason[reason] ?? 0) + remoteMainAuthorityReady;
  }
  const authorityReady = branchAuthorityReady + (remoteMainReady ? remoteMainAuthorityReady : 0);

  return {
    enabled,
    trustBasis,
    pending: pendingProposals.length,
    preflightReady,
    authorityReady,
    branchAuthorityReady,
    remoteMainAuthorityReady,
    authorityBlocked,
    authorityByReason,
    needsVerification,
    knownVerificationFailed,
    blocked,
    byReason,
    recentBlockers,
    verifierContracts,
    ...(configurationBlocker ? { configurationBlocker } : {}),
    remoteProtection,
  };
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
      detail: 'skipped in fleet status summary; run `ashlr fleet direction` for full report',
    }],
    repos: [],
  };
}

function buildAutonomyDirectionSummary(report: ResourceStrategyReport): FleetAutonomyDirectionSummary {
  return {
    generatedAt: report.generatedAt,
    mode: report.mode,
    confidence: report.confidence,
    reasons: report.reasons.slice(0, 3),
    recommendedActions: report.recommendedActions.slice(0, 3),
    resources: {
      posture: report.resources.posture,
      constrained: report.resources.constrained,
      depleted: report.resources.depleted,
    },
    guardHealth: {
      blocked: report.guardHealth.blocked,
      blocks: report.guardHealth.blocks.length,
    },
    budgets: {
      daemonBudgetLevel: report.budgets.daemonBudgetLevel,
      daemonSpentTodayUsd: report.budgets.daemonSpentTodayUsd,
    },
    productionVelocity: report.productionVelocity,
  };
}

function buildAutonomyStatus(
  packs: AutonomyEvidencePack[],
  sourceQuality: AutonomyEvidenceSourceQuality,
): FleetAutonomyStatus {
  const byTier: Record<string, number> = {};
  let allowed = 0;
  let denied = 0;
  let latestAt: string | null = null;
  let sealedV3 = 0;

  for (const pack of packs) {
    if (pack.version === 3) sealedV3++;
    if (latestAt === null || Date.parse(pack.generatedAt) > Date.parse(latestAt)) {
      latestAt = pack.generatedAt;
    }
    const tier = pack.policy?.tier ?? 'unknown';
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    if (pack.policy?.allowed === true) allowed++;
    else if (pack.policy?.allowed === false) denied++;
  }

  return {
    evidencePacks: packs.length,
    latestAt,
    allowed,
    denied,
    byTier,
    authorityState: sourceQuality.sourceState === 'missing'
      ? 'cold-start'
      : sourceQuality.sourceState === 'healthy' && sourceQuality.complete
        ? 'ready'
        : 'degraded',
    protocols: { sealedV3, legacy: packs.length - sealedV3 },
    sourceQuality: { ...sourceQuality },
    recent: packs.slice(0, 8).map((pack) => ({
      proposalId: pack.proposal.id,
      generatedAt: pack.generatedAt,
      title: pack.proposal.title,
      tier: pack.policy?.tier ?? null,
      action: pack.policy?.action ?? null,
      allowed: pack.policy?.allowed ?? null,
      target: pack.target,
      riskClass: pack.riskClass,
      verificationPassed: pack.verification.passed,
      changedFiles: pack.diff.files.length,
      changedLines: pack.diff.changedLines,
      reason: pack.policy?.reason ?? null,
    })),
  };
}

async function buildSharedQueueStatus(cfg: AshlrConfig): Promise<FleetSharedQueueStatus | undefined> {
  const sq = cfg.fleet?.sharedQueue;
  if (sq?.mode !== 'filesystem' || !sq.path || sq.path.trim().length === 0) {
    return undefined;
  }

  const path = sq.path;
  const machineId = sq.machineId && sq.machineId.trim().length > 0 ? sq.machineId : hostname();
  const leaseMs =
    typeof sq.leaseMs === 'number' && Number.isFinite(sq.leaseMs) && sq.leaseMs > 0
      ? Math.floor(sq.leaseMs)
      : 5 * 60 * 1000;
  const cooldownMs = configCooldownMs(cfg);
  const trustedCoherentStorage = sq.trustedCoherentStorage === true;

  try {
    const { SharedStore } = await import('./shared-store.js');
    const store = new SharedStore(path, leaseMs);
    const health = store.readHealth({ machineId, ...(cooldownMs !== undefined ? { cooldownMs } : {}) });
    return {
      enabled: true,
      mode: 'filesystem',
      machineId,
      ...health,
      trustedCoherentStorage,
      authorityReady: trustedCoherentStorage && health.capability.verified && health.readable &&
        health.lock.recoveryRequired === false,
    };
  } catch {
    return {
      enabled: true,
      mode: 'filesystem',
      path,
      machineId,
      leaseMs,
      readable: false,
      capability: {
        scope: 'local-primitives-only',
        durabilityPolicy: process.platform === 'win32'
          ? 'windows-file-fsync-atomic-rename'
          : 'posix-file-and-directory-fsync',
        checked: false,
        verified: false,
        failure: 'status-unavailable',
      },
      trustedCoherentStorage,
      authorityReady: false,
      activeClaims: 0,
      ownedClaims: 0,
      expiredClaims: 0,
      reclaimableClaims: 0,
      executingClaims: 0,
      ambiguousClaims: 0,
      claimsByMachine: [],
      claimSamples: [],
      nextLeaseExpiryAt: null,
      oldestExpiredMs: null,
      workedEvents: 0,
      cooldownItems: 0,
      usageEntries: 0,
      lock: { present: false, ageMs: null, stale: false, links: null, recoveryRequired: false },
    };
  }
}

function compactStatusMetadata(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}

async function buildActiveWorkStatus(): Promise<FleetActiveWorkStatus | undefined> {
  try {
    const { readDaemonSpendGuard } = await import('../daemon/state.js');
    const result = readDaemonSpendGuard();
    if (!result.exists) return undefined;

    const guard = result.guard;
    const armedMs = guard?.armedAt ? Date.parse(guard.armedAt) : NaN;
    const ageMs = Number.isFinite(armedMs) ? Math.max(0, Date.now() - armedMs) : null;
    const itemIds = Array.isArray(guard?.itemIds)
      ? guard.itemIds
          .filter((itemId): itemId is string => typeof itemId === 'string' && itemId.length > 0)
          .map((itemId) => compactStatusMetadata(itemId))
      : [];

    return {
      source: 'daemon-spend-guard',
      path: result.path,
      exists: true,
      malformed: result.malformed,
      pid: typeof guard?.pid === 'number' ? guard.pid : null,
      hostname: typeof guard?.hostname === 'string' ? compactStatusMetadata(guard.hostname, 120) : null,
      armedAt: typeof guard?.armedAt === 'string' ? guard.armedAt : null,
      ageMs,
      itemCount: itemIds.length,
      itemIds: itemIds.slice(0, 12),
      ...(result.error ? { error: compactStatusMetadata(result.error, 240) } : {}),
    };
  } catch {
    return undefined;
  }
}

function buildRepoExecutionCoverage(enrolledRepos: ReadonlySet<string>): NonNullable<FleetQueueRepoCoverage['executionProfiles']> {
  let reposWithProjects = 0;
  let reposWithVerifyCommands = 0;
  let reposWithVerifyContracts = 0;
  let reposWithValidVerifyContracts = 0;
  let reposWithExplicitMergeContracts = 0;
  const packageManagers = new Map<RepoPackageManager, Set<string>>();
  const missingVerifyCommands: NonNullable<NonNullable<FleetQueueRepoCoverage['executionProfiles']>['missingVerifyCommands']> = [];
  const missingExplicitMergeContracts: NonNullable<NonNullable<FleetQueueRepoCoverage['executionProfiles']>['missingExplicitMergeContracts']> = [];

  for (const repo of enrolledRepos) {
    try {
      const profile = detectRepoExecutionProfile(repo);
      if (profile.projects.length > 0) reposWithProjects++;
      const projectKinds = [...new Set(profile.projects.map((project) => project.kind))].sort();
      if (profile.verifyCommands.length > 0) reposWithVerifyCommands++;
      else {
        missingVerifyCommands.push({
          repo,
          name: basename(repo),
          projectKinds,
          reason: profile.noVerifyReason ?? 'no detected verify commands',
        });
      }
      if (profile.verifyContract?.present) reposWithVerifyContracts++;
      if (profile.verifyContract?.valid) reposWithValidVerifyContracts++;
      if (profile.verifyContract?.mergeGradeExplicit && profile.verifyContractSource === 'tracked-clean') {
        reposWithExplicitMergeContracts++;
      }
      else {
        missingExplicitMergeContracts.push({
          repo,
          name: basename(repo),
          projectKinds,
          reason: profile.verifyContract?.mergeGradeExplicit
            ? `ashlr.verify.json is ${profile.verifyContractSource}; merge contract must be tracked-clean`
            : profile.verifyContract?.mergeGradeReason ?? 'missing ashlr.verify.json merge-profile contract',
        });
      }
      for (const project of profile.projects) {
        const repos = packageManagers.get(project.packageManager) ?? new Set<string>();
        repos.add(repo);
        packageManagers.set(project.packageManager, repos);
      }
    } catch {
      // Read-only observability only; a broken profile scan should not hide queue status.
      missingVerifyCommands.push({
        repo,
        name: basename(repo),
        projectKinds: [],
        reason: 'repo execution profile detection failed',
      });
      missingExplicitMergeContracts.push({
        repo,
        name: basename(repo),
        projectKinds: [],
        reason: 'repo execution profile detection failed',
      });
    }
  }

  const result: NonNullable<FleetQueueRepoCoverage['executionProfiles']> = {
    reposWithProjects,
    reposWithVerifyCommands,
    reposMissingVerifyCommands: Math.max(0, enrolledRepos.size - reposWithVerifyCommands),
    reposWithVerifyContracts,
    reposWithValidVerifyContracts,
    reposWithExplicitMergeContracts,
    reposMissingExplicitMergeContracts: Math.max(0, enrolledRepos.size - reposWithExplicitMergeContracts),
    packageManagers: [...packageManagers.entries()]
      .map(([manager, repos]) => ({ manager, repos: repos.size }))
      .sort((a, b) => b.repos - a.repos || a.manager.localeCompare(b.manager)),
  };
  if (missingVerifyCommands.length > 0) {
    result.missingVerifyCommands = missingVerifyCommands.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (missingExplicitMergeContracts.length > 0) {
    result.missingExplicitMergeContracts = missingExplicitMergeContracts.sort((a, b) => a.name.localeCompare(b.name));
  }
  return result;
}

function configCooldownMs(cfg: AshlrConfig): number | undefined {
  const daemon = (cfg as { daemon?: Record<string, unknown> }).daemon;
  const value = daemon?.['cooldownMs'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function commandShell(argv: string[]): string {
  return argv.map((part) => {
    if (/^[A-Za-z0-9_./:=@+-]+$/.test(part)) return part;
    return `'${part.replace(/'/g, `'\\''`)}'`;
  }).join(' ');
}

function nextActionCommand(
  label: string,
  argv: string[],
  safety: FleetNextActionCommandSafety,
  extras: Omit<FleetNextActionCommand, 'label' | 'argv' | 'shell' | 'safety'> = {},
): FleetNextActionCommand {
  return {
    label,
    argv,
    shell: commandShell(argv),
    safety,
    ...extras,
  };
}

/**
 * Sum `tick.backends[backend]` across recent ticks (within RECENT_WINDOW_MS).
 * Pure fallback for when the quota ledger is unavailable.
 */
function sumRecentBackend(
  ticks: Array<{ ts?: string; backends?: Record<string, number> }>,
  backend: EngineId,
): number {
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  let sum = 0;
  for (const t of ticks) {
    const n = t.backends?.[backend];
    if (typeof n !== 'number' || n <= 0) continue;
    const ts = t.ts ? Date.parse(t.ts) : NaN;
    if (Number.isNaN(ts) || ts >= cutoff) sum += n;
  }
  return sum;
}
