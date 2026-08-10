/**
 * Pure, planning-only contracts for future Cortex and Locus integration.
 *
 * This module validates and canonicalizes untrusted envelopes. It performs no
 * network, filesystem, process, persistence, approval, dispatch, or mutation
 * work. A valid digest is integrity evidence only; it is not authentication or
 * authority.
 */

import { createHash } from 'node:crypto';

export const ECOSYSTEM_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const MAX_ECOSYSTEM_ENVELOPE_BYTES = 64 * 1024;
export const MAX_ECOSYSTEM_LIST_ITEMS = 8;

const MAX_ID_LENGTH = 128;
const MAX_REF_LENGTH = 160;
const MAX_TITLE_LENGTH = 200;
const MAX_OBJECTIVE_LENGTH = 4_000;
const MAX_OUTCOME_LENGTH = 1_000;
const MAX_LIST_ITEM_LENGTH = 500;
const MAX_TOOL_LENGTH = 160;
const MAX_SIGNATURE_LENGTH = 1_024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 4_096;
const MAX_CANONICAL_TEXT_BYTES = MAX_ECOSYSTEM_ENVELOPE_BYTES;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/;
const PIN_PART_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;
const SAFE_SIGNATURE_RE = /^[A-Za-z0-9._~-]+$/;

const CANDIDATE_KEYS = new Set([
  'schemaVersion', 'authority', 'digestAlgorithm', 'candidateDigest',
  'candidateId', 'revision', 'issuedAt', 'expiresAt', 'replayKey',
  'source', 'accountability', 'intent',
]);
const CANDIDATE_SOURCE_KEYS = new Set([
  'system', 'organizationRef', 'space', 'workstream', 'sensitivity',
]);
const CANDIDATE_ACCOUNTABILITY_KEYS = new Set(['accountableRef', 'dueAt']);
const CANDIDATE_INTENT_KEYS = new Set([
  'title', 'objective', 'desiredOutcome', 'constraints', 'successSignals', 'guardrails',
]);

const EVIDENCE_KEYS = new Set([
  'schemaVersion', 'authority', 'digestAlgorithm', 'envelopeDigest',
  'envelopeId', 'issuedAt', 'expiresAt', 'idempotencyKey',
  'mission', 'identity', 'operation', 'result', 'attestation',
]);
const EVIDENCE_MISSION_KEYS = new Set(['graphDigest', 'nodeKey', 'purpose']);
const EVIDENCE_IDENTITY_KEYS = new Set([
  'bindingRef', 'tenantRef', 'principalRef', 'sessionRef', 'sealVerifiedAt',
]);
const EVIDENCE_OPERATION_KEYS = new Set([
  'provider', 'tool', 'selectorsDigest', 'argsDigest', 'effectClass',
]);
const EVIDENCE_RESULT_KEYS = new Set([
  'state', 'receiptRef', 'responseDigest', 'observedAt',
]);
const EVIDENCE_ATTESTATION_KEYS = new Set([
  'kind', 'issuerRevision', 'signature',
]);
const VERIFIED_ENVELOPE_KEYS = new Set(['envelopeDigest', 'identity', 'operation']);
const EXPECTED_IDENTITY_KEYS = new Set([
  'bindingRef', 'tenantRef', 'principalRef', 'sessionRef',
]);
const CURRENT_LOCUS_REPORT_REQUIRED_KEYS = new Set([
  'version', 'ready', 'status', 'pin', 'mcp_registered', 'doctor', 'commands',
  'exit_code', 'status_oneline', 'home', 'required_servers', 'mcp_command',
]);
const CURRENT_LOCUS_REPORT_ALLOWED_KEYS = new Set([
  ...CURRENT_LOCUS_REPORT_REQUIRED_KEYS,
  'findings', 'next_steps', 'env_session_id',
]);
const CURRENT_LOCUS_PIN_REQUIRED_KEYS = new Set([
  'alias', 'tenant', 'binding_id', 'expires_at', 'seal_ok', 'expired', 'frozen',
]);
const CURRENT_LOCUS_PIN_ALLOWED_KEYS = new Set([
  ...CURRENT_LOCUS_PIN_REQUIRED_KEYS,
  'principal', 'client',
]);

export type CortexSpace = 'personal' | 'business';
export type CortexWorkstream = 'personal' | 'company' | 'govcon' | 'commercial';
export type CortexSensitivity = 'standard' | 'restricted' | 'govcon_only';

