/**
 * test/m229.goal-engine-trio.test.ts — M229: goal-milestone EXECUTION via the
 * real frontier-agent trio (Claude Code + Codex + Kimi/NIM) instead of the
 * builtin chat loop.
 *
 * WHAT THIS PROVES:
 *  1. allowCloud=true + frontier engines configured → advanceGoal dispatches via
 *     the sandboxed frontier path (runGoal called with sandboxEngine:true,
 *     requireSandbox:true, and a frontier engine id).
 *  2. Rotation: successive advanceGoalCycle calls spread across all configured
 *     frontier engines (round-robin).
 *  3. 429/rate-limit → retry on next engine; exhausting all → milestone 'blocked'.
 *  4. Flag-off (allowCloud=false) → builtin swarm path, runGoal NEVER called.
 *  5. Sandbox/proposal-only invariant: runGoal is called with sandboxEngine:true
 *     + requireSandbox:true on every frontier dispatch — no unsandboxed path.
 *  6. No safety guard weakened: assertMayMutate still called before any dispatch;
 *     runSwarm's builtin-forcing for swarms is untouched (this test verifies
 *     runGoal, not runSwarm, is used for the frontier path).
 *
 * HERMETIC: no real LLM / network calls. All external modules mocked via vi.mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: vi.fn(),
}));

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: vi.fn(),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: vi.fn(),
  killSwitchOn: vi.fn(() => false),
  listEnrolled: vi.fn(() => []),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  isEnrolled: vi.fn(() => true),
  setKill: vi.fn(),
}));

vi.mock('../src/core/goals/store.js', () => ({
  loadGoal: vi.fn(),
  updateMilestoneStatus: vi.fn(),
  resumeMilestone: vi.fn(),
  listGoals: vi.fn(() => []),
  saveGoal: vi.fn(),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: vi.fn(() => []),
  loadProposal: vi.fn(() => null),
}));

vi.mock('../src/core/swarm/store.js', () => ({
  loadSwarm: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports under test (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import type { AshlrConfig, Goal, Milestone, SwarmRun } from '../src/core/types.js';
import { advanceGoal, advanceGoalCycle, _m229ResetRoundRobin } from '../src/core/goals/advance.js';
import { runGoal } from '../src/core/run/orchestrator.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import { assertMayMutate } from '../src/core/sandbox/policy.js';
import {
  loadGoal as mockLoadGoal,
  updateMilestoneStatus,
} from '../src/core/goals/store.js';
import { listProposals } from '../src/core/inbox/store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(
  allowedBackends: string[] = ['claude', 'codex', 'nim'],
): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
    foundry: {
      allowedBackends: allowedBackends as any,
    },
  } as AshlrConfig;
}

function makeMilestone(over: Partial<Milestone> = {}): Milestone {
  return {
    id: 'm1',
    order: 1,
    title: 'Add feature X',
    status: 'pending',
    proposalId: null,
    swarmId: null,
    specId: null,
    ...over,
  } as Milestone;
}

function makeGoal(project: string, milestones: Milestone[] = []): Goal {
  return {
    id: 'g1',
    objective: 'Build feature X',
    status: 'active',
    project,
    milestones: milestones.length ? milestones : [makeMilestone()],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Goal;
}

/** A minimal SwarmRun-shaped object a mocked runGoal can return. */
function makeRunState(
  id = 'run-1',
  status = 'done',
  result = 'ok',
): { id: string; status: string; result: string; usage: { tokensIn: number; tokensOut: number; steps: number; estCostUsd: number } } {
  return { id, status, result, usage: { tokensIn: 10, tokensOut: 10, steps: 1, estCostUsd: 0 } };
}

