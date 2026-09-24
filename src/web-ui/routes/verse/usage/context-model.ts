/**
 * routes/verse/usage/context-model.ts — the ONE projection of context facts
 * for every surface that shows a seat: the seat picker's rows, the new-chat
 * dialog's context block, the resources panel's "This chat" efficiency block,
 * and the Usage section's per-seat efficiency table.
 *
 * WHY ONE MODULE. Before V3.9 every surface read `seat.contextWindow` (the
 * DEFAULT model's window) or the session's creation-time window, and three of
 * them rendered "200k" for a 1M Claude model. The arithmetic now lives in
 * core/verse/context-math.ts, shared with the server; this module is only the
 * wording and the aggregation, so the picker, the dialog and the panel cannot
 * describe one model's budget three different ways.
 *
 * HONESTY RULES this module enforces (docs/VERSE-CONTEXT.md):
 *
 *  1. UNKNOWN IS NOT A NUMBER. A model whose budget is unknown reads "window
 *     unknown", never a default dressed as a fact. A Verse fallback window is
 *     marked "est.", and its source says so in words.
 *  2. AN UPPER BOUND IS NOT A MEASUREMENT. Codex's turn total sums every model
 *     call; until its rollout is read, occupancy is "≤ N", and any statistic
 *     built on such a reading carries the same flag.
 *  3. NO CACHE REPORTED IS NOT A 0% HIT RATE. A provider that reported no
 *     cache activity at all (Ollama; codex on its very first call) gets "none
 *     reported", not a 0% that reads "caching is broken".
 *  4. NOTHING HERE SPENDS. Every figure is derived from what the server
 *     already returned (seats, sessions, the open chat's event log).
 *
 * Pure: no React, no I/O.
 */
import {
  CACHE_IDLE_TTL_MS,
  budgetFor,
  cacheHitRatio,
  fitVerdict,
  hasExpansiveMode,
  sessionOverheadTokens,
} from '../../../../core/verse/context-math.js';
import type {
  VerseContextBudget,
  VerseContextFit,
  VerseContextMode,
  VerseEngine,
  VerseEvent,
  VerseFitVerdict,
  VerseModelOption,
  VerseSeat,
  VerseSession,
  VerseUsage,
  VerseWindowSource,
} from '../../../../core/verse/types.js';
import { CODEX_EXPANSIVE_METERING_NOTE, WINDOW_SOURCE_TEXT, modelOptionFor, seatUnavailableReason, sessionContextBudget } from '../verse-model.js';
import { formatTokens } from '../verse-store.js';

// ---------------------------------------------------------------------------
// Models and modes
// ---------------------------------------------------------------------------

/**
 * A seat's option for a model id, matching through the alias table (a chat
 * remembered on `claude-opus-5.5` is the catalog's `claude-opus-5-5`). The
 * lookup itself is verse-model's `modelOptionFor`, the one the context meter
 * uses, so the picker and the meter can never resolve one id two ways.
 */
export function seatModelOption(seat: VerseSeat | null | undefined, modelId: string): VerseModelOption | null {
  return seat ? modelOptionFor([seat], { seatId: seat.id, model: modelId }) : null;
}

/** `mode` when this model has a budget for it, else `standard` — never a mode the CLI cannot be told. */
export function resolveContextMode(option: VerseModelOption | null | undefined, mode: VerseContextMode): VerseContextMode {
  return mode !== 'standard' && budgetFor(option, mode) !== null ? mode : 'standard';
}

/** The budget a model runs with in a mode (resolved), or null when even its standard window is unknown. */
export function effectiveBudget(option: VerseModelOption | null | undefined, mode: VerseContextMode): VerseContextBudget | null {
  return budgetFor(option, resolveContextMode(option, mode));
}

/** Why this model cannot be chosen on this seat, or null when it can. The seat's own outage wins. */
export function modelUnavailableReason(seat: VerseSeat, option: VerseModelOption): string | null {
  const seatReason = seatUnavailableReason(seat);
  if (seatReason !== null) return seatReason;
  const reason = option.unavailableReason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null;
}

export const CONTEXT_MODE_LABEL: Record<VerseContextMode, string> = {
  standard: 'Standard',
  expansive: 'Expansive',
};

