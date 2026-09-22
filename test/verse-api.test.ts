/**
 * Tests for /api/verse/* (src/core/verse/verse-api.ts + verse-stream.ts).
 *
 * Runs the REAL server (test/helpers/authenticated-web-server.ts) under a
 * relocated HOME, with a fake VerseEngineHandle injected through the
 * resetVerseEngine() hook — so no vendor CLI is spawned and owner A's engine
 * is not exercised here. Real loopback bind → real-io lane.
 *
 * Covers: bootstrap shape (no launcher leaks), read boundary on GETs, POST
 * 401 without the mutation token, POST 404 when dispatch is off, create 201,
 * turns 202 then 409 while running, session detail / rename / cancel /
 * delete, and the SSE tail with Last-Event-ID resume + live delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type {
  VerseCreateSessionRequest,
  VerseEvent,
  VerseSession,
  VerseUsage,
} from '../src/core/verse/types.js';
import type { VerseEngineHandle, VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { resetVerseEngine, invalidateVerseSeatCache, expandHomePrefix } from '../src/core/verse/verse-api.js';
import { readAuthHeaders, readSseAuth, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Fake engine (in-memory, contract-shaped)
// ---------------------------------------------------------------------------

class FakeVerseError extends Error {
  constructor(
    public readonly code: 'VERSE_SESSION_NOT_FOUND' | 'VERSE_SESSION_BUSY' | 'VERSE_INVALID' | 'VERSE_TOO_LARGE',
    public readonly status: 404 | 409 | 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

function zeroUsage(): VerseUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null };
}

type Draft = Omit<VerseEvent, 'seq' | 'at'>;

class FakeEngine implements VerseEngineHandle {
  readonly sessions = new Map<string, VerseSession>();
  readonly events = new Map<string, VerseEvent[]>();
  readonly listeners = new Map<string, Set<(e: VerseEvent) => void>>();
  /** PRIVATE launches the API handed us — asserted on, never serialized. */
  readonly launches: VerseSeatLaunch[] = [];
  readonly createRequests: VerseCreateSessionRequest[] = [];
  closed = false;
  private counter = 0;

  listSessions(): VerseSession[] { return [...this.sessions.values()]; }
  getSession(id: string): VerseSession | null { return this.sessions.get(id) ?? null; }
  getEvents(id: string, fromSeq = -1): VerseEvent[] {
    return (this.events.get(id) ?? []).filter((e) => e.seq > fromSeq);
  }
  createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch): VerseSession {
    this.createRequests.push(req);
    this.launches.push(launch);
    const id = `s${++this.counter}`;
    const now = new Date().toISOString();
    const session: VerseSession = {
      id,
      title: req.title ?? 'New chat',
      projectPath: req.projectPath,
      engine: launch.seat.engine,
      accountId: launch.seat.accountId,
      seatId: launch.seat.id,
      model: req.model ?? launch.seat.models[0]?.id ?? 'unknown',
      nativeSessionId: null,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      turnCount: 0,
      usage: zeroUsage(),
      lastError: null,
    };
    this.sessions.set(id, session);
    this.events.set(id, []);
    return session;
  }
  sendTurn(id: string, text: string): { turnId: string; session: VerseSession } {
    const session = this.must(id);
    if (session.status === 'running') throw new FakeVerseError('VERSE_SESSION_BUSY', 409, 'turn already running');
    const turnId = `t${++this.counter}`;
    session.status = 'running';
    session.turnCount += 1;
    session.updatedAt = new Date().toISOString();
    this.emit(id, { type: 'user-message', turnId, text });
    this.emit(id, { type: 'turn-started', turnId, pid: null });
    return { turnId, session };
  }
  cancelTurn(id: string): boolean {
    const session = this.must(id);
    if (session.status !== 'running') return false;
    session.status = 'idle';
    this.emit(id, { type: 'cancelled', turnId: 'tX' });
    return true;
  }
  deleteSession(id: string): void {
    this.must(id);
    this.sessions.delete(id);
    this.events.delete(id);
    this.listeners.delete(id);
  }
  renameSession(id: string, title: string): VerseSession {
    const session = this.must(id);
    session.title = title;
    session.updatedAt = new Date().toISOString();
    return session;
  }
  subscribe(id: string, fromSeq: number, listener: (event: VerseEvent) => void): () => void {
    this.must(id);
    for (const e of this.getEvents(id, fromSeq)) listener(e);
    let set = this.listeners.get(id);
    if (!set) { set = new Set(); this.listeners.set(id, set); }
    set.add(listener);
    return () => { set?.delete(listener); };
  }
  /** Like the real engine: every running turn is settled (cancelled + turn-done) and the record saved. */
  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue;
      const turnId = [...(this.events.get(session.id) ?? [])].reverse().find((e) => e.type === 'turn-started')?.turnId ?? 'tX';
      this.emit(session.id, { type: 'cancelled', turnId });
      this.emit(session.id, { type: 'turn-done', turnId, ok: false, nativeSessionId: session.nativeSessionId, durationMs: 0 });
      session.status = 'idle';
      session.updatedAt = new Date().toISOString();
    }
  }

  /** Test-only: push a live event. */
  emit(id: string, draft: Draft): VerseEvent {
    const list = this.events.get(id) ?? [];
    const event = { ...draft, seq: list.length + 1, at: new Date().toISOString() } as VerseEvent;
    list.push(event);
    this.events.set(id, list);
    for (const l of this.listeners.get(id) ?? []) l(event);
    return event;
  }
  private must(id: string): VerseSession {
    const s = this.sessions.get(id);
    if (!s) throw new FakeVerseError('VERSE_SESSION_NOT_FOUND', 404, `session not found: ${id}`);
    return s;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CLAUDE_COMMAND = ['/opt/private/launchers/claude-max-profile', '--profile', 'mason-max'];

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    // Port 1 refuses immediately: no local seats, no 2s timeout wait.
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

function makeOpts(overrides: Partial<WebServerOptions> = {}): WebServerOptions {
  return { port: 0, open: false, allowDispatch: true, ...overrides };
}

interface HttpResult { status: number; body: string; json: unknown }

function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
        res.on('end', () => {
          let json: unknown = null;
          try { json = JSON.parse(raw); } catch { /* not json */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface Frame { id?: string; event: string; data: unknown }

/** Open an SSE connection and collect frames until `until` returns true (or timeout). */
function collectSse(
  port: number,
  urlPath: string,
  headers: Record<string, string>,
  until: (frames: Frame[]) => boolean,
  onOpen?: () => void,
  timeoutMs = 6000,
): Promise<{ status: number; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    let buffer = '';
    let settled = false;
    let status = 0;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        status = res.statusCode ?? 0;
        if (status !== 200) {
          let raw = '';
          res.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
          res.on('end', () => { settled = true; resolve({ status, frames: [{ event: 'error-response', data: raw }] }); });
          return;
        }
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (raw.startsWith(': connected')) { onOpen?.(); continue; }
            if (raw.startsWith(':')) continue;
            let id: string | undefined;
            let event = 'message';
            let dataRaw = '';
            for (const line of raw.split('\n')) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) dataRaw = line.slice(6);
            }
            let data: unknown = dataRaw;
            try { data = JSON.parse(dataRaw); } catch { /* keep raw */ }
            frames.push({ id, event, data });
          }
          if (!settled && until(frames)) {
            settled = true;
            res.destroy();
            req.destroy();
            resolve({ status, frames });
          }
        });
        res.on('end', () => { if (!settled) { settled = true; resolve({ status, frames }); } });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (settled && (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')) return;
      if (!settled) reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      if (!settled) { settled = true; req.destroy(); resolve({ status, frames }); }
    });
    req.end();
  });
}

