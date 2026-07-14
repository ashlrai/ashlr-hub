import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  acquireLocalStoreLock,
  ownsLocalStoreLock,
  releaseLocalStoreLock,
  type LocalStoreLock,
} from '../fleet/local-store-lock.js';
import {
  loadExistingProvenanceKeyReadOnly,
  loadExistingProvenanceKey,
  loadOrCreateKey,
  provenanceKeyPath,
} from '../foundry/provenance.js';
import { assurePrivateStoragePath, assurePrivateStoragePaths } from './private-storage.js';

const SCHEMA_VERSION = 1 as const;
const EFFECT_DOMAIN = 'ashlr:tool-effect:v1';
const ATTESTATION_DOMAIN = 'ashlr:tool-effect-attestation:v1';
const PACK_ID_DOMAIN = 'ashlr:tool-effect-terminal-pack-id:v1';
const PACK_COMMIT_DOMAIN = 'ashlr:tool-effect-terminal-pack-commit:v1';
const FORMAT_FLOOR_DOMAIN = 'ashlr:tool-effect-terminal-pack-format:v2';
const PACK_BLOOM_DOMAIN = 'ashlr:tool-effect-terminal-pack-bloom:v1';
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/;
const MAX_RECORD_BYTES = 2_048;
const MAX_RECORDS = 25_000;
const MAX_PACK_ENTRIES = 200;
const MAX_PACKS = 512;
const MAX_UNDERFILLED_PACKS = 8;
const PACK_BLOOM_BYTES = 256;
const PACK_BLOOM_HASHES = 4;
const MAX_LOGICAL_RECORDS = MAX_RECORDS + MAX_PACKS * MAX_PACK_ENTRIES;
const MAX_PACK_BYTES = 1024 * 1024;
const MAX_PACKED_BYTES = 512 * 1024 * 1024;
const MAX_PACK_COMMIT_BYTES = 2_048;
const MAX_PACK_CANDIDATES = 32;
const MAX_DIRECTORY_ENTRIES = MAX_RECORDS * 2 + MAX_PACKS * 2 + MAX_PACK_CANDIDATES + 64;
const PACK_SEQUENCE_WIDTH = 12;
const ZERO_DIGEST = '0'.repeat(64);
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_OUTCOME_BYTES = 1024 * 1024;
const MAX_ARGUMENT_NODES = 10_000;
const MAX_ARGUMENT_DEPTH = 32;
const LOCK_WAIT_MS = 2_000;
const LIVE_OWNER_PROBE_WAIT_MS = 0;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const O_DIRECTORY = typeof fsConstants.O_DIRECTORY === 'number' ? fsConstants.O_DIRECTORY : 0;
const processObservedEffects = new Set<string>();
const processUncertainEffects = new Set<string>();

export type EffectSafety = 'append' | 'proposal' | 'write' | 'exec';
export type EffectResolution = 'attested-committed' | 'attested-no-effect' | 'abandoned';

interface PreparedEffectRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  effectId: string;
  scopeHash: string;
  generationHash: string;
  taskHash: string;
  ordinal: number;
  toolName: string;
  toolCallHash: string;
  argumentDigest: string;
  safety: EffectSafety;
  identityPolicy: 'generation-bound' | 'scope-bound';
  phase: 'prepared';
  ownerHash: string;
  revision: 1;
  preparedAt: string;
  attestation: string;
}

interface CommittedEffectRecord extends Omit<PreparedEffectRecord, 'phase' | 'revision' | 'attestation'> {
  phase: 'committed';
  revision: 2;
  committedAt: string;
  outcomeDigest: string;
  preparedAttestation: string;
  attestation: string;
}

interface ResolvedEffectRecord extends Omit<PreparedEffectRecord, 'phase' | 'revision' | 'attestation'> {
  phase: 'resolved';
  revision: 2;
  resolution: EffectResolution;
  resolvedAt: string;
  evidenceDigest: string;
  preparedAttestation: string;
  attestation: string;
}

export type EffectRecord = PreparedEffectRecord | CommittedEffectRecord | ResolvedEffectRecord;
type TerminalEffectRecord = CommittedEffectRecord | ResolvedEffectRecord;

interface TerminalPackEntry {
  prepared: PreparedEffectRecord;
  terminal: TerminalEffectRecord;
}

interface TerminalPackRecord {
  schemaVersion: 1;
  recordType: 'terminal-pack';
  packId: string;
  createdAt: string;
  entries: TerminalPackEntry[];
}

interface TerminalPackCommitRecord {
  schemaVersion: 1;
  recordType: 'terminal-pack-commit';
  sequence: number;
  packId: string;
  packDigest: string;
  packBytes: number;
  entryCount: number;
  scopeBloom: string;
  effectBloom: string;
  previousCommitAttestation: string;
  committedAt: string;
  attestation: string;
}

interface TerminalPackFormatFloor {
  schemaVersion: 2;
  recordType: 'effect-terminal-pack-format';
  createdAt: string;
  attestation: string;
}

export interface ToolEffectInput {
  scopeId: string;
  generation: string;
  taskId: string;
  ordinal: number;
  toolName: string;
  toolCallId: string;
  arguments: unknown;
  safety: EffectSafety;
}

export interface PreparedToolEffect {
  effectId: string;
  scopeHash: string;
  generationHash: string;
  ownerToken: string;
  recordPath: string;
  liveLock: LocalStoreLock;
}

export type PrepareToolEffectResult =
  | { ok: true; effect: PreparedToolEffect }
  | { ok: false; reason: 'duplicate' | 'invalid' | 'capacity' | 'unavailable'; phase?: EffectRecord['phase'] };

export interface EffectJournalReadResult {
  records: EffectRecord[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  invalidRecords: number;
  limitExceeded: boolean;
}

export interface EffectJournalCompactionResult {
  ok: boolean;
  reason: 'compacted' | 'nothing-to-compact' | 'unsupported' | 'degraded' | 'capacity';
  packedRecords: number;
  looseRecordsRemoved: number;
  packId?: string;
}

interface JournalDirectory {
  path: string;
  dev: number;
  ino: number;
}

function owned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function stateRoot(): string {
  return join(homedir(), '.ashlr');
}

export function effectJournalDirectory(): string {
  return join(stateRoot(), 'effect-journal');
}

/** Windows cannot currently prove durable installation of a new directory entry through Node. */
export function effectJournalExecutionSupported(): boolean {
  return process.platform !== 'win32';
}

/** Packed authority requires durable directory-entry ordering and cleanup. */
export function effectJournalCompactionSupported(): boolean {
  return process.platform !== 'win32';
}

function hash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function safeId(value: string): boolean {
  return typeof value === 'string' && SAFE_ID_RE.test(value);
}

function boundedOpaqueId(value: unknown, maxBytes = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function canonicalArguments(value: unknown): string | null {
  let nodes = 0;
  let bytes = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) throw new Error('argument bound');
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('non-finite argument');
      return candidate;
    }
    if (typeof candidate === 'string') {
      bytes += Buffer.byteLength(candidate, 'utf8');
      if (bytes > MAX_ARGUMENT_BYTES) throw new Error('argument bound');
      return candidate;
    }
    if (Array.isArray(candidate)) {
      const output: unknown[] = [];
      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('accessor argument');
        output.push(visit(descriptor.value, depth + 1));
      }
      return output;
    }
    if (typeof candidate !== 'object' || candidate === undefined) throw new Error('unsupported argument');
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain argument');
    const source = candidate as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      bytes += Buffer.byteLength(key, 'utf8');
      if (bytes > MAX_ARGUMENT_BYTES) throw new Error('argument bound');
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('accessor argument');
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };

  try {
    const encoded = JSON.stringify(visit(value, 0));
    return Buffer.byteLength(encoded, 'utf8') <= MAX_ARGUMENT_BYTES ? encoded : null;
  } catch {
    return null;
  }
}

function effectIdentity(value: unknown): {
  effectId: string;
  scopeHash: string;
  generationHash: string;
  taskHash: string;
  toolCallHash: string;
  argumentDigest: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as ToolEffectInput;
  if (
    !safeId(input.scopeId) || !safeId(input.generation) || !boundedOpaqueId(input.taskId) ||
    !safeId(input.toolName) || !boundedOpaqueId(input.toolCallId) ||
    !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || input.ordinal > 1_000_000 ||
    (input.safety !== 'append' && input.safety !== 'proposal' && input.safety !== 'write' && input.safety !== 'exec')
  ) return null;
  const canonical = canonicalArguments(input.arguments);
  if (canonical === null) return null;
  const scopeHash = hash([EFFECT_DOMAIN, 'scope', input.scopeId.toLowerCase()]);
  const generationHash = hash([EFFECT_DOMAIN, 'generation', input.generation]);
  const taskHash = hash([EFFECT_DOMAIN, 'task', input.taskId]);
  const toolCallHash = hash([EFFECT_DOMAIN, 'tool-call', input.toolCallId]);
  const argumentDigest = createHash('sha256').update(canonical).digest('hex');
  return {
    effectId: hash([
      EFFECT_DOMAIN,
      scopeHash,
      ...(input.safety === 'write' ? [generationHash] : []),
      input.toolName,
      argumentDigest,
    ]),
    scopeHash,
    generationHash,
    taskHash,
    toolCallHash,
    argumentDigest,
  };
}

