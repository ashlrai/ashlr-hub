import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isOuterAttemptIdentity, isSafeExecutionIdentity } from './attempt-identity.js';
import {
  isTrustedCaptureRepairItem,
  isTrustedDiagnosticResliceItem,
  isTrustedGeneratedRepairItem,
} from './self-heal-trust.js';
import type { EngineId, EngineTier, Proposal, RepairTreatment, WorkItem } from '../types.js';
import { listProposalsDetailed, loadProposal } from '../inbox/store.js';
import {
  canonicalDispatchRepoIdentity,
  dispatchProductionDir,
  hasExactDispatchProductionTreatmentOutcomeReceipt,
  readDispatchProductionFailureAttemptReceipts,
  readDispatchProductionAttemptProtocolQuality,
  recordDispatchProduction,
  resolveDispatchProductionAttemptReceiptWitnesses,
  resolveDispatchProductionAttemptWitnesses,
  sanitizeDispatchProductionEvent,
  withDispatchProductionGenerationAuthority,
  type DispatchProductionAttemptProof,
  type DispatchProductionAttemptProofTarget,
  type DispatchProductionEvent,
} from './dispatch-production-ledger.js';
import {
  readRepairHandoffs,
  repairGenerationIdFromHandoffId,
  repairHandoffObjectiveControlFamilyKey,
  type RepairHandoffObservation,
} from './repair-handoff-journal.js';
import {
  generatedRepairLifecycleAttemptHash,
  repairTreatmentForUnitId,
  repairTreatmentUnitId,
} from './generated-repair-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import {
  acquireProposalStoreMutationLock,
  releaseProposalStoreMutationLock,
} from '../inbox/proposal-mutation-lock.js';
import { workItemObjectiveHash } from './work-item-objective.js';
import { scrubSecrets } from '../util/scrub.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';

const MAX_RECORDS = 100_000;
const MAX_LEDGER_BYTES = 32 * 1024 * 1024;
const MAX_CAPSULE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_OUTCOMES = 2_048;
const MAX_PUBLICATION_CAPSULE_BYTES = 4 * 1024;
const MAX_FAILURE_MARKER_BYTES = 4 * 1024;
const MAX_ATTEMPT_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPT_RETENTION_BYTES = 256 * 1024;
const MAX_ATTEMPT_ROW_BYTES = 128 * 1024;
const MAX_ATTEMPT_ROWS = 50_000;
const MAX_CACHED_RECORDS = 4_096;
const MAX_PROPOSAL_AUTHORITY_FILES = 4_096;
const MAX_PROPOSAL_AUTHORITY_BYTES = 64 * 1024 * 1024;
const MAX_PROPOSAL_AUTHORITY_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HANDOFF_ALIAS_GENERATIONS = 64;
const ATTEMPT_MEMBERSHIP_BITS = 1_048_576;
const ATTEMPT_MEMBERSHIP_BYTES = ATTEMPT_MEMBERSHIP_BITS / 8;
const ATTEMPT_MEMBERSHIP_HASHES = 7;
const MAX_ATTEMPT_MEMBERSHIP_SEGMENTS = 4;
const MAX_ATTEMPT_MEMBERSHIP_FALSE_POSITIVE_RATE = 1e-7;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);

export type GeneratedRepairDisposition = 'active' | 'retired' | 'exhausted' | 'quarantined';

interface GeneratedRepairLifecycleRecord {
  generationId: string;
  disposition: GeneratedRepairDisposition;
  emptyAttemptHashes: string[];
  emptyAttemptBackends?: EngineId[];
  emptyAttemptTiers?: EngineTier[];
  emptyAttemptProofReceipts?: GeneratedRepairDispatchProofReceipt[];
  terminalAttemptHash?: string;
  terminalAttemptProofReceipt?: GeneratedRepairDispatchProofReceipt;
  proposalAuthority?: GeneratedRepairProposalAuthority;
  treatmentWitnessRecordedAt?: string;
  treatmentWitnessDigest?: string;
  updatedAt: string;
}

interface GeneratedRepairDispatchProofReceipt {
  proof: DispatchProductionAttemptProof;
  /** Hash of the exact proof target, excluding the observation-only scan cutoff. */
  targetDigest?: string;
  /** Allowlisted metadata needed to publish after analytics and attempt-receipt retention. */
  publication?: GeneratedRepairPublicationCapsule;
  /** Binds publication metadata to the proof and exact target digest. */
  publicationDigest?: string;
  /** Exact immutable writer receipt bytes and epoch observed when the capsule was minted. */
  sourceReceiptFileDigest?: string;
  sourceRetirementEpoch?: number;
}

interface GeneratedRepairProposalAuthority {
  schemaVersion: 1 | 2;
  proposalIdHash: string;
  trajectoryIdHash: string;
  eventTs: string;
  eventDigest: string;
  contentDigest: string;
  attemptReceipt?: {
    generationId: string;
    ordinal: 1 | 2;
    fileDigest: string;
    retirementEpoch: number;
  };
  bindingDigest: string;
}

interface GeneratedRepairPublicationCapsule {
  schemaVersion: 1;
  itemId: string;
  repo: string;
  source: 'self';
  outcome: 'empty-diff' | 'proposal-created';
  proposalId?: string;
  trajectoryId: string;
  objectiveHash: string;
  /** Present only when an ordinal-two success is bound to an exact failed predecessor. */
  repairRootId?: string;
  repairDepth?: 0 | 1;
}

interface GeneratedRepairDispatchAttemptWitness {
  proof: DispatchProductionAttemptProof;
  event?: DispatchProductionEvent;
}

interface GeneratedRepairLifecycleLedger {
  schemaVersion: 2;
  retention?: { droppedThrough: string };
  records: GeneratedRepairLifecycleRecord[];
}

let lifecycleLedgerCache: { fingerprint: string; ledger: GeneratedRepairLifecycleLedger } | undefined;
let lifecycleDirectoryFsyncHookForTest: ((dir: string) => void) | undefined;
let lifecycleRaceHooksForTest: {
  ordinaryProposalAuthorityValidated?: () => void;
  candidateInstalledBeforeCommit?: () => void;
} | undefined;
let lifecycleAdmissionTraceHookForTest: ((stage: string) => void) | undefined;

/** Deterministic durability fault seam; production callers must never set this. */
export function _setGeneratedRepairLifecycleDirectoryFsyncHookForTest(
  hook: ((dir: string) => void) | undefined,
): void {
  lifecycleDirectoryFsyncHookForTest = hook;
}

/** Deterministic concurrency seams; production callers must never set these. */
export function _setGeneratedRepairLifecycleRaceHooksForTest(
  hooks: typeof lifecycleRaceHooksForTest,
): void {
  lifecycleRaceHooksForTest = hooks;
}

/** Test-only admission trace; production callers must never set this. */
export function _setGeneratedRepairLifecycleAdmissionTraceHookForTest(
  hook: ((stage: string) => void) | undefined,
): void {
  lifecycleAdmissionTraceHookForTest = hook;
}

export function _resetGeneratedRepairLifecycleCacheForTest(): void {
  lifecycleLedgerCache = undefined;
}

function cloneLedger(ledger: GeneratedRepairLifecycleLedger): GeneratedRepairLifecycleLedger {
  return {
    schemaVersion: 2,
    ...(ledger.retention ? { retention: { ...ledger.retention } } : {}),
    records: ledger.records.map((record) => ({
      ...record,
      emptyAttemptHashes: record.emptyAttemptHashes.slice(),
      ...(record.emptyAttemptBackends
        ? { emptyAttemptBackends: record.emptyAttemptBackends.slice() }
        : {}),
      ...(record.emptyAttemptTiers
        ? { emptyAttemptTiers: record.emptyAttemptTiers.slice() }
        : {}),
      ...(record.emptyAttemptProofReceipts
        ? { emptyAttemptProofReceipts: structuredClone(record.emptyAttemptProofReceipts) }
        : {}),
      ...(record.terminalAttemptProofReceipt
        ? { terminalAttemptProofReceipt: structuredClone(record.terminalAttemptProofReceipt) }
        : {}),
      ...(record.proposalAuthority
        ? { proposalAuthority: { ...record.proposalAuthority } }
        : {}),
    })),
  };
}

export interface GeneratedRepairLifecycleResult {
  available: boolean;
  disposition: GeneratedRepairDisposition;
  authoritativeEmptyRuns: number;
  unavailableReason?: 'proofless-legacy' | 'retention-degraded' | 'storage-recovery-required';
  requiredAction?: 'operator-reset';
  lastAuthoritativeEmptyBackend?: EngineId | null;
  authoritativeEmptyBackends?: EngineId[];
  authoritativeEmptyTiers?: EngineTier[];
}

export type GeneratedRepairDispatchState =
  | { applies: false; state: 'not-applicable'; dispatchable: true }
  | { applies: true; state: 'active'; dispatchable: true; disposition: 'active' }
  | {
      applies: true;
      state: 'terminal';
      dispatchable: false;
      disposition: Exclude<GeneratedRepairDisposition, 'active'>;
    }
  | { applies: true; state: 'lifecycle-unavailable'; dispatchable: false };

export type GeneratedRepairLifecycleEvidence =
  | { kind: 'proposal-created'; attemptId: string; proposalId: string; ts?: string; treatmentCandidate?: DispatchProductionEvent }
  | { kind: 'empty-diff'; attemptId: string; backend: EngineId; tier: EngineTier; ts?: string; treatmentCandidate?: DispatchProductionEvent }
  | { kind: 'dispatch-proof-empty-diff'; eventTs: string; treatmentCandidate?: DispatchProductionEvent }
  | { kind: 'non-terminal'; attemptId?: string; ts?: string };

export interface GeneratedRepairLifecycleTransitionResult extends GeneratedRepairLifecycleResult {
  recorded: boolean;
  /** Present only when this call durably committed a new terminal treatment outcome. */
  treatmentOutcomeWitness?: GeneratedRepairTreatmentOutcomeWitness;
}

export interface GeneratedRepairTreatmentOutcomeWitness {
  outcome: 'converted' | 'not-converted';
  disposition: 'retired' | 'exhausted' | 'quarantined';
  generationId: string;
  attemptHash: string;
}

export interface PendingGeneratedRepairTreatmentOutcome extends GeneratedRepairTreatmentOutcomeWitness {
  candidate: DispatchProductionEvent;
}

export type PendingGeneratedRepairTreatmentOutcomeRead =
  PendingGeneratedRepairTreatmentOutcome[] & {
    readonly available: boolean;
    readonly prooflessLegacy: number;
    readonly requiredAction: 'operator-reset' | null;
  };

export function readGeneratedRepairTerminalOutcome(
  generationId: string,
): GeneratedRepairTreatmentOutcomeWitness | null {
  if (!SHA256_RE.test(generationId)) return null;
  const loaded = loadStableReadableLedger();
  if (!loaded.ok) return null;
  const record = loaded.ledger.records.find((candidate) => candidate.generationId === generationId);
  if (
    !record ||
    (record.disposition !== 'retired' && record.disposition !== 'exhausted' && record.disposition !== 'quarantined') ||
    !record.terminalAttemptHash ||
    !proposalAuthorityStillValid(record)
  ) return null;
  const authority = handoffAuthoritySnapshot();
  if (
    record.treatmentWitnessRecordedAt
      ? !hasExactPublishedTreatmentReceipt(record, authority)
      : !terminalCandidateFromCapsule(record, authority, true) &&
        !hasExactPendingTreatmentReceipt(record, authority)
  ) return null;
  return {
    outcome: record.disposition === 'retired' ? 'converted' : 'not-converted',
    disposition: record.disposition,
    generationId,
    attemptHash: record.terminalAttemptHash,
  };
}

export interface GeneratedRepairRetryPolicy {
  applies: boolean;
  available: boolean;
  requireAlternative: boolean;
  excludedBackend: EngineId | null;
  requiredTier: EngineTier | null;
}

export interface GeneratedRepairDispatchLineage {
  repairHandoffId: string;
  repairGenerationId: string;
  repairTreatmentUnitId: string;
  repairTreatment: RepairTreatment;
  repairAttemptOrdinal: 1 | 2;
  repairPreviousBackend?: EngineId;
}

export function generatedRepairLifecyclePath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'generated-repair-lifecycle.json');
}

interface HandoffAuthoritySnapshot {
  byEventId: Map<string, RepairHandoffObservation>;
  observations: RepairHandoffObservation[];
  objectiveControlGenerationsByEventId: Map<string, string[]>;
  exactParentRowGenerationsByEventId: Map<string, string[]>;
  degradedObjectiveControlEventIds: Set<string>;
  observationsByGenerationId: Map<string, RepairHandoffObservation[]>;
  widenedCaptureChildren: Set<string>;
  sourceState: 'missing' | 'healthy' | 'degraded';
}

function handoffTreatmentTuple(
  observation: RepairHandoffObservation,
): readonly [string, RepairTreatment] | null {
  if (observation.kind !== 'no-diff-reslice' || !observation.parentObjectiveHash) return null;
  const unitId = repairTreatmentUnitId({
    kind: observation.kind,
    repo: observation.repo,
    parentItemId: observation.parentItemId,
    parentObjectiveHash: observation.parentObjectiveHash,
  });
  const treatment = unitId ? repairTreatmentForUnitId(unitId) : null;
  return unitId && treatment ? [unitId, treatment] : null;
}

function compatibleActiveEvidenceAliasKey(
  observation: RepairHandoffObservation,
): string | null {
  if (
    !observation.parentObjectiveHash ||
    observation.parentSource === undefined ||
    observation.parentBackend === undefined ||
    observation.parentTier === undefined
  ) return null;
  const treatment = handoffTreatmentTuple(observation);
  if (!treatment) return null;
  return JSON.stringify([
    observation.parentSource,
    observation.parentBackend,
    observation.parentTier,
    observation.parentObjectiveHash,
    observation.childItemId,
    ...treatment,
  ]);
}

function exactParentRowAliasKey(observation: RepairHandoffObservation): string | null {
  const objectiveControlKey = repairHandoffObjectiveControlFamilyKey(observation);
  if (
    !objectiveControlKey ||
    observation.parentSource === undefined ||
    observation.parentBackend === undefined ||
    observation.parentTier === undefined
  ) return null;
  const treatment = handoffTreatmentTuple(observation);
  if (!treatment) return null;
  return JSON.stringify([
    objectiveControlKey,
    observation.parentOutcome,
    observation.parentAttemptId,
    observation.parentRunId ?? null,
    observation.parentTrajectoryId ?? null,
    observation.parentSource,
    observation.parentBackend,
    observation.parentTier,
    observation.ts,
    ...treatment,
    observation.diffFiles ?? null,
    observation.diffLines ?? null,
  ]);
}

function handoffAuthoritySnapshot(): HandoffAuthoritySnapshot {
  const read = readRepairHandoffs();
  const observations = read.sourceState === 'degraded' ? [] : read.observations;
  const byEventId = new Map(observations.map((entry) => [entry.eventId, entry]));
  const objectiveControlFamilies = new Map<string, RepairHandoffObservation[]>();
  const exactParentRowFamilies = new Map<string, RepairHandoffObservation[]>();
  const observationsByGenerationId = new Map<string, RepairHandoffObservation[]>();
  const widenedCaptureChildren = new Set<string>();
  for (const observation of observations) {
    const generationRows = observationsByGenerationId.get(observation.generationId) ?? [];
    generationRows.push(observation);
    observationsByGenerationId.set(observation.generationId, generationRows);
    if (
      observation.kind === 'capture-repair' &&
      (observation.parentSource === 'issue' || observation.parentSource === 'goal')
    ) {
      widenedCaptureChildren.add(JSON.stringify([observation.repo, observation.childItemId]));
    }
    const objectiveControlFamily = repairHandoffObjectiveControlFamilyKey(observation);
    if (objectiveControlFamily) {
      const rows = objectiveControlFamilies.get(objectiveControlFamily) ?? [];
      rows.push(observation);
      objectiveControlFamilies.set(objectiveControlFamily, rows);
    }
    const exactParentRowFamily = exactParentRowAliasKey(observation);
    if (exactParentRowFamily) {
      const rows = exactParentRowFamilies.get(exactParentRowFamily) ?? [];
      rows.push(observation);
      exactParentRowFamilies.set(exactParentRowFamily, rows);
    }
  }
  const objectiveControlGenerationsByEventId = new Map<string, string[]>();
  const degradedObjectiveControlEventIds = new Set<string>();
  for (const rows of objectiveControlFamilies.values()) {
    const generations = [...new Set(rows.map((row) => row.generationId))];
    if (generations.length > MAX_HANDOFF_ALIAS_GENERATIONS) {
      for (const row of rows) degradedObjectiveControlEventIds.add(row.eventId);
      continue;
    }
    for (const row of rows) objectiveControlGenerationsByEventId.set(row.eventId, generations);
  }
  const exactParentRowGenerationsByEventId = new Map<string, string[]>();
  for (const rows of exactParentRowFamilies.values()) {
    const generations = [...new Set(rows.map((row) => row.generationId))];
    if (generations.length > MAX_HANDOFF_ALIAS_GENERATIONS) continue;
    for (const row of rows) exactParentRowGenerationsByEventId.set(row.eventId, generations);
  }
  return {
    byEventId,
    observations,
    objectiveControlGenerationsByEventId,
    exactParentRowGenerationsByEventId,
    degradedObjectiveControlEventIds,
    observationsByGenerationId,
    widenedCaptureChildren,
    sourceState: read.sourceState,
  };
}

