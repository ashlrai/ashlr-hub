/**
 * Reserve-breach detection — V3.10 Track B, 3.10 review findings c3 / c4.
 *
 * Every signed rollout stage requires `reserveBreaches: 0`, and one breach
 * regresses the ladder a rung (rollout.ts). Until this module nothing wrote a
 * `reserve:breach` row, so that criterion was always met and the regression
 * could never fire: invariant I5 ("Mason's reserve is never spent") was only
 * enforced BEFORE dispatch (routing/headroom.ts refuses a seat at or past its
 * line) and never observed after it. This module is the observer.
 *
 * WHAT A BREACH IS. Autonomy used a paid seat and the seat's usage is now PAST
 * the line the grant signed for it:
 *   - weekly (long) window above `100 − reserveFloorPercent`, or
 *   - 5-hour (short) window above `maxSessionWindowPercent`
 *     (a seat that reports only a short window carries the reserve on it too,
 *     exactly as headroom.ts applies it).
 * The pre-dispatch gate admits work only while the reading is under the line,
 * so a breach is the in-flight overshoot: a run admitted at 68% of the 5-hour
 * window that finishes at 78%.
 *
 * WHY ATTRIBUTION MATTERS. Mason's own interactive use crosses the same lines
 * all the time — that is what the reserve is FOR. Counting his crossing as an
 * autonomy breach would regress the ladder every time he works hard, which is
 * both wrong and a liveness trap. So a crossing counts only when autonomy used
 * the seat in the ATTRIBUTION_LOOKBACK_MS before the reading: seats the caller
 * names (`usedSeatIds`, e.g. the dispatch it just finished) plus seats the
 * routing log shows autonomous work was sent to (decisions.jsonl, sources
 * `daemon` / `best-of-n` / `leader`). When both autonomy and Mason were on
 * the seat, the crossing counts — the conservative reading for a
 * zero-tolerance criterion (a regression only ever narrows authority).
 *
 * ONE ROW PER EPISODE. A weekly window stays over its line until it resets,
 * and every tick sees it again. Recording each sighting would regress the
 * ladder one rung per tick all the way down. So the detector remembers which
 * (seat, window) pairs are over the line and whether that episode was already
 * charged to autonomy (`reserve-watch.json`, 0600, in the authority dir,
 * written under the ledger lock). A charged episode is never recorded again; an
 * UNcharged one (Mason crossed) is re-checked on later calls, because a caller
 * that knows a run just used the seat (`usedSeatIds`, from the dispatch path)
 * may arrive after the per-tick check that saw no routing evidence. A fresh
 * reading back under the line re-arms the pair. If the file is missing or
 * unreadable, a breach row for the same seat and window within the window's
 * length stands in for it (never double-count after a lost state file).
 *
 * UNKNOWN IS NOT A BREACH. A missing, stale (> HEADROOM_READING_MAX_AGE_MS)
 * or null reading proves nothing either way; headroom.ts already keeps
 * autonomy off such a seat. Local (free) seats have no line.
 *
 * Callers: capability.ts runs the detector on EVERY standing tick, inside the
 * same ledger transaction as the rollout step, so a breach regresses the
 * ladder on the tick it is seen. `recordReserveBreaches` is the same thing as
 * an API for callers that hold a fresher snapshot or know which seats a run
 * just used.
 */
import { join } from 'node:path';

import type { ReserveBreachRecord } from '../fleet/fleet-types.js';
import {
  readCapacitySnapshot,
  readShadowDecisions,
  sanitizeSeatCapacity,
  type ShadowDecisionRecord,
} from '../routing/budget-store.js';
import { HEADROOM_READING_MAX_AGE_MS, classifyWindow, type SeatCapacity } from '../routing/headroom.js';
import {
  authorityDir,
  readPrivateText,
  withLedgerTransaction,
  writePrivateAtomically,
  type LedgerEvidenceRow,
  type LedgerTransaction,
} from './ledger.js';
import type { EffectivePolicy } from './types.js';

/**
 * A crossing is charged to autonomy when autonomy was routed to the seat this
 * long before the reading. Two hours covers a long sandboxed run that was
 * admitted under the line and is still spending when the next reading lands.
 */
