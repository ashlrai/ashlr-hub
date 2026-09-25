/**
 * Seat capacity history (3.10.1) — a small rolling log of each paid seat's
 * window usage, beside the latest-only snapshot:
 *
 *   ~/.ashlr/routing/capacity.json            latest snapshot (budget-store.ts)
 *   ~/.ashlr/routing/capacity-history.jsonl   this file: one row per seat
 *                                             window per recorded sample
 *
 * WHY: Command's weekly burn-downs used to start empty on every page load —
 * the readings lived only in the browser. The wire contract (row shape,
 * route, response) is capacity-history-types.ts.
 *
 * WHO WRITES (each path never throws into its caller):
 *   - the daemon's capacity publisher, on every publish and on every check
 *     that finds the Verse server's snapshot fresh (daemon/capacity-publisher.ts);
 *   - the Verse server, after each budget read the UI polls and on a 60 s
 *     follow of its own publisher (capacity-history-api.ts) — so history keeps
 *     growing while the fleet is dark and no daemon runs.
 * Both read the same snapshot, so they see the same observations; the rules
 * below make a second recorder a no-op instead of a duplicate.
 *
 * RULES
 *  - A row carries the seat's `observedAt` (when the provider window was
 *    read), never the publish time: republishing a stale reading adds nothing,
 *    and a seat with no timestamp adds nothing (headroom.ts treats it as
 *    unknown usage too).
 *  - Flat-run compression: a row is written only when the value (or the
 *    window's reset) changed, or ≥ 10 min passed since that seat window's
 *    last row. A week of flat readings is ~1 000 rows per window, not 20 000.
 *  - Stable series: a row's window class is headroom.ts's, except that a
 *    Codex `*_primary` window already recorded as WEEKLY stays weekly for the
 *    rest of that reset period (historyWindowClass) — so a weekly-only
 *    primary does not jump to the session line in its last ~5 hours.
 *  - Bounded: rows older than 8 days are dropped, and the file is rewritten
 *    (atomic temp + rename, 0600) once it passes 2 MiB or its oldest row is a
 *    day past the keep window — so compaction runs about daily, not per append.
 *    Past the byte cap, older rows are THINNED per series (a low and a high
 *    reading per time slot) before any row is dropped, so every seat keeps
 *    its whole 8-day window; dropping the oldest rows is the last resort.
 *  - ASHLR_CAPACITY_HISTORY=0 turns EVERY recorder off (checked here in the
 *    store, so the daemon, the request path and the follow all honour it);
 *    the route still serves whatever was already recorded.
 *  - Readers are total: a corrupt or partial line (a writer that died
 *    mid-line) is skipped, and an append after one starts on a fresh line.
 *  - 0600 file in the 0700 routing directory, O_NOFOLLOW | O_NONBLOCK (a FIFO
 *    planted at the path is refused instead of hanging the process), one
 *    O_APPEND write per record batch. Paths re-resolve homedir() per call
 *    (budget-store.ts), so a relocated HOME in tests is always honoured.
 *
 * Known race, accepted: a compaction in one process can drop a row another
 * process appended between the compaction's read and its rename. That costs
 * one sample, once a day at most; the next sample re-records the value.
 */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { readCapacitySnapshot, routingDir, type CapacitySnapshot } from './budget-store.js';
import type {
  CapacityHistoryResponse,
  CapacityHistoryRow,
  CapacityHistorySeries,
  CapacityHistorySource,
  CapacityHistoryWindow,
} from './capacity-history-types.js';
import { classifyWindow, type CapacityWindow, type SeatCapacity, type SeatWindowClass } from './headroom.js';
import { BUDGET_SEAT_ID_RE } from './policy.js';

export const CAPACITY_HISTORY_FILE = 'capacity-history.jsonl';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 86_400_000;

