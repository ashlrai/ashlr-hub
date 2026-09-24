/**
 * test/verse-server-wiring-310.test.ts — V3.10 server wiring (integrator IA1).
 *
 * The glue between the Track-A units, each piece driven without a socket or a
 * real vendor process (unit lane):
 *   - verse-api: a readiness refusal is a 409 SeatNotReadyResponse (not a 500);
 *     GET /sessions/:id honours `?after=`; the real engine singleton is built
 *     with the session-list hook wired to notifyVerseSessionsChanged().
 *   - session-engine: the list hook fires on status/title/turnCount changes
 *     only; only PERSISTED events count toward turnCount; grok's "No session
 *     found with id" recovers like claude's and codex's; crash and shutdown
 *     deliver pending reasoning taps and flush the store synchronously.
 *   - read-session: the SSE query proof admits `?topics=` / `?after=` on the
 *     routes that read them, and nothing else.
 *   - cli/verse: the background services start, fail independently, and stop.
 *
 * HOME is the per-worker temp home from test/setup/home.ts, and every engine
 * here is rooted in a mkdtemp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// Spread-mocked so everything else in web/api.ts stays real: only the push
// verse-api.ts calls from the engine's session-list hook is observed.
const notifySpy = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/web/api.js')>();
  return { ...actual, notifyVerseSessionsChanged: notifySpy };
});

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseAdapter, VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import { __resetLocalOnlyLatchForTests } from '../src/core/policy/local-only.js';
import {
  createVerseEngine,
  VerseError,
  type VerseEngineHandle,
  type VerseEngineOptions,
  type VerseSeatLaunch,
} from '../src/core/verse/session-engine.js';
import type { SeatReadiness } from '../src/core/verse/health-types.js';
import type { VerseEvent, VerseSeat, VerseSession } from '../src/core/verse/types.js';
import { getVerseEngine, handleVerseApi, resetVerseEngine, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { createReadSessionBoundary } from '../src/core/web/read-session.js';
import { startVerseBackgroundServices } from '../src/cli/verse.js';

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

/** Above every platform's pid_max: the engine's group signals can only ESRCH. */
let nextFakePid = 4_195_400;

class FakeChild extends EventEmitter {
  readonly pid = nextFakePid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean { return true; }
  unref(): void { /* nothing */ }
  line(event: Record<string, unknown>): void { this.stdout.write(`${JSON.stringify(event)}\n`); }
  exit(code: number, stderr = ''): void {
    if (stderr) this.stderr.write(stderr);
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

/** Every stdout line IS a parsed event: the engine is under test, not a vendor dialect. */
function jsonAdapter(launched: VerseSession[]): VerseAdapter {
  return {
    buildLaunch(session) {
      launched.push(JSON.parse(JSON.stringify(session)) as VerseSession);
      return { argv: ['/opt/fake/bin/fake-cli'], cwd: session.projectPath, env: {}, stdin: null };
    },
    createParser(turnId) {
      return {
        push(line: string): VerseParsedEvent[] {
          try { return [{ turnId, ...(JSON.parse(line) as object) } as VerseParsedEvent]; } catch { return []; }
        },
        finish(): VerseParsedEvent[] { return []; },
        nativeSessionId(): string | null { return null; },
      };
    },
  };
}

const OPEN_CFG = {
  version: 1,
  roots: ['/tmp'],
  editor: { name: 'vscode' },
  models: { providerChain: ['anthropic', 'ollama'], ollama: 'http://localhost:11434', lmstudio: 'http://localhost:1234', routing: [] },
  foundry: { allowedBackends: ['builtin', 'local-coder', 'claude', 'codex', 'nim', 'kimi', 'grok'], claude5: { enabled: false } },
} as unknown as AshlrConfig;

function seat(engine: VerseSeat['engine'], id: string): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: engine === 'local' ? 'local' : id,
    models: [{ id: engine === 'local' ? 'qwen3-coder' : 'grok-4', label: 'm', contextWindow: 32_000 }],
    contextWindow: null,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };
}

const GROK = seat('grok', 'grok-a');
const LOCAL = seat('local', 'local:qwen3-coder');

