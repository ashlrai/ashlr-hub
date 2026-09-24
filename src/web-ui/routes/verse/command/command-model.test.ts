import { describe, expect, it } from 'vitest';
import type { VerseSeat } from '../../../../core/verse/types.js';
import { bindingLine, bindingReset, bindingResetText, buildKpis, burnTimeFormat, formatSpan, mergeSeatHistory, rankNeedsYou, reasonResetText, recordReading, resetInstantFromWords, resetWords, SEAT_READINGS_MAX, seatBurns, seatNames, seatReasons, seatReasonText, seriesKey, silentSources, sinceYouLooked, subscriptionUsage, windowSum } from './command-model.js';
import { activitySnapshot, budgetView, fleetHistory, fleetLive, leaderState, learningState, needsYouItems, seatHistory } from './fixtures.test-support.js';
import type { CapacityHistoryResponse } from '../../../../core/routing/capacity-history-types.js';
import { reasonSentence } from '../../../../core/routing/seat-reasons.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');

describe('windowSum', () => {
  it('sums a full window and refuses a window with any unknown day', () => {
    const days = fleetHistory('live', NOW).days;
    expect(windowSum(days, (d) => d.merges.realized, 7)).toBeGreaterThan(0);
    const sparse = fleetHistory('sparse', NOW).days;
    expect(windowSum(sparse, (d) => d.merges.realized, 7)).toBeNull();
    expect(windowSum(days, (d) => d.merges.realized, 1000)).toBeNull();
  });
});

describe('buildKpis', () => {
  it('builds the five KPIs with "vs prior 7d" deltas and units', () => {
    const kpis = buildKpis({ fleet: fleetLive('live', NOW), history: fleetHistory('live', NOW), learning: learningState('live', NOW), policy: null });
    expect(kpis.map((k) => k.label)).toEqual(['Merged · 7d', 'Post-merge green', 'Cycle time', 'Metered spend · 7d', 'Lift']);
    const [merged, green, cycle, , lift] = kpis;
    expect(merged!.value).toBe('23');
    expect(merged!.delta?.versus).toBe('vs prior 7d');
    expect(merged!.trend).toHaveLength(14);
    expect(green!.value).toBe('96%');
    expect(green!.delta?.unit).toBe('pts');
    expect(cycle!.value).toBe('2h 14m');
    expect(lift!.value).toBe('+4.2 pts');
  });

  it('is honest when nothing answers: dashes, no deltas', () => {
    const kpis = buildKpis({ fleet: null, history: null, learning: null, policy: null });
    expect(kpis.map((k) => k.value)).toEqual(['—', '—', '—', '—', '—']);
    expect(kpis.every((k) => k.delta === null)).toBe(true);
  });

  it('formats spans', () => {
    expect(formatSpan(38 * 60_000)).toBe('38m');
    expect(formatSpan(null)).toBe('—');
    expect(formatSpan(74 * 3_600_000)).toBe('3d 2h');
  });
});

describe('sinceYouLooked', () => {
  it('counts what ended after the last visit and nothing on a first visit', () => {
    const fleet = fleetLive('live', NOW);
    const items = sinceYouLooked({ lastLookedAt: new Date(NOW - 12 * 3_600_000).toISOString(), fleet, leader: leaderState('live', NOW), activity: activitySnapshot('live', NOW) });
    expect(items.map((i) => i.text)).toEqual(['2 merged', '1 reverted', '1 refused or failed', '1 new memo', '3 new for you']);
    expect(sinceYouLooked({ lastLookedAt: null, fleet, leader: null, activity: null })).toEqual([]);
  });
});

describe('needs you ordering and silence', () => {
  it('ranks most severe first, then newest', () => {
    expect(rankNeedsYou(needsYouItems(NOW)).map((i) => i.severity)).toEqual(['high', 'warn', 'warn', 'info']);
  });
  it('lists sources that did not answer', () => {
    const a = activitySnapshot('live', NOW);
    expect(silentSources({ ...a, sources: { ...a.sources, fleet: 'unavailable', leader: 'error' } })).toEqual(['fleet', 'leader']);
  });
});

