/**
 * Immutable selection-start receipt envelope.
 *
 * This is a pure signing/verification contract. It deliberately does not write
 * files or invoke engines; the future durable producer must write, fsync, and
 * re-read this exact envelope after shared execution authority is acquired.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { EngineId, EngineTier } from '../types.js';
import type { DispatchSelectionObservationV1 } from './dispatch-production-ledger.js';
import {
  dispatchProductionDir,
  ensurePrivateDispatchProductionReceiptDirectory,
  inspectExactDispatchProductionReceiptFile,
  withStableDispatchProductionWriteRoot,
} from './dispatch-production-storage.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import { loadExistingProvenanceKey, loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const RECEIPT_ID_DOMAIN = 'ashlr:selection-start-receipt-id:v1\0';
const RECEIPT_SIGNATURE_DOMAIN = 'ashlr:selection-start-receipt-signature:v1\0';
const RECEIPT_V2_ID_DOMAIN = 'ashlr:selection-start-receipt-id:v2\0';
const RECEIPT_V2_SIGNATURE_DOMAIN = 'ashlr:selection-start-receipt-signature:v2\0';
const RECEIPT_V2_DIGEST_DOMAIN = 'ashlr:selection-start-receipt-digest:v2\0';
const ROOT_V2_DIGEST_DOMAIN = 'ashlr:selection-start-receipt-root-digest:v2\0';
const SELECTION_V2_DIGEST_DOMAIN = 'ashlr:selection-start-receipt-selection-digest:v2\0';
const RECEIPT_DIRECTORY = 'selection-start-receipts';
const MAX_RECEIPT_BYTES = 16 * 1024;
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

/**
 * Coordinator-only receipt envelope. This remains an in-memory pure contract:
 * installing and joining it to durable coordinator state is intentionally owned
 * by the future shared-queue integration.
 */
export interface SelectionStartReceiptV2 {
  schemaVersion: 2;
  authority: 'coordinator-minted-v2';
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

export interface CreateCoordinatorSelectionStartReceiptV2Input {
  root: SelectionStartReceiptRoot;
  claim: SelectionStartReceiptClaim;
  selectionObservation: DispatchSelectionObservationV1;
  ts: string;
}

export type SelectionStartReceiptReadResult =
  | { status: 'found'; receipt: SelectionStartReceiptV1 }
  | { status: 'missing' | 'degraded'; reason: string };

export type SelectionStartReceiptWriteResult =
  | { status: 'recorded' | 'replayed'; receipt: SelectionStartReceiptV1 }
  | { status: 'conflicted' | 'unavailable' | 'degraded'; reason: string };

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
    observation.randomizationProtocolVersion === 'binary-uniform-v1' &&
    typeof observation.candidateSetDigest === 'string' && SHA256_RE.test(observation.candidateSetDigest) &&
    typeof observation.assignmentDigest === 'string' && SHA256_RE.test(observation.assignmentDigest) &&
    candidateCount === 2 &&
    typeof selectedRank === 'number' && Number.isSafeInteger(selectedRank) && selectedRank >= 0 && selectedRank < candidateCount &&
    selectionProbabilityPpm === 500_000 &&
    typeof observation.selectedBackend === 'string' && observation.selectedBackend !== 'builtin' && ENGINE_IDS.has(observation.selectedBackend as EngineId) &&
    typeof observation.selectedTier === 'string' && ENGINE_TIERS.has(observation.selectedTier as EngineTier) &&
    (observation.selectedModel === undefined || observation.selectedModel === null ||
      (typeof observation.selectedModel === 'string' && observation.selectedModel.length <= 160));
}

function canonicalRootV2(root: SelectionStartReceiptRoot): readonly [string, string, string] {
  return [root.runId, root.trajectoryId, root.objectiveHash];
}

function canonicalClaimV2(claim: SelectionStartReceiptClaim): readonly [string, number, string] {
  return [claim.queueId, claim.claimEpoch, claim.claimBindingDigest];
}

function canonicalSelectionV2(observation: DispatchSelectionObservationV1): readonly unknown[] {
  return [
    observation.schemaVersion,
    observation.authority,
    observation.mode,
    observation.selectionPolicyVersion,
    observation.randomizationProtocolVersion,
    observation.candidateSetDigest,
    observation.assignmentDigest,
    observation.candidateCount,
    observation.selectedRank,
    observation.selectionProbabilityPpm,
    observation.selectedBackend,
    observation.selectedTier,
    observation.selectedModel ?? null,
  ];
}

function sha256Digest(domain: string, payload: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([domain, ...payload]), 'utf8').digest('hex');
}

/** Return the deterministic public root digest used by durable V2 coordinator bindings. */
export function rootDigestV2(root: unknown): string | null {
  return validRoot(root) ? sha256Digest(ROOT_V2_DIGEST_DOMAIN, canonicalRootV2(root)) : null;
}

