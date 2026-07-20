/**
 * dispatch-production-ledger.ts — append-only proposal-production outcome stream.
 *
 * Writes metadata-only rows to ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl
 * (or $ASHLR_HOME/dispatch-production). This is history/analytics, not the
 * cooldown ledger: never truncate, never rewrite, never throw.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type {
  DaemonDispatchProductionOutcome,
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  ProductionAttemptShape,
  RepairTreatment,
  RunActionCounts,
  RouteSnapshot,
  RunEventSummary,
  WorkItem,
} from '../types.js';
import {
  causalMetadata,
  routeSnapshot as normalizeRouteSnapshot,
  runEventSummary as normalizeRunEventSummary,
} from '../learning/causal.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import {
  addProductionAttemptShape,
  classifyProductionAttemptForLearningWithLabel,
  emptyProductionAttemptShape,
  generatedRepairAttemptKindFromSignals,
  hasProductionAttemptShape,
  productionAttemptLearningLabelFromSignals,
  sanitizeProductionAttemptLearningLabel,
  type GeneratedRepairAttemptKind,
  type ProductionAttemptLearningClassification,
  type ProductionAttemptLearningLabel,
} from '../learning/attempt-shape.js';
import { scrubSecrets } from '../util/scrub.js';
import { fsyncDirectory } from '../util/durability.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import {
  generatedRepairLifecycleAttemptHash,
  REPAIR_TREATMENTS,
  repairGenerationIdFromHandoffId,
  repairTreatmentForUnitId,
} from './generated-repair-identity.js';
import {
  assureStableRegularFiles,
  openStableDirectoryGuard,
  readStableRegularFile,
  type StableFileBatchAssurance,
  type StableFileBatchAssuranceResult,
  type StableFileReadFailureReason,
} from '../util/stable-file-read.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 2_000;
const DEFAULT_READ_MAX_FILES = 31;
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 10_000;
const HARD_READ_MAX_FILES = 32;
const HARD_READ_MAX_BYTES = 32 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 50_000;
const HARD_ATTEMPT_PROOF_TARGETS = 256;
const MAX_LOOSE_FILES = 3;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_READ_ROW_BYTES = 128 * 1024;
const MAX_ATTEMPT_FUTURE_SKEW_MS = 60_000;
const ATTEMPT_PROOF_RECEIPT_DIR = 'repair-attempt-proofs';
const MAX_ATTEMPT_PROOF_RECEIPTS = 2_048;
const MAX_ATTEMPT_ACTIVE_GENERATIONS = MAX_ATTEMPT_PROOF_RECEIPTS + 1;
const ATTEMPT_BLOCKED_MEMBERSHIP_BITS = 1_048_576;
const ATTEMPT_BLOCKED_MEMBERSHIP_BYTES = ATTEMPT_BLOCKED_MEMBERSHIP_BITS / 8;
const ATTEMPT_BLOCKED_MEMBERSHIP_HASHES = 7;
const MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS = 4;
const MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE = 1e-7;
const MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE =
  MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS * MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE;
const MAX_ATTEMPT_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPT_RECEIPT_DIR_ENTRIES = MAX_ATTEMPT_PROOF_RECEIPTS + 16;
const MAX_STALE_ATTEMPT_RECEIPT_STAGES = 16;
const MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES =
  MAX_ATTEMPT_RECEIPT_DIR_ENTRIES + MAX_STALE_ATTEMPT_RECEIPT_STAGES;
const ATTEMPT_RECEIPT_RETENTION_FILE = '.retention.json';
const MAX_ATTEMPT_RECEIPT_RETENTION_BYTES = 256 * 1024;
const ATTEMPT_RETENTION_ARTIFACT_SET_DIGEST_DOMAIN =
  'ashlr:dispatch-attempt-retention-artifact-set:v1\0';
const ATTEMPT_RECEIPT_PROTOCOL_FILE = '.protocol.json';
const ATTEMPT_RECEIPT_VALIDATION = 'bounded-raw-history-v1';
const MAX_TREATMENT_OUTCOME_RECEIPTS = 2_048;
const MAX_TREATMENT_RECEIPT_DIR_ENTRIES = MAX_TREATMENT_OUTCOME_RECEIPTS + 16;
const TREATMENT_RECEIPT_RETENTION_FILE = '.retention.json';
const MAX_TREATMENT_RECEIPT_RETENTION_BYTES = 512 * 1024;
const MAX_TREATMENT_RECEIPT_TOMBSTONES = 2_048;
const MAX_TREATMENT_RECEIPT_BYTES = 16 * 1024;
const MAX_TREATMENT_RECEIPT_AGGREGATE_BYTES = 4 * 1024 * 1024;
const TREATMENT_RECEIPT_PROTOCOL_FILE = '.protocol.json';
const MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES = 4 * 1024;
const TREATMENT_RECEIPT_COMPACTED_DIR = '.retired-exact';
const MAX_TREATMENT_COMPACTED_MARKER_BYTES = 512;
const MAX_TREATMENT_COMPACTED_MARKERS = HARD_READ_MAX_ROWS;
const MAX_TREATMENT_COMPACTED_MARKER_AGGREGATE_BYTES = HARD_READ_MAX_BYTES;
const MAX_ATTEMPT_FAILURE_RECEIPT_BYTES = 16 * 1024;
const MAX_ATTEMPT_FAILURE_RECEIPT_AGGREGATE_BYTES =
  MAX_ATTEMPT_PROOF_RECEIPTS * MAX_ATTEMPT_FAILURE_RECEIPT_BYTES;
const TREATMENT_RECEIPT_DIGEST_DOMAIN = 'ashlr:dispatch-treatment-outcome-receipt:v1\0';
const TREATMENT_RETENTION_DIGEST_DOMAIN = 'ashlr:dispatch-treatment-retention:v1\0';
const TREATMENT_RETENTION_COMPACTION_DOMAIN = 'ashlr:dispatch-treatment-retention-compaction:v1\0';
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ATTEMPT_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([12])\.json$/;
const ATTEMPT_RECEIPT_INTENT_FILE_RE = /^([a-f0-9]{64})-([12])\.intent\.json$/;
const ATTEMPT_FAILURE_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([12])-([a-f0-9]{64})\.failure\.json$/;
const ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE = /^([a-f0-9]{64})-([12])-([a-f0-9]{64})\.failure\.intent\.json$/;
const TREATMENT_RECEIPT_FILE_RE = /^([a-f0-9]{64})-([a-f0-9]{64})\.json$/;
const ATTEMPT_RECEIPT_STAGE_FILE_RE = /^(?:[a-f0-9]{64}-[12](?:-[a-f0-9]{64}\.failure)?\.(?:json|intent\.json)|\.(?:retention|protocol)\.json)(?:\.\d+\.tmp|\.[a-f0-9]{32}\.stage)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MAX_SELECTION_CANDIDATES = 64;
const MAX_SELECTION_VERSION = 80;
const SELECTION_CANDIDATE_DIGEST_DOMAIN = 'ashlr:selection-candidate-set:v1\0';
const SELECTION_ASSIGNMENT_DIGEST_DOMAIN = 'ashlr:selection-assignment:v1\0';
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);
const WORK_SOURCES = new Set<WorkItem['source']>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint',
  'goal', 'hygiene', 'invent',
]);
const DISPATCH_PRODUCTION_OUTCOMES = new Set<DaemonDispatchProductionOutcome>([
  'proposal-created', 'cancelled', 'empty-diff', 'gate-blocked', 'engine-failed',
  'sandbox-failed', 'proposal-capture-error', 'proposal-disabled', 'unknown',
]);
const DISPATCH_PRODUCTION_BASES = new Set<DispatchProductionBasis>([
  'run-proposal-outcome', 'pending-proposal-delta', 'best-of-n-summary',
  'repair-lifecycle-candidate', 'repair-lifecycle-outcome', 'unknown',
]);
const DISPATCH_PRODUCTION_EVENT_KEYS = new Set([
  'schemaVersion', 'ts', 'machineId', 'itemId', 'source', 'repo', 'title', 'backend',
  'tier', 'model', 'assignedBy', 'routeReason', 'outcome', 'proposalCreated',
  'proposalId', 'runId', 'trajectoryId', 'routeSnapshot', 'runEventSummary',
  'evidenceOutcome', 'learningSource', 'labelBasis', 'routerPolicyVersion',
  'learningEpoch', 'selectionObservation', 'objectiveHash', 'learningLabel', 'spentUsd', 'diffFiles',
  'diffLines', 'reason', 'basis', 'repairHandoffId', 'repairGenerationId',
  'repairTreatmentUnitId', 'repairTreatment', 'repairTreatmentOutcome',
  'repairTreatmentAttemptHash', 'repairAttemptOrdinal', 'repairPreviousBackend',
  'repairRootId', 'repairDepth', 'repairLineageInvalid',
]);
const ATTEMPT_RECEIPT_FAILURE_OUTCOMES = new Set<DaemonDispatchProductionOutcome>([
  'engine-failed', 'sandbox-failed', 'proposal-capture-error', 'gate-blocked',
]);
const MIN_REPAIR_TREATMENT_ATTEMPTS = 3;

export type DispatchProductionBasis =
  | 'run-proposal-outcome'
  | 'pending-proposal-delta'
  | 'best-of-n-summary'
  | 'repair-lifecycle-candidate'
  | 'repair-lifecycle-outcome'
  | 'unknown';

/**
 * Metadata-only record of a pre-execution randomized assignment. This is an
 * analytic commitment, never routing or merge authority.
 */
export interface DispatchSelectionObservationV1 {
  schemaVersion: 1;
  authority: 'observation-only';
  mode: 'randomized-canary';
  selectionPolicyVersion: string;
  randomizationProtocolVersion: string;
  candidateSetDigest: string;
  assignmentDigest: string;
  candidateCount: number;
  selectedRank: number;
  selectionProbabilityPpm: number;
  selectedBackend: EngineId;
  selectedTier: EngineTier;
  selectedModel?: string | null;
}

export interface DispatchSelectionCandidate {
  backend: EngineId;
  tier: EngineTier;
  model?: string | null;
}

export interface CreateDispatchSelectionObservationInput {
  candidates: readonly DispatchSelectionCandidate[];
  selected: DispatchSelectionCandidate;
  selectionPolicyVersion: string;
  randomizationProtocolVersion: string;
  selectionProbabilityPpm: number;
  trajectoryId: string;
  runId: string;
  objectiveHash: string;
  routerPolicyVersion: string;
  learningEpoch: string;
}

export interface DispatchProductionEvent {
  schemaVersion: 1;
  ts: string;
  machineId?: string;
  itemId: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId | null;
  tier: EngineTier | null;
  model?: string | null;
  assignedBy: string;
  routeReason: string;
  outcome: DaemonDispatchProductionOutcome;
  proposalCreated: boolean;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  selectionObservation?: DispatchSelectionObservationV1;
  /** Scrubbed metadata-only hash of the dispatched work item's objective. */
  objectiveHash?: string;
  learningLabel?: ProductionAttemptLearningLabel;
  spentUsd: number;
  diffFiles?: number;
  diffLines?: number;
  reason?: string;
  basis: DispatchProductionBasis;
  /** Metadata-only exact lineage for journal-authorized diagnostic repair dispatches. */
  repairHandoffId?: string;
  repairGenerationId?: string;
  repairTreatmentUnitId?: string;
  repairTreatment?: RepairTreatment;
  /** Terminal outcome emitted only after the local lifecycle store commits it. */
  repairTreatmentOutcome?: 'converted' | 'not-converted';
  repairTreatmentAttemptHash?: string;
  repairAttemptOrdinal?: 1 | 2;
  repairPreviousBackend?: EngineId;
  /** Exact generated-repair reservation root identity for immutable failure receipts. */
  repairRootId?: string;
  repairDepth?: 0 | 1;
  repairLineageInvalid?: true;
}

export interface ReadDispatchProductionEventsOptions {
  sinceMs?: number;
  limit?: number;
  /** Maximum dated partitions. Loose legacy partitions retain their separate fixed cap. */
  maxFiles?: number;
  /** Aggregate bytes physically read across selected partitions. */
  maxBytes?: number;
  /** Aggregate physical rows examined, including blank and invalid rows. */
  maxRows?: number;
}

export interface DispatchProductionParentIdentity {
  ts: string;
  itemId: string;
  repo: string;
  outcome: string;
  attemptId: string;
  source?: WorkItem['source'];
  backend?: EngineId | null;
  tier?: EngineTier | null;
  objectiveHash?: string;
}

export type DispatchProductionParentStatus = 'found' | 'missing' | 'degraded';

export interface DispatchProductionAttemptProofTarget {
  ts: string;
  /** Inclusive bounded scan start for generation-wide conflict detection. */
  sequenceStartTs?: string;
  /** Inclusive bounded scan end; lifecycle uses a cutoff captured under the generation fence. */
  sequenceEndTs?: string;
  itemId: string;
  repo: string;
  source: WorkItem['source'];
  outcome: 'empty-diff' | 'proposal-created';
  /** Required exactly for proposal-created targets and forbidden for empty-diff targets. */
  proposalId?: string;
  objectiveHash: string;
  repairHandoffId: string;
  repairGenerationId: string;
  repairTreatmentUnitId: string;
  repairTreatment: RepairTreatment;
  repairAttemptOrdinal: 1 | 2;
}

export interface DispatchProductionAttemptProof {
  schemaVersion: 1;
  integrityClass: 'owner-writable-local';
  cryptographicallyTrusted: false;
  rollbackProtected: false;
  eventTs: string;
  eventDigest: string;
  attemptHash: string;
  backend: Exclude<EngineId, 'builtin'>;
  tier: EngineTier;
  model: string | null;
  previousBackend: Exclude<EngineId, 'builtin'> | null;
  repairHandoffId: string;
  repairGenerationId: string;
  repairTreatmentUnitId: string;
  repairTreatment: RepairTreatment;
  repairAttemptOrdinal: 1 | 2;
}

export interface DispatchProductionFailureAttemptProof extends
  Omit<DispatchProductionAttemptProof, 'repairTreatmentUnitId' | 'repairTreatment'> {
  repairTreatmentUnitId?: string;
  repairTreatment?: RepairTreatment;
}

export interface DispatchProductionFailureAttemptReceiptTarget {
  repairGenerationId: string;
  repairAttemptOrdinal: 1 | 2;
  attemptHash: string;
}

export type DispatchProductionFailureAttemptReceiptResolution =
  | { status: 'proven'; proof: DispatchProductionFailureAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'receipt-missing' | 'receipt-uncommitted' }
  | { status: 'unproven'; reason: 'target-mismatch' | 'event-ineligible' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionFailureAttemptReceiptBatchResolution =
  | { status: 'resolved'; authoritative: boolean; receipts: Array<{
      proof: DispatchProductionFailureAttemptProof;
      event: DispatchProductionEvent;
    }> }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptProofDegradedReason =
  | 'target-invalid'
  | 'target-limit'
  | 'date-limit'
  | 'source-unavailable'
  | 'source-unsafe'
  | 'source-mutated'
  | 'partition-unreadable'
  | 'partition-byte-limit'
  | 'partition-row-limit'
  | 'partition-invalid'
  | 'partition-conflict'
  | 'retirement-membership-saturated';

export interface DispatchProductionWriteResult {
  attempted: number;
  recorded: number;
  failed: number;
  failureReasons?: Array<'retirement-membership-saturated'>;
}

export interface DispatchProductionAttemptProtocolQuality {
  status: 'healthy' | 'saturated' | 'degraded';
  segmentCount: number;
  estimatedFalsePositiveRate: number;
  maxFalsePositiveRate: number;
}

export type DispatchProductionAttemptProofResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof }
  | { status: 'missing'; reason: 'partition-missing' | 'event-missing' }
  | { status: 'unproven'; reason: 'event-ineligible' | 'target-mismatch' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptProofBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptProofResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionAttemptWitnessResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | Exclude<DispatchProductionAttemptProofResolution, { status: 'proven' }>;

export type DispatchProductionAttemptWitnessBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptWitnessResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export interface DispatchProductionAttemptReceiptWitnessTarget {
  repairGenerationId: string;
  repairAttemptOrdinal: 1 | 2;
}

export type DispatchProductionAttemptReceiptWitnessResolution =
  | { status: 'proven'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'receipt-missing' | 'receipt-uncommitted' }
  | { status: 'unproven'; reason: 'event-ineligible' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptReceiptWitnessBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptReceiptWitnessResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionAttemptReceiptAvailabilityResolution =
  | { status: 'available'; proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'missing'; reason: 'raw-append-missing' }
  | { status: 'missing'; reason: 'receipt-missing-after-append';
      proof: DispatchProductionAttemptProof; event: DispatchProductionEvent }
  | { status: 'unproven'; reason: 'event-ineligible' | 'target-mismatch' |
      'attempt-sequence-missing' | 'attempt-sequence-mismatch' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

export type DispatchProductionAttemptReceiptAvailabilityBatchResolution =
  | { status: 'resolved'; resolutions: DispatchProductionAttemptReceiptAvailabilityResolution[] }
  | { status: 'degraded'; reason: 'target-limit' };

export type DispatchProductionReadStopReason =
  | 'event-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error';

export interface DispatchProductionSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: DispatchProductionReadStopReason[];
  filesRead: number;
  datedFilesRead: number;
  looseFilesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface DispatchProductionEventsReadResult extends DispatchProductionSourceQuality {
  events: DispatchProductionEvent[];
}

export interface DispatchProductionYieldReadResult {
  summary?: DispatchProductionYieldSummary;
  sourceQuality: DispatchProductionSourceQuality;
  /**
   * Completeness-aware randomized assignment observation state for status only.
   * A ledger event alone cannot qualify an observation: a future receipt join
   * must bind it to pre-execution authority before it can be reported present.
   */
  selectionObservationState?: 'no-dispatches' | 'not-observed' | 'unjoined';
}

export interface DispatchProductionReasonCount {
  reason: string;
  count: number;
}

export interface DispatchProductionOutcomeCounts {
  proposalCreated: number;
  emptyDiff: number;
  gateBlocked: number;
  engineFailed: number;
  /** Optional for compatibility with callers that construct legacy count fixtures. */
  cancelled?: number;
  sandboxFailed: number;
  proposalCaptureError: number;
  proposalDisabled: number;
  unknown: number;
}

export interface GeneratedRepairAttemptSummary {
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  captureRepairs: number;
  diagnosticReslices: number;
  proposalRepairs: number;
  /** Explicit event/unit attribution quality; never inferred from conversion output. */
  treatmentAttribution?: RepairTreatmentAttributionSummary;
  /** Per-treatment conversion is withheld until each arm has a bounded minimum sample. */
  treatmentConversions?: RepairTreatmentConversionSummary[];
}

export interface RepairTreatmentAttributionSummary {
  eligibleEvents: number;
  attributedEvents: number;
  unattributedEvents: number;
  distinctUnits: number;
  replayedEvents: number;
  minimumTerminalUnitsPerArm: 3;
  arms: RepairTreatmentAttributionArmSummary[];
  gate: 'collecting' | 'ready' | 'withheld';
  blockers: RepairTreatmentAttributionBlocker[];
}

export interface RepairTreatmentAttributionArmSummary {
  repairTreatment: RepairTreatment;
  attributedUnits: number;
  terminalUnits: number;
  remaining: number;
}

export type RepairTreatmentAttributionBlocker =
  | 'in-flight'
  | 'unmatched-terminal'
  | 'unattributed'
  | 'replayed'
  | 'source-incomplete';

export interface RepairTreatmentConversionSummary {
  repairTreatment: RepairTreatment;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
}

export interface GeneratedRepairBackendTransitionBucket {
  previousBackend: EngineId;
  retryBackend: EngineId;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  outcomes: DispatchProductionOutcomeCounts;
}

export interface GeneratedRepairBackendTransitionSummary {
  sourceState: 'healthy' | 'degraded';
  lineageEvents: number;
  transitionEvents: number;
  attempts: number;
  duplicateEvents: number;
  conflictingAttempts: number;
  invalidLineageEvents: number;
  byTransition: GeneratedRepairBackendTransitionBucket[];
}

export interface DispatchProductionYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  /** Optional for compatibility with summaries persisted before diagnostic accounting. */
  diagnosticAttempts?: number;
  diagnosticNoProposal?: number;
  diagnosticProposalRate?: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
}

export interface DispatchProductionYieldSummary {
  windowHours: number;
  attempts: number;
  events: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  /** Optional for compatibility with summaries persisted before diagnostic accounting. */
  diagnosticAttempts?: number;
  diagnosticNoProposal?: number;
  diagnosticProposalRate?: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  generatedRepairBackendTransitions?: GeneratedRepairBackendTransitionSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
  byBackend: DispatchProductionYieldBucket[];
  bySource: DispatchProductionYieldBucket[];
  byRepo: DispatchProductionYieldBucket[];
  byBackendModel: DispatchProductionYieldBucket[];
  byBackendSource: DispatchProductionYieldBucket[];
}

export function dispatchProductionDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'dispatch-production');
}

interface DispatchProductionWriteRoot {
  path: string;
  realPath: string;
  identity: Stats;
  fd?: number;
}

const dispatchProductionWriteRoots: DispatchProductionWriteRoot[] = [];

function assertStableDispatchProductionWriteRoot(): DispatchProductionWriteRoot {
  const expected = dispatchProductionWriteRoots.at(-1);
  if (!expected) throw new Error('dispatch production write root unavailable');
  const named = lstatSync(expected.path);
  if (!safeDispatchProductionDirectory(named) || !sameFile(expected.identity, named) ||
    realpathSync(expected.path) !== expected.realPath) {
    throw new Error('dispatch production write root changed');
  }
  if (expected.fd !== undefined) {
    const opened = fstatSync(expected.fd);
    if (!safeDispatchProductionDirectory(opened) || !sameFile(expected.identity, opened)) {
      throw new Error('dispatch production write root changed');
    }
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    expected.path, 'directory', 'inspect-owned', { anchorPath: dirname(expected.path) },
  ).ok) throw new Error('unsafe Windows dispatch production root');
  return expected;
}

function openDispatchProductionWriteRoot(): DispatchProductionWriteRoot {
  const path = dispatchProductionDir();
  const parent = dirname(path);
  let created = false;
  let fd: number | undefined;
  try {
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: false, mode: 0o700 });
      created = true;
    }
    const before = lstatSync(path);
    if (!safeDispatchProductionDirectory(before)) {
      throw new Error('unsafe dispatch production write root');
    }
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'directory', created ? 'secure-created' : 'inspect-owned', { anchorPath: parent },
    ).ok) throw new Error('unsafe Windows dispatch production root');
    const identity = lstatSync(path);
    const realParent = realpathSync(parent);
    const realPath = realpathSync(path);
    if (!safeDispatchProductionDirectory(identity) || !sameFile(before, identity) ||
      dirname(realPath) !== realParent || basename(realPath) !== basename(path)) {
      throw new Error('unsafe dispatch production write root');
    }
    if (process.platform !== 'win32') {
      const directoryOnly = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
      fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | directoryOnly);
      const opened = fstatSync(fd);
      if (!safeDispatchProductionDirectory(opened) || !sameFile(identity, opened)) {
        throw new Error('dispatch production write root changed');
      }
    }
    if (created) fsyncDirectory(parent);
    return { path, realPath, identity, ...(fd === undefined ? {} : { fd }) };
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    throw error;
  }
}

/**
 * Execute one metadata-store write while the dispatch-production root remains
 * identity-pinned. Receipt stores use this instead of reimplementing a second
 * private-root authority model.
 */
export function withStableDispatchProductionWriteRoot<T>(consume: () => T): T {
  if (dispatchProductionWriteRoots.length > 0) {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  }
  const root = openDispatchProductionWriteRoot();
  dispatchProductionWriteRoots.push(root);
  try {
    assertStableDispatchProductionWriteRoot();
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return value;
  } finally {
    dispatchProductionWriteRoots.pop();
    if (root.fd !== undefined) { try { closeSync(root.fd); } catch { /* best effort */ } }
  }
}

function treatmentOutcomeReceiptDir(): string {
  return join(dispatchProductionDir(), 'repair-treatment-outcomes');
}

function attemptProofReceiptDir(): string {
  return join(dispatchProductionDir(), ATTEMPT_PROOF_RECEIPT_DIR);
}

function attemptProofReceiptName(generationId: string, ordinal: 1 | 2): string {
  return `${generationId}-${ordinal}.json`;
}

function attemptFailureReceiptName(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return `${generationId}-${ordinal}-${attemptHash}.failure.json`;
}

function attemptReceiptLockPath(): string {
  return join(attemptProofReceiptDir(), '.receipts.lock');
}

function ensurePrivateReceiptDirectory(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: false, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!safeDispatchProductionDirectory(dirStat)) throw new Error('unsafe receipt directory');
  chmodSync(dir, 0o700);
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    dir, 'directory', created ? 'secure-created' : 'inspect-existing', {
      anchorPath: dispatchProductionDir(),
    },
  ).ok) throw new Error('unsafe Windows receipt directory');
  if (created) fsyncDirectory(dirname(dir));
  assertStableDispatchProductionWriteRoot();
}

/** Ensure a private receipt subdirectory beneath the pinned production root. */
export function ensurePrivateDispatchProductionReceiptDirectory(dir: string): void {
  ensurePrivateReceiptDirectory(dir);
}

function secureCreatedReceiptTempFile(path: string): void {
  assertStableDispatchProductionWriteRoot();
  if (!/(?:\.\d+\.tmp|\.[a-f0-9]{32}\.stage)$/.test(basename(path))) {
    throw new Error('receipt secure-created target is not a new temp');
  }
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'secure-created', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt file');
}

function inspectExactReceiptAuthorityFile(path: string): void {
  if (dispatchProductionWriteRoots.length > 0) assertStableDispatchProductionWriteRoot();
  if (process.platform === 'win32' && !assurePrivateStoragePath(
    path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  ).ok) throw new Error('unsafe Windows receipt authority file');
}

/** Re-check an existing production receipt leaf before it becomes authority. */
export function inspectExactDispatchProductionReceiptFile(path: string): void {
  inspectExactReceiptAuthorityFile(path);
}

class ReceiptDirectoryAuthorityError extends Error {
  constructor(readonly reason: string) {
    super(`unsafe Windows receipt authority directory: ${reason}`);
  }
}

const UNSAFE_RECEIPT_DIRECTORY_REASONS = new Set([
  'anchor-not-reached', 'dacl-not-protected', 'deny-ace', 'inherited-ace',
  'missing-or-duplicate-principal', 'reparse-ancestor', 'reparse-point',
  'unexpected-ace-count', 'untrusted-ancestor-delete', 'untrusted-ancestor-owner',
  'untrusted-item-write', 'wrong-flags', 'wrong-kind', 'wrong-owner', 'wrong-rights',
]);

function inspectExactReceiptAuthorityDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  const assurance = assurePrivateStoragePath(
    path, 'directory', 'inspect-existing', { anchorPath: dispatchProductionDir() },
  );
  if (!assurance.ok) throw new ReceiptDirectoryAuthorityError(assurance.reason);
}

function treatmentOutcomeReceiptName(event: DispatchProductionEvent): string | null {
  if (
    event.basis !== 'repair-lifecycle-outcome' ||
    !event.repairGenerationId || !SHA256_RE.test(event.repairGenerationId) ||
    !event.repairTreatmentAttemptHash || !SHA256_RE.test(event.repairTreatmentAttemptHash)
  ) return null;
  return `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`;
}

interface TreatmentReceiptTombstone {
  name: string;
  receiptDigest: string;
}

interface TreatmentReceiptRetentionState {
  schemaVersion: 1 | 2 | 3;
  droppedThrough: string;
  retirementEpoch: number;
  previousRetentionDigest: string | null;
  compactedDigest: string;
  compactedCount: number;
  tombstones: TreatmentReceiptTombstone[];
}

interface TreatmentReceiptProtocolState {
  schemaVersion: 1;
  retirementEpoch: number;
  retentionDigest: string | null;
}

interface TreatmentCompactedReceiptMarker extends TreatmentReceiptTombstone {
  schemaVersion: 1;
}

interface TreatmentReceiptAuthorityState {
  retention: TreatmentReceiptRetentionState | null;
  compactedMarkers: Map<string, TreatmentCompactedReceiptMarker>;
  observedCompactedMarkers: Map<string, TreatmentCompactedReceiptMarker>;
  pendingCompaction: boolean;
}

function treatmentOutcomeReceiptDigest(
  name: string,
  event: DispatchProductionEvent,
): string {
  return createHash('sha256')
    .update(TREATMENT_RECEIPT_DIGEST_DOMAIN, 'utf8')
    .update(name, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(event), 'utf8')
    .digest('hex');
}

function emptyTreatmentRetentionCompactedDigest(): string {
  return createHash('sha256').update(TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8').digest('hex');
}

function treatmentReceiptRetentionDigest(state: TreatmentReceiptRetentionState): string {
  return createHash('sha256')
    .update(TREATMENT_RETENTION_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(state), 'utf8')
    .digest('hex');
}

function compactTreatmentReceiptTombstones(
  priorDigest: string,
  tombstones: readonly TreatmentReceiptTombstone[],
): string {
  let digest = priorDigest;
  const ordered = [...tombstones].sort((left, right) => left.name.localeCompare(right.name));
  for (const tombstone of ordered) {
    digest = createHash('sha256')
      .update(TREATMENT_RETENTION_COMPACTION_DOMAIN, 'utf8')
      .update(digest, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.name, 'utf8')
      .update('\0', 'utf8')
      .update(tombstone.receiptDigest, 'utf8')
      .digest('hex');
  }
  return digest;
}

function treatmentReceiptProtocolPath(): string {
  return join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_PROTOCOL_FILE);
}

function treatmentCompactedReceiptDir(): string {
  return join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_COMPACTED_DIR);
}

function treatmentCompactedReceiptPath(name: string): string {
  if (!TREATMENT_RECEIPT_FILE_RE.test(name)) throw new Error('invalid compacted treatment receipt name');
  return join(treatmentCompactedReceiptDir(), name);
}

function readCompactedTreatmentReceiptMarker(
  name: string,
  batchAssurance?: StableFileBatchAssurance,
): TreatmentCompactedReceiptMarker | null {
  const dir = treatmentCompactedReceiptDir();
  const path = treatmentCompactedReceiptPath(name);
  if (!existsSync(path)) return null;
  if (!batchAssurance) inspectExactReceiptAuthorityDirectory(dir);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_COMPACTED_MARKER_BYTES,
    remainingBytes: MAX_TREATMENT_COMPACTED_MARKER_BYTES,
    batchAssurance,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid compacted treatment receipt marker');
  }
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
    'schemaVersion', 'name', 'receiptDigest',
  ])) || parsed['schemaVersion'] !== 1 || parsed['name'] !== name ||
    typeof parsed['receiptDigest'] !== 'string' || !SHA256_RE.test(parsed['receiptDigest']) ||
    `${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid compacted treatment receipt marker');
  }
  return {
    schemaVersion: 1,
    name,
    receiptDigest: parsed['receiptDigest'],
  };
}

function readCompactedTreatmentReceiptMarkerSet(): TreatmentCompactedReceiptMarker[] {
  const dir = treatmentCompactedReceiptDir();
  if (!existsSync(dir)) return [];
  inspectExactReceiptAuthorityDirectory(dir);
  const guard = openStableDirectoryGuard(dir, { anchorPath: dispatchProductionDir() });
  if (!guard.ok) throw new Error('unsafe compacted treatment receipt marker directory');
  let finished = false;
  try {
    const names: string[] = [];
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_TREATMENT_COMPACTED_MARKERS) {
          throw new Error('compacted treatment receipt marker directory limit');
        }
        if (!TREATMENT_RECEIPT_FILE_RE.test(entry.name)) {
          throw new Error('unexpected compacted treatment receipt marker entry');
        }
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    names.sort((left, right) => left.localeCompare(right));
    if (names.some((name, index) => index > 0 && names[index - 1] === name)) {
      throw new Error('duplicate compacted treatment receipt marker');
    }
    let aggregateBytes = 0;
    for (const name of names) {
      const stat = lstatSync(join(dir, name));
      if (!safeDispatchProductionFile(stat) || stat.size < 2 ||
        stat.size > MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
        throw new Error('unsafe compacted treatment receipt marker');
      }
      aggregateBytes += stat.size;
      if (aggregateBytes > MAX_TREATMENT_COMPACTED_MARKER_AGGREGATE_BYTES) {
        throw new Error('compacted treatment receipt marker aggregate byte limit');
      }
    }
    const markers: TreatmentCompactedReceiptMarker[] = [];
    for (let offset = 0; offset < names.length; offset += 512) {
      const batchNames = names.slice(offset, offset + 512);
      const paths = batchNames.map((name) => join(dir, name));
      const assurance = assureRetentionFiles(paths, dispatchProductionDir());
      if (!assurance.ok) throw new Error('unsafe compacted treatment receipt marker batch');
      for (let index = 0; index < batchNames.length; index++) {
        const marker = readCompactedTreatmentReceiptMarker(
          batchNames[index]!, assurance.token,
        );
        if (marker === null) throw new Error('missing compacted treatment receipt marker');
        markers.push(marker);
      }
    }
    const guardFailure = guard.finish();
    finished = true;
    if (guardFailure !== null) {
      throw new Error('compacted treatment receipt marker directory changed');
    }
    return markers;
  } finally {
    if (!finished) guard.finish();
  }
}

function treatmentCompactedMarkerAggregate(
  markers: readonly TreatmentCompactedReceiptMarker[],
): { count: number; digest: string } {
  if (markers.length > MAX_TREATMENT_COMPACTED_MARKERS) {
    throw new Error('compacted treatment receipt marker count limit');
  }
  return {
    count: markers.length,
    digest: compactTreatmentReceiptTombstones(
      emptyTreatmentRetentionCompactedDigest(), markers,
    ),
  };
}

function validateCommittedTreatmentCompactedMarkers(
  retention: TreatmentReceiptRetentionState | null,
  markers: readonly TreatmentCompactedReceiptMarker[],
): Map<string, TreatmentCompactedReceiptMarker> {
  const aggregate = treatmentCompactedMarkerAggregate(markers);
  const expectedCount = retention?.compactedCount ?? 0;
  const expectedDigest = retention?.compactedDigest ?? emptyTreatmentRetentionCompactedDigest();
  if (aggregate.count !== expectedCount || aggregate.digest !== expectedDigest) {
    throw new Error('compacted treatment receipt marker aggregate mismatch');
  }
  const byName = new Map<string, TreatmentCompactedReceiptMarker>();
  const looseByName = new Map((retention?.tombstones ?? []).map((value) => [value.name, value]));
  for (const marker of markers) {
    if (byName.has(marker.name)) {
      throw new Error('duplicate compacted treatment receipt marker');
    }
    const loose = looseByName.get(marker.name);
    if (loose) {
      throw new Error(loose.receiptDigest === marker.receiptDigest
        ? 'duplicate treatment receipt retirement marker'
        : 'conflicting treatment receipt retirement marker');
    }
    byName.set(marker.name, marker);
  }
  return byName;
}

function writeCompactedTreatmentReceiptMarkers(
  tombstones: readonly TreatmentReceiptTombstone[],
): void {
  if (tombstones.length === 0) return;
  for (const tombstone of tombstones) {
    const existing = readCompactedTreatmentReceiptMarker(tombstone.name);
    if (existing && existing.receiptDigest !== tombstone.receiptDigest) {
      throw new Error('conflicting compacted treatment receipt marker');
    }
    const marker: TreatmentCompactedReceiptMarker = { schemaVersion: 1, ...tombstone };
    if (Buffer.byteLength(`${JSON.stringify(marker)}\n`, 'utf8') >
      MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
      throw new Error('compacted treatment receipt marker too large');
    }
  }
  const dir = treatmentCompactedReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  let installed = false;
  for (const tombstone of tombstones) {
    const path = treatmentCompactedReceiptPath(tombstone.name);
    const existing = readCompactedTreatmentReceiptMarker(tombstone.name);
    if (existing) {
      if (existing.receiptDigest !== tombstone.receiptDigest) {
        throw new Error('conflicting compacted treatment receipt marker');
      }
      continue;
    }
    const marker: TreatmentCompactedReceiptMarker = { schemaVersion: 1, ...tombstone };
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    if (bytes.length > MAX_TREATMENT_COMPACTED_MARKER_BYTES) {
      throw new Error('compacted treatment receipt marker too large');
    }
    const tmp = attemptReceiptStagePath(path);
    let fd: number | undefined;
    try {
      fd = openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      if (writeSync(fd, bytes) !== bytes.length) {
        throw new Error('short compacted treatment receipt marker write');
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      secureCreatedReceiptTempFile(tmp);
      assertStableDispatchProductionWriteRoot();
      renameSync(tmp, path);
      inspectExactReceiptAuthorityFile(path);
      installed = true;
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
      cleanupDispatchProductionWriteTemp(tmp);
    }
  }
  if (installed) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

function readRawTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  const path = join(treatmentOutcomeReceiptDir(), TREATMENT_RECEIPT_RETENTION_FILE);
  if (!existsSync(path)) return null;
  inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_RETENTION_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_RETENTION_BYTES,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid treatment receipt retention marker');
  }
  inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (`${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const droppedThrough = isPlainRecord(parsed)
    ? canonicalUtcTimestamp(parsed['droppedThrough'])
    : null;
  if (!isPlainRecord(parsed) || droppedThrough === null) {
    throw new Error('invalid treatment receipt retention marker');
  }
  if (parsed['schemaVersion'] === 1) {
    if (!hasOnlyKeys(parsed, new Set(['schemaVersion', 'droppedThrough']))) {
      throw new Error('invalid treatment receipt retention marker');
    }
    return {
      schemaVersion: 1,
      droppedThrough,
      retirementEpoch: 0,
      previousRetentionDigest: null,
      compactedDigest: emptyTreatmentRetentionCompactedDigest(),
      compactedCount: 0,
      tombstones: [],
    };
  }
  const schemaVersion = parsed['schemaVersion'];
  const keys = schemaVersion === 3
    ? new Set([
      'schemaVersion', 'droppedThrough', 'retirementEpoch', 'previousRetentionDigest',
      'compactedDigest', 'compactedCount', 'tombstones',
    ])
    : new Set(['schemaVersion', 'droppedThrough', 'retirementEpoch', 'tombstones']);
  if ((schemaVersion !== 2 && schemaVersion !== 3) || !hasOnlyKeys(parsed, keys) ||
    !Number.isSafeInteger(parsed['retirementEpoch']) ||
    (parsed['retirementEpoch'] as number) < 1 || !Array.isArray(parsed['tombstones']) ||
    (schemaVersion === 2 && parsed['tombstones'].length < 1) ||
    parsed['tombstones'].length > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const previousRetentionDigest = schemaVersion === 3 ? parsed['previousRetentionDigest'] : null;
  const compactedDigest = schemaVersion === 3
    ? parsed['compactedDigest']
    : emptyTreatmentRetentionCompactedDigest();
  const compactedCount = schemaVersion === 3 ? parsed['compactedCount'] : 0;
  if ((previousRetentionDigest !== null &&
      (typeof previousRetentionDigest !== 'string' || !SHA256_RE.test(previousRetentionDigest))) ||
    typeof compactedDigest !== 'string' || !SHA256_RE.test(compactedDigest) ||
    !Number.isSafeInteger(compactedCount) || (compactedCount as number) < 0) {
    throw new Error('invalid treatment receipt retention marker');
  }
  const tombstones: TreatmentReceiptTombstone[] = [];
  for (const value of parsed['tombstones']) {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set(['name', 'receiptDigest'])) ||
      typeof value['name'] !== 'string' || !TREATMENT_RECEIPT_FILE_RE.test(value['name']) ||
      typeof value['receiptDigest'] !== 'string' || !SHA256_RE.test(value['receiptDigest'])) {
      throw new Error('invalid treatment receipt retention marker');
    }
    tombstones.push({ name: value['name'], receiptDigest: value['receiptDigest'] });
  }
  if (tombstones.some((value, index) =>
    index > 0 && tombstones[index - 1]!.name >= value.name)) {
    throw new Error('invalid treatment receipt retention marker');
  }
  return {
    schemaVersion: schemaVersion as 2 | 3,
    droppedThrough,
    retirementEpoch: parsed['retirementEpoch'] as number,
    previousRetentionDigest,
    compactedDigest,
    compactedCount: compactedCount as number,
    tombstones,
  };
}

