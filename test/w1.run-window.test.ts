/**
 * test/w1.run-window.test.ts — the bounded run window's ARITHMETIC.
 *
 * Pure maths, no I/O, no fixture. These are the cases a naive clock gets
 * wrong, which is the whole reason the module exists:
 *
 *  A. Resolution + refusal (a mistyped bound must REFUSE, never run forever)
 *  B. The overnight wrap — 23:00 → 07:00 must be TOMORROW's 07:00
 *  C. The slept-through end time — a host suspended past its own deadline
 *  D. Timezones and DST — '07:00' means 07:00 where the operator is
 *  E. Iteration windows
 *  F. Park clamping — a park must never outlive the window
 *
 * The wire rule is `{ kind: 'at-time', at: <absolute ISO> }`; turning an
 * operator's '07:00' into that instant is `resolveWallClockStopRule`, which is
 * where the wrap and the DST arithmetic live.
 */

import { describe, it, expect } from 'vitest';
import {
  RUN_WINDOW_MAX_HORIZON_MS,
  RUN_WINDOW_MAX_ITERATIONS,
  RUN_WINDOW_MAX_PARK_MS,
  evaluateRunWindow,
  hostTimeZone,
  isResolvableTimeZone,
  nextWallClockOccurrenceMs,
  parseWallClockTime,
  resolveRunWindow,
  resolveWallClockStopRule,
  runWindowParkMs,
  wallClockToEpochMs,
  type ResolvedRunWindow,
  type RunWindowStopRule,
} from '../src/core/daemon/run-window.js';

/** Unwrap a resolution that must have succeeded. */
function ok(result: ReturnType<typeof resolveRunWindow>): ResolvedRunWindow {
  if (!result.ok) throw new Error(`expected a resolved window, got refusal: ${result.reason}`);
  return result.window;
}

/** Unwrap a wall-clock resolution that must have succeeded. */
function rule(result: ReturnType<typeof resolveWallClockStopRule>): RunWindowStopRule {
  if (!result.ok) throw new Error(`expected a stop rule, got refusal: ${result.reason}`);
  return result.rule;
}

/** Arm an absolute window `ms` ahead of `nowMs`. */
function atTime(nowMs: number, ms: number): ResolvedRunWindow {
  return ok(resolveRunWindow(
    { kind: 'at-time', at: new Date(nowMs + ms).toISOString() },
    { nowMs },
  ));
}

// ===========================================================================
// A — Resolution + refusal
// ===========================================================================