export const ATTRIBUTION_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Fallback dedupe span per window when the watch file is lost: the window's own length. */
const EPISODE_SPAN_MS: Readonly<Record<ReserveBreachRecord['window'], number>> = Object.freeze({
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});

/** A reading this far in the future is a clock problem, not evidence. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const WATCH_FILE = 'reserve-watch.json';
const WATCH_MAX_BYTES = 64 * 1024;
const WATCH_MAX_KEYS = 256;
/** Routing-log rows scanned for attribution (newest first). */
const ATTRIBUTION_SCAN_ROWS = 500;
const AUTONOMOUS_SOURCES: ReadonlySet<ShadowDecisionRecord['source']> = new Set(['daemon', 'best-of-n', 'leader']);

export interface ReserveWatchEntry {
  /** Last fresh reading was past the line. */
  over: boolean;
  /** That reading's observedAt. */
  at: string;
  /** This over-the-line episode is already on the ledger as a breach. */
  recorded: boolean;
}

/** Keyed `${seatId}|${window}`. */
export type ReserveWatchState = Record<string, ReserveWatchEntry>;

export interface ReserveBreachDetection {
  breaches: ReserveBreachRecord[];
  /** The watch state after these readings. */
  state: ReserveWatchState;
}

function watchKey(seatId: string, window: ReserveBreachRecord['window']): string {
  return `${seatId}|${window}`;
}

/** The seats a capacity input carries: a CapacitySnapshot, `{ seats }`, or a bare array. Invalid seats are dropped. */
export function capacitySeatsOf(capacity: unknown): SeatCapacity[] {
  const list = Array.isArray(capacity)
    ? capacity
    : typeof capacity === 'object' && capacity !== null && Array.isArray((capacity as { seats?: unknown }).seats)
      ? (capacity as { seats: unknown[] }).seats
      : [];
  const out: SeatCapacity[] = [];
  for (const raw of list.slice(0, 64)) {
    const seat = sanitizeSeatCapacity(raw);
    if (seat) out.push(seat);
  }
  return out;
}

interface WindowReading {
  window: ReserveBreachRecord['window'];
  usedPercent: number;
  limitPercent: number;
}

/**
 * The lines one seat must stay under and where its fresh reading stands.
 * Mirrors headroom.ts assessSeat: per-model windows never bind, the reserve
 * protects the long window (or the short one when it is the only one), the
 * session ceiling protects the short one. A window with no percent is skipped
 * (unknown, not over) unless the provider flagged its limit (a spent window
 * is 100% by definition).
 */
function windowReadings(seat: SeatCapacity, reserveFloorPercent: number, maxSessionWindowPercent: number | null, nowMs: number): WindowReading[] {
  let weekly: number | null = null;
  let session: number | null = null;
  let hasWeeklyWindow = false;
  for (const window of seat.windows) {
    const cls = classifyWindow(seat.engine, window, nowMs);
    if (cls === 'model') continue;
    if (cls === 'weekly') hasWeeklyWindow = true;
    const used = window.limitReached ? 100 : window.usedPercent;
    if (used === null) continue;
    if (cls === 'weekly') weekly = Math.max(weekly ?? 0, used);
    else session = Math.max(session ?? 0, used);
  }
  const reserveLine = 100 - reserveFloorPercent;
  const out: WindowReading[] = [];
  if (weekly !== null) out.push({ window: 'weekly', usedPercent: weekly, limitPercent: reserveLine });
  if (session !== null) {
    const sessionLine = hasWeeklyWindow
      ? maxSessionWindowPercent
      : Math.min(maxSessionWindowPercent ?? 100, reserveLine);
    if (sessionLine !== null) out.push({ window: 'session', usedPercent: session, limitPercent: sessionLine });
  }
  return out;
}

/**
 * PURE: the breaches in `seats` under `policy`, given the watch state and the
 * breach rows already on the ledger. `autonomyUsed(seatId, sinceMs)` answers
 * "was autonomy routed to this seat at or after sinceMs".
 */