function readTreatmentReceiptProtocolState(): TreatmentReceiptProtocolState | null {
  const path = treatmentReceiptProtocolPath();
  if (!existsSync(path)) return null;
  inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES,
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid treatment receipt protocol');
  }
  inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(loaded.text);
  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
    'schemaVersion', 'retirementEpoch', 'retentionDigest',
  ])) || parsed['schemaVersion'] !== 1 ||
    !Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0 ||
    (parsed['retentionDigest'] !== null &&
      (typeof parsed['retentionDigest'] !== 'string' || !SHA256_RE.test(parsed['retentionDigest']))) ||
    `${JSON.stringify(parsed)}\n` !== loaded.text) {
    throw new Error('invalid treatment receipt protocol');
  }
  return {
    schemaVersion: 1,
    retirementEpoch: parsed['retirementEpoch'] as number,
    retentionDigest: parsed['retentionDigest'] as string | null,
  };
}

function readBoundTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  const state = readRawTreatmentReceiptRetentionState();
  const protocol = readTreatmentReceiptProtocolState();
  if (state === null) {
    if (protocol === null || (protocol.retirementEpoch === 0 && protocol.retentionDigest === null)) {
      return null;
    }
    throw new Error('treatment receipt retention anchor missing');
  }
  if (protocol === null) {
    if (state.schemaVersion !== 3) return state;
    throw new Error('treatment receipt protocol anchor missing');
  }
  const digest = treatmentReceiptRetentionDigest(state);
  if (protocol.retirementEpoch === state.retirementEpoch && protocol.retentionDigest === digest) {
    return state;
  }
  if (state.schemaVersion === 3 &&
    state.retirementEpoch === protocol.retirementEpoch + 1 &&
    state.previousRetentionDigest === protocol.retentionDigest) {
    return state;
  }
  throw new Error('treatment receipt retention rollback detected');
}

function markerMap(
  markers: readonly TreatmentCompactedReceiptMarker[],
): Map<string, TreatmentCompactedReceiptMarker> {
  return new Map(markers.map((marker) => [marker.name, marker]));
}

function readTreatmentReceiptAuthorityState(): TreatmentReceiptAuthorityState {
  const retention = readBoundTreatmentReceiptRetentionState();
  const observed = readCompactedTreatmentReceiptMarkerSet();
  const compactedMarkers = validateCommittedTreatmentCompactedMarkers(retention, observed);
  return {
    retention,
    compactedMarkers,
    observedCompactedMarkers: compactedMarkers,
    pendingCompaction: false,
  };
}

function pendingTreatmentCompactionMarkers(
  retention: TreatmentReceiptRetentionState,
): TreatmentReceiptTombstone[] {
  if (retention.schemaVersion !== 1) return retention.tombstones;
  const sources = readRetiredTreatmentOutcomeSources(retention.droppedThrough);
  if (sources.size === 0) {
    throw new Error('legacy treatment outcome retirement source unavailable');
  }
  return [...sources].map(([name, event]) => ({
    name,
    receiptDigest: treatmentOutcomeReceiptDigest(name, event),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

function readTreatmentReceiptAuthorityStateForWrite(): TreatmentReceiptAuthorityState {
  const retention = readBoundTreatmentReceiptRetentionState();
  const observed = readCompactedTreatmentReceiptMarkerSet();
  try {
    const compactedMarkers = validateCommittedTreatmentCompactedMarkers(retention, observed);
    return {
      retention,
      compactedMarkers,
      observedCompactedMarkers: compactedMarkers,
      pendingCompaction: false,
    };
  } catch (committedError) {
    if (retention === null) throw committedError;
    const pending = pendingTreatmentCompactionMarkers(retention);
    if (pending.length === 0) throw committedError;
    const pendingByName = new Map(pending.map((marker) => [marker.name, marker]));
    if (pendingByName.size !== pending.length) {
      throw new Error('duplicate pending compacted treatment receipt marker');
    }
    const foundPending = new Set<string>();
    const committedObserved: TreatmentCompactedReceiptMarker[] = [];
    for (const marker of observed) {
      const expected = pendingByName.get(marker.name);
      if (!expected) {
        committedObserved.push(marker);
        continue;
      }
      if (expected.receiptDigest !== marker.receiptDigest) {
        throw new Error('conflicting pending compacted treatment receipt marker');
      }
      foundPending.add(marker.name);
    }
    if (foundPending.size !== pending.length) throw committedError;
    const compactedMarkers = validateCommittedTreatmentCompactedMarkers(
      retention, committedObserved,
    );
    return {
      retention,
      compactedMarkers,
      observedCompactedMarkers: markerMap(observed),
      pendingCompaction: true,
    };
  }
}

function readTreatmentReceiptRetentionState(): TreatmentReceiptRetentionState | null {
  return readTreatmentReceiptAuthorityState().retention;
}

function treatmentReceiptLockPath(): string {
  return join(treatmentOutcomeReceiptDir(), '.receipts.lock');
}

function treatmentReceiptEventMatchesExpected(
  stored: DispatchProductionEvent,
  expected: DispatchProductionEvent,
): boolean {
  if (JSON.stringify(stored) === JSON.stringify(expected)) return true;
  const storedLabel: unknown = stored.learningLabel;
  const normalizedLabel = sanitizeProductionAttemptLearningLabel(storedLabel);
  if (
    !isPlainRecord(storedLabel) ||
    storedLabel['classifierVersion'] !== 'attempt-shape-v1' ||
    normalizedLabel === undefined
  ) return false;
  return JSON.stringify({
    ...stored,
    learningLabel: normalizedLabel,
  }) === JSON.stringify(expected);
}

/** Verify an exact immutable terminal-outcome receipt without writing or repairing storage. */
export function hasExactDispatchProductionTreatmentOutcomeReceipt(
  expected: DispatchProductionEvent,
): boolean {
  let canonical: DispatchProductionEvent;
  try {
    canonical = sanitizeDispatchProductionEvent(expected, { materializeLearningLabel: true });
  } catch {
    return false;
  }
  const name = treatmentOutcomeReceiptName(canonical);
  if (name === null) return false;
  try {
    const authority = readTreatmentReceiptAuthorityState();
    const retention = authority.retention;
    const wantedDigest = treatmentOutcomeReceiptDigest(name, canonical);
    const tombstone = retention?.tombstones.find((value) => value.name === name);
    const compacted = authority.compactedMarkers.get(name);
    const retired = tombstone ?? compacted;
    const path = join(treatmentOutcomeReceiptDir(), name);
    if (!existsSync(path)) {
      if (retired) return retired.receiptDigest === wantedDigest;
      const retiredSource = retention?.schemaVersion === 1
        ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
        : undefined;
      return retiredSource !== undefined && JSON.stringify(retiredSource) === JSON.stringify(canonical);
    }
    const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
    if (retired) {
      return retired.receiptDigest === artifact.receiptDigest &&
        retired.receiptDigest === wantedDigest;
    }
    const retiredSource = retention?.schemaVersion === 1
      ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
      : undefined;
    if (retiredSource) {
      return JSON.stringify(retiredSource) === JSON.stringify(canonical) &&
        JSON.stringify(artifact.event) === JSON.stringify(canonical);
    }
    if (retention && Date.parse(artifact.ts) <= Date.parse(retention.droppedThrough)) return false;
    return treatmentReceiptEventMatchesExpected(artifact.event, canonical);
  } catch {
    return false;
  }
}

const heldAttemptAuthorityLocks = new Set<string>();

function attemptAuthorityLockPath(generationId: string): string {
  return join(dispatchProductionDir(), `.attempt-authority-${generationId}.lock`);
}

export function withDispatchProductionGenerationAuthority<T>(
  generationId: string,
  consume: () => T,
): { ok: true; value: T } | { ok: false } {
  // Global order: lifecycle -> generation -> receipt writer -> date partition.
  // No dispatch writer may acquire lifecycle authority while holding this lock.
  if (!SHA256_RE.test(generationId)) return { ok: false };
  if (heldAttemptAuthorityLocks.has(generationId)) return { ok: true, value: consume() };
  let openedRoot: DispatchProductionWriteRoot | undefined;
  if (dispatchProductionWriteRoots.length === 0) {
    try {
      openedRoot = openDispatchProductionWriteRoot();
      dispatchProductionWriteRoots.push(openedRoot);
    } catch {
      return { ok: false };
    }
  }
  let lock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    assertStableDispatchProductionWriteRoot();
    lock = acquireLocalStoreLock(attemptAuthorityLockPath(generationId));
    assertStableDispatchProductionWriteRoot();
  } catch {
    releaseLocalStoreLock(lock);
    lock = null;
  }
  if (!lock) {
    if (openedRoot) {
      dispatchProductionWriteRoots.pop();
      if (openedRoot.fd !== undefined) {
        try { closeSync(openedRoot.fd); } catch { /* best effort */ }
      }
    }
    return { ok: false };
  }
  heldAttemptAuthorityLocks.add(generationId);
  try {
    const value = consume();
    assertStableDispatchProductionWriteRoot();
    return { ok: true, value };
  } finally {
    heldAttemptAuthorityLocks.delete(generationId);
    releaseLocalStoreLock(lock);
    if (openedRoot) {
      dispatchProductionWriteRoots.pop();
      if (openedRoot.fd !== undefined) {
        try { closeSync(openedRoot.fd); } catch { /* best effort */ }
      }
    }
  }
}

function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString().slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function stripSecrets(value: string): string {
  return scrubSecrets(value);
}

function boundedText(value: string, max: number): string {
  const stripped = stripSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedOptionalText(value, max);
}

function selectionRouteTuple(value: DispatchSelectionCandidate): [EngineId, EngineTier, string | null] | null {
  if (!ENGINE_IDS.has(value.backend) || value.backend === 'builtin' || !ENGINE_TIERS.has(value.tier)) return null;
  const model = boundedNullableText(value.model, 160);
  return model === undefined ? [value.backend, value.tier, null] : [value.backend, value.tier, model];
}

function selectionTupleKey(tuple: readonly [EngineId, EngineTier, string | null]): string {
  return JSON.stringify(tuple);
}

function hmacSelection(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function selectionAssignmentPayload(input: {
  candidateSetDigest: string;
  candidateCount: number;
  selectedRank: number;
  selectionProbabilityPpm: number;
  selectedRoute: readonly [EngineId, EngineTier, string | null];
  selectionPolicyVersion: string;
  randomizationProtocolVersion: string;
  trajectoryId: string;
  runId: string;
  objectiveHash: string;
  routerPolicyVersion: string;
  learningEpoch: string;
}): unknown[] {
  return [
    input.candidateSetDigest,
    input.candidateCount,
    input.selectedRank,
    input.selectionProbabilityPpm,
    input.selectedRoute,
    input.selectionPolicyVersion,
    input.randomizationProtocolVersion,
    input.trajectoryId,
    input.runId,
    input.objectiveHash,
    input.routerPolicyVersion,
    input.learningEpoch,
  ];
}

/**
 * Commit a pre-selection canary population without retaining any candidate
 * identities. Callers must hold the private provenance key only in memory.
 */
export function createDispatchSelectionObservation(
  input: CreateDispatchSelectionObservationInput,
  key: Buffer,
): DispatchSelectionObservationV1 | null {
  if (!Buffer.isBuffer(key) || key.length !== 32 ||
    !Number.isSafeInteger(input.selectionProbabilityPpm) ||
    input.selectionProbabilityPpm < 1 || input.selectionProbabilityPpm > 1_000_000 ||
    !SHA256_RE.test(input.objectiveHash) ||
    !isSafeExecutionIdentity(input.runId) ||
    input.trajectoryId !== `run:${input.runId}` ||
    typeof input.selectionPolicyVersion !== 'string' || input.selectionPolicyVersion.length < 1 ||
    input.selectionPolicyVersion.length > MAX_SELECTION_VERSION || scrubSecrets(input.selectionPolicyVersion) !== input.selectionPolicyVersion ||
    typeof input.randomizationProtocolVersion !== 'string' || input.randomizationProtocolVersion.length < 1 ||
    input.randomizationProtocolVersion.length > MAX_SELECTION_VERSION || scrubSecrets(input.randomizationProtocolVersion) !== input.randomizationProtocolVersion ||
    typeof input.routerPolicyVersion !== 'string' || input.routerPolicyVersion.length < 1 ||
    input.routerPolicyVersion.length > MAX_SELECTION_VERSION || scrubSecrets(input.routerPolicyVersion) !== input.routerPolicyVersion ||
    typeof input.learningEpoch !== 'string' || input.learningEpoch.length < 1 || input.learningEpoch.length > 40 ||
    scrubSecrets(input.learningEpoch) !== input.learningEpoch ||
    !Array.isArray(input.candidates) || input.candidates.length < 1 || input.candidates.length > MAX_SELECTION_CANDIDATES) {
    return null;
  }
  const candidates = input.candidates.map(selectionRouteTuple);
  const selected = selectionRouteTuple(input.selected);
  if (!selected || candidates.some((candidate) => candidate === null)) return null;
  const canonicalCandidates = (candidates as Array<[EngineId, EngineTier, string | null]>)
    .sort((left, right) => selectionTupleKey(left).localeCompare(selectionTupleKey(right)));
  if (new Set(canonicalCandidates.map(selectionTupleKey)).size !== canonicalCandidates.length) return null;
  const selectedRank = canonicalCandidates.findIndex((candidate) => selectionTupleKey(candidate) === selectionTupleKey(selected));
  if (selectedRank < 0) return null;
  const candidateSetDigest = hmacSelection(key, SELECTION_CANDIDATE_DIGEST_DOMAIN, [
    canonicalCandidates,
    input.selectionPolicyVersion,
    input.routerPolicyVersion,
    input.learningEpoch,
  ]);
  const assignmentDigest = hmacSelection(key, SELECTION_ASSIGNMENT_DIGEST_DOMAIN, selectionAssignmentPayload({
    candidateSetDigest,
    candidateCount: canonicalCandidates.length,
    selectedRank,
    selectionProbabilityPpm: input.selectionProbabilityPpm,
    selectedRoute: selected,
    selectionPolicyVersion: input.selectionPolicyVersion,
    randomizationProtocolVersion: input.randomizationProtocolVersion,
    trajectoryId: input.trajectoryId,
    runId: input.runId,
    objectiveHash: input.objectiveHash,
    routerPolicyVersion: input.routerPolicyVersion,
    learningEpoch: input.learningEpoch,
  }));
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    mode: 'randomized-canary',
    selectionPolicyVersion: input.selectionPolicyVersion,
    randomizationProtocolVersion: input.randomizationProtocolVersion,
    candidateSetDigest,
    assignmentDigest,
    candidateCount: canonicalCandidates.length,
    selectedRank,
    selectionProbabilityPpm: input.selectionProbabilityPpm,
    selectedBackend: selected[0],
    selectedTier: selected[1],
    ...(selected[2] !== null ? { selectedModel: selected[2] } : {}),
  };
}

function constantTimeDigestEquals(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sanitizeDispatchSelectionObservation(
  value: unknown,
  binding: {
    backend: EngineId | null | undefined;
    tier: EngineTier | null | undefined;
    model: string | null | undefined;
    trajectoryId?: string;
    runId?: string;
    objectiveHash?: string;
    routerPolicyVersion?: string;
    learningEpoch?: string;
  },
): DispatchSelectionObservationV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid selection observation');
  const observation = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion', 'authority', 'mode', 'selectionPolicyVersion', 'randomizationProtocolVersion',
    'candidateSetDigest', 'assignmentDigest', 'candidateCount', 'selectedRank',
    'selectionProbabilityPpm', 'selectedBackend', 'selectedTier', 'selectedModel',
  ]);
  if (!hasOnlyKeys(observation, allowed) || observation['schemaVersion'] !== 1 ||
    observation['authority'] !== 'observation-only' || observation['mode'] !== 'randomized-canary' ||
    typeof observation['selectionPolicyVersion'] !== 'string' || observation['selectionPolicyVersion'].length < 1 ||
    observation['selectionPolicyVersion'].length > MAX_SELECTION_VERSION || scrubSecrets(observation['selectionPolicyVersion']) !== observation['selectionPolicyVersion'] ||
    typeof observation['randomizationProtocolVersion'] !== 'string' || observation['randomizationProtocolVersion'].length < 1 ||
    observation['randomizationProtocolVersion'].length > MAX_SELECTION_VERSION || scrubSecrets(observation['randomizationProtocolVersion']) !== observation['randomizationProtocolVersion'] ||
    !SHA256_RE.test(observation['candidateSetDigest'] as string) || !SHA256_RE.test(observation['assignmentDigest'] as string) ||
    !Number.isSafeInteger(observation['candidateCount']) || (observation['candidateCount'] as number) < 1 ||
    (observation['candidateCount'] as number) > MAX_SELECTION_CANDIDATES ||
    !Number.isSafeInteger(observation['selectedRank']) || (observation['selectedRank'] as number) < 0 ||
    (observation['selectedRank'] as number) >= (observation['candidateCount'] as number) ||
    !Number.isSafeInteger(observation['selectionProbabilityPpm']) ||
    (observation['selectionProbabilityPpm'] as number) < 1 || (observation['selectionProbabilityPpm'] as number) > 1_000_000 ||
    !ENGINE_IDS.has(observation['selectedBackend'] as EngineId) || observation['selectedBackend'] === 'builtin' ||
    !ENGINE_TIERS.has(observation['selectedTier'] as EngineTier) ||
    observation['selectedBackend'] !== binding.backend || observation['selectedTier'] !== binding.tier ||
    (observation['selectedModel'] !== undefined && observation['selectedModel'] !== null &&
      !boundedStoredText(observation['selectedModel'], 160)) ||
    (observation['selectedModel'] ?? null) !== (binding.model ?? null) ||
    !binding.trajectoryId || !binding.runId || binding.trajectoryId !== `run:${binding.runId}` ||
    !SHA256_RE.test(binding.objectiveHash ?? '') || !binding.routerPolicyVersion || !binding.learningEpoch) {
    throw new Error('invalid selection observation');
  }
  let key: Buffer | null;
  try { key = loadExistingProvenanceKeyReadOnly(); } catch { key = null; }
  if (!key) throw new Error('selection observation provenance unavailable');
  const selectedRoute: [EngineId, EngineTier, string | null] = [
    observation['selectedBackend'] as EngineId,
    observation['selectedTier'] as EngineTier,
    (observation['selectedModel'] ?? null) as string | null,
  ];
  const expectedAssignment = hmacSelection(key, SELECTION_ASSIGNMENT_DIGEST_DOMAIN, selectionAssignmentPayload({
    candidateSetDigest: observation['candidateSetDigest'] as string,
    candidateCount: observation['candidateCount'] as number,
    selectedRank: observation['selectedRank'] as number,
    selectionProbabilityPpm: observation['selectionProbabilityPpm'] as number,
    selectedRoute,
    selectionPolicyVersion: observation['selectionPolicyVersion'] as string,
    randomizationProtocolVersion: observation['randomizationProtocolVersion'] as string,
    trajectoryId: binding.trajectoryId,
    runId: binding.runId,
    objectiveHash: binding.objectiveHash!,
    routerPolicyVersion: binding.routerPolicyVersion,
    learningEpoch: binding.learningEpoch,
  }));
  if (!constantTimeDigestEquals(observation['assignmentDigest'] as string, expectedAssignment)) {
    throw new Error('invalid selection observation');
  }
  return {
    schemaVersion: 1,
    authority: 'observation-only',
    mode: 'randomized-canary',
    selectionPolicyVersion: observation['selectionPolicyVersion'] as string,
    randomizationProtocolVersion: observation['randomizationProtocolVersion'] as string,
    candidateSetDigest: observation['candidateSetDigest'] as string,
    assignmentDigest: observation['assignmentDigest'] as string,
    candidateCount: observation['candidateCount'] as number,
    selectedRank: observation['selectedRank'] as number,
    selectionProbabilityPpm: observation['selectionProbabilityPpm'] as number,
    selectedBackend: observation['selectedBackend'] as EngineId,
    selectedTier: observation['selectedTier'] as EngineTier,
    ...(observation['selectedModel'] !== undefined && observation['selectedModel'] !== null
      ? { selectedModel: observation['selectedModel'] as string }
      : {}),
  };
}

export function canonicalDispatchRepoIdentity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || !isAbsolute(value)) return null;
  if (scrubSecrets(value) !== value) return null;
  const canonical = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  return canonical !== null && canonical.length <= 500 && scrubSecrets(canonical) === canonical
    ? canonical
    : null;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

export function sanitizeDispatchProductionEvent(
  event: DispatchProductionEvent,
  opts: { materializeLearningLabel?: boolean; deriveLegacyRunOutcomeCausal?: boolean } = {},
): DispatchProductionEvent {
  const ts = eventTimestamp(event.ts);
  const machineId = boundedOptionalText(event.machineId, 120);
  const itemId = boundedText(event.itemId, 240) || 'unknown';
  const source = boundedText(event.source, 80) as WorkItem['source'];
  const repo = canonicalDispatchRepoIdentity(event.repo);
  if (repo === null) throw new Error('invalid dispatch production repository identity');
  const title = boundedText(event.title, 160) || 'untitled';
  const backend = boundedNullableText(event.backend, 80) as EngineId | null | undefined;
  const tier = boundedNullableText(event.tier, 40) as EngineTier | null | undefined;
  const model = boundedNullableText(event.model, 160) as string | null | undefined;
  const assignedBy = boundedText(event.assignedBy, 80) || 'unknown';
  const routeReason = boundedText(event.routeReason, 240) || 'unknown';
  const proposalId = boundedOptionalText(event.proposalId, 160);
  const runId = boundedOptionalText(event.runId, 160);
  const trajectoryId = boundedOptionalText(event.trajectoryId, 240);
  const outcome = boundedText(event.outcome, 80) as DaemonDispatchProductionOutcome;
  const basis = boundedText(event.basis, 80) as DispatchProductionBasis;
  const routerPolicyVersion = boundedOptionalText(event.routerPolicyVersion, 80);
  const learningEpoch = boundedOptionalText(event.learningEpoch, 40);
  const objectiveHash = typeof event.objectiveHash === 'string' && /^[a-f0-9]{64}$/.test(event.objectiveHash)
    ? event.objectiveHash
    : undefined;
  const repairHandoffId = typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId)
    ? event.repairHandoffId
    : undefined;
  const repairGenerationId = typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId)
    ? event.repairGenerationId
    : undefined;
  const repairTreatmentUnitId = typeof event.repairTreatmentUnitId === 'string' && SHA256_RE.test(event.repairTreatmentUnitId)
    ? event.repairTreatmentUnitId
    : undefined;
  const repairTreatment = event.repairTreatment === 'baseline-reslice' || event.repairTreatment === 'target-localization'
    ? event.repairTreatment
    : undefined;
  const repairTreatmentOutcome = event.repairTreatmentOutcome === 'converted' ||
    event.repairTreatmentOutcome === 'not-converted'
    ? event.repairTreatmentOutcome
    : undefined;
  const repairTreatmentAttemptHash = typeof event.repairTreatmentAttemptHash === 'string' &&
    SHA256_RE.test(event.repairTreatmentAttemptHash)
    ? event.repairTreatmentAttemptHash
    : undefined;
  const repairAttemptOrdinal = event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2
    ? event.repairAttemptOrdinal
    : undefined;
  const repairPreviousBackend = ENGINE_IDS.has(event.repairPreviousBackend as EngineId)
    ? event.repairPreviousBackend
    : undefined;
  const repairRootId = typeof event.repairRootId === 'string' && SHA256_RE.test(event.repairRootId)
    ? event.repairRootId
    : undefined;
  const repairDepth = event.repairDepth === 0 || event.repairDepth === 1
    ? event.repairDepth
    : undefined;
  const repairLineageFieldsPresent = event.repairHandoffId !== undefined ||
    event.repairGenerationId !== undefined ||
    event.repairTreatmentUnitId !== undefined ||
    event.repairTreatment !== undefined ||
    event.repairTreatmentOutcome !== undefined ||
    event.repairTreatmentAttemptHash !== undefined ||
    event.repairAttemptOrdinal !== undefined ||
    event.repairPreviousBackend !== undefined ||
    event.repairRootId !== undefined ||
    event.repairDepth !== undefined;
  const diagnosticRepairLineage = repairTreatmentUnitId !== undefined && repairTreatment !== undefined &&
    /:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(itemId) &&
    repairTreatmentForUnitId(repairTreatmentUnitId) === repairTreatment;
  const genericRepairLineage = repairTreatmentUnitId === undefined && repairTreatment === undefined &&
    /:proposal-repair(?:-capture)?:[0-9a-f]{12}$/i.test(itemId) &&
    repairRootId !== undefined && repairDepth !== undefined;
  const legacyRepairLineage = repairTreatmentUnitId === undefined && repairTreatment === undefined &&
    repairRootId === undefined && repairDepth === undefined;
  const repairLineageComplete = event.repairLineageInvalid !== true &&
    backend !== undefined &&
    backend !== null &&
    ENGINE_IDS.has(backend) &&
    repairGenerationId !== undefined &&
    ((diagnosticRepairLineage &&
      repairHandoffId !== undefined &&
      repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId &&
      (ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(outcome)
        ? repairRootId !== undefined && repairDepth !== undefined
        : repairRootId === undefined && repairDepth === undefined)) || genericRepairLineage ||
      (legacyRepairLineage && repairHandoffId !== undefined &&
        repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId)) &&
    repairAttemptOrdinal !== undefined &&
    (repairAttemptOrdinal === 1
      ? repairPreviousBackend === undefined
      : repairPreviousBackend !== undefined && backend !== repairPreviousBackend);
  const lifecycleAttemptId = trajectoryId !== undefined && runId !== undefined &&
    trajectoryId === `run:${runId}` && repairTreatmentAttemptHash !== undefined &&
    generatedRepairLifecycleAttemptHash(runId) === repairTreatmentAttemptHash
    ? runId
    : trajectoryId ?? runId;
  const repairTreatmentOutcomeComplete = repairTreatmentOutcome !== undefined &&
    basis === 'repair-lifecycle-outcome' &&
    repairTreatmentAttemptHash !== undefined &&
    lifecycleAttemptId !== undefined &&
    generatedRepairLifecycleAttemptHash(lifecycleAttemptId) === repairTreatmentAttemptHash &&
    repairTreatmentUnitId !== undefined &&
    repairTreatment !== undefined &&
    repairGenerationId !== undefined &&
    (repairTreatmentOutcome === 'converted'
      ? outcome === 'proposal-created' && Boolean(event.proposalCreated) && proposalId !== undefined
      : outcome === 'empty-diff' && !event.proposalCreated && proposalId === undefined && repairAttemptOrdinal === 2);
  const repairTreatmentCandidateComplete = repairTreatmentOutcome === undefined &&
    basis === 'repair-lifecycle-candidate' &&
    repairTreatmentAttemptHash !== undefined &&
    lifecycleAttemptId !== undefined &&
    generatedRepairLifecycleAttemptHash(lifecycleAttemptId) === repairTreatmentAttemptHash &&
    repairTreatmentUnitId !== undefined &&
    repairTreatment !== undefined &&
    repairGenerationId !== undefined;
  const repairLineageInvalid = event.repairLineageInvalid === true ||
    (repairLineageFieldsPresent && !repairLineageComplete) ||
    ((basis === 'repair-lifecycle-candidate' || basis === 'repair-lifecycle-outcome' ||
      event.repairTreatmentOutcome !== undefined ||
      event.repairTreatmentAttemptHash !== undefined) &&
      !repairTreatmentOutcomeComplete && !repairTreatmentCandidateComplete);
  const reason = boundedOptionalText(event.reason, 240);
  const diffFiles = finiteNonNegative(event.diffFiles);
  const diffLines = finiteNonNegative(event.diffLines);
  const spentUsd = finiteNonNegative(event.spentUsd) ?? 0;
  const legacyCausal =
    opts.deriveLegacyRunOutcomeCausal && basis === 'run-proposal-outcome'
      ? legacyRunOutcomeCausalFallback({
          backend,
          tier,
          model,
          assignedBy: boundedOptionalText(event.assignedBy, 80),
          routeReason: boundedOptionalText(event.routeReason, 240),
          runId,
          outcome,
          proposalCreated: Boolean(event.proposalCreated),
          proposalId,
          diffFiles,
          diffLines,
          spentUsd: finiteNonNegative(event.spentUsd),
        })
      : {};
  const causal = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId,
    routeSnapshot: event.routeSnapshot ?? legacyCausal.routeSnapshot,
    runEventSummary: event.runEventSummary ?? legacyCausal.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ?? 'daemon-dispatch',
    labelBasis: event.labelBasis ?? 'dispatch-outcome',
    routerPolicyVersion,
    learningEpoch,
  });
  const selectionObservation = sanitizeDispatchSelectionObservation(event.selectionObservation, {
    backend,
    tier,
    model,
    trajectoryId: causal.trajectoryId,
    runId,
    objectiveHash,
    routerPolicyVersion: causal.routerPolicyVersion,
    learningEpoch: causal.learningEpoch,
  });
  const learningLabel = opts.materializeLearningLabel
    ? productionAttemptLearningLabelFromSignals({
        outcome,
        proposalCreated: Boolean(event.proposalCreated),
        actionCounts: causal.runEventSummary?.actionCounts,
        reason,
        itemId,
        title,
        source,
      })
    : sanitizeProductionAttemptLearningLabel(event.learningLabel);
  return {
    schemaVersion: 1,
    ts,
    ...(machineId ? { machineId } : {}),
    itemId,
    source,
    repo,
    title,
    backend: backend ?? null,
    tier: tier ?? null,
    ...(model !== undefined ? { model } : {}),
    assignedBy,
    routeReason,
    outcome,
    proposalCreated: Boolean(event.proposalCreated),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    ...(selectionObservation ? { selectionObservation } : {}),
    ...(learningLabel ? { learningLabel } : {}),
    ...(objectiveHash ? { objectiveHash } : {}),
    ...(repairLineageInvalid
      ? {
        repairLineageInvalid: true as const,
        ...(repairGenerationId && repairAttemptOrdinal
          ? { repairGenerationId, repairAttemptOrdinal }
          : {}),
      }
      : repairLineageComplete
        ? {
          ...(repairHandoffId ? { repairHandoffId } : {}),
          repairGenerationId,
          ...(repairTreatmentUnitId ? { repairTreatmentUnitId } : {}),
          ...(repairTreatment ? { repairTreatment } : {}),
          ...(repairTreatmentOutcomeComplete || repairTreatmentCandidateComplete ? {
            ...(repairTreatmentOutcome ? { repairTreatmentOutcome } : {}),
            repairTreatmentAttemptHash,
          } : {}),
          repairAttemptOrdinal,
          ...(repairPreviousBackend ? { repairPreviousBackend } : {}),
          ...(repairRootId ? { repairRootId, repairDepth } : {}),
          }
        : {}),
    spentUsd,
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    ...(reason ? { reason } : {}),
    basis,
  };
}

