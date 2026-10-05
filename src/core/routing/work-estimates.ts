/** Pure estimates from metadata-only completed observations, never initialized budgets. */
import type { TaskWorkForecast, ObservedPercentiles } from './scheduling-types.js';
export interface WorkHistorySample {
  id: string; engine: string; model: string | null; seatId: string | null; taskKind: string;
  /** Native account proof recorded with the routed attempt, absent legacy data stays pooled. */
  accountHint?: string | null;
  completed: boolean; durationMs: number | null; tokens: number | null;
}
export function observedPercentiles(values: readonly (number | null)[]): ObservedPercentiles | null {
  const sorted = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const pick = (q: number) => sorted[Math.min(sorted.length-1, Math.ceil(sorted.length*q)-1)]!;
  return { p25: pick(.25), p50: pick(.5), p75: pick(.75), samples: sorted.length };
}
export function forecastWork(taskId: string, cohort: TaskWorkForecast['cohort'], history: readonly WorkHistorySample[]): TaskWorkForecast {
  // Exact engine/model/task cohort; account-less observations stay explicitly
  // pooled. No keyword fallback to all history or percentage-to-token fiction.
  const unique = new Map(history.filter((v) => v.completed && v.engine === cohort.engine && v.model === cohort.model &&
    v.taskKind === cohort.taskKind && (cohort.seatId === null || v.seatId === cohort.seatId)).map((v) => [v.id,v]));
  const samples = cohort.model === null ? [] : [...unique.values()];
  const durationMs = observedPercentiles(samples.map((v) => v.durationMs));
  const tokens = observedPercentiles(samples.map((v) => v.tokens));
  return { taskId, cohort, durationMs, tokens, fit: 'unknown', limitations: [
    ...(cohort.model === null ? ['Actual selected model is unknown; no model-compatible estimate is claimed.'] : []),
    ...(cohort.seatId === null ? ['Observations are pooled by engine/model/task kind; account attribution is unavailable.'] : []),
    ...(!durationMs ? ['No compatible positive completed-duration observations.'] : ['Observed duration includes execution overhead; future work can differ.']),
    ...(!tokens ? ['No compatible positive reported-token observations.'] : []),
    'Provider quota token allowance is unknown; headroom percent is not converted to tokens.',
  ] };
}
