/**
 * data/sse.ts — the live channel. One EventSource against /api/events for
 * the whole app, fanning out NAMED events (see api.ts handleSseEvents:
 * 'runs' | 'swarms' | 'inbox' | 'daemon' | 'daemon-observation' |
 * 'fleet-activity-ping' | 'fleet-activity-observation' | 'snapshot') to
 * subscribers, and invalidating the matching cache key so any mounted
 * useQuery(key) re-fetches in the background.
 *
 * The server polls disk at a fixed interval (api.ts SSE_POLL_MS, ~1.5s at
 * time of writing) — that is the real latency floor for "live". This layer
 * does not, and should not, try to beat that; it just makes sure the UI
 * never polls MORE often than the server already pushes.
 */
import { getReadClientProof, getAuthSnapshot, subscribeAuth } from './auth-store.js';
import { invalidate } from './cache.js';

export const SSE_EVENT_NAMES = [
  'runs',
  'swarms',
  'inbox',
  'daemon',
  'daemon-observation',
  'fleet-activity-ping',
  'fleet-activity-observation',
  'snapshot',
] as const;
export type SseEventName = (typeof SSE_EVENT_NAMES)[number];

/** Cache keys (see data/queries.ts) invalidated when a given SSE event fires. */
const EVENT_TO_CACHE_KEYS: Record<SseEventName, string[]> = {
  runs: ['runs'],
  swarms: ['swarms'],
  inbox: ['inbox'],
  daemon: ['daemon'],
  'daemon-observation': ['daemon'],
  'fleet-activity-ping': ['fleet-activity'],
  'fleet-activity-observation': ['fleet-activity'],
  snapshot: ['dashboard-snapshot'],
};

type RawListener = (payload: unknown) => void;
const rawListeners = new Map<SseEventName, Set<RawListener>>();

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

function backoffMs(): number {
  // 1s, 2s, 4s, 8s, capped at 15s — the server's own poll floor is ~1.5s so
  // there is no benefit reconnecting faster than that even on attempt 0.
  return Math.min(1000 * 2 ** reconnectAttempt, 15_000);
}

function teardown(): void {
  if (source) {
    source.close();
    source = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, backoffMs());
}

function connect(): void {
  if (getAuthSnapshot().phase !== 'authenticated') return;
  teardown();

  const url = `/api/events?client=${encodeURIComponent(getReadClientProof())}`;
  const es = new EventSource(url, { withCredentials: true });
  source = es;

  es.onopen = () => {
    reconnectAttempt = 0;
  };

  for (const name of SSE_EVENT_NAMES) {
    es.addEventListener(name, (evt) => {
      const messageEvent = evt as MessageEvent<string>;
      let payload: unknown = undefined;
      try {
        payload = JSON.parse(messageEvent.data);
      } catch {
        payload = undefined;
      }
      for (const key of EVENT_TO_CACHE_KEYS[name]) invalidate(key);
      const listeners = rawListeners.get(name);
      if (listeners) for (const l of listeners) l(payload);
    });
  }

  es.onerror = () => {
    // EventSource auto-retries on its own, but its built-in retry delay is
    // opaque and can hammer a server that just lost its read session. Close
    // it and drive reconnection ourselves so we stop entirely once
    // auth-store reports the session as expired (see the subscribeAuth
    // wiring at the bottom of this file).
    es.close();
    if (source === es) source = null;
    if (getAuthSnapshot().phase === 'authenticated') scheduleReconnect();
  };
}

/** Subscribe to one named SSE event's raw payload (rarely needed directly —
 * most views should prefer useQuery + the cache-key mapping above). */
export function onSseEvent(name: SseEventName, listener: RawListener): () => void {
  let set = rawListeners.get(name);
  if (!set) {
    set = new Set();
    rawListeners.set(name, set);
  }
  set.add(listener);
  return () => set!.delete(listener);
}

// Connect once authenticated; disconnect the instant the session drops so a
// stale connection never masks a 401 the rest of the app needs to react to.
subscribeAuth(() => {
  const phase = getAuthSnapshot().phase;
  if (phase === 'authenticated') {
    reconnectAttempt = 0;
    connect();
  } else {
    teardown();
  }
});