function attestationKey(createKey: boolean): Buffer | null {
  try {
    if (!createKey) return loadExistingProvenanceKeyReadOnly();
    const candidate = loadOrCreateKey();
    const assurance = assurePrivateStoragePath(
      provenanceKeyPath(),
      'file',
      'inspect-existing',
      { anchorPath: stateRoot() },
    );
    if (!assurance.ok) return null;
    const durable = loadExistingProvenanceKey();
    if (!durable || durable.length !== candidate.length || !timingSafeEqual(durable, candidate)) return null;
    if (!fsyncDirectory(dirname(provenanceKeyPath()))) return null;
    return durable;
  } catch {
    return null;
  }
}

function domainAttestation(
  domain: string,
  value: unknown,
  createKey = false,
  suppliedKey?: Buffer,
): string | null {
  try {
    const key = suppliedKey ?? attestationKey(createKey);
    if (!key) return null;
    return createHmac('sha256', key)
      .update(JSON.stringify([domain, value]))
      .digest('hex');
  } catch {
    return null;
  }
}

function recordAttestation(
  record: Omit<EffectRecord, 'attestation'>,
  createKey = false,
  suppliedKey?: Buffer,
): string | null {
  return domainAttestation(ATTESTATION_DOMAIN, record, createKey, suppliedKey);
}

function equalDigest(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function expectedKeys(phase: EffectRecord['phase']): string[] {
  const base = [
    'argumentDigest', 'attestation', 'effectId', 'generationHash', 'identityPolicy', 'ordinal', 'ownerHash',
    'phase', 'preparedAt', 'revision', 'safety', 'schemaVersion', 'scopeHash', 'taskHash',
    'toolCallHash', 'toolName',
  ];
  if (phase === 'committed') base.push('committedAt', 'outcomeDigest');
  if (phase === 'committed') base.push('preparedAttestation');
  if (phase === 'resolved') base.push('evidenceDigest', 'preparedAttestation', 'resolution', 'resolvedAt');
  return base.sort();
}

function strictRecord(value: unknown, key?: Buffer): EffectRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const phase = row['phase'];
  if (phase !== 'prepared' && phase !== 'committed' && phase !== 'resolved') return null;
  if (Object.keys(row).sort().join(',') !== expectedKeys(phase).join(',')) return null;
  if (
    row['schemaVersion'] !== SCHEMA_VERSION ||
    typeof row['effectId'] !== 'string' || !SHA256_RE.test(row['effectId']) ||
    typeof row['scopeHash'] !== 'string' || !SHA256_RE.test(row['scopeHash']) ||
    typeof row['generationHash'] !== 'string' || !SHA256_RE.test(row['generationHash']) ||
    typeof row['taskHash'] !== 'string' || !SHA256_RE.test(row['taskHash']) ||
    typeof row['toolCallHash'] !== 'string' || !SHA256_RE.test(row['toolCallHash']) ||
    typeof row['argumentDigest'] !== 'string' || !SHA256_RE.test(row['argumentDigest']) ||
    typeof row['ownerHash'] !== 'string' || !SHA256_RE.test(row['ownerHash']) ||
    typeof row['attestation'] !== 'string' || !SHA256_RE.test(row['attestation']) ||
    typeof row['toolName'] !== 'string' || !safeId(row['toolName']) ||
    (row['safety'] !== 'append' && row['safety'] !== 'proposal' && row['safety'] !== 'write' && row['safety'] !== 'exec') ||
    (row['identityPolicy'] !== 'generation-bound' && row['identityPolicy'] !== 'scope-bound') ||
    ((row['safety'] === 'write') !== (row['identityPolicy'] === 'generation-bound')) ||
    !Number.isSafeInteger(row['ordinal']) || Number(row['ordinal']) < 1 ||
    !canonicalTimestamp(row['preparedAt']) ||
    (phase === 'prepared' ? row['revision'] !== 1 : row['revision'] !== 2)
  ) return null;
  if (
    phase === 'committed' &&
    (!canonicalTimestamp(row['committedAt']) || typeof row['outcomeDigest'] !== 'string' || !SHA256_RE.test(row['outcomeDigest']) ||
      typeof row['preparedAttestation'] !== 'string' || !SHA256_RE.test(row['preparedAttestation']))
  ) return null;
  if (
    phase === 'resolved' &&
    (row['resolution'] !== 'attested-committed' && row['resolution'] !== 'attested-no-effect' && row['resolution'] !== 'abandoned' ||
      !canonicalTimestamp(row['resolvedAt']) || typeof row['evidenceDigest'] !== 'string' || !SHA256_RE.test(row['evidenceDigest']))
  ) return null;
  if (phase === 'resolved' && (typeof row['preparedAttestation'] !== 'string' || !SHA256_RE.test(row['preparedAttestation']))) return null;
  const recomputedEffectId = hash([
    EFFECT_DOMAIN,
    row['scopeHash'],
    ...(row['identityPolicy'] === 'generation-bound' ? [row['generationHash']] : []),
    row['toolName'],
    row['argumentDigest'],
  ]);
  if (!equalDigest(String(row['effectId']), recomputedEffectId)) return null;
  const { attestation, ...unsigned } = row;
  const expected = recordAttestation(unsigned as unknown as Omit<EffectRecord, 'attestation'>, false, key);
  return expected && equalDigest(attestation as string, expected) ? row as unknown as EffectRecord : null;
}

const PACK_LINEAGE_KEYS = [
  'schemaVersion', 'effectId', 'scopeHash', 'generationHash', 'taskHash', 'ordinal', 'toolName',
  'toolCallHash', 'argumentDigest', 'safety', 'identityPolicy', 'ownerHash', 'preparedAt',
] as const;

function samePackLineage(prepared: PreparedEffectRecord, terminal: TerminalEffectRecord): boolean {
  return terminal.preparedAttestation === prepared.attestation &&
    PACK_LINEAGE_KEYS.every((key) => terminal[key] === prepared[key]);
}

function terminalPackId(createdAt: string, entries: TerminalPackEntry[]): string {
  return hash([
    PACK_ID_DOMAIN,
    createdAt,
    entries.map((entry) => [
      entry.prepared.scopeHash,
      entry.prepared.effectId,
      entry.prepared.attestation,
      entry.terminal.attestation,
    ]),
  ]);
}

function packBloom(values: string[]): string {
  const bloom = Buffer.alloc(PACK_BLOOM_BYTES);
  for (const value of values) {
    const digest = createHash('sha256')
      .update(JSON.stringify([PACK_BLOOM_DOMAIN, value]))
      .digest();
    for (let index = 0; index < PACK_BLOOM_HASHES; index += 1) {
      const bit = digest.readUInt32BE(index * 4) % (PACK_BLOOM_BYTES * 8);
      bloom[Math.floor(bit / 8)]! |= 1 << (bit % 8);
    }
  }
  return bloom.toString('base64');
}

function strictPackBloom(value: unknown): string | null {
  if (typeof value !== 'string' || value.length !== Math.ceil(PACK_BLOOM_BYTES / 3) * 4) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === PACK_BLOOM_BYTES && bytes.toString('base64') === value ? value : null;
  } catch { return null; }
}

function packBloomMayContain(encoded: string, value: string): boolean {
  const bloom = Buffer.from(encoded, 'base64');
  const digest = createHash('sha256')
    .update(JSON.stringify([PACK_BLOOM_DOMAIN, value]))
    .digest();
  for (let index = 0; index < PACK_BLOOM_HASHES; index += 1) {
    const bit = digest.readUInt32BE(index * 4) % (PACK_BLOOM_BYTES * 8);
    if ((bloom[Math.floor(bit / 8)]! & (1 << (bit % 8))) === 0) return false;
  }
  return true;
}

function strictTerminalPack(value: unknown, key: Buffer): TerminalPackRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'createdAt,entries,packId,recordType,schemaVersion') return null;
  if (
    row['schemaVersion'] !== 1 || row['recordType'] !== 'terminal-pack' ||
    typeof row['packId'] !== 'string' || !SHA256_RE.test(row['packId']) ||
    !canonicalTimestamp(row['createdAt']) || !Array.isArray(row['entries']) ||
    row['entries'].length < 1 || row['entries'].length > MAX_PACK_ENTRIES
  ) return null;
  const entries: TerminalPackEntry[] = [];
  let previousKey = '';
  for (const candidate of row['entries']) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const pair = candidate as Record<string, unknown>;
    if (Object.keys(pair).sort().join(',') !== 'prepared,terminal') return null;
    const prepared = strictRecord(pair['prepared'], key);
    const terminal = strictRecord(pair['terminal'], key);
    if (!prepared || prepared.phase !== 'prepared' || !terminal || terminal.phase === 'prepared') return null;
    if (!samePackLineage(prepared, terminal)) return null;
    const entryKey = `${prepared.scopeHash}:${prepared.effectId}`;
    if (entryKey <= previousKey) return null;
    previousKey = entryKey;
    entries.push({ prepared, terminal });
  }
  const createdAt = String(row['createdAt']);
  return equalDigest(String(row['packId']), terminalPackId(createdAt, entries))
    ? { schemaVersion: 1, recordType: 'terminal-pack', packId: String(row['packId']), createdAt, entries }
    : null;
}

