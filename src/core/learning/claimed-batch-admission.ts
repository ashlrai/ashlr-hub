import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadExistingProvenanceKey, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  generatedRepairGenerationId,
  generatedRepairGenerationIds,
} from '../fleet/generated-repair-lifecycle.js';
import { isTrustedGeneratedRepairItem } from '../fleet/self-heal-trust.js';
import { existingWorkItemObjectiveHash } from '../fleet/work-item-objective.js';
import type {
  QueueClaimGeneration,
  WorkQueueCoordinator,
} from '../seams/work-queue-coordinator.js';
import {
  canonicalEnrollmentPath,
  canonicalFilesystemPathIdentity,
  readEnrollmentRegistry,
} from '../sandbox/policy.js';
import type { WorkItem } from '../types.js';
import {
  readImmutablePrivateRecordPoint,
  readImmutablePrivateRecords,
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordReadOptions,
  type ImmutablePrivateRecordReadResult,
  type ImmutablePrivateRecordReadStopReason,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { policyAssignmentUnitId } from './policy-assignment-identity.js';

const PROTOCOL = 'claimed-batch-admission-v1' as const;
const COMMIT_PROTOCOL = 'claimed-batch-admission-commit-v1' as const;
const SHA256_RE = /^[a-f0-9]{64}$/;
const POLICY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_MEMBERS = 512;
const MAX_SERIALIZED_BYTES = 128 * 1024;
const MAX_ID_BYTES = 1_024;
const MAX_TEXT_BYTES = 256 * 1024;
const MEMBER_KEYS = ['admissionUnitId', 'expectedAssignmentUnitId', 'workSource'] as const;
const RECEIPT_KEYS = [
  'admissionOccurrenceDigest',
  'admissionPolicyDigest',
  'assignmentDenominatorComplete',
  'attestation',
  'attestationAuthority',
  'authority',
  'batchAssignmentExpectationComplete',
  'batchDenominatorComplete',
  'batchId',
  'campaignDenominatorComplete',
  'campaignDigest',
  'causalDenominatorComplete',
  'causalIdentifiability',
  'commitSemantics',
  'eligibilityPopulationDigest',
  'executionAuthority',
  'leaseAuthorityAtCommit',
  'leaseAuthorityAtReturn',
  'learningAuthority',
  'learningEpoch',
  'memberCount',
  'members',
  'orderingEvidence',
  'policyEligible',
  'policyVersion',
  'preExposureVerified',
  'protocol',
  'queueAtomicDecision',
  'receiptDigest',
  'recordedAt',
  'schemaVersion',
  'verifierIsolated',
] as const;
const COMMIT_KEYS = [
  'admissionOccurrenceDigest',
  'attestation',
  'authority',
  'batchId',
  'commitDigest',
  'executionAuthority',
  'protocol',
  'receiptDigest',
  'schemaVersion',
] as const;
const REPAIR_METADATA_KEYS = [
  'repairRootId',
  'repairRootAuthorityId',
  'repairDepth',
  'repairHandoffId',
  'repairGenerationId',
  'repairTreatmentUnitId',
  'repairTreatment',
  'repairParentItemId',
  'repairParentSource',
  'repairParentBackend',
  'repairParentTier',
  'repairParentObjectiveHash',
] as const satisfies readonly (keyof WorkItem)[];
const WORK_SOURCES = new Set<WorkItem['source']>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint',
  'goal', 'hygiene', 'invent',
]);

export interface ClaimedBatchAdmissionMemberV1 {
  admissionUnitId: string;
  expectedAssignmentUnitId: string;
  workSource: WorkItem['source'];
}

export interface ClaimedBatchAdmissionInput {
  campaignDigest: string;
  admissionPolicyDigest: string;
  policyVersion: string;
  learningEpoch: string;
  items: readonly WorkItem[];
}

type ClaimedBatchAdmissionDraftInput = ClaimedBatchAdmissionInput & {
  recordedAt: string;
  admissionOccurrenceDigest: string;
};

export type ClaimedBatchAdmissionDisposition =
  | 'recorded'
  | 'replayed'
  | 'conflicted'
  | 'invalid'
  | 'duplicate-claim'
  | 'fence-mismatch'
  | 'persistence-failed';

export type ClaimedBatchAdmissionResult =
  | {
      disposition: Extract<ClaimedBatchAdmissionDisposition, 'recorded' | 'replayed'>;
      receipt: ClaimedBatchAdmissionV1;
    }
  | {
      disposition: Exclude<ClaimedBatchAdmissionDisposition, 'recorded' | 'replayed'>;
      receipt: null;
    };

export interface ExpectedPolicyAssignmentIdentityInput {
  repo: string;
  workItemId: string;
  workSource: WorkItem['source'];
  workItemGenerationId: string;
  objectiveHash: string;
  campaignDigest: string;
  eligibilityPopulationDigest: string;
  policyVersion: string;
  learningEpoch: string;
}

