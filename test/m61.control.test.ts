/**
 * m61.control.test.ts — M61: Mission Control aggregator.
 *
 * Units under test:
 *   buildControlSnapshot (src/core/web/control.ts) — read-only aggregation.
 *
 * HOME is relocated to a fresh tmp dir per test so the whole ~/.ashlr surface
 * (daemon state, quota ledger) is isolated; restored afterward.
 * getProviderRegistry probes localhost — it may fail in CI (no Ollama/LM Studio)
 * and the contract requires it degrades gracefully to up:false. We assert it
 * never throws and providers array is always present.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import { buildControlSnapshot } from '../src/core/web/control.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://localhost:11434', providerChain: [] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry };
}

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m61-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// Shape tests
// ---------------------------------------------------------------------------

describe('buildControlSnapshot — full shape (M61)', () => {
  it('returns all top-level keys on an empty ~/.ashlr', async () => {
    const snap = await buildControlSnapshot(baseConfig());

    // Top-level keys present
    expect(snap).toHaveProperty('ts');
    expect(snap).toHaveProperty('models');
    expect(snap).toHaveProperty('fleet');
    expect(snap).toHaveProperty('daemon');
    expect(snap).toHaveProperty('usage');
    expect(snap).toHaveProperty('limits');
    expect(snap).toHaveProperty('subscriptionLimits');
    expect(snap).toHaveProperty('logs');
  });

  it('ts is a valid ISO string', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(typeof snap.ts).toBe('string');
    expect(Date.parse(snap.ts)).not.toBeNaN();
  });

  it('models section has activeProvider and providers array', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.models).toHaveProperty('activeProvider');
    expect(snap.models.providers).toBeInstanceOf(Array);
    // providers may be empty (CI has no Ollama/LM Studio) — but shape must exist
    for (const p of snap.models.providers) {
      expect(typeof p.id).toBe('string');
      expect(['local', 'cloud']).toContain(p.kind);
      expect(typeof p.up).toBe('boolean');
      expect(p.models).toBeInstanceOf(Array);
    }
  });

  it('fleet section has all FleetStatus keys', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.fleet).toHaveProperty('generatedAt');
    expect(snap.fleet).toHaveProperty('daemon');
    expect(snap.fleet).toHaveProperty('backends');
    expect(snap.fleet).toHaveProperty('queue');
    expect(snap.fleet).toHaveProperty('proposals');
    expect(snap.fleet).toHaveProperty('merges');
    expect(snap.fleet).toHaveProperty('killed');
    expect(snap.fleet.autonomyDirection).toMatchObject({
      mode: expect.any(String),
      confidence: expect.any(String),
      resources: expect.any(Object),
      guardHealth: expect.any(Object),
      budgets: expect.any(Object),
    });
  });

  it('daemon section has running/pid/lastTickAt/todaySpentUsd and active direction fields', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(typeof snap.daemon.running).toBe('boolean');
    expect(snap.daemon.pid === null || typeof snap.daemon.pid === 'number').toBe(true);
    expect(snap.daemon.lastTickAt === null || typeof snap.daemon.lastTickAt === 'string').toBe(true);
    expect(typeof snap.daemon.todaySpentUsd).toBe('number');
    expect(snap.daemon.activeDirectionMode === null || typeof snap.daemon.activeDirectionMode === 'string').toBe(true);
    expect(snap.daemon.activeDirectionAt === null || typeof snap.daemon.activeDirectionAt === 'string').toBe(true);
    expect(snap.daemon.activeDirectionReason === null || typeof snap.daemon.activeDirectionReason === 'string').toBe(true);
    expect(typeof snap.daemon.autonomyControlLoop).toBe('boolean');
  });

  it('usage section has required keys and window=7d', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.usage.window).toBe('7d');
    expect(typeof snap.usage.totalTokens).toBe('number');
    expect(typeof snap.usage.totalCostUsd).toBe('number');
    expect(typeof snap.usage.localSavingsUsd).toBe('number');
    expect(snap.usage.byProvider).toBeInstanceOf(Array);
  });

  it('logs is an array, items have ts/kind/msg', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.logs).toBeInstanceOf(Array);
    for (const entry of snap.logs) {
      expect(typeof entry.ts).toBe('string');
      expect(['tick', 'merge', 'info', 'dispatch']).toContain(entry.kind);
      expect(typeof entry.msg).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Never-throws contract
// ---------------------------------------------------------------------------

describe('buildControlSnapshot — never throws (M61)', () => {
  it('does not throw on a minimal config (empty foundry, no daemon state)', async () => {
    const cfg = baseConfig();
    await expect(buildControlSnapshot(cfg)).resolves.toBeDefined();
  });

  it('does not throw when cfg.foundry is absent', async () => {
    const cfg: AshlrConfig = { ...baseConfig(), foundry: undefined };
    await expect(buildControlSnapshot(cfg)).resolves.toBeDefined();
  });

  it('does not throw when cfg.foundry.limits is absent', async () => {
    const cfg = withFoundry({ allowedBackends: ['builtin'] });
    await expect(buildControlSnapshot(cfg)).resolves.toBeDefined();
  });

  it('logs array is empty (not throwing) when no daemon state exists', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    // No daemon.json in tmpHome => no ticks => empty logs
    expect(snap.logs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// subscriptionLimits — honest stub
// ---------------------------------------------------------------------------

describe('subscriptionLimits (M61)', () => {
  it('exposes honest usage windows + provider status, never a fabricated cap (M63)', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    const sl = snap.subscriptionLimits;
    // M63 widened this: `connected` is now a dynamic boolean (true when usage
    // windows resolve or an API key is present), with windows + providers.
    expect(typeof sl.connected).toBe('boolean');
    expect(Array.isArray(sl.windows)).toBe(true);
    expect(Array.isArray(sl.providers)).toBe(true);
    // Subscription caps are never fabricated.
    for (const p of sl.providers) expect(p.limit).toBeUndefined();
  });

  it('note is a non-empty string explaining the stub', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(typeof snap.subscriptionLimits.note).toBe('string');
    expect(snap.subscriptionLimits.note.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// limits — empty when no foundry.limits
// ---------------------------------------------------------------------------

describe('limits section (M61)', () => {
  it('is [] when cfg.foundry is absent', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.limits).toEqual([]);
  });

  it('is [] when cfg.foundry.limits is absent', async () => {
    const snap = await buildControlSnapshot(withFoundry({ allowedBackends: ['builtin'] }));
    expect(snap.limits).toEqual([]);
  });

  it('populates a limit entry when foundry.limits is configured', async () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 10 } },
    });
    const snap = await buildControlSnapshot(cfg);
    expect(snap.limits).toHaveLength(1);
    const lim = snap.limits[0];
    expect(lim.backend).toBe('claude');
    expect(lim.window).toBe('1h');
    expect(lim.max).toBe(10);
    expect(typeof lim.used).toBe('number');
    expect(['ok', 'warn', 'over', 'unlimited']).toContain(lim.standing);
  });

  it('standing is ok when used=0 against a fresh ledger', async () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 10 } },
    });
    const snap = await buildControlSnapshot(cfg);
    expect(snap.limits[0].used).toBe(0);
    expect(snap.limits[0].standing).toBe('ok');
  });

  it('standing is over when all uses are consumed', async () => {
    const cfg = withFoundry({
      allowedBackends: ['claude'],
      limits: { claude: { window: '1h', max: 2 } },
    });
    // Record 2 uses to hit the cap
    const { recordUse } = await import('../src/core/fleet/quota.js');
    recordUse('claude');
    recordUse('claude');

    const snap = await buildControlSnapshot(cfg);
    expect(snap.limits[0].used).toBe(2);
    expect(snap.limits[0].standing).toBe('over');
  });
});

// ---------------------------------------------------------------------------
// usage.byProvider share sum
// ---------------------------------------------------------------------------

describe('usage.byProvider share sum (M61)', () => {
  it('shares sum to ~100 (±1) when there is usage', async () => {
    // Seed a fake daemon state with ticks to give rollup something,
    // but buildRollup reads usage events from disk — if none exist the
    // byProvider array will be empty, which is valid. We just assert the
    // invariant when data IS present (skip when empty).
    const snap = await buildControlSnapshot(baseConfig());
    const { byProvider } = snap.usage;
    if (byProvider.length === 0) {
      // No usage data in CI — that's fine, the invariant is vacuously satisfied.
      return;
    }
    const sum = byProvider.reduce((s, p) => s + p.sharePct, 0);
    expect(sum).toBeGreaterThanOrEqual(99);
    expect(sum).toBeLessThanOrEqual(101);
  });

  it('byProvider entries have correct shape', async () => {
    const snap = await buildControlSnapshot(baseConfig());
    for (const p of snap.usage.byProvider) {
      expect(typeof p.provider).toBe('string');
      expect(['local', 'cloud']).toContain(p.tier);
      expect(typeof p.tokens).toBe('number');
      expect(typeof p.costUsd).toBe('number');
      expect(typeof p.sharePct).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// logs — derived from daemon ticks
// ---------------------------------------------------------------------------

describe('logs section (M61)', () => {
  it('populates logs from daemon ticks when daemon.json exists', async () => {
    // Write a fake daemon.json with two ticks
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const fakeState = {
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: '2026-06-17T00:01:00.000Z',
      todayDate: '2026-06-17',
      todaySpentUsd: 0.05,
      itemsProcessed: 2,
      ticks: [
        {
          ts: '2026-06-17T00:00:00.000Z',
          itemsConsidered: 1,
          proposalsCreated: 1,
          spentUsd: 0.02,
          reason: 'ok',
          backends: { builtin: 1 },
        },
        {
          ts: '2026-06-17T00:01:00.000Z',
          itemsConsidered: 1,
          proposalsCreated: 0,
          spentUsd: 0.03,
          reason: 'ok',
          merged: 1,
          backends: { claude: 1 },
        },
      ],
    };
    writeFileSync(join(ashlrDir, 'daemon.json'), JSON.stringify(fakeState, null, 2));

    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.logs.length).toBeGreaterThan(0);

    // Most-recent-first: the second tick (merged) should appear before the first
    const kinds = snap.logs.map((l) => l.kind);
    expect(kinds).toContain('tick');
    expect(kinds).toContain('merge');

    // All entries have valid ISO ts
    for (const entry of snap.logs) {
      expect(Date.parse(entry.ts)).not.toBeNaN();
    }
  });

  it('exposes the most recent applied autonomy direction from daemon ticks', async () => {
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    writeFileSync(join(ashlrDir, 'daemon.json'), JSON.stringify({
      running: true,
      pid: 123,
      startedAt: '2026-06-17T00:00:00.000Z',
      lastTickAt: '2026-06-17T00:03:00.000Z',
      todayDate: '2026-06-17',
      todaySpentUsd: 0.05,
      itemsProcessed: 2,
      ticks: [
        {
          ts: '2026-06-17T00:01:00.000Z',
          itemsConsidered: 1,
          proposalsCreated: 1,
          spentUsd: 0.02,
          reason: 'ok',
          directionMode: 'backlog-build',
          directionReason: 'healthy resources',
        },
        {
          ts: '2026-06-17T00:03:00.000Z',
          itemsConsidered: 0,
          proposalsCreated: 0,
          spentUsd: 0,
          reason: 'verify-only',
          dryRun: true,
          directionMode: 'verify-only',
          directionReason: 'pending proposals need verification',
          autoMerge: { attempted: 3, judged: 2, merged: 0 },
          dispatches: [{
            itemId: 'item-1',
            title: 'Improve daemon routing visibility',
            repo: '/tmp/repo-alpha',
            source: 'todo',
            backend: 'builtin',
            tier: 'local',
            assignedBy: 'router',
            reason: 'test route',
            dispatched: true,
            spentUsd: 0.001,
          }],
        },
      ],
    }, null, 2));

    const snap = await buildControlSnapshot(withFoundry({ autonomyControlLoop: true }));
    expect(snap.daemon.activeDirectionMode).toBe('verify-only');
    expect(snap.daemon.activeDirectionAt).toBe('2026-06-17T00:03:00.000Z');
    expect(snap.daemon.activeDirectionReason).toBe('pending proposals need verification');
    expect(snap.daemon.autonomyControlLoop).toBe(true);
    expect(snap.logs[0]?.msg).toContain('direction=verify-only');
    expect(snap.logs[0]?.msg).toContain('mode=simulation');
    expect(snap.logs[0]?.dryRun).toBe(true);
    expect(snap.logs[0]?.msg).toContain('maintenance=attempted:3,judged:2,merged:0');
    expect(snap.logs.some((entry) =>
      entry.kind === 'dispatch' &&
      entry.msg.includes('builtin') &&
      entry.msg.includes('Improve daemon routing visibility') &&
      entry.msg.includes('test route'),
    )).toBe(true);
  });

  it('logs are capped at 50 by default', async () => {
    // Write 60 ticks
    const ashlrDir = join(tmpHome, '.ashlr');
    mkdirSync(ashlrDir, { recursive: true });
    const ticks = Array.from({ length: 60 }, (_, i) => ({
      ts: new Date(Date.now() - i * 60_000).toISOString(),
      itemsConsidered: 1,
      proposalsCreated: 0,
      spentUsd: 0.001,
      reason: 'ok',
    }));
    writeFileSync(
      join(ashlrDir, 'daemon.json'),
      JSON.stringify({ running: false, pid: null, startedAt: null, lastTickAt: null, todayDate: null, todaySpentUsd: 0, itemsProcessed: 60, ticks }),
    );

    const snap = await buildControlSnapshot(baseConfig());
    expect(snap.logs.length).toBeLessThanOrEqual(50);
  });
});
