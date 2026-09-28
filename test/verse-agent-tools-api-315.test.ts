/**
 * 3.15 agent tools — the routes, through the REAL server (a loopback bind;
 * registered in the real-io lane), under a relocated HOME, plus the stdio
 * bridge relaying to that server.
 *
 * The load-bearing security claims:
 *   - the page's routes keep the normal posture (read session for GETs,
 *     dispatch + mutation token for POSTs, strict bodies);
 *   - the MCP endpoint is authenticated by the turn's bearer token alone: no
 *     token / unknown / revoked → 404 (never 401), a browser Origin → 403,
 *     GET → 405 without a read session; a sibling path still needs the token;
 *   - the kill switch refuses every call and revokes the token;
 *   - confirmations are answered only through the page's token-gated route;
 *   - the stdio bridge relays with the bearer from a token FILE and falls
 *     back to "no tools" when the turn is gone.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { resetBrowserBridgeForTest } from '../src/core/verse/browser-bridge.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { setVerseMcpApiDepsForTest } from '../src/core/verse/verse-mcp-api.js';
import {
  mintVerseMcpTurn,
  pendingConfirmations,
  requestAgentConfirmation,
  resetVerseMcpGrantsForTest,
  turnForBearer,
} from '../src/core/verse/verse-mcp-grants.js';
import { codexVerseMcpOverrides, verseMcpTokenFile } from '../src/core/verse/verse-mcp-launch.js';
import { runVerseMcpStdio, VERSE_MCP_TOKEN_FILE_ENV, VERSE_MCP_RESOLVE_ENV, VERSE_MCP_DIR_ENV, VERSE_MCP_RUNNING_FILE_ENV, type VerseMcpStdioIo } from '../src/core/verse/verse-mcp-stdio.js';
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

const MCP = '/api/verse/agent-tools/mcp';

describe('agent tools through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let handles: Array<{ close(): Promise<void> }> = [];
  let killed = false;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-agent-tools-home-')));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    const project = path.join(tmpHome, 'proj');
    fs.mkdirSync(project, { recursive: true });
    const session = {
      id: 's-1', title: 'chat', projectPath: project, engine: 'codex', accountId: 'a', seatId: 'codex-a', model: 'm',
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
    killed = false;
    setVerseMcpApiDepsForTest({ killSwitch: async () => killed });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    resetBrowserBridgeForTest();
    resetVerseMcpGrantsForTest();
    setVerseMcpApiDepsForTest(null);
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
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

  it('the sheet\'s routes: read session for GETs, the mutation token for POSTs, strict bodies', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const mutate = { 'x-ashlr-token': handle.token };

    expect((await request(handle.port, 'GET', '/api/verse/agent-tools/grant?sessionId=s-1')).status).toBe(401);
    const state = await request(handle.port, 'GET', '/api/verse/agent-tools/grant?sessionId=s-1', read);
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ sessionId: 's-1', scopes: [], grant: { terminal: 'off', browser: 'off' }, support: { supported: true, transport: 'stdio' }, turnActive: false });
    expect((await request(handle.port, 'GET', '/api/verse/agent-tools/grant?sessionId=nope', read)).status).toBe(404);
    expect((await request(handle.port, 'GET', '/api/verse/agent-tools/grant?sessionId=s-1&x=1', read)).status).toBe(400);

    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/grant', {}, { sessionId: 's-1', terminal: 'agent' })).status).toBe(401);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'everything' })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'agent', extra: 1 })).status).toBe(400);
    const on = await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'agent', browser: 'look' });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ scopes: ['terminal', 'browser'], grant: { terminal: 'agent', browser: 'look' } });
    // The Browser pane's switch followed.
    const policy = await request(handle.port, 'GET', '/api/verse/browser/policy?sessionId=s-1', read);
    expect(policy.json).toMatchObject({ agentAccess: true });

    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/share', mutate, { sessionId: 's-1', tabId: 't-abc', shared: true })).status).toBe(404);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/confirm', mutate, { sessionId: 's-1', id: 'cf_AAAAAAAAAAAA', answer: 'once' })).status).toBe(404);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/confirm', mutate, { sessionId: 's-1', id: 'cf_AAAAAAAAAAAA', answer: 'yes' })).status).toBe(400);
    expect((await request(handle.port, 'GET', '/api/verse/agent-tools/tabs', read)).json).toEqual({ tabs: [] });
  });

  it('the endpoint: bearer only, 404 (never 401) without a live token, Origin refused, GET 405, exact path only', async () => {
    const handle = await boot();
    const mutate = { 'x-ashlr-token': handle.token };
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'agent' });
    const cred = mintVerseMcpTurn('s-1', 'codex')!;
    expect(cred.url).toBe(`http://127.0.0.1:${handle.port}${MCP}`);
    const bearer = { Authorization: `Bearer ${cred.token}` };

    const init = await request(handle.port, 'POST', MCP, bearer, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ result: { serverInfo: { name: 'ashlr-verse' } } });
    const list = await request(handle.port, 'POST', MCP, bearer, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain('terminal_run');
    expect(names.some((n) => n.startsWith('browser_'))).toBe(false);
    // Under Node there is no PTY: the terminal tools say so.
    const call = await request(handle.port, 'POST', MCP, bearer, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terminal_list', arguments: {} } });
    expect(JSON.stringify(call.json)).toMatch(/desktop app/);

    const get = await request(handle.port, 'GET', MCP);
    expect(get.status).toBe(405);
    expect(get.headers['allow']).toBe('POST');
    expect((await request(handle.port, 'POST', MCP, {}, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    expect((await request(handle.port, 'POST', MCP, { Authorization: `Bearer ${'A'.repeat(43)}` }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(404);
    expect((await request(handle.port, 'POST', MCP, { ...bearer, Origin: 'https://evil.example' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(403);
    expect((await request(handle.port, 'POST', MCP, { ...bearer, 'Content-Type': 'text/plain' }, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(415);
    // The gate exemption is the exact path: a sibling still needs the Verse token.
    expect((await request(handle.port, 'POST', `${MCP}/x`, bearer, {})).status).toBe(401);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/grant', bearer, { sessionId: 's-1', terminal: 'shared' })).status).toBe(401);

    // Tools off → the token dies with them.
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'off' });
    expect((await request(handle.port, 'POST', MCP, bearer, { jsonrpc: '2.0', id: 4, method: 'ping' })).status).toBe(404);
  });

  it('the kill switch refuses the call and revokes the token', async () => {
    const handle = await boot();
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', { 'x-ashlr-token': handle.token }, { sessionId: 's-1', terminal: 'agent' });
    const cred = mintVerseMcpTurn('s-1', 'codex')!;
    killed = true;
    const call = await request(handle.port, 'POST', MCP, { Authorization: `Bearer ${cred.token}` }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'terminal_list', arguments: {} } });
    expect(JSON.stringify(call.json)).toMatch(/kill switch/);
    expect(turnForBearer(cred.token)).toBeNull();
  });

  it('a confirmation shows in the chat\'s activity and is answered through the token-gated route', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const mutate = { 'x-ashlr-token': handle.token };
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', mutate, { sessionId: 's-1', terminal: 'agent' });
    const answer = requestAgentConfirmation('s-1', { tool: 'terminal_run', rule: 'rm-recursive', reason: 'It deletes files.', command: 'rm -rf build', tabId: null });
    const activity = await request(handle.port, 'GET', '/api/verse/agent-tools/activity?sessionId=s-1', read);
    const pending = (activity.json as { pending: Array<{ id: string; command: string }> }).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.command).toBe('rm -rf build');
    // The agent cannot answer its own question: no token, no route.
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/confirm', {}, { sessionId: 's-1', id: pending[0]!.id, answer: 'once' })).status).toBe(401);
    expect((await request(handle.port, 'POST', '/api/verse/agent-tools/confirm', mutate, { sessionId: 's-1', id: pending[0]!.id, answer: 'once' })).status).toBe(200);
    expect(await answer).toBe('once');
    expect(pendingConfirmations('s-1')).toEqual([]);
  });

  it('the stdio bridge relays with the token FILE Codex is given, and answers "no tools" once the turn is gone', async () => {
    const handle = await boot();
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', { 'x-ashlr-token': handle.token }, { sessionId: 's-1', terminal: 'agent' });
    const overrides = codexVerseMcpOverrides('s-1');
    const envArg = overrides.find((a) => a.includes('ASHLR_VERSE_MCP_TOKEN_FILE='))!;
    const tokenFile = JSON.parse(envArg.slice(envArg.indexOf('=') + 1)) as string;
    expect(tokenFile).toBe(verseMcpTokenFile('s-1'));

    const run = async (lines: string[], env: NodeJS.ProcessEnv, ppid = 1): Promise<unknown[]> => {
      const out: unknown[] = [];
      const io: VerseMcpStdioIo = {
        lines: (async function* () { for (const l of lines) yield l; })(),
        write: (line) => out.push(JSON.parse(line)),
        env,
        ppid,
        readFile: (p) => fs.promises.readFile(p, 'utf8'),
        fetch: globalThis.fetch.bind(globalThis),
      };
      await runVerseMcpStdio(io);
      // Requests run concurrently: answers come back in completion order, so index them by id.
      return out.sort((a, b) => Number((a as { id: number }).id) - Number((b as { id: number }).id));
    };
    const msgs = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    ];
    const live = await run(msgs, { [VERSE_MCP_TOKEN_FILE_ENV]: tokenFile });
    expect(live).toHaveLength(2);
    expect(JSON.stringify(live[1])).toContain('terminal_run');

    // Grok's route: the parent pid names the chat in running.json.
    const runDir = path.dirname(tokenFile);
    const running = path.join(tmpHome, 'running.json');
    fs.writeFileSync(running, JSON.stringify({ v: 1, entries: [{ kind: 'turn', sessionId: 's-1', turnId: 't', pid: 4242, pgid: 4242, markers: [], spawnedAt: 0, serverPid: 1, serverStartedAt: null }] }));
    const grokEnv = { [VERSE_MCP_RESOLVE_ENV]: 'parent', [VERSE_MCP_DIR_ENV]: runDir, [VERSE_MCP_RUNNING_FILE_ENV]: running };
    expect(JSON.stringify((await run(msgs, grokEnv, 4242))[1])).toContain('terminal_run');
    expect((await run(msgs, grokEnv, 999))[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });

    // A token file pointing anywhere but loopback Verse is ignored.
    const evil = path.join(tmpHome, 'evil.json');
    fs.writeFileSync(evil, JSON.stringify({ url: 'http://evil.example/api/verse/agent-tools/mcp', token: JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token }));
    expect((await run(msgs, { [VERSE_MCP_TOKEN_FILE_ENV]: evil }))[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });

    // Turn over: the bridge still answers, with no tools and a readable refusal.
    await request(handle.port, 'POST', '/api/verse/agent-tools/grant', { 'x-ashlr-token': handle.token }, { sessionId: 's-1', terminal: 'off' });
    const gone = await run([...msgs, JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'terminal_list' } })], { [VERSE_MCP_TOKEN_FILE_ENV]: tokenFile });
    expect(gone[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    expect(JSON.stringify(gone[2])).toMatch(/not available to this turn/);
  });
});
