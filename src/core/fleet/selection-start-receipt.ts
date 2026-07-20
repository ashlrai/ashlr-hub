/**
 * Immutable selection-start receipt envelope.
 *
 * This is a pure signing/verification contract. It deliberately does not write
 * files or invoke engines; the future durable producer must write, fsync, and
 * re-read this exact envelope after shared execution authority is acquired.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EngineId, EngineTier } from '../types.js';
import type { DispatchSelectionObservationV1 } from './dispatch-production-ledger.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_ID_DOMAIN = 'ashlr:selection-start-receipt-id:v1\0';
const RECEIPT_SIGNATURE_DOMAIN = 'ashlr:selection-start-receipt-signature:v1\0';
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

export interface SelectionStartReceiptRoot {
  runId: string;
  trajectoryId: string;
  objectiveHash: string;
}

export interface SelectionStartReceiptClaim {
  queueId: string;
  claimEpoch: number;
  claimBindingDigest: string;
}

export interface SelectionStartReceiptV1 {
  schemaVersion: 1;
  authority: 'observation-only';
  receiptId: string;
  ts: string;
  root: SelectionStartReceiptRoot;
  claim: SelectionStartReceiptClaim;
  selectionObservation: DispatchSelectionObservationV1;
  signature: string;
}

export interface CreateSelectionStartReceiptInput {
  root: SelectionStartReceiptRoot;
  claim: SelectionStartReceiptClaim;
  selectionObservation: DispatchSelectionObservationV1;
  ts: string;
}

function fixedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === keys.length &&
    keys.every((key) => Object.hasOwn(value as Record<string, unknown>, key));
}

function validKey(key: Buffer): boolean {
  return Buffer.isBuffer(key) && key.length === 32;
}

function validRoot(root: unknown): root is SelectionStartReceiptRoot {
  return fixedObject(root, ['runId', 'trajectoryId', 'objectiveHash']) &&
    typeof root.runId === 'string' && isSafeExecutionIdentity(root.runId) &&
    root.trajectoryId === `run:${root.runId}` && typeof root.objectiveHash === 'string' &&
    SHA256_RE.test(root.objectiveHash);
}

function validClaim(claim: unknown): claim is SelectionStartReceiptClaim {
  if (!fixedObject(claim, ['queueId', 'claimEpoch', 'claimBindingDigest'])) return false;
  const queueId = claim.queueId;
  const claimEpoch = claim.claimEpoch;
  const claimBindingDigest = claim.claimBindingDigest;
  return typeof queueId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(queueId) &&
    typeof claimEpoch === 'number' && Number.isSafeInteger(claimEpoch) && claimEpoch > 0 &&
    typeof claimBindingDigest === 'string' && SHA256_RE.test(claimBindingDigest);
}

function validObservation(value: unknown): value is DispatchSelectionObservationV1 {
  const allowed = [
    'schemaVersion', 'authority', 'mode', 'selectionPolicyVersion', 'randomizationProtocolVersion',
    'candidateSetDigest', 'assignmentDigest', 'candidateCount', 'selectedRank',
    'selectionProbabilityPpm', 'selectedBackend', 'selectedTier', 'selectedModel',
  ];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  const keys = Object.keys(observation);
  if (!keys.every((key) => allowed.includes(key)) ||
    !allowed.filter((key) => key !== 'selectedModel').every((key) => Object.hasOwn(observation, key))) return false;
  const candidateCount = observation.candidateCount;
  const selectedRank = observation.selectedRank;
  const selectionProbabilityPpm = observation.selectionProbabilityPpm;
  return observation.schemaVersion === 1 && observation.authority === 'observation-only' &&
    observation.mode === 'randomized-canary' &&
    typeof observation.selectionPolicyVersion === 'string' && observation.selectionPolicyVersion.length > 0 && observation.selectionPolicyVersion.length <= 80 &&
    typeof observation.randomizationProtocolVersion === 'string' && observation.randomizationProtocolVersion.length > 0 && observation.randomizationProtocolVersion.length <= 80 &&
    typeof observation.candidateSetDigest === 'string' && SHA256_RE.test(observation.candidateSetDigest) &&
    typeof observation.assignmentDigest === 'string' && SHA256_RE.test(observation.assignmentDigest) &&
    typeof candidateCount === 'number' && Number.isSafeInteger(candidateCount) && candidateCount >= 1 && candidateCount <= 64 &&
    typeof selectedRank === 'number' && Number.isSafeInteger(selectedRank) && selectedRank >= 0 && selectedRank < candidateCount &&
    typeof selectionProbabilityPpm === 'number' && Number.isSafeInteger(selectionProbabilityPpm) && selectionProbabilityPpm >= 1 && selectionProbabilityPpm <= 1_000_000 &&
    typeof observation.selectedBackend === 'string' && observation.selectedBackend !== 'builtin' && ENGINE_IDS.has(observation.selectedBackend as EngineId) &&
    typeof observation.selectedTier === 'string' && ENGINE_TIERS.has(observation.selectedTier as EngineTier) &&
    (observation.selectedModel === undefined || observation.selectedModel === null ||
      (typeof observation.selectedModel === 'string' && observation.selectedModel.length <= 160));
}

function receiptId(key: Buffer, root: SelectionStartReceiptRoot, claim: SelectionStartReceiptClaim): string {
  return createHmac('sha256', key).update(JSON.stringify([
    RECEIPT_ID_DOMAIN, root.runId, root.trajectoryId, root.objectiveHash,
    claim.queueId, claim.claimEpoch, claim.claimBindingDigest,
  ]), 'utf8').digest('hex');
}

function signaturePayload(receipt: Omit<SelectionStartReceiptV1, 'signature'>): string {
  return JSON.stringify([
    RECEIPT_SIGNATURE_DOMAIN,
    receipt.schemaVersion,
    receipt.authority,
    receipt.receiptId,
    receipt.ts,
    receipt.root,
    receipt.claim,
    receipt.selectionObservation,
  ]);
}

function equalDigest(left: string, right: string): boolean {
  return SHA256_RE.test(left) && SHA256_RE.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Create a signed in-memory receipt envelope; callers must durably install it separately. */
