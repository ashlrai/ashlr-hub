/**
 * Independently signed source bundle for the Agent OS read model.
 *
 * Hub never mints these signatures. A deployment provisions role-separated
 * Ed25519 public keys, ingests canonical signed bytes, and receives a verifier
 * closed over exactly one authenticated bundle. The bundle remains
 * observation-only and grants no planning or execution authority.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto';

import type { AgentNativeKernelEvidenceV1 } from './agent-native-kernel.js';
import {
  buildAgentOsReadModelV1,
  type AgentOsReadModelInputV1,
  type AgentOsReadModelVerifierV1,
  type AgentOsSourceBundleVerificationInputV1,
} from './agent-os-read-model.js';
import type { OutcomeEvidenceVerificationInputV1 } from './value-portfolio.js';

export const AGENT_OS_SOURCE_BUNDLE_PROTOCOL = 'ashlr-agent-os-source-bundle-v1' as const;
export const AGENT_OS_SOURCE_TRUST_PROTOCOL = 'ashlr-agent-os-source-trust-v1' as const;
export const AGENT_OS_SOURCE_SIGNATURE_ALGORITHM = 'ed25519' as const;
export const AGENT_OS_SOURCE_BUNDLE_MAX_LIFETIME_MS = 5 * 60_000;
export const AGENT_OS_SOURCE_BUNDLE_MAX_FUTURE_SKEW_MS = 60_000;
export const AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST = '0'.repeat(64);
export const AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE = 4_096;

const EVIDENCE_RECEIPT_PROTOCOL = 'ashlr-agent-os-evidence-index-receipt-v1' as const;
const OUTCOME_RECEIPT_PROTOCOL = 'ashlr-agent-os-outcome-receipt-v1' as const;
const MAX_TRUST_KEYS = 48;
const MAX_PRODUCER_BINDINGS = 12;
const MAX_OUTCOME_RECEIPTS = 12;
const MAX_CANONICAL_BYTES = 768 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_CANONICAL_NODES = 100_000;
const DIGEST_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const KEY_ID_RE = /^[a-f0-9]{64}$/;

export type AgentOsSourceTrustRoleV1 =
  | 'source-observer'
  | 'evidence-index-observer'
  | 'outcome-observer';

export interface AgentOsSourceTrustKeyV1 {
  keyId: string;
  principalDigest: string;
  role: AgentOsSourceTrustRoleV1;
  signatureAlgorithm: typeof AGENT_OS_SOURCE_SIGNATURE_ALGORITHM;
  publicKeySpki: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

export interface AgentOsSourceTrustPolicyV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_SOURCE_TRUST_PROTOCOL;
  generation: number;
  keys: readonly AgentOsSourceTrustKeyV1[];
}

/** Production intentionally starts fail-closed until roots are provisioned. */
export const DEFAULT_AGENT_OS_SOURCE_TRUST_POLICY_V1: AgentOsSourceTrustPolicyV1 = Object.freeze({
  schemaVersion: 1,
  protocol: AGENT_OS_SOURCE_TRUST_PROTOCOL,
  generation: 0,
  keys: Object.freeze([]),
});

export interface AgentOsHypothesisProducerBindingV1 {
  producerDigest: string;
  principalDigest: string;
  bindingAuthority: 'source-observer-attestation';
}

export interface AgentOsEvidenceIndexReceiptUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof EVIDENCE_RECEIPT_PROTOCOL;
  keyId: string;
  principalDigest: string;
  signatureAlgorithm: typeof AGENT_OS_SOURCE_SIGNATURE_ALGORITHM;
  specDigest: string;
  missionDigest: string;
  evidence: AgentNativeKernelEvidenceV1;
}

export interface AgentOsEvidenceIndexReceiptV1 extends AgentOsEvidenceIndexReceiptUnsignedV1 {
  signature: string;
}

export interface AgentOsOutcomeReceiptUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof OUTCOME_RECEIPT_PROTOCOL;
  keyId: string;
  principalDigest: string;
  signatureAlgorithm: typeof AGENT_OS_SOURCE_SIGNATURE_ALGORITHM;
  input: OutcomeEvidenceVerificationInputV1;
}

export interface AgentOsOutcomeReceiptV1 extends AgentOsOutcomeReceiptUnsignedV1 {
  signature: string;
}

interface AgentOsSourceBundleEffectsV1 {
  files: false;
  models: false;
  providers: false;
  dispatches: false;
  goals: false;
  proposals: false;
  merges: false;
  releases: false;
  deployments: false;
  publications: false;
  externalMutations: false;
  budgets: false;
  learning: false;
}

