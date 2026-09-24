/**
 * Budget persistence (V3.10 unit A9) — three small private files:
 *
 *   ~/.ashlr/budget.json                 the operator's BudgetPolicy (0600)
 *   ~/.ashlr/routing/capacity.json       the latest seat capacity the Verse
 *                                        server observed, for processes that
 *                                        have no account collector (the fleet
 *                                        daemon) — 0600 in a 0700 directory
 *   ~/.ashlr/routing/decisions.jsonl     shadow-mode routing decisions, append
 *                                        only, size-bounded with one rotation
 *
 * WHY A CAPACITY SNAPSHOT. The account collector lives inside the Verse
 * server and keeps Claude's windows in memory; the only file it publishes
 * (`.resource-quota-shared-evidence.json`) is Codex-only with a 5 s TTL. The
 * daemon therefore had no Claude reading at all — which is why
 * `subscriptionAllows('claude')` used to fail OPEN. The snapshot carries the
 * readings (never a verdict: the reader re-applies the CURRENT policy) with
 * their own `observedAt`, so a reader can tell exactly how old they are.
 *
 * RULES
 *  - Load is TOTAL: a missing, oversized or mangled file yields the defaults /
 *    null. The server must boot on any file, and a daemon must fail CLOSED on
 *    a bad snapshot, never crash.
 *  - An UPDATE never writes over a policy file it could not read (3.10 review
 *    d7): it refuses with BudgetPolicyUnreadableError and keeps a copy. Only a
 *    missing file starts from the defaults.
 *  - Writes are atomic (O_EXCL|O_NOFOLLOW temp, fchmod 0600, fsync, rename) in
 *    a directory that must be a real, owned directory.
 *  - Paths re-resolve `homedir()` per call so a relocated HOME (tests) is
 *    always honoured.
 *  - Nothing persisted here is a secret; free text (labels, reasons, the
 *    provider's reset wording) still goes through `scrubSecrets`.
 */
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { open as openAsync, rename as renameAsync, rm as rmAsync } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import type { CapacityWindow, SeatCapacity } from './headroom.js';
import {
  applyBudgetUpdate,
  BUDGET_ENGINES,
  BUDGET_SEAT_ID_RE,
  defaultBudgetPolicy,
  isBudgetMode,
  sanitizeBudgetPolicy,
  type BudgetEngine,
  type ParsedBudgetUpdate,
} from './policy.js';
import type { BudgetPolicy, BudgetUpdateRequest, RoutingRequest, SeatDecision } from './types.js';

export const BUDGET_FILE = 'budget.json';
export const ROUTING_DIR = 'routing';
export const CAPACITY_SNAPSHOT_FILE = 'capacity.json';
export const DECISIONS_LOG_FILE = 'decisions.jsonl';

const MAX_POLICY_BYTES = 64 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** Rotate the decision log past this size; one previous generation is kept. */
export const DECISIONS_LOG_MAX_BYTES = 2 * 1024 * 1024;
/** Longest line a reader will parse; anything larger was not written by us. */
const MAX_DECISION_LINE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_SEATS = 64;
const MAX_SNAPSHOT_WINDOWS = 12;

export function ashlrRoot(): string {
  return join(homedir(), '.ashlr');
}

export function budgetPolicyPath(): string {
  return join(ashlrRoot(), BUDGET_FILE);
}

export function routingDir(): string {
  return join(ashlrRoot(), ROUTING_DIR);
}

export function capacitySnapshotPath(): string {
  return join(routingDir(), CAPACITY_SNAPSHOT_FILE);
}

export function decisionsLogPath(): string {
  return join(routingDir(), DECISIONS_LOG_FILE);
}

// ---------------------------------------------------------------------------
// Budget policy
// ---------------------------------------------------------------------------

/** The operator's policy, or the defaults. Total: never throws. */
export function loadBudgetPolicy(file: string = budgetPolicyPath()): BudgetPolicy {
  const read = readPrivateFileCapped(file, MAX_POLICY_BYTES);
  if (!read || read.truncated) return defaultBudgetPolicy();
  try {
    return sanitizeBudgetPolicy(JSON.parse(read.text) as unknown);
  } catch {
    return defaultBudgetPolicy();
  }
}

