/**
 * api/types.ts — the PUBLIC type surface of @ashlr/hub (M33).
 *
 * Curated re-exports only: everything here is part of the published contract
 * (`import type { … } from '@ashlr/hub/types'`). Internals stay unexported —
 * add types deliberately, never wholesale.
 */

export type {
  // Config + index
  AshlrConfig,
  AshlrIndex,
  IndexedItem,
  ItemKind,
  GitStatus,
  // Runs + swarms
  RunState,
  RunTask,
  RunUsage,
  RunBudget,
  RunOptions,
  RunEstimate,
  PercentileTriple,
  SwarmRun,
  SwarmPlan,
  // Genome
  GenomeEntry,
  RecallHit,
  LearnInput,
  // Portfolio intelligence
  Backlog,
  WorkItem,
  WorkSource,
  HealthScore,
  HealthReport,
  HealthDimensionScore,
  HealthScoreError,
  ClampedHealthScore,
  AskResult,
  ImpactResult,
  KnowledgeGraph,
  // Approval inbox + audit
  Proposal,
  ProposalKind,
  ProposalStatus,
  ApplyResult,
  AuditEntry,
  // Observability
  ActivityRollup,
  // Dashboard + web
  DashboardSnapshot,
  WebServerOptions,
  // M31 agent-native surface
  OrientResult,
  NativeToolDef,
  NativeToolSafety,
  // Notifications
  NotifyTarget,
} from '../core/types.js';

export type {
  SeamId,
  SeamImpl,
  SeamCloud,
  SeamStatus,
  SeamRegistry,
} from '../core/seams/types.js';

export type {
  ExternalSkillAuditEntry,
  ExternalSkillAuditIssue,
  ExternalSkillAuditIssueCode,
  ExternalSkillCollision,
  ExternalSkillAuditReport,
  ExternalSkillPromotionBlocker,
} from '../core/fleet/external-skill-audit.js';

export type {
  ExternalSkillTrialArm,
  ExternalSkillTrialArmProgress,
  ExternalSkillTrialCaseInput,
  ExternalSkillTrialEffect,
  ExternalSkillTrialEvaluation,
  ExternalSkillTrialEvaluationBlocker,
  ExternalSkillTrialEvaluationInput,
  ExternalSkillTrialOutcomeInput,
  ExternalSkillTrialOutcomeReceipt,
  ExternalSkillTrialPairAssignment,
  ExternalSkillTrialPlan,
  ExternalSkillTrialPlanInput,
  ExternalSkillTrialRunAssignment,
} from '../core/fleet/external-skill-shadow-eval.js';

export type {
  ExternalSkillGitCaptureInput,
  ExternalSkillGitCaptureOptions,
  ExternalSkillGitCaptureReason,
  ExternalSkillGitCaptureResult,
} from '../core/fleet/external-skill-git-capture.js';

export type {
  ExternalSkillCustodyAttestation,
  ExternalSkillCustodyAttestationInput,
  ExternalSkillCustodyAttestationReason,
  ExternalSkillCustodyAttestationResult,
  ExternalSkillCustodyAttestationUnsigned,
  ExternalSkillCustodyTrustKey,
  ExternalSkillCustodyTrustPolicy,
} from '../core/fleet/external-skill-custody-attestation.js';

export type {
  SkillRoutingCalibrationCollisionsV1,
  SkillRoutingCalibrationReasonV1,
  SkillRoutingCalibrationRoutingV1,
  SkillRoutingCalibrationSampleV1,
  SkillRoutingCalibrationV1,
} from '../core/fleet/skill-routing-calibration.js';

export type {
  ExternalSkillAuditReceipt,
  ExternalSkillAuditReceiptInput,
  ExternalSkillAuditReceiptReason,
  ExternalSkillAuditReceiptUnsigned,
  ExternalSkillAuditReceiptVerificationResult,
} from '../core/fleet/external-skill-audit-receipt.js';

export type {
  ExternalSkillAuditTrustPolicy,
  ExternalSkillAuditTrustRoot,
} from '../core/fleet/external-skill-audit-trust-roots.js';

export type {
  ExternalSkillMaturityAuditEvidenceV1,
  ExternalSkillMaturityAuditSignalV1,
  ExternalSkillMaturityBlockerV1,
  ExternalSkillMaturityProjectionInputV1,
  ExternalSkillMaturityProjectionV1,
  ExternalSkillMaturityRoutingEvidenceV1,
  ExternalSkillMaturityRoutingSignalV1,
  ExternalSkillMaturityStageV1,
  ExternalSkillMaturityStateV1,
} from '../core/fleet/external-skill-maturity.js';

export type {
  InspectProductionActivationReadinessInputV1,
  ProductionActivationReadinessBlockerCodeV1,
  ProductionActivationReadinessBlockerV1,
  ProductionActivationReadinessV1,
  ProductionArtifactPackagingObservationV1,
  ProductionReleaseTipObservationV1,
  ProductionResidentServiceObservationV1,
  ReleaseTipProjectionInputV1,
  ResidentServiceDiagnosticProjectionInputV1,
} from '../core/daemon/production-activation-readiness.js';

export type {
  EvaluateSkillRetrievalCalibrationInputV1,
  SkillRetrievalCalibrationAuditBindingV1,
  SkillRetrievalCalibrationAuditEvidenceV1,
  SkillRetrievalCalibrationCandidateV1,
  SkillRetrievalCalibrationCaseV1,
  SkillRetrievalCalibrationProjectionV1,
  SkillRetrievalCalibrationReasonV1,
  SkillRetrievalCalibrationRoutingV1,
  SkillRetrievalCalibrationSampleV1,
  SkillRetrievalCalibrationSnapshotV1,
} from '../core/fleet/skill-retrieval-calibration.js';

export type {
  ExternalSkillArtifactClassV1,
  ExternalSkillArtifactClassCountV1,
  ExternalSkillArtifactFirewallReasonV1,
  ExternalSkillArtifactFirewallResultV1,
} from '../core/fleet/external-skill-artifact-firewall.js';