function launchFor(s: VerseSeat): VerseSeatLaunch {
  return {
    seat: s,
    launcher: s.engine === 'local' ? null : ['/opt/fake/node', '/opt/fake/launcher.mjs'],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let work: string;
let root: string;
let project: string;
let children: FakeChild[];
let launched: VerseSession[];
let engines: VerseEngineHandle[];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'verse-wiring-'));
  root = join(work, 'root');
  project = join(work, 'project');
  mkdirSync(project, { mode: 0o700 });
  project = realpathSync(project);
  children = [];
  launched = [];
  engines = [];
  notifySpy.mockClear();
  __resetLocalOnlyLatchForTests();
});

afterEach(() => {
  for (const engine of engines) {
    try { engine.close(); } catch { /* closed */ }
  }
  resetVerseEngine(null);
  rmSync(work, { recursive: true, force: true });
  __resetLocalOnlyLatchForTests();
});

function makeEngine(opts: VerseEngineOptions = {}): VerseEngineHandle {
  const engine = createVerseEngine({
    root,
    killGraceMs: 30,
    loadConfig: () => OPEN_CFG,
    adapterFor: () => jsonAdapter(launched),
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as VerseEngineOptions['spawn'],
    readiness: null,
    reasoningTap: null,
    preflight: null,
    processRegistry: false,
    ...opts,
  });
  engines.push(engine);
  return engine;
}

function collect(engine: VerseEngineHandle, id: string): VerseEvent[] {
  const seen: VerseEvent[] = [];
  engine.subscribe(id, Number.MAX_SAFE_INTEGER, (event) => seen.push(event));
  return seen;
}

// ---------------------------------------------------------------------------
// verse-api: direct handler calls with an in-memory req/res
// ---------------------------------------------------------------------------

const TOKEN = 'm'.repeat(64);

function apiCtx(): VerseApiContext {
  return { cfg: OPEN_CFG, token: TOKEN, allowDispatch: true };
}

function fakeReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(req, {
    method,
    url,
    headers: body === undefined ? {} : { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' },
  });
  if (body === undefined) req.end();
  else req.end(JSON.stringify(body));
  return req;
}

interface Captured { status: number; body: Record<string, unknown> }

function fakeRes(): { res: ServerResponse; done: Promise<Captured> } {
  let resolve!: (value: Captured) => void;
  const done = new Promise<Captured>((r) => { resolve = r; });
  let status = 0;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    setHeader() { /* unused */ },
    end(payload?: string) {
      this.writableEnded = true;
      resolve({ status, body: payload ? JSON.parse(payload) as Record<string, unknown> : {} });
    },
  };
  return { res: res as unknown as ServerResponse, done };
}

async function call(method: string, url: string, body?: unknown): Promise<Captured> {
  const { res, done } = fakeRes();
  const path = url.split('?')[0]!;
  const handled = await handleVerseApi(apiCtx(), fakeReq(method, url, body), res, path, method);
  expect(handled).toBe(true);
  return done;
}

function event(seq: number, type: 'user-message' | 'assistant-message', text: string): VerseEvent {
  return { seq, at: '2026-09-23T00:00:00.000Z', type, turnId: 't1', text } as VerseEvent;
}

/** Just enough engine for the two routes under test. */
function fakeEngine(overrides: Partial<VerseEngineHandle> = {}): VerseEngineHandle {
  const session = { id: 's1', status: 'idle', title: 'x', turnCount: 0 } as unknown as VerseSession;
  const events = [event(1, 'user-message', 'a'), event(2, 'assistant-message', 'b'), event(3, 'user-message', 'c')];
  return {
    listSessions: () => [session],
    getSession: (id: string) => (id === 's1' ? session : null),
    getEvents: (_id: string, fromSeq = 0) => events.filter((e) => e.seq > fromSeq),
    subscribe: () => () => {},
    close: () => {},
    ...overrides,
  } as unknown as VerseEngineHandle;
}

