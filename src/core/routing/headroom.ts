/**
 * Live headroom per seat — how much of each seat autonomy may still use under
 * its budget policy (V3.10 unit A9).
 *
 * INPUT is a `SeatCapacity`: the public Verse seat projection (the same
 * windows `GET /api/verse/accounts` serves — Claude `five_hour`/`seven_day`,
 * Codex `codex_<bucket>_{primary,secondary}`, Grok's billing period) reduced to
 * what budgeting needs. OUTPUT is the contract's `SeatHeadroom`, plus the
 * reopening time the router needs for `SeatExclusion.nextEligibleAt`.
 *
 * HONESTY RULES (docs/VERSE-TELEMETRY-V2.md, and Mason's decision):
 *  - Unknown usage is NOT headroom. A paid seat with no reading, a reported
 *    account window with a null percent, or a reading older than
 *    `readingMaxAgeMs` is ineligible for autonomy. This is the fix for the old
 *    Claude fail-open, where "no signal" was treated as "go ahead".
 *  - A spent PER-MODEL window is not a spent account. Claude's
 *    `seven_day_fable` can read 100% while `five_hour` reads 15%; only the
 *    account-wide windows bind (seats.ts `seatUsability` has the same rule).
 *  - Claude publishes no machine-readable reset. Its reset is quoted in the
 *    provider's own words and never turned into a timestamp or a countdown.
 *  - Codex credits are paid overage. Autonomy never spends them, so a spent
 *    Codex window blocks autonomy even when a balance exists.
 *
 * WINDOW SEMANTICS
 *  - `reservePercent` keeps that share of the LONG (weekly / billing-period)
 *    window for Mason: autonomy stops at `100 − reserve` used. A seat that
 *    reports only a short window applies the reserve to that one.
 *  - `maxSessionWindowPercent` is the ceiling on the SHORT (5-hour) window, so
 *    a live interactive session is never starved ("never touch Claude while
 *    its 5-hour window is above 70%").
 *  - The binding window is whichever of the two leaves autonomy LESS room.
 *
 * BROWSER-SAFE and PURE: type-only imports, no clock reads (callers pass
 * `nowMs`), no I/O.
 */
import type { VerseSeat, VerseSeatCapacity } from '../verse/types.js';
import type { BudgetEngine } from './policy.js';
import { reasonSentences } from './seat-reasons.js';
import type { SeatBudgetPolicy, SeatHeadroom, SeatReason } from './types.js';

/** A reading older than this is too stale to spend against (the collector polls every 30 s when active). */
export const HEADROOM_READING_MAX_AGE_MS = 15 * 60_000;

/**
 * A window whose reset is further away than this cannot be a 5-hour window,
 * whatever its id says. Codex's `primary` bucket is USUALLY the 5-hour window,
 * but on 2026-09-24 both accounts reported a `primary` resetting ~42 h out —
 * so the reset distance, when known, overrides the id.
 */
export const SESSION_WINDOW_MAX_MS = 5 * 60 * 60_000 + 15 * 60_000;

export type SeatWindowClass = 'session' | 'weekly' | 'model';

export interface CapacityWindow {
  id: string;
  /** Provider percent; null = NO SIGNAL (not zero). */
  usedPercent: number | null;
  /** Machine reset; always null for Claude. */
  resetsAt: string | null;
  /** The provider's own reset wording (Claude), verbatim. */
  resetDescription: string | null;
  /** Provider explicitly flagged the limit (a denial, not a measurement). */
  limitReached: boolean;
}

/** What the budget layer needs to know about one seat. JSON-safe; persisted in the capacity snapshot. */
export interface SeatCapacity {
  seatId: string;
  engine: BudgetEngine;
  label: string;
  /** True for local runtime seats: $0 and no provider window. */
  free: boolean;
  windows: CapacityWindow[];
  /** The account reports no usable login. */
  signedOut: boolean;
  /** Can a turn reach this seat at all? Null when unknown. */
  reachable: boolean | null;
  /** Default model's context window in tokens; null when unknown. */
  contextWindow: number | null;
  /** When the windows were read; null when never. */
  observedAt: string | null;
  /** Today's metered spend in USD; null when unknown or not metered. */
  spentTodayUsd: number | null;
}

