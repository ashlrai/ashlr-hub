/**
 * agent-action-ledger.ts — append-only metadata stream for autonomous action traces.
 *
 * This is Ashlr's software-level global workspace substrate: compact, scrubbed
 * events that describe what the fleet attended to, tried, skipped, produced,
 * or blocked on. It is analytics/learning input only. It never grants outward
 * authority and never throws.
 */

import {
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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  EngineId,
  EngineTier,
  EvidenceOutcomeSummary,
  LabelBasis,
  LearningSource,
  RouteSnapshot,
  RunEventSummary,
  WorkSource,
} from '../types.js';
import { scrubSecrets } from '../util/scrub.js';
import { causalMetadata } from '../learning/causal.js';
import {
  classifyProductionAttemptForLearningWithLabel,
  sanitizeProductionAttemptLearningLabel,
  type ProductionAttemptLearningLabel,
} from '../learning/attempt-shape.js';
import {
  evidenceOutcomeSummary as normalizeEvidenceOutcome,
  routeSnapshot as normalizeRouteSnapshot,
  runEventSummary as normalizeRunEventSummary,
} from '../learning/causal.js';
import { listEnrolled } from '../sandbox/policy.js';
import { repairGenerationIdFromHandoffId } from './repair-handoff-journal.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_LEDGER_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DEFAULT_READ_MAX_FILES = 32;
const DEFAULT_READ_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_READ_MAX_ROWS = 100_000;
const HARD_READ_MAX_FILES = 366;
const HARD_READ_MAX_BYTES = 256 * 1024 * 1024;
const HARD_READ_MAX_ROWS = 1_000_000;
const MAX_READ_ROW_BYTES = 128 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_048;
const MAX_WRITE_PARTITIONS_PER_CALL = 32;
const ROUTE_SNAPSHOT_KEYS = new Set([
  'backend', 'tier', 'model', 'assignedBy', 'reason', 'routerPolicyVersion',
  'selectedSkillIds', 'skillPolicyVersion', 'skillMode',
]);
const RUN_SUMMARY_KEYS = new Set([
  'runId', 'status', 'outcome', 'proposalCreated', 'proposalId', 'diffFiles',
  'diffLines', 'tokensIn', 'tokensOut', 'costUsd', 'durationMs', 'cacheHit',
  'contextSummary', 'actionCounts',
]);
const EVIDENCE_OUTCOME_KEYS = new Set([
  'target', 'trustBasis', 'riskClass', 'verificationPassed', 'policyAllowed',
  'policyAction', 'policyTier', 'gateCount',
]);

export type AgentActionActor =
  | 'daemon'
  | 'agent'
  | 'judge'
  | 'verifier'
  | 'merge'
  | 'fleet'
  | 'system';

export type AgentActionKind =
  | 'tick'
  | 'selection'
  | 'route'
  | 'dispatch'
  | 'proposal'
  | 'verification'
  | 'judge'
  | 'merge'
  | 'guard'
  | 'maintenance'
  | 'context-rollup'
  | 'reflection';

export type AgentActionOutcome =
  | 'started'
  | 'ok'
  | 'skipped'
  | 'blocked'
  | 'failed'
  | 'proposal-created'
  | 'no-proposal'
  | 'verified'
  | 'judged'
  | 'merged'
  | 'rejected'
  | 'unknown';

export interface AgentActionEvent {
  schemaVersion: 1;
  ts: string;
  machineId?: string;
  actor: AgentActionActor;
  kind: AgentActionKind;
  outcome: AgentActionOutcome;
  action: string;
  summary: string;
  repo?: string;
  itemId?: string;
  source?: WorkSource;
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
  learningLabel?: ProductionAttemptLearningLabel;
  repairHandoffId?: string;
  repairGenerationId?: string;
  repairAttemptOrdinal?: 1 | 2;
  repairPreviousBackend?: EngineId;
  repairLineageInvalid?: true;
  backend?: EngineId | null;
  tier?: EngineTier | null;
  model?: string | null;
  reason?: string;
  durationMs?: number;
  spentUsd?: number;
  tags?: string[];
  counts?: Record<string, number>;
  /** Deterministic metadata-only identity for semantic context-rollup deduplication. */
  contextRollupId?: string;
  contextRollupPolicyVersion?: 'context-rollup-v1';
  contextRollupSourceMaxTs?: string;
}

const AGENT_ACTION_ACTORS = new Set<AgentActionActor>([
  'daemon',
  'agent',
  'judge',
  'verifier',
  'merge',
  'fleet',
  'system',
]);

const AGENT_ACTION_KINDS = new Set<AgentActionKind>([
  'tick',
  'selection',
  'route',
  'dispatch',
  'proposal',
  'verification',
  'judge',
  'merge',
  'guard',
  'maintenance',
  'context-rollup',
  'reflection',
]);

const AGENT_ACTION_OUTCOMES = new Set<AgentActionOutcome>([
  'started',
  'ok',
  'skipped',
  'blocked',
  'failed',
  'proposal-created',
  'no-proposal',
  'verified',
  'judged',
  'merged',
  'rejected',
  'unknown',
]);

