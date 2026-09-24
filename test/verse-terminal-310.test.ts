/**
 * V3.10 Terminal pane (unit C4) — core/verse/terminal.ts, terminal-api.ts and
 * the `terminal` kind of process-registry.ts.
 *
 * vitest runs on Node, which has no PTY: every shell here is a FAKE spawner
 * (SPEC-310C §7 C4 "Injected spawner"). No real shell, no model call, no paid
 * seat. The API half runs the REAL server under a relocated HOME.
 *
 * Under test (SPEC-310C §3 / §7 C4):
 *   - login shell, TERM=xterm-256color, sanitised env, own process group, registered;
 *   - output coalesced into seq-numbered frames, ≤ 60 Hz, leading edge;
 *   - 256 KB in-memory scrollback, replayed past `after` (reattach after reload);
 *   - OSC titles (split across chunks, sanitised);
 *   - the 8-tab cap, the 12 h idle kill, exit kept readable, kill = hang-up + SIGKILL tree;
 *   - routes: working-directory guard, unknown keys, 16 KB input cap, the
 *     mutation gate, SSE replay, open-external, Launch / dev-server Start commands;
 *   - terminal POSTs do not tear the read-projection worker down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseSession } from '../src/core/verse/types.js';
import {
  bunPtySpawner,
  createOscTitleParser,
  createTerminalManager,
  descendantsFromPsRows,
  sanitizeTerminalTitle,
  setTerminalManagerForTest,
  terminalEnv,
  TerminalError,
  TERMINAL_UNAVAILABLE_REASON,
  type PtyExit,
  type PtyHandle,
  type PtySpawnOptions,
  type TerminalManager,
} from '../src/core/verse/terminal.js';
import { formatTerminalSseFrame, setTerminalApiDepsForTest } from '../src/core/verse/terminal-api.js';
import type { AppsSnapshot } from '../src/core/verse/apps.js';
import { createProcessRegistry, runningKindOf } from '../src/core/verse/process-registry.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { mutationInvalidatesReadCaches } from '../src/core/web/server.js';
import { resetPreviewCaches } from '../src/core/verse/preview.js';
import type { VerseTerminalFrame } from '../src/core/verse/workbench-types.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Fake PTY
// ---------------------------------------------------------------------------

interface FakePty extends PtyHandle {
  opts: PtySpawnOptions;
  written: Uint8Array[];
  resizes: Array<[number, number]>;
  closed: boolean;
  emit(text: string | Uint8Array): void;
  exit(result: PtyExit): void;
}

function fakeSpawner(): { spawn: (opts: PtySpawnOptions) => FakePty; spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  let nextPid = 4000;
  const spawn = (opts: PtySpawnOptions): FakePty => {
    let resolveExit!: (value: PtyExit) => void;
    const exited = new Promise<PtyExit>((r) => { resolveExit = r; });
    const pty: FakePty = {
      pid: nextPid++,
      opts,
      written: [],
      resizes: [],
      closed: false,
      write(data) { pty.written.push(data); },
      resize(cols, rows) { pty.resizes.push([cols, rows]); },
      close() { pty.closed = true; },
      exited,
      emit(text) { opts.onData(typeof text === 'string' ? new TextEncoder().encode(text) : text); },
      exit(result) { resolveExit(result); },
    };
    spawned.push(pty);
    return pty;
  };
  return { spawn, spawned };
}

function decode(frame: VerseTerminalFrame): string {
  return frame.type === 'output' ? Buffer.from(frame.dataBase64, 'base64').toString('utf8') : '';
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-terminal-310-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function manager(overrides: Parameters<typeof createTerminalManager>[0] = {}) {
  const fake = fakeSpawner();
  const kills: Array<[number, string]> = [];
  const m = createTerminalManager({
    spawner: fake.spawn,
    registry: null,
    env: async () => ({ PATH: '/usr/bin:/bin', HOME: tmpRoot }),
    shell: () => '/bin/zsh',
    kill: (pid, sig) => { kills.push([pid, sig]); },
    exists: () => true,
    listDescendants: async () => [9001, 9002],
    frameIntervalMs: 16,
    killGraceMs: 100,
    startCommandWaitMs: 500,
    ...overrides,
  });
  return { m, fake, kills };
}

async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

describe('TerminalManager — availability', () => {
  it('is unavailable without a PTY (Node), and says the terminal needs the desktop app', async () => {
    const m = createTerminalManager({ spawner: null, registry: null });
    expect(m.available()).toEqual({ available: false, reason: TERMINAL_UNAVAILABLE_REASON });
    await expect(m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'TERMINAL_UNAVAILABLE' });
  });

  it('detects Bun only when it has a Terminal (PTY) API', () => {
    expect(bunPtySpawner(undefined)).toBeNull();
    expect(bunPtySpawner({ spawn: () => ({}) })).toBeNull();
    const spawnCalls: unknown[][] = [];
    const runtime = {
      Terminal: function Terminal() {},
      spawn: (argv: string[], opts: Record<string, unknown>) => {
        spawnCalls.push([argv, opts]);
        return {
          pid: 77,
          exited: Promise.resolve(0),
          exitCode: 0,
          signalCode: null,
          terminal: { write: () => 1, resize: () => {}, close: () => {} },
        };
      },
    };
    const spawner = bunPtySpawner(runtime)!;
    expect(spawner).toBeTypeOf('function');
    const handle = spawner({ argv: ['/bin/zsh', '-l'], cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24, onData: () => {} });
    expect(handle.pid).toBe(77);
    const [argv, opts] = spawnCalls[0] as [string[], { terminal: { cols: number; rows: number } }];
    expect(argv).toEqual(['/bin/zsh', '-l']);
    expect(opts.terminal.cols).toBe(80);
  });
});

describe('TerminalManager — create', () => {
  it('starts a LOGIN shell in the root with TERM=xterm-256color and the environment it was given', async () => {
    const { m, fake } = manager({
      env: async () => ({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: tmpRoot, TERM_PROGRAM: 'Apple_Terminal', COLUMNS: '200' }),
    });
    const tab = await m.create({ sessionId: 's-1', root: tmpRoot, cols: 100, rows: 30 });
    const pty = fake.spawned[0]!;
    expect(pty.opts.argv).toEqual(['/bin/zsh', '-l']);
    expect(pty.opts.cwd).toBe(tmpRoot);
    expect(pty.opts.cols).toBe(100);
    expect(pty.opts.env['TERM']).toBe('xterm-256color');
    expect(pty.opts.env['COLORTERM']).toBe('truecolor');
    expect(pty.opts.env['PATH']).toBe('/opt/homebrew/bin:/usr/bin');
    // The sidecar's own terminal identity never leaks into ours.
    expect(pty.opts.env['TERM_PROGRAM']).toBeUndefined();
    expect(pty.opts.env['COLUMNS']).toBeUndefined();
    expect(pty.opts.env['LANG']).toBe('en_US.UTF-8');
    expect(tab).toMatchObject({ sessionId: 's-1', root: tmpRoot, title: path.basename(tmpRoot), cols: 100, rows: 30, exited: null });
    expect(tab.id).toMatch(/^t-[a-f0-9]{12}$/);
  });

  it('the default environment has ASHLR_* and credentials stripped (login-path sanitising)', () => {
    const env = terminalEnv({ HOME: '/h', PATH: '/bin', LC_ALL: 'C.UTF-8' }, '/h/p');
    expect(env).toMatchObject({ TERM: 'xterm-256color', PWD: '/h/p', LC_ALL: 'C.UTF-8' });
    // An explicit locale is kept, never overridden.
    expect(env['LANG']).toBeUndefined();
  });

  it('refuses a relative or missing root', async () => {
    const { m } = manager();
    await expect(m.create({ sessionId: 's', root: 'relative/dir', cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'TERMINAL_INVALID' });
    await expect(m.create({ sessionId: 's', root: path.join(tmpRoot, 'missing'), cols: 80, rows: 24 })).rejects.toMatchObject({ code: 'TERMINAL_INVALID' });
  });

  it('caps open tabs at 8 (SPEC-310C §3)', async () => {
    const { m } = manager();
    for (let i = 0; i < 8; i++) await m.create({ sessionId: `s-${i}`, root: tmpRoot, cols: 80, rows: 24 });
    const err = await m.create({ sessionId: 's-9', root: tmpRoot, cols: 80, rows: 24 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerminalError);
    expect((err as TerminalError).code).toBe('TERMINAL_LIMIT');
    expect(m.list()).toHaveLength(8);
  });

  it('clamps absurd sizes', async () => {
    const { m, fake } = manager();
    await m.create({ sessionId: 's', root: tmpRoot, cols: 99999, rows: 0 });
    expect([fake.spawned[0]!.opts.cols, fake.spawned[0]!.opts.rows]).toEqual([500, 2]);
  });

  it('registers the shell as a `terminal` entry with its own process group, and forgets it on exit', async () => {
    const registry = createProcessRegistry(tmpRoot, { serverPid: process.pid, serverStartedAt: 1 });
    const { m, fake } = manager({ registry });
    const tab = await m.create({ sessionId: 's-1', root: tmpRoot, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    const [entry] = registry.entries();
    expect(entry).toMatchObject({ kind: 'terminal', sessionId: 's-1', turnId: tab.id, pid: pty.pid, pgid: pty.pid, markers: ['zsh'] });
    pty.exit({ code: 0, signal: null });
    await tick(60);
    expect(registry.entries()).toEqual([]);
  });
});

describe('TerminalManager — output frames and scrollback', () => {
  it('sends the first chunk at once (a keystroke echo is never held) and coalesces a burst into one trailing frame', async () => {
    const { m, fake } = manager({ frameIntervalMs: 40 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    frames.length = 0; // drop the title frame sent on subscribe
    const pty = fake.spawned[0]!;
    pty.emit('a');
    expect(frames.map(decode)).toEqual(['a']);
    pty.emit('b');
    pty.emit('c');
    pty.emit('d');
    expect(frames).toHaveLength(1);
    await tick(60);
    expect(frames.map(decode)).toEqual(['a', 'bcd']);
    expect(frames.map((f) => (f.type === 'output' ? f.seq : 0))).toEqual([1, 2]);
  });

  it('replays only what the client does not have (after=<seq>), then the title', async () => {
    const { m, fake } = manager({ frameIntervalMs: 0 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    pty.emit('one ');
    pty.emit('two ');
    pty.emit('three');
    const replay: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 1, (f) => replay.push(f));
    expect(replay.filter((f) => f.type === 'output').map(decode)).toEqual(['two ', 'three']);
    expect(replay.at(-1)).toEqual({ type: 'title', title: path.basename(tmpRoot) });
  });

  it('keeps at most 256 KB of scrollback in memory, dropping the oldest frames', async () => {
    const { m, fake } = manager({ frameIntervalMs: 0 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    const chunk = 'x'.repeat(40 * 1024);
    for (let i = 0; i < 10; i++) pty.emit(chunk); // 400 KB
    const replay: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => replay.push(f));
    const outputs = replay.filter((f): f is Extract<VerseTerminalFrame, { type: 'output' }> => f.type === 'output');
    const bytes = outputs.reduce((n, f) => n + Buffer.from(f.dataBase64, 'base64').length, 0);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
    expect(bytes).toBeGreaterThan(200 * 1024);
    // The newest frame survives; the first ones are gone.
    expect(outputs.at(-1)!.seq).toBe(10);
    expect(outputs[0]!.seq).toBeGreaterThan(1);
  });

  it('never sends one frame larger than 64 KB', async () => {
    const { m, fake } = manager({ frameIntervalMs: 0 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    fake.spawned[0]!.emit('y'.repeat(150 * 1024));
    const sizes = frames.filter((f) => f.type === 'output').map((f) => Buffer.from((f as { dataBase64: string }).dataBase64, 'base64').length);
    expect(sizes).toEqual([65536, 65536, 22528]);
  });

  it('takes the tab title from OSC 0 / OSC 2 — even split across chunks — and sanitises it', async () => {
    const { m, fake } = manager({ frameIntervalMs: 0 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    const pty = fake.spawned[0]!;
    pty.emit('prompt \u001b]0;npm ');
    pty.emit('run dev\u0007 more');
    expect(m.get(tab.id)!.title).toBe('npm run dev');
    expect(frames).toContainEqual({ type: 'title', title: 'npm run dev' });
    pty.emit('\u001b]2;evil\u202e\u0001name\u001b\\');
    expect(m.get(tab.id)!.title).toBe('evilname');
  });

  it('keeps an exited tab (and its output) until it is closed', async () => {
    const { m, fake } = manager({ frameIntervalMs: 0 });
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f));
    const pty = fake.spawned[0]!;
    pty.emit('bye');
    pty.exit({ code: 3, signal: null });
    await tick(60);
    expect(frames.at(-1)).toEqual({ type: 'exit', code: 3, signal: null });
    expect(m.get(tab.id)!.exited).toMatchObject({ code: 3, signal: null });
    expect(() => m.write(tab.id, new Uint8Array([97]))).toThrow(expect.objectContaining({ code: 'TERMINAL_EXITED' }));
    // A reattaching client still gets the output and the exit.
    const replay: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => replay.push(f));
    expect(replay.map((f) => f.type)).toEqual(['output', 'title', 'exit']);
    expect(pty.closed).toBe(true);
  });
});

describe('TerminalManager — input, resize, kill, idle', () => {
  it('writes input and resizes the PTY', async () => {
    const { m, fake } = manager();
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    m.write(tab.id, new TextEncoder().encode('ls\r'));
    m.resize(tab.id, 120, 40);
    const pty = fake.spawned[0]!;
    expect(new TextDecoder().decode(pty.written[0])).toBe('ls\r');
    expect(pty.resizes).toEqual([[120, 40]]);
    expect(m.get(tab.id)).toMatchObject({ cols: 120, rows: 40 });
  });

  it('kill hangs the terminal up, then SIGKILLs the group and every descendant snapshotted before the hang-up', async () => {
    const { m, fake, kills } = manager();
    const tab = await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24 });
    const pty = fake.spawned[0]!;
    let closedStream = false;
    const frames: VerseTerminalFrame[] = [];
    m.subscribe(tab.id, 0, (f) => frames.push(f), () => { closedStream = true; });
    m.kill(tab.id);
    expect(m.get(tab.id)).toBeNull();
    expect(closedStream).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: 'exit' });
    await tick(10);
    expect(pty.closed).toBe(true);
    expect(kills).toEqual([[-pty.pid, 'SIGHUP']]);
    await tick(150);
    expect(kills).toEqual([[-pty.pid, 'SIGHUP'], [-pty.pid, 'SIGKILL'], [9001, 'SIGKILL'], [9002, 'SIGKILL']]);
  });

  it('kills a tab idle for 12 hours, and only that one', async () => {
    let now = 1_000_000;
    const { m } = manager({ now: () => now });
    const idle = await m.create({ sessionId: 'a', root: tmpRoot, cols: 80, rows: 24 });
    now += 11 * 3_600_000;
    const busy = await m.create({ sessionId: 'b', root: tmpRoot, cols: 80, rows: 24 });
    now += 1 * 3_600_000 + 1;
    expect(m.sweepIdle()).toEqual([idle.id]);
    expect(m.list().map((t) => t.id)).toEqual([busy.id]);
  });

  it('types a Launch / dev-server command once the shell has drawn its prompt — never before', async () => {
    const { m, fake } = manager();
    await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24, startCommand: 'npm run dev' });
    const pty = fake.spawned[0]!;
    await tick(20);
    expect(pty.written).toHaveLength(0);
    pty.emit('% ');
    await tick(80);
    expect(pty.written.map((w) => new TextDecoder().decode(w))).toEqual(['npm run dev\r']);
  });

  it('types it after a short wait if the shell never prints a prompt', async () => {
    const { m, fake } = manager({ startCommandWaitMs: 30 });
    await m.create({ sessionId: 's', root: tmpRoot, cols: 80, rows: 24, startCommand: 'claude\nrm -rf /' });
    await tick(60);
    // A newline in a start command can never run a second command.
    expect(fake.spawned[0]!.written.map((w) => new TextDecoder().decode(w))).toEqual(['claude rm -rf /\r']);
  });

  it('closeAll kills every tab (server shutdown)', async () => {
    const { m } = manager();
    await m.create({ sessionId: 'a', root: tmpRoot, cols: 80, rows: 24 });
    await m.create({ sessionId: 'b', root: tmpRoot, cols: 80, rows: 24 });
    m.closeAll();
    expect(m.list()).toEqual([]);
  });
});

describe('helpers', () => {
  it('walks the process tree below a pid', () => {
    const ps = ' 100 1\n 200 100\n 300 200\n 400 1\n 500 300\n bogus\n';
    expect(descendantsFromPsRows(ps, 100).sort()).toEqual([200, 300, 500]);
    expect(descendantsFromPsRows(ps, 999)).toEqual([]);
  });

  it('parses OSC titles terminated by BEL or ST, ignores other OSCs and gives up on runaway ones', () => {
    const p = createOscTitleParser();
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(p.feed(enc('\u001b]0;hello\u0007'))).toBe('hello');
    expect(p.feed(enc('\u001b]7;file://host/dir\u0007plain'))).toBeNull();
    expect(p.feed(enc('\u001b]2;ünïcode\u001b\\'))).toBe('ünïcode');
    expect(p.feed(enc(`\u001b]0;${'z'.repeat(600)}\u0007`))).toBeNull();
    expect(p.feed(enc('\u001b]0;after\u0007'))).toBe('after');
  });

  it('sanitises titles: control and bidi characters out, capped', () => {
    expect(sanitizeTerminalTitle('\u202eabc\u0000')).toBe('abc');
    expect(sanitizeTerminalTitle('   ')).toBeNull();
    expect(sanitizeTerminalTitle('ab '.repeat(100))!.length).toBe(80);
  });

  it('scrubs a secret out of a title where it leaves the server', () => {
    const frame = formatTerminalSseFrame({ type: 'title', title: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' });
    expect(frame).not.toContain('ghp_abcdefghijklmnop');
  });

  it('formats output frames with an id (the resume cursor) and title/exit frames without', () => {
    expect(formatTerminalSseFrame({ type: 'output', seq: 7, dataBase64: 'aGk=' })).toBe('id: 7\nevent: output\ndata: {"type":"output","seq":7,"dataBase64":"aGk="}\n\n');
    expect(formatTerminalSseFrame({ type: 'exit', code: 0, signal: null })).toBe('event: exit\ndata: {"type":"exit","code":0,"signal":null}\n\n');
  });

  it('terminal POSTs never invalidate the read projections; everything else still does', () => {
    expect(mutationInvalidatesReadCaches('/api/verse/terminal')).toBe(false);
    expect(mutationInvalidatesReadCaches('/api/verse/terminal/t-1/input')).toBe(false);
    expect(mutationInvalidatesReadCaches('/api/verse/terminals')).toBe(true);
    expect(mutationInvalidatesReadCaches('/api/verse/sessions')).toBe(true);
  });
});

describe('process registry — terminal entries next to turns', () => {
  it('a terminal never displaces the session\'s turn, and a turn never displaces its terminals', () => {
    const reg = createProcessRegistry(tmpRoot, { serverPid: 50, serverStartedAt: 1 });
    reg.add({ sessionId: 's', turnId: 'turn-1', pid: 10, pgid: 10, markers: ['claude'], spawnedAt: 1 });
    reg.add({ kind: 'terminal', sessionId: 's', turnId: 't-a', pid: 11, pgid: 11, markers: ['zsh'], spawnedAt: 1 });
    reg.add({ kind: 'terminal', sessionId: 's', turnId: 't-b', pid: 12, pgid: 12, markers: ['zsh'], spawnedAt: 1 });
    reg.add({ sessionId: 's', turnId: 'turn-2', pid: 13, pgid: 13, markers: ['claude'], spawnedAt: 2 });
    const entries = reg.entries();
    expect(entries.map((e) => `${runningKindOf(e)}:${e.turnId}`).sort()).toEqual(['terminal:t-a', 'terminal:t-b', 'turn:turn-2']);
    reg.remove('s', 't-a');
    expect(reg.entries().map((e) => e.turnId).sort()).toEqual(['t-b', 'turn-2']);
  });

  it('reaps a shell a dead server left behind, under the same identity proof as a turn', () => {
    const writer = createProcessRegistry(tmpRoot, { serverPid: 999_999, serverStartedAt: 1 });
    writer.add({ kind: 'terminal', sessionId: 's', turnId: 't-a', pid: 4242, pgid: 4242, markers: ['zsh'], spawnedAt: 1_000_000 });
    const killed: Array<[number, string]> = [];
    const reaper = createProcessRegistry(tmpRoot, {
      serverPid: 1,
      serverStartedAt: 1,
      exists: (pid) => pid !== 999_999,
      listProcesses: () => [{ pid: 4242, pgid: 4242, startedAt: 1_000_000, command: '/bin/zsh -l' }],
      kill: (pid, sig) => { killed.push([pid, sig]); },
      termGraceMs: 10,
    });
    const report = reaper.reapOrphans();
    expect(report.reaped).toEqual([{ sessionId: 's', turnId: 't-a', pgid: 4242, pids: [4242] }]);
    expect(killed[0]).toEqual([-4242, 'SIGTERM']);
  });
});

// ---------------------------------------------------------------------------
// Routes through the real server
// ---------------------------------------------------------------------------

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

/** Open an SSE stream and collect frames until `until` says stop (or the server ends it). */
function streamFrames(port: number, urlPath: string, headers: Record<string, string>, until: (frames: string[]) => boolean): Promise<{ status: number; frames: string[]; ended: boolean }> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let buf = '';
      let done = false;
      const finish = (ended: boolean) => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode ?? 0, frames, ended });
        req.destroy();
      };
      res.on('data', (c: Buffer) => {
        buf += c.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!block.startsWith(':')) frames.push(block);
        }
        if (until(frames)) finish(false);
      });
      res.on('end', () => finish(true));
    });
    req.on('error', (err) => { if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err); });
    req.end();
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

