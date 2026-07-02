/**
 * M222 — Goal-planner tests.
 *
 * Verifies four properties:
 *
 *  1. EXPANSION: a goal with 0 milestones + a mock 4-milestone strategist
 *     response → expandGoalToMilestones persists the milestones and
 *     scanGoals emits a substantive next-step WorkItem (source:'goal',
 *     value≥4).
 *
 *  2. RESILIENCE: when the strategist throws, expandGoalToMilestones
 *     returns the original goal unchanged and does NOT rethrow.
 *
 *  3. FLAG-OFF PARITY: cfg.foundry.goalPlanning === false → scanGoals
 *     emits [] for a goal with 0 milestones (byte-identical to pre-M222).
 *
 *  4. NO-OP WHEN MILESTONES PRESENT: a goal that already has milestones
 *     is not re-expanded.
 *
 * Hermetic: tmp HOME + mocked manager + mocked goals store.
 * vi.mock() at module top level (vitest hoists these correctly).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================================
// ── Mock fleet/manager (frontier client) ─────────────────────────────────────
// ============================================================================

let _completeImpl: ReturnType<typeof vi.fn>;

vi.mock('../src/core/fleet/manager.js', () => ({
  resolveFrontierJudgeClient: vi.fn((cfg: unknown) => {
    void cfg;
    return {
      complete: (...args: unknown[]) => (_completeImpl as (...a: unknown[]) => unknown)(...args),
      model: 'mock-frontier',
    };
  }),
}));

// ============================================================================
// ── Mock goals store ──────────────────────────────────────────────────────────
// ============================================================================

// We need to intercept saveGoal to verify persistence without touching disk.
let _savedGoals: Map<string, import('../src/core/types.js').Goal>;

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
    listGoals: vi.fn(() => []),
    goalsDir: vi.fn(() => path.join(os.tmpdir(), 'm222-goals')),
  };
});

// ============================================================================
// ── Mock github integration (needed transitively by scanners) ─────────────────
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
import { listGoals } from '../src/core/goals/store.js';

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

function makeActiveGoalWithMilestone(id: string, objective: string, project: string | null = tmpDir): Goal {
  return {
    id,
    objective,
    project,
    status: 'active',
    milestones: [
      {
        id: `${id}-m0`,
        title: 'Existing milestone',
        detail: 'Already planned.',
        order: 0,
        status: 'pending',
        specId: null,
        swarmId: null,
        proposalId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** A well-formed 4-milestone strategist response */
const MOCK_4_MILESTONE_RESPONSE = `
1. Add rate-limiter middleware — implement src/middleware/rate-limit.ts with sliding-window algorithm; wire into Express router; add unit tests covering burst rejection.
2. Implement JWT refresh tokens — extend src/auth/jwt.ts with refreshToken(oldToken) -> newToken; add integration tests; update token expiry config.
3. Add structured error responses — replace ad-hoc 500 throws in src/routes/*.ts with a central errorHandler(err, req, res, next) returning JSON {code, message, trace_id}.
4. Add request tracing — instrument src/app.ts with OpenTelemetry trace-id injection; propagate trace-id through all middleware; emit to console on error.
`.trim();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm222-'));
  _savedGoals = new Map();
  clearGoalPlannerCache();

  // Default: 4-milestone response
  _completeImpl = vi.fn(async (_system: unknown, _user: unknown) => MOCK_4_MILESTONE_RESPONSE);

  vi.clearAllMocks();
  // Re-set complete after clearAllMocks
  _completeImpl = vi.fn(async (_system: unknown, _user: unknown) => MOCK_4_MILESTONE_RESPONSE);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ============================================================================
// Suite 1 — expandGoalToMilestones: basic expansion
// ============================================================================

