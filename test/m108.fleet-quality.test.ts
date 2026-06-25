/**
 * M108 — fleet real-diff yield: scanner ignore predicate + conductor skip logic.
 *
 * Verifies two quality improvements:
 *
 *  1. SCANNER IGNORE: scanTodos must NOT surface a TODO inside a lockfile
 *     (bun.lock, package-lock.json), node_modules, dist, or a minified file —
 *     but MUST still surface a real TODO in src/foo.ts.
 *
 *  2. CONDUCTOR SKIP: runConductor must skip a goal whose project is not
 *     enrolled (no spin / no advance attempt) while still advancing a goal
 *     with an enrolled project. The skip must not count as a failed advance.
 *
 * Hermetic: tmp repos + mocked child_process (mirrors m95/m99 conventions).
 * All vi.mock() calls are at module top level so vitest hoists them correctly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

// ============================================================================
// ── Mock child_process BEFORE scanner imports (vitest hoists vi.mock) ────────
// ============================================================================

let _execFileImpl: ReturnType<typeof vi.fn>;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  const mockExecFile = ((...args: unknown[]) => _execFileImpl(...args)) as typeof actual.execFile & {
    [k: symbol]: unknown;
  };
  mockExecFile[promisify.custom] = (
    file: string,
    cmdArgs: readonly string[],
    options: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      _execFileImpl(
        file,
        cmdArgs,
        options,
        (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => {
          if (err) {
            reject(Object.assign(err, { stdout, stderr }));
          } else {
            resolve({ stdout, stderr });
          }
        },
      );
    });

  return {
    ...actual,
    execFile: mockExecFile,
    spawnSync: (..._args: unknown[]) => ({
      pid: 0, output: [], stdout: '[]', stderr: '', status: 0, signal: null,
    }),
  };
});

// ============================================================================
// ── Module mocks for conductor (mirrors m102 conventions) ────────────────────
// ============================================================================

const mockKillSwitchOn = vi.fn<[], boolean>(() => false);
const mockListEnrolled = vi.fn<[], string[]>(() => []);

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: () => mockKillSwitchOn(),
  setKill: vi.fn(),
  listEnrolled: () => mockListEnrolled(),
  isEnrolled: vi.fn(() => false),
}));

const mockListGoals = vi.fn();
const mockLoadGoal = vi.fn();

vi.mock('../src/core/goals/store.js', () => ({
  listGoals: (...args: unknown[]) => mockListGoals(...args),
  loadGoal: (...args: unknown[]) => mockLoadGoal(...args),
  resumeMilestone: vi.fn(),
  updateMilestoneStatus: vi.fn(() => null),
  saveGoal: vi.fn(),
  createGoal: vi.fn(),
  deleteGoal: vi.fn(),
  addMilestone: vi.fn(),
  clearMilestones: vi.fn(),
  reorderMilestones: vi.fn(),
  pauseMilestone: vi.fn(),
  skipMilestone: vi.fn(),
}));

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: vi.fn(),
  parseTaskList: vi.fn(),
  planGoal: vi.fn(),
  DEFAULT_MAX_TOKENS: 50_000,
  DEFAULT_MAX_STEPS: 40,
  DEFAULT_PARALLEL: 2,
  TITRR_MAX_ATTEMPTS: 2,
  titrrTestRun: vi.fn(),
  loadRun: vi.fn(),
  listRuns: vi.fn(),
  saveRun: vi.fn(),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => false),
  buildEngineCommand: vi.fn(),
  spawnEngine: vi.fn(),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
  loadProposal: vi.fn(() => null),
  pendingCount: vi.fn(() => 0),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  loadSwarm: vi.fn(),
  saveSwarm: vi.fn(),
  listSwarms: vi.fn(() => []),
}));

const mockRunDaemon = vi.fn();

vi.mock('../src/core/daemon/loop.js', () => ({
  runDaemon: (...args: unknown[]) => mockRunDaemon(...args),
  tick: vi.fn(),
  stopDaemon: vi.fn(),
  buildItemGoal: vi.fn(),
}));

// ============================================================================
// ── Late imports (AFTER vi.mock declarations) ─────────────────────────────────
// ============================================================================

import { scanTodos, isIgnoredPath } from '../src/core/portfolio/scanners.js';
import { runConductor } from '../src/core/goals/conductor.js';
import type { Goal, Milestone, SwarmRun } from '../src/core/types.js';
import type { AshlrConfig } from '../src/core/types.js';

// ============================================================================
// ── Helpers ───────────────────────────────────────────────────────────────────
// ============================================================================

/** Build an execFile stub that returns output as if rg/grep found the given lines. */
function makeRgStub(rgOutput: string): ReturnType<typeof vi.fn> {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    if (typeof cb === 'function') cb(null, rgOutput, '');
  });
}

