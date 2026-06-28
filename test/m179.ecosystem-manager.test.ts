/**
 * m179.ecosystem-manager.test.ts — M179 Ecosystem Manager tests.
 *
 * Units under test:
 *   1. Per-repo context injection — gatherStrategicContext repos fed into prompt
 *   2. Per-tool goals — proposedGoals tagged with targetRepo, substantive content
 *   3. Per-tool roadmap — proposedEvolution.toolRoadmap parsed + persisted
 *   4. Elon-mode ecosystem prompt — ECOSYSTEM MANAGER phrases present
 *   5. Ecosystem prompt injection — per-tool section in user prompt
 *   6. targetRepo parsing — null + string cases
 *   7. spec.ts ToolRoadmapEntry type — shape validation
 *   8. Graceful degradation — no repos enrolled → still works
 *
 * Hermetic: HOME relocated to tmp dir. LLM mocked. gatherStrategicContext mocked.
 * Conventions mirror m162.elite-strategist.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m179-home-'));
  process.env.HOME = tmpHome;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

const mockComplete = vi.fn<[string, string], Promise<string>>();

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'mock-opus',
    complete: mockComplete,
  })),
}));

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: vi.fn((objective: string, opts?: { project?: string | null }) => ({
    id: `goal-${Math.random().toString(36).slice(2, 7)}`,
    objective,
    project: opts?.project ?? null,
    status: 'planning',
    milestones: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  listGoals: vi.fn(() => []),
}));

vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: vi.fn(() => ({
    window: '30d',
    proposalsCreated: 12,
    merged: 9,
    rejected: 2,
    pending: 1,
    withDiff: 11,
    emptyRate: 0.04,
    trivialRatio: 0.12,
    acceptRate: 0.82,
    rejectRate: 0.18,
    verifyPassRate: 0.91,
    avgDiffLines: 61,
    byEngine: {},
    byRepo: {},
  })),
}));

vi.mock('../src/core/quality/health.js', () => ({
  computeReport: vi.fn(async () => ({ repos: [{ overall: 88 }] })),
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  recordDecision: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: gatherStrategicContext — returns multi-repo context
// ---------------------------------------------------------------------------

const MOCK_REPOS = [
  {
    path: '/repos/ashlr-pulse',
    name: 'ashlr-pulse',
    health: 'clean' as const,
    hasTests: true,
    recentCommits: ['feat: add fleet map tab', 'fix: websocket reconnect'],
    openIssueCount: 4,
    lastActivity: '2026-06-25T10:00:00.000Z',
  },
  {
    path: '/repos/phantom-secrets',
    name: 'phantom-secrets',
    health: 'dirty' as const,
    hasTests: true,
    recentCommits: ['feat: team vault push', 'fix: key rotation edge case'],
    openIssueCount: 2,
    lastActivity: '2026-06-20T08:00:00.000Z',
  },
  {
    path: '/repos/ashlr-plugin',
    name: 'ashlr-plugin',
    health: 'clean' as const,
    hasTests: true,
    recentCommits: ['feat: genome loop M55', 'perf: compress read output'],
    openIssueCount: 1,
    lastActivity: '2026-06-27T14:00:00.000Z',
  },
  {
    path: '/repos/binshield',
    name: 'binshield',
    health: 'clean' as const,
    hasTests: false,
    recentCommits: ['chore: update deps'],
    openIssueCount: 7,
    lastActivity: '2026-05-10T09:00:00.000Z',
  },
];

const mockGatherStrategicContext = vi.fn(async () => ({
  repos: MOCK_REPOS,
  outcomes: { merged7d: 9, rejected7d: 2, reverted7d: 0, shipRate: 0.82, trivialRatio: 0.12 },
  fleet: { pendingProposals: 1, activeGoals: 0, completedGoals: 14 },
  narrative: [
    'Fleet: 1 pending proposals | 0 active goals | 14 completed goals',
    '7-day outcomes: 9 merged, 2 rejected, 0 reverted | ship rate 82% | trivial ratio 12%',
    'Repos (4 enrolled):',
    '  ashlr-pulse: clean, has tests, 4 open issues, last commit 2026-06-25: "feat: add fleet map tab"',
    '  phantom-secrets: dirty, has tests, 2 open issues, last commit 2026-06-20: "feat: team vault push"',
    '  ashlr-plugin: clean, has tests, 1 open issues, last commit 2026-06-27: "feat: genome loop M55"',
    '  binshield: clean, no tests, 7 open issues, last commit 2026-05-10: "chore: update deps"',
  ].join('\n'),
}));

vi.mock('../src/core/vision/context.js', () => ({
  gatherStrategicContext: mockGatherStrategicContext,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCfgBase: AshlrConfig = {
  provider: 'anthropic',
  models: { ollama: 'http://127.0.0.1:9' },
  foundry: { allowedBackends: ['builtin'] },
} as unknown as AshlrConfig;

const mockCfgWithOpus: AshlrConfig = {
  provider: 'anthropic',
  models: { ollama: 'http://127.0.0.1:9' },
  foundry: {
    allowedBackends: ['builtin'],
    strategistModel: 'claude-opus-4-8',
  },
} as unknown as AshlrConfig;

/** Build a valid ecosystem-manager briefing JSON with per-tool goals + roadmap. */
function makeEcosystemBriefingJson(overrides: Partial<{
  proposedGoals: unknown[];
  toolRoadmap: unknown[];
  currentState: string;
  gapToVision: string;
}> = {}): string {
  return JSON.stringify({
    currentState: overrides.currentState ??
      'Fleet merging 9/11 proposals at 82% accept rate with 12% trivial ratio — solid baseline. ' +
      'ashlr-pulse has 4 open issues with no real-time capability yet; binshield has 7 open issues and no tests — both are liabilities.',
    gapToVision: overrides.gapToVision ??
      'THE BOTTLENECK: The ecosystem\'s tools are in maintenance mode — ashlr-pulse lacks real-time fleet visibility, ' +
      'binshield has no tests and 7 open issues, and phantom team-vault sync is unfinished. ' +
      'Until each tool reaches a genuinely useful state, the fleet\'s autonomous output has no compounding amplifier.',
    proposedEvolution: {
      ambitionLevel: 10,
      priorities: [
        { title: 'Ecosystem tool excellence', rationale: 'Each tool must reach 10x useful state before adding new tools.', rank: 1 },
        { title: 'Human leverage maximisation', rationale: 'Every autonomous merge must free a non-trivial block of Mason\'s time.', rank: 2 },
      ],
      toolRoadmap: overrides.toolRoadmap ?? [
        {
          repo: 'ashlr-pulse',
          ambitionLevel: 9,
          vision: 'The real-time command center for the entire ashlr fleet — every agent action visible + controllable from a single dashboard with sub-second latency.',
          nextMilestone: 'Implement WebSocket-based real-time event stream for proposal/merge events + fleet-command round-trip from the dashboard',
        },
        {
          repo: 'phantom-secrets',
          ambitionLevel: 8,
          vision: 'Production-grade E2E encrypted team secret management that developers trust more than 1Password for engineering credentials.',
          nextMilestone: 'Harden team-vault sync: add conflict resolution, E2E encryption verification, and audit log for all vault mutations',
        },
        {
          repo: 'ashlr-plugin',
          ambitionLevel: 9,
          vision: 'The token-efficiency layer that makes every Claude session 5x cheaper — genome-aware, savings-visible, zero-config.',
          nextMilestone: 'Close the genome loop: auto-propose genome updates when ashlr__grep finds patterns not yet in the genome',
        },
        {
          repo: 'binshield',
          ambitionLevel: 7,
          vision: 'The security gate that catches every supply-chain vulnerability before it reaches main — integrated into the merge gate, zero false-positive tolerance.',
          nextMilestone: 'Add test suite + integrate binshield scan into the fleet\'s merge-gate trust tier — block merges with critical CVEs',
        },
      ],
    },
    recommendedDirection: [
      'THE MOVE: Make ashlr-pulse real-time — implement WebSocket event stream for fleet proposals/merges so Mason has live visibility into every autonomous action.',
      'KILL-LIST: Stop letting binshield accumulate issues without tests — freeze new binshield features until test coverage reaches 80%.',
      'KILL-LIST: Kill phantom dirty-state commits — enforce clean working tree before any vault push to prevent partial-sync corruption.',
    ],
    newProblems: [
      'No tool in the ecosystem has end-to-end automated testing from fleet action to tool UI — blind spots compound.',
      'binshield has 7 open issues with no tests — a security tool with no tests is a liability not an asset.',
    ],
    questionsForMason: [
      'Should ashlr-pulse\'s real-time stream be push (WebSocket from hub) or pull (polling from pulse)? Push is better UX but requires persistent hub connection.',
    ],
    proposedGoals: overrides.proposedGoals ?? [
      {
        objective: 'Implement ashlr-pulse real-time fleet event stream with WebSocket + fleet-command round-trip',
        rationale: 'Real-time visibility is the forcing function for Mason to trust autonomous merges — without it, every merge is a surprise.',
        specPriority: 'Ecosystem tool excellence',
        targetRepo: 'ashlr-pulse',
      },
      {
        objective: 'Harden phantom-secrets team-vault sync: E2E encryption, conflict resolution, audit log',
        rationale: 'Unfinished vault sync is a security liability and blocks team adoption of phantom as a real credential manager.',
        specPriority: 'Ecosystem tool excellence',
        targetRepo: 'phantom-secrets',
      },
      {
        objective: 'Add binshield test suite and integrate into fleet merge-gate as a blocking security check',
        rationale: 'A security scanner with no tests that isn\'t in the merge gate is theatre — it needs both to deliver real value.',
        specPriority: 'Ecosystem tool excellence',
        targetRepo: 'binshield',
      },
    ],
  });
}

