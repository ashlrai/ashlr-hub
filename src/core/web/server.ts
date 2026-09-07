/**
 * core/web/server.ts — M14 local web dashboard HTTP server.
 *
 * Starts a localhost-only HTTP server bound to 127.0.0.1 ONLY. Zero new
 * runtime deps (Node http/crypto/fs/path/url builtins). No CDN — all assets
 * served from the bundled public dir.
 *
 * Security pipeline per request (in order):
 *   1. Host-header allowlist  → 403 on mismatch  (anti DNS-rebinding)
 *   2. read-session boundary  → public health/static; auth for content GET/SSE
 *   3. handleApi(...)         → true means handled, stop
 *   4. serveStatic(...)       → 404 if asset not found
 *
 * Read tickets are short-lived, HttpOnly, SameSite=Strict, HMAC-bound to the
 * current read token, and GET-scoped. Mutation routes never accept them:
 * POST /api/run is registered ONLY when opts.allowDispatch is true and remains
 * raw-token-guarded inside handleApi.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { AshlrConfig, WebServerOptions, WebServerHandle } from '../types.js';
import { handleApi, drainSseConnections, drainSseSession, invalidateWebReadCaches } from './api.js';
import { createReadProjectionWorker, type ReadProjectionReader } from './read-projections.js';
import { createReadSessionBoundary, headerValue, isAllowedHost, requestUrl, safeEqual, sendJson } from './read-session.js';
import { serveStatic } from './static.js';
import { gcRunStreams } from '../run/streaming.js';

// ---------------------------------------------------------------------------
// Host-header allowlist (anti DNS-rebinding)
// Accepts: localhost, 127.0.0.1, [::1] — with or without :port suffix.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// assetsDir: resolve the bundled SPA assets directory relative to this module.
// Works from both:
//   src/  (tsx / ts-node dev)  → <repo>/src/core/web/public
//   dist/ (compiled)           → <repo>/dist/core/web/public
//   Bun SEA binary             → set ASHLR_WEB_PUBLIC=<path/to/public>
//
// ASHLR_WEB_PUBLIC override:
//   In a Bun-compiled single-file executable, import.meta.url points to the
//   build-time source path, not a runtime-accessible location.  The binary
//   launcher (or the Tauri sidecar launch command) sets ASHLR_WEB_PUBLIC to
//   the sibling `public/` directory extracted/copied next to the binary so
//   that static assets are resolved correctly at runtime.
// ---------------------------------------------------------------------------

export function assetsDir(): string {
  // Honor an explicit override — used by the Bun SEA binary and Tauri sidecar.
  if (process.env.ASHLR_WEB_PUBLIC) {
    return process.env.ASHLR_WEB_PUBLIC;
  }
  // Fallback: import.meta.url points to this file (server.ts / server.js after build)
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), 'public');
}

// ---------------------------------------------------------------------------
// startServer
// ---------------------------------------------------------------------------

export async function startServer(
  cfg: AshlrConfig,
  opts: WebServerOptions,
  dependencies: { readProjections?: ReadProjectionReader | null } = {},
): Promise<WebServerHandle> {
  // Sweep expired/over-budget captures at process startup even when no future
  // run writes output. This is best-effort and never creates the store.
  gcRunStreams(true);
  // Separate capabilities: read authority can mint a GET-only browser ticket,
  // while the mutation token is accepted only by handleApi mutation gates.
  const sessions = createReadSessionBoundary({ onRotate: drainSseConnections, onRevokeSession: drainSseSession });
  const { readToken } = sessions;
  const token = randomBytes(32).toString('hex');
  // The production default isolates synchronous metadata aggregation from the
  // HTTP loop. Explicit null keeps injected, in-process readers available to
  // hermetic route tests; there is no runtime fallback after a worker failure.
  const readProjections = dependencies.readProjections === undefined
    ? createReadProjectionWorker(cfg)
    : dependencies.readProjections;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The EventSource client proof appears in its same-origin URL because the
    // browser API cannot set headers. Never allow it to escape in a Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Legacy index.html contains its stylesheet inline; scripts remain
    // external-only. The new console uses external assets for both.
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // ── 1. Host-header allowlist (anti DNS-rebinding) ──────────────────────
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid Host header');
      return;
    }

    const url = requestUrl(req);
    if (!url) {
      sendJson(res, 400, { error: 'invalid request URL' });
      return;
    }
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const authority = sessions.authority(req, url);

    if (sessions.handleSession(req, res, url)) return;

    // Public liveness is intentionally content-free and bounded. Operators
    // with read authority retain the richer persisted /api/health projection.
    if (path === '/api/health' && method === 'GET' && !authority) {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Static assets remain public. Every current and future proprietary API
    // GET (including SSE) is default-deny here before route dispatch.
    if (
      method === 'GET'
      && (path === '/api' || path.startsWith('/api/'))
      && !authority
    ) {
      sendJson(res, 401, { error: 'unauthorized: read session required' }, {
        Vary: 'Cookie, X-Ashlr-Token, X-Ashlr-Read-Client',
      });
      return;
    }

    // ── 2. API routes ──────────────────────────────────────────────────────
    // handleApi is async; wrap to catch errors without crashing the server.
    handleApi(req, res, cfg, {
      token,
      allowDispatch: opts.allowDispatch,
      readSession: authority?.kind === 'session' ? authority.session : undefined,
      readProjections: readProjections ?? undefined,
    })
      .then((handled) => {
        // A mutation can partially succeed and still return 409/500 (for
        // example a pause whose daemon has not quiesced yet). Invalidate after
        // every token-authorized attempt, never after an unauthenticated POST.
        if (handled && req.method === 'POST' && opts.allowDispatch
          && safeEqual(headerValue(req, 'x-ashlr-token'), token)) {
          invalidateWebReadCaches(cfg);
          // Start invalidation before another request can observe stale worker
          // caches. It only tears down readers, never starts a daemon or work.
          void readProjections?.invalidate().catch(() => {});
        }
        if (handled) return;

        // ── 3. Static assets ───────────────────────────────────────────────
        const served = serveStatic(req, res, assetsDir());
        if (!served) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
      })
      .catch(() => {
        // Never let an unhandled rejection crash the server.
        if (!res.headersSent) {
          sendJson(res, 500, { code: 'INTERNAL_ERROR', error: 'internal server error' });
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  });

  // ── Socket-level timeouts (anti slow-loris) ─────────────────────────────
  // Reap partial/stalled requests so a client trickling headers/body on the
  // loopback interface cannot tie up resources indefinitely. The readBody()
  // 64 KB cap bounds body size; these bound time. Loopback-only scope keeps
  // this low-severity, but it is cheap insurance for a server that can spawn
  // agents. Note: SSE responses are server-pushed and do not rely on the
  // client keeping the request open past header receipt.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  // ── Bind to loopback only — never 0.0.0.0 ───────────────────────────────
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to determine bound port'));
      }
    });
  }).catch(async (error: unknown) => {
    await readProjections?.close();
    throw error;
  });

  const url = `http://127.0.0.1:${port}`;

  // ── Handle object ────────────────────────────────────────────────────────
  const handle: WebServerHandle = {
    port,
    readToken,
    token,
    url,
    async close(): Promise<void> {
      await Promise.all([readProjections?.close(), new Promise<void>((resolve) => {
        // Drain all open SSE response streams registered by handleApi, then
        // close the HTTP server (stops accepting new connections).
        drainSseConnections();
        sessions.clear();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      })]);
    },
  };

  return handle;
}
