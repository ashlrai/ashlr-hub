/**
 * dispatch-production-ledger.ts — append-only proposal-production outcome stream.
 *
 * Writes metadata-only rows to ~/.ashlr/dispatch-production/YYYY-MM-DD.jsonl
 * (or $ASHLR_HOME/dispatch-production). This is history/analytics, not the
 * cooldown ledger: never truncate, never rewrite, never throw.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonDispatchProductionOutcome,
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  ProductionAttemptShape,
  RunActionCounts,
  RouteSnapshot,
  RunEventSummary,
  WorkItem,
} from '../types.js';
import { causalMetadata } from '../learning/causal.js';
import {
  addProductionAttemptShape,
  classifyProductionAttemptForLearningWithLabel,
  emptyProductionAttemptShape,
  generatedRepairAttemptKindFromSignals,
  hasProductionAttemptShape,
  productionAttemptLearningLabelFromSignals,
  sanitizeProductionAttemptLearningLabel,
  type GeneratedRepairAttemptKind,
  type ProductionAttemptLearningClassification,
  type ProductionAttemptLearningLabel,
} from '../learning/attempt-shape.js';
import { scrubSecrets } from '../util/scrub.js';
import { repairGenerationIdFromHandoffId } from './repair-handoff-journal.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_READ_LIMIT = 2_000;
const DEFAULT_READ_MAX_FILES = 31;
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 10_000;
const HARD_READ_MAX_FILES = 32;
const HARD_READ_MAX_BYTES = 32 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 50_000;
const MAX_LOOSE_FILES = 3;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_READ_ROW_BYTES = 128 * 1024;
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const ENGINE_IDS = new Set<EngineId>([
  'builtin', 'local-coder', 'ashlrcode', 'aw', 'claude', 'codex', 'hermes',
  'kimi', 'nim', 'opencode', 'grok',
]);

export type DispatchProductionBasis =
  | 'run-proposal-outcome'
  | 'pending-proposal-delta'
  | 'best-of-n-summary'
  | 'unknown';

export interface DispatchProductionEvent {
  schemaVersion: 1;
  ts: string;
  machineId?: string;
  itemId: string;
  source: WorkItem['source'];
  repo: string;
  title: string;
  backend: EngineId | null;
  tier: EngineTier | null;
  model?: string | null;
  assignedBy: string;
  routeReason: string;
  outcome: DaemonDispatchProductionOutcome;
  proposalCreated: boolean;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  routeSnapshot?: RouteSnapshot;
  runEventSummary?: RunEventSummary;
  evidenceOutcome?: EvidenceOutcomeSummary;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  routerPolicyVersion?: string;
  learningEpoch?: string;
  /** Scrubbed metadata-only hash of the dispatched work item's objective. */
  objectiveHash?: string;
  learningLabel?: ProductionAttemptLearningLabel;
  spentUsd: number;
  diffFiles?: number;
  diffLines?: number;
  reason?: string;
  basis: DispatchProductionBasis;
  /** Metadata-only exact lineage for journal-authorized diagnostic repair dispatches. */
  repairHandoffId?: string;
  repairGenerationId?: string;
  repairAttemptOrdinal?: 1 | 2;
  repairPreviousBackend?: EngineId;
  repairLineageInvalid?: true;
}

export interface ReadDispatchProductionEventsOptions {
  sinceMs?: number;
  limit?: number;
  /** Maximum dated partitions. Loose legacy partitions retain their separate fixed cap. */
  maxFiles?: number;
  /** Aggregate bytes physically read across selected partitions. */
  maxBytes?: number;
  /** Aggregate physical rows examined, including blank and invalid rows. */
  maxRows?: number;
}

export type DispatchProductionReadStopReason =
  | 'event-limit'
  | 'file-limit'
  | 'byte-limit'
  | 'row-limit'
  | 'io-error';

export interface DispatchProductionSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: DispatchProductionReadStopReason[];
  filesRead: number;
  datedFilesRead: number;
  looseFilesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface DispatchProductionEventsReadResult extends DispatchProductionSourceQuality {
  events: DispatchProductionEvent[];
}

export interface DispatchProductionYieldReadResult {
  summary?: DispatchProductionYieldSummary;
  sourceQuality: DispatchProductionSourceQuality;
}

export interface DispatchProductionReasonCount {
  reason: string;
  count: number;
}

export interface DispatchProductionOutcomeCounts {
  proposalCreated: number;
  emptyDiff: number;
  gateBlocked: number;
  engineFailed: number;
  sandboxFailed: number;
  proposalCaptureError: number;
  proposalDisabled: number;
  unknown: number;
}

export interface GeneratedRepairAttemptSummary {
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  captureRepairs: number;
  diagnosticReslices: number;
  proposalRepairs: number;
}

export interface GeneratedRepairBackendTransitionBucket {
  previousBackend: EngineId;
  retryBackend: EngineId;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  outcomes: DispatchProductionOutcomeCounts;
}

