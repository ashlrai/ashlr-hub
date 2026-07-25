/**
 * Candidate-bound, observation-only calibration for the exact M356 shadow
 * retrieval kernel.
 *
 * Inputs remain private. The projection returns aggregate metadata only and
 * deliberately cannot establish heldout independence, runtime build identity,
 * routing authority, or activation authority.
 */

import { createHash } from 'node:crypto';

import {
  projectExternalSkillCandidateMetadata,
} from './external-skill-audit.js';
import {
  verifyTrustedExternalSkillAuditReceipt,
  type ExternalSkillAuditReceiptReason,
} from './external-skill-audit-receipt.js';
import {
  MAX_SELECTED_SKILLS,
  rankSkillRetrievalCandidates,
  SKILL_RETRIEVAL_POLICY_VERSION,
  skillRetrievalQueryFingerprint,
  type SkillRetrievalQuery,
  type SkillRetrievalScoringCandidate,
} from './skill-retrieval.js';

const PROTOCOL = 'skill-retrieval-calibration-v1' as const;
const SETTLEMENT_WINDOW_MS = 2 * 60 * 1_000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_NODES = 1_500_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANDIDATES = 256;
const MAX_CASES = 10_000;
const MAX_TOTAL_TEXT_CHARS = 5 * 1024 * 1024;
const MAX_VERSION_CHARS = 128;
const MAX_SKILL_NAME_CHARS = 128;
const MAX_NAME_CHARS = 120;
const MAX_SUMMARY_CHARS = 320;
const MAX_QUERY_TEXT_CHARS = 640;
const MAX_LIST_ITEMS = 16;
const MAX_LIST_ITEM_CHARS = 80;
const MAX_QUERY_TAGS = 50;
const REQUIRED_POSITIVE_PER_CANDIDATE = 50;
const REQUIRED_NEGATIVE_PER_CANDIDATE = 60;
const REQUIRED_GROUPS_PER_KIND = 5;
const MAX_GROUP_SHARE = 0.25;
const REQUIRED_POSITIVE_LOWER_BOUND = 0.8;
const REQUIRED_NEGATIVE_LOWER_BOUND = 0.95;
const ONE_SIDED_95_Z = 1.6448536269514722;

const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const INPUT_KEYS = [
  'asOf', 'auditEvidence', 'candidateSkillBytes', 'firstSnapshotBytes',
  'secondSnapshotBytes',
] as const;
const AUDIT_KEYS = ['receiptBytes', 'reportBytes', 'selectedSkillName'] as const;
const SNAPSHOT_KEYS = [
  'auditBinding', 'candidates', 'cases', 'complete', 'conflictingRows',
  'duplicateRows', 'invalidRows', 'limitExceeded', 'routerPolicyVersion',
  'schemaVersion', 'sourceRevision', 'sourceState',
] as const;
const AUDIT_BINDING_KEYS = [
  'packDigest', 'portablePackDigest', 'receiptDigest', 'reportDigest',
  'selectedSkillContentHash', 'selectedSkillName',
] as const;
const CANDIDATE_KEYS = [
  'candidateId', 'commandKinds', 'name', 'summary', 'tags', 'taskKinds',
] as const;
const CASE_KEYS = [
  'caseId', 'clusterId', 'excludedCandidateId', 'groupId', 'kind', 'observedAt',
  'ownerCandidateId', 'query',
] as const;
const QUERY_KEYS = ['detail', 'route', 'source', 'tags', 'title'] as const;
const ROUTE_KEYS = ['backend', 'model', 'reason', 'tier'] as const;

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer',
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;

export interface SkillRetrievalCalibrationAuditEvidenceV1 {
  reportBytes: Uint8Array;
  receiptBytes: Uint8Array;
  selectedSkillName: string;
}

export interface SkillRetrievalCalibrationAuditBindingV1 {
  reportDigest: string;
  receiptDigest: string;
  packDigest: string;
  portablePackDigest: string;
  selectedSkillName: string;
  selectedSkillContentHash: string;
}

export interface SkillRetrievalCalibrationCandidateV1
  extends SkillRetrievalScoringCandidate {
  candidateId: string;
}

export interface SkillRetrievalCalibrationCaseV1 {
  caseId: string;
  clusterId: string;
  groupId: string;
  kind: 'positive-owner' | 'negative-owner';
  ownerCandidateId: string;
  excludedCandidateId: string | null;
  observedAt: string;
  query: SkillRetrievalQuery;
}

export interface SkillRetrievalCalibrationSnapshotV1 {
  schemaVersion: 1;
  sourceRevision: string;
  routerPolicyVersion: typeof SKILL_RETRIEVAL_POLICY_VERSION;
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  invalidRows: number;
  duplicateRows: number;
  conflictingRows: number;
  limitExceeded: boolean;
  auditBinding: SkillRetrievalCalibrationAuditBindingV1;
  candidates: readonly SkillRetrievalCalibrationCandidateV1[];
  cases: readonly SkillRetrievalCalibrationCaseV1[];
}

export interface EvaluateSkillRetrievalCalibrationInputV1 {
  asOf: string;
  auditEvidence: SkillRetrievalCalibrationAuditEvidenceV1;
  candidateSkillBytes: Uint8Array;
  firstSnapshotBytes: Uint8Array;
  secondSnapshotBytes: Uint8Array;
}

