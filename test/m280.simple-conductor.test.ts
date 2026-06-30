/**
 * m280.simple-conductor.test.ts — M280: SIMPLE-CONDUCTOR unit tests.
 *
 * Test groups:
 *
 *   1. READS TASKS — parses ~/.ashlr/tasks.json; missing file → no-op.
 *   2. DISPATCHES VIA runEngineSandboxed (MOCKED) — files proposal + marks task
 *      done + writes tasks.json back.
 *   3. SKIPS DONE TASKS — task with done:true is never dispatched.
 *   4. SKIPS IN-FLIGHT TASKS — task whose proposalId is already PENDING is skipped.
 *   5. RESPECTS KILL-SWITCH — killSwitchOn()=true → immediate zeros.
 *   6. RESPECTS ENROLLMENT — assertMayMutate throws → skip + error, continue.
 *   7. CALLS runAutoMergePass — after dispatch, pass result feeds merged count.
 *   8. NEVER-THROWS PER TASK — runEngineSandboxed throwing on one task does not
 *      abort the loop; next task still runs.
 *   9. FLAG-OFF — loop.ts uses runConductor when simpleConductor !== true.
 *  10. DRY-RUN — no dispatch, no write, tasksAttempted populated.
 *  11. MAX-TASKS-PER-CYCLE — at most 3 tasks dispatched per tick.
 *
 * SAFETY: HOME is overridden to a tmp dir. All I/O mocked. No real LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../src/core/types.js';
import type { TaskSpec } from '../src/core/simple-conductor.js';

// ---------------------------------------------------------------------------
// HOME isolation — must happen before any module resolves homedir()
// ---------------------------------------------------------------------------
const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before any lazy import
// ---------------------------------------------------------------------------

// killSwitchOn
const mockKillSwitchOn = vi.fn(() => false);
// assertMayMutate — throws to simulate unenrolled repo
const mockAssertMayMutate = vi.fn((_repo: string) => { /* no-op by default */ });
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
  assertMayMutate: (repo: string, opts?: unknown) => mockAssertMayMutate(repo),
  listEnrolled: vi.fn(() => []),
}));

// runEngineSandboxed
const mockRunEngineSandboxed = vi.fn();
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  runEngineSandboxed: (...args: unknown[]) => mockRunEngineSandboxed(...args),
  // M300: runApiModelSandboxed added to conductor — mock so the import doesn't crash.
  runApiModelSandboxed: vi.fn(async () => ({ proposalId: undefined })),
}));

// M300: engine-registry (resolveEngineSpec) — default: cli-agent kind so
// all existing m280 tasks still go through runEngineSandboxed.
vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: vi.fn(() => ({ id: 'claude', kind: 'cli-agent', tier: 'frontier' })),
  resolveEngineRegistry: vi.fn(() => ({})),
}));

// M300: resource-monitor — default: all backends open (no reroute).
vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    backends: [
      { backend: 'claude', availability: 'open', usedPct: null, cap: null, capUnit: null, capWindow: null, resetsAt: null, costPerMTokenOut: 0, p50LatencyMs: null, snapshotAt: new Date().toISOString(), reason: 'open', backoffUntilMs: null },
    ],
  })),
  peekBackendAvailability: vi.fn(() => null),
  recordBackoff: vi.fn(),
  clearBackoff: vi.fn(),
}));

// runAutoMergePass
const mockRunAutoMergePass = vi.fn();
vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: (...args: unknown[]) => mockRunAutoMergePass(...args),
}));

// listProposals — controls pending set
const mockListProposals = vi.fn(() => []);
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
}));