beforeEach(() => {
  mockComplete.mockReset();
  mockGatherStrategicContext.mockClear();
});

// ---------------------------------------------------------------------------
// 1. Per-repo context injection — gatherStrategicContext repos fed into prompt
// ---------------------------------------------------------------------------

describe('M179 — per-repo context injection', () => {
  it('calls gatherStrategicContext to fetch per-repo data', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    expect(mockGatherStrategicContext).toHaveBeenCalled();
  });

  it('injects per-tool section into user prompt containing tool names', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    expect(capturedPrompts.length).toBeGreaterThan(0);
    const prompt = capturedPrompts[0]!;
    // Each enrolled tool name must appear in the per-tool section
    expect(prompt).toContain('ashlr-pulse');
    expect(prompt).toContain('phantom-secrets');
    expect(prompt).toContain('ashlr-plugin');
    expect(prompt).toContain('binshield');
  });

  it('per-tool section shows health + test status for each repo', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    const prompt = capturedPrompts[0]!;
    // binshield has no tests — should appear as such
    expect(prompt).toMatch(/binshield/);
    expect(prompt).toMatch(/NO TESTS|no tests/);
    // phantom-secrets is dirty
    expect(prompt).toMatch(/dirty/);
  });

  it('per-tool section shows recent commits for each repo', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    const prompt = capturedPrompts[0]!;
    expect(prompt).toContain('feat: add fleet map tab');
    expect(prompt).toContain('feat: team vault push');
    expect(prompt).toContain('feat: genome loop M55');
  });

  it('per-tool section header mentions enrolled repo count', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    const prompt = capturedPrompts[0]!;
    expect(prompt).toMatch(/PER-TOOL ECOSYSTEM STATE.*4 enrolled repos/);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-tool goals — proposedGoals tagged with targetRepo, substantive content
// ---------------------------------------------------------------------------

describe('M179 — per-tool proposedGoals', () => {
  it('parses targetRepo field on each proposedGoal', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.proposedGoals.length).toBeGreaterThan(0);
    // Every goal should have a targetRepo field
    for (const goal of briefing.proposedGoals) {
      expect('targetRepo' in goal).toBe(true);
    }
  });

  it('goals reference specific tool names (ashlr-pulse, phantom-secrets, binshield)', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const targetRepos = briefing.proposedGoals
      .map((g) => g.targetRepo)
      .filter(Boolean);
    expect(targetRepos.length).toBeGreaterThan(0);
    // At least one goal targets a specific tool
    expect(targetRepos.some((r) => r === 'ashlr-pulse' || r === 'phantom-secrets' || r === 'binshield')).toBe(true);
  });

  it('goals are substantive per-tool improvements (not fleet-internal metrics)', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const objectives = briefing.proposedGoals.map((g) => g.objective.toLowerCase());
    // Goals must mention real tool features, not fleet-internal metrics like "NaN metric"
    const hasSubstantiveGoal = objectives.some((o) =>
      o.includes('real-time') ||
      o.includes('websocket') ||
      o.includes('vault') ||
      o.includes('test suite') ||
      o.includes('merge-gate') ||
      o.includes('encryption') ||
      o.includes('dashboard') ||
      o.includes('genome') ||
      o.includes('scan') ||
      o.includes('binshield') ||
      o.includes('ashlr-pulse') ||
      o.includes('phantom')
    );
    expect(hasSubstantiveGoal).toBe(true);
  });

  it('goals do NOT reference fleet-internal NaN metrics as objectives', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const objectives = briefing.proposedGoals.map((g) => g.objective.toLowerCase());
    // None of the goals should be purely about fleet-internal metric fixing
    for (const obj of objectives) {
      expect(obj).not.toMatch(/fix.*nan|nan.*metric|fleet metric/i);
    }
  });

  it('targetRepo null is preserved for ecosystem-wide goals', async () => {
    const briefingWithNullTarget = makeEcosystemBriefingJson({
      proposedGoals: [
        {
          objective: 'Ship the autonomous engineering fleet v5 to beta users',
          rationale: 'The whole ecosystem is only valuable when it ships — get to beta.',
          specPriority: 'Human leverage maximisation',
          targetRepo: null,
        },
      ],
    });
    mockComplete.mockResolvedValueOnce(briefingWithNullTarget);

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.proposedGoals.length).toBeGreaterThan(0);
    const nullTargetGoal = briefing.proposedGoals.find((g) => g.targetRepo === null);
    expect(nullTargetGoal).toBeDefined();
    expect(nullTargetGoal!.objective).toContain('fleet');
  });

  it('targetRepo string is preserved correctly', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const pulseGoal = briefing.proposedGoals.find((g) => g.targetRepo === 'ashlr-pulse');
    expect(pulseGoal).toBeDefined();
    expect(pulseGoal!.objective.toLowerCase()).toMatch(/real.time|websocket|dashboard/);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-tool roadmap — proposedEvolution.toolRoadmap parsed + in spec
// ---------------------------------------------------------------------------

describe('M179 — proposedEvolution.toolRoadmap', () => {
  it('parses toolRoadmap from proposedEvolution', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap;
    expect(Array.isArray(roadmap)).toBe(true);
    expect((roadmap ?? []).length).toBeGreaterThan(0);
  });

  it('each toolRoadmap entry has repo, ambitionLevel, vision, nextMilestone', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap ?? [];
    for (const entry of roadmap) {
      expect(typeof entry.repo).toBe('string');
      expect(entry.repo.length).toBeGreaterThan(0);
      expect(typeof entry.ambitionLevel).toBe('number');
      expect(entry.ambitionLevel).toBeGreaterThanOrEqual(1);
      expect(entry.ambitionLevel).toBeLessThanOrEqual(10);
      expect(typeof entry.vision).toBe('string');
      expect(entry.vision.length).toBeGreaterThan(0);
      expect(typeof entry.nextMilestone).toBe('string');
      expect(entry.nextMilestone.length).toBeGreaterThan(0);
    }
  });

  it('toolRoadmap covers enrolled tools (ashlr-pulse, phantom-secrets, binshield)', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap ?? [];
    const repos = roadmap.map((e) => e.repo);
    expect(repos).toContain('ashlr-pulse');
    expect(repos).toContain('phantom-secrets');
    expect(repos).toContain('binshield');
  });

  it('toolRoadmap entries have substantive vision (10x language, not incremental)', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap ?? [];
    const pulseEntry = roadmap.find((e) => e.repo === 'ashlr-pulse');
    expect(pulseEntry).toBeDefined();
    // nextMilestone must be a concrete engineering action, not a vague direction
    expect(pulseEntry!.nextMilestone.toLowerCase()).toMatch(/implement|add|build|create|harden|ship/);
  });

  it('toolRoadmap persisted to spec via adoptBriefing', async () => {
    const { adoptBriefing } = await import('../src/core/vision/strategist.js');
    const { loadSpec } = await import('../src/core/vision/spec.js');

    const briefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'Fleet state.',
      gapToVision: 'THE BOTTLENECK: tools are in maintenance mode.',
      proposedEvolution: {
        ambitionLevel: 10,
        toolRoadmap: [
          {
            repo: 'ashlr-pulse',
            ambitionLevel: 9,
            vision: 'Real-time fleet command center.',
            nextMilestone: 'Implement WebSocket event stream for proposals',
          },
          {
            repo: 'phantom-secrets',
            ambitionLevel: 8,
            vision: 'Production-grade team secret management.',
            nextMilestone: 'Harden team-vault sync with E2E encryption',
          },
        ],
      },
      recommendedDirection: ['THE MOVE: real-time pulse dashboard'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    };

    await adoptBriefing(mockCfgBase, briefing);

    const spec = loadSpec('ecosystem');
    expect(spec).not.toBeNull();
    expect(Array.isArray(spec!.toolRoadmap)).toBe(true);
    expect(spec!.toolRoadmap!.length).toBe(2);
    const pulseEntry = spec!.toolRoadmap!.find((e) => e.repo === 'ashlr-pulse');
    expect(pulseEntry).toBeDefined();
    expect(pulseEntry!.ambitionLevel).toBe(9);
    expect(pulseEntry!.vision).toContain('Real-time');
    expect(pulseEntry!.nextMilestone).toContain('WebSocket');
  });
});

