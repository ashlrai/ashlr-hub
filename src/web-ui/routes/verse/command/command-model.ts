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
import type { CapacityHistoryResponse } from '../../../../core/routing/capacity-history-types.js';
import type { SeatReason, SeatReasonKind } from '../../../../core/routing/types.js';
import type { VerseSeat } from '../../../../core/verse/types.js';
import { classifyWindow } from '../../../../core/routing/headroom.js';
import { describeResetAt } from '../../../../core/verse/seat-readiness.js';
import type { EffectivePolicy } from '../../../../core/authority/types.js';
import type { StatTileDelta } from '../../../components/charts/StatTile.js';
import { asSentence, localTimes, parseLegacyReason } from '../fleet/why-seat-model.js';

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
  /**
   * The live budget view, for subscription usage as PERCENT of each paid
   * seat's binding window. Optional so a caller without it still renders the
   * metered figure honestly; the caption then points at the seat burn-downs.
   */
  budget?: BudgetView | null;
}

/**
 * The per-token (metered API) part of a day's spend, when the server splits
 * it out. WHY not `estCostUsd`: that field prices EVERY run's tokens from a
 * static table — Claude/Codex/Grok subscription CLI runs included — so
 * showing it as "spend vs the metered cap" reported subscription work as a
 * budget breach (review 3.10 c10; the default grant's cap is $0/day).
 * Subscriptions are not billed per token: their cost is window usage, shown
 * as percent. fleet-history reports `meteredCostUsd` per day (per-token API
 * engines only — core/verse/fleet-history.ts `runBilling`); a server that
 * predates it leaves the figure unknown — "—", never the mixed estimate.
 */