// runConductor — for flag-off test
const mockRunConductor = vi.fn();
vi.mock('../src/core/goals/conductor.js', () => ({
  runConductor: (...args: unknown[]) => mockRunConductor(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(simpleConductor = true): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    foundry: {
      simpleConductor,
      autoMerge: { enabled: false },
    },
  } as unknown as AshlrConfig;
}

function writeTasks(tasks: TaskSpec[]): void {
  const dir = join(tmpHome, '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n', 'utf8');
}

function readTasks(): TaskSpec[] {
  const p = join(tmpHome, '.ashlr', 'tasks.json');
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf8')) as TaskSpec[];
}

function baseTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'task-1',
    repo: '/tmp/fake-repo',
    instruction: 'fix the bug',
    priority: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'm280-home-'));
  process.env.HOME = tmpHome;

  mockKillSwitchOn.mockReturnValue(false);
  mockAssertMayMutate.mockImplementation(() => { /* enrolled */ });
  mockRunEngineSandboxed.mockResolvedValue({
    state: { id: 'run-1', status: 'done' },
    proposalId: 'prop-abc',
  });
  mockRunAutoMergePass.mockResolvedValue({
    attempted: 1, merged: 1, branched: 0, results: [], judged: 1,
    judgeCapped: 0, skipped: [], autoArchived: 0, ttlRejected: 0,
  });
  mockListProposals.mockReturnValue([]);
  mockRunConductor.mockResolvedValue({
    killSwitchTripped: false, daemonFallback: false, goalActivity: [],
    goalsAdvanced: 0, proposalsFiled: 0, goalsDone: 0,
  });
  vi.clearAllMocks();
  // Re-establish defaults after clearAllMocks
  mockKillSwitchOn.mockReturnValue(false);
  mockAssertMayMutate.mockImplementation(() => { /* enrolled */ });
  mockRunEngineSandboxed.mockResolvedValue({
    state: { id: 'run-1', status: 'done' },
    proposalId: 'prop-abc',
  });
  mockRunAutoMergePass.mockResolvedValue({
    attempted: 1, merged: 1, branched: 0, results: [], judged: 1,
    judgeCapped: 0, skipped: [], autoArchived: 0, ttlRejected: 0,
  });
  mockListProposals.mockReturnValue([]);
  mockRunConductor.mockResolvedValue({
    killSwitchTripped: false, daemonFallback: false, goalActivity: [],
    goalsAdvanced: 0, proposalsFiled: 0, goalsDone: 0,
  });
});

