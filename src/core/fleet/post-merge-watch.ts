/**
 * Post-merge watch — V3.10 Track B (owner: unit U4). SPEC-310B §2 "Post-merge watch".
 *
 * For 2 h after each fleet landing it watches CI on the merge SHA and re-runs
 * the repo's own required suite in a FRESH worktree at that SHA. On red:
 *   1. quarantine the repo (6 h) — and owner-hold it if this is its second
 *      quarantine within 7 days;
 *   2. revert — only a commit authored by `ashlr-fleet[bot]` carrying the
 *      landing's `Ashlr-Grant` trailer, through G0 / G3 / G7 and auto-merged
 *      (U3's `landFleetRevert`);
 *   3. file a repair task (U5's task source).
 * Escalation: a revert that conflicts / fails / is refused ⇒ owner-hold + a
 * global soft kill; 2 repos red within 6 h, or 3 reverts within 24 h ⇒ a
 * global soft kill. A revert is itself watched; a red revert is never
 * reverted — it escalates.
 *
 * ── WHY THE QUARANTINE COMES BEFORE THE REVERT ─────────────────────────────
 * SPEC-310B lists revert → quarantine. Here the hold is set first: it lowers
 * authority (always allowed, instant), and a revert that must be retried on a
 * later tick would otherwise leave a red repo open to new fleet merges in
 * between. G0 therefore has to let a `revert` landing through repo holds
 * (U3 cross-unit request) — KILL and a missing capability still stop it.
 *
 * ── ATTRIBUTION: ONLY WHAT THIS LANDING BROKE ──────────────────────────────
 * A red merge SHA is not proof the landing broke it — Mason may have pushed a
 * red commit underneath. So red is attributed against the first parent:
 *   - CI: a check red on the merge SHA and ALSO red on the parent is inherited;
 *   - suite: a failure that repeats (flake guard: one immediate re-run) is
 *     inherited when the parent's suite fails too.
 * Inherited red quarantines the repo (the fleet must not stack work on a red
 * base) but never reverts — a revert cannot turn it green — and never counts
 * toward the fleet-wide kill rules, which are about what the FLEET did.
 * A parent we could not evaluate does not excuse the landing (fail safe:
 * reverting a fleet commit is cheap, reversible, and re-filed as repair).
 *
 * ── HONESTY ────────────────────────────────────────────────────────────────
 * A watch still in progress writes nothing to the ledger (rollout criteria
 * never count a pending watch as green). A watch that reaches its deadline
 * with NO evidence (suite never ran, CI never reported) is finalized RED as
 * "unproven" and quarantines the repo — never green by default. CI still
 * pending at the deadline with a passing suite is green on the suite's
 * evidence, recorded as `ci: 'unknown'`.
 *
 * ── STATE ──────────────────────────────────────────────────────────────────
 * `~/.ashlr/authority/post-merge-watch.json` (0600): open / recent watches and
 * the escalation history. Denied to confined agents with the rest of
 * ~/.ashlr/authority. A corrupt store fails the pass CLOSED (the caller holds
 * production): losing track of a red landing is worse than a paused fleet.
 * Landings are also re-discovered from the authority ledger's `merge:landed`
 * rows each pass, so a missed `afterLanding` hook cannot drop a watch.
 *
 * Every dependency is injectable (PostMergeWatchDeps); production defaults
 * read GitHub (read-only endpoints, App token from custody), run the suite in
 * a detached worktree of the fleet mirror, and call U3 / U5 / U1 through their
 * frozen contracts. Never throws out of a public API.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

import type { AshlrConfig } from '../types.js';
import type { LedgerAppendInput, LedgerEventKind, LedgerReadOptions, LedgerReadResult } from '../authority/types.js';
import { appendLedger, readLedger } from '../authority/ledger.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { revokeArmedMerges, type MergeRevocationOutcome } from '../authority/clamp.js';
import { githubToken } from '../authority/custody-client.js';
import { recordFleetEscalationHalt } from '../daemon/post-merge-halt.js';
import { detectVerifyCommands, runVerifyCommandAsync, type RunVerifyCommandAsyncOptions } from '../run/verify-commands.js';
import { VerificationCapacityError, withRepoLease, withVerificationSlot } from '../sandbox/execution-leases.js';
import { mirrorLeaseKey, mirrorPathFor } from './mirrors.js';
import { runSafeGitSync } from '../sandbox/safe-git.js';
import { audit } from '../sandbox/audit.js';
import { killSwitchOn, setKill } from '../sandbox/policy.js';
import { scrubSecrets } from '../util/scrub.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { enqueueTask } from './task-source.js';
import {
  NAME_WITH_OWNER_RE,
  authorityStateDir,
  ensureAuthorityStateDir,
  setRepoHold,
} from './quarantine.js';
import type {
  EnqueueTaskResult,
  FleetTaskInput,
  LandingRecord,
  PostMergeResult,
  RepoHoldChange,
  SetRepoHoldRequest,
} from './fleet-types.js';

// ---------------------------------------------------------------------------
// Policy constants (SPEC-310B §2). Exported so tests and the UI quote the same numbers.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const POST_MERGE_WATCH_MS = 2 * HOUR_MS;
export const QUARANTINE_MS = 6 * HOUR_MS;
export const SECOND_QUARANTINE_WINDOW_MS = 7 * DAY_MS;
export const RED_REPOS_WINDOW_MS = 6 * HOUR_MS;
export const RED_REPOS_KILL_COUNT = 2;
export const REVERTS_WINDOW_MS = DAY_MS;
export const REVERTS_KILL_COUNT = 3;
/** CI that has registered no check at all this long after landing is `none`, not "not started yet". */
export const CI_NONE_GRACE_MS = 15 * MINUTE_MS;
/** Transient revert failures (GitHub 5xx, network) retried this many times before escalating. */
export const MAX_REVERT_ATTEMPTS = 3;
/**
 * A revert still `pending` (its checks running, the mirror not yet at the
 * base, verification capacity busy) this long after the revert started is a
 * failed revert: owner-hold + soft kill. WHY a deadline and not attempts: a
 * pending answer is not a failure, and counting one per tick would turn three
 * slow CI polls into a fleet-wide stop; but a red repo cannot wait forever
 * either (it is quarantined meanwhile, so nothing else lands on it).
 */
export const REVERT_PENDING_DEADLINE_MS = 60 * MINUTE_MS;
/** How long one pass lets the lander wait for the revert PR's checks before answering `pending` (never blocks the tick). */
export const REVERT_TICK_WAIT_MS = 30_000;
/** Suite attempts that could not RUN (infra) before we stop trying for this watch. */
export const MAX_SUITE_INFRA_ATTEMPTS = 3;
/** A landing whose record claims a longer window is clamped to this. */
const MAX_WATCH_WINDOW_MS = DAY_MS;
const HISTORY_RETENTION_MS = 30 * DAY_MS;
const DONE_WATCH_RETENTION_MS = 7 * DAY_MS;
const MAX_WATCHES = 1_000;
const MAX_HISTORY_ROWS = 5_000;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_DETAIL_CHARS = 400;

/** The GitHub App's bot login. Only commits GitHub attributes to it are ever reverted. */
export const FLEET_BOT_LOGIN = 'ashlr-fleet[bot]';
/** `<app-user-id>+ashlr-fleet[bot]@users.noreply.github.com` — the bot's commit identity. */
const FLEET_BOT_EMAIL_RE = /^\d+\+ashlr-fleet\[bot\]@users\.noreply\.github\.com$/i;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const LANDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/#-]{0,239}$/;

// ---------------------------------------------------------------------------
// Observation shapes
// ---------------------------------------------------------------------------

/**
 * One read of CI on a SHA.
 * - `green`   — every check / status completed and none failed.
 * - `red`     — at least one failed (`failing` names them).
 * - `pending` — something is still running / queued.
 * - `none`    — no check run and no status registered at all.
 * - `unknown` — could not read, or evidence incomplete (a cancelled check).
 */
export interface CiObservation {
  state: 'green' | 'red' | 'pending' | 'none' | 'unknown';
  /** Names of failing checks / status contexts (scrubbed, capped). */
  failing: string[];
  detail: string;
}

/** One suite run at a SHA in a fresh worktree. `not-run` = could not execute (infra), never a verdict. */
export interface SuiteRun {
  result: 'pass' | 'fail' | 'not-run';
  detail: string;
  commandsRun: number;
}

/** What GitHub says about a commit — enough to prove fleet authorship and find the parent. */
export interface CommitInfo {
  sha: string;
  parents: string[];
  /** GitHub login the commit author maps to; null when GitHub could not map it. */
  authorLogin: string | null;
  authorName: string | null;
  authorEmail: string | null;
  message: string;
}

// ---------------------------------------------------------------------------
// Cross-unit seam: the revert lander (U3)
// ---------------------------------------------------------------------------

export interface FleetRevertRequest {
  /** The `merge` landing to revert. */
  landing: LandingRecord;
  /** One sentence for the revert PR body. Scrubbed. */
  reason: string;
  /**
   * `revert:<landing.id>`. The same key MUST map to the same branch / PR, and
   * an already-merged revert for it must be returned rather than re-created —
   * a crash between the merge call and our ledger row re-runs this request.
   */
  idempotencyKey: string;
  actor: 'post-merge-watch';
}

export type FleetRevertFailureCode =
  | 'conflict'
  | 'gate-refused'
  | 'checks-red'
  | 'github'
  | 'killed'
  | 'unavailable'
  | 'not-fleet'
  | 'invalid-response'
  /** In flight, not failed: retried next pass without burning an attempt, bounded by REVERT_PENDING_DEADLINE_MS. */
  | 'pending';

export type FleetRevertOutcome =
  | { ok: true; landing: LandingRecord }
  | { ok: false; code: FleetRevertFailureCode; retryable: boolean; reason: string };

export type FleetRevertLander = (req: FleetRevertRequest) => Promise<FleetRevertOutcome>;

/** U3's `landFleetRevert` signature (host-merge.ts), with the per-call wait bound. */
type HostMergeRevertLander = (req: FleetRevertRequest, opts?: { maxWaitMs?: number }) => Promise<FleetRevertOutcome>;

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export type WatchPhase = 'watching' | 'reverting' | 'done';

/**
 * - `green`          — verified green.
 * - `reverted`       — red, attributed to this landing, reverted.
 * - `revert-failed`  — red, revert conflicted / was refused / exhausted retries ⇒ owner-hold + soft kill.
 * - `revert-refused` — red, but the commit is not provably the fleet's ⇒ never reverted; owner-hold + soft kill.
 * - `inherited-red`  — red, but the base was already red ⇒ quarantine only.
 * - `unproven`       — deadline passed with no evidence ⇒ recorded red, quarantine only.
 * - `revert-red`     — a revert landing went red ⇒ owner-hold + soft kill (a revert is never reverted).
 */
