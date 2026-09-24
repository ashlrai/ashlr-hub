import { describe, expect, it } from 'vitest';
import { buildKpis, formatSpan, rankNeedsYou, recordReading, seatBurns, silentSources, sinceYouLooked, windowSum } from './command-model.js';
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
    expect(kpis.map((k) => k.label)).toEqual(['Merged · 7d', 'Post-merge green', 'Cycle time', 'Spend vs cap · 7d', 'Lift']);
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
    expect(claude.points[0]!.remaining).toBe(46);
  });
});