const ENGINE_IDS = new Set<EngineId>([
  'builtin',
  'local-coder',
  'ashlrcode',
  'aw',
  'claude',
  'codex',
  'hermes',
  'kimi',
  'nim',
  'opencode',
  'grok',
]);

const ENGINE_TIERS = new Set<EngineTier>(['local', 'mid', 'frontier']);

const WORK_SOURCES = new Set<WorkSource>([
  'issue',
  'todo',
  'test',
  'dep',
  'doc',
  'security',
  'plugin',
  'self',
  'lint',
  'goal',
  'hygiene',
  'invent',
]);

export interface AgentActionCount {
  key: string;
  count: number;
}

export interface AgentWorkspaceAttention {
  kind: 'repo' | 'backend' | 'action' | 'outcome' | 'source';
  topic: string;
  weight: number;
  detail: string;
}

export interface AgentWorkspaceRecentAction {
  ts: string;
  actor: AgentActionActor;
  kind: AgentActionKind;
  outcome: AgentActionOutcome;
  action: string;
  summary: string;
  repo?: string;
  itemId?: string;
  proposalId?: string;
  runId?: string;
  trajectoryId?: string;
  learningSource?: LearningSource;
  labelBasis?: LabelBasis;
  backend?: EngineId | null;
  model?: string | null;
}

export interface AgentWorkspaceStatus {
  generatedAt: string;
  windowHours: number;
  eventCount: number;
  latestAt: string | null;
  activeMachines: string[];
  spendUsd: number;
  proposalEvents: number;
  noProposalEvents: number;
  diagnosticNoProposalEvents?: number;
  policySuppressedEvents?: number;
  diagnosticProposalRate?: number | null;
  diagnosticNoProposalRate?: number | null;
  repoEventCount: number;
  repoDistinctCount: number;
  topRepoCount: number;
  attention: AgentWorkspaceAttention[];
  byAction: AgentActionCount[];
  byOutcome: AgentActionCount[];
  byRepo: AgentActionCount[];
  byBackend: AgentActionCount[];
  entropy: {
    action: number;
    outcome: number;
    repo: number;
  };
  recentActions: AgentWorkspaceRecentAction[];
  sourceQuality?: AgentActionSourceQuality;
}

export type AgentActionRepoScope = 'enrolled-existing' | 'all';

export function agentActionsDir(): string {
  const configuredHome = process.env.ASHLR_HOME;
  const root =
    typeof configuredHome === 'string' && configuredHome.trim() !== '' && isAbsolute(configuredHome)
      ? configuredHome
      : join(homedir(), '.ashlr');
  return join(root, 'agent-actions');
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

function boundedText(value: string, max: number): string {
  const stripped = scrubSecrets(value);
  return stripped.length > max ? `${stripped.slice(0, max - 3)}...` : stripped;
}

function boundedOptionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return boundedText(value, max);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | undefined {
  return typeof value === 'string' && allowed.has(value as T) ? value as T : undefined;
}

function sanitizeCounts(counts: unknown): Record<string, number> | undefined {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts).slice(0, 20)) {
    if (!Number.isFinite(value)) continue;
    out[boundedText(key, 64)] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const out = tags
    .filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
    .slice(0, 12)
    .map((tag) => boundedText(tag.trim(), 48));
  return out.length > 0 ? out : undefined;
}