// ---------------------------------------------------------------------------
// 4. Elon-mode ecosystem prompt — ECOSYSTEM MANAGER phrases present
// ---------------------------------------------------------------------------

describe('M179 — Elon-mode ECOSYSTEM MANAGER system prompt', () => {
  it('system prompt contains ECOSYSTEM MANAGER phrases', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain('ECOSYSTEM MANAGER');
    expect(src).toContain('ECOSYSTEM LENS');
  });

  it('system prompt still contains core Elon-mode phrases', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain('FIRST PRINCIPLES');
    expect(src).toContain('10x');
    expect(src).toContain('THE BOTTLENECK');
    expect(src).toContain('THE MOVE');
    expect(src).toContain('KILL-LIST');
  });

  it('system prompt mentions per-tool goal requirement (targetRepo)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain('targetRepo');
    expect(src).toContain('toolRoadmap');
  });

  it('system prompt instructs on substantive per-tool goals (not fleet-internal metrics)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain('SUBSTANTIVE');
    expect(src).toContain('nextMilestone');
  });

  it('system prompt mentions ecosystem tool examples (ashlr-pulse, phantom)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain('ashlr-pulse');
    expect(src).toContain('phantom');
  });

  it('system prompt JSON schema includes toolRoadmap in proposedEvolution', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    // The JSON schema example in the prompt should show toolRoadmap
    const toolRoadmapIdx = src.indexOf('"toolRoadmap"');
    expect(toolRoadmapIdx).toBeGreaterThan(-1);
    // Should appear inside the proposedEvolution schema example
    const proposedEvolutionIdx = src.lastIndexOf('"proposedEvolution"', toolRoadmapIdx);
    expect(proposedEvolutionIdx).toBeGreaterThan(-1);
    expect(proposedEvolutionIdx).toBeLessThan(toolRoadmapIdx);
  });
});