/** A flat seat window still gets one row this often (so a reader can tell "flat" from "not watched"). */
export const HISTORY_FLAT_ROW_MS = 10 * MIN;
/** Rows younger than this are always kept (subject to the byte cap). */
export const HISTORY_KEEP_MS = 8 * DAY;
/** Past this size the file is compacted. */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** Compaction rewrites down to this, so the next byte compaction is days away, not one append away. */
export const HISTORY_COMPACT_TARGET_BYTES = Math.floor(HISTORY_MAX_BYTES * 0.75);
/**
 * Byte compaction thins before it drops (3.10.1 review: a flat cut to the
 * target evicted the start of EVERY seat's weekly window once a multi-seat
 * setup passed ~16 series). Each step leaves rows newer than `rawMs`
 * untouched and keeps, per series, at most the lowest and the highest reading
 * in each `slotMs` slot of the older rows — a climb keeps its ends, a reset
 * keeps its drop. Steps run in order until the file fits the target. Rough
 * cost of 8 days per series: 30 min slots ≈ 85 KB, 2 h ≈ 22 KB, 6 h ≈ 8 KB,
 * so even MAX_SEATS paid seats (128 series) fit at the last step. Slots are
 * epoch-aligned, so re-thinning already-thinned rows keeps the same rows.
 */
export const HISTORY_THIN_STEPS: readonly { rawMs: number; slotMs: number }[] = [
  { rawMs: DAY, slotMs: 30 * MIN },
  { rawMs: DAY, slotMs: 2 * HOUR },
  { rawMs: 6 * HOUR, slotMs: 2 * HOUR },
  { rawMs: HOUR, slotMs: 6 * HOUR },
];
/** Age compaction runs once the oldest row is this far past the keep window. */
const AGE_SLACK_MS = DAY;
/** How much of the file's end an append reads to find each series' last row. */
const TAIL_BYTES = 128 * 1024;
/** How much of the file's start an append reads to find the oldest row (age compaction). */
const HEAD_BYTES = 2048;
/** The most a reader loads (the file is compacted at 2 MiB; anything past this is not ours). */
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** A row is ~120 bytes; a longer line was not written by us. */
const MAX_LINE_CHARS = 1024;
/** A reading stamped further ahead than this is a clock problem, not a sample. */
const FUTURE_SKEW_MS = 5 * MIN;
/** Codex reports its reset as a countdown, so the same reset can move by a second between reads. */
const RESET_JITTER_MS = MIN;
const MAX_SEATS = 64;

/** Response bounds: ≤ 32 series × ≤ 720 points (one per ~14 min over a week) — a few hundred KB at worst. */
export const HISTORY_MAX_SERIES = 32;
export const HISTORY_MAX_POINTS_PER_SERIES = 720;

const WINDOWS: readonly CapacityHistoryWindow[] = ['session', 'weekly'];
const SOURCES: readonly CapacityHistorySource[] = ['daemon', 'verse'];
const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
/**
 * O_NONBLOCK, as verse/fleet-history.ts: a blocking open() of a FIFO waits
 * forever for the other end, and every open here is synchronous — on the
 * Verse server's event loop or in the daemon's standing tick. Non-blocking, a
 * read open of a FIFO returns at once (the fstat check then refuses it) and
 * an append open without a reader fails with ENXIO. Regular files ignore it.
 */
const NON_BLOCK = typeof fsConstants.O_NONBLOCK === 'number' ? fsConstants.O_NONBLOCK : 0;

/** True when ASHLR_CAPACITY_HISTORY=0: no recorder writes (the route still serves what exists). */
export function capacityHistoryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['ASHLR_CAPACITY_HISTORY'] === '0';
}

export function capacityHistoryPath(): string {
  return join(routingDir(), CAPACITY_HISTORY_FILE);
}

/** Series identity: seat ids may contain `:` and `/` (BUDGET_SEAT_ID_RE), never `#`. */
export function historySeriesKey(seatId: string, window: CapacityHistoryWindow): string {
  return `${seatId}#${window}`;
}

/** Second precision keeps rows short; two reads in one second are one observation. */
function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function resetMoved(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a !== b;
  return Math.abs(Date.parse(a) - Date.parse(b)) > RESET_JITTER_MS;
}

export interface HistoryRowOptions {
  nowMs: number;
  source: CapacityHistorySource;
  /**
   * Per seat id, the `resetsAt` of that seat's newest recorded WEEKLY row
   * (appendCapacityHistory reads it from the file's tail). Feeds the sticky
   * rule in {@link historyWindowClass}; absent = headroom.ts's class as is.
   */
  weeklyResetBySeat?: ReadonlyMap<string, string>;
}

