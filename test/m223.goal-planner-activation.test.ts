/**
 * M223 — Goal-planner activation tests.
 *
 * Verifies the root-cause fix: scanGoals must expand 'planning'-status goals
 * (zero milestones) — not just 'active' ones — so that goals created by
 * adoptBriefing/createGoal (which start in 'planning' status) actually reach
 * expandGoalToMilestones and produce work items in the daemon backlog.
 *
 * New properties verified:
 *
 *  1. PLANNING-STATUS EXPANSION: a goal with status:'planning' + 0 milestones
 *     IS picked up by scanGoals and expanded to milestones.
 *
 *  2. WORK ITEM PRODUCED: after expansion the planning goal emits a WorkItem
 *     (source:'goal', value≥4) — meaning the daemon backlog is non-empty.
 *
 *  3. OBSERVABILITY: plannerLog emits a structured '[ashlr] goal-planner:info'
 *     line when expansion succeeds (so daemon log shows activity).
 *
 *  4. NO-CLIENT SKIP LOG: when resolveFrontierJudgeClient returns null,
 *     plannerLog emits a '[ashlr] goal-planner:warn' skip line.
 *
 *  5. ACTIVE GOALS STILL WORK: active goals with 0 milestones are also
 *     expanded (regression guard on M222 behaviour).
 *
 *  6. DEDUP: a goal appearing in both listGoals('active') and
 *     listGoals('planning') is only expanded once (in-process cache).
 *
 * Hermetic: tmp HOME + mocked manager + mocked goals store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================================
// ── Mock fleet/manager (frontier client) ─────────────────────────────────────
// ============================================================================

let _completeImpl: ReturnType<typeof vi.fn>;
let _clientNull = false;

vi.mock('../src/core/fleet/manager.js', () => ({
  resolveFrontierJudgeClient: vi.fn(() => {
    if (_clientNull) return null;
    return {
      complete: (...args: unknown[]) => (_completeImpl as (...a: unknown[]) => unknown)(...args),
      model: 'mock-frontier',
    };
  }),
}));

// ============================================================================
// ── Mock goals store ──────────────────────────────────────────────────────────
// ============================================================================

let _savedGoals: Map<string, import('../src/core/types.js').Goal>;
let _activeGoals: import('../src/core/types.js').Goal[] = [];
let _planningGoals: import('../src/core/types.js').Goal[] = [];

vi.mock('../src/core/goals/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/goals/store.js')>();
  return {
    ...actual,
    saveGoal: vi.fn((goal: import('../src/core/types.js').Goal) => {
      _savedGoals.set(goal.id, structuredClone(goal));
    }),
    loadGoal: vi.fn((id: string) => {
      return _savedGoals.get(id) ?? null;
    }),
    listGoals: vi.fn((filter?: { status?: string }) => {
      if (filter?.status === 'active') return _activeGoals;
      if (filter?.status === 'planning') return _planningGoals;
      return [..._activeGoals, ..._planningGoals];
    }),
    goalsDir: vi.fn(() => path.join(os.tmpdir(), 'm223-goals')),
  };
});

// ============================================================================
// ── Mock github + policy (transitive deps of scanners) ───────────────────────
// ============================================================================

vi.mock('../src/core/integrations/github.js', () => ({
  listIssues: vi.fn(() => []),
  githubStatus: vi.fn(() => ({ isRepo: false, ci: 'unknown' })),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: vi.fn(() => false),
  setKill: vi.fn(),
  listEnrolled: vi.fn(() => []),
  isEnrolled: vi.fn(() => false),
}));

// ============================================================================
// ── Late imports ──────────────────────────────────────────────────────────────
// ============================================================================

import { expandGoalToMilestones, clearGoalPlannerCache } from '../src/core/strategy/goal-planner.js';
import { scanGoals } from '../src/core/portfolio/scanners.js';
import type { Goal, AshlrConfig } from '../src/core/types.js';

// ============================================================================
// ── Helpers ───────────────────────────────────────────────────────────────────
// ============================================================================

function makeCfg(overrides: Partial<NonNullable<AshlrConfig['foundry']>> = {}): Pick<AshlrConfig, 'foundry' | 'models'> {
  return {
    foundry: overrides,
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
  };
}

function makePlanningGoal(id: string, objective: string, project: string | null = tmpDir): Goal {
  return {
    id,
    objective,
    project,
    status: 'planning',
    milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeActiveGoalNoMilestones(id: string, objective: string, project: string | null = tmpDir): Goal {
  return {
    id,
    objective,
    project,
    status: 'active',
    milestones: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const MOCK_4_MILESTONE_RESPONSE = `
1. Add rate-limiter middleware — implement src/middleware/rate-limit.ts with sliding-window algorithm; wire into Express router; add unit tests covering burst rejection.
2. Implement JWT refresh tokens — extend src/auth/jwt.ts with refreshToken(oldToken) -> newToken; add integration tests; update token expiry config.
3. Add structured error responses — replace ad-hoc 500 throws in src/routes/*.ts with a central errorHandler(err, req, res, next) returning JSON {code, message, trace_id}.
4. Add request tracing — instrument src/app.ts with OpenTelemetry trace-id injection; propagate trace-id through all middleware; emit to console on error.
`.trim();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm223-'));
  _savedGoals = new Map();
  _activeGoals = [];
  _planningGoals = [];
  _clientNull = false;
  clearGoalPlannerCache();
  _completeImpl = vi.fn(async () => MOCK_4_MILESTONE_RESPONSE);
  vi.clearAllMocks();
  _completeImpl = vi.fn(async () => MOCK_4_MILESTONE_RESPONSE);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ============================================================================
// Suite 1 — planning-status goals are expanded by scanGoals
// ============================================================================

describe('M223 — scanGoals expands planning-status goals', () => {
  it('emits a WorkItem for a planning-status (0-milestone) goal after expansion', async () => {
    const goal = makePlanningGoal('goal-plan-1', 'Harden the authentication layer');
    _planningGoals = [goal];
    // Pre-seed savedGoals so loadGoal inside expandGoalToMilestones finds it
    _savedGoals.set(goal.id, structuredClone(goal));

    const items = await scanGoals(tmpDir, makeCfg());
    expect(items.length).toBeGreaterThanOrEqual(1);
    const goalItem = items.find((i) => i.source === 'goal');
    expect(goalItem).toBeDefined();
    expect(goalItem!.value).toBeGreaterThanOrEqual(4);
  });

  it('planning goal is persisted with milestones after scanGoals runs', async () => {
    const goal = makePlanningGoal('goal-plan-2', 'Improve observability layer');
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    await scanGoals(tmpDir, makeCfg());

    // saveGoal should have been called with milestones
    const { saveGoal } = await import('../src/core/goals/store.js');
    const calls = (saveGoal as ReturnType<typeof vi.fn>).mock.calls;
    const savedWithMilestones = calls.find(
      ([g]: [Goal]) => g.id === goal.id && g.milestones.length >= 3,
    );
    expect(savedWithMilestones).toBeDefined();
  });

  it('expanded planning goal has status active after expansion', async () => {
    const goal = makePlanningGoal('goal-plan-3', 'Add fleet observability');
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    // expandGoalToMilestones directly to check returned status
    const result = await expandGoalToMilestones(goal, makeCfg(), tmpDir);
    expect(result.status).toBe('active');
    expect(result.milestones.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================================
// Suite 2 — active-status goals still work (M222 regression guard)
// ============================================================================

describe('M223 — active-status 0-milestone goals still expanded (M222 regression)', () => {
  it('emits WorkItem for active 0-milestone goal', async () => {
    const goal = makeActiveGoalNoMilestones('goal-active-1', 'Ship rate-limiting feature');
    _activeGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    const items = await scanGoals(tmpDir, makeCfg());
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]!.source).toBe('goal');
  });
});

// ============================================================================
// Suite 3 — observability logs
// ============================================================================

describe('M223 — goal-planner observability', () => {
  it('logs [ashlr] goal-planner:info when expansion succeeds', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const goal = makePlanningGoal('goal-log-1', 'Add structured logging');
    _savedGoals.set(goal.id, structuredClone(goal));

    await expandGoalToMilestones(goal, makeCfg(), tmpDir);

    const infoLines = logSpy.mock.calls
      .flat()
      .filter((s): s is string => typeof s === 'string' && s.includes('[ashlr] goal-planner:info'));
    // Should see at least the "expanding" and "goal expanded" log lines
    expect(infoLines.some((l) => l.includes('expanding goal'))).toBe(true);
    expect(infoLines.some((l) => l.includes('goal expanded'))).toBe(true);
    logSpy.mockRestore();
  });

  it('logs [ashlr] goal-planner:warn when no frontier client', async () => {
    _clientNull = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goal = makePlanningGoal('goal-log-2', 'Fix NaN metrics');
    _savedGoals.set(goal.id, structuredClone(goal));

    await expandGoalToMilestones(goal, makeCfg(), tmpDir);

    const warnLines = warnSpy.mock.calls
      .flat()
      .filter((s): s is string => typeof s === 'string' && s.includes('[ashlr] goal-planner:warn'));
    expect(warnLines.some((l) => l.includes('no frontier client'))).toBe(true);
    warnSpy.mockRestore();
  });
});

// ============================================================================
// Suite 4 — dedup: planning goal not double-expanded in same tick
// ============================================================================

describe('M223 — in-process cache prevents double expansion', () => {
  it('expands each goal at most once per tick even if it appears in both active + planning lists', async () => {
    // Simulate a goal in both lists (shouldn't happen in practice, but guards the cache)
    const goal = makePlanningGoal('goal-dedup-1', 'Dedup test goal');
    _activeGoals = [{ ...goal, status: 'active' }];
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    await scanGoals(tmpDir, makeCfg());

    // completeImpl should be called at most once
    expect(_completeImpl.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

// ============================================================================
// Suite 5 — repo scoping: scanGoals only emits work for this repo
// ============================================================================

describe('M223 — scanGoals respects goal project scope', () => {
  it('does not emit or expand projectless planning goals', async () => {
    const goal = makePlanningGoal('goal-projectless-1', 'Projectless planning goal', null);
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    const items = await scanGoals(tmpDir, makeCfg());

    expect(items.filter((i) => i.source === 'goal')).toHaveLength(0);
    expect(_completeImpl).not.toHaveBeenCalled();
  });

  it('does not emit or expand goals bound to a different repo', async () => {
    const otherRepo = path.join(os.tmpdir(), 'ashlr-other-repo');
    const goal = makePlanningGoal('goal-other-repo-1', 'Other repo goal', otherRepo);
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    const items = await scanGoals(tmpDir, makeCfg());

    expect(items.filter((i) => i.source === 'goal')).toHaveLength(0);
    expect(_completeImpl).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Suite 6 — flag-off: goalPlanning:false → planning goals not expanded
// ============================================================================

describe('M223 — goalPlanning:false disables expansion for planning goals', () => {
  it('returns [] for a planning goal when goalPlanning flag is off', async () => {
    const goal = makePlanningGoal('goal-flag-1', 'Flag-off test');
    _planningGoals = [goal];
    _savedGoals.set(goal.id, structuredClone(goal));

    const items = await scanGoals(tmpDir, makeCfg({ goalPlanning: false }));
    // With flag off, expandGoalToMilestones is a no-op, goal stays 0-milestones
    // → no WorkItem emitted (no actionable milestone)
    const goalItems = items.filter((i) => i.source === 'goal');
    expect(goalItems.length).toBe(0);
  });
});
