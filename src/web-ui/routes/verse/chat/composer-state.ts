/**
 * routes/verse/chat/composer-state.ts — the composer's memory, and an
 * honest estimate of what a message will cost.
 *
 * Two things a long agentic day needs from a message box and does not get
 * from a bare `useState`:
 *
 *   1. A draft survives switching chats and reloading the app. Half-written
 *      instructions are expensive to re-type and are lost today the moment
 *      ⌘K lands somewhere else.
 *   2. What was already sent can be recalled with ↑, the way every shell
 *      works, because the second attempt at a prompt is usually the first
 *      one plus a clause.
 *
 * Both are per-session and stored in `localStorage`, bounded so a long-lived
 * browser cannot accumulate an unbounded map. Every access is wrapped: a
 * private window with storage blocked still runs the app.
 */

const DRAFT_KEY = 'ashlr.verse.drafts.v1';
const SENT_KEY = 'ashlr.verse.sent.v1';

/** Sessions remembered, newest last. */
const SESSION_LIMIT = 40;
/** Messages recalled per session. */
const HISTORY_LIMIT = 25;
/** Matches VERSE_MAX_TURN_TEXT_BYTES; a draft over it cannot be sent anyway. */
const TEXT_LIMIT = 64 * 1024;

function readMap<T>(key: string, parse: (value: unknown) => T | null): Record<string, T> {
  const out: Record<string, T> = {};
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const clean = parse(value);
        if (clean !== null) out[id] = clean;
      }
    }
  } catch {
    /* storage unavailable or corrupt — an empty memory is a valid one */
  }
  return out;
}

function writeMap(key: string, map: Record<string, unknown>): void {
  // Insertion order is recency order: every write deletes before re-inserting.
  const ids = Object.keys(map);
  for (const stale of ids.slice(0, Math.max(0, ids.length - SESSION_LIMIT))) delete map[stale];
  try {
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, TEXT_LIMIT) : null;

const asHistory = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    .slice(-HISTORY_LIMIT)
    .map((v) => v.slice(0, TEXT_LIMIT));
  return list.length > 0 ? list : null;
};

/** The unsent draft for this chat, or `''`. */
export function loadDraft(sessionId: string | null | undefined): string {
  if (!sessionId) return '';
  return readMap(DRAFT_KEY, asText)[sessionId] ?? '';
}

/** Persist (or clear, when empty) the draft for this chat. */
export function saveDraft(sessionId: string | null | undefined, text: string): void {
  if (!sessionId) return;
  const map = readMap(DRAFT_KEY, asText);
  delete map[sessionId];
  if (text.trim().length > 0) map[sessionId] = text.slice(0, TEXT_LIMIT);
  writeMap(DRAFT_KEY, map);
}

/** Messages sent in this chat, oldest first. */
export function loadHistory(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  return readMap(SENT_KEY, asHistory)[sessionId] ?? [];
}

/** Record a sent message; consecutive duplicates are not stored twice. */
export function pushHistory(sessionId: string | null | undefined, text: string): void {
  if (!sessionId || text.trim().length === 0) return;
  const map = readMap(SENT_KEY, asHistory);
  const current = map[sessionId] ?? [];
  delete map[sessionId];
  const next = current[current.length - 1] === text ? current : [...current, text.slice(0, TEXT_LIMIT)];
  map[sessionId] = next.slice(-HISTORY_LIMIT);
  writeMap(SENT_KEY, map);
}

/**
 * Forget everything this chat remembered — its unsent draft and its sent
 * messages.
 *
 * Deleting a chat removes its transcript from disk, but the verbatim prompts
 * stayed in browser storage under the dead session id until forty newer
 * sessions rotated them out.
 */
export function forgetComposerMemory(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  for (const [key, parse] of [
    [DRAFT_KEY, asText],
    [SENT_KEY, asHistory],
  ] as const) {
    const map: Record<string, unknown> = readMap(key, parse as (v: unknown) => unknown);
    if (!(sessionId in map)) continue;
    delete map[sessionId];
    writeMap(key, map);
  }
}

/**
 * Drop every remembered draft and sent message, for every session.
 *
 * Called on disconnect/logout alongside the query cache's `evictAll`, whose
 * contract is that stale data must not leak into the next session's first
 * paint. Prompt text is precisely the content that wipe exists for, and it is
 * the one thing that used to survive it.
 */
export function clearComposerMemory(): void {
  for (const key of [DRAFT_KEY, SENT_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }
}

export const VERSE_DRAFT_STORAGE_KEY = DRAFT_KEY;
export const VERSE_SENT_STORAGE_KEY = SENT_KEY;

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * Characters per token. A rough English/code average, and rough is the
 * point: the real count is the provider's, which this app does not have
 * before the turn runs. Every surface that shows this figure marks it `≈`
 * and never presents it as measured (DESIGN §6, VERSE-TELEMETRY-V2).
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

export type CostTone = 'ok' | 'warn' | 'danger';

export interface CostHint {
  /** Estimated tokens for the draft itself. */
  draftTokens: number;
  /** Context occupancy this message would push the session to, as a percent. */
  projectedPercent: number;
  tone: CostTone;
}

/**
 * What sending this draft would do to the context window — or null when the
 * window is unknown, the box is empty, or the session is still comfortable.
 * The thresholds are the ContextMeter's, so the hint and the 2px line under
 * the header never disagree about when things are getting tight.
 */
export function costHint(
  text: string,
  contextTokens: number | null | undefined,
  contextWindow: number | null | undefined,
  warnPercent: number,
  dangerPercent: number,
): CostHint | null {
  const draftTokens = estimateTokens(text);
  if (draftTokens === 0) return null;
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null;
  if (window === null) return null;
  const used = typeof contextTokens === 'number' && Number.isFinite(contextTokens) ? Math.max(0, contextTokens) : 0;
  const projectedPercent = Math.min(999, Math.round(((used + draftTokens) / window) * 100));
  if (projectedPercent < warnPercent) return null;
  return {
    draftTokens,
    projectedPercent,
    tone: projectedPercent >= dangerPercent ? 'danger' : 'warn',
  };
}
