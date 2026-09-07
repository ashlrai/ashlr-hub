import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ReadSessionRevocations } from './read-session-revocations.js';

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

/**
 * Paths where a browser EventSource connects directly (no custom headers
 * possible) and therefore must be allowed to prove its session via the
 * `?client=` query param instead of the `x-ashlr-read-client` header.
 * Deliberately as loose on the id segment as src/core/web/run-stream.ts's
 * own RUN_EVENTS_PATH_RE — this only decides eligibility for query-proof
 * auth, not run-id safety; run-stream.ts's RUN_ID_RE is the actual gate
 * before any fs path is built, and a malformed id here still ends up 400ed
 * by that route once request auth clears this boundary.
 */
const SSE_RUN_EVENTS_PATH_RE = /^\/api\/run\/[^/]+\/events$/;

function isSseQueryProofPath(pathname: string): boolean {
  return pathname === '/api/events' || SSE_RUN_EVENTS_PATH_RE.test(pathname);
}

export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return HOST_RE.test(host);
}

export function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0] ?? '' : '';
  return raw ?? '';
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
}

export function sendJson(
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
  if (isSseQueryProofPath(url.pathname)) {
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
  cookieName = READ_SESSION_COOKIE,
): ValidReadSession | null {
  const ticket = readCookie(req, cookieName);
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

export type ReadAuthority = { kind: 'header' } | { kind: 'session'; session: ValidReadSession };
function readAuthority(
  req: IncomingMessage,
  token: string,
  signingKey: string,
  url: URL,
  revocations: ReadSessionRevocations,
  cookieName = READ_SESSION_COOKIE,
): ReadAuthority | null {
  if (safeEqual(headerValue(req, 'x-ashlr-token'), token)) return { kind: 'header' };
  const session = validateReadSession(req, signingKey, url, revocations, 'read', Date.now(), cookieName);
  return session ? { kind: 'session', session } : null;
}

function sessionCookie(value: string, maxAgeSeconds: number, cookieName = READ_SESSION_COOKIE): string {
  // The dashboard is intentionally plain HTTP on loopback, so a Secure cookie
  // would never be returned by browsers. Do not infer TLS from forwarded
  // headers: this server has no trusted-proxy mode. SameSite=Strict plus the
  // secret custom header on session creation prevents cross-site bootstrap.
  return `${cookieName}=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}


export interface ReadSessionBoundary {
  readonly readToken: string;
  authority(req: IncomingMessage, url: URL): ReadAuthority | null;
  handleSession(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  clear(): void;
}

/** Shared protocol; independent instances never share ticket-signing or revocation state. */
export function createReadSessionBoundary(options: {
  cookieName?: string;
  onRevokeSession?: (id: string) => void;
  onRotate?: () => void;
} = {}): ReadSessionBoundary {
  const cookieName = options.cookieName ?? READ_SESSION_COOKIE;
  if (!/^[A-Za-z0-9_]{1,80}$/.test(cookieName)) throw new Error('Invalid read-session cookie name');
  const readToken = randomBytes(32).toString('hex');
  let signingKey = randomBytes(32).toString('hex');
  const revocations = new ReadSessionRevocations(READ_SESSION_REVOCATION_CAPACITY);
  return {
    readToken,
    authority: (req, url) => readAuthority(req, readToken, signingKey, url, revocations, cookieName),
    handleSession(req, res, url) {
      if (url.pathname !== '/api/session') return false;
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'POST') {
        if (!safeEqual(headerValue(req, 'x-ashlr-token'), readToken)) {
          sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
          return true;
        }
        if (url.search || !readClientHeader(req)) {
          sendJson(res, 400, { error: 'invalid read client proof' });
          return true;
        }
        const ticket = mintReadSession(signingKey, readClientHeader(req));
        sendJson(res, 204, undefined, {
          'Set-Cookie': sessionCookie(ticket, Math.floor(READ_SESSION_TTL_MS / 1000), cookieName),
        });
        return true;
      }
      if (method === 'DELETE') {
        const session = !url.search
          ? validateReadSession(req, signingKey, url, revocations, 'logout', Date.now(), cookieName) : null;
        if (!session) {
          sendJson(res, 401, { code: 'SESSION_REQUIRED', error: 'valid read session required' });
          return true;
        }
        const revoked = revocations.revoke(session);
        if (revoked.rotateSigningKey) {
          signingKey = randomBytes(32).toString('hex');
          revocations.clear();
          options.onRotate?.();
        } else options.onRevokeSession?.(session.id);
        sendJson(res, 204, undefined, { 'Set-Cookie': sessionCookie('', 0, cookieName) });
        return true;
      }
      sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST, DELETE' });
      return true;
    },
    clear() {
      revocations.clear();
      signingKey = randomBytes(32).toString('hex');
    },
  };
}
