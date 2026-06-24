/**
 * M84 — `ashlr goal --direct` mode.
 *
 * Asserts that --direct:
 *  1. Skips milestone planning entirely and invokes runGoal exactly once with
 *     the verbatim objective + sandboxEngine:true + requireSandbox:true (the
 *     same frontier sandboxed path the daemon uses for non-builtin backends).
 *  2. Requires --project; errors clearly (exit 2) when absent.
 *  3. Correlates the proposal via listProposals (origin:'agent', repo, newly-
 *     filed) — the same pattern as findProposalForSwarm in advance.ts.
 *  4. Leaves the default (no --direct) path unchanged — it still creates a goal,
 *     plans milestones, and advances via cmdGoals.
 *
 * Everything outward (runGoal, routeBackend, assertMayMutate, inbox, config,
 * cmdGoals, listGoals store) is MOCKED — no real ~/.ashlr, no real engine runs.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the module-under-test is imported.
// ---------------------------------------------------------------------------

const mockRunGoal = vi.fn();
const mockRouteBackend = vi.fn();
const mockAssertMayMutate = vi.fn();
const mockListProposals = vi.fn();
const mockLoadConfig = vi.fn();
const mockCmdGoals = vi.fn();
const mockListGoals = vi.fn();

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
}));

vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: (...args: unknown[]) => mockAssertMayMutate(...args),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
}));

vi.mock('../src/core/config.js', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

// cmdGoal dynamically imports './goals.js' and '../core/goals/store.js' on the
// non-direct path; mock both so the default-path tests are hermetic.
vi.mock('../src/cli/goals.js', () => ({
  cmdGoals: (...args: unknown[]) => mockCmdGoals(...args),
}));

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: (...args: unknown[]) => mockListGoals(...args),
  // other store exports referenced by goals.ts internals — stubs only:
  loadGoal: vi.fn(),
  createGoal: vi.fn(),
  updateMilestoneStatus: vi.fn(),
  addMilestone: vi.fn(),
  clearMilestones: vi.fn(),
  deleteGoal: vi.fn(),
  reorderMilestones: vi.fn(),
  pauseMilestone: vi.fn(),
  resumeMilestone: vi.fn(),
  skipMilestone: vi.fn(),
}));

// Lazy import AFTER mocks are registered.
import { cmdGoal } from '../src/cli/goal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(): AshlrConfig {
  return { version: 1 } as AshlrConfig;
}

function makeRunState(id = 'run-direct-1') {
  return { id, status: 'done' };
}

function makeProposal(id = 'prop-direct-1', repo = '/tmp/enrolled-repo') {
  return { id, origin: 'agent', repo, status: 'pending' };
}

// Suppress console.log noise in tests.
const originalLog = console.log;
const originalError = console.error;
const originalStderr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  console.log = vi.fn();
  console.error = vi.fn();
  process.stderr.write = vi.fn() as typeof process.stderr.write;

  mockRunGoal.mockReset();
  mockRouteBackend.mockReset();
  mockAssertMayMutate.mockReset();
  mockListProposals.mockReset();
  mockLoadConfig.mockReset();
  mockCmdGoals.mockReset();
  mockListGoals.mockReset();

  // Sensible defaults.
  mockAssertMayMutate.mockImplementation(() => { /* enrolled, allowed */ });
  mockLoadConfig.mockReturnValue(makeCfg());
  mockRouteBackend.mockReturnValue({ backend: 'codex', tier: 'frontier', reason: 'frontier-first' });
  mockRunGoal.mockResolvedValue(makeRunState());
  // First call (pendingBefore snapshot) returns []; second call (post-run) returns [proposal].
  mockListProposals
    .mockReturnValueOnce([])
    .mockReturnValue([makeProposal()]);

  // Default-path: cmdGoals always succeeds; listGoals returns a goal so the
  // conductor can resolve it after creation.
  mockCmdGoals.mockResolvedValue(0);
  mockListGoals.mockReturnValue([
    {
      id: 'goal-default-1',
      objective: 'build something',
      project: '/tmp/enrolled-repo',
      status: 'active',
      milestones: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);
});

