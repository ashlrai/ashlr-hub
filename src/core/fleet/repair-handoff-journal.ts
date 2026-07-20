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
  type BigIntStats,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  canonicalDispatchRepoIdentity,
  recordDispatchProduction,
  readDispatchProductionParents,
  sanitizeDispatchProductionEvent,
  type DispatchProductionEvent,
  type DispatchProductionParentStatus,
} from './dispatch-production-ledger.js';
import {
  repairGenerationIdFromHandoffId,
  repairTreatmentForUnitId,
  repairTreatmentUnitId,
} from './generated-repair-identity.js';
import type { EngineId, EngineTier, RepairTreatment, WorkItem, WorkSource } from '../types.js';
import { existingWorkItemObjectiveHash } from './work-item-objective.js';
import { isSafeExecutionIdentity } from './attempt-identity.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { assurePrivateStoragePath, type PrivateStorageMode } from '../util/private-storage.js';
import { fsyncDirectory as fsyncDirectoryDurably } from '../util/durability.js';

const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_ROW_BYTES = 2_048;
const PARENT_AUTHORITY_RETRY_MS = 10;
const PARENT_AUTHORITY_RETRIES = 200;
const PARENT_AUTHORITY_RETRY_SLEEP = new Int32Array(new SharedArrayBuffer(4));
const SHA256_RE = /^[a-f0-9]{64}$/;
const WORK_SOURCES = new Set<WorkSource>([
  'issue', 'todo', 'test', 'dep', 'doc', 'security', 'plugin', 'self', 'lint', 'goal', 'hygiene', 'invent',
]);
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes', 'kimi', 'nim', 'opencode', 'grok',
]);
const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

export type RepairHandoffKind = 'capture-repair' | 'no-diff-reslice';

interface RepairHandoffObservationBase {
  eventId: string;
  generationId: string;
  repairTreatmentUnitId?: string;
  repairTreatment?: RepairTreatment;
  childItemId: string;
  ts: string;
  kind: RepairHandoffKind;
  repo: string;
  parentItemId: string;
  parentOutcome: 'proposal-capture-error' | 'gate-blocked' | 'empty-diff';
  parentAttemptId: string;
  parentRunId?: string;
  parentTrajectoryId?: string;
  diffFiles?: number;
  diffLines?: number;
}

export interface RepairHandoffObservationV1 extends RepairHandoffObservationBase {
  schemaVersion: 1;
  parentSource?: WorkSource;
  parentBackend?: EngineId | null;
  parentTier?: EngineTier | null;
  parentObjectiveHash?: string;
}

export interface RepairHandoffObservationV2 extends RepairHandoffObservationBase {
  schemaVersion: 2;
  parentSource: WorkSource;
  parentBackend: EngineId | null;
  parentTier: EngineTier | null;
  parentObjectiveHash: string;
  /** Present only on rows emitted by an activation-aware writer. */
  writerActivationId?: string;
  writerActivatedAt?: string;
}

export type RepairHandoffObservation = RepairHandoffObservationV1 | RepairHandoffObservationV2;

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
  parentEvidenceQuarantine: RepairHandoffParentEvidenceQuarantine;
  limitExceeded: boolean;
  physicalRows: number;
  authorityDigest: string;
}

export interface RepairHandoffParentEvidenceQuarantine {
  missing: number;
  degraded: number;
  /** Bounded opaque event identities only; no parent content is retained. */
  samples: Array<{ eventId: string; status: 'missing' | 'degraded' }>;
}

export interface RepairHandoffCompactionResult {
  available: boolean;
  before: number;
  after: number;
  removed: number;
}

export interface RepairHandoffSchemaSummary {
  sourceState: RepairHandoffReadResult['sourceState'];
  v1Authorities: number;
  v2Authorities: number;
  v1PhysicalRows: number;
  v2PhysicalRows: number;
  invalidRows: number;
  conflictingIds: number;
  parentEvidenceQuarantine: RepairHandoffParentEvidenceQuarantine;
  limitExceeded: boolean;
  aliasFamilies: number;
  latestV2At: string | null;
  currentActivationV2Authorities: number;
  unboundV2Authorities: number;
  latestCurrentActivationV2At: string | null;
  currentActivationAuthorityDigest: string | null;
  authorityDigest: string;
}

/** Read-only selection state for repeated authoritative parent capture failures. */
export interface CaptureGateDispatchState {
  state: 'active' | 'terminal' | 'unavailable';
  authoritativeAttempts: number;
}

const MAX_PARENT_EVIDENCE_QUARANTINE_SAMPLES = 3;

function parentEvidenceQuarantine(
  rows: readonly RepairHandoffObservation[],
  statuses: readonly DispatchProductionParentStatus[],
): RepairHandoffParentEvidenceQuarantine {
  const byId = new Map<string, 'missing' | 'degraded'>();
  for (let index = 0; index < rows.length; index++) {
    const status = statuses[index];
    if (status !== 'missing' && status !== 'degraded') continue;
    const prior = byId.get(rows[index]!.eventId);
    byId.set(rows[index]!.eventId, prior === 'degraded' || status === 'degraded' ? 'degraded' : status);
  }
  const entries = [...byId.entries()].sort(([left], [right]) => left.localeCompare(right));
  return {
    missing: entries.filter(([, status]) => status === 'missing').length,
    degraded: entries.filter(([, status]) => status === 'degraded').length,
    samples: entries.slice(0, MAX_PARENT_EVIDENCE_QUARANTINE_SAMPLES)
      .map(([eventId, status]) => ({ eventId, status })),
  };
}

export interface RepairHandoffV2Activation {
  id: string;
  activatedAt: string;
}

type RepairHandoffJournalFaultPoint =
  | 'append-file-fsync'
  | 'append-path-verification'
  | 'append-directory-fsync';

let repairHandoffJournalFaultForTest:
  ((point: RepairHandoffJournalFaultPoint) => void) | undefined;

export function _setRepairHandoffJournalFaultForTest(
  hook: ((point: RepairHandoffJournalFaultPoint) => void) | undefined,
): void {
  repairHandoffJournalFaultForTest = hook;
}

export function repairHandoffJournalPath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'repair-handoffs.jsonl');
}

/**
 * Schema-v2 authority is isolated from the legacy journal so a rollback to a
 * v1-only binary can neither parse nor compact away objective-scoped rows.
 */
export function repairHandoffV2JournalPath(): string {
  return join(homedir(), '.ashlr', 'fleet', 'repair-handoffs-v2.jsonl');
}

