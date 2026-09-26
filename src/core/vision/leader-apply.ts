/**
 * Leader action application — V3.10 Track B (unit U8).
 *
 * Three steps per action, in this order:
 *
 *   1. A PURE POLICY CHECK (`classifyLeaderAction`) decides the class from the
 *      kind AND its params, against the standing grant:
 *        A — applies now; Mason can veto any time.
 *        B — applies after a veto window (grant `leader.vetoMinutes`, ≥ 30 min),
 *            deferred past local quiet hours (00:00–07:00) when it raises spend
 *            and the budget is not all-in (addendum §6).
 *        C — outside the grant: never applied; goes to Needs-you with the
 *            Leader's argument.
 *      With no grant, a `propose` switch or a shadow stage (the grant's
 *      current leader classes are empty) every memo is a DRY RUN: actions are
 *      computed and shown, never applied.
 *   2. APPLY, recording the action's exact `inverse` (the prior state).
 *   3. A `leader:action` row on the authority ledger for every status change.
 *
 * FAIL-CLOSED LEDGER RULES
 *   - An action is applied only after its `scheduled` row is on the ledger.
 *     If the ledger will not take the row, nothing is applied.
 *   - A class-B action is applied at the end of its window only if the ledger
 *     holds its `scheduled` row with the same kind, params and window. The
 *     local store (~/.ashlr/vision/leader/actions.json) is a working copy the
 *     UI reads; it is never trusted to AUTHORIZE anything, because it is not
 *     hash-chained.
 *   - Apply and veto settle a stored row by compare-and-set (a claim taken
 *     under the store lock), never by blind overwrite: a veto that lands
 *     mid-apply stands and the applier undoes its change; one action is
 *     applied at most once across processes.
 *   - A veto takes the inverse from the ledger's `applied` row. When the
 *     ledger cannot be read, a veto still runs — lowering never waits on
 *     anything (I1) — but only inverses that cannot raise autonomy (cancel a
 *     task / experiment, retire a standard, archive a goal, or restore a
 *     directive / budget that is not above the current one).
 *
 * BYTE-FOR-BYTE VETO. File-backed state (Leader directives, the A9 budget
 * policy, goal records) is snapshotted before the change and its digest after.
 * A veto restores the exact prior bytes when the file is still exactly what
 * the action wrote; when something else changed it since, only the fields the
 * action touched are put back and the veto reports `restored: false`.
 *
 * NODE-ONLY. `readLeaderDirectives` is the one hot path (the dispatch router
 * reads it); its imports are fs/crypto only — every heavy dependency (GitHub,
 * experiments, the task queue) is imported lazily inside the default deps.
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { goalsDir } from '../config.js';
import type { Goal, GoalStatus } from '../types.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import type { BudgetMode, BudgetPolicy } from '../routing/types.js';
import type {
  EffectivePolicy,
  LedgerAppendInput,
  LedgerAppendResult,
  LedgerEventKind,
  LedgerReadOptions,
  LedgerReadResult,
} from '../authority/types.js';
import type {
  CancelTaskRequest,
  CancelTaskResult,
  EnqueueTaskResult,
  FleetPrRequest,
  FleetPrResult,
  FleetTaskInput,
  RepoHoldChange,
  SetRepoHoldRequest,
} from '../fleet/fleet-types.js';
import type {
  AdoptHarnessRequest,
  CancelExperimentRequest,
  CancelExperimentResult,
  HarnessChangeResult,
  HarnessHypothesis,
  HarnessVersion,
  RollbackHarnessRequest,
  StartExperimentRequest,
  StartExperimentResult,
} from '../learn/harness-types.js';
import {
  LEADER_LIMITS,
  type LeaderAction,
  type LeaderActionClass,
  type LeaderActionParamsMap,
  type LeaderDirectivesV1,
  type LeaderInverse,
  type LeaderStandard,
  type LeaderVetoRecord,
} from './leader-types.js';
import { leaderRoot, parseActionParams, readLeaderMemo, type AnyLeaderActionDraft } from './leader-memo.js';

// Ranks duplicated from authority/types.ts on purpose: that module is a leaf
// of the authority surface, and this one must stay importable by the router
// without pulling runtime values across. Both are frozen tables.
const BUDGET_RANK: Readonly<Record<BudgetMode, number>> = { reserve: 0, balanced: 1, 'all-in': 2 };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function leaderActionsPath(): string {
  return join(leaderRoot(), 'actions.json');
}

export function leaderDirectivesPath(): string {
  return join(leaderRoot(), 'directives.json');
}

export function leaderStandardsPath(): string {
  return join(leaderRoot(), 'standards.json');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Directives (U5's dispatch router reads these)
// ---------------------------------------------------------------------------

const MAX_DIRECTIVES_BYTES = 16 * 1024;

/** The one serialization of directives — a veto reproduces these bytes exactly. */
export function serializeDirectives(directives: LeaderDirectivesV1): string {
  return `${JSON.stringify(directives, null, 2)}\n`;
}

function sanitizeDirectives(raw: unknown): LeaderDirectivesV1 | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(r['updatedAt']))) return null;
  const lanes = r['grokLanes'];
  const codex = r['codexEnabled'];
  const tuningRaw = r['routerTuning'];
  let routerTuning: LeaderDirectivesV1['routerTuning'] = null;
  if (tuningRaw !== null && tuningRaw !== undefined) {
    const parsed = parseActionParams('router.tune', { tuning: tuningRaw });
    if (!parsed.ok) return null;
    routerTuning = parsed.params.tuning;
  }
  return {
    v: 1,
    updatedAt: r['updatedAt'],
    routerTuning,
    // Clamped on READ as well as on write: this file lives under ~/.ashlr, and
    // the dispatch router must never see a lane count the Leader could not set.
    grokLanes: Number.isInteger(lanes) && (lanes as number) >= LEADER_LIMITS.grokLanes.min && (lanes as number) <= LEADER_LIMITS.grokLanes.max
      ? (lanes as number)
      : null,
    codexEnabled: typeof codex === 'boolean' ? codex : null,
  };
}

let directivesCache: { key: string; value: LeaderDirectivesV1 | null } | null = null;

/**
 * The Leader's standing directives (grok lanes, codex lanes, router tuning),
 * or null when the Leader has set none — the router then uses its defaults.
 *
 * FROZEN cross-unit contract (U5). Cheap: one stat per call, the file is
 * re-read only when its size or mtime changes. Never throws; a malformed file
 * reads as null (the conservative defaults: grok 2 lanes, codex off, no tuning).
 *
 * The router must still clamp what it reads against the grant: codexEnabled
 * is honoured only while the grant lists codex, and grokLanes only while it
 * lists grok-cli. The Leader checks both before writing; the router checking
 * again is what makes a hand-edited file harmless.
 */
export function readLeaderDirectives(): LeaderDirectivesV1 | null {
  const path = leaderDirectivesPath();
  let key: string;
  try {
    const st = statSync(path);
    key = `${path}\0${st.size}\0${st.mtimeMs}`;
  } catch {
    directivesCache = null;
    return null;
  }
  if (directivesCache && directivesCache.key === key) return directivesCache.value;
  const read = readPrivateFileCapped(path, MAX_DIRECTIVES_BYTES);
  let value: LeaderDirectivesV1 | null = null;
  if (read && !read.truncated) {
    try {
      value = sanitizeDirectives(JSON.parse(read.text) as unknown);
    } catch {
      value = null;
    }
  }
  directivesCache = { key, value };
  return value;
}

function readRawFile(path: string, max: number): string | null {
  const read = readPrivateFileCapped(path, max);
  return read && !read.truncated ? read.text : null;
}

/** Current directives as the Leader edits them (never null — defaults when none are set). */
function baseDirectives(nowIso: string): LeaderDirectivesV1 {
  return readLeaderDirectives() ?? { v: 1, updatedAt: nowIso, routerTuning: null, grokLanes: null, codexEnabled: null };
}

function writeDirectives(directives: LeaderDirectivesV1): string {
  ensurePrivateDirectory(leaderRoot());
  const bytes = serializeDirectives(directives);
  writePrivateFileAtomic(leaderDirectivesPath(), bytes);
  directivesCache = null;
  return bytes;
}

/** The grok lane count in force when the Leader has not set one. */
export function currentGrokLanes(directives: LeaderDirectivesV1 | null): number {
  return directives?.grokLanes ?? LEADER_LIMITS.grokLanes.default;
}

// ---------------------------------------------------------------------------
// Standards
// ---------------------------------------------------------------------------

const MAX_STANDARDS_BYTES = 256 * 1024;
const MAX_STANDARDS = 200;

export function readStandards(): LeaderStandard[] {
  const raw = readRawFile(leaderStandardsPath(), MAX_STANDARDS_BYTES);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { standards?: unknown }).standards)) return [];
    return ((parsed as { standards: unknown[] }).standards).filter((s): s is LeaderStandard => {
      if (typeof s !== 'object' || s === null) return false;
      const r = s as Record<string, unknown>;
      return typeof r['id'] === 'string' && typeof r['rule'] === 'string' && typeof r['appliesTo'] === 'string'
        && (r['source'] === 'leader' || r['source'] === 'mason') && typeof r['addedAt'] === 'string';
    });
  } catch {
    return [];
  }
}

