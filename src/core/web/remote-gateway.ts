/**
 * Dormant phone gateway HTTP adapter. No production startup path imports/calls
 * startRemoteReadGateway; Tunnel must target this listener, never Hub's :7777.
 * The browser receives a separate, short-lived device session. Hub's read
 * token and its read-session cookie stay exclusively on the loopback hop.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteAccessVerifier, parseRemoteAccessConfig, verifyRemoteAccessHeader, type RemoteAccessConfig, type RemoteAccessIdentity } from './remote-access.js';
import { checkRemoteEnvelope, classifyRemoteRoute } from './remote-gateway-policy.js';
import type { RemoteDeviceStore } from './remote-device-store.js';
import { serveStatic } from './static.js';

const COOKIE_NAME = '__Host-ashlr-remote';
const SESSION_MS = 15 * 60_000;
// A single session detail can contain 5,000 events; retain a hard bound while
// allowing a real long-running chat to load on the phone.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SSE_CHUNK_BYTES = 1024 * 1024;
const REMOTE_MARKER = '<meta name="ashlr-remote-gateway" content="v1">';
type AccessVerifier = ReturnType<typeof createRemoteAccessVerifier>;

export interface RemoteReadGatewayOptions {
  access: RemoteAccessConfig;
  hub: { port: number; readToken: string };
  devices: RemoteDeviceStore;
  /** Bundled web public dir. Assets stay off until the remote client is ready. */
  assetsDir?: string;
  mobileAssetsEnabled?: boolean;
  port?: number;
  /** Test-only pinned local JWKS verifier. Production derives it from access. */
  verifier?: AccessVerifier;
  now?: () => number;
}

interface DeviceSession { deviceId: string; subject: string; expiresAt: number; csrf: string }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function cookieValue(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) return null;
  const matches = header.split(';').map((piece) => piece.trim()).filter((piece) => piece.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function staticPath(path: string): boolean {
  return path === '/verse/m' || path === '/verse/m/' || path === '/verse/m/sw.js'
    || /^\/next\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|svg|png|webp|woff2?)$/.test(path)
    || /^\/next\/verse-m\/(?:manifest\.webmanifest|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon\.png)$/.test(path);
}