describe('W1 · A · resolution and refusal', () => {
  it('A1: until-paused resolves with no clock and no iteration bound', () => {
    const w = ok(resolveRunWindow({ kind: 'until-paused' }, { nowMs: 1_700_000_000_000 }));
    expect(w.kind).toBe('until-paused');
    expect(w.endsAtMs).toBeNull();
    expect(w.maxIterations).toBeNull();
    expect(evaluateRunWindow(w, { iterations: 10_000 }).expired).toBe(false);
  });

  it('A2: a non-ISO stop time REFUSES — it never degrades into an unbounded run', () => {
    for (const at of ['07:00', 'tomorrow', '', 'seven', 'not-a-date']) {
      const result = resolveRunWindow({ kind: 'at-time', at });
      expect(result.ok, `'${at}' must be refused`).toBe(false);
    }
  });

  it('A3: a stop time IN THE PAST refuses — the run would end before it began', () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 0);
    const result = resolveRunWindow(
      { kind: 'at-time', at: new Date(nowMs - 10 * 60_000).toISOString() },
      { nowMs },
    );
    expect(result.ok).toBe(false);
    // The refusal is a SENTENCE — it is rendered verbatim to the operator.
    if (!result.ok) {
      expect(result.reason).toContain('in the past');
      expect(result.reason).toContain('later than now');
    }
  });

  it('A3b: a stop time exactly NOW refuses rather than running zero iterations', () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 0);
    expect(resolveRunWindow({ kind: 'at-time', at: new Date(nowMs).toISOString() }, { nowMs }).ok)
      .toBe(false);
  });

  it('A3c: a stop time beyond the horizon refuses — a window is a night, not a standing order', () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 0);
    const result = resolveRunWindow(
      { kind: 'at-time', at: new Date(nowMs + RUN_WINDOW_MAX_HORIZON_MS + 60_000).toISOString() },
      { nowMs },
    );
    expect(result.ok).toBe(false);
    // Just inside the horizon is fine.
    expect(resolveRunWindow(
      { kind: 'at-time', at: new Date(nowMs + RUN_WINDOW_MAX_HORIZON_MS - 60_000).toISOString() },
      { nowMs },
    ).ok).toBe(true);
  });

  it('A4: a non-positive / non-integer / out-of-range iteration count REFUSES', () => {
    for (const n of [0, -1, 1.5, Number.NaN, RUN_WINDOW_MAX_ITERATIONS + 1]) {
      const result = resolveRunWindow({ kind: 'after-iterations', iterations: n as number });
      expect(result.ok, `iterations=${n} must be refused`).toBe(false);
    }
    expect(resolveRunWindow({ kind: 'after-iterations', iterations: 1 }).ok).toBe(true);
    expect(resolveRunWindow({ kind: 'after-iterations', iterations: RUN_WINDOW_MAX_ITERATIONS }).ok).toBe(true);
  });

  it('A4b: the iteration ceiling matches the client contract (1..500)', () => {
    expect(RUN_WINDOW_MAX_ITERATIONS).toBe(500);
  });

  it('A5: an unknown stop-rule kind REFUSES rather than throwing', () => {
    expect(resolveRunWindow({ kind: 'whenever' } as never).ok).toBe(false);
    expect(resolveRunWindow(null as never).ok).toBe(false);
  });

  it('A6: parseWallClockTime accepts only HH:MM 24h', () => {
    expect(parseWallClockTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseWallClockTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseWallClockTime('24:00')).toBeNull();
    expect(parseWallClockTime(null as never)).toBeNull();
  });

  it('A7: resolveWallClockStopRule refuses a malformed time with a sentence', () => {
    for (const at of ['7:00', '25:00', '07:60', '0700', '', 'seven']) {
      const result = resolveWallClockStopRule(at);
      expect(result.ok, `'${at}' must be refused`).toBe(false);
      if (!result.ok) expect(result.reason.endsWith('.')).toBe(true);
    }
  });

  it('A8: resolveWallClockStopRule refuses an unresolvable timezone', () => {
    const result = resolveWallClockStopRule('07:00', { timeZone: 'Mars/Olympus' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('timezone');
  });
});

// ===========================================================================
// B — THE OVERNIGHT WRAP
// ===========================================================================