function packCommitAttestation(
  record: Omit<TerminalPackCommitRecord, 'attestation'>,
  createKey = false,
  key?: Buffer,
): string | null {
  return domainAttestation(PACK_COMMIT_DOMAIN, record, createKey, key);
}

function strictPackCommit(value: unknown, key: Buffer): TerminalPackCommitRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const expectedKeys = [
    'attestation', 'committedAt', 'effectBloom', 'entryCount', 'packBytes', 'packDigest', 'packId',
    'previousCommitAttestation', 'recordType', 'schemaVersion', 'sequence',
    'scopeBloom',
  ].sort().join(',');
  if (Object.keys(row).sort().join(',') !== expectedKeys) return null;
  if (
    row['schemaVersion'] !== 1 || row['recordType'] !== 'terminal-pack-commit' ||
    !Number.isSafeInteger(row['sequence']) || Number(row['sequence']) < 1 || Number(row['sequence']) > MAX_PACKS ||
    typeof row['packId'] !== 'string' || !SHA256_RE.test(row['packId']) ||
    typeof row['packDigest'] !== 'string' || !SHA256_RE.test(row['packDigest']) ||
    typeof row['previousCommitAttestation'] !== 'string' || !SHA256_RE.test(row['previousCommitAttestation']) ||
    typeof row['attestation'] !== 'string' || !SHA256_RE.test(row['attestation']) ||
    !Number.isSafeInteger(row['packBytes']) || Number(row['packBytes']) < 2 || Number(row['packBytes']) > MAX_PACK_BYTES ||
    !Number.isSafeInteger(row['entryCount']) || Number(row['entryCount']) < 1 || Number(row['entryCount']) > MAX_PACK_ENTRIES ||
    strictPackBloom(row['scopeBloom']) === null || strictPackBloom(row['effectBloom']) === null ||
    !canonicalTimestamp(row['committedAt'])
  ) return null;
  const { attestation, ...unsigned } = row;
  const expected = packCommitAttestation(
    unsigned as unknown as Omit<TerminalPackCommitRecord, 'attestation'>,
    false,
    key,
  );
  return expected && equalDigest(String(attestation), expected)
    ? row as unknown as TerminalPackCommitRecord
    : null;
}

function formatFloorAttestation(
  record: Omit<TerminalPackFormatFloor, 'attestation'>,
  createKey = false,
  key?: Buffer,
): string | null {
  return domainAttestation(FORMAT_FLOOR_DOMAIN, record, createKey, key);
}

function strictFormatFloor(value: unknown, key: Buffer): TerminalPackFormatFloor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'attestation,createdAt,recordType,schemaVersion') return null;
  if (
    row['schemaVersion'] !== 2 || row['recordType'] !== 'effect-terminal-pack-format' ||
    !canonicalTimestamp(row['createdAt']) || typeof row['attestation'] !== 'string' || !SHA256_RE.test(row['attestation'])
  ) return null;
  const { attestation, ...unsigned } = row;
  const expected = formatFloorAttestation(
    unsigned as unknown as Omit<TerminalPackFormatFloor, 'attestation'>,
    false,
    key,
  );
  return expected && equalDigest(String(attestation), expected)
    ? row as unknown as TerminalPackFormatFloor
    : null;
}

function ensureDirectory(): JournalDirectory {
  const root = stateRoot();
  mkdirSync(root, { mode: 0o700, recursive: true });
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !owned(rootStat.uid)) {
    throw new Error('unsafe Ashlr state root for effect journal');
  }
  chmodSync(root, 0o700);
  const path = effectJournalDirectory();
  mkdirSync(path, { mode: 0o700, recursive: true });
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid)) {
    throw new Error('unsafe effect journal directory');
  }
  chmodSync(path, 0o700);
  const assurance = assurePrivateStoragePath(path, 'directory', 'secure-created', { anchorPath: root });
  if (!assurance.ok) throw new Error(`unable to secure effect journal directory: ${assurance.reason}`);
  const after = lstatSync(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) {
    throw new Error('effect journal directory changed during validation');
  }
  return { path, dev: after.dev, ino: after.ino };
}

function sameDirectory(directory: JournalDirectory): boolean {
  try {
    const stat = lstatSync(directory.path);
    return !stat.isSymbolicLink() && stat.isDirectory() && owned(stat.uid) &&
      stat.dev === directory.dev && stat.ino === directory.ino;
  } catch {
    return false;
  }
}

function recordPath(directory: JournalDirectory, scopeHash: string, effectId: string): string {
  return join(directory.path, `.effect-v1-${scopeHash}-${effectId}.json`);
}

function terminalPath(directory: JournalDirectory, scopeHash: string, effectId: string): string {
  return join(directory.path, `.terminal-v1-${scopeHash}-${effectId}.json`);
}

function terminalPackPath(directory: JournalDirectory, packId: string): string {
  return join(directory.path, `.terminal-pack-v1-${packId}.json`);
}

function terminalPackCommitPath(directory: JournalDirectory, sequence: number, packId: string): string {
  return join(
    directory.path,
    `.terminal-pack-commit-v1-${String(sequence).padStart(PACK_SEQUENCE_WIDTH, '0')}-${packId}.json`,
  );
}

function terminalPackFormatFloorPath(directory: JournalDirectory): string {
  return join(directory.path, '.format-v2-effect-terminal-packs.json');
}

function journalLockPath(directory: JournalDirectory): string {
  return join(directory.path, '.writer-v1.lock');
}

function effectLiveLockPath(directory: JournalDirectory, scopeHash: string, effectId: string): string {
  return join(directory.path, `.owner-v1-${scopeHash}-${effectId}.lock`);
}

function findScopeHashForEffect(
  directory: JournalDirectory,
  effectId: string,
): { kind: 'absent' } | { kind: 'conflict' } | { kind: 'found'; scopeHash: string } {
  const suffix = `-${effectId}.json`;
  let found: string | null = null;
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) return { kind: 'conflict' };
      if (!entry.name.startsWith('.effect-v1-') || !entry.name.endsWith(suffix)) continue;
      const scopeHash = entry.name.slice('.effect-v1-'.length, -suffix.length);
      if (!SHA256_RE.test(scopeHash) || found !== null) return { kind: 'conflict' };
      found = scopeHash;
    }
    return found ? { kind: 'found', scopeHash: found } : { kind: 'absent' };
  } finally {
    dir.closeSync();
  }
}

interface StableAuthorityBytes {
  bytes: Buffer;
  dev: number;
  ino: number;
}

function readAuthorityBytes(
  path: string,
  directory: JournalDirectory,
  maxBytes: number,
  pathsAssured = false,
): 'absent' | 'invalid' | StableAuthorityBytes {
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return 'invalid';
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before.uid) ||
      before.size < 2 || before.size > maxBytes ||
      (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
    ) return 'invalid';
    if (!pathsAssured) {
      const assurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: stateRoot() });
      if (!assurance.ok) return 'invalid';
    }
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) return 'invalid';
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return 'invalid';
      offset += count;
    }
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || !sameDirectory(directory)) return 'invalid';
    return { bytes, dev: opened.dev, ino: opened.ino };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function readRecord(
  path: string,
  directory: JournalDirectory,
  expectedScopeHash: string,
  expectedEffectId: string,
  key?: Buffer,
  pathsAssured = false,
): 'absent' | 'invalid' | EffectRecord {
  const source = readAuthorityBytes(path, directory, MAX_RECORD_BYTES, pathsAssured);
  if (source === 'absent' || source === 'invalid') return source;
  try {
    const record = strictRecord(JSON.parse(source.bytes.toString('utf8')), key);
    return record && record.scopeHash === expectedScopeHash && record.effectId === expectedEffectId
      ? record
      : 'invalid';
  } catch {
    return 'invalid';
  }
}

function readEffectiveRecord(
  directory: JournalDirectory,
  scopeHash: string,
  effectId: string,
  key?: Buffer,
  pathsAssured = false,
): 'absent' | 'invalid' | EffectRecord {
  const prepared = readRecord(
    recordPath(directory, scopeHash, effectId), directory, scopeHash, effectId, key, pathsAssured,
  );
  if (prepared === 'absent' || prepared === 'invalid' || prepared.phase !== 'prepared') return prepared;
  const terminal = readRecord(
    terminalPath(directory, scopeHash, effectId), directory, scopeHash, effectId, key, pathsAssured,
  );
  if (terminal === 'absent') return prepared;
  if (
    terminal === 'invalid' || terminal.phase === 'prepared' ||
    terminal.preparedAttestation !== prepared.attestation ||
    terminal.ownerHash !== prepared.ownerHash ||
    terminal.generationHash !== prepared.generationHash
  ) return 'invalid';
  return terminal;
}

function fsyncDirectory(path: string): boolean {
  if (process.platform === 'win32') return true;
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isDirectory() || !owned(before.uid)) return false;
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_DIRECTORY);
    const opened = fstatSync(fd);
    if (
      !opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino ||
      !owned(opened.uid)
    ) return false;
    fsyncSync(fd);
    const after = lstatSync(path);
    return !after.isSymbolicLink() && after.isDirectory() &&
      after.dev === opened.dev && after.ino === opened.ino && owned(after.uid);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