export type WatchOutcome =
  | 'green'
  | 'reverted'
  | 'revert-failed'
  | 'revert-refused'
  | 'inherited-red'
  | 'unproven'
  | 'revert-red';

export interface SuiteState {
  state: 'pending' | 'pass' | 'fail' | 'not-run';
  /** Suite executions so far (incl. the flake re-run). */
  runs: number;
  /** Attempts that could not execute. */
  infraAttempts: number;
  /** The parent's suite, run only to attribute a failure. */
  parent: 'pass' | 'fail' | 'not-run' | null;
  /** A single failure awaiting its confirming re-run (budget ran out mid-pass). */
  unconfirmedFail: boolean;
  detail: string | null;
}

export interface PostMergeWatch {
  v: 1;
  landing: LandingRecord;
  phase: WatchPhase;
  registeredAt: string;
  /** Effective deadline (landing.watchUntil, clamped). */
  watchUntil: string;
  lastCheckedAt: string | null;
  ci: CiObservation | null;
  suite: SuiteState;
  result: PostMergeResult | null;
  outcome: WatchOutcome | null;
  revert: RevertState | null;
  repairTaskId: string | null;
  repairError: string | null;
  /** Ledger rows not yet appended (retried each pass, oldest first). */
  pendingLedger: PendingLedgerRow[];
}

export interface RevertState {
  attempts: number;
  lastError: string | null;
  revertLandingId: string | null;
  /** fleetRevertRefusal() passed on GitHub's own view of the commit. Nothing is reverted before this is true. */
  authorshipProven: boolean;
  /**
   * When this revert started (ISO). Bounds `pending` answers. Optional: a
   * state stored before 3.10's pending code starts its clock at the first
   * pending answer.
   */
  startedAt?: string | null;
}

type PendingLedgerRow = { kind: 'post-merge:result' | 'revert:landed' | 'revert:failed' | 'kill:on'; data: unknown };

interface HistoryRow {
  repo: string;
  at: string;
  landingId: string | null;
}

export interface EscalationHistory {
  /** Every quarantine the watch set (culprit, inherited, unproven). */
  quarantines: HistoryRow[];
  /** Fleet-attributed reds only (the "2 repos red within 6 h" rule). */
  reds: HistoryRow[];
  /** Reverts that landed (the "3 reverts within 24 h" rule). */
  reverts: HistoryRow[];
  kills: { at: string; reason: string }[];
}