export function detectReserveBreaches(input: {
  seats: readonly SeatCapacity[];
  policy: Pick<EffectivePolicy, 'spend'>;
  nowMs: number;
  state: ReserveWatchState | null;
  priorBreaches: readonly Pick<LedgerEvidenceRow, 'at' | 'seatId' | 'window'>[];
  autonomyUsed: (seatId: string, sinceMs: number) => boolean;
}): ReserveBreachDetection {
  const { nowMs } = input;
  const state: ReserveWatchState = { ...(input.state ?? {}) };
  const breaches: ReserveBreachRecord[] = [];
  const seen = new Set<string>();
  for (const seat of input.seats) {
    if (seat.free || seen.has(seat.seatId)) continue;
    seen.add(seat.seatId);
    const seatPolicy = Object.prototype.hasOwnProperty.call(input.policy.spend.seats, seat.seatId)
      ? input.policy.spend.seats[seat.seatId]
      : undefined;
    // A seat the grant does not let autonomy use cannot be breached BY autonomy.
    if (!seatPolicy || !seatPolicy.enabled) continue;
    const observedMs = seat.observedAt ? Date.parse(seat.observedAt) : NaN;
    if (!Number.isFinite(observedMs)) continue;
    if (nowMs - observedMs > HEADROOM_READING_MAX_AGE_MS || observedMs - nowMs > MAX_CLOCK_SKEW_MS) continue;
    const observedAt = new Date(observedMs).toISOString();
    for (const reading of windowReadings(seat, seatPolicy.reserveFloorPercent, seatPolicy.maxSessionWindowPercent, nowMs)) {
      const key = watchKey(seat.seatId, reading.window);
      const previous = input.state ? input.state[key] : undefined;
      const over = reading.usedPercent > reading.limitPercent;
      // Never move the watch backwards in time (an older snapshot after a newer one).
      if (previous && Date.parse(previous.at) > observedMs) continue;
      if (!over) {
        state[key] = { over: false, at: observedAt, recorded: false };
        continue;
      }
      if (previous?.over === true && previous.recorded) {
        state[key] = { over: true, at: observedAt, recorded: true }; // same episode, already charged
        continue;
      }
      if (!previous) {
        // Lost or first-ever watch state: the ledger is the memory.
        const span = EPISODE_SPAN_MS[reading.window];
        const onRecord = input.priorBreaches.some((row) => row.seatId === seat.seatId && row.window === reading.window
          && observedMs - Date.parse(row.at) < span);
        if (onRecord) {
          state[key] = { over: true, at: observedAt, recorded: true };
          continue;
        }
      }
      const charged = input.autonomyUsed(seat.seatId, observedMs - ATTRIBUTION_LOOKBACK_MS);
      state[key] = { over: true, at: observedAt, recorded: charged };
      if (!charged) continue;
      breaches.push({
        v: 1,
        seatId: seat.seatId,
        window: reading.window,
        usedPercent: Math.round(reading.usedPercent * 10) / 10,
        limitPercent: reading.limitPercent,
        at: observedAt,
      });
    }
  }
  // Bounded: drop the oldest keys if a misbehaving source floods seat ids.
  const keys = Object.keys(state);
  if (keys.length > WATCH_MAX_KEYS) {
    keys.sort((a, b) => Date.parse(state[a]!.at) - Date.parse(state[b]!.at));
    for (const key of keys.slice(0, keys.length - WATCH_MAX_KEYS)) delete state[key];
  }
  return { breaches, state };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

export function reserveWatchPath(): string {
  return join(authorityDir(), WATCH_FILE);
}

/** null = missing or unreadable (the caller falls back to the ledger for dedupe). */
function readWatchState(): ReserveWatchState | null {
  const read = readPrivateText(reserveWatchPath(), WATCH_MAX_BYTES);
  if (read.state !== 'ok') return null;
  try {
    const raw = JSON.parse(read.text) as { v?: unknown; seats?: unknown };
    if (raw.v !== 1 || typeof raw.seats !== 'object' || raw.seats === null || Array.isArray(raw.seats)) return null;
    const out: ReserveWatchState = {};
    for (const [key, value] of Object.entries(raw.seats as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as { over?: unknown; at?: unknown; recorded?: unknown };
      if (typeof entry.over !== 'boolean' || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) continue;
      out[key] = { over: entry.over, at: entry.at, recorded: entry.recorded === true };
    }
    return out;
  } catch {
    return null;
  }
}

/** Seats the routing log shows autonomy was sent to (newest first). Never throws. */
function routedAutonomySeats(): { seatId: string; atMs: number }[] {
  let records: ShadowDecisionRecord[];
  try {
    records = readShadowDecisions(ATTRIBUTION_SCAN_ROWS);
  } catch {
    return [];
  }
  const out: { seatId: string; atMs: number }[] = [];
  for (const record of records) {
    if (!AUTONOMOUS_SOURCES.has(record.source)) continue;
    // `actual` null = held (nothing ran) — except the Leader, which records
    // its routed seat before the call and never fills `actual`.
    const seatId = record.actual
      ? record.actual.seatId ?? record.decision.seatId
      : record.source === 'leader' ? record.decision.seatId : null;
    const atMs = Date.parse(record.at);
    if (seatId && Number.isFinite(atMs)) out.push({ seatId, atMs });
  }
  return out;
}

/**
 * Detect and ledger reserve breaches INSIDE an open ledger transaction (the
 * rollout step then sees them). Returns the rows written. Throws when the
 * ledger refuses a row — the caller's transaction fails closed.
 */
export function recordReserveBreachesUnderLock(
  tx: LedgerTransaction,
  input: { capacity: unknown; policy: EffectivePolicy; nowMs: number; usedSeatIds?: readonly string[] },
): number {
  if (tx.snapshot.chain === 'broken') return 0;
  const seats = capacitySeatsOf(input.capacity);
  if (seats.length === 0) return 0;
  const named = new Set(input.usedSeatIds ?? []);
  let routed: { seatId: string; atMs: number }[] | null = null;
  const detection = detectReserveBreaches({
    seats,
    policy: input.policy,
    nowMs: input.nowMs,
    state: readWatchState(),
    priorBreaches: tx.snapshot.index.evidence.filter((row) => row.kind === 'reserve:breach'),
    autonomyUsed: (seatId, sinceMs) => {
      if (named.has(seatId)) return true;
      // Read lazily: only a crossing needs the routing log.
      routed ??= routedAutonomySeats();
      return routed.some((use) => use.seatId === seatId && use.atMs >= sinceMs);
    },
  });
  for (const breach of detection.breaches) {
    tx.append({ kind: 'reserve:breach', actor: 'daemon', grantId: input.policy.grantId, repo: null, data: breach });
  }
  // After the rows: a crash between the two re-detects from the ledger
  // (fallback dedupe), it never loses a breach.
  try {
    writePrivateAtomically(reserveWatchPath(), `${JSON.stringify({ v: 1, seats: detection.state })}\n`);
  } catch {
    // The watch file is a dedupe aid; the ledger rows above are the record.
  }
  return detection.breaches.length;
}

/**
 * Compare the capacity snapshot with the grant's reserve lines and ledger a
 * `reserve:breach` row for each seat autonomy used past its line. Resolves to
 * the number of rows written; rejects when the ledger refused them.
 * `capacity` defaults to nothing: pass the snapshot you hold (or
 * `readCapacitySnapshot()`); `usedSeatIds` names seats a caller KNOWS
 * autonomy just used (in addition to the routing log).
 */
export async function recordReserveBreaches(input: {
  capacity: unknown;
  policy: EffectivePolicy;
  now?: Date;
  usedSeatIds?: readonly string[];
}): Promise<number> {
  const nowMs = (input.now ?? new Date()).getTime();
  const result = withLedgerTransaction((tx) => recordReserveBreachesUnderLock(tx, {
    capacity: input.capacity,
    policy: input.policy,
    nowMs,
    ...(input.usedSeatIds ? { usedSeatIds: input.usedSeatIds } : {}),
  }));
  if (!result.ok) throw new Error(`reserve breach detection failed: ${result.reason}`);
  return result.value;
}

/** The persisted capacity snapshot, for the per-tick check (null = none; nothing to judge). */
export function currentCapacityForBreachCheck(): unknown {
  try {
    return readCapacitySnapshot();
  } catch {
    return null;
  }
}