describe('M222 — expandGoalToMilestones: basic expansion', () => {
  it('expands a 0-milestone goal into milestones when strategist returns valid response', async () => {
    const goal = makeActiveGoalNoMilestones('goal-auth', 'Harden the authentication layer');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(result.milestones.length).toBeGreaterThanOrEqual(3);
    expect(result.milestones.length).toBeLessThanOrEqual(6);
  });

  it('expanded milestones all have status "pending"', async () => {
    const goal = makeActiveGoalNoMilestones('goal-auth2', 'Harden the authentication layer');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    for (const m of result.milestones) {
      expect(m.status).toBe('pending');
    }
  });

  it('expanded milestones have non-empty title and detail', async () => {
    const goal = makeActiveGoalNoMilestones('goal-auth3', 'Harden the authentication layer');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    for (const m of result.milestones) {
      expect(m.title.trim().length).toBeGreaterThan(0);
      expect(m.detail.trim().length).toBeGreaterThan(0);
    }
  });

  it('calls saveGoal to persist the expanded milestones', async () => {
    const { saveGoal } = await import('../src/core/goals/store.js');
    const goal = makeActiveGoalNoMilestones('goal-auth4', 'Harden the authentication layer');
    // Pre-populate _savedGoals so loadGoal returns the goal
    _savedGoals.set(goal.id, structuredClone(goal));
    const cfg = makeCfg();
    await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(saveGoal).toHaveBeenCalled();
  });

  it('updated goal has status "active" after expansion', async () => {
    const goal = makeActiveGoalNoMilestones('goal-auth5', 'Harden the authentication layer');
    _savedGoals.set(goal.id, structuredClone(goal));
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(result.status).toBe('active');
  });
});

// ============================================================================
// Suite 2 — expandGoalToMilestones: resilience / error paths
// ============================================================================

