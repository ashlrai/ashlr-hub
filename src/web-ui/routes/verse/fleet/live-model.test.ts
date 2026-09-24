import { describe, expect, it } from 'vitest';
import { funnelStages, laneRows, latestDecision, parkedGantt, refusalStack, runStatus, runTone } from './live-model.js';
import { fleetLive } from '../command/fixtures.test-support.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const H = 3_600_000;

describe('laneRows', () => {
  it('packs overlapping runs into numbered slot rows per lane, with the engine on the lane', () => {
    const lanes = laneRows(fleetLive('live', NOW).runs, NOW - 12 * H, NOW);
    const labels = lanes.map((l) => l.label);
    expect(labels[0]).toMatch(/^Local/);
    expect(labels.some((l) => l.startsWith('Grok · '))).toBe(true);
    expect(lanes.find((l) => l.label.startsWith('Grok'))!.engine).toBe('grok');
    // No two bars in a row overlap.
    for (const lane of lanes) {
      const items = [...lane.items].sort((a, b) => a.start - b.start);
      for (let i = 1; i < items.length; i++) expect(items[i]!.start).toBeGreaterThanOrEqual(items[i - 1]!.end ?? NOW);
    }
  });

  it('leaves parked work to the Gantt when asked', () => {
    const all = laneRows(fleetLive('live', NOW).runs, NOW - 12 * H, NOW);
    const noParked = laneRows(fleetLive('live', NOW).runs, NOW - 12 * H, NOW, { includeParked: false });
    const count = (ls: typeof all) => ls.reduce((n, l) => n + l.items.length, 0);
    expect(count(all) - count(noParked)).toBe(2);
  });

  it('names statuses and tones: outcome once ended, phase while running', () => {
    const runs = fleetLive('live', NOW).runs;
    expect(runStatus(runs.find((r) => r.id === 'r6')!)).toBe('merged');
    expect(runStatus(runs.find((r) => r.id === 'r1')!)).toBe('producing');
    expect(runTone('merged')).toBe('success');
    expect(runTone('reverting')).toBe('danger');
    expect(runTone('producing')).toBe('running');
    expect(runTone('nonsense')).toBe('unknown');
  });
});

describe('parkedGantt', () => {
  it('runs each parked item to its release time and counts unknown releases', () => {
    const runs = fleetLive('live', NOW).runs;
    const g = parkedGantt(runs, NOW);
    expect(g.lanes).toHaveLength(2);
    expect(g.lanes[0]!.items[0]!.outline).toBe(true);
    expect(g.to).toBeGreaterThan(NOW + 42 * H - 1);
    const unknown = parkedGantt(runs.map((r) => (r.hold ? { ...r, hold: { ...r.hold, nextEligibleAt: null } } : r)), NOW);
    expect(unknown.unknownRelease).toBe(2);
    expect(unknown.lanes[0]!.items[0]!.end).toBeNull();
  });
});

describe('gates', () => {
  it('builds a narrowing funnel from G0 entries', () => {
    const stages = funnelStages(fleetLive('live', NOW).funnel);
    expect(stages[0]).toEqual({ id: 'entered', label: 'Proposals', value: 64 });
    expect(stages.at(-1)).toEqual({ id: 'G7', label: 'G7 GitHub checks', value: 23 });
    expect(funnelStages(null)).toEqual([]);
  });

  it('keeps the top five reasons in fixed identity slots and folds the rest into Other', () => {
    const r = refusalStack(fleetLive('live', NOW).funnel);
    expect(r.segments.map((s) => s.id)).toEqual(['tests-failed', 'protected-path', 'judge-reject', 'risk-over-cap', 'checks-red', '__other']);
    expect(r.segments.at(-1)!.color).toBe('var(--chart-neutral)');
    expect(r.segments[0]!.color).toBe('var(--chart-series-1)');
    expect(r.total).toBe(41);
    expect(r.categories).not.toContain('G5');
  });

  it('finds the newest routing decision', () => {
    expect(latestDecision(fleetLive('live', NOW))!.decision.seatId).toBe('grok-a');
    expect(latestDecision(fleetLive('dark', NOW))).toBeNull();
  });
});
