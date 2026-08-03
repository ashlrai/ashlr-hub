import { createHash } from 'node:crypto';

import {
  verifyTrustedExternalSkillAuditReceipt,
  type ExternalSkillAuditReceiptReason,
} from './external-skill-audit-receipt.js';
import {
  evaluateSkillRoutingCalibration,
  type SkillRoutingCalibrationReasonV1,
  type SkillRoutingCalibrationSnapshotV1,
} from './skill-routing-calibration.js';

const PROTOCOL = 'external-skill-maturity-projection-v1' as const;
const MAX_AUDIT_REPORT_BYTES = 1024 * 1024;
const MAX_AUDIT_RECEIPT_BYTES = 16 * 1024;
const MAX_ROUTING_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_NODES = 1_500_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_SKILL_NAME_CHARS = 128;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const INPUT_KEYS = ['asOf', 'auditEvidence', 'routingEvidence'] as const;
const AUDIT_KEYS = ['receiptBytes', 'reportBytes', 'selectedSkillName'] as const;
const ROUTING_KEYS = ['firstSnapshotBytes', 'secondSnapshotBytes'] as const;
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

export type ExternalSkillMaturityStateV1 =
  | 'quarantined'
  | 'structurally-valid'
  | 'routing-valid'
  | 'sandbox-trialed'
  | 'shadow-observed'
  | 'verified-active'
  | 'revoked';

export type ExternalSkillMaturityBlockerV1 =
  | 'audit-receipt-authentication-required'
  | 'audit-receipt-currentness-required'
  | 'capture-receipt-binding-required'
  | 'trusted-clock-required'
  | 'online-revocation-required'
  | 'independent-verifier-principal-required'
  | 'one-use-replay-protection-required'
  | 'append-only-transparency-required'
  | 'routing-calibration-ready-required'
  | 'routing-candidate-binding-required'
  | 'runtime-router-equivalence-required'
  | 'independent-heldout-corpus-required'
  | 'routing-confidence-policy-required'
  | 'authenticated-custody-required'
  | 'sealed-sandbox-runner-required'
  | 'authenticated-exposure-receipt-required'
  | 'independent-outcome-attestation-required'
  | 'complete-randomized-trial-required'
  | 'production-shadow-receipt-required'
  | 'shadow-adverse-event-policy-required'
  | 'activation-policy-receipt-required'
  | 'rollback-canary-evidence-required'
  | 'runtime-configuration-attestation-required'
  | 'candidate-revocation-receipt-required';

export interface ExternalSkillMaturityAuditEvidenceV1 {
  reportBytes: Uint8Array;
  receiptBytes: Uint8Array;
  selectedSkillName: string;
}

export interface ExternalSkillMaturityRoutingEvidenceV1 {
  firstSnapshotBytes: Uint8Array;
  secondSnapshotBytes: Uint8Array;
}

export interface ExternalSkillMaturityProjectionInputV1 {
  asOf: string;
  auditEvidence: ExternalSkillMaturityAuditEvidenceV1 | null;
  routingEvidence: ExternalSkillMaturityRoutingEvidenceV1 | null;
}

export interface ExternalSkillMaturityStageV1 {
  state: ExternalSkillMaturityStateV1;
  gate: 'satisfied' | 'blocked';
  blockers: readonly ExternalSkillMaturityBlockerV1[];
}

export interface ExternalSkillMaturityAuditSignalV1 {
  state: 'authenticated' | 'withheld';
  reason: ExternalSkillAuditReceiptReason;
  signatureVerified: boolean;
  trustRootProvisioned: boolean;
  receiptDigest: string | null;
  expiresAt: string | null;
}

export interface ExternalSkillMaturityRoutingSignalV1 {
  gate: 'ready' | 'collecting' | 'withheld';
  reason: SkillRoutingCalibrationReasonV1;
  sourceState: 'healthy' | 'degraded';
  meetsCalibrationThresholds: boolean | null;
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
  globalReplayProtectionVerified: false;
}

