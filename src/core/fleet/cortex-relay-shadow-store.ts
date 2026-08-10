import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec,
  type ImmutablePrivateRecordStoreConfig,
} from '../util/immutable-private-record-store.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import {
  _validateCortexRelayShadowForTest,
  _prepareCortexRelayShadowClaimForTest,
  CORTEX_RELAY_SHADOW_TEST_CONTROL,
  observeCortexRelayShadowAfterClaim,
  prepareCortexRelayShadowClaim,
  type CortexRelayShadowDependencies,
  type CortexRelayShadowInput,
  type CortexRelayShadowMetadata,
  type CortexRelayShadowResult,
} from './cortex-relay-shadow.js';

const RECEIPT_PROTOCOL = 'ashlr-cortex-relay-shadow-receipt/v1' as const;
const RECEIPT_DIGEST_DOMAIN = 'ashlr:cortex-relay-shadow:receipt:v1';
const RECEIPT_SIGNATURE_DOMAIN = 'ashlr:cortex-relay-shadow:receipt-signature:v1';
const RECEIPT_KEY_DOMAIN = 'ashlr:cortex-relay-shadow:receipt-key:v1';
const SHA256_RE = /^[0-9a-f]{64}$/;
const SHA256_TAGGED_RE = /^sha256:[0-9a-f]{64}$/;
const HMAC_RE = /^hmac-sha256:[0-9a-f]{64}$/;

export type CortexRelayShadowRecordState = 'recorded' | 'duplicate' | 'conflict' | 'unavailable';

export interface CortexRelayShadowReceiptV1 {
  schemaVersion: 1;
  protocol: typeof RECEIPT_PROTOCOL;
  recordId: string;
  metadata: CortexRelayShadowMetadata;
  receiptDigest: string;
  signingKeyId: string;
  signatureAlgorithm: 'hmac-sha256';
  signature: string;
}

export interface CortexRelayShadowRecordResult {
  state: CortexRelayShadowRecordState;
  metadata: CortexRelayShadowMetadata;
  receipt?: CortexRelayShadowReceiptV1;
}

function anchorPath(override?: string): string {
  const root = override ?? process.env.ASHLR_HOME ?? join(homedir(), '.ashlr');
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error('unsafe ASHLR_HOME');
  return root;
}

function safeDirectory(path: string, exact = false): boolean {
  const stat = lstatSync(path);
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (process.platform === 'win32' ||
      ((typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
        (exact ? (stat.mode & 0o777) === 0o700 : (stat.mode & 0o022) === 0)));
}

function createOrPinPrivateChild(parent: string, name: string): string | null {
  const path = join(parent, name);
  let created = false;
  try {
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (!safeDirectory(parent) || !safeDirectory(path, true) ||
      realpathSync(path) !== join(realpathSync(parent), name) ||
      !assurePrivateStoragePath(path, 'directory', created ? 'secure-created' : 'inspect-existing', {
        anchorPath: parent,
      }).ok) return null;
    if (created) fsyncDirectory(parent);
    return path;
  } catch {
    return null;
  }
}

function recordIdentity(metadata: CortexRelayShadowMetadata): string {
  return metadata.assignmentId ?? metadata.inputDigest;
}

function recordId(metadata: CortexRelayShadowMetadata): string {
  return createHash('sha256')
    .update(`${RECEIPT_KEY_DOMAIN}\0${recordIdentity(metadata)}`, 'utf8').digest('hex');
}

function signingKey(provenanceKey: Buffer): Buffer {
  return createHmac('sha256', provenanceKey).update(RECEIPT_KEY_DOMAIN, 'utf8').digest();
}

function signingKeyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}

function receiptBase(
  metadata: CortexRelayShadowMetadata,
  id: string,
  keyId: string,
): Omit<CortexRelayShadowReceiptV1, 'receiptDigest' | 'signature'> {
  return {
    schemaVersion: 1,
    protocol: RECEIPT_PROTOCOL,
    recordId: id,
    metadata,
    signingKeyId: keyId,
    signatureAlgorithm: 'hmac-sha256',
  };
}

function digestOf(base: Omit<CortexRelayShadowReceiptV1, 'receiptDigest' | 'signature'>): string {
  return `sha256:${createHash('sha256')
    .update(`${RECEIPT_DIGEST_DOMAIN}\0${JSON.stringify(base)}`, 'utf8').digest('hex')}`;
}

