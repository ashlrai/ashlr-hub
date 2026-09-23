/**
 * run-window.ts — the BOUNDED RUN WINDOW. Pure maths, no I/O, never throws.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Every scheduler in this repo is relative-elapsed: `Date.now()` deltas and
 * `setTimeout`. Nothing parses a time of day, nothing knows a timezone, and
 * `StartCalendarInterval` appears nowhere — the two launch-trigger allowlists
 * (`daemon/runtime-activation-transaction.ts`, `daemon/resident-service-
 * readiness.ts`) actively REJECT an extra OS trigger and their tests lock that.
 * So an overnight run window cannot be an OS launch trigger. It is IN-PROCESS,
 * and this module is the whole of its arithmetic.
 *
 * Three stop rules, chosen per run:
 *
 *   { kind: 'until-paused' }                  run until the operator parks it
 *   { kind: 'until-clock', at: '07:00' }      stop at a wall-clock local time
 *   { kind: 'iterations', max: 40 }           stop after N loop iterations
 *
 * ── THE THINGS A NAIVE CLOCK GETS WRONG ────────────────────────────────────
 *
 * 1. THE MACHINE SLEEPS AND WAKES PAST THE END TIME.
 *    A window must NEVER be held as "remaining milliseconds" counted down by
 *    elapsed time, and must never be armed as one long `setTimeout`. A laptop
 *    suspended at 01:00 and opened at 09:00 fired no timers in between; a
 *    single `setTimeout(6h)` scheduled for 07:00 fires at 15:00 on macOS,
 *    eight hours of wall-clock too late, and a countdown of elapsed awake time
 *    never reaches zero at all. So the window is stored as an ABSOLUTE epoch
 *    instant (`endsAtMs`) and every check is `Date.now() >= endsAtMs`. A run
 *    that slept through its own end time is expired the first moment it looks,
 *    with `reason: 'clock-reached'` and a negative remaining — which is the
 *    correct answer, not an error. {@link runWindowParkMs} additionally caps
 *    every park at {@link RUN_WINDOW_MAX_PARK_MS} so a woken process re-checks
 *    within a minute instead of finishing a stale timer.
 *
 * 2. A STOP TIME THAT IS TOMORROW. The overnight case IS the case: a run
 *    started at 23:00 that stops at 07:00 must resolve to TOMORROW's 07:00,
 *    not to an instant eight hours in the past. {@link nextWallClockOccurrenceMs}
 *    always resolves strictly forward — when today's occurrence is already at
 *    or behind `now`, it advances one LOCAL CALENDAR DAY (not `+24h`, which is
 *    wrong across a DST transition by exactly the offset change).
 *
 * 3. THE LOCAL TIMEZONE, AND DST. '07:00' means 07:00 where the operator is.
 *    Offsets are resolved per-instant from the IANA zone via `Intl`, so a
 *    window spanning a DST boundary is 7 or 9 hours of real time as the clock
 *    requires, not a fixed 8. A local time that does not exist (the spring-
 *    forward gap) resolves to the instant the clock jumps to; a local time
 *    that happens twice (the autumn fall-back) resolves to the FIRST of the
 *    two. Both are documented choices, not accidents — see
 *    {@link wallClockToEpochMs}.
 *
 * This module decides nothing about stopping. It reports that the window is
 * over; `loop.ts` parks the daemon by PAUSING (`~/.ashlr/daemon.paused`), never
 * by `stopDaemon()`, which is `setKill(true)` and would also refuse the agent's
 * own write tools. See `daemon/pause.ts`.
 *
 * No new runtime deps; `Intl` only. Never throws out of a public API.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The three stop rules. A run picks exactly one.
 *
 * This is the wire shape `POST /api/verse/overnight` sends, shared verbatim
 * with the client's `overnight-contract.ts`.
 *
 * `at` is an ABSOLUTE ISO-8601 instant, deliberately NOT a time of day. The
 * caller resolves the operator's wall-clock pick to the next occurrence in
 * their own timezone BEFORE arming, which removes the ambiguity entirely: a
 * 23:50 arming for "07:00" can never be read here as ten minutes ago. A caller
 * with no browser (the CLI) resolves it with {@link resolveWallClockStopRule},
 * which is the same arithmetic the browser does.
 */
