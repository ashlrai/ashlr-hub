/** Advisory scheduling metadata. This never changes a signed observation or admission. */
export interface ResetProvenance {
  kind: 'fixed-period' | 'weekly-deadline' | 'rolling-release' | 'balance' | 'unknown';
  at: string | null;
  description: string | null;
  source: string | null;
  /** Native subscription plan qualified before/after the current quota reply. */
  plan?: 'pro' | 'max' | 'plus';
  /** Exact native length used to qualify a Codex weekly deadline, never an inferred start. */
  windowDurationMins?: 10080;
  /** Provider-reported start, never inferred from a percentage. */
  startsAt?: string | null;
}
export interface ObservedPercentiles { p25: number; p50: number; p75: number; samples: number }
export interface TaskWorkForecast {
  taskId: string;
  /** When this real selected-batch estimate was recorded; absent means unknown. */
  recordedAt?: string;
  durationMs: ObservedPercentiles | null;
  tokens: ObservedPercentiles | null;
  cohort: { engine: string; model: string | null; seatId: string | null; taskKind: string };
  fit: 'likely-before-reset' | 'uncertain' | 'unlikely-before-reset' | 'unknown';
  limitations: string[];
}
export interface AccountSchedulingView {
  seatId: string;
  observedAt: string | null;
  admission: 'eligible' | 'held' | 'unknown';
  headroomPercent: number | null;
  reset: ResetProvenance;
  opportunity: { kind: 'before-reset' | 'ordinary' | 'held' | 'unknown'; reason: string };
  forecast: TaskWorkForecast | null;
}
export interface SchedulingAdviceView {
  observedAt: string;
  state: 'choice-returned' | 'fallback' | 'skipped';
  reason: 'stop-active' | 'preparation-cancelled' | 'signed-metered-unavailable' | 'metered-allowance-exhausted' | 'no-comparable-pairs' | 'no-eligible-choice' | 'eligible-choice-returned';
}
export interface SchedulingView {
  sourceState: 'ready' | 'unavailable';
  observedAt: string;
  accounts: AccountSchedulingView[];
  /** Recorded selected-batch advice, not a provider-health or dispatch receipt. */
  advisory?: SchedulingAdviceView;
}
/** Internal correlated IDs are never sent verbatim to the advisory provider. */
export interface ResourceChoiceCandidate {
  id: string; taskId: string; seatId: string; engine: string; model: string | null;
  taskKind: string; headroomPercent: number | null; resetAt: string | null;
  /** Absent legacy quartile means unknown fit, never inferred from p75. */
  durationP25Ms?: number | null;
  durationP75Ms: number | null; reason: string;
}