export interface CortexMissionCandidateV1 {
  schemaVersion: typeof ECOSYSTEM_EVIDENCE_SCHEMA_VERSION;
  authority: 'planning-candidate-only';
  digestAlgorithm: 'sha256';
  candidateDigest: string;
  candidateId: string;
  revision: number;
  issuedAt: string;
  expiresAt: string;
  replayKey: string;
  source: {
    system: 'ashlr-cortex';
    organizationRef: string;
    space: CortexSpace;
    workstream: CortexWorkstream;
    sensitivity: CortexSensitivity;
  };
  accountability: {
    accountableRef: string;
    dueAt: string | null;
  };
  intent: {
    title: string;
    objective: string;
    desiredOutcome: string;
    constraints: string[];
    successSignals: string[];
    guardrails: string[];
  };
}

export type LocusEvidencePurpose = 'external-read' | 'proposal-only-write';
export type LocusEvidenceEffectClass = 'read' | 'proposal-only';
export type LocusEvidenceResultState = 'observed' | 'denied' | 'failed' | 'transport-unknown';
export type LocusEvidenceAttestationKind = 'unverified-local' | 'signed-locus-v1';

export interface LocusBoundEvidenceEnvelopeV1 {
  schemaVersion: typeof ECOSYSTEM_EVIDENCE_SCHEMA_VERSION;
  authority: 'identity-evidence-only';
  digestAlgorithm: 'sha256';
  envelopeDigest: string;
  envelopeId: string;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
  mission: {
    graphDigest: string;
    nodeKey: string;
    purpose: LocusEvidencePurpose;
  };
  identity: {
    bindingRef: string;
    tenantRef: string;
    principalRef: string;
    sessionRef: string;
    sealVerifiedAt: string;
  };
  operation: {
    provider: string;
    tool: string;
    selectorsDigest: string;
    argsDigest: string;
    effectClass: LocusEvidenceEffectClass;
  };
  result: {
    state: LocusEvidenceResultState;
    receiptRef: string | null;
    responseDigest: string | null;
    observedAt: string;
  };
  attestation: {
    kind: LocusEvidenceAttestationKind;
    issuerRevision: string;
    signature: string | null;
  };
}

export type EcosystemEnvelopeValidationCode =
  | 'invalid-schema'
  | 'invalid-field'
  | 'invalid-timestamp'
  | 'invalid-boundary'
  | 'invalid-digest'
  | 'digest-mismatch'
  | 'expired'
  | 'future-issued'
  | 'too-large';

export interface EcosystemEnvelopeValidationIssue {
  code: EcosystemEnvelopeValidationCode;
  path: string;
  message: string;
}

export type EcosystemEnvelopeValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: EcosystemEnvelopeValidationIssue[] };