function writeRecord(path: string, record: EffectRecord, directory: JournalDirectory): boolean {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  if (bytes.length > MAX_RECORD_BYTES) return false;
  const target = path;
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return false;
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;
    fd = openSync(target, flags, 0o600);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() || opened.nlink !== 1 || !owned(opened.uid)
    ) return false;
    const assurance = assurePrivateStoragePath(target, 'file', 'secure-created', {
      anchorPath: stateRoot(),
    });
    if (!assurance.ok) return false;
    const installed = lstatSync(target);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 1 ||
      installed.dev !== opened.dev || installed.ino !== opened.ino || !sameDirectory(directory)
    ) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written === 0) return false;
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!fsyncDirectory(directory.path)) return false;
    const reread = readRecord(path, directory, record.scopeHash, record.effectId);
    return sameDirectory(directory) && reread !== 'invalid' && reread !== 'absent' &&
      reread.effectId === record.effectId && equalDigest(reread.attestation, record.attestation);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    // A failed exclusive write leaves invalid evidence in place and therefore
    // fails closed. Never unlink an authority record after opening it.
  }
}

function writeImmutableAuthorityBytes(
  path: string,
  bytes: Buffer,
  maxBytes: number,
  directory: JournalDirectory,
): boolean {
  if (bytes.length < 2 || bytes.length > maxBytes || process.platform === 'win32') return false;
  const candidate = join(
    directory.path,
    `.terminal-stage-v1-${hash([PACK_ID_DOMAIN, basename(path)])}-${randomUUID()}.candidate`,
  );
  let fd: number | undefined;
  let linked = false;
  try {
    if (!sameDirectory(directory) || existsSync(path)) return false;
    fd = openSync(
      candidate,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || !owned(opened.uid)) return false;
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (written === 0) return false;
      offset += written;
    }
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const secured = assurePrivateStoragePath(candidate, 'file', 'secure-created', { anchorPath: stateRoot() });
    if (!secured.ok) return false;
    const candidateStat = lstatSync(candidate);
    if (
      candidateStat.isSymbolicLink() || !candidateStat.isFile() || candidateStat.nlink !== 1 ||
      !owned(candidateStat.uid) || candidateStat.dev !== opened.dev || candidateStat.ino !== opened.ino
    ) return false;
    linkSync(candidate, path);
    linked = true;
    const installed = lstatSync(path);
    if (
      installed.isSymbolicLink() || !installed.isFile() || installed.nlink !== 2 ||
      installed.dev !== opened.dev || installed.ino !== opened.ino || !sameDirectory(directory)
    ) return false;
    unlinkSync(candidate);
    linked = false;
    const finalStat = lstatSync(path);
    if (
      finalStat.isSymbolicLink() || !finalStat.isFile() || finalStat.nlink !== 1 ||
      finalStat.dev !== opened.dev || finalStat.ino !== opened.ino || !sameDirectory(directory)
    ) return false;
    if (!fsyncDirectory(directory.path)) return false;
    const reread = readAuthorityBytes(path, directory, maxBytes);
    return reread !== 'absent' && reread !== 'invalid' && reread.bytes.equals(bytes);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    if (!linked) {
      try { if (existsSync(candidate)) unlinkSync(candidate); } catch { /* fail-closed residue */ }
    }
    // A linked candidate or installed final file is retained on uncertainty.
  }
}

function recoverPackCandidatesUnlocked(directory: JournalDirectory): boolean {
  if (process.platform === 'win32') return false;
  try {
    const finalNames: string[] = [];
    const candidates: string[] = [];
    let totalEntries = 0;
    const dir = opendirSync(directory.path);
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        totalEntries += 1;
        if (totalEntries > MAX_DIRECTORY_ENTRIES) return false;
        if (/^\.terminal-stage-v1-[a-f0-9]{64}-[A-Za-z0-9-]+\.candidate$/.test(entry.name)) {
          candidates.push(entry.name);
          if (candidates.length > MAX_PACK_CANDIDATES) return false;
        } else if (
          /^\.effect-v1-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name) ||
          /^\.terminal-v1-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name) ||
          /^\.terminal-pack-v1-[a-f0-9]{64}\.json$/.test(entry.name) ||
          /^\.terminal-pack-commit-v1-\d{12}-[a-f0-9]{64}\.json$/.test(entry.name) ||
          entry.name === '.format-v2-effect-terminal-packs.json'
        ) {
          finalNames.push(entry.name);
        }
      }
    } finally {
      dir.closeSync();
    }
    if (candidates.length === 0) return true;
    for (const name of candidates) {
      const path = join(directory.path, name);
      const assurance = assurePrivateStoragePath(path, 'file', 'inspect-existing', { anchorPath: stateRoot() });
      if (!assurance.ok) return false;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || !owned(stat.uid) || stat.nlink < 1 || stat.nlink > 2) {
        return false;
      }
      if (stat.nlink === 2) {
        const matches = finalNames.filter((finalName) => {
          try {
            const candidate = lstatSync(join(directory.path, finalName));
            return candidate.dev === stat.dev && candidate.ino === stat.ino && candidate.nlink === 2;
          } catch { return false; }
        });
        if (matches.length !== 1) return false;
      }
      unlinkSync(path);
    }
    return fsyncDirectory(directory.path) && sameDirectory(directory);
  } catch {
    return false;
  }
}

function unlinkExactAuthorityFile(
  path: string,
  expectedBytes: Buffer,
  maxBytes: number,
  directory: JournalDirectory,
): boolean {
  if (process.platform === 'win32') return false;
  const guard = join(
    directory.path,
    `.terminal-stage-v1-${hash([PACK_ID_DOMAIN, basename(path)])}-${randomUUID()}.candidate`,
  );
  try {
    const source = readAuthorityBytes(path, directory, maxBytes);
    if (source === 'absent') return true;
    if (source === 'invalid' || !source.bytes.equals(expectedBytes)) return false;
    const current = lstatSync(path);
    if (
      current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || !owned(current.uid) ||
      current.dev !== source.dev || current.ino !== source.ino || !sameDirectory(directory)
    ) return false;
    // Pin the verified inode before unlinking its canonical name. Any crash
    // residue uses the normal candidate-recovery path and remains fail-closed.
    linkSync(path, guard);
    const pinned = lstatSync(guard);
    const stillCurrent = lstatSync(path);
    if (
      pinned.dev !== source.dev || pinned.ino !== source.ino || pinned.nlink !== 2 ||
      stillCurrent.dev !== source.dev || stillCurrent.ino !== source.ino || stillCurrent.nlink !== 2 ||
      !sameDirectory(directory)
    ) return false;
    unlinkSync(path);
    const remaining = lstatSync(guard);
    if (remaining.dev !== source.dev || remaining.ino !== source.ino || remaining.nlink !== 1) return false;
    unlinkSync(guard);
    return sameDirectory(directory);
  } catch {
    return false;
  }
}

function atCapacity(directory: JournalDirectory): boolean {
  let count = 0;
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) return true;
      if (/^\.effect-v1-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) {
        count += 1;
        if (count >= MAX_RECORDS) return true;
      }
    }
    return false;
  } finally {
    dir.closeSync();
  }
}

function looseTerminalCount(directory: JournalDirectory): number {
  let count = 0;
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) return MAX_PACK_ENTRIES;
      if (/^\.terminal-v1-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) count += 1;
    }
    return count;
  } finally {
    dir.closeSync();
  }
}

