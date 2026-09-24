/**
 * core/verse/fleet-history.ts — `GET /api/verse/fleet/history` (V3.10, unit A8).
 *
 * A daily projection of what the fleet did — runs, proposals, judge verdicts,
 * verification results, authenticated merges — plus the persisted fleet
 * scorecard trend, for the Fleet/Growth charts. Wire contract and honesty
 * rules: ./fleet-history-types.ts.
 *
 * ── WHY IT DOES NOT CALL THE CANONICAL LIST READERS ────────────────────────
 * `listRunsDetailed`, `listProposalsDetailed` and `readDecisionsDetailed` are
 * synchronous. Measured against a copy of a real ~/.ashlr (5,295 runs / 76 MB,
 * 674 proposals / 11 MB, 1,166 decision rows): 1.2 s, 263 ms and 33 ms of
 * event-loop blocking PER CALL — against a 20 ms budget for any handler. And
 * they re-read everything every time.
 *
 * So this module keeps its own INCREMENTAL, ASYNC, TIME-SLICED readers:
 *   - file contents are read with fs/promises (off the loop) under the same
 *     guards the canonical readers use (lstat → no symlink, single link, owned
 *     by us, not group/world-writable; open O_NOFOLLOW; fstat identity and
 *     size re-checked after the read; per-file byte bound);
 *   - each file is reduced to a tiny metadata summary, cached by
 *     (ino, size, mtime), so a refresh only re-reads files that changed;
 *   - parsing yields to the event loop whenever a slice passes SLICE_MS.
 * It extracts counts and timestamps only. It never returns goal text, diffs,
 * prompts or absolute paths, and it is never merge or learning authority:
 * realized merges are still classified by `authenticatedRealizedMergeOf`, the
 * same HMAC-verified witness the scorecard uses.
 *
 * ── THE SCORECARD TREND ────────────────────────────────────────────────────
 * `snapshotScorecardIfDue` had no caller, so no trend history ever existed.
 * This service now drives it (at most hourly; the snapshot itself is daily)
 * through a worker thread (fleet-history-worker.ts) because one snapshot is
 * ~0.5 s of synchronous reads. When the worker cannot start — the compiled
 * single-file binary only bundles the workers scripts/build-sea.mjs lists —
 * it falls back to running the maintenance INLINE but DEFERRED and never on a
 * request's path: the request is answered from cache immediately.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { sendJson } from '../web/api.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { createBoundedReadWorker, type BoundedReadWorker } from '../web/bounded-read-worker.js';
import { decisionsDir } from '../fleet/decisions-ledger.js';
import { authenticatedRealizedMergeOf, canonicalRealizedMergeIdentity } from '../inbox/realized-merge.js';
import {
  runScorecardHistoryMaintenance,
  type ScorecardHistoryMaintenanceResult,
  type ScorecardTrend,
  type ScorecardTrendPoint,
} from '../fleet/scorecard.js';
import type { ApiModule } from './api-modules.js';
import {
  FLEET_HISTORY_WORKER_KIND,
  normalizeFleetHistoryWorkerRequest,
  type FleetHistoryWorkerPayload,
} from './fleet-history-worker-protocol.js';
import {
  FLEET_DARK_AFTER_MS,
  FLEET_HISTORY_DEFAULT_DAYS,
  FLEET_HISTORY_MAX_DAYS,
  FLEET_HISTORY_MIN_DAYS,
  type FleetHistoryDay,
  type FleetHistoryFunnel,
  type FleetHistoryResponse,
  type FleetHistoryScorecard,
  type FleetHistorySource,
  type FleetRunStatus,
  type FleetScorecardSnapshotMode,
  type FleetScorecardTrendPoint,
  type FleetSwimlane,
  type FleetSwimlaneItem,
} from './fleet-history-types.js';

export * from './fleet-history-types.js';

// Compile-time guard: the browser-safe structural copy must keep accepting
// the real scorecard point, or the wire contract has silently drifted.
const TREND_POINT_SHAPE_CHECK: (point: ScorecardTrendPoint) => FleetScorecardTrendPoint = (point) => point;
void TREND_POINT_SHAPE_CHECK;

export const FLEET_HISTORY_PATH = '/api/verse/fleet/history';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
/** Parse work per event-loop turn before yielding (the handler budget is 20 ms). */
const SLICE_MS = 8;
/** Concurrent file reads in flight (fs threadpool is 4 by default; a few extra hide latency). */
const READ_CONCURRENCY = 8;
/** Same per-file bound the canonical run reader uses; bigger files are skipped and reported. */
const MAX_RUN_FILE_BYTES = 1024 * 1024;
/** Canonical proposal store bound. */
const MAX_PROPOSAL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DECISION_FILE_BYTES = 64 * 1024 * 1024;
const MAX_DECISION_ROW_BYTES = 128 * 1024;
const MAX_RUN_FILES = 20_000;
const MAX_PROPOSAL_FILES = 4_096;
const MAX_DECISION_FILES = 800;
/**
 * Swimlane bound: newest runs first. 400 bars is more than a 1,400 px timeline
 * can separate, and each bar costs ~13 µs of secret-scrubbing at serialize
 * time (600 bars measured 7.7 ms of the 20 ms handler budget).
 */
const MAX_SWIMLANE_ITEMS = 400;
/** A `running` run with no update for this long is flagged stale (likely orphaned). */
const STALE_RUNNING_MS = 30 * 60 * 1000;
/** Timestamps further in the future than this are clock garbage, not activity. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** A projection younger than this is served as-is (no polling faster than 2 s anywhere). */
const HISTORY_FRESH_MS = 30_000;
/** Scorecard trend cache lifetime, and the in-process snapshot attempt cadence. */
const TREND_FRESH_MS = 10 * 60 * 1000;
const SNAPSHOT_ATTEMPT_INTERVAL_MS = 60 * 60 * 1000;
/** Inline fallback runs this long after being scheduled, off any request's path. */
const INLINE_MAINTENANCE_DELAY_MS = 15_000;
/** Consecutive worker failures before the service gives up on the worker. */
const WORKER_FAILURES_BEFORE_INLINE = 2;
const WORKER_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Time slicing
// ---------------------------------------------------------------------------

