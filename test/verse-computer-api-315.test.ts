/**
 * 3.15 desktop control — `/api/verse/computer*` through the REAL server (a
 * loopback bind; registered in the real-io lane), under a relocated HOME.
 *
 * The load-bearing claims:
 *   - every route keeps the normal posture: GETs need the read session,
 *     POSTs the mutation token (and dispatch), bodies are strict — there is
 *     no token-less seat endpoint in this family;
 *   - end to end: a `computer_*` tool call → relay → the Verse window's
 *     long-poll → the window's answer → the tool's result, including the
 *     access sheet making a grant;
 *   - KILL over HTTP revokes every grant and fails what is waiting.
 * No desktop is involved: the "window" is this test answering the poll.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { computerGrantsFor, resetComputerBridgeForTest } from '../src/core/verse/computer-bridge.js';
import type { VerseComputerCommand } from '../src/core/verse/computer-types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import { tools } from '../src/core/verse/verse-mcp-computer.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

interface HttpResult { status: number; json: unknown; text: string }

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
        resolve({ status: res.statusCode ?? 0, json, text });
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

const tool = (name: string) => tools.find((t) => t.name === name)!;

describe('computer routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let handles: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-computer-home-')));
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
    resetComputerBridgeForTest();
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    resetComputerBridgeForTest();
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

  it('keeps the normal posture: read session for GETs, the mutation token for POSTs, strict bodies', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const mutate = { 'x-ashlr-token': handle.token };

    expect((await request(handle.port, 'GET', '/api/verse/computer/state')).status).toBe(401);
    const state = await request(handle.port, 'GET', '/api/verse/computer/state', read);
    expect(state.status).toBe(200);
    expect(state.json).toEqual({ windowPresent: false, chats: [] });
    expect((await request(handle.port, 'GET', '/api/verse/computer/state?x=1', read)).status).toBe(400);
    expect((await request(handle.port, 'GET', '/api/verse/computer/commands?wait=99999', read)).status).toBe(400);

    expect((await request(handle.port, 'POST', '/api/verse/computer/kill', {}, {})).status).toBe(401);
    expect((await request(handle.port, 'POST', '/api/verse/computer/kill', mutate, { all: true })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/computer/kill', mutate, {})).status).toBe(200);
    expect((await request(handle.port, 'POST', '/api/verse/computer/revoke', mutate, { sessionId: 's-1', bundleId: '../x' })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/computer/result', mutate, { id: 'cc_AAAAAAAAAAAA', ok: true })).status).toBe(404);
    expect((await request(handle.port, 'POST', '/api/verse/computer/result', mutate, { id: 'nope', ok: true })).status).toBe(400);
    expect((await request(handle.port, 'POST', '/api/verse/computer/result', mutate, { id: 'cc_AAAAAAAAAAAA', ok: true, extra: 1 })).status).toBe(400);
  });

  it('a read-only server (no dispatch) refuses every POST', async () => {
    const handle = await boot(false);
    expect((await request(handle.port, 'POST', '/api/verse/computer/kill', { 'x-ashlr-token': handle.token }, {})).status).toBe(404);
  });

  it('end to end: request_access → the window\'s sheet → a grant; a click after KILL fails as stopped', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const mutate = { 'x-ashlr-token': handle.token };

    // No window polling yet: an immediate, actionable refusal.
    const early = await tool('computer_list_apps').handler({}, { sessionId: 's-1' });
    expect(early.isError).toBe(true);
    expect(JSON.stringify(early)).toMatch(/Verse window is not open/);

    const pollOnce = async (): Promise<VerseComputerCommand> => {
      const polled = await request(handle.port, 'GET', '/api/verse/computer/commands?wait=5000', read);
      expect(polled.status).toBe(200);
      const [command] = (polled.json as { commands: VerseComputerCommand[] }).commands;
      return command!;
    };

    // The window polls (and keeps polling as the tool's two steps arrive).
    const firstPoll = pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    const call = tool('computer_request_access').handler({ apps: ['Notes'], reason: 'write the list' }, { sessionId: 's-1' });

    const list = await firstPoll;
    expect(list).toMatchObject({ kind: 'native', sessionId: 's-1', op: { op: 'list-apps', req: list.id } });
    const secondPoll = pollOnce();
    await request(handle.port, 'POST', '/api/verse/computer/result', mutate, {
      id: list.id, ok: true, data: { apps: [{ bundleId: 'com.apple.Notes', name: 'Notes', pid: 7, active: false, hidden: false, path: '/System/Applications/Notes.app/Contents/MacOS/Notes' }] },
    });

    const sheet = await secondPoll;
    expect(sheet).toMatchObject({ kind: 'access', apps: [{ bundleId: 'com.apple.Notes', tier: 'full', running: true }], reason: 'write the list' });
    const answered = await request(handle.port, 'POST', '/api/verse/computer/result', mutate, { id: sheet.id, ok: true, data: { approved: [{ bundleId: 'com.apple.Notes', tier: 'full' }] } });
    expect(answered.status).toBe(200);
    const result = await call;
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toMatch(/Notes \(com\.apple\.Notes\): full control/);
    expect(computerGrantsFor('s-1')).toEqual([{ bundleId: 'com.apple.Notes', tier: 'full' }]);

    const state = await request(handle.port, 'GET', '/api/verse/computer/state', read);
    expect(state.json).toMatchObject({ windowPresent: true, chats: [{ sessionId: 's-1', grants: [{ bundleId: 'com.apple.Notes', tier: 'full' }] }] });

    // KILL over HTTP: grants gone; the next tool call is refused before anything is queued.
    const killed = await request(handle.port, 'POST', '/api/verse/computer/kill', mutate, {});
    expect(killed.json).toMatchObject({ chats: [] });
    const after = await tool('computer_screenshot').handler({}, { sessionId: 's-1' });
    expect(JSON.stringify(after)).toMatch(/no desktop access yet/);
  });
});
