import { describe, expect, it } from 'vitest';
import type { VerseSeat } from '../../../../core/verse/types.js';
import { bindingLine, bindingResetText, buildKpis, burnTimeFormat, formatSpan, rankNeedsYou, recordReading, resetWords, seatBurns, silentSources, sinceYouLooked, subscriptionUsage, windowSum } from './command-model.js';
import { activitySnapshot, budgetView, fleetHistory, fleetLive, leaderState, learningState, needsYouItems } from './fixtures.test-support.js';

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
  it('records readings per seat, drops a reset window, and builds paid seats first', () => {
    let history = recordReading({}, budgetView('live', NOW));
    const later = budgetView('live', NOW + 60_000);
    later.headroom[1] = { ...later.headroom[1]!, weeklyUsedPercent: 33 };
    history = recordReading(history, later);
    expect(history['grok-a']!.map((r) => r.used)).toEqual([31, 33]);
    // A fresh window (usage fell sharply) starts a new line.
    const reset = budgetView('live', NOW + 120_000);
    reset.headroom[1] = { ...reset.headroom[1]!, weeklyUsedPercent: 2 };
    expect(recordReading(history, reset)['grok-a']!.map((r) => r.used)).toEqual([2]);
    expect(history['local-qwen']).toBeUndefined();
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
    expect(claude.resetAt).toBeNull();
    expect(claude.start).toBeNull();
    expect(claude.points.map((p) => p.remaining)).toEqual([26]);
    expect(claude.resetText).toBe('Sep 24 at 5pm (America/New_York)');
    const weekly = claudeWithoutReset('weekly');
    const w = seatBurns(weekly, recordReading({}, weekly), claudeRoster).find((b) => b.seatId === 'claude-a')!;
    // The account-wide weekly window — never the per-model (Fable) one beside it.
    expect(w.resetText).toBe('Sep 25 at 7pm (America/New_York)');
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
    expect(fmt(reset - 7 * 86_400_000)).not.toBe(fmt(reset));
    expect(fmt(reset)).toMatch(/Sep 26/);
    expect(fmt(reset - 7 * 86_400_000)).toMatch(/Sep 19/);
  });
  it('keeps the 5-hour axis short, and blanks an invalid time', () => {
    expect(burnTimeFormat('session')(Date.parse('2026-09-26T17:27:00Z'))).not.toMatch(/Sep/);
    expect(burnTimeFormat('weekly')(Number.NaN)).toBe('');
  });
});