export type SkillRetrievalCalibrationReasonV1 =
  | 'evidence-collected'
  | 'invalid-input'
  | 'snapshot-not-canonical'
  | 'snapshot-mutation'
  | 'source-degraded'
  | 'source-incomplete'
  | 'source-invalid'
  | 'duplicate-input'
  | 'conflicting-input'
  | 'input-limit-exceeded'
  | 'router-policy-mismatch'
  | 'audit-authentication-required'
  | 'audit-binding-mismatch'
  | 'no-settled-cases'
  | 'settlement-window'
  | 'insufficient-sample'
  | 'thresholds-not-met';

export interface SkillRetrievalCalibrationSampleV1 {
  candidates: number;
  settledCases: number;
  excludedCases: number;
  positiveCases: number;
  negativeCases: number;
  candidatesMeetingSampleGate: number;
  candidatesMeetingDiversityGate: number;
  requiredPositivePerCandidate: 50;
  requiredNegativePerCandidate: 60;
  requiredGroupsPerKind: 5;
  maximumGroupShare: 0.25;
}

export interface SkillRetrievalCalibrationRoutingV1 {
  ambiguousCutoffCases: number;
  statisticScope: 'descriptive-wilson-per-candidate';
  positiveSelectedPassed: number;
  positiveSelectedAccuracy: number | null;
  minimumPerCandidatePositiveAccuracy: number | null;
  minimumPerCandidatePositiveDescriptiveWilson: number | null;
  positiveRankOnePassed: number;
  positiveRankOneAccuracy: number | null;
  negativeExcludedPassed: number;
  negativeExcludedAccuracy: number | null;
  minimumPerCandidateNegativeAccuracy: number | null;
  minimumPerCandidateNegativeDescriptiveWilson: number | null;
  requiredPositiveLowerBound: 0.8;
  requiredNegativeLowerBound: 0.95;
}

interface AuthorityBoundaryV1 {
  authority: 'observation-only';
  executionAuthority: false;
  exposureAuthority: false;
  routingAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  proposalAuthority: false;
  verificationAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deploymentAuthority: false;
  transitionAuthority: false;
  revocationAuthority: false;
  auditAuthenticationVerified: boolean;
  scoringKernelEquivalent: true;
  runtimeRouterEquivalent: false;
  runtimeBuildAttestationVerified: false;
  independentHeldoutVerified: false;
  distinctReadReceiptsVerified: false;
  trustedClockVerified: false;
  captureReceiptBindingVerified: false;
  appendOnlyTransparencyVerified: false;
  choiceSetBindingVerified: false;
  sourceCompletenessVerified: false;
  simultaneousConfidenceVerified: false;
  marginalConfidenceVerified: false;
}

export type SkillRetrievalCalibrationProjectionV1 = AuthorityBoundaryV1 & {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  state: 'projected' | 'withheld';
  gate: 'collecting' | 'withheld';
  reason: SkillRetrievalCalibrationReasonV1;
  sourceState: 'declared-healthy' | 'degraded';
  asOf: string | null;
  settledThrough: string | null;
  evidenceRoot: string | null;
  submittedChoiceSetDigest: string | null;
  selectedCandidateBindingVerified: boolean;
  auditReason: ExternalSkillAuditReceiptReason | null;
  sample: SkillRetrievalCalibrationSampleV1 | null;
  routing: SkillRetrievalCalibrationRoutingV1 | null;
  blockers: readonly [
    'capture-receipt-binding-required',
    'runtime-build-attestation-required',
    'independent-heldout-receipt-required',
    'distinct-read-receipts-required',
    'trusted-clock-required',
    'append-only-transparency-required',
    'verifier-owned-completeness-required',
    'simultaneous-confidence-required',
    'independent-observation-provenance-required',
  ];
};

interface NormalizedSnapshot {
  sourceRevision: string;
  auditBinding: SkillRetrievalCalibrationAuditBindingV1;
  candidates: SkillRetrievalCalibrationCandidateV1[];
  cases: SkillRetrievalCalibrationCaseV1[];
}

interface NormalizedInput {
  asOf: string;
  auditEvidence: {
    reportBytes: Buffer;
    receiptBytes: Buffer;
    selectedSkillName: string;
  };
  candidateSkillBytes: Buffer;
  firstSnapshotBytes: Buffer;
  secondSnapshotBytes: Buffer;
}

interface CandidateStats {
  positive: {
    total: number;
    selectedPassed: number;
    rankOnePassed: number;
    groups: Map<string, number>;
  };
  negative: {
    total: number;
    passed: number;
    groups: Map<string, number>;
  };
}

const BLOCKERS = [
  'capture-receipt-binding-required',
  'runtime-build-attestation-required',
  'independent-heldout-receipt-required',
  'distinct-read-receipts-required',
  'trusted-clock-required',
  'append-only-transparency-required',
  'verifier-owned-completeness-required',
  'simultaneous-confidence-required',
  'independent-observation-provenance-required',
] as const;