export interface GeneratedRepairBackendTransitionSummary {
  sourceState: 'healthy' | 'degraded';
  lineageEvents: number;
  transitionEvents: number;
  attempts: number;
  duplicateEvents: number;
  conflictingAttempts: number;
  invalidLineageEvents: number;
  byTransition: GeneratedRepairBackendTransitionBucket[];
}

export interface DispatchProductionYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
}

export interface DispatchProductionYieldSummary {
  windowHours: number;
  attempts: number;
  events: number;
  proposalsCreated: number;
  noProposal: number;
  proposalRate: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts?: RunActionCounts;
  attemptShape?: ProductionAttemptShape;
  generatedRepairAttempts?: GeneratedRepairAttemptSummary;
  generatedRepairBackendTransitions?: GeneratedRepairBackendTransitionSummary;
  topReasons: DispatchProductionReasonCount[];
  diagnosticTopReasons?: DispatchProductionReasonCount[];
  byBackend: DispatchProductionYieldBucket[];
  bySource: DispatchProductionYieldBucket[];
  byRepo: DispatchProductionYieldBucket[];
  byBackendModel: DispatchProductionYieldBucket[];
  byBackendSource: DispatchProductionYieldBucket[];
}

export function dispatchProductionDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== ''
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'dispatch-production');
}

function eventDateString(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString().slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

function eventTimestamp(ts: string): string {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function stripSecrets(value: string): string {
  return scrubSecrets(value);
}

function boundedText(value: string, max: number): string {
  const stripped = stripSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function boundedNullableText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return boundedOptionalText(value, max);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function sanitizeEvent(
  event: DispatchProductionEvent,
  opts: { materializeLearningLabel?: boolean; deriveLegacyRunOutcomeCausal?: boolean } = {},
): DispatchProductionEvent {
  const ts = eventTimestamp(event.ts);
  const machineId = boundedOptionalText(event.machineId, 120);
  const itemId = boundedText(event.itemId, 240) || 'unknown';
  const source = boundedText(event.source, 80) as WorkItem['source'];
  const repo = boundedText(event.repo, 500) || 'unknown';
  const title = boundedText(event.title, 160) || 'untitled';
  const backend = boundedNullableText(event.backend, 80) as EngineId | null | undefined;
  const tier = boundedNullableText(event.tier, 40) as EngineTier | null | undefined;
  const model = boundedNullableText(event.model, 160) as string | null | undefined;
  const assignedBy = boundedText(event.assignedBy, 80) || 'unknown';
  const routeReason = boundedText(event.routeReason, 240) || 'unknown';
  const proposalId = boundedOptionalText(event.proposalId, 160);
  const runId = boundedOptionalText(event.runId, 160);
  const trajectoryId = boundedOptionalText(event.trajectoryId, 240);
  const routerPolicyVersion = boundedOptionalText(event.routerPolicyVersion, 80);
  const learningEpoch = boundedOptionalText(event.learningEpoch, 40);
  const objectiveHash = typeof event.objectiveHash === 'string' && /^[a-f0-9]{64}$/.test(event.objectiveHash)
    ? event.objectiveHash
    : undefined;
  const repairHandoffId = typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId)
    ? event.repairHandoffId
    : undefined;
  const repairGenerationId = typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId)
    ? event.repairGenerationId
    : undefined;
  const repairAttemptOrdinal = event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2
    ? event.repairAttemptOrdinal
    : undefined;
  const repairPreviousBackend = ENGINE_IDS.has(event.repairPreviousBackend as EngineId)
    ? event.repairPreviousBackend
    : undefined;
  const repairLineageFieldsPresent = event.repairHandoffId !== undefined ||
    event.repairGenerationId !== undefined ||
    event.repairAttemptOrdinal !== undefined ||
    event.repairPreviousBackend !== undefined;
  const repairLineageComplete = event.repairLineageInvalid !== true &&
    backend !== undefined &&
    backend !== null &&
    ENGINE_IDS.has(backend) &&
    repairHandoffId !== undefined &&
    repairGenerationId !== undefined &&
    repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId &&
    repairAttemptOrdinal !== undefined &&
    (repairAttemptOrdinal === 1
      ? repairPreviousBackend === undefined
      : repairPreviousBackend !== undefined && backend !== repairPreviousBackend);
  const repairLineageInvalid = event.repairLineageInvalid === true ||
    (repairLineageFieldsPresent && !repairLineageComplete);
  const outcome = boundedText(event.outcome, 80) as DaemonDispatchProductionOutcome;
  const basis = boundedText(event.basis, 80) as DispatchProductionBasis;
  const reason = boundedOptionalText(event.reason, 240);
  const diffFiles = finiteNonNegative(event.diffFiles);
  const diffLines = finiteNonNegative(event.diffLines);
  const spentUsd = finiteNonNegative(event.spentUsd) ?? 0;
  const legacyCausal =
    opts.deriveLegacyRunOutcomeCausal && basis === 'run-proposal-outcome'
      ? legacyRunOutcomeCausalFallback({
          backend,
          tier,
          model,
          assignedBy: boundedOptionalText(event.assignedBy, 80),
          routeReason: boundedOptionalText(event.routeReason, 240),
          runId,
          outcome,
          proposalCreated: Boolean(event.proposalCreated),
          proposalId,
          diffFiles,
          diffLines,
          spentUsd: finiteNonNegative(event.spentUsd),
        })
      : {};
  const causal = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId,
    routeSnapshot: event.routeSnapshot ?? legacyCausal.routeSnapshot,
    runEventSummary: event.runEventSummary ?? legacyCausal.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ?? 'daemon-dispatch',
    labelBasis: event.labelBasis ?? 'dispatch-outcome',
    routerPolicyVersion,
    learningEpoch,
  });
  const learningLabel = opts.materializeLearningLabel
    ? productionAttemptLearningLabelFromSignals({
        outcome,
        proposalCreated: Boolean(event.proposalCreated),
        actionCounts: causal.runEventSummary?.actionCounts,
        reason,
        itemId,
        title,
        source,
      })
    : sanitizeProductionAttemptLearningLabel(event.learningLabel);
  return {
    schemaVersion: 1,
    ts,
    ...(machineId ? { machineId } : {}),
    itemId,
    source,
    repo,
    title,
    backend: backend ?? null,
    tier: tier ?? null,
    ...(model !== undefined ? { model } : {}),
    assignedBy,
    routeReason,
    outcome,
    proposalCreated: Boolean(event.proposalCreated),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    ...(learningLabel ? { learningLabel } : {}),
    ...(objectiveHash ? { objectiveHash } : {}),
    ...(repairLineageInvalid
      ? { repairLineageInvalid: true as const }
      : repairLineageComplete
        ? {
          repairHandoffId,
          repairGenerationId,
          repairAttemptOrdinal,
          ...(repairPreviousBackend ? { repairPreviousBackend } : {}),
          }
        : {}),
    spentUsd,
    ...(diffFiles !== undefined ? { diffFiles } : {}),
    ...(diffLines !== undefined ? { diffLines } : {}),
    ...(reason ? { reason } : {}),
    basis,
  };
}