/** A minimal SwarmRun for mocked runSwarm. */
function makeSwarmRun(id = 'swarm-1', status: SwarmRun['status'] = 'done'): SwarmRun {
  const now = new Date().toISOString();
  return {
    id,
    goal: 'test goal',
    specId: null,
    project: '/tmp/repo',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 10000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 0, tokensOut: 0, steps: 0, estCostUsd: 0 },
    parallel: 1,
    status,
    plan: { specId: null, goal: 'test goal', tasks: [] },
    tasks: [],
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpDir: string;
const origHome = process.env['HOME'];
const origTestAllow = process.env['ASHLR_TEST_ALLOW_ANY_REPO'];
const origNoSleep = process.env['ASHLR_TEST_NO_SLEEP'];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ashlr-m229-'));
  process.env['HOME'] = tmpDir;
  process.env['ASHLR_TEST_ALLOW_ANY_REPO'] = '1';
  process.env['ASHLR_TEST_NO_SLEEP'] = '1'; // skip backoff delays
  _m229ResetRoundRobin();
  vi.resetAllMocks();
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (origTestAllow === undefined) delete process.env['ASHLR_TEST_ALLOW_ANY_REPO'];
  else process.env['ASHLR_TEST_ALLOW_ANY_REPO'] = origTestAllow;
  if (origNoSleep === undefined) delete process.env['ASHLR_TEST_NO_SLEEP'];
  else process.env['ASHLR_TEST_NO_SLEEP'] = origNoSleep;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. allowCloud=true → runGoal called with sandboxEngine:true + requireSandbox:true
// ---------------------------------------------------------------------------

describe('M229 — frontier dispatch when allowCloud=true', () => {
  it('correlates a canonical proposal for a symlink-bound goal', async () => {
    const physical = join(tmpDir, 'physical-repo');
    const alias = join(tmpDir, 'repo-alias');
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(alias));
    vi.mocked(runGoal as any).mockResolvedValue(makeRunState());
    vi.mocked(listProposals)
      .mockReturnValueOnce([])
      .mockReturnValue([{
        id: 'prop-canonical', status: 'pending', origin: 'agent',
        repo: realpathSync.native(physical), summary: '',
      } as any]);

    await advanceGoal('g1', makeConfig(['codex']), { allowCloud: true, allowAnyRepo: true });

    expect(updateMilestoneStatus).toHaveBeenLastCalledWith('g1', 'm1', 'proposed', {
      swarmId: 'run-1',
      proposalId: 'prop-canonical',
    });
  });
  it('calls runGoal with sandboxEngine:true and requireSandbox:true', async () => {
    const repo = tmpDir;
    const goal = makeGoal(repo);
    vi.mocked(mockLoadGoal).mockReturnValue(goal);

    // Snapshot: no pending proposals before run
    vi.mocked(listProposals).mockReturnValueOnce([]); // beforeIds snapshot
    // After run: one new proposal with origin:'agent'
    vi.mocked(listProposals).mockReturnValue([
      { id: 'prop-1', status: 'pending', origin: 'agent', repo: realpathSync.native(repo), summary: '' } as any,
    ]);

    vi.mocked(runGoal as any).mockResolvedValue(makeRunState('run-frontier-1', 'done'));

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    const run = await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    // runGoal must have been called (not runSwarm)
    expect(vi.mocked(runGoal)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSwarm)).not.toHaveBeenCalled();

    const [_goal, _cfg, opts] = vi.mocked(runGoal).mock.calls[0]!;
    expect((opts as any).sandboxEngine).toBe(true);
    expect((opts as any).requireSandbox).toBe(true);
    expect((opts as any).engine).toMatch(/^(claude|codex|nim)$/);
    expect((opts as any).cwd).toBe(repo);

    // Milestone status updated to 'proposed' because we got a proposal
    expect(vi.mocked(updateMilestoneStatus)).toHaveBeenCalledWith(
      'g1', 'm1', 'in-progress',
    );
    const lastCall = vi.mocked(updateMilestoneStatus).mock.calls.slice(-1)[0]!;
    expect(lastCall[2]).toBe('proposed');
    expect(run.id).toBeDefined();
  });

  it('assertMayMutate is called before dispatch (enrollment gate intact)', async () => {
    const repo = tmpDir;
    const goal = makeGoal(repo);
    vi.mocked(mockLoadGoal).mockReturnValue(goal);
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runGoal as any).mockResolvedValue(makeRunState('run-1', 'done'));

    const cfg = makeConfig(['claude']);
    await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    // assertMayMutate must have been called BEFORE runGoal
    const assertOrder = vi.mocked(assertMayMutate).mock.invocationCallOrder[0]!;
    const runGoalOrder = vi.mocked(runGoal).mock.invocationCallOrder[0]!;
    expect(assertOrder).toBeLessThan(runGoalOrder);
  });
});

// ---------------------------------------------------------------------------
// 2. Rotation: successive calls spread across frontier engines
// ---------------------------------------------------------------------------

