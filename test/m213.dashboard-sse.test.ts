/**
 * M213 Dashboard SSE tests — hermetic, all data-source modules mocked.
 *
 * Verifies:
 *   1. GET /api/events is handled (handleApi returns true)
 *   2. SSE response Content-Type: text/event-stream
 *   3. Connection handshake comment ': connected\n\n' is written
 *   4. 'snapshot' named SSE event emitted on initial tick
 *   5. snapshot payload includes dispatchEnabled: false
 *   6. snapshot payload includes dispatchEnabled: true when allowDispatch=true
 *   7. Existing events still emitted: runs, swarms, inbox, daemon, fleet-activity-ping
 *   8. drainSseConnections() ends the SSE response
 *   9. POST /api/events returns 404 (not a valid mutation route)
 *  10. server.ts HOST_RE allowlist — loopback-only binding verified
 *  11. app.js snapshot SSE handler suppresses polling only while snapshots are fresh
 *  12. app.js SSE error handler restores polling fallback
 *  13. app.js stale-snapshot watchdog restores polling and withholds exact learning metrics
 *  14. app.js Fleet Dashboard wires the M262 visibility panel
 *  15. app.js Fleet Dashboard status panel renders readiness rail
 *  16. app.js inbox detail reads current proposal review fields
 *  17. SSE response has Cache-Control: no-cache + Connection: keep-alive
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readAgentWorkspace,
  recordAgentAction,
} from '../src/core/fleet/agent-action-ledger.js';

// ---------------------------------------------------------------------------
// Config fixture
// ---------------------------------------------------------------------------

function makeConfig() {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_INDEX = { version: 1, generatedAt: new Date().toISOString(), root: '/home', items: [] };
const FIXTURE_TOOLS_REGISTRY = { tools: [], installedCount: 0 };
const FIXTURE_ROLLUP = {
  window: '7d' as const,
  since: new Date(Date.now() - 7 * 86400000).toISOString(),
  totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 0, commits: 0 },
  byProject: [], byDay: [], byModel: [],
  budget: {
    level: 'ok' as const, window: '7d', spentUsd: 0, capUsd: null,
    spentTokens: 0, capTokens: null, message: 'ok',
  },
};
const FIXTURE_DAEMON_STATE = {
  running: false, pid: null, startedAt: null, lastTickAt: null,
  todaySpentUsd: 0, itemsProcessed: 0, ticks: [],
  todayDate: new Date().toISOString().slice(0, 10),
};
const FIXTURE_FRONTIER_USAGE = { generatedAt: new Date().toISOString(), engines: [] };
const daemonStateMocks = vi.hoisted(() => ({
  loadDaemonStateStrict: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks (hoisted before dynamic imports)
// ---------------------------------------------------------------------------

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => FIXTURE_INDEX) }));
vi.mock('../src/core/tools-registry.js', () => ({ getToolsRegistry: vi.fn(() => FIXTURE_TOOLS_REGISTRY) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollup: vi.fn(() => FIXTURE_ROLLUP) }));
vi.mock('../src/core/run/orchestrator.js', () => ({
  listRuns: vi.fn(() => []),
  loadRun: vi.fn(() => null),
  runGoal: vi.fn(),
}));
vi.mock('../src/core/swarm/store.js', () => ({
  listSwarms: vi.fn(() => []),
  loadSwarm: vi.fn(() => null),
}));
vi.mock('../src/core/mcp-registry.js', () => ({ discoverMcpServers: vi.fn(() => ({ servers: [] })) }));
vi.mock('../src/core/genome/store.js', () => ({ loadGenome: vi.fn(() => []) }));
vi.mock('../src/core/genome/recall.js', () => ({ recall: vi.fn(async () => []) }));
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: vi.fn(() => 0),
  listProposals: vi.fn(() => []),
  loadProposal: vi.fn(() => null),
  setStatus: vi.fn(),
}));
vi.mock('../src/core/daemon/state.js', () => daemonStateMocks);
vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsageSync: vi.fn(() => FIXTURE_FRONTIER_USAGE),
}));
vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: vi.fn(async () => ({})),
  readFleetDaemonStatus: vi.fn(async () => ({
    daemon: {
      running: false,
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todaySpentUsd: 0,
    },
    recentTicks: [],
  })),
}));
vi.mock('../src/core/sandbox/policy.js', () => ({ listEnrolled: vi.fn(() => []) }));
vi.mock('../src/core/goals/store.js', () => ({ listGoals: vi.fn(() => []) }));
vi.mock('../src/core/goals/advance.js', () => ({
  progressOf: vi.fn(() => ({ fractionDone: 0, counts: {}, nextActionableId: null })),
}));
vi.mock('../src/cli/open.js', () => ({
  openInEditor: vi.fn(async () => ({ ok: true })),
  openInFinder: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../src/core/dashboard.js', () => ({
  buildSnapshot: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    repos: [],
    runs: [],
    swarms: [],
    pulse: null,
    genome: [],
    inbox: { pending: 0 },
    daemonObservation: {
      runtimeState: 'stopped',
      sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
      pendingProposals: 0,
    },
    fleet: null,
    frontierUsage: null,
  })),
}));
vi.mock('../src/core/web/control.js', () => ({
  buildControlSnapshot: vi.fn(async () => ({
    logs: [],
    logsSourceQuality: { sourceState: 'healthy', complete: true, reason: 'missing' },
  })),
  buildFleetActivity: vi.fn(async () => ({})),
}));

// ---------------------------------------------------------------------------
// Fake IncomingMessage / ServerResponse helpers
// ---------------------------------------------------------------------------

function makeReq(urlPath = '/api/events', method = 'GET'): IncomingMessage {
  return {
    url: urlPath,
    method,
    headers: { host: '127.0.0.1' },
    on(_event: string, _cb: () => void) { return this; },
  } as unknown as IncomingMessage;
}

function makeSseRes() {
  const headers: Record<string, string> = {};
  let statusCode = 0;
  const chunks: string[] = [];
  let ended = false;

  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number, hdrs?: Record<string, string>) {
      statusCode = status;
      if (hdrs) Object.assign(headers, hdrs);
      (this as { headersSent: boolean }).headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      ended = true;
      (this as { writableEnded: boolean }).writableEnded = true;
    },
    _headers: () => headers,
    _status: () => statusCode,
    _chunks: () => chunks,
    _ended: () => ended,
  };
  return res as unknown as ServerResponse & {
    _headers: () => Record<string, string>;
    _status: () => number;
    _chunks: () => string[];
    _ended: () => boolean;
  };
}

function makeJsonRes() {
  let statusCode = 0;
  let body: unknown = null;
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) { statusCode = status; },
    end(payload?: string) {
      try { body = JSON.parse(payload ?? ''); } catch { body = payload; }
    },
    _status: () => statusCode,
    _body: () => body,
  };
  return res as unknown as ServerResponse & { _status: () => number; _body: () => unknown };
}

// ---------------------------------------------------------------------------
// Import under test (after mocks are registered)
// ---------------------------------------------------------------------------

import { handleApi, drainSseConnections } from '../src/core/web/api.js';
import { buildSnapshot } from '../src/core/dashboard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CTX = { token: 'test-token', allowDispatch: false } as const;

daemonStateMocks.loadDaemonStateStrict.mockReturnValue({
  ok: true,
  state: FIXTURE_DAEMON_STATE,
  fresh: false,
});

/**
 * Open an SSE connection and drain the initial emitUpdate() async work.
 *
 * Strategy: advance fake timers by 0ms. This flushes all pending microtasks
 * (including the async buildSnapshot Promise chain inside emitUpdate) without
 * firing the 1500ms poll interval — so we see exactly the initial-tick events.
 */
async function openSseAndDrainInitial(
  cfg = makeConfig(),
  ctx: { token: string; allowDispatch: boolean } = BASE_CTX,
) {
  vi.useFakeTimers();
  const req = makeReq('/api/events');
  const res = makeSseRes();
  await handleApi(req, res as unknown as ServerResponse, cfg as any, ctx);
  // Flush the async microtask chain from the initial emitUpdate() call.
  // buildSnapshot is async, so its continuation lands in the microtask queue.
  // Pump the queue several times to let the full async chain resolve before
  // checking chunks. We do NOT advance the timer to avoid triggering the
  // 1500ms poll interval.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  return { req, res };
}