describe('verse-api: readiness refusal', () => {
  const refusal: SeatReadiness = { seatId: 'claude-a', ready: false, reason: 'claude-a is signed out', alternatives: ['grok-a', 'local:qwen3-coder'] };

  it('answers a VERSE_SEAT_NOT_READY from the engine with the 409 SeatNotReadyResponse', async () => {
    resetVerseEngine(fakeEngine({
      sendTurn: () => { throw new VerseError('VERSE_SEAT_NOT_READY', 'claude-a is signed out', { readiness: refusal }); },
    }));
    const response = await call('POST', '/api/verse/sessions/s1/turns', { text: 'hello' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'claude-a is signed out', code: 'seat-not-ready', readiness: refusal });
  });

  it('keeps the 409 and its code when the refusal carries no usable readiness (never a 500)', async () => {
    resetVerseEngine(fakeEngine({
      sendTurn: () => { throw Object.assign(new Error('not ready'), { code: 'VERSE_SEAT_NOT_READY', readiness: { seatId: 3 } }); },
    }));
    const response = await call('POST', '/api/verse/sessions/s1/turns', { text: 'hello' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'seat-not-ready', error: 'not ready' });
  });

  it('leaves the other engine codes mapped as before', async () => {
    resetVerseEngine(fakeEngine({
      sendTurn: () => { throw new VerseError('VERSE_SESSION_BUSY', 'a turn is already running'); },
    }));
    const response = await call('POST', '/api/verse/sessions/s1/turns', { text: 'hello' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ code: 'VERSE_SESSION_BUSY', error: 'a turn is already running' });
  });
});

describe('verse-api: GET /sessions/:id?after=', () => {
  beforeEach(() => { resetVerseEngine(fakeEngine()); });

  it('returns only events after the cursor, and the whole log without one', async () => {
    const all = await call('GET', '/api/verse/sessions/s1');
    expect(all.status).toBe(200);
    expect((all.body['events'] as VerseEvent[]).map((e) => e.seq)).toEqual([1, 2, 3]);
    const tail = await call('GET', '/api/verse/sessions/s1?after=2');
    expect(tail.status).toBe(200);
    expect((tail.body['events'] as VerseEvent[]).map((e) => e.seq)).toEqual([3]);
    expect((tail.body['session'] as VerseSession).id).toBe('s1');
    const past = await call('GET', '/api/verse/sessions/s1?after=99');
    expect(past.body['events']).toEqual([]);
    const zero = await call('GET', '/api/verse/sessions/s1?after=0');
    expect((zero.body['events'] as VerseEvent[]).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('refuses a malformed, repeated or unknown query instead of replaying from the start', async () => {
    for (const url of [
      '/api/verse/sessions/s1?after=abc',
      '/api/verse/sessions/s1?after=-1',
      '/api/verse/sessions/s1?after=1e3',
      '/api/verse/sessions/s1?after=',
      '/api/verse/sessions/s1?after=1&after=2',
      '/api/verse/sessions/s1?since=1',
    ]) {
      const response = await call('GET', url);
      expect(response.status, url).toBe(400);
      expect(response.body['code']).toBe('VERSE_INVALID');
    }
  });

  it('still 404s an unknown session', async () => {
    const response = await call('GET', '/api/verse/sessions/nope?after=1');
    expect(response.status).toBe(404);
  });
});

describe('verse-api: the real engine singleton', () => {
  it('is built with the session-list hook wired to notifyVerseSessionsChanged', async () => {
    const prevHome = process.env['HOME'];
    process.env['HOME'] = work;
    try {
      resetVerseEngine(null);
      const engine = await getVerseEngine();
      expect(notifySpy).not.toHaveBeenCalled();
      const created = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
      expect(notifySpy).toHaveBeenCalledTimes(1);
      engine.renameSession(created.id, 'Renamed');
      expect(notifySpy).toHaveBeenCalledTimes(2);
      engine.deleteSession(created.id);
      expect(notifySpy).toHaveBeenCalledTimes(3);
    } finally {
      resetVerseEngine(null);
      process.env['HOME'] = prevHome;
    }
  });
});

// ---------------------------------------------------------------------------
// session-engine
// ---------------------------------------------------------------------------

describe('session-engine: session-list hook', () => {
  it('fires on create, turn start, turn end, rename and delete — not on readings that change nothing listed', async () => {
    const seenStates: string[] = [];
    // The hook reads the engine it is installed on; a holder breaks the cycle.
    const holder: { engine: VerseEngineHandle | null } = { engine: null };
    const hook = vi.fn((id: string) => {
      const s = holder.engine?.getSession(id);
      seenStates.push(s ? `${s.status}:${s.turnCount}:${s.title}` : 'deleted');
    });
    const engine = makeEngine({ onSessionChange: hook });
    holder.engine = engine;
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id, title: 'Chat' }, launchFor(LOCAL));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    const child = children[0]!;
    child.line({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 15, contextWindow: 32_000 },
    });
    child.line({ type: 'assistant-message', text: 'hi' });
    child.exit(0);
    await waitFor(() => seen.some((e) => e.type === 'turn-done'));
    engine.renameSession(s.id, 'Renamed');
    engine.renameSession(s.id, 'Renamed'); // unchanged: no announcement
    engine.deleteSession(s.id);

    expect(hook.mock.calls.every(([id]) => id === s.id)).toBe(true);
    expect(seenStates).toEqual([
      'idle:0:Chat',
      'running:0:Chat',
      'idle:1:Chat',
      'idle:1:Renamed',
      'deleted',
    ]);
  });

  it('never lets a throwing hook break a turn', async () => {
    const engine = makeEngine({ onSessionChange: () => { throw new Error('listener bug'); }, log: () => {} });
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    children[0]!.line({ type: 'assistant-message', text: 'ok' });
    children[0]!.exit(0);
    await waitFor(() => seen.some((e) => e.type === 'turn-done'));
    expect(engine.getSession(s.id)).toMatchObject({ status: 'idle', turnCount: 1 });
  });
});