/**
 * The series a window's reading is recorded under: headroom.ts's class, made
 * STABLE for the one window whose class depends on the clock.
 *
 * headroom.ts calls a Codex `*_primary` window weekly only while its reset is
 * more than ~5 h away (the primary is usually the 5-hour window, but some
 * accounts report a weekly-only primary). Recorded as is, a weekly-only
 * primary would move to the session series for the last ~5 h before its
 * reset, splitting one physical window across two lines. So a primary the
 * live classifier calls 'session' stays 'weekly' when this seat's newest
 * weekly row carries the same reset instant (within the countdown jitter)
 * and no window the classifier already calls weekly accounts for that reset
 * — i.e. that primary IS the window the weekly line has been drawing. A
 * window's reset instant is fixed for its life, so a real 5-hour window
 * never inherits a weekly one's. The next period (reset ~7 days out) is
 * weekly on its own. With no weekly row on file (first seen inside its last
 * 5 h) there is no evidence, and the headroom class stands. Budget gating is
 * unchanged: this only picks the history series.
 */
export function historyWindowClass(
  seat: SeatCapacity,
  window: CapacityWindow,
  nowMs: number,
  weeklyReset: string | undefined,
): SeatWindowClass {
  const cls = classifyWindow(seat.engine, window, nowMs);
  if (cls !== 'session' || seat.engine !== 'codex' || !window.id.endsWith('_primary')) return cls;
  if (!weeklyReset || !window.resetsAt || resetMoved(window.resetsAt, weeklyReset)) return cls;
  const explained = seat.windows.some((other) => other !== window && other.resetsAt !== null
    && classifyWindow(seat.engine, other, nowMs) === 'weekly' && !resetMoved(other.resetsAt, weeklyReset));
  return explained ? cls : 'weekly';
}

/**
 * The highest reading among the seat's ACCOUNT windows of `cls` — exactly
 * headroom.ts assessSeat's `sessionUsed` / `weeklyUsed` (same classifier,
 * per-model windows excluded, null percent = no signal), so a recorded row
 * is the number the budget view showed for that window at that moment. The
 * one exception is the sticky weekly primary ({@link historyWindowClass}).
 */
function peakWindow(seat: SeatCapacity, cls: CapacityHistoryWindow, nowMs: number, weeklyReset: string | undefined): CapacityWindow | null {
  let best: CapacityWindow | null = null;
  for (const window of seat.windows) {
    const used = window.usedPercent;
    if (used === null || typeof used !== 'number' || !Number.isFinite(used)) continue;
    if (historyWindowClass(seat, window, nowMs, weeklyReset) !== cls) continue;
    if (best === null || used > (best.usedPercent as number)) best = window;
  }
  return best;
}

/** The rows one snapshot of `seats` would record (before compression). Pure. */
export function historyRowsFromSeats(
  seats: readonly SeatCapacity[],
  opts: HistoryRowOptions,
): CapacityHistoryRow[] {
  const rows: CapacityHistoryRow[] = [];
  for (const seat of seats.slice(0, MAX_SEATS)) {
    if (!isObject(seat) || seat.free || typeof seat.seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seat.seatId)) continue;
    if (!Array.isArray(seat.windows)) continue;
    // No timestamp, no row: an undated reading cannot be placed on a chart.
    const observed = typeof seat.observedAt === 'string' ? Date.parse(seat.observedAt) : NaN;
    if (!Number.isFinite(observed) || observed > opts.nowMs + FUTURE_SKEW_MS || observed < opts.nowMs - HISTORY_KEEP_MS) continue;
    const ts = isoSeconds(observed);
    const weeklyReset = opts.weeklyResetBySeat?.get(seat.seatId);
    for (const window of WINDOWS) {
      const peak = peakWindow(seat, window, opts.nowMs, weeklyReset);
      if (!peak) continue;
      const resetMs = peak.resetsAt ? Date.parse(peak.resetsAt) : NaN;
      rows.push({
        ts,
        seat: seat.seatId,
        window,
        usedPct: Math.round(Math.min(100, Math.max(0, peak.usedPercent as number)) * 10) / 10,
        resetsAt: Number.isFinite(resetMs) ? isoSeconds(resetMs) : null,
        source: opts.source,
      });
    }
  }
  return rows;
}