export function prepareToolEffect(input: ToolEffectInput): PrepareToolEffectResult {
  if (!effectJournalExecutionSupported()) return { ok: false, reason: 'unavailable' };
  const identity = effectIdentity(input);
  if (!identity) return { ok: false, reason: 'invalid' };
  if (input.safety === 'exec') return { ok: false, reason: 'unavailable' };
  const processKey = `${effectJournalDirectory()}:${identity.scopeHash}:${identity.effectId}`;
  if (processObservedEffects.has(processKey) && !existsSync(effectJournalDirectory())) {
    return { ok: false, reason: 'unavailable' };
  }
  let lock: LocalStoreLock | null = null;
  let liveLock: LocalStoreLock | null = null;
  let transferredLiveLock = false;
  try {
    const directory = ensureDirectory();
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return { ok: false, reason: 'unavailable' };
    const key = attestationKey(true);
    if (!key || !recoverPackCandidatesUnlocked(directory)) return { ok: false, reason: 'unavailable' };
    const scopeState = readEffectJournalUnlocked(directory, MAX_RECORDS, identity.scopeHash);
    if (scopeState.sourceState === 'degraded' || scopeState.limitExceeded) {
      return { ok: false, reason: 'unavailable' };
    }
    const path = recordPath(directory, identity.scopeHash, identity.effectId);
    const existing = scopeState.records.find((record) => record.effectId === identity.effectId);
    if (existing) return { ok: false, reason: 'duplicate', phase: existing.phase };
    if (processObservedEffects.has(processKey)) return { ok: false, reason: 'unavailable' };
    if (scopeState.records.length >= MAX_RECORDS || atCapacity(directory)) {
      return { ok: false, reason: 'capacity' };
    }
    liveLock = acquireLocalStoreLock(
      effectLiveLockPath(directory, identity.scopeHash, identity.effectId),
      LOCK_WAIT_MS,
    );
    if (!liveLock) return { ok: false, reason: 'unavailable' };
    const ownerToken = randomUUID();
    const unsigned = {
      schemaVersion: SCHEMA_VERSION,
      ...identity,
      ordinal: input.ordinal,
      toolName: input.toolName,
      safety: input.safety,
      identityPolicy: input.safety === 'write' ? 'generation-bound' as const : 'scope-bound' as const,
      phase: 'prepared' as const,
      ownerHash: hash([EFFECT_DOMAIN, 'owner', ownerToken]),
      revision: 1 as const,
      preparedAt: new Date().toISOString(),
    };
    const attestation = recordAttestation(unsigned, true, key);
    if (!attestation) return { ok: false, reason: 'unavailable' };
    if (!writeRecord(path, { ...unsigned, attestation }, directory)) {
      return { ok: false, reason: 'unavailable' };
    }
    processObservedEffects.add(processKey);
    transferredLiveLock = true;
    return {
      ok: true,
      effect: {
        effectId: identity.effectId,
        scopeHash: identity.scopeHash,
        generationHash: identity.generationHash,
        ownerToken,
        recordPath: path,
        liveLock,
      },
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    releaseLocalStoreLock(lock);
    // Ownership transfers to the returned handle only after a durable prepare.
    if (liveLock && !transferredLiveLock) releaseLocalStoreLock(liveLock);
  }
}

export function commitToolEffect(effect: PreparedToolEffect, outcome: unknown): boolean {
  if (!effectJournalExecutionSupported()) return false;
  if (
    !effect || typeof effect !== 'object' ||
    !SHA256_RE.test(effect.effectId) || !SHA256_RE.test(effect.scopeHash) ||
    !SHA256_RE.test(effect.generationHash) || !safeId(effect.ownerToken) ||
    !effect.liveLock || typeof effect.liveLock !== 'object'
  ) return false;
  const processKey = `${effectJournalDirectory()}:${effect.scopeHash}:${effect.effectId}`;
  processUncertainEffects.add(processKey);
  let lock: LocalStoreLock | null = null;
  let releaseLiveLock = false;
  try {
    const directory = ensureDirectory();
    const path = recordPath(directory, effect.scopeHash, effect.effectId);
    const expectedLivePath = effectLiveLockPath(directory, effect.scopeHash, effect.effectId);
    if (
      path !== effect.recordPath || effect.liveLock.path !== expectedLivePath ||
      !ownsLocalStoreLock(effect.liveLock)
    ) return false;
    const ownedPrepared = readEffectiveRecord(directory, effect.scopeHash, effect.effectId);
    if (
      ownedPrepared === 'absent' || ownedPrepared === 'invalid' || ownedPrepared.phase !== 'prepared' ||
      ownedPrepared.generationHash !== effect.generationHash ||
      ownedPrepared.ownerHash !== hash([EFFECT_DOMAIN, 'owner', effect.ownerToken])
    ) return false;
    releaseLiveLock = true;
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return false;
    const current = readEffectiveRecord(directory, effect.scopeHash, effect.effectId);
    if (
      current === 'absent' || current === 'invalid' || current.phase !== 'prepared' ||
      current.effectId !== effect.effectId || current.generationHash !== effect.generationHash ||
      current.ownerHash !== hash([EFFECT_DOMAIN, 'owner', effect.ownerToken])
    ) return false;
    let encoded: string;
    try {
      if (typeof outcome === 'string') encoded = outcome;
      else {
        const json = JSON.stringify(outcome);
        encoded = json === undefined ? `[${typeof outcome}]` : json;
      }
    } catch { encoded = '[unserializable outcome]'; }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_OUTCOME_BYTES) return false;
    const { attestation: _old, phase: _phase, revision: _revision, ...base } = current;
    const unsigned = {
      ...base,
      phase: 'committed' as const,
      revision: 2 as const,
      committedAt: new Date().toISOString(),
      outcomeDigest: createHash('sha256').update(encoded).digest('hex'),
      preparedAttestation: current.attestation,
    };
    const key = attestationKey(true);
    const attestation = key ? recordAttestation(unsigned, true, key) : null;
    const terminal = attestation === null ? null : { ...unsigned, attestation };
    const committed = terminal !== null && strictRecord(terminal) !== null &&
      writeRecord(terminalPath(directory, effect.scopeHash, effect.effectId), terminal, directory);
    if (committed) {
      processUncertainEffects.delete(processKey);
      if (key && looseTerminalCount(directory) >= MAX_PACK_ENTRIES) {
        // Retention is maintenance after the terminal effect is already durable;
        // a compaction refusal must not turn a committed outcome into ambiguity.
        compactTerminalEffectsUnlocked(directory, key);
      }
    }
    return committed;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(lock);
    if (releaseLiveLock) releaseLocalStoreLock(effect.liveLock);
  }
}

/** Relinquish live ownership while retaining prepared evidence and replay refusal. */
export function releasePreparedToolEffect(effect: PreparedToolEffect | null | undefined): void {
  if (
    !effect || typeof effect !== 'object' ||
    !SHA256_RE.test(effect.effectId) || !SHA256_RE.test(effect.scopeHash) ||
    !effect.liveLock || typeof effect.liveLock !== 'object'
  ) return;
  const expectedPath = join(
    effectJournalDirectory(),
    `.owner-v1-${effect.scopeHash}-${effect.effectId}.lock`,
  );
  if (effect.liveLock.path !== expectedPath) return;
  releaseLocalStoreLock(effect.liveLock);
}

export function resolvePreparedEffect(input: {
  effectId: string;
  expectedAttestation: string;
  resolution: EffectResolution;
  evidenceDigest: string;
}): boolean {
  if (!effectJournalExecutionSupported()) return false;
  if (
    !input || typeof input !== 'object' || !SHA256_RE.test(input.effectId) ||
    !SHA256_RE.test(input.expectedAttestation) || !SHA256_RE.test(input.evidenceDigest) ||
    (input.resolution !== 'attested-committed' && input.resolution !== 'attested-no-effect' && input.resolution !== 'abandoned')
  ) return false;
  let lock: LocalStoreLock | null = null;
  let liveLock: LocalStoreLock | null = null;
  try {
    const directory = ensureDirectory();
    const located = findScopeHashForEffect(directory, input.effectId);
    if (located.kind !== 'found') return false;
    const scopeHash = located.scopeHash;
    liveLock = acquireLocalStoreLock(
      effectLiveLockPath(directory, scopeHash, input.effectId),
      LIVE_OWNER_PROBE_WAIT_MS,
    );
    if (!liveLock) return false;
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return false;
    const snapshot = readEffectJournalUnlocked(directory, MAX_RECORDS, scopeHash);
    if (snapshot.sourceState === 'degraded' || snapshot.limitExceeded) return false;
    const current = snapshot.records.find((record) => record.effectId === input.effectId);
    if (!current || current.phase !== 'prepared' ||
      !equalDigest(current.attestation, input.expectedAttestation)) return false;
    const { attestation: _old, phase: _phase, revision: _revision, ...base } = current;
    const unsigned = {
      ...base,
      phase: 'resolved' as const,
      revision: 2 as const,
      resolution: input.resolution,
      resolvedAt: new Date().toISOString(),
      evidenceDigest: input.evidenceDigest,
      preparedAttestation: current.attestation,
    };
    const key = attestationKey(true);
    const attestation = key ? recordAttestation(unsigned, true, key) : null;
    const terminal = attestation === null ? null : { ...unsigned, attestation };
    const resolved = terminal !== null && strictRecord(terminal) !== null &&
      writeRecord(terminalPath(directory, current.scopeHash, input.effectId), terminal, directory);
    if (resolved && key && looseTerminalCount(directory) >= MAX_PACK_ENTRIES) {
      compactTerminalEffectsUnlocked(directory, key);
    }
    return resolved;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(lock);
    releaseLocalStoreLock(liveLock);
  }
}

interface PackedAuthorityState {
  pairs: Map<string, TerminalPackEntry>;
  commits: TerminalPackCommitRecord[];
  orphanPacks: Array<{ name: string; bytes: Buffer; pack: TerminalPackRecord }>;
  invalidRecords: number;
}

interface JournalReadCapture {
  packed?: PackedAuthorityState;
}

function sameRecord(left: EffectRecord, right: EffectRecord): boolean {
  return left.attestation === right.attestation && JSON.stringify(left) === JSON.stringify(right);
}

function samePackEntry(left: TerminalPackEntry, right: TerminalPackEntry): boolean {
  return sameRecord(left.prepared, right.prepared) && sameRecord(left.terminal, right.terminal);
}

