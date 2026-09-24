/**
 * core/verse/verse-stream.ts — GET /api/verse/sessions/:id/events (owner B).
 *
 * A per-session SSE tail modeled on src/core/web/run-stream.ts, but fed by
 * the engine's push subscription instead of a poll loop:
 *
 *   engine.subscribe(id, fromSeq, listener)  → replay (seq > fromSeq), then live
 *
 * EVENT PROTOCOL
 *   id: <seq>            VerseEvent.seq — monotonic per session, the resume cursor.
 *                        OMITTED for transient events (V3.10: thinking-delta,
 *                        thinking-progress, progress, status), which carry the last
 *                        persisted seq and must never become the browser's
 *                        Last-Event-ID.
 *   event: <type>        VerseEvent.type (user-message, text-delta, turn-done, …)
 *   data: <json>         the whole VerseEvent, passed through sanitizePublicJson
 *   : keepalive          comment every VERSE_SSE_KEEPALIVE_MS so proxies/browsers
 *                        do not reap an idle session between turns
 *
 * RESUME (V3.10). The cursor is the larger of the `Last-Event-ID` header (the
 * browser's automatic reconnect) and a `?after=<seq>` query (a client that
 * opens a fresh EventSource after loading the session detail — EventSource
 * cannot set headers). Only events with a greater seq are replayed, served
 * from the store's seq → offset index rather than a whole-log parse. Seqs of
 * a compacted log have gaps; a cursor never needs them contiguous.
 *
 * BACK-PRESSURE (V3.10). `res.write` returning false means the socket buffer
 * is full (a slow or backgrounded tab). Transient frames are then DROPPED —
 * they are superseded within a second anyway. Persisted frames keep queueing
 * until VERSE_SSE_MAX_BUFFERED_BYTES, past which the stream is closed: the
 * client reconnects with Last-Event-ID and resumes losslessly, instead of the
 * server buffering without bound for a tab nobody is watching.
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
import { isTransientVerseEvent, type VerseEvent } from './types.js';

/** Matches the full route; loose on the id segment (VERSE_SESSION_ID_RE is the real gate). */
export const VERSE_EVENTS_PATH_RE = /^\/api\/verse\/sessions\/([^/]+)\/events$/;

/** Session ids are file-name safe by construction (the engine mints them). */
export const VERSE_SESSION_ID_RE = /^[\w.-]{1,200}$/;

export const VERSE_SSE_KEEPALIVE_MS = 15_000;
/** Queued-but-unsent bytes past which a stalled stream is closed (client resumes by cursor). */
export const VERSE_SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

function singleHeader(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? (raw[0] ?? '') : '';
  return raw ?? '';
}

function parseCursor(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d{1,15}$/.test(trimmed)) return -1;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 ? n : -1;
}

/** Last-Event-ID → the seq to resume AFTER; -1 (replay everything) when absent/invalid. */
export function parseLastEventId(req: IncomingMessage): number {
  return parseCursor(singleHeader(req, 'last-event-id'));
}

/** `?after=<seq>` → the seq to resume AFTER; -1 when absent/invalid/repeated. */
export function parseAfterQuery(req: IncomingMessage): number {
  const url = typeof req.url === 'string' ? req.url : '';
  const q = url.indexOf('?');
  if (q === -1) return -1;
  const values = new URLSearchParams(url.slice(q + 1)).getAll('after');
  return values.length === 1 ? parseCursor(values[0] ?? '') : -1;
}

/** The resume cursor: the later of the header and the query (see header). */
export function resumeCursor(req: IncomingMessage): number {
  return Math.max(parseLastEventId(req), parseAfterQuery(req));
}

/** One SSE frame. Transient events get no `id:` line (see the protocol above). */
export function formatVerseSseFrame(event: VerseEvent): string {
  const data = JSON.stringify(sanitizePublicJson(event));
  return isTransientVerseEvent(event)
    ? `event: ${event.type}\ndata: ${data}\n\n`
    : `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

export interface VerseEventsSseOptions {
  keepaliveMs?: number;
  /** Override VERSE_SSE_MAX_BUFFERED_BYTES (tests). */
  maxBufferedBytes?: number;
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
  const maxBuffered = opts.maxBufferedBytes ?? VERSE_SSE_MAX_BUFFERED_BYTES;
  /** The last write returned false and no 'drain' has come since. */
  let congested = false;
  if (typeof res.on === 'function') res.on('drain', () => { congested = false; });

  const send = (event: VerseEvent): void => {
    if (ended) return;
    const transient = isTransientVerseEvent(event);
    if (transient && congested) return; // superseded soon; never worth queueing
    try {
      const ok = res.write(formatVerseSseFrame(event));
      if (ok === false) congested = true;
    } catch {
      // Socket closed; cleanup fires on 'close'/'error'.
      return;
    }
    const buffered = typeof res.writableLength === 'number' ? res.writableLength : 0;
    if (!transient && buffered > maxBuffered) cleanup();
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

  const fromSeq = resumeCursor(req);
  try {
    const unsubscribe = engine.subscribe(id, fromSeq, send);
    // The replay itself can end the stream (a stalled socket past the buffer
    // cap) before `subscribe` returned the handle cleanup needed.
    if (ended) unsubscribe();
    else live.unsubscribe = unsubscribe;
  } catch {
    // Session vanished between the existence check and the subscription.
    cleanup();
  }
}
