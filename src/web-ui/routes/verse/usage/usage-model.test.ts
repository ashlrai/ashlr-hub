/**
 * usage-model.test.ts — these tests exist to keep the Usage section honest.
 *
 * The important cases are the ones that pin what we REFUSE to draw: a Claude
 * percentage derived from the dispatch ledger, an `unknown` window whose
 * placeholder usedPct is 0, and a single day of tick history dressed up as a
 * trend. If one of these ever starts returning `kind: 'measured'`, the UI has
 * begun fabricating numbers, which is the one failure mode this section is
 * not allowed to have.
 */
import { describe, expect, it } from 'vitest';
import type { ControlSnapshot, VerseSeat } from '../../../data/api-types.js';
import type { FrontierEngineUsage, FrontierUsage } from '../../../../core/usage/frontier-usage.js';
import {
  AMBIGUOUS_REASON,
  GENERIC_NO_SIGNAL,
  LOCAL_NOT_APPLICABLE,
  NO_SIGNAL_REASON,
  SERIES_UNAVAILABLE_NO_LEDGER,
  buildDailySpendSeries,
  buildLimitRows,
  buildLocalCloudSplit,
  projectVerseControl,
  resolveWindowSignal,
  windowTone,
} from './usage-model.js';
import { buildFallbackAccountCards } from './accounts-model.js';
import { inTimeZone, TEST_ZONES } from '../growth/time-zone.test-support.js';

type SubscriptionEngineUsage = ControlSnapshot['subscriptionUsage'][number];
type DaemonObservation = ControlSnapshot['daemonObservation'];

function seat(over: Partial<VerseSeat> & Pick<VerseSeat, 'id' | 'engine' | 'label'>): VerseSeat {
  return {
    accountId: over.id,
    models: [{ id: 'm1', label: 'M1', contextWindow: 200_000 }],
    contextWindow: 200_000,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
    ...over,
  } as VerseSeat;
}

function engineUsage(over: Partial<FrontierEngineUsage> & Pick<FrontierEngineUsage, 'engine'>): FrontierEngineUsage {
  return {
    callsToday: 0,
    subscriptionWindow: { state: 'unknown', usedPct: 0, windowLabel: '1d' },
    ...over,
  };
}

function frontier(engines: FrontierEngineUsage[]): FrontierUsage {
  return { generatedAt: '2026-09-19T10:00:00.000Z', engines };
}

const CLAUDE_NO_DATA: SubscriptionEngineUsage = { engine: 'claude', windows: [], hasData: false };
const CODEX_REAL: SubscriptionEngineUsage = {
  engine: 'codex',
  plan: 'pro',
  hasData: true,
  windows: [
    { label: '5h', usedPercent: 62, resetsAt: 1_760_000_000 },
    { label: '7d', usedPercent: 91 },
  ],
};

