/**
 * Signed, observation-only evidence that merged work remained stable for a
 * bounded window. Cohort manifests are the release boundary: unmanifested
 * witness rows are never returned as usable evidence.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import { fsyncDirectory } from '../util/durability.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/#-]{0,239}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARTITION_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_MEMBERS = 64;
const MAX_ROW_BYTES = 16 * 1024;
const MAX_PARTITION_BYTES = 16 * 1024 * 1024;
const HARD_MAX_FILES = 366;
const HARD_MAX_READ_BYTES = 64 * 1024 * 1024;
const HARD_MAX_ROWS = 100_000;
const MAX_DIRECTORY_ENTRIES = 1_024;
const DEFAULT_MAX_FILES = 90;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ROWS = 25_000;
const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;

const WITNESS_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'witnessId', 'cohortId',
  'repoDigest', 'proposalId', 'mergeCommit', 'observedHead', 'windowStartedAt',
  'stableAt', 'windowMs', 'verificationDigest', 'witnessDigest', 'attestation',
]);
const MEMBER_KEYS = new Set(['witnessId', 'witnessDigest']);
const MANIFEST_KEYS = new Set([
  'schemaVersion', 'recordType', 'authority', 'manifestId', 'cohortId',
  'partitionDate', 'completedAt', 'memberCount', 'members', 'attestation',
]);

export interface PostMergeStabilityWitness {
  schemaVersion: 1;
  recordType: 'stable-after-window';
  authority: 'observation-only';
  witnessId: string;
  cohortId: string;
  repoDigest: string;
  proposalId: string;
  mergeCommit: string;
  observedHead: string;
  windowStartedAt: string;
  stableAt: string;
  windowMs: number;
  verificationDigest: string;
  witnessDigest: string;
  attestation: string;
}

export interface PostMergeStabilityWitnessInput {
  cohortId: string;
  /** Canonicalized and HMAC-pseudonymized; the path is never persisted. */
  repo?: string;
  repoDigest?: string;
  proposalId: string;
  mergeCommit: string;
  observedHead: string;
  windowStartedAt: string;
  stableAt: string;
  windowMs: number;
  verificationDigest: string;
  schemaVersion?: 1;
  recordType?: 'stable-after-window';
  authority?: 'observation-only';
  witnessId?: string;
  witnessDigest?: string;
  attestation?: string;
}

export interface PostMergeStabilityManifestMember {
  witnessId: string;
  witnessDigest: string;
}

export interface PostMergeStabilityCohortManifest {
  schemaVersion: 1;
  recordType: 'cohort-manifest';
  authority: 'observation-only';
  manifestId: string;
  cohortId: string;
  partitionDate: string;
  completedAt: string;
  memberCount: number;
  members: PostMergeStabilityManifestMember[];
  attestation: string;
}

export interface PostMergeStabilityCohortInput {
  cohortId: string;
  completedAt: string;
  witnesses: PostMergeStabilityWitnessInput[];
}

export interface PostMergeStabilityWriteResult {
  attempted: number;
  recorded: number;
  replayed: number;
  conflicted: number;
  invalid: number;
  failed: number;
  witnessesRecorded: number;
}

export type PostMergeStabilityStopReason =
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'row-size'
  | 'invalid-row'
  | 'conflict'
  | 'orphan-witness'
  | 'incomplete-manifest'
  | 'key-unavailable'
  | 'io-error';

export interface PostMergeStabilityReadOptions {
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  requireComplete?: boolean;
  lockWaitMs?: number;
}

export interface PostMergeStabilityReadResult {
  witnesses: PostMergeStabilityWitness[];
  manifests: PostMergeStabilityCohortManifest[];
  cohortSummary: PostMergeStabilityCohortSummary;
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: PostMergeStabilityStopReason[];
  filesRead: number;
  bytesRead: number;
  physicalRows: number;
  invalidRows: number;
  oversizedRows: number;
  orphanWitnesses: number;
  incompleteManifests: number;
  conflictingCohorts: number;
  duplicateRows: number;
  releasedCohorts: number;
  limitExceeded: boolean;
}

