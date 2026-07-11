import { createHash, randomBytes } from 'node:crypto';
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
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { DispatchProductionEvent } from './dispatch-production-ledger.js';
import type { EngineId, EngineTier, WorkSource } from '../types.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_ROW_BYTES = 2_048;
const SHA256_RE = /^[a-f0-9]{64}$/;
const WORK_SOURCES = new Set<WorkSource>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

export type RepairHandoffKind = 'capture-repair' | 'no-diff-reslice';

export interface RepairHandoffObservation {
  schemaVersion: 1;
  eventId: string;
  generationId: string;
  childItemId: string;
  ts: string;
  kind: RepairHandoffKind;
  repo: string;
  parentItemId: string;
  parentOutcome: 'proposal-capture-error' | 'gate-blocked' | 'empty-diff';
  parentAttemptId: string;
  parentSource?: WorkSource;
  parentBackend?: EngineId | null;
  parentTier?: EngineTier | null;
  parentObjectiveHash?: string;
  parentRunId?: string;
  parentTrajectoryId?: string;
  diffFiles?: number;
  diffLines?: number;
}

export interface RepairHandoffWriteResult {
  attempted: number;
  recorded: number;
  failed: number;
}

export interface RepairHandoffReadResult {
  observations: RepairHandoffObservation[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  invalidRows: number;
  conflictingIds: number;
  limitExceeded: boolean;
  physicalRows: number;
}

export interface RepairHandoffCompactionResult {
  available: boolean;
  before: number;
  after: number;
  removed: number;
}

export function repairHandoffJournalPath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'repair-handoffs.jsonl');
}

function repairHandoffLockPath(): string {
  return `${repairHandoffJournalPath()}.lock`;
}

function privateOwner(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function validIdentity(value: string): boolean {
  const candidate: unknown = value;
  if (isSafeExecutionIdentity(candidate)) return true;
  return value.startsWith('run:') && isSafeExecutionIdentity(value.slice(4));
}

function count(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1_000_000, Math.trunc(value)));
}

function safeItemId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 180) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function semanticEventId(fields: Pick<
  RepairHandoffObservation,
  'kind' | 'repo' | 'parentItemId' | 'parentOutcome' | 'parentAttemptId'
>): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:repair-handoff:v1', fields.kind, fields.repo, fields.parentItemId,
    fields.parentOutcome, fields.parentAttemptId,
  ])).digest('hex');
}

