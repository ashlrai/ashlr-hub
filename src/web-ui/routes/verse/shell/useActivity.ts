/**
 * routes/verse/shell/useActivity.ts — the shell's one CURSOR loop over
 * GET /api/verse/activity (unit C1; route: core/verse/activity-api.ts).
 *
 * The rail badges, the palette's "Needs you" and running chats, the Needs-you
 * drawer and the in-app "Finished / Failed" toasts all read this ONE store,
 * so the whole shell costs one request per tick however many things show a
 * count. (The chat list polls the same route WITHOUT a cursor for its
 * present-tense view — chat/use-chat-activity.ts, C2.)
 *
 * CADENCE. Every 5 s while the window is visible, every 30 s while it is
 * hidden (the badges still need to be right when it comes back, and the tab
 * title count; C8's Rust owns native notifications). Never under the 2 s
 * floor (section-visibility MIN_POLL_INTERVAL_MS). Polls only while
 * something is subscribed.
 *
 * HONESTY. A 404 means the activity module is not in this build →
 * `unavailable`, and every badge renders "unknown" (no dot), never zero. A
 * failed poll keeps the last good data and says `stale` — a badge that
 * flashes to 0 on one dropped request would read as a false all-clear.
 *
 * COMPLETIONS arrive once per cursor; `onActivityCompletions` listeners get
 * each batch exactly once. The first poll of a page carries none (history is
 * not news).
 */
import { useSyncExternalStore } from 'react';
import type { VerseActivityCompletion, VerseActivityResponse } from '../../../../core/verse/workbench-types.js';
import { VERSE_ACTIVITY_PATH } from '../../../../core/verse/workbench-types.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { MIN_POLL_INTERVAL_MS } from './section-visibility.js';

export const ACTIVITY_POLL_VISIBLE_MS = 5_000;
export const ACTIVITY_POLL_HIDDEN_MS = 30_000;

export type ActivityStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'unavailable';

export interface ActivityState {
  status: ActivityStatus;
  data: VerseActivityResponse | null;
  /** ms epoch of the last successful poll. */
  updatedAt: number | null;
}

type Fetcher = (path: string, signal?: AbortSignal) => Promise<VerseActivityResponse>;

let fetcher: Fetcher = (path, signal) => apiGet<VerseActivityResponse>(path, signal);
let snapshot: ActivityState = { status: 'idle', data: null, updatedAt: null };
let cursor: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let subscribers = 0;
const listeners = new Set<() => void>();
const completionListeners = new Set<(batch: VerseActivityCompletion[]) => void>();

function emit(next: ActivityState): void {
  snapshot = next;
  for (const l of [...listeners]) l();
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (subscribers === 0) return;
  const every = Math.max(MIN_POLL_INTERVAL_MS, hidden() ? ACTIVITY_POLL_HIDDEN_MS : ACTIVITY_POLL_VISIBLE_MS);
  timer = setTimeout(() => {
    void refreshActivity();
  }, every);
}

/** Poll now (joins one already running). Resolves when it has settled; never rejects. */
export function refreshActivity(): Promise<void> {
  if (inFlight) return inFlight;
  if (snapshot.status === 'idle') emit({ ...snapshot, status: 'loading' });
  const path = cursor ? `${VERSE_ACTIVITY_PATH}?since=${encodeURIComponent(cursor)}` : VERSE_ACTIVITY_PATH;
  inFlight = (async () => {
    try {
      const data = await fetcher(path);
      const firstPoll = cursor === null;
      cursor = typeof data.cursor === 'string' ? data.cursor : null;
      emit({ status: 'ready', data, updatedAt: Date.now() });
      if (!firstPoll && Array.isArray(data.completions) && data.completions.length > 0) {
        for (const l of [...completionListeners]) {
          try { l(data.completions); } catch { /* a listener must not stop the loop */ }
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        emit({ status: 'unavailable', data: null, updatedAt: snapshot.updatedAt });
      } else if (err instanceof ApiError && err.status === 400 && cursor) {
        // A cursor the server no longer accepts: start over rather than stall.
        cursor = null;
        emit({ ...snapshot, status: snapshot.data ? 'stale' : 'loading' });
      } else {
        emit({ ...snapshot, status: snapshot.data ? 'stale' : 'unavailable' });
      }
    } finally {
      inFlight = null;
      schedule();
    }
  })();
  return inFlight;
}

function onVisibility(): void {
  // Back in view: catch up now rather than up to 30 s late.
  if (!hidden() && subscribers > 0) void refreshActivity();
  else schedule();
}

function start(): void {
  subscribers += 1;
  if (subscribers === 1) {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    void refreshActivity();
  }
}

function stop(): void {
  subscribers = Math.max(0, subscribers - 1);
  if (subscribers > 0) return;
  if (timer) clearTimeout(timer);
  timer = null;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    stop();
  };
}

export function getActivityState(): ActivityState {
  return snapshot;
}

/** The shell's activity. Subscribing starts the poll; the last unsubscribe stops it. */
export function useActivity(): ActivityState {
  return useSyncExternalStore(subscribe, getActivityState, getActivityState);
}

/** Each batch of newly finished turns, exactly once. Returns the unsubscribe. */
export function onActivityCompletions(listener: (batch: VerseActivityCompletion[]) => void): () => void {
  completionListeners.add(listener);
  return () => completionListeners.delete(listener);
}

/** Test seam: inject the fetch, clear state (and any timer). */
export function resetActivityForTest(next?: Fetcher): void {
  if (timer) clearTimeout(timer);
  timer = null;
  inFlight = null;
  cursor = null;
  subscribers = 0;
  listeners.clear();
  completionListeners.clear();
  fetcher = next ?? ((path, signal) => apiGet<VerseActivityResponse>(path, signal));
  snapshot = { status: 'idle', data: null, updatedAt: null };
}
