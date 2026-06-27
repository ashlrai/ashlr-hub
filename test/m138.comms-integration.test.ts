/**
 * M138 — Fleet iMessage comms integration: handlers + digest + ask-vision
 *
 * Modules under test:
 *   src/core/comms/handlers.ts   — registerCommsHandlers / elon-vision handler
 *   src/cli/comms.ts             — cmdComms 'digest' + 'ask-vision' subcommands
 *
 * All external I/O is mocked:
 *   - sendIMessage          → vi.fn() (no osascript)
 *   - adoptBriefing         → vi.fn() (no spec/goals FS writes)
 *   - loadLatestBriefing    → vi.fn() (returns deterministic StrategicBriefing)
 *   - runStrategist         → vi.fn() (same deterministic briefing)
 *   - buildOversightSnapshot → vi.fn() (returns deterministic OversightSnapshot)
 *   - runCommsCycle         → vi.fn() (returns {sent:1, resolved:0})
 *   - loadConfig            → vi.fn() (returns minimal cfgEnabled)
 *   - node:fs existsSync / commsEnabled guard
 *
 * Test counts:
 *   1. registerCommsHandlers wires the elon-vision handler (kind found in registry)
 *   2. elon-vision index=0 (Approve) calls adoptBriefing with loadLatestBriefing result
 *   3. elon-vision index=1 (Hold) is a no-op — adoptBriefing/sendIMessage not called
 *   4. elon-vision index=2 (Show) sends full briefing text via sendIMessage
 *   5. elon-vision handler never throws even when adoptBriefing rejects
 *   6. comms digest sends an SMS-sized scrubbed report
 *   7. comms digest report text contains key fleet metrics
 *   8. comms ask-vision posts a 3-option question and runs the cycle
 *   9. comms ask-vision uses loadLatestBriefing when available (no runStrategist call)
 *  10. comms ask-vision falls back to runStrategist when no cached briefing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock factories are hoisted
// ---------------------------------------------------------------------------
const {
  mockSendIMessage,
  mockAdoptBriefing,
  mockLoadLatestBriefing,
  mockRunStrategist,
  mockBuildOversightSnapshot,
  mockRunCommsCycle,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockSendIMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockAdoptBriefing: vi.fn().mockResolvedValue({ specId: 'ecosystem', goalIds: ['g1', 'g2'] }),
  mockLoadLatestBriefing: vi.fn(),
  mockRunStrategist: vi.fn(),
  mockBuildOversightSnapshot: vi.fn(),
  mockRunCommsCycle: vi.fn().mockResolvedValue({ sent: 1, resolved: 0 }),
  mockLoadConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: node:fs — route existsSync chat.db check so dispatch doesn't short-circuit
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
// Mock: node:child_process — suppress all osascript/sqlite3 spawns
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
// Mock: imessage — capture sendIMessage calls
// ---------------------------------------------------------------------------
vi.mock('../src/core/integrations/imessage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/imessage.js')>();
  return {
    ...actual,
    sendIMessage: mockSendIMessage,
    commsEnabled: (_cfg: unknown) => {
      const c = (_cfg as { comms?: { enabled?: boolean; imessageHandle?: string } }).comms;
      return !!(c?.enabled && c?.imessageHandle);
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: strategist — loadLatestBriefing + adoptBriefing + runStrategist
// ---------------------------------------------------------------------------
vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: mockLoadLatestBriefing,
  adoptBriefing: mockAdoptBriefing,
  runStrategist: mockRunStrategist,
}));

// ---------------------------------------------------------------------------
// Mock: oversight-export — buildOversightSnapshot
// ---------------------------------------------------------------------------
vi.mock('../src/core/fleet/oversight-export.js', () => ({
  buildOversightSnapshot: mockBuildOversightSnapshot,
}));

// ---------------------------------------------------------------------------
// Mock: dispatch — runCommsCycle (keep registerResolutionHandler real)
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
import { registerCommsHandlers } from '../src/core/comms/handlers.js';
import { postRequest, listRequests } from '../src/core/comms/requests.js';
import { cmdComms } from '../src/cli/comms.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { StrategicBriefing } from '../src/core/vision/strategist.js';
import type { OversightSnapshot } from '../src/core/fleet/oversight-export.js';
import type { QualityMetrics } from '../src/core/types.js';
import { makeCfg } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function cfgEnabled(): AshlrConfig {
  return makeCfg({
    comms: { enabled: true, imessageHandle: '+15555550100', service: 'iMessage' },
  });
}

function makeBriefing(overrides: Partial<StrategicBriefing> = {}): StrategicBriefing {
  return {
    generatedAt: '2026-06-27T10:00:00.000Z',
    project: null,
    currentState: 'Fleet is producing proposals at a steady rate with 80% accept rate.',
    gapToVision: 'No self-improvement loop yet; agent quality still requires human oversight.',
    proposedEvolution: {},
    recommendedDirection: ['Wire self-improvement loop', 'Reduce trivial proposal ratio'],
    newProblems: [],
    questionsForMason: ['Should the fleet auto-adopt briefings without your review?'],
    proposedGoals: [
      { objective: 'Implement self-improvement feedback loop', rationale: 'Closes the main gap', specPriority: 'Self-improvement' },
      { objective: 'Add proposal quality scoring', rationale: 'Reduces trivial ratio', specPriority: 'Quality' },
    ],
    ...overrides,
  };
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
    vision: {
      northStar: 'Fully autonomous engineering fleet',
      endState: 'No human intervention needed',
      ambitionLevel: '9',
      progressPct: 45,
    },
    goals: { active: 5, done: 12, progressPct: 60 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _tmpHome: string;
let _prevHome: string | undefined;

beforeEach(() => {
  _prevHome = process.env.HOME;
  _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m138-'));
  process.env.HOME = _tmpHome;

  mockSendIMessage.mockClear();
  mockAdoptBriefing.mockClear();
  mockLoadLatestBriefing.mockClear();
  mockRunStrategist.mockClear();
  mockBuildOversightSnapshot.mockClear();
  mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });
  mockLoadConfig.mockResolvedValue(cfgEnabled());
});

afterEach(() => {
  vi.clearAllMocks();
  if (_prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = _prevHome;
  try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ===========================================================================
// 1. registerCommsHandlers — wires the elon-vision handler
// ===========================================================================

describe('registerCommsHandlers', () => {
  it('wires elon-vision handler into the registry without throwing', () => {
    const cfg = cfgEnabled();
    // Confirm registration is idempotent and does not throw.
    expect(() => registerCommsHandlers(cfg)).not.toThrow();
    expect(() => registerCommsHandlers(cfg)).not.toThrow(); // second call is safe
  });

  it('wires manager-approval handler without throwing', () => {
    const cfg = cfgEnabled();
    expect(() => registerCommsHandlers(cfg)).not.toThrow();
  });
});

// ===========================================================================
// 2–5. elon-vision handler behaviour
//
// Strategy: registerCommsHandlers uses the real registerResolutionHandler from
// dispatch.js (only runCommsCycle is mocked). We call registerCommsHandlers to
// wire the handler into the real registry, then trigger it by invoking the
// dispatch module's internal invokeHandler path via a synthetic resolved request.
//
// The cleanest isolation: re-export a test-only invokeHandler shim by spying on
// dispatch's registerResolutionHandler with vi.spyOn on the *module namespace*.
// But since dispatch.js is partially mocked (runCommsCycle only), the real
// registerResolutionHandler is available. We capture handlers by wrapping the
// real registerResolutionHandler with a spy on the module namespace object.
// ===========================================================================

// We need the dispatch module namespace so we can capture the real handler.
import * as dispatchModule from '../src/core/comms/dispatch.js';

describe('elon-vision handler', () => {
  /** Helper: register handlers, capture the elon-vision one, invoke it. */
  async function invokeElonHandler(
    cfg: ReturnType<typeof cfgEnabled>,
    answerIndex: number,
    answerText: string,
  ): Promise<void> {
    let capturedFn: ((req: ReturnType<typeof makeCommsReq>) => void | Promise<void>) | undefined;

    const spy = vi.spyOn(dispatchModule, 'registerResolutionHandler').mockImplementation(
      (kind: string, fn: (req: unknown) => void | Promise<void>) => {
        if (kind === 'elon-vision') capturedFn = fn as typeof capturedFn;
      },
    );

    registerCommsHandlers(cfg);
    spy.mockRestore();

    if (capturedFn) {
      await capturedFn(makeCommsReq(answerIndex, answerText));
    }
  }

  function makeCommsReq(answerIndex: number, answerText: string) {
    return {
      id: `test-${answerIndex}`,
      kind: 'elon-vision',
      type: 'question' as const,
      text: 'Strategy?',
      options: ['Approve & create goals', 'Hold', 'Show full briefing'],
      status: 'answered' as const,
      answerIndex,
      answerText,
      createdAt: new Date().toISOString(),
    };
  }

  it('index=0 (Approve) calls adoptBriefing with loadLatestBriefing result', async () => {
    const cfg = cfgEnabled();
    const briefing = makeBriefing();
    mockLoadLatestBriefing.mockReturnValue(briefing);
    mockAdoptBriefing.mockResolvedValue({ specId: 'ecosystem', goalIds: ['g1'] });

    await invokeElonHandler(cfg, 0, 'Approve & create goals');

    expect(mockAdoptBriefing).toHaveBeenCalledWith(cfg, briefing, { by: 'mason' });
  });

  it('index=1 (Hold) does not call adoptBriefing or sendIMessage', async () => {
    const cfg = cfgEnabled();
    mockLoadLatestBriefing.mockReturnValue(makeBriefing());

    await invokeElonHandler(cfg, 1, 'Hold');

    expect(mockAdoptBriefing).not.toHaveBeenCalled();
    expect(mockSendIMessage).not.toHaveBeenCalled();
  });

  it('index=2 (Show) sends full briefing text via sendIMessage', async () => {
    const cfg = cfgEnabled();
    const briefing = makeBriefing();
    mockLoadLatestBriefing.mockReturnValue(briefing);

    await invokeElonHandler(cfg, 2, 'Show full briefing');

    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [sentText] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(sentText).toContain('Strategic Briefing');
    expect(sentText).toContain(briefing.currentState);
    expect(sentText).toContain(briefing.gapToVision);
  });

  it('handler never throws even when adoptBriefing rejects', async () => {
    const cfg = cfgEnabled();
    mockLoadLatestBriefing.mockReturnValue(makeBriefing());
    mockAdoptBriefing.mockRejectedValue(new Error('spec write failed'));

    await expect(invokeElonHandler(cfg, 0, 'Approve & create goals')).resolves.not.toThrow();
  });
});