function compatibleActiveEvidenceAliasObservation(
  authority: HandoffAuthoritySnapshot,
  anchor: RepairHandoffObservation,
  generationId: string,
): RepairHandoffObservation | null {
  if (authority.sourceState === 'degraded') return null;
  const familyKey = compatibleActiveEvidenceAliasKey(anchor);
  const familyGenerations = authority.objectiveControlGenerationsByEventId.get(anchor.eventId);
  if (
    !familyKey ||
    authority.degradedObjectiveControlEventIds.has(anchor.eventId) ||
    !familyGenerations ||
    familyGenerations.length > MAX_HANDOFF_ALIAS_GENERATIONS ||
    !familyGenerations.includes(generationId)
  ) return null;
  const matches = (authority.observationsByGenerationId.get(generationId) ?? []).filter(
    (observation) => compatibleActiveEvidenceAliasKey(observation) === familyKey,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function exactParentRowAliasObservation(
  authority: HandoffAuthoritySnapshot,
  anchor: RepairHandoffObservation,
  generationId: string,
): RepairHandoffObservation | null {
  if (authority.sourceState === 'degraded') return null;
  const familyKey = exactParentRowAliasKey(anchor);
  const familyGenerations = authority.exactParentRowGenerationsByEventId.get(anchor.eventId);
  if (!familyKey || !familyGenerations?.includes(generationId)) return null;
  const matches = (authority.observationsByGenerationId.get(generationId) ?? []).filter(
    (observation) => exactParentRowAliasKey(observation) === familyKey,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function exactParentRowAliasGenerations(
  authority: HandoffAuthoritySnapshot,
  leftGenerationId: string,
  rightGenerationId: string,
): boolean {
  if (authority.sourceState === 'degraded') return false;
  const leftRows = authority.observationsByGenerationId.get(leftGenerationId) ?? [];
  if (leftRows.length !== 1) return false;
  const right = exactParentRowAliasObservation(authority, leftRows[0]!, rightGenerationId);
  return right !== null;
}

function generatedRepairGenerationIdFromAuthority(
  item: WorkItem,
  authority: HandoffAuthoritySnapshot,
): string | null {
  if (!isTrustedGeneratedRepairItem(item)) return null;
  if (item.repairHandoffId !== undefined || item.repairGenerationId !== undefined) {
    if (
      typeof item.repairHandoffId !== 'string' ||
      typeof item.repairGenerationId !== 'string' ||
      repairGenerationIdFromHandoffId(item.repairHandoffId) !== item.repairGenerationId
    ) return null;
    const handoff = authority.byEventId.get(item.repairHandoffId);
    if (!handoff || handoff.generationId !== item.repairGenerationId || handoff.childItemId !== item.id) return null;
    try { if (resolve(handoff.repo) !== resolve(item.repo)) return null; } catch { return null; }
    if (isTrustedDiagnosticResliceItem(item)) {
      const expectedUnitId = handoff.parentObjectiveHash === undefined ? null : repairTreatmentUnitId({
        kind: 'no-diff-reslice',
        repo: handoff.repo,
        parentItemId: handoff.parentItemId,
        parentObjectiveHash: handoff.parentObjectiveHash,
      });
      const expectedTreatment = expectedUnitId ? repairTreatmentForUnitId(expectedUnitId) : null;
      const treatmentMetadataPresent = item.repairTreatmentUnitId !== undefined || item.repairTreatment !== undefined;
      if (
        handoff.kind !== 'no-diff-reslice' ||
        handoff.parentSource === undefined ||
        handoff.parentBackend === undefined ||
        handoff.parentTier === undefined ||
        item.repairParentItemId !== handoff.parentItemId ||
        item.repairParentSource !== handoff.parentSource ||
        item.repairParentBackend !== handoff.parentBackend ||
        item.repairParentTier !== handoff.parentTier ||
        handoff.parentObjectiveHash === undefined ||
        item.repairParentObjectiveHash !== handoff.parentObjectiveHash ||
        expectedUnitId === null ||
        expectedTreatment === null ||
        (treatmentMetadataPresent && (
          item.repairTreatmentUnitId !== expectedUnitId ||
          item.repairTreatment !== expectedTreatment
        )) ||
        (handoff.repairTreatmentUnitId !== undefined && handoff.repairTreatmentUnitId !== expectedUnitId) ||
        (handoff.repairTreatment !== undefined && handoff.repairTreatment !== expectedTreatment)
      ) return null;
    }
    const widenedCapture = isTrustedCaptureRepairItem(item) && (
      handoff.parentSource === 'issue' ||
      handoff.parentSource === 'goal' ||
      item.repairParentSource === 'issue' ||
      item.repairParentSource === 'goal'
    );
    if (
      widenedCapture &&
      (
        handoff.kind !== 'capture-repair' ||
        handoff.parentSource !== item.repairParentSource ||
        handoff.parentBackend !== item.repairParentBackend ||
        handoff.parentTier !== item.repairParentTier ||
        handoff.parentObjectiveHash !== item.repairParentObjectiveHash
      )
    ) return null;
    return item.repairGenerationId;
  }
  // Diagnostic reslices derive authority from a durable parent handoff. Older
  // hashless/fallback generations remain readable but can never dispatch.
  if (isTrustedDiagnosticResliceItem(item)) return null;
  if (
    isTrustedCaptureRepairItem(item) &&
    (item.repairParentSource === 'issue' || item.repairParentSource === 'goal')
  ) return null;
  let repo: string;
  try {
    repo = resolve(item.repo);
  } catch {
    return null;
  }
  if (isTrustedCaptureRepairItem(item)) {
    if (authority.sourceState === 'degraded') return null;
    const authoritativeWidenedChild = authority.widenedCaptureChildren.has(
      JSON.stringify([repo, item.id]),
    );
    if (authoritativeWidenedChild) return null;
  }
  const ts = Date.parse(item.ts);
  if (!Number.isFinite(ts)) return null;
  return createHash('sha256').update(JSON.stringify([
    'ashlr:generated-repair-generation:v1',
    repo,
    item.id,
    item.source,
    new Date(ts).toISOString(),
  ])).digest('hex');
}

export function generatedRepairGenerationId(item: WorkItem): string | null {
  return generatedRepairGenerationIdFromAuthority(item, handoffAuthoritySnapshot());
}

export function generatedRepairCooldownKey(item: WorkItem): string {
  if (item.repairHandoffId === undefined && item.repairGenerationId === undefined) return item.id;
  const generationId = generatedRepairGenerationId(item);
  return generationId ? `${item.id}::generation:${generationId}` : item.id;
}

/** Current generation plus objective-control generations in either rollout direction. */
export function generatedRepairGenerationIds(item: WorkItem): string[] {
  return generatedRepairGenerationIdsFromAuthority(item, handoffAuthoritySnapshot());
}

function generatedRepairGenerationIdsFromAuthority(
  item: WorkItem,
  snapshot: HandoffAuthoritySnapshot,
): string[] {
  const current = generatedRepairGenerationIdFromAuthority(item, snapshot);
  if (!current || typeof item.repairHandoffId !== 'string') return current ? [current] : [];
  const target = snapshot.byEventId.get(item.repairHandoffId);
  if (!target || !target.parentObjectiveHash) return [current];
  if (snapshot.degradedObjectiveControlEventIds.has(target.eventId)) return [];
  return [...new Set([
    current,
    ...(snapshot.objectiveControlGenerationsByEventId.get(target.eventId) ?? []),
  ])];
}

export function generatedRepairCooldownKeys(item: WorkItem): string[] {
  const generations = generatedRepairGenerationIds(item);
  if (generations.length === 0) return [item.id];
  const generationKeys = generations.map((generationId) => `${item.id}::generation:${generationId}`);
  return item.repairHandoffId === undefined && item.repairGenerationId === undefined
    ? [item.id, ...generationKeys]
    : generationKeys;
}

function isLifecycleAttemptIdentity(value: unknown): value is string {
  if (isSafeExecutionIdentity(value)) return true;
  return typeof value === 'string' && value.startsWith('run:') && isOuterAttemptIdentity(value.slice(4));
}

const ATTEMPT_PROOF_TARGET_KEYS = new Set([
  'ts', 'sequenceStartTs', 'sequenceEndTs', 'itemId', 'repo', 'source', 'outcome', 'proposalId', 'objectiveHash', 'repairHandoffId',
  'repairGenerationId', 'repairTreatmentUnitId', 'repairTreatment', 'repairAttemptOrdinal',
]);
const ATTEMPT_PROOF_KEYS = new Set([
  'schemaVersion', 'integrityClass', 'cryptographicallyTrusted', 'rollbackProtected',
  'eventTs', 'eventDigest', 'attemptHash', 'backend', 'tier', 'model', 'previousBackend',
  'repairHandoffId', 'repairGenerationId', 'repairTreatmentUnitId', 'repairTreatment',
  'repairAttemptOrdinal',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function canonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validStoredAttemptProofTarget(value: unknown): value is DispatchProductionAttemptProofTarget {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ATTEMPT_PROOF_TARGET_KEYS)) return false;
  let canonicalRepo: string;
  try { canonicalRepo = resolve(String(value['repo'] ?? '')); } catch { return false; }
  const sequenceStartTs = value['sequenceStartTs'];
  const sequenceEndTs = value['sequenceEndTs'];
  const outcome = value['outcome'];
  const proposalId = value['proposalId'];
  return canonicalUtcTimestamp(value['ts']) &&
    (sequenceStartTs === undefined || (
      canonicalUtcTimestamp(sequenceStartTs) && Date.parse(sequenceStartTs) <= Date.parse(value['ts'] as string)
    )) &&
    (sequenceEndTs === undefined || (
      canonicalUtcTimestamp(sequenceEndTs) && Date.parse(value['ts'] as string) <= Date.parse(sequenceEndTs)
    )) &&
    typeof value['itemId'] === 'string' &&
    /:proposal-repair-nodiff:[0-9a-f]{12}$/.test(value['itemId']) &&
    value['repo'] === canonicalRepo &&
    value['source'] === 'self' &&
    (outcome === 'empty-diff' || outcome === 'proposal-created') &&
    (outcome === 'proposal-created'
      ? isSafeExecutionIdentity(proposalId)
      : proposalId === undefined) &&
    SHA256_RE.test(String(value['objectiveHash'] ?? '')) &&
    SHA256_RE.test(String(value['repairHandoffId'] ?? '')) &&
    SHA256_RE.test(String(value['repairGenerationId'] ?? '')) &&
    repairGenerationIdFromHandoffId(value['repairHandoffId'] as string) === value['repairGenerationId'] &&
    SHA256_RE.test(String(value['repairTreatmentUnitId'] ?? '')) &&
    repairTreatmentForUnitId(value['repairTreatmentUnitId'] as string) === value['repairTreatment'] &&
    (value['repairAttemptOrdinal'] === 1 || value['repairAttemptOrdinal'] === 2);
}

function validStoredAttemptProof(value: unknown): value is DispatchProductionAttemptProof {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ATTEMPT_PROOF_KEYS)) return false;
  const backend = value['backend'];
  const previousBackend = value['previousBackend'];
  const ordinal = value['repairAttemptOrdinal'];
  return value['schemaVersion'] === 1 &&
    value['integrityClass'] === 'owner-writable-local' &&
    value['cryptographicallyTrusted'] === false &&
    value['rollbackProtected'] === false &&
    canonicalUtcTimestamp(value['eventTs']) &&
    SHA256_RE.test(String(value['eventDigest'] ?? '')) &&
    SHA256_RE.test(String(value['attemptHash'] ?? '')) &&
    ENGINE_IDS.has(backend as EngineId) && backend !== 'builtin' &&
    (value['tier'] === 'local' || value['tier'] === 'mid' || value['tier'] === 'frontier') &&
    (value['model'] === null || typeof value['model'] === 'string') &&
    (previousBackend === null || (ENGINE_IDS.has(previousBackend as EngineId) && previousBackend !== 'builtin')) &&
    SHA256_RE.test(String(value['repairHandoffId'] ?? '')) &&
    SHA256_RE.test(String(value['repairGenerationId'] ?? '')) &&
    repairGenerationIdFromHandoffId(value['repairHandoffId'] as string) === value['repairGenerationId'] &&
    SHA256_RE.test(String(value['repairTreatmentUnitId'] ?? '')) &&
    repairTreatmentForUnitId(value['repairTreatmentUnitId'] as string) === value['repairTreatment'] &&
    (ordinal === 1 || ordinal === 2) &&
    (ordinal === 1 ? previousBackend === null : previousBackend !== null && previousBackend !== backend);
}

function sameAttemptProof(
  left: DispatchProductionAttemptProof,
  right: DispatchProductionAttemptProof,
): boolean {
  return left.schemaVersion === right.schemaVersion && left.integrityClass === right.integrityClass &&
    left.cryptographicallyTrusted === right.cryptographicallyTrusted &&
    left.rollbackProtected === right.rollbackProtected && left.eventTs === right.eventTs &&
    left.eventDigest === right.eventDigest && left.attemptHash === right.attemptHash &&
    left.backend === right.backend && left.tier === right.tier && left.model === right.model &&
    left.previousBackend === right.previousBackend && left.repairHandoffId === right.repairHandoffId &&
    left.repairGenerationId === right.repairGenerationId &&
    left.repairTreatmentUnitId === right.repairTreatmentUnitId &&
    left.repairTreatment === right.repairTreatment &&
    left.repairAttemptOrdinal === right.repairAttemptOrdinal;
}

function sameDispatchProofReceipt(
  left: GeneratedRepairDispatchProofReceipt,
  right: GeneratedRepairDispatchProofReceipt,
): boolean {
  return sameAttemptProof(left.proof, right.proof) &&
    left.targetDigest === right.targetDigest &&
    JSON.stringify(left.publication) === JSON.stringify(right.publication) &&
    left.publicationDigest === right.publicationDigest &&
    left.sourceReceiptFileDigest === right.sourceReceiptFileDigest &&
    left.sourceRetirementEpoch === right.sourceRetirementEpoch;
}

function attemptProofTargetDigest(target: DispatchProductionAttemptProofTarget): string {
  const { sequenceStartTs: _sequenceStartTs, sequenceEndTs: _sequenceEndTs, ...authority } = target;
  return createHash('sha256').update(JSON.stringify(authority), 'utf8').digest('hex');
}

function proofMatchesTarget(
  proof: DispatchProductionAttemptProof,
  target: DispatchProductionAttemptProofTarget,
): boolean {
  return proof.eventTs === target.ts &&
    proof.repairHandoffId === target.repairHandoffId &&
    proof.repairGenerationId === target.repairGenerationId &&
    proof.repairTreatmentUnitId === target.repairTreatmentUnitId &&
    proof.repairTreatment === target.repairTreatment &&
    proof.repairAttemptOrdinal === target.repairAttemptOrdinal;
}

function durableReceiptMatchesTarget(
  receipt: GeneratedRepairDispatchProofReceipt,
  target: DispatchProductionAttemptProofTarget,
): boolean {
  return receipt.targetDigest !== undefined &&
    receipt.targetDigest === attemptProofTargetDigest(target) &&
    proofMatchesTarget(receipt.proof, target);
}

function canonicalEventMatchesProofReceipt(
  event: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  proof: DispatchProductionAttemptProof,
): boolean {
  if (createHash('sha256').update(JSON.stringify(event), 'utf8').digest('hex') !== proof.eventDigest) {
    return false;
  }
  return rebuiltProofCandidate(event, target, proof) !== null;
}

const PUBLICATION_CAPSULE_KEYS = new Set([
  'schemaVersion',
  'itemId',
  'repo',
  'source',
  'outcome',
  'proposalId',
  'trajectoryId',
  'objectiveHash',
  'repairRootId',
  'repairDepth',
]);

function publicationCapsuleDigest(
  proof: DispatchProductionAttemptProof,
  targetDigest: string,
  publication: GeneratedRepairPublicationCapsule,
): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:generated-repair-publication-capsule:v1',
    proof.eventDigest,
    targetDigest,
    proof,
    publication,
  ]), 'utf8').digest('hex');
}

function publicationTarget(
  publication: GeneratedRepairPublicationCapsule,
  proof: DispatchProductionAttemptProof,
): DispatchProductionAttemptProofTarget {
  return {
    ts: proof.eventTs,
    itemId: publication.itemId,
    repo: publication.repo,
    source: publication.source,
    outcome: publication.outcome,
    ...(publication.proposalId ? { proposalId: publication.proposalId } : {}),
    objectiveHash: publication.objectiveHash,
    repairHandoffId: proof.repairHandoffId,
    repairGenerationId: proof.repairGenerationId,
    repairTreatmentUnitId: proof.repairTreatmentUnitId,
    repairTreatment: proof.repairTreatment,
    repairAttemptOrdinal: proof.repairAttemptOrdinal,
  };
}

function safePublicationText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    !value.includes('\0') && scrubSecrets(value) === value;
}

function validPublicationCapsule(
  publication: unknown,
  proof: DispatchProductionAttemptProof,
  targetDigest: string,
): publication is GeneratedRepairPublicationCapsule {
  if (
    !isPlainRecord(publication) ||
    !hasOnlyKeys(publication, PUBLICATION_CAPSULE_KEYS) ||
    Buffer.byteLength(JSON.stringify(publication), 'utf8') > MAX_PUBLICATION_CAPSULE_BYTES ||
    publication['schemaVersion'] !== 1 ||
    !safePublicationText(publication['itemId'], 240) ||
    !safePublicationText(publication['repo'], 500) ||
    publication['source'] !== 'self' ||
    (publication['outcome'] !== 'empty-diff' && publication['outcome'] !== 'proposal-created') ||
    !isLifecycleAttemptIdentity(publication['trajectoryId']) ||
    scrubSecrets(publication['trajectoryId']) !== publication['trajectoryId'] ||
    !SHA256_RE.test(String(publication['objectiveHash'] ?? '')) ||
    generatedRepairLifecycleAttemptHash(publication['trajectoryId']) !== proof.attemptHash
  ) return false;
  const rootBindingPresent = publication['repairRootId'] !== undefined ||
    publication['repairDepth'] !== undefined;
  if (rootBindingPresent && (
    proof.repairAttemptOrdinal !== 2 ||
    !SHA256_RE.test(String(publication['repairRootId'] ?? '')) ||
    (publication['repairDepth'] !== 0 && publication['repairDepth'] !== 1)
  )) return false;
  if (
    publication['outcome'] === 'proposal-created'
      ? !isSafeExecutionIdentity(publication['proposalId']) ||
        scrubSecrets(publication['proposalId']) !== publication['proposalId']
      : publication['proposalId'] !== undefined
  ) return false;
  let canonicalRepo: string;
  try { canonicalRepo = resolve(publication['repo']); } catch { return false; }
  if (canonicalRepo !== publication['repo']) return false;
  const target = publicationTarget(publication as unknown as GeneratedRepairPublicationCapsule, proof);
  return validStoredAttemptProofTarget(target) && attemptProofTargetDigest(target) === targetDigest;
}

function proofReceiptFromEvent(
  event: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  proof: DispatchProductionAttemptProof,
  failurePredecessor?: DispatchProductionEvent,
): GeneratedRepairDispatchProofReceipt | null {
  const trajectoryId = event.trajectoryId;
  if (!trajectoryId) return null;
  const publication: GeneratedRepairPublicationCapsule = {
    schemaVersion: 1,
    itemId: target.itemId,
    repo: target.repo,
    source: 'self',
    outcome: target.outcome,
    ...(target.proposalId ? { proposalId: target.proposalId } : {}),
    trajectoryId,
    objectiveHash: target.objectiveHash,
    ...(failurePredecessor ? {
      repairRootId: failurePredecessor.repairRootId,
      repairDepth: failurePredecessor.repairDepth,
    } : {}),
  };
  const targetDigest = attemptProofTargetDigest(target);
  if (!validPublicationCapsule(publication, proof, targetDigest)) return null;
  const base: GeneratedRepairDispatchProofReceipt = {
    proof: structuredClone(proof),
    targetDigest,
    publication,
    publicationDigest: publicationCapsuleDigest(proof, targetDigest, publication),
  };
  const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  const exact = readPrivateFile(
    join(attemptDir, `${proof.repairGenerationId}-${proof.repairAttemptOrdinal}.json`),
    MAX_ATTEMPT_ROW_BYTES,
  );
  const protocol = readAttemptProtocolSnapshot(attemptDir);
  if (!exact.ok || !exact.exists || !protocol ||
    !exactAttemptReceiptMatchesCapsule(exact.bytes, target, base, protocol)) return null;
  return {
    ...base,
    sourceReceiptFileDigest: digestBytes(exact.bytes),
    sourceRetirementEpoch: protocol.retirementEpoch,
  };
}

function publicationEventFromReceipt(
  receipt: GeneratedRepairDispatchProofReceipt,
): {
  event: DispatchProductionEvent;
  target: DispatchProductionAttemptProofTarget;
  publication: GeneratedRepairPublicationCapsule;
} | null {
  const { proof, targetDigest, publication, publicationDigest } = receipt;
  if (
    !targetDigest || !publication || !publicationDigest ||
    !validPublicationCapsule(publication, proof, targetDigest) ||
    publicationDigest !== publicationCapsuleDigest(proof, targetDigest, publication)
  ) return null;
  const target = publicationTarget(publication, proof);
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: proof.eventTs,
    itemId: publication.itemId,
    repo: publication.repo,
    source: publication.source,
    title: 'Generated repair treatment witness',
    backend: proof.backend,
    tier: proof.tier,
    model: proof.model,
    assignedBy: 'generated-repair-lifecycle',
    routeReason: 'durable terminal treatment publication',
    outcome: publication.outcome,
    proposalCreated: publication.outcome === 'proposal-created',
    ...(publication.proposalId ? { proposalId: publication.proposalId } : {}),
    trajectoryId: publication.trajectoryId,
    objectiveHash: publication.objectiveHash,
    spentUsd: 0,
    basis: 'run-proposal-outcome',
    repairHandoffId: proof.repairHandoffId,
    repairGenerationId: proof.repairGenerationId,
    repairTreatmentUnitId: proof.repairTreatmentUnitId,
    repairTreatment: proof.repairTreatment,
    repairAttemptOrdinal: proof.repairAttemptOrdinal,
    ...(proof.previousBackend ? { repairPreviousBackend: proof.previousBackend } : {}),
  };
  return { event, target, publication };
}

function rebuiltProofCandidate(
  event: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  proof: DispatchProductionAttemptProof,
): DispatchProductionEvent | null {
  const candidate = structuredClone(event);
  candidate.basis = 'repair-lifecycle-candidate';
  candidate.model = proof.model;
  candidate.repairTreatmentAttemptHash = proof.attemptHash;
  if (candidate.routeSnapshot) candidate.routeSnapshot.model = proof.model;
  return treatmentCandidateMatchesProof(candidate, target, proof, false) ? candidate : null;
}

function validDispatchProofReceipt(value: unknown): value is GeneratedRepairDispatchProofReceipt {
  if (!isPlainRecord(value) ||
    !hasOnlyKeys(value, new Set([
      'proof', 'targetDigest', 'publication', 'publicationDigest',
      'sourceReceiptFileDigest', 'sourceRetirementEpoch',
    ])) ||
    !validStoredAttemptProof(value['proof'])) return false;
  const targetDigest = value['targetDigest'];
  if (targetDigest !== undefined && (typeof targetDigest !== 'string' || !SHA256_RE.test(targetDigest))) return false;
  const publication = value['publication'];
  const publicationDigest = value['publicationDigest'];
  if ((publication === undefined) !== (publicationDigest === undefined)) return false;
  const sourceReceiptFileDigest = value['sourceReceiptFileDigest'];
  const sourceRetirementEpoch = value['sourceRetirementEpoch'];
  if ((sourceReceiptFileDigest === undefined) !== (sourceRetirementEpoch === undefined) ||
    (sourceReceiptFileDigest !== undefined && (
      typeof sourceReceiptFileDigest !== 'string' || !SHA256_RE.test(sourceReceiptFileDigest) ||
      !Number.isSafeInteger(sourceRetirementEpoch) || Number(sourceRetirementEpoch) < 0
    ))) return false;
  if (publication !== undefined && (
    targetDigest === undefined ||
    typeof publicationDigest !== 'string' ||
    !SHA256_RE.test(publicationDigest) ||
    !validPublicationCapsule(publication, value['proof'], targetDigest) ||
    publicationDigest !== publicationCapsuleDigest(value['proof'], targetDigest, publication)
  )) return false;
  return true;
}

function validStoredAttemptReceiptOrdinals(
  receipts: readonly GeneratedRepairDispatchProofReceipt[],
): boolean {
  return receipts.every((receipt, index) => receipt.proof.repairAttemptOrdinal === index + 1) ||
    (receipts.length === 1 && receipts[0]!.proof.repairAttemptOrdinal === 2);
}

function treatmentCandidateMatchesProof(
  candidate: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  proof: DispatchProductionAttemptProof,
  allowMissingDerivedFields: boolean,
): boolean {
  const attemptId = candidate.trajectoryId ?? candidate.runId;
  const proposalCreated = target.outcome === 'proposal-created';
  const optionalExact = <T>(value: T | undefined, expected: T): boolean =>
    allowMissingDerivedFields && value === undefined ? true : value === expected;
  if (
    candidate.basis !== 'repair-lifecycle-candidate' ||
    candidate.ts !== proof.eventTs ||
    candidate.itemId !== target.itemId ||
    candidate.repo !== target.repo ||
    candidate.source !== target.source ||
    candidate.outcome !== target.outcome ||
    candidate.proposalCreated !== proposalCreated ||
    (proposalCreated
      ? candidate.proposalId !== target.proposalId
      : candidate.proposalId !== undefined) ||
    candidate.backend !== proof.backend ||
    candidate.tier !== proof.tier ||
    !optionalExact(candidate.model, proof.model) ||
    !optionalExact(candidate.objectiveHash, target.objectiveHash) ||
    !optionalExact(candidate.repairHandoffId, proof.repairHandoffId) ||
    !optionalExact(candidate.repairGenerationId, proof.repairGenerationId) ||
    !optionalExact(candidate.repairTreatmentUnitId, proof.repairTreatmentUnitId) ||
    !optionalExact(candidate.repairTreatment, proof.repairTreatment) ||
    !optionalExact(candidate.repairAttemptOrdinal, proof.repairAttemptOrdinal) ||
    !optionalExact(candidate.repairTreatmentAttemptHash, proof.attemptHash) ||
    candidate.repairTreatmentOutcome !== undefined ||
    candidate.repairLineageInvalid !== undefined ||
    !attemptId || generatedRepairLifecycleAttemptHash(attemptId) !== proof.attemptHash
  ) return false;
  if (proof.repairAttemptOrdinal === 1) {
    if (candidate.repairPreviousBackend !== undefined) return false;
  } else if (!optionalExact(candidate.repairPreviousBackend, proof.previousBackend!)) {
    return false;
  }
  if (candidate.routeSnapshot && (
    candidate.routeSnapshot.backend !== proof.backend ||
    candidate.routeSnapshot.tier !== proof.tier ||
    !optionalExact(candidate.routeSnapshot.model, proof.model)
  )) return false;
  if (candidate.runEventSummary && (
    candidate.runEventSummary.outcome !== target.outcome ||
    candidate.runEventSummary.proposalCreated !== proposalCreated ||
    (proposalCreated
      ? candidate.runEventSummary.proposalId !== target.proposalId
      : candidate.runEventSummary.proposalId !== undefined) ||
    (candidate.runId !== undefined && candidate.runEventSummary.runId !== candidate.runId)
  )) return false;
  return true;
}

function proposalAuthorityBindingDigest(
  proposalIdHash: string,
  trajectoryIdHash: string,
  eventTs: string,
  eventDigest: string,
  contentDigest: string,
  attemptReceipt?: GeneratedRepairProposalAuthority['attemptReceipt'],
): string {
  return createHash('sha256').update(JSON.stringify([
    attemptReceipt
      ? 'ashlr:generated-repair-proposal-authority:v2'
      : 'ashlr:generated-repair-proposal-authority:v1',
    proposalIdHash,
    trajectoryIdHash,
    eventTs,
    eventDigest,
    contentDigest,
    ...(attemptReceipt ? [attemptReceipt] : []),
  ]), 'utf8').digest('hex');
}