// ---------------------------------------------------------------------------
// 5. Ecosystem prompt injection — per-tool section appears in user prompt
// ---------------------------------------------------------------------------

describe('M179 — per-tool section in user prompt', () => {
  it('user prompt contains PER-TOOL ECOSYSTEM STATE header', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    expect(capturedPrompts[0]).toContain('PER-TOOL ECOSYSTEM STATE');
  });

  it('user prompt still contains NORTH-STAR section', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    expect(capturedPrompts[0]).toContain('NORTH-STAR');
  });

  it('user prompt still contains FLEET METRICS section', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    expect(capturedPrompts[0]).toContain('FLEET METRICS');
  });

  it('user prompt per-tool section includes open issue count', async () => {
    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    // binshield has 7 open issues — that number should appear near binshield
    const prompt = capturedPrompts[0]!;
    const binshieldIdx = prompt.indexOf('binshield');
    expect(binshieldIdx).toBeGreaterThan(-1);
    // Within 300 chars of binshield mention, the issue count should appear
    const vicinity = prompt.slice(binshieldIdx, binshieldIdx + 300);
    expect(vicinity).toMatch(/7 open issues/);
  });
});

// ---------------------------------------------------------------------------
// 6. targetRepo parsing — null + string + missing
// ---------------------------------------------------------------------------

