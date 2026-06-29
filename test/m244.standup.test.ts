/**
 * M244 — Rich daily standup test suite.
 *
 * Tests:
 *  1.  buildDailyStandup — contains header with date
 *  2.  buildDailyStandup — shipped proposals count from applied in 24h
 *  3.  buildDailyStandup — proposals shipped more than 24h ago are excluded
 *  4.  buildDailyStandup — per-repo breakdown included when repos present
 *  5.  buildDailyStandup — pending proposals count shown
 *  6.  buildDailyStandup — judge verdict breakdown (ship/review/noise/harmful)
 *  7.  buildDailyStandup — per-engine ship-rates from decisions
 *  8.  buildDailyStandup — active goals + milestone progress
 *  9.  buildDailyStandup — frontier usage / cost (getFrontierUsage)
 * 10.  buildDailyStandup — self-improvement: anti-playbook + skill counts from hub
 * 11.  buildDailyStandup — recent anti-playbook lesson title shown
 * 12.  buildDailyStandup — contains dashboard URL
 * 13.  buildDailyStandup — never throws when all data sources fail
 * 14.  buildDailyStandup — never throws when getFrontierUsage rejects
 * 15.  buildDailyStandup — output is bounded (≤ 3000 chars on very long data)
 * 16.  notifyFleetEvent 'daily-standup' — uses buildDailyStandup output (rich report)
 * 17.  notifyFleetEvent 'daily-standup' — no-op when proactive=false
 * 18.  notifyFleetEvent 'daily-standup' — no-op when telegram not configured
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixed test timestamp (all 24h window comparisons anchored here)
// ---------------------------------------------------------------------------

const FIXED_NOW_MS = new Date('2026-06-29T08:00:00.000Z').getTime();
const WITHIN_24H   = new Date(FIXED_NOW_MS - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
const OUTSIDE_24H  = new Date(FIXED_NOW_MS - 25 * 60 * 60 * 1000).toISOString(); // 25h ago

// ---------------------------------------------------------------------------
// Hoisted mocks — no runtime constants allowed inside vi.hoisted()
// ---------------------------------------------------------------------------

const {
  mockSendTelegramMessage,
  mockTelegramEnabled,
  mockListProposals,
  mockReadDecisions,
  mockListGoals,
  mockGetFrontierUsage,
} = vi.hoisted(() => ({
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockTelegramEnabled: vi.fn().mockReturnValue(true),
  mockListProposals: vi.fn().mockReturnValue([]),
  mockReadDecisions: vi.fn().mockReturnValue([]),
  mockListGoals: vi.fn().mockReturnValue([]),
  // default resolved value set in beforeEach so WITHIN_24H is accessible
  mockGetFrontierUsage: vi.fn(),
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  pollTelegramUpdates: vi.fn().mockResolvedValue({ updates: [], newOffset: 0 }),
  answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
  telegramEnabled: mockTelegramEnabled,
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: mockListProposals,
  listRequests: vi.fn().mockReturnValue([]),
  outstanding: vi.fn().mockReturnValue(undefined),
  loadProposal: vi.fn().mockReturnValue(null),
  markSent: vi.fn(),
  resolveRequest: vi.fn(),
  createProposal: vi.fn(),
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: mockReadDecisions,
  recordDecision: vi.fn(),
  decisionsDir: () => '',
}));

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: mockListGoals,
  createGoal: vi.fn(),
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
  goalsDir: () => join(process.env['HOME'] ?? tmpdir(), '.ashlr', 'goals'),
}));

vi.mock('../src/core/usage/frontier-usage.js', () => ({
  getFrontierUsage: mockGetFrontierUsage,
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: vi.fn().mockReturnValue(false),
  killSwitchPath: () => '',
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn().mockReturnValue(false),
  buildEngineCommand: vi.fn().mockReturnValue(null),
  spawnEngine: vi.fn().mockReturnValue({ ok: false, output: '' }),
}));

vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: vi.fn().mockReturnValue(null),
  runStrategist: vi.fn(),
  adoptBriefing: vi.fn(),
}));

vi.mock('../src/core/comms/elon-dialogue.js', () => ({
  handleStrategicMessage: vi.fn().mockResolvedValue('snapshot'),
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
// Temp HOME + hub.jsonl setup helpers
// ---------------------------------------------------------------------------

let tmpHome: string;
const origHome = process.env['HOME'];

/** Write a genome hub.jsonl file with given entries. */
function writeHubEntries(entries: Array<{ tags: string[]; ts: string; title: string }>): void {
  const genomeDir = join(tmpHome, '.ashlr', 'genome');
  mkdirSync(genomeDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify({
    id: `test-${Math.random().toString(36).slice(2)}`,
    source: 'hub',
    project: null,
    title: e.title,
    text: e.title,
    tags: e.tags,
    ts: e.ts,
  }));
  writeFileSync(join(genomeDir, 'hub.jsonl'), lines.join('\n') + '\n', 'utf8');
}

