/**
 * routes/verse/shell/nav-history.ts — ⌘[ / ⌘] through surfaces AND chats
 * (unit C1; SPEC-310C §1 "Keep-alive").
 *
 * One linear history, like a browser's: visiting a place after going back
 * drops the forward entries. A chat is a place of its own — Chat ▸ A and
 * Chat ▸ B are two entries — so "back" after jumping from one chat to another
 * returns to the first chat, not to whatever surface was before Chat.
 *
 * Pure: the ui store holds the value and decides when to push.
 */
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';

export interface NavEntry {
  section: WorkbenchSectionId;
  /** The chat open at the time; only meaningful when `section` is chat. */
  sessionId: string | null;
}

export interface NavHistory {
  entries: readonly NavEntry[];
  /** Index of the current entry; -1 only for an empty history. */
  index: number;
}

/** Bounded: a long day of switching must not grow without limit. */
export const NAV_HISTORY_LIMIT = 50;

export const EMPTY_NAV_HISTORY: NavHistory = Object.freeze({ entries: Object.freeze([]) as readonly NavEntry[], index: -1 });

function sameEntry(a: NavEntry | undefined, b: NavEntry): boolean {
  return !!a && a.section === b.section && (a.section !== 'chat' || a.sessionId === b.sessionId);
}

/** Visit `entry`: drop the forward stack, skip a no-op repeat, cap the length. */
export function pushNav(history: NavHistory, entry: NavEntry): NavHistory {
  const normalised: NavEntry = { section: entry.section, sessionId: entry.section === 'chat' ? entry.sessionId : null };
  const current = history.entries[history.index];
  if (sameEntry(current, normalised)) return history;
  // "Chat, no chat open yet" followed by the chat that then opened is ONE
  // visit: refine the entry in place (dropping any forward stack) rather
  // than leaving a back-stop that shows an empty chat.
  if (current && current.section === 'chat' && current.sessionId === null && normalised.section === 'chat') {
    const entries = [...history.entries.slice(0, history.index), normalised];
    return { entries, index: entries.length - 1 };
  }
  const kept = history.entries.slice(0, history.index + 1);
  const entries = [...kept, normalised].slice(-NAV_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

export function canGoBack(history: NavHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: NavHistory): boolean {
  return history.index >= 0 && history.index < history.entries.length - 1;
}

/** Step `delta` (−1 back, +1 forward). Null when there is nowhere to go. */
export function stepNav(history: NavHistory, delta: -1 | 1): { history: NavHistory; entry: NavEntry } | null {
  const index = history.index + delta;
  const entry = history.entries[index];
  if (!entry) return null;
  return { history: { entries: history.entries, index }, entry };
}

/**
 * ⌃Tab through recent chats: the most-recently-used list, current chat first.
 * Consecutive presses inside `windowMs` keep walking the SAME snapshot of
 * the list (the Alt-Tab rule), so ⌃Tab ⌃Tab reaches the third-most-recent
 * chat instead of bouncing between two.
 */
export interface RecentCycle {
  order: readonly string[];
  position: number;
  at: number;
}

export const RECENT_CYCLE_WINDOW_MS = 1_500;
export const RECENT_CHATS_LIMIT = 10;

export function cycleRecent(
  recent: readonly string[],
  cycle: RecentCycle | null,
  direction: 1 | -1,
  now: number,
  windowMs: number = RECENT_CYCLE_WINDOW_MS,
): { sessionId: string; cycle: RecentCycle } | null {
  const fresh = !cycle || now - cycle.at > windowMs;
  const order = fresh ? recent : cycle!.order;
  if (order.length < 2) return null;
  const from = fresh ? 0 : cycle!.position;
  const position = (from + direction + order.length) % order.length;
  return { sessionId: order[position]!, cycle: { order, position, at: now } };
}

/** Move `sessionId` to the front of the MRU list. */
export function touchRecent(recent: readonly string[], sessionId: string, limit: number = RECENT_CHATS_LIMIT): string[] {
  return [sessionId, ...recent.filter((id) => id !== sessionId)].slice(0, limit);
}