export interface ClaimedBatchAdmissionV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  executionAuthority: false;
  learningAuthority: false;
  policyEligible: false;
  causalIdentifiability: 'not-identifiable';
  commitSemantics: 'historical-exact-generation-fence';
  attestationAuthority: 'host-shared-hmac';
  verifierIsolated: false;
  queueAtomicDecision: false;
  leaseAuthorityAtCommit: false;
  leaseAuthorityAtReturn: false;
  orderingEvidence: 'daemon-observed-post-fence-pre-dispatch';
  batchDenominatorComplete: true;
  batchAssignmentExpectationComplete: true;
  campaignDenominatorComplete: false;
  causalDenominatorComplete: false;
  assignmentDenominatorComplete: false;
  preExposureVerified: false;
  recordedAt: string;
  admissionOccurrenceDigest: string;
  batchId: string;
  campaignDigest: string;
  admissionPolicyDigest: string;
  eligibilityPopulationDigest: string;
  policyVersion: string;
  learningEpoch: string;
  memberCount: number;
  members: ClaimedBatchAdmissionMemberV1[];
  receiptDigest: string;
  attestation: string;
}

export interface ClaimedBatchAdmissionCommitV1 {
  schemaVersion: 1;
  protocol: typeof COMMIT_PROTOCOL;
  authority: 'observation-only';
  executionAuthority: false;
  batchId: string;
  admissionOccurrenceDigest: string;
  receiptDigest: string;
  commitDigest: string;
  attestation: string;
}

export type ClaimedBatchAdmissionReadStopReason =
  | ImmutablePrivateRecordReadStopReason
  | 'missing-store'
  | 'uncommitted-admission'
  | 'orphaned-commit'
  | 'commit-mismatch';

export interface ClaimedBatchAdmissionReadResult
  extends Omit<ImmutablePrivateRecordReadResult<ClaimedBatchAdmissionV1>, 'stopReasons'> {
  stopReasons: ClaimedBatchAdmissionReadStopReason[];
}

