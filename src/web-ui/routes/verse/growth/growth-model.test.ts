import { describe, expect, it } from 'vitest';
import {
  HARNESS_BASELINE_WINDOW_MS,
  HARNESS_TIME_FLOOR_MS,
  MODEL_LABEL_MAX,
  costPerMerge,
  forestRows,
  harnessSteps,
  harnessTime,
  modelLabels,
  modelOutcomes,
  weeklyBins,
} from './growth-model.js';
import { fleetHistory, learningState } from '../command/fixtures.test-support.js';
import { formatDayLabel, formatTimeLabel, timeLabelLadder } from '../../../components/charts/format.js';
import { TEST_ZONES, inTimeZone } from './time-zone.test-support.js';
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

  it('stamps each week at its last day\'s local midnight, so every rung of the axis names that day — in any zone', () => {
    const days = fleetHistory('live', NOW).days;
    for (const zone of TEST_ZONES) {
      inTimeZone(zone, () => {
        const bins = weeklyBins(days);
        const weekLabel = (ms: number) => `wk to ${formatTimeLabel(ms)}`;
        // The Growth axis ladder: its own label, then the kit's fallback rung.
        const ladder = timeLabelLadder(bins[0]!.end, bins.at(-1)!.end, weekLabel, bins.map((b) => b.end));
        for (const b of bins) {
          const day = formatDayLabel(b.endDay);
          expect(ladder.map((rung) => rung(b.end)), `${zone} ${b.endDay}`).toEqual([`wk to ${day}`, day]);
        }
      });
    }
  });
});

describe('modelOutcomes', () => {
  const m = (model: string, over: Partial<ModelStats> = {}) => ({ engine: 'local', model, dispatches: 0, judged: 0, shipVerdicts: 0, merged: 0, costPerMergedUsd: null, ...over }) as ModelStats;

  it('splits each model\'s dispatches into what they became, top by dispatches', () => {
    const out = modelOutcomes([m('a', { dispatches: 10, judged: 8, shipVerdicts: 5, merged: 3 }), m('b', { dispatches: 20, judged: 2 }), m('idle', {})]);
    expect(out.categories).toEqual(['b', 'a']);
    expect(out.values).toEqual([[0, 0, 2, 18], [3, 2, 3, 2]]);
  });

  it('names a model without its vendor path or snapshot date, shortened only at a word boundary', () => {
    expect(modelLabels([
      m('claude-haiku-4-5-20251001', { engine: 'claude' }),
      m('grok-4.7-fast-reasoning', { engine: 'grok-cli' }),
      m('meta/llama-3.1-70b-instruct', { engine: 'nim' }),
      m('qwen3.8:27b-ctx64k'),
      m('gpt-5.5-2026-01-15', { engine: 'codex' }),
    ])).toEqual(['claude-haiku-4-5', 'grok-4.7-fast…', 'llama-3.1-70b…', 'qwen3.8:27b-ctx64k', 'gpt-5.5']);
  });

  it('never cuts a name mid-word', () => {
    const ids = ['grok-4.7-fast-reasoning', 'grok-4.7-build-fast', 'deepseek-r1-distill-llama-70b', 'qwen2.5-coder:32b-instruct-q4_K_M', 'averyveryverylongsinglewordmodel'];
    const labels = modelLabels(ids.map((id) => m(id)));
    expect(labels).toEqual(['grok-4.7-fast…', 'grok-4.7-build…', 'deepseek-r1…', 'qwen2.5-coder:32b…', 'averyveryverylongsinglewordmodel']);
    labels.forEach((label, i) => {
      const id = ids[i]!;
      expect(label.length <= MODEL_LABEL_MAX || label === id, label).toBe(true);
      if (label.endsWith('…')) {
        const kept = label.slice(0, -1);
        expect(id.startsWith(kept), label).toBe(true);
        // The cut lands on a boundary: the id's next character is a separator.
        expect([' ', '-', ':'], label).toContain(id[kept.length]);
      } else {
        expect(label).toBe(id);
      }
    });
  });

  it('gives every column its own label — two snapshots of one model, a shared long prefix, one tag on two engines', () => {
    const labels = modelLabels([
      m('claude-haiku-4-5-20251001', { engine: 'claude' }),
      m('claude-haiku-4-5', { engine: 'claude' }),
      m('grok-4.7-fast-reasoning', { engine: 'grok-cli' }),
      m('grok-4.7-fast-research', { engine: 'grok-cli' }),
      m('qwen3.8:27b', { engine: 'local' }),
      m('qwen3.8:27b', { engine: 'local-coder' }),
    ]);
    // Before: 'claude-haiku-4-5-…' twice and 'grok-4.7-fast-rea…' / 'grok-4.7-fast-res…'.
    expect(labels).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-haiku-4-5',
      'grok-4.7-fast-reasoning',
      'grok-4.7-fast-research',
      'local:qwen3.8:27b',
      'local-coder:qwen3.8:27b',
    ]);
    expect(new Set(labels).size).toBe(labels.length);
    // Rows the server should never send twice still get distinct columns.
    const twice = modelLabels([m('same'), m('same')]);
    expect(twice).toEqual(['local:same', 'local:same #2']);
    expect(modelOutcomes([m('claude-haiku-4-5-20251001', { dispatches: 3 }), m('claude-haiku-4-5', { dispatches: 2 })]).categories).toEqual(['claude-haiku-4-5-20251001', 'claude-haiku-4-5']);
  });

  it('keeps each model\'s full id as its title while the axis label is shortened', () => {
    const out = modelOutcomes([
      m('grok-4.7-fast-reasoning', { engine: 'grok-cli', dispatches: 9 }),
      m('meta/llama-3.1-70b-instruct', { engine: 'nim', dispatches: 8 }),
      m('claude-haiku-4-5-20251001', { engine: 'claude', dispatches: 7 }),
      m('qwen3.8:27b', { engine: 'local', dispatches: 6 }),
      m('qwen3.8:27b', { engine: 'local-coder', dispatches: 5 }),
    ]);
    expect(out.categories).toEqual(['grok-4.7-fast…', 'llama-3.1-70b…', 'claude-haiku-4-5', 'local:qwen3.8:27b', 'local-coder:qwen3.8:27b']);
    // A title never drops what the label needed to stay unique (the engine).
    expect(out.titles).toEqual(['grok-4.7-fast-reasoning', 'meta/llama-3.1-70b-instruct', 'claude-haiku-4-5-20251001', 'local:qwen3.8:27b', 'local-coder:qwen3.8:27b']);
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
