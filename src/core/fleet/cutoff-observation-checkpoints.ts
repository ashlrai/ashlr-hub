/**
 * Durable, authenticated ordering for bracketed cutoff observations.
 *
 * This ledger is observation-only. It does not establish an exact shared
 * cutoff, a denominator-complete population, or merge-policy authority.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  loadExistingProvenanceKey,
  loadExistingProvenanceKeyReadOnly,
} from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import {
  createCutoffCheckpointDigestV1,
  verifyCutoffCheckpointDigestV1,
} from './authenticated-cutoff-snapshot.js';
import {
  verifyEnrollmentCutoffSnapshotV2,
  type EnrollmentCutoffSnapshotV2,
} from './enrollment-cutoff-snapshot.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const MAX_ROWS = 256;
const MAX_ROW_BYTES = 8 * 1024 * 1024;
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_ROOT_BYTES = 16 * 1024;
const MAX_ROTATION_BYTES = 16 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENTRY_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'cutoffAuthority',
  'denominatorComplete', 'policyEligible', 'rollbackProtected', 'historicalAuthority',
  'sequence', 'previousEntryDigest',
  'recordedAt', 'snapshot', 'entryDigest',
]);
const ROOT_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'cutoffAuthority',
  'denominatorComplete', 'policyEligible', 'rollbackProtected', 'historicalAuthority',
  'sequence', 'entryDigest',
  'ledgerBytes', 'updatedAt', 'rootDigest',
]);
const RETENTION_CERTIFICATE_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'cutoffAuthority', 'denominatorComplete',
  'policyEligible', 'rollbackProtected', 'historicalAuthority', 'generation',
  'legacyRootDigest', 'legacyEntryDigest', 'legacySequence', 'activeRootDigest',
  'activeEntryDigest', 'activeSequence', 'certificateDigest',
]);
const GENERATION_HEAD_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'cutoffAuthority', 'denominatorComplete',
  'policyEligible', 'rollbackProtected', 'historicalAuthority', 'generation',
  'certificateDigest', 'headDigest',
]);
const GENERATION_INTENT_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'cutoffAuthority', 'denominatorComplete',
  'policyEligible', 'rollbackProtected', 'historicalAuthority', 'generation', 'phase', 'intentDigest',
]);

type KeyProvider = () => Buffer | null;

export interface CutoffObservationCheckpointV1 {
  schemaVersion: 1;
  recordType: 'cutoff-observation-checkpoint';
  authority: 'observation-only';
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
  sequence: number;
  previousEntryDigest: string | null;
  recordedAt: string;
  recoveryPolicy?: 'root-required';
  captureAttemptId?: string;
  snapshot: EnrollmentCutoffSnapshotV2;
  entryDigest: string;
}

export interface CutoffObservationRootV1 {
  schemaVersion: 1;
  recordType: 'cutoff-observation-root';
  authority: 'observation-only';
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
  sequence: number;
  entryDigest: string;
  ledgerBytes: number;
  updatedAt: string;
  rootDigest: string;
}

/**
 * V1 retention is deliberately one-generation only. This certificate is a
 * metadata-only bridge between the immutable legacy ledger and generation 1;
 * it never grants cutoff, historical, denominator, or policy authority.
 */
interface CutoffObservationRetentionCertificateV1 {
  schemaVersion: 1;
  recordType: 'cutoff-observation-retention-certificate';
  authority: 'observation-only';
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
  generation: 1;
  legacyRootDigest: string;
  legacyEntryDigest: string;
  legacySequence: number;
  activeRootDigest: string;
  activeEntryDigest: string;
  activeSequence: number;
  certificateDigest: string;
}

interface CutoffObservationGenerationHeadV1 {
  schemaVersion: 1;
  recordType: 'cutoff-observation-generation-head';
  authority: 'observation-only';
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
  generation: 1;
  certificateDigest: string;
  headDigest: string;
}

interface CutoffObservationGenerationIntentV1 {
  schemaVersion: 1;
  recordType: 'cutoff-observation-generation-intent';
  authority: 'observation-only';
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
  generation: 1;
  phase: 'building' | 'committed';
  intentDigest: string;
}

export type CutoffObservationStopReason =
  | 'invalid-row'
  | 'invalid-root'
  | 'unreleased-tail'
  | 'io-error';

export interface CutoffObservationCheckpointReadResult {
  checkpoints: CutoffObservationCheckpointV1[];
  root: CutoffObservationRootV1 | null;
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: CutoffObservationStopReason[];
  physicalRows: number;
  releasedRows: number;
  unreleasedRows: number;
  bytesRead: number;
  latestCapturedAt: string | null;
  cutoffAuthority: false;
  denominatorComplete: false;
  policyEligible: false;
  rollbackProtected: false;
  historicalAuthority: false;
}

export interface CutoffObservationCheckpointWriteResult {
  attempted: 1;
  recorded: 0 | 1;
  replayed: 0 | 1;
  recoveredRows: number;
  invalid: 0 | 1;
  failed: 0 | 1;
}

interface DirectoryState {
  rootPath: string;
  root: Stats;
  fleetPath: string;
  fleet: Stats;
}

interface ParsedLedger {
  entries: CutoffObservationCheckpointV1[];
  lineEnds: number[];
  bytes: Buffer;
  invalid: boolean;
  tornTail: boolean;
}

function keyProvider(): Buffer | null {
  try { return loadExistingProvenanceKey(); } catch { return null; }
}

function readOnlyKeyProvider(): Buffer | null {
  try { return loadExistingProvenanceKeyReadOnly(); } catch { return null; }
}

function pinKey(provider: KeyProvider): KeyProvider | null {
  let loaded: Buffer | null;
  try { loaded = provider(); } catch { return null; }
  if (!Buffer.isBuffer(loaded) || loaded.length !== 32) return null;
  const pinned = Buffer.from(loaded);
  return () => pinned;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function sameNode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function owned(stat: Stats): boolean {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

function privateDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function privateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 && owned(stat) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

function storageRoot(): string {
  const configured = process.env.ASHLR_HOME;
  if (!configured) return join(homedir(), '.ashlr');
  if (!isAbsolute(configured) || resolve(configured) !== configured) {
    throw new Error('ASHLR_HOME must be canonical and absolute');
  }
  return configured;
}

export function cutoffObservationCheckpointLedgerPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.jsonl');
}

export function cutoffObservationCheckpointRootPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.root.json');
}

function generationOneLedgerPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.g1.jsonl');
}

function generationOneRootPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.g1.root.json');
}

function retentionCertificatePath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.retention.g1.json');
}

function generationHeadPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.generations.head.json');
}

function generationIntentPath(): string {
  return join(storageRoot(), 'fleet', 'cutoff-observation-checkpoints.g1.intent.json');
}

function lockPath(): string {
  return join(storageRoot(), 'fleet', '.cutoff-observation-checkpoints.lock');
}

function ensurePrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 });
  let stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)) throw new Error('unsafe checkpoint directory');
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  stat = lstatSync(path);
  if (!privateDirectory(stat)) throw new Error('checkpoint directory is not private');
  return stat;
}

function ensureDirectories(): DirectoryState {
  const rootPath = storageRoot();
  const parent = dirname(rootPath);
  if (!existsSync(rootPath)) {
    if (!existsSync(parent) || !privateDirectory(lstatSync(parent))) {
      throw new Error('unsafe checkpoint root parent');
    }
    mkdirSync(rootPath, { mode: 0o700 });
    fsyncDirectory(parent);
  }
  const root = ensurePrivateDirectory(rootPath);
  const fleetPath = join(rootPath, 'fleet');
  if (!existsSync(fleetPath)) {
    mkdirSync(fleetPath, { mode: 0o700 });
    fsyncDirectory(rootPath);
  }
  const fleet = ensurePrivateDirectory(fleetPath);
  return { rootPath, root, fleetPath, fleet };
}

function verifyDirectories(expected: DirectoryState): void {
  const root = lstatSync(expected.rootPath);
  const fleet = lstatSync(expected.fleetPath);
  if (!privateDirectory(root) || !privateDirectory(fleet) ||
    !sameNode(root, expected.root) || !sameNode(fleet, expected.fleet)) {
    throw new Error('checkpoint directory identity changed');
  }
}

function readOpened(fd: number, size: number): Buffer {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_LEDGER_BYTES) throw new Error('checkpoint byte limit');
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error('short checkpoint read');
    offset += count;
  }
  return bytes;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, null);
    if (count <= 0) throw new Error('short checkpoint write');
    offset += count;
  }
}

function entryPayload(entry: Omit<CutoffObservationCheckpointV1, 'entryDigest'>): unknown[] {
  const payload: unknown[] = [
    'entry', entry.schemaVersion, entry.recordType, entry.authority,
    entry.cutoffAuthority, entry.denominatorComplete, entry.policyEligible,
    entry.rollbackProtected, entry.historicalAuthority,
    entry.sequence, entry.previousEntryDigest, entry.recordedAt, entry.snapshot,
  ];
  if (entry.recoveryPolicy === 'root-required') payload.push(entry.recoveryPolicy);
  if (entry.captureAttemptId) payload.push(entry.captureAttemptId);
  return payload;
}

function rootPayload(root: Omit<CutoffObservationRootV1, 'rootDigest'>): unknown[] {
  return [
    'root', root.schemaVersion, root.recordType, root.authority,
    root.cutoffAuthority, root.denominatorComplete, root.policyEligible,
    root.rollbackProtected, root.historicalAuthority,
    root.sequence, root.entryDigest, root.ledgerBytes, root.updatedAt,
  ];
}

function retentionCertificatePayload(
  value: Omit<CutoffObservationRetentionCertificateV1, 'certificateDigest'>,
): unknown[] {
  return [
    'retention-certificate', value.schemaVersion, value.recordType, value.authority,
    value.cutoffAuthority, value.denominatorComplete, value.policyEligible,
    value.rollbackProtected, value.historicalAuthority, value.generation,
    value.legacyRootDigest, value.legacyEntryDigest, value.legacySequence,
    value.activeRootDigest, value.activeEntryDigest, value.activeSequence,
  ];
}

function generationHeadPayload(value: Omit<CutoffObservationGenerationHeadV1, 'headDigest'>): unknown[] {
  return [
    'generation-head', value.schemaVersion, value.recordType, value.authority,
    value.cutoffAuthority, value.denominatorComplete, value.policyEligible,
    value.rollbackProtected, value.historicalAuthority, value.generation,
    value.certificateDigest,
  ];
}

function generationIntentPayload(value: Omit<CutoffObservationGenerationIntentV1, 'intentDigest'>): unknown[] {
  return [
    'generation-intent', value.schemaVersion, value.recordType, value.authority,
    value.cutoffAuthority, value.denominatorComplete, value.policyEligible,
    value.rollbackProtected, value.historicalAuthority, value.generation, value.phase,
  ];
}

function buildGenerationIntent(
  phase: CutoffObservationGenerationIntentV1['phase'],
  key: KeyProvider,
): CutoffObservationGenerationIntentV1 | null {
  const base = {
    schemaVersion: 1 as const,
    recordType: 'cutoff-observation-generation-intent' as const,
    authority: 'observation-only' as const,
    cutoffAuthority: false as const,
    denominatorComplete: false as const,
    policyEligible: false as const,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
    generation: 1 as const,
    phase,
  };
  const intentDigest = createCutoffCheckpointDigestV1(generationIntentPayload(base), key);
  return intentDigest ? { ...base, intentDigest } : null;
}

function verifyGenerationIntent(value: unknown, key: KeyProvider): value is CutoffObservationGenerationIntentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const intent = value as CutoffObservationGenerationIntentV1;
  if (Object.keys(intent).length !== GENERATION_INTENT_KEYS.size ||
    Object.keys(intent).some((name) => !GENERATION_INTENT_KEYS.has(name)) ||
    intent.schemaVersion !== 1 || intent.recordType !== 'cutoff-observation-generation-intent' ||
    intent.authority !== 'observation-only' || intent.cutoffAuthority !== false ||
    intent.denominatorComplete !== false || intent.policyEligible !== false ||
    intent.rollbackProtected !== false || intent.historicalAuthority !== false || intent.generation !== 1 ||
    (intent.phase !== 'building' && intent.phase !== 'committed') || !SHA256_RE.test(intent.intentDigest)) return false;
  const { intentDigest: _intentDigest, ...base } = intent;
  return verifyCutoffCheckpointDigestV1(generationIntentPayload(base), intent.intentDigest, key);
}

