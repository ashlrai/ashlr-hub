/**
 * dispatch-production-ledger.ts — append-only proposal-production outcome stream.
 *
 * Writes metadata-only rows to ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl
 * (or $ASHLR_HOME/dispatch-production). This is history/analytics, not the
 * cooldown ledger: never truncate, never rewrite, never throw.
 */

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
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
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
import { causalMetadata } from '../learning/causal.js';
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
import {
  generatedRepairLifecycleAttemptHash,
  REPAIR_TREATMENTS,
  repairGenerationIdFromHandoffId,
  repairTreatmentForUnitId,
} from './generated-repair-identity.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 2_000;
const DEFAULT_READ_MAX_FILES = 31;
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 10_000;
const HARD_READ_MAX_FILES = 32;
const HARD_READ_MAX_BYTES = 32 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 50_000;
const MAX_LOOSE_FILES = 3;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_READ_ROW_BYTES = 128 * 1024;
const MAX_TREATMENT_OUTCOME_RECEIPTS = 2_048;
const MAX_TREATMENT_RECEIPT_DIR_ENTRIES = MAX_TREATMENT_OUTCOME_RECEIPTS + 16;
const TREATMENT_RECEIPT_RETENTION_FILE = '.retention.json';
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);
const MIN_REPAIR_TREATMENT_ATTEMPTS = 3;

export type DispatchProductionBasis =
  | 'run-proposal-outcome'
  | 'pending-proposal-delta'
  | 'best-of-n-summary'
  | 'repair-lifecycle-candidate'
  | 'repair-lifecycle-outcome'
  | 'unknown';

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

function treatmentOutcomeReceiptDir(): string {
  return join(dispatchProductionDir(), 'repair-treatment-outcomes');
}

function treatmentOutcomeReceiptName(event: DispatchProductionEvent): string | null {
  if (
    event.basis !== 'repair-lifecycle-outcome' ||
    !event.repairGenerationId || !SHA256_RE.test(event.repairGenerationId) ||
    !event.repairTreatmentAttemptHash || !SHA256_RE.test(event.repairTreatmentAttemptHash)
  ) return null;
  return `${event.repairGenerationId}-${event.repairTreatmentAttemptHash}.json`;
}

