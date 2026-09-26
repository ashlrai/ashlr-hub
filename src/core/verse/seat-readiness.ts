/**
 * core/verse/seat-readiness.ts — "can this seat run a turn right now, and if
 * not, where else can the operator go?" (V3.10, unit A2).
 *
 * PURE and BROWSER-SAFE on purpose: the engine's admission gate
 * (`getSeatReadiness` in core/verse/seats.ts) and the Composer's block
 * (web-ui/routes/verse/health/ComposerSeatBlock.tsx) must give the SAME
 * answer, with the SAME ranked alternatives, or the UI would offer a seat the
 * server then refuses. One implementation, imported by both. Type-only
 * imports and `Intl` only — no node: modules.
 *
 * ── WHAT BLOCKS A SEAT ─────────────────────────────────────────────────────
 * Only POSITIVE evidence that a turn would fail at the provider:
 *   - `signed-out` — the CLI said so (status command or the live collector).
 *   - `exhausted`  — every window that carried a reading is spent and no
 *                    Codex credit balance remains (`seatUsability` in seats.ts;
 *                    a spent per-model window beside a healthy account-wide
 *                    one is `tight`, not exhausted).
 * `unknown`, `expiring` and `binary-skew` are WARNINGS, never refusals: an
 * admission gate that refused on "we could not read it" would lock Mason out
 * of his own seats every time a probe hiccuped (docs/VERSE-TELEMETRY-V2.md —
 * no signal is not a verdict).
 *
 * ── HOW ALTERNATIVES ARE RANKED ────────────────────────────────────────────
 * (research r2/accounts.md, recommendation 4): other subscription seats with
 * measured headroom first, then subscription seats whose headroom is tight or
 * unread, then local models (free, always last because they are the weakest).
 * Inside a tier the SAME ENGINE leads (a Codex user blocked on one account most
 * likely wants the other Codex account), then the lower binding-window
 * percentage, then discovery order. A seat with no runnable model, a local
 * seat whose runtime is not answering, or a seat that is itself blocked is
 * never offered.
 */
import type { SeatConnection, SeatHealthReport, SeatReadiness } from './health-types.js';
import type { VerseSeat } from './types.js';

/** The only connections that refuse a turn. Everything else is a warning. */
export const SEAT_BLOCKING_CONNECTIONS: ReadonlySet<SeatConnection> = new Set<SeatConnection>(['signed-out', 'exhausted']);

/** At most this many alternatives are offered — a list, not a directory. */
export const SEAT_MAX_ALTERNATIVES = 5;

export interface SeatBlock {
  connection: 'signed-out' | 'exhausted';
  /** One plain sentence naming the seat and the fact ("Personal Codex is out of usage — resets Fri 2:25 PM."). */
  reason: string;
  /** Machine-readable reset instant, when the provider gave one. */
  resetAt: string | null;
}

function reportFor(reports: readonly SeatHealthReport[] | null | undefined, seatId: string): SeatHealthReport | null {
  if (!reports) return null;
  for (const report of reports) if (report.seatId === seatId) return report;
  return null;
}

/**
 * A reset instant as a short local phrase ("Fri 2:25 PM", "Sep 30, 2:25 PM"),
 * or null when `iso` is not a valid instant. Only a MACHINE-READABLE instant
 * is ever formatted — Claude's prose reset never reaches this function.
 */
