/**
 * m114.shared-subscription.test.ts — M114: cross-machine subscription throttle.
 *
 * Tests the cross-machine awareness added to subscription-usage.ts:
 *
 *   Flag-off (no sharedQueue cfg) → byte-identical to M80 local-only behavior.
 *
 *   Shared mode (tmp dir):
 *     - Machine A publishes 85% for codex → ledger persists on disk.
 *     - Machine B (local reads 10%) is BLOCKED by subscriptionAllows at
 *       maxPercent=80 because it sees A's 85% via the ledger.
 *     - Expired entries (resetsAt in the past) are NOT used for aggregation.
 *     - Stale entries (older than maxAgeMs) are NOT used for aggregation.
 *     - Claude activity (no local %) is published with usedPercent=0 and is
 *       visible to siblings (but doesn't trigger a block on its own).
 *     - Unwritable path: subscriptionAllows falls back to local decision and
 *       never throws.
 *
 * Mirrors m80/m85 conventions: readCodexRateLimits is vi.mocked so no disk
 * access happens for the local-read path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodexRateLimits } from '../src/core/observability/codex-source.js';

// ---------------------------------------------------------------------------
// Mock readCodexRateLimits before importing the module under test
// ---------------------------------------------------------------------------

let mockRateLimitsReturn: CodexRateLimits | null = null;

vi.mock('../src/core/observability/codex-source.js', () => ({
  readCodexRateLimits: () => mockRateLimitsReturn,
  CODEX_PROVIDER_KEY: 'codex',
  collectCodexEvents: () => [],
}));

// Import after mock is registered.
import {
  subscriptionUsage,
  subscriptionAllows,
} from '../src/core/fleet/subscription-usage.js';
import { SharedStore } from '../src/core/fleet/shared-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRateLimits(primaryPct: number, secondaryPct?: number): CodexRateLimits {
  const baseResetsAt = Math.floor(Date.now() / 1000) + 3600; // 1h from now
  return {
    primary: {
      usedPercent: primaryPct,
      windowMinutes: 300, // 5h window
      resetsAt: baseResetsAt,
    },
    ...(secondaryPct !== undefined
      ? {
          secondary: {
            usedPercent: secondaryPct,
            windowMinutes: 10080, // 7d window
            resetsAt: baseResetsAt + 7 * 24 * 3600,
          },
        }
      : {}),
    planType: 'pro',
  };
}

/** Build a shared-mode cfg object pointing at `dir`. */
function sharedCfg(dir: string, machineId: string): unknown {
  return {
    fleet: {
      sharedQueue: {
        mode: 'filesystem',
        path: dir,
        machineId,
      },
    },
  };
}

/** Directly write a UsageEntry into the shared store from "another machine". */
function seedEntry(
  store: SharedStore,
  machineId: string,
  engine: string,
  usedPercent: number,
  windowLabel: string,
  resetsAt: number,
  ts?: string,
) {
  store.publishUsage({
    machineId,
    engine,
    ts: ts ?? new Date().toISOString(),
    usedPercent,
    windowLabel,
    resetsAt,
  });
}

// ---------------------------------------------------------------------------
// Tmp dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  mockRateLimitsReturn = null;
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m114-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ===========================================================================
// FLAG-OFF: no sharedQueue → identical to M80 local-only behavior
// ===========================================================================

describe('flag-off: no sharedQueue cfg → local-only behavior (byte-identical to M80)', () => {
  it('subscriptionUsage: codex returns local % with no cfg', () => {
    mockRateLimitsReturn = makeRateLimits(55);
    const usage = subscriptionUsage('codex');
    expect(usage?.usedPercent).toBe(55);
    expect(usage?.windowLabel).toBe('5h');
  });

  it('subscriptionUsage: claude returns null with no cfg', () => {
    mockRateLimitsReturn = makeRateLimits(99);
    expect(subscriptionUsage('claude')).toBeNull();
  });

  it('subscriptionAllows: blocks codex at 95% (over default 90%) with no cfg', () => {
    mockRateLimitsReturn = makeRateLimits(95);
    const result = subscriptionAllows('codex');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('95%');
  });

  it('subscriptionAllows: allows codex at 40% with no cfg', () => {
    mockRateLimitsReturn = makeRateLimits(40);
    const result = subscriptionAllows('codex');
    expect(result.allowed).toBe(true);
  });

  it('subscriptionAllows: allows claude (no local signal) with no cfg', () => {
    const result = subscriptionAllows('claude');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('unknown');
  });

  it('subscriptionAllows: allows non-subscription engine with no cfg', () => {
    const result = subscriptionAllows('builtin');
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('not a subscription engine');
  });
});

