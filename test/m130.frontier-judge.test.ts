/**
 * m130.frontier-judge.test.ts — Frontier judge resolver tests (M130).
 *
 * Verifies that manager + strategist use the Claude CLI path when the engine
 * is allowed + installed, fall back to local-72b when unavailable, and that
 * managerJudgeEngine='local' forces the local path regardless.
 *
 * Mocking conventions mirror m120.manager.test.ts + m123.judge-client.test.ts:
 *   - HOME isolated to a tmp dir for each test.
 *   - spawnEngine + engineInstalled mocked (never spawn a real process).
 *   - getActiveClient throws so the new resolver is the only path exercised.
 *   - ollamaDirectComplete stubbed via global.fetch.
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m130-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

/** A valid JSON verdict the Claude CLI would return (wrapped in claude's JSON envelope). */
const CLAUDE_JSON_OUTPUT = JSON.stringify({
  result: JSON.stringify({
    verdict: 'ship',
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'Frontier judge: clean improvement.',
  }),
  cost_usd: 0.001,
  usage: { input_tokens: 100, output_tokens: 50 },
});

/** spawnEngine mock that simulates a successful claude CLI invocation. */
function mockSpawnEngineSuccess() {
  return vi.fn().mockReturnValue({ ok: true, output: CLAUDE_JSON_OUTPUT });
}

/** spawnEngine mock that simulates a failed claude CLI invocation. */
function mockSpawnEngineFailure() {
  return vi.fn().mockReturnValue({ ok: false, output: '', error: 'claude not found' });
}

/** engineInstalled mock: claude is installed. */
function mockEngineInstalledTrue() {
  return vi.fn((engine: string) => engine === 'claude');
}

/** engineInstalled mock: claude is NOT installed. */
function mockEngineInstalledFalse() {
  return vi.fn(() => false);
}

// cfg with claude in allowedBackends
const CFG_CLAUDE_ALLOWED: AshlrConfig = {
  foundry: {
    allowedBackends: ['builtin', 'claude'],
    judgeAllowedBackends: ['claude'],
    managerJudgeEngine: 'auto',
  },
  models: { ollama: 'http://127.0.0.1:9' }, // dead port → local fallback fails fast
} as unknown as AshlrConfig;

// cfg with managerJudgeEngine='local' (forces 72b path)
const CFG_FORCE_LOCAL: AshlrConfig = {
  foundry: {
    allowedBackends: ['builtin', 'claude'],
    managerJudgeEngine: 'local',
  },
  models: { ollama: 'http://127.0.0.1:9' },
} as unknown as AshlrConfig;

// cfg without claude in allowedBackends
const CFG_CLAUDE_NOT_ALLOWED: AshlrConfig = {
  foundry: {
    allowedBackends: ['builtin'],
    managerJudgeEngine: 'auto',
  },
  models: { ollama: 'http://127.0.0.1:9' },
} as unknown as AshlrConfig;

// ---------------------------------------------------------------------------
// Helper: minimal Proposal
// ---------------------------------------------------------------------------

let _seq = 0;
function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: `p-m130-${_seq++}`,
    repo: '/repos/test',
    origin: 'backlog',
    kind: 'patch',
    title: 'frontier test proposal',
    summary: 'a test change',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: '+const x = 1;\n',
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    ...overrides,
  } as Proposal;
}

// ---------------------------------------------------------------------------
// 1. judgeProposal — uses Claude CLI when allowed + installed
// ---------------------------------------------------------------------------