function authorityBoundary(
  auditAuthenticationVerified = false,
): AuthorityBoundaryV1 {
  return {
    authority: 'observation-only',
    executionAuthority: false,
    exposureAuthority: false,
    routingAuthority: false,
    learningAuthority: false,
    policyAuthority: false,
    promotionAuthority: false,
    proposalAuthority: false,
    verificationAuthority: false,
    mergeAuthority: false,
    releaseAuthority: false,
    deploymentAuthority: false,
    transitionAuthority: false,
    revocationAuthority: false,
    auditAuthenticationVerified,
    scoringKernelEquivalent: true,
    runtimeRouterEquivalent: false,
    runtimeBuildAttestationVerified: false,
    independentHeldoutVerified: false,
    distinctReadReceiptsVerified: false,
    trustedClockVerified: false,
    captureReceiptBindingVerified: false,
    appendOnlyTransparencyVerified: false,
    choiceSetBindingVerified: false,
    sourceCompletenessVerified: false,
    simultaneousConfidenceVerified: false,
    marginalConfidenceVerified: false,
  };
}

function exactPlainRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string')) return null;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])) {
    return null;
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value: unknown, maximum: number, allowEmpty = true): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= maximum &&
    !hasControlCharacter(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function copyBytes(value: unknown, maximum: number): Buffer | null {
  try {
    if (!(value instanceof Uint8Array) ||
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
      TYPED_ARRAY_BUFFER_GETTER === undefined) {
      return null;
    }
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    const backingBuffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    ) as ArrayBufferLike;
    if (byteLength === 0 || byteLength > maximum ||
      (typeof SharedArrayBuffer !== 'undefined' && backingBuffer instanceof SharedArrayBuffer)) {
      return null;
    }
    const copy = Buffer.alloc(byteLength);
    Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
    return copy;
  } catch {
    return null;
  }
}

function normalizeInput(value: unknown): NormalizedInput | null {
  try {
    const input = exactPlainRecord(value, INPUT_KEYS);
    if (input === null || !canonicalTimestamp(input['asOf'])) return null;
    const audit = exactPlainRecord(input['auditEvidence'], AUDIT_KEYS);
    if (audit === null ||
      typeof audit['selectedSkillName'] !== 'string' ||
      audit['selectedSkillName'].length > MAX_SKILL_NAME_CHARS ||
      !SKILL_NAME.test(audit['selectedSkillName'])) {
      return null;
    }
    const reportBytes = copyBytes(audit['reportBytes'], MAX_SNAPSHOT_BYTES);
    const receiptBytes = copyBytes(audit['receiptBytes'], 16 * 1024);
    const candidateSkillBytes = copyBytes(input['candidateSkillBytes'], 256 * 1024);
    const firstSnapshotBytes = copyBytes(input['firstSnapshotBytes'], MAX_SNAPSHOT_BYTES);
    const secondSnapshotBytes = copyBytes(input['secondSnapshotBytes'], MAX_SNAPSHOT_BYTES);
    if (reportBytes === null || receiptBytes === null || candidateSkillBytes === null ||
      firstSnapshotBytes === null || secondSnapshotBytes === null) {
      return null;
    }
    return {
      asOf: input['asOf'],
      auditEvidence: {
        reportBytes,
        receiptBytes,
        selectedSkillName: audit['selectedSkillName'],
      },
      candidateSkillBytes,
      firstSnapshotBytes,
      secondSnapshotBytes,
    };
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string | null {
  let nodes = 0;
  const encode = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new RangeError('limit');
    }
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') {
      return JSON.stringify(current);
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('non-finite');
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      return `[${current.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    }
    if (typeof current !== 'object') throw new TypeError('non-json');
    const record = current as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('prototype');
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(',')}}`;
  };
  try {
    return encode(value, 0);
  } catch {
    return null;
  }
}

function decodeCanonicalSnapshot(bytes: Buffer): unknown | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    const canonical = canonicalJson(value);
    return canonical !== null && Buffer.from(canonical, 'utf8').equals(bytes) ? value : null;
  } catch {
    return null;
  }
}

function normalizeList(value: unknown, maximum = MAX_LIST_ITEMS): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const list: string[] = [];
  for (const entry of value) {
    if (!boundedText(entry, MAX_LIST_ITEM_CHARS, false)) return null;
    list.push(entry);
  }
  const sorted = [...new Set(list)].sort();
  return sorted.length === list.length ? sorted : null;
}

function normalizeQueryTags(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_QUERY_TAGS) return null;
  const tags: string[] = [];
  for (const entry of value) {
    if (!boundedText(entry, MAX_LIST_ITEM_CHARS, false)) return null;
    tags.push(entry);
  }
  return tags;
}

const INVALID_QUERY_TEXT = Symbol('invalid-query-text');

function normalizeNullableQueryText(
  value: unknown,
  allowNull = false,
): string | null | undefined | typeof INVALID_QUERY_TEXT {
  if (value === null) return allowNull ? null : INVALID_QUERY_TEXT;
  if (value === undefined) return undefined;
  return boundedText(value, MAX_QUERY_TEXT_CHARS) ? value : INVALID_QUERY_TEXT;
}