/** How each seat's CLI is named when its pinned version is shown. */
export const ENGINE_CLI_NAME: Record<VerseEngine, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  grok: 'Grok CLI',
  local: 'Claude Code',
};

/** "Claude Code 2.1.257" — the binary this seat is pinned to; null when unknown (local seats, old servers). */
export function seatCliLine(seat: VerseSeat): string | null {
  const version = typeof seat.cliVersion === 'string' ? seat.cliVersion.trim() : '';
  return version.length > 0 ? `${ENGINE_CLI_NAME[seat.engine]} ${version}` : null;
}

/** The seat's own plain-language context facts (binary skew, catalog not yet fetched, …). */
export function seatContextNotes(seat: VerseSeat): string[] {
  return (seat.notes ?? []).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Window provenance
// ---------------------------------------------------------------------------

// Window provenance wording is verse-model's `WINDOW_SOURCE_TEXT` — the
// meter's tooltip, the picker and the resources panel all read that one table.

export function isEstimatedWindow(source: VerseWindowSource | null | undefined): boolean {
  return source === 'fallback';
}

// ---------------------------------------------------------------------------
// Picker and dialog wording
// ---------------------------------------------------------------------------

/**
 * The compact per-model phrase a picker row carries: "1M ctx · compacts ≈367k".
 * Uses the budget for `mode` when the model has one, and names the mode only
 * when it is not the default, so an ordinary row stays short.
 */
export function modelContextPhrase(option: VerseModelOption, mode: VerseContextMode = 'standard'): string {
  const resolved = resolveContextMode(option, mode);
  const budget = budgetFor(option, resolved);
  if (!budget) return 'window unknown';
  const window = `${formatTokens(budget.contextWindow)} ctx${isEstimatedWindow(option.windowSource) ? ' (est.)' : ''}`;
  const compacts = budget.autoCompactAt === null ? '' : ` · compacts ≈${formatTokens(budget.autoCompactAt)}`;
  return `${window}${compacts}${resolved === 'expansive' ? ' (expansive)' : ''}`;
}

/**
 * The full sentence for a tooltip or the dialog: the window, where each mode
 * compacts, and how the window is known.
 */
export function modelContextSentence(option: VerseModelOption): string {
  const standard = budgetFor(option, 'standard');
  const expansive = hasExpansiveMode(option) ? budgetFor(option, 'expansive') : null;
  const parts: string[] = [];
  if (!standard) {
    parts.push('Context window unknown for this model.');
  } else {
    const where = standard.autoCompactAt === null
      ? ''
      : `; compacts at about ${formatTokens(standard.autoCompactAt)}${expansive ? ' in Standard' : ''}`;
    parts.push(`${formatTokens(standard.contextWindow)}-token window${where}.`);
  }
  if (expansive) {
    parts.push(`Expansive runs to about ${formatTokens(expansive.autoCompactAt ?? expansive.contextWindow)} before compacting.`);
  }
  if (option.windowSource) parts.push(`Window ${WINDOW_SOURCE_TEXT[option.windowSource]}.`);
  return parts.join(' ');
}

/**
 * The metering caveat an Expansive cost sentence must carry for this engine,
 * or null when there is none. The wording is verse-model's
 * CODEX_EXPANSIVE_METERING_NOTE — ONE sentence for the new-chat dialog, the
 * handoff dialog, the in-chat mode menu and the "Expansive could help" chip.
 * The ratio those surfaces quote (≈3.2× for a 785k vs 245k codex turn) counts
 * re-sent TOKENS only; GPT-5.6-class requests above 272k reportedly also
 * count about 2× against plan limits (docs/VERSE-CONTEXT.md §2.3, a single
 * secondary source), so the note is worded as reported, never as a measured
 * multiplier. Standard never crosses 272k; Expansive does by design.
 */
export function expansiveMeteringNote(engine: VerseEngine | null | undefined): string | null {
  return engine === 'codex' ? CODEX_EXPANSIVE_METERING_NOTE : null;
}

/**
 * "A turn at 967k re-sends 2.6× the tokens of one at 367k." — the only ratio
 * any Expansive cost sentence quotes, and it is arithmetic on the model's own
 * budgets. Null when either compaction point is unknown. It comes BEFORE the
 * codex metering note, whose "twice that" refers to it.
 */
export function expansiveRatioSentence(option: VerseModelOption | null | undefined): string | null {
  const standard = budgetFor(option, 'standard');
  const expansive = budgetFor(option, 'expansive');
  const stdCap = standard ? standard.autoCompactAt ?? standard.contextWindow : null;
  const expCap = expansive ? expansive.autoCompactAt ?? expansive.contextWindow : null;
  if (stdCap === null || expCap === null || stdCap <= 0) return null;
  return `A turn at ${formatTokens(expCap)} re-sends ${(expCap / stdCap).toFixed(1)}× the tokens of one at ${formatTokens(stdCap)}.`;
}

/**
 * What each mode costs, in plain words, for the mode selector. Numbers come
 * from the model's own budgets; the only ratio quoted is arithmetic (every
 * turn re-sends everything held, so a turn at X re-sends X/Y of one at Y) —
 * a token ratio, not a usage multiplier, which is why codex also carries the
 * shared metering caveat.
 */
export function contextModeDescription(engine: VerseEngine, option: VerseModelOption, mode: VerseContextMode): string {
  const standard = budgetFor(option, 'standard');
  const expansive = budgetFor(option, 'expansive');
  const stdCap = standard ? standard.autoCompactAt ?? standard.contextWindow : null;
  const expCap = expansive ? expansive.autoCompactAt ?? expansive.contextWindow : null;
  if (mode === 'standard' || expCap === null) {
    if (stdCap === null) return 'The CLI compacts at its own default point for this model.';
    return engine === 'claude'
      ? `Compacts at about ${formatTokens(stdCap)}. Every turn re-sends the whole context, so holding it under this point keeps each turn cheaper and recall sharper.`
      : `Compacts at about ${formatTokens(stdCap)} — the CLI's own default budget for this model.`;
  }
  const ratio = expansiveRatioSentence(option);
  const metering = expansiveMeteringNote(engine);
  return `Runs to about ${formatTokens(expCap)} before compacting — for tightly coupled, cross-cutting work that needs everything in view at once. Each turn re-sends everything held, so a long expansive chat uses noticeably more of your plan per turn.${ratio ? ` ${ratio}` : ''}${metering ? ` ${metering}` : ''}`;
}

/** Why a model offers no mode choice, for the one line where the selector would be. */
export function noModeReason(engine: VerseEngine, option: VerseModelOption): string {
  if (!budgetFor(option, 'standard')) return 'This model’s window is unknown, so Verse cannot offer a larger budget for it.';
  if (engine === 'grok' || engine === 'local') return 'One budget: this CLI compacts at its own fixed point, and Verse cannot raise it per chat.';
  return 'One budget: this model has no larger window to expand into.';
}

// ---------------------------------------------------------------------------
// Context fit
// ---------------------------------------------------------------------------

/** Short form for a picker row, where it sits beside the capacity words. */
export const FIT_SHORT: Record<VerseFitVerdict, string> = {
  fits: 'code fits',
  tight: 'code fits, tight',
  expansive: 'code needs expansive',
  split: 'code too big — split',
};

/** Badge text for the chosen model. */
export const FIT_LABEL: Record<VerseFitVerdict, string> = {
  fits: 'Fits',
  tight: 'Tight fit',
  expansive: 'Needs expansive',
  split: 'Split the work',
};

/** A fit reading that is a FLOOR (a root hit its file or time cap). */
export function fitIsFloor(fit: VerseContextFit): boolean {
  return fit.roots.some((r) => r.truncated);
}

/**
 * The verdict for a model IN THE MODE THE CHAT WOULD RUN IN, or null when its
 * budget is unknown (never guessed).
 *
 * `engine` is the seat's engine: the fixed prompt added to the code is that
 * CLI's estimate (context-math `sessionOverheadTokens` — ≈15k local, ≈25k
 * claude), not one flat figure. With a flat 30k a 64k local seat (compacts
 * ≈32.5k) called anything over ~2.5k tokens of code "too big — split". Null
 * falls back to the largest estimate.
 *
 * In Standard this is context-math's `fitVerdict` as is — including
 * "expansive", the suggestion that only the bigger budget holds the code. In
 * Expansive the bigger budget IS the budget, so the same thresholds are
 * applied to it: the code fits, fits tightly, or no single context on this
 * model holds it. Without this, a chat already set to Expansive would still be
 * told its code "fits tightly under ≈367k" — true of a budget it is not using.
 */
export function modelFit(
  tokens: number | null | undefined,
  option: VerseModelOption | null | undefined,
  mode: VerseContextMode,
  engine: VerseEngine | null,
): VerseFitVerdict | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return null;
  const overhead = sessionOverheadTokens(engine);
  if (resolveContextMode(option, mode) === 'expansive' && option) {
    const expansive = budgetFor(option, 'expansive')!;
    return fitVerdict(tokens, { ...option, contextWindow: expansive.contextWindow, autoCompactAt: expansive.autoCompactAt, expansive: null }, overhead);
  }
  return fitVerdict(tokens, option, overhead);
}