let tmpHome: string;
let tmpRepoRoot: string;
let repo: string;
let prevHome: string | undefined;
let engine: FakeEngine;
let cfg: AshlrConfig;
let handles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-api-home-'));
  tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-api-repos-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;

  const accountsRoot = path.join(tmpHome, '.ashlr', 'account-connections');
  fs.mkdirSync(accountsRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsRoot, 'connections.json'), JSON.stringify({
    accounts: [{ id: 'claude', label: 'Claude Code', provider: 'claude', command: CLAUDE_COMMAND }],
  }));
  repo = fs.mkdtempSync(path.join(tmpRepoRoot, 'repo-'));
  fs.writeFileSync(path.join(tmpHome, '.ashlr', 'enrollment.json'), JSON.stringify({
    repos: [repo, path.join(tmpRepoRoot, 'missing')],
  }));

  cfg = makeConfig(accountsRoot);
  engine = new FakeEngine();
  resetVerseEngine(engine);
  invalidateVerseSeatCache();
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  resetVerseEngine(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(cfg, makeOpts(opts));
  handles.push(handle);
  const read = readAuthHeaders(handle.port);
  const mutate = { 'x-ashlr-token': handle.token, 'content-type': 'application/json' };
  return { handle, port: handle.port, read, mutate };
}