interface DerivedMember {
  repo: string;
  workItemId: string;
  workSource: WorkItem['source'];
  workItemGenerationId: string;
  objectiveHash: string;
  admissionUnitId: string;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function hmacTuple(key: Buffer, domain: string, values: readonly unknown[]): string {
  return createHmac('sha256', key)
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

function shaTuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([domain, ...values]), 'utf8')
    .digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function exactClaimGenerationDigest(
  key: Buffer,
  claimedIds: readonly string[],
  generations: readonly QueueClaimGeneration[],
): string | null {
  if (key.length !== 32 || generations.length !== claimedIds.length) return null;
  const claimedSet = new Set(claimedIds);
  const seen = new Set<string>();
  const canonical: Array<[string, string]> = [];
  for (const generation of generations) {
    if (
      !claimedSet.has(generation.itemId) ||
      seen.has(generation.itemId) ||
      !SHA256_RE.test(generation.generationId)
    ) return null;
    seen.add(generation.itemId);
    canonical.push([generation.itemId, generation.generationId]);
  }
  if (seen.size !== claimedSet.size) return null;
  canonical.sort(([left], [right]) => left.localeCompare(right));
  return hmacTuple(key, 'ashlr:claimed-batch-claim-generation:v1', canonical);
}

function canonicalRepo(value: unknown): string | null {
  if (!boundedString(value, MAX_ID_BYTES)) return null;
  const canonical = canonicalFilesystemPathIdentity(value);
  if (!canonical || Buffer.byteLength(canonical, 'utf8') > MAX_ID_BYTES) return null;
  try {
    return statSync(canonical).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

function validContext(
  campaignDigest: unknown,
  admissionPolicyDigest: unknown,
  policyVersion: unknown,
  learningEpoch: unknown,
): boolean {
  return SHA256_RE.test(typeof campaignDigest === 'string' ? campaignDigest : '') &&
    SHA256_RE.test(typeof admissionPolicyDigest === 'string' ? admissionPolicyDigest : '') &&
    POLICY_RE.test(typeof policyVersion === 'string' ? policyVersion : '') &&
    POLICY_RE.test(typeof learningEpoch === 'string' ? learningEpoch : '');
}

function hasRepairMetadata(item: WorkItem): boolean {
  return REPAIR_METADATA_KEYS.some((key) => item[key] !== undefined);
}

function semanticGeneration(
  item: WorkItem,
  repo: string,
  objectiveHash: string,
  key: Buffer,
): { current: string; lineage: string[] } | null {
  const repair = isTrustedGeneratedRepairItem(item) || hasRepairMetadata(item);
  if (repair) {
    if (item.repairHandoffId === undefined || item.repairGenerationId === undefined) return null;
    const current = generatedRepairGenerationId(item);
    const lineage = [...new Set(generatedRepairGenerationIds(item))].sort();
    if (!current || !SHA256_RE.test(current) || lineage.length < 1 ||
      lineage.some((generation) => !SHA256_RE.test(generation)) ||
      !lineage.includes(current)) return null;
    return { current, lineage };
  }
  return {
    current: hmacTuple(key, 'ashlr:claimed-batch-semantic-generation:v1', [
      repo,
      item.id,
      item.source,
      objectiveHash,
    ]),
    lineage: [],
  };
}

function deriveMember(
  item: WorkItem,
  input: Pick<
    ClaimedBatchAdmissionDraftInput,
    'campaignDigest' | 'admissionPolicyDigest' | 'policyVersion' | 'learningEpoch'
  >,
  key: Buffer,
  enrolledRepos: ReadonlySet<string>,
): DerivedMember | null {
  if (!boundedString(item.id, MAX_ID_BYTES) ||
    !boundedString(item.title, MAX_TEXT_BYTES) ||
    !boundedString(item.detail, MAX_TEXT_BYTES) ||
    !WORK_SOURCES.has(item.source)) return null;
  const repo = canonicalRepo(item.repo);
  if (!repo || !enrolledRepos.has(repo)) return null;
  const canonicalItem = { ...item, repo };
  const objectiveHash = existingWorkItemObjectiveHash(canonicalItem);
  if (!objectiveHash || !SHA256_RE.test(objectiveHash)) return null;
  const generation = semanticGeneration(canonicalItem, repo, objectiveHash, key);
  if (!generation) return null;
  const admissionUnitId = hmacTuple(key, 'ashlr:claimed-batch-admission-unit:v1', [
    repo,
    item.id,
    item.source,
    generation.current,
    generation.lineage,
    objectiveHash,
    input.campaignDigest,
    input.admissionPolicyDigest,
    input.policyVersion,
    input.learningEpoch,
  ]);
  return {
    repo,
    workItemId: item.id,
    workSource: item.source,
    workItemGenerationId: generation.current,
    objectiveHash,
    admissionUnitId,
  };
}

function expectedAssignmentWithKey(
  input: ExpectedPolicyAssignmentIdentityInput,
  key: Buffer,
): string | null {
  const repo = canonicalRepo(input.repo);
  if (!repo || key.length !== 32 ||
    !boundedString(input.workItemId, MAX_ID_BYTES) ||
    !WORK_SOURCES.has(input.workSource) ||
    !SHA256_RE.test(input.workItemGenerationId) ||
    !SHA256_RE.test(input.objectiveHash) ||
    !SHA256_RE.test(input.campaignDigest) ||
    !SHA256_RE.test(input.eligibilityPopulationDigest) ||
    !POLICY_RE.test(input.policyVersion) ||
    !POLICY_RE.test(input.learningEpoch)) return null;
  return policyAssignmentUnitId(key, { ...input, repo });
}

export function expectedPolicyAssignmentUnitId(
  input: ExpectedPolicyAssignmentIdentityInput,
): string | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key ? expectedAssignmentWithKey(input, key) : null;
  } catch {
    return null;
  }
}

function receiptBody(
  receipt: Omit<ClaimedBatchAdmissionV1, 'receiptDigest' | 'attestation'>,
): readonly unknown[] {
  return [
    receipt.schemaVersion,
    receipt.protocol,
    receipt.authority,
    receipt.executionAuthority,
    receipt.learningAuthority,
    receipt.policyEligible,
    receipt.causalIdentifiability,
    receipt.commitSemantics,
    receipt.attestationAuthority,
    receipt.verifierIsolated,
    receipt.queueAtomicDecision,
    receipt.leaseAuthorityAtCommit,
    receipt.leaseAuthorityAtReturn,
    receipt.orderingEvidence,
    receipt.batchDenominatorComplete,
    receipt.batchAssignmentExpectationComplete,
    receipt.campaignDenominatorComplete,
    receipt.causalDenominatorComplete,
    receipt.assignmentDenominatorComplete,
    receipt.preExposureVerified,
    receipt.recordedAt,
    receipt.admissionOccurrenceDigest,
    receipt.batchId,
    receipt.campaignDigest,
    receipt.admissionPolicyDigest,
    receipt.eligibilityPopulationDigest,
    receipt.policyVersion,
    receipt.learningEpoch,
    receipt.memberCount,
    receipt.members.map((member) => [
      member.admissionUnitId,
      member.expectedAssignmentUnitId,
      member.workSource,
    ]),
  ];
}

function createWithKey(input: ClaimedBatchAdmissionDraftInput, key: Buffer): ClaimedBatchAdmissionV1 | null {
  if (key.length !== 32 ||
    !canonicalTimestamp(input.recordedAt) ||
    !SHA256_RE.test(input.admissionOccurrenceDigest) ||
    !validContext(
      input.campaignDigest,
      input.admissionPolicyDigest,
      input.policyVersion,
      input.learningEpoch,
    ) ||
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > MAX_MEMBERS) return null;
  const enrollment = readEnrollmentRegistry();
  if (enrollment.state !== 'ready') return null;
  const enrolledRepos = new Set(enrollment.repos.flatMap((repo) => {
    if (canonicalEnrollmentPath(repo) !== repo) return [];
    const canonical = canonicalRepo(repo);
    return canonical ? [canonical] : [];
  }));
  if (enrolledRepos.size !== enrollment.repos.length) return null;
  const boundInput: ClaimedBatchAdmissionDraftInput = {
    ...input,
    campaignDigest: hmacTuple(
      key,
      'ashlr:claimed-batch-campaign-context:v1',
      [input.campaignDigest],
    ),
    admissionPolicyDigest: hmacTuple(
      key,
      'ashlr:claimed-batch-admission-policy-context:v1',
      [input.admissionPolicyDigest],
    ),
  };
  const derived = input.items.map((item) => deriveMember(item, boundInput, key, enrolledRepos));
  if (derived.some((member) => member === null)) return null;
  const complete = derived as DerivedMember[];
  complete.sort((left, right) =>
    left.admissionUnitId < right.admissionUnitId
      ? -1
      : left.admissionUnitId > right.admissionUnitId ? 1 : 0);
  if (complete.some((member, index) =>
    index > 0 && member.admissionUnitId === complete[index - 1]?.admissionUnitId)) return null;
  const eligibilityPopulationDigest = hmacTuple(
    key,
    'ashlr:claimed-batch-population:v1',
    [
      boundInput.campaignDigest,
      boundInput.admissionPolicyDigest,
      boundInput.policyVersion,
      boundInput.learningEpoch,
      boundInput.admissionOccurrenceDigest,
      complete.map((member) => [member.admissionUnitId, member.workSource]),
    ],
  );
  const members = complete.map((member): ClaimedBatchAdmissionMemberV1 | null => {
    const expectedAssignmentUnitId = expectedAssignmentWithKey({
      repo: member.repo,
      workItemId: member.workItemId,
      workSource: member.workSource,
      workItemGenerationId: member.workItemGenerationId,
      objectiveHash: member.objectiveHash,
      campaignDigest: boundInput.campaignDigest,
      eligibilityPopulationDigest,
      policyVersion: boundInput.policyVersion,
      learningEpoch: boundInput.learningEpoch,
    }, key);
    return expectedAssignmentUnitId
      ? { admissionUnitId: member.admissionUnitId, expectedAssignmentUnitId, workSource: member.workSource }
      : null;
  });
  if (members.some((member) => member === null)) return null;
  const canonicalMembers = members as ClaimedBatchAdmissionMemberV1[];
  const batchId = hmacTuple(key, 'ashlr:claimed-batch-slot:v1', [
    boundInput.campaignDigest,
    boundInput.admissionPolicyDigest,
    eligibilityPopulationDigest,
    boundInput.policyVersion,
    boundInput.learningEpoch,
    boundInput.admissionOccurrenceDigest,
  ]);
  const unsigned: Omit<ClaimedBatchAdmissionV1, 'receiptDigest' | 'attestation'> = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    causalIdentifiability: 'not-identifiable',
    commitSemantics: 'historical-exact-generation-fence',
    attestationAuthority: 'host-shared-hmac',
    verifierIsolated: false,
    queueAtomicDecision: false,
    leaseAuthorityAtCommit: false,
    leaseAuthorityAtReturn: false,
    orderingEvidence: 'daemon-observed-post-fence-pre-dispatch',
    batchDenominatorComplete: true,
    batchAssignmentExpectationComplete: true,
    campaignDenominatorComplete: false,
    causalDenominatorComplete: false,
    assignmentDenominatorComplete: false,
    preExposureVerified: false,
    recordedAt: input.recordedAt,
    admissionOccurrenceDigest: input.admissionOccurrenceDigest,
    batchId,
    campaignDigest: boundInput.campaignDigest,
    admissionPolicyDigest: boundInput.admissionPolicyDigest,
    eligibilityPopulationDigest,
    policyVersion: boundInput.policyVersion,
    learningEpoch: boundInput.learningEpoch,
    memberCount: canonicalMembers.length,
    members: canonicalMembers,
  };
  const receiptDigest = shaTuple('ashlr:claimed-batch-receipt:v1', receiptBody(unsigned));
  const attestation = hmacTuple(key, 'ashlr:claimed-batch-attestation:v1', [
    receiptDigest,
    ...receiptBody(unsigned),
  ]);
  return { ...unsigned, receiptDigest, attestation };
}

