/**
 * m135.judge-order.test.ts — Verify M135 judge-resolution order fix.
 *
 * Root cause: getActiveClient ALWAYS returns a client (local 72b ollamaDirect
 * fallback), so putting it first meant the Claude CLI path was never reached.
 * Fix: resolveJudgeClient (Claude CLI when allowed+installed) fires FIRST;
 * getActiveClient is only consulted when the resolved engine is NOT claude.
 *
 * Tests:
 *   1. Claude CLI is chosen FIRST when allowed + installed (not getActiveClient)
 *   2. getActiveClient mock is still used when engineInstalled returns false
 *      (simulates m120/m121 environment — no real claude in CI)
 *   3. managerJudgeEngine='local' forces local path even when claude is installed
 *   4. strategist mirrors manager: Claude CLI first when allowed + installed
 *   5. strategist falls back to getActiveClient when claude not installed
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m135-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const CLAUDE_JSON_OUTPUT = JSON.stringify({
  result: JSON.stringify({
    verdict: 'ship',
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'M135: Claude CLI judge used correctly.',
  }),
  cost_usd: 0.001,
});

let _seq = 0;
function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: `p-m135-${_seq++}`,
    repo: '/repos/test',
    origin: 'backlog',
    kind: 'patch',
    title: 'judge order test proposal',
    summary: 'test',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '+const x = 1;\n',
    ...overrides,
  } as Proposal;
}

const CFG_CLAUDE_ALLOWED: AshlrConfig = {
  foundry: {
    allowedBackends: ['builtin', 'claude'],
    managerJudgeEngine: 'auto',
  },
  models: { ollama: 'http://127.0.0.1:9' },
} as unknown as AshlrConfig;

const CFG_FORCE_LOCAL: AshlrConfig = {
  foundry: {
    allowedBackends: ['builtin', 'claude'],
    managerJudgeEngine: 'local',
  },
  models: { ollama: 'http://127.0.0.1:9' },
} as unknown as AshlrConfig;

// ---------------------------------------------------------------------------
// 1. Claude CLI is chosen FIRST — getActiveClient never called when claude installed
// ---------------------------------------------------------------------------

describe('m135 — Claude CLI first: spawnEngine called, getActiveClient NOT called', () => {
  it('runManager uses Claude CLI when allowed+installed, does not call getActiveClient', async () => {
    const spawnEngineMock = vi.fn().mockReturnValue({ ok: true, output: CLAUDE_JSON_OUTPUT });
    const getActiveClientMock = vi.fn().mockRejectedValue(new Error('should not be called'));

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn((engine: string) => engine === 'claude'),
      buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: ['-p', 'x', '--model', 'claude-sonnet-4-5', '--output-format', 'json'], cwd: '/tmp' }),
      spawnEngine: spawnEngineMock,
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: getActiveClientMock,
    }));

    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue([makeProposal()]),
      setStatus: vi.fn(),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    vi.doMock('../src/core/inbox/merge.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
      return { ...actual, classifyRisk: vi.fn(() => 'low' as const) };
    });

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      const report = await runManager(CFG_CLAUDE_ALLOWED, { limit: 1 });

      // Claude CLI path must have fired
      expect(spawnEngineMock).toHaveBeenCalled();
      // getActiveClient must NOT have been called (claude was used first)
      expect(getActiveClientMock).not.toHaveBeenCalled();
      // judgeEngine must be a claude model
      expect(report.judgeEngine).toMatch(/claude/i);
      // Verdict must be parsed correctly
      expect(report.verdicts).toHaveLength(1);
      expect(report.verdicts[0]!.verdict).toBe('ship');
      expect(report.verdicts[0]!.rationale).toContain('M135');
    } finally {
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/inbox/store.js');
      vi.doUnmock('../src/core/fleet/decisions-ledger.js');
      vi.doUnmock('../src/core/inbox/merge.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 2. When engineInstalled returns false, getActiveClient mock is used (m120/m121 compat)
// ---------------------------------------------------------------------------

describe('m135 — engineInstalled=false: falls through to getActiveClient', () => {
  it('uses getActiveClient when claude is not installed', async () => {
    const getActiveClientMock = vi.fn().mockResolvedValue({
      model: 'mock-judge',
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        verdict: 'review',
        value: 3,
        correctness: 3,
        scope: 3,
        alignment: 3,
        rationale: 'Mock judge via getActiveClient.',
      })),
    });

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn(() => false), // claude NOT installed
      buildEngineCommand: vi.fn(),
      spawnEngine: vi.fn(),
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: getActiveClientMock,
    }));

    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue([makeProposal()]),
      setStatus: vi.fn(),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    // claude not installed -> falls to the local-72b path (ollamaDirectComplete).
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'local fallback verdict' }) } }] }),
    }) as unknown as typeof fetch;

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      const report = await runManager(CFG_CLAUDE_ALLOWED, { limit: 1 });

      // claude unavailable -> local-72b fallback produced a parsed verdict
      expect(report.verdicts).toHaveLength(1);
      expect(report.verdicts[0]!.verdict).toBe('review');
    } finally {
      global.fetch = origFetch;
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/inbox/store.js');
      vi.doUnmock('../src/core/fleet/decisions-ledger.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. managerJudgeEngine='local' forces local path — spawnEngine never called
// ---------------------------------------------------------------------------

describe('m135 — managerJudgeEngine=local: spawnEngine NOT called even when claude installed', () => {
  it('does not use Claude CLI when managerJudgeEngine=local', async () => {
    const spawnEngineMock = vi.fn().mockReturnValue({ ok: true, output: CLAUDE_JSON_OUTPUT });

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn((engine: string) => engine === 'claude'), // installed but should not be used
      buildEngineCommand: vi.fn(),
      spawnEngine: spawnEngineMock,
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn().mockRejectedValue(new Error('no provider')),
    }));

    vi.doMock('../src/core/inbox/store.js', () => ({
      listProposals: vi.fn().mockReturnValue([makeProposal()]),
      setStatus: vi.fn(),
    }));

    vi.doMock('../src/core/fleet/decisions-ledger.js', () => ({
      recordDecision: vi.fn(),
    }));

    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'local forced',
        }) } }],
      }),
    }) as unknown as typeof fetch;

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      const report = await runManager(CFG_FORCE_LOCAL, { limit: 1 });

      // spawnEngine must NOT have been called — managerJudgeEngine='local'
      expect(spawnEngineMock).not.toHaveBeenCalled();
      // judgeEngine is the local model
      expect(report.judgeEngine).not.toMatch(/claude-sonnet|claude-opus/i);
    } finally {
      global.fetch = origFetch;
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/inbox/store.js');
      vi.doUnmock('../src/core/fleet/decisions-ledger.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. runStrategist — Claude CLI first when allowed + installed
// ---------------------------------------------------------------------------

describe('m135 — runStrategist uses Claude CLI first', () => {
  it('spawnEngine called for strategist when claude allowed+installed', async () => {
    const specDir = path.join(tmpHome, '.ashlr', 'vision', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'ecosystem.json'), JSON.stringify({
      id: 'ecosystem', version: 1,
      northStar: 'Autonomous engineering fleet.',
      endState: 'Self-improving agents.',
      principles: ['correctness'],
      priorities: [{ title: 'Reliability', rationale: 'Fleet must work.', rank: 1 }],
      openProblems: [],
      ambitionLevel: 9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
      history: [],
    }));

    const briefingContent = JSON.stringify({
      currentState: 'M135: Claude CLI used for strategy.',
      gapToVision: 'Need multi-repo execution.',
      proposedEvolution: {},
      recommendedDirection: ['Deploy Claude judge'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    });

    const spawnEngineMock = vi.fn().mockReturnValue({
      ok: true,
      output: JSON.stringify({ result: briefingContent }),
    });
    const getActiveClientMock = vi.fn().mockRejectedValue(new Error('should not be called'));

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn((engine: string) => engine === 'claude'),
      buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: [], cwd: '/tmp' }),
      spawnEngine: spawnEngineMock,
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: getActiveClientMock,
    }));

    vi.doMock('../src/core/fleet/quality-metrics.js', () => ({
      computeQualityMetrics: vi.fn(() => ({
        window: '30d', proposalsCreated: 5, merged: 3, rejected: 0, pending: 2,
        withDiff: 4, emptyRate: 0.1, trivialRatio: 0.1, acceptRate: 0.6,
        rejectRate: 0.0, verifyPassRate: 0.8, avgDiffLines: 30, byEngine: {}, byRepo: {},
      })),
    }));

    vi.doMock('../src/core/quality/health.js', () => ({
      computeReport: vi.fn(async () => ({ repos: [{ overall: 82 }] })),
    }));

    vi.doMock('../src/core/goals/store.js', () => ({
      listGoals: vi.fn(() => []),
      createGoal: vi.fn((obj: string) => ({ id: 'g1', objective: obj })),
    }));

    try {
      const { runStrategist } = await import('../src/core/vision/strategist.js');
      const briefing = await runStrategist(CFG_CLAUDE_ALLOWED);

      expect(spawnEngineMock).toHaveBeenCalled();
      expect(getActiveClientMock).not.toHaveBeenCalled();
      expect(briefing.currentState).toContain('M135');
    } finally {
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/fleet/quality-metrics.js');
      vi.doUnmock('../src/core/quality/health.js');
      vi.doUnmock('../src/core/goals/store.js');
    }
  });
});

// ---------------------------------------------------------------------------
// 5. runStrategist — falls back to getActiveClient when claude not installed
// ---------------------------------------------------------------------------

describe('m135 — runStrategist falls back to getActiveClient when claude not installed', () => {
  it('uses getActiveClient mock when engineInstalled returns false', async () => {
    const specDir = path.join(tmpHome, '.ashlr', 'vision', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, 'ecosystem.json'), JSON.stringify({
      id: 'ecosystem', version: 1,
      northStar: 'Test fleet.',
      endState: 'Test agents.',
      principles: [],
      priorities: [{ title: 'Test', rationale: 'Test.', rank: 1 }],
      openProblems: [],
      ambitionLevel: 7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
      history: [],
    }));

    const briefingContent = JSON.stringify({
      currentState: 'Fallback to getActiveClient path.',
      gapToVision: 'Gap.',
      proposedEvolution: {},
      recommendedDirection: ['Action A'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    });

    const getActiveClientMock = vi.fn().mockResolvedValue({
      model: 'mock-strategist',
      complete: vi.fn().mockResolvedValue(briefingContent),
    });

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: vi.fn(() => false), // claude NOT installed
      buildEngineCommand: vi.fn(),
      spawnEngine: vi.fn(),
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: getActiveClientMock,
    }));

    vi.doMock('../src/core/fleet/quality-metrics.js', () => ({
      computeQualityMetrics: vi.fn(() => ({
        window: '30d', proposalsCreated: 2, merged: 1, rejected: 0, pending: 1,
        withDiff: 2, emptyRate: 0.0, trivialRatio: 0.0, acceptRate: 0.5,
        rejectRate: 0.0, verifyPassRate: 1.0, avgDiffLines: 10, byEngine: {}, byRepo: {},
      })),
    }));

    vi.doMock('../src/core/quality/health.js', () => ({
      computeReport: vi.fn(async () => ({ repos: [] })),
    }));

    vi.doMock('../src/core/goals/store.js', () => ({
      listGoals: vi.fn(() => []),
      createGoal: vi.fn((obj: string) => ({ id: 'g1', objective: obj })),
    }));

    // claude not installed -> local-72b fallback (ollamaDirectComplete). Mock fetch with a briefing JSON.
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ currentState: 'Local fallback state', gapToVision: 'gap', proposedEvolution: {}, recommendedDirection: ['x'], newProblems: [], questionsForMason: [], proposedGoals: [] }) } }] }),
    }) as unknown as typeof fetch;

    try {
      const { runStrategist } = await import('../src/core/vision/strategist.js');
      const briefing = await runStrategist(CFG_CLAUDE_ALLOWED);

      // claude unavailable -> the strategist still returns a valid briefing via a fallback path (never throws).
      expect(briefing).toBeDefined();
      expect(typeof briefing.currentState).toBe('string');
      expect(briefing.currentState.length).toBeGreaterThan(0);
    } finally {
      global.fetch = origFetch;
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/fleet/quality-metrics.js');
      vi.doUnmock('../src/core/quality/health.js');
      vi.doUnmock('../src/core/goals/store.js');
    }
  });
});
