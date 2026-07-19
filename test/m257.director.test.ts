/**
 * M257 — Elon Director test suite.
 *
 * Tests:
 *  1.  buildDirectorContext — assembles with fallback when all sources throw
 *  2.  buildDirectorContext — degrades gracefully when resource-monitor throws
 *  3.  buildDirectorContext — degrades gracefully when fleet/status throws
 *  4.  buildDirectorContext — degrades gracefully when decisions-ledger throws
 *  5.  buildDirectorContext — degrades gracefully when goals/store throws
 *  6.  buildDirectorContext — degrades gracefully when genome/store throws
 *  7.  buildDirectorContext — derives resourcePosture 'full' when claude open
 *  8.  buildDirectorContext — derives resourcePosture 'preserve' when claude near
 *  9.  buildDirectorContext — derives resourcePosture 'local-only' when all frontier exhausted
 * 10.  runDirectorCycle — no-op when cfg.comms.director is false (default)
 * 11.  runDirectorCycle — no-op when cfg.comms.director is absent
 * 12.  runDirectorCycle — parses mocked LLM decision → calls sendTelegramMessage with digest
 * 13.  runDirectorCycle — posts postRequest('decision-needed') for each escalation
 * 14.  runDirectorCycle — no goal mutation (createGoal never called)
 * 15.  runDirectorCycle — never throws even when LLM call throws
 * 16.  runDirectorCycle — never throws even when sendTelegramMessage throws
 * 17.  runDirectorCycle — never throws even when buildDirectorContext throws
 * 18.  runDirectorDryRun — returns formatted string, does NOT call sendTelegramMessage
 * 19.  runDirectorDryRun — handles LLM parse failure gracefully
 * 20.  runDirectorDryRun — never throws
 * 21.  NO goal mutation — createGoal never called by director cycle
 * 22.  NO merge/bypass — applyProposal/setStatus never called by director
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Fixed test values
// ---------------------------------------------------------------------------

const FIXED_NOW_MS = new Date('2026-06-29T10:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockSendTelegramMessage,
  mockTelegramEnabled,
  mockGetResourceSnapshot,
  mockBuildFleetStatus,
  mockReadDecisions,
  mockReadDecisionsDetailed,
  mockListProposals,
  mockListProposalsDetailed,
  mockListGoals,
  mockPostRequest,
  mockCreateGoal,
  mockApplyProposal,
  mockBuildComplete,
  mockHubStorePath,
} = vi.hoisted(() => ({
  mockSendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockTelegramEnabled: vi.fn().mockReturnValue(true),
  mockGetResourceSnapshot: vi.fn(),
  mockBuildFleetStatus: vi.fn(),
  mockReadDecisions: vi.fn().mockReturnValue([]),
  mockReadDecisionsDetailed: vi.fn(),
  mockListProposals: vi.fn().mockReturnValue([]),
  mockListProposalsDetailed: vi.fn(),
  mockListGoals: vi.fn().mockReturnValue([]),
  mockPostRequest: vi.fn().mockReturnValue('req-id-123'),
  mockCreateGoal: vi.fn(),
  mockApplyProposal: vi.fn(),
  mockBuildComplete: vi.fn(),
  mockHubStorePath: vi.fn().mockReturnValue('/nonexistent/hub.jsonl'),
}));

// Mock Telegram
vi.mock('../src/core/integrations/telegram.js', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
  telegramEnabled: mockTelegramEnabled,
}));

// Mock resource-monitor
vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: mockGetResourceSnapshot,
}));

// Mock fleet/status
vi.mock('../src/core/fleet/status.js', () => ({
  buildFleetStatus: mockBuildFleetStatus,
}));

// Mock decisions-ledger
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: mockReadDecisions,
  readDecisionsDetailed: mockReadDecisionsDetailed,
  recordDecision: vi.fn(),
  decisionsDir: () => '',
}));

// Mock goals/store
vi.mock('../src/core/goals/store.js', () => ({
  listGoals: mockListGoals,
  createGoal: mockCreateGoal,
  loadGoal: vi.fn().mockReturnValue(null),
  saveGoal: vi.fn(),
}));

// Mock requests
vi.mock('../src/core/comms/requests.js', () => ({
  postRequest: mockPostRequest,
  listRequests: vi.fn().mockReturnValue([]),
  outstanding: vi.fn().mockReturnValue(undefined),
  markSent: vi.fn(),
  resolveRequest: vi.fn(),
}));

// Mock genome/store
vi.mock('../src/core/genome/store.js', () => ({
  hubStorePath: mockHubStorePath,
}));

// Mock engines (the LLM caller)
vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn().mockReturnValue(true),
  buildEngineCommand: vi.fn().mockReturnValue(['echo', 'test']),
  spawnEngine: mockBuildComplete,
}));

// Safety: mock inbox/store to ensure applyProposal is never called
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: mockListProposals,
  listProposalsDetailed: mockListProposalsDetailed,
  loadProposal: vi.fn().mockReturnValue(null),
  setStatus: mockApplyProposal,
  applyProposal: mockApplyProposal,
  createProposal: vi.fn(),
  markSent: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const OPEN_SNAPSHOT = {
  generatedAt: new Date(FIXED_NOW_MS).toISOString(),
  backends: [
    {
      backend: 'claude',
      availability: 'open',
      usedPct: 30,
      cap: 100,
      capUnit: null,
      capWindow: '7d',
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: new Date(FIXED_NOW_MS).toISOString(),
      reason: 'claude at 30% — within limit',
      backoffUntilMs: null,
    },
    {
      backend: 'builtin',
      availability: 'open',
      usedPct: null,
      cap: null,
      capUnit: null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: new Date(FIXED_NOW_MS).toISOString(),
      reason: 'always available',
      backoffUntilMs: null,
    },
  ],
};

const NEAR_SNAPSHOT = {
  ...OPEN_SNAPSHOT,
  backends: [
    { ...OPEN_SNAPSHOT.backends[0], availability: 'near', usedPct: 78 },
    OPEN_SNAPSHOT.backends[1],
  ],
};

const EXHAUSTED_SNAPSHOT = {
  ...OPEN_SNAPSHOT,
  backends: [
    { ...OPEN_SNAPSHOT.backends[0], availability: 'exhausted', usedPct: 100 },
    OPEN_SNAPSHOT.backends[1],
  ],
};

const FLEET_STATUS = {
  generatedAt: new Date(FIXED_NOW_MS).toISOString(),
  daemon: { running: true, lastTickAt: new Date(FIXED_NOW_MS).toISOString(), todaySpentUsd: 2.5 },
  backends: [{ backend: 'claude', dispatchesRecent: 10, quota: 'ok' }],
  queue: { backlogItems: 5 },
  proposals: { pending: 3, frontierPending: 1, applied: 12 },
  merges: { recent: 8 },
  killed: false,
};

const MOCK_DECISIONS = [
  {
    ts: new Date(FIXED_NOW_MS - 1000).toISOString(),
    proposalId: 'p1',
    action: 'merged',
    labelBasis: 'realized-merge-v1',
    engine: 'claude',
    costUsd: 0.05,
    cacheHit: true,
  },
  {
    ts: new Date(FIXED_NOW_MS - 2000).toISOString(),
    proposalId: 'p2',
    action: 'rejected',
    engine: 'codex',
    costUsd: 0.01,
    cacheHit: false,
  },
];

const MOCK_GOALS = [
  {
    id: 'phantom-team-vaults-abc123',
    objective: 'Build phantom team-vaults API',
    status: 'active',
    milestones: [
      { id: 'm0', title: 'Scaffold vault model', status: 'done', order: 0, detail: '', specId: null, swarmId: null, proposalId: null, createdAt: '', updatedAt: '' },
      { id: 'm1', title: 'Implement sharing endpoint', status: 'pending', order: 1, detail: '', specId: null, swarmId: null, proposalId: null, createdAt: '', updatedAt: '' },
    ],
    createdAt: new Date(FIXED_NOW_MS - 10000).toISOString(),
    updatedAt: new Date(FIXED_NOW_MS - 5000).toISOString(),
  },
];

// A valid DirectorDecision JSON string
const VALID_DECISION_JSON = JSON.stringify({
  reasoning: 'Claude is open at 30%. Highest leverage: advance phantom team-vaults API toward launch.',
  resourcePosture: 'full',
  resourceRationale: 'All backends open — use claude freely for high-effort milestone work.',
  topGoalId: 'phantom-team-vaults-abc123',
  suggestedNewGoal: null,
  backendHint: {
    preferBackends: ['claude'],
    avoidBackends: [],
    rationale: 'Claude open — no demotion needed',
  },
  telegramDigest: 'Fleet brief — Mon 29 Jun\n\nPOSTURE: claude at 30% — full headroom\n\nFOCUS: phantom team-vaults API (1/2 milestones done)\n\nOUTCOMES (24h): 1 merged, 1 rejected, $0.06 spent',
  escalations: [],
  confidence: 'high',
});

// A decision with escalations
const DECISION_WITH_ESCALATIONS = JSON.stringify({
  reasoning: 'binshield v0.3.0 ready. Needs release decision.',
  resourcePosture: 'full',
  resourceRationale: 'All backends open.',
  topGoalId: null,
  suggestedNewGoal: null,
  backendHint: null,
  telegramDigest: 'Fleet brief\n\nNEEDS YOUR CALL: binshield v0.3.0 release',
  escalations: [
    {
      topic: 'binshield v0.3.0 ready to publish',
      context: 'All tests green, changelog reviewed.',
      options: ['Publish now', 'Hold for review', 'Skip release'],
      stakes: 'critical',
    },
  ],
  confidence: 'high',
});

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function makeConfig(directorEnabled = false): Record<string, unknown> {
  return {
    comms: {
      enabled: true,
      channel: 'telegram',
      proactive: true,
      director: directorEnabled,
      telegram: {
        botToken: 'test-token-123',
        chatId: '999',
      },
    },
    foundry: {
      allowedBackends: ['claude', 'builtin'],
      managerJudgeEngine: 'claude',
      strategistModel: 'claude-opus-4-8',
    },
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ashlr-m257-'));
  vi.useFakeTimers({ now: FIXED_NOW_MS });

  // Default happy-path mocks
  mockGetResourceSnapshot.mockResolvedValue(OPEN_SNAPSHOT);
  mockBuildFleetStatus.mockResolvedValue(FLEET_STATUS);
  mockReadDecisions.mockReturnValue(MOCK_DECISIONS);
  mockListProposals.mockReturnValue([{
    id: 'p1',
    status: 'applied',
    realizedMerge: {
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: '1'.repeat(40),
      proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40),
      observedAt: new Date(FIXED_NOW_MS - 1000).toISOString(),
    },
  }]);
  mockReadDecisionsDetailed.mockImplementation(() => {
    const decisions = mockReadDecisions();
    return {
      decisions,
      sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesRead: 1, bytesRead: 0, rowsScanned: decisions.length,
      invalidRows: 0, unreadableFiles: 0,
    };
  });
  mockListProposalsDetailed.mockImplementation(() => {
    const proposals = mockListProposals();
    return {
      proposals,
      sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesDiscovered: proposals.length, filesRead: proposals.length,
      bytesRead: 0, invalidFiles: 0, unreadableFiles: 0,
    };
  });
  mockListGoals.mockReturnValue(MOCK_GOALS);
  mockTelegramEnabled.mockReturnValue(true);
  mockSendTelegramMessage.mockResolvedValue({ ok: true });
  mockCreateGoal.mockReturnValue({ id: 'new-goal', objective: 'test', status: 'planning', milestones: [] });
  mockApplyProposal.mockReturnValue(undefined);

  // LLM returns valid decision by default
  mockBuildComplete.mockResolvedValue({
    ok: true,
    output: VALID_DECISION_JSON,
  });
});

afterEach(() => {
  vi.useRealTimers();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M257 — Elon Director', () => {

  // ── buildDirectorContext ────────────────────────────────────────────────

  describe('buildDirectorContext', () => {
    it('1. assembles successfully when all sources return data', async () => {
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx).toBeDefined();
      expect(ctx.resourcePosture).toBe('full');
      expect(ctx.resources.backends).toHaveLength(2);
      expect(ctx.fleet.daemonRunning).toBe(true);
      expect(ctx.fleet.todaySpentUsd).toBe(2.5);
      expect(ctx.outcomes.mergedCount).toBe(1);
      expect(ctx.outcomes.rejectedCount).toBe(1);
      expect(ctx.goals.active).toHaveLength(1);
      expect(ctx.goals.active[0].id).toBe('phantom-team-vaults-abc123');
    });

    it('2. degrades gracefully when resource-monitor throws', async () => {
      mockGetResourceSnapshot.mockRejectedValue(new Error('network fail'));
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.resources.backends).toHaveLength(0);
      expect(ctx.resourcePosture).toBe('degraded'); // no backends → degraded
      // Other sections still populated
      expect(ctx.fleet.daemonRunning).toBe(true);
    });

    it('3. degrades gracefully when fleet/status throws', async () => {
      mockBuildFleetStatus.mockRejectedValue(new Error('state fail'));
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.fleet.daemonRunning).toBe(false); // fallback
      expect(ctx.fleet.todaySpentUsd).toBe(0);
      expect(ctx.resources.backends).toHaveLength(2); // still populated
    });

    it('4. degrades gracefully when decisions-ledger throws', async () => {
      mockReadDecisions.mockImplementation(() => { throw new Error('ledger fail'); });
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(0);
      expect(ctx.outcomes.costUsdToday).toBe(0);
      // other sections still work
      expect(ctx.goals.active).toHaveLength(1);
    });

    it('keeps one canonical merge factual without granting per-engine ship credit', async () => {
      mockReadDecisions.mockReturnValue([
        { ...MOCK_DECISIONS[0], labelBasis: undefined },
        MOCK_DECISIONS[0],
        { ...MOCK_DECISIONS[0], ts: new Date(FIXED_NOW_MS - 500).toISOString() },
      ]);

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(1);
      expect(ctx.outcomes.engineShipRates).toEqual({});
    });

    it('excludes factual merges from an engine rejection-derived adaptive rate', async () => {
      mockReadDecisions.mockReturnValue([
        MOCK_DECISIONS[0],
        { ...MOCK_DECISIONS[1], engine: 'claude' },
      ]);

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(1);
      expect(ctx.outcomes.engineShipRates).toEqual({ claude: 0 });
    });

    it('does not trust a caller-supplied release label as per-engine success credit', async () => {
      mockReadDecisions.mockReturnValue([
        MOCK_DECISIONS[0],
        {
          ...MOCK_DECISIONS[0],
          ts: new Date(FIXED_NOW_MS - 500).toISOString(),
          labelBasis: 'post-merge-credit-release-v1',
        },
      ]);

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(1);
      expect(ctx.outcomes.engineShipRates).toEqual({});
    });

    it('counts a legacy merge row as zero even with a current realized witness', async () => {
      mockReadDecisions.mockReturnValue([
        { ...MOCK_DECISIONS[0], labelBasis: undefined },
      ]);

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(0);
      expect(ctx.outcomes.engineShipRates).toEqual({});
    });

    it('fails closed when detailed outcome sources are degraded', async () => {
      mockReadDecisionsDetailed.mockReturnValue({
        decisions: MOCK_DECISIONS,
        sourceState: 'degraded', sourcePresent: true, complete: false, stopReasons: ['row-cap'],
        filesRead: 1, bytesRead: 1024, rowsScanned: MOCK_DECISIONS.length,
        invalidRows: 0, unreadableFiles: 0,
      });

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.outcomes.mergedCount).toBe(0);
      expect(ctx.outcomes.engineShipRates).toEqual({});
      expect(ctx.outcomes.costUsdToday).toBe(0);
    });

    it('5. degrades gracefully when goals/store throws', async () => {
      mockListGoals.mockImplementation(() => { throw new Error('goals fail'); });
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.goals.active).toHaveLength(0);
      expect(ctx.goals.planning).toHaveLength(0);
      // other sections still work
      expect(ctx.fleet.daemonRunning).toBe(true);
    });

    it('6. degrades gracefully when genome/store throws', async () => {
      mockHubStorePath.mockImplementation(() => { throw new Error('genome fail'); });
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.learning.lessonsCount).toBe(0);
      expect(ctx.learning.skillCount).toBe(0);
      // other sections still work
      expect(ctx.goals.active).toHaveLength(1);
    });

    it('does not trust legacy or release-tagged m243 genome rows as positive skill signal', async () => {
      const hubPath = join(tmpDir, 'hub.jsonl');
      writeFileSync(hubPath, [
        JSON.stringify({
          title: 'Legacy skill',
          tags: ['m243:skill'],
          ts: new Date(FIXED_NOW_MS - 1000).toISOString(),
        }),
        JSON.stringify({
          title: 'Caller-tagged release skill',
          tags: ['m243:skill', 'credit:released-v1'],
          ts: new Date(FIXED_NOW_MS - 1000).toISOString(),
        }),
        JSON.stringify({
          title: 'A negative lesson remains visible',
          tags: ['m235:anti-playbook'],
          ts: new Date(FIXED_NOW_MS - 1000).toISOString(),
        }),
      ].join('\n') + '\n');
      mockHubStorePath.mockReturnValue(hubPath);

      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);

      expect(ctx.learning.skillCount).toBe(0);
      expect(ctx.learning.lessonsCount).toBe(1);
      expect(ctx.learning.recentLessonTitles).toEqual(['A negative lesson remains visible']);
    });

    it('renders factual merges and authenticated-only adaptive signals explicitly', async () => {
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const { renderDirectorPrompt } = await import('../src/core/comms/director-prompt.js');
      const prompt = renderDirectorPrompt(await buildDirectorContext(makeConfig() as never));

      expect(prompt).toContain('Realized merges (factual only): 1, Rejected: 1');
      expect(prompt).not.toContain('claude=100%');
      expect(prompt).toContain('Released-credit engine ship rates: codex=0%');
    });

    it('7. derives resourcePosture=full when claude is open', async () => {
      mockGetResourceSnapshot.mockResolvedValue(OPEN_SNAPSHOT);
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);
      expect(ctx.resourcePosture).toBe('full');
    });

    it('8. derives resourcePosture=preserve when claude is near', async () => {
      mockGetResourceSnapshot.mockResolvedValue(NEAR_SNAPSHOT);
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);
      expect(ctx.resourcePosture).toBe('preserve');
    });

    it('9. derives resourcePosture=local-only when all frontier exhausted', async () => {
      mockGetResourceSnapshot.mockResolvedValue(EXHAUSTED_SNAPSHOT);
      const { buildDirectorContext } = await import('../src/core/comms/director-context.js');
      const ctx = await buildDirectorContext(makeConfig() as never);
      expect(ctx.resourcePosture).toBe('local-only');
    });
  });

  // ── runDirectorCycle — gating ───────────────────────────────────────────

  describe('runDirectorCycle — gating', () => {
    it('10. is a no-op when cfg.comms.director=false', async () => {
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(false) as never);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      expect(mockBuildComplete).not.toHaveBeenCalled();
    });

    it('11. is a no-op when cfg.comms.director is absent', async () => {
      const cfg = { comms: { enabled: true, channel: 'telegram' } };
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(cfg as never);
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
      expect(mockBuildComplete).not.toHaveBeenCalled();
    });
  });

  // ── runDirectorCycle — live path ────────────────────────────────────────

  describe('runDirectorCycle — live path', () => {
    it('12. parses mocked LLM decision and calls sendTelegramMessage with digest', async () => {
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(true) as never);

      expect(mockSendTelegramMessage).toHaveBeenCalledOnce();
      const [digestText] = mockSendTelegramMessage.mock.calls[0] as [string, ...unknown[]];
      expect(typeof digestText).toBe('string');
      expect(digestText).toContain('Fleet brief');
      expect(digestText).toContain('phantom team-vaults');
    });

    it('13. posts postRequest(decision-needed) for each escalation', async () => {
      mockBuildComplete.mockResolvedValue({
        ok: true,
        output: DECISION_WITH_ESCALATIONS,
      });

      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(true) as never);

      expect(mockPostRequest).toHaveBeenCalledOnce();
      const [reqArg] = mockPostRequest.mock.calls[0] as [{ kind: string; type: string; text: string }];
      expect(reqArg.kind).toBe('decision-needed');
      expect(reqArg.type).toBe('question');
      expect(reqArg.text).toContain('binshield');
    });

    it('14. never calls createGoal (no goal mutation in M257)', async () => {
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(true) as never);
      expect(mockCreateGoal).not.toHaveBeenCalled();
    });

    it('15. never throws even when LLM call throws', async () => {
      mockBuildComplete.mockRejectedValue(new Error('LLM exploded'));
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await expect(runDirectorCycle(makeConfig(true) as never)).resolves.toBeUndefined();
    });

    it('16. never throws even when sendTelegramMessage throws', async () => {
      mockSendTelegramMessage.mockRejectedValue(new Error('Telegram down'));
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await expect(runDirectorCycle(makeConfig(true) as never)).resolves.toBeUndefined();
    });

    it('17. never throws even when buildDirectorContext throws (all sources fail)', async () => {
      mockGetResourceSnapshot.mockRejectedValue(new Error('fail'));
      mockBuildFleetStatus.mockRejectedValue(new Error('fail'));
      mockReadDecisions.mockImplementation(() => { throw new Error('fail'); });
      mockListGoals.mockImplementation(() => { throw new Error('fail'); });

      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await expect(runDirectorCycle(makeConfig(true) as never)).resolves.toBeUndefined();
    });
  });

  // ── runDirectorDryRun ────────────────────────────────────────────────────

  describe('runDirectorDryRun', () => {
    it('18. returns formatted string and does NOT call sendTelegramMessage', async () => {
      const { runDirectorDryRun } = await import('../src/core/comms/director.js');
      const output = await runDirectorDryRun(makeConfig(false) as never);

      expect(typeof output).toBe('string');
      expect(output.length).toBeGreaterThan(100);
      // Dry-run never sends Telegram
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    });

    it('19. handles LLM parse failure gracefully', async () => {
      mockBuildComplete.mockResolvedValue({ ok: true, output: 'not valid json {{{' });
      const { runDirectorDryRun } = await import('../src/core/comms/director.js');
      const output = await runDirectorDryRun(makeConfig(true) as never);

      expect(typeof output).toBe('string');
      expect(output).toContain('GOD-VIEW');
      expect(mockSendTelegramMessage).not.toHaveBeenCalled();
    });

    it('20. never throws under any condition', async () => {
      mockGetResourceSnapshot.mockRejectedValue(new Error('fail'));
      mockBuildFleetStatus.mockRejectedValue(new Error('fail'));
      mockBuildComplete.mockRejectedValue(new Error('LLM fail'));

      const { runDirectorDryRun } = await import('../src/core/comms/director.js');
      await expect(runDirectorDryRun(makeConfig(true) as never)).resolves.toBeDefined();
    });
  });

  // ── Safety invariants ────────────────────────────────────────────────────

  describe('safety invariants', () => {
    it('21. createGoal is NEVER called by runDirectorCycle (no goal mutation)', async () => {
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(true) as never);
      expect(mockCreateGoal).not.toHaveBeenCalled();
    });

    it('22. applyProposal/setStatus is NEVER called by director', async () => {
      const { runDirectorCycle } = await import('../src/core/comms/director.js');
      await runDirectorCycle(makeConfig(true) as never);
      expect(mockApplyProposal).not.toHaveBeenCalled();
    });
  });

});
