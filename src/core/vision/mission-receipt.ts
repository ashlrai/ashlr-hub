/**
 * Immutable, observation-only receipts for Ecosystem Mission Graph state.
 *
 * Receipts authenticate what one local Hub process observed. They are not an
 * independent verifier and grant no planning, execution, proposal, merge,
 * release, deployment, external-mutation, learning, or policy authority.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
} from '../foundry/provenance.js';
import {
  readImmutablePrivateRecordPoint,
  readImmutablePrivateRecords,
  recoverImmutablePrivateRecordStore,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordPointReadResult,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadResult,
  type ImmutablePrivateRecordRecoveryDisposition,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';

const PROTOCOL = 'mission-observation-receipt-v1' as const;
const RECORD_TYPE = 'mission-observation' as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const KEY_RE = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const MAX_BRIEFING_BYTES = 256 * 1024;
const MAX_CANONICAL_NODES = 10_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_IDENTIFIER_BYTES = 1_024;
const MAX_MISSION_NODES = 24;
const MAX_BLOCKED_BY = 8;
const MAX_MILESTONES_PER_NODE = 64;
const MAX_TOTAL_MILESTONES = 512;
const MAX_RECORD_BYTES = 256 * 1024;

const RECEIPT_KEYS = new Set([
  'schemaVersion', 'protocol', 'recordType', 'authority', 'planningAuthority',
  'executionAuthority', 'proposalAuthority', 'mergeAuthority', 'releaseAuthority',
  'deployAuthority', 'externalMutationAuthority', 'learningAuthority', 'policyEligible',
  'attestationAuthority', 'verifierIsolated', 'recordedAt', 'captureKind', 'missionKey',
  'graphDigest', 'briefingDigest', 'enrollmentSourceDigest', 'goalSourceDigest',
  'proposalSourceDigest', 'sourceComplete', 'engineeringStatus', 'businessOutcomeStatus',
  'humanDecisionEvidenceComplete', 'outcomeEvidenceComplete', 'nodeCount', 'nodes',
  'snapshotDigest', 'receiptId', 'receiptDigest', 'attestation',
]);
const NODE_KEYS = new Set([
  'nodeKey', 'kind', 'status', 'blockedBy', 'goalRef', 'goalRecordDigest',
  'milestoneCount', 'milestones', 'engineeringRealized',
]);
const MILESTONE_KEYS = new Set([
  'milestoneRef', 'status', 'proposalRef', 'proposalStatus', 'verificationPassed',
  'verificationDigest', 'mergeSource', 'exactRevision', 'realizedMergeDigest',
  'engineeringRealized',
]);
const RECEIPT_INPUT_KEYS = new Set([
  'recordedAt', 'captureKind', 'missionKey', 'graphDigest', 'briefing',
  'briefingSource', 'enrollmentSource', 'goalSource', 'proposalSource', 'nodes',
]);
const SOURCE_INPUT_KEYS = new Set(['sourceState', 'complete', 'digest']);
const NODE_INPUT_KEYS = new Set([
  'nodeKey', 'kind', 'status', 'blockedBy', 'goalId', 'goalRecordDigest', 'milestones',
]);
const MILESTONE_INPUT_KEYS = new Set([
  'milestoneId', 'status', 'proposalId', 'proposalStatus', 'verificationPassed',
  'verificationDigest', 'mergeSource', 'exactRevision', 'realizedMergeDigest',
]);

export type MissionObservationEngineeringStatus =
  | 'blocked'
  | 'ready'
  | 'in-progress'
  | 'awaiting-human'
  | 'complete'
  | 'failed';

export type MissionObservationNodeStatus =
  | 'blocked'
  | 'ready'
  | 'active'
  | 'proposed'
  | 'awaiting-human'
  | 'complete'
  | 'failed';

export type MissionObservationMilestoneStatus =
  | 'pending'
  | 'in-progress'
  | 'proposed'
  | 'paused'
  | 'skipped'
  | 'blocked'
  | 'done';

export type MissionObservationProposalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'awaiting-host-merge'
  | 'applied'
  | 'failed';

export interface MissionObservationSourceInput {
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  /** Digest calculated by the authoritative bounded source reader. */
  digest: string;
}

export interface MissionObservationMilestoneInput {
  milestoneId: string;
  status: MissionObservationMilestoneStatus;
  proposalId: string | null;
  proposalStatus: MissionObservationProposalStatus | null;
  verificationPassed: boolean;
  verificationDigest: string | null;
  mergeSource: 'local-default-branch' | 'github-host' | null;
  exactRevision: string | null;
  realizedMergeDigest: string | null;
}

export interface MissionObservationNodeInput {
  nodeKey: string;
  kind: 'work' | 'human-gate';
  status: MissionObservationNodeStatus;
  blockedBy: readonly string[];
  goalId: string | null;
  goalRecordDigest: string | null;
  milestones: readonly MissionObservationMilestoneInput[];
}