async function createSession(port: number, mutate: Record<string, string>, extra: Partial<VerseCreateSessionRequest> = {}) {
  const res = await request(port, 'POST', '/api/verse/sessions', mutate, JSON.stringify({
    projectPath: repo, seatId: 'claude', ...extra,
  }));
  expect(res.status).toBe(201);
  return res.json as VerseSession;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/verse/bootstrap', () => {
  it('returns seats, projects, sessions, dispatch flag and local runtime — without launcher commands', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/bootstrap', read);
    expect(res.status).toBe(200);
    const body = res.json as {
      seats: Array<{ id: string; engine: string; models: Array<{ id: string }> }>;
      projects: Array<{ path: string; name: string; enrolled: boolean }>;
      sessions: unknown[];
      dispatchEnabled: boolean;
      localRuntime: { ollama: { reachable: boolean; baseUrl: string; models: string[] } };
    };
    expect(Object.keys(body).sort()).toEqual(['dispatchEnabled', 'localRuntime', 'projects', 'seats', 'sessions']);
    expect(body.seats.map((s) => s.id)).toEqual(['claude']);
    // The FIRST model is what a new session defaults to, so it must be the
    // newest the catalog offers — not whichever was newest when this was
    // written. Pinning a specific id here is how this test broke the moment
    // Fable 5.1 was added, and how the Codex list sat stale at gpt-5.5 while
    // the catalog had already moved to the GPT-6 family.
    expect(body.seats[0]?.models[0]?.id).toBe('claude-fable-5-1');
    expect(body.projects).toEqual([{ path: repo, name: path.basename(repo), enrolled: true }]);
    expect(body.sessions).toEqual([]);
    expect(body.dispatchEnabled).toBe(true);
    expect(body.localRuntime.ollama.reachable).toBe(false);
    expect(body.localRuntime.ollama.baseUrl).toBe('http://127.0.0.1:1');

    expect(res.body).not.toContain('command');
    expect(res.body).not.toContain('launcher');
    for (const part of CLAUDE_COMMAND) expect(res.body).not.toContain(part);
  });

  it('reports dispatchEnabled=false on a read-only server', async () => {
    const { port, read } = await boot({ allowDispatch: false });
    const res = await request(port, 'GET', '/api/verse/bootstrap', read);
    expect(res.status).toBe(200);
    expect((res.json as { dispatchEnabled: boolean }).dispatchEnabled).toBe(false);
  });

  it('is behind the read boundary like every other GET /api/*', async () => {
    const { port } = await boot();
    const res = await request(port, 'GET', '/api/verse/bootstrap');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/verse/sessions — gates', () => {
  it('401 without the mutation token (the read token is not enough)', async () => {
    const { port, read } = await boot();
    const noToken = await request(port, 'POST', '/api/verse/sessions', { 'content-type': 'application/json' }, '{}');
    expect(noToken.status).toBe(401);
    const readToken = await request(port, 'POST', '/api/verse/sessions', { ...read, 'content-type': 'application/json' }, '{}');
    expect(readToken.status).toBe(401);
    expect(engine.sessions.size).toBe(0);
  });

  it('404 when dispatch is off, even with a valid token', async () => {
    const { port, mutate } = await boot({ allowDispatch: false });
    const res = await request(port, 'POST', '/api/verse/sessions', mutate, JSON.stringify({ projectPath: repo, seatId: 'claude' }));
    expect(res.status).toBe(404);
    const turn = await request(port, 'POST', '/api/verse/sessions/s1/turns', mutate, JSON.stringify({ text: 'hi' }));
    expect(turn.status).toBe(404);
    expect(engine.sessions.size).toBe(0);
  });

  it('415 without a JSON Content-Type; 400 on invalid body / unknown seat', async () => {
    const { port, handle, mutate } = await boot();
    const wrongType = await request(port, 'POST', '/api/verse/sessions', { 'x-ashlr-token': handle.token }, '{}');
    expect(wrongType.status).toBe(415);

    const badJson = await request(port, 'POST', '/api/verse/sessions', mutate, '{ nope');
    expect(badJson.status).toBe(400);
    expect((badJson.json as { code: string }).code).toBe('VERSE_INVALID');

    const noSeat = await request(port, 'POST', '/api/verse/sessions', mutate, JSON.stringify({ projectPath: repo }));
    expect(noSeat.status).toBe(400);

    const unknownSeat = await request(port, 'POST', '/api/verse/sessions', mutate, JSON.stringify({ projectPath: repo, seatId: 'nope' }));
    expect(unknownSeat.status).toBe(400);
    expect((unknownSeat.json as { code: string; error: string }).error).toContain('unknown seat');
    expect(engine.sessions.size).toBe(0);
  });
});