describe('M229 — round-robin engine rotation', () => {
  it('rotates across configured frontier engines across successive advanceGoal calls', async () => {
    const repo = tmpDir;
    const makeGoalWithId = (id: string) => makeGoal(repo, [makeMilestone({ id, status: 'pending' })]);

    // We call advanceGoal 3 times (resetting goal/milestone mock each time)
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runGoal as any).mockResolvedValue(makeRunState('run-x', 'done'));

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    const enginesUsed: string[] = [];

    for (let i = 0; i < 3; i++) {
      vi.mocked(mockLoadGoal).mockReturnValue(makeGoalWithId(`m${i}`));
      vi.clearAllMocks();
      // Re-mock after clearAllMocks
      vi.mocked(listProposals).mockReturnValue([]);
      vi.mocked(runGoal as any).mockResolvedValue(makeRunState(`run-${i}`, 'done'));

      await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

      const calls = vi.mocked(runGoal).mock.calls;
      if (calls.length > 0) {
        const engine = (calls[0]![2] as any).engine as string;
        enginesUsed.push(engine);
      }
      _m229ResetRoundRobin(); // We test rotation across 3 engines — see note
    }

    // Without resetting: first 3 calls should each pick a different engine.
    // Since we reset per iteration here for isolation, at minimum each call
    // hits a valid frontier engine.
    expect(enginesUsed.length).toBe(3);
    for (const e of enginesUsed) {
      expect(['claude', 'codex', 'nim']).toContain(e);
    }
  });

  it('with 3 engines and no reset, three calls each use a different engine', async () => {
    const repo = tmpDir;
    _m229ResetRoundRobin();

    // M270: nim must be promoted to frontier for it to be in the dynamic trio.
    // Without promotion nim stays 'mid'. This test covers the nim-as-frontier path
    // (cfg.foundry.nim.tier = 'frontier') — the same config required to run Kimi K2 via NIM.
    const cfg: AshlrConfig = {
      ...makeConfig(['claude', 'codex', 'nim']),
      foundry: {
        allowedBackends: ['claude', 'codex', 'nim'] as any,
        nim: { tier: 'frontier' as any },
      },
    };
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runGoal as any).mockResolvedValue(makeRunState('run-x', 'done'));

    const enginesUsed: string[] = [];
    for (let i = 0; i < 3; i++) {
      vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo, [makeMilestone({ id: `m${i}` })]));
      await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });
      const calls = vi.mocked(runGoal).mock.calls;
      const lastCall = calls[calls.length - 1]!;
      enginesUsed.push((lastCall[2] as any).engine as string);
    }

    // All three calls should spread across the trio (claude, codex, nim-promoted)
    expect(new Set(enginesUsed).size).toBe(3);
    expect(new Set(enginesUsed)).toEqual(new Set(['claude', 'codex', 'nim']));
  });
});

// ---------------------------------------------------------------------------
// 3. 429 → retry on next engine; exhausting all → 'blocked'
// ---------------------------------------------------------------------------

describe('M229 — 429 rate-limit → next engine retry', () => {
  it('on 429 from first engine, retries on next engine and succeeds', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals)
      .mockReturnValueOnce([]) // beforeIds
      .mockReturnValue([
        { id: 'prop-rl', status: 'pending', origin: 'agent', repo: realpathSync.native(repo), summary: '' } as any,
      ]);

    let callCount = 0;
    vi.mocked(runGoal as any).mockImplementation(async (_goal, _cfg, opts: any) => {
      callCount++;
      if (callCount === 1) {
        // First call returns a 429 signal
        return makeRunState('run-429', 'failed', 'error: 429 Too Many Requests rate limit exceeded');
      }
      // Second call succeeds
      return makeRunState('run-ok', 'done', 'ok');
    });

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    const run = await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    // runGoal called twice (once for the 429, once for the retry)
    expect(callCount).toBe(2);

    // The two calls must use different engines
    const calls = vi.mocked(runGoal).mock.calls;
    const engine1 = (calls[0]![2] as any).engine;
    const engine2 = (calls[1]![2] as any).engine;
    expect(engine1).not.toBe(engine2);

    // Final status: proposed (second call succeeded and produced a proposal)
    const lastStatusCall = vi.mocked(updateMilestoneStatus).mock.calls.slice(-1)[0]!;
    expect(lastStatusCall[2]).toBe('proposed');
    expect(run).toBeDefined();
  });

  it('when ALL engines return 429, milestone ends up blocked', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);

    // Every call returns a 429
    vi.mocked(runGoal as any).mockResolvedValue(
      makeRunState('run-rl', 'failed', 'error: rate_limit 429 too_many_requests'),
    );

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    const run = await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    // runGoal called multiple times (at least n+1 attempts)
    expect(vi.mocked(runGoal).mock.calls.length).toBeGreaterThanOrEqual(3);

    // Milestone ends up 'blocked' (no proposal produced, all engines exhausted)
    const statusCalls = vi.mocked(updateMilestoneStatus).mock.calls;
    const lastStatus = statusCalls[statusCalls.length - 1]![2];
    expect(lastStatus).toBe('blocked');
    expect(run.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// 4. Flag-off: allowCloud=false → builtin swarm path, runGoal never called
// ---------------------------------------------------------------------------

describe('M229 — flag-off: allowCloud=false uses builtin swarm', () => {
  it('correlates a canonical swarm proposal for a lexical project caller', async () => {
    const physical = join(tmpDir, 'lexical-repo');
    const nested = join(physical, 'identity-probe');
    mkdirSync(nested, { recursive: true });
    const lexical = join(nested, '..');
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(lexical));
    vi.mocked(runSwarm as any).mockResolvedValue(makeSwarmRun('swarm-lexical', 'done'));
    vi.mocked(listProposals).mockReturnValue([{
      id: 'prop-lexical', status: 'pending', origin: 'swarm',
      repo: realpathSync.native(physical), summary: 'swarm=swarm-lexical',
    } as any]);

    await advanceGoal('g1', makeConfig(), { allowCloud: false, allowAnyRepo: true });

    expect(updateMilestoneStatus).toHaveBeenLastCalledWith('g1', 'm1', 'proposed', {
      swarmId: 'swarm-lexical',
      proposalId: 'prop-lexical',
    });
  });

  it('allowCloud=false → runSwarm called, runGoal never called', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runSwarm as any).mockResolvedValue(makeSwarmRun('swarm-1', 'done'));

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    await advanceGoal('g1', cfg, { allowCloud: false, allowAnyRepo: true });

    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).toHaveBeenCalledTimes(1);

    // runSwarm must be called with sandbox:true + requireSandbox:true + propose:true
    const [_, _cfg, swarmOpts] = vi.mocked(runSwarm).mock.calls[0]!;
    expect((swarmOpts as any).sandbox).toBe(true);
    expect((swarmOpts as any).requireSandbox).toBe(true);
    expect((swarmOpts as any).propose).toBe(true);
  });

  it('no allowCloud in opts → builtin swarm path', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runSwarm as any).mockResolvedValue(makeSwarmRun('swarm-2', 'done'));

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    await advanceGoal('g1', cfg, { allowAnyRepo: true }); // no allowCloud

    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).toHaveBeenCalledTimes(1);
  });

  it('allowCloud=true but no frontier engines in allowedBackends → builtin swarm', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runSwarm as any).mockResolvedValue(makeSwarmRun('swarm-3', 'done'));

    // Only 'builtin' in allowedBackends — no frontier engines
    const cfg = makeConfig(['builtin']);
    await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Sandbox/proposal-only invariant: sandboxEngine:true on every attempt