function sanitizeEvent(event: AgentActionEvent): AgentActionEvent {
  const ts = eventTimestamp(event.ts);
  const tags = sanitizeTags(event.tags);
  const counts = sanitizeCounts(event.counts);
  const durationMs = finiteNumber(event.durationMs);
  const spentUsd = finiteNumber(event.spentUsd);
  const learningLabel = sanitizeProductionAttemptLearningLabel(event.learningLabel);
  const source = enumValue(event.source, WORK_SOURCES);
  const backend = event.backend === null ? null : enumValue(event.backend, ENGINE_IDS);
  const tier = event.tier === null ? null : enumValue(event.tier, ENGINE_TIERS);
  const machineId = boundedOptionalText(event.machineId, 120);
  const repo = boundedOptionalText(event.repo, 500);
  const itemId = boundedOptionalText(event.itemId, 240);
  const proposalId = boundedOptionalText(event.proposalId, 160);
  const runId = boundedOptionalText(event.runId, 160);
  const model = boundedOptionalText(event.model, 160);
  const reason = boundedOptionalText(event.reason, 240);
  const repairHandoffId = typeof event.repairHandoffId === 'string' && /^[a-f0-9]{64}$/.test(event.repairHandoffId)
    ? event.repairHandoffId
    : undefined;
  const repairGenerationId = typeof event.repairGenerationId === 'string' && /^[a-f0-9]{64}$/.test(event.repairGenerationId)
    ? event.repairGenerationId
    : undefined;
  const repairAttemptOrdinal = event.repairAttemptOrdinal === 1 || event.repairAttemptOrdinal === 2
    ? event.repairAttemptOrdinal
    : undefined;
  const repairPreviousBackend = enumValue(event.repairPreviousBackend, ENGINE_IDS);
  const repairLineageFieldsPresent = event.repairHandoffId !== undefined ||
    event.repairGenerationId !== undefined ||
    event.repairAttemptOrdinal !== undefined ||
    event.repairPreviousBackend !== undefined;
  const repairLineageComplete = event.repairLineageInvalid !== true &&
    backend !== undefined &&
    backend !== null &&
    repairHandoffId !== undefined &&
    repairGenerationId !== undefined &&
    repairGenerationIdFromHandoffId(repairHandoffId) === repairGenerationId &&
    repairAttemptOrdinal !== undefined &&
    (repairAttemptOrdinal === 1
      ? repairPreviousBackend === undefined
      : repairPreviousBackend !== undefined && backend !== repairPreviousBackend);
  const repairLineageInvalid = event.repairLineageInvalid === true ||
    (repairLineageFieldsPresent && !repairLineageComplete);
  const contextRollupId = typeof event.contextRollupId === 'string' &&
    /^cr-[0-9a-f]{64}$/.test(event.contextRollupId) ? event.contextRollupId : undefined;
  const contextRollupPolicyVersion = event.contextRollupPolicyVersion === 'context-rollup-v1'
    ? event.contextRollupPolicyVersion
    : undefined;
  const contextRollupSourceMaxTs = typeof event.contextRollupSourceMaxTs === 'string' &&
    Number.isFinite(Date.parse(event.contextRollupSourceMaxTs)) &&
    new Date(Date.parse(event.contextRollupSourceMaxTs)).toISOString() === event.contextRollupSourceMaxTs
    ? event.contextRollupSourceMaxTs
    : undefined;
  const causal = causalMetadata({
    ts,
    itemId,
    proposalId,
    runId,
    trajectoryId: event.trajectoryId,
    routeSnapshot: event.routeSnapshot,
    runEventSummary: event.runEventSummary,
    evidenceOutcome: event.evidenceOutcome,
    learningSource: event.learningSource ?? 'agent-action',
    labelBasis: event.labelBasis ?? (event.kind === 'dispatch' ? 'dispatch-outcome' : 'unknown'),
    routerPolicyVersion: event.routerPolicyVersion,
    learningEpoch: event.learningEpoch,
  });

  return {
    schemaVersion: 1,
    ts,
    actor: enumValue(event.actor, AGENT_ACTION_ACTORS) ?? 'system',
    kind: enumValue(event.kind, AGENT_ACTION_KINDS) ?? 'reflection',
    outcome: enumValue(event.outcome, AGENT_ACTION_OUTCOMES) ?? 'unknown',
    action: boundedText(event.action, 120),
    summary: boundedText(event.summary, 240),
    ...(machineId ? { machineId } : {}),
    ...(repo ? { repo } : {}),
    ...(itemId ? { itemId } : {}),
    ...(source ? { source } : {}),
    ...(proposalId ? { proposalId } : {}),
    ...(runId ? { runId } : {}),
    ...causal,
    ...(learningLabel ? { learningLabel } : {}),
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
    ...(backend !== undefined ? { backend } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(model ? { model } : {}),
    ...(reason ? { reason } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.max(0, durationMs) } : {}),
    ...(spentUsd !== undefined ? { spentUsd: Math.max(0, spentUsd) } : {}),
    ...(tags ? { tags } : {}),
    ...(counts ? { counts } : {}),
    ...(contextRollupId ? { contextRollupId } : {}),
    ...(contextRollupPolicyVersion ? { contextRollupPolicyVersion } : {}),
    ...(contextRollupSourceMaxTs ? { contextRollupSourceMaxTs } : {}),
  };
}

function isAgentActionEvent(value: unknown): value is AgentActionEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    obj['schemaVersion'] === 1 &&
    typeof obj['ts'] === 'string' &&
    enumValue(obj['actor'], AGENT_ACTION_ACTORS) !== undefined &&
    enumValue(obj['kind'], AGENT_ACTION_KINDS) !== undefined &&
    enumValue(obj['outcome'], AGENT_ACTION_OUTCOMES) !== undefined &&
    typeof obj['action'] === 'string' && obj['action'].trim() !== '' &&
    typeof obj['summary'] === 'string' && obj['summary'].trim() !== '' &&
    validOptionalCausalRecord(obj['routeSnapshot'], ROUTE_SNAPSHOT_KEYS, normalizeRouteSnapshot, ['routerPolicyVersion']) &&
    validOptionalCausalRecord(obj['runEventSummary'], RUN_SUMMARY_KEYS, normalizeRunEventSummary) &&
    validOptionalCausalRecord(obj['evidenceOutcome'], EVIDENCE_OUTCOME_KEYS, normalizeEvidenceOutcome) &&
    (!['proposal-created', 'verified', 'judged', 'merged', 'rejected'].includes(String(obj['outcome'])) ||
      (typeof obj['proposalId'] === 'string' && obj['proposalId'].trim() !== ''))
  );
}

