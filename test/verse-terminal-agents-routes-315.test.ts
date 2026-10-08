/**
 * 3.15 — the terminal for many agents, through the REAL server (real-io lane:
 * binds a loopback HTTP server and runs the generated hook script with
 * /bin/sh + curl, the way Claude Code / Codex would):
 *
 *   - an agent tab's launch carries its per-launch hooks; the hook script,
 *     run for real, reaches `/agent-state` WITHOUT the mutation token and
 *     moves the tab's status; a wrong token, a browser Origin or a bad state
 *     is refused; the hooks go away with the tab;
 *   - fix chips: the local model's suggestions for a failed block (scrubbed
 *     input, cached), behind the mutation token, 503 when it does not answer;
 *   - launch configurations: listed with their commands, launched by name
 *     (commands from the file, never the request), a cwd outside the root refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import { resetTerminalActivityForTest, needsYouItems } from '../src/core/verse/terminal-activity.js';
import { createTerminalManager, setTerminalManagerForTest, type PtyExit, type PtyHandle, type PtySpawnOptions, type TerminalManager } from '../src/core/verse/terminal.js';
import { setTerminalApiDepsForTest } from '../src/core/verse/terminal-api.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { resetPreviewCaches } from '../src/core/verse/preview.js';
import type { VerseTerminalLaunchListResponse, VerseTerminalLaunchResponse, VerseTerminalTab } from '../src/core/verse/workbench-types.js';
import { findSyncIoInSource } from '../scripts/check-verse-sync-io.mjs';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const enc = (s: string) => new TextEncoder().encode(s);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const osc = (payload: string) => `\x1b]${payload}\x07`;
const PROMPT = `\r\x1b[0m\x1b[27m\x1b[24m\x1b[J${osc('133;A')}USER% ${osc('133;B')}\x1b[K\x1b[?2004h`;

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  written: string[];
  emit(text: string): void;
}

function fakeSpawner() {
  const spawned: FakePty[] = [];
  let pid = 12_000;
  const spawn = (opts: PtySpawnOptions): FakePty => {
    const exited = new Promise<PtyExit>(() => {});
    const pty: FakePty = {
      pid: pid++,
      opts,
      written: [],
      write(data) { pty.written.push(new TextDecoder().decode(data)); },
      resize() {},
      close() {},
      exited,
      emit(text) { opts.onData(enc(text)); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawn, spawned };
}

interface HttpResult { status: number; json: unknown }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}, body?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(raw); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function runHook(script: string, args: string[], stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', [script, ...args], { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout });
    });
    child.stdin?.end(stdin);
  });
}

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
    id, title: 'chat', projectPath, engine: 'claude', accountId: 'a', seatId: 'claude-a', model: 'm', nativeSessionId: null,
    createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z', status: 'idle', turnCount: 0, usage: {}, lastError: null,
  } as unknown as VerseSession;
}

describe('terminal 3.15 agents, fixes and launch configurations through the real server', () => {
  let tmpHome: string;
  let prev: { HOME?: string; TMPDIR?: string };
  let project: string;
  let handles: Array<{ close(): Promise<void> }> = [];
  let fake: ReturnType<typeof fakeSpawner>;
  let m: TerminalManager;
  let fixCalls: string[];
  let fixReply: () => Promise<string>;

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-agents-315-home-')));
    prev = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
    process.env.HOME = tmpHome;
    // The hook files go under the per-user temp dir: keep them inside this test's home.
    process.env.TMPDIR = path.join(tmpHome, 'tmp');
    fs.mkdirSync(process.env.TMPDIR, { mode: 0o700 });
    project = path.join(tmpHome, 'proj');
    fs.mkdirSync(path.join(project, 'web'), { recursive: true });
    resetVerseEngine(engineWith([sessionAt('s-1', project)]));
    invalidateVerseSeatCache();
    resetPreviewCaches();
    resetTerminalActivityForTest();
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
      startCommandWaitMs: 5,
      shellIntegration: { dir: () => path.join(tmpHome, '.si', 'v1') },
      killSwitch: async () => false,
      agentQuietMs: 10_000,
    });
    setTerminalManagerForTest(m);
    fixCalls = [];
    fixReply = async () => '{"suggestions":[{"command":"npm install","why":"A dependency is missing."}]}';
    setTerminalApiDepsForTest({
      openExternal: async () => {},
      platform: 'darwin',
      devServers: { listListeners: async () => [] },
      fixAssist: () => ({ model: 'qwen-test', complete: async (_s, user) => { fixCalls.push(user); return fixReply(); } }),
    });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    setTerminalManagerForTest(null);
    setTerminalApiDepsForTest(null);
    resetVerseEngine(null);
    resetTerminalActivityForTest();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function boot() {
    const cfgRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(cfgRoot, { recursive: true });
    fs.writeFileSync(path.join(cfgRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const handle = await startServer(makeConfig(cfgRoot), { port: 0, open: false, allowDispatch: true });
    handles.push(handle);
    return { port: handle.port, read: readAuthHeaders(handle.port), mutate: { 'x-ashlr-token': handle.token, 'content-type': 'application/json' } };
  }

  async function tabs(port: number, read: Record<string, string>): Promise<VerseTerminalTab[]> {
    return ((await request(port, 'GET', '/api/verse/terminal', read)).json as { tabs: VerseTerminalTab[] }).tabs;
  }

  it('a Claude Code tab: launched with --settings, its real hook script moves the status without the mutation token', async () => {
    const { port, read, mutate } = await boot();
    const created = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', appId: 'claude-code', cols: 80, rows: 24 }));
    expect(created.status).toBe(201);
    const tab = (created.json as { tab: VerseTerminalTab }).tab;
    expect(tab.agent).toBe(true);
    const pty = fake.spawned[0]!;
    pty.emit('% ');
    await tick(100);
    const typed = pty.written.join('');
    const settings = /^claude --settings (\S+)\r$/.exec(typed)?.[1];
    expect(settings).toBeTruthy();
    expect(settings!.startsWith(path.join(tmpHome, 'tmp'))).toBe(true);
    // Never the operator's own Claude config.
    expect(fs.existsSync(path.join(tmpHome, '.claude'))).toBe(false);
    const script = path.join(path.dirname(settings!), 'hook.sh');
    const token = /x-ashlr-agent-token: ([a-f0-9]{48})/.exec(fs.readFileSync(script, 'utf8'))![1]!;
    // The token never reaches the page.
    expect(JSON.stringify(await tabs(port, read))).not.toContain(token);

    const needs = await runHook(script, ['needs-you'], JSON.stringify({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }));
    expect(needs).toEqual({ code: 0, stdout: '' });
    let state = (await tabs(port, read)).find((t) => t.id === tab.id)!.agentState;
    expect(state).toMatchObject({ agent: 'claude-code', state: 'needs-you', source: 'hook', channel: 'hooks', message: 'Claude needs your permission to use Bash' });
    expect(needsYouItems().map((i) => i.id)).toEqual([`chats:agent-waiting:${tab.id}`]);

    await runHook(script, ['idle'], JSON.stringify({ hook_event_name: 'Stop' }));
    state = (await tabs(port, read)).find((t) => t.id === tab.id)!.agentState;
    expect(state).toMatchObject({ state: 'idle', message: null });
    expect(needsYouItems()).toEqual([]);

    // Refusals: wrong token, a browser, a bad state, a GET.
    const url = `/api/verse/terminal/${tab.id}/agent-state?state=running`;
    expect((await request(port, 'POST', url, { 'x-ashlr-agent-token': 'b'.repeat(48) }, '{}')).status).toBe(404);
    expect((await request(port, 'POST', url, {}, '{}')).status).toBe(404);
    expect((await request(port, 'POST', url, { 'x-ashlr-agent-token': token, origin: `http://127.0.0.1:${port}` }, '{}')).status).toBe(403);
    expect((await request(port, 'POST', `/api/verse/terminal/${tab.id}/agent-state?state=done`, { 'x-ashlr-agent-token': token }, '{}')).status).toBe(400);
    expect((await request(port, 'GET', url, read)).status).toBe(404);
    // The exemption is exactly that path shape: its neighbours still need the mutation token.
    expect((await request(port, 'POST', `/api/verse/terminal/${tab.id}/kill`, { 'x-ashlr-agent-token': token, 'content-type': 'application/json' }, '{}')).status).toBe(401);

    // Closing schedules asynchronous hook removal; observe its completion.
    expect((await request(port, 'POST', `/api/verse/terminal/${tab.id}/kill`, mutate, '{}')).status).toBe(200);
    await expect.poll(() => fs.existsSync(path.dirname(settings!))).toBe(false);
  });

  it('a Codex tab gets -c notify; a launch through Ollama gets no hooks (status read from its output)', async () => {
    const { port, mutate } = await boot();
    await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', appId: 'codex', cols: 80, rows: 24 }));
    fake.spawned[0]!.emit('% ');
    await tick(100);
    expect(fake.spawned[0]!.written.join('')).toMatch(/^codex -c 'notify=\["\/bin\/sh","[^"]+\/hook\.sh","idle"\]'\r$/);
  });

  it('fix chips: the local model\'s commands for a failed block — scrubbed, cached, behind the token, 503 when it is down', async () => {
    const { port, mutate } = await boot();
    const created = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    const tabId = (created.json as { tab: VerseTerminalTab }).tab.id;
    const pty = fake.spawned[0]!;
    const nonce = pty.opts.env['ASHLR_SHELL_NONCE']!;
    pty.emit(PROMPT);
    pty.emit(`${osc(`633;E;npm test;${nonce}`)}${osc('133;C')}Error: cannot find module 'x' (key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345)\r\n${osc('133;D;1')}${PROMPT}`);
    pty.emit(`${osc(`633;E;true;${nonce}`)}${osc('133;C')}${osc('133;D;0')}${PROMPT}`);
    await tick(10);
    const fix = (block: string, headers = mutate) => request(port, 'POST', `/api/verse/terminal/${tabId}/blocks/${block}/fix`, headers, '{}');
    const first = await fix('b-1');
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ suggestions: [{ command: 'npm install', why: 'A dependency is missing.' }], model: 'qwen-test' });
    expect(fixCalls).toHaveLength(1);
    expect(fixCalls[0]).not.toContain('sk-ant-api03');
    expect((await fix('b-1')).status).toBe(200);
    expect(fixCalls).toHaveLength(1);
    expect((await fix('b-2')).status).toBe(400);
    expect((await fix('b-9')).status).toBe(404);
    expect((await fix('b-1', { 'content-type': 'application/json' })).status).toBe(401);

    pty.emit(`${osc(`633;E;make;${nonce}`)}${osc('133;C')}boom\r\n${osc('133;D;2')}${PROMPT}`);
    await tick(10);
    fixReply = async () => { throw new Error('ECONNREFUSED'); };
    const down = await fix('b-3');
    expect(down.status).toBe(503);
    expect(down.json).toMatchObject({ code: 'TERMINAL_ASSIST_UNAVAILABLE' });
  });

  it('launch configurations: listed with their commands, launched by name from the file, a bad file explained', async () => {
    const { port, read, mutate } = await boot();
    fs.mkdirSync(path.join(project, '.ashlr', 'verse'), { recursive: true });
    fs.writeFileSync(path.join(project, '.ashlr', 'verse', 'launch.json'), JSON.stringify({
      version: 1,
      configurations: [
        { name: 'Dev', tabs: [{ split: 'down', panes: [{ cwd: 'web', command: 'npm run dev' }, { command: 'npm test -- --watch' }] }, { panes: [{ agent: 'claude-code' }] }] },
        { name: 'Missing dir', tabs: [{ panes: [{ command: 'echo first' }, { cwd: 'nope', command: 'ls' }] }] },
      ],
    }));
    const listed = await request(port, 'GET', '/api/verse/terminal/launch?sessionId=s-1', read);
    expect(listed.status).toBe(200);
    const list = listed.json as VerseTerminalLaunchListResponse;
    expect(list.errors).toEqual([]);
    expect(list.configs.map((c) => c.name)).toEqual(['Dev', 'Missing dir']);
    const devDigest = list.configs[0]!.digest;
    const missingDigest = list.configs[1]!.digest;
    expect(devDigest).toMatch(/^(?:[a-f0-9]{8}-){7}[a-f0-9]{8}$/);
    // Listing typed nothing.
    expect(fake.spawned).toHaveLength(0);

    const launchPath = path.join(project, '.ashlr', 'verse', 'launch.json');
    const reviewedFile = fs.readFileSync(launchPath, 'utf8');
    fs.writeFileSync(launchPath, reviewedFile.replace('npm run dev', 'echo changed'));
    const changed = await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Dev', digest: devDigest, cols: 100, rows: 30 }));
    expect(changed.status).toBe(409);
    expect(changed.json).toMatchObject({ code: 'TERMINAL_LAUNCH_CHANGED' });
    expect(fake.spawned).toHaveLength(0);
    fs.writeFileSync(launchPath, reviewedFile);
    expect((await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Dev', cols: 100, rows: 30 }))).status).toBe(400);
    expect(fake.spawned).toHaveLength(0);

    const launched = await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Dev', digest: devDigest, cols: 100, rows: 30 }));
    expect(launched.status).toBe(201);
    const body = launched.json as VerseTerminalLaunchResponse;
    expect(body.errors).toEqual([]);
    expect(body.groups.map((g) => [g.split, g.tabs.length])).toEqual([['down', 2], ['right', 1]]);
    expect(fake.spawned.map((p) => p.opts.cwd)).toEqual([fs.realpathSync(path.join(project, 'web')), project, project]);
    for (const p of fake.spawned) p.emit('% ');
    await tick(100);
    expect(fake.spawned.map((p) => p.written.join('').replace(/ --settings \S+/, ' --settings …'))).toEqual(['npm run dev\r', 'npm test -- --watch\r', 'claude --settings …\r']);
    expect(body.groups[1]!.tabs[0]!.agent).toBe(true);

    const spawnedBeforeInvalid = fake.spawned.length;
    const missing = await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Missing dir', digest: missingDigest, cols: 80, rows: 24 }));
    expect(missing.status).toBe(409);
    expect((missing.json as VerseTerminalLaunchResponse).errors[0]).toMatch(/^ls: cwd must be an existing directory/);
    expect(fake.spawned).toHaveLength(spawnedBeforeInvalid);
    expect((await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Nope', digest: devDigest, cols: 80, rows: 24 }))).status).toBe(404);
    // The request cannot carry a command.
    expect((await request(port, 'POST', '/api/verse/terminal/launch', mutate, JSON.stringify({ sessionId: 's-1', root: project, name: 'Dev', digest: devDigest, cols: 80, rows: 24, command: 'rm -rf ~' }))).status).toBe(400);
    expect((await request(port, 'POST', '/api/verse/terminal/launch', { 'content-type': 'application/json' }, JSON.stringify({ sessionId: 's-1', root: project, name: 'Dev', digest: devDigest, cols: 80, rows: 24 }))).status).toBe(401);

    fs.writeFileSync(path.join(project, '.ashlr', 'verse', 'launch.json'), '{"version":1,"configurations":[{"name":"x","tabs":[{"panes":[{"command":"a\\nb"}]}]}]}');
    const bad = (await request(port, 'GET', '/api/verse/terminal/launch?sessionId=s-1', read)).json as VerseTerminalLaunchListResponse;
    expect(bad.configs).toEqual([]);
    expect(bad.errors[0]!.error).toMatch(/one line/);
  });

  it('no synchronous fs in the route file', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'verse', 'terminal-api.ts'), 'utf8');
    expect(findSyncIoInSource(source, 'terminal-api.ts')).toEqual([]);
  });
});