/**
 * Cooperative yield: callers `await slicer.gate()` BEFORE each unit of parse
 * work, so once a slice is spent every queued continuation yields before
 * parsing. A slice therefore never exceeds SLICE_MS plus one bounded parse.
 */
class Slicer {
  private sliceStart = performance.now();
  async gate(): Promise<void> {
    if (performance.now() - this.sliceStart < SLICE_MS) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.sliceStart = performance.now();
  }
}

async function mapPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Guarded async file reads (mirrors decisions-ledger.ts readDecisionFile)
// ---------------------------------------------------------------------------

function ownedByCurrentUser(stat: { uid: number | bigint }): boolean {
  return typeof process.getuid !== 'function' || Number(stat.uid) === process.getuid();
}

function notWritableByOthers(stat: { mode: number | bigint }): boolean {
  return process.platform === 'win32' || (Number(stat.mode) & 0o022) === 0;
}

function safeFileStat(stat: BigIntStats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && Number(stat.nlink) === 1 &&
    ownedByCurrentUser(stat) && notWritableByOthers(stat);
}

type FileReadFailure = 'oversized-file' | 'unsafe-file' | 'io-error';

async function readGuardedFile(
  path: string,
  expected: BigIntStats,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: FileReadFailure }> {
  if (!safeFileStat(expected)) return { ok: false, reason: 'unsafe-file' };
  if (Number(expected.size) > maxBytes) return { ok: false, reason: 'oversized-file' };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK: if the path was swapped for a FIFO after lstat, open must
    // not hang the threadpool; the fstat identity check below rejects it.
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!safeFileStat(before) || before.ino !== expected.ino || before.dev !== expected.dev) {
      return { ok: false, reason: 'unsafe-file' };
    }
    const size = Number(before.size);
    if (size > maxBytes) return { ok: false, reason: 'oversized-file' };
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== size || after.size !== before.size || after.ino !== before.ino) {
      return { ok: false, reason: 'io-error' };
    }
    return { ok: true, text: buffer.toString('utf8') };
  } catch {
    return { ok: false, reason: 'io-error' };
  } finally {
    try { await handle?.close(); } catch { /* best-effort */ }
  }
}

// ---------------------------------------------------------------------------
// Incremental directory reader
// ---------------------------------------------------------------------------

interface DirectoryScan<T> {
  state: 'healthy' | 'degraded' | 'missing';
  values: T[];
  reasons: string[];
  recordsRead: number;
  recordsSkipped: number;
}

interface CachedFile<T> {
  key: string;
  values: T[];
  skipped: number;
  reasons: string[];
}

interface DirectorySpec<T> {
  dir: () => string;
  include: (name: string) => boolean;
  maxFiles: number;
  maxFileBytes: number;
  /** Order the candidate names so a `maxFiles` cut keeps the most useful ones. */
  order?: (a: string, b: string) => number;
  /** Returns the extracted values plus rows skipped inside the file. */
  extract: (text: string, name: string) => { values: T[]; skipped: number; reasons: string[] };
}

/**
 * Reads one ledger directory, caching each file's extracted summary by
 * (dev, ino, size, mtime) so a refresh re-reads only what changed.
 */
class IncrementalDirectory<T> {
  private cache = new Map<string, CachedFile<T>>();
  private cachedDir: string | null = null;

  constructor(private readonly spec: DirectorySpec<T>) {}

  async scan(slicer: Slicer): Promise<DirectoryScan<T>> {
    const dir = this.spec.dir();
    if (dir !== this.cachedDir) {
      // HOME moved (tests, or a relocated ASHLR_HOME): never serve another root's cache.
      this.cache.clear();
      this.cachedDir = dir;
    }
    let dirStat: BigIntStats;
    try {
      dirStat = await lstat(dir, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.clear();
        return { state: 'missing', values: [], reasons: [], recordsRead: 0, recordsSkipped: 0 };
      }
      return degradedScan(['io-error']);
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !ownedByCurrentUser(dirStat) || !notWritableByOthers(dirStat)) {
      return degradedScan(['unsafe-directory']);
    }

    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => this.spec.include(name));
    } catch {
      return degradedScan(['io-error']);
    }
    const reasons = new Set<string>();
    if (this.spec.order) names.sort(this.spec.order);
    if (names.length > this.spec.maxFiles) {
      reasons.add('file-limit');
      names = names.slice(0, this.spec.maxFiles);
    }

    const values: T[] = [];
    let recordsRead = 0;
    let recordsSkipped = 0;
    const seen = new Set<string>();

    await mapPool(names, READ_CONCURRENCY, async (name) => {
      seen.add(name);
      const path = join(dir, name);
      let stat: BigIntStats;
      try {
        stat = await lstat(path, { bigint: true });
      } catch {
        reasons.add('io-error');
        recordsSkipped++;
        return;
      }
      const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      const cached = this.cache.get(name);
      let entry: CachedFile<T>;
      if (cached && cached.key === key) {
        entry = cached;
      } else {
        const loaded = await readGuardedFile(path, stat, this.spec.maxFileBytes);
        if (!loaded.ok) {
          entry = { key, values: [], skipped: 1, reasons: [loaded.reason] };
          // io-error is transient: do not pin it in the cache.
          if (loaded.reason !== 'io-error') this.cache.set(name, entry);
        } else {
          await slicer.gate();
          try {
            const extracted = this.spec.extract(loaded.text, name);
            entry = { key, values: extracted.values, skipped: extracted.skipped, reasons: extracted.reasons };
          } catch {
            entry = { key, values: [], skipped: 1, reasons: ['invalid-file'] };
          }
          this.cache.set(name, entry);
        }
      }
      for (const value of entry.values) values.push(value);
      recordsRead += entry.values.length;
      recordsSkipped += entry.skipped;
      for (const reason of entry.reasons) reasons.add(reason);
    });

    for (const name of this.cache.keys()) {
      if (!seen.has(name)) this.cache.delete(name);
    }
    const reasonList = [...reasons].sort();
    return {
      state: reasonList.length > 0 ? 'degraded' : 'healthy',
      values,
      reasons: reasonList,
      recordsRead,
      recordsSkipped,
    };
  }
}