/**
 * Where the policy file stands, for a WRITER (3.10 review d7). Reads stay
 * total — `loadBudgetPolicy` answers the defaults for any bad file, which is
 * right for a reader — but a writer that started from those defaults would
 * replace the operator's real policy with "defaults + one click". So a writer
 * asks this first: only `missing` may start from the defaults.
 *
 * Only ENOENT is missing. A file that exists but cannot be opened (EACCES,
 * EMFILE), is a symlink or not a regular file, is over the cap, is not a JSON
 * object, or carries a `mode` / `seats` this build cannot read (a newer
 * build's mode, a hand edit) is `unreadable`. Never throws.
 */
export type BudgetPolicyFileState =
  | { state: 'missing' }
  | { state: 'ok'; policy: BudgetPolicy }
  | { state: 'unreadable'; reason: string; fingerprint: string | null };

export function readBudgetPolicyFileState(file: string = budgetPolicyPath()): BudgetPolicyFileState {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: `could not be inspected (${typeof code === 'string' ? code : 'error'})`, fingerprint: null };
  }
  if (stat.isSymbolicLink()) return { state: 'unreadable', reason: 'is a symlink', fingerprint: null };
  if (!stat.isFile()) return { state: 'unreadable', reason: 'is not a regular file', fingerprint: null };
  const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const read = readPrivateFileCapped(file, MAX_POLICY_BYTES);
  if (!read) return { state: 'unreadable', reason: 'could not be read', fingerprint };
  if (read.truncated) return { state: 'unreadable', reason: `is larger than ${MAX_POLICY_BYTES} bytes`, fingerprint };
  let raw: unknown;
  try {
    raw = JSON.parse(read.text) as unknown;
  } catch {
    return { state: 'unreadable', reason: 'is not valid JSON', fingerprint };
  }
  if (!isObject(raw)) return { state: 'unreadable', reason: 'is not a JSON object', fingerprint };
  // sanitizeBudgetPolicy would quietly turn these into 'balanced' / no seats;
  // a write on top would make that loss permanent.
  if ('mode' in raw && !isBudgetMode(raw['mode'])) return { state: 'unreadable', reason: 'has a mode this build does not know', fingerprint };
  if ('seats' in raw && !isObject(raw['seats'])) return { state: 'unreadable', reason: 'has a malformed seats map', fingerprint };
  return { state: 'ok', policy: sanitizeBudgetPolicy(raw) };
}

/**
 * The write refusal for an unreadable policy file: nothing was written, the
 * original is untouched, and (when its bytes could be read) a byte-exact
 * copy sits beside it. Duck-typed like BudgetPolicyError (`code` + `status`)
 * so a route that forwards them shows the real reason; 503 because the
 * request was fine and the store is what is unusable.
 */
export class BudgetPolicyUnreadableError extends Error {
  readonly code = 'VERSE_STORE_UNREADABLE' as const;
  readonly status = 503 as const;
  readonly file: string;
  readonly archivedTo: string | null;

  constructor(file: string, reason: string, archivedTo: string | null) {
    super(
      `${file} ${reason}; the budget change was not saved so the policy in it is kept. `
        + (archivedTo ? `A copy is at ${archivedTo}. ` : '')
        + 'Fix or move the file aside to start from the defaults.',
    );
    this.name = 'BudgetPolicyUnreadableError';
    this.file = file;
    this.archivedTo = archivedTo;
  }
}

/** Largest unreadable policy file still copied aside (the cap is 64 KiB; a runaway file is left in place). */
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
/** Copies already made in this process, by file identity, so repeated refused clicks do not pile up archives. */
const archivedPolicyCopies = new Map<string, string | null>();

