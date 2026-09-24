/**
 * routes/verse/usage/usage-model.ts — the honesty layer of the Usage section.
 *
 * Every number this section renders passes through here first, because the
 * hard problem of this surface is NOT drawing meters: it is knowing which
 * numbers are real. `GET /api/usage` collapses three different provenances
 * into one identical-looking `subscriptionWindow` shape (see
 * src/core/usage/frontier-usage.ts `buildEngineUsage`):
 *
 *   1. a REAL subscription-tracker reading (codex, parsed from its session
 *      files) — `subWindow !== null`;
 *   2. a figure DERIVED from the dispatch ledger vs. a configured foundry
 *      cap — taken only when `limitMax !== undefined && limitMax > 0`;
 *   3. genuinely nothing — `state: 'unknown', usedPct: 0`.
 *
 * (2) is the trap. For Claude — which has no local utilization signal at all
 * (`subscriptionUsage('claude')` returns null by design, and Ashlr never
 * proactively throttles it) — a configured cap makes `/api/usage` hand back
 * something like `{state:'active', usedPct: 35, windowLabel:'1d'}`. Rendered
 * as a window meter that reads "Claude 35% of window used", which is false.
 * And (3)'s `usedPct: 0` rendered as a bar reads "0% used — plenty left",
 * which is equally false.
 *
 * So this module establishes provenance before anything is called measured:
 *
 *   - `ControlSnapshot.subscriptionUsage` is provenance-bearing: an entry
 *     exists for codex only when `readCodexRateLimits()` actually succeeded,
 *     and `hasData` is literally `windows.length > 0`. Claude's entry is
 *     hard-coded `{windows: [], hasData: false}`. Grok has no entry at all.
 *     A `hasData` entry is therefore proof of a real reading.
 *   - `VerseSeat.health.windows` come from observations.json and are
 *     PER-ACCOUNT, which is finer-grained than anything else available; a
 *     non-null `usedPercent` there is a real observation.
 *   - Failing both, a `/api/usage` entry can still be proven real by
 *     elimination: branch (2) is unreachable without a configured limit, so
 *     `state !== 'unknown' && limit === undefined` can ONLY have come from
 *     the subscription tracker.
 *   - Everything else is unknown, and says why in one line.
 *
 * Nothing here ever converts an unknown into 0, and nothing derived from the
 * dispatch ledger is ever presented as subscription utilization — that data
 * is real, but it belongs under "Dispatch limits", where it is labeled as
 * calls against a configured cap.
 *
 * Scope note: this module owns PROVENANCE (what may be called measured) and
 * the accounting projections (local/cloud split, dispatch limits, the daemon
 * tick spend series, the configured-caps narrowing). The account CARD model —
 * binding constraint, verdict, credits — lives in `accounts-model.ts`, which
 * calls `resolveWindowSignal` here for the fallback path rather than
 * re-deriving provenance a second time.
 *
 * Pure: no React, no I/O, no formatting of currency/percent (the chart
 * layer's `chartFormat` owns that).
 */
import type { ControlSnapshot, SourceQuality, VerseEngine, VerseSeat } from '../../../data/api-types.js';
import type { FrontierEngineUsage } from '../../../../core/usage/frontier-usage.js';
import { localDateKey } from '../autonomy/format.js';
import { calendarDayStart } from '../growth/calendar-day.js';

type SubscriptionEngineUsage = ControlSnapshot['subscriptionUsage'][number];
type ControlLimit = ControlSnapshot['limits'][number];
type ControlUsage = ControlSnapshot['usage'];
type DaemonObservation = ControlSnapshot['daemonObservation'];

// ---------------------------------------------------------------------------
// Engine identity
// ---------------------------------------------------------------------------

/**
 * One hue per provider (docs/VERSE-DESIGN-V2.md §2 "Engine identity"). Used
 * ONLY for the 2px seat marker and the window bar, never for text. Written
 * with a literal fallback so the section is correct before owner A lands the
 * tokens in design/tokens.css.
 */
export const ENGINE_COLOR: Record<VerseEngine, string> = {
  claude: 'var(--engine-claude, #c96442)',
  codex: 'var(--engine-codex, #10a37f)',
  grok: 'var(--engine-grok, #6b7280)',
  local: 'var(--engine-local, #7c5cff)',
};

