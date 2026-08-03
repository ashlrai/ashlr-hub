/**
 * Durable host-merge cancellation protocol foundation.
 *
 * This module authenticates and serializes metadata-only state transitions. It
 * intentionally has no GitHub client, merge consumer, or operational authority.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, opendirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadExistingProvenanceKeyReadOnly } from '../foundry/provenance.js';
import {
  acquireLocalStoreLockWithOutcome,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import { fsyncDirectory } from '../util/durability.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const PROTOCOL = 'ashlr.host-merge-revocation.v1' as const;
const SIGNATURE_ALGORITHM = 'hmac-sha256' as const;
const KEY_DOMAIN = 'ashlr.host-merge-revocation.key.v1';
const KEY_ID_DOMAIN = 'ashlr.host-merge-revocation.key-id.v1';
const RECEIPT_DIGEST_DOMAIN = 'ashlr.host-merge-revocation.receipt-digest.v1';
const RECEIPT_ATTESTATION_DOMAIN = 'ashlr.host-merge-revocation.receipt-attestation.v1';
const STATE_DIGEST_DOMAIN = 'ashlr.host-merge-revocation.state-digest.v1';
const STATE_ATTESTATION_DOMAIN = 'ashlr.host-merge-revocation.state-attestation.v1';
const AUTHORITY_ID_DOMAIN = 'ashlr.host-merge-revocation.authority-id.v1';
const REQUEST_DIGEST_DOMAIN = 'ashlr.host-merge-revocation.request-digest.v1';

const MAX_STATE_BYTES = 64 * 1024;
const MAX_STATE_FILES = 2_048;
const MAX_STORE_ENTRIES = 4_096;
const MAX_RECEIPTS = 3;
const MAX_TTL_MS = 15 * 60 * 1000;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const OID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\/\/)[A-Za-z0-9._/-]{1,240}$/;
const NODE_ID_RE = /^[A-Za-z0-9_+/=-]{1,240}$/;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

export type HostMergeRevocationPhaseV1 = 'prepared' | 'armed' | 'revoked' | 'consumed';
export type HostMergeRevocationActionV1 = 'prepare' | 'arm' | 'revoke' | 'consume';

export interface HostMergeRevocationIdentityV1 {
  nameWithOwner: string;
  repositoryId: string;
  baseRef: string;
  baseOid: string;
  headRef: string;
  headOid: string;
  pullRequestId: string;
  pullRequestNumber: number;
  evidencePackDigest: string;
  verifierManifestDigest: string;
  protectionPolicyDigest: string;
  killEpoch: string;
  policyEpoch: string;
  expiresAt: string;
}

export interface HostMergeRevocationReceiptV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authorityId: string;
  sequence: number;
  action: HostMergeRevocationActionV1;
  phase: HostMergeRevocationPhaseV1;
  operationId: string;
  requestDigest: string;
  previousReceiptDigest: string | null;
  recordedAt: string;
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  receiptDigest: string;
  attestation: string;
  operationalAuthority: false;
  hostAutoMergeEnabled: false;
}

export interface HostMergeRevocationStateV1 {
  schemaVersion: 1;
  protocol: typeof PROTOCOL;
  authorityId: string;
  identity: HostMergeRevocationIdentityV1;
  phase: HostMergeRevocationPhaseV1;
  sequence: number;
  receipts: HostMergeRevocationReceiptV1[];
  signingKeyId: string;
  signatureAlgorithm: typeof SIGNATURE_ALGORITHM;
  stateDigest: string;
  attestation: string;
  operationalAuthority: false;
  hostAutoMergeEnabled: false;
}

export type HostMergeRevocationReadResult =
  | {
      state: 'missing';
      authorityId: string;
      record: null;
      operationalAuthority: false;
      hostAutoMergeEnabled: false;
    }
  | {
      state: 'healthy';
      authorityId: string;
      record: HostMergeRevocationStateV1;
      operationalAuthority: false;
      hostAutoMergeEnabled: false;
    }
  | {
      state: 'degraded';
      authorityId: string | null;
      reason: string;
      record: null;
      operationalAuthority: false;
      hostAutoMergeEnabled: false;
    };

export type HostMergeRevocationWriteResult =
  | {
      status: 'applied' | 'replayed';
      authorityId: string;
      receipt: HostMergeRevocationReceiptV1;
      record: HostMergeRevocationStateV1;
      operationalAuthority: false;
      hostAutoMergeEnabled: false;
    }
  | {
      status: 'refused' | 'degraded';
      authorityId: string | null;
      reason: string;
      operationalAuthority: false;
      hostAutoMergeEnabled: false;
    };

export interface PrepareHostMergeRevocationInputV1 {
  identity: HostMergeRevocationIdentityV1;
  operationId: string;
  now?: Date;
}

export interface TransitionHostMergeRevocationInputV1 {
  identity: HostMergeRevocationIdentityV1;
  action: Exclude<HostMergeRevocationActionV1, 'prepare'>;
  operationId: string;
  expectedSequence: number;
  expectedReceiptDigest: string;
  now?: Date;
}

interface SigningKey {
  key: Buffer;
  id: string;
}

const AUTHORITY_FALSE = {
  operationalAuthority: false,
  hostAutoMergeEnabled: false,
} as const;

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeNow(value: Date | undefined): Date | null {
  const now = value ?? new Date();
  return Number.isFinite(now.getTime()) ? now : null;
}

function equalDigest(left: string, right: string): boolean {
  if (!DIGEST_RE.test(left) || !DIGEST_RE.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function hash(domain: string, payload: string): string {
  return createHash('sha256').update(domain, 'utf8').update('\n', 'utf8')
    .update(payload, 'utf8').digest('hex');
}

function hmac(key: Buffer, domain: string, payload: string): string {
  return createHmac('sha256', key).update(domain, 'utf8').update('\n', 'utf8')
    .update(payload, 'utf8').digest('hex');
}

function deriveSigningKey(): SigningKey | null {
  try {
    const provenance = loadExistingProvenanceKeyReadOnly();
    if (!provenance || provenance.length !== 32) return null;
    const key = createHmac('sha256', provenance).update(KEY_DOMAIN, 'utf8').update('\n').digest();
    const id = createHash('sha256').update(KEY_ID_DOMAIN, 'utf8').update('\n').update(key).digest('hex');
    return { key, id };
  } catch {
    return null;
  }
}

function validRef(value: unknown): value is string {
  return typeof value === 'string' && REF_RE.test(value) &&
    !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock') &&
    !value.includes('@{') && !value.includes('\\') &&
    value.split('/').every((component) => component !== '.' && component !== '..');
}

function sanitizeIdentity(value: unknown): HostMergeRevocationIdentityV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const exactKeys = [
    'baseOid', 'baseRef', 'evidencePackDigest', 'expiresAt', 'headOid', 'headRef',
    'killEpoch', 'nameWithOwner', 'policyEpoch', 'protectionPolicyDigest',
    'pullRequestId', 'pullRequestNumber', 'repositoryId', 'verifierManifestDigest',
  ];
  if (Object.keys(row).sort().join(',') !== exactKeys.sort().join(',') ||
    typeof row['nameWithOwner'] !== 'string' || !REPO_RE.test(row['nameWithOwner']) ||
    typeof row['repositoryId'] !== 'string' || !NODE_ID_RE.test(row['repositoryId']) ||
    !validRef(row['baseRef']) || typeof row['baseOid'] !== 'string' || !OID_RE.test(row['baseOid']) ||
    !validRef(row['headRef']) || typeof row['headOid'] !== 'string' || !OID_RE.test(row['headOid']) ||
    row['baseRef'] === row['headRef'] || row['baseOid'] === row['headOid'] ||
    typeof row['pullRequestId'] !== 'string' || !NODE_ID_RE.test(row['pullRequestId']) ||
    !Number.isSafeInteger(row['pullRequestNumber']) || Number(row['pullRequestNumber']) < 1 ||
    typeof row['evidencePackDigest'] !== 'string' || !DIGEST_RE.test(row['evidencePackDigest']) ||
    typeof row['verifierManifestDigest'] !== 'string' || !DIGEST_RE.test(row['verifierManifestDigest']) ||
    typeof row['protectionPolicyDigest'] !== 'string' || !DIGEST_RE.test(row['protectionPolicyDigest']) ||
    typeof row['killEpoch'] !== 'string' || !DIGEST_RE.test(row['killEpoch']) ||
    typeof row['policyEpoch'] !== 'string' || !DIGEST_RE.test(row['policyEpoch']) ||
    !canonicalTimestamp(row['expiresAt'])) return null;
  return {
    nameWithOwner: row['nameWithOwner'],
    repositoryId: row['repositoryId'],
    baseRef: row['baseRef'],
    baseOid: row['baseOid'],
    headRef: row['headRef'],
    headOid: row['headOid'],
    pullRequestId: row['pullRequestId'],
    pullRequestNumber: row['pullRequestNumber'] as number,
    evidencePackDigest: row['evidencePackDigest'],
    verifierManifestDigest: row['verifierManifestDigest'],
    protectionPolicyDigest: row['protectionPolicyDigest'],
    killEpoch: row['killEpoch'],
    policyEpoch: row['policyEpoch'],
    expiresAt: row['expiresAt'],
  };
}

function identityPayload(identity: HostMergeRevocationIdentityV1): string {
  return JSON.stringify({
    baseOid: identity.baseOid,
    baseRef: identity.baseRef,
    evidencePackDigest: identity.evidencePackDigest,
    expiresAt: identity.expiresAt,
    headOid: identity.headOid,
    headRef: identity.headRef,
    killEpoch: identity.killEpoch,
    nameWithOwner: identity.nameWithOwner,
    policyEpoch: identity.policyEpoch,
    protectionPolicyDigest: identity.protectionPolicyDigest,
    pullRequestId: identity.pullRequestId,
    pullRequestNumber: identity.pullRequestNumber,
    repositoryId: identity.repositoryId,
    verifierManifestDigest: identity.verifierManifestDigest,
  });
}

export function hostMergeRevocationAuthorityId(
  identity: HostMergeRevocationIdentityV1,
): string | null {
  const sanitized = sanitizeIdentity(identity);
  return sanitized ? hash(AUTHORITY_ID_DOMAIN, identityPayload(sanitized)) : null;
}

function storeRoot(): string | null {
  try {
    const home = homedir();
    if (!isAbsolute(home)) return null;
    return join(resolve(home), '.ashlr', 'host-merge-revocations');
  } catch {
    return null;
  }
}

export function hostMergeRevocationStatePath(
  identity: HostMergeRevocationIdentityV1,
): string | null {
  const root = storeRoot();
  const authorityId = hostMergeRevocationAuthorityId(identity);
  return root && authorityId ? join(root, `${authorityId}.json`) : null;
}

function privateDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path, { bigint: true });
    return !stat.isSymbolicLink() && stat.isDirectory() &&
      (typeof process.getuid !== 'function' || stat.uid === BigInt(process.getuid())) &&
      (process.platform === 'win32' || Number(stat.mode & 0o777n) === 0o700) &&
      assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath: homedir() }).ok;
  } catch {
    return false;
  }
}

function createDirectory(path: string): 'created' | 'existing' | null {
  try {
    let created = false;
    try {
      mkdirSync(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (created && !assurePrivateStoragePath(
      path, 'directory', 'secure-created', { anchorPath: homedir() },
    ).ok) return null;
    return privateDirectory(path) ? (created ? 'created' : 'existing') : null;
  } catch {
    return null;
  }
}

function ensureStore(): string | null {
  const root = storeRoot();
  if (!root) return null;
  const ashlr = dirname(root);
  try {
    let ashlrCreated = false;
    try {
      mkdirSync(ashlr, { mode: 0o700 });
      ashlrCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
    }
    if (ashlrCreated && !assurePrivateStoragePath(
      ashlr, 'directory', 'secure-created', { anchorPath: homedir() },
    ).ok) return null;
    if (!privateDirectory(ashlr)) return null;
    const rootState = createDirectory(root);
    if (!rootState) return null;
    if (ashlrCreated) fsyncDirectory(dirname(ashlr));
    if (rootState === 'created') fsyncDirectory(ashlr);
    return root;
  } catch {
    return null;
  }
}

function receiptPayload(receipt: HostMergeRevocationReceiptV1): string {
  return JSON.stringify({
    action: receipt.action,
    authorityId: receipt.authorityId,
    hostAutoMergeEnabled: receipt.hostAutoMergeEnabled,
    operationId: receipt.operationId,
    operationalAuthority: receipt.operationalAuthority,
    phase: receipt.phase,
    previousReceiptDigest: receipt.previousReceiptDigest,
    protocol: receipt.protocol,
    recordedAt: receipt.recordedAt,
    requestDigest: receipt.requestDigest,
    schemaVersion: receipt.schemaVersion,
    sequence: receipt.sequence,
    signatureAlgorithm: receipt.signatureAlgorithm,
    signingKeyId: receipt.signingKeyId,
  });
}

function receiptAttestationPayload(receipt: HostMergeRevocationReceiptV1): string {
  return JSON.stringify({
    receiptDigest: receipt.receiptDigest,
    signingKeyId: receipt.signingKeyId,
    signatureAlgorithm: receipt.signatureAlgorithm,
  });
}

function statePayload(state: HostMergeRevocationStateV1): string {
  return JSON.stringify({
    authorityId: state.authorityId,
    hostAutoMergeEnabled: state.hostAutoMergeEnabled,
    identity: state.identity,
    operationalAuthority: state.operationalAuthority,
    phase: state.phase,
    protocol: state.protocol,
    receipts: state.receipts,
    schemaVersion: state.schemaVersion,
    sequence: state.sequence,
    signatureAlgorithm: state.signatureAlgorithm,
    signingKeyId: state.signingKeyId,
  });
}

function stateAttestationPayload(state: HostMergeRevocationStateV1): string {
  return JSON.stringify({
    stateDigest: state.stateDigest,
    signingKeyId: state.signingKeyId,
    signatureAlgorithm: state.signatureAlgorithm,
  });
}

function requestDigest(
  action: HostMergeRevocationActionV1,
  authorityId: string,
  operationId: string,
  expectedSequence: number,
  expectedReceiptDigest: string | null,
): string {
  return hash(REQUEST_DIGEST_DOMAIN, JSON.stringify({
    action,
    authorityId,
    expectedReceiptDigest,
    expectedSequence,
    operationId,
  }));
}

function buildReceipt(
  key: SigningKey,
  authorityId: string,
  sequence: number,
  action: HostMergeRevocationActionV1,
  phase: HostMergeRevocationPhaseV1,
  operationId: string,
  request: string,
  previousReceiptDigest: string | null,
  recordedAt: string,
): HostMergeRevocationReceiptV1 {
  const unsigned = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authorityId,
    sequence,
    action,
    phase,
    operationId,
    requestDigest: request,
    previousReceiptDigest,
    recordedAt,
    signingKeyId: key.id,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    ...AUTHORITY_FALSE,
    receiptDigest: '',
    attestation: '',
  } satisfies HostMergeRevocationReceiptV1;
  unsigned.receiptDigest = hash(RECEIPT_DIGEST_DOMAIN, receiptPayload(unsigned));
  unsigned.attestation = hmac(
    key.key,
    RECEIPT_ATTESTATION_DOMAIN,
    receiptAttestationPayload(unsigned),
  );
  return unsigned;
}

function buildState(
  key: SigningKey,
  authorityId: string,
  identity: HostMergeRevocationIdentityV1,
  receipts: HostMergeRevocationReceiptV1[],
): HostMergeRevocationStateV1 {
  const latest = receipts.at(-1)!;
  const state = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    authorityId,
    identity,
    phase: latest.phase,
    sequence: latest.sequence,
    receipts,
    signingKeyId: key.id,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    stateDigest: '',
    attestation: '',
    ...AUTHORITY_FALSE,
  } satisfies HostMergeRevocationStateV1;
  state.stateDigest = hash(STATE_DIGEST_DOMAIN, statePayload(state));
  state.attestation = hmac(key.key, STATE_ATTESTATION_DOMAIN, stateAttestationPayload(state));
  return state;
}

function validReceipt(
  value: unknown,
  key: SigningKey,
  authorityId: string,
  previous: HostMergeRevocationReceiptV1 | null,
  expectedSequence: number,
): value is HostMergeRevocationReceiptV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = [
    'action', 'attestation', 'authorityId', 'hostAutoMergeEnabled', 'operationId',
    'operationalAuthority', 'phase', 'previousReceiptDigest', 'protocol',
    'receiptDigest', 'recordedAt', 'requestDigest', 'schemaVersion', 'sequence',
    'signatureAlgorithm', 'signingKeyId',
  ];
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',') ||
    row['schemaVersion'] !== 1 || row['protocol'] !== PROTOCOL ||
    row['authorityId'] !== authorityId || row['sequence'] !== expectedSequence ||
    !['prepare', 'arm', 'revoke', 'consume'].includes(String(row['action'])) ||
    !['prepared', 'armed', 'revoked', 'consumed'].includes(String(row['phase'])) ||
    typeof row['operationId'] !== 'string' || !OPERATION_ID_RE.test(row['operationId']) ||
    typeof row['requestDigest'] !== 'string' || !DIGEST_RE.test(row['requestDigest']) ||
    row['previousReceiptDigest'] !== (previous?.receiptDigest ?? null) ||
    !canonicalTimestamp(row['recordedAt']) ||
    row['signingKeyId'] !== key.id || row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM ||
    typeof row['receiptDigest'] !== 'string' || !DIGEST_RE.test(row['receiptDigest']) ||
    typeof row['attestation'] !== 'string' || !DIGEST_RE.test(row['attestation']) ||
    row['operationalAuthority'] !== false || row['hostAutoMergeEnabled'] !== false) return false;
  const receipt = row as unknown as HostMergeRevocationReceiptV1;
  if (
    (expectedSequence === 1 && (receipt.action !== 'prepare' || receipt.phase !== 'prepared')) ||
    (expectedSequence === 2 && (receipt.action !== 'arm' || receipt.phase !== 'armed')) ||
    (expectedSequence === 3 && !(
      (receipt.action === 'revoke' && receipt.phase === 'revoked') ||
      (receipt.action === 'consume' && receipt.phase === 'consumed')
    )) ||
    (previous && Date.parse(receipt.recordedAt) < Date.parse(previous.recordedAt))
  ) return false;
  const expectedDigest = hash(RECEIPT_DIGEST_DOMAIN, receiptPayload(receipt));
  const expectedAttestation = hmac(
    key.key,
    RECEIPT_ATTESTATION_DOMAIN,
    receiptAttestationPayload(receipt),
  );
  return equalDigest(expectedDigest, receipt.receiptDigest) &&
    equalDigest(expectedAttestation, receipt.attestation);
}

function parseState(
  value: unknown,
  key: SigningKey,
  expectedAuthorityId: string,
  expectedIdentity: HostMergeRevocationIdentityV1,
): HostMergeRevocationStateV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = [
    'attestation', 'authorityId', 'hostAutoMergeEnabled', 'identity',
    'operationalAuthority', 'phase', 'protocol', 'receipts', 'schemaVersion',
    'sequence', 'signatureAlgorithm', 'signingKeyId', 'stateDigest',
  ];
  const identity = sanitizeIdentity(row['identity']);
  if (Object.keys(row).sort().join(',') !== keys.sort().join(',') ||
    row['schemaVersion'] !== 1 || row['protocol'] !== PROTOCOL ||
    row['authorityId'] !== expectedAuthorityId || !identity ||
    identityPayload(identity) !== identityPayload(expectedIdentity) ||
    !Array.isArray(row['receipts']) || row['receipts'].length < 1 ||
    row['receipts'].length > MAX_RECEIPTS || row['sequence'] !== row['receipts'].length ||
    row['signingKeyId'] !== key.id || row['signatureAlgorithm'] !== SIGNATURE_ALGORITHM ||
    row['operationalAuthority'] !== false || row['hostAutoMergeEnabled'] !== false ||
    typeof row['stateDigest'] !== 'string' || !DIGEST_RE.test(row['stateDigest']) ||
    typeof row['attestation'] !== 'string' || !DIGEST_RE.test(row['attestation'])) return null;
  const receipts: HostMergeRevocationReceiptV1[] = [];
  const operationIds = new Set<string>();
  for (let index = 0; index < row['receipts'].length; index += 1) {
    const receipt = row['receipts'][index];
    if (!validReceipt(receipt, key, expectedAuthorityId, receipts[index - 1] ?? null, index + 1) ||
      operationIds.has(receipt.operationId)) return null;
    operationIds.add(receipt.operationId);
    receipts.push(receipt);
  }
  const state = row as unknown as HostMergeRevocationStateV1;
  const latest = receipts.at(-1)!;
  if (state.phase !== latest.phase || state.sequence !== latest.sequence) return null;
  const expectedDigest = hash(STATE_DIGEST_DOMAIN, statePayload(state));
  const expectedAttestation = hmac(key.key, STATE_ATTESTATION_DOMAIN, stateAttestationPayload(state));
  return equalDigest(expectedDigest, state.stateDigest) &&
    equalDigest(expectedAttestation, state.attestation)
    ? state
    : null;
}

function degraded(authorityId: string | null, reason: string): HostMergeRevocationReadResult {
  return { state: 'degraded', authorityId, reason, record: null, ...AUTHORITY_FALSE };
}

function inspectStoreEntries(
  root: string,
  authorityId: string,
): 'healthy' | 'ambiguous-crash-artifact' | 'entry-limit-exceeded' | 'unavailable' {
  let directory: ReturnType<typeof opendirSync> | undefined;
  try {
    const prefix = `${authorityId}.json.`;
    directory = opendirSync(root);
    let entries = 0;
    let ambiguous = false;
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_STORE_ENTRIES) return 'entry-limit-exceeded';
      if (entry.name.startsWith(prefix) && entry.name.endsWith('.tmp')) ambiguous = true;
    }
    return ambiguous ? 'ambiguous-crash-artifact' : 'healthy';
  } catch {
    return 'unavailable';
  } finally {
    try { directory?.closeSync(); } catch { /* fail closed through the returned inspection */ }
  }
}