function validOptionalCausalRecord(
  value: unknown,
  recognizedKeys: ReadonlySet<string>,
  normalize: (input: never) => object | undefined,
  syntheticKeys: readonly string[] = [],
): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rawKeys = new Set(Object.keys(value));
  if (![...rawKeys].some((key) => recognizedKeys.has(key))) return false;
  const normalized = normalize(value as never);
  return normalized !== undefined && Object.keys(normalized).some((key) =>
    !syntheticKeys.includes(key) || rawKeys.has(key));
}

export interface AgentActionWriteResult {
  attempted: number;
  recorded: number;
}

export interface ReadAgentActionsOptions {
  sinceMs?: number;
  limit?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxRows?: number;
  filter?: (event: AgentActionEvent) => boolean;
  /** Stop after proving the logical event cap was exceeded; the result is explicitly partial. */
  stopAfterLimit?: boolean;
  /** Return no events unless every selected source row was read and validated. */
  requireComplete?: boolean;
}

export type AgentActionReadStopReason = 'event-limit' | 'file-limit' | 'byte-limit' | 'row-limit' | 'io-error';

export interface AgentActionSourceQuality {
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: AgentActionReadStopReason[];
  filesRead: number;
  bytesRead: number;
  rowsScanned: number;
  invalidRows: number;
  unreadableFiles: number;
}

export interface AgentActionsReadResult extends AgentActionSourceQuality {
  events: AgentActionEvent[];
}

function sameFile(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: ReturnType<typeof fstatSync>): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function unsafeLedgerFile(stat: ReturnType<typeof fstatSync>): boolean {
  return Number(stat.nlink) !== 1 || !ownedByCurrentUser(stat) || (Number(stat.mode) & 0o022) !== 0;
}

function unsafeLedgerDirectory(stat: ReturnType<typeof fstatSync>): boolean {
  return !ownedByCurrentUser(stat) || (Number(stat.mode) & 0o022) !== 0;
}

function sameDirectorySnapshot(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return sameFile(left, right) && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('agent-action append made no progress');
    offset += written;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function appendAgentActionLine(
  path: string,
  line: string,
  sync: boolean,
  dir: string,
  directorySnapshot: NonNullable<ReturnType<typeof lstatSync>>,
): void {
  let fd: number | undefined;
  try {
    const directoryBefore = lstatSync(dir);
    if (!sameFile(directorySnapshot, directoryBefore) || unsafeLedgerDirectory(directoryBefore)) {
      throw new Error('agent-action directory identity changed');
    }
    let pathBefore: NonNullable<ReturnType<typeof lstatSync>> | undefined;
    try {
      pathBefore = lstatSync(path);
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || unsafeLedgerFile(pathBefore)) {
        throw new Error('agent-action ledger path is unsafe');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fd = openSync(
      path,
      fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW |
        (pathBefore ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL),
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile() || unsafeLedgerFile(opened) || (pathBefore && !sameFile(pathBefore, opened))) {
      throw new Error('agent-action ledger is not a safe regular file');
    }
    fchmodSync(fd, 0o600);
    if (opened.size > 0) {
      const tail = Buffer.alloc(1);
      if (readSync(fd, tail, 0, 1, opened.size - 1) !== 1) {
        throw new Error('agent-action ledger tail is unreadable');
      }
      if (tail[0] !== 0x0a) writeAll(fd, Buffer.from('\n', 'utf8'));
    }
    writeAll(fd, Buffer.from(line, 'utf8'));
    if (sync) fsyncSync(fd);
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    const directoryAfter = lstatSync(dir);
    if (
      !after.isFile() || unsafeLedgerFile(after) || !sameFile(opened, after) ||
      pathAfter.isSymbolicLink() || !pathAfter.isFile() || !sameFile(after, pathAfter) ||
      !sameFile(directorySnapshot, directoryAfter) || unsafeLedgerDirectory(directoryAfter)
    ) throw new Error('agent-action append identity changed');
    if (sync && !pathBefore) fsyncDirectory(dir);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function recordAgentActionResult(
  input: AgentActionEvent | AgentActionEvent[],
  opts?: { sync?: boolean },
): AgentActionWriteResult {
  let attempted = 0;
  let recorded = 0;
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  try {
    const events = Array.isArray(input) ? input : [input];
    attempted = events.length;
    if (events.length === 0) return { attempted, recorded };
    const dir = agentActionsDir();
    const parentDir = dirname(dir);
    const parentDirectoryCreated = !existsSync(parentDir);
    const directoryCreated = !existsSync(dir);
    if (directoryCreated) mkdirSync(dir, { recursive: true, mode: 0o700 });
    lock = acquireLocalStoreLock(join(dir, '.agent-actions.lock'));
    if (!lock) return { attempted, recorded };
    const directoryBefore = lstatSync(dir);
    if (
      directoryBefore.isSymbolicLink() ||
      !directoryBefore.isDirectory() ||
      unsafeLedgerDirectory(directoryBefore)
    ) return { attempted, recorded };
    const partitions = new Set<string>();
    for (const event of events) {
      try {
        const record = sanitizeEvent(event);
        if (!isAgentActionEvent(record)) continue;
        const partition = eventDateString(record.ts);
        if (!partitions.has(partition) && partitions.size >= MAX_WRITE_PARTITIONS_PER_CALL) continue;
        partitions.add(partition);
        const path = join(dir, `${partition}.jsonl`);
        const line = JSON.stringify(record) + '\n';
        if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) continue;
        appendAgentActionLine(path, line, opts?.sync === true, dir, directoryBefore);
        recorded++;
      } catch {
        // Skip only this record; telemetry must never disrupt the caller.
      }
    }
    if (opts?.sync === true && directoryCreated && recorded > 0) {
      try {
        fsyncDirectory(parentDir);
        if (parentDirectoryCreated) fsyncDirectory(dirname(parentDir));
      } catch (error) {
        recorded = 0;
        throw error;
      }
    }
  } catch {
    // Telemetry/history must never fail dispatch.
  } finally {
    releaseLocalStoreLock(lock);
  }
  return { attempted, recorded };
}

export function recordAgentAction(input: AgentActionEvent | AgentActionEvent[]): void {
  void recordAgentActionResult(input);
}

function boundedReadOption(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(hardMax, Math.floor(value)))
    : fallback;
}

function emptyAgentActionRead(
  sourceState: AgentActionSourceQuality['sourceState'],
  overrides: Partial<AgentActionsReadResult> = {},
): AgentActionsReadResult {
  return {
    events: [],
    sourceState,
    sourcePresent: sourceState !== 'missing',
    complete: sourceState !== 'degraded',
    stopReasons: [],
    filesRead: 0,
    bytesRead: 0,
    rowsScanned: 0,
    invalidRows: 0,
    unreadableFiles: 0,
    ...overrides,
  };
}

function pushStopReason(reasons: AgentActionReadStopReason[], reason: AgentActionReadStopReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function readAgentActionFile(
  path: string,
  maxBytes: number,
): { ok: true; text: string; bytesRead: number } | { ok: false; reason: 'byte-limit' | 'io-error' } {
  let fd: number | undefined;
  try {
    const pathBefore = lstatSync(path);
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || unsafeLedgerFile(pathBefore)) {
      return { ok: false, reason: 'io-error' };
    }
    if (pathBefore.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || unsafeLedgerFile(before) || !sameFile(pathBefore, before)) {
      return { ok: false, reason: 'io-error' };
    }
    if (before.size > maxBytes) return { ok: false, reason: 'byte-limit' };
    const buffer = Buffer.alloc(before.size);
    const bytesRead = before.size > 0 ? readSync(fd, buffer, 0, before.size, 0) : 0;
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      pathAfter.isSymbolicLink() || !pathAfter.isFile() || !after.isFile() ||
      unsafeLedgerFile(after) || !sameFile(before, after) || !sameFile(after, pathAfter) ||
      after.size !== before.size || bytesRead !== before.size
    ) return { ok: false, reason: 'io-error' };
    return { ok: true, text: buffer.toString('utf8'), bytesRead };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best-effort read */ }
    }
  }
}