// Restore after suite.
afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  process.stderr.write = originalStderr;
});

// ---------------------------------------------------------------------------
// --direct: single run, verbatim objective.
// ---------------------------------------------------------------------------

describe('cmdGoal --direct — invokes runGoal once with the verbatim objective', () => {
  it('calls runGoal exactly once with sandboxEngine:true + requireSandbox:true', async () => {
    const rc = await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(rc).toBe(0);
    expect(mockRunGoal).toHaveBeenCalledTimes(1);

    const opts = mockRunGoal.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.sandboxEngine).toBe(true);
    expect(opts.requireSandbox).toBe(true);
  });

  it('passes the verbatim objective as the goal string (not a decomposed milestone title)', async () => {
    const objective = 'create docs/FOO.md with one line';
    await cmdGoal([objective, '--project', '/tmp/enrolled-repo', '--direct']);

    const goalArg = mockRunGoal.mock.calls[0]![0] as string;
    expect(goalArg).toBe(objective);
  });

  it('resolves the project path and passes it as cwd', async () => {
    await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    const opts = mockRunGoal.mock.calls[0]![2] as Record<string, unknown>;
    expect(typeof opts.cwd).toBe('string');
    expect((opts.cwd as string).endsWith('enrolled-repo')).toBe(true);
  });

  it('skips milestone planning — cmdGoals is never called', async () => {
    await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(mockCmdGoals).not.toHaveBeenCalled();
  });

  it('routes via routeBackend and passes the chosen backend as engine', async () => {
    mockRouteBackend.mockReturnValue({ backend: 'claude', tier: 'frontier', reason: 'frontier-first' });
    mockListProposals.mockReturnValueOnce([]).mockReturnValue([makeProposal()]);

    await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    const opts = mockRunGoal.mock.calls[0]![2] as Record<string, unknown>;
    expect(opts.engine).toBe('claude');
  });

  it('honors --allow-cloud: propagates it to the runGoal budget', async () => {
    await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
      '--allow-cloud',
    ]);

    const opts = mockRunGoal.mock.calls[0]![2] as Record<string, unknown>;
    const budget = opts.budget as { allowCloud: boolean };
    expect(budget.allowCloud).toBe(true);
  });

  it('returns exit 0 when a new PENDING agent proposal is found after the run', async () => {
    // beforeEach default: first listProposals call returns [] (pendingBefore snapshot),
    // second call returns [makeProposal()] (post-run) — a new agent proposal for the repo.
    const rc = await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(rc).toBe(0);
  });

  it('returns exit 1 when no new PENDING proposal is found (engine produced no diff)', async () => {
    // Both calls return the same empty list — no new proposals.
    mockListProposals.mockReturnValue([]);

    const rc = await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(rc).toBe(1);
  });

  it('checks assertMayMutate BEFORE runGoal (enrollment gate is respected)', async () => {
    const order: string[] = [];
    mockAssertMayMutate.mockImplementation(() => { order.push('gate'); });
    mockRunGoal.mockImplementation(async () => { order.push('run'); return makeRunState(); });

    await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(order).toEqual(['gate', 'run']);
  });

  it('returns exit 1 when assertMayMutate throws (non-enrolled repo)', async () => {
    mockAssertMayMutate.mockImplementation(() => {
      throw new Error('repo not enrolled for autonomous work: /tmp/enrolled-repo');
    });

    const rc = await cmdGoal([
      'create docs/FOO.md with one line',
      '--project', '/tmp/enrolled-repo',
      '--direct',
    ]);

    expect(rc).toBe(1);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// --direct without --project: clear error.
// ---------------------------------------------------------------------------

describe('cmdGoal --direct — requires --project', () => {
  it('returns exit 2 with a clear error when --project is absent', async () => {
    const rc = await cmdGoal(['create docs/FOO.md with one line', '--direct']);

    expect(rc).toBe(2);
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('error message mentions --project', async () => {
    await cmdGoal(['create docs/FOO.md with one line', '--direct']);

    const stderrWrite = process.stderr.write as ReturnType<typeof vi.fn>;
    const allOutput = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(allOutput).toMatch(/--project/);
  });
});

// ---------------------------------------------------------------------------
// Default path (no --direct): milestone planning still runs.
// ---------------------------------------------------------------------------

describe('cmdGoal default (no --direct) — milestone planning still runs', () => {
  it('calls cmdGoals for add + plan + advance (no runGoal directly)', async () => {
    const rc = await cmdGoal(['build something', '--project', '/tmp/enrolled-repo']);

    expect(rc).toBe(0);
    // cmdGoals is called at least 3 times: add, plan, advance.
    expect(mockCmdGoals).toHaveBeenCalledTimes(3);
    // runGoal is NEVER called directly from cmdGoal on the default path.
    expect(mockRunGoal).not.toHaveBeenCalled();
  });

  it('calls cmdGoals("add", ...) first', async () => {
    await cmdGoal(['build something', '--project', '/tmp/enrolled-repo']);

    const firstCall = mockCmdGoals.mock.calls[0] as string[][];
    expect(firstCall[0]).toContain('add');
  });

  it('calls cmdGoals("plan", ...) second', async () => {
    await cmdGoal(['build something', '--project', '/tmp/enrolled-repo']);

    const secondCall = mockCmdGoals.mock.calls[1] as string[][];
    expect(secondCall[0]).toContain('plan');
  });

  it('calls cmdGoals("advance", ...) third', async () => {
    await cmdGoal(['build something', '--project', '/tmp/enrolled-repo']);

    const thirdCall = mockCmdGoals.mock.calls[2] as string[][];
    expect(thirdCall[0]).toContain('advance');
  });
});

// ---------------------------------------------------------------------------
// Early-return paths (from M55 conductor suite — regression guard).
// ---------------------------------------------------------------------------

describe('cmdGoal early-return paths (regression)', () => {
  it('returns 2 when no objective given', async () => {
    expect(await cmdGoal([])).toBe(2);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockCmdGoals).not.toHaveBeenCalled();
  });

  it('returns 0 for --help', async () => {
    expect(await cmdGoal(['--help'])).toBe(0);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockCmdGoals).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source-level safety guard — goal.ts carries NO outward-mutation primitive.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOAL_SRC = readFileSync(pathResolve(HERE, '../src/cli/goal.ts'), 'utf8');

const OUTWARD_PRIMITIVES: RegExp[] = [
  /applyProposal/,
  /inbox\/apply/,
  /git\s+push/,
  /gh\s+pr\s+create/,
  /createPr\b/,
  /mergeProposal/,
  /autoMerge\s*\(/,
  /ship-deploy|shipDeploy|startShip\b/,
];

describe('goal.ts source-level safety guard (M84)', () => {
  for (const re of OUTWARD_PRIMITIVES) {
    it(`goal.ts does not contain ${re}`, () => {
      expect(re.test(GOAL_SRC), `goal.ts unexpectedly matched ${re}`).toBe(false);
    });
  }

  it('every runGoal( call in goal.ts uses sandboxEngine:true AND requireSandbox:true', () => {
    const calls = GOAL_SRC.match(/runGoal\s*\(([\s\S]*?)\}\s*\)/g) ?? [];
    const realCalls = calls.filter((c) => /sandboxEngine/.test(c));
    expect(realCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of realCalls) {
      expect(call).toMatch(/sandboxEngine:\s*true/);
      expect(call).toMatch(/requireSandbox:\s*true/);
    }
  });

  it('goal.ts does not call runSwarm directly', () => {
    // runSwarm is the builtin path that hard-forces engine:'builtin' and
    // produces 0-diff proposals. --direct must NOT use it.
    expect(GOAL_SRC).not.toMatch(/\brunSwarm\s*\(/);
  });
});