describe('seat burn-downs', () => {
  const GROK = seriesKey('grok-a', 'weekly');

  it('records readings per seat window, drops a reset window, and builds paid seats first', () => {
    let history = recordReading({}, budgetView('live', NOW));
    const later = budgetView('live', NOW + 60_000);
    later.headroom[1] = { ...later.headroom[1]!, weeklyUsedPercent: 33 };
    history = recordReading(history, later);
    expect(history[GROK]!.map((r) => r.used)).toEqual([31, 33]);
    // Both of Claude's windows are kept, each on its own line.
    expect(history[seriesKey('claude-a', 'session')]!.map((r) => r.used)).toEqual([74, 74]);
    expect(history[seriesKey('claude-a', 'weekly')]!.map((r) => r.used)).toEqual([54, 54]);
    // A fresh window (usage fell sharply) starts a new line.
    const reset = budgetView('live', NOW + 120_000);
    reset.headroom[1] = { ...reset.headroom[1]!, weeklyUsedPercent: 2 };
    expect(recordReading(history, reset)[GROK]!.map((r) => r.used)).toEqual([2]);
    expect(Object.keys(history).some((k) => k.startsWith('local-qwen'))).toBe(false);
    const burns = seatBurns(budgetView('live', NOW), history);
    expect(burns.map((b) => [b.seatId, b.free])).toEqual([
      ['claude-a', false],
      ['codex-a', false],
      ['grok-a', false],
      ['local-qwen', true],
    ]);
    const claude = burns[0]!;
    expect(claude.reservePercent).toBe(40);
    // The 5-hour window binds (74% used): remaining 26, stop line at the 70% ceiling.
    expect(claude.window).toBe('session');
    expect(claude.points[0]!.remaining).toBe(26);
    expect(claude.line).toEqual({ value: 30, label: '5-hour ceiling' });
    expect(burns.find((b) => b.seatId === 'grok-a')!.line).toBeNull();
  });

  it('keeps only the ends of a flat run, so the bounded history spans changes, not polls', () => {
    const at = (i: number, grok: number) => {
      const v = budgetView('live', NOW + i * 30_000);
      v.headroom[1] = { ...v.headroom[1]!, weeklyUsedPercent: grok };
      return v;
    };
    let history: Record<string, { t: number; used: number }[]> = {};
    for (let i = 0; i < 1000; i++) history = recordReading(history, at(i, 31));
    // A thousand identical polls (8+ hours) are two readings: where the run began and the latest.
    expect(history[GROK]!.map((r) => r.used)).toEqual([31, 31]);
    expect(history[GROK]![0]!.t).toBe(Date.parse(at(0, 31).sampledAt));
    expect(history[GROK]![1]!.t).toBe(Date.parse(at(999, 31).sampledAt));
    history = recordReading(history, at(1000, 32));
    history = recordReading(history, at(1001, 32));
    expect(history[GROK]!.map((r) => r.used)).toEqual([31, 31, 32, 32]);
    expect(history[GROK]!.length).toBeLessThanOrEqual(SEAT_READINGS_MAX);
  });

  it('draws the BINDING window\'s own line, never a mix of the two windows', () => {
    const view = budgetView('live', NOW);
    const history = recordReading({}, view);
    // Claude: the 5-hour window binds at 74% used.
    expect(seatBurns(view, history).find((b) => b.seatId === 'claude-a')!.points.map((p) => p.remaining)).toEqual([26]);
    const weekly = budgetView('live', NOW + 60_000);
    weekly.headroom[0] = { ...weekly.headroom[0]!, bindingWindow: 'weekly' };
    const next = recordReading(history, weekly);
    expect(seatBurns(weekly, next).find((b) => b.seatId === 'claude-a')!.points.map((p) => p.remaining)).toEqual([46, 46]);
  });
});