/** Return the deterministic public selection digest used by durable V2 coordinator bindings. */
export function selectionDigestV2(observation: unknown): string | null {
  return validObservation(observation) ? sha256Digest(SELECTION_V2_DIGEST_DOMAIN, canonicalSelectionV2(observation)) : null;
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

function receiptIdV2(key: Buffer, root: SelectionStartReceiptRoot, claim: SelectionStartReceiptClaim): string {
  return createHmac('sha256', key).update(JSON.stringify([
    RECEIPT_V2_ID_DOMAIN, ...canonicalRootV2(root), ...canonicalClaimV2(claim),
  ]), 'utf8').digest('hex');
}

function signaturePayloadV2(receipt: Omit<SelectionStartReceiptV2, 'signature'>): string {
  return JSON.stringify([
    RECEIPT_V2_SIGNATURE_DOMAIN,
    receipt.schemaVersion,
    receipt.authority,
    receipt.receiptId,
    receipt.ts,
    canonicalRootV2(receipt.root),
    canonicalClaimV2(receipt.claim),
    canonicalSelectionV2(receipt.selectionObservation),
  ]);
}

/** Return the deterministic full-envelope digest used by durable V2 coordinator bindings. */
export function receiptDigestV2(receipt: unknown): string | null {
  const verified = validSelectionStartReceiptV2(receipt);
  return verified ? sha256Digest(RECEIPT_V2_DIGEST_DOMAIN, [
    verified.receiptId,
    verified.ts,
    canonicalRootV2(verified.root),
    canonicalClaimV2(verified.claim),
    canonicalSelectionV2(verified.selectionObservation),
    verified.signature,
  ]) : null;
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

function validSelectionStartReceiptV2(value: unknown): SelectionStartReceiptV2 | null {
  const keys = ['schemaVersion', 'authority', 'receiptId', 'ts', 'root', 'claim', 'selectionObservation', 'signature'];
  if (!fixedObject(value, keys)) return null;
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== 2 || receipt.authority !== 'coordinator-minted-v2' ||
    typeof receipt.receiptId !== 'string' || !SHA256_RE.test(receipt.receiptId) ||
    typeof receipt.ts !== 'string' || !Number.isFinite(Date.parse(receipt.ts)) ||
    !validRoot(receipt.root) || !validClaim(receipt.claim) || !validObservation(receipt.selectionObservation) ||
    typeof receipt.signature !== 'string' || !SHA256_RE.test(receipt.signature)) return null;
  return {
    schemaVersion: 2,
    authority: 'coordinator-minted-v2',
    receiptId: receipt.receiptId,
    ts: receipt.ts,
    root: { ...receipt.root },
    claim: { ...receipt.claim },
    selectionObservation: { ...receipt.selectionObservation },
    signature: receipt.signature,
  };
}

/** Create a signed V2 envelope. Durable installation is deliberately not part of this pure API. */
export function createCoordinatorSelectionStartReceiptV2(
  input: CreateCoordinatorSelectionStartReceiptV2Input,
  key: Buffer,
): SelectionStartReceiptV2 | null {
  if (!validKey(key) || !validRoot(input.root) || !validClaim(input.claim) ||
    !validObservation(input.selectionObservation) || typeof input.ts !== 'string' ||
    !Number.isFinite(Date.parse(input.ts))) return null;
  const unsigned = {
    schemaVersion: 2 as const,
    authority: 'coordinator-minted-v2' as const,
    receiptId: receiptIdV2(key, input.root, input.claim),
    ts: input.ts,
    root: { ...input.root },
    claim: { ...input.claim },
    selectionObservation: { ...input.selectionObservation },
  };
  return {
    ...unsigned,
    signature: createHmac('sha256', key).update(signaturePayloadV2(unsigned), 'utf8').digest('hex'),
  };
}

/** Verify a V2 coordinator envelope without durable-binding or daemon-side effects. */
export function verifyCoordinatorSelectionStartReceiptV2(
  value: unknown,
  key: Buffer,
): SelectionStartReceiptV2 | null {
  if (!validKey(key)) return null;
  const receipt = validSelectionStartReceiptV2(value);
  if (!receipt) return null;
  const { signature, ...unsigned } = receipt;
  const expectedId = receiptIdV2(key, receipt.root, receipt.claim);
  const expectedSignature = createHmac('sha256', key).update(signaturePayloadV2(unsigned), 'utf8').digest('hex');
  if (!equalDigest(receipt.receiptId, expectedId) || !equalDigest(signature, expectedSignature)) return null;
  return receipt;
}

export function selectionStartReceiptDir(): string {
  return join(dispatchProductionDir(), RECEIPT_DIRECTORY);
}

function receiptPath(receiptId: string): string | null {
  return SHA256_RE.test(receiptId) ? join(selectionStartReceiptDir(), `${receiptId}.json`) : null;
}

function sameReplay(left: SelectionStartReceiptV1, right: SelectionStartReceiptV1): boolean {
  return left.receiptId === right.receiptId &&
    JSON.stringify(left.root) === JSON.stringify(right.root) &&
    JSON.stringify(left.claim) === JSON.stringify(right.claim) &&
    JSON.stringify(left.selectionObservation) === JSON.stringify(right.selectionObservation);
}

/** Read one installed receipt without creating directories or repairing key state. */
export function readSelectionStartReceipt(receiptId: string): SelectionStartReceiptReadResult {
  const path = receiptPath(receiptId);
  if (!path) return { status: 'degraded', reason: 'invalid-receipt-id' };
  const key = loadExistingProvenanceKeyReadOnly();
  if (!key) return { status: 'degraded', reason: 'provenance-unavailable' };
  if (!existsSync(path)) return { status: 'missing', reason: 'absent' };
  try {
    inspectExactDispatchProductionReceiptFile(path);
    const read = readStableRegularFile(path, {
      anchorPath: dispatchProductionDir(),
      maxFileBytes: MAX_RECEIPT_BYTES,
      remainingBytes: MAX_RECEIPT_BYTES,
    });
    if (!read.ok) return { status: 'degraded', reason: `unsafe-receipt-${read.reason}` };
    const receipt = verifySelectionStartReceipt(JSON.parse(read.text), key);
    return receipt ? { status: 'found', receipt } : { status: 'degraded', reason: 'invalid-receipt' };
  } catch {
    return { status: 'degraded', reason: 'receipt-read-failed' };
  }
}

function safeCreatedTemp(fd: number, path: string): boolean {
  const opened = fstatSync(fd, { bigint: true });
  const named = lstatSync(path, { bigint: true });
  return opened.isFile() && named.isFile() && !named.isSymbolicLink() &&
    opened.dev === named.dev && opened.ino === named.ino && opened.nlink === 1n && named.nlink === 1n &&
    (process.platform === 'win32' || (opened.mode & 0o022n) === 0n);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error('receipt write made no progress');
    offset += written;
  }
}