describe('session-engine: turnCount counts persisted output only', () => {
  it('does not count a failed turn that produced only transient notices', async () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    children[0]!.line({ type: 'status', kind: 'retry', message: 'API retry 1/10' });
    children[0]!.line({ type: 'progress', phase: 'waiting', elapsedMs: 5 });
    children[0]!.exit(1);
    await waitFor(() => seen.some((e) => e.type === 'turn-done'));
    // The notices were delivered live…
    expect(seen.some((e) => e.type === 'status')).toBe(true);
    // …but the vendor side never engaged, so the next launch must not resume.
    expect(engine.getSession(s.id)).toMatchObject({ status: 'error', turnCount: 0 });
  });

  it('counts a failed turn once a persisted event arrived', async () => {
    const engine = makeEngine();
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    children[0]!.line({ type: 'status', kind: 'retry', message: 'API retry 1/10' });
    children[0]!.line({ type: 'assistant-message', text: 'partial' });
    children[0]!.exit(1);
    await waitFor(() => seen.some((e) => e.type === 'turn-done'));
    expect(engine.getSession(s.id)).toMatchObject({ status: 'error', turnCount: 1 });
  });
});

describe('session-engine: grok lost-thread recovery', () => {
  it('classifies grok’s "No session found with id" (stderr only) and retries once on a new native session', async () => {
    const engine = makeEngine({ log: () => {} });
    const s = engine.createSession({ projectPath: project, seatId: GROK.id }, launchFor(GROK));
    const seen = collect(engine, s.id);
    engine.sendTurn(s.id, 'hello');
    children[0]!.exit(1, 'Error: No session found with id 0199-abc');
    await waitFor(() => children.length === 2);
    children[1]!.line({ type: 'assistant-message', text: 'back' });
    children[1]!.exit(0);
    await waitFor(() => seen.some((e) => e.type === 'turn-done'));

    const recovered = seen.find((e) => e.type === 'recovered');
    expect(recovered).toMatchObject({ how: 'new-native-session' });
    // The retry was launched as a NEW conversation.
    expect(launched[1]).toMatchObject({ turnCount: 0 });
    expect(launched[1]!.nativeSessionId).not.toBe(launched[0]!.nativeSessionId);
    expect(seen.filter((e) => e.type === 'turn-done')).toMatchObject([{ ok: true }]);
  });
});

