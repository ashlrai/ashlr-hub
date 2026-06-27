/**
 * M148 — Fleet digest: judge-calibration health line
 *
 * Asserts that `ashlr comms digest` appends a compact judge-calibration line
 * to the fleet summary message, sourced from judgeHealth() WITHOUT the
 * degradation pass (traces-only; fast + cheap).
 *
 * Modules under test:
 *   src/cli/comms.ts             — cmdComms 'digest' subcommand (M148 addition)
 *
 * All external I/O is mocked (mirrors m138 conventions):
 *   - judgeHealth               → vi.fn() (no live judge, no FS traces)
 *   - buildOversightSnapshot    → vi.fn() (deterministic OversightSnapshot)
 *   - runCommsCycle             → vi.fn() (returns {sent:1, resolved:0})
 *   - loadConfig                → vi.fn() (returns minimal cfgEnabled)
 *   - node:fs existsSync        → pass-through with chat.db shim
 *
 * Test counts:
 *   1. digest includes κ line when judgeHealth returns a full report
 *   2. digest includes flag token (⚠ low-kappa) when flags present
 *   3. digest shows "calibrating (N traces)" when sampleSize===0
 *   4. digest still sends as a 'report' (type check) in all paths
 *   5. digest never throws when judgeHealth itself throws unexpectedly
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const {
  mockJudgeHealth,
  mockBuildOversightSnapshot,
  mockRunCommsCycle,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockJudgeHealth: vi.fn(),
  mockBuildOversightSnapshot: vi.fn(),
  mockRunCommsCycle: vi.fn().mockResolvedValue({ sent: 1, resolved: 0 }),
  mockLoadConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: node:fs — chat.db shim (mirrors m138)
// ---------------------------------------------------------------------------
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: unknown): boolean => {
      if (typeof p === 'string' && p.endsWith('chat.db')) return true;
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: node:child_process — suppress osascript spawns (mirrors m138)
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: imessage (mirrors m138)
// ---------------------------------------------------------------------------
vi.mock('../src/core/integrations/imessage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/imessage.js')>();
  return {
    ...actual,
    sendIMessage: vi.fn().mockResolvedValue({ ok: true }),
    commsEnabled: (_cfg: unknown) => {
      const c = (_cfg as { comms?: { enabled?: boolean; imessageHandle?: string } }).comms;
      return !!(c?.enabled && c?.imessageHandle);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: judge-calibration — judgeHealth only (no live judge, no FS)
// ---------------------------------------------------------------------------
vi.mock('../src/core/fleet/judge-calibration.js', () => ({
  judgeHealth: mockJudgeHealth,
  // Re-export other symbols as stubs so TypeScript is satisfied.
  cohenKappa: vi.fn(),
  darkCurrent: vi.fn().mockReturnValue([]),
  runDegradationHarness: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: oversight-export
// ---------------------------------------------------------------------------
vi.mock('../src/core/fleet/oversight-export.js', () => ({
  buildOversightSnapshot: mockBuildOversightSnapshot,
}));

// ---------------------------------------------------------------------------
// Mock: dispatch — runCommsCycle only
// ---------------------------------------------------------------------------
vi.mock('../src/core/comms/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/dispatch.js')>();
  return { ...actual, runCommsCycle: mockRunCommsCycle };
});

// ---------------------------------------------------------------------------
// Mock: strategist — not exercised by digest, stub to avoid FS access
// ---------------------------------------------------------------------------
vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: vi.fn().mockReturnValue(null),
  runStrategist: vi.fn(),
  adoptBriefing: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: config
// ---------------------------------------------------------------------------
vi.mock('../src/core/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { cmdComms } from '../src/cli/comms.js';
import { listRequests } from '../src/core/comms/requests.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { OversightSnapshot } from '../src/core/fleet/oversight-export.js';
import type { QualityMetrics } from '../src/core/types.js';
import type { JudgeHealthReport } from '../src/core/fleet/judge-calibration.js';
import { makeCfg } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function cfgEnabled(): AshlrConfig {
  return makeCfg({
    comms: { enabled: true, imessageHandle: '+15555550100', service: 'iMessage' },
  });
}

function zeroMetrics(): QualityMetrics {
  return {
    proposalsCreated: 42,
    merged: 34,
    rejected: 4,
    pending: 4,
    emptyRate: 0.05,
    trivialRatio: 0.1,
    acceptRate: 0.81,
    avgDiffLines: 28,
    byEngine: {},
    byRepo: {},
    trends: [],
    windowLabel: '30d',
  };
}

function makeSnapshot(overrides: Partial<OversightSnapshot> = {}): OversightSnapshot {
  return {
    generatedAt: '2026-06-27T10:00:00.000Z',
    scorecard: zeroMetrics(),
    manager: {
      generatedAt: '2026-06-27T09:00:00.000Z',
      shipped: 30,
      review: 3,
      noise: 1,
      harmful: 0,
      recommendations: ['Focus on higher-impact proposals.'],
    },
    vision: null,
    goals: { active: 5, done: 12, progressPct: 60 },
    ...overrides,
  };
}

/** Full judgeHealth report with 142 traces, κ=0.62, 78% ship-bias. */
function makeJudgeReport(overrides: Partial<JudgeHealthReport> = {}): JudgeHealthReport {
  return {
    kappaVsOutcome: 0.62,
    darkCurrent: [
      {
        judgeEngine: 'claude-sonnet-4-5',
        traceCount: 142,
        verdictDistribution: { ship: 0.78, review: 0.15, noise: 0.05, harmful: 0.02 },
        meanScores: { value: 7.2, correctness: 7.5, scope: 6.8, alignment: 7.1 },
        stdScores: { value: 1.1, correctness: 0.9, scope: 1.2, alignment: 1.0 },
      },
    ],
    degradationRecoveryRate: null,
    sampleSize: 142,
    flags: [],
    ...overrides,
  };
}