export interface AgentOsSourceBundleUnsignedV1 {
  schemaVersion: 1;
  protocol: typeof AGENT_OS_SOURCE_BUNDLE_PROTOCOL;
  recordType: 'agent-os-source-bundle';
  authority: 'observation-only';
  planningAuthority: false;
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
  learningAuthority: false;
  budgetAuthority: false;
  effects: AgentOsSourceBundleEffectsV1;
  sequence: number;
  previousBundleDigest: string;
  issuedAt: string;
  expiresAt: string;
  policyGeneration: number;
  trustPolicyDigest: string;
  sourceKeyId: string;
  sourcePrincipalDigest: string;
  readModelInput: AgentOsReadModelInputV1;
  evidenceIndexReceipt: AgentOsEvidenceIndexReceiptV1;
  producerBindings: AgentOsHypothesisProducerBindingV1[];
  outcomeReceipts: AgentOsOutcomeReceiptV1[];
}

export interface AgentOsSourceBundleEnvelopeV1 extends AgentOsSourceBundleUnsignedV1 {
  bundleDigest: string;
  signatureAlgorithm: typeof AGENT_OS_SOURCE_SIGNATURE_ALGORITHM;
  signature: string;
}

export type AgentOsSourceBundleIssueV1 =
  | 'invalid-input'
  | 'trust-policy-invalid'
  | 'trust-policy-mismatch'
  | 'trust-root-unprovisioned'
  | 'source-key-unknown'
  | 'source-key-invalid'
  | 'source-key-inactive'
  | 'source-key-revoked'
  | 'evidence-key-unknown'
  | 'evidence-key-invalid'
  | 'evidence-key-inactive'
  | 'evidence-key-revoked'
  | 'source-evidence-separation-failed'
  | 'bundle-not-current'
  | 'bundle-expired'
  | 'bundle-digest-invalid'
  | 'bundle-signature-invalid'
  | 'evidence-signature-invalid'
  | 'evidence-binding-mismatch'
  | 'producer-binding-invalid'
  | 'outcome-key-unknown'
  | 'outcome-key-invalid'
  | 'outcome-key-inactive'
  | 'outcome-key-revoked'
  | 'outcome-observer-separation-failed'
  | 'outcome-producer-separation-failed'
  | 'outcome-signature-invalid'
  | 'outcome-binding-mismatch'
  | 'read-model-invalid';

export type AgentOsSourceBundleVerificationResultV1 =
  | {
      ok: true;
      bundleDigest: string;
      readModelInput: AgentOsReadModelInputV1;
      verifier: AgentOsReadModelVerifierV1;
      issues: [];
    }
  | {
      ok: false;
      bundleDigest: null;
      readModelInput: null;
      verifier: null;
      issues: [AgentOsSourceBundleIssueV1];
    };

const POLICY_KEYS = ['generation', 'keys', 'protocol', 'schemaVersion'] as const;
const TRUST_KEY_KEYS = [
  'keyId', 'notAfter', 'notBefore', 'principalDigest', 'publicKeySpki', 'revokedAt',
  'role', 'signatureAlgorithm',
] as const;
const UNSIGNED_BUNDLE_KEYS = [
  'authority', 'budgetAuthority', 'deployAuthority', 'effects', 'evidenceIndexReceipt',
  'executionAuthority', 'expiresAt', 'externalMutationAuthority', 'issuedAt',
  'learningAuthority', 'mergeAuthority', 'outcomeReceipts', 'planningAuthority',
  'policyGeneration', 'previousBundleDigest', 'producerBindings', 'proposalAuthority', 'protocol',
  'publicationAuthority', 'readModelInput', 'recordType', 'releaseAuthority',
  'schemaVersion', 'sequence', 'sourceKeyId', 'sourcePrincipalDigest', 'trustPolicyDigest',
] as const;
const ENVELOPE_KEYS = [...UNSIGNED_BUNDLE_KEYS, 'bundleDigest', 'signatureAlgorithm', 'signature'] as const;
const EFFECT_KEYS = [
  'budgets', 'deployments', 'dispatches', 'externalMutations', 'files', 'goals', 'learning',
  'merges', 'models', 'proposals', 'providers', 'publications', 'releases',
] as const;
const PRODUCER_BINDING_KEYS = ['bindingAuthority', 'principalDigest', 'producerDigest'] as const;
const EVIDENCE_UNSIGNED_KEYS = [
  'evidence', 'keyId', 'missionDigest', 'principalDigest', 'protocol', 'schemaVersion',
  'signatureAlgorithm', 'specDigest',
] as const;
const EVIDENCE_RECEIPT_KEYS = [...EVIDENCE_UNSIGNED_KEYS, 'signature'] as const;
const OUTCOME_UNSIGNED_KEYS = [
  'input', 'keyId', 'principalDigest', 'protocol', 'schemaVersion', 'signatureAlgorithm',
] as const;
const OUTCOME_RECEIPT_KEYS = [...OUTCOME_UNSIGNED_KEYS, 'signature'] as const;
const EVIDENCE_INDEX_KEYS = [
  'evidenceDigest', 'format', 'observedAt', 'portfolioDigest', 'resourceDigest', 'sourceComplete',
] as const;
const SOURCE_TUPLE_KEYS = [
  'capabilityProjectionDigest', 'evidenceIndexDigest', 'hypothesisDigests',
  'kernelCycleDigest', 'outcomeReceiptDigests', 'portfolioDigest', 'renderedAt',
] as const;

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !descriptors[String(key)]?.enumerable ||
      !Object.hasOwn(descriptors[String(key)]!, 'value'))) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function canonicalize(
  value: unknown,
  state = { depth: 0, nodes: 0, ancestors: new Set<object>() },
): Canonical {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || state.depth > MAX_CANONICAL_DEPTH) throw new TypeError('value too large');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || state.ancestors.has(value)) throw new TypeError('non-json value');
  state.ancestors.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' ||
        (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) throw new TypeError('invalid array');
      return value.map((entry, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('sparse array');
        return canonicalize(entry, state);
      });
    }
    const row = record(value);
    if (!row) throw new TypeError('non-plain object');
    const output: { [key: string]: Canonical } = Object.create(null) as { [key: string]: Canonical };
    for (const key of Object.keys(row).sort()) output[key] = canonicalize(row[key], state);
    return output;
  } finally {
    state.depth -= 1;
    state.ancestors.delete(value);
  }
}