/**
 * The sentence under the fit badge, for the verdict `modelFit` gave in the
 * chat's mode. In Standard a tight fit also names the Expansive budget when
 * one exists, and "needs expansive" says what to do — suggestions only;
 * nothing here switches the mode.
 */
export function fitExplanation(input: {
  verdict: VerseFitVerdict;
  tokens: number;
  option: VerseModelOption;
  mode: VerseContextMode;
  floor?: boolean;
}): string {
  const amount = `${input.floor ? 'at least ' : ''}~${formatTokens(input.tokens)} tokens of tracked code`;
  const inExpansive = resolveContextMode(input.option, input.mode) === 'expansive';
  const standard = budgetFor(input.option, 'standard');
  const expansive = budgetFor(input.option, 'expansive');
  const stdCap = standard ? formatTokens(standard.autoCompactAt ?? standard.contextWindow) : null;
  const expCap = expansive ? formatTokens(expansive.autoCompactAt ?? expansive.contextWindow) : null;
  const cap = inExpansive ? expCap : stdCap;
  const budget = inExpansive ? 'Expansive budget' : 'budget';
  switch (input.verdict) {
    case 'fits':
      return `All ${amount} fits well inside this model's ${budget}${cap ? ` (compacts ≈${cap})` : ''}, with room left for the conversation.`;
    case 'tight': {
      const roomier = !inExpansive && expCap !== null && hasExpansiveMode(input.option)
        ? ` Expansive (≈${expCap}) would hold it with room to spare.`
        : '';
      return `${capitalize(amount)} fits under the ≈${cap ?? '?'} compaction point${inExpansive ? ' of the Expansive budget' : ''}, with little room for the conversation — expect it to compact if the agent reads widely.${roomier}`;
    }
    case 'expansive':
      return `${capitalize(amount)} is more than the Standard budget (≈${stdCap ?? '?'}) holds; only Expansive (≈${expCap ?? '?'}) takes it all. Switch to Expansive, or narrow the folders to the part you are changing.`;
    case 'split':
      return `${capitalize(amount)} is more than any single context on this model holds${expCap ? `, even Expansive (≈${expCap})` : ''}. Split the work: fan it out across several chats, each scoped to one folder or subsystem, or narrow this chat to the part you are changing.`;
  }
}