/** Byte-exact private copy of an unreadable file beside it; null when its bytes cannot be read. Never throws. */
function archiveUnreadablePolicy(file: string, fingerprint: string | null, now: Date): string | null {
  if (!fingerprint) return null;
  const key = `${file}\0${fingerprint}`;
  if (archivedPolicyCopies.has(key)) return archivedPolicyCopies.get(key) ?? null;
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let bytes: Buffer | null = null;
  let src = -1;
  try {
    src = openSync(file, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(src);
    if (stat.isFile() && stat.size <= MAX_ARCHIVE_BYTES) {
      const buf = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < buf.length) {
        const n = readSync(src, buf, offset, buf.length - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      if (offset === buf.length) bytes = buf;
    }
  } catch {
    bytes = null;
  } finally {
    if (src >= 0) {
      try { closeSync(src); } catch { /* never throws */ }
    }
  }
  let target: string | null = null;
  if (bytes) {
    const candidate = join(dirname(file), `${basename(file).replace(/\.json$/, '')}.unreadable-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    let out = -1;
    try {
      // O_EXCL: never clobbers an earlier copy; O_NOFOLLOW: never writes through a planted link.
      out = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const n = writeSync(out, bytes, offset, bytes.length - offset, offset);
        if (n <= 0) throw new Error('archive write made no progress');
        offset += n;
      }
      fsyncSync(out);
      target = candidate;
    } catch {
      // A half-written copy would later pass for a real archive.
      if (out >= 0) {
        try { rmSync(candidate, { force: true }); } catch { /* best effort */ }
      }
    } finally {
      if (out >= 0) {
        try { closeSync(out); } catch { /* never throws */ }
      }
    }
  }
  archivedPolicyCopies.set(key, target);
  return target;
}

/**
 * Apply exactly one validated update and persist atomically. Throws
 * `BudgetPolicyError` (VERSE_INVALID 400 / VERSE_TOO_LARGE 413) for a bad
 * update — nothing is written.
 *
 * Throws `BudgetPolicyUnreadableError` (503) when the file exists but cannot
 * be read — nothing is written and a copy is kept (see
 * readBudgetPolicyFileState). Only a MISSING file starts from the defaults.
 *
 * Read-modify-write without a lock: the only writer is the operator's own
 * Budget panel, one click at a time. Two racing clicks resolve last-writer-
 * wins, and each response carries the policy as stored.
 */
export function updateBudgetPolicy(
  update: BudgetUpdateRequest | ParsedBudgetUpdate,
  opts: { now?: Date; file?: string; engineOf?: (seatId: string) => BudgetEngine | undefined } = {},
): BudgetPolicy {
  const file = opts.file ?? budgetPolicyPath();
  const now = opts.now ?? new Date();
  const found = readBudgetPolicyFileState(file);
  if (found.state === 'unreadable') {
    throw new BudgetPolicyUnreadableError(file, found.reason, archiveUnreadablePolicy(file, found.fingerprint, now));
  }
  const current = found.state === 'ok' ? found.policy : defaultBudgetPolicy();
  const next = applyBudgetUpdate(current, update, now.toISOString(), opts.engineOf);
  ensurePrivateDirectory(dirname(file));
  writePrivateFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

// ---------------------------------------------------------------------------
// Capacity snapshot
// ---------------------------------------------------------------------------

export interface CapacitySnapshot {
  v: 1;
  /** When the Verse server wrote this snapshot. */
  publishedAt: string;
  seats: SeatCapacity[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return scrubSecrets(value.slice(0, max));
}

function sanitizeWindow(raw: unknown): CapacityWindow | null {
  if (!isObject(raw) || typeof raw['id'] !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(raw['id'])) return null;
  const used = raw['usedPercent'];
  if (used !== null && (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100)) return null;
  const resetsAt = raw['resetsAt'];
  if (resetsAt !== null && !isIso(resetsAt)) return null;
  const description = raw['resetDescription'];
  if (description !== null && typeof description !== 'string') return null;
  if (typeof raw['limitReached'] !== 'boolean') return null;
  return {
    id: raw['id'],
    usedPercent: used,
    resetsAt,
    resetDescription: description === null ? null : cleanText(description, 160),
    limitReached: raw['limitReached'],
  };
}

/** Strict, field-by-field validation of one persisted seat; null drops it (the reader then fails closed). */
export function sanitizeSeatCapacity(raw: unknown): SeatCapacity | null {
  if (!isObject(raw)) return null;
  const seatId = raw['seatId'];
  const engine = raw['engine'];
  if (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId)) return null;
  if (typeof engine !== 'string' || !(BUDGET_ENGINES as readonly string[]).includes(engine)) return null;
  if (typeof raw['free'] !== 'boolean' || typeof raw['signedOut'] !== 'boolean') return null;
  // `free` is only believable for a local seat: a paid seat claiming it would
  // bypass every reserve.
  if (raw['free'] !== (engine === 'local')) return null;
  const reachable = raw['reachable'];
  if (reachable !== null && typeof reachable !== 'boolean') return null;
  const contextWindow = raw['contextWindow'];
  if (contextWindow !== null && (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)) return null;
  const observedAt = raw['observedAt'];
  if (observedAt !== null && !isIso(observedAt)) return null;
  const spent = raw['spentTodayUsd'];
  if (spent !== null && (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0)) return null;
  if (!Array.isArray(raw['windows']) || raw['windows'].length > MAX_SNAPSHOT_WINDOWS) return null;
  const windows: CapacityWindow[] = [];
  for (const w of raw['windows']) {
    const clean = sanitizeWindow(w);
    if (!clean) return null;
    windows.push(clean);
  }
  return {
    seatId,
    engine: engine as BudgetEngine,
    label: cleanText(raw['label'], 80) ?? seatId,
    free: raw['free'],
    windows,
    signedOut: raw['signedOut'],
    reachable,
    contextWindow,
    observedAt,
    spentTodayUsd: spent,
  };
}

function buildSnapshot(seats: readonly SeatCapacity[], now: Date): CapacitySnapshot {
  return {
    v: 1,
    publishedAt: now.toISOString(),
    seats: seats.slice(0, MAX_SNAPSHOT_SEATS).map((seat) => sanitizeSeatCapacity(seat)).filter((s): s is SeatCapacity => s !== null),
  };
}

/** Persist the seats the Verse server just observed (sync, fsync'd). Throws on a storage failure. */
export function writeCapacitySnapshot(seats: readonly SeatCapacity[], now: Date = new Date(), file: string = capacitySnapshotPath()): CapacitySnapshot {
  const snapshot = buildSnapshot(seats, now);
  ensurePrivateDirectory(dirname(file));
  writePrivateFileAtomic(file, `${JSON.stringify(snapshot)}\n`);
  return snapshot;
}

/**
 * The same write, off the event loop — what the request path and the
 * background publisher use. Measured on this machine the sync version's
 * fsync costs p50 4.8 ms / p99 14.6 ms, too close to the 20 ms handler
 * budget to sit on a request. This one skips fsync on purpose: the snapshot
 * is a CACHE of in-memory readings. A crash can lose the newest write, and
 * then a reader finds the older (or no) snapshot and fails CLOSED — never
 * open. Still create-exclusive, O_NOFOLLOW, 0600, renamed into place.
 */
export async function writeCapacitySnapshotAsync(
  seats: readonly SeatCapacity[],
  now: Date = new Date(),
  file: string = capacitySnapshotPath(),
): Promise<CapacitySnapshot> {
  const snapshot = buildSnapshot(seats, now);
  ensurePrivateDirectory(dirname(file));
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  const handle = await openAsync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(snapshot)}\n`, 'utf8');
    await handle.chmod(0o600);
    await handle.close();
    await renameAsync(temp, file);
    published = true;
  } finally {
    if (!published) {
      await handle.close().catch(() => undefined);
      await rmAsync(temp, { force: true }).catch(() => undefined);
    }
  }
  return snapshot;
}

/**
 * The persisted snapshot, or null when absent, unreadable, or not ours.
 * Seats that fail validation are DROPPED — a reader looking for them then
 * finds no reading and fails closed.
 */
export function readCapacitySnapshot(file: string = capacitySnapshotPath()): CapacitySnapshot | null {
  const read = readPrivateFileCapped(file, MAX_SNAPSHOT_BYTES);
  if (!read || read.truncated) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(read.text) as unknown;
  } catch {
    return null;
  }
  if (!isObject(raw) || raw['v'] !== 1 || !isIso(raw['publishedAt']) || !Array.isArray(raw['seats'])) return null;
  const seats: SeatCapacity[] = [];
  for (const entry of raw['seats'].slice(0, MAX_SNAPSHOT_SEATS)) {
    const clean = sanitizeSeatCapacity(entry);
    if (clean) seats.push(clean);
  }
  return { v: 1, publishedAt: new Date(Date.parse(raw['publishedAt'])).toISOString(), seats };
}

// ---------------------------------------------------------------------------
// Shadow decision log
// ---------------------------------------------------------------------------

/** Where a shadow decision came from, so the Leader can compare lanes. */
export type ShadowDecisionSource = 'daemon' | 'gateway' | 'best-of-n' | 'leader' | 'verse' | 'test';

export interface ShadowDecisionRecord {
  v: 1;
  at: string;
  source: ShadowDecisionSource;
  request: RoutingRequest;
  decision: SeatDecision;
  /** What ACTUALLY ran, when the caller knows it — the comparison shadow mode exists for. */
  actual: { engine: string; seatId: string | null } | null;
}

const SHADOW_SOURCES: readonly ShadowDecisionSource[] = ['daemon', 'gateway', 'best-of-n', 'leader', 'verse', 'test'];

function scrubDecision(decision: SeatDecision): SeatDecision {
  return {
    seatId: decision.seatId,
    candidates: [...decision.candidates],
    exclusions: decision.exclusions.map((e) => ({
      seatId: e.seatId,
      reasons: e.reasons.map((r) => scrubSecrets(r)),
      nextEligibleAt: e.nextEligibleAt,
    })),
    why: scrubSecrets(decision.why),
    mode: decision.mode,
  };
}

function rotateIfLarge(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < DECISIONS_LOG_MAX_BYTES) return;
  const previous = file.replace(/\.jsonl$/, '.1.jsonl');
  try { rmSync(previous, { force: true }); } catch { /* best effort */ }
  renameSync(file, previous);
}