function legacyRunOutcomeCausalFallback(input: {
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  assignedBy?: string;
  routeReason?: string;
  runId?: string;
  outcome?: DaemonDispatchProductionOutcome;
  proposalCreated?: boolean;
  proposalId?: string;
  diffFiles?: number;
  diffLines?: number;
  spentUsd?: number;
}): { routeSnapshot?: RouteSnapshot; runEventSummary?: RunEventSummary } {
  const routeSnapshot: RouteSnapshot = {
    ...(input.backend !== undefined ? { backend: input.backend } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.assignedBy ? { assignedBy: input.assignedBy } : {}),
    ...(input.routeReason ? { reason: input.routeReason } : {}),
  };
  const runEventSummary: RunEventSummary = {
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    ...(input.proposalCreated !== undefined ? { proposalCreated: input.proposalCreated } : {}),
    ...(input.proposalId ? { proposalId: input.proposalId } : {}),
    ...(input.diffFiles !== undefined ? { diffFiles: input.diffFiles } : {}),
    ...(input.diffLines !== undefined ? { diffLines: input.diffLines } : {}),
    ...(input.spentUsd !== undefined ? { costUsd: input.spentUsd } : {}),
  };
  return {
    ...(Object.keys(routeSnapshot).length > 0 ? { routeSnapshot } : {}),
    ...(Object.keys(runEventSummary).length > 0 ? { runEventSummary } : {}),
  };
}

function isDispatchProductionEvent(value: unknown): value is DispatchProductionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['schemaVersion'] === 1 &&
    typeof obj['ts'] === 'string' &&
    typeof obj['itemId'] === 'string' &&
    typeof obj['source'] === 'string' &&
    typeof obj['repo'] === 'string' &&
    typeof obj['title'] === 'string' &&
    typeof obj['assignedBy'] === 'string' &&
    typeof obj['routeReason'] === 'string' &&
    typeof obj['outcome'] === 'string' &&
    typeof obj['proposalCreated'] === 'boolean' &&
    typeof obj['spentUsd'] === 'number' &&
    typeof obj['basis'] === 'string'
  );
}