function normalizeQuery(value: unknown): SkillRetrievalQuery | null {
  const record = exactPlainRecord(value, QUERY_KEYS);
  if (record === null) return null;
  const title = normalizeNullableQueryText(record['title']);
  const detail = normalizeNullableQueryText(record['detail']);
  const source = normalizeNullableQueryText(record['source']);
  if (title === INVALID_QUERY_TEXT ||
    detail === INVALID_QUERY_TEXT ||
    source === INVALID_QUERY_TEXT) {
    return null;
  }
  const tags = normalizeQueryTags(record['tags']);
  if (tags === null) return null;
  const routeRecord = exactPlainRecord(record['route'], ROUTE_KEYS);
  if (routeRecord === null) return null;
  const backend = normalizeNullableQueryText(routeRecord['backend'], true);
  const tier = normalizeNullableQueryText(routeRecord['tier'], true);
  const model = normalizeNullableQueryText(routeRecord['model'], true);
  const reason = normalizeNullableQueryText(routeRecord['reason']);
  if (backend === INVALID_QUERY_TEXT ||
    tier === INVALID_QUERY_TEXT ||
    model === INVALID_QUERY_TEXT ||
    reason === INVALID_QUERY_TEXT) {
    return null;
  }
  return {
    ...(typeof title === 'string' ? { title } : {}),
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(typeof source === 'string' ? { source } : {}),
    tags,
    route: {
      backend: backend ?? null,
      tier: tier ?? null,
      model: model ?? null,
      ...(typeof reason === 'string' ? { reason } : {}),
    },
  };
}

function normalizeAuditBinding(value: unknown): SkillRetrievalCalibrationAuditBindingV1 | null {
  const record = exactPlainRecord(value, AUDIT_BINDING_KEYS);
  if (record === null ||
    typeof record['reportDigest'] !== 'string' || !DIGEST.test(record['reportDigest']) ||
    typeof record['receiptDigest'] !== 'string' || !DIGEST.test(record['receiptDigest']) ||
    typeof record['packDigest'] !== 'string' || !DIGEST.test(record['packDigest']) ||
    typeof record['portablePackDigest'] !== 'string' ||
    !DIGEST.test(record['portablePackDigest']) ||
    typeof record['selectedSkillName'] !== 'string' ||
    !SKILL_NAME.test(record['selectedSkillName']) ||
    typeof record['selectedSkillContentHash'] !== 'string' ||
    !DIGEST.test(record['selectedSkillContentHash'])) {
    return null;
  }
  return {
    reportDigest: record['reportDigest'],
    receiptDigest: record['receiptDigest'],
    packDigest: record['packDigest'],
    portablePackDigest: record['portablePackDigest'],
    selectedSkillName: record['selectedSkillName'],
    selectedSkillContentHash: record['selectedSkillContentHash'],
  };
}