describe('resolveWindowSignal — what we refuse to draw', () => {
  it('never turns a ledger-derived Claude percentage into a subscription meter', () => {
    // /api/usage reports a plausible-looking window ONLY because a foundry cap
    // is configured (frontier-usage.ts derived branch). It is not utilization.
    const f = engineUsage({
      engine: 'claude',
      callsToday: 35,
      limit: 100,
      limitWindow: '1d',
      subscriptionWindow: { state: 'active', usedPct: 35, windowLabel: '1d' },
    });

    const withControl = resolveWindowSignal({ engine: 'claude', subscription: CLAUDE_NO_DATA, frontier: f });
    expect(withControl.kind).toBe('unknown');
    expect(withControl).toMatchObject({ reason: NO_SIGNAL_REASON.claude });

    // Even with /api/control unavailable, the ambiguity resolves to unknown.
    const withoutControl = resolveWindowSignal({ engine: 'claude', frontier: f });
    expect(withoutControl).toEqual({ kind: 'unknown', reason: AMBIGUOUS_REASON });
  });

  it('never renders an `unknown` window state as a measured 0%', () => {
    const f = engineUsage({ engine: 'claude', subscriptionWindow: { state: 'unknown', usedPct: 0, windowLabel: '1d' } });
    const signal = resolveWindowSignal({ engine: 'claude', subscription: CLAUDE_NO_DATA, frontier: f });
    expect(signal.kind).toBe('unknown');
    expect(JSON.stringify(signal)).not.toContain('usedPct');
  });

  it('reports Grok as unknown, naming the missing probe wiring', () => {
    const signal = resolveWindowSignal({ engine: 'grok' });
    expect(signal).toEqual({ kind: 'unknown', reason: NO_SIGNAL_REASON.grok });
  });

  it('falls back to the generic reason for an engine with no bespoke copy', () => {
    const signal = resolveWindowSignal({ engine: 'codex' });
    expect(signal).toEqual({ kind: 'unknown', reason: GENERIC_NO_SIGNAL });
  });

  it('treats local seats as having no quota concept at all', () => {
    expect(resolveWindowSignal({ engine: 'local' })).toEqual({
      kind: 'not-applicable',
      reason: LOCAL_NOT_APPLICABLE,
    });
  });
});

describe('resolveWindowSignal — what we do draw', () => {
  it('uses the subscription tracker reading for Codex, both windows, with resets', () => {
    const signal = resolveWindowSignal({ engine: 'codex', subscription: CODEX_REAL });
    expect(signal.kind).toBe('measured');
    if (signal.kind !== 'measured') return;
    expect(signal.source).toBe('subscription-tracker');
    expect(signal.scope).toBe('account');
    expect(signal.windows).toEqual([
      { id: '5h-0', label: '5h', usedPct: 62, resetsAt: 1_760_000_000, tone: 'ok' },
      { id: '7d-1', label: '7d', usedPct: 91, resetsAt: null, tone: 'danger' },
    ]);
  });

  it('marks a tracker reading engine-wide when several accounts share the engine', () => {
    const signal = resolveWindowSignal({ engine: 'codex', subscription: CODEX_REAL, engineSeatCount: 2 });
    expect(signal.kind === 'measured' && signal.scope).toBe('engine');
  });

  it('prefers the per-account observation over the engine-wide tracker', () => {
    const s = seat({
      id: 'codex-personal',
      engine: 'codex',
      label: 'Personal Codex',
      health: {
        state: 'ready',
        summary: null,
        observedAt: '2026-09-19T09:00:00.000Z',
        windows: [{ id: '5h', usedPercent: 12, resetsAt: '2026-09-19T14:00:00.000Z' }],
      },
    });
    const signal = resolveWindowSignal({ engine: 'codex', seat: s, subscription: CODEX_REAL });
    expect(signal.kind).toBe('measured');
    if (signal.kind !== 'measured') return;
    expect(signal.source).toBe('account-observation');
    expect(signal.windows[0]).toMatchObject({ label: '5h', usedPct: 12, tone: 'ok' });
    expect(signal.windows[0]?.resetsAt).toBe(Math.round(Date.parse('2026-09-19T14:00:00.000Z') / 1000));
  });

  it('accepts a frontier window with no configured limit, because the derived branch is unreachable', () => {
    const f = engineUsage({
      engine: 'codex',
      subscriptionWindow: { state: 'near', usedPct: 83, windowLabel: '5h', resetsAt: 1_760_000_000 },
    });
    const signal = resolveWindowSignal({ engine: 'codex', frontier: f });
    expect(signal.kind).toBe('measured');
    if (signal.kind !== 'measured') return;
    expect(signal.windows).toEqual([
      { id: '5h', label: '5h', usedPct: 83, resetsAt: 1_760_000_000, tone: 'warn' },
    ]);
  });

  it('clamps a nonsense percentage instead of overflowing the meter', () => {
    const signal = resolveWindowSignal({
      engine: 'codex',
      subscription: { engine: 'codex', hasData: true, windows: [{ label: '5h', usedPercent: 412 }] },
    });
    expect(signal.kind === 'measured' && signal.windows[0]?.usedPct).toBe(100);
  });

  it('tones match frontier-usage thresholds', () => {
    expect(windowTone(79)).toBe('ok');
    expect(windowTone(80)).toBe('warn');
    expect(windowTone(90)).toBe('danger');
  });
});

