/**
 * 3.16 — /api/verse/multimodel/**: the context read (learning, ROI,
 * local-only, local badges), once-per-send labelling, outcome and link
 * writes, the per-chat meter (with the fleet's share of each seat), local
 * warm-up — plus the mutation gate and strict bodies. Also the on-disk store
 * and the loopback-only warm-up itself.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { VerseEvent, VerseSeat, VerseSession } from '../src/core/verse/types.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { createMultimodelApi, foldRoiByEngine, listPriceOf, localBadges, type MultimodelApiDeps } from '../src/core/verse/multimodel-api.js';
import { createMultimodelStore, type MultimodelStore } from '../src/core/verse/multimodel/store.js';
import { isLoopbackUrl, lastThroughput, recordThroughput, resetThroughputForTest, warmLocalModel } from '../src/core/verse/multimodel/local-warm.js';
import { completedLocalTurnThroughput, localSpeedBinding, type LocalSpeedBinding } from '../src/core/verse/local-throughput.js';
import { DEFAULT_CLAUDE_MODEL_ID, DEFAULT_CODEX_MODEL_ID, KNOWN_MODELS } from '../src/core/run/model-catalog.js';
import type { ChatMeter, LocalWarmResult, MultimodelContext } from '../src/core/verse/multimodel/types.js';

const TOKEN = 'mm-test-token';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');

function seat(id: string, engine: VerseSeat['engine'], label: string, windows: Array<{ id: string; usedPercent: number }> = []): VerseSeat {
  return {
    id, engine, label, accountId: engine === 'local' ? 'local' : id,
    models: [{ id: engine === 'local' ? id.replace(/^local:/, '') : `${engine}-default`, label, contextWindow: engine === 'local' ? 65_536 : 1_000_000 }],
    contextWindow: engine === 'local' ? 65_536 : 1_000_000,
    health: { state: 'ready', summary: null, windows: [], observedAt: null },
    ...(engine === 'local' ? {} : {
      capacity: {
        source: 'collector', observedAt: new Date(NOW - 60_000).toISOString(), usability: 'ready', planType: 'max',
        windows: windows.map((w) => ({ id: w.id, usedPercent: w.usedPercent, resetsAt: null, resetDescription: null, limitReached: false, measured: true })),
        binding: null, credits: null, evidence: 'collector',
      } as unknown as NonNullable<VerseSeat['capacity']>,
    }),
  };
}

function session(id: string, over: Partial<VerseSession> = {}): VerseSession {
  return {
    id, title: id, projectPath: '/repo', engine: 'claude', accountId: 'claude', seatId: 'claude', model: 'claude-sonnet-5',
    nativeSessionId: null, createdAt: '', updatedAt: new Date(NOW).toISOString(), status: 'idle', turnCount: 1,
    usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null },
    lastError: null, ...over,
  };
}

const SEATS = [
  seat('claude', 'claude', 'Claude Max', [{ id: 'five_hour', usedPercent: 40 }]),
  seat('local:qwen3.6:27b', 'local', 'Qwen 27B (local)'),
  seat('local:remote', 'local', 'Remote (local)'),
];
const LAUNCHES = new Map<string, VerseSeatLaunch>([
  ['local:qwen3.6:27b', { seat: SEATS[1]!, launcher: null, ollamaBaseUrl: 'http://127.0.0.1:11434' }],
  ['local:remote', { seat: SEATS[2]!, launcher: null, ollamaBaseUrl: 'http://10.0.0.9:11434' }],
]);

let sessions: VerseSession[] = [];
let events: Record<string, VerseEvent[]> = {};
let store: MultimodelStore;
let localOnly: string | null = null;
const labelled: Array<{ text: string; reason: string | null | undefined }> = [];
const warmed: string[] = [];

const deps: MultimodelApiDeps = {
  store: () => store,
  listSessions: async () => sessions,
  getEvents: async (id) => events[id] ?? [],
  getLocalBinding: async (id) => {
    const session = sessions.find(s => s.id === id);
    const launch = session ? LAUNCHES.get(session.seatId) : null;
    return session && launch ? localSpeedBinding(launch.seat, session.model, launch) : null;
  },
  discovery: async () => ({ seats: SEATS, launches: LAUNCHES }),
  roi: () => ({ claude: { dispatches: 12, shipRate: 0.5, avgLatencyMs: 1000 } }),
  localOnlyReason: async (_cfg, projectPath) => (projectPath === '/private-repo' ? 'private-repo is listed in foundry.wiki.localOnlyRepos.' : localOnly),
  budgetPolicy: async () => ({ mode: 'balanced', seats: {}, updatedAt: new Date(0).toISOString() }),
  priceOf: listPriceOf,
  warm: async (t) => { warmed.push(`${t.seatId}@${t.ollamaBaseUrl}`); return { seatId: t.seatId, ok: true, ms: 12, loadMs: 800, tokPerSec: 41.5, error: null } satisfies LocalWarmResult; },
  label: async (text, opts) => {
    labelled.push({ text, reason: opts.localOnlyReason });
    return { classification: { kind: 'review', task: 'review', difficulty: 'high', size: 'small', estTokens: 3, label: 'deep review', signals: [], decidedBy: 'rules', confidence: null }, fallbackReason: 'The decision layer is not installed; the rules labelled this.' };
  },
  now: () => NOW,
};

let server: http.Server;
let base: string;
let allowDispatch = true;

beforeAll(async () => {
  const api = createMultimodelApi(deps);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: VerseApiContext = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch };
    void api(ctx, req, res, url.pathname, req.method ?? 'GET').then((handled) => {
      if (!handled) {
        res.writeHead(418, { 'Content-Type': 'application/json' });
        res.end('{"error":"not mine"}');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store = createMultimodelStore(mkdtempSync(join(tmpdir(), 'mm-store-')));
  sessions = [session('root'), session('draft', { engine: 'local', seatId: 'local:qwen3.6:27b', model: 'qwen3.6:27b', usage: { inputTokens: 300_000, outputTokens: 50_000, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: null } })];
  events = {};
  localOnly = null;
  labelled.length = 0;
  warmed.length = 0;
  allowDispatch = true;
  resetThroughputForTest();
});

const get = (path: string) => fetch(`${base}${path}`);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-ashlr-token': TOKEN, ...headers },
  body: JSON.stringify(body),
});

describe('routes', () => {
  it('declines paths that are not its own', async () => {
    expect((await get('/api/verse/wiki')).status).toBe(418);
    expect((await get('/api/verse/multimodel/nope')).status).toBe(404);
  });

  it('GET /context: learned table, per-engine ROI, local-only, and local badges (private only on loopback)', async () => {
    await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'review', signal: 'up' });
    events['q'] = [
      { seq: 1, at: new Date(NOW - 10_000).toISOString(), type: 'usage', turnId: 't1', usage: { inputTokens: 10, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 65_536 } },
      { seq: 2, at: new Date(NOW).toISOString(), type: 'turn-done', turnId: 't1', ok: true, durationMs: 10_000, nativeSessionId: null },
    ] as unknown as VerseEvent[];
    sessions.push(session('q', { engine: 'local', seatId: 'local:qwen3.6:27b', model: 'qwen3.6:27b', turnCount: 1 }));
    const res = await get('/api/verse/multimodel/context?projectPath=%2Fprivate-repo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as MultimodelContext;
    expect(body.learned['review|seat:claude']).toMatchObject({ up: 1, down: 0 });
    expect(body.roi.claude?.shipRate).toBe(0.5);
    expect(body.localOnly).toEqual({ on: true, reason: 'private-repo is listed in foundry.wiki.localOnlyRepos.' });
    expect(body.local.map((b) => [b.seatId, b.private, b.contextWindow])).toEqual([['local:qwen3.6:27b', true, 65_536], ['local:remote', false, 65_536]]);
    // Speed from the last clean local turn, end to end (400 tokens / 10 s).
    expect(body.local[0]).toMatchObject({ tokPerSec: 40, tokPerSecSource: 'turn' });
  });

  it('a chat is private when ANY root it reaches is local-only (not just its primary)', async () => {
    sessions.push(session('multi', { projectPath: '/repo', extraRoots: ['/private-repo'] }));
    const ctx = (await (await get('/api/verse/multimodel/context?sessionId=multi')).json()) as MultimodelContext;
    expect(ctx.localOnly).toEqual({ on: true, reason: 'private-repo is listed in foundry.wiki.localOnlyRepos.' });
    expect(((await (await get('/api/verse/multimodel/context?sessionId=root')).json()) as MultimodelContext).localOnly.on).toBe(false);
    await post('/api/verse/multimodel/label', { text: 'review this', sessionId: 'multi' });
    expect(labelled.at(-1)?.reason).toBe('private-repo is listed in foundry.wiki.localOnlyRepos.');
    // One scope per request.
    expect((await get('/api/verse/multimodel/context?sessionId=multi&projectPath=%2Frepo')).status).toBe(400);
    expect((await get('/api/verse/multimodel/context?sessionId=..%2Fx')).status).toBe(400);
  });

  it('GET /context is strict about its query', async () => {
    expect((await get('/api/verse/multimodel/context?projectPath=relative/path')).status).toBe(400);
    expect((await get('/api/verse/multimodel/context?x=1')).status).toBe(400);
    expect((await get('/api/verse/multimodel/context')).status).toBe(200);
  });

  it('POST /label hands the local-only reason to the labeller (which then keeps the text on this Mac)', async () => {
    const res = await post('/api/verse/multimodel/label', { text: 'review this', projectPath: '/private-repo' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { classification: { decidedBy: string }; fallbackReason: string };
    expect(body.classification.decidedBy).toBe('rules');
    expect(labelled).toEqual([{ text: 'review this', reason: 'private-repo is listed in foundry.wiki.localOnlyRepos.' }]);
    expect((await post('/api/verse/multimodel/label', { text: '' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/label', { text: 'x', extra: 1 })).status).toBe(400);
  });

  it('every POST is behind the dispatch switch and the mutation token + JSON gate', async () => {
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'code', signal: 'up' }, { 'x-ashlr-token': 'wrong' })).status).toBe(401);
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'code', signal: 'up' }, { 'content-type': 'text/plain' })).status).toBe(415);
    allowDispatch = false;
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'code', signal: 'up' })).status).toBe(404);
    expect(await store.readOutcomes()).toEqual([]);
  });

  it('POST /outcome validates and records the seat engine server-side', async () => {
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'poetry', signal: 'up' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'code', signal: 'love' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'claude', kind: 'code', signal: 'up', engine: 'grok' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/outcome', { seatId: 'local:qwen3.6:27b', kind: 'code', signal: 'draft-accepted', sessionId: 'draft' })).status).toBe(200);
    expect(await store.readOutcomes()).toEqual([{ at: new Date(NOW).toISOString(), seatId: 'local:qwen3.6:27b', engine: 'local', kind: 'code', signal: 'draft-accepted', sessionId: 'draft' }]);
  });

  it('POST /link joins existing chats only; GET /meter then counts the whole thread', async () => {
    expect((await post('/api/verse/multimodel/link', { parentSessionId: 'root', childSessionId: 'ghost', relation: 'compare' })).status).toBe(404);
    expect((await post('/api/verse/multimodel/link', { parentSessionId: 'root', childSessionId: 'root', relation: 'compare' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/link', { parentSessionId: 'root', childSessionId: 'draft', relation: 'poke' })).status).toBe(400);
    expect((await post('/api/verse/multimodel/link', { parentSessionId: 'root', childSessionId: 'draft', relation: 'draft' })).status).toBe(200);
    const res = await get('/api/verse/multimodel/meter?sessionId=root');
    expect(res.status).toBe(200);
    const meter = (await res.json()) as ChatMeter;
    expect(meter.sessions.map((s) => [s.sessionId, s.relation])).toEqual([['root', 'root'], ['draft', 'draft']]);
    // Sonnet list price: 1M in × $3 + 100k out × $15 = $4.50; local priced at that rate = $0.90 + $0.75.
    expect(meter.totals.listUsd).toBe(4.5);
    expect(meter.totals.savedUsd).toBe(1.65);
    const claude = meter.seats.find((s) => s.seatId === 'claude');
    expect(claude).toMatchObject({ window: '5-hour 40% used', fleetShare: 'The fleet may use 60%; 40% is kept for your chats.' });
    expect(meter.budgetMode).toBe('balanced');
    expect((await get('/api/verse/multimodel/meter?sessionId=nope')).status).toBe(404);
    expect((await get('/api/verse/multimodel/meter')).status).toBe(400);
  });

  it('POST /local/warm warms a local seat of this machine only', async () => {
    const ok = await post('/api/verse/multimodel/local/warm', { seatId: 'local:qwen3.6:27b' });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as LocalWarmResult).tokPerSec).toBe(41.5);
    expect(warmed).toEqual(['local:qwen3.6:27b@http://127.0.0.1:11434']);
    expect((await post('/api/verse/multimodel/local/warm', { seatId: 'claude' })).status).toBe(404);
    expect((await post('/api/verse/multimodel/local/warm', {})).status).toBe(400);
  });
});

describe('helpers', () => {
  it('list prices come from the fleet catalog (one table), with family fallbacks', () => {
    const sonnet = KNOWN_MODELS.find((m) => m.id === 'claude:sonnet')!;
    expect(listPriceOf('claude', 'claude-sonnet-4-7')).toEqual({ inPerM: sonnet.costPerMTokIn, outPerM: sonnet.costPerMTokOut });
    for (const [engine, model] of [['claude', DEFAULT_CLAUDE_MODEL_ID], ['codex', DEFAULT_CODEX_MODEL_ID]] as const) {
      const current = KNOWN_MODELS.find(entry => entry.id === `${engine}:${model}`)!;
      expect(current).toBeDefined();
      expect(listPriceOf(engine, model)).toEqual({ inPerM: current.costPerMTokIn, outPerM: current.costPerMTokOut });
    }
    const legacyOpus = KNOWN_MODELS.find(entry => entry.id === 'claude:opus')!;
    expect(listPriceOf('claude', 'claude-opus-unknown')).toEqual({ inPerM: legacyOpus.costPerMTokIn, outPerM: legacyOpus.costPerMTokOut });
    const legacyCodex = KNOWN_MODELS.find(entry => entry.id === 'codex:gpt-5.5')!;
    expect(listPriceOf('codex', 'gpt-6')).toEqual({ inPerM: legacyCodex.costPerMTokIn, outPerM: legacyCodex.costPerMTokOut });
    expect(listPriceOf('grok', 'grok-4')).toBeNull();
    expect(listPriceOf('local', 'qwen')).toBeNull();
  });

  it('fleet ROI folds lane names onto chat engines, dispatch-weighted', () => {
    const roi = foldRoiByEngine([
      { engine: 'claude-cli', dispatches: 10, judged: 10, shipVerdicts: 5, avgLatencyMs: 100 },
      { engine: 'claude', dispatches: 30, judged: 10, shipVerdicts: 9, avgLatencyMs: 300 },
      { engine: 'grok-cli', dispatches: 4, judged: 0, shipVerdicts: 0, avgLatencyMs: null },
      { engine: 'local-coder', dispatches: 2, judged: 2, shipVerdicts: 1, avgLatencyMs: 50 },
    ]);
    expect(roi['claude']).toEqual({ dispatches: 40, shipRate: 0.7, avgLatencyMs: 250 });
    expect(roi['grok']).toEqual({ dispatches: 4, shipRate: null, avgLatencyMs: null });
    expect(roi['local']?.shipRate).toBe(0.5);
  });

  it('the store is private, bounded and survives a torn line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mm-priv-'));
    const s = createMultimodelStore(join(root, 'mm'));
    await s.appendOutcome({ at: new Date(NOW).toISOString(), seatId: 'grok', engine: 'grok', kind: 'code', signal: 'up' });
    await Promise.all([
      s.addLink({ parentSessionId: 'a', childSessionId: 'b', relation: 'compare', at: '' }),
      s.addLink({ parentSessionId: 'a', childSessionId: 'c', relation: 'compare', at: '' }),
      s.addLink({ parentSessionId: 'a', childSessionId: 'b', relation: 'review', at: '' }),
    ]);
    expect((await s.readLinks()).map((l) => `${l.childSessionId}:${l.relation}`)).toEqual(['c:compare', 'b:review']);
    expect(statSync(join(root, 'mm')).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, 'mm', 'outcomes.jsonl')).mode & 0o777).toBe(0o600);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(root, 'mm', 'outcomes.jsonl'), '{"torn":\n');
    expect(await s.readOutcomes()).toHaveLength(1);
    // Nothing prompt-shaped is ever written.
    expect(readFileSync(join(root, 'mm', 'outcomes.jsonl'), 'utf8')).not.toMatch(/text|prompt/);
  });
});

describe('warmLocalModel', () => {
  it('refuses anything that is not loopback, before any request', async () => {
    let called = false;
    const res = await warmLocalModel({ seatId: 'local:x', model: 'x', ollamaBaseUrl: 'http://10.0.0.9:11434' }, { fetchImpl: (async () => { called = true; return new Response('{}'); }) as typeof fetch });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not point at this Mac/);
    expect(called).toBe(false);
    expect(isLoopbackUrl('http://localhost:1234')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false);
  });

  it('Ollama lane: keep_alive, exact generation speed and the cold-load time', async () => {
    let body: Record<string, unknown> = {};
    let url = '';
    const res = await warmLocalModel({ seatId: 'local:q', model: 'qwen3.6:27b', contextWindow: 65_536, ollamaBaseUrl: 'http://127.0.0.1:11434/' }, {
      fetchImpl: (async (u: string, init: RequestInit) => {
        url = u;
        body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ eval_count: 24, eval_duration: 500_000_000, load_duration: 7_250_000_000 }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(url).toBe('http://127.0.0.1:11434/api/generate');
    expect(body).toMatchObject({ model: 'qwen3.6:27b', stream: false, keep_alive: '30m' });
    expect(res).toMatchObject({ ok: true, tokPerSec: 48, loadMs: 7250, error: null });
    expect(lastThroughput({ seatId: 'local:q', model: 'qwen3.6:27b', endpoint: 'http://127.0.0.1:11434', contextWindow: 65_536 })).toMatchObject({ tokPerSec: 48, source: 'warm' });
  });

  it('llama-server lane goes through its loopback proxy and is measured end to end', async () => {
    let t = 0;
    const res = await warmLocalModel({ seatId: 'local:q', model: 'q', ollamaBaseUrl: 'http://127.0.0.1:11434', anthropicBaseUrl: 'http://127.0.0.1:8099' }, {
      now: () => (t += 500),
      fetchImpl: (async (u: string) => {
        expect(u).toBe('http://127.0.0.1:8099/v1/messages');
        return new Response(JSON.stringify({ usage: { output_tokens: 10 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: true, tokPerSec: 20, loadMs: null });
  });

  it('a runtime that is down or refuses says so', async () => {
    const down = await warmLocalModel({ seatId: 'l', model: 'm', ollamaBaseUrl: 'http://127.0.0.1:1' }, { fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    expect(down).toMatchObject({ ok: false, error: 'The local runtime is not reachable.' });
    const refused = await warmLocalModel({ seatId: 'l', model: 'm', ollamaBaseUrl: 'http://127.0.0.1:1' }, { fetchImpl: (async () => new Response('no', { status: 404 })) as typeof fetch });
    expect(refused).toMatchObject({ ok: false, error: 'The runtime answered 404.' });
  });
});


describe('local speed attribution and measurement time', () => {
  const current = () => localSpeedBinding(SEATS[1]!, 'qwen3.6:27b', LAUNCHES.get(SEATS[1]!.id)!)!;
  const turn = (at: number, outputTokens = 400): VerseEvent[] => [
    { seq: 1, at: new Date(at - 10_000).toISOString(), type: 'usage', turnId: 't', usage: { inputTokens: 0, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, contextTokens: 0, contextWindow: 65_536 } },
    { seq: 2, at: new Date(at).toISOString(), type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 10_000 },
  ];
  it('refreshes an older cached measurement from a newer valid completed turn with its original time', async () => {
    recordThroughput(current(), { tokPerSec: 90.12345, source: 'warm', scope: 'warm-decode', at: new Date(NOW - 60_000).toISOString() });
    sessions = [session('q', { engine: 'local', seatId: current().seatId, model: current().model })];
    events.q = turn(NOW - 20_000, 412);
    const result = await localBadges(deps, { seats: SEATS, launches: LAUNCHES });
    expect(result[0]).toMatchObject({ tokPerSec: 41.2, tokPerSecSource: 'turn', tokPerSecScope: 'turn-end-to-end', tokPerSecObservedAt: new Date(NOW - 20_000).toISOString(), state: 'unknown' });
    events.q = turn(NOW - 5_000, 573);
    expect((await localBadges(deps, { seats: SEATS, launches: LAUNCHES }))[0]).toMatchObject({ tokPerSec: 57.3, tokPerSecObservedAt: new Date(NOW - 5_000).toISOString() });
  });
  it('exposes exact completed-turn deltas and original time independently of newer warm speed without inference', async () => {
    const at = NOW - 7_200_000;
    const usage = { inputTokens: 1234, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 50, contextTokens: 1234, contextWindow: 65_536 };
    sessions = [session('q', { engine: 'local', seatId: current().seatId, model: current().model })];
    events.q = [
      { seq: 1, at: new Date(at - 10_000).toISOString(), type: 'usage', turnId: 't', usage },
      { seq: 2, at: new Date(at - 1000).toISOString(), type: 'usage', turnId: 't', usage: { ...usage, inputTokens: 22, outputTokens: 173, cacheReadTokens: 20, cacheCreationTokens: 0 } },
      { seq: 3, at: new Date(at).toISOString(), type: 'turn-done', turnId: 't', ok: true, nativeSessionId: null, durationMs: 12_345 },
    ];
    recordThroughput(current(), { tokPerSec: 90, source: 'warm', scope: 'warm-decode', at: new Date(NOW).toISOString() });
    const result = await get('/api/verse/multimodel/context');
    const data = await result.json() as MultimodelContext;
    expect(data.local[0]).toMatchObject({ tokPerSec: 90, tokPerSecScope: 'warm-decode', completedTurn: {
      scope: 'turn-end-to-end', observedAt: new Date(at).toISOString(), contextWindow: 65_536,
      durationMs: 12_345, inputTokens: 1256, outputTokens: 573, cacheReadTokens: 20, cacheCreationTokens: 50,
    } });
    expect(JSON.stringify(data.local[0]?.completedTurn)).not.toMatch(/endpoint|127\.0\.0\.1|nativeSessionId|projectPath/);
    expect(warmed).toEqual([]);
    expect(labelled).toEqual([]);
  });
  it('leaves absent or malformed recorded input/cache deltas unknown without losing valid output speed', () => {
    const rows = turn(NOW);
    const first = rows[0] as Extract<VerseEvent, { type: 'usage' }>;
    const missing = { ...first.usage } as Partial<typeof first.usage>;
    delete missing.inputTokens;
    const reading = completedLocalTurnThroughput([
      { ...first, usage: missing as typeof first.usage },
      { ...first, seq: 2, usage: { ...first.usage, inputTokens: 5, outputTokens: 20, cacheReadTokens: -1, cacheCreationTokens: Number.MAX_SAFE_INTEGER } },
      { ...first, seq: 3, usage: { ...first.usage, cacheCreationTokens: 1 } },
      rows[1]!,
    ]);
    expect(reading).toMatchObject({ tokPerSec: 82, durationMs: 10_000, inputTokens: null, outputTokens: 820, cacheReadTokens: null, cacheCreationTokens: null });
  });
  it.each(['failed', 'canceled', 'missing-usage', 'future', 'window-conflict', 'fractional-output'])('does not fabricate completed-turn details from %s evidence', async reason => {
    const at = reason === 'future' ? NOW + 1 : NOW;
    let rows = turn(at);
    if (reason === 'failed') rows = rows.map(event => event.type === 'turn-done' ? { ...event, ok: false } : event);
    if (reason === 'canceled') rows.unshift({ seq: 0, at: new Date(at).toISOString(), type: 'cancelled', turnId: 't' });
    if (reason === 'missing-usage') rows = rows.filter(event => event.type !== 'usage');
    if (reason === 'fractional-output') {
      const usage = rows[0] as Extract<VerseEvent, { type: 'usage' }>;
      rows = [{ ...usage, usage: { ...usage.usage, outputTokens: 0.5 } }, { ...usage, seq: 2, usage: { ...usage.usage, outputTokens: 0.5 } }, { ...rows[1]!, seq: 3 }];
    }
    if (reason === 'window-conflict') {
      const usage = rows[0] as Extract<VerseEvent, { type: 'usage' }>;
      rows.unshift({ ...usage, seq: 0, usage: { ...usage.usage, contextWindow: 32_768 } });
    }
    sessions = [session('q', { engine: 'local', seatId: current().seatId, model: current().model })]; events.q = rows;
    expect((await localBadges(deps, { seats: SEATS, launches: LAUNCHES }))[0]?.completedTurn).toBeNull();
    expect(warmed).toEqual([]);
  });
  it('keeps a newer warm-up reading when the only completed turn is older', async () => {
    const reading = { tokPerSec: 41.234567, source: 'warm' as const, scope: 'warm-decode' as const, at: new Date(NOW).toISOString() };
    recordThroughput(current(), reading);
    sessions = [session('q', { engine: 'local', seatId: current().seatId, model: current().model })]; events.q = turn(NOW - 10_000);
    expect((await localBadges(deps, { seats: SEATS, launches: LAUNCHES }))[0]).toMatchObject({ tokPerSec: reading.tokPerSec, tokPerSecObservedAt: reading.at, tokPerSecScope: reading.scope });
  });
  it('does not share a model measurement across endpoints, seats or configured contexts', () => {
    const identity = current(); recordThroughput(identity, { tokPerSec: 40, source: 'warm', scope: 'warm-decode', at: new Date(NOW).toISOString() });
    for (const change of [{ endpoint: 'http://127.0.0.1:8099' }, { seatId: 'local:other' }, { contextWindow: 32_768 }]) {
      expect(lastThroughput({ ...identity, ...change })).toBeNull();
    }
    recordThroughput(identity, { tokPerSec: 10, source: 'turn', scope: 'turn-end-to-end', at: new Date(NOW - 1).toISOString() });
    expect(lastThroughput(identity)?.tokPerSec).toBe(40);
  });
  it.each(['missing', 'changed-endpoint', 'changed-context', 'changed-model', 'changed-seat'])('keeps an unproved saved launch %s unknown instead of using current discovery as proof', async reason => {
    sessions = [session('q', { engine: 'local', seatId: current().seatId, model: current().model })]; events.q = turn(NOW);
    const binding: LocalSpeedBinding | null = reason === 'missing' ? null : { ...current(), ...(reason === 'changed-endpoint' ? { endpoint: 'http://127.0.0.1:8099' } : reason === 'changed-model' ? { model: 'other-model' } : reason === 'changed-seat' ? { seatId: 'other-seat' } : { contextWindow: 32_768 }) };
    const result = await localBadges({ ...deps, getLocalBinding: async () => binding }, { seats: SEATS, launches: LAUNCHES });
    expect(result[0]).toMatchObject({ tokPerSec: null, tokPerSecObservedAt: null, state: 'unknown', completedTurn: null });
  });
  it('retains unknown when per-turn context is absent, and reads at most three matching sessions', async () => {
    sessions = Array.from({ length: 5 }, (_, i) => session(`q${i}`, { engine: 'local', seatId: current().seatId, model: current().model, updatedAt: new Date(NOW - i).toISOString() }));
    const seen: string[] = [];
    const result = await localBadges({ ...deps, getEvents: async id => { seen.push(id); return turn(NOW).map(event => event.type === 'usage' ? { ...event, usage: { ...event.usage, contextWindow: null } } : event); } }, { seats: SEATS, launches: LAUNCHES });
    expect(seen.sort()).toEqual(['q0', 'q1', 'q2']); expect(result[0]?.tokPerSec).toBeNull();
  });
});


it('end-to-end warm speed includes body generation instead of stopping at response headers', async () => {
  let clock = 100;
  const response = new Response('{}', { status: 200 });
  Object.defineProperty(response, 'json', { value: async () => { clock = 1500; return { usage: { output_tokens: 10 } }; } });
  const result = await warmLocalModel({ seatId: 'local:test', model: 'test', contextWindow: 65_536,
    ollamaBaseUrl: 'http://127.0.0.1:11434', anthropicBaseUrl: 'http://127.0.0.1:8099' },
  { now: () => clock, fetchImpl: (async () => response) as typeof fetch });
  expect(result).toMatchObject({ ms: 1400, tokPerSec: 10 / 1.4, tokPerSecScope: 'warm-end-to-end' });
  expect(lastThroughput({ seatId: 'local:test', model: 'test', endpoint: 'http://127.0.0.1:8099', contextWindow: 65_536 }))
    .toEqual({ tokPerSec: 10 / 1.4, source: 'warm', scope: 'warm-end-to-end', at: new Date(clock).toISOString() });
});