/**
 * How the working-set figure is made — shown once, beside the badge. Names the
 * fixed-prompt figure the verdict added, and calls it an estimate: no CLI
 * reports its base prompt before a turn has run.
 */
export function fitMethodNote(engine: VerseEngine | null): string {
  const cli = engine ? ` for ${ENGINE_CLI_NAME[engine]}` : '';
  return `Estimated from the size of tracked text files (bytes ÷ 4), plus an estimated ~${formatTokens(sessionOverheadTokens(engine))} of fixed prompt${cli} that every chat starts with. An agent rarely reads everything, so this is a ceiling, not a forecast.`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// One session's context
// ---------------------------------------------------------------------------

export interface SessionContextView {
  tokens: number;
  /** False when `tokens` is an upper bound (codex before its rollout is read). */
  exact: boolean;
  window: number | null;
  autoCompactAt: number | null;
  /** How the window is known; null when nothing says (no window, or a stored one without provenance). */
  source: VerseWindowSource | null;
  mode: VerseContextMode;
  /** The session's model has a real expansive budget on its seat. */
  hasModes: boolean;
}

/**
 * The window a session is measured against, by the precedence every surface
 * shares — runtime → the seat's CURRENT catalog budget for the model and mode
 * → what the record stored → the seat default. The precedence itself lives in
 * verse-model's `sessionContextBudget` (the context meter reads it too); this
 * only adds whether the model offers a second mode, for the panels here.
 */
export function sessionContext(session: VerseSession, seats: readonly VerseSeat[]): SessionContextView {
  const budget = sessionContextBudget(seats, session);
  return {
    tokens: Math.floor(budget.contextTokens),
    exact: budget.exact,
    window: budget.contextWindow,
    autoCompactAt: budget.autoCompactAt,
    source: budget.source,
    mode: budget.mode,
    hasModes: hasExpansiveMode(budget.option),
  };
}

/**
 * Cache-hit ratio, except when the provider reported no cache activity at all
 * — then null ("none reported"), because 0% would claim caching failed when
 * the truth is that nothing was said about it.
 */
export function reportedCacheHitRatio(usage: Pick<VerseUsage, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>): number | null {
  if (usage.cacheReadTokens <= 0 && usage.cacheCreationTokens <= 0) return null;
  return cacheHitRatio(usage);
}

export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export interface TurnContextStats {
  /** Turns with at least one context reading. */
  turns: number;
  /** Mean of each turn's context (its largest trustworthy reading); null with no turns. */
  average: number | null;
  /** Largest per-turn context seen. */
  peak: number | null;
  /** False when any counted turn had only an upper-bound reading. */
  exact: boolean;
  /** Compactions recorded in the log. */
  compactions: number;
  /** Cache-hit ratio of the most recent turn (see `reportedCacheHitRatio`). */
  lastTurnCacheHit: number | null;
}

/**
 * Context per turn from the open chat's event log.
 *
 * A turn's context is its LARGEST trustworthy reading: within one turn the
 * prompt only grows, except across a compaction, and the peak is what the
 * turn actually paid for. Exact readings (`context` events, usage frames not
 * flagged as upper bounds) win; a turn whose only reading is codex's turn
 * total contributes that total and flags the statistic as an upper bound —
 * that figure can be many times the real prompt, so it is never mixed in
 * where an exact one exists.
 */
export function turnContextStats(events: readonly VerseEvent[]): TurnContextStats {
  const perTurn = new Map<string, { exact: number | null; bound: number | null }>();
  let compactions = 0;
  let lastUsage: VerseUsage | null = null;
  const note = (turnId: string, tokens: number, exact: boolean): void => {
    if (!Number.isFinite(tokens) || tokens < 0) return;
    const entry = perTurn.get(turnId) ?? { exact: null, bound: null };
    if (exact) entry.exact = Math.max(entry.exact ?? 0, tokens);
    else entry.bound = Math.max(entry.bound ?? 0, tokens);
    perTurn.set(turnId, entry);
  };
  for (const event of events) {
    switch (event.type) {
      case 'usage':
        lastUsage = event.usage;
        note(event.turnId, event.usage.contextTokens, event.usage.contextTokensExact !== false);
        break;
      case 'context':
        if (event.turnId !== null) note(event.turnId, event.contextTokens, event.exact);
        break;
      case 'compaction':
        compactions += 1;
        break;
      default:
        break;
    }
  }
  let sum = 0;
  let peak: number | null = null;
  let exact = true;
  let turns = 0;
  for (const entry of perTurn.values()) {
    const value = entry.exact ?? entry.bound;
    if (value === null) continue;
    if (entry.exact === null) exact = false;
    turns += 1;
    sum += value;
    peak = peak === null ? value : Math.max(peak, value);
  }
  return {
    turns,
    average: turns === 0 ? null : Math.round(sum / turns),
    peak,
    exact,
    compactions,
    lastTurnCacheHit: lastUsage === null ? null : reportedCacheHitRatio(lastUsage),
  };
}

export interface IdleCacheWarning {
  idleMs: number;
  tokens: number;
  /** A local model: the cost is time, not spend. */
  local: boolean;
}

/**
 * The next turn of an idle chat re-reads its whole context uncached once the
 * provider's prompt cache has expired (CACHE_IDLE_TTL_MS). Below the fixed
 * prompt every new chat on this engine pays anyway (its estimate) there is
 * nothing worth warning about.
 */
export function idleCacheWarning(
  session: Pick<VerseSession, 'status' | 'engine'>,
  tokens: number,
  now: number,
  /**
   * When the chat last TALKED to its provider (`lastTurnActivityAt(events)`),
   * never `session.updatedAt`: a rename or mode switch moves that without
   * warming the provider's cache. Null (no turn yet / log not loaded) → no warning.
   */
  lastActivityAt: string | null,
): IdleCacheWarning | null {
  if (session.status === 'running' || lastActivityAt === null) return null;
  const last = Date.parse(lastActivityAt);
  if (!Number.isFinite(last)) return null;
  const idleMs = now - last;
  if (idleMs < CACHE_IDLE_TTL_MS || tokens < sessionOverheadTokens(session.engine)) return null;
  return { idleMs, tokens, local: session.engine === 'local' };
}

// ---------------------------------------------------------------------------
// Per-seat efficiency across sessions (Usage section)
// ---------------------------------------------------------------------------

export interface SeatEfficiencyRow {
  seatId: string;
  label: string;
  engine: VerseEngine;
  /** The seat is no longer in the roster (its sessions remain on disk). */
  retired: boolean;
  sessions: number;
  turns: number;
  /** input + cache read + cache write: every prompt token the seat was sent. */
  promptTokens: number;
  outputTokens: number;
  /** Null when the provider reported no cache activity on any of these sessions. */
  cacheHitRatio: number | null;
  compactions: number;
  expansiveSessions: number;
  /** The fullest context among these sessions right now, as a share of its window. */
  fullest: { sessionId: string; title: string; tokens: number; window: number | null; exact: boolean } | null;
}

/**
 * "Fullest" is a share of the window when both windows are known; a context
 * with a known window outranks one without (its fullness is a fact, the other
 * a size); two unknown windows compare by size.
 */
function fuller(a: NonNullable<SeatEfficiencyRow['fullest']>, b: NonNullable<SeatEfficiencyRow['fullest']>): boolean {
  if (a.window !== null && b.window !== null) return a.tokens / a.window > b.tokens / b.window;
  if (a.window !== null) return true;
  if (b.window !== null) return false;
  return a.tokens > b.tokens;
}

/**
 * Aggregate every session by seat. Ratios are computed from SUMS, never as a
 * mean of per-session ratios — a two-turn chat must not weigh as much as a
 * two-hundred-turn one. Seats with no sessions are omitted rather than shown
 * as zeros. Sorted by prompt tokens, largest first: that is where efficiency
 * matters most.
 */
export function seatEfficiency(sessions: readonly VerseSession[], seats: readonly VerseSeat[]): SeatEfficiencyRow[] {
  const bySeat = new Map<string, VerseSession[]>();
  for (const s of sessions) {
    const list = bySeat.get(s.seatId) ?? [];
    list.push(s);
    bySeat.set(s.seatId, list);
  }
  const rows: SeatEfficiencyRow[] = [];
  for (const [seatId, list] of bySeat) {
    const seat = seats.find((s) => s.id === seatId) ?? null;
    let input = 0;
    let read = 0;
    let write = 0;
    let output = 0;
    let turns = 0;
    let compactions = 0;
    let expansiveSessions = 0;
    let fullest: SeatEfficiencyRow['fullest'] = null;
    for (const s of list) {
      input += s.usage.inputTokens;
      read += s.usage.cacheReadTokens;
      write += s.usage.cacheCreationTokens;
      output += s.usage.outputTokens;
      turns += s.turnCount;
      compactions += s.compactionCount ?? 0;
      // The mode as the meter resolves it (verse-model sessionContextBudget),
      // counted before the empty-reading skip: the mode is a fact about the
      // chat, not about its reading.
      const view = sessionContext(s, seats);
      if (view.mode === 'expansive') expansiveSessions += 1;
      if (view.tokens <= 0) continue;
      const candidate = { sessionId: s.id, title: s.title, tokens: view.tokens, window: view.window, exact: view.exact };
      if (fullest === null || fuller(candidate, fullest)) fullest = candidate;
    }
    rows.push({
      seatId,
      label: seat?.label ?? seatId,
      engine: seat?.engine ?? list[0]!.engine,
      retired: seat === null,
      sessions: list.length,
      turns,
      promptTokens: input + read + write,
      outputTokens: output,
      cacheHitRatio: reportedCacheHitRatio({ inputTokens: input, cacheReadTokens: read, cacheCreationTokens: write }),
      compactions,
      expansiveSessions,
      fullest,
    });
  }
  return rows.sort((a, b) => b.promptTokens - a.promptTokens || a.label.localeCompare(b.label));
}