export function meteredCost(d: FleetHistoryDay): number | null {
  const v = (d as FleetHistoryDay & { meteredCostUsd?: number | null }).meteredCostUsd;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** "Claude 54% · Grok 31% of window used" — paid seats' binding-window usage, never dollars. */
export function subscriptionUsage(view: BudgetView | null | undefined): string | null {
  if (!view) return null;
  const info = new Map(view.seatInfo.map((s) => [s.seatId, s]));
  const parts: string[] = [];
  for (const h of view.headroom) {
    const seat = info.get(h.seatId);
    if (!seat || seat.free) continue;
    const used = h.bindingWindow === 'session' ? h.sessionUsedPercent : h.bindingWindow === 'weekly' ? h.weeklyUsedPercent : null;
    parts.push(`${seat.label} ${used === null || !Number.isFinite(used) ? '—' : `${Math.round(used)}%`}`);
  }
  return parts.length ? `${parts.join(' · ')} of window used` : null;
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

export function buildKpis({ fleet, history, learning, policy, budget }: KpiInputs): Kpi[] {
  const days = history?.days ?? [];
  const merges = (d: FleetHistoryDay) => d.merges.realized;
  const spend = meteredCost;

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

  // Metered spend vs cap — per-token API spend ONLY (see meteredCost);
  // subscriptions go in the caption as percent of their window.
  const spend7 = windowSum(days, spend, 7);
  const spendPrior = windowSum(days, spend, 7, 7);
  const capPerDay = policy ? policy.spend.meteredUsdPerDay : null;
  const spendValue = spend7 === null ? '—' : `$${spend7.toFixed(2)}${capPerDay !== null ? ` / $${(capPerDay * 7).toFixed(0)}` : ''}`;
  const meteredKnown = days.some((d) => meteredCost(d) !== null);
  const capWords = capPerDay === null ? null : capPerDay === 0 ? 'metered APIs off ($0 cap)' : `cap $${capPerDay}/day`;
  const subs = subscriptionUsage(budget);
  const spendCaption = [
    capWords,
    meteredKnown ? null : 'metered split not reported yet',
    subs ? `subscriptions: ${subs}` : 'subscriptions are window usage, not dollars — see seat capacity',
  ]
    .filter(Boolean)
    .join(' · ');

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
      label: 'Metered spend · 7d',
      value: spendValue,
      delta: spend7 !== null && spendPrior !== null ? { value: spend7 - spendPrior, versus: 'vs prior 7d', goodWhenPositive: false, format: signedUsd } : null,
      trend: meteredKnown ? lastValues(days, spend, 14) : undefined,
      trendLabel: 'Metered (per-token API) spend per day',
      caption: spendCaption,
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

/**
 * Seat id → the label every other surface names that seat by ("Claude Max",
 * never "claude-a"): the live roster when the cache holds it, else the
 * budget route's seat info (polled on Command, so present when the roster is
 * not). Both carry the same `VerseSeat.label` for the same id.
 */
export function seatNames(
  seats: readonly Pick<VerseSeat, 'id' | 'label'>[] | null | undefined,
  view: Pick<BudgetView, 'seatInfo'> | null | undefined,
): Map<string, string> {
  const names = new Map<string, string>();
  const put = (id: unknown, label: unknown) => {
    if (typeof id === 'string' && typeof label === 'string' && label.trim().length > 0) names.set(id, label.trim());
  };
  for (const s of view?.seatInfo ?? []) put(s.seatId, s.label);
  for (const s of seats ?? []) put(s.id, s.label);
  return names;
}

/** Sources that did not answer — the card must not say "All clear" while any is listed. */
export function silentSources(activity: VerseActivityResponse | null): string[] {
  if (!activity) return [];
  return Object.entries(activity.sources).filter(([, state]) => state !== 'ok').map(([source]) => source);
}

// ---------------------------------------------------------------------------
// Seat burn-downs
// ---------------------------------------------------------------------------

export type SeatWindow = 'session' | 'weekly';

export interface SeatReading {
  t: number;
  /** Percent of the window used, 0–100. */
  used: number;
}

/**
 * Readings are kept per seat WINDOW, not per seat: the binding window can flip
 * between the 5-hour and the weekly window from one poll to the next, and a
 * line that mixed the two would draw a jump that never happened. Seat ids may
 * contain `:` and `/`, never `#` (the server keys its history the same way).
 */
export function seriesKey(seatId: string, window: SeatWindow): string {
  return `${seatId}#${window}`;
}

/**
 * The readings this page has seen since Verse opened, per seat window. The
 * budget route serves ONE reading per seat, so on their own these start the
 * burn-down empty on every load; `mergeSeatHistory` adds the server's recorded
 * history (GET /api/verse/budget/history — core/routing/capacity-history.ts,
 * written by the capacity publishers), so a reload keeps the whole window.
 * Memory only, bounded; never a guessed history.
 *
 * The bound counts CHANGES, not polls: a flat run keeps only its two ends
 * (see `recordReading`). At one poll per 30 s a plain 240-reading ring held
 * two hours — a sliver of a 7-day window — while window percent moves in
 * whole points a few times an hour.
 */
export const SEAT_READINGS_MAX = 240;
/** A merged line (recorded history + this page's readings), flat runs collapsed: a week of changes fits. */
export const SEAT_HISTORY_MAX = 2000;
/** A drop this large between consecutive readings is a window reset: the line starts again. */
const RESET_DROP = 20;

function isFlatEnd(line: readonly SeatReading[], used: number): boolean {
  const n = line.length;
  return n >= 2 && line[n - 1]!.used === used && line[n - 2]!.used === used;
}

export function recordReading(history: Readonly<Record<string, SeatReading[]>>, view: BudgetView | null): Record<string, SeatReading[]> {
  if (!view) return { ...history };
  const t = Date.parse(view.sampledAt);
  if (!Number.isFinite(t)) return { ...history };
  const next: Record<string, SeatReading[]> = { ...history };
  for (const h of view.headroom) {
    const windows: [SeatWindow, number | null][] = [['session', h.sessionUsedPercent], ['weekly', h.weeklyUsedPercent]];
    for (const [window, used] of windows) {
      if (used === null || !Number.isFinite(used)) continue;
      const key = seriesKey(h.seatId, window);
      const prev = next[key] ?? [];
      if (prev.length && prev[prev.length - 1]!.t >= t) continue;
      // A reset (used dropped sharply) starts a new window — drop the old one.
      const fresh = prev.length && used + RESET_DROP < prev[prev.length - 1]!.used ? [] : prev;
      // A flat run keeps only its first and latest reading: the line through
      // them is identical, and the ring then spans hours or days, not minutes.
      next[key] = [...(isFlatEnd(fresh, used) ? fresh.slice(0, -1) : fresh), { t, used }].slice(-SEAT_READINGS_MAX);
    }
  }
  return next;
}

export interface MergedSeatHistory {
  /** One line per seat window, oldest first, starting after its last reset. */
  readings: Record<string, SeatReading[]>;
  /** Series keys the server's recorded history contributed readings to. */
  recorded: ReadonlySet<string>;
}

/**
 * The server's recorded history merged with this page's live readings, per
 * seat window: oldest first, one reading per instant, cut after the last
 * reset drop and with flat runs collapsed — the same rules `recordReading`
 * applies, so the line reads the same either way. `server` is untrusted wire
 * data: malformed series and points are skipped.
 *
 * ONE CLOCK PER STRETCH OF LINE (review 3.10.1). The two sources stamp the
 * same observation differently: a recorded row carries the provider
 * reading's `observedAt` (capacity-history.ts), a live reading the budget
 * route's `sampledAt` — when it was ASKED, which is later, and the budget
 * wire carries no `observedAt` to do better. Interleaved, the same value
 * lands at two instants and an older value can sort after a newer one: a
 * poll just after a reset still serving 85% drew 85 → 3 → 85 → 3. So the
 * recorded history is authoritative for every instant it covers — up to the
 * moment the server answered (`generatedAt`), or its newest row when that is
 * later or `generatedAt` is unreadable — and live readings only extend a
 * recorded line past that point. The server records the snapshot behind
 * each budget read (capacity-history-api.ts, throttled to 15 s), so a live
 * reading hidden this way is recorded at its own `observedAt` by the next
 * history read, and until then the next live poll carries the same value.
 * A live reading after `generatedAt` came from a collector that had already
 * seen every recorded observation, so the extension never runs backwards.
 * Both instants are the Verse server's own clock. A window with no recorded
 * series keeps every live reading.
 */
export function mergeSeatHistory(live: Readonly<Record<string, SeatReading[]>>, server: CapacityHistoryResponse | null): MergedSeatHistory {
  const generatedAt = typeof server?.generatedAt === 'string' ? Date.parse(server.generatedAt) : Number.NaN;
  const persisted = new Map<string, SeatReading[]>();
  for (const series of Array.isArray(server?.series) ? server!.series : []) {
    if (!series || typeof series.seatId !== 'string' || (series.window !== 'session' && series.window !== 'weekly') || !Array.isArray(series.points)) continue;
    const points: SeatReading[] = [];
    for (const p of series.points) {
      if (!Array.isArray(p)) continue;
      const [t, used] = p as unknown[];
      if (typeof t === 'number' && Number.isFinite(t) && typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100) points.push({ t, used });
    }
    if (points.length === 0) continue;
    const key = seriesKey(series.seatId, series.window);
    persisted.set(key, [...(persisted.get(key) ?? []), ...points]);
  }
  const readings: Record<string, SeatReading[]> = {};
  const recorded = new Set<string>();
  for (const key of new Set([...Object.keys(live), ...persisted.keys()])) {
    const fromServer = persisted.get(key) ?? [];
    let fromPage = live[key] ?? [];
    if (fromServer.length > 0) {
      recorded.add(key);
      const newestRecorded = Math.max(...fromServer.map((r) => r.t));
      const coveredTo = Number.isFinite(generatedAt) ? Math.max(generatedAt, newestRecorded) : newestRecorded;
      fromPage = fromPage.filter((r) => r.t > coveredTo);
    }
    // Recorded rows can repeat an instant (two series under one key); the
    // last one read stands. Live readings are strictly later than all of them.
    const byT = new Map<number, SeatReading>();
    for (const r of fromServer) byT.set(r.t, r);
    for (const r of fromPage) byT.set(r.t, r);
    const sorted = [...byT.values()].sort((a, b) => a.t - b.t);
    let start = 0;
    for (let i = 1; i < sorted.length; i++) if (sorted[i]!.used + RESET_DROP < sorted[i - 1]!.used) start = i;
    const line: SeatReading[] = [];
    for (const r of sorted.slice(start)) {
      if (isFlatEnd(line, r.used)) line.pop();
      line.push(r);
    }
    readings[key] = line.slice(-SEAT_HISTORY_MAX);
  }
  return { readings, recorded };
}

export interface SeatBurn {
  seatId: string;
  label: string;
  engine: 'claude' | 'codex' | 'grok' | 'local';
  window: 'session' | 'weekly' | null;
  /** Remaining percent readings (100 − used), inside [start, resetAt] when the reset is known. */
  points: { t: number; remaining: number | null }[];
  /** `resetAt` minus the window's length; null exactly when `resetAt` is. */
  start: number | null;
  resetAt: number | null;
  /**
   * Where `resetAt` came from: the budget route's machine instant
   * ('provider'), the provider's own reset words read on the clock they name
   * ('words' — see `resetInstantFromWords`), or nowhere (null).
   */
  resetFrom: 'provider' | 'words' | null;
  /**
   * The provider's own reset wording for the binding window, verbatim
   * ("Sep 25 at 7pm (America/New_York)"), when the seat roster carries it.
   * Claude publishes ONLY this — never a machine instant. The card always
   * shows the words; when they name a clock time inside this window they
   * also place the reset (`resetFrom: 'words'`), otherwise the card draws the
   * readings with no reset point or projection.
   */
  resetText: string | null;
  reservePercent: number;
  /**
   * The line autonomy stops at IN THE WINDOW THIS CHART DRAWS, as remaining
   * percent (see `bindingLine`); null when that window has no limit.
   */
  line: { value: number; label: string } | null;
  enabled: boolean;
  free: boolean;
  eligible: boolean;
  /**
   * The router's first reason for this seat in words (`seatReasonText`):
   * complete sentences, local times, never the log form's " (resets <ISO>)."
   * clause. Null when the route gave none.
   */
  reason: string | null;
  /**
   * True when the server's recorded history contributed to this window's
   * line; false when every point is one this page saw since Verse opened.
   * Picks the card's note when the line starts late in the window.
   */
  recorded: boolean;
}

/** Length of each provider window, for the chart domain (reset − length → reset). */
export const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * DAY } as const;

/**
 * The stop line for the binding window, mirroring core/routing/headroom.ts
 * exactly (review 3.10 d2). The reserve protects the LONG (weekly) window;
 * the 5-hour window is capped by `maxSessionWindowPercent` — except when the
 * seat has no weekly window at all, where the short one carries both limits
 * and the tighter one wins. Drawing the weekly reserve on a 5-hour chart put
 * Mason's balanced cutoff at 60% used instead of 70% and made the verdict say
 * "autonomy has stopped" while the server still had the seat eligible.
 *
 * `weeklyUsedPercent === null` stands in for "no weekly window": a weekly
 * window whose reading is unknown makes the seat ineligible server-side
 * anyway (unknown usage is never headroom), and the card shows that reason.
 */
export function bindingLine(
  h: { bindingWindow: 'session' | 'weekly' | null; weeklyUsedPercent: number | null },
  policy: { reservePercent: number; maxSessionWindowPercent?: number } | undefined,
): { value: number; label: string } | null {
  if (!policy || h.bindingWindow === null) return null;
  const reserveCeiling = 100 - policy.reservePercent;
  const sessionCeiling = policy.maxSessionWindowPercent ?? 100;
  let ceiling: number;
  let label: string;
  if (h.bindingWindow === 'weekly') {
    ceiling = reserveCeiling;
    label = 'Reserved for you';
  } else if (h.weeklyUsedPercent === null && reserveCeiling < sessionCeiling) {
    ceiling = reserveCeiling;
    label = 'Reserved for you';
  } else {
    ceiling = sessionCeiling;
    label = '5-hour ceiling';
  }
  const value = 100 - ceiling;
  return value > 0 ? { value, label } : null;
}

/**
 * Axis/verdict time format per window (review 3.10 c17). A weekly window
 * starts exactly seven days before it resets, so weekday + time alone printed
 * "Sat 10:27 AM … Resets Sat 10:27 AM"; the weekly form carries the date.
 * It carries ONLY the date (3.10.1): inside one week the weekday repeats what
 * the date says, and at a quarter-width card "Fri, Sep 18 at 11:46 PM" +
 * "Resets Fri, Sep 25 at 11:46 PM" were wider than the plot and collided.
 */
export function burnTimeFormat(window: 'session' | 'weekly' | null): (ms: number) => string {
  const opts: Intl.DateTimeFormatOptions =
    window === 'session'
      ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return (ms) => {
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', opts);
  };
}

/**
 * The provider's reset wording for the seat window that plays `binding`'s
 * role. WHY the seat roster and not the budget route: `SeatHeadroom` (the
 * frozen budget wire shape) carries only a machine `resetAt`, which is
 * structurally null for Claude — the provider's sentence lives on the seat's
 * capacity windows. The window is picked with the SAME classifier the server
 * used to choose the binding window (core/routing/headroom.ts), so the words
 * belong to the window the chart draws, not to a per-model window beside it.
 */
export function bindingResetText(
  seat: Pick<VerseSeat, 'capacity'> | undefined,
  engine: SeatBurn['engine'],
  binding: 'session' | 'weekly' | null,
  nowMs: number,
): string | null {
  if (!seat?.capacity || binding === null || engine === 'local') return null;
  for (const w of seat.capacity.windows) {
    const text = typeof w.resetDescription === 'string' ? w.resetDescription.trim() : '';
    if (text.length === 0) continue;
    if (classifyWindow(engine, { id: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt, resetDescription: w.resetDescription, limitReached: w.limitReached }, nowMs) === binding) return text;
  }
  return null;
}

/**
 * "resets Sep 25 at 7pm (America/New_York)" from the provider's words. The
 * collector strips the leading "resets" (claude-account-usage.ts) but other
 * paths keep it; either way the sentence itself is shown verbatim.
 */
export function resetWords(text: string): string {
  return `resets ${text.replace(/^resets\s+/i, '')}`;
}

const MONTHS: readonly string[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The collector's own reset grammar (core/resources/claude-account-usage.ts
 * `RESET`), with the leading "resets" optional because other paths keep it.
 * Anything outside it — a changed native format, free prose — stays words.
 */
const RESET_WORDS_RE = /^(?:resets\s+)?(?:([A-Za-z]{3}) ([1-9]|[12]\d|3[01]) at )?([1-9]|1[0-2])(?::([0-5]\d))?(am|pm) \(([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2})\)$/i;

interface WallClock { y: number; mo: number; d: number; h: number; mi: number }

function wallClock(ms: number, fmt: Intl.DateTimeFormat): WallClock | null {
  const parts = fmt.formatToParts(new Date(ms));
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const c = { y: n('year'), mo: n('month') - 1, d: n('day'), h: n('hour') % 24, mi: n('minute') };
  return Object.values(c).every(Number.isFinite) ? c : null;
}

const wallAsUtc = (c: WallClock) => Date.UTC(c.y, c.mo, c.d, c.h, c.mi);

/**
 * The instant whose wall clock in `fmt`'s zone reads `want`: start from the
 * wall time as if it were UTC and correct by the zone's offset until the
 * clock agrees. Null when it never does — a time skipped by a DST jump.
 */
function instantAt(want: WallClock, fmt: Intl.DateTimeFormat): number | null {
  const target = wallAsUtc(want);
  let at = target;
  for (let i = 0; i < 3; i++) {
    const seen = wallClock(at, fmt);
    if (!seen) return null;
    const drift = target - wallAsUtc(seen);
    if (drift === 0) return at;
    at += drift;
  }
  return null;
}

/**
 * The instant named by the provider's reset words — "Sep 25 at 6:59pm
 * (America/New_York)" or "1:40am (America/New_York)" — or null when the words
 * are not in the collector's grammar or name an unknown zone.
 *
 * WHY this is not "synthesizing a countdown from a description"
 * (core/verse/types.ts): the words ARE an instant — a wall-clock minute in a
 * named IANA zone — so reading them on that zone's clock adds nothing the
 * provider did not say. The only thing the words leave out is the year (or,
 * for "1:40am", the day), and the candidate nearest `nowMs` is taken; the
 * caller still refuses an instant outside the window's own span
 * (`seatBurns`), so a misread can never stretch or shift the chart by more
 * than the window it draws. Without this, Claude — the seat that matters
 * most — was the one card with no window, no pace line and no projection.
 */
export function resetInstantFromWords(text: string, nowMs: number): number | null {
  const m = RESET_WORDS_RE.exec(text.trim());
  if (!m || !Number.isFinite(nowMs)) return null;
  const [, month, day, hour, minute, meridiem, zone] = m;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  } catch {
    return null; // RangeError: not a zone this runtime knows.
  }
  const today = wallClock(nowMs, fmt);
  if (!today) return null;
  const h = (Number(hour) % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const mi = minute === undefined ? 0 : Number(minute);
  const candidates: WallClock[] = [];
  if (month !== undefined) {
    const mo = MONTHS.indexOf(month.toLowerCase());
    const d = Number(day);
    if (mo < 0) return null;
    for (const y of [today.y - 1, today.y, today.y + 1]) {
      // Feb 30 would roll into March — refuse it rather than move the reset.
      if (new Date(Date.UTC(y, mo, d)).getUTCDate() === d) candidates.push({ y, mo, d, h, mi });
    }
  } else {
    for (const k of [-1, 0, 1]) {
      const date = new Date(Date.UTC(today.y, today.mo, today.d + k));
      candidates.push({ y: date.getUTCFullYear(), mo: date.getUTCMonth(), d: date.getUTCDate(), h, mi });
    }
  }
  let best: number | null = null;
  for (const c of candidates) {
    const at = instantAt(c, fmt);
    if (at !== null && (best === null || Math.abs(at - nowMs) < Math.abs(best - nowMs))) best = at;
  }
  return best;
}

/**
 * How far a words-derived reset may sit in the past (a reading taken just
 * before the rollover) or beyond one window ahead (the provider rounds its
 * words to the minute or the hour).
 */
const WORDS_RESET_SLACK_MS = 15 * 60_000;

/**
 * The binding window's reset instant: the budget route's machine instant when
 * there is one, else the provider's words read on their own clock — but only
 * when that instant can close the window the current reading sits in (no
 * more than one window ahead, no more than a few minutes past). Words that
 * fail either test stay words, and the card says the reset is not placed.
 */
/** Earliest instant accepted as a real reset (2000-01-01T00:00:00Z). */
const PLAUSIBLE_RESET_FLOOR_MS = Date.UTC(2000, 0, 1);

export function bindingReset(
  machine: string | null,
  resetText: string | null,
  windowMs: number | null,
  nowMs: number,
): { at: number; from: 'provider' | 'words' } | null {
  const at = machine ? Date.parse(machine) : NaN;
  // A placeholder instant (epoch 0 or anything before 2000) is not a reset —
  // fall through to the provider's words, as if no instant were sent.
  if (Number.isFinite(at) && at >= PLAUSIBLE_RESET_FLOOR_MS) return { at, from: 'provider' };
  if (resetText === null || windowMs === null) return null;
  const words = resetInstantFromWords(resetText, nowMs);
  if (words === null || words < nowMs - WORDS_RESET_SLACK_MS || words > nowMs + windowMs + WORDS_RESET_SLACK_MS) return null;
  return { at: words, from: 'words' };
}

// ---------------------------------------------------------------------------
// Seat reasons, in words (3.10.1)
// ---------------------------------------------------------------------------

/**
 * The budget route's reasons as data. `SeatHeadroom.reasons` carries each
 * one in the router's LOG form — "… so autonomy stops at 92% (resets
 * 2026-09-26T03:46:56.000Z)." (core/routing/seat-reasons.ts
 * `reasonSentence`) — so the reset clause is split back off with the Fleet
 * surface's own parser: an instant → `resetsAt`, Claude's words →
 * `resetDescription`. Non-strings and blanks are skipped (wire data).
 */
export function seatReasons(reasons: readonly unknown[] | null | undefined): SeatReason[] {
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map(parseLegacyReason);
}

/** Two resets this close are the same one (the router and the chart read the same window). */
const SAME_RESET_MS = 60_000;

/**
 * Reasons whose reset is, by construction, the BINDING window's: headroom.ts
 * attaches `resetOf(bindingRow.window)` to exactly these. A `spent` reason
 * can name the other window (a spent 5-hour window beside a weekly one that
 * is even further past its reserve), so it is never taken for the chart's.
 */
const BINDING_RESET_KINDS: ReadonlySet<SeatReasonKind> = new Set<SeatReasonKind>(['reserve', 'session-ceiling']);

/** Claude's words without the "resets" some paths lead with. */
function bareResetWords(text: string | null | undefined): string {
  return typeof text === 'string' ? text.trim().replace(/^resets\s+/i, '') : '';
}

/**
 * The binding window's reset words from the router's own reasons — the
 * fallback when the roster (read from cache, never fetched here) has none,
 * so a card never says "reset time not reported" beside a reason that names
 * the reset.
 */
export function reasonResetText(reasons: readonly SeatReason[]): string | null {
  for (const r of reasons) {
    if (!BINDING_RESET_KINDS.has(r.kind)) continue;
    const words = bareResetWords(r.resetDescription);
    if (words) return words;
  }
  return null;
}

/**
 * When `reason` lifts, in the viewer's words — or null when the card already
 * says it: the chart's reset marker ("Resets Sep 26, 11:46 PM", a machine
 * instant or Claude's words placed on their clock) or the header's verbatim
 * words. A reset the card does NOT show (another window's) is kept: a machine
 * instant in the viewer's zone (`describeResetAt`, as Fleet and Accounts
 * word it), Claude's words verbatim.
 */
function unshownReset(reason: SeatReason, card: { resetAt: number | null; resetText: string | null }, nowMs: number): string | null {
  const at = typeof reason.resetsAt === 'string' ? Date.parse(reason.resetsAt) : Number.NaN;
  if (Number.isFinite(at)) {
    if (card.resetAt !== null && Math.abs(at - card.resetAt) <= SAME_RESET_MS) return null;
    return describeResetAt(reason.resetsAt, nowMs);
  }
  const words = bareResetWords(reason.resetDescription);
  if (!words) return null;
  if (card.resetText !== null && bareResetWords(card.resetText).toLowerCase() === words.toLowerCase()) return null;
  return words;
}

/**
 * What a card says about why the router holds a seat back: the reason's own
 * sentence (any instant inside it in local time — Fleet's `localTimes`),
 * closed by exactly one full stop, then "Resets …." only when the card does
 * not already show that reset (`unshownReset`). Never the log form: held-back
 * cards printed "… stops at 92% (resets 2026-09-26T03:46:56.000Z)." and, for
 * Claude, "… (resets Sep 25 at 7pm (America/New_York))." verbatim.
 */
export function seatReasonText(reason: SeatReason | undefined, card: { resetAt: number | null; resetText: string | null }, nowMs: number): string | null {
  if (!reason) return null;
  const text = asSentence(localTimes(reason.text, nowMs));
  if (!text) return null;
  const when = unshownReset(reason, card, nowMs);
  return when ? `${text} Resets ${when}.` : text;
}

/**
 * One burn-down per seat, paid seats first (they are the ones that run out).
 * `history` is keyed by `seriesKey` (seat + window); each card draws its
 * BINDING window's line. `seats` (the live roster, optional) supplies the
 * provider's reset wording for seats that publish no machine reset time (see
 * `bindingResetText`), which also places their reset when it names a clock
 * time (`bindingReset`); without a roster, a reason held at the binding
 * window's reserve or ceiling supplies the same words (`reasonResetText`).
 * `recorded` (from `mergeSeatHistory`) names the lines the server's recorded
 * history contributed to. Each card's `reason` is the router's first reason
 * in words (`seatReasonText`).
 */
export function seatBurns(
  view: BudgetView | null,
  history: Readonly<Record<string, SeatReading[]>>,
  seats?: readonly VerseSeat[] | null,
  recorded?: ReadonlySet<string> | null,
): SeatBurn[] {
  if (!view) return [];
  const info = new Map(view.seatInfo.map((s) => [s.seatId, s]));
  const roster = new Map((seats ?? []).map((s) => [s.id, s]));
  const sampled = Date.parse(view.sampledAt);
  const nowMs = Number.isFinite(sampled) ? sampled : Date.now();
  return view.headroom
    .map((h): SeatBurn => {
      const i = info.get(h.seatId);
      const engine = i?.engine ?? 'local';
      const windowMs = h.bindingWindow ? WINDOW_MS[h.bindingWindow] : null;
      const reasons = seatReasons(h.reasons);
      const resetText =
        bindingResetText(roster.get(h.seatId), engine, h.bindingWindow, nowMs) ??
        (h.bindingWindow === null || engine === 'local' ? null : reasonResetText(reasons));
      // A reset is only placed on a chart that has a window to put before it.
      const reset = windowMs === null ? null : bindingReset(h.resetAt, resetText, windowMs, nowMs);
      const start = reset && windowMs !== null ? reset.at - windowMs : null;
      const key = h.bindingWindow ? seriesKey(h.seatId, h.bindingWindow) : null;
      const readings = key ? history[key] ?? [] : [];
      return {
        seatId: h.seatId,
        label: i?.label ?? h.seatId,
        engine,
        window: h.bindingWindow,
        points: readings.filter((r) => start === null || r.t >= start).map((r) => ({ t: r.t, remaining: Math.max(0, 100 - r.used) })),
        start,
        resetAt: reset?.at ?? null,
        resetFrom: reset?.from ?? null,
        resetText,
        reservePercent: view.effective[h.seatId]?.reservePercent ?? 0,
        line: bindingLine(h, view.effective[h.seatId]),
        enabled: view.effective[h.seatId]?.enabled ?? false,
        free: i?.free ?? false,
        eligible: h.eligibleForAutonomy,
        reason: seatReasonText(reasons[0], { resetAt: reset?.at ?? null, resetText }, nowMs),
        recorded: key !== null && (recorded?.has(key) ?? false),
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