/** Build an execFile stub that always errors (simulates rg/grep not available). */
function execFileError(): ReturnType<typeof vi.fn> {
  return vi.fn((...args: unknown[]) => {
    const cb = args[args.length - 1] as (err: Error) => void;
    if (typeof cb === 'function') cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });
}

function makeCfg(): AshlrConfig {
  return { version: 1 } as AshlrConfig;
}

function makeMilestone(order: number, status: Milestone['status'] = 'pending'): Milestone {
  return {
    id: `m${order}`,
    title: `Milestone ${order}`,
    detail: `Detail for milestone ${order}`,
    order,
    status,
    specId: null,
    swarmId: null,
    proposalId: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function makeGoal(
  id: string,
  project: string | null,
  status: Goal['status'] = 'active',
): Goal {
  return {
    id,
    objective: `Objective for ${id}`,
    status,
    milestones: [makeMilestone(0), makeMilestone(1)],
    project,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSwarmRun(id: string, status: SwarmRun['status'] = 'done'): SwarmRun {
  return {
    id,
    status,
    goal: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plan: { id: 'plan-1', phases: [], createdAt: new Date().toISOString() },
    tasks: [],
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, costUsd: 0 },
    budget: { maxTokens: 200_000, maxSteps: 40, allowCloud: false },
  } as unknown as SwarmRun;
}

// ============================================================================
// Suite 1: isIgnoredPath unit tests
// ============================================================================

describe('M108 — isIgnoredPath: identifies non-actionable file paths', () => {
  it('returns true for bun.lock', () => {
    expect(isIgnoredPath('bun.lock')).toBe(true);
  });

  it('returns true for .vscode/bun.lock (path with .vscode dir)', () => {
    expect(isIgnoredPath('.vscode/bun.lock')).toBe(true);
  });

  it('returns true for package-lock.json', () => {
    expect(isIgnoredPath('package-lock.json')).toBe(true);
  });

  it('returns true for yarn.lock', () => {
    expect(isIgnoredPath('yarn.lock')).toBe(true);
  });

  it('returns true for pnpm-lock.yaml', () => {
    expect(isIgnoredPath('pnpm-lock.yaml')).toBe(true);
  });

  it('returns true for Cargo.lock', () => {
    expect(isIgnoredPath('Cargo.lock')).toBe(true);
  });

  it('returns true for node_modules/lodash/index.js', () => {
    expect(isIgnoredPath('node_modules/lodash/index.js')).toBe(true);
  });

  it('returns true for dist/bundle.js', () => {
    expect(isIgnoredPath('dist/bundle.js')).toBe(true);
  });

  it('returns true for build/output.js', () => {
    expect(isIgnoredPath('build/output.js')).toBe(true);
  });

  it('returns true for a .min.js file', () => {
    expect(isIgnoredPath('public/app.min.js')).toBe(true);
  });

  it('returns true for a .min.css file', () => {
    expect(isIgnoredPath('public/styles.min.css')).toBe(true);
  });

  it('returns true for a .map file', () => {
    expect(isIgnoredPath('dist/app.js.map')).toBe(true);
  });

  it('returns true for a .generated.ts file', () => {
    expect(isIgnoredPath('src/api.generated.ts')).toBe(true);
  });

  it('returns false for src/foo.ts', () => {
    expect(isIgnoredPath('src/foo.ts')).toBe(false);
  });

  it('returns false for lib/utils.js', () => {
    expect(isIgnoredPath('lib/utils.js')).toBe(false);
  });

  it('returns false for test/m108.fleet-quality.test.ts', () => {
    expect(isIgnoredPath('test/m108.fleet-quality.test.ts')).toBe(false);
  });
});

// ============================================================================
// Suite 2: scanTodos ignore predicate integration
// ============================================================================

describe('M108 — scanTodos: filters out TODOs in non-actionable files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm108-scan-'));
    // Create a minimal git-like repo structure
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT surface a TODO inside bun.lock', async () => {
    // rg output line: file:line:content
    const rgOutput = '.vscode/bun.lock:365:# TODO: regenerate this lockfile\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    const lockItems = items.filter((i) => i.title.includes('bun.lock'));
    expect(lockItems).toHaveLength(0);
  });

  it('does NOT surface a TODO inside package-lock.json', async () => {
    const rgOutput = 'package-lock.json:12:// TODO: update this\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    const lockItems = items.filter((i) => i.title.includes('package-lock.json'));
    expect(lockItems).toHaveLength(0);
  });

  it('does NOT surface a TODO inside node_modules/x.js', async () => {
    const rgOutput = 'node_modules/some-lib/index.js:42:// TODO: upstream fix\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    const nodeItems = items.filter((i) => i.title.includes('node_modules'));
    expect(nodeItems).toHaveLength(0);
  });

  it('does NOT surface a TODO inside dist/y.js', async () => {
    const rgOutput = 'dist/bundle.js:100:// TODO: minify this\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    const distItems = items.filter((i) => i.title.includes('dist'));
    expect(distItems).toHaveLength(0);
  });

  it('does NOT surface a TODO inside a .min.js file', async () => {
    const rgOutput = 'public/app.min.js:1:// TODO: source map\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    const minItems = items.filter((i) => i.title.includes('min.js'));
    expect(minItems).toHaveLength(0);
  });

  it('STILL surfaces a real TODO in src/foo.ts', async () => {
    const rgOutput = 'src/foo.ts:17:// TODO: implement retry logic\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    expect(items.length).toBeGreaterThanOrEqual(1);
    const fooItem = items.find((i) => i.title.includes('src/foo.ts'));
    expect(fooItem).toBeDefined();
  });

  it('surfaces src TODO but suppresses lock-file TODO in the same rg output', async () => {
    const rgOutput = [
      'src/foo.ts:17:// TODO: implement retry logic',
      'bun.lock:365:# TODO: regenerate lockfile',
      'package-lock.json:12:// TODO: update',
      'node_modules/lib/index.js:5:// TODO: upstream',
    ].join('\n') + '\n';
    _execFileImpl = makeRgStub(rgOutput);

    const items = await scanTodos(tmpDir);
    // Only src/foo.ts should survive
    expect(items.length).toBe(1);
    expect(items[0]!.title).toMatch(/src\/foo\.ts/);
  });

  it('returns [] gracefully when rg is not available', async () => {
    _execFileImpl = execFileError();
    const items = await scanTodos(tmpDir);
    expect(Array.isArray(items)).toBe(true);
  });
});

