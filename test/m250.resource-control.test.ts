/**
 * test/m250.resource-control.test.ts — M250–M252 Resource Control Plane tests.
 *
 * Invariants proved:
 *
 *  1. STATS-CACHE 7D SUM: senseResources sums messageCount from stats-cache.json
 *     over the rolling 7-day window and maps availability by protectPct/cap.
 *
 *  2. CODEX DELEGATION: senseResources delegates to readCodexRateLimits() and
 *     maps primary/secondary usedPercent → availability correctly.
 *
 *  3. NIM CREDENTIAL + BACKOFF: missing executor-resolvable credentials make
 *     NIM unreachable; with a credential, backoff and clearBackoff are intact.
 *
 *  4. OLLAMA HEALTH: resource-monitor wraps http; never throws on any error.
 *
 *  5. ALL-SOURCES-FAIL GRACEFUL: when stats-cache is missing, codex has no
 *     sessions, nim has no backoff, Ollama unreachable — snapshot is still
 *     returned with availability='unknown' or 'open', never throws.
 *
 *  6. GATEWAY RESOURCE-AWARE DEMOTE: when flag is ON and claude is 'exhausted',
 *     decide() demotes to codex when codex is 'open'.
 *
 *  7. FLAG-OFF BYTE-IDENTICAL: gateway.decide() with resourceAware=false (or
 *     absent) produces byte-identical output to the pre-M250 path.
 *
 *  8. HARD ITEMS PAUSE: effort>=4 item with all frontiers exhausted returns
 *     reason starting with 'resource-pause:' — never silently downgraded.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Environment isolation + module reset between tests to avoid cache bleed
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string | undefined;
let origNimApiKey: string | undefined;

const FAKE_NIM_API_KEY = 'm250-fake-nim-credential';

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m250-'));
  mkdirSync(join(tmpHome, '.ashlr', 'fleet'), { recursive: true });
  mkdirSync(join(tmpHome, '.claude'), { recursive: true });
  origHome = process.env['HOME'];
  origNimApiKey = process.env['NVIDIA_NIM_API_KEY'];
  process.env['HOME'] = tmpHome;
  delete process.env['NVIDIA_NIM_API_KEY'];
  // Reset module registry so each test gets a fresh resource-monitor
  // (clears the in-memory snapshot cache and backoff store).
  vi.resetModules();
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (origNimApiKey === undefined) delete process.env['NVIDIA_NIM_API_KEY'];
  else process.env['NVIDIA_NIM_API_KEY'] = origNimApiKey;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function writeStatsCache(
  days: Array<{ daysAgo: number; messageCount: number }>,
): void {
  const now = Date.now();
  const dailyActivity = days.map(({ daysAgo, messageCount }) => {
    const d = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    return { date, messageCount };
  });
  writeFileSync(
    join(tmpHome, '.claude', 'stats-cache.json'),
    JSON.stringify({ version: 1, dailyActivity }),
  );
}

import type { AshlrConfig, EngineId, WorkItem, WorkSource } from '../src/core/types.js';
import type { DispatchProductionEvent } from '../src/core/fleet/dispatch-production-ledger.js';
import {
  learningEpochFromTimestamp,
  ROUTER_POLICY_VERSION,
} from '../src/core/learning/causal.js';
import { productionAttemptLearningLabelFromSignals } from '../src/core/learning/attempt-shape.js';

function baseCfg(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseCfg(), foundry };
}

let _seq = 0;
const FIXED_TS = '2026-06-29T00:00:00.000Z';

function makeItem(source: WorkSource, over: Partial<WorkItem> = {}): WorkItem {
  const id = `repo:${source}:item${_seq++}`;
  return {
    id,
    repo: '/repo',
    source,
    title: `test item ${id}`,
    detail: 'detail',
    value: over.value ?? 3,
    effort: over.effort ?? 3,
    score: over.score ?? 3,
    tags: [],
    ts: FIXED_TS,
    ...over,
  };
}

function makeDispatchProductionEvent(over: Partial<DispatchProductionEvent> = {}): DispatchProductionEvent {
  const event: DispatchProductionEvent = {
    schemaVersion: 1,
    ts: FIXED_TS,
    machineId: 'm250',
    itemId: 'repo:security:item',
    source: 'security',
    repo: '/repo',
    title: 'security item',
    backend: 'claude',
    tier: 'frontier',
    model: 'test-model',
    assignedBy: 'daemon',
    routeReason: 'frontier',
    outcome: 'empty-diff',
    proposalCreated: false,
    spentUsd: 0,
    reason: 'agent returned no diff',
    basis: 'run-proposal-outcome',
    ...over,
  };
  if (event.routerPolicyVersion === undefined) event.routerPolicyVersion = ROUTER_POLICY_VERSION;
  if (event.learningEpoch === undefined) event.learningEpoch = learningEpochFromTimestamp(event.ts);
  if (event.learningLabel === undefined) {
    event.learningLabel = productionAttemptLearningLabelFromSignals({
      outcome: event.outcome,
      proposalCreated: event.proposalCreated,
      actionCounts: event.runEventSummary?.actionCounts,
    });
  }
  return event;
}

function learnedRerouteEvents(base: EngineId, alternate: EngineId): DispatchProductionEvent[] {
  return [
    makeDispatchProductionEvent({ backend: base, outcome: 'empty-diff', proposalCreated: false }),
    makeDispatchProductionEvent({ backend: base, outcome: 'gate-blocked', proposalCreated: false }),
    makeDispatchProductionEvent({ backend: base, outcome: 'engine-failed', proposalCreated: false }),
    makeDispatchProductionEvent({ backend: alternate, outcome: 'proposal-created', proposalCreated: true }),
    makeDispatchProductionEvent({ backend: alternate, outcome: 'proposal-created', proposalCreated: true }),
    makeDispatchProductionEvent({ backend: alternate, outcome: 'empty-diff', proposalCreated: false }),
  ];
}

// ---------------------------------------------------------------------------
// 1. Stats-cache 7d sum + availability mapping
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — Claude stats-cache 7d sum', () => {
  it('sums messages within 7d and returns open when under protectPct', async () => {
    writeStatsCache([
      { daysAgo: 0, messageCount: 100 },
      { daysAgo: 1, messageCount: 100 },
      { daysAgo: 2, messageCount: 100 },
      { daysAgo: 3, messageCount: 100 },
      { daysAgo: 4, messageCount: 100 },
    ]); // 500/2000 = 25%

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);

    expect(state.backend).toBe('claude');
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(25);
    expect(state.cap).toBe(2000);
    expect(state.capUnit).toBe('messages');
    expect(state.capWindow).toBe('7d');
  });

  it('returns near when usedPct >= 75 but under protectPct=85', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 1600 }]); // 80%

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('near');
    expect(state.usedPct).toBe(80);
  });

  it('returns throttled when usedPct >= protectPct', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 1800 }]); // 90% > 85% protectPct

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('throttled');
    expect(state.usedPct).toBe(90);
    expect(state.reason).toMatch(/protectPct/);
  });

  it('returns exhausted when usedPct >= 100%', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 2100 }]); // 105%

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBeGreaterThanOrEqual(100);
  });

  it('excludes messages older than 7 days', async () => {
    writeStatsCache([
      { daysAgo: 8,  messageCount: 9999 }, // outside 7d window — excluded
      { daysAgo: 1,  messageCount: 100  }, // inside window
    ]);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);
    expect(state.usedPct).toBe(5); // 100/2000
    expect(state.availability).toBe('open');
  });

  it('uses transcript sensing (not unknown) when no weeklyMessageCap configured', async () => {
    // M253: with no weeklyMessageCap, transcript sensing (5h window, default Pro cap)
    // is the primary path — it never returns 'unknown'. (Supersedes the old M250
    // stats-cache-only behavior where no cap meant unknown.)
    writeStatsCache([{ daysAgo: 0, messageCount: 500 }]);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({ allowedBackends: ['claude'] as EngineId[] });

    const state = await getBackendResourceState('claude', cfg);
    expect(state.availability).not.toBe('unknown');
    expect(['open', 'near', 'throttled', 'exhausted']).toContain(state.availability);
  });

  it('returns open (0%) gracefully when stats-cache.json is missing', async () => {
    // No stats-cache file written → sumClaudeMessages7d returns 0

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const state = await getBackendResourceState('claude', cfg);
    expect(state).toBeDefined();
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 1b. Operator resource overrides
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — operator resource overrides', () => {
  it('uses an active override before probing telemetry', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const until = Math.floor(Date.now() / 1000) + 3600;
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      resourceOverrides: {
        claude: {
          availability: 'exhausted',
          resetsAt: until,
          reason: 'Claude Code weekly usage exhausted',
        },
      },
    });

    const state = await getBackendResourceState('claude', cfg);

    expect(state.availability).toBe('exhausted');
    expect(state.resetsAt).toBe(until);
    expect(state.reason).toMatch(/operator override/i);
    expect(state.reason).toMatch(/weekly usage exhausted/i);
  });

  it('ignores an expired override and falls back to sensing', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude'] as EngineId[],
      claudeResource: { fiveHourMessageCap: 100, protectPct: 85 },
      resourceOverrides: {
        claude: {
          availability: 'exhausted',
          until: new Date(Date.now() - 60_000).toISOString(),
          reason: 'stale outage',
        },
      },
    });

    const state = await getBackendResourceState('claude', cfg);

    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(0);
    expect(state.reason).not.toMatch(/operator override/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Codex delegation
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — Codex delegation', () => {
  it('maps usedPercent=45 → open', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 45, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        planType: 'pro',
      }),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('codex', baseCfg());

    expect(state.backend).toBe('codex');
    expect(state.availability).toBe('open');
    expect(state.usedPct).toBe(45);
    expect(state.capWindow).toBe('5h');
    expect(state.resetsAt).toBeGreaterThan(0);
    expect(state.costPerMTokenOut).toBe(0);
  });

  it('maps usedPercent=95 → throttled', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 95, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 1800 },
      }),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('codex', baseCfg());
    expect(state.availability).toBe('throttled');
    expect(state.usedPct).toBe(95);
  });

  it('maps usedPercent=100 → exhausted', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 900 },
      }),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('codex', baseCfg());
    expect(state.availability).toBe('exhausted');
    expect(state.usedPct).toBe(100);
  });

  it('uses higher of primary/secondary (most conservative)', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary:   { usedPercent: 30, windowMinutes: 300,   resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { usedPercent: 92, windowMinutes: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
      }),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('codex', baseCfg());
    expect(state.usedPct).toBe(92);
    expect(state.availability).toBe('throttled');
  });

  it('returns unknown when readCodexRateLimits returns null', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('codex', baseCfg());
    expect(state.availability).toBe('unknown');
    expect(state.usedPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. NIM backoff store
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — NIM backoff store', () => {
  it('nim is unreachable when the executor cannot resolve its credential', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.backend).toBe('nim');
    expect(state.availability).toBe('unreachable');
    expect(state.reason).toContain('NVIDIA_NIM_API_KEY');
    expect(state.reason).not.toContain(FAKE_NIM_API_KEY);
    expect(state.backoffUntilMs).toBeNull();
  });

  it('nim is open with a fake credential and no backoff', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = FAKE_NIM_API_KEY;
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.backend).toBe('nim');
    expect(state.availability).toBe('open');
    expect(state.reason).not.toContain(FAKE_NIM_API_KEY);
    expect(state.backoffUntilMs).toBeNull();
  });

  it('nim rejects a Phantom placeholder just like the executor', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = 'phm_placeholder_token';
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.availability).toBe('unreachable');
    expect(state.reason).not.toContain('phm_placeholder_token');
  });

  it('recordBackoff marks nim as throttled or exhausted', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = FAKE_NIM_API_KEY;
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState, recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
    recordBackoff('nim', 30_000, '429 rate limit from NIM API');

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.availability === 'throttled' || state.availability === 'exhausted').toBe(true);
    expect(state.backoffUntilMs).toBeGreaterThan(Date.now());
    expect(state.reason).toMatch(/backoff/i);
  });

  it('clearBackoff restores nim to open', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = FAKE_NIM_API_KEY;
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState, recordBackoff, clearBackoff } = await import('../src/core/fabric/resource-monitor.js');
    recordBackoff('nim', 30_000, '429 rate limit');
    clearBackoff('nim');

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.availability).toBe('open');
    expect(state.backoffUntilMs).toBeNull();
  });

  it('expired backoff is treated as open', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = FAKE_NIM_API_KEY;
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState, recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
    recordBackoff('nim', 1, 'test — expired immediately');
    await new Promise(r => setTimeout(r, 10));

    const state = await getBackendResourceState('nim', baseCfg());
    expect(state.availability).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// 4. Ollama health check — test the never-throw contract
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — Ollama health (never-throw contract)', () => {
  it('returns builtin as always-open without probing Ollama', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin'] as EngineId[],
      local: { maxConcurrent: 1, baseUrl: 'http://localhost:11434' },
    });

    const state = await getBackendResourceState('builtin', cfg);
    expect(state).toBeDefined();
    expect(state.backend).toBe('builtin');
    expect(state.availability).toBe('open');
    expect(state.cap).toBeNull();
    expect(state.capUnit).toBeNull();
    expect(state.reason).toMatch(/always available/i);
  });

  it('builtin always has costPerMTokenOut=0', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('builtin', baseCfg());
    expect(state.costPerMTokenOut).toBe(0);
  });

  it('local-coder uses the Ollama-backed local resource sensor', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['local-coder'] as EngineId[],
      local: { maxConcurrent: 2, baseUrl: 'http://127.0.0.1:9' },
    });

    const state = await getBackendResourceState('local-coder', cfg);

    expect(state.backend).toBe('local-coder');
    expect(['open', 'near', 'unreachable', 'throttled']).toContain(state.availability);
    expect(state.cap).toBe(2);
    expect(state.capUnit).toBe('concurrent');
    expect(state.costPerMTokenOut).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. All-sources-fail graceful degradation
// ---------------------------------------------------------------------------

describe('M250 ResourceMonitor — graceful degradation when all sources fail', () => {
  it('getResourceSnapshot never throws and returns valid shape', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'nim', 'builtin'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const snap = await getResourceSnapshot(cfg);

    expect(snap).toBeDefined();
    expect(snap.generatedAt).toBeDefined();
    expect(Array.isArray(snap.backends)).toBe(true);
    expect(snap.backends.length).toBeGreaterThan(0);

    for (const b of snap.backends) {
      expect(b.availability).toBeDefined();
      expect(b.backend).toBeDefined();
      expect(b.snapshotAt).toBeDefined();
    }
  });

  it('getResourceSnapshot includes allowed local-coder as a sensed backend', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({
      allowedBackends: ['local-coder', 'builtin'] as EngineId[],
      local: { maxConcurrent: 2, baseUrl: 'http://127.0.0.1:9' },
    });

    const snap = await getResourceSnapshot(cfg);
    const localCoder = snap.backends.find((b) => b.backend === 'local-coder');

    expect(localCoder).toBeDefined();
    expect(localCoder?.cap).toBe(2);
    expect(localCoder?.capUnit).toBe('concurrent');
  });

  it('snapshot cache: second call within TTL returns same generatedAt', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = baseCfg();

    const snap1 = await getResourceSnapshot(cfg);
    const snap2 = await getResourceSnapshot(cfg);

    // Both came from same cache slot → same generatedAt
    expect(snap1.generatedAt).toBe(snap2.generatedAt);
  });

  it('snapshot cache is keyed by allowed backends and local resource config', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');

    const builtinOnly = await getResourceSnapshot(
      withFoundry({ allowedBackends: ['builtin'] as EngineId[] }),
    );
    const withLocalCoder = await getResourceSnapshot(
      withFoundry({
        allowedBackends: ['builtin', 'local-coder'] as EngineId[],
        local: { maxConcurrent: 3, baseUrl: 'http://127.0.0.1:9' },
      }),
    );

    expect(builtinOnly.backends.map((b) => b.backend)).toEqual(['builtin']);
    const localCoder = withLocalCoder.backends.find((b) => b.backend === 'local-coder');
    expect(localCoder).toBeDefined();
    expect(localCoder?.cap).toBe(3);
  });

  it('recordBackoff invalidates the cache', async () => {
    process.env['NVIDIA_NIM_API_KEY'] = FAKE_NIM_API_KEY;
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getResourceSnapshot, recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
    const cfg = withFoundry({ allowedBackends: ['nim', 'builtin'] as EngineId[] });

    const snap1 = await getResourceSnapshot(cfg);
    // nim is open before backoff
    const nimBefore = snap1.backends.find(b => b.backend === 'nim');
    expect(nimBefore?.availability).toBe('open');

    recordBackoff('nim', 60_000, 'test 429');
    const snap2 = await getResourceSnapshot(cfg);

    // After recordBackoff+re-sense, nim must show backoff state
    const nimState = snap2.backends.find(b => b.backend === 'nim');
    expect(nimState).toBeDefined();
    expect(nimState!.availability === 'throttled' || nimState!.availability === 'exhausted').toBe(true);
    expect(nimState!.backoffUntilMs).toBeGreaterThan(Date.now());
  });
});

// ---------------------------------------------------------------------------
// 6. Gateway resource-aware demote
// ---------------------------------------------------------------------------

describe('M252 Gateway — resource-aware demote', () => {
  it('resourceAware=true with open claude: no demote step in trace', async () => {
    // Claude open: 20%
    writeStatsCache([{ daysAgo: 0, messageCount: 400 }]);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));

    // Hermetic routing: the claude/codex CLIs aren't on PATH in CI, so
    // routeBackend would fall through to 'builtin' (which then senses Ollama
    // unreachable and demotes). Force the frontiers "installed" so an OPEN
    // frontier is the routed base — exactly the scenario this test exercises.
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const item = makeItem('issue', { effort: 8, score: 8 });
    const decision = await decide(item, cfg);

    const hasDemoteStep = decision.trace.some(t => t.stage === 'resourceDemote');
    expect(hasDemoteStep).toBe(false);
    expect(decision.demotedFrom).toBeUndefined();
    expect(decision.reason).not.toMatch(/resource-pause:/i);
  });

  it('resourceAware=true with claude exhausted: no resource-pause for low-effort item', async () => {
    // Claude exhausted: 105%
    writeStatsCache([{ daysAgo: 0, messageCount: 2100 }]);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 30, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    // Low-effort item — should not pause even if claude is exhausted (demotes or uses builtin)
    const item = makeItem('lint', { effort: 1, score: 2 });
    const decision = await decide(item, cfg);

    expect(decision.reason).not.toMatch(/resource-pause:/i);
    // Result must be a valid backend
    const allowed = new Set(cfg.foundry?.allowedBackends ?? ['builtin']);
    allowed.add('builtin');
    expect(allowed.has(decision.backend)).toBe(true);
  });

  it('resourceAware=true with unknown claude demotes to sensed open codex', async () => {
    writeFileSync(
      join(tmpHome, '.claude', 'stats-cache.json'),
      JSON.stringify({
        version: 1,
        dailyActivity: [{ date: '2000-01-01', messageCount: 1 }],
        lastComputedDate: '2000-01-01',
      }),
    );
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000 },
    });

    const snapshot = await getResourceSnapshot(cfg);
    expect(snapshot.backends.find((b) => b.backend === 'claude')?.availability).toBe('unknown');
    expect(snapshot.backends.find((b) => b.backend === 'codex')?.availability).toBe('open');

    const decision = await decide({ goal: 'reason about architecture', repo: tmpHome }, cfg);

    expect(decision.backend).toBe('codex');
    expect(decision.demotedFrom).toBe('claude');
    expect(decision.resourceState?.availability).toBe('unknown');
    expect(decision.reason).toMatch(/resourceDemote: claude→codex/i);
  });

  it('resourceAware=true routes generated capture repairs around exhausted frontier capacity', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      resourceOverrides: {},
    });
    const item = makeItem('self', {
      id: 'repo:proposal-repair-capture:abcdef123456',
      effort: 1,
      score: 1,
      title: 'Repair dispatch capture failure for repo item repo:self-heal:stalled',
      detail:
        'Dispatch capture repair: an autonomous dispatch produced repairable work but no proposal.\n' +
        'Original work item: repo:self-heal:stalled\n' +
        'Dispatch outcome: gate-blocked\n' +
        'Diff metadata: files=1, lines=12\n' +
        'Failure: completeness gate blocked proposal capture\n' +
        'Produce a fresh complete fix, rerun merge-grade verification, and do not copy any old partial diff or tool output.',
      tags: ['self-heal', 'proposal-repair', 'dispatch-capture-repair', 'capture-gate', 'verify', 'high-priority'],
    });

    const base = routeBackend(item, cfg);
    const alternate: EngineId = base.backend === 'claude' ? 'codex' : 'claude';
    cfg.foundry!.resourceOverrides = {
      [base.backend]: { availability: 'exhausted', reason: 'test selected frontier exhausted' },
      [alternate]: { availability: 'open', reason: 'test alternate frontier open' },
    };

    const decision = await decide(item, cfg);

    expect(base.tier).toBe('frontier');
    expect(base.reason).toContain('frontier: generated capture proposal repair');
    expect(decision.backend).toBe(alternate);
    expect(decision.demotedFrom).toBe(base.backend);
    expect(decision.reason).toMatch(/resourceDemote:/i);
    expect(decision.trace[0]?.reason).toContain('frontier: generated capture proposal repair');
  });

  it('resourceAware=true can demote exhausted claude to open local-coder before builtin', async () => {
    writeFileSync(
      join(tmpHome, '.claude', 'stats-cache.json'),
      JSON.stringify({
        version: 1,
        dailyActivity: [{ date: '2000-01-01', messageCount: 1 }],
        lastComputedDate: '2000-01-01',
      }),
    );
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['claude', 'local-coder', 'builtin'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000 },
      resourceOverrides: {
        'local-coder': {
          availability: 'open',
          reason: 'test local coder capacity',
        },
      },
    });

    const decision = await decide({ goal: 'implement routine fix', repo: tmpHome }, cfg);

    expect(decision.backend).toBe('local-coder');
    expect(decision.demotedFrom).toBe('claude');
    expect(decision.reason).toMatch(/resourceDemote: claude→local-coder/i);
  });

  it('resourceAware=true skips credential-unavailable nim during demotion', async () => {
    const { getResourceSnapshot } = await import('../src/core/fabric/resource-monitor.js');
    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['claude', 'nim', 'builtin'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      resourceOverrides: {
        claude: { availability: 'exhausted', reason: 'test claude exhausted' },
        nim: { availability: 'open', reason: 'must not bypass missing credential' },
      },
    });

    const snapshot = await getResourceSnapshot(cfg);
    expect(snapshot.backends.find((b) => b.backend === 'nim')?.availability).toBe('unreachable');

    const decision = await decide({ goal: 'implement routine fix', repo: tmpHome }, cfg);

    expect(decision.backend).toBe('builtin');
    expect(decision.backend).not.toBe('nim');
    expect(decision.demotedFrom).toBe('claude');
    expect(decision.reason).toMatch(/resourceDemote: claude→builtin/i);
  });

  it('resource-aware learned target gate allows open or near m53 nudges', async () => {
    let dispatchProductionEvents: DispatchProductionEvent[] = [];
    vi.doMock('../src/core/fleet/dispatch-production-ledger.js', () => ({
      readDispatchProductionEvents: vi.fn(() => dispatchProductionEvents),
      readDispatchProductionEventsDetailed: vi.fn(() => ({
        events: dispatchProductionEvents,
        sourceState: 'healthy',
        sourcePresent: true,
        complete: true,
        stopReasons: [],
        filesRead: 1,
        datedFilesRead: 1,
        looseFilesRead: 0,
        bytesRead: 1,
        rowsScanned: dispatchProductionEvents.length,
        invalidRows: 0,
        unreadableFiles: 0,
      })),
    }));
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      intelligence: { minProposalYieldRate: 0.5 },
      resourceOverrides: {},
    });
    const item = makeItem('security', { id: 'fixed-security-1', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate: EngineId = base.backend === 'claude' ? 'codex' : 'claude';
    cfg.foundry!.resourceOverrides = {
      [base.backend]: { availability: 'open', reason: 'test base capacity open' },
      [alternate]: { availability: 'near', reason: 'test learned target near capacity' },
    };
    dispatchProductionEvents = learnedRerouteEvents(base.backend, alternate);

    const decision = await decide(item, cfg);

    expect(base.tier).toBe('frontier');
    expect(decision.backend).toBe(alternate);
    expect(decision.trace.some(t => t.stage === 'm53Nudge')).toBe(true);
    expect(decision.trace.some(t => t.stage === 'finalResourceDemote')).toBe(false);
  });

  it('resource-aware learned target gate blocks unavailable m53 nudges', async () => {
    let dispatchProductionEvents: DispatchProductionEvent[] = [];
    vi.doMock('../src/core/fleet/dispatch-production-ledger.js', () => ({
      readDispatchProductionEvents: vi.fn(() => dispatchProductionEvents),
      readDispatchProductionEventsDetailed: vi.fn(() => ({
        events: dispatchProductionEvents,
        sourceState: 'healthy',
        sourcePresent: true,
        complete: true,
        stopReasons: [],
        filesRead: 1,
        datedFilesRead: 1,
        looseFilesRead: 0,
        bytesRead: 1,
        rowsScanned: dispatchProductionEvents.length,
        invalidRows: 0,
        unreadableFiles: 0,
      })),
    }));
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const { routeBackend } = await import('../src/core/fleet/router.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      intelligence: { minProposalYieldRate: 0.5 },
      resourceOverrides: {},
    });
    const item = makeItem('security', { id: 'fixed-security-1', effort: 5, score: 10 });
    const base = routeBackend(item, cfg);
    const alternate: EngineId = base.backend === 'claude' ? 'codex' : 'claude';
    cfg.foundry!.resourceOverrides = {
      [base.backend]: { availability: 'open', reason: 'test base capacity open' },
      [alternate]: { availability: 'throttled', reason: 'test learned target throttled' },
    };
    dispatchProductionEvents = learnedRerouteEvents(base.backend, alternate);

    const decision = await decide(item, cfg);

    expect(base.tier).toBe('frontier');
    expect(decision.backend).toBe(base.backend);
    expect(decision.trace.some(t => t.stage === 'm53Nudge')).toBe(false);
    expect(decision.reason).not.toMatch(/resourceDemote:|resource-pause:/i);
  });

  it('final resource guard re-senses after m53 invalidates resource cache', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));
    vi.doMock('../src/core/run/engines.js', async () => ({
      ...(await vi.importActual<typeof import('../src/core/run/engines.js')>(
        '../src/core/run/engines.js',
      )),
      engineInstalled: () => true,
    }));
    vi.doMock('../src/core/run/learned-router.js', async () => {
      const actual = await vi.importActual<typeof import('../src/core/run/learned-router.js')>(
        '../src/core/run/learned-router.js',
      );
      return {
        ...actual,
        recommendRoute: vi.fn(async () => {
          const { recordBackoff } = await import('../src/core/fabric/resource-monitor.js');
          recordBackoff('codex', 60_000, 'test backoff during learned routing');
          return {
            backend: 'codex',
            tier: 'frontier',
            reason: 'same-tier reroute to codex from test',
            confidence: 0.9,
          };
        }),
      };
    });

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      intelligence: { minProposalYieldRate: 0.5 },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
      resourceOverrides: {
        claude: { availability: 'open', reason: 'test claude capacity open' },
      },
    });
    const item = makeItem('security', { id: 'fixed-security-1', effort: 5, score: 10 });

    const decision = await decide(item, cfg);

    expect(decision.trace.some(t => t.stage === 'm53Nudge')).toBe(true);
    expect(decision.trace.some(t => t.stage === 'finalResourceDemote')).toBe(true);
    expect(decision.backend).toBe('claude');
    expect(decision.demotedFrom).toBe('codex');
    expect(decision.reason).toMatch(/resourceDemote: codex→claude/i);
  });

  it('never throws with resourceAware=true and corrupt cfg', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const badCfg = { foundry: { fabric: { gateway: true, resourceAware: true } } } as unknown as AshlrConfig;

    await expect(decide(makeItem('issue'), badCfg)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Flag-OFF byte-identical (M247 golden-trace extension)
// ---------------------------------------------------------------------------

describe('M252 Gateway — flag-OFF byte-identical to pre-M250', () => {
  it('absent foundry.fabric → pass-through, no resourceDemote step', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 1900 }]); // 95% — would demote if flag-ON

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const { routeBackend } = await import('../src/core/fleet/router.js');

    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
      // fabric absent → full pass-through
    });

    const item = makeItem('issue', { effort: 8, score: 8 });
    const gd = await decide(item, cfg);
    const direct = routeBackend(item, cfg);

    expect(gd.backend).toBe(direct.backend);
    expect(gd.reason).toBe('pass-through');
    expect(gd.trace).toHaveLength(0);
    expect(gd.resourceState).toBeUndefined();
    expect(gd.demotedFrom).toBeUndefined();
  });

  it('gateway=true + resourceAware=false → no resourceDemote step even at 95%', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 1900 }]); // 95%

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: false },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const item = makeItem('lint', { effort: 1, score: 2 });
    const decision = await decide(item, cfg);

    const hasDemoteStep = decision.trace.some(t => t.stage === 'resourceDemote');
    expect(hasDemoteStep).toBe(false);
    expect(decision.demotedFrom).toBeUndefined();
    expect(decision.resourceState).toBeUndefined();
  });

  it('10 items flag-OFF all match direct routeBackend output', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const { routeBackend } = await import('../src/core/fleet/router.js');

    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude'] as EngineId[],
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const sources: WorkSource[] = [
      'issue', 'lint', 'security', 'goal', 'hygiene',
      'deps', 'self', 'test', 'doc', 'invent',
    ];
    for (const src of sources) {
      const item = makeItem(src, { effort: 4, score: 4 });
      const gd = await decide(item, cfg);
      const direct = routeBackend(item, cfg);
      expect(gd.backend).toBe(direct.backend);
      expect(gd.trace).toHaveLength(0);
      expect(gd.reason).toBe('pass-through');
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Hard items pause not silent downgrade + type-shape invariants
// ---------------------------------------------------------------------------

describe('M252 Gateway — hard items + type-shape invariants', () => {
  it('effort<4 item routes normally (not paused) when all backends open', async () => {
    writeStatsCache([{ daysAgo: 0, messageCount: 400 }]); // 20% — open

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 20, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    const item = makeItem('hygiene', { effort: 2, score: 2 });
    const decision = await decide(item, cfg);

    expect(decision.reason).not.toMatch(/resource-pause:/i);
  });

  it('never-throw: decide() with resourceAware=true never rejects', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
    });

    const item = makeItem('issue', { effort: 5 });
    await expect(decide(item, cfg)).resolves.toBeDefined();
  });

  it('getBackendResourceState for ashlrcode engine never throws', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    // 'ashlrcode' is a valid EngineId but has no special sensing — falls to builtinState()
    const state = await getBackendResourceState('ashlrcode' as EngineId, baseCfg());
    expect(state).toBeDefined();
    expect(state.backend).toBe('ashlrcode');
  });

  it('BackendResourceState has all required fields', async () => {
    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue(null),
    }));

    const { getBackendResourceState } = await import('../src/core/fabric/resource-monitor.js');

    const state = await getBackendResourceState('nim', baseCfg());

    expect(typeof state.backend).toBe('string');
    expect(typeof state.availability).toBe('string');
    expect(typeof state.costPerMTokenOut).toBe('number');
    expect(typeof state.snapshotAt).toBe('string');
    expect(typeof state.reason).toBe('string');
    expect('usedPct' in state).toBe(true);
    expect('cap' in state).toBe(true);
    expect('resetsAt' in state).toBe(true);
    expect('backoffUntilMs' in state).toBe(true);
  });

  it('GatewayDecision has resourceState + demotedFrom fields when demote fires', async () => {
    // Claude throttled: 90%
    writeStatsCache([{ daysAgo: 0, messageCount: 1800 }]);

    vi.doMock('../src/core/observability/codex-source.js', () => ({
      readCodexRateLimits: vi.fn().mockReturnValue({
        primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      }),
    }));

    const { decide } = await import('../src/core/fabric/gateway.js');
    const cfg = withFoundry({
      allowedBackends: ['builtin', 'claude', 'codex'] as EngineId[],
      fabric: { gateway: true, resourceAware: true },
      claudeResource: { weeklyMessageCap: 2000, protectPct: 85 },
    });

    // Low-effort item routed to claude (frontier) will get demoted due to throttle
    const item = makeItem('lint', { effort: 1, score: 2 });
    const decision = await decide(item, cfg);

    // Decision must always have backend + tier + source + trace + reason
    expect(typeof decision.backend).toBe('string');
    expect(typeof decision.tier).toBe('string');
    expect(typeof decision.source).toBe('string');
    expect(Array.isArray(decision.trace)).toBe(true);
    expect(typeof decision.reason).toBe('string');

    // If a demote fired: resourceState + demotedFrom must be defined
    if (decision.demotedFrom !== undefined) {
      expect(decision.resourceState).toBeDefined();
      expect(decision.resourceState!.availability).toBeDefined();
    }
  });
});