export interface MissionObservationReceiptInput {
  recordedAt: string;
  captureKind: 'explicit-reconcile';
  missionKey: string;
  graphDigest: string;
  /** The exact parsed briefing. Only its bounded canonical digest is retained. */
  briefing: unknown;
  /** Must be complete and its digest must equal the canonical briefing digest. */
  briefingSource: MissionObservationSourceInput;
  enrollmentSource: MissionObservationSourceInput;
  goalSource: MissionObservationSourceInput;
  proposalSource: MissionObservationSourceInput;
  nodes: readonly MissionObservationNodeInput[];
}

export interface MissionObservationMilestoneV1 {
  milestoneRef: string;
  status: MissionObservationMilestoneStatus;
  proposalRef: string | null;
  proposalStatus: MissionObservationProposalStatus | null;
  verificationPassed: boolean;
  verificationDigest: string | null;
  mergeSource: 'local-default-branch' | 'github-host' | null;
  exactRevision: string | null;
  realizedMergeDigest: string | null;
  engineeringRealized: boolean;
}

export interface MissionObservationNodeV1 {
  nodeKey: string;
  kind: 'work' | 'human-gate';
  status: MissionObservationNodeStatus;
  blockedBy: string[];
  goalRef: string | null;
  goalRecordDigest: string | null;
  milestoneCount: number;
  milestones: MissionObservationMilestoneV1[];
  engineeringRealized: boolean;
}

export interface MissionObservationReceiptV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  recordType: typeof RECORD_TYPE;
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  externalMutationAuthority: false;
  learningAuthority: false;
  policyEligible: false;
  attestationAuthority: 'host-shared-hmac';
  verifierIsolated: false;
  recordedAt: string;
  captureKind: 'explicit-reconcile';
  missionKey: string;
  graphDigest: string;
  briefingDigest: string;
  enrollmentSourceDigest: string;
  goalSourceDigest: string;
  proposalSourceDigest: string;
  sourceComplete: true;
  engineeringStatus: MissionObservationEngineeringStatus;
  businessOutcomeStatus: 'not-observed';
  humanDecisionEvidenceComplete: false;
  outcomeEvidenceComplete: false;
  nodeCount: number;
  nodes: MissionObservationNodeV1[];
  snapshotDigest: string;
  receiptId: string;
  receiptDigest: string;
  attestation: string;
}

export type MissionObservationReceiptDisposition =
  | 'recorded'
  | 'replayed'
  | 'conflicted'
  | 'invalid'
  | 'source-degraded'
  | 'key-unavailable'
  | 'persistence-failed';

export type MissionObservationReceiptRecordResult =
  | {
      disposition: 'recorded' | 'replayed';
      receipt: MissionObservationReceiptV1;
    }
  | {
      disposition: Exclude<MissionObservationReceiptDisposition, 'recorded' | 'replayed'>;
      receipt: null;
    };