describe('recorded seat history (GET /api/verse/budget/history)', () => {
  const GROK = seriesKey('grok-a', 'weekly');
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const response = (series: CapacityHistoryResponse['series']): CapacityHistoryResponse => ({
    v: 1, generatedAt: new Date(NOW).toISOString(), days: 8, since: new Date(NOW - 8 * DAY).toISOString(), oldestAt: null, series, truncated: false,
  });

  const at = (series: CapacityHistoryResponse['series'], generatedAt: number | string): CapacityHistoryResponse => ({
    ...response(series),
    generatedAt: typeof generatedAt === 'number' ? new Date(generatedAt).toISOString() : generatedAt,
  });

  it('draws the recorded history up to when the server answered, then only this page\'s later readings', () => {
    // Live readings at or before generatedAt are the server's to record (at
    // their observedAt); only the one after it extends the line.
    const live = { [GROK]: [{ t: NOW - 2 * HOUR, used: 28 }, { t: NOW - HOUR, used: 30 }, { t: NOW + 30_000, used: 31 }] };
    const merged = mergeSeatHistory(live, response([
      { seatId: 'grok-a', window: 'weekly', points: [[NOW - 2 * DAY, 10], [NOW - DAY, 20], [NOW - HOUR, 29]], resetsAt: null, thinned: false },
    ]));
    expect(merged.readings[GROK]).toEqual([
      { t: NOW - 2 * DAY, used: 10 }, { t: NOW - DAY, used: 20 }, { t: NOW - HOUR, used: 29 }, { t: NOW + 30_000, used: 31 },
    ]);
    expect(merged.recorded.has(GROK)).toBe(true);
  });

  // Review 3.10.1: live readings are stamped when the budget route was ASKED
  // (sampledAt), recorded rows when the provider was READ (observedAt). Mixed
  // per instant, a poll that still served the pre-reset 85% sorted after the
  // recorded post-reset 3% — a spike, and the reset cut then dropped the
  // first real post-reset reading.
  it('never interleaves the two clocks across a window reset', () => {
    const t0 = NOW;
    const merged = mergeSeatHistory(
      { [GROK]: [{ t: t0 - 5 * 60_000 + 5_000, used: 85 }, { t: t0 + 12_000, used: 85 }, { t: t0 + 40_000, used: 3 }] },
      at([{ seatId: 'grok-a', window: 'weekly', points: [[t0 - 5 * 60_000, 85], [t0 + 10_000, 3]], resetsAt: null, thinned: false }], t0 + 30_000),
    );
    const line = merged.readings[GROK]!;
    // The line starts at the first post-reset reading the server recorded, and never climbs back to 85.
    expect(line[0]).toEqual({ t: t0 + 10_000, used: 3 });
    expect(line.map((r) => r.used)).toEqual([3, 3]);
    expect(line.map((r) => r.t)).toEqual([t0 + 10_000, t0 + 40_000]);
  });

  it('never dips a rising line with a live reading of an older observation', () => {
    const merged = mergeSeatHistory(
      { [GROK]: [{ t: NOW + 12_000, used: 50 }, { t: NOW + 42_000, used: 52 }] },
      at([{ seatId: 'grok-a', window: 'weekly', points: [[NOW - 5 * 60_000, 50], [NOW + 10_000, 52]], resetsAt: null, thinned: false }], NOW + 30_000),
    );
    const used = merged.readings[GROK]!.map((r) => r.used);
    expect(used).toEqual([50, 52, 52]);
    // Oldest first, every step up or level — one clock at a time.
    for (let i = 1; i < used.length; i++) expect(used[i]!).toBeGreaterThanOrEqual(used[i - 1]!);
  });

  it('falls back to the newest recorded row when generatedAt is unreadable', () => {
    const merged = mergeSeatHistory(
      { [GROK]: [{ t: NOW - 2 * HOUR, used: 40 }, { t: NOW - 30 * 60_000, used: 44 }] },
      at([{ seatId: 'grok-a', window: 'weekly', points: [[NOW - 3 * HOUR, 38], [NOW - HOUR, 42]], resetsAt: null, thinned: false }], 'not a time'),
    );
    expect(merged.readings[GROK]!.map((r) => r.used)).toEqual([38, 42, 44]);
  });

  it('starts after the last reset, collapses flat runs, and keeps live-only lines unrecorded', () => {
    const claude = seriesKey('claude-a', 'session');
    const merged = mergeSeatHistory({ [claude]: [{ t: NOW, used: 74 }] }, response([
      // A 5-hour window that reset (80 → 5), then sat flat at 12.
      { seatId: 'grok-a', window: 'weekly', points: [[NOW - 9 * HOUR, 80], [NOW - 8 * HOUR, 5], [NOW - 7 * HOUR, 12], [NOW - 6 * HOUR, 12], [NOW - 5 * HOUR, 12], [NOW - 4 * HOUR, 12]], resetsAt: null, thinned: false },
    ]));
    expect(merged.readings[GROK]!.map((r) => r.used)).toEqual([5, 12, 12]);
    expect(merged.readings[GROK]![2]!.t).toBe(NOW - 4 * HOUR);
    expect(merged.readings[claude]).toEqual([{ t: NOW, used: 74 }]);
    expect(merged.recorded.has(claude)).toBe(false);
  });

  it('skips malformed wire data instead of drawing it', () => {
    const bad = {
      v: 1,
      series: [
        { seatId: 'grok-a', window: 'monthly', points: [[NOW, 5]] },
        { seatId: 7, window: 'weekly', points: [[NOW, 5]] },
        { seatId: 'grok-a', window: 'weekly', points: [[NOW - HOUR, 'x'], [NOW - HOUR, 140], 'nope', [NOW, 12]] },
      ],
    } as unknown as CapacityHistoryResponse;
    const merged = mergeSeatHistory({}, bad);
    expect(Object.keys(merged.readings)).toEqual([GROK]);
    expect(merged.readings[GROK]).toEqual([{ t: NOW, used: 12 }]);
    expect(mergeSeatHistory({}, null)).toEqual({ readings: {}, recorded: new Set() });
  });

  it('after a reload the burn-down has the whole window, and knows its line was recorded', () => {
    const view = budgetView('live', NOW);
    // A fresh page: one live poll only.
    const merged = mergeSeatHistory(recordReading({}, view), seatHistory('live', NOW));
    const grok = seatBurns(view, merged.readings, null, merged.recorded).find((b) => b.seatId === 'grok-a')!;
    expect(grok.recorded).toBe(true);
    // The window opened 3 days ago (reset in 4); the line starts within its first hour.
    expect(grok.points[0]!.t - grok.start!).toBeLessThan(HOUR);
    expect(grok.points.at(-1)!.remaining).toBe(69);
    // Without the server's history it is the page's own single reading.
    const alone = seatBurns(view, recordReading({}, view)).find((b) => b.seatId === 'grok-a')!;
    expect(alone.recorded).toBe(false);
    expect(alone.points).toHaveLength(1);
  });
});