afterEach(() => {
  process.env.HOME = origHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Lazy import (after mocks + HOME isolation)
// ---------------------------------------------------------------------------
async function importConductor() {
  return import('../src/core/simple-conductor.js');
}

// ---------------------------------------------------------------------------
// 1. READS TASKS — missing file → no-op
// ---------------------------------------------------------------------------
describe('M280 — reads tasks', () => {
  it('returns zeros when tasks.json is absent', async () => {
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(result.tasksAttempted).toBe(0);
    expect(result.proposalsFiled).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.killSwitchTripped).toBe(false);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
  });

  it('returns zeros when tasks.json is empty array', async () => {
    writeTasks([]);
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(result.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. DISPATCHES VIA runEngineSandboxed — files proposal + marks done
// ---------------------------------------------------------------------------
describe('M280 — dispatches and marks done', () => {
  it('dispatches a ready task, files proposal, marks done:true in tasks.json', async () => {
    const task = baseTask({ id: 'task-1', repo: '/tmp/repo-a' });
    writeTasks([task]);

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });

    expect(result.tasksAttempted).toBe(1);
    expect(result.proposalsFiled).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.errors).toHaveLength(0);

    // runEngineSandboxed called with correct args
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    const [engine, instruction, , opts] = mockRunEngineSandboxed.mock.calls[0];
    expect(engine).toBe('claude');
    // M298: instruction is the original task instruction + full-suite directive appended.
    expect(instruction).toContain('fix the bug');
    expect(instruction).toContain('BEFORE FINISHING');
    expect(instruction).toContain('npm test');
    expect(instruction).toContain('npx tsc --noEmit');
    expect(opts.sourceRepo).toBe('/tmp/repo-a');
    expect(opts.propose).toBe(true);
    expect(opts.budget.maxTokens).toBe(150_000); // M287: raised for substantial work
    expect(opts.budget.maxSteps).toBe(100);

    // tasks.json written back with done:true + proposalId
    const written = readTasks();
    expect(written[0].done).toBe(true);
    expect(written[0].proposalId).toBe('prop-abc');
    expect(written[0].dispatchedAt).toBeDefined();
  });

  it('uses task.engine when specified', async () => {
    writeTasks([baseTask({ engine: 'codex' as never, repo: '/tmp/repo-b' })]);
    const { runSimpleConductor } = await importConductor();
    await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    const [engine] = mockRunEngineSandboxed.mock.calls[0];
    expect(engine).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// 3. SKIPS DONE TASKS
// ---------------------------------------------------------------------------
describe('M280 — skips done tasks', () => {
  it('does not dispatch a task with done:true', async () => {
    writeTasks([baseTask({ done: true })]);
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(result.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. SKIPS IN-FLIGHT TASKS (PENDING proposal guard)
// ---------------------------------------------------------------------------
describe('M280 — skips in-flight tasks', () => {
  it('skips a task whose proposalId is in the PENDING proposal list', async () => {
    writeTasks([baseTask({ proposalId: 'prop-existing' })]);
    mockListProposals.mockReturnValue([{ id: 'prop-existing', status: 'pending' }]);
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(result.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. KILL-SWITCH
// ---------------------------------------------------------------------------
describe('M280 — kill-switch', () => {
  it('returns killSwitchTripped:true and zeros when kill switch is on', async () => {
    mockKillSwitchOn.mockReturnValue(true);
    writeTasks([baseTask()]);
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(result.killSwitchTripped).toBe(true);
    expect(result.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6. ENROLLMENT GUARD
// ---------------------------------------------------------------------------
describe('M280 — enrollment guard', () => {
  it('skips + records error when assertMayMutate throws; continues to next task', async () => {
    const task1 = baseTask({ id: 'task-unenrolled', repo: '/tmp/unenrolled' });
    const task2 = baseTask({ id: 'task-ok', repo: '/tmp/enrolled', priority: -1 });
    writeTasks([task1, task2]);

    mockAssertMayMutate.mockImplementation((repo: string) => {
      if (repo === '/tmp/unenrolled') throw new Error('repo not enrolled');
    });

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });

    // Both tasks attempted (one failed enrollment, one succeeded dispatch)
    expect(result.tasksAttempted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe('task-unenrolled');
    expect(result.errors[0].error).toContain('not enrolled');

    // The second task was dispatched successfully
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 7. CALLS runAutoMergePass
// ---------------------------------------------------------------------------
describe('M280 — calls runAutoMergePass', () => {
  it('calls runAutoMergePass after dispatching and feeds merged count', async () => {
    writeTasks([baseTask()]);
    mockRunAutoMergePass.mockResolvedValue({
      attempted: 1, merged: 2, branched: 0, results: [], judged: 1,
      judgeCapped: 0, skipped: [], autoArchived: 0, ttlRejected: 0,
    });
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });
    expect(mockRunAutoMergePass).toHaveBeenCalledOnce();
    expect(result.merged).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. NEVER-THROWS PER TASK
// ---------------------------------------------------------------------------
describe('M280 — never-throws per task', () => {
  it('continues to next task when runEngineSandboxed throws on first task', async () => {
    const task1 = baseTask({ id: 'task-fail', repo: '/tmp/repo-fail', priority: 1 });
    const task2 = baseTask({ id: 'task-ok', repo: '/tmp/repo-ok', priority: 0 });
    writeTasks([task1, task2]);

    let callCount = 0;
    mockRunEngineSandboxed.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('engine crash');
      return { state: { id: 'run-2', status: 'done' }, proposalId: 'prop-ok' };
    });

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });

    expect(result.tasksAttempted).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].taskId).toBe('task-fail');
    expect(result.proposalsFiled).toBe(1); // second task succeeded
  });
});

// ---------------------------------------------------------------------------
// 9. FLAG-OFF — loop.ts uses runConductor when simpleConductor !== true
// ---------------------------------------------------------------------------
describe('M280 — flag-off uses runConductor', () => {
  it('config without simpleConductor flag does not import simple-conductor', async () => {
    // We test the flag-off behavior by checking loop.ts routes to runConductor
    // when cfg.foundry.simpleConductor is absent/false.
    // We do this by reading the loop.ts source and verifying the gate condition.
    const loopSrc = readFileSync(
      join(process.cwd(), 'src/cli/loop.ts'),
      'utf8',
    );
    expect(loopSrc).toContain("cfg.foundry?.simpleConductor === true");
    expect(loopSrc).toContain("runConductor");
    // The old runConductor import still exists (not deleted).
    expect(loopSrc).toContain("goals/conductor.js");
  });
});

// ---------------------------------------------------------------------------
// 10. DRY-RUN
// ---------------------------------------------------------------------------
describe('M280 — dry-run', () => {
  it('records intent, does not dispatch or write tasks.json', async () => {
    writeTasks([baseTask()]);
    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), { once: true, dryRun: true, allowCloud: false });

    expect(result.tasksAttempted).toBe(1);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(mockRunAutoMergePass).not.toHaveBeenCalled();

    // tasks.json not modified (task still not done)
    const tasks = readTasks();
    expect(tasks[0].done).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// 11. MAX-TASKS-PER-CYCLE
// ---------------------------------------------------------------------------
describe('M280 — max tasks per cycle', () => {
  it('dispatches at most 3 tasks per tick', async () => {
    const tasks: TaskSpec[] = Array.from({ length: 5 }, (_, i) => ({
      id: `task-${i}`,
      repo: `/tmp/repo-${i}`,
      instruction: `fix ${i}`,
      priority: 5 - i,
    }));
    writeTasks(tasks);

    const { runSimpleConductor } = await importConductor();
    await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });

    expect(mockRunEngineSandboxed).toHaveBeenCalledTimes(3);
  });
});