export function createSelectionStartReceipt(
  input: CreateSelectionStartReceiptInput,
  key: Buffer,
): SelectionStartReceiptV1 | null {
  if (!validKey(key) || !validRoot(input.root) || !validClaim(input.claim) ||
    !validObservation(input.selectionObservation) || typeof input.ts !== 'string' ||
    !Number.isFinite(Date.parse(input.ts))) return null;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'observation-only' as const,
    receiptId: receiptId(key, input.root, input.claim),
    ts: input.ts,
    root: { ...input.root },
    claim: { ...input.claim },
    selectionObservation: { ...input.selectionObservation },
  };
  return {
    ...unsigned,
    signature: createHmac('sha256', key).update(signaturePayload(unsigned), 'utf8').digest('hex'),
  };
}

/** Verify an untrusted persisted envelope without creating or repairing a key. */
export function verifySelectionStartReceipt(value: unknown, key: Buffer): SelectionStartReceiptV1 | null {
  const keys = ['schemaVersion', 'authority', 'receiptId', 'ts', 'root', 'claim', 'selectionObservation', 'signature'];
  if (!validKey(key) || !fixedObject(value, keys)) return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== 1 || receipt.authority !== 'observation-only' ||
    typeof receipt.receiptId !== 'string' || !SHA256_RE.test(receipt.receiptId) ||
    typeof receipt.ts !== 'string' || !Number.isFinite(Date.parse(receipt.ts)) ||
    !validRoot(receipt.root) || !validClaim(receipt.claim) || !validObservation(receipt.selectionObservation) ||
    typeof receipt.signature !== 'string' || !SHA256_RE.test(receipt.signature)) return null;
  const unsigned = {
    schemaVersion: 1 as const,
    authority: 'observation-only' as const,
    receiptId: receipt.receiptId,
    ts: receipt.ts,
    root: receipt.root,
    claim: receipt.claim,
    selectionObservation: receipt.selectionObservation,
  };
  const expectedId = receiptId(key, receipt.root, receipt.claim);
  const expectedSignature = createHmac('sha256', key).update(signaturePayload(unsigned), 'utf8').digest('hex');
  if (!equalDigest(receipt.receiptId, expectedId) || !equalDigest(receipt.signature, expectedSignature)) return null;
  return { ...unsigned, signature: receipt.signature };
}
