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
 *   2. elon-vision index=0 (legacy Approve) adopts NOTHING (3.14: the stale
 *      Strategist briefing is retired) and says so
 *   3. elon-vision index=1 (Hold) is a no-op — adoptBriefing/sendIMessage not called
 *   4. elon-vision index=2 (legacy Show) sends the retirement note, not the stale briefing
 *   5. elon-vision handler never throws even when adoptBriefing rejects
 *   6. comms digest (3.14 change-driven) queues and delivers a report
 *   7. an idle digest is one honest line — no "nominal", κ or vision-% noise
 *   8. comms ask-vision runs the Leader tick path; the memo is delivered by
 *      the Leader thread (3.14 — no comms request is posted, the old
 *      "Keep it / Veto" question is retired) and the CLI reports honestly
 *      whether it was delivered, queued or stuck
 *   9. comms ask-vision never reaches the legacy runStrategist / briefing path
 *  10. no Leader memo yet ⇒ nothing posted, exit 1; a memo is posted once
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** A fake cycle that delivers every pending report (what the real dispatch does). */
async function deliverPendingReports(): Promise<{ sent: number; resolved: number }> {
  const { listRequests: lr, markReportDelivered } = await import('../src/core/comms/requests.js');
  const pending = lr({ status: 'pending', type: 'report' });
  for (const r of pending) markReportDelivered(r.id);
  return { sent: pending.length, resolved: pending.length };
}
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  mockLoadConfigReadOnlyStrict,
  mockLeaderTick,
  mockBuildLeaderState,
} = vi.hoisted(() => ({
  mockLeaderTick: vi.fn(),
  mockBuildLeaderState: vi.fn(),
  mockSendIMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockAdoptBriefing: vi.fn().mockResolvedValue({ specId: 'ecosystem', goalIds: ['g1', 'g2'] }),
  mockLoadLatestBriefing: vi.fn(),
  mockRunStrategist: vi.fn(),
  mockBuildOversightSnapshot: vi.fn(),
  mockRunCommsCycle: vi.fn().mockResolvedValue({ sent: 1, resolved: 0 }),
  mockLoadConfig: vi.fn(),
  mockLoadConfigReadOnlyStrict: vi.fn(),
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
// Mock: the Leader (V3.10) — ask-vision runs `ashlr leader tick`'s path
// ---------------------------------------------------------------------------
const leaderThread = vi.hoisted(() => ({
  memoState: null as null | 'pending' | 'sent' | 'failed',
  sync: vi.fn(),
}));
vi.mock('../src/core/vision/leader-thread.js', () => ({
  syncLeaderMemosToThread: leaderThread.sync,
  listThread: vi.fn(() =>
    leaderThread.memoState === null
      ? []
      : [{
          id: 'lt-20260924063000-aaaaaa', at: '2026-09-24T06:30:00.000Z', from: 'leader', channel: 'system', kind: 'memo',
          text: 'Memo lm-20260924063000-abcdef', memoId: 'lm-20260924063000-abcdef',
          delivery: { telegram: leaderThread.memoState, ...(leaderThread.memoState === 'sent' ? { sentAt: '2026-09-24T06:33:00.000Z' } : {}) },
        }],
  ),
}));

vi.mock('../src/core/vision/leader.js', () => ({
  loadDefaultLeaderRunDeps: vi.fn(async () => ({ fake: 'deps' })),
  leaderTick: mockLeaderTick,
  buildLeaderState: mockBuildLeaderState,
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
  loadConfigReadOnlyStrict: mockLoadConfigReadOnlyStrict,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { registerCommsHandlers } from '../src/core/comms/handlers.js';
import { postRequest, listRequests } from '../src/core/comms/requests.js';
import { cmdComms } from '../src/cli/comms.js';
import { setTelegramTransportForTests, TELEGRAM_PHANTOM_BRAND } from '../src/core/integrations/telegram.js';
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
  mockLoadConfigReadOnlyStrict.mockReset();
});

afterEach(() => {
  setTelegramTransportForTests(null);
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

  it('index=0 (legacy Approve) adopts nothing — the stale Strategist briefing is retired (3.14)', async () => {
    const cfg = cfgEnabled();
    mockLoadLatestBriefing.mockReturnValue(makeBriefing());

    await invokeElonHandler(cfg, 0, 'Approve & create goals');

    expect(mockAdoptBriefing).not.toHaveBeenCalled();
    expect(mockLoadLatestBriefing).not.toHaveBeenCalled();
    expect(mockSendIMessage).toHaveBeenCalledOnce();
    expect((mockSendIMessage.mock.calls[0] as [string])[0]).toMatch(/retired; nothing was adopted/);
  });

  it('index=1 (Hold) does not call adoptBriefing or sendIMessage', async () => {
    const cfg = cfgEnabled();
    mockLoadLatestBriefing.mockReturnValue(makeBriefing());

    await invokeElonHandler(cfg, 1, 'Hold');

    expect(mockAdoptBriefing).not.toHaveBeenCalled();
    expect(mockSendIMessage).not.toHaveBeenCalled();
  });

  it('index=2 (legacy Show) sends the retirement note, never the stale briefing', async () => {
    const cfg = cfgEnabled();
    const briefing = makeBriefing();
    mockLoadLatestBriefing.mockReturnValue(briefing);

    await invokeElonHandler(cfg, 2, 'Show full briefing');

    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [sentText] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(sentText).not.toContain(briefing.currentState);
    expect(sentText).toContain('phm leader show');
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
  it('queues a report and runs a cycle that delivers it', async () => {
    mockRunCommsCycle.mockImplementation(deliverPendingReports);

    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
    const all = listRequests({ kind: 'fleet-digest' });
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe('report');
    expect(all[0]!.status).toBe('answered');
  });

  it('an idle fleet gets one honest line — no "nominal", κ or vision-% noise; then silence', async () => {
    mockRunCommsCycle.mockImplementation(deliverPendingReports);

    await cmdComms(['digest']);
    const [r] = listRequests({ kind: 'fleet-digest' });
    expect(r!.text).toMatch(/^Fleet idle/);
    expect(r!.text).toMatch(/autonomy is off — next step: `phm authority setup`/);
    expect(r!.text).not.toMatch(/nominal|κ|kappa|Vision progress|0 proposals/i);
    // The old digest read the oversight snapshot; the change-driven one does not.
    expect(mockBuildOversightSnapshot).not.toHaveBeenCalled();

    // Nothing changed since: the second digest is silent (exit 0, nothing queued).
    expect(await cmdComms(['digest'])).toBe(0);
    expect(listRequests({ kind: 'fleet-digest' })).toHaveLength(1);
  });

  it('returns exit code 1 when comms is disabled', async () => {
    mockLoadConfig.mockResolvedValue(makeCfg({ comms: { enabled: false } }));
    const exitCode = await cmdComms(['digest']);
    expect(exitCode).toBe(1);
    expect(listRequests({ kind: 'fleet-digest' })).toHaveLength(0);
  });
});

// ===========================================================================
// 8–10. comms ask-vision
// ===========================================================================

describe('comms ask-vision', () => {
  const MEMO_ID = 'lm-20260924063000-abcdef';
  function leaderMemo(overrides: Record<string, unknown> = {}) {
    return {
      id: MEMO_ID, at: '2026-09-24T06:30:00.000Z', status: 'ok', dryRun: false,
      bottleneck: { statement: 'Too many open goals', metric: 'active-goals', evidence: [] },
      move: { statement: 'Prune to four goals', why: 'focus', expectedDelta: null },
      killList: [], questionsForMason: ['Should ashlr-cortex get a verify command?'],
      actions: [{ status: 'applied' }, { status: 'refused' }],
      ...overrides,
    };
  }
  function telegramCfg(): AshlrConfig {
    return makeCfg({ comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token', chatId: '42' } } });
  }
  function capture(): { logs: string[]; errors: string[]; restore: () => void } {
    const logs: string[] = [];
    const errors: string[] = [];
    const l = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const e = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
    return { logs, errors, restore: () => { l.mockRestore(); e.mockRestore(); } };
  }

  beforeEach(() => {
    mockLeaderTick.mockResolvedValue({ applied: [], graded: [], due: { due: false }, started: false, run: null });
    mockBuildLeaderState.mockReturnValue({ latest: leaderMemo() });
    mockLoadConfig.mockResolvedValue(telegramCfg());
    leaderThread.memoState = 'pending';
    leaderThread.sync.mockClear();
  });

  it('runs the Leader tick, lets the cycle drain the Leader thread, and posts NO comms request', async () => {
    mockRunCommsCycle.mockImplementation(async () => {
      leaderThread.memoState = 'sent';
      return { sent: 1, resolved: 0 };
    });
    const out = capture();
    let exitCode: number;
    try {
      exitCode = await cmdComms(['ask-vision']);
    } finally {
      out.restore();
    }
    expect(exitCode).toBe(0);
    expect(mockLeaderTick).toHaveBeenCalledWith({ fake: 'deps' }, { awaitRun: true });
    expect(leaderThread.sync).toHaveBeenCalled();
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
    // The retired "Keep it / Veto this memo / Show full memo" question is gone.
    expect(listRequests()).toHaveLength(0);
    expect(out.logs.join('\n')).toContain(`Leader memo ${MEMO_ID} is queued in the Leader thread, not delivered yet`);
    expect(out.logs.join('\n')).toContain(`Leader memo ${MEMO_ID} delivered to Telegram (chat 42)`);
  });

  it('never reaches the legacy Strategist path', async () => {
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });
    const out = capture();
    try { await cmdComms(['ask-vision']); } finally { out.restore(); }
    expect(mockRunStrategist).not.toHaveBeenCalled();
    expect(mockLoadLatestBriefing).not.toHaveBeenCalled();
  });

  it('no ok memo yet ⇒ exit 1 and the thread is not consulted', async () => {
    mockBuildLeaderState.mockReturnValue({ latest: leaderMemo({ status: 'no-seat' }) });
    const out = capture();
    try { expect(await cmdComms(['ask-vision'])).toBe(1); } finally { out.restore(); }
    expect(leaderThread.sync).not.toHaveBeenCalled();
    expect(out.errors.join('\n')).toContain('No Leader memo yet');
  });

  it('an already-delivered memo says when (exit 0)', async () => {
    leaderThread.memoState = 'sent';
    mockRunCommsCycle.mockResolvedValue({ sent: 0, resolved: 0 });
    const out = capture();
    try { expect(await cmdComms(['ask-vision'])).toBe(0); } finally { out.restore(); }
    expect(out.logs.join('\n')).toContain(`Leader memo ${MEMO_ID} was already delivered at 2026-09-24T06:33:00.000Z`);
  });

  it('says "queued, not delivered" (exit 1) instead of "already sent" when the memo is stuck', async () => {
    mockRunCommsCycle.mockResolvedValue({ sent: 0, resolved: 0 });
    const out = capture();
    try {
      expect(await cmdComms(['ask-vision'])).toBe(1);
    } finally {
      out.restore();
    }
    expect(out.logs.join('\n')).toContain(`Leader memo ${MEMO_ID} is queued in the Leader thread, not delivered yet`);
    expect(out.logs.join('\n')).not.toMatch(/already sent/);
    expect(out.errors.join('\n')).toContain('was not delivered');
  });

  it('returns exit code 1 when comms is disabled', async () => {
    mockLoadConfig.mockResolvedValue(makeCfg({ comms: { enabled: false } }));
    const exitCode = await cmdComms(['ask-vision']);
    expect(exitCode).toBe(1);
    expect(mockLeaderTick).not.toHaveBeenCalled();
  });
});

describe('comms telegram-brand explicit operator command', () => {
  const botId = 123456789;
  function setup(target = false) {
    const values = { name: target ? TELEGRAM_PHANTOM_BRAND.name : 'Ashlr',
      description: target ? TELEGRAM_PHANTOM_BRAND.description : 'Old description',
      short_description: target ? TELEGRAM_PHANTOM_BRAND.shortDescription : 'Old short description' };
    mockLoadConfigReadOnlyStrict.mockReturnValue(makeCfg({ comms: { enabled: true, channel: 'telegram',
      telegram: { botToken: 'fake-private-brand-token', chatId: 'fake-private-chat' } } }));
    const calls: string[] = [];
    setTelegramTransportForTests(async (method, body) => {
      calls.push(method);
      if (method === 'getMe') return { ok: true, result: { id: botId, is_bot: true, username: 'test_phantom_bot' } };
      if (method.startsWith('getMy')) return { ok: true, result: { ...values } };
      const key = method === 'setMyName' ? 'name' : method === 'setMyDescription' ? 'description' : 'short_description';
      values[key] = String(body[key]); return { ok: true, result: true };
    });
    return calls;
  }
  it('defaults to read-only preview and never loads writable config or runs the comms cycle', async () => {
    const calls = setup(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mockLoadConfig.mockClear(); mockRunCommsCycle.mockClear();
      expect(await cmdComms(['--help'])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('Phantom comms');
      expect(log.mock.calls.flat().join('\n')).toContain('Usage: phm comms');
      expect(log.mock.calls.flat().join('\n')).toContain('Compatible alias: ashlr comms <command>');
      expect(mockLoadConfigReadOnlyStrict).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(await cmdComms(['telegram-brand', '--json'])).toBe(0);
      const result = JSON.parse(log.mock.calls.at(-1)![0] as string);
      expect(result).toMatchObject({ mode: 'preview', status: 'preview', botId });
      expect(calls).toEqual(['getMe', 'getMyName', 'getMyDescription', 'getMyShortDescription']);
      expect(mockLoadConfigReadOnlyStrict).toHaveBeenCalledTimes(1); expect(mockLoadConfig).not.toHaveBeenCalled();
      expect(mockRunCommsCycle).not.toHaveBeenCalled(); expect(existsSync(join(_tmpHome, '.ashlr', 'comms'))).toBe(false);
      expect(JSON.stringify(log.mock.calls)).not.toContain('fake-private');
    } finally { log.mockRestore(); }
  });
  it.each([['--apply'], ['--apply', '--preview', '--expected-bot-id', '123'], ['--locale', 'en'],
    ['--expected-bot-id', '123'], ['--apply', '--expected-bot-id', '0'], ['--apply', '--expected-bot-id', '1e3'],
    ['--apply', '--expected-bot-id', '9007199254740992'], ['--json', '--json'], ['--token', 'fake-private']])('rejects unsafe/unsupported flags before config or contact: %s', async (...flags) => {
    const calls = setup(); const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdComms(['telegram-brand', ...flags])).toBe(2);
      expect(error.mock.calls.flat().join('\n')).toContain('usage: phm comms telegram-brand');
      expect(mockLoadConfigReadOnlyStrict).not.toHaveBeenCalled(); expect(calls).toEqual([]);
      expect(JSON.stringify(error.mock.calls)).not.toContain('fake-private');
    } finally { error.mockRestore(); }
  });
  it('applies only through explicit expected bot ID and outputs verified safe facts', async () => {
    const calls = setup(); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdComms(['telegram-brand', '--apply', '--expected-bot-id', String(botId), '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ mode: 'apply', status: 'verified', botId });
      expect(calls.filter((method) => method.startsWith('set'))).toEqual(['setMyName', 'setMyDescription', 'setMyShortDescription']);
      expect(calls).not.toContain('sendMessage'); expect(calls).not.toContain('getUpdates');
    } finally { log.mockRestore(); }
  });
  it('returns nonzero on partial/unknown readback and never prints token-bearing errors', async () => {
    setup(); setTelegramTransportForTests(async (method) => {
      if (method === 'getMe') return { ok: true, result: { id: botId, is_bot: true } };
      if (method.startsWith('getMy')) return { ok: true, result: { name: 'Old', description: 'Old', short_description: 'Old' } };
      throw new Error('fake-private-brand-token https://api.telegram.org/botfake-private-brand-token');
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdComms(['telegram-brand', '--apply', '--expected-bot-id', String(botId), '--json'])).toBe(1);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string).status).toBe('partial');
      expect(JSON.stringify(log.mock.calls)).not.toContain('fake-private');
    } finally { log.mockRestore(); }
  });
  it('refuses unreadable config without provider contact or unsafe exception details', async () => {
    const calls = setup(); mockLoadConfigReadOnlyStrict.mockImplementation(() => { throw new Error('/private/home/fake-private-token'); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cmdComms(['telegram-brand', '--json'])).toBe(1); expect(calls).toEqual([]);
      expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toEqual({ status: 'blocked', reason: 'configuration-or-operation-unavailable' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('fake-private');
    } finally { log.mockRestore(); }
  });
});