describe('M222 — expandGoalToMilestones: resilience', () => {
  it('returns original goal unchanged when strategist throws', async () => {
    _completeImpl = vi.fn(async () => { throw new Error('network error'); });
    const goal = makeActiveGoalNoMilestones('goal-err', 'Fix the data pipeline');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    // Goal is unchanged — still has no milestones
    expect(result.milestones).toHaveLength(0);
  });

  it('does NOT throw when strategist throws', async () => {
    _completeImpl = vi.fn(async () => { throw new Error('timeout'); });
    const goal = makeActiveGoalNoMilestones('goal-err2', 'Fix the data pipeline');
    const cfg = makeCfg();
    await expect(expandGoalToMilestones(goal, cfg, tmpDir)).resolves.toBeDefined();
  });

  it('returns original goal when strategist returns unparseable response', async () => {
    _completeImpl = vi.fn(async () => 'no milestones here at all');
    const goal = makeActiveGoalNoMilestones('goal-unparse', 'Fix the data pipeline');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(result.milestones).toHaveLength(0);
  });

  it('does NOT re-expand a goal that already has milestones', async () => {
    const goal = makeActiveGoalWithMilestone('goal-has-ms', 'Already planned goal');
    const cfg = makeCfg();
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(result.milestones).toHaveLength(1); // unchanged
    expect(_completeImpl).not.toHaveBeenCalled();
  });

  it('in-process cache: only calls strategist once for the same goal id', async () => {
    const goal = makeActiveGoalNoMilestones('goal-cached', 'Goal to cache');
    _savedGoals.set(goal.id, structuredClone(goal));
    const cfg = makeCfg();
    await expandGoalToMilestones(goal, cfg, tmpDir);
    await expandGoalToMilestones(goal, cfg, tmpDir); // second call
    expect(_completeImpl).toHaveBeenCalledTimes(1);
  });

  it('clearGoalPlannerCache allows re-expansion on next tick', async () => {
    const goal = makeActiveGoalNoMilestones('goal-recache', 'Goal to recache');
    _savedGoals.set(goal.id, structuredClone(goal));
    const cfg = makeCfg();
    await expandGoalToMilestones(goal, cfg, tmpDir);
    clearGoalPlannerCache();
    // Reset saved so loadGoal returns fresh
    _savedGoals.set(goal.id, structuredClone({ ...goal, milestones: [] }));
    await expandGoalToMilestones({ ...goal, milestones: [] }, cfg, tmpDir);
    expect(_completeImpl).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Suite 3 — FLAG-OFF PARITY: goalPlanning === false
// ============================================================================

describe('M222 — flag-off parity: goalPlanning === false', () => {
  it('expandGoalToMilestones is a no-op when goalPlanning === false', async () => {
    const goal = makeActiveGoalNoMilestones('goal-flagoff', 'Should not expand');
    const cfg = makeCfg({ goalPlanning: false });
    const result = await expandGoalToMilestones(goal, cfg, tmpDir);
    expect(result.milestones).toHaveLength(0);
    expect(_completeImpl).not.toHaveBeenCalled();
  });

  it('scanGoals emits [] for a 0-milestone goal when goalPlanning === false', async () => {
    const goal = makeActiveGoalNoMilestones('goal-scanflagoff', 'No milestones, flag off');
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: false });
    const items = await scanGoals(tmpDir, cfg);
    expect(items).toHaveLength(0);
  });

  it('scanGoals emits [] for 0-milestone goal when no cfg passed (legacy path)', async () => {
    const goal = makeActiveGoalNoMilestones('goal-nocfg', 'No milestones, no cfg');
    vi.mocked(listGoals).mockReturnValue([goal]);
    // No cfg → expansion guard: _cfg is undefined → expansion skipped
    const items = await scanGoals(tmpDir, undefined);
    expect(items).toHaveLength(0);
  });
});

// ============================================================================
// Suite 4 — scanGoals wiring: emits substantive item after expansion
// ============================================================================

describe('M222 — scanGoals wiring: expansion → value≥4 WorkItem', () => {
  it('scanGoals emits a WorkItem after expanding a 0-milestone goal', async () => {
    clearGoalPlannerCache();
    const goal = makeActiveGoalNoMilestones('goal-wire', 'Add structured tracing to the fleet');
    // expandGoalToMilestones will be called; we need loadGoal to return the goal
    _savedGoals.set(goal.id, structuredClone(goal));
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    const items = await scanGoals(tmpDir, cfg);
    // After expansion the goal gets milestones → scanGoals emits one item
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('emitted WorkItem has source "goal"', async () => {
    clearGoalPlannerCache();
    const goal = makeActiveGoalNoMilestones('goal-wire2', 'Add structured tracing to the fleet');
    _savedGoals.set(goal.id, structuredClone(goal));
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    const items = await scanGoals(tmpDir, cfg);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.source).toBe('goal');
  });

  it('emitted WorkItem has value ≥ 4', async () => {
    clearGoalPlannerCache();
    const goal = makeActiveGoalNoMilestones('goal-wire3', 'Add structured tracing to the fleet');
    _savedGoals.set(goal.id, structuredClone(goal));
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    const items = await scanGoals(tmpDir, cfg);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.value).toBeGreaterThanOrEqual(4);
  });

  it('scanGoals still emits for goal that already has milestones (unchanged path)', async () => {
    clearGoalPlannerCache();
    const goal = makeActiveGoalWithMilestone('goal-already', 'Has a real milestone');
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    const items = await scanGoals(tmpDir, cfg);
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('goal');
  });

  it('scanGoals emits [] for a projectless goal even when it has milestones', async () => {
    clearGoalPlannerCache();
    const goal = makeActiveGoalWithMilestone('goal-projectless', 'Projectless goal', null);
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    const items = await scanGoals(tmpDir, cfg);
    expect(items).toHaveLength(0);
  });

  it('scanGoals never throws when expansion throws internally', async () => {
    clearGoalPlannerCache();
    _completeImpl = vi.fn(async () => { throw new Error('frontier down'); });
    const goal = makeActiveGoalNoMilestones('goal-throw', 'Expansion throws');
    _savedGoals.set(goal.id, structuredClone(goal));
    vi.mocked(listGoals).mockReturnValue([goal]);
    const cfg = makeCfg({ goalPlanning: true });
    // scanGoals wraps everything in try/catch → must resolve to []
    await expect(scanGoals(tmpDir, cfg)).resolves.toEqual([]);
  });
});