function writeStandards(standards: LeaderStandard[]): void {
  ensurePrivateDirectory(leaderRoot());
  writePrivateFileAtomic(leaderStandardsPath(), `${JSON.stringify({ v: 1, standards: standards.slice(-MAX_STANDARDS) }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Action store (working copy for the UI — never an authorization source)
// ---------------------------------------------------------------------------

/** Exact bytes around one file-backed change, so a veto can put them back. */
export interface RestoreFile {
  /** What the file is: `directives`, `budget`, or `goal:<id>`. Paths are re-derived, never stored. */
  target: string;
  existed: boolean;
  /** The prior bytes (null when the file did not exist). */
  before: string | null;
  /** sha256 of the bytes the action wrote; null when it wrote nothing. */
  afterSha: string | null;
}

export interface StoredLeaderAction {
  action: LeaderAction;
  restore: RestoreFile[];
  /**
   * An in-flight apply or veto owns this row (compare-and-set under the store
   * lock). WHY: the daemon, `ashlr leader tick` and the comms poller can all
   * apply, and Verse / CLI / Telegram can all veto, from different processes.
   * Without a claim a veto that landed mid-apply was overwritten with
   * `applied` and the change stood against Mason's veto, and two tickers could
   * apply one action twice (review 310 c7). Absent on rows written before
   * 3.10.1 = unclaimed.
   */
  claim?: ActionClaim | null;
}

interface ActionClaim {
  op: 'apply' | 'veto';
  token: string;
  at: string;
}

interface LeaderActionStoreV1 {
  v: 1;
  updatedAt: string;
  /** Oldest first. */
  actions: StoredLeaderAction[];
  /** Needs-you items Mason dismissed (class-C asks, questions). */
  dismissed: { id: string; at: string }[];
}

/** Read cap: a file longer than this is never parsed on the hot path. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;
/**
 * Write budget, deliberately BELOW the read cap. WHY: the store used to be
 * trimmed by count only, so goal snapshots could push it past the read cap;
 * every reader then saw an empty store and the next write replaced the real
 * file with it (review 310 d3 — the same write-cap vs read-cap mismatch as
 * pool-ledger-json.ts). Compacting to this budget on every write keeps a
 * written file always readable, with headroom.
 */
const STORE_WRITE_BUDGET = 6 * 1024 * 1024;
/** A legacy over-size file is parsed with this cap once, archived and compacted (never read as empty). */
const STORE_RECOVERY_MAX_BYTES = 64 * 1024 * 1024;
export const ACTIONS_KEEP = 400;
const DISMISSED_KEEP = 500;
/** An apply / veto claim older than this belongs to a process that died mid-way. */
const CLAIM_STALE_MS = 10 * 60_000;

function emptyStore(nowIso: string): LeaderActionStoreV1 {
  return { v: 1, updatedAt: nowIso, actions: [], dismissed: [] };
}

function parseStore(raw: string): LeaderActionStoreV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LeaderActionStoreV1>;
    if (typeof parsed !== 'object' || parsed === null || parsed.v !== 1 || !Array.isArray(parsed.actions)) return null;
    return {
      v: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      actions: parsed.actions.filter((a): a is StoredLeaderAction =>
        typeof a === 'object' && a !== null && typeof a.action === 'object' && a.action !== null
        && typeof a.action.id === 'string' && Array.isArray(a.restore)),
      dismissed: Array.isArray(parsed.dismissed)
        ? parsed.dismissed.filter((d): d is { id: string; at: string } => typeof d?.id === 'string' && typeof d?.at === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * The store as read, telling "absent" apart from "present but unreadable".
 *   ok / missing — `store` is the truth (missing = empty);
 *   recovered    — the file was over the read cap (written by an older build)
 *                  and was parsed with the recovery cap; `raw` is its bytes;
 *   invalid      — present but not a store we wrote (garbled, wrong version);
 *   unreadable   — present but the read failed (EMFILE, EACCES…): transient.
 */
type StoreRead =
  | { state: 'ok' | 'missing'; store: LeaderActionStoreV1 }
  | { state: 'recovered'; store: LeaderActionStoreV1; raw: string }
  | { state: 'invalid' | 'unreadable'; reason: string };

function readActionStoreDetailed(): StoreRead {
  const path = leaderActionsPath();
  try {
    lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'missing', store: emptyStore(new Date(0).toISOString()) };
    return { state: 'unreadable', reason: `stat failed (${(err as NodeJS.ErrnoException)?.code ?? 'error'})` };
  }
  const read = readPrivateFileCapped(path, MAX_STORE_BYTES);
  if (!read) return { state: 'unreadable', reason: 'the file could not be opened or read' };
  if (!read.truncated) {
    const store = parseStore(read.text);
    return store ? { state: 'ok', store } : { state: 'invalid', reason: 'the file is not a Leader action store' };
  }
  const big = readPrivateFileCapped(path, STORE_RECOVERY_MAX_BYTES);
  if (!big) return { state: 'unreadable', reason: 'the over-size file could not be read' };
  if (big.truncated) return { state: 'invalid', reason: `the file is ${big.bytes} bytes, past the recovery cap` };
  const store = parseStore(big.text);
  return store ? { state: 'recovered', store, raw: big.text } : { state: 'invalid', reason: 'the over-size file is not a Leader action store' };
}

/**
 * The store for READERS (UI, planning). Total: an unreadable file reads as
 * empty here, which is safe only because this copy is never written back —
 * every write goes through `withActionStore`, which refuses or archives
 * instead (review 310 d3/d7).
 */
export function readActionStore(): LeaderActionStoreV1 {
  const read = readActionStoreDetailed();
  return 'store' in read ? read.store : emptyStore(new Date(0).toISOString());
}

function storeBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Drop goal bytes an inverse must not carry (review 310 d5): keep the id, a
 * digest and the prior status. Rows written before 3.10.1 carried whole
 * records; this is also applied to them before they reach the ledger again.
 */
function projectInverse(inverse: LeaderInverse | null): LeaderInverse | null {
  if (!inverse || inverse.op !== 'restore-goals') return inverse;
  return {
    op: 'restore-goals',
    before: inverse.before.map((b) => {
      if (b.record === null) return b;
      let priorStatus = b.priorStatus;
      if (priorStatus === undefined) {
        try { priorStatus = (JSON.parse(b.record) as Goal).status; } catch { /* unknown */ }
      }
      return { goalId: b.goalId, record: null, recordSha256: b.recordSha256 ?? sha256(b.record), ...(priorStatus ? { priorStatus } : {}) };
    }),
  };
}

/**
 * Count trim, then a BYTE budget: oldest first, (1) drop the restore
 * snapshots of settled actions (their veto then restores the status only),
 * (2) drop settled actions, (3) drop old dismissals. Scheduled or claimed rows are never touched — they
 * are tiny (no snapshots) and are what a veto or apply is working on.
 * Throws rather than write a file the reader could not read.
 */
function compactStore(store: LeaderActionStoreV1): LeaderActionStoreV1 {
  const live = (s: StoredLeaderAction): boolean => s.action.status === 'scheduled' || (s.claim !== undefined && s.claim !== null);
  // Count trim keeps every live row; the oldest settled rows go first.
  let actions = store.actions;
  if (actions.length > ACTIONS_KEEP) {
    let excess = actions.length - ACTIONS_KEEP;
    actions = actions.filter((s) => {
      if (excess > 0 && !live(s)) { excess -= 1; return false; }
      return true;
    });
  }
  // Goal bytes in a stored INVERSE are never read (a goal veto takes its
  // inverse from the ledger, and its bytes from `restore`), so rows written
  // before 3.10.1 lose that duplicate copy on the first write.
  const projected = actions.map((s) => (s.action.inverse?.op === 'restore-goals' && s.action.inverse.before.some((b) => b.record !== null)
    ? { ...s, action: { ...s.action, inverse: projectInverse(s.action.inverse) } as LeaderAction }
    : s));
  const out: LeaderActionStoreV1 = { ...store, actions: projected, dismissed: store.dismissed.slice(-DISMISSED_KEEP) };
  let total = storeBytes(out);
  if (total <= STORE_WRITE_BUDGET) return out;
  for (let i = 0; i < out.actions.length && total > STORE_WRITE_BUDGET; i += 1) {
    const s = out.actions[i]!;
    if (live(s)) continue;
    if (s.restore.length === 0) continue;
    const slim: StoredLeaderAction = { ...s, restore: [] };
    total -= storeBytes(s) - storeBytes(slim);
    out.actions[i] = slim;
  }
  while (total > STORE_WRITE_BUDGET) {
    const index = out.actions.findIndex((s) => !live(s));
    if (index === -1) break;
    total -= storeBytes(out.actions[index]) + 1;
    out.actions.splice(index, 1);
  }
  while (total > STORE_WRITE_BUDGET && out.dismissed.length > 0) {
    total -= storeBytes(out.dismissed[0]) + 1;
    out.dismissed.shift();
  }
  if (storeBytes(out) > MAX_STORE_BYTES) throw new Error('the Leader action store cannot be compacted under its size cap; nothing was written');
  return out;
}

function writeActionStore(store: LeaderActionStoreV1): void {
  ensurePrivateDirectory(leaderRoot());
  writePrivateFileAtomic(leaderActionsPath(), `${JSON.stringify(compactStore(store))}\n`);
  storeListeners.forEach((fn) => {
    try { fn(); } catch { /* a listener never breaks a write */ }
  });
}

const storeListeners = new Set<() => void>();

/** Called after every store write in THIS process (the API refreshes its needs-you cache). */
export function onLeaderStoreChange(fn: () => void): () => void {
  storeListeners.add(fn);
  return () => storeListeners.delete(fn);
}

function archiveSuffix(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
}

/**
 * The store a read-modify-write may start from — NEVER defaults over a real
 * file (review 310 d3/d7):
 *   - transient read failure → throw; nothing is written, the caller retries;
 *   - over-size legacy file  → a byte-exact archive copy is kept beside it,
 *     then the parsed store is used (the write compacts it under budget);
 *   - garbled file           → renamed aside (actions.unreadable-<ts>.json),
 *     then start empty. The store is a working copy, never an authorization
 *     source (the ledger is): a class-B row lost this way never applies,
 *     which fails closed.
 */
function loadStoreForWrite(): LeaderActionStoreV1 {
  const read = readActionStoreDetailed();
  switch (read.state) {
    case 'ok':
    case 'missing':
      return read.store;
    case 'recovered':
      writePrivateFileAtomic(join(leaderRoot(), `actions.oversize-${archiveSuffix()}.json`), read.raw);
      return read.store;
    case 'unreadable':
      throw new Error(`the Leader action store could not be read (${read.reason}); nothing was written`);
    case 'invalid':
      renameSync(leaderActionsPath(), join(leaderRoot(), `actions.unreadable-${archiveSuffix()}.json`));
      return emptyStore(new Date(0).toISOString());
  }
}

/**
 * Read-modify-write under the store lock. The mutator gets a fresh copy and
 * returns the value to hand back; the store is written only when it returns.
 */
function withActionStore<T>(mutate: (store: LeaderActionStoreV1) => T): T {
  ensurePrivateDirectory(leaderRoot());
  const lock = acquireLocalStoreLock(join(leaderRoot(), '.actions.lock'), 5_000);
  if (!lock) throw new Error('the Leader action store is busy');
  try {
    const store = loadStoreForWrite();
    const out = mutate(store);
    store.updatedAt = new Date().toISOString();
    writeActionStore(store);
    return out;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

function claimIsLive(claim: ActionClaim | null | undefined, nowMs: number): boolean {
  if (!claim) return false;
  const at = Date.parse(claim.at);
  return Number.isFinite(at) && nowMs - at < CLAIM_STALE_MS;
}

interface Claimed {
  stored: StoredLeaderAction;
  token: string;
}

/**
 * Compare-and-set: claim the row for `op` when `accept` holds for its CURRENT
 * stored state and no live claim is on it. Null = someone else owns it or it
 * moved on (vetoed, applied, gone) — the caller does nothing.
 */
function claimAction(
  deps: LeaderApplyDeps,
  actionId: string,
  op: ActionClaim['op'],
  accept: (s: StoredLeaderAction) => boolean,
  opts: { takeStale?: boolean } = {},
): Claimed | null {
  const nowMs = deps.now();
  const token = randomUUID();
  return withActionStore((store) => {
    const s = store.actions.find((x) => x.action.id === actionId);
    if (!s || !accept(s)) return null;
    if (s.claim && (claimIsLive(s.claim, nowMs) || !opts.takeStale)) return null;
    s.claim = { op, token, at: new Date(nowMs).toISOString() };
    return { stored: structuredClone(s), token };
  });
}

/**
 * Settle a claimed row: write `next` only while this claim still owns it.
 * Returns false (and writes nothing) when a veto took the row meanwhile.
 */
function settleClaim(claimed: Claimed, next: StoredLeaderAction): boolean {
  return withActionStore((store) => {
    const index = store.actions.findIndex((x) => x.action.id === next.action.id);
    if (index === -1 || store.actions[index]!.claim?.token !== claimed.token) return false;
    store.actions[index] = { action: next.action, restore: next.restore, claim: null };
    return true;
  });
}

/** Newest first. */
export function listLeaderActions(limit = 100): LeaderAction[] {
  const store = readActionStore();
  return store.actions.slice(-limit).reverse().map((s) => s.action);
}

export function findStoredAction(actionId: string): StoredLeaderAction | null {
  return readActionStore().actions.find((s) => s.action.id === actionId) ?? null;
}

export function dismissedNeedsYouIds(): Set<string> {
  return new Set(readActionStore().dismissed.map((d) => d.id));
}

/** Dismiss a class-C ask or a Leader question from Needs-you. Idempotent. */
export function dismissNeedsYouItem(itemId: string, nowIso = new Date().toISOString()): void {
  withActionStore((store) => {
    if (!store.dismissed.some((d) => d.id === itemId)) store.dismissed.push({ id: itemId, at: nowIso });
  });
}

// ---------------------------------------------------------------------------
// Goals I/O (exact bytes)
// ---------------------------------------------------------------------------

const MAX_GOAL_BYTES = 256 * 1024;
const GOAL_ID_RE = /^[\w.-]{1,200}$/;

function goalFile(goalId: string): string {
  if (!GOAL_ID_RE.test(goalId)) throw new Error('invalid goal id');
  return join(goalsDir(), `${goalId}.json`);
}

/**
 * WHY this path is computed here: goals/store.ts keeps its per-goal lock path
 * private, and a byte-exact restore cannot go through saveGoal (which always
 * bumps updatedAt). Taking the SAME lock keeps the restore from racing a
 * conductor claim; test/leader-apply-310b.test.ts proves the two paths agree
 * by holding this lock and watching saveGoal wait on it.
 */
export function goalLockPathFor(goalId: string): string {
  return join(goalsDir(), `.${createHash('sha256').update(goalId).digest('hex')}.lock`);
}

function readGoalRaw(goalId: string): string | null {
  try {
    const text = readFileSync(goalFile(goalId), 'utf8');
    return text.length > MAX_GOAL_BYTES ? null : text;
  } catch {
    return null;
  }
}

/**
 * One goal's entry in a `restore-goals` inverse: the digest of the prior bytes
 * and the prior status — never the bytes themselves, which live only in the
 * local restore snapshot (the inverse goes on the 64 KB-per-line ledger).
 */
function goalInverseEntry(goalId: string, priorBytes: string): { goalId: string; record: null; recordSha256: string; priorStatus?: GoalStatus } {
  let priorStatus: GoalStatus | undefined;
  try { priorStatus = (JSON.parse(priorBytes) as Goal).status; } catch { /* unknown: a veto then leaves the status alone */ }
  return { goalId, record: null, recordSha256: sha256(priorBytes), ...(priorStatus ? { priorStatus } : {}) };
}

function rolledStatus(goal: Goal): GoalStatus {
  if (goal.milestones.length === 0) return 'planning';
  const live = goal.milestones.filter((m) => m.status !== 'skipped');
  if (live.length > 0 && live.every((m) => m.status === 'done')) return 'done';
  return 'active';
}

/** Write exact goal bytes under the goal's store lock; only when the file still hashes to `expectSha`. */
function restoreGoalBytes(goalId: string, bytes: string, expectSha: string | null): boolean {
  const lock = acquireLocalStoreLock(goalLockPathFor(goalId), 2_000);
  if (!lock) return false;
  try {
    const current = readGoalRaw(goalId);
    if (expectSha !== null && (current === null || sha256(current) !== expectSha)) return false;
    const target = goalFile(goalId);
    const tmp = `${target}.leader-restore-${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    return true;
  } catch {
    return false;
  } finally {
    releaseLocalStoreLock(lock);
  }
}

// ---------------------------------------------------------------------------
// Dependencies (every side effect goes through here — tests inject fakes)
// ---------------------------------------------------------------------------

export interface LeaderGoalsPort {
  load(goalId: string): Goal | null;
  save(goal: Goal, nowIso: string): boolean;
  list(): { goals: Goal[]; complete: boolean };
  createIfAbsent(objective: string, project: string | null): { status: 'created' | 'exists' | 'failed'; goal: Goal };
  enrolledRepos(): string[] | null;
}

export interface LeaderBudgetPort {
  path(): string;
  load(): BudgetPolicy;
  setMode(mode: BudgetMode): BudgetPolicy;
  /** A9's serialization of a stored policy (what updateBudgetPolicy writes). */
  serialize(policy: BudgetPolicy): string;
  sanitize(raw: unknown): BudgetPolicy;
}

/** harness-registry `recordHypotheses` result: `already recorded` is a refusal reason too. */
export interface LeaderHypothesisRecordResult {
  accepted: string[];
  refused: { id: string | null; reason: string }[];
}

export interface LeaderApplyDeps {
  now(): number;
  standingPolicy(): EffectivePolicy | null;
  appendLedger<K extends LedgerEventKind>(input: LedgerAppendInput<K>): LedgerAppendResult<K>;
  readLedger(opts?: LedgerReadOptions): Promise<LedgerReadResult>;
  setRepoHold(req: SetRepoHoldRequest): RepoHoldChange | Promise<RepoHoldChange>;
  enqueueTask(input: FleetTaskInput): EnqueueTaskResult | Promise<EnqueueTaskResult>;
  cancelTask(req: CancelTaskRequest): CancelTaskResult | Promise<CancelTaskResult>;
  closeFleetPr(req: FleetPrRequest): Promise<FleetPrResult>;
  reopenFleetPr(req: FleetPrRequest): Promise<FleetPrResult>;
  /**
   * U9's harness registry (learn/harness-registry.ts): a memo's hypotheses are
   * registered as OPEN there (the Growth surface lists them), and
   * `experiment.start` starts the registry's validated copy — never the
   * model-authored text straight from the memo file.
   */
  recordHypotheses(hypotheses: readonly HarnessHypothesis[]): LeaderHypothesisRecordResult | Promise<LeaderHypothesisRecordResult>;
  findHypothesis(id: string): HarnessHypothesis | null | Promise<HarnessHypothesis | null>;
  startExperiment(req: StartExperimentRequest): StartExperimentResult | Promise<StartExperimentResult>;
  cancelExperiment(req: CancelExperimentRequest): CancelExperimentResult | Promise<CancelExperimentResult>;
  activeHarness(): HarnessVersion | null | Promise<HarnessVersion | null>;
  adoptHarness(req: AdoptHarnessRequest): HarnessChangeResult | Promise<HarnessChangeResult>;
  rollbackHarness(req: RollbackHarnessRequest): HarnessChangeResult | Promise<HarnessChangeResult>;
  /** Codex lanes may be enabled only after the Codex windows reset. null = unknown (fails closed). */
  codexReadiness(): { ready: boolean | null; resetsAt: string | null };
  goals: LeaderGoalsPort;
  budget: LeaderBudgetPort;
  addPlaybookDelta(text: string): void;
  /** Tell Mason a class-B action is waiting (Telegram / iMessage via comms). Best-effort. */
  notify(action: LeaderAction): void;
}

let enrolledCache: string[] | null = null;

/**
 * The production deps. Heavy cross-unit modules are imported here, lazily,
 * so importing this file (the router does) stays cheap. Call
 * `loadDefaultLeaderDeps()` once before using them.
 */
export async function loadDefaultLeaderDeps(): Promise<LeaderApplyDeps> {
  const [ledger, effective, quarantine, taskSource, hostMerge, experiments, registry, goalsStore, budgetStore, budgetPolicy, playbook, sandboxPolicy] =
    await Promise.all([
      import('../authority/ledger.js'),
      import('../authority/effective-config.js'),
      import('../fleet/quarantine.js'),
      import('../fleet/task-source.js'),
      import('../fleet/host-merge.js'),
      import('../learn/experiments.js'),
      import('../learn/harness-registry.js'),
      import('../goals/store.js'),
      import('../routing/budget-store.js'),
      import('../routing/policy.js'),
      import('./playbook.js'),
      import('../sandbox/policy.js'),
    ]);
  try {
    const enrollment = sandboxPolicy.readEnrollmentRegistry();
    enrolledCache = enrollment.state === 'ready' ? [...enrollment.repos] : null;
  } catch {
    enrolledCache = null;
  }
  return {
    now: () => Date.now(),
    standingPolicy: () => effective.currentStandingPolicy(),
    appendLedger: (input) => ledger.appendLedger(input),
    readLedger: (opts) => ledger.readLedger(opts),
    setRepoHold: (req) => quarantine.setRepoHold(req),
    enqueueTask: (input) => taskSource.enqueueTask(input),
    cancelTask: (req) => taskSource.cancelTask(req),
    closeFleetPr: (req) => hostMerge.closeFleetPr(req),
    reopenFleetPr: (req) => hostMerge.reopenFleetPr(req),
    recordHypotheses: (hypotheses) => registry.recordHypotheses(hypotheses),
    findHypothesis: (id) => registry.findHypothesis(id),
    startExperiment: (req) => experiments.startExperiment(req),
    cancelExperiment: (req) => experiments.cancelExperiment(req),
    activeHarness: () => registry.activeHarness(),
    adoptHarness: (req) => registry.adoptHarness(req),
    rollbackHarness: (req) => registry.rollbackHarness(req),
    codexReadiness: () => codexReadinessFromSnapshot(budgetStore.readCapacitySnapshot()?.seats ?? null, Date.now()),
    goals: {
      load: (id) => goalsStore.loadGoal(id),
      save: (goal, nowIso) => goalsStore.saveGoal(goal, { now: nowIso }),
      list: () => {
        const read = goalsStore.listGoalsDetailed();
        return { goals: read.goals, complete: read.complete || read.sourceState === 'missing' };
      },
      createIfAbsent: (objective, project) => goalsStore.createGoalIfAbsent(objective, { project }),
      enrolledRepos: () => enrolledCache,
    },
    budget: {
      path: () => budgetStore.budgetPolicyPath(),
      load: () => budgetStore.loadBudgetPolicy(),
      setMode: (mode) => budgetStore.updateBudgetPolicy({ mode }),
      serialize: (policy) => `${JSON.stringify(policy, null, 2)}\n`,
      sanitize: (raw) => budgetPolicy.sanitizeBudgetPolicy(raw),
    },
    addPlaybookDelta: (text) => playbook.addDelta('strategy', text),
    notify: (action) => {
      void import('../comms/requests.js').then((comms) => {
        comms.postRequest({
          kind: 'leader-veto',
          type: 'question',
          text: `Leader will apply at ${action.applyAfter ?? '?'}: ${action.summary}. Reply 1 to veto.`,
          options: ['Veto', 'Let it apply'],
          meta: { actionId: action.id },
        });
      }).catch(() => { /* Needs-you in Verse still shows it */ });
    },
  };
}

/** Same freshness bar as A9's headroom (HEADROOM_READING_MAX_AGE_MS). */
const CODEX_READING_MAX_AGE_MS = 15 * 60_000;

/**
 * Codex lanes may be enabled only after the Codex windows reset (addendum
 * §10). Ready = at least one codex seat has every window readable, not
 * flagged, and below 100%. Unknown readings are NOT ready (fail closed).
 */
export function codexReadinessFromSnapshot(
  seats: readonly {
    engine: string;
    /** When the windows were read; a missing or stale reading is unknown, not "reset". */
    observedAt?: string | null;
    windows: { usedPercent: number | null; resetsAt: string | null; limitReached: boolean }[];
  }[] | null,
  nowMs: number,
  maxAgeMs = CODEX_READING_MAX_AGE_MS,
): { ready: boolean | null; resetsAt: string | null } {
  if (!seats) return { ready: null, resetsAt: null };
  const codex = seats.filter((s) => s.engine === 'codex');
  if (codex.length === 0) return { ready: null, resetsAt: null };
  let earliest: number | null = null;
  for (const seat of codex) {
    if (seat.windows.length === 0) continue;
    if (seat.observedAt !== undefined) {
      const observed = seat.observedAt ? Date.parse(seat.observedAt) : NaN;
      if (!Number.isFinite(observed) || nowMs - observed > maxAgeMs) continue;
    }
    let open = true;
    for (const w of seat.windows) {
      const spent = w.limitReached || (w.usedPercent !== null && w.usedPercent >= 100);
      if (w.usedPercent === null && !w.limitReached) open = false;
      if (spent) {
        const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        if (Number.isFinite(reset) && reset <= nowMs) continue; // the window has reset since the reading
        open = false;
        if (Number.isFinite(reset) && (earliest === null || reset < earliest)) earliest = reset;
      }
    }
    if (open) return { ready: true, resetsAt: null };
  }
  return { ready: false, resetsAt: earliest === null ? null : new Date(earliest).toISOString() };
}

// ---------------------------------------------------------------------------
// The pure policy check
// ---------------------------------------------------------------------------

export interface LeaderPolicyContext {
  nowMs: number;
  /** currentStandingPolicy(); null = no standing authority (dry run). */
  policy: EffectivePolicy | null;
  budgetMode: BudgetMode;
  directives: LeaderDirectivesV1 | null;
  codex: { ready: boolean | null; resetsAt: string | null };
  /** Goals with status active or planning; null = the goal store could not be read completely (fails closed). */
  openGoalCount: number | null;
  /** goal.create actions applied or scheduled in the last 24 h. */
  goalCreatesLast24h: number;
  /** Ids of hypotheses this action's memo carries. */
  hypothesisIds: readonly string[];
}

export interface LeaderClassification {
  class: LeaderActionClass;
  /** `refused` = the Leader's own limits or an invalid request (nothing happens, nothing escalates). */
  verdict: 'ok' | 'refused';
  reason: string | null;
  /** Raises spend (budget toward all-in, more lanes) — the quiet-hours rule applies. */
  spendRaising: boolean;
}

/** Dry run = the Leader may compute but not act (no grant, propose switch, shadow stage). */
export function isLeaderDryRun(policy: EffectivePolicy | null): boolean {
  return policy === null || policy.switch !== 'autonomous' || policy.leader.classes.length === 0;
}

function ok(cls: LeaderActionClass, spendRaising = false): LeaderClassification {
  return { class: cls, verdict: 'ok', reason: null, spendRaising };
}

function refuse(cls: LeaderActionClass, reason: string): LeaderClassification {
  return { class: cls, verdict: 'refused', reason, spendRaising: false };
}

function escalate(reason: string, spendRaising = false): LeaderClassification {
  return { class: 'C', verdict: 'ok', reason, spendRaising };
}

/**
 * Class from kind AND params (SPEC-310B §4, leader-types.ts). PURE: no clock,
 * no I/O — everything it needs is in `ctx`, so the same inputs always give
 * the same class, and the check can be re-run verbatim when a class-B window
 * closes.
 */
export function classifyLeaderAction(draft: AnyLeaderActionDraft, ctx: LeaderPolicyContext): LeaderClassification {
  const policy = ctx.policy;
  switch (draft.kind) {
    case 'escalate':
      return escalate('The Leader asked Mason directly.');
    case 'goal.focus':
    case 'goal.pause':
    case 'goal.reorder':
    case 'goal.archive':
    case 'standard.add':
    case 'router.tune':
    case 'repo.pause':
    case 'repo.resume':
    case 'pr.close':
      return ok('A');
    case 'experiment.start': {
      const params = draft.params as LeaderActionParamsMap['experiment.start'];
      return ctx.hypothesisIds.includes(params.hypothesisId)
        ? ok('A')
        : refuse('A', 'The experiment names a hypothesis this memo does not carry.');
    }
    case 'work.dispatch': {
      const params = draft.params as LeaderActionParamsMap['work.dispatch'];
      if (policy && !policy.repos.some((r) => r.nameWithOwner === params.task.repo)) {
        return escalate(`${params.task.repo} is not in the grant's current stage.`);
      }
      return ok('A');
    }
    case 'goal.create': {
      if (ctx.openGoalCount === null) return refuse('B', 'The goal list could not be read completely, so the active-goal limit cannot be checked.');
      if (ctx.openGoalCount >= LEADER_LIMITS.maxActiveGoals) {
        return refuse('B', `${ctx.openGoalCount} goals are already open; at most ${LEADER_LIMITS.maxActiveGoals} may be active — finish or prune first.`);
      }
      if (ctx.goalCreatesLast24h >= LEADER_LIMITS.maxNewGoalsPerDay) {
        return refuse('B', `The Leader already created ${ctx.goalCreatesLast24h} goals in the last 24 hours (limit ${LEADER_LIMITS.maxNewGoalsPerDay}).`);
      }
      return ok('B');
    }
    case 'budget.mode': {
      const to = (draft.params as LeaderActionParamsMap['budget.mode']).to;
      const delta = BUDGET_RANK[to] - BUDGET_RANK[ctx.budgetMode];
      if (delta === 0) return refuse('A', `The budget is already ${to}.`);
      if (delta < 0) return ok('A'); // toward reserve: lowering is always class A
      if (!policy || BUDGET_RANK[to] > BUDGET_RANK[policy.spend.maxMode]) {
        return escalate(`Moving to ${to} is above the grant's budget ceiling (${policy?.spend.maxMode ?? 'no grant'}).`, true);
      }
      return ok('B', true);
    }
    case 'lanes.grok': {
      const slots = (draft.params as LeaderActionParamsMap['lanes.grok']).slots;
      const current = currentGrokLanes(ctx.directives);
      if (slots === current) return refuse('A', `Grok already runs ${current} lanes.`);
      if (slots < current) return ok('A');
      if (policy && !policy.engines.includes('grok-cli')) return escalate('The grant does not list grok-cli.', true);
      return slots <= LEADER_LIMITS.grokLanes.maxClassA ? ok('A', true) : ok('B', true);
    }
    case 'lanes.codex': {
      const enabled = (draft.params as LeaderActionParamsMap['lanes.codex']).enabled;
      const current = ctx.directives?.codexEnabled === true;
      if (enabled === current) return refuse('A', enabled ? 'Codex lanes are already on.' : 'Codex lanes are already off.');
      if (!enabled) return ok('A');
      if (!policy || !policy.engines.includes('codex')) return escalate('The grant does not list codex.', true);
      if (ctx.codex.ready !== true) {
        return refuse('B', ctx.codex.resetsAt
          ? `Codex usage has not reset yet (resets ${ctx.codex.resetsAt}).`
          : 'Codex usage is unknown or spent; lanes stay off until a window resets.');
      }
      return ok('B', true);
    }
    case 'harness.adopt':
      return ok('B');
    default:
      return refuse('C', 'Unknown action kind.');
  }
}

/**
 * When a class-B action applies: createdAt + veto window, pushed to the end of
 * local quiet hours when it raises spend, would otherwise land inside them,
 * and the budget is not all-in (addendum §6). Local time is the process's
 * timezone — the daemon runs as Mason on his Mac.
 */
export function classBApplyAfter(
  createdMs: number,
  vetoMinutes: number,
  spendRaising: boolean,
  budgetMode: BudgetMode,
): { applyAfterMs: number; deferred: boolean } {
  const minutes = Math.min(24 * 60, Math.max(LEADER_LIMITS.defaultVetoMinutes, Math.round(vetoMinutes)));
  const end = createdMs + minutes * 60_000;
  if (!spendRaising || budgetMode === 'all-in') return { applyAfterMs: end, deferred: false };
  const local = new Date(end);
  const hour = local.getHours();
  const { startHour, endHour } = LEADER_LIMITS.quietHours;
  if (hour < startHour || hour >= endHour) return { applyAfterMs: end, deferred: false };
  const wake = new Date(local.getFullYear(), local.getMonth(), local.getDate(), endHour, 0, 0, 0).getTime();
  return { applyAfterMs: Math.max(end, wake), deferred: wake > end };
}

export interface PlannedActionMeta {
  id: string;
  memoId: string;
  createdAtMs: number;
}

/**
 * Plan one action: class, status and window. Pure over `ctx`.
 *   dry run         → refused ("dry run: …") — or escalated for class C;
 *   class not granted in the current stage → escalated (class C);
 *   Leader limit    → refused;
 *   A               → scheduled with applyAfter = createdAt (applied at once);
 *   B               → scheduled with the veto window;
 *   C               → escalated.
 */
export function planLeaderAction(draft: AnyLeaderActionDraft, meta: PlannedActionMeta, ctx: LeaderPolicyContext): LeaderAction {
  const createdAt = new Date(meta.createdAtMs).toISOString();
  const base = {
    v: 1 as const,
    id: meta.id,
    memoId: meta.memoId,
    kind: draft.kind,
    params: draft.params,
    summary: draft.summary,
    why: draft.why,
    createdAt,
    appliedAt: null,
    vetoedAt: null,
    vetoNote: null,
    inverse: null,
  };
  const c = classifyLeaderAction(draft, ctx);
  const policy = ctx.policy;
  const build = (cls: LeaderActionClass, status: LeaderAction['status'], reason: string | null, applyAfter: string | null, deferred = false): LeaderAction =>
    ({ ...base, class: cls, status, statusReason: reason, applyAfter, deferredForQuietHours: deferred }) as LeaderAction;

  if (c.verdict === 'refused') return build(c.class, 'refused', c.reason, null);
  if (c.class === 'C') return build('C', 'escalated', c.reason, null);
  if (isLeaderDryRun(policy)) {
    const why = policy === null
      ? 'dry run: no standing grant is in force, so the Leader only proposes.'
      : policy.switch !== 'autonomous'
        ? 'dry run: the autonomy switch is on Propose, so the Leader only proposes.'
        : `dry run: stage ${policy.rollout.stageId} does not let the Leader act yet.`;
    return build(c.class, 'refused', why, null);
  }
  if (!policy!.leader.classes.includes(c.class)) {
    return build('C', 'escalated', `Class ${c.class} is not granted in stage ${policy!.rollout.stageId}; Mason decides.`, null);
  }
  if (c.class === 'A') return build('A', 'scheduled', null, createdAt);
  const window = classBApplyAfter(meta.createdAtMs, policy!.leader.vetoMinutes, c.spendRaising, ctx.budgetMode);
  return build('B', 'scheduled', null, new Date(window.applyAfterMs).toISOString(), window.deferred);
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

function actionRepo(action: LeaderAction): string | null {
  const p = action.params as unknown as Record<string, unknown>;
  if (typeof p['repo'] === 'string') return p['repo'];
  const task = p['task'] as { repo?: unknown } | undefined;
  if (task && typeof task.repo === 'string') return task.repo;
  return null;
}

function ledgerAction(deps: LeaderApplyDeps, action: LeaderAction): { ok: true } | { ok: false; reason: string } {
  try {
    const res = deps.appendLedger({
      kind: 'leader:action',
      // Never goal bytes on the ledger (d5) — also for rows stored before 3.10.1.
      data: action.inverse && action.inverse.op === 'restore-goals' ? { ...action, inverse: projectInverse(action.inverse) } as LeaderAction : action,
      actor: 'leader',
      grantId: deps.standingPolicy()?.grantId ?? null,
      repo: actionRepo(action),
    });
    return res.ok ? { ok: true } : { ok: false, reason: res.reason };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'ledger append failed' };
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().filter((k) => rec[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`).join(',')}}`;
}

/** The latest ledger row for `actionId` with `status`, or null (or 'unavailable'). */
async function ledgerRowFor(
  deps: LeaderApplyDeps,
  actionId: string,
  status: LeaderAction['status'],
): Promise<LeaderAction | null | 'unavailable'> {
  let read: LedgerReadResult;
  try {
    read = await deps.readLedger({ kinds: ['leader:action'] });
  } catch {
    return 'unavailable';
  }
  if (read.chain === 'broken') return 'unavailable';
  for (let i = read.entries.length - 1; i >= 0; i -= 1) {
    const entry = read.entries[i]!;
    if (entry.kind !== 'leader:action') continue;
    const data = entry.data;
    if (data.id === actionId && data.status === status) return data;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type ApplyOutcome =
  | { status: 'applied'; inverse: LeaderInverse; restore: RestoreFile[]; detail: string | null }
  | { status: 'refused' | 'failed'; reason: string };

async function applyDirectivesChange(
  deps: LeaderApplyDeps,
  mutate: (d: LeaderDirectivesV1) => LeaderDirectivesV1,
): Promise<ApplyOutcome> {
  const nowIso = new Date(deps.now()).toISOString();
  const beforeBytes = readRawFile(leaderDirectivesPath(), MAX_DIRECTIVES_BYTES);
  const before = readLeaderDirectives();
  const next = mutate({ ...baseDirectives(nowIso), updatedAt: nowIso });
  const written = writeDirectives(next);
  return {
    status: 'applied',
    inverse: { op: 'restore-directives', before },
    restore: [{ target: 'directives', existed: beforeBytes !== null, before: beforeBytes, afterSha: sha256(written) }],
    detail: null,
  };
}

async function applyGoalStatus(
  deps: LeaderApplyDeps,
  goalId: string,
  decide: (goal: Goal) => { status: GoalStatus } | { refuse: string },
): Promise<ApplyOutcome> {
  const goal = deps.goals.load(goalId);
  if (!goal) return { status: 'refused', reason: `Goal ${goalId} does not exist.` };
  const verdict = decide(goal);
  if ('refuse' in verdict) return { status: 'refused', reason: verdict.refuse };
  const beforeBytes = readGoalRaw(goalId);
  if (beforeBytes === null) return { status: 'failed', reason: `Goal ${goalId} could not be read.` };
  goal.status = verdict.status;
  const nowIso = new Date(deps.now()).toISOString();
  if (!deps.goals.save(goal, nowIso)) return { status: 'failed', reason: `Goal ${goalId} changed underneath the Leader; nothing was written.` };
  const after = readGoalRaw(goalId);
  return {
    status: 'applied',
    // Digest + prior status only; the bytes stay in the local snapshot (d5).
    inverse: { op: 'restore-goals', before: [goalInverseEntry(goalId, beforeBytes)] },
    restore: [{ target: `goal:${goalId}`, existed: true, before: beforeBytes, afterSha: after === null ? null : sha256(after) }],
    detail: null,
  };
}

function resolveGoalProject(targetRepo: string | null, enrolled: readonly string[] | null): { project: string | null } | { refuse: string } {
  if (targetRepo === null) return { project: null };
  if (!enrolled) return { refuse: 'The enrollment registry could not be read.' };
  const [owner, name] = targetRepo.split('/') as [string, string];
  const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const matches = enrolled.filter((p) => base(p) === name || base(p) === `${owner}__${name}`);
  if (matches.length === 1) return { project: matches[0]! };
  return { refuse: matches.length === 0 ? `${targetRepo} is not enrolled.` : `${targetRepo} matches more than one enrolled checkout.` };
}

async function executeAction(deps: LeaderApplyDeps, action: LeaderAction): Promise<ApplyOutcome> {
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  switch (action.kind) {
    case 'goal.focus':
      return applyGoalStatus(deps, action.params.goalId, (goal) => {
        if (goal.status === 'archived' || goal.status === 'done') return { refuse: `Goal ${goal.id} is ${goal.status}.` };
        // Saving bumps updatedAt, which is what the goal list (newest first) and
        // therefore the focus snapshot rank by: the focused goal moves to the top.
        return { status: goal.status === 'paused' ? rolledStatus(goal) : goal.status };
      });
    case 'goal.pause':
      return applyGoalStatus(deps, action.params.goalId, (goal) =>
        goal.status === 'paused' || goal.status === 'archived' || goal.status === 'done'
          ? { refuse: `Goal ${goal.id} is already ${goal.status}.` }
          : { status: 'paused' });
    case 'goal.archive':
      return applyGoalStatus(deps, action.params.goalId, (goal) =>
        goal.status === 'archived' ? { refuse: `Goal ${goal.id} is already archived.` } : { status: 'archived' });
    case 'goal.reorder': {
      const ids = action.params.goalIds;
      const goals = ids.map((id) => deps.goals.load(id));
      const missing = ids.filter((_, i) => goals[i] === null);
      if (missing.length > 0) return { status: 'refused', reason: `Unknown goals: ${missing.join(', ')}.` };
      const befores = ids.map((id) => readGoalRaw(id));
      if (befores.some((b) => b === null)) return { status: 'failed', reason: 'A goal could not be read.' };
      // Newest-first listing: save the LAST priority first, so the first one
      // ends up with the newest updatedAt. Explicit, strictly increasing stamps
      // make the order exact even within one millisecond.
      const restore: RestoreFile[] = [];
      for (let i = ids.length - 1; i >= 0; i -= 1) {
        const goal = goals[i]!;
        const stampIso = new Date(nowMs + (ids.length - 1 - i)).toISOString();
        if (!deps.goals.save(goal, stampIso)) {
          return { status: 'failed', reason: `Goal ${goal.id} changed underneath the Leader; the reorder stopped part-way (earlier goals were saved).` };
        }
      }
      for (let i = 0; i < ids.length; i += 1) {
        const after = readGoalRaw(ids[i]!);
        restore.push({ target: `goal:${ids[i]!}`, existed: true, before: befores[i]!, afterSha: after === null ? null : sha256(after) });
      }
      return {
        status: 'applied',
        // Ten whole goal records overflowed the 64 KB ledger line and every
        // reorder was undone at once (review 310 d5): ids + digests only.
        inverse: { op: 'restore-goals', before: ids.map((id, i) => goalInverseEntry(id, befores[i]!)) },
        restore,
        detail: null,
      };
    }
    case 'goal.create': {
      const listed = deps.goals.list();
      if (!listed.complete) return { status: 'refused', reason: 'The goal list could not be read completely.' };
      const open = listed.goals.filter((g) => g.status === 'active' || g.status === 'planning').length;
      if (open >= LEADER_LIMITS.maxActiveGoals) {
        return { status: 'refused', reason: `${open} goals are already open (limit ${LEADER_LIMITS.maxActiveGoals}).` };
      }
      const target = resolveGoalProject(action.params.goal.targetRepo, deps.goals.enrolledRepos());
      if ('refuse' in target) return { status: 'refused', reason: target.refuse };
      const created = deps.goals.createIfAbsent(action.params.goal.objective, target.project);
      if (created.status === 'exists') return { status: 'refused', reason: 'A goal with this objective already exists.' };
      if (created.status === 'failed') return { status: 'failed', reason: 'The goal store did not accept the new goal.' };
      return { status: 'applied', inverse: { op: 'archive-goal', goalId: created.goal.id }, restore: [], detail: null };
    }
    case 'work.dispatch': {
      const task = action.params.task;
      const res = await deps.enqueueTask({
        ...task,
        source: 'leader',
        requestedBy: 'leader',
        dedupeKey: `leader:${task.repo}:${sha256(task.title.toLowerCase()).slice(0, 16)}`,
      });
      if (!res.ok) return { status: 'failed', reason: res.reason };
      if (res.deduped) return { status: 'refused', reason: 'An identical task is already queued.' };
      return { status: 'applied', inverse: { op: 'cancel-task', taskId: res.task.id }, restore: [], detail: null };
    }
    case 'standard.add': {
      const standards = readStandards();
      const rule = action.params.rule;
      if (standards.some((s) => s.retiredAt === null && s.rule.toLowerCase() === rule.toLowerCase())) {
        return { status: 'refused', reason: 'That standard is already in force.' };
      }
      const standard: LeaderStandard = {
        id: `std-${sha256(`${action.id}\0${rule}`).slice(0, 12)}`,
        rule,
        appliesTo: action.params.appliesTo,
        evidence: action.params.evidence,
        source: 'leader',
        addedAt: nowIso,
        retiredAt: null,
      };
      writeStandards([...standards, standard]);
      return { status: 'applied', inverse: { op: 'retire-standard', standardId: standard.id }, restore: [], detail: null };
    }
    case 'router.tune': {
      const tuning = action.params.tuning;
      return applyDirectivesChange(deps, (d) => ({ ...d, routerTuning: { ...(d.routerTuning ?? {}), ...tuning } }));
    }
    case 'lanes.grok': {
      const slots = action.params.slots;
      return applyDirectivesChange(deps, (d) => ({ ...d, grokLanes: slots }));
    }
    case 'lanes.codex': {
      const enabled = action.params.enabled;
      return applyDirectivesChange(deps, (d) => ({ ...d, codexEnabled: enabled }));
    }
    case 'experiment.start': {
      // The memo names the hypothesis; the harness registry supplies what is
      // tested (U9: findHypothesis + startExperiment). The registry copy passed
      // validateHarnessHypothesis when it was recorded, and it must be the
      // SAME claim the memo carries — an id that collides with a different
      // registry hypothesis (an insight's, say) would otherwise start an
      // experiment the memo never proposed.
      const memo = readLeaderMemo(action.memoId);
      const carried: HarnessHypothesis | undefined = memo?.hypotheses.find((h) => h.id === action.params.hypothesisId);
      if (!carried) return { status: 'refused', reason: 'The hypothesis is not in the memo on disk.' };
      const hypothesis = await deps.findHypothesis(action.params.hypothesisId);
      if (!hypothesis) return { status: 'refused', reason: 'The harness registry has no record of this hypothesis (it was refused when recorded, or never recorded).' };
      if (hypothesis.target !== carried.target || canonical(hypothesis.patch) !== canonical(carried.patch)) {
        return { status: 'refused', reason: 'The harness registry holds a different hypothesis under this id.' };
      }
      const res = await deps.startExperiment({ hypothesis, requestedBy: 'leader' });
      if (!res.ok) return { status: 'refused', reason: res.reason };
      return { status: 'applied', inverse: { op: 'cancel-experiment', experimentId: res.experimentId }, restore: [], detail: null };
    }
    case 'repo.pause': {
      const change = await deps.setRepoHold({
        repo: action.params.repo,
        kind: 'leader-pause',
        hold: { reason: action.params.reason, until: action.params.until },
        actor: 'leader',
      });
      if (!change.ok) return { status: 'refused', reason: change.reason ?? 'The hold was refused.' };
      return { status: 'applied', inverse: { op: 'restore-repo-hold', repo: action.params.repo, before: change.before }, restore: [], detail: null };
    }
    case 'repo.resume': {
      const change = await deps.setRepoHold({ repo: action.params.repo, kind: 'leader-pause', hold: null, actor: 'leader' });
      if (!change.ok) return { status: 'refused', reason: change.reason ?? 'The resume was refused.' };
      if (change.before === null) return { status: 'refused', reason: `${action.params.repo} had no Leader pause.` };
      return { status: 'applied', inverse: { op: 'restore-repo-hold', repo: action.params.repo, before: change.before }, restore: [], detail: null };
    }
    case 'pr.close': {
      const res = await deps.closeFleetPr({ repo: action.params.repo, number: action.params.number, reason: action.params.reason, actor: 'leader' });
      if (!res.ok) return { status: 'refused', reason: res.reason };
      return { status: 'applied', inverse: { op: 'reopen-pr', repo: action.params.repo, number: action.params.number }, restore: [], detail: null };
    }
    case 'budget.mode': {
      const path = deps.budget.path();
      const beforeBytes = readRawFile(path, 64 * 1024);
      const before = deps.budget.load();
      if (before.mode === action.params.to) return { status: 'refused', reason: `The budget is already ${before.mode}.` };
      deps.budget.setMode(action.params.to);
      const after = readRawFile(path, 64 * 1024);
      return {
        status: 'applied',
        inverse: { op: 'restore-budget', before },
        restore: [{ target: 'budget', existed: beforeBytes !== null, before: beforeBytes, afterSha: after === null ? null : sha256(after) }],
        detail: null,
      };
    }
    case 'harness.adopt': {
      const res = await deps.adoptHarness({ versionId: action.params.versionId, experimentId: action.params.experimentId, actor: 'leader' });
      if (!res.ok) return { status: 'refused', reason: res.reason };
      return { status: 'applied', inverse: { op: 'rollback-harness', toVersionId: res.before?.id ?? null }, restore: [], detail: null };
    }
    case 'escalate':
      return { status: 'refused', reason: 'Class C actions are never applied.' };
    default:
      return { status: 'refused', reason: 'Unknown action kind.' };
  }
}

function replaceStored(store: LeaderActionStoreV1, next: StoredLeaderAction): void {
  const index = store.actions.findIndex((s) => s.action.id === next.action.id);
  if (index === -1) store.actions.push(next);
  else store.actions[index] = next;
}

/** The row as stored now (after a lost claim, the caller reports what actually happened). */
function currentAction(actionId: string, fallback: LeaderAction): LeaderAction {
  return findStoredAction(actionId)?.action ?? fallback;
}

/**
 * Settle a claimed scheduled action that did NOT apply (refused / failed):
 * write it only while the claim still owns the row, then record it. A veto
 * that took the row meanwhile stands — its `vetoed` status is not overwritten
 * and no later ledger row contradicts it.
 */
function settleNotApplied(deps: LeaderApplyDeps, claimed: Claimed, next: LeaderAction): LeaderAction {
  if (!settleClaim(claimed, { action: next, restore: [] })) return currentAction(next.id, next);
  ledgerAction(deps, next);
  return next;
}

/**
 * Apply one scheduled action the caller has CLAIMED (`claimAction(…, 'apply')`).
 * Returns the updated action — or, when a veto took the row while the change
 * was being made, the vetoed action after the change has been undone.
 */
async function applyClaimed(deps: LeaderApplyDeps, claimed: Claimed, opts: { approvedVia?: string } = {}): Promise<LeaderAction> {
  const action = claimed.stored.action;
  let outcome: ApplyOutcome;
  try {
    outcome = await executeAction(deps, action);
  } catch (err) {
    outcome = { status: 'failed', reason: err instanceof Error ? err.message.slice(0, 300) : 'applying threw' };
  }
  if (outcome.status !== 'applied') {
    return settleNotApplied(deps, claimed, { ...action, status: outcome.status, statusReason: outcome.reason } as LeaderAction);
  }
  // An early apply Mason approved says so on its `applied` row (the ledger's record of why it did not wait).
  const statusReason = opts.approvedVia
    ? [`Approved by Mason (${opts.approvedVia}) before its veto window closed.`, outcome.detail].filter((t): t is string => typeof t === 'string' && t.length > 0).join(' ')
    : outcome.detail;
  let next = { ...action, status: 'applied', statusReason, appliedAt: new Date(deps.now()).toISOString(), inverse: outcome.inverse } as LeaderAction;
  let restore = outcome.restore;
  const row = ledgerAction(deps, next);
  if (!row.ok) {
    // The change is made but could not be recorded: undo it at once. An
    // authority change that is not on the ledger must not stand.
    await runInverse(deps, { action: next, restore }, outcome.inverse, true);
    next = { ...action, status: 'failed', statusReason: `The ledger did not record the change, so it was undone (${row.reason}).`, inverse: null } as LeaderAction;
    restore = [];
    if (!settleClaim(claimed, { action: next, restore })) return currentAction(next.id, next);
    return next;
  }
  if (settleClaim(claimed, { action: next, restore })) return next;
  // A veto took the row while the change was being made (c7). The change is
  // on the ledger as applied; undo it now with the inverse this process just
  // recorded (trusted), and put the veto's outcome on the ledger after it so
  // the ledger's last word for this action is `vetoed`, like the store's.
  const current = currentAction(action.id, next);
  let result: { restored: boolean; detail: string };
  try {
    result = await runInverse(deps, { action: next, restore }, outcome.inverse, true);
  } catch (err) {
    result = { restored: false, detail: `Undoing threw: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}` };
  }
  const vetoed = current.status === 'vetoed';
  const record: LeaderVetoRecord = {
    actionId: action.id,
    memoId: action.memoId,
    note: current.vetoNote,
    inverse: projectInverse(outcome.inverse),
    restored: result.restored,
    detail: `${vetoed ? 'Vetoed while it was being applied' : 'The apply lost its claim'}; the change was undone: ${result.detail}`,
    at: new Date(deps.now()).toISOString(),
  };
  try { deps.appendLedger({ kind: 'leader:vetoed', data: record, actor: vetoed ? 'mason' : 'leader', grantId: deps.standingPolicy()?.grantId ?? null, repo: actionRepo(action) }); } catch { /* best-effort */ }
  const final = vetoed
    ? { ...current, inverse: null } as LeaderAction
    : { ...current, status: 'failed', statusReason: 'Another process settled this action while it was being applied; the change was undone.', inverse: null } as LeaderAction;
  ledgerAction(deps, final);
  return final;
}

/** Claim a scheduled action and apply it; when it is no longer ours to apply (vetoed, already claimed), its current row is returned untouched. */
async function applyScheduled(deps: LeaderApplyDeps, stored: StoredLeaderAction): Promise<LeaderAction> {
  const expected = stored.action;
  const claimed = claimAction(deps, expected.id, 'apply', (s) => s.action.status === 'scheduled' && s.action.applyAfter === expected.applyAfter);
  if (!claimed) return currentAction(expected.id, expected);
  return applyClaimed(deps, claimed);
}

/** Build the policy context from live state (the only impure part of planning). */
export function buildPolicyContext(deps: LeaderApplyDeps, hypothesisIds: readonly string[]): LeaderPolicyContext {
  const nowMs = deps.now();
  let openGoalCount: number | null = null;
  try {
    const listed = deps.goals.list();
    openGoalCount = listed.complete ? listed.goals.filter((g) => g.status === 'active' || g.status === 'planning').length : null;
  } catch {
    openGoalCount = null;
  }
  const dayAgo = nowMs - 86_400_000;
  const read = readActionStoreDetailed();
  // An unreadable store is an UNKNOWN tally, not zero: count it as the daily
  // limit so goal.create fails closed rather than slipping past it.
  const creates = !('store' in read)
    ? LEADER_LIMITS.maxNewGoalsPerDay
    : read.store.actions.filter((s) => s.action.kind === 'goal.create'
      && (s.action.status === 'applied' || s.action.status === 'scheduled')
      && Date.parse(s.action.createdAt) >= dayAgo).length;
  let budgetMode: BudgetMode = 'balanced';
  try {
    budgetMode = deps.budget.load().mode;
  } catch { /* balanced is A9's default */ }
  return {
    nowMs,
    policy: deps.standingPolicy(),
    budgetMode,
    directives: readLeaderDirectives(),
    codex: deps.codexReadiness(),
    openGoalCount,
    goalCreatesLast24h: creates,
    hypothesisIds,
  };
}

/**
 * Plan, record and (for class A) apply a memo's actions. Every planned action
 * gets a ledger row first; if the ledger refuses the row, the action is marked
 * refused and nothing is applied. Class B actions are left scheduled (and Mason
 * is notified); class A actions are applied immediately, in order.
 */
export async function enactLeaderActions(
  deps: LeaderApplyDeps,
  memoId: string,
  drafts: readonly AnyLeaderActionDraft[],
  hypothesisIds: readonly string[],
  opts: { idFor: (index: number) => string },
): Promise<LeaderAction[]> {
  const ctx = buildPolicyContext(deps, hypothesisIds);
  const planned: LeaderAction[] = [];
  let pendingCreates = 0;
  for (let i = 0; i < drafts.length; i += 1) {
    // Goal creates in the same memo count against the daily and active limits.
    const localCtx: LeaderPolicyContext = {
      ...ctx,
      openGoalCount: ctx.openGoalCount === null ? null : ctx.openGoalCount + pendingCreates,
      goalCreatesLast24h: ctx.goalCreatesLast24h + pendingCreates,
    };
    let action = planLeaderAction(drafts[i]!, { id: opts.idFor(i), memoId, createdAtMs: ctx.nowMs }, localCtx);
    if (action.kind === 'goal.create' && action.status === 'scheduled') pendingCreates += 1;
    const row = ledgerAction(deps, action);
    if (!row.ok && action.status === 'scheduled') {
      action = { ...action, status: 'refused', statusReason: `The authority ledger is unavailable, so nothing was applied (${row.reason}).`, applyAfter: null } as LeaderAction;
    }
    planned.push(action);
  }
  withActionStore((store) => {
    for (const action of planned) replaceStored(store, { action, restore: [] });
  });

  const out: LeaderAction[] = [];
  for (const action of planned) {
    if (action.status === 'scheduled' && action.class === 'A') {
      out.push(await applyScheduled(deps, { action, restore: [] }));
    } else {
      if (action.status === 'scheduled' && action.class === 'B') {
        try { deps.notify(action); } catch { /* best-effort */ }
      }
      out.push(action);
    }
  }
  return out;
}

/**
 * Apply every class-B action whose veto window has closed. Each one must be
 * confirmed by its `scheduled` ledger row (same kind, params and window) and
 * must STILL pass the policy check with today's grant — a grant revoked or
 * narrowed during the window stops it.
 */
export async function applyDueLeaderActions(deps: LeaderApplyDeps): Promise<LeaderAction[]> {
  const nowMs = deps.now();
  const out: LeaderAction[] = [];
  const snapshot = readActionStore().actions;
  // A claim whose process died (older than CLAIM_STALE_MS) is settled from the
  // ledger, never re-applied: the change may already have been made.
  for (const s of snapshot) {
    if (s.action.status !== 'scheduled' || s.claim?.op !== 'apply' || claimIsLive(s.claim, nowMs)) continue;
    const settled = await settleInterruptedApply(deps, s);
    if (settled) out.push(settled);
  }
  const due = snapshot.filter((s) =>
    s.action.status === 'scheduled' && s.action.class === 'B' && s.action.applyAfter !== null && Date.parse(s.action.applyAfter) <= nowMs
    && !s.claim);
  for (const snap of due) {
    // Claim FIRST, under the store lock, against the CURRENT row: a veto that
    // landed since the snapshot wins, and a second ticker (daemon + CLI +
    // comms) finds the claim and skips — one apply per action (c7).
    const claimed = claimAction(deps, snap.action.id, 'apply', (s) =>
      s.action.status === 'scheduled' && s.action.class === 'B' && s.action.applyAfter === snap.action.applyAfter);
    if (!claimed) continue;
    const action = claimed.stored.action;
    const refusal = await scheduledApplyRefusal(deps, action);
    if (refusal !== null) {
      out.push(settleNotApplied(deps, claimed, { ...action, status: 'refused', statusReason: refusal } as LeaderAction));
      continue;
    }
    out.push(await applyClaimed(deps, claimed));
  }
  return out;
}

/**
 * The authority checks a scheduled class-B action must pass before it may
 * apply — at the end of its veto window AND when Mason approves it early.
 * Null = it may apply; otherwise the reason it may not:
 *   - its `scheduled` row must be on the ledger with the same kind, class,
 *     window, memo and params (the local store never authorizes anything);
 *   - it must STILL classify as class B under today's grant, with class B
 *     granted and the Leader not in dry run (a grant revoked or narrowed
 *     since stops it).
 */
async function scheduledApplyRefusal(deps: LeaderApplyDeps, action: LeaderAction): Promise<string | null> {
  const row = await ledgerRowFor(deps, action.id, 'scheduled');
  if (row === 'unavailable') return 'The authority ledger could not be read, so the scheduled action was not applied.';
  if (row === null
    || row.kind !== action.kind || row.class !== 'B' || row.applyAfter !== action.applyAfter || row.memoId !== action.memoId
    || canonical(row.params) !== canonical(action.params)) {
    return 'The scheduled action does not match its ledger record, so it was not applied.';
  }
  const memo = readLeaderMemo(action.memoId);
  const ctx = buildPolicyContext(deps, memo?.hypotheses.map((h) => h.id) ?? []);
  // The action itself is already counted in the 24 h create tally — do not count it twice.
  if (action.kind === 'goal.create') ctx.goalCreatesLast24h = Math.max(0, ctx.goalCreatesLast24h - 1);
  const again = classifyLeaderAction(action as unknown as AnyLeaderActionDraft, ctx);
  const granted = !isLeaderDryRun(ctx.policy) && again.verdict === 'ok' && again.class === 'B' && ctx.policy!.leader.classes.includes('B');
  if (!granted) {
    return `The grant changed during the veto window: ${again.reason ?? (isLeaderDryRun(ctx.policy) ? 'the Leader may no longer act' : 'class B is no longer granted')}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Approve (3.14)
// ---------------------------------------------------------------------------

/**
 * - `applied`                — a class-B action Mason approved inside its window
 *                              was applied now (and stays vetoable, like any
 *                              applied action);
 * - `recorded-dry-run`       — the Leader is in dry run: the approval is
 *                              recorded (it feeds the next memo), nothing applied;
 * - `recorded-outside-grant` — a class-C ask: outside the grant, never applied
 *                              from here; the approval is recorded;
 * - `refused`                — the authority checks said no right now (the
 *                              action stays scheduled; its window decides);
 * - `not-pending`            — already applied / vetoed / refused / failed, or
 *                              a class-A action mid-apply.
 */
export type LeaderApprovalOutcome = 'applied' | 'recorded-dry-run' | 'recorded-outside-grant' | 'refused' | 'not-pending';

export interface LeaderApprovalResult {
  ok: boolean;
  /** HTTP-ish: 404 unknown action, 409 nothing to approve / refused now. */
  code: 200 | 404 | 409;
  outcome: LeaderApprovalOutcome | null;
  message: string;
  /** The action as it stands after the approval (null when unknown). */
  action: LeaderAction | null;
}

/**
 * Mason approves a pending Leader action. NEVER BYPASSES AUTHORITY:
 *   - class B inside its veto window → claimed like the window close claims
 *     it, re-checked by `scheduledApplyRefusal` (ledger row + today's grant),
 *     then applied early through the same `applyClaimed` path, its ledger row
 *     saying who approved it. The window is Mason's review; his explicit
 *     approval is that review, and the action stays vetoable afterwards.
 *     If a check fails the action is left scheduled — its window decides.
 *   - dry run (no grant / Propose / shadow stage) → recorded only;
 *   - class C (outside the grant) → recorded only: raising the grant is
 *     Mason's own step (`ashlr authority`), never an approval side effect.
 * Recording the approval (leader-operator.ts) is the caller's job — this
 * module decides and applies; it does not keep operator records.
 */
export async function applyApprovedLeaderAction(
  deps: LeaderApplyDeps,
  actionId: string,
  opts: { via: string },
): Promise<LeaderApprovalResult> {
  const stored = findStoredAction(actionId);
  if (!stored) return { ok: false, code: 404, outcome: null, message: `No Leader action ${actionId}.`, action: null };
  const action = stored.action;
  if (action.status === 'escalated') {
    return {
      ok: true,
      code: 200,
      outcome: 'recorded-outside-grant',
      message: 'Recorded your approval. This is outside the standing grant, so nothing was applied; widen the grant yourself (ashlr authority) if you want the Leader to do it.',
      action,
    };
  }
  if (action.status === 'refused' && typeof action.statusReason === 'string' && action.statusReason.startsWith('dry run:')) {
    return {
      ok: true,
      code: 200,
      outcome: 'recorded-dry-run',
      message: `Recorded your approval. Nothing was applied — ${action.statusReason}`,
      action,
    };
  }
  if (action.status !== 'scheduled' || action.class !== 'B') {
    const why = action.status === 'scheduled' ? 'it is being applied now' : `it is ${action.status}`;
    return { ok: false, code: 409, outcome: 'not-pending', message: `Nothing to approve: ${why}.`, action };
  }
  const claimed = claimAction(deps, actionId, 'apply', (s) =>
    s.action.status === 'scheduled' && s.action.class === 'B' && s.action.applyAfter === action.applyAfter);
  if (!claimed) {
    const current = currentAction(actionId, action);
    return { ok: false, code: 409, outcome: 'not-pending', message: `Nothing to approve: it is ${current.status === 'scheduled' ? 'being applied now' : current.status}.`, action: current };
  }
  const refusal = await scheduledApplyRefusal(deps, claimed.stored.action);
  if (refusal !== null) {
    // Release the claim and leave it scheduled: the window close re-checks it.
    settleClaim(claimed, claimed.stored);
    return { ok: false, code: 409, outcome: 'refused', message: `Not applied: ${refusal}`, action: currentAction(actionId, action) };
  }
  const applied = await applyClaimed(deps, claimed, { approvedVia: opts.via });
  if (applied.status === 'applied') {
    return { ok: true, code: 200, outcome: 'applied', message: `Applied: ${applied.summary}`, action: applied };
  }
  return { ok: false, code: 409, outcome: 'refused', message: `Not applied: ${applied.statusReason ?? applied.status}`, action: applied };
}

/**
 * A scheduled action whose apply claim went stale: the applying process died
 * somewhere between claiming and settling. The ledger says whether the change
 * was recorded as applied; if so the store is brought in line (so Mason can
 * still veto it), otherwise it is marked failed and NOT retried — re-running
 * could apply it twice.
 */
async function settleInterruptedApply(deps: LeaderApplyDeps, stale: StoredLeaderAction): Promise<LeaderAction | null> {
  const claimed = claimAction(deps, stale.action.id, 'apply', (s) => s.action.status === 'scheduled' && s.claim?.op === 'apply', { takeStale: true });
  if (!claimed) return null;
  const applied = await ledgerRowFor(deps, stale.action.id, 'applied');
  if (applied !== 'unavailable' && applied !== null) {
    return settleClaim(claimed, { action: applied, restore: [] }) ? applied : currentAction(applied.id, applied);
  }
  return settleNotApplied(deps, claimed, {
    ...claimed.stored.action,
    status: 'failed',
    statusReason: 'An earlier apply of this action was interrupted before it was recorded; it was not retried. Check the setting it touches.',
  } as LeaderAction);
}

// ---------------------------------------------------------------------------
// Veto
// ---------------------------------------------------------------------------

export interface LeaderVetoResult {
  ok: boolean;
  /** HTTP-ish: 404 unknown action, 409 nothing to veto. */
  code: 200 | 404 | 409;
  message: string;
  records: LeaderVetoRecord[];
}

/** Inverses a veto may run from the local store alone (they can only lower autonomy). */
const LOWERING_ONLY_OPS: ReadonlySet<LeaderInverse['op']> = new Set(['cancel-task', 'retire-standard', 'cancel-experiment', 'archive-goal']);

function directivesNotAbove(restored: LeaderDirectivesV1 | null, current: LeaderDirectivesV1 | null): boolean {
  if (currentGrokLanes(restored) > currentGrokLanes(current)) return false;
  if (restored?.codexEnabled === true && current?.codexEnabled !== true) return false;
  return true;
}

/**
 * Run an inverse. `trusted` = it came from the ledger (or from this very
 * process a moment ago); untrusted inverses may only lower autonomy.
 * Returns whether the prior state was restored EXACTLY, and what happened.
 */
async function runInverse(
  deps: LeaderApplyDeps,
  stored: StoredLeaderAction,
  inverse: LeaderInverse,
  trusted: boolean,
): Promise<{ restored: boolean; detail: string; ran: boolean }> {
  const action = stored.action;
  const restoreFor = (target: string): RestoreFile | undefined => stored.restore.find((r) => r.target === target);
  switch (inverse.op) {
    case 'restore-directives': {
      const current = readLeaderDirectives();
      if (!trusted && !directivesNotAbove(inverse.before, current)) {
        return { restored: false, detail: 'The ledger could not confirm this veto and restoring would raise lanes; left as is.', ran: false };
      }
      const snap = restoreFor('directives');
      const currentBytes = readRawFile(leaderDirectivesPath(), MAX_DIRECTIVES_BYTES);
      if (snap && currentBytes !== null && snap.afterSha === sha256(currentBytes)) {
        if (inverse.before === null) {
          try { unlinkSync(leaderDirectivesPath()); } catch { /* already gone */ }
        } else {
          // The ledger's `before` is authoritative; it serializes to the prior bytes exactly.
          writePrivateFileAtomic(leaderDirectivesPath(), serializeDirectives(inverse.before));
        }
        directivesCache = null;
        return { restored: true, detail: 'Directives restored exactly.', ran: true };
      }
      // Something else changed the file since: put back only what this action set.
      const nowIso = new Date(deps.now()).toISOString();
      const next = { ...baseDirectives(nowIso), updatedAt: nowIso };
      const p = action.params as unknown as Record<string, unknown>;
      if (action.kind === 'lanes.grok' && current?.grokLanes === p['slots']) next.grokLanes = inverse.before?.grokLanes ?? null;
      else if (action.kind === 'lanes.codex' && current?.codexEnabled === p['enabled']) next.codexEnabled = inverse.before?.codexEnabled ?? null;
      else if (action.kind === 'router.tune') next.routerTuning = inverse.before?.routerTuning ?? null;
      else return { restored: false, detail: 'The setting was changed again since; left as is.', ran: false };
      writeDirectives(next);
      return { restored: false, detail: 'Other directives changed since; only this action’s setting was put back.', ran: true };
    }
    case 'restore-budget': {
      const current = deps.budget.load();
      if (!trusted && BUDGET_RANK[inverse.before.mode] > BUDGET_RANK[current.mode]) {
        return { restored: false, detail: 'The ledger could not confirm this veto and restoring would raise the budget; left as is.', ran: false };
      }
      const path = deps.budget.path();
      const snap = restoreFor('budget');
      const currentBytes = readRawFile(path, 64 * 1024);
      if (snap && currentBytes !== null && snap.afterSha === sha256(currentBytes)) {
        if (!snap.existed) {
          try { unlinkSync(path); } catch { /* already gone */ }
          return { restored: true, detail: 'Budget restored exactly (back to defaults).', ran: true };
        }
        // Prefer the snapshot bytes, but only if they ARE the ledger's policy.
        let bytes = deps.budget.serialize(inverse.before);
        if (snap.before !== null) {
          try {
            if (canonical(deps.budget.sanitize(JSON.parse(snap.before))) === canonical(inverse.before)) bytes = snap.before;
          } catch { /* fall back to the canonical serialization */ }
        }
        ensurePrivateDirectory(dirname(path));
        writePrivateFileAtomic(path, bytes);
        return { restored: true, detail: 'Budget restored exactly.', ran: true };
      }
      const to = (action.params as unknown as { to?: BudgetMode }).to;
      if (current.mode === to) {
        deps.budget.setMode(inverse.before.mode);
        return { restored: false, detail: `The budget was edited since; the mode was put back to ${inverse.before.mode}.`, ran: true };
      }
      return { restored: false, detail: 'The budget was changed again since; left as is.', ran: false };
    }
    case 'restore-goals': {
      if (!trusted) return { restored: false, detail: 'The ledger could not confirm this veto; goals were left as they are.', ran: false };
      let exact = true;
      const notes: string[] = [];
      for (const entry of inverse.before) {
        const { goalId } = entry;
        const snap = restoreFor(`goal:${goalId}`);
        // The prior bytes: the inverse's own copy (rows before 3.10.1), else
        // the local snapshot — trusted only when it hashes to the digest the
        // (ledger's) inverse carries, so a tampered actions.json cannot
        // smuggle other bytes into a goal.
        let priorBytes: string | null = entry.record;
        if (priorBytes === null && snap?.before != null && typeof entry.recordSha256 === 'string' && sha256(snap.before) === entry.recordSha256) {
          priorBytes = snap.before;
        }
        if (priorBytes !== null && snap && restoreGoalBytes(goalId, priorBytes, snap.afterSha)) continue;
        exact = false;
        // Changed since (or no snapshot): restore the status only.
        let priorStatus: GoalStatus | null = entry.priorStatus ?? null;
        if (priorStatus === null && priorBytes !== null) {
          try { priorStatus = (JSON.parse(priorBytes) as Goal).status; } catch { priorStatus = null; }
        }
        const goal = deps.goals.load(goalId);
        if (priorStatus && goal && goal.status !== priorStatus) {
          goal.status = priorStatus;
          if (deps.goals.save(goal, new Date(deps.now()).toISOString())) notes.push(`${goalId}: status put back to ${priorStatus}`);
          else notes.push(`${goalId}: could not be written`);
        } else {
          notes.push(`${goalId}: ${priorStatus ? 'already as before or missing' : 'prior state unknown; left as is'}`);
        }
      }
      return { restored: exact, detail: exact ? 'Goals restored exactly.' : `Goals changed since; ${notes.join('; ')}.`, ran: true };
    }
    case 'archive-goal': {
      const goal = deps.goals.load(inverse.goalId);
      if (!goal) return { restored: false, detail: 'The created goal no longer exists.', ran: false };
      if (goal.status === 'archived') return { restored: false, detail: 'The goal is already archived.', ran: false };
      goal.status = 'archived';
      const saved = deps.goals.save(goal, new Date(deps.now()).toISOString());
      return { restored: false, detail: saved ? 'The created goal was archived (soft; restorable).' : 'The goal could not be archived.', ran: saved };
    }
    case 'cancel-task': {
      const res = await deps.cancelTask({ taskId: inverse.taskId, reason: 'Leader dispatch vetoed by Mason', actor: 'mason' });
      return res.ok
        ? { restored: true, detail: 'The queued task was cancelled.', ran: true }
        : { restored: false, detail: `The task could not be cancelled: ${res.reason}`, ran: false };
    }
    case 'retire-standard': {
      const standards = readStandards();
      const target = standards.find((s) => s.id === inverse.standardId);
      if (!target || target.retiredAt !== null) return { restored: true, detail: 'The standard is not in force.', ran: false };
      target.retiredAt = new Date(deps.now()).toISOString();
      writeStandards(standards);
      return { restored: true, detail: 'The standard was retired.', ran: true };
    }
    case 'cancel-experiment': {
      const res = await deps.cancelExperiment({ experimentId: inverse.experimentId, reason: 'Leader experiment vetoed by Mason', actor: 'mason' });
      return res.ok
        ? { restored: true, detail: 'The experiment was cancelled.', ran: true }
        : { restored: false, detail: `The experiment could not be cancelled: ${res.reason}`, ran: false };
    }
    case 'restore-repo-hold': {
      if (!trusted) return { restored: false, detail: 'The ledger could not confirm this veto; the repo hold was left as is.', ran: false };
      const before = inverse.before;
      const change = await deps.setRepoHold({
        repo: inverse.repo,
        kind: 'leader-pause',
        hold: before === null ? null : { reason: before.reason, until: before.until, landingId: before.landingId },
        actor: 'mason',
      });
      return change.ok
        ? { restored: true, detail: before === null ? 'The Leader pause was lifted.' : 'The prior Leader pause was put back.', ran: true }
        : { restored: false, detail: `The repo hold could not be restored: ${change.reason ?? 'refused'}`, ran: false };
    }
    case 'reopen-pr': {
      if (!trusted) return { restored: false, detail: 'The ledger could not confirm this veto; the PR stays closed.', ran: false };
      const res = await deps.reopenFleetPr({ repo: inverse.repo, number: inverse.number, reason: 'Leader close vetoed by Mason', actor: 'mason' });
      return res.ok
        ? { restored: true, detail: `${inverse.repo}#${inverse.number} was reopened.`, ran: true }
        : { restored: false, detail: `The PR could not be reopened: ${res.reason}`, ran: false };
    }
    case 'rollback-harness': {
      if (!trusted) return { restored: false, detail: 'The ledger could not confirm this veto; the harness was left as is.', ran: false };
      const res = await deps.rollbackHarness({ toVersionId: inverse.toVersionId, reason: 'Leader adoption vetoed by Mason', actor: 'mason' });
      return res.ok
        ? { restored: true, detail: 'The previous harness is active again.', ran: true }
        : { restored: false, detail: `The harness could not be rolled back: ${res.reason}`, ran: false };
    }
    default:
      return { restored: false, detail: 'Unknown inverse.', ran: false };
  }
}

type VetoOutcome = LeaderVetoRecord | { busy: string } | null;

function vetoPlaybook(deps: LeaderApplyDeps, action: LeaderAction, note: string | null): void {
  try {
    deps.addPlaybookDelta(`Mason vetoed the Leader's "${action.summary}" (${action.kind})${note ? `: ${note}` : ''}. Weigh this before proposing similar moves.`);
  } catch { /* best-effort */ }
}

async function vetoOne(deps: LeaderApplyDeps, stored: StoredLeaderAction, note: string | null): Promise<VetoOutcome> {
  const actionId = stored.action.id;
  const nowIso = new Date(deps.now()).toISOString();
  const nowMs = deps.now();

  // A scheduled action is vetoed by compare-and-set on its CURRENT row (c7).
  // Lowering is instant (I1), so a veto is never refused because an apply is
  // in flight: it takes the row, and the applier — finding its claim gone —
  // undoes the change it just made (applyClaimed).
  if (stored.action.status === 'scheduled') {
    type Taken = { kind: 'vetoed'; action: LeaderAction; applying: 'no' | 'live' | 'interrupted' } | { kind: 'moved' };
    const taken = withActionStore((store): Taken => {
      const s = store.actions.find((x) => x.action.id === actionId);
      if (!s || s.action.status !== 'scheduled') return { kind: 'moved' };
      const applying = s.claim?.op !== 'apply' ? 'no' : claimIsLive(s.claim, nowMs) ? 'live' : 'interrupted';
      const vetoed = { ...s.action, status: 'vetoed', vetoedAt: nowIso, vetoNote: note } as LeaderAction;
      const index = store.actions.indexOf(s);
      store.actions[index] = { action: vetoed, restore: [], claim: null };
      return { kind: 'vetoed', action: vetoed, applying };
    });
    if (taken.kind === 'moved') {
      // It applied (or was settled) between the caller's read and the lock.
      const fresh = findStoredAction(actionId);
      return fresh && fresh.action.status === 'applied' ? vetoOne(deps, fresh, note) : null;
    }
    const action = taken.action;
    const detail = taken.applying === 'live'
      ? 'Vetoed while it was being applied; the change is undone as soon as the apply finishes.'
      : taken.applying === 'interrupted'
        ? 'Vetoed; an earlier apply of this action was interrupted and may have partly applied — check the setting it touches.'
        : 'Vetoed before it applied; nothing changed.';
    const record: LeaderVetoRecord = { actionId, memoId: action.memoId, note, inverse: null, restored: taken.applying === 'no', detail, at: nowIso };
    try { deps.appendLedger({ kind: 'leader:vetoed', data: record, actor: 'mason', grantId: deps.standingPolicy()?.grantId ?? null, repo: actionRepo(action) }); } catch { /* best-effort */ }
    ledgerAction(deps, action);
    vetoPlaybook(deps, action, note);
    return record;
  }

  if (stored.action.status !== 'applied' || !stored.action.inverse) return null;
  // An applied action: claim it so two vetoes (Verse + Telegram) never run
  // the inverse twice.
  const claimed = claimAction(deps, actionId, 'veto', (s) => s.action.status === 'applied' && s.action.inverse !== null);
  if (!claimed) {
    const fresh = findStoredAction(actionId);
    if (fresh && fresh.action.status === 'applied' && claimIsLive(fresh.claim, nowMs)) return { busy: `A veto of ${actionId} is already running.` };
    return null;
  }
  const action = claimed.stored.action;
  const fromLedger = await ledgerRowFor(deps, action.id, 'applied');
  const trustedInverse = fromLedger !== 'unavailable' && fromLedger !== null && fromLedger.inverse ? fromLedger.inverse : null;
  const inverse = trustedInverse ?? action.inverse!;
  if (!trustedInverse && !LOWERING_ONLY_OPS.has(inverse.op) && inverse.op !== 'restore-directives' && inverse.op !== 'restore-budget') {
    // Leave the action applied: this veto cannot be confirmed and could raise autonomy.
    settleClaim(claimed, claimed.stored);
    const record: LeaderVetoRecord = { actionId: action.id, memoId: action.memoId, note, inverse: null, restored: false,
      detail: 'The authority ledger could not confirm this action, so the veto could not safely undo it.', at: nowIso };
    try { deps.appendLedger({ kind: 'leader:vetoed', data: record, actor: 'mason', grantId: deps.standingPolicy()?.grantId ?? null, repo: actionRepo(action) }); } catch { /* best-effort */ }
    return record;
  }
  let result: { restored: boolean; detail: string };
  try {
    result = await runInverse(deps, claimed.stored, inverse, trustedInverse !== null);
  } catch (err) {
    result = { restored: false, detail: `Undoing threw: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}` };
  }
  const record: LeaderVetoRecord = { actionId: action.id, memoId: action.memoId, note, inverse: projectInverse(inverse), restored: result.restored, detail: result.detail, at: nowIso };
  const vetoed = { ...action, status: 'vetoed', vetoedAt: nowIso, vetoNote: note } as LeaderAction;
  settleClaim(claimed, { action: vetoed, restore: [] });
  // Lowering never waits on the ledger (I1): the veto stands even if these rows fail.
  try { deps.appendLedger({ kind: 'leader:vetoed', data: record, actor: 'mason', grantId: deps.standingPolicy()?.grantId ?? null, repo: actionRepo(action) }); } catch { /* best-effort */ }
  ledgerAction(deps, vetoed);
  vetoPlaybook(deps, action, note);
  return record;
}

/** Veto one action. Needs no authority beyond the caller's (lowering is instant, I1). */
export async function vetoLeaderAction(deps: LeaderApplyDeps, actionId: string, note: string | null): Promise<LeaderVetoResult> {
  const stored = findStoredAction(actionId);
  if (!stored) return { ok: false, code: 404, message: `No Leader action ${actionId}.`, records: [] };
  if (stored.action.status !== 'scheduled' && stored.action.status !== 'applied') {
    return { ok: false, code: 409, message: `Action ${actionId} is ${stored.action.status}; there is nothing to veto.`, records: [] };
  }
  const record = await vetoOne(deps, stored, note);
  if (record && 'busy' in record) return { ok: false, code: 409, message: record.busy, records: [] };
  return record
    ? { ok: true, code: 200, message: record.detail, records: [record] }
    : { ok: false, code: 409, message: 'Nothing to veto.', records: [] };
}

/** Veto every live action of a memo, newest first, so chained inverses unwind in order. */
export async function vetoLeaderMemo(deps: LeaderApplyDeps, memoId: string, note: string | null): Promise<LeaderVetoResult> {
  const live = readActionStore().actions.filter((s) => s.action.memoId === memoId);
  if (live.length === 0) return { ok: false, code: 404, message: `No actions for memo ${memoId}.`, records: [] };
  const targets = live.filter((s) => s.action.status === 'scheduled' || s.action.status === 'applied');
  if (targets.length === 0) return { ok: false, code: 409, message: 'Nothing in this memo is live.', records: [] };
  const records: LeaderVetoRecord[] = [];
  for (const stored of [...targets].reverse()) {
    // Re-read: an earlier inverse in this loop may have rewritten the store.
    const fresh = findStoredAction(stored.action.id) ?? stored;
    const record = await vetoOne(deps, fresh, note);
    if (record && !('busy' in record)) records.push(record);
  }
  return {
    ok: true,
    code: 200,
    message: `Vetoed ${records.length} action${records.length === 1 ? '' : 's'}; ${records.filter((r) => r.restored).length} restored exactly.`,
    records,
  };
}
