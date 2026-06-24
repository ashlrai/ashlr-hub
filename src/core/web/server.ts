/**
 * core/web/server.ts — M14 local web dashboard HTTP server.
 *
 * Starts a localhost-only HTTP server bound to 127.0.0.1 ONLY. Zero new
 * runtime deps (Node http/crypto/fs/path/url builtins). No CDN — all assets
 * served from the bundled public dir.
 *
 * Security pipeline per request (in order):
 *   1. Host-header allowlist  → 403 on mismatch  (anti DNS-rebinding)
 *   2. handleApi(...)         → true means handled, stop
 *   3. serveStatic(...)       → 404 if asset not found
 *
 * The dispatch route (POST /api/run) is registered ONLY when
 * opts.allowDispatch is true and is token-guarded inside handleApi.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { AshlrConfig, WebServerOptions, WebServerHandle } from '../types.js';
import { handleApi, drainSseConnections } from './api.js';
import { serveStatic } from './static.js';

// ---------------------------------------------------------------------------
// Host-header allowlist (anti DNS-rebinding)
// Accepts: localhost, 127.0.0.1, [::1] — with or without :port suffix.
// ---------------------------------------------------------------------------

const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return HOST_RE.test(host);
}

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
): Promise<WebServerHandle> {
  // Per-session secret token (32 bytes → 64 hex chars). Used only when
  // allowDispatch is true, but always generated so the shape is consistent.
  const token = randomBytes(32).toString('hex');

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // ── 1. Host-header allowlist (anti DNS-rebinding) ──────────────────────
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: invalid Host header');
      return;
    }

    // ── 2. API routes ──────────────────────────────────────────────────────
    // handleApi is async; wrap to catch errors without crashing the server.
    handleApi(req, res, cfg, { token, allowDispatch: opts.allowDispatch })
      .then((handled) => {
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
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        if (!res.writableEnded) {
          res.end('Internal server error');
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
  });

  const url = `http://127.0.0.1:${port}`;

  // ── Handle object ────────────────────────────────────────────────────────
  const handle: WebServerHandle = {
    port,
    token,
    url,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Drain all open SSE response streams registered by handleApi, then
        // close the HTTP server (stops accepting new connections).
        drainSseConnections();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };

  return handle;
}