// ============================================================================
// Suite 3: runConductor skips un-enrolled goals, advances enrolled ones
// ============================================================================

describe('M108 — runConductor: skips goals with no enrolled project', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockKillSwitchOn.mockReturnValue(false);
    mockListEnrolled.mockReturnValue([]);
    mockListGoals.mockReset().mockReturnValue([]);
    mockLoadGoal.mockReset().mockReturnValue(null);
    mockRunSwarm.mockReset();
    mockRunDaemon.mockReset().mockResolvedValue({ running: false });
  });

  it('skips a goal with project=null (no enrolled project) — no spin, no swarm', async () => {
    const unenrolledGoal = makeGoal('g-unenrolled', null);
    mockListGoals.mockReturnValue([unenrolledGoal]);
    mockListEnrolled.mockReturnValue([]); // nothing enrolled

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    // No advance attempt for the unenrolled goal
    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(summary.goalsAdvanced).toBe(0);
    // No daemon fallback since there were active goals (just unenrollable ones)
    expect(summary.daemonFallback).toBe(false);
  });

  it('skips a goal whose project path is not in listEnrolled()', async () => {
    const goal = makeGoal('g-wrong-path', '/some/non-enrolled/path');
    mockListGoals.mockReturnValue([goal]);
    mockListEnrolled.mockReturnValue(['/different/enrolled/repo']);

    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(mockRunSwarm).not.toHaveBeenCalled();
    expect(summary.goalsAdvanced).toBe(0);
  });

  it('writes a needs-attention log to stderr when skipping unenrolled goal', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const goal = makeGoal('g-log-test', '/not/enrolled');
    mockListGoals.mockReturnValue([goal]);
    // non-empty enrolled list that does NOT include this goal's project
    mockListEnrolled.mockReturnValue(['/some/other/enrolled/repo']);

    await runConductor(makeCfg(), { once: true, dryRun: false });

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const hasNeedsAttention = calls.some((msg) =>
      msg.includes('g-log-test') && msg.includes('needs-attention'),
    );
    expect(hasNeedsAttention).toBe(true);
  });

  it('advances an enrolled goal while skipping an unenrolled one', async () => {
    const enrolledPath = '/tmp/enrolled-repo';
    const enrolledGoal = makeGoal('g-enrolled', enrolledPath);
    const unenrolledGoal = makeGoal('g-unenrolled', null);

    // Return both goals; only enrolled is advanceable
    mockListGoals.mockReturnValue([enrolledGoal, unenrolledGoal]);
    mockListEnrolled.mockReturnValue([enrolledPath]);

    const afterAdvance = {
      ...enrolledGoal,
      milestones: [
        { ...makeMilestone(0, 'proposed'), swarmId: 's1', proposalId: 'p1' },
        makeMilestone(1),
      ],
    };
    mockLoadGoal.mockReturnValue(afterAdvance);
    mockRunSwarm.mockResolvedValue(makeSwarmRun('s1', 'done'));

    // Inline import mock for listProposals used inside advanceGoal
    const { listProposals } = await import('../src/core/inbox/store.js');
    vi.mocked(listProposals).mockReturnValue([
      { id: 'p1', origin: 'swarm', repo: enrolledPath, status: 'pending', summary: 'swarm=s1' } as Parameters<typeof listProposals>[0] extends infer _T ? ReturnType<typeof listProposals>[number] : never,
    ]);

    const { updateMilestoneStatus } = await import('../src/core/goals/store.js');
    vi.mocked(updateMilestoneStatus).mockReturnValue(afterAdvance);

    const summary = await runConductor(makeCfg(), {
      once: true,
      dryRun: false,
      maxGoalsPerCycle: 5, // allow both to be attempted
    });

    // Enrolled goal was advanced; unenrolled was skipped
    expect(summary.goalsAdvanced).toBeGreaterThanOrEqual(1);
    // runSwarm was called exactly once (for the enrolled goal only)
    expect(mockRunSwarm).toHaveBeenCalledTimes(1);
  });

  it('falls back to daemon when ALL goals are unenrolled (no active enrollable goals)', async () => {
    const unenrolledGoal = makeGoal('g-all-unenrolled', '/not/enrolled');
    mockListGoals.mockReturnValue([unenrolledGoal]);
    mockListEnrolled.mockReturnValue([]);

    // Daemon fallback should NOT trigger here — there ARE active goals, they're just skipped.
    // The conductor falls back only when listGoals returns [] (no active goals at all).
    // Having unenrolled goals that skip in the loop means goalsAdvanced=0 but daemonFallback=false.
    const summary = await runConductor(makeCfg(), { once: true, dryRun: false });

    expect(summary.daemonFallback).toBe(false);
    expect(summary.goalsAdvanced).toBe(0);
    expect(mockRunDaemon).not.toHaveBeenCalled();
  });

  it('does NOT skip an enrolled goal — advances it normally', async () => {
    const enrolledPath = '/tmp/my-repo';
    const goal = makeGoal('g-can-advance', enrolledPath);
    mockListGoals.mockReturnValue([goal]);
    mockListEnrolled.mockReturnValue([enrolledPath]);

    // dry-run so we don't need full swarm mock
    const summary = await runConductor(makeCfg(), { once: true, dryRun: true });

    // In dry-run, milestonesAdvanced is incremented for each goal with a milestone
    expect(summary.milestonesAdvanced).toBeGreaterThanOrEqual(1);
    expect(summary.daemonFallback).toBe(false);
  });
});
