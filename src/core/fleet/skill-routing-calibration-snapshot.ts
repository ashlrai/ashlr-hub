import { createHmac, timingSafeEqual } from 'node:crypto';

import { SKILL_ROUTING_CALIBRATION_POLICY_VERSION } from './skill-routing-calibration.js';
import type {
  SkillRoutingCalibrationSnapshotV1,
  SkillRoutingCaseV1,
  SkillRoutingSkillV1,
  SkillRoutingSparseTermV1,
} from './skill-routing-calibration.js';

const PROTOCOL = 'skill-routing-calibration-snapshot-projection-v1' as const;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_SKILLS = 256;
const MAX_CASES = 10_000;
const MAX_TEXT_PARTS = 64;
const MAX_TEXT_PART_BYTES = 8 * 1024;
const MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_VECTOR_TERMS = 256;
const MAX_TOTAL_VECTOR_TERMS = 250_000;
const MAX_TOKEN_CHARS = 32;
const MAX_TERM_COUNT = 1_000_000;
const SOURCE_KEY_BYTES = 32;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
export const SKILL_ROUTING_CALIBRATION_PROJECTION_POLICY_VERSION = 'm453-token-counts-v1';

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

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'redacted',
]);

const INPUT_KEYS = [
  'cases', 'complete', 'conflictingRows', 'duplicateRows', 'invalidRows',
  'limitExceeded', 'routerPolicyVersion', 'schemaVersion', 'skills',
  'sourceRevision', 'sourceState',
] as const;
const SKILL_KEYS = ['sourceId', 'textParts'] as const;
const CASE_KEYS = [
  'excludedSkillSourceId', 'kind', 'observedAt', 'ownerSkillSourceId',
  'sourceId', 'textParts',
] as const;
const CANONICAL_SOURCE_KEYS = [
  'schemaVersion', 'sourceRevision', 'routerPolicyVersion', 'sourceState',
  'complete', 'invalidRows', 'duplicateRows', 'conflictingRows', 'limitExceeded',
  'skills', 'cases', 'sourceId', 'kind', 'ownerSkillSourceId',
  'excludedSkillSourceId', 'observedAt', 'textParts',
] as const;

export interface SkillRoutingCalibrationSourceSkillV1 {
  sourceId: string;
  textParts: readonly string[];
}

export interface SkillRoutingCalibrationSourceCaseV1 {
  sourceId: string;
  kind: 'positive-owner' | 'negative-owner';
  ownerSkillSourceId: string;
  excludedSkillSourceId: string | null;
  observedAt: string;
  textParts: readonly string[];
}

export interface SkillRoutingCalibrationSnapshotSourceV1 {
  schemaVersion: 1;
  sourceRevision: string;
  routerPolicyVersion: string;
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  invalidRows: number;
  duplicateRows: number;
  conflictingRows: number;
  limitExceeded: boolean;
  skills: readonly SkillRoutingCalibrationSourceSkillV1[];
  cases: readonly SkillRoutingCalibrationSourceCaseV1[];
}

export type SkillRoutingCalibrationSnapshotProjectionReasonV1 =
  | 'snapshot-projected'
  | 'invalid-input'
  | 'source-degraded'
  | 'source-incomplete'
  | 'source-invalid'
  | 'duplicate-input'
  | 'conflicting-input'
  | 'input-limit-exceeded';

interface ProjectionBase {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authority: 'observation-only';
  metadataOnly: true;
  rawSourceReturned: false;
  sourceKeyReturned: false;
  routingAuthority: false;
  learningAuthority: false;
  policyAuthority: false;
  promotionAuthority: false;
  mergeAuthority: false;
}

export type SkillRoutingCalibrationSnapshotProjectionV1 = ProjectionBase & (
  | {
    state: 'projected';
    reason: 'snapshot-projected';
    snapshot: SkillRoutingCalibrationSnapshotV1;
  }
  | {
    state: 'withheld';
    reason: Exclude<SkillRoutingCalibrationSnapshotProjectionReasonV1, 'snapshot-projected'>;
    snapshot: null;
  }
);