function canonicalBytes(value: unknown): Buffer | null {
  try {
    const bytes = Buffer.from(JSON.stringify(canonicalize(value)), 'utf8');
    return bytes.length <= MAX_CANONICAL_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/** Canonical exact envelope bytes used by durable content-addressed storage. */
export function canonicalAgentOsSourceBundleEnvelopeBytesV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row || !exactKeys(row, ENVELOPE_KEYS)) return null;
  return canonicalBytes(row);
}

function detached(value: unknown): unknown | null {
  const bytes = canonicalBytes(value);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return null; }
}

function sha(domain: string, bytes: Uint8Array): string {
  return createHash('sha256').update(domain, 'utf8').update('\0').update(bytes).digest('hex');
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function base64url(value: unknown, minimum: number, maximum: number): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length >= minimum && bytes.length <= maximum && bytes.toString('base64url') === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && sameBytes(Buffer.from(left), Buffer.from(right));
}

function publicKey(value: unknown): KeyObject | null {
  const bytes = base64url(value, 32, 128);
  if (!bytes) return null;
  try {
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonical = Buffer.from(key.export({ format: 'der', type: 'spki' }));
    return key.asymmetricKeyType === 'ed25519' && sameBytes(canonical, bytes) ? key : null;
  } catch {
    return null;
  }
}

export function agentOsSourceTrustKeyIdV1(
  publicKeySpki: unknown,
  role: unknown,
): string | null {
  if (!['source-observer', 'evidence-index-observer', 'outcome-observer'].includes(String(role))) return null;
  const bytes = base64url(publicKeySpki, 32, 128);
  if (!bytes || !publicKey(publicKeySpki)) return null;
  return sha(`ashlr:agent-os-source-trust-key:${String(role)}:v1`, bytes);
}

function trustKeyShape(value: unknown): value is AgentOsSourceTrustKeyV1 {
  const row = record(value);
  return Boolean(row && exactKeys(row, TRUST_KEY_KEYS) && KEY_ID_RE.test(String(row['keyId'])) &&
    digest(row['principalDigest']) &&
    ['source-observer', 'evidence-index-observer', 'outcome-observer'].includes(String(row['role'])) &&
    row['signatureAlgorithm'] === AGENT_OS_SOURCE_SIGNATURE_ALGORITHM &&
    typeof row['publicKeySpki'] === 'string' && publicKey(row['publicKeySpki']) &&
    agentOsSourceTrustKeyIdV1(row['publicKeySpki'], row['role']) === row['keyId'] &&
    canonicalIso(row['notBefore']) && canonicalIso(row['notAfter']) &&
    Date.parse(row['notBefore'] as string) < Date.parse(row['notAfter'] as string) &&
    (row['revokedAt'] === null || canonicalIso(row['revokedAt'])));
}

