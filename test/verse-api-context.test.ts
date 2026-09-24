/**
 * Tests for the V3.9 context-orchestration surface of /api/verse/*
 * (src/core/verse/verse-api.ts):
 *
 *   POST /api/verse/sessions               contextMode, handoffFromSessionId,
 *                                          preference default, memory snapshot
 *   POST /api/verse/sessions/:id/context-mode
 *   POST /api/verse/sessions/:id/handoff-preview
 *   GET|POST /api/verse/preferences
 *   GET  /api/verse/context-fit
 *   GET  /api/verse/search
 *   GET|POST /api/verse/memory
 *
 * Runs the REAL server (test/helpers/authenticated-web-server.ts) under a
 * relocated HOME with a fake VerseEngineHandle — no vendor CLI is spawned and
 * nothing here can spend. The V3.9 SERVICE modules (preferences, project
 * memory, handoff, fit, search) are the real ones, so every assertion about a
 * file on disk is about a real file under the temporary HOME.
 *
 * Also: the turn-time refusal of a model that became unrunnable
 * (VERSE_MODEL_UNAVAILABLE), the /memory route's own body cap, the
 * `contentSanitized` flag + VERSE_MEMORY_REDACTED refusal, and readBody's
 * chunk-safe decoding.
 *
 * Seat discovery is the one thing replaced: `discoverSeats` returns a fixed
 * roster, because the behaviours under test depend on per-model budgets
 * (a 1M model with an expansive mode, a 200k one without, a model listed with
 * an `unavailableReason`) and on a Grok seat, none of which a hermetic
 * machine can be made to discover.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerOptions } from '../src/core/types.js';
import type {
  VerseContextFit,
  VerseContextMode,
  VerseCreateSessionRequest,
  VerseEvent,
  VerseHandoffPreview,
  VerseModelOption,
  VersePreferences,
  VerseProjectMemory,
  VerseSearchResponse,
  VerseSeat,
  VerseSession,
  VerseUsage,
} from '../src/core/verse/types.js';
import type { VerseParsedEvent } from '../src/core/verse/adapters/index.js';
import type { VerseCreateOptions, VerseEngineHandle, VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseSeatDiscovery } from '../src/core/verse/seats.js';
import { budgetFor, claudeAutoCompactAt, grokAutoCompactAt } from '../src/core/verse/context-math.js';
import { clearContextFitCache } from '../src/core/verse/context-fit.js';
import {
  invalidateVerseSeatCache,
  resetVerseEngine,
  resetVerseWorkspaceStore,
  VERSE_MEMORY_BODY_MAX_BYTES,
} from '../src/core/verse/verse-api.js';
import { VERSE_MEMORY_MAX_BYTES } from '../src/core/verse/types.js';
import { DEFAULT_MAX_BODY_BYTES, readBody } from '../src/core/web/api.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

// ---------------------------------------------------------------------------
// Seat roster (replaces discovery; everything else in seats.ts is real)
// ---------------------------------------------------------------------------

const seatState = vi.hoisted(() => ({ discovery: null as unknown }));

vi.mock('../src/core/verse/seats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/verse/seats.js')>();
  return {
    ...actual,
    // An Error in the slot makes discovery FAIL (the turn-time model check
    // must then stay out of the way).
    discoverSeats: async () => {
      if (seatState.discovery instanceof Error) throw seatState.discovery;
      return seatState.discovery;
    },
  };
});

const LAUNCHER = ['/opt/private/launchers/claude-test-profile', '--profile', 'test'];
const GROK_LAUNCHER = ['/opt/private/launchers/grok-test-profile'];

/** A 1M Claude model: standard compacts near 367k, expansive near 967k. */
const BIG: VerseModelOption = {
  id: 'claude-big',
  label: 'Big',
  contextWindow: 1_000_000,
  autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, 400_000),
  expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, null) },
  maxOutputTokens: 128_000,
  windowSource: 'cli-catalog',
  minCliVersion: null,
};
/** A 200k Claude model: no expansive mode exists for it. */
const SMALL: VerseModelOption = {
  id: 'claude-small',
  label: 'Small',
  contextWindow: 200_000,
  autoCompactAt: claudeAutoCompactAt(200_000, 64_000),
  maxOutputTokens: 64_000,
  windowSource: 'cli-catalog',
  minCliVersion: null,
};
/** Listed, not runnable: the seat's pinned CLI predates it. */
const PINNED_OUT: VerseModelOption = {
  id: 'claude-opus-5-5',
  label: 'Opus 5.5',
  contextWindow: 1_000_000,
  autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, 400_000),
  expansive: { contextWindow: 1_000_000, autoCompactAt: claudeAutoCompactAt(1_000_000, 128_000, null) },
  windowSource: 'cli-catalog',
  minCliVersion: '2.1.280',
  unavailableReason: 'needs Claude Code 2.1.280; this seat runs 2.1.257',
};
/** A local tag as discovery lists it (window re-read from Ollama on every discovery). */
const LOCAL_64K: VerseModelOption = {
  id: 'qwen3.8:27b-ctx64k',
  label: 'Qwen3.8 27b-ctx64k',
  contextWindow: 65_536,
  autoCompactAt: claudeAutoCompactAt(65_536, null, null),
  windowSource: 'provider-catalog',
};
const GROK_MODEL: VerseModelOption = {
  id: 'grok-4.7',
  label: 'Grok 4.7',
  contextWindow: 500_000,
  autoCompactAt: grokAutoCompactAt(500_000, 80),
  windowSource: 'provider-catalog',
};

function seat(id: string, engine: VerseSeat['engine'], models: VerseModelOption[]): VerseSeat {
  return {
    id,
    engine,
    label: id,
    accountId: id,
    models,
    contextWindow: models[0]?.contextWindow ?? null,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
  };
}