interface ProjectionFailure {
  ok: false;
  reason: Exclude<SkillRoutingCalibrationSnapshotProjectionReasonV1, 'snapshot-projected'>;
}

interface ProjectionSuccess<T> {
  ok: true;
  value: T;
}

type ProjectionResult<T> = ProjectionFailure | ProjectionSuccess<T>;

function base(): ProjectionBase {
  return {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authority: 'observation-only',
    metadataOnly: true,
    rawSourceReturned: false,
    sourceKeyReturned: false,
    routingAuthority: false,
    learningAuthority: false,
    policyAuthority: false,
    promotionAuthority: false,
    mergeAuthority: false,
  };
}

function withheld(
  reason: Exclude<SkillRoutingCalibrationSnapshotProjectionReasonV1, 'snapshot-projected'>,
): SkillRoutingCalibrationSnapshotProjectionV1 {
  return { ...base(), state: 'withheld', reason, snapshot: null };
}

function exactPlainRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(
    (descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true,
  )) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactArray(value: unknown, maximum: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value'))) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) return false;
  const expectedKeys = new Set([
    ...Array.from({ length: value.length }, (_, index) => String(index)),
    'length',
  ]);
  return ownKeys.length === expectedKeys.size &&
    ownKeys.every((key) => expectedKeys.has(key as string));
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function copyPrivateBuffer(value: unknown, minimum: number, maximum: number): Buffer | null {
  if (!Buffer.isBuffer(value) ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
    TYPED_ARRAY_BUFFER_GETTER === undefined) {
    return null;
  }
  const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
  const backingBuffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
  if (byteLength < minimum || byteLength > maximum ||
    (typeof SharedArrayBuffer !== 'undefined' && backingBuffer instanceof SharedArrayBuffer)) {
    return null;
  }
  const copy = Buffer.allocUnsafeSlow(byteLength);
  Reflect.apply(TYPED_ARRAY_SET, copy, [value]);
  return copy;
}

function decodeSource(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function canonicalSourceBytes(value: SkillRoutingCalibrationSnapshotSourceV1): Buffer {
  return Buffer.from(JSON.stringify(value, [...CANONICAL_SOURCE_KEYS]), 'utf8');
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateTextParts(value: unknown): ProjectionResult<string[]> {
  if (!exactArray(value, MAX_TEXT_PARTS) || value.length === 0) {
    return { ok: false, reason: 'invalid-input' };
  }
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part !== 'string' || part.length === 0 ||
      Buffer.byteLength(part, 'utf8') > MAX_TEXT_PART_BYTES) {
      return { ok: false, reason: 'invalid-input' };
    }
    parts.push(part);
  }
  return { ok: true, value: parts };
}

function vectorFromText(
  key: Buffer,
  parts: readonly string[],
): ProjectionResult<{ vector: SkillRoutingSparseTermV1[]; sourceBytes: number }> {
  const counts = new Map<string, number>();
  let sourceBytes = 0;
  for (const part of parts) {
    sourceBytes += Buffer.byteLength(part, 'utf8');
    const tokens = part.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      if (token.length < 2 || token.length > MAX_TOKEN_CHARS || STOP_WORDS.has(token)) continue;
      const nextCount = (counts.get(token) ?? 0) + 1;
      if (nextCount > MAX_TERM_COUNT) return { ok: false, reason: 'input-limit-exceeded' };
      counts.set(token, nextCount);
      if (counts.size > MAX_VECTOR_TERMS) return { ok: false, reason: 'input-limit-exceeded' };
    }
  }
  if (counts.size === 0) return { ok: false, reason: 'invalid-input' };
  const vector = [...counts.entries()]
    .map(([token, count]) => ({
      termId: hmac(key, 'ashlr.skill-routing-calibration.term-id.v1', token),
      count,
    }))
    .sort((left, right) => compareText(left.termId, right.termId));
  return { ok: true, value: { vector, sourceBytes } };
}

function validateSourceId(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_ID_RE.test(value);
}