describe('W1 · B · the overnight wrap (23:00 → 07:00 is TOMORROW)', () => {
  const TZ = 'America/New_York';

  it('B1: at 23:00 local, a 07:00 stop resolves to TOMORROW — not 16h in the past', () => {
    // 2026-03-10T23:00 in New York (EDT, UTC-4) = 2026-03-11T03:00Z
    const nowMs = Date.UTC(2026, 2, 11, 3, 0);
    const endsAtMs = nextWallClockOccurrenceMs('07:00', nowMs, TZ);
    expect(endsAtMs).not.toBeNull();
    expect(endsAtMs as number).toBeGreaterThan(nowMs);
    expect((endsAtMs as number) - nowMs).toBe(8 * 3_600_000);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(endsAtMs as number));
    expect(local).toBe('07:00');
  });

  it('B2: resolveWallClockStopRule emits an ABSOLUTE instant carrying the wrap', () => {
    const nowMs = Date.UTC(2026, 2, 11, 3, 0); // 23:00 Mar 10 in NY
    const stopRule = rule(resolveWallClockStopRule('07:00', { nowMs, timeZone: TZ }));
    expect(stopRule.kind).toBe('at-time');
    if (stopRule.kind !== 'at-time') throw new Error('unreachable');
    expect(Date.parse(stopRule.at)).toBe(nowMs + 8 * 3_600_000);

    // And that absolute instant survives resolveRunWindow unchanged.
    const w = ok(resolveRunWindow(stopRule, { nowMs }));
    expect(w.endsAtMs).toBe(nowMs + 8 * 3_600_000);
    expect(evaluateRunWindow(w, { nowMs }).expired).toBe(false);
  });

  it('B3: a stop time later TODAY does not wrap', () => {
    const nowMs = Date.UTC(2026, 2, 10, 13, 0); // 09:00 NY
    expect((nextWallClockOccurrenceMs('17:00', nowMs, TZ) as number) - nowMs).toBe(8 * 3_600_000);
  });

  it('B4: a stop time equal to NOW wraps to tomorrow — never resolves to zero', () => {
    const nowMs = Date.UTC(2026, 2, 10, 13, 0); // exactly 09:00 NY
    const endsAtMs = nextWallClockOccurrenceMs('09:00', nowMs, TZ) as number;
    expect(endsAtMs).toBeGreaterThan(nowMs);
    expect(endsAtMs - nowMs).toBe(24 * 3_600_000);
  });

  it('B5: the wrap crosses a month and a year boundary correctly', () => {
    const nowMs = Date.UTC(2025, 11, 31, 23, 30);
    const endsAtMs = nextWallClockOccurrenceMs('07:00', nowMs, 'UTC') as number;
    expect(new Date(endsAtMs).toISOString()).toBe('2026-01-01T07:00:00.000Z');
  });

  it('B6: a 23:50 arming for 07:00 can NEVER be read as ten minutes ago', () => {
    // The exact ambiguity the absolute-instant contract exists to remove.
    const nowMs = Date.UTC(2026, 5, 1, 3, 50); // 23:50 May 31 NY
    const stopRule = rule(resolveWallClockStopRule('07:00', { nowMs, timeZone: TZ }));
    if (stopRule.kind !== 'at-time') throw new Error('unreachable');
    expect(Date.parse(stopRule.at)).toBeGreaterThan(nowMs);
    expect(resolveRunWindow(stopRule, { nowMs }).ok).toBe(true);
  });
});

// ===========================================================================
// C — THE SLEPT-THROUGH END TIME
// ===========================================================================

describe('W1 · C · the host slept through its own end time', () => {
  const TZ = 'America/New_York';

  it('C1: a window whose deadline passed while suspended is expired on the FIRST look', () => {
    const armedAtMs = Date.UTC(2026, 2, 11, 3, 0); // 23:00 NY, Mar 10
    const stopRule = rule(resolveWallClockStopRule('07:00', { nowMs: armedAtMs, timeZone: TZ }));
    const w = ok(resolveRunWindow(stopRule, { nowMs: armedAtMs }));

    // The lid closed at 01:00 and opened at 09:00 — no timer fired in between.
    const wokeAtMs = Date.UTC(2026, 2, 11, 13, 0); // 09:00 NY
    const verdict = evaluateRunWindow(w, { nowMs: wokeAtMs });

    expect(verdict.expired).toBe(true);
    expect(verdict.reason).toBe('clock-reached');
    // A NEGATIVE remaining is the correct report, not an error.
    expect(verdict.remainingMs as number).toBeLessThan(0);
    expect(verdict.detail).toContain('asleep');
  });

  it('C2: expiry is decided by absolute time, NOT by accumulated elapsed time', () => {
    // The regression that matters: a countdown of AWAKE milliseconds never
    // reaches zero across a suspend. An absolute deadline always does.
    const nowMs = 1_000_000_000_000;
    const w = atTime(nowMs, 8 * 3_600_000);
    const endsAtMs = w.endsAtMs as number;

    expect(evaluateRunWindow(w, { nowMs: endsAtMs - 1 }).expired).toBe(false);
    expect(evaluateRunWindow(w, { nowMs: endsAtMs }).expired).toBe(true);
    // Woken a week late — still simply expired, never wrapped or negative-looped.
    expect(evaluateRunWindow(w, { nowMs: endsAtMs + 7 * 86_400_000 }).expired).toBe(true);
  });

  it('C3: an overshoot within one park chunk is NOT reported as a sleep', () => {
    const w = atTime(0, 8 * 3_600_000);
    const verdict = evaluateRunWindow(w, { nowMs: (w.endsAtMs as number) + 1_000 });
    expect(verdict.expired).toBe(true);
    expect(verdict.detail).not.toContain('asleep');
  });
});