function degradedScan<T>(reasons: string[]): DirectoryScan<T> {
  return { state: 'degraded', values: [], reasons, recordsRead: 0, recordsSkipped: 0 };
}

// ---------------------------------------------------------------------------
// Extractors — metadata only
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Engine ids are free-form on disk; keep them short and identifier-shaped. */
function engineLabel(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const cleaned = value.replace(/[^\w.:-]/g, '').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/** Repository basename only — an absolute path never leaves this module. */
function repoLabel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return null;
  const name = basename(value.replace(/[\\/]+$/, '')).replace(/[^\w.@+-]/g, '').slice(0, 80);
  return name.length > 0 && name !== '.' && name !== '..' ? name : null;
}

const RUN_STATUSES: ReadonlySet<FleetRunStatus> = new Set(['running', 'done', 'failed', 'aborted']);
const RUN_FILE_RE = /^[\w.-]+\.json$/;

export interface RunSummary {
  id: string;
  createdMs: number;
  updatedMs: number;
  status: FleetRunStatus;
  engine: string;
  repo: string | null;
  estCostUsd: number | null;
}

export function extractRun(text: string, name: string): { values: RunSummary[]; skipped: number; reasons: string[] } {
  const parsed = recordOf(JSON.parse(text));
  const id = parsed?.['id'];
  const status = parsed?.['status'];
  const createdMs = timeOf(parsed?.['createdAt']);
  const updatedMs = timeOf(parsed?.['updatedAt']);
  if (!parsed || typeof id !== 'string' || `${id}.json` !== name || typeof status !== 'string' ||
    !RUN_STATUSES.has(status as FleetRunStatus) || createdMs === null) {
    return { values: [], skipped: 1, reasons: ['invalid-file'] };
  }
  const scope = recordOf(parsed['delegationScope']);
  const usage = recordOf(parsed['usage']);
  const cost = usage?.['estCostUsd'];
  return {
    values: [{
      id,
      createdMs,
      updatedMs: updatedMs !== null && updatedMs >= createdMs ? updatedMs : createdMs,
      status: status as FleetRunStatus,
      engine: engineLabel(parsed['engine']),
      repo: repoLabel(scope?.['sourceRepo']),
      estCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    }],
    skipped: 0,
    reasons: [],
  };
}

const PROPOSAL_FILE_RE = /^[\w.-]+\.json$/;
const PROPOSAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed']);
const INFRA_FAILURES = new Set(['tool', 'timeout', 'infra', 'cancelled', 'invalid-command']);

export type VerificationOutcome = 'passed' | 'failed-code' | 'failed-infra' | 'failed-unknown';

export interface ProposalSummary {
  id: string;
  createdMs: number;
  withDiff: boolean;
  verification: { outcome: VerificationOutcome; atMs: number; ranTests: boolean } | null;
  /** Authenticated realized merge witness time, when there is one. */
  realizedMs: number | null;
  /** Canonical merge identity, for duplicate detection (never serialized). */
  realizedKey: string | null;
}

export function extractProposal(
  text: string,
  name: string,
): { values: ProposalSummary[]; skipped: number; reasons: string[] } {
  const parsed = recordOf(JSON.parse(text));
  const id = parsed?.['id'];
  const createdMs = timeOf(parsed?.['createdAt']);
  if (!parsed || typeof id !== 'string' || `${id}.json` !== name || createdMs === null ||
    typeof parsed['status'] !== 'string' || !PROPOSAL_STATUSES.has(parsed['status'])) {
    return { values: [], skipped: 1, reasons: ['invalid-file'] };
  }
  const diff = parsed['diff'];
  const withDiff = typeof diff === 'string' && diff.trim().length > 0 && parsed['isPartial'] !== true;

  let verification: ProposalSummary['verification'] = null;
  const verify = recordOf(parsed['verifyResult']);
  if (verify && typeof verify['passed'] === 'boolean') {
    const category = verify['failureCategory'];
    const outcome: VerificationOutcome = verify['passed'] === true
      ? 'passed'
      : category === 'code'
        ? 'failed-code'
        : typeof category === 'string' && INFRA_FAILURES.has(category)
          ? 'failed-infra'
          : 'failed-unknown';
    const ran = Array.isArray(verify['ran']) ? verify['ran'] : [];
    const ranTests = ran.some((entry) => recordOf(entry)?.['kind'] === 'test');
    // Legacy results carry no verifiedAt; the proposal's filing time is the
    // closest honest day (verification runs right after capture).
    verification = { outcome, atMs: timeOf(verify['verifiedAt']) ?? createdMs, ranTests };
  }

  let realizedMs: number | null = null;
  let realizedKey: string | null = null;
  if (parsed['status'] === 'applied' && withDiff && (parsed['kind'] === 'patch' || parsed['kind'] === 'pr')) {
    // Same witness the scorecard trusts: an HMAC-verified realized merge.
    const evidence = authenticatedRealizedMergeOf(parsed);
    const identity = evidence ? canonicalRealizedMergeIdentity(parsed) : null;
    if (evidence && identity) {
      realizedMs = timeOf(evidence.source === 'local-default-branch'
        ? evidence.observedAt
        : evidence.reconciliation.observedAt);
      realizedKey = identity.key;
    }
  }
  return { values: [{ id, createdMs, withDiff, verification, realizedMs, realizedKey }], skipped: 0, reasons: [] };
}

const DECISION_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type JudgeBucket = 'ship' | 'review' | 'noise' | 'harmful' | 'failed';

export interface DecisionSummary {
  tsMs: number;
  proposalId: string;
  action: string;
  judge: JudgeBucket | null;
}

const REASON_CODE_BUCKET: Readonly<Record<string, JudgeBucket>> = {
  'judge-ship-would-merge': 'ship',
  'judge-ship-review-required': 'ship',
  'judge-review': 'review',
  'judge-noise': 'noise',
  'judge-harmful': 'harmful',
  'judge-verdict-unrecognized': 'failed',
  'judge-parse-failure': 'failed',
  'judge-network-failure': 'failed',
};