/**
 * Durably install an immutable receipt using link-based no-clobber publication.
 * This is not called by the daemon yet; a future producer must invoke it after
 * shared execution authority and before any engine side effect.
 */
export function writeSelectionStartReceipt(input: CreateSelectionStartReceiptInput): SelectionStartReceiptWriteResult {
  const key = loadExistingProvenanceKey();
  if (!key) return { status: 'unavailable', reason: 'provenance-unavailable' };
  const receipt = createSelectionStartReceipt(input, key);
  if (!receipt) return { status: 'unavailable', reason: 'invalid-receipt-input' };
  const existing = readSelectionStartReceipt(receipt.receiptId);
  if (existing.status === 'found') return sameReplay(existing.receipt, receipt)
    ? { status: 'replayed', receipt: existing.receipt }
    : { status: 'conflicted', reason: 'receipt-id-conflict' };
  if (existing.status === 'degraded' && existing.reason !== 'absent') {
    return { status: 'degraded', reason: existing.reason };
  }

  let temp: string | undefined;
  let fd: number | undefined;
  try {
    return withStableDispatchProductionWriteRoot(() => {
      const directory = selectionStartReceiptDir();
      ensurePrivateDispatchProductionReceiptDirectory(directory);
      const target = receiptPath(receipt.receiptId)!;
      const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
      if (bytes.length > MAX_RECEIPT_BYTES) return { status: 'unavailable', reason: 'receipt-too-large' };
      temp = join(directory, `.${receipt.receiptId}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`);
      const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
      fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
      if (!safeCreatedTemp(fd, temp)) throw new Error('unsafe receipt temporary file');
      writeAll(fd, bytes);
      chmodSync(temp, 0o600);
      fsyncSync(fd);
      if (!safeCreatedTemp(fd, temp)) throw new Error('receipt temporary changed');
      closeSync(fd);
      fd = undefined;
      try {
        linkSync(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = readSelectionStartReceipt(receipt.receiptId);
        return winner.status === 'found'
          ? sameReplay(winner.receipt, receipt)
            ? { status: 'replayed', receipt: winner.receipt }
            : { status: 'conflicted', reason: 'receipt-id-conflict' }
          : { status: 'degraded', reason: 'receipt-install-contended' };
      }
      unlinkSync(temp);
      temp = undefined;
      fsyncDirectory(directory);
      const installed = readSelectionStartReceipt(receipt.receiptId);
      return installed.status === 'found' && sameReplay(installed.receipt, receipt)
        ? { status: 'recorded', receipt: installed.receipt }
        : { status: 'degraded', reason: 'receipt-final-read-failed' };
    });
  } catch {
    return { status: 'degraded', reason: 'receipt-write-failed' };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* preserve write failure */ } }
    if (temp !== undefined) { try { unlinkSync(temp); } catch { /* exact temp cleanup is best effort */ } }
  }
}
