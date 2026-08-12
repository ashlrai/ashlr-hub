/**
 * Signed lifecycle-stable proposal effect policy.
 *
 * This module only classifies and authenticates authority. V1 intentionally
 * grants no outward effect: every effectful proposal is `human-only` and must
 * wait for a future, separately authenticated human capability.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Proposal, ProposalEffectPolicyV1, ProposalKind } from '../types.js';
import {
  loadExistingProvenanceKeyReadOnly,
  loadOrCreateKey,
} from '../foundry/provenance.js';

export type ProposalEffectClass = 'none' | 'outward-effect';

export type ProposalEffectPolicyCode =
  | 'policy-not-required'
  | 'policy-missing'
  | 'policy-unsupported'
  | 'policy-invalid'
  | 'policy-human-only'
  | 'effect-class-mismatch';

export interface ProposalEffectPolicyEvaluation {
  allowed: boolean;
  effectClass: ProposalEffectClass;
  code: ProposalEffectPolicyCode;
}

const POLICY_DOMAIN = 'ashlr.proposal-effect-policy.v1';
const POLICY_KEY_DOMAIN = 'ashlr.proposal-effect-policy.signing-key.v1';
const POLICY_KEY_ID_DOMAIN = 'ashlr.proposal-effect-policy.signing-key-id.v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ORIGINS = new Set(['backlog', 'swarm', 'manual', 'agent']);
const KINDS = new Set<ProposalKind>([
  'patch',
  'pr',
  'deploy',
  'note',
  'desktop-action',
  'browser-action',
]);
const POLICY_KEYS = [
  'schemaVersion',
  'reviewPolicy',
  'effectClass',
  'proposalId',
  'repo',
  'origin',
  'kind',
  'titleDigest',
  'summaryDigest',
  'diffDigest',
  'actionDigest',
  'workItemId',
  'workItemGenerationId',
  'runId',
  'trajectoryId',
  'createdAt',
  'algorithm',
  'keyId',
  'attestation',
] as const;

/** V1 is intentionally review-only until a separately authenticated capability lands. */
export const HUMAN_EFFECT_CAPABILITY_AVAILABLE = false;

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | {
  [key: string]: CanonicalValue;
};

const MAX_ACTION_DEPTH = 16;
const MAX_ACTION_NODES = 2_048;
const MAX_ACTION_KEYS = 2_048;
const MAX_ACTION_STRING_BYTES = 64 * 1024;
const MAX_ACTION_CANONICAL_BYTES = 256 * 1024;

interface CanonicalBudget {
  nodes: number;
  keys: number;
  stringBytes: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  budget: CanonicalBudget,
  depth = 0,
): CanonicalValue | undefined {
  if (depth > MAX_ACTION_DEPTH || ++budget.nodes > MAX_ACTION_NODES) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.stringBytes += Buffer.byteLength(value, 'utf8');
    return budget.stringBytes <= MAX_ACTION_STRING_BYTES ? value : undefined;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    const output: CanonicalValue[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        ancestors.delete(value);
        return undefined;
      }
      const encoded = canonicalize(descriptor.value, ancestors, budget, depth + 1);
      if (encoded === undefined) {
        ancestors.delete(value);
        return undefined;
      }
      output.push(encoded);
    }
    ancestors.delete(value);
    return output;
  }
  if (typeof value !== 'object') return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  const output = Object.create(null) as Record<string, CanonicalValue>;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  budget.keys += keys.length;
  if (budget.keys > MAX_ACTION_KEYS) {
    ancestors.delete(value);
    return undefined;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      ancestors.delete(value);
      return undefined;
    }
    const encoded = canonicalize(descriptor.value, ancestors, budget, depth + 1);
    if (encoded === undefined) {
      ancestors.delete(value);
      return undefined;
    }
    output[key] = encoded;
  }
  ancestors.delete(value);
  return output;
}