interface WatchStoreV1 {
  v: 1;
  watches: PostMergeWatch[];
  history: EscalationHistory;
  /** Last authority-ledger seq scanned for `merge:landed`; null = never scanned. */
  ledgerCursor: number | null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PostMergeWatchDeps {
  now: () => number;
  ciStatus: (repo: string, sha: string) => Promise<CiObservation>;
  readCommit: (repo: string, sha: string) => Promise<CommitInfo | null>;
  runSuiteAt: (repo: string, sha: string, opts: { signal?: AbortSignal }) => Promise<SuiteRun>;
  landRevert: FleetRevertLander;
  enqueueRepairTask: (input: FleetTaskInput) => EnqueueTaskResult;
  setHold: (req: SetRepoHoldRequest, opts: { nowMs: number }) => RepoHoldChange;
  /** Arm the global soft kill (~/.ashlr/KILL). `changed` = it was not already on. */
  softKill: (reason: string) => { ok: boolean; changed: boolean; reason: string };
  /**
   * Revoke every ARMED host merge (all repos) right after a soft kill — the
   * same companion Stop runs (authority/clamp.ts revokeArmedMerges). Never
   * throws. Optional so older fixtures that build a full deps object still
   * type-check; advancePostMergeWatches always fills it from the defaults.
   */
  revokeArmedMerges?: (reason: string) => Promise<MergeRevocationOutcome>;
  killActive: () => boolean;
  appendLedger: <K extends LedgerEventKind>(input: LedgerAppendInput<K>) => { ok: boolean; reason?: string };
  /** Optional: discover landings the afterLanding hook missed. */
  readLedger?: (opts: LedgerReadOptions) => Promise<LedgerReadResult>;
  /** Durable halt record for the morning report (daemon/post-merge-halt.ts). */
  recordHalt: (input: { reason: string; repos: string[]; landingIds: string[]; nowMs: number }) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function clean(text: unknown, max = MAX_DETAIL_CHARS): string {
  const s = scrubSecrets(typeof text === 'string' ? text : String(text)).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function currentGrantId(): string | null {
  try {
    return currentStandingPolicy()?.grantId ?? null;
  } catch {
    return null;
  }
}

/**
 * Minimal structural check of a LandingRecord arriving from another unit or
 * the ledger. Returns why it is unusable, or null.
 */
export function landingRefusal(record: unknown): string | null {
  if (!record || typeof record !== 'object') return 'the landing record is not an object';
  const l = record as Partial<LandingRecord>;
  if (l.v !== 1) return 'the landing record has an unknown version';
  if (typeof l.id !== 'string' || !LANDING_ID_RE.test(l.id)) return 'the landing id is malformed';
  if (l.kind !== 'merge' && l.kind !== 'revert') return 'the landing kind is neither merge nor revert';
  if (typeof l.repo !== 'string' || !NAME_WITH_OWNER_RE.test(l.repo)) return 'the landing repo is not owner/name';
  if (typeof l.mergeSha !== 'string' || !GIT_SHA_RE.test(l.mergeSha)) return 'the landing merge SHA is malformed';
  if (typeof l.headSha !== 'string' || !GIT_SHA_RE.test(l.headSha)) return 'the landing head SHA is malformed';
  if (typeof l.grantId !== 'string' || l.grantId.length === 0) return 'the landing carries no grant id';
  if (!Number.isSafeInteger(l.prNumber) || (l.prNumber ?? 0) <= 0) return 'the landing PR number is malformed';
  if (!isIso(l.landedAt)) return 'the landing time is not ISO';
  if (l.kind === 'revert' && (typeof l.revertsLandingId !== 'string' || l.revertsLandingId.length === 0)) {
    return 'a revert landing must name the landing it reverts';
  }
  return null;
}

/** landing.watchUntil when sane, else landedAt + 2 h; never beyond landedAt + 24 h. */
export function effectiveWatchUntil(landing: LandingRecord): string {
  const landed = Date.parse(landing.landedAt);
  const fallback = landed + POST_MERGE_WATCH_MS;
  const claimed = isIso(landing.watchUntil) ? Date.parse(landing.watchUntil) : Number.NaN;
  const until = Number.isFinite(claimed) && claimed > landed ? Math.min(claimed, landed + MAX_WATCH_WINDOW_MS) : fallback;
  return iso(until);
}

/**
 * Why `commit` must NOT be reverted as `landing`, or null when it may.
 * SPEC-310B §2: "Only commits authored by ashlr-fleet[bot] that carry
 * Ashlr-Grant are ever reverted." Also: exactly the SHA our ledger recorded,
 * a single-parent (squash) commit, and a merge — never a revert of a revert.
 */
export function fleetRevertRefusal(commit: CommitInfo, landing: LandingRecord): string | null {
  if (landing.kind !== 'merge') return 'a revert landing is never itself reverted';
  if (commit.sha.toLowerCase() !== landing.mergeSha.toLowerCase()) {
    return `GitHub returned ${short(commit.sha)} for ${short(landing.mergeSha)}`;
  }
  const byLogin = commit.authorLogin === FLEET_BOT_LOGIN;
  const byEmail = commit.authorLogin === null && typeof commit.authorEmail === 'string' &&
    FLEET_BOT_EMAIL_RE.test(commit.authorEmail);
  if (!byLogin && !byEmail) {
    return `${short(commit.sha)} was not authored by ${FLEET_BOT_LOGIN}` +
      (commit.authorLogin ? ` (author: ${clean(commit.authorLogin, 60)})` : '');
  }
  const trailers = [...commit.message.matchAll(/^Ashlr-Grant:[ \t]*(\S+)[ \t]*$/gm)].map((m) => m[1]);
  if (trailers.length === 0) return `${short(commit.sha)} carries no Ashlr-Grant trailer`;
  if (trailers.length > 1 || trailers[0] !== landing.grantId) {
    return `${short(commit.sha)}'s Ashlr-Grant trailer does not match grant ${clean(landing.grantId, 64)}`;
  }
  if (commit.parents.length !== 1) {
    return `${short(commit.sha)} has ${commit.parents.length} parents; fleet landings are single-parent squash merges`;
  }
  return null;
}

const RED_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
const OK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * Pure CI classification over GitHub's check runs and combined-status
 * contexts. A `stale` run is ignored; a `cancelled` one makes the evidence
 * incomplete (CI concurrency groups cancel superseded runs — that is not red,
 * and it is not proof of green either).
 */
export function classifyCi(
  checkRuns: readonly { name: string; status: string; conclusion: string | null }[],
  statuses: readonly { context: string; state: string }[],
): CiObservation {
  const failing: string[] = [];
  let pending = 0;
  let ok = 0;
  let cancelled = 0;
  for (const run of checkRuns) {
    if (run.status !== 'completed') { pending++; continue; }
    const c = run.conclusion ?? '';
    if (RED_CONCLUSIONS.has(c)) failing.push(clean(run.name, 80));
    else if (OK_CONCLUSIONS.has(c)) ok++;
    else if (c === 'cancelled') cancelled++;
    // `stale` and unknown conclusions carry no verdict.
  }
  for (const status of statuses) {
    if (status.state === 'failure' || status.state === 'error') failing.push(clean(status.context, 80));
    else if (status.state === 'pending') pending++;
    else if (status.state === 'success') ok++;
  }
  const failingSorted = [...new Set(failing)].sort();
  if (failingSorted.length > 0) {
    return { state: 'red', failing: failingSorted, detail: `CI failing: ${failingSorted.slice(0, 5).join(', ')}` };
  }
  if (pending > 0) return { state: 'pending', failing: [], detail: `${pending} check(s) still running` };
  if (cancelled > 0) return { state: 'unknown', failing: [], detail: `${cancelled} check(s) cancelled; CI evidence incomplete` };
  if (ok > 0) return { state: 'green', failing: [], detail: `${ok} check(s) green` };
  return { state: 'none', failing: [], detail: 'no checks or statuses registered' };
}

function withinWindow(rows: readonly HistoryRow[], nowMs: number, windowMs: number): HistoryRow[] {
  return rows.filter((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && at <= nowMs && nowMs - at < windowMs;
  });
}

/** Distinct repos with a fleet-attributed red within the window (the 2-repos kill rule). */
export function redReposWithin(history: EscalationHistory, nowMs: number): string[] {
  return [...new Set(withinWindow(history.reds, nowMs, RED_REPOS_WINDOW_MS).map((r) => r.repo.toLowerCase()))].sort();
}

/** Reverts landed within the window (the 3-reverts kill rule). */
export function revertsWithin(history: EscalationHistory, nowMs: number): number {
  return withinWindow(history.reverts, nowMs, REVERTS_WINDOW_MS).length;
}

/** A PRIOR quarantine of `repo` within 7 days (excluding one for `landingId`) ⇒ this one escalates to owner-hold. */
export function priorQuarantineWithin(
  history: EscalationHistory,
  repo: string,
  nowMs: number,
  landingId: string | null,
): HistoryRow | null {
  return withinWindow(history.quarantines, nowMs, SECOND_QUARANTINE_WINDOW_MS)
    .find((r) => r.repo.toLowerCase() === repo.toLowerCase() && (landingId === null || r.landingId !== landingId)) ?? null;
}

function emptyHistory(): EscalationHistory {
  return { quarantines: [], reds: [], reverts: [], kills: [] };
}

function pruneHistory(history: EscalationHistory, nowMs: number): EscalationHistory {
  const keep = <T extends { at: string }>(rows: T[]): T[] => rows
    .filter((r) => { const at = Date.parse(r.at); return Number.isFinite(at) && nowMs - at < HISTORY_RETENTION_MS; })
    .slice(-MAX_HISTORY_ROWS);
  return {
    quarantines: keep(history.quarantines),
    reds: keep(history.reds),
    reverts: keep(history.reverts),
    kills: keep(history.kills),
  };
}

function pushOnce(rows: HistoryRow[], row: HistoryRow): void {
  if (row.landingId !== null && rows.some((r) => r.landingId === row.landingId && r.repo === row.repo)) return;
  rows.push(row);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function postMergeWatchPath(): string {
  return join(authorityStateDir(), 'post-merge-watch.json');
}

function storeLockPath(): string {
  return join(authorityStateDir(), '.post-merge-watch.lock');
}

function passLockPath(): string {
  return join(authorityStateDir(), '.post-merge-watch.pass.lock');
}

type StoreRead = { ok: true; store: WatchStoreV1 } | { ok: false; reason: string };

function isHistoryRow(v: unknown): v is HistoryRow {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['repo'] === 'string' && isIso(r['at']) && (r['landingId'] === null || typeof r['landingId'] === 'string');
}

function isWatch(v: unknown): v is PostMergeWatch {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return w['v'] === 1 && landingRefusal(w['landing']) === null &&
    (w['phase'] === 'watching' || w['phase'] === 'reverting' || w['phase'] === 'done') &&
    isIso(w['registeredAt']) && isIso(w['watchUntil']) &&
    !!w['suite'] && typeof w['suite'] === 'object' && Array.isArray(w['pendingLedger']);
}

function parseStore(text: string): StoreRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the post-merge watch store is not valid JSON' };
  }
  const s = parsed as Partial<WatchStoreV1> | null;
  if (!s || typeof s !== 'object' || s.v !== 1) return { ok: false, reason: 'the post-merge watch store has an unknown version' };
  if (!Array.isArray(s.watches) || s.watches.length > MAX_WATCHES || !s.watches.every(isWatch)) {
    return { ok: false, reason: 'the post-merge watch store holds a malformed watch' };
  }
  const h = s.history as Partial<EscalationHistory> | undefined;
  if (!h || !Array.isArray(h.quarantines) || !Array.isArray(h.reds) || !Array.isArray(h.reverts) || !Array.isArray(h.kills) ||
    ![...h.quarantines, ...h.reds, ...h.reverts].every(isHistoryRow)) {
    return { ok: false, reason: 'the post-merge watch store has a malformed escalation history' };
  }
  if (s.ledgerCursor !== null && !Number.isSafeInteger(s.ledgerCursor)) {
    return { ok: false, reason: 'the post-merge watch store has a malformed ledger cursor' };
  }
  return { ok: true, store: s as WatchStoreV1 };
}

function readStoreUnlocked(): StoreRead {
  const path = postMergeWatchPath();
  if (!existsSync(path)) {
    return { ok: true, store: { v: 1, watches: [], history: emptyHistory(), ledgerCursor: null } };
  }
  const read = readStableRegularFile(path, { anchorPath: homedir(), maxFileBytes: MAX_STORE_BYTES, remainingBytes: MAX_STORE_BYTES });
  if (!read.ok) return { ok: false, reason: `the post-merge watch store is unreadable (${read.reason})` };
  return parseStore(read.text);
}

function writeStoreUnlocked(store: WatchStoreV1): void {
  const encoded = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) throw new Error('the post-merge watch store would exceed its size bound');
  const target = postMergeWatchPath();
  writePrivateFileAtomically(`${target}.${process.pid}.${randomUUID()}.tmp`, target, encoded, {
    anchorPath: homedir(),
    label: 'post-merge watch store',
  });
}

/** Read-modify-write under the store lock. `fn` must be synchronous and cheap. */
function mutateStore<T>(fn: (store: WatchStoreV1) => T): { ok: true; value: T } | { ok: false; reason: string } {
  const dir = ensureAuthorityStateDir();
  if (!dir.ok) return dir;
  const lock = acquireLocalStoreLock(storeLockPath(), 2_000, { anchorPath: homedir() });
  if (!lock) return { ok: false, reason: 'the post-merge watch store lock is unavailable' };
  try {
    const read = readStoreUnlocked();
    if (!read.ok) return read;
    const before = JSON.stringify(read.store);
    const value = fn(read.store);
    // No-op passes write nothing (and create nothing) — an idle fleet leaves no trace.
    if (JSON.stringify(read.store) !== before) writeStoreUnlocked(read.store);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, reason: `the post-merge watch store could not be written (${errText(error)})` };
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function newWatch(landing: LandingRecord, nowMs: number): PostMergeWatch {
  return {
    v: 1,
    landing: { ...landing },
    phase: 'watching',
    registeredAt: iso(nowMs),
    watchUntil: effectiveWatchUntil(landing),
    lastCheckedAt: null,
    ci: null,
    suite: { state: 'pending', runs: 0, infraAttempts: 0, parent: null, unconfirmedFail: false, detail: null },
    result: null,
    outcome: null,
    revert: null,
    repairTaskId: null,
    repairError: null,
    pendingLedger: [],
  };
}

// ---------------------------------------------------------------------------
// Public: registration and read views
// ---------------------------------------------------------------------------

export type RegisterLandingResult = { ok: true; registered: boolean } | { ok: false; reason: string };

/**
 * Start watching a landing (U5's `afterLanding` hook calls this for every
 * merge and revert the fleet lands). Idempotent on `landing.id`. Never throws.
 */
export function registerLanding(landing: LandingRecord, opts: { nowMs?: number } = {}): RegisterLandingResult {
  const refusal = landingRefusal(landing);
  if (refusal) return { ok: false, reason: refusal };
  const nowMs = opts.nowMs ?? Date.now();
  const r = mutateStore((store) => registerInto(store, landing, nowMs));
  return r.ok ? { ok: true, registered: r.value } : { ok: false, reason: r.reason };
}

function registerInto(store: WatchStoreV1, landing: LandingRecord, nowMs: number): boolean {
  if (store.watches.some((w) => w.landing.id === landing.id)) return false;
  if (store.watches.length >= MAX_WATCHES) {
    // Make room by dropping the oldest FINISHED watches only; an open watch is never evicted.
    const doneIdx = store.watches.findIndex((w) => w.phase === 'done');
    if (doneIdx < 0) throw new Error('too many open post-merge watches');
    store.watches.splice(doneIdx, 1);
  }
  store.watches.push(newWatch(landing, nowMs));
  return true;
}

export interface PostMergeWatchView {
  landingId: string;
  repo: string;
  prNumber: number;
  kind: LandingRecord['kind'];
  mergeSha: string;
  phase: WatchPhase;
  landedAt: string;
  watchUntil: string;
  ci: CiObservation['state'] | null;
  suite: SuiteState['state'];
  outcome: WatchOutcome | null;
  verdict: PostMergeResult['verdict'] | null;
  detail: string | null;
  checkedAt: string | null;
}

/**
 * Open watches (for the Fleet swimlane's `watching` / `reverting` phases)
 * and finished ones from the last 7 days. Throws when the store is corrupt —
 * the Fleet API renders that as unknown, never as "nothing watched".
 */
export function listPostMergeWatches(): PostMergeWatchView[] {
  const read = readStoreUnlocked();
  if (!read.ok) throw new Error(`post-merge watches unknown: ${read.reason}`);
  return read.store.watches.map((w) => ({
    landingId: w.landing.id,
    repo: w.landing.repo,
    prNumber: w.landing.prNumber,
    kind: w.landing.kind,
    mergeSha: w.landing.mergeSha,
    phase: w.phase,
    landedAt: w.landing.landedAt,
    watchUntil: w.watchUntil,
    ci: w.ci?.state ?? null,
    suite: w.suite.state,
    outcome: w.outcome,
    verdict: w.result?.verdict ?? null,
    detail: w.result?.detail ?? w.suite.detail ?? w.ci?.detail ?? null,
    checkedAt: w.result?.checkedAt ?? w.lastCheckedAt,
  }));
}

/**
 * Post-merge green % over finished watches of `merge` landings in the window
 * (optionally one repo). null = no finished watch — never 0 or 100 by default.
 */
export function postMergeGreenPct(opts: { repo?: string; sinceMs: number; nowMs?: number }): { finished: number; green: number; pct: number | null } {
  const views = listPostMergeWatches();
  const nowMs = opts.nowMs ?? Date.now();
  const finished = views.filter((v) => v.kind === 'merge' && v.verdict !== null && v.checkedAt !== null &&
    Date.parse(v.checkedAt) >= opts.sinceMs && Date.parse(v.checkedAt) <= nowMs &&
    (opts.repo === undefined || v.repo.toLowerCase() === opts.repo.toLowerCase()));
  const green = finished.filter((v) => v.verdict === 'green').length;
  return { finished: finished.length, green, pct: finished.length === 0 ? null : Math.round((green / finished.length) * 1000) / 10 };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface PostMergeWatchPassOptions {
  deps?: Partial<PostMergeWatchDeps>;
  /** Suite executions this pass may spend (a red confirmation costs up to 3). Default 3. */
  maxSuiteRuns?: number;
  signal?: AbortSignal;
}

export interface PostMergeWatchPassResult {
  /** false ⇒ the watch could not run; the caller must hold production (fail closed). */
  ok: boolean;
  reason: string | null;
  /** Watches still open after the pass. */
  open: number;
  finalized: PostMergeResult[];
  /** Landing ids reverted this pass. */
  reverted: string[];
  /** Plain sentences: holds set, kills armed, failures. */
  escalations: string[];
  softKilled: boolean;
  suiteRuns: number;
  discovered: number;
}

let passInFlight = false;

/**
 * Advance every open watch by at most one step each (bounded by
 * `maxSuiteRuns`). Call once per daemon tick where verification may run
 * (U5: beforeTick). May take as long as a suite run. Never throws.
 */
export async function advancePostMergeWatches(opts: PostMergeWatchPassOptions = {}): Promise<PostMergeWatchPassResult> {
  const deps = { ...defaultPostMergeWatchDeps(), ...(opts.deps ?? {}) } as PostMergeWatchDeps;
  const result: PostMergeWatchPassResult = {
    ok: true, reason: null, open: 0, finalized: [], reverted: [], escalations: [], softKilled: false, suiteRuns: 0, discovered: 0,
  };
  if (passInFlight) return { ...result, reason: 'another post-merge watch pass is already running in this process' };
  passInFlight = true;
  let passLock: ReturnType<typeof acquireLocalStoreLock> = null;
  try {
    const initial = readStoreUnlocked();
    if (!initial.ok) return { ...result, ok: false, reason: initial.reason };

    // 1. Discover landings the afterLanding hook may have missed.
    result.discovered = await discoverFromLedger(deps, initial.store.ledgerCursor);
    // Nothing was ever landed ⇒ nothing to watch, and nothing is written.
    if (!existsSync(postMergeWatchPath())) return result;

    const dir = ensureAuthorityStateDir();
    if (!dir.ok) return { ...result, ok: false, reason: dir.reason };
    passLock = acquireLocalStoreLock(passLockPath(), 0, { anchorPath: homedir() });
    if (!passLock) {
      // Another process is mid-pass; its watches are covered. Not a failure.
      return { ...result, reason: 'another post-merge watch pass holds the pass lock' };
    }

    // 2. Flush ledger rows a previous pass could not write.
    flushPendingLedger(deps);

    // 3. Step each open watch — reverts first (they are the urgent ones), then oldest landing first.
    const snapshot = readStoreUnlocked();
    if (!snapshot.ok) return { ...result, ok: false, reason: snapshot.reason };
    const open = snapshot.store.watches
      .filter((w) => w.phase !== 'done')
      .sort((a, b) => (a.phase === b.phase ? 0 : a.phase === 'reverting' ? -1 : 1) ||
        Date.parse(a.landing.landedAt) - Date.parse(b.landing.landedAt));
    const budget = { suiteRuns: Math.max(0, Math.floor(opts.maxSuiteRuns ?? 3)) };
    for (const watch of open) {
      if (opts.signal?.aborted) break;
      try {
        await stepWatch(watch.landing.id, deps, budget, result, opts.signal);
      } catch (error) {
        // A step that threw has proven nothing; the watch stays open and is retried next pass.
        result.escalations.push(`post-merge watch of ${watch.landing.id} failed this pass: ${clean(errText(error))}`);
      }
    }

    // 4. Housekeeping.
    const nowMs = deps.now();
    const final = mutateStore((store) => {
      store.history = pruneHistory(store.history, nowMs);
      store.watches = store.watches.filter((w) => w.phase !== 'done' || w.pendingLedger.length > 0 ||
        nowMs - Date.parse(w.result?.checkedAt ?? w.registeredAt) < DONE_WATCH_RETENTION_MS);
      return store.watches.filter((w) => w.phase !== 'done').length;
    });
    if (!final.ok) return { ...result, ok: false, reason: final.reason };
    result.open = final.value;
    return result;
  } catch (error) {
    return { ...result, ok: false, reason: `post-merge watch pass failed: ${clean(errText(error))}` };
  } finally {
    if (passLock) releaseLocalStoreLock(passLock);
    passInFlight = false;
  }
}

async function discoverFromLedger(deps: PostMergeWatchDeps, cursor: number | null): Promise<number> {
  if (!deps.readLedger) return 0;
  let read: LedgerReadResult;
  try {
    read = await deps.readLedger({ kinds: ['merge:landed', 'revert:landed'], ...(cursor !== null ? { sinceSeq: cursor + 1 } : {}) });
  } catch {
    // No ledger (yet) ⇒ nothing to discover; the afterLanding hook remains the primary path.
    return 0;
  }
  if (read.chain === 'broken') return 0; // B-U1 halts everything on a broken chain.
  let maxSeq = cursor;
  const landings: LandingRecord[] = [];
  for (const entry of read.entries) {
    if (cursor !== null && entry.seq <= cursor) continue;
    maxSeq = maxSeq === null ? entry.seq : Math.max(maxSeq, entry.seq);
    if ((entry.kind === 'merge:landed' || entry.kind === 'revert:landed') && landingRefusal(entry.data) === null) {
      landings.push(entry.data);
    }
  }
  if (landings.length === 0 && maxSeq === cursor) return 0;
  const nowMs = deps.now();
  const r = mutateStore((store) => {
    let added = 0;
    for (const landing of landings) if (registerInto(store, landing, nowMs)) added++;
    if (maxSeq !== null) store.ledgerCursor = maxSeq;
    return added;
  });
  return r.ok ? r.value : 0;
}

function tryLedger(deps: PostMergeWatchDeps, row: PendingLedgerRow, repo: string | null): boolean {
  try {
    const r = deps.appendLedger({
      kind: row.kind,
      data: row.data as never,
      actor: 'post-merge-watch',
      grantId: currentGrantId(),
      repo,
    });
    return r.ok;
  } catch {
    return false;
  }
}

function flushPendingLedger(deps: PostMergeWatchDeps): void {
  mutateStore((store) => {
    for (const w of store.watches) {
      while (w.pendingLedger.length > 0) {
        if (!tryLedger(deps, w.pendingLedger[0]!, w.landing.repo)) break;
        w.pendingLedger.shift();
      }
    }
  });
}

/** Queue a ledger row on the watch and try to append it now (order preserved). */
function ledgerOrQueue(deps: PostMergeWatchDeps, w: PostMergeWatch, row: PendingLedgerRow): void {
  if (w.pendingLedger.length === 0 && tryLedger(deps, row, w.landing.repo)) return;
  w.pendingLedger.push(row);
}

/** Persist the mutated watch (by landing id) into the current store. */
function saveWatch(w: PostMergeWatch, mutateHistory?: (h: EscalationHistory) => void): void {
  const r = mutateStore((store) => {
    const idx = store.watches.findIndex((x) => x.landing.id === w.landing.id);
    if (idx >= 0) store.watches[idx] = w;
    else store.watches.push(w);
    if (mutateHistory) mutateHistory(store.history);
  });
  if (!r.ok) throw new Error(r.reason);
}

function readWatch(landingId: string): { watch: PostMergeWatch; history: EscalationHistory } | null {
  const read = readStoreUnlocked();
  if (!read.ok) throw new Error(read.reason);
  const watch = read.store.watches.find((w) => w.landing.id === landingId);
  return watch ? { watch: structuredClone(watch), history: structuredClone(read.store.history) } : null;
}

async function stepWatch(
  landingId: string,
  deps: PostMergeWatchDeps,
  budget: { suiteRuns: number },
  pass: PostMergeWatchPassResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const current = readWatch(landingId);
  if (!current || current.watch.phase === 'done') return;
  const w = current.watch;
  if (w.phase === 'reverting') {
    await attemptRevert(w, deps, pass);
    return;
  }

  const nowMs = deps.now();
  const landing = w.landing;
  const deadlineMs = Date.parse(w.watchUntil);
  const killed = safeKillActive(deps);

  // ── observe CI ─────────────────────────────────────────────────────────
  w.ci = await safeCi(deps, landing.repo, landing.mergeSha);
  w.lastCheckedAt = iso(nowMs);

  // ── run the suite (bounded; never while Stop is on) ──────────────────
  const suiteWanted = (w.suite.state === 'pending' && w.suite.infraAttempts < MAX_SUITE_INFRA_ATTEMPTS) ||
    (w.suite.state === 'not-run' && w.suite.infraAttempts < MAX_SUITE_INFRA_ATTEMPTS);
  if (suiteWanted && !killed && budget.suiteRuns > 0 && !signal?.aborted) {
    budget.suiteRuns--;
    pass.suiteRuns++;
    let run = await safeSuite(deps, landing.repo, landing.mergeSha, signal);
    w.suite.runs++;
    if (run.result === 'fail' && !w.suite.unconfirmedFail) {
      // Flake guard: a red suite must be red twice before it reverts anything.
      if (budget.suiteRuns <= 0) {
        w.suite.unconfirmedFail = true;
        w.suite.detail = `failed once, awaiting a confirming re-run: ${run.detail}`;
        saveWatch(w);
        return;
      }
      budget.suiteRuns--;
      pass.suiteRuns++;
      const again = await safeSuite(deps, landing.repo, landing.mergeSha, signal);
      w.suite.runs++;
      if (again.result === 'pass') {
        run = { ...again, detail: `failed once, then passed on re-run (treated as a flake): ${run.detail}` };
      } else if (again.result === 'not-run') {
        // The confirmation could not run: neither red nor green yet.
        w.suite.unconfirmedFail = true;
        w.suite.detail = `failed once; the confirming re-run could not run (${again.detail})`;
        saveWatch(w);
        return;
      }
    } else if (run.result === 'pass' && w.suite.unconfirmedFail) {
      run = { ...run, detail: `failed once, then passed on re-run (treated as a flake): ${run.detail}` };
    } else if (run.result === 'not-run' && w.suite.unconfirmedFail) {
      w.suite.infraAttempts++;
      w.suite.detail = `failed once; the confirming re-run could not run (${run.detail})`;
      saveWatch(w);
      return;
    }
    w.suite.unconfirmedFail = false;
    w.suite.state = run.result;
    w.suite.detail = run.detail;
    if (run.result === 'not-run') w.suite.infraAttempts++;
  }

  const ci = w.ci;
  const ciRed = ci.state === 'red';
  const suiteRed = w.suite.state === 'fail';

  if (ciRed || suiteRed) {
    await onRed(w, current.history, deps, budget, pass, signal);
    return;
  }

  const graceOver = nowMs - Date.parse(landing.landedAt) >= CI_NONE_GRACE_MS;
  const ciSettled = ci.state === 'green' || (ci.state === 'none' && graceOver);
  const suiteGaveUp = w.suite.state === 'not-run' && w.suite.infraAttempts >= MAX_SUITE_INFRA_ATTEMPTS;
  const pastDeadline = nowMs >= deadlineMs;

  if (w.suite.state === 'pass' && ciSettled) {
    finalizeGreen(w, deps, nowMs, ci.state === 'none' ? 'none' : 'green', `suite: ${w.suite.detail ?? 'passed'}; CI: ${ci.detail}`, pass);
    return;
  }
  if (ci.state === 'green' && suiteGaveUp) {
    finalizeGreen(w, deps, nowMs, 'green', `CI green; the local suite could not run (${w.suite.detail ?? 'infra'})`, pass);
    return;
  }
  if (pastDeadline) {
    if (w.suite.state === 'pass') {
      finalizeGreen(w, deps, nowMs, ci.state === 'none' ? 'none' : 'unknown',
        `suite: ${w.suite.detail ?? 'passed'}; CI never settled within the watch (${ci.detail})`, pass);
      return;
    }
    if (ci.state === 'green') {
      finalizeGreen(w, deps, nowMs, 'green', `CI green; the local suite never ran (${w.suite.detail ?? 'no suite run'})`, pass);
      return;
    }
    await finalizeUnproven(w, current.history, deps, nowMs, pass);
    return;
  }
  saveWatch(w);
}

function finalizeGreen(
  w: PostMergeWatch,
  deps: PostMergeWatchDeps,
  nowMs: number,
  ci: PostMergeResult['ci'],
  detail: string,
  pass: PostMergeWatchPassResult,
): void {
  const result = buildResult(w, nowMs, ci, 'green', detail);
  w.result = result;
  w.outcome = 'green';
  w.phase = 'done';
  ledgerOrQueue(deps, w, { kind: 'post-merge:result', data: result });
  saveWatch(w);
  pass.finalized.push(result);
}

function buildResult(
  w: PostMergeWatch,
  nowMs: number,
  ci: PostMergeResult['ci'],
  verdict: PostMergeResult['verdict'],
  detail: string,
): PostMergeResult {
  return {
    v: 1,
    landingId: w.landing.id,
    repo: w.landing.repo,
    mergeSha: w.landing.mergeSha,
    ci,
    suite: w.suite.state === 'pass' ? 'pass' : w.suite.state === 'fail' ? 'fail' : 'not-run',
    verdict,
    detail: clean(detail),
    checkedAt: iso(nowMs),
  };
}

function ciForResult(ci: CiObservation | null): PostMergeResult['ci'] {
  if (!ci) return 'unknown';
  if (ci.state === 'green' || ci.state === 'red' || ci.state === 'none') return ci.state;
  return 'unknown';
}

async function finalizeUnproven(
  w: PostMergeWatch,
  history: EscalationHistory,
  deps: PostMergeWatchDeps,
  nowMs: number,
  pass: PostMergeWatchPassResult,
): Promise<void> {
  const detail = `unproven: no evidence within the watch — suite ${w.suite.state}` +
    `${w.suite.detail ? ` (${w.suite.detail})` : ''}, CI ${w.ci?.state ?? 'unread'}`;
  const result = buildResult(w, nowMs, ciForResult(w.ci), 'red', detail);
  w.result = result;
  w.outcome = 'unproven';
  w.phase = 'done';
  ledgerOrQueue(deps, w, { kind: 'post-merge:result', data: result });
  quarantine(w, history, deps, nowMs, `post-merge of ${short(w.landing.mergeSha)} could not be verified within the watch`, pass);
  saveWatch(w, (h) => pushOnce(h.quarantines, { repo: w.landing.repo, at: iso(nowMs), landingId: w.landing.id }));
  pass.finalized.push(result);
}

/**
 * Set the 6 h quarantine; owner-hold too when a prior quarantine of the repo
 * falls within 7 days. Lowering authority: a failed hold write is reported
 * loudly but does not stop the rest of the escalation.
 */
function quarantine(
  w: PostMergeWatch,
  history: EscalationHistory,
  deps: PostMergeWatchDeps,
  nowMs: number,
  reason: string,
  pass: PostMergeWatchPassResult,
): void {
  const repo = w.landing.repo;
  const q = deps.setHold({
    repo,
    kind: 'quarantine',
    actor: 'post-merge-watch',
    hold: { reason, until: iso(nowMs + QUARANTINE_MS), landingId: w.landing.id },
  }, { nowMs });
  pass.escalations.push(q.ok
    ? `${repo} quarantined for 6 h: ${reason}`
    : `FAILED to quarantine ${repo} (${q.reason ?? 'unknown'}): ${reason}`);
  const prior = priorQuarantineWithin(history, repo, nowMs, w.landing.id);
  if (prior) {
    ownerHold(w, deps, nowMs, `second quarantine within 7 days (previous ${prior.at}); ${reason}`, pass);
  }
}

function ownerHold(w: PostMergeWatch, deps: PostMergeWatchDeps, nowMs: number, reason: string, pass: PostMergeWatchPassResult): void {
  const repo = w.landing.repo;
  const r = deps.setHold({
    repo,
    kind: 'owner-hold',
    actor: 'post-merge-watch',
    hold: { reason, until: null, landingId: w.landing.id },
  }, { nowMs });
  pass.escalations.push(r.ok
    ? `${repo} on owner-hold until Mason resumes it: ${reason}`
    : `FAILED to owner-hold ${repo} (${r.reason ?? 'unknown'}): ${reason}`);
}

async function softKill(
  w: PostMergeWatch | null,
  deps: PostMergeWatchDeps,
  nowMs: number,
  reason: string,
  repos: string[],
  pass: PostMergeWatchPassResult,
): Promise<{ at: string; reason: string }> {
  let armed: { ok: boolean; changed: boolean; reason: string };
  try {
    armed = deps.softKill(reason);
  } catch (error) {
    armed = { ok: false, changed: false, reason: errText(error) };
  }
  pass.softKilled = pass.softKilled || armed.ok;
  pass.escalations.push(armed.ok
    ? `global soft kill armed: ${reason}`
    : `FAILED to arm the global soft kill (${clean(armed.reason)}): ${reason}`);
  // WHY revoke armed merges here too (INT2 left this to the U4 owner): KILL
  // alone makes the consume step refuse, but a merge another process already
  // ARMED keeps its protocol-level authority until something revokes it —
  // Stop/Revoke do, and a soft kill is the fleet pressing Stop on itself.
  // Lowering authority, so it runs even when arming KILL failed (then it is
  // the only thing standing between an armed merge and GitHub), and after
  // the arm attempt so nothing can be re-armed behind it while KILL is on.
  // Idempotent: a KILL that was already on just finds nothing left to revoke.
  await revokeMergesAfterSoftKill(deps, reason, pass);
  if (armed.changed && w) ledgerOrQueue(deps, w, { kind: 'kill:on', data: { reason: clean(reason) } });
  try {
    deps.recordHalt({ reason, repos, landingIds: w ? [w.landing.id] : [], nowMs });
  } catch { /* the halt record is for the morning report; the kill itself is what matters */ }
  audit({
    action: 'fleet:post-merge-soft-kill',
    repo: null,
    sandboxId: null,
    summary: clean(reason),
    result: armed.ok ? 'ok' : 'error',
  });
  return { at: iso(nowMs), reason: clean(reason) };
}

async function revokeMergesAfterSoftKill(deps: PostMergeWatchDeps, reason: string, pass: PostMergeWatchPassResult): Promise<void> {
  const revoke = deps.revokeArmedMerges ?? revokeArmedMerges;
  let outcome: MergeRevocationOutcome;
  try {
    outcome = await revoke(`post-merge soft kill: ${clean(reason, 200)}`);
  } catch (error) {
    // The contract says never throws; an injected one might. Still reported.
    outcome = { revoked: 0, failed: [errText(error)] };
  }
  if (outcome.revoked > 0) pass.escalations.push(`revoked ${outcome.revoked} armed fleet merge(s) after the soft kill`);
  if (outcome.failed.length > 0) {
    pass.escalations.push(`could not revoke every armed fleet merge after the soft kill (KILL still blocks their consume): ${clean(outcome.failed.join('; '))}`);
  }
}

async function onRed(
  w: PostMergeWatch,
  history: EscalationHistory,
  deps: PostMergeWatchDeps,
  budget: { suiteRuns: number },
  pass: PostMergeWatchPassResult,
  signal: AbortSignal | undefined,
): Promise<void> {
  const landing = w.landing;
  const nowMs = deps.now();

  // ── a red REVERT is never reverted: owner-hold + global soft kill ──────
  if (landing.kind === 'revert') {
    const detail = `the revert ${short(landing.mergeSha)} is itself red (${redDetail(w)})`;
    const result = buildResult(w, nowMs, ciForResult(w.ci), 'red', detail);
    w.result = result;
    w.outcome = 'revert-red';
    w.phase = 'done';
    ledgerOrQueue(deps, w, { kind: 'post-merge:result', data: result });
    ownerHold(w, deps, nowMs, detail, pass);
    const kill = await softKill(w, deps, nowMs, `${landing.repo}: ${detail}`, [landing.repo], pass);
    saveWatch(w, (h) => { h.kills.push(kill); });
    pass.finalized.push(result);
    return;
  }

  // ── attribute against the first parent ──────────────────────────────────
  const commit = await safeReadCommit(deps, landing.repo, landing.mergeSha);
  const parent = commit && commit.parents.length >= 1 ? commit.parents[0]! : null;
  let culpritChecks: string[] = [];
  if (w.ci?.state === 'red') {
    culpritChecks = w.ci.failing;
    if (parent) {
      const parentCi = await safeCi(deps, landing.repo, parent);
      if (parentCi.state === 'red') {
        const inherited = new Set(parentCi.failing);
        culpritChecks = w.ci.failing.filter((name) => !inherited.has(name));
      }
    }
  }
  let suiteCulprit = false;
  if (w.suite.state === 'fail') {
    if (w.suite.parent === null && parent && !safeKillActive(deps) && budget.suiteRuns > 0 && !signal?.aborted) {
      budget.suiteRuns--;
      pass.suiteRuns++;
      const parentRun = await safeSuite(deps, landing.repo, parent, signal);
      w.suite.parent = parentRun.result;
    }
    // An unevaluated parent does not excuse the landing (fail safe).
    suiteCulprit = w.suite.parent !== 'fail';
  }
  const culprit = culpritChecks.length > 0 || suiteCulprit;

  if (!culprit) {
    const detail = `default branch was already red at parent ${parent ? short(parent) : '?'} (${redDetail(w)}); not caused by this landing`;
    const result = buildResult(w, nowMs, ciForResult(w.ci), 'red', detail);
    w.result = result;
    w.outcome = 'inherited-red';
    w.phase = 'done';
    ledgerOrQueue(deps, w, { kind: 'post-merge:result', data: result });
    quarantine(w, history, deps, nowMs, detail, pass);
    saveWatch(w, (h) => pushOnce(h.quarantines, { repo: landing.repo, at: iso(nowMs), landingId: landing.id }));
    pass.finalized.push(result);
    return;
  }

  const why = culpritChecks.length > 0 ? `CI failing on ${short(landing.mergeSha)}: ${culpritChecks.slice(0, 5).join(', ')}` : '';
  const detail = [why, suiteCulprit ? `suite failed twice at ${short(landing.mergeSha)}: ${w.suite.detail ?? ''}` : '']
    .filter(Boolean).join('; ');
  const result = buildResult(w, nowMs, ciForResult(w.ci), 'red', detail);
  w.result = result;
  ledgerOrQueue(deps, w, { kind: 'post-merge:result', data: result });
  pass.finalized.push(result);

  // ── 1. quarantine first (lowering authority; see header) ────────────────
  quarantine(w, history, deps, nowMs, `fleet merge PR #${landing.prNumber} (${short(landing.mergeSha)}) went red: ${detail}`, pass);
  const redRow = { repo: landing.repo, at: iso(nowMs), landingId: landing.id };
  const projected: EscalationHistory = { ...history, reds: [...history.reds, redRow] };
  const redRepos = redReposWithin(projected, nowMs);
  const kills: { at: string; reason: string }[] = [];
  if (redRepos.length >= RED_REPOS_KILL_COUNT) {
    kills.push(await softKill(w, deps, nowMs, `${redRepos.length} repos went red within 6 h (${redRepos.join(', ')})`, redRepos, pass));
  }

  // ── 2. prove it is the fleet's commit ───────────────────────────────────
  if (!commit) {
    // Transient: GitHub could not be read. Retry the proof and the revert next pass.
    w.phase = 'reverting';
    w.revert = { attempts: 0, lastError: 'could not read the merge commit from GitHub', revertLandingId: null, authorshipProven: false, startedAt: iso(nowMs) };
    saveWatch(w, (h) => { pushOnce(h.reds, redRow); pushOnce(h.quarantines, { ...redRow }); h.kills.push(...kills); });
    return;
  }
  const refusal = fleetRevertRefusal(commit, landing);
  if (refusal) {
    w.outcome = 'revert-refused';
    w.phase = 'done';
    ledgerOrQueue(deps, w, { kind: 'revert:failed', data: { landingId: landing.id, repo: landing.repo, reason: clean(`not reverted: ${refusal}`) } });
    ownerHold(w, deps, nowMs, `red landing is not provably the fleet's (${refusal}); it was NOT reverted`, pass);
    kills.push(await softKill(w, deps, nowMs, `${landing.repo}: red landing could not be proven fleet-authored — ${refusal}`, [landing.repo], pass));
    saveWatch(w, (h) => { pushOnce(h.reds, redRow); pushOnce(h.quarantines, { ...redRow }); h.kills.push(...kills); });
    return;
  }

  // ── 3. revert ───────────────────────────────────────────────────────────
  w.phase = 'reverting';
  w.revert = { attempts: 0, lastError: null, revertLandingId: null, authorshipProven: true, startedAt: iso(nowMs) };
  saveWatch(w, (h) => { pushOnce(h.reds, redRow); pushOnce(h.quarantines, { ...redRow }); h.kills.push(...kills); });
  await attemptRevert(w, deps, pass);
}

function redDetail(w: PostMergeWatch): string {
  const parts: string[] = [];
  if (w.ci?.state === 'red') parts.push(w.ci.detail);
  if (w.suite.state === 'fail') parts.push(`suite: ${w.suite.detail ?? 'failed'}`);
  return parts.join('; ') || 'red';
}

async function attemptRevert(w: PostMergeWatch, deps: PostMergeWatchDeps, pass: PostMergeWatchPassResult): Promise<void> {
  const landing = w.landing;
  const nowMs = deps.now();
  const state: RevertState = w.revert ?? { attempts: 0, lastError: null, revertLandingId: null, authorshipProven: false, startedAt: iso(nowMs) };
  w.revert = state;

  // Prove authorship first if an earlier pass could not read the commit.
  if (!state.authorshipProven) {
    const commit = await safeReadCommit(deps, landing.repo, landing.mergeSha);
    if (!commit) {
      state.attempts++;
      if (state.attempts < MAX_REVERT_ATTEMPTS) { saveWatch(w); return; }
      return await failRevert(w, deps, nowMs, 'github', 'the merge commit could not be read from GitHub to prove fleet authorship', pass);
    }
    const refusal = fleetRevertRefusal(commit, landing);
    if (refusal) {
      w.outcome = 'revert-refused';
      w.phase = 'done';
      ledgerOrQueue(deps, w, { kind: 'revert:failed', data: { landingId: landing.id, repo: landing.repo, reason: clean(`not reverted: ${refusal}`) } });
      ownerHold(w, deps, nowMs, `red landing is not provably the fleet's (${refusal}); it was NOT reverted`, pass);
      const kill = await softKill(w, deps, nowMs, `${landing.repo}: red landing could not be proven fleet-authored — ${refusal}`, [landing.repo], pass);
      saveWatch(w, (h) => { h.kills.push(kill); });
      return;
    }
    state.authorshipProven = true;
    state.lastError = null;
  }

  let outcome: FleetRevertOutcome;
  try {
    outcome = await deps.landRevert({
      landing,
      reason: clean(`Post-merge watch: ${w.result?.detail ?? 'red after landing'}`),
      idempotencyKey: `revert:${landing.id}`,
      actor: 'post-merge-watch',
    });
  } catch (error) {
    outcome = { ok: false, code: 'github', retryable: true, reason: errText(error) };
  }
  if (outcome.ok) {
    const bad = revertLandingRefusal(outcome.landing, landing);
    if (bad) outcome = { ok: false, code: 'invalid-response', retryable: false, reason: bad };
  }

  if (!outcome.ok) {
    if (outcome.code === 'killed') {
      // Stop is on: nothing merges, including this revert. It stays queued; the quarantine holds the repo.
      state.lastError = clean(outcome.reason);
      saveWatch(w);
      return;
    }
    if (outcome.code === 'pending') {
      // In flight (checks running, mirror catching up, verification capacity
      // busy): not an attempt. Bounded by the overall deadline instead.
      const startedMs = state.startedAt ? Date.parse(state.startedAt) : Number.NaN;
      if (!Number.isFinite(startedMs)) state.startedAt = iso(nowMs);
      const elapsedMs = Number.isFinite(startedMs) ? nowMs - startedMs : 0;
      state.lastError = clean(outcome.reason);
      if (elapsedMs < REVERT_PENDING_DEADLINE_MS) {
        saveWatch(w);
        return;
      }
      return await failRevert(
        w, deps, nowMs, 'pending',
        `still not landed ${Math.round(elapsedMs / MINUTE_MS)} min after it started: ${outcome.reason}`,
        pass,
      );
    }
    state.attempts++;
    state.lastError = clean(outcome.reason);
    if (outcome.retryable && state.attempts < MAX_REVERT_ATTEMPTS) {
      pass.escalations.push(`revert of ${landing.id} failed (attempt ${state.attempts}/${MAX_REVERT_ATTEMPTS}), will retry: ${state.lastError}`);
      saveWatch(w);
      return;
    }
    return await failRevert(w, deps, nowMs, outcome.code, outcome.reason, pass);
  }

  // ── landed ──────────────────────────────────────────────────────────────
  const revertLanding = outcome.landing;
  state.revertLandingId = revertLanding.id;
  state.lastError = null;
  w.outcome = 'reverted';
  w.phase = 'done';
  ledgerOrQueue(deps, w, { kind: 'revert:landed', data: revertLanding });
  pass.reverted.push(landing.id);
  pass.escalations.push(`${landing.repo}: reverted PR #${landing.prNumber} (${short(landing.mergeSha)}) with ${short(revertLanding.mergeSha)}`);

  // Repair task (U5). Idempotent on dedupeKey; a failure is retried next pass.
  fileRepair(w, deps);

  const revertRow = { repo: landing.repo, at: iso(nowMs), landingId: landing.id };
  const kills: { at: string; reason: string }[] = [];
  const snapshot = readWatch(landing.id);
  const history = snapshot?.history ?? emptyHistory();
  const reverts = revertsWithin({ ...history, reverts: [...history.reverts.filter((r) => r.landingId !== landing.id), revertRow] }, nowMs);
  if (reverts >= REVERTS_KILL_COUNT) {
    kills.push(await softKill(w, deps, nowMs, `${reverts} fleet reverts within 24 h`, [landing.repo], pass));
  }
  saveWatch(w, (h) => {
    pushOnce(h.reverts, revertRow);
    h.kills.push(...kills);
  });
  // Watch the revert itself (a red revert escalates, it is never reverted).
  const reg = mutateStore((store) => registerInto(store, revertLanding, nowMs));
  if (!reg.ok) pass.escalations.push(`the revert ${revertLanding.id} could not be registered for watching: ${reg.reason}`);
}

async function failRevert(
  w: PostMergeWatch,
  deps: PostMergeWatchDeps,
  nowMs: number,
  code: FleetRevertFailureCode,
  reason: string,
  pass: PostMergeWatchPassResult,
): Promise<void> {
  const landing = w.landing;
  w.outcome = 'revert-failed';
  w.phase = 'done';
  const sentence = clean(`revert of PR #${landing.prNumber} (${short(landing.mergeSha)}) failed [${code}]: ${reason}`);
  ledgerOrQueue(deps, w, { kind: 'revert:failed', data: { landingId: landing.id, repo: landing.repo, reason: sentence } });
  ownerHold(w, deps, nowMs, sentence, pass);
  const kill = await softKill(w, deps, nowMs, `${landing.repo}: ${sentence}`, [landing.repo], pass);
  saveWatch(w, (h) => { h.kills.push(kill); });
}

/** A lander answer we will record as a revert must actually be one — of THIS landing. */
function revertLandingRefusal(revert: LandingRecord, of: LandingRecord): string | null {
  const shape = landingRefusal(revert);
  if (shape) return `the revert landing is malformed: ${shape}`;
  if (revert.kind !== 'revert') return 'the lander returned a non-revert landing';
  if (revert.repo.toLowerCase() !== of.repo.toLowerCase()) return 'the lander returned a revert in another repo';
  if (revert.revertsLandingId !== of.id) return 'the lander returned a revert of another landing';
  return null;
}

function fileRepair(w: PostMergeWatch, deps: PostMergeWatchDeps): void {
  const landing = w.landing;
  const failing = w.ci?.state === 'red' ? w.ci.failing.slice(0, 5).join(', ') : '';
  const input: FleetTaskInput = {
    repo: landing.repo,
    source: 'repair',
    title: clean(`Repair: re-land PR #${landing.prNumber} without breaking ${failing || 'the suite'}`, 160),
    detail: clean(
      `Fleet merge ${short(landing.mergeSha)} (PR #${landing.prNumber}, proposal ${landing.proposalId ?? 'unknown'}) ` +
      `went red after landing and was reverted. ${w.result?.detail ?? ''} ` +
      `Re-attempt the change so every required check stays green.`,
      1_000,
    ),
    difficulty: 'medium',
    value: 3,
    requestedBy: 'post-merge-watch',
    landingId: landing.id,
    dedupeKey: `repair:${landing.id}`,
  };
  try {
    const r = deps.enqueueRepairTask(input);
    if (r.ok) { w.repairTaskId = r.task.id; w.repairError = null; } else w.repairError = clean(r.reason);
  } catch (error) {
    w.repairError = clean(errText(error));
  }
}

// ---------------------------------------------------------------------------
// Safe wrappers (a dependency that throws proves nothing)
// ---------------------------------------------------------------------------

async function safeCi(deps: PostMergeWatchDeps, repo: string, sha: string): Promise<CiObservation> {
  try {
    const ci = await deps.ciStatus(repo, sha);
    if (!ci || typeof ci.state !== 'string') return { state: 'unknown', failing: [], detail: 'CI reader returned nothing' };
    return { state: ci.state, failing: Array.isArray(ci.failing) ? ci.failing.map((n) => clean(n, 80)) : [], detail: clean(ci.detail ?? '') };
  } catch (error) {
    return { state: 'unknown', failing: [], detail: `CI unreadable: ${clean(errText(error))}` };
  }
}

async function safeSuite(deps: PostMergeWatchDeps, repo: string, sha: string, signal: AbortSignal | undefined): Promise<SuiteRun> {
  try {
    const run = await deps.runSuiteAt(repo, sha, signal ? { signal } : {});
    if (!run || (run.result !== 'pass' && run.result !== 'fail' && run.result !== 'not-run')) {
      return { result: 'not-run', detail: 'suite runner returned nothing', commandsRun: 0 };
    }
    return { result: run.result, detail: clean(run.detail ?? ''), commandsRun: run.commandsRun ?? 0 };
  } catch (error) {
    return { result: 'not-run', detail: `suite could not run: ${clean(errText(error))}`, commandsRun: 0 };
  }
}

async function safeReadCommit(deps: PostMergeWatchDeps, repo: string, sha: string): Promise<CommitInfo | null> {
  try {
    const c = await deps.readCommit(repo, sha);
    if (!c || typeof c.sha !== 'string' || !Array.isArray(c.parents) || typeof c.message !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

function safeKillActive(deps: PostMergeWatchDeps): boolean {
  try {
    return deps.killActive();
  } catch {
    return true; // unknown ⇒ treat Stop as on
  }
}

// ---------------------------------------------------------------------------
// Production defaults
// ---------------------------------------------------------------------------

export function defaultPostMergeWatchDeps(): PostMergeWatchDeps {
  return {
    now: () => Date.now(),
    ciStatus: githubCiStatus,
    readCommit: githubReadCommit,
    runSuiteAt: runSuiteInMirrorWorktree,
    landRevert: landRevertViaHostMerge,
    enqueueRepairTask: (input) => enqueueTask(input),
    setHold: (req, o) => setRepoHold(req, o),
    softKill: armGlobalSoftKill,
    killActive: () => killSwitchOn(),
    appendLedger: (input) => appendLedger(input),
    readLedger: (o) => readLedger(o),
    recordHalt: ({ reason, repos, landingIds, nowMs }) => {
      recordFleetEscalationHalt({ reason, repos, landingIds }, { now: () => nowMs });
    },
  };
}

/** Stop = `~/.ashlr/KILL` (the same sentinel `ashlr stop` and the Command Stop button write). */
export function armGlobalSoftKill(reason: string): { ok: boolean; changed: boolean; reason: string } {
  const wasOn = killSwitchOn();
  const r = setKill(true, { waitMs: 1_000 });
  // The sentinel is installed BEFORE setKill waits for quiescence, so
  // "armed" is the readback, not r.ok (which also requires the fence).
  const on = killSwitchOn();
  return { ok: on, changed: on && !wasOn, reason: on ? clean(reason) : r.reason };
}

/**
 * U3's revert path, resolved at call time. WHY dynamic: `landFleetRevert` is
 * not part of the frozen day-0 host-merge contract; until U3 exports it the
 * answer is a non-retryable `unavailable` — which escalates (owner-hold +
 * soft kill), the correct direction for a red merge nobody can revert.
 */
export async function landRevertViaHostMerge(req: FleetRevertRequest): Promise<FleetRevertOutcome> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('./host-merge.js')) as unknown as Record<string, unknown>;
  } catch (error) {
    return { ok: false, code: 'unavailable', retryable: false, reason: `host-merge could not load: ${errText(error)}` };
  }
  let fn: unknown;
  try {
    fn = mod['landFleetRevert'];
  } catch {
    fn = undefined; // a module namespace proxy that throws on unknown names reads as "not exported"
  }
  if (typeof fn !== 'function') {
    return { ok: false, code: 'unavailable', retryable: false, reason: 'host-merge exports no landFleetRevert' };
  }
  // A short per-call wait: the watch runs in the daemon's beforeTick, and an
  // unfinished wait answers `pending` and resumes on the next pass.
  return (fn as HostMergeRevertLander)(req, { maxWaitMs: REVERT_TICK_WAIT_MS });
}

// ── GitHub (read-only endpoints; App installation token from custody) ─────

const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

async function githubGet(repo: string, path: string, fetchImpl: FetchLike): Promise<unknown> {
  if (!NAME_WITH_OWNER_RE.test(repo)) throw new Error('repo is not owner/name');
  const token = await githubToken(repo);
  const res = await fetchImpl(`${GITHUB_API}/repos/${repo}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ashlr-fleet-post-merge-watch',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  // Never echo the body or headers: a GitHub error body can quote the request.
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
  return res.json();
}

/** CI on `sha`: check runs (≤ 300) plus combined commit statuses. */
export async function githubCiStatus(repo: string, sha: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<CiObservation> {
  if (!GIT_SHA_RE.test(sha)) return { state: 'unknown', failing: [], detail: 'malformed SHA' };
  const runs: { name: string; status: string; conclusion: string | null }[] = [];
  for (let page = 1; page <= 3; page++) {
    const body = await githubGet(repo, `/commits/${sha}/check-runs?per_page=100&page=${page}`, fetchImpl) as
      { total_count?: unknown; check_runs?: unknown };
    const list = Array.isArray(body?.check_runs) ? body.check_runs : [];
    for (const item of list) {
      const r = item as Record<string, unknown>;
      runs.push({
        name: typeof r['name'] === 'string' ? r['name'] : 'unnamed check',
        status: typeof r['status'] === 'string' ? r['status'] : 'unknown',
        conclusion: typeof r['conclusion'] === 'string' ? r['conclusion'] : null,
      });
    }
    const total = typeof body?.total_count === 'number' ? body.total_count : list.length;
    if (list.length < 100 || runs.length >= total) break;
  }
  const status = await githubGet(repo, `/commits/${sha}/status?per_page=100`, fetchImpl) as { statuses?: unknown };
  const statuses = (Array.isArray(status?.statuses) ? status.statuses : []).map((s) => {
    const r = s as Record<string, unknown>;
    return { context: typeof r['context'] === 'string' ? r['context'] : 'status', state: typeof r['state'] === 'string' ? r['state'] : 'unknown' };
  });
  return classifyCi(runs, statuses);
}

export async function githubReadCommit(repo: string, sha: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): Promise<CommitInfo | null> {
  if (!GIT_SHA_RE.test(sha)) return null;
  const body = await githubGet(repo, `/commits/${sha}`, fetchImpl) as Record<string, unknown> | null;
  if (!body || typeof body['sha'] !== 'string') return null;
  const commit = (body['commit'] ?? {}) as Record<string, unknown>;
  const author = (commit['author'] ?? {}) as Record<string, unknown>;
  const ghAuthor = body['author'] as Record<string, unknown> | null | undefined;
  const parents = Array.isArray(body['parents'])
    ? body['parents'].map((p) => (p as Record<string, unknown>)['sha']).filter((s): s is string => typeof s === 'string' && GIT_SHA_RE.test(s))
    : [];
  return {
    sha: body['sha'],
    parents,
    authorLogin: ghAuthor && typeof ghAuthor['login'] === 'string' ? ghAuthor['login'] : null,
    authorName: typeof author['name'] === 'string' ? author['name'] : null,
    authorEmail: typeof author['email'] === 'string' ? author['email'] : null,
    message: typeof commit['message'] === 'string' ? commit['message'] : '',
  };
}

// ── The suite in a fresh worktree of the fleet mirror ──────────────────────

/**
 * `~/.ashlr/fleet/mirrors/<owner>__<repo>` — U6's canonical mirror path
 * (fleet/mirrors.ts owns the layout; one rule, no drift). The watch never
 * touches Mason's own checkouts.
 */
export function fleetMirrorPath(repo: string): string {
  return mirrorPathFor(repo);
}

/** How long the watch waits for the mirror's repo lease around worktree add / remove. */
const SUITE_LEASE_WAIT_MS = 60_000;

const SUITE_COMMAND_TIMEOUT_MS = 10 * MINUTE_MS;
const SUITE_TOTAL_TIMEOUT_MS = 20 * MINUTE_MS;
const GIT_TIMEOUT_MS = 60_000;

/**
 * git in the fleet mirror through U2's sandbox/safe-git.ts (layout `repo`).
 * WHY: agents run in worktrees linked to the mirror and share its config
 * between U6's syncs, so a planted `core.hooksPath`, fsmonitor, filter or
 * diff driver would run with the daemon's authority on the next daemon git
 * call. safe-git forces hooks / fsmonitor off, reads attributes from the
 * EMPTY tree (no filter driver can match during `worktree add`), nulls
 * global / system config and credential helpers, and verifies `.git` is the
 * mirror's own directory before anything runs. `mirror` must be canonical.
 */
function mirrorGit(mirror: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = runSafeGitSync({
      workTree: mirror,
      gitDir: join(mirror, '.git'),
      layout: 'repo',
      args,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 4 * 1024 * 1024,
      noOptionalLocks: true,
    });
    return { ok: r.ok, stdout: r.stdout.trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** HEAD of the linked worktree at `path`, read from the mirror (no git runs inside the worktree). */
function worktreeHead(mirror: string, path: string): string | null {
  const listed = mirrorGit(mirror, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;
  const want = realpathOr(path);
  for (const block of listed.stdout.split('\n\n')) {
    const lines = block.split('\n');
    const wt = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    if (!wt || realpathOr(wt) !== want) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice('HEAD '.length) ?? null;
    return head && GIT_SHA_RE.test(head) ? head : null;
  }
  return null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export interface MirrorSuiteOptions {
  signal?: AbortSignal;
  /** Tests point this at a scratch repo; production uses fleetMirrorPath. */
  mirrorPath?: string;
}

/**
 * True when a standing policy is live (unknown ⇒ live: confine, the rule
 * sandbox/confine.ts applies to agents).
 */
function standingLive(): boolean {
  try {
    return currentStandingPolicy() !== null;
  } catch {
    return true;
  }
}

/**
 * Detached worktree at `sha`, the repo's own REQUIRED merge-profile verify
 * commands, then removal. A failure is `fail` only when the command ran and
 * the CODE failed; a tool / timeout / infra failure is `not-run` — it proves
 * nothing about the merge.
 *
 * V3.10 hardening (INT3):
 * - Commands are detected in the PARENT's tree (the pre-landing base), then
 *   the worktree moves to `sha` — the H1a rule inbox/merge.ts verifyProposal
 *   applies: the change under test can never choose what tests it. G1 already
 *   routes manifest / verify-config changes to the owner lane; this makes the
 *   watch hold even for a config file G1 does not list.
 * - Worktree add / checkout / remove run under the mirror's repo lease (U6:
 *   a mirror sync never interleaves with them); a busy lease is `not-run`.
 * - The suite runs in a verification slot (U6: bounded machine-wide).
 * - Under a standing grant the suite runs CONFINED (it executes merged,
 *   agent-written code): inbox/merge.ts openStandingVerificationConfinement.
 *   A grant with no buildable confinement is `not-run`, never unconfined.
 */
export async function runSuiteInMirrorWorktree(repo: string, sha: string, opts: MirrorSuiteOptions = {}): Promise<SuiteRun> {
  if (!GIT_SHA_RE.test(sha)) return { result: 'not-run', detail: 'malformed SHA', commandsRun: 0 };
  let mirror: string | null = opts.mirrorPath ?? null;
  if (!mirror && NAME_WITH_OWNER_RE.test(repo)) {
    try {
      mirror = fleetMirrorPath(repo);
    } catch {
      mirror = null;
    }
  }
  if (!mirror || !existsSync(mirror)) return { result: 'not-run', detail: `no fleet mirror for ${repo}`, commandsRun: 0 };
  mirror = realpathOr(mirror);
  if (!mirrorGit(mirror, ['cat-file', '-e', `${sha}^{commit}`]).ok) {
    return { result: 'not-run', detail: `${short(sha)} is not in the mirror yet`, commandsRun: 0 };
  }
  const parentRead = mirrorGit(mirror, ['rev-parse', '--verify', '--quiet', `${sha}^1^{commit}`]);
  const detectAt = parentRead.ok && GIT_SHA_RE.test(parentRead.stdout) ? parentRead.stdout : sha;
  let leaseKey: string;
  try {
    leaseKey = mirrorLeaseKey(mirror);
  } catch (error) {
    return { result: 'not-run', detail: `mirror lease key: ${clean(errText(error))}`, commandsRun: 0 };
  }
  let tempRoot: string;
  try {
    tempRoot = mkdtempSync(join(tmpdir(), 'ashlr-post-merge-watch-'));
  } catch (error) {
    return { result: 'not-run', detail: `temp dir: ${clean(errText(error))}`, commandsRun: 0 };
  }
  // Two worktrees: `detect` at the parent (read the command set, then gone),
  // `wt` at the merge SHA (run it). Nothing ever runs git INSIDE a worktree.
  const detectTree = join(tempRoot, 'detect');
  const worktree = join(tempRoot, 'wt');
  let confined: { runSubprocess: NonNullable<RunVerifyCommandAsyncOptions['_runSubprocess']>; close: () => void } | null = null;
  try {
    // ── set up under the mirror lease: add at the parent, detect, move to sha ──
    const setup = await withRepoLease(leaseKey, (): { ok: true; required: ReturnType<typeof detectVerifyCommands> } | { ok: false; detail: string } => {
      let required: ReturnType<typeof detectVerifyCommands>;
      if (detectAt !== sha) {
        if (!mirrorGit(mirror, ['worktree', 'add', '--detach', detectTree, detectAt]).ok) return { ok: false, detail: 'git worktree add (parent) failed' };
        required = rebaseCommandCwds(detectVerifyCommands(detectTree, 'merge').filter((c) => c.required !== false), detectTree);
        mirrorGit(mirror, ['worktree', 'remove', '--force', detectTree]);
      }
      if (!mirrorGit(mirror, ['worktree', 'add', '--detach', worktree, sha]).ok) return { ok: false, detail: 'git worktree add failed' };
      if (worktreeHead(mirror, worktree) !== sha) return { ok: false, detail: 'worktree is not at the merge SHA' };
      required = detectAt !== sha ? required! : detectVerifyCommands(worktree, 'merge').filter((c) => c.required !== false);
      return { ok: true, required };
    }, { waitMs: SUITE_LEASE_WAIT_MS });
    if (!setup.ok) return { result: 'not-run', detail: `the mirror's repo lease is unavailable: ${clean(setup.reason)}`, commandsRun: 0 };
    if (!setup.value.ok) return { result: 'not-run', detail: setup.value.detail, commandsRun: 0 };
    const required = setup.value.required;
    if (required.length === 0) return { result: 'not-run', detail: 'no required verify command', commandsRun: 0 };
    // The toolchain: the same links (root + pnpm workspace packages) and the
    // same read-only grants G3 uses — inbox/merge.ts linkVerifyNodeModules.
    // One helper for both so the watch can never verify with a narrower
    // toolchain than the gate that admitted the merge (a false `fail`).
    const { linkVerifyNodeModules, openStandingVerificationConfinement } = await import('../inbox/merge.js');
    const installGrants = linkVerifyNodeModules(mirror, worktree);

    if (standingLive()) {
      try {
        confined = await openStandingVerificationConfinement(worktree, { readOnlyPaths: installGrants });
      } catch (error) {
        return { result: 'not-run', detail: `suite confinement unavailable under the standing grant: ${clean(errText(error))}`, commandsRun: 0 };
      }
    }
    const runOpts: Pick<RunVerifyCommandAsyncOptions, '_runSubprocess'> = confined ? { _runSubprocess: confined.runSubprocess } : {};

    let commandsRun = 0;
    const runAll = async (): Promise<SuiteRun> => {
      const started = Date.now();
      for (const command of required) {
        if (opts.signal?.aborted) return { result: 'not-run', detail: 'interrupted', commandsRun };
        const remaining = SUITE_TOTAL_TIMEOUT_MS - (Date.now() - started);
        if (remaining <= 0) return { result: 'not-run', detail: 'suite exceeded its time budget', commandsRun };
        const r = await runVerifyCommandAsync(command, worktree, {} as AshlrConfig, {
          timeoutMs: Math.min(command.timeoutMs ?? SUITE_COMMAND_TIMEOUT_MS, SUITE_COMMAND_TIMEOUT_MS, remaining),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...runOpts,
        });
        commandsRun++;
        if (!r.ok) {
          const line = firstFailureLine(r.output);
          if (r.failureCategory === 'code') {
            return { result: 'fail', detail: `\`${clean(r.command, 120)}\` failed: ${line}`, commandsRun };
          }
          return { result: 'not-run', detail: `\`${clean(r.command, 120)}\` could not run (${r.failureCategory ?? 'infra'})`, commandsRun };
        }
      }
      return { result: 'pass', detail: `${commandsRun} required command(s) green at ${short(sha)}`, commandsRun };
    };
    try {
      return await withVerificationSlot(leaseKey, runAll, opts.signal ? { signal: opts.signal } : {});
    } catch (error) {
      if (error instanceof VerificationCapacityError) {
        return { result: 'not-run', detail: `verification capacity unavailable: ${clean(error.message)}`, commandsRun };
      }
      throw error;
    }
  } catch (error) {
    return { result: 'not-run', detail: `suite harness: ${clean(errText(error))}`, commandsRun: 0 };
  } finally {
    confined?.close();
    const cleanup = (): void => {
      mirrorGit(mirror, ['worktree', 'remove', '--force', worktree]);
      mirrorGit(mirror, ['worktree', 'remove', '--force', detectTree]);
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* temp dir; the OS reaps it */ }
      mirrorGit(mirror, ['worktree', 'prune']);
    };
    // Under the lease when it comes free; otherwise anyway — a stranded
    // worktree linked to the mirror is worse than an unleased removal of our own.
    let cleaned = false;
    try {
      cleaned = (await withRepoLease(leaseKey, () => { cleanup(); return true; }, { waitMs: SUITE_LEASE_WAIT_MS })).ok;
    } catch { /* fall through */ }
    if (!cleaned) cleanup();
  }
}

/**
 * Commands detected in the `detect` tree carry an ABSOLUTE `cwd` inside it
 * (repo-profile's contract parser stores the resolved directory). That tree
 * is removed before the suite runs in `wt`, so an unrebased `cwd` pointed at
 * a deleted directory outside the workspace and every package-scoped command
 * (`"cwd": "packages/a"` — the pnpm-workspace shape) came back
 * `invalid-command` → `not-run`: the watch could never verify such a repo.
 * Rebase each onto the same RELATIVE path, which runVerifyCommandAsync
 * resolves against the suite's worktree. A cwd that is not inside the detect
 * tree (lexically or physically) is left as it is, so it still fails closed
 * (`not-run`) instead of silently running somewhere else.
 */
function rebaseCommandCwds<T extends { cwd?: string }>(commands: T[], detectTree: string): T[] {
  const roots = [detectTree, realpathOr(detectTree)];
  return commands.map((command) => {
    if (!command.cwd || !isAbsolute(command.cwd)) return command;
    for (const root of roots) {
      const rel = relative(root, command.cwd);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      if (rel === '') {
        const { cwd: _root, ...rest } = command;
        void _root;
        return rest as T;
      }
      return { ...command, cwd: rel };
    }
    return command;
  });
}

function firstFailureLine(output: string): string {
  const lines = output.split('\n').map((l) => l.trim()).filter(Boolean);
  return clean(lines.find((l) => /error|fail/i.test(l)) ?? lines[0] ?? 'no output', 200);
}