/** Compact, metadata-only cohort coverage for observational consumers. */
export interface PostMergeStabilityCohortSummary {
  completeCohorts: number;
  releasedWitnesses: number;
  distinctRepoDigests: number;
  latestCompletedAt?: string;
}

function noControls(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function storageHome(): string {
  const configured = process.env.ASHLR_HOME;
  if (typeof configured === 'string') {
    const trimmed = configured.trim();
    if (trimmed && isAbsolute(trimmed) && noControls(trimmed)) {
      try { return resolve(trimmed); } catch { /* use the private default */ }
    }
  }
  return resolve(join(homedir(), '.ashlr'));
}

export function postMergeStabilityDir(): string {
  return join(storageHome(), 'fleet', 'post-merge-stability');
}

export function postMergeStabilityPartitionPath(partitionDate: string): string {
  if (!validDate(partitionDate)) throw new Error('invalid post-merge stability partition date');
  return join(postMergeStabilityDir(), `${partitionDate}.jsonl`);
}

function lockPath(): string {
  return join(postMergeStabilityDir(), '.post-merge-stability.lock');
}

function exactKeys(row: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const actual = Object.keys(row);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  return canonicalTimestamp(`${value}T00:00:00.000Z`);
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function hmac(key: Buffer, domain: string, tuple: unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, ...tuple]), 'utf8').digest('hex');
}

function existingSigningKey(): Buffer | null {
  try { return loadExistingProvenanceKey(); } catch { return null; }
}

function repoDigest(key: Buffer, repo: string): string | null {
  if (!repo || repo.length > 1_024 || !noControls(repo) || !isAbsolute(repo)) return null;
  try { return hmac(key, 'ashlr:post-merge-stability-repo:v1', [resolve(repo)]); } catch { return null; }
}

/** Pseudonymous repository identity shared by stability producers and readers. */
export function postMergeStabilityRepoDigest(repo: string): string | null {
  const key = existingSigningKey();
  return key ? repoDigest(key, repo) : null;
}

type WitnessIdentity = Pick<PostMergeStabilityWitness,
  'cohortId' | 'repoDigest' | 'proposalId' | 'mergeCommit'>;

export function postMergeStabilityWitnessId(value: WitnessIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:post-merge-stability-witness-id:v1', value.cohortId, value.repoDigest,
    value.proposalId, value.mergeCommit,
  ])).digest('hex');
}

function unsignedWitnessTuple(value: Omit<PostMergeStabilityWitness, 'witnessDigest' | 'attestation'>): unknown[] {
  return [
    value.schemaVersion, value.recordType, value.authority, value.witnessId,
    value.cohortId, value.repoDigest, value.proposalId, value.mergeCommit,
    value.observedHead, value.windowStartedAt, value.stableAt, value.windowMs,
    value.verificationDigest,
  ];
}

