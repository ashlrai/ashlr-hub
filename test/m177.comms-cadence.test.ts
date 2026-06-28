/**
 * M177 — Throttled digest + ask-vision cadence driven by `ashlr comms cycle`
 *
 * Modules under test:
 *   src/cli/comms.ts — cmdComms 'cycle' with cadence throttle logic
 *
 * All external I/O is mocked:
 *   - buildOversightSnapshot → vi.fn() (deterministic snapshot)
 *   - loadLatestBriefing     → vi.fn() (returns deterministic StrategicBriefing)
 *   - runStrategist          → vi.fn() (same briefing)
 *   - judgeHealth            → vi.fn() (returns zeroed health)
 *   - runCommsCycle          → vi.fn() (returns {sent:1, resolved:0})
 *   - loadConfig             → vi.fn() (returns minimal cfgEnabled)
 *   - node:fs (existsSync / readFileSync / writeFileSync / mkdirSync)
 *     — partial mock: cadence files route through controlled state;
 *       everything else uses real fs (tmpdir HOME).
 *
 * Test counts:
 *   1.  cycle sends a digest when last-digest is stale (> interval)
 *   2.  cycle skips digest when last-digest was just written (< interval)
 *   3.  cycle sends ask-vision when last-askvision is stale (> interval)
 *   4.  cycle skips ask-vision when last-askvision was just written (< interval)
 *   5.  cycle updates last-digest timestamp file after sending
 *   6.  cycle updates last-askvision timestamp file after sending
 *   7.  a digest error does not break the poll cycle (runCommsCycle still called)
 *   8.  an ask-vision error does not break the poll cycle
 *   9.  comms disabled → neither digest nor ask-vision fires, cycle still runs
 *  10.  both stale → both digest + ask-vision fire in the same cycle run
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------
const {
  mockBuildOversightSnapshot,
  mockLoadLatestBriefing,
  mockRunStrategist,
  mockJudgeHealth,
  mockRunCommsCycle,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockBuildOversightSnapshot: vi.fn(),
  mockLoadLatestBriefing: vi.fn(),
  mockRunStrategist: vi.fn(),
  mockJudgeHealth: vi.fn(),
  mockRunCommsCycle: vi.fn().mockResolvedValue({ sent: 1, resolved: 0 }),
  mockLoadConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: node:fs — intercept cadence writes/reads; delegate rest to real fs
// ---------------------------------------------------------------------------
// We track written cadence files in an in-memory map keyed by path suffix.
const cadenceStore: Map<string, string> = new Map();

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: unknown): boolean => {
      if (typeof p === 'string' && (p.endsWith('last-digest.json') || p.endsWith('last-askvision.json'))) {
        return cadenceStore.has(p as string);
      }
      // also let chat.db pass so dispatch doesn't short-circuit
      if (typeof p === 'string' && p.endsWith('chat.db')) return true;
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    },
    readFileSync: (p: unknown, enc?: unknown) => {
      if (typeof p === 'string' && (p.endsWith('last-digest.json') || p.endsWith('last-askvision.json'))) {
        const val = cadenceStore.get(p as string);
        if (val === undefined) throw new Error(`ENOENT: ${p as string}`);
        return val;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, enc);
    },
    writeFileSync: (p: unknown, data: unknown, enc?: unknown) => {
      if (typeof p === 'string' && (p.endsWith('last-digest.json') || p.endsWith('last-askvision.json'))) {
        cadenceStore.set(p as string, String(data));
        return;
      }
      return (actual.writeFileSync as (...a: unknown[]) => unknown)(p, data, enc);
    },
    mkdirSync: (p: unknown, opts?: unknown) => {
      // Only suppress mkdirSync for the specific cadence dir when HOME is a tmpdir
      // (cadence writes go to in-memory store; real requests.jsonl dir creation must proceed)
      return (actual.mkdirSync as (...a: unknown[]) => unknown)(p, opts);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: node:child_process — suppress osascript/sqlite3
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
// Mock: imessage
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
// Mock: telegram — telegramEnabled always false in these tests
// ---------------------------------------------------------------------------
vi.mock('../src/core/integrations/telegram.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/telegram.js')>();
  return {
    ...actual,
    telegramEnabled: (_cfg: unknown) => false,
    sendTelegram: vi.fn().mockResolvedValue({ ok: true }),
  };
});

// ---------------------------------------------------------------------------
// Mock: oversight-export
// ---------------------------------------------------------------------------
vi.mock('../src/core/fleet/oversight-export.js', () => ({
  buildOversightSnapshot: mockBuildOversightSnapshot,
}));

// ---------------------------------------------------------------------------
// Mock: strategist
// ---------------------------------------------------------------------------
vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: mockLoadLatestBriefing,
  runStrategist: mockRunStrategist,
  adoptBriefing: vi.fn().mockResolvedValue({ specId: 'eco', goalIds: [] }),
}));

// ---------------------------------------------------------------------------
// Mock: judge-calibration
// ---------------------------------------------------------------------------
vi.mock('../src/core/fleet/judge-calibration.js', () => ({
  judgeHealth: mockJudgeHealth,
}));

// ---------------------------------------------------------------------------
// Mock: dispatch
// ---------------------------------------------------------------------------
vi.mock('../src/core/comms/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/dispatch.js')>();
  return {
    ...actual,
    runCommsCycle: mockRunCommsCycle,
  };
});

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
import { makeCfg } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function cfgEnabled(overrides: Partial<NonNullable<AshlrConfig['comms']>> = {}): AshlrConfig {
  return makeCfg({
    comms: {
      enabled: true,
      imessageHandle: '+15555550100',
      service: 'iMessage',
      ...overrides,
    },
  });
}

function cfgDisabled(): AshlrConfig {
  return makeCfg({ comms: { enabled: false } });
}

function zeroMetrics(): QualityMetrics {
  return {
    proposalsCreated: 10,
    merged: 8,
    rejected: 1,
    pending: 1,
    emptyRate: 0.05,
    trivialRatio: 0.1,
    acceptRate: 0.80,
    avgDiffLines: 20,
    byEngine: {},
    byRepo: {},
    trends: [],
    windowLabel: '30d',
  };
}

function makeSnapshot(overrides: Partial<OversightSnapshot> = {}): OversightSnapshot {
  return {
    generatedAt: '2026-06-28T00:00:00.000Z',
    scorecard: zeroMetrics(),
    manager: {
      generatedAt: '2026-06-28T00:00:00.000Z',
      shipped: 8,
      review: 1,
      noise: 1,
      harmful: 0,
      recommendations: ['Keep it up.'],
    },
    vision: {
      northStar: 'Autonomous fleet',
      endState: 'No human toil',
      ambitionLevel: '9',
      progressPct: 50,
    },
    goals: { active: 3, done: 7, progressPct: 70 },
    ...overrides,
  };
}

function makeBriefing() {
  return {
    generatedAt: '2026-06-28T00:00:00.000Z',
    project: null,
    currentState: 'Fleet is healthy.',
    gapToVision: 'No self-improvement yet.',
    proposedEvolution: {},
    recommendedDirection: ['Wire self-improvement loop'],
    newProblems: [],
    questionsForMason: ['Should fleet auto-adopt briefings?'],
    proposedGoals: [],
  };
}

function makeJudgeHealth() {
  return {
    sampleSize: 0,
    kappaVsOutcome: null,
    darkCurrent: [],
    flags: [],
  };
}

// Stale = more than 6h ago
const STALE_6H = Date.now() - 7 * 60 * 60 * 1000;
// Recent = just now
const RECENT = Date.now() - 60 * 1000;
// Stale = more than 24h ago
const STALE_24H = Date.now() - 25 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _tmpHome: string;
let _prevHome: string | undefined;

beforeEach(() => {
  _prevHome = process.env['HOME'];
  _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m177-'));
  process.env['HOME'] = _tmpHome;

  cadenceStore.clear();

  mockBuildOversightSnapshot.mockReturnValue(makeSnapshot());
  mockLoadLatestBriefing.mockReturnValue(makeBriefing());
  mockRunStrategist.mockResolvedValue(makeBriefing());
  mockJudgeHealth.mockResolvedValue(makeJudgeHealth());
  mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });
  mockLoadConfig.mockResolvedValue(cfgEnabled());
});

afterEach(() => {
  vi.clearAllMocks();
  cadenceStore.clear();
  if (_prevHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = _prevHome;
  try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// Helper: write a stale or recent cadence entry into the mock store
function setCadence(name: 'last-digest' | 'last-askvision', sentAtMs: number): void {
  // Build the path that cadencePath() inside comms.ts will produce
  const p = join(_tmpHome, '.ashlr', 'comms', `${name}.json`);
  cadenceStore.set(p, JSON.stringify({ sentAt: sentAtMs }));
}

// Helper: read the cadence store value for a given name
function getCadenceValue(name: 'last-digest' | 'last-askvision'): number | null {
  const p = join(_tmpHome, '.ashlr', 'comms', `${name}.json`);
  const raw = cadenceStore.get(p);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as { sentAt: number }).sentAt;
  } catch {
    return null;
  }
}

// ===========================================================================
// 1. Digest fires when stale
// ===========================================================================

describe('cycle digest cadence', () => {
  it('sends a digest when last-digest is stale (> 6h interval)', async () => {
    setCadence('last-digest', STALE_6H);

    const exit = await cmdComms(['cycle']);
    expect(exit).toBe(0);
    expect(mockBuildOversightSnapshot).toHaveBeenCalledOnce();
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();

    const queued = listRequests({ kind: 'fleet-digest' });
    expect(queued.length).toBeGreaterThan(0);
  });

  it('skips digest when last-digest was recent (< 6h interval)', async () => {
    setCadence('last-digest', RECENT);

    await cmdComms(['cycle']);
    expect(mockBuildOversightSnapshot).not.toHaveBeenCalled();
    // cycle still runs
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('sends digest when no last-digest file exists (first run)', async () => {
    // cadenceStore is empty — no file

    await cmdComms(['cycle']);
    expect(mockBuildOversightSnapshot).toHaveBeenCalledOnce();
  });

  it('uses custom digestIntervalHours from config', async () => {
    // interval = 2h; last-digest was 1h ago → should skip
    mockLoadConfig.mockResolvedValue(cfgEnabled({ digestIntervalHours: 2 }));
    setCadence('last-digest', Date.now() - 1 * 60 * 60 * 1000);

    await cmdComms(['cycle']);
    expect(mockBuildOversightSnapshot).not.toHaveBeenCalled();

    // last-digest was 3h ago → should fire
    setCadence('last-digest', Date.now() - 3 * 60 * 60 * 1000);
    await cmdComms(['cycle']);
    expect(mockBuildOversightSnapshot).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 2. Ask-vision fires when stale
// ===========================================================================

describe('cycle ask-vision cadence', () => {
  it('sends ask-vision when last-askvision is stale (> 24h interval)', async () => {
    setCadence('last-askvision', STALE_24H);
    setCadence('last-digest', RECENT); // suppress digest

    await cmdComms(['cycle']);
    expect(mockLoadLatestBriefing).toHaveBeenCalled();
    const queued = listRequests({ kind: 'elon-vision' });
    expect(queued.length).toBeGreaterThan(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('skips ask-vision when last-askvision was recent (< 24h interval)', async () => {
    setCadence('last-askvision', RECENT);
    setCadence('last-digest', RECENT);

    await cmdComms(['cycle']);
    expect(mockLoadLatestBriefing).not.toHaveBeenCalled();
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('sends ask-vision when no last-askvision file exists (first run)', async () => {
    setCadence('last-digest', RECENT); // suppress digest

    await cmdComms(['cycle']);
    expect(mockLoadLatestBriefing).toHaveBeenCalled();
    const queued = listRequests({ kind: 'elon-vision' });
    expect(queued.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. Timestamps updated after send
// ===========================================================================

describe('timestamp update', () => {
  it('updates last-digest after digest fires', async () => {
    const before = Date.now();
    // No entry → stale → fires
    await cmdComms(['cycle']);

    const written = getCadenceValue('last-digest');
    expect(written).not.toBeNull();
    expect(written!).toBeGreaterThanOrEqual(before);
    expect(written!).toBeLessThanOrEqual(Date.now());
  });

  it('updates last-askvision after ask-vision fires', async () => {
    setCadence('last-digest', RECENT); // suppress digest
    const before = Date.now();

    await cmdComms(['cycle']);

    const written = getCadenceValue('last-askvision');
    expect(written).not.toBeNull();
    expect(written!).toBeGreaterThanOrEqual(before);
    expect(written!).toBeLessThanOrEqual(Date.now());
  });

  it('does not update last-digest when digest is skipped', async () => {
    setCadence('last-digest', RECENT);
    setCadence('last-askvision', RECENT);

    await cmdComms(['cycle']);

    // The value should remain the same RECENT-ish value we set
    const written = getCadenceValue('last-digest');
    // It was set to RECENT; if digest was skipped, it won't be re-written with a newer ts
    // We just confirm no new entry was written with a strictly later timestamp
    expect(written).toBeCloseTo(RECENT, -3); // within ~1s
  });
});

// ===========================================================================
// 4. Never-throws: errors don't break the poll cycle
// ===========================================================================

describe('never-throws', () => {
  it('digest error does not break the poll cycle (runCommsCycle still called)', async () => {
    mockBuildOversightSnapshot.mockImplementation(() => { throw new Error('snapshot exploded'); });
    // cadenceStore empty → stale → will try digest → throws → must not break cycle

    const exit = await cmdComms(['cycle']);
    expect(exit).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('ask-vision error does not break the poll cycle', async () => {
    setCadence('last-digest', RECENT); // suppress digest
    mockLoadLatestBriefing.mockImplementation(() => { throw new Error('briefing exploded'); });

    const exit = await cmdComms(['cycle']);
    expect(exit).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('both errors do not break the poll cycle', async () => {
    mockBuildOversightSnapshot.mockImplementation(() => { throw new Error('snap fail'); });
    mockLoadLatestBriefing.mockImplementation(() => { throw new Error('briefing fail'); });

    const exit = await cmdComms(['cycle']);
    expect(exit).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 5. Comms disabled → nothing fires
// ===========================================================================

describe('comms disabled', () => {
  it('neither digest nor ask-vision fire when comms is disabled', async () => {
    mockLoadConfig.mockResolvedValue(cfgDisabled());

    const exit = await cmdComms(['cycle']);
    expect(exit).toBe(0);
    expect(mockBuildOversightSnapshot).not.toHaveBeenCalled();
    expect(mockLoadLatestBriefing).not.toHaveBeenCalled();
    // cycle still runs (registerCommsHandlers + runCommsCycle)
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// 6. Both stale in the same run
// ===========================================================================

describe('both stale', () => {
  it('fires both digest and ask-vision in the same cycle when both are stale', async () => {
    setCadence('last-digest', STALE_6H);
    setCadence('last-askvision', STALE_24H);

    await cmdComms(['cycle']);

    expect(mockBuildOversightSnapshot).toHaveBeenCalledOnce();
    expect(mockLoadLatestBriefing).toHaveBeenCalled();

    const digests = listRequests({ kind: 'fleet-digest' });
    const visions = listRequests({ kind: 'elon-vision' });
    expect(digests.length).toBeGreaterThan(0);
    expect(visions.length).toBeGreaterThan(0);

    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });
});