function validProposalAuthority(value: unknown): value is GeneratedRepairProposalAuthority {
  if (!isPlainRecord(value) || (value['schemaVersion'] !== 1 && value['schemaVersion'] !== 2) ||
    !hasOnlyKeys(value, new Set([
    'schemaVersion', 'proposalIdHash', 'trajectoryIdHash', 'eventTs', 'eventDigest',
    'contentDigest', 'attemptReceipt', 'bindingDigest',
  ]))) return false;
  const proposalIdHash = value['proposalIdHash'];
  const trajectoryIdHash = value['trajectoryIdHash'];
  const eventTs = value['eventTs'];
  const eventDigest = value['eventDigest'];
  const contentDigest = value['contentDigest'];
  const attemptReceipt = value['attemptReceipt'];
  const bindingDigest = value['bindingDigest'];
  if (value['schemaVersion'] === 1 && attemptReceipt !== undefined) return false;
  if (value['schemaVersion'] === 2 && (
    !isPlainRecord(attemptReceipt) ||
    !hasOnlyKeys(attemptReceipt, new Set([
      'generationId', 'ordinal', 'fileDigest', 'retirementEpoch',
    ])) ||
    !SHA256_RE.test(String(attemptReceipt['generationId'] ?? '')) ||
    (attemptReceipt['ordinal'] !== 1 && attemptReceipt['ordinal'] !== 2) ||
    !SHA256_RE.test(String(attemptReceipt['fileDigest'] ?? '')) ||
    !Number.isSafeInteger(attemptReceipt['retirementEpoch']) ||
    Number(attemptReceipt['retirementEpoch']) < 0
  )) return false;
  return typeof proposalIdHash === 'string' && SHA256_RE.test(proposalIdHash) &&
    typeof trajectoryIdHash === 'string' && SHA256_RE.test(trajectoryIdHash) &&
    canonicalUtcTimestamp(eventTs) &&
    typeof eventDigest === 'string' && SHA256_RE.test(eventDigest) &&
    typeof contentDigest === 'string' && SHA256_RE.test(contentDigest) &&
    typeof bindingDigest === 'string' &&
    bindingDigest === proposalAuthorityBindingDigest(
      proposalIdHash,
      trajectoryIdHash,
      eventTs,
      eventDigest,
      contentDigest,
      value['schemaVersion'] === 2
        ? attemptReceipt as GeneratedRepairProposalAuthority['attemptReceipt']
        : undefined,
    );
}

function validRecord(value: unknown): value is GeneratedRepairLifecycleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const disposition = record['disposition'];
  const hashes = record['emptyAttemptHashes'];
  const backends = record['emptyAttemptBackends'];
  const tiers = record['emptyAttemptTiers'];
  const proofReceipts = record['emptyAttemptProofReceipts'];
  const terminalAttemptHash = record['terminalAttemptHash'];
  const terminalProofReceipt = record['terminalAttemptProofReceipt'];
  const proposalAuthority = record['proposalAuthority'];
  const treatmentWitnessRecordedAt = record['treatmentWitnessRecordedAt'];
  const treatmentWitnessDigest = record['treatmentWitnessDigest'];
  if (
    !SHA256_RE.test(String(record['generationId'] ?? '')) ||
    (disposition !== 'active' && disposition !== 'retired' && disposition !== 'exhausted' && disposition !== 'quarantined') ||
    !Array.isArray(hashes) ||
    hashes.length > 2 ||
    hashes.some((hash) => typeof hash !== 'string' || !SHA256_RE.test(hash)) ||
    new Set(hashes).size !== hashes.length ||
    typeof record['updatedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(record['updatedAt']))
  ) return false;
  if (
    backends !== undefined && (
      !Array.isArray(backends) ||
      backends.length !== hashes.length ||
      backends.some((backend) => !ENGINE_IDS.has(backend as EngineId))
    )
  ) return false;
  if (
    tiers !== undefined && (
      backends === undefined ||
      !Array.isArray(tiers) ||
      tiers.length !== hashes.length ||
      tiers.some((tier) => tier !== 'local' && tier !== 'mid' && tier !== 'frontier')
    )
  ) return false;
  if (proofReceipts !== undefined && (
    !Array.isArray(proofReceipts) ||
    proofReceipts.length !== hashes.length ||
    proofReceipts.some((receipt) => !validDispatchProofReceipt(receipt)) ||
    !validStoredAttemptReceiptOrdinals(proofReceipts) ||
    proofReceipts.some((receipt, index) =>
      receipt.proof.attemptHash !== hashes[index] ||
      (backends !== undefined && receipt.proof.backend !== backends[index]) ||
      (tiers !== undefined && receipt.proof.tier !== tiers[index]))
  )) return false;
  if (disposition === 'active' && hashes.length > 1) return false;
  if (disposition === 'exhausted' && hashes.length !== 2) return false;
  if (disposition === 'quarantined' && (
    hashes.length !== 2 ||
    tiers === undefined ||
    backends === undefined ||
    (backends as unknown[]).includes('builtin') ||
    new Set(tiers as unknown[]).size !== 1
  )) return false;
  if (terminalAttemptHash !== undefined && (
    disposition === 'active' || !SHA256_RE.test(String(terminalAttemptHash))
  )) return false;
  if (terminalProofReceipt !== undefined && (
    disposition === 'active' ||
    !validDispatchProofReceipt(terminalProofReceipt) ||
    terminalProofReceipt.proof.attemptHash !== terminalAttemptHash
  )) return false;
  if (proposalAuthority !== undefined && (
    disposition !== 'retired' || !validProposalAuthority(proposalAuthority)
  )) return false;
  if (
    proofReceipts !== undefined &&
    (disposition === 'exhausted' || disposition === 'quarantined') &&
    terminalAttemptHash !== proofReceipts.at(-1)?.proof.attemptHash
  ) return false;
  if ((treatmentWitnessRecordedAt === undefined) !== (treatmentWitnessDigest === undefined)) return false;
  if (treatmentWitnessRecordedAt !== undefined && (
    disposition === 'active' ||
    !canonicalUtcTimestamp(treatmentWitnessRecordedAt) ||
    !SHA256_RE.test(String(treatmentWitnessDigest))
  )) return false;
  return true;
}

function parsedLifecycleRecord(
  value: unknown,
  schemaVersion: 1 | 2,
): GeneratedRepairLifecycleRecord | null {
  if (validRecord(value)) return structuredClone(value);
  if (!isPlainRecord(value) || schemaVersion !== 1) return null;
  const recordedAt = value['treatmentWitnessRecordedAt'];
  if (!canonicalUtcTimestamp(recordedAt) || value['treatmentWitnessDigest'] !== undefined) return null;
  const migrated = structuredClone(value);
  delete migrated['treatmentWitnessRecordedAt'];
  return validRecord(migrated) ? migrated : null;
}

function parseLedgerBytes(bytes: Buffer): GeneratedRepairLifecycleLedger | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isPlainRecord(parsed)) return null;
    const value = parsed;
    const schemaVersion = value['schemaVersion'];
    if (
      (schemaVersion !== 1 && schemaVersion !== 2) ||
      !hasOnlyKeys(value, schemaVersion === 1
        ? new Set(['schemaVersion', 'records'])
        : new Set(['schemaVersion', 'retention', 'records'])) ||
      !Array.isArray(value['records'])
    ) return null;
    const retention = value['retention'];
    if (schemaVersion === 1 && retention !== undefined) return null;
    if (schemaVersion === 2 && retention !== undefined && (
      !isPlainRecord(retention) ||
      !hasOnlyKeys(retention, new Set(['droppedThrough'])) ||
      !canonicalUtcTimestamp(retention['droppedThrough'])
    )) return null;
    const records = value['records'].map((record) => parsedLifecycleRecord(record, schemaVersion));
    if (records.some((record) => record === null)) return null;
    const validRecords = records as GeneratedRepairLifecycleRecord[];
    if (validRecords.length > MAX_RECORDS) return null;
    const generationIds = new Set<string>();
    for (const record of validRecords) {
      if (generationIds.has(record.generationId)) return null;
      generationIds.add(record.generationId);
    }
    return {
      schemaVersion: 2,
      ...(retention ? { retention: retention as { droppedThrough: string } } : {}),
      records: validRecords,
    };
  } catch {
    return null;
  }
}

type LifecycleLedgerRead =
  | { ok: true; ledger: GeneratedRepairLifecycleLedger; fingerprint: string }
  | { ok: false };