export type RunWindowStopRule =
  | { readonly kind: 'until-paused' }
  | { readonly kind: 'at-time'; readonly at: string }
  | { readonly kind: 'after-iterations'; readonly iterations: number };

/** A stop rule resolved against a concrete `now` into absolute quantities. */
export interface ResolvedRunWindow {
  readonly kind: RunWindowStopRule['kind'];
  /** Epoch ms the window was armed at. */
  readonly startedAtMs: number;
  /**
   * ABSOLUTE epoch ms the window ends, or null when the rule has no clock
   * component. Never a duration — see note 1 in the file header.
   */
  readonly endsAtMs: number | null;
  /** Iteration ceiling, or null when the rule has no iteration component. */
  readonly maxIterations: number | null;
  /** The absolute ISO instant for an `at-time` rule; null otherwise. */
  readonly at: string | null;
  /** One line, safe for an audit summary. Metadata only. */
  readonly describe: string;
}

/** Why a window is over. `null` while it is still open. */
export type RunWindowExpiry = 'clock-reached' | 'iterations-reached';

export interface RunWindowEvaluation {
  readonly expired: boolean;
  readonly reason: RunWindowExpiry | null;
  /**
   * Signed ms until `endsAtMs` (NEGATIVE when the end time already passed,
   * which is how a slept-through window reports itself), or null.
   */
  readonly remainingMs: number | null;
  readonly remainingIterations: number | null;
  readonly detail: string;
}

/** {@link resolveRunWindow}'s result. A refusal is a value, never a throw. */
export type ResolveRunWindowResult =
  | { readonly ok: true; readonly window: ResolvedRunWindow }
  | { readonly ok: false; readonly reason: string };

/**
 * The longest a caller may park in one go while a window is open. A machine
 * that suspends mid-park wakes with a stale timer; capping the chunk bounds
 * how long a woken process can run past its own end time to one minute.
 * Matches `sleepUntilNextUtcBudgetDay`'s existing 60s chunking in loop.ts.
 */
export const RUN_WINDOW_MAX_PARK_MS = 60_000;

// ---------------------------------------------------------------------------
// Timezone arithmetic
// ---------------------------------------------------------------------------

/** The host's IANA zone, or 'UTC' when the runtime cannot say. Never throws. */
export function hostTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True when `timeZone` is a zone this runtime can actually resolve. */
export function isResolvableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallClockParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number;   // 1-31
  readonly hour: number;  // 0-23
  readonly minute: number;
  readonly second: number;
}

/**
 * The wall-clock components `instantMs` shows in `timeZone`.
 * Returns null when the zone cannot be resolved.
 */
function partsInZone(instantMs: number, timeZone: string): WallClockParts | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const read: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(instantMs))) {
      if (part.type === 'literal') continue;
      const value = Number(part.value);
      if (!Number.isFinite(value)) continue;
      read[part.type] = value;
    }
    const year = read['year'];
    const month = read['month'];
    const day = read['day'];
    // `hour12: false` yields 24 rather than 0 for midnight in some ICU builds.
    const hour = read['hour'] === 24 ? 0 : read['hour'];
    const minute = read['minute'];
    const second = read['second'];
    if (
      year === undefined || month === undefined || day === undefined ||
      hour === undefined || minute === undefined || second === undefined
    ) {
      return null;
    }
    return { year, month, day, hour, minute, second };
  } catch {
    return null;
  }
}

/**
 * The zone's UTC offset (ms) AT a given instant. Positive east of Greenwich.
 * Derived by reading the instant's wall clock in the zone and treating those
 * components as if they were UTC — the difference is the offset in force then,
 * which is what makes this DST-correct rather than fixed per zone.
 */