export function judgeBucketOf(row: Record<string, unknown>): JudgeBucket {
  const code = row['judgeReasonCode'];
  if (typeof code === 'string' && REASON_CODE_BUCKET[code]) return REASON_CODE_BUCKET[code]!;
  const verdict = row['verdict'];
  // Legacy rows predate reason codes; only the four considered verdicts count as judgments.
  if (verdict === 'ship' || verdict === 'review' || verdict === 'noise' || verdict === 'harmful') return verdict;
  return 'failed';
}

export function extractDecisions(text: string): { values: DecisionSummary[]; skipped: number; reasons: string[] } {
  const values: DecisionSummary[] = [];
  let skipped = 0;
  const reasons = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    if (line.length > MAX_DECISION_ROW_BYTES) {
      skipped++;
      reasons.add('oversized-row');
      continue;
    }
    let row: Record<string, unknown> | null;
    try {
      row = recordOf(JSON.parse(line));
    } catch {
      row = null;
    }
    const tsMs = timeOf(row?.['ts']);
    const proposalId = row?.['proposalId'];
    const action = row?.['action'];
    if (!row || tsMs === null || typeof proposalId !== 'string' || typeof action !== 'string') {
      skipped++;
      reasons.add('invalid-row');
      continue;
    }
    values.push({ tsMs, proposalId, action, judge: action === 'judged' ? judgeBucketOf(row) : null });
  }
  return { values, skipped, reasons: [...reasons] };
}

// ---------------------------------------------------------------------------
// Aggregation (pure — unit tested directly)
// ---------------------------------------------------------------------------

export interface FleetHistoryInputs {
  nowMs: number;
  days: number;
  tzOffsetMinutes: number;
  runs: DirectoryScan<RunSummary>;
  proposals: DirectoryScan<ProposalSummary>;
  decisions: DirectoryScan<DecisionSummary>;
  scorecard: FleetHistoryScorecard;
}

