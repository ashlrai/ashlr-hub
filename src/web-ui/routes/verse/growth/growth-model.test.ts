import { describe, expect, it } from 'vitest';
import { costPerMerge, forestRows, harnessSteps, modelOutcomes, weeklyBins } from './growth-model.js';
import { fleetHistory, learningState } from '../command/fixtures.test-support.js';
import type { ModelStats } from '../../../data/api-types.js';

const NOW = Date.parse('2026-09-24T15:00:00Z');

describe('weeklyBins', () => {
  it('makes complete 7-day windows ending on the last day, oldest first', () => {
    const days = fleetHistory('live', NOW).days;
    const bins = weeklyBins(days);
    expect(bins).toHaveLength(12);
    expect(bins.at(-1)!.endDay).toBe(days.at(-1)!.day);
    expect(bins.every((b) => b.merges !== null)).toBe(true);
  });

  it('marks a window with an unknown day unknown, and cost per merge undefined without merges', () => {
    const bins = weeklyBins(fleetHistory('sparse', NOW).days);
    expect(bins.at(-1)!.merges).toBeNull();
    expect(costPerMerge({ end: 0, endDay: '', merges: 0, costUsd: 3 })).toBeNull();
    expect(costPerMerge({ end: 0, endDay: '', merges: 4, costUsd: 2 })).toBe(0.5);
  });
});

describe('modelOutcomes', () => {
  it('splits each model\'s dispatches into what they became, top by dispatches', () => {
    const m = (model: string, over: Partial<ModelStats>) => ({ engine: 'local', model, dispatches: 0, judged: 0, shipVerdicts: 0, merged: 0, costPerMergedUsd: null, ...over }) as ModelStats;
    const out = modelOutcomes([m('a', { dispatches: 10, judged: 8, shipVerdicts: 5, merged: 3 }), m('b', { dispatches: 20, judged: 2 }), m('idle', {})]);
    expect(out.categories).toEqual(['b', 'a']);
    expect(out.values).toEqual([[0, 0, 2, 18], [3, 2, 3, 2]]);
  });
});

describe('harnessSteps', () => {
  it('steps up by each adoption\'s lift, back down on rollback with a ▼ marker', () => {
    const { steps, markers } = harnessSteps(learningState('live', NOW));
    expect(steps.map((s) => [s.label, s.value])).toEqual([
      ['Compiled defaults', 0],
      ['h-0001', 4.2],
      ['h-0002', 1.2000000000000002],
      ['h-0001', 4.2],
    ]);
    expect(steps[1]!.low).toBeCloseTo(1.1);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe('rollback');
    expect(harnessSteps(learningState('dark', NOW))).toEqual({ steps: [], markers: [] });
  });

  it('lists experiments with running ones below the pair gate as unknown', () => {
    const rows = forestRows(learningState('live', NOW));
    expect(rows[0]).toMatchObject({ label: 'h-0004 vs h-0001', estimate: null, detail: 'running · 5/8 pairs' });
    expect(rows.at(-1)).toMatchObject({ estimate: 4.2, detail: 'passed the gate' });
  });
});
