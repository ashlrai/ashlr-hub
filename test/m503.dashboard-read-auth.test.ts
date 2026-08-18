import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { createConnection } from 'node:net';

import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { startServer } from '../src/core/web/server.js';
import type { WebServerHandle } from '../src/core/types.js';

interface ResponseData {
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

let fixture: H1Fixture;
let handles: WebServerHandle[];
const CLIENT_PROOF = 'a'.repeat(64);

beforeEach(() => {
  fixture = makeFixture();
  handles = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const handle of handles) {
    try { await handle.close(); } catch { /* best effort */ }
  }
  fixture.cleanup();
});

async function server(allowDispatch = false): Promise<WebServerHandle> {
  const handle = await startServer(makeCfg(), { port: 0, open: false, allowDispatch });
  handles.push(handle);
  return handle;
}

function request(
  handle: WebServerHandle,
  method: string,
  path: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: handle.port,
      path,
      method,
      headers: { Host: `127.0.0.1:${handle.port}`, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body,
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawRequest(handle: WebServerHandle, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: handle.port });
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2_000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function openSse(
  handle: WebServerHandle,
  headers: http.OutgoingHttpHeaders = {},
  path = '/api/events',
): Promise<ResponseData> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: handle.port,
      path,
      method: 'GET',
      headers: { Host: `127.0.0.1:${handle.port}`, ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (res.statusCode === 200 && body.includes(': connected')) {
          resolve({ statusCode: 200, body, headers: res.headers });
          res.destroy();
          req.destroy();
        }
      });
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0,
        body,
        headers: res.headers,
      }));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}

function persistentSse(
  handle: WebServerHandle,
  headers: http.OutgoingHttpHeaders,
  path: string,
): Promise<{ connected: Promise<void>; closed: Promise<string>; destroy(): void }> {
  let resolveConnected!: () => void;
  let resolveClosed!: (body: string) => void;
  const connected = new Promise<void>((resolve) => { resolveConnected = resolve; });
  const closed = new Promise<string>((resolve) => { resolveClosed = resolve; });
  let body = '';
  const req = http.request({ hostname: '127.0.0.1', port: handle.port, path, method: 'GET', headers: { Host: `127.0.0.1:${handle.port}`, ...headers } });
  req.on('response', (res) => {
    res.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.includes(': connected')) resolveConnected();
    });
    res.on('end', () => resolveClosed(body));
    res.on('close', () => resolveClosed(body));
  });
  req.end();
  return Promise.resolve({ connected, closed, destroy: () => req.destroy() });
}

async function mintCookie(
  handle: WebServerHandle,
  clientProof = CLIENT_PROOF,
): Promise<{ cookie: string; ticket: string; response: ResponseData; clientProof: string }> {
  const response = await request(handle, 'POST', '/api/session', {
    'x-ashlr-token': handle.readToken,
    'x-ashlr-read-client': clientProof,
  });
  const setCookie = response.headers['set-cookie']?.[0] ?? '';
  const cookie = setCookie.split(';', 1)[0] ?? '';
  const ticket = cookie.slice(cookie.indexOf('=') + 1);
  return { cookie, ticket, response, clientProof };
}