describe('resetInstantFromWords', () => {
  // Thu Sep 24 2026, 4:30 PM in New York (EDT, UTC−4) — the live defect's moment.
  const now = Date.parse('2026-09-24T20:30:00Z');
  const iso = (text: string, at = now) => {
    const v = resetInstantFromWords(text, at);
    return v === null ? null : new Date(v).toISOString();
  };

  it('reads the collector\'s grammar on the clock it names, with or without "resets"', () => {
    expect(iso('Sep 25 at 6:59pm (America/New_York)')).toBe('2026-09-25T22:59:00.000Z');
    expect(iso('resets Sep 25 at 6:59pm (America/New_York)')).toBe('2026-09-25T22:59:00.000Z');
    expect(iso('Sep 25 at 7pm (America/New_York)')).toBe('2026-09-25T23:00:00.000Z');
    expect(iso('Sep 25 at 12am (UTC)')).toBe('2026-09-25T00:00:00.000Z');
    expect(iso('Sep 25 at 12pm (Asia/Kolkata)')).toBe('2026-09-25T06:30:00.000Z');
  });

  it('takes the nearest year for a dated reset and the nearest day for a bare time', () => {
    expect(iso('Jan 2 at 3am (Europe/London)')).toBe('2027-01-02T03:00:00.000Z');
    // A bare time is the occurrence nearest the reading: 7 PM today, 1:40 AM tonight.
    expect(iso('7pm (America/New_York)')).toBe('2026-09-24T23:00:00.000Z');
    expect(iso('1:40am (America/New_York)')).toBe('2026-09-25T05:40:00.000Z');
    // Winter time (EST, UTC−5) is read on the zone's own offset that day.
    expect(iso('Dec 1 at 9am (America/New_York)', Date.parse('2026-11-28T12:00:00Z'))).toBe('2026-12-01T14:00:00.000Z');
  });

  it('refuses words it cannot place: free prose, an unknown zone, an impossible date', () => {
    expect(iso('in 3 hours')).toBeNull();
    expect(iso('Sep 25 at 7pm')).toBeNull();
    expect(iso('Sep 25 at 7pm (Mars/Olympus_Mons)')).toBeNull();
    expect(iso('Feb 30 at 1am (UTC)')).toBeNull();
    expect(iso('Sep 25 at 13pm (UTC)')).toBeNull();
    expect(resetInstantFromWords('Sep 25 at 7pm (UTC)', Number.NaN)).toBeNull();
  });
});