/** `SeatHeadroom` plus the facts the router needs but the wire shape does not carry. */
export interface SeatAssessment {
  headroom: SeatHeadroom;
  /** When the blocking condition is expected to lift; null when unknown / never / not blocked. */
  reopensAt: string | null;
  /** True when usage is known to be spent (limit flagged or ≥ 100%) on an account window. */
  exhausted: boolean;
  /** True when usage evidence is missing, partial or stale. */
  unknownUsage: boolean;
  /** The sentences naming each spent account window (a subset of `headroom.reasons`). */
  spentReasons: string[];
  /** `headroom.reasons` as data (same order): each sentence without its reset clause, plus the reset. */
  details: SeatReason[];
  /** `spentReasons` as data. */
  spentDetails: SeatReason[];
}

export interface AssessOptions {
  nowMs: number;
  readingMaxAgeMs?: number;
}

// ---------------------------------------------------------------------------
// Projection from the public seat shape
// ---------------------------------------------------------------------------

/**
 * Reduce a public `VerseSeat` to a `SeatCapacity`. `liveCapacity`, when given,
 * replaces the seat's own (possibly cached) capacity — the caller re-reads
 * telemetry per request exactly as verse-api's `liveSeats` does.
 */
export function capacityFromSeat(seat: VerseSeat, liveCapacity?: VerseSeatCapacity | null): SeatCapacity {
  const free = seat.engine === 'local';
  const capacity = liveCapacity === undefined ? seat.capacity ?? null : liveCapacity;
  // A failed account check may retain a verified window for display until its
  // original expiry. Autonomy cannot spend against that prior reading.
  const current = !free && capacity &&
    (capacity.usability === 'ready' || capacity.usability === 'tight' || capacity.usability === 'exhausted')
    ? capacity : null;
  const windows: CapacityWindow[] = current === null ? [] : current.windows.map((w) => ({
    id: w.id,
    usedPercent: typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent)
      ? Math.max(0, Math.min(100, w.usedPercent))
      : null,
    resetsAt: w.resetsAt,
    resetDescription: w.resetDescription,
    limitReached: w.limitReached === true,
  }));
  const signedOut = !free && capacity?.usability === 'signed-out';
  return {
    seatId: seat.id,
    engine: seat.engine,
    label: seat.label,
    free,
    windows,
    signedOut,
    // A local seat is only listed when the runtime answered discovery. A
    // native seat is reachable unless signed out; "no reading" is a usage
    // question, not a reachability one.
    reachable: free ? true : signedOut ? false : null,
    contextWindow: typeof seat.contextWindow === 'number' && seat.contextWindow > 0 ? seat.contextWindow : null,
    observedAt: current === null ? null : current.observedAt ?? seat.health.observedAt ?? null,
    spentTodayUsd: null,
  };
}

// ---------------------------------------------------------------------------
// Window classification
// ---------------------------------------------------------------------------

function resetDistanceMs(window: CapacityWindow, nowMs: number): number | null {
  if (!window.resetsAt) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at - nowMs : null;
}

/** Which role a window plays for budgeting. Per-model windows never bind. */
export function classifyWindow(engine: BudgetEngine, window: CapacityWindow, nowMs: number): SeatWindowClass {
  const id = window.id;
  if (engine === 'claude') {
    if (id === 'five_hour') return 'session';
    if (id === 'seven_day') return 'weekly';
    if (id.startsWith('seven_day_')) return 'model';
  }
  if (engine === 'grok') return 'weekly';
  const distance = resetDistanceMs(window, nowMs);
  if (engine === 'codex') {
    if (id.endsWith('_secondary')) return 'weekly';
    if (id.endsWith('_primary')) return distance !== null && distance > SESSION_WINDOW_MAX_MS ? 'weekly' : 'session';
  }
  // Unknown id: only a reset we can SEE inside five hours makes it short.
  return distance !== null && distance <= SESSION_WINDOW_MAX_MS ? 'session' : 'weekly';
}

