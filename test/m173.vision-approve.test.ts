/**
 * m173.vision-approve.test.ts — Vision approve round-trip tests.
 *
 * Bug: `ashlr vision approve` reported "no briefing found" even though a
 * persisted briefing existed at ~/.ashlr/vision/briefings/. Root cause:
 * loadLatestBriefing() called require('node:fs') inside an ESM module —
 * the ReferenceError was silently swallowed by the outer try/catch, returning
 * null. Fix: use the static ESM import (readdirSync / readFileSync).
 *
 * Units under test:
 *   1. Round-trip — writeBriefing (via runStrategist) → loadLatestBriefing finds it
 *   2. Direct persist → loadLatestBriefing round-trip (no LLM call)
 *   3. approve path — loadLatestBriefing + adoptBriefing applies briefing + creates goals
 *   4. "no briefing" path triggers only when dir is genuinely empty
 *   5. project filter — loadLatestBriefing(project) ignores mismatched briefings
 *
 * Hermetic: HOME relocated to a tmp dir. Mirrors m121 conventions.
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
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m173-home-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Mock: createGoal — track calls
// ---------------------------------------------------------------------------

const createdGoals: Array<{ objective: string; project?: string | null }> = [];
const persistedGoals = new Map<string, ReturnType<typeof makeMockGoal>>();
let persistGoalWrites = true;

function makeMockGoal(id: string, objective: string, project?: string | null) {
  const now = new Date().toISOString();
  return {
    id,
    objective,
    project: project ?? null,
    status: 'planning' as const,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

vi.mock('../src/core/goals/store.js', () => ({
  createGoal: vi.fn((objective: string, opts?: { project?: string | null }) => {
    const id = `goal-${createdGoals.length}`;
    createdGoals.push({ objective, project: opts?.project });
    const goal = makeMockGoal(id, objective, opts?.project);
    if (persistGoalWrites) persistedGoals.set(id, goal);
    return goal;
  }),
  createGoalIfAbsent: vi.fn((objective: string, opts?: { project?: string | null; mission?: unknown }) => {
    const id = `goal-${createdGoals.length}`;
    const goal = { ...makeMockGoal(id, objective, opts?.project), ...(opts?.mission ? { mission: opts.mission } : {}) };
    createdGoals.push({ objective, project: opts?.project });
    if (!persistGoalWrites) return { status: 'failed', goal };
    if (persistedGoals.has(id)) return { status: 'exists', goal };
    persistedGoals.set(id, goal as ReturnType<typeof makeMockGoal>);
    return { status: 'created', goal };
  }),
  listGoals: vi.fn(() => []),
  listGoalsDetailed: vi.fn(() => ({
    goals: [],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    scannedFiles: 0,
    unreadableFiles: 0,
    limitExceeded: false,
  })),
  loadGoal: vi.fn((id: string) => persistedGoals.get(id) ?? null),
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
    proposalsCreated: 5,
    merged: 3,
    rejected: 1,
    pending: 1,
    withDiff: 4,
    emptyRate: 0.0,
    trivialRatio: 0.1,
    acceptRate: 0.6,
    rejectRate: 0.2,
    verifyPassRate: 0.9,
    avgDiffLines: 30,
    byEngine: {},
    byRepo: {},
  })),
}));

// Mock health report
vi.mock('../src/core/quality/health.js', () => ({
  computeReport: vi.fn(async () => ({ repos: [{ overall: 80 }] })),
}));

// Mock provider-client so runStrategist uses our mock complete
const mockComplete = vi.fn<[string, string], Promise<string>>();

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'mock-frontier',
    complete: mockComplete,
  })),
}));

beforeEach(() => {
  createdGoals.length = 0;
  persistedGoals.clear();
  persistGoalWrites = true;
  mockComplete.mockReset();
});

// ---------------------------------------------------------------------------
// Late imports (after vi.mock declarations)
// ---------------------------------------------------------------------------

import {
  runStrategist,
  loadLatestBriefing,
  readLatestBriefingDetailed,
  adoptBriefing,
  previewBriefingAdoption,
} from '../src/core/vision/strategist.js';
import type { StrategicBriefing } from '../src/core/vision/strategist.js';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Dead Ollama URL — fails fast rather than timing out
const mockCfg: AshlrConfig = { provider: 'anthropic', models: { ollama: 'http://127.0.0.1:9' } } as unknown as AshlrConfig;

function makeBriefingJson(overrides: Partial<{
  proposedGoals: unknown[];
  project: string | null;
}> = {}): string {
  return JSON.stringify({
    currentState: 'Fleet shipping at 60% accept rate.',
    gapToVision: 'Multi-file execution is the bottleneck.',
    proposedEvolution: { ambitionLevel: 9 },
    recommendedDirection: ['Ship multi-file executor', 'Kill low-leverage proposals'],
    newProblems: ['Cross-repo dep resolution'],
    questionsForMason: [],
    proposedGoals: overrides.proposedGoals ?? [
      { objective: 'Multi-file milestone executor', rationale: 'Closes autonomy gap.', specPriority: 'End-to-end autonomy for well-scoped tasks' },
    ],
  });
}

/** Write a briefing JSON directly to tmpHome briefings dir (mirrors writeBriefing internals). */
function writeBriefingFile(briefing: StrategicBriefing): string {
  const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
  fs.mkdirSync(dir, { recursive: true });
  const ts = briefing.generatedAt.replace(/[:.]/g, '-');
  const project = briefing.project ? `-${briefing.project}` : '';
  const file = path.join(dir, `${ts}${project}.json`);
  fs.writeFileSync(file, JSON.stringify(briefing, null, 2) + '\n', 'utf8');
  return file;
}