describe('bindingReset', () => {
  const WEEK = 7 * 24 * 3_600_000;
  const FIVE_H = 5 * 3_600_000;
  const now = Date.parse('2026-09-24T20:30:00Z');

  it('prefers the machine instant, else places the words', () => {
    expect(bindingReset('2026-09-26T00:00:00Z', 'Sep 25 at 6:59pm (America/New_York)', WEEK, now)).toEqual({ at: Date.parse('2026-09-26T00:00:00Z'), from: 'provider' });
    expect(bindingReset(null, 'Sep 25 at 6:59pm (America/New_York)', WEEK, now)).toEqual({ at: Date.parse('2026-09-25T22:59:00Z'), from: 'words' });
  });

  it('refuses words that cannot close the window the reading is in', () => {
    // A 5-hour window cannot reset 26 hours from now…
    expect(bindingReset(null, 'Sep 25 at 6:59pm (America/New_York)', FIVE_H, now)).toBeNull();
    // …and a reset an hour ago closed the PREVIOUS window (stale words).
    expect(bindingReset(null, 'Sep 24 at 3:30pm (America/New_York)', WEEK, now)).toBeNull();
    // A reading taken a few minutes before the rollover still places it.
    expect(bindingReset(null, 'Sep 24 at 4:25pm (America/New_York)', WEEK, now)).toEqual({ at: Date.parse('2026-09-24T20:25:00Z'), from: 'words' });
    expect(bindingReset(null, null, WEEK, now)).toBeNull();
    expect(bindingReset(null, 'Sep 25 at 6:59pm (America/New_York)', null, now)).toBeNull();
    expect(bindingReset('not a date', null, WEEK, now)).toBeNull();
  });
});

// P4 regression: Claude publishes no machine reset — only words on the seat
// roster. The burn keeps its readings and carries the binding window's words.
describe('seat burn-downs without a machine reset (Claude)', () => {
  const claudeRoster = [{
    id: 'claude-a',
    capacity: {
      windows: [
        { id: 'five_hour', usedPercent: 74, resetsAt: null, resetDescription: 'Sep 24 at 5pm (America/New_York)', limitReached: false, measured: true },
        { id: 'seven_day', usedPercent: 54, resetsAt: null, resetDescription: 'Sep 25 at 7pm (America/New_York)', limitReached: false, measured: true },
        { id: 'seven_day_fable', usedPercent: 99, resetsAt: null, resetDescription: 'Sep 26 at 9am (America/New_York)', limitReached: false, measured: true },
      ],
    },
  }] as unknown as VerseSeat[];

  function claudeWithoutReset(binding: 'session' | 'weekly') {
    const view = budgetView('live', NOW);
    view.headroom[0] = { ...view.headroom[0]!, bindingWindow: binding, resetAt: null };
    return view;
  }

  it('keeps the readings and takes the reset words of the window that binds', () => {
    const view = claudeWithoutReset('session');
    const history = recordReading({}, view);
    const claude = seatBurns(view, history, claudeRoster).find((b) => b.seatId === 'claude-a')!;
    // 5 PM in New York is 6 h after this 11 AM reading — no 5-hour window
    // resets then, so the words stay words and nothing is placed.
    expect(claude.resetAt).toBeNull();
    expect(claude.start).toBeNull();
    expect(claude.resetFrom).toBeNull();
    expect(claude.points.map((p) => p.remaining)).toEqual([26]);
    expect(claude.resetText).toBe('Sep 24 at 5pm (America/New_York)');
    const weekly = claudeWithoutReset('weekly');
    const w = seatBurns(weekly, recordReading({}, weekly), claudeRoster).find((b) => b.seatId === 'claude-a')!;
    // The account-wide weekly window — never the per-model (Fable) one beside it.
    expect(w.resetText).toBe('Sep 25 at 7pm (America/New_York)');
  });

  // The live defect: Claude's weekly words name a time, so the card gets the
  // whole window (reset − 7 d → reset) like every other seat.
  it('places the weekly reset from the words and spans the whole window', () => {
    const weekly = claudeWithoutReset('weekly');
    const w = seatBurns(weekly, recordReading({}, weekly), claudeRoster).find((b) => b.seatId === 'claude-a')!;
    expect(w.resetFrom).toBe('words');
    expect(new Date(w.resetAt!).toISOString()).toBe('2026-09-25T23:00:00.000Z');
    expect(w.start).toBe(w.resetAt! - 7 * 24 * 3_600_000);
    expect(w.points.map((p) => p.remaining)).toEqual([46]);
    expect(w.line).toEqual({ value: 40, label: 'Reserved for you' });
    // A machine instant, when there is one, still wins.
    const machine = seatBurns(budgetView('live', NOW), recordReading({}, budgetView('live', NOW)), claudeRoster).find((b) => b.seatId === 'claude-a')!;
    expect(machine.resetFrom).toBe('provider');
  });

  it('has no words without a roster, a binding window, or a provider sentence', () => {
    const view = claudeWithoutReset('session');
    expect(seatBurns(view, {}).find((b) => b.seatId === 'claude-a')!.resetText).toBeNull();
    expect(bindingResetText(claudeRoster[0], 'claude', null, NOW)).toBeNull();
    expect(bindingResetText({ capacity: undefined }, 'claude', 'session', NOW)).toBeNull();
    expect(bindingResetText(claudeRoster[0], 'local', 'session', NOW)).toBeNull();
  });

  it('writes the provider sentence verbatim, with or without its leading "resets"', () => {
    expect(resetWords('Sep 25 at 7pm (America/New_York)')).toBe('resets Sep 25 at 7pm (America/New_York)');
    expect(resetWords('resets Sep 25 at 7pm (America/New_York)')).toBe('resets Sep 25 at 7pm (America/New_York)');
  });
});