function validateInputQuality(
  value: Record<string, unknown>,
): Exclude<SkillRoutingCalibrationSnapshotProjectionReasonV1, 'snapshot-projected'> | null {
  if (value['schemaVersion'] !== 1 ||
    typeof value['sourceRevision'] !== 'string' || !VERSION_RE.test(value['sourceRevision']) ||
    typeof value['routerPolicyVersion'] !== 'string' || !VERSION_RE.test(value['routerPolicyVersion']) ||
    (value['sourceState'] !== 'healthy' && value['sourceState'] !== 'degraded') ||
    typeof value['complete'] !== 'boolean' || typeof value['limitExceeded'] !== 'boolean' ||
    !nonNegativeInteger(value['invalidRows']) || !nonNegativeInteger(value['duplicateRows']) ||
    !nonNegativeInteger(value['conflictingRows'])) {
    return 'invalid-input';
  }
  if (value['limitExceeded']) return 'input-limit-exceeded';
  if (value['conflictingRows'] > 0) return 'conflicting-input';
  if (value['duplicateRows'] > 0) return 'duplicate-input';
  if (value['invalidRows'] > 0) return 'source-invalid';
  if (value['sourceState'] === 'degraded') return 'source-degraded';
  if (!value['complete']) return 'source-incomplete';
  return null;
}