export type ExternalSkillMaturityProjectionV1 = AuthorityBoundaryV1 & (
  | {
    schemaVersion: 1;
    protocol: typeof PROTOCOL;
    state: 'projected';
    reason: 'evidence-chain-incomplete';
    sourceState: 'healthy' | 'degraded';
    gate: 'collecting';
    asOf: string;
    highestDefensibleState: 'quarantined';
    nextState: 'structurally-valid';
    terminal: false;
    evidenceRoot: string;
    topBlocker: ExternalSkillMaturityBlockerV1;
    stages: readonly ExternalSkillMaturityStageV1[];
    evidence: {
      audit: ExternalSkillMaturityAuditSignalV1 | null;
      routing: ExternalSkillMaturityRoutingSignalV1 | null;
    };
  }
  | {
    schemaVersion: 1;
    protocol: typeof PROTOCOL;
    state: 'withheld';
    reason: 'invalid-input';
    sourceState: 'degraded';
    gate: 'withheld';
    asOf: null;
    highestDefensibleState: null;
    nextState: null;
    terminal: false;
    evidenceRoot: null;
    topBlocker: null;
    stages: readonly [];
    evidence: {
      audit: null;
      routing: null;
    };
  }
);

interface NormalizedInput {
  asOf: string;
  auditEvidence: {
    reportBytes: Buffer;
    receiptBytes: Buffer;
    selectedSkillName: string;
  } | null;
  routingEvidence: {
    firstSnapshotBytes: Buffer;
    secondSnapshotBytes: Buffer;
  } | null;
}

function authorityBoundary(): AuthorityBoundaryV1 {
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
    globalReplayProtectionVerified: false,
  };
}

function snapshotExactPlainRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Reflect.getPrototypeOf(value);
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

function copyBytes(value: unknown, maximum: number): Buffer | null {
  try {
    if (!(value instanceof Uint8Array) ||
      TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined ||
      TYPED_ARRAY_BUFFER_GETTER === undefined) {
      return null;
    }
    const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []) as number;
    const backingBuffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
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
    const input = snapshotExactPlainRecord(value, INPUT_KEYS);
    if (input === null || !canonicalTimestamp(input['asOf'])) return null;

    let auditEvidence: NormalizedInput['auditEvidence'] = null;
    if (input['auditEvidence'] !== null) {
      const auditInput = snapshotExactPlainRecord(input['auditEvidence'], AUDIT_KEYS);
      if (auditInput === null) return null;
      const reportBytes = copyBytes(auditInput['reportBytes'], MAX_AUDIT_REPORT_BYTES);
      const receiptBytes = copyBytes(auditInput['receiptBytes'], MAX_AUDIT_RECEIPT_BYTES);
      const selectedSkillName = auditInput['selectedSkillName'];
      if (reportBytes === null || receiptBytes === null ||
        typeof selectedSkillName !== 'string' ||
        selectedSkillName.length > MAX_SKILL_NAME_CHARS ||
        !SKILL_NAME.test(selectedSkillName)) {
        return null;
      }
      auditEvidence = { reportBytes, receiptBytes, selectedSkillName };
    }

    let routingEvidence: NormalizedInput['routingEvidence'] = null;
    if (input['routingEvidence'] !== null) {
      const routingInput = snapshotExactPlainRecord(input['routingEvidence'], ROUTING_KEYS);
      if (routingInput === null) return null;
      const firstSnapshotBytes = copyBytes(
        routingInput['firstSnapshotBytes'],
        MAX_ROUTING_SNAPSHOT_BYTES,
      );
      const secondSnapshotBytes = copyBytes(
        routingInput['secondSnapshotBytes'],
        MAX_ROUTING_SNAPSHOT_BYTES,
      );
      if (firstSnapshotBytes === null || secondSnapshotBytes === null) return null;
      routingEvidence = { firstSnapshotBytes, secondSnapshotBytes };
    }

    return { asOf: input['asOf'], auditEvidence, routingEvidence };
  } catch {
    return null;
  }
}

function decodeJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function canonicalJson(value: unknown): string | null {
  let nodes = 0;
  const encode = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) throw new RangeError('limit');
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
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

function digest(domain: string, value: Uint8Array | string): string {
  return createHash('sha256').update(domain, 'utf8').update(value).digest('hex');
}

function unique(
  values: readonly ExternalSkillMaturityBlockerV1[],
): ExternalSkillMaturityBlockerV1[] {
  return [...new Set(values)];
}

function stage(
  state: ExternalSkillMaturityStateV1,
  blockers: readonly ExternalSkillMaturityBlockerV1[],
): ExternalSkillMaturityStageV1 {
  return {
    state,
    gate: blockers.length === 0 ? 'satisfied' : 'blocked',
    blockers: [...blockers],
  };
}

function withheld(): ExternalSkillMaturityProjectionV1 {
  return {
    ...authorityBoundary(),
    schemaVersion: 1,
    protocol: PROTOCOL,
    state: 'withheld',
    reason: 'invalid-input',
    sourceState: 'degraded',
    gate: 'withheld',
    asOf: null,
    highestDefensibleState: null,
    nextState: null,
    terminal: false,
    evidenceRoot: null,
    topBlocker: null,
    stages: [],
    evidence: { audit: null, routing: null },
  };
}