function buildRetentionCertificate(
  legacy: CutoffObservationRootV1,
  active: CutoffObservationRootV1,
  key: KeyProvider,
): CutoffObservationRetentionCertificateV1 | null {
  const base = {
    schemaVersion: 1 as const,
    recordType: 'cutoff-observation-retention-certificate' as const,
    authority: 'observation-only' as const,
    cutoffAuthority: false as const,
    denominatorComplete: false as const,
    policyEligible: false as const,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
    generation: 1 as const,
    legacyRootDigest: legacy.rootDigest,
    legacyEntryDigest: legacy.entryDigest,
    legacySequence: legacy.sequence,
    activeRootDigest: active.rootDigest,
    activeEntryDigest: active.entryDigest,
    activeSequence: active.sequence,
  };
  const certificateDigest = createCutoffCheckpointDigestV1(retentionCertificatePayload(base), key);
  return certificateDigest ? { ...base, certificateDigest } : null;
}

function verifyRetentionCertificate(value: unknown, key: KeyProvider): value is CutoffObservationRetentionCertificateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const certificate = value as CutoffObservationRetentionCertificateV1;
  if (Object.keys(certificate).length !== RETENTION_CERTIFICATE_KEYS.size ||
    Object.keys(certificate).some((name) => !RETENTION_CERTIFICATE_KEYS.has(name)) ||
    certificate.schemaVersion !== 1 || certificate.recordType !== 'cutoff-observation-retention-certificate' ||
    certificate.authority !== 'observation-only' || certificate.cutoffAuthority !== false ||
    certificate.denominatorComplete !== false || certificate.policyEligible !== false ||
    certificate.rollbackProtected !== false || certificate.historicalAuthority !== false ||
    certificate.generation !== 1 || !SHA256_RE.test(certificate.legacyRootDigest) ||
    !SHA256_RE.test(certificate.legacyEntryDigest) || !Number.isSafeInteger(certificate.legacySequence) ||
    certificate.legacySequence !== MAX_ROWS || !SHA256_RE.test(certificate.activeRootDigest) ||
    !SHA256_RE.test(certificate.activeEntryDigest) || !Number.isSafeInteger(certificate.activeSequence) ||
    certificate.activeSequence < 1 || certificate.activeSequence > MAX_ROWS ||
    !SHA256_RE.test(certificate.certificateDigest)) return false;
  const { certificateDigest: _certificateDigest, ...base } = certificate;
  return verifyCutoffCheckpointDigestV1(retentionCertificatePayload(base), certificate.certificateDigest, key);
}

function buildGenerationHead(
  certificate: CutoffObservationRetentionCertificateV1,
  key: KeyProvider,
): CutoffObservationGenerationHeadV1 | null {
  const base = {
    schemaVersion: 1 as const,
    recordType: 'cutoff-observation-generation-head' as const,
    authority: 'observation-only' as const,
    cutoffAuthority: false as const,
    denominatorComplete: false as const,
    policyEligible: false as const,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
    generation: 1 as const,
    certificateDigest: certificate.certificateDigest,
  };
  const headDigest = createCutoffCheckpointDigestV1(generationHeadPayload(base), key);
  return headDigest ? { ...base, headDigest } : null;
}

function verifyGenerationHead(value: unknown, key: KeyProvider): value is CutoffObservationGenerationHeadV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const head = value as CutoffObservationGenerationHeadV1;
  if (Object.keys(head).length !== GENERATION_HEAD_KEYS.size ||
    Object.keys(head).some((name) => !GENERATION_HEAD_KEYS.has(name)) ||
    head.schemaVersion !== 1 || head.recordType !== 'cutoff-observation-generation-head' ||
    head.authority !== 'observation-only' || head.cutoffAuthority !== false ||
    head.denominatorComplete !== false || head.policyEligible !== false ||
    head.rollbackProtected !== false || head.historicalAuthority !== false || head.generation !== 1 ||
    !SHA256_RE.test(head.certificateDigest) || !SHA256_RE.test(head.headDigest)) return false;
  const { headDigest: _headDigest, ...base } = head;
  return verifyCutoffCheckpointDigestV1(generationHeadPayload(base), head.headDigest, key);
}

function buildEntry(
  snapshot: EnrollmentCutoffSnapshotV2,
  sequence: number,
  previousEntryDigest: string | null,
  recordedAt: string,
  key: KeyProvider,
  recoveryPolicy?: 'root-required',
  captureAttemptId?: string,
): CutoffObservationCheckpointV1 | null {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || !canonicalTimestamp(recordedAt) ||
    !verifyEnrollmentCutoffSnapshotV2(snapshot, key)) return null;
  const base = {
    schemaVersion: 1 as const,
    recordType: 'cutoff-observation-checkpoint' as const,
    authority: 'observation-only' as const,
    cutoffAuthority: false as const,
    denominatorComplete: false as const,
    policyEligible: false as const,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
    sequence,
    previousEntryDigest,
    recordedAt,
    snapshot,
    ...(recoveryPolicy ? { recoveryPolicy } : {}),
    ...(captureAttemptId ? { captureAttemptId } : {}),
  };
  const entryDigest = createCutoffCheckpointDigestV1(entryPayload(base), key);
  return entryDigest ? { ...base, entryDigest } : null;
}

function verifyEntry(
  value: unknown,
  expectedSequence: number,
  previousEntryDigest: string | null,
  key: KeyProvider,
): value is CutoffObservationCheckpointV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as CutoffObservationCheckpointV1;
  const keys = new Set(ENTRY_KEYS);
  if (entry.recoveryPolicy === 'root-required') keys.add('recoveryPolicy');
  if (typeof entry.captureAttemptId === 'string') keys.add('captureAttemptId');
  if (Object.keys(entry).length !== keys.size || Object.keys(entry).some((name) => !keys.has(name)) ||
    entry.schemaVersion !== 1 || entry.recordType !== 'cutoff-observation-checkpoint' ||
    entry.authority !== 'observation-only' || entry.cutoffAuthority !== false ||
    entry.denominatorComplete !== false || entry.policyEligible !== false ||
    entry.rollbackProtected !== false || entry.historicalAuthority !== false ||
    (entry.captureAttemptId !== undefined && !/^[a-f0-9-]{36}$/.test(entry.captureAttemptId)) ||
    entry.sequence !== expectedSequence || entry.previousEntryDigest !== previousEntryDigest ||
    !canonicalTimestamp(entry.recordedAt) || !SHA256_RE.test(entry.entryDigest) ||
    !verifyEnrollmentCutoffSnapshotV2(entry.snapshot, key)) return false;
  const { entryDigest: _entryDigest, ...base } = entry;
  return verifyCutoffCheckpointDigestV1(entryPayload(base), entry.entryDigest, key);
}

