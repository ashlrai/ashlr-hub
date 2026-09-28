import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createRemoteAccessVerifier } from '../src/core/web/remote-access.js';
import { createRemoteDeviceStore, type RemoteDevice } from '../src/core/web/remote-device-store.js';
import { startRemoteReadGateway } from '../src/core/web/remote-gateway.js';

const ORIGIN = 'https://phone.example.com';
const SUBJECT = '7335d417-61da-459d-899c-0a01c76a2f94';
const DEVICE_ID = '6335d417-61da-459d-899c-0a01c76a2f94';
const TOKEN = 'a'.repeat(64);
const CONFIG = { publicOrigin: ORIGIN, teamDomain: 'https://team.cloudflareaccess.com', audience: 'b'.repeat(64), allowedSubjects: [SUBJECT] };
const active = new Set<Server>();
const dirs: string[] = [];
afterEach(async () => {
  for (const server of active) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  active.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function device(): RemoteDevice {
  return { id: DEVICE_ID, label: 'Phone', subject: SUBJECT, email: 'owner@example.com',
    scopes: { read: true, act: true }, credentialId: randomBytes(32).toString('base64url'),
    publicKey: randomBytes(80).toString('base64url'), counter: 0, transports: ['internal'],
    deviceType: 'multiDevice', backedUp: true, createdAt: 1, lastUsedAt: null, revokedAt: null };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-remote-http-'));
  dirs.push(root);
  const devices = createRemoteDeviceStore(root);
  devices.add(device());
  const received: { path: string; headers: Record<string, unknown> }[] = [];
  const hub = createServer((req, res) => {
    received.push({ path: req.url ?? '', headers: { ...req.headers } });
    if (req.url === '/api/session' && req.method === 'POST' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(204, { 'Set-Cookie': `ashlr_read_session=${'z'.repeat(80)}; Path=/api/; HttpOnly` }); res.end(); return;
    }
    if (req.url?.startsWith('/api/events?topics=verse-sessions&client=') && req.headers.cookie?.startsWith('ashlr_read_session=')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: tick\ndata: ${'x'.repeat(128)}\n\n`); return;
    }
    if (req.url === '/api/verse/activity' && req.headers['x-ashlr-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  active.add(hub);
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const hubPort = (hub.address() as { port: number }).port;
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const key = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256', use: 'sig' };
  const verifier = createRemoteAccessVerifier(CONFIG, createLocalJWKSet({ keys: [key] }));
  const sign = (expiry: number, subject = SUBJECT) => new SignJWT({ type: 'app', email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(CONFIG.teamDomain).setAudience(CONFIG.audience)
    .setSubject(subject).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setNotBefore(Math.floor(Date.now() / 1000) - 1)
    .setExpirationTime(expiry).sign(privateKey);
  const jwt = await sign(Math.floor(Date.now() / 1000) + 600);
  const gateway = await startRemoteReadGateway({ access: CONFIG, hub: { port: hubPort, readToken: TOKEN }, devices, verifier });
  const identity = { subject: SUBJECT, email: 'owner@example.com', expiresAt: Date.now() + 600_000 };
  const session = gateway.issueDeviceSession(identity, DEVICE_ID);
  if (!session) throw new Error('fixture session missing');
  const headers = { host: 'phone.example.com', 'cf-access-jwt-assertion': jwt, cookie: session.cookie.split(';', 1)[0]! };
  async function get(path: string, overrides: Record<string, string> = {}, method = 'GET') {
    return new Promise<Response>((resolve, reject) => {
      const outgoing = httpRequest(`${gateway.url}${path}`, { method, headers: { ...headers, ...overrides } }, (incoming) => {
        resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
          status: incoming.statusCode, headers: incoming.headers as HeadersInit,
        }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
  }
  return { gateway, devices, received, headers, get, sign, session };
}

describe('dormant remote read gateway HTTP boundary', () => {
  it('keeps raw Hub credentials off the browser and allows only reviewed reads', async () => {
    const f = await fixture();
    try {
      const probe = await f.get('/remote/session');
      expect(await probe.json()).toMatchObject({ authenticated: true, capabilities: { writes: false }, deviceId: DEVICE_ID });
      expect(probe.headers.get('set-cookie')).toBeNull();
      const response = await f.get('/api/verse/activity');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('x-ashlr-token')).toBeNull();
      expect(f.received.at(-1)?.headers['x-ashlr-token']).toBe(TOKEN);
      expect((await f.get('/api/session')).status).toBe(404);
      expect((await f.get('/api/verse/agent-tools/mcp')).status).toBe(404);
      expect((await f.get('/verse/m/')).status).toBe(404);
      expect((await f.get('/api/verse/activity', {}, 'POST')).status).toBe(403);
    } finally { await f.gateway.close(); }
  });

  it('denies absent/altered Access assertion, wrong Host/Origin, raw tokens and revoked devices', async () => {
    const f = await fixture();
    try {
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': '' })).status).toBe(401);
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': `${f.headers['cf-access-jwt-assertion']}x` })).status).toBe(401);
      expect((await f.get('/api/verse/activity', { host: 'evil.example' })).status).toBe(403);
      expect((await f.get('/api/verse/activity', { origin: 'https://evil.example' })).status).toBe(403);
      expect((await f.get('/api/verse/activity', { 'x-ashlr-token': TOKEN })).status).toBe(403);
      const expired = await f.sign(Math.floor(Date.now() / 1000) - 5);
      expect((await f.get('/api/verse/activity', { 'cf-access-jwt-assertion': expired })).status).toBe(401);
      f.devices.revoke(DEVICE_ID, Date.now());
      expect((await f.get('/api/verse/activity')).status).toBe(401);
    } finally { await f.gateway.close(); }
  });

  it('closes live SSE on device revocation and never forwards local credentials', async () => {
    const f = await fixture();
    try {
      const response = await f.get('/api/events?topics=verse-sessions');
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('event: tick');
      const streamRequest = f.received.find((r) => r.path.startsWith('/api/events?'))!;
      expect(streamRequest.headers.cookie).toMatch(/^ashlr_read_session=/);
      expect(streamRequest.headers['x-ashlr-token']).toBeUndefined();
      f.devices.revoke(DEVICE_ID, Date.now());
      const closed = await Promise.race([reader.read(), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))]);
      expect(closed).not.toBe('timeout');
      expect((closed as ReadableStreamReadResult<Uint8Array>).done).toBe(true);
    } finally { await f.gateway.close(); }
  });

  it('caps a live SSE connection to the device session expiry', async () => {
    const f = await fixture();
    try {
      const short = f.gateway.issueDeviceSession({ subject: SUBJECT, email: 'owner@example.com',
        expiresAt: Date.now() + 300 }, DEVICE_ID);
      expect(short).not.toBeNull();
      const response = await f.get('/api/events?topics=verse-sessions', { cookie: short!.cookie.split(';', 1)[0]! });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      const closed = await Promise.race([reader.read(), new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3_000))]);
      expect(closed).not.toBe('timeout');
      expect((closed as ReadableStreamReadResult<Uint8Array>).done).toBe(true);
    } finally { await f.gateway.close(); }
  });
});
