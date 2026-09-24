import { describe, expect, it } from 'vitest';
import {
  HARNESS_BASELINE_WINDOW_MS,
  HARNESS_TIME_FLOOR_MS,
  costPerMerge,
  forestRows,
  harnessSteps,
  harnessTime,
  modelOutcomes,
  weeklyBins,
} from './growth-model.js';
import { fleetHistory, learningState } from '../command/fixtures.test-support.js';
import type { ModelStats } from '../../../data/api-types.js';
import type { LearningStateV1 } from '../../../../core/learn/harness-types.js';

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

  describe('never emits a point without a real timestamp', () => {
    // The registry stamps the compiled-defaults baseline at the epoch
    // (core/learn/harness-registry.ts baselineVersion) — the live shape.
    const EPOCH = '1970-01-01T00:00:00.000Z';
    const DAY = 86_400_000;
    const withEpochBaseline = (state: LearningStateV1): LearningStateV1 => ({
      ...state,
      versions: state.versions.map((v) => (v.seq === 0 ? { ...v, createdAt: EPOCH } : v)),
    });
    const allTimes = (s: ReturnType<typeof harnessSteps>) => [...s.steps.map((p) => p.at), ...s.markers.map((m) => m.at)];

    it('anchors a defaults-only harness at a 90-day window before generatedAt, not the epoch', () => {
      const only = withEpochBaseline(learningState('sparse', NOW));
      const { steps, markers } = harnessSteps({ ...only, experiments: [] });
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ label: 'Compiled defaults', value: 0 });
      expect(steps[0]!.at).toBe(NOW - HARNESS_BASELINE_WINDOW_MS);
      expect(markers).toEqual([]);
      // An explicit `now` wins over generatedAt.
      expect(harnessSteps({ ...only, experiments: [] }, NOW + DAY).steps[0]!.at).toBe(NOW + DAY - HARNESS_BASELINE_WINDOW_MS);
    });

    it('starts the defaults step at the first real harness event when there is history', () => {
      const live = withEpochBaseline(learningState('live', NOW));
      const series = harnessSteps(live);
      // h-0001 was created (and e1 started) 20 days before NOW: the earliest real event.
      expect(series.steps[0]).toMatchObject({ label: 'Compiled defaults', at: NOW - 20 * DAY });
      expect(Math.min(...allTimes(series))).toBe(NOW - 20 * DAY);
      expect(series.steps.map((s) => s.label)).toEqual(['Compiled defaults', 'h-0001', 'h-0002', 'h-0001']);
    });

    it('drops an adoption or rollback stamped at the epoch instead of drawing it in 1970', () => {
      const live = learningState('live', NOW);
      const bad: LearningStateV1 = {
        ...live,
        versions: live.versions.map((v) => (v.id === 'h-0002' ? { ...v, adoptedAt: EPOCH, rolledBackAt: '' } : v)),
      };
      const series = harnessSteps(bad);
      expect(series.steps.map((s) => s.id)).not.toContain('h-0002@adopt');
      expect(series.markers).toEqual([]);
      for (const t of allTimes(series)) expect(t).toBeGreaterThanOrEqual(HARNESS_TIME_FLOOR_MS);
    });

    it('treats missing, unparsable and pre-2020 stamps as not real', () => {
      expect(harnessTime(null)).toBeNull();
      expect(harnessTime('')).toBeNull();
      expect(harnessTime('not a date')).toBeNull();
      expect(harnessTime(EPOCH)).toBeNull();
      expect(harnessTime('2026-09-01T00:00:00Z')).toBe(Date.parse('2026-09-01T00:00:00Z'));
    });
  });

  it('lists experiments with running ones below the pair gate as unknown', () => {
    const rows = forestRows(learningState('live', NOW));
    expect(rows[0]).toMatchObject({ label: 'h-0004 vs h-0001', estimate: null, detail: 'running · 5/8 pairs' });
    expect(rows.at(-1)).toMatchObject({ estimate: 4.2, detail: 'passed the gate' });
  });
});
