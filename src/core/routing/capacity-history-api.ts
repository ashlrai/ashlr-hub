/**
 * `GET /api/verse/budget/history` — seat window history for Command's
 * burn-downs (3.10.1; wire contract in capacity-history-types.ts, store in
 * capacity-history.ts).
 *
 *   GET /api/verse/budget/history[?days=1..14]  → CapacityHistoryResponse
 *
 * MOUNTED INSIDE the 'budget' entry of verse-api.ts: `withCapacityHistory`
 * wraps the budget module, so the route family, its mount order and the mount
 * test's module ids stay exactly as they were. The wrapper also makes the
 * Verse server a recorder:
 *   - after every successful `GET /api/verse/budget` (the read the Command
 *     surface, the capacity strip and the Fleet surface already poll) it
 *     records the snapshot that read just refreshed — throttled, after the
 *     response is written, never throwing into the request;
 *   - on first use it starts a 60 s follow of the capacity snapshot (which
 *     the server's own publisher rewrites every minute), so history keeps
 *     growing while no page polls and no daemon runs (fleet dark). Refused in
 *     test processes, like the daemon publisher.
 * Recording is idempotent across recorders: rows carry the reading's own
 * observedAt, and the store's compression rule drops a reading already
 * recorded (capacity-history.ts). ASHLR_CAPACITY_HISTORY=0 stops every
 * recorder in the store itself; this route keeps serving what exists.
 *
 * Security posture matches the budget GETs: behind server.ts's read-session
 * boundary (every GET under /api), non-GET is a 404 after verse-api's mutation
 * gate, unknown or repeated query parameters are 400s, and the body goes
 * through sendJson() → sanitizePublicJson(). The response is bounded
 * (≤ 32 series × ≤ 720 points).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ApiModule } from '../verse/api-modules.js';
import { sendJson } from '../web/api.js';
import {
  buildCapacityHistoryResponse,
  capacityHistoryDisabled,
  readCapacityHistory,
  recordCapacityHistoryFromSnapshot,
  type CapacityHistoryWriteResult,
} from './capacity-history.js';
import {
  CAPACITY_HISTORY_DEFAULT_DAYS,
  CAPACITY_HISTORY_MAX_DAYS,
  VERSE_CAPACITY_HISTORY_PATH,
} from './capacity-history-types.js';
import { VERSE_BUDGET_PATH } from './types.js';

const DAY = 86_400_000;

/** The server records at most this often from request traffic (the budget read may be polled by several pages). */
export const SERVER_RECORD_MIN_MS = 15_000;
/** The background follow's cadence — the Verse server's publisher rewrites the snapshot every 60 s. */
export const SERVER_RECORD_EVERY_MS = 60_000;

function readQuery(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query string' });
    return null;
  }
  for (const key of new Set(params.keys())) {
    if (!allowed.includes(key)) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown query parameter: ${key}` });
      return null;
    }
    if (params.getAll(key).length > 1) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `query parameter ${key} may appear only once` });
      return null;
    }
  }
  return params;
}

/** The history route. Returns false for every other path (api-modules.ts contract). */
export const handleCapacityHistoryApi: ApiModule = async (_ctx, req, res, path, method) => {
  if (path !== VERSE_CAPACITY_HISTORY_PATH) return false;
  if (method !== 'GET') {
    sendJson(res, 404, { error: `not found: ${method} ${path}` });
    return true;
  }
  const params = readQuery(req, res, ['days']);
  if (!params) return true;
  const raw = params.get('days');
  let days = CAPACITY_HISTORY_DEFAULT_DAYS;
  if (raw !== null) {
    if (!/^\d{1,2}$/.test(raw) || Number(raw) < 1 || Number(raw) > CAPACITY_HISTORY_MAX_DAYS) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `days must be a whole number from 1 to ${CAPACITY_HISTORY_MAX_DAYS}` });
      return true;
    }
    days = Number(raw);
  }
  try {
    const nowMs = Date.now();
    const rows = readCapacityHistory({ sinceMs: nowMs - days * DAY });
    sendJson(res, 200, buildCapacityHistoryResponse(rows, { nowMs, days }));
  } catch {
    sendJson(res, 500, { error: 'capacity history request failed' });
  }
  return true;
};

// ---------------------------------------------------------------------------
// Server-side recording
// ---------------------------------------------------------------------------

let lastServerRecordAt = Number.NEGATIVE_INFINITY;
let lastServerError: string | null = null;
let followTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Why this process must not start the background follow; null when it may.
 * ASHLR_CAPACITY_HISTORY=0 is enforced in the store (every recorder is a
 * no-op); refusing the follow as well just keeps an idle timer from running.
 */
export function capacityHistoryFollowRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  // Never from a test run: a timer that outlives a test would write under
  // whatever HOME the next test set.
  if (env['VITEST'] || env['NODE_ENV'] === 'test') return 'test process';
  if (capacityHistoryDisabled(env)) return 'disabled by ASHLR_CAPACITY_HISTORY=0';
  return null;
}

/**
 * Record the on-disk snapshot as the Verse server (throttled). Never throws;
 * a failure is logged once per distinct error, then stays quiet until it
 * changes or clears.
 */
export function recordServerCapacityHistory(
  nowMs: number = Date.now(),
  record: () => CapacityHistoryWriteResult = () => recordCapacityHistoryFromSnapshot(undefined, 'verse', { nowMs }),
  log: (message: string) => void = (message) => { console.warn(`[ashlr] ${message}`); },
): CapacityHistoryWriteResult | null {
  if (nowMs - lastServerRecordAt < SERVER_RECORD_MIN_MS) return null;
  lastServerRecordAt = nowMs;
  let result: CapacityHistoryWriteResult;
  try {
    result = record();
  } catch (err) {
    result = { appended: 0, compacted: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
  if (result.error !== null && result.error !== lastServerError) {
    try { log(`capacity history was not recorded (${result.error}); the burn-downs keep their in-page readings`); } catch { /* never throws */ }
  }
  lastServerError = result.error;
  return result;
}

/** Start the process-wide 60 s follow once (idempotent, never throws). True when it runs. */
export function ensureServerCapacityHistoryFollow(env: NodeJS.ProcessEnv = process.env): boolean {
  if (followTimer) return true;
  if (capacityHistoryFollowRefusal(env) !== null) return false;
  try {
    followTimer = setInterval(() => { recordServerCapacityHistory(); }, SERVER_RECORD_EVERY_MS);
    followTimer.unref?.();
    return true;
  } catch {
    followTimer = null;
    return false;
  }
}

/** Test hook: stop the follow and forget throttle and error state. */
export function resetCapacityHistoryApiForTest(): void {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
  lastServerRecordAt = Number.NEGATIVE_INFINITY;
  lastServerError = null;
}

/**
 * The 'budget' mount entry: the history route first, then the budget module
 * unchanged. A successful budget read then records the snapshot it just
 * refreshed — AFTER its response is written, so the read never waits on it.
 */
export function withCapacityHistory(budget: ApiModule): ApiModule {
  return async (ctx, req, res, path, method) => {
    if (await handleCapacityHistoryApi(ctx, req, res, path, method)) return true;
    const handled = await budget(ctx, req, res, path, method);
    if (handled && method === 'GET' && path === VERSE_BUDGET_PATH && res.statusCode === 200) {
      ensureServerCapacityHistoryFollow();
      recordServerCapacityHistory();
    }
    return handled;
  };
}