/** Human name for a window, for reasons. */
export function windowName(engine: BudgetEngine, window: CapacityWindow, cls: SeatWindowClass): string {
  if (cls === 'session') return '5-hour window';
  if (cls === 'model') {
    const model = window.id.startsWith('seven_day_') ? window.id.slice('seven_day_'.length) : window.id;
    return `${model.charAt(0).toUpperCase()}${model.slice(1)}-only weekly window`;
  }
  if (engine === 'grok' || window.id.endsWith('_monthly')) {
    return window.id.endsWith('_monthly') ? 'monthly billing window' : window.id.endsWith('_weekly') ? 'weekly window' : 'billing-period window';
  }
  return 'weekly window';
}

/**
 * A window's reset as data: the machine instant when there is one, else
 * Claude's own words, verbatim — never a synthesized time. `reasonSentence`
 * turns it back into the " (resets …)" clause the string form has always had.
 */
function resetOf(window: CapacityWindow): Pick<SeatReason, 'resetsAt' | 'resetDescription'> {
  if (window.resetsAt) return { resetsAt: window.resetsAt, resetDescription: null };
  return { resetsAt: null, resetDescription: window.resetDescription ?? null };
}

function isSpent(window: CapacityWindow): boolean {
  return window.limitReached || (window.usedPercent !== null && window.usedPercent >= 100);
}

