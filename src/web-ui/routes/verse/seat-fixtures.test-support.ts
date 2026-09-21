/**
 * seat-fixtures.test-support.ts — seats carrying owner S's V2.1
 * `VerseSeat.capacity` record, shaped like Mason's REAL roster as measured on
 * 2026-09-19 (docs/VERSE-TELEMETRY-V2.md):
 *
 *   claude          max        five_hour 15%  ·  seven_day 85%  ·  seven_day_fable 100% (flagged)
 *   codex-personal  pro        codex_codex_primary 100% (flagged) + 2048.42 credits
 *   grok            SuperGrok  grok_unified_weekly 1%
 *
 * Built through the real types, so a change to the contract breaks these
 * fixtures at compile time rather than leaving the UI tests passing against a
 * shape the server no longer sends.
 */
import type { VerseSeat } from '../../data/api-types.js';

type Capacity = NonNullable<VerseSeat['capacity']>;
type CapacityWindow = Capacity['windows'][number];

/** A window with the honest defaults: measured, no prose, no instant. */
export function seatWindow(over: Partial<CapacityWindow> & Pick<CapacityWindow, 'id'>): CapacityWindow {
  return {
    usedPercent: null,
    resetsAt: null,
    resetDescription: null,
    limitReached: false,
    measured: true,
    ...over,
  };
}

export function capacity(over: Partial<Capacity> = {}): Capacity {
  return {
    planType: null,
    binding: null,
    windows: [],
    credits: null,
    usability: 'unknown',
    observedAt: null,
    evidenceSource: 'collector',
    notes: [],
    ...over,
  };
}

const NATIVE_BASE: VerseSeat = {
  id: 'claude',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', contextWindow: 200_000 }],
  contextWindow: 200_000,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

export function nativeSeat(cap: Capacity, over: Partial<VerseSeat> = {}): VerseSeat {
  return { ...NATIVE_BASE, ...over, capacity: cap };
}

const CLAUDE_WINDOWS: CapacityWindow[] = [
  seatWindow({ id: 'five_hour', usedPercent: 15, resetDescription: 'resets Sep 21 at 1:40am (America/New_York)' }),
  seatWindow({ id: 'seven_day', usedPercent: 85, resetDescription: 'resets Sep 25 at 7pm (America/New_York)' }),
  seatWindow({ id: 'seven_day_fable', usedPercent: 100, resetDescription: 'resets Sep 25 at 7pm (America/New_York)', limitReached: true, measured: false }),
];

/** Claude on max: three windows, prose resets, the per-model week binding. */
export const CLAUDE_MAX_SEAT = nativeSeat(capacity({
  planType: 'max',
  windows: CLAUDE_WINDOWS,
  binding: CLAUDE_WINDOWS[2]!,
  usability: 'exhausted',
  observedAt: '2026-09-20T18:32:00.000Z',
}));

/** The same seat before its per-model week ran out — the everyday case. */
export const CLAUDE_TIGHT_SEAT = (() => {
  const windows = [
    CLAUDE_WINDOWS[0]!,
    CLAUDE_WINDOWS[1]!,
    seatWindow({ id: 'seven_day_fable', usedPercent: 92, resetDescription: 'resets Sep 25 at 7pm (America/New_York)' }),
  ];
  return nativeSeat(capacity({
    planType: 'max',
    windows,
    binding: windows[2]!,
    usability: 'tight',
    observedAt: '2026-09-20T18:32:00.000Z',
  }));
})();

/** Codex: weekly window flagged spent, credits still spendable → tight. */
export const CODEX_CREDITS_SEAT = (() => {
  const window = seatWindow({ id: 'codex_codex_primary', usedPercent: 100, resetsAt: '2026-09-25T18:25:44.000Z', limitReached: true, measured: false });
  return nativeSeat(capacity({
    planType: 'pro',
    windows: [window],
    binding: window,
    credits: { hasCredits: true, unlimited: false, balance: '2048.4196250000' },
    usability: 'tight',
    observedAt: '2026-09-20T18:32:00.000Z',
  }), { id: 'codex-personal', engine: 'codex', label: 'Personal Codex', accountId: 'codex-personal' });
})();

/** Grok on SuperGrok with a real machine-readable reset. */
export const GROK_SEAT = (() => {
  const window = seatWindow({ id: 'grok_unified_weekly', usedPercent: 1, resetsAt: '2026-09-26T12:43:50.000Z' });
  return nativeSeat(capacity({
    planType: 'SuperGrok',
    windows: [window],
    binding: window,
    usability: 'ready',
    observedAt: '2026-09-20T18:32:00.000Z',
  }), { id: 'grok', engine: 'grok', label: 'Grok', accountId: 'grok' });
})();

/** Nothing was read. Not zero, not healthy. */
export const UNREAD_SEAT = nativeSeat(capacity({
  usability: 'unknown',
  notes: ['No probe has run for this account yet in this server.'],
}), { health: { state: 'unknown', summary: null, windows: [], observedAt: null } });

/** An Ollama tag: no subscription, no quota, no bill. */
export const LOCAL_SEAT_V2: VerseSeat = {
  id: 'local:qwen3-coder',
  engine: 'local',
  label: 'Qwen3 Coder (local)',
  accountId: 'local',
  models: [{ id: 'qwen3-coder', label: 'qwen3-coder', contextWindow: 65_536 }],
  contextWindow: 65_536,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};