function legacyRunOutcomeCausalFallback(input: {
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  assignedBy?: string;
  routeReason?: string;
  runId?: string;
  outcome?: DaemonDispatchProductionOutcome;
  proposalCreated?: boolean;
  proposalId?: string;
  diffFiles?: number;
  diffLines?: number;
  spentUsd?: number;
}): { routeSnapshot?: RouteSnapshot; runEventSummary?: RunEventSummary } {
  const routeSnapshot: RouteSnapshot = {
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
    ...(input.routeReason ? { reason: input.routeReason } : {}),
  };
  const runEventSummary: RunEventSummary = {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.proposalCreated !== undefined ? { proposalCreated: input.proposalCreated } : {}),
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    ...(input.diffFiles !== undefined ? { diffFiles: input.diffFiles } : {}),
    ...(input.diffLines !== undefined ? { diffLines: input.diffLines } : {}),
    ...(input.spentUsd !== undefined ? { costUsd: input.spentUsd } : {}),
  };
  return {
    ...(Object.keys(routeSnapshot).length > 0 ? { routeSnapshot } : {}),
    ...(Object.keys(runEventSummary).length > 0 ? { runEventSummary } : {}),
  };
}

function isDispatchProductionEvent(value: unknown): value is DispatchProductionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['schemaVersion'] === 1 &&
    typeof obj['ts'] === 'string' &&
    typeof obj['itemId'] === 'string' &&
    typeof obj['source'] === 'string' &&
    typeof obj['repo'] === 'string' && canonicalDispatchRepoIdentity(obj['repo']) === obj['repo'] &&
    typeof obj['title'] === 'string' &&
    typeof obj['assignedBy'] === 'string' &&
    typeof obj['routeReason'] === 'string' &&
    typeof obj['outcome'] === 'string' &&
    typeof obj['proposalCreated'] === 'boolean' &&
    typeof obj['spentUsd'] === 'number' &&
    typeof obj['basis'] === 'string'
  );
}

export function recordDispatchProduction(
  input: DispatchProductionEvent | DispatchProductionEvent[],
): DispatchProductionWriteResult {
  const result: DispatchProductionWriteResult = { attempted: 0, recorded: 0, failed: 0 };
  try {
    const events = Array.isArray(input) ? input : [input];
    result.attempted = events.length;
    if (events.length === 0) return result;
    for (const event of events) {
      try {
        const record = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
        if (!isDispatchProductionEvent(record)) throw new Error('dispatch production repository identity is not canonical');
        const canonicalLine = JSON.stringify(record);
        const attemptAuthority = parseDispatchProductionAttemptAuthority(record, canonicalLine);
        const failureAuthority = parseDispatchProductionFailureAttemptAuthority(record, canonicalLine);
        if (
          (attemptAuthority !== null || failureAuthority !== null) &&
          Date.parse(record.ts) > Date.now() + MAX_ATTEMPT_FUTURE_SKEW_MS
        ) throw new Error('future-dated generated repair attempt');
        withStableDispatchProductionWriteRoot(() => {
          const dir = dispatchProductionDir();
          const write = (): void => {
            const receiptName = treatmentOutcomeReceiptName(record);
            if (receiptName) persistTreatmentOutcomeReceipt(record, receiptName);
            else {
              const append = (): void => appendDispatchProductionLine(
                join(dir, `${eventDateString(record.ts)}.jsonl`), canonicalLine + '\n',
              );
              if (attemptAuthority !== null) {
                recordAttemptProductionWithReceipt(record, canonicalLine, append);
              } else if (failureAuthority !== null) {
                recordFailureAttemptProductionWithReceipt(record, canonicalLine);
              } else append();
            }
          };
          if (record.repairGenerationId && record.repairAttemptOrdinal) {
            if (!withDispatchProductionGenerationAuthority(record.repairGenerationId, write).ok) {
              throw new Error('dispatch production generation authority unavailable');
            }
          } else write();
        });
        result.recorded += 1;
      } catch (error) {
        // Skip only this record; later records in the batch still get a chance.
        result.failed += 1;
        if (error instanceof AttemptMembershipSaturatedError) {
          result.failureReasons = [...new Set([
            ...(result.failureReasons ?? []), 'retirement-membership-saturated' as const,
          ])];
        }
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
    result.failed = Math.max(result.failed, result.attempted - result.recorded);
  }
  return result;
}

function attemptReceiptStagePath(path: string): string {
  return `${path}.${randomBytes(16).toString('hex')}.stage`;
}

function cleanupDispatchProductionWriteTemp(path: string): void {
  try {
    assertStableDispatchProductionWriteRoot();
    const stat = lstatSync(path);
    if (safeDispatchProductionFile(stat)) unlinkSync(path);
  } catch {
    // A missing, replaced, linked, or out-of-root temp is never followed or removed.
  }
}

function attemptReceiptIntentPath(generationId: string, ordinal: 1 | 2): string {
  return join(attemptProofReceiptDir(), `${generationId}-${ordinal}.intent.json`);
}

function attemptFailureReceiptIntentPath(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return join(
    attemptProofReceiptDir(),
    `${generationId}-${ordinal}-${attemptHash}.failure.intent.json`,
  );
}

function cleanupStaleAttemptReceiptStages(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const stale: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
        throw new Error('attempt receipt directory scan limit');
      }
      if (!ATTEMPT_RECEIPT_STAGE_FILE_RE.test(entry.name)) continue;
      stale.push(entry.name);
      if (stale.length > MAX_STALE_ATTEMPT_RECEIPT_STAGES) {
        throw new Error('attempt receipt staging limit');
      }
    }
  } finally { handle.closeSync(); }

  for (const name of stale) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (!safeDispatchProductionFile(stat) ||
      (process.platform === 'win32' && !assurePrivateStoragePath(
        path, 'file', 'inspect-owned', { anchorPath: dispatchProductionDir() },
      ).ok)) {
      throw new Error('unsafe attempt receipt stage');
    }
  }
  for (const name of stale) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, name));
  }
  if (stale.length > 0) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

interface AttemptReceiptProtocolGeneration {
  generationId: string;
  admittedAt: string;
}

interface AttemptGenerationMembership {
  algorithm: 'sha256-bloom-v1';
  bitCount: typeof ATTEMPT_BLOCKED_MEMBERSHIP_BITS;
  hashCount: typeof ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
  bits: string;
}

interface AttemptGenerationMembershipSegment extends AttemptGenerationMembership {
  insertedCount: number;
  setBitCount: number;
}

interface AttemptGenerationMembershipSet {
  algorithm: 'segmented-sha256-bloom-v1';
  maxSegmentFalsePositiveRate: typeof MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE;
  quality: 'healthy' | 'saturated';
  segments: AttemptGenerationMembershipSegment[];
}

class AttemptMembershipSaturatedError extends Error {
  constructor(readonly membership?: AttemptGenerationMembershipSet) {
    super('attempt retirement membership saturated');
    this.name = 'AttemptMembershipSaturatedError';
  }
}

interface AttemptReceiptProtocolActivation {
  schemaVersion: 5;
  activationId: string;
  activatedAt: string;
  acceptsEventsAfter: string;
  retirementEpoch: number;
  generations: AttemptReceiptProtocolGeneration[];
  blockedGenerations: AttemptGenerationMembershipSet;
}

interface AttemptReceiptRetentionState {
  present: boolean;
  epochBound: boolean;
  droppedThrough: string | null;
  retirementEpoch: number;
  pendingGenerations: string[];
  pendingArtifacts: AttemptReceiptRetentionArtifacts;
}

interface AttemptReceiptRetentionArtifact {
  name: string;
  generationId: string;
  ordinal: 1 | 2;
  kind: 'receipt' | 'intent' | 'failure-receipt' | 'failure-intent';
  eventTs: string;
  eventDigest: string;
  fileDigest: string;
}

interface AttemptReceiptRetentionArtifactSet {
  count: number;
  digests: string[];
}

type AttemptReceiptRetentionArtifacts =
  | AttemptReceiptRetentionArtifact[]
  | AttemptReceiptRetentionArtifactSet;

interface DispatchProductionLedgerRetentionHooksForTest {
  afterAttemptReceiptIntentAssured?: (path: string) => void;
  afterAttemptRetentionMarker?: () => void;
  afterFailureAttemptAppend?: () => void;
  afterTreatmentCompactedMarkers?: () => void;
  assureStableRegularFiles?: (
    paths: string[],
    anchorPath: string,
  ) => StableFileBatchAssuranceResult;
}

let dispatchProductionLedgerRetentionHooksForTest:
  DispatchProductionLedgerRetentionHooksForTest | undefined;

export function _setDispatchProductionLedgerRetentionHooksForTest(
  hooks: DispatchProductionLedgerRetentionHooksForTest | undefined,
): void {
  dispatchProductionLedgerRetentionHooksForTest = hooks;
}

function assureRetentionFiles(
  paths: string[],
  anchorPath: string,
): StableFileBatchAssuranceResult {
  return (dispatchProductionLedgerRetentionHooksForTest?.assureStableRegularFiles ??
    assureStableRegularFiles)(paths, anchorPath);
}

function attemptRetentionArtifactSet(
  artifacts: readonly AttemptReceiptRetentionArtifact[],
): AttemptReceiptRetentionArtifactSet {
  const digests = artifacts.map((artifact) => createHash('sha256')
    .update(ATTEMPT_RETENTION_ARTIFACT_SET_DIGEST_DOMAIN, 'utf8')
    .update(JSON.stringify(artifact), 'utf8')
    .digest('hex')).sort();
  return {
    count: digests.length,
    digests,
  };
}

function emptyAttemptGenerationMembership(): AttemptGenerationMembership {
  return {
    algorithm: 'sha256-bloom-v1',
    bitCount: ATTEMPT_BLOCKED_MEMBERSHIP_BITS,
    hashCount: ATTEMPT_BLOCKED_MEMBERSHIP_HASHES,
    bits: Buffer.alloc(ATTEMPT_BLOCKED_MEMBERSHIP_BYTES).toString('base64'),
  };
}

function countSetBits(bits: Buffer): number {
  let count = 0;
  for (const byte of bits) {
    let value = byte;
    while (value !== 0) {
      value &= value - 1;
      count++;
    }
  }
  return count;
}

function membershipSegment(
  membership: AttemptGenerationMembership,
  insertedCount = 0,
): AttemptGenerationMembershipSegment {
  const bits = attemptGenerationMembershipBuffer(membership);
  if (bits === null) throw new Error('invalid attempt generation membership');
  return { ...membership, insertedCount, setBitCount: countSetBits(bits) };
}

function emptyAttemptGenerationMembershipSet(): AttemptGenerationMembershipSet {
  return {
    algorithm: 'segmented-sha256-bloom-v1',
    maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
    quality: 'healthy',
    segments: [membershipSegment(emptyAttemptGenerationMembership())],
  };
}

function attemptGenerationMembershipBuffer(value: unknown): Buffer | null {
  const keys = isPlainRecord(value) ? Object.keys(value) : [];
  const validKeys = keys.length === 4
    ? new Set(['algorithm', 'bitCount', 'hashCount', 'bits'])
    : new Set(['algorithm', 'bitCount', 'hashCount', 'bits', 'insertedCount', 'setBitCount']);
  if (!isPlainRecord(value) ||
    (keys.length !== 4 && keys.length !== 6) ||
    !hasOnlyKeys(value, validKeys) ||
    value['algorithm'] !== 'sha256-bloom-v1' ||
    value['bitCount'] !== ATTEMPT_BLOCKED_MEMBERSHIP_BITS ||
    value['hashCount'] !== ATTEMPT_BLOCKED_MEMBERSHIP_HASHES ||
    typeof value['bits'] !== 'string') return null;
  const bits = Buffer.from(value['bits'], 'base64');
  if (bits.length !== ATTEMPT_BLOCKED_MEMBERSHIP_BYTES || bits.toString('base64') !== value['bits']) {
    return null;
  }
  return bits;
}

function attemptGenerationMembershipSet(value: unknown): AttemptGenerationMembershipSet | null {
  if (!isPlainRecord(value) ||
    !hasOnlyKeys(value, new Set(['algorithm', 'maxSegmentFalsePositiveRate', 'quality', 'segments'])) ||
    value['algorithm'] !== 'segmented-sha256-bloom-v1' ||
    value['maxSegmentFalsePositiveRate'] !== MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE ||
    (value['quality'] !== 'healthy' && value['quality'] !== 'saturated') ||
    !Array.isArray(value['segments']) || value['segments'].length < 1 ||
    value['segments'].length > MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) return null;
  const segments: AttemptGenerationMembershipSegment[] = [];
  for (const segment of value['segments']) {
    const insertedCount = isPlainRecord(segment) ? segment['insertedCount'] : undefined;
    const setBitCount = isPlainRecord(segment) ? segment['setBitCount'] : undefined;
    if (!isPlainRecord(segment) || !hasOnlyKeys(segment, new Set([
      'algorithm', 'bitCount', 'hashCount', 'bits', 'insertedCount', 'setBitCount',
    ])) || typeof insertedCount !== 'number' || !Number.isSafeInteger(insertedCount) || insertedCount < 0 ||
      typeof setBitCount !== 'number' || !Number.isSafeInteger(setBitCount) || setBitCount < 0 ||
      setBitCount > ATTEMPT_BLOCKED_MEMBERSHIP_BITS) return null;
    const membership: AttemptGenerationMembership = {
      algorithm: segment['algorithm'] as AttemptGenerationMembership['algorithm'],
      bitCount: segment['bitCount'] as AttemptGenerationMembership['bitCount'],
      hashCount: segment['hashCount'] as AttemptGenerationMembership['hashCount'],
      bits: segment['bits'] as string,
    };
    const bits = attemptGenerationMembershipBuffer(membership);
    if (bits === null || countSetBits(bits) !== segment['setBitCount']) return null;
    segments.push({
      ...membership,
      insertedCount,
      setBitCount,
    });
  }
  const observedSaturation = segments.some((segment) =>
    membershipSegmentFalsePositiveRate(segment) > MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE);
  if (value['quality'] === 'healthy' && observedSaturation) return null;
  if (value['quality'] === 'saturated' &&
    !observedSaturation && segments.length !== MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) return null;
  return {
    algorithm: 'segmented-sha256-bloom-v1',
    maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
    quality: value['quality'],
    segments,
  };
}

function membershipSegmentFalsePositiveRate(segment: AttemptGenerationMembershipSegment): number {
  return (segment.setBitCount / ATTEMPT_BLOCKED_MEMBERSHIP_BITS) ** ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
}

function membershipSetFalsePositiveRate(membership: AttemptGenerationMembershipSet): number {
  return Math.min(1, membership.segments.reduce(
    (total, segment) => total + membershipSegmentFalsePositiveRate(segment), 0,
  ));
}

function membershipSetSaturated(membership: AttemptGenerationMembershipSet): boolean {
  return membership.quality === 'saturated';
}

function attemptGenerationMembershipIndexes(generationId: string): number[] {
  const digest = createHash('sha256')
    .update('ashlr:dispatch-attempt-generation-membership:v1\0', 'utf8')
    .update(generationId, 'utf8')
    .digest();
  return Array.from({ length: ATTEMPT_BLOCKED_MEMBERSHIP_HASHES }, (_, index) =>
    digest.readUInt32BE(index * 4) % ATTEMPT_BLOCKED_MEMBERSHIP_BITS);
}

function attemptGenerationMembershipHas(
  membership: AttemptGenerationMembershipSet,
  generationId: string,
): boolean {
  return membership.segments.some((segment) => {
    const bits = attemptGenerationMembershipBuffer(segment);
    if (bits === null) throw new Error('invalid attempt generation membership');
    return attemptGenerationMembershipIndexes(generationId).every((index) =>
      (bits[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0);
  });
}

function setAttemptGenerationMembershipBits(bits: Buffer, generationId: string): void {
  for (const index of attemptGenerationMembershipIndexes(generationId)) {
    bits[Math.floor(index / 8)]! |= 1 << (index % 8);
  }
}

function addAttemptGenerationMembership(
  membership: AttemptGenerationMembershipSet,
  generationIds: Iterable<string>,
): AttemptGenerationMembershipSet {
  if (membership.quality === 'saturated') throw new AttemptMembershipSaturatedError(membership);
  const segments = membership.segments.map((segment) => ({ ...segment }));
  for (const generationId of generationIds) {
    if (attemptGenerationMembershipHas({ ...membership, segments }, generationId)) continue;
    let active = segments.at(-1)!;
    let bits = attemptGenerationMembershipBuffer(active);
    if (bits === null) throw new Error('invalid attempt generation membership');
    const candidate = Buffer.from(bits);
    setAttemptGenerationMembershipBits(candidate, generationId);
    const candidateSetBits = countSetBits(candidate);
    const candidateRate = (candidateSetBits / ATTEMPT_BLOCKED_MEMBERSHIP_BITS) **
      ATTEMPT_BLOCKED_MEMBERSHIP_HASHES;
    if (candidateRate > MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE) {
      if (segments.length >= MAX_ATTEMPT_BLOCKED_MEMBERSHIP_SEGMENTS) {
        throw new AttemptMembershipSaturatedError({
          ...membership,
          quality: 'saturated',
          segments,
        });
      }
      active = membershipSegment(emptyAttemptGenerationMembership());
      segments.push(active);
      bits = attemptGenerationMembershipBuffer(active)!;
      setAttemptGenerationMembershipBits(bits, generationId);
    } else bits = candidate;
    segments[segments.length - 1] = {
      ...active,
      bits: bits.toString('base64'),
      insertedCount: active.insertedCount + 1,
      setBitCount: countSetBits(bits),
    };
  }
  return { ...membership, segments };
}

function addAttemptGenerationMembershipPersistingQuality(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
  generationIds: Iterable<string>,
): AttemptGenerationMembershipSet {
  try {
    return addAttemptGenerationMembership(activation.blockedGenerations, generationIds);
  } catch (error) {
    if (error instanceof AttemptMembershipSaturatedError && error.membership) {
      writeAttemptReceiptProtocolActivation(dir, {
        ...activation,
        blockedGenerations: error.membership,
      });
    }
    throw error;
  }
}

function readAttemptReceiptProtocolActivation(
  context?: AttemptReceiptBatchReadContext,
  directoryAlreadyInspected = false,
): AttemptReceiptProtocolActivation | null {
  const path = join(attemptProofReceiptDir(), ATTEMPT_RECEIPT_PROTOCOL_FILE);
  if (!existsSync(path)) return null;
  if (!directoryAlreadyInspected) inspectExactReceiptAuthorityDirectory(attemptProofReceiptDir());
  inspectExactReceiptAuthorityFile(path);
  const remainingBytes = context ? HARD_READ_MAX_BYTES - context.bytesRead : MAX_ATTEMPT_PROTOCOL_BYTES;
  if (remainingBytes <= 0) throw new Error('attempt receipt protocol byte limit');
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_PROTOCOL_BYTES,
    remainingBytes: Math.min(MAX_ATTEMPT_PROTOCOL_BYTES, remainingBytes),
  });
  if (!loaded.ok) throw new Error('invalid attempt receipt protocol activation');
  if (context) context.bytesRead += loaded.bytesRead;
  const parsed: unknown = JSON.parse(loaded.text);
  const protocolKeys = isPlainRecord(parsed) && parsed['schemaVersion'] === 5
    ? new Set([
      'schemaVersion', 'activationId', 'activatedAt', 'acceptsEventsAfter', 'retirementEpoch',
      'generations', 'blockedGenerations',
    ])
    : new Set([
      'schemaVersion', 'activationId', 'activatedAt', 'acceptsEventsAfter', 'generations',
      'blockedGenerations',
    ]);
  if (!isPlainRecord(parsed) ||
    !hasOnlyKeys(parsed, protocolKeys) ||
    (parsed['schemaVersion'] !== 3 && parsed['schemaVersion'] !== 4 && parsed['schemaVersion'] !== 5) ||
    (parsed['schemaVersion'] === 5 &&
      (!Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0)) ||
    typeof parsed['activationId'] !== 'string' || !SHA256_RE.test(parsed['activationId']) ||
    !Array.isArray(parsed['generations']) ||
    parsed['generations'].length > MAX_ATTEMPT_ACTIVE_GENERATIONS) {
    throw new Error('invalid attempt receipt protocol activation');
  }
  const activatedAt = canonicalUtcTimestamp(parsed['activatedAt']);
  const acceptsEventsAfter = canonicalUtcTimestamp(parsed['acceptsEventsAfter']);
  const legacyBlockedBits = parsed['schemaVersion'] === 3
    ? attemptGenerationMembershipBuffer(parsed['blockedGenerations'])
    : null;
  const legacySegment = parsed['schemaVersion'] === 3 && legacyBlockedBits !== null
    ? membershipSegment(parsed['blockedGenerations'] as unknown as AttemptGenerationMembership)
    : null;
  const blockedGenerations = parsed['schemaVersion'] === 3
    ? (legacySegment === null ? null : {
      algorithm: 'segmented-sha256-bloom-v1' as const,
      maxSegmentFalsePositiveRate: MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE as
      typeof MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE,
      quality: membershipSegmentFalsePositiveRate(legacySegment) >
        MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE
        ? 'saturated' as const
        : 'healthy' as const,
      segments: [legacySegment],
    })
    : attemptGenerationMembershipSet(parsed['blockedGenerations']);
  if (activatedAt === null || acceptsEventsAfter === null || blockedGenerations === null ||
    Date.parse(acceptsEventsAfter) > Date.parse(activatedAt)) {
    throw new Error('invalid attempt receipt protocol activation');
  }
  const generations: AttemptReceiptProtocolGeneration[] = [];
  const seen = new Set<string>();
  for (const value of parsed['generations']) {
    if (!isPlainRecord(value) ||
      !hasOnlyKeys(value, new Set(['generationId', 'admittedAt'])) ||
      typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId'])) {
      throw new Error('invalid attempt receipt generation history');
    }
    const admittedAt = canonicalUtcTimestamp(value['admittedAt']);
    if (admittedAt === null || seen.has(value['generationId'])) {
      throw new Error('invalid attempt receipt generation history');
    }
    seen.add(value['generationId']);
    generations.push({
      generationId: value['generationId'],
      admittedAt,
    });
  }
  if (generations.some((generation, index) =>
    index > 0 && generations[index - 1]!.generationId >= generation.generationId)) {
    throw new Error('invalid attempt receipt generation history');
  }
  return {
    schemaVersion: 5,
    activationId: parsed['activationId'],
    activatedAt,
    acceptsEventsAfter,
    retirementEpoch: parsed['schemaVersion'] === 5 ? parsed['retirementEpoch'] as number : 0,
    generations,
    blockedGenerations,
  };
}

export function readDispatchProductionAttemptProtocolQuality(): DispatchProductionAttemptProtocolQuality {
  try {
    const activation = readAttemptReceiptProtocolActivation();
    if (activation === null) {
      const dir = attemptProofReceiptDir();
      if (existsSync(dir)) {
        const stat = lstatSync(dir);
        if (!safeDispatchProductionDirectory(stat) ||
          (process.platform === 'win32' && (() => {
            try { inspectExactReceiptAuthorityDirectory(dir); return false; } catch { return true; }
          })()) || listAttemptReceiptAuthorityArtifacts(dir).length > 0) {
          throw new Error('attempt authority artifacts survive missing protocol');
        }
      }
      return {
        status: 'healthy',
        segmentCount: 0,
        estimatedFalsePositiveRate: 0,
        maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
      };
    }
    validateAttemptReceiptArtifactBindings(attemptProofReceiptDir(), activation);
    const estimatedFalsePositiveRate = membershipSetFalsePositiveRate(activation.blockedGenerations);
    return {
      status: membershipSetSaturated(activation.blockedGenerations) ? 'saturated' : 'healthy',
      segmentCount: activation.blockedGenerations.segments.length,
      estimatedFalsePositiveRate,
      maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
    };
  } catch {
    return {
      status: 'degraded',
      segmentCount: 0,
      estimatedFalsePositiveRate: 1,
      maxFalsePositiveRate: MAX_ATTEMPT_BLOCKED_TOTAL_FALSE_POSITIVE_RATE,
    };
  }
}

function writeAttemptReceiptProtocolActivation(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): void {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, ATTEMPT_RECEIPT_PROTOCOL_FILE);
  const tmp = attemptReceiptStagePath(path);
  const bytes = Buffer.from(`${JSON.stringify(activation)}\n`, 'utf8');
  if (bytes.length > MAX_ATTEMPT_PROTOCOL_BYTES) throw new Error('attempt receipt protocol too large');
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt receipt protocol write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function listAttemptReceiptAuthorityArtifacts(dir: string): Array<{
  name: string;
  generationId: string | null;
}> {
  const artifacts: Array<{ name: string; generationId: string | null }> = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const generationId = receipt?.[1] ?? intent?.[1] ??
        failureReceipt?.[1] ?? failureIntent?.[1] ?? null;
      if (generationId !== null || entry.name === ATTEMPT_RECEIPT_RETENTION_FILE) {
        artifacts.push({ name: entry.name, generationId });
      }
    }
  } finally { handle.closeSync(); }
  return artifacts;
}

function assertNoAttemptReceiptAuthorityArtifacts(dir: string): void {
  if (listAttemptReceiptAuthorityArtifacts(dir).length > 0) {
    throw new Error('attempt receipt protocol missing with authority artifacts');
  }
}

function validateAttemptReceiptArtifactBindings(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): void {
  const active = new Set(activation.generations.map((generation) => generation.generationId));
  const retention = readAttemptReceiptRetentionState();
  if (retention.present) {
    const validEpoch = !retention.epochBound
      ? retention.pendingGenerations.length > 0 && activation.retirementEpoch === 0
      : retention.pendingGenerations.length === 0
        ? retention.retirementEpoch === activation.retirementEpoch
        : retention.retirementEpoch === activation.retirementEpoch ||
          retention.retirementEpoch === activation.retirementEpoch + 1;
    if (!validEpoch) throw new Error('attempt receipt protocol rollback detected');
  } else if (activation.retirementEpoch !== 0) {
    throw new Error('attempt receipt retention anchor missing');
  }
  const pending = new Set(retention.pendingGenerations);
  for (const artifact of listAttemptReceiptAuthorityArtifacts(dir)) {
    if (artifact.generationId === null || active.has(artifact.generationId)) continue;
    if (!pending.has(artifact.generationId) ||
      !attemptGenerationMembershipHas(activation.blockedGenerations, artifact.generationId)) {
      throw new Error('attempt receipt protocol rollback detected');
    }
  }
}

function ensureAttemptReceiptProtocolActivation(
  dir: string,
  event: DispatchProductionEvent,
): AttemptReceiptProtocolActivation {
  const existing = readAttemptReceiptProtocolActivation();
  if (existing !== null) {
    validateAttemptReceiptArtifactBindings(dir, existing);
    return existing;
  }
  assertNoAttemptReceiptAuthorityArtifacts(dir);
  const partitions = listAttemptProofPartitionDates(dispatchProductionDir(), dirname(dispatchProductionDir()));
  if (!partitions.ok) throw new Error(`attempt receipt activation ${partitions.reason}`);
  const blockedGenerations = readBoundedLegacyAttemptGenerationMembership(partitions.dates);
  if (!blockedGenerations.ok) throw new Error(`attempt receipt activation ${blockedGenerations.reason}`);
  const migratedSegment = membershipSegment(blockedGenerations.membership);
  const activatedAt = new Date().toISOString();
  const acceptsEventsAfter = new Date(Math.min(
    Date.parse(event.ts),
    Date.parse(activatedAt) - MAX_ATTEMPT_FUTURE_SKEW_MS,
  )).toISOString();
  const activation: AttemptReceiptProtocolActivation = {
    schemaVersion: 5,
    activationId: randomBytes(32).toString('hex'),
    activatedAt,
    acceptsEventsAfter,
    retirementEpoch: 0,
    generations: [],
    blockedGenerations: {
      ...emptyAttemptGenerationMembershipSet(),
      quality: membershipSegmentFalsePositiveRate(migratedSegment) >
        MAX_ATTEMPT_BLOCKED_SEGMENT_FALSE_POSITIVE_RATE ? 'saturated' : 'healthy',
      segments: [migratedSegment],
    },
  };
  writeAttemptReceiptProtocolActivation(dir, activation);
  return activation;
}

function admitAttemptReceiptGeneration(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
  event: DispatchProductionEvent,
): AttemptReceiptProtocolActivation {
  const generationId = event.repairGenerationId!;
  const existing = activation.generations.find((generation) => generation.generationId === generationId);
  if (existing) return activation;
  if (membershipSetSaturated(activation.blockedGenerations)) {
    throw new AttemptMembershipSaturatedError(activation.blockedGenerations);
  }
  if (attemptGenerationMembershipHas(activation.blockedGenerations, generationId)) {
    throw new Error('attempt proof generation blocked');
  }
  if (activation.generations.length >= MAX_ATTEMPT_ACTIVE_GENERATIONS) {
    activation = reclaimArtifactlessAttemptGenerations(dir, activation);
    if (activation.generations.length >= MAX_ATTEMPT_ACTIVE_GENERATIONS) {
      throw new Error('attempt active generation capacity unavailable');
    }
  }
  if (Date.parse(event.ts) < Date.parse(activation.acceptsEventsAfter)) {
    throw new Error('attempt event predates protocol authority');
  }
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    generations: [...activation.generations, {
      generationId,
      admittedAt: event.ts,
    }].sort((left, right) => left.generationId.localeCompare(right.generationId)),
  };
  writeAttemptReceiptProtocolActivation(dir, next);
  return next;
}

function reclaimArtifactlessAttemptGenerations(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  const artifactGenerations = new Set(listAttemptReceiptAuthorityArtifacts(dir)
    .map((artifact) => artifact.generationId)
    .filter((generationId): generationId is string => generationId !== null));
  const needed = Math.max(1, activation.generations.length - MAX_ATTEMPT_ACTIVE_GENERATIONS + 1);
  const reclaiming = activation.generations
    .filter((generation) => !artifactGenerations.has(generation.generationId))
    .sort((left, right) => Date.parse(left.admittedAt) - Date.parse(right.admittedAt) ||
      left.generationId.localeCompare(right.generationId))
    .slice(0, needed);
  if (reclaiming.length < needed) return activation;
  const blocked = addAttemptGenerationMembershipPersistingQuality(
    dir,
    activation,
    reclaiming.map((generation) => generation.generationId),
  );
  const reclaimingIds = new Set(reclaiming.map((generation) => generation.generationId));
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    generations: activation.generations.filter((generation) => !reclaimingIds.has(generation.generationId)),
    blockedGenerations: blocked,
  };
  // The atomic protocol replacement both retires the abandoned IDs and frees
  // their exact active slots. A crash can expose the old state or the new one,
  // never an admitted ID that was forgotten by both representations.
  writeAttemptReceiptProtocolActivation(dir, next);
  return next;
}

function validateAttemptRetentionArtifact(
  path: string,
  name: string,
  activationId: string,
  batchAssurance?: StableFileBatchAssurance,
): AttemptReceiptRetentionArtifact {
  const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(name);
  const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(name);
  const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(name);
  const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(name);
  const match = receipt ?? intent ?? failureReceipt ?? failureIntent;
  if (!match) throw new Error('invalid attempt receipt filename during retention');
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_READ_ROW_BYTES,
    remainingBytes: MAX_READ_ROW_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  if (!loaded.ok || !loaded.text.endsWith('\n') ||
    loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    throw new Error('invalid attempt receipt envelope during retention');
  }
  const receiptLine = loaded.text.slice(0, -1);
  let envelope: unknown;
  try { envelope = JSON.parse(receiptLine); } catch {
    throw new Error('invalid attempt receipt envelope during retention');
  }
  const failureArtifact = failureReceipt !== null || failureIntent !== null;
  if (!isPlainRecord(envelope) ||
    (envelope['receiptSchemaVersion'] !== 1 && envelope['receiptSchemaVersion'] !== 2) ||
    (envelope['receiptSchemaVersion'] === 2 && !failureArtifact) ||
    !hasOnlyKeys(envelope, envelope['receiptSchemaVersion'] === 2 ? new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'appendAuthority', 'event',
    ]) : new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) ||
    envelope['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
    envelope['activationId'] !== activationId) {
    throw new Error('invalid attempt receipt activation during retention');
  }
  const event = envelope['event'];
  const canonicalLine = JSON.stringify(event);
  const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
  const ts = isPlainRecord(event) ? canonicalUtcTimestamp(event['ts']) : null;
  const appendAuthority = envelope['receiptSchemaVersion'] === 2 && isPlainRecord(event)
    ? parseAttemptFailureAppendAuthority(
        envelope['appendAuthority'], event as unknown as DispatchProductionEvent, canonicalRow,
      )
    : undefined;
  const canonicalEnvelope = envelope['receiptSchemaVersion'] === 2 && appendAuthority
    ? attemptFailureReceiptEnvelope(
        event as unknown as DispatchProductionEvent, activationId, appendAuthority,
      )
    : attemptReceiptEnvelope(event as DispatchProductionEvent, activationId);
  if (ts === null || !canonicalStoredDispatchProductionEvent(event, canonicalLine, ts.slice(0, 10)) ||
    (envelope['receiptSchemaVersion'] === 2 && !appendAuthority) ||
    receiptLine !== canonicalEnvelope) {
    throw new Error('invalid attempt receipt event during retention');
  }
  const authority = failureArtifact
    ? parseDispatchProductionFailureAttemptAuthority(event, canonicalLine)
    : parseDispatchProductionAttemptAuthority(event, canonicalLine);
  const generationId = match[1]!;
  const ordinal = Number(match[2]) as 1 | 2;
  if (authority === null || authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal ||
    (failureArtifact && authority.proof.attemptHash !== match[3]) ||
    authority.proof.eventDigest !== createHash('sha256').update(canonicalLine, 'utf8').digest('hex')) {
    throw new Error('unbound attempt receipt during retention');
  }
  return {
    name,
    generationId,
    ordinal,
    kind: receipt ? 'receipt'
      : intent ? 'intent'
        : failureReceipt ? 'failure-receipt'
          : 'failure-intent',
    eventTs: authority.event.ts,
    eventDigest: authority.proof.eventDigest,
    fileDigest: createHash('sha256').update(loaded.text, 'utf8').digest('hex'),
  };
}

function deleteAttemptReceiptArtifactsForGenerations(
  dir: string,
  generationIds: ReadonlySet<string>,
  activationId: string,
  expectedArtifacts: AttemptReceiptRetentionArtifacts,
): void {
  assertStableDispatchProductionWriteRoot();
  const dropping: AttemptReceiptRetentionArtifact[] = [];
  const expected = Array.isArray(expectedArtifacts)
    ? new Map(expectedArtifacts.map((artifact) => [artifact.name, artifact]))
    : null;
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const generationId = receipt?.[1] ?? intent?.[1] ??
        failureReceipt?.[1] ?? failureIntent?.[1];
      if (!generationId || !generationIds.has(generationId)) continue;
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }

  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe retired attempt receipt batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = validateAttemptRetentionArtifact(
        paths[index]!, batchNames[index]!, activationId, assurance.token,
      );
      const wanted = expected?.get(artifact.name);
      if (wanted && JSON.stringify(artifact) !== JSON.stringify(wanted)) {
        throw new Error('mutated attempt receipt during retention');
      }
      if (expected !== null && expected.size > 0 && !wanted) {
        throw new Error('unexpected attempt receipt during retention');
      }
      dropping.push(artifact);
    }
  }
  if (!Array.isArray(expectedArtifacts)) {
    const observed = attemptRetentionArtifactSet(dropping);
    const expectedDigests = new Set(expectedArtifacts.digests);
    if (observed.count > expectedArtifacts.count ||
      observed.digests.some((digest) => !expectedDigests.has(digest))) {
      throw new Error('mutated compact attempt receipt retention set');
    }
  }

  for (let offset = 0; offset < dropping.length; offset += 512) {
    const paths = dropping.slice(offset, offset + 512)
      .map((artifact) => join(dir, artifact.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe retired attempt receipt batch');
    for (const path of paths) {
      if (!safeDispatchProductionFile(lstatSync(path))) {
        throw new Error('unsafe retired attempt receipt');
      }
    }
  }
  for (const artifact of dropping) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, artifact.name));
  }
  if (dropping.length > 0) fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
}

