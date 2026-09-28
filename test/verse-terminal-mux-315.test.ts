/**
 * 3.15 — the terminal routes added for six panes, history and plain language,
 * through the REAL server (fake PTYs, fake models, a relocated HOME):
 *
 *   GET  /api/verse/terminal/stream?tabs=…   one SSE, tab-tagged frames, per-tab resume,
 *                                           `gone` per tab, ends when none is left
 *   GET  /api/verse/terminal/history         ranked, off → empty
 *   POST /api/verse/terminal/history/clear   mutation token only
 *   GET|POST /api/verse/terminal/settings
 *   POST /api/verse/terminal/assist          mutation token only; context scrubbed;
 *                                           text back, nothing typed into the shell
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig, ChatMessage } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import {
  createTerminalManager,
  recordFinishedCommand,
  setTerminalManagerForTest,
  type PtyExit,
  type PtyHandle,
  type PtySpawnOptions,
  type TerminalManager,
} from '../src/core/verse/terminal.js';
import { setTerminalApiDepsForTest } from '../src/core/verse/terminal-api.js';
import { setTerminalHistoryForTest } from '../src/core/verse/terminal-history.js';
import { resetTerminalSettingsCacheForTest } from '../src/core/verse/terminal-settings.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { resetPreviewCaches } from '../src/core/verse/preview.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const SECRET = 'ghp_' + 'B'.repeat(36);

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  written: string[];
  emit(text: string): void;
  exit(result: PtyExit): void;
}

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => FakePty; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  const spawn = (opts: PtySpawnOptions): FakePty => {
    let resolveExit!: (value: PtyExit) => void;
    const exited = new Promise<PtyExit>((r) => { resolveExit = r; });
    const pty: FakePty = {
      pid: 7000 + spawned.length,
      opts,
      written: [],
      write(data) { pty.written.push(new TextDecoder().decode(data)); },
      resize() {},
      close() {},
      exited,
      emit(text) { opts.onData(new TextEncoder().encode(text)); },
      exit(result) { resolveExit(result); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawn, spawned };
}

interface HttpResult { status: number; body: string; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body: raw, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface Frame { event: string; data: Record<string, unknown> }

/** Collect SSE frames (comments skipped) until `until` says stop or the server ends it. */
function streamFrames(port: number, urlPath: string, headers: Record<string, string>, until: (frames: Frame[]) => boolean, onOpen?: () => void): Promise<{ status: number; frames: Frame[]; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = '';
      let done = false;
      const finish = (ended: boolean) => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode ?? 0, frames, ended });
        req.destroy();
      };
      onOpen?.();
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith(':')) continue;
          const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) frames.push({ event, data: JSON.parse(data) as Record<string, unknown> });
        }
        if (until(frames)) finish(false);
      });
      res.on('end', () => finish(true));
    });
    req.on('error', (err) => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    req.end();
  });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const osc = (payload: string) => `\x1b]${payload}\x07`;
const PROMPT = `${osc('133;A')}% ${osc('133;B')}`;
const decode = (f: Frame) => Buffer.from(String(f.data['dataBase64']), 'base64').toString('utf8');

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function engineWith(sessions: VerseSession[]): VerseEngineHandle {
  return {
    listSessions: () => sessions,
    getSession: (id: string) => sessions.find((s) => s.id === id) ?? null,
    getEvents: () => [],
    subscribe: () => () => {},
    close: () => {},
  } as unknown as VerseEngineHandle;
}

function sessionAt(id: string, projectPath: string): VerseSession {
  return {
    id, title: 'chat', projectPath, engine: 'claude', accountId: 'a', seatId: 'claude-a', model: 'm',
    nativeSessionId: null, createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
    status: 'idle', turnCount: 0, usage: {}, lastError: null,
  } as unknown as VerseSession;
}