/**
 * Append one shadow decision. Never throws: shadow logging must never be the
 * reason a dispatch fails. Returns false when the record could not be written.
 */
export function recordShadowDecision(
  input: { source: ShadowDecisionSource; request: RoutingRequest; decision: SeatDecision;
    actual?: { engine: string; seatId: string | null } | null; now?: Date },
  file: string = decisionsLogPath(),
): boolean {
  try {
    if (!SHADOW_SOURCES.includes(input.source)) return false;
    const record: ShadowDecisionRecord = {
      v: 1,
      at: (input.now ?? new Date()).toISOString(),
      source: input.source,
      request: { ...input.request },
      decision: scrubDecision(input.decision),
      actual: input.actual ? { engine: scrubSecrets(String(input.actual.engine)).slice(0, 64), seatId: input.actual.seatId } : null,
    };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_DECISION_LINE_BYTES) return false;
    ensurePrivateDirectory(dirname(file));
    rotateIfLarge(file);
    // One O_APPEND write per record (a line is far below PIPE_BUF-scale
    // sizes on local disks), O_NOFOLLOW so a planted link cannot redirect it.
    // The mode applies when the file is created.
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
    const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return false;
      const bytes = Buffer.from(line, 'utf8');
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) return false;
        offset += written;
      }
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

