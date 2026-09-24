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
 *
 * V3.9 — every model option carries its real context budget, computed with
 * the SAME formulas the server uses (core/verse/context-math.ts), from the
 * ground truth in docs/VERSE-CONTEXT.md §1: 1M Claude models compact at 367k
 * in Standard and 967k in Expansive; Codex measures against 258.4k and
 * compacts at 244.8k (Expansive: 828.4k / 784.8k, told `872000`); Grok
 * compacts at 400k of 500k; a 64k local tag at 32.5k.
 */
import type { VerseModelOption, VerseSeat } from '../../data/api-types.js';
import {
  CLAUDE_STANDARD_AUTOCOMPACT_WINDOW,
  claudeAutoCompactAt,
  codexAutoCompactAt,
  codexEffectiveWindow,
  grokAutoCompactAt,
} from '../../../core/verse/context-math.js';
import type { VerseWindowSource } from '../../../core/verse/types.js';

/**
 * A Claude model option exactly as model-windows builds one: 1M-native models
 * get a capped Standard budget and an `auto` Expansive one; 200k models get
 * their native budget and no second mode.
 */
export function claudeOption(
  id: string,
  label: string,
  window: number,
  maxOutputTokens: number,
  over: Partial<VerseModelOption> = {},
): VerseModelOption {
  const native1m = window >= 1_000_000;
  return {
    id,
    label,
    contextWindow: window,
    autoCompactAt: claudeAutoCompactAt(window, maxOutputTokens, native1m ? CLAUDE_STANDARD_AUTOCOMPACT_WINDOW : null),
    expansive: native1m ? { contextWindow: window, autoCompactAt: claudeAutoCompactAt(window, maxOutputTokens, null) } : null,
    maxOutputTokens,
    windowSource: 'cli-catalog',
    minCliVersion: null,
    unavailableReason: null,
    ...over,
  };
}

/** A codex catalog entry projected the way model-windows does: 95% effective, 90%-of-raw compaction. */
export function codexOption(id: string, label: string, maxWindow: number, source: VerseWindowSource = 'provider-catalog'): VerseModelOption {
  const raw = 272_000;
  return {
    id,
    label,
    contextWindow: codexEffectiveWindow(raw, 95),
    autoCompactAt: codexAutoCompactAt(raw),
    expansive: maxWindow > raw
      ? { contextWindow: codexEffectiveWindow(maxWindow, 95), autoCompactAt: codexAutoCompactAt(maxWindow), providerWindow: maxWindow }
      : null,
    windowSource: source,
  };
}

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
  models: [claudeOption('claude-opus-5', 'Opus 5', 1_000_000, 64_000)],
  contextWindow: 1_000_000,
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
  models: [{ id: 'qwen3-coder', label: 'qwen3-coder', contextWindow: 65_536, autoCompactAt: claudeAutoCompactAt(65_536, null), windowSource: 'runtime' }],
  contextWindow: 65_536,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

// ---------------------------------------------------------------------------
// V3.9 context seats — shaped like Mason's roster on 2026-09-23
// ---------------------------------------------------------------------------

/** The note seats.ts writes when a seat's pinned CLI is older than one installed. */
export const CLAUDE_SKEW_NOTE =
  'Pinned to Claude Code 2.1.257; 2.1.280 is installed — Opus 5.5 needs it. Re-pin with: ashlr resources profile repin --directory <dir> --executable <path>';

export const OPUS_55_REASON = 'needs Claude Code 2.1.280; this seat runs 2.1.257';

/**
 * claude-a: pinned to 2.1.257, so Opus 5.5 is LISTED but unavailable, and the
 * first (default) model is a runnable one.
 */
export const CLAUDE_CONTEXT_SEAT: VerseSeat = {
  id: 'claude-a',
  engine: 'claude',
  label: 'Claude Max',
  accountId: 'claude-a',
  models: [
    claudeOption('claude-fable-5-1', 'Fable 5.1', 1_000_000, 128_000),
    claudeOption('claude-opus-5-5', 'Opus 5.5', 1_000_000, 128_000, { minCliVersion: '2.1.280', unavailableReason: OPUS_55_REASON }),
    claudeOption('claude-haiku-4-5-20251001', 'Haiku 4.5', 200_000, 32_000),
  ],
  contextWindow: 1_000_000,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
  cliVersion: '2.1.257',
  notes: [CLAUDE_SKEW_NOTE],
};

/** codex-b: its own catalog — GPT-6 Astra with an 872k expansive budget, GPT-5.5 with none. */
export const CODEX_CONTEXT_SEAT: VerseSeat = {
  id: 'codex-b',
  engine: 'codex',
  label: 'Work Codex',
  accountId: 'codex-b',
  models: [codexOption('gpt-6-astra', 'GPT-6 Astra', 872_000), codexOption('gpt-5.5', 'GPT-5.5', 272_000)],
  contextWindow: codexEffectiveWindow(272_000, 95),
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
  cliVersion: '0.155.0',
};

export const CODEX_CATALOG_NOTE = "Model list is Verse's built-in list until this seat's first turn fetches its own catalog.";

/** codex-a: never ran a turn, so no catalog yet — the documented fallback list, and a note saying so. */
export const CODEX_UNFETCHED_SEAT: VerseSeat = {
  id: 'codex-a',
  engine: 'codex',
  label: 'Personal Codex',
  accountId: 'codex-a',
  models: [codexOption('gpt-5.5', 'GPT-5.5', 272_000, 'documented')],
  contextWindow: codexEffectiveWindow(272_000, 95),
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
  cliVersion: '0.136.0',
  notes: [CODEX_CATALOG_NOTE],
};

/** grok-a: one budget, 400k of 500k; no expansive mode exists. */
export const GROK_CONTEXT_SEAT: VerseSeat = {
  id: 'grok-a',
  engine: 'grok',
  label: 'Grok',
  accountId: 'grok-a',
  models: [{ id: 'grok-4.7-build-fast', label: 'Grok 4.7 Fast', contextWindow: 500_000, autoCompactAt: grokAutoCompactAt(500_000, 80), windowSource: 'provider-catalog' }],
  contextWindow: 500_000,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

/** A 64k local tag: Verse tells the CLI the window, so it compacts at 32.5k. */
export const LOCAL_CONTEXT_SEAT: VerseSeat = {
  id: 'local:qwen3.8:27b-ctx64k',
  engine: 'local',
  label: 'Qwen3.8 27B (local)',
  accountId: 'local',
  models: [{ id: 'qwen3.8:27b-ctx64k', label: 'qwen3.8:27b-ctx64k', contextWindow: 65_536, autoCompactAt: claudeAutoCompactAt(65_536, null), windowSource: 'runtime' }],
  contextWindow: 65_536,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};

/** A model whose window nothing knows — the picker must say so, never guess. */
export const UNKNOWN_WINDOW_SEAT: VerseSeat = {
  id: 'claude-x',
  engine: 'claude',
  label: 'Claude Team',
  accountId: 'claude-x',
  models: [{ id: 'claude-mystery-9', label: 'Mystery 9', contextWindow: null }],
  contextWindow: null,
  health: { state: 'ready', summary: null, windows: [], observedAt: null },
};