/** YYYY-MM-DD for `ms` in a zone `tzOffsetMinutes` behind UTC (Date#getTimezoneOffset semantics). */
export function dayKey(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function windowDays(nowMs: number, days: number, tzOffsetMinutes: number): { keys: string[]; fromMs: number } {
  const today = dayKey(nowMs, tzOffsetMinutes);
  const todayStartUtc = Date.parse(`${today}T00:00:00Z`) + tzOffsetMinutes * 60_000;
  const fromMs = todayStartUtc - (days - 1) * DAY_MS;
  const keys: string[] = [];
  for (let i = 0; i < days; i++) keys.push(dayKey(fromMs + i * DAY_MS + DAY_MS / 2, tzOffsetMinutes));
  return { keys, fromMs };
}

function sourceOf(scan: DirectoryScan<unknown>, lastRecordMs: number | null): FleetHistorySource {
  return {
    state: scan.state,
    complete: scan.state !== 'degraded',
    reasons: scan.reasons,
    recordsRead: scan.recordsRead,
    recordsSkipped: scan.recordsSkipped,
    lastRecordAt: lastRecordMs === null ? null : new Date(lastRecordMs).toISOString(),
  };
}

/**
 * A source that produced nothing readable at all while degraded is UNKNOWN;
 * a degraded source that still produced records yields lower bounds.
 */
function unreadable(scan: DirectoryScan<unknown>): boolean {
  return scan.state === 'degraded' && scan.recordsRead === 0;
}

function emptyDay(day: string, known: { runs: boolean; proposals: boolean; decisions: boolean; merges: boolean }): FleetHistoryDay {
  const r = known.runs ? 0 : null;
  const p = known.proposals ? 0 : null;
  const d = known.decisions ? 0 : null;
  return {
    day,
    runs: { started: r, done: r, failed: r, aborted: r, unfinished: r },
    proposals: { filed: p, withDiff: p },
    judged: { total: d, ship: d, review: d, noise: d, harmful: d, failed: d },
    verification: { passed: p, failedCode: p, failedInfra: p, failedUnknown: p, withTests: p },
    merges: { realized: known.merges ? 0 : null },
    claimCheck: { passed: null, flagged: null },
    estCostUsd: known.runs ? 0 : null,
  };
}

function bump(value: number | null, by = 1): number | null {
  return value === null ? null : value + by;
}

export function buildFleetHistory(input: FleetHistoryInputs): FleetHistoryResponse {
  const { nowMs, days, tzOffsetMinutes } = input;
  const { keys, fromMs } = windowDays(nowMs, days, tzOffsetMinutes);
  const latestAllowed = nowMs + MAX_FUTURE_SKEW_MS;
  const inWindow = (ms: number) => ms >= fromMs && ms <= latestAllowed;

  // Duplicate canonical merge identities make the realized count ambiguous;
  // the scorecard degrades to unknown in that case and so does this.
  const mergeKeys = new Map<string, string>();
  let duplicateMerge = false;
  for (const proposal of input.proposals.values) {
    if (!proposal.realizedKey) continue;
    const prior = mergeKeys.get(proposal.realizedKey);
    if (prior !== undefined && prior !== proposal.id) duplicateMerge = true;
    else mergeKeys.set(proposal.realizedKey, proposal.id);
  }

  const known = {
    runs: !unreadable(input.runs),
    proposals: !unreadable(input.proposals),
    decisions: !unreadable(input.decisions),
    merges: !unreadable(input.proposals) && !duplicateMerge,
  };
  const byDay = new Map<string, FleetHistoryDay>(keys.map((key) => [key, emptyDay(key, known)]));
  const dayFor = (ms: number): FleetHistoryDay | undefined => (inWindow(ms) ? byDay.get(dayKey(ms, tzOffsetMinutes)) : undefined);

  let lastRunMs: number | null = null;
  let lastProposalMs: number | null = null;
  let lastDecisionMs: number | null = null;
  const later = (a: number | null, b: number): number | null => (b > latestAllowed ? a : a === null || b > a ? b : a);

  // ── runs ────────────────────────────────────────────────────────────────
  const windowRuns: RunSummary[] = [];
  for (const run of input.runs.values) {
    lastRunMs = later(lastRunMs, run.updatedMs);
    lastRunMs = later(lastRunMs, run.createdMs);
    const day = dayFor(run.createdMs);
    if (!day) continue;
    windowRuns.push(run);
    day.runs.started = bump(day.runs.started);
    if (run.status === 'done') day.runs.done = bump(day.runs.done);
    else if (run.status === 'failed') day.runs.failed = bump(day.runs.failed);
    else if (run.status === 'aborted') day.runs.aborted = bump(day.runs.aborted);
    else day.runs.unfinished = bump(day.runs.unfinished);
    if (run.estCostUsd !== null && day.estCostUsd !== null) day.estCostUsd += run.estCostUsd;
  }

  // ── proposals, verification, merges ───────────────────────────────────
  const windowProposals: ProposalSummary[] = [];
  for (const proposal of input.proposals.values) {
    lastProposalMs = later(lastProposalMs, proposal.createdMs);
    const filedDay = dayFor(proposal.createdMs);
    if (filedDay) {
      windowProposals.push(proposal);
      filedDay.proposals.filed = bump(filedDay.proposals.filed);
      if (proposal.withDiff) filedDay.proposals.withDiff = bump(filedDay.proposals.withDiff);
    }
    if (proposal.verification) {
      const vDay = dayFor(proposal.verification.atMs);
      if (vDay) {
        const v = vDay.verification;
        if (proposal.verification.outcome === 'passed') v.passed = bump(v.passed);
        else if (proposal.verification.outcome === 'failed-code') v.failedCode = bump(v.failedCode);
        else if (proposal.verification.outcome === 'failed-infra') v.failedInfra = bump(v.failedInfra);
        else v.failedUnknown = bump(v.failedUnknown);
        if (proposal.verification.ranTests) v.withTests = bump(v.withTests);
      }
    }
    if (known.merges && proposal.realizedMs !== null && proposal.realizedMs <= nowMs) {
      const mDay = dayFor(proposal.realizedMs);
      if (mDay) mDay.merges.realized = bump(mDay.merges.realized);
    }
  }

  // ── decisions ───────────────────────────────────────────────────────────
  const shipProposals = new Set<string>();
  for (const row of input.decisions.values) {
    lastDecisionMs = later(lastDecisionMs, row.tsMs);
    if (row.judge === null) continue;
    if (row.judge === 'ship' && row.tsMs <= latestAllowed) shipProposals.add(row.proposalId);
    const day = dayFor(row.tsMs);
    if (!day) continue;
    const j = day.judged;
    j.total = bump(j.total);
    j[row.judge] = bump(j[row.judge]);
  }

  // ── funnel (cumulative, proposal-centric) ─────────────────────────────────
  let funnel: FleetHistoryFunnel;
  if (!known.proposals) {
    funnel = { filed: null, verified: null, verificationPassed: null, judgedShip: null, merged: null };
  } else {
    let verified = 0;
    let passed = 0;
    let ship = 0;
    let merged = 0;
    for (const p of windowProposals) {
      if (!p.verification) continue;
      verified++;
      if (p.verification.outcome !== 'passed') continue;
      passed++;
      if (!shipProposals.has(p.id)) continue;
      ship++;
      if (p.realizedMs !== null) merged++;
    }
    funnel = {
      filed: windowProposals.length,
      verified,
      verificationPassed: passed,
      judgedShip: known.decisions ? ship : null,
      merged: known.decisions && known.merges ? merged : null,
    };
  }

  // ── swimlanes ─────────────────────────────────────────────────────────────
  windowRuns.sort((a, b) => b.createdMs - a.createdMs || a.id.localeCompare(b.id));
  const swimlanesTruncated = windowRuns.length > MAX_SWIMLANE_ITEMS;
  const laneMap = new Map<string, FleetSwimlane & { newestMs: number }>();
  for (const run of windowRuns.slice(0, MAX_SWIMLANE_ITEMS)) {
    const laneId = run.repo ?? `engine:${run.engine}`;
    let lane = laneMap.get(laneId);
    if (!lane) {
      lane = { id: laneId, label: run.repo ?? `${run.engine} (no repo)`, items: [], newestMs: run.createdMs };
      laneMap.set(laneId, lane);
    }
    const running = run.status === 'running';
    const item: FleetSwimlaneItem = {
      id: run.id,
      startMs: run.createdMs,
      endMs: running ? null : run.updatedMs,
      status: run.status,
      engine: run.engine,
      stale: running && nowMs - run.updatedMs > STALE_RUNNING_MS,
    };
    lane.items.push(item);
  }
  const swimlanes: FleetSwimlane[] = [...laneMap.values()]
    .sort((a, b) => b.newestMs - a.newestMs || a.label.localeCompare(b.label))
    .map(({ id, label, items }) => ({ id, label, items: items.reverse() }));

  // ── totals, activity ──────────────────────────────────────────────────────
  const dayList = keys.map((key) => byDay.get(key)!);
  const sum = (pick: (day: FleetHistoryDay) => number | null): number | null => {
    let total = 0;
    for (const day of dayList) {
      const value = pick(day);
      if (value === null) return null;
      total += value;
    }
    return total;
  };
  const cost = sum((day) => day.estCostUsd);
  const production = [lastRunMs, lastProposalMs].filter((ms): ms is number => ms !== null);
  const lastActivityMs = production.length > 0 ? Math.max(...production) : null;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    window: {
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      days,
      tzOffsetMinutes,
    },
    days: dayList,
    totals: {
      runsStarted: sum((day) => day.runs.started),
      proposalsFiled: sum((day) => day.proposals.filed),
      judged: sum((day) => day.judged.total),
      verificationPassed: sum((day) => day.verification.passed),
      mergesRealized: sum((day) => day.merges.realized),
      estCostUsd: cost === null ? null : Math.round(cost * 10_000) / 10_000,
    },
    funnel,
    swimlanes,
    swimlanesTruncated,
    lastActivityAt: lastActivityMs === null ? null : new Date(lastActivityMs).toISOString(),
    darkSince: lastActivityMs !== null && nowMs - lastActivityMs > FLEET_DARK_AFTER_MS
      ? new Date(lastActivityMs).toISOString()
      : null,
    sources: {
      runs: sourceOf(input.runs, lastRunMs),
      proposals: duplicateMerge
        ? {
            ...sourceOf(input.proposals, lastProposalMs),
            state: 'degraded',
            complete: false,
            reasons: [...input.proposals.reasons, 'duplicate-canonical-realized-merge-identity'].sort(),
          }
        : sourceOf(input.proposals, lastProposalMs),
      decisions: sourceOf(input.decisions, lastDecisionMs),
      claimCheck: {
        state: 'not-recorded',
        complete: false,
        reasons: ['claim-integrity-verdicts-not-persisted'],
        recordsRead: 0,
        recordsSkipped: 0,
        lastRecordAt: null,
      },
    },
    scorecard: input.scorecard,
  };
}