function normalizePolicy(value: unknown): AgentOsSourceTrustPolicyV1 | null {
  const row = record(value);
  if (!row || !exactKeys(row, POLICY_KEYS) || row['schemaVersion'] !== 1 ||
    row['protocol'] !== AGENT_OS_SOURCE_TRUST_PROTOCOL || !Number.isSafeInteger(row['generation']) ||
    Number(row['generation']) < 0 || !Array.isArray(row['keys']) || row['keys'].length > MAX_TRUST_KEYS) return null;
  let prior = '';
  const principals = new Set<string>();
  for (const entry of row['keys']) {
    if (!trustKeyShape(entry) || entry.keyId <= prior) return null;
    // A principal cannot satisfy more than one independent trust role. Key
    // rotation and role changes require a new principal in a new generation.
    if (principals.has(entry.principalDigest)) return null;
    principals.add(entry.principalDigest);
    prior = entry.keyId;
  }
  return row as unknown as AgentOsSourceTrustPolicyV1;
}

export function agentOsSourceTrustPolicyDigestV1(value: unknown): string | null {
  const bytes = canonicalAgentOsSourceTrustPolicyBytesV1(value);
  return bytes ? sha('ashlr:agent-os-source-trust-policy:v1', bytes) : null;
}

/** Canonical policy bytes suitable for pinning one immutable verification view. */
export function canonicalAgentOsSourceTrustPolicyBytesV1(value: unknown): Buffer | null {
  const policy = normalizePolicy(value);
  return policy ? canonicalBytes(policy) : null;
}

export function canonicalAgentOsEvidenceIndexReceiptPayloadV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row || !exactKeys(row, EVIDENCE_UNSIGNED_KEYS)) return null;
  return canonicalBytes(row);
}

export function canonicalAgentOsOutcomeReceiptPayloadV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row || !exactKeys(row, OUTCOME_UNSIGNED_KEYS)) return null;
  return canonicalBytes(row);
}

export function canonicalAgentOsSourceBundlePayloadV1(value: unknown): Buffer | null {
  const row = record(value);
  if (!row || !exactKeys(row, UNSIGNED_BUNDLE_KEYS)) return null;
  return canonicalBytes(row);
}

export function agentOsSourceBundleDigestV1(unsigned: unknown, signature: unknown): string | null {
  const payload = canonicalAgentOsSourceBundlePayloadV1(unsigned);
  const signatureBytes = base64url(signature, 64, 64);
  if (!payload || !signatureBytes) return null;
  return sha('ashlr:agent-os-source-bundle-envelope:v1', Buffer.concat([payload, signatureBytes]));
}

function fail(issue: AgentOsSourceBundleIssueV1): AgentOsSourceBundleVerificationResultV1 {
  return { ok: false, bundleDigest: null, readModelInput: null, verifier: null, issues: [issue] };
}

function activeKeyReason(
  key: AgentOsSourceTrustKeyV1,
  issuedAt: number,
  expiresAt: number,
  now: number,
  prefix: 'source' | 'evidence' | 'outcome',
  historical: boolean,
): AgentOsSourceBundleIssueV1 | null {
  if (issuedAt < Date.parse(key.notBefore) || expiresAt > Date.parse(key.notAfter) ||
    (!historical && now >= Date.parse(key.notAfter))) {
    return `${prefix}-key-inactive` as AgentOsSourceBundleIssueV1;
  }
  if (key.revokedAt !== null && now >= Date.parse(key.revokedAt)) {
    return `${prefix}-key-revoked` as AgentOsSourceBundleIssueV1;
  }
  return null;
}

function verifyEd25519(payload: Buffer | null, signature: unknown, key: AgentOsSourceTrustKeyV1): boolean {
  const signatureBytes = base64url(signature, 64, 64);
  const parsedKey = publicKey(key.publicKeySpki);
  if (!payload || !signatureBytes || !parsedKey) return false;
  try { return verifySignature(null, payload, parsedKey, signatureBytes); } catch { return false; }
}