export interface EcosystemEnvelopeValidationOptions {
  /** Explicit clock input. When provided, expired or future-issued input fails. */
  now?: string;
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

function issue(
  code: EcosystemEnvelopeValidationCode,
  path: string,
  message: string,
): EcosystemEnvelopeValidationIssue {
  return { code, path, message };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.size && keys.every((key) => {
    if (typeof key !== 'string' || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeBounded(value: unknown, maxBytes: number): CanonicalValue | null {
  let nodes = 0;
  let textBytes = 0;
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, depth: number): CanonicalValue => {
    nodes += 1;
    if (nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
      throw new TypeError('canonical value exceeds structural bounds');
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('canonical values require finite numbers');
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (typeof candidate === 'string') {
      const normalized = candidate.normalize('NFC');
      textBytes += Buffer.byteLength(normalized, 'utf8');
      if (textBytes > MAX_CANONICAL_TEXT_BYTES || textBytes > maxBytes) {
        throw new TypeError('canonical text exceeds byte bounds');
      }
      return normalized;
    }
    if (typeof candidate !== 'object' || candidate === null || ancestors.has(candidate)) {
      throw new TypeError('canonical values require acyclic JSON data');
    }

    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, 'length');
        if (!lengthDescriptor || !('value' in lengthDescriptor) ||
            !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
            lengthDescriptor.value > MAX_CANONICAL_NODES) {
          throw new TypeError('canonical arrays require a bounded data length');
        }
        const length = lengthDescriptor.value as number;
        const ownKeys = Reflect.ownKeys(candidate);
        if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string') ||
            !ownKeys.includes('length')) {
          throw new TypeError('canonical arrays cannot contain symbols or extra properties');
        }
        const output: CanonicalValue[] = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
            throw new TypeError('canonical arrays require dense enumerable data elements');
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return output;
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonical values require plain records');
      }
      const entries: Array<[string, unknown]> = [];
      for (const rawKey of Reflect.ownKeys(candidate)) {
        if (typeof rawKey !== 'string') throw new TypeError('canonical records cannot contain symbols');
        const descriptor = Object.getOwnPropertyDescriptor(candidate, rawKey);
        if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor)) {
          throw new TypeError('canonical records require enumerable data properties');
        }
        const key = rawKey.normalize('NFC');
        textBytes += Buffer.byteLength(key, 'utf8');
        if (textBytes > MAX_CANONICAL_TEXT_BYTES || textBytes > maxBytes) {
          throw new TypeError('canonical keys exceed byte bounds');
        }
        entries.push([key, descriptor.value]);
      }
      entries.sort(([left], [right]) => canonicalCompare(left, right));
      const output = Object.create(null) as Record<string, CanonicalValue>;
      let previous: string | undefined;
      for (const [key, entry] of entries) {
        if (key === previous) throw new TypeError('canonical keys collide after normalization');
        output[key] = visit(entry, depth + 1);
        previous = key;
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  try {
    const clone = visit(value, 0);
    const encoded = JSON.stringify(clone);
    return Buffer.byteLength(encoded, 'utf8') <= maxBytes ? clone : null;
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  const canonical = canonicalizeBounded(value, MAX_ECOSYSTEM_ENVELOPE_BYTES);
  if (canonical === null) throw new TypeError('value cannot be canonicalized within bounds');
  return JSON.stringify(canonical);
}

function isBoundedJson(value: unknown, maxBytes: number): boolean {
  return canonicalizeBounded(value, maxBytes) !== null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function isCanonicalText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && value === value.normalize('NFC');
}

function isOpaqueRef(value: unknown, maxLength = MAX_REF_LENGTH): value is string {
  return isCanonicalText(value, maxLength) && ID_RE.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function timestampMillis(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function validList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1 ||
      lengthDescriptor.value > MAX_ECOSYSTEM_LIST_ITEMS ||
      Reflect.ownKeys(value).length !== (lengthDescriptor.value as number) + 1) return false;
  const entries: string[] = [];
  for (let index = 0; index < (lengthDescriptor.value as number); index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !('value' in descriptor) ||
        !isCanonicalText(descriptor.value, MAX_LIST_ITEM_LENGTH)) return false;
    entries.push(descriptor.value);
  }
  return new Set(entries).size === entries.length;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort(canonicalCompare);
}

function candidateDigestPayload(candidate: CortexMissionCandidateV1): unknown {
  return {
    schemaVersion: candidate.schemaVersion,
    authority: candidate.authority,
    digestAlgorithm: candidate.digestAlgorithm,
    candidateId: candidate.candidateId,
    revision: candidate.revision,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    replayKey: candidate.replayKey,
    source: candidate.source,
    accountability: candidate.accountability,
    intent: {
      ...candidate.intent,
      constraints: sorted(candidate.intent.constraints),
      successSignals: sorted(candidate.intent.successSignals),
      guardrails: sorted(candidate.intent.guardrails),
    },
  };
}

/** Canonical integrity digest. This is not a signature or authorization. */
export function cortexMissionCandidateDigest(candidate: CortexMissionCandidateV1): string {
  return sha256(candidateDigestPayload(candidate));
}

function validateClockWindow(
  issuedAt: unknown,
  expiresAt: unknown,
  options: EcosystemEnvelopeValidationOptions,
  issues: EcosystemEnvelopeValidationIssue[],
): { issued: number | null; expires: number | null } {
  const issued = timestampMillis(issuedAt);
  const expires = timestampMillis(expiresAt);
  if (issued === null) issues.push(issue('invalid-timestamp', 'issuedAt', 'must be a canonical ISO-8601 timestamp'));
  if (expires === null) issues.push(issue('invalid-timestamp', 'expiresAt', 'must be a canonical ISO-8601 timestamp'));
  if (issued !== null && expires !== null && expires <= issued) {
    issues.push(issue('invalid-timestamp', 'expiresAt', 'must be later than issuedAt'));
  }
  if (options.now !== undefined) {
    const now = timestampMillis(options.now);
    if (now === null) {
      issues.push(issue('invalid-timestamp', '$options.now', 'must be a canonical ISO-8601 timestamp'));
    } else {
      if (issued !== null && issued > now) issues.push(issue('future-issued', 'issuedAt', 'must not be in the future'));
      if (expires !== null && expires <= now) issues.push(issue('expired', 'expiresAt', 'envelope has expired'));
    }
  }
  return { issued, expires };
}

/** Strictly validate a Cortex planning candidate from an untrusted boundary. */
export function validateCortexMissionCandidate(
  value: unknown,
  options: EcosystemEnvelopeValidationOptions = {},
): EcosystemEnvelopeValidationResult<CortexMissionCandidateV1> {
  const issues: EcosystemEnvelopeValidationIssue[] = [];
  let sanitized: CortexMissionCandidateV1 | null = null;
  if (!isPlainRecord(value) || !hasExactKeys(value, CANDIDATE_KEYS)) {
    return { ok: false, issues: [issue('invalid-schema', '$', 'candidate must contain only the V1 schema fields')] };
  }
  if (value['schemaVersion'] !== 1 || value['authority'] !== 'planning-candidate-only' ||
      value['digestAlgorithm'] !== 'sha256') {
    issues.push(issue('invalid-schema', '$', 'unsupported candidate version, authority, or digest algorithm'));
  }
  if (!isDigest(value['candidateDigest'])) issues.push(issue('invalid-digest', 'candidateDigest', 'must be lowercase SHA-256'));
  if (!isOpaqueRef(value['candidateId'], MAX_ID_LENGTH)) issues.push(issue('invalid-field', 'candidateId', 'must be a bounded opaque id'));
  if (!Number.isSafeInteger(value['revision']) || (value['revision'] as number) < 1) {
    issues.push(issue('invalid-field', 'revision', 'must be a positive safe integer'));
  }
  if (!isOpaqueRef(value['replayKey'], MAX_ID_LENGTH)) issues.push(issue('invalid-field', 'replayKey', 'must be a bounded opaque id'));
  validateClockWindow(value['issuedAt'], value['expiresAt'], options, issues);

  const source = value['source'];
  if (!isPlainRecord(source) || !hasExactKeys(source, CANDIDATE_SOURCE_KEYS)) {
    issues.push(issue('invalid-schema', 'source', 'must contain only source fields'));
  } else {
    const space = source['space'];
    const workstream = source['workstream'];
    if (source['system'] !== 'ashlr-cortex' || !isOpaqueRef(source['organizationRef']) ||
        (space !== 'personal' && space !== 'business') ||
        !['personal', 'company', 'govcon', 'commercial'].includes(String(workstream)) ||
        !['standard', 'restricted', 'govcon_only'].includes(String(source['sensitivity']))) {
      issues.push(issue('invalid-field', 'source', 'contains an invalid source identity or boundary'));
    }
    if ((space === 'personal' && workstream !== 'personal') ||
        (space === 'business' && workstream === 'personal')) {
      issues.push(issue('invalid-boundary', 'source.workstream', 'space and workstream are inconsistent'));
    }
    if (source['sensitivity'] === 'govcon_only' && workstream !== 'govcon') {
      issues.push(issue('invalid-boundary', 'source.sensitivity', 'govcon_only candidates must be govcon scoped'));
    }
  }

  const accountability = value['accountability'];
  if (!isPlainRecord(accountability) || !hasExactKeys(accountability, CANDIDATE_ACCOUNTABILITY_KEYS)) {
    issues.push(issue('invalid-schema', 'accountability', 'must contain only accountability fields'));
  } else {
    if (!isOpaqueRef(accountability['accountableRef'])) {
      issues.push(issue('invalid-field', 'accountability.accountableRef', 'must be a bounded opaque ref'));
    }
    if (accountability['dueAt'] !== null && timestampMillis(accountability['dueAt']) === null) {
      issues.push(issue('invalid-timestamp', 'accountability.dueAt', 'must be null or a canonical ISO-8601 timestamp'));
    }
  }

  const intent = value['intent'];
  if (!isPlainRecord(intent) || !hasExactKeys(intent, CANDIDATE_INTENT_KEYS)) {
    issues.push(issue('invalid-schema', 'intent', 'must contain only bounded intent fields'));
  } else {
    if (!isCanonicalText(intent['title'], MAX_TITLE_LENGTH)) issues.push(issue('invalid-field', 'intent.title', 'invalid title'));
    if (!isCanonicalText(intent['objective'], MAX_OBJECTIVE_LENGTH)) issues.push(issue('invalid-field', 'intent.objective', 'invalid objective'));
    if (!isCanonicalText(intent['desiredOutcome'], MAX_OUTCOME_LENGTH)) issues.push(issue('invalid-field', 'intent.desiredOutcome', 'invalid desired outcome'));
    for (const key of ['constraints', 'successSignals', 'guardrails'] as const) {
      if (!validList(intent[key])) issues.push(issue('invalid-field', `intent.${key}`, 'must be a non-empty bounded unique string list'));
    }
  }

  if (issues.length === 0) {
    const clone = canonicalizeBounded(value, MAX_ECOSYSTEM_ENVELOPE_BYTES);
    if (clone === null) {
      issues.push(issue('too-large', '$', 'canonical candidate exceeds the byte bound'));
    } else {
      const candidate = clone as unknown as CortexMissionCandidateV1;
      if (cortexMissionCandidateDigest(candidate) !== candidate.candidateDigest) {
        issues.push(issue('digest-mismatch', 'candidateDigest', 'candidate digest does not match canonical content'));
      } else {
        sanitized = candidate;
      }
    }
  }
  return issues.length === 0 && sanitized !== null
    ? { ok: true, value: sanitized, issues: [] }
    : { ok: false, issues };
}

function evidenceDigestPayload(envelope: LocusBoundEvidenceEnvelopeV1): unknown {
  return {
    schemaVersion: envelope.schemaVersion,
    authority: envelope.authority,
    digestAlgorithm: envelope.digestAlgorithm,
    envelopeId: envelope.envelopeId,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    idempotencyKey: envelope.idempotencyKey,
    mission: envelope.mission,
    identity: envelope.identity,
    operation: envelope.operation,
    result: envelope.result,
    attestation: envelope.attestation,
  };
}

/** Canonical integrity digest. It does not verify the attestation signature. */
export function locusBoundEvidenceEnvelopeDigest(envelope: LocusBoundEvidenceEnvelopeV1): string {
  return sha256(evidenceDigestPayload(envelope));
}

function secretLike(value: string): boolean {
  return /^(?:phm:|env:|test:|hmac-sha256:|ctx_pat_|ghp_|sk[-_])/i.test(value);
}

/** Strictly validate a Locus identity-evidence envelope from an untrusted boundary. */
export function validateLocusBoundEvidenceEnvelope(
  value: unknown,
  options: EcosystemEnvelopeValidationOptions = {},
): EcosystemEnvelopeValidationResult<LocusBoundEvidenceEnvelopeV1> {
  const issues: EcosystemEnvelopeValidationIssue[] = [];
  let sanitized: LocusBoundEvidenceEnvelopeV1 | null = null;
  if (!isPlainRecord(value) || !hasExactKeys(value, EVIDENCE_KEYS)) {
    return { ok: false, issues: [issue('invalid-schema', '$', 'evidence must contain only the V1 schema fields')] };
  }
  if (value['schemaVersion'] !== 1 || value['authority'] !== 'identity-evidence-only' ||
      value['digestAlgorithm'] !== 'sha256') {
    issues.push(issue('invalid-schema', '$', 'unsupported evidence version, authority, or digest algorithm'));
  }
  if (!isDigest(value['envelopeDigest'])) issues.push(issue('invalid-digest', 'envelopeDigest', 'must be lowercase SHA-256'));
  if (!isOpaqueRef(value['envelopeId'], MAX_ID_LENGTH)) issues.push(issue('invalid-field', 'envelopeId', 'must be a bounded opaque id'));
  if (!isOpaqueRef(value['idempotencyKey'], MAX_ID_LENGTH)) issues.push(issue('invalid-field', 'idempotencyKey', 'must be a bounded opaque id'));
  const window = validateClockWindow(value['issuedAt'], value['expiresAt'], options, issues);

  const mission = value['mission'];
  if (!isPlainRecord(mission) || !hasExactKeys(mission, EVIDENCE_MISSION_KEYS)) {
    issues.push(issue('invalid-schema', 'mission', 'must contain only mission binding fields'));
  } else if (!isDigest(mission['graphDigest']) || !isOpaqueRef(mission['nodeKey']) ||
             !['external-read', 'proposal-only-write'].includes(String(mission['purpose']))) {
    issues.push(issue('invalid-field', 'mission', 'contains an invalid mission binding'));
  }

  const identity = value['identity'];
  if (!isPlainRecord(identity) || !hasExactKeys(identity, EVIDENCE_IDENTITY_KEYS)) {
    issues.push(issue('invalid-schema', 'identity', 'must contain only opaque identity refs'));
  } else {
    for (const key of ['bindingRef', 'tenantRef', 'principalRef', 'sessionRef'] as const) {
      if (!isOpaqueRef(identity[key]) || secretLike(String(identity[key]))) {
        issues.push(issue('invalid-field', `identity.${key}`, 'must be a bounded opaque, non-secret ref'));
      }
    }
    const sealAt = timestampMillis(identity['sealVerifiedAt']);
    if (sealAt === null) issues.push(issue('invalid-timestamp', 'identity.sealVerifiedAt', 'must be a canonical ISO-8601 timestamp'));
    if (sealAt !== null && window.issued !== null && sealAt > window.issued) {
      issues.push(issue('invalid-timestamp', 'identity.sealVerifiedAt', 'cannot be later than issuedAt'));
    }
  }

  const operation = value['operation'];
  if (!isPlainRecord(operation) || !hasExactKeys(operation, EVIDENCE_OPERATION_KEYS)) {
    issues.push(issue('invalid-schema', 'operation', 'must contain only bounded operation fields'));
  } else {
    if (!isOpaqueRef(operation['provider']) || !isOpaqueRef(operation['tool'], MAX_TOOL_LENGTH) ||
        !isDigest(operation['selectorsDigest']) || !isDigest(operation['argsDigest']) ||
        !['read', 'proposal-only'].includes(String(operation['effectClass']))) {
      issues.push(issue('invalid-field', 'operation', 'contains an invalid provider, tool, digest, or effect class'));
    }
    if (isPlainRecord(mission)) {
      const expected = mission['purpose'] === 'external-read' ? 'read' :
        mission['purpose'] === 'proposal-only-write' ? 'proposal-only' : null;
      if (expected !== null && operation['effectClass'] !== expected) {
        issues.push(issue('invalid-boundary', 'operation.effectClass', 'effect class does not match mission purpose'));
      }
    }
  }

  const result = value['result'];
  if (!isPlainRecord(result) || !hasExactKeys(result, EVIDENCE_RESULT_KEYS)) {
    issues.push(issue('invalid-schema', 'result', 'must contain only bounded result fields'));
  } else {
    if (!['observed', 'denied', 'failed', 'transport-unknown'].includes(String(result['state']))) {
      issues.push(issue('invalid-field', 'result.state', 'invalid result state'));
    }
    if (result['receiptRef'] !== null && (!isOpaqueRef(result['receiptRef']) || secretLike(String(result['receiptRef'])))) {
      issues.push(issue('invalid-field', 'result.receiptRef', 'must be null or a bounded opaque ref'));
    }
    if (result['responseDigest'] !== null && !isDigest(result['responseDigest'])) {
      issues.push(issue('invalid-digest', 'result.responseDigest', 'must be null or lowercase SHA-256'));
    }
    const observedAt = timestampMillis(result['observedAt']);
    if (observedAt === null) issues.push(issue('invalid-timestamp', 'result.observedAt', 'must be a canonical ISO-8601 timestamp'));
    if (observedAt !== null && window.issued !== null && observedAt > window.issued) {
      issues.push(issue('invalid-timestamp', 'result.observedAt', 'cannot be later than issuedAt'));
    }
    if (result['state'] === 'observed' && result['responseDigest'] === null) {
      issues.push(issue('invalid-digest', 'result.responseDigest', 'observed evidence requires a response digest'));
    }
    if (isPlainRecord(operation) && operation['effectClass'] === 'proposal-only' &&
        result['state'] === 'observed' && result['receiptRef'] === null) {
      issues.push(issue('invalid-field', 'result.receiptRef', 'observed proposal-only evidence requires a receipt ref'));
    }
  }

  const attestation = value['attestation'];
  if (!isPlainRecord(attestation) || !hasExactKeys(attestation, EVIDENCE_ATTESTATION_KEYS)) {
    issues.push(issue('invalid-schema', 'attestation', 'must contain only attestation fields'));
  } else {
    if (!['unverified-local', 'signed-locus-v1'].includes(String(attestation['kind'])) ||
        !isOpaqueRef(attestation['issuerRevision'])) {
      issues.push(issue('invalid-field', 'attestation', 'invalid kind or issuer revision'));
    }
    if (attestation['kind'] === 'unverified-local' && attestation['signature'] !== null) {
      issues.push(issue('invalid-boundary', 'attestation.signature', 'unverified-local evidence cannot carry a signature'));
    }
    if (attestation['kind'] === 'signed-locus-v1') {
      const signature = attestation['signature'];
      if (typeof signature !== 'string' || signature.length < 32 ||
          signature.length > MAX_SIGNATURE_LENGTH || !SAFE_SIGNATURE_RE.test(signature)) {
        issues.push(issue('invalid-field', 'attestation.signature', 'signed evidence requires a bounded encoded signature'));
      }
    }
  }

  if (issues.length === 0) {
    const clone = canonicalizeBounded(value, MAX_ECOSYSTEM_ENVELOPE_BYTES);
    if (clone === null) {
      issues.push(issue('too-large', '$', 'canonical evidence envelope exceeds the byte bound'));
    } else {
      const envelope = clone as unknown as LocusBoundEvidenceEnvelopeV1;
      if (locusBoundEvidenceEnvelopeDigest(envelope) !== envelope.envelopeDigest) {
        issues.push(issue('digest-mismatch', 'envelopeDigest', 'evidence digest does not match canonical content'));
      } else {
        sanitized = envelope;
      }
    }
  }
  return issues.length === 0 && sanitized !== null
    ? { ok: true, value: sanitized, issues: [] }
    : { ok: false, issues };
}

export type LocusRealizationEvidenceReason =
  | 'invalid-envelope'
  | 'mission-mismatch'
  | 'unverified-local'
  | 'verification-context-invalid'
  | 'signature-unverified'
  | 'identity-mismatch'
  | 'operation-mismatch'
  | 'not-observed'
  | 'missing-receipt'
  | 'eligible';

export interface LocusVerifiedEnvelopeBinding {
  /** Exact digest returned by a separately authoritative signature verifier. */
  envelopeDigest: string;
  /** Expected active identity context, independently sourced by the caller. */
  identity: {
    bindingRef: string;
    tenantRef: string;
    principalRef: string;
    sessionRef: string;
  };
  /** Expected operation context; prevents provider/tool/argument substitution. */
  operation: LocusBoundEvidenceEnvelopeV1['operation'];
}

export interface LocusRealizationEvidenceContext {
  now: string;
  graphDigest: string;
  nodeKey: string;
  purpose: LocusEvidencePurpose;
  verifiedEnvelope: LocusVerifiedEnvelopeBinding;
}

export interface LocusRealizationEvidenceAssessment {
  eligible: boolean;
  reason: LocusRealizationEvidenceReason;
}

/**
 * Determine whether a valid envelope may be considered by a realization
 * reader. The verified digest must come from a separate signature verifier;
 * this function binds that result to exact mission, identity, and operation
 * context rather than accepting a free-form boolean assertion.
 */
export function assessLocusEvidenceForRealization(
  value: unknown,
  context: LocusRealizationEvidenceContext,
): LocusRealizationEvidenceAssessment {
  const validated = validateLocusBoundEvidenceEnvelope(value, { now: context.now });
  if (!validated.ok) return { eligible: false, reason: 'invalid-envelope' };
  const envelope = validated.value;
  if (envelope.mission.graphDigest !== context.graphDigest ||
      envelope.mission.nodeKey !== context.nodeKey ||
      envelope.mission.purpose !== context.purpose) {
    return { eligible: false, reason: 'mission-mismatch' };
  }
  if (envelope.attestation.kind === 'unverified-local') {
    return { eligible: false, reason: 'unverified-local' };
  }
  const verified = context.verifiedEnvelope;
  if (!isPlainRecord(verified) || !hasExactKeys(verified, VERIFIED_ENVELOPE_KEYS) ||
      !isDigest(verified['envelopeDigest']) ||
      !isPlainRecord(verified['identity']) ||
      !hasExactKeys(verified['identity'], EXPECTED_IDENTITY_KEYS) ||
      !isPlainRecord(verified['operation']) ||
      !hasExactKeys(verified['operation'], EVIDENCE_OPERATION_KEYS)) {
    return { eligible: false, reason: 'verification-context-invalid' };
  }
  const expectedIdentity = verified['identity'];
  for (const key of ['bindingRef', 'tenantRef', 'principalRef', 'sessionRef'] as const) {
    if (!isOpaqueRef(expectedIdentity[key]) || secretLike(String(expectedIdentity[key]))) {
      return { eligible: false, reason: 'verification-context-invalid' };
    }
  }
  const expectedOperation = verified['operation'];
  if (!isOpaqueRef(expectedOperation['provider']) ||
      !isOpaqueRef(expectedOperation['tool'], MAX_TOOL_LENGTH) ||
      !isDigest(expectedOperation['selectorsDigest']) || !isDigest(expectedOperation['argsDigest']) ||
      (expectedOperation['effectClass'] !== 'read' && expectedOperation['effectClass'] !== 'proposal-only')) {
    return { eligible: false, reason: 'verification-context-invalid' };
  }
  if (envelope.envelopeDigest !== verified['envelopeDigest']) {
    return { eligible: false, reason: 'signature-unverified' };
  }
  if (envelope.identity.bindingRef !== expectedIdentity['bindingRef'] ||
      envelope.identity.tenantRef !== expectedIdentity['tenantRef'] ||
      envelope.identity.principalRef !== expectedIdentity['principalRef'] ||
      envelope.identity.sessionRef !== expectedIdentity['sessionRef']) {
    return { eligible: false, reason: 'identity-mismatch' };
  }
  if (envelope.operation.provider !== expectedOperation['provider'] ||
      envelope.operation.tool !== expectedOperation['tool'] ||
      envelope.operation.selectorsDigest !== expectedOperation['selectorsDigest'] ||
      envelope.operation.argsDigest !== expectedOperation['argsDigest'] ||
      envelope.operation.effectClass !== expectedOperation['effectClass']) {
    return { eligible: false, reason: 'operation-mismatch' };
  }
  if (envelope.result.state !== 'observed' || envelope.result.responseDigest === null) {
    return { eligible: false, reason: 'not-observed' };
  }
  if (envelope.operation.effectClass === 'proposal-only' && envelope.result.receiptRef === null) {
    return { eligible: false, reason: 'missing-receipt' };
  }
  return { eligible: true, reason: 'eligible' };
}

export interface CurrentLocusReadinessProjectionV1 {
  version: string;
  status: 'ready';
  statusOneline: string;
  bindingAlias: string;
  tenant: string;
  bindingId: string;
  expiresAt: string;
}

export type CurrentLocusReadinessBlocker =
  | 'invalid-report'
  | 'not-ready'
  | 'invalid-pin'
  | 'invalid-seal'
  | 'expired-pin'
  | 'frozen-pin'
  | 'identity-mismatch'
  | 'invalid-mcp-contract';

export type CurrentLocusReadinessResult =
  | { allow: true; blockers: []; readiness: CurrentLocusReadinessProjectionV1 }
  | { allow: false; blockers: CurrentLocusReadinessBlocker[]; readiness: null };

/**
 * Strict, sanitized wrapper around the currently documented Locus report.
 * Unknown fields, oversized reports, and missing positive pin facts block;
 * `status_oneline` alone is never sufficient identity evidence.
 */
export function evaluateCurrentLocusReadiness(
  value: unknown,
  options: { now: string },
): CurrentLocusReadinessResult {
  const blockers: CurrentLocusReadinessBlocker[] = [];
  const now = timestampMillis(options.now);
  const boundedClone = canonicalizeBounded(value, MAX_ECOSYSTEM_ENVELOPE_BYTES);
  if (!isPlainRecord(boundedClone) || now === null) {
    return { allow: false, blockers: ['invalid-report'], readiness: null };
  }
  const report = boundedClone;
  const rootKeys = Object.keys(report);
  if (!isBoundedJson(report, MAX_ECOSYSTEM_ENVELOPE_BYTES) ||
      ![...CURRENT_LOCUS_REPORT_REQUIRED_KEYS].every((key) => rootKeys.includes(key)) ||
      !rootKeys.every((key) => CURRENT_LOCUS_REPORT_ALLOWED_KEYS.has(key)) ||
      !isPlainRecord(report['doctor']) || !isPlainRecord(report['commands']) ||
      !isCanonicalText(report['home'], 4_096)) {
    blockers.push('invalid-report');
  }
  const version = report['version'];
  const statusOneline = report['status_oneline'];
  if (!isCanonicalText(version, 40) || report['ready'] !== true || report['status'] !== 'ready' ||
      report['exit_code'] !== 0 || !isCanonicalText(statusOneline, MAX_REF_LENGTH)) {
    blockers.push('not-ready');
  }
  const pin = report['pin'];
  let alias: string | null = null;
  let tenant: string | null = null;
  let bindingId: string | null = null;
  let expiresAt: string | null = null;
  if (!isPlainRecord(pin)) {
    blockers.push('invalid-pin');
  } else {
    const pinKeys = Object.keys(pin);
    if (![...CURRENT_LOCUS_PIN_REQUIRED_KEYS].every((key) => pinKeys.includes(key)) ||
        !pinKeys.every((key) => CURRENT_LOCUS_PIN_ALLOWED_KEYS.has(key))) {
      blockers.push('invalid-pin');
    }
    for (const key of ['principal', 'client'] as const) {
      const optionalRef = pin[key];
      if (optionalRef !== undefined && optionalRef !== null && !isOpaqueRef(optionalRef)) {
        blockers.push('invalid-pin');
      }
    }
    alias = typeof pin['alias'] === 'string' && PIN_PART_RE.test(pin['alias']) ? pin['alias'] : null;
    tenant = typeof pin['tenant'] === 'string' && PIN_PART_RE.test(pin['tenant']) ? pin['tenant'] : null;
    bindingId = isOpaqueRef(pin['binding_id']) ? pin['binding_id'] : null;
    expiresAt = timestampMillis(pin['expires_at']) === null ? null : pin['expires_at'] as string;
    if (alias === null || tenant === null || bindingId === null || expiresAt === null) blockers.push('invalid-pin');
    if (pin['seal_ok'] !== true) blockers.push('invalid-seal');
    if (pin['expired'] !== false || (expiresAt !== null && now !== null && Date.parse(expiresAt) <= now)) blockers.push('expired-pin');
    // Missing is not false: older/partial reports cannot assert the session is unfrozen.
    if (pin['frozen'] !== false) blockers.push('frozen-pin');
  }
  if (alias !== null && tenant !== null && statusOneline !== `${alias}:${tenant}`) {
    blockers.push('identity-mismatch');
  }
  const servers = report['required_servers'];
  const mcp = report['mcp_registered'];
  if (!Array.isArray(servers) || servers.length !== 2 ||
      servers[0] !== 'locus' || servers[1] !== 'phantom' ||
      report['mcp_command'] !== 'locus-mcp' ||
      !isPlainRecord(mcp) || !hasExactKeys(mcp, new Set(['claude', 'cursor', 'codex'])) ||
      !['claude', 'cursor', 'codex'].every((key) => typeof mcp[key] === 'boolean') ||
      !['claude', 'cursor', 'codex'].some((key) => mcp[key] === true)) {
    blockers.push('invalid-mcp-contract');
  }
  const unique = [...new Set(blockers)];
  if (unique.length > 0 || typeof version !== 'string' || typeof statusOneline !== 'string' ||
      alias === null || tenant === null || bindingId === null || expiresAt === null) {
    return { allow: false, blockers: unique, readiness: null };
  }
  return {
    allow: true,
    blockers: [],
    readiness: {
      version,
      status: 'ready',
      statusOneline,
      bindingAlias: alias,
      tenant,
      bindingId,
      expiresAt,
    },
  };
}
