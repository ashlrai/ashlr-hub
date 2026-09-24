/**
 * 3.10 server performance (unit A3) — the Verse cockpit's read paths.
 *
 *  - /api/verse/control reads a stable config identity (so the shared
 *    fleet-status cache hits), only the fleet/daemon slice, a fingerprinted
 *    pending count, and — with a read-projection worker — a stale-while-
 *    revalidate fleet read that never waits on a busy worker.
 *  - /api/verse/usage-series is served from the rollup cache, refreshed on
 *    the worker.
 *  - GET /runtime and GET /fleet share one live runtime probe.
 *
 * HOME is relocated per worker by test/setup/home.ts; this file writes only
 * under that tmp HOME.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import type { CachedFleetStatus } from '../src/core/web/fleet-status-cache.js';
import type { ReadProjectionReader } from '../src/core/web/read-projections.js';

const seen = vi.hoisted(() => ({
  fleetCfgs: [] as unknown[],
  pendingCalls: 0,
  runtimeCalls: 0,
  rollupBuilds: 0, // collectUsageEvents calls == in-process rollup builds
}));

vi.mock('../src/core/web/fleet-status-cache.js', () => ({
  getCachedFleetStatus: vi.fn(async (cfg: unknown) => {
    seen.fleetCfgs.push(cfg);
    return fleetFixture(0);
  }),
}));

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...real,
    pendingCount: vi.fn(() => {
      seen.pendingCalls += 1;
      return 2;
    }),
  };
});

vi.mock('../src/core/local-runtime/llama/index.js', () => ({
  statusLocalRuntime: vi.fn(async () => {
    seen.runtimeCalls += 1;
    return {
      schemaVersion: 1, state: 'down', runtimeKind: 'unknown', parallelRefusal: null,
      baseUrl: 'http://127.0.0.1:8080/v1', origin: 'http://127.0.0.1:8080', host: '127.0.0.1', port: 8080,
      model: null, modelName: null, quant: null, contextTotal: null, contextPerSlot: null,
      slots: { source: 'unknown', configured: 0, busy: 0 }, pid: null, owner: null, startedAt: null,
    };
  }),
}));

vi.mock('../src/core/observability/usage-source.js', () => ({
  collectUsageEvents: vi.fn(() => {
    seen.rollupBuilds += 1;
    return [];
  }),
  dashNormalize: (p: string) => p,
}));

vi.mock('../src/core/index-engine.js', () => ({ loadIndex: vi.fn(() => null) }));

function fleetFixture(ageMs: number): CachedFleetStatus {
  return {
    stale: false,
    ageMs,
    status: {
      generatedAt: new Date().toISOString(),
      daemon: {
        running: false,
        sourceQuality: { sourceState: 'healthy', complete: true, reason: 'healthy' },
        lastTickAt: null,
        todaySpentUsd: 0,
      },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
    },
  } as unknown as CachedFleetStatus;
}

function rollupFixture(day: string) {
  return {
    window: '7d', since: new Date().toISOString(),
    totals: { tokensIn: 1, tokensOut: 1, estCostUsd: 0, sessions: 1, commits: 0 },
    byProject: [], byModel: [],
    byDay: [{ day, tokensIn: 1, tokensOut: 1, estCostUsd: 0, sessions: 1, cacheRead: 0, cacheWrite: 0, cacheHitRate: 0 }],
    budget: { level: 'ok', window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: '' },
  };
}

const controlApi = await import('../src/core/verse/control-api.js');
const rollupMod = await import('../src/core/observability/rollup.js');

function cfg(): AshlrConfig {
  return {
    version: 1, roots: [], editor: 'vscode', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
  } as AshlrConfig;
}

function fakeReader(): ReadProjectionReader & { calls: Array<[string, unknown]>; release: () => void; hold: boolean } {
  const reader = {
    calls: [] as Array<[string, unknown]>,
    hold: false,
    pending: [] as Array<() => void>,
    release(): void {
      for (const done of this.pending.splice(0)) done();
    },
    async read(kind: string, payload?: unknown): Promise<unknown> {
      reader.calls.push([kind, payload]);
      if (reader.hold) await new Promise<void>((r) => reader.pending.push(r));
      if (kind === 'fleet') return fleetFixture(reader.calls.length);
      if (kind === 'pulse') return rollupFixture(`worker-${reader.calls.length}`);
      throw new Error(`unexpected ${kind}`);
    },
    async invalidate(): Promise<void> {},
    async close(): Promise<void> {},
  };
  return reader as unknown as ReadProjectionReader & { calls: Array<[string, unknown]>; release: () => void; hold: boolean };
}

interface Captured { status: number; body: unknown }

function call(path: string, ctx: Partial<Parameters<typeof controlApi.handleVerseControlApi>[0]> = {}): Promise<Captured> {
  const url = path;
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    end(chunk?: string) { if (chunk) text += chunk; this.writableEnded = true; },
    write(chunk: string) { text += chunk; return true; },
  } as unknown as ServerResponse;
  const pathname = path.split('?')[0]!;
  return controlApi.handleVerseControlApi(
    { cfg: cfg(), token: 't'.repeat(64), allowDispatch: false, ...ctx },
    req, res, pathname, 'GET',
  ).then(() => ({ status, body: text ? JSON.parse(text) : null }));
}

function writeConfig(extra: Record<string, unknown>): void {
  const dir = join(homedir(), '.ashlr');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, ...extra }), { mode: 0o600 });
}

beforeEach(() => {
  seen.fleetCfgs.length = 0;
  seen.pendingCalls = 0;
  seen.runtimeCalls = 0;
  seen.rollupBuilds = 0;
  rollupMod.invalidateRollupCache();
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(join(homedir(), '.ashlr', 'config.json'), { force: true });
  rmSync(join(homedir(), '.ashlr', 'inbox'), { recursive: true, force: true });
});

describe('GET /api/verse/control', () => {
  it('hands the fleet cache the SAME config object while the file is unchanged', async () => {
    writeConfig({ staleDays: 30 });
    await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false });
    await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false });
    expect(seen.fleetCfgs).toHaveLength(2);
    expect(seen.fleetCfgs[0]).toBe(seen.fleetCfgs[1]);
    writeConfig({ staleDays: 31 });
    await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false });
    expect(seen.fleetCfgs[2]).not.toBe(seen.fleetCfgs[1]);
  });

  it('does not build the rollup (or anything outside the fleet/daemon slice)', async () => {
    const snap = await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false });
    expect(seen.rollupBuilds).toBe(0);
    expect(snap.fleet.freshness).toEqual({ stale: false, ageMs: 0 });
    expect(snap.pendingApprovals).toBe(2);
  });

  it('recounts pending approvals only when the inbox changes', async () => {
    const inbox = join(homedir(), '.ashlr', 'inbox');
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(inbox, 'prop-1.json'), '{}');
    expect(controlApi.cachedPendingCount()).toBe(2);
    expect(controlApi.cachedPendingCount()).toBe(2);
    expect(seen.pendingCalls).toBe(1);
    // The store's own writes: temp file + rename into the directory.
    writeFileSync(join(inbox, '.prop-2.tmp'), '{}');
    renameSync(join(inbox, '.prop-2.tmp'), join(inbox, 'prop-2.json'));
    controlApi.cachedPendingCount();
    expect(seen.pendingCalls).toBe(2);
    rmSync(join(inbox, 'prop-2.json'));
    controlApi.cachedPendingCount();
    expect(seen.pendingCalls).toBe(3);
  });

  it('catches an in-place edit (no directory change) within the full-check window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const inbox = join(homedir(), '.ashlr', 'inbox');
    mkdirSync(inbox, { recursive: true, mode: 0o700 });
    writeFileSync(join(inbox, 'prop-1.json'), '{}');
    controlApi.cachedPendingCount();
    const base = seen.pendingCalls;
    writeFileSync(join(inbox, 'prop-1.json'), '{"status":"changed"}');
    controlApi.cachedPendingCount();
    expect(seen.pendingCalls).toBe(base); // directory stamp unchanged: fast path
    vi.setSystemTime(start + 10_001);
    controlApi.cachedPendingCount();
    expect(seen.pendingCalls).toBe(base + 1);
    // A later check with nothing changed stays cached.
    vi.setSystemTime(start + 20_002);
    controlApi.cachedPendingCount();
    expect(seen.pendingCalls).toBe(base + 1);
  });

  it('reads fleet status through the worker, fresh for 5 s, then stale-while-revalidate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const reader = fakeReader();
    await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false, readProjections: reader });
    await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false, readProjections: reader });
    expect(reader.calls.filter(([k]) => k === 'fleet')).toHaveLength(1);
    expect(seen.fleetCfgs).toHaveLength(0); // never the in-process fleet build

    // Past the fresh window, with the worker busy: answer immediately, stale.
    vi.setSystemTime(start + 6_000);
    reader.hold = true;
    const snap = await controlApi.buildVerseControlSnapshot(cfg(), { dispatchEnabled: false, readProjections: reader });
    expect(snap.fleet.freshness.stale).toBe(true);
    expect(snap.fleet.freshness.ageMs).toBeGreaterThanOrEqual(6_000);
    expect(reader.calls.filter(([k]) => k === 'fleet')).toHaveLength(2);
    reader.hold = false;
    reader.release();
  });
});

describe('GET /api/verse/usage-series', () => {
  it('refreshes the rollup on the worker and serves repeats from the cache', async () => {
    const reader = fakeReader();
    const first = await call('/api/verse/usage-series?window=7d', { readProjections: reader });
    expect(first.status).toBe(200);
    expect((first.body as { byDay: Array<{ day: string }> }).byDay[0]!.day).toBe('worker-1');
    const second = await call('/api/verse/usage-series?window=7d', { readProjections: reader });
    expect((second.body as { byDay: Array<{ day: string }> }).byDay[0]!.day).toBe('worker-1');
    expect(reader.calls).toEqual([['pulse', { window: '7d' }]]);
    expect(seen.rollupBuilds).toBe(0);
  });

  it('without a worker, computes in-process once and caches', async () => {
    await call('/api/verse/usage-series?window=30d');
    await call('/api/verse/usage-series?window=30d');
    expect(seen.rollupBuilds).toBe(1);
  });
});

describe('shared runtime probe', () => {
  it('GET /runtime and GET /fleet share one probe within 3 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const runtime = await call('/api/verse/runtime');
    expect(runtime.status).toBe(200);
    const fleet = await call('/api/verse/fleet');
    expect(fleet.status).toBe(200);
    expect(seen.runtimeCalls).toBe(1);
    vi.setSystemTime(start + 3_500);
    await call('/api/verse/fleet');
    expect(seen.runtimeCalls).toBe(2);
  });
});