function reconstructWitness(value: unknown, persisted: boolean): PostMergeStabilityWitness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (persisted && !exactKeys(row, WITNESS_KEYS)) return null;
  const key = existingSigningKey();
  if (!key) return null;
  let digest: string | null = null;
  if (typeof row['repo'] === 'string') digest = repoDigest(key, row['repo']);
  else if (typeof row['repoDigest'] === 'string' && SHA256_RE.test(row['repoDigest'])) digest = row['repoDigest'];
  if (
    (row['schemaVersion'] !== undefined && row['schemaVersion'] !== 1) ||
    (row['recordType'] !== undefined && row['recordType'] !== 'stable-after-window') ||
    (row['authority'] !== undefined && row['authority'] !== 'observation-only') ||
    !digest || !safeId(row['cohortId']) || !safeId(row['proposalId']) ||
    typeof row['mergeCommit'] !== 'string' || !GIT_SHA_RE.test(row['mergeCommit']) ||
    typeof row['observedHead'] !== 'string' || !GIT_SHA_RE.test(row['observedHead']) ||
    !canonicalTimestamp(row['windowStartedAt']) || !canonicalTimestamp(row['stableAt']) ||
    Date.parse(row['stableAt']) < Date.parse(row['windowStartedAt']) ||
    !Number.isSafeInteger(row['windowMs']) || Number(row['windowMs']) < 1 || Number(row['windowMs']) > MAX_WINDOW_MS ||
    Date.parse(row['stableAt']) - Date.parse(row['windowStartedAt']) < Number(row['windowMs']) ||
    typeof row['verificationDigest'] !== 'string' || !SHA256_RE.test(row['verificationDigest'])
  ) return null;
  const unsigned: Omit<PostMergeStabilityWitness, 'witnessDigest' | 'attestation'> = {
    schemaVersion: 1,
    recordType: 'stable-after-window',
    authority: 'observation-only',
    witnessId: '',
    cohortId: row['cohortId'],
    repoDigest: digest,
    proposalId: row['proposalId'],
    mergeCommit: row['mergeCommit'],
    observedHead: row['observedHead'],
    windowStartedAt: row['windowStartedAt'],
    stableAt: row['stableAt'],
    windowMs: Number(row['windowMs']),
    verificationDigest: row['verificationDigest'],
  };
  unsigned.witnessId = postMergeStabilityWitnessId(unsigned);
  if (row['witnessId'] !== undefined && !equalDigest(String(row['witnessId']), unsigned.witnessId)) return null;
  const witnessDigest = createHash('sha256').update(JSON.stringify([
    'ashlr:post-merge-stability-witness:v1', ...unsignedWitnessTuple(unsigned),
  ])).digest('hex');
  if (row['witnessDigest'] !== undefined && !equalDigest(String(row['witnessDigest']), witnessDigest)) return null;
  const attestation = hmac(key, 'ashlr:post-merge-stability-attestation:v1', [witnessDigest]);
  if (row['attestation'] !== undefined && !equalDigest(String(row['attestation']), attestation)) return null;
  if (persisted && (typeof row['witnessId'] !== 'string' || typeof row['witnessDigest'] !== 'string' ||
      typeof row['attestation'] !== 'string')) return null;
  return { ...unsigned, witnessDigest, attestation };
}

export function buildPostMergeStabilityWitness(input: PostMergeStabilityWitnessInput): PostMergeStabilityWitness | null {
  return reconstructWitness(input, false);
}

export function sanitizePostMergeStabilityWitness(value: unknown): PostMergeStabilityWitness | null {
  return reconstructWitness(value, false);
}

export function verifyPostMergeStabilityWitness(value: unknown): value is PostMergeStabilityWitness {
  return reconstructWitness(value, true) !== null;
}

function canonicalMembers(witnesses: PostMergeStabilityWitness[]): PostMergeStabilityManifestMember[] | null {
  if (witnesses.length < 1 || witnesses.length > MAX_MEMBERS) return null;
  const members = witnesses.map(({ witnessId, witnessDigest }) => ({ witnessId, witnessDigest }))
    .sort((a, b) => a.witnessId.localeCompare(b.witnessId));
  return new Set(members.map((member) => member.witnessId)).size === members.length ? members : null;
}

function manifestId(cohortId: string, _partitionDate: string): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:post-merge-stability-manifest-id:v1', cohortId,
  ])).digest('hex');
}

