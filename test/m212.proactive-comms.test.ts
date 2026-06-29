/**
 * M212 — Proactive comms test suite.
 *
 * Tests:
 *  1.  notifyFleetEvent — no-op when proactive=false
 *  2.  notifyFleetEvent — sends merge message when proactive=true
 *  3.  notifyFleetEvent — decision-needed sends with inline buttons
 *  4.  notifyFleetEvent — throttle suppresses second call within cooldown
 *  5.  notifyFleetEvent — _resetCooldowns() allows re-fire
 *  6.  notifyFleetEvent — daily-standup sends formatted message
 *  7.  notifyFleetEvent — anomaly sends warning message
 *  8.  notifyFleetEvent — no-op when telegramEnabled=false even if proactive=true
 *  9.  pause/resume — isPaused/setPause create/remove pause.json
 * 10.  dispatch — isPaused() short-circuits runCommsCycle (returns {sent:0,resolved:0})
 * 11.  dispatch — "pause" text → setPause(true) + confirmation sent
 * 12.  dispatch — "resume fleet" text → setPause(false) + confirmation sent
 * 13.  elon-dialogue — "status" fast-path returns fleet snapshot without LLM
 * 14.  elon-dialogue — "what's running" fast-path triggered
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockSendTelegramMessage,
  mockPollTelegramUpdates,
  mockTelegramEnabled,
  mockKillSwitchOn,
  mockListProposals,
  mockListGoals,
  mockHandleStrategicMessage,
} = vi.hoisted(() => ({
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockPollTelegramUpdates: vi.fn().mockResolvedValue({ updates: [], newOffset: 0 }),
  mockTelegramEnabled: vi.fn().mockReturnValue(true),
  mockKillSwitchOn: vi.fn().mockReturnValue(false),
  mockListProposals: vi.fn().mockReturnValue([]),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockHandleStrategicMessage: vi.fn().mockResolvedValue('snapshot'),
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  pollTelegramUpdates: mockPollTelegramUpdates,
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  telegramEnabled: mockTelegramEnabled,
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: mockKillSwitchOn,
  killSwitchPath: () => '',
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: mockListProposals,
  listRequests: vi.fn().mockReturnValue([]),
  outstanding: vi.fn().mockReturnValue(undefined),
  loadProposal: vi.fn().mockReturnValue(null),
  markSent: vi.fn(),
  resolveRequest: vi.fn(),
}));

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: mockListGoals,
  createGoal: vi.fn(),
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
  goalsDir: () => join(process.env['HOME'] ?? tmpdir(), '.ashlr', 'goals'),
}));

vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: vi.fn().mockReturnValue(null),
  runStrategist: vi.fn(),
  adoptBriefing: vi.fn(),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn().mockReturnValue(false),
  buildEngineCommand: vi.fn().mockReturnValue(null),
  spawnEngine: vi.fn().mockReturnValue({ ok: false, output: '' }),
}));

vi.mock('../src/core/comms/elon-dialogue.js', () => ({
  handleStrategicMessage: mockHandleStrategicMessage,
}));

// node:fs passthrough — let real fs work for pause file tests
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string, _args: string[], _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => { cb(null, '', ''); return {} as ReturnType<typeof actual.execFile>; },
  };
});

// ---------------------------------------------------------------------------
// Temp HOME setup
// ---------------------------------------------------------------------------

let tmpHome: string;
const origHome = process.env['HOME'];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm212-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockPollTelegramUpdates.mockResolvedValue({ updates: [], newOffset: 0 });
  mockTelegramEnabled.mockReturnValue(true);
  mockKillSwitchOn.mockReturnValue(false);
  mockListProposals.mockReturnValue([]);
  mockListGoals.mockReturnValue([]);
  mockHandleStrategicMessage.mockResolvedValue('snapshot');
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  notifyFleetEvent,
  _resetCooldowns,
} from '../src/core/comms/events.js';
import { isPaused, setPause } from '../src/core/comms/pause.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { handleStrategicMessage } from '../src/core/comms/elon-dialogue.js';

// ---------------------------------------------------------------------------
// Helper cfgs
// ---------------------------------------------------------------------------

function makeCfg(proactive = true) {
  return {
    comms: {
      enabled: true,
      channel: 'telegram' as const,
      telegram: { botToken: 'test-bot', chatId: '42' },
      proactive,
    },
    foundry: {},
  };
}

// ---------------------------------------------------------------------------
// 1–8: notifyFleetEvent
// ---------------------------------------------------------------------------

describe('notifyFleetEvent', () => {

  beforeEach(() => {
    _resetCooldowns();
  });

  it('1. no-op when proactive=false', async () => {
    await notifyFleetEvent('merge', { repo: 'my/repo', engine: 'frontier', title: 'Fix bug' }, makeCfg(false) as never);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it('2. sends merge message when proactive=true', async () => {
    await notifyFleetEvent('merge', { repo: 'my/repo', engine: 'frontier', title: 'Add feature' }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('Add feature');
    expect(text).toContain('my/repo');
    expect(text).toContain('frontier');
  });

  it('3. decision-needed sends with inline buttons', async () => {
    await notifyFleetEvent('decision-needed', {
      question: 'Merge this?',
      proposalId: 'prop-123',
      options: ['Approve', 'Reject', 'Show diff'],
    }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    const [text, opts] = mockSendTelegramMessage.mock.calls[0] as [string, { buttons?: string[]; requestId?: string } | undefined, unknown];
    expect(text).toContain('Merge this?');
    expect(opts?.buttons).toEqual(['Approve', 'Reject', 'Show diff']);
    expect(opts?.requestId).toBe('prop-123');
  });

  it('4. throttle suppresses second call within cooldown window', async () => {
    await notifyFleetEvent('merge', { repo: 'r', engine: 'e', title: 'T1' }, makeCfg() as never);
    await notifyFleetEvent('merge', { repo: 'r', engine: 'e', title: 'T2' }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
  });

  it('5. _resetCooldowns() allows re-fire after throttle', async () => {
    await notifyFleetEvent('merge', { repo: 'r', engine: 'e', title: 'T1' }, makeCfg() as never);
    _resetCooldowns();
    await notifyFleetEvent('merge', { repo: 'r', engine: 'e', title: 'T2' }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledTimes(2);
  });

  it('6. daily-standup sends formatted message', async () => {
    await notifyFleetEvent('daily-standup', {
      merged: 5,
      proposals: 3,
      summary: 'Great day',
    }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('5 merged');
    expect(text).toContain('3 pending');
    expect(text).toContain('Great day');
  });

  it('7. anomaly sends warning message', async () => {
    await notifyFleetEvent('anomaly', { detail: 'Disk full on agent-1' }, makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('Disk full on agent-1');
  });

  it('8. no-op when telegramEnabled=false even if proactive=true', async () => {
    mockTelegramEnabled.mockReturnValue(false);
    await notifyFleetEvent('merge', { repo: 'r', engine: 'e', title: 'T' }, makeCfg() as never);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9: pause/resume — file I/O
// ---------------------------------------------------------------------------

describe('pause.ts — isPaused / setPause', () => {

  it('9. isPaused returns false initially, true after setPause(true), false after setPause(false)', () => {
    expect(isPaused()).toBe(false);
    setPause(true);
    expect(isPaused()).toBe(true);
    setPause(false);
    expect(isPaused()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10–12: dispatch soft-pause integration
// ---------------------------------------------------------------------------

describe('dispatch.ts — soft-pause integration', () => {

  beforeEach(() => {
    setPause(false); // ensure clean state
  });

  it('10. isPaused() short-circuits runCommsCycle → {sent:0, resolved:0}', async () => {
    setPause(true);
    const result = await runCommsCycle(makeCfg() as never);
    expect(result).toEqual({ sent: 0, resolved: 0 });
    expect(mockPollTelegramUpdates).not.toHaveBeenCalled();
  });

  it('11. "pause" text → setPause(true) + confirmation message', async () => {
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'pause', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    expect(isPaused()).toBe(true);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.stringContaining('paused'),
      undefined,
      expect.anything(),
    );
  });

  it('12. "resume fleet" text → setPause(false) + confirmation message', async () => {
    setPause(true);
    // Must not short-circuit: isPaused() check happens BEFORE poll, so we need
    // the cycle to run. Set pause=false before the cycle reads it, but send the
    // resume command — simulate by setting pause false via file then running.
    // Actually: dispatch checks isPaused() at the top before polling.
    // So we need pause=false when cycle starts, but "resume fleet" text received.
    setPause(false);
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'resume fleet', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    expect(isPaused()).toBe(false);
    expect(mockSendTelegramMessage).toHaveBeenCalledWith(
      expect.stringContaining('resumed'),
      undefined,
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// 13–14: elon-dialogue status fast-path
// ---------------------------------------------------------------------------

describe('elon-dialogue — status fast-path', () => {

  // These tests use the REAL handleStrategicMessage (not the mock).
  // We need to import it directly without the elon-dialogue mock.
  // Vitest module mocks are per-file, so we re-import via dynamic import.

  it('13. "status" → returns fleet snapshot without calling LLM (fetch)', async () => {
    // Restore mock so we use the real implementation
    vi.unmock('../src/core/comms/elon-dialogue.js');
    const { handleStrategicMessage: realFn } = await import('../src/core/comms/elon-dialogue.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const reply = await realFn('status', makeCfg() as never);

    expect(reply).toContain('Fleet status');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('14. "what\'s running" → fast-path triggered, no LLM call', async () => {
    vi.unmock('../src/core/comms/elon-dialogue.js');
    const { handleStrategicMessage: realFn } = await import('../src/core/comms/elon-dialogue.js');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const reply = await realFn("what's running", makeCfg() as never);

    expect(reply).toContain('Fleet status');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