export function projectExternalSkillMaturity(
  input: unknown,
): ExternalSkillMaturityProjectionV1 {
  const normalized = normalizeInput(input);
  if (normalized === null) return withheld();

  const auditResult = normalized.auditEvidence === null
    ? null
    : verifyTrustedExternalSkillAuditReceipt(normalized.auditEvidence);
  const auditSignal: ExternalSkillMaturityAuditSignalV1 | null = auditResult === null
    ? null
    : {
      state: auditResult.state,
      reason: auditResult.reason,
      signatureVerified: auditResult.signatureVerified,
      trustRootProvisioned: auditResult.trustRootProvisioned,
      receiptDigest: auditResult.receiptDigest,
      expiresAt: auditResult.expiresAt,
    };

  let routingSignal: ExternalSkillMaturityRoutingSignalV1 | null = null;
  let firstRoutingDigest: string | null = null;
  let secondRoutingDigest: string | null = null;
  if (normalized.routingEvidence !== null) {
    try {
      const firstSnapshot = decodeJson(normalized.routingEvidence.firstSnapshotBytes);
      const secondSnapshot = decodeJson(normalized.routingEvidence.secondSnapshotBytes);
      const firstCanonical = canonicalJson(firstSnapshot);
      const secondCanonical = canonicalJson(secondSnapshot);
      if (firstCanonical === null || secondCanonical === null) {
        throw new RangeError('routing snapshot exceeds canonicalization limits');
      }
      firstRoutingDigest = digest(
        'ashlr:external-skill-maturity:routing-snapshot:v1\0',
        firstCanonical,
      );
      secondRoutingDigest = digest(
        'ashlr:external-skill-maturity:routing-snapshot:v1\0',
        secondCanonical,
      );
      const result = evaluateSkillRoutingCalibration({
        asOf: normalized.asOf,
        firstSnapshot: firstSnapshot as SkillRoutingCalibrationSnapshotV1,
        secondSnapshot: secondSnapshot as SkillRoutingCalibrationSnapshotV1,
      });
      routingSignal = {
        gate: result.gate,
        reason: result.reason,
        sourceState: result.sourceState,
        meetsCalibrationThresholds: result.meetsCalibrationThresholds,
      };
    } catch {
      routingSignal = {
        gate: 'withheld',
        reason: 'invalid-input',
        sourceState: 'degraded',
        meetsCalibrationThresholds: null,
      };
      firstRoutingDigest = null;
      secondRoutingDigest = null;
    }
  }

  const structuralBlockers: ExternalSkillMaturityBlockerV1[] = [];
  if (auditSignal?.state !== 'authenticated') {
    structuralBlockers.push(
      auditSignal !== null && [
        'receipt-expired',
        'receipt-not-current',
        'trust-key-inactive',
        'trust-key-revoked',
      ].includes(auditSignal.reason)
        ? 'audit-receipt-currentness-required'
        : 'audit-receipt-authentication-required',
    );
  } else if (auditSignal.expiresAt === null || auditSignal.expiresAt < normalized.asOf) {
    structuralBlockers.push('audit-receipt-currentness-required');
  }
  structuralBlockers.push(
    'capture-receipt-binding-required',
    'trusted-clock-required',
    'online-revocation-required',
    'independent-verifier-principal-required',
    'one-use-replay-protection-required',
    'append-only-transparency-required',
  );

  const routingBlockers = unique([
    ...structuralBlockers,
    ...(routingSignal?.gate === 'ready' && routingSignal.meetsCalibrationThresholds === true
      ? []
      : ['routing-calibration-ready-required' as const]),
    'routing-candidate-binding-required',
    'runtime-router-equivalence-required',
    'independent-heldout-corpus-required',
    'routing-confidence-policy-required',
  ]);
  const sandboxBlockers = unique([
    ...routingBlockers,
    'authenticated-custody-required',
    'sealed-sandbox-runner-required',
    'authenticated-exposure-receipt-required',
    'independent-outcome-attestation-required',
    'complete-randomized-trial-required',
  ]);
  const shadowBlockers = unique([
    ...sandboxBlockers,
    'production-shadow-receipt-required',
    'shadow-adverse-event-policy-required',
  ]);
  const activeBlockers = unique([
    ...shadowBlockers,
    'activation-policy-receipt-required',
    'rollback-canary-evidence-required',
    'runtime-configuration-attestation-required',
  ]);
  const revokedBlockers: ExternalSkillMaturityBlockerV1[] = [
    'candidate-revocation-receipt-required',
  ];

  const stages = [
    stage('quarantined', []),
    stage('structurally-valid', structuralBlockers),
    stage('routing-valid', routingBlockers),
    stage('sandbox-trialed', sandboxBlockers),
    stage('shadow-observed', shadowBlockers),
    stage('verified-active', activeBlockers),
    stage('revoked', revokedBlockers),
  ];
  const evidenceRoot = digest(
    'ashlr:external-skill-maturity:evidence-root:v1\0',
    JSON.stringify([
      normalized.asOf,
      normalized.auditEvidence === null ? null : [
        digest(
          'ashlr:external-skill-maturity:audit-report:v1\0',
          normalized.auditEvidence.reportBytes,
        ),
        digest(
          'ashlr:external-skill-maturity:audit-receipt:v1\0',
          normalized.auditEvidence.receiptBytes,
        ),
        normalized.auditEvidence.selectedSkillName,
      ],
      auditSignal,
      firstRoutingDigest,
      secondRoutingDigest,
      routingSignal,
    ]),
  );
  const evidenceDegraded =
    (auditSignal !== null && auditSignal.state === 'withheld') ||
    (routingSignal !== null &&
      (routingSignal.gate === 'withheld' || routingSignal.sourceState === 'degraded'));

  return {
    ...authorityBoundary(),
    schemaVersion: 1,
    protocol: PROTOCOL,
    state: 'projected',
    reason: 'evidence-chain-incomplete',
    sourceState: evidenceDegraded ? 'degraded' : 'healthy',
    gate: 'collecting',
    asOf: normalized.asOf,
    highestDefensibleState: 'quarantined',
    nextState: 'structurally-valid',
    terminal: false,
    evidenceRoot,
    topBlocker: structuralBlockers[0]!,
    stages,
    evidence: {
      audit: auditSignal,
      routing: routingSignal,
    },
  };
}