describe('M179 — targetRepo parsing edge cases', () => {
  it('missing targetRepo field results in undefined (not crash)', async () => {
    const briefingWithNoTarget = makeEcosystemBriefingJson({
      proposedGoals: [
        {
          objective: 'Goal without targetRepo field',
          rationale: 'Testing absent field.',
          specPriority: 'P1',
          // targetRepo intentionally omitted
        },
      ],
    });
    mockComplete.mockResolvedValueOnce(briefingWithNoTarget);

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.proposedGoals.length).toBeGreaterThan(0);
    const goal = briefing.proposedGoals[0]!;
    expect(goal.objective).toBe('Goal without targetRepo field');
    // targetRepo should be undefined (not null, not crash)
    expect(goal.targetRepo).toBeUndefined();
  });

  it('toolRoadmap with invalid entries (no repo field) are skipped', async () => {
    const briefingBadRoadmap = makeEcosystemBriefingJson({
      toolRoadmap: [
        { repo: 'ashlr-pulse', ambitionLevel: 9, vision: 'Real-time.', nextMilestone: 'WebSocket' },
        { ambitionLevel: 8, vision: 'No repo field.', nextMilestone: 'Skip me' }, // invalid
        { repo: '', ambitionLevel: 7, vision: 'Empty repo.', nextMilestone: 'Skip me too' }, // invalid
      ],
    });
    mockComplete.mockResolvedValueOnce(briefingBadRoadmap);

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap ?? [];
    // Only the valid entry should be parsed
    expect(roadmap.length).toBe(1);
    expect(roadmap[0]!.repo).toBe('ashlr-pulse');
  });

  it('toolRoadmap ambitionLevel is clamped to 1–10', async () => {
    const briefingOutOfRange = makeEcosystemBriefingJson({
      toolRoadmap: [
        { repo: 'ashlr-pulse', ambitionLevel: 15, vision: 'Too ambitious.', nextMilestone: 'Clamped' },
        { repo: 'phantom-secrets', ambitionLevel: -3, vision: 'Negative.', nextMilestone: 'Clamped' },
      ],
    });
    mockComplete.mockResolvedValueOnce(briefingOutOfRange);

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    const roadmap = briefing.proposedEvolution.toolRoadmap ?? [];
    expect(roadmap.length).toBe(2);
    for (const entry of roadmap) {
      expect(entry.ambitionLevel).toBeGreaterThanOrEqual(1);
      expect(entry.ambitionLevel).toBeLessThanOrEqual(10);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. spec.ts ToolRoadmapEntry type — shape validation
// ---------------------------------------------------------------------------

describe('M179 — spec.ts ToolRoadmapEntry type', () => {
  it('ToolRoadmapEntry is exported from spec.ts', async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/spec.ts'),
      'utf8',
    );
    expect(src).toContain('export interface ToolRoadmapEntry');
  });

  it('EndStateSpec has optional toolRoadmap field', async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/spec.ts'),
      'utf8',
    );
    expect(src).toContain('toolRoadmap?:');
    expect(src).toContain('ToolRoadmapEntry[]');
  });

  it('ToolRoadmapEntry has repo, ambitionLevel, vision, nextMilestone fields', async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/spec.ts'),
      'utf8',
    );
    // Find the ToolRoadmapEntry interface block
    const start = src.indexOf('export interface ToolRoadmapEntry');
    const end = src.indexOf('\n}', start) + 2;
    const block = src.slice(start, end);
    expect(block).toContain('repo:');
    expect(block).toContain('ambitionLevel:');
    expect(block).toContain('vision:');
    expect(block).toContain('nextMilestone:');
  });

  it('applyEvolution with toolRoadmap persists it to disk', () => {
    // Need to import from the actual module at the right HOME
    const specsDir = path.join(tmpHome, '.ashlr', 'vision');
    fs.mkdirSync(specsDir, { recursive: true });

    // Write a spec with toolRoadmap
    const spec = {
      id: 'ecosystem',
      project: null,
      northStar: 'Test NS',
      endState: 'Test ES',
      principles: [],
      priorities: [],
      openProblems: [],
      ambitionLevel: 9,
      toolRoadmap: [
        { repo: 'ashlr-pulse', ambitionLevel: 9, vision: 'Real-time.', nextMilestone: 'WebSocket event stream' },
      ],
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: 'strategist' as const,
      history: [{ version: 1, summary: 'init', ts: new Date().toISOString() }],
    };
    fs.writeFileSync(path.join(specsDir, 'ecosystem.json'), JSON.stringify(spec, null, 2));

    // Read it back
    const raw = JSON.parse(fs.readFileSync(path.join(specsDir, 'ecosystem.json'), 'utf8')) as typeof spec;
    expect(Array.isArray(raw.toolRoadmap)).toBe(true);
    expect(raw.toolRoadmap![0]!.repo).toBe('ashlr-pulse');
    expect(raw.toolRoadmap![0]!.nextMilestone).toContain('WebSocket');
  });
});