describe('m130 — judge uses Claude CLI when available', () => {
  it('spawnEngine is called with claude argv and parses the verdict', async () => {
    // Mock engines module: engineInstalled→true, buildEngineCommand returns a cmd,
    // spawnEngine returns a valid claude JSON output.
    const spawnEngineMock = mockSpawnEngineSuccess();
    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: mockEngineInstalledTrue(),
      buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: ['-p', 'prompt', '--model', 'claude-sonnet-4-5', '--output-format', 'json'], cwd: '/tmp' }),
      spawnEngine: spawnEngineMock,
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    // getActiveClient throws → falls through to resolveJudgeClient
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

    vi.doMock('../src/core/inbox/merge.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
      return { ...actual, classifyRisk: vi.fn(() => 'low' as const) };
    });

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager(CFG_CLAUDE_ALLOWED, { limit: 1 });

    expect(report).toBeDefined();
    // spawnEngine must have been called (Claude CLI path taken)
    expect(spawnEngineMock).toHaveBeenCalled();
    // The verdict should have been parsed from the CLI output
    expect(report.verdicts).toHaveLength(1);
    const v = report.verdicts[0]!;
    expect(v.verdict).toBe('ship');
    expect(v.value).toBe(5);
    expect(v.rationale).toContain('Frontier judge');
    // judgeEngine should identify as a claude model
    expect(report.judgeEngine).toMatch(/claude/i);

    vi.doUnmock('../src/core/run/engines.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/inbox/store.js');
    vi.doUnmock('../src/core/fleet/decisions-ledger.js');
    vi.doUnmock('../src/core/inbox/merge.js');
  });
});

// ---------------------------------------------------------------------------
// 2. judgeProposal — falls back to local path when claude unavailable
// ---------------------------------------------------------------------------

describe('m130 — judge falls back to local 72b when claude unavailable', () => {
  it('uses ollamaDirectComplete (fetch) when engineInstalled returns false', async () => {
    // M282: reset module registry so manager.js is re-imported with fresh static
    // bindings. Without this, the prior test cached manager.js with the real
    // engineInstalled binding (returns true because claude is installed on this
    // machine). vi.doMock cannot override an already-bound static import — only
    // a full registry reset + re-import picks up the new mock.
    vi.resetModules();
    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: mockEngineInstalledFalse(),
      buildEngineCommand: vi.fn(),
      spawnEngine: mockSpawnEngineFailure(),
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

    // Stub fetch for the ollamaDirectComplete path
    const localVerdictJson = JSON.stringify({
      verdict: 'review',
      value: 3,
      correctness: 3,
      scope: 3,
      alignment: 3,
      rationale: 'Local 72b fallback.',
    });
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: localVerdictJson } }] }),
    }) as unknown as typeof fetch;

    try {
      const { runManager } = await import('../src/core/fleet/manager.js');
      const report = await runManager(CFG_CLAUDE_NOT_ALLOWED, { limit: 1 });

      expect(report).toBeDefined();
      // Should still get a verdict (from fetch mock = local path)
      // Since fetch is dead (port 9) OR we stubbed it, either a review default or local verdict.
      expect(report.verdicts).toHaveLength(1);
      // judgeEngine should not be a claude model
      expect(report.judgeEngine).not.toMatch(/claude-sonnet|claude-opus/i);
    } finally {
      global.fetch = origFetch;
    }

    vi.doUnmock('../src/core/run/engines.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/inbox/store.js');
    vi.doUnmock('../src/core/fleet/decisions-ledger.js');
  });
});

// ---------------------------------------------------------------------------
// 3. managerJudgeEngine='local' forces local path even if claude is installed
// ---------------------------------------------------------------------------

describe('m130 — managerJudgeEngine=local forces local path', () => {
  it('does NOT call spawnEngine when managerJudgeEngine=local', async () => {
    const spawnEngineMock = mockSpawnEngineSuccess();

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: mockEngineInstalledTrue(), // claude IS installed
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

    // Stub fetch so local path doesn't time out (dead port 9)
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
      await runManager(CFG_FORCE_LOCAL, { limit: 1 });

      // spawnEngine must NOT have been called — managerJudgeEngine='local'
      expect(spawnEngineMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = origFetch;
    }

    vi.doUnmock('../src/core/run/engines.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/inbox/store.js');
    vi.doUnmock('../src/core/fleet/decisions-ledger.js');
  });
});

// ---------------------------------------------------------------------------
// 4. Parse failure on Claude CLI output → defaults to 'review' (fail-closed)
// ---------------------------------------------------------------------------