// ===========================================================================
// SHARED MODE: publish + aggregate
// ===========================================================================

describe('shared mode: machine A publishes, machine B reads', () => {
  it('machine B is BLOCKED when A published 85% and maxPercent=80', () => {
    // Seed machine A's reading directly into the shared store.
    const store = new SharedStore(tmpDir);
    seedEntry(
      store,
      'machine-A',
      'codex',
      85,
      '5h',
      Math.floor(Date.now() / 1000) + 3600, // resets 1h from now
    );

    // Machine B: local reads only 10%.
    mockRateLimitsReturn = makeRateLimits(10);
    const cfgB = sharedCfg(tmpDir, 'machine-B');

    const result = subscriptionAllows('codex', { maxPercent: 80, cfg: cfgB });
    expect(result.allowed).toBe(false);
    // Reason should reflect the cross-machine reading.
    expect(result.reason).toContain('85%');
    expect(result.reason).toContain('cross-machine');
  });

  it('machine B is ALLOWED when A published 70% and maxPercent=80', () => {
    const store = new SharedStore(tmpDir);
    seedEntry(
      store,
      'machine-A',
      'codex',
      70,
      '5h',
      Math.floor(Date.now() / 1000) + 3600,
    );

    mockRateLimitsReturn = makeRateLimits(10);
    const cfgB = sharedCfg(tmpDir, 'machine-B');

    const result = subscriptionAllows('codex', { maxPercent: 80, cfg: cfgB });
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('70%');
    expect(result.reason).toContain('cross-machine');
  });

  it('most-saturated reading governs when multiple machines publish', () => {
    const store = new SharedStore(tmpDir);
    const futureReset = Math.floor(Date.now() / 1000) + 3600;
    seedEntry(store, 'machine-A', 'codex', 60, '5h', futureReset);
    seedEntry(store, 'machine-B', 'codex', 85, '5h', futureReset);
    seedEntry(store, 'machine-C', 'codex', 45, '5h', futureReset);

    mockRateLimitsReturn = makeRateLimits(10);
    const cfgD = sharedCfg(tmpDir, 'machine-D');

    const result = subscriptionAllows('codex', { maxPercent: 80, cfg: cfgD });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('85%');
  });
});

// ===========================================================================
// SHARED MODE: expired / stale entries are ignored
// ===========================================================================

describe('shared mode: expired and stale entries are ignored', () => {
  it('expired entry (resetsAt in the past) is ignored — falls back to local', () => {
    const store = new SharedStore(tmpDir);
    // resetsAt is 1 hour in the PAST → window has already reset → entry is stale.
    seedEntry(
      store,
      'machine-A',
      'codex',
      95,
      '5h',
      Math.floor(Date.now() / 1000) - 3600,
    );

    // Local reads 10% — should be allowed since A's entry is expired.
    mockRateLimitsReturn = makeRateLimits(10);
    const cfg = sharedCfg(tmpDir, 'machine-B');

    const result = subscriptionAllows('codex', { maxPercent: 80, cfg });
    expect(result.allowed).toBe(true);
  });

  it('very old ts entry (beyond maxAgeMs) is ignored', () => {
    const store = new SharedStore(tmpDir);
    // Publish a future-reset entry but with a ts 10 days in the past.
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    seedEntry(
      store,
      'machine-A',
      'codex',
      95,
      '5h',
      Math.floor(Date.now() / 1000) + 3600, // resetsAt is future
      tenDaysAgo,                             // but ts is ancient
    );

    mockRateLimitsReturn = makeRateLimits(10);
    const cfg = sharedCfg(tmpDir, 'machine-B');

    const result = subscriptionAllows('codex', { maxPercent: 80, cfg });
    // DEFAULT_LEDGER_MAX_AGE_MS = 8 days → 10-day-old ts is pruned → falls back to local 10%
    expect(result.allowed).toBe(true);
  });
});

// ===========================================================================
// SHARED MODE: claude activity is visible to siblings
// ===========================================================================