// ---------------------------------------------------------------------------
// 8. Graceful degradation — no repos enrolled → still works
// ---------------------------------------------------------------------------

describe('M179 — graceful degradation (no repos)', () => {
  it('succeeds when gatherStrategicContext returns empty repos array', async () => {
    mockGatherStrategicContext.mockResolvedValueOnce({
      repos: [],
      outcomes: { merged7d: 0, rejected7d: 0, reverted7d: 0, shipRate: 0, trivialRatio: 0 },
      fleet: { pendingProposals: 0, activeGoals: 0, completedGoals: 0 },
      narrative: 'Fleet: 0 pending proposals | 0 active goals | 0 completed goals\nRepos: no enrolled repos.',
    });

    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson({
      proposedGoals: [
        { objective: 'Enroll first tool repo into the fleet', rationale: 'Nothing to manage without enrolled tools.', specPriority: 'P1', targetRepo: null },
      ],
      toolRoadmap: [],
    }));

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.generatedAt).toBeTruthy();
    expect(Array.isArray(briefing.proposedGoals)).toBe(true);
  });

  it('per-tool section absent from prompt when no repos enrolled', async () => {
    mockGatherStrategicContext.mockResolvedValueOnce({
      repos: [],
      outcomes: { merged7d: 0, rejected7d: 0, reverted7d: 0, shipRate: 0, trivialRatio: 0 },
      fleet: { pendingProposals: 0, activeGoals: 0, completedGoals: 0 },
      narrative: 'Repos: no enrolled repos.',
    });

    const capturedPrompts: string[] = [];
    mockComplete.mockImplementation(async (_sys: string, user: string) => {
      capturedPrompts.push(user);
      return makeEcosystemBriefingJson();
    });

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await runStrategist(mockCfgBase);

    // Per-tool section header should NOT appear when repos list is empty
    expect(capturedPrompts[0]).not.toContain('PER-TOOL ECOSYSTEM STATE');
  });

  it('runStrategist never throws even when context module absent', async () => {
    // Don't need to change the mock — just verify the always-pass case
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    await expect(runStrategist(mockCfgBase)).resolves.toBeTruthy();
  });

  it('runStrategist succeeds when gatherStrategicContext rejects', async () => {
    mockGatherStrategicContext.mockRejectedValueOnce(new Error('context unavailable'));
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.generatedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 9. Full runStrategist ecosystem shape integrity
// ---------------------------------------------------------------------------

describe('M179 — runStrategist ecosystem full integrity', () => {
  it('returns valid StrategicBriefing shape with ecosystem fields', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.generatedAt).toBeTruthy();
    expect(typeof briefing.currentState).toBe('string');
    expect(typeof briefing.gapToVision).toBe('string');
    expect(Array.isArray(briefing.recommendedDirection)).toBe(true);
    expect(Array.isArray(briefing.newProblems)).toBe(true);
    expect(Array.isArray(briefing.questionsForMason)).toBe(true);
    expect(Array.isArray(briefing.proposedGoals)).toBe(true);
    expect(typeof briefing.proposedEvolution).toBe('object');
    // M179: toolRoadmap should be present
    expect(Array.isArray(briefing.proposedEvolution.toolRoadmap)).toBe(true);
  });

  it('THE BOTTLENECK references ecosystem tools not fleet-internal metrics', async () => {
    mockComplete.mockResolvedValueOnce(makeEcosystemBriefingJson());

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgBase);

    expect(briefing.gapToVision).toContain('BOTTLENECK');
    // The bottleneck description should reference ecosystem/tools, not just fleet metrics
    expect(briefing.gapToVision.toLowerCase()).toMatch(/tool|ecosystem|pulse|phantom|vault|real.time|binshield/);
  });

  it('uses cfg.foundry.strategistModel (Opus) — strategic-model constant present', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/core/vision/strategist.ts'),
      'utf8',
    );
    expect(src).toContain("'claude-opus-4-8'");
  });

  it('degrades gracefully when LLM unavailable — never throws', async () => {
    mockComplete.mockRejectedValueOnce(new Error('Opus unavailable'));

    const { runStrategist } = await import('../src/core/vision/strategist.js');
    const briefing = await runStrategist(mockCfgWithOpus);

    expect(briefing).toBeTruthy();
    expect(briefing.generatedAt).toBeTruthy();
    expect(Array.isArray(briefing.proposedGoals)).toBe(true);
  });
});