describe('sessions lifecycle', () => {
  it('creates a session (201), hands the private launch to the engine, and never echoes it', async () => {
    const { port, read, mutate } = await boot();
    const session = await createSession(port, mutate, { title: 'Fix the thing', model: 'claude-sonnet-5' });
    expect(session.id).toBe('s1');
    expect(session.seatId).toBe('claude');
    expect(session.engine).toBe('claude');
    expect(session.model).toBe('claude-sonnet-5');
    expect(session.title).toBe('Fix the thing');
    expect(session.projectPath).toBe(repo);
    expect(session.status).toBe('idle');

    expect(engine.launches).toHaveLength(1);
    expect(engine.launches[0]?.launcher).toEqual(CLAUDE_COMMAND);
    expect(engine.launches[0]?.seat.id).toBe('claude');
    expect(engine.launches[0]?.ollamaBaseUrl).toBe('http://127.0.0.1:1');

    const list = await request(port, 'GET', '/api/verse/sessions', read);
    expect(list.status).toBe(200);
    expect((list.json as VerseSession[]).map((s) => s.id)).toEqual(['s1']);
    for (const part of CLAUDE_COMMAND) expect(list.body).not.toContain(part);

    const bootstrap = await request(port, 'GET', '/api/verse/bootstrap', read);
    const body = bootstrap.json as { sessions: VerseSession[]; projects: Array<{ path: string; enrolled: boolean }> };
    expect(body.sessions.map((s) => s.id)).toEqual(['s1']);
    expect(body.projects.map((p) => p.path)).toEqual([repo]);
  });

  it('expands a `~/` project path (sanitized round-trip) before the engine sees it', async () => {
    const { port, mutate } = await boot();
    const inside = path.join(tmpHome, 'proj');
    fs.mkdirSync(inside);
    const session = await createSession(port, mutate, { projectPath: '~/proj' });
    expect(engine.createRequests[0]?.projectPath).toBe(inside);
    // Outbound, the home dir is redacted to `~` by sanitizePublicJson.
    expect(session.projectPath).toBe('~/proj');
    expect(expandHomePrefix('~/proj')).toBe(inside);
  });

  it('turns: 202 while idle, 409 VERSE_SESSION_BUSY while running, 413 when too large', async () => {
    const { port, mutate } = await boot();
    const session = await createSession(port, mutate);

    const first = await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: 'hello' }));
    expect(first.status).toBe(202);
    const turn = first.json as { turnId: string; session: VerseSession };
    expect(turn.turnId).toBe('t2');
    expect(turn.session.status).toBe('running');
    expect(turn.session.turnCount).toBe(1);

    const second = await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: 'again' }));
    expect(second.status).toBe(409);
    expect((second.json as { code: string }).code).toBe('VERSE_SESSION_BUSY');

    const empty = await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: '   ' }));
    expect(empty.status).toBe(400);

    const huge = await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: 'x'.repeat(70_000) }));
    expect(huge.status).toBe(413);
    expect((huge.json as { code: string }).code).toBe('VERSE_TOO_LARGE');

    const missing = await request(port, 'POST', '/api/verse/sessions/nope/turns', mutate, JSON.stringify({ text: 'hi' }));
    expect(missing.status).toBe(404);
    expect((missing.json as { code: string }).code).toBe('VERSE_SESSION_NOT_FOUND');

    const badId = await request(port, 'POST', '/api/verse/sessions/..%2Fetc/turns', mutate, JSON.stringify({ text: 'hi' }));
    expect(badId.status).toBe(400);
  });

  it('detail, rename, cancel, delete', async () => {
    const { port, read, mutate } = await boot();
    const session = await createSession(port, mutate);
    await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: 'hello' }));
    engine.emit(session.id, { type: 'text-delta', turnId: 't2', text: 'Hi ' });

    const detail = await request(port, 'GET', `/api/verse/sessions/${session.id}`, read);
    expect(detail.status).toBe(200);
    const d = detail.json as { session: VerseSession; events: VerseEvent[] };
    expect(d.session.id).toBe(session.id);
    expect(d.events.map((e) => [e.seq, e.type])).toEqual([[1, 'user-message'], [2, 'turn-started'], [3, 'text-delta']]);

    const unknown = await request(port, 'GET', '/api/verse/sessions/nope', read);
    expect(unknown.status).toBe(404);
    expect((unknown.json as { code: string }).code).toBe('VERSE_SESSION_NOT_FOUND');

    const renamed = await request(port, 'POST', `/api/verse/sessions/${session.id}/rename`, mutate, JSON.stringify({ title: '  Renamed  ' }));
    expect(renamed.status).toBe(200);
    expect((renamed.json as VerseSession).title).toBe('Renamed');
    const badRename = await request(port, 'POST', `/api/verse/sessions/${session.id}/rename`, mutate, JSON.stringify({ title: '' }));
    expect(badRename.status).toBe(400);

    const cancel = await request(port, 'POST', `/api/verse/sessions/${session.id}/cancel`, mutate, '{}');
    expect(cancel.status).toBe(200);
    expect(cancel.json).toEqual({ ok: true, cancelled: true });
    expect(engine.getSession(session.id)?.status).toBe('idle');
    const cancelIdle = await request(port, 'POST', `/api/verse/sessions/${session.id}/cancel`, mutate, '{}');
    expect(cancelIdle.json).toEqual({ ok: true, cancelled: false });

    const del = await request(port, 'POST', `/api/verse/sessions/${session.id}/delete`, mutate, '{}');
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ ok: true });
    expect(engine.sessions.size).toBe(0);
    const delAgain = await request(port, 'POST', `/api/verse/sessions/${session.id}/delete`, mutate, '{}');
    expect(delAgain.status).toBe(404);

    const unknownAction = await request(port, 'POST', `/api/verse/sessions/${session.id}/explode`, mutate, '{}');
    expect(unknownAction.status).toBe(404);
  });
});