/** Starting this module requires a fully provisioned config and local Hub. */
export async function startRemoteReadGateway(options: RemoteReadGatewayOptions) {
  const config = parseRemoteAccessConfig(options.access);
  if (!config) throw new Error('Invalid remote Access configuration');
  if (!Number.isInteger(options.hub.port) || options.hub.port < 1 || options.hub.port > 65535
    || !/^[a-f0-9]{64}$/.test(options.hub.readToken)) throw new Error('Invalid local Hub read authority');
  const verify = options.verifier ?? createRemoteAccessVerifier(config);
  const now = options.now ?? Date.now;
  const hubOrigin = `http://127.0.0.1:${options.hub.port}`;
  const sessions = new Map<string, DeviceSession>();
  const streams = new Map<ServerResponse, { deviceId: string; close: () => void }>();
  const localClient = randomBytes(32).toString('hex');
  let localCookie = '';
  let localCookieUntil = 0;
  let localCookiePending: Promise<boolean> | null = null;

  async function localReadSession(): Promise<boolean> {
    if (localCookie && localCookieUntil > now() + 30_000) return true;
    if (localCookiePending) return localCookiePending;
    localCookiePending = (async () => {
      try {
        const response = await fetch(`${hubOrigin}/api/session`, { method: 'POST', redirect: 'manual',
          headers: { host: `127.0.0.1:${options.hub.port}`, 'x-ashlr-token': options.hub.readToken, 'x-ashlr-read-client': localClient },
          signal: AbortSignal.timeout(5_000),
        });
        const ticket = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
        if (response.status !== 204 || !/^ashlr_read_session=[A-Za-z0-9_.-]{50,300}$/.test(ticket)) return false;
        localCookie = ticket;
        localCookieUntil = now() + 14 * 60_000;
        return true;
      } catch { return false; }
    })();
    try { return await localCookiePending; } finally { localCookiePending = null; }
  }

  function liveSession(req: IncomingMessage, identity: RemoteAccessIdentity): DeviceSession | null {
    for (const [key, value] of sessions) if (value.expiresAt <= now()) sessions.delete(key);
    const value = cookieValue(req);
    const session = value ? sessions.get(hash(value)) : undefined;
    if (!session || session.expiresAt <= now() || session.subject !== identity.subject) return null;
    // Fresh disk read detects revocation by another process, not just our listener.
    return options.devices.getActive(session.deviceId, identity.subject) ? session : null;
  }

  const server = createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    void (async () => {
      const envelope = checkRemoteEnvelope(req, config.publicOrigin);
      if (!envelope.ok) { json(res, 403, { code: 'REMOTE_ENVELOPE_DENIED', error: 'Remote request denied' }); return; }
      const identity = await verifyRemoteAccessHeader(req.headers, verify);
      if (!identity || identity.expiresAt <= now()) { json(res, 401, { code: 'ACCESS_REQUIRED', error: 'Cloudflare Access authentication required' }); return; }
      const session = liveSession(req, identity);
      const target = req.url ?? '';
      if (req.method === 'GET' && target === '/remote/session') {
        if (!session) { json(res, 200, { authenticated: false, capabilities: { writes: false, pairing: false } }); return; }
        const device = options.devices.getActive(session.deviceId, identity.subject);
        if (!device) { json(res, 401, { code: 'DEVICE_REVOKED', error: 'Device unavailable' }); return; }
        json(res, 200, { authenticated: true, deviceId: device.id, label: device.label, scopes: device.scopes,
          csrfToken: session.csrf, expiresAt: Math.min(session.expiresAt, identity.expiresAt), capabilities: { writes: false, pairing: false } });
        return;
      }
      if (!session) { json(res, 401, { code: 'DEVICE_SESSION_REQUIRED', error: 'Device authentication required' }); return; }
      if (req.method !== 'GET') { json(res, 404, { code: 'ROUTE_DENIED', error: 'Route unavailable' }); return; }
      const route = classifyRemoteRoute(req.method, target);
      if (route.kind === 'deny') {
        const path = target.split('?')[0] ?? '';
        if (!options.mobileAssetsEnabled || !options.assetsDir || !staticPath(path) || target !== path) {
          json(res, 404, { code: 'ROUTE_DENIED', error: 'Route unavailable' }); return;
        }
        if (path === '/verse/m' || path === '/verse/m/') {
          try {
            const html = readFileSync(join(options.assetsDir, 'next', 'index.html'), 'utf8');
            if (!html.includes('<head>') || !html.includes('</head>') || !html.includes('name="ashlr-remote-gateway"')) {
              const body = html.replace('<head>', `<head>${REMOTE_MARKER}`);
              if (body !== html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); return; }
            }
          } catch { /* missing build stays denied */ }
          json(res, 503, { code: 'REMOTE_ASSETS_UNAVAILABLE', error: 'Mobile assets unavailable' }); return;
        }
        if (!serveStatic(req, res, options.assetsDir)) json(res, 404, { code: 'ROUTE_DENIED', error: 'Route unavailable' });
        return;
      }
      if (route.kind === 'stream' && !(await localReadSession())) {
        json(res, 503, { code: 'HUB_READ_UNAVAILABLE', error: 'Local read session unavailable' }); return;
      }
      const controller = new AbortController();
      const onClose = () => controller.abort();
      res.once('close', onClose);
      const upstreamTarget = route.kind === 'stream'
        ? `${target}${target.includes('?') ? '&' : '?'}client=${localClient}` : target;
      const upstreamHeaders: Record<string, string> = route.kind === 'stream'
        ? { cookie: localCookie } : { 'x-ashlr-token': options.hub.readToken };
      if (route.kind === 'stream') {
        const deadline = Math.min(session.expiresAt, identity.expiresAt);
        const close = () => { controller.abort(); if (!res.writableEnded) res.end(); };
        const timer = setTimeout(close, Math.max(1, deadline - now()));
        const poll = setInterval(() => {
          try { if (!options.devices.getActive(session.deviceId, identity.subject)) close(); }
          catch { close(); }
        }, 1_000);
        streams.set(res, { deviceId: session.deviceId, close });
        res.once('close', () => { clearTimeout(timer); clearInterval(poll); streams.delete(res); });
      }
      try {
        const upstream = await fetch(`${hubOrigin}${upstreamTarget}`, { headers: upstreamHeaders, redirect: 'manual', signal: controller.signal });
        if (upstream.status >= 300 && upstream.status < 400) {
          json(res, 502, { code: 'HUB_BAD_RESPONSE', error: 'Local Hub refused read' }); return;
        }
        if (route.kind === 'read') {
          const type = upstream.headers.get('content-type') ?? '';
          if (!type.startsWith('application/json')) { json(res, 502, { code: 'HUB_BAD_RESPONSE', error: 'Local Hub returned unexpected content' }); return; }
          const size = Number(upstream.headers.get('content-length') ?? '0');
          if (size > MAX_JSON_BYTES) { json(res, 502, { code: 'HUB_BAD_RESPONSE', error: 'Local Hub response too large' }); return; }
          const bytes = Buffer.from(await upstream.arrayBuffer());
          if (bytes.length > MAX_JSON_BYTES || bytes.includes(options.hub.readToken)) {
            json(res, 502, { code: 'HUB_BAD_RESPONSE', error: 'Local Hub response rejected' }); return;
          }
          res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(bytes); return;
        }
        if (upstream.status === 401) { localCookie = ''; localCookieUntil = 0; }
        if (upstream.status !== 200 || !upstream.headers.get('content-type')?.startsWith('text/event-stream') || !upstream.body) {
          json(res, 502, { code: 'HUB_BAD_RESPONSE', error: 'Local Hub stream unavailable' }); return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        // Hold a token-length tail, preventing a credential split across frames
        // from reaching the browser. Content is untrusted and may contain it.
        let pending = Buffer.alloc(0);
        for await (const chunk of upstream.body) {
          if (controller.signal.aborted || res.writableEnded) break;
          if (chunk.byteLength > MAX_SSE_CHUNK_BYTES) { controller.abort(); break; }
          pending = Buffer.concat([pending, Buffer.from(chunk)]);
          if (pending.includes(options.hub.readToken)) { controller.abort(); break; }
          const safeLength = pending.length - options.hub.readToken.length + 1;
          if (safeLength > 0) {
            const writable = res.write(pending.subarray(0, safeLength));
            pending = pending.subarray(safeLength);
            if (!writable) await new Promise<void>((resolve) => {
              const done = () => { res.off('drain', done); controller.signal.removeEventListener('abort', done); resolve(); };
              res.once('drain', done);
              controller.signal.addEventListener('abort', done, { once: true });
            });
          }
        }
        if (!controller.signal.aborted && !pending.includes(options.hub.readToken) && !res.writableEnded) res.write(pending);
        if (!res.writableEnded) res.end();
      } catch {
        if (!res.headersSent && !res.writableEnded) json(res, 502, { code: 'HUB_UNAVAILABLE', error: 'Local Hub unavailable' });
        else if (!res.writableEnded) res.end();
      } finally { res.off('close', onClose); }
    })().catch(() => { if (!res.headersSent) json(res, 500, { code: 'REMOTE_ERROR', error: 'Remote gateway error' }); else res.end(); });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  const offRevoke = options.devices.onRevoked((deviceId) => {
    for (const [key, session] of sessions) if (session.deviceId === deviceId) sessions.delete(key);
    for (const stream of streams.values()) if (stream.deviceId === deviceId) stream.close();
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); }
  catch (error) { offRevoke(); throw error; }
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** Internal only: caller must first complete a verified WebAuthn login. */
    issueDeviceSession(identity: RemoteAccessIdentity, deviceId: string) {
      if (identity.expiresAt <= now() || !config.allowedSubjects.includes(identity.subject)
        || !options.devices.getActive(deviceId, identity.subject)) return null;
      const secret = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(identity.expiresAt, now() + SESSION_MS);
      // One live browser session per device. Renewal replaces the old ticket.
      for (const [key, value] of sessions) if (value.expiresAt <= now()
        || (value.deviceId === deviceId && value.subject === identity.subject)) sessions.delete(key);
      sessions.set(hash(secret), { subject: identity.subject, deviceId, csrf: csrfToken, expiresAt });
      return { cookie: `${COOKIE_NAME}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expiresAt - now()) / 1000))}`,
        csrfToken, expiresAt };
    },
    async close() {
      offRevoke();
      for (const stream of streams.values()) stream.close();
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
