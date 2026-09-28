/**
 * 3.15 integrated Browser pane — the routes, through the REAL server (a
 * loopback bind; registered in the real-io lane), under a relocated HOME.
 *
 * The load-bearing security claims:
 *   - the page's routes keep the normal posture (read session for GETs,
 *     dispatch + mutation token for POSTs, strict bodies);
 *   - the retired Browser grant endpoint answers 410 for every grant and
 *     cannot queue a command, even when an old seat still has the URL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { setBrowserDevServerListerForTest } from '../src/core/verse/browser-api.js';
import { browserSeatLaunch, claimBrowserCommands, resetBrowserBridgeForTest } from '../src/core/verse/browser-bridge.js';
import { agentToolScopes, mintVerseMcpTurn, resetVerseMcpGrantsForTest, revokeAllVerseMcpTurns } from '../src/core/verse/verse-mcp-grants.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

interface HttpResult { status: number; json: unknown; headers: http.IncomingHttpHeaders; text: string }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {}, tools: {}, verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

describe('browser routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let handles: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-browser-home-')));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const project = path.join(tmpHome, 'proj');
    fs.mkdirSync(project, { recursive: true });
    const session = {
      id: 's-1', title: 'chat', projectPath: project, engine: 'claude', accountId: 'a', seatId: 'claude-a', model: 'm',
      nativeSessionId: null, createdAt: 'x', updatedAt: 'y', status: 'idle', turnCount: 1, usage: {}, lastError: null,
    } as unknown as VerseSession;
    resetVerseEngine({
      listSessions: () => [session],
      getSession: (id: string) => (id === 's-1' ? session : null),
      getEvents: () => [],
      subscribe: () => () => {},
      close: () => {},
    } as unknown as VerseEngineHandle);
    invalidateVerseSeatCache();
    resetBrowserBridgeForTest();
    resetVerseMcpGrantsForTest();
    setBrowserDevServerListerForTest(async () => [{ label: 'npm run dev', url: 'http://localhost:5173/', running: true }]);
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    resetBrowserBridgeForTest();
    resetVerseMcpGrantsForTest();
    setBrowserDevServerListerForTest(null);
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function boot(allowDispatch = true) {
    const cfgRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(cfgRoot, { recursive: true });
    fs.writeFileSync(path.join(cfgRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const handle = await startServer(makeConfig(cfgRoot), { port: 0, open: false, allowDispatch });
    handles.push(handle);
    return handle;
  }

  const grantOf = (): string => {
    const launch = browserSeatLaunch('s-1');
    if (!launch) throw new Error('no grant');
    return String((JSON.parse(launch.mcpConfig) as { mcpServers: Record<string, { url: string }> }).mcpServers['ashlr-browser']!.url.split('/').pop());
  };

  it('page routes: read session for GETs, the mutation token for POSTs, strict bodies', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const mutate = { 'x-ashlr-token': handle.token };

    expect((await request(handle.port, 'GET', '/api/verse/browser/policy?sessionId=s-1')).status).toBe(401);
    const policy = await request(handle.port, 'GET', '/api/verse/browser/policy?sessionId=s-1', read);
    expect(policy.status).toBe(200);
    expect(policy.json).toMatchObject({ sessionId: 's-1', agentAccess: false, allowedOrigins: [] });
    expect((await request(handle.port, 'GET', '/api/verse/browser/policy?sessionId=nope', read)).status).toBe(404);
    expect((await request(handle.port, 'GET', '/api/verse/browser/policy?sessionId=s-1&x=1', read)).status).toBe(400);

    expect((await request(handle.port, 'POST', '/api/verse/browser/access', {}, { sessionId: 's-1', enabled: true })).status).toBe(401);
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: 'yes' })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true, extra: 1 })).status).toBe(400);
    const on = await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ agentAccess: true });
    // The grant never reaches the page.
    expect(on.text).not.toContain(grantOf());
    expect(browserSeatLaunch('s-1')!.mcpConfig).toContain(`http://127.0.0.1:${handle.port}/api/verse/browser/mcp/`);

    const allow = await request(handle.port, 'POST', '/api/verse/browser/allow', mutate, { sessionId: 's-1', origin: 'https://example.com/x', allowed: true });
    expect(allow.json).toMatchObject({ allowedOrigins: ['https://example.com'] });
    expect((await request(handle.port, 'POST', '/api/verse/browser/allow', mutate, { sessionId: 's-1', origin: 'file:///etc', allowed: true })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/browser/result', mutate, { sessionId: 's-1', id: 'bc_AAAAAAAAAAAA', ok: true })).status).toBe(404);

    // 3.15 P2/P3 scopes: acting comes on with access; scripts need their own switch.
    expect(on.json).toMatchObject({ actAccess: true, scriptAccess: false, allowances: [] });
    expect(agentToolScopes('s-1')).toContain('browser_act');
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true, scope: 'root' })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', {}, { sessionId: 's-1', enabled: true, scope: 'browser_script' })).status).toBe(401);
    const scripts = await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true, scope: 'browser_script' });
    expect(scripts.json).toMatchObject({ agentAccess: true, actAccess: true, scriptAccess: true });
    expect(agentToolScopes('s-1')).toContain('browser_script');
    const noAct = await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: false, scope: 'browser_act' });
    expect(noAct.json).toMatchObject({ agentAccess: true, actAccess: false, scriptAccess: false });
    expect(agentToolScopes('s-1')).not.toContain('browser_act');
    expect(agentToolScopes('s-1')).not.toContain('browser_script');
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true, scope: 'browser_script' })).status).toBe(409);
    expect((await request(handle.port, 'POST', '/api/verse/browser/allowance', mutate, { sessionId: 's-1', key: '' })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/browser/allowance', mutate, { sessionId: 's-1', key: 'submit@http://localhost:5173', x: 1 })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/browser/allowance', mutate, { sessionId: 's-1', key: 'submit@http://localhost:5173' })).json).toMatchObject({ allowances: [] });
    // A scope cannot be switched on without the grant.
    await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: false });
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', mutate, { sessionId: 's-1', enabled: true, scope: 'browser_act' })).status).toBe(409);
  });

  it('a read-only server (no dispatch) refuses every POST, the MCP endpoint included', async () => {
    const handle = await boot(false);
    expect((await request(handle.port, 'POST', '/api/verse/browser/access', { 'x-ashlr-token': handle.token }, { sessionId: 's-1', enabled: true })).status).toBe(404);
    expect((await request(handle.port, 'POST', `/api/verse/browser/mcp/${'A'.repeat(43)}`, {}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
  });

  it('retired Browser MCP grant cannot act before or after Stop', async () => {
    const handle = await boot();
    await request(handle.port, 'POST', '/api/verse/browser/access', { 'x-ashlr-token': handle.token }, { sessionId: 's-1', enabled: true });
    const grant = grantOf();
    const mcp = `/api/verse/browser/mcp/${grant}`;
    expect(mintVerseMcpTurn('s-1', 'claude')).not.toBeNull();
    const attempt = () => request(handle.port, 'POST', mcp, {}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'http://localhost:5173/settings' } } });
    expect((await attempt()).status).toBe(410);
    expect((await request(handle.port, 'GET', mcp)).status).toBe(410);
    expect(await claimBrowserCommands('s-1', { waitMs: 0 })).toEqual([]);
    revokeAllVerseMcpTurns('Stop');
    expect((await attempt()).status).toBe(410);
    expect(await claimBrowserCommands('s-1', { waitMs: 0 })).toEqual([]);
    // The 410 exception is limited to the old exact path shape.
    expect((await request(handle.port, 'POST', `${mcp}/x`, {}, {})).status).toBe(401);
  });
});