function sourceTuple(value: AgentOsReadModelInputV1): AgentOsSourceBundleVerificationInputV1 | null {
  try {
    const kernel = record(value.kernel);
    const kernelBasis = record(kernel?.['basis']);
    const spectrum = record(value.capabilitySpectrum);
    const portfolio = record(value.portfolio);
    if (!kernel || !kernelBasis || !spectrum || !portfolio || !Array.isArray(value.hypotheses)) return null;
    const hypotheses = value.hypotheses.map((hypothesis) => {
      const row = record(hypothesis);
      const source = record(row?.['outcomeSource']);
      const evidence = source ? record(source['evidence']) : null;
      return {
        hypothesisDigest: row?.['hypothesisDigest'],
        outcomeReceiptDigest: evidence?.['receiptDigest'] ?? null,
      };
    });
    if (hypotheses.some((entry) => !digest(entry.hypothesisDigest) ||
      (entry.outcomeReceiptDigest !== null && !digest(entry.outcomeReceiptDigest)))) return null;
    const tuple = {
      renderedAt: value.renderedAt,
      kernelCycleDigest: kernel['cycleDigest'],
      evidenceIndexDigest: kernelBasis['evidenceDigest'],
      capabilityProjectionDigest: spectrum['projectionDigest'],
      portfolioDigest: portfolio['portfolioDigest'],
      hypothesisDigests: hypotheses.map((entry) => entry.hypothesisDigest as string).sort(),
      outcomeReceiptDigests: hypotheses.flatMap((entry) =>
        entry.outcomeReceiptDigest === null ? [] : [entry.outcomeReceiptDigest as string]).sort(),
    };
    const row = record(tuple);
    return row && exactKeys(row, SOURCE_TUPLE_KEYS) && canonicalIso(tuple.renderedAt) &&
      digest(tuple.kernelCycleDigest) && digest(tuple.evidenceIndexDigest) &&
      digest(tuple.capabilityProjectionDigest) && digest(tuple.portfolioDigest)
      ? tuple as AgentOsSourceBundleVerificationInputV1
      : null;
  } catch {
    return null;
  }
}

function outcomeInputFromHypothesis(value: unknown): OutcomeEvidenceVerificationInputV1 | null {
  const row = record(value);
  const source = record(row?.['outcomeSource']);
  const evidence = source ? record(source['evidence']) : null;
  if (!row || !source || !evidence || !digest(row['producerDigest']) || !digest(row['specDigest']) ||
    !digest(row['missionDigest']) || !digest(source['sourceDigest'])) return null;
  return {
    evidence: evidence as unknown as OutcomeEvidenceVerificationInputV1['evidence'],
    sourceDigest: source['sourceDigest'] as string,
    producerDigest: row['producerDigest'] as string,
    specDigest: row['specDigest'] as string,
    missionDigest: row['missionDigest'] as string,
  };
}

function exactCanonicalMatch(left: unknown, right: unknown): boolean {
  const leftBytes = canonicalBytes(left);
  const rightBytes = canonicalBytes(right);
  return Boolean(leftBytes && rightBytes && sameBytes(leftBytes, rightBytes));
}

function closedVerifier(
  expectedTuple: AgentOsSourceBundleVerificationInputV1,
  outcomeInputs: ReadonlyMap<string, { inputDigest: string; independent: true }>,
): AgentOsReadModelVerifierV1 {
  const expectedTupleBytes = canonicalBytes(expectedTuple)!;
  return Object.freeze({
    verifySourceBundle(input: Readonly<AgentOsSourceBundleVerificationInputV1>) {
      const candidate = canonicalBytes(input);
      const authenticated = Boolean(candidate && sameBytes(candidate, expectedTupleBytes));
      return { sourceBundleAuthenticated: authenticated, evidenceIndexAuthenticated: authenticated };
    },
    outcomeEvidenceVerifier: Object.freeze({
      verifyOutcomeEvidence(input: Readonly<OutcomeEvidenceVerificationInputV1>) {
        const receiptDigest = record(input.evidence)?.['receiptDigest'];
        const bytes = canonicalBytes(input);
        const indexed = typeof receiptDigest === 'string' ? outcomeInputs.get(receiptDigest) : undefined;
        const authenticated = Boolean(bytes && indexed && sameText(
          sha('ashlr:agent-os-outcome-verification-input:v1', bytes),
          indexed.inputDigest,
        ));
        return { authenticated, independentObserver: authenticated && indexed?.independent === true };
      },
    }),
  });
}

/**
 * Verify one immutable bundle against an already-selected trust policy.
 * Callers must never construct `trustPolicy` from request or bundle data.
 */