function ssePayload(chunks: string[], event: string): Record<string, unknown> {
  const frame = chunks.join('').split('\n\n').find((entry) => entry.startsWith(`event: ${event}\n`));
  expect(frame).toBeDefined();
  const data = frame!.split('\n').find((line) => line.startsWith('data: '));
  expect(data).toBeDefined();
  return JSON.parse(data!.slice('data: '.length)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M213 Dashboard SSE — /api/events', () => {
  afterEach(() => {
    drainSseConnections();
    vi.useRealTimers();
    daemonStateMocks.loadDaemonStateStrict.mockReset();
    daemonStateMocks.loadDaemonStateStrict.mockReturnValue({
      ok: true,
      state: FIXTURE_DAEMON_STATE,
      fresh: false,
    });
  });

  // ── 1. handleApi routes /api/events ──────────────────────────────────────

  it('handleApi returns true for GET /api/events', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events');
    const res = makeSseRes();
    const handled = await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(handled).toBe(true);
  });

  // ── 2. SSE response Content-Type ─────────────────────────────────────────

  it('sets Content-Type: text/event-stream', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._headers()['Content-Type']).toBe('text/event-stream');
  });

  // ── 3. Connection handshake comment ──────────────────────────────────────

  it('writes the ": connected\\n\\n" handshake comment', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain(': connected\n\n');
  });

  // ── 4. snapshot named event emitted on initial tick ──────────────────────

  it('emits a "snapshot" named SSE event on the initial tick', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: snapshot\n');
  });

  // ── 5. snapshot payload: dispatchEnabled false ────────────────────────────

  it('snapshot payload carries dispatchEnabled: false when allowDispatch=false', async () => {
    const { res } = await openSseAndDrainInitial(makeConfig(), { token: 'tok', allowDispatch: false });
    const allChunks = res._chunks().join('');
    const match = allChunks.match(/event: snapshot\ndata: (\{.*?\})\n/s);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload.dispatchEnabled).toBe(false);
  });

  // ── 6. snapshot payload: dispatchEnabled true ─────────────────────────────

  it('snapshot payload carries dispatchEnabled: true when allowDispatch=true', async () => {
    const { res } = await openSseAndDrainInitial(makeConfig(), { token: 'tok', allowDispatch: true });
    const allChunks = res._chunks().join('');
    const match = allChunks.match(/event: snapshot\ndata: (\{.*?\})\n/s);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1]);
    expect(payload.dispatchEnabled).toBe(true);
  });

  it('keeps raw agent prose out of the SSE snapshot payload', async () => {
    const rawCanary = 'RAW_CUSTOMER_STDOUT_CANARY_7f8a91 ordinary private text';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m213-privacy-'));
    const previous = process.env.ASHLR_HOME;
    process.env.ASHLR_HOME = home;
    try {
      recordAgentAction({
        schemaVersion: 1,
        ts: new Date().toISOString(),
        actor: 'daemon',
        kind: 'dispatch',
        outcome: 'no-proposal',
        action: 'daemon:dispatch',
        summary: rawCanary,
        repo: '/tmp/privacy-repo',
        itemId: 'privacy-item',
        source: 'todo',
        backend: 'codex',
        tier: 'frontier',
        reason: rawCanary,
        routeSnapshot: {
          backend: 'codex',
          tier: 'frontier',
          assignedBy: 'router',
          reason: rawCanary,
        },
        tags: [rawCanary],
      });
      const workspace = readAgentWorkspace({ repoScope: 'all' });
      vi.mocked(buildSnapshot).mockResolvedValueOnce({
        generatedAt: new Date().toISOString(),
        repos: [],
        runs: [],
        swarms: [],
        pulse: null,
        genome: [],
        inbox: { pending: 0 },
        fleet: { workspace },
        frontierUsage: null,
      } as any);

      const { res } = await openSseAndDrainInitial();
      const payload = res._chunks().join('');

      expect(payload).not.toContain(rawCanary);
      expect(payload).toContain('daemon:dispatch outcome=no-proposal backend=codex source=todo ref=');
      expect(payload).toContain('"proseDigest":"sha256:');
    } finally {
      if (previous === undefined) delete process.env.ASHLR_HOME;
      else process.env.ASHLR_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not overlap full snapshot builds when an SSE update is still in flight', async () => {
    vi.useFakeTimers();
    const mockedBuildSnapshot = vi.mocked(buildSnapshot);
    mockedBuildSnapshot.mockClear();
    let resolveSnapshot!: (value: any) => void;
    mockedBuildSnapshot.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));

    const req = makeReq('/api/events');
    const res = makeSseRes();
    await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mockedBuildSnapshot).toHaveBeenCalledTimes(1);

    resolveSnapshot({ generatedAt: new Date().toISOString() });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    mockedBuildSnapshot.mockResolvedValue({ generatedAt: new Date().toISOString() } as any);
  });

  it('shares one bounded run/swarm projection across concurrent SSE clients', async () => {
    vi.useFakeTimers();
    const orchestrator = await import('../src/core/run/orchestrator.js');
    const swarmStore = await import('../src/core/swarm/store.js');
    const mockedListRuns = vi.mocked(orchestrator.listRuns);
    const mockedListSwarms = vi.mocked(swarmStore.listSwarms);
    mockedListRuns.mockClear();
    mockedListSwarms.mockClear();

    const first = makeSseRes();
    const second = makeSseRes();
    await handleApi(makeReq('/api/events'), first, makeConfig() as any, BASE_CTX);
    await handleApi(makeReq('/api/events'), second, makeConfig() as any, BASE_CTX);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mockedListRuns).toHaveBeenCalledTimes(1);
    expect(mockedListRuns).toHaveBeenCalledWith({ limit: 20 });
    expect(mockedListSwarms).toHaveBeenCalledTimes(1);
    expect(mockedListSwarms).toHaveBeenCalledWith({ limit: 20 });
  });

  // ── 7a–e. Existing named events still emitted ────────────────────────────

  it('still emits "runs" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: runs\n');
  });

  it('still emits "swarms" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: swarms\n');
  });

  it('still emits "inbox" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: inbox\n');
  });

  it('still emits "daemon" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: daemon\n');
  });

  it('still emits "fleet-activity-ping" named event', async () => {
    const { res } = await openSseAndDrainInitial();
    expect(res._chunks().join('')).toContain('event: fleet-activity-ping\n');
  });

  it('emits degraded daemon and activity observations without stopped or zero claims', async () => {
    const { readFleetDaemonStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(readFleetDaemonStatus).mockResolvedValueOnce({
      daemon: {
        running: false,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unreadable' },
        pid: null,
        startedAt: null,
        lastTickAt: null,
        todaySpentUsd: 0,
      },
      recentTicks: [],
    } as any);
    vi.mocked(buildSnapshot).mockResolvedValueOnce({
      generatedAt: new Date().toISOString(),
      daemonObservation: {
        runtimeState: 'unknown',
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unreadable' },
        running: null,
        pid: null,
        startedAt: null,
        lastTickAt: null,
        todayDate: null,
        todaySpentUsd: null,
        itemsProcessed: null,
        ticks: null,
        pendingProposals: 0,
      },
    } as any);
    const { res } = await openSseAndDrainInitial();

    expect(ssePayload(res._chunks(), 'daemon-observation')).toMatchObject({
      runtimeState: 'unknown',
      running: null,
      todaySpentUsd: null,
      itemsProcessed: null,
      ticks: null,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reason: 'unreadable',
      },
    });
    expect(ssePayload(res._chunks(), 'fleet-activity-observation')).toMatchObject({
      runtimeState: 'unknown',
      running: null,
      lastTickAt: null,
      tickCount: null,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reason: 'unreadable',
      },
    });
    expect(ssePayload(res._chunks(), 'daemon')).toMatchObject({
      running: false,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    expect(ssePayload(res._chunks(), 'fleet-activity-ping')).toEqual({
      running: false,
      lastTickAt: null,
      tickCount: 0,
    });
  });

  it('returns an explicit unknown daemon observation from its additive endpoint', async () => {
    const { readFleetDaemonStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(readFleetDaemonStatus).mockResolvedValueOnce({
      daemon: {
        running: false,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'malformed' },
        pid: null,
        startedAt: null,
        lastTickAt: null,
        todaySpentUsd: 0,
      },
      recentTicks: [],
    } as any);
    const res = makeJsonRes();
    const handled = await handleApi(
      makeReq('/api/daemon-observation'),
      res,
      makeConfig() as any,
      BASE_CTX,
    );

    expect(handled).toBe(true);
    expect(res._status()).toBe(200);
    expect(res._body()).toMatchObject({
      runtimeState: 'unknown',
      running: null,
      todaySpentUsd: null,
      itemsProcessed: null,
      ticks: null,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reason: 'malformed',
      },
    });
  });

  it('keeps GET /api/daemon and legacy SSE events shape-compatible when authority is unknown', async () => {
    const { readFleetDaemonStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(readFleetDaemonStatus).mockResolvedValueOnce({
      daemon: {
        running: false,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'inconsistent' },
        pid: null,
        startedAt: null,
        lastTickAt: null,
        todaySpentUsd: 0,
      },
      recentTicks: [],
    } as any);
    const res = makeJsonRes();
    await handleApi(makeReq('/api/daemon'), res, makeConfig() as any, BASE_CTX);

    expect(res._body()).toEqual({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
  });

  it('replaces cached daemon health with fresh provenance without changing the legacy shape', async () => {
    const { readFleetDaemonStatus } = await import('../src/core/fleet/status.js');
    vi.mocked(readFleetDaemonStatus).mockClear();
    vi.mocked(readFleetDaemonStatus).mockResolvedValueOnce({
      daemon: {
        running: false,
        sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unreadable' },
        pid: null,
        startedAt: null,
        lastTickAt: null,
        todaySpentUsd: 0,
      },
      recentTicks: [],
    } as any);
    const staleSnapshot = {
      generatedAt: new Date().toISOString(),
      inbox: { pending: 2 },
      daemon: { running: true, todaySpentUsd: 4.2, pendingProposals: 2 },
      daemonObservation: {
        observedAt: '2026-07-25T00:00:00.000Z',
        runtimeState: 'running',
        sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
        running: true,
        pid: 42,
        startedAt: '2026-07-25T00:00:00.000Z',
        lastTickAt: '2026-07-25T00:01:00.000Z',
        todayDate: '2026-07-25',
        todaySpentUsd: 4.2,
        itemsProcessed: 9,
        ticks: [],
        pendingProposals: 2,
      },
    } as any;
    let resolveSnapshot!: (value: typeof staleSnapshot) => void;
    vi.mocked(buildSnapshot).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSnapshot = resolve;
    }));
    const res = makeJsonRes();
    const pending = handleApi(makeReq('/api/snapshot'), res, makeConfig() as any, BASE_CTX);
    await Promise.resolve();
    expect(readFleetDaemonStatus).not.toHaveBeenCalled();
    resolveSnapshot(staleSnapshot);
    await pending;
    expect(readFleetDaemonStatus).toHaveBeenCalledTimes(1);

    const body = res._body() as Record<string, unknown>;
    expect(body['daemonObservation']).toMatchObject({
      runtimeState: 'unknown',
      running: null,
      todaySpentUsd: null,
      itemsProcessed: null,
      sourceQuality: { sourceState: 'degraded', complete: false, reason: 'unreadable' },
    });
    expect(body['daemon']).toEqual({
      running: false,
      todaySpentUsd: 0,
      pendingProposals: 2,
    });
  });

  it('keeps GET /api/logs array-compatible and exposes degraded provenance additively', async () => {
    const control = await import('../src/core/web/control.js');
    const degradedLogs = {
      logs: null,
      logsSourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reason: 'unreadable',
      },
    } as any;
    vi.mocked(control.buildControlSnapshot)
      .mockResolvedValueOnce(degradedLogs)
      .mockResolvedValueOnce(degradedLogs);
    const res = makeJsonRes();

    await handleApi(makeReq('/api/logs'), res, makeConfig() as any, BASE_CTX);
    expect(res._body()).toEqual([]);

    const observationRes = makeJsonRes();
    await handleApi(
      makeReq('/api/logs-observation'),
      observationRes,
      makeConfig() as any,
      BASE_CTX,
    );
    expect(observationRes._body()).toEqual({
      entries: null,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reason: 'unreadable',
      },
    });
  });

  // ── 8. drainSseConnections closes all connections ─────────────────────────

  it('drainSseConnections() ends the SSE response', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events');
    const res = makeSseRes();
    await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(res._ended()).toBe(false);
    drainSseConnections();
    expect(res._ended()).toBe(true);
  });

  // ── 9. POST /api/events → 404 (not a mutation route) ─────────────────────

  it('POST /api/events returns 404 (handled=true, not a mutation route)', async () => {
    vi.useFakeTimers();
    const req = makeReq('/api/events', 'POST');
    const res = makeJsonRes();
    const handled = await handleApi(req, res as unknown as ServerResponse, makeConfig() as any, BASE_CTX);
    expect(handled).toBe(true);
    expect(res._status()).toBe(404);
  });

  // ── 10. server.ts binds to 127.0.0.1 only ────────────────────────────────

  it('server.ts binds exclusively to 127.0.0.1 (loopback only)', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/server.ts'),
      'utf8',
    );
    expect(src).toContain('HOST_RE');
    expect(src).toContain('127.0.0.1');
    expect(src).toContain('localhost');
    // The listen call must specify 127.0.0.1 as the bind address
    expect(src).toContain("server.listen(opts.port, '127.0.0.1'");
  });

  // ── 11. app.js: snapshot SSE handler suppresses polling interval ──────────

  it('app.js snapshot SSE handler suppresses polling only for a fresh snapshot', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain("es.addEventListener('snapshot'");
    expect(src).toContain('state.fleetDashboard = data');
    const snapshotHandlerMatch = src.match(/es\.addEventListener\('snapshot'[\s\S]*?\}\);/);
    expect(snapshotHandlerMatch).not.toBeNull();
    expect(snapshotHandlerMatch![0]).toContain('fleetSnapshotLearningFresh(data)');
    expect(snapshotHandlerMatch![0]).toContain('if (learningFresh) stopFleetDashboardPolling()');
    expect(snapshotHandlerMatch![0]).toContain('else startFleetDashboardPolling()');
  });

  it('app.js consumes additive daemon provenance while retaining legacy SSE compatibility', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain("es.addEventListener('daemon'");
    expect(src).toContain("es.addEventListener('daemon-observation'");
    expect(src).toContain("apiFetch('/api/daemon-observation')");
  });

  // ── 12. app.js: SSE error handler restores polling fallback ──────────────

  it('app.js SSE error handler restarts the polling fallback interval', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('SSE dropped — restart polling fallback');
    const errorHandlerMatch = src.match(/es\.addEventListener\('error'[\s\S]*?\}\);/);
    expect(errorHandlerMatch).not.toBeNull();
    expect(errorHandlerMatch![0]).toContain('startFleetDashboardPolling()');
  });

  it('app.js bounds snapshot freshness and restarts polling while EventSource remains open', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-07-22T12:00:00.000Z');
    vi.setSystemTime(now);
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const helpersStart = src.indexOf('function fleetSnapshotLearningFresh(snapshot, nowMs = Date.now())');
    const helpersEnd = src.indexOf('\nasync function loadFleetDashboard()', helpersStart);
    expect(helpersStart).toBeGreaterThanOrEqual(0);
    expect(helpersEnd).toBeGreaterThan(helpersStart);

    const state = {
      activeView: 'fleet-dashboard',
      fleetDashboard: { generatedAt: new Date(now).toISOString() },
      fleetDashboardInterval: null as ReturnType<typeof setInterval> | null,
      fleetSnapshotWatchdog: null as ReturnType<typeof setInterval> | null,
      fleetSnapshotStale: false,
    };
    const loadFleetDashboard = vi.fn();
    const renderFleetDashboard = vi.fn();
    const helpers = new Function(
      'state', 'fdLoadSettings', 'loadFleetDashboard', 'renderFleetDashboard',
      'FD_SNAPSHOT_MAX_AGE_MS', 'FD_SNAPSHOT_MAX_FUTURE_SKEW_MS',
      'FD_SNAPSHOT_WATCHDOG_MS', 'FD_DEFAULT_SETTINGS',
      `${src.slice(helpersStart, helpersEnd)}\nreturn { fleetSnapshotLearningFresh, ensureFleetSnapshotWatchdog };`,
    )(
      state,
      () => ({ refreshSecs: 15 }),
      loadFleetDashboard,
      renderFleetDashboard,
      30_000,
      5_000,
      5_000,
      { refreshSecs: 15 },
    ) as {
      fleetSnapshotLearningFresh: (snapshot: unknown, nowMs?: number) => boolean;
      ensureFleetSnapshotWatchdog: () => void;
    };

    expect(helpers.fleetSnapshotLearningFresh(
      { generatedAt: new Date(now - 30_000).toISOString() }, now,
    )).toBe(true);
    expect(helpers.fleetSnapshotLearningFresh(
      { generatedAt: new Date(now - 30_001).toISOString() }, now,
    )).toBe(false);
    expect(helpers.fleetSnapshotLearningFresh(
      { generatedAt: new Date(now + 5_001).toISOString() }, now,
    )).toBe(false);
    expect(helpers.fleetSnapshotLearningFresh({ generatedAt: 'invalid' }, now)).toBe(false);

    helpers.ensureFleetSnapshotWatchdog();
    const watchdog = state.fleetSnapshotWatchdog;
    helpers.ensureFleetSnapshotWatchdog();
    expect(state.fleetSnapshotWatchdog).toBe(watchdog);
    vi.advanceTimersByTime(30_000);
    expect(state.fleetDashboardInterval).toBeNull();
    vi.advanceTimersByTime(5_000);
    expect(state.fleetSnapshotStale).toBe(true);
    expect(state.fleetDashboardInterval).not.toBeNull();
    expect(renderFleetDashboard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(loadFleetDashboard).toHaveBeenCalledTimes(1);
  });

  // ── 13. app.js: Fleet Dashboard includes visibility panel ────────────────

  it('app.js wires the M262 visibility panel into Fleet Dashboard settings and panelDefs', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function fdRenderVisibilityPanel');
    expect(src).toContain("visibility: 'Visibility'");
    expect(src).toContain("key: 'visibility'");
    expect(src).toContain('snap.visibility');
  });

  it('app.js surfaces proposal production in Fleet, Mission Control, and Fleet Dashboard', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function renderProposalProductionCard');
    expect(src).toContain('function renderDispatchProductionCard');
    expect(src).toContain('function renderAttemptCoverageCard');
    expect(src).toContain('function renderLearningMetricsUnavailableCard');
    expect(src).toContain('function learningMetricsAvailabilityText');
    expect(src).toContain('function renderPhantomAgentReportCard');
    expect(src).toContain('function formatCountMap');
    expect(src).toContain('function dispatchProductionDiagnosticAttempts');
    expect(src).toContain('function generatedWorkMetric');
    expect(src).toContain('function diagnosticResliceDrainMetric');
    expect(src).toContain('function generatedRepairRecoveryMetric');
    expect(src).toContain('function fleetRepairRecoveryMetric');
    expect(src).toContain('if (!dispatchProductionSourceHealthy(source)) return null');
    expect(src).toContain('generated-repair-recovery-active');
    expect(src).toContain('repair recovery -> learning');
    expect(src).toContain("'Repair Loop'");
    expect(src).toContain('fdMetricPill(\'Repair Loop\'');
    expect(src).toContain('Repair recovery');
    expect(src).toContain('captureRepairs');
    expect(src).toContain('diagnosticReslices');
    expect(src).toContain('function renderMissionBriefCard');
    expect(src).toContain('function renderNextActionCommand');
    expect(src).toContain('fleet-command-rail');
    expect(src).toContain('Next: ${compactFleetReason(actionDetail)}');
    expect(src).toContain('function formatAttemptShape');
    expect(src).toContain('gate/capture');
    expect(src).toContain('Dispatch yield data unavailable.');
    expect(src).toContain("renderMissionBriefCard(f.missionBrief, 'fleet-card card')");
    expect(src).toContain('renderMissionBriefCard(missionBrief)');
    expect(src).toContain('missionBrief');
    expect(src).toContain("renderProposalProductionCard(f.proposalProduction, 'fleet-card card')");
    expect(src).toContain('renderDispatchProductionCard(\n    f.dispatchProduction,\n    f.dispatchProductionSource,');
    expect(src).toContain('function dispatchProductionSourceText');
    expect(src).toContain("return source?.sourceState === 'healthy' && source.complete === true");
    expect(src).toContain("['Source', dispatchProductionSourceText(sourceQuality)]");
    expect(src).toContain('const attemptCoverage = learningSnapshotFresh && dispatchProductionSourceHealthy(f.dispatchProductionSource)');
    expect(src).toContain("attemptCoverage, 'fleet-card card', f.learningMetrics?.attemptCoverage, f.learningMetrics");
    expect(src).toContain("renderLearningMetricsUnavailableCard(f.learningMetrics, 'fleet-card card')");
    expect(src).toContain("['Generated work', generatedWorkMetric(f.queue?.generatedWork) ?? '—']");
    expect(src).toContain("['Diagnostic drain', diagnosticResliceDrainMetric(f.queue?.diagnosticResliceDrain) ?? '—']");
    expect(src).toContain('renderProposalProductionCard(production)');
    expect(src).toContain("attemptCoverage, 'ctrl-card card', learningMetrics?.attemptCoverage, learningMetrics");
    expect(src).toContain('renderLearningMetricsUnavailableCard(learningMetrics)');
    expect(src).toContain('renderPhantomAgentReportCard(f.phantom');
    expect(src).toContain('renderPhantomAgentReportCard(d.fleet?.phantom');
    expect(src).toContain('delegationSafety');
    expect(src).toContain("'Delegation unsafe'");
    expect(src).toContain("'Phantom delegation'");
    expect(src).toContain('attemptCoverage.causalCoverage');
    expect(src).toContain("'Attempt coverage'");
    expect(src).toContain("'Current labels'");
    expect(src).toContain("controlMetric('No-prop 24h'");
    expect(src).toContain('queue.generatedWork.total ?? 0');
    expect(src).toContain("controlMetric('Diag Drain'");
    expect(src).toContain("fdMetricPill('Generated'");
    expect(src).toContain("fdMetricPill('Diag Drain'");
    expect(src).toContain('production.diagnosticNoProposalDispatches ?? production.noProposalDispatches');
    expect(src).toContain("controlMetric(\n      'Yield 24h'");
    expect(src).toContain("snap.fleet?.proposalProduction ?? snap.control?.fleet?.proposalProduction");
    expect(src).toContain("snap.fleet?.dispatchProduction ?? snap.control?.fleet?.dispatchProduction");
    expect(src).toContain("snap.fleet?.dispatchProductionSource ?? snap.control?.fleet?.dispatchProductionSource");
    expect(src).toContain("snap.fleet?.attemptCoverage ?? snap.control?.fleet?.attemptCoverage");
    expect(src).toContain("'Proposal production'");
    expect(src).toContain("'Dispatch yield'");
    expect(src).toContain("['Suppressed', suppressed]");
    expect(src).toContain('function dispatchProductionWeakestBackend(backends)');
    expect(src).toContain('.filter((candidate) => dispatchProductionDiagnosticAttempts(candidate) > 0)');
    expect(src).toContain('dispatchProductionDiagnosticRate(left) - dispatchProductionDiagnosticRate(right)');
    expect(src).toContain('if (!dispatchProduction || !sourceHealthy)');
    expect(src.match(/if \(dispatchProduction && dispatchProductionSourceHealthy\(dispatchProductionSource\)\)/g))
      .toHaveLength(1);
    expect(src).toContain('if (learningSnapshotFresh && dispatchProduction && dispatchProductionSourceHealthy(dispatchProductionSource))');
    expect(src).toContain("if (!metric || typeof metric !== 'object') return 'withheld'");
  });

  it('withholds learning rates when the dispatch denominator is degraded or missing', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const start = src.indexOf('function learningMetricsAvailabilityText(source)');
    const end = src.indexOf('\nfunction renderLearningMetricsUnavailableCard', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const format = new Function(
      `${src.slice(start, end)}\nreturn learningMetricsAvailabilityText;`,
    )() as (source: Record<string, unknown>) => string;

    expect(format({
      state: 'withheld', reason: 'dispatch-source-missing', sourceQuality: {},
    })).toBe('withheld: dispatch denominator missing');
    expect(format({
      state: 'withheld', reason: 'dispatch-source-degraded',
      sourceQuality: { invalidRows: 4, unreadableFiles: 1, stopReasons: ['row-limit'] },
    })).toBe('withheld: dispatch denominator degraded; 4 invalid row(s); 1 unreadable file(s); stopped: row-limit');
    expect(format({
      state: 'withheld', reason: 'learning-snapshot-unstable', sourceQuality: {},
    })).toBe('withheld: cross-source snapshot changed during read');
    expect(format({
      state: 'withheld', reason: 'learning-snapshot-settling', sourceQuality: {},
    })).toBe('withheld: dispatch rows are still settling');

    const metricStart = src.indexOf('function formatCoverageMetric(metric)');
    const metricEnd = src.indexOf('\nfunction learningMetricsAvailabilityText', metricStart);
    const formatMetric = new Function(
      `${src.slice(metricStart, metricEnd)}\nreturn formatCoverageMetric;`,
    )() as (metric?: Record<string, number>) => string;
    expect(formatMetric()).toBe('withheld');

    const healthStart = src.indexOf('function dispatchProductionSourceHealthy(source)');
    const healthEnd = src.indexOf('\nfunction workspaceSourceHealthy', healthStart);
    const sourceHealthy = new Function(
      `${src.slice(healthStart, healthEnd)}\nreturn dispatchProductionSourceHealthy;`,
    )() as (source?: { sourceState: string; complete: boolean }) => boolean;
    expect(sourceHealthy()).toBe(false);
    expect(sourceHealthy({ sourceState: 'missing', complete: false })).toBe(false);
    expect(sourceHealthy({ sourceState: 'degraded', complete: false })).toBe(false);
    expect(sourceHealthy({ sourceState: 'healthy', complete: true })).toBe(true);

    const panelStart = src.indexOf('function fdRenderProductionPanel(snap)');
    const panelEnd = src.indexOf('\nfunction fdRenderIntelligencePanel', panelStart);
    type FakeNode = { children: unknown[]; appendChild: (child: unknown) => unknown };
    const node = (...children: unknown[]): FakeNode => ({
      children,
      appendChild(child: unknown) { this.children.push(child); return child; },
    });
    const renderPanel = new Function(
      'el', 'infoGrid', 'dispatchProductionSourceHealthy', 'dispatchProductionSourceText',
      'fleetSnapshotLearningFresh', 'learningSettlementText',
      `${src.slice(panelStart, panelEnd)}\nreturn fdRenderProductionPanel;`,
    )(
      (_tag: string, _attrs: unknown, ...children: unknown[]) => node(...children),
      (rows: unknown[][]) => node(...rows.flat()),
      sourceHealthy,
      (source?: { sourceState?: string }) => source?.sourceState ?? 'unknown',
      () => true,
      () => null,
    ) as (snap: Record<string, unknown>) => FakeNode;
    const rendered = renderPanel({
      fleet: {
        dispatchProductionSource: { sourceState: 'degraded', complete: false },
        dispatchProduction: {
          attempts: 2, proposalsCreated: 0, diagnosticNoProposal: 2,
          diagnosticProposalRate: 0, byBackend: [{ backend: 'local', attempts: 2, proposalsCreated: 0 }],
        },
      },
    });
    const flatten = (value: unknown): string => value && typeof value === 'object' && 'children' in value
      ? (value as FakeNode).children.map(flatten).join(' ')
      : String(value ?? '');
    const renderedText = flatten(rendered);
    expect(renderedText).toContain('degraded');
    expect(renderedText).not.toContain('0/2');
    expect(renderedText).not.toContain('Attempts');
    expect(renderedText).not.toContain('No-proposal');
    expect(renderedText).not.toContain('0%');

    const renderStalePanel = new Function(
      'el', 'infoGrid', 'dispatchProductionSourceHealthy', 'dispatchProductionSourceText',
      'fleetSnapshotLearningFresh', 'learningSettlementText',
      `${src.slice(panelStart, panelEnd)}\nreturn fdRenderProductionPanel;`,
    )(
      (_tag: string, _attrs: unknown, ...children: unknown[]) => node(...children),
      (rows: unknown[][]) => node(...rows.flat()),
      sourceHealthy,
      (source?: { sourceState?: string }) => source?.sourceState ?? 'unknown',
      () => false,
      () => null,
    ) as (snap: Record<string, unknown>) => FakeNode;
    const staleText = flatten(renderStalePanel({
      generatedAt: '2026-07-22T00:00:00.000Z',
      production: {
        proposals24h: { applied: 4, pending: 1, rejected: 2 },
        judgeVerdicts24h: { ship: 3, review: 2, noise: 1, harmful: 1 },
        autoMergesToday: { count: 0, titles: [] },
        activeGoals: [],
        shipsPerDayTrend: [],
      },
      fleet: {
        proposalProduction: {
          selected: 4, dispatched: 3, proposalsCreated: 2,
          diagnosticNoProposalDispatches: 1, suppressedDispatches: 1, errors: 0,
        },
        dispatchProductionSource: { sourceState: 'healthy', complete: true },
        dispatchProduction: {
          attempts: 2, proposalsCreated: 0, diagnosticNoProposal: 2,
          diagnosticProposalRate: 0, byBackend: [{ backend: 'local', attempts: 2, proposalsCreated: 0 }],
        },
        attemptCoverage: { attempts: 2 },
        trajectoryLearning: { trajectories: 2 },
        workspace: { eventCount: 2, diagnosticProposalRate: 0 },
      },
    }));
    expect(staleText).toContain('Exact learning metrics withheld');
    expect(staleText).toContain('stale snapshot Yield withheld');
    expect(staleText).not.toContain('0/2');
    expect(staleText).not.toContain('Attempt coverage');
    expect(staleText).not.toContain('Trajectory learning');
    expect(staleText).not.toContain('Global workspace');
    expect(staleText).not.toContain('Proposal production');
    expect(staleText).not.toContain('Judge verdicts');
    expect(staleText).toContain('Proposals (24h)');

    const intelligenceStart = src.indexOf('function fdRenderIntelligencePanel(snap)');
    const intelligenceEnd = src.indexOf('\nfunction fdRenderVisibilityPanel', intelligenceStart);
    expect(intelligenceStart).toBeGreaterThanOrEqual(0);
    expect(intelligenceEnd).toBeGreaterThan(intelligenceStart);
    const renderStaleIntelligence = new Function(
      'el', 'fleetSnapshotLearningFresh',
      `${src.slice(intelligenceStart, intelligenceEnd)}\nreturn fdRenderIntelligencePanel;`,
    )(
      (_tag: string, _attrs: unknown, ...children: unknown[]) => node(...children),
      () => false,
    ) as (snap: Record<string, unknown>) => FakeNode;
    const staleIntelligenceText = flatten(renderStaleIntelligence({
      intelligence: {
        engineScorecards: [{ engine: 'codex', ship: 3, review: 1, noise: 0, harmful: 0, shipRate: 0.75 }],
        routingScores: [{ engine: 'codex', taskClass: 'code', score: 0.75, trend: 'promoted', samples: 8 }],
        antiPlaybooks: [{ title: 'Old lesson', snippet: 'stale', ts: '2026-07-22T00:00:00.000Z' }],
      },
    }));
    expect(staleIntelligenceText).toContain('exact intelligence metrics withheld');
    expect(staleIntelligenceText).not.toContain('Engine scorecards');
    expect(staleIntelligenceText).not.toContain('Learned routing');
    expect(staleIntelligenceText).not.toContain('Anti-playbooks');
    expect(staleIntelligenceText).not.toContain('75%');

    const renderFreshIntelligence = new Function(
      'el', 'fleetSnapshotLearningFresh',
      `${src.slice(intelligenceStart, intelligenceEnd)}\nreturn fdRenderIntelligencePanel;`,
    )(
      (_tag: string, _attrs: unknown, ...children: unknown[]) => node(...children),
      () => true,
    ) as (snap: Record<string, unknown>) => FakeNode;
    const healthySources = {
      decisions: { sourceState: 'healthy', sourcePresent: true, complete: true, authenticated: false },
      assignments: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        denominatorComplete: false, authenticated: true,
      },
    };
    const healthyDecisionSource = {
      sourceState: 'healthy', sourcePresent: true, complete: true,
      stopReasons: [], filesRead: 1, bytesRead: 0, rowsScanned: 8,
      invalidRows: 0, unreadableFiles: 0,
    };
    const observationalText = flatten(renderFreshIntelligence({
      intelligence: {
        engineScorecards: [],
        decisionSourceQuality: healthyDecisionSource,
        routingLearningAuthority: {
          state: 'inactive', operationalSteering: false,
          sourceQuality: healthySources,
          samples: { observed: 8, eligible: 0, minimumPerStratum: 5 },
          cohort: { policyVersion: null, learningEpoch: null },
          blockerCodes: ['decision-authenticity-unavailable'],
        },
        routingScores: [{ engine: 'codex', model: null, taskClass: 'code', score: 0.75, trend: 'observational', samples: 8 }],
        antiPlaybooks: [], recentEvents: [],
      },
    }));
    expect(observationalText).toContain('Routing learning authority');
    expect(observationalText).toContain('inactive; runtime routing is neutral');
    expect(observationalText).toContain('source quality: healthy');
    expect(observationalText).toContain('Observational routing scores');
    expect(observationalText).toContain('obs');
    expect(observationalText).not.toContain('Operational routing scores');
    expect(observationalText).not.toContain('▲');
    expect(observationalText).not.toContain('▼');

    const healthyZeroText = flatten(renderFreshIntelligence({
      intelligence: {
        decisionSourceQuality: { ...healthyDecisionSource, rowsScanned: 0 },
        routingLearningAuthority: {
          state: 'inactive', operationalSteering: false,
          sourceQuality: healthySources,
          samples: { observed: 0, eligible: 0, minimumPerStratum: 5 },
          cohort: { policyVersion: null, learningEpoch: null }, blockerCodes: [],
        },
        engineScorecards: [], routingScores: [], antiPlaybooks: [], recentEvents: [],
      },
    }));
    expect(healthyZeroText).toContain('source quality: healthy zero');
    expect(healthyZeroText).toContain('0 observed / 0 eligible');
    expect(healthyZeroText).toContain('sources are healthy with zero admitted observations');

    const degradedText = flatten(renderFreshIntelligence({
      intelligence: {
        decisionSourceQuality: healthyDecisionSource,
        routingLearningAuthority: {
          state: 'inactive', operationalSteering: false,
          sourceQuality: {
            ...healthySources,
            assignments: { ...healthySources.assignments, sourceState: 'degraded', complete: false },
          },
          samples: { observed: 0, eligible: 0, minimumPerStratum: 5 },
          cohort: { policyVersion: null, learningEpoch: null },
          blockerCodes: ['assignment-source-degraded'],
        },
        engineScorecards: [], routingScores: [], antiPlaybooks: [], recentEvents: [],
      },
    }));
    expect(degradedText).toContain('source quality: degraded');
    expect(degradedText).toContain('sample counts withheld');
    expect(degradedText).toContain('scores withheld because routing learning sources are degraded');
    expect(degradedText).not.toContain('healthy with zero admitted observations');

    const betweenReadsDegradedText = flatten(renderFreshIntelligence({
      intelligence: {
        decisionSourceQuality: {
          ...healthyDecisionSource,
          sourceState: 'degraded', complete: false, invalidRows: 1,
        },
        routingLearningAuthority: {
          state: 'inactive', operationalSteering: false,
          sourceQuality: healthySources,
          samples: { observed: 0, eligible: 0, minimumPerStratum: 5 },
          cohort: { policyVersion: null, learningEpoch: null }, blockerCodes: [],
        },
        engineScorecards: [],
        routingScores: [{ engine: 'codex', model: null, taskClass: 'code', score: 0.75, trend: 'observational', samples: 8 }],
        antiPlaybooks: [], recentEvents: [],
      },
    }));
    expect(betweenReadsDegradedText).toContain('source quality: degraded');
    expect(betweenReadsDegradedText).toContain('sample counts withheld');
    expect(betweenReadsDegradedText).toContain('scores withheld because routing learning sources are degraded');
    expect(betweenReadsDegradedText).not.toContain('healthy zero');
    expect(betweenReadsDegradedText).not.toContain('75%');
  });

  it('withholds stale learning metrics in Fleet and Mission Control as well as Fleet Dashboard', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain(
      "const learningSnapshotFresh = fleetSnapshotLearningFresh({ generatedAt: state.fleetObservedAt });",
    );
    expect(src).toContain('const learningSnapshotFresh = fleetSnapshotLearningFresh(d);');
    expect(src).toContain("else if (state.activeView === 'control')");
    expect(src).toContain("else if (state.activeView === 'fleet')");
    expect(src).toContain("section.appendChild(renderStaleLearningSnapshotCard('fleet-card card'))");
    expect(src).toContain('section.appendChild(renderStaleLearningSnapshotCard());');
    expect(src).toContain('const learningDenominatorHealthy = learningSnapshotFresh &&');
    expect(src).toContain('if (learningSnapshotFresh && production)');
  });

  it('app.js renders activity evidence without a misleading healthy zero', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('function daemonActivityDisplay');
    expect(src).toContain("return 'activity unavailable'");
    expect(src).toContain('activity.ownerState');
    expect(src).toContain('children active');
    expect(src).toContain('d.fleet?.daemon ?? fleet.daemon ?? daemon');
    expect(src).not.toContain("['Child work',");
    expect(src).not.toContain("'none observed'");
  });

  it('CLI renders degraded autonomy evidence as partial authority, never an empty healthy store', async () => {
    const { formatFleetStatus } = await import('../src/cli/fleet.js');
    const rendered = formatFleetStatus({
      generatedAt: '2026-07-16T12:00:00.000Z',
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      autonomy: {
        evidencePacks: 0,
        latestAt: null,
        allowed: 0,
        denied: 0,
        byTier: {},
        recent: [],
        authorityState: 'degraded',
        protocols: { sealedV3: 0, legacy: 0 },
        sourceQuality: {
          sourceState: 'degraded',
          sourcePresent: true,
          complete: false,
          filesRead: 2,
          bytesRead: 2048,
          invalidFiles: 1,
          unreadableFiles: 2,
          limitExceeded: true,
        },
      },
      killed: false,
    } as any);

    expect(rendered).toContain('authority: degraded');
    expect(rendered).toContain('protocols: v3=0, legacy=0');
    expect(rendered).toContain('source:    degraded (partial, present=yes)');
    expect(rendered).toContain('read:      2 file(s), 2048 byte(s), 1 invalid, 2 unreadable, limit exceeded');
    expect(rendered).not.toContain('no evidence packs yet');
  });

  it('app.js gives degraded, cold-start, and ready evidence distinct render contracts', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const start = src.indexOf('function autonomyAuthorityState(autonomy)');
    const end = src.indexOf('\nfunction compactFleetReason', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const helperSource = src.slice(start, end);
    const helpers = new Function(
      `${helperSource}\nreturn { autonomyAuthorityState, autonomyEvidenceMetric, autonomyEvidenceHeroMetric, autonomyEvidenceProtocolsMetric, ` +
        'autonomyEvidenceSourceMetric, autonomyEvidenceDiagnosticsMetric, autonomyEvidenceReadMetric, ' +
        'autonomyEvidenceAccent, autonomyEvidenceToneClass };',
    )() as Record<string, (autonomy: Record<string, any>) => string>;

    const degraded = {
      evidencePacks: 0,
      allowed: 0,
      denied: 0,
      authorityState: 'degraded',
      protocols: { sealedV3: 0, legacy: 0 },
      sourceQuality: {
        sourceState: 'degraded', sourcePresent: true, complete: false,
        filesRead: 2, bytesRead: 2048, invalidFiles: 1, unreadableFiles: 2, limitExceeded: true,
      },
    };
    expect(helpers.autonomyAuthorityState!(degraded)).toBe('degraded');
    expect(helpers.autonomyEvidenceMetric!(degraded)).toBe('degraded / 0 observed');
    expect(helpers.autonomyEvidenceHeroMetric!(degraded)).toBe('degraded · 0');
    expect(helpers.autonomyEvidenceProtocolsMetric!(degraded)).toBe('0 v3 / 0 legacy');
    expect(helpers.autonomyEvidenceSourceMetric!(degraded)).toBe('degraded / partial');
    expect(helpers.autonomyEvidenceDiagnosticsMetric!(degraded))
      .toBe('1 invalid / 2 unreadable / limit exceeded');
    expect(helpers.autonomyEvidenceReadMetric!(degraded)).toBe('2 files / 2048 bytes');
    expect(helpers.autonomyEvidenceAccent!(degraded)).toBe('#f87171');
    expect(helpers.autonomyEvidenceToneClass!(degraded)).toBe('fd-meta-val--fail');
    expect(helpers.autonomyEvidenceMetric!(degraded)).not.toBe('0 packs');

    const coldStart = {
      evidencePacks: 0,
      allowed: 0,
      denied: 0,
      authorityState: 'cold-start',
      protocols: { sealedV3: 0, legacy: 0 },
      sourceQuality: {
        sourceState: 'missing', sourcePresent: false, complete: true,
        filesRead: 0, bytesRead: 0, invalidFiles: 0, unreadableFiles: 0, limitExceeded: false,
      },
    };
    expect(helpers.autonomyEvidenceMetric!(coldStart)).toBe('cold-start / 0 packs');
    expect(helpers.autonomyEvidenceHeroMetric!(coldStart)).toBe('cold-start · 0');
    expect(helpers.autonomyEvidenceAccent!(coldStart)).toBe('#fbbf24');
    expect(helpers.autonomyEvidenceToneClass!(coldStart)).toBe('fd-meta-val--warn');

    const ready = {
      evidencePacks: 3,
      allowed: 3,
      denied: 0,
      authorityState: 'ready',
      protocols: { sealedV3: 2, legacy: 1 },
      sourceQuality: {
        sourceState: 'healthy', sourcePresent: true, complete: true,
        filesRead: 3, bytesRead: 4096, invalidFiles: 0, unreadableFiles: 0, limitExceeded: false,
      },
    };
    expect(helpers.autonomyEvidenceMetric!(ready)).toBe('ready / 3 packs');
    expect(helpers.autonomyEvidenceHeroMetric!(ready)).toBe('ready · 3');
    expect(helpers.autonomyEvidenceProtocolsMetric!(ready)).toBe('2 v3 / 1 legacy');
    expect(helpers.autonomyEvidenceAccent!(ready)).toBe('#38bdf8');
    expect(helpers.autonomyEvidenceToneClass!(ready)).toBeNull();

    const missingDiagnostics = { ...ready, sourceQuality: undefined };
    expect(helpers.autonomyAuthorityState!(missingDiagnostics)).toBe('unavailable');
    expect(helpers.autonomyEvidenceAccent!(missingDiagnostics)).toBe('#94a3b8');
    expect(helpers.autonomyEvidenceToneClass!(missingDiagnostics)).toBe('fd-meta-val--warn');

    const inconsistentPartial = {
      ...ready,
      sourceQuality: { ...ready.sourceQuality, complete: false },
    };
    expect(helpers.autonomyAuthorityState!(inconsistentPartial)).toBe('degraded');
    expect(helpers.autonomyEvidenceAccent!(inconsistentPartial)).toBe('#f87171');
    expect(helpers.autonomyEvidenceToneClass!(inconsistentPartial)).toBe('fd-meta-val--fail');

    expect(src).toContain("controlMetric('Evidence authority', autonomyEvidenceHeroMetric(autonomy), autonomyEvidenceAccent(autonomy))");
    expect(src).toContain("mkMeta('Evidence authority', autonomyEvidenceMetric(autonomy), evidenceTone)");
    expect(src).toContain("mkMeta('Evidence source', autonomyEvidenceSourceMetric(autonomy), evidenceTone)");
    expect(src).toContain("mkMeta('Evidence diagnostics', autonomyEvidenceDiagnosticsMetric(autonomy), evidenceTone)");
    expect(src).toContain("['Authority', autonomyEvidenceMetric(autonomy)]");
    expect(src).toContain('Signed evidence authority is degraded; inspect source diagnostics before autonomous merge.');
    expect(src).not.toContain('No autonomy evidence packs yet.');
  });

  it('app.js uses canonical daemon state field names instead of hiding live values', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain("['Last tick', d.lastTickAt ? fmtRelative(d.lastTickAt) : '—']");
    expect(src).toContain('d.todaySpentUsd.toFixed(4)');
    expect(src).not.toContain('d.lastTick ?');
    expect(src).not.toContain('d.todaySpendUsd');
  });

  it('app.js surfaces bounded metadata-only trajectory traces in Mission Control and Fleet Dashboard', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );

    expect(src).toContain('function renderTrajectoryLearningCard');
    expect(src).toContain('const learningDenominatorHealthy = learningSnapshotFresh &&');
    expect(src).toContain('? d.fleet?.trajectoryLearning ?? fleet.trajectoryLearning ?? null');
    expect(src).toContain('const skillCorpusReadiness = learningSnapshotFresh');
    expect(src).toContain("trajectoryLearning, skillCorpusReadiness, 'ctrl-card card', learningMetrics?.trajectoryLearning");
    expect(src).toContain("trajectoryLearning ? 'Trajectory Learning' : 'Skill Learning'");
    expect(src).toContain("trajectoryLearning || skillCorpusReadiness");
    expect(src).toContain('snap.fleet?.trajectoryLearning ?? snap.control?.fleet?.trajectoryLearning');
    expect(src).toContain('snap.fleet?.skillCorpusReadiness ?? snap.control?.fleet?.skillCorpusReadiness');
    expect(src).toContain('function trajectoryLearningPopulation(trajectoryLearning)');
    expect(src).toContain("['Observed trajectories', population.observed]");
    expect(src).toContain("['Learning eligible', population.learningEligible]");
    expect(src).toContain("['Incomplete', population.incomplete]");
    expect(src).toContain("['Degraded', population.degraded]");
    expect(src).toContain("['Dispatch -> decision', formatCoverageMetric(routeSpine.dispatchToDecision)]");
    expect(src).toContain("['Dispatch -> evidence', formatCoverageMetric(routeSpine.dispatchToEvidence)]");
    expect(src).toContain("['Dispatch -> merge', formatCoverageMetric(routeSpine.dispatchToMerge)]");
    expect(src).toContain("['Merged', terminal ? terminal.merged : 'withheld']");
    expect(src).toContain("['No-proposal', terminal ? terminal['no-proposal'] : 'withheld']");
    expect(src).toContain("['Failed', terminal ? terminal.failed : 'withheld']");
    expect(src).toContain("['Top gap', formatTrajectoryLearningGap(trajectoryLearning)]");
    expect(src).toContain('function renderTrajectoryTraceList(trajectoryLearning)');
    expect(src).toContain('trajectoryLearning?.traces');
    expect(src).toContain("/^trajectory:[a-f0-9]{12}$/");
    expect(src).toContain('body.appendChild(renderTrajectoryTraceList(trajectoryLearning))');

    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rowsStart = src.indexOf('\nfunction trajectoryLearningRows', formatStart);
    const traceStart = src.indexOf('\nfunction trajectoryTraceValue', rowsStart);
    const rendererEnd = src.indexOf('\nfunction formatCountMap', rowsStart);
    expect(formatStart).toBeGreaterThanOrEqual(0);
    expect(rowsStart).toBeGreaterThan(formatStart);
    expect(rendererEnd).toBeGreaterThan(rowsStart);

    const formatterSource = src.slice(formatStart, rowsStart);
    const formatter = new Function(`${formatterSource}\nreturn formatTrajectoryLearningGap;`)() as (
      trajectoryLearning: Record<string, any>,
    ) => string;
    const renderedGap = formatter({
      gaps: [
        { kind: 'repo:/private/ashlr', count: 99, sampleRefs: ['item-secret'] },
        { kind: 'evidence', count: 3, sampleRefs: ['trajectory:abc123', 'proposal-secret'] },
      ],
    });
    expect(renderedGap).toBe('Evidence 3 missing');
    expect(renderedGap).not.toContain('ashlr');
    expect(renderedGap).not.toContain('secret');
    expect(renderedGap).not.toContain('trajectory:');

    const trajectoryUiSource = src.slice(formatStart, traceStart);
    for (const identityField of ['sampleRefs', '.recent', '.ref', 'repo', 'itemId', 'proposalId', 'runId', 'trajectoryId']) {
      expect(trajectoryUiSource).not.toContain(identityField);
    }

    const traceSource = src.slice(traceStart, rendererEnd);
    for (const forbidden of ['repo', 'itemId', 'proposalId', 'runId', 'trajectoryId', 'prompt', 'diff', 'stdout', 'stderr', 'commandKinds']) {
      expect(traceSource).not.toContain(forbidden);
    }

    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 2,
      skillObservation: { sampleState: 'insufficient-sample' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);
    expect(values['Observed trajectories']).toBe(2);
    expect(values['Learning eligible']).toBe(2);
    expect(values.Incomplete).toBe(0);
    expect(values.Degraded).toBe(0);
    expect(values.Merged).toBe('withheld');
    expect(values['Dispatch -> decision']).toBe('coverage');
    expect(values['Skill-observed trajectories']).toBe('withheld (<3)');
    expect(values['Observed selections']).toBe('withheld');
    expect(values['Observation join gaps']).toBe('withheld');
  });

  it('executes the trajectory trace renderer for valid, legacy, degraded, and hostile snapshots', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const traceStart = src.indexOf('function trajectoryTraceValue(value, allowed, fallback = \'unknown\')');
    const traceEnd = src.indexOf('\nfunction renderTrajectoryLearningCard', traceStart);
    expect(traceStart).toBeGreaterThanOrEqual(0);
    expect(traceEnd).toBeGreaterThan(traceStart);
    const el = (tag: string, attrs: Record<string, unknown>, ...children: unknown[]) => ({
      tag, attrs, children,
      appendChild(child: unknown) { this.children.push(child); },
    });
    const renderer = new Function(
      'el',
      `${src.slice(traceStart, traceEnd)}\nreturn renderTrajectoryTraceList;`,
    )(el) as (trajectoryLearning: Record<string, unknown>) => ReturnType<typeof el>;
    const text = (node: unknown): string => typeof node === 'string'
      ? node
      : node && typeof node === 'object' && 'children' in node
        ? (node as { children: unknown[] }).children.map(text).join(' ')
        : '';

    const valid = text(renderer({ traces: {
      state: 'available',
      records: [{
        ref: 'trajectory:0123456789ab', terminalOutcome: 'failed', sourceState: 'degraded',
        coverage: { dispatch: true, proposal: false, evidence: true, decision: true, agentAction: true },
        events: [{
          ts: '2026-07-21T12:00:00.000Z', kind: 'evidence', outcome: 'failed', action: 'verified',
          route: { tier: 'frontier', backend: 'codex', modelFamily: 'codex', policyVersion: 'fleet-router-v1', learningEpoch: '2026-07-21' },
          evidence: { state: 'failed', trust: 'deterministic' }, labelBasis: 'evidence-policy', learningSource: 'autonomy-evidence',
        }],
      }],
    } }));
    expect(valid).toContain('trajectory:0123456789ab');
    expect(valid).toContain('evidence/failed/verified');
    expect(valid).toContain('route=frontier/codex/codex');
    expect(valid).toContain('policy=fleet-router-v1');
    expect(valid).toContain('source=autonomy-evidence');

    expect(text(renderer({}))).toContain('Trajectory traces unavailable');
    expect(text(renderer({ traces: { state: 'degraded', records: [] } }))).toContain('partial dispatch history withheld');

    const hostile = 'RAW_TRACE_RENDER_SECRET';
    const hostileText = text(renderer({ traces: {
      state: 'available', records: [{
        ref: `trajectory:${hostile}`, terminalOutcome: hostile, sourceState: hostile,
        coverage: { dispatch: hostile },
        events: [{
          ts: hostile, kind: hostile, outcome: hostile, action: hostile,
          route: { tier: hostile, backend: hostile, modelFamily: hostile, policyVersion: hostile, learningEpoch: hostile },
          evidence: { state: hostile, trust: hostile }, labelBasis: hostile, learningSource: hostile,
        }],
      }],
    } }));
    expect(hostileText).toContain('trajectory:unavailable');
    expect(hostileText).not.toContain(hostile);
  });

  it('app.js renders categorical skill corpus readiness without exposing sub-k details', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rowsFor = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )((metric?: { count?: number }) => `coverage:${metric?.count ?? 0}`) as (
      trajectoryLearning: Record<string, any>,
      readiness?: Record<string, any>,
    ) => Array<[string, string | number]>;

    const readiness = {
      corpus: {
        state: 'ready',
        sourceQuality: { badge: 'healthy-source', detail: 'private corpus detail' },
      },
      eligibleSignedCards: 'available',
      selectedObservations: 'present',
      learning: {
        state: 'k-gated',
        minimumObservedTrajectories: 5,
        sampleState: 'insufficient-sample',
        observedTrajectoryCoverage: { count: 2, rate: 1 },
      },
      cardIds: ['skill-secret'],
      queryText: 'private query text',
    };
    const values = Object.fromEntries(rowsFor({
      trajectories: 2,
      skillObservation: { sampleState: 'insufficient-sample', joined: 2, unjoined: 1 },
    }, readiness));

    expect(values['Skill corpus']).toBe('ready');
    expect(values['Corpus source']).toBe('healthy');
    expect(values['Eligible cards']).toBe('available');
    expect(values['Skill observations']).toBe('present');
    expect(values['Learning gate']).toBe('sample gated');
    expect(values['Observation threshold']).toBe('5 trajectories');
    expect(values['Skill-observed trajectories']).toBe('withheld (<5)');
    expect(values['Observed selections']).toBe('withheld');
    expect(values['Observation join gaps']).toBe('withheld');
    expect(values).not.toHaveProperty('Observed coverage');
    expect(JSON.stringify(values)).not.toContain('private');
    expect(JSON.stringify(values)).not.toContain('skill-secret');

    const observed = Object.fromEntries(rowsFor({
      trajectories: 5,
      skillObservation: { sampleState: 'observed', joined: 5, unjoined: 0, conflicting: 0 },
    }, {
      ...readiness,
      learning: {
        ...readiness.learning,
        state: 'observable',
        sampleState: 'observed',
        observedTrajectoryCoverage: { count: 5, rate: 1 },
      },
    }));
    expect(observed['Learning gate']).toBe('observable');
    expect(observed['Observed coverage']).toBe('coverage:5');
  });

  it('app.js keeps legacy trajectory snapshots renderable without corpus readiness', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({ trajectories: 0 }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Observed trajectories']).toBe(0);
    expect(values['Learning eligible']).toBe(0);
    expect(values.Incomplete).toBe(0);
    expect(values.Degraded).toBe(0);
    expect(values['Skill-observed trajectories']).toBe('withheld (<3)');
    expect(values).not.toHaveProperty('Skill corpus');
    expect(values).not.toHaveProperty('Observed coverage');
  });

  it('app.js shows zero learning eligibility without hiding observed trajectory work', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      version: 1,
      trajectories: 5,
      population: {
        observed: 'private-population-value',
        learningEligible: 0,
        incomplete: 4,
        degraded: 1,
        privateField: 'private-population-value',
      },
      skillObservation: { sampleState: 'none' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Observed trajectories']).toBe(5);
    expect(values['Learning eligible']).toBe(0);
    expect(values.Incomplete).toBe(4);
    expect(values.Degraded).toBe(1);
    expect(JSON.stringify(values)).not.toContain('private-population-value');
    expect(JSON.stringify(values)).not.toMatch(/repo|item|run|trajectoryId|proposalId/);
  });

  it('app.js renders a zero-observation sample as none rather than withheld', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 4,
      skillObservation: { sampleState: 'none' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Skill-observed trajectories']).toBe('none');
    expect(values['Observed selections']).toBe('none');
    expect(values['Observation join gaps']).toBe('not applicable');
  });

  it('app.js reports orphaned observation presence without exposing its count', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    const formatStart = src.indexOf('function formatTrajectoryLearningGap(trajectoryLearning)');
    const rendererEnd = src.indexOf('\nfunction formatCountMap', formatStart);
    const trajectoryUiSource = src.slice(formatStart, rendererEnd);
    const rows = new Function(
      'formatCoverageMetric',
      `${trajectoryUiSource}\nreturn trajectoryLearningRows;`,
    )(() => 'coverage')({
      trajectories: 4,
      skillObservation: { eventState: 'present', sampleState: 'none' },
    }) as Array<[string, string | number]>;
    const values = Object.fromEntries(rows);

    expect(values['Observation sample']).toBe('no joined sample');
    expect(values['Observed selections']).toBe('present; counts withheld');
    expect(values['Observation join gaps']).toBe('present; counts withheld');
    expect(JSON.stringify(values)).not.toMatch(/orphan|conflict|\b[1-2]\b/);
  });

  it('app.js renders Fleet Dashboard readiness rail from existing fleet snapshots', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    expect(src).toContain('function fdRenderReadinessRail');
    expect(src).toContain('autonomousShipReadiness');
    expect(src).toContain('missionBrief');
    expect(src).toContain("'Fleet OS'");
    expect(src).toContain("'Brief'");
    expect(src).toContain("'Confidence'");
    expect(src).toContain("'Action'");
    expect(src).toContain("'Data'");
    expect(src).toContain("'Blocker'");
    expect(src).toContain("'Queue'");
    expect(src).toContain("'Leases'");
    expect(src).toContain("'Yield'");
    expect(src).toContain("['degraded-source', 'degraded']");
    expect(src).toContain("['unknown-source', 'unknown']");
    expect(src).toContain("['stale-source', 'stale']");
    expect(src).toContain("['missing-source', 'missing']");
    expect(src).toContain("['healthy-zero', 'empty']");
    expect(src).toContain('const sources = Array.isArray(readiness.sources) ? readiness.sources : []');
    expect(src).toContain('source?.sourceQuality?.badge === badge');
    expect(src).toContain('function fdReadinessDataTitle');
    expect(src).toContain('function fdReadinessDataPill');
    expect(src).toContain('fdReadinessDataPill(readiness)');
    expect(src).toContain("el('summary', {}, 'Source detail')");
    expect(src).toContain("qualityParts.length > 0 ? qualityParts.join(' / ') : 'healthy sources'");
    expect(src).toContain('const briefDetail = missionBrief?.whyNow ?? primaryAction?.detail ?? actionLabel');
    expect(src).toContain('const actionDetail = primaryAction?.detail ?? briefDetail');
    expect(css).toContain('.fd-readiness-rail');
    expect(css).toContain('.fd-readiness-strip');
    expect(css).toContain('.fleet-command-rail');
    expect(css).toContain('.fleet-command-safety--autonomous-dispatch');
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(css).toContain('.fd-readiness-pill--data .fd-readiness-pill__value');
    expect(css).toContain('white-space: pre-line');
  });

  it('app.js keeps readiness data-quality counts distinct from healthy zero', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function fdReadinessDataText(readiness)');
    const end = src.indexOf('\nfunction fdReadinessDataTitle', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const formatterSource = src.slice(start, end);
    const formatter = new Function(`${formatterSource}\nreturn fdReadinessDataText;`)() as (
      readiness: Record<string, any>,
    ) => string;

    expect(formatter({
      freshness: { overall: 'stale' },
      sourceQualitySummary: {
        'degraded-source': 2,
        'unknown-source': 1,
        'stale-source': 3,
        'missing-source': 4,
        'healthy-zero': 5,
      },
      sources: [],
    })).toBe('stale · 2 degraded / 1 unknown / 3 stale / 4 missing / 5 empty');

    const degradedAndUnknown = formatter({
      freshness: { overall: 'fresh' },
      sourceQualitySummary: {
        'degraded-source': 1,
        'unknown-source': 2,
        'stale-source': 0,
        'missing-source': 0,
        'healthy-zero': 0,
      },
      sources: [],
    });
    expect(degradedAndUnknown).toBe('fresh · 1 degraded / 2 unknown');
    expect(degradedAndUnknown).not.toContain('empty');
    expect(degradedAndUnknown).not.toContain('healthy sources');
    expect(formatter({
      freshness: { overall: 'fresh' },
      sourceQualitySummary: {},
      sources: [],
      evidenceMatrix: { state: 'degraded', sources: [], summary: { withheld: 1 } },
    })).toBe('fresh · 0 healthy / 0 degraded / 0 blocked · evidence degraded');
  });

  it('app.js keeps unhealthy workspace zeroes distinct from healthy telemetry', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function workspaceSourceHealthy(workspace)');
    const end = src.indexOf('\nfunction fleetRepairRecoveryActive', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const formatterSource = src.slice(start, end);
    const helpers = new Function(
      `${formatterSource}\nreturn { workspaceSourceText, workspaceReadText, workspaceObservedValue };`,
    )() as Record<string, (...args: any[]) => string>;
    const degraded = {
      sourceQuality: {
        sourceState: 'degraded', complete: false, stopReasons: ['row-limit'],
        filesRead: 2, bytesRead: 2048, rowsScanned: 10, invalidRows: 1, unreadableFiles: 0,
      },
    };
    expect(helpers.workspaceSourceText!(degraded)).toBe('degraded (row-limit)');
    expect(helpers.workspaceReadText!(degraded)).toBe('2 files · 2048 bytes · 10 rows · 1 invalid · 0 unreadable');
    expect(helpers.workspaceObservedValue!(degraded, 0)).toBe('0 observed (partial)');
    expect(helpers.workspaceObservedValue!(degraded, '0%', true)).toBe('partial');

    const missing = { sourceQuality: { sourceState: 'missing', complete: true } };
    expect(helpers.workspaceSourceText!(missing)).toBe('missing');
    expect(helpers.workspaceObservedValue!(missing, 0)).toBe('unavailable');

    const legacy = { eventCount: 0, proposalEvents: 0 };
    expect(helpers.workspaceSourceText!(legacy)).toBe('unknown');
    expect(helpers.workspaceReadText!(legacy)).toBe('—');
    expect(helpers.workspaceObservedValue!(legacy, 0)).toBe('unavailable');
    expect(helpers.workspaceObservedValue!(legacy, '0%', true)).toBe('unavailable');
    expect(src).toContain('const sourceKnown = Boolean(workspace.sourceQuality)');
    expect(src).toContain("['Latest', sourceKnown ? workspace.latestAt ? fmtRelative(workspace.latestAt) : '—' : 'unavailable']");
  });

  it('app.js exposes observation-only canary promotion readiness without activation controls', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

    expect(src).toContain('function renderAutoMergeCanaryPromotionReadinessCard');
    expect(src).toContain("'Canary Promotion Readiness'");
    expect(src).toContain("['Scope caps', capSummary]");
    expect(src).toContain("['Cap source', scopeCaps?.source ?? 'unavailable']");
    expect(src).toContain("['Policy identity', scopeIdentity?.state ?? 'unavailable']");
    expect(src).toContain("['Identity observed', scopeIdentity?.observedAt ? fmtRelative(scopeIdentity.observedAt) : 'never']");
    expect(src).toContain("['Activation', 'disabled']");
    expect(src).toContain('f.autoMergeCanaryPromotionReadiness');
    expect(src).toContain('fleet.autoMergeCanaryPromotionReadiness ?? null');
    expect(src).toMatch(/fdMetricPill\(\s*'Canary promotion'/);
    expect(src).not.toContain('activateAutoMergeCanaryPromotion');
  });

  it('app.js withholds Fleet Activity proposal metrics without complete source evidence', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function fleetActivitySourceHealthy(source)');
    const end = src.indexOf('\nfunction renderFleetActivity()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const helpers = new Function(
      `${src.slice(start, end)}\nreturn { fleetActivitySourceHealthy, fleetActivitySourceText, fleetActivityObservedMetric };`,
    )() as Record<string, (...args: any[]) => string | boolean>;
    const healthy = { sourceState: 'healthy', complete: true };
    const degraded = { sourceState: 'degraded', complete: false, stopReasons: ['io-error'] };

    expect(helpers.fleetActivitySourceHealthy!(healthy)).toBe(true);
    expect(helpers.fleetActivityObservedMetric!(healthy, 0)).toBe('0');
    expect(helpers.fleetActivitySourceHealthy!(degraded)).toBe(false);
    expect(helpers.fleetActivityObservedMetric!(degraded, 0)).toBe('unavailable');
    expect(helpers.fleetActivityObservedMetric!(undefined, 0)).toBe('unavailable');
    expect(helpers.fleetActivitySourceText!(degraded)).toBe('degraded (io-error)');
    expect(src).toContain('Proposal evidence is unavailable; repository activity is withheld.');
    expect(src).toContain('Merge evidence is unavailable; recent merges are withheld.');
  });

  it('app.js never renders free-form agent summaries', () => {
    const rawCanary = 'RAW_CUSTOMER_STDOUT_CANARY_7f8a91 ordinary private text';
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const start = src.indexOf('function agentActionDisplayText(action)');
    const end = src.indexOf('\nfunction renderFleetActivity()', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const agentActionDisplayText = new Function(
      `${src.slice(start, end)}\nreturn agentActionDisplayText;`,
    )() as (action: Record<string, unknown>) => string;

    const display = agentActionDisplayText({
      action: 'daemon:dispatch',
      kind: 'dispatch',
      outcome: 'no-proposal',
      summary: rawCanary,
      proseDigest: `sha256:${'a'.repeat(64)}`,
    });

    expect(display).toBe('daemon:dispatch dispatch/no-proposal ref=aaaaaaaaaaaa');
    expect(display).not.toContain(rawCanary);
    expect(src).not.toContain('title: action.summary');
    expect(src).not.toContain('compactFleetReason(action.summary');
  });

  it('renders cutoff checkpoints outside readiness and labels evidence source quality honestly', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const summaryStart = src.indexOf('function evidenceSourceSummary(source)');
    const summaryEnd = src.indexOf('\nfunction renderCutoffCheckpointCard', summaryStart);
    expect(summaryStart).toBeGreaterThanOrEqual(0);
    expect(summaryEnd).toBeGreaterThan(summaryStart);
    const evidenceSourceSummary = new Function(
      `${src.slice(summaryStart, summaryEnd)}\nreturn evidenceSourceSummary;`,
    )() as (source: Record<string, unknown>) => string;

    expect(evidenceSourceSummary({
      evidenceRole: 'forensics',
      evidenceQuality: { sourceState: 'missing', sourcePresent: false, complete: true, rowsScanned: 0 },
    })).toBe('forensics · missing');
    expect(evidenceSourceSummary({
      evidenceRole: 'forensics',
      evidenceQuality: { sourceState: 'degraded', sourcePresent: true, complete: false, rowsScanned: 0 },
    })).toBe('forensics · degraded');
    expect(evidenceSourceSummary({
      evidenceRole: 'learning',
      evidenceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true, rowsScanned: 0 },
    })).toBe('learning · 0 rows');

    expect(src).toContain("el('span', { cls: 'card-title' }, 'Cutoff Checkpoints')");
    expect(src).toContain("el('span', { cls: 'card-subtitle' }, 'Observation only')");
    expect(src).toContain("['Capture', status.captureScheduler?.state ?? 'unknown']");
    expect(src).toContain('d.fleet?.cutoffCheckpoints ?? fleet.cutoffCheckpoints ?? null');
    expect(src.indexOf('renderCutoffCheckpointCard('))
      .toBeGreaterThan(src.indexOf('renderAutonomousShipReadinessCard('));
  });

  it('app.js renders Fleet Dashboard lease board from shared queue machine health', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
    expect(src).toContain('function fdRenderLeaseBoard');
    expect(src).toContain('function fdActiveWorkValue');
    expect(src).toContain("'Active work'");
    expect(src).toContain("'Lease Board'");
    expect(src).toContain('claimsByMachine');
    expect(src).toContain('claimSamples');
    expect(src).toContain('nextLeaseExpiryAt');
    expect(src).toContain('oldestExpiredMs');
    expect(src).toContain('ambiguousClaims');
    expect(src).toContain("'Ambiguous'");
    expect(src).toContain('fdRenderLeaseBoard(sharedQueue, activeWork)');
    expect(src).toContain('claimsByMachine.slice(0, 6)');
    expect(src).toContain('claimSamples.slice(0, 6)');
    expect(src).toContain("activeWork?.hostname");
    expect(src).toContain('Machine claims unavailable.');
    expect(css).toContain('.fd-lease-board');
    expect(css).toContain('.fd-lease-metrics');
    expect(css).toContain('.fd-lease-machine__id');
    expect(css).toContain('.fd-lease-samples');
    expect(css).toContain('.fd-lease-active-ids');
    expect(css).toContain('text-overflow: ellipsis');
  });

  it('renders one bounded read-only Autonomy Lane Board in Fleet Dashboard and Mission Control', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

    expect(src).toContain('function renderAutonomyLaneBoard');
    expect(src).toContain('laneLocks.samples.slice(0, 8)');
    expect(src).toContain('body.appendChild(rows)');
    expect(src).toContain("el('span', { cls: 'autonomy-lane-board__eyebrow' }, 'Autonomy Lanes')");
    expect(src).toContain("state === 'healthy' ? 'No occupied autonomy lanes.'");
    expect(src).toContain('Lane counts are observed from partial sources');
    expect(src).toContain('Lane data unavailable');
    expect(src).toContain("shell: 'ashlr fleet status --json'");
    expect(src).toContain("shell: 'ashlr goals list --json'");
    expect(src).toContain("shell: 'ashlr inbox --json'");
    expect(src).toContain("fleet-command-safety--read-only");
    expect(src).not.toContain('autonomyLaneBoardMutation');

    const laneHelpersStart = src.indexOf('function laneLockSourceState(laneLocks, sourceNames)');
    const displayStateStart = src.indexOf('function laneLockDisplayState(laneLocks)');
    const displayStateEnd = src.indexOf('function laneLockStateLabel(reason)', displayStateStart);
    const displayHelpers = new Function(
      `${src.slice(laneHelpersStart, displayStateEnd)}\nreturn { laneLockDisplayState, laneLockMetricObservations, laneLockMetricText, laneLockOccupiedObservation };`,
    )() as {
      laneLockDisplayState: (laneLocks: Record<string, unknown> | null) => string;
      laneLockMetricObservations: (laneLocks: Record<string, unknown> | null) => Record<string, { state: string; value: number | null }>;
      laneLockMetricText: (metric: { state: string; value: number | null }, label: string) => string;
      laneLockOccupiedObservation: (laneLocks: Record<string, unknown> | null) => { state: string; value: number | null };
    };
    const displayState = displayHelpers.laneLockDisplayState;
    const counts = { active: 0, staleInProgress: 0, awaitingHostMerge: 0, unverifiedApplied: 0 };
    const healthySources = {
      enrollment: { sourceState: 'healthy', complete: true },
      goals: { sourceState: 'healthy', complete: true },
      proposals: { sourceState: 'healthy', complete: true },
      queue: { sourceState: 'healthy', complete: true },
    };
    expect(displayState({ sourceQuality: { sourceState: 'missing', complete: false } })).toBe('unknown');
    expect(displayState({
      ...counts,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        sources: { ...healthySources, goals: { sourceState: 'missing', complete: false } },
      },
    })).toBe('degraded');
    expect(displayState({
      ...counts,
      sourceQuality: { sourceState: 'healthy', complete: false, sources: healthySources },
    })).toBe('degraded');
    expect(displayState({
      ...counts,
      sourceQuality: { sourceState: 'healthy', complete: true, sources: healthySources },
    })).toBe('healthy');
    expect(displayState({
      ...counts,
      sourceQuality: { sourceState: 'healthy', complete: true },
    })).toBe('unknown');
    expect(displayState({
      staleInProgress: 0,
      awaitingHostMerge: 0,
      unverifiedApplied: 0,
      sourceQuality: { sourceState: 'healthy', complete: true, sources: healthySources },
    })).toBe('unknown');

    const metricStart = src.indexOf('function laneLocksMetric(laneLocks)');
    const laneMetricSource = src.slice(metricStart, displayStateEnd);
    const metricHelpers = new Function(
      `${laneMetricSource}\nreturn { laneLocksMetric, laneLockDisplayState };`,
    )() as { laneLocksMetric: (laneLocks: Record<string, unknown> | null) => string | null };
    expect(metricHelpers.laneLocksMetric({
      ...counts,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        sources: { ...healthySources, queue: { sourceState: 'missing', complete: false } },
      },
    })).toBe('0 active / 0 stale / 0 handoff / 0 unverified');
    expect(metricHelpers.laneLocksMetric({
      ...counts,
      active: 2,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        sources: { ...healthySources, queue: { sourceState: 'degraded', complete: false } },
      },
    })).toBe('2 active / 0 stale / 0 handoff / 0 unverified');

    const sourceMatrix = [
      {
        name: 'degraded enrollment',
        quality: {
          sourceState: 'degraded', complete: false,
          sources: { ...healthySources, enrollment: { sourceState: 'degraded', complete: false } },
        },
        state: 'degraded',
        metric: '0 active observed (partial) / 0 stale observed (partial) / ' +
          '0 handoff observed (partial) / 0 unverified observed (partial)',
        occupied: { state: 'degraded', value: 0 },
      },
      {
        name: 'degraded goals',
        quality: {
          sourceState: 'degraded', complete: false,
          sources: { ...healthySources, goals: { sourceState: 'degraded', complete: false } },
        },
        state: 'degraded',
        metric: '0 active observed (partial) / 0 stale observed (partial) / 0 handoff / 0 unverified observed (partial)',
        occupied: { state: 'degraded', value: 0 },
      },
      {
        name: 'missing goals',
        quality: {
          sourceState: 'missing', complete: false,
          sources: { ...healthySources, goals: { sourceState: 'missing', complete: false } },
        },
        state: 'degraded',
        metric: 'active unavailable / stale unavailable / 0 handoff / unverified unavailable',
        occupied: { state: 'unavailable', value: null },
      },
      {
        name: 'degraded proposals',
        quality: {
          sourceState: 'degraded', complete: false,
          sources: { ...healthySources, proposals: { sourceState: 'degraded', complete: false } },
        },
        state: 'degraded',
        metric: '0 active observed (partial) / 0 stale observed (partial) / ' +
          '0 handoff observed (partial) / 0 unverified observed (partial)',
        occupied: { state: 'degraded', value: 0 },
      },
      {
        name: 'missing proposals',
        quality: {
          sourceState: 'missing', complete: false,
          sources: { ...healthySources, proposals: { sourceState: 'missing', complete: false } },
        },
        state: 'missing',
        metric: 'active unavailable / stale unavailable / handoff unavailable / unverified unavailable',
        occupied: { state: 'unavailable', value: null },
      },
      {
        name: 'degraded queue only',
        quality: {
          sourceState: 'degraded', complete: false,
          sources: { ...healthySources, queue: { sourceState: 'degraded', complete: false } },
        },
        state: 'degraded',
        metric: '0 active / 0 stale / 0 handoff / 0 unverified',
        occupied: { state: 'healthy', value: 0 },
      },
    ];
    for (const fixture of sourceMatrix) {
      const laneLocks = { ...counts, sourceQuality: fixture.quality };
      expect(displayState(laneLocks), fixture.name).toBe(fixture.state);
      expect(metricHelpers.laneLocksMetric(laneLocks), fixture.name).toBe(fixture.metric);
      expect(displayHelpers.laneLockOccupiedObservation(laneLocks), fixture.name).toEqual(fixture.occupied);
    }

    const compactSummaryStart = src.indexOf('function laneBoardCompactSummary(laneLocks)');
    const compactSummaryEnd = src.indexOf('function laneBoardCompactViewport()', compactSummaryStart);
    const compactSummary = new Function(
      `${src.slice(laneHelpersStart, displayStateEnd)}\n${src.slice(compactSummaryStart, compactSummaryEnd)}\nreturn laneBoardCompactSummary;`,
    )() as (laneLocks: Record<string, unknown> | null) => string;
    expect(compactSummary({
      active: 0,
      staleInProgress: 0,
      awaitingHostMerge: 0,
      unverifiedApplied: 0,
      sourceQuality: { sourceState: 'missing', complete: false },
    })).toBe('Lanes Unavailable');
    expect(compactSummary({
      active: 2,
      staleInProgress: 0,
      awaitingHostMerge: 1,
      unverifiedApplied: 0,
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        sources: { ...healthySources, queue: { sourceState: 'degraded', complete: false } },
      },
    })).toBe('Lanes Partial · 3');

    const laneRenderStart = src.indexOf('function renderAutonomyLaneBoard');
    const laneRenderEnd = src.indexOf('function autonomyAuthorityState', laneRenderStart);
    const laneRenderSource = src.slice(laneRenderStart, laneRenderEnd);
    const laneActionIndex = laneRenderSource.indexOf("cls: 'autonomy-lane-board__action'");
    const laneMetricsIndex = laneRenderSource.indexOf("cls: 'autonomy-lane-board__metrics'");
    const laneRowsIndex = laneRenderSource.indexOf("cls: 'autonomy-lane-board__rows'");
    expect(laneActionIndex).toBeGreaterThanOrEqual(0);
    expect(laneMetricsIndex).toBeGreaterThan(laneActionIndex);
    expect(laneRowsIndex).toBeGreaterThan(laneActionIndex);
    expect(laneRenderSource).toContain("const displayable = state === 'healthy' || state === 'degraded'");
    expect(laneRenderSource).toContain('const samples = displayable && Array.isArray(laneLocks?.samples)');

    const readinessIndex = src.indexOf('if (readinessRail) body.appendChild(readinessRail)');
    const dashboardLaneIndex = src.indexOf('body.appendChild(renderAutonomyLaneBoard(fleetSnapshot?.laneLocks))');
    const leaseIndex = src.indexOf('const leaseBoard = fdRenderLeaseBoard(sharedQueue, activeWork)');
    expect(readinessIndex).toBeGreaterThanOrEqual(0);
    expect(dashboardLaneIndex).toBeGreaterThan(readinessIndex);
    expect(leaseIndex).toBeGreaterThan(dashboardLaneIndex);

    const missionBriefIndex = src.indexOf('const missionBriefCard = renderMissionBriefCard(missionBrief)');
    const missionLaneIndex = src.indexOf("renderAutonomyLaneBoard(laneLocks, 'ctrl-card card')");
    expect(missionLaneIndex).toBeGreaterThan(missionBriefIndex);
    expect(css).toContain('.autonomy-lane-board__rows');
    expect(css).toContain('.autonomy-lane-board__action');
    expect(css).toContain('.autonomy-lane-board__reference { grid-column: 1 / -1; }');
    expect(css).not.toContain('.autonomy-lane-board__row--header { display: none; }');
    expect(css).toContain('.autonomy-lane-board__row--header {\n    position: absolute;');
    expect(src).toContain("'aria-label': `Repo: ${repo}`");
    expect(src).toContain("'aria-label': `Objective or reference: ${reference}`");
    expect(src).toContain('rail.appendChild(renderReadinessLaneControl(fleet?.laneLocks))');
    expect(src).toContain("const secondary = el('details', { cls: 'fd-readiness-secondary', open: 'open' }");
    expect(src).toContain('if (laneBoardCompactViewport()) secondary.open = false');
    expect(src).toContain("typeof window.matchMedia === 'function'");
    expect(src).not.toContain("if (!window.matchMedia('(max-width: 720px)').matches) secondary.open = true");
    const readinessRailStart = src.indexOf('function fdRenderReadinessRail(snap)');
    const readinessRailEnd = src.indexOf('function fdRenderStatusPanel(snap)', readinessRailStart);
    const readinessRailSource = src.slice(readinessRailStart, readinessRailEnd);
    expect(readinessRailSource.indexOf('renderReadinessLaneControl')).toBeGreaterThan(
      readinessRailSource.indexOf("cls: 'fd-readiness-rail__verdict'"),
    );
    expect(readinessRailSource.indexOf("cls: 'fd-readiness-strip'")).toBeGreaterThan(
      readinessRailSource.indexOf('renderReadinessLaneControl'),
    );
    expect(readinessRailSource.indexOf("cls: 'fd-readiness-secondary'")).toBeGreaterThan(
      readinessRailSource.indexOf('renderReadinessLaneControl'),
    );
    expect(css).toContain('.fd-readiness-secondary > summary');
    expect(css).toContain('.fd-readiness-secondary__grid');
    expect(css).toContain('.fd-readiness-lane-control');
    expect(css).toContain('.fd-readiness-lane-control__action');

    const readinessControlStart = src.indexOf('function renderReadinessLaneControl(laneLocks)');
    const readinessControlEnd = src.indexOf('function renderCompactLaneControl', readinessControlStart);
    const readinessControlSource = src.slice(readinessControlStart, readinessControlEnd);
    expect(readinessControlSource).toContain('fleet-command-safety--read-only');
    expect(readinessControlSource).not.toContain('laneLocks.samples');

    const compactControlStart = src.indexOf('function renderCompactLaneControl(laneLocks)');
    const compactControlEnd = src.indexOf('function renderAutonomyLaneBoard', compactControlStart);
    const compactControlSource = src.slice(compactControlStart, compactControlEnd);
    expect(compactControlSource).toContain("'aria-label': 'Autonomy lane status'");
    expect(compactControlSource).toContain('fleet-command-safety--read-only');
    expect(compactControlSource).not.toContain('laneLocks.samples');

    const controlStart = src.indexOf('function renderControl()');
    const controlEnd = src.indexOf('function renderFleetActivity', controlStart);
    const controlSource = src.slice(controlStart, controlEnd);
    expect(controlSource.indexOf('heroPulse.appendChild(renderCompactLaneControl(laneLocks))')).toBeGreaterThanOrEqual(0);
    expect(controlSource.indexOf('const heroMetrics')).toBeGreaterThan(
      controlSource.indexOf('heroPulse.appendChild(renderCompactLaneControl(laneLocks))'),
    );
    expect(controlSource).toContain('const laneLocksState = laneLockDisplayState(laneLocks)');
    expect(controlSource).toContain('const laneLocksActive = laneLockMetricObservations(laneLocks).active');
    expect(controlSource).toContain("laneLockMetricText(laneLocksActive, '')");
    expect(css).toContain('.ctrl-lane-compact__action');
  });

  it('executes degraded lane and stale readiness renderers with bounded accessible mobile output', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public');
    const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

    type RenderNode = {
      tagName: string;
      className: string;
      attributes: Record<string, string>;
      children: RenderNode[];
      open: boolean;
      textContent: string;
      appendChild: (child: RenderNode) => RenderNode;
      setAttribute: (name: string, value: unknown) => void;
      addEventListener: () => void;
    };
    const node = (tagName: string, text = ''): RenderNode => {
      const result = {
        tagName,
        className: '',
        attributes: {} as Record<string, string>,
        children: [] as RenderNode[],
        open: false,
        appendChild(child: RenderNode) {
          this.children.push(child);
          return child;
        },
        setAttribute(name: string, value: unknown) {
          this.attributes[name] = String(value);
          if (name === 'open') this.open = true;
        },
        addEventListener() {},
        get textContent() {
          return text + this.children.map((child) => child.textContent).join('');
        },
      };
      return result;
    };
    const document = {
      createElement: (tagName: string) => node(tagName),
      createTextNode: (text: string) => node('#text', text),
    };
    const descendants = (rootNode: RenderNode): RenderNode[] => [
      rootNode,
      ...rootNode.children.flatMap(descendants),
    ];
    const byClass = (rootNode: RenderNode, className: string) => descendants(rootNode)
      .filter((candidate) => candidate.className.split(/\s+/).includes(className));
    const byAttribute = (rootNode: RenderNode, name: string, value: string) => descendants(rootNode)
      .filter((candidate) => candidate.attributes[name] === value);

    const functionSource = (name: string, nextName: string) => {
      const start = src.indexOf(`function ${name}`);
      const end = src.indexOf(`\nfunction ${nextName}`, start);
      expect(start, name).toBeGreaterThanOrEqual(0);
      expect(end, nextName).toBeGreaterThan(start);
      return src.slice(start, end);
    };
    const elSource = functionSource('el(tag, attrs = {}, ...children)', 'svgEl');
    const laneHelpers = src.slice(
      src.indexOf('function laneLockSourceState(laneLocks, sourceNames)'),
      src.indexOf('\nfunction renderReadinessLaneControl', src.indexOf('function laneLockSourceState(laneLocks, sourceNames)')),
    );
    const readinessControl = functionSource('renderReadinessLaneControl(laneLocks)', 'renderCompactLaneControl');
    const laneBoard = functionSource('renderAutonomyLaneBoard(laneLocks, cardClass = \'\')', 'autonomyAuthorityState');
    const duration = functionSource('fdFormatDurationMs(ms)', 'fdRenderLeaseMetric');
    const leaseMetric = functionSource('fdRenderLeaseMetric(label, value, tone, title)', 'fdActiveWorkTitle');
    const readinessData = src.slice(
      src.indexOf('function fdReadinessDataText(readiness)'),
      src.indexOf('\nfunction fdFormatDurationMs', src.indexOf('function fdReadinessDataText(readiness)')),
    );
    const readinessRail = functionSource('fdRenderReadinessRail(snap)', 'fdRenderStatusPanel');
    const buildRenderers = new Function('document', 'window', `
      ${elSource}
      const compactFleetReason = (value, limit) => String(value ?? '').slice(0, limit);
      const basenameFromPath = (value) => String(value).split(/[\\\\/]/).filter(Boolean).pop() ?? '';
      ${laneHelpers}
      ${readinessControl}
      ${laneBoard}
      ${duration}
      ${leaseMetric}
      ${readinessData}
      const queueEligibilityMetric = () => null;
      const generatedWorkMetric = () => null;
      const diagnosticResliceDrainMetric = () => null;
      const fleetSnapshotLearningFresh = () => false;
      const fleetRepairRecoveryMetric = () => null;
      const fleetRepairRecoveryActive = () => false;
      const sharedQueueMetric = () => null;
      const formatShipReadinessVerdict = (value) => String(value ?? 'unknown');
      const shipReadinessAccent = () => '#f97316';
      ${readinessRail}
      return { renderAutonomyLaneBoard, renderReadinessLaneControl, fdRenderReadinessRail };
    `);

    const laneLocks = {
      active: 1,
      staleInProgress: 1,
      awaitingHostMerge: 0,
      unverifiedApplied: 1,
      samples: Array.from({ length: 10 }, (_, index) => ({
        repo: `/workspace/repository-with-a-very-long-name-${index}`,
        title: `Long objective ${index} that must remain readable without widening the viewport`,
        goalId: `g_${String(index).padStart(16, '0')}`,
        reason: index % 2 === 0 ? 'stale-in-progress' : 'unverified-applied',
        ageMs: 90_000 + index,
      })),
      sourceQuality: {
        sourceState: 'degraded',
        complete: false,
        reasons: ['snapshot-stale', 'goal-ledger-partial'],
        sources: {
          enrollment: { sourceState: 'healthy', complete: true },
          goals: { sourceState: 'degraded', complete: false },
          proposals: { sourceState: 'healthy', complete: true },
          queue: { sourceState: 'healthy', complete: true },
        },
      },
    };
    const staleSnapshot = {
      generatedAt: '2000-01-01T00:00:00.000Z',
      fleet: {
        laneLocks,
        autonomousShipReadiness: {
          verdict: 'blocked',
          confidence: 'low',
          freshness: { overall: 'stale' },
          sourceQualitySummary: { 'stale-source': 1, 'degraded-source': 1 },
          sources: [],
          topBlocker: { id: 'stale-evidence', detail: 'Fresh evidence required' },
          primaryAction: { id: 'refresh-evidence', detail: 'Refresh evidence' },
        },
        queue: { backlogItems: 3 },
        dispatchProduction: { proposalsCreated: 9 },
      },
    };

    for (const mobile of [false, true]) {
      const window = { matchMedia: () => ({ matches: mobile }) };
      const renderers = buildRenderers(document, window) as {
        renderAutonomyLaneBoard: (value: unknown) => RenderNode;
        renderReadinessLaneControl: (value: unknown) => RenderNode;
        fdRenderReadinessRail: (value: unknown) => RenderNode;
      };
      const board = renderers.renderAutonomyLaneBoard(laneLocks);
      expect(board.className).toContain('autonomy-lane-board--degraded');
      expect(board.textContent).toContain('Lane counts are observed from partial sources: snapshot-stale, goal-ledger-partial');
      expect(board.textContent).toContain('Inspect lane sourcesashlr fleet status --jsonread-only');
      expect(byClass(board, 'autonomy-lane-board__row')).toHaveLength(9);
      expect(byAttribute(board, 'role', 'columnheader')).toHaveLength(4);
      expect(byAttribute(board, 'aria-label', 'Observed autonomy lanes')).toHaveLength(1);
      expect(byAttribute(board, 'aria-label', 'State: stale')).toHaveLength(4);
      expect(descendants(board).filter((candidate) => candidate.tagName === 'button')).toHaveLength(0);

      const control = renderers.renderReadinessLaneControl(laneLocks);
      expect(control.attributes.role).toBe('status');
      expect(control.attributes['aria-label']).toBe('Autonomy lane status');
      expect(control.textContent).toContain('Lanes Partial · 2 observed (partial)');
      expect(control.textContent).toContain('read-only');

      const rail = renderers.fdRenderReadinessRail(staleSnapshot);
      expect(rail.textContent).toContain('blocked');
      expect(rail.textContent).toContain('stale · 1 degraded / 1 stale');
      expect(rail.textContent).toContain('withheld (stale snapshot)');
      const secondary = byClass(rail, 'fd-readiness-secondary')[0];
      expect(secondary?.open).toBe(!mobile);
    }

    expect(css).toMatch(/\.fd-readiness-lane-control\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.fd-readiness-lane-control__summary\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/);
    expect(css).toMatch(/\.autonomy-lane-board__row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(70px, 0\.75fr\)[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.autonomy-lane-board__action\s*\{[\s\S]*?flex-wrap:\s*wrap;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.fd-readiness-lane-control\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.autonomy-lane-board__row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto;/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.autonomy-lane-board__reference\s*\{\s*grid-column:\s*1 \/ -1;/);
  });

  it('app.js inbox detail reads current proposal review fields', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/core/web/public/app.js'),
      'utf8',
    );
    expect(src).toContain('p.riskClass ?? p.riskLevel');
    expect(src).toContain("['Verify',  verify]");
    expect(src).toContain("['Taste',   taste]");
  });

  // ── 15. SSE response headers ──────────────────────────────────────────────

  it('SSE response has Cache-Control: no-cache and Connection: keep-alive', async () => {
    const { res } = await openSseAndDrainInitial();
    const hdrs = res._headers();
    expect(hdrs['Cache-Control']).toContain('no-cache');
    expect(hdrs['Connection']).toBe('keep-alive');
  });
});