export function recordDispatchProduction(
  input: DispatchProductionEvent | DispatchProductionEvent[],
): void {
  try {
    const events = Array.isArray(input) ? input : [input];
    if (events.length === 0) return;
    const dir = dispatchProductionDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const event of events) {
      try {
        const record = sanitizeEvent(event, { materializeLearningLabel: true });
        appendDispatchProductionLine(
          join(dir, `${eventDateString(record.ts)}.jsonl`),
          JSON.stringify(record) + '\n',
        );
      } catch {
        // Skip only this record; later records in the batch still get a chance.
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
  }
}

function appendDispatchProductionLine(path: string, line: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error('dispatch production ledger is not a regular file');
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      const read = readSync(fd, tail, 0, 1, opened.size - 1);
      if (read !== 1) throw new Error('dispatch production ledger tail is unreadable');
      if (tail[0] !== 0x0a) writeSync(fd, '\n', undefined, 'utf8');
    }
    writeSync(fd, line, undefined, 'utf8');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyDispatchProductionRead(
  sourceState: DispatchProductionSourceQuality['sourceState'],
  overrides: Partial<DispatchProductionEventsReadResult> = {},
): DispatchProductionEventsReadResult {
  return {
    events: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    datedFilesRead: 0,
    looseFilesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeDispatchProductionDirectory(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isDirectory() &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function safeDispatchProductionFile(stat: Stats): boolean {
  return !stat.isSymbolicLink() && stat.isFile() && Number(stat.nlink) === 1 &&
    (typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid()) &&
    (process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0);
}

function readDispatchProductionFileTail(
  path: string,
  maxBytes: number,
): { text: string; bytesRead: number; truncated: boolean } | null {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (!safeDispatchProductionFile(pathBefore)) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!safeDispatchProductionFile(before) || !sameFile(pathBefore, before)) return null;
    const bytes = Math.min(before.size, maxBytes);
    const start = Math.max(0, before.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const bytesRead = bytes > 0 ? readSync(fd, buffer, 0, bytes, start) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() ||
      !safeDispatchProductionFile(pathAfter) ||
      !safeDispatchProductionFile(after) ||
      !sameFile(before, after) ||
      !sameFile(after, pathAfter) ||
      after.size !== before.size ||
      bytesRead !== bytes
    ) return null;
    let text: string;
    if (start > 0) {
      const boundaryWasNewline = buffer[0] === 0x0a;
      text = buffer.subarray(1, bytesRead).toString('utf8');
      if (!boundaryWasNewline) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
    } else {
      text = buffer.subarray(0, bytesRead).toString('utf8');
    }
    return { text, bytesRead, truncated: start > 0 };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort diagnostics read */ }
    }
  }
}

function pushStopReason(
  reasons: DispatchProductionReadStopReason[],
  reason: DispatchProductionReadStopReason,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

export function readDispatchProductionEventsDetailed(
  opts: ReadDispatchProductionEventsOptions = {},
): DispatchProductionEventsReadResult {
  const cap = boundedReadOption(opts.limit, DEFAULT_READ_LIMIT, DEFAULT_READ_LIMIT);
  const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
  const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
  const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
  const dir = dispatchProductionDir();
  if (!existsSync(dir)) return emptyDispatchProductionRead('missing');

  let files: string[];
  let directorySnapshot: ReturnType<typeof lstatSync>;
  try {
    directorySnapshot = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directorySnapshot)) throw new Error('unsafe dispatch production directory');
    const selected: string[] = [];
    const handle = opendirSync(dir);
    try {
      let seen = 0;
      let entry = handle.readSync();
      while (entry !== null) {
        seen++;
        if (seen > MAX_DIRECTORY_ENTRIES) {
          return emptyDispatchProductionRead('degraded', {
            sourcePresent: true, complete: false, stopReasons: ['file-limit'],
          });
        }
        if (entry.name.endsWith('.jsonl')) selected.push(entry.name);
        entry = handle.readSync();
      }
    } finally {
      handle.closeSync();
    }
    files = selected.sort((left, right) => {
        const leftDated = DATE_LEDGER_FILE_RE.test(left);
        const rightDated = DATE_LEDGER_FILE_RE.test(right);
        if (leftDated !== rightDated) return leftDated ? -1 : 1;
        return right.localeCompare(left);
      });
  } catch {
    return emptyDispatchProductionRead('degraded', {
      complete: false,
      stopReasons: ['io-error'],
      unreadableFiles: 1,
    });
  }
  if (files.length === 0) {
    try {
      const directoryAfter = lstatSync(dir);
      return safeDispatchProductionDirectory(directoryAfter) && sameFile(directorySnapshot, directoryAfter) &&
        directorySnapshot.mtimeMs === directoryAfter.mtimeMs && directorySnapshot.ctimeMs === directoryAfter.ctimeMs
        ? emptyDispatchProductionRead('healthy', { sourcePresent: true })
        : emptyDispatchProductionRead('degraded', {
            sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
          });
    } catch {
      return emptyDispatchProductionRead('degraded', {
        sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
      });
    }
  }

  const result = emptyDispatchProductionRead('healthy');
  result.sourcePresent = true;
  let stopTraversal = false;
  for (const file of files) {
    if (stopTraversal) break;
    if (opts.sinceMs !== undefined && !fileMayContainSince(file, opts.sinceMs)) continue;
    if (result.rowsScanned >= maxRows) {
      pushStopReason(result.stopReasons, 'row-limit');
      result.complete = false;
      break;
    }
    const isDatedFile = DATE_LEDGER_FILE_RE.test(file);
    if (isDatedFile) {
      if (result.datedFilesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.datedFilesRead++;
    } else {
      if (result.looseFilesRead >= MAX_LOOSE_FILES) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      result.looseFilesRead++;
    }

    const remainingBytes = maxBytes - result.bytesRead;
    if (remainingBytes <= 0) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      break;
    }
    const loaded = readDispatchProductionFileTail(join(dir, file), remainingBytes);
    result.filesRead++;
    if (!loaded) {
      result.unreadableFiles++;
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      break;
    }
    result.bytesRead += loaded.bytesRead;
    if (loaded.truncated) {
      pushStopReason(result.stopReasons, 'byte-limit');
      result.complete = false;
      stopTraversal = true;
    }

    let cursor = loaded.text.length;
    let trailingSeparator = true;
    while (cursor > 0) {
      if (result.rowsScanned >= maxRows) {
        pushStopReason(result.stopReasons, 'row-limit');
        result.complete = false;
        stopTraversal = true;
        break;
      }
      const newline = loaded.text.lastIndexOf('\n', cursor - 1);
      const line = loaded.text.slice(newline + 1, cursor);
      cursor = newline >= 0 ? newline : 0;
      if (trailingSeparator && line === '') {
        trailingSeparator = false;
        continue;
      }
      trailingSeparator = false;
      result.rowsScanned++;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
        result.invalidRows++;
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isDispatchProductionEvent(parsed)) {
          result.invalidRows++;
          continue;
        }
        const eventMs = Date.parse(parsed.ts);
        if (!Number.isFinite(eventMs)) {
          result.invalidRows++;
          continue;
        }
        if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
        if (result.events.length >= cap) {
          pushStopReason(result.stopReasons, 'event-limit');
          result.complete = false;
          stopTraversal = true;
          break;
        }
        result.events.push(sanitizeEvent(parsed, {
          deriveLegacyRunOutcomeCausal: true,
          materializeLearningLabel: true,
        }));
      } catch {
        result.invalidRows++;
      }
    }
  }
  if (result.invalidRows > 0 || result.unreadableFiles > 0) result.complete = false;
  if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
    result.sourceState = 'degraded';
  }
  try {
    const directoryAfter = lstatSync(dir);
    if (!safeDispatchProductionDirectory(directoryAfter) || !sameFile(directorySnapshot, directoryAfter) ||
      directorySnapshot.mtimeMs !== directoryAfter.mtimeMs || directorySnapshot.ctimeMs !== directoryAfter.ctimeMs) {
      pushStopReason(result.stopReasons, 'io-error');
      result.unreadableFiles++;
      result.complete = false;
      result.sourceState = 'degraded';
    }
  } catch {
    pushStopReason(result.stopReasons, 'io-error');
    result.unreadableFiles++;
    result.complete = false;
    result.sourceState = 'degraded';
  }
  return result;
}