export interface MissionObservationReceiptReadResult extends
  Omit<ImmutablePrivateRecordReadResult<MissionObservationReceiptV1>, 'records'> {
  receipts: MissionObservationReceiptV1[];
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor || !descriptor.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown, maxBytes: number): string | null {
  let visitedNodes = 0;
  let textBytes = 0;
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, depth: number): CanonicalValue => {
    visitedNodes += 1;
    if (visitedNodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new Error('canonical value exceeds structural bounds');
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('canonical numbers must be finite');
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (typeof candidate === 'string') {
      const normalized = candidate.normalize('NFC');
      textBytes += Buffer.byteLength(normalized, 'utf8');
      if (textBytes > maxBytes) throw new Error('canonical text exceeds byte bound');
      return normalized;
    }
    if (typeof candidate !== 'object') throw new Error('unsupported canonical value');
    if (ancestors.has(candidate)) throw new Error('cyclic canonical value');
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const output: CanonicalValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new Error('canonical arrays must be dense data arrays');
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }
      const source = recordOf(candidate);
      if (!source) throw new Error('canonical objects must be plain records');
      const output = Object.create(null) as Record<string, CanonicalValue>;
      const entries: Array<[string, unknown]> = [];
      for (const rawKey of Object.keys(source)) {
        const descriptor = Object.getOwnPropertyDescriptor(source, rawKey);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('canonical objects must contain data properties');
        }
        const key = rawKey.normalize('NFC');
        textBytes += Buffer.byteLength(key, 'utf8');
        if (textBytes > maxBytes) throw new Error('canonical keys exceed byte bound');
        entries.push([key, descriptor.value]);
      }
      entries.sort(([left], [right]) => codeUnitCompare(left, right));
      for (const [key, entry] of entries) {
        if (Object.prototype.hasOwnProperty.call(output, key)) {
          throw new Error('canonical keys collide after normalization');
        }
        output[key] = visit(entry, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  try {
    const encoded = JSON.stringify(visit(value, 0));
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? encoded : null;
  } catch {
    return null;
  }
}

function sha(domain: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function hmac(key: Buffer, domain: string, value: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function equalDigest(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' ||
    !SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const first = Buffer.from(left, 'hex');
  const second = Buffer.from(right, 'hex');
  return first.length === second.length && timingSafeEqual(first, second);
}

function boundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES;
}

function validSource(source: MissionObservationSourceInput): boolean {
  const row = recordOf(source);
  return row !== null && exactKeys(row, SOURCE_INPUT_KEYS) &&
    (source.sourceState === 'missing' || source.sourceState === 'healthy') &&
    source.complete === true && SHA256_RE.test(source.digest);
}

/** Shared bounded digest for binding a receipt to the exact current briefing. */
export function missionObservationBriefingDigest(briefing: unknown): string | null {
  const canonical = canonicalJson(briefing, MAX_BRIEFING_BYTES);
  return canonical === null
    ? null
    : createHash('sha256')
      .update('ashlr:mission-observation:briefing:v1\0', 'utf8')
      .update(canonical, 'utf8')
      .digest('hex');
}

function normalizeMilestone(
  input: MissionObservationMilestoneInput,
  key: Buffer,
): MissionObservationMilestoneV1 | null {
  const row = recordOf(input);
  if (!row || !exactKeys(row, MILESTONE_INPUT_KEYS) || !boundedIdentifier(input.milestoneId) ||
    !new Set<MissionObservationMilestoneStatus>([
      'pending', 'in-progress', 'proposed', 'paused', 'skipped', 'blocked', 'done',
    ]).has(input.status) || typeof input.verificationPassed !== 'boolean') return null;
  const proposalAbsent = input.proposalId === null;
  if (!proposalAbsent && !boundedIdentifier(input.proposalId)) return null;
  const proposalStatuses = new Set<MissionObservationProposalStatus>([
    'pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed',
  ]);
  if ((proposalAbsent && input.proposalStatus !== null) ||
    (!proposalAbsent && (input.proposalStatus === null || !proposalStatuses.has(input.proposalStatus)))) return null;
  if ((input.verificationDigest !== null && !SHA256_RE.test(input.verificationDigest)) ||
    (input.realizedMergeDigest !== null && !SHA256_RE.test(input.realizedMergeDigest)) ||
    (input.exactRevision !== null && !REVISION_RE.test(input.exactRevision)) ||
    (input.mergeSource !== null && input.mergeSource !== 'local-default-branch' && input.mergeSource !== 'github-host')) {
    return null;
  }
  if (proposalAbsent && (input.verificationPassed || input.verificationDigest !== null ||
    input.mergeSource !== null || input.exactRevision !== null || input.realizedMergeDigest !== null)) return null;
  if (input.verificationPassed !== (input.verificationDigest !== null)) return null;
  const mergeFieldsPresent = input.mergeSource !== null && input.exactRevision !== null &&
    input.realizedMergeDigest !== null;
  const mergeFieldsAbsent = input.mergeSource === null && input.exactRevision === null &&
    input.realizedMergeDigest === null;
  if (!mergeFieldsPresent && !mergeFieldsAbsent) return null;
  const engineeringRealized = input.proposalStatus === 'applied' && input.verificationPassed && mergeFieldsPresent;
  return {
    milestoneRef: hmac(key, 'ashlr:mission-observation:milestone-ref:v1', input.milestoneId),
    status: input.status,
    proposalRef: proposalAbsent
      ? null
      : hmac(key, 'ashlr:mission-observation:proposal-ref:v1', input.proposalId),
    proposalStatus: input.proposalStatus,
    verificationPassed: input.verificationPassed,
    verificationDigest: input.verificationDigest,
    mergeSource: input.mergeSource,
    exactRevision: input.exactRevision,
    realizedMergeDigest: input.realizedMergeDigest,
    engineeringRealized,
  };
}

function normalizeNode(
  input: MissionObservationNodeInput,
  key: Buffer,
): MissionObservationNodeV1 | null {
  const row = recordOf(input);
  if (!row || !exactKeys(row, NODE_INPUT_KEYS) || !KEY_RE.test(input.nodeKey) ||
    (input.kind !== 'work' && input.kind !== 'human-gate') ||
    !Array.isArray(input.blockedBy) || input.blockedBy.length > MAX_BLOCKED_BY ||
    !Array.isArray(input.milestones) || input.milestones.length > MAX_MILESTONES_PER_NODE) return null;
  const statuses = new Set<MissionObservationNodeStatus>([
    'blocked', 'ready', 'active', 'proposed', 'awaiting-human', 'complete', 'failed',
  ]);
  if (!statuses.has(input.status)) return null;
  const blockedBy = [...input.blockedBy];
  if (blockedBy.some((dependency) => !KEY_RE.test(dependency)) ||
    new Set(blockedBy).size !== blockedBy.length) return null;
  blockedBy.sort(codeUnitCompare);
  if ((input.status === 'blocked') !== (blockedBy.length > 0)) return null;

  if (input.kind === 'human-gate') {
    if (input.goalId !== null || input.goalRecordDigest !== null || input.milestones.length !== 0 ||
      (input.status !== 'blocked' && input.status !== 'awaiting-human')) return null;
    return {
      nodeKey: input.nodeKey,
      kind: input.kind,
      status: input.status,
      blockedBy,
      goalRef: null,
      goalRecordDigest: null,
      milestoneCount: 0,
      milestones: [],
      engineeringRealized: false,
    };
  }

  if ((input.goalId === null) !== (input.goalRecordDigest === null) ||
    (input.goalId !== null && !boundedIdentifier(input.goalId)) ||
    (input.goalRecordDigest !== null && !SHA256_RE.test(input.goalRecordDigest)) ||
    (input.goalId === null && input.milestones.length > 0)) return null;
  const milestones: MissionObservationMilestoneV1[] = [];
  for (const milestone of input.milestones) {
    const normalized = normalizeMilestone(milestone, key);
    if (!normalized) return null;
    milestones.push(normalized);
  }
  milestones.sort((left, right) => codeUnitCompare(left.milestoneRef, right.milestoneRef));
  if (milestones.some((milestone, index) =>
    index > 0 && milestone.milestoneRef === milestones[index - 1]!.milestoneRef)) return null;
  const required = milestones.filter((milestone) => milestone.status !== 'skipped');
  const engineeringRealized = required.length > 0 &&
    required.every((milestone) => milestone.engineeringRealized);
  if ((input.status === 'complete') !== engineeringRealized) return null;
  return {
    nodeKey: input.nodeKey,
    kind: input.kind,
    status: input.status,
    blockedBy,
    goalRef: input.goalId === null
      ? null
      : hmac(key, 'ashlr:mission-observation:goal-ref:v1', input.goalId),
    goalRecordDigest: input.goalRecordDigest,
    milestoneCount: milestones.length,
    milestones,
    engineeringRealized,
  };
}

function engineeringStatusOf(nodes: readonly MissionObservationNodeV1[]): MissionObservationEngineeringStatus {
  if (nodes.some((node) => node.status === 'failed')) return 'failed';
  if (nodes.every((node) => node.status === 'complete')) return 'complete';
  if (nodes.some((node) => node.status === 'active' || node.status === 'proposed')) return 'in-progress';
  if (nodes.some((node) => node.status === 'awaiting-human')) return 'awaiting-human';
  if (nodes.some((node) => node.status === 'ready')) return 'ready';
  return 'blocked';
}

type UnsignedReceipt = Omit<MissionObservationReceiptV1, 'receiptDigest' | 'attestation'>;

function snapshotPayload(receipt: Pick<
  MissionObservationReceiptV1,
  | 'captureKind' | 'missionKey' | 'graphDigest' | 'briefingDigest'
  | 'enrollmentSourceDigest' | 'goalSourceDigest' | 'proposalSourceDigest'
  | 'sourceComplete' | 'engineeringStatus' | 'businessOutcomeStatus'
  | 'humanDecisionEvidenceComplete' | 'outcomeEvidenceComplete' | 'nodeCount' | 'nodes'
>): unknown[] {
  return [
    receipt.captureKind, receipt.missionKey, receipt.graphDigest, receipt.briefingDigest,
    receipt.enrollmentSourceDigest, receipt.goalSourceDigest, receipt.proposalSourceDigest,
    receipt.sourceComplete, receipt.engineeringStatus, receipt.businessOutcomeStatus,
    receipt.humanDecisionEvidenceComplete, receipt.outcomeEvidenceComplete,
    receipt.nodeCount, receipt.nodes,
  ];
}

function receiptPayload(receipt: UnsignedReceipt): unknown[] {
  return [
    receipt.schemaVersion, receipt.protocol, receipt.recordType, receipt.authority,
    receipt.planningAuthority, receipt.executionAuthority, receipt.proposalAuthority,
    receipt.mergeAuthority, receipt.releaseAuthority, receipt.deployAuthority,
    receipt.externalMutationAuthority, receipt.learningAuthority, receipt.policyEligible,
    receipt.attestationAuthority, receipt.verifierIsolated, receipt.recordedAt,
    ...snapshotPayload(receipt), receipt.snapshotDigest, receipt.receiptId,
  ];
}

function createWithKey(
  input: MissionObservationReceiptInput,
  key: Buffer,
): MissionObservationReceiptV1 | null {
  const inputRow = recordOf(input);
  if (key.length !== 32 || !inputRow || !exactKeys(inputRow, RECEIPT_INPUT_KEYS) ||
    !canonicalTimestamp(input.recordedAt) ||
    input.captureKind !== 'explicit-reconcile' || !KEY_RE.test(input.missionKey) ||
    !SHA256_RE.test(input.graphDigest) || !validSource(input.enrollmentSource) ||
    !validSource(input.goalSource) || !validSource(input.proposalSource) ||
    !Array.isArray(input.nodes) || input.nodes.length < 1 || input.nodes.length > MAX_MISSION_NODES) return null;
  const briefingDigest = missionObservationBriefingDigest(input.briefing);
  if (!briefingDigest || !validSource(input.briefingSource) ||
    !equalDigest(input.briefingSource.digest, briefingDigest)) return null;
  const nodes: MissionObservationNodeV1[] = [];
  let totalMilestones = 0;
  for (const node of input.nodes) {
    const normalized = normalizeNode(node, key);
    if (!normalized) return null;
    totalMilestones += normalized.milestoneCount;
    if (totalMilestones > MAX_TOTAL_MILESTONES) return null;
    nodes.push(normalized);
  }
  nodes.sort((left, right) => codeUnitCompare(left.nodeKey, right.nodeKey));
  if (nodes.some((node, index) => index > 0 && node.nodeKey === nodes[index - 1]!.nodeKey)) return null;
  const engineeringStatus = engineeringStatusOf(nodes);
  const semantic = {
    captureKind: input.captureKind,
    missionKey: input.missionKey,
    graphDigest: input.graphDigest,
    briefingDigest,
    enrollmentSourceDigest: input.enrollmentSource.digest,
    goalSourceDigest: input.goalSource.digest,
    proposalSourceDigest: input.proposalSource.digest,
    sourceComplete: true as const,
    engineeringStatus,
    businessOutcomeStatus: 'not-observed' as const,
    humanDecisionEvidenceComplete: false as const,
    outcomeEvidenceComplete: false as const,
    nodeCount: nodes.length,
    nodes,
  };
  const snapshotDigest = sha('ashlr:mission-observation:snapshot:v1', snapshotPayload(semantic));
  const receiptId = sha('ashlr:mission-observation:receipt-id:v1', [input.graphDigest, snapshotDigest]);
  const unsigned: UnsignedReceipt = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    recordType: RECORD_TYPE,
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    externalMutationAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    attestationAuthority: 'host-shared-hmac',
    verifierIsolated: false,
    recordedAt: input.recordedAt,
    ...semantic,
    snapshotDigest,
    receiptId,
  };
  const receiptDigest = sha('ashlr:mission-observation:receipt:v1', receiptPayload(unsigned));
  const complete: MissionObservationReceiptV1 = {
    ...unsigned,
    receiptDigest,
    attestation: hmac(key, 'ashlr:mission-observation:attestation:v1', [
      receiptDigest,
      ...receiptPayload(unsigned),
    ]),
  };
  return Buffer.byteLength(`${JSON.stringify(complete)}\n`, 'utf8') <= MAX_RECORD_BYTES
    ? complete
    : null;
}

function parseNode(value: unknown): MissionObservationNodeV1 | null {
  const row = recordOf(value);
  if (!row || !exactKeys(row, NODE_KEYS) || typeof row['nodeKey'] !== 'string' ||
    !KEY_RE.test(row['nodeKey']) ||
    (row['kind'] !== 'work' && row['kind'] !== 'human-gate') ||
    !Array.isArray(row['blockedBy']) || row['blockedBy'].length > MAX_BLOCKED_BY ||
    !Array.isArray(row['milestones']) || row['milestones'].length > MAX_MILESTONES_PER_NODE ||
    !Number.isSafeInteger(row['milestoneCount']) || row['milestoneCount'] !== row['milestones'].length ||
    typeof row['engineeringRealized'] !== 'boolean') return null;
  const status = row['status'] as MissionObservationNodeStatus;
  if (!new Set<MissionObservationNodeStatus>([
    'blocked', 'ready', 'active', 'proposed', 'awaiting-human', 'complete', 'failed',
  ]).has(status)) return null;
  const blockedBy = row['blockedBy'] as unknown[];
  if (blockedBy.some((entry) => typeof entry !== 'string' || !KEY_RE.test(entry)) ||
    blockedBy.some((entry, index) => index > 0 && String(blockedBy[index - 1]) >= String(entry)) ||
    ((status === 'blocked') !== (blockedBy.length > 0))) return null;
  const milestones: MissionObservationMilestoneV1[] = [];
  for (const value of row['milestones']) {
    const milestone = recordOf(value);
    if (!milestone || !exactKeys(milestone, MILESTONE_KEYS) ||
      typeof milestone['milestoneRef'] !== 'string' || !SHA256_RE.test(milestone['milestoneRef']) ||
      typeof milestone['verificationPassed'] !== 'boolean' ||
      typeof milestone['engineeringRealized'] !== 'boolean') return null;
    const milestoneStatus = milestone['status'] as MissionObservationMilestoneStatus;
    const proposalStatus = milestone['proposalStatus'] as MissionObservationProposalStatus | null;
    if (!new Set<MissionObservationMilestoneStatus>([
      'pending', 'in-progress', 'proposed', 'paused', 'skipped', 'blocked', 'done',
    ]).has(milestoneStatus) || (proposalStatus !== null && !new Set<MissionObservationProposalStatus>([
      'pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed',
    ]).has(proposalStatus))) return null;
    const parsed = milestone as unknown as MissionObservationMilestoneV1;
    if ((parsed.proposalRef !== null && !SHA256_RE.test(parsed.proposalRef)) ||
      (parsed.verificationDigest !== null && !SHA256_RE.test(parsed.verificationDigest)) ||
      (parsed.realizedMergeDigest !== null && !SHA256_RE.test(parsed.realizedMergeDigest)) ||
      (parsed.exactRevision !== null && !REVISION_RE.test(parsed.exactRevision)) ||
      (parsed.mergeSource !== null && parsed.mergeSource !== 'local-default-branch' && parsed.mergeSource !== 'github-host') ||
      parsed.verificationPassed !== (parsed.verificationDigest !== null)) return null;
    const proposalAbsent = parsed.proposalRef === null;
    if ((proposalAbsent && parsed.proposalStatus !== null) ||
      (!proposalAbsent && parsed.proposalStatus === null) ||
      (proposalAbsent && (parsed.verificationPassed || parsed.verificationDigest !== null ||
        parsed.mergeSource !== null || parsed.exactRevision !== null || parsed.realizedMergeDigest !== null))) return null;
    const mergePresent = parsed.mergeSource !== null && parsed.exactRevision !== null && parsed.realizedMergeDigest !== null;
    const mergeAbsent = parsed.mergeSource === null && parsed.exactRevision === null && parsed.realizedMergeDigest === null;
    if ((!mergePresent && !mergeAbsent) || parsed.engineeringRealized !== (
      parsed.proposalStatus === 'applied' && parsed.verificationPassed && mergePresent
    )) return null;
    milestones.push({ ...parsed });
  }
  if (milestones.some((milestone, index) =>
    index > 0 && milestone.milestoneRef <= milestones[index - 1]!.milestoneRef)) return null;
  const node = row as unknown as MissionObservationNodeV1;
  if (node.kind === 'human-gate') {
    if (node.goalRef !== null || node.goalRecordDigest !== null || milestones.length !== 0 ||
      node.engineeringRealized || (status !== 'blocked' && status !== 'awaiting-human')) return null;
  } else {
    if ((node.goalRef === null) !== (node.goalRecordDigest === null) ||
      (node.goalRef !== null && !SHA256_RE.test(node.goalRef)) ||
      (node.goalRecordDigest !== null && !SHA256_RE.test(node.goalRecordDigest))) return null;
    const required = milestones.filter((milestone) => milestone.status !== 'skipped');
    const realized = required.length > 0 && required.every((milestone) => milestone.engineeringRealized);
    if (node.engineeringRealized !== realized || ((status === 'complete') !== realized)) return null;
  }
  return {
    nodeKey: node.nodeKey,
    kind: node.kind,
    status,
    blockedBy: [...node.blockedBy],
    goalRef: node.goalRef,
    goalRecordDigest: node.goalRecordDigest,
    milestoneCount: milestones.length,
    milestones,
    engineeringRealized: node.engineeringRealized,
  };
}

function reconstructWithKey(value: unknown, key: Buffer): MissionObservationReceiptV1 | null {
  const row = recordOf(value);
  if (key.length !== 32 || !row || !exactKeys(row, RECEIPT_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== PROTOCOL || row['recordType'] !== RECORD_TYPE ||
    row['authority'] !== 'observation-only' || row['planningAuthority'] !== false ||
    row['executionAuthority'] !== false || row['proposalAuthority'] !== false ||
    row['mergeAuthority'] !== false || row['releaseAuthority'] !== false ||
    row['deployAuthority'] !== false || row['externalMutationAuthority'] !== false ||
    row['learningAuthority'] !== false || row['policyEligible'] !== false ||
    row['attestationAuthority'] !== 'host-shared-hmac' || row['verifierIsolated'] !== false ||
    !canonicalTimestamp(row['recordedAt']) || row['captureKind'] !== 'explicit-reconcile' ||
    typeof row['missionKey'] !== 'string' || !KEY_RE.test(row['missionKey']) ||
    row['sourceComplete'] !== true || row['businessOutcomeStatus'] !== 'not-observed' ||
    row['humanDecisionEvidenceComplete'] !== false || row['outcomeEvidenceComplete'] !== false ||
    !Number.isSafeInteger(row['nodeCount']) || !Array.isArray(row['nodes']) ||
    row['nodeCount'] !== row['nodes'].length || row['nodes'].length < 1 ||
    row['nodes'].length > MAX_MISSION_NODES) return null;
  for (const field of [
    'graphDigest', 'briefingDigest', 'enrollmentSourceDigest', 'goalSourceDigest',
    'proposalSourceDigest', 'snapshotDigest', 'receiptId', 'receiptDigest', 'attestation',
  ] as const) {
    if (typeof row[field] !== 'string' || !SHA256_RE.test(row[field])) return null;
  }
  const nodes: MissionObservationNodeV1[] = [];
  let totalMilestones = 0;
  for (const value of row['nodes']) {
    const node = parseNode(value);
    if (!node) return null;
    totalMilestones += node.milestoneCount;
    if (totalMilestones > MAX_TOTAL_MILESTONES) return null;
    nodes.push(node);
  }
  if (nodes.some((node, index) => index > 0 && node.nodeKey <= nodes[index - 1]!.nodeKey)) return null;
  const engineeringStatus = engineeringStatusOf(nodes);
  if (row['engineeringStatus'] !== engineeringStatus) return null;
  const unsigned: UnsignedReceipt = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    recordType: RECORD_TYPE,
    authority: 'observation-only',
    planningAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deployAuthority: false,
    externalMutationAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    attestationAuthority: 'host-shared-hmac',
    verifierIsolated: false,
    recordedAt: row['recordedAt'] as string,
    captureKind: 'explicit-reconcile',
    missionKey: row['missionKey'] as string,
    graphDigest: row['graphDigest'] as string,
    briefingDigest: row['briefingDigest'] as string,
    enrollmentSourceDigest: row['enrollmentSourceDigest'] as string,
    goalSourceDigest: row['goalSourceDigest'] as string,
    proposalSourceDigest: row['proposalSourceDigest'] as string,
    sourceComplete: true,
    engineeringStatus,
    businessOutcomeStatus: 'not-observed',
    humanDecisionEvidenceComplete: false,
    outcomeEvidenceComplete: false,
    nodeCount: nodes.length,
    nodes,
    snapshotDigest: row['snapshotDigest'] as string,
    receiptId: row['receiptId'] as string,
  };
  const snapshotDigest = sha('ashlr:mission-observation:snapshot:v1', snapshotPayload(unsigned));
  const receiptId = sha('ashlr:mission-observation:receipt-id:v1', [unsigned.graphDigest, snapshotDigest]);
  const receiptDigest = sha('ashlr:mission-observation:receipt:v1', receiptPayload(unsigned));
  const attestation = hmac(key, 'ashlr:mission-observation:attestation:v1', [
    receiptDigest,
    ...receiptPayload(unsigned),
  ]);
  if (!equalDigest(row['snapshotDigest'], snapshotDigest) || !equalDigest(row['receiptId'], receiptId) ||
    !equalDigest(row['receiptDigest'], receiptDigest) || !equalDigest(row['attestation'], attestation)) return null;
  return { ...unsigned, receiptDigest, attestation };
}

function receiptCodec(key: Buffer): ImmutablePrivateRecordCodec<MissionObservationReceiptV1> {
  return {
    parse: (value) => reconstructWithKey(value, key),
    serialize: (receipt) => `${JSON.stringify(receipt)}\n`,
    recordId: (receipt) => receipt.receiptId,
    recordFileName: (receipt) => `${receipt.receiptId}.json`,
    isRecordFileName: (fileName) => /^[a-f0-9]{64}\.json$/.test(fileName),
    stageToken: (receipt) => hmac(
      key,
      'ashlr:mission-observation:publication-stage:v1',
      receipt.receiptId,
    ).slice(0, 32),
    // receiptId binds every semantic field. A later identical capture may have
    // a different wall clock and must replay the earliest persisted observation.
    equivalent: (left, right) => equalDigest(left.receiptId, right.receiptId),
    compare: (left, right) => codeUnitCompare(left.recordedAt, right.recordedAt) ||
      codeUnitCompare(left.receiptId, right.receiptId),
  };
}

export function missionObservationReceiptRootPath(): string {
  return resolve(join(homedir(), '.ashlr', 'mission-receipts'));
}

function storeConfig(
  mode: 'write' | 'read',
  suppliedKey?: Buffer,
): ImmutablePrivateRecordStoreConfig<MissionObservationReceiptV1> {
  const anchorPath = resolve(join(homedir(), '.ashlr'));
  return {
    label: 'mission observation receipt',
    anchorPath,
    rootPath: missionObservationReceiptRootPath(),
    lockFileName: '.mission-receipts.lock',
    maxRecordBytes: MAX_RECORD_BYTES,
    defaultMaxFiles: 4_096,
    hardMaxFiles: 25_000,
    defaultMaxBytes: 64 * 1024 * 1024,
    hardMaxBytes: 256 * 1024 * 1024,
    codecForWrite: () => {
      if (mode !== 'write') return null;
      const key = suppliedKey ?? loadExistingProvenanceKey();
      return key?.length === 32 ? receiptCodec(key) : null;
    },
    codecForRead: () => {
      if (mode !== 'read') return null;
      const key = suppliedKey ?? loadExistingProvenanceKeyReadOnly();
      return key?.length === 32 ? receiptCodec(key) : null;
    },
  };
}

/** Create an authenticated receipt in memory without persisting it. */
export function createMissionObservationReceipt(
  input: MissionObservationReceiptInput,
): MissionObservationReceiptV1 | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key?.length === 32 ? createWithKey(input, key) : null;
  } catch {
    return null;
  }
}

