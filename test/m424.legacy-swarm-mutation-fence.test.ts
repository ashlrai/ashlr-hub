import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunState, Sandbox, SwarmPlan } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  sandboxDiff: vi.fn(),
  inspectSandboxSourceRevision: vi.fn(() => ({
    ok: true,
    reason: 'sandbox source revision matches admission baseline',
  })),
  removeSandbox: vi.fn(),
  removeSandboxWithBorrowedAuthority: vi.fn(),
  createProposal: vi.fn(),
  runGoal: vi.fn(),
  planSwarm: vi.fn(),
  assurePrivateStorage: vi.fn(() => ({ ok: true, reason: 'exact-private-dacl' })),
  snapshotProject: vi.fn((project: string | null) => ({
    project,
    isRepo: false,
    head: null,
    dirty: false,
    stashRef: null,
    ts: new Date().toISOString(),
  })),
}));

vi.mock('../src/core/util/private-storage.js', () => ({
  assurePrivateStoragePath: mocks.assurePrivateStorage,
}));

vi.mock('../src/core/run/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/orchestrator.js')>();
  return { ...actual, runGoal: mocks.runGoal };
});

vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mocks.planSwarm,
}));

vi.mock('../src/core/swarm/rollback.js', () => ({
  snapshotProject: mocks.snapshotProject,
}));

vi.mock('../src/core/sandbox/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/worktree.js')>();
  return {
    ...actual,
    createSandbox: mocks.createSandbox,
    sandboxDiff: mocks.sandboxDiff,
    inspectSandboxSourceRevision: mocks.inspectSandboxSourceRevision,
    removeSandbox: mocks.removeSandbox,
    removeSandboxWithBorrowedAuthority: mocks.removeSandboxWithBorrowedAuthority,
  };
});

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return { ...actual, createProposal: mocks.createProposal };
});

import { enroll, isEnrolled, killSwitchOn, setKill, unenroll } from '../src/core/sandbox/policy.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import { loadSwarm } from '../src/core/swarm/store.js';

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    foundry: { completenessGate: false },
  };
}

function completedRun(goal: string): RunState {
  const now = new Date().toISOString();
  return {
    id: 'm424-task-run',
    goal,
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'done',
    result: 'task complete',
  };
}

const plan: SwarmPlan = {
  specId: null,
  goal: 'mutation lifecycle',
  tasks: [{ id: 'build-1', phase: 'build', goal: 'held write', deps: [] }],
};

