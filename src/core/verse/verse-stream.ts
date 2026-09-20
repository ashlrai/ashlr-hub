/**
 * core/verse/verse-stream.ts — GET /api/verse/sessions/:id/events (owner B).
 *
 * A per-session SSE tail modeled on src/core/web/run-stream.ts, but fed by
 * the engine's push subscription instead of a poll loop:
 *
 *   engine.subscribe(id, fromSeq, listener)  → replay (seq > fromSeq), then live
 *
 * EVENT PROTOCOL
 *   id: <seq>            VerseEvent.seq — monotonic per session, the resume cursor
 *   event: <type>        VerseEvent.type (user-message, text-delta, turn-done, …)
 *   data: <json>         the whole VerseEvent, passed through sanitizePublicJson
 *   : keepalive          comment every VERSE_SSE_KEEPALIVE_MS so proxies/browsers
 *                        do not reap an idle session between turns
 *
 * Unlike a run stream, a session stream never ends on its own — a session
 * outlives its turns. It closes on client disconnect, read-session expiry,
 * server drain (shared registry with /api/events), or session deletion.
 *
 * SECURITY
 *  - Read-only. `id` is validated against VERSE_SESSION_ID_RE before it
 *    reaches the engine (which builds file paths from it).
 *  - Every payload passes through sanitizePublicJson() like every other SSE
 *    route (secret-shaped strings scrubbed, home paths redacted).
 *  - Shares the /api/events connection cap (registerSse / deregisterSse).
 *  - Auth: the read-session boundary in server.ts (plus the EventSource
 *    query-proof allowance in read-session.ts) runs before this handler.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizePublicJson } from '../util/public-json.js';
import { registerSse, deregisterSse, sseConnectionCapReached, sendJson } from '../web/api.js';
import type { VerseEngineHandle } from './session-engine.js';
import type { VerseEvent } from './types.js';

/** Matches the full route; loose on the id segment (VERSE_SESSION_ID_RE is the real gate). */
export const VERSE_EVENTS_PATH_RE = /^\/api\/verse\/sessions\/([^/]+)\/events$/;

/** Session ids are file-name safe by construction (the engine mints them). */
export const VERSE_SESSION_ID_RE = /^[\w.-]{1,200}$/;

export const VERSE_SSE_KEEPALIVE_MS = 15_000;

function singleHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? (raw[0] ?? '') : '';
  return raw ?? '';
}

/** Last-Event-ID → the seq to resume AFTER; -1 (replay everything) when absent/invalid. */
export function parseLastEventId(req: IncomingMessage): number {
  const raw = singleHeader(req, 'last-event-id').trim();
  if (!raw) return -1;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}

export interface VerseEventsSseOptions {
  keepaliveMs?: number;
}

/**
 * Handle GET /api/verse/sessions/:id/events. Synchronous entry point; the
 * stream lives until the client disconnects, the read session expires, or
 * the server drains SSE connections.
 */
export function handleVerseEventsSse(
  req: IncomingMessage,
  res: ServerResponse,
  engine: VerseEngineHandle,
  rawId: string,
  readSession: { id: string; expiresAt: number },
  opts: VerseEventsSseOptions = {},
): void {
  if (!VERSE_SESSION_ID_RE.test(rawId)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid session id' });
    return;
  }
  const id = rawId;

  if (!engine.getSession(id)) {
    sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: `session not found: ${id}` });
    return;
  }

  if (sseConnectionCapReached()) {
    sendJson(res, 503, { error: 'too many live connections' });
    return;
  }

  let cleanup: () => void = () => {};
  if (typeof res.on === 'function') res.on('error', () => cleanup());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  try {
    res.write(': connected\n\n');
  } catch {
    return; // Socket already gone.
  }

  let ended = false;

  const send = (event: VerseEvent): void => {
    if (ended) return;
    try {
      const line = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(sanitizePublicJson(event))}\n\n`;
      res.write(line);
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
    }
  };

  const keepalive = (): void => {
    if (ended) return;
    try {
      res.write(': keepalive\n\n');
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
    }
  };

  // Filled in after `cleanup` is defined (it must exist before registerSse);
  // a holder object keeps every field optional-and-safe if cleanup fires
  // early, without a TDZ hazard.
  const live: {
    unsubscribe?: () => void;
    keepaliveTimer?: ReturnType<typeof setInterval>;
    expiryTimer?: ReturnType<typeof setTimeout>;
    sseId?: string;
  } = {};

  cleanup = (): void => {
    if (ended) return;
    ended = true;
    if (live.unsubscribe) {
      try { live.unsubscribe(); } catch { /* best effort */ }
    }
    if (live.keepaliveTimer !== undefined) clearInterval(live.keepaliveTimer);
    if (live.expiryTimer !== undefined) clearTimeout(live.expiryTimer);
    if (live.sseId !== undefined) deregisterSse(live.sseId);
    try {
      res.end();
    } catch {
      // Already ended.
    }
  };

  // Register BEFORE subscribing so a drain during replay is honored.
  live.sseId = registerSse(cleanup, readSession.id);
  live.expiryTimer = setTimeout(cleanup, Math.max(0, readSession.expiresAt - Date.now()));
  live.keepaliveTimer = setInterval(keepalive, Math.max(1_000, opts.keepaliveMs ?? VERSE_SSE_KEEPALIVE_MS));

  req.on('close', cleanup);
  req.on('error', cleanup);

  const fromSeq = parseLastEventId(req);
  try {
    live.unsubscribe = engine.subscribe(id, fromSeq, send);
  } catch {
    // Session vanished between the existence check and the subscription.
    cleanup();
  }
}