function recoverAttemptReceiptRetention(
  dir: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  const retention = readAttemptReceiptRetentionState();
  if (retention.pendingGenerations.length === 0) return activation;
  if (retention.droppedThrough === null) throw new Error('invalid pending attempt retention');
  const targetEpoch = retention.epochBound
    ? retention.retirementEpoch
    : activation.retirementEpoch === 0 ? 1 : activation.retirementEpoch;
  if (retention.epochBound && targetEpoch !== activation.retirementEpoch &&
    targetEpoch !== activation.retirementEpoch + 1) {
    throw new Error('invalid pending attempt retention epoch');
  }
  const pending = new Set(retention.pendingGenerations);
  const active = new Set(activation.generations.map((generation) => generation.generationId));
  for (const generationId of pending) {
    if (!active.has(generationId) &&
      !attemptGenerationMembershipHas(activation.blockedGenerations, generationId)) {
      throw new Error('invalid pending attempt retention');
    }
  }
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    retirementEpoch: targetEpoch,
    generations: activation.generations.filter((generation) => !pending.has(generation.generationId)),
    blockedGenerations: addAttemptGenerationMembershipPersistingQuality(dir, activation, pending),
  };
  if (next.generations.length !== activation.generations.length ||
    next.retirementEpoch !== activation.retirementEpoch) {
    writeAttemptReceiptProtocolActivation(dir, next);
  }
  deleteAttemptReceiptArtifactsForGenerations(
    dir, pending, activation.activationId, retention.pendingArtifacts,
  );
  writeAttemptReceiptRetention(
    dir, retention.droppedThrough, targetEpoch, [], [],
  );
  return next;
}

function attemptReceiptEnvelope(event: DispatchProductionEvent, activationId: string): string {
  return JSON.stringify({
    receiptSchemaVersion: 1,
    validation: ATTEMPT_RECEIPT_VALIDATION,
    activationId,
    event,
  });
}

interface AttemptFailureAppendAuthority {
  schemaVersion: 1;
  partitionDate: string;
  appendOffset: number;
  appendBytes: number;
  appendDigest: string;
  fileIdentity: {
    device: string;
    inode: string;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  };
}

function attemptFailureReceiptEnvelope(
  event: DispatchProductionEvent,
  activationId: string,
  appendAuthority: AttemptFailureAppendAuthority,
): string {
  return JSON.stringify({
    receiptSchemaVersion: 2,
    validation: ATTEMPT_RECEIPT_VALIDATION,
    activationId,
    appendAuthority,
    event,
  });
}

function safeBigIntDispatchProductionFile(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1n &&
    (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function attemptFailureAppendAuthority(
  event: DispatchProductionEvent,
  canonicalRow: Buffer,
  stat: BigIntStats,
): AttemptFailureAppendAuthority {
  const size = Number(stat.size);
  if (!safeBigIntDispatchProductionFile(stat) || !Number.isSafeInteger(size) || size < 0) {
    throw new Error('attempt failure partition size unavailable');
  }
  return {
    schemaVersion: 1,
    partitionDate: eventDateString(event.ts),
    appendOffset: size,
    appendBytes: canonicalRow.length,
    appendDigest: createHash('sha256').update(canonicalRow).digest('hex'),
    fileIdentity: {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      size,
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    },
  };
}

function parseAttemptFailureAppendAuthority(
  value: unknown,
  event: DispatchProductionEvent,
  canonicalRow: Buffer,
): AttemptFailureAppendAuthority | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set([
    'schemaVersion', 'partitionDate', 'appendOffset', 'appendBytes',
    'appendDigest', 'fileIdentity',
  ])) || value['schemaVersion'] !== 1 ||
    value['partitionDate'] !== eventDateString(event.ts) ||
    !Number.isSafeInteger(value['appendOffset']) || (value['appendOffset'] as number) < 0 ||
    value['appendBytes'] !== canonicalRow.length ||
    value['appendDigest'] !== createHash('sha256').update(canonicalRow).digest('hex')) return null;
  const identity = value['fileIdentity'];
  if (!isPlainRecord(identity) || !hasOnlyKeys(identity, new Set([
    'device', 'inode', 'size', 'mtimeNs', 'ctimeNs',
  ])) || typeof identity['device'] !== 'string' || !/^\d+$/.test(identity['device']) ||
    typeof identity['inode'] !== 'string' || !/^\d+$/.test(identity['inode']) ||
    identity['size'] !== value['appendOffset'] ||
    typeof identity['mtimeNs'] !== 'string' || !/^-?\d+$/.test(identity['mtimeNs']) ||
    typeof identity['ctimeNs'] !== 'string' || !/^-?\d+$/.test(identity['ctimeNs'])) return null;
  return value as unknown as AttemptFailureAppendAuthority;
}

function failureAppendIdentityMatches(
  authority: AttemptFailureAppendAuthority,
  stat: BigIntStats,
): boolean {
  return safeBigIntDispatchProductionFile(stat) &&
    stat.dev.toString() === authority.fileIdentity.device &&
    stat.ino.toString() === authority.fileIdentity.inode;
}

function inspectFailureAttemptAppend(
  fd: number,
  path: string,
  authority: AttemptFailureAppendAuthority,
  canonicalRow: Buffer,
): 0 | 1 {
  const before = fstatSync(fd, { bigint: true });
  const namedBefore = lstatSync(path, { bigint: true });
  if (!failureAppendIdentityMatches(authority, before) ||
    !failureAppendIdentityMatches(authority, namedBefore) ||
    before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) {
    throw new Error('attempt failure partition identity changed');
  }
  const size = Number(before.size);
  if (!Number.isSafeInteger(size) || size < authority.appendOffset) {
    throw new Error('attempt failure partition truncated');
  }
  if (size === authority.appendOffset) {
    if (before.mtimeNs.toString() !== authority.fileIdentity.mtimeNs ||
      before.ctimeNs.toString() !== authority.fileIdentity.ctimeNs) {
      throw new Error('attempt failure partition mutated before append');
    }
    return 0;
  }
  const appendEnd = authority.appendOffset + authority.appendBytes;
  if (!Number.isSafeInteger(appendEnd) || size < appendEnd) {
    throw new Error('attempt failure partition contains a partial append');
  }
  const exact = Buffer.alloc(authority.appendBytes);
  if (readSync(fd, exact, 0, exact.length, authority.appendOffset) !== exact.length ||
    !exact.equals(canonicalRow) ||
    createHash('sha256').update(exact).digest('hex') !== authority.appendDigest) {
    throw new Error('attempt failure exact append changed');
  }
  const after = fstatSync(fd, { bigint: true });
  const namedAfter = lstatSync(path, { bigint: true });
  if (!sameBigIntSnapshot(before, after) || !sameBigIntSnapshot(namedBefore, namedAfter) ||
    before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) {
    throw new Error('attempt failure partition changed during exact read');
  }
  return 1;
}

function recordAttemptProductionWithReceipt(
  event: DispatchProductionEvent,
  canonicalLine: string,
  append: () => void,
): void {
  assertStableDispatchProductionWriteRoot();
  const dir = attemptProofReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const lock = acquireLocalStoreLock(attemptReceiptLockPath());
  if (!lock) throw new Error('attempt proof receipt lock unavailable');
  let tmp: string | null = null;
  try {
    cleanupStaleAttemptReceiptStages(dir);
    let activation = ensureAttemptReceiptProtocolActivation(dir, event);
    activation = recoverAttemptReceiptRetention(dir, activation);
    activation = admitAttemptReceiptGeneration(dir, activation, event);
    const generationId = event.repairGenerationId!;
    const ordinal = event.repairAttemptOrdinal!;
    const path = join(dir, attemptProofReceiptName(generationId, ordinal));
    const intentPath = attemptReceiptIntentPath(generationId, ordinal);
    const wantedDigest = createHash('sha256').update(canonicalLine, 'utf8').digest('hex');
    if (existsSync(path)) {
      const loaded = readAttemptProofReceipt(generationId, ordinal);
      if (loaded.status !== 'proven' || loaded.authority.proof.eventDigest !== wantedDigest) {
        throw new Error('conflicting attempt proof receipt');
      }
      return;
    }
    if (existsSync(intentPath)) {
      const pending = readAttemptProofReceiptFile(intentPath, generationId, ordinal, true);
      if (pending.status === 'proven') {
        assertStableDispatchProductionWriteRoot();
        renameSync(intentPath, path);
        inspectExactReceiptAuthorityFile(path);
        fsyncDirectory(dir);
        if (pending.authority.proof.eventDigest !== wantedDigest) {
          throw new Error('conflicting committed attempt proof intent');
        }
        return;
      }
      if (pending.status !== 'intent') throw new Error('invalid attempt proof intent');
      assertStableDispatchProductionWriteRoot();
      unlinkSync(intentPath);
      fsyncDirectory(dir);
    }
    const retentionPlan = planAttemptProofReceiptRetention(dir, generationId, activation);
    if (retentionPlan) {
      activation = applyAttemptReceiptRetention(dir, retentionPlan, activation);
    }
    const bytes = Buffer.from(`${attemptReceiptEnvelope(event, activation.activationId)}\n`, 'utf8');
    if (bytes.length > MAX_READ_ROW_BYTES) throw new Error('attempt proof receipt too large');
    tmp = attemptReceiptStagePath(intentPath);
    let fd: number | undefined;
    try {
      fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt proof intent write');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      secureCreatedReceiptTempFile(tmp);
      assertStableDispatchProductionWriteRoot();
      renameSync(tmp, intentPath);
      tmp = null;
      inspectExactReceiptAuthorityFile(intentPath);
      fsyncDirectory(dir);
      dispatchProductionLedgerRetentionHooksForTest?.afterAttemptReceiptIntentAssured?.(intentPath);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    }
    append();
    assertStableDispatchProductionWriteRoot();
    renameSync(intentPath, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (tmp) cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}

function countAttemptReceiptAuthorityArtifacts(dir: string): number {
  let count = 0;
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
        throw new Error('attempt receipt directory scan limit');
      }
      if (ATTEMPT_RECEIPT_FILE_RE.test(entry.name) ||
        ATTEMPT_RECEIPT_INTENT_FILE_RE.test(entry.name) ||
        ATTEMPT_FAILURE_RECEIPT_FILE_RE.test(entry.name) ||
        ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.test(entry.name)) count++;
    }
  } finally { handle.closeSync(); }
  return count;
}

function recordFailureAttemptProductionWithReceipt(
  event: DispatchProductionEvent,
  canonicalLine: string,
): void {
  assertStableDispatchProductionWriteRoot();
  const dir = attemptProofReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const lock = acquireLocalStoreLock(attemptReceiptLockPath());
  if (!lock) throw new Error('attempt failure receipt lock unavailable');
  let tmp: string | null = null;
  try {
    cleanupStaleAttemptReceiptStages(dir);
    let activation = ensureAttemptReceiptProtocolActivation(dir, event);
    activation = recoverAttemptReceiptRetention(dir, activation);
    activation = admitAttemptReceiptGeneration(dir, activation, event);
    const authority = parseDispatchProductionFailureAttemptAuthority(event, canonicalLine);
    if (authority === null) throw new Error('ineligible attempt failure receipt');
    const { repairGenerationId: generationId, repairAttemptOrdinal: ordinal, attemptHash } = authority.proof;
    const path = join(dir, attemptFailureReceiptName(generationId, ordinal, attemptHash));
    const intentPath = attemptFailureReceiptIntentPath(generationId, ordinal, attemptHash);
    if (existsSync(path)) {
      const loaded = readFailureAttemptReceiptFile(path, generationId, ordinal, attemptHash, activation);
      if (loaded.status !== 'proven' || loaded.proof.eventDigest !== authority.proof.eventDigest) {
        throw new Error('conflicting attempt failure receipt');
      }
      return;
    }
    if (existsSync(intentPath)) {
      const pending = readFailureAttemptReceiptFile(
        intentPath, generationId, ordinal, attemptHash, activation,
      );
      if (pending.status === 'proven') {
        if (pending.proof.eventDigest !== authority.proof.eventDigest) {
          throw new Error('conflicting committed attempt failure intent');
        }
        if (!pending.appendAuthority) {
          throw new Error('legacy attempt failure intent append authority unavailable');
        }
        const partition = join(
          dispatchProductionDir(), `${pending.appendAuthority.partitionDate}.jsonl`,
        );
        const partitionLock = acquireLocalStoreLock(`${partition}.lock`);
        if (!partitionLock) throw new Error('attempt failure partition lock unavailable');
        let partitionFd: number | undefined;
        try {
          partitionFd = openSync(
            partition,
            fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
          );
          const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
          const appended = inspectFailureAttemptAppend(
            partitionFd, partition, pending.appendAuthority, canonicalRow,
          );
          if (appended === 0 && writeSync(partitionFd, canonicalRow) !== canonicalRow.length) {
            throw new Error('short attempt failure exact append');
          }
          if (appended === 0) fsyncSync(partitionFd);
          dispatchProductionLedgerRetentionHooksForTest?.afterFailureAttemptAppend?.();
          if (inspectFailureAttemptAppend(
            partitionFd, partition, pending.appendAuthority, canonicalRow,
          ) !== 1) throw new Error('attempt failure exact append did not commit');
          assertStableDispatchProductionWriteRoot();
          renameSync(intentPath, path);
          inspectExactReceiptAuthorityFile(path);
          fsyncDirectory(dir);
          return;
        } finally {
          if (partitionFd !== undefined) {
            try { closeSync(partitionFd); } catch { /* preserve primary failure */ }
          }
          releaseLocalStoreLock(partitionLock);
        }
      }
      throw new Error('invalid attempt failure intent');
    }
    const retentionPlan = planAttemptProofReceiptRetention(dir, generationId, activation);
    if (retentionPlan) {
      activation = applyAttemptReceiptRetention(dir, retentionPlan, activation);
    }
    if (countAttemptReceiptAuthorityArtifacts(dir) >= MAX_ATTEMPT_PROOF_RECEIPTS) {
      throw new Error('attempt failure receipt capacity unavailable');
    }
    const partition = join(dispatchProductionDir(), `${eventDateString(event.ts)}.jsonl`);
    const partitionLock = acquireLocalStoreLock(`${partition}.lock`);
    if (!partitionLock) throw new Error('attempt failure partition lock unavailable');
    let partitionFd: number | undefined;
    try {
      const existed = existsSync(partition);
      partitionFd = openSync(
        partition,
        fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const opened = fstatSync(partitionFd);
      const named = lstatSync(partition);
      if (!safeDispatchProductionFile(opened) || !safeDispatchProductionFile(named) ||
        !sameFile(opened, named)) throw new Error('unsafe attempt failure partition');
      if (!existed) fsyncDirectory(dirname(partition));
      if (opened.size > 0) {
        const tail = Buffer.alloc(1);
        if (readSync(partitionFd, tail, 0, 1, opened.size - 1) !== 1) {
          throw new Error('attempt failure partition tail unavailable');
        }
        if (tail[0] !== 0x0a) {
          if (writeSync(partitionFd, Buffer.from('\n', 'utf8')) !== 1) {
            throw new Error('short attempt failure partition separator append');
          }
          fsyncSync(partitionFd);
        }
      }
      const canonicalRow = Buffer.from(`${canonicalLine}\n`, 'utf8');
      const appendAuthority = attemptFailureAppendAuthority(
        event, canonicalRow, fstatSync(partitionFd, { bigint: true }),
      );
      const bytes = Buffer.from(`${attemptFailureReceiptEnvelope(
        event, activation.activationId, appendAuthority,
      )}\n`, 'utf8');
      if (bytes.length > MAX_ATTEMPT_FAILURE_RECEIPT_BYTES) {
        throw new Error('attempt failure receipt too large');
      }
      tmp = attemptReceiptStagePath(intentPath);
      let fd: number | undefined;
      try {
        fd = openSync(
          tmp,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt failure intent write');
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        secureCreatedReceiptTempFile(tmp);
        assertStableDispatchProductionWriteRoot();
        renameSync(tmp, intentPath);
        tmp = null;
        inspectExactReceiptAuthorityFile(intentPath);
        fsyncDirectory(dir);
      } finally {
        if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
      }
      if (inspectFailureAttemptAppend(
        partitionFd, partition, appendAuthority, canonicalRow,
      ) !== 0) throw new Error('attempt failure append already present before commit');
      if (writeSync(partitionFd, canonicalRow) !== canonicalRow.length) {
        throw new Error('short attempt failure exact append');
      }
      fsyncSync(partitionFd);
      dispatchProductionLedgerRetentionHooksForTest?.afterFailureAttemptAppend?.();
      if (inspectFailureAttemptAppend(
        partitionFd, partition, appendAuthority, canonicalRow,
      ) !== 1) throw new Error('attempt failure exact append did not commit');
      assertStableDispatchProductionWriteRoot();
      renameSync(intentPath, path);
      inspectExactReceiptAuthorityFile(path);
      fsyncDirectory(dir);
      assertStableDispatchProductionWriteRoot();
    } finally {
      if (partitionFd !== undefined) {
        try { closeSync(partitionFd); } catch { /* preserve primary failure */ }
      }
      releaseLocalStoreLock(partitionLock);
    }
  } finally {
    if (tmp) cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}

function readAttemptReceiptRetentionState(): AttemptReceiptRetentionState {
  const path = join(attemptProofReceiptDir(), ATTEMPT_RECEIPT_RETENTION_FILE);
  if (!existsSync(path)) return {
    present: false,
    epochBound: false,
    droppedThrough: null,
    retirementEpoch: 0,
    pendingGenerations: [],
    pendingArtifacts: [],
  };
  inspectExactReceiptAuthorityDirectory(attemptProofReceiptDir());
  inspectExactReceiptAuthorityFile(path);
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_RECEIPT_RETENTION_BYTES,
    remainingBytes: MAX_ATTEMPT_RECEIPT_RETENTION_BYTES,
  });
  if (!loaded.ok) throw new Error('invalid attempt receipt retention marker');
  const parsed: unknown = JSON.parse(loaded.text);
  const retentionKeys = isPlainRecord(parsed) &&
    (parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6)
    ? new Set([
      'schemaVersion', 'droppedThrough', 'retirementEpoch', 'pendingGenerations', 'pendingArtifacts',
    ])
    : isPlainRecord(parsed) && parsed['schemaVersion'] === 3
      ? new Set(['schemaVersion', 'droppedThrough', 'pendingGenerations', 'pendingArtifacts'])
      : new Set(['schemaVersion', 'droppedThrough', 'pendingGenerations']);
  if (!isPlainRecord(parsed) ||
    !hasOnlyKeys(parsed, retentionKeys) ||
    (parsed['schemaVersion'] !== 2 && parsed['schemaVersion'] !== 3 &&
      parsed['schemaVersion'] !== 4 && parsed['schemaVersion'] !== 5 &&
      parsed['schemaVersion'] !== 6) ||
    ((parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6) &&
      (!Number.isSafeInteger(parsed['retirementEpoch']) || (parsed['retirementEpoch'] as number) < 0)) ||
    !Array.isArray(parsed['pendingGenerations']) ||
    parsed['pendingGenerations'].length > MAX_ATTEMPT_PROOF_RECEIPTS) {
    throw new Error('invalid attempt receipt retention marker');
  }
  const droppedThrough = parsed['droppedThrough'] === null
    ? null
    : canonicalUtcTimestamp(parsed['droppedThrough']);
  if (parsed['droppedThrough'] !== null && droppedThrough === null) {
    throw new Error('invalid attempt receipt retention marker');
  }
  const pendingGenerations: string[] = [];
  for (const generationId of parsed['pendingGenerations']) {
    if (typeof generationId !== 'string' || !SHA256_RE.test(generationId)) {
      throw new Error('invalid attempt receipt retention marker');
    }
    pendingGenerations.push(generationId);
  }
  if (pendingGenerations.some((generationId, index) =>
    index > 0 && pendingGenerations[index - 1]! >= generationId)) {
    throw new Error('invalid attempt receipt retention marker');
  }
  let pendingArtifacts: AttemptReceiptRetentionArtifacts = [];
  if (parsed['schemaVersion'] === 3 || parsed['schemaVersion'] === 4 ||
    parsed['schemaVersion'] === 5 || parsed['schemaVersion'] === 6) {
    const compact = parsed['schemaVersion'] === 6 && isPlainRecord(parsed['pendingArtifacts'])
      ? parsed['pendingArtifacts']
      : null;
    if (compact !== null) {
      if (!hasOnlyKeys(compact, new Set(['count', 'digests'])) ||
        !Number.isSafeInteger(compact['count']) || (compact['count'] as number) < 1 ||
        (compact['count'] as number) > MAX_ATTEMPT_PROOF_RECEIPTS ||
        !Array.isArray(compact['digests']) ||
        compact['digests'].length !== compact['count'] ||
        compact['digests'].some((digest) => typeof digest !== 'string' || !SHA256_RE.test(digest)) ||
        compact['digests'].some((digest, index, digests) =>
          index > 0 && String(digests[index - 1]) >= String(digest)) ||
        pendingGenerations.length === 0) {
        throw new Error('invalid attempt receipt retention marker');
      }
      pendingArtifacts = {
        count: compact['count'] as number,
        digests: compact['digests'] as string[],
      };
    } else if (!Array.isArray(parsed['pendingArtifacts']) ||
      parsed['pendingArtifacts'].length > MAX_ATTEMPT_PROOF_RECEIPTS * 2) {
      throw new Error('invalid attempt receipt retention marker');
    } else {
      const parsedArtifacts: AttemptReceiptRetentionArtifact[] = [];
      const seenArtifacts = new Set<string>();
      for (const value of parsed['pendingArtifacts']) {
        if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set([
          'name', 'generationId', 'ordinal', 'kind', 'eventTs', 'eventDigest', 'fileDigest',
        ])) || typeof value['name'] !== 'string' ||
          typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId']) ||
          (value['ordinal'] !== 1 && value['ordinal'] !== 2) ||
          (value['kind'] !== 'receipt' && value['kind'] !== 'intent' &&
            ((parsed['schemaVersion'] !== 5 && parsed['schemaVersion'] !== 6) ||
              (value['kind'] !== 'failure-receipt' && value['kind'] !== 'failure-intent'))) ||
          canonicalUtcTimestamp(value['eventTs']) === null ||
          typeof value['eventDigest'] !== 'string' || !SHA256_RE.test(value['eventDigest']) ||
          typeof value['fileDigest'] !== 'string' || !SHA256_RE.test(value['fileDigest']) ||
          !pendingGenerations.includes(value['generationId']) || seenArtifacts.has(value['name'])) {
          throw new Error('invalid attempt receipt retention marker');
        }
        const expectedName = value['kind'] === 'receipt'
          ? attemptProofReceiptName(value['generationId'], value['ordinal'])
          : value['kind'] === 'intent'
            ? `${value['generationId']}-${value['ordinal']}.intent.json`
            : null;
        const failureMatch = value['kind'] === 'failure-receipt'
          ? ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(value['name'])
          : value['kind'] === 'failure-intent'
            ? ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(value['name'])
            : null;
        if (expectedName !== null ? value['name'] !== expectedName :
          failureMatch?.[1] !== value['generationId'] ||
            Number(failureMatch?.[2]) !== value['ordinal']) {
          throw new Error('invalid attempt receipt retention marker');
        }
        seenArtifacts.add(value['name']);
        parsedArtifacts.push(value as unknown as AttemptReceiptRetentionArtifact);
      }
      parsedArtifacts.sort((left, right) => left.name.localeCompare(right.name));
      pendingArtifacts = parsedArtifacts;
    }
  }
  return {
    present: true,
    epochBound: parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6,
    droppedThrough,
    retirementEpoch: parsed['schemaVersion'] === 4 || parsed['schemaVersion'] === 5 ||
      parsed['schemaVersion'] === 6
      ? parsed['retirementEpoch'] as number
      : 0,
    pendingGenerations,
    pendingArtifacts,
  };
}

function writeAttemptReceiptRetention(
  dir: string,
  droppedThrough: string,
  retirementEpoch: number,
  pendingGenerations: readonly string[],
  pendingArtifacts: readonly AttemptReceiptRetentionArtifact[],
): void {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, ATTEMPT_RECEIPT_RETENTION_FILE);
  const tmp = attemptReceiptStagePath(path);
  const prior = readAttemptReceiptRetentionState();
  if (!Number.isSafeInteger(retirementEpoch) || retirementEpoch < prior.retirementEpoch) {
    throw new Error('invalid attempt receipt retention epoch');
  }
  const priorMs = prior.droppedThrough === null
    ? Number.NEGATIVE_INFINITY
    : Date.parse(prior.droppedThrough);
  const nextMs = Math.max(priorMs, Date.parse(droppedThrough));
  if (!Number.isFinite(nextMs)) throw new Error('invalid attempt receipt retention timestamp');
  const pending = [...new Set(pendingGenerations)].sort();
  if (pending.length > MAX_ATTEMPT_PROOF_RECEIPTS || pending.some((generationId) => !SHA256_RE.test(generationId))) {
    throw new Error('invalid pending attempt retention');
  }
  const sortedArtifacts = [...pendingArtifacts]
    .sort((left, right) => left.name.localeCompare(right.name));
  const marker = {
    schemaVersion: 5,
    droppedThrough: new Date(nextMs).toISOString(),
    retirementEpoch,
    pendingGenerations: pending,
    pendingArtifacts: sortedArtifacts,
  };
  let bytes = Buffer.from(`${JSON.stringify(marker)}\n`);
  if (bytes.length > MAX_ATTEMPT_RECEIPT_RETENTION_BYTES && sortedArtifacts.length > 0) {
    bytes = Buffer.from(`${JSON.stringify({
      ...marker,
      schemaVersion: 6,
      pendingArtifacts: attemptRetentionArtifactSet(sortedArtifacts),
    })}\n`);
  }
  if (bytes.length > MAX_ATTEMPT_RECEIPT_RETENTION_BYTES) {
    throw new Error('attempt receipt retention marker too large');
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short attempt receipt retention write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

interface AttemptReceiptRetentionPlan {
  dropping: Array<AttemptReceiptRetentionArtifact & { ts: string }>;
  droppedThrough: string;
}

function failureAttemptRetentionKey(
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
): string {
  return JSON.stringify([generationId, ordinal, attemptHash]);
}

function failureAttemptRetentionArtifactKey(artifact: AttemptReceiptRetentionArtifact): string | null {
  const match = artifact.kind === 'failure-receipt'
    ? ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(artifact.name)
    : artifact.kind === 'failure-intent'
      ? ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(artifact.name)
      : null;
  return match === null
    ? null
    : failureAttemptRetentionKey(match[1]!, Number(match[2]) as 1 | 2, match[3]!);
}

function failureAttemptRetentionRawDigests(
  text: string,
  wanted: ReadonlySet<string>,
): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  for (const line of text.slice(0, -1).split('\n')) {
    const event: unknown = JSON.parse(line);
    const authority = isPlainRecord(event)
      ? parseDispatchProductionFailureAttemptAuthority(event as unknown as DispatchProductionEvent, line)
      : null;
    if (authority === null) continue;
    const key = failureAttemptRetentionKey(
      authority.proof.repairGenerationId,
      authority.proof.repairAttemptOrdinal,
      authority.proof.attemptHash,
    );
    if (!wanted.has(key)) continue;
    const digests = matches.get(key) ?? new Set<string>();
    digests.add(authority.proof.eventDigest);
    matches.set(key, digests);
  }
  return matches;
}

function validateAttemptRetentionRawBindings(
  artifacts: readonly AttemptReceiptRetentionArtifact[],
): void {
  const byDate = new Map<string, AttemptReceiptRetentionArtifact[]>();
  for (const artifact of artifacts) {
    const date = artifact.eventTs.slice(0, 10);
    const entries = byDate.get(date) ?? [];
    entries.push(artifact);
    byDate.set(date, entries);
  }
  if (byDate.size > HARD_READ_MAX_FILES) throw new Error('attempt retention date limit');
  let remainingBytes = HARD_READ_MAX_BYTES;
  let remainingRows = HARD_READ_MAX_ROWS;
  for (const [date, entries] of byDate) {
    const path = join(dispatchProductionDir(), `${date}.jsonl`);
    if (!existsSync(path)) {
      if (entries.some((entry) => entry.kind === 'receipt' || entry.kind === 'failure-receipt')) {
        throw new Error('attempt receipt raw partition missing during retention');
      }
      continue;
    }
    const loaded = readStableRegularFile(path, {
      anchorPath: dirname(dispatchProductionDir()),
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes,
    });
    if (!loaded.ok) throw new Error('attempt receipt raw partition unavailable during retention');
    remainingBytes -= loaded.bytesRead;
    const wanted = new Set(entries.map((entry) => entry.generationId));
    const parsed = parseAttemptProofPartition(
      loaded.text, loaded.bytesRead, date, remainingRows, new Set(), wanted,
    );
    if (!parsed.ok) throw new Error('attempt receipt raw partition invalid during retention');
    remainingRows -= parsed.rowsRead;
    const failureArtifacts = entries.filter((artifact) =>
      artifact.kind === 'failure-receipt' || artifact.kind === 'failure-intent');
    const failureKeys = new Set(failureArtifacts.map(failureAttemptRetentionArtifactKey)
      .filter((key): key is string => key !== null));
    const failureMatches = failureAttemptRetentionRawDigests(loaded.text, failureKeys);
    for (const artifact of entries) {
      const failureKey = failureAttemptRetentionArtifactKey(artifact);
      if (failureKey !== null) {
        const digests = failureMatches.get(failureKey) ?? new Set<string>();
        if (digests.size === 0) {
          if (artifact.kind === 'failure-receipt') {
            throw new Error('attempt failure receipt raw event missing during retention');
          }
          continue;
        }
        if (digests.size !== 1 || !digests.has(artifact.eventDigest)) {
          throw new Error('attempt failure receipt raw digest conflict during retention');
        }
        continue;
      }
      const sameOrdinal = [...new Map((parsed.sequenceMatches.get(artifact.generationId) ?? [])
        .filter((match) => match.ordinal === artifact.ordinal)
        .map((match) => [match.eventDigest, match])).values()];
      if (sameOrdinal.length === 0) {
        if (artifact.kind === 'receipt') throw new Error('attempt receipt raw event missing during retention');
        continue;
      }
      if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
        sameOrdinal[0]!.eventDigest !== artifact.eventDigest) {
        throw new Error('attempt receipt raw digest conflict during retention');
      }
    }
  }
}

function planAttemptProofReceiptRetention(
  dir: string,
  preservedGenerationId: string,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptRetentionPlan | null {
  const receipts: Array<AttemptReceiptRetentionArtifact & { ts: string }> = [];
  const generations = new Map(activation.generations.map((generation) => [generation.generationId, generation]));
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_ATTEMPT_RECEIPT_DIR_ENTRIES) {
        throw new Error('attempt receipt directory limit');
      }
      const receipt = ATTEMPT_RECEIPT_FILE_RE.exec(entry.name);
      const intent = ATTEMPT_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const failureReceipt = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
      const failureIntent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
      const match = receipt ?? intent ?? failureReceipt ?? failureIntent;
      if (!match) continue;
      const generation = generations.get(match[1]!);
      if (!generation) throw new Error('unbound attempt receipt during retention');
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe attempt receipt retention batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = validateAttemptRetentionArtifact(
        paths[index]!, batchNames[index]!, activation.activationId, assurance.token,
      );
      const generation = generations.get(artifact.generationId);
      if (!generation) throw new Error('unbound attempt receipt during retention');
      receipts.push({ ...artifact, ts: generation.admittedAt });
    }
  }
  validateAttemptRetentionRawBindings(receipts);
  if (receipts.length < MAX_ATTEMPT_PROOF_RECEIPTS) return null;

  const byGeneration = new Map<string, Array<AttemptReceiptRetentionArtifact & { ts: string }>>();
  for (const receipt of receipts) {
    const group = byGeneration.get(receipt.generationId) ?? [];
    group.push(receipt);
    byGeneration.set(receipt.generationId, group);
  }
  const groups = [...byGeneration.values()]
    .filter((group) => group[0]!.generationId !== preservedGenerationId)
    .sort((left, right) => {
    const leftTs = Math.max(...left.map((receipt) => Date.parse(receipt.ts)));
    const rightTs = Math.max(...right.map((receipt) => Date.parse(receipt.ts)));
    return leftTs - rightTs || left[0]!.generationId.localeCompare(right[0]!.generationId);
    });
  const dropping: Array<AttemptReceiptRetentionArtifact & { ts: string }> = [];
  let remaining = receipts.length;
  for (const group of groups) {
    if (remaining < MAX_ATTEMPT_PROOF_RECEIPTS) break;
    dropping.push(...group);
    remaining -= group.length;
  }
  if (dropping.length === 0) throw new Error('attempt receipt capacity unavailable');
  const droppedThrough = dropping.reduce((latest, receipt) =>
    Date.parse(receipt.eventTs) > Date.parse(latest) ? receipt.eventTs : latest, dropping[0]!.eventTs);
  return { dropping, droppedThrough };
}

function applyAttemptReceiptRetention(
  dir: string,
  plan: AttemptReceiptRetentionPlan,
  activation: AttemptReceiptProtocolActivation,
): AttemptReceiptProtocolActivation {
  if (activation.retirementEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('attempt receipt retirement epoch exhausted');
  }
  const dropping = new Set(plan.dropping.map((receipt) => receipt.generationId));
  const pendingArtifacts = plan.dropping.map(({ ts: _ts, ...artifact }) => artifact);
  const next: AttemptReceiptProtocolActivation = {
    ...activation,
    retirementEpoch: activation.retirementEpoch + 1,
    generations: activation.generations.filter((generation) => !dropping.has(generation.generationId)),
    blockedGenerations: addAttemptGenerationMembershipPersistingQuality(dir, activation, dropping),
  };
  writeAttemptReceiptRetention(
    dir, plan.droppedThrough, next.retirementEpoch, [...dropping], pendingArtifacts,
  );
  dispatchProductionLedgerRetentionHooksForTest?.afterAttemptRetentionMarker?.();
  writeAttemptReceiptProtocolActivation(dir, next);
  deleteAttemptReceiptArtifactsForGenerations(
    dir, dropping, activation.activationId, pendingArtifacts,
  );
  writeAttemptReceiptRetention(dir, plan.droppedThrough, next.retirementEpoch, [], []);
  return next;
}

interface TreatmentOutcomeReceiptArtifact extends TreatmentReceiptTombstone {
  event: DispatchProductionEvent;
  ts: string;
}

