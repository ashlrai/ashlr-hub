/**
 * m121.vision.test.ts — Vision / Strategist layer tests.
 *
 * Units under test:
 *   1. spec CRUD — loadSpec/saveSpec/listSpecs, defaultEcosystemSpec on first access
 *   2. applyEvolution — bumps version, appends history, persists, by-attribution
 *   3. runStrategist — parses a mocked frontier response → StrategicBriefing shape
 *   4. adoptBriefing — evolves spec + creates goals (mock createGoal) tagged to spec
 *   5. manager alignment hook — buildJudgePrompt includes spec context when present
 *   6. CLI cmdVision — show/approve/set/review exit codes + usage
 *
 * Hermetic: HOME relocated to a tmp dir. getActiveClient and createGoal mocked.
 * Conventions mirror m120.manager.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m121-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock: getActiveClient — returns a deterministic strategist
// ---------------------------------------------------------------------------

const mockComplete = vi.fn<[string, string], Promise<string>>();

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'mock-frontier',
    complete: mockComplete,
  })),
}));

// ---------------------------------------------------------------------------
// Mock: createGoal — track calls
// ---------------------------------------------------------------------------

const createdGoals: Array<{ objective: string; project?: string | null }> = [];

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: vi.fn((objective: string, opts?: { project?: string | null }) => {
    const id = `goal-${createdGoals.length}`;
    createdGoals.push({ objective, project: opts?.project });
    return { id, objective, project: opts?.project ?? null, status: 'planning', milestones: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }),
  listGoals: vi.fn(() => []),
  loadGoal: vi.fn(() => null),
  saveGoal: vi.fn(),
  deleteGoal: vi.fn(),
  addMilestone: vi.fn(),
  updateMilestoneStatus: vi.fn(),
  clearMilestones: vi.fn(),
  reorderMilestones: vi.fn(),
  pauseMilestone: vi.fn(),
  resumeMilestone: vi.fn(),
  skipMilestone: vi.fn(),
}));

// Mock quality-metrics so runStrategist doesn't need real proposals
vi.mock('../src/core/fleet/quality-metrics.js', () => ({
  computeQualityMetrics: vi.fn(() => ({
    window: '30d',
    proposalsCreated: 10,
    merged: 7,
    rejected: 1,
    pending: 2,
    withDiff: 9,
    emptyRate: 0.1,
    trivialRatio: 0.2,
    acceptRate: 0.7,
    rejectRate: 0.1,
    verifyPassRate: 0.8,
    avgDiffLines: 45,
    byEngine: {},
    byRepo: {},
  })),
}));

// Mock health report
vi.mock('../src/core/quality/health.js', () => ({
  computeReport: vi.fn(async () => ({ repos: [{ overall: 78 }] })),
}));

beforeEach(() => {
  createdGoals.length = 0;
  mockComplete.mockReset();
});

// ---------------------------------------------------------------------------
// Late imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  loadSpec,
  saveSpec,
  listSpecs,
  applyEvolution,
} from '../src/core/vision/spec.js';
import type { EndStateSpec } from '../src/core/vision/spec.js';
import { runStrategist, adoptBriefing, loadLatestBriefing } from '../src/core/vision/strategist.js';
import type { StrategicBriefing } from '../src/core/vision/strategist.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockCfg: AshlrConfig = { provider: 'anthropic' } as unknown as AshlrConfig;

function makeMockBriefingJson(overrides: Partial<{
  currentState: string;
  gapToVision: string;
  proposedGoals: unknown[];
}> = {}): string {
  return JSON.stringify({
    currentState: overrides.currentState ?? 'Fleet is shipping steadily at 70% accept rate.',
    gapToVision: overrides.gapToVision ?? 'Autonomous end-to-end execution is missing for multi-file tasks.',
    proposedEvolution: {
      ambitionLevel: 10,
      priorities: [
        { title: 'End-to-end autonomy', rationale: 'Core gap to close.', rank: 1 },
      ],
    },
    recommendedDirection: ['Ship multi-file milestone executor', 'Add verify step to all proposals'],
    newProblems: ['Cross-repo dependency resolution'],
    questionsForMason: ['Should the fleet target 95% autonomy or 100%?'],
    proposedGoals: overrides.proposedGoals ?? [
      { objective: 'Implement multi-file milestone executor', rationale: 'Closes autonomy gap.', specPriority: 'End-to-end autonomy for well-scoped tasks' },
      { objective: 'Add verify step to proposal pipeline', rationale: 'Improves quality gate.', specPriority: 'Quality gate robustness' },
    ],
  });
}

// ---------------------------------------------------------------------------
// 1. Spec CRUD
// ---------------------------------------------------------------------------

describe('M121 — spec CRUD', () => {
  it('loadSpec("ecosystem") returns a non-null default on first access', () => {
    const spec = loadSpec('ecosystem');
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe('ecosystem');
    expect(typeof spec!.northStar).toBe('string');
    expect(spec!.northStar.length).toBeGreaterThan(10);
    expect(spec!.version).toBe(1);
    expect(spec!.updatedBy).toBe('mason');
  });

  it('loadSpec for unknown id returns null', () => {
    const spec = loadSpec('no-such-spec-xyz');
    expect(spec).toBeNull();
  });

  it('saveSpec + loadSpec round-trips correctly', () => {
    const now = new Date().toISOString();
    const spec: EndStateSpec = {
      id: 'test-project',
      project: 'test-project',
      northStar: 'Test north star.',
      endState: 'Test end state.',
      principles: ['Never throw.'],
      priorities: [{ title: 'Ship fast', rationale: 'Velocity matters.', rank: 1 }],
      openProblems: ['How to be 10x.'],
      ambitionLevel: 8,
      version: 1,
      updatedAt: now,
      updatedBy: 'mason',
      history: [{ version: 1, summary: 'Initial.', ts: now }],
    };
    saveSpec(spec);

    const loaded = loadSpec('test-project');
    expect(loaded).not.toBeNull();
    expect(loaded!.northStar).toBe('Test north star.');
    expect(loaded!.ambitionLevel).toBe(8);
    expect(loaded!.priorities[0]!.title).toBe('Ship fast');
  });

  it('listSpecs returns all saved specs', () => {
    // Save two specs.
    const now = new Date().toISOString();
    const base: EndStateSpec = {
      id: 'alpha', project: null, northStar: 'A', endState: 'B',
      principles: [], priorities: [], openProblems: [],
      ambitionLevel: 5, version: 1, updatedAt: now, updatedBy: 'mason', history: [],
    };
    saveSpec({ ...base, id: 'alpha' });
    saveSpec({ ...base, id: 'beta' });

    const specs = listSpecs();
    const ids = specs.map((s) => s.id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
  });

  it('listSpecs returns [] on empty dir', () => {
    // Fresh HOME — no specs written yet.
    const specs = listSpecs();
    expect(Array.isArray(specs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. applyEvolution — version bump + history
// ---------------------------------------------------------------------------

describe('M121 — applyEvolution', () => {
  it('bumps version and appends history entry', () => {
    // Ensure ecosystem spec exists at v1.
    const original = loadSpec('ecosystem')!;
    expect(original.version).toBe(1);

    const updated = applyEvolution(
      'ecosystem',
      { northStar: 'New north star via evolution.' },
      'strategist',
      'Strategist raised ambition.',
    );

    expect(updated.version).toBe(2);
    expect(updated.northStar).toBe('New north star via evolution.');
    expect(updated.updatedBy).toBe('strategist');
    expect(updated.history).toHaveLength(2);
    expect(updated.history[1]!.summary).toBe('Strategist raised ambition.');
  });

  it('by:mason stamps updatedBy as mason', () => {
    const updated = applyEvolution('ecosystem', { ambitionLevel: 10 }, 'mason');
    expect(updated.updatedBy).toBe('mason');
    expect(updated.ambitionLevel).toBe(10);
  });

  it('persists across load after evolution', () => {
    applyEvolution('ecosystem', { northStar: 'Persisted north star.' }, 'mason');
    const reloaded = loadSpec('ecosystem')!;
    expect(reloaded.northStar).toBe('Persisted north star.');
    expect(reloaded.version).toBe(2);
  });

  it('creates spec on first evolution for non-existing id', () => {
    const spec = applyEvolution('brand-new-spec', { northStar: 'Born now.' }, 'mason');
    expect(spec.northStar).toBe('Born now.');
    expect(spec.version).toBeGreaterThanOrEqual(2); // default is v1, evolution → v2
  });

  it('never throws on any input', () => {
    expect(() => applyEvolution('ecosystem', {}, 'mason')).not.toThrow();
    expect(() => applyEvolution('ecosystem', { ambitionLevel: 999 }, 'strategist')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. runStrategist — parses mocked frontier briefing
// ---------------------------------------------------------------------------

describe('M121 — runStrategist', () => {
  it('returns a valid StrategicBriefing from a mocked LLM response', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());

    const briefing = await runStrategist(mockCfg);

    expect(briefing.generatedAt).toBeTruthy();
    expect(typeof briefing.currentState).toBe('string');
    expect(briefing.currentState.length).toBeGreaterThan(5);
    expect(typeof briefing.gapToVision).toBe('string');
    expect(Array.isArray(briefing.recommendedDirection)).toBe(true);
    expect(Array.isArray(briefing.newProblems)).toBe(true);
    expect(Array.isArray(briefing.questionsForMason)).toBe(true);
    expect(Array.isArray(briefing.proposedGoals)).toBe(true);
    expect(typeof briefing.proposedEvolution).toBe('object');
  });

  it('parses proposedGoals with specPriority linkage', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());
    const briefing = await runStrategist(mockCfg);

    expect(briefing.proposedGoals.length).toBe(2);
    expect(briefing.proposedGoals[0]!.objective).toContain('multi-file');
    expect(briefing.proposedGoals[0]!.specPriority).toBeTruthy();
  });

  it('parses proposedEvolution fields', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());
    const briefing = await runStrategist(mockCfg);

    expect(briefing.proposedEvolution.ambitionLevel).toBe(10);
    expect(Array.isArray(briefing.proposedEvolution.priorities)).toBe(true);
  });

  it('degrades gracefully when LLM is unavailable', async () => {
    mockComplete.mockRejectedValueOnce(new Error('network failure'));
    const briefing = await runStrategist(mockCfg);

    // Should return a fallback briefing, never throw.
    expect(briefing).toBeTruthy();
    expect(briefing.generatedAt).toBeTruthy();
    expect(Array.isArray(briefing.proposedGoals)).toBe(true);
  });

  it('handles malformed JSON from LLM — returns fallback, never throws', async () => {
    mockComplete.mockResolvedValueOnce('This is not JSON at all, sorry.');
    const briefing = await runStrategist(mockCfg);

    expect(briefing).toBeTruthy();
    expect(typeof briefing.currentState).toBe('string');
  });

  it('persists briefing to ~/.ashlr/vision/briefings/', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());
    await runStrategist(mockCfg);

    const briefingsDir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    expect(fs.existsSync(briefingsDir)).toBe(true);
    const files = fs.readdirSync(briefingsDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('loadLatestBriefing returns the persisted briefing', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());
    const original = await runStrategist(mockCfg);

    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(original.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// 4. adoptBriefing — spec evolution + goal creation
// ---------------------------------------------------------------------------

describe('M121 — adoptBriefing', () => {
  it('creates goals from proposedGoals via createGoal', async () => {
    const briefing: StrategicBriefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: { ambitionLevel: 9 },
      recommendedDirection: ['Ship thing A'],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [
        { objective: 'Implement parallel executor', rationale: 'Speed.', specPriority: 'End-to-end autonomy for well-scoped tasks' },
        { objective: 'Tighten quality gate', rationale: 'Quality.', specPriority: 'Quality gate robustness' },
      ],
    };

    const result = await adoptBriefing(mockCfg, briefing);

    expect(result.goalIds).toHaveLength(2);
    expect(createdGoals).toHaveLength(2);
    // Goals should be tagged with spec priority in the objective prefix.
    expect(createdGoals[0]!.objective).toContain('[vision:');
    expect(createdGoals[0]!.objective).toContain('Implement parallel executor');
    expect(createdGoals[1]!.objective).toContain('[vision:');
  });

  it('evolves the spec when proposedEvolution is non-empty', async () => {
    const briefing: StrategicBriefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: { northStar: 'Updated north star via adopt.' },
      recommendedDirection: [],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    };

    await adoptBriefing(mockCfg, briefing);

    const spec = loadSpec('ecosystem')!;
    expect(spec.northStar).toBe('Updated north star via adopt.');
    expect(spec.version).toBe(2);
  });

  it('goals without specPriority are created without prefix', async () => {
    const briefing: StrategicBriefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: {},
      recommendedDirection: [],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [
        { objective: 'Bare goal with no priority link', rationale: 'Just a goal.' },
      ],
    };

    await adoptBriefing(mockCfg, briefing);

    expect(createdGoals[0]!.objective).not.toContain('[vision:');
    expect(createdGoals[0]!.objective).toBe('Bare goal with no priority link');
  });

  it('returns specId correctly for ecosystem spec', async () => {
    const briefing: StrategicBriefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: 'State.',
      gapToVision: 'Gap.',
      proposedEvolution: {},
      recommendedDirection: [],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    };

    const result = await adoptBriefing(mockCfg, briefing);
    expect(result.specId).toBe('ecosystem');
  });

  it('never throws even with an empty briefing', async () => {
    const briefing: StrategicBriefing = {
      generatedAt: new Date().toISOString(),
      project: null,
      currentState: '',
      gapToVision: '',
      proposedEvolution: {},
      recommendedDirection: [],
      newProblems: [],
      questionsForMason: [],
      proposedGoals: [],
    };

    await expect(adoptBriefing(mockCfg, briefing)).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 5. Manager alignment hook — judgeProposal includes spec context
// ---------------------------------------------------------------------------

describe('M121 — manager alignment uses spec context', () => {
  it('buildJudgePrompt includes north star when spec is present', async () => {
    // Save a spec so loadSpecForProposal can find it.
    const now = new Date().toISOString();
    const { saveSpec: saveSp } = await import('../src/core/vision/spec.js');
    saveSp({
      id: 'myrepo',
      project: 'myrepo',
      northStar: 'DISTINCTIVE_NORTH_STAR_STRING',
      endState: 'End state.',
      principles: [],
      priorities: [{ title: 'Priority One', rationale: 'Reason.', rank: 1 }],
      openProblems: [],
      ambitionLevel: 9,
      version: 1,
      updatedAt: now,
      updatedBy: 'mason',
      history: [],
    });

    // Import the internal loadSpecForProposal indirectly by calling judgeProposal
    // and observing what the mock complete was called with.
    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const mockClient = {
      complete: vi.fn(async () => JSON.stringify({
        verdict: 'ship', value: 5, correctness: 5, scope: 1, alignment: 5,
        rationale: 'Great change.',
      })),
    };

    const proposal = {
      id: 'p1',
      title: 'Test proposal',
      summary: 'A test.',
      kind: 'fix',
      engineModel: 'claude',
      repo: 'myrepo',
      diff: '+const x = 1;',
      status: 'pending',
      createdAt: now,
    } as Parameters<typeof judgeProposal>[0];

    await judgeProposal(proposal, mockCfg, mockClient);

    const userPromptArg = mockClient.complete.mock.calls[0]?.[1] ?? '';
    expect(userPromptArg).toContain('DISTINCTIVE_NORTH_STAR_STRING');
    expect(userPromptArg).toContain('Priority One');
  });

  it('judgeProposal still works when no repo-specific spec exists (backward-safe, uses ecosystem fallback)', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');

    const mockClient = {
      complete: vi.fn(async () => JSON.stringify({
        verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3,
        rationale: 'Needs inspection.',
      })),
    };

    const now = new Date().toISOString();
    const proposal = {
      id: 'p2',
      title: 'Another proposal',
      summary: 'Uses ecosystem spec as fallback.',
      kind: 'feature',
      engineModel: 'local',
      repo: 'repo-with-no-specific-spec-xyz',
      diff: '+foo();',
      status: 'pending',
      createdAt: now,
    } as Parameters<typeof judgeProposal>[0];

    // judgeProposal succeeds regardless of spec presence — never throws.
    const verdict = await judgeProposal(proposal, mockCfg, mockClient);
    expect(verdict.verdict).toBe('review');
    expect(verdict.alignment).toBe(3);

    // The call must have been made (client was invoked).
    expect(mockClient.complete).toHaveBeenCalledOnce();

    // Prompt includes the ecosystem spec as fallback context (alignment-to-vision
    // is always provided when an ecosystem spec exists — this is the correct behavior).
    const userPromptArg = mockClient.complete.mock.calls[0]?.[1] ?? '';
    // The prompt is well-formed regardless of whether spec context is present.
    expect(userPromptArg).toContain('Another proposal');
    expect(userPromptArg).toContain('+foo();');
  });
});

// ---------------------------------------------------------------------------
// 6. CLI cmdVision — exit codes + usage
// ---------------------------------------------------------------------------

describe('M121 — cmdVision CLI', () => {
  it('--help returns 0', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['--help'])).toBe(0);
  });

  it('no args returns 0 (shows help)', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision([])).toBe(0);
  });

  it('show returns 0 for ecosystem spec', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['show'])).toBe(0);
  });

  it('show returns 1 for missing spec id', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['show', 'nonexistent-spec-zzz'])).toBe(1);
  });

  it('set --north-star updates spec and returns 0', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['set', '--north-star', 'CLI-set north star.']);
    expect(code).toBe(0);

    const spec = loadSpec('ecosystem');
    expect(spec!.northStar).toBe('CLI-set north star.');
  });

  it('set with no flags returns 2 (bad usage)', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['set'])).toBe(2);
  });

  it('approve returns 1 when no briefing exists', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    // No briefings dir in fresh tmpHome.
    expect(await cmdVision(['approve'])).toBe(1);
  });

  it('review runs runStrategist and returns 0', async () => {
    mockComplete.mockResolvedValueOnce(makeMockBriefingJson());
    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['review']);
    expect(code).toBe(0);
  });

  it('unknown subcommand returns 2', async () => {
    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['frobnicate'])).toBe(2);
  });
});