function makeBriefing(overrides: Partial<StrategicBriefing> = {}): StrategicBriefing {
  return {
    generatedAt: new Date().toISOString(),
    project: null,
    currentState: 'Test state.',
    gapToVision: 'Test gap.',
    proposedEvolution: { ambitionLevel: 8 },
    recommendedDirection: ['Do the thing'],
    newProblems: [],
    questionsForMason: [],
    proposedGoals: [
      { objective: 'Execute multi-file tasks end-to-end', rationale: 'Core gap.', specPriority: 'Autonomy' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Round-trip via runStrategist → loadLatestBriefing
// ---------------------------------------------------------------------------

describe('M173 — runStrategist → loadLatestBriefing round-trip', () => {
  it('persisted briefing is found by loadLatestBriefing after runStrategist', async () => {
    mockComplete.mockResolvedValueOnce(makeBriefingJson());
    const original = await runStrategist(mockCfg);

    // Confirm file was written
    const briefingsDir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    expect(fs.existsSync(briefingsDir)).toBe(true);
    const files = fs.readdirSync(briefingsDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    // loadLatestBriefing must find it
    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(original.generatedAt);
    expect(loaded!.currentState).toBe(original.currentState);
  });

  it('loadLatestBriefing returns the most recent of multiple briefings', async () => {
    // Write two briefings with different timestamps
    const older = makeBriefing({ generatedAt: '2026-06-27T10:00:00.000Z' });
    const newer = makeBriefing({ generatedAt: '2026-06-28T03:25:05.379Z' });
    writeBriefingFile(older);
    writeBriefingFile(newer);

    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();
    // Sort-reversed filenames should surface the newer one
    expect(loaded!.generatedAt).toBe(newer.generatedAt);
  });
});

// ---------------------------------------------------------------------------
// 2. Direct persist → loadLatestBriefing (no LLM involved)
// ---------------------------------------------------------------------------

describe('M173 — direct persist → loadLatestBriefing', () => {
  it('finds a briefing written directly to the briefings dir', () => {
    const briefing = makeBriefing();
    writeBriefingFile(briefing);

    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();
    expect(loaded!.generatedAt).toBe(briefing.generatedAt);
    expect(loaded!.proposedGoals).toHaveLength(1);
    expect(loaded!.proposedGoals[0]!.objective).toBe('Execute multi-file tasks end-to-end');
  });

  it('returns full briefing fields correctly', () => {
    const briefing = makeBriefing({
      currentState: 'Specific state value',
      gapToVision: 'Specific gap value',
      recommendedDirection: ['Move A', 'Move B'],
      newProblems: ['Problem X'],
      questionsForMason: ['Question Y'],
    });
    writeBriefingFile(briefing);

    const loaded = loadLatestBriefing()!;
    expect(loaded.currentState).toBe('Specific state value');
    expect(loaded.gapToVision).toBe('Specific gap value');
    expect(loaded.recommendedDirection).toEqual(['Move A', 'Move B']);
    expect(loaded.newProblems).toEqual(['Problem X']);
    expect(loaded.questionsForMason).toEqual(['Question Y']);
  });
});

// ---------------------------------------------------------------------------
// 3. approve path — loadLatestBriefing + adoptBriefing applies + creates goals
// ---------------------------------------------------------------------------

describe('M173 — approve path (loadLatestBriefing + adoptBriefing)', () => {
  it('approve: finds briefing and creates goals via adoptBriefing', async () => {
    const briefing = makeBriefing({
      proposedGoals: [
        { objective: 'Ship multi-file executor', rationale: 'Core gap.', specPriority: 'Autonomy' },
        { objective: 'Tighten quality gate', rationale: 'Quality.' },
      ],
    });
    writeBriefingFile(briefing);

    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();

    const result = await adoptBriefing(mockCfg, loaded!);
    expect(result.specId).toBe('ecosystem');
    expect(result.goalIds).toHaveLength(2);
    expect(createdGoals).toHaveLength(2);
    expect(createdGoals[0]!.objective).toContain('[vision:Autonomy]');
    expect(createdGoals[0]!.objective).toContain('Ship multi-file executor');
  });

  it('approve: evolves spec from persisted briefing', async () => {
    const briefing = makeBriefing({
      proposedEvolution: { northStar: 'Approved north star from briefing.' },
      proposedGoals: [],
    });
    writeBriefingFile(briefing);

    const loaded = loadLatestBriefing()!;
    await adoptBriefing(mockCfg, loaded);

    const { loadSpec } = await import('../src/core/vision/spec.js');
    const spec = loadSpec('ecosystem')!;
    expect(spec.northStar).toBe('Approved north star from briefing.');
    expect(spec.version).toBe(2);
  });

  it('cmdVision approve returns 0 when briefing exists', async () => {
    const briefing = makeBriefing({ proposedGoals: [] });
    writeBriefingFile(briefing);

    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['approve']);
    expect(code).toBe(0);
  });

  it('cmdVision approve returns 1 and reports a goal-store persistence failure', async () => {
    const briefing = makeBriefing({
      proposedGoals: [
        { objective: 'Goal whose write fails', rationale: 'Exercise persistence truth.' },
      ],
    });
    writeBriefingFile(briefing);
    persistGoalWrites = false;
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['approve']);

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('Failed to persist 1 proposed goal(s)');
    expect(errors.join('\n')).toContain('the local goal record could not be persisted');
  });

  it('cmdVision preview compiles the briefing without creating goals', async () => {
    const briefing = makeBriefing({
      proposedGoals: [
        { objective: 'Preview-only mission', rationale: 'Inspect before adoption.' },
      ],
    });
    writeBriefingFile(briefing);

    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['preview']);

    expect(code).toBe(0);
    expect(createdGoals).toHaveLength(0);
  });

  it('cmdVision preview and reconcile fail closed for an invalid mission graph', async () => {
    const node = (key: string, dependsOn: string[]) => ({
      key, objective: `Gate ${key}`, rationale: 'Human-owned decision.', targetRepo: null,
      dependsOn, deliverable: `Decision ${key}`, acceptanceEvidence: ['Authorized receipt exists'],
      riskClass: 'high' as const, humanGate: true,
      outcome: { desiredOutcome: 'A safe decision', successSignals: ['Decision recorded'], guardrails: ['No inferred approval'] },
    });
    writeBriefingFile(makeBriefing({ proposedGoals: [node('one', ['two']), node('two', ['one'])] }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['preview'])).toBe(1);
    expect(await cmdVision(['reconcile'])).toBe(1);
    expect(createdGoals).toHaveLength(0);
  });

  it('cmdVision preview explains the complete outcome and evidence contract', async () => {
    writeBriefingFile(makeBriefing({ proposedGoals: [{
      key: 'release', objective: 'Authorize release', rationale: 'Human-owned.', targetRepo: null,
      dependsOn: [], deliverable: 'Release decision receipt',
      acceptanceEvidence: ['Authorized receipt is bound to the mission'], riskClass: 'high', humanGate: true,
      outcome: {
        desiredOutcome: 'A safe release decision',
        successSignals: ['Decision is traceable'],
        guardrails: ['No inferred approval'],
      },
    }] }));
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => output.push(args.map(String).join(' ')));
    const { cmdVision } = await import('../src/cli/vision.js');

    expect(await cmdVision(['preview'])).toBe(0);
    expect(output.join('\n')).toContain('deliverable: Release decision receipt');
    expect(output.join('\n')).toContain('acceptance evidence: Authorized receipt is bound to the mission');
    expect(output.join('\n')).toContain('success signals: Decision is traceable');
    expect(output.join('\n')).toContain('guardrails: No inferred approval');
    expect(output.join('\n')).toContain('human gate required');
  });
});

describe('M173 — malformed model mission metadata', () => {
  const validNode = {
    key: 'root', objective: 'Build root', rationale: 'Needed.', targetRepo: 'hub', dependsOn: [],
    deliverable: 'Root artifact', acceptanceEvidence: ['Root tests pass'], riskClass: 'low', humanGate: false,
    outcome: { desiredOutcome: 'Users benefit', successSignals: ['Usage grows'], guardrails: ['No new authority'] },
  };

  it.each([
    ['invalid dependency', { dependsOn: ['BAD KEY'] }],
    ['too many dependencies', { dependsOn: Array.from({ length: 9 }, (_, index) => `node-${index}`) }],
    ['string human gate', { humanGate: 'true' }],
    ['invalid key', { key: 'Bad Key' }],
    ['incomplete outcome', { outcome: { desiredOutcome: 'Users benefit', successSignals: [], guardrails: [] } }],
  ])('marks %s as invalid instead of silently making a ready root', async (_label, override) => {
    mockComplete.mockResolvedValueOnce(makeBriefingJson({ proposedGoals: [{ ...validNode, ...override }] }));
    const parsed = await runStrategist(mockCfg);
    expect(parsed.proposedGoals[0]?.missionMetadataInvalid).toBe(true);
    const preview = previewBriefingAdoption(parsed, {
      enrolledRepos: [path.join(tmpHome, 'hub')], existingGoals: [], activeThreshold: 4,
    });
    expect(preview.missionGraph?.state).toBe('invalid');
    expect(preview.entries[0]?.reason).toBe('mission-graph-invalid');
  });

  it.each([
    ['invalid dependency', { dependsOn: ['BAD KEY'] }],
    ['too many dependencies', { dependsOn: Array.from({ length: 9 }, (_, index) => `node-${index}`) }],
    ['string human gate', { humanGate: 'true' }],
    ['incomplete outcome', { outcome: { desiredOutcome: 'Users benefit', successSignals: ['Usage grows'], guardrails: [] } }],
  ])('rejects persisted mission metadata with %s', (_label, override) => {
    const malformed = makeBriefing({
      proposedGoals: [{ ...validNode, ...override }] as StrategicBriefing['proposedGoals'],
    });
    writeBriefingFile(malformed);

    expect(readLatestBriefingDetailed()).toMatchObject({
      briefing: null,
      sourceState: 'degraded',
      complete: false,
      reason: 'briefing-records-unreadable',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. "no briefing" path — triggers only when dir is genuinely empty
// ---------------------------------------------------------------------------

describe('M173 — no briefing path', () => {
  it('loadLatestBriefing returns null when briefings dir does not exist', () => {
    // Fresh tmpHome — no briefings dir written
    const loaded = loadLatestBriefing();
    expect(loaded).toBeNull();
  });

  it('loadLatestBriefing returns null when briefings dir is empty', () => {
    const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    fs.mkdirSync(dir, { recursive: true });
    // Dir exists but has no .json files
    const loaded = loadLatestBriefing();
    expect(loaded).toBeNull();
  });

  it('loadLatestBriefing skips corrupt JSON files and returns null when all corrupt', () => {
    const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-06-28T03-00-00-000Z.json'), 'NOT_VALID_JSON', 'utf8');
    const loaded = loadLatestBriefing();
    expect(loaded).toBeNull();
  });

  it('bounds total directory entries, including non-JSON files', () => {
    const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 513; index++) fs.writeFileSync(path.join(dir, `noise-${index}.txt`), 'x');
    expect(readLatestBriefingDetailed()).toMatchObject({
      briefing: null, sourceState: 'degraded', complete: false,
      reason: 'briefing-record-limit-exceeded', limitExceeded: true,
    });
  });

  it.each([
    ['schema-invalid', JSON.stringify({})],
    ['oversized', 'x'.repeat(256 * 1024 + 1)],
  ])('degrades rather than trusting a %s briefing record', (_kind, contents) => {
    const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-08-09.json'), contents);
    expect(readLatestBriefingDetailed()).toMatchObject({
      briefing: null, sourceState: 'degraded', complete: false,
      reason: 'briefing-records-unreadable', unreadableFiles: 1,
    });
  });

  it('reconcile refuses an older valid briefing when a newer record is corrupt', async () => {
    writeBriefingFile(makeBriefing({
      generatedAt: '2026-08-08T12:00:00.000Z',
      proposedGoals: [{ objective: 'Do not materialize stale work', rationale: 'Stale authority.' }],
    }));
    const dir = path.join(tmpHome, '.ashlr', 'vision', 'briefings');
    fs.writeFileSync(path.join(dir, '2026-08-09T12-00-00-000Z.json'), '{"partial":', 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { cmdVision } = await import('../src/cli/vision.js');
    expect(await cmdVision(['reconcile'])).toBe(1);
    expect(createdGoals).toHaveLength(0);
  });

  it('cmdVision approve returns 1 when no briefing exists', async () => {
    // Fresh tmpHome — no briefings dir
    const { cmdVision } = await import('../src/cli/vision.js');
    const code = await cmdVision(['approve']);
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. project filter — loadLatestBriefing(project) ignores mismatched briefings
// ---------------------------------------------------------------------------

describe('M173 — project filter in loadLatestBriefing', () => {
  it('returns null when all briefings belong to a different project', () => {
    const briefing = makeBriefing({ project: 'other-repo' });
    writeBriefingFile(briefing);

    // Ask for a project that has no matching briefing
    const loaded = loadLatestBriefing('my-repo');
    expect(loaded).toBeNull();
  });

  it('returns matching project briefing when project matches', () => {
    const briefing = makeBriefing({ project: 'my-repo' });
    writeBriefingFile(briefing);

    const loaded = loadLatestBriefing('my-repo');
    expect(loaded).not.toBeNull();
    expect(loaded!.project).toBe('my-repo');
  });

  it('loadLatestBriefing() with no args returns ANY briefing regardless of project', () => {
    const briefing = makeBriefing({ project: 'some-project' });
    writeBriefingFile(briefing);

    // No argument → no project filter → returns the briefing
    const loaded = loadLatestBriefing();
    expect(loaded).not.toBeNull();
    expect(loaded!.project).toBe('some-project');
  });

  it('loadLatestBriefing(null) filters to null-project briefings only', () => {
    const withProject = makeBriefing({ generatedAt: '2026-06-28T01:00:00.000Z', project: 'some-repo' });
    const withoutProject = makeBriefing({ generatedAt: '2026-06-28T02:00:00.000Z', project: null });
    writeBriefingFile(withProject);
    writeBriefingFile(withoutProject);

    const loaded = loadLatestBriefing(null);
    expect(loaded).not.toBeNull();
    expect(loaded!.project).toBeNull();
  });
});