function reconstructWithKey(value: unknown, key: Buffer): ClaimedBatchAdmissionV1 | null {
  if (key.length !== 32 ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, RECEIPT_KEYS)) return null;
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== 1 ||
    row['protocol'] !== PROTOCOL ||
    row['authority'] !== 'observation-only' ||
    row['executionAuthority'] !== false ||
    row['learningAuthority'] !== false ||
    row['policyEligible'] !== false ||
    row['causalIdentifiability'] !== 'not-identifiable' ||
    row['commitSemantics'] !== 'historical-exact-generation-fence' ||
    row['attestationAuthority'] !== 'host-shared-hmac' ||
    row['verifierIsolated'] !== false ||
    row['queueAtomicDecision'] !== false ||
    row['leaseAuthorityAtCommit'] !== false ||
    row['leaseAuthorityAtReturn'] !== false ||
    row['orderingEvidence'] !== 'daemon-observed-post-fence-pre-dispatch' ||
    row['batchDenominatorComplete'] !== true ||
    row['batchAssignmentExpectationComplete'] !== true ||
    row['campaignDenominatorComplete'] !== false ||
    row['causalDenominatorComplete'] !== false ||
    row['assignmentDenominatorComplete'] !== false ||
    row['preExposureVerified'] !== false ||
    !canonicalTimestamp(row['recordedAt']) ||
    !SHA256_RE.test(typeof row['admissionOccurrenceDigest'] === 'string'
      ? row['admissionOccurrenceDigest']
      : '') ||
    !validContext(
      row['campaignDigest'],
      row['admissionPolicyDigest'],
      row['policyVersion'],
      row['learningEpoch'],
    ) ||
    !SHA256_RE.test(typeof row['batchId'] === 'string' ? row['batchId'] : '') ||
    !SHA256_RE.test(typeof row['eligibilityPopulationDigest'] === 'string'
      ? row['eligibilityPopulationDigest']
      : '') ||
    !Number.isSafeInteger(row['memberCount']) ||
    (row['memberCount'] as number) < 1 ||
    (row['memberCount'] as number) > MAX_MEMBERS ||
    !Array.isArray(row['members']) ||
    row['members'].length !== row['memberCount'] ||
    !SHA256_RE.test(typeof row['receiptDigest'] === 'string' ? row['receiptDigest'] : '') ||
    !SHA256_RE.test(typeof row['attestation'] === 'string' ? row['attestation'] : '')) return null;
  const members: ClaimedBatchAdmissionMemberV1[] = [];
  for (const value of row['members']) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !exactKeys(value, MEMBER_KEYS)) return null;
    const member = value as Record<string, unknown>;
    if (!SHA256_RE.test(typeof member['admissionUnitId'] === 'string' ? member['admissionUnitId'] : '') ||
      !SHA256_RE.test(typeof member['expectedAssignmentUnitId'] === 'string'
        ? member['expectedAssignmentUnitId']
        : '') ||
      !WORK_SOURCES.has(member['workSource'] as WorkItem['source'])) return null;
    members.push({
      admissionUnitId: member['admissionUnitId'] as string,
      expectedAssignmentUnitId: member['expectedAssignmentUnitId'] as string,
      workSource: member['workSource'] as WorkItem['source'],
    });
  }
  if (members.some((member, index) =>
    index > 0 && member.admissionUnitId <= members[index - 1]!.admissionUnitId)) return null;
  const eligibilityPopulationDigest = hmacTuple(
    key,
    'ashlr:claimed-batch-population:v1',
    [
      row['campaignDigest'],
      row['admissionPolicyDigest'],
      row['policyVersion'],
      row['learningEpoch'],
      row['admissionOccurrenceDigest'],
      members.map((member) => [member.admissionUnitId, member.workSource]),
    ],
  );
  if (!equalDigest(row['eligibilityPopulationDigest'] as string, eligibilityPopulationDigest)) return null;
  const batchId = hmacTuple(key, 'ashlr:claimed-batch-slot:v1', [
    row['campaignDigest'],
    row['admissionPolicyDigest'],
    eligibilityPopulationDigest,
    row['policyVersion'],
    row['learningEpoch'],
    row['admissionOccurrenceDigest'],
  ]);
  if (!equalDigest(row['batchId'] as string, batchId)) return null;
  const unsigned: Omit<ClaimedBatchAdmissionV1, 'receiptDigest' | 'attestation'> = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    learningAuthority: false,
    policyEligible: false,
    causalIdentifiability: 'not-identifiable',
    commitSemantics: 'historical-exact-generation-fence',
    attestationAuthority: 'host-shared-hmac',
    verifierIsolated: false,
    queueAtomicDecision: false,
    leaseAuthorityAtCommit: false,
    leaseAuthorityAtReturn: false,
    orderingEvidence: 'daemon-observed-post-fence-pre-dispatch',
    batchDenominatorComplete: true,
    batchAssignmentExpectationComplete: true,
    campaignDenominatorComplete: false,
    causalDenominatorComplete: false,
    assignmentDenominatorComplete: false,
    preExposureVerified: false,
    recordedAt: row['recordedAt'] as string,
    admissionOccurrenceDigest: row['admissionOccurrenceDigest'] as string,
    batchId,
    campaignDigest: row['campaignDigest'] as string,
    admissionPolicyDigest: row['admissionPolicyDigest'] as string,
    eligibilityPopulationDigest,
    policyVersion: row['policyVersion'] as string,
    learningEpoch: row['learningEpoch'] as string,
    memberCount: members.length,
    members,
  };
  const receiptDigest = shaTuple('ashlr:claimed-batch-receipt:v1', receiptBody(unsigned));
  if (!equalDigest(row['receiptDigest'] as string, receiptDigest)) return null;
  const attestation = hmacTuple(key, 'ashlr:claimed-batch-attestation:v1', [
    receiptDigest,
    ...receiptBody(unsigned),
  ]);
  if (!equalDigest(row['attestation'] as string, attestation)) return null;
  return { ...unsigned, receiptDigest, attestation };
}

