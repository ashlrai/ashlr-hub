import { describe, expect, it } from 'vitest';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import {
  asClause,
  budgetMeter,
  countdownLabel,
  describeTickOutcome,
  formatDuration,
  formatInterval,
  formatStamp,
  formatUsd,
  formatWholePercent,
  localDateKey,
  nextTickAt,
  repoDisplayName,
  tidyProse,
  UNKNOWN,
} from './format.js';

describe('autonomy formatting', () => {
  it('never renders an absent value as zero', () => {
    expect(formatUsd(null)).toBe(UNKNOWN);
    expect(formatUsd(undefined)).toBe(UNKNOWN);
    expect(formatUsd(4.5)).toBe('$4.50');
    expect(formatInterval(null)).toBe(UNKNOWN);
    expect(formatInterval(900_000)).toBe('every 15m');
    expect(formatInterval(930_000)).toBe('every 15m 30s');
  });

  it('formats durations compactly across the second/minute/hour boundaries', () => {
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_960_000)).toBe('1h 06m');
  });

  describe('budget meter', () => {
    it('reads a daily budget of 0 as stopped, never as unlimited', () => {
      const meter = budgetMeter(0, 0);
      expect(meter.state).toBe('stopped');
      expect(meter.note).toContain('stopped');
      expect(meter.note).toContain('not unlimited');
      // A full bar, not an empty one — an empty meter would read as headroom.
      expect(meter.percent).toBe(100);
    });

    it('reports spend against the cap with the remainder in words', () => {
      const meter = budgetMeter(4.5, 25);
      expect(meter.state).toBe('ok');
      expect(meter.percent).toBe(18);
      expect(meter.label).toBe('$4.50 of $25.00 today · 18%');
      expect(meter.note).toBe('$20.50 left today.');
    });

    it('warns past 70% and says so past 100%', () => {
      expect(budgetMeter(20, 25).state).toBe('warn');
      expect(budgetMeter(25, 25).state).toBe('over');
      expect(budgetMeter(30, 25).percent).toBe(100);
    });

    it('is honestly unknown when either side is unobservable', () => {
      expect(budgetMeter(null, 25).state).toBe('unknown');
      expect(budgetMeter(4, null).state).toBe('unknown');
      expect(budgetMeter(null, 25).percent).toBeNull();
    });

    /**
     * `todayUsd` belongs to `todayDate`. The daemon writes the figure once a
     * day and leaves it there, so a machine that last ticked three weeks ago
     * answers `{todayUsd: 0, todayDate: "2026-09-01"}` — which used to render
     * as "$0.00 of $50.00 today · 0%" with a green meter. That is a fabricated
     * statement about today on the number an operator checks before walking
     * away from an autonomous loop.
     */
    it('refuses to call a stale ledger day "today"', () => {
      const now = new Date('2026-09-20T09:00:00');
      const meter = budgetMeter(0, 50, '2026-09-01', now);
      expect(meter.state).toBe('unknown');
      expect(meter.percent).toBeNull();
      // The ledger day as a person reads a date, never the raw ISO key.
      expect(meter.note).toBe('Nothing has been recorded today — the last ledger day is Sep 1.');
      expect(meter.note).not.toContain('2026-09-01');
      expect(meter.label).not.toContain('$0.00 of');
      expect(meter.label).toContain(UNKNOWN);
    });

    it('reads a current ledger day normally, and a missing one as before', () => {
      const now = new Date('2026-09-20T09:00:00');
      expect(budgetMeter(4.5, 25, localDateKey(now), now).state).toBe('ok');
      // No date to check is not the same as a stale date.
      expect(budgetMeter(4.5, 25, null, now).state).toBe('ok');
      expect(budgetMeter(4.5, 25, undefined, now).state).toBe('ok');
    });

    /**
     * The daemon stamps `todayDate` in UTC; the operator reads the screen in
     * local time. Comparing against the local day alone would cry "stale"
     * every evening west of UTC — a daily false alarm on the meter whose only
     * job is to be trustworthy.
     */
    it('accepts the UTC ledger day as current, not just the local one', () => {
      // 2026-09-19 20:00 local in a UTC-4 zone is 2026-09-20 in UTC.
      const evening = new Date('2026-09-20T00:00:00.000Z');
      const utcDay = evening.toISOString().slice(0, 10);
      expect(budgetMeter(4.5, 25, utcDay, evening).state).toBe('ok');
      expect(budgetMeter(4.5, 25, localDateKey(evening), evening).state).toBe('ok');
      // A genuinely old day matches neither spelling.
      expect(budgetMeter(0, 25, '2026-09-01', evening).state).toBe('unknown');
    });

    it('still reports a 0 budget as stopped even on a stale day', () => {
      // A cap of 0 is a statement about CONFIGURATION, which stays true
      // regardless of which day the ledger last recorded.
      const now = new Date('2026-09-20T09:00:00');
      expect(budgetMeter(0, 0, '2026-09-01', now).state).toBe('stopped');
    });
  });

  describe('formatStamp', () => {
    // formatClock alone is only honest inside a single-day window, and the
    // audit trail defaults to 200 rows and offers 500.
    const now = new Date('2026-09-20T09:00:00');

    const at = (iso: string) => new Date(iso);
    const clockOf = (d: Date) =>
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    it('prints time alone for an entry from today', () => {
      const today = at('2026-09-20T03:12:44');
      expect(formatStamp(today.toISOString(), now)).toBe(clockOf(today));
    });

    it('prefixes the date for anything older, so two 03:12s are distinguishable', () => {
      const yesterday = at('2026-09-19T03:12:44');
      const stamp = formatStamp(yesterday.toISOString(), now);
      // Same clock, different row — which is exactly what formatClock could
      // not express and is why the two must not be equal.
      expect(clockOf(yesterday)).toBe(clockOf(at('2026-09-20T03:12:44')));
      expect(stamp).not.toBe(formatStamp(at('2026-09-20T03:12:44').toISOString(), now));
      expect(stamp.endsWith(clockOf(yesterday))).toBe(true);
      expect(stamp.length).toBeGreaterThan(clockOf(yesterday).length);
    });

    it('is unknown, not a guess, for a missing or unparseable timestamp', () => {
      expect(formatStamp(null, now)).toBe(UNKNOWN);
      expect(formatStamp('not a date', now)).toBe(UNKNOWN);
    });
  });

  describe('next tick countdown', () => {
    it('derives the next tick from the last one plus the interval', () => {
      const last = '2026-01-01T00:00:00.000Z';
      const at = nextTickAt(last, 900_000);
      expect(at).toBe(Date.parse(last) + 900_000);
      expect(countdownLabel(at, Date.parse(last) + 600_000)).toBe('in 5m 00s');
      expect(countdownLabel(at, Date.parse(last) + 900_000)).toBe('due now');
      expect(countdownLabel(at, Date.parse(last) + 1_020_000)).toBe('overdue by 2m 00s');
    });

    it('refuses to guess without a last tick or a usable interval', () => {
      expect(nextTickAt(null, 900_000)).toBeNull();
      expect(nextTickAt('2026-01-01T00:00:00.000Z', 0)).toBeNull();
      expect(countdownLabel(null, Date.now())).toBe(UNKNOWN);
    });
  });

  describe('formatWholePercent', () => {
    it('is a whole percent, with "<1%" for a non-zero sliver rather than "0%"', () => {
      expect(formatWholePercent(0)).toBe('0%');
      expect(formatWholePercent(0.004)).toBe('<1%');
      expect(formatWholePercent(0.0099)).toBe('<1%');
      expect(formatWholePercent(0.18)).toBe('18%');
      expect(formatWholePercent(0.123456)).toBe('12%');
      expect(formatWholePercent(1)).toBe('100%');
      expect(formatWholePercent(null)).toBe(UNKNOWN);
      expect(formatWholePercent(Number.NaN)).toBe(UNKNOWN);
    });

    it('keeps the budget line from claiming 0% of a cap that real spend has touched', () => {
      const now = new Date('2026-09-20T09:00:00');
      expect(budgetMeter(0.05, 25, localDateKey(now), now).label).toBe('$0.05 of $25.00 today · <1%');
      expect(budgetMeter(4.5, 25, localDateKey(now), now).label).toBe('$4.50 of $25.00 today · 18%');
      // Over the cap the text stops at 100%, like the bar.
      expect(budgetMeter(30, 25, localDateKey(now), now).label).toBe('$30.00 of $25.00 today · 100%');
    });
  });

  describe('tidyProse', () => {
    // Local 09:00 and 23:46 on the same day, so the phrase is "today …" in any zone.
    const now = new Date(2026, 8, 24, 9, 0, 0).getTime();
    const tonight = new Date(2026, 8, 24, 23, 46, 56).toISOString();

    it('reads an ISO instant inside server prose as local, human time', () => {
      const text = tidyProse(`Claude Max is out of usage — resets ${tonight}.`, now);
      expect(text).toBe(`Claude Max is out of usage — resets ${describeResetAt(tonight, now)}.`);
      expect(text).toMatch(/resets today /);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('replaces every instant, offsets and bare dates-with-time included', () => {
      const text = tidyProse('from 2026-09-20T03:12:44+02:00 until 2026-09-26T03:46:56.000Z', now);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(text.startsWith('from ')).toBe(true);
    });

    it('leaves a calendar date, a version and plain prose alone', () => {
      expect(tidyProse('ledger day 2026-09-01; needs 2.1.280', now)).toBe('ledger day 2026-09-01; needs 2.1.280');
    });

    it('collapses the ".;" and ".." that joined sentences leave behind, keeping a real ellipsis', () => {
      expect(tidyProse('tests failed.; lint failed.', now)).toBe('tests failed; lint failed.');
      expect(tidyProse('quota exhausted..', now)).toBe('quota exhausted.');
      expect(tidyProse('still waiting...', now)).toBe('still waiting...');
    });
  });

  describe('asClause', () => {
    it('drops a closing period so the sentence can be embedded, and keeps an ellipsis', () => {
      expect(asClause(' quota exhausted. ')).toBe('quota exhausted');
      expect(asClause('no period')).toBe('no period');
      expect(asClause('trailing off…')).toBe('trailing off…');
      expect(asClause('trailing off...')).toBe('trailing off...');
    });
  });

  describe('repoDisplayName', () => {
    it('shows a checkout path by its folder name, never the raw home or temp path', () => {
      expect(repoDisplayName('/Users/mason/dev/ashlr-hub')).toBe('ashlr-hub');
      expect(repoDisplayName('/private/tmp/claude-501/abc/scratchpad/home-ctx/')).toBe('home-ctx');
      expect(repoDisplayName('~/code/hub')).toBe('hub');
    });

    it('keeps an owner/name slug whole — its owner is half of what identifies it', () => {
      expect(repoDisplayName('ashlrai/ashlr-hub')).toBe('ashlrai/ashlr-hub');
      expect(repoDisplayName('ashlr-hub')).toBe('ashlr-hub');
    });
  });

  it('explains tick outcomes in words an operator can act on', () => {
    expect(describeTickOutcome('kill-switch')).toEqual({ label: 'refused — emergency stop engaged', tone: 'danger' });
    expect(describeTickOutcome('no-enrolled-repos').label).toContain('no repos enrolled');
    expect(describeTickOutcome(null)).toEqual({ label: 'no tick recorded', tone: 'unknown' });
    expect(describeTickOutcome('something-new').label).toBe('something-new');
  });
});
