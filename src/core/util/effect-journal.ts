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
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
const SHA256_RE = /^[a-f0-9]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/;
const MAX_RECORD_BYTES = 2_048;
const MAX_RECORDS = 25_000;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_OUTCOME_BYTES = 1024 * 1024;
const MAX_ARGUMENT_NODES = 10_000;
const MAX_ARGUMENT_DEPTH = 32;
const LOCK_WAIT_MS = 2_000;
const LIVE_OWNER_PROBE_WAIT_MS = 0;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
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

function recordAttestation(
  record: Omit<EffectRecord, 'attestation'>,
  createKey = false,
  suppliedKey?: Buffer,
): string | null {
  try {
    const key = suppliedKey ?? attestationKey(createKey);
    if (!key) return null;
    return createHmac('sha256', key)
      .update(JSON.stringify([ATTESTATION_DOMAIN, record]))
      .digest('hex');
  } catch {
    return null;
  }
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
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
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

function readRecord(
  path: string,
  directory: JournalDirectory,
  expectedScopeHash: string,
  expectedEffectId: string,
  key?: Buffer,
  pathsAssured = false,
): 'absent' | 'invalid' | EffectRecord {
  let fd: number | undefined;
  try {
    if (!sameDirectory(directory)) return 'invalid';
    const before = lstatSync(path);
    if (
      before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || !owned(before.uid) ||
      before.size < 2 || before.size > MAX_RECORD_BYTES ||
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
    const record = strictRecord(JSON.parse(bytes.toString('utf8')), key);
    return record && record.scopeHash === expectedScopeHash && record.effectId === expectedEffectId
      ? record
      : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'invalid';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
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
    fd = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(fd);
    return true;
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

function atCapacity(directory: JournalDirectory): boolean {
  let count = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
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
    if (!attestationKey(true)) return { ok: false, reason: 'unavailable' };
    const scopeState = readEffectJournalUnlocked(directory, MAX_RECORDS, identity.scopeHash);
    if (scopeState.sourceState === 'degraded' || scopeState.limitExceeded) {
      return { ok: false, reason: 'unavailable' };
    }
    const path = recordPath(directory, identity.scopeHash, identity.effectId);
    const existing = readEffectiveRecord(directory, identity.scopeHash, identity.effectId);
    if (existing === 'invalid') return { ok: false, reason: 'unavailable' };
    if (existing !== 'absent') return { ok: false, reason: 'duplicate', phase: existing.phase };
    if (processObservedEffects.has(processKey)) return { ok: false, reason: 'unavailable' };
    if (atCapacity(directory)) return { ok: false, reason: 'capacity' };
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
    const attestation = recordAttestation(unsigned, true);
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
    const attestation = recordAttestation(unsigned, true);
    const terminal = attestation === null ? null : { ...unsigned, attestation };
    const committed = terminal !== null && strictRecord(terminal) !== null &&
      writeRecord(terminalPath(directory, effect.scopeHash, effect.effectId), terminal, directory);
    if (committed) processUncertainEffects.delete(processKey);
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
    const attestation = recordAttestation(unsigned, true);
    const terminal = attestation === null ? null : { ...unsigned, attestation };
    return terminal !== null && strictRecord(terminal) !== null &&
      writeRecord(terminalPath(directory, current.scopeHash, input.effectId), terminal, directory);
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(lock);
    releaseLocalStoreLock(liveLock);
  }
}

function readEffectJournalUnlocked(
  directory: JournalDirectory,
  limit: number,
  scopeFilter?: string,
): EffectJournalReadResult {
  const key = attestationKey(false);
  if (!key) return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: false };
  const baseEntries: Array<{ name: string; scopeHash: string; effectId: string }> = [];
  const terminalEntries = new Map<string, string>();
  let structuralInvalid = 0;
  let physicalRecords = 0;
  const dir = opendirSync(directory.path);
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      const base = /^\.effect-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      const terminal = /^\.terminal-v1-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(entry.name);
      const match = base ?? terminal;
      if (!match) {
        if (entry.name.startsWith('.effect-') || entry.name.startsWith('.terminal-') ||
          entry.name.startsWith('.format-')) structuralInvalid += 1;
        continue;
      }
      if (scopeFilter && match[1] !== scopeFilter) continue;
      physicalRecords += 1;
      if (physicalRecords > MAX_RECORDS * 2) {
        return { records: [], sourceState: 'degraded', invalidRecords: 0, limitExceeded: true };
      }
      if (base) baseEntries.push({ name: entry.name, scopeHash: base[1]!, effectId: base[2]! });
      else terminalEntries.set(`${terminal![1]}:${terminal![2]}`, entry.name);
    }
  } finally {
    dir.closeSync();
  }

  baseEntries.sort((a, b) => a.name.localeCompare(b.name));
  const baseIds = new Set(baseEntries.map((entry) => `${entry.scopeHash}:${entry.effectId}`));
  let invalidRecords = structuralInvalid;
  for (const terminalId of terminalEntries.keys()) {
    if (!baseIds.has(terminalId)) invalidRecords += 1;
  }
  const limitExceeded = baseEntries.length > limit;
  const selectedEntries = baseEntries.slice(0, limit);
  const matchedPaths: string[] = [];
  for (const entry of selectedEntries) {
    matchedPaths.push(join(directory.path, entry.name));
    const terminalName = terminalEntries.get(`${entry.scopeHash}:${entry.effectId}`);
    if (terminalName) matchedPaths.push(join(directory.path, terminalName));
  }

  for (let index = 0; index < matchedPaths.length; index += 512) {
    const assurance = assurePrivateStoragePaths(matchedPaths.slice(index, index + 512), {
      anchorPath: stateRoot(),
    });
    if (!assurance.ok) {
      return { records: [], sourceState: 'degraded', invalidRecords: 1, limitExceeded: false };
    }
  }

  const records: EffectRecord[] = [];
  for (const entry of selectedEntries) {
    const record = readEffectiveRecord(directory, entry.scopeHash, entry.effectId, key, true);
    if (record === 'absent' || record === 'invalid') invalidRecords += 1;
    else records.push(record);
  }
  records.sort((a, b) => a.preparedAt.localeCompare(b.preparedAt) || a.effectId.localeCompare(b.effectId));
  return {
    records,
    sourceState: invalidRecords > 0 || limitExceeded ? 'degraded' : 'healthy',
    invalidRecords,
    limitExceeded,
  };
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
    const located = findScopeHashForEffect(directory, effectId);
    if (located.kind === 'conflict') {
      return { records: [], sourceState: 'degraded', invalidRecords: 1, limitExceeded: false };
    }
    if (located.kind === 'absent') {
      return { records: [], sourceState: 'healthy', invalidRecords: 0, limitExceeded: false };
    }
    const result = readEffectJournalUnlocked(directory, MAX_RECORDS, located.scopeHash);
    return { ...result, records: result.records.filter((record) => record.effectId === effectId) };
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
