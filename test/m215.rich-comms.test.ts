/**
 * M215 — Rich comms test suite.
 *
 * Tests:
 *  1.  merge notification includes diffSummary in message text
 *  2.  merge notification includes inline "View diff" + "Revert" buttons
 *  3.  merge notification — button requestId matches proposalId
 *  4.  merge notification — no proposalId → revert button still created (proposal-only)
 *  5.  buildFleetSnapshot — returns snapshot with dashboard URL
 *  6.  buildFleetSnapshot — never throws (getFrontierUsage mock fails)
 *  7.  buildFleetSnapshot — includes pending proposals
 *  8.  daily-standup — includes dashboard URL in message
 *  9.  daily-standup — includes pendingDecisions in message
 * 10.  daily-standup — capped at 5 pending decisions
 * 11.  dispatch — "snapshot" text command → buildFleetSnapshot reply sent
 * 12.  dispatch — "dashboard" text command → reply sent
 * 13.  dispatch — "revert:<id>:<repo>" text → creates revert proposal + confirmation sent
 * 14.  dispatch — revert confirmation says "pending, not applied"
 * 15.  buildRevertProposal — returns null (not throws) when bisect fails
 * 16.  buildRevertProposal — NEVER auto-applies (proposal returned is pending)
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
  mockGetFrontierUsage,
  mockListProposals,
  mockBisectAndRevert,
} = vi.hoisted(() => ({
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockPollTelegramUpdates: vi.fn().mockResolvedValue({ updates: [], newOffset: 0 }),
  mockTelegramEnabled: vi.fn().mockReturnValue(true),
  mockGetFrontierUsage: vi.fn().mockResolvedValue({
    generatedAt: '2026-06-28T00:00:00.000Z',
    engines: [
      {
        engine: 'claude',
        callsToday: 12,
        costToday: 0.42,
        subscriptionWindow: { state: 'active', usedPct: 34, windowLabel: '1d' },
        remainingEstimate: 88,
        limit: 100,
      },
      {
        engine: 'codex',
        callsToday: 5,
        subscriptionWindow: { state: 'active', usedPct: 10, windowLabel: '1d' },
      },
    ],
  }),
  mockListProposals: vi.fn().mockReturnValue([
    { id: 'prop-1', title: 'Fix flaky test in auth', status: 'pending' },
    { id: 'prop-2', title: 'Upgrade tslib', status: 'pending' },
  ]),
  mockBisectAndRevert: vi.fn().mockResolvedValue({
    culprit: 'abc12345',
    revertProposal: {
      culprit: 'abc12345',
      culpritProposalId: 'prop-abc',
      proposal: {
        id: 'revert-prop-1',
        title: 'Revert regressing auto-merge abc12345 in my-repo',
        status: 'pending',
        diff: '# revert abc12345\n',
      },
    },
  }),
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  pollTelegramUpdates: mockPollTelegramUpdates,
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  telegramEnabled: mockTelegramEnabled,
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: vi.fn().mockReturnValue(false),
  killSwitchPath: () => '',
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: mockListProposals,
  listRequests: vi.fn().mockReturnValue([]),
  outstanding: vi.fn().mockReturnValue(undefined),
  loadProposal: vi.fn().mockReturnValue(null),
  markSent: vi.fn(),
  resolveRequest: vi.fn(),
  createProposal: vi.fn((data: unknown) => ({ id: 'revert-prop-1', status: 'pending', ...((data as object) ?? {}) })),
}));

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: vi.fn().mockReturnValue([]),
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
  handleStrategicMessage: vi.fn().mockResolvedValue('fleet snapshot from elon'),
}));

vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsage: mockGetFrontierUsage,
}));

vi.mock('../src/core/fleet/regression-sentinel.js', () => ({
  bisectAndRevert: mockBisectAndRevert,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string, _args: string[], _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => { cb(null, '', ''); return {} as ReturnType<typeof actual.execFile>; },
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '', error: null }),
  };
});

// ---------------------------------------------------------------------------
// Temp HOME setup
// ---------------------------------------------------------------------------

let tmpHome: string;
const origHome = process.env['HOME'];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm215-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();
  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockPollTelegramUpdates.mockResolvedValue({ updates: [], newOffset: 0 });
  mockTelegramEnabled.mockReturnValue(true);
  mockGetFrontierUsage.mockResolvedValue({
    generatedAt: '2026-06-28T00:00:00.000Z',
    engines: [
      {
        engine: 'claude',
        callsToday: 12,
        costToday: 0.42,
        subscriptionWindow: { state: 'active', usedPct: 34, windowLabel: '1d' },
      },
    ],
  });
  mockListProposals.mockReturnValue([
    { id: 'prop-1', title: 'Fix flaky test in auth', status: 'pending' },
    { id: 'prop-2', title: 'Upgrade tslib', status: 'pending' },
  ]);
  mockBisectAndRevert.mockResolvedValue({
    culprit: 'abc12345',
    revertProposal: {
      culprit: 'abc12345',
      proposal: {
        id: 'revert-prop-1',
        title: 'Revert regressing auto-merge abc12345 in my-repo',
        status: 'pending',
        diff: '# revert abc12345\n',
      },
    },
  });
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
  buildFleetSnapshot,
  buildRevertProposal,
  _resetCooldowns,
} from '../src/core/comms/events.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { setPause } from '../src/core/comms/pause.js';

// ---------------------------------------------------------------------------
// Helper
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
// 1–4: merge notification enrichment
// ---------------------------------------------------------------------------

describe('notifyFleetEvent — merge (M215)', () => {
  beforeEach(() => { _resetCooldowns(); });

  it('1. merge with diffSummary includes it in message text', async () => {
    await notifyFleetEvent(
      'merge',
      { repo: 'acme/api', engine: 'claude', title: 'Fix auth', diffSummary: '@@ -1,3 +1,4 @@ const x = 1;' },
      makeCfg() as never,
    );
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('Fix auth');
    expect(text).toContain('@@ -1,3 +1,4 @@');
  });

  it('2. merge notification includes "View diff" and "Revert" buttons', async () => {
    await notifyFleetEvent(
      'merge',
      { repo: 'acme/api', engine: 'claude', title: 'Fix auth', proposalId: 'prop-xyz' },
      makeCfg() as never,
    );
    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [string, { buttons?: string[] } | undefined, unknown];
    expect(opts?.buttons).toBeDefined();
    expect(opts?.buttons?.length).toBe(2);
    const buttonText = opts?.buttons?.join(' ');
    expect(buttonText).toContain('View diff');
    expect(buttonText).toContain('Revert');
  });

  it('3. merge button requestId matches proposalId', async () => {
    await notifyFleetEvent(
      'merge',
      { repo: 'acme/api', engine: 'claude', title: 'Fix auth', proposalId: 'prop-xyz' },
      makeCfg() as never,
    );
    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [string, { requestId?: string } | undefined, unknown];
    expect(opts?.requestId).toBe('prop-xyz');
  });

  it('4. merge without proposalId still sends buttons (proposal-only safe)', async () => {
    await notifyFleetEvent(
      'merge',
      { repo: 'acme/api', engine: 'claude', title: 'No id merge' },
      makeCfg() as never,
    );
    const [, opts] = mockSendTelegramMessage.mock.calls[0] as [string, { buttons?: string[] } | undefined, unknown];
    expect(opts?.buttons?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5–7: buildFleetSnapshot
// ---------------------------------------------------------------------------

describe('buildFleetSnapshot (M215)', () => {

  it('5. returns snapshot containing dashboard URL', async () => {
    const snap = await buildFleetSnapshot(makeCfg() as never);
    expect(snap).toContain('localhost:4317');
    expect(snap).toContain('Fleet snapshot');
  });

  it('6. never throws when getFrontierUsage rejects', async () => {
    mockGetFrontierUsage.mockRejectedValueOnce(new Error('network fail'));
    const snap = await buildFleetSnapshot(makeCfg() as never);
    // Still returns something with the dashboard URL
    expect(snap).toContain('localhost:4317');
  });

  it('7. includes pending proposal count and titles', async () => {
    const snap = await buildFleetSnapshot(makeCfg() as never);
    expect(snap).toContain('Fix flaky test in auth');
  });
});

// ---------------------------------------------------------------------------
// 8–10: daily-standup enrichment
// ---------------------------------------------------------------------------

describe('notifyFleetEvent — daily-standup (M215)', () => {
  beforeEach(() => { _resetCooldowns(); });

  it('8. daily-standup includes dashboard URL', async () => {
    await notifyFleetEvent(
      'daily-standup',
      { merged: 3, proposals: 2, summary: 'Solid day' },
      makeCfg() as never,
    );
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('localhost:4317');
  });

  it('9. daily-standup includes pendingDecisions list', async () => {
    await notifyFleetEvent(
      'daily-standup',
      {
        merged: 1,
        proposals: 2,
        pendingDecisions: ['Upgrade Node', 'Enable auto-merge'],
      },
      makeCfg() as never,
    );
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    expect(text).toContain('Upgrade Node');
    expect(text).toContain('Enable auto-merge');
  });

  it('10. daily-standup caps pendingDecisions at 5', async () => {
    const decisions = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    await notifyFleetEvent(
      'daily-standup',
      { merged: 0, proposals: 7, pendingDecisions: decisions },
      makeCfg() as never,
    );
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    // F and G should not appear (items 6+)
    expect(text).not.toContain('F\n');
    expect(text).not.toContain('G\n');
    // First 5 should appear
    expect(text).toContain('A');
    expect(text).toContain('E');
  });
});

// ---------------------------------------------------------------------------
// 11–14: dispatch text commands
// ---------------------------------------------------------------------------

describe('dispatch.ts — M215 text commands', () => {
  beforeEach(() => { setPause(false); });

  it('11. "snapshot" text → calls buildFleetSnapshot and sends reply', async () => {
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'snapshot', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    expect(mockSendTelegramMessage).toHaveBeenCalled();
    const calls = mockSendTelegramMessage.mock.calls as [string, unknown, unknown][];
    const texts = calls.map(([t]) => t);
    // At least one call contains the fleet snapshot content
    expect(texts.some((t) => t.includes('localhost:4317'))).toBe(true);
  });

  it('12. "dashboard" text → reply contains dashboard URL', async () => {
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'dashboard', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    const calls = mockSendTelegramMessage.mock.calls as [string, unknown, unknown][];
    expect(calls.some(([t]) => t.includes('localhost:4317'))).toBe(true);
  });

  it('13. "revert:<id>:<repo>" text → sends proposal confirmation', async () => {
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'revert:prop-abc:/home/user/my-repo', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    const calls = mockSendTelegramMessage.mock.calls as [string, unknown, unknown][];
    expect(calls.length).toBeGreaterThan(0);
    const texts = calls.map(([t]) => t);
    expect(texts.some((t) => t.includes('proposal') || t.includes('revert'))).toBe(true);
  });

  it('14. revert confirmation text says "pending, not applied"', async () => {
    mockPollTelegramUpdates.mockResolvedValueOnce({
      updates: [{ kind: 'text', text: 'revert:prop-abc:/home/user/my-repo', fromChatId: '42' }],
      newOffset: 1,
    });
    await runCommsCycle(makeCfg() as never);
    const calls = mockSendTelegramMessage.mock.calls as [string, unknown, unknown][];
    const texts = calls.map(([t]) => t);
    const confirmText = texts.find((t) => t.toLowerCase().includes('pending') || t.toLowerCase().includes('not applied'));
    expect(confirmText).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 15–16: buildRevertProposal safety
// ---------------------------------------------------------------------------

describe('buildRevertProposal (M215)', () => {

  it('15. returns null (not throws) when bisectAndRevert produces no culprit', async () => {
    mockBisectAndRevert.mockResolvedValueOnce({ reason: 'no candidates' });
    const result = await buildRevertProposal('prop-gone', '/tmp/repo', makeCfg() as never);
    expect(result).toBeNull();
  });

  it('16. returned proposal has status "pending" — never auto-applied', async () => {
    const result = await buildRevertProposal('prop-abc', '/tmp/my-repo', makeCfg() as never);
    // When bisect returns a revertProposal, buildRevertProposal returns it
    expect(result).not.toBeNull();
    expect(result?.status).toBe('pending');
  });
});