export function projectSkillRoutingCalibrationSnapshot(
  sourceBytes: Buffer,
  sourceKeyBytes: Buffer,
): SkillRoutingCalibrationSnapshotProjectionV1 {
  let sourceBuffer: Buffer | null = null;
  let sourceKey: Buffer | null = null;
  let canonicalBuffer: Buffer | null = null;
  try {
    sourceBuffer = copyPrivateBuffer(sourceBytes, 2, MAX_SOURCE_BYTES);
    sourceKey = copyPrivateBuffer(sourceKeyBytes, SOURCE_KEY_BYTES, SOURCE_KEY_BYTES);
    if (sourceBuffer === null || sourceKey === null) return withheld('invalid-input');
    const decoded = decodeSource(sourceBuffer);
    if (!exactPlainRecord(decoded, INPUT_KEYS)) return withheld('invalid-input');
    const source = decoded as unknown as SkillRoutingCalibrationSnapshotSourceV1;
    canonicalBuffer = canonicalSourceBytes(source);
    if (!byteEqual(sourceBuffer, canonicalBuffer)) return withheld('invalid-input');
    const qualityReason = validateInputQuality(decoded);
    if (qualityReason !== null) return withheld(qualityReason);
    if (source.routerPolicyVersion !== SKILL_ROUTING_CALIBRATION_POLICY_VERSION) {
      return withheld('invalid-input');
    }

    if (!exactArray(source.skills, MAX_SKILLS) || source.skills.length === 0 ||
      !exactArray(source.cases, MAX_CASES)) {
      return withheld(
        Array.isArray(source.skills) && source.skills.length > MAX_SKILLS ||
        Array.isArray(source.cases) && source.cases.length > MAX_CASES
          ? 'input-limit-exceeded'
          : 'invalid-input',
      );
    }

    let totalTextBytes = 0;
    let totalVectorTerms = 0;
    const rawSkillIds = new Set<string>();
    const opaqueSkillIds = new Set<string>();
    const skillIdBySource = new Map<string, string>();
    const skills: SkillRoutingSkillV1[] = [];

    for (const rawSkill of source.skills) {
      if (!exactPlainRecord(rawSkill, SKILL_KEYS) || !validateSourceId(rawSkill['sourceId'])) {
        return withheld('invalid-input');
      }
      if (rawSkillIds.has(rawSkill['sourceId'])) return withheld('duplicate-input');
      const textParts = validateTextParts(rawSkill['textParts']);
      if (!textParts.ok) return withheld(textParts.reason);
      const projectedVector = vectorFromText(sourceKey, textParts.value);
      if (!projectedVector.ok) return withheld(projectedVector.reason);
      totalTextBytes += projectedVector.value.sourceBytes;
      totalVectorTerms += projectedVector.value.vector.length;
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES || totalVectorTerms > MAX_TOTAL_VECTOR_TERMS) {
        return withheld('input-limit-exceeded');
      }
      const skillId = hmac(
        sourceKey,
        'ashlr.skill-routing-calibration.skill-id.v1',
        rawSkill['sourceId'],
      );
      if (opaqueSkillIds.has(skillId)) return withheld('conflicting-input');
      rawSkillIds.add(rawSkill['sourceId']);
      opaqueSkillIds.add(skillId);
      skillIdBySource.set(rawSkill['sourceId'], skillId);
      skills.push({ skillId, vector: projectedVector.value.vector });
    }

    const rawCaseIds = new Set<string>();
    const opaqueCaseIds = new Set<string>();
    const cases: SkillRoutingCaseV1[] = [];
    for (const rawCase of source.cases) {
      if (!exactPlainRecord(rawCase, CASE_KEYS) || !validateSourceId(rawCase['sourceId']) ||
        !validateSourceId(rawCase['ownerSkillSourceId']) || !canonicalTimestamp(rawCase['observedAt']) ||
        (rawCase['kind'] !== 'positive-owner' && rawCase['kind'] !== 'negative-owner')) {
        return withheld('invalid-input');
      }
      if (rawCaseIds.has(rawCase['sourceId'])) return withheld('duplicate-input');
      const ownerSkillId = skillIdBySource.get(rawCase['ownerSkillSourceId']);
      if (ownerSkillId === undefined) return withheld('invalid-input');
      let excludedSkillId: string | null = null;
      if (rawCase['kind'] === 'positive-owner') {
        if (rawCase['excludedSkillSourceId'] !== null) return withheld('invalid-input');
      } else {
        if (!validateSourceId(rawCase['excludedSkillSourceId']) ||
          rawCase['excludedSkillSourceId'] === rawCase['ownerSkillSourceId']) {
          return withheld('invalid-input');
        }
        excludedSkillId = skillIdBySource.get(rawCase['excludedSkillSourceId']) ?? null;
        if (excludedSkillId === null) return withheld('invalid-input');
      }
      const textParts = validateTextParts(rawCase['textParts']);
      if (!textParts.ok) return withheld(textParts.reason);
      const projectedVector = vectorFromText(sourceKey, textParts.value);
      if (!projectedVector.ok) return withheld(projectedVector.reason);
      totalTextBytes += projectedVector.value.sourceBytes;
      totalVectorTerms += projectedVector.value.vector.length;
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES || totalVectorTerms > MAX_TOTAL_VECTOR_TERMS) {
        return withheld('input-limit-exceeded');
      }
      const caseId = hmac(
        sourceKey,
        'ashlr.skill-routing-calibration.case-id.v1',
        rawCase['sourceId'],
      );
      if (opaqueCaseIds.has(caseId)) return withheld('conflicting-input');
      rawCaseIds.add(rawCase['sourceId']);
      opaqueCaseIds.add(caseId);
      cases.push({
        caseId,
        kind: rawCase['kind'],
        ownerSkillId,
        excludedSkillId,
        observedAt: rawCase['observedAt'],
        vector: projectedVector.value.vector,
      });
    }

    skills.sort((left, right) => compareText(left.skillId, right.skillId));
    cases.sort((left, right) => compareText(left.caseId, right.caseId));
    const snapshot: SkillRoutingCalibrationSnapshotV1 = {
      schemaVersion: 1,
      sourceRevision: source.sourceRevision,
      routerPolicyVersion: source.routerPolicyVersion,
      projectionPolicyVersion: SKILL_ROUTING_CALIBRATION_PROJECTION_POLICY_VERSION,
      sourceState: 'healthy',
      complete: true,
      invalidRows: 0,
      duplicateRows: 0,
      conflictingRows: 0,
      limitExceeded: false,
      skills,
      cases,
    };
    return { ...base(), state: 'projected', reason: 'snapshot-projected', snapshot };
  } catch {
    return withheld('invalid-input');
  } finally {
    canonicalBuffer?.fill(0);
    sourceBuffer?.fill(0);
    sourceKey?.fill(0);
  }
}