function normalizeSnapshot(value: unknown): {
  value: NormalizedSnapshot | null;
  reason: SkillRetrievalCalibrationReasonV1 | null;
} {
  const record = exactPlainRecord(value, SNAPSHOT_KEYS);
  if (record === null || record['schemaVersion'] !== 1 ||
    typeof record['sourceRevision'] !== 'string' ||
    record['sourceRevision'].length > MAX_VERSION_CHARS ||
    !VERSION.test(record['sourceRevision'])) {
    return { value: null, reason: 'source-invalid' };
  }
  if (record['routerPolicyVersion'] !== SKILL_RETRIEVAL_POLICY_VERSION) {
    return { value: null, reason: 'router-policy-mismatch' };
  }
  if (record['sourceState'] === 'degraded') return { value: null, reason: 'source-degraded' };
  if (record['sourceState'] !== 'healthy') return { value: null, reason: 'source-invalid' };
  if (record['complete'] !== true) return { value: null, reason: 'source-incomplete' };
  if (!count(record['invalidRows']) || record['invalidRows'] !== 0) {
    return { value: null, reason: 'source-invalid' };
  }
  if (!count(record['duplicateRows']) || record['duplicateRows'] !== 0) {
    return { value: null, reason: 'duplicate-input' };
  }
  if (!count(record['conflictingRows']) || record['conflictingRows'] !== 0) {
    return { value: null, reason: 'conflicting-input' };
  }
  if (record['limitExceeded'] !== false) {
    return {
      value: null,
      reason: record['limitExceeded'] === true ? 'input-limit-exceeded' : 'source-invalid',
    };
  }
  const auditBinding = normalizeAuditBinding(record['auditBinding']);
  if (auditBinding === null ||
    !Array.isArray(record['candidates']) || record['candidates'].length === 0 ||
    record['candidates'].length > MAX_CANDIDATES ||
    !Array.isArray(record['cases']) || record['cases'].length > MAX_CASES) {
    return { value: null, reason: 'source-invalid' };
  }

  let totalText = 0;
  const candidates: SkillRetrievalCalibrationCandidateV1[] = [];
  const candidateIds = new Set<string>();
  for (const rawCandidate of record['candidates']) {
    const candidate = exactPlainRecord(rawCandidate, CANDIDATE_KEYS);
    if (candidate === null ||
      typeof candidate['candidateId'] !== 'string' || !DIGEST.test(candidate['candidateId']) ||
      candidateIds.has(candidate['candidateId']) ||
      !boundedText(candidate['name'], MAX_NAME_CHARS, false) ||
      !boundedText(candidate['summary'], MAX_SUMMARY_CHARS)) {
      return {
        value: null,
        reason: candidate !== null &&
          typeof candidate['candidateId'] === 'string' &&
          candidateIds.has(candidate['candidateId'])
          ? 'duplicate-input'
          : 'source-invalid',
      };
    }
    const tags = normalizeList(candidate['tags']);
    const taskKinds = normalizeList(candidate['taskKinds']);
    const commandKinds = normalizeList(candidate['commandKinds'], 12);
    if (tags === null || taskKinds === null || commandKinds === null) {
      return { value: null, reason: 'source-invalid' };
    }
    const name = candidate['name'];
    const summary = candidate['summary'];
    totalText += name.length + summary.length +
      [...tags, ...taskKinds, ...commandKinds].reduce((sum, entry) => sum + entry.length, 0);
    if (totalText > MAX_TOTAL_TEXT_CHARS) {
      return { value: null, reason: 'input-limit-exceeded' };
    }
    candidateIds.add(candidate['candidateId']);
    candidates.push({
      candidateId: candidate['candidateId'],
      name,
      summary,
      tags,
      taskKinds,
      commandKinds,
    });
  }
  if (!candidateIds.has(auditBinding.selectedSkillContentHash)) {
    return { value: null, reason: 'audit-binding-mismatch' };
  }

  const cases: SkillRetrievalCalibrationCaseV1[] = [];
  const caseIds = new Set<string>();
  const clusterIds = new Set<string>();
  const semanticCases = new Set<string>();
  for (const rawCase of record['cases']) {
    const calibrationCase = exactPlainRecord(rawCase, CASE_KEYS);
    if (calibrationCase === null ||
      typeof calibrationCase['caseId'] !== 'string' || !DIGEST.test(calibrationCase['caseId']) ||
      typeof calibrationCase['clusterId'] !== 'string' ||
      !DIGEST.test(calibrationCase['clusterId']) ||
      typeof calibrationCase['groupId'] !== 'string' || !DIGEST.test(calibrationCase['groupId']) ||
      caseIds.has(calibrationCase['caseId']) || clusterIds.has(calibrationCase['clusterId']) ||
      (calibrationCase['kind'] !== 'positive-owner' &&
        calibrationCase['kind'] !== 'negative-owner') ||
      typeof calibrationCase['ownerCandidateId'] !== 'string' ||
      !candidateIds.has(calibrationCase['ownerCandidateId']) ||
      !canonicalTimestamp(calibrationCase['observedAt'])) {
      return {
        value: null,
        reason: calibrationCase !== null &&
          ((typeof calibrationCase['caseId'] === 'string' &&
            caseIds.has(calibrationCase['caseId'])) ||
            (typeof calibrationCase['clusterId'] === 'string' &&
              clusterIds.has(calibrationCase['clusterId'])))
          ? 'duplicate-input'
          : 'source-invalid',
      };
    }
    const excludedCandidateId = calibrationCase['excludedCandidateId'];
    if ((calibrationCase['kind'] === 'positive-owner' && excludedCandidateId !== null) ||
      (calibrationCase['kind'] === 'negative-owner' &&
        (typeof excludedCandidateId !== 'string' ||
          !candidateIds.has(excludedCandidateId) ||
          excludedCandidateId === calibrationCase['ownerCandidateId']))) {
      return { value: null, reason: 'source-invalid' };
    }
    const query = normalizeQuery(calibrationCase['query']);
    if (query === null) return { value: null, reason: 'source-invalid' };
    const semanticCase = JSON.stringify([
      calibrationCase['kind'],
      calibrationCase['ownerCandidateId'],
      excludedCandidateId,
      skillRetrievalQueryFingerprint(query),
    ]);
    if (semanticCases.has(semanticCase)) {
      return { value: null, reason: 'duplicate-input' };
    }
    totalText += JSON.stringify(query).length;
    if (totalText > MAX_TOTAL_TEXT_CHARS) {
      return { value: null, reason: 'input-limit-exceeded' };
    }
    caseIds.add(calibrationCase['caseId']);
    clusterIds.add(calibrationCase['clusterId']);
    semanticCases.add(semanticCase);
    cases.push({
      caseId: calibrationCase['caseId'],
      clusterId: calibrationCase['clusterId'],
      groupId: calibrationCase['groupId'],
      kind: calibrationCase['kind'],
      ownerCandidateId: calibrationCase['ownerCandidateId'],
      excludedCandidateId: excludedCandidateId as string | null,
      observedAt: calibrationCase['observedAt'],
      query,
    });
  }

  candidates.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  cases.sort((left, right) => left.caseId.localeCompare(right.caseId));
  return {
    value: {
      sourceRevision: record['sourceRevision'],
      auditBinding,
      candidates,
      cases,
    },
    reason: null,
  };
}

function digest(domain: string, value: Uint8Array | string): string {
  return createHash('sha256').update(domain, 'utf8').update(value).digest('hex');
}