function buildRoot(
  entry: CutoffObservationCheckpointV1,
  ledgerBytes: number,
  updatedAt: string,
  key: KeyProvider,
): CutoffObservationRootV1 | null {
  if (!Number.isSafeInteger(ledgerBytes) || ledgerBytes < 1 || !canonicalTimestamp(updatedAt)) return null;
  const base = {
    schemaVersion: 1 as const,
    recordType: 'cutoff-observation-root' as const,
    authority: 'observation-only' as const,
    cutoffAuthority: false as const,
    denominatorComplete: false as const,
    policyEligible: false as const,
    rollbackProtected: false as const,
    historicalAuthority: false as const,
    sequence: entry.sequence,
    entryDigest: entry.entryDigest,
    ledgerBytes,
    updatedAt,
  };
  const rootDigest = createCutoffCheckpointDigestV1(rootPayload(base), key);
  return rootDigest ? { ...base, rootDigest } : null;
}

function verifyRoot(value: unknown, key: KeyProvider): value is CutoffObservationRootV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = value as CutoffObservationRootV1;
  if (Object.keys(root).length !== ROOT_KEYS.size || Object.keys(root).some((name) => !ROOT_KEYS.has(name)) ||
    root.schemaVersion !== 1 || root.recordType !== 'cutoff-observation-root' ||
    root.authority !== 'observation-only' || root.cutoffAuthority !== false ||
    root.denominatorComplete !== false || root.policyEligible !== false ||
    root.rollbackProtected !== false || root.historicalAuthority !== false ||
    !Number.isSafeInteger(root.sequence) || root.sequence < 1 || !SHA256_RE.test(root.entryDigest) ||
    !Number.isSafeInteger(root.ledgerBytes) || root.ledgerBytes < 1 ||
    !canonicalTimestamp(root.updatedAt) || !SHA256_RE.test(root.rootDigest)) return false;
  const { rootDigest: _rootDigest, ...base } = root;
  return verifyCutoffCheckpointDigestV1(rootPayload(base), root.rootDigest, key);
}

function parseLedger(bytes: Buffer, key: KeyProvider): ParsedLedger {
  if (bytes.length === 0) return { entries: [], lineEnds: [], bytes, invalid: false, tornTail: false };
  const tornTail = bytes[bytes.length - 1] !== 0x0a;
  const complete = tornTail ? bytes.subarray(0, bytes.lastIndexOf(0x0a) + 1) : bytes;
  const lines = complete.length === 0 ? [] : complete.toString('utf8').slice(0, -1).split('\n');
  const entries: CutoffObservationCheckpointV1[] = [];
  const lineEnds: number[] = [];
  let offset = 0;
  let invalid = tornTail || lines.length > MAX_ROWS;
  for (const line of lines) {
    const length = Buffer.byteLength(line, 'utf8') + 1;
    offset += length;
    if (!line || length > MAX_ROW_BYTES) { invalid = true; continue; }
    try {
      const previous = entries.length === 0 ? null : entries[entries.length - 1]!.entryDigest;
      const value: unknown = JSON.parse(line);
      if (!verifyEntry(value, entries.length + 1, previous, key)) invalid = true;
      else { entries.push(value); lineEnds.push(offset); }
    } catch { invalid = true; }
  }
  return { entries, lineEnds, bytes, invalid, tornTail };
}

function readPrivateFile(path: string, maxBytes: number): Buffer | null | 'degraded' {
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    const named = lstatSync(path);
    if (!privateFile(named) || named.size > maxBytes) return 'degraded';
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size > maxBytes) return 'degraded';
    const bytes = readOpened(fd, opened.size);
    const after = fstatSync(fd);
    const namedAfter = lstatSync(path);
    if (!privateFile(after) || !privateFile(namedAfter) || !sameNode(opened, after) ||
      !sameNode(opened, namedAfter) || after.size !== opened.size) return 'degraded';
    return bytes;
  } catch { return 'degraded'; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function readRoot(
  path: string,
  key: KeyProvider,
): CutoffObservationRootV1 | null | 'io-error' | 'invalid-root' {
  const bytes = readPrivateFile(path, MAX_ROOT_BYTES);
  if (bytes === null) return null;
  if (bytes === 'degraded') return 'io-error';
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return verifyRoot(value, key) ? value : 'invalid-root';
  } catch { return 'invalid-root'; }
}

function readSignedJson<T>(
  path: string,
  key: KeyProvider,
  verify: (value: unknown, key: KeyProvider) => value is T,
): T | null | 'io-error' | 'invalid-root' {
  const bytes = readPrivateFile(path, MAX_ROTATION_BYTES);
  if (bytes === null) return null;
  if (bytes === 'degraded') return 'io-error';
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    return verify(value, key) ? value : 'invalid-root';
  } catch { return 'invalid-root'; }
}

function writeSignedJson(path: string, value: object, directories: DirectoryState): boolean {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > MAX_ROTATION_BYTES) return false;
  const tmp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    if (existsSync(path) && !privateFile(lstatSync(path))) return false;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    writeAll(fd, bytes);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!privateFile(written) || !sameNode(opened, written) || written.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;
    verifyDirectories(directories);
    renameSync(tmp, path);
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(written, installed)) return false;
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function writeRoot(path: string, root: CutoffObservationRootV1, directories: DirectoryState): boolean {
  const bytes = Buffer.from(`${JSON.stringify(root)}\n`, 'utf8');
  if (bytes.length > MAX_ROOT_BYTES) return false;
  const tmp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    if (existsSync(path) && !privateFile(lstatSync(path))) return false;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    writeAll(fd, bytes);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    if (!privateFile(written) || !sameNode(opened, written) || written.size !== bytes.length) return false;
    closeSync(fd);
    fd = undefined;
    verifyDirectories(directories);
    renameSync(tmp, path);
    const installed = lstatSync(path);
    if (!privateFile(installed) || !sameNode(written, installed)) return false;
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
  }
}