/** Verify a receipt with the existing key. This never creates a key or store. */
export function verifyMissionObservationReceipt(value: unknown): MissionObservationReceiptV1 | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key?.length === 32 ? reconstructWithKey(value, key) : null;
  } catch {
    return null;
  }
}

function sourcesComplete(input: MissionObservationReceiptInput): boolean {
  return validSource(input.briefingSource) && validSource(input.enrollmentSource) && validSource(input.goalSource) &&
    validSource(input.proposalSource);
}

/** Persist one immutable receipt and return the exact point-read record. */
export function recordMissionObservationReceipt(
  input: MissionObservationReceiptInput,
  options: { lockWaitMs?: number } = {},
): MissionObservationReceiptRecordResult {
  try {
    const row = recordOf(input);
    if (!row || !exactKeys(row, RECEIPT_INPUT_KEYS)) {
      return { disposition: 'invalid', receipt: null };
    }
    if (!sourcesComplete(input)) {
      return { disposition: 'source-degraded', receipt: null };
    }
  } catch {
    return { disposition: 'invalid', receipt: null };
  }
  let key: Buffer | null;
  try { key = loadExistingProvenanceKey(); } catch { key = null; }
  if (!key || key.length !== 32) return { disposition: 'key-unavailable', receipt: null };
  const receipt = createWithKey(input, key);
  if (!receipt) return { disposition: 'invalid', receipt: null };
  const disposition = writeImmutablePrivateRecord(storeConfig('write', key), receipt, options);
  if (disposition !== 'recorded' && disposition !== 'replayed') {
    return {
      disposition: disposition === 'conflicted'
        ? 'conflicted'
        : disposition === 'invalid'
          ? 'invalid'
          : 'persistence-failed',
      receipt: null,
    };
  }
  const point = readImmutablePrivateRecordPoint(
    storeConfig('read', key),
    receipt.receiptId,
    `${receipt.receiptId}.json`,
  );
  if (point.sourceState !== 'healthy' || !point.exactReadComplete || !point.record ||
    !equalDigest(point.record.receiptId, receipt.receiptId)) {
    return { disposition: 'persistence-failed', receipt: null };
  }
  return { disposition, receipt: point.record };
}

/** Bounded stable ledger read. `requireComplete` should be true for consumers. */
export function readMissionObservationReceipts(
  options: ImmutablePrivateRecordReadOptions = {},
): MissionObservationReceiptReadResult {
  const result = readImmutablePrivateRecords(storeConfig('read'), options);
  return {
    receipts: result.records,
    sourceState: result.sourceState,
    sourcePresent: result.sourcePresent,
    complete: result.complete,
    stopReasons: result.stopReasons,
    filesRead: result.filesRead,
    bytesRead: result.bytesRead,
    invalidFiles: result.invalidFiles,
    limitExceeded: result.limitExceeded,
  };
}

/** Exact point read; it does not claim aggregate ledger completeness. */
export function readMissionObservationReceiptPoint(
  receiptId: string,
): ImmutablePrivateRecordPointReadResult<MissionObservationReceiptV1> {
  return readImmutablePrivateRecordPoint(
    storeConfig('read'),
    receiptId,
    `${receiptId}.json`,
  );
}

/** Conservative cleanup/finalization for authenticated interrupted publications. */
export function recoverMissionObservationReceiptStore(): ImmutablePrivateRecordRecoveryDisposition {
  return recoverImmutablePrivateRecordStore(storeConfig('write'));
}