function repairHandoffLockPath(path: string): string {
  return `${path}.lock`;
}

function privateOwner(uid: number | bigint): boolean {
  return typeof process.getuid !== 'function' || BigInt(process.getuid()) === BigInt(uid);
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
  'schemaVersion' | 'kind' | 'repo' | 'parentItemId' | 'parentOutcome' |
  'parentAttemptId' | 'parentObjectiveHash'
>): string {
  if (fields.schemaVersion === 2) {
    return createHash('sha256').update(JSON.stringify([
      'ashlr:repair-handoff:v2', fields.kind, fields.repo, fields.parentItemId,
      fields.parentObjectiveHash,
    ])).digest('hex');
  }
  return createHash('sha256').update(JSON.stringify([
    'ashlr:repair-handoff:v1', fields.kind, fields.repo, fields.parentItemId,
    fields.parentOutcome, fields.parentAttemptId,
  ])).digest('hex');
}

const ACTIVATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalRepairHandoffV2Activation(value: unknown): RepairHandoffV2Activation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || !ACTIVATION_ID_RE.test(row['id'])) return null;
  if (typeof row['activatedAt'] !== 'string') return null;
  const parsed = Date.parse(row['activatedAt']);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== row['activatedAt']) return null;
  return { id: row['id'].toLowerCase(), activatedAt: row['activatedAt'] };
}

export function validRepairHandoffV2Activation(value: unknown): value is RepairHandoffV2Activation {
  return canonicalRepairHandoffV2Activation(value) !== null;
}