describe('buildFallbackAccountCards — the same card model from coarser sources', () => {
  const control = {
    subscriptionUsage: [CLAUDE_NO_DATA, CODEX_REAL],
    models: { activeProvider: 'ollama', providers: [{ id: 'ollama', kind: 'local', up: true, baseUrl: null, models: ['qwen3-coder'] }] },
  } as unknown as ControlSnapshot;

  const bootstrap = {
    seats: [
      seat({ id: 'claude', engine: 'claude', label: 'Claude Max' }),
      seat({ id: 'codex-personal', engine: 'codex', label: 'Personal Codex' }),
      seat({ id: 'codex-work', engine: 'codex', label: 'Work Codex' }),
      seat({ id: 'local:qwen3-coder', engine: 'local', label: 'Qwen3 Coder' }),
    ],
    projects: [],
    sessions: [],
    dispatchEnabled: true,
    localRuntime: { ollama: { reachable: true, baseUrl: 'http://127.0.0.1:11434', models: ['qwen3-coder'] } },
  } as unknown as Parameters<typeof buildFallbackAccountCards>[0]['bootstrap'];

  const usage = frontier([
    engineUsage({ engine: 'claude', callsToday: 35, tokensToday: 120_000, costToday: 2.5, limit: 100, limitWindow: '1d', subscriptionWindow: { state: 'active', usedPct: 35, windowLabel: '1d' } }),
    engineUsage({ engine: 'codex', callsToday: 9, tokensToday: 40_000, subscriptionWindow: { state: 'near', usedPct: 62, windowLabel: '5h' } }),
  ]);

  it('keeps the ledger-derived Claude percentage out of the card entirely', () => {
    const cards = buildFallbackAccountCards({ bootstrap, control, frontier: usage });
    const claude = cards.find((c) => c.label === 'Claude Max');
    expect(claude?.verdict.state).toBe('unknown');
    expect(claude?.binding).toBeNull();
    expect(claude?.others).toEqual([]);
  });

  it('labels an engine-wide tracker reading as shared, not as this account’s own', () => {
    const cards = buildFallbackAccountCards({ bootstrap, control, frontier: usage });
    const personal = cards.find((c) => c.label === 'Personal Codex');
    expect(personal?.plan).toBe('pro');
    // The tracker reports 5h at 62% and 7d at 91%; the binding one is 91%.
    expect(personal?.binding?.usedPct).toBe(91);
    expect(personal?.others.map((w) => w.usedPct)).toEqual([62]);
    expect(personal?.sourceNote).toMatch(/engine-wide, shared by every account on this engine/);
  });

  it('drops local seats, which have their own panel and their own physics', () => {
    const cards = buildFallbackAccountCards({ bootstrap, control, frontier: usage });
    expect(cards.map((c) => c.label)).not.toContain('Qwen3 Coder');
  });

  it('invents nothing when the seat roster is missing', () => {
    expect(buildFallbackAccountCards({ bootstrap: undefined, control, frontier: usage })).toEqual([]);
  });
});

describe('buildLimitRows', () => {
  it('pairs ledger readings with caps, and never zeroes a cap with no reading', () => {
    const rows = buildLimitRows(
      [{ backend: 'codex', window: '1d', max: 200, used: 50, standing: 'ok' }],
      [
        { engine: 'codex', window: '1d', max: 200 },
        { engine: 'grok', window: '1h', max: 10 },
      ],
    );
    expect(rows).toEqual([
      { id: 'codex:1d', backend: 'codex', window: '1d', max: 200, used: 50, standing: 'ok', usedPct: 25, configuredOnly: false },
      { id: 'grok:1h', backend: 'grok', window: '1h', max: 10, used: null, standing: 'unknown', usedPct: null, configuredOnly: true },
    ]);
  });

  it('returns nothing when nothing is configured', () => {
    expect(buildLimitRows(undefined, undefined)).toEqual([]);
  });
});