function emptyRead(
  sourceState: CutoffObservationCheckpointReadResult['sourceState'],
  overrides: Partial<CutoffObservationCheckpointReadResult> = {},
): CutoffObservationCheckpointReadResult {
  return {
    checkpoints: [], root: null, sourceState, sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded', stopReasons: [], physicalRows: 0,
    releasedRows: 0, unreleasedRows: 0, bytesRead: 0, latestCapturedAt: null,
    cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
    rollbackProtected: false, historicalAuthority: false,
    ...overrides,
  };
}

interface ReleasedLedger {
  parsed: ParsedLedger;
  root: CutoffObservationRootV1;
  entries: CutoffObservationCheckpointV1[];
}

function readReleasedLedger(
  ledgerPath: string,
  rootPath: string,
  key: KeyProvider,
): ReleasedLedger | null | 'degraded' {
  const ledgerBytes = readPrivateFile(ledgerPath, MAX_LEDGER_BYTES);
  const root = readRoot(rootPath, key);
  if (ledgerBytes === null || root === null || ledgerBytes === 'degraded' ||
    root === 'io-error' || root === 'invalid-root') return 'degraded';
  const parsed = parseLedger(ledgerBytes, key);
  const released = root.ledgerBytes <= ledgerBytes.length
    ? parseLedger(ledgerBytes.subarray(0, root.ledgerBytes), key) : null;
  const rootIndex = root.sequence - 1;
  const rootEntry = released?.entries[rootIndex];
  const rootEnd = released?.lineEnds[rootIndex];
  if (parsed.invalid || released?.invalid || !released || released.entries.length !== root.sequence ||
    !rootEntry || rootEnd !== root.ledgerBytes || rootEntry.entryDigest !== root.entryDigest ||
    parsed.entries.length !== root.sequence) return 'degraded';
  return { parsed, root, entries: released.entries };
}

function readRotatedCheckpoints(
  key: KeyProvider,
): CutoffObservationCheckpointReadResult | null {
  const head = readSignedJson(generationHeadPath(), key, verifyGenerationHead);
  const intent = readSignedJson(generationIntentPath(), key, verifyGenerationIntent);
  if (head === null) {
    if (intent === null) {
      const orphaned = [generationOneLedgerPath(), generationOneRootPath(), retentionCertificatePath()]
        .some((path) => existsSync(path));
      return orphaned ? emptyRead('degraded', { sourcePresent: true, stopReasons: ['invalid-root'] }) : null;
    }
    if (intent === 'io-error' || intent === 'invalid-root' || intent.phase === 'committed') {
      return emptyRead('degraded', { sourcePresent: true, stopReasons: ['invalid-root'] });
    }
    // A signed building marker makes these artifacts explicitly unpublished.
    return null;
  }
  if (head === 'io-error' || head === 'invalid-root') {
    return emptyRead('degraded', { sourcePresent: true, stopReasons: ['invalid-root'] });
  }
  const legacy = readReleasedLedger(cutoffObservationCheckpointLedgerPath(), cutoffObservationCheckpointRootPath(), key);
  const active = readReleasedLedger(generationOneLedgerPath(), generationOneRootPath(), key);
  const certificate = readSignedJson(retentionCertificatePath(), key, verifyRetentionCertificate);
  if (!legacy || !active || legacy === 'degraded' || active === 'degraded' || intent === null ||
    intent === 'io-error' || intent === 'invalid-root' || intent.phase !== 'committed' || certificate === null ||
    certificate === 'io-error' || certificate === 'invalid-root' ||
    certificate.certificateDigest !== head.certificateDigest ||
    certificate.legacyRootDigest !== legacy.root.rootDigest ||
    certificate.legacyEntryDigest !== legacy.root.entryDigest ||
    certificate.legacySequence !== legacy.root.sequence ||
    certificate.activeRootDigest !== active.root.rootDigest ||
    certificate.activeEntryDigest !== active.root.entryDigest ||
    certificate.activeSequence !== active.root.sequence) {
    return emptyRead('degraded', { sourcePresent: true, stopReasons: ['invalid-root'] });
  }
  const checkpoints = [...legacy.entries, ...active.entries];
  return {
    checkpoints, root: active.root, sourceState: 'healthy', sourcePresent: true,
    complete: true, stopReasons: [], physicalRows: checkpoints.length,
    releasedRows: checkpoints.length, unreleasedRows: 0,
    bytesRead: legacy.parsed.bytes.length + active.parsed.bytes.length,
    latestCapturedAt: checkpoints[checkpoints.length - 1]?.snapshot.capturedAt ?? null,
    cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
    rollbackProtected: false, historicalAuthority: false,
  };
}