describe('M424 legacy swarm mutation lifecycle authority', { timeout: 15_000 }, () => {
  let home: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousAshlrHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousAshlrHome = process.env.ASHLR_HOME;
    home = mkdtempSync(join(tmpdir(), 'ashlr-m424-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ASHLR_HOME = join(home, '.ashlr');
    delete process.env.ASHLR_IN_SWARM;
    vi.clearAllMocks();

    const sandbox: Sandbox = {
      id: 'm424-sandbox',
      sourceRepo: join(home, 'repo'),
      worktreePath: join(home, 'sandbox'),
      branch: 'ashlr/sandbox/m424',
      baseHead: 'a'.repeat(40),
      createdAt: new Date().toISOString(),
      ownerPid: process.pid,
    };
    mocks.createSandbox.mockReturnValue(sandbox);
    mocks.sandboxDiff.mockReturnValue({
      patch: 'diff --git a/x.ts b/x.ts\n+held effect\n',
      files: 1,
      insertions: 1,
      deletions: 0,
    });
    mocks.removeSandbox.mockReturnValue({ status: 'complete' });
    mocks.removeSandboxWithBorrowedAuthority.mockReturnValue({ status: 'complete' });
    mocks.planSwarm.mockResolvedValue(plan);
  });

  afterEach(() => {
    setKill(false, { waitMs: 500 });
    delete process.env.ASHLR_IN_SWARM;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = previousAshlrHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps pause non-quiesced while a held task drains through capture and borrowed cleanup', async () => {
    let releaseTask!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseTask = resolve; });
    mocks.runGoal.mockImplementationOnce(async (goal: string) => {
      markEntered();
      await release;
      return completedRun(goal);
    });

    const project = join(home, 'repo');
    expect(enroll(project)).toMatchObject({ ok: true, quiesced: true });
    const running = runSwarm(
      { goal: plan.goal },
      config(),
      {
        runId: 'm424-held-strict-swarm',
        project,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
      () => {},
    );
    await entered;

    expect(unenroll(project, { waitMs: 25 })).toEqual({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'outward mutation fence unavailable',
    });
    expect(isEnrolled(project)).toBe(true);

    expect(setKill(true, { waitMs: 25 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);

    releaseTask();
    await expect(running).resolves.toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/kill switch during phase build/i),
    });
    expect(mocks.sandboxDiff).toHaveBeenCalledOnce();
    expect(mocks.createProposal).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).toHaveBeenCalledOnce();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({
      ok: true,
      changed: false,
      quiesced: true,
    });
  }, 30_000);

  it('retains authority through held planning and persists the completed plan before quiescence', async () => {
    let releasePlanner!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releasePlanner = resolve; });
    mocks.planSwarm.mockImplementationOnce(async () => {
      markEntered();
      await release;
      return plan;
    });

    const project = join(home, 'repo');
    const runId = 'm424-held-strict-planning';
    expect(enroll(project)).toMatchObject({ ok: true, quiesced: true });
    const running = runSwarm(
      { goal: plan.goal },
      config(),
      {
        runId,
        project,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
      () => {},
    );
    await entered;

    expect(mocks.createSandbox).toHaveBeenCalledOnce();
    expect(setKill(true, { waitMs: 25 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });

    releasePlanner();
    await expect(running).resolves.toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/kill switch during planning/i),
      plan,
    });
    expect(loadSwarm(runId)).toMatchObject({ status: 'aborted', plan });
    expect(mocks.runGoal).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).toHaveBeenCalledOnce();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({
      ok: true,
      changed: false,
      quiesced: true,
    });
  });

  it('does not apply autonomous kill gating to a non-strict manual swarm', async () => {
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
    mocks.runGoal.mockImplementationOnce(async (goal: string) => completedRun(goal));

    const result = await runSwarm(
      { goal: plan.goal },
      config(),
      { runId: 'm424-manual-swarm', project: join(home, 'repo'), noCapture: true },
      () => {},
    );

    expect(result.status).toBe('done');
    expect(mocks.runGoal).toHaveBeenCalledOnce();
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  }, 30_000);

  it('does not report quiescence while proposal capture is inside the retained fence', async () => {
    mocks.runGoal.mockImplementationOnce(async (goal: string) => completedRun(goal));
    const project = join(home, 'repo');
    expect(enroll(project)).toMatchObject({ ok: true, quiesced: true });
    let pauseDuringCapture: ReturnType<typeof setKill> | undefined;
    mocks.createProposal.mockImplementationOnce((proposal: Record<string, unknown>) => {
      pauseDuringCapture = setKill(true, { waitMs: 25 });
      return {
        ...proposal,
        id: 'm424-held-capture',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
    });

    const result = await runSwarm(
      { goal: plan.goal },
      config(),
      {
        runId: 'm424-proposal-capture',
        project,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
      () => {},
    );

    expect(result.status).toBe('done');
    expect(pauseDuringCapture).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(mocks.createProposal).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxWithBorrowedAuthority).toHaveBeenCalledOnce();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('rechecks enrollment across the creation-to-execution fence handoff', async () => {
    const project = join(home, 'gap-repo');
    expect(enroll(project)).toMatchObject({ ok: true, quiesced: true });
    let gapUnenroll: ReturnType<typeof unenroll> | undefined;
    mocks.createSandbox.mockImplementationOnce(() => {
      gapUnenroll = unenroll(project, { waitMs: 500 });
      return {
        id: 'm424-gap-sandbox',
        sourceRepo: project,
        worktreePath: join(home, 'gap-sandbox'),
        branch: 'ashlr/sandbox/m424-gap',
        baseHead: 'b'.repeat(40),
        createdAt: new Date().toISOString(),
        ownerPid: process.pid,
      } satisfies Sandbox;
    });

    const result = await runSwarm(
      { goal: plan.goal },
      config(),
      {
        runId: 'm424-unenroll-handoff',
        project,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
      () => {},
    );

    expect(gapUnenroll).toMatchObject({ ok: true, changed: true, quiesced: true });
    expect(result).toMatchObject({
      status: 'failed',
      result: expect.stringMatching(/mutation lifecycle authority unavailable/i),
    });
    expect(mocks.runGoal).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).not.toHaveBeenCalled();
  });
});