function loadLedger(): LifecycleLedgerRead {
  const path = generatedRepairLifecyclePath();
  const dir = dirname(path);
  if (existsSync(dir) && !assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) {
    lifecycleLedgerCache = undefined;
    return { ok: false };
  }
  if (!existsSync(path)) {
    const fingerprint = `${path}:missing`;
    if (lifecycleLedgerCache?.fingerprint === fingerprint) {
      return { ok: true, ledger: cloneLedger(lifecycleLedgerCache.ledger), fingerprint };
    }
    const ledger: GeneratedRepairLifecycleLedger = { schemaVersion: 2, records: [] };
    if (ledger.records.length <= MAX_CACHED_RECORDS) {
      lifecycleLedgerCache = { fingerprint, ledger };
      return { ok: true, ledger: cloneLedger(ledger), fingerprint };
    }
    // Large ledgers are already isolated by a fresh parse. Keeping another
    // resident graph and cloning it again only amplifies bounded file bytes.
    lifecycleLedgerCache = undefined;
    return { ok: true, ledger, fingerprint };
  }
  let fd: number | undefined;
  try {
    if (!assureLifecycleStoragePath(path, 'file', 'inspect-existing')) return { ok: false };
    const before = lstatSync(path);
    if (!safeStoreFile(before) || before.size > MAX_LEDGER_BYTES) {
      lifecycleLedgerCache = undefined;
      return { ok: false };
    }
    const fingerprint = `${path}:${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
    if (lifecycleLedgerCache?.fingerprint === fingerprint) {
      return { ok: true, ledger: cloneLedger(lifecycleLedgerCache.ledger), fingerprint };
    }
    lifecycleLedgerCache = undefined;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!safeStoreFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_LEDGER_BYTES) {
      return { ok: false };
    }
    const bytes = Buffer.alloc(opened.size);
    if (opened.size > 0 && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { ok: false };
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) return { ok: false };
    const ledger = parseLedgerBytes(bytes);
    if (!ledger) return { ok: false };
    if (ledger.records.length <= MAX_CACHED_RECORDS) {
      lifecycleLedgerCache = { fingerprint, ledger };
      return { ok: true, ledger: cloneLedger(ledger), fingerprint };
    }
    lifecycleLedgerCache = undefined;
    return { ok: true, ledger, fingerprint };
  } catch {
    lifecycleLedgerCache = undefined;
    return { ok: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function lifecycleLockPath(): string {
  return `${generatedRepairLifecyclePath()}.lock`;
}

function lifecycleFailurePath(): string {
  return `${generatedRepairLifecyclePath()}.failed`;
}

function lifecycleRollbackPath(): string {
  return `${generatedRepairLifecyclePath()}.rollback`;
}

interface LifecycleWriteFailureMarker {
  schemaVersion: 1 | 2;
  kind: 'rollback-required' | 'commit-complete';
  priorLedgerExisted: boolean;
  priorLedgerDigest: string;
  candidateDigest: string;
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function safeStoreFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && ownedByCurrentUser(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function assureLifecycleStoragePath(
  path: string,
  kind: 'file' | 'directory',
  mode: 'secure-created' | 'inspect-existing',
): boolean {
  return process.platform !== 'win32' || assurePrivateStoragePath(
    path,
    kind,
    mode,
    { anchorPath: homedir() },
  ).ok;
}

function ensureLifecycleDirectory(): string {
  const dir = dirname(generatedRepairLifecyclePath());
  const created = !existsSync(dir);
  if (created) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) {
    throw new Error('unsafe generated repair lifecycle directory');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o300) !== 0o300) {
    throw new Error('generated repair lifecycle directory is not owner-writable');
  }
  chmodSync(dir, 0o700);
  if (!assureLifecycleStoragePath(
    dir,
    'directory',
    created ? 'secure-created' : 'inspect-existing',
  )) throw new Error('unsafe Windows generated repair lifecycle directory');
  return dir;
}

function fsyncDirectory(dir: string): void {
  if (!assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) {
    throw new Error('unsafe Windows generated repair lifecycle directory');
  }
  lifecycleDirectoryFsyncHookForTest?.(dir);
  let fd: number | undefined;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function atomicPrivateWrite(path: string, bytes: Buffer): void {
  const dir = ensureLifecycleDirectory();
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!safeStoreFile(opened)) throw new Error('unsafe generated repair lifecycle temporary file');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short generated repair lifecycle write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!assureLifecycleStoragePath(tmp, 'file', 'secure-created')) {
      throw new Error('unsafe Windows generated repair lifecycle temporary file');
    }
    renameSync(tmp, path);
    if (!assureLifecycleStoragePath(path, 'file', 'inspect-existing')) {
      throw new Error('unsafe Windows generated repair lifecycle installed file');
    }
    fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPrivateFile(
  path: string,
  maxBytes: number,
  storage: 'external' | 'lifecycle' = 'external',
): { ok: true; exists: false } | { ok: true; exists: true; bytes: Buffer } | { ok: false } {
  const dir = dirname(path);
  if (storage === 'lifecycle' && existsSync(dir) &&
    !assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) {
    return { ok: false };
  }
  if (!existsSync(path)) return { ok: true, exists: false };
  let fd: number | undefined;
  try {
    if (storage === 'lifecycle' &&
      !assureLifecycleStoragePath(path, 'file', 'inspect-existing')) return { ok: false };
    const before = lstatSync(path);
    if (!safeStoreFile(before) || before.size > maxBytes) return { ok: false };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !safeStoreFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > maxBytes
    ) return { ok: false };
    const bytes = Buffer.alloc(opened.size);
    if (opened.size > 0 && readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { ok: false };
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) return { ok: false };
    return { ok: true, exists: true, bytes };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function removePrivateFile(path: string): boolean {
  try {
    const dir = dirname(path);
    if (existsSync(dir) && !assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) {
      return false;
    }
    if (!existsSync(path)) return true;
    if (!assureLifecycleStoragePath(path, 'file', 'inspect-existing')) return false;
    const stat = lstatSync(path);
    if (!safeStoreFile(stat)) return false;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    return true;
  } catch {
    return false;
  }
}

function parseLifecycleWriteFailureMarker(bytes: Buffer): LifecycleWriteFailureMarker | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
      'schemaVersion', 'kind', 'priorLedgerExisted', 'priorLedgerDigest', 'candidateDigest',
    ]))) return null;
    if (
      (parsed['schemaVersion'] !== 1 && parsed['schemaVersion'] !== 2) ||
      (parsed['kind'] !== 'rollback-required' && parsed['kind'] !== 'commit-complete') ||
      (parsed['schemaVersion'] === 1 && parsed['kind'] !== 'rollback-required') ||
      typeof parsed['priorLedgerExisted'] !== 'boolean' ||
      !SHA256_RE.test(String(parsed['priorLedgerDigest'] ?? '')) ||
      !SHA256_RE.test(String(parsed['candidateDigest'] ?? ''))
    ) return null;
    return parsed as unknown as LifecycleWriteFailureMarker;
  } catch {
    return null;
  }
}

/** Restore only the durable pre-write snapshot; never adopt a failed candidate. */
function recoverLifecycleWriteFailureUnlocked(): boolean {
  const markerRead = readPrivateFile(
    lifecycleFailurePath(),
    MAX_FAILURE_MARKER_BYTES,
    'lifecycle',
  );
  if (!markerRead.ok) return false;
  if (!markerRead.exists) return true;
  const marker = parseLifecycleWriteFailureMarker(markerRead.bytes);
  if (!marker) return false;
  const currentRead = readPrivateFile(
    generatedRepairLifecyclePath(),
    MAX_LEDGER_BYTES,
    'lifecycle',
  );
  if (!currentRead.ok) return false;
  const currentDigest = currentRead.exists ? digestBytes(currentRead.bytes) : null;
  const rollbackRead = readPrivateFile(lifecycleRollbackPath(), MAX_LEDGER_BYTES, 'lifecycle');
  if (!rollbackRead.ok) return false;
  if (marker.kind === 'commit-complete') {
    if (!currentRead.exists || currentDigest !== marker.candidateDigest ||
      !parseLedgerBytes(currentRead.bytes)) return false;
    if (rollbackRead.exists && digestBytes(rollbackRead.bytes) !== marker.priorLedgerDigest) return false;
    lifecycleLedgerCache = undefined;
    if (rollbackRead.exists && !removePrivateFile(lifecycleRollbackPath())) return false;
    return removePrivateFile(lifecycleFailurePath());
  }
  // A crash after rename may leave only the restored ledger and marker. This is
  // still complete rollback authority and needs no new data allocation to finish.
  if (!rollbackRead.exists) {
    if (marker.priorLedgerExisted) {
      if (currentDigest !== marker.priorLedgerDigest) return false;
    } else {
      if (currentDigest !== null && currentDigest !== marker.candidateDigest) return false;
      if (currentDigest === marker.candidateDigest && !removePrivateFile(generatedRepairLifecyclePath())) {
        return false;
      }
    }
    lifecycleLedgerCache = undefined;
    return removePrivateFile(lifecycleFailurePath());
  }
  if (digestBytes(rollbackRead.bytes) !== marker.priorLedgerDigest) return false;
  if (marker.priorLedgerExisted) {
    if (!parseLedgerBytes(rollbackRead.bytes)) return false;
  } else if (rollbackRead.bytes.length !== 0) {
    return false;
  }
  if (currentRead.exists) {
    if (currentDigest !== marker.candidateDigest && currentDigest !== marker.priorLedgerDigest) return false;
  }
  try {
    if (marker.priorLedgerExisted) {
      if (currentDigest !== marker.priorLedgerDigest) {
        // The rollback file was already fsynced before the commit marker. Rename
        // it over the failed candidate so ENOSPC recovery does not allocate a
        // second full ledger image.
        renameSync(lifecycleRollbackPath(), generatedRepairLifecyclePath());
        if (!assureLifecycleStoragePath(
          generatedRepairLifecyclePath(),
          'file',
          'inspect-existing',
        )) return false;
        fsyncDirectory(dirname(generatedRepairLifecyclePath()));
      }
    } else if (!removePrivateFile(generatedRepairLifecyclePath())) {
      return false;
    }
    lifecycleLedgerCache = undefined;
    if (!removePrivateFile(lifecycleFailurePath())) return false;
    // A stale rollback without a marker has no authority and is safe to remove later.
    removePrivateFile(lifecycleRollbackPath());
    return true;
  } catch {
    return false;
  }
}

function lifecycleWriteInProgress(): boolean {
  try {
    return existsSync(lifecycleLockPath());
  } catch {
    return true;
  }
}

function lifecycleStorageAvailable(): boolean {
  try {
    const dir = ensureLifecycleDirectory();
    const failure = lifecycleFailurePath();
    if (existsSync(failure)) {
      if (!safeStoreFile(lstatSync(failure)) ||
        !assureLifecycleStoragePath(failure, 'file', 'inspect-existing')) return false;
      return false;
    }
    const path = generatedRepairLifecyclePath();
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (!safeStoreFile(stat) || stat.size > MAX_LEDGER_BYTES ||
        !assureLifecycleStoragePath(path, 'file', 'inspect-existing')) return false;
    }
    const rollback = lifecycleRollbackPath();
    if (existsSync(rollback) && (
      !safeStoreFile(lstatSync(rollback)) ||
      !assureLifecycleStoragePath(rollback, 'file', 'inspect-existing')
    )) {
      return false;
    }
    if (!assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) return false;
    return true;
  } catch {
    return false;
  }
}

function recoverLifecycleStorage(): boolean {
  if (!existsSync(lifecycleFailurePath())) return lifecycleStorageAvailable();
  const lock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lock) return false;
  try {
    return recoverLifecycleWriteFailureUnlocked() && lifecycleStorageAvailable();
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Validate lifecycle sources without creating directories, chmodding, or writing markers. */
function lifecycleStorageReadable(): boolean {
  try {
    const failure = lifecycleFailurePath();
    if (existsSync(failure)) return false;
    if (lifecycleWriteInProgress()) return false;
    const path = generatedRepairLifecyclePath();
    const dir = dirname(path);
    if (existsSync(dir)) {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByCurrentUser(stat.uid)) return false;
      if (process.platform !== 'win32' && (stat.mode & 0o300) !== 0o300) return false;
      if (!assureLifecycleStoragePath(dir, 'directory', 'inspect-existing')) return false;
    }
    if (!existsSync(path)) return true;
    const stat = lstatSync(path);
    if (!safeStoreFile(stat) || stat.size > MAX_LEDGER_BYTES ||
      !assureLifecycleStoragePath(path, 'file', 'inspect-existing')) return false;
    const rollback = lifecycleRollbackPath();
    return !existsSync(rollback) || (
      safeStoreFile(lstatSync(rollback)) &&
      assureLifecycleStoragePath(rollback, 'file', 'inspect-existing')
    );
  } catch {
    return false;
  }
}

function currentLifecycleLedgerFingerprint(): string | null {
  const path = generatedRepairLifecyclePath();
  try {
    if (!existsSync(path)) return `${path}:missing`;
    const stat = lstatSync(path);
    if (!safeStoreFile(stat) || stat.size > MAX_LEDGER_BYTES) return null;
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/**
 * Return only a candidate that stayed installed while lifecycle marker and lock
 * state were clean. This keeps observational readers mutation-free while making
 * an installed-but-rollback-eligible candidate invisible.
 */
function loadStableReadableLedger(): LifecycleLedgerRead {
  if (existsSync(lifecycleFailurePath())) {
    if (!recoverLifecycleStorage()) return { ok: false };
  }
  if (!lifecycleStorageReadable()) return { ok: false };
  const loaded = loadLedger();
  if (!loaded.ok || !lifecycleStorageReadable()) return { ok: false };
  if (currentLifecycleLedgerFingerprint() !== loaded.fingerprint) return { ok: false };
  return lifecycleStorageReadable() ? loaded : { ok: false };
}

function saveLedger(ledger: GeneratedRepairLifecycleLedger): boolean {
  let markerPrepared = false;
  let commitComplete = false;
  let priorBytes: Buffer | undefined;
  let priorLedgerExisted = false;
  let candidateDigest: string | undefined;
  try {
    const path = generatedRepairLifecyclePath();
    if (existsSync(lifecycleFailurePath())) throw new Error('generated repair lifecycle recovery required');
    if (existsSync(path) && (
      !safeStoreFile(lstatSync(path)) ||
      !assureLifecycleStoragePath(path, 'file', 'inspect-existing')
    )) throw new Error('unsafe generated repair lifecycle ledger');
    lifecycleLedgerCache = undefined;
    const bytes = serializeLedger(ledger);
    candidateDigest = digestBytes(bytes);
    const prior = readPrivateFile(path, MAX_LEDGER_BYTES, 'lifecycle');
    if (!prior.ok) throw new Error('generated repair lifecycle rollback source unavailable');
    priorBytes = prior.exists ? prior.bytes : Buffer.alloc(0);
    priorLedgerExisted = prior.exists;
    if (prior.exists && !parseLedgerBytes(priorBytes)) {
      throw new Error('generated repair lifecycle rollback source is invalid');
    }
    const rollbackPath = lifecycleRollbackPath();
    if (existsSync(rollbackPath) && (
      !safeStoreFile(lstatSync(rollbackPath)) ||
      !assureLifecycleStoragePath(rollbackPath, 'file', 'inspect-existing')
    )) {
      throw new Error('unsafe generated repair lifecycle rollback');
    }
    if (!removePrivateFile(rollbackPath)) {
      throw new Error('stale generated repair lifecycle rollback remained');
    }
    const marker: LifecycleWriteFailureMarker = {
      schemaVersion: 2,
      kind: 'rollback-required',
      priorLedgerExisted,
      priorLedgerDigest: digestBytes(priorBytes),
      candidateDigest,
    };
    atomicPrivateWrite(lifecycleFailurePath(), Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8'));
    markerPrepared = true;
    if (priorLedgerExisted) {
      renameSync(path, rollbackPath);
      if (!assureLifecycleStoragePath(rollbackPath, 'file', 'inspect-existing')) {
        throw new Error('unsafe Windows generated repair lifecycle rollback');
      }
      fsyncDirectory(dirname(path));
    }
    atomicPrivateWrite(path, bytes);
    lifecycleLedgerCache = undefined;
    lifecycleRaceHooksForTest?.candidateInstalledBeforeCommit?.();
    atomicPrivateWrite(lifecycleFailurePath(), Buffer.from(`${JSON.stringify({
      ...marker,
      kind: 'commit-complete',
    } satisfies LifecycleWriteFailureMarker)}\n`, 'utf8'));
    commitComplete = true;
    // Cleanup is no longer part of the commit point. A surviving v2 marker
    // deterministically adopts only the already-fsynced candidate.
    if (!recoverLifecycleWriteFailureUnlocked()) {
      lifecycleLedgerCache = undefined;
      return false;
    }
    return true;
  } catch (error) {
    lifecycleAdmissionTraceHookForTest?.(
      `lifecycle-ledger-save-error:${error instanceof Error ? error.message : 'unknown'}`,
    );
    markerPrepared = markerPrepared || existsSync(lifecycleFailurePath());
    if (markerPrepared && priorBytes !== undefined) {
      try {
        if (commitComplete) {
          recoverLifecycleWriteFailureUnlocked();
        } else {
          const rollbackMarker: LifecycleWriteFailureMarker = {
            schemaVersion: 2,
            kind: 'rollback-required',
            priorLedgerExisted,
            priorLedgerDigest: digestBytes(priorBytes),
            candidateDigest: candidateDigest ?? digestBytes(Buffer.alloc(0)),
          };
          atomicPrivateWrite(
            lifecycleFailurePath(),
            Buffer.from(`${JSON.stringify(rollbackMarker)}\n`, 'utf8'),
          );
          recoverLifecycleWriteFailureUnlocked();
        }
      } catch {
        // The structured marker and rollback snapshot remain the recovery authority.
      }
    } else {
      removePrivateFile(lifecycleRollbackPath());
    }
    return false;
  }
}

function serializeLedger(ledger: GeneratedRepairLifecycleLedger): Buffer {
  const authority = handoffAuthoritySnapshot();
  if (authority.sourceState === 'degraded') {
    throw new Error('generated repair lifecycle handoff authority degraded');
  }
  const isPending = (record: GeneratedRepairLifecycleRecord): boolean =>
    isDiagnosticTreatmentRecord(record, authority) &&
    record.disposition !== 'active' &&
    !record.treatmentWitnessRecordedAt;
  const serializeRecord = (record: GeneratedRepairLifecycleRecord): string =>
    record.treatmentWitnessRecordedAt && record.emptyAttemptProofReceipts
      ? JSON.stringify((({ emptyAttemptProofReceipts: _proofs, ...retained }) => retained)(record))
      : JSON.stringify(record);
  let pendingCount = 0;
  let pendingBytes = 0;
  const recordBytes = new Uint32Array(ledger.records.length);
  const retained = new Uint8Array(ledger.records.length);
  retained.fill(1);
  let retainedRecordBytes = 0;
  for (let index = 0; index < ledger.records.length; index++) {
    const record = ledger.records[index]!;
    const serializedBytes = Buffer.byteLength(serializeRecord(record), 'utf8');
    if (serializedBytes > MAX_LEDGER_BYTES) {
      throw new Error('generated repair lifecycle record bytes exceeded');
    }
    recordBytes[index] = serializedBytes;
    retainedRecordBytes += serializedBytes;
    if (isPending(record)) {
      pendingCount++;
      pendingBytes += serializedBytes;
    }
  }
  if (pendingCount > MAX_PENDING_OUTCOMES || pendingBytes > MAX_CAPSULE_BYTES) {
    throw new Error('generated repair lifecycle pending outbox capacity exceeded');
  }
  let retainedCount = ledger.records.length;
  let droppedThrough = ledger.retention?.droppedThrough;
  const noteDropped = (record: GeneratedRepairLifecycleRecord): void => {
    if (!droppedThrough || Date.parse(record.updatedAt) > Date.parse(droppedThrough)) {
      droppedThrough = new Date(record.updatedAt).toISOString();
    }
  };
  const prefixFor = (): string =>
    `{"schemaVersion":2${droppedThrough ? `,"retention":{"droppedThrough":${JSON.stringify(droppedThrough)}}` : ''},"records":[`;
  const encodedLength = (): number => {
    const recordsLength = retainedRecordBytes + Math.max(0, retainedCount - 1);
    return Buffer.byteLength(prefixFor(), 'utf8') + recordsLength + Buffer.byteLength(']}\n', 'utf8');
  };
  let cursor = 0;
  while (retainedCount > MAX_RECORDS || encodedLength() > MAX_LEDGER_BYTES) {
    while (cursor < ledger.records.length - 1 && (!retained[cursor] || isPending(ledger.records[cursor]!))) cursor++;
    if (cursor >= ledger.records.length - 1) {
      throw new Error('generated repair lifecycle has no safely droppable record');
    }
    retained[cursor] = 0;
    retainedCount--;
    retainedRecordBytes -= recordBytes[cursor]!;
    noteDropped(ledger.records[cursor]!);
    cursor++;
  }
  const prefix = prefixFor();
  const suffix = ']}\n';
  const canonicalLength = Buffer.byteLength(prefix, 'utf8') + retainedRecordBytes +
    Math.max(0, retainedCount - 1) + Buffer.byteLength(suffix, 'utf8');
  const canonical = Buffer.allocUnsafe(canonicalLength);
  let offset = canonical.write(prefix, 0, 'utf8');
  let wroteRecord = false;
  for (let index = 0; index < ledger.records.length; index++) {
    if (!retained[index]) continue;
    if (wroteRecord) canonical[offset++] = 0x2c;
    const expectedBytes = recordBytes[index]!;
    const written = canonical.write(serializeRecord(ledger.records[index]!), offset, expectedBytes, 'utf8');
    if (written !== expectedBytes) {
      throw new Error('generated repair lifecycle record serialization changed');
    }
    offset += written;
    wroteRecord = true;
  }
  offset += canonical.write(suffix, offset, 'utf8');
  if (offset !== canonical.length || canonical.length > MAX_LEDGER_BYTES) {
    throw new Error('generated repair lifecycle bytes exceeded');
  }
  return canonical;
}

function resultFromRecord(
  available: boolean,
  record: GeneratedRepairLifecycleRecord | undefined,
): GeneratedRepairLifecycleResult {
  const legacyBackendlessActive = record?.disposition === 'active' &&
    record.emptyAttemptHashes.length > 0 &&
    record.emptyAttemptBackends === undefined;
  const legacyTierlessActive = record?.disposition === 'active' &&
    record.emptyAttemptHashes.length > 0 &&
    record.emptyAttemptBackends !== undefined &&
    record.emptyAttemptTiers === undefined;
  return {
    available: available && !legacyTierlessActive,
    disposition: legacyBackendlessActive ? 'retired' : (record?.disposition ?? 'active'),
    authoritativeEmptyRuns: record?.emptyAttemptHashes.length ?? 0,
    ...(record?.emptyAttemptHashes.length
      ? { lastAuthoritativeEmptyBackend: record.emptyAttemptBackends?.at(-1) ?? null }
      : {}),
    ...(record?.emptyAttemptBackends && record.emptyAttemptBackends.length > 0
      ? { authoritativeEmptyBackends: record.emptyAttemptBackends.slice() }
      : {}),
    ...(record?.emptyAttemptTiers && record.emptyAttemptTiers.length > 0
      ? { authoritativeEmptyTiers: record.emptyAttemptTiers.slice() }
      : {}),
  };
}

function prooflessLegacyResult(): GeneratedRepairLifecycleResult {
  return {
    available: false,
    disposition: 'active',
    authoritativeEmptyRuns: 0,
    unavailableReason: 'proofless-legacy',
    requiredAction: 'operator-reset',
  };
}

function retentionDegradedResult(): GeneratedRepairLifecycleResult {
  return {
    available: false,
    disposition: 'active',
    authoritativeEmptyRuns: 0,
    unavailableReason: 'retention-degraded',
    requiredAction: 'operator-reset',
  };
}

function itemIntersectsLifecycleRetention(
  item: WorkItem,
  ledger: GeneratedRepairLifecycleLedger,
): boolean {
  return Boolean(
    ledger.retention &&
    canonicalUtcTimestamp(item.ts) &&
    Date.parse(item.ts) <= Date.parse(ledger.retention.droppedThrough),
  );
}

function hasProoflessDiagnosticEvidence(record: GeneratedRepairLifecycleRecord): boolean {
  if (record.treatmentWitnessRecordedAt && record.treatmentWitnessDigest) return false;
  return (
    record.emptyAttemptHashes.length > 0 &&
    (
      record.emptyAttemptBackends?.length !== record.emptyAttemptHashes.length ||
      record.emptyAttemptTiers?.length !== record.emptyAttemptHashes.length ||
      record.emptyAttemptProofReceipts?.length !== record.emptyAttemptHashes.length ||
      record.emptyAttemptProofReceipts?.some((receipt) =>
        receipt.targetDigest === undefined || publicationEventFromReceipt(receipt) === null) !== false
    )
  ) || (
    record.disposition !== 'active' &&
    record.terminalAttemptHash !== undefined &&
    (
      record.terminalAttemptProofReceipt?.targetDigest === undefined ||
      publicationEventFromReceipt(record.terminalAttemptProofReceipt) === null
    )
  );
}

function mergedLifecycleRecord(
  generationId: string,
  generationIds: readonly string[],
  records: readonly GeneratedRepairLifecycleRecord[],
): { ok: true; record: GeneratedRepairLifecycleRecord | undefined } | { ok: false } {
  const selected = records
    .filter((record) => generationIds.includes(record.generationId))
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
  if (selected.length === 0) return { ok: true, record: undefined };
  if (
    selected.length === 1 &&
    selected[0]!.emptyAttemptHashes.length > 0 &&
    selected[0]!.emptyAttemptBackends === undefined
  ) return { ok: true, record: { ...selected[0]!, generationId } };
  const terminal = new Set(selected
    .map((record) => record.disposition)
    .filter((disposition) => disposition !== 'active'));
  if (terminal.size > 1) return { ok: false };
  const terminalAliases = selected.filter((record) => record.disposition !== 'active');
  const terminalAttemptHashes = terminalAliases.flatMap((record) =>
    record.terminalAttemptHash ? [record.terminalAttemptHash] : []);
  if (terminalAttemptHashes.some((hash) => hash !== terminalAttemptHashes[0])) return { ok: false };
  const terminalReceipts = terminalAliases.flatMap((record) =>
    record.terminalAttemptProofReceipt ? [record.terminalAttemptProofReceipt] : []);
  if (terminalReceipts.some((receipt) =>
    !sameDispatchProofReceipt(receipt, terminalReceipts[0]!))) return { ok: false };
  const proposalAuthorities = terminalAliases.flatMap((record) =>
    record.proposalAuthority ? [record.proposalAuthority] : []);
  if (proposalAuthorities.some((authority) =>
    authority.bindingDigest !== proposalAuthorities[0]!.bindingDigest)) return { ok: false };
  const treatmentWitnesses = terminalAliases.flatMap((record) =>
    record.treatmentWitnessRecordedAt && record.treatmentWitnessDigest
      ? [{ recordedAt: record.treatmentWitnessRecordedAt, digest: record.treatmentWitnessDigest }]
      : []);
  if (treatmentWitnesses.some((witness) =>
    witness.recordedAt !== treatmentWitnesses[0]!.recordedAt ||
    witness.digest !== treatmentWitnesses[0]!.digest)) return { ok: false };
  const terminalSource = terminalAliases.at(-1);
  const authoritativeGenerationId = terminalReceipts[0]?.proof.repairGenerationId ??
    terminalSource?.generationId ?? generationId;

  const attempts = new Map<string, {
    backend: EngineId;
    tier?: EngineTier;
    receipt?: GeneratedRepairDispatchProofReceipt;
    receiptMissing: boolean;
  }>();
  for (const record of selected) {
    if (
      record.emptyAttemptHashes.length > 0 &&
      record.emptyAttemptBackends?.length !== record.emptyAttemptHashes.length
    ) return { ok: false };
    for (let index = 0; index < record.emptyAttemptHashes.length; index++) {
      const hash = record.emptyAttemptHashes[index]!;
      const backend = record.emptyAttemptBackends![index]!;
      const tier = record.emptyAttemptTiers?.[index];
      const receipt = record.emptyAttemptProofReceipts?.[index];
      if (backend === 'builtin') return { ok: false };
      const existing = attempts.get(hash);
      if (existing !== undefined && (existing.backend !== backend || existing.tier !== tier)) return { ok: false };
      if (existing?.receipt && receipt && !sameDispatchProofReceipt(existing.receipt, receipt)) return { ok: false };
      if (existing) {
        if (!receipt) existing.receiptMissing = true;
        else if (!existing.receipt) existing.receipt = structuredClone(receipt);
      } else if (attempts.size < 2) {
        attempts.set(hash, {
          backend,
          ...(tier ? { tier } : {}),
          ...(receipt ? { receipt: structuredClone(receipt) } : {}),
          receiptMissing: receipt === undefined,
        });
      }
    }
  }
  const mergedAttempts = [...attempts.entries()];
  const receiptsComplete = mergedAttempts.length > 0 && mergedAttempts.every(([, attempt]) =>
    attempt.receipt !== undefined && !attempt.receiptMissing);
  if (receiptsComplete) {
    mergedAttempts.sort((left, right) =>
      left[1].receipt!.proof.repairAttemptOrdinal - right[1].receipt!.proof.repairAttemptOrdinal);
    if (!validStoredAttemptReceiptOrdinals(mergedAttempts.map(([, attempt]) => attempt.receipt!))) {
      return { ok: false };
    }
  }
  const emptyAttemptHashes = mergedAttempts.map(([hash]) => hash);
  const emptyAttemptBackends = emptyAttemptHashes.map((hash) => attempts.get(hash)!.backend);
  const mergedTiers = emptyAttemptHashes.map((hash) => attempts.get(hash)!.tier);
  const emptyAttemptTiers = mergedTiers.every((tier): tier is EngineTier => tier !== undefined)
    ? mergedTiers
    : undefined;
  if (
    emptyAttemptHashes.length >= 2 && (
      emptyAttemptTiers === undefined ||
      new Set(emptyAttemptTiers).size !== 1 ||
      new Set(emptyAttemptBackends).size !== emptyAttemptBackends.length
    )
  ) return { ok: false };
  const explicitDisposition = [...terminal][0];
  const disposition: GeneratedRepairDisposition = explicitDisposition ?? (
    emptyAttemptHashes.length >= 2 ? 'exhausted' : 'active'
  );
  return {
    ok: true,
    record: {
      generationId: authoritativeGenerationId,
      disposition,
      emptyAttemptHashes,
      emptyAttemptBackends,
      ...(emptyAttemptTiers ? { emptyAttemptTiers } : {}),
      ...(receiptsComplete
        ? { emptyAttemptProofReceipts: mergedAttempts.map(([, attempt]) => structuredClone(attempt.receipt!)) }
        : {}),
      ...(terminalAttemptHashes[0]
        ? { terminalAttemptHash: terminalAttemptHashes[0] }
        : {}),
      ...(terminalReceipts[0]
        ? { terminalAttemptProofReceipt: structuredClone(terminalReceipts[0]) }
        : {}),
      ...(proposalAuthorities[0]
        ? { proposalAuthority: structuredClone(proposalAuthorities[0]) }
        : {}),
      ...(treatmentWitnesses[0]
        ? {
            treatmentWitnessRecordedAt: treatmentWitnesses[0].recordedAt,
            treatmentWitnessDigest: treatmentWitnesses[0].digest,
          }
        : {}),
      updatedAt: terminalSource?.updatedAt ?? selected.at(-1)!.updatedAt,
    },
  };
}

function replaceLifecycleFamily(
  ledger: GeneratedRepairLifecycleLedger,
  record: GeneratedRepairLifecycleRecord,
  generationIds: readonly string[],
): void {
  ledger.records = ledger.records.filter((candidate) => !generationIds.includes(candidate.generationId));
  ledger.records.push(record);
}

function diagnosticAttemptProofTarget(
  item: WorkItem,
  eventTs: string,
  repairAttemptOrdinal: 1 | 2,
  authority: HandoffAuthoritySnapshot,
  outcome: DispatchProductionAttemptProofTarget['outcome'] = 'empty-diff',
  proposalId?: string,
  receiptGenerationId?: string,
  aliasedObjectiveHash?: string,
): DispatchProductionAttemptProofTarget | null {
  if (
    !isTrustedDiagnosticResliceItem(item) ||
    !canonicalUtcTimestamp(eventTs) ||
    (outcome === 'proposal-created'
      ? !isSafeExecutionIdentity(proposalId)
      : proposalId !== undefined)
  ) return null;
  const generationId = generatedRepairGenerationIdFromAuthority(item, authority);
  if (
    generationId === null ||
    typeof item.repairHandoffId !== 'string' ||
    item.repairGenerationId !== generationId
  ) return null;
  const handoff = authority.byEventId.get(item.repairHandoffId);
  if (
    !handoff || handoff.kind !== 'no-diff-reslice' || handoff.generationId !== generationId ||
    handoff.childItemId !== item.id || handoff.parentObjectiveHash === undefined
  ) return null;
  const receiptHandoff = receiptGenerationId === undefined || receiptGenerationId === generationId
    ? handoff
    : compatibleActiveEvidenceAliasObservation(authority, handoff, receiptGenerationId);
  if (
    !receiptHandoff ||
    receiptHandoff.kind !== 'no-diff-reslice' ||
    receiptHandoff.childItemId !== item.id ||
    receiptHandoff.parentObjectiveHash === undefined
  ) return null;
  const treatmentUnitId = repairTreatmentUnitId({
    kind: 'no-diff-reslice',
    repo: receiptHandoff.repo,
    parentItemId: receiptHandoff.parentItemId,
    parentObjectiveHash: receiptHandoff.parentObjectiveHash,
  });
  const treatment = treatmentUnitId ? repairTreatmentForUnitId(treatmentUnitId) : null;
  const objectiveHash = receiptHandoff !== handoff && SHA256_RE.test(aliasedObjectiveHash ?? '')
    ? aliasedObjectiveHash!
    : workItemObjectiveHash(item);
  if (!treatmentUnitId || !treatment || !objectiveHash) return null;
  const repo = canonicalDispatchRepoIdentity(item.repo);
  if (repo === null) return null;
  return {
    ts: eventTs,
    sequenceStartTs: receiptHandoff.ts,
    sequenceEndTs: new Date().toISOString(),
    itemId: item.id,
    repo,
    source: item.source,
    outcome,
    ...(proposalId ? { proposalId } : {}),
    objectiveHash,
    repairHandoffId: receiptHandoff.eventId,
    repairGenerationId: receiptHandoff.generationId,
    repairTreatmentUnitId: treatmentUnitId,
    repairTreatment: treatment,
    repairAttemptOrdinal,
  };
}

function resolveProvenAttemptProofs(
  targets: readonly DispatchProductionAttemptProofTarget[],
): GeneratedRepairDispatchAttemptWitness[] | null {
  const resolved = resolveDispatchProductionAttemptWitnesses(targets);
  if (resolved.status !== 'resolved' || resolved.resolutions.length !== targets.length) return null;
  const witnesses = resolved.resolutions.flatMap((resolution) =>
    resolution.status === 'proven'
      ? [{ proof: resolution.proof, event: resolution.event }]
      : []);
  return witnesses.length === targets.length ? witnesses : null;
}

function proposalContentAuthorityDigest(proposal: Proposal): string | null {
  if (!proposal.diff || !proposal.diffHash) return null;
  const diffDigest = createHash('sha256').update(proposal.diff, 'utf8').digest('hex');
  if (proposal.diffHash !== diffDigest) return null;
  let repo: string;
  try {
    if (proposal.repo === null) return null;
    repo = resolve(proposal.repo);
  } catch {
    return null;
  }
  const authority = [
    'ashlr:generated-repair-proposal-content:v1',
    proposal.id,
    repo,
    proposal.origin,
    proposal.kind,
    proposal.title,
    proposal.summary,
    Buffer.byteLength(proposal.diff, 'utf8'),
    diffDigest,
    proposal.workItemId ?? null,
    proposal.workItemGenerationId ?? null,
    proposal.workSource ?? null,
    proposal.runId ?? null,
    proposal.trajectoryId ?? null,
    proposal.runEventSummary ?? null,
    proposal.createdAt,
    proposal.engineModel ?? null,
    proposal.engineTier ?? null,
    proposal.diffHash,
    proposal.provenanceSig ?? null,
    proposal.producerProvenanceVersion ?? null,
    proposal.producerProvenanceSig ?? null,
    proposal.isPartial ?? false,
  ];
  return createHash('sha256').update(JSON.stringify(authority), 'utf8').digest('hex');
}

function durableProposalAuthority(
  item: WorkItem,
  generationIds: readonly string[],
  evidence: Extract<GeneratedRepairLifecycleEvidence, { kind: 'proposal-created' }>,
): { proposal: Proposal; contentDigest: string } | null {
  const proposal = loadProposal(evidence.proposalId);
  if (!proposal || (
    proposal.status !== 'pending' &&
    proposal.status !== 'approved' &&
    proposal.status !== 'awaiting-host-merge' &&
    proposal.status !== 'applied'
  )) return null;
  if (
    proposal.id !== evidence.proposalId ||
    proposal.workItemId !== item.id ||
    proposal.workSource !== 'self' ||
    !proposal.workItemGenerationId ||
    !generationIds.includes(proposal.workItemGenerationId) ||
    (proposal.origin !== 'agent' && proposal.origin !== 'swarm') ||
    (proposal.kind !== 'patch' && proposal.kind !== 'pr') ||
    !proposal.diff ||
    proposal.isPartial === true ||
    !proposal.runId ||
    !proposal.trajectoryId ||
    proposal.trajectoryId !== `run:${proposal.runId}` ||
    evidence.attemptId !== proposal.trajectoryId ||
    proposal.runEventSummary?.runId !== proposal.runId ||
    proposal.runEventSummary.status !== 'done' ||
    proposal.runEventSummary.outcome !== 'proposal-created' ||
    proposal.runEventSummary.proposalCreated !== true ||
    proposal.runEventSummary.proposalId !== proposal.id
  ) return null;
  try {
    if (proposal.repo === null || resolve(proposal.repo) !== resolve(item.repo)) return null;
  } catch {
    return null;
  }
  const contentDigest = proposalContentAuthorityDigest(proposal);
  return contentDigest ? { proposal, contentDigest } : null;
}

function exactOrdinaryFailurePredecessor(
  item: WorkItem,
  generationIds: readonly string[],
  second: DispatchProductionEvent,
  authority: HandoffAuthoritySnapshot,
): boolean {
  if (second.repairAttemptOrdinal !== 2 || !second.repairPreviousBackend) return false;
  const resolved = readDispatchProductionFailureAttemptReceipts(generationIds);
  if (resolved.status !== 'resolved' || !resolved.authoritative) return false;
  const firsts = resolved.receipts.filter(({ proof }) =>
    generationIds.includes(proof.repairGenerationId) && proof.repairAttemptOrdinal === 1);
  if (firsts.length !== 1) return false;
  const { proof, event } = firsts[0]!;
  let repo: string;
  let eventRepo: string;
  try {
    repo = resolve(item.repo);
    eventRepo = resolve(event.repo);
  } catch { return false; }
  const failureHandoff = authority.byEventId.get(proof.repairHandoffId);
  return proof.previousBackend === null &&
    failureHandoff !== undefined &&
    failureHandoff.generationId === proof.repairGenerationId &&
    generationIds.includes(failureHandoff.generationId) &&
    Date.parse(event.ts) < Date.parse(second.ts) &&
    proof.attemptHash !== generatedRepairLifecycleAttemptHash(second.trajectoryId!) &&
    proof.backend === second.repairPreviousBackend &&
    proof.tier === second.tier &&
    event.itemId === item.id &&
    eventRepo === repo &&
    event.source === item.source &&
    event.objectiveHash === workItemObjectiveHash(item) &&
    event.proposalCreated === false &&
    event.proposalId === undefined &&
    DIAGNOSTIC_FAILURE_OUTCOMES.has(event.outcome) &&
    event.repairRootId === item.repairRootId &&
    event.repairDepth === item.repairDepth;
}

interface ExactOrdinaryProposalAttempt {
  event: DispatchProductionEvent;
  receipt: NonNullable<GeneratedRepairProposalAuthority['attemptReceipt']>;
}

function exactOrdinaryProposalAttempt(
  item: WorkItem,
  generationIds: readonly string[],
  evidence: Extract<GeneratedRepairLifecycleEvidence, { kind: 'proposal-created' }>,
  proposal: Proposal,
  authority: HandoffAuthoritySnapshot,
): ExactOrdinaryProposalAttempt | null {
  const ts = evidence.ts;
  const objectiveHash = workItemObjectiveHash(item);
  if (!canonicalUtcTimestamp(ts) || !objectiveHash ||
    !SHA256_RE.test(item.repairRootId ?? '') ||
    (item.repairDepth !== 0 && item.repairDepth !== 1)) return null;
  const protocol = readAttemptProtocolSnapshot(join(dispatchProductionDir(), 'repair-attempt-proofs'));
  if (!protocol) return null;
  const candidates = generationIds.flatMap((generationId) => ([1, 2] as const).flatMap((ordinal) => {
    const exact = exactAttemptReceiptEvent(generationId, ordinal, protocol);
    if (!exact) return [];
    const event = exact.event;
    let repo: string;
    try { repo = resolve(event.repo); } catch { return []; }
    if (
      event.ts !== ts ||
      event.itemId !== item.id ||
      repo !== resolve(item.repo) ||
      event.source !== 'self' ||
      event.outcome !== 'proposal-created' ||
      event.proposalCreated !== true ||
      event.proposalId !== evidence.proposalId ||
      event.trajectoryId !== evidence.attemptId ||
      event.runId !== proposal.runId ||
      event.objectiveHash !== objectiveHash ||
      event.basis !== 'run-proposal-outcome' ||
      event.repairGenerationId !== generationId ||
      event.repairRootId !== item.repairRootId ||
      event.repairDepth !== item.repairDepth ||
      event.repairTreatmentUnitId !== undefined ||
      event.repairTreatment !== undefined ||
      event.repairTreatmentOutcome !== undefined ||
      event.repairTreatmentAttemptHash !== undefined ||
      (ordinal === 2 && !exactOrdinaryFailurePredecessor(item, generationIds, event, authority))
    ) return [];
    return [{
      event,
      receipt: {
        generationId,
        ordinal,
        fileDigest: exact.fileDigest,
        retirementEpoch: exact.retirementEpoch,
      },
    }];
  }));
  return candidates.length === 1 ? candidates[0]! : null;
}

function proposalAuthorityFromEvent(
  proposalId: string,
  trajectoryId: string,
  event: DispatchProductionEvent,
  contentDigest: string,
  attemptReceipt?: GeneratedRepairProposalAuthority['attemptReceipt'],
): GeneratedRepairProposalAuthority {
  const eventDigest = digestBytes(Buffer.from(JSON.stringify(event), 'utf8'));
  const proposalIdHash = digestBytes(Buffer.from(proposalId, 'utf8'));
  const trajectoryIdHash = digestBytes(Buffer.from(trajectoryId, 'utf8'));
  return {
    schemaVersion: attemptReceipt ? 2 : 1,
    proposalIdHash,
    trajectoryIdHash,
    eventTs: event.ts,
    eventDigest,
    contentDigest,
    ...(attemptReceipt ? { attemptReceipt: { ...attemptReceipt } } : {}),
    bindingDigest: proposalAuthorityBindingDigest(
      proposalIdHash, trajectoryIdHash, event.ts, eventDigest, contentDigest, attemptReceipt,
    ),
  };
}

function exactOrdinaryProposalAuthorityEvent(
  authority: GeneratedRepairProposalAuthority,
  proposal: Proposal,
): boolean {
  const read = readPrivateFile(
    join(dispatchProductionDir(), `${authority.eventTs.slice(0, 10)}.jsonl`),
    MAX_LEDGER_BYTES,
  );
  if (!read.ok || !read.exists || read.bytes.length === 0 || read.bytes.at(-1) !== 0x0a) return false;
  const lines = read.bytes.toString('utf8').slice(0, -1).split('\n');
  if (lines.length > MAX_ATTEMPT_ROWS) return false;
  let matches = 0;
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_ATTEMPT_ROW_BYTES) return false;
    try {
      const parsed = JSON.parse(line) as DispatchProductionEvent;
      const event = sanitizeDispatchProductionEvent(parsed, { materializeLearningLabel: true });
      if (JSON.stringify(event) !== line) return false;
      if (digestBytes(Buffer.from(line, 'utf8')) !== authority.eventDigest) continue;
      if (
        event.ts !== authority.eventTs ||
        event.itemId !== proposal.workItemId ||
        event.proposalId !== proposal.id ||
        event.trajectoryId !== proposal.trajectoryId ||
        event.runId !== proposal.runId ||
        event.outcome !== 'proposal-created' ||
        event.proposalCreated !== true ||
        event.source !== 'self' ||
        event.basis !== 'run-proposal-outcome'
      ) return false;
      if (!proposal.repo || resolve(event.repo) !== resolve(proposal.repo)) return false;
      matches++;
    } catch {
      return false;
    }
  }
  return matches === 1;
}

interface ProposalAuthoritySnapshot {
  available: boolean;
  candidatesByBindingHash: Map<string, Proposal[]>;
}

function proposalAuthorityBindingHash(proposalIdHash: string, trajectoryIdHash: string): string {
  return `${proposalIdHash}:${trajectoryIdHash}`;
}

function loadProposalAuthoritySnapshot(): ProposalAuthoritySnapshot {
  const read = listProposalsDetailed({
    requireComplete: true,
    maxFiles: MAX_PROPOSAL_AUTHORITY_FILES,
    maxBytes: MAX_PROPOSAL_AUTHORITY_BYTES,
    maxFileBytes: MAX_PROPOSAL_AUTHORITY_FILE_BYTES,
  });
  if (!read.complete || read.sourceState === 'degraded') {
    return { available: false, candidatesByBindingHash: new Map() };
  }
  const candidatesByBindingHash = new Map<string, Proposal[]>();
  for (const proposal of read.proposals) {
    if (typeof proposal.trajectoryId !== 'string') continue;
    const key = proposalAuthorityBindingHash(
      digestBytes(Buffer.from(proposal.id, 'utf8')),
      digestBytes(Buffer.from(proposal.trajectoryId, 'utf8')),
    );
    const candidates = candidatesByBindingHash.get(key) ?? [];
    candidates.push(proposal);
    candidatesByBindingHash.set(key, candidates);
  }
  return { available: true, candidatesByBindingHash };
}

function withProposalStoreAuthority<T>(
  consume: () => T,
): { ok: true; value: T } | { ok: false } {
  // Lock order is lifecycle -> generation -> proposal store -> receipt writer/date partition.
  const lock = acquireProposalStoreMutationLock(250);
  if (!lock) return { ok: false };
  try {
    return { ok: true, value: consume() };
  } finally {
    releaseProposalStoreMutationLock(lock);
  }
}

function exactOrdinaryProposalReceiptStillValid(
  authority: GeneratedRepairProposalAuthority,
  proposal: Proposal,
): boolean {
  const binding = authority.attemptReceipt;
  if (authority.schemaVersion !== 2 || !binding) return false;
  const exact = exactAttemptReceiptEvent(binding.generationId, binding.ordinal);
  if (!exact || exact.fileDigest !== binding.fileDigest ||
    exact.retirementEpoch < binding.retirementEpoch) return false;
  const event = exact.event;
  try {
    return digestBytes(Buffer.from(JSON.stringify(event), 'utf8')) === authority.eventDigest &&
      event.ts === authority.eventTs &&
      event.itemId === proposal.workItemId &&
      event.proposalId === proposal.id &&
      event.trajectoryId === proposal.trajectoryId &&
      event.runId === proposal.runId &&
      event.outcome === 'proposal-created' &&
      event.proposalCreated === true &&
      event.source === 'self' &&
      event.basis === 'run-proposal-outcome' &&
      event.repairGenerationId === binding.generationId &&
      event.repairAttemptOrdinal === binding.ordinal &&
      proposal.repo !== null && resolve(event.repo) === resolve(proposal.repo);
  } catch {
    return false;
  }
}

function proposalAuthorityStillValid(
  record: GeneratedRepairLifecycleRecord,
  snapshot: ProposalAuthoritySnapshot = loadProposalAuthoritySnapshot(),
): boolean {
  if (record.disposition !== 'retired') return true;
  const authority = record.proposalAuthority;
  if (!authority || !validProposalAuthority(authority)) return false;
  if (!snapshot.available) return false;
  const candidates = snapshot.candidatesByBindingHash.get(proposalAuthorityBindingHash(
    authority.proposalIdHash,
    authority.trajectoryIdHash,
  )) ?? [];
  if (candidates.length !== 1) return false;
  const proposal = candidates[0]!;
  const contentDigest = proposalContentAuthorityDigest(proposal);
  if (contentDigest !== authority.contentDigest ||
    authority.bindingDigest !== proposalAuthorityBindingDigest(
      authority.proposalIdHash,
      authority.trajectoryIdHash,
      authority.eventTs,
      authority.eventDigest,
      authority.contentDigest,
      authority.attemptReceipt,
    )) return false;
  if (authority.schemaVersion === 2) {
    return exactOrdinaryProposalReceiptStillValid(authority, proposal);
  }
  const receipt = record.terminalAttemptProofReceipt;
  if (receipt) {
    const capsule = publicationEventFromReceipt(receipt);
    return receipt.proof.eventDigest === authority.eventDigest &&
      receipt.proof.eventTs === authority.eventTs &&
      typeof capsule?.event.proposalId === 'string' &&
      digestBytes(Buffer.from(capsule.event.proposalId, 'utf8')) === authority.proposalIdHash &&
      typeof capsule.event.trajectoryId === 'string' &&
      digestBytes(Buffer.from(capsule.event.trajectoryId, 'utf8')) === authority.trajectoryIdHash;
  }
  return exactOrdinaryProposalAuthorityEvent(authority, proposal);
}

interface AttemptProtocolSnapshot {
  activationId: string;
  retirementEpoch: number;
  quality: 'healthy' | 'saturated';
  activeGenerations: Map<string, string>;
  generationBlocked: (generationId: string) => boolean;
}

interface AttemptRetentionArtifact {
  name: string;
  generationId: string;
  ordinal: 1 | 2;
  kind: 'receipt' | 'intent';
  eventTs: string;
  eventDigest: string;
  fileDigest: string;
}

function countMembershipBits(bits: Buffer): number {
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

function attemptMembershipIndexes(generationId: string): number[] {
  const digest = createHash('sha256')
    .update('ashlr:dispatch-attempt-generation-membership:v1\0', 'utf8')
    .update(generationId, 'utf8')
    .digest();
  return Array.from({ length: ATTEMPT_MEMBERSHIP_HASHES }, (_, index) =>
    digest.readUInt32BE(index * 4) % ATTEMPT_MEMBERSHIP_BITS);
}

function parseAttemptMembershipSegment(value: unknown, withCounts: boolean): Buffer | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set(withCounts
    ? ['algorithm', 'bitCount', 'hashCount', 'bits', 'insertedCount', 'setBitCount']
    : ['algorithm', 'bitCount', 'hashCount', 'bits']))) return null;
  if (
    value['algorithm'] !== 'sha256-bloom-v1' ||
    value['bitCount'] !== ATTEMPT_MEMBERSHIP_BITS ||
    value['hashCount'] !== ATTEMPT_MEMBERSHIP_HASHES ||
    typeof value['bits'] !== 'string'
  ) return null;
  const bits = Buffer.from(value['bits'], 'base64');
  if (bits.length !== ATTEMPT_MEMBERSHIP_BYTES || bits.toString('base64') !== value['bits']) return null;
  if (withCounts && (
    !Number.isSafeInteger(value['insertedCount']) || Number(value['insertedCount']) < 0 ||
    !Number.isSafeInteger(value['setBitCount']) || Number(value['setBitCount']) < 0 ||
    Number(value['setBitCount']) !== countMembershipBits(bits)
  )) return null;
  return bits;
}

function readAttemptProtocolSnapshot(attemptDir: string): AttemptProtocolSnapshot | null {
  const sharedQuality = readDispatchProductionAttemptProtocolQuality();
  if (sharedQuality.status === 'degraded') return null;
  const read = readPrivateFile(join(attemptDir, '.protocol.json'), MAX_ATTEMPT_PROTOCOL_BYTES);
  if (!read.ok || !read.exists) return null;
  try {
    const parsed = JSON.parse(read.bytes.toString('utf8')) as unknown;
    if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, new Set([
      'schemaVersion', 'activationId', 'activatedAt', 'acceptsEventsAfter', 'generations',
      'retirementEpoch', 'blockedGenerations',
    ])) || parsed['schemaVersion'] !== 5 ||
      !SHA256_RE.test(String(parsed['activationId'] ?? '')) ||
      !Number.isSafeInteger(parsed['retirementEpoch']) || Number(parsed['retirementEpoch']) < 0 ||
      !canonicalUtcTimestamp(parsed['activatedAt']) ||
      !canonicalUtcTimestamp(parsed['acceptsEventsAfter']) ||
      Date.parse(String(parsed['acceptsEventsAfter'])) > Date.parse(String(parsed['activatedAt'])) ||
      !Array.isArray(parsed['generations']) || parsed['generations'].length > 2_049) return null;
    const activeGenerations = new Map<string, string>();
    for (const generation of parsed['generations']) {
      if (!isPlainRecord(generation) || !hasOnlyKeys(generation, new Set(['generationId', 'admittedAt'])) ||
        !SHA256_RE.test(String(generation['generationId'] ?? '')) ||
        !canonicalUtcTimestamp(generation['admittedAt']) ||
        activeGenerations.has(String(generation['generationId']))) return null;
      activeGenerations.set(String(generation['generationId']), String(generation['admittedAt']));
    }
    const ordered = [...activeGenerations.keys()];
    if (ordered.some((generationId, index) => index > 0 && ordered[index - 1]! >= generationId)) return null;
    const blocked = parsed['blockedGenerations'];
    if (!isPlainRecord(blocked) || !hasOnlyKeys(blocked, new Set([
      'algorithm', 'maxSegmentFalsePositiveRate', 'quality', 'segments',
    ])) || blocked['algorithm'] !== 'segmented-sha256-bloom-v1' ||
      blocked['maxSegmentFalsePositiveRate'] !== MAX_ATTEMPT_MEMBERSHIP_FALSE_POSITIVE_RATE ||
      (blocked['quality'] !== 'healthy' && blocked['quality'] !== 'saturated') ||
      blocked['quality'] !== sharedQuality.status ||
      !Array.isArray(blocked['segments']) || blocked['segments'].length < 1 ||
      blocked['segments'].length > MAX_ATTEMPT_MEMBERSHIP_SEGMENTS) return null;
    const parsedSegments = blocked['segments'].map((segment) =>
      parseAttemptMembershipSegment(segment, true));
    if (parsedSegments.some((segment) => segment === null)) return null;
    const segments = parsedSegments as Buffer[];
    return {
      activationId: String(parsed['activationId']),
      retirementEpoch: Number(parsed['retirementEpoch']),
      quality: blocked['quality'],
      activeGenerations,
      generationBlocked: (generationId: string): boolean => {
        const indexes = attemptMembershipIndexes(generationId);
        return (segments as Buffer[]).some((segment) => indexes.every((index) =>
          (segment[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0));
      },
    };
  } catch {
    return null;
  }
}

interface ExactAttemptReceiptEvent {
  event: DispatchProductionEvent;
  fileDigest: string;
  retirementEpoch: number;
}

function exactAttemptReceiptEvent(
  generationId: string,
  ordinal: 1 | 2,
  protocol?: AttemptProtocolSnapshot,
): ExactAttemptReceiptEvent | null {
  const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  const snapshot = protocol ?? readAttemptProtocolSnapshot(attemptDir);
  if (!snapshot) return null;
  const admittedAt = snapshot.activeGenerations.get(generationId);
  if (admittedAt === undefined) return null;
  const exact = readPrivateFile(
    join(attemptDir, `${generationId}-${ordinal}.json`),
    MAX_ATTEMPT_ROW_BYTES,
  );
  if (!exact.ok || !exact.exists) return null;
  try {
    const text = exact.bytes.toString('utf8');
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return null;
    const line = text.slice(0, -1);
    const envelope = JSON.parse(line) as unknown;
    if (!isPlainRecord(envelope) || !hasOnlyKeys(envelope, new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) || envelope['receiptSchemaVersion'] !== 1 ||
      envelope['validation'] !== 'bounded-raw-history-v1' ||
      envelope['activationId'] !== snapshot.activationId ||
      !isPlainRecord(envelope['event']) || JSON.stringify(envelope) !== line) return null;
    const event = sanitizeDispatchProductionEvent(
      envelope['event'] as unknown as DispatchProductionEvent,
      { materializeLearningLabel: true },
    );
    if (JSON.stringify(event) !== JSON.stringify(envelope['event']) ||
      event.repairGenerationId !== generationId ||
      event.repairAttemptOrdinal !== ordinal ||
      Date.parse(event.ts) < Date.parse(admittedAt)) return null;
    return {
      event,
      fileDigest: digestBytes(exact.bytes),
      retirementEpoch: snapshot.retirementEpoch,
    };
  } catch {
    return null;
  }
}

function exactAttemptReceiptMatchesCapsule(
  bytes: Buffer,
  target: DispatchProductionAttemptProofTarget,
  receipt: GeneratedRepairDispatchProofReceipt,
  protocol: AttemptProtocolSnapshot,
): boolean {
  try {
    const text = bytes.toString('utf8');
    if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) return false;
    const line = text.slice(0, -1);
    const envelope = JSON.parse(line) as unknown;
    if (!isPlainRecord(envelope) || !hasOnlyKeys(envelope, new Set([
      'receiptSchemaVersion', 'validation', 'activationId', 'event',
    ])) || envelope['receiptSchemaVersion'] !== 1 ||
      envelope['validation'] !== 'bounded-raw-history-v1' ||
      envelope['activationId'] !== protocol.activationId ||
      !isPlainRecord(envelope['event']) || JSON.stringify(envelope) !== line) return false;
    const event = sanitizeDispatchProductionEvent(
      envelope['event'] as unknown as DispatchProductionEvent,
      { materializeLearningLabel: true },
    );
    if (JSON.stringify(event) !== JSON.stringify(envelope['event'])) return false;
    const admittedAt = protocol.activeGenerations.get(target.repairGenerationId);
    return admittedAt !== undefined &&
      Date.parse(event.ts) >= Date.parse(admittedAt) &&
      canonicalEventMatchesProofReceipt(event, target, receipt.proof);
  } catch {
    return false;
  }
}

function retainedAttemptGeneration(
  attemptDir: string,
  target: DispatchProductionAttemptProofTarget,
  receipt: GeneratedRepairDispatchProofReceipt,
  protocol: AttemptProtocolSnapshot,
): boolean {
  const retained = readPrivateFile(join(attemptDir, '.retention.json'), MAX_ATTEMPT_RETENTION_BYTES);
  if (!retained.ok || !retained.exists) return false;
  try {
    const marker = JSON.parse(retained.bytes.toString('utf8')) as unknown;
    if (!isPlainRecord(marker) || !hasOnlyKeys(marker, new Set([
      'schemaVersion', 'droppedThrough', 'retirementEpoch', 'pendingGenerations', 'pendingArtifacts',
    ])) || marker['schemaVersion'] !== 4 ||
      !canonicalUtcTimestamp(marker['droppedThrough']) ||
      !Number.isSafeInteger(marker['retirementEpoch']) || marker['retirementEpoch'] !== protocol.retirementEpoch ||
      !Array.isArray(marker['pendingGenerations']) || marker['pendingGenerations'].length > 2_048 ||
      marker['pendingGenerations'].some((generationId) =>
        typeof generationId !== 'string' || !SHA256_RE.test(generationId)) ||
      Date.parse(target.ts) > Date.parse(String(marker['droppedThrough'])) ||
      !Array.isArray(marker['pendingArtifacts']) || marker['pendingArtifacts'].length > 4_096) return false;
    const pendingGenerations = marker['pendingGenerations'] as string[];
    if (pendingGenerations.some((generationId, index) =>
      index > 0 && pendingGenerations[index - 1]! >= generationId)) return false;
    const artifacts: AttemptRetentionArtifact[] = [];
    const names = new Set<string>();
    const identities = new Set<string>();
    for (const value of marker['pendingArtifacts']) {
      if (!isPlainRecord(value) || !hasOnlyKeys(value, new Set([
        'name', 'generationId', 'ordinal', 'kind', 'eventTs', 'eventDigest', 'fileDigest',
      ])) || typeof value['name'] !== 'string' ||
        typeof value['generationId'] !== 'string' || !SHA256_RE.test(value['generationId']) ||
        (value['ordinal'] !== 1 && value['ordinal'] !== 2) ||
        (value['kind'] !== 'receipt' && value['kind'] !== 'intent') ||
        !canonicalUtcTimestamp(value['eventTs']) ||
        typeof value['eventDigest'] !== 'string' || !SHA256_RE.test(value['eventDigest']) ||
        typeof value['fileDigest'] !== 'string' || !SHA256_RE.test(value['fileDigest']) ||
        !pendingGenerations.includes(value['generationId'])) return false;
      const expectedName = value['kind'] === 'receipt'
        ? `${value['generationId']}-${value['ordinal']}.json`
        : `${value['generationId']}-${value['ordinal']}.intent.json`;
      const identity = `${value['generationId']}:${value['ordinal']}:${value['kind']}`;
      if (value['name'] !== expectedName || names.has(value['name']) || identities.has(identity)) return false;
      names.add(value['name']);
      identities.add(identity);
      artifacts.push(value as unknown as AttemptRetentionArtifact);
    }
    if (pendingGenerations.some((generationId) =>
      !artifacts.some((artifact) => artifact.generationId === generationId))) return false;
    const generationId = target.repairGenerationId;
    if (protocol.quality !== 'healthy' || protocol.activeGenerations.has(generationId) ||
      !protocol.generationBlocked(generationId) ||
      receipt.sourceReceiptFileDigest === undefined || receipt.sourceRetirementEpoch === undefined ||
      protocol.retirementEpoch <= receipt.sourceRetirementEpoch) return false;
    if (!pendingGenerations.includes(generationId)) {
      return artifacts.every((artifact) => artifact.generationId !== generationId);
    }
    const expectedName = `${generationId}-${target.repairAttemptOrdinal}.json`;
    return artifacts.some((artifact) =>
      artifact.name === expectedName &&
      artifact.generationId === generationId &&
      artifact.ordinal === target.repairAttemptOrdinal &&
      artifact.kind === 'receipt' &&
      artifact.eventTs === target.ts &&
      artifact.eventDigest === receipt.proof.eventDigest &&
      artifact.fileDigest === receipt.sourceReceiptFileDigest);
  } catch {
    return false;
  }
}

function sourceProofCompatibleWithCapsule(
  target: DispatchProductionAttemptProofTarget,
  receipt: GeneratedRepairDispatchProofReceipt,
): boolean {
  const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  const receiptName = `${target.repairGenerationId}-${target.repairAttemptOrdinal}`;
  const exact = readPrivateFile(join(attemptDir, `${receiptName}.json`), MAX_LEDGER_BYTES);
  const intent = readPrivateFile(join(attemptDir, `${receiptName}.intent.json`), MAX_LEDGER_BYTES);
  if (!exact.ok || !intent.ok || intent.exists) return false;
  const protocol = readAttemptProtocolSnapshot(attemptDir);
  if (!protocol) return false;
  // The immutable receipt is authority. Raw analytics resolution is only a
  // compatibility path for lifecycle capsules minted before receipt retention.
  if (exact.exists) {
    const exactValid = receipt.sourceReceiptFileDigest !== undefined &&
      receipt.sourceRetirementEpoch !== undefined &&
      protocol.retirementEpoch >= receipt.sourceRetirementEpoch &&
      digestBytes(exact.bytes) === receipt.sourceReceiptFileDigest &&
      exactAttemptReceiptMatchesCapsule(exact.bytes, target, receipt, protocol);
    if (!exactValid) return false;
    // Ordinal two is sequence-validated by the lifecycle, including exact
    // alias-family failed predecessors. Ordinal one still asks the receipt
    // resolver to reject a conflicting immutable successor.
    if (target.repairAttemptOrdinal === 2) return true;
  }
  const resolved = resolveDispatchProductionAttemptReceiptWitnesses([{
    repairGenerationId: target.repairGenerationId,
    repairAttemptOrdinal: target.repairAttemptOrdinal,
  }]);
  if (resolved.status !== 'resolved' || resolved.resolutions.length !== 1) return false;
  const resolution = resolved.resolutions[0]!;
  if (resolution.status === 'proven') {
    return sameAttemptProof(resolution.proof, receipt.proof) &&
      canonicalEventMatchesProofReceipt(resolution.event, target, receipt.proof);
  }
  if (
    resolution.status !== 'missing' &&
    !(resolution.status === 'degraded' && (
      resolution.reason === 'source-unavailable' ||
      resolution.reason === 'date-limit' ||
      resolution.reason === 'partition-byte-limit' ||
      resolution.reason === 'partition-row-limit'
    ))
  ) return false;
  if (exact.exists) return true;
  const capsule = publicationEventFromReceipt(receipt);
  const retained = capsule !== null &&
    attemptProofTargetDigest(capsule.target) === attemptProofTargetDigest(target) &&
    retainedAttemptGeneration(attemptDir, target, receipt, protocol);
  return retained;
}

function validAttemptProofSequence(proofs: readonly DispatchProductionAttemptProof[]): boolean {
  if (proofs.length === 0 || proofs.length > 2) return false;
  const first = proofs[0]!;
  if (first.repairAttemptOrdinal !== 1 || first.previousBackend !== null) return false;
  if (proofs.length === 1) return true;
  const second = proofs[1]!;
  return second.repairAttemptOrdinal === 2 &&
    Date.parse(first.eventTs) < Date.parse(second.eventTs) &&
    first.attemptHash !== second.attemptHash &&
    first.backend !== second.backend &&
    first.tier === second.tier &&
    second.previousBackend === first.backend;
}

const DIAGNOSTIC_FAILURE_OUTCOMES = new Set<DispatchProductionEvent['outcome']>([
  'engine-failed', 'sandbox-failed', 'proposal-capture-error', 'gate-blocked',
]);

function diagnosticFailurePredecessorProof(
  item: WorkItem,
  second: DispatchProductionAttemptProof,
  authority: HandoffAuthoritySnapshot,
): GeneratedRepairDispatchAttemptWitness | null {
  if (
    second.repairAttemptOrdinal !== 2 ||
    second.previousBackend === null ||
    typeof item.repairRootId !== 'string' ||
    !SHA256_RE.test(item.repairRootId) ||
    (item.repairDepth !== 0 && item.repairDepth !== 1)
  ) return null;
  const secondHandoff = authority.byEventId.get(second.repairHandoffId);
  if (!secondHandoff || secondHandoff.generationId !== second.repairGenerationId) return null;
  const generationIds = authority.exactParentRowGenerationsByEventId.get(secondHandoff.eventId) ?? [];
  if (!generationIds.includes(second.repairGenerationId)) return null;
  const resolved = readDispatchProductionFailureAttemptReceipts(generationIds);
  if (resolved.status !== 'resolved' || !resolved.authoritative) return null;
  const ordinalOne = resolved.receipts.filter(({ proof }) =>
    generationIds.includes(proof.repairGenerationId) &&
    proof.repairAttemptOrdinal === 1);
  if (ordinalOne.length !== 1) return null;
  const { proof, event } = ordinalOne[0]!;
  const predecessorHandoff = authority.byEventId.get(proof.repairHandoffId);
  if (
    !predecessorHandoff ||
    predecessorHandoff.generationId !== proof.repairGenerationId ||
    !generationIds.includes(predecessorHandoff.generationId) ||
    proof.repairTreatmentUnitId !== second.repairTreatmentUnitId ||
    proof.repairTreatment !== second.repairTreatment
  ) return null;
  const predecessor: DispatchProductionAttemptProof = {
    ...proof,
    repairTreatmentUnitId: proof.repairTreatmentUnitId,
    repairTreatment: proof.repairTreatment,
  };
  const objectiveHash = workItemObjectiveHash(item);
  let repo: string;
  let eventRepo: string;
  try {
    repo = resolve(item.repo);
    eventRepo = resolve(event.repo);
  } catch { return null; }
  if (
    !objectiveHash ||
    event.itemId !== item.id ||
    eventRepo !== repo ||
    event.source !== item.source ||
    event.objectiveHash !== objectiveHash ||
    event.proposalCreated !== false ||
    event.proposalId !== undefined ||
    !DIAGNOSTIC_FAILURE_OUTCOMES.has(event.outcome) ||
    event.trajectoryId === undefined ||
    generatedRepairLifecycleAttemptHash(event.trajectoryId) !== predecessor.attemptHash ||
    event.repairHandoffId !== proof.repairHandoffId ||
    event.repairGenerationId !== proof.repairGenerationId ||
    event.repairTreatmentUnitId !== second.repairTreatmentUnitId ||
    event.repairTreatment !== second.repairTreatment ||
    event.repairAttemptOrdinal !== 1 ||
    event.repairPreviousBackend !== undefined ||
    event.repairRootId !== item.repairRootId ||
    event.repairDepth !== item.repairDepth ||
    !validAttemptProofSequence([predecessor, second])
  ) return null;
  return { proof: predecessor, event: structuredClone(event) };
}

function validDiagnosticTreatmentProofSequence(
  item: WorkItem,
  proofs: readonly DispatchProductionAttemptProof[],
  authority: HandoffAuthoritySnapshot,
): boolean {
  return validAttemptProofSequence(proofs) || (
    proofs.length === 1 && diagnosticFailurePredecessorProof(item, proofs[0]!, authority) !== null
  );
}

function exactDiagnosticAttemptReceiptWitness(
  target: DispatchProductionAttemptProofTarget,
  exactReceipt?: ExactAttemptReceiptEvent,
): GeneratedRepairDispatchAttemptWitness | null {
  const exact = exactReceipt ?? exactAttemptReceiptEvent(
    target.repairGenerationId,
    target.repairAttemptOrdinal,
  );
  if (!exact) return null;
  const event = exact.event;
  if (!event.trajectoryId || event.backend === null || event.backend === 'builtin' ||
    event.tier === null || !event.repairHandoffId || !event.repairGenerationId ||
    !event.repairTreatmentUnitId || !event.repairTreatment ||
    event.repairAttemptOrdinal === undefined) return null;
  const proof: DispatchProductionAttemptProof = {
    schemaVersion: 1,
    integrityClass: 'owner-writable-local',
    cryptographicallyTrusted: false,
    rollbackProtected: false,
    eventTs: event.ts,
    eventDigest: digestBytes(Buffer.from(JSON.stringify(event), 'utf8')),
    attemptHash: generatedRepairLifecycleAttemptHash(event.trajectoryId),
    backend: event.backend,
    tier: event.tier,
    model: event.model ?? null,
    previousBackend: event.repairAttemptOrdinal === 2
      ? event.repairPreviousBackend as Exclude<EngineId, 'builtin'>
      : null,
    repairHandoffId: event.repairHandoffId,
    repairGenerationId: event.repairGenerationId,
    repairTreatmentUnitId: event.repairTreatmentUnitId,
    repairTreatment: event.repairTreatment,
    repairAttemptOrdinal: event.repairAttemptOrdinal,
  };
  return canonicalEventMatchesProofReceipt(event, target, proof)
    ? { proof, event }
    : null;
}

function resolveDiagnosticLifecycleAttemptWitness(
  item: WorkItem,
  eventTs: string,
  outcome: DispatchProductionAttemptProofTarget['outcome'],
  proposalId: string | undefined,
  authority: HandoffAuthoritySnapshot,
  priorReceipts: readonly GeneratedRepairDispatchProofReceipt[],
): { target: DispatchProductionAttemptProofTarget; witness: GeneratedRepairDispatchAttemptWitness } | null {
  if (authority.sourceState === 'degraded') return null;
  const generationIds = generatedRepairGenerationIdsFromAuthority(item, authority);
  if (generationIds.length === 0 || generationIds.length > MAX_HANDOFF_ALIAS_GENERATIONS) return null;
  const ordinals: Array<1 | 2> = priorReceipts.length === 0
    ? [1, 2]
    : priorReceipts.length === 1
      ? [2]
      : [];
  const attemptDir = join(dispatchProductionDir(), 'repair-attempt-proofs');
  const protocol = readAttemptProtocolSnapshot(attemptDir);
  const candidates: Array<{
    target: DispatchProductionAttemptProofTarget;
    witness: GeneratedRepairDispatchAttemptWitness;
  }> = [];
  for (const generationId of generationIds) {
    for (const ordinal of ordinals) {
      const target = diagnosticAttemptProofTarget(
        item,
        eventTs,
        ordinal,
        authority,
        outcome,
        proposalId,
        generationId,
      );
      if (!target) return null;
      const receiptPath = join(attemptDir, `${generationId}-${ordinal}.json`);
      const intentPath = join(attemptDir, `${generationId}-${ordinal}.intent.json`);
      const receiptRead = readPrivateFile(receiptPath, MAX_ATTEMPT_ROW_BYTES);
      const intentRead = readPrivateFile(intentPath, MAX_ATTEMPT_ROW_BYTES);
      if (!receiptRead.ok || !intentRead.ok || intentRead.exists) return null;
      let witness: GeneratedRepairDispatchAttemptWitness | undefined;
      if (receiptRead.exists) {
        if (!protocol) return null;
        const exact = exactAttemptReceiptEvent(generationId, ordinal, protocol);
        if (!exact || digestBytes(receiptRead.bytes) !== exact.fileDigest) return null;
        const exactWitness = exactDiagnosticAttemptReceiptWitness(target, exact);
        if (!exactWitness) return null;
        witness = exactWitness;
      } else {
        witness = resolveProvenAttemptProofs([target])?.[0];
      }
      if (!witness) continue;
      if (!validDiagnosticTreatmentProofSequence(
        item,
        [...priorReceipts.map((receipt) => receipt.proof), witness.proof],
        authority,
      )) return null;
      candidates.push({ target, witness });
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

function revalidateDiagnosticAttemptProofs(
  item: WorkItem,
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
): GeneratedRepairDispatchAttemptWitness[] | null {
  if (record.emptyAttemptHashes.length === 0) return [];
  const receipts = record.emptyAttemptProofReceipts;
  if (
    receipts?.length !== record.emptyAttemptHashes.length ||
    record.emptyAttemptBackends?.length !== receipts.length ||
    record.emptyAttemptTiers?.length !== receipts.length
  ) return null;
  for (let index = 0; index < receipts.length; index++) {
    const receipt = receipts[index]!;
    const capsule = publicationEventFromReceipt(receipt);
    const target = diagnosticAttemptProofTarget(
      item,
      receipt.proof.eventTs,
      receipt.proof.repairAttemptOrdinal,
      authority,
      'empty-diff',
      undefined,
      receipt.proof.repairGenerationId,
      capsule?.target.objectiveHash,
    );
    if (
      !target ||
      !durableReceiptMatchesTarget(receipt, target) ||
      !sourceProofCompatibleWithCapsule(target, receipt)
    ) return null;
  }
  const proofs = receipts.map((receipt) => receipt.proof);
  if (!validDiagnosticTreatmentProofSequence(item, proofs, authority)) return null;
  for (let index = 0; index < proofs.length; index++) {
    const proof = proofs[index]!;
    const receipt = receipts[index]!;
    if (
      !sameAttemptProof(proof, receipt.proof) ||
      proof.attemptHash !== record.emptyAttemptHashes[index] ||
      proof.backend !== record.emptyAttemptBackends[index] ||
      proof.tier !== record.emptyAttemptTiers[index]
    ) return null;
  }
  return receipts.map((receipt) => {
    const capsule = publicationEventFromReceipt(receipt);
    return {
      proof: structuredClone(receipt.proof),
      ...(capsule ? { event: capsule.event } : {}),
    };
  });
}

function revalidateDiagnosticTerminalProof(
  item: WorkItem,
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
): GeneratedRepairDispatchAttemptWitness | null {
  const receipt = record.terminalAttemptProofReceipt;
  if (
    record.disposition === 'active' ||
    !receipt ||
    record.terminalAttemptHash !== receipt.proof.attemptHash
  ) return null;
  const outcome = record.disposition === 'retired' ? 'proposal-created' : 'empty-diff';
  const capsule = publicationEventFromReceipt(receipt);
  if (!capsule || capsule.target.outcome !== outcome) return null;
  const terminalTarget = diagnosticAttemptProofTarget(
    item,
    receipt.proof.eventTs,
    receipt.proof.repairAttemptOrdinal,
    authority,
    outcome,
    outcome === 'proposal-created' ? capsule.event.proposalId : undefined,
    receipt.proof.repairGenerationId,
    capsule.target.objectiveHash,
  );
  if (
    !terminalTarget ||
    !durableReceiptMatchesTarget(receipt, terminalTarget) ||
    !sourceProofCompatibleWithCapsule(terminalTarget, receipt) ||
    attemptProofTargetDigest(capsule.target) !== attemptProofTargetDigest(terminalTarget)
  ) return null;
  const terminalAlreadyIncluded = record.emptyAttemptProofReceipts?.some((prior) =>
    sameAttemptProof(prior.proof, receipt.proof)) ?? false;
  const proofReceipts = terminalAlreadyIncluded
    ? record.emptyAttemptProofReceipts!
    : [...record.emptyAttemptProofReceipts ?? [], receipt];
  const proofs = proofReceipts.map((candidate) => candidate.proof);
  if (!validDiagnosticTreatmentProofSequence(item, proofs, authority)) return null;
  for (let index = 0; index < (record.emptyAttemptProofReceipts?.length ?? 0); index++) {
    if (!sameAttemptProof(proofs[index]!, record.emptyAttemptProofReceipts![index]!.proof)) return null;
  }
  const terminalWitness: GeneratedRepairDispatchAttemptWitness = {
    proof: structuredClone(receipt.proof),
    event: capsule.event,
  };
  if (
    !sameAttemptProof(terminalWitness.proof, receipt.proof) ||
    !rebuiltProofCandidate(capsule.event, terminalTarget, receipt.proof)
  ) return null;
  return terminalWitness;
}

/** Read one immutable generation; callers block dispatch when availability is false. */
export function readGeneratedRepairLifecycle(item: WorkItem): GeneratedRepairLifecycleResult {
  const authority = handoffAuthoritySnapshot();
  const recoveryRequired = existsSync(lifecycleFailurePath());
  const loaded = loadStableReadableLedger();
  if (!loaded.ok) {
    return recoveryRequired ? {
      available: false,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      unavailableReason: 'storage-recovery-required',
      requiredAction: 'operator-reset',
    } : { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  }
  return readGeneratedRepairLifecycleFromSources(item, authority, loaded);
}

function readGeneratedRepairLifecycleFromSources(
  item: WorkItem,
  authority: HandoffAuthoritySnapshot,
  loaded: ReturnType<typeof loadLedger>,
  recordsByGeneration?: ReadonlyMap<string, GeneratedRepairLifecycleRecord>,
  resolvedGenerationIds?: readonly string[],
): GeneratedRepairLifecycleResult {
  const id = generatedRepairGenerationIdFromAuthority(item, authority);
  if (!id || !loaded.ok) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  const generationIds = resolvedGenerationIds ?? generatedRepairGenerationIdsFromAuthority(item, authority);
  const selectedIds = new Set(generationIds);
  const selectedRecords = recordsByGeneration
    ? generationIds.flatMap((generationId) => {
      const record = recordsByGeneration.get(generationId);
      return record ? [record] : [];
    })
    : loaded.ledger.records.filter((record) => selectedIds.has(record.generationId));
  const merged = mergedLifecycleRecord(id, generationIds, selectedRecords);
  if (!merged.ok) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  const record = merged.record;
  if (!record && itemIntersectsLifecycleRetention(item, loaded.ledger)) {
    return retentionDegradedResult();
  }
  const diagnostic = isTrustedDiagnosticResliceItem(item);
  if (record && !proposalAuthorityStillValid(record)) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  }
  const hasPublishedMarker = Boolean(record?.treatmentWitnessRecordedAt && record.treatmentWitnessDigest);
  const publishedTombstone = Boolean(record && hasPublishedMarker &&
    hasExactPublishedTreatmentReceipt(record, authority));
  if (record && hasPublishedMarker && !publishedTombstone) return prooflessLegacyResult();
  const diagnosticWitnesses = record && diagnostic && !publishedTombstone
    ? revalidateDiagnosticAttemptProofs(item, record, authority)
    : [];
  const diagnosticProofs = diagnosticWitnesses?.map((witness) => witness.proof) ?? null;
  if (diagnosticProofs === null || (
    !publishedTombstone && record?.disposition === 'quarantined' &&
    !hasObjectiveSaturationProof(item, diagnosticProofs, authority)
  )) return record && diagnostic && hasProoflessDiagnosticEvidence(record)
    ? prooflessLegacyResult()
    : { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  if (record && diagnostic && !publishedTombstone && record.disposition !== 'active' &&
    !revalidateDiagnosticTerminalProof(item, record, authority)) {
    return hasProoflessDiagnosticEvidence(record)
      ? prooflessLegacyResult()
      : { available: false, disposition: 'active', authoritativeEmptyRuns: 0 };
  }
  return resultFromRecord(true, record);
}

function dispatchStateForLifecycle(
  item: WorkItem,
  lifecycle: GeneratedRepairLifecycleResult,
): GeneratedRepairDispatchState {
  if (!isTrustedGeneratedRepairItem(item)) {
    if (item.tags.includes('proposal-repair')) {
      return { applies: true, state: 'lifecycle-unavailable', dispatchable: false };
    }
    return { applies: false, state: 'not-applicable', dispatchable: true };
  }
  if (!lifecycle.available) {
    return { applies: true, state: 'lifecycle-unavailable', dispatchable: false };
  }
  if (lifecycle.disposition === 'active') {
    return { applies: true, state: 'active', dispatchable: true, disposition: 'active' };
  }
  return {
    applies: true,
    state: 'terminal',
    dispatchable: false,
    disposition: lifecycle.disposition,
  };
}

/** Project durable generated-repair lifecycle authority into dispatch eligibility. */
export function generatedRepairDispatchState(item: WorkItem): GeneratedRepairDispatchState {
  return dispatchStateForLifecycle(item, readGeneratedRepairLifecycle(item));
}

export interface GeneratedRepairQueueReaderSnapshot {
  dispatchState(item: WorkItem): GeneratedRepairDispatchState;
  retryPolicy(item: WorkItem): GeneratedRepairRetryPolicy;
  cooldownKeys(item: WorkItem): string[];
}

function retryPolicyFromLifecycle(
  item: WorkItem,
  lifecycle: GeneratedRepairLifecycleResult,
): GeneratedRepairRetryPolicy {
  if (!isTrustedGeneratedRepairItem(item)) {
    return {
      applies: false,
      available: true,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: null,
    };
  }
  if (!lifecycle.available || lifecycle.disposition !== 'active') {
    return {
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: null,
    };
  }
  const requireAlternative = lifecycle.authoritativeEmptyRuns >= 1;
  const excludedBackend = lifecycle.lastAuthoritativeEmptyBackend ?? null;
  const requiredTier = lifecycle.authoritativeEmptyTiers?.[0] ?? null;
  return {
    applies: true,
    available: !requireAlternative || (excludedBackend !== null && requiredTier !== null),
    requireAlternative,
    excludedBackend: requireAlternative ? excludedBackend : null,
    requiredTier: requireAlternative ? requiredTier : null,
  };
}

/** Point-in-time queue authority; first rolls back any interrupted lifecycle write. */
export function readGeneratedRepairQueueSnapshot(): GeneratedRepairQueueReaderSnapshot {
  const authority = handoffAuthoritySnapshot();
  const loaded = loadStableReadableLedger();
  const recordsByGeneration = new Map(
    loaded.ok ? loaded.ledger.records.map((record) => [record.generationId, record] as const) : [],
  );
  const generationIdsByItem = new Map<WorkItem, string[]>();
  const lifecycleByItem = new Map<WorkItem, GeneratedRepairLifecycleResult>();
  const generationIdsFor = (item: WorkItem): string[] => {
    const cached = generationIdsByItem.get(item);
    if (cached) return cached;
    const generationIds = generatedRepairGenerationIdsFromAuthority(item, authority);
    generationIdsByItem.set(item, generationIds);
    return generationIds;
  };
  const lifecycleFor = (item: WorkItem): GeneratedRepairLifecycleResult => {
    let lifecycle = lifecycleByItem.get(item);
    if (!lifecycle) {
      lifecycle = readGeneratedRepairLifecycleFromSources(
        item,
        authority,
        loaded,
        recordsByGeneration,
        generationIdsFor(item),
      );
      lifecycleByItem.set(item, lifecycle);
    }
    return lifecycle;
  };
  return {
    dispatchState(item) {
      return dispatchStateForLifecycle(item, lifecycleFor(item));
    },
    retryPolicy(item) {
      return retryPolicyFromLifecycle(item, lifecycleFor(item));
    },
    cooldownKeys(item) {
      const generations = generationIdsFor(item);
      if (generations.length === 0) return [item.id];
      const generationKeys = generations.map((generationId) => `${item.id}::generation:${generationId}`);
      return item.repairHandoffId === undefined && item.repairGenerationId === undefined
        ? [item.id, ...generationKeys]
        : generationKeys;
    },
  };
}

/** Derive backend retry constraints from durable evidence for every trusted repair. */
export function generatedRepairRetryPolicy(item: WorkItem): GeneratedRepairRetryPolicy {
  if (!isTrustedGeneratedRepairItem(item)) {
    return retryPolicyFromLifecycle(item, {
      available: true,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
    });
  }
  if (generatedRepairGenerationId(item) === null) {
    return {
      applies: true,
      available: false,
      requireAlternative: false,
      excludedBackend: null,
      requiredTier: null,
    };
  }
  return retryPolicyFromLifecycle(item, readGeneratedRepairLifecycle(item));
}

export function generatedRepairBackendAllowed(item: WorkItem, backend: EngineId): boolean {
  const policy = generatedRepairRetryPolicy(item);
  if (!policy.applies) return true;
  if (!policy.available) return false;
  return !policy.requireAlternative || (
    policy.excludedBackend !== null && backend !== policy.excludedBackend
  );
}

/** Snapshot metadata-only retry lineage before the current dispatch transition is recorded. */
export function generatedRepairDispatchLineage(
  item: WorkItem,
  backend: EngineId | null,
): GeneratedRepairDispatchLineage | null {
  if (!isTrustedDiagnosticResliceItem(item) || backend === null) return null;
  const generationId = generatedRepairGenerationId(item);
  if (
    generationId === null ||
    typeof item.repairHandoffId !== 'string' ||
    item.repairGenerationId !== generationId
  ) return null;
  const lifecycle = readGeneratedRepairLifecycle(item);
  if (!lifecycle.available) return null;
  const backends = lifecycle.authoritativeEmptyBackends;
  if (lifecycle.authoritativeEmptyRuns > 0 && backends === undefined) return null;
  const previousBackend = backends?.at(-1);
  const treatmentUnitId = item.repairTreatmentUnitId ?? (
    item.repairParentItemId && item.repairParentObjectiveHash
      ? repairTreatmentUnitId({
          kind: 'no-diff-reslice',
          repo: item.repo,
          parentItemId: item.repairParentItemId,
          parentObjectiveHash: item.repairParentObjectiveHash,
        })
      : null
  );
  const treatment = treatmentUnitId ? repairTreatmentForUnitId(treatmentUnitId) : null;
  if (!treatmentUnitId || !treatment) return null;
  return {
    repairHandoffId: item.repairHandoffId,
    repairGenerationId: generationId,
    repairTreatmentUnitId: treatmentUnitId,
    repairTreatment: treatment,
    repairAttemptOrdinal: previousBackend ? 2 : 1,
    ...(previousBackend ? { repairPreviousBackend: previousBackend } : {}),
  };
}

/**
 * Record a typed local-daemon transition. Terminal states are absorbing and
 * duplicate attempt ids are idempotent. Callers must independently verify that
 * proposal-created evidence exists durably in the inbox.
 */
export function recordGeneratedRepairLifecycle(
  item: WorkItem,
  evidence: GeneratedRepairLifecycleEvidence,
): GeneratedRepairLifecycleTransitionResult {
  if (evidence.kind === 'non-terminal') {
    return {
      available: generatedRepairGenerationId(item) !== null,
      disposition: 'active',
      authoritativeEmptyRuns: 0,
      recorded: false,
    };
  }
  const diagnostic = isTrustedDiagnosticResliceItem(item);
  if (
    (diagnostic && evidence.kind === 'empty-diff') ||
    (!diagnostic && evidence.kind === 'dispatch-proof-empty-diff') ||
    (evidence.kind === 'dispatch-proof-empty-diff' && !canonicalUtcTimestamp(evidence.eventTs)) ||
    (diagnostic && evidence.kind === 'proposal-created' && !canonicalUtcTimestamp(evidence.ts))
  ) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (
    (evidence.kind === 'proposal-created' || evidence.kind === 'empty-diff') &&
    !isLifecycleAttemptIdentity(evidence.attemptId)
  ) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (evidence.kind === 'proposal-created' && !isSafeExecutionIdentity(evidence.proposalId)) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (evidence.kind === 'empty-diff' && (
    !ENGINE_IDS.has(evidence.backend) ||
    evidence.backend === 'builtin' ||
    (evidence.tier !== 'local' && evidence.tier !== 'mid' && evidence.tier !== 'frontier')
  )) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const lock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lock) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  try {
    lifecycleAdmissionTraceHookForTest?.('lifecycle-lock');
    if (!recoverLifecycleWriteFailureUnlocked()) {
      return {
        available: false,
        disposition: 'active',
        authoritativeEmptyRuns: 0,
        unavailableReason: 'storage-recovery-required',
        requiredAction: 'operator-reset',
        recorded: false,
      };
    }
    const authority = handoffAuthoritySnapshot();
    const id = generatedRepairGenerationIdFromAuthority(item, authority);
    if (!id) {
      return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
    }
    lifecycleAdmissionTraceHookForTest?.('handoff-authority');
    const generationIds = generatedRepairGenerationIdsFromAuthority(item, authority);
    const transition = withDispatchProductionAliasFamilyAuthority(generationIds, () => {
      lifecycleAdmissionTraceHookForTest?.('generation-authority');
      const record = () => recordGeneratedRepairLifecycleUnlocked(
        item,
        id,
        generationIds,
        evidence,
        authority,
      );
      if (evidence.kind !== 'proposal-created') return record();
      const fenced = withProposalStoreAuthority(() => {
        lifecycleAdmissionTraceHookForTest?.('proposal-store-authority');
        return record();
      });
      return fenced.ok
        ? fenced.value
        : {
            available: false,
            disposition: 'active',
            authoritativeEmptyRuns: 0,
            recorded: false,
          } satisfies GeneratedRepairLifecycleTransitionResult;
    });
    return transition.ok
      ? transition.value
      : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function withDispatchProductionAliasFamilyAuthority<T>(
  generationIds: readonly string[],
  consume: () => T,
): { ok: true; value: T } | { ok: false } {
  const ordered = [...new Set(generationIds)].sort();
  if (ordered.length === 0 || ordered.length > MAX_HANDOFF_ALIAS_GENERATIONS) {
    return { ok: false };
  }
  const acquire = (index: number): { ok: true; value: T } | { ok: false } => {
    if (index === ordered.length) return { ok: true, value: consume() };
    const nested = withDispatchProductionGenerationAuthority(
      ordered[index]!,
      () => acquire(index + 1),
    );
    return nested.ok ? nested.value : { ok: false };
  };
  return acquire(0);
}

function rebuiltTreatmentCandidate(
  item: WorkItem,
  candidate: DispatchProductionEvent,
  target: DispatchProductionAttemptProofTarget,
  proof: DispatchProductionAttemptProof,
  canonicalEvent?: DispatchProductionEvent,
  canonicalEventDigestBound = true,
): DispatchProductionEvent | null {
  if (!treatmentCandidateMatchesProof(candidate, target, proof, true)) return null;
  if (canonicalEvent && canonicalEventDigestBound && createHash('sha256')
    .update(JSON.stringify(canonicalEvent), 'utf8')
    .digest('hex') !== proof.eventDigest) return null;
  const rebuilt = structuredClone(canonicalEvent ?? candidate);
  rebuilt.ts = proof.eventTs;
  rebuilt.itemId = target.itemId;
  rebuilt.repo = target.repo;
  rebuilt.source = target.source;
  rebuilt.title = item.title;
  rebuilt.backend = proof.backend;
  rebuilt.tier = proof.tier;
  rebuilt.model = proof.model;
  rebuilt.outcome = target.outcome;
  rebuilt.proposalCreated = target.outcome === 'proposal-created';
  if (target.outcome === 'proposal-created') rebuilt.proposalId = target.proposalId!;
  else delete rebuilt.proposalId;
  rebuilt.objectiveHash = target.objectiveHash;
  rebuilt.basis = 'repair-lifecycle-candidate';
  rebuilt.repairHandoffId = proof.repairHandoffId;
  rebuilt.repairGenerationId = proof.repairGenerationId;
  rebuilt.repairTreatmentUnitId = proof.repairTreatmentUnitId;
  rebuilt.repairTreatment = proof.repairTreatment;
  rebuilt.repairTreatmentAttemptHash = proof.attemptHash;
  rebuilt.repairAttemptOrdinal = proof.repairAttemptOrdinal;
  delete rebuilt.repairTreatmentOutcome;
  delete rebuilt.repairLineageInvalid;
  if (proof.repairAttemptOrdinal === 1) delete rebuilt.repairPreviousBackend;
  else rebuilt.repairPreviousBackend = proof.previousBackend!;
  if (rebuilt.routeSnapshot) {
    rebuilt.routeSnapshot.backend = proof.backend;
    rebuilt.routeSnapshot.tier = proof.tier;
    rebuilt.routeSnapshot.model = proof.model;
  }
  return treatmentCandidateMatchesProof(rebuilt, target, proof, false) ? rebuilt : null;
}

function hasObjectiveSaturationProof(
  item: WorkItem,
  childProofs: readonly DispatchProductionAttemptProof[],
  authority = handoffAuthoritySnapshot(),
): boolean {
  if (
    !isTrustedDiagnosticResliceItem(item) ||
    typeof item.repairHandoffId !== 'string' ||
    childProofs.length !== 2 ||
    !validAttemptProofSequence(childProofs)
  ) return false;
  if (authority.sourceState === 'degraded') return false;
  const parent = authority.byEventId.get(item.repairHandoffId);
  if (
    !parent ||
    parent.kind !== 'no-diff-reslice' ||
    parent.parentOutcome !== 'empty-diff' ||
    parent.generationId !== item.repairGenerationId ||
    parent.childItemId !== item.id ||
    parent.parentObjectiveHash !== item.repairParentObjectiveHash ||
    parent.parentBackend === null ||
    parent.parentBackend === 'builtin' ||
    parent.parentTier === null ||
    childProofs.some((proof) => {
      const proofHandoff = authority.byEventId.get(proof.repairHandoffId);
      return !proofHandoff ||
        proofHandoff.generationId !== proof.repairGenerationId ||
        exactParentRowAliasObservation(authority, parent, proof.repairGenerationId)?.eventId !==
          proof.repairHandoffId ||
        proof.repairTreatmentUnitId !== proofHandoff.repairTreatmentUnitId ||
        proof.repairTreatment !== proofHandoff.repairTreatment ||
        proof.tier !== parent.parentTier;
    }) ||
    Date.parse(parent.ts) >= Date.parse(childProofs[0]!.eventTs)
  ) return false;
  const parentAttemptHash = generatedRepairLifecycleAttemptHash(parent.parentAttemptId);
  if (new Set([parentAttemptHash, ...childProofs.map((proof) => proof.attemptHash)]).size !== 3) return false;
  return new Set([parent.parentBackend, ...childProofs.map((proof) => proof.backend)]).size >= 2;
}

function recordGeneratedRepairLifecycleUnlocked(
  item: WorkItem,
  id: string,
  generationIds: readonly string[],
  evidence: Exclude<GeneratedRepairLifecycleEvidence, { kind: 'non-terminal' }>,
  authority: HandoffAuthoritySnapshot,
): GeneratedRepairLifecycleTransitionResult {
  const diagnostic = isTrustedDiagnosticResliceItem(item);
  const durableProposal = evidence.kind === 'proposal-created'
    ? durableProposalAuthority(item, generationIds, evidence)
    : null;
  lifecycleAdmissionTraceHookForTest?.(
    durableProposal === null ? 'durable-proposal-missing' : 'durable-proposal',
  );
  const exactOrdinaryAttempt = evidence.kind === 'proposal-created' && !diagnostic && durableProposal
    ? exactOrdinaryProposalAttempt(item, generationIds, evidence, durableProposal.proposal, authority)
    : null;
  if (evidence.kind === 'proposal-created' && (
    durableProposal === null || (!diagnostic && exactOrdinaryAttempt === null)
  )) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (exactOrdinaryAttempt) {
    lifecycleRaceHooksForTest?.ordinaryProposalAuthorityValidated?.();
  }
  const loaded = loadLedger();
  if (!loaded.ok) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const merged = mergedLifecycleRecord(id, generationIds, loaded.ledger.records);
  if (!merged.ok) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const existing = merged.record;
  if (!existing && itemIntersectsLifecycleRetention(item, loaded.ledger)) {
    return { ...retentionDegradedResult(), recorded: false };
  }
  if (existing && !proposalAuthorityStillValid(existing)) {
    return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  const hasPublishedMarker = Boolean(existing?.treatmentWitnessRecordedAt && existing.treatmentWitnessDigest);
  const publishedTombstone = Boolean(existing && hasPublishedMarker &&
    hasExactPublishedTreatmentReceipt(existing, authority));
  if (existing && hasPublishedMarker && !publishedTombstone) {
    return { ...prooflessLegacyResult(), recorded: false };
  }
  if (publishedTombstone && existing && existing.disposition !== 'active') {
    return { ...resultFromRecord(true, existing), recorded: false };
  }
  const diagnosticWitnesses = existing && isTrustedDiagnosticResliceItem(item)
    ? revalidateDiagnosticAttemptProofs(item, existing, authority)
    : [];
  const diagnosticProofs = diagnosticWitnesses?.map((witness) => witness.proof) ?? null;
  if (diagnosticProofs === null || (
    existing?.disposition === 'quarantined' &&
    !hasObjectiveSaturationProof(item, diagnosticProofs, authority)
  )) return existing && diagnostic && hasProoflessDiagnosticEvidence(existing)
    ? { ...prooflessLegacyResult(), recorded: false }
    : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  const diagnosticTerminalWitness = existing && diagnostic && existing.disposition !== 'active'
    ? revalidateDiagnosticTerminalProof(item, existing, authority)
    : undefined;
  if (diagnosticTerminalWitness === null) {
    return hasProoflessDiagnosticEvidence(existing!)
      ? { ...prooflessLegacyResult(), recorded: false }
      : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
  }
  if (existing?.disposition === 'retired' || existing?.disposition === 'exhausted' || existing?.disposition === 'quarantined') {
    if (evidence.kind === 'dispatch-proof-empty-diff') {
      const terminalWitness = diagnosticWitnesses?.at(-1);
      const terminalProof = terminalWitness?.proof;
      const target = terminalProof
        ? diagnosticAttemptProofTarget(
            item,
            terminalProof.eventTs,
            terminalProof.repairAttemptOrdinal,
            authority,
            'empty-diff',
            undefined,
            terminalProof.repairGenerationId,
          )
        : null;
      if (
        !terminalProof ||
        !target ||
        existing.terminalAttemptHash !== terminalProof.attemptHash ||
        evidence.eventTs !== terminalProof.eventTs ||
        (evidence.treatmentCandidate && !rebuiltTreatmentCandidate(
          item,
          evidence.treatmentCandidate,
          target,
          terminalProof,
          terminalWitness.event!,
          false,
        ))
      ) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
    } else if (diagnostic && evidence.kind === 'proposal-created') {
      const receipt = existing.terminalAttemptProofReceipt;
      const capsule = receipt ? publicationEventFromReceipt(receipt) : null;
      const target = receipt && capsule
        ? diagnosticAttemptProofTarget(
            item,
            receipt.proof.eventTs,
            receipt.proof.repairAttemptOrdinal,
            authority,
            'proposal-created',
            capsule.event.proposalId,
            receipt.proof.repairGenerationId,
          )
        : null;
      if (
        existing.disposition !== 'retired' ||
        !receipt ||
        !capsule ||
        !target ||
        evidence.ts !== receipt.proof.eventTs ||
        generatedRepairLifecycleAttemptHash(evidence.attemptId) !== receipt.proof.attemptHash ||
        evidence.proposalId !== capsule.event.proposalId ||
        !diagnosticTerminalWitness ||
        (evidence.treatmentCandidate && !rebuiltTreatmentCandidate(
          item,
          evidence.treatmentCandidate,
          target,
            receipt.proof,
            diagnosticTerminalWitness.event!,
            false,
        ))
      ) return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
    }
    return { ...resultFromRecord(true, existing), recorded: false };
  }

  const evidenceTs = evidence.kind === 'dispatch-proof-empty-diff' ? evidence.eventTs : evidence.ts;
  const now = evidenceTs && Number.isFinite(Date.parse(evidenceTs))
    ? new Date(evidenceTs).toISOString()
    : new Date().toISOString();
  const emptyAttemptHashes = existing?.emptyAttemptHashes.slice() ?? [];
  const emptyAttemptBackends = existing?.emptyAttemptBackends?.slice() ?? [];
  const emptyAttemptTiers = existing?.emptyAttemptTiers?.slice() ?? [];
  const emptyAttemptProofReceipts = existing?.emptyAttemptProofReceipts
    ? structuredClone(existing.emptyAttemptProofReceipts)
    : [];
  const backendHistoryKnown = emptyAttemptBackends.length === emptyAttemptHashes.length;
  const tierHistoryKnown = emptyAttemptTiers.length === emptyAttemptHashes.length;
  let disposition: Exclude<GeneratedRepairDisposition, 'active'>;
  let terminalAttemptHash: string;
  let terminalAttemptProofReceipt: GeneratedRepairDispatchProofReceipt | undefined;
  let proposalAuthority: GeneratedRepairProposalAuthority | undefined;
  let treatmentCandidate = evidence.treatmentCandidate
    ? structuredClone(evidence.treatmentCandidate)
    : undefined;
  if (evidence.kind === 'proposal-created') {
    disposition = 'retired';
    if (diagnostic) {
      if (!backendHistoryKnown || !tierHistoryKnown ||
        emptyAttemptProofReceipts.length !== emptyAttemptHashes.length) {
        return { ...resultFromRecord(false, existing), recorded: false };
      }
      const resolved = resolveDiagnosticLifecycleAttemptWitness(
        item,
        evidence.ts!,
        'proposal-created',
        evidence.proposalId,
        authority,
        emptyAttemptProofReceipts,
      );
      lifecycleAdmissionTraceHookForTest?.(
        resolved ? 'diagnostic-attempt-witness' : 'diagnostic-attempt-witness-missing',
      );
      if (!resolved) return { ...resultFromRecord(false, existing), recorded: false };
      const { target, witness } = resolved;
      const proof = witness.proof;
      if (generatedRepairLifecycleAttemptHash(evidence.attemptId) !== proof.attemptHash) {
        return { ...resultFromRecord(false, existing), recorded: false };
      }
      const candidateInput: DispatchProductionEvent = evidence.treatmentCandidate
        ? structuredClone(evidence.treatmentCandidate)
        : {
            ...structuredClone(witness.event!),
            basis: 'repair-lifecycle-candidate',
            repairTreatmentAttemptHash: proof.attemptHash,
          };
      treatmentCandidate = rebuiltTreatmentCandidate(
        item,
        candidateInput,
        target,
        proof,
        witness.event!,
      ) ?? undefined;
      if (!treatmentCandidate) return { ...resultFromRecord(false, existing), recorded: false };
      lifecycleAdmissionTraceHookForTest?.('treatment-candidate');
      terminalAttemptHash = proof.attemptHash;
      const failurePredecessor = emptyAttemptProofReceipts.length === 0 &&
        proof.repairAttemptOrdinal === 2
        ? diagnosticFailurePredecessorProof(item, proof, authority)
        : null;
      terminalAttemptProofReceipt = proofReceiptFromEvent(
        witness.event!,
        target,
        proof,
        failurePredecessor?.event,
      ) ?? undefined;
      if (!terminalAttemptProofReceipt) {
        return { ...resultFromRecord(false, existing), recorded: false };
      }
      lifecycleAdmissionTraceHookForTest?.('terminal-attempt-receipt');
      proposalAuthority = proposalAuthorityFromEvent(
        evidence.proposalId,
        evidence.attemptId,
        witness.event!,
        durableProposal!.contentDigest,
      );
      lifecycleAdmissionTraceHookForTest?.('proposal-authority');
    } else {
      terminalAttemptHash = generatedRepairLifecycleAttemptHash(evidence.attemptId);
      proposalAuthority = proposalAuthorityFromEvent(
        evidence.proposalId,
        evidence.attemptId,
        exactOrdinaryAttempt!.event,
        durableProposal!.contentDigest,
        exactOrdinaryAttempt!.receipt,
      );
    }
  } else if (evidence.kind === 'empty-diff') {
    if (!backendHistoryKnown || (emptyAttemptHashes.length > 0 && !tierHistoryKnown)) {
      return { ...resultFromRecord(false, existing), recorded: false };
    }
    const hash = generatedRepairLifecycleAttemptHash(evidence.attemptId);
    const existingAttemptIndex = emptyAttemptHashes.indexOf(hash);
    if (existingAttemptIndex >= 0) {
      if (emptyAttemptBackends[existingAttemptIndex] !== evidence.backend) {
        return { ...resultFromRecord(false, existing), recorded: false };
      }
      if (emptyAttemptTiers[existingAttemptIndex] !== evidence.tier) {
        return { ...resultFromRecord(false, existing), recorded: false };
      }
      return { ...resultFromRecord(true, existing), recorded: false };
    }
    const parentTierBound = isTrustedDiagnosticResliceItem(item) || (
      isTrustedCaptureRepairItem(item) &&
      (item.repairParentSource === 'issue' || item.repairParentSource === 'goal')
    );
    if (
      emptyAttemptHashes.length === 0 &&
      parentTierBound &&
      item.repairParentTier !== evidence.tier
    ) {
      return { ...resultFromRecord(false, existing), recorded: false };
    }
    if (emptyAttemptHashes.length === 1 && (
      emptyAttemptBackends[0] === evidence.backend ||
      emptyAttemptTiers[0] !== evidence.tier
    )) {
      return { ...resultFromRecord(false, existing), recorded: false };
    }
    emptyAttemptHashes.push(hash);
    emptyAttemptBackends.push(evidence.backend);
    emptyAttemptTiers.push(evidence.tier);
    if (emptyAttemptHashes.length < 2) {
      const recorded = saveActiveEmptyProgress(
        loaded.ledger, id, generationIds, emptyAttemptHashes, emptyAttemptBackends, emptyAttemptTiers, now,
      );
      return recorded
        ? {
          available: true,
          disposition: 'active',
          authoritativeEmptyRuns: emptyAttemptHashes.length,
          recorded: true,
        }
        : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
    }
    disposition = 'exhausted';
    terminalAttemptHash = hash;
  } else {
    if (!backendHistoryKnown || !tierHistoryKnown ||
      emptyAttemptProofReceipts.length !== emptyAttemptHashes.length) {
      return { ...resultFromRecord(false, existing), recorded: false };
    }
    const replayIndex = emptyAttemptProofReceipts.findIndex((receipt) =>
      receipt.proof.eventTs === evidence.eventTs);
    if (replayIndex >= 0) {
      const receipt = emptyAttemptProofReceipts[replayIndex]!;
      const replayTarget = diagnosticAttemptProofTarget(
        item,
        receipt.proof.eventTs,
        receipt.proof.repairAttemptOrdinal,
        authority,
        'empty-diff',
        undefined,
        receipt.proof.repairGenerationId,
        publicationEventFromReceipt(receipt)?.target.objectiveHash,
      );
      if (!replayTarget) return { ...resultFromRecord(false, existing), recorded: false };
      const replayWitness = diagnosticWitnesses?.find((witness) =>
        witness.proof.eventTs === receipt.proof.eventTs);
      if (!replayWitness) return { ...resultFromRecord(false, existing), recorded: false };
      if (evidence.treatmentCandidate && !rebuiltTreatmentCandidate(
        item,
        evidence.treatmentCandidate,
        replayTarget,
        receipt.proof,
        replayWitness.event,
        false,
      )) return { ...resultFromRecord(false, existing), recorded: false };
      const replay = resultFromRecord(true, existing);
      return {
        ...replay,
        authoritativeEmptyRuns: Math.max(
          replay.authoritativeEmptyRuns,
          receipt.proof.repairAttemptOrdinal,
        ),
        recorded: false,
      };
    }
    const resolved = resolveDiagnosticLifecycleAttemptWitness(
      item,
      evidence.eventTs,
      'empty-diff',
      undefined,
      authority,
      emptyAttemptProofReceipts,
    );
    if (!resolved) return { ...resultFromRecord(false, existing), recorded: false };
    const { target, witness } = resolved;
    const proof = witness.proof;
    const proofs = [...emptyAttemptProofReceipts.map((receipt) => receipt.proof), proof];
    const candidateInput: DispatchProductionEvent = evidence.treatmentCandidate
      ? structuredClone(evidence.treatmentCandidate)
      : {
          ...structuredClone(witness.event!),
          basis: 'repair-lifecycle-candidate',
          repairTreatmentAttemptHash: proof.attemptHash,
        };
    treatmentCandidate = rebuiltTreatmentCandidate(
      item,
      candidateInput,
      target,
      proof,
      witness.event!,
    ) ?? undefined;
    if (!treatmentCandidate) return { ...resultFromRecord(false, existing), recorded: false };
    emptyAttemptHashes.push(proof.attemptHash);
    emptyAttemptBackends.push(proof.backend);
    emptyAttemptTiers.push(proof.tier);
    const failurePredecessor = emptyAttemptProofReceipts.length === 0 &&
      proof.repairAttemptOrdinal === 2
      ? diagnosticFailurePredecessorProof(item, proof, authority)
      : null;
    const proofReceipt = proofReceiptFromEvent(
      witness.event!,
      target,
      proof,
      failurePredecessor?.event,
    );
    if (!proofReceipt) return { ...resultFromRecord(false, existing), recorded: false };
    emptyAttemptProofReceipts.push(proofReceipt);
    if (emptyAttemptHashes.length < 2) {
      const recorded = saveActiveEmptyProgress(
        loaded.ledger,
        id,
        generationIds,
        emptyAttemptHashes,
        emptyAttemptBackends,
        emptyAttemptTiers,
        now,
        emptyAttemptProofReceipts,
      );
      if (!recorded) {
        return { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
      }
      const persisted = resultFromRecord(true, loaded.ledger.records.at(-1));
      // A transition acknowledges the accepted attempt ordinal. Persisted reads
      // continue to count only authoritative diagnostic empty outcomes.
      return {
        ...persisted,
        authoritativeEmptyRuns: Math.max(persisted.authoritativeEmptyRuns, proof.repairAttemptOrdinal),
        recorded: true,
      };
    }
    disposition = hasObjectiveSaturationProof(item, proofs, authority) ? 'quarantined' : 'exhausted';
    terminalAttemptHash = proof.attemptHash;
    terminalAttemptProofReceipt = structuredClone(proofReceipt);
  }

  const record: GeneratedRepairLifecycleRecord = {
    generationId: id,
    disposition,
    emptyAttemptHashes: emptyAttemptHashes.slice(0, 2),
    ...(emptyAttemptBackends.length === emptyAttemptHashes.length
      ? { emptyAttemptBackends: emptyAttemptBackends.slice(0, 2) }
      : {}),
    ...(emptyAttemptTiers.length === emptyAttemptHashes.length
      ? { emptyAttemptTiers: emptyAttemptTiers.slice(0, 2) }
      : {}),
    ...(emptyAttemptProofReceipts.length === emptyAttemptHashes.length && emptyAttemptProofReceipts.length > 0
      ? { emptyAttemptProofReceipts: structuredClone(emptyAttemptProofReceipts.slice(0, 2)) }
      : {}),
    terminalAttemptHash,
    ...(terminalAttemptProofReceipt ? { terminalAttemptProofReceipt } : {}),
    ...(proposalAuthority ? { proposalAuthority } : {}),
    updatedAt: now,
  };
  lifecycleAdmissionTraceHookForTest?.('lifecycle-record');
  replaceLifecycleFamily(loaded.ledger, record, generationIds);
  const recorded = saveLedger(loaded.ledger);
  lifecycleAdmissionTraceHookForTest?.(
    recorded ? 'lifecycle-ledger-saved' : 'lifecycle-ledger-save-failed',
  );
  return recorded
    ? {
      ...resultFromRecord(true, record),
      recorded: true,
      ...(diagnostic ? {
        treatmentOutcomeWitness: {
          outcome: disposition === 'retired' ? 'converted' : 'not-converted',
          disposition,
          generationId: id,
          attemptHash: terminalAttemptHash,
        },
      } : {}),
    }
    : { available: false, disposition: 'active', authoritativeEmptyRuns: 0, recorded: false };
}

function diagnosticFailurePredecessorFromCapsule(
  capsule: {
    event: DispatchProductionEvent;
    target: DispatchProductionAttemptProofTarget;
    publication: GeneratedRepairPublicationCapsule;
  },
  second: DispatchProductionAttemptProof,
  authority: HandoffAuthoritySnapshot,
): boolean {
  // Root authority is carried by the publication capsule, not the reconstructed
  // success event, because diagnostic success rows intentionally omit it.
  const boundRootId = capsule.publication.repairRootId;
  const boundDepth = capsule.publication.repairDepth;
  if (second.repairAttemptOrdinal !== 2 || second.previousBackend === null ||
    !SHA256_RE.test(boundRootId ?? '') ||
    (boundDepth !== 0 && boundDepth !== 1)) return false;
  const handoff = authority.byEventId.get(second.repairHandoffId);
  if (!handoff || handoff.generationId !== second.repairGenerationId) return false;
  const generationIds = [...new Set([
    second.repairGenerationId,
    ...(authority.exactParentRowGenerationsByEventId.get(handoff.eventId) ?? []),
  ])];
  const resolved = readDispatchProductionFailureAttemptReceipts(generationIds);
  if (resolved.status !== 'resolved' || !resolved.authoritative) return false;
  const firsts = resolved.receipts.filter(({ proof }) =>
    generationIds.includes(proof.repairGenerationId) && proof.repairAttemptOrdinal === 1);
  if (firsts.length !== 1) return false;
  const { proof, event } = firsts[0]!;
  const predecessorHandoff = authority.byEventId.get(proof.repairHandoffId);
  let eventRepo: string;
  let targetRepo: string;
  try {
    eventRepo = resolve(event.repo);
    targetRepo = resolve(capsule.target.repo);
  } catch { return false; }
  const predecessor: DispatchProductionAttemptProof = {
    ...proof,
    repairTreatmentUnitId: proof.repairTreatmentUnitId!,
    repairTreatment: proof.repairTreatment!,
  };
  return predecessorHandoff !== undefined &&
    predecessorHandoff.generationId === proof.repairGenerationId &&
    generationIds.includes(predecessorHandoff.generationId) &&
    proof.repairTreatmentUnitId === second.repairTreatmentUnitId &&
    proof.repairTreatment === second.repairTreatment &&
    event.itemId === capsule.target.itemId &&
    eventRepo === targetRepo &&
    event.source === capsule.target.source &&
    event.objectiveHash === capsule.target.objectiveHash &&
    event.proposalCreated === false &&
    event.proposalId === undefined &&
    DIAGNOSTIC_FAILURE_OUTCOMES.has(event.outcome) &&
    event.repairRootId === boundRootId &&
    event.repairDepth === boundDepth &&
    event.repairHandoffId === proof.repairHandoffId &&
    event.repairGenerationId === proof.repairGenerationId &&
    event.repairAttemptOrdinal === 1 &&
    event.repairPreviousBackend === undefined &&
    validAttemptProofSequence([predecessor, second]);
}

function terminalCandidateFromCapsule(
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
  requireSourceProof = true,
): DispatchProductionEvent | null {
  const receipt = record.terminalAttemptProofReceipt;
  if (!receipt || !record.terminalAttemptHash || receipt.proof.attemptHash !== record.terminalAttemptHash) return null;
  const capsule = publicationEventFromReceipt(receipt);
  if (!capsule) return null;
  const expectedOutcome = record.disposition === 'retired' ? 'proposal-created' : 'empty-diff';
  if (
    capsule.target.outcome !== expectedOutcome ||
    !exactParentRowAliasGenerations(
      authority,
      record.generationId,
      capsule.target.repairGenerationId,
    )
  ) return null;
  let target: DispatchProductionAttemptProofTarget = capsule.target;
  if (requireSourceProof) {
    const parent = authority.byEventId.get(receipt.proof.repairHandoffId);
    if (
      !parent ||
      parent.generationId !== capsule.target.repairGenerationId ||
      parent.childItemId !== capsule.target.itemId ||
      parent.repo !== capsule.target.repo ||
      Date.parse(parent.ts) >= Date.parse(capsule.event.ts)
    ) return null;
    target = {
      ...capsule.target,
      sequenceStartTs: parent.ts,
      sequenceEndTs: new Date().toISOString(),
    };
  }
  if (!durableReceiptMatchesTarget(receipt, target)) return null;
  if (requireSourceProof) {
    if (!sourceProofCompatibleWithCapsule(target, receipt)) return null;
    const receipts = structuredClone(record.emptyAttemptProofReceipts ?? []);
    if (!receipts.some((candidate) => sameAttemptProof(candidate.proof, receipt.proof))) receipts.push(receipt);
    const proofs = receipts.map((candidate) => candidate.proof);
    if (!validAttemptProofSequence(proofs) && !(
      proofs.length === 1 &&
      diagnosticFailurePredecessorFromCapsule(capsule, proofs[0]!, authority)
    )) return null;
  }
  return rebuiltProofCandidate(capsule.event, target, receipt.proof);
}

function treatmentWitnessForRecord(
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
  ts: string,
  requireSourceProof: boolean,
): DispatchProductionEvent | null {
  const candidate = terminalCandidateFromCapsule(record, authority, requireSourceProof);
  if (!candidate || !record.terminalAttemptHash || !canonicalUtcTimestamp(ts)) return null;
  try {
    return sanitizeDispatchProductionEvent({
      ...candidate,
      ts,
      basis: 'repair-lifecycle-outcome',
      repairTreatmentOutcome: record.disposition === 'retired' ? 'converted' : 'not-converted',
      repairTreatmentAttemptHash: record.terminalAttemptHash,
    }, { materializeLearningLabel: true });
  } catch {
    return null;
  }
}

function exactTreatmentReceiptStorageAssured(
  witness: DispatchProductionEvent,
  mode: 'secure-created' | 'inspect-existing',
): boolean {
  if (process.platform !== 'win32') return true;
  if (!witness.repairGenerationId || !witness.repairTreatmentAttemptHash) return false;
  const root = dispatchProductionDir();
  const dir = join(root, 'repair-treatment-outcomes');
  const receiptPath = join(
    dir,
    `${witness.repairGenerationId}-${witness.repairTreatmentAttemptHash}.json`,
  );
  if (!assurePrivateStoragePath(
    dir, 'directory', 'inspect-existing', { anchorPath: root },
  ).ok) return false;
  const retentionPath = join(dir, '.retention.json');
  const authorityPath = existsSync(receiptPath) ? receiptPath : retentionPath;
  if (!existsSync(authorityPath)) return false;
  return assurePrivateStoragePath(
    authorityPath,
    'file',
    authorityPath === receiptPath ? mode : 'inspect-existing',
    { anchorPath: root },
  ).ok;
}

function hasExactPublishedTreatmentReceipt(
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
): boolean {
  if (!record.treatmentWitnessRecordedAt || !record.treatmentWitnessDigest) return false;
  const witness = treatmentWitnessForRecord(record, authority, record.treatmentWitnessRecordedAt, false);
  return witness !== null &&
    digestBytes(Buffer.from(JSON.stringify(witness), 'utf8')) === record.treatmentWitnessDigest &&
    exactTreatmentReceiptStorageAssured(witness, 'inspect-existing') &&
    hasExactDispatchProductionTreatmentOutcomeReceipt(witness);
}

function hasExactPendingTreatmentReceipt(
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
): boolean {
  if (record.treatmentWitnessRecordedAt || record.treatmentWitnessDigest) return false;
  const witness = treatmentWitnessForRecord(record, authority, record.updatedAt, false);
  return witness !== null &&
    exactTreatmentReceiptStorageAssured(witness, 'inspect-existing') &&
    hasExactDispatchProductionTreatmentOutcomeReceipt(witness);
}

function isDiagnosticTreatmentRecord(
  record: GeneratedRepairLifecycleRecord,
  authority: HandoffAuthoritySnapshot,
): boolean {
  if (record.terminalAttemptProofReceipt || (record.emptyAttemptProofReceipts?.length ?? 0) > 0) {
    return true;
  }
  return authority.observationsByGenerationId.get(record.generationId)?.some(
    (observation) => observation.kind === 'no-diff-reslice',
  ) === true;
}

/** Durable terminal-label outbox; independent of observational ledger volume. */
export function readPendingGeneratedRepairTreatmentOutcomes(): PendingGeneratedRepairTreatmentOutcomeRead {
  const result = (
    available: boolean,
    outcomes: PendingGeneratedRepairTreatmentOutcome[] = [],
    prooflessLegacy = 0,
  ): PendingGeneratedRepairTreatmentOutcomeRead => {
    const effectiveAvailability = available && prooflessLegacy === 0;
    Object.defineProperty(outcomes, 'available', { value: effectiveAvailability, enumerable: false });
    Object.defineProperty(outcomes, 'prooflessLegacy', { value: prooflessLegacy, enumerable: false });
    Object.defineProperty(outcomes, 'requiredAction', {
      value: prooflessLegacy > 0 || !effectiveAvailability ? 'operator-reset' : null,
      enumerable: false,
    });
    return outcomes as PendingGeneratedRepairTreatmentOutcomeRead;
  };
  if (!recoverLifecycleStorage()) return result(false);
  const lock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lock) return result(false);
  try {
    if (!recoverLifecycleWriteFailureUnlocked()) return result(false);
    const loaded = loadLedger();
    if (!loaded.ok) return result(false);
    const authority = handoffAuthoritySnapshot();
    if (authority.sourceState === 'degraded') return result(false);
    let proposalAuthority: ProposalAuthoritySnapshot | undefined;
    let prooflessLegacy = 0;
    const outcomes = loaded.ledger.records.flatMap((record): PendingGeneratedRepairTreatmentOutcome[] => {
      if (
        !isDiagnosticTreatmentRecord(record, authority) ||
        (record.disposition !== 'retired' && record.disposition !== 'exhausted' && record.disposition !== 'quarantined') ||
        !record.terminalAttemptHash ||
        record.treatmentWitnessRecordedAt ||
        (record.disposition === 'retired' && !proposalAuthorityStillValid(
          record,
          proposalAuthority ??= loadProposalAuthoritySnapshot(),
        ))
      ) return [];
      const candidate = terminalCandidateFromCapsule(record, authority, true) ?? (
        hasExactPendingTreatmentReceipt(record, authority)
          ? terminalCandidateFromCapsule(record, authority, false)
          : null
      );
      if (!record.terminalAttemptProofReceipt?.targetDigest || !candidate) {
        prooflessLegacy++;
        return [];
      }
      return [{
        outcome: record.disposition === 'retired' ? 'converted' : 'not-converted',
        disposition: record.disposition,
        generationId: record.generationId,
        attemptHash: record.terminalAttemptHash,
        candidate,
      }];
    });
    return result(true, outcomes, prooflessLegacy);
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Publish and acknowledge one terminal treatment witness under lifecycle + generation authority. */
export function publishGeneratedRepairTreatmentOutcome(
  generationId: string,
  attemptHash: string,
): boolean {
  if (!SHA256_RE.test(generationId) || !SHA256_RE.test(attemptHash)) return false;
  const lifecycleLock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lifecycleLock) return false;
  try {
    if (!recoverLifecycleWriteFailureUnlocked()) return false;
    const published = withDispatchProductionGenerationAuthority(generationId, () => {
      const loaded = loadLedger();
      if (!loaded.ok) return false;
      const record = loaded.ledger.records.find((candidate) => candidate.generationId === generationId);
      if (
        !record ||
        record.terminalAttemptHash !== attemptHash
      ) return false;
      const publish = (): boolean => {
        if (!proposalAuthorityStillValid(record)) return false;
        const authority = handoffAuthoritySnapshot();
        if (record.treatmentWitnessRecordedAt && record.treatmentWitnessDigest) {
          return hasExactPublishedTreatmentReceipt(record, authority);
        }
        const candidate = terminalCandidateFromCapsule(record, authority, true) ?? (
          hasExactPendingTreatmentReceipt(record, authority)
            ? terminalCandidateFromCapsule(record, authority, false)
            : null
        );
        if (!candidate) return false;
        const witness = sanitizeDispatchProductionEvent({
          ...candidate,
          ts: record.updatedAt,
          basis: 'repair-lifecycle-outcome',
          repairTreatmentOutcome: record.disposition === 'retired' ? 'converted' : 'not-converted',
          repairTreatmentAttemptHash: attemptHash,
        }, { materializeLearningLabel: true });
        if (!hasExactDispatchProductionTreatmentOutcomeReceipt(witness) &&
          recordDispatchProduction(witness).recorded !== 1) return false;
        if (!exactTreatmentReceiptStorageAssured(witness, 'secure-created') ||
          !hasExactDispatchProductionTreatmentOutcomeReceipt(witness)) return false;
        record.treatmentWitnessRecordedAt = witness.ts;
        record.treatmentWitnessDigest = digestBytes(Buffer.from(JSON.stringify(witness), 'utf8'));
        delete record.emptyAttemptProofReceipts;
        return saveLedger(loaded.ledger);
      };
      if (record.disposition !== 'retired') return publish();
      const fenced = withProposalStoreAuthority(publish);
      return fenced.ok && fenced.value;
    });
    return published.ok && published.value;
  } finally {
    releaseLocalStoreLock(lifecycleLock);
  }
}

/** Acknowledge one outbox row only after its terminal witness append is durable. */
export function acknowledgeGeneratedRepairTreatmentOutcome(
  generationId: string,
  attemptHash: string,
  ts?: string,
): boolean {
  if (
    !SHA256_RE.test(generationId) ||
    !SHA256_RE.test(attemptHash) ||
    (ts !== undefined && !canonicalUtcTimestamp(ts))
  ) return false;
  const lifecycleLock = acquireLocalStoreLock(lifecycleLockPath(), 250);
  if (!lifecycleLock) return false;
  try {
    if (!recoverLifecycleWriteFailureUnlocked()) return false;
    const acknowledged = withDispatchProductionGenerationAuthority(generationId, () => {
      const loaded = loadLedger();
      if (!loaded.ok) return false;
      const record = loaded.ledger.records.find((candidate) => candidate.generationId === generationId);
      if (!record || record.terminalAttemptHash !== attemptHash) return false;
      const acknowledge = (): boolean => {
        if (!proposalAuthorityStillValid(record)) return false;
        const authority = handoffAuthoritySnapshot();
        if (record.treatmentWitnessRecordedAt && record.treatmentWitnessDigest) {
          return hasExactPublishedTreatmentReceipt(record, authority);
        }
        if (!record.terminalAttemptProofReceipt?.targetDigest) return false;
        const candidate = terminalCandidateFromCapsule(record, authority, false);
        if (!candidate) return false;
        const acknowledgedAt = ts ?? record.updatedAt;
        const witness = sanitizeDispatchProductionEvent({
          ...candidate,
          ts: acknowledgedAt,
          basis: 'repair-lifecycle-outcome',
          repairTreatmentOutcome: record.disposition === 'retired' ? 'converted' : 'not-converted',
          repairTreatmentAttemptHash: attemptHash,
        }, { materializeLearningLabel: true });
        if (!hasExactDispatchProductionTreatmentOutcomeReceipt(witness)) return false;
        record.treatmentWitnessRecordedAt = acknowledgedAt;
        record.treatmentWitnessDigest = digestBytes(Buffer.from(JSON.stringify(witness), 'utf8'));
        record.updatedAt = acknowledgedAt;
        delete record.emptyAttemptProofReceipts;
        return saveLedger(loaded.ledger);
      };
      if (record.disposition !== 'retired') return acknowledge();
      const fenced = withProposalStoreAuthority(acknowledge);
      return fenced.ok && fenced.value;
    });
    return acknowledged.ok && acknowledged.value;
  } finally {
    releaseLocalStoreLock(lifecycleLock);
  }
}

function saveActiveEmptyProgress(
  ledger: GeneratedRepairLifecycleLedger,
  id: string,
  generationIds: readonly string[],
  emptyAttemptHashes: string[],
  emptyAttemptBackends: EngineId[],
  emptyAttemptTiers: EngineTier[],
  updatedAt: string,
  emptyAttemptProofReceipts?: GeneratedRepairDispatchProofReceipt[],
): boolean {
  const record: GeneratedRepairLifecycleRecord = {
    generationId: id,
    disposition: 'active',
    emptyAttemptHashes: emptyAttemptHashes.slice(0, 2),
    emptyAttemptBackends: emptyAttemptBackends.slice(0, 2),
    emptyAttemptTiers: emptyAttemptTiers.slice(0, 2),
    ...(emptyAttemptProofReceipts?.length === emptyAttemptHashes.length
      ? { emptyAttemptProofReceipts: structuredClone(emptyAttemptProofReceipts.slice(0, 2)) }
      : {}),
    updatedAt,
  };
  replaceLifecycleFamily(ledger, record, generationIds);
  return saveLedger(ledger);
}