/**
 * Flat-run compression: record `row` after `last` (that series' newest row)
 * only when it is a NEWER observation and its value or reset changed, or
 * ≥ 10 min passed. An equal or older timestamp is an observation already
 * recorded — by this process or the other recorder.
 */
export function shouldRecordRow(last: CapacityHistoryRow | undefined, row: CapacityHistoryRow): boolean {
  if (!last) return true;
  const dt = Date.parse(row.ts) - Date.parse(last.ts);
  if (!(dt > 0)) return false;
  if (row.usedPct !== last.usedPct) return true;
  if (resetMoved(last.resetsAt, row.resetsAt)) return true;
  return dt >= HISTORY_FLAT_ROW_MS;
}

function serializeRow(row: CapacityHistoryRow): string {
  // resetsAt is omitted when unknown (every Claude row): ~15 bytes a row.
  return JSON.stringify({
    ts: row.ts,
    seat: row.seat,
    window: row.window,
    usedPct: row.usedPct,
    ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}),
    source: row.source,
  });
}

/** One line → a validated row, or null (corrupt, partial, foreign). Never throws. */
export function parseHistoryLine(line: string): CapacityHistoryRow | null {
  if (line.length === 0 || line.length > MAX_LINE_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  const { ts, seat, window, usedPct, resetsAt, source } = raw;
  if (!isIso(ts)) return null;
  if (typeof seat !== 'string' || !BUDGET_SEAT_ID_RE.test(seat)) return null;
  if (typeof window !== 'string' || !(WINDOWS as readonly string[]).includes(window)) return null;
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct) || usedPct < 0 || usedPct > 100) return null;
  if (resetsAt !== undefined && resetsAt !== null && !isIso(resetsAt)) return null;
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source)) return null;
  return {
    ts,
    seat,
    window: window as CapacityHistoryWindow,
    usedPct,
    resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
    source: source as CapacityHistorySource,
  };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

interface Chunk {
  text: string;
  /** The whole file's size. */
  size: number;
  /** True when the chunk starts at byte 0 (its first line is whole). */
  fromStart: boolean;
  /** True when the file's last byte is a newline (or the file is empty). */
  endsWithNewline: boolean;
}

/** The first or last `maxBytes` of `file`; null when it is missing or not a regular file (a FIFO included). Never throws. */
function readChunk(file: string, maxBytes: number, where: 'head' | 'tail'): Chunk | null {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = stat.size;
    const length = Math.min(size, maxBytes);
    const position = where === 'tail' ? size - length : 0;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buffer, offset, length - offset, position + offset);
      if (n <= 0) break;
      offset += n;
    }
    const bytes = buffer.subarray(0, offset);
    return {
      text: bytes.toString('utf8'),
      size,
      fromStart: position === 0,
      endsWithNewline: size === 0 || (where === 'tail' && offset === length && bytes[offset - 1] === 0x0a),
    };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* never throws */ }
  }
}