describe('GET /api/verse/sessions/:id/events (SSE)', () => {
  it('requires the read session; 404 for an unknown session; 400 for a malformed id', async () => {
    const { port, handle, read } = await boot();
    const auth = await readSseAuth(handle);

    const noSession = await collectSse(port, '/api/verse/sessions/s1/events', read, () => true);
    expect(noSession.status).toBe(401); // raw read token is not a browser session

    const unknown = await collectSse(port, `/api/verse/sessions/s9/events${auth.query}`, auth.headers, () => true);
    expect(unknown.status).toBe(404);

    const malformed = await collectSse(port, `/api/verse/sessions/a%2Fb/events${auth.query}`, auth.headers, () => true);
    expect(malformed.status).toBe(400);
  });

  it('replays history as typed frames with id=seq, resumes after Last-Event-ID, and delivers live events', async () => {
    const { port, handle, mutate } = await boot();
    const auth = await readSseAuth(handle);
    const session = await createSession(port, mutate);
    await request(port, 'POST', `/api/verse/sessions/${session.id}/turns`, mutate, JSON.stringify({ text: 'hello world' }));
    engine.emit(session.id, { type: 'text-delta', turnId: 't2', text: 'Hi ' });

    // Fresh connection: full replay (seq 1..3), then a live event pushed after open.
    const full = await collectSse(
      port,
      `/api/verse/sessions/${session.id}/events${auth.query}`,
      auth.headers,
      (frames) => frames.some((f) => f.event === 'assistant-message'),
      () => {
        setTimeout(() => engine.emit(session.id, { type: 'assistant-message', turnId: 't2', text: 'Hi there' }), 20);
      },
    );
    expect(full.status).toBe(200);
    expect(full.frames.map((f) => [f.id, f.event])).toEqual([
      ['1', 'user-message'],
      ['2', 'turn-started'],
      ['3', 'text-delta'],
      ['4', 'assistant-message'],
    ]);
    const userMsg = full.frames[0]?.data as VerseEvent;
    expect(userMsg).toMatchObject({ seq: 1, type: 'user-message', turnId: 't2', text: 'hello world' });
    expect(typeof userMsg.at).toBe('string');

    // Reconnect with Last-Event-ID: only events after it, no duplicates.
    const resumed = await collectSse(
      port,
      `/api/verse/sessions/${session.id}/events${auth.query}`,
      { ...auth.headers, 'Last-Event-ID': '2' },
      (frames) => frames.some((f) => f.event === 'turn-done'),
      () => {
        setTimeout(() => {
          engine.getSession(session.id)!.status = 'idle';
          engine.emit(session.id, { type: 'turn-done', turnId: 't2', ok: true, nativeSessionId: null, durationMs: 5 });
        }, 20);
      },
    );
    expect(resumed.frames.map((f) => [f.id, f.event])).toEqual([
      ['3', 'text-delta'],
      ['4', 'assistant-message'],
      ['5', 'turn-done'],
    ]);

    // Listeners are released on disconnect.
    await new Promise((r) => setTimeout(r, 30));
    expect(engine.listeners.get(session.id)?.size ?? 0).toBe(0);
  });

  it('scrubs secret-shaped strings from event payloads', async () => {
    const { port, handle, mutate } = await boot();
    const auth = await readSseAuth(handle);
    const session = await createSession(port, mutate);
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    engine.emit(session.id, { type: 'error', turnId: null, message: `leaked ${secret}` });
    const out = await collectSse(
      port,
      `/api/verse/sessions/${session.id}/events${auth.query}`,
      auth.headers,
      (frames) => frames.length >= 1,
    );
    expect(out.frames[0]?.event).toBe('error');
    expect(JSON.stringify(out.frames[0]?.data)).not.toContain(secret);
    expect(JSON.stringify(out.frames[0]?.data)).toContain('[REDACTED]');
  });
});