export function readDispatchProductionEvents(
  opts?: ReadDispatchProductionEventsOptions,
): DispatchProductionEvent[] {
  return readDispatchProductionEventsDetailed(opts).events;
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function emptyOutcomeCounts(): DispatchProductionOutcomeCounts {
  return {
    proposalCreated: 0,
    emptyDiff: 0,
    gateBlocked: 0,
    engineFailed: 0,
    sandboxFailed: 0,
    proposalCaptureError: 0,
    proposalDisabled: 0,
    unknown: 0,
  };
}

const RUN_ACTION_COUNT_KEYS = [
  'sandboxCreated',
  'spawnAttempts',
  'transientRetries',
  'proposalCaptureAttempts',
  'completenessGateRuns',
  'verifyRepairAttempts',
  'modelSteps',
  'toolSteps',
  'totalSteps',
  'diffFiles',
  'diffLines',
  'proposalCreated',
  'proposalBlocked',
  'proposalDisabled',
] as const satisfies readonly (keyof RunActionCounts)[];

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function addRunActionCounts(target: RunActionCounts, source: RunActionCounts | undefined): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  const record = source as Record<string, unknown>;
  for (const key of RUN_ACTION_COUNT_KEYS) {
    const value = nonNegativeInteger(record[key]);
    if (value === undefined || value <= 0) continue;
    target[key] = Math.min((target[key] ?? 0) + value, Number.MAX_SAFE_INTEGER);
  }
}

function hasRunActionCounts(counts: RunActionCounts): boolean {
  return RUN_ACTION_COUNT_KEYS.some((key) => (counts[key] ?? 0) > 0);
}

function incrementOutcome(
  counts: DispatchProductionOutcomeCounts,
  outcome: DaemonDispatchProductionOutcome,
): void {
  switch (outcome) {
    case 'proposal-created':
      counts.proposalCreated++;
      break;
    case 'empty-diff':
      counts.emptyDiff++;
      break;
    case 'gate-blocked':
      counts.gateBlocked++;
      break;
    case 'engine-failed':
      counts.engineFailed++;
      break;
    case 'sandbox-failed':
      counts.sandboxFailed++;
      break;
    case 'proposal-capture-error':
      counts.proposalCaptureError++;
      break;
    case 'proposal-disabled':
      counts.proposalDisabled++;
      break;
    default:
      counts.unknown++;
      break;
  }
}

