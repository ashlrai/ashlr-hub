/**
 * Dormant phone gateway HTTP adapter. No production startup path imports/calls
 * startRemoteReadGateway; Tunnel must target this listener, never Hub's :7777.
 * The browser receives a separate, short-lived device session. Hub's read
 * token and its read-session cookie stay exclusively on the loopback hop.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TextDecoder } from 'node:util';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteAccessVerifier, parseRemoteAccessConfig, verifyRemoteAccessHeader, type RemoteAccessConfig, type RemoteAccessIdentity } from './remote-access.js';
import { checkRemoteEnvelope, classifyRemoteRoute, validateRemoteMutation, type RemoteRouteDecision } from './remote-gateway-policy.js';
import type { RemoteDeviceStore } from './remote-device-store.js';
import type { createRemotePairing } from './remote-pairing.js';
import { serveStatic } from './static.js';

const COOKIE_NAME = '__Host-ashlr-remote';
const PREAUTH_COOKIE_NAME = '__Host-ashlr-remote-preauth';
const SESSION_MS = 15 * 60_000;
const MAX_PREAUTH_SESSIONS = 128;
const MAX_BODY_BYTES = 65_536;
// A single session detail can contain 5,000 events; retain a hard bound while
// allowing a real long-running chat to load on the phone.
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SSE_CHUNK_BYTES = 1024 * 1024;
const REMOTE_MARKER = '<meta name="ashlr-remote-gateway" content="v1">';
type AccessVerifier = ReturnType<typeof createRemoteAccessVerifier>;

export interface RemoteReadGatewayOptions {
  access: RemoteAccessConfig;
  hub: { port: number; readToken: string; mutationToken?: string };
  devices: RemoteDeviceStore;
  pairing?: ReturnType<typeof createRemotePairing>;
  /** Bundled web public dir. Assets stay off until the remote client is ready. */
  assetsDir?: string;
  mobileAssetsEnabled?: boolean;
  port?: number;
  /** Test-only pinned local JWKS verifier. Production derives it from access. */
  verifier?: AccessVerifier;
  now?: () => number;
}

interface DeviceSession { deviceId: string; subject: string; expiresAt: number; csrf: string }
interface PreauthSession { subject: string; expiresAt: number; csrf: string }

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(body));
}

function cookieValue(req: IncomingMessage, name = COOKIE_NAME): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 4096) return null;
  const matches = header.split(';').map((piece) => piece.trim()).filter((piece) => piece.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function shape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  return object(value) && required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
async function bodyText(req: IncomingMessage): Promise<string | null> {
  if (req.headers['content-type'] !== 'application/json'
    || Number(req.headers['content-length'] ?? '0') > MAX_BODY_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return null; }
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const text = await bodyText(req);
  if (text === null) return null;
  try { const parsed: unknown = JSON.parse(text); return object(parsed) ? parsed : null; }
  catch { return null; }
}
async function boundedResponse(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}
function parsedMutation(decision: RemoteRouteDecision, body: string): unknown | null {
  try {
    const parsed: unknown = body.length ? JSON.parse(body) : undefined;
    return validateRemoteMutation(decision, parsed) ? parsed ?? {} : null;
  } catch { return null; }
}
function staticPath(path: string): boolean {
  return path === '/verse/m' || path === '/verse/m/' || path === '/verse/m/sw.js'
    || /^\/next\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:js|css|svg|png|webp|woff2?)$/.test(path)
    || /^\/next\/verse-m\/(?:manifest\.webmanifest|icon-192\.png|icon-512\.png|icon-maskable-512\.png|apple-touch-icon\.png)$/.test(path);
}

