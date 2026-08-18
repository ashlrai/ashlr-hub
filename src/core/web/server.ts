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
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { AshlrConfig, WebServerOptions, WebServerHandle } from '../types.js';
import { handleApi, drainSseConnections, drainSseSession } from './api.js';
import { ReadSessionRevocations } from './read-session-revocations.js';
import { serveStatic } from './static.js';

// ---------------------------------------------------------------------------
// Host-header allowlist (anti DNS-rebinding)
// Accepts: localhost, 127.0.0.1, [::1] — with or without :port suffix.
// ---------------------------------------------------------------------------

const HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const READ_SESSION_COOKIE = 'ashlr_read_session';
const READ_SESSION_VERSION = 'v1';
const READ_SESSION_METHOD = 'GET';
const READ_SESSION_PATH_PREFIX = '/api/';
const READ_SESSION_TTL_MS = 15 * 60 * 1000;
const READ_SESSION_FUTURE_SKEW_MS = 5_000;
const MAX_COOKIE_HEADER_BYTES = 8_192;
const MAX_READ_SESSION_BYTES = 256;
const READ_CLIENT_HEADER = 'x-ashlr-read-client';
const READ_CLIENT_QUERY = 'client';
const READ_CLIENT_RE = /^[a-f0-9]{64}$/;
const READ_SESSION_REVOCATION_CAPACITY = 64;

function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return HOST_RE.test(host);
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0] ?? '' : '';
  return raw ?? '';
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  const publicBody = body && typeof body === 'object' && 'error' in body
    ? { ...body, error: String((body as { error: unknown }).error).slice(0, 512) }
    : body;
  res.end(JSON.stringify(publicBody));
}

function clientBinding(clientProof: string): string {
  return createHash('sha256').update(clientProof, 'utf8').digest('base64url');
}

function ticketPayload(expiresAtMs: number, nonce: string, binding: string): string {
  return [
    READ_SESSION_VERSION,
    READ_SESSION_METHOD,
    READ_SESSION_PATH_PREFIX,
    String(expiresAtMs),
    nonce,
    binding,
  ].join('.');
}

function signTicketPayload(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(payload, 'utf8').digest('base64url');
}

function mintReadSession(signingKey: string, clientProof: string, nowMs = Date.now()): string {
  const payload = ticketPayload(
    nowMs + READ_SESSION_TTL_MS,
    randomBytes(16).toString('base64url'),
    clientBinding(clientProof),
  );
  return `${payload}.${signTicketPayload(payload, signingKey)}`;
}

function readClientHeader(req: IncomingMessage): string {
  const value = headerValue(req, READ_CLIENT_HEADER);
  return READ_CLIENT_RE.test(value) ? value : '';
}

/**
 * Cookie possession is not enough on loopback because cookies are host-, not
 * port-scoped. Bind normal fetches to an exact header and EventSource to one
 * exact query proof. The query proof has no authority without the signed
 * HttpOnly ticket that contains its digest.
 */
function readSessionClientProof(req: IncomingMessage, url: URL): string {
  if (url.pathname === '/api/events') {
    if (headerValue(req, READ_CLIENT_HEADER)) return '';
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== READ_CLIENT_QUERY) return '';
    const value = entries[0]?.[1] ?? '';
    return READ_CLIENT_RE.test(value) ? value : '';
  }

  // The query proof is SSE-only. Other API routes must use the exact header;
  // this also fails closed if a client parameter is duplicated or smuggled.
  if (url.searchParams.has(READ_CLIENT_QUERY)) return '';
  return readClientHeader(req);
}

/** Parse one exact cookie value. Duplicate names are ambiguous and fail closed. */
function readCookie(req: IncomingMessage, name: string): string {
  const raw = headerValue(req, 'cookie');
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_COOKIE_HEADER_BYTES) return '';

  let found = '';
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found) return '';
    const value = part.slice(separator + 1).trim();
    if (!value || Buffer.byteLength(value, 'utf8') > MAX_READ_SESSION_BYTES) return '';
    found = value;
  }
  return found;
}

interface ValidReadSession { id: string; expiresAt: number }