// Patch Date.now() to return a fixed value so 24h window is deterministic.
const origDateNow = Date.now;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm244-'));
  process.env['HOME'] = tmpHome;
  vi.clearAllMocks();

  // Freeze time
  vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);

  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockTelegramEnabled.mockReturnValue(true);
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
  mockListGoals.mockReturnValue([]);
  mockGetFrontierUsage.mockResolvedValue({ generatedAt: WITHIN_24H, engines: [] });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
  Date.now = origDateNow;
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  buildDailyStandup,
  notifyFleetEvent,
  _resetCooldowns,
} from '../src/core/comms/events.js';

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
// Tests
// ---------------------------------------------------------------------------

describe('buildDailyStandup — M244', () => {

  it('1. contains date header', async () => {
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toMatch(/Fleet morning report/);
    // Date portion of UTCString
    expect(text).toMatch(/2026/);
  });

  it('2. counts applied proposals within 24h as shipped', async () => {
    mockListProposals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'applied') {
        return [
          { id: 'p1', title: 'Fix auth', repo: 'acme/api', status: 'applied', decidedAt: WITHIN_24H },
          { id: 'p2', title: 'Upgrade deps', repo: 'acme/api', status: 'applied', decidedAt: WITHIN_24H },
        ];
      }
      return [];
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('2 shipped');
  });

  it('3. applied proposals outside 24h window are NOT counted', async () => {
    mockListProposals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'applied') {
        return [
          { id: 'p1', title: 'Old fix', repo: 'acme/api', status: 'applied', decidedAt: OUTSIDE_24H },
        ];
      }
      return [];
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('0 shipped');
    expect(text).not.toContain('Old fix');
  });

  it('4. per-repo breakdown shown when repos are present', async () => {
    mockListProposals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'applied') {
        return [
          { id: 'p1', title: 'A', repo: 'myorg/backend', status: 'applied', decidedAt: WITHIN_24H },
          { id: 'p2', title: 'B', repo: 'myorg/backend', status: 'applied', decidedAt: WITHIN_24H },
          { id: 'p3', title: 'C', repo: 'myorg/frontend', status: 'applied', decidedAt: WITHIN_24H },
        ];
      }
      return [];
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('backend: 2');
    expect(text).toContain('frontend: 1');
  });

  it('5. pending proposals count is shown', async () => {
    mockListProposals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'pending') {
        return [
          { id: 'q1', title: 'Waiting 1', status: 'pending' },
          { id: 'q2', title: 'Waiting 2', status: 'pending' },
          { id: 'q3', title: 'Waiting 3', status: 'pending' },
        ];
      }
      return [];
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('3 pending');
  });

  it('6. judge verdict breakdown shown', async () => {
    mockReadDecisions.mockReturnValue([
      { ts: WITHIN_24H, proposalId: 'p1', action: 'judged', verdict: 'ship',   engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p2', action: 'judged', verdict: 'ship',   engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p3', action: 'judged', verdict: 'review', engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p4', action: 'judged', verdict: 'noise',  engine: 'codex' },
      { ts: WITHIN_24H, proposalId: 'p5', action: 'judged', verdict: 'harmful',engine: 'codex' },
    ]);
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('ship: 2');
    expect(text).toContain('review: 1');
    expect(text).toContain('noise: 1');
    expect(text).toContain('harmful: 1');
  });

  it('7. per-engine ship-rates from decisions ledger', async () => {
    mockReadDecisions.mockReturnValue([
      { ts: WITHIN_24H, proposalId: 'p1', action: 'judged', verdict: 'ship', engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p2', action: 'judged', verdict: 'ship', engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p3', action: 'judged', verdict: 'noise', engine: 'claude' },
      { ts: WITHIN_24H, proposalId: 'p4', action: 'judged', verdict: 'ship', engine: 'codex' },
      { ts: WITHIN_24H, proposalId: 'p5', action: 'judged', verdict: 'harmful', engine: 'codex' },
    ]);
    const text = await buildDailyStandup(makeCfg() as never);
    // claude: 2/3 = 67%
    expect(text).toContain('claude: 2/3 (67%)');
    // codex: 1/2 = 50%
    expect(text).toContain('codex: 1/2 (50%)');
  });

  it('8. active goals with milestone progress are shown', async () => {
    mockListGoals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'active') {
        return [
          {
            id: 'g1',
            objective: 'Ship the auth module',
            status: 'active',
            milestones: [
              { status: 'done' },
              { status: 'done' },
              { status: 'pending' },
              { status: 'skipped' },  // should not count in denominator
            ],
          },
        ];
      }
      return [];
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('Active goals: 1');
    expect(text).toContain('Ship the auth module');
    // 2 done out of 3 non-skipped
    expect(text).toContain('[2/3]');
  });

  it('9. frontier usage per-engine is shown', async () => {
    mockGetFrontierUsage.mockResolvedValue({
      generatedAt: WITHIN_24H,
      engines: [
        {
          engine: 'claude',
          callsToday: 24,
          costToday: 1.23,
          subscriptionWindow: { state: 'active', usedPct: 48, windowLabel: '1d' },
        },
        {
          engine: 'codex',
          callsToday: 8,
          costToday: null,
          subscriptionWindow: { state: 'active', usedPct: 16, windowLabel: '1d' },
        },
      ],
    });
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('Frontier usage today:');
    expect(text).toContain('claude: 24 calls, 48% (active) $1.23');
    expect(text).toContain('codex: 8 calls, 16% (active)');
    // no cost for codex (null)
    expect(text).not.toMatch(/codex.*\$\d/);
  });

  it('10. self-improvement: anti-playbook + skill counts from hub', async () => {
    writeHubEntries([
      { tags: ['m235:anti-playbook'], ts: WITHIN_24H, title: 'Do not mutate config in tests' },
      { tags: ['m235:anti-playbook'], ts: OUTSIDE_24H, title: 'Old lesson' },
      { tags: ['m243:skill'], ts: WITHIN_24H, title: 'How to patch deps safely' },
      { tags: ['m243:skill'], ts: WITHIN_24H, title: 'Auth token refresh pattern' },
    ]);
    const text = await buildDailyStandup(makeCfg() as never);
    // Total counts across all time (not just 24h window — per spec: "lessons" are cumulative)
    expect(text).toContain('Self-improvement:');
    expect(text).toContain('2 lessons');
    expect(text).toContain('2 skills');
  });

  it('11. recent anti-playbook lesson title (within 24h) is shown', async () => {
    writeHubEntries([
      { tags: ['m235:anti-playbook'], ts: WITHIN_24H, title: 'Avoid side effects in tests' },
      { tags: ['m235:anti-playbook'], ts: OUTSIDE_24H, title: 'Stale lesson should not appear' },
    ]);
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('Avoid side effects in tests');
    expect(text).not.toContain('Stale lesson should not appear');
  });

  it('12. always contains dashboard URL', async () => {
    const text = await buildDailyStandup(makeCfg() as never);
    expect(text).toContain('localhost:4317');
  });

  it('13. never throws when all data sources fail', async () => {
    mockListProposals.mockImplementation(() => { throw new Error('inbox down'); });
    mockReadDecisions.mockImplementation(() => { throw new Error('ledger down'); });
    mockListGoals.mockImplementation(() => { throw new Error('goals down'); });
    mockGetFrontierUsage.mockRejectedValue(new Error('usage down'));

    const text = await buildDailyStandup(makeCfg() as never);

    // Still produces something with dashboard URL
    expect(text).toContain('localhost:4317');
  });

  it('14. never throws when getFrontierUsage rejects', async () => {
    mockGetFrontierUsage.mockRejectedValueOnce(new Error('rate limit'));
    const text = await buildDailyStandup(makeCfg() as never);
    // Should degrade gracefully; dashboard URL still present
    expect(text).toContain('localhost:4317');
    // Usage section simply absent
    expect(text).not.toContain('Frontier usage today:');
  });

  it('15. output is bounded at 3000 chars when data is very long', async () => {
    // Generate 100 active goals with long objective strings
    mockListGoals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'active') {
        return Array.from({ length: 100 }, (_, i) => ({
          id: `g${i}`,
          objective: `Long objective string that fills space in the report number ${i} to make the text long`,
          status: 'active',
          milestones: [{ status: 'done' }, { status: 'pending' }],
        }));
      }
      return [];
    });
    mockReadDecisions.mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        ts: WITHIN_24H,
        proposalId: `p${i}`,
        action: 'judged',
        verdict: 'ship',
        engine: `engine-${i % 10}`,
      })),
    );

    const text = await buildDailyStandup(makeCfg() as never);
    expect(text.length).toBeLessThanOrEqual(3000);
  });
});