function childItemId(kind: RepairHandoffKind, repo: string, parentItemId: string): string {
  const domain = kind === 'capture-repair'
    ? 'dispatch-capture-gate-repair'
    : 'dispatch-no-diff-reslice';
  const prefix = kind === 'capture-repair' ? 'proposal-repair-capture' : 'proposal-repair-nodiff';
  const hash = createHash('sha1')
    .update(`${repo}\0${parentItemId}\0${domain}`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:${prefix}:${hash}`;
}

export { repairGenerationIdFromHandoffId } from './generated-repair-identity.js';

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
  if (event.source !== 'self' && event.source !== 'issue' && event.source !== 'goal') return null;
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
  if (canonicalDispatchRepoIdentity(event.repo) === null) return null;
  const kind = eligibleKind(event);
  if (!kind) return null;
  try {
    event = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
  } catch {
    return null;
  }
  const parsedTs = Date.parse(event.ts);
  if (!Number.isFinite(parsedTs)) return null;
  const repo = canonicalDispatchRepoIdentity(event.repo);
  if (repo === null || repo !== event.repo) return null;
  if (!safeItemId(event.itemId)) return null;
  const parentAttemptId = event.trajectoryId ?? event.runId;
  if (!parentAttemptId || !validIdentity(parentAttemptId)) return null;
  if (event.runId && !validIdentity(event.runId)) return null;
  if (event.trajectoryId && !validIdentity(event.trajectoryId)) return null;
  if (event.runId && event.trajectoryId && event.trajectoryId !== `run:${event.runId}`) return null;
  if (typeof event.objectiveHash !== 'string' || !SHA256_RE.test(event.objectiveHash)) return null;
  const ts = new Date(parsedTs).toISOString();
  const semantic = {
    schemaVersion: 2 as const,
    kind,
    repo,
    parentItemId: event.itemId,
    parentOutcome: event.outcome as RepairHandoffObservation['parentOutcome'],
    parentAttemptId,
    parentObjectiveHash: event.objectiveHash,
    ts,
  };
  const eventId = semanticEventId(semantic);
  const generationId = repairGenerationIdFromHandoffId(eventId)!;
  const treatmentUnitId = kind === 'no-diff-reslice'
    ? repairTreatmentUnitId({
        kind,
        repo,
        parentItemId: semantic.parentItemId,
        parentObjectiveHash: semantic.parentObjectiveHash,
      })
    : null;
  const repairTreatment = treatmentUnitId ? repairTreatmentForUnitId(treatmentUnitId) : null;
  if (kind === 'no-diff-reslice' && (!treatmentUnitId || !repairTreatment)) return null;
  return {
    schemaVersion: 2,
    eventId,
    generationId,
    ...(kind === 'no-diff-reslice'
      ? { repairTreatmentUnitId: treatmentUnitId!, repairTreatment: repairTreatment! }
      : {}),
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
    parentObjectiveHash: event.objectiveHash,
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
    (row['schemaVersion'] !== 1 && row['schemaVersion'] !== 2) ||
    typeof row['eventId'] !== 'string' || !SHA256_RE.test(row['eventId']) ||
    typeof row['generationId'] !== 'string' || !SHA256_RE.test(row['generationId']) ||
    !safeItemId(row['childItemId']) ||
    typeof row['ts'] !== 'string' || !Number.isFinite(Date.parse(row['ts'])) ||
    (row['kind'] !== 'capture-repair' && row['kind'] !== 'no-diff-reslice') ||
    typeof row['repo'] !== 'string' || row['repo'].length < 1 || row['repo'].length > 1_024 ||
    canonicalDispatchRepoIdentity(row['repo']) !== row['repo'] ||
    !safeItemId(row['parentItemId']) ||
    (row['parentOutcome'] !== 'proposal-capture-error' && row['parentOutcome'] !== 'gate-blocked' && row['parentOutcome'] !== 'empty-diff') ||
    typeof row['parentAttemptId'] !== 'string' || !validIdentity(row['parentAttemptId'])
  ) return false;
  if (row['kind'] === 'no-diff-reslice' && row['parentOutcome'] !== 'empty-diff') return false;
  if (row['kind'] === 'capture-repair' && row['parentOutcome'] === 'empty-diff') return false;
  const treatmentMetadataPresent = row['repairTreatmentUnitId'] !== undefined || row['repairTreatment'] !== undefined;
  if (treatmentMetadataPresent && (
    row['kind'] !== 'no-diff-reslice' ||
    typeof row['repairTreatmentUnitId'] !== 'string' || !SHA256_RE.test(row['repairTreatmentUnitId']) ||
    (row['repairTreatment'] !== 'baseline-reslice' && row['repairTreatment'] !== 'target-localization')
  )) return false;
  const parentProvenanceFields = ['parentSource', 'parentBackend', 'parentTier'] as const;
  const parentProvenanceCount = parentProvenanceFields.filter((key) => row[key] !== undefined).length;
  if (parentProvenanceCount !== 0 && parentProvenanceCount !== parentProvenanceFields.length) return false;
  if (row['parentObjectiveHash'] !== undefined && !SHA256_RE.test(String(row['parentObjectiveHash']))) return false;
  if (row['parentObjectiveHash'] !== undefined && parentProvenanceCount !== parentProvenanceFields.length) return false;
  if (row['schemaVersion'] === 2 && (
    typeof row['parentObjectiveHash'] !== 'string' ||
    parentProvenanceCount !== parentProvenanceFields.length
  )) return false;
  if (row['schemaVersion'] === 2 && row['kind'] === 'no-diff-reslice' && !treatmentMetadataPresent) return false;
  if (row['schemaVersion'] === 2) {
    const activationPresent = row['writerActivationId'] !== undefined || row['writerActivatedAt'] !== undefined;
    if (activationPresent && !validRepairHandoffV2Activation({
      id: row['writerActivationId'],
      activatedAt: row['writerActivatedAt'],
    })) return false;
    if (activationPresent && Date.parse(String(row['writerActivatedAt'])) > Date.parse(String(row['ts']))) return false;
    try {
      if (new Date(Date.parse(String(row['ts']))).toISOString() !== row['ts']) return false;
    } catch {
      return false;
    }
  }
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
  if (row['schemaVersion'] === 2) {
    const runId = row['parentRunId'];
    const trajectoryId = row['parentTrajectoryId'];
    if (runId !== undefined && trajectoryId !== undefined && trajectoryId !== `run:${runId}`) return false;
    const authoritativeAttempt = trajectoryId ?? runId;
    if (authoritativeAttempt === undefined || row['parentAttemptId'] !== authoritativeAttempt) return false;
  }
  for (const key of ['diffFiles', 'diffLines'] as const) {
    const field = row[key];
    if (field !== undefined && (!Number.isInteger(field) || Number(field) < 0 || Number(field) > 1_000_000)) return false;
  }
  const observation = row as unknown as RepairHandoffObservation;
  if (treatmentMetadataPresent) {
    const expectedUnitId = repairTreatmentUnitId({
      kind: 'no-diff-reslice',
      repo: observation.repo,
      parentItemId: observation.parentItemId,
      parentObjectiveHash: observation.parentObjectiveHash!,
    });
    if (
      expectedUnitId === null ||
      observation.repairTreatmentUnitId !== expectedUnitId ||
      observation.repairTreatment !== repairTreatmentForUnitId(expectedUnitId)
    ) return false;
  }
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

function fullObservationFingerprint(row: RepairHandoffObservation): string {
  return JSON.stringify([
    row.schemaVersion,
    row.eventId,
    row.generationId,
    row.repairTreatmentUnitId ?? null,
    row.repairTreatment ?? null,
    row.childItemId,
    row.ts,
    row.kind,
    row.repo,
    row.parentItemId,
    row.parentOutcome,
    row.parentAttemptId,
    row.parentSource ?? null,
    row.parentBackend ?? null,
    row.parentTier ?? null,
    row.parentObjectiveHash ?? null,
    row.schemaVersion === 2 ? row.writerActivationId ?? null : null,
    row.schemaVersion === 2 ? row.writerActivatedAt ?? null : null,
    row.parentRunId ?? null,
    row.parentTrajectoryId ?? null,
    row.diffFiles ?? null,
    row.diffLines ?? null,
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

function safeRepairHandoffDirectory(stat: Stats | BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() && privateOwner(stat.uid);
}

function safeRepairHandoffJournal(stat: Stats | BigIntStats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && privateOwner(stat.uid) && stat.nlink === 1;
}

function assureRepairHandoffStoragePath(
  path: string,
  kind: 'file' | 'directory',
  mode: PrivateStorageMode,
  anchorPath: string,
): void {
  if (!assurePrivateStoragePath(
    path, kind, mode, { anchorPath },
  ).ok) throw new Error(`unsafe Windows repair handoff ${kind}`);
}

function assureRepairHandoffJournalFile(path: string, mode: PrivateStorageMode, opened: Stats): void {
  assureRepairHandoffStoragePath(path, 'file', mode, dirname(path));
  const named = lstatSync(path);
  if (!safeRepairHandoffJournal(named) || named.dev !== opened.dev || named.ino !== opened.ino) {
    throw new Error('unsafe repair handoff journal');
  }
}

function ensurePrivatePath(path: string): BigIntStats {
  const dir = dirname(path);
  const created = !existsSync(dir) && mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined;
  const dirStat = lstatSync(dir, { bigint: true });
  if (!safeRepairHandoffDirectory(dirStat)) {
    throw new Error('unsafe repair handoff directory');
  }
  chmodSync(dir, 0o700);
  assureRepairHandoffStoragePath(
    dir,
    'directory',
    created ? 'secure-created' : 'inspect-existing',
    dirname(dir),
  );
  const assuredDirStat = lstatSync(dir, { bigint: true });
  if (
    !safeRepairHandoffDirectory(assuredDirStat) ||
    assuredDirStat.dev !== dirStat.dev || assuredDirStat.ino !== dirStat.ino
  ) throw new Error('unsafe repair handoff directory');
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!safeRepairHandoffJournal(stat)) {
      throw new Error('unsafe repair handoff journal');
    }
    assureRepairHandoffJournalFile(path, 'inspect-existing', stat);
  }
  return assuredDirStat;
}

function appendObservation(observation: RepairHandoffObservation): boolean {
  const path = observation.schemaVersion === 2
    ? repairHandoffV2JournalPath()
    : repairHandoffJournalPath();
  try {
    ensurePrivatePath(path);
  } catch {
    return false;
  }
  const lock = acquireLocalStoreLock(repairHandoffLockPath(path));
  if (!lock) return false;
  let fd: number | undefined;
  try {
    const directory = ensurePrivatePath(path);
    const v1 = readRepairHandoffsInternal(repairHandoffJournalPath(), 1);
    const v2 = readRepairHandoffsInternal(repairHandoffV2JournalPath(), 2);
    const durable = observation.schemaVersion === 1 ? v1 : v2;
    const combined = combineRepairHandoffReadsAfterParentSettlement([v1, v2]);
    if (
      durable.conflictingIds > 0 || durable.limitExceeded ||
      combined.sourceState === 'degraded' || combined.conflictingIds > 0 || combined.limitExceeded
    ) return false;
    if (hasExactObservation(durable, observation)) {
      fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(fd);
      if (!opened.isFile() || !privateOwner(opened.uid) || opened.nlink !== 1) return false;
      syncRepairHandoffAuthority(path, fd, directory);
      closeSync(fd);
      fd = undefined;
      return exactObservationHasHealthyAuthority(observation);
    }
    if (durable.physicalRows + (durable.tornTail ? 1 : 0) >= MAX_RECORDS) return false;
    if (!observationAdmissionAllowed(durable, observation)) return false;
    const before = existsSync(path) ? lstatSync(path) : undefined;
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (before ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      const bytes = Buffer.from(`\n${JSON.stringify(observation)}\n`, 'utf8');
      if (!stat.isFile() || !privateOwner(stat.uid) || stat.nlink !== 1 || stat.size + bytes.length > MAX_FILE_BYTES) return false;
      if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) return false;
      fchmodSync(fd, 0o600);
      if (!before) assureRepairHandoffJournalFile(path, 'secure-created', stat);
      if (bytes.length > MAX_ROW_BYTES) return false;
      if (writeSync(fd, bytes) !== bytes.length) return false;
      syncRepairHandoffAuthority(path, fd, directory);
      return exactObservationHasHealthyAuthority(observation);
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* best effort */ }
        fd = undefined;
      }
      return false;
    }
  } catch {
    return false;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    releaseLocalStoreLock(lock);
  }
}

function syncRepairHandoffAuthority(path: string, fd: number, directory: BigIntStats): void {
  repairHandoffJournalFaultForTest?.('append-file-fsync');
  fsyncSync(fd);
  repairHandoffJournalFaultForTest?.('append-path-verification');
  const persisted = fstatSync(fd);
  const authoritative = lstatSync(path);
  const currentDirectory = lstatSync(dirname(path), { bigint: true });
  if (
    persisted.nlink !== 1 || authoritative.isSymbolicLink() || !authoritative.isFile() ||
    authoritative.dev !== persisted.dev || authoritative.ino !== persisted.ino ||
    currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino
  ) throw new Error('repair handoff path changed after append');
  fsyncDirectoryDurably(dirname(path), {
    expectedIdentity: { dev: directory.dev, ino: directory.ino },
    beforeFsync: () => repairHandoffJournalFaultForTest?.('append-directory-fsync'),
  });
}

function exactObservationHasHealthyAuthority(observation: RepairHandoffObservation): boolean {
  const v1 = readRepairHandoffsInternal(repairHandoffJournalPath(), 1);
  const v2 = readRepairHandoffsInternal(repairHandoffV2JournalPath(), 2);
  const durable = observation.schemaVersion === 1 ? v1 : v2;
  const combined = combineRepairHandoffReadsAfterParentSettlement([v1, v2]);
  return hasExactObservation(durable, observation) &&
    durable.sourceState === 'healthy' &&
    combined.sourceState === 'healthy' &&
    combined.conflictingIds === 0 &&
    !combined.limitExceeded;
}

function combineRepairHandoffReadsAfterParentSettlement(
  reads: readonly InternalRepairHandoffReadResult[],
): RepairHandoffReadResult {
  let combined = combineRepairHandoffReads(reads);
  if (reads.some((read) => read.sourceState === 'degraded')) return combined;
  for (let attempt = 1; combined.sourceState === 'degraded' && attempt < PARENT_AUTHORITY_RETRIES; attempt++) {
    Atomics.wait(PARENT_AUTHORITY_RETRY_SLEEP, 0, 0, PARENT_AUTHORITY_RETRY_MS);
    combined = combineRepairHandoffReads(reads);
  }
  return combined;
}

function hasExactObservation(
  read: InternalRepairHandoffReadResult,
  observation: RepairHandoffObservation,
): boolean {
  const expected = fullObservationFingerprint(observation);
  return read.durableRows.some((row) => fullObservationFingerprint(row) === expected);
}

function observationAdmissionAllowed(
  read: InternalRepairHandoffReadResult,
  observation: RepairHandoffObservation,
): boolean {
  if (observation.schemaVersion !== 2) return true;

  const durableV2 = read.durableRows.filter(
    (row): row is RepairHandoffObservationV2 => row.schemaVersion === 2,
  );
  const sameEvent = durableV2.filter((row) => row.eventId === observation.eventId);
  if (sameEvent.some((row) => row.parentAttemptId === observation.parentAttemptId)) return false;
  if (sameEvent.some((row) => Date.parse(row.ts) === Date.parse(observation.ts))) return false;

  const incoming = canonicalRepairHandoffV2Activation({
    id: observation.writerActivationId,
    activatedAt: observation.writerActivatedAt,
  });
  const claims = durableV2.flatMap((row) => {
    const activation = canonicalRepairHandoffV2Activation({
      id: row.writerActivationId,
      activatedAt: row.writerActivatedAt,
    });
    return activation ? [activation] : [];
  });
  if (!incoming) return claims.length === 0;
  if (claims.some((claim) =>
    (claim.id === incoming.id && claim.activatedAt !== incoming.activatedAt) ||
    (claim.activatedAt === incoming.activatedAt && claim.id !== incoming.id))) return false;

  const highWater = claims.reduce<number | null>((latest, claim) => {
    const activatedAt = Date.parse(claim.activatedAt);
    return latest === null || activatedAt > latest ? activatedAt : latest;
  }, null);
  return highWater === null || Date.parse(incoming.activatedAt) >= highWater;
}

export function recordRepairHandoffs(
  events: DispatchProductionEvent | DispatchProductionEvent[],
  options: { schemaVersion?: 1; activation?: never } | {
    schemaVersion: 2;
    activation: RepairHandoffV2Activation;
  } = {},
): RepairHandoffWriteResult {
  const result: RepairHandoffWriteResult = { attempted: 0, recorded: 0, failed: 0 };
  for (const event of Array.isArray(events) ? events : [events]) {
    const objectiveScoped = repairHandoffFromDispatchEvent(event);
    if (!objectiveScoped) continue;
    let canonicalParent: DispatchProductionEvent;
    try {
      canonicalParent = sanitizeDispatchProductionEvent(event, { materializeLearningLabel: true });
    } catch {
      continue;
    }
    const activation = options.schemaVersion === 2
      ? canonicalRepairHandoffV2Activation(options.activation)
      : null;
    if (options.schemaVersion === 2 && !activation) {
      result.attempted += 1;
      result.failed += 1;
      continue;
    }
    const observation: RepairHandoffObservation = options.schemaVersion === 2
      ? (() => {
          const bound = {
            ...objectiveScoped,
            writerActivationId: activation!.id,
            writerActivatedAt: activation!.activatedAt,
          };
          const eventId = semanticEventId(bound);
          return {
            ...bound,
            eventId,
            generationId: repairGenerationIdFromHandoffId(eventId)!,
          };
        })()
      : (() => {
          const legacy = { ...objectiveScoped, schemaVersion: 1 as const };
          const eventId = semanticEventId(legacy);
          return {
            ...legacy,
            eventId,
            generationId: repairGenerationIdFromHandoffId(eventId)!,
          };
        })();
    result.attempted += 1;
    const parent = recordDispatchProduction(canonicalParent);
    if (parent.recorded !== 1) {
      result.failed += 1;
      continue;
    }
    if (!validObservation(observation)) {
      result.failed += 1;
      continue;
    }
    if (appendObservation(observation)) result.recorded += 1;
    else result.failed += 1;
  }
  return result;
}

interface InternalRepairHandoffReadResult extends Omit<
  RepairHandoffReadResult,
  'authorityDigest' | 'parentEvidenceQuarantine'
> {
  durableRows: RepairHandoffObservation[];
  compactionRows: RepairHandoffObservation[];
  activeActivationRows: RepairHandoffObservationV2[];
  tornTail: boolean;
  quarantinedIds?: Set<string>;
}

function readRepairHandoffsInternal(
  path: string,
  expectedSchemaVersion: 1 | 2,
): InternalRepairHandoffReadResult {
  if (!existsSync(path)) {
    return {
      observations: [],
      durableRows: [],
      compactionRows: [],
      activeActivationRows: [],
      tornTail: false,
      sourceState: 'missing',
      invalidRows: 0,
      conflictingIds: 0,
      limitExceeded: false,
      physicalRows: 0,
    };
  }
  let fd: number | undefined;
  try {
    ensurePrivatePath(path);
    const before = lstatSync(path);
    if (before.size > MAX_FILE_BYTES || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) {
      return {
        observations: [],
        durableRows: [],
        compactionRows: [],
        activeActivationRows: [],
        tornTail: false,
        sourceState: 'degraded',
        invalidRows: 0,
        conflictingIds: 0,
        limitExceeded: true,
        physicalRows: 0,
      };
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
    const tornTail = text.length > 0 && !text.endsWith('\n');
    const byId = new Map<string, {
      schemaVersion: 1 | 2;
      attempts: Map<string, { fingerprint: string; row: RepairHandoffObservation; physicalOrder: number }>;
      conflict: boolean;
    }>();
    const invalidClaimedIds = new Set<string>();
    const durableRows: RepairHandoffObservation[] = [];
    const activationConflictingIds = new Set<string>();
    const activationClaimsById = new Map<string, Map<string, Set<string>>>();
    const activationClaimsByTime = new Map<string, Map<string, Set<string>>>();
    let activationHighWater: RepairHandoffV2Activation | null = null;
    let nextPhysicalOrder = 0;
    let invalidRows = tornTail ? 1 : 0;
    const physicalRows = completeLines.filter(Boolean).length;
    const limitExceeded = physicalRows > MAX_RECORDS;
    for (const line of completeLines) {
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_ROW_BYTES) { invalidRows += 1; continue; }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!validObservation(parsed) || parsed.schemaVersion !== expectedSchemaVersion) {
          invalidRows += 1;
          if (
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            typeof (parsed as Record<string, unknown>)['eventId'] === 'string' &&
            SHA256_RE.test((parsed as Record<string, string>)['eventId']!)
          ) invalidClaimedIds.add((parsed as Record<string, string>)['eventId']!);
          continue;
        }
        if (
          parsed.schemaVersion === 2 &&
          parsed.writerActivationId !== undefined &&
          parsed.writerActivatedAt !== undefined
        ) {
          const canonicalActivation = canonicalRepairHandoffV2Activation({
            id: parsed.writerActivationId,
            activatedAt: parsed.writerActivatedAt,
          })!;
          parsed.writerActivationId = canonicalActivation.id;
          const timesForId = activationClaimsById.get(parsed.writerActivationId) ?? new Map<string, Set<string>>();
          const idsForTime = activationClaimsByTime.get(parsed.writerActivatedAt) ?? new Map<string, Set<string>>();
          const conflictingClaims = [
            ...[...timesForId.entries()]
              .filter(([activatedAt]) => activatedAt !== parsed.writerActivatedAt)
              .flatMap(([_activatedAt, eventIds]) => [...eventIds]),
            ...[...idsForTime.entries()]
              .filter(([activationId]) => activationId !== parsed.writerActivationId)
              .flatMap(([_activationId, eventIds]) => [...eventIds]),
          ];
          if (conflictingClaims.length > 0) {
            activationConflictingIds.add(parsed.eventId);
            for (const eventId of conflictingClaims) activationConflictingIds.add(eventId);
          } else if (
            activationHighWater &&
            Date.parse(parsed.writerActivatedAt) < Date.parse(activationHighWater.activatedAt)
          ) {
            // Physical append order is the durable writer chronology. Once a
            // newer activation has appeared, an older writer cannot mint or
            // extend authority in any generation.
            activationConflictingIds.add(parsed.eventId);
          } else if (
            !activationHighWater ||
            Date.parse(parsed.writerActivatedAt) > Date.parse(activationHighWater.activatedAt)
          ) {
            activationHighWater = {
              id: parsed.writerActivationId,
              activatedAt: parsed.writerActivatedAt,
            };
          }

          const idsAtClaimedTime = timesForId.get(parsed.writerActivatedAt) ?? new Set<string>();
          idsAtClaimedTime.add(parsed.eventId);
          timesForId.set(parsed.writerActivatedAt, idsAtClaimedTime);
          activationClaimsById.set(parsed.writerActivationId, timesForId);

          const timesForClaimedId = idsForTime.get(parsed.writerActivationId) ?? new Set<string>();
          timesForClaimedId.add(parsed.eventId);
          idsForTime.set(parsed.writerActivationId, timesForClaimedId);
          activationClaimsByTime.set(parsed.writerActivatedAt, idsForTime);
        } else if (parsed.schemaVersion === 2 && activationHighWater) {
          // Unbound rows are compatible only with the pre-activation journal.
          // Once a bound writer appears, physical append order prevents a
          // rollback writer from minting healthy schema-v2 authority.
          activationConflictingIds.add(parsed.eventId);
        }
        durableRows.push(parsed);
        let event = byId.get(parsed.eventId);
        if (!event) {
          event = { schemaVersion: parsed.schemaVersion, attempts: new Map(), conflict: false };
          byId.set(parsed.eventId, event);
        } else if (event.schemaVersion !== parsed.schemaVersion) {
          event.conflict = true;
          continue;
        }
        const attempt = event.attempts.get(parsed.parentAttemptId);
        if (parsed.schemaVersion === 2) {
          const fingerprint = fullObservationFingerprint(parsed);
          if (attempt) {
            if (attempt.fingerprint !== fingerprint) event.conflict = true;
          } else if ([...event.attempts.values()].some(
            (entry) => Date.parse(entry.row.ts) === Date.parse(parsed.ts),
          )) {
            event.conflict = true;
          } else {
            event.attempts.set(parsed.parentAttemptId, {
              fingerprint,
              row: parsed,
              physicalOrder: nextPhysicalOrder++,
            });
          }
        } else {
          const fingerprint = observationFingerprint(parsed);
          if (!attempt) {
            event.attempts.set(parsed.parentAttemptId, {
              fingerprint,
              row: parsed,
              physicalOrder: nextPhysicalOrder++,
            });
          } else if (attempt.fingerprint !== fingerprint) event.conflict = true;
          else if (
            hasParentProvenance(attempt.row) &&
            hasParentProvenance(parsed) &&
            !sameParentProvenance(attempt.row, parsed)
          ) event.conflict = true;
          else if (attempt.row.parentObjectiveHash !== parsed.parentObjectiveHash) event.conflict = true;
          else if (!hasParentProvenance(attempt.row) && hasParentProvenance(parsed)) {
            // V1 routing provenance may enrich the same immutable attempt.
            attempt.row = parsed;
          }
        }
      } catch { invalidRows += 1; }
    }
    for (const eventId of invalidClaimedIds) {
      const event = byId.get(eventId);
      if (event) event.conflict = true;
    }
    const validEvents = [...byId.entries()]
      .filter(([eventId, entry]) => !entry.conflict && !invalidClaimedIds.has(eventId))
      .map(([_eventId, entry]) => entry);
    const conflictingIds = new Set([
      ...invalidClaimedIds,
      ...activationConflictingIds,
      ...[...byId.entries()].filter(([_eventId, entry]) => entry.conflict).map(([eventId]) => eventId),
    ]);
    const authoritativeEvents = validEvents.filter((entry) =>
      ![...entry.attempts.values()].some(({ row }) => activationConflictingIds.has(row.eventId)),
    );
    const observations = authoritativeEvents
      .map((entry) => {
        const attempts = [...entry.attempts.values()].map((attempt) => attempt.row);
        if (entry.schemaVersion === 1) {
          return attempts.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0]!;
        }
        // Journal order, unlike event time, is monotonic under the store lock.
        // Keep the first durable row as the generation's immutable proof fence.
        // Reactivation changes the active writer epoch, but not generation
        // identity, so it must not move this lower bound past child evidence.
        return attempts[0]!;
      })
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const activeActivationRows = activationHighWater
      ? authoritativeEvents.flatMap((entry) => {
          if (entry.schemaVersion !== 2) return [];
          const active = [...entry.attempts.values()]
            .filter(({ row }) =>
              row.schemaVersion === 2 &&
              row.writerActivationId === activationHighWater!.id &&
              row.writerActivatedAt === activationHighWater!.activatedAt)
            .sort((left, right) =>
              Date.parse(right.row.ts) - Date.parse(left.row.ts) ||
              right.physicalOrder - left.physicalOrder)[0];
          return active?.row.schemaVersion === 2 ? [active.row] : [];
        })
      : [];
    const compactionRows = authoritativeEvents
      .flatMap((entry) => [...entry.attempts.values()])
      .sort((left, right) => left.physicalOrder - right.physicalOrder)
      .map((attempt) => attempt.row);
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1 || after.size !== opened.size) {
      throw new Error('repair handoff journal changed during read');
    }
    return {
      observations,
      durableRows,
      compactionRows,
      activeActivationRows,
      tornTail,
      // The row threshold is an observability/compaction signal, not an
      // authority failure: every row was still parsed under the byte cap.
      sourceState: invalidRows > 0 || conflictingIds.size > 0 ? 'degraded' : 'healthy',
      invalidRows,
      conflictingIds: conflictingIds.size,
      quarantinedIds: conflictingIds,
      limitExceeded,
      physicalRows,
    };
  } catch {
    return {
      observations: [],
      durableRows: [],
      compactionRows: [],
      activeActivationRows: [],
      tornTail: false,
      sourceState: 'degraded',
      invalidRows: 1,
      conflictingIds: 0,
      limitExceeded: false,
      physicalRows: 0,
    };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function combineRepairHandoffReads(
  reads: readonly InternalRepairHandoffReadResult[],
): RepairHandoffReadResult {
  const quarantinedIds = new Set(reads.flatMap((read) => [...(read.quarantinedIds ?? [])]));
  const parentEvidenceRows = reads
    .flatMap((read) => read.compactionRows)
    .filter((row) => !quarantinedIds.has(row.eventId));
  const parentEvidenceStatuses = readDispatchProductionParents(parentEvidenceRows.map((row) => ({
    ts: row.ts,
    itemId: row.parentItemId,
    repo: row.repo,
    outcome: row.parentOutcome,
    attemptId: row.parentAttemptId,
    ...(row.parentSource !== undefined ? { source: row.parentSource } : {}),
    ...(row.parentBackend !== undefined ? { backend: row.parentBackend } : {}),
    ...(row.parentTier !== undefined ? { tier: row.parentTier } : {}),
    ...(row.parentObjectiveHash !== undefined ? { objectiveHash: row.parentObjectiveHash } : {}),
  })));
  const parentStatusByFingerprint = new Map(parentEvidenceRows.map((row, index) => [
    fullObservationFingerprint(row),
    parentEvidenceStatuses[index]!,
  ]));
  const candidates = reads
    .flatMap((read) => read.observations)
    .filter((row) => !quarantinedIds.has(row.eventId))
    .sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
  const parentStatuses = candidates.map((row) =>
    parentStatusByFingerprint.get(fullObservationFingerprint(row)) ?? 'degraded');
  const observations = candidates.filter((_row, index) => parentStatuses[index] === 'found');
  const objectiveControlParentStatuses = new Map<string, Set<(typeof parentStatuses)[number]>>();
  for (let index = 0; index < candidates.length; index++) {
    const family = repairHandoffObjectiveControlFamilyKey(candidates[index]!);
    if (family === null) continue;
    const statuses = objectiveControlParentStatuses.get(family) ??
      new Set<(typeof parentStatuses)[number]>();
    statuses.add(parentStatuses[index]!);
    objectiveControlParentStatuses.set(family, statuses);
  }
  const splitObjectiveControlFamily = [...objectiveControlParentStatuses.values()].some((statuses) =>
    statuses.has('found') && statuses.size > 1);
  const parentQuarantinedIds = new Set(parentEvidenceRows
    .filter((_row, index) => parentEvidenceStatuses[index] !== 'found')
    .map((row) => row.eventId));
  const parentEvidenceQuarantineSummary = parentEvidenceQuarantine(
    parentEvidenceRows,
    parentEvidenceStatuses,
  );
  const invalidRows = reads.reduce((sum, read) => sum + read.invalidRows, 0);
  const conflictingIds = new Set([...quarantinedIds, ...parentQuarantinedIds]).size;
  const intrinsicallyDegraded = reads.some((read) => read.sourceState === 'degraded');
  const anyPresent = reads.some((read) => read.sourceState !== 'missing');
  const authorityDigest = createHash('sha256').update(JSON.stringify([
    'ashlr:repair-handoff-authority:v1',
    observations.map(fullObservationFingerprint).sort(),
  ])).digest('hex');
  return {
    observations,
    sourceState: intrinsicallyDegraded || parentQuarantinedIds.size > 0 || splitObjectiveControlFamily
      ? 'degraded'
      : anyPresent ? 'healthy' : 'missing',
    invalidRows,
    conflictingIds,
    parentEvidenceQuarantine: parentEvidenceQuarantineSummary,
    limitExceeded: reads.some((read) => read.limitExceeded),
    physicalRows: reads.reduce((sum, read) => sum + read.physicalRows, 0),
    authorityDigest,
  };
}

export function readRepairHandoffs(): RepairHandoffReadResult {
  return combineRepairHandoffReads([
    readRepairHandoffsInternal(repairHandoffJournalPath(), 1),
    readRepairHandoffsInternal(repairHandoffV2JournalPath(), 2),
  ]);
}

/**
 * Suppress an ordinary parent only after two independently recorded capture
 * failures for its exact repository, work item, and objective. Missing or
 * degraded evidence intentionally fails open so observability loss never
 * becomes execution authority.
 */
export function captureGateDispatchState(item: WorkItem): CaptureGateDispatchState {
  const objectiveHash = existingWorkItemObjectiveHash(item);
  if (!objectiveHash) return { state: 'unavailable', authoritativeAttempts: 0 };
  let repo: string;
  try { repo = resolve(item.repo); } catch { return { state: 'unavailable', authoritativeAttempts: 0 }; }
  const reads = [
    readRepairHandoffsInternal(repairHandoffJournalPath(), 1),
    readRepairHandoffsInternal(repairHandoffV2JournalPath(), 2),
  ];
  const combined = combineRepairHandoffReads(reads);
  if (combined.sourceState !== 'healthy' || combined.limitExceeded) {
    return { state: 'unavailable', authoritativeAttempts: 0 };
  }
  const attempts = new Map<string, string>();
  for (const row of reads.flatMap((read) => read.compactionRows)) {
    if (
      row.kind !== 'capture-repair' ||
      (row.parentOutcome !== 'proposal-capture-error' && row.parentOutcome !== 'gate-blocked') ||
      row.parentItemId !== item.id ||
      row.parentSource !== item.source ||
      row.parentObjectiveHash !== objectiveHash
    ) continue;
    let rowRepo: string;
    try { rowRepo = resolve(row.repo); } catch { return { state: 'unavailable', authoritativeAttempts: 0 }; }
    if (rowRepo !== repo) continue;
    const fingerprint = JSON.stringify([
      row.kind, row.repo, row.parentItemId, row.parentSource, row.parentObjectiveHash, row.parentOutcome,
    ]);
    const previous = attempts.get(row.parentAttemptId);
    if (previous !== undefined && previous !== fingerprint) {
      return { state: 'unavailable', authoritativeAttempts: 0 };
    }
    attempts.set(row.parentAttemptId, fingerprint);
  }
  const authoritativeAttempts = attempts.size;
  return {
    state: authoritativeAttempts >= 2 ? 'terminal' : 'active',
    authoritativeAttempts,
  };
}

/** Stable objective-control family shared by queue and lifecycle authority. */
export function repairHandoffObjectiveControlFamilyKey(
  row: RepairHandoffObservation,
): string | null {
  if (!row.parentObjectiveHash) return null;
  return JSON.stringify([
    row.kind,
    row.repo,
    row.parentItemId,
    row.parentObjectiveHash,
    row.childItemId,
  ]);
}

export function readRepairHandoffSchemaSummary(
  currentActivation?: RepairHandoffV2Activation,
): RepairHandoffSchemaSummary {
  const v1 = readRepairHandoffsInternal(repairHandoffJournalPath(), 1);
  const v2 = readRepairHandoffsInternal(repairHandoffV2JournalPath(), 2);
  const combined = combineRepairHandoffReads([v1, v2]);
  const v1Authorities = combined.observations.filter((row) => row.schemaVersion === 1);
  const v2Authorities = combined.observations.filter((row) => row.schemaVersion === 2);
  const authoritativeV2GenerationIds = new Set(v2Authorities.map((row) => row.generationId));
  const activeActivationCandidates = v2.activeActivationRows.filter((row) =>
    authoritativeV2GenerationIds.has(row.generationId));
  const activeParentStatuses = readDispatchProductionParents(activeActivationCandidates.map((row) => ({
    ts: row.ts,
    itemId: row.parentItemId,
    repo: row.repo,
    outcome: row.parentOutcome,
    attemptId: row.parentAttemptId,
    source: row.parentSource,
    backend: row.parentBackend,
    tier: row.parentTier,
    objectiveHash: row.parentObjectiveHash,
  })));
  const activeActivationV2Authorities = activeActivationCandidates
    .filter((_row, index) => activeParentStatuses[index] === 'found');
  const canonicalCurrentActivation = currentActivation
    ? canonicalRepairHandoffV2Activation(currentActivation)
    : null;
  const currentActivationV2 = canonicalCurrentActivation
    ? activeActivationV2Authorities.filter((row) =>
        row.writerActivationId === canonicalCurrentActivation.id &&
        row.writerActivatedAt === canonicalCurrentActivation.activatedAt &&
        Date.parse(row.ts) >= Date.parse(canonicalCurrentActivation.activatedAt))
    : [];
  const latestCurrentActivationV2At = currentActivationV2.reduce<string | null>((latest, row) =>
    latest === null || Date.parse(row.ts) > Date.parse(latest) ? row.ts : latest, null);
  const currentActivationAuthorityDigest = canonicalCurrentActivation
    ? createHash('sha256').update(JSON.stringify([
        'ashlr:repair-handoff:activation-authority:v1',
        canonicalCurrentActivation.id,
        canonicalCurrentActivation.activatedAt,
        currentActivationV2.map(fullObservationFingerprint).sort(),
      ])).digest('hex')
    : null;
  const v1FamilyKeys = new Set(v1Authorities
    .map(repairHandoffObjectiveControlFamilyKey)
    .filter((key): key is string => key !== null));
  const aliasFamilies = new Set(v2Authorities
    .map(repairHandoffObjectiveControlFamilyKey)
    .filter((key): key is string => key !== null && v1FamilyKeys.has(key))).size;
  return {
    sourceState: combined.sourceState,
    v1Authorities: v1Authorities.length,
    v2Authorities: v2Authorities.length,
    v1PhysicalRows: v1.physicalRows,
    v2PhysicalRows: v2.physicalRows,
    invalidRows: combined.invalidRows,
    conflictingIds: combined.conflictingIds,
    parentEvidenceQuarantine: combined.parentEvidenceQuarantine,
    limitExceeded: combined.limitExceeded,
    aliasFamilies,
    latestV2At: v2Authorities[0]?.ts ?? null,
    currentActivationV2Authorities: currentActivationV2.length,
    unboundV2Authorities: v2Authorities.filter((row) => !row.writerActivationId).length,
    latestCurrentActivationV2At,
    currentActivationAuthorityDigest,
    authorityDigest: combined.authorityDigest,
  };
}

function compactRepairHandoffFile(
  path: string,
  expectedSchemaVersion: 1 | 2,
): RepairHandoffCompactionResult {
  if (!existsSync(path)) return { available: true, before: 0, after: 0, removed: 0 };
  try {
    ensurePrivatePath(path);
  } catch {
    return { available: false, before: 0, after: 0, removed: 0 };
  }
  const lock = acquireLocalStoreLock(repairHandoffLockPath(path));
  if (!lock) return { available: false, before: 0, after: 0, removed: 0 };
  let tmp: string | undefined;
  let fd: number | undefined;
  try {
    const read = readRepairHandoffsInternal(path, expectedSchemaVersion);
    if (read.conflictingIds > 0 || read.limitExceeded) {
      return { available: false, before: read.physicalRows, after: 0, removed: 0 };
    }
    const parentAuthority = combineRepairHandoffReads([{ ...read, sourceState: 'healthy' }]);
    if (parentAuthority.sourceState === 'degraded') {
      return { available: false, before: read.physicalRows, after: 0, removed: 0 };
    }
    // Preserve every semantic event id: old fingerprints are the immutable
    // conflict history that prevents a later replay from minting new authority.
    // Compaction only removes physical replays and invalid/torn rows.
    const compacted = read.compactionRows;
    if (compacted.length === read.physicalRows && read.invalidRows === 0 && !read.tornTail) {
      return { available: true, before: read.physicalRows, after: compacted.length, removed: 0 };
    }
    const directory = ensurePrivatePath(path);
    tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const openedTmp = fstatSync(fd);
    if (!safeRepairHandoffJournal(openedTmp)) throw new Error('unsafe repair handoff compaction file');
    fchmodSync(fd, 0o600);
    assureRepairHandoffJournalFile(tmp, 'secure-created', openedTmp);
    const bytes = Buffer.from(compacted.map((row) => JSON.stringify(row)).join('\n') + (compacted.length ? '\n' : ''), 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short repair handoff compaction write');
    fsyncSync(fd);
    const compactedFile = fstatSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    tmp = undefined;
    assureRepairHandoffJournalFile(path, 'inspect-existing', compactedFile);
    const authoritative = lstatSync(path);
    const currentDirectory = lstatSync(dirname(path), { bigint: true });
    if (
      authoritative.isSymbolicLink() || !authoritative.isFile() || authoritative.nlink !== 1 ||
      authoritative.dev !== compactedFile.dev || authoritative.ino !== compactedFile.ino ||
      !safeRepairHandoffDirectory(currentDirectory) ||
      currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino
    ) throw new Error('repair handoff compaction path changed');
    fsyncDirectoryDurably(dirname(path), {
      expectedIdentity: { dev: directory.dev, ino: directory.ino },
    });
    const repaired = readRepairHandoffsInternal(path, expectedSchemaVersion);
    const repairedAuthority = combineRepairHandoffReads([repaired]);
    if (
      repaired.sourceState !== 'healthy' || repaired.invalidRows !== 0 || repaired.tornTail ||
      repaired.conflictingIds > 0 || repaired.limitExceeded ||
      repairedAuthority.sourceState === 'degraded' ||
      repaired.compactionRows.map(fullObservationFingerprint).join('\n') !==
        compacted.map(fullObservationFingerprint).join('\n')
    ) throw new Error('repair handoff compaction did not restore authority');
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

export function compactRepairHandoffs(): RepairHandoffCompactionResult {
  const results = [
    compactRepairHandoffFile(repairHandoffJournalPath(), 1),
    compactRepairHandoffFile(repairHandoffV2JournalPath(), 2),
  ];
  return {
    available: results.every((result) => result.available),
    before: results.reduce((sum, result) => sum + result.before, 0),
    after: results.reduce((sum, result) => sum + result.after, 0),
    removed: results.reduce((sum, result) => sum + result.removed, 0),
  };
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
    ...(observation.kind === 'no-diff-reslice'
      ? {
          ...(observation.repairTreatmentUnitId ? { repairTreatmentUnitId: observation.repairTreatmentUnitId } : {}),
          ...(observation.repairTreatment ? { repairTreatment: observation.repairTreatment } : {}),
        }
      : {}),
  };
}