function isDecisionRecord(value: unknown): value is ShadowDecisionRecord {
  if (!isObject(value) || value['v'] !== 1 || !isIso(value['at'])) return false;
  if (typeof value['source'] !== 'string' || !(SHADOW_SOURCES as readonly string[]).includes(value['source'])) return false;
  const decision = value['decision'];
  return isObject(decision) && typeof decision['why'] === 'string' && Array.isArray(decision['candidates'])
    && Array.isArray(decision['exclusions']) && isObject(value['request']);
}

/** Tail-read the newest `limit` shadow decisions, newest first. Never throws. */
export function readShadowDecisions(limit = 50, file: string = decisionsLogPath()): ShadowDecisionRecord[] {
  const want = Math.max(1, Math.min(500, Math.floor(limit)));
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | noFollow);
  } catch {
    return [];
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return [];
    const length = Math.min(stat.size, want * MAX_DECISION_LINE_BYTES, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buffer, offset, length - offset, stat.size - length + offset);
      if (n <= 0) break;
      offset += n;
    }
    const lines = buffer.subarray(0, offset).toString('utf8').split('\n');
    const out: ShadowDecisionRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < want; i -= 1) {
      const line = lines[i]!;
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isDecisionRecord(parsed)) out.push(parsed);
      } catch {
        // The first line of a tail window is usually partial.
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}