describe('loopback dashboard read authority', () => {
  it('bounds a malformed request target and remains available afterward', async () => {
    const handle = await server();
    const malformed = await rawRequest(
      handle,
      `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`,
    );

    expect(malformed).toContain('HTTP/1.1 400');
    expect(malformed.toLowerCase()).toContain('cache-control: no-store');
    expect(malformed).toContain('invalid request URL');
    expect(malformed.length).toBeLessThan(1_024);

    const survived = await request(handle, 'GET', '/api/config/effective', {
      'x-ashlr-token': handle.readToken,
    });
    expect(survived.statusCode).toBe(200);
  });

  it('keeps static assets and only a minimal bounded liveness projection public', async () => {
    const handle = await server();
    const root = await request(handle, 'GET', '/');
    const health = await request(handle, 'GET', '/api/health');

    expect(root.statusCode).toBe(200);
    expect(String(root.headers['content-type'])).toContain('text/html');
    expect(root.headers['referrer-policy']).toBe('no-referrer');
    expect(root.headers['x-frame-options']).toBe('DENY');
    expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(root.headers['permissions-policy']).toContain('camera=()');
    expect(health.statusCode).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    expect(health.body.length).toBeLessThan(32);
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('default-denies proprietary and unknown API GETs for missing or wrong authority', async () => {
    const handle = await server();
    for (const path of ['/api/config/effective', '/api/snapshot', '/api/new-content']) {
      const missing = await request(handle, 'GET', path);
      const wrong = await request(handle, 'GET', path, { 'x-ashlr-token': 'wrong' });
      for (const response of [missing, wrong]) {
        expect(response.statusCode).toBe(401);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers.vary).toBe('Cookie, X-Ashlr-Token, X-Ashlr-Read-Client');
        expect(response.body).not.toContain(handle.readToken);
        expect(response.body).not.toContain(handle.token);
      }
    }
  });

  it('preserves raw-header access for trusted CLI and headless clients', async () => {
    const handle = await server();
    const response = await request(handle, 'GET', '/api/config/effective', {
      'x-ashlr-token': handle.readToken,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(handle.readToken);
    expect(response.body).not.toContain(handle.token);
  });

  it('mints a bounded, scoped, HttpOnly read ticket without copying the raw token', async () => {
    const handle = await server();
    const { cookie, ticket, response } = await mintCookie(handle);
    const setCookie = response.headers['set-cookie']?.[0] ?? '';

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api/');
    expect(setCookie).toContain('Max-Age=900');
    expect(setCookie).not.toContain('Secure');
    expect(cookie).toMatch(/^ashlr_read_session=/);
    expect(ticket.length).toBeLessThan(256);
    expect(ticket).not.toContain(handle.readToken);
    expect(ticket).not.toContain(handle.token);
    expect(ticket).not.toContain(CLIENT_PROOF);
    expect(ticket.split('.').slice(0, 3)).toEqual(['v1', 'GET', '/api/']);
  });

  it('rejects missing, wrong, repeated, and cookie-only session bootstrap tokens', async () => {
    const handle = await server();
    const { cookie } = await mintCookie(handle);
    const cases = [
      { 'x-ashlr-read-client': CLIENT_PROOF },
      { 'x-ashlr-token': 'wrong', 'x-ashlr-read-client': CLIENT_PROOF },
      { 'x-ashlr-token': [handle.readToken, handle.readToken], 'x-ashlr-read-client': CLIENT_PROOF },
      { 'x-ashlr-token': handle.token, 'x-ashlr-read-client': CLIENT_PROOF },
      { Cookie: cookie, 'x-ashlr-read-client': CLIENT_PROOF },
    ];
    for (const headers of cases) {
      const response = await request(handle, 'POST', '/api/session', headers);
      expect(response.statusCode).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.body).not.toContain(handle.readToken);
      expect(response.body).not.toContain(handle.token);
    }
  });

  it('rejects malformed, oversized, repeated, or query-supplied bootstrap client proofs', async () => {
    const handle = await server();
    const invalidHeaders: http.OutgoingHttpHeaders[] = [
      {},
      { 'x-ashlr-read-client': 'a'.repeat(63) },
      { 'x-ashlr-read-client': 'A'.repeat(64) },
      { 'x-ashlr-read-client': 'a'.repeat(4_096) },
      { 'x-ashlr-read-client': [CLIENT_PROOF, CLIENT_PROOF] },
    ];
    for (const headers of invalidHeaders) {
      const response = await request(handle, 'POST', '/api/session', {
        'x-ashlr-token': handle.readToken,
        ...headers,
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect((await request(handle, 'POST', `/api/session?client=${CLIENT_PROOF}`, {
      'x-ashlr-token': handle.readToken,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(400);
  });

  it('authorizes content GETs with a valid cookie and rejects tampering or duplicates', async () => {
    const handle = await server();
    const { cookie, ticket } = await mintCookie(handle);
    const valid = await request(handle, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
    });
    const tampered = `${cookie.slice(0, -1)}${cookie.endsWith('a') ? 'b' : 'a'}`;
    const duplicate = `${cookie}; ashlr_read_session=${ticket}`;

    expect(valid.statusCode).toBe(200);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: tampered,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: duplicate,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: `ashlr_read_session=${'x'.repeat(300)}`,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);
  });

  it('binds the host-scoped cookie to one origin-scoped client proof', async () => {
    const handle = await server();
    const { cookie } = await mintCookie(handle);
    const cookieAlone = await request(handle, 'GET', '/api/config/effective', { Cookie: cookie });
    const wrongProof = await request(handle, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': 'b'.repeat(64),
    });
    const repeatedProof = await request(handle, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': [CLIENT_PROOF, CLIENT_PROOF],
    });
    const querySmuggling = await request(
      handle,
      'GET',
      `/api/config/effective?client=${CLIENT_PROOF}`,
      { Cookie: cookie, 'x-ashlr-read-client': CLIENT_PROOF },
    );

    // Models another localhost port stealing the host-scoped HttpOnly cookie:
    // replay still fails without the per-origin sessionStorage proof.
    expect(cookieAlone.statusCode).toBe(401);
    expect(wrongProof.statusCode).toBe(401);
    expect(repeatedProof.statusCode).toBe(401);
    expect(querySmuggling.statusCode).toBe(401);
  });

  it('rejects expired and implausibly future tickets, and token rotation invalidates them', async () => {
    const baseNow = Date.UTC(2026, 7, 10, 12, 0, 0);
    const now = vi.spyOn(Date, 'now').mockReturnValue(baseNow);
    const first = await server();
    const { cookie } = await mintCookie(first);

    now.mockReturnValue(baseNow + (16 * 60 * 1000));
    expect((await request(first, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);

    now.mockReturnValue(baseNow - 10_000);
    expect((await request(first, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);

    now.mockReturnValue(baseNow);
    const rotated = await server();
    expect((await request(rotated, 'GET', '/api/config/effective', {
      Cookie: cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);
  });

  it('requires an expiring browser session for SSE and rejects header-only or missing expiry', async () => {
    const handle = await server();
    const { cookie } = await mintCookie(handle);
    const headerSse = await openSse(handle, { 'x-ashlr-token': handle.readToken });
    const cookieSse = await openSse(
      handle,
      { Cookie: cookie },
      `/api/events?client=${CLIENT_PROOF}`,
    );
    const missing = await openSse(handle);

    expect(headerSse.statusCode).toBe(401);
    expect(cookieSse.statusCode).toBe(200);
    expect(String(cookieSse.headers['content-type'])).toContain('text/event-stream');
    expect(missing.statusCode).toBe(401);
    expect(String(missing.headers['content-type'])).toContain('application/json');
  });

  it('rejects cookie SSE with missing, wrong, malformed, duplicate, or unknown client query values', async () => {
    const handle = await server();
    const { cookie } = await mintCookie(handle);
    const paths = [
      '/api/events',
      `/api/events?client=${'b'.repeat(64)}`,
      `/api/events?client=${'a'.repeat(63)}`,
      `/api/events?client=${'a'.repeat(4_096)}`,
      `/api/events?client=${CLIENT_PROOF}&client=${CLIENT_PROOF}`,
      `/api/events?client=${CLIENT_PROOF}&extra=1`,
      `/api/events?extra=1&client=${CLIENT_PROOF}`,
    ];
    for (const path of paths) {
      const response = await request(handle, 'GET', path, { Cookie: cookie });
      expect(response.statusCode).toBe(401);
    }
  });

  it('never upgrades a read header or cookie into mutation authority', async () => {
    const handle = await server(true);
    const { cookie } = await mintCookie(handle);
    const readHeaderOnly = await request(handle, 'POST', '/api/run', {
      'x-ashlr-token': handle.readToken,
      'Content-Type': 'application/json',
    });
    const cookieOnly = await request(handle, 'POST', '/api/run', {
      Cookie: cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
      'Content-Type': 'application/json',
    });
    const clientProofOnly = await request(handle, 'POST', '/api/run', {
      'x-ashlr-read-client': CLIENT_PROOF,
      'Content-Type': 'application/json',
    });
    expect(readHeaderOnly.statusCode).toBe(401);
    expect(cookieOnly.statusCode).toBe(401);
    expect(clientProofOnly.statusCode).toBe(401);
    expect(readHeaderOnly.body).not.toContain(handle.readToken);
    expect(cookieOnly.body).not.toContain(handle.token);
  });

  it('does not accept the mutation token for reads or read-session bootstrap', async () => {
    const handle = await server(true);
    const read = await request(handle, 'GET', '/api/config/effective', {
      'x-ashlr-token': handle.token,
    });
    const bootstrap = await request(handle, 'POST', '/api/session', {
      'x-ashlr-token': handle.token,
    });
    expect(read.statusCode).toBe(401);
    expect(bootstrap.statusCode).toBe(401);
    expect(bootstrap.headers['set-cookie']).toBeUndefined();
  });

  it('requires exact cookie and client proof to clear a session', async () => {
    const handle = await server();
    const minted = await mintCookie(handle);
    const unauthenticated = await request(handle, 'DELETE', '/api/session');
    const wrongProof = await request(handle, 'DELETE', '/api/session', {
      Cookie: minted.cookie, 'x-ashlr-read-client': 'b'.repeat(64),
    });
    const cleared = await request(handle, 'DELETE', '/api/session', {
      Cookie: minted.cookie, 'x-ashlr-read-client': CLIENT_PROOF,
    });
    const unsupported = await request(handle, 'GET', '/api/session', {
      'x-ashlr-token': handle.readToken,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(wrongProof.statusCode).toBe(401);
    expect(cleared.statusCode).toBe(204);
    expect(cleared.headers['set-cookie']?.[0]).toContain('Max-Age=0');
    expect(cleared.headers['cache-control']).toBe('no-store');
    expect(unsupported.statusCode).toBe(405);
    expect(unsupported.headers.allow).toBe('POST, DELETE');
  });

  it('closes an authorized SSE stream at its exact signed session expiry', async () => {
    const mintedAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(mintedAt);
    const handle = await server();
    const minted = await mintCookie(handle);
    now.mockReturnValue(mintedAt + (15 * 60 * 1000) - 250);
    const stream = await persistentSse(handle, { Cookie: minted.cookie }, `/api/events?client=${CLIENT_PROOF}`);
    await stream.connected;
    const body = await Promise.race([
      stream.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE did not close at expiry')), 2_000)),
    ]);
    expect(body).toContain('event: session-expired');
  });

  it('rejects a session exactly at the expiry boundary', async () => {
    const mintedAt = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(mintedAt);
    const handle = await server();
    const minted = await mintCookie(handle);
    now.mockReturnValue(mintedAt + (15 * 60 * 1000));
    const response = await request(handle, 'GET', `/api/events?client=${CLIENT_PROOF}`, {
      Cookie: minted.cookie,
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(': connected');
  });

  it('revokes an already-open SSE stream when the session is deleted', async () => {
    const handle = await server();
    const minted = await mintCookie(handle);
    const stream = await persistentSse(handle, { Cookie: minted.cookie }, `/api/events?client=${CLIENT_PROOF}`);
    await stream.connected;
    expect((await request(handle, 'DELETE', '/api/session', {
      Cookie: minted.cookie, 'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(204);
    await Promise.race([
      stream.closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE survived logout')), 2_000)),
    ]);
    expect((await request(handle, 'GET', `/api/events?client=${CLIENT_PROOF}`, {
      Cookie: minted.cookie,
    })).statusCode).toBe(401);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: minted.cookie,
      'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(401);
  });

  it('logout revokes only the matching session and leaves a rival stream open', async () => {
    const handle = await server();
    const rivalProof = 'b'.repeat(64);
    const first = await mintCookie(handle, CLIENT_PROOF);
    const rival = await mintCookie(handle, rivalProof);
    const firstStream = await persistentSse(handle, { Cookie: first.cookie }, `/api/events?client=${CLIENT_PROOF}`);
    const rivalStream = await persistentSse(handle, { Cookie: rival.cookie }, `/api/events?client=${rivalProof}`);
    await Promise.all([firstStream.connected, rivalStream.connected]);
    expect((await request(handle, 'DELETE', '/api/session', {
      Cookie: first.cookie, 'x-ashlr-read-client': CLIENT_PROOF,
    })).statusCode).toBe(204);
    await firstStream.closed;
    const rivalState = await Promise.race([
      rivalStream.closed.then(() => 'closed'),
      new Promise<'open'>((resolve) => setTimeout(() => resolve('open'), 250)),
    ]);
    expect(rivalState).toBe('open');
    expect((await request(handle, 'GET', `/api/events?client=${CLIENT_PROOF}`, {
      Cookie: first.cookie,
    })).statusCode).toBe(401);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: rival.cookie,
      'x-ashlr-read-client': rivalProof,
    })).statusCode).toBe(200);
    rivalStream.destroy();
  });

  it('rotates the ticket signer and drains old streams when the revocation cap is exhausted', async () => {
    const handle = await server();
    const sessions: Array<Awaited<ReturnType<typeof mintCookie>>> = [];
    for (let i = 0; i < 66; i++) {
      sessions.push(await mintCookie(handle, i.toString(16).padStart(64, '0')));
    }

    // Fill the bounded revocation registry without touching the two sessions
    // used to prove the saturation response.
    for (let i = 0; i < 64; i++) {
      const current = sessions[i]!;
      expect((await request(handle, 'DELETE', '/api/session', {
        Cookie: current.cookie,
        'x-ashlr-read-client': current.clientProof,
      })).statusCode).toBe(204);
    }

    const overflow = sessions[64]!;
    const rival = sessions[65]!;
    const overflowStream = await persistentSse(
      handle,
      { Cookie: overflow.cookie },
      `/api/events?client=${overflow.clientProof}`,
    );
    const rivalStream = await persistentSse(
      handle,
      { Cookie: rival.cookie },
      `/api/events?client=${rival.clientProof}`,
    );
    await Promise.all([overflowStream.connected, rivalStream.connected]);

    expect((await request(handle, 'DELETE', '/api/session', {
      Cookie: overflow.cookie,
      'x-ashlr-read-client': overflow.clientProof,
    })).statusCode).toBe(204);
    await Promise.all([overflowStream.closed, rivalStream.closed]);

    // Rotation invalidates every ticket signed before saturation rather than
    // silently evicting an exact logout. The stable raw read capability can
    // immediately exchange for a new ticket under the fresh signer.
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: rival.cookie,
      'x-ashlr-read-client': rival.clientProof,
    })).statusCode).toBe(401);
    const fresh = await mintCookie(handle, rival.clientProof);
    expect(fresh.response.statusCode).toBe(204);
    expect((await request(handle, 'GET', '/api/config/effective', {
      Cookie: fresh.cookie,
      'x-ashlr-read-client': fresh.clientProof,
    })).statusCode).toBe(200);
  });
});

describe('browser transport contract', () => {
  it('uses header-authenticated reads and cookie-backed EventSource without token URLs', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/core/web/public/app.js', 'utf8');
    expect(source).toContain("headers['x-ashlr-token'] = token");
    expect(source).toContain("headers['x-ashlr-read-client'] = clientProof");
    expect(source).toContain("fetch(API_BASE + '/api/session'");
    expect(source).toContain('window.crypto.getRandomValues(bytes)');
    expect(source).toContain('new EventSource(`/api/events?client=${encodeURIComponent(clientProof)}`)');
    expect(source).not.toMatch(/EventSource\([^\n]*(token|ashlr-token)/i);
    expect(source).not.toMatch(/[?&](token|ashlr-token)=/i);
    expect(source).toContain("const READ_TOKEN_STORAGE_KEY = 'ashlr-read-token'");
    expect(source).toContain("const READ_CLIENT_STORAGE_KEY = 'ashlr-read-client'");
    expect(source).not.toContain('let mutationToken');
    expect(source).not.toContain('clearMutationToken');
    expect(source).not.toMatch(/sessionStorage\.(setItem|getItem)\([^\n]*mutation/i);
  });

  it('prompts independently for two consecutive mutation actions', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/core/web/public/app.js', 'utf8');
    const functionSource = source.match(/function promptMutationToken\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(functionSource).toBeTruthy();

    const prompt = vi.fn()
      .mockReturnValueOnce('  first-action-token  ')
      .mockReturnValueOnce('second-action-token');
    const factory = new Function(
      'window',
      `'use strict'; ${functionSource}; return promptMutationToken;`,
    ) as (window: { prompt: typeof prompt }) => () => string;
    const perActionPrompt = factory({ prompt });

    expect(perActionPrompt()).toBe('first-action-token');
    expect(perActionPrompt()).toBe('second-action-token');
    expect(prompt).toHaveBeenCalledTimes(2);
  });
});