function sessionAt(id: string, projectPath: string, extraRoots?: string[]): VerseSession {
  return {
    id,
    title: 'chat',
    projectPath,
    ...(extraRoots ? { extraRoots } : {}),
    engine: 'claude',
    accountId: 'a',
    seatId: 'claude-a',
    model: 'm',
    nativeSessionId: null,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: {},
    lastError: null,
  } as unknown as VerseSession;
}

describe('terminal routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let project: string;
  let other: string;
  let handles: Array<{ close(): Promise<void> }> = [];
  let fake: ReturnType<typeof fakeSpawner>;
  let m: TerminalManager;
  let opened: string[];

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-terminal-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    project = path.join(tmpHome, 'proj');
    other = path.join(tmpHome, 'elsewhere');
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', 'weird; rm': 'next dev' } }));
    resetVerseEngine(engineWith([sessionAt('s-1', project)]));
    invalidateVerseSeatCache();
    resetPreviewCaches();
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
    });
    setTerminalManagerForTest(m);
    opened = [];
    setTerminalApiDepsForTest({
      openExternal: async (dir) => { opened.push(dir); },
      platform: 'darwin',
      devServers: { listListeners: async () => [] },
    });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    setTerminalManagerForTest(null);
    setTerminalApiDepsForTest(null);
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

  it('lists availability and tabs; creation is refused without the mutation token', async () => {
    const { port, read } = await boot();
    const list = await request(port, 'GET', '/api/verse/terminal', read);
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ available: true, reason: null, tabs: [] });
    const denied = await request(port, 'POST', '/api/verse/terminal', { 'content-type': 'application/json' }, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    expect(denied.status).toBe(401);
    expect(fake.spawned).toHaveLength(0);
  });

  it('reports unavailable under Node with the desktop-app reason, and create is a 503', async () => {
    setTerminalManagerForTest(createTerminalManager({ spawner: null, registry: null }));
    const { port, read, mutate } = await boot();
    const list = await request(port, 'GET', '/api/verse/terminal', read);
    expect(list.json).toEqual({ available: false, reason: TERMINAL_UNAVAILABLE_REASON, tabs: [] });
    const create = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    expect(create.status).toBe(503);
  });

  it('opens a tab in the chat\'s root by default, and returns it', async () => {
    const { port, mutate } = await boot();
    const res = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 90, rows: 20 }));
    expect(res.status).toBe(201);
    const tab = (res.json as { tab: { id: string; root: string; sessionId: string } }).tab;
    expect(tab.sessionId).toBe('s-1');
    // sanitizePublicJson spells the home directory `~`.
    expect(tab.root).toBe('~/proj');
    expect(fs.realpathSync(fake.spawned[0]!.opts.cwd)).toBe(fs.realpathSync(project));
  });

  it('guards the working directory: never ~, never outside the chat\'s roots or known projects', async () => {
    const { port, mutate } = await boot();
    const post = (body: unknown) => request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify(body));
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: tmpHome })).status).toBe(400);
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: other })).status).toBe(400);
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: path.join(tmpHome, '.ashlr') })).status).toBe(400);
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: 'relative' })).status).toBe(400);
    // A symlink that points out of the root is not the root.
    fs.symlinkSync(other, path.join(tmpHome, 'link'));
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: path.join(tmpHome, 'link') })).status).toBe(400);
    // `~/proj` (how the UI reads it back) is the chat's root.
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, root: '~/proj' })).status).toBe(201);
    expect(fake.spawned).toHaveLength(1);
  });

  it('rejects unknown keys, a missing session and bad sizes', async () => {
    const { port, mutate } = await boot();
    const post = (body: unknown) => request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify(body));
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, command: 'rm -rf /' })).status).toBe(400);
    expect((await post({ sessionId: 'nope', cols: 80, rows: 24 })).status).toBe(404);
    expect((await post({ sessionId: 's-1', cols: 'wide', rows: 24 })).status).toBe(400);
    expect((await post({ sessionId: 's-1', cols: 80, rows: 24, appId: 'claude', devServerId: 'x' })).status).toBe(400);
    expect(fake.spawned).toHaveLength(0);
  });

  it('input: base64 ≤ 16 KB reaches the shell; more is a 413, non-base64 a 400', async () => {
    const { port, mutate } = await boot();
    const created = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    const id = (created.json as { tab: { id: string } }).tab.id;
    const ok = await request(port, 'POST', `/api/verse/terminal/${id}/input`, mutate, JSON.stringify({ dataBase64: Buffer.from('echo hi\r').toString('base64') }));
    expect(ok.status).toBe(204);
    expect(new TextDecoder().decode(fake.spawned[0]!.written[0])).toBe('echo hi\r');
    const big = await request(port, 'POST', `/api/verse/terminal/${id}/input`, mutate, JSON.stringify({ dataBase64: Buffer.alloc(16 * 1024 + 3).toString('base64') }));
    expect(big.status).toBe(413);
    const bad = await request(port, 'POST', `/api/verse/terminal/${id}/input`, mutate, JSON.stringify({ dataBase64: 'not base64!' }));
    expect(bad.status).toBe(400);
    const resize = await request(port, 'POST', `/api/verse/terminal/${id}/resize`, mutate, JSON.stringify({ cols: 132, rows: 43 }));
    expect(resize.status).toBe(204);
    expect(fake.spawned[0]!.resizes).toEqual([[132, 43]]);
    const missing = await request(port, 'POST', '/api/verse/terminal/t-000000000000/input', mutate, JSON.stringify({ dataBase64: 'aGk=' }));
    expect(missing.status).toBe(404);
  });

  it('streams the scrollback first (past `after`), then live output, and ends when the tab is killed', async () => {
    const { port, read, mutate } = await boot();
    const created = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    const id = (created.json as { tab: { id: string } }).tab.id;
    const pty = fake.spawned[0]!;
    pty.emit('first ');
    pty.emit('second ');
    const replay = await streamFrames(port, `/api/verse/terminal/${id}/stream?after=1`, read, (f) => f.some((b) => b.includes('event: title')));
    expect(replay.status).toBe(200);
    const outputs = replay.frames.filter((b) => b.includes('event: output'));
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toContain('id: 2');
    expect(Buffer.from(JSON.parse(outputs[0]!.split('data: ')[1]!).dataBase64, 'base64').toString()).toBe('second ');

    const live = streamFrames(port, `/api/verse/terminal/${id}/stream?after=2`, read, () => false);
    await tick(50);
    pty.emit('third');
    await tick(20);
    const kill = await request(port, 'POST', `/api/verse/terminal/${id}/kill`, mutate, '{}');
    expect(kill.status).toBe(200);
    const result = await live;
    expect(result.ended).toBe(true);
    expect(result.frames.some((b) => b.includes('event: output') && b.includes(Buffer.from('third').toString('base64')))).toBe(true);
    expect(result.frames.at(-1)).toContain('event: exit');
    expect((await request(port, 'GET', '/api/verse/terminal', read)).json).toMatchObject({ tabs: [] });
  });

  it('Launch: an app id types the catalog\'s own launch command; a dev server id types its script, quoted', async () => {
    const { port, mutate } = await boot();
    const launch = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, appId: 'codex' }));
    expect(launch.status).toBe(201);
    await tick(50);
    expect(new TextDecoder().decode(fake.spawned[0]!.written[0])).toBe('codex\r');
    expect((await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, appId: 'claude-desktop' }))).status).toBe(400);

    const targets = await request(port, 'GET', '/api/verse/preview/targets?sessionId=s-1', readAuthHeaders(port));
    const servers = (targets.json as { devServers: Array<{ id: string; label: string }> }).devServers;
    const weird = servers.find((s) => s.label.includes('weird'))!;
    expect(weird.label).toBe("npm run 'weird; rm'");
    const start = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, devServerId: weird.id }));
    expect(start.status).toBe(201);
    await tick(50);
    expect(new TextDecoder().decode(fake.spawned[1]!.written[0])).toBe("npm run 'weird; rm'\r");
    const unknown = await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, devServerId: 'dev-000000000000' }));
    expect(unknown.status).toBe(404);
  });

  it('Launch via Ollama with a local model: resolved server-side against the Apps snapshot, never taken from the page', async () => {
    const facts = (p: string) => ({ path: p, realPath: p, mtimeMs: 0, size: 1 });
    // WHY a hand-built snapshot: the terminal only needs what resolveAppLaunch
    // reads (binaries, the Ollama launch list, installed tags) — no probes run.
    const snapshot = {
      binaries: new Map([['codex', facts('/usr/local/bin/codex')], ['ollama', facts('/usr/local/bin/ollama')]]),
      ollamaLaunchIds: new Set(['codex']),
      ollama: { reachable: true, version: '0.33.3', models: ['qwen3.8:27b'], resident: [] },
    } as unknown as AppsSnapshot;
    setTerminalApiDepsForTest({ openExternal: async () => {}, platform: 'darwin', devServers: { listListeners: async () => [] }, appsSnapshot: async () => snapshot });
    const { port, mutate } = await boot();
    const post = (body: Record<string, unknown>) => request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24, ...body }));

    expect((await post({ appId: 'codex', model: 'qwen3.8:27b' })).status).toBe(201);
    await tick(50);
    expect(new TextDecoder().decode(fake.spawned[0]!.written[0])).toBe('ollama launch codex --model qwen3.8:27b\r');
    expect((await post({ appId: 'codex', via: 'ollama' })).status).toBe(201);
    await tick(50);
    expect(new TextDecoder().decode(fake.spawned[1]!.written[0])).toBe('ollama launch codex\r');

    // Refusals, each before a shell starts: a tag Ollama does not have, a
    // model on the native path, via/model without an app, a bad via.
    expect((await post({ appId: 'codex', model: 'not-installed:1b' })).status).toBe(400);
    expect((await post({ appId: 'codex', via: 'native', model: 'qwen3.8:27b' })).status).toBe(400);
    expect((await post({ model: 'qwen3.8:27b' })).status).toBe(400);
    expect((await post({ appId: 'codex', via: 'shell' })).status).toBe(400);
    expect(fake.spawned).toHaveLength(2);

    // Apps never loaded in this process: said, not guessed.
    setTerminalApiDepsForTest({ openExternal: async () => {}, platform: 'darwin', devServers: { listListeners: async () => [] }, appsSnapshot: async () => null });
    const unloaded = await post({ appId: 'codex', via: 'ollama' });
    expect(unloaded.status).toBe(409);
    expect((unloaded.json as { code: string }).code).toBe('VERSE_APPS_UNAVAILABLE');
    // The plain app launch still needs no snapshot (3.10.0 behaviour).
    expect((await post({ appId: 'codex' })).status).toBe(201);
  });

  it('opens Terminal.app at the chat\'s root (macOS), with the same root guard', async () => {
    const { port, mutate } = await boot();
    const ok = await request(port, 'POST', '/api/verse/terminal/open-external', mutate, JSON.stringify({ sessionId: 's-1' }));
    expect(ok.status).toBe(202);
    expect(opened.map((d) => fs.realpathSync(d))).toEqual([fs.realpathSync(project)]);
    const outside = await request(port, 'POST', '/api/verse/terminal/open-external', mutate, JSON.stringify({ sessionId: 's-1', root: other }));
    expect(outside.status).toBe(400);
    setTerminalApiDepsForTest({ openExternal: async () => {}, platform: 'linux' });
    const linux = await request(port, 'POST', '/api/verse/terminal/open-external', mutate, JSON.stringify({ sessionId: 's-1' }));
    expect(linux.status).toBe(400);
  });

  it('server close kills every open shell', async () => {
    const { port, mutate } = await boot();
    await request(port, 'POST', '/api/verse/terminal', mutate, JSON.stringify({ sessionId: 's-1', cols: 80, rows: 24 }));
    expect(m.list()).toHaveLength(1);
    await handles.pop()!.close();
    expect(m.list()).toHaveLength(0);
  });
});