function buildDiscovery(): VerseSeatDiscovery {
  const claude = seat('claude-test', 'claude', [BIG, SMALL, PINNED_OUT]);
  const grok = seat('grok-test', 'grok', [GROK_MODEL]);
  const local = seat(`local:${LOCAL_64K.id}`, 'local', [LOCAL_64K]);
  const launches = new Map<string, VerseSeatLaunch>([
    [claude.id, { seat: claude, launcher: LAUNCHER, ollamaBaseUrl: 'http://127.0.0.1:1' }],
    [grok.id, { seat: grok, launcher: GROK_LAUNCHER, ollamaBaseUrl: 'http://127.0.0.1:1' }],
    [local.id, { seat: local, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:1' }],
  ]);
  return {
    seats: [claude, grok, local],
    launches,
    localRuntime: { ollama: { reachable: false, baseUrl: 'http://127.0.0.1:1', models: [] } },
  };
}

// ---------------------------------------------------------------------------
// Fake engine (contract-shaped; mirrors the real engine's refusals)
// ---------------------------------------------------------------------------

class FakeVerseError extends Error {
  constructor(
    public readonly code: 'VERSE_SESSION_NOT_FOUND' | 'VERSE_SESSION_BUSY' | 'VERSE_INVALID' | 'VERSE_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}

/** An event before seq/at are stamped — the adapters' distributive Omit, so each variant keeps its own fields. */
type Draft = VerseParsedEvent;

function zeroUsage(): VerseUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null };
}

class FakeEngine implements VerseEngineHandle {
  readonly sessions = new Map<string, VerseSession>();
  readonly events = new Map<string, VerseEvent[]>();
  readonly sessionLaunches = new Map<string, VerseSeatLaunch>();
  readonly createRequests: VerseCreateSessionRequest[] = [];
  readonly createOptions: Array<VerseCreateOptions | undefined> = [];
  readonly modeCalls: Array<{ id: string; mode: VerseContextMode }> = [];
  readonly refreshCalls: Array<{ id: string; option: VerseModelOption }> = [];
  /** `refresh:<id>` / `turn:<id>`, in call order — the refresh must precede the launch. */
  readonly callOrder: string[] = [];
  private counter = 0;
  /** Monotonic clock so `updatedAt` orders sessions deterministically. */
  private tick = Date.parse('2026-09-20T12:00:00.000Z');

  private stamp(): string {
    this.tick += 1_000;
    return new Date(this.tick).toISOString();
  }

  listSessions(): VerseSession[] { return [...this.sessions.values()]; }
  getSession(id: string): VerseSession | null { return this.sessions.get(id) ?? null; }
  getEvents(id: string, fromSeq = 0): VerseEvent[] {
    return (this.events.get(id) ?? []).filter((e) => e.seq > fromSeq);
  }
  createSession(req: VerseCreateSessionRequest, launch: VerseSeatLaunch, opts?: VerseCreateOptions): VerseSession {
    this.createRequests.push(req);
    this.createOptions.push(opts);
    // The real engine's default: the first RUNNABLE model.
    const model = req.model ?? launch.seat.models.find((m) => !m.unavailableReason)?.id ?? 'unknown';
    if (!launch.seat.models.some((m) => m.id === model)) {
      throw new FakeVerseError('VERSE_INVALID', `model ${model} is not available on seat ${launch.seat.id}`);
    }
    const id = `s${++this.counter}`;
    const at = this.stamp();
    const session: VerseSession = {
      id,
      title: req.title ?? 'New chat',
      projectPath: req.projectPath,
      ...(req.extraRoots ? { extraRoots: req.extraRoots } : {}),
      engine: launch.seat.engine,
      accountId: launch.seat.accountId,
      seatId: launch.seat.id,
      model,
      nativeSessionId: null,
      createdAt: at,
      updatedAt: at,
      status: 'idle',
      turnCount: 0,
      usage: zeroUsage(),
      lastError: null,
      ...(req.contextMode ? { contextMode: req.contextMode } : {}),
      // Like the real engine: a snapshot pins memory on, an explicit `null`
      // records the API's decision that it is off, absent says nothing.
      ...(opts?.memory ? { memoryEnabled: true } : opts?.memory === null ? { memoryEnabled: false } : {}),
      ...(opts?.handoffFrom ? { handoffFrom: opts.handoffFrom } : {}),
    };
    this.sessions.set(id, session);
    this.events.set(id, []);
    this.sessionLaunches.set(id, launch);
    return session;
  }
  setContextMode(id: string, mode: VerseContextMode): VerseSession {
    this.modeCalls.push({ id, mode });
    const session = this.must(id);
    if (session.status === 'running') throw new FakeVerseError('VERSE_SESSION_BUSY', 'a turn is running');
    const option = this.sessionLaunches.get(id)?.seat.models.find((m) => m.id === session.model) ?? null;
    if (budgetFor(option, mode) === null) {
      throw new FakeVerseError('VERSE_INVALID', `model ${session.model} has no ${mode} budget`);
    }
    session.contextMode = mode;
    session.updatedAt = this.stamp();
    return session;
  }
  refreshLocalWindow(id: string, option: VerseModelOption): VerseSession {
    this.refreshCalls.push({ id, option });
    this.callOrder.push(`refresh:${id}`);
    const session = this.must(id);
    if (session.engine !== 'local') return session;
    if (session.status === 'running') throw new FakeVerseError('VERSE_SESSION_BUSY', 'turn already running');
    session.usage.contextWindow = option.contextWindow;
    session.usage.autoCompactAt = option.autoCompactAt;
    session.usage.contextWindowSource = option.windowSource ?? 'fallback';
    return session;
  }
  sendTurn(id: string, text: string): { turnId: string; session: VerseSession } {
    this.callOrder.push(`turn:${id}`);
    const session = this.must(id);
    if (session.status === 'running') throw new FakeVerseError('VERSE_SESSION_BUSY', 'turn already running');
    const turnId = `t${++this.counter}`;
    session.status = 'running';
    session.turnCount += 1;
    this.emit(id, { type: 'user-message', turnId, text });
    return { turnId, session };
  }
  cancelTurn(id: string): boolean { this.must(id); return false; }
  deleteSession(id: string): void { this.must(id); this.sessions.delete(id); }
  renameSession(id: string, title: string): VerseSession {
    const session = this.must(id);
    session.title = title;
    return session;
  }
  subscribe(id: string): () => void { this.must(id); return () => {}; }
  close(): void { /* nothing running */ }

  /** Test-only: append an event and bump the session's recency. */
  emit(id: string, draft: Draft): VerseEvent {
    const list = this.events.get(id) ?? [];
    const at = this.stamp();
    const event = { ...draft, seq: list.length + 1, at } as VerseEvent;
    list.push(event);
    this.events.set(id, list);
    const session = this.sessions.get(id);
    if (session) session.updatedAt = at;
    return event;
  }
  private must(id: string): VerseSession {
    const s = this.sessions.get(id);
    if (!s) throw new FakeVerseError('VERSE_SESSION_NOT_FOUND', `session not found: ${id}`);
    return s;
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeConfig(): AshlrConfig {
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
  } as unknown as AshlrConfig;
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
        // Bytes first, decoded once: per-chunk decoding would split a
        // multi-byte character and fail the round-trip tests on the CLIENT.
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { chunks.push(c); });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
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

let tmpHome: string;
let tmpRepoRoot: string;
let repo: string;
let other: string;
let prevHome: string | undefined;
let engine: FakeEngine;
let handles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-ctx-home-'));
  tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-ctx-repos-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  fs.mkdirSync(path.join(tmpHome, '.ashlr'), { recursive: true });
  repo = fs.mkdtempSync(path.join(tmpRepoRoot, 'repo-'));
  other = fs.mkdtempSync(path.join(tmpRepoRoot, 'other-'));

  seatState.discovery = buildDiscovery();
  engine = new FakeEngine();
  resetVerseEngine(engine);
  resetVerseWorkspaceStore(null);
  invalidateVerseSeatCache();
  clearContextFitCache();
  handles = [];
});

afterEach(async () => {
  for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
  handles = [];
  resetVerseEngine(null);
  resetVerseWorkspaceStore(null);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
});

async function boot(opts: Partial<WebServerOptions> = {}) {
  const handle = await startServer(makeConfig(), { port: 0, open: false, allowDispatch: true, ...opts });
  handles.push(handle);
  const read = readAuthHeaders(handle.port);
  const mutate = { 'x-ashlr-token': handle.token, 'content-type': 'application/json' };
  return { handle, port: handle.port, read, mutate };
}

type Mutate = Record<string, string>;

async function post(port: number, mutate: Mutate, urlPath: string, body: unknown): Promise<HttpResult> {
  return request(port, 'POST', urlPath, mutate, JSON.stringify(body));
}

async function create(port: number, mutate: Mutate, extra: Record<string, unknown> = {}): Promise<VerseSession> {
  const res = await post(port, mutate, '/api/verse/sessions', { projectPath: repo, seatId: 'claude-test', ...extra });
  expect(res.status, res.body).toBe(201);
  return res.json as VerseSession;
}

function memoryRoot(): string {
  return path.join(tmpHome, '.ashlr', 'verse', 'memory');
}

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

function errorOf(res: HttpResult): string {
  return (res.json as { error?: string } | null)?.error ?? '';
}

// ---------------------------------------------------------------------------
// POST /api/verse/sessions — V3.9 resolution
// ---------------------------------------------------------------------------

describe('POST /api/verse/sessions — context mode', () => {
  it('forwards an explicit mode the model has a budget for', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big', contextMode: 'expansive' });
    expect(engine.createRequests[0]?.contextMode).toBe('expansive');
    expect(session.contextMode).toBe('expansive');

    await create(port, mutate, { model: 'claude-small', contextMode: 'standard' });
    expect(engine.createRequests[1]?.contextMode).toBe('standard');
  });

  it('refuses an explicit mode the model has no budget for — before memory is prepared', async () => {
    const { port, mutate } = await boot();
    const res = await post(port, mutate, '/api/verse/sessions', {
      projectPath: repo, seatId: 'claude-test', model: 'claude-small', contextMode: 'expansive',
    });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      code: 'VERSE_INVALID',
      error: 'model claude-small has no expansive context mode on seat claude-test',
    });
    expect(engine.createRequests).toHaveLength(0);
    // A refused request leaves nothing behind.
    expect(fs.existsSync(memoryRoot())).toBe(false);
  });

  it('defaults to the seat preference, and quietly yields to standard where the model has no such mode', async () => {
    const { port, mutate } = await boot();
    const pref = await post(port, mutate, '/api/verse/preferences', { seatId: 'claude-test', contextMode: 'expansive' });
    expect(pref.status).toBe(200);

    await create(port, mutate, { model: 'claude-big' });
    expect(engine.createRequests[0]?.contextMode).toBe('expansive');

    // A default is not a demand: a 200k model simply runs standard — and says so.
    await create(port, mutate, { model: 'claude-small' });
    expect(engine.createRequests[1]?.contextMode).toBe('standard');

    // An explicit choice beats the preference.
    await create(port, mutate, { model: 'claude-big', contextMode: 'standard' });
    expect(engine.createRequests[2]?.contextMode).toBe('standard');

    // Another seat's preference does not leak.
    const grok = await post(port, mutate, '/api/verse/sessions', { projectPath: repo, seatId: 'grok-test' });
    expect(grok.status).toBe(201);
    expect(engine.createRequests[3]?.contextMode).toBe('standard');
  });

  it('with no preference, a new session records `standard` explicitly (absent is reserved for pre-3.9 records)', async () => {
    // An absent contextMode is how the engine recognises a legacy Claude
    // session that ran at the CLI's native window; a 3.9 session must never
    // look like one.
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    expect(engine.createRequests[0]?.contextMode).toBe('standard');
    expect(session.contextMode).toBe('standard');
  });
});