function sortedReasons(reasons: Map<string, number>, limit: number): DispatchProductionReasonCount[] {
  return [...reasons.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function isSuppressedDispatchProductionReason(reason: string | undefined): boolean {
  const normalized = String(reason ?? '').trim().toLowerCase();
  return normalized.startsWith('proposal-disabled') ||
    normalized.includes('proposal filing disabled');
}

function addDiagnosticReason(
  reasons: Map<string, number>,
  reason: string,
  classification: ProductionAttemptLearningClassification,
): void {
  if (classification.policySuppressed || isSuppressedDispatchProductionReason(reason)) return;
  reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
}

interface MutableYieldBucket {
  key: string;
  backend?: EngineId | null;
  source?: WorkItem['source'];
  repo?: string;
  model?: string | null;
  attempts: number;
  proposalsCreated: number;
  spentUsd: number;
  outcomes: DispatchProductionOutcomeCounts;
  actionCounts: RunActionCounts;
  attemptShape: ProductionAttemptShape;
  generatedRepairAttempts: GeneratedRepairAttemptSummary;
  reasons: Map<string, number>;
  diagnosticReasons: Map<string, number>;
}

function emptyGeneratedRepairAttemptSummary(): GeneratedRepairAttemptSummary {
  return {
    attempts: 0,
    proposalsCreated: 0,
    noProposal: 0,
    proposalRate: 0,
    captureRepairs: 0,
    diagnosticReslices: 0,
    proposalRepairs: 0,
  };
}

function hasGeneratedRepairAttemptSummary(summary: GeneratedRepairAttemptSummary): boolean {
  return summary.attempts > 0 ||
    summary.proposalsCreated > 0 ||
    summary.noProposal > 0 ||
    summary.captureRepairs > 0 ||
    summary.diagnosticReslices > 0 ||
    summary.proposalRepairs > 0;
}

function addGeneratedRepairAttempt(
  summary: GeneratedRepairAttemptSummary,
  kind: GeneratedRepairAttemptKind | undefined,
  proposalCreated: boolean,
): void {
  if (!kind) return;
  summary.attempts++;
  if (proposalCreated) summary.proposalsCreated++;
  else summary.noProposal++;
  summary.proposalRate = summary.attempts > 0 ? summary.proposalsCreated / summary.attempts : 0;
  if (kind === 'capture-repair') summary.captureRepairs++;
  else if (kind === 'no-diff-reslice') summary.diagnosticReslices++;
  else summary.proposalRepairs++;
}

function touchBucket(
  buckets: Map<string, MutableYieldBucket>,
  key: string,
  fields: Omit<Partial<MutableYieldBucket>, 'key' | 'attempts' | 'proposalsCreated' | 'spentUsd' | 'outcomes' | 'reasons'>,
): MutableYieldBucket {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      key,
      ...fields,
      attempts: 0,
      proposalsCreated: 0,
      spentUsd: 0,
      outcomes: emptyOutcomeCounts(),
      actionCounts: {},
      attemptShape: emptyProductionAttemptShape(),
      generatedRepairAttempts: emptyGeneratedRepairAttemptSummary(),
      reasons: new Map(),
      diagnosticReasons: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

function addToBucket(bucket: MutableYieldBucket, event: DispatchProductionEvent): void {
  bucket.attempts++;
  if (event.proposalCreated) bucket.proposalsCreated++;
  bucket.spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
  incrementOutcome(bucket.outcomes, event.outcome);
  addRunActionCounts(bucket.actionCounts, event.runEventSummary?.actionCounts);
  const classification = classifyProductionAttemptForLearningWithLabel({
    outcome: event.outcome,
    proposalCreated: event.proposalCreated,
    actionCounts: event.runEventSummary?.actionCounts,
    reason: event.reason ?? event.routeReason,
    itemId: event.itemId,
    title: event.title,
    source: event.source,
  }, event.learningLabel);
  addProductionAttemptShape(bucket.attemptShape, classification.attemptShape);
  addGeneratedRepairAttempt(
    bucket.generatedRepairAttempts,
    generatedRepairAttemptKindFromSignals({
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }),
    event.proposalCreated,
  );
  const reason = event.reason ?? event.routeReason ?? event.outcome;
  bucket.reasons.set(reason, (bucket.reasons.get(reason) ?? 0) + 1);
  addDiagnosticReason(bucket.diagnosticReasons, reason, classification);
}

function finalizeBucket(bucket: MutableYieldBucket): DispatchProductionYieldBucket {
  const proposalsCreated = bucket.proposalsCreated;
  const attempts = bucket.attempts;
  return {
    key: bucket.key,
    ...(bucket.backend !== undefined ? { backend: bucket.backend } : {}),
    ...(bucket.source !== undefined ? { source: bucket.source } : {}),
    ...(bucket.repo !== undefined ? { repo: bucket.repo } : {}),
    ...(bucket.model !== undefined ? { model: bucket.model } : {}),
    attempts,
    proposalsCreated,
    noProposal: Math.max(0, attempts - proposalsCreated),
    proposalRate: attempts > 0 ? proposalsCreated / attempts : 0,
    spentUsd: bucket.spentUsd,
    outcomes: bucket.outcomes,
    ...(hasRunActionCounts(bucket.actionCounts) ? { actionCounts: bucket.actionCounts } : {}),
    ...(hasProductionAttemptShape(bucket.attemptShape) ? { attemptShape: bucket.attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(bucket.generatedRepairAttempts)
      ? { generatedRepairAttempts: bucket.generatedRepairAttempts }
      : {}),
    topReasons: sortedReasons(bucket.reasons, 5),
    diagnosticTopReasons: sortedReasons(bucket.diagnosticReasons, 5),
  };
}

function sortedBuckets(buckets: Map<string, MutableYieldBucket>, limit: number): DispatchProductionYieldBucket[] {
  return [...buckets.values()]
    .map(finalizeBucket)
    .sort(
      (a, b) =>
        b.noProposal - a.noProposal ||
        a.proposalRate - b.proposalRate ||
        b.attempts - a.attempts ||
        a.key.localeCompare(b.key),
    )
    .slice(0, limit);
}

function summarizeGeneratedRepairBackendTransitions(
  events: DispatchProductionEvent[],
  limit: number,
): GeneratedRepairBackendTransitionSummary | undefined {
  const attempts = new Map<string, DispatchProductionEvent>();
  const conflicts = new Set<string>();
  let lineageEvents = 0;
  let transitionEvents = 0;
  let duplicateEvents = 0;
  let invalidLineageEvents = 0;

  for (const event of events) {
    const hasAnyLineage = event.repairLineageInvalid === true ||
      event.repairHandoffId !== undefined ||
      event.repairGenerationId !== undefined ||
      event.repairAttemptOrdinal !== undefined ||
      event.repairPreviousBackend !== undefined;
    if (!hasAnyLineage) continue;

    const complete = event.repairLineageInvalid !== true &&
      typeof event.repairHandoffId === 'string' && SHA256_RE.test(event.repairHandoffId) &&
      typeof event.repairGenerationId === 'string' && SHA256_RE.test(event.repairGenerationId) &&
      repairGenerationIdFromHandoffId(event.repairHandoffId) === event.repairGenerationId &&
      (event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2) &&
      (event.repairAttemptOrdinal === 1
        ? event.repairPreviousBackend === undefined
        : ENGINE_IDS.has(event.repairPreviousBackend as EngineId) && event.backend !== event.repairPreviousBackend);
    if (!complete || !ENGINE_IDS.has(event.backend as EngineId)) {
      invalidLineageEvents++;
      continue;
    }

    lineageEvents++;
    if (event.repairAttemptOrdinal !== 2 || event.repairPreviousBackend === undefined) continue;
    transitionEvents++;
    const executionId = event.runId ?? event.trajectoryId;
    if (!executionId) {
      invalidLineageEvents++;
      continue;
    }
    const key = `${event.repairGenerationId}:2:${executionId}`;
    const previous = attempts.get(key);
    if (!previous) {
      attempts.set(key, event);
      continue;
    }
    const same = previous.repairHandoffId === event.repairHandoffId &&
      previous.repairPreviousBackend === event.repairPreviousBackend &&
      previous.backend === event.backend &&
      previous.outcome === event.outcome &&
      previous.proposalCreated === event.proposalCreated;
    if (same) duplicateEvents++;
    else conflicts.add(key);
  }

  if (lineageEvents === 0 && invalidLineageEvents === 0) return undefined;

  const buckets = new Map<string, GeneratedRepairBackendTransitionBucket>();
  for (const [key, event] of attempts) {
    if (conflicts.has(key) || event.backend === null || event.repairPreviousBackend === undefined) continue;
    const bucketKey = `${event.repairPreviousBackend}:${event.backend}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        previousBackend: event.repairPreviousBackend,
        retryBackend: event.backend,
        attempts: 0,
        proposalsCreated: 0,
        noProposal: 0,
        proposalRate: 0,
        outcomes: emptyOutcomeCounts(),
      };
      buckets.set(bucketKey, bucket);
    }
    bucket.attempts++;
    if (event.proposalCreated) bucket.proposalsCreated++;
    else bucket.noProposal++;
    bucket.proposalRate = bucket.proposalsCreated / bucket.attempts;
    incrementOutcome(bucket.outcomes, event.outcome);
  }

  const aggregateAttempts = [...buckets.values()]
    .reduce((total, bucket) => total + bucket.attempts, 0);
  const byTransition = [...buckets.values()]
    .sort((a, b) => b.attempts - a.attempts ||
      a.previousBackend.localeCompare(b.previousBackend) ||
      a.retryBackend.localeCompare(b.retryBackend))
    .slice(0, limit);
  return {
    sourceState: conflicts.size > 0 || invalidLineageEvents > 0 ? 'degraded' : 'healthy',
    lineageEvents,
    transitionEvents,
    attempts: aggregateAttempts,
    duplicateEvents,
    conflictingAttempts: conflicts.size,
    invalidLineageEvents,
    byTransition,
  };
}

export function summarizeDispatchProductionYield(
  events: DispatchProductionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
  },
): DispatchProductionYieldSummary | undefined {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  if (events.length === 0) return undefined;

  const byBackend = new Map<string, MutableYieldBucket>();
  const bySource = new Map<string, MutableYieldBucket>();
  const byRepo = new Map<string, MutableYieldBucket>();
  const byBackendModel = new Map<string, MutableYieldBucket>();
  const byBackendSource = new Map<string, MutableYieldBucket>();
  const topReasons = new Map<string, number>();
  const overall = emptyOutcomeCounts();
  const actionCounts: RunActionCounts = {};
  const attemptShape = emptyProductionAttemptShape();
  const generatedRepairAttempts = emptyGeneratedRepairAttemptSummary();
  let proposalsCreated = 0;
  let spentUsd = 0;
  const diagnosticTopReasons = new Map<string, number>();

  for (const event of events) {
    if (event.proposalCreated) proposalsCreated++;
    spentUsd += Number.isFinite(event.spentUsd) ? event.spentUsd : 0;
    incrementOutcome(overall, event.outcome);
    addRunActionCounts(actionCounts, event.runEventSummary?.actionCounts);
    const classification = classifyProductionAttemptForLearningWithLabel({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
      reason: event.reason ?? event.routeReason,
      itemId: event.itemId,
      title: event.title,
      source: event.source,
    }, event.learningLabel);
    addProductionAttemptShape(attemptShape, classification.attemptShape);
    addGeneratedRepairAttempt(
      generatedRepairAttempts,
      generatedRepairAttemptKindFromSignals({
        itemId: event.itemId,
        title: event.title,
        source: event.source,
      }),
      event.proposalCreated,
    );
    const reason = event.reason ?? event.routeReason ?? event.outcome;
    topReasons.set(reason, (topReasons.get(reason) ?? 0) + 1);
    addDiagnosticReason(diagnosticTopReasons, reason, classification);

    const backendKey = event.backend ?? 'unknown';
    addToBucket(touchBucket(byBackend, backendKey, { backend: event.backend }), event);

    const sourceKey = event.source;
    addToBucket(touchBucket(bySource, sourceKey, { source: event.source }), event);

    const repoKey = event.repo;
    addToBucket(touchBucket(byRepo, repoKey, { repo: event.repo }), event);

    const modelKey = `${event.backend ?? 'unknown'}:${event.model ?? 'default'}`;
    addToBucket(touchBucket(byBackendModel, modelKey, { backend: event.backend, model: event.model ?? null }), event);

    const backendSourceKey = `${event.backend ?? 'unknown'}:${event.source}`;
    addToBucket(
      touchBucket(byBackendSource, backendSourceKey, { backend: event.backend, source: event.source }),
      event,
    );
  }

  const total = events.length;
  const generatedRepairBackendTransitions = summarizeGeneratedRepairBackendTransitions(events, limit);
  return {
    windowHours: opts?.windowHours ?? 24,
    attempts: total,
    events: total,
    proposalsCreated,
    noProposal: Math.max(0, total - proposalsCreated),
    proposalRate: total > 0 ? proposalsCreated / total : 0,
    spentUsd,
    outcomes: overall,
    ...(hasRunActionCounts(actionCounts) ? { actionCounts } : {}),
    ...(hasProductionAttemptShape(attemptShape) ? { attemptShape } : {}),
    ...(hasGeneratedRepairAttemptSummary(generatedRepairAttempts) ? { generatedRepairAttempts } : {}),
    ...(generatedRepairBackendTransitions ? { generatedRepairBackendTransitions } : {}),
    topReasons: sortedReasons(topReasons, limit),
    diagnosticTopReasons: sortedReasons(diagnosticTopReasons, limit),
    byBackend: sortedBuckets(byBackend, limit),
    bySource: sortedBuckets(bySource, limit),
    byRepo: sortedBuckets(byRepo, limit),
    byBackendModel: sortedBuckets(byBackendModel, limit),
    byBackendSource: sortedBuckets(byBackendSource, limit),
  };
}

export function readDispatchProductionYieldDetailed(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldReadResult {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const read = readDispatchProductionEventsDetailed({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
    maxBytes: opts?.maxBytes,
    maxRows: opts?.maxRows,
  });
  const summary = summarizeDispatchProductionYield(read.events, {
    windowHours: windowMs / (60 * 60 * 1000),
    limitPerDimension: opts?.limitPerDimension,
  });
  const { events: _events, ...sourceQuality } = read;
  return {
    ...(summary ? { summary } : {}),
    sourceQuality,
  };
}

export function readDispatchProductionYield(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  maxBytes?: number;
  maxRows?: number;
}): DispatchProductionYieldSummary | undefined {
  return readDispatchProductionYieldDetailed(opts).summary;
}