function readPackedAuthorityUnlocked(
  directory: JournalDirectory,
  key: Buffer,
  packNames: Map<string, string>,
  commitNames: Array<{ name: string; sequence: number; packId: string }>,
  formatFloorNames: string[],
  scopeFilter?: string,
  effectFilter?: string,
): PackedAuthorityState {
  const pairs = new Map<string, TerminalPackEntry>();
  if (packNames.size === 0 && commitNames.length === 0 && formatFloorNames.length === 0) {
    return { pairs, commits: [], orphanPacks: [], invalidRecords: 0 };
  }
  if (
    process.platform === 'win32' || formatFloorNames.length !== 1 ||
    commitNames.length > MAX_PACKS || packNames.size > MAX_PACKS + MAX_PACK_CANDIDATES
  ) return { pairs, commits: [], orphanPacks: [], invalidRecords: 1 };

  const floorPath = join(directory.path, formatFloorNames[0]!);
  const floorSource = readAuthorityBytes(floorPath, directory, MAX_PACK_COMMIT_BYTES);
  if (floorSource === 'absent' || floorSource === 'invalid') {
    return { pairs, commits: [], orphanPacks: [], invalidRecords: 1 };
  }
  try {
    if (!strictFormatFloor(JSON.parse(floorSource.bytes.toString('utf8')), key)) {
      return { pairs, commits: [], orphanPacks: [], invalidRecords: 1 };
    }
  } catch {
    return { pairs, commits: [], orphanPacks: [], invalidRecords: 1 };
  }

  commitNames.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
  const commits: TerminalPackCommitRecord[] = [];
  const committedPackIds = new Set<string>();
  let previousAttestation = ZERO_DIGEST;
  let totalPackedBytes = 0;
  let invalidRecords = 0;

  for (let index = 0; index < commitNames.length; index += 1) {
    const expectedSequence = index + 1;
    const descriptor = commitNames[index]!;
    if (descriptor.sequence !== expectedSequence || committedPackIds.has(descriptor.packId)) {
      invalidRecords += 1;
      continue;
    }
    const markerSource = readAuthorityBytes(
      join(directory.path, descriptor.name),
      directory,
      MAX_PACK_COMMIT_BYTES,
    );
    if (markerSource === 'absent' || markerSource === 'invalid') {
      invalidRecords += 1;
      continue;
    }
    let marker: TerminalPackCommitRecord | null = null;
    try { marker = strictPackCommit(JSON.parse(markerSource.bytes.toString('utf8')), key); }
    catch { marker = null; }
    if (
      !marker || marker.sequence !== descriptor.sequence || marker.packId !== descriptor.packId ||
      marker.previousCommitAttestation !== previousAttestation
    ) {
      invalidRecords += 1;
      continue;
    }
    const scopeMayMatch = !scopeFilter || packBloomMayContain(marker.scopeBloom, scopeFilter);
    const effectMayMatch = !effectFilter || packBloomMayContain(marker.effectBloom, effectFilter);
    if (!scopeMayMatch || !effectMayMatch) {
      previousAttestation = marker.attestation;
      committedPackIds.add(marker.packId);
      commits.push(marker);
      continue;
    }
    const packName = packNames.get(marker.packId);
    if (!packName) {
      invalidRecords += 1;
      continue;
    }
    const packSource = readAuthorityBytes(join(directory.path, packName), directory, MAX_PACK_BYTES);
    if (packSource === 'absent' || packSource === 'invalid') {
      invalidRecords += 1;
      continue;
    }
    const digest = createHash('sha256').update(packSource.bytes).digest('hex');
    let pack: TerminalPackRecord | null = null;
    try { pack = strictTerminalPack(JSON.parse(packSource.bytes.toString('utf8')), key); }
    catch { pack = null; }
    if (
      !pack || pack.packId !== marker.packId || packSource.bytes.length !== marker.packBytes ||
      pack.entries.length !== marker.entryCount || !equalDigest(digest, marker.packDigest) ||
      packBloom(pack.entries.map((entry) => entry.prepared.scopeHash)) !== marker.scopeBloom ||
      packBloom(pack.entries.map((entry) => entry.prepared.effectId)) !== marker.effectBloom
    ) {
      invalidRecords += 1;
      continue;
    }
    totalPackedBytes += packSource.bytes.length;
    if (totalPackedBytes > MAX_PACKED_BYTES) {
      invalidRecords += 1;
      continue;
    }
    for (const pair of pack.entries) {
      if (scopeFilter && pair.prepared.scopeHash !== scopeFilter) continue;
      if (effectFilter && pair.prepared.effectId !== effectFilter) continue;
      const pairKey = `${pair.prepared.scopeHash}:${pair.prepared.effectId}`;
      const existing = pairs.get(pairKey);
      if (existing && !samePackEntry(existing, pair)) invalidRecords += 1;
      else pairs.set(pairKey, pair);
    }
    previousAttestation = marker.attestation;
    committedPackIds.add(marker.packId);
    commits.push(marker);
  }

  let orphanPacks = 0;
  const validatedOrphans: Array<{ name: string; bytes: Buffer; pack: TerminalPackRecord }> = [];
  for (const [packId, packName] of packNames) {
    if (committedPackIds.has(packId)) continue;
    orphanPacks += 1;
    if (orphanPacks > MAX_PACK_CANDIDATES) {
      invalidRecords += 1;
      continue;
    }
    const source = readAuthorityBytes(join(directory.path, packName), directory, MAX_PACK_BYTES);
    if (source === 'absent' || source === 'invalid') {
      invalidRecords += 1;
      continue;
    }
    try {
      const pack = strictTerminalPack(JSON.parse(source.bytes.toString('utf8')), key);
      if (!pack || pack.packId !== packId) invalidRecords += 1;
      else validatedOrphans.push({ name: packName, bytes: source.bytes, pack });
    } catch { invalidRecords += 1; }
  }

  return { pairs, commits, orphanPacks: validatedOrphans, invalidRecords };
}

function readEffectJournalUnlocked(
  directory: JournalDirectory,
  limit: number,
  scopeFilter?: string,
  effectFilter?: string,
  capture?: JournalReadCapture,
): EffectJournalReadResult {
  const key = attestationKey(false);
  if (!key) return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
  const baseEntries: Array<{ name: string; scopeHash: string; effectId: string }> = [];
  const terminalEntries = new Map<string, { name: string; scopeHash: string; effectId: string }>();
  const packNames = new Map<string, string>();
  const commitNames: Array<{ name: string; sequence: number; packId: string }> = [];
  const formatFloorNames: string[] = [];
  let structuralInvalid = 0;
  let physicalRecords = 0;
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) {
        return { records: [], sourceState: 'degraded', invalidRecords: 1, limitExceeded: true };
      }
      const pack = /^\.terminal-pack-v1-([a-f0-9]{64})\.json$/.exec(entry.name);
      const commit = /^\.terminal-pack-commit-v1-(\d{12})-([a-f0-9]{64})\.json$/.exec(entry.name);
      if (pack) {
        if (packNames.size >= MAX_PACKS + MAX_PACK_CANDIDATES || packNames.has(pack[1]!)) structuralInvalid += 1;
        else packNames.set(pack[1]!, entry.name);
        continue;
      }
      if (commit) {
        const sequence = Number(commit[1]);
        if (commitNames.length >= MAX_PACKS || !Number.isSafeInteger(sequence) || sequence < 1) structuralInvalid += 1;
        else commitNames.push({ name: entry.name, sequence, packId: commit[2]! });
        continue;
      }
      if (entry.name === '.format-v2-effect-terminal-packs.json') {
        formatFloorNames.push(entry.name);
        continue;
      }
      const base = /^\.effect-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      const terminal = /^\.terminal-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      const match = base ?? terminal;
      if (!match) {
        if (entry.name.startsWith('.effect-') || entry.name.startsWith('.terminal-') ||
          entry.name.startsWith('.format-')) structuralInvalid += 1;
        continue;
      }
      if (scopeFilter && match[1] !== scopeFilter) continue;
      if (effectFilter && match[2] !== effectFilter) continue;
      physicalRecords += 1;
      if (physicalRecords > MAX_RECORDS * 2) {
        return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: true };
      }
      if (base) baseEntries.push({ name: entry.name, scopeHash: base[1]!, effectId: base[2]! });
      else {
        const terminalKey = `${terminal![1]}:${terminal![2]}`;
        if (terminalEntries.has(terminalKey)) structuralInvalid += 1;
        else terminalEntries.set(terminalKey, {
          name: entry.name,
          scopeHash: terminal![1]!,
          effectId: terminal![2]!,
        });
      }
    }
  } finally {
    dir.closeSync();
  }

  const packed = readPackedAuthorityUnlocked(
    directory,
    key,
    packNames,
    commitNames,
    formatFloorNames,
    scopeFilter,
    effectFilter,
  );
  if (capture) capture.packed = packed;
  let invalidRecords = structuralInvalid + packed.invalidRecords;
  baseEntries.sort((a, b) => a.name.localeCompare(b.name));
  const matchedPaths: string[] = [];
  for (const entry of baseEntries) {
    matchedPaths.push(join(directory.path, entry.name));
    const terminal = terminalEntries.get(`${entry.scopeHash}:${entry.effectId}`);
    if (terminal) matchedPaths.push(join(directory.path, terminal.name));
  }
  for (let index = 0; index < matchedPaths.length; index += 512) {
    const assurance = assurePrivateStoragePaths(matchedPaths.slice(index, index + 512), {
      anchorPath: stateRoot(),
    });
    if (!assurance.ok) {
      return { records: [], sourceState: 'degraded', invalidRecords: 1, limitExceeded: false };
    }
  }

  const records = new Map<string, EffectRecord>();
  for (const [pairKey, pair] of packed.pairs) records.set(pairKey, pair.terminal);
  const baseIds = new Set<string>();
  const loosePrepared = new Map<string, PreparedEffectRecord>();
  const looseTerminal = new Map<string, TerminalEffectRecord>();
  for (const entry of baseEntries) {
    const pairKey = `${entry.scopeHash}:${entry.effectId}`;
    baseIds.add(pairKey);
    const prepared = readRecord(
      join(directory.path, entry.name),
      directory,
      entry.scopeHash,
      entry.effectId,
      key,
      true,
    );
    if (prepared === 'absent' || prepared === 'invalid' || prepared.phase !== 'prepared') {
      invalidRecords += 1;
      continue;
    }
    loosePrepared.set(pairKey, prepared);
    const terminalEntry = terminalEntries.get(pairKey);
    let terminal: EffectRecord | 'absent' | 'invalid' = 'absent';
    if (terminalEntry) {
      terminal = readRecord(
        join(directory.path, terminalEntry.name),
        directory,
        entry.scopeHash,
        entry.effectId,
        key,
        true,
      );
      if (
        terminal === 'absent' || terminal === 'invalid' || terminal.phase === 'prepared' ||
        !samePackLineage(prepared, terminal)
      ) {
        invalidRecords += 1;
        continue;
      }
      looseTerminal.set(pairKey, terminal);
    }
    const packedPair = packed.pairs.get(pairKey);
    if (packedPair) {
      if (!sameRecord(prepared, packedPair.prepared) ||
        (terminal !== 'absent' && !sameRecord(terminal, packedPair.terminal))) {
        invalidRecords += 1;
        continue;
      }
      records.set(pairKey, packedPair.terminal);
    } else {
      records.set(pairKey, terminal === 'absent' ? prepared : terminal);
    }
  }

  for (const [pairKey, terminalEntry] of terminalEntries) {
    if (baseIds.has(pairKey)) continue;
    const packedPair = packed.pairs.get(pairKey);
    if (!packedPair) {
      invalidRecords += 1;
      continue;
    }
    const terminal = readRecord(
      join(directory.path, terminalEntry.name),
      directory,
      terminalEntry.scopeHash,
      terminalEntry.effectId,
      key,
    );
    if (terminal === 'absent' || terminal === 'invalid' || !sameRecord(terminal, packedPair.terminal)) {
      invalidRecords += 1;
    }
  }

  for (const [pairKey, pair] of packed.pairs) {
    const prepared = loosePrepared.get(pairKey);
    if (!prepared || !sameRecord(prepared, pair.prepared)) invalidRecords += 1;
  }
  for (const orphan of packed.orphanPacks) {
    for (const pair of orphan.pack.entries) {
      if (scopeFilter && pair.prepared.scopeHash !== scopeFilter) continue;
      if (effectFilter && pair.prepared.effectId !== effectFilter) continue;
      const pairKey = `${pair.prepared.scopeHash}:${pair.prepared.effectId}`;
      const prepared = loosePrepared.get(pairKey);
      const terminal = looseTerminal.get(pairKey);
      if (
        !prepared || !terminal || !sameRecord(prepared, pair.prepared) ||
        !sameRecord(terminal, pair.terminal)
      ) invalidRecords += 1;
    }
  }

  const sortedRecords = [...records.values()]
    .sort((a, b) => a.preparedAt.localeCompare(b.preparedAt) || a.effectId.localeCompare(b.effectId));
  const limitExceeded = sortedRecords.length > limit;
  return {
    records: sortedRecords.slice(0, limit),
    sourceState: invalidRecords > 0 || limitExceeded ? 'degraded' : 'healthy',
    invalidRecords,
    limitExceeded,
  };
}

