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
 *  12. LOCUS CI SESSION — pass-through / refuse→errors / mint overlay / mint fail.
 *
 * SAFETY: HOME is overridden to a tmp dir. All I/O mocked. No real LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../src/core/types.js';
import type { TaskSpec } from '../src/core/simple-conductor.js';

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  liveConductorActivationAuthorized: () => true,
}));

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
const mockLoadProposal = vi.fn((id: string) => ({ id, status: 'pending' }));
function defaultDetailedProposalSnapshot() {
  const listed = mockListProposals() as Array<{ id: string }>;
  const listedById = new Map(listed.map((proposal) => [proposal.id, proposal]));
  const ids = new Set(listed.map((proposal) => proposal.id));
  try {
    for (const task of readTasks()) {
      if (task.proposalId) ids.add(task.proposalId);
      if (task.candidateProposalId) ids.add(task.candidateProposalId);
    }
  } catch { /* malformed-store tests intentionally have no proposal snapshot */ }
  if (mockRunEngineSandboxed.mock.calls.length > 0) {
    for (const id of ['prop-abc', 'prop-ok', 'proposal-candidate', 'proposal-stale']) ids.add(id);
  }
  return {
    proposals: [...ids].map((id) => listedById.get(id) ?? mockLoadProposal(id)).filter(Boolean),
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesDiscovered: ids.size,
    filesRead: ids.size,
    bytesRead: 1,
    invalidFiles: 0,
    unreadableFiles: 0,
  };
}
const mockListProposalsDetailed = vi.fn(defaultDetailedProposalSnapshot);
vi.mock('../src/core/inbox/store.js', () => ({
  ensureProposalInbox: () => true,
  listProposals: (...args: unknown[]) => mockListProposals(...args),
  loadProposal: (...args: unknown[]) => mockLoadProposal(...args),
  listProposalsDetailed: (...args: unknown[]) => mockListProposalsDetailed(...args),
}));