function commitBody(
  commit: Omit<ClaimedBatchAdmissionCommitV1, 'commitDigest' | 'attestation'>,
): readonly unknown[] {
  return [
    commit.schemaVersion,
    commit.protocol,
    commit.authority,
    commit.executionAuthority,
    commit.batchId,
    commit.admissionOccurrenceDigest,
    commit.receiptDigest,
  ];
}

function createCommitWithKey(
  receipt: ClaimedBatchAdmissionV1,
  key: Buffer,
): ClaimedBatchAdmissionCommitV1 | null {
  const verified = reconstructWithKey(receipt, key);
  if (!verified) return null;
  const unsigned: Omit<ClaimedBatchAdmissionCommitV1, 'commitDigest' | 'attestation'> = {
    schemaVersion: 1,
    protocol: COMMIT_PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    batchId: verified.batchId,
    admissionOccurrenceDigest: verified.admissionOccurrenceDigest,
    receiptDigest: verified.receiptDigest,
  };
  const commitDigest = shaTuple('ashlr:claimed-batch-admission-commit:v1', commitBody(unsigned));
  const attestation = hmacTuple(key, 'ashlr:claimed-batch-admission-commit-attestation:v1', [
    commitDigest,
    ...commitBody(unsigned),
  ]);
  return { ...unsigned, commitDigest, attestation };
}

