/**
 * Ashlr Verse — context arithmetic shared by the server and the browser.
 *
 * PURE and BROWSER-SAFE: no node imports, no I/O. The seat catalog, the
 * session engine, the adapters and the UI all compute thresholds through this
 * one module, so "compacts at 367k" can never mean two different numbers in
 * two places. docs/VERSE-CONTEXT.md is the prose authority for every constant.
 *
 * Where each formula comes from (all read from the CLIs themselves, 2026-09-23):
 *
 *  Claude Code (2.1.257 and 2.1.280 binaries): the auto-compaction window is
 *    `min(--autocompact | autoCompactWindow | auto, model window)`. From it the
 *    CLI reserves `min(max output, 20_000)` for the reply and compacts a
 *    further 13_000 below that. On a 1M model at `auto` that is 967_000 — the
 *    `pre_tokens` observed on real compactions (967_391).
 *  Codex (0.136 – 0.155 rollouts): the window the CLI measures against is
 *    `context_window × effective_context_window_percent / 100` = 258_400 for
 *    every 272k model; auto-compaction triggers at 90% of the RAW window
 *    (244_800). The largest uncompacted call across 62,104 was 243_204.
 *  Grok (0.2.118 catalog): compacts at `auto_compact_threshold_percent` (80)
 *    of `context_window` (500_000) = 400_000.
 *  Local seats run the Claude Code binary against Ollama, so they compact by
 *    the Claude formula over the window Verse passes in
 *    `CLAUDE_CODE_MAX_CONTEXT_TOKENS`.
 */