describe('shared mode: claude activity published (usedPercent=0)', () => {
  it('subscriptionUsage publishes a claude entry with usedPercent=0', () => {
    const cfg = sharedCfg(tmpDir, 'machine-A');
    // Claude always returns null locally; subscriptionUsage should still publish.
    subscriptionUsage('claude', { cfg });

    const store = new SharedStore(tmpDir);
    const entries = store.readUsageEntries('claude');
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.machineId === 'machine-A');
    expect(entry).toBeDefined();
    expect(entry?.usedPercent).toBe(0);
  });

  it('claude 0% entry from sibling does not block dispatch', () => {
    const store = new SharedStore(tmpDir);
    seedEntry(
      store,
      'machine-A',
      'claude',
      0,
      'unknown',
      Math.floor(Date.now() / 1000) + 3600,
    );

    const cfg = sharedCfg(tmpDir, 'machine-B');
    // Claude has no local signal — should still allow.
    const result = subscriptionAllows('claude', { maxPercent: 80, cfg });
    expect(result.allowed).toBe(true);
  });
});

// ===========================================================================
// SHARED MODE: upsert — republish replaces prior entry
// ===========================================================================

describe('shared mode: publishUsage upserts (no stale duplicate entries)', () => {
  it('second publish for same machineId+engine replaces the first', () => {
    const store = new SharedStore(tmpDir);
    store.publishUsage({
      machineId: 'machine-A',
      engine: 'codex',
      ts: new Date().toISOString(),
      usedPercent: 50,
      windowLabel: '5h',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    });
    store.publishUsage({
      machineId: 'machine-A',
      engine: 'codex',
      ts: new Date().toISOString(),
      usedPercent: 85,
      windowLabel: '5h',
      resetsAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const entries = store.readUsageEntries('codex');
    const machineAEntries = entries.filter((e) => e.machineId === 'machine-A');
    // Only the most-recent entry should remain.
    expect(machineAEntries).toHaveLength(1);
    expect(machineAEntries[0]?.usedPercent).toBe(85);
  });
});

// ===========================================================================
// UNWRITABLE PATH: falls back to local, never throws
// ===========================================================================

describe('unwritable path: falls back to local decision, never throws', () => {
  it('subscriptionAllows does not throw when shared path is unwritable', () => {
    const badCfg = sharedCfg('/nonexistent-path-that-cannot-be-created-m114', 'machine-X');
    mockRateLimitsReturn = makeRateLimits(40);
    expect(() => subscriptionAllows('codex', { maxPercent: 80, cfg: badCfg })).not.toThrow();
  });

  // win32: chmod-based unwritable-dir setup has no effect on Windows.
  it.skipIf(process.platform === 'win32')('subscriptionAllows falls back to local decision when shared path is unwritable', () => {
    const badCfg = sharedCfg('/nonexistent-path-that-cannot-be-created-m114', 'machine-X');
    // Local reads 95% → should block even without shared store.
    mockRateLimitsReturn = makeRateLimits(95);
    const result = subscriptionAllows('codex', { maxPercent: 80, cfg: badCfg });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('95%');
  });

  it('subscriptionAllows allows when local is under cap and shared unwritable', () => {
    const badCfg = sharedCfg('/nonexistent-path-that-cannot-be-created-m114', 'machine-X');
    mockRateLimitsReturn = makeRateLimits(10);
    const result = subscriptionAllows('codex', { maxPercent: 80, cfg: badCfg });
    expect(result.allowed).toBe(true);
  });

  it('subscriptionUsage does not throw when shared path is unwritable', () => {
    const badCfg = sharedCfg('/nonexistent-path-that-cannot-be-created-m114', 'machine-X');
    mockRateLimitsReturn = makeRateLimits(50);
    expect(() => subscriptionUsage('codex', { cfg: badCfg })).not.toThrow();
  });
});

// ===========================================================================
// Never-throws guarantee (mirrors m80)
// ===========================================================================

describe('never-throws guarantee', () => {
  it('subscriptionUsage never throws with garbage input', () => {
    mockRateLimitsReturn = {
      primary: undefined,
      secondary: undefined,
    } as unknown as CodexRateLimits;
    expect(() => subscriptionUsage('codex')).not.toThrow();
  });

  it('subscriptionAllows never throws on any engine with or without cfg', () => {
    mockRateLimitsReturn = null;
    const cfg = sharedCfg(tmpDir, 'machine-A');
    expect(() => subscriptionAllows('claude', { cfg })).not.toThrow();
    expect(() => subscriptionAllows('codex', { cfg })).not.toThrow();
    expect(() => subscriptionAllows('builtin', { cfg })).not.toThrow();
    expect(() => subscriptionAllows('nonexistent' as 'builtin', { cfg })).not.toThrow();
  });
});