/** Insufficient-traces report (sampleSize===0). */
function makeInsufficientReport(n = 3): JudgeHealthReport {
  return {
    kappaVsOutcome: null,
    darkCurrent: [],
    degradationRecoveryRate: null,
    sampleSize: 0,
    flags: [`insufficient traces: found ${n}, need at least 5`],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _tmpHome: string;
let _prevHome: string | undefined;

beforeEach(() => {
  _prevHome = process.env.HOME;
  _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m148-'));
  process.env.HOME = _tmpHome;

  mockBuildOversightSnapshot.mockReturnValue(makeSnapshot());
  mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });
  mockLoadConfig.mockResolvedValue(cfgEnabled());
  mockJudgeHealth.mockResolvedValue(makeJudgeReport());
});

afterEach(() => {
  vi.clearAllMocks();
  if (_prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = _prevHome;
  try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ===========================================================================
// Tests
// ===========================================================================

describe('comms digest — judge-calibration health line (M148)', () => {

  // 1. Full report: κ + ship-bias + trace count present in text
  it('includes judge κ, ship-bias%, and trace count when judgeHealth returns a full report', async () => {
    mockJudgeHealth.mockResolvedValue(makeJudgeReport());

    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(0);

    const all = listRequests({ kind: 'fleet-digest' });
    const r = all[all.length - 1]!;
    expect(r.type).toBe('report');

    // κ value
    expect(r.text).toMatch(/κ=0\.62/);
    // ship-bias percentage
    expect(r.text).toMatch(/ship-bias 78%/);
    // trace count
    expect(r.text).toMatch(/142 traces/);
    // starts with "Judge:"
    expect(r.text).toMatch(/Judge:/);
  });

  // 2. Flag appended when kappa is low
  it('appends ⚠ low-kappa flag when judgeHealth returns a low-kappa flag', async () => {
    mockJudgeHealth.mockResolvedValue(makeJudgeReport({
      kappaVsOutcome: 0.18,
      flags: ['kappa vs outcome is 0.18 (< 0.20) — judge agreement with reality is poor'],
    }));

    await cmdComms(['digest']);

    const all = listRequests({ kind: 'fleet-digest' });
    const r = all[all.length - 1]!;
    expect(r.text).toContain('⚠ low-kappa');
  });

  // 3. Insufficient traces: shows "calibrating (N traces)"
  it('shows "Judge: calibrating (N traces)" when sampleSize===0', async () => {
    mockJudgeHealth.mockResolvedValue(makeInsufficientReport(3));

    await cmdComms(['digest']);

    const all = listRequests({ kind: 'fleet-digest' });
    const r = all[all.length - 1]!;
    expect(r.text).toMatch(/Judge: calibrating \(3 traces\)/);
    // Must NOT contain κ= in the calibrating case
    expect(r.text).not.toMatch(/κ=/);
  });

  // 4. Digest always sends as type='report' regardless of judge health path
  it('always sends the digest as type=report even with calibrating judge', async () => {
    mockJudgeHealth.mockResolvedValue(makeInsufficientReport(0));

    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();

    const all = listRequests({ kind: 'fleet-digest' });
    const r = all[all.length - 1]!;
    expect(r.type).toBe('report');
  });

  // 5. Never throws if judgeHealth itself throws unexpectedly
  it('never throws and still sends digest when judgeHealth throws', async () => {
    mockJudgeHealth.mockRejectedValue(new Error('judge-calibration exploded'));

    const exitCode = await cmdComms(['digest']);
    // Digest should still succeed — judgeHealth failure is swallowed
    expect(exitCode).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();

    const all = listRequests({ kind: 'fleet-digest' });
    expect(all.length).toBeGreaterThan(0);
    const r = all[all.length - 1]!;
    expect(r.type).toBe('report');
    // No judge line at all is fine — just no throw
  });

  // Confirm judgeHealth is called WITHOUT runDegradation (traces-only, fast path)
  it('calls judgeHealth without runDegradation option', async () => {
    mockJudgeHealth.mockResolvedValue(makeJudgeReport());

    await cmdComms(['digest']);

    expect(mockJudgeHealth).toHaveBeenCalledOnce();
    // Called with only cfg — no second opts argument containing runDegradation:true
    const callArgs = mockJudgeHealth.mock.calls[0] as unknown[];
    expect(callArgs).toHaveLength(1); // only cfg, no opts
  });
});