function rowsOf(chunk: Chunk): CapacityHistoryRow[] {
  const lines = chunk.text.split('\n');
  // A tail window starts mid-line; that fragment is not a row.
  if (!chunk.fromStart) lines.shift();
  const rows: CapacityHistoryRow[] = [];
  for (const line of lines) {
    const row = parseHistoryLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * One O_APPEND write of `text`; creates the file 0600 and re-tightens a
 * loosened mode. Anything but a regular file is refused: a FIFO without a
 * reader fails the non-blocking open (ENXIO), one with a reader the fstat.
 */
function appendPrivate(file: string, text: string): void {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | NO_FOLLOW | NON_BLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('capacity history is not a regular file');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('capacity history is owned by another user');
    }
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const n = writeSync(fd, bytes, offset, bytes.length - offset);
      if (n <= 0) throw new Error('capacity history write made no progress');
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
}

function byTime(a: CapacityHistoryRow, b: CapacityHistoryRow): number {
  return Date.parse(a.ts) - Date.parse(b.ts);
}

interface CompactEntry {
  row: CapacityHistoryRow;
  t: number;
  key: string;
  line: string;
  /** The line's bytes plus its newline. */
  bytes: number;
}

function totalBytes(entries: readonly CompactEntry[]): number {
  return entries.reduce((n, e) => n + e.bytes, 0);
}

/**
 * One thinning step (HISTORY_THIN_STEPS): entries at or after `nowMs − rawMs`
 * stay; each series' older entries keep only the first lowest and the first
 * highest reading of every epoch-aligned `slotMs` slot, in time order — plus
 * the series' own first and last entry, so thinning never shortens a line
 * (the window's start is exactly what the byte cap used to cut).
 * `entries` is in time order; so is the result.
 */
function thinEntries(entries: readonly CompactEntry[], nowMs: number, step: { rawMs: number; slotMs: number }): CompactEntry[] {
  const rawFrom = nowMs - step.rawMs;
  const keep = new Array<boolean>(entries.length).fill(false);
  const slots = new Map<string, { lo: number; hi: number }>();
  const ends = new Map<string, { first: number; last: number }>();
  entries.forEach((entry, i) => {
    const end = ends.get(entry.key);
    if (end) end.last = i;
    else ends.set(entry.key, { first: i, last: i });
    if (entry.t >= rawFrom) {
      keep[i] = true;
      return;
    }
    const id = `${entry.key}#${Math.floor(entry.t / step.slotMs)}`;
    const slot = slots.get(id);
    if (!slot) {
      slots.set(id, { lo: i, hi: i });
      return;
    }
    if (entry.row.usedPct < entries[slot.lo]!.row.usedPct) slot.lo = i;
    if (entry.row.usedPct > entries[slot.hi]!.row.usedPct) slot.hi = i;
  });
  for (const { lo, hi } of slots.values()) {
    keep[lo] = true;
    keep[hi] = true;
  }
  for (const { first, last } of ends.values()) {
    keep[first] = true;
    keep[last] = true;
  }
  return entries.filter((_, i) => keep[i]);
}

/**
 * Rewrite the file with rows younger than the keep window; duplicates (one
 * observation recorded by both recorders) and unreadable lines go too. Over
 * the compaction target, older rows are thinned per series
 * (HISTORY_THIN_STEPS) so every seat keeps its whole window, and only if the
 * coarsest step still does not fit are the oldest rows dropped. Atomic (temp
 * + fsync + rename, 0600). Returns the rows kept. Throws on a storage failure.
 */
export function compactCapacityHistory(file: string = capacityHistoryPath(), nowMs: number = Date.now()): number {
  const chunk = readChunk(file, MAX_READ_BYTES, 'tail');
  if (!chunk) return 0;
  const cutoff = nowMs - HISTORY_KEEP_MS;
  const seen = new Set<string>();
  let entries: CompactEntry[] = rowsOf(chunk)
    .filter((row) => Date.parse(row.ts) >= cutoff)
    .sort(byTime)
    .filter((row) => {
      const id = `${historySeriesKey(row.seat, row.window)}#${row.ts}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((row) => {
      const line = serializeRow(row);
      return { row, t: Date.parse(row.ts), key: historySeriesKey(row.seat, row.window), line, bytes: Buffer.byteLength(line) + 1 };
    });
  let total = totalBytes(entries);
  for (const step of HISTORY_THIN_STEPS) {
    if (total <= HISTORY_COMPACT_TARGET_BYTES) break;
    entries = thinEntries(entries, nowMs, step);
    total = totalBytes(entries);
  }
  // Last resort (a burst no thinning step can absorb): oldest first.
  let drop = 0;
  while (total > HISTORY_COMPACT_TARGET_BYTES && drop < entries.length) {
    total -= entries[drop]!.bytes;
    drop += 1;
  }
  const kept = entries.slice(drop).map((e) => e.line);
  writePrivateFileAtomic(file, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  return kept.length;
}

function needsCompaction(file: string, sizeAfter: number, nowMs: number): boolean {
  if (sizeAfter > HISTORY_MAX_BYTES) return true;
  const head = readChunk(file, HEAD_BYTES, 'head');
  if (!head || head.size === 0) return false;
  // Rows are appended in time order, so the first readable row is the oldest.
  const lines = head.text.split('\n');
  if (head.size > HEAD_BYTES) lines.pop(); // the head window may end mid-line
  for (const line of lines) {
    const row = parseHistoryLine(line);
    if (row) return Date.parse(row.ts) < nowMs - HISTORY_KEEP_MS - AGE_SLACK_MS;
  }
  // The file opens with garbage (a torn write, a hand edit): rewrite it clean.
  return true;
}

export interface CapacityHistoryWriteResult {
  appended: number;
  compacted: boolean;
  /** Why nothing could be written; null on success (including "nothing new"). */
  error: string | null;
}

function errorText(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return err instanceof Error ? err.message : 'unknown error';
}

const NOTHING: CapacityHistoryWriteResult = Object.freeze({ appended: 0, compacted: false, error: null });

/**
 * Record `seats` (one snapshot's readings) under the compression rule.
 * NEVER THROWS: history is a convenience beside the budget gate, never a
 * reason a publish or a budget read fails. Failures come back as `error`.
 * A no-op under ASHLR_CAPACITY_HISTORY=0 — this is the one door every
 * recorder (daemon, request path, follow) writes through.
 */
export function appendCapacityHistory(
  seats: readonly SeatCapacity[],
  opts: { source: CapacityHistorySource; nowMs?: number; file?: string; env?: NodeJS.ProcessEnv },
): CapacityHistoryWriteResult {
  if (capacityHistoryDisabled(opts.env)) return { ...NOTHING };
  const nowMs = opts.nowMs ?? Date.now();
  try {
    // Cheap pre-check (no I/O): a snapshot with nothing recordable touches no file.
    if (historyRowsFromSeats(seats, { nowMs, source: opts.source }).length === 0) return { ...NOTHING };
    const file = opts.file ?? capacityHistoryPath();
    ensurePrivateDirectory(dirname(file));
    const tail = readChunk(file, TAIL_BYTES, 'tail');
    // Each series' newest row. A series quiet for longer than the tail
    // window gets one extra row — harmless.
    const last = new Map<string, CapacityHistoryRow>();
    for (const row of tail ? rowsOf(tail) : []) {
      const key = historySeriesKey(row.seat, row.window);
      const prev = last.get(key);
      if (!prev || Date.parse(row.ts) >= Date.parse(prev.ts)) last.set(key, row);
    }
    // Each seat's newest weekly reset keeps a weekly-only Codex primary on
    // its weekly line through its last hours (historyWindowClass).
    const weeklyResetBySeat = new Map<string, string>();
    for (const row of last.values()) {
      if (row.window === 'weekly' && row.resetsAt) weeklyResetBySeat.set(row.seat, row.resetsAt);
    }
    const rows = historyRowsFromSeats(seats, { nowMs, source: opts.source, weeklyResetBySeat });
    const fresh: CapacityHistoryRow[] = [];
    for (const row of rows) {
      const key = historySeriesKey(row.seat, row.window);
      if (!shouldRecordRow(last.get(key), row)) continue;
      fresh.push(row);
      last.set(key, row);
    }
    if (fresh.length === 0) return { ...NOTHING };
    // After a torn last line, start on a fresh one so only the fragment is lost.
    const separator = tail && tail.size > 0 && !tail.endsWithNewline ? '\n' : '';
    const text = `${separator}${fresh.map(serializeRow).join('\n')}\n`;
    appendPrivate(file, text);
    let compacted = false;
    if (needsCompaction(file, (tail?.size ?? 0) + Buffer.byteLength(text), nowMs)) {
      compactCapacityHistory(file, nowMs);
      compacted = true;
    }
    return { appended: fresh.length, compacted, error: null };
  } catch (err) {
    return { appended: 0, compacted: false, error: errorText(err) };
  }
}

/**
 * Record a capacity snapshot — the one given, or (when `snapshot` is
 * undefined) the one on disk. A missing or unreadable snapshot records
 * nothing, and so does ASHLR_CAPACITY_HISTORY=0 (before any read). Never
 * throws.
 */
export function recordCapacityHistoryFromSnapshot(
  snapshot: CapacitySnapshot | null | undefined,
  source: CapacityHistorySource,
  opts: { nowMs?: number; file?: string; snapshotFile?: string; env?: NodeJS.ProcessEnv } = {},
): CapacityHistoryWriteResult {
  if (capacityHistoryDisabled(opts.env)) return { ...NOTHING };
  let snap: CapacitySnapshot | null = snapshot ?? null;
  if (snapshot === undefined) {
    try {
      snap = readCapacitySnapshot(opts.snapshotFile);
    } catch {
      snap = null;
    }
  }
  if (!snap) return { ...NOTHING };
  return appendCapacityHistory(snap.seats, { source, nowMs: opts.nowMs, file: opts.file, env: opts.env });
}

/** Every readable row at or after `sinceMs`, in file order. Never throws. */
export function readCapacityHistory(opts: { sinceMs?: number; file?: string } = {}): CapacityHistoryRow[] {
  try {
    const chunk = readChunk(opts.file ?? capacityHistoryPath(), MAX_READ_BYTES, 'tail');
    if (!chunk) return [];
    const since = opts.sinceMs ?? Number.NEGATIVE_INFINITY;
    return rowsOf(chunk).filter((row) => Date.parse(row.ts) >= since);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

type Point = [number, number];

/** Drop the interior points of every flat run: its first and last reading draw the same line. */
export function collapseFlatRuns(points: readonly Point[]): Point[] {
  return points.filter((p, i) => i === 0 || i === points.length - 1 || p[1] !== points[i - 1]![1] || p[1] !== points[i + 1]![1]);
}

/** `max` points spread evenly over `points`, first and last always kept. */
function thinEvenly(points: readonly Point[], max: number): Point[] {
  if (points.length <= max) return [...points];
  const out: Point[] = [];
  let previous = -1;
  for (let i = 0; i < max; i++) {
    const index = Math.round((i * (points.length - 1)) / (max - 1));
    if (index !== previous) out.push(points[index]!);
    previous = index;
  }
  return out;
}

/** Group `rows` into bounded per-seat-window series for the last `days`. Pure. */
export function buildCapacityHistoryResponse(
  rows: readonly CapacityHistoryRow[],
  opts: { nowMs: number; days: number },
): CapacityHistoryResponse {
  const sinceMs = opts.nowMs - opts.days * DAY;
  const groups = new Map<string, { seatId: string; window: CapacityHistoryWindow; rows: { t: number; used: number; resetsAt: string | null }[] }>();
  for (const row of rows) {
    const t = Date.parse(row.ts);
    if (!(t >= sinceMs) || t > opts.nowMs + FUTURE_SKEW_MS) continue;
    const key = historySeriesKey(row.seat, row.window);
    let group = groups.get(key);
    if (!group) {
      group = { seatId: row.seat, window: row.window, rows: [] };
      groups.set(key, group);
    }
    group.rows.push({ t, used: row.usedPct, resetsAt: row.resetsAt });
  }
  const keys = [...groups.keys()].sort();
  let oldest = Number.POSITIVE_INFINITY;
  const series: CapacityHistorySeries[] = keys.slice(0, HISTORY_MAX_SERIES).map((key) => {
    const group = groups.get(key)!;
    // Stable sort, then one point per instant: both recorders may have seen
    // the same observation; the later-written row wins.
    const sorted = [...group.rows].sort((a, b) => a.t - b.t);
    const unique: typeof sorted = [];
    for (const r of sorted) {
      if (unique.length > 0 && unique[unique.length - 1]!.t === r.t) unique[unique.length - 1] = r;
      else unique.push(r);
    }
    const collapsed = collapseFlatRuns(unique.map((r): Point => [r.t, r.used]));
    const thinned = collapsed.length > HISTORY_MAX_POINTS_PER_SERIES;
    const points = thinned ? thinEvenly(collapsed, HISTORY_MAX_POINTS_PER_SERIES) : collapsed;
    oldest = Math.min(oldest, points[0]![0]);
    return { seatId: group.seatId, window: group.window, points, resetsAt: unique[unique.length - 1]!.resetsAt, thinned };
  });
  return {
    v: 1,
    generatedAt: new Date(opts.nowMs).toISOString(),
    days: opts.days,
    since: new Date(sinceMs).toISOString(),
    oldestAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    series,
    truncated: keys.length > HISTORY_MAX_SERIES,
  };
}
