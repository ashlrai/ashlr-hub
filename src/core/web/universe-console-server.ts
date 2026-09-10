import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadSessionBoundary, headerValue, requestUrl, sendJson } from './read-session.js';
import { serveStatic } from './static.js';
import { createUniverseConsoleReader, validateUniverseConsoleRoot } from './universe-console-reads.js';
import type { UniverseConsoleServerHandle, UniverseConsoleServerOptions } from './universe-console-types.js';
export type { UniverseConsoleServerHandle, UniverseConsoleServerOptions } from './universe-console-types.js';

function sendProjection(res: ServerResponse, json: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(json, 'utf8') });
  res.end(json);
}

/** Config-free, foreground-only reader for exactly one caller-selected Universe store. */
export async function startUniverseConsoleServer(options: UniverseConsoleServerOptions): Promise<UniverseConsoleServerHandle> {
  const root = validateUniverseConsoleRoot(options.root);
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('Invalid Universe console port');
  const reader = createUniverseConsoleReader(root);
  const sessions = createReadSessionBoundary({ cookieName: `ashlr_universe_${randomBytes(12).toString('hex')}` });
  const assets = join(dirname(fileURLToPath(import.meta.url)), 'public');
  let origin = '';
  let boundPort = 0;
  let closing: Promise<void> | null = null;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const host = headerValue(req, 'host');
    if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(host)) {
      sendJson(res, 403, { error: 'Forbidden: invalid Host header' }); return;
    }
    // Native raw-header clients need no Origin. Browser requests must match the
    // advertised origin exactly; no trusted proxy or permissive CORS mode exists.
    if (req.headers.origin !== undefined && headerValue(req, 'origin') !== origin) {
      sendJson(res, 403, { error: 'Forbidden: invalid Origin header' }); return;
    }
    const url = requestUrl(req);
    if (!url) { sendJson(res, 400, { error: 'Invalid request URL' }); return; }
    const method = (req.method ?? 'GET').toUpperCase();
    if (url.pathname === '/health') {
      if (url.search) { sendJson(res, 400, { error: 'Health does not accept query parameters' }); return; }
      if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
      sendJson(res, 200, { ok: true }); return;
    }
    if (sessions.handleSession(req, res, url)) return;
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!sessions.authority(req, url)) {
        sendJson(res, 401, { error: 'Unauthorized: read session required' },
          { Vary: 'Cookie, X-Ashlr-Token, X-Ashlr-Read-Client' }); return;
      }
      if (method !== 'GET') { sendJson(res, 405, { error: 'Read-only API' }); return; }
      if (url.pathname === '/api/universe/console' || url.pathname === '/api/universe') {
        if (url.search) { sendJson(res, 400, { error: 'This route does not accept query parameters' }); return; }
        if (url.pathname.endsWith('/console')) {
          // Explicit authenticated scope metadata, not a inferred/default home.
          sendJson(res, 200, { schemaVersion: 1, mode: 'universe', root, readOnly: true });
        } else sendProjection(res, await reader.overview());
        return;
      }
      if (url.pathname === '/api/universe/graph') {
        const ids = url.searchParams.getAll('universeId');
        if (ids.length !== 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ids[0]!) ||
          [...url.searchParams.keys()].some((key) => key !== 'universeId')) {
          sendJson(res, 400, { error: 'Expected exactly one universeId and no other parameters' }); return;
        }
        sendProjection(res, await reader.graph(ids[0]!)); return;
      }
      if (url.pathname === '/api/universe/campaign-readiness') {
        const ids = url.searchParams.getAll('campaignId');
        if (ids.length !== 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ids[0]!) ||
          [...url.searchParams.keys()].some((key) => key !== 'campaignId')) {
          sendJson(res, 400, { error: 'Expected exactly one campaignId and no other parameters' }); return;
        }
        sendProjection(res, await reader.campaignReadiness(ids[0]!)); return;
      }
      if (url.pathname === '/api/universe/controller-status') {
        const ids = url.searchParams.getAll('controllerId');
        if (ids.length !== 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ids[0]!) ||
          [...url.searchParams.keys()].some((key) => key !== 'controllerId')) {
          sendJson(res, 400, { error: 'Expected exactly one controllerId and no other parameters' }); return;
        }
        sendProjection(res, await reader.controllerStatus(ids[0]!)); return;
      }
      sendJson(res, 404, { error: 'Route unavailable in this scoped console' }); return;
    }
    if (method !== 'GET' && method !== 'HEAD') { sendJson(res, 405, { error: 'Method not allowed' }); return; }
    if (url.search) { sendJson(res, 400, { error: 'Static resources do not accept query parameters' }); return; }
    if (url.pathname === '/universe') { res.writeHead(308, { Location: '/universe/' }); res.end(); return; }
    if (url.pathname === '/universe/' || url.pathname.startsWith('/next/assets/')) {
      // Reuse packaged assets without ASHLR_WEB_PUBLIC or a caller-selected path.
      const staticRequest = Object.create(req) as IncomingMessage;
      staticRequest.url = url.pathname === '/universe/' ? '/next/index.html' : url.pathname;
      if (serveStatic(staticRequest, res, assets)) return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  const server = createServer((req, res) => {
    if (closing) { sendJson(res, 503, { error: 'Console is closing' }); return; }
    void route(req, res).catch(() => {
      if (!res.headersSent && !res.destroyed) sendJson(res, 503, { error: 'Universe evidence is temporarily unavailable' });
      else if (!res.writableEnded) res.end();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolveListening, reject) => {
      const fail = (error: Error): void => { server.removeListener('listening', ready); reject(error); };
      const ready = (): void => { server.removeListener('error', fail); resolveListening(); };
      server.once('error', fail); server.once('listening', ready);
      server.listen(requestedPort, '127.0.0.1');
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Console address is unavailable');
    boundPort = address.port;
    origin = `http://127.0.0.1:${boundPort}`;
  } catch (error) {
    await reader.close(); sessions.clear(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((done) => server.close(() => done()));
    throw error;
  }
  return { url: origin, consoleUrl: `${origin}/universe/`, port: boundPort, readToken: sessions.readToken,
    close() {
      if (closing) return closing;
      sessions.clear();
      closing = Promise.all([reader.close(), new Promise<void>((done) => {
        server.close(() => done()); server.closeIdleConnections(); server.closeAllConnections();
      })]).then(() => undefined);
      return closing;
    } };
}
