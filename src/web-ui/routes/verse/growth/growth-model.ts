/**
 * routes/verse/growth/growth-model.ts — "is the output compounding?" as pure
 * data (unit C7; SPEC-310B §6 Growth, SPEC-310C §5).
 *
 *   weeklyBins      rolling 7-day windows ENDING TODAY, so every point is a
 *                   complete week (a calendar week-to-date would dip every
 *                   Monday and read as a regression);
 *   costPerMerge    spend ÷ merges per window — undefined (null) for a week
 *                   with no merges, never $0 or ∞;
 *   modelOutcomes   what each model's dispatches became (ROI composition);
 *   harnessSteps    the active harness's level over time: each adoption
 *                   steps up by its experiment's lift, a rollback steps back
 *                   down with a ▼ marker;
 *   forestRows      one row per experiment, newest first.
 *
 * Framework-free; tested directly.
 */
import type { FleetHistoryDay } from '../../../../core/verse/fleet-history-types.js';
import type { ExperimentResultV1, LearningStateV1 } from '../../../../core/learn/harness-types.js';
import { HARNESS_ADOPTION_GATE } from '../../../../core/learn/harness-types.js';
import type { ModelStats } from '../../../data/api-types.js';
import type { BarStackSegment } from '../../../components/charts/BarStack.js';
import { toneColor } from '../../../components/charts/colors.js';
import type { ForestRow } from '../../../components/charts/ForestPlot.js';
import type { StepMarker, StepPoint } from '../../../components/charts/StepBand.js';

export interface WeekBin {
  /** Epoch ms of the window's last day (UTC midnight). */
  end: number;
  /** YYYY-MM-DD of the last day. */
  endDay: string;
  merges: number | null;
  costUsd: number | null;
}

/** Complete 7-day windows ending on the last day of `days`, oldest first. */
export function weeklyBins(days: readonly FleetHistoryDay[]): WeekBin[] {
  const bins: WeekBin[] = [];
  for (let end = days.length; end - 7 >= 0; end -= 7) {
    const week = days.slice(end - 7, end);
    const sum = (pick: (d: FleetHistoryDay) => number | null): number | null => {
      let total = 0;
      for (const d of week) {
        const v = pick(d);
        if (v === null || !Number.isFinite(v)) return null;
        total += v;
      }
      return total;
    };
    const lastDay = week[week.length - 1]!.day;
    bins.unshift({ end: Date.parse(`${lastDay}T00:00:00Z`), endDay: lastDay, merges: sum((d) => d.merges.realized), costUsd: sum((d) => d.estCostUsd) });
  }
  return bins;
}

/** Dollars per merge; null when either side is unknown or nothing merged. */
export function costPerMerge(bin: WeekBin): number | null {
  if (bin.merges === null || bin.costUsd === null || bin.merges === 0) return null;
  return bin.costUsd / bin.merges;
}

// ---------------------------------------------------------------------------
// Model outcomes (ROI)
// ---------------------------------------------------------------------------

export const OUTCOME_SEGMENTS: BarStackSegment[] = [
  { id: 'merged', label: 'Merged', color: toneColor('success') },
  { id: 'ship', label: 'Judged ship, not merged', color: toneColor('info') },
  { id: 'rejected', label: 'Judged not worth shipping', color: toneColor('warning') },
  { id: 'unjudged', label: 'Not judged', color: toneColor('neutral') },
];

export interface ModelOutcomes {
  categories: string[];
  values: (number | null)[][];
  /** Per category, for the caption / table: dollars per merge. */
  costPerMerged: (number | null)[];
  models: ModelStats[];
}

/** A short, readable model label ("qwen3.8:27b", "grok-4.7"). */
export function modelLabel(m: Pick<ModelStats, 'engine' | 'model'>): string {
  const model = m.model.includes('/') ? m.model.split('/').pop()! : m.model;
  return model.length > 18 ? `${model.slice(0, 17)}…` : model;
}

/** Top `limit` models by dispatches, each split into what its dispatches became. */
export function modelOutcomes(models: readonly ModelStats[], limit = 6): ModelOutcomes {
  const top = [...models].filter((m) => m.dispatches > 0).sort((a, b) => b.dispatches - a.dispatches).slice(0, limit);
  return {
    categories: top.map(modelLabel),
    values: top.map((m) => {
      const merged = Math.max(0, m.merged);
      const ship = Math.max(0, m.shipVerdicts - merged);
      const rejected = Math.max(0, m.judged - m.shipVerdicts);
      const unjudged = Math.max(0, m.dispatches - m.judged);
      return [merged, ship, rejected, unjudged];
    }),
    costPerMerged: top.map((m) => m.costPerMergedUsd),
    models: top,
  };
}