export function readAgentActionsDetailed(opts: ReadAgentActionsOptions = {}): AgentActionsReadResult {
  let lock: ReturnType<typeof acquireLocalStoreLock> | undefined;
  try {
    const maxFiles = boundedReadOption(opts.maxFiles, DEFAULT_READ_MAX_FILES, HARD_READ_MAX_FILES);
    const maxBytes = boundedReadOption(opts.maxBytes, DEFAULT_READ_MAX_BYTES, HARD_READ_MAX_BYTES);
    const maxRows = boundedReadOption(opts.maxRows, DEFAULT_READ_MAX_ROWS, HARD_READ_MAX_ROWS);
    const dir = agentActionsDir();
    if (!existsSync(dir)) return emptyAgentActionRead('missing');
    lock = acquireLocalStoreLock(join(dir, '.agent-actions.lock'), 250);
    if (!lock) {
      return emptyAgentActionRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }
    let directorySnapshot: ReturnType<typeof lstatSync>;
    try {
      directorySnapshot = lstatSync(dir);
      if (directorySnapshot.isSymbolicLink() || !directorySnapshot.isDirectory() || unsafeLedgerDirectory(directorySnapshot)) {
        return emptyAgentActionRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
      }
    } catch {
      return emptyAgentActionRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }

    let files: string[];
    try {
      const handle = opendirSync(dir);
      const selected: string[] = [];
      let entriesSeen = 0;
      const loose: string[] = [];
      let invalidDatedPartition = false;
      try {
        let entry = handle.readSync();
        while (entry !== null) {
          entriesSeen++;
          if (entriesSeen > MAX_DIRECTORY_ENTRIES) {
            return emptyAgentActionRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
          }
          if (entry.name.endsWith('.jsonl')) {
            if (!DATE_LEDGER_FILE_RE.test(entry.name)) loose.push(entry.name);
            else if (!validDatePartition(entry.name)) invalidDatedPartition = true;
            else if (opts.sinceMs === undefined || fileMayContainSince(entry.name, opts.sinceMs)) selected.push(entry.name);
          }
          entry = handle.readSync();
        }
      } finally {
        handle.closeSync();
      }
      if (invalidDatedPartition) {
        return emptyAgentActionRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
      }
      if (loose.length > 3) {
        return emptyAgentActionRead('degraded', { sourcePresent: true, complete: false, stopReasons: ['file-limit'] });
      }
      files = [...selected.sort().reverse(), ...loose.sort().reverse()];
    } catch {
      return emptyAgentActionRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
    }
    if (files.length === 0) return emptyAgentActionRead('healthy');

    const result = emptyAgentActionRead('healthy');
    result.sourcePresent = true;
    const eventLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.floor(opts.limit)
      : undefined;
    let stoppedAfterEventLimit = false;
    let datedFilesRead = 0;
    for (const file of files) {
      const datedPartition = DATE_LEDGER_FILE_RE.test(file);
      if (datedPartition && datedFilesRead >= maxFiles) {
        pushStopReason(result.stopReasons, 'file-limit');
        result.complete = false;
        continue;
      }
      const remainingBytes = maxBytes - result.bytesRead;
      if (remainingBytes <= 0) {
        pushStopReason(result.stopReasons, 'byte-limit');
        result.complete = false;
        break;
      }
      const loaded = readAgentActionFile(join(dir, file), remainingBytes);
      result.filesRead++;
      if (datedPartition) datedFilesRead++;
      if (!loaded.ok) {
        if (loaded.reason === 'io-error') result.unreadableFiles++;
        pushStopReason(result.stopReasons, loaded.reason);
        result.complete = false;
        break;
      }
      result.bytesRead += loaded.bytesRead;
      for (const line of loaded.text.split('\n').reverse()) {
        if (!line.trim()) continue;
        if (result.rowsScanned >= maxRows) {
          pushStopReason(result.stopReasons, 'row-limit');
          result.complete = false;
          break;
        }
        result.rowsScanned++;
        if (Buffer.byteLength(line, 'utf8') > MAX_READ_ROW_BYTES) {
          result.invalidRows++;
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(line);
          if (!isAgentActionEvent(parsed)) {
            result.invalidRows++;
            continue;
          }
          const eventMs = Date.parse(parsed.ts);
          const partitionDate = DATE_LEDGER_FILE_RE.exec(file)?.[1];
          if (!Number.isFinite(eventMs) ||
            (partitionDate !== undefined && new Date(eventMs).toISOString().slice(0, 10) !== partitionDate)) {
            result.invalidRows++;
            continue;
          }
          const sanitized = sanitizeEvent(parsed);
          if (opts.sinceMs !== undefined && eventMs < opts.sinceMs) continue;
          if (opts.filter && !opts.filter(sanitized)) continue;
          result.events.push(sanitized);
          if (opts.stopAfterLimit === true && eventLimit !== undefined && result.events.length > eventLimit) {
            pushStopReason(result.stopReasons, 'event-limit');
            result.complete = false;
            stoppedAfterEventLimit = true;
            break;
          }
        } catch {
          result.invalidRows++;
        }
      }
      if (!result.complete) break;
    }

    try {
      const directoryAfter = lstatSync(dir);
      if (
        directoryAfter.isSymbolicLink() || !directoryAfter.isDirectory() ||
        unsafeLedgerDirectory(directoryAfter) || !sameDirectorySnapshot(directorySnapshot, directoryAfter)
      ) {
        pushStopReason(result.stopReasons, 'io-error');
        result.complete = false;
        result.unreadableFiles++;
      }
    } catch {
      pushStopReason(result.stopReasons, 'io-error');
      result.complete = false;
      result.unreadableFiles++;
    }
    result.events.sort((left, right) => Date.parse(right.ts) - Date.parse(left.ts));
    if (eventLimit !== undefined) {
      if (!stoppedAfterEventLimit && result.events.length > eventLimit) {
        pushStopReason(result.stopReasons, 'event-limit');
        result.complete = false;
      }
      result.events = result.events.slice(0, eventLimit);
    }
    if (result.invalidRows > 0 || result.unreadableFiles > 0 || !result.complete) {
      result.complete = false;
      result.sourceState = 'degraded';
    }
    return result;
  } catch {
    return emptyAgentActionRead('degraded', { complete: false, stopReasons: ['io-error'], unreadableFiles: 1 });
  } finally {
    releaseLocalStoreLock(lock);
  }
}