function signatureOf(digest: string, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update(`${RECEIPT_SIGNATURE_DOMAIN}\0${digest}`, 'utf8').digest('hex')}`;
}

function createReceipt(
  metadata: CortexRelayShadowMetadata,
  provenanceKey: Buffer,
): CortexRelayShadowReceiptV1 | null {
  if (provenanceKey.length !== 32 || !validMetadata(metadata)) return null;
  const key = signingKey(provenanceKey);
  const base = receiptBase(metadata, recordId(metadata), signingKeyId(key));
  const receiptDigest = digestOf(base);
  return Object.freeze({ ...base, receiptDigest, signature: signatureOf(receiptDigest, key) });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validMetadata(metadata: CortexRelayShadowMetadata): boolean {
  try {
    const { outcomeDigest, ...base } = metadata;
    return metadata.schemaVersion === 1 &&
      metadata.protocol === 'ashlr-cortex-relay-shadow-outcome/v1' &&
      metadata.mode === 'shadow' && metadata.evidenceClass === 'observation-only' &&
      metadata.consumable === false && metadata.authorityGranted === false &&
      metadata.executionAuthority === false && metadata.proposalAuthority === false &&
      metadata.mergeAuthority === false && metadata.deployAuthority === false &&
      metadata.accepted === false && typeof metadata.reason === 'string' &&
      typeof metadata.observedAt === 'string' && Number.isFinite(Date.parse(metadata.observedAt)) &&
      SHA256_TAGGED_RE.test(metadata.inputDigest) &&
      outcomeDigest === `sha256:${createHash('sha256')
        .update(`ashlr:cortex-relay-shadow:outcome:v1\0${JSON.stringify(base)}`, 'utf8').digest('hex')}` &&
      metadata.effects?.agentsSpawned === 0 && metadata.effects.proposalsCreated === 0 &&
      metadata.effects.repositoriesMutated === 0 && metadata.effects.merges === 0 &&
      metadata.effects.deployments === 0;
  } catch {
    return false;
  }
}

function parseReceipt(value: unknown, provenanceKey: Buffer): CortexRelayShadowReceiptV1 | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!exactKeys(row, [
      'schemaVersion', 'protocol', 'recordId', 'metadata', 'receiptDigest',
      'signingKeyId', 'signatureAlgorithm', 'signature',
    ]) || row.schemaVersion !== 1 || row.protocol !== RECEIPT_PROTOCOL ||
      typeof row.recordId !== 'string' || !SHA256_RE.test(row.recordId) ||
      typeof row.signingKeyId !== 'string' || !SHA256_RE.test(row.signingKeyId) ||
      row.signatureAlgorithm !== 'hmac-sha256' || typeof row.receiptDigest !== 'string' ||
      !SHA256_TAGGED_RE.test(row.receiptDigest) || typeof row.signature !== 'string' ||
      !HMAC_RE.test(row.signature) || !validMetadata(row.metadata as CortexRelayShadowMetadata)) return null;
    const metadata = row.metadata as CortexRelayShadowMetadata;
    const key = signingKey(provenanceKey);
    const base = receiptBase(metadata, row.recordId, row.signingKeyId);
    const expectedDigest = digestOf(base);
    const expectedSignature = signatureOf(expectedDigest, key);
    const actual = Buffer.from(row.signature.slice('hmac-sha256:'.length), 'hex');
    const expected = Buffer.from(expectedSignature.slice('hmac-sha256:'.length), 'hex');
    if (row.recordId !== recordId(metadata) || row.signingKeyId !== signingKeyId(key) ||
      row.receiptDigest !== expectedDigest || actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)) return null;
    return value as CortexRelayShadowReceiptV1;
  } catch {
    return null;
  }
}

function codec(key: Buffer): ImmutablePrivateRecordCodec<CortexRelayShadowReceiptV1> {
  return {
    parse: (value) => parseReceipt(value, key),
    serialize: (receipt) => `${JSON.stringify(receipt)}\n`,
    recordId: (receipt) => receipt.recordId,
    recordFileName: (receipt) => `${receipt.recordId}.json`,
    isRecordFileName: (name) => /^[0-9a-f]{64}\.json$/.test(name),
    stageToken: (receipt) => createHmac('sha256', signingKey(key))
      .update(`${RECEIPT_SIGNATURE_DOMAIN}\0stage\0${receipt.receiptDigest}`, 'utf8').digest('hex'),
    equivalent: (left, right) => JSON.stringify(left) === JSON.stringify(right),
  };
}

function storeConfig(
  fleet: string,
  key: Buffer,
): ImmutablePrivateRecordStoreConfig<CortexRelayShadowReceiptV1> {
  return {
    label: 'Cortex relay shadow receipts',
    anchorPath: fleet,
    rootPath: join(fleet, 'cortex-relay-shadow'),
    lockFileName: '.cortex-relay-shadow.lock',
    maxRecordBytes: 64 * 1024,
    defaultMaxFiles: 10_000,
    hardMaxFiles: 100_000,
    defaultMaxBytes: 64 * 1024 * 1024,
    hardMaxBytes: 512 * 1024 * 1024,
    codecForWrite: () => codec(key),
    codecForRead: () => codec(key),
  };
}

function recordWithKey(
  metadata: CortexRelayShadowMetadata,
  root: string | undefined,
  key: Buffer | null,
): CortexRelayShadowRecordResult {
  if (!key || key.length !== 32 || !metadata.assignmentId ||
      metadata.assignmentId !== metadata.runId || !metadata.assignmentDigest ||
      !SHA256_TAGGED_RE.test(metadata.assignmentDigest)) {
    return { state: 'unavailable', metadata };
  }
  try {
    const anchor = anchorPath(root);
    if (!safeDirectory(anchor)) return { state: 'unavailable', metadata };
    const fleet = createOrPinPrivateChild(anchor, 'fleet');
    if (!fleet) return { state: 'unavailable', metadata };
    const receipt = createReceipt(metadata, key);
    if (!receipt) return { state: 'unavailable', metadata };
    const result = writeImmutablePrivateRecord(storeConfig(fleet, key), receipt);
    if (result === 'recorded') return { state: 'recorded', metadata, receipt };
    if (result === 'replayed') return { state: 'duplicate', metadata, receipt };
    if (result === 'conflicted') return { state: 'conflict', metadata };
    return { state: 'unavailable', metadata };
  } catch {
    return { state: 'unavailable', metadata };
  }
}

/** Durable authenticated claim. Missing existing provenance authority fails closed. */
function recordCortexRelayShadowOutcome(
  metadata: CortexRelayShadowMetadata,
  options: { root?: string } = {},
): CortexRelayShadowRecordResult {
  return recordWithKey(metadata, options.root, loadExistingProvenanceKeyReadOnly());
}

export interface ConsumeCortexRelayShadowResult {
  validation: CortexRelayShadowResult;
  receipt: CortexRelayShadowRecordResult;
  effectEligible: false;
}

/** Shadow-only consumer: observe, durably claim, and stop. No effect callback exists. */
export function consumeCortexRelayShadow(
  input: CortexRelayShadowInput,
): ConsumeCortexRelayShadowResult {
  const claim = prepareCortexRelayShadowClaim(input);
  if (!claim.ok) {
    return {
      validation: { accepted: false, observed: false, metadata: claim.metadata },
      receipt: { state: 'unavailable', metadata: claim.metadata },
      effectEligible: false,
    };
  }
  const receipt = recordCortexRelayShadowOutcome(claim.metadata);
  if (receipt.state !== 'recorded') {
    return {
      validation: { accepted: false, observed: false, metadata: claim.metadata },
      receipt,
      effectEligible: false,
    };
  }
  return {
    validation: observeCortexRelayShadowAfterClaim(input),
    receipt,
    effectEligible: false,
  };
}

/** Vitest-only integrated seam for deterministic trust and durability attacks. */
export function _consumeCortexRelayShadowForTest(
  sentinel: symbol,
  input: CortexRelayShadowInput,
  options: {
    validation?: Partial<CortexRelayShadowDependencies>;
    root?: string;
    provenanceKey?: Buffer;
  } = {},
): ConsumeCortexRelayShadowResult {
  if (sentinel !== CORTEX_RELAY_SHADOW_TEST_CONTROL || process.env.VITEST !== 'true') {
    throw new Error('invalid Cortex relay shadow test control');
  }
  const dependencies = options.validation ?? {};
  const now = dependencies.now ?? (() => new Date());
  const loadPolicy = dependencies.loadPolicy ?? (() => null);
  const claim = _prepareCortexRelayShadowClaimForTest(
    sentinel,
    input,
    { now, loadPolicy },
  );
  if (!claim.ok) {
    return {
      validation: { accepted: false, observed: false, metadata: claim.metadata },
      receipt: { state: 'unavailable', metadata: claim.metadata },
      effectEligible: false,
    };
  }
  const receipt = recordWithKey(claim.metadata, options.root, options.provenanceKey ?? null);
  if (receipt.state !== 'recorded') {
    return {
      validation: { accepted: false, observed: false, metadata: claim.metadata },
      receipt,
      effectEligible: false,
    };
  }
  const validation = _validateCortexRelayShadowForTest(sentinel, input, dependencies);
  return {
    validation,
    receipt,
    effectEligible: false,
  };
}

export function _recordCortexRelayShadowOutcomeForTest(
  sentinel: symbol,
  metadata: CortexRelayShadowMetadata,
  options: { root: string; provenanceKey: Buffer },
): CortexRelayShadowRecordResult {
  if (sentinel !== CORTEX_RELAY_SHADOW_TEST_CONTROL || process.env.VITEST !== 'true') {
    throw new Error('invalid Cortex relay shadow test control');
  }
  return recordWithKey(metadata, options.root, options.provenanceKey);
}