function rate(passed: number, total: number): number | null {
  return total === 0 ? null : Math.round((passed / total) * 1_000_000) / 1_000_000;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function wilsonLowerBound(passed: number, total: number): number | null {
  if (total === 0) return null;
  const proportion = passed / total;
  const zSquared = ONE_SIDED_95_Z * ONE_SIDED_95_Z;
  const denominator = 1 + zSquared / total;
  const center = proportion + zSquared / (2 * total);
  const margin = ONE_SIDED_95_Z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * total)) / total,
  );
  return (center - margin) / denominator;
}

function groupDiversityPass(groups: ReadonlyMap<string, number>, total: number): boolean {
  if (groups.size < REQUIRED_GROUPS_PER_KIND || total === 0) return false;
  return [...groups.values()].every((value) => value / total <= MAX_GROUP_SHARE);
}

function baseResult(
  state: 'projected' | 'withheld',
  gate: 'collecting' | 'withheld',
  reason: SkillRetrievalCalibrationReasonV1,
  sourceState: 'declared-healthy' | 'degraded',
  options: {
    asOf?: string;
    settledThrough?: string;
    evidenceRoot?: string;
    submittedChoiceSetDigest?: string;
    selectedCandidateBindingVerified?: boolean;
    auditReason?: ExternalSkillAuditReceiptReason;
    auditAuthenticationVerified?: boolean;
    sample?: SkillRetrievalCalibrationSampleV1;
    routing?: SkillRetrievalCalibrationRoutingV1;
  } = {},
): SkillRetrievalCalibrationProjectionV1 {
  return {
    ...authorityBoundary(options.auditAuthenticationVerified),
    schemaVersion: 1,
    protocol: PROTOCOL,
    state,
    gate,
    reason,
    sourceState,
    asOf: options.asOf ?? null,
    settledThrough: options.settledThrough ?? null,
    evidenceRoot: options.evidenceRoot ?? null,
    submittedChoiceSetDigest: options.submittedChoiceSetDigest ?? null,
    selectedCandidateBindingVerified: options.selectedCandidateBindingVerified ?? false,
    auditReason: options.auditReason ?? null,
    sample: options.sample ?? null,
    routing: options.routing ?? null,
    blockers: BLOCKERS,
  };
}