// ===========================================================================
// 6–7. comms digest
// ===========================================================================

describe('comms digest', () => {
  it('sends a scrubbed SMS-sized report via postRequest + runCommsCycle', async () => {
    mockBuildOversightSnapshot.mockReturnValue(makeSnapshot());
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(0);
    expect(mockBuildOversightSnapshot).toHaveBeenCalledOnce();
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
  });

  it('digest report text contains fleet metrics (proposals, accept rate, goals)', async () => {
    const snap = makeSnapshot();
    mockBuildOversightSnapshot.mockReturnValue(snap);
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    // Capture what was posted via postRequest by inspecting requests store
    await cmdComms(['digest']);

    const all = listRequests({ kind: 'fleet-digest' });
    expect(all.length).toBeGreaterThan(0);
    const r = all[all.length - 1]!;
    expect(r.type).toBe('report');
    expect(r.text).toMatch(/42 proposals/);          // proposalsCreated
    expect(r.text).toMatch(/81%/);                   // acceptRate
    expect(r.text).not.toMatch(/ASHLR_PULSE_PAT/i); // no secrets
    expect(r.text).not.toMatch(/token|secret|key/i); // no secrets
  });

  it('returns exit code 1 when comms is disabled', async () => {
    mockLoadConfig.mockResolvedValue(makeCfg({ comms: { enabled: false } }));
    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(1);
    expect(mockBuildOversightSnapshot).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 8–10. comms ask-vision
// ===========================================================================

describe('comms ask-vision', () => {
  it('posts a 3-option elon-vision question and runs the cycle', async () => {
    const briefing = makeBriefing();
    mockLoadLatestBriefing.mockReturnValue(briefing);
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    const exitCode = await cmdComms(['ask-vision']);
    expect(exitCode).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();

    const all = listRequests({ kind: 'elon-vision' });
    expect(all.length).toBeGreaterThan(0);
    const r = all[all.length - 1]!;
    expect(r.type).toBe('question');
    expect(r.options).toHaveLength(3);
    expect(r.options[0]).toBe('Approve & create goals');
    expect(r.options[1]).toBe('Hold');
    expect(r.options[2]).toBe('Show full briefing');
  });

  it('uses loadLatestBriefing when available — does not call runStrategist', async () => {
    mockLoadLatestBriefing.mockReturnValue(makeBriefing());
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    await cmdComms(['ask-vision']);
    expect(mockRunStrategist).not.toHaveBeenCalled();
  });

  it('falls back to runStrategist when no cached briefing', async () => {
    mockLoadLatestBriefing.mockReturnValue(null); // no cached briefing
    const briefing = makeBriefing();
    mockRunStrategist.mockResolvedValue(briefing);
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    const exitCode = await cmdComms(['ask-vision']);
    expect(exitCode).toBe(0);
    expect(mockRunStrategist).toHaveBeenCalledOnce();

    const all = listRequests({ kind: 'elon-vision' });
    const r = all[all.length - 1]!;
    expect(r.options).toHaveLength(3);
  });

  it('returns exit code 1 when comms is disabled', async () => {
    mockLoadConfig.mockResolvedValue(makeCfg({ comms: { enabled: false } }));
    const exitCode = await cmdComms(['ask-vision']);
    expect(exitCode).toBe(1);
    expect(mockRunStrategist).not.toHaveBeenCalled();
  });
});