function childItemId(kind: RepairHandoffKind, repo: string, parentItemId: string): string {
  const domain = kind === 'capture-repair'
    ? 'dispatch-capture-gate-repair'
    : 'dispatch-no-diff-reslice';
  const prefix = kind === 'capture-repair' ? 'proposal-repair-capture' : 'proposal-repair-nodiff';
  const hash = createHash('sha1')
    .update(`${resolve(repo)}\0${parentItemId}\0${domain}`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:${prefix}:${hash}`;
}

export function repairGenerationIdFromHandoffId(eventId: string): string | null {
  if (!SHA256_RE.test(eventId)) return null;
  return createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-handoff-generation:v1', eventId]))
    .digest('hex');
}

function eligibleKind(event: DispatchProductionEvent): RepairHandoffKind | null {
  if (
    event.basis !== 'run-proposal-outcome' ||
    event.proposalCreated !== false ||
    event.proposalId ||
    !event.repo ||
    !event.itemId ||
    /\b(?:proposal-repair|dispatch-capture-repair|proposal-repair-capture|proposal-repair-nodiff|diagnostic-reslice|no-diff-reslice)\b/i
      .test(`${event.itemId}\n${event.title}`)
  ) return null;
  if (event.outcome === 'empty-diff') {
    if (event.learningLabel && event.learningLabel.learningKind !== 'diagnostic-no-proposal') return null;
    return 'no-diff-reslice';
  }
  if (event.source !== 'self') return null;
  if (event.outcome === 'proposal-capture-error') return 'capture-repair';
  if (event.outcome !== 'gate-blocked') return null;
  const actions = event.runEventSummary?.actionCounts;
  if (
    (actions?.completenessGateRuns ?? 0) > 0 ||
    (actions?.diffFiles ?? 0) > 0 ||
    (event.diffFiles ?? 0) > 0 ||
    /\b(?:capture|completeness|gate)\b/i.test(`${event.reason ?? ''}\n${event.routeReason ?? ''}`)
  ) {
    return 'capture-repair';
  }
  return null;
}

export function repairHandoffFromDispatchEvent(
  event: DispatchProductionEvent,
): RepairHandoffObservation | null {
  const kind = eligibleKind(event);
  if (!kind) return null;
  const parsedTs = Date.parse(event.ts);
  if (!Number.isFinite(parsedTs)) return null;
  let repo: string;
  try { repo = resolve(event.repo); } catch { return null; }
  if (!safeItemId(event.itemId)) return null;
  const parentAttemptId = event.trajectoryId ?? event.runId;
  if (!parentAttemptId || !validIdentity(parentAttemptId)) return null;
  if (event.runId && !validIdentity(event.runId)) return null;
  if (event.trajectoryId && !validIdentity(event.trajectoryId)) return null;
  const ts = new Date(parsedTs).toISOString();
  const semantic = {
    kind,
    repo,
    parentItemId: event.itemId,
    parentOutcome: event.outcome as RepairHandoffObservation['parentOutcome'],
    parentAttemptId,
    ts,
  };
  const eventId = semanticEventId(semantic);
  const generationId = repairGenerationIdFromHandoffId(eventId)!;
  return {
    schemaVersion: 1,
    eventId,
    generationId,
    childItemId: childItemId(kind, repo, event.itemId),
    ts,
    kind,
    repo,
    parentItemId: semantic.parentItemId,
    parentOutcome: semantic.parentOutcome,
    parentAttemptId,
    parentSource: event.source,
    parentBackend: event.backend,
    parentTier: event.tier,
    ...(typeof event.objectiveHash === 'string' && SHA256_RE.test(event.objectiveHash)
      ? { parentObjectiveHash: event.objectiveHash }
      : {}),
    ...(event.runId ? { parentRunId: event.runId } : {}),
    ...(event.trajectoryId ? { parentTrajectoryId: event.trajectoryId } : {}),
    ...(count(event.diffFiles) !== undefined ? { diffFiles: count(event.diffFiles) } : {}),
    ...(count(event.diffLines) !== undefined ? { diffLines: count(event.diffLines) } : {}),
  };
}

function validObservation(value: unknown): value is RepairHandoffObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (
    row['schemaVersion'] !== 1 ||
    typeof row['eventId'] !== 'string' || !SHA256_RE.test(row['eventId']) ||
    typeof row['generationId'] !== 'string' || !SHA256_RE.test(row['generationId']) ||
    !safeItemId(row['childItemId']) ||
    typeof row['ts'] !== 'string' || !Number.isFinite(Date.parse(row['ts'])) ||
    (row['kind'] !== 'capture-repair' && row['kind'] !== 'no-diff-reslice') ||
    typeof row['repo'] !== 'string' || row['repo'].length < 1 || row['repo'].length > 1_024 ||
    !safeItemId(row['parentItemId']) ||
    (row['parentOutcome'] !== 'proposal-capture-error' && row['parentOutcome'] !== 'gate-blocked' && row['parentOutcome'] !== 'empty-diff') ||
    typeof row['parentAttemptId'] !== 'string' || !validIdentity(row['parentAttemptId'])
  ) return false;
  if (row['kind'] === 'no-diff-reslice' && row['parentOutcome'] !== 'empty-diff') return false;
  if (row['kind'] === 'capture-repair' && row['parentOutcome'] === 'empty-diff') return false;
  const parentProvenanceFields = ['parentSource', 'parentBackend', 'parentTier'] as const;
  const parentProvenanceCount = parentProvenanceFields.filter((key) => row[key] !== undefined).length;
  if (parentProvenanceCount !== 0 && parentProvenanceCount !== parentProvenanceFields.length) return false;
  if (row['parentObjectiveHash'] !== undefined && !SHA256_RE.test(String(row['parentObjectiveHash']))) return false;
  if (row['parentObjectiveHash'] !== undefined && parentProvenanceCount !== parentProvenanceFields.length) return false;
  if (row['parentSource'] !== undefined && !WORK_SOURCES.has(row['parentSource'] as WorkSource)) return false;
  if (
    row['parentBackend'] !== undefined && row['parentBackend'] !== null &&
    !ENGINE_IDS.has(row['parentBackend'] as EngineId)
  ) return false;
  if (
    row['parentTier'] !== undefined && row['parentTier'] !== null &&
    !ENGINE_TIERS.has(row['parentTier'] as EngineTier)
  ) return false;
  for (const key of ['parentRunId', 'parentTrajectoryId'] as const) {
    const field = row[key];
    if (field !== undefined && (typeof field !== 'string' || !validIdentity(field))) return false;
  }
  for (const key of ['diffFiles', 'diffLines'] as const) {
    const field = row[key];
    if (field !== undefined && (!Number.isInteger(field) || Number(field) < 0 || Number(field) > 1_000_000)) return false;
  }
  const observation = row as unknown as RepairHandoffObservation;
  if (observation.eventId !== semanticEventId(observation)) return false;
  if (observation.generationId !== repairGenerationIdFromHandoffId(observation.eventId)) return false;
  if (observation.childItemId !== childItemId(observation.kind, observation.repo, observation.parentItemId)) return false;
  return true;
}

function observationFingerprint(row: RepairHandoffObservation): string {
  return JSON.stringify([
    row.eventId,
    row.generationId,
    row.childItemId,
    row.kind,
    row.repo,
    row.parentItemId,
    row.parentOutcome,
    row.parentAttemptId,
    row.parentRunId ?? null,
    row.parentTrajectoryId ?? null,
  ]);
}

function hasParentProvenance(row: RepairHandoffObservation): boolean {
  return row.parentSource !== undefined || row.parentBackend !== undefined || row.parentTier !== undefined;
}

function sameParentProvenance(left: RepairHandoffObservation, right: RepairHandoffObservation): boolean {
  return left.parentSource === right.parentSource &&
    left.parentBackend === right.parentBackend &&
    left.parentTier === right.parentTier;
}

function ensurePrivatePath(path: string): Stats {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || !privateOwner(dirStat.uid)) {
    throw new Error('unsafe repair handoff directory');
  }
  chmodSync(dir, 0o700);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || !privateOwner(stat.uid) || stat.nlink !== 1) {
      throw new Error('unsafe repair handoff journal');
    }
  }
  return dirStat;
}

function appendObservation(observation: RepairHandoffObservation): boolean {
  const path = repairHandoffJournalPath();
  const lock = acquireLocalStoreLock(repairHandoffLockPath());
  if (!lock) return false;
  let fd: number | undefined;
  try {
    const directory = ensurePrivatePath(path);
    const before = existsSync(path) ? lstatSync(path) : undefined;
    fd = openSync(path, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    const bytes = Buffer.from(`\n${JSON.stringify(observation)}\n`, 'utf8');
    if (!stat.isFile() || !privateOwner(stat.uid) || stat.nlink !== 1 || stat.size + bytes.length > MAX_FILE_BYTES) return false;
    if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) return false;
    fchmodSync(fd, 0o600);
    if (bytes.length > MAX_ROW_BYTES) return false;
    if (writeSync(fd, bytes) !== bytes.length) return false;
    fsyncSync(fd);
    const persisted = fstatSync(fd);
    const authoritative = lstatSync(path);
    const currentDirectory = lstatSync(dirname(path));
    if (
      persisted.nlink !== 1 || authoritative.isSymbolicLink() || !authoritative.isFile() ||
      authoritative.dev !== persisted.dev || authoritative.ino !== persisted.ino ||
      currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino
    ) return false;
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(path), fsConstants.O_RDONLY);
      fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

export function recordRepairHandoffs(
  events: DispatchProductionEvent | DispatchProductionEvent[],
): RepairHandoffWriteResult {
  const result: RepairHandoffWriteResult = { attempted: 0, recorded: 0, failed: 0 };
  for (const event of Array.isArray(events) ? events : [events]) {
    const observation = repairHandoffFromDispatchEvent(event);
    if (!observation) continue;
    result.attempted += 1;
    if (appendObservation(observation)) result.recorded += 1;
    else result.failed += 1;
  }
  return result;
}

export function readRepairHandoffs(): RepairHandoffReadResult {
  const path = repairHandoffJournalPath();
  if (!existsSync(path)) {
    return { observations: [], sourceState: 'missing', invalidRows: 0, conflictingIds: 0, limitExceeded: false, physicalRows: 0 };
  }
  let fd: number | undefined;
  try {
    ensurePrivatePath(path);
    const before = lstatSync(path);
    if (before.size > MAX_FILE_BYTES || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) {
      return { observations: [], sourceState: 'degraded', invalidRows: 0, conflictingIds: 0, limitExceeded: true, physicalRows: 0 };
    }
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || !privateOwner(opened.uid) || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('repair handoff journal changed during open');
    }
    const bytes = Buffer.alloc(opened.size);
    const read = opened.size > 0 ? readSync(fd, bytes, 0, bytes.length, 0) : 0;
    const text = bytes.subarray(0, read).toString('utf8');
    const completeLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n').slice(0, -1);
    const byId = new Map<string, { fingerprint: string; row: RepairHandoffObservation; conflict: boolean }>();
    let invalidRows = text.endsWith('\n') ? 0 : 1;
    const physicalRows = completeLines.filter(Boolean).length;
    const limitExceeded = physicalRows > MAX_RECORDS;
    for (const line of completeLines) {
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) { invalidRows += 1; continue; }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!validObservation(parsed)) { invalidRows += 1; continue; }
        const fingerprint = observationFingerprint(parsed);
        const existing = byId.get(parsed.eventId);
        if (!existing) byId.set(parsed.eventId, { fingerprint, row: parsed, conflict: false });
        else if (existing.fingerprint !== fingerprint) existing.conflict = true;
        else if (
          hasParentProvenance(existing.row) &&
          hasParentProvenance(parsed) &&
          !sameParentProvenance(existing.row, parsed)
        ) existing.conflict = true;
        else if (existing.row.parentObjectiveHash !== parsed.parentObjectiveHash) existing.conflict = true;
        else if (!hasParentProvenance(existing.row) && hasParentProvenance(parsed)) {
          // Routing provenance may enrich a legacy row because it only restores
          // the route that created the same semantic event.
          existing.row = parsed;
        }
      } catch { invalidRows += 1; }
    }
    const conflictingIds = [...byId.values()].filter((entry) => entry.conflict).length;
    const observations = [...byId.values()]
      .filter((entry) => !entry.conflict)
      .map((entry) => entry.row)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size) {
      throw new Error('repair handoff journal changed during read');
    }
    return {
      observations,
      // The row threshold is an observability/compaction signal, not an
      // authority failure: every row was still parsed under the byte cap.
      sourceState: invalidRows > 0 || conflictingIds > 0 ? 'degraded' : 'healthy',
      invalidRows,
      conflictingIds,
      limitExceeded,
      physicalRows,
    };
  } catch {
    return { observations: [], sourceState: 'degraded', invalidRows: 1, conflictingIds: 0, limitExceeded: false, physicalRows: 0 };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

export function compactRepairHandoffs(): RepairHandoffCompactionResult {
  const path = repairHandoffJournalPath();
  const lock = acquireLocalStoreLock(repairHandoffLockPath());
  if (!lock) return { available: false, before: 0, after: 0, removed: 0 };
  let tmp: string | undefined;
  let fd: number | undefined;
  try {
    const read = readRepairHandoffs();
    if (read.conflictingIds > 0) {
      return { available: false, before: read.physicalRows, after: 0, removed: 0 };
    }
    // Preserve every semantic event id: old fingerprints are the immutable
    // conflict history that prevents a later replay from minting new authority.
    // Compaction only removes physical replays and invalid/torn rows.
    const compacted = read.observations.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    if (compacted.length === read.physicalRows) {
      return { available: true, before: read.physicalRows, after: compacted.length, removed: 0 };
    }
    const directory = ensurePrivatePath(path);
    tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const bytes = Buffer.from(compacted.map((row) => JSON.stringify(row)).join('\n') + (compacted.length ? '\n' : ''), 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short repair handoff compaction write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    const compactedFile = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    tmp = undefined;
    const authoritative = lstatSync(path);
    const currentDirectory = lstatSync(dirname(path));
    if (
      authoritative.isSymbolicLink() || !authoritative.isFile() || authoritative.nlink !== 1 ||
      authoritative.dev !== compactedFile.dev || authoritative.ino !== compactedFile.ino ||
      currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino
    ) throw new Error('repair handoff compaction path changed');
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dirname(path), fsConstants.O_RDONLY);
      fsyncSync(dirFd);
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
    return {
      available: true,
      before: read.physicalRows,
      after: compacted.length,
      removed: read.physicalRows - compacted.length,
    };
  } catch {
    return { available: false, before: 0, after: 0, removed: 0 };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    if (tmp) { try { unlinkSync(tmp); } catch { /* absent */ } }
    releaseLocalStoreLock(lock);
  }
}

export function dispatchEventFromRepairHandoff(
  observation: RepairHandoffObservation,
): DispatchProductionEvent {
  return {
    schemaVersion: 1,
    ts: observation.ts,
    itemId: observation.parentItemId,
    source: observation.parentSource ?? 'self',
    repo: observation.repo,
    title: '',
    backend: observation.parentBackend ?? null,
    tier: observation.parentTier ?? null,
    ...(observation.parentObjectiveHash ? { objectiveHash: observation.parentObjectiveHash } : {}),
    assignedBy: 'repair-handoff-journal',
    routeReason: 'durable-parent-handoff',
    outcome: observation.kind === 'capture-repair' ? 'proposal-capture-error' : 'empty-diff',
    proposalCreated: false,
    ...(observation.parentRunId ? { runId: observation.parentRunId } : {}),
    ...(observation.parentTrajectoryId ? { trajectoryId: observation.parentTrajectoryId } : {}),
    spentUsd: 0,
    ...(observation.diffFiles !== undefined ? { diffFiles: observation.diffFiles } : {}),
    ...(observation.diffLines !== undefined ? { diffLines: observation.diffLines } : {}),
    basis: 'run-proposal-outcome',
    repairHandoffId: observation.eventId,
    repairGenerationId: observation.generationId,
  };
}