const mockVerifyPendingAuthority = vi.fn(() => true);
vi.mock('../src/core/inbox/pending-authority.js', () => ({
  isAuthoritativeDurablePendingProposal: (...args: unknown[]) =>
    mockVerifyPendingAuthority(...args),
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
  mockLoadProposal.mockImplementation((id: string) => ({ id, status: 'pending' }));
  mockVerifyPendingAuthority.mockReturnValue(true);
  mockListProposalsDetailed.mockImplementation(defaultDetailedProposalSnapshot);
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
  mockLoadProposal.mockImplementation((id: string) => ({ id, status: 'pending' }));
  mockVerifyPendingAuthority.mockReturnValue(true);
  mockListProposalsDetailed.mockImplementation(defaultDetailedProposalSnapshot);
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
    const { simpleConductorTaskGenerationId } = await import('../src/core/simple-conductor-task-store.js');
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
    expect(opts.workItemId).toBe('task-1');
    expect(opts.workItemGenerationId).toBe(simpleConductorTaskGenerationId(task));
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
    expect(readTasks().find((task) => task.id === 'task-fail')).toEqual(expect.objectContaining({
      attempts: 1,
      done: false,
      lastError: 'engine crash',
    }));
  });

  it('counts throwing invocations against the cycle cap', async () => {
    writeTasks(Array.from({ length: 5 }, (_, index) => baseTask({
      id: `task-throw-${index}`,
      repo: `/tmp/repo-throw-${index}`,
      priority: 5 - index,
    })));
    mockRunEngineSandboxed.mockRejectedValue(new Error('provider unavailable'));

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).toHaveBeenCalledTimes(3);
    expect(result.tasksAttempted).toBe(3);
    expect(readTasks().filter((task) => task.attempts === 1)).toHaveLength(3);
  });

  it('keeps a third no-proposal attempt retryable instead of reporting false completion', async () => {
    writeTasks([baseTask({ attempts: 2 })]);
    mockRunEngineSandboxed.mockResolvedValue({ state: { id: 'run-no-proposal', status: 'done' } });

    const { runSimpleConductor } = await importConductor();
    await runSimpleConductor(makeConfig(), { once: true, dryRun: false, allowCloud: false });

    expect(readTasks()[0]).toEqual(expect.objectContaining({
      attempts: 3,
      done: false,
      retryAfter: expect.any(String),
      lastError: expect.stringContaining('no authoritative proposal'),
    }));
  });

  it('persists an unresolved candidate and refuses to double-dispatch it on restart', async () => {
    writeTasks([baseTask()]);
    mockRunEngineSandboxed.mockResolvedValue({
      state: { id: 'run-candidate', status: 'failed' },
      candidateProposalId: 'proposal-candidate',
    });
    mockVerifyPendingAuthority.mockReturnValue(false);

    const { runSimpleConductor } = await importConductor();
    const first = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });
    const second = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(first.proposalsFiled).toBe(0);
    expect(second.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    expect(readTasks()[0]).toEqual(expect.objectContaining({
      done: false,
      candidateProposalId: 'proposal-candidate',
      retryAfter: expect.any(String),
    }));
  });

  it('keeps an invalid pending candidate blocking after its cooldown expires', async () => {
    writeTasks([baseTask({
      candidateProposalId: 'proposal-still-pending',
      retryAfter: '2020-01-01T00:00:00.000Z',
    })]);
    mockVerifyPendingAuthority.mockReturnValue(false);

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(result.tasksAttempted).toBe(0);
    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toContain('reconciliation required');
  });

  it('does not let a candidate from an explicit older generation block a replacement objective', async () => {
    writeTasks([baseTask({ candidateProposalId: 'proposal-old-generation' })]);
    mockLoadProposal.mockImplementation((id: string) => id === 'proposal-old-generation'
      ? {
          id,
          status: 'pending',
          workItemId: 'task-1',
          workItemGenerationId: 'a'.repeat(64),
        }
      : { id, status: 'pending' });
    mockVerifyPendingAuthority.mockImplementation((_proposal, expected) =>
      (expected as { id?: string }).id === 'prop-abc');

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    expect(result.proposalsFiled).toBe(1);
    expect(readTasks()[0].proposalId).toBe('prop-abc');
  });

  it('requires reconciliation instead of redispatching an expired same-generation lease', async () => {
    const row = baseTask();
    const { simpleConductorTaskGenerationId } = await import('../src/core/simple-conductor-task-store.js');
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([{
      ...row,
      attempts: 1,
      revision: 1,
      dispatchLease: {
        token: '12345678-1234-4123-8123-123456789abc',
        generationId,
        claimedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    }]);

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toContain('expired without terminal authority');
    expect(readTasks()[0].attempts).toBe(1);
  });

  it('recovers an authoritative proposal created before an expired lease was settled', async () => {
    const row = baseTask();
    const { simpleConductorTaskGenerationId } = await import('../src/core/simple-conductor-task-store.js');
    const generationId = simpleConductorTaskGenerationId(row);
    writeTasks([{
      ...row,
      attempts: 1,
      revision: 1,
      dispatchLease: {
        token: '12345678-1234-4123-8123-123456789abc',
        generationId,
        claimedAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    }]);
    mockListProposals.mockReturnValue([{
      id: 'proposal-crash-recovered',
      status: 'pending',
      repo: row.repo,
      workItemId: row.id,
      workItemGenerationId: generationId,
    }]);

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(result.proposalsRecovered).toBe(1);
    expect(readTasks()[0]).toEqual(expect.objectContaining({
      done: true,
      proposalId: 'proposal-crash-recovered',
      attempts: 1,
    }));
    expect(readTasks()[0].dispatchLease).toBeUndefined();
  });

  it('fails closed when the proposal source is degraded', async () => {
    writeTasks([baseTask()]);
    mockListProposalsDetailed.mockReturnValue({
      proposals: [],
      sourceState: 'degraded',
      sourcePresent: true,
      complete: false,
      stopReasons: ['invalid-file'],
      filesDiscovered: 1,
      filesRead: 1,
      bytesRead: 0,
      invalidFiles: 1,
      unreadableFiles: 0,
    });

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toContain('proposal source is degraded');
  });

  it('does not treat a missing proposal source as authoritative emptiness', async () => {
    writeTasks([baseTask()]);
    mockListProposalsDetailed.mockReturnValue({
      proposals: [],
      sourceState: 'missing',
      sourcePresent: false,
      complete: true,
      stopReasons: [],
      filesDiscovered: 0,
      filesRead: 0,
      bytesRead: 0,
      invalidFiles: 0,
      unreadableFiles: 0,
    });

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    expect(result.errors[0]?.error).toContain('proposal source is degraded');
  });

  it('does not settle a proposal onto a task generation changed during dispatch', async () => {
    writeTasks([baseTask()]);
    mockRunEngineSandboxed.mockImplementation(async () => {
      const [current] = readTasks();
      writeTasks([{ ...current, instruction: 'replacement objective' }]);
      return { state: { id: 'run-stale', status: 'done' }, proposalId: 'proposal-stale' };
    });

    const { runSimpleConductor } = await importConductor();
    const result = await runSimpleConductor(makeConfig(), {
      once: true,
      dryRun: false,
      allowCloud: false,
    });

    expect(result.proposalsFiled).toBe(0);
    expect(result.errors.some((entry) => entry.error.includes('generation'))).toBe(true);
    expect(readTasks()[0].instruction).toBe('replacement objective');
    expect(readTasks()[0].done).not.toBe(true);
    expect(readTasks()[0].proposalId).toBeUndefined();
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

// ---------------------------------------------------------------------------
// 12. LOCUS CI SESSION ISOLATION (per-task mint around sandboxed dispatch)
// ---------------------------------------------------------------------------
describe('M280 — Locus CI session isolation', () => {
  const LOCUS_ENV_KEYS = [
    'LOCUS_ENFORCE',
    'LOCUS_CI_BINDING',
    'LOCUS_BINDING',
    'LOCUS_SESSION_ID',
  ] as const;

  function snapshotLocusEnv(): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    for (const k of LOCUS_ENV_KEYS) out[k] = process.env[k];
    return out;
  }

  function restoreLocusEnv(prev: Record<string, string | undefined>): void {
    for (const k of LOCUS_ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }

  it('pass-through when enforce off and no binding (engine still runs)', async () => {
    const prev = snapshotLocusEnv();
    try {
      delete process.env.LOCUS_ENFORCE;
      delete process.env.LOCUS_CI_BINDING;
      delete process.env.LOCUS_BINDING;
      delete process.env.LOCUS_SESSION_ID;

      writeTasks([baseTask({ id: 'task-locus-pass' })]);
      const { runSimpleConductor } = await importConductor();
      const result = await runSimpleConductor(makeConfig(), {
        once: true,
        dryRun: false,
        allowCloud: false,
      });

      expect(result.tasksAttempted).toBe(1);
      expect(result.proposalsFiled).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockRunEngineSandboxed).toHaveBeenCalledOnce();
    } finally {
      restoreLocusEnv(prev);
    }
  });

  it('maps LOCUS_ENFORCE without binding to result.errors (never throws; no engine call)', async () => {
    const prev = snapshotLocusEnv();
    try {
      process.env.LOCUS_ENFORCE = '1';
      delete process.env.LOCUS_CI_BINDING;
      delete process.env.LOCUS_BINDING;
      delete process.env.LOCUS_SESSION_ID;

      writeTasks([baseTask({ id: 'task-locus-refuse' })]);
      const { runSimpleConductor } = await importConductor();
      const result = await runSimpleConductor(makeConfig(), {
        once: true,
        dryRun: false,
        allowCloud: false,
      });

      expect(result.tasksAttempted).toBe(1);
      expect(result.proposalsFiled).toBe(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].taskId).toBe('task-locus-refuse');
      expect(result.errors[0].error).toMatch(/LOCUS_CI_BINDING|LOCUS_BINDING|LOCUS_ENFORCE/);
      expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
      // Task claimed + settled failed (not done)
      const written = readTasks();
      expect(written[0].done).toBeFalsy();
      expect(written[0].lastError).toMatch(/LOCUS_CI_BINDING|LOCUS_BINDING|LOCUS_ENFORCE/);
    } finally {
      restoreLocusEnv(prev);
    }
  });

  it('overlays mint handle env on process.env for the sandboxed run only', async () => {
    const prev = snapshotLocusEnv();
    const seen: { sessionId?: string } = {};
    try {
      delete process.env.LOCUS_SESSION_ID;
      vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
        const actual = await importOriginal<
          typeof import('../src/core/integrations/locus.js')
        >();
        return {
          ...actual,
          runWithLocusSessionIfConfigured: async (
            fn: (handle: {
              sessionId: string;
              binding: string;
              env: NodeJS.ProcessEnv;
            } | null) => Promise<unknown>,
          ) =>
            fn({
              sessionId: 'sess-conductor-mint',
              binding: 'ci-acme',
              env: {
                LOCUS_SESSION_ID: 'sess-conductor-mint',
                LOCUS_BINDING: 'ci-acme',
                LOCUS_HOME: '/tmp/locus-conductor-mint',
              },
            }),
        };
      });

      mockRunEngineSandboxed.mockImplementation(async () => {
        seen.sessionId = process.env.LOCUS_SESSION_ID;
        return {
          state: { id: 'run-locus-mint', status: 'done' },
          proposalId: 'prop-abc',
        };
      });

      writeTasks([baseTask({ id: 'task-locus-mint' })]);
      const { runSimpleConductor } = await import(
        '../src/core/simple-conductor.js?locus-session-mint=' + Date.now()
      );
      const result = await runSimpleConductor(makeConfig(), {
        once: true,
        dryRun: false,
        allowCloud: false,
      });

      expect(result.tasksAttempted).toBe(1);
      expect(result.proposalsFiled).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(seen.sessionId).toBe('sess-conductor-mint');
      // Restored after sandboxed body — must not leak mint session into ambient env.
      expect(process.env.LOCUS_SESSION_ID).toBeUndefined();
    } finally {
      restoreLocusEnv(prev);
      vi.doUnmock('../src/core/integrations/locus.js');
    }
  });

  it('maps LocusMintError to result.errors without throwing', async () => {
    const prev = snapshotLocusEnv();
    try {
      vi.doMock('../src/core/integrations/locus.js', async (importOriginal) => {
        const actual = await importOriginal<
          typeof import('../src/core/integrations/locus.js')
        >();
        return {
          ...actual,
          runWithLocusSessionIfConfigured: async () => {
            throw new actual.LocusMintError('ci mint failed: simulated conductor');
          },
        };
      });

      writeTasks([baseTask({ id: 'task-locus-mint-err' })]);
      const { runSimpleConductor } = await import(
        '../src/core/simple-conductor.js?locus-session-mint-err=' + Date.now()
      );
      const result = await runSimpleConductor(makeConfig(), {
        once: true,
        dryRun: false,
        allowCloud: false,
      });

      expect(result.tasksAttempted).toBe(1);
      expect(result.proposalsFiled).toBe(0);
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].taskId).toBe('task-locus-mint-err');
      expect(result.errors[0].error).toMatch(/ci mint failed/);
      expect(mockRunEngineSandboxed).not.toHaveBeenCalled();
    } finally {
      restoreLocusEnv(prev);
      vi.doUnmock('../src/core/integrations/locus.js');
    }
  });
});