// ===========================================================================
// D — Timezones and DST
// ===========================================================================

describe('W1 · D · the local timezone, and DST', () => {
  it('D1: the same HH:MM resolves to different instants in different zones', () => {
    const nowMs = Date.UTC(2026, 5, 1, 0, 0);
    const ny = nextWallClockOccurrenceMs('07:00', nowMs, 'America/New_York') as number;
    const utc = nextWallClockOccurrenceMs('07:00', nowMs, 'UTC') as number;
    const tokyo = nextWallClockOccurrenceMs('07:00', nowMs, 'Asia/Tokyo') as number;
    expect(new Set([ny, utc, tokyo]).size).toBe(3);
    expect(ny - utc).toBe(4 * 3_600_000); // NY is UTC-4 in June
  });

  it('D2: a window spanning spring-forward is 7 real hours, not 8', () => {
    // US DST 2026 begins 2026-03-08 02:00 local. Run 23:00 Mar 7 → 07:00 Mar 8.
    const TZ = 'America/New_York';
    const nowMs = Date.UTC(2026, 2, 8, 4, 0); // 23:00 Mar 7 NY (EST, UTC-5)
    const endsAtMs = nextWallClockOccurrenceMs('07:00', nowMs, TZ) as number;
    expect(endsAtMs - nowMs).toBe(7 * 3_600_000);
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(endsAtMs));
    expect(local).toBe('07:00');
  });

  it('D3: a window spanning fall-back is 9 real hours, not 8', () => {
    // US DST 2026 ends 2026-11-01 02:00 local. Run 23:00 Oct 31 → 07:00 Nov 1.
    const TZ = 'America/New_York';
    const nowMs = Date.UTC(2026, 10, 1, 3, 0); // 23:00 Oct 31 NY (EDT, UTC-4)
    expect((nextWallClockOccurrenceMs('07:00', nowMs, TZ) as number) - nowMs).toBe(9 * 3_600_000);
  });

  it('D4: a local time inside the spring-forward GAP still resolves forward', () => {
    // 02:30 on 2026-03-08 does not exist in New York. A bound that VANISHES is
    // the one failure worse than a bound that is slightly off.
    const TZ = 'America/New_York';
    const nowMs = Date.UTC(2026, 2, 8, 4, 0); // 23:00 Mar 7 NY
    const endsAtMs = nextWallClockOccurrenceMs('02:30', nowMs, TZ);
    expect(endsAtMs).not.toBeNull();
    expect(endsAtMs as number).toBeGreaterThan(nowMs);
  });

  it('D5: wallClockToEpochMs round-trips through the zone it was given', () => {
    const TZ = 'Europe/Berlin';
    const ms = wallClockToEpochMs(2026, 7, 15, 23, 30, TZ) as number;
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(ms));
    expect(local).toContain('07/15/2026');
    expect(local).toContain('23:30');
  });

  it('D6: the host zone is resolvable and is the default for the CLI resolver', () => {
    const zone = hostTimeZone();
    expect(isResolvableTimeZone(zone)).toBe(true);
    expect(resolveWallClockStopRule('07:00').ok).toBe(true);
  });

  it('D7: midnight resolves to 00:00, not 24:00', () => {
    const nowMs = Date.UTC(2026, 5, 1, 12, 0);
    const endsAtMs = nextWallClockOccurrenceMs('00:00', nowMs, 'UTC') as number;
    expect(new Date(endsAtMs).toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });
});