function zoneOffsetMsAt(instantMs: number, timeZone: string): number | null {
  const parts = partsInZone(instantMs, timeZone);
  if (!parts) return null;
  const asIfUtc = Date.UTC(
    parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
  );
  // Second-truncate the probe so the sub-second remainder does not leak in.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The epoch instant at which `timeZone`'s clock reads the given local
 * date-and-time. Returns null when the zone cannot be resolved.
 *
 * Two passes: guess with the offset in force at the naive-UTC instant, then
 * re-read the offset at the corrected instant and correct again if it changed.
 * That second pass is what makes DST boundaries land correctly.
 *
 * AMBIGUOUS AND NONEXISTENT LOCAL TIMES — both documented, neither an error:
 *  - Spring forward (02:30 does not exist): both passes agree on an instant
 *    whose clock reads 03:30, i.e. the moment the clock jumps past the request.
 *    A window asking to stop at a skipped time stops when that time would have
 *    arrived, which is the operator's intent.
 *  - Autumn fall-back (01:30 happens twice): resolves to the FIRST occurrence,
 *    the earlier instant, so a window never runs an extra hour by surprise.
 *    Erring short is the safe direction for a bound on autonomous work.
 */
export function wallClockToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  if (!Number.isFinite(naive)) return null;
  const firstOffset = zoneOffsetMsAt(naive, timeZone);
  if (firstOffset === null) return null;
  const firstGuess = naive - firstOffset;
  const secondOffset = zoneOffsetMsAt(firstGuess, timeZone);
  if (secondOffset === null) return null;
  if (secondOffset === firstOffset) return firstGuess;
  const secondGuess = naive - secondOffset;
  // Fall-back hour: both candidates are real instants reading the requested
  // clock time. Take the earlier one — a bound that errs short, never long.
  const thirdOffset = zoneOffsetMsAt(secondGuess, timeZone);
  if (thirdOffset === secondOffset) return Math.min(firstGuess, secondGuess);
  return firstGuess;
}

