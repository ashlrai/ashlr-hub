/**
 * routes/verse/chat/composer-state.ts — the composer's memory, and an
 * honest estimate of what a message will cost.
 *
 * The memory (per-chat drafts and sent messages in `localStorage`) lives in
 * composer-memory.ts and is re-exported here unchanged; see that file.
 */

import { CHARS_PER_TOKEN, occupancy } from '../../../../core/verse/context-math.js';

export {
  clearComposerMemory,
  forgetComposerMemory,
  loadDraft,
  loadHistory,
  pushHistory,
  saveDraft,
  VERSE_DRAFT_STORAGE_KEY,
  VERSE_SENT_STORAGE_KEY,
} from './composer-memory.js';

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Characters per token — context-math's CHARS_PER_TOKEN, the one estimator
 * every surface uses (handoff size, fit badges, this hint). A rough
 * English/code average, and rough is the point: the real count is the
 * provider's, which this app does not have before the turn runs. Every
 * surface that shows this figure marks it `≈` and never presents it as
 * measured (DESIGN §6, VERSE-TELEMETRY-V2).
 */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

/** `over` = the projection is past the whole window, not just the compaction point. */
export type CostTone = 'warn' | 'danger' | 'over';

export interface CostHint {
  /** Estimated tokens for the draft itself. */
  draftTokens: number;
  /** Occupancy this message would push the session to (current + draft), in tokens. */
  projectedTokens: number;
  /** …as a percent of the context WINDOW (the meter's track), unclamped. */
  projectedPercent: number;
  /** Where the CLI auto-compacts, when known. */
  autoCompactAt: number | null;
  /** True when the projection reaches the compaction point: the CLI compacts before or during this turn. */
  pastCompaction: boolean;
  tone: CostTone;
  /** False when the current occupancy is itself an upper bound (codex before its rollout is read). */
  exact: boolean;
}

/** The session's context budget as the composer sees it (verse-model `sessionContextBudget`). */
export interface CostBudget {
  contextTokens: number | null | undefined;
  contextWindow: number | null | undefined;
  autoCompactAt?: number | null;
  exact?: boolean;
}

/**
 * What sending this draft would do to the context — or null when the window
 * is unknown, the box is empty, or the session stays comfortable.
 *
 * The tones are context-math `occupancy()`'s — measured against the
 * COMPACTION point when it is known (warn from 80%, danger from 95%), else
 * against the window — which is exactly what colours the ContextMeter, so the
 * hint and the meter can never disagree about when things are getting tight.
 */
export function costHint(text: string, budget: CostBudget): CostHint | null {
  const draftTokens = estimateTokens(text);
  if (draftTokens === 0) return null;
  const window = typeof budget.contextWindow === 'number' && budget.contextWindow > 0 ? budget.contextWindow : null;
  if (window === null) return null;
  const used = typeof budget.contextTokens === 'number' && Number.isFinite(budget.contextTokens) ? Math.max(0, budget.contextTokens) : 0;
  const projected = occupancy({
    contextTokens: used + draftTokens,
    contextWindow: window,
    autoCompactAt: budget.autoCompactAt ?? null,
    contextTokensExact: budget.exact,
  });
  if (projected.tone === 'ok' || projected.tone === 'unknown') return null;
  return {
    draftTokens,
    projectedTokens: projected.tokens,
    projectedPercent: Math.min(999, Math.round((projected.ofWindow ?? 0) * 100)),
    autoCompactAt: projected.autoCompactAt,
    pastCompaction: projected.ofCompaction !== null && projected.ofCompaction >= 1,
    tone: projected.tone,
    exact: projected.exact,
  };
}
