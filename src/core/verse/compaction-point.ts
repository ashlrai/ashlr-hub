/**
 * Ashlr Verse — where each engine auto-compacts, including when the CLI
 * reports a different window at runtime. Part of context-math.ts, which
 * re-exports everything here; see its header for where each formula comes
 * from (docs/VERSE-CONTEXT.md is the prose authority for every constant).
 *
 * WHY A SEPARATE MODULE: the browser's session store (web-ui verse-store.ts)
 * reconciles the compaction point as context readings stream in, which puts
 * it on the chat first-paint path. Importing context-math there pulled the
 * whole module (budgets, occupancy, fit and handoff advice) into the chat
 * first-paint critical JS; importing this file pulls only these formulas.
 *
 * PURE and BROWSER-SAFE: no node imports, no I/O.
 */

import type { VerseContextBudget, VerseEngine } from './types.js';

/** Claude Code reserves min(max output, this) of the window for the reply. */
export const CLAUDE_OUTPUT_RESERVE_CAP = 20_000;
/** …and compacts this many tokens below the reserved window. */
export const CLAUDE_COMPACT_BUFFER = 13_000;
/** Codex: default `effective_context_window_percent` in every catalog entry. */
export const CODEX_EFFECTIVE_WINDOW_PERCENT = 95;
/** Codex: auto-compaction fires at this fraction of the RAW window. */
export const CODEX_AUTO_COMPACT_FRACTION = 0.9;

/** A positive finite number, floored; null for anything else. */
export function positiveInt(value: unknown): number | null {
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

/** Codex: where auto-compaction fires for a given RAW window. */
export function codexAutoCompactAt(rawWindow: number): number {
  return Math.floor(rawWindow * CODEX_AUTO_COMPACT_FRACTION);
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