/** Parse 'HH:MM' (24h). Returns null for anything else — no throw, no guess. */
export function parseWallClockTime(at: string): { hour: number; minute: number } | null {
  if (typeof at !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The next instant at which `timeZone`'s clock reads `at`, STRICTLY AFTER
 * `nowMs`. This is the overnight wrap: at 23:00 local, '07:00' is tomorrow's
 * 07:00, because today's has already gone.
 *
 * Advances by one LOCAL CALENDAR DAY, never by `+24h` — across a DST boundary
 * those differ by the offset change, and only the calendar-day advance keeps
 * the clock reading the requested time.
 */
export function nextWallClockOccurrenceMs(
  at: string,
  nowMs: number,
  timeZone: string,
): number | null {
  const hhmm = parseWallClockTime(at);
  if (!hhmm) return null;
  if (!Number.isFinite(nowMs)) return null;
  const today = partsInZone(nowMs, timeZone);
  if (!today) return null;

  const sameDay = wallClockToEpochMs(
    today.year, today.month, today.day, hhmm.hour, hhmm.minute, timeZone,
  );
  if (sameDay !== null && sameDay > nowMs) return sameDay;

  // Already gone today (or landed exactly on now) — take tomorrow's. Date.UTC
  // normalises a day overflow (e.g. the 32nd) into the next month/year for us;
  // we only use it to get the next calendar date, never as an instant.
  const tomorrowProbe = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const nextDay = wallClockToEpochMs(
    tomorrowProbe.getUTCFullYear(),
    tomorrowProbe.getUTCMonth() + 1,
    tomorrowProbe.getUTCDate(),
    hhmm.hour,
    hhmm.minute,
    timeZone,
  );
  if (nextDay !== null && nextDay > nowMs) return nextDay;
  return null;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * The iteration ceiling, matching the client contract's documented 1..500.
 * A bound a typo can turn into "forever" is not a bound.
 */
export const RUN_WINDOW_MAX_ITERATIONS = 500;

/**
 * The furthest ahead an `at-time` stop may be armed. A window is a NIGHT, not
 * a standing instruction; an instant six weeks out is a mistake, not a plan.
 */
export const RUN_WINDOW_MAX_HORIZON_MS = 7 * 24 * 3_600_000;

/**
 * Turn an operator's wall-clock pick into the contract's absolute `at-time`
 * rule. This is the arithmetic the browser does before it POSTs; it lives here
 * so the CLI, which has no browser to do it, resolves it identically instead
 * of inventing a second, subtly different answer.
 *
 * Handles the overnight wrap and DST — see {@link nextWallClockOccurrenceMs}.
 */
export function resolveWallClockStopRule(
  at: string,
  opts: { nowMs?: number; timeZone?: string } = {},
): { ok: true; rule: RunWindowStopRule } | { ok: false; reason: string } {
  const nowMs = opts.nowMs ?? Date.now();
  if (!parseWallClockTime(at)) {
    return { ok: false, reason: `A stop time must look like 'HH:MM' on a 24-hour clock. '${at}' does not.` };
  }
  const timeZone = opts.timeZone ?? hostTimeZone();
  if (!isResolvableTimeZone(timeZone)) {
    return { ok: false, reason: `This machine cannot resolve the timezone '${timeZone}', so '${at}' has no fixed meaning.` };
  }
  const endsAtMs = nextWallClockOccurrenceMs(at, nowMs, timeZone);
  if (endsAtMs === null) {
    return { ok: false, reason: `Could not work out when '${at}' next happens in ${timeZone}.` };
  }
  return { ok: true, rule: { kind: 'at-time', at: new Date(endsAtMs).toISOString() } };
}

/**
 * Resolve a stop rule against `nowMs` into absolute quantities. Never throws;
 * every rejection is an `{ ok: false, reason }` value, and every reason is a
 * SENTENCE, because it is rendered verbatim to the operator as the refusal
 * `note` on `POST /api/verse/overnight`.
 */
export function resolveRunWindow(
  rule: RunWindowStopRule,
  opts: { nowMs?: number } = {},
): ResolveRunWindowResult {
  const nowMs = opts.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    return { ok: false, reason: 'This machine could not read its own clock, so a timed run cannot be bounded.' };
  }
  if (rule === null || typeof rule !== 'object') {
    return { ok: false, reason: 'A run needs exactly one stop rule, and none was given.' };
  }

  if (rule.kind === 'until-paused') {
    return {
      ok: true,
      window: {
        kind: 'until-paused',
        startedAtMs: nowMs,
        endsAtMs: null,
        maxIterations: null,
        at: null,
        describe: 'run until paused (~/.ashlr/daemon.paused)',
      },
    };
  }

  if (rule.kind === 'after-iterations') {
    const iterations = rule.iterations;
    if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1) {
      return { ok: false, reason: 'An iteration budget must be a whole number of at least 1.' };
    }
    if (iterations > RUN_WINDOW_MAX_ITERATIONS) {
      return {
        ok: false,
        reason: `An iteration budget may be at most ${RUN_WINDOW_MAX_ITERATIONS}; ${iterations} was asked for.`,
      };
    }
    return {
      ok: true,
      window: {
        kind: 'after-iterations',
        startedAtMs: nowMs,
        endsAtMs: null,
        maxIterations: iterations,
        at: null,
        describe: `stop after ${iterations} iteration${iterations === 1 ? '' : 's'}`,
      },
    };
  }

  if (rule.kind === 'at-time') {
    if (typeof rule.at !== 'string' || rule.at.trim().length === 0) {
      return { ok: false, reason: 'A timed run needs an absolute ISO-8601 instant to stop at, and none was given.' };
    }
    const endsAtMs = Date.parse(rule.at);
    if (!Number.isFinite(endsAtMs)) {
      return {
        ok: false,
        reason: `'${rule.at}' is not an ISO-8601 instant. A stop time must be absolute (for example ` +
          `2026-09-24T07:00:00.000Z), not a time of day.`,
      };
    }
    // The client resolves forward before sending, but a request can still
    // arrive stale — a queued POST, a hand-written call, a host whose clock
    // moved. A window that already ended must REFUSE, not run zero iterations
    // and not silently become unbounded.
    if (endsAtMs <= nowMs) {
      const agoMin = ((nowMs - endsAtMs) / 60_000).toFixed(1);
      return {
        ok: false,
        reason: `That stop time (${rule.at}) is ${agoMin} minutes in the past, so the run would end before ` +
          `it began. Pick a time later than now.`,
      };
    }
    if (endsAtMs - nowMs > RUN_WINDOW_MAX_HORIZON_MS) {
      const days = ((endsAtMs - nowMs) / 86_400_000).toFixed(1);
      return {
        ok: false,
        reason: `That stop time is ${days} days away. An unattended run is bounded to at most ` +
          `${RUN_WINDOW_MAX_HORIZON_MS / 86_400_000} days.`,
      };
    }
    const hours = (endsAtMs - nowMs) / 3_600_000;
    return {
      ok: true,
      window: {
        kind: 'at-time',
        startedAtMs: nowMs,
        endsAtMs,
        maxIterations: null,
        at: new Date(endsAtMs).toISOString(),
        describe: `stop at ${new Date(endsAtMs).toISOString()} (in ${hours.toFixed(2)}h)`,
      },
    };
  }

  return {
    ok: false,
    reason: `'${String((rule as { kind?: unknown }).kind)}' is not a stop rule this engine knows.`,
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

/**
 * Is the window over? Compares an ABSOLUTE deadline against an ABSOLUTE now,
 * so a process that was suspended across its own end time reports expired on
 * its first look, with a negative `remainingMs`.
 *
 * `iterations` is the count of iterations ALREADY COMPLETED.
 */
export function evaluateRunWindow(
  window: ResolvedRunWindow,
  state: { nowMs?: number; iterations?: number } = {},
): RunWindowEvaluation {
  const nowMs = state.nowMs ?? Date.now();
  const iterations = state.iterations ?? 0;

  const remainingIterations = window.maxIterations === null
    ? null
    : window.maxIterations - iterations;
  const remainingMs = window.endsAtMs === null ? null : window.endsAtMs - nowMs;

  if (window.endsAtMs !== null && Number.isFinite(nowMs) && nowMs >= window.endsAtMs) {
    const overshootMs = nowMs - window.endsAtMs;
    return {
      expired: true,
      reason: 'clock-reached',
      remainingMs,
      remainingIterations,
      detail: overshootMs > RUN_WINDOW_MAX_PARK_MS
        ? `run window ended at ${window.at}; ` +
          `noticed ${(overshootMs / 60_000).toFixed(1)} min late (the host was likely asleep)`
        : `run window ended at ${window.at}`,
    };
  }

  if (remainingIterations !== null && remainingIterations <= 0) {
    return {
      expired: true,
      reason: 'iterations-reached',
      remainingMs,
      remainingIterations,
      detail: `run window completed its ${window.maxIterations}-iteration budget`,
    };
  }

  return {
    expired: false,
    reason: null,
    remainingMs,
    remainingIterations,
    detail: window.describe,
  };
}

/**
 * How long a caller may park before it must look at the window again.
 *
 * Never longer than {@link RUN_WINDOW_MAX_PARK_MS}, so a suspended host that
 * wakes past its end time notices within a minute instead of serving out a
 * timer armed before the suspend. Never longer than the time actually left,
 * so the window is not overshot by a park. Never negative.
 */
export function runWindowParkMs(
  window: ResolvedRunWindow,
  requestedMs: number,
  nowMs: number = Date.now(),
): number {
  const requested = Number.isFinite(requestedMs) ? Math.max(0, requestedMs) : 0;
  let park = Math.min(requested, RUN_WINDOW_MAX_PARK_MS);
  if (window.endsAtMs !== null && Number.isFinite(nowMs)) {
    park = Math.min(park, Math.max(0, window.endsAtMs - nowMs));
  }
  return park;
}