/** Starting this module requires a fully provisioned config and local Hub. */
export async function startRemoteReadGateway(options: RemoteReadGatewayOptions) {
  const parsedConfig = parseRemoteAccessConfig(options.access);
  if (!parsedConfig) throw new Error('Invalid remote Access configuration');
  const config = parsedConfig;
  if (!Number.isInteger(options.hub.port) || options.hub.port < 1 || options.hub.port > 65535
    || !/^[a-f0-9]{64}$/.test(options.hub.readToken)) throw new Error('Invalid local Hub read authority');
  if (options.hub.mutationToken !== undefined && !/^[a-f0-9]{64}$/.test(options.hub.mutationToken)) {
    throw new Error('Invalid local Hub mutation authority');
  }
  const verify = options.verifier ?? createRemoteAccessVerifier(config);
  const now = options.now ?? Date.now;
  const hubOrigin = `http://127.0.0.1:${options.hub.port}`;
  const hubSecrets = [options.hub.readToken, options.hub.mutationToken].filter((secret): secret is string => !!secret);
  const longestSecret = Math.max(...hubSecrets.map((secret) => secret.length));
  const sessions = new Map<string, DeviceSession>();
  const preauthSessions = new Map<string, PreauthSession>();
  const registrationOwners = new Map<string, { owner: string; expiresAt: number }>();
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

  function livePreauth(req: IncomingMessage, identity: RemoteAccessIdentity): { key: string; session: PreauthSession } | null {
    const value = cookieValue(req, PREAUTH_COOKIE_NAME);
    const key = value ? hash(value) : '';
    const session = preauthSessions.get(key);
    return session && session.expiresAt > now() && session.subject === identity.subject ? { key, session } : null;
  }

  function issuePreauth(identity: RemoteAccessIdentity) {
    for (const [key, value] of preauthSessions) if (value.expiresAt <= now()) preauthSessions.delete(key);
    if (preauthSessions.size >= MAX_PREAUTH_SESSIONS) return null;
    const secret = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(identity.expiresAt, now() + SESSION_MS);
    preauthSessions.set(hash(secret), { subject: identity.subject, csrf, expiresAt });
    return { csrf, cookie: `${PREAUTH_COOKIE_NAME}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expiresAt - now()) / 1000))}` };
  }

  function issueDeviceSession(identity: RemoteAccessIdentity, deviceId: string) {
    if (identity.expiresAt <= now() || !config.allowedSubjects.includes(identity.subject)
      || !options.devices.getActive(deviceId, identity.subject)) return null;
    const secret = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(identity.expiresAt, now() + SESSION_MS);
    for (const [key, value] of sessions) if (value.expiresAt <= now()
      || (value.deviceId === deviceId && value.subject === identity.subject)) sessions.delete(key);
    sessions.set(hash(secret), { subject: identity.subject, deviceId, csrf: csrfToken, expiresAt });
    return { cookie: `${COOKIE_NAME}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expiresAt - now()) / 1000))}`,
      csrfToken, expiresAt };
  }

  function capabilities() {
    return { writes: !!(options.pairing && options.hub.mutationToken),
      pairing: !!options.pairing, push: false };
  }

  async function forwardMutation(method: string, target: string, body: string): Promise<{ status: number; body: string } | null> {
    if (!options.hub.mutationToken) return null;
    try {
      const response = await fetch(`${hubOrigin}${target}`, { method, redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'x-ashlr-token': options.hub.mutationToken },
        body: method === 'DELETE' && body === '' ? undefined : body, signal: AbortSignal.timeout(30_000) });
      if (response.status >= 300 && response.status < 400) return null;
      if (response.status === 204) return { status: 204, body: '' };
      if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) return null;
      const bytes = await boundedResponse(response, MAX_JSON_BYTES);
      if (!bytes || bytes.includes(options.hub.mutationToken)
        || bytes.includes(options.hub.readToken)) return null;
      return { status: response.status, body: bytes.toString('utf8') };
    } catch { return null; }
  }

  const server = createServer((req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    void (async () => {
      // Check Host/Origin before a JWKS fetch, then CSRF after resolving the
      // Access-bound preauth or device session. No forwarded header is trusted.
      const preliminary = checkRemoteEnvelope({ method: 'GET', headers: req.headers }, config.publicOrigin);
      if (!preliminary.ok) { json(res, 403, { code: 'REMOTE_ENVELOPE_DENIED', error: 'Remote request denied' }); return; }
      const identity = await verifyRemoteAccessHeader(req.headers, verify);
      if (!identity || identity.expiresAt <= now()) { json(res, 401, { code: 'ACCESS_REQUIRED', error: 'Cloudflare Access authentication required' }); return; }
      const session = liveSession(req, identity);
      const preauth = livePreauth(req, identity);
      const envelope = checkRemoteEnvelope(req, config.publicOrigin, session?.csrf ?? preauth?.session.csrf);
      if (!envelope.ok) { json(res, 403, { code: 'REMOTE_ENVELOPE_DENIED', error: 'Remote request denied' }); return; }
      const target = req.url ?? '';
      if (req.method === 'GET' && target === '/remote/session') {
        if (!session) {
          if (!options.pairing) { json(res, 200, { authenticated: false, capabilities: capabilities() }); return; }
          const proof = preauth ? { csrf: preauth.session.csrf, cookie: null } : issuePreauth(identity);
          if (!proof) { json(res, 503, { code: 'PAIRING_BUSY', error: 'Too many pending phone sessions' }); return; }
          json(res, 200, { authenticated: false, csrfToken: proof.csrf, capabilities: capabilities() },
            proof.cookie ? { 'Set-Cookie': proof.cookie } : {});
          return;
        }
        const device = options.devices.getActive(session.deviceId, identity.subject);
        if (!device) { json(res, 401, { code: 'DEVICE_REVOKED', error: 'Device unavailable' }); return; }
        json(res, 200, { authenticated: true, deviceId: device.id, label: device.label, scopes: device.scopes,
          csrfToken: session.csrf, expiresAt: Math.min(session.expiresAt, identity.expiresAt), capabilities: capabilities() });
        return;
      }
      if (options.pairing && req.method === 'GET' && target.startsWith('/remote/pair/status?')) {
        if (!preauth) { json(res, 401, { code: 'PREAUTH_REQUIRED', error: 'Pairing session required' }); return; }
        const query = /^\/remote\/pair\/status\?pendingId=([0-9a-f-]{36})$/.exec(target);
        const owned = query ? registrationOwners.get(query[1]!) : null;
        if (!owned || owned.owner !== preauth.key || owned.expiresAt <= now()) {
          json(res, 404, { code: 'PAIRING_NOT_FOUND', error: 'Pairing unavailable' }); return;
        }
        const status = options.pairing.phone.registrationStatus(identity, query![1]!);
        if (!status) { json(res, 404, { code: 'PAIRING_NOT_FOUND', error: 'Pairing unavailable' }); return; }
        json(res, 200, status); return;
      }
      if (options.pairing && req.method === 'POST' && target.startsWith('/remote/')) {
        if (target === '/remote/logout') {
          if (!session) { json(res, 401, { code: 'DEVICE_SESSION_REQUIRED', error: 'Device authentication required' }); return; }
          const value = cookieValue(req);
          if (value) sessions.delete(hash(value));
          res.writeHead(204, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` }); res.end(); return;
        }
        if (target === '/remote/pair/claim' || target === '/remote/pair/complete'
          || target === '/remote/auth/begin' || target === '/remote/auth/finish') {
          if (!preauth) { json(res, 401, { code: 'PREAUTH_REQUIRED', error: 'Pairing session required' }); return; }
          const body = await jsonBody(req);
          if (!body) { json(res, 400, { code: 'INVALID_BODY', error: 'Invalid request body' }); return; }
          if (target === '/remote/pair/claim') {
            if (!shape(body, ['code', 'label']) || typeof body.code !== 'string' || typeof body.label !== 'string') {
              json(res, 400, { code: 'INVALID_BODY', error: 'Invalid pairing request' }); return;
            }
            const claimed = await options.pairing.phone.claimInvitation(identity, body.code, body.label);
            if (!claimed) { json(res, 403, { code: 'PAIRING_DENIED', error: 'Pairing unavailable' }); return; }
            for (const [id, owner] of registrationOwners) if (owner.expiresAt <= now()) registrationOwners.delete(id);
            registrationOwners.set(claimed.pendingId, { owner: preauth.key, expiresAt: now() + 5 * 60_000 });
            json(res, 200, claimed); return;
          }
          if (target === '/remote/pair/complete') {
            if (!shape(body, ['pendingId', 'response']) || typeof body.pendingId !== 'string'
              || registrationOwners.get(body.pendingId)?.owner !== preauth.key || !object(body.response)) {
              json(res, 403, { code: 'PAIRING_DENIED', error: 'Pairing unavailable' }); return;
            }
            const completed = await options.pairing.phone.completeRegistration(identity, body.pendingId,
              body.response as unknown as RegistrationResponseJSON);
            if (!completed) { json(res, 403, { code: 'PAIRING_DENIED', error: 'Pairing unavailable' }); return; }
            json(res, 200, { pendingApproval: true }); return;
          }
          if (target === '/remote/auth/begin') {
            if (!shape(body, ['deviceId']) || typeof body.deviceId !== 'string') {
              json(res, 400, { code: 'INVALID_BODY', error: 'Invalid authentication request' }); return;
            }
            const begun = await options.pairing.phone.beginAuthentication(identity, body.deviceId);
            if (!begun) { json(res, 403, { code: 'AUTH_DENIED', error: 'Device authentication unavailable' }); return; }
            json(res, 200, begun); return;
          }
          if (!shape(body, ['challengeId', 'response']) || typeof body.challengeId !== 'string' || !object(body.response)) {
            json(res, 400, { code: 'INVALID_BODY', error: 'Invalid authentication response' }); return;
          }
          const verified = await options.pairing.phone.completeAuthentication(identity, body.challengeId,
            body.response as unknown as AuthenticationResponseJSON);
          const issued = verified && issueDeviceSession(identity, verified.id);
          if (!issued) { json(res, 403, { code: 'AUTH_DENIED', error: 'Device authentication failed' }); return; }
          const device = options.devices.getActive(verified.id, identity.subject)!;
          json(res, 200, { authenticated: true, deviceId: device.id, label: device.label, scopes: device.scopes,
            csrfToken: issued.csrfToken, expiresAt: issued.expiresAt, capabilities: capabilities() }, { 'Set-Cookie': issued.cookie });
          return;
        }
      }
      // The pairing shell may load after Access before a device exists. Its
      // assets have no API authority; every data route still needs a device.
      const publicMobileAsset = req.method === 'GET' && !!options.pairing && !!options.mobileAssetsEnabled
        && staticPath(target) && !target.includes('?');
      if (!session && !publicMobileAsset) {
        json(res, 401, { code: 'DEVICE_SESSION_REQUIRED', error: 'Device authentication required' }); return;
      }
      if (session && options.pairing && options.hub.mutationToken && req.method === 'POST'
        && (target === '/remote/step-up/begin' || target === '/remote/step-up/finish')) {
        if (!options.devices.getActive(session.deviceId, identity.subject)?.scopes.act) {
          json(res, 403, { code: 'ACT_DENIED', error: 'Device action scope required' }); return;
        }
        const body = await jsonBody(req);
        if (!body || typeof body.method !== 'string' || typeof body.path !== 'string' || typeof body.body !== 'string'
          || !shape(body, ['method', 'path', 'body'], target.endsWith('/finish') ? ['challengeId', 'response'] : [])) {
          json(res, 400, { code: 'INVALID_BODY', error: 'Invalid step-up request' }); return;
        }
        const operation = { method: body.method, path: body.path, body: body.body };
        const decision = classifyRemoteRoute(operation.method, operation.path);
        if (decision.kind !== 'write' || parsedMutation(decision, operation.body) === null) {
          json(res, 403, { code: 'ROUTE_DENIED', error: 'Mutation denied' }); return;
        }
        const bound = { method: operation.method as 'POST' | 'DELETE', path: operation.path, body: operation.body };
        if (target.endsWith('/begin')) {
          const begun = await options.pairing.phone.beginStepUp(identity, session.deviceId, bound);
          if (!begun) { json(res, 403, { code: 'STEP_UP_DENIED', error: 'Device authentication unavailable' }); return; }
          json(res, 200, begun); return;
        }
        if (typeof body.challengeId !== 'string' || !object(body.response)) {
          json(res, 400, { code: 'INVALID_BODY', error: 'Invalid step-up response' }); return;
        }
        const result = await options.pairing.phone.runWithStepUp(identity, body.challengeId,
          body.response as unknown as AuthenticationResponseJSON, bound, async () => {
            // The pairing callback enters after its final live revocation
            // check. Validate body and scope again immediately at dispatch.
            if (parsedMutation(decision, operation.body) === null
              || !options.devices.getActive(session.deviceId, identity.subject)?.scopes.act) return null;
            return forwardMutation(operation.method, operation.path, operation.body);
          });
        if (!result.ok) { json(res, 403, { code: 'STEP_UP_DENIED', error: 'Device authentication failed' }); return; }
        if (!result.value) { json(res, 502, { code: 'HUB_UNAVAILABLE', error: 'Local Hub unavailable' }); return; }
        if (result.value.status === 204) { res.writeHead(204); res.end(); return; }
        res.writeHead(result.value.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(result.value.body); return;
      }
      const route = classifyRemoteRoute(req.method, target);
      if (route.kind === 'write') {
        if (!session) { json(res, 401, { code: 'DEVICE_SESSION_REQUIRED', error: 'Device authentication required' }); return; }
        if (!options.pairing || !options.hub.mutationToken || !options.devices.getActive(session.deviceId, identity.subject)?.scopes.act) {
          json(res, 403, { code: 'ACT_DENIED', error: 'Device action scope required' }); return;
        }
        if (route.stepUp) { json(res, 403, { code: 'STEP_UP_REQUIRED', error: 'Fresh device authentication required' }); return; }
        const body = await bodyText(req);
        if (body === null || parsedMutation(route, body) === null || !options.devices.getActive(session.deviceId, identity.subject)) {
          json(res, 400, { code: 'INVALID_MUTATION', error: 'Mutation denied' }); return;
        }
        const result = await forwardMutation(req.method ?? '', target, body);
        if (!result) { json(res, 502, { code: 'HUB_UNAVAILABLE', error: 'Local Hub unavailable' }); return; }
        if (result.status === 204) { res.writeHead(204); res.end(); return; }
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(result.body); return;
      }
      if (req.method !== 'GET') { json(res, 404, { code: 'ROUTE_DENIED', error: 'Route unavailable' }); return; }
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
      if (!session) { json(res, 401, { code: 'DEVICE_SESSION_REQUIRED', error: 'Device authentication required' }); return; }
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
          const bytes = await boundedResponse(upstream, MAX_JSON_BYTES);
          if (!bytes || hubSecrets.some((secret) => bytes.includes(secret))) {
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
          if (hubSecrets.some((secret) => pending.includes(secret))) { controller.abort(); break; }
          const safeLength = pending.length - longestSecret + 1;
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
        if (!controller.signal.aborted && !hubSecrets.some((secret) => pending.includes(secret)) && !res.writableEnded) res.write(pending);
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
    issueDeviceSession,
    async close() {
      offRevoke();
      for (const stream of streams.values()) stream.close();
      sessions.clear();
      preauthSessions.clear();
      registrationOwners.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