function reconstructManifest(value: unknown, persisted: boolean): PostMergeStabilityCohortManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (persisted && !exactKeys(row, MANIFEST_KEYS)) return null;
  const key = existingSigningKey();
  if (!key ||
    (row['schemaVersion'] !== undefined && row['schemaVersion'] !== 1) ||
    (row['recordType'] !== undefined && row['recordType'] !== 'cohort-manifest') ||
    (row['authority'] !== undefined && row['authority'] !== 'observation-only') ||
    !safeId(row['cohortId']) || !validDate(row['partitionDate']) || !canonicalTimestamp(row['completedAt']) ||
    row['completedAt'].slice(0, 10) !== row['partitionDate'] ||
    !Number.isSafeInteger(row['memberCount']) || Number(row['memberCount']) < 1 || Number(row['memberCount']) > MAX_MEMBERS ||
    !Array.isArray(row['members']) || row['members'].length !== Number(row['memberCount'])
  ) return null;
  const members: PostMergeStabilityManifestMember[] = [];
  for (const value of row['members']) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const member = value as Record<string, unknown>;
    if ((persisted && !exactKeys(member, MEMBER_KEYS)) || typeof member['witnessId'] !== 'string' ||
      !SHA256_RE.test(member['witnessId']) || typeof member['witnessDigest'] !== 'string' ||
      !SHA256_RE.test(member['witnessDigest'])) return null;
    members.push({ witnessId: member['witnessId'], witnessDigest: member['witnessDigest'] });
  }
  const sorted = [...members].sort((a, b) => a.witnessId.localeCompare(b.witnessId));
  if (new Set(sorted.map((member) => member.witnessId)).size !== sorted.length ||
      JSON.stringify(sorted) !== JSON.stringify(members)) return null;
  const expectedId = manifestId(row['cohortId'], row['partitionDate']);
  if (row['manifestId'] !== undefined && !equalDigest(String(row['manifestId']), expectedId)) return null;
  const unsigned = {
    schemaVersion: 1 as const,
    recordType: 'cohort-manifest' as const,
    authority: 'observation-only' as const,
    manifestId: expectedId,
    cohortId: row['cohortId'],
    partitionDate: row['partitionDate'],
    completedAt: row['completedAt'],
    memberCount: members.length,
    members,
  };
  const attestation = hmac(key, 'ashlr:post-merge-stability-manifest:v1', [
    unsigned.schemaVersion, unsigned.recordType, unsigned.authority, unsigned.manifestId,
    unsigned.cohortId, unsigned.partitionDate, unsigned.completedAt, unsigned.memberCount,
    unsigned.members.map((member) => [member.witnessId, member.witnessDigest]),
  ]);
  if (row['attestation'] !== undefined && !equalDigest(String(row['attestation']), attestation)) return null;
  if (persisted && (typeof row['manifestId'] !== 'string' || typeof row['attestation'] !== 'string')) return null;
  return { ...unsigned, attestation };
}

export function buildPostMergeStabilityCohortManifest(
  cohortId: string,
  completedAt: string,
  witnesses: PostMergeStabilityWitness[],
): PostMergeStabilityCohortManifest | null {
  const members = canonicalMembers(witnesses);
  if (!safeId(cohortId) || !canonicalTimestamp(completedAt) || !members ||
      witnesses.some((witness) => witness.cohortId !== cohortId ||
        Date.parse(witness.stableAt) > Date.parse(completedAt))) return null;
  return reconstructManifest({
    cohortId,
    partitionDate: completedAt.slice(0, 10),
    completedAt,
    memberCount: members.length,
    members,
  }, false);
}

export function verifyPostMergeStabilityCohortManifest(value: unknown): value is PostMergeStabilityCohortManifest {
  return reconstructManifest(value, true) !== null;
}

function owner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function sameNode(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && owner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}
function privateFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && owner(stat.uid) &&
    (process.platform === 'win32' || (stat.mode & 0o077) === 0);
}

interface DirectoryState { home: Stats; fleet: Stats; stability: Stats }

function makePrivateDirectory(path: string): Stats {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const before = lstatSync(path);
  if (!privateDirectory(before)) throw new Error('unsafe post-merge stability directory');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!privateDirectory(after) || !sameNode(before, after)) throw new Error('post-merge stability directory changed');
  return after;
}

function ensureDirectories(): DirectoryState {
  const homePath = storageHome();
  const home = makePrivateDirectory(homePath);
  const fleet = makePrivateDirectory(join(homePath, 'fleet'));
  const stability = makePrivateDirectory(postMergeStabilityDir());
  const currentHome = lstatSync(homePath);
  if (!privateDirectory(currentHome) || !sameNode(home, currentHome)) throw new Error('stability ancestor changed');
  return { home: currentHome, fleet, stability };
}

function inspectDirectories(): DirectoryState | undefined {
  const paths = [storageHome(), join(storageHome(), 'fleet'), postMergeStabilityDir()];
  if (paths.some((path) => !existsSync(path))) return undefined;
  const [home, fleet, stability] = paths.map((path) => lstatSync(path)) as [Stats, Stats, Stats];
  if (![home, fleet, stability].every(privateDirectory)) throw new Error('unsafe post-merge stability directory');
  return { home, fleet, stability };
}