// ---------------------------------------------------------------------------
// Scorecard trend service (worker first, deferred inline fallback)
// ---------------------------------------------------------------------------

export type ScorecardMaintenanceRunner = (payload: FleetHistoryWorkerPayload) => Promise<ScorecardHistoryMaintenanceResult>;

export interface ScorecardTrendServiceOptions {
  now?: () => number;
  /** Off-thread runner; rejects when the worker cannot run. Omit to use the real worker. */
  runWorker?: ScorecardMaintenanceRunner | null;
  /** Inline fallback; synchronous by nature. Defaults to runScorecardHistoryMaintenance. */
  runInline?: (payload: FleetHistoryWorkerPayload) => ScorecardHistoryMaintenanceResult;
  /** Test seam for the deferred inline schedule. */
  schedule?: (fn: () => void, delayMs: number) => void;
  closeWorker?: () => Promise<void>;
}

export interface ScorecardTrendService {
  get(limit: number): Promise<FleetHistoryScorecard>;
  close(): Promise<void>;
  mode(): FleetScorecardSnapshotMode;
}

function trendSource(result: ScorecardHistoryMaintenanceResult | null, pendingReason: string | null): FleetHistorySource {
  if (!result) {
    return {
      state: 'degraded',
      complete: false,
      reasons: [pendingReason ?? 'scorecard-trend-pending'],
      recordsRead: 0,
      recordsSkipped: 0,
      lastRecordAt: null,
    };
  }
  const qualities = [result.trend7d.sourceQuality, result.trend30d.sourceQuality];
  const degraded = qualities.some((q) => q.sourceState === 'degraded' || !q.complete);
  const missing = qualities.every((q) => q.sourceState === 'missing');
  const points = [...result.trend7d.points, ...result.trend30d.points];
  const newest = points.reduce<number | null>((acc, point) => {
    const ms = Date.parse(point.ts);
    return Number.isFinite(ms) && (acc === null || ms > acc) ? ms : acc;
  }, null);
  return {
    state: degraded ? 'degraded' : missing ? 'missing' : 'healthy',
    complete: !degraded,
    reasons: [...new Set(qualities.flatMap((q) => q.reasons))].sort(),
    recordsRead: points.length,
    recordsSkipped: 0,
    lastRecordAt: newest === null ? null : new Date(newest).toISOString(),
  };
}

function oldestFirst(trend: ScorecardTrend): FleetScorecardTrendPoint[] {
  return [...trend.points].reverse();
}