function actionDigest(action: unknown): string | null {
  if (action === undefined) return sha256(`${POLICY_DOMAIN}\naction-absent`);
  const canonical = canonicalize(action, new Set(), { nodes: 0, keys: 0, stringBytes: 0 });
  if (canonical === undefined) return null;
  const encoded = JSON.stringify(canonical);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ACTION_CANONICAL_BYTES) return null;
  return sha256(`${POLICY_DOMAIN}\naction\n${encoded}`);
}

export type MaterializedProposalAction =
  | { ok: true; action: Proposal['action'] | undefined }
  | { ok: false };

/**
 * Materialize the exact JSON-safe action bytes once at the trusted store
 * boundary. The same inert clone is then signed and persisted, so proxies,
 * accessors, toJSON hooks, and exotic prototypes cannot change between those
 * two operations.
 */
export function materializeProposalActionForPolicy(action: unknown): MaterializedProposalAction {
  if (action === undefined) return { ok: true, action: undefined };
  try {
    const canonical = canonicalize(action, new Set(), { nodes: 0, keys: 0, stringBytes: 0 });
    if (canonical === undefined || canonical === null || Array.isArray(canonical) ||
      typeof canonical !== 'object') return { ok: false };
    const encoded = JSON.stringify(canonical);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ACTION_CANONICAL_BYTES) return { ok: false };
    return { ok: true, action: JSON.parse(encoded) as Proposal['action'] };
  } catch {
    return { ok: false };
  }
}

/** V1's deliberately narrow no-effect classification. Ambiguity is outward. */
export function proposalHasOutwardEffect(proposal: Pick<Proposal, 'kind' | 'action'>): boolean {
  return proposal.kind !== 'note' || proposal.action !== undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === undefined ? null : typeof value === 'string' ? value : undefined;
}

function unsignedPolicyTuple(
  proposal: Proposal,
): Omit<ProposalEffectPolicyV1, 'keyId' | 'attestation'> | null {
  if (
    typeof proposal.id !== 'string' || proposal.id.length === 0 ||
    (proposal.repo !== null && typeof proposal.repo !== 'string') ||
    !ORIGINS.has(proposal.origin) || !KINDS.has(proposal.kind) ||
    typeof proposal.title !== 'string' || typeof proposal.summary !== 'string' ||
    (proposal.diff !== undefined && typeof proposal.diff !== 'string') ||
    typeof proposal.createdAt !== 'string' || proposal.createdAt.length === 0
  ) return null;
  const workItemId = nullableString(proposal.workItemId);
  const workItemGenerationId = nullableString(proposal.workItemGenerationId);
  const runId = nullableString(proposal.runId);
  const trajectoryId = nullableString(proposal.trajectoryId);
  const digest = actionDigest(proposal.action);
  if (
    workItemId === undefined || workItemGenerationId === undefined ||
    runId === undefined || trajectoryId === undefined || digest === null
  ) return null;
  return {
    schemaVersion: 1,
    reviewPolicy: 'human-only',
    effectClass: proposalHasOutwardEffect(proposal) ? 'outward-effect' : 'none',
    proposalId: proposal.id,
    repo: proposal.repo,
    origin: proposal.origin,
    kind: proposal.kind,
    titleDigest: sha256(proposal.title),
    summaryDigest: sha256(proposal.summary),
    diffDigest: proposal.diff === undefined ? null : sha256(proposal.diff),
    actionDigest: digest,
    workItemId,
    workItemGenerationId,
    runId,
    trajectoryId,
    createdAt: proposal.createdAt,
    algorithm: 'hmac-sha256',
  };
}

function derivedPolicyKey(provenanceKey: Buffer): Buffer {
  return createHmac('sha256', provenanceKey).update(POLICY_KEY_DOMAIN, 'utf8').digest();
}

function policyKeyId(key: Buffer): string {
  return createHash('sha256').update(POLICY_KEY_ID_DOMAIN, 'utf8').update(key).digest('hex');
}

function policyPayload(
  tuple: Omit<ProposalEffectPolicyV1, 'attestation'>,
): string {
  return `${POLICY_DOMAIN}\n${JSON.stringify(tuple)}`;
}

