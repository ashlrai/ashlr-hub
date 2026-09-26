/**
 * routes/verse/mind/leader-model.ts — pure helpers over LeaderStateV1 for the
 * Command Leader card and the Mind surface (unit C7; SPEC-310B §4).
 *
 *   class A — applied now; Veto undoes it exactly (its recorded inverse);
 *   class B — waits out its veto window (a countdown ring), then applies;
 *   class C — outside the grant, never applied: shown as "needs you".
 *
 * Framework-free; tested directly.
 */
import type { LeaderAction, LeaderExpectedDelta, LeaderMemoSummary, LeaderStateV1 } from '../../../../core/vision/leader-types.js';

/** Actions a Veto can still act on: applied (undo) or scheduled (cancel). */
export function isVetoable(action: LeaderAction): boolean {
  return action.status === 'applied' || action.status === 'scheduled';
}

/** Remaining fraction (1 → 0) of a class-B action's veto window; null when it has none. */
export function vetoWindowFraction(action: Pick<LeaderAction, 'status' | 'createdAt' | 'applyAfter'>, now: number): number | null {
  if (action.status !== 'scheduled' || !action.applyAfter) return null;
  const start = Date.parse(action.createdAt);
  const end = Date.parse(action.applyAfter);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.max(0, Math.min(1, (end - now) / (end - start)));
}

/** "18m", "1h 04m", "applying…" */
export function countdownText(applyAfter: string | null, now: number): string {
  if (!applyAfter) return '';
  const ms = Date.parse(applyAfter) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return 'applying…';
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const METRIC_UNIT: Record<string, string> = { 'merges/day': 'merges/day' };

/** "+4 merges/day by Fri" */
export function expectedDeltaText(d: LeaderExpectedDelta | null): string | null {
  if (!d) return null;
  const by = Date.parse(d.byDate);
  const when = Number.isFinite(by) ? new Date(by).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : d.byDate;
  const n = Number.isInteger(d.delta) ? String(Math.abs(d.delta)) : Math.abs(d.delta).toFixed(1);
  return `${d.delta >= 0 ? '+' : '−'}${n} ${METRIC_UNIT[d.metric] ?? d.metric} by ${when}`;
}

export type OutcomeMark = 'hit' | 'miss' | 'pending' | 'ungraded';

export function outcomeMark(m: Pick<LeaderMemoSummary, 'outcome' | 'expectedDelta'>): OutcomeMark {
  if (!m.expectedDelta) return 'ungraded';
  if (!m.outcome) return 'pending';
  if (m.outcome.hit === null) return 'ungraded';
  return m.outcome.hit ? 'hit' : 'miss';
}

export const OUTCOME_WORD: Record<OutcomeMark, string> = {
  hit: 'hit',
  miss: 'missed',
  pending: 'graded in 7 days',
  ungraded: 'not gradeable',
};

/** The latest memo's actions, class-C last (they are asks, not actions). */
export function memoActions(state: LeaderStateV1 | null): LeaderAction[] {
  if (!state?.latest) return [];
  const byId = new Map(state.actions.map((a) => [a.id, a]));
  // The state's action list carries the newest status; fall back to the memo's copy.
  const list = state.latest.actions.map((a) => byId.get(a.id) ?? a);
  const order = { A: 0, B: 1, C: 2 } as const;
  return list.sort((a, b) => order[a.class] - order[b.class] || Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export const STATUS_WORD: Record<LeaderAction['status'], string> = {
  scheduled: 'Scheduled',
  applied: 'Applied',
  vetoed: 'Vetoed',
  refused: 'Refused',
  failed: 'Failed',
  escalated: 'Needs you',
};

/**
 * The Leader has nothing to show — no memo, no action, nothing graded, no
 * standard — so Mind says it once instead of three empty cards. The title is
 * the fact; the line is the last run's own reason when it gave one. Null
 * while the Leader has anything to show (or has not answered).
 */
export function leaderSilence(state: LeaderStateV1 | null): { title: string; why: string | null } | null {
  if (!state) return null;
  const standards = state.standards.filter((s) => s.retiredAt === null);
  if (state.timeline.length || state.actions.length || state.hitRate.graded > 0 || standards.length) return null;
  const reason = state.lastRun?.reason?.trim() || null;
  return {
    title: state.lastRun ? "The Leader hasn't written a memo yet." : "The Leader hasn't run yet.",
    why: reason ? (/[.!?…]$/.test(reason) ? reason : `${reason}.`) : null,
  };
}