export function verifyAgentOsSourceBundleV1(
  value: unknown,
  trustPolicy: AgentOsSourceTrustPolicyV1 = DEFAULT_AGENT_OS_SOURCE_TRUST_POLICY_V1,
  now: Date = new Date(),
  options: { historical?: boolean } = {},
): AgentOsSourceBundleVerificationResultV1 {
  try {
    const policy = normalizePolicy(trustPolicy);
    if (!policy) return fail('trust-policy-invalid');
    if (policy.keys.length === 0) return fail('trust-root-unprovisioned');
    const policyDigest = agentOsSourceTrustPolicyDigestV1(policy);
    if (!policyDigest) return fail('trust-policy-invalid');
    const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
    if (!Number.isFinite(nowMs)) return fail('invalid-input');

    const snapshot = detached(value);
    const envelope = record(snapshot);
    if (!envelope || !exactKeys(envelope, ENVELOPE_KEYS) || envelope['schemaVersion'] !== 1 ||
      envelope['protocol'] !== AGENT_OS_SOURCE_BUNDLE_PROTOCOL ||
      envelope['recordType'] !== 'agent-os-source-bundle' || envelope['authority'] !== 'observation-only' ||
      envelope['planningAuthority'] !== false || envelope['executionAuthority'] !== false ||
      envelope['proposalAuthority'] !== false || envelope['mergeAuthority'] !== false ||
      envelope['releaseAuthority'] !== false || envelope['deployAuthority'] !== false ||
      envelope['publicationAuthority'] !== false || envelope['externalMutationAuthority'] !== false ||
      envelope['learningAuthority'] !== false || envelope['budgetAuthority'] !== false ||
      !record(envelope['effects']) || !exactKeys(envelope['effects'] as Record<string, unknown>, EFFECT_KEYS) ||
      Object.values(envelope['effects'] as Record<string, unknown>).some((effect) => effect !== false) ||
      !Number.isSafeInteger(envelope['sequence']) || Number(envelope['sequence']) < 1 ||
      Number(envelope['sequence']) > AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE ||
      !KEY_ID_RE.test(String(envelope['previousBundleDigest'])) ||
      (Number(envelope['sequence']) === 1) !==
        sameText(envelope['previousBundleDigest'], AGENT_OS_SOURCE_BUNDLE_GENESIS_DIGEST) ||
      !canonicalIso(envelope['issuedAt']) || !canonicalIso(envelope['expiresAt']) ||
      !Number.isSafeInteger(envelope['policyGeneration']) || Number(envelope['policyGeneration']) < 0 ||
      !digest(envelope['trustPolicyDigest']) || !KEY_ID_RE.test(String(envelope['sourceKeyId'])) ||
      !digest(envelope['sourcePrincipalDigest']) || !Array.isArray(envelope['producerBindings']) ||
      envelope['producerBindings'].length > MAX_PRODUCER_BINDINGS || !Array.isArray(envelope['outcomeReceipts']) ||
      envelope['outcomeReceipts'].length > MAX_OUTCOME_RECEIPTS || !DIGEST_RE.test(String(envelope['bundleDigest'])) ||
      envelope['signatureAlgorithm'] !== AGENT_OS_SOURCE_SIGNATURE_ALGORITHM) return fail('invalid-input');
    if (envelope['policyGeneration'] !== policy.generation || !sameText(envelope['trustPolicyDigest'], policyDigest)) {
      return fail('trust-policy-mismatch');
    }

    const issuedAt = Date.parse(envelope['issuedAt'] as string);
    const expiresAt = Date.parse(envelope['expiresAt'] as string);
    if (issuedAt > nowMs + AGENT_OS_SOURCE_BUNDLE_MAX_FUTURE_SKEW_MS || expiresAt <= issuedAt ||
      expiresAt - issuedAt > AGENT_OS_SOURCE_BUNDLE_MAX_LIFETIME_MS) return fail('bundle-not-current');
    if (expiresAt <= nowMs && options.historical !== true) return fail('bundle-expired');

    const sourceKey = policy.keys.find((key) => key.keyId === envelope['sourceKeyId']);
    if (!sourceKey) return fail('source-key-unknown');
    if (sourceKey.role !== 'source-observer' || !sameText(sourceKey.principalDigest, envelope['sourcePrincipalDigest'])) {
      return fail('source-key-invalid');
    }
    const sourceKeyState = activeKeyReason(sourceKey, issuedAt, expiresAt, nowMs, 'source', options.historical === true);
    if (sourceKeyState) return fail(sourceKeyState);

    // Authenticate the complete aggregate before interpreting any nested
    // producer, evidence, or outcome assertion as trusted input.
    const unsignedBundle = Object.fromEntries(UNSIGNED_BUNDLE_KEYS.map((key) => [key, envelope[key]]));
    const expectedBundleDigest = agentOsSourceBundleDigestV1(unsignedBundle, envelope['signature']);
    if (!expectedBundleDigest || !sameText(expectedBundleDigest, envelope['bundleDigest'])) {
      return fail('bundle-digest-invalid');
    }
    if (!verifyEd25519(canonicalAgentOsSourceBundlePayloadV1(unsignedBundle), envelope['signature'], sourceKey)) {
      return fail('bundle-signature-invalid');
    }

    const evidenceReceipt = record(envelope['evidenceIndexReceipt']);
    if (!evidenceReceipt || !exactKeys(evidenceReceipt, EVIDENCE_RECEIPT_KEYS) ||
      evidenceReceipt['schemaVersion'] !== 1 || evidenceReceipt['protocol'] !== EVIDENCE_RECEIPT_PROTOCOL ||
      !KEY_ID_RE.test(String(evidenceReceipt['keyId'])) || !digest(evidenceReceipt['principalDigest']) ||
      evidenceReceipt['signatureAlgorithm'] !== AGENT_OS_SOURCE_SIGNATURE_ALGORITHM ||
      !digest(evidenceReceipt['specDigest']) || !digest(evidenceReceipt['missionDigest'])) return fail('invalid-input');
    const evidenceKey = policy.keys.find((key) => key.keyId === evidenceReceipt['keyId']);
    if (!evidenceKey) return fail('evidence-key-unknown');
    if (evidenceKey.role !== 'evidence-index-observer' ||
      !sameText(evidenceKey.principalDigest, evidenceReceipt['principalDigest'])) return fail('evidence-key-invalid');
    const evidenceKeyState = activeKeyReason(evidenceKey, issuedAt, expiresAt, nowMs, 'evidence', options.historical === true);
    if (evidenceKeyState) return fail(evidenceKeyState);
    if (sourceKey.keyId === evidenceKey.keyId || sourceKey.publicKeySpki === evidenceKey.publicKeySpki ||
      sameText(sourceKey.principalDigest, evidenceKey.principalDigest)) return fail('source-evidence-separation-failed');

    const evidenceUnsigned = Object.fromEntries(EVIDENCE_UNSIGNED_KEYS.map((key) => [key, evidenceReceipt[key]]));
    if (!verifyEd25519(
      canonicalAgentOsEvidenceIndexReceiptPayloadV1(evidenceUnsigned),
      evidenceReceipt['signature'],
      evidenceKey,
    )) return fail('evidence-signature-invalid');

    const readModelInput = record(envelope['readModelInput']) as unknown as AgentOsReadModelInputV1 | null;
    const tuple = readModelInput ? sourceTuple(readModelInput) : null;
    const kernel = readModelInput ? record(readModelInput.kernel) : null;
    const basis = record(kernel?.['basis']);
    const sources = record(kernel?.['sources']);
    const evidence = record(evidenceReceipt['evidence']);
    if (!readModelInput || !tuple || !kernel || !basis || !sources || !evidence ||
      !exactKeys(evidence, EVIDENCE_INDEX_KEYS) || evidence['format'] !== 'evidence-index-v1' ||
      typeof evidence['sourceComplete'] !== 'boolean' || !digest(evidence['evidenceDigest']) ||
      !digest(evidence['resourceDigest']) || !digest(evidence['portfolioDigest']) ||
      !canonicalIso(evidence['observedAt']) ||
      !sameText(evidenceReceipt['specDigest'], basis['specDigest']) ||
      !sameText(evidenceReceipt['missionDigest'], basis['missionDigest']) ||
      !sameText(evidence['evidenceDigest'], basis['evidenceDigest']) ||
      !sameText(evidence['resourceDigest'], basis['resourceDigest']) ||
      !sameText(evidence['portfolioDigest'], tuple.portfolioDigest) ||
      evidence['sourceComplete'] !== sources['evidenceComplete']) return fail('evidence-binding-mismatch');

    const hypothesisRows = readModelInput.hypotheses.map((hypothesis) => record(hypothesis));
    if (hypothesisRows.some((row) => !row || !digest(row['producerDigest']))) return fail('read-model-invalid');
    const expectedProducers = [...new Set(hypothesisRows.map((row) => row!['producerDigest'] as string))].sort();
    const producerPrincipals = new Map<string, string>();
    let priorProducer = '';
    for (const rawBinding of envelope['producerBindings']) {
      const binding = record(rawBinding);
      if (!binding || !exactKeys(binding, PRODUCER_BINDING_KEYS) || !digest(binding['producerDigest']) ||
        !digest(binding['principalDigest']) || binding['bindingAuthority'] !== 'source-observer-attestation' ||
        String(binding['producerDigest']) <= priorProducer) return fail('producer-binding-invalid');
      producerPrincipals.set(binding['producerDigest'] as string, binding['principalDigest'] as string);
      priorProducer = binding['producerDigest'] as string;
    }
    if (producerPrincipals.size !== expectedProducers.length ||
      expectedProducers.some((producer) => !producerPrincipals.has(producer))) return fail('producer-binding-invalid');

    const expectedOutcomes = new Map<string, OutcomeEvidenceVerificationInputV1>();
    for (const hypothesis of readModelInput.hypotheses) {
      const input = outcomeInputFromHypothesis(hypothesis);
      if (!input) continue;
      if (expectedOutcomes.has(input.evidence.receiptDigest)) return fail('outcome-binding-mismatch');
      expectedOutcomes.set(input.evidence.receiptDigest, input);
    }
    const authenticatedOutcomes = new Map<string, { inputDigest: string; independent: true }>();
    const outcomePrincipals = new Set<string>();
    const outcomePublicKeys = new Set<string>();
    let priorOutcome = '';
    for (const rawReceipt of envelope['outcomeReceipts']) {
      const receipt = record(rawReceipt);
      if (!receipt || !exactKeys(receipt, OUTCOME_RECEIPT_KEYS) || receipt['schemaVersion'] !== 1 ||
        receipt['protocol'] !== OUTCOME_RECEIPT_PROTOCOL || !KEY_ID_RE.test(String(receipt['keyId'])) ||
        !digest(receipt['principalDigest']) || receipt['signatureAlgorithm'] !== AGENT_OS_SOURCE_SIGNATURE_ALGORITHM) {
        return fail('invalid-input');
      }
      const receiptInput = record(receipt['input']);
      const receiptEvidence = record(receiptInput?.['evidence']);
      const receiptDigest = receiptEvidence?.['receiptDigest'];
      if (!digest(receiptDigest) || receiptDigest <= priorOutcome || authenticatedOutcomes.has(receiptDigest)) {
        return fail('outcome-binding-mismatch');
      }
      const expected = expectedOutcomes.get(receiptDigest);
      if (!expected || !exactCanonicalMatch(receipt['input'], expected)) return fail('outcome-binding-mismatch');
      const outcomeKey = policy.keys.find((key) => key.keyId === receipt['keyId']);
      if (!outcomeKey) return fail('outcome-key-unknown');
      if (outcomeKey.role !== 'outcome-observer' ||
        !sameText(outcomeKey.principalDigest, receipt['principalDigest'])) return fail('outcome-key-invalid');
      const outcomeKeyState = activeKeyReason(outcomeKey, issuedAt, expiresAt, nowMs, 'outcome', options.historical === true);
      if (outcomeKeyState) return fail(outcomeKeyState);
      if (outcomeKey.keyId === sourceKey.keyId || outcomeKey.publicKeySpki === sourceKey.publicKeySpki ||
        sameText(outcomeKey.principalDigest, sourceKey.principalDigest) ||
        outcomeKey.keyId === evidenceKey.keyId || outcomeKey.publicKeySpki === evidenceKey.publicKeySpki ||
        sameText(outcomeKey.principalDigest, evidenceKey.principalDigest) ||
        outcomePrincipals.has(outcomeKey.principalDigest) || outcomePublicKeys.has(outcomeKey.publicKeySpki)) {
        return fail('outcome-observer-separation-failed');
      }
      const producerPrincipal = producerPrincipals.get(expected.producerDigest);
      if (!producerPrincipal || sameText(producerPrincipal, outcomeKey.principalDigest)) {
        return fail('outcome-producer-separation-failed');
      }
      const unsignedReceipt = Object.fromEntries(OUTCOME_UNSIGNED_KEYS.map((key) => [key, receipt[key]]));
      if (!verifyEd25519(canonicalAgentOsOutcomeReceiptPayloadV1(unsignedReceipt), receipt['signature'], outcomeKey)) {
        return fail('outcome-signature-invalid');
      }
      const inputBytes = canonicalBytes(receipt['input']);
      if (!inputBytes) return fail('outcome-binding-mismatch');
      authenticatedOutcomes.set(receiptDigest, {
        inputDigest: sha('ashlr:agent-os-outcome-verification-input:v1', inputBytes),
        independent: true,
      });
      outcomePrincipals.add(outcomeKey.principalDigest);
      outcomePublicKeys.add(outcomeKey.publicKeySpki);
      priorOutcome = receiptDigest;
    }
    if (authenticatedOutcomes.size !== expectedOutcomes.size) return fail('outcome-binding-mismatch');

    const verifier = closedVerifier(tuple, authenticatedOutcomes);
    if (!buildAgentOsReadModelV1(readModelInput, verifier).ok) return fail('read-model-invalid');
    return {
      ok: true,
      bundleDigest: expectedBundleDigest,
      readModelInput,
      verifier,
      issues: [],
    };
  } catch {
    return fail('invalid-input');
  }
}