/** Mint only at the trusted store boundary. Never accepts caller policy data. */
export function mintProposalEffectPolicy(proposal: Proposal): ProposalEffectPolicyV1 | null {
  try {
    const tuple = unsignedPolicyTuple(proposal);
    if (!tuple) return null;
    const key = derivedPolicyKey(loadOrCreateKey());
    const withKey: Omit<ProposalEffectPolicyV1, 'attestation'> = {
      ...tuple,
      keyId: policyKeyId(key),
    };
    return {
      ...withKey,
      attestation: createHmac('sha256', key).update(policyPayload(withKey), 'utf8').digest('hex'),
    };
  } catch {
    return null;
  }
}

function materializeExactPolicy(value: unknown): ProposalEffectPolicyV1 | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== POLICY_KEYS.length ||
      keys.some((key) => typeof key !== 'string' || !POLICY_KEYS.includes(key as never))) {
      return null;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of POLICY_KEYS) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
      Object.defineProperty(output, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return output as unknown as ProposalEffectPolicyV1;
  } catch {
    return null;
  }
}

function safeHexEqual(left: string, right: string): boolean {
  if (!SHA256_HEX.test(left) || !SHA256_HEX.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Verify without creating, repairing, or otherwise mutating signing authority. */
function verifyMaterializedProposalEffectPolicy(
  proposal: Proposal,
  policy: ProposalEffectPolicyV1,
): boolean {
  try {
    const tuple = unsignedPolicyTuple(proposal);
    if (!tuple || policy.schemaVersion !== 1 || policy.reviewPolicy !== 'human-only' ||
      policy.algorithm !== 'hmac-sha256') return false;
    const keySource = loadExistingProvenanceKeyReadOnly();
    if (!keySource) return false;
    const key = derivedPolicyKey(keySource);
    const expectedKeyId = policyKeyId(key);
    if (!safeHexEqual(policy.keyId, expectedKeyId)) return false;
    const expectedWithoutAttestation: Omit<ProposalEffectPolicyV1, 'attestation'> = {
      ...tuple,
      keyId: expectedKeyId,
    };
    const expected = createHmac('sha256', key)
      .update(policyPayload(expectedWithoutAttestation), 'utf8')
      .digest('hex');
    return Object.entries(expectedWithoutAttestation).every(
        ([field, value]) => policy[field as keyof ProposalEffectPolicyV1] === value,
      ) && safeHexEqual(policy.attestation, expected);
  } catch {
    return false;
  }
}

export function verifyProposalEffectPolicy(proposal: Proposal): boolean {
  const policy = materializeExactPolicy(proposal.effectPolicy);
  return policy !== null && verifyMaterializedProposalEffectPolicy(proposal, policy);
}

/**
 * Evaluate an effect at either an early filter or a lock-held sink. `operation`
 * is intentionally non-authoritative context and cannot broaden the result.
 */
export function evaluateProposalEffectPolicy(
  proposal: Proposal,
  operation?: string,
): ProposalEffectPolicyEvaluation {
  const effectClass: ProposalEffectClass = proposalHasOutwardEffect(proposal)
    ? 'outward-effect'
    : 'none';
  const requiresHumanCapability = operation === 'status-transition' ||
    operation === 'authority-field-update';
  if (effectClass === 'none' && !requiresHumanCapability) {
    return { allowed: true, effectClass, code: 'policy-not-required' };
  }
  if (proposal.effectPolicy === undefined) {
    return { allowed: false, effectClass, code: 'policy-missing' };
  }
  const policy = materializeExactPolicy(proposal.effectPolicy);
  if (policy === null ||
    policy.schemaVersion !== 1 || policy.reviewPolicy !== 'human-only' ||
    policy.algorithm !== 'hmac-sha256') {
    return { allowed: false, effectClass, code: 'policy-unsupported' };
  }
  if (policy.effectClass !== effectClass) {
    return { allowed: false, effectClass, code: 'effect-class-mismatch' };
  }
  if (!verifyMaterializedProposalEffectPolicy(proposal, policy)) {
    return { allowed: false, effectClass, code: 'policy-invalid' };
  }
  return { allowed: false, effectClass, code: 'policy-human-only' };
}