function pct(value: number): string {
  return `${Math.round(value)}%`;
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

interface ClassedWindow {
  window: CapacityWindow;
  cls: SeatWindowClass;
}

/** The highest reading among `rows`, with its window; null when none carried a percent. */
function peak(rows: ClassedWindow[]): ClassedWindow | null {
  let best: ClassedWindow | null = null;
  for (const row of rows) {
    if (row.window.usedPercent === null) continue;
    if (best === null || row.window.usedPercent > best.window.usedPercent!) best = row;
  }
  return best;
}

/**
 * When EVERY spent window in `rows` has reset — the seat is blocked until the
 * last of them does, so this is the latest reset. Null unless every row has a
 * machine-readable reset (one unknown reset makes the reopening unknown).
 */
function lastReset(rows: ClassedWindow[]): string | null {
  const times: string[] = [];
  for (const row of rows) {
    const at = row.window.resetsAt;
    if (!at || !Number.isFinite(Date.parse(at))) return null;
    times.push(at);
  }
  times.sort((a, b) => Date.parse(b) - Date.parse(a));
  return times[0] ?? null;
}

/** Full assessment of one seat for AUTONOMOUS use under `policy`. Pure. */
export function assessSeat(capacity: SeatCapacity, policy: SeatBudgetPolicy, opts: AssessOptions): SeatAssessment {
  const { nowMs } = opts;
  const maxAge = opts.readingMaxAgeMs ?? HEADROOM_READING_MAX_AGE_MS;
  // Reasons are built as data; `headroom.reasons` is derived from them.
  const details: SeatReason[] = [];

  // ── Local: free, windowless, bounded only by reachability ──────────────
  if (capacity.free) {
    const reachable = capacity.reachable !== false;
    if (!policy.enabled) details.push({ kind: 'switched-off', text: 'Autonomy is switched off for this seat.' });
    if (!reachable) details.push({ kind: 'unreachable', text: 'The local model runtime is not reachable.' });
    const eligible = policy.enabled && reachable;
    if (eligible) details.push({ kind: 'headroom', text: 'Local model — free, with no usage window to protect.' });
    return {
      headroom: {
        seatId: capacity.seatId,
        sessionUsedPercent: null,
        weeklyUsedPercent: null,
        bindingWindow: null,
        // No window binds a local seat; "all of it" is the honest number while
        // the runtime answers, and unknown while it does not.
        autonomyHeadroomPercent: reachable ? 100 : null,
        resetAt: null,
        eligibleForAutonomy: eligible,
        reasons: reasonSentences(details),
      },
      reopensAt: null,
      exhausted: false,
      unknownUsage: false,
      spentReasons: [],
      details,
      spentDetails: [],
    };
  }

  // ── Paid seat ──────────────────────────────────────────────────────────
  const classed: ClassedWindow[] = capacity.windows.map((window) => ({
    window,
    cls: classifyWindow(capacity.engine, window, nowMs),
  }));
  const account = classed.filter((row) => row.cls !== 'model');
  const sessionRows = account.filter((row) => row.cls === 'session');
  const weeklyRows = account.filter((row) => row.cls === 'weekly');
  const sessionPeak = peak(sessionRows);
  const weeklyPeak = peak(weeklyRows);
  const sessionUsed = sessionPeak?.window.usedPercent ?? null;
  const weeklyUsed = weeklyPeak?.window.usedPercent ?? null;

  // Evidence quality.
  const observedMs = capacity.observedAt ? Date.parse(capacity.observedAt) : NaN;
  const ageMs = Number.isFinite(observedMs) ? nowMs - observedMs : null;
  const stale = ageMs === null || ageMs > maxAge;
  const hasReading = sessionUsed !== null || weeklyUsed !== null;
  const nullWindow = account.find((row) => row.window.usedPercent === null && !row.window.limitReached);

  // Ceilings. The reserve protects the LONG window; with no long window it
  // protects the short one. The session ceiling protects a live session.
  const reserveCeiling = 100 - policy.reservePercent;
  const sessionCeiling = policy.maxSessionWindowPercent ?? 100;
  // With no long window the short one carries BOTH limits; say which one bit.
  const sessionLimitIsReserve = weeklyRows.length === 0 && reserveCeiling < sessionCeiling;
  const sessionLimit = sessionLimitIsReserve ? reserveCeiling : sessionCeiling;
  let weeklyRoom: number | null = null;
  let sessionRoom: number | null = null;
  if (weeklyUsed !== null) weeklyRoom = reserveCeiling - weeklyUsed;
  if (sessionUsed !== null) sessionRoom = sessionLimit - sessionUsed;
  let bindingWindow: SeatHeadroom['bindingWindow'] = null;
  let room: number | null = null;
  if (weeklyRoom !== null && (sessionRoom === null || weeklyRoom <= sessionRoom)) {
    bindingWindow = 'weekly';
    room = weeklyRoom;
  } else if (sessionRoom !== null) {
    bindingWindow = 'session';
    room = sessionRoom;
  }
  const bindingRow = bindingWindow === 'weekly' ? weeklyPeak : bindingWindow === 'session' ? sessionPeak : null;

  // Blockers, most fundamental first. Every one gets a plain sentence.
  let reopensAt: string | null = null;
  const spentRows = account.filter((row) => isSpent(row.window));
  const exhausted = spentRows.length > 0;
  const unknownUsage = !hasReading || stale || nullWindow !== undefined;

  if (!policy.enabled) details.push({ kind: 'switched-off', text: 'Autonomy is switched off for this seat.' });
  if (capacity.signedOut) {
    details.push({ kind: 'signed-out', text: 'Signed out — reconnect this account before anything can run on it.' });
  }

  const spentDetails: SeatReason[] = [];
  if (exhausted) {
    for (const row of spentRows) {
      const used = row.window.limitReached ? 'limit reached' : `${pct(row.window.usedPercent!)} used`;
      spentDetails.push({
        kind: 'spent',
        text: `The ${windowName(capacity.engine, row.window, row.cls)} is spent — ${used}.`,
        ...resetOf(row.window),
      });
    }
    details.push(...spentDetails);
    reopensAt = lastReset(spentRows);
  }

  if (!hasReading) {
    details.push({
      kind: 'unknown-usage',
      text: account.length === 0
        ? 'No usage reading for this seat — unknown usage is not headroom, so autonomy stays off it.'
        : 'Its usage windows carried no percentage — unknown usage is not headroom, so autonomy stays off it.',
    });
  } else if (stale) {
    details.push({
      kind: 'unknown-usage',
      text: ageMs === null
        ? 'The usage reading has no timestamp — too uncertain to spend against.'
        : `The usage reading is ${formatAge(ageMs)} old — too stale to spend against (limit ${formatAge(maxAge)}).`,
    });
  } else if (nullWindow) {
    details.push({
      kind: 'unknown-usage',
      text: `The ${windowName(capacity.engine, nullWindow.window, nullWindow.cls)} carried no percentage — `
        + 'unknown usage is not headroom.',
    });
  }

  const usdCap = policy.dailyUsdCap;
  let overUsd = false;
  if (usdCap !== undefined) {
    if (capacity.spentTodayUsd === null) {
      overUsd = true;
      details.push({ kind: 'spend-cap', text: `A $${usdCap.toFixed(2)} daily cap is set but today's spend on this seat is unknown.` });
    } else if (capacity.spentTodayUsd >= usdCap) {
      overUsd = true;
      details.push({ kind: 'spend-cap', text: `Spent $${capacity.spentTodayUsd.toFixed(2)} of its $${usdCap.toFixed(2)} daily cap.` });
    }
  }

  // Ceiling reasons only matter when the reading itself is trustworthy.
  const ceilingBlocked = !exhausted && !unknownUsage && room !== null && room <= 0;
  if (ceilingBlocked && bindingRow) {
    const name = windowName(capacity.engine, bindingRow.window, bindingRow.cls);
    const used = pct(bindingRow.window.usedPercent!);
    if (bindingWindow === 'session' && !sessionLimitIsReserve) {
      details.push({
        kind: 'session-ceiling',
        text: `The ${name} is ${used} used; autonomy stops at ${pct(sessionLimit)} to protect your live session.`,
        ...resetOf(bindingRow.window),
      });
    } else {
      details.push({
        kind: 'reserve',
        text: `The ${name} is ${used} used; ${pct(policy.reservePercent)} is kept for you, so autonomy `
          + `stops at ${pct(reserveCeiling)}.`,
        ...resetOf(bindingRow.window),
      });
    }
    reopensAt = bindingRow.window.resetsAt;
  }

  // Model-scoped windows are facts worth showing, never blockers.
  for (const row of classed) {
    if (row.cls === 'model' && isSpent(row.window)) {
      details.push({
        kind: 'model-window',
        text: `The ${windowName(capacity.engine, row.window, row.cls)} is spent — it limits that model only, not the account.`,
      });
    }
  }

  const eligible = policy.enabled && !capacity.signedOut && !exhausted && !unknownUsage && !overUsd
    && room !== null && room > 0;
  if (eligible && bindingRow) {
    const name = windowName(capacity.engine, bindingRow.window, bindingRow.cls);
    const kept = bindingWindow === 'weekly' || sessionLimitIsReserve
      ? policy.reservePercent > 0 ? ` (${pct(policy.reservePercent)} kept for you)` : ''
      : sessionLimit < 100 ? ` (autonomy stops at ${pct(sessionLimit)} to protect your live session)` : '';
    details.unshift({ kind: 'headroom', text: `${pct(room!)} of the ${name} is left for autonomy${kept}.` });
  }

  return {
    headroom: {
      seatId: capacity.seatId,
      sessionUsedPercent: sessionUsed,
      weeklyUsedPercent: weeklyUsed,
      bindingWindow,
      autonomyHeadroomPercent: room === null ? null : Math.max(0, Math.round(room)),
      resetAt: bindingRow?.window.resetsAt ?? null,
      eligibleForAutonomy: eligible,
      reasons: reasonSentences(details),
    },
    // A seat that is merely switched off, signed out, or unknown has no
    // known reopening — only a window reset is a date we can name.
    reopensAt: !policy.enabled || capacity.signedOut || unknownUsage || overUsd ? null : reopensAt,
    exhausted,
    unknownUsage,
    spentReasons: reasonSentences(spentDetails),
    details,
    spentDetails,
  };
}

/** The contract's `SeatHeadroom` for one seat. */
export function computeHeadroom(capacity: SeatCapacity, policy: SeatBudgetPolicy, opts: AssessOptions): SeatHeadroom {
  return assessSeat(capacity, policy, opts).headroom;
}