// Review 3.10.1 (high): the budget route's reasons are the router's LOG
// sentences — "… stops at 92% (resets 2026-09-26T03:46:56.000Z)." — and the
// cards printed them verbatim: a UTC instant, nested parentheses for Claude,
// and ".." once a period followed. Built here with the real producer.
describe('seat reasons in words', () => {
  const RESET_ISO = '2026-09-26T03:46:56.000Z';
  const reserveText = 'The weekly window is 92% used; 8% is kept for you, so autonomy stops at 92%.';
  const codexHeld = (reason: string) => {
    const view = budgetView('live', NOW);
    view.headroom[2] = { ...view.headroom[2]!, weeklyUsedPercent: 92, resetAt: RESET_ISO, reasons: [reason] };
    view.effective['codex-a'] = { seatId: 'codex-a', enabled: true, reservePercent: 8 };
    return seatBurns(view, recordReading({}, view)).find((b) => b.seatId === 'codex-a')!;
  };

  it('prints the sentence once, closed by one period, without the log\'s reset clause', () => {
    const wire = reasonSentence({ kind: 'reserve', text: reserveText, resetsAt: RESET_ISO });
    expect(wire).toBe(`The weekly window is 92% used; 8% is kept for you, so autonomy stops at 92% (resets ${RESET_ISO}).`);
    const codex = codexHeld(wire);
    // The chart already marks this reset ("Resets …" in local time), so the reason does not repeat it.
    expect(codex.resetAt).toBe(Date.parse(RESET_ISO));
    expect(codex.reason).toBe(reserveText);
    expect(codex.reason).not.toMatch(/\d{4}-\d{2}-\d{2}T|\(resets|\.\./);
  });

  it('names another window\'s reset in the viewer\'s zone, never as UTC ISO', () => {
    const other = '2026-09-24T19:10:00.000Z';
    const codex = codexHeld(reasonSentence({ kind: 'spent', text: 'The 5-hour window is spent — limit reached.', resetsAt: other }));
    expect(codex.reason).toBe(`The 5-hour window is spent — limit reached. Resets ${describeResetAt(other, Date.parse(budgetView('live', NOW).sampledAt))}.`);
    expect(codex.reason).not.toMatch(/\d{4}-\d{2}-\d{2}T|\(resets/);
  });

  it('keeps Claude\'s words once — in the header — never as "(resets … (Zone))."', () => {
    const words = 'Sep 25 at 7pm (America/New_York)';
    const view = budgetView('live', NOW);
    const text = 'The weekly window is 97% used; 40% is kept for you, so autonomy stops at 60%.';
    view.headroom[0] = { ...view.headroom[0]!, bindingWindow: 'weekly', weeklyUsedPercent: 97, resetAt: null, reasons: [reasonSentence({ kind: 'reserve', text, resetDescription: words })] };
    expect(view.headroom[0].reasons[0]).toBe(`${text.slice(0, -1)} (resets ${words}).`);
    const roster = [{ id: 'claude-a', capacity: { windows: [{ id: 'seven_day', usedPercent: 97, resetsAt: null, resetDescription: words, limitReached: false, measured: true }] } }] as unknown as VerseSeat[];
    for (const seats of [roster, null]) {
      const claude = seatBurns(view, recordReading({}, view), seats).find((b) => b.seatId === 'claude-a')!;
      expect(claude.reason).toBe(text);
      // Without a roster the reason's own words place the reset — no "reset time not reported" beside it.
      expect(claude.resetText).toBe(words);
      expect(claude.resetFrom).toBe('words');
    }
  });

  it('turns an instant inside the sentence into local time, and closes an unterminated one', () => {
    const inside = '2026-09-24T19:10:00.000Z';
    const reason = seatReasons([`Parked; the earliest known reopening is ${inside}`])[0];
    expect(seatReasonText(reason, { resetAt: null, resetText: null }, NOW)).toBe(`Parked; the earliest known reopening is ${describeResetAt(inside, NOW)}.`);
    expect(seatReasonText(undefined, { resetAt: null, resetText: null }, NOW)).toBeNull();
    expect(seatReasons([7, '', '  ', 'Signed out — reconnect this account before anything can run on it.'] as unknown[]).map((r) => r.kind)).toEqual(['signed-out']);
    expect(seatReasons(undefined)).toEqual([]);
  });

  it('takes reset words from reasons only where headroom.ts ties them to the binding window', () => {
    const words = 'Sep 25 at 7pm (America/New_York)';
    expect(reasonResetText(seatReasons([reasonSentence({ kind: 'reserve', text: reserveText, resetDescription: `resets ${words}` })]))).toBe(words);
    expect(reasonResetText(seatReasons([reasonSentence({ kind: 'session-ceiling', text: 'The 5-hour window is 74% used; autonomy stops at 70% to protect your live session.', resetDescription: words })]))).toBe(words);
    // A spent window may be the OTHER window; its words never place this chart's reset.
    expect(reasonResetText(seatReasons([reasonSentence({ kind: 'spent', text: 'The 5-hour window is spent — limit reached.', resetDescription: words })]))).toBeNull();
  });
});

describe('seatNames', () => {
  it('names a seat by its roster label, else the budget route\'s, never inventing one', () => {
    const view = budgetView('live', NOW);
    const names = seatNames([{ id: 'claude-a', label: 'Claude Max' }, { id: 'blank', label: '  ' }], view);
    expect(names.get('claude-a')).toBe('Claude Max');
    expect(names.get('grok-a')).toBe('Grok (grok-a)');
    expect(names.has('blank')).toBe(false);
    expect(names.has('nobody')).toBe(false);
    expect(seatNames(null, null).size).toBe(0);
  });
});

// Review 3.10 c10: subscription runs' token-priced estimate is not metered spend.
describe('metered spend KPI', () => {
  const policy = { spend: { meteredUsdPerDay: 0 } } as unknown as Parameters<typeof buildKpis>[0]['policy'];
  it('never shows the all-runs estimate as metered spend against the cap', () => {
    const history = fleetHistory('live', NOW);
    expect(history.days.some((d) => (d.estCostUsd ?? 0) > 0)).toBe(true);
    const spend = buildKpis({ fleet: null, history, learning: null, policy, budget: budgetView('live', NOW) }).find((k) => k.id === 'spend')!;
    expect(spend.label).toBe('Metered spend · 7d');
    expect(spend.value).toBe('—');
    expect(spend.trend).toBeUndefined();
    expect(spend.caption).toContain('metered APIs off ($0 cap)');
    expect(spend.caption).toContain('metered split not reported yet');
    // Subscriptions as percent of their binding window, never dollars.
    expect(spend.caption).toContain('subscriptions: Claude (claude-a) 74% · Grok (grok-a) 31% · Codex (codex-a) 100% of window used');
    expect(spend.caption).not.toMatch(/\$\d+\.\d/);
  });

  it('uses the server’s metered split when it reports one', () => {
    const history = fleetHistory('live', NOW);
    const days = history.days.map((d) => ({ ...d, meteredCostUsd: 0.5 }));
    const capped = { spend: { meteredUsdPerDay: 2 } } as unknown as Parameters<typeof buildKpis>[0]['policy'];
    const spend = buildKpis({ fleet: null, history: { ...history, days }, learning: null, policy: capped }).find((k) => k.id === 'spend')!;
    expect(spend.value).toBe('$3.50 / $14');
    expect(spend.trend).toHaveLength(14);
    expect(spend.delta?.value).toBe(0);
    expect(spend.caption).toContain('cap $2/day');
    expect(spend.caption).toContain('see seat capacity');
  });

  it('lists only paid seats, with "—" for an unknown window', () => {
    const view = budgetView('dark', NOW);
    view.headroom[1] = { ...view.headroom[1]!, weeklyUsedPercent: null };
    expect(subscriptionUsage(view)).toBe('Claude (claude-a) 74% · Grok (grok-a) — · Codex (codex-a) 100% of window used');
    expect(subscriptionUsage(null)).toBeNull();
  });
});

// Review 3.10 d2: the stop line belongs to the window the chart draws.
describe('bindingLine mirrors core/routing/headroom.ts', () => {
  const balancedClaude = { reservePercent: 40, maxSessionWindowPercent: 70 };
  it('weekly binds → the weekly reserve', () => {
    expect(bindingLine({ bindingWindow: 'weekly', weeklyUsedPercent: 54 }, balancedClaude)).toEqual({ value: 40, label: 'Reserved for you' });
  });
  it('5-hour binds → the 5-hour ceiling (70% used = 30% remaining), not the weekly reserve', () => {
    // The review's scenario: weekly 20%, 5-hour 65% → server: session binds, eligible.
    const line = bindingLine({ bindingWindow: 'session', weeklyUsedPercent: 20 }, balancedClaude)!;
    expect(line).toEqual({ value: 30, label: '5-hour ceiling' });
    // 35% remaining sits ABOVE the line, so the verdict cannot say "autonomy has stopped".
    expect(100 - 65).toBeGreaterThan(line.value);
  });
  it('no weekly window → the short window carries both limits and the tighter wins', () => {
    expect(bindingLine({ bindingWindow: 'session', weeklyUsedPercent: null }, balancedClaude)).toEqual({ value: 40, label: 'Reserved for you' });
    expect(bindingLine({ bindingWindow: 'session', weeklyUsedPercent: null }, { reservePercent: 10, maxSessionWindowPercent: 70 })).toEqual({ value: 30, label: '5-hour ceiling' });
  });
  it('no limit → no line', () => {
    expect(bindingLine({ bindingWindow: 'weekly', weeklyUsedPercent: 5 }, { reservePercent: 0 })).toBeNull();
    expect(bindingLine({ bindingWindow: 'session', weeklyUsedPercent: 5 }, { reservePercent: 40 })).toBeNull();
    expect(bindingLine({ bindingWindow: null, weeklyUsedPercent: null }, balancedClaude)).toBeNull();
  });
});

// Review 3.10 c17: a weekly window's start and reset are the same weekday and time.
describe('burnTimeFormat', () => {
  it('dates the weekly axis so start and reset differ', () => {
    const reset = Date.parse('2026-09-26T17:27:00Z');
    const fmt = burnTimeFormat('weekly');
    // The viewer's local day (Sep 26 in New York, Sep 27 in Tokyo) — never a hard-coded one.
    const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    expect(fmt(reset - 7 * 86_400_000)).not.toBe(fmt(reset));
    expect(fmt(reset)).toContain(day(reset));
    expect(fmt(reset - 7 * 86_400_000)).toContain(day(reset - 7 * 86_400_000));
    // The date alone: a weekday beside it only widened labels that collided.
    expect(fmt(reset)).not.toMatch(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  });
  it('keeps the 5-hour axis short, and blanks an invalid time', () => {
    expect(burnTimeFormat('session')(Date.parse('2026-09-26T17:27:00Z'))).not.toMatch(/Sep/);
    expect(burnTimeFormat('weekly')(Number.NaN)).toBe('');
  });
});