function workerEntrypoint(): URL {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === 'file:' && moduleUrl.pathname.endsWith('/fleet-history.ts')) {
    // Source tree (tsx / vitest): register the dev loader inside the thread,
    // exactly like read-projections.ts does for its worker.
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
    const source = new URL('./fleet-history-worker.ts', import.meta.url).href;
    const bootstrap = `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`;
    return new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`);
  }
  return new URL('./fleet-history-worker.js', import.meta.url);
}

function createWorkerRunner(): { run: ScorecardMaintenanceRunner; close: () => Promise<void> } {
  let worker: BoundedReadWorker | null = null;
  return {
    run: async (payload) => {
      worker ??= createBoundedReadWorker({
        workerEntrypoint,
        workerData: null,
        normalize: normalizeFleetHistoryWorkerRequest,
        maxPending: 2,
        timeoutMs: WORKER_TIMEOUT_MS,
      });
      return await worker.read(FLEET_HISTORY_WORKER_KIND, payload) as ScorecardHistoryMaintenanceResult;
    },
    close: async () => {
      const current = worker;
      worker = null;
      await current?.close();
    },
  };
}

export function createScorecardTrendService(options: ScorecardTrendServiceOptions = {}): ScorecardTrendService {
  const now = options.now ?? Date.now;
  const runInline = options.runInline ?? runScorecardHistoryMaintenance;
  const schedule = options.schedule ?? ((fn, delayMs) => { setTimeout(fn, delayMs).unref(); });
  let runWorker: ScorecardMaintenanceRunner | null;
  let closeWorker: (() => Promise<void>) | undefined = options.closeWorker;
  if (options.runWorker === undefined) {
    const created = createWorkerRunner();
    runWorker = created.run;
    closeWorker = created.close;
  } else {
    runWorker = options.runWorker;
  }

  let mode: FleetScorecardSnapshotMode = runWorker ? 'worker' : 'inline';
  let cached: ScorecardHistoryMaintenanceResult | null = null;
  let cachedAtMs = 0;
  let cachedLimit = 0;
  let lastAttemptMs: number | null = null;
  let lastWroteMs: number | null = null;
  let workerFailures = 0;
  let inflight: Promise<void> | null = null;
  let inlineScheduled = false;
  let lastError: string | null = null;
  let closed = false;

  const snapshotDue = (): boolean => lastAttemptMs === null || now() - lastAttemptMs >= SNAPSHOT_ATTEMPT_INTERVAL_MS;

  function accept(result: ScorecardHistoryMaintenanceResult, limit: number): void {
    cached = result;
    cachedAtMs = now();
    cachedLimit = limit;
    lastError = null;
    if (result.wrote) lastWroteMs = now();
  }

  function scheduleInline(limit: number): void {
    if (inlineScheduled || closed) return;
    inlineScheduled = true;
    schedule(() => {
      inlineScheduled = false;
      if (closed) return;
      const snapshot = snapshotDue();
      if (snapshot) lastAttemptMs = now();
      try {
        accept(runInline({ snapshot, limit }), limit);
      } catch {
        lastError = 'scorecard-trend-unavailable';
      }
    }, INLINE_MAINTENANCE_DELAY_MS);
  }

  async function refreshViaWorker(limit: number): Promise<void> {
    const snapshot = snapshotDue();
    if (snapshot) lastAttemptMs = now();
    try {
      accept(await runWorker!({ snapshot, limit }), limit);
      workerFailures = 0;
    } catch {
      workerFailures++;
      lastError = 'scorecard-worker-unavailable';
      // Let the next attempt retry the snapshot rather than waiting an hour.
      if (snapshot) lastAttemptMs = null;
      if (workerFailures >= WORKER_FAILURES_BEFORE_INLINE) {
        mode = 'inline';
        void closeWorker?.().catch(() => undefined);
        scheduleInline(limit);
      }
    }
  }

  // Views are memoized per limit and rebuilt only when the state they show
  // changes, so an unchanged trend is the SAME object on every call — the
  // history service keys its serialized-payload memo on that identity.
  const views = new Map<number, { stamp: string; view: FleetHistoryScorecard }>();

  function view(limit: number): FleetHistoryScorecard {
    const stamp = `${cachedAtMs}|${mode}|${lastAttemptMs}|${lastWroteMs}|${lastError}`;
    const memo = views.get(limit);
    if (memo && memo.stamp === stamp) return memo.view;
    const built: FleetHistoryScorecard = {
      trend7d: cached ? oldestFirst(cached.trend7d).slice(-limit) : [],
      trend30d: cached ? oldestFirst(cached.trend30d).slice(-limit) : [],
      source: trendSource(cached, lastError),
      snapshot: {
        mode,
        lastAttemptAt: lastAttemptMs === null ? null : new Date(lastAttemptMs).toISOString(),
        lastWroteAt: lastWroteMs === null ? null : new Date(lastWroteMs).toISOString(),
      },
    };
    if (views.size >= 8) views.clear();
    views.set(limit, { stamp, view: built });
    return built;
  }

  return {
    mode: () => mode,
    async get(limit) {
      if (closed) return view(limit);
      const fresh = cached !== null && now() - cachedAtMs < TREND_FRESH_MS && cachedLimit >= limit && !snapshotDue();
      if (fresh) return view(limit);
      if (mode === 'worker') {
        inflight ??= refreshViaWorker(Math.max(limit, cachedLimit)).finally(() => { inflight = null; });
        await inflight;
      } else {
        // Inline never runs on a request's path: answer from cache now.
        scheduleInline(Math.max(limit, cachedLimit));
      }
      return view(limit);
    },
    async close() {
      closed = true;
      await closeWorker?.().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Fleet history service
// ---------------------------------------------------------------------------

export interface FleetHistoryQuery {
  days: number;
  tzOffsetMinutes: number;
}

export interface FleetHistoryService {
  get(query: FleetHistoryQuery): Promise<FleetHistoryResponse>;
  /** The public JSON body for `query` (sanitized, serialized, memoized per projection). */
  getPayload(query: FleetHistoryQuery): Promise<string>;
  close(): Promise<void>;
}

/**
 * Public JSON for a projection, with the secret/home-path scrub applied to
 * every part that carries text derived from disk.
 *
 * WHY NOT sanitizePublicJson(whole): it scrubs every KEY as well as every
 * string, and a 365-day history has ~11,000 constant keys — measured 24 ms
 * for the whole object versus 8 ms for the disk-derived parts, over the 20 ms
 * handler budget. `days`, `totals`, `funnel`, `window` and the top-level
 * timestamps are built only from numbers, `toISOString()` and `dayKey()`
 * output, so the scrub is provably a no-op on them; the test suite asserts
 * that this output equals sanitizePublicJson(whole) byte for byte.
 */
export function serializeFleetHistory(history: FleetHistoryResponse): string {
  return JSON.stringify({
    ...history,
    swimlanes: sanitizePublicJson(history.swimlanes),
    sources: sanitizePublicJson(history.sources),
    scorecard: sanitizePublicJson(history.scorecard),
  });
}

const MAX_MEMOIZED_PAYLOADS = 8;

export interface FleetHistoryServiceOptions {
  now?: () => number;
  scorecard?: ScorecardTrendService;
  /** Directory resolvers (default: under the CURRENT HOME, resolved per scan). */
  runsDir?: () => string;
  inboxDir?: () => string;
  decisionsDir?: () => string;
}

/** Mirrors core/run/orchestrator.ts runsDir() (not exported there). */
function defaultRunsDir(): string {
  return join(homedir(), '.ashlr', 'runs');
}

/** Mirrors core/inbox/store.ts inboxDir(); importing the store would load its whole write path. */
function defaultInboxDir(): string {
  return join(homedir(), '.ashlr', 'inbox');
}

export function createFleetHistoryService(options: FleetHistoryServiceOptions = {}): FleetHistoryService {
  const now = options.now ?? Date.now;
  const scorecard = options.scorecard ?? createScorecardTrendService({ now });
  const runs = new IncrementalDirectory<RunSummary>({
    dir: options.runsDir ?? defaultRunsDir,
    include: (name) => RUN_FILE_RE.test(name),
    maxFiles: MAX_RUN_FILES,
    maxFileBytes: MAX_RUN_FILE_BYTES,
    // Run ids are not time-ordered; a file-limit cut is reported, not hidden.
    order: (a, b) => a.localeCompare(b),
    extract: extractRun,
  });
  const proposals = new IncrementalDirectory<ProposalSummary>({
    dir: options.inboxDir ?? defaultInboxDir,
    include: (name) => PROPOSAL_FILE_RE.test(name),
    maxFiles: MAX_PROPOSAL_FILES,
    maxFileBytes: MAX_PROPOSAL_FILE_BYTES,
    order: (a, b) => a.localeCompare(b),
    extract: extractProposal,
  });
  const decisions = new IncrementalDirectory<DecisionSummary>({
    dir: options.decisionsDir ?? decisionsDir,
    include: (name) => DECISION_FILE_RE.test(name),
    maxFiles: MAX_DECISION_FILES,
    maxFileBytes: MAX_DECISION_FILE_BYTES,
    // Newest day files first, so a file-limit cut drops the oldest history.
    order: (a, b) => b.localeCompare(a),
    extract: (text) => extractDecisions(text),
  });

  let scans: {
    atMs: number;
    runs: DirectoryScan<RunSummary>;
    proposals: DirectoryScan<ProposalSummary>;
    decisions: DirectoryScan<DecisionSummary>;
  } | null = null;
  let scanning: Promise<void> | null = null;
  /** Serialized bodies for the current scan + trend, keyed by query. */
  const payloads = new Map<string, { scanAtMs: number; trend: FleetHistoryScorecard; body: string }>();

  async function current(query: FleetHistoryQuery): Promise<{ history: FleetHistoryResponse; scanAtMs: number; trend: FleetHistoryScorecard }> {
    if (!scans || now() - scans.atMs >= HISTORY_FRESH_MS) {
      scanning ??= rescan().finally(() => { scanning = null; });
      await scanning;
    }
    const scan = scans!;
    const trend = await scorecard.get(Math.min(FLEET_HISTORY_MAX_DAYS, query.days));
    const history = buildFleetHistory({
      nowMs: scan.atMs,
      days: query.days,
      tzOffsetMinutes: query.tzOffsetMinutes,
      runs: scan.runs,
      proposals: scan.proposals,
      decisions: scan.decisions,
      scorecard: trend,
    });
    return { history, scanAtMs: scan.atMs, trend };
  }

  async function rescan(): Promise<void> {
    const slicer = new Slicer();
    // Sequential on purpose: each reader already pipelines its own reads, and
    // running three at once would only interleave their parse slices.
    const runScan = await runs.scan(slicer);
    const proposalScan = await proposals.scan(slicer);
    const decisionScan = await decisions.scan(slicer);
    scans = { atMs: now(), runs: runScan, proposals: proposalScan, decisions: decisionScan };
  }

  return {
    async get(query) {
      return (await current(query)).history;
    },
    async getPayload(query) {
      const key = `${query.days}:${query.tzOffsetMinutes}`;
      // Fast path: same scan and same trend object → the same bytes.
      if (scans && now() - scans.atMs < HISTORY_FRESH_MS) {
        const memo = payloads.get(key);
        const trend = await scorecard.get(Math.min(FLEET_HISTORY_MAX_DAYS, query.days));
        if (memo && memo.scanAtMs === scans.atMs && memo.trend === trend) return memo.body;
      }
      const built = await current(query);
      const body = serializeFleetHistory(built.history);
      for (const [memoKey, memo] of payloads) {
        if (memo.scanAtMs !== built.scanAtMs) payloads.delete(memoKey);
      }
      if (payloads.size >= MAX_MEMOIZED_PAYLOADS) payloads.delete(payloads.keys().next().value!);
      payloads.set(key, { scanAtMs: built.scanAtMs, trend: built.trend, body });
      return body;
    },
    async close() {
      await scorecard.close();
    },
  };
}

let serviceSingleton: FleetHistoryService | null = null;

/** The per-process service (lazily created on the first request). */
export function getFleetHistoryService(): FleetHistoryService {
  serviceSingleton ??= createFleetHistoryService();
  return serviceSingleton;
}

/** Test/reset hook: close the current service and optionally install another. */
export async function resetFleetHistoryServiceForTests(next: FleetHistoryService | null = null): Promise<void> {
  const previous = serviceSingleton;
  serviceSingleton = next;
  await previous?.close();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type FleetHistoryQueryResult =
  | { ok: true; query: FleetHistoryQuery }
  | { ok: false; code: 'INVALID_DAYS' | 'INVALID_TZ'; error: string };

/** Strict query parsing: absent → default; present but malformed → 400, never silently clamped. */
export function parseFleetHistoryQuery(url: string | undefined): FleetHistoryQueryResult {
  let params: URLSearchParams;
  try {
    params = new URL(url ?? '', 'http://localhost').searchParams;
  } catch {
    params = new URLSearchParams();
  }
  let days = FLEET_HISTORY_DEFAULT_DAYS;
  const rawDays = params.get('days');
  if (rawDays !== null) {
    if (!/^\d{1,3}$/.test(rawDays) || Number(rawDays) < FLEET_HISTORY_MIN_DAYS || Number(rawDays) > FLEET_HISTORY_MAX_DAYS) {
      return {
        ok: false,
        code: 'INVALID_DAYS',
        error: `days must be an integer from ${FLEET_HISTORY_MIN_DAYS} to ${FLEET_HISTORY_MAX_DAYS}`,
      };
    }
    days = Number(rawDays);
  }
  let tzOffsetMinutes = 0;
  const rawTz = params.get('tz');
  if (rawTz !== null) {
    // Date#getTimezoneOffset range: UTC-12 is +720, UTC+14 is -840.
    if (!/^-?\d{1,3}$/.test(rawTz) || Number(rawTz) < -840 || Number(rawTz) > 720) {
      return { ok: false, code: 'INVALID_TZ', error: 'tz must be a Date#getTimezoneOffset() value in minutes' };
    }
    tzOffsetMinutes = Number(rawTz);
  }
  return { ok: true, query: { days, tzOffsetMinutes } };
}

/**
 * `GET /api/verse/fleet/history?days=90&tz=<getTimezoneOffset()>` — see
 * FleetHistoryResponse. Read-only; mounted by verse-api.ts (unit A10) behind
 * the same read-session boundary as every other GET.
 */
export const handleFleetHistoryApi: ApiModule = async (_ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
  if (path !== FLEET_HISTORY_PATH) return false;
  if (method !== 'GET') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  const parsed = parseFleetHistoryQuery(req.url);
  if (!parsed.ok) {
    sendJson(res, 400, { code: parsed.code, error: parsed.error });
    return true;
  }
  try {
    const body = await getFleetHistoryService().getPayload(parsed.query);
    // Same headers as sendJson(); the body is already sanitized (serializeFleetHistory).
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    sendJson(res, 500, { code: 'FLEET_HISTORY_UNAVAILABLE', error: 'fleet history is temporarily unavailable' });
  }
  return true;
};