function verifyDirectories(expected: DirectoryState): void {
  const current = inspectDirectories();
  if (!current || !sameNode(current.home, expected.home) || !sameNode(current.fleet, expected.fleet) ||
      !sameNode(current.stability, expected.stability)) throw new Error('post-merge stability directory replaced');
}

function existingFile(path: string): Stats | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!privateFile(stat)) throw new Error('unsafe post-merge stability partition');
  return stat;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('post-merge stability write made no progress');
    offset += written;
  }
}

function readAll(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset);
    if (read <= 0) break;
    offset += read;
  }
  if (offset !== size) throw new Error('short post-merge stability read');
  return bytes;
}

function bounded(value: number | undefined, fallback: number, hard: number, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(zero ? 0 : 1, Math.min(hard, Math.floor(value)));
}

function validateExistingPartition(bytes: Buffer): void {
  if (bytes.length === 0) return;
  if (bytes[bytes.length - 1] !== 0x0a) throw new Error('torn post-merge stability partition');
  const lines = bytes.toString('utf8').slice(0, -1).split('\n');
  if (lines.length >= HARD_MAX_ROWS) throw new Error('post-merge stability row limit');
  for (const line of lines) {
    if (!line || Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) throw new Error('invalid post-merge stability row');
    const value = JSON.parse(line) as unknown;
    if (!verifyPostMergeStabilityWitness(value) && !verifyPostMergeStabilityCohortManifest(value)) {
      throw new Error('invalid post-merge stability row');
    }
  }
}

