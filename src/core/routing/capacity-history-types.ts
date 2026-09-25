/**
 * Seat capacity history — the wire contract (3.10.1). BROWSER-SAFE: types
 * and constants only, so the Command surface can import them without pulling
 * node:fs into the web bundle. The store is core/routing/capacity-history.ts;
 * the route is core/routing/capacity-history-api.ts.
 *
 *   GET /api/verse/budget/history[?days=1..14]  → CapacityHistoryResponse
 *
 * WHY: the weekly burn-downs on Command need the whole window, but
 * capacity.json holds only the latest snapshot and the budget route serves
 * one reading per seat. Every snapshot publish (the Verse server's, or the
 * daemon's when no Verse server runs) now also appends to a small rolling
 * log beside capacity.json, and this route serves it back per seat.
 */

export const VERSE_CAPACITY_HISTORY_PATH = '/api/verse/budget/history';
export const CAPACITY_HISTORY_DEFAULT_DAYS = 8;
export const CAPACITY_HISTORY_MAX_DAYS = 14;

/** The two account windows a burn-down draws (headroom.ts SeatWindowClass minus per-model windows, which never bind). */
export type CapacityHistoryWindow = 'session' | 'weekly';

/** Which process recorded the row: the Verse server, or the standing daemon. */
export type CapacityHistorySource = 'daemon' | 'verse';

/** One persisted row — one line of ~/.ashlr/routing/capacity-history.jsonl. */
export interface CapacityHistoryRow {
  /** When the provider window was READ (the seat's observedAt), ISO, second precision. */
  ts: string;
  /** Budget seat id (BUDGET_SEAT_ID_RE). */
  seat: string;
  window: CapacityHistoryWindow;
  /** Percent of the window used, 0–100, one decimal — the peak account window of this class, exactly as headroom.ts reads it. */
  usedPct: number;
  /** The window's machine reset, when the provider publishes one (never for Claude). */
  resetsAt: string | null;
  source: CapacityHistorySource;
}

/** One seat window's readings, oldest first. */
export interface CapacityHistorySeries {
  seatId: string;
  window: CapacityHistoryWindow;
  /**
   * `[epoch ms, percent used]`, oldest first. Interior points of a flat run
   * are dropped (its first and last reading draw the same line), and a
   * series longer than the response bound is thinned evenly — first and last
   * points always kept.
   */
  points: Array<[number, number]>;
  /** The newest row's machine reset, when known. */
  resetsAt: string | null;
  /** True when the series was thinned to fit the response bound. */
  thinned: boolean;
}

export interface CapacityHistoryResponse {
  v: 1;
  generatedAt: string;
  /** The window asked for, in days. */
  days: number;
  /** generatedAt − days: nothing older is served. */
  since: string;
  /** The oldest row served, across every series; null when there is none. */
  oldestAt: string | null;
  series: CapacityHistorySeries[];
  /** True when series were dropped to fit the response bound. */
  truncated: boolean;
}