function canonicalTreatmentOutcomeReceiptEvent(
  value: unknown,
  line: string,
  name: string,
): value is DispatchProductionEvent {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    !isDispatchProductionEvent(value) || JSON.stringify(value) !== line ||
    canonicalUtcTimestamp(value['ts']) === null ||
    value['basis'] !== 'repair-lifecycle-outcome' ||
    treatmentOutcomeReceiptName(value) !== name ||
    hasOwn(value, 'repairLineageInvalid')) return false;
  try {
    const hashUsesRunId = typeof value.runId === 'string' &&
      generatedRepairLifecycleAttemptHash(value.runId) === value.repairTreatmentAttemptHash;
    const canonicalInput = hashUsesRunId && value.trajectoryId !== undefined
      ? { ...value, trajectoryId: undefined }
      : value;
    const sanitized = sanitizeDispatchProductionEvent(
      canonicalInput,
      { materializeLearningLabel: true },
    );
    if (JSON.stringify(sanitized) === line) return true;

    // v1 learning labels remain semantically validated by the shared
    // sanitizer, which materializes their successor as v2. Immutable v1
    // receipts therefore need byte-preserving recognition without relabeling
    // their historical classifier version.
    const storedLabel = (value as Record<string, unknown>)['learningLabel'];
    const storedClassifierVersion: unknown = isPlainRecord(storedLabel)
      ? storedLabel['classifierVersion']
      : undefined;
    if (
      isPlainRecord(storedLabel) &&
      storedClassifierVersion === 'attempt-shape-v1' &&
      sanitizeProductionAttemptLearningLabel(storedLabel) !== undefined
    ) {
      if (JSON.stringify({ ...sanitized, learningLabel: storedLabel }) === line) return true;
      // Some earliest immutable v1 receipts retained a trajectory id that the
      // current canonical hash path intentionally elides. Revalidate the
      // original envelope for byte compatibility, while retaining the shared
      // sanitizer as the semantic admission gate.
      const legacyEnvelope = sanitizeDispatchProductionEvent(
        value as DispatchProductionEvent,
        { materializeLearningLabel: true },
      );
      return JSON.stringify({ ...legacyEnvelope, learningLabel: storedLabel }) === line;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Current receipts use one canonical JSON line plus a terminal newline. The
 * earliest private receipt writer omitted that final delimiter, so accept only
 * an otherwise canonical single-line object as a legacy framing variant.
 */
function treatmentOutcomeReceiptLine(text: string): string | null {
  if (text.endsWith('\n')) {
    return text.indexOf('\n') === text.length - 1 ? text.slice(0, -1) : null;
  }
  return text.length > 0 && !text.includes('\n') ? text : null;
}

function readTreatmentOutcomeReceiptArtifact(
  path: string,
  name: string,
  batchAssurance?: StableFileBatchAssurance,
): TreatmentOutcomeReceiptArtifact {
  if (!batchAssurance) inspectExactReceiptAuthorityDirectory(treatmentOutcomeReceiptDir());
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_TREATMENT_RECEIPT_BYTES,
    remainingBytes: MAX_TREATMENT_RECEIPT_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  const line = loaded.ok ? treatmentOutcomeReceiptLine(loaded.text) : null;
  if (line === null) {
    throw new Error('invalid treatment outcome receipt');
  }
  if (!batchAssurance) inspectExactReceiptAuthorityFile(path);
  const parsed: unknown = JSON.parse(line);
  if (!canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) {
    throw new Error('unbound treatment outcome receipt');
  }
  return {
    name,
    event: parsed,
    ts: parsed.ts,
    receiptDigest: treatmentOutcomeReceiptDigest(name, parsed),
  };
}

function treatmentOutcomeSourcesFromPartition(
  text: string,
  bytesRead: number,
  date: string,
  remainingRows: number,
): { sources: Map<string, DispatchProductionEvent>; rowsRead: number } {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') !== bytesRead || !text.endsWith('\n')) {
    throw new Error('invalid treatment outcome source partition');
  }
  const sources = new Map<string, DispatchProductionEvent>();
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > remainingRows) throw new Error('treatment outcome source row limit');
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) continue;
    const name = treatmentOutcomeReceiptName(parsed);
    if (name === null || !canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) continue;
    const previous = sources.get(name);
    if (previous && JSON.stringify(previous) !== line) {
      throw new Error('conflicting treatment outcome source identity');
    }
    sources.set(name, parsed);
  }
  return { sources, rowsRead: lines.length };
}

function readRetiredTreatmentOutcomeSources(
  droppedThrough: string,
): Map<string, DispatchProductionEvent> {
  const cutoffMs = Date.parse(droppedThrough);
  if (!Number.isFinite(cutoffMs)) throw new Error('invalid treatment outcome retirement cutoff');
  const dir = dispatchProductionDir();
  const before = lstatSync(dir);
  if (!safeDispatchProductionDirectory(before)) throw new Error('unsafe treatment outcome source directory');
  const partitions = listAttemptProofPartitionDates(dir, dirname(dir));
  if (!partitions.ok) throw new Error(`treatment outcome source ${partitions.reason}`);
  const cutoffDate = droppedThrough.slice(0, 10);
  const dates = partitions.dates.filter((date) => date <= cutoffDate);
  let remainingBytes = HARD_READ_MAX_BYTES;
  let remainingRows = HARD_READ_MAX_ROWS;
  const sources = new Map<string, DispatchProductionEvent>();
  for (const date of dates) {
    const path = join(dir, `${date}.jsonl`);
    const loaded = readStableRegularFile(path, {
      anchorPath: dirname(dir),
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes,
    });
    if (!loaded.ok) throw new Error('treatment outcome source partition unavailable');
    remainingBytes -= loaded.bytesRead;
    const parsed = treatmentOutcomeSourcesFromPartition(
      loaded.text, loaded.bytesRead, date, remainingRows,
    );
    remainingRows -= parsed.rowsRead;
    for (const [name, event] of parsed.sources) {
      if (Date.parse(event.ts) > cutoffMs) continue;
      const previous = sources.get(name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
        throw new Error('conflicting retired treatment outcome source');
      }
      sources.set(name, event);
    }
  }
  const after = lstatSync(dir);
  if (!safeDispatchProductionDirectory(after) || !sameFile(before, after) ||
    before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new Error('treatment outcome source directory changed');
  }
  return sources;
}

function persistTreatmentOutcomeReceipt(event: DispatchProductionEvent, name: string): void {
  assertStableDispatchProductionWriteRoot();
  const dir = treatmentOutcomeReceiptDir();
  ensurePrivateReceiptDirectory(dir);
  const path = join(dir, name);
  const lock = acquireLocalStoreLock(treatmentReceiptLockPath());
  if (!lock) throw new Error('treatment outcome receipt lock unavailable');
  let fd: number | undefined;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const authority = readTreatmentReceiptAuthorityStateForWrite();
    const retention = authority.retention;
    const wantedDigest = treatmentOutcomeReceiptDigest(name, event);
    const tombstone = retention?.tombstones.find((value) => value.name === name);
    const compacted = authority.compactedMarkers.get(name);
    const retired = tombstone ?? compacted;
    if (retired) {
      if (retired.receiptDigest !== wantedDigest) {
        throw new Error('conflicting retired treatment outcome receipt');
      }
      if (existsSync(path)) {
        const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
        if (artifact.receiptDigest !== wantedDigest ||
          JSON.stringify(artifact.event) !== JSON.stringify(event)) {
          throw new Error('conflicting treatment outcome receipt');
        }
      }
      return;
    }
    const retiredSource = retention?.schemaVersion === 1
      ? readRetiredTreatmentOutcomeSources(retention.droppedThrough).get(name)
      : undefined;
    if (retiredSource) {
      if (JSON.stringify(retiredSource) !== JSON.stringify(event)) {
        throw new Error('conflicting retired treatment outcome source');
      }
      return;
    }
    if (existsSync(path)) {
      const artifact = readTreatmentOutcomeReceiptArtifact(path, name);
      if (artifact.receiptDigest !== wantedDigest ||
        JSON.stringify(artifact.event) !== JSON.stringify(event)) {
        throw new Error('conflicting treatment outcome receipt');
      }
      if (retention &&
        Date.parse(artifact.ts) <= Date.parse(retention.droppedThrough)) {
        throw new Error('restored retired treatment outcome receipt');
      }
      if (process.platform === 'win32' && !assurePrivateStoragePath(
        path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
      ).ok) throw new Error('unsafe Windows treatment outcome receipt');
      return;
    }
    if (retention && Date.parse(event.ts) <= Date.parse(retention.droppedThrough)) {
      throw new Error('treatment outcome receipt retirement rollback detected');
    }
    pruneTreatmentOutcomeReceipts(dir);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    if (bytes.length > MAX_TREATMENT_RECEIPT_BYTES) throw new Error('treatment outcome receipt too large');
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment outcome receipt write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok) throw new Error('unsafe Windows treatment outcome receipt');
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
    releaseLocalStoreLock(lock);
  }
}

function writeTreatmentReceiptRetention(
  dir: string,
  prior: TreatmentReceiptRetentionState | null,
  droppedThrough: string,
  additions: readonly TreatmentReceiptTombstone[],
): TreatmentReceiptRetentionState {
  assertStableDispatchProductionWriteRoot();
  const path = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
  const tmp = attemptReceiptStagePath(path);
  const observedAuthority = readTreatmentReceiptAuthorityStateForWrite();
  if (JSON.stringify(observedAuthority.retention) !== JSON.stringify(prior)) {
    throw new Error('treatment receipt retention changed');
  }
  if ((prior?.retirementEpoch ?? 0) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('treatment receipt retirement epoch exhausted');
  }
  let compactedDigest = prior?.compactedDigest ?? emptyTreatmentRetentionCompactedDigest();
  let compactedCount = prior?.compactedCount ?? 0;
  const legacySources = prior?.schemaVersion === 1
    ? readRetiredTreatmentOutcomeSources(prior.droppedThrough)
    : null;
  if (legacySources?.size === 0) {
    throw new Error('legacy treatment outcome retirement source unavailable');
  }
  const legacyTombstones = legacySources
    ? [...legacySources].map(([name, event]) => ({
        name,
        receiptDigest: treatmentOutcomeReceiptDigest(name, event),
      })).sort((left, right) => left.name.localeCompare(right.name))
    : [];
  const inheritedTombstones = prior?.schemaVersion === 1
    ? legacyTombstones
    : (prior?.tombstones ?? []);
  let byName = new Map(inheritedTombstones.map((value) => [value.name, value]));
  for (const addition of additions) {
    const existing = byName.get(addition.name);
    if (existing && existing.receiptDigest !== addition.receiptDigest) {
      throw new Error('conflicting treatment receipt tombstone');
    }
    byName.set(addition.name, {
      name: addition.name,
      receiptDigest: addition.receiptDigest,
    });
  }
  let compactedAdditions: TreatmentReceiptTombstone[] = [];
  if (byName.size > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    const rotating = [...inheritedTombstones]
      .sort((left, right) => left.name.localeCompare(right.name));
    if (rotating.length === 0 ||
      (prior?.compactedCount ?? 0) > Number.MAX_SAFE_INTEGER - rotating.length) {
      throw new Error('treatment receipt tombstone compaction unavailable');
    }
    const compactedByName = new Map(observedAuthority.observedCompactedMarkers);
    for (const tombstone of rotating) {
      const existing = compactedByName.get(tombstone.name);
      if (existing && existing.receiptDigest !== tombstone.receiptDigest) {
        throw new Error('conflicting compacted treatment receipt marker');
      }
      compactedByName.set(tombstone.name, { schemaVersion: 1, ...tombstone });
    }
    const expectedCount = (prior?.compactedCount ?? 0) + rotating.length;
    if (compactedByName.size !== expectedCount) {
      throw new Error('unexpected pending compacted treatment receipt marker');
    }
    const aggregate = treatmentCompactedMarkerAggregate([...compactedByName.values()]);
    compactedDigest = aggregate.digest;
    compactedCount = aggregate.count;
    compactedAdditions = rotating;
    byName = new Map();
    for (const addition of additions) {
      byName.set(addition.name, {
        name: addition.name,
        receiptDigest: addition.receiptDigest,
      });
    }
  } else if (observedAuthority.pendingCompaction) {
    throw new Error('orphan compacted treatment receipt markers without compaction');
  }
  const tombstones = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (tombstones.length > MAX_TREATMENT_RECEIPT_TOMBSTONES) {
    throw new Error('treatment receipt tombstone rollover unavailable');
  }
  const nextMs = Math.max(
    prior ? Date.parse(prior.droppedThrough) : Number.NEGATIVE_INFINITY,
    Date.parse(droppedThrough),
  );
  if (!Number.isFinite(nextMs)) throw new Error('invalid treatment receipt retention timestamp');
  const next: TreatmentReceiptRetentionState = {
    schemaVersion: 3,
    droppedThrough: new Date(nextMs).toISOString(),
    retirementEpoch: (prior?.retirementEpoch ?? 0) + 1,
    previousRetentionDigest: prior === null ? null : treatmentReceiptRetentionDigest(prior),
    compactedDigest,
    compactedCount,
    tombstones,
  };
  const bytes = Buffer.from(`${JSON.stringify(next)}\n`, 'utf8');
  if (bytes.length > MAX_TREATMENT_RECEIPT_RETENTION_BYTES) {
    throw new Error('treatment receipt retention marker too large');
  }
  stabilizeTreatmentReceiptProtocol(dir, prior);
  writeCompactedTreatmentReceiptMarkers(compactedAdditions);
  if (compactedAdditions.length > 0) {
    dispatchProductionLedgerRetentionHooksForTest?.afterTreatmentCompactedMarkers?.();
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment receipt retention write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      path, 'file', 'inspect-existing', { anchorPath: dispatchProductionDir() },
    ).ok) throw new Error('unsafe Windows treatment receipt retention marker');
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
    if (JSON.stringify(readRawTreatmentReceiptRetentionState()) !== JSON.stringify(next) ||
      JSON.stringify(readTreatmentReceiptRetentionState()) !== JSON.stringify(next)) {
      throw new Error('treatment receipt retention installation changed');
    }
    return next;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function writeTreatmentReceiptProtocolState(
  dir: string,
  state: TreatmentReceiptProtocolState,
): void {
  assertStableDispatchProductionWriteRoot();
  const path = treatmentReceiptProtocolPath();
  const tmp = attemptReceiptStagePath(path);
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
  if (bytes.length > MAX_TREATMENT_RECEIPT_PROTOCOL_BYTES) {
    throw new Error('treatment receipt protocol too large');
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment receipt protocol write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    secureCreatedReceiptTempFile(tmp);
    assertStableDispatchProductionWriteRoot();
    renameSync(tmp, path);
    inspectExactReceiptAuthorityFile(path);
    fsyncDirectory(dir);
    assertStableDispatchProductionWriteRoot();
    if (JSON.stringify(readTreatmentReceiptProtocolState()) !== JSON.stringify(state)) {
      throw new Error('treatment receipt protocol installation changed');
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    cleanupDispatchProductionWriteTemp(tmp);
  }
}

function treatmentReceiptProtocolFor(
  state: TreatmentReceiptRetentionState | null,
): TreatmentReceiptProtocolState {
  return {
    schemaVersion: 1,
    retirementEpoch: state?.retirementEpoch ?? 0,
    retentionDigest: state === null ? null : treatmentReceiptRetentionDigest(state),
  };
}

function stabilizeTreatmentReceiptProtocol(
  dir: string,
  state: TreatmentReceiptRetentionState | null,
): void {
  const current = readTreatmentReceiptProtocolState();
  const wanted = treatmentReceiptProtocolFor(state);
  if (JSON.stringify(current) === JSON.stringify(wanted)) return;
  if (current === null) {
    if (state?.schemaVersion === 3) throw new Error('treatment receipt protocol anchor missing');
    writeTreatmentReceiptProtocolState(dir, wanted);
    return;
  }
  if (state?.schemaVersion === 3 &&
    state.retirementEpoch === current.retirementEpoch + 1 &&
    state.previousRetentionDigest === current.retentionDigest) {
    writeTreatmentReceiptProtocolState(dir, wanted);
    return;
  }
  throw new Error('treatment receipt protocol conflict');
}

function pruneTreatmentOutcomeReceipts(dir: string): void {
  assertStableDispatchProductionWriteRoot();
  const authority = readTreatmentReceiptAuthorityStateForWrite();
  const retention = authority.retention;
  if (retention?.schemaVersion !== 1) stabilizeTreatmentReceiptProtocol(dir, retention);
  const names: string[] = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_TREATMENT_RECEIPT_DIR_ENTRIES) throw new Error('treatment receipt directory limit');
      if (!TREATMENT_RECEIPT_FILE_RE.test(entry.name)) continue;
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  let aggregateBytes = 0;
  for (const name of names) {
    const stat = lstatSync(join(dir, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.size < 2 || stat.size > MAX_TREATMENT_RECEIPT_BYTES) {
      throw new Error('invalid treatment receipt allocation');
    }
    aggregateBytes += stat.size;
    if (aggregateBytes > MAX_TREATMENT_RECEIPT_AGGREGATE_BYTES) {
      throw new Error('treatment receipt aggregate byte limit');
    }
  }
  let receipts: TreatmentOutcomeReceiptArtifact[] = [];
  for (let offset = 0; offset < names.length; offset += 512) {
    const batchNames = names.slice(offset, offset + 512);
    const paths = batchNames.map((name) => join(dir, name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt retention batch');
    for (let index = 0; index < batchNames.length; index++) {
      const artifact = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batchNames[index]!, assurance.token,
      );
      receipts.push(artifact);
    }
  }
  const retiredByName = new Map((retention?.tombstones ?? []).map((value) => [value.name, value]));
  for (const [name, compacted] of authority.compactedMarkers) {
    retiredByName.set(name, compacted);
  }
  const overlap = receipts.filter((receipt) => retiredByName.has(receipt.name));
  for (const receipt of overlap) {
    if (retiredByName.get(receipt.name)!.receiptDigest !== receipt.receiptDigest) {
      throw new Error('conflicting treatment receipt retention overlap');
    }
  }
  for (let offset = 0; offset < overlap.length; offset += 512) {
    const batch = overlap.slice(offset, offset + 512);
    const paths = batch.map((receipt) => join(dir, receipt.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt overlap batch');
    for (let index = 0; index < batch.length; index++) {
      const current = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batch[index]!.name, assurance.token,
      );
      if (current.receiptDigest !== batch[index]!.receiptDigest) {
        throw new Error('mutated treatment receipt retention overlap');
      }
    }
  }
  for (const receipt of overlap) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, receipt.name));
  }
  if (overlap.length > 0) fsyncDirectory(dir);
  const overlapped = new Set(overlap.map((receipt) => receipt.name));
  receipts = receipts.filter((receipt) => !overlapped.has(receipt.name));
  if (retention && receipts.some((receipt) =>
    Date.parse(receipt.ts) <= Date.parse(retention.droppedThrough))) {
    throw new Error('restored retired treatment outcome receipt');
  }
  if (receipts.length < MAX_TREATMENT_OUTCOME_RECEIPTS) return;
  receipts.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.name.localeCompare(right.name));
  const minimumDropCount = receipts.length - MAX_TREATMENT_OUTCOME_RECEIPTS + 1;
  const cutoff = Date.parse(receipts[minimumDropCount - 1]!.ts);
  const dropping = receipts.filter((receipt) => Date.parse(receipt.ts) <= cutoff);
  const droppedThrough = dropping.reduce((latest, receipt) =>
    Date.parse(receipt.ts) > Date.parse(latest) ? receipt.ts : latest, dropping[0]!.ts);
  const nextRetention = writeTreatmentReceiptRetention(dir, retention, droppedThrough, dropping);
  for (let offset = 0; offset < dropping.length; offset += 512) {
    const batch = dropping.slice(offset, offset + 512);
    const paths = batch.map((receipt) => join(dir, receipt.name));
    const assurance = assureRetentionFiles(paths, dispatchProductionDir());
    if (!assurance.ok) throw new Error('unsafe treatment receipt deletion batch');
    for (let index = 0; index < batch.length; index++) {
      const current = readTreatmentOutcomeReceiptArtifact(
        paths[index]!, batch[index]!.name, assurance.token,
      );
      if (current.receiptDigest !== batch[index]!.receiptDigest) {
        throw new Error('mutated treatment outcome receipt during retention');
      }
    }
  }
  for (const receipt of dropping) {
    assertStableDispatchProductionWriteRoot();
    unlinkSync(join(dir, receipt.name));
  }
  fsyncDirectory(dir);
  assertStableDispatchProductionWriteRoot();
  writeTreatmentReceiptProtocolState(dir, treatmentReceiptProtocolFor(nextRetention));
}

function appendDispatchProductionLine(path: string, line: string): void {
  assertStableDispatchProductionWriteRoot();
  const lock = acquireLocalStoreLock(`${path}.lock`);
  if (!lock) throw new Error('dispatch production ledger lock unavailable');
  let fd: number | undefined;
  try {
    assertStableDispatchProductionWriteRoot();
    const existed = existsSync(path);
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!safeDispatchProductionFile(opened)) throw new Error('dispatch production ledger is not a safe regular file');
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1) throw new Error('dispatch production ledger tail is unreadable');
      if (tail[0] !== 0x0a && writeSync(fd, '\n', undefined, 'utf8') !== 1) {
        throw new Error('dispatch production ledger separator write was short');
      }
    }
    if (writeSync(fd, line, undefined, 'utf8') !== Buffer.byteLength(line)) {
      throw new Error('dispatch production ledger append was short');
    }
    fsyncSync(fd);
    assertStableDispatchProductionWriteRoot();
    if (!existed) {
      fsyncDirectory(dirname(path));
    }
    assertStableDispatchProductionWriteRoot();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    releaseLocalStoreLock(lock);
  }
}

function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyDispatchProductionRead(
  sourceState: DispatchProductionSourceQuality['sourceState'],
  overrides: Partial<DispatchProductionEventsReadResult> = {},
): DispatchProductionEventsReadResult {
  return {
    events: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    datedFilesRead: 0,
    looseFilesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeDispatchProductionDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function safeDispatchProductionFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && Number(stat.nlink) === 1 &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function readDispatchProductionFileTail(
  path: string,
  maxBytes: number,
): { text: string; bytesRead: number; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (!safeDispatchProductionFile(pathBefore)) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!safeDispatchProductionFile(before) || !sameFile(pathBefore, before)) return null;
    const bytes = Math.min(before.size, maxBytes);
    const start = Math.max(0, before.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const bytesRead = bytes > 0 ? readSync(fd, buffer, 0, bytes, start) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !safeDispatchProductionFile(pathAfter) ||
      !safeDispatchProductionFile(after) ||
      !sameFile(before, after) ||
      !sameFile(after, pathAfter) ||
      after.size !== before.size ||
      bytesRead !== bytes
    ) return null;
    let text: string;
    if (start > 0) {
      const boundaryWasNewline = buffer[0] === 0x0a;
      text = buffer.subarray(1, bytesRead).toString('utf8');
      if (!boundaryWasNewline) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
    } else {
      text = buffer.subarray(0, bytesRead).toString('utf8');
    }
    return { text, bytesRead, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort diagnostics read */ }
    }
  }
}

function pushStopReason(
  reasons: DispatchProductionReadStopReason[],
  reason: DispatchProductionReadStopReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Authority-specific parent lookup. It reads only the dated partitions named
 * by the requested identities, so unrelated history growth cannot revoke a
 * valid repair handoff through the observational reader's global caps.
 */
export function readDispatchProductionParents(
  targets: readonly DispatchProductionParentIdentity[],
): DispatchProductionParentStatus[] {
  const statuses = targets.map((): DispatchProductionParentStatus => 'missing');
  const byDate = new Map<string, number[]>();
  const canonicalRepos = new Map<string, string | null>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const parsed = Date.parse(target.ts);
    if (!Number.isFinite(parsed)) {
      statuses[index] = 'degraded';
      continue;
    }
    const date = new Date(parsed).toISOString().slice(0, 10);
    const indices = byDate.get(date) ?? [];
    indices.push(index);
    byDate.set(date, indices);
  }
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return statuses;
  let directoryBefore: Stats;
  try {
    directoryBefore = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directoryBefore)) throw new Error('unsafe parent directory');
  } catch {
    return statuses.map(() => 'degraded');
  }
  for (const [date, indices] of byDate) {
    const path = join(dir, `${date}.jsonl`);
    if (!existsSync(path)) continue;
    const loaded = readDispatchProductionFileTail(path, HARD_READ_MAX_BYTES);
    if (!loaded) {
      for (const index of indices) statuses[index] = 'degraded';
      continue;
    }
    const complete = loaded.text.endsWith('\n');
    const lines = complete
      ? loaded.text.slice(0, -1).split('\n')
      : loaded.text.split('\n').slice(0, -1);
    const eventsByIdentity = new Map<string, Map<string, DispatchProductionEvent>>();
    let invalid = !complete || loaded.truncated || lines.length > HARD_READ_MAX_ROWS;
    for (const line of lines.slice(0, HARD_READ_MAX_ROWS)) {
      if (!line.trim()) {
        invalid = true;
        continue;
      }
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        invalid = true;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
          invalid = true;
          continue;
        }
        const key = JSON.stringify([
          parsed.ts, parsed.itemId, parsed.repo, parsed.outcome,
          parsed.trajectoryId ?? parsed.runId ?? null,
        ]);
        const semantic = eventsByIdentity.get(key) ?? new Map<string, DispatchProductionEvent>();
        semantic.set(JSON.stringify(parsed), parsed);
        eventsByIdentity.set(key, semantic);
      } catch {
        invalid = true;
      }
    }
    for (const index of indices) {
      if (invalid) {
        statuses[index] = 'degraded';
        continue;
      }
      const target = targets[index]!;
      let targetRepo = canonicalRepos.get(target.repo);
      if (targetRepo === undefined) {
        targetRepo = canonicalDispatchRepoIdentity(target.repo);
        canonicalRepos.set(target.repo, targetRepo);
      }
      if (targetRepo === null) {
        statuses[index] = 'degraded';
        continue;
      }
      const semanticEvents = [...(eventsByIdentity.get(JSON.stringify([
        target.ts, target.itemId, targetRepo, target.outcome, target.attemptId,
      ]))?.values() ?? [])];
      if (semanticEvents.length > 1) {
        statuses[index] = 'degraded';
        continue;
      }
      const event = semanticEvents[0];
      const found = event !== undefined &&
        (target.source === undefined || event.source === target.source) &&
        (target.backend === undefined || event.backend === target.backend) &&
        (target.tier === undefined || event.tier === target.tier) &&
        (target.objectiveHash === undefined || event.objectiveHash === target.objectiveHash);
      statuses[index] = found
        ? 'found'
        : 'missing';
    }
  }
  try {
    const directoryAfter = lstatSync(dir);
    if (
      !safeDispatchProductionDirectory(directoryAfter) ||
      !sameFile(directoryBefore, directoryAfter) ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs
    ) {
      return statuses.map(() => 'degraded');
    }
  } catch {
    return statuses.map(() => 'degraded');
  }
  return statuses;
}

interface ParsedDispatchProductionAttemptAuthority {
  event: DispatchProductionEvent;
  proof: DispatchProductionAttemptProof;
}

interface ParsedDispatchProductionFailureAttemptAuthority {
  event: DispatchProductionEvent;
  proof: DispatchProductionFailureAttemptProof;
}

interface ParsedDispatchProductionPartitionMatch {
  row: ParsedDispatchProductionAttemptAuthority | null;
  event: DispatchProductionEvent;
  eventDigest: string;
  conflict: boolean;
}

interface ParsedDispatchProductionSequenceMatch {
  row: ParsedDispatchProductionAttemptAuthority | null;
  eventDigest: string;
  ordinal: 1 | 2;
  ts: string;
}

type AttemptReceiptCachedPartition =
  | { ok: true; sequenceMatches: Map<string, ParsedDispatchProductionSequenceMatch[]> }
  | { ok: false; reason: DispatchProductionAttemptProofDegradedReason };

interface AttemptReceiptBatchReadContext {
  wantedGenerationIds: ReadonlySet<string>;
  partitionCache: Map<string, AttemptReceiptCachedPartition>;
  partitionDates?: { ok: true; dates: string[] } |
    { ok: false; reason: DispatchProductionAttemptProofDegradedReason };
  filesRead: number;
  bytesRead: number;
  rowsRead: number;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function canonicalUtcTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : null;
}

function boundedStoredText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && scrubSecrets(value) === value &&
    ![...value].some((char) => char.charCodeAt(0) < 32);
}

function validRunTrajectory(value: unknown): value is string {
  return boundedStoredText(value, 240) && value.startsWith('run:') &&
    isSafeExecutionIdentity(value.slice('run:'.length));
}

function canonicalStoredDispatchProductionEvent(
  value: unknown,
  line: string,
  partitionDate: string,
): value is DispatchProductionEvent {
  if (!isPlainRecord(value) || JSON.stringify(value) !== line || !isDispatchProductionEvent(value)) return false;
  try {
    if (JSON.stringify(sanitizeDispatchProductionEvent(value, { materializeLearningLabel: true })) !== line) {
      return false;
    }
  } catch {
    return false;
  }
  const ts = canonicalUtcTimestamp(value['ts']);
  if (ts === null || ts.slice(0, 10) !== partitionDate) return false;
  if (!WORK_SOURCES.has(value['source'] as WorkItem['source'])) return false;
  if (!DISPATCH_PRODUCTION_OUTCOMES.has(value['outcome'] as DaemonDispatchProductionOutcome)) return false;
  if (!DISPATCH_PRODUCTION_BASES.has(value['basis'] as DispatchProductionBasis)) return false;
  if (value['backend'] !== null && !ENGINE_IDS.has(value['backend'] as EngineId)) return false;
  if (value['tier'] !== null && !ENGINE_TIERS.has(value['tier'] as EngineTier)) return false;
  if (hasOwn(value, 'model') && value['model'] !== null && !boundedStoredText(value['model'], 160)) return false;
  return true;
}

function parseDispatchProductionReceiptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionAttemptAuthority | null {
  const raw = event as unknown as Record<string, unknown>;
  const proposalCreated = event.outcome === 'proposal-created';
  const failedAttempt = ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome);
  const emptyAttempt = event.outcome === 'empty-diff';
  const diagnosticAttempt = /:proposal-repair-nodiff:[0-9a-f]{12}$/.test(event.itemId) &&
    SHA256_RE.test(event.repairTreatmentUnitId ?? '') &&
    REPAIR_TREATMENTS.includes(event.repairTreatment as RepairTreatment) &&
    repairTreatmentForUnitId(event.repairTreatmentUnitId!) === event.repairTreatment;
  const genericAttempt = /:proposal-repair(?:-capture)?:[0-9a-f]{12}$/.test(event.itemId) &&
    !hasOwn(raw, 'repairTreatmentUnitId') && !hasOwn(raw, 'repairTreatment') &&
    SHA256_RE.test(event.repairRootId ?? '') &&
    (event.repairDepth === 0 || event.repairDepth === 1);
  if (
    !hasOnlyKeys(raw, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    event.basis !== 'run-proposal-outcome' ||
    (!emptyAttempt && !proposalCreated && !failedAttempt) ||
    event.proposalCreated !== proposalCreated ||
    (proposalCreated
      ? !boundedStoredText(event.proposalId, 160) || !isSafeExecutionIdentity(event.proposalId)
      : hasOwn(raw, 'proposalId')) ||
    hasOwn(raw, 'repairLineageInvalid') ||
    hasOwn(raw, 'repairTreatmentOutcome') ||
    hasOwn(raw, 'repairTreatmentAttemptHash') ||
    !boundedStoredText(event.itemId, 240) ||
    (!diagnosticAttempt && !genericAttempt) ||
    !boundedStoredText(event.title, 160) ||
    !boundedStoredText(event.assignedBy, 80) ||
    !boundedStoredText(event.routeReason, 240) ||
    event.source !== 'self' ||
    !ENGINE_IDS.has(event.backend as EngineId) ||
    event.backend === null || event.backend === 'builtin' ||
    !ENGINE_TIERS.has(event.tier as EngineTier) ||
    event.tier === null ||
    (hasOwn(raw, 'model') && event.model !== null && !boundedStoredText(event.model, 160)) ||
    !isSafeExecutionIdentity(event.runId) ||
    !validRunTrajectory(event.trajectoryId) ||
    (genericAttempt && event.trajectoryId !== `run:${event.runId}`) ||
    !SHA256_RE.test(event.objectiveHash ?? '') ||
    event.learningSource !== 'daemon-dispatch' ||
    event.labelBasis !== 'dispatch-outcome' ||
    !boundedStoredText(event.routerPolicyVersion, 80) ||
    !SHA256_RE.test(event.repairGenerationId ?? '') ||
    (diagnosticAttempt && (!SHA256_RE.test(event.repairHandoffId ?? '') ||
      repairGenerationIdFromHandoffId(event.repairHandoffId!) !== event.repairGenerationId)) ||
    (genericAttempt && hasOwn(raw, 'repairHandoffId') &&
      !SHA256_RE.test(event.repairHandoffId ?? '')) ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
    (diagnosticAttempt && (failedAttempt
      ? !SHA256_RE.test(event.repairRootId ?? '') ||
        (event.repairDepth !== 0 && event.repairDepth !== 1)
      : hasOwn(raw, 'repairRootId') || hasOwn(raw, 'repairDepth'))) ||
    !Number.isFinite(event.spentUsd) || event.spentUsd < 0 ||
    (emptyAttempt && event.diffFiles !== undefined && event.diffFiles !== 0) ||
    (emptyAttempt && event.diffLines !== undefined && event.diffLines !== 0)
  ) return null;

  if (event.repairAttemptOrdinal === 1) {
    if (hasOwn(raw, 'repairPreviousBackend')) return null;
  } else if (
    !ENGINE_IDS.has(event.repairPreviousBackend as EngineId) ||
    event.repairPreviousBackend === 'builtin' ||
    event.repairPreviousBackend === event.backend
  ) return null;

  const route = event.routeSnapshot;
  if (!isPlainRecord(route) ||
    JSON.stringify(normalizeRouteSnapshot(route)) !== JSON.stringify(route) ||
    route['backend'] !== event.backend ||
    route['tier'] !== event.tier ||
    hasOwn(route, 'model') !== hasOwn(raw, 'model') ||
    (hasOwn(route, 'model') && route['model'] !== event.model) ||
    route['assignedBy'] !== event.assignedBy ||
    route['routerPolicyVersion'] !== event.routerPolicyVersion) return null;

  const summary = event.runEventSummary;
  if (!isPlainRecord(summary) ||
    JSON.stringify(normalizeRunEventSummary(summary)) !== JSON.stringify(summary) ||
    summary['runId'] !== event.runId ||
    (failedAttempt
      ? summary['status'] !== 'done' && summary['status'] !== 'failed' && summary['status'] !== 'aborted'
      : summary['status'] !== 'done') ||
    summary['outcome'] !== event.outcome ||
    summary['proposalCreated'] !== proposalCreated ||
    (proposalCreated
      ? summary['proposalId'] !== event.proposalId
      : hasOwn(summary, 'proposalId')) ||
    summary['costUsd'] !== event.spentUsd ||
    (emptyAttempt && hasOwn(summary, 'diffFiles') && summary['diffFiles'] !== 0) ||
    (emptyAttempt && hasOwn(summary, 'diffLines') && summary['diffLines'] !== 0) ||
    (event.diffFiles !== undefined && summary['diffFiles'] !== undefined &&
      summary['diffFiles'] !== event.diffFiles) ||
    (event.diffLines !== undefined && summary['diffLines'] !== undefined &&
      summary['diffLines'] !== event.diffLines)) return null;

  const actionCounts = summary['actionCounts'];
  if (actionCounts !== undefined && (!isPlainRecord(actionCounts) ||
    (emptyAttempt && hasOwn(actionCounts, 'diffFiles') && actionCounts['diffFiles'] !== 0) ||
    (emptyAttempt && hasOwn(actionCounts, 'diffLines') && actionCounts['diffLines'] !== 0) ||
    (hasOwn(actionCounts, 'proposalCreated') &&
      actionCounts['proposalCreated'] !== (proposalCreated ? 1 : 0)) ||
    (event.diffFiles !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== event.diffFiles) ||
    (summary['diffFiles'] !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== summary['diffFiles']) ||
    (event.diffLines !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== event.diffLines) ||
    (summary['diffLines'] !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== summary['diffLines']))) return null;

  return {
    event,
    proof: {
      schemaVersion: 1,
      integrityClass: 'owner-writable-local',
      cryptographicallyTrusted: false,
      rollbackProtected: false,
      eventTs: event.ts,
      eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
      attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId),
      backend: event.backend,
      tier: event.tier,
      model: event.model ?? null,
      previousBackend: event.repairAttemptOrdinal === 2
        ? event.repairPreviousBackend as Exclude<EngineId, 'builtin'>
        : null,
      repairHandoffId: event.repairHandoffId!,
      repairGenerationId: event.repairGenerationId!,
      repairTreatmentUnitId: event.repairTreatmentUnitId!,
      repairTreatment: event.repairTreatment!,
      repairAttemptOrdinal: event.repairAttemptOrdinal,
    },
  };
}

function parseDispatchProductionAttemptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionAttemptAuthority | null {
  const authority = parseDispatchProductionReceiptAuthority(event, line);
  return authority !== null && !ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome)
    ? authority
    : null;
}

function parseDispatchProductionFailureAttemptAuthority(
  event: DispatchProductionEvent,
  line: string,
): ParsedDispatchProductionFailureAttemptAuthority | null {
  const diagnostic = parseDispatchProductionReceiptAuthority(event, line);
  if (diagnostic !== null && ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome)) {
    return diagnostic;
  }

  const raw = event as unknown as Record<string, unknown>;
  if (
    !hasOnlyKeys(raw, DISPATCH_PRODUCTION_EVENT_KEYS) ||
    event.basis !== 'run-proposal-outcome' ||
    !ATTEMPT_RECEIPT_FAILURE_OUTCOMES.has(event.outcome) ||
    event.proposalCreated || hasOwn(raw, 'proposalId') ||
    hasOwn(raw, 'repairLineageInvalid') ||
    hasOwn(raw, 'repairTreatmentUnitId') || hasOwn(raw, 'repairTreatment') ||
    hasOwn(raw, 'repairTreatmentOutcome') || hasOwn(raw, 'repairTreatmentAttemptHash') ||
    !boundedStoredText(event.itemId, 240) ||
    !/:proposal-repair(?:-capture)?:[0-9a-f]{12}$/.test(event.itemId) ||
    !boundedStoredText(event.title, 160) ||
    !boundedStoredText(event.assignedBy, 80) ||
    !boundedStoredText(event.routeReason, 240) ||
    event.source !== 'self' ||
    !ENGINE_IDS.has(event.backend as EngineId) ||
    event.backend === null || event.backend === 'builtin' ||
    !ENGINE_TIERS.has(event.tier as EngineTier) || event.tier === null ||
    (hasOwn(raw, 'model') && event.model !== null && !boundedStoredText(event.model, 160)) ||
    !isSafeExecutionIdentity(event.runId) ||
    !validRunTrajectory(event.trajectoryId) || event.trajectoryId !== `run:${event.runId}` ||
    !SHA256_RE.test(event.objectiveHash ?? '') ||
    event.learningSource !== 'daemon-dispatch' ||
    event.labelBasis !== 'dispatch-outcome' ||
    !boundedStoredText(event.routerPolicyVersion, 80) ||
    !SHA256_RE.test(event.repairHandoffId ?? '') ||
    !SHA256_RE.test(event.repairGenerationId ?? '') ||
    repairGenerationIdFromHandoffId(event.repairHandoffId!) !== event.repairGenerationId ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2) ||
    !SHA256_RE.test(event.repairRootId ?? '') ||
    (event.repairDepth !== 0 && event.repairDepth !== 1) ||
    !Number.isFinite(event.spentUsd) || event.spentUsd < 0
  ) return null;

  if (event.repairAttemptOrdinal === 1) {
    if (hasOwn(raw, 'repairPreviousBackend')) return null;
  } else if (
    !ENGINE_IDS.has(event.repairPreviousBackend as EngineId) ||
    event.repairPreviousBackend === 'builtin' ||
    event.repairPreviousBackend === event.backend
  ) return null;

  const route = event.routeSnapshot;
  if (!isPlainRecord(route) ||
    JSON.stringify(normalizeRouteSnapshot(route)) !== JSON.stringify(route) ||
    route['backend'] !== event.backend || route['tier'] !== event.tier ||
    hasOwn(route, 'model') !== hasOwn(raw, 'model') ||
    (hasOwn(route, 'model') && route['model'] !== event.model) ||
    route['assignedBy'] !== event.assignedBy ||
    route['routerPolicyVersion'] !== event.routerPolicyVersion) return null;

  const summary = event.runEventSummary;
  if (!isPlainRecord(summary) ||
    JSON.stringify(normalizeRunEventSummary(summary)) !== JSON.stringify(summary) ||
    summary['runId'] !== event.runId ||
    (summary['status'] !== 'done' && summary['status'] !== 'failed' && summary['status'] !== 'aborted') ||
    summary['outcome'] !== event.outcome || summary['proposalCreated'] !== false ||
    hasOwn(summary, 'proposalId') || summary['costUsd'] !== event.spentUsd ||
    (event.diffFiles !== undefined && summary['diffFiles'] !== undefined &&
      summary['diffFiles'] !== event.diffFiles) ||
    (event.diffLines !== undefined && summary['diffLines'] !== undefined &&
      summary['diffLines'] !== event.diffLines)) return null;

  const actionCounts = summary['actionCounts'];
  if (actionCounts !== undefined && (!isPlainRecord(actionCounts) ||
    (hasOwn(actionCounts, 'proposalCreated') && actionCounts['proposalCreated'] !== 0) ||
    (event.diffFiles !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== event.diffFiles) ||
    (summary['diffFiles'] !== undefined && actionCounts['diffFiles'] !== undefined &&
      actionCounts['diffFiles'] !== summary['diffFiles']) ||
    (event.diffLines !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== event.diffLines) ||
    (summary['diffLines'] !== undefined && actionCounts['diffLines'] !== undefined &&
      actionCounts['diffLines'] !== summary['diffLines']))) return null;

  return {
    event,
    proof: {
      schemaVersion: 1,
      integrityClass: 'owner-writable-local',
      cryptographicallyTrusted: false,
      rollbackProtected: false,
      eventTs: event.ts,
      eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
      attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId),
      backend: event.backend,
      tier: event.tier,
      model: event.model ?? null,
      previousBackend: event.repairAttemptOrdinal === 2
        ? event.repairPreviousBackend as Exclude<EngineId, 'builtin'>
        : null,
      repairHandoffId: event.repairHandoffId!,
      repairGenerationId: event.repairGenerationId!,
      repairAttemptOrdinal: event.repairAttemptOrdinal,
    },
  };
}

function validDispatchProductionAttemptProofTarget(
  target: DispatchProductionAttemptProofTarget,
): { date: string; sequenceStartDate: string; sequenceEndDate: string; repo: string } | null {
  if (!isPlainRecord(target)) return null;
  const ts = canonicalUtcTimestamp(target.ts);
  const sequenceStartTs = canonicalUtcTimestamp(target.sequenceStartTs ?? target.ts);
  const sequenceEndTs = canonicalUtcTimestamp(target.sequenceEndTs ?? target.ts);
  const repo = canonicalDispatchRepoIdentity(target.repo);
  const proposalCreated = target.outcome === 'proposal-created';
  if (
    ts === null || sequenceStartTs === null || sequenceEndTs === null ||
    Date.parse(sequenceStartTs) > Date.parse(ts) || Date.parse(ts) > Date.parse(sequenceEndTs) || repo === null ||
    !boundedStoredText(target.itemId, 240) ||
    !/:proposal-repair-nodiff:[0-9a-f]{12}$/.test(target.itemId) ||
    target.source !== 'self' ||
    (target.outcome !== 'empty-diff' && target.outcome !== 'proposal-created') ||
    (proposalCreated
      ? !boundedStoredText(target.proposalId, 160) || !isSafeExecutionIdentity(target.proposalId)
      : hasOwn(target, 'proposalId')) ||
    !SHA256_RE.test(target.objectiveHash) ||
    !SHA256_RE.test(target.repairHandoffId) ||
    !SHA256_RE.test(target.repairGenerationId) ||
    repairGenerationIdFromHandoffId(target.repairHandoffId) !== target.repairGenerationId ||
    !SHA256_RE.test(target.repairTreatmentUnitId) ||
    !REPAIR_TREATMENTS.includes(target.repairTreatment) ||
    repairTreatmentForUnitId(target.repairTreatmentUnitId) !== target.repairTreatment ||
    (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)
  ) return null;
  return {
    date: ts.slice(0, 10),
    sequenceStartDate: sequenceStartTs.slice(0, 10),
    sequenceEndDate: sequenceEndTs.slice(0, 10),
    repo,
  };
}

function sameBigIntSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function safeBigIntDirectory(stat: BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (process.platform === 'win32' || typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
    (process.platform === 'win32' || (stat.mode & 0o022n) === 0n);
}

function stablyMissingDispatchProductionDirectory(dir: string): boolean {
  const root = dirname(dir);
  try {
    const before = lstatSync(root, { bigint: true });
    if (!safeBigIntDirectory(before)) return false;
    const realBefore = realpathSync(root);
    if (process.platform === 'win32' && !assurePrivateStoragePath(
      root,
      'directory',
      'inspect-owned',
      { anchorPath: root },
    ).ok) return false;
    try {
      lstatSync(dir);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const after = lstatSync(root, { bigint: true });
    try {
      lstatSync(dir);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    return safeBigIntDirectory(after) && sameBigIntSnapshot(before, after) && realBefore === realpathSync(root);
  } catch {
    return false;
  }
}

function attemptProofReadReason(reason: StableFileReadFailureReason): DispatchProductionAttemptProofDegradedReason {
  switch (reason) {
    case 'unsafe-path':
    case 'unsafe-file':
      return 'source-unsafe';
    case 'changed-during-read':
      return 'source-mutated';
    case 'per-file-byte-limit':
    case 'byte-limit':
      return 'partition-byte-limit';
    default:
      return 'partition-unreadable';
  }
}

function attemptProofLookupKey(ts: string, itemId: string, repo: string): string {
  return JSON.stringify([ts, itemId, repo]);
}

function stablyMissingAttemptProofPartition(
  dir: string,
  path: string,
  root: string,
): DispatchProductionAttemptWitnessResolution {
  const guard = openStableDirectoryGuard(dir, { anchorPath: root });
  if (!guard.ok) {
    const reason = guard.reason === 'unsafe-path' || guard.reason === 'unsafe-file'
      ? 'source-unsafe'
      : guard.reason === 'missing'
        ? 'source-mutated'
        : attemptProofReadReason(guard.reason);
    return { status: 'degraded', reason };
  }
  let missing = false;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
  }
  const guardFailure = guard.finish();
  if (guardFailure !== null || !missing) return { status: 'degraded', reason: 'source-mutated' };
  return { status: 'missing', reason: 'partition-missing' };
}

function attemptSequenceKey(target: DispatchProductionAttemptProofTarget, repo: string): string {
  void repo;
  return target.repairGenerationId;
}

function attemptSequenceKeyFromEvent(event: DispatchProductionEvent): string | null {
  if (
    event.basis !== 'run-proposal-outcome' ||
    typeof event.repairGenerationId !== 'string' ||
    (event.repairAttemptOrdinal !== 1 && event.repairAttemptOrdinal !== 2)
  ) return null;
  return event.repairGenerationId;
}

function listAttemptProofPartitionDates(
  dir: string,
  root: string,
): { ok: true; dates: string[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const guard = openStableDirectoryGuard(dir, { anchorPath: root });
  if (!guard.ok) {
    return {
      ok: false,
      reason: guard.reason === 'unsafe-path' || guard.reason === 'unsafe-file'
        ? 'source-unsafe'
        : guard.reason === 'missing'
          ? 'source-mutated'
          : attemptProofReadReason(guard.reason),
    };
  }
  const dates: string[] = [];
  try {
    let entryLimitExceeded = false;
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_DIRECTORY_ENTRIES) {
          entryLimitExceeded = true;
          break;
        }
        const match = DATE_LEDGER_FILE_RE.exec(entry.name);
        if (match) dates.push(match[1]!);
      }
    } finally { handle.closeSync(); }
    const guardFailure = guard.finish();
    if (guardFailure !== null) return { ok: false, reason: 'source-mutated' };
    if (entryLimitExceeded) return { ok: false, reason: 'date-limit' };
    return { ok: true, dates: [...new Set(dates)].sort() };
  } catch {
    guard.finish();
    return { ok: false, reason: 'partition-unreadable' };
  }
}

function parseAttemptProofPartition(
  text: string,
  bytesRead: number,
  date: string,
  remainingRows: number,
  wantedKeys: ReadonlySet<string>,
  wantedSequenceKeys: ReadonlySet<string>,
): { ok: true; matches: Map<string, ParsedDispatchProductionPartitionMatch>;
  sequenceMatches: Map<string, ParsedDispatchProductionSequenceMatch[]>; rowsRead: number } |
  { ok: false; reason: 'partition-invalid' | 'partition-row-limit'; rowsRead: number } {
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') !== bytesRead || !text.endsWith('\n')) {
    return { ok: false, reason: 'partition-invalid', rowsRead: 0 };
  }
  const matches = new Map<string, ParsedDispatchProductionPartitionMatch>();
  const sequenceMatches = new Map<string, ParsedDispatchProductionSequenceMatch[]>();
  let rowsRead = 0;
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset);
    if (end < 0) return { ok: false, reason: 'partition-invalid', rowsRead };
    const line = text.slice(offset, end);
    offset = end + 1;
    rowsRead++;
    if (rowsRead > remainingRows) return { ok: false, reason: 'partition-row-limit', rowsRead };
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
      return { ok: false, reason: 'partition-invalid', rowsRead };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return { ok: false, reason: 'partition-invalid', rowsRead }; }
    if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
      return { ok: false, reason: 'partition-invalid', rowsRead };
    }
    const lineAuthority = parseDispatchProductionAttemptAuthority(parsed, line);
    const failureAuthority = parseDispatchProductionFailureAttemptAuthority(parsed, line);
    const sequenceKey = failureAuthority === null ? attemptSequenceKeyFromEvent(parsed) : null;
    if (sequenceKey && wantedSequenceKeys.has(sequenceKey)) {
      const entries = sequenceMatches.get(sequenceKey) ?? [];
      entries.push({
        row: lineAuthority,
        eventDigest: createHash('sha256').update(line, 'utf8').digest('hex'),
        ordinal: parsed.repairAttemptOrdinal!,
        ts: parsed.ts,
      });
      sequenceMatches.set(sequenceKey, entries);
    }
    const key = attemptProofLookupKey(parsed.ts, parsed.itemId, parsed.repo);
    if (!wantedKeys.has(key)) continue;
    const eventDigest = createHash('sha256').update(line, 'utf8').digest('hex');
    const previous = matches.get(key);
    if (previous) {
      if (previous.eventDigest !== eventDigest) previous.conflict = true;
      continue;
    }
    matches.set(key, {
      event: parsed,
      eventDigest,
      row: lineAuthority,
      conflict: false,
    });
  }
  return { ok: true, matches, sequenceMatches, rowsRead };
}