describe('terminal 3.15 routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let project: string;
  let handles: Array<{ close(): Promise<void> }> = [];
  let fake: ReturnType<typeof fakeSpawner>;
  let m: TerminalManager;
  let seen: ChatMessage[][];
  let localText: string | null;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-terminal-mux-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    project = path.join(tmpHome, 'proj');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    resetVerseEngine(engineWith([sessionAt('s-1', project)]));
    invalidateVerseSeatCache();
    resetPreviewCaches();
    resetTerminalSettingsCacheForTest();
    setTerminalHistoryForTest(null);
    fake = fakeSpawner();
    m = createTerminalManager({
      spawner: fake.spawn,
      registry: null,
      env: async () => ({ PATH: '/usr/bin:/bin', HOME: tmpHome }),
      shell: () => '/bin/zsh',
      kill: () => {},
      exists: () => false,
      listDescendants: async () => [],
      frameIntervalMs: 0,
      startCommandWaitMs: 20,
      shellIntegration: null,
      // Exactly what the process's manager does: history under the (relocated) HOME.
      onCommandFinished: recordFinishedCommand,
    });
    setTerminalManagerForTest(m);
    seen = [];
    localText = '{"command":"du -sh * | sort -h","explanation":"Sizes, largest last.","risky":false}';
    setTerminalApiDepsForTest({
      platform: 'darwin',
      devServers: { listListeners: async () => [] },
      assist: {
        local: async () => (localText === null ? null : async (messages) => {
          seen.push(messages);
          return { text: localText!, model: 'local:test-model' };
        }),
        grok: async () => null,
      },
    });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    setTerminalManagerForTest(null);
    setTerminalApiDepsForTest(null);
    setTerminalHistoryForTest(null);
    resetTerminalSettingsCacheForTest();
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function boot() {
    const cfgRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(cfgRoot, { recursive: true });
    fs.writeFileSync(path.join(cfgRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const handle = await startServer(makeConfig(cfgRoot), { port: 0, open: false, allowDispatch: true });
    handles.push(handle);
    return {
      port: handle.port,
      read: readAuthHeaders(handle.port),
      mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' },
    };
  }

  async function openTab(port: number, mutate: Record<string, string>): Promise<{ id: string; pty: FakePty }> {
    const res = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    expect(res.status).toBe(201);
    return { id: (res.json as { tab: { id: string } }).tab.id, pty: fake.spawned.at(-1)! };
  }

  // -------------------------------------------------------------------------
  // The multiplexed stream
  // -------------------------------------------------------------------------

  it('one stream carries several tabs, each resumed past its own seq, tagged by tab', async () => {
    const { port, read, mutate } = await boot();
    const a = await openTab(port, mutate);
    const b = await openTab(port, mutate);
    a.pty.emit('a1 ');
    a.pty.emit('a2 ');
    b.pty.emit('b1 ');
    const res = await streamFrames(port, `/api/verse/terminal/stream?tabs=${a.id}:1,${b.id}`, read,
      (f) => f.filter((x) => x.event === 'title').length === 2);
    expect(res.status).toBe(200);
    const outputs = res.frames.filter((f) => f.event === 'output');
    expect(outputs.map((f) => [f.data['tab'], decode(f)])).toEqual([[a.id, 'a2 '], [b.id, 'b1 ']]);
    expect(res.frames.every((f) => f.data['tab'] === a.id || f.data['tab'] === b.id)).toBe(true);
  });

  it('live frames for every tab; a killed tab ends with exit + gone while the others go on; the last one ends the stream', async () => {
    const { port, read, mutate } = await boot();
    const a = await openTab(port, mutate);
    const b = await openTab(port, mutate);
    const live = streamFrames(port, `/api/verse/terminal/stream?tabs=${a.id},${b.id}`, read, () => false);
    await tick(60);
    a.pty.emit('from a');
    b.pty.emit('from b');
    await tick(20);
    expect((await request(port, 'POST', `/api/verse/terminal/${a.id}/kill`, mutate, '{}')).status).toBe(200);
    await tick(20);
    b.pty.emit('b still here');
    await tick(20);
    expect((await request(port, 'POST', `/api/verse/terminal/${b.id}/kill`, mutate, '{}')).status).toBe(200);
    const result = await live;
    expect(result.ended).toBe(true);
    const texts = result.frames.filter((f) => f.event === 'output').map((f) => `${f.data['tab']}:${decode(f)}`);
    expect(texts).toEqual([`${a.id}:from a`, `${b.id}:from b`, `${b.id}:b still here`]);
    const aGone = result.frames.findIndex((f) => f.event === 'gone' && f.data['tab'] === a.id);
    const aExit = result.frames.findIndex((f) => f.event === 'exit' && f.data['tab'] === a.id);
    expect(aExit).toBeGreaterThanOrEqual(0);
    expect(aGone).toBeGreaterThan(aExit);
    expect(result.frames.at(-1)).toMatchObject({ event: 'gone', data: { tab: b.id } });
  });

  it('an unknown tab is `gone` at once; nothing known ends the stream; a malformed list is a 400', async () => {
    const { port, read, mutate } = await boot();
    const a = await openTab(port, mutate);
    const mixed = await streamFrames(port, `/api/verse/terminal/stream?tabs=t-000000000000,${a.id}`, read, (f) => f.some((x) => x.event === 'title'));
    expect(mixed.frames[0]).toMatchObject({ event: 'gone', data: { tab: 't-000000000000' } });
    const none = await streamFrames(port, '/api/verse/terminal/stream?tabs=t-000000000000', read, () => false);
    expect(none.ended).toBe(true);
    expect(none.frames).toEqual([{ event: 'gone', data: { tab: 't-000000000000', type: 'gone' } }]);
    expect((await request(port, 'GET', '/api/verse/terminal/stream?tabs=../x', read)).status).toBe(400);
    expect((await request(port, 'GET', '/api/verse/terminal/stream', read)).status).toBe(400);
    // The per-tab route still answers (older pages).
    const single = await streamFrames(port, `/api/verse/terminal/${a.id}/stream`, read, (f) => f.some((x) => x.event === 'title'));
    expect(single.status).toBe(200);
  });

  it('the stream needs the read session', async () => {
    const { port, mutate } = await boot();
    const a = await openTab(port, mutate);
    expect((await request(port, 'GET', `/api/verse/terminal/stream?tabs=${a.id}`, {})).status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // History + settings
  // -------------------------------------------------------------------------

  it('a finished command lands in history (scrubbed, ranked for its cwd); clear and settings are mutations', async () => {
    const { port, read, mutate } = await boot();
    const a = await openTab(port, mutate);
    a.pty.emit(`${osc(`633;P;Cwd=${project}`)}${PROMPT}`);
    a.pty.emit(`gh auth login --with-token ${SECRET}\r\n${osc('133;C')}ok\r\n${osc('133;D;0')}${PROMPT}`);
    a.pty.emit(`git status\r\n${osc('133;C')}clean\r\n${osc('133;D;0')}${PROMPT}`);
    await tick(50);

    const listed = await request(port, 'GET', `/api/verse/terminal/history?q=g&cwd=${encodeURIComponent('~/proj')}`, read);
    expect(listed.status).toBe(200);
    const body = listed.json as { enabled: boolean; entries: Array<{ cmd: string; here: boolean; sameRepo: boolean; cwd: string }> };
    expect(body.enabled).toBe(true);
    expect(body.entries.map((e) => e.cmd).sort()).toEqual(['gh auth login --with-token [REDACTED]', 'git status']);
    expect(body.entries[0]).toMatchObject({ here: true, sameRepo: true, cwd: '~/proj' });
    const prefix = await request(port, 'GET', '/api/verse/terminal/history?q=git', read);
    expect((prefix.json as { entries: Array<{ cmd: string }> }).entries.map((e) => e.cmd)).toEqual(['git status']);
    expect(listed.body).not.toContain(SECRET);
    const onDisk = fs.readFileSync(path.join(tmpHome, '.ashlr', 'verse', 'terminal-history.jsonl'), 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk.split('\n').filter(Boolean)).toHaveLength(2);

    expect((await request(port, 'GET', '/api/verse/terminal/history?limit=0', read)).status).toBe(400);
    expect((await request(port, 'GET', '/api/verse/terminal/history?q=a&q=b', read)).status).toBe(400);

    // Clear: the mutation token, then nothing is left.
    expect((await request(port, 'POST', '/api/verse/terminal/history/clear', { 'content-type': 'application/json' }, '{}')).status).toBe(401);
    expect((await request(port, 'POST', '/api/verse/terminal/history/clear', mutate, '{}')).status).toBe(200);
    expect((await request(port, 'GET', '/api/verse/terminal/history', read)).json).toEqual({ enabled: true, entries: [] });

    // Off: nothing is recorded, nothing is read back.
    expect((await request(port, 'GET', '/api/verse/terminal/settings', read)).json).toEqual({ history: true, assist: 'local' });
    expect((await request(port, 'POST', '/api/verse/terminal/settings', { 'content-type': 'application/json' }, '{"history":false}')).status).toBe(401);
    expect((await request(port, 'POST', '/api/verse/terminal/settings', mutate, '{"history":"no"}')).status).toBe(400);
    expect((await request(port, 'POST', '/api/verse/terminal/settings', mutate, '{"history":false}')).json).toEqual({ history: false, assist: 'local' });
    a.pty.emit(`ls\r\n${osc('133;C')}x\r\n${osc('133;D;0')}${PROMPT}`);
    await tick(50);
    expect((await request(port, 'GET', '/api/verse/terminal/history', read)).json).toEqual({ enabled: false, entries: [] });
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'verse', 'terminal-history.jsonl'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Plain language → command
  // -------------------------------------------------------------------------

  it('assist: the local model gets the request + scrubbed recent blocks; the command comes back as text and is never typed', async () => {
    const { port, mutate } = await boot();
    const a = await openTab(port, mutate);
    a.pty.emit(`${osc(`633;P;Cwd=${project}`)}${PROMPT}`);
    a.pty.emit(`npm test\r\n${osc('133;C')}Error: token ${SECRET} rejected\r\n${osc('133;D;1')}${PROMPT}`);
    await tick(30);
    const writesBefore = a.pty.written.length;

    const denied = await request(port, 'POST', '/api/verse/terminal/assist', { 'content-type': 'application/json' }, JSON.stringify({ request: 'x', tabId: a.id }));
    expect(denied.status).toBe(401);

    const res = await request(port, 'POST', '/api/verse/terminal/assist', mutate, JSON.stringify({ request: 'show the biggest folders here', tabId: a.id }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ command: 'du -sh * | sort -h', explanation: 'Sizes, largest last.', provider: 'local:test-model', risky: false });
    expect(a.pty.written.length).toBe(writesBefore);
    const sent = seen[0]!.map((msg) => msg.content).join('\n');
    expect(sent).toContain('show the biggest folders here');
    expect(sent).toContain('$ npm test (exit 1)');
    expect(sent).toContain('Current directory: ~/proj');
    expect(sent).not.toContain(SECRET);

    // Risky answers are flagged by the server's own check too.
    localText = '{"command":"git push --force origin main"}';
    expect((await request(port, 'POST', '/api/verse/terminal/assist', mutate, JSON.stringify({ request: 'force push' }))).json).toMatchObject({ risky: true });
  });

  it('assist: saved auto mode cannot send terminal context to Grok without this request opting in', async () => {
    const { port, mutate } = await boot();
    let grokCalls = 0;
    setTerminalApiDepsForTest({
      assist: {
        local: async () => null,
        grok: async () => async () => {
          grokCalls++;
          return { text: '{"command":"ls"}', model: 'grok:remote' };
        },
      },
    });
    await request(port, 'POST', '/api/verse/terminal/settings', mutate, '{"assist":"auto"}');
    const post = (body: unknown) => request(port, 'POST', '/api/verse/terminal/assist', mutate, JSON.stringify(body));
    expect((await post({ request: 'list files' })).status).toBe(503);
    expect(grokCalls).toBe(0);
    expect((await post({ request: 'list files', cloudAllowed: 'yes' })).status).toBe(400);
    expect((await post({ request: 'list files', cloudAllowed: true })).json).toMatchObject({ provider: 'grok:remote' });
    expect(grokCalls).toBe(1);
    await request(port, 'POST', '/api/verse/terminal/settings', mutate, '{"assist":"local"}');
    expect((await post({ request: 'list files', cloudAllowed: true })).status).toBe(503);
    expect(grokCalls).toBe(1);
  });

  it('assist: off is a 409, no model a 503, bad bodies a 400', async () => {
    const { port, mutate } = await boot();
    const post = (body: unknown) => request(port, 'POST', '/api/verse/terminal/assist', mutate, JSON.stringify(body));
    expect((await post({})).status).toBe(400);
    expect((await post({ request: 'x', command: 'rm -rf /' })).status).toBe(400);
    expect((await post({ request: 'x', tabId: 't-000000000000' })).status).toBe(404);
    expect((await post({ request: 'x', blockIds: ['nope'] })).status).toBe(400);
    expect((await post({ request: 'y'.repeat(2001) })).status).toBe(413);
    localText = null;
    const none = await post({ request: 'list files' });
    expect(none.status).toBe(503);
    expect(none.json).toMatchObject({ code: 'TERMINAL_ASSIST_NO_MODEL' });
    await request(port, 'POST', '/api/verse/terminal/settings', mutate, '{"assist":"off"}');
    localText = '{"command":"ls"}';
    const off = await post({ request: 'list files' });
    expect(off.status).toBe(409);
    expect(seen).toHaveLength(0);
  });
});