// ---------------------------------------------------------------------------
// Window signals
// ---------------------------------------------------------------------------

/** Exact copy for every "we do not know" case, exported so tests pin it. */
export const NO_SIGNAL_REASON: Partial<Record<VerseEngine, string>> = {
  claude:
    'Claude publishes no local utilization signal, so there is no window percentage to read. Ashlr deliberately never throttles this seat on a guess.',
  // Grok is absent from frontier-usage.ts entirely, so /api/usage can never
  // carry it. Its real state comes from the per-account probe behind
  // /api/verse/accounts; this copy is only ever seen on the fallback roster.
  grok: 'Grok is absent from the per-engine usage snapshot, so this fallback roster has no window data for it. Its real state comes from the per-account probe.',
};

export const AMBIGUOUS_REASON =
  'The only figure available is derived from the dispatch ledger against a configured cap, not from the subscription itself. It is shown under Dispatch limits.';

export const GENERIC_NO_SIGNAL = 'No subscription window reading is reported for this engine.';

export const LOCAL_NOT_APPLICABLE =
  'Local models have no subscription and no quota window — only whether the runtime is up.';

export type WindowTone = 'ok' | 'warn' | 'danger';

/** Provenance of a measured window, shown to the operator as a source line. */
export type WindowSource = 'account-observation' | 'subscription-tracker';

export const WINDOW_SOURCE_LABEL: Record<WindowSource, string> = {
  'account-observation': 'from this account’s observed windows',
  'subscription-tracker': 'from the subscription tracker',
};

export interface MeasuredWindow {
  id: string;
  label: string;
  /** 0–100, clamped. Never synthesized — only ever a real reading. */
  usedPct: number;
  /** Unix epoch SECONDS, matching SubscriptionUsageWindow.resetsAt. */
  resetsAt: number | null;
  tone: WindowTone;
}

export type WindowSignal =
  | {
      kind: 'measured';
      source: WindowSource;
      /** 'engine' when the reading covers every account on this engine. */
      scope: 'account' | 'engine';
      windows: MeasuredWindow[];
    }
  | { kind: 'unknown'; reason: string }
  | { kind: 'not-applicable'; reason: string };

/** `SourceQuality` shaped for <Epistemic/> so unknowns use the shared treatment. */
export function unknownQuality(reason: string): SourceQuality {
  return { sourceState: 'unknown', complete: false, reason };
}