function readCutoffObservationCheckpointsOnce(
  key: KeyProvider,
): CutoffObservationCheckpointReadResult {
  let directories: DirectoryState;
  try {
    const rootPath = storageRoot();
    const fleetPath = join(rootPath, 'fleet');
    if (!existsSync(rootPath) || !existsSync(fleetPath)) return emptyRead('missing', { sourcePresent: false });
    const root = lstatSync(rootPath);
    const fleet = lstatSync(fleetPath);
    if (!privateDirectory(root) || !privateDirectory(fleet)) {
      return emptyRead('degraded', { stopReasons: ['io-error'] });
    }
    directories = { rootPath, root, fleetPath, fleet };
  } catch { return emptyRead('degraded', { stopReasons: ['io-error'] }); }
  try {
    const pinnedKey = pinKey(key);
    if (!pinnedKey) return emptyRead('degraded', { sourcePresent: true, stopReasons: ['io-error'] });
    verifyDirectories(directories);
    const rotated = readRotatedCheckpoints(pinnedKey);
    if (rotated) return rotated;
    verifyDirectories(directories);
    const ledgerBytes = readPrivateFile(cutoffObservationCheckpointLedgerPath(), MAX_LEDGER_BYTES);
    const root = readRoot(cutoffObservationCheckpointRootPath(), pinnedKey);
    verifyDirectories(directories);
    if (ledgerBytes === null && root === null) return emptyRead('missing', { sourcePresent: false });
    if (root === 'invalid-root') {
      return emptyRead('degraded', { sourcePresent: true, stopReasons: ['invalid-root'] });
    }
    if (ledgerBytes === 'degraded' || root === 'io-error' || ledgerBytes === null || root === null) {
      return emptyRead('degraded', { sourcePresent: true, stopReasons: ['io-error'] });
    }
    const parsed = parseLedger(ledgerBytes, pinnedKey);
    const rootIndex = root.sequence - 1;
    const released = root.ledgerBytes <= ledgerBytes.length
      ? parseLedger(ledgerBytes.subarray(0, root.ledgerBytes), pinnedKey)
      : null;
    const rootEntry = released?.entries[rootIndex];
    const rootEnd = released?.lineEnds[rootIndex];
    if (released?.invalid) {
      return emptyRead('degraded', {
        sourcePresent: true, root, stopReasons: ['invalid-row'],
        physicalRows: parsed.entries.length, bytesRead: ledgerBytes.length,
      });
    }
    if (!released || released.entries.length !== root.sequence || !rootEntry ||
      rootEnd !== root.ledgerBytes || rootEntry.entryDigest !== root.entryDigest) {
      return emptyRead('degraded', {
        sourcePresent: true, root, stopReasons: ['invalid-root'],
        physicalRows: parsed.entries.length, bytesRead: ledgerBytes.length,
      });
    }
    const checkpoints = released.entries;
    if (parsed.invalid) {
      return {
        ...emptyRead('degraded'), checkpoints, root, sourcePresent: true, complete: false,
        stopReasons: ['invalid-row'], physicalRows: Math.max(parsed.entries.length, root.sequence + 1),
        releasedRows: checkpoints.length, unreleasedRows: 1, bytesRead: ledgerBytes.length,
        latestCapturedAt: checkpoints[checkpoints.length - 1]?.snapshot.capturedAt ?? null,
      };
    }
    const unreleasedRows = parsed.entries.length - root.sequence;
    return {
      checkpoints, root, sourceState: unreleasedRows > 0 ? 'degraded' : 'healthy',
      sourcePresent: true, complete: unreleasedRows === 0,
      stopReasons: unreleasedRows > 0 ? ['unreleased-tail'] : [],
      physicalRows: parsed.entries.length, releasedRows: checkpoints.length, unreleasedRows,
      bytesRead: ledgerBytes.length,
      latestCapturedAt: checkpoints[checkpoints.length - 1]?.snapshot.capturedAt ?? null,
      cutoffAuthority: false, denominatorComplete: false, policyEligible: false,
      rollbackProtected: false, historicalAuthority: false,
    };
  } catch {
    return emptyRead('degraded', { sourcePresent: true, stopReasons: ['io-error'] });
  }
}

/** Authenticated, non-mutating snapshot read for status and diagnostics. */
export function readCutoffObservationCheckpointsSnapshot(
  key: KeyProvider = readOnlyKeyProvider,
  attempts = 3,
): CutoffObservationCheckpointReadResult {
  let keyLoaded = false;
  let stableKey: Buffer | null = null;
  const transactionKey = (): Buffer | null => {
    if (!keyLoaded) {
      keyLoaded = true;
      try {
        const loaded = key();
        stableKey = Buffer.isBuffer(loaded) && loaded.length === 32 ? Buffer.from(loaded) : null;
      } catch { stableKey = null; }
    }
    return stableKey;
  };
  const boundedAttempts = Number.isSafeInteger(attempts) ? Math.max(1, Math.min(5, attempts)) : 3;
  let result = emptyRead('degraded', { sourcePresent: true, stopReasons: ['io-error'] });
  for (let attempt = 0; attempt < boundedAttempts; attempt += 1) {
    result = readCutoffObservationCheckpointsOnce(transactionKey);
    if (result.sourceState !== 'degraded') return result;
  }
  return result;
}

export function readCutoffObservationCheckpoints(
  key: KeyProvider = keyProvider,
): CutoffObservationCheckpointReadResult {
  try {
    const rootPath = storageRoot();
    const fleetPath = join(rootPath, 'fleet');
    if (!existsSync(rootPath) || !existsSync(fleetPath)) return emptyRead('missing', { sourcePresent: false });
    const root = lstatSync(rootPath);
    const fleet = lstatSync(fleetPath);
    if (!privateDirectory(root) || !privateDirectory(fleet)) {
      return emptyRead('degraded', { stopReasons: ['io-error'] });
    }
  } catch { return emptyRead('degraded', { stopReasons: ['io-error'] }); }
  const lock = acquireLocalStoreLock(lockPath(), 2_000);
  if (!lock) return emptyRead('degraded', { sourcePresent: true, stopReasons: ['io-error'] });
  try {
    return readCutoffObservationCheckpointsOnce(key);
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function writeFreshLedger(path: string, row: Buffer, directories: DirectoryState): boolean {
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    if (existsSync(path)) return false;
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened)) return false;
    writeAll(fd, row);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const written = fstatSync(fd);
    const named = lstatSync(path);
    if (!privateFile(written) || !privateFile(named) || !sameNode(opened, written) ||
      !sameNode(written, named) || written.size !== row.length) return false;
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return true;
  } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

/** Remove only known private orphan artifacts before the first head exists. */
function removePrivateOrphan(path: string, directories: DirectoryState): boolean {
  try {
    if (!existsSync(path)) return true;
    verifyDirectories(directories);
    const named = lstatSync(path);
    if (!privateFile(named)) return false;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
    verifyDirectories(directories);
    return true;
  } catch { return false; }
}

function discardUnpublishedGenerationOne(directories: DirectoryState): boolean {
  // No head means no generation-one state was ever released. Discarding the
  // bounded artifacts prevents an interrupted root-required capture from
  // becoming visible on a later retry.
  return [generationOneLedgerPath(), generationOneRootPath(), retentionCertificatePath(), generationIntentPath()]
    .every((path) => removePrivateOrphan(path, directories));
}