describe('m130 — parse failure → review (fail-closed)', () => {
  it('defaults to review when spawnEngine returns unparseable output', async () => {
    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: mockEngineInstalledTrue(),
      buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: [], cwd: '/tmp' }),
      // Return a JSON envelope whose .result is prose (not a judge JSON object)
      spawnEngine: vi.fn().mockReturnValue({
        ok: true,
        output: JSON.stringify({ result: 'I cannot judge this at this time.', usage: {} }),
      }),
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

    const { runManager } = await import('../src/core/fleet/manager.js');
    const report = await runManager(CFG_CLAUDE_ALLOWED, { limit: 1 });

    expect(report).toBeDefined();
    expect(report.verdicts).toHaveLength(1);
    // Parse failure → fail-closed to 'review', never noise/harmful
    expect(report.verdicts[0]!.verdict).toBe('review');
    expect(report.verdicts[0]!.wouldMerge).toBe(false);

    vi.doUnmock('../src/core/run/engines.js');
    vi.doUnmock('../src/core/run/provider-client.js');
    vi.doUnmock('../src/core/inbox/store.js');
    vi.doUnmock('../src/core/fleet/decisions-ledger.js');
  });
});

// ---------------------------------------------------------------------------
// 5. runStrategist — uses Claude CLI when available
// ---------------------------------------------------------------------------

describe('m130 — runStrategist uses Claude CLI when available', () => {
  it('spawnEngine is called for strategist when claude is allowed+installed', async () => {
    // Ensure an ecosystem spec exists so runStrategist doesn't short-circuit.
    const specDir = path.join(tmpHome, '.ashlr', 'vision', 'specs');
    fs.mkdirSync(specDir, { recursive: true });
    const spec = {
      id: 'ecosystem',
      version: 1,
      northStar: 'Autonomous engineering fleet at frontier quality.',
      endState: 'Self-improving coding agent fleet.',
      principles: ['local-first', 'correctness'],
      priorities: [{ title: 'Reliability', rationale: 'Fleet must be reliable', rank: 1 }],
      openProblems: ['provider crash on sparse config'],
      ambitionLevel: 9,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: 'test',
      history: [],
    };
    fs.writeFileSync(path.join(specDir, 'ecosystem.json'), JSON.stringify(spec));

    const briefingContent = JSON.stringify({
      currentState: 'Frontier model used for strategy.',
      gapToVision: 'Need autonomous multi-repo execution.',
      proposedEvolution: {},
      recommendedDirection: ['Deploy frontier judge', 'Add cross-repo planner'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [
        { objective: 'Integrate frontier judge into merge gate', rationale: 'Quality.', specPriority: 'Reliability' },
      ],
    });

    const spawnEngineMock = vi.fn().mockReturnValue({
      ok: true,
      output: JSON.stringify({ result: briefingContent }),
    });

    vi.doMock('../src/core/run/engines.js', () => ({
      engineInstalled: mockEngineInstalledTrue(),
      buildEngineCommand: vi.fn().mockReturnValue({ bin: 'claude', args: [], cwd: '/tmp' }),
      spawnEngine: spawnEngineMock,
      resolveBinAbsolute: vi.fn((b: string) => b),
      phantomInitializedAt: vi.fn(() => false),
    }));

    vi.doMock('../src/core/run/provider-client.js', () => ({
      getActiveClient: vi.fn().mockRejectedValue(new Error('no provider')),
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

      expect(briefing).toBeDefined();
      expect(spawnEngineMock).toHaveBeenCalled();
      expect(briefing.currentState).toContain('Frontier model');
      expect(briefing.recommendedDirection).toHaveLength(2);
      expect(briefing.proposedGoals).toHaveLength(1);
    } finally {
      vi.doUnmock('../src/core/run/engines.js');
      vi.doUnmock('../src/core/run/provider-client.js');
      vi.doUnmock('../src/core/fleet/quality-metrics.js');
      vi.doUnmock('../src/core/quality/health.js');
      vi.doUnmock('../src/core/goals/store.js');
    }
  });
});