// ---------------------------------------------------------------------------
// 16–18: notifyFleetEvent 'daily-standup' integration
// ---------------------------------------------------------------------------

describe('notifyFleetEvent daily-standup — M244', () => {
  beforeEach(() => { _resetCooldowns(); });

  it('16. uses buildDailyStandup output (rich report sent via Telegram)', async () => {
    mockListProposals.mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'applied') {
        return [
          { id: 'p1', title: 'M244 feature', repo: 'acme/core', status: 'applied', decidedAt: WITHIN_24H },
        ];
      }
      return [];
    });

    await notifyFleetEvent('daily-standup', {}, makeCfg() as never);

    expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
    const [text] = mockSendTelegramMessage.mock.calls[0] as [string, unknown, unknown];
    // Rich report replaces old placeholder format — should have the morning header
    expect(text).toContain('Fleet morning report');
    // Should contain the dashboard URL
    expect(text).toContain('localhost:4317');
  });

  it('17. no-op when proactive=false', async () => {
    await notifyFleetEvent('daily-standup', {}, makeCfg(false) as never);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });

  it('18. no-op when telegram not configured', async () => {
    mockTelegramEnabled.mockReturnValue(false);
    await notifyFleetEvent('daily-standup', {}, makeCfg() as never);
    expect(mockSendTelegramMessage).not.toHaveBeenCalled();
  });
});