function hasGenerationOneArtifacts(): boolean {
  return [generationOneLedgerPath(), generationOneRootPath(), retentionCertificatePath(), generationIntentPath()]
    .some((path) => existsSync(path));
}

function publishGenerationHead(
  legacyRoot: CutoffObservationRootV1,
  activeRoot: CutoffObservationRootV1,
  key: KeyProvider,
  directories: DirectoryState,
): boolean {
  const certificate = buildRetentionCertificate(legacyRoot, activeRoot, key);
  if (!certificate || !writeSignedJson(retentionCertificatePath(), certificate, directories)) return false;
  const head = buildGenerationHead(certificate, key);
  return Boolean(head && writeSignedJson(generationHeadPath(), head, directories));
}

function startGenerationOne(
  snapshot: EnrollmentCutoffSnapshotV2,
  legacyRoot: CutoffObservationRootV1,
  recordedAt: string,
  key: KeyProvider,
  directories: DirectoryState,
  recoveryPolicy?: 'root-required',
  captureAttemptId?: string,
): boolean {
  const building = buildGenerationIntent('building', key);
  if (!building || !writeSignedJson(generationIntentPath(), building, directories)) return false;
  const entry = buildEntry(snapshot, 1, null, recordedAt, key, recoveryPolicy, captureAttemptId);
  if (!entry) return false;
  const row = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
  if (row.length > MAX_ROW_BYTES || !writeFreshLedger(generationOneLedgerPath(), row, directories)) return false;
  const activeRoot = buildRoot(entry, row.length, recordedAt, key);
  if (!activeRoot || !writeRoot(generationOneRootPath(), activeRoot, directories)) return false;
  const committed = buildGenerationIntent('committed', key);
  if (!committed || !writeSignedJson(generationIntentPath(), committed, directories)) return false;
  // The head is published last. Orphan generation files are intentionally invisible.
  return publishGenerationHead(legacyRoot, activeRoot, key, directories);
}