function treatmentReceiptLockPath(): string {
  return join(treatmentOutcomeReceiptDir(), '.receipts.lock');
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
  const repairLineageFieldsPresent = event.repairHandoffId !== undefined ||
    event.repairGenerationId !== undefined ||
    event.repairTreatmentUnitId !== undefined ||
    event.repairTreatment !== undefined ||
    event.repairTreatmentOutcome !== undefined ||
    event.repairTreatmentAttemptHash !== undefined ||
    event.repairAttemptOrdinal !== undefined ||
    event.repairPreviousBackend !== undefined;
  const repairLineageComplete = event.repairLineageInvalid !== true &&
    backend !== undefined &&
    backend !== null &&
    ENGINE_IDS.has(backend) &&
    repairHandoffId !== undefined &&
    repairGenerationId !== undefined &&
    repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId &&
    ((repairTreatmentUnitId === undefined && repairTreatment === undefined) || (
      repairTreatmentUnitId !== undefined && repairTreatment !== undefined &&
      /:proposal-repair-nodiff:[0-9a-f]{12}$/i.test(itemId) &&
      repairTreatmentForUnitId(repairTreatmentUnitId) === repairTreatment
    )) &&
    repairAttemptOrdinal !== undefined &&
    (repairAttemptOrdinal === 1
      ? repairPreviousBackend === undefined
      : repairPreviousBackend !== undefined && backend !== repairPreviousBackend);
  const lifecycleAttemptId = trajectoryId ?? runId;
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
    ...(learningLabel ? { learningLabel } : {}),
    ...(objectiveHash ? { objectiveHash } : {}),
    ...(repairLineageInvalid
      ? { repairLineageInvalid: true as const }
      : repairLineageComplete
        ? {
          repairHandoffId,
          repairGenerationId,
          ...(repairTreatmentUnitId ? { repairTreatmentUnitId } : {}),
          ...(repairTreatment ? { repairTreatment } : {}),
          ...(repairTreatmentOutcomeComplete || repairTreatmentCandidateComplete ? {
            ...(repairTreatmentOutcome ? { repairTreatmentOutcome } : {}),
            repairTreatmentAttemptHash,
          } : {}),
          repairAttemptOrdinal,
          ...(repairPreviousBackend ? { repairPreviousBackend } : {}),
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
): { attempted: number; recorded: number; failed: number } {
  const result = { attempted: 0, recorded: 0, failed: 0 };
  try {
    const events = Array.isArray(input) ? input : [input];
    result.attempted = events.length;
    if (events.length === 0) return result;
    const dir = dispatchProductionDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      fsyncDirectory(dirname(dir));
    }
    for (const event of events) {
      try {
        const record = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
        if (!isDispatchProductionEvent(record)) throw new Error('dispatch production repository identity is not canonical');
        const receiptName = treatmentOutcomeReceiptName(record);
        if (receiptName) persistTreatmentOutcomeReceipt(record, receiptName);
        else appendDispatchProductionLine(
          join(dir, `${eventDateString(record.ts)}.jsonl`),
          JSON.stringify(record) + '\n',
        );
        result.recorded += 1;
      } catch {
        // Skip only this record; later records in the batch still get a chance.
        result.failed += 1;
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
    result.failed = Math.max(result.failed, result.attempted - result.recorded);
  }
  return result;
}

function persistTreatmentOutcomeReceipt(event: DispatchProductionEvent, name: string): void {
  const dir = treatmentOutcomeReceiptDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!safeDispatchProductionDirectory(dirStat)) throw new Error('unsafe treatment outcome receipt directory');
  chmodSync(dir, 0o700);
  const path = join(dir, name);
  const lock = acquireLocalStoreLock(treatmentReceiptLockPath());
  if (!lock) throw new Error('treatment outcome receipt lock unavailable');
  let fd: number | undefined;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    if (existsSync(path)) {
      const loaded = readDispatchProductionFileTail(path, MAX_READ_ROW_BYTES);
      if (!loaded || loaded.truncated) throw new Error('invalid existing treatment outcome receipt');
      const parsed: unknown = JSON.parse(loaded.text);
      if (!isDispatchProductionEvent(parsed)) throw new Error('invalid existing treatment outcome receipt');
      if (treatmentOutcomeReceiptName(parsed) !== name) throw new Error('conflicting treatment outcome receipt');
      return;
    }
    pruneTreatmentOutcomeReceipts(dir);
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    if (bytes.length > MAX_READ_ROW_BYTES) throw new Error('treatment outcome receipt too large');
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment outcome receipt write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve primary failure */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    releaseLocalStoreLock(lock);
  }
}

function writeTreatmentReceiptRetention(dir: string, droppedThrough: string): void {
  const path = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    let priorMs = Number.NEGATIVE_INFINITY;
    if (existsSync(path)) {
      const loaded = readDispatchProductionFileTail(path, 4_096);
      if (!loaded || loaded.truncated) throw new Error('invalid treatment receipt retention marker');
      const parsed = JSON.parse(loaded.text) as { droppedThrough?: unknown };
      priorMs = typeof parsed.droppedThrough === 'string' ? Date.parse(parsed.droppedThrough) : Number.NaN;
      if (!Number.isFinite(priorMs)) throw new Error('invalid treatment receipt retention marker');
    }
    const nextMs = Math.max(priorMs, Date.parse(droppedThrough));
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, droppedThrough: new Date(nextMs).toISOString() })}\n`);
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short treatment receipt retention write');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve failure */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function pruneTreatmentOutcomeReceipts(dir: string): void {
  const receipts: Array<{ name: string; ts: string }> = [];
  const handle = opendirSync(dir);
  try {
    let physical = 0;
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      physical++;
      if (physical > MAX_TREATMENT_RECEIPT_DIR_ENTRIES) throw new Error('treatment receipt directory limit');
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const loaded = readDispatchProductionFileTail(join(dir, entry.name), MAX_READ_ROW_BYTES);
      if (!loaded || loaded.truncated) throw new Error('invalid treatment outcome receipt during retention');
      const parsed: unknown = JSON.parse(loaded.text);
      if (!isDispatchProductionEvent(parsed) || treatmentOutcomeReceiptName(parsed) !== entry.name) {
        throw new Error('unbound treatment outcome receipt during retention');
      }
      receipts.push({ name: entry.name, ts: parsed.ts });
    }
  } finally { handle.closeSync(); }
  if (receipts.length < MAX_TREATMENT_OUTCOME_RECEIPTS) return;
  receipts.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.name.localeCompare(right.name));
  const dropping = receipts.slice(0, receipts.length - MAX_TREATMENT_OUTCOME_RECEIPTS + 1);
  const droppedThrough = dropping.reduce((latest, receipt) =>
    Date.parse(receipt.ts) > Date.parse(latest) ? receipt.ts : latest, dropping[0]!.ts);
  writeTreatmentReceiptRetention(dir, droppedThrough);
  for (const receipt of dropping) unlinkSync(join(dir, receipt.name));
  fsyncDirectory(dir);
}

function appendDispatchProductionLine(path: string, line: string): void {
  const lock = acquireLocalStoreLock(`${path}.lock`);
  if (!lock) throw new Error('dispatch production ledger lock unavailable');
  let fd: number | undefined;
  try {
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
    if (!existed) {
      fsyncDirectory(dirname(path));
    }
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
    const events: DispatchProductionEvent[] = [];
    let invalid = !complete;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        invalid = true;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isDispatchProductionEvent(parsed)) {
          invalid = true;
          continue;
        }
        events.push(sanitizeDispatchProductionEvent(parsed, {
          deriveLegacyRunOutcomeCausal: true,
          materializeLearningLabel: true,
        }));
      } catch {
        invalid = true;
      }
    }
    for (const index of indices) {
      const target = targets[index]!;
      const targetRepo = canonicalDispatchRepoIdentity(target.repo);
      const found = events.some((event) =>
        targetRepo !== null &&
        event.ts === target.ts &&
        event.itemId === target.itemId &&
        event.repo === targetRepo &&
        event.outcome === target.outcome &&
        (event.trajectoryId ?? event.runId) === target.attemptId &&
        (target.source === undefined || event.source === target.source) &&
        (target.backend === undefined || event.backend === target.backend) &&
        (target.tier === undefined || event.tier === target.tier) &&
        (target.objectiveHash === undefined || event.objectiveHash === target.objectiveHash));
      statuses[index] = found
        ? 'found'
        : loaded.truncated || invalid
          ? 'degraded'
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
      return statuses.map((status) => status === 'found' ? 'degraded' : status);
    }
  } catch {
    return statuses.map((status) => status === 'found' ? 'degraded' : status);
  }
  return statuses;
}

function mergeTreatmentOutcomeReceipts(
  result: DispatchProductionEventsReadResult,
  opts: ReadDispatchProductionEventsOptions,
  cap: number,
  maxBytes: number,
  maxRows: number,
): void {
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
  try {
    const retentionPath = join(dir, TREATMENT_RECEIPT_RETENTION_FILE);
    if (existsSync(retentionPath)) {
      const loaded = readDispatchProductionFileTail(retentionPath, 4_096);
      if (!loaded || loaded.truncated) throw new Error('invalid receipt retention marker');
      const parsed = JSON.parse(loaded.text) as { schemaVersion?: unknown; droppedThrough?: unknown };
      const droppedMs = typeof parsed.droppedThrough === 'string' ? Date.parse(parsed.droppedThrough) : Number.NaN;
      if (parsed.schemaVersion !== 1 || !Number.isFinite(droppedMs)) throw new Error('invalid receipt retention marker');
      if (opts.sinceMs === undefined || opts.sinceMs <= droppedMs) {
        result.complete = false;
        pushStopReason(result.stopReasons, 'file-limit');
      }
    }
  } catch {
    result.complete = false;
    result.unreadableFiles++;
    pushStopReason(result.stopReasons, 'io-error');
  }
  const receipts = new Map<string, DispatchProductionEvent>();
  for (const name of entries) {
    if (result.rowsScanned >= maxRows || result.bytesRead >= maxBytes) {
      result.complete = false;
      pushStopReason(result.stopReasons, result.rowsScanned >= maxRows ? 'row-limit' : 'byte-limit');
      break;
    }
    const remaining = Math.min(MAX_READ_ROW_BYTES, maxBytes - result.bytesRead);
    const loaded = readDispatchProductionFileTail(join(dir, name), remaining);
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
      const parsed: unknown = JSON.parse(loaded.text);
      if (!isDispatchProductionEvent(parsed)) throw new Error('invalid receipt');
      const event = parsed;
      if (event.basis !== 'repair-lifecycle-outcome' || treatmentOutcomeReceiptName(event) !== name) {
        throw new Error('unbound receipt');
      }
      const eventMs = Date.parse(event.ts);
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