function reconstructCommitWithKey(
  value: unknown,
  key: Buffer,
): ClaimedBatchAdmissionCommitV1 | null {
  if (
    key.length !== 32 ||
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, COMMIT_KEYS)
  ) return null;
  const row = value as Record<string, unknown>;
  if (
    row['schemaVersion'] !== 1 ||
    row['protocol'] !== COMMIT_PROTOCOL ||
    row['authority'] !== 'observation-only' ||
    row['executionAuthority'] !== false ||
    !SHA256_RE.test(typeof row['batchId'] === 'string' ? row['batchId'] : '') ||
    !SHA256_RE.test(typeof row['admissionOccurrenceDigest'] === 'string'
      ? row['admissionOccurrenceDigest']
      : '') ||
    !SHA256_RE.test(typeof row['receiptDigest'] === 'string' ? row['receiptDigest'] : '') ||
    !SHA256_RE.test(typeof row['commitDigest'] === 'string' ? row['commitDigest'] : '') ||
    !SHA256_RE.test(typeof row['attestation'] === 'string' ? row['attestation'] : '')
  ) return null;
  const unsigned: Omit<ClaimedBatchAdmissionCommitV1, 'commitDigest' | 'attestation'> = {
    schemaVersion: 1,
    protocol: COMMIT_PROTOCOL,
    authority: 'observation-only',
    executionAuthority: false,
    batchId: row['batchId'] as string,
    admissionOccurrenceDigest: row['admissionOccurrenceDigest'] as string,
    receiptDigest: row['receiptDigest'] as string,
  };
  const commitDigest = shaTuple('ashlr:claimed-batch-admission-commit:v1', commitBody(unsigned));
  if (!equalDigest(row['commitDigest'] as string, commitDigest)) return null;
  const attestation = hmacTuple(key, 'ashlr:claimed-batch-admission-commit-attestation:v1', [
    commitDigest,
    ...commitBody(unsigned),
  ]);
  if (!equalDigest(row['attestation'] as string, attestation)) return null;
  return { ...unsigned, commitDigest, attestation };
}

export function verifyClaimedBatchAdmission(value: unknown): ClaimedBatchAdmissionV1 | null {
  try {
    const key = loadExistingProvenanceKeyReadOnly();
    return key ? reconstructWithKey(value, key) : null;
  } catch {
    return null;
  }
}

export function encodeClaimedBatchAdmission(value: unknown): string | null {
  const verified = verifyClaimedBatchAdmission(value);
  return verified ? JSON.stringify(verified) : null;
}

export function decodeClaimedBatchAdmission(serialized: string): ClaimedBatchAdmissionV1 | null {
  try {
    if (typeof serialized !== 'string' ||
      Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) return null;
    const parsed: unknown = JSON.parse(serialized);
    const verified = verifyClaimedBatchAdmission(parsed);
    if (!verified || JSON.stringify(verified) !== serialized) return null;
    return verified;
  } catch {
    return null;
  }
}

function admissionRoot(): string {
  return resolve(join(homedir(), '.ashlr', 'claimed-batch-admissions'));
}

function admissionCommitRoot(): string {
  return resolve(join(homedir(), '.ashlr', 'claimed-batch-admission-commits'));
}

export function claimedBatchAdmissionRootPath(): string {
  return admissionRoot();
}

export function claimedBatchAdmissionCommitRootPath(): string {
  return admissionCommitRoot();
}