function readAttemptProofPartitionWithContext(
  date: string,
  context: AttemptReceiptBatchReadContext,
): AttemptReceiptCachedPartition {
  const cached = context.partitionCache.get(date);
  if (cached) return cached;
  const path = join(dispatchProductionDir(), `${date}.jsonl`);
  if (!existsSync(path)) {
    const missing = { ok: true as const, sequenceMatches: new Map() };
    context.partitionCache.set(date, missing);
    return missing;
  }
  if (context.filesRead >= HARD_READ_MAX_FILES) {
    const limited = { ok: false as const, reason: 'date-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  if (context.bytesRead >= HARD_READ_MAX_BYTES) {
    const limited = { ok: false as const, reason: 'partition-byte-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  if (context.rowsRead >= HARD_READ_MAX_ROWS) {
    const limited = { ok: false as const, reason: 'partition-row-limit' as const };
    context.partitionCache.set(date, limited);
    return limited;
  }
  context.filesRead++;
  const loaded = readStableRegularFile(path, {
    anchorPath: dirname(dispatchProductionDir()),
    maxFileBytes: HARD_READ_MAX_BYTES,
    remainingBytes: HARD_READ_MAX_BYTES - context.bytesRead,
  });
  if (!loaded.ok) {
    const failed = { ok: false as const, reason: attemptProofReadReason(loaded.reason) };
    context.partitionCache.set(date, failed);
    return failed;
  }
  context.bytesRead += loaded.bytesRead;
  const parsed = parseAttemptProofPartition(
    loaded.text,
    loaded.bytesRead,
    date,
    HARD_READ_MAX_ROWS - context.rowsRead,
    new Set(),
    context.wantedGenerationIds,
  );
  context.rowsRead = Math.min(HARD_READ_MAX_ROWS, context.rowsRead + parsed.rowsRead);
  const result: AttemptReceiptCachedPartition = parsed.ok
    ? { ok: true, sequenceMatches: parsed.sequenceMatches }
    : { ok: false, reason: parsed.reason };
  context.partitionCache.set(date, result);
  return result;
}

function readBoundedLegacyAttemptGenerationMembership(
  dates: readonly string[],
): { ok: true; membership: AttemptGenerationMembership } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  if (dates.length > MAX_DIRECTORY_ENTRIES) return { ok: false, reason: 'date-limit' };
  const dir = dispatchProductionDir();
  const root = dirname(dir);
  const bits = Buffer.alloc(ATTEMPT_BLOCKED_MEMBERSHIP_BYTES);
  let totalBytes = 0;
  let totalRows = 0;
  for (const date of dates) {
    if (totalBytes >= HARD_READ_MAX_BYTES) return { ok: false, reason: 'partition-byte-limit' };
    if (totalRows >= HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
    const loaded = readStableRegularFile(join(dir, `${date}.jsonl`), {
      anchorPath: root,
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes: HARD_READ_MAX_BYTES - totalBytes,
    });
    if (!loaded.ok) return { ok: false, reason: attemptProofReadReason(loaded.reason) };
    totalBytes += loaded.bytesRead;
    if (loaded.text.length === 0 ||
      Buffer.byteLength(loaded.text, 'utf8') !== loaded.bytesRead ||
      !loaded.text.endsWith('\n')) {
      return { ok: false, reason: 'partition-invalid' };
    }
    let offset = 0;
    while (offset < loaded.text.length) {
      const end = loaded.text.indexOf('\n', offset);
      if (end < 0) return { ok: false, reason: 'partition-invalid' };
      const line = loaded.text.slice(offset, end);
      offset = end + 1;
      totalRows++;
      if (totalRows > HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
      if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        return { ok: false, reason: 'partition-invalid' };
      }
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { return { ok: false, reason: 'partition-invalid' }; }
      if (!canonicalStoredDispatchProductionEvent(parsed, line, date)) {
        return { ok: false, reason: 'partition-invalid' };
      }
      const generationId = attemptSequenceKeyFromEvent(parsed);
      if (generationId !== null) setAttemptGenerationMembershipBits(bits, generationId);
    }
  }
  return {
    ok: true,
    membership: {
      ...emptyAttemptGenerationMembership(),
      bits: bits.toString('base64'),
    },
  };
}

function readBoundedRawAttemptSequence(
  generationId: string,
  context?: AttemptReceiptBatchReadContext,
):
  { ok: true; matches: ParsedDispatchProductionSequenceMatch[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return { ok: true, matches: [] };
  const root = dirname(dir);
  if (context) {
    context.partitionDates ??= listAttemptProofPartitionDates(dir, root);
    if (!context.partitionDates.ok) return context.partitionDates;
    if (context.partitionDates.dates.length > HARD_READ_MAX_FILES) {
      return { ok: false, reason: 'date-limit' };
    }
    const matches: ParsedDispatchProductionSequenceMatch[] = [];
    for (const date of context.partitionDates.dates) {
      const partition = readAttemptProofPartitionWithContext(date, context);
      if (!partition.ok) return partition;
      matches.push(...(partition.sequenceMatches.get(generationId) ?? []));
    }
    return { ok: true, matches };
  }
  const partitions = listAttemptProofPartitionDates(dir, root);
  if (!partitions.ok) return partitions;
  if (partitions.dates.length > HARD_READ_MAX_FILES) return { ok: false, reason: 'date-limit' };

  const matches: ParsedDispatchProductionSequenceMatch[] = [];
  let totalBytes = 0;
  let totalRows = 0;
  for (const date of partitions.dates) {
    if (totalBytes >= HARD_READ_MAX_BYTES) return { ok: false, reason: 'partition-byte-limit' };
    if (totalRows >= HARD_READ_MAX_ROWS) return { ok: false, reason: 'partition-row-limit' };
    const loaded = readStableRegularFile(join(dir, `${date}.jsonl`), {
      anchorPath: root,
      maxFileBytes: HARD_READ_MAX_BYTES,
      remainingBytes: HARD_READ_MAX_BYTES - totalBytes,
    });
    if (!loaded.ok) return { ok: false, reason: attemptProofReadReason(loaded.reason) };
    totalBytes += loaded.bytesRead;
    const parsed = parseAttemptProofPartition(
      loaded.text,
      loaded.bytesRead,
      date,
      HARD_READ_MAX_ROWS - totalRows,
      new Set(),
      new Set([generationId]),
    );
    totalRows += parsed.rowsRead;
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    matches.push(...(parsed.sequenceMatches.get(generationId) ?? []));
  }
  return { ok: true, matches };
}

function readBoundedRawAttemptSequenceSince(
  generationId: string,
  notBefore: string,
  context?: AttemptReceiptBatchReadContext,
): { ok: true; matches: ParsedDispatchProductionSequenceMatch[] } |
  { ok: false; reason: DispatchProductionAttemptProofDegradedReason } {
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return { ok: true, matches: [] };
  const batch: AttemptReceiptBatchReadContext = context ?? {
    wantedGenerationIds: new Set([generationId]),
    partitionCache: new Map<string, AttemptReceiptCachedPartition>(),
    filesRead: 0,
    bytesRead: 0,
    rowsRead: 0,
  };
  batch.partitionDates ??= listAttemptProofPartitionDates(dir, dirname(dir));
  if (!batch.partitionDates.ok) return batch.partitionDates;
  const firstDate = notBefore.slice(0, 10);
  const dates = batch.partitionDates.dates.filter((date) => date >= firstDate);
  if (dates.length > HARD_READ_MAX_FILES) return { ok: false, reason: 'date-limit' };
  const cutoff = Date.parse(notBefore);
  const matches: ParsedDispatchProductionSequenceMatch[] = [];
  for (const date of dates) {
    const partition = readAttemptProofPartitionWithContext(date, batch);
    if (!partition.ok) return partition;
    matches.push(...(partition.sequenceMatches.get(generationId) ?? [])
      .filter((match) => Date.parse(match.ts) >= cutoff));
  }
  return { ok: true, matches };
}

function attemptProofEventMatchesTarget(
  event: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  repo: string,
): boolean {
  return event.ts === target.ts &&
    event.itemId === target.itemId &&
    event.repo === repo &&
    event.source === target.source &&
    event.outcome === target.outcome &&
    event.proposalId === target.proposalId &&
    event.objectiveHash === target.objectiveHash &&
    event.repairHandoffId === target.repairHandoffId &&
    event.repairGenerationId === target.repairGenerationId &&
    event.repairTreatmentUnitId === target.repairTreatmentUnitId &&
    event.repairTreatment === target.repairTreatment &&
    event.repairAttemptOrdinal === target.repairAttemptOrdinal;
}

type AttemptProofReceiptRead =
  | { status: 'missing' }
  | { status: 'intent'; authority: ParsedDispatchProductionAttemptAuthority }
  | { status: 'proven'; authority: ParsedDispatchProductionAttemptAuthority }
  | { status: 'unproven'; reason: 'event-ineligible' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

type AttemptReceiptRetentionRead =
  | { status: 'none' }
  | { status: 'retained'; droppedThrough: string }
  | { status: 'degraded' };

function validateLegacyAttemptProofReceipt(
  authority: ParsedDispatchProductionAttemptAuthority,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead | null {
  const history = readBoundedRawAttemptSequence(authority.proof.repairGenerationId, context);
  if (!history.ok) return { status: 'degraded', reason: history.reason };
  const sameOrdinal = [...new Map(history.matches
    .filter((match) => match.ordinal === authority.proof.repairAttemptOrdinal)
    .map((match) => [match.eventDigest, match])).values()];
  if (sameOrdinal.length === 0) return { status: 'degraded', reason: 'source-unavailable' };
  if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
    sameOrdinal[0]!.eventDigest !== authority.proof.eventDigest) {
    return { status: 'degraded', reason: 'partition-conflict' };
  }
  return null;
}

function validateProtocolAttemptProofReceipt(
  authority: ParsedDispatchProductionAttemptAuthority,
  activation: AttemptReceiptProtocolActivation,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead | null {
  const generation = activation.generations.find((entry) =>
    entry.generationId === authority.proof.repairGenerationId);
  if (!generation ||
    Date.parse(authority.event.ts) < Date.parse(activation.acceptsEventsAfter) ||
    Date.parse(authority.event.ts) < Date.parse(generation.admittedAt)) {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const history = readBoundedRawAttemptSequenceSince(
    authority.proof.repairGenerationId,
    generation.admittedAt,
    context,
  );
  if (!history.ok) return { status: 'degraded', reason: history.reason };
  const sameOrdinal = [...new Map(history.matches
    .filter((match) => match.ordinal === authority.proof.repairAttemptOrdinal)
    .map((match) => [match.eventDigest, match])).values()];
  if (sameOrdinal.length === 0) return { status: 'intent', authority };
  if (sameOrdinal.length !== 1 || sameOrdinal[0]!.row === null ||
    sameOrdinal[0]!.eventDigest !== authority.proof.eventDigest) {
    return { status: 'degraded', reason: 'partition-conflict' };
  }
  return null;
}

function readAttemptReceiptRetention(): AttemptReceiptRetentionRead {
  try {
    const retention = readAttemptReceiptRetentionState();
    return retention.droppedThrough === null
      ? { status: 'none' }
      : { status: 'retained', droppedThrough: retention.droppedThrough };
  } catch {
    return { status: 'degraded' };
  }
}

function readAttemptProofReceipt(
  generationId: string,
  ordinal: 1 | 2,
  validateRaw = true,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead {
  const dir = attemptProofReceiptDir();
  if (existsSync(dir)) {
    try { inspectExactReceiptAuthorityDirectory(dir); } catch {
      return { status: 'degraded', reason: 'source-unsafe' };
    }
  }
  const path = join(dir, attemptProofReceiptName(generationId, ordinal));
  let activation = knownActivation;
  if (activation === undefined) {
    try { activation = readAttemptReceiptProtocolActivation(); } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
  }
  const generation = activation?.generations.find((entry) => entry.generationId === generationId);
  if (!generation && activation && membershipSetSaturated(activation.blockedGenerations)) {
    return { status: 'degraded', reason: 'retirement-membership-saturated' };
  }
  if (!generation && activation && attemptGenerationMembershipHas(
    activation.blockedGenerations, generationId,
  )) return {
    status: 'degraded',
    reason: membershipSetSaturated(activation.blockedGenerations)
      ? 'retirement-membership-saturated'
      : 'source-unavailable',
  };
  if (existsSync(path)) {
    return readAttemptProofReceiptFile(path, generationId, ordinal, validateRaw, activation, context);
  }
  const intentPath = attemptReceiptIntentPath(generationId, ordinal);
  if (existsSync(intentPath)) {
    return readAttemptProofReceiptFile(intentPath, generationId, ordinal, validateRaw, activation, context);
  }
  return { status: 'missing' };
}

function readAttemptProofReceiptFile(
  path: string,
  generationId: string,
  ordinal: 1 | 2,
  validateRaw = true,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
): AttemptProofReceiptRead {
  try { inspectExactReceiptAuthorityFile(path); } catch {
    return { status: 'degraded', reason: 'source-unsafe' };
  }
  const remainingBytes = context ? HARD_READ_MAX_BYTES - context.bytesRead : MAX_READ_ROW_BYTES;
  if (remainingBytes <= 0) return { status: 'degraded', reason: 'partition-byte-limit' };
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_READ_ROW_BYTES,
    remainingBytes: Math.min(MAX_READ_ROW_BYTES, remainingBytes),
  });
  if (!loaded.ok) return { status: 'degraded', reason: attemptProofReadReason(loaded.reason) };
  if (context) context.bytesRead += loaded.bytesRead;
  if (!loaded.text.endsWith('\n') || loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const receiptLine = loaded.text.slice(0, -1);
  let parsed: unknown;
  try { parsed = JSON.parse(receiptLine); } catch { return { status: 'degraded', reason: 'partition-invalid' }; }
  let validated = false;
  let activationId: string | null = null;
  let line = receiptLine;
  if (isPlainRecord(parsed) && parsed['receiptSchemaVersion'] === 1) {
    if (!hasOnlyKeys(parsed, new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) || parsed['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
      typeof parsed['activationId'] !== 'string' || !SHA256_RE.test(parsed['activationId'])) {
      return { status: 'degraded', reason: 'partition-invalid' };
    }
    activationId = parsed['activationId'];
    parsed = parsed['event'];
    line = JSON.stringify(parsed);
    validated = true;
  }
  const ts = isPlainRecord(parsed) ? canonicalUtcTimestamp(parsed['ts']) : null;
  if (ts === null || !canonicalStoredDispatchProductionEvent(parsed, line, ts.slice(0, 10))) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  if (validated) {
    if (receiptLine !== attemptReceiptEnvelope(parsed, activationId!)) {
      return { status: 'degraded', reason: 'partition-invalid' };
    }
    try {
      const activation = knownActivation === undefined
        ? readAttemptReceiptProtocolActivation()
        : knownActivation;
      if (activation === null || activation.activationId !== activationId) {
        return { status: 'degraded', reason: 'source-unavailable' };
      }
      const generation = activation.generations.find((entry) => entry.generationId === generationId);
      if (!generation) {
        return { status: 'degraded', reason: 'source-unavailable' };
      }
    } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
  }
  const authority = parseDispatchProductionAttemptAuthority(parsed, line);
  if (authority === null) return { status: 'unproven', reason: 'event-ineligible' };
  if (
    authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal
  ) return { status: 'degraded', reason: 'partition-conflict' };
  if (!validateRaw) return { status: 'proven', authority };
  if (!validated) {
    const legacyFailure = validateLegacyAttemptProofReceipt(authority, context);
    if (legacyFailure !== null) return legacyFailure;
  } else {
    let activation: AttemptReceiptProtocolActivation | null;
    try {
      activation = knownActivation === undefined
        ? readAttemptReceiptProtocolActivation()
        : knownActivation;
    } catch {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
    if (activation === null) return { status: 'degraded', reason: 'source-unavailable' };
    const protocolFailure = validateProtocolAttemptProofReceipt(authority, activation, context);
    if (protocolFailure !== null && !(
      protocolFailure.status === 'intent' && ATTEMPT_RECEIPT_FILE_RE.test(basename(path))
    )) return protocolFailure;
  }
  return { status: 'proven', authority };
}

type FailureAttemptReceiptFileRead =
  | Exclude<DispatchProductionFailureAttemptReceiptResolution, { status: 'proven' }>
  | (Extract<DispatchProductionFailureAttemptReceiptResolution, { status: 'proven' }> & {
      appendAuthority?: AttemptFailureAppendAuthority;
    });

function readFailureAttemptReceiptFile(
  path: string,
  generationId: string,
  ordinal: 1 | 2,
  attemptHash: string,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  batchAssurance?: StableFileBatchAssurance,
): FailureAttemptReceiptFileRead {
  try { if (!batchAssurance) inspectExactReceiptAuthorityFile(path); } catch {
    return { status: 'degraded', reason: 'source-unsafe' };
  }
  const loaded = readStableRegularFile(path, {
    anchorPath: dispatchProductionDir(),
    maxFileBytes: MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
    remainingBytes: MAX_ATTEMPT_FAILURE_RECEIPT_BYTES,
    ...(batchAssurance ? { batchAssurance } : {}),
  });
  if (!loaded.ok) return { status: 'degraded', reason: attemptProofReadReason(loaded.reason) };
  if (!loaded.text.endsWith('\n') || loaded.text.indexOf('\n') !== loaded.text.length - 1) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const receiptLine = loaded.text.slice(0, -1);
  let envelope: unknown;
  try { envelope = JSON.parse(receiptLine); } catch {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  if (!isPlainRecord(envelope) ||
    (envelope['receiptSchemaVersion'] !== 1 && envelope['receiptSchemaVersion'] !== 2) ||
    !hasOnlyKeys(envelope, envelope['receiptSchemaVersion'] === 2 ? new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'appendAuthority', 'event',
    ]) : new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) ||
    envelope['validation'] !== ATTEMPT_RECEIPT_VALIDATION ||
    typeof envelope['activationId'] !== 'string' || !SHA256_RE.test(envelope['activationId'])) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  const event = envelope['event'];
  const line = JSON.stringify(event);
  const canonicalRow = Buffer.from(`${line}\n`, 'utf8');
  const ts = isPlainRecord(event) ? canonicalUtcTimestamp(event['ts']) : null;
  const appendAuthority = envelope['receiptSchemaVersion'] === 2 && isPlainRecord(event)
    ? parseAttemptFailureAppendAuthority(
        envelope['appendAuthority'], event as unknown as DispatchProductionEvent, canonicalRow,
      )
    : undefined;
  const canonicalEnvelope = envelope['receiptSchemaVersion'] === 2 && appendAuthority
    ? attemptFailureReceiptEnvelope(event as DispatchProductionEvent, envelope['activationId'], appendAuthority)
    : attemptReceiptEnvelope(event as DispatchProductionEvent, envelope['activationId']);
  if (ts === null || !canonicalStoredDispatchProductionEvent(event, line, ts.slice(0, 10)) ||
    (envelope['receiptSchemaVersion'] === 2 && !appendAuthority) ||
    receiptLine !== canonicalEnvelope) {
    return { status: 'degraded', reason: 'partition-invalid' };
  }
  let activation: AttemptReceiptProtocolActivation | null;
  try {
    activation = knownActivation === undefined
      ? readAttemptReceiptProtocolActivation()
      : knownActivation;
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const generation = activation?.generations.find((entry) => entry.generationId === generationId);
  if (!activation || activation.activationId !== envelope['activationId'] || !generation ||
    Date.parse(ts) < Date.parse(activation.acceptsEventsAfter) ||
    Date.parse(ts) < Date.parse(generation.admittedAt)) {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
  const authority = parseDispatchProductionFailureAttemptAuthority(event, line);
  if (authority === null) return { status: 'unproven', reason: 'event-ineligible' };
  if (authority.proof.repairGenerationId !== generationId ||
    authority.proof.repairAttemptOrdinal !== ordinal ||
    authority.proof.attemptHash !== attemptHash) {
    return { status: 'unproven', reason: 'target-mismatch' };
  }
  return {
    status: 'proven',
    proof: authority.proof,
    event: structuredClone(authority.event),
    ...(appendAuthority ? { appendAuthority } : {}),
  };
}

function retiredFailureAttemptResolution(
  activation: AttemptReceiptProtocolActivation | null,
  generationId: string,
): Extract<DispatchProductionFailureAttemptReceiptResolution, { status: 'degraded' }> | null {
  if (activation === null || activation.generations.some((entry) => entry.generationId === generationId)) {
    return null;
  }
  if (membershipSetSaturated(activation.blockedGenerations)) {
    return { status: 'degraded', reason: 'retirement-membership-saturated' };
  }
  return attemptGenerationMembershipHas(activation.blockedGenerations, generationId)
    ? { status: 'degraded', reason: 'source-unavailable' }
    : null;
}

export function resolveDispatchProductionFailureAttemptReceipt(
  target: DispatchProductionFailureAttemptReceiptTarget,
): DispatchProductionFailureAttemptReceiptResolution {
  if (!isPlainRecord(target) ||
    !hasOnlyKeys(target, new Set(['repairGenerationId', 'repairAttemptOrdinal', 'attemptHash'])) ||
    !SHA256_RE.test(target.repairGenerationId) || !SHA256_RE.test(target.attemptHash) ||
    (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)) {
    return { status: 'degraded', reason: 'target-invalid' };
  }
  const dir = attemptProofReceiptDir();
  try {
    if (existsSync(dir)) inspectExactReceiptAuthorityDirectory(dir);
    const activation = readAttemptReceiptProtocolActivation();
    const retired = retiredFailureAttemptResolution(activation, target.repairGenerationId);
    if (retired !== null) return retired;
    const path = join(dir, attemptFailureReceiptName(
      target.repairGenerationId, target.repairAttemptOrdinal, target.attemptHash,
    ));
    if (existsSync(path)) {
      const loaded = readFailureAttemptReceiptFile(
        path,
        target.repairGenerationId,
        target.repairAttemptOrdinal,
        target.attemptHash,
        activation,
      );
      return loaded.status === 'proven'
        ? { status: 'proven', proof: loaded.proof, event: loaded.event }
        : loaded;
    }
    const intentPath = attemptFailureReceiptIntentPath(
      target.repairGenerationId, target.repairAttemptOrdinal, target.attemptHash,
    );
    if (existsSync(intentPath)) {
      const pending = readFailureAttemptReceiptFile(
        intentPath,
        target.repairGenerationId,
        target.repairAttemptOrdinal,
        target.attemptHash,
        activation,
      );
      return pending.status === 'proven'
        ? { status: 'missing', reason: 'receipt-uncommitted' }
        : pending;
    }
    return { status: 'missing', reason: 'receipt-missing' };
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
}

export function readDispatchProductionFailureAttemptReceipts(
  generationIds: readonly string[],
): DispatchProductionFailureAttemptReceiptBatchResolution {
  if (generationIds.length > MAX_ATTEMPT_PROOF_RECEIPTS ||
    generationIds.some((generationId) => !SHA256_RE.test(generationId))) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const wanted = new Set(generationIds);
  if (wanted.size === 0) return { status: 'resolved', authoritative: false, receipts: [] };
  const dir = attemptProofReceiptDir();
  try {
    if (!existsSync(dir)) return { status: 'resolved', authoritative: false, receipts: [] };
    inspectExactReceiptAuthorityDirectory(dir);
    const activation = readAttemptReceiptProtocolActivation();
    if (activation === null) return { status: 'degraded', reason: 'source-unavailable' };
    for (const generationId of wanted) {
      const retired = retiredFailureAttemptResolution(activation, generationId);
      if (retired !== null) return retired;
    }
    const files: Array<{ name: string; generationId: string; ordinal: 1 | 2; attemptHash: string }> = [];
    let aggregateBytes = 0;
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_ATTEMPT_RECEIPT_SCAN_ENTRIES) {
          return { status: 'degraded', reason: 'date-limit' };
        }
        const intent = ATTEMPT_FAILURE_RECEIPT_INTENT_FILE_RE.exec(entry.name);
        if (intent && wanted.has(intent[1]!)) {
          return { status: 'degraded', reason: 'source-unavailable' };
        }
        const match = ATTEMPT_FAILURE_RECEIPT_FILE_RE.exec(entry.name);
        if (!match || !wanted.has(match[1]!)) continue;
        if (files.length >= MAX_ATTEMPT_PROOF_RECEIPTS) {
          return { status: 'degraded', reason: 'target-limit' };
        }
        const stat = lstatSync(join(dir, entry.name));
        if (!safeDispatchProductionFile(stat) || stat.size > MAX_ATTEMPT_FAILURE_RECEIPT_BYTES) {
          return { status: 'degraded', reason: 'source-unsafe' };
        }
        aggregateBytes += stat.size;
        if (aggregateBytes > MAX_ATTEMPT_FAILURE_RECEIPT_AGGREGATE_BYTES) {
          return { status: 'degraded', reason: 'partition-byte-limit' };
        }
        files.push({
          name: entry.name,
          generationId: match[1]!,
          ordinal: Number(match[2]) as 1 | 2,
          attemptHash: match[3]!,
        });
      }
    } finally { handle.closeSync(); }
    const receipts: Array<{ proof: DispatchProductionFailureAttemptProof; event: DispatchProductionEvent }> = [];
    for (let offset = 0; offset < files.length; offset += 512) {
      const batch = files.slice(offset, offset + 512);
      const paths = batch.map((file) => join(dir, file.name));
      const assurance = assureRetentionFiles(paths, dispatchProductionDir());
      if (!assurance.ok) return { status: 'degraded', reason: attemptProofReadReason(assurance.reason) };
      for (let index = 0; index < batch.length; index++) {
        const file = batch[index]!;
        const resolution = readFailureAttemptReceiptFile(
          paths[index]!,
          file.generationId,
          file.ordinal,
          file.attemptHash,
          activation,
          assurance.token,
        );
        if (resolution.status !== 'proven') {
          return resolution.status === 'degraded'
            ? resolution
            : { status: 'degraded', reason: 'partition-invalid' };
        }
        receipts.push({ proof: resolution.proof, event: resolution.event });
      }
    }
    receipts.sort((left, right) => Date.parse(left.event.ts) - Date.parse(right.event.ts));
    return { status: 'resolved', authoritative: true, receipts };
  } catch {
    return { status: 'degraded', reason: 'source-unavailable' };
  }
}

function readAttemptProofReceiptSequence(
  generationId: string,
  knownActivation?: AttemptReceiptProtocolActivation | null,
  context?: AttemptReceiptBatchReadContext,
):
  { status: 'resolved'; first: AttemptProofReceiptRead; second: AttemptProofReceiptRead } {
  return {
    status: 'resolved',
    first: readAttemptProofReceipt(generationId, 1, true, knownActivation, context),
    second: readAttemptProofReceipt(generationId, 2, true, knownActivation, context),
  };
}

function resolveAttemptProofReceipt(
  target: DispatchProductionAttemptProofTarget,
  repo: string,
): DispatchProductionAttemptWitnessResolution | null {
  const receipt = readAttemptProofReceipt(target.repairGenerationId, target.repairAttemptOrdinal);
  if (receipt.status === 'missing') {
    const retention = readAttemptReceiptRetention();
    if (retention.status === 'degraded' ||
      (retention.status === 'retained' && Date.parse(target.ts) <= Date.parse(retention.droppedThrough))) {
      return { status: 'degraded', reason: 'source-unavailable' };
    }
    return null;
  }
  if (receipt.status === 'intent') return null;
  if (receipt.status !== 'proven') return receipt;
  const authority = receipt.authority;
  if (!attemptProofEventMatchesTarget(authority.event, target, repo)) {
    return { status: 'unproven', reason: 'target-mismatch' };
  }
  return {
    status: 'proven',
    proof: authority.proof,
    event: structuredClone(authority.event),
  };
}

function receiptSequenceConflict(
  first: ParsedDispatchProductionAttemptAuthority,
  second: ParsedDispatchProductionAttemptAuthority,
): boolean {
  return first.event.outcome === 'proposal-created' ||
    Date.parse(first.event.ts) > Date.parse(second.event.ts) ||
    first.proof.attemptHash === second.proof.attemptHash ||
    second.proof.previousBackend !== first.proof.backend ||
    second.proof.tier !== first.proof.tier ||
    second.event.itemId !== first.event.itemId ||
    second.event.repo !== first.event.repo ||
    second.event.source !== first.event.source ||
    second.event.objectiveHash !== first.event.objectiveHash ||
    second.proof.repairHandoffId !== first.proof.repairHandoffId ||
    second.proof.repairTreatmentUnitId !== first.proof.repairTreatmentUnitId ||
    second.proof.repairTreatment !== first.proof.repairTreatment;
}

type FailureAttemptPredecessor =
  | { status: 'proven' }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'degraded'; reason: DispatchProductionAttemptProofDegradedReason };

function failureAttemptPredecessor(
  generationId: string,
  second: ParsedDispatchProductionAttemptAuthority,
): FailureAttemptPredecessor {
  const batch = readDispatchProductionFailureAttemptReceipts([generationId]);
  if (batch.status === 'degraded') return batch;
  const firsts = batch.receipts.filter((receipt) => receipt.proof.repairAttemptOrdinal === 1);
  if (firsts.length === 0) return { status: 'missing' };
  if (firsts.length !== 1) return { status: 'conflict' };
  const first = firsts[0]!;
  const sameRoot = second.event.repairRootId === undefined || (
    first.event.repairRootId === second.event.repairRootId &&
    first.event.repairDepth === second.event.repairDepth
  );
  return Date.parse(first.event.ts) <= Date.parse(second.event.ts) &&
    first.proof.attemptHash !== second.proof.attemptHash &&
    first.proof.backend === second.proof.previousBackend &&
    first.proof.tier === second.proof.tier &&
    first.event.itemId === second.event.itemId &&
    first.event.repo === second.event.repo &&
    first.event.source === second.event.source &&
    first.event.objectiveHash === second.event.objectiveHash &&
    first.proof.repairHandoffId === second.proof.repairHandoffId &&
    first.proof.repairGenerationId === second.proof.repairGenerationId &&
    first.proof.repairTreatmentUnitId === second.proof.repairTreatmentUnitId &&
    first.proof.repairTreatment === second.proof.repairTreatment &&
    sameRoot
    ? { status: 'proven' }
    : { status: 'conflict' };
}

function resolveReceiptCompleteAttemptSequence(
  targets: readonly DispatchProductionAttemptProofTarget[],
  indexes: readonly number[],
  repos: ReadonlyMap<number, string>,
): Map<number, DispatchProductionAttemptWitnessResolution> | null {
  const firstTarget = targets[indexes[0]!]!;
  const needsSecond = indexes.some((index) => targets[index]!.repairAttemptOrdinal === 2);
  const sequence = readAttemptProofReceiptSequence(firstTarget.repairGenerationId);
  if (sequence.first.status === 'intent' ||
    (needsSecond && (sequence.second.status === 'missing' || sequence.second.status === 'intent'))) return null;

  const { first, second } = sequence;
  const uniform = (
    resolution: DispatchProductionAttemptWitnessResolution,
  ): Map<number, DispatchProductionAttemptWitnessResolution> => new Map(
    indexes.map((index) => [index, resolution]),
  );
  if (first.status !== 'proven' && first.status !== 'missing') return uniform(first);
  if (second.status !== 'missing' && second.status !== 'intent' && second.status !== 'proven') {
    return uniform(second);
  }
  const failurePredecessor = first.status === 'missing' && second.status === 'proven'
    ? failureAttemptPredecessor(firstTarget.repairGenerationId, second.authority)
    : { status: 'missing' as const };
  if (failurePredecessor.status === 'degraded') return uniform(failurePredecessor);
  if (failurePredecessor.status === 'conflict') {
    return uniform({ status: 'unproven', reason: 'attempt-sequence-mismatch' });
  }
  if (first.status === 'missing' && failurePredecessor.status !== 'proven') return null;
  if (first.status === 'proven' && second.status === 'proven' &&
    receiptSequenceConflict(first.authority, second.authority)) {
    return uniform({ status: 'unproven', reason: 'attempt-sequence-mismatch' });
  }

  const result = new Map<number, DispatchProductionAttemptWitnessResolution>();
  for (const index of indexes) {
    const target = targets[index]!;
    const repo = repos.get(index)!;
    const receipt = target.repairAttemptOrdinal === 1 ? first : second;
    if (receipt.status !== 'proven') {
      result.set(index, { status: 'unproven', reason: 'attempt-sequence-missing' });
    } else if (!attemptProofEventMatchesTarget(receipt.authority.event, target, repo)) {
      result.set(index, { status: 'unproven', reason: 'target-mismatch' });
    } else {
      result.set(index, {
        status: 'proven',
        proof: receipt.authority.proof,
        event: structuredClone(receipt.authority.event),
      });
    }
  }
  return result;
}

/**
 * Resolve metadata-only generated-repair attempt proof from a complete immutable
 * receipt sequence, or conservatively from stable dispatch-production partitions
 * for legacy/incomplete generations. Routing and attempt identity are always
 * derived from persisted bytes rather than trusted from the caller.
 */
export function resolveDispatchProductionAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptProofBatchResolution {
  const witnessed = resolveDispatchProductionAttemptWitnesses(targets);
  if (witnessed.status !== 'resolved') return witnessed;
  return {
    status: 'resolved',
    resolutions: witnessed.resolutions.map((resolution) =>
      resolution.status === 'proven'
        ? { status: 'proven', proof: resolution.proof }
        : resolution),
  };
}

export function resolveDispatchProductionAttemptWitnesses(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptWitnessBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  return { status: 'resolved', resolutions: resolveBoundedDispatchProductionAttemptProofs(targets) };
}

const ATTEMPT_RECEIPT_WITNESS_TARGET_KEYS = new Set([
  'repairGenerationId',
  'repairAttemptOrdinal',
]);

/**
 * Read canonical metadata-only attempt witnesses directly from immutable
 * generation receipts. This bounded recovery API never enumerates production
 * partitions and validates the complete available sequence before returning it.
 */
export function resolveDispatchProductionAttemptReceiptWitnesses(
  targets: readonly DispatchProductionAttemptReceiptWitnessTarget[],
): DispatchProductionAttemptReceiptWitnessBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const resolutions: DispatchProductionAttemptReceiptWitnessResolution[] = Array.from(
    { length: targets.length },
    () => ({ status: 'degraded', reason: 'target-invalid' }),
  );
  const byGeneration = new Map<string, number[]>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    if (
      !isPlainRecord(target) ||
      !hasOnlyKeys(target, ATTEMPT_RECEIPT_WITNESS_TARGET_KEYS) ||
      !SHA256_RE.test(target.repairGenerationId) ||
      (target.repairAttemptOrdinal !== 1 && target.repairAttemptOrdinal !== 2)
    ) continue;
    const indexes = byGeneration.get(target.repairGenerationId) ?? [];
    indexes.push(index);
    byGeneration.set(target.repairGenerationId, indexes);
  }

  const context: AttemptReceiptBatchReadContext = {
    wantedGenerationIds: new Set(byGeneration.keys()),
    partitionCache: new Map(),
    filesRead: 0,
    bytesRead: 0,
    rowsRead: 0,
  };
  let activation: AttemptReceiptProtocolActivation | null = null;
  if (byGeneration.size > 0) {
    const receiptDir = attemptProofReceiptDir();
    if (existsSync(receiptDir)) {
      try { inspectExactReceiptAuthorityDirectory(receiptDir); } catch (error) {
        const reason = error instanceof ReceiptDirectoryAuthorityError &&
          UNSAFE_RECEIPT_DIRECTORY_REASONS.has(error.reason)
          ? 'source-unsafe' as const
          : 'source-unavailable' as const;
        for (const indexes of byGeneration.values()) {
          for (const index of indexes) {
            resolutions[index] = { status: 'degraded', reason };
          }
        }
        return { status: 'resolved', resolutions };
      }
    }
    try { activation = readAttemptReceiptProtocolActivation(context, true); } catch {
      for (const indexes of byGeneration.values()) {
        for (const index of indexes) {
          resolutions[index] = { status: 'degraded', reason: 'source-unavailable' };
        }
      }
      return { status: 'resolved', resolutions };
    }
  }

  for (const [generationId, indexes] of byGeneration) {
    const sequence = readAttemptProofReceiptSequence(generationId, activation, context);
    const { first, second } = sequence;
    const receiptFailure = first.status !== 'missing' && first.status !== 'intent' && first.status !== 'proven'
      ? first
      : second.status !== 'missing' && second.status !== 'intent' && second.status !== 'proven'
        ? second
        : null;
    if (receiptFailure !== null) {
      for (const index of indexes) resolutions[index] = receiptFailure;
      continue;
    }
    if (first.status === 'proven' && second.status === 'proven' &&
      receiptSequenceConflict(first.authority, second.authority)) {
      for (const index of indexes) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      }
      continue;
    }
    const needsFailurePredecessor = indexes.some((index) =>
      targets[index]!.repairAttemptOrdinal === 2) &&
      first.status === 'missing' && second.status === 'proven';
    const failurePredecessor = needsFailurePredecessor
      ? failureAttemptPredecessor(generationId, second.authority)
      : { status: 'missing' as const };
    if (failurePredecessor.status === 'degraded' || failurePredecessor.status === 'conflict') {
      const resolution: DispatchProductionAttemptReceiptWitnessResolution =
        failurePredecessor.status === 'degraded'
          ? failurePredecessor
          : { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      for (const index of indexes) resolutions[index] = resolution;
      continue;
    }

    for (const index of indexes) {
      const target = targets[index]!;
      const receipt = target.repairAttemptOrdinal === 1 ? first : second;
      if (receipt.status === 'intent') {
        resolutions[index] = { status: 'missing', reason: 'receipt-uncommitted' };
      } else if (receipt.status === 'missing') {
        resolutions[index] = { status: 'missing', reason: 'receipt-missing' };
      } else if (target.repairAttemptOrdinal === 2 &&
        (first.status === 'intent' ||
          (first.status === 'missing' && failurePredecessor.status !== 'proven'))) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-missing' };
      } else if (receipt.status !== 'proven') {
        resolutions[index] = receipt;
      } else {
        resolutions[index] = {
          status: 'proven',
          proof: receipt.authority.proof,
          event: structuredClone(receipt.authority.event),
        };
      }
    }
  }
  return { status: 'resolved', resolutions };
}

/**
 * Observationally distinguish an absent receipt with no matching authoritative
 * append from a receipt that is missing after its raw append committed.
 */
export function readDispatchProductionAttemptReceiptAvailability(
  targets: readonly DispatchProductionAttemptProofTarget[],
): DispatchProductionAttemptReceiptAvailabilityBatchResolution {
  if (targets.length > HARD_ATTEMPT_PROOF_TARGETS) {
    return { status: 'degraded', reason: 'target-limit' };
  }
  const resolutions: DispatchProductionAttemptReceiptAvailabilityResolution[] = Array.from(
    { length: targets.length },
    () => ({ status: 'degraded', reason: 'target-invalid' }),
  );
  const valid = new Map<number, { repo: string }>();
  const receiptTargets: DispatchProductionAttemptReceiptWitnessTarget[] = [];
  const receiptIndexes: number[] = [];
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const parsed = validDispatchProductionAttemptProofTarget(target);
    if (!parsed) continue;
    valid.set(index, { repo: parsed.repo });
    receiptTargets.push({
      repairGenerationId: target.repairGenerationId,
      repairAttemptOrdinal: target.repairAttemptOrdinal,
    });
    receiptIndexes.push(index);
  }

  const receipts = resolveDispatchProductionAttemptReceiptWitnesses(receiptTargets);
  if (receipts.status !== 'resolved') return receipts;
  const rawTargets: DispatchProductionAttemptProofTarget[] = [];
  const rawIndexes: number[] = [];
  for (let offset = 0; offset < receipts.resolutions.length; offset++) {
    const index = receiptIndexes[offset]!;
    const receipt = receipts.resolutions[offset]!;
    if (receipt.status === 'proven') {
      const target = targets[index]!;
      if (!attemptProofEventMatchesTarget(receipt.event, target, valid.get(index)!.repo)) {
        resolutions[index] = { status: 'unproven', reason: 'target-mismatch' };
      } else {
        resolutions[index] = {
          status: 'available',
          proof: receipt.proof,
          event: structuredClone(receipt.event),
        };
      }
    } else if (receipt.status === 'missing') {
      rawTargets.push(targets[index]!);
      rawIndexes.push(index);
    } else {
      resolutions[index] = receipt;
    }
  }

  if (rawTargets.length > 0) {
    const raw = resolveBoundedDispatchProductionAttemptProofs(rawTargets, false);
    for (let offset = 0; offset < raw.length; offset++) {
      const index = rawIndexes[offset]!;
      const resolution = raw[offset]!;
      if (resolution.status === 'proven') {
        resolutions[index] = {
          status: 'missing',
          reason: 'receipt-missing-after-append',
          proof: resolution.proof,
          event: structuredClone(resolution.event),
        };
      } else if (resolution.status === 'missing') {
        resolutions[index] = { status: 'missing', reason: 'raw-append-missing' };
      } else {
        resolutions[index] = resolution;
      }
    }
  }
  return { status: 'resolved', resolutions };
}

function resolveBoundedDispatchProductionAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
  allowReceiptFastPath = true,
): DispatchProductionAttemptWitnessResolution[] {
  const resolutions: DispatchProductionAttemptWitnessResolution[] = Array.from({ length: targets.length }, () => ({
    status: 'degraded', reason: 'target-invalid',
  }));
  const byDate = new Map<string, Array<{ index: number; repo: string; key: string; sequenceKey: string }>>();
  const sequences = new Map<string, { first: number[]; second: number[] }>();
  const sequenceWindows = new Map<string, { start: string; end: string; indexes: number[] }>();
  const validRepos = new Map<number, string>();
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index]!;
    const valid = validDispatchProductionAttemptProofTarget(target);
    if (!valid) continue;
    const sequenceKey = attemptSequenceKey(target, valid.repo);
    const entries = byDate.get(valid.date) ?? [];
    entries.push({
      index,
      repo: valid.repo,
      key: attemptProofLookupKey(target.ts, target.itemId, valid.repo),
      sequenceKey,
    });
    byDate.set(valid.date, entries);
    validRepos.set(index, valid.repo);
    const sequence = sequences.get(sequenceKey) ?? { first: [], second: [] };
    sequence[target.repairAttemptOrdinal === 1 ? 'first' : 'second'].push(index);
    sequences.set(sequenceKey, sequence);
    const window = sequenceWindows.get(sequenceKey) ?? {
      start: valid.sequenceStartDate,
      end: valid.sequenceEndDate,
      indexes: [],
    };
    if (valid.sequenceStartDate < window.start) window.start = valid.sequenceStartDate;
    if (valid.sequenceEndDate > window.end) window.end = valid.sequenceEndDate;
    window.indexes.push(index);
    sequenceWindows.set(sequenceKey, window);
  }
  if (byDate.size === 0) return resolutions;

  const receiptCompleteSequences = new Set<string>();
  if (allowReceiptFastPath) {
    for (const [sequenceKey, sequence] of sequences) {
      const indexes = [...sequence.first, ...sequence.second];
      const receiptResolution = resolveReceiptCompleteAttemptSequence(targets, indexes, validRepos);
      if (receiptResolution === null) continue;
      for (const [index, resolution] of receiptResolution) resolutions[index] = resolution;
      receiptCompleteSequences.add(sequenceKey);
    }
  }
  if (receiptCompleteSequences.size > 0) {
    for (const [date, entries] of byDate) {
      const remaining = entries.filter((entry) => !receiptCompleteSequences.has(entry.sequenceKey));
      if (remaining.length === 0) byDate.delete(date);
      else byDate.set(date, remaining);
    }
    for (const sequenceKey of receiptCompleteSequences) {
      sequences.delete(sequenceKey);
      sequenceWindows.delete(sequenceKey);
    }
  }
  if (byDate.size === 0) return resolutions;

  const receiptResolutions = new Map<number, DispatchProductionAttemptWitnessResolution>();
  if (allowReceiptFastPath) {
    for (const entries of byDate.values()) for (const entry of entries) {
      const receipt = resolveAttemptProofReceipt(targets[entry.index]!, entry.repo);
      if (receipt !== null) {
        receiptResolutions.set(entry.index, receipt);
        resolutions[entry.index] = receipt;
      }
    }
  }
  const sequenceIndexesByDate = new Map<string, Set<number>>();
  for (const window of sequenceWindows.values()) {
    let cursor = Date.parse(`${window.start}T00:00:00.000Z`);
    const end = Date.parse(`${window.end}T00:00:00.000Z`);
    if (!Number.isFinite(cursor) || !Number.isFinite(end)) continue;
    while (cursor <= end) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      const indexes = sequenceIndexesByDate.get(date) ?? new Set<number>();
      for (const index of window.indexes) indexes.add(index);
      sequenceIndexesByDate.set(date, indexes);
      cursor += DAY_MS;
      if (byDate.size > HARD_READ_MAX_FILES) break;
    }
    if (byDate.size > HARD_READ_MAX_FILES) break;
  }
  if (byDate.size > HARD_READ_MAX_FILES) {
    for (const window of sequenceWindows.values()) for (const index of window.indexes) {
      resolutions[index] = { status: 'degraded', reason: 'date-limit' };
    }
    return resolutions;
  }

  const dir = dispatchProductionDir();
  const root = dirname(dir);
  if (!existsSync(dir)) {
    const stableMissing = stablyMissingDispatchProductionDirectory(dir);
    for (const entries of byDate.values()) {
      for (const entry of entries) resolutions[entry.index] = stableMissing
        ? { status: 'missing', reason: 'partition-missing' }
        : { status: 'degraded', reason: 'source-unavailable' };
    }
    return resolutions;
  }

  const durablePartitions = listAttemptProofPartitionDates(dir, root);
  if (!durablePartitions.ok) {
    for (const window of sequenceWindows.values()) for (const index of window.indexes) {
      resolutions[index] = { status: 'degraded', reason: durablePartitions.reason };
    }
    return resolutions;
  }
  const allValidIndexes = [...sequenceWindows.values()].flatMap((window) => window.indexes);
  for (const date of durablePartitions.dates) {
    if (!byDate.has(date)) byDate.set(date, []);
    const indexes = sequenceIndexesByDate.get(date) ?? new Set<number>();
    for (const index of allValidIndexes) indexes.add(index);
    sequenceIndexesByDate.set(date, indexes);
  }
  if (byDate.size > HARD_READ_MAX_FILES) {
    for (const index of allValidIndexes) resolutions[index] = { status: 'degraded', reason: 'date-limit' };
    return resolutions;
  }

  let totalBytes = 0;
  let totalRows = 0;
  const sequenceMatches = new Map<string, ParsedDispatchProductionSequenceMatch[]>();
  const wantedSequenceKeys = new Set(sequences.keys());
  const sequenceDegradations = new Map<number, DispatchProductionAttemptProofDegradedReason>();
  for (const [date, entries] of byDate) {
    const relatedIndexes = sequenceIndexesByDate.get(date) ?? new Set(entries.map((entry) => entry.index));
    const degradeRelated = (reason: DispatchProductionAttemptProofDegradedReason): void => {
      for (const index of relatedIndexes) if (!sequenceDegradations.has(index)) {
        sequenceDegradations.set(index, reason);
      }
    };
    if (totalBytes >= HARD_READ_MAX_BYTES) {
      degradeRelated('partition-byte-limit');
      continue;
    }
    if (totalRows >= HARD_READ_MAX_ROWS) {
      degradeRelated('partition-row-limit');
      continue;
    }
    const path = join(dir, `${date}.jsonl`);
    let dateResolutions: DispatchProductionAttemptWitnessResolution[];
    try {
      let partitionMissing = false;
      try { lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') partitionMissing = true;
        else throw error;
      }
      if (partitionMissing) {
        const missing = stablyMissingAttemptProofPartition(dir, path, root);
        dateResolutions = entries.map(() => missing);
        if (missing.status === 'degraded') degradeRelated(missing.reason);
      } else {
        const loaded = readStableRegularFile(path, {
          anchorPath: root,
          maxFileBytes: HARD_READ_MAX_BYTES,
          remainingBytes: Math.max(0, HARD_READ_MAX_BYTES - totalBytes),
        });
        if (!loaded.ok) {
          const reason = attemptProofReadReason(loaded.reason);
          degradeRelated(reason);
          dateResolutions = entries.map(() => ({
            status: 'degraded', reason,
          }));
        } else {
          totalBytes += loaded.bytesRead;
          const parsed = parseAttemptProofPartition(
            loaded.text,
            loaded.bytesRead,
            date,
            Math.max(0, HARD_READ_MAX_ROWS - totalRows),
            new Set(entries.map((entry) => entry.key)),
            wantedSequenceKeys,
          );
          totalRows += parsed.rowsRead;
          if (!parsed.ok) {
            degradeRelated(parsed.reason);
            dateResolutions = entries.map(() => ({ status: 'degraded', reason: parsed.reason }));
          } else {
            for (const [sequenceKey, matches] of parsed.sequenceMatches) {
              sequenceMatches.set(sequenceKey, [
                ...(sequenceMatches.get(sequenceKey) ?? []),
                ...matches,
              ]);
            }
            dateResolutions = entries.map((entry) => {
              const target = targets[entry.index]!;
              const match = parsed.matches.get(entry.key);
              if (!match) return { status: 'missing', reason: 'event-missing' };
              if (match.conflict) return { status: 'degraded', reason: 'partition-conflict' };
              if (match.row === null) return { status: 'unproven', reason: 'event-ineligible' };
              if (!attemptProofEventMatchesTarget(match.event, target, entry.repo)) {
                return { status: 'unproven', reason: 'target-mismatch' };
              }
              return {
                status: 'proven',
                proof: match.row.proof,
                event: structuredClone(match.row.event),
              };
            });
          }
        }
      }
    } catch {
      degradeRelated('partition-unreadable');
      dateResolutions = entries.map(() => ({ status: 'degraded', reason: 'partition-unreadable' }));
    }
    for (let offset = 0; offset < entries.length; offset++) {
      resolutions[entries[offset]!.index] = dateResolutions[offset]!;
    }
  }

  for (const [index, reason] of sequenceDegradations) {
    resolutions[index] = { status: 'degraded', reason };
  }
  for (const [index, receipt] of receiptResolutions) {
    if (receipt.status === 'degraded' || receipt.status === 'unproven') {
      resolutions[index] = receipt;
    } else if (receipt.status === 'proven' && resolutions[index]?.status === 'missing') {
      resolutions[index] = receipt;
    }
  }

  for (const [sequenceKey, sequence] of sequences) {
    const completeMatches = sequenceMatches.get(sequenceKey) ?? [];
    const firstRows = [...new Map(completeMatches
      .filter((match) => match.ordinal === 1)
      .map((match) => [match.eventDigest, match])).values()];
    const secondRows = [...new Map(completeMatches
      .filter((match) => match.ordinal === 2)
      .map((match) => [match.eventDigest, match])).values()];
    const uniqueFirstRows = new Set(firstRows.map((match) => match.eventDigest));
    const uniqueSecondRows = new Set(secondRows.map((match) => match.eventDigest));
    const observedFirst = firstRows.length === 1 ? firstRows[0]!.row : null;
    const observedSecond = secondRows.length === 1 ? secondRows[0]!.row : null;
    const sequenceConflict =
      uniqueFirstRows.size > 1 ||
      uniqueSecondRows.size > 1 ||
      firstRows.some((match) => match.row === null) ||
      secondRows.some((match) => match.row === null) ||
      (observedFirst !== null && observedSecond !== null && (
        observedFirst.event.outcome === 'proposal-created' ||
        observedFirst.proof.attemptHash === observedSecond.proof.attemptHash ||
        observedSecond.proof.previousBackend !== observedFirst.proof.backend ||
        observedSecond.proof.tier !== observedFirst.proof.tier
      ));
    if (sequenceConflict) {
      for (const index of [...sequence.first, ...sequence.second]) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    const degradedFirst = sequence.first.map((index) => resolutions[index])
      .find((resolution): resolution is Extract<DispatchProductionAttemptProofResolution, { status: 'degraded' }> =>
        resolution?.status === 'degraded');
    const firstProofs = sequence.first.flatMap((index) => {
      const resolution = resolutions[index];
      return resolution?.status === 'proven' ? [resolution.proof] : [];
    });
    const secondProofs = sequence.second.flatMap((index) => {
      const resolution = resolutions[index];
      return resolution?.status === 'proven' ? [resolution.proof] : [];
    });
    const firstAttemptHashes = new Set(firstProofs.map((proof) => proof.attemptHash));
    const secondAttemptHashes = new Set(secondProofs.map((proof) => proof.attemptHash));
    if (firstAttemptHashes.size > 1) {
      for (const index of [...sequence.first, ...sequence.second]) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    if (secondAttemptHashes.size > 1) {
      for (const index of sequence.second) {
        if (resolutions[index]?.status === 'proven') {
          resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
        }
      }
      continue;
    }
    for (const index of sequence.second) {
      const resolution = resolutions[index];
      if (resolution?.status !== 'proven') continue;
      if (degradedFirst) {
        resolutions[index] = { status: 'degraded', reason: degradedFirst.reason };
        continue;
      }
      if (firstProofs.length === 0) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-missing' };
        continue;
      }
      const firstBackends = new Set(firstProofs.map((proof) => proof.backend));
      const firstTiers = new Set(firstProofs.map((proof) => proof.tier));
      if (firstBackends.size !== 1 || firstTiers.size !== 1 ||
        resolution.proof.attemptHash === firstProofs[0]!.attemptHash ||
        resolution.proof.previousBackend !== firstProofs[0]!.backend ||
        resolution.proof.tier !== firstProofs[0]!.tier) {
        resolutions[index] = { status: 'unproven', reason: 'attempt-sequence-mismatch' };
      }
    }
  }
  return resolutions;
}