import type {
  VerseContextBudget,
  VerseContextMode,
  VerseEngine,
  VerseFitVerdict,
  VerseModelOption,
  VerseSession,
  VerseUsage,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Standard-mode compaction window for 1M-context Claude models.
 *
 * WHY 400k and not the CLI's ~967k: every turn re-sends the whole prefix, so a
 * session held near 900k costs ~2.3× per call what one held under 400k does,
 * and long-context recall degrades with length on every published benchmark
 * (docs/VERSE-CONTEXT.md §2). 400k keeps a large working set — far above the
 * 150k Anthropic's own API compacts at by default — while leaving the full
 * window one click away in `expansive` mode. Grok's native budget is also
 * 400k, so the two frontier engines share one standard ceiling.
 */
export const CLAUDE_STANDARD_AUTOCOMPACT_WINDOW = 400_000;

/** Claude Code reserves min(max output, this) of the window for the reply. */
export const CLAUDE_OUTPUT_RESERVE_CAP = 20_000;
/** …and compacts this many tokens below the reserved window. */
export const CLAUDE_COMPACT_BUFFER = 13_000;
/** Claude Code clamps `--autocompact` to [100k, 1M]. */
export const CLAUDE_AUTOCOMPACT_MIN = 100_000;
export const CLAUDE_AUTOCOMPACT_MAX = 1_000_000;

/** Codex: default `effective_context_window_percent` in every catalog entry. */
export const CODEX_EFFECTIVE_WINDOW_PERCENT = 95;
/** Codex: auto-compaction fires at this fraction of the RAW window. */
export const CODEX_AUTO_COMPACT_FRACTION = 0.9;

/** Grok: `auto_compact_threshold_percent` in the 0.2.118 catalog. */
export const GROK_AUTO_COMPACT_PERCENT = 80;

/**
 * How long a provider keeps a conversation's prompt cache warm while idle.
 * Claude Code on a subscription: 1h (5 min without it). Past this, the next
 * turn re-reads the whole context at full price — the single most expensive
 * thing an idle long session can do.
 */
export const CACHE_IDLE_TTL_MS = 60 * 60 * 1000;

/**
 * Fixed prompt overhead (system prompt + tool definitions) a FRESH session
 * already occupies before any work, per engine.
 *
 *  local  15k — measured: two real turns through Claude Code 2.1.280 against
 *               Ollama with `--exclude-dynamic-system-prompt-sections`
 *               reported 14,695 and 14,942 context tokens for a one-word reply.
 *  claude 25k — the same CLI without that flag measured 17.8k–23.3k on local
 *               seats; rounded up. An ESTIMATE, never shown as a measurement.
 *  codex  15k / grok 20k — estimates; neither CLI reports its base prompt.
 *
 * Only used by the fit verdicts, which are labelled as estimates in the UI.
 */
export const SESSION_BASE_OVERHEAD_BY_ENGINE: Readonly<Record<VerseEngine, number>> = {
  claude: 25_000,
  codex: 15_000,
  grok: 20_000,
  local: 15_000,
};

/** Fallback overhead when the engine is unknown (the largest estimate). */
export const SESSION_BASE_OVERHEAD_TOKENS = 25_000;

export function sessionOverheadTokens(engine: VerseEngine | null | undefined): number {
  return engine ? SESSION_BASE_OVERHEAD_BY_ENGINE[engine] ?? SESSION_BASE_OVERHEAD_TOKENS : SESSION_BASE_OVERHEAD_TOKENS;
}

/**
 * Smallest local window worth offering as a seat. Local turns run Claude Code
 * with `CLAUDE_CODE_MAX_CONTEXT_TOKENS=<window>`, which compacts at
 * `window − 20k − 13k`; below this the compaction point leaves under 8k of
 * working room above the ~15k base prompt, so every turn would compact.
 */
export const LOCAL_MIN_WORKING_TOKENS = 8_000;
export const LOCAL_MIN_USABLE_WINDOW =
  SESSION_BASE_OVERHEAD_BY_ENGINE.local + LOCAL_MIN_WORKING_TOKENS + CLAUDE_OUTPUT_RESERVE_CAP + CLAUDE_COMPACT_BUFFER;

/** True when a local window leaves real working room under Claude Code's compaction rule. */
export function localWindowUsable(window: number | null | undefined): boolean {
  return typeof window === 'number' && Number.isFinite(window) && window >= LOCAL_MIN_USABLE_WINDOW;
}

/** chars → tokens estimator used everywhere a count is estimated rather than measured. */
export const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// Per-engine formulas
// ---------------------------------------------------------------------------

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/**
 * Claude Code's auto-compaction point.
 *
 * @param modelWindow        the model's context window (1_000_000, 200_000, or
 *                           the local num_ctx passed in CLAUDE_CODE_MAX_CONTEXT_TOKENS)
 * @param maxOutputTokens    the model's default max output; null → assume the cap
 * @param autocompactWindow  the `--autocompact` value in force; null → `auto`
 *                           (the full model window)
 */
export function claudeAutoCompactAt(
  modelWindow: number,
  maxOutputTokens: number | null,
  autocompactWindow: number | null = null,
): number {
  const window = Math.min(modelWindow, positiveInt(autocompactWindow) ?? modelWindow);
  const reserve = Math.min(positiveInt(maxOutputTokens) ?? CLAUDE_OUTPUT_RESERVE_CAP, CLAUDE_OUTPUT_RESERVE_CAP);
  return Math.max(0, window - reserve - CLAUDE_COMPACT_BUFFER);
}

/** Codex: the window the CLI measures occupancy against. */
export function codexEffectiveWindow(rawWindow: number, percent: number | null = null): number {
  const pct = positiveInt(percent) !== null && (percent as number) <= 100 ? (percent as number) : CODEX_EFFECTIVE_WINDOW_PERCENT;
  return Math.floor((rawWindow * pct) / 100);
}

/** Codex: where auto-compaction fires for a given RAW window. */
export function codexAutoCompactAt(rawWindow: number): number {
  return Math.floor(rawWindow * CODEX_AUTO_COMPACT_FRACTION);
}

/** Grok: where auto-compaction fires. */
export function grokAutoCompactAt(window: number, percent: number | null = null): number {
  const pct = positiveInt(percent) !== null && (percent as number) <= 100 ? (percent as number) : GROK_AUTO_COMPACT_PERCENT;
  return Math.floor((window * pct) / 100);
}

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/**
 * Ids Verse once shipped that the CLI does NOT resolve to the model the label
 * promised. `claude-opus-5.5` is parsed by Claude Code as a fuzzy match for
 * `claude-opus-5` (its normaliser rejects the `.5` suffix and falls back to
 * `includes('claude-opus-5')`), so every "Opus 5.5" turn actually ran Opus 5.
 * Old session records keep their stored id; adapters send the canonical one.
 */
export const VERSE_MODEL_ID_ALIASES: Readonly<Record<string, string>> = {
  'claude-opus-5.5': 'claude-opus-5-5',
};

export function canonicalModelId(id: string): string {
  return VERSE_MODEL_ID_ALIASES[id] ?? id;
}

// ---------------------------------------------------------------------------
// Budgets and occupancy
// ---------------------------------------------------------------------------

/** The budget a model runs with in a mode, or null when that mode does not exist for it. */
export function budgetFor(option: VerseModelOption | null | undefined, mode: VerseContextMode): VerseContextBudget | null {
  if (!option) return null;
  if (mode === 'expansive') return option.expansive ?? null;
  const window = positiveInt(option.contextWindow);
  if (window === null) return null;
  return { contextWindow: window, autoCompactAt: positiveInt(option.autoCompactAt ?? null) };
}

/** True when this model has a genuine expansive budget larger than its standard one. */
export function hasExpansiveMode(option: VerseModelOption | null | undefined): boolean {
  const standard = budgetFor(option, 'standard');
  const expansive = budgetFor(option, 'expansive');
  if (!expansive) return false;
  if (!standard) return true;
  return (expansive.autoCompactAt ?? expansive.contextWindow) > (standard.autoCompactAt ?? standard.contextWindow);
}

/**
 * The `--autocompact` value Verse passes to Claude Code for a model in a mode,
 * or null for "let the CLI use `auto`". Only 1M-native models are capped in
 * standard mode; a 200k model already compacts near 167k natively.
 */
export function claudeAutocompactFlag(option: VerseModelOption | null | undefined, mode: VerseContextMode): number | null {
  if (mode === 'expansive') return null;
  const window = positiveInt(option?.contextWindow ?? null);
  return window !== null && window > CLAUDE_STANDARD_AUTOCOMPACT_WINDOW && hasExpansiveMode(option)
    ? CLAUDE_STANDARD_AUTOCOMPACT_WINDOW
    : null;
}

/**
 * Recompute the compaction point when the CLI reports a window at runtime
 * that differs from the catalog budget (Claude Code clamps a 1M model to 200k
 * when long-context credit runs out; grok can upgrade a window by header).
 *
 *  claude/local — fixed-buffer formula over min(runtime window, --autocompact).
 *  codex        — the runtime figure is the EFFECTIVE window; the compaction
 *                 point stays 90% of the raw window it implies.
 *  grok/other   — keep the budget's compaction RATIO.
 */
export function reconcileAutoCompactAt(input: {
  engine: VerseEngine;
  runtimeWindow: number;
  budget: VerseContextBudget | null;
  /** The `--autocompact` value in force for claude/local; null = auto. */
  autocompactWindow?: number | null;
  maxOutputTokens?: number | null;
}): number | null {
  const runtime = positiveInt(input.runtimeWindow);
  if (runtime === null) return input.budget?.autoCompactAt ?? null;
  if (input.budget && input.budget.contextWindow === runtime) return input.budget.autoCompactAt;
  switch (input.engine) {
    case 'claude':
    case 'local':
      return claudeAutoCompactAt(runtime, input.maxOutputTokens ?? null, input.autocompactWindow ?? null);
    case 'codex':
      return codexAutoCompactAt(Math.round((runtime * 100) / CODEX_EFFECTIVE_WINDOW_PERCENT));
    default: {
      const b = input.budget;
      if (!b || b.autoCompactAt === null || b.contextWindow <= 0) return null;
      return Math.floor(runtime * (b.autoCompactAt / b.contextWindow));
    }
  }
}

export type VerseOccupancyTone = 'unknown' | 'ok' | 'warn' | 'danger' | 'over';

export interface VerseOccupancy {
  tokens: number;
  window: number | null;
  autoCompactAt: number | null;
  /** tokens / window, unclamped; null when the window is unknown. */
  ofWindow: number | null;
  /** tokens / autoCompactAt, unclamped; null when the compaction point is unknown. */
  ofCompaction: number | null;
  /** Tokens left before auto-compaction (≥ 0), null when unknown. */
  untilCompaction: number | null;
  tone: VerseOccupancyTone;
  /** False when `tokens` is an upper bound (codex before its rollout is readable). */
  exact: boolean;
}

/** Warn at 80% of the compaction point, danger from 95% — BEFORE the CLI compacts, not after. */
export const OCCUPANCY_WARN = 0.8;
export const OCCUPANCY_DANGER = 0.95;

export function occupancy(usage: Pick<VerseUsage, 'contextTokens' | 'contextWindow' | 'autoCompactAt' | 'contextTokensExact'>): VerseOccupancy {
  const tokens = Math.max(0, Math.floor(usage.contextTokens || 0));
  const window = positiveInt(usage.contextWindow);
  const compactAt = positiveInt(usage.autoCompactAt ?? null);
  const ofWindow = window !== null ? tokens / window : null;
  const ofCompaction = compactAt !== null ? tokens / compactAt : null;
  const gauge = ofCompaction ?? ofWindow;
  const exact = usage.contextTokensExact !== false;
  let tone: VerseOccupancyTone = 'unknown';
  if (!exact && gauge !== null && gauge >= 1) {
    // An UPPER BOUND past the compaction point says nothing about the real
    // prompt: codex's turn total sums every model call (median 29× the last
    // one). Claiming "over the window" from it would be invented precision.
    tone = 'unknown';
  } else if (window !== null && tokens > window) tone = 'over';
  else if (gauge !== null) tone = gauge >= OCCUPANCY_DANGER ? 'danger' : gauge >= OCCUPANCY_WARN ? 'warn' : 'ok';
  return {
    tokens,
    window,
    autoCompactAt: compactAt,
    ofWindow,
    ofCompaction,
    untilCompaction: compactAt !== null ? Math.max(0, compactAt - tokens) : null,
    tone,
    exact,
  };
}

// ---------------------------------------------------------------------------
// Efficiency
// ---------------------------------------------------------------------------

/**
 * Share of prompt tokens served from cache: cacheRead / (input + cacheRead +
 * cacheCreation). Adapters already report `inputTokens` EXCLUDING cached
 * tokens (codex's turn total is split by its adapter), so the buckets are
 * disjoint. Null when nothing has been read yet.
 */
export function cacheHitRatio(usage: Pick<VerseUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>): number | null {
  const denominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return denominator > 0 ? usage.cacheReadTokens / denominator : null;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Advice (pure; the UI decides how to show it, nothing here spends)
// ---------------------------------------------------------------------------

/**
 * Would this working set fit one context on this model?
 *
 *  fits      — working set + fixed overhead ≤ 60% of the standard compaction point
 *  tight     — ≤ 100% of it: it fits, but the session will compact soon
 *  expansive — only the expansive budget holds it
 *  split     — no single context holds it; fan the work out instead
 *
 * Null when the model's budget is unknown (never guessed). Pass the engine's
 * `sessionOverheadTokens(engine)`; the default is the largest estimate.
 */
export function fitVerdict(
  workingSetTokens: number,
  option: VerseModelOption | null | undefined,
  overheadTokens: number = SESSION_BASE_OVERHEAD_TOKENS,
): VerseFitVerdict | null {
  const standard = budgetFor(option, 'standard');
  if (!standard) return null;
  const need = Math.max(0, workingSetTokens) + Math.max(0, overheadTokens);
  const standardCap = standard.autoCompactAt ?? standard.contextWindow;
  if (need <= standardCap * 0.6) return 'fits';
  if (need <= standardCap) return 'tight';
  const expansive = budgetFor(option, 'expansive');
  if (expansive && need <= (expansive.autoCompactAt ?? expansive.contextWindow)) return 'expansive';
  return 'split';
}

export type VerseAdviceLevel = 'none' | 'suggest' | 'urge';

export interface VerseHandoffAdvice {
  level: VerseAdviceLevel;
  /** Plain sentences, most important first. Empty when level is 'none'. */
  reasons: string[];
}

/** Compactions after which early-turn detail is mostly summaries. */
export const HANDOFF_COMPACTION_THRESHOLD = 2;
/** Below this, an expired cache is cheap to re-read and not worth a handoff. */
export const HANDOFF_IDLE_MIN_TOKENS = 100_000;

function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Should the operator continue in a fresh session? Pure: `now` and
 * `lastActivityAt` are passed in, so the verdict is reproducible in tests.
 */
export function handoffAdvice(input: {
  usage: VerseUsage;
  compactionCount?: number;
  lastActivityAt?: string | null;
  now: number;
}): VerseHandoffAdvice {
  const occ = occupancy(input.usage);
  const reasons: string[] = [];
  let level: VerseAdviceLevel = 'none';
  const bump = (to: VerseAdviceLevel): void => {
    // (level only ever rises)
    if (to === 'urge' || (to === 'suggest' && level === 'none')) level = to;
  };

  if (!occ.exact) {
    // An upper bound cannot justify "you are near compaction"; wait for a reading.
  } else if (occ.tone === 'over') {
    bump('urge');
    reasons.push(`Context (${compactTokens(occ.tokens)}) is past the ${compactTokens(occ.window ?? 0)} window.`);
  } else if (occ.ofCompaction !== null && occ.ofCompaction >= OCCUPANCY_WARN) {
    bump('suggest');
    reasons.push(`About ${compactTokens(occ.untilCompaction ?? 0)} tokens left before the CLI auto-compacts.`);
  }

  const compactions = input.compactionCount ?? 0;
  if (compactions >= HANDOFF_COMPACTION_THRESHOLD) {
    bump('suggest');
    reasons.push(`Compacted ${compactions} times — early turns now survive only as summaries.`);
  }

  if (input.lastActivityAt) {
    const idle = input.now - Date.parse(input.lastActivityAt);
    if (occ.exact && Number.isFinite(idle) && idle >= CACHE_IDLE_TTL_MS && occ.tokens >= HANDOFF_IDLE_MIN_TOKENS) {
      bump('suggest');
      reasons.push(`Idle over an hour: the prompt cache has likely expired, so the next turn re-reads ~${compactTokens(occ.tokens)} tokens at full cost.`);
    }
  }
  return { level, reasons };
}

export interface VerseExpansiveAdvice {
  suggest: boolean;
  reason: string | null;
}

/**
 * Suggest — never switch on — expansive mode. Only for a session in standard
 * mode whose model has a real expansive budget, and only on evidence: it has
 * already compacted repeatedly, or its working set only fits expansive.
 */
export function expansiveAdvice(input: {
  session: Pick<VerseSession, 'contextMode' | 'compactionCount'>;
  option: VerseModelOption | null | undefined;
  workingSetTokens?: number | null;
}): VerseExpansiveAdvice {
  if ((input.session.contextMode ?? 'standard') !== 'standard' || !hasExpansiveMode(input.option)) {
    return { suggest: false, reason: null };
  }
  const compactions = input.session.compactionCount ?? 0;
  if (compactions >= HANDOFF_COMPACTION_THRESHOLD) {
    return { suggest: true, reason: `This session has compacted ${compactions} times; expansive mode keeps more of it in view.` };
  }
  if (typeof input.workingSetTokens === 'number' && fitVerdict(input.workingSetTokens, input.option) === 'expansive') {
    return { suggest: true, reason: `The reachable code (~${compactTokens(input.workingSetTokens)} tokens) only fits the expansive budget.` };
  }
  return { suggest: false, reason: null };
}

/** Engines whose CLIs can be told a compaction budget per invocation. */
export function engineSupportsModes(engine: VerseEngine): boolean {
  return engine === 'claude' || engine === 'codex';
}