describe('buildLocalCloudSplit', () => {
  it('splits tokens and cost by tier and keeps the savings figure intact', () => {
    const split = buildLocalCloudSplit({
      window: '7d',
      totalTokens: 300,
      totalCostUsd: 4,
      localSavingsUsd: 12.5,
      byProvider: [
        { provider: 'ollama', tier: 'local', tokens: 200, costUsd: 0, sharePct: 66 },
        { provider: 'anthropic', tier: 'cloud', tokens: 100, costUsd: 4, sharePct: 34 },
      ],
    });
    expect(split).toMatchObject({
      localTokens: 200,
      cloudTokens: 100,
      cloudCostUsd: 4,
      localSavingsUsd: 12.5,
      empty: false,
    });
    expect(split?.byProvider[0]?.provider).toBe('ollama');
  });

  it('is null when /api/control did not answer', () => {
    expect(buildLocalCloudSplit(undefined)).toBeNull();
  });
});

describe('buildDailySpendSeries', () => {
  function observation(over: Partial<DaemonObservation>): DaemonObservation {
    return {
      observedAt: '2026-09-19T10:00:00.000Z',
      runtimeState: 'running',
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      running: true,
      pid: 1,
      startedAt: null,
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: null,
      itemsProcessed: null,
      ticks: null,
      ...over,
    } as DaemonObservation;
  }

  const tick = (ts: string, spentUsd: number) =>
    ({ ts, itemsConsidered: 1, proposalsCreated: 0, spentUsd, reason: 'ok' }) as unknown as NonNullable<DaemonObservation['ticks']>[number];

  // Tick instants are built in LOCAL time: the series buckets by the viewer's own calendar day.
  const local = (d: number, h: number) => new Date(2026, 8, d, h).toISOString();

  it('refuses to call a single day of ticks a trend', () => {
    const series = buildDailySpendSeries(
      observation({ ticks: [tick(local(19, 1), 1), tick(local(19, 5), 2)] }),
    );
    expect(series.available).toBe(false);
    expect(series.available === false && series.reason).toContain('only 1 day');
  });

  it('leaves a day with no retained tick as an explicit gap, not a zero', () => {
    const series = buildDailySpendSeries(
      observation({
        ticks: [
          tick(local(17, 1), 1.5),
          tick(local(17, 9), 0.5),
          tick(local(19, 2), 3),
        ],
      }),
    );
    expect(series.available).toBe(true);
    if (!series.available) return;
    expect(series.days).toEqual([
      { day: '2026-09-17', usd: 2 },
      { day: '2026-09-18', usd: null },
      { day: '2026-09-19', usd: 3 },
    ]);
    expect(series.caveat).toContain('autonomous work only, chats excluded');
  });

  it('buckets by the viewer\u2019s LOCAL day — the calendar the chart and table label in — in every zone', () => {
    for (const zone of [...TEST_ZONES, 'America/Los_Angeles']) {
      inTimeZone(zone, () => {
        // 8 PM and 11:30 PM on the 23rd are the 23rd where the viewer is, whatever UTC says.
        const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
        const series = buildDailySpendSeries(observation({ ticks: [tick(at(22, 12), 1), tick(at(23, 20), 2), tick(at(23, 23, 30), 0.5), tick(at(24, 0, 30), 4)] }));
        expect(series.available, zone).toBe(true);
        if (!series.available) return;
        expect(series.days, zone).toEqual([
          { day: '2026-09-22', usd: 1 },
          { day: '2026-09-23', usd: 2.5 },
          { day: '2026-09-24', usd: 4 },
        ]);
      });
    }
  });

  it('walks calendar days across a DST change without skipping or doubling one', () => {
    inTimeZone('America/Los_Angeles', () => {
      // 2026-11-01 is 25 hours long in Los Angeles.
      const series = buildDailySpendSeries(observation({ ticks: [tick(new Date(2026, 9, 31, 12).toISOString(), 1), tick(new Date(2026, 10, 2, 12).toISOString(), 2)] }));
      expect(series.available && series.days.map((d) => d.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    });
  });

  it('declines the series when the daemon ledger is degraded or absent', () => {
    expect(buildDailySpendSeries(undefined)).toEqual({ available: false, reason: SERIES_UNAVAILABLE_NO_LEDGER });
    const degraded = buildDailySpendSeries(
      observation({ sourceQuality: { sourceState: 'degraded', complete: false, reason: 'missing' }, ticks: [] }),
    );
    expect(degraded.available).toBe(false);
    expect(degraded.available === false && degraded.reason).toContain('degraded');
  });
});

describe('projectVerseControl', () => {
  it('reads the contract shape, nested under `caps`', () => {
    const projected = projectVerseControl({
      caps: {
        dailyBudgetUsd: 25,
        subscriptionMaxPercent: 90,
        foundryLimits: [{ engine: 'codex', window: '1d', max: 200 }],
      },
      todaySpentUsd: 4.25,
    });
    expect(projected).toEqual({
      available: true,
      reason: null,
      dailyBudgetUsd: 25,
      subscriptionMaxPercent: 90,
      todaySpentUsd: 4.25,
      // No `spend` block here, so there is no ledger day to carry — null
      // means "cannot be checked", which is not the same as "today".
      todaySpentDate: null,
      foundryLimits: [{ engine: 'codex', window: '1d', max: 200 }],
    });
  });

  it('accepts the caps inlined at the top level and a daemon-nested spend', () => {
    const projected = projectVerseControl({ dailyBudgetUsd: 10, daemon: { todaySpentUsd: 1 } });
    expect(projected.dailyBudgetUsd).toBe(10);
    expect(projected.todaySpentUsd).toBe(1);
  });

  it('reads spend from the real `spend.todayUsd` block the route actually sends', () => {
    // VerseControlSnapshot puts today's spend under `spend`, not at the root.
    // Before reconciliation this path was missed entirely and the figure fell
    // through to the daemon observation.
    const projected = projectVerseControl({
      caps: { dailyBudgetUsd: 25, subscriptionMaxPercent: 90, foundryLimits: [] },
      spend: { todayUsd: 6.5, todayDate: '2026-09-19', dailyBudgetUsd: 25 },
      daemon: { todaySpentUsd: 99 },
    });
    expect(projected.todaySpentUsd).toBe(6.5);
    // The day the figure belongs to travels with it, so the panels can tell
    // whether it is a statement about today at all.
    expect(projected.todaySpentDate).toBe('2026-09-19');
  });

  it('reports an unreadable ledger as unknown instead of a stale daemon number', () => {
    // `spend.todayUsd` is deliberately null (never 0) when the ledger cannot
    // be read. Falling back to the daemon observation there would print a
    // stale figure as if it were today's spend.
    const projected = projectVerseControl({
      caps: { dailyBudgetUsd: 25, foundryLimits: [] },
      spend: { todayUsd: null, todayDate: null, dailyBudgetUsd: 25 },
      daemon: { todaySpentUsd: 12 },
    });
    expect(projected.todaySpentUsd).toBeNull();
  });

  it('degrades rather than throwing on a body it does not recognise', () => {
    expect(projectVerseControl(null, 'route missing')).toMatchObject({ available: false, reason: 'route missing' });
    const junk = projectVerseControl({ caps: { foundryLimits: [{ engine: 42 }, 'nope', { engine: 'codex' }] } });
    expect(junk.foundryLimits).toEqual([]);
    expect(junk.dailyBudgetUsd).toBeNull();
  });
});