describe('/api/events verse-sessions push', () => {
  it('emits a verse-sessions frame once a session exists and again when the list changes', async () => {
    const { port, handle, mutate } = await boot();
    const auth = await readSseAuth(handle);
    const session = await createSession(port, mutate);

    const out = await collectSse(
      port,
      `/api/events${auth.query}`,
      auth.headers,
      (frames) => frames.filter((f) => f.event === 'verse-sessions').length >= 2,
      () => {
        setTimeout(() => {
          void request(port, 'POST', `/api/verse/sessions/${session.id}/rename`, mutate, JSON.stringify({ title: 'Changed' }));
        }, 100);
      },
      8000,
    );
    const verseFrames = out.frames.filter((f) => f.event === 'verse-sessions');
    expect(verseFrames.length).toBeGreaterThanOrEqual(2);
    const first = verseFrames[0]?.data as { sessions: VerseSession[] };
    expect(first.sessions.map((s) => s.id)).toEqual([session.id]);
    const last = verseFrames[verseFrames.length - 1]?.data as { sessions: VerseSession[] };
    expect(last.sessions[0]?.title).toBe('Changed');
  });
});

describe('server shutdown', () => {
  it('closes the verse engine so a running turn is settled and nothing is left `running`', async () => {
    const { handle, port, mutate } = await boot();
    const created = await createSession(port, mutate);
    const turn = await request(port, 'POST', `/api/verse/sessions/${created.id}/turns`, mutate, JSON.stringify({ text: 'go' }));
    expect(turn.status).toBe(202);
    expect(engine.getSession(created.id)!.status).toBe('running');

    handles = handles.filter((h) => h !== handle);
    await handle.close();

    expect(engine.closed).toBe(true);
    expect(engine.getSession(created.id)!.status).toBe('idle');
    const types = engine.getEvents(created.id).map((e) => e.type);
    expect(types.slice(-2)).toEqual(['cancelled', 'turn-done']);
  });
});

describe('engine reset hook', () => {
  it('closes the previous engine when a new one is installed', () => {
    const next = new FakeEngine();
    resetVerseEngine(next);
    expect(engine.closed).toBe(true);
    expect(next.closed).toBe(false);
    resetVerseEngine(null);
    expect(next.closed).toBe(true);
  });
});