export function windowTone(usedPct: number): WindowTone {
  // Mirrors frontier-usage.ts: >= DEFAULT_MAX_PERCENT (90) exhausted, >= 80 near.
  if (usedPct >= 90) return 'danger';
  if (usedPct >= 80) return 'warn';
  return 'ok';
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function toEpochSeconds(value: number | undefined | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function measured(
  source: WindowSource,
  scope: 'account' | 'engine',
  windows: MeasuredWindow[],
): WindowSignal {
  return { kind: 'measured', source, scope, windows };
}

function noSignal(engine: VerseEngine): WindowSignal {
  return { kind: 'unknown', reason: NO_SIGNAL_REASON[engine] ?? GENERIC_NO_SIGNAL };
}

/**
 * The one decision that keeps this surface honest. See the module header for
 * why each branch is ordered the way it is.
 */
export function resolveWindowSignal(input: {
  engine: VerseEngine;
  seat?: VerseSeat | undefined;
  subscription?: SubscriptionEngineUsage | undefined;
  frontier?: FrontierEngineUsage | undefined;
  /** >1 means a tracker reading covers several accounts, so scope is 'engine'. */
  engineSeatCount?: number;
}): WindowSignal {
  const { engine, seat, subscription, frontier, engineSeatCount = 1 } = input;

  if (engine === 'local') return { kind: 'not-applicable', reason: LOCAL_NOT_APPLICABLE };

  // 1. Per-account observations are the finest-grained real reading we have.
  const observed = (seat?.health.windows ?? []).filter(
    (w): w is { id: string; usedPercent: number; resetsAt: string | null } =>
      typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent),
  );
  if (observed.length > 0) {
    return measured(
      'account-observation',
      'account',
      observed.map((w) => {
        const pct = clampPct(w.usedPercent);
        const parsed = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
        return {
          id: w.id,
          label: w.id,
          usedPct: pct,
          resetsAt: Number.isNaN(parsed) ? null : Math.round(parsed / 1000),
          tone: windowTone(pct),
        };
      }),
    );
  }

  // 2. A `hasData` subscription entry is proof the tracker actually read something.
  if (subscription && subscription.hasData && subscription.windows.length > 0) {
    return measured(
      'subscription-tracker',
      engineSeatCount > 1 ? 'engine' : 'account',
      subscription.windows.map((w, i) => {
        const pct = clampPct(w.usedPercent);
        return {
          id: `${w.label}-${i}`,
          label: w.label,
          usedPct: pct,
          resetsAt: toEpochSeconds(w.resetsAt),
          tone: windowTone(pct),
        };
      }),
    );
  }

  // 3. An explicit `hasData: false` entry is an explicit "no signal" (claude).
  if (subscription && !subscription.hasData) return noSignal(engine);

  if (frontier && frontier.subscriptionWindow.state !== 'unknown') {
    // 4. Proof by elimination: frontier-usage's derived branch is unreachable
    //    without a configured limit, so a stated window with no limit can only
    //    have come from the subscription tracker.
    if (frontier.limit === undefined) {
      const pct = clampPct(frontier.subscriptionWindow.usedPct);
      return measured('subscription-tracker', engineSeatCount > 1 ? 'engine' : 'account', [
        {
          id: frontier.subscriptionWindow.windowLabel ?? 'window',
          label: frontier.subscriptionWindow.windowLabel ?? 'window',
          usedPct: pct,
          resetsAt: toEpochSeconds(frontier.subscriptionWindow.resetsAt),
          tone: windowTone(pct),
        },
      ]);
    }
    // 5. A limit is configured, so the figure may be ledger-derived. Ambiguous
    //    is not good enough for a meter.
    return { kind: 'unknown', reason: AMBIGUOUS_REASON };
  }

  // 6. state === 'unknown' (usedPct is a placeholder 0) or no entry at all.
  return noSignal(engine);
}

// ---------------------------------------------------------------------------
// Local vs cloud split
// ---------------------------------------------------------------------------

export interface ProviderSlice {
  provider: string;
  tier: 'local' | 'cloud';
  tokens: number;
  costUsd: number;
  sharePct: number;
}

export interface LocalCloudSplit {
  window: string;
  totalTokens: number;
  totalCostUsd: number;
  /** Money NOT spent because the work ran locally. */
  localSavingsUsd: number;
  localTokens: number;
  cloudTokens: number;
  localCostUsd: number;
  cloudCostUsd: number;
  byProvider: ProviderSlice[];
  /** True when the window carries no activity at all — an empty state, not a zero. */
  empty: boolean;
}

export function buildLocalCloudSplit(usage: ControlUsage | undefined): LocalCloudSplit | null {
  if (!usage) return null;
  const byProvider: ProviderSlice[] = (usage.byProvider ?? []).map((p) => ({
    provider: p.provider,
    tier: p.tier,
    tokens: p.tokens,
    costUsd: p.costUsd,
    sharePct: p.sharePct,
  }));
  const sum = (tier: 'local' | 'cloud', field: 'tokens' | 'costUsd'): number =>
    byProvider.filter((p) => p.tier === tier).reduce((acc, p) => acc + (p[field] || 0), 0);

  return {
    window: usage.window,
    totalTokens: usage.totalTokens,
    totalCostUsd: usage.totalCostUsd,
    localSavingsUsd: usage.localSavingsUsd,
    localTokens: sum('local', 'tokens'),
    cloudTokens: sum('cloud', 'tokens'),
    localCostUsd: sum('local', 'costUsd'),
    cloudCostUsd: sum('cloud', 'costUsd'),
    byProvider: [...byProvider].sort((a, b) => b.tokens - a.tokens),
    empty: byProvider.length === 0 && usage.totalTokens === 0,
  };
}

// ---------------------------------------------------------------------------
// Dispatch-ledger usage against configured foundry limits
// ---------------------------------------------------------------------------

export interface UsageLimitRow {
  id: string;
  backend: string;
  window: string;
  max: number;
  /** null when the limit is configured but no ledger reading is available. */
  used: number | null;
  standing: ControlLimit['standing'] | 'unknown';
  usedPct: number | null;
  /** True when only the configured cap is known, with no usage behind it. */
  configuredOnly: boolean;
}

/**
 * `/api/control`'s `limits` already pairs each configured foundry limit with
 * its ledger reading. Owner B's `/api/verse/control` adds the CONFIGURED caps,
 * which may include an engine the control snapshot has not reported on — those
 * are surfaced as configured-with-no-reading rather than dropped or zeroed.
 */
export function buildLimitRows(
  limits: readonly ControlLimit[] | undefined,
  configured: readonly ConfiguredFoundryLimit[] | undefined,
): UsageLimitRow[] {
  const rows: UsageLimitRow[] = [];
  const seen = new Set<string>();
  for (const l of limits ?? []) {
    const key = `${l.backend}:${l.window}`;
    seen.add(key);
    const usedPct = l.max > 0 ? clampPct((l.used / l.max) * 100) : null;
    rows.push({
      id: key,
      backend: l.backend,
      window: l.window,
      max: l.max,
      used: l.used,
      standing: l.standing,
      usedPct,
      configuredOnly: false,
    });
  }
  for (const c of configured ?? []) {
    const key = `${c.engine}:${c.window}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id: key,
      backend: c.engine,
      window: c.window,
      max: c.max,
      used: null,
      standing: 'unknown',
      usedPct: null,
      configuredOnly: true,
    });
  }
  return rows.sort((a, b) => a.backend.localeCompare(b.backend) || a.window.localeCompare(b.window));
}

// ---------------------------------------------------------------------------
// Per-day spend series
// ---------------------------------------------------------------------------

export interface SpendDay {
  /** YYYY-MM-DD — the viewer's LOCAL calendar day, the calendar the chart and table label in. */
  day: string;
  /** null = no tick retained for this day, NOT a measured zero. */
  usd: number | null;
}

export type SpendSeries =
  | { available: true; days: SpendDay[]; tickCount: number; caveat: string }
  | { available: false; reason: string };

export const SERIES_UNAVAILABLE_NO_LEDGER =
  'No per-day series is available: the sources this view reads carry aggregate spend only, not a dated history.';

/**
 * The only dated spend history reachable from the three endpoints this section
 * reads is `ControlSnapshot.daemonObservation.ticks`, where each tick carries
 * `ts` and `spentUsd`. It is real, but partial — the ledger is capped and it
 * records the autonomous loop only — so the caveat says so, days inside the
 * covered span with no retained tick stay `null` (a visible break, never a
 * fabricated zero), and anything under two days is refused as "not a series".
 */
export function buildDailySpendSeries(observation: DaemonObservation | undefined): SpendSeries {
  if (!observation) return { available: false, reason: SERIES_UNAVAILABLE_NO_LEDGER };
  if (observation.sourceQuality?.sourceState !== 'healthy') {
    return {
      available: false,
      reason: `No per-day series: the daemon ledger is ${observation.sourceQuality?.sourceState ?? 'unavailable'}${
        observation.sourceQuality?.reason ? ` (${observation.sourceQuality.reason})` : ''
      }.`,
    };
  }
  const ticks = observation.ticks;
  if (!ticks || ticks.length === 0) return { available: false, reason: SERIES_UNAVAILABLE_NO_LEDGER };

  const byDay = new Map<string, number>();
  for (const t of ticks) {
    const ms = Date.parse(t.ts);
    if (Number.isNaN(ms)) continue;
    // Bucketed by the viewer's LOCAL day — the same calendar every day axis
    // uses (growth/calendar-day) — so a tick at 8 PM on the 23rd in Denver
    // counts toward the 23rd, not the UTC 24th.
    const day = localDateKey(new Date(ms));
    byDay.set(day, (byDay.get(day) ?? 0) + (Number.isFinite(t.spentUsd) ? t.spentUsd : 0));
  }
  if (byDay.size < 2) {
    return {
      available: false,
      reason: `No per-day series: only ${byDay.size} day${byDay.size === 1 ? '' : 's'} of daemon ticks is retained, which is not a trend.`,
    };
  }

  const sorted = [...byDay.keys()].sort();
  const first = sorted[0] as string;
  const last = sorted[sorted.length - 1] as string;
  const days: SpendDay[] = [];
  // Walk LOCAL calendar days (a DST day is 23 or 25 hours, never a skipped or doubled day).
  const end = calendarDayStart(last);
  for (let at = new Date(calendarDayStart(first)); at.getTime() <= end; at = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1)) {
    const day = localDateKey(at);
    days.push({ day, usd: byDay.has(day) ? (byDay.get(day) as number) : null });
  }
  return {
    available: true,
    days,
    tickCount: ticks.length,
    caveat: `From the last ${ticks.length} recorded daemon ticks. The tick ledger is capped and records the autonomous loop only — interactive chat turns are not in it, and a gap is a day with no retained tick, not a measured zero.`,
  };
}

// ---------------------------------------------------------------------------
// GET /api/verse/control — defensive projection
// ---------------------------------------------------------------------------

export interface ConfiguredFoundryLimit {
  engine: string;
  window: string;
  max: number;
}

export interface VerseControlProjection {
  available: boolean;
  reason: string | null;
  dailyBudgetUsd: number | null;
  subscriptionMaxPercent: number | null;
  todaySpentUsd: number | null;
  /**
   * The ledger day `todaySpentUsd` was counted for (`YYYY-MM-DD`), or null
   * when the source carries no date. The daemon writes the figure once a day
   * and leaves it there, so without this a stale day renders as today's spend.
   */
  todaySpentDate: string | null;
  foundryLimits: ConfiguredFoundryLimit[];
}

const UNAVAILABLE_PROJECTION: VerseControlProjection = {
  available: false,
  reason: null,
  dailyBudgetUsd: null,
  subscriptionMaxPercent: null,
  todaySpentUsd: null,
  todaySpentDate: null,
  foundryLimits: [],
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(source: Record<string, unknown> | null, keys: readonly string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const v = source[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Narrow `GET /api/verse/control` down to the four figures this section needs.
 *
 * The authoritative shape is `VerseControlSnapshot` in
 * `src/core/verse/control-types.ts`, and the field paths below now match it
 * exactly (`caps.*`, `spend.todayUsd`). It still narrows STRUCTURALLY rather
 * than casting to that type, because `usage-queries.ts` deliberately hands
 * this function a non-throwing wrapper's `raw` body: the route can be absent
 * (no --allow-dispatch) or degraded, and a degraded panel is the designed
 * state here, not an exception. The legacy root-level spend spellings are
 * kept as a fallback ONLY behind the contract path, so a server that predates
 * the `spend` block still renders a figure instead of "unknown".
 */
export function projectVerseControl(raw: unknown, reason: string | null = null): VerseControlProjection {
  const root = record(raw);
  if (!root) return { ...UNAVAILABLE_PROJECTION, reason };

  const caps = record(root['caps']) ?? root;
  const daemon = record(root['daemon']);
  const spend = record(root['spend']);

  const foundryLimits: ConfiguredFoundryLimit[] = [];
  const rawLimits = caps['foundryLimits'];
  if (Array.isArray(rawLimits)) {
    for (const entry of rawLimits) {
      const e = record(entry);
      if (!e) continue;
      const engine = typeof e['engine'] === 'string' ? e['engine'] : null;
      const max = readNumber(e, ['max']);
      if (engine === null || max === null) continue;
      foundryLimits.push({
        engine,
        window: typeof e['window'] === 'string' ? e['window'] : '1d',
        max,
      });
    }
  }

  return {
    available: true,
    reason,
    dailyBudgetUsd: readNumber(caps, ['dailyBudgetUsd']),
    subscriptionMaxPercent: readNumber(caps, ['subscriptionMaxPercent']),
    // Contract path first: VerseControlSnapshot.spend.todayUsd is the one the
    // server actually sends, and it is null (not 0) when the ledger is
    // unreadable — so a present-but-null `spend` block must NOT fall through
    // to the daemon observation and report a stale number as today's spend.
    todaySpentUsd: spend
      ? readNumber(spend, ['todayUsd'])
      : readNumber(root, ['todaySpentUsd', 'todaySpendUsd', 'spendTodayUsd']) ??
        readNumber(daemon, ['todaySpentUsd']),
    // Only the contract path carries a date. A legacy server's root-level
    // spelling has none, and null means "cannot be checked", not "today".
    todaySpentDate: spend && typeof spend['todayDate'] === 'string' ? spend['todayDate'] : null,
    foundryLimits,
  };
}

export function unavailableVerseControl(reason: string): VerseControlProjection {
  return { ...UNAVAILABLE_PROJECTION, reason };
}