function ensureFormatFloorUnlocked(directory: JournalDirectory, key: Buffer): boolean {
  const path = terminalPackFormatFloorPath(directory);
  if (existsSync(path)) {
    const source = readAuthorityBytes(path, directory, MAX_PACK_COMMIT_BYTES);
    if (source === 'absent' || source === 'invalid') return false;
    try { return strictFormatFloor(JSON.parse(source.bytes.toString('utf8')), key) !== null; }
    catch { return false; }
  }
  const unsigned = {
    schemaVersion: 2 as const,
    recordType: 'effect-terminal-pack-format' as const,
    createdAt: new Date().toISOString(),
  };
  const attestation = formatFloorAttestation(unsigned, true, key);
  if (!attestation) return false;
  const bytes = Buffer.from(`${JSON.stringify({ ...unsigned, attestation })}\n`, 'utf8');
  if (!writeImmutableAuthorityBytes(path, bytes, MAX_PACK_COMMIT_BYTES, directory)) return false;
  const source = readAuthorityBytes(path, directory, MAX_PACK_COMMIT_BYTES);
  if (source === 'absent' || source === 'invalid') return false;
  try { return strictFormatFloor(JSON.parse(source.bytes.toString('utf8')), key) !== null; }
  catch { return false; }
}

function collectLooseTerminalPairs(
  directory: JournalDirectory,
  key: Buffer,
): { pairs: TerminalPackEntry[]; invalid: boolean } {
  const bases = new Map<string, { scopeHash: string; effectId: string; name: string }>();
  const terminals = new Map<string, string>();
  let invalid = false;
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) {
        invalid = true;
        break;
      }
      const base = /^\.effect-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      const terminal = /^\.terminal-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      if (base) {
        const pairKey = `${base[1]}:${base[2]}`;
        if (bases.size >= MAX_RECORDS || bases.has(pairKey)) invalid = true;
        else bases.set(pairKey, { scopeHash: base[1]!, effectId: base[2]!, name: entry.name });
      } else if (terminal) {
        const pairKey = `${terminal[1]}:${terminal[2]}`;
        if (terminals.size >= MAX_RECORDS || terminals.has(pairKey)) invalid = true;
        else terminals.set(pairKey, entry.name);
      }
    }
  } finally {
    dir.closeSync();
  }
  if (invalid) return { pairs: [], invalid: true };
  const pairs: TerminalPackEntry[] = [];
  for (const [pairKey, terminalName] of terminals) {
    const base = bases.get(pairKey);
    if (!base) continue;
    const prepared = readRecord(
      join(directory.path, base.name), directory, base.scopeHash, base.effectId, key,
    );
    const terminal = readRecord(
      join(directory.path, terminalName), directory, base.scopeHash, base.effectId, key,
    );
    if (
      prepared === 'absent' || prepared === 'invalid' || prepared.phase !== 'prepared' ||
      terminal === 'absent' || terminal === 'invalid' || terminal.phase === 'prepared' ||
      !samePackLineage(prepared, terminal)
    ) return { pairs: [], invalid: true };
    pairs.push({ prepared, terminal });
  }
  pairs.sort((a, b) => {
    const left = `${a.prepared.scopeHash}:${a.prepared.effectId}`;
    const right = `${b.prepared.scopeHash}:${b.prepared.effectId}`;
    return left.localeCompare(right);
  });
  return { pairs, invalid: false };
}

function looseAuthorityKeys(directory: JournalDirectory): Set<string> | null {
  const keys = new Set<string>();
  let totalEntries = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      totalEntries += 1;
      if (totalEntries > MAX_DIRECTORY_ENTRIES) return null;
      const match = /^\.(?:effect|terminal)-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      if (match) {
        keys.add(`${match[1]}:${match[2]}`);
        if (keys.size > MAX_RECORDS) return null;
      }
    }
  } finally {
    dir.closeSync();
  }
  return keys;
}

function cleanupPackedOverlapUnlocked(
  directory: JournalDirectory,
  pair: TerminalPackEntry,
): { ok: boolean; removed: number } {
  const terminalBytes = Buffer.from(`${JSON.stringify(pair.terminal)}\n`, 'utf8');
  let removed = 0;
  const terminalFile = terminalPath(directory, pair.prepared.scopeHash, pair.prepared.effectId);
  if (existsSync(terminalFile)) {
    if (!unlinkExactAuthorityFile(terminalFile, terminalBytes, MAX_RECORD_BYTES, directory)) {
      return { ok: false, removed };
    }
    removed += 1;
  }
  // Keep the authenticated prepared tombstone. It is the rollback floor for
  // exact reads and older binaries if a terminal pack tail disappears.
  return { ok: true, removed };
}