export function describeResetAt(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (new Date(now).toDateString() === date.toDateString()) return `today ${time}`;
  // Within the coming week the weekday is the clearest name for a day.
  if (at > now && at - now < 6 * 24 * 60 * 60 * 1000) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

/** When a spent seat reopens, as a machine-readable instant and/or the provider's own words. */
export interface SeatReopening {
  /** ISO instant the LAST spent window resets; null when any spent window gave only prose (or nothing). */
  resetAt: string | null;
  /** Provider reset wording to show when `resetAt` is null (Claude publishes prose only). */
  resetDescription: string | null;
}

function parseableInstant(iso: string | null | undefined): iso is string {
  return typeof iso === 'string' && Number.isFinite(Date.parse(iso));
}

type CapacityWindow = NonNullable<VerseSeat['capacity']>['windows'][number];

function isSpentWindow(w: CapacityWindow): boolean {
  return w.limitReached || (w.usedPercent !== null && w.usedPercent >= 100);
}

/**
 * When a spent seat is usable again: the LATEST reset among its spent
 * windows. A seat reopens only once EVERY spent window has reset — a Codex
 * seat whose 5-hour window resets in 2h but whose weekly window is spent
 * until Wednesday is still spent in 2h. `capacity.binding` cannot answer
 * this: `bindingWindow` (accounts.ts) keeps the FIRST window among equal
 * percentages, so two windows at 100% named whichever the provider listed
 * first — usually the earlier reset. This is the server twin of the web's
 * `seatReopensAt` (routes/verse/seat-subscription.ts), Fleet's
 * `eligibleAgain` and the router's headroom `lastReset`, so every surface
 * names the same instant.
 *
 *   - a spent window with only provider prose → `resetAt` null (prose is
 *     never parsed, and "when all of them have reset" is then unknown); that
 *     window's prose is returned instead;
 *   - nothing spent → the binding window's own reset, as before.
 */
export function seatReopening(capacity: VerseSeat['capacity'] | null | undefined): SeatReopening {
  if (!capacity) return { resetAt: null, resetDescription: null };
  const spent = capacity.windows.filter(isSpentWindow);
  if (spent.length === 0) {
    const binding = capacity.binding;
    return {
      resetAt: binding !== null && parseableInstant(binding.resetsAt) ? binding.resetsAt : null,
      resetDescription: binding?.resetDescription ?? null,
    };
  }
  const unknown = spent.filter((w) => !parseableInstant(w.resetsAt));
  if (unknown.length > 0) {
    return { resetAt: null, resetDescription: unknown.find((w) => w.resetDescription !== null)?.resetDescription ?? null };
  }
  const latest = spent.reduce((a, b) => (Date.parse(b.resetsAt!) > Date.parse(a.resetsAt!) ? b : a));
  return { resetAt: latest.resetsAt, resetDescription: latest.resetDescription };
}

/**
 * Why `seat` cannot take a turn, or null when nothing positively blocks it.
 *
 * The health report (sweep + live telemetry) wins when present; without one
 * the seat's own `capacity.usability` — which is on every native seat the
 * server serves — is the fallback, so the seat picker can mark a blocked seat
 * before the health endpoint has ever been read.
 */
export function seatBlock(
  seat: VerseSeat,
  report: SeatHealthReport | null,
  now: number = Date.now(),
): SeatBlock | null {
  let connection: SeatBlock['connection'] | null = null;
  let resetAt: string | null = null;
  if (report !== null) {
    if (report.connection === 'signed-out' || report.connection === 'exhausted') {
      connection = report.connection;
      resetAt = report.resetAt;
    }
  } else if (seat.engine !== 'local') {
    const usability = seat.capacity?.usability;
    if (usability === 'signed-out' || usability === 'exhausted') {
      connection = usability;
      // The latest spent-window reset, the same instant the health report names.
      resetAt = usability === 'exhausted' ? seatReopening(seat.capacity).resetAt : null;
    }
  }
  if (connection === null) return null;
  if (connection === 'signed-out') {
    return { connection, resetAt: null, reason: `${seat.label} is signed out — reconnect it to use this seat.` };
  }
  const when = describeResetAt(resetAt, now);
  const prose = when === null ? seatReopening(seat.capacity).resetDescription : null;
  const tail = when !== null ? ` — resets ${when}` : prose !== null ? ` — ${prose}` : '';
  return { connection, resetAt, reason: `${seat.label} is out of usage${tail}.` };
}

function hasRunnableModel(seat: VerseSeat): boolean {
  return seat.models.some((model) => !model.unavailableReason);
}

/** 0 = subscription seat with measured headroom, 1 = tight/unread subscription seat, 2 = local. */
function tier(seat: VerseSeat): number {
  if (seat.engine === 'local') return 2;
  return seat.capacity?.usability === 'ready' ? 0 : 1;
}

function bindingPercent(seat: VerseSeat): number {
  const used = seat.capacity?.binding?.usedPercent;
  // Unread sorts after every reading: no signal is not "0% used".
  return typeof used === 'number' && Number.isFinite(used) ? used : 101;
}

/** Can `seat` be offered as somewhere else to go? */
function offerable(seat: VerseSeat, report: SeatHealthReport | null, now: number): boolean {
  if (!hasRunnableModel(seat)) return false;
  if (seat.health.state === 'unavailable') return false;
  if (seatBlock(seat, report, now) !== null) return false;
  // A local seat is only worth offering while its runtime answers. `unknown`
  // with reasons is the sweep saying Ollama did not respond.
  if (seat.engine === 'local' && report !== null && report.connection === 'unknown' && report.reasons.length > 0) {
    return false;
  }
  return true;
}

/** Ranked ids of seats that could take the turn instead of `seatId` (see the file header). */
export function rankSeatAlternatives(
  seatId: string,
  seats: readonly VerseSeat[],
  reports: readonly SeatHealthReport[] | null | undefined,
  now: number = Date.now(),
): string[] {
  const blocked = seats.find((seat) => seat.id === seatId) ?? null;
  const candidates = seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => seat.id !== seatId && offerable(seat, reportFor(reports, seat.id), now));
  candidates.sort((a, b) => {
    const byTier = tier(a.seat) - tier(b.seat);
    if (byTier !== 0) return byTier;
    if (blocked !== null) {
      const sameA = a.seat.engine === blocked.engine ? 0 : 1;
      const sameB = b.seat.engine === blocked.engine ? 0 : 1;
      if (sameA !== sameB) return sameA - sameB;
    }
    const byUse = bindingPercent(a.seat) - bindingPercent(b.seat);
    if (byUse !== 0) return byUse;
    return a.index - b.index;
  });
  return candidates.slice(0, SEAT_MAX_ALTERNATIVES).map(({ seat }) => seat.id);
}

/**
 * The admission answer for one seat. A seat that is not in `seats` at all is
 * reported READY with no reason: the readiness layer has no evidence about
 * it, and "seat not found" is the engine's own error to raise.
 */
export function seatReadiness(
  seatId: string,
  seats: readonly VerseSeat[],
  reports: readonly SeatHealthReport[] | null | undefined,
  now: number = Date.now(),
): SeatReadiness {
  const seat = seats.find((candidate) => candidate.id === seatId) ?? null;
  if (seat === null) return { seatId, ready: true, reason: null, alternatives: [] };
  const block = seatBlock(seat, reportFor(reports, seatId), now);
  if (block === null) return { seatId, ready: true, reason: null, alternatives: [] };
  return { seatId, ready: false, reason: block.reason, alternatives: rankSeatAlternatives(seatId, seats, reports, now) };
}