describe('session-engine: reasoning flush on crash and shutdown', () => {
  it('interruptAll delivers every pending tap synchronously, then flushes the store', () => {
    const order: string[] = [];
    const engine = makeEngine({
      reasoningTap: (e) => { order.push(`tap:${e.type}`); },
      reasoningFlush: () => { order.push('flush'); },
      log: () => {},
    });
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    engine.sendTurn(s.id, 'hello');
    // Synchronously, as the crash handler does: no tick has run the queue.
    expect(order).toEqual([]);
    expect(engine.interruptAll!('server crashed')).toBe(1);
    expect(order.at(-1)).toBe('flush');
    expect(order.slice(0, -1)).toEqual(expect.arrayContaining(['tap:user-message', 'tap:turn-started', 'tap:error', 'tap:turn-done']));
    expect(order.indexOf('tap:turn-done')).toBeLessThan(order.indexOf('flush'));
  });

  it('close() flushes after settling running turns', () => {
    const order: string[] = [];
    const engine = makeEngine({
      reasoningTap: (e) => { order.push(`tap:${e.type}`); },
      reasoningFlush: () => { order.push('flush'); },
    });
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    engine.sendTurn(s.id, 'hello');
    engine.close();
    expect(order).toContain('tap:cancelled');
    expect(order.at(-1)).toBe('flush');
  });

  it('delivers taps on the next tick as before when nothing is shutting down', async () => {
    const tapped: string[] = [];
    const flush = vi.fn();
    const engine = makeEngine({ reasoningTap: (e) => { tapped.push(e.type); }, reasoningFlush: flush });
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    engine.sendTurn(s.id, 'hello');
    expect(tapped).toEqual([]);
    await new Promise((r) => setImmediate(r));
    expect(tapped).toEqual(['user-message', 'turn-started']);
    expect(flush).not.toHaveBeenCalled();
  });

  it('a throwing flush never escapes the crash path', () => {
    const engine = makeEngine({ reasoningTap: () => {}, reasoningFlush: () => { throw new Error('disk gone'); }, log: () => {} });
    const s = engine.createSession({ projectPath: project, seatId: LOCAL.id }, launchFor(LOCAL));
    engine.sendTurn(s.id, 'hello');
    expect(() => engine.interruptAll!('server crashed')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// read-session: SSE query proof with data parameters
// ---------------------------------------------------------------------------

describe('read-session: SSE data parameters beside the client proof', () => {
  const PROOF = 'a'.repeat(64);
  const boundary = createReadSessionBoundary();
  let cookie = '';

  beforeEach(() => {
    const req = {
      method: 'POST',
      url: '/api/session',
      headers: { 'x-ashlr-token': boundary.readToken, 'x-ashlr-read-client': PROOF },
    } as unknown as IncomingMessage;
    let setCookie = '';
    const res = {
      writeHead(_status: number, headers: Record<string, string>) { setCookie = headers['Set-Cookie'] ?? ''; return this; },
      end() { /* 204 */ },
    } as unknown as ServerResponse;
    expect(boundary.handleSession(req, res, new URL('http://localhost/api/session'))).toBe(true);
    cookie = setCookie.split(';', 1)[0]!;
    expect(cookie.startsWith('ashlr_read_session=')).toBe(true);
  });

  function authorised(pathAndQuery: string, headers: Record<string, string> = {}): boolean {
    const req = { method: 'GET', url: pathAndQuery, headers: { cookie, ...headers } } as unknown as IncomingMessage;
    return boundary.authority(req, new URL(pathAndQuery, 'http://localhost')) !== null;
  }

  const VERSE = '/api/verse/sessions/s1/events';

  it('admits the proof alone, exactly as before', () => {
    expect(authorised(`/api/events?client=${PROOF}`)).toBe(true);
    expect(authorised(`${VERSE}?client=${PROOF}`)).toBe(true);
    expect(authorised(`/api/run/r1/events?client=${PROOF}`)).toBe(true);
  });

  it('admits ?topics= on /api/events and ?after= on the Verse tail, in either order', () => {
    expect(authorised(`/api/events?topics=verse-sessions&client=${PROOF}`)).toBe(true);
    expect(authorised(`/api/events?client=${PROOF}&topics=verse-sessions,runs`)).toBe(true);
    expect(authorised(`${VERSE}?after=40&client=${PROOF}`)).toBe(true);
    expect(authorised(`${VERSE}?client=${PROOF}&after=0`)).toBe(true);
  });

  it('keeps each data parameter to the route that reads it', () => {
    expect(authorised(`/api/events?after=40&client=${PROOF}`)).toBe(false);
    expect(authorised(`${VERSE}?topics=verse-sessions&client=${PROOF}`)).toBe(false);
    expect(authorised(`/api/run/r1/events?after=1&client=${PROOF}`)).toBe(false);
  });

  it('fails closed on a malformed value, a repeat, an unknown parameter, or a missing proof', () => {
    for (const path of [
      `${VERSE}?after=-1&client=${PROOF}`,
      `${VERSE}?after=abc&client=${PROOF}`,
      `${VERSE}?after=${'9'.repeat(16)}&client=${PROOF}`,
      `${VERSE}?after=1&after=2&client=${PROOF}`,
      `${VERSE}?after=1&client=${PROOF}&client=${PROOF}`,
      `${VERSE}?after=1&extra=1&client=${PROOF}`,
      `${VERSE}?after=1`,
      `${VERSE}?after=${PROOF}&client=${'b'.repeat(64)}`,
      `/api/events?topics=VERSE&client=${PROOF}`,
      `/api/events?topics=verse-sessions;x&client=${PROOF}`,
      `/api/events?topics=${'a,'.repeat(200)}a&client=${PROOF}`,
      `/api/events?topics=a&topics=b&client=${PROOF}`,
      `/api/events?client=${PROOF}&extra=1`,
    ]) {
      expect(authorised(path), path).toBe(false);
    }
  });

  it('still refuses the query proof alongside the header, and on non-SSE routes', () => {
    expect(authorised(`${VERSE}?after=1&client=${PROOF}`, { 'x-ashlr-read-client': PROOF })).toBe(false);
    expect(authorised(`/api/verse/sessions/s1?after=1&client=${PROOF}`)).toBe(false);
    // A normal fetch keeps using the header, with any query of its own.
    expect(authorised('/api/verse/sessions/s1?after=1', { 'x-ashlr-read-client': PROOF })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cli/verse: background services
// ---------------------------------------------------------------------------

describe('cli/verse: background services', () => {
  function fakes(order: string[]) {
    return {
      loadHealth: async () => ({
        startVerseHealth: (cfg: AshlrConfig) => { order.push(`health:start:${cfg === OPEN_CFG}`); },
        stopVerseHealth: () => { order.push('health:stop'); },
      }),
      loadClaudeUsage: async () => ({
        // Never settles: proves the prime is not awaited.
        primeClaudeUsage: () => { order.push('usage:prime'); return new Promise<void>(() => {}); },
      }),
      loadReasoning: async () => ({
        scheduleReasoningMaintenance: () => { order.push('reasoning:start'); },
        resetReasoningApiState: () => { order.push('reasoning:stop'); },
      }),
      loadBudget: async () => ({
        startBudgetCapacityPublisher: () => { order.push('budget:start'); return () => { order.push('budget:stop'); }; },
      }),
    };
  }

  it('starts all four with the server config, without awaiting the usage prime, and stops them newest first', async () => {
    const order: string[] = [];
    const services = await startVerseBackgroundServices(OPEN_CFG, fakes(order));
    expect(services.started).toEqual(['health', 'claude-usage', 'reasoning', 'budget']);
    expect(order).toEqual(['health:start:true', 'usage:prime', 'reasoning:start', 'budget:start']);
    services.stop();
    services.stop(); // idempotent
    expect(order.slice(4)).toEqual(['budget:stop', 'reasoning:stop', 'health:stop']);
  });

  it('a service that fails to load or start is reported and skipped; the rest still run', async () => {
    const order: string[] = [];
    const log = vi.fn();
    const services = await startVerseBackgroundServices(OPEN_CFG, {
      ...fakes(order),
      loadHealth: async () => { throw new Error('module missing'); },
      loadReasoning: async () => ({
        scheduleReasoningMaintenance: () => { throw new Error('bad root'); },
        resetReasoningApiState: () => { order.push('reasoning:stop'); },
      }),
      log,
    });
    expect(services.started).toEqual(['claude-usage', 'budget']);
    expect(log.mock.calls.map(([m]) => m)).toEqual([
      'health did not start: module missing',
      'reasoning did not start: bad root',
    ]);
    services.stop();
    expect(order).toEqual(['usage:prime', 'budget:start', 'budget:stop']);
  });

  it('skips the account services under --no-accounts', async () => {
    const order: string[] = [];
    const services = await startVerseBackgroundServices(OPEN_CFG, { ...fakes(order), accountServices: false });
    expect(services.started).toEqual(['claude-usage', 'reasoning']);
    services.stop();
    expect(order).toEqual(['usage:prime', 'reasoning:start', 'reasoning:stop']);
  });

  it('a throwing stopper does not keep the others from stopping', async () => {
    const order: string[] = [];
    const log = vi.fn();
    const services = await startVerseBackgroundServices(OPEN_CFG, {
      ...fakes(order),
      loadBudget: async () => ({ startBudgetCapacityPublisher: () => () => { throw new Error('timer gone'); } }),
      log,
    });
    services.stop();
    expect(order).toContain('reasoning:stop');
    expect(order).toContain('health:stop');
    expect(log).toHaveBeenCalledWith('budget did not stop cleanly: timer gone');
  });
});
