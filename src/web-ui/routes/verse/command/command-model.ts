/**
 * routes/verse/command/command-model.ts — the pure numbers behind Command's
 * KPI row, "Since you looked" strip, seat burn-downs and the Needs-you card
 * (unit C7; SPEC-310B §6, SPEC-310C §5).
 *
 * Honesty (docs/VERSE-TELEMETRY-V2.md): a KPI whose source did not answer
 * is "—", and a delta is computed only when BOTH windows are fully known — a
 * week with one unreadable day has no honest "vs prior 7d". Framework-free;
 * tested directly.
 */
import type { FleetLiveSnapshotV1, FleetLiveRun } from '../../../../core/fleet/fleet-types.js';
import type { LeaderStateV1 } from '../../../../core/vision/leader-types.js';
import type { LearningStateV1 } from '../../../../core/learn/harness-types.js';
import type { NeedsYouItem, NeedsYouSeverity, VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import type { FleetHistoryDay, FleetHistoryResponse } from '../../../../core/verse/fleet-history-types.js';
import type { BudgetView } from '../../../../core/routing/policy.js';
import type { EffectivePolicy } from '../../../../core/authority/types.js';
import type { StatTileDelta } from '../../../components/charts/StatTile.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// Windows over the daily history
// ---------------------------------------------------------------------------

/** Sum of `pick` over days [end-len, end); null if any day in the window is unknown or missing. */
export function windowSum(days: readonly FleetHistoryDay[], pick: (d: FleetHistoryDay) => number | null, len: number, endOffset = 0): number | null {
  const end = days.length - endOffset;
  const start = end - len;
  if (start < 0 || len <= 0) return null;
  let total = 0;
  for (let i = start; i < end; i++) {
    const v = pick(days[i]!);
    if (v === null || !Number.isFinite(v)) return null;
    total += v;
  }
  return total;
}

/** The last `len` values of `pick`, oldest first (nulls kept — the sparkline breaks there). */
export function lastValues(days: readonly FleetHistoryDay[], pick: (d: FleetHistoryDay) => number | null, len: number): (number | null)[] {
  return days.slice(Math.max(0, days.length - len)).map(pick);
}

function mean(values: readonly (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

// ---------------------------------------------------------------------------
// KPI row
// ---------------------------------------------------------------------------

export interface Kpi {
  id: 'merged' | 'green' | 'cycle' | 'spend' | 'lift';
  label: string;
  /** Display string; "—" when unknown. */
  value: string;
  delta: StatTileDelta | null;
  trend: (number | null)[] | undefined;
  trendLabel: string;
  caption: string;
}

export interface KpiInputs {
  fleet: FleetLiveSnapshotV1 | null;
  history: FleetHistoryResponse | null;
  learning: LearningStateV1 | null;
  policy: EffectivePolicy | null;
}

const signedInt = (v: number) => (v > 0 ? `+${v}` : String(v));
const signedPts = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;

/** "2h 14m", "38m", "3d 2h". */
export function formatSpan(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Mean daily post-merge green % across repos, per day (oldest first, 14 days). */
export function greenTrend(fleet: FleetLiveSnapshotV1 | null): (number | null)[] {
  if (!fleet || fleet.repos.length === 0) return [];
  const len = Math.max(...fleet.repos.map((r) => r.greenTrend.length));
  return Array.from({ length: len }, (_, i) => mean(fleet.repos.map((r) => r.greenTrend[i - (len - r.greenTrend.length)] ?? null)));
}

export function buildKpis({ fleet, history, learning, policy }: KpiInputs): Kpi[] {
  const days = history?.days ?? [];
  const merges = (d: FleetHistoryDay) => d.merges.realized;
  const spend = (d: FleetHistoryDay) => d.estCostUsd;

  // Merged · 7d — the live summary when the daemon answers, else the history window.
  const merged7 = fleet?.summary.merged7d ?? windowSum(days, merges, 7);
  const mergedPrior = windowSum(days, merges, 7, 7);
  const mergedNow = windowSum(days, merges, 7);
  const mergedDelta = mergedNow !== null && mergedPrior !== null ? mergedNow - mergedPrior : null;

  // Post-merge green — the 7-day figure plus the 14-day repo trend.
  const green = fleet?.summary.postMergeGreenPct7d ?? null;
  const gTrend = greenTrend(fleet);
  const gNow = gTrend.length >= 14 ? mean(gTrend.slice(-7)) : null;
  const gPrior = gTrend.length >= 14 ? mean(gTrend.slice(-14, -7)) : null;
  const greenDelta = gNow !== null && gPrior !== null ? gNow - gPrior : null;

  // Spend vs cap — metered spend only; subscriptions are not billed per token.
  const spend7 = windowSum(days, spend, 7);
  const spendPrior = windowSum(days, spend, 7, 7);
  const capPerDay = policy ? policy.spend.meteredUsdPerDay : null;
  const spendValue = spend7 === null ? '—' : `$${spend7.toFixed(2)}${capPerDay !== null ? ` / $${(capPerDay * 7).toFixed(0)}` : ''}`;

  // Lift — the active harness's own experiment (null = baseline in force).
  const active = learning?.active ?? null;
  const activeExp = active?.experimentId ? learning?.experiments.find((e) => e.id === active.experimentId) ?? null : null;
  const lift = activeExp?.lift ?? null;

  return [
    {
      id: 'merged',
      label: 'Merged · 7d',
      value: merged7 === null ? '—' : String(merged7),
      delta: mergedDelta === null ? null : { value: mergedDelta, unit: Math.abs(mergedDelta) === 1 ? 'merge' : 'merges', versus: 'vs prior 7d', goodWhenPositive: true, format: signedInt },
      trend: days.length ? lastValues(days, merges, 14) : undefined,
      trendLabel: 'Merges per day, last 14 days',
      caption: fleet?.summary.mergedToday != null ? `${fleet.summary.mergedToday} today` : 'fleet merges on default branches',
    },
    {
      id: 'green',
      label: 'Post-merge green',
      value: green === null ? '—' : `${Math.round(green)}%`,
      delta: greenDelta === null ? null : { value: greenDelta, unit: 'pts', versus: 'vs prior 7d', goodWhenPositive: true, format: signedPts },
      trend: gTrend.length ? gTrend : undefined,
      trendLabel: 'Post-merge green percent per day',
      caption: green === null ? 'no completed post-merge watch yet' : 'CI + suite 2 h after each merge',
    },
    {
      id: 'cycle',
      label: 'Cycle time',
      value: formatSpan(fleet?.summary.cycleTimeP50Ms7d ?? null),
      delta: null,
      trend: undefined,
      trendLabel: 'Cycle time',
      caption: 'median, proposal → merge, 7d',
    },
    {
      id: 'spend',
      label: 'Spend vs cap · 7d',
      value: spendValue,
      delta: spend7 !== null && spendPrior !== null ? { value: spend7 - spendPrior, versus: 'vs prior 7d', goodWhenPositive: false, format: signedUsd } : null,
      trend: days.length ? lastValues(days, spend, 14) : undefined,
      trendLabel: 'Estimated metered spend per day',
      caption: capPerDay === 0 ? 'metered APIs off — subscriptions only' : 'metered APIs; subscriptions not billed per token',
    },
    {
      id: 'lift',
      label: 'Lift',
      value: lift ? `${signedPts(lift.mean)} pts` : '—',
      delta: null,
      trend: undefined,
      trendLabel: 'Harness lift',
      caption: active ? `harness ${active.id} vs baseline${lift ? ` (95% ${signedPts(lift.ciLow)} to ${signedPts(lift.ciHigh)})` : ''}` : 'no harness adopted — defaults in force',
    },
  ];
}

// ---------------------------------------------------------------------------
// Since you looked
// ---------------------------------------------------------------------------

export interface SinceItem {
  id: string;
  text: string;
  tone: 'success' | 'danger' | 'warning' | 'neutral' | 'info';
}

export interface SinceInputs {
  /** ISO of the previous visit; null = first visit (nothing is "new"). */
  lastLookedAt: string | null;
  fleet: FleetLiveSnapshotV1 | null;
  leader: LeaderStateV1 | null;
  activity: VerseActivityResponse | null;
}

const after = (iso: string | null, t: number) => iso !== null && Date.parse(iso) > t;

/** What changed since the operator last opened Command, newest kinds first. */
export function sinceYouLooked({ lastLookedAt, fleet, leader, activity }: SinceInputs): SinceItem[] {
  if (!lastLookedAt) return [];
  const t = Date.parse(lastLookedAt);
  if (!Number.isFinite(t)) return [];
  const out: SinceItem[] = [];
  const ended = (fleet?.runs ?? []).filter((r) => after(r.endedAt, t));
  const count = (o: FleetLiveRun['outcome']) => ended.filter((r) => r.outcome === o).length;
  const merged = count('merged');
  const reverted = count('reverted');
  const failed = count('failed') + count('refused');
  if (merged) out.push({ id: 'merged', text: `${merged} merged`, tone: 'success' });
  if (reverted) out.push({ id: 'reverted', text: `${reverted} reverted`, tone: 'danger' });
  if (failed) out.push({ id: 'failed', text: `${failed} refused or failed`, tone: 'warning' });
  const memos = (leader?.timeline ?? []).filter((m) => Date.parse(m.at) > t && m.status === 'ok').length;
  if (memos) out.push({ id: 'memos', text: `${memos} new memo${memos === 1 ? '' : 's'}`, tone: 'info' });
  const fresh = (activity?.needsYou ?? []).filter((i) => Date.parse(i.since) > t).length;
  if (fresh) out.push({ id: 'needs', text: `${fresh} new for you`, tone: 'warning' });
  return out;
}

// ---------------------------------------------------------------------------
// Needs you (Command card)
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<NeedsYouSeverity, number> = { high: 0, warn: 1, info: 2 };

/** Most severe first, then newest. Pure — the drawer (C1) owns the full list. */
export function rankNeedsYou(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || Date.parse(b.since) - Date.parse(a.since));
}

/** Sources that did not answer — the card must not say "All clear" while any is listed. */
export function silentSources(activity: VerseActivityResponse | null): string[] {
  if (!activity) return [];
  return Object.entries(activity.sources).filter(([, state]) => state !== 'ok').map(([source]) => source);
}

// ---------------------------------------------------------------------------
// Seat burn-downs
// ---------------------------------------------------------------------------

export interface SeatReading {
  t: number;
  /** Percent of the binding window used, 0–100. */
  used: number;
}

/**
 * The readings the page has seen per seat. WHY client-side: the budget route
 * serves ONE reading per seat (its current headroom); no window history is
 * persisted server-side yet (CROSS-UNIT REQUEST to A9/C6). So the burn-down
 * starts with what this viewer has observed since Verse opened, says so, and
 * never draws a guessed history. Memory only, bounded.
 */
export const SEAT_READINGS_MAX = 240;

export function recordReading(history: Readonly<Record<string, SeatReading[]>>, view: BudgetView | null): Record<string, SeatReading[]> {
  if (!view) return { ...history };
  const t = Date.parse(view.sampledAt);
  if (!Number.isFinite(t)) return { ...history };
  const next: Record<string, SeatReading[]> = { ...history };
  for (const h of view.headroom) {
    const used = h.bindingWindow === 'session' ? h.sessionUsedPercent : h.bindingWindow === 'weekly' ? h.weeklyUsedPercent : null;
    if (used === null || !Number.isFinite(used)) continue;
    const prev = next[h.seatId] ?? [];
    if (prev.length && prev[prev.length - 1]!.t >= t) continue;
    // A reset (used dropped sharply) starts a new window — drop the old one.
    const fresh = prev.length && used + 20 < prev[prev.length - 1]!.used ? [] : prev;
    next[h.seatId] = [...fresh, { t, used }].slice(-SEAT_READINGS_MAX);
  }
  return next;
}

export interface SeatBurn {
  seatId: string;
  label: string;
  engine: 'claude' | 'codex' | 'grok' | 'local';
  window: 'session' | 'weekly' | null;
  /** Remaining percent readings (100 − used). */
  points: { t: number; remaining: number | null }[];
  start: number | null;
  resetAt: number | null;
  reservePercent: number;
  enabled: boolean;
  free: boolean;
  eligible: boolean;
  reason: string | null;
}

const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * DAY } as const;

/** One burn-down per seat, paid seats first (they are the ones that run out). */
export function seatBurns(view: BudgetView | null, history: Readonly<Record<string, SeatReading[]>>): SeatBurn[] {
  if (!view) return [];
  const info = new Map(view.seatInfo.map((s) => [s.seatId, s]));
  return view.headroom
    .map((h): SeatBurn => {
      const i = info.get(h.seatId);
      const resetAt = h.resetAt ? Date.parse(h.resetAt) : NaN;
      const windowMs = h.bindingWindow ? WINDOW_MS[h.bindingWindow] : null;
      const start = Number.isFinite(resetAt) && windowMs ? resetAt - windowMs : null;
      const readings = history[h.seatId] ?? [];
      return {
        seatId: h.seatId,
        label: i?.label ?? h.seatId,
        engine: i?.engine ?? 'local',
        window: h.bindingWindow,
        points: readings.filter((r) => start === null || r.t >= start).map((r) => ({ t: r.t, remaining: Math.max(0, 100 - r.used) })),
        start,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
        reservePercent: view.effective[h.seatId]?.reservePercent ?? 0,
        enabled: view.effective[h.seatId]?.enabled ?? false,
        free: i?.free ?? false,
        eligible: h.eligibleForAutonomy,
        reason: h.reasons[0] ?? null,
      };
    })
    .sort((a, b) => Number(a.free) - Number(b.free) || a.label.localeCompare(b.label));
}

/** "Claude 40% reserved for you" — the first enabled Claude seat's reserve, from the live budget. */
export function claudeReserve(view: BudgetView | null): { label: string; percent: number } | null {
  if (!view) return null;
  const seat = view.seatInfo.find((s) => s.engine === 'claude');
  if (!seat) return null;
  const policy = view.effective[seat.seatId];
  return policy ? { label: 'Claude', percent: policy.reservePercent } : null;
}