export function readAgentActions(opts: ReadAgentActionsOptions = {}): AgentActionEvent[] {
  const result = readAgentActionsDetailed({
    ...opts,
    stopAfterLimit: opts.stopAfterLimit ?? opts.requireComplete !== true,
  });
  const events = opts.requireComplete === true && (!result.complete || result.sourceState === 'degraded')
    ? []
    : result.events;
  Object.defineProperty(events, 'sourceQuality', {
    value: {
      sourceState: result.sourceState,
      sourcePresent: result.sourcePresent,
      complete: result.complete,
      stopReasons: result.stopReasons,
      filesRead: result.filesRead,
      bytesRead: result.bytesRead,
      rowsScanned: result.rowsScanned,
      invalidRows: result.invalidRows,
      unreadableFiles: result.unreadableFiles,
    } satisfies AgentActionSourceQuality,
    enumerable: false,
  });
  return events;
}

function enrolledExistingRepos(repos?: readonly string[]): Set<string> {
  const candidates = repos ?? listEnrolled();
  const out = new Set<string>();
  for (const repo of candidates) {
    if (typeof repo !== 'string' || repo.trim() === '') continue;
    const abs = resolve(repo);
    if (existsSync(abs)) out.add(abs);
  }
  return out;
}

export function filterAgentActionsByRepoScope(
  events: readonly AgentActionEvent[],
  opts?: {
    repoScope?: AgentActionRepoScope;
    enrolledRepos?: readonly string[];
  },
): AgentActionEvent[] {
  if (opts?.repoScope === 'all') return [...events];
  const allowed = enrolledExistingRepos(opts?.enrolledRepos);
  return events.filter((event) => {
    if (!event.repo) return true;
    return allowed.has(resolve(event.repo));
  });
}