export function evaluateSkillRetrievalCalibration(
  input: unknown,
): SkillRetrievalCalibrationProjectionV1 {
  const normalized = normalizeInput(input);
  if (normalized === null) {
    return baseResult('withheld', 'withheld', 'invalid-input', 'degraded');
  }

  const firstValue = decodeCanonicalSnapshot(normalized.firstSnapshotBytes);
  const secondValue = decodeCanonicalSnapshot(normalized.secondSnapshotBytes);
  if (firstValue === null || secondValue === null) {
    return baseResult('withheld', 'withheld', 'snapshot-not-canonical', 'degraded', {
      asOf: normalized.asOf,
    });
  }
  const first = normalizeSnapshot(firstValue);
  const second = normalizeSnapshot(secondValue);
  if (first.value === null || second.value === null) {
    return baseResult(
      'withheld',
      'withheld',
      first.reason ?? second.reason ?? 'source-invalid',
      'degraded',
      { asOf: normalized.asOf },
    );
  }
  if (!normalized.firstSnapshotBytes.equals(normalized.secondSnapshotBytes) ||
    JSON.stringify(first.value) !== JSON.stringify(second.value)) {
    return baseResult('withheld', 'withheld', 'snapshot-mutation', 'degraded', {
      asOf: normalized.asOf,
    });
  }

  const audit = verifyTrustedExternalSkillAuditReceipt(normalized.auditEvidence);
  const auditAuthenticated = audit.state === 'authenticated';
  const binding = first.value.auditBinding;
  const projectedCandidate = projectExternalSkillCandidateMetadata(normalized.candidateSkillBytes);
  const selectedCandidate = first.value.candidates.find(
    (candidate) => candidate.candidateId === binding.selectedSkillContentHash,
  );
  const candidateBytesBound = projectedCandidate !== null &&
    projectedCandidate.contentHash === binding.selectedSkillContentHash &&
    projectedCandidate.name === binding.selectedSkillName &&
    selectedCandidate !== undefined &&
    selectedCandidate.name === projectedCandidate.name &&
    selectedCandidate.summary === projectedCandidate.description &&
    selectedCandidate.tags.length === 0 &&
    selectedCandidate.taskKinds.length === 0 &&
    selectedCandidate.commandKinds.length === 0;
  if (!candidateBytesBound) {
    return baseResult('withheld', 'withheld', 'audit-binding-mismatch', 'degraded', {
      asOf: normalized.asOf,
      auditReason: audit.reason,
      auditAuthenticationVerified: auditAuthenticated,
    });
  }
  const selectedCandidateBindingVerified = auditAuthenticated &&
    candidateBytesBound &&
    binding.reportDigest === audit.reportDigest &&
    binding.receiptDigest === audit.receiptDigest &&
    binding.packDigest === audit.packDigest &&
    binding.portablePackDigest === audit.portablePackDigest &&
    binding.selectedSkillName === audit.selectedSkillName &&
    binding.selectedSkillContentHash === audit.selectedSkillContentHash;
  if (auditAuthenticated && !selectedCandidateBindingVerified) {
    return baseResult('withheld', 'withheld', 'audit-binding-mismatch', 'degraded', {
      asOf: normalized.asOf,
      auditReason: audit.reason,
      auditAuthenticationVerified: true,
    });
  }

  const asOfMs = Date.parse(normalized.asOf);
  if (first.value.cases.some((entry) => Date.parse(entry.observedAt) > asOfMs)) {
    return baseResult('withheld', 'withheld', 'source-invalid', 'degraded', {
      asOf: normalized.asOf,
      auditReason: audit.reason,
      auditAuthenticationVerified: auditAuthenticated,
      selectedCandidateBindingVerified,
    });
  }
  const settledThroughMs = asOfMs - SETTLEMENT_WINDOW_MS;
  const settledThrough = new Date(settledThroughMs).toISOString();
  const settledCases = first.value.cases.filter(
    (entry) => Date.parse(entry.observedAt) <= settledThroughMs,
  );
  const excludedCases = first.value.cases.length - settledCases.length;

  const snapshotDigest = digest(
    'ashlr:skill-retrieval-calibration:snapshot:v1\0',
    normalized.firstSnapshotBytes,
  );
  const submittedChoiceSetDigest = digest(
    'ashlr:skill-retrieval-calibration:choice-set:v1\0',
    JSON.stringify(first.value.candidates),
  );
  const evidenceRoot = digest(
    'ashlr:skill-retrieval-calibration:evidence-root:v1\0',
    JSON.stringify([
      normalized.asOf,
      snapshotDigest,
      submittedChoiceSetDigest,
      audit.state === 'authenticated'
        ? [audit.reportDigest, audit.receiptDigest, audit.selectedSkillContentHash]
        : [audit.reason],
    ]),
  );
  const common = {
    asOf: normalized.asOf,
    settledThrough,
    evidenceRoot,
    submittedChoiceSetDigest,
    selectedCandidateBindingVerified,
    auditReason: audit.reason,
    auditAuthenticationVerified: auditAuthenticated,
  };
  if (settledCases.length === 0) {
    return baseResult(
      'projected',
      'collecting',
      first.value.cases.length === 0 ? 'no-settled-cases' : 'settlement-window',
      'declared-healthy',
      common,
    );
  }

  const stats = new Map<string, CandidateStats>();
  for (const candidate of first.value.candidates) {
    stats.set(candidate.candidateId, {
      positive: { total: 0, selectedPassed: 0, rankOnePassed: 0, groups: new Map() },
      negative: { total: 0, passed: 0, groups: new Map() },
    });
  }
  let positiveCases = 0;
  let positiveSelectedPassed = 0;
  let positiveRankOnePassed = 0;
  let negativeCases = 0;
  let negativeExcludedPassed = 0;
  let ambiguousCutoffCases = 0;

  for (const calibrationCase of settledCases) {
    const ranked = rankSkillRetrievalCandidates(first.value.candidates, calibrationCase.query);
    const byId = new Map(ranked.map((entry) => [entry.candidateId, entry]));
    const selectedIds = new Set(
      ranked.slice(0, MAX_SELECTED_SKILLS).map((entry) => entry.candidateId),
    );
    if (ranked.length > MAX_SELECTED_SKILLS &&
      ranked[MAX_SELECTED_SKILLS - 1]!.score === ranked[MAX_SELECTED_SKILLS]!.score) {
      ambiguousCutoffCases += 1;
    }
    const owner = byId.get(calibrationCase.ownerCandidateId);
    const ownerStats = stats.get(calibrationCase.ownerCandidateId)!;
    if (calibrationCase.kind === 'positive-owner') {
      positiveCases += 1;
      ownerStats.positive.total += 1;
      ownerStats.positive.groups.set(
        calibrationCase.groupId,
        (ownerStats.positive.groups.get(calibrationCase.groupId) ?? 0) + 1,
      );
      const selectedPassed = owner !== undefined &&
        owner.score > 0 &&
        selectedIds.has(calibrationCase.ownerCandidateId);
      const rankOnePassed = owner?.rank === 1 && owner.score > 0;
      if (selectedPassed) {
        positiveSelectedPassed += 1;
        ownerStats.positive.selectedPassed += 1;
      }
      if (rankOnePassed) {
        positiveRankOnePassed += 1;
        ownerStats.positive.rankOnePassed += 1;
      }
    } else {
      negativeCases += 1;
      ownerStats.negative.total += 1;
      ownerStats.negative.groups.set(
        calibrationCase.groupId,
        (ownerStats.negative.groups.get(calibrationCase.groupId) ?? 0) + 1,
      );
      const excluded = byId.get(calibrationCase.excludedCandidateId!);
      const passed = owner !== undefined &&
        owner.score > 0 &&
        selectedIds.has(calibrationCase.ownerCandidateId) &&
        (excluded === undefined || !selectedIds.has(calibrationCase.excludedCandidateId!));
      if (passed) {
        negativeExcludedPassed += 1;
        ownerStats.negative.passed += 1;
      }
    }
  }

  let candidatesMeetingSampleGate = 0;
  let candidatesMeetingDiversityGate = 0;
  const positiveAccuracies: number[] = [];
  const negativeAccuracies: number[] = [];
  const positiveLowerBounds: number[] = [];
  const negativeLowerBounds: number[] = [];
  for (const candidateStats of stats.values()) {
    if (candidateStats.positive.total >= REQUIRED_POSITIVE_PER_CANDIDATE &&
      candidateStats.negative.total >= REQUIRED_NEGATIVE_PER_CANDIDATE) {
      candidatesMeetingSampleGate += 1;
    }
    if (groupDiversityPass(
      candidateStats.positive.groups,
      candidateStats.positive.total,
    ) && groupDiversityPass(
      candidateStats.negative.groups,
      candidateStats.negative.total,
    )) {
      candidatesMeetingDiversityGate += 1;
    }
    const positiveAccuracy = rate(
      candidateStats.positive.selectedPassed,
      candidateStats.positive.total,
    );
    const negativeAccuracy = rate(candidateStats.negative.passed, candidateStats.negative.total);
    const positiveLower = wilsonLowerBound(
      candidateStats.positive.selectedPassed,
      candidateStats.positive.total,
    );
    const negativeLower = wilsonLowerBound(
      candidateStats.negative.passed,
      candidateStats.negative.total,
    );
    if (positiveAccuracy !== null) positiveAccuracies.push(positiveAccuracy);
    if (negativeAccuracy !== null) negativeAccuracies.push(negativeAccuracy);
    if (positiveLower !== null) positiveLowerBounds.push(positiveLower);
    if (negativeLower !== null) negativeLowerBounds.push(negativeLower);
  }

  const sample: SkillRetrievalCalibrationSampleV1 = {
    candidates: first.value.candidates.length,
    settledCases: settledCases.length,
    excludedCases,
    positiveCases,
    negativeCases,
    candidatesMeetingSampleGate,
    candidatesMeetingDiversityGate,
    requiredPositivePerCandidate: REQUIRED_POSITIVE_PER_CANDIDATE,
    requiredNegativePerCandidate: REQUIRED_NEGATIVE_PER_CANDIDATE,
    requiredGroupsPerKind: REQUIRED_GROUPS_PER_KIND,
    maximumGroupShare: MAX_GROUP_SHARE,
  };
  const routing: SkillRetrievalCalibrationRoutingV1 = {
    ambiguousCutoffCases,
    statisticScope: 'descriptive-wilson-per-candidate',
    positiveSelectedPassed,
    positiveSelectedAccuracy: rate(positiveSelectedPassed, positiveCases),
    minimumPerCandidatePositiveAccuracy:
      positiveAccuracies.length === first.value.candidates.length
        ? Math.min(...positiveAccuracies)
        : null,
    minimumPerCandidatePositiveDescriptiveWilson:
      positiveLowerBounds.length === first.value.candidates.length
        ? roundMetric(Math.min(...positiveLowerBounds))
        : null,
    positiveRankOnePassed,
    positiveRankOneAccuracy: rate(positiveRankOnePassed, positiveCases),
    negativeExcludedPassed,
    negativeExcludedAccuracy: rate(negativeExcludedPassed, negativeCases),
    minimumPerCandidateNegativeAccuracy:
      negativeAccuracies.length === first.value.candidates.length
        ? Math.min(...negativeAccuracies)
        : null,
    minimumPerCandidateNegativeDescriptiveWilson:
      negativeLowerBounds.length === first.value.candidates.length
        ? roundMetric(Math.min(...negativeLowerBounds))
        : null,
    requiredPositiveLowerBound: REQUIRED_POSITIVE_LOWER_BOUND,
    requiredNegativeLowerBound: REQUIRED_NEGATIVE_LOWER_BOUND,
  };
  const sampleComplete = candidatesMeetingSampleGate === first.value.candidates.length &&
    candidatesMeetingDiversityGate === first.value.candidates.length;
  const minimumPositiveLowerBound =
    positiveLowerBounds.length === first.value.candidates.length
      ? Math.min(...positiveLowerBounds)
      : null;
  const minimumNegativeLowerBound =
    negativeLowerBounds.length === first.value.candidates.length
      ? Math.min(...negativeLowerBounds)
      : null;
  const thresholdsMet = sampleComplete &&
    routing.ambiguousCutoffCases === 0 &&
    minimumPositiveLowerBound !== null &&
    minimumPositiveLowerBound >= REQUIRED_POSITIVE_LOWER_BOUND &&
    minimumNegativeLowerBound !== null &&
    minimumNegativeLowerBound >= REQUIRED_NEGATIVE_LOWER_BOUND;
  const detail = { ...common, sample, routing };
  if (!auditAuthenticated) {
    return baseResult(
      'projected',
      'collecting',
      'audit-authentication-required',
      'declared-healthy',
      detail,
    );
  }
  if (!sampleComplete) {
    return baseResult(
      'projected',
      'collecting',
      'insufficient-sample',
      'declared-healthy',
      detail,
    );
  }
  if (!thresholdsMet) {
    return baseResult(
      'projected',
      'withheld',
      'thresholds-not-met',
      'declared-healthy',
      detail,
    );
  }
  return baseResult(
    'projected',
    'collecting',
    'evidence-collected',
    'declared-healthy',
    detail,
  );
}