export function readHostMergeRevocationState(
  inputIdentity: HostMergeRevocationIdentityV1,
): HostMergeRevocationReadResult {
  const identity = sanitizeIdentity(inputIdentity);
  const authorityId = identity ? hostMergeRevocationAuthorityId(identity) : null;
  if (!identity || !authorityId) return degraded(null, 'identity-invalid');
  const root = storeRoot();
  if (!root) return degraded(authorityId, 'store-root-invalid');
  const path = join(root, `${authorityId}.json`);
  if (!existsSync(root)) {
    return { state: 'missing', authorityId, record: null, ...AUTHORITY_FALSE };
  }
  if (!privateDirectory(root)) return degraded(authorityId, 'store-directory-unsafe');
  const inspection = inspectStoreEntries(root, authorityId);
  if (inspection === 'ambiguous-crash-artifact') {
    return degraded(authorityId, 'state-crash-artifact-ambiguous');
  }
  if (inspection === 'entry-limit-exceeded') {
    return degraded(authorityId, 'store-entry-limit-exceeded');
  }
  if (inspection === 'unavailable') return degraded(authorityId, 'store-scan-unavailable');
  if (!existsSync(path)) {
    return { state: 'missing', authorityId, record: null, ...AUTHORITY_FALSE };
  }
  const key = deriveSigningKey();
  if (!key) return degraded(authorityId, 'signing-key-unavailable');
  const read = readStableRegularFile(path, {
    anchorPath: homedir(),
    maxFileBytes: MAX_STATE_BYTES,
    remainingBytes: MAX_STATE_BYTES,
  });
  if (!read.ok) return degraded(authorityId, `state-read-${read.reason}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return degraded(authorityId, 'state-invalid');
  }
  if (`${JSON.stringify(parsed)}\n` !== read.text) return degraded(authorityId, 'state-invalid');
  const record = parseState(parsed, key, authorityId, identity);
  return record
    ? { state: 'healthy', authorityId, record, ...AUTHORITY_FALSE }
    : degraded(authorityId, 'state-authentication-failed');
}

function persistState(root: string, state: HostMergeRevocationStateV1): boolean {
  try {
    const inspection = inspectStoreEntries(root, state.authorityId);
    if (inspection !== 'healthy') return false;
    const files = readdirSync(root).filter((name) => DIGEST_RE.test(name.slice(0, 64)) && name.endsWith('.json'));
    const path = join(root, `${state.authorityId}.json`);
    if (!existsSync(path) && files.length >= MAX_STATE_FILES) return false;
    const temporary = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    writePrivateFileAtomically(temporary, path, `${JSON.stringify(state)}\n`, {
      anchorPath: homedir(),
      label: 'host merge revocation state',
    });
    return true;
  } catch {
    return false;
  }
}

function refusal(
  status: 'refused' | 'degraded',
  authorityId: string | null,
  reason: string,
): HostMergeRevocationWriteResult {
  return { status, authorityId, reason, ...AUTHORITY_FALSE };
}

function withAuthorityLock(
  identity: HostMergeRevocationIdentityV1,
  run: (
    root: string,
    authorityId: string,
    key: SigningKey,
    lock: LocalStoreLock,
  ) => HostMergeRevocationWriteResult,
): HostMergeRevocationWriteResult {
  const authorityId = hostMergeRevocationAuthorityId(identity);
  if (!authorityId) return refusal('refused', null, 'identity-invalid');
  const root = ensureStore();
  if (!root) return refusal('degraded', authorityId, 'store-unavailable');
  const key = deriveSigningKey();
  if (!key) return refusal('degraded', authorityId, 'signing-key-unavailable');
  const acquisition = acquireLocalStoreLockWithOutcome(join(root, `${authorityId}.lock`), 2_000, {
    anchorPath: homedir(),
    exactPrivateStorage: true,
  });
  if (acquisition.state !== 'acquired') {
    return refusal(
      'degraded',
      authorityId,
      acquisition.state === 'contended' ? 'state-lock-contended' : 'state-lock-unavailable',
    );
  }
  const lock = acquisition.lock;
  try {
    return ownsLocalStoreLock(lock)
      ? run(root, authorityId, key, lock)
      : refusal('degraded', authorityId, 'state-lock-lost');
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function replayReceipt(
  state: HostMergeRevocationStateV1,
  operationId: string,
  expectedRequestDigest: string,
): HostMergeRevocationWriteResult | null {
  const receipt = state.receipts.find((candidate) => candidate.operationId === operationId);
  if (!receipt) return null;
  return equalDigest(receipt.requestDigest, expectedRequestDigest)
    ? {
        status: 'replayed',
        authorityId: state.authorityId,
        receipt,
        record: state,
        ...AUTHORITY_FALSE,
      }
    : refusal('refused', state.authorityId, 'operation-id-conflict');
}

export function prepareHostMergeRevocation(
  input: PrepareHostMergeRevocationInputV1,
): HostMergeRevocationWriteResult {
  const startedAt = performance.now();
  const identity = sanitizeIdentity(input.identity);
  const now = safeNow(input.now);
  if (!identity || !now || !OPERATION_ID_RE.test(input.operationId)) {
    return refusal('refused', null, 'prepare-input-invalid');
  }
  const expiresAt = Date.parse(identity.expiresAt);
  if (expiresAt <= now.getTime() || expiresAt - now.getTime() > MAX_TTL_MS) {
    return refusal('refused', hostMergeRevocationAuthorityId(identity), 'expiry-invalid');
  }
  return withAuthorityLock(identity, (root, authorityId, key, lock) => {
    const effectiveNow = now.getTime() + Math.max(0, performance.now() - startedAt);
    if (expiresAt <= effectiveNow) return refusal('refused', authorityId, 'expiry-invalid');
    const request = requestDigest('prepare', authorityId, input.operationId, 0, null);
    const current = readHostMergeRevocationState(identity);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if (current.state === 'degraded') return refusal('degraded', authorityId, current.reason);
    if (current.state === 'healthy') {
      return replayReceipt(current.record, input.operationId, request) ??
        refusal('refused', authorityId, 'authority-already-exists');
    }
    const receipt = buildReceipt(
      key,
      authorityId,
      1,
      'prepare',
      'prepared',
      input.operationId,
      request,
      null,
      new Date(effectiveNow).toISOString(),
    );
    const record = buildState(key, authorityId, identity, [receipt]);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if (expiresAt <= now.getTime() + Math.max(0, performance.now() - startedAt)) {
      return refusal('refused', authorityId, 'expiry-invalid');
    }
    if (!persistState(root, record)) return refusal('degraded', authorityId, 'state-write-failed');
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    const reread = readHostMergeRevocationState(identity);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if (reread.state !== 'healthy' || !equalDigest(reread.record.stateDigest, record.stateDigest)) {
      return refusal('degraded', authorityId, 'state-post-write-verification-failed');
    }
    return { status: 'applied', authorityId, receipt, record: reread.record, ...AUTHORITY_FALSE };
  });
}

function targetPhase(
  action: Exclude<HostMergeRevocationActionV1, 'prepare'>,
): HostMergeRevocationPhaseV1 {
  return action === 'arm' ? 'armed' : action === 'revoke' ? 'revoked' : 'consumed';
}

export function transitionHostMergeRevocation(
  input: TransitionHostMergeRevocationInputV1,
): HostMergeRevocationWriteResult {
  const startedAt = performance.now();
  const identity = sanitizeIdentity(input.identity);
  const now = safeNow(input.now);
  if (!identity || !now || !['arm', 'revoke', 'consume'].includes(input.action) ||
    !OPERATION_ID_RE.test(input.operationId) ||
    !Number.isSafeInteger(input.expectedSequence) || input.expectedSequence < 1 ||
    !DIGEST_RE.test(input.expectedReceiptDigest)) {
    return refusal('refused', identity ? hostMergeRevocationAuthorityId(identity) : null, 'transition-input-invalid');
  }
  return withAuthorityLock(identity, (root, authorityId, key, lock) => {
    const current = readHostMergeRevocationState(identity);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if (current.state === 'missing') return refusal('refused', authorityId, 'authority-missing');
    if (current.state === 'degraded') return refusal('degraded', authorityId, current.reason);
    const record = current.record;
    const latest = record.receipts.at(-1)!;
    const effectiveNow = now.getTime() + Math.max(0, performance.now() - startedAt);
    if (effectiveNow < Date.parse(latest.recordedAt)) {
      return refusal('refused', authorityId, 'clock-rollback');
    }
    // Authority-advancing retries must not turn an old idempotency receipt into
    // fresh authority after expiry. Restrictive revocation remains replayable.
    if ((input.action === 'arm' || input.action === 'consume') &&
      effectiveNow >= Date.parse(identity.expiresAt)) {
      return refusal('refused', authorityId, 'authority-expired');
    }
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    const request = requestDigest(
      input.action,
      authorityId,
      input.operationId,
      input.expectedSequence,
      input.expectedReceiptDigest,
    );
    const replay = replayReceipt(record, input.operationId, request);
    if (replay) return replay;
    if (record.sequence !== input.expectedSequence ||
      !equalDigest(latest.receiptDigest, input.expectedReceiptDigest)) {
      return refusal('refused', authorityId, 'compare-and-swap-mismatch');
    }
    if (record.phase === 'revoked' || record.phase === 'consumed') {
      return refusal('refused', authorityId, 'authority-terminal');
    }
    if ((input.action === 'arm' && record.phase !== 'prepared') ||
      ((input.action === 'revoke' || input.action === 'consume') && record.phase !== 'armed')) {
      return refusal('refused', authorityId, 'transition-invalid');
    }
    // Expiry forbids every authority-advancing transition. Revocation remains
    // available after expiry because it is terminal and strictly restrictive.
    if (record.receipts.length >= MAX_RECEIPTS) {
      return refusal('degraded', authorityId, 'receipt-limit-exceeded');
    }
    const receipt = buildReceipt(
      key,
      authorityId,
      record.sequence + 1,
      input.action,
      targetPhase(input.action),
      input.operationId,
      request,
      latest.receiptDigest,
      new Date(effectiveNow).toISOString(),
    );
    const next = buildState(key, authorityId, identity, [...record.receipts, receipt]);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if ((input.action === 'arm' || input.action === 'consume') &&
      now.getTime() + Math.max(0, performance.now() - startedAt) >= Date.parse(identity.expiresAt)) {
      return refusal('refused', authorityId, 'authority-expired');
    }
    if (!persistState(root, next)) return refusal('degraded', authorityId, 'state-write-failed');
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    const reread = readHostMergeRevocationState(identity);
    if (!ownsLocalStoreLock(lock)) return refusal('degraded', authorityId, 'state-lock-lost');
    if (reread.state !== 'healthy' || !equalDigest(reread.record.stateDigest, next.stateDigest)) {
      return refusal('degraded', authorityId, 'state-post-write-verification-failed');
    }
    return { status: 'applied', authorityId, receipt, record: reread.record, ...AUTHORITY_FALSE };
  });
}

/** Crash recovery is an authenticated read. It never advances or repairs state. */
export function recoverHostMergeRevocation(
  identity: HostMergeRevocationIdentityV1,
): HostMergeRevocationReadResult {
  return readHostMergeRevocationState(identity);
}