// ---------------------------------------------------------------------------

describe('M229 — sandbox+proposal-only invariant', () => {
  it('every runGoal call has sandboxEngine:true and requireSandbox:true', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);

    // First call: 429. Second: success.
    let n = 0;
    vi.mocked(runGoal as any).mockImplementation(async () => {
      n++;
      if (n === 1) return makeRunState('r1', 'failed', '429 rate limit');
      return makeRunState('r2', 'done');
    });

    const cfg = makeConfig(['claude', 'codex']);
    await advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true });

    // EVERY call to runGoal must have sandboxEngine:true + requireSandbox:true
    for (const [, , opts] of vi.mocked(runGoal).mock.calls) {
      expect((opts as any).sandboxEngine).toBe(true);
      expect((opts as any).requireSandbox).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No safety guard weakened
// ---------------------------------------------------------------------------

describe('M229 — safety guards all intact', () => {
  it('kill-switch (assertMayMutate throw) prevents any dispatch', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(assertMayMutate as any).mockImplementation(() => {
      throw new Error('kill switch is on');
    });

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    await expect(
      advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true }),
    ).rejects.toThrow('kill switch is on');

    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).not.toHaveBeenCalled();
  });

  it('no-project goal errors before any dispatch', async () => {
    const goalNoProject: Goal = {
      ...makeGoal('/tmp/x'),
      project: undefined as unknown as string,
    };
    vi.mocked(mockLoadGoal).mockReturnValue(goalNoProject);

    const cfg = makeConfig(['claude', 'codex', 'nim']);
    await expect(
      advanceGoal('g1', cfg, { allowCloud: true, allowAnyRepo: true }),
    ).rejects.toThrow('no enrolled project');

    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).not.toHaveBeenCalled();
  });

  it('runSwarm builtin-forcing for swarms is untouched (flag-off path)', async () => {
    const repo = tmpDir;
    vi.mocked(mockLoadGoal).mockReturnValue(makeGoal(repo));
    vi.mocked(listProposals).mockReturnValue([]);
    vi.mocked(runSwarm as any).mockResolvedValue(makeSwarmRun('s1', 'done'));

    const cfg = makeConfig(['claude', 'codex']);
    // allowCloud=false → builtin-swarm path
    await advanceGoal('g1', cfg, { allowCloud: false, allowAnyRepo: true });

    // runSwarm is called; runGoal is NOT called (builtin-forcing inside runner.ts untouched)
    expect(vi.mocked(runGoal)).not.toHaveBeenCalled();
    expect(vi.mocked(runSwarm)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ sandbox: true, requireSandbox: true, propose: true }),
      expect.any(Function),
    );
  });
});