function appendCohort(
  witnesses: PostMergeStabilityWitness[],
  manifest: PostMergeStabilityCohortManifest,
  waitMs: number,
): 'recorded' | 'replayed' | 'conflicted' | 'failed' {
  const path = postMergeStabilityPartitionPath(manifest.partitionDate);
  let directories: DirectoryState;
  try { directories = ensureDirectories(); existingFile(path); } catch { return 'failed'; }
  const lock = acquireLocalStoreLock(lockPath(), waitMs);
  if (!lock) return 'failed';
  let fd: number | undefined;
  try {
    verifyDirectories(directories);
    const before = existingFile(path);
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    let opened = fstatSync(fd);
    if (!privateFile(opened) || (before && !sameNode(before, opened)) || opened.size > MAX_PARTITION_BYTES) return 'failed';
    fchmodSync(fd, 0o600);
    opened = fstatSync(fd);
    const named = lstatSync(path);
    if (!privateFile(named) || !sameNode(opened, named)) return 'failed';
    verifyDirectories(directories);
    const existing = readAll(fd, opened.size);
    validateExistingPartition(existing);
    const existingRows = existing.length === 0 ? [] : existing.toString('utf8').trimEnd().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const prior = existingRows.filter((row) => row['recordType'] === 'cohort-manifest' && row['cohortId'] === manifest.cohortId)
      .map((row) => reconstructManifest(row, true)).filter((row): row is PostMergeStabilityCohortManifest => row !== null);
    if (prior.some((row) => JSON.stringify(row) === JSON.stringify(manifest))) return 'replayed';
    if (prior.length > 0) return 'conflicted';

    const witnessBytes = witnesses.map((witness) => Buffer.from(`${JSON.stringify(witness)}\n`, 'utf8'));
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8');
    if ([...witnessBytes, manifestBytes].some((row) => row.length > MAX_ROW_BYTES) ||
      opened.size + witnessBytes.reduce((sum, row) => sum + row.length, 0) + manifestBytes.length > MAX_PARTITION_BYTES ||
      existingRows.length + witnesses.length + 1 > HARD_MAX_ROWS) return 'failed';
    const stable = fstatSync(fd);
    if (!privateFile(stable) || !sameNode(stable, opened) || stable.size !== opened.size) return 'failed';
    for (const row of witnessBytes) writeAll(fd, row);
    fsyncSync(fd);
    writeAll(fd, manifestBytes);
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    const expectedSize = opened.size + witnessBytes.reduce((sum, row) => sum + row.length, 0) + manifestBytes.length;
    if (!privateFile(persisted) || !sameNode(persisted, opened) || persisted.size !== expectedSize) return 'failed';
    const current = lstatSync(path);
    if (!privateFile(current) || !sameNode(current, persisted)) return 'failed';
    verifyDirectories(directories);
    fsyncDirectory(postMergeStabilityDir());
    verifyDirectories(directories);
    return 'recorded';
  } catch { return 'failed'; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

export function recordPostMergeStabilityCohort(
  input: PostMergeStabilityCohortInput,
  options: { lockWaitMs?: number } = {},
): PostMergeStabilityWriteResult {
  const result: PostMergeStabilityWriteResult = {
    attempted: 1, recorded: 0, replayed: 0, conflicted: 0, invalid: 0, failed: 0, witnessesRecorded: 0,
  };
  if (!input || !safeId(input.cohortId) || !Array.isArray(input.witnesses) ||
      input.witnesses.length < 1 || input.witnesses.length > MAX_MEMBERS) {
    result.invalid = 1;
    return result;
  }
  if (!existingSigningKey()) { result.failed = 1; return result; }
  if (input.witnesses.some((candidate) => candidate?.cohortId !== input.cohortId)) {
    result.invalid = 1;
    return result;
  }
  const witnesses = input.witnesses.map((candidate) => buildPostMergeStabilityWitness({
    ...candidate,
    cohortId: input.cohortId,
  }));
  if (witnesses.some((witness) => witness === null)) { result.invalid = 1; return result; }
  const valid = witnesses as PostMergeStabilityWitness[];
  const manifest = buildPostMergeStabilityCohortManifest(input.cohortId, input.completedAt, valid);
  if (!manifest || valid.some((witness) => witness.stableAt.slice(0, 10) !== manifest.partitionDate)) {
    result.invalid = 1;
    return result;
  }
  const disposition = appendCohort(valid, manifest, bounded(options.lockWaitMs, 2_000, 2_000, true));
  result[disposition] = 1;
  if (disposition === 'recorded') result.witnessesRecorded = valid.length;
  return result;
}

function emptyRead(state: PostMergeStabilityReadResult['sourceState'], overrides: Partial<PostMergeStabilityReadResult> = {}): PostMergeStabilityReadResult {
  return {
    witnesses: [], manifests: [], cohortSummary: {
      completeCohorts: 0, releasedWitnesses: 0, distinctRepoDigests: 0,
    }, sourceState: state, sourcePresent: state !== 'missing',
    complete: state !== 'degraded', stopReasons: [], filesRead: 0, bytesRead: 0,
    physicalRows: 0, invalidRows: 0, oversizedRows: 0, orphanWitnesses: 0,
    incompleteManifests: 0, conflictingCohorts: 0, duplicateRows: 0,
    releasedCohorts: 0, limitExceeded: false, ...overrides,
  };
}

interface LocatedWitness { row: PostMergeStabilityWitness; file: string; order: number }
interface LocatedManifest { row: PostMergeStabilityCohortManifest; file: string; order: number }

function discoverPartitions(): { files: string[]; overflow: boolean; unsafe: boolean } {
  const dir = opendirSync(postMergeStabilityDir());
  const files: string[] = [];
  let entries = 0;
  try {
    while (true) {
      const entry = dir.readSync();
      if (!entry) break;
      entries += 1;
      if (entries > MAX_DIRECTORY_ENTRIES) return { files, overflow: true, unsafe: false };
      if (entry.isFile() && PARTITION_RE.test(entry.name)) files.push(entry.name);
      else if (entry.name !== '.post-merge-stability.lock') return { files, overflow: false, unsafe: true };
    }
  } finally { dir.closeSync(); }
  files.sort();
  return { files, overflow: false, unsafe: false };
}

export function readPostMergeStability(
  options: PostMergeStabilityReadOptions = {},
): PostMergeStabilityReadResult {
  let directories: DirectoryState | undefined;
  try { directories = inspectDirectories(); } catch {
    return emptyRead('degraded', { complete: false, stopReasons: ['io-error'] });
  }
  if (!directories) return emptyRead('missing', { sourcePresent: false });
  const lock = acquireLocalStoreLock(lockPath(), bounded(options.lockWaitMs, 2_000, 2_000, true));
  if (!lock) return emptyRead('degraded', { complete: false, stopReasons: ['io-error'] });
  try {
    verifyDirectories(directories);
    const discovered = discoverPartitions();
    if (discovered.unsafe) return emptyRead('degraded', {
      complete: false, stopReasons: ['io-error'], sourcePresent: true,
    });
    if (discovered.overflow) return emptyRead('degraded', {
      complete: false, stopReasons: ['file-limit'], sourcePresent: true, limitExceeded: true,
    });
    if (discovered.files.length === 0) return emptyRead('missing', { sourcePresent: false });
    if (!existingSigningKey()) return emptyRead('degraded', {
      sourcePresent: true, complete: false, stopReasons: ['key-unavailable'],
    });
    const maxFiles = bounded(options.maxFiles, DEFAULT_MAX_FILES, HARD_MAX_FILES, true);
    const maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_READ_BYTES, true);
    const maxRows = bounded(options.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS, true);
    const stops = new Set<PostMergeStabilityStopReason>();
    let files = discovered.files;
    if (files.length > maxFiles) {
      files = maxFiles === 0 ? [] : files.slice(-maxFiles);
      stops.add('file-limit');
    }
    const witnesses: LocatedWitness[] = [];
    const manifests: LocatedManifest[] = [];
    let bytesRead = 0;
    let physicalRows = 0;
    let invalidRows = 0;
    let oversizedRows = 0;
    let filesRead = 0;
    for (const file of files) {
      const path = join(postMergeStabilityDir(), file);
      const before = existingFile(path);
      if (!before) { stops.add('io-error'); continue; }
      if (bytesRead + before.size > maxBytes || before.size > MAX_PARTITION_BYTES) { stops.add('byte-limit'); break; }
      let fd: number | undefined;
      try {
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (!privateFile(opened) || !sameNode(opened, before)) throw new Error('partition changed');
        const bytes = readAll(fd, opened.size);
        filesRead += 1;
        bytesRead += bytes.length;
        const text = bytes.toString('utf8');
        const torn = text.length > 0 && !text.endsWith('\n');
        const lines = text.length === 0 ? [] : (torn ? text.split('\n') : text.slice(0, -1).split('\n'));
        for (let order = 0; order < lines.length; order += 1) {
          const line = lines[order]!;
          if (!line) continue;
          physicalRows += 1;
          if (physicalRows > maxRows || physicalRows > HARD_MAX_ROWS) { stops.add('row-limit'); break; }
          if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) { oversizedRows += 1; stops.add('row-size'); continue; }
          try {
            const value = JSON.parse(line) as unknown;
            const witness = reconstructWitness(value, true);
            if (witness) witnesses.push({ row: witness, file, order });
            else {
              const manifest = reconstructManifest(value, true);
              if (manifest && manifest.partitionDate === file.slice(0, 10)) manifests.push({ row: manifest, file, order });
              else { invalidRows += 1; stops.add('invalid-row'); }
            }
          } catch { invalidRows += 1; stops.add('invalid-row'); }
        }
        if (torn) { physicalRows += 1; invalidRows += 1; stops.add('invalid-row'); }
        const after = fstatSync(fd);
        const named = lstatSync(path);
        if (!privateFile(after) || !privateFile(named) || !sameNode(after, opened) ||
            !sameNode(named, opened) || after.size !== opened.size) throw new Error('partition changed');
      } catch { stops.add('io-error'); }
      finally { if (fd !== undefined) { try { closeSync(fd); } catch { stops.add('io-error'); } } }
      if (stops.has('row-limit')) break;
    }

    const witnessById = new Map<string, LocatedWitness[]>();
    for (const witness of witnesses) witnessById.set(witness.row.witnessId, [...(witnessById.get(witness.row.witnessId) ?? []), witness]);
    const manifestById = new Map<string, LocatedManifest[]>();
    for (const manifest of manifests) manifestById.set(manifest.row.cohortId, [...(manifestById.get(manifest.row.cohortId) ?? []), manifest]);
    let duplicateRows = 0;
    let conflictingCohorts = 0;
    const releasedWitnesses = new Map<string, PostMergeStabilityWitness>();
    const releasedManifests: PostMergeStabilityCohortManifest[] = [];
    const consumedLocations = new Set<string>();
    let incompleteManifests = 0;
    for (const candidates of manifestById.values()) {
      const fingerprints = new Map(candidates.map((candidate) => [JSON.stringify(candidate.row), candidate]));
      duplicateRows += candidates.length - fingerprints.size;
      if (fingerprints.size !== 1) { conflictingCohorts += 1; stops.add('conflict'); continue; }
      const located = [...fingerprints.values()][0]!;
      const selected: LocatedWitness[] = [];
      let complete = true;
      for (const member of located.row.members) {
        const rows = (witnessById.get(member.witnessId) ?? []).filter((candidate) =>
          candidate.file === located.file && candidate.order < located.order &&
          candidate.row.cohortId === located.row.cohortId && equalDigest(candidate.row.witnessDigest, member.witnessDigest));
        const rowFingerprints = new Map(rows.map((candidate) => [JSON.stringify(candidate.row), candidate]));
        duplicateRows += rows.length - rowFingerprints.size;
        if (rowFingerprints.size !== 1) { complete = false; break; }
        selected.push([...rowFingerprints.values()][0]!);
      }
      if (!complete || selected.length !== located.row.memberCount) {
        incompleteManifests += 1;
        stops.add('incomplete-manifest');
        continue;
      }
      releasedManifests.push(located.row);
      for (const witness of selected) {
        releasedWitnesses.set(witness.row.witnessId, witness.row);
        for (const duplicate of witnessById.get(witness.row.witnessId) ?? []) {
          if (duplicate.file === located.file && duplicate.order < located.order &&
              duplicate.row.cohortId === located.row.cohortId &&
              equalDigest(duplicate.row.witnessDigest, witness.row.witnessDigest)) {
            consumedLocations.add(`${duplicate.file}:${duplicate.order}`);
          }
        }
      }
    }
    const orphanWitnesses = witnesses.filter((witness) => !consumedLocations.has(`${witness.file}:${witness.order}`)).length;
    if (orphanWitnesses > 0) stops.add('orphan-witness');
    const degraded = stops.size > 0;
    const requireComplete = options.requireComplete === true && degraded;
    const outputWitnesses = requireComplete ? [] : [...releasedWitnesses.values()].sort((a, b) => Date.parse(b.stableAt) - Date.parse(a.stableAt));
    const outputManifests = requireComplete ? [] : releasedManifests.sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
    const cohortSummary: PostMergeStabilityCohortSummary = {
      completeCohorts: outputManifests.length,
      releasedWitnesses: outputWitnesses.length,
      distinctRepoDigests: new Set(outputWitnesses.map((witness) => witness.repoDigest)).size,
      ...(outputManifests[0] ? { latestCompletedAt: outputManifests[0].completedAt } : {}),
    };
    return {
      witnesses: outputWitnesses,
      manifests: outputManifests,
      cohortSummary,
      sourceState: degraded ? 'degraded' : 'healthy',
      sourcePresent: true,
      complete: !degraded,
      stopReasons: [...stops],
      filesRead,
      bytesRead,
      physicalRows,
      invalidRows,
      oversizedRows,
      orphanWitnesses,
      incompleteManifests,
      conflictingCohorts,
      duplicateRows,
      releasedCohorts: requireComplete ? 0 : outputManifests.length,
      limitExceeded: stops.has('file-limit') || stops.has('byte-limit') || stops.has('row-limit') || stops.has('row-size'),
    };
  } catch {
    return emptyRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'] });
  } finally { releaseLocalStoreLock(lock); }
}

export const readPostMergeStabilityDetailed = readPostMergeStability;