// ---------------------------------------------------------------------------
// Harness steps + experiments
// ---------------------------------------------------------------------------

export interface HarnessSeries {
  steps: StepPoint[];
  markers: StepMarker[];
}

/**
 * The level of the ACTIVE harness over time, in points of paired pass-rate
 * lift over the compiled defaults. Each adoption adds its own experiment's
 * lift to the level of the version it was measured against; its band is that
 * experiment's 95% interval (the step's own uncertainty, not a compounded
 * one — the caption says so). A rollback returns to the parent's level.
 */
export function harnessSteps(learning: LearningStateV1 | null): HarnessSeries {
  if (!learning || learning.versions.length === 0) return { steps: [], markers: [] };
  const byId = new Map(learning.versions.map((v) => [v.id, v]));
  const exps = new Map(learning.experiments.map((e) => [e.id, e]));
  const level = new Map<string, number | null>();
  const events: { at: number; step?: StepPoint; marker?: StepMarker }[] = [];

  const baseline = [...learning.versions].sort((a, b) => a.seq - b.seq)[0]!;
  level.set(baseline.id, 0);
  const t0 = Date.parse(baseline.createdAt);
  if (Number.isFinite(t0)) events.push({ at: t0, step: { id: `${baseline.id}@base`, at: t0, value: 0, low: 0, high: 0, label: baseline.status === 'baseline' ? 'Compiled defaults' : baseline.id, detail: 'baseline' } });

  const adopted = learning.versions
    .filter((v) => v.adoptedAt && v.id !== baseline.id)
    .sort((a, b) => Date.parse(a.adoptedAt!) - Date.parse(b.adoptedAt!));
  for (const v of adopted) {
    const exp: ExperimentResultV1 | undefined = v.experimentId ? exps.get(v.experimentId) : undefined;
    const baseId = exp?.baseVersionId ?? v.parentId ?? baseline.id;
    const baseLevel = level.get(baseId) ?? (byId.has(baseId) ? null : 0);
    const lift = exp?.lift ?? null;
    const value = lift && baseLevel !== null && baseLevel !== undefined ? baseLevel + lift.mean : null;
    level.set(v.id, value);
    const at = Date.parse(v.adoptedAt!);
    if (!Number.isFinite(at)) continue;
    const detail = v.status === 'canary' ? 'canary' : v.status === 'rolled-back' ? 'adopted, later rolled back' : 'adopted';
    events.push({
      at,
      step: {
        id: `${v.id}@adopt`,
        at,
        value,
        low: value !== null && lift ? baseLevel! + lift.ciLow : null,
        high: value !== null && lift ? baseLevel! + lift.ciHigh : null,
        label: v.id,
        detail,
      },
    });
    if (v.rolledBackAt) {
      const back = Date.parse(v.rolledBackAt);
      if (Number.isFinite(back)) {
        const parentLevel = level.get(baseId) ?? null;
        const parent = byId.get(baseId);
        events.push({ at: back, marker: { id: `${v.id}@rb`, at: back, kind: 'rollback', label: `${v.id}: ${v.rollbackReason ?? 'rolled back'}` } });
        events.push({ at: back + 1, step: { id: `${v.id}@rb-step`, at: back + 1, value: parentLevel, low: null, high: null, label: parent?.id ?? baseId, detail: `restored after ${v.id} rolled back` } });
      }
    }
  }
  events.sort((a, b) => a.at - b.at);
  return {
    steps: events.flatMap((e) => (e.step ? [e.step] : [])),
    markers: events.flatMap((e) => (e.marker ? [e.marker] : [])),
  };
}

const VERDICT_WORD: Record<string, string> = { adopt: 'passed the gate', reject: 'rejected', inconclusive: 'inconclusive' };

export function forestRows(learning: LearningStateV1 | null): ForestRow[] {
  if (!learning) return [];
  return learning.experiments.map((e) => ({
    id: e.id,
    label: `${e.candidateVersionId} vs ${e.baseVersionId}`,
    estimate: e.lift?.mean ?? null,
    low: e.lift?.ciLow ?? null,
    high: e.lift?.ciHigh ?? null,
    n: e.pairs,
    detail:
      e.status === 'running' || e.status === 'queued'
        ? `${e.status} · ${e.pairs}/${HARNESS_ADOPTION_GATE.minPairs} pairs`
        : e.verdict
          ? VERDICT_WORD[e.verdict] ?? e.verdict
          : e.status,
  }));
}