describe('POST /api/verse/sessions — model availability', () => {
  it('defaults to the first RUNNABLE model, resolving the preferred mode against it', async () => {
    // A roster whose first entry is listed-but-unavailable (the engine never
    // picks it silently, and neither may the API's pre-checks).
    const discovery = buildDiscovery();
    const claude = discovery.seats[0]!;
    claude.models = [PINNED_OUT, BIG, SMALL];
    seatState.discovery = discovery;
    const { port, mutate } = await boot();
    expect((await post(port, mutate, '/api/verse/preferences', { seatId: 'claude-test', contextMode: 'expansive' })).status).toBe(200);
    const session = await create(port, mutate);
    expect(engine.createRequests[0]).not.toHaveProperty('model');
    expect(session.model).toBe('claude-big');
    expect(engine.createRequests[0]?.contextMode).toBe('expansive');
  });

  it('refuses a listed-but-unavailable model with its reason, and resolves the retired dotted alias to it', async () => {
    const { port, mutate } = await boot();
    const direct = await post(port, mutate, '/api/verse/sessions', {
      projectPath: repo, seatId: 'claude-test', model: 'claude-opus-5-5',
    });
    expect(direct.status).toBe(400);
    expect(errorOf(direct)).toBe(
      'model claude-opus-5-5 cannot run on seat claude-test: needs Claude Code 2.1.280; this seat runs 2.1.257',
    );

    // `claude-opus-5.5` is what older clients remembered; it means the same model.
    const alias = await post(port, mutate, '/api/verse/sessions', {
      projectPath: repo, seatId: 'claude-test', model: 'claude-opus-5.5',
    });
    expect(alias.status).toBe(400);
    expect(errorOf(alias)).toContain('model claude-opus-5-5 cannot run on seat claude-test');

    const unknown = await post(port, mutate, '/api/verse/sessions', {
      projectPath: repo, seatId: 'claude-test', model: 'claude-nope',
    });
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toBe('model claude-nope is not available on seat claude-test');

    expect(engine.createRequests).toHaveLength(0);
    expect(fs.existsSync(memoryRoot())).toBe(false);
  });
});

describe('POST /api/verse/sessions/:id/turns — model availability at turn time', () => {
  function turnUrl(id: string): string {
    return `/api/verse/sessions/${id}/turns`;
  }

  /** Re-point discovery and drop the 3s seat cache so the next request sees it. */
  function rediscover(mutateSeat: (d: VerseSeatDiscovery) => void): void {
    const discovery = buildDiscovery();
    mutateSeat(discovery);
    seatState.discovery = discovery;
    invalidateVerseSeatCache();
  }

  it('refuses (409) a session whose model became unrunnable after it was created, without reaching the engine', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    // The seat was re-pinned under the chat: claude-big is still LISTED, now with a reason.
    rediscover((d) => {
      d.seats[0]!.models = [{ ...BIG, unavailableReason: 'needs Claude Code 2.1.300; this seat runs 2.1.257' }, SMALL];
    });
    const res = await post(port, mutate, turnUrl(session.id), { text: 'hi' });
    expect(res.status, res.body).toBe(409);
    expect(res.json).toEqual({
      code: 'VERSE_MODEL_UNAVAILABLE',
      error: 'model claude-big cannot run on seat claude-test: needs Claude Code 2.1.300; this seat runs 2.1.257',
    });
    expect(engine.getSession(session.id)?.turnCount).toBe(0);
    expect(engine.getEvents(session.id)).toHaveLength(0);
  });

  it('resolves an old session stored under the retired dotted alias to the canonical option', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    // What a pre-3.9 record looks like: `claude-opus-5.5`, on a seat pinned to 2.1.257.
    engine.sessions.get(session.id)!.model = 'claude-opus-5.5';
    const res = await post(port, mutate, turnUrl(session.id), { text: 'hi' });
    expect(res.status, res.body).toBe(409);
    expect((res.json as { code?: string }).code).toBe('VERSE_MODEL_UNAVAILABLE');
    expect(errorOf(res)).toBe(
      'model claude-opus-5-5 cannot run on seat claude-test: needs Claude Code 2.1.280; this seat runs 2.1.257',
    );
    expect(engine.getEvents(session.id)).toHaveLength(0);
  });

  it('never blocks when discovery fails, the seat is gone, or the model is not listed', async () => {
    const { port, mutate } = await boot();
    const a = await create(port, mutate, { model: 'claude-big' });
    const b = await create(port, mutate, { model: 'claude-big' });
    const c = await create(port, mutate, { model: 'claude-big' });

    seatState.discovery = new Error('ollama exploded');
    invalidateVerseSeatCache();
    const failed = await post(port, mutate, turnUrl(a.id), { text: 'hi' });
    expect(failed.status, failed.body).toBe(202);

    rediscover((d) => {
      d.seats = d.seats.filter((x) => x.id !== 'claude-test');
      (d.launches as Map<string, VerseSeatLaunch>).delete('claude-test');
    });
    const gone = await post(port, mutate, turnUrl(b.id), { text: 'hi' });
    expect(gone.status, gone.body).toBe(202);

    rediscover((d) => { d.seats[0]!.models = [SMALL]; });
    const unlisted = await post(port, mutate, turnUrl(c.id), { text: 'hi' });
    expect(unlisted.status, unlisted.body).toBe(202);

    expect([a, b, c].map((x) => engine.getSession(x.id)?.turnCount)).toEqual([1, 1, 1]);
  });

  it('a local session\'s stored window is refreshed from the live option BEFORE the turn launches', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { seatId: `local:${LOCAL_64K.id}` });
    // A stale record (the pre-3.9 262,144 for a -ctx64k tag).
    engine.sessions.get(session.id)!.usage.contextWindow = 262_144;
    const res = await post(port, mutate, turnUrl(session.id), { text: 'hi' });
    expect(res.status, res.body).toBe(202);
    expect(engine.refreshCalls).toEqual([{ id: session.id, option: LOCAL_64K }]);
    expect(engine.callOrder).toEqual([`refresh:${session.id}`, `turn:${session.id}`]);
    expect(engine.getSession(session.id)?.usage.contextWindow).toBe(65_536);
  });

  it('refreshes only local sessions, and only with a live option', async () => {
    const { port, mutate } = await boot();
    const claude = await create(port, mutate, { model: 'claude-big' });
    expect((await post(port, mutate, turnUrl(claude.id), { text: 'hi' })).status).toBe(202);
    expect(engine.refreshCalls).toEqual([]);

    // Ollama down / tag gone: the stored window stands and the turn still starts.
    const local = await create(port, mutate, { seatId: `local:${LOCAL_64K.id}` });
    engine.sessions.get(local.id)!.usage.contextWindow = 65_536;
    seatState.discovery = new Error('ollama exploded');
    invalidateVerseSeatCache();
    expect((await post(port, mutate, turnUrl(local.id), { text: 'hi' })).status).toBe(202);
    expect(engine.refreshCalls).toEqual([]);
    expect(engine.getSession(local.id)?.usage.contextWindow).toBe(65_536);
  });

  it('a local seat whose live window is too small answers 409 VERSE_MODEL_UNAVAILABLE without refreshing', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { seatId: `local:${LOCAL_64K.id}` });
    const reason = 'Context window 32,768 is too small for Claude Code';
    rediscover((d) => {
      d.seats[2]!.models = [{ ...LOCAL_64K, contextWindow: 32_768, autoCompactAt: null, unavailableReason: reason }];
    });
    const res = await post(port, mutate, turnUrl(session.id), { text: 'hi' });
    expect(res.status, res.body).toBe(409);
    expect(res.json).toEqual({
      code: 'VERSE_MODEL_UNAVAILABLE',
      error: `model ${LOCAL_64K.id} cannot run on seat local:${LOCAL_64K.id}: ${reason}`,
    });
    expect(engine.callOrder).toEqual([]);
  });

  it('the model-unavailable 409 carries a code distinct from a busy session\'s', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    expect((await post(port, mutate, turnUrl(session.id), { text: 'one' })).status).toBe(202);
    const busy = await post(port, mutate, turnUrl(session.id), { text: 'two' });
    expect(busy.status).toBe(409);
    expect((busy.json as { code?: string }).code).toBe('VERSE_SESSION_BUSY');

    engine.sessions.get(session.id)!.status = 'idle';
    engine.sessions.get(session.id)!.model = 'claude-opus-5-5';
    const unavailable = await post(port, mutate, turnUrl(session.id), { text: 'three' });
    expect(unavailable.status).toBe(409);
    expect((unavailable.json as { code?: string }).code).toBe('VERSE_MODEL_UNAVAILABLE');
  });

  it('refuses turn text containing NUL (it rides on argv) before anything is recorded', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    const res = await post(port, mutate, turnUrl(session.id), { text: 'fact one\u0000fact two' });
    expect(res.status, res.body).toBe(400);
    expect((res.json as { code?: string }).code).toBe('VERSE_INVALID');
    expect(errorOf(res)).toBe('text must not contain NUL bytes');
    expect(engine.callOrder).toEqual([]);
    expect(engine.getEvents(session.id)).toHaveLength(0);
  });

  it('a runnable model starts the turn; an unknown session is still the engine\'s 404', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    expect((await post(port, mutate, turnUrl(session.id), { text: 'hi' })).status).toBe(202);
    const missing = await post(port, mutate, turnUrl('s999'), { text: 'hi' });
    expect(missing.status).toBe(404);
    expect((missing.json as { code?: string }).code).toBe('VERSE_SESSION_NOT_FOUND');
  });
});