function mergeTreatmentOutcomeReceipts(
  result: DispatchProductionEventsReadResult,
  opts: ReadDispatchProductionEventsOptions,
  cap: number,
  maxBytes: number,
  maxRows: number,
): void {
  // Raw JSONL is analytics only. A terminal treatment witness exists solely as
  // one strict canonical receipt, never because a raw row claims that role.
  result.events = result.events.filter((event) => event.basis !== 'repair-lifecycle-outcome');
  const dir = treatmentOutcomeReceiptDir();
  if (!existsSync(dir)) return;
  const lock = acquireLocalStoreLock(treatmentReceiptLockPath(), 250);
  if (!lock) {
    result.sourceState = 'degraded';
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    return;
  }
  const entries: string[] = [];
  try {
    const dirStat = lstatSync(dir);
    if (!safeDispatchProductionDirectory(dirStat) ||
      (process.platform !== 'win32' && (dirStat.mode & 0o077) !== 0)) throw new Error('unsafe receipt directory');
    inspectExactReceiptAuthorityDirectory(dir);
    const handle = opendirSync(dir);
    try {
      let physical = 0;
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        physical++;
        if (physical > MAX_TREATMENT_RECEIPT_DIR_ENTRIES) throw new Error('receipt directory limit');
        if (/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) entries.push(entry.name);
      }
    } finally { handle.closeSync(); }
  } catch {
    result.sourceState = 'degraded';
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    releaseLocalStoreLock(lock);
    return;
  }
  let retention: TreatmentReceiptRetentionState | null = null;
  let compactedMarkers = new Map<string, TreatmentCompactedReceiptMarker>();
  let retiredSources = new Map<string, DispatchProductionEvent>();
  try {
    const retentionPath = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
    if (existsSync(retentionPath) || existsSync(treatmentReceiptProtocolPath()) ||
      existsSync(treatmentCompactedReceiptDir())) {
      const authority = readTreatmentReceiptAuthorityState();
      retention = authority.retention;
      compactedMarkers = authority.compactedMarkers;
      if (retention) {
        const droppedMs = Date.parse(retention.droppedThrough);
        if (!Number.isFinite(droppedMs)) throw new Error('invalid receipt retention marker');
        if (retention.schemaVersion === 1) {
          retiredSources = readRetiredTreatmentOutcomeSources(retention.droppedThrough);
        }
        if (opts.sinceMs === undefined || opts.sinceMs <= droppedMs) {
          result.complete = false;
          pushStopReason(result.stopReasons, 'file-limit');
        }
      }
    }
  } catch {
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
    result.sourceState = 'degraded';
    releaseLocalStoreLock(lock);
    return;
  }
  const receipts = new Map<string, DispatchProductionEvent>();
  for (const name of entries) {
    if (result.rowsScanned >= maxRows || result.bytesRead >= maxBytes) {
      result.complete = false;
      pushStopReason(result.stopReasons, result.rowsScanned >= maxRows ? 'row-limit' : 'byte-limit');
      break;
    }
    const remaining = Math.min(MAX_TREATMENT_RECEIPT_BYTES, maxBytes - result.bytesRead);
    const path = join(dir, name);
    const loaded = readDispatchProductionFileTail(path, remaining);
    result.filesRead++;
    if (!loaded || loaded.truncated) {
      result.unreadableFiles++;
      result.complete = false;
      pushStopReason(result.stopReasons, 'io-error');
      continue;
    }
    result.bytesRead += loaded.bytesRead;
    result.rowsScanned++;
    try {
      inspectExactReceiptAuthorityFile(path);
      const line = treatmentOutcomeReceiptLine(loaded.text);
      if (line === null) {
        throw new Error('invalid receipt');
      }
      const parsed: unknown = JSON.parse(line);
      if (!canonicalTreatmentOutcomeReceiptEvent(parsed, line, name)) {
        throw new Error('invalid receipt');
      }
      const event = parsed;
      const receiptDigest = treatmentOutcomeReceiptDigest(name, event);
      const tombstone = retention?.tombstones.find((value) => value.name === name);
      const compacted = compactedMarkers.get(name);
      const retired = tombstone ?? compacted;
      if (retired) {
        if (retired.receiptDigest !== receiptDigest) {
          throw new Error('conflicting retired treatment outcome receipt');
        }
        continue;
      }
      const retiredSource = retiredSources.get(name);
      if (retiredSource) {
        if (JSON.stringify(retiredSource) !== JSON.stringify(event)) {
          throw new Error('conflicting retired treatment outcome source');
        }
        continue;
      }
      const eventMs = Date.parse(event.ts);
      if (retention && eventMs <= Date.parse(retention.droppedThrough)) {
        throw new Error('restored retired treatment outcome receipt');
      }
      if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
      receipts.set(name, event);
    } catch {
      result.invalidRows++;
      result.complete = false;
    }
  }
  if (receipts.size > 0) {
    const receiptKeys = new Set(receipts.keys());
    result.events = result.events.filter((event) => {
      const name = treatmentOutcomeReceiptName(event);
      return name === null || !receiptKeys.has(name);
    });
    result.events.push(...receipts.values());
    result.events.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (result.events.length > cap) {
      result.events = result.events.slice(0, cap);
      result.complete = false;
      pushStopReason(result.stopReasons, 'event-limit');
    }
  }
  if (!result.complete || result.invalidRows > 0 || result.unreadableFiles > 0) result.sourceState = 'degraded';
  releaseLocalStoreLock(lock);
}

export function readDispatchProductionEventsDetailed(
  opts: ReadDispatchProductionEventsOptions = {},
): DispatchProductionEventsReadResult {
  const cap = boundedReadOption(opts.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
  const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
  const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return emptyDispatchProductionRead('missing');

  let files: string[];
  let directorySnapshot: ReturnType<typeof lstatSync>;
  try {
    directorySnapshot = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directorySnapshot)) throw new Error('unsafe dispatch production directory');
    const selected: string[] = [];
    const handle = opendirSync(dir);
    try {
      let seen = 0;
      let entry = handle.readSync();
      while (entry !== null) {
        seen++;
        if (seen > MAX_DIRECTORY_ENTRIES) {
          return emptyDispatchProductionRead('degraded', {
            sourcePresent: true, complete: false, stopReasons: ['file-limit'],
          });
        }
        if (entry.name.endsWith('.jsonl')) selected.push(entry.name);
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
    files = selected.sort((left, right) => {
        const leftDated = DATE_LEDGER_FILE_RE.test(left);
        const rightDated = DATE_LEDGER_FILE_RE.test(right);
        if (leftDated !== rightDated) return leftDated ? -1 : 1;
        return right.localeCompare(left);
      });
  } catch {
    return emptyDispatchProductionRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
  const result = emptyDispatchProductionRead('healthy');
  result.sourcePresent = true;
  let stopTraversal = false;
  for (const file of files) {
    if (stopTraversal) break;
    if (opts.sinceMs !== undefined && !fileMayContainSince(file, opts.sinceMs)) continue;
    if (result.rowsScanned >= maxRows) {
      pushStopReason(result.stopReasons, 'row-limit');
      result.complete = false;
      break;
    }
    const isDatedFile = DATE_LEDGER_FILE_RE.test(file);
    if (isDatedFile) {
      if (result.datedFilesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.datedFilesRead++;
    } else {
      if (result.looseFilesRead >= MAX_LOOSE_FILES) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.looseFilesRead++;
    }

    const remainingBytes = maxBytes - result.bytesRead;
    if (remainingBytes <= 0) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      break;
    }
    const loaded = readDispatchProductionFileTail(join(dir, file), remainingBytes);
    result.filesRead++;
    if (!loaded) {
      result.unreadableFiles++;
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      break;
    }
    result.bytesRead += loaded.bytesRead;
    if (loaded.truncated) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      stopTraversal = true;
    }

    let cursor = loaded.text.length;
    let trailingSeparator = true;
    while (cursor > 0) {
      if (result.rowsScanned >= maxRows) {
        pushStopReason(result.stopReasons, 'row-limit');
        result.complete = false;
        stopTraversal = true;
        break;
      }
      const newline = loaded.text.lastIndexOf('\n', cursor - 1);
      const line = loaded.text.slice(newline + 1, cursor);
      cursor = newline >= 0 ? newline : 0;
      if (trailingSeparator && line === '') {
        trailingSeparator = false;
        continue;
      }
      trailingSeparator = false;
      result.rowsScanned++;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        result.invalidRows++;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isDispatchProductionEvent(parsed)) {
          result.invalidRows++;
          continue;
        }
        const eventMs = Date.parse(parsed.ts);
        if (!Number.isFinite(eventMs)) {
          result.invalidRows++;
          continue;
        }
        if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
        if (result.events.length >= cap) {
          pushStopReason(result.stopReasons, 'event-limit');
          result.complete = false;
          stopTraversal = true;
          break;
        }
        result.events.push(sanitizeDispatchProductionEvent(parsed, {
          deriveLegacyRunOutcomeCausal: true,
          materializeLearningLabel: true,
        }));
      } catch {
        result.invalidRows++;
      }
    }
  }
  if (result.invalidRows > 0 || result.unreadableFiles > 0) result.complete = false;
  mergeTreatmentOutcomeReceipts(result, opts, cap, maxBytes, maxRows);
  if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
    result.sourceState = 'degraded';
  }
  try {
    const directoryAfter = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directoryAfter) || !sameFile(directorySnapshot, directoryAfter) ||
      directorySnapshot.mtimeMs !== directoryAfter.mtimeMs || directorySnapshot.ctimeMs !== directoryAfter.ctimeMs) {
      pushStopReason(result.stopReasons, 'io-error');
      result.unreadableFiles++;
      result.complete = false;
      result.sourceState = 'degraded';
    }
  } catch {
    pushStopReason(result.stopReasons, 'io-error');
    result.unreadableFiles++;
    result.complete = false;
    result.sourceState = 'degraded';
  }
  return result;
}

export function readDispatchProductionEvents(
  opts?: ReadDispatchProductionEventsOptions,
): DispatchProductionEvent[] {
  return readDispatchProductionEventsDetailed(opts).events;
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function emptyOutcomeCounts(): DispatchProductionOutcomeCounts {
  return {
    proposalCreated: 0,
    emptyDiff: 0,
    gateBlocked: 0,
    engineFailed: 0,
    cancelled: 0,
    sandboxFailed: 0,
    proposalCaptureError: 0,
    proposalDisabled: 0,
    unknown: 0,
  };
}

const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function addRunActionCounts(target: RunActionCounts, source: RunActionCounts | undefined): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  const record = source as Record<string, unknown>;
  for (const key of RUN_ACTION_COUNT_KEYS) {
    const value = nonNegativeInteger(record[key]);
    if (value === undefined || value <= 0) continue;
    target[key] = Math.min((target[key] ?? 0) + value, Number.MAX_SAFE_INTEGER);
  }
}

function hasRunActionCounts(counts: RunActionCounts): boolean {
  return RUN_ACTION_COUNT_KEYS.some((key) => (counts[key] ?? 0) > 0);
}

function incrementOutcome(
  counts: DispatchProductionOutcomeCounts,
  outcome: DaemonDispatchProductionOutcome | 'cancelled',
): void {
  switch (outcome) {
    case 'proposal-created':
      counts.proposalCreated++;
      break;
    case 'empty-diff':
      counts.emptyDiff++;
      break;
    case 'gate-blocked':
      counts.gateBlocked++;
      break;
    case 'engine-failed':
      counts.engineFailed++;
      break;
    case 'cancelled':
      counts.cancelled = (counts.cancelled ?? 0) + 1;
      break;
    case 'sandbox-failed':
      counts.sandboxFailed++;
      break;
    case 'proposal-capture-error':
      counts.proposalCaptureError++;
      break;
    case 'proposal-disabled':
      counts.proposalDisabled++;
      break;
    default:
      counts.unknown++;
      break;
  }
}

function isCancelledDispatchProductionEvent(event: DispatchProductionEvent): boolean {
  if (String(event.outcome).trim().toLowerCase() === 'cancelled') return true;
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, event.learningLabel);
  return String(classification.kind) === 'cancelled';
}

function outcomeForAccounting(
  event: DispatchProductionEvent,
): DaemonDispatchProductionOutcome | 'cancelled' {
  return isCancelledDispatchProductionEvent(event) ? 'cancelled' : event.outcome;
}

function sortedReasons(reasons: Map<string, number>, limit: number): DispatchProductionReasonCount[] {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function isSuppressedDispatchProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled');
}

function addDiagnosticReason(
  reasons: Map<string, number>,
  reason: string,
  classification: ProductionAttemptLearningClassification,
): void {
  if (!classification.diagnosticAttempt || isSuppressedDispatchProductionReason(reason)) return;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

interface MutableYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  diagnosticAttempts: number;
  diagnosticProposalsCreated: number;
  diagnosticNoProposal: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts: RunActionCounts;
  attemptShape: ProductionAttemptShape;
  generatedRepairAttempts: GeneratedRepairAttemptSummary;
  repairTreatments: MutableRepairTreatmentAttribution;
  reasons: Map<string, number>;
  diagnosticReasons: Map<string, number>;
}

interface MutableRepairTreatmentAttribution {
  eligibleEvents: number;
  attributedEvents: number;
  unattributedEvents: number;
  replayedEvents: number;
  units: Map<RepairTreatment, Map<string, MutableRepairTreatmentUnit>>;
}

interface MutableRepairTreatmentUnit {
  rawAttempts: Map<string, string>;
  rawOrdinals: Set<1 | 2>;
  witness?: {
    executionKey: string;
    generationId: string;
    converted: boolean;
  };
  witnessEvents: number;
}

function emptyRepairTreatmentAttribution(): MutableRepairTreatmentAttribution {
  return {
    eligibleEvents: 0,
    attributedEvents: 0,
    unattributedEvents: 0,
    replayedEvents: 0,
    units: new Map(),
  };
}

function emptyGeneratedRepairAttemptSummary(): GeneratedRepairAttemptSummary {
  return {
    attempts: 0,
    proposalsCreated: 0,
    noProposal: 0,
    proposalRate: 0,
    captureRepairs: 0,
    diagnosticReslices: 0,
    proposalRepairs: 0,
  };
}

function hasGeneratedRepairAttemptSummary(summary: GeneratedRepairAttemptSummary): boolean {
  return summary.attempts > 0 ||
    summary.proposalsCreated > 0 ||
    summary.noProposal > 0 ||
    summary.captureRepairs > 0 ||
    summary.diagnosticReslices > 0 ||
    summary.proposalRepairs > 0;
}

function addGeneratedRepairAttempt(
  summary: GeneratedRepairAttemptSummary,
  kind: GeneratedRepairAttemptKind | undefined,
  proposalCreated: boolean,
  cancelled: boolean,
): void {
  if (!kind || cancelled) return;
  summary.attempts++;
  if (proposalCreated) summary.proposalsCreated++;
  else summary.noProposal++;
  summary.proposalRate = summary.attempts > 0 ? summary.proposalsCreated / summary.attempts : 0;
  if (kind === 'capture-repair') summary.captureRepairs++;
  else if (kind === 'no-diff-reslice') summary.diagnosticReslices++;
  else summary.proposalRepairs++;
}

function addRepairTreatmentAttempt(
  attribution: MutableRepairTreatmentAttribution,
  event: DispatchProductionEvent,
): void {
  if (isCancelledDispatchProductionEvent(event)) return;
  const kind = generatedRepairAttemptKindFromSignals({
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  });
  if (kind !== 'no-diff-reslice') return;
  if (event.basis === 'repair-lifecycle-candidate') return;
  const terminalWitness = event.basis === 'repair-lifecycle-outcome';
  if (!terminalWitness) attribution.eligibleEvents++;
  const treatment = event.repairTreatment;
  const unitId = event.repairTreatmentUnitId;
  const executionId = event.trajectoryId ?? event.runId;
  if (
    !treatment ||
    !unitId ||
    !executionId ||
    event.repairLineageInvalid === true ||
    typeof event.repairHandoffId !== 'string' ||
    typeof event.repairGenerationId !== 'string' ||
    repairGenerationIdFromHandoffId(event.repairHandoffId) !== event.repairGenerationId ||
    repairTreatmentForUnitId(unitId) !== treatment ||
    !/:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(event.itemId)
  ) {
    attribution.unattributedEvents++;
    return;
  }
  const units = attribution.units.get(treatment) ?? new Map<string, MutableRepairTreatmentUnit>();
  const unit: MutableRepairTreatmentUnit = units.get(unitId) ?? {
    rawAttempts: new Map(),
    rawOrdinals: new Set(),
    witnessEvents: 0,
  };
  const attemptHash = generatedRepairLifecycleAttemptHash(executionId);
  if (terminalWitness && (
    event.repairTreatmentOutcome === undefined ||
    event.repairTreatmentAttemptHash !== attemptHash
  )) {
    attribution.unattributedEvents++;
    return;
  }
  const executionKey = `${event.repairGenerationId}:${attemptHash}`;
  if (terminalWitness) {
    unit.witnessEvents++;
    if (unit.witnessEvents > 1 || unit.witness !== undefined) attribution.replayedEvents++;
    if (!unit.witness) {
      unit.witness = {
        executionKey,
        generationId: event.repairGenerationId,
        converted: event.repairTreatmentOutcome === 'converted',
      };
    }
  } else {
    attribution.attributedEvents++;
    const repeatedOrdinal = unit.rawOrdinals.has(event.repairAttemptOrdinal!);
    unit.rawOrdinals.add(event.repairAttemptOrdinal!);
    const fingerprint = JSON.stringify([
      event.repairHandoffId,
      event.backend,
      event.outcome,
      event.proposalCreated,
      event.proposalId ?? null,
    ]);
    const prior = unit.rawAttempts.get(executionKey);
    if (repeatedOrdinal || prior !== undefined) attribution.replayedEvents++;
    if (prior !== undefined) {
      if (prior !== fingerprint) attribution.unattributedEvents++;
    } else {
      unit.rawAttempts.set(executionKey, fingerprint);
    }
  }
  units.set(unitId, unit);
  attribution.units.set(treatment, units);
}

function sampleGatedTreatmentConversions(
  attribution: MutableRepairTreatmentAttribution,
): RepairTreatmentConversionSummary[] | undefined {
  if (attribution.unattributedEvents > 0 || attribution.replayedEvents > 0) return undefined;
  if (REPAIR_TREATMENTS.some(
    (treatment) => (attribution.units.get(treatment)?.size ?? 0) < MIN_REPAIR_TREATMENT_ATTEMPTS,
  )) return undefined;
  const allUnits = [...attribution.units.values()].flatMap((units) => [...units.values()]);
  if (allUnits.some((unit) =>
    unit.witnessEvents !== 1 ||
    unit.witness === undefined ||
    !unit.rawAttempts.has(unit.witness.executionKey)
  )) return undefined;
  const conversions = REPAIR_TREATMENTS
    .map((treatment) => [treatment, attribution.units.get(treatment)!] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([repairTreatment, units]) => {
      const attempts = units.size;
      const proposalsCreated = [...units.values()].filter((unit) => unit.witness?.converted === true).length;
      return {
        repairTreatment,
        attempts,
        proposalsCreated,
        noProposal: attempts - proposalsCreated,
        proposalRate: proposalsCreated / attempts,
      };
    });
  return conversions.length > 0 ? conversions : undefined;
}

function treatmentAttributionSummary(
  attribution: MutableRepairTreatmentAttribution,
): RepairTreatmentAttributionSummary | undefined {
  if (attribution.eligibleEvents === 0) return undefined;
  const distinctUnits = [...attribution.units.values()].reduce((sum, units) => sum + units.size, 0);
  const arms = REPAIR_TREATMENTS
    .map((repairTreatment): RepairTreatmentAttributionArmSummary => {
      const units = [...(attribution.units.get(repairTreatment)?.values() ?? [])];
      const attributedUnits = units.filter((unit) => unit.rawAttempts.size > 0).length;
      const terminalUnits = units.filter((unit) =>
        unit.witnessEvents === 1 &&
        unit.witness !== undefined &&
        unit.rawAttempts.has(unit.witness.executionKey)
      ).length;
      return {
        repairTreatment,
        attributedUnits,
        terminalUnits,
        remaining: Math.max(0, MIN_REPAIR_TREATMENT_ATTEMPTS - terminalUnits),
      };
    })
    .sort((left, right) => left.repairTreatment.localeCompare(right.repairTreatment));
  const blockers: RepairTreatmentAttributionBlocker[] = [];
  if (arms.some((arm) => arm.attributedUnits > arm.terminalUnits)) blockers.push('in-flight');
  const hasUnmatchedTerminal = [...attribution.units.values()].some((units) =>
    [...units.values()].some((unit) =>
      unit.witnessEvents > 0 && (
        unit.witnessEvents !== 1 ||
        unit.witness === undefined ||
        !unit.rawAttempts.has(unit.witness.executionKey)
      )
    )
  );
  if (hasUnmatchedTerminal) blockers.push('unmatched-terminal');
  if (attribution.unattributedEvents > 0) blockers.push('unattributed');
  if (attribution.replayedEvents > 0) blockers.push('replayed');
  const integrityWithheld = blockers.includes('unmatched-terminal') ||
    blockers.includes('unattributed') ||
    blockers.includes('replayed');
  const ready = arms.every((arm) => arm.remaining === 0) && !blockers.includes('in-flight');
  return {
    eligibleEvents: attribution.eligibleEvents,
    attributedEvents: attribution.attributedEvents,
    unattributedEvents: attribution.unattributedEvents,
    distinctUnits,
    replayedEvents: attribution.replayedEvents,
    minimumTerminalUnitsPerArm: MIN_REPAIR_TREATMENT_ATTEMPTS,
    arms,
    gate: integrityWithheld ? 'withheld' : ready ? 'ready' : 'collecting',
    blockers,
  };
}

function touchBucket(
  buckets: Map<string, MutableYieldBucket>,
  key: string,
  fields: Omit<Partial<MutableYieldBucket>, 'key' | 'attempts' | 'proposalsCreated' | 'spentUsd' | 'outcomes' | 'reasons'>,
): MutableYieldBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      ...fields,
      attempts: 0,
      proposalsCreated: 0,
      diagnosticAttempts: 0,
      diagnosticProposalsCreated: 0,
      diagnosticNoProposal: 0,
      spentUsd: 0,
      outcomes: emptyOutcomeCounts(),
      actionCounts: {},
      attemptShape: emptyProductionAttemptShape(),
      generatedRepairAttempts: emptyGeneratedRepairAttemptSummary(),
      repairTreatments: emptyRepairTreatmentAttribution(),
      reasons: new Map(),
      diagnosticReasons: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function addToBucket(bucket: MutableYieldBucket, event: DispatchProductionEvent): void {
  bucket.attempts++;
  if (event.proposalCreated) bucket.proposalsCreated++;
  bucket.spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
  incrementOutcome(bucket.outcomes, outcomeForAccounting(event));
  addRunActionCounts(bucket.actionCounts, event.runEventSummary?.actionCounts);
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, event.learningLabel);
  const cancelled = isCancelledDispatchProductionEvent(event);
  if (!cancelled && classification.diagnosticAttempt) bucket.diagnosticAttempts++;
  if (!cancelled && classification.kind === 'proposal-created') bucket.diagnosticProposalsCreated++;
  if (!cancelled && classification.diagnosticNoProposal) bucket.diagnosticNoProposal++;
  addProductionAttemptShape(bucket.attemptShape, classification.attemptShape);
  addGeneratedRepairAttempt(
    bucket.generatedRepairAttempts,
    generatedRepairAttemptKindFromSignals({
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }),
    event.proposalCreated,
    cancelled,
  );
  addRepairTreatmentAttempt(bucket.repairTreatments, event);
  const reason = event.reason ?? event.routeReason ?? event.outcome;
  bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
  addDiagnosticReason(bucket.diagnosticReasons, reason, classification);
}

function finalizeBucket(bucket: MutableYieldBucket): DispatchProductionYieldBucket {
  const proposalsCreated = bucket.proposalsCreated;
  const attempts = bucket.attempts;
  const treatmentConversions = sampleGatedTreatmentConversions(bucket.repairTreatments);
  const treatmentAttribution = treatmentAttributionSummary(bucket.repairTreatments);
  if (treatmentAttribution) bucket.generatedRepairAttempts.treatmentAttribution = treatmentAttribution;
  if (treatmentConversions) bucket.generatedRepairAttempts.treatmentConversions = treatmentConversions;
  return {
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.repo !== undefined ? { repo: bucket.repo } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    attempts,
    proposalsCreated,
    noProposal: Math.max(0, attempts - proposalsCreated),
    proposalRate: attempts > 0 ? proposalsCreated / attempts : 0,
    diagnosticAttempts: bucket.diagnosticAttempts,
    diagnosticNoProposal: bucket.diagnosticNoProposal,
    diagnosticProposalRate: bucket.diagnosticAttempts > 0
      ? bucket.diagnosticProposalsCreated / bucket.diagnosticAttempts
      : 0,
    spentUsd: bucket.spentUsd,
    outcomes: bucket.outcomes,
    ...(hasRunActionCounts(bucket.actionCounts) ? { actionCounts: bucket.actionCounts } : {}),
    ...(hasProductionAttemptShape(bucket.attemptShape) ? { attemptShape: bucket.attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(bucket.generatedRepairAttempts)
      ? { generatedRepairAttempts: bucket.generatedRepairAttempts }
      : {}),
    topReasons: sortedReasons(bucket.reasons, 5),
    diagnosticTopReasons: sortedReasons(bucket.diagnosticReasons, 5),
  };
}

function sortedBuckets(buckets: Map<string, MutableYieldBucket>, limit: number): DispatchProductionYieldBucket[] {
  return [...buckets.values()]
    .map(finalizeBucket)
    .sort(
      (a, b) =>
        Number((b.diagnosticAttempts ?? 0) > 0) - Number((a.diagnosticAttempts ?? 0) > 0) ||
        (b.diagnosticNoProposal ?? 0) - (a.diagnosticNoProposal ?? 0) ||
        (a.diagnosticProposalRate ?? 0) - (b.diagnosticProposalRate ?? 0) ||
        (b.diagnosticAttempts ?? 0) - (a.diagnosticAttempts ?? 0) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

function summarizeGeneratedRepairBackendTransitions(
  events: DispatchProductionEvent[],
  limit: number,
): GeneratedRepairBackendTransitionSummary | undefined {
  const attempts = new Map<string, DispatchProductionEvent>();
  const conflicts = new Set<string>();
  let lineageEvents = 0;
  let transitionEvents = 0;
  let duplicateEvents = 0;
  let invalidLineageEvents = 0;

  for (const event of events) {
    const hasAnyLineage = event.repairLineageInvalid === true ||
      event.repairHandoffId !== undefined ||
      event.repairGenerationId !== undefined ||
      event.repairAttemptOrdinal !== undefined ||
      event.repairPreviousBackend !== undefined;
    if (!hasAnyLineage) continue;

    const complete = event.repairLineageInvalid !== true &&
      typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId) &&
      typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId) &&
      repairGenerationIdFromHandoffId(event.repairHandoffId) === event.repairGenerationId &&
      (event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2) &&
      (event.repairAttemptOrdinal === 1
        ? event.repairPreviousBackend === undefined
        : ENGINE_IDS.has(event.repairPreviousBackend as EngineId) && event.backend !== event.repairPreviousBackend);
    if (!complete || !ENGINE_IDS.has(event.backend as EngineId)) {
      invalidLineageEvents++;
      continue;
    }

    lineageEvents++;
    if (event.repairAttemptOrdinal !== 2 || event.repairPreviousBackend === undefined) continue;
    transitionEvents++;
    const executionId = event.runId ?? event.trajectoryId;
    if (!executionId) {
      invalidLineageEvents++;
      continue;
    }
    const key = `${event.repairGenerationId}:2:${executionId}`;
    const previous = attempts.get(key);
    if (!previous) {
      attempts.set(key, event);
      continue;
    }
    const same = previous.repairHandoffId === event.repairHandoffId &&
      previous.repairPreviousBackend === event.repairPreviousBackend &&
      previous.backend === event.backend &&
      outcomeForAccounting(previous) === outcomeForAccounting(event) &&
      previous.proposalCreated === event.proposalCreated;
    if (same) duplicateEvents++;
    else conflicts.add(key);
  }

  if (lineageEvents === 0 && invalidLineageEvents === 0) return undefined;

  const buckets = new Map<string, GeneratedRepairBackendTransitionBucket>();
  for (const [key, event] of attempts) {
    if (conflicts.has(key) || event.backend === null || event.repairPreviousBackend === undefined) continue;
    const bucketKey = `${event.repairPreviousBackend}:${event.backend}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        previousBackend: event.repairPreviousBackend,
        retryBackend: event.backend,
        attempts: 0,
        proposalsCreated: 0,
        noProposal: 0,
        proposalRate: 0,
        outcomes: emptyOutcomeCounts(),
      };
      buckets.set(bucketKey, bucket);
    }
    incrementOutcome(bucket.outcomes, outcomeForAccounting(event));
    if (isCancelledDispatchProductionEvent(event)) continue;
    bucket.attempts++;
    if (event.proposalCreated) bucket.proposalsCreated++;
    else bucket.noProposal++;
    bucket.proposalRate = bucket.proposalsCreated / bucket.attempts;
  }

  const aggregateAttempts = [...buckets.values()]
    .reduce((total, bucket) => total + bucket.attempts, 0);
  const byTransition = [...buckets.values()]
    .sort((a, b) => b.attempts - a.attempts ||
      a.previousBackend.localeCompare(b.previousBackend) ||
      a.retryBackend.localeCompare(b.retryBackend))
    .slice(0, limit);
  return {
    sourceState: conflicts.size > 0 || invalidLineageEvents > 0 ? 'degraded' : 'healthy',
    lineageEvents,
    transitionEvents,
    attempts: aggregateAttempts,
    duplicateEvents,
    conflictingAttempts: conflicts.size,
    invalidLineageEvents,
    byTransition,
  };
}

export function summarizeDispatchProductionYield(
  events: DispatchProductionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
  },
): DispatchProductionYieldSummary | undefined {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  if (events.length === 0) return undefined;

  const byBackend = new Map<string, MutableYieldBucket>();
  const bySource = new Map<string, MutableYieldBucket>();
  const byRepo = new Map<string, MutableYieldBucket>();
  const byBackendModel = new Map<string, MutableYieldBucket>();
  const byBackendSource = new Map<string, MutableYieldBucket>();
  const topReasons = new Map<string, number>();
  const overall = emptyOutcomeCounts();
  const actionCounts: RunActionCounts = {};
  const attemptShape = emptyProductionAttemptShape();
  const generatedRepairAttempts = emptyGeneratedRepairAttemptSummary();
  const repairTreatments = emptyRepairTreatmentAttribution();
  let proposalsCreated = 0;
  let diagnosticAttempts = 0;
  let diagnosticProposalsCreated = 0;
  let diagnosticNoProposal = 0;
  let spentUsd = 0;
  let total = 0;
  const diagnosticTopReasons = new Map<string, number>();

  for (const event of events) {
    if (event.basis === 'repair-lifecycle-candidate') continue;
    if (event.basis === 'repair-lifecycle-outcome') {
      addRepairTreatmentAttempt(repairTreatments, event);
      addRepairTreatmentAttempt(
        touchBucket(byBackend, event.backend ?? 'unknown', { backend: event.backend }).repairTreatments,
        event,
      );
      addRepairTreatmentAttempt(touchBucket(bySource, event.source, { source: event.source }).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(byRepo, event.repo, { repo: event.repo }).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(
        byBackendModel,
        `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`,
        { backend: event.backend, model: event.model ?? null },
      ).repairTreatments, event);
      addRepairTreatmentAttempt(touchBucket(
        byBackendSource,
        `${event.backend ?? 'unknown'}:${event.source}`,
        { backend: event.backend, source: event.source },
      ).repairTreatments, event);
      continue;
    }
    total++;
    if (event.proposalCreated) proposalsCreated++;
    spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
    incrementOutcome(overall, outcomeForAccounting(event));
    addRunActionCounts(actionCounts, event.runEventSummary?.actionCounts);
    const classification = classifyProductionAttemptForLearningWithLabel({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
      reason: event.reason ?? event.routeReason,
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }, event.learningLabel);
    const cancelled = isCancelledDispatchProductionEvent(event);
    if (!cancelled && classification.diagnosticAttempt) diagnosticAttempts++;
    if (!cancelled && classification.kind === 'proposal-created') diagnosticProposalsCreated++;
    if (!cancelled && classification.diagnosticNoProposal) diagnosticNoProposal++;
    addProductionAttemptShape(attemptShape, classification.attemptShape);
    addGeneratedRepairAttempt(
      generatedRepairAttempts,
      generatedRepairAttemptKindFromSignals({
        itemId: event.itemId,
        title: event.title,
        source: event.source,
      }),
      event.proposalCreated,
      cancelled,
    );
    addRepairTreatmentAttempt(repairTreatments, event);
    const reason = event.reason ?? event.routeReason ?? event.outcome;
    topReasons.set(reason, (topReasons.get(reason) ?? 0) + 1);
    addDiagnosticReason(diagnosticTopReasons, reason, classification);

    const backendKey = event.backend ?? 'unknown';
    addToBucket(touchBucket(byBackend, backendKey, { backend: event.backend }), event);

    const sourceKey = event.source;
    addToBucket(touchBucket(bySource, sourceKey, { source: event.source }), event);

    const repoKey = event.repo;
    addToBucket(touchBucket(byRepo, repoKey, { repo: event.repo }), event);

    const modelKey = `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`;
    addToBucket(touchBucket(byBackendModel, modelKey, { backend: event.backend, model: event.model ?? null }), event);

    const backendSourceKey = `${event.backend ?? 'unknown'}:${event.source}`;
    addToBucket(
      touchBucket(byBackendSource, backendSourceKey, { backend: event.backend, source: event.source }),
      event,
    );
  }

  const treatmentConversions = sampleGatedTreatmentConversions(repairTreatments);
  const treatmentAttribution = treatmentAttributionSummary(repairTreatments);
  if (treatmentAttribution) generatedRepairAttempts.treatmentAttribution = treatmentAttribution;
  if (treatmentConversions) generatedRepairAttempts.treatmentConversions = treatmentConversions;
  const generatedRepairBackendTransitions = summarizeGeneratedRepairBackendTransitions(
    events.filter((event) =>
      event.basis !== 'repair-lifecycle-candidate' && event.basis !== 'repair-lifecycle-outcome'
    ),
    limit,
  );
  return {
    windowHours: opts?.windowHours ?? 24,
    attempts: total,
    events: total,
    proposalsCreated,
    noProposal: Math.max(0, total - proposalsCreated),
    proposalRate: total > 0 ? proposalsCreated / total : 0,
    diagnosticAttempts,
    diagnosticNoProposal,
    diagnosticProposalRate: diagnosticAttempts > 0 ? diagnosticProposalsCreated / diagnosticAttempts : 0,
    spentUsd,
    outcomes: overall,
    ...(hasRunActionCounts(actionCounts) ? { actionCounts } : {}),
    ...(hasProductionAttemptShape(attemptShape) ? { attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(generatedRepairAttempts) ? { generatedRepairAttempts } : {}),
    ...(generatedRepairBackendTransitions ? { generatedRepairBackendTransitions } : {}),
    topReasons: sortedReasons(topReasons, limit),
    diagnosticTopReasons: sortedReasons(diagnosticTopReasons, limit),
    byBackend: sortedBuckets(byBackend, limit),
    bySource: sortedBuckets(bySource, limit),
    byRepo: sortedBuckets(byRepo, limit),
    byBackendModel: sortedBuckets(byBackendModel, limit),
    byBackendSource: sortedBuckets(byBackendSource, limit),
  };
}

function withholdTreatmentConversions(summary: DispatchProductionYieldSummary | undefined): void {
  if (!summary) return;
  const withhold = (generated: GeneratedRepairAttemptSummary | undefined): void => {
    if (!generated) return;
    delete generated.treatmentConversions;
    const attribution = generated.treatmentAttribution;
    if (!attribution) return;
    attribution.gate = 'withheld';
    if (!attribution.blockers.includes('source-incomplete')) {
      attribution.blockers = [...attribution.blockers, 'source-incomplete'];
    }
  };
  withhold(summary.generatedRepairAttempts);
  for (const buckets of [
    summary.byBackend,
    summary.bySource,
    summary.byRepo,
    summary.byBackendModel,
    summary.byBackendSource,
  ]) {
    for (const bucket of buckets) withhold(bucket.generatedRepairAttempts);
  }
}

export function readDispatchProductionYieldDetailed(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldReadResult {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const read = readDispatchProductionEventsDetailed({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
    maxBytes: opts?.maxBytes,
    maxRows: opts?.maxRows,
  });
  const summary = summarizeDispatchProductionYield(read.events, {
    windowHours: windowMs / (60 * 60 * 1000),
    limitPerDimension: opts?.limitPerDimension,
  });
  if (read.sourceState !== 'healthy' || !read.complete) withholdTreatmentConversions(summary);
  const { events: _events, ...sourceQuality } = read;
  return {
    ...(summary ? { summary } : {}),
    sourceQuality,
    ...(read.sourceState === 'healthy' && read.complete
      ? {
          selectionObservationState: read.events.length === 0
            ? 'no-dispatches' as const
            : read.events.some((event) => event.selectionObservation !== undefined)
              ? 'unjoined' as const
              : 'not-observed' as const,
        }
      : {}),
  };
}

export function readDispatchProductionYield(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldSummary | undefined {
  return readDispatchProductionYieldDetailed(opts).summary;
}