function admissionCodec(key: Buffer): ImmutablePrivateRecordCodec<ClaimedBatchAdmissionV1> {
  return {
    parse: (value) => reconstructWithKey(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.batchId,
    recordFileName: (record) => `${record.batchId}.json`,
    isRecordFileName: (fileName) => /^[a-f0-9]{64}\.json$/.test(fileName),
    stageToken: (record) => hmacTuple(
      key,
      'ashlr:claimed-batch-publication-stage:v1',
      [record.batchId],
    ).slice(0, 32),
    // A retry of one exact claim generation may observe a later wall clock.
    // The authenticated batch slot binds every semantic field except recordedAt.
    equivalent: (left, right) => equalDigest(left.batchId, right.batchId),
    compare: (left, right) =>
      left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0,
  };
}

function admissionCommitCodec(
  key: Buffer,
): ImmutablePrivateRecordCodec<ClaimedBatchAdmissionCommitV1> {
  return {
    parse: (value) => reconstructCommitWithKey(value, key),
    serialize: (record) => `${JSON.stringify(record)}\n`,
    recordId: (record) => record.batchId,
    recordFileName: (record) => `${record.batchId}.json`,
    isRecordFileName: (fileName) => /^[a-f0-9]{64}\.json$/.test(fileName),
    stageToken: (record) => hmacTuple(
      key,
      'ashlr:claimed-batch-commit-publication-stage:v1',
      [record.batchId],
    ).slice(0, 32),
    equivalent: (left, right) =>
      equalDigest(left.commitDigest, right.commitDigest) &&
      equalDigest(left.attestation, right.attestation),
    compare: (left, right) =>
      left.batchId < right.batchId ? -1 : left.batchId > right.batchId ? 1 : 0,
  };
}

function admissionStoreConfig(
  mode: 'write' | 'read',
): ImmutablePrivateRecordStoreConfig<ClaimedBatchAdmissionV1> {
  const anchorPath = resolve(join(homedir(), '.ashlr'));
  return {
    label: 'claimed batch admission',
    anchorPath,
    rootPath: admissionRoot(),
    lockFileName: '.claimed-batch-admissions.lock',
    maxRecordBytes: MAX_SERIALIZED_BYTES + 1,
    defaultMaxFiles: 4_096,
    hardMaxFiles: 16_384,
    defaultMaxBytes: 16 * 1024 * 1024,
    hardMaxBytes: 128 * 1024 * 1024,
    codecForWrite: () => {
      if (mode !== 'write') return null;
      const key = loadExistingProvenanceKey();
      return key?.length === 32 ? admissionCodec(key) : null;
    },
    codecForRead: () => {
      if (mode !== 'read') return null;
      const key = loadExistingProvenanceKeyReadOnly();
      return key?.length === 32 ? admissionCodec(key) : null;
    },
  };
}

function admissionCommitStoreConfig(
  mode: 'write' | 'read',
): ImmutablePrivateRecordStoreConfig<ClaimedBatchAdmissionCommitV1> {
  const anchorPath = resolve(join(homedir(), '.ashlr'));
  return {
    label: 'claimed batch admission commit',
    anchorPath,
    rootPath: admissionCommitRoot(),
    lockFileName: '.claimed-batch-admission-commits.lock',
    maxRecordBytes: MAX_SERIALIZED_BYTES + 1,
    defaultMaxFiles: 4_096,
    hardMaxFiles: 16_384,
    defaultMaxBytes: 16 * 1024 * 1024,
    hardMaxBytes: 128 * 1024 * 1024,
    codecForWrite: () => {
      if (mode !== 'write') return null;
      const key = loadExistingProvenanceKey();
      return key?.length === 32 ? admissionCommitCodec(key) : null;
    },
    codecForRead: () => {
      if (mode !== 'read') return null;
      const key = loadExistingProvenanceKeyReadOnly();
      return key?.length === 32 ? admissionCommitCodec(key) : null;
    },
  };
}

export function admitClaimedBatchAfterExactFence(
  coordinator: Pick<
    WorkQueueCoordinator,
    'fenceClaimGenerations' | 'releaseClaimGenerations'
  >,
  machineId: string,
  input: ClaimedBatchAdmissionInput,
  expectedGenerations: readonly QueueClaimGeneration[],
  options: {
    lockWaitMs?: number;
    aggregateReadMaxFiles?: number;
    aggregateReadMaxBytes?: number;
  } = {},
): ClaimedBatchAdmissionResult {
  const release = (): void => {
    try { coordinator.releaseClaimGenerations(expectedGenerations, machineId); } catch { /* best effort */ }
  };
  if (!Array.isArray(input.items) || input.items.length < 1) {
    return { disposition: 'invalid', receipt: null };
  }
  const claimedIds = input.items.map((item) => item.id);
  const claimedSet = new Set(claimedIds);
  if (claimedSet.size !== claimedIds.length) {
    release();
    return { disposition: 'duplicate-claim', receipt: null };
  }
  let key: Buffer | null;
  try { key = loadExistingProvenanceKey(); } catch { key = null; }
  if (!key || key.length !== 32) {
    release();
    return { disposition: 'invalid', receipt: null };
  }
  const expectedOccurrenceDigest = Array.isArray(expectedGenerations)
    ? exactClaimGenerationDigest(key, claimedIds, expectedGenerations)
    : null;
  if (!expectedOccurrenceDigest) {
    release();
    return { disposition: 'fence-mismatch', receipt: null };
  }
  let initialGenerations: QueueClaimGeneration[];
  try {
    initialGenerations = coordinator.fenceClaimGenerations(expectedGenerations, machineId);
  } catch {
    release();
    return { disposition: 'fence-mismatch', receipt: null };
  }
  const admissionOccurrenceDigest = Array.isArray(initialGenerations)
    ? exactClaimGenerationDigest(key, claimedIds, initialGenerations)
    : null;
  if (
    !admissionOccurrenceDigest ||
    !equalDigest(admissionOccurrenceDigest, expectedOccurrenceDigest)
  ) {
    release();
    return { disposition: 'fence-mismatch', receipt: null };
  }
  // Node's directory fsync fallback cannot yet prove entry durability on Windows.
  if (process.platform === 'win32') {
    release();
    return { disposition: 'persistence-failed', receipt: null };
  }
  const receipt = createWithKey({
    ...input,
    recordedAt: new Date().toISOString(),
    admissionOccurrenceDigest,
  }, key);
  if (!receipt) {
    release();
    return { disposition: 'invalid', receipt: null };
  }
  const write = writeImmutablePrivateRecord(admissionStoreConfig('write'), receipt, options);
  if (write !== 'recorded' && write !== 'replayed') {
    release();
    return {
      disposition: write === 'conflicted' ? 'conflicted' : 'persistence-failed',
      receipt: null,
    };
  }
  const observationRead = readImmutablePrivateRecordPoint(
    admissionStoreConfig('read'),
    receipt.batchId,
    `${receipt.batchId}.json`,
  );
  const persisted = observationRead.sourceState === 'healthy' &&
    observationRead.exactReadComplete &&
    observationRead.record &&
    equalDigest(observationRead.record.batchId, receipt.batchId)
    ? observationRead.record
    : null;
  if (!persisted) {
    release();
    return { disposition: 'persistence-failed', receipt: null };
  }
  let finalGenerations: QueueClaimGeneration[];
  try {
    finalGenerations = coordinator.fenceClaimGenerations(expectedGenerations, machineId);
  } catch {
    finalGenerations = [];
  }
  const finalOccurrenceDigest = Array.isArray(finalGenerations)
    ? exactClaimGenerationDigest(key, claimedIds, finalGenerations)
    : null;
  if (!finalOccurrenceDigest || !equalDigest(finalOccurrenceDigest, admissionOccurrenceDigest)) {
    release();
    return { disposition: 'fence-mismatch', receipt: null };
  }
  const commit = createCommitWithKey(persisted, key);
  if (!commit) {
    release();
    return { disposition: 'persistence-failed', receipt: null };
  }
  const commitWrite = writeImmutablePrivateRecord(
    admissionCommitStoreConfig('write'),
    commit,
    options,
  );
  if (commitWrite !== 'recorded' && commitWrite !== 'replayed') {
    release();
    return {
      disposition: commitWrite === 'conflicted' ? 'conflicted' : 'persistence-failed',
      receipt: null,
    };
  }
  const commitRead = readImmutablePrivateRecordPoint(
    admissionCommitStoreConfig('read'),
    commit.batchId,
    `${commit.batchId}.json`,
  );
  const exactCommit = commitRead.sourceState === 'healthy' &&
    commitRead.exactReadComplete &&
    commitRead.record &&
    equalDigest(commitRead.record.batchId, persisted.batchId) &&
    equalDigest(commitRead.record.admissionOccurrenceDigest, persisted.admissionOccurrenceDigest) &&
    equalDigest(commitRead.record.receiptDigest, persisted.receiptDigest);
  const aggregate = readClaimedBatchAdmissions({
    requireComplete: false,
    maxFiles: options.aggregateReadMaxFiles,
    maxBytes: options.aggregateReadMaxBytes,
  });
  const storageDegraded = aggregate.stopReasons.some((reason) =>
    reason !== 'uncommitted-admission' &&
    reason !== 'file-limit' &&
    reason !== 'byte-limit');
  const admitted = exactCommit && !storageDegraded ? persisted : null;
  if (!admitted) {
    release();
    return { disposition: 'persistence-failed', receipt: null };
  }
  return { disposition: write, receipt: admitted };
}

export function readClaimedBatchAdmissions(
  options: ImmutablePrivateRecordReadOptions = {},
): ClaimedBatchAdmissionReadResult {
  const rawOptions = { ...options, requireComplete: false };
  const observations = readImmutablePrivateRecords(admissionStoreConfig('read'), rawOptions);
  const commits = readImmutablePrivateRecords(admissionCommitStoreConfig('read'), rawOptions);
  const stopReasons = new Set<ClaimedBatchAdmissionReadStopReason>([
    ...observations.stopReasons,
    ...commits.stopReasons,
  ]);
  if (
    (observations.sourceState === 'missing') !==
    (commits.sourceState === 'missing')
  ) stopReasons.add('missing-store');
  const commitsByBatch = new Map(commits.records.map((commit) => [commit.batchId, commit]));
  const matchedCommits = new Set<string>();
  const records: ClaimedBatchAdmissionV1[] = [];
  const joinCoverageComplete = [...observations.stopReasons, ...commits.stopReasons]
    .every((reason) => reason !== 'file-limit' && reason !== 'byte-limit');
  for (const receipt of observations.records) {
    const commit = commitsByBatch.get(receipt.batchId);
    if (!commit) {
      if (joinCoverageComplete) stopReasons.add('uncommitted-admission');
      continue;
    }
    matchedCommits.add(commit.batchId);
    if (
      !equalDigest(commit.admissionOccurrenceDigest, receipt.admissionOccurrenceDigest) ||
      !equalDigest(commit.receiptDigest, receipt.receiptDigest)
    ) {
      stopReasons.add('commit-mismatch');
      continue;
    }
    records.push(receipt);
  }
  if (
    joinCoverageComplete &&
    commits.records.some((commit) => !matchedCommits.has(commit.batchId))
  ) {
    stopReasons.add('orphaned-commit');
  }
  const filesRead = observations.filesRead + commits.filesRead;
  const bytesRead = observations.bytesRead + commits.bytesRead;
  if (options.maxFiles !== undefined && filesRead > Math.max(0, Math.floor(options.maxFiles))) {
    stopReasons.add('file-limit');
  }
  if (options.maxBytes !== undefined && bytesRead > Math.max(0, Math.floor(options.maxBytes))) {
    stopReasons.add('byte-limit');
  }
  const sourcePresent = observations.sourcePresent || commits.sourcePresent;
  const degraded = stopReasons.size > 0;
  return {
    records: options.requireComplete === true && degraded ? [] : records,
    sourceState: degraded ? 'degraded' : sourcePresent ? 'healthy' : 'missing',
    sourcePresent,
    complete: sourcePresent && !degraded,
    stopReasons: [...stopReasons],
    filesRead,
    bytesRead,
    invalidFiles: observations.invalidFiles + commits.invalidFiles,
    limitExceeded:
      observations.limitExceeded ||
      commits.limitExceeded ||
      stopReasons.has('file-limit') ||
      stopReasons.has('byte-limit'),
  };
}