function compactTerminalEffectsUnlocked(
  directory: JournalDirectory,
  key: Buffer,
): EffectJournalCompactionResult {
  if (!effectJournalCompactionSupported()) {
    return { ok: false, reason: 'unsupported', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  if (!recoverPackCandidatesUnlocked(directory)) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  const capture: JournalReadCapture = {};
  const before = readEffectJournalUnlocked(directory, MAX_LOGICAL_RECORDS, undefined, undefined, capture);
  const packed = capture.packed;
  if (before.sourceState === 'degraded' || before.limitExceeded || !packed) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  for (const orphan of packed.orphanPacks) {
    if (!unlinkExactAuthorityFile(
      join(directory.path, orphan.name),
      orphan.bytes,
      MAX_PACK_BYTES,
      directory,
    )) return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  if (packed.orphanPacks.length > 0 && (!fsyncDirectory(directory.path) || !sameDirectory(directory))) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  let removed = 0;
  let durableRemoved = 0;
  const flushCleanup = (): boolean => {
    if (removed === durableRemoved) return true;
    if (!fsyncDirectory(directory.path) || !sameDirectory(directory)) return false;
    durableRemoved = removed;
    return true;
  };
  const looseKeys = looseAuthorityKeys(directory);
  if (!looseKeys) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  for (const pairKey of looseKeys) {
    const packedPair = packed.pairs.get(pairKey);
    if (!packedPair) continue;
    const cleanup = cleanupPackedOverlapUnlocked(directory, packedPair);
    removed += cleanup.removed;
    if (!cleanup.ok) {
      return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
    }
    if (removed - durableRemoved >= MAX_PACK_CANDIDATES && !flushCleanup()) {
      return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
    }
  }
  if (!flushCleanup()) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
  }
  const loose = collectLooseTerminalPairs(directory, key);
  if (loose.invalid) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  }

  const unpacked: TerminalPackEntry[] = [];
  for (const pair of loose.pairs) {
    const pairKey = `${pair.prepared.scopeHash}:${pair.prepared.effectId}`;
    const existing = packed.pairs.get(pairKey);
    if (existing) {
      if (!samePackEntry(existing, pair)) {
        return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
      }
      const cleanup = cleanupPackedOverlapUnlocked(directory, pair);
      removed += cleanup.removed;
      if (!cleanup.ok) {
        return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
      }
      if (removed - durableRemoved >= MAX_PACK_CANDIDATES && !flushCleanup()) {
        return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
      }
    } else if (unpacked.length < MAX_PACK_ENTRIES) {
      unpacked.push(pair);
    }
  }
  if (!flushCleanup()) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
  }
  if (unpacked.length === 0) {
    return {
      ok: true,
      reason: removed > 0 ? 'compacted' : 'nothing-to-compact',
      packedRecords: 0,
      looseRecordsRemoved: removed,
    };
  }
  if (packed.commits.length >= MAX_PACKS) {
    return { ok: false, reason: 'capacity', packedRecords: 0, looseRecordsRemoved: removed };
  }
  const underfilledPacks = packed.commits.filter((commit) => commit.entryCount < MAX_PACK_ENTRIES).length;
  if (unpacked.length < MAX_PACK_ENTRIES && underfilledPacks >= MAX_UNDERFILLED_PACKS) {
    return { ok: false, reason: 'capacity', packedRecords: 0, looseRecordsRemoved: removed };
  }
  if (!ensureFormatFloorUnlocked(directory, key)) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
  }

  const createdAt = new Date().toISOString();
  const packId = terminalPackId(createdAt, unpacked);
  const pack: TerminalPackRecord = {
    schemaVersion: 1,
    recordType: 'terminal-pack',
    packId,
    createdAt,
    entries: unpacked,
  };
  const packBytes = Buffer.from(`${JSON.stringify(pack)}\n`, 'utf8');
  if (packBytes.length > MAX_PACK_BYTES || !strictTerminalPack(pack, key)) {
    return { ok: false, reason: 'capacity', packedRecords: 0, looseRecordsRemoved: removed };
  }
  if (!writeImmutableAuthorityBytes(
    terminalPackPath(directory, packId), packBytes, MAX_PACK_BYTES, directory,
  )) return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };

  const previous = packed.commits.at(-1);
  const unsignedMarker = {
    schemaVersion: 1 as const,
    recordType: 'terminal-pack-commit' as const,
    sequence: (previous?.sequence ?? 0) + 1,
    packId,
    packDigest: createHash('sha256').update(packBytes).digest('hex'),
    packBytes: packBytes.length,
    entryCount: unpacked.length,
    scopeBloom: packBloom(unpacked.map((entry) => entry.prepared.scopeHash)),
    effectBloom: packBloom(unpacked.map((entry) => entry.prepared.effectId)),
    previousCommitAttestation: previous?.attestation ?? ZERO_DIGEST,
    committedAt: new Date().toISOString(),
  };
  const markerAttestation = packCommitAttestation(unsignedMarker, true, key);
  if (!markerAttestation) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
  }
  const marker: TerminalPackCommitRecord = { ...unsignedMarker, attestation: markerAttestation };
  const markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
  if (!strictPackCommit(marker, key) || !writeImmutableAuthorityBytes(
    terminalPackCommitPath(directory, marker.sequence, packId),
    markerBytes,
    MAX_PACK_COMMIT_BYTES,
    directory,
  )) return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };

  const committed = readEffectJournalUnlocked(directory, MAX_LOGICAL_RECORDS);
  if (committed.sourceState === 'degraded' || committed.limitExceeded) {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
  }
  const committedById = new Map(committed.records.map((record) => [record.effectId, record]));
  for (const pair of unpacked) {
    const observed = committedById.get(pair.prepared.effectId);
    if (!observed || !sameRecord(observed, pair.terminal)) {
      return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: removed };
    }
  }
  for (const pair of unpacked) {
    const cleanup = cleanupPackedOverlapUnlocked(directory, pair);
    removed += cleanup.removed;
    if (!cleanup.ok) {
      return {
        ok: false,
        reason: 'degraded',
        packedRecords: unpacked.length,
        looseRecordsRemoved: removed,
        packId,
      };
    }
    if (removed - durableRemoved >= MAX_PACK_CANDIDATES && !flushCleanup()) {
      return {
        ok: false,
        reason: 'degraded',
        packedRecords: unpacked.length,
        looseRecordsRemoved: removed,
        packId,
      };
    }
  }
  if (!flushCleanup()) {
    return {
      ok: false,
      reason: 'degraded',
      packedRecords: unpacked.length,
      looseRecordsRemoved: removed,
      packId,
    };
  }
  for (const pair of unpacked) {
    const prepared = readRecord(
      recordPath(directory, pair.prepared.scopeHash, pair.prepared.effectId),
      directory,
      pair.prepared.scopeHash,
      pair.prepared.effectId,
      key,
    );
    const terminal = readRecord(
      terminalPath(directory, pair.prepared.scopeHash, pair.prepared.effectId),
      directory,
      pair.prepared.scopeHash,
      pair.prepared.effectId,
      key,
    );
    if (
      prepared === 'absent' || prepared === 'invalid' || !sameRecord(prepared, pair.prepared) ||
      terminal !== 'absent'
    ) {
      return {
        ok: false,
        reason: 'degraded',
        packedRecords: unpacked.length,
        looseRecordsRemoved: removed,
        packId,
      };
    }
  }
  return {
    ok: true,
    reason: 'compacted',
    packedRecords: unpacked.length,
    looseRecordsRemoved: removed,
    packId,
  };
}

export function compactEffectJournal(): EffectJournalCompactionResult {
  if (!effectJournalCompactionSupported()) {
    return { ok: false, reason: 'unsupported', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  if (!existsSync(effectJournalDirectory())) {
    return { ok: true, reason: 'nothing-to-compact', packedRecords: 0, looseRecordsRemoved: 0 };
  }
  let lock: LocalStoreLock | null = null;
  try {
    const directory = ensureDirectory();
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
    const key = attestationKey(false);
    if (!key) return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
    return compactTerminalEffectsUnlocked(directory, key);
  } catch {
    return { ok: false, reason: 'degraded', packedRecords: 0, looseRecordsRemoved: 0 };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

export function readEffectJournal(limit = 1_000): EffectJournalReadResult {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS) {
    return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: true };
  }
  if (!existsSync(effectJournalDirectory())) {
    return { records: [], sourceState: 'missing', invalidRecords: 0, limitExceeded: false };
  }
  let lock: LocalStoreLock | null = null;
  try {
    const directory = ensureDirectory();
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
    return readEffectJournalUnlocked(directory, limit);
  } catch {
    return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Bounded exact-effect inspection that is isolated from unrelated scope damage. */
export function readEffectRecord(effectId: string): EffectJournalReadResult {
  if (!SHA256_RE.test(effectId)) {
    return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
  }
  if (!existsSync(effectJournalDirectory())) {
    return { records: [], sourceState: 'missing', invalidRecords: 0, limitExceeded: false };
  }
  let lock: LocalStoreLock | null = null;
  try {
    const directory = ensureDirectory();
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
    return readEffectJournalUnlocked(directory, 2, undefined, effectId);
  } catch {
    return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

/** Conservative finalization guard: degraded evidence is always unresolved. */
export function hasUnresolvedToolEffects(scopeId: string, generation: string): boolean {
  if (!safeId(scopeId) || !safeId(generation)) return true;
  const scopeHash = hash([EFFECT_DOMAIN, 'scope', scopeId.toLowerCase()]);
  const processScopePrefix = `${effectJournalDirectory()}:${scopeHash}:`;
  const processScopeUncertain = [...processUncertainEffects].some((key) => key.startsWith(processScopePrefix));
  const processScopeObserved = [...processObservedEffects]
    .filter((key) => key.startsWith(processScopePrefix))
    .map((key) => key.slice(processScopePrefix.length));
  if (!existsSync(effectJournalDirectory())) {
    return processScopeUncertain || processScopeObserved.length > 0;
  }
  let lock: LocalStoreLock | null = null;
  try {
    const directory = ensureDirectory();
    lock = acquireLocalStoreLock(journalLockPath(directory), LOCK_WAIT_MS);
    if (!lock) return true;
    const result = readEffectJournalUnlocked(directory, MAX_RECORDS, scopeHash);
    const persistedIds = new Set(result.records.map((record) => record.effectId));
    const observedEvidenceMissing = processScopeObserved.some((effectId) => !persistedIds.has(effectId));
    return processScopeUncertain || result.sourceState === 'degraded' || result.limitExceeded ||
      observedEvidenceMissing || result.records.some((record) => record.phase !== 'committed');
  } catch {
    return true;
  } finally {
    releaseLocalStoreLock(lock);
  }
}