describe('POST /api/verse/sessions — shared project memory', () => {
  it('snapshots a private, writable memory for a Claude seat; read-only for Grok', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    const memory = engine.createOptions[0]?.memory;
    expect(memory).toBeTruthy();
    expect(memory?.writable).toBe(true);
    expect(path.dirname(memory!.dir)).toBe(memoryRoot());
    expect(path.basename(memory!.dir)).toMatch(new RegExp(`^${path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-')}.*-[0-9a-f]{12}$`));
    expect(mode(memory!.dir)).toBe(0o700);
    expect(Buffer.byteLength(memory!.block, 'utf8')).toBeLessThanOrEqual(6 * 1024);
    expect(memory!.block).toContain(memory!.dir);
    expect(session.memoryEnabled).toBe(true);

    const grok = await post(port, mutate, '/api/verse/sessions', { projectPath: repo, seatId: 'grok-test' });
    expect(grok.status).toBe(201);
    const grokMemory = engine.createOptions[1]?.memory;
    expect(grokMemory?.writable).toBe(false);
    // Same project → same directory, whichever engine asks.
    expect(grokMemory?.dir).toBe(memory?.dir);

    // Neither the directory nor the prompt block is ever part of a response.
    expect(JSON.stringify(session)).not.toContain('.ashlr/verse/memory');
    expect(grok.body).not.toContain('.ashlr/verse/memory');
  });

  it('offers no memory when it is off globally or for this project — and still offers it elsewhere', async () => {
    const { port, mutate } = await boot();
    const optOut = await post(port, mutate, '/api/verse/preferences', { projectPath: repo, memoryEnabled: false });
    expect(optOut.status).toBe(200);

    // `null`, not absent: the API DECIDED memory is off, and the record says so.
    const inRepo = await create(port, mutate);
    expect(engine.createOptions[0]?.memory).toBeNull();
    expect(inRepo.memoryEnabled).toBe(false);

    const elsewhere = await create(port, mutate, { projectPath: other });
    expect(engine.createOptions[1]?.memory?.writable).toBe(true);
    expect(elsewhere.memoryEnabled).toBe(true);

    const globalOff = await post(port, mutate, '/api/verse/preferences', { memoryEnabled: false });
    expect(globalOff.status).toBe(200);
    const off = await create(port, mutate, { projectPath: other });
    expect(engine.createOptions[2]?.memory).toBeNull();
    expect(off.memoryEnabled).toBe(false);
  });

  it('never blocks the chat when memory cannot be prepared — the record then says memory is off', async () => {
    const { port, mutate } = await boot();
    // A FILE where the memory directory belongs: mkdir under it must fail.
    fs.mkdirSync(path.join(tmpHome, '.ashlr', 'verse'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(memoryRoot(), 'not a directory');
    const session = await create(port, mutate);
    expect(engine.createOptions[0]?.memory).toBeNull();
    expect(session.memoryEnabled).toBe(false);
  });
});

describe('POST /api/verse/sessions — handoff provenance', () => {
  it('pins the source title read from the store, and never forwards the raw id to the engine', async () => {
    const { port, mutate } = await boot();
    const source = await create(port, mutate, { title: 'Migrate the billing tables' });
    const next = await create(port, mutate, { model: 'claude-big', handoffFromSessionId: source.id });
    expect(engine.createOptions[1]?.handoffFrom).toEqual({ sessionId: source.id, title: 'Migrate the billing tables' });
    expect(engine.createRequests[1]).not.toHaveProperty('handoffFromSessionId');
    expect(next.handoffFrom).toEqual({ sessionId: source.id, title: 'Migrate the billing tables' });
  });

  it('refuses a missing or malformed source (400) without creating anything', async () => {
    const { port, mutate } = await boot();
    const missing = await post(port, mutate, '/api/verse/sessions', {
      projectPath: repo, seatId: 'claude-test', handoffFromSessionId: 's404',
    });
    expect(missing.status).toBe(400);
    expect(errorOf(missing)).toBe('handoff source session not found: s404');

    for (const bad of ['../etc', '', 42, null]) {
      const res = await post(port, mutate, '/api/verse/sessions', {
        projectPath: repo, seatId: 'claude-test', handoffFromSessionId: bad,
      });
      expect(res.status).toBe(400);
      expect(errorOf(res)).toBe('handoffFromSessionId must be a session id');
    }
    expect(engine.createRequests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/verse/sessions/:id/context-mode
// ---------------------------------------------------------------------------

describe('POST /api/verse/sessions/:id/context-mode', () => {
  it('switches the mode and answers with the session', async () => {
    const { port, mutate } = await boot();
    const session = await create(port, mutate, { model: 'claude-big' });
    const up = await post(port, mutate, `/api/verse/sessions/${session.id}/context-mode`, { mode: 'expansive' });
    expect(up.status).toBe(200);
    expect((up.json as VerseSession).contextMode).toBe('expansive');
    const down = await post(port, mutate, `/api/verse/sessions/${session.id}/context-mode`, { mode: 'standard' });
    expect(down.status).toBe(200);
    expect((down.json as VerseSession).contextMode).toBe('standard');
    expect(engine.modeCalls).toEqual([{ id: session.id, mode: 'expansive' }, { id: session.id, mode: 'standard' }]);
  });

  it('validates the body strictly and maps the engine refusals (400 no budget, 409 running, 404 unknown)', async () => {
    const { port, mutate } = await boot();
    const small = await create(port, mutate, { model: 'claude-small' });
    const url = `/api/verse/sessions/${small.id}/context-mode`;

    expect((await post(port, mutate, url, { mode: 'huge' })).status).toBe(400);
    expect((await post(port, mutate, url, {})).status).toBe(400);
    const extra = await post(port, mutate, url, { mode: 'standard', force: true });
    expect(extra.status).toBe(400);
    expect(errorOf(extra)).toBe('unknown key: force');
    expect(engine.modeCalls).toHaveLength(0);

    const noBudget = await post(port, mutate, url, { mode: 'expansive' });
    expect(noBudget.status).toBe(400);
    expect((noBudget.json as { code: string }).code).toBe('VERSE_INVALID');

    const unknown = await post(port, mutate, '/api/verse/sessions/s404/context-mode', { mode: 'standard' });
    expect(unknown.status).toBe(404);
    expect((unknown.json as { code: string }).code).toBe('VERSE_SESSION_NOT_FOUND');

    const big = await create(port, mutate, { model: 'claude-big' });
    const turn = await post(port, mutate, `/api/verse/sessions/${big.id}/turns`, { text: 'go' });
    expect(turn.status).toBe(202);
    const busy = await post(port, mutate, `/api/verse/sessions/${big.id}/context-mode`, { mode: 'expansive' });
    expect(busy.status).toBe(409);
    expect((busy.json as { code: string }).code).toBe('VERSE_SESSION_BUSY');
  });

  it('sits behind the dispatch gate and the mutation token', async () => {
    const { port, read } = await boot({ allowDispatch: false });
    const off = await request(port, 'POST', '/api/verse/sessions/s1/context-mode', {
      ...read, 'content-type': 'application/json',
    }, JSON.stringify({ mode: 'expansive' }));
    expect(off.status).toBe(404);

    const on = await boot();
    const noToken = await request(on.port, 'POST', '/api/verse/sessions/s1/context-mode', {
      'content-type': 'application/json',
    }, JSON.stringify({ mode: 'expansive' }));
    expect(noToken.status).toBe(401);
    expect(engine.modeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/verse/sessions/:id/handoff-preview
// ---------------------------------------------------------------------------

describe('POST /api/verse/sessions/:id/handoff-preview', () => {
  const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';

  async function seeded(port: number, mutate: Mutate): Promise<VerseSession> {
    const session = await create(port, mutate, { title: 'Billing migration' });
    engine.emit(session.id, { type: 'user-message', turnId: 't1', text: 'Migrate the billing tables to the new schema.' });
    engine.emit(session.id, {
      type: 'tool-use', turnId: 't1', toolUseId: 'u1', name: 'Edit',
      input: { file_path: path.join(repo, 'src/billing.ts'), old_string: 'a', new_string: 'b' },
    });
    engine.emit(session.id, { type: 'assistant-message', turnId: 't1', text: 'Moved the invoices table; payments remain.' });
    engine.emit(session.id, { type: 'user-message', turnId: 't2', text: `Now do payments. My key is ${SECRET}` });
    engine.emit(session.id, {
      type: 'assistant-message', turnId: 't2',
      text: 'SUMMARY: invoices and payments migrated; the backfill script is the last open item.',
    });
    return session;
  }

  it('builds a deterministic, scrubbed note from the event log (zero spend)', async () => {
    const { port, mutate } = await boot();
    const session = await seeded(port, mutate);
    const url = `/api/verse/sessions/${session.id}/handoff-preview`;

    const first = await post(port, mutate, url, {});
    expect(first.status).toBe(200);
    const preview = first.json as VerseHandoffPreview;
    expect(preview.sourceSessionId).toBe(session.id);
    expect(preview.sourceTitle).toBe('Billing migration');
    expect(preview.text).toContain('Migrate the billing tables to the new schema.');
    expect(preview.text).toContain('src/billing.ts');
    expect(preview.text).not.toContain(SECRET);
    expect(preview.stats.turnsCovered).toBe(2);
    expect(preview.stats.filesTouched).toBe(1);
    expect(preview.stats.chars).toBe(preview.text.length);
    expect(preview.stats.estTokens).toBe(Math.ceil(preview.text.length / 4));
    expect(preview.stats.truncated).toEqual([]);

    // Deterministic: the same log yields byte-identical text.
    const again = await post(port, mutate, url, {});
    expect((again.json as VerseHandoffPreview).text).toBe(preview.text);
    // Building a preview sent no turn.
    expect(engine.getSession(session.id)?.turnCount).toBe(0);
  });

  it('carries the focus line and, on request, the last reply verbatim', async () => {
    const { port, mutate } = await boot();
    const session = await seeded(port, mutate);
    const url = `/api/verse/sessions/${session.id}/handoff-preview`;
    const res = await post(port, mutate, url, {
      includeLastAssistant: true,
      focus: '  Finish the backfill script and verify row counts.  ',
    });
    expect(res.status).toBe(200);
    const text = (res.json as VerseHandoffPreview).text;
    expect(text).toContain('Finish the backfill script and verify row counts.');
    expect(text).toContain('SUMMARY: invoices and payments migrated; the backfill script is the last open item.');
    expect(text).toContain('verbatim');

    const blankFocus = await post(port, mutate, url, { focus: '   ' });
    expect(blankFocus.status).toBe(200);
    expect((blankFocus.json as VerseHandoffPreview).text).not.toContain('Focus for this session');
  });

  it('validates the body strictly (400), 404s an unknown session, and is dispatch-gated', async () => {
    const { port, mutate } = await boot();
    const session = await seeded(port, mutate);
    const url = `/api/verse/sessions/${session.id}/handoff-preview`;
    expect(errorOf(await post(port, mutate, url, { summary: true }))).toBe('unknown key: summary');
    expect((await post(port, mutate, url, { includeLastAssistant: 'yes' })).status).toBe(400);
    expect((await post(port, mutate, url, { focus: 7 })).status).toBe(400);
    const long = await post(port, mutate, url, { focus: 'x'.repeat(501) });
    expect(long.status).toBe(400);
    expect((long.json as { code: string }).code).toBe('VERSE_INVALID');
    // 500 chars after trimming is the limit, not before.
    expect((await post(port, mutate, url, { focus: ` ${'x'.repeat(500)} ` })).status).toBe(200);

    const missing = await post(port, mutate, '/api/verse/sessions/s404/handoff-preview', {});
    expect(missing.status).toBe(404);

    const readOnly = await boot({ allowDispatch: false });
    const off = await request(readOnly.port, 'POST', url, readOnly.mutate, '{}');
    expect(off.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /api/verse/preferences
// ---------------------------------------------------------------------------

describe('/api/verse/preferences', () => {
  function prefsFile(): string {
    return path.join(tmpHome, '.ashlr', 'verse', 'preferences.json');
  }

  it('GET answers the defaults before anything is stored, behind the read boundary', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', '/api/verse/preferences', read);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ version: 1, seats: {}, memory: { enabled: true, disabledProjects: [] } });
    expect(fs.existsSync(prefsFile())).toBe(false);

    expect((await request(port, 'GET', '/api/verse/preferences')).status).toBe(401);
    expect((await request(port, 'GET', '/api/verse/preferences?x=1', read)).status).toBe(400);
  });

  it('POST applies exactly one form per request and persists 0600', async () => {
    const { port, read, mutate } = await boot();
    const seatPref = await post(port, mutate, '/api/verse/preferences', { seatId: 'claude-test', contextMode: 'expansive' });
    expect(seatPref.status).toBe(200);
    expect((seatPref.json as VersePreferences).seats).toEqual({ 'claude-test': { contextMode: 'expansive' } });
    expect(mode(prefsFile())).toBe(0o600);

    const project = await post(port, mutate, '/api/verse/preferences', { projectPath: repo, memoryEnabled: false });
    expect(project.status).toBe(200);
    expect((project.json as VersePreferences).memory.disabledProjects).toEqual([fs.realpathSync(repo)]);

    const global = await post(port, mutate, '/api/verse/preferences', { memoryEnabled: false });
    expect((global.json as VersePreferences).memory.enabled).toBe(false);

    const reset = await post(port, mutate, '/api/verse/preferences', { seatId: 'claude-test', contextMode: 'standard' });
    expect((reset.json as VersePreferences).seats).toEqual({});

    const got = await request(port, 'GET', '/api/verse/preferences', read);
    expect(got.json).toEqual({
      version: 1,
      seats: {},
      memory: { enabled: false, disabledProjects: [fs.realpathSync(repo)] },
    });
  });

  it('refuses a mode the seat cannot run, an unknown seat, mixed forms, unknown keys and guarded paths', async () => {
    const { port, mutate } = await boot();
    const cases: Array<[unknown, string]> = [
      [{ seatId: 'grok-test', contextMode: 'expansive' }, 'seat grok-test has no model with a expansive context mode'],
      [{ seatId: 'nope', contextMode: 'expansive' }, 'unknown seat: nope'],
      [{ seatId: 'claude-test', contextMode: 'huge' }, 'contextMode must be one of: standard, expansive'],
      [{ seatId: 'claude-test', contextMode: 'expansive', memoryEnabled: true }, 'preferences update must be exactly one of'],
      [{ memoryEnabled: 'no' }, 'memoryEnabled must be a boolean'],
      [{ memoryEnabled: true, theme: 'dark' }, 'unknown key: theme'],
      [{ projectPath: '/', memoryEnabled: false }, 'the filesystem root cannot be used as a workspace root'],
      [{ projectPath: path.join(tmpHome, '.ashlr'), memoryEnabled: false }, '~/.ashlr'],
      [{ projectPath: path.join(repo, 'missing'), memoryEnabled: false }, 'path must be an existing directory'],
      [{ projectPath: 'relative/dir', memoryEnabled: false }, 'absolute'],
    ];
    for (const [body, message] of cases) {
      const res = await post(port, mutate, '/api/verse/preferences', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res), JSON.stringify(body)).toContain(message);
    }
    // Resetting a seat that is not currently discovered only removes an entry.
    const reset = await post(port, mutate, '/api/verse/preferences', { seatId: 'local:gone', contextMode: 'standard' });
    expect(reset.status).toBe(200);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'verse', 'preferences.json'))).toBe(true);
  });

  it('POST is gated like every other mutation; other methods are 404', async () => {
    const readOnly = await boot({ allowDispatch: false });
    const off = await request(readOnly.port, 'POST', '/api/verse/preferences', readOnly.mutate, JSON.stringify({ memoryEnabled: false }));
    expect(off.status).toBe(404);
    const { port, read, mutate } = await boot();
    const noToken = await request(port, 'POST', '/api/verse/preferences', { ...read, 'content-type': 'application/json' }, JSON.stringify({ memoryEnabled: false }));
    expect(noToken.status).toBe(401);
    const wrongType = await request(port, 'POST', '/api/verse/preferences', { 'x-ashlr-token': mutate['x-ashlr-token']! }, '{}');
    expect(wrongType.status).toBe(415);
    expect((await request(port, 'DELETE', '/api/verse/preferences', read)).status).toBe(404);
    expect(fs.existsSync(path.join(tmpHome, '.ashlr', 'verse', 'preferences.json'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/context-fit
// ---------------------------------------------------------------------------

describe('GET /api/verse/context-fit', () => {
  function writeBytes(dir: string, name: string, bytes: number): void {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), 'a'.repeat(bytes));
  }

  function q(params: Array<[string, string]>): string {
    return `/api/verse/context-fit?${new URLSearchParams(params).toString()}`;
  }

  it('measures the primary plus repeated extraRoots, and a symlinked duplicate once', async () => {
    writeBytes(repo, 'src/a.ts', 400);
    writeBytes(repo, 'README.md', 1_000);
    writeBytes(other, 'lib/b.ts', 800);
    const alias = path.join(tmpRepoRoot, 'alias');
    fs.symlinkSync(repo, alias);
    const { port, read } = await boot();

    const res = await request(port, 'GET', q([['projectPath', repo], ['extraRoots', other], ['extraRoots', alias]]), read);
    expect(res.status, res.body).toBe(200);
    const fit = res.json as VerseContextFit;
    expect(fit.estimator).toBe('bytes/4');
    expect(fit.roots.map((r) => r.path)).toEqual([fs.realpathSync(repo), fs.realpathSync(other)]);
    expect(fit.roots.map((r) => [r.files, r.bytes, r.estTokens, r.truncated])).toEqual([
      [2, 1_400, 350, false],
      [1, 800, 200, false],
    ]);
    expect(fit.totalEstTokens).toBe(550);
    expect(Number.isNaN(Date.parse(fit.sampledAt))).toBe(false);
  });

  it('measures a named workspace from the registry', async () => {
    writeBytes(repo, 'a.ts', 40);
    writeBytes(other, 'b.ts', 80);
    const { port, read, mutate } = await boot();
    const ws = await post(port, mutate, '/api/verse/workspaces', { name: 'Pair', roots: [repo, other] });
    expect(ws.status, ws.body).toBe(201);
    const id = (ws.json as { id: string }).id;
    const res = await request(port, 'GET', q([['workspaceId', id]]), read);
    expect(res.status, res.body).toBe(200);
    const fit = res.json as VerseContextFit;
    expect(fit.roots.map((r) => r.path)).toEqual([fs.realpathSync(repo), fs.realpathSync(other)]);
    expect(fit.totalEstTokens).toBe(30);

    // A root deleted since the workspace was saved is refused, not measured as zero.
    fs.rmSync(other, { recursive: true, force: true });
    const stale = await request(port, 'GET', q([['workspaceId', id]]), read);
    expect(stale.status).toBe(400);
    expect(errorOf(stale)).toBe('path must be an existing directory');
  });

  it('applies the session-root rules and strict query parsing (400s)', async () => {
    const { port, read } = await boot();
    const cases: Array<[string, string]> = [
      ['/api/verse/context-fit', 'workspaceId or projectPath is required'],
      [q([['workspaceId', 'w1'], ['projectPath', repo]]), 'not both'],
      [q([['workspaceId', 'w-missing']]), 'unknown workspace: w-missing'],
      [q([['workspaceId', ' ']]), 'workspaceId must be a non-empty string'],
      [q([['projectPath', repo], ['projectPath', other]]), 'query parameter projectPath may appear only once'],
      [q([['projectPath', repo], ['depth', '2']]), 'unknown query parameter: depth'],
      [q([['projectPath', path.join(tmpHome, '.ashlr')]]), '~/.ashlr'],
      [q([['projectPath', tmpHome]]), 'your home directory'],
      [q([['projectPath', path.join(repo, 'nope')]]), 'path must be an existing directory'],
      [q([['projectPath', repo], ['extraRoots', '']]), 'extraRoots entry is required'],
      [q([['projectPath', repo], ...Array.from({ length: 8 }, (): [string, string] => ['extraRoots', other])]), 'at most 8 roots'],
    ];
    for (const [url, message] of cases) {
      const res = await request(port, 'GET', url, read);
      expect(res.status, url).toBe(400);
      expect(errorOf(res), url).toContain(message);
    }
    expect((await request(port, 'POST', q([['projectPath', repo]]), { ...read, 'content-type': 'application/json' }, '{}')).status).toBe(404);
    expect((await request(port, 'GET', q([['projectPath', repo]]))).status).toBe(401);
  });

  it('expands the `~/` spelling sanitized responses use', async () => {
    const inside = path.join(tmpHome, 'proj');
    writeBytes(inside, 'x.ts', 12);
    const { port, read } = await boot();
    const res = await request(port, 'GET', q([['projectPath', '~/proj']]), read);
    expect(res.status, res.body).toBe(200);
    const fit = res.json as VerseContextFit;
    expect(fit.totalEstTokens).toBe(3);
    expect(fit.roots).toHaveLength(1);
    expect(fit.roots[0]?.path.endsWith('/proj')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/verse/search
// ---------------------------------------------------------------------------

describe('GET /api/verse/search', () => {
  async function seedSearch(port: number, mutate: Mutate): Promise<{ a: VerseSession; b: VerseSession }> {
    const a = await create(port, mutate, { title: 'Flaky tests' });
    engine.emit(a.id, { type: 'user-message', turnId: 't1', text: 'The migration test is flaky on CI.' });
    engine.emit(a.id, { type: 'assistant-message', turnId: 't1', text: 'Pinned the migration clock; the test is stable now.' });
    engine.emit(a.id, { type: 'tool-result', turnId: 't1', toolUseId: 'u1', output: 'migration migration migration', isError: false });
    const b = await create(port, mutate, { title: 'Docs' });
    engine.emit(b.id, { type: 'user-message', turnId: 't2', text: 'Rewrite the README intro.' });
    return { a, b };
  }

  it('finds user and assistant messages (never tool output), newest session first, with a limit', async () => {
    const { port, read, mutate } = await boot();
    const { a } = await seedSearch(port, mutate);
    const res = await request(port, 'GET', '/api/verse/search?q=migration', read);
    expect(res.status, res.body).toBe(200);
    const body = res.json as VerseSearchResponse;
    expect(body.query).toBe('migration');
    expect(body.hits.map((h) => [h.sessionId, h.kind])).toEqual(
      expect.arrayContaining([[a.id, 'user'], [a.id, 'assistant']]),
    );
    expect(body.hits).toHaveLength(2);
    expect(body.hits.every((h) => h.snippet.toLowerCase().includes('migration'))).toBe(true);
    expect(body.scannedSessions).toBe(2);
    expect(body.truncated).toBe(false);

    const limited = await request(port, 'GET', '/api/verse/search?q=migration&limit=1', read);
    expect((limited.json as VerseSearchResponse).hits).toHaveLength(1);

    const none = await request(port, 'GET', '/api/verse/search?q=kubernetes', read);
    expect((none.json as VerseSearchResponse).hits).toEqual([]);

    // Terms are AND-ed.
    const both = await request(port, 'GET', `/api/verse/search?q=${encodeURIComponent('README migration')}`, read);
    expect((both.json as VerseSearchResponse).hits).toEqual([]);
  });

  it('validates q and limit (400) and is GET-only behind the read boundary', async () => {
    const { port, read, mutate } = await boot();
    await seedSearch(port, mutate);
    const cases: Array<[string, string]> = [
      ['/api/verse/search', 'q is required'],
      ['/api/verse/search?q=%20%20', 'q is required'],
      ['/api/verse/search?q=a&limit=0', 'limit must be a positive integer'],
      ['/api/verse/search?q=a&limit=abc', 'limit must be a positive integer'],
      ['/api/verse/search?q=a&limit=-3', 'limit must be a positive integer'],
      ['/api/verse/search?q=a&q=b', 'query parameter q may appear only once'],
      ['/api/verse/search?q=a&sort=new', 'unknown query parameter: sort'],
      [`/api/verse/search?q=${'x'.repeat(201)}`, ''],
    ];
    for (const [url, message] of cases) {
      const res = await request(port, 'GET', url, read);
      expect(res.status, url).toBe(400);
      expect((res.json as { code: string }).code).toBe('VERSE_INVALID');
      expect(errorOf(res), url).toContain(message);
    }
    // An over-large limit is clamped, not refused.
    expect((await request(port, 'GET', '/api/verse/search?q=migration&limit=5000', read)).status).toBe(200);
    expect((await request(port, 'GET', '/api/verse/search?q=migration')).status).toBe(401);
    expect((await request(port, 'POST', '/api/verse/search?q=migration', mutate, '{}')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// /api/verse/memory
// ---------------------------------------------------------------------------

describe('/api/verse/memory', () => {
  function memUrl(p: string): string {
    return `/api/verse/memory?${new URLSearchParams([['projectPath', p]]).toString()}`;
  }

  it('reads empty before anything exists, without creating anything', async () => {
    const { port, read } = await boot();
    const res = await request(port, 'GET', memUrl(repo), read);
    expect(res.status, res.body).toBe(200);
    expect(res.json).toEqual({
      projectPath: fs.realpathSync(repo),
      enabled: true,
      content: '',
      bytes: 0,
      updatedAt: null,
      files: [],
    } satisfies VerseProjectMemory);
    expect(fs.existsSync(memoryRoot())).toBe(false);
  });

  it('writes MEMORY.md privately, reads it back, reports the preference, and clears with ""', async () => {
    const { port, read, mutate } = await boot();
    const content = '# Project memory\n\n- Use pnpm, not npm (lockfile is pnpm-lock.yaml).\n';
    const write = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content });
    expect(write.status, write.body).toBe(200);
    const written = write.json as VerseProjectMemory;
    expect(written.content).toBe(content);
    expect(written.bytes).toBe(Buffer.byteLength(content));
    expect(written.enabled).toBe(true);
    expect(typeof written.updatedAt).toBe('string');

    const dirs = fs.readdirSync(memoryRoot());
    expect(dirs).toHaveLength(1);
    const file = path.join(memoryRoot(), dirs[0]!, 'MEMORY.md');
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(mode(file)).toBe(0o600);
    expect(mode(path.join(memoryRoot(), dirs[0]!))).toBe(0o700);

    // A new session on this project is snapshotted with exactly this text.
    await create(port, mutate);
    expect(engine.createOptions[0]?.memory?.block).toContain('Use pnpm, not npm');

    await post(port, mutate, '/api/verse/preferences', { projectPath: repo, memoryEnabled: false });
    const got = await request(port, 'GET', memUrl(repo), read);
    expect((got.json as VerseProjectMemory).enabled).toBe(false);
    expect((got.json as VerseProjectMemory).content).toBe(content);

    // Writing stays allowed while disabled — clearing must always work.
    const cleared = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: '' });
    expect(cleared.status).toBe(200);
    expect((cleared.json as VerseProjectMemory).content).toBe('');
    expect((cleared.json as VerseProjectMemory).enabled).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  });

  it('validates strictly: unknown keys, missing content, NUL bytes, guarded paths, size', async () => {
    const { port, read, mutate } = await boot();
    const cases: Array<[unknown, number, string]> = [
      [{ projectPath: repo, content: 'x', append: true }, 400, 'unknown key: append'],
      [{ projectPath: repo }, 400, 'content must be a string'],
      [{ projectPath: repo, content: 42 }, 400, 'content must be a string'],
      [{ projectPath: repo, content: 'a\u0000b' }, 400, 'NUL'],
      [{ content: 'x' }, 400, 'projectPath is required'],
      [{ projectPath: path.join(tmpHome, '.ashlr', 'verse'), content: 'x' }, 400, '~/.ashlr'],
      [{ projectPath: '/', content: 'x' }, 400, 'the filesystem root'],
      [{ projectPath: repo, content: 'x'.repeat(70_000) }, 413, ''],
    ];
    for (const [body, status, message] of cases) {
      const res = await post(port, mutate, '/api/verse/memory', body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(errorOf(res)).toContain(message);
    }
    expect(fs.existsSync(memoryRoot())).toBe(false);

    const getCases: Array<[string, string]> = [
      ['/api/verse/memory', 'projectPath is required'],
      [`${memUrl(repo)}&extra=1`, 'unknown query parameter: extra'],
      [memUrl(path.join(repo, 'missing')), 'path must be an existing directory'],
    ];
    for (const [url, message] of getCases) {
      const res = await request(port, 'GET', url, read);
      expect(res.status, url).toBe(400);
      expect(errorOf(res), url).toContain(message);
    }
  });

  it('accepts content AT the byte limit even when JSON escaping doubles the body; the content cap stays 413', async () => {
    const { port, read, mutate } = await boot();
    // Every newline is two bytes once escaped: a 128 KiB body for 64 KiB of
    // content — the case the shared 65,536-byte body cap could never admit.
    const atLimit = '\n'.repeat(VERSE_MEMORY_MAX_BYTES);
    const body = JSON.stringify({ projectPath: repo, content: atLimit });
    expect(Buffer.byteLength(body)).toBeGreaterThan(2 * DEFAULT_MAX_BODY_BYTES - 1);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(VERSE_MEMORY_BODY_MAX_BYTES);
    const ok = await request(port, 'POST', '/api/verse/memory', mutate, body);
    expect(ok.status, ok.body.slice(0, 200)).toBe(200);
    expect((ok.json as VerseProjectMemory).bytes).toBe(VERSE_MEMORY_MAX_BYTES);

    // One byte over the CONTENT limit: refused by the content rule, not the body cap.
    const over = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: `${atLimit}x` });
    expect(over.status).toBe(413);
    expect(errorOf(over)).toBe(`content exceeds ${VERSE_MEMORY_MAX_BYTES} bytes`);

    // One byte over the MEMORY body cap: refused before parsing.
    const padded = JSON.stringify({ projectPath: repo, content: '' });
    const hugeBody = padded.slice(0, -1) + ' '.repeat(VERSE_MEMORY_BODY_MAX_BYTES - Buffer.byteLength(padded) + 1) + '}';
    expect(Buffer.byteLength(hugeBody)).toBe(VERSE_MEMORY_BODY_MAX_BYTES + 1);
    const tooBig = await request(port, 'POST', '/api/verse/memory', mutate, hugeBody);
    expect(tooBig.status).toBe(413);
    expect(errorOf(tooBig)).toBe('request body too large');

    // Multi-byte text across many socket chunks round-trips byte-exact.
    const dashes = '\u2014'.repeat(Math.floor(VERSE_MEMORY_MAX_BYTES / 3));
    const wrote = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: dashes });
    expect(wrote.status).toBe(200);
    const onDisk = fs.readFileSync(path.join(memoryRoot(), fs.readdirSync(memoryRoot())[0]!, 'MEMORY.md'), 'utf8');
    expect(onDisk === dashes).toBe(true);
    const got = await request(port, 'GET', memUrl(repo), read);
    expect((got.json as VerseProjectMemory).content === dashes).toBe(true);
  });

  it('every other POST keeps the shared 65,536-byte body cap', async () => {
    const { port, mutate } = await boot();
    const base = JSON.stringify({ projectPath: repo, memoryEnabled: true });
    const pad = (n: number) => base.slice(0, -1) + ' '.repeat(n - Buffer.byteLength(base)) + '}';
    const atCap = await request(port, 'POST', '/api/verse/preferences', mutate, pad(DEFAULT_MAX_BODY_BYTES));
    expect(atCap.status, atCap.body).toBe(200);
    const overCap = await request(port, 'POST', '/api/verse/preferences', mutate, pad(DEFAULT_MAX_BODY_BYTES + 1));
    expect(overCap.status).toBe(413);
    expect(errorOf(overCap)).toBe('request body too large');
  });

  it('flags content the sanitizer changed, and refuses a save that would write placeholders over secrets', async () => {
    const { port, read, mutate } = await boot();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const raw = `# Notes\n- scratch lives in ${tmpHome}/scratch\n- test key ${secret}\n`;
    const write = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: raw });
    expect(write.status, write.body).toBe(200);
    const file = path.join(memoryRoot(), fs.readdirSync(memoryRoot())[0]!, 'MEMORY.md');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);

    // What the browser sees is the sanitized view, and it says so.
    const got = await request(port, 'GET', memUrl(repo), read);
    const view = got.json as VerseProjectMemory & { contentSanitized?: boolean };
    expect(view.contentSanitized).toBe(true);
    expect((write.json as { contentSanitized?: boolean }).contentSanitized).toBe(true);
    expect(view.content).toContain('~/scratch');
    expect(view.content).toContain('[REDACTED]');
    expect(view.content).not.toContain(secret);

    // Saving that view back would replace the real key with the placeholder.
    const echoed = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: `${view.content}- new line\n` });
    expect(echoed.status).toBe(409);
    expect((echoed.json as { code?: string }).code).toBe('VERSE_MEMORY_REDACTED');
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);

    // Dropping the placeholder line is allowed; the `~` spelling is kept as written.
    const edited = view.content.split('\n').filter((l) => !l.includes('[REDACTED]')).join('\n');
    const saved = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: edited });
    expect(saved.status, saved.body).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
    expect(saved.json).not.toHaveProperty('contentSanitized');
  });

  it('keeps a file that already holds the literal marker editable (only an INCREASE is refused)', async () => {
    const { port, mutate } = await boot();
    expect((await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: 'seed' })).status).toBe(200);
    const file = path.join(memoryRoot(), fs.readdirSync(memoryRoot())[0]!, 'MEMORY.md');
    // An agent quoted an already-scrubbed log line into its own file.
    fs.writeFileSync(file, 'log said: token [REDACTED]\n');
    const same = await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: 'log said: token [REDACTED]\nmore\n' });
    expect(same.status, same.body).toBe(200);
    const more = await post(port, mutate, '/api/verse/memory', {
      projectPath: repo, content: 'log said: token [REDACTED]\nand [REDACTED]\n',
    });
    expect(more.status).toBe(409);
  });

  it('GET works on a read-only server; POST there is 404', async () => {
    const { port, read, mutate } = await boot({ allowDispatch: false });
    expect((await request(port, 'GET', memUrl(repo), read)).status).toBe(200);
    expect((await post(port, mutate, '/api/verse/memory', { projectPath: repo, content: 'x' })).status).toBe(404);
    expect((await request(port, 'GET', memUrl(repo))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// readBody (src/core/web/api.ts) — the shared body reader
// ---------------------------------------------------------------------------

describe('readBody', () => {
  function fakeReq(): PassThrough & IncomingMessage {
    return new PassThrough() as unknown as PassThrough & IncomingMessage;
  }

  it('decodes a multi-byte character split across chunks exactly once', async () => {
    const req = fakeReq();
    const pending = readBody(req);
    const bytes = Buffer.from('a\u2014b', 'utf8'); // the em dash is 3 bytes
    req.write(bytes.subarray(0, 2));
    req.write(bytes.subarray(2));
    req.end();
    expect(await pending).toBe('a\u2014b');
  });

  it('rejects past the default cap, and honours a per-call cap', async () => {
    const small = fakeReq();
    const refused = readBody(small);
    small.end(Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 0x61));
    await expect(refused).rejects.toThrow('request body too large');

    const big = fakeReq();
    const allowed = readBody(big, DEFAULT_MAX_BODY_BYTES * 2);
    big.end(Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, 0x61));
    expect((await allowed).length).toBe(DEFAULT_MAX_BODY_BYTES + 1);
  });
});

// ---------------------------------------------------------------------------
// Route shape
// ---------------------------------------------------------------------------

describe('route shape', () => {
  it('bootstrap keeps its exact key set; the new routes answer only their methods', async () => {
    const { port, read, mutate } = await boot();
    const bootstrap = await request(port, 'GET', '/api/verse/bootstrap', read);
    expect(Object.keys(bootstrap.json as object).sort()).toEqual(['dispatchEnabled', 'localRuntime', 'projects', 'seats', 'sessions']);

    expect((await request(port, 'PUT', '/api/verse/memory', read)).status).toBe(404);
    expect((await request(port, 'POST', '/api/verse/context-fit', mutate, '{}')).status).toBe(404);
    expect((await request(port, 'GET', '/api/verse/preferences/extra', read)).status).toBe(404);
    expect((await request(port, 'GET', '/api/verse/searchx?q=a', read)).status).toBe(404);
  });
});