function appendGenerationOne(
  snapshot: EnrollmentCutoffSnapshotV2,
  recordedAt: string,
  key: KeyProvider,
  directories: DirectoryState,
  recoveryPolicy?: 'root-required',
  captureAttemptId?: string,
): 'recorded' | 'replayed' | 'failed' {
  const published = readRotatedCheckpoints(key);
  if (!published || published.sourceState !== 'healthy' || !published.complete) return 'failed';
  const legacy = readReleasedLedger(cutoffObservationCheckpointLedgerPath(), cutoffObservationCheckpointRootPath(), key);
  const active = readReleasedLedger(generationOneLedgerPath(), generationOneRootPath(), key);
  if (!legacy || !active || legacy === 'degraded' || active === 'degraded' || active.entries.length >= MAX_ROWS ||
    legacy.entries.length !== MAX_ROWS) return 'failed';
  const all = [...legacy.entries, ...active.entries];
  if (all.some((candidate) => candidate.snapshot.snapshotDigest === snapshot.snapshotDigest &&
    (!captureAttemptId || candidate.captureAttemptId === captureAttemptId))) return 'replayed';
  const entry = buildEntry(snapshot, active.entries.length + 1,
    active.entries[active.entries.length - 1]?.entryDigest ?? null, recordedAt, key, recoveryPolicy, captureAttemptId);
  if (!entry) return 'failed';
  const row = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
  if (row.length > MAX_ROW_BYTES || active.parsed.bytes.length + row.length > MAX_LEDGER_BYTES) return 'failed';
  let fd: number | undefined;
  try {
    const path = generationOneLedgerPath();
    const named = lstatSync(path);
    if (!privateFile(named)) return 'failed';
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || !sameNode(named, opened) || opened.size !== active.parsed.bytes.length) return 'failed';
    writeAll(fd, row);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== opened.size + row.length) return 'failed';
    const root = buildRoot(entry, persisted.size, recordedAt, key);
    if (!root || !writeRoot(generationOneRootPath(), root, directories) ||
      !publishGenerationHead(legacy.root, root, key, directories)) return 'failed';
    return 'recorded';
  } catch { return 'failed'; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

export function recordCutoffObservationCheckpoint(
  snapshot: EnrollmentCutoffSnapshotV2,
  options: {
    now?: () => string;
    lockWaitMs?: number;
    keyProvider?: KeyProvider;
    recoveryPolicy?: 'root-required';
    captureAttemptId?: string;
  } = {},
): CutoffObservationCheckpointWriteResult {
  const result: CutoffObservationCheckpointWriteResult = {
    attempted: 1, recorded: 0, replayed: 0, recoveredRows: 0, invalid: 0, failed: 0,
  };
  const key = pinKey(options.keyProvider ?? keyProvider);
  if (process.platform === 'win32' || !key || !verifyEnrollmentCutoffSnapshotV2(snapshot, key)) {
    result.invalid = 1;
    return result;
  }
  let directories: DirectoryState;
  try { directories = ensureDirectories(); } catch { result.failed = 1; return result; }
  const waitMs = typeof options.lockWaitMs === 'number' && Number.isFinite(options.lockWaitMs)
    ? Math.max(0, Math.min(2_000, Math.floor(options.lockWaitMs))) : 2_000;
  const lock = acquireLocalStoreLock(lockPath(), waitMs);
  if (!lock) { result.failed = 1; return result; }
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    const publishedHead = readSignedJson(generationHeadPath(), key, verifyGenerationHead);
    const intent = readSignedJson(generationIntentPath(), key, verifyGenerationIntent);
    if (publishedHead === 'io-error' || publishedHead === 'invalid-root') {
      throw new Error('invalid checkpoint generation head');
    }
    if (intent === 'io-error' || intent === 'invalid-root') {
      throw new Error('invalid checkpoint generation intent');
    }
    if (publishedHead) {
      const appended = appendGenerationOne(snapshot, options.now?.() ?? new Date().toISOString(), key,
        directories, options.recoveryPolicy, options.captureAttemptId);
      if (appended === 'recorded') result.recorded = 1;
      else if (appended === 'replayed') result.replayed = 1;
      else result.failed = 1;
      return result;
    }
    if (intent?.phase === 'committed' || (intent === null && hasGenerationOneArtifacts()) ||
      (intent?.phase === 'building' && !discardUnpublishedGenerationOne(directories))) {
      throw new Error('unsafe unpublished checkpoint generation');
    }
    const ledgerPath = cutoffObservationCheckpointLedgerPath();
    const rootPath = cutoffObservationCheckpointRootPath();
    const priorFile = existsSync(ledgerPath) ? lstatSync(ledgerPath) : null;
    if (priorFile && (!privateFile(priorFile) || priorFile.size > MAX_LEDGER_BYTES)) throw new Error('unsafe checkpoint ledger');
    fd = openSync(ledgerPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    const opened = fstatSync(fd);
    if (!privateFile(opened) || (priorFile && !sameNode(priorFile, opened)) || opened.size > MAX_LEDGER_BYTES) {
      throw new Error('unsafe opened checkpoint ledger');
    }
    fchmodSync(fd, 0o600);
    const openedBytes = readOpened(fd, opened.size);
    let root = readRoot(rootPath, key);
    if (root === 'invalid-root' || root === 'io-error') throw new Error('invalid checkpoint root');
    let parsed = parseLedger(openedBytes, key);
    let ledgerSize = opened.size;
    if (parsed.invalid) {
      const recoveryBytes = root?.ledgerBytes ?? 0;
      if (recoveryBytes > openedBytes.length) throw new Error('invalid checkpoint ledger');
      const released = parseLedger(openedBytes.subarray(0, recoveryBytes), key);
      if (released.invalid || (root !== null && (
        released.entries.length !== root.sequence ||
        released.entries[root.sequence - 1]?.entryDigest !== root.entryDigest ||
        released.lineEnds[root.sequence - 1] !== root.ledgerBytes))) {
        throw new Error('invalid checkpoint ledger prefix');
      }
      ftruncateSync(fd, recoveryBytes);
      fsyncSync(fd);
      const truncated = fstatSync(fd);
      const named = lstatSync(ledgerPath);
      if (!privateFile(truncated) || !sameNode(opened, truncated) || truncated.size !== recoveryBytes ||
        !privateFile(named) || !sameNode(truncated, named)) {
        throw new Error('checkpoint tail recovery failed');
      }
      parsed = released;
      ledgerSize = recoveryBytes;
      result.recoveredRows = 1;
    }
    if (parsed.entries.length === 0 && root !== null) throw new Error('orphan checkpoint root');
    if (parsed.entries.length > 0) {
      const last = parsed.entries[parsed.entries.length - 1]!;
      if (root !== null && (root.sequence > parsed.entries.length ||
        parsed.entries[root.sequence - 1]?.entryDigest !== root.entryDigest ||
        parsed.lineEnds[root.sequence - 1] !== root.ledgerBytes)) {
        throw new Error('checkpoint root does not bind ledger');
      }
      if (root === null || root.sequence < parsed.entries.length) {
        const releasedRows = root?.sequence ?? 0;
        const unreleased = parsed.entries.slice(releasedRows);
        if (unreleased.some((entry) => entry.recoveryPolicy === 'root-required')) {
          const recoveryBytes = root?.ledgerBytes ?? 0;
          ftruncateSync(fd, recoveryBytes);
          fsyncSync(fd);
          const truncated = fstatSync(fd);
          const named = lstatSync(ledgerPath);
          if (!privateFile(truncated) || !sameNode(opened, truncated) || truncated.size !== recoveryBytes ||
            !privateFile(named) || !sameNode(truncated, named)) throw new Error('checkpoint root-required recovery failed');
          parsed = parseLedger(openedBytes.subarray(0, recoveryBytes), key);
          ledgerSize = recoveryBytes;
          result.recoveredRows += unreleased.length;
        } else {
          const recoveredRoot = buildRoot(last, parsed.lineEnds[parsed.lineEnds.length - 1]!,
            options.now?.() ?? new Date().toISOString(), key);
          if (!recoveredRoot || !writeRoot(rootPath, recoveredRoot, directories)) throw new Error('checkpoint recovery failed');
          result.recoveredRows += root === null ? parsed.entries.length : parsed.entries.length - root.sequence;
          root = recoveredRoot;
        }
      }
      if (parsed.entries.some((candidate) => candidate.snapshot.snapshotDigest === snapshot.snapshotDigest &&
        (!options.captureAttemptId || candidate.captureAttemptId === options.captureAttemptId))) {
        result.replayed = 1;
        return result;
      }
    }
    if (parsed.entries.length >= MAX_ROWS) {
      if (!root || root.sequence !== MAX_ROWS ||
        !startGenerationOne(snapshot, root, options.now?.() ?? new Date().toISOString(), key,
          directories, options.recoveryPolicy, options.captureAttemptId)) {
        throw new Error('checkpoint rotation failed');
      }
      result.recorded = 1;
      return result;
    }
    const recordedAt = options.now?.() ?? new Date().toISOString();
    const previous = parsed.entries[parsed.entries.length - 1]?.entryDigest ?? null;
    const entry = buildEntry(
      snapshot, parsed.entries.length + 1, previous, recordedAt, key,
      options.recoveryPolicy, options.captureAttemptId,
    );
    if (!entry) { result.invalid = 1; return result; }
    const row = Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8');
    if (row.length > MAX_ROW_BYTES || ledgerSize + row.length > MAX_LEDGER_BYTES) throw new Error('checkpoint limit');
    const stable = fstatSync(fd);
    if (!privateFile(stable) || !sameNode(opened, stable) || stable.size !== ledgerSize) throw new Error('checkpoint ledger moved');
    verifyDirectories(directories);
    writeAll(fd, row);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    if (!privateFile(persisted) || !sameNode(opened, persisted) || persisted.size !== ledgerSize + row.length) {
      throw new Error('checkpoint append was not durable');
    }
    const named = lstatSync(ledgerPath);
    if (!privateFile(named) || !sameNode(persisted, named)) {
      throw new Error('checkpoint ledger pathname changed after append');
    }
    const nextRoot = buildRoot(entry, persisted.size, recordedAt, key);
    if (!nextRoot || !writeRoot(rootPath, nextRoot, directories)) throw new Error('checkpoint root write failed');
    result.recorded = 1;
    return result;
  } catch {
    result.failed = 1;
    return result;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}