// ===========================================================================
// E — Iteration windows
// ===========================================================================

describe('W1 · E · iteration windows', () => {
  it('E1: expires only once the Nth iteration has COMPLETED', () => {
    const w = ok(resolveRunWindow({ kind: 'after-iterations', iterations: 3 }));
    expect(evaluateRunWindow(w, { iterations: 0 }).expired).toBe(false);
    expect(evaluateRunWindow(w, { iterations: 2 }).expired).toBe(false);
    const done = evaluateRunWindow(w, { iterations: 3 });
    expect(done.expired).toBe(true);
    expect(done.reason).toBe('iterations-reached');
    expect(done.remainingIterations).toBe(0);
  });

  it('E2: an iteration window has no clock component and never expires on time', () => {
    const w = ok(resolveRunWindow({ kind: 'after-iterations', iterations: 5 }));
    expect(w.endsAtMs).toBeNull();
    expect(evaluateRunWindow(w, { nowMs: 8.64e15, iterations: 1 }).expired).toBe(false);
  });
});

// ===========================================================================
// F — Park clamping
// ===========================================================================

describe('W1 · F · a park never outlives the window', () => {
  it('F1: every park is capped at RUN_WINDOW_MAX_PARK_MS so a woken host re-checks fast', () => {
    // Batch mode's real default interval is 5 minutes.
    expect(runWindowParkMs(atTime(0, 8 * 3_600_000), 300_000, 0)).toBe(RUN_WINDOW_MAX_PARK_MS);
  });

  it('F2: a park never exceeds the time actually remaining', () => {
    const w = atTime(0, 8 * 3_600_000);
    const endsAtMs = w.endsAtMs as number;
    expect(runWindowParkMs(w, 300_000, endsAtMs - 5_000)).toBe(5_000);
    expect(runWindowParkMs(w, 300_000, endsAtMs)).toBe(0);
    // Past the deadline the park is zero, never negative.
    expect(runWindowParkMs(w, 300_000, endsAtMs + 60_000)).toBe(0);
  });

  it('F3: a short requested park is not lengthened', () => {
    expect(runWindowParkMs(atTime(0, 8 * 3_600_000), 1_000, 0)).toBe(1_000);
  });

  it('F4: an iteration window still chunks, so a suspend cannot strand the loop', () => {
    const w = ok(resolveRunWindow({ kind: 'after-iterations', iterations: 10 }));
    expect(runWindowParkMs(w, 300_000, 0)).toBe(RUN_WINDOW_MAX_PARK_MS);
  });

  it('F5: a non-finite requested park degrades to zero rather than NaN', () => {
    const w = ok(resolveRunWindow({ kind: 'after-iterations', iterations: 10 }));
    expect(runWindowParkMs(w, Number.NaN, 0)).toBe(0);
  });

  it('F6: chunked parks still add up to the full interval — tick cadence is unchanged', () => {
    // The loop parks in chunks and re-checks; the TOTAL must still be the
    // configured interval, or a bounded run would tick far more often than an
    // unbounded one and burn the daily budget faster.
    const w = atTime(0, 8 * 3_600_000);
    let elapsed = 0;
    let chunks = 0;
    while (elapsed < 300_000 && chunks < 100) {
      const chunk = runWindowParkMs(w, 300_000 - elapsed, elapsed);
      if (chunk <= 0) break;
      elapsed += chunk;
      chunks++;
    }
    expect(elapsed).toBe(300_000);
    expect(chunks).toBe(5); // 5 × 60s
  });
});
