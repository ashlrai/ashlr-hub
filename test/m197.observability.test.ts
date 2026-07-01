/**
 * test/m197.observability.test.ts — M197 OBSERVABILITY: silent catch sites now log.
 *
 * Verifies that the catch-handler instrumentation added in M197 meets two
 * invariants for each patched site:
 *
 *   1. BEHAVIOUR UNCHANGED — the return value / fallback from the catch is
 *      identical to what it was before (null / undefined / 0 / false).
 *   2. WARN EMITTED — console.warn is called with a '[ashlr]' prefix when the
 *      underlying call rejects/throws.
 *
 * We use vi.spyOn(console, 'warn') to observe logging without modifying
 * production modules. Each test restores the spy after.
 *
 * SAFETY: no real daemon state, no real filesystem writes beyond what the
 * imported modules already do in-memory. No LLM subprocesses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before module imports so the modules bind to the mocks.
// ---------------------------------------------------------------------------

// Mock desktopNotify + notify so we can force rejections in notify-proposal.
const mockDesktopNotify = vi.fn();
const mockNotify = vi.fn();

vi.mock('../src/core/integrations/desktop-notify.js', () => ({
  desktopNotify: (...args: unknown[]) => mockDesktopNotify(...args),
}));

vi.mock('../src/core/integrations/notify.js', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

// Mock buildFleetDigest + buildFleetStatus for control.ts tests.
const mockBuildFleetDigest = vi.fn();
const mockBuildFleetStatus = vi.fn();
let mockAuditEntries: Array<{
  ts: string;
  action: string;
  repo: string | null;
  sandboxId: string | null;
  summary: string;
  result: 'ok' | 'refused' | 'error';
}> = [];

vi.mock('../src/core/fleet/digest.js', () => ({
  buildFleetDigest: (...args: unknown[]) => mockBuildFleetDigest(...args),
}));

vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: (...args: unknown[]) => mockBuildFleetStatus(...args),
}));

vi.mock('../src/core/sandbox/audit.js', () => ({
  readAudit: () => mockAuditEntries,
}));

// Mock runAutoMergePass — used in loop.ts tick().
const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

// Mock estimateRun — used in the anomaly-detection path.
const mockEstimateRun = vi.fn();
vi.mock('../src/core/observability/estimate.js', () => ({
  estimateRun: (...args: unknown[]) => mockEstimateRun(...args),
}));

// Mock pendingCount — used in loop.ts tick() proposals-delta and recordTick paths.
const mockPendingCount = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  pendingCount: (...args: unknown[]) => mockPendingCount(...args),
  listProposals: vi.fn(() => []),
  createProposal: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy imports — AFTER mocks.
// ---------------------------------------------------------------------------

import { notifyNewProposal } from '../src/core/inbox/notify-proposal.js';
import { buildFleetActivity, buildControlSnapshot } from '../src/core/web/control.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalCfg(): AshlrConfig {
  return {
    daemon: {
      dailyBudgetUsd: 1,
      intervalMs: 60_000,
      perTickItems: 1,
      parallel: 1,
    },
  } as unknown as AshlrConfig;
}

function minimalProposal(): Proposal {
  return {
    id: 'test-001',
    kind: 'patch',
    title: 'Test proposal',
    repo: '/tmp/repo',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '',
    engine: 'claude',
    goal: '',
    sandboxId: null,
    spentUsd: 0,
  } as unknown as Proposal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M197 observability — notify-proposal.ts', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAuditEntries = [];
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('desktopNotify failure: emits warn with [ashlr] prefix, returns void (no throw)', async () => {
    mockDesktopNotify.mockRejectedValueOnce(new Error('no notification centre'));
    mockNotify.mockResolvedValueOnce(undefined);

    await expect(notifyNewProposal(minimalProposal(), minimalCfg())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ashlr]'),
      expect.stringContaining('no notification centre'),
    );
  });

  it('webhook notify failure: emits warn with [ashlr] prefix, returns void (no throw)', async () => {
    mockDesktopNotify.mockResolvedValueOnce(undefined);
    mockNotify.mockRejectedValueOnce(new Error('webhook timeout'));

    await expect(notifyNewProposal(minimalProposal(), minimalCfg())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ashlr]'),
      expect.stringContaining('webhook timeout'),
    );
  });

  it('both fail: two warn calls, still no throw', async () => {
    mockDesktopNotify.mockRejectedValueOnce(new Error('desktop err'));
    mockNotify.mockRejectedValueOnce(new Error('webhook err'));

    await expect(notifyNewProposal(minimalProposal(), minimalCfg())).resolves.toBeUndefined();

    const warnCalls = warnSpy.mock.calls.map(c => c[0] as string);
    expect(warnCalls.some(m => m.includes('[ashlr]') && m.includes('desktopNotify'))).toBe(true);
    expect(warnCalls.some(m => m.includes('[ashlr]') && m.includes('notify'))).toBe(true);
  });

  it('both succeed: no warn emitted', async () => {
    mockDesktopNotify.mockResolvedValueOnce(true);
    mockNotify.mockResolvedValueOnce(true);

    await notifyNewProposal(minimalProposal(), minimalCfg());

    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('M197 observability — control.ts buildFleetActivity', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockAuditEntries = [];
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('buildFleetDigest failure: warn emitted, function still resolves', async () => {
    mockBuildFleetDigest.mockRejectedValueOnce(new Error('digest DB locked'));

    const result = await buildFleetActivity(minimalCfg());

    // Still resolves — graceful degradation
    expect(result).toBeDefined();
    expect(result.repos).toEqual([]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ashlr]'),
      expect.stringContaining('digest DB locked'),
    );
  });

  it('buildFleetDigest success: no warn emitted', async () => {
    mockBuildFleetDigest.mockResolvedValueOnce({
      running: false,
      lastTickAt: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      repos: [],
      totalProposed: 0,
      totalAutoMerged: 0,
      totalPending: 0,
      totalDeclined: 0,
    });

    await buildFleetActivity(minimalCfg());

    const digestWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('buildFleetDigest'),
    );
    expect(digestWarns).toHaveLength(0);
  });

  it('surfaces successful inbox:auto-merge audit events in recentMerges', async () => {
    mockBuildFleetDigest.mockResolvedValueOnce({
      running: false,
      lastTickAt: null,
      todaySpentUsd: 0,
      itemsProcessed: 0,
      repos: [],
      totalProposed: 0,
      totalAutoMerged: 1,
      totalPending: 0,
      totalDeclined: 0,
    });
    mockAuditEntries = [
      {
        ts: '2026-07-01T00:00:00.000Z',
        action: 'inbox:auto-merge',
        repo: '/tmp/repo',
        sandboxId: 'prop-123',
        summary: 'proposal prop-123 auto-merge MERGED: merged to master',
        result: 'ok',
      },
      {
        ts: '2026-07-01T00:01:00.000Z',
        action: 'inbox:auto-merge',
        repo: '/tmp/repo',
        sandboxId: 'prop-err',
        summary: 'proposal prop-err auto-merge not merged: failed gate',
        result: 'error',
      },
    ];

    const result = await buildFleetActivity(minimalCfg());

    expect(result.recentMerges).toHaveLength(1);
    expect(result.recentMerges[0]).toMatchObject({
      repo: '/tmp/repo',
      proposalId: 'prop-123',
      ts: '2026-07-01T00:00:00.000Z',
      engine: null,
    });
  });
});

describe('M197 observability — control.ts buildControlSnapshot', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('buildFleetStatus failure: warn emitted, snapshot still resolves with fallback fleet', async () => {
    mockBuildFleetStatus.mockRejectedValueOnce(new Error('fleet status boom'));

    const result = await buildControlSnapshot(minimalCfg());

    expect(result).toBeDefined();
    // Fallback fleet shape
    expect(result.fleet).toMatchObject({
      backends: [],
      killed: false,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ashlr]'),
      expect.stringContaining('fleet status boom'),
    );
  });

  it('buildFleetStatus success: no buildFleetStatus warn', async () => {
    mockBuildFleetStatus.mockResolvedValueOnce({
      generatedAt: new Date().toISOString(),
      daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
      backends: [],
      queue: { backlogItems: 0 },
      proposals: { pending: 0, frontierPending: 0, applied: 0 },
      merges: { recent: 0 },
      killed: false,
    });

    await buildControlSnapshot(minimalCfg());

    const statusWarns = warnSpy.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes('buildFleetStatus'),
    );
    expect(statusWarns).toHaveLength(0);
  });
});