function validateReadSession(
  req: IncomingMessage,
  signingKey: string,
  url: URL,
  revocations: ReadSessionRevocations,
  purpose: 'read' | 'logout' = 'read',
  nowMs = Date.now(),
): ValidReadSession | null {
  const ticket = readCookie(req, READ_SESSION_COOKIE);
  if (!ticket) return null;
  const clientProof = purpose === 'logout' ? readClientHeader(req) : readSessionClientProof(req, url);
  if (!clientProof) return null;

  const parts = ticket.split('.');
  if (parts.length !== 7) return null;
  const [version, method, pathPrefix, expiresRaw, nonce, binding, signature] = parts;
  if (
    version !== READ_SESSION_VERSION
    || method !== READ_SESSION_METHOD
    || pathPrefix !== READ_SESSION_PATH_PREFIX
    || (purpose === 'read' && (req.method ?? 'GET').toUpperCase() !== method)
    || (purpose === 'read' && !url.pathname.startsWith(pathPrefix))
    || !/^\d{13}$/.test(expiresRaw ?? '')
    || !/^[A-Za-z0-9_-]{22}$/.test(nonce ?? '')
    || !/^[A-Za-z0-9_-]{43}$/.test(binding ?? '')
    || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')
  ) return null;

  const expiresAtMs = Number(expiresRaw);
  if (
    !Number.isSafeInteger(expiresAtMs)
    || expiresAtMs <= nowMs
    || expiresAtMs > nowMs + READ_SESSION_TTL_MS + READ_SESSION_FUTURE_SKEW_MS
  ) return null;

  if (!safeEqual(binding!, clientBinding(clientProof))) return null;

  const payload = ticketPayload(expiresAtMs, nonce!, binding!);
  if (!safeEqual(signature!, signTicketPayload(payload, signingKey))) return null;
  const session = {
    id: createHash('sha256').update(ticket, 'utf8').digest('hex'),
    expiresAt: expiresAtMs,
  };
  return revocations.isRevoked(session.id, nowMs) ? null : session;
}

type ReadAuthority = { kind: 'header' } | { kind: 'session'; session: ValidReadSession };
function readAuthority(
  req: IncomingMessage,
  token: string,
  signingKey: string,
  url: URL,
  revocations: ReadSessionRevocations,
): ReadAuthority | null {
  if (safeEqual(headerValue(req, 'x-ashlr-token'), token)) return { kind: 'header' };
  const session = validateReadSession(req, signingKey, url, revocations);
  return session ? { kind: 'session', session } : null;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
  // The dashboard is intentionally plain HTTP on loopback, so a Secure cookie
  // would never be returned by browsers. Do not infer TLS from forwarded
  // headers: this server has no trusted-proxy mode. SameSite=Strict plus the
  // secret custom header on session creation prevents cross-site bootstrap.
  return `${READ_SESSION_COOKIE}=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
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
  // Separate capabilities: read authority can mint a GET-only browser ticket,
  // while the mutation token is accepted only by handleApi mutation gates.
  const readToken = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  let readSessionSigningKey = randomBytes(32).toString('hex');
  const readSessionRevocations = new ReadSessionRevocations(READ_SESSION_REVOCATION_CAPACITY);

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
    const authority = readAuthority(
      req,
      readToken,
      readSessionSigningKey,
      url,
      readSessionRevocations,
    );

    // Exchange the raw operator token for a short-lived, read-only browser
    // session. The ticket is HMAC-bound to this server process and cannot be
    // used by any mutation route, which still requires the raw header.
    if (path === '/api/session') {
      if (method === 'POST') {
        if (!safeEqual(headerValue(req, 'x-ashlr-token'), readToken)) {
          sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
          return;
        }
        if (url.search || !readClientHeader(req)) {
          sendJson(res, 400, { error: 'invalid read client proof' });
          return;
        }
        const ticket = mintReadSession(readSessionSigningKey, readClientHeader(req));
        sendJson(res, 204, undefined, {
          'Set-Cookie': sessionCookie(ticket, Math.floor(READ_SESSION_TTL_MS / 1000)),
        });
        return;
      }
      if (method === 'DELETE') {
        const session = !url.search
          ? validateReadSession(
              req,
              readSessionSigningKey,
              url,
              readSessionRevocations,
              'logout',
            )
          : null;
        if (!session) {
          sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
          return;
        }
        const revocation = readSessionRevocations.revoke(session);
        if (revocation.rotateSigningKey) {
          // Capacity exhaustion must never resurrect an evicted ticket. Rotate
          // the independent signer synchronously and drain all old streams;
          // the stable raw read token can still mint fresh tickets afterward.
          readSessionSigningKey = randomBytes(32).toString('hex');
          readSessionRevocations.clear();
          drainSseConnections();
        } else {
          drainSseSession(session.id);
        }
        sendJson(res, 204, undefined, {
          'Set-Cookie': sessionCookie('', 0),
        });
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST, DELETE' });
      return;
    }

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
    })
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
  });

  const url = `http://127.0.0.1:${port}`;

  // ── Handle object ────────────────────────────────────────────────────────
  const handle: WebServerHandle = {
    port,
    readToken,
    token,
    url,
    close(): Promise<void> {
      return new Promise((resolve) => {
        // Drain all open SSE response streams registered by handleApi, then
        // close the HTTP server (stops accepting new connections).
        drainSseConnections();
        readSessionRevocations.clear();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve());
      });
    },
  };

  return handle;
}