function fileMayContainSince(file: string, sinceMs: number): boolean {
  const match = DATE_LEDGER_FILE_RE.exec(file);
  if (!match) return true;
  const endOfDayMs = Date.parse(`${match[1]}T23:59:59.999Z`);
  return !Number.isFinite(endOfDayMs) || endOfDayMs >= sinceMs;
}

function validDatePartition(file: string): boolean {
  const date = DATE_LEDGER_FILE_RE.exec(file)?.[1];
  if (!date) return false;
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === date;
}

function increment(map: Map<string, number>, key: string | null | undefined): void {
  const normalized = key && key.trim() ? key.trim() : 'unknown';
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function topCounts(map: Map<string, number>, limit: number): AgentActionCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function entropy(counts: AgentActionCount[]): number {
  const total = counts.reduce((sum, count) => sum + count.count, 0);
  if (total <= 0) return 0;
  const value = counts.reduce((sum, count) => {
    const p = count.count / total;
    return p > 0 ? sum - p * Math.log2(p) : sum;
  }, 0);
  return Math.round(value * 1000) / 1000;
}

function recentAction(event: AgentActionEvent): AgentWorkspaceRecentAction {
  return {
    ts: event.ts,
    actor: event.actor,
    kind: event.kind,
    outcome: event.outcome,
    action: event.action,
    summary: event.summary,
    ...(event.repo ? { repo: event.repo } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.proposalId ? { proposalId: event.proposalId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.trajectoryId ? { trajectoryId: event.trajectoryId } : {}),
    ...(event.learningSource ? { learningSource: event.learningSource } : {}),
    ...(event.labelBasis ? { labelBasis: event.labelBasis } : {}),
    ...(event.backend !== undefined ? { backend: event.backend } : {}),
    ...(event.model !== undefined ? { model: event.model } : {}),
  };
}

function isAgentWorkspaceProductionEvent(event: AgentActionEvent): boolean {
  return event.kind === 'dispatch' ||
    event.kind === 'proposal' ||
    event.outcome === 'proposal-created' ||
    event.outcome === 'no-proposal';
}

function proposalCreatedSignal(event: AgentActionEvent): boolean | undefined {
  if (event.runEventSummary?.proposalCreated === true) return true;
  if (event.runEventSummary?.proposalCreated === false) return false;
  if (event.outcome === 'proposal-created') return true;
  if (event.outcome === 'no-proposal') return false;
  return undefined;
}

function attentionFromCounts(
  kind: AgentWorkspaceAttention['kind'],
  rows: AgentActionCount[],
  detailPrefix: string,
  limit: number,
): AgentWorkspaceAttention[] {
  return rows.slice(0, limit).map((row) => ({
    kind,
    topic: row.key,
    weight: row.count,
    detail: `${detailPrefix}: ${row.count}`,
  }));
}

export function summarizeAgentWorkspace(
  events: AgentActionEvent[],
  opts?: {
    windowHours?: number;
    limitPerDimension?: number;
    recentLimit?: number;
  },
): AgentWorkspaceStatus {
  const limit = opts?.limitPerDimension !== undefined && opts.limitPerDimension > 0
    ? Math.floor(opts.limitPerDimension)
    : 8;
  const recentLimit = opts?.recentLimit !== undefined && opts.recentLimit > 0
    ? Math.floor(opts.recentLimit)
    : 10;
  const byAction = new Map<string, number>();
  const byOutcome = new Map<string, number>();
  const byRepo = new Map<string, number>();
  const byBackend = new Map<string, number>();
  const bySource = new Map<string, number>();
  const contextRollupIds = new Set<string>();
  const semanticEvents: AgentActionEvent[] = [];
  const activeMachines = new Set<string>();
  let spendUsd = 0;
  let proposalEvents = 0;
  let noProposalEvents = 0;
  let diagnosticNoProposalEvents = 0;
  let policySuppressedEvents = 0;
  let latestAt: string | null = null;

  for (const event of events) {
    if (event.kind === 'context-rollup') {
      if (!event.contextRollupId || contextRollupIds.has(event.contextRollupId)) continue;
      contextRollupIds.add(event.contextRollupId);
    }
    semanticEvents.push(event);
    increment(byAction, event.kind);
    increment(byOutcome, event.outcome);
    if (event.repo) increment(byRepo, event.repo);
    if (event.backend) increment(byBackend, event.backend);
    if (event.source) increment(bySource, event.source);
    if (event.machineId) activeMachines.add(event.machineId);
    spendUsd += finiteNumber(event.spentUsd) ?? 0;
    if (event.outcome === 'proposal-created') proposalEvents++;
    if (event.outcome === 'no-proposal') noProposalEvents++;
    if (isAgentWorkspaceProductionEvent(event)) {
      const classification = classifyProductionAttemptForLearningWithLabel({
        outcome: event.runEventSummary?.outcome ?? event.outcome,
        proposalCreated: proposalCreatedSignal(event),
        actionCounts: event.runEventSummary?.actionCounts,
        reason: event.reason,
      }, event.learningLabel);
      if (classification.diagnosticNoProposal) diagnosticNoProposalEvents++;
      if (classification.policySuppressed) policySuppressedEvents++;
    }
    if (!latestAt || Date.parse(event.ts) > Date.parse(latestAt)) latestAt = event.ts;
  }

  const actionRows = topCounts(byAction, limit);
  const outcomeRows = topCounts(byOutcome, limit);
  const repoRows = topCounts(byRepo, limit);
  const backendRows = topCounts(byBackend, limit);
  const sourceRows = topCounts(bySource, limit);
  const repoEventCount = [...byRepo.values()].reduce((sum, count) => sum + count, 0);
  const topRepoCount = [...byRepo.values()].reduce((max, count) => Math.max(max, count), 0);
  const diagnosticProposalDenominator = proposalEvents + diagnosticNoProposalEvents;

  const attention = [
    ...attentionFromCounts('repo', repoRows, 'repo events', 3),
    ...attentionFromCounts('outcome', outcomeRows, 'outcomes', 2),
    ...attentionFromCounts('backend', backendRows, 'backend events', 2),
    ...attentionFromCounts('source', sourceRows, 'source events', 1),
  ].slice(0, 8);

  return {
    generatedAt: new Date().toISOString(),
    windowHours: opts?.windowHours ?? 24,
    eventCount: semanticEvents.length,
    latestAt,
    activeMachines: [...activeMachines].sort().slice(0, 10),
    spendUsd,
    proposalEvents,
    noProposalEvents,
    diagnosticNoProposalEvents,
    policySuppressedEvents,
    diagnosticProposalRate: diagnosticProposalDenominator > 0
      ? proposalEvents / diagnosticProposalDenominator
      : null,
    diagnosticNoProposalRate: diagnosticProposalDenominator > 0
      ? diagnosticNoProposalEvents / diagnosticProposalDenominator
      : null,
    repoEventCount,
    repoDistinctCount: byRepo.size,
    topRepoCount,
    attention,
    byAction: actionRows,
    byOutcome: outcomeRows,
    byRepo: repoRows,
    byBackend: backendRows,
    entropy: {
      action: entropy(actionRows),
      outcome: entropy(outcomeRows),
      repo: entropy(repoRows),
    },
    recentActions: semanticEvents.slice(0, recentLimit).map(recentAction),
  };
}

export interface AgentWorkspaceReadResult {
  workspace: AgentWorkspaceStatus;
  events: AgentActionEvent[];
  sourceQuality: AgentActionSourceQuality;
}

export function readAgentWorkspaceDetailed(opts?: {
  windowMs?: number;
  limit?: number;
  limitPerDimension?: number;
  recentLimit?: number;
  repoScope?: AgentActionRepoScope;
  enrolledRepos?: readonly string[];
}): AgentWorkspaceReadResult {
  const windowMs = opts?.windowMs ?? 24 * 60 * 60 * 1000;
  const sinceMs = Date.now() - windowMs;
  const maxFiles = Math.max(1, Math.ceil(windowMs / DAY_MS) + 1);
  const read = readAgentActionsDetailed({
    sinceMs,
    limit: opts?.limit ?? 1000,
    maxFiles,
  });
  const events = filterAgentActionsByRepoScope(read.events, {
    repoScope: opts?.repoScope,
    enrolledRepos: opts?.enrolledRepos,
  });
  const workspace = summarizeAgentWorkspace(events, {
    windowHours: windowMs / (60 * 60 * 1000),
    limitPerDimension: opts?.limitPerDimension,
    recentLimit: opts?.recentLimit,
  });
  const sourceQuality: AgentActionSourceQuality = {
    sourceState: read.sourceState,
    sourcePresent: read.sourcePresent,
    complete: read.complete,
    stopReasons: read.stopReasons,
    filesRead: read.filesRead,
    bytesRead: read.bytesRead,
    rowsScanned: read.rowsScanned,
    invalidRows: read.invalidRows,
    unreadableFiles: read.unreadableFiles,
  };
  workspace.sourceQuality = sourceQuality;
  return { workspace, events, sourceQuality };
}

export function readAgentWorkspace(opts?: Parameters<typeof readAgentWorkspaceDetailed>[0]): AgentWorkspaceStatus {
  return readAgentWorkspaceDetailed(opts).workspace;
}
