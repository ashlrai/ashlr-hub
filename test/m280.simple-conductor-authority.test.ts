import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { TaskSpec } from '../src/core/simple-conductor.js';

vi.mock('../src/core/daemon/activation-permit.js', () => ({
  liveConductorActivationAuthorized: () => true,
}));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  killSwitchOn: () => false,
  assertMayMutate: vi.fn(),
}));

vi.mock('../src/core/run/engine-registry.js', () => ({
  resolveEngineSpec: vi.fn(() => ({ id: 'claude', kind: 'cli-agent', tier: 'frontier' })),
  resolveEngineRegistry: vi.fn(() => ({})),
}));

vi.mock('../src/core/fabric/resource-monitor.js', () => ({
  getResourceSnapshot: vi.fn(async () => ({
    generatedAt: new Date().toISOString(),
    backends: [
      {
        backend: 'claude',
        availability: 'open',
        usedPct: null,
        cap: null,
        capUnit: null,
        capWindow: null,
        resetsAt: null,
        costPerMTokenOut: 0,
        p50LatencyMs: null,
        snapshotAt: new Date().toISOString(),
        reason: 'open',
        backoffUntilMs: null,
      },
    ],
  })),
}));

vi.mock('../src/core/fleet/automerge-pass.js', () => ({
  runAutoMergePass: vi.fn(async () => ({
    attempted: 0,
    merged: 0,
    branched: 0,
    results: [],
    judged: 0,
    judgeCapped: 0,
    skipped: [],
    autoArchived: 0,
    ttlRejected: 0,
  })),
}));

const mockRunEngineSandboxed = vi.fn();
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  runEngineSandboxed: (...args: unknown[]) => mockRunEngineSandboxed(...args),
  runApiModelSandboxed: vi.fn(),
}));

let priorHome: string | undefined;
let priorAllowAnyRepo: string | undefined;
let priorPulseUrl: string | undefined;
let home: string;
let repo: string;
let corruptNextProposal = false;
let runOrdinal = 0;

function cfg(): AshlrConfig {
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
      simpleConductor: true,
      autoMerge: { enabled: false },
      productionVelocity: {
        enabled: true,
        profile: 'resource-control',
        stalePendingTtlHours: 24,
      },
    },
  } as unknown as AshlrConfig;
}

function tasksPath(): string {
  return join(home, '.ashlr', 'tasks.json');
}

function writeTasks(tasks: TaskSpec[]): void {
  mkdirSync(join(home, '.ashlr'), { recursive: true });
  writeFileSync(tasksPath(), `${JSON.stringify(tasks, null, 2)}\n`, 'utf8');
}

function readTasks(): TaskSpec[] {
  return JSON.parse(readFileSync(tasksPath(), 'utf8')) as TaskSpec[];
}

function proposalFile(id: string): string {
  return join(home, '.ashlr', 'inbox', `${id}.json`);
}

async function createRealProposalFromDispatch(
  _engine: unknown,
  _instruction: unknown,
  runCfg: AshlrConfig,
  opts: Record<string, unknown>,
) {
  const { createProposal } = await import('../src/core/inbox/store.js');
  const { hashDiff, signProvenance } = await import('../src/core/foundry/provenance.js');
  const { canonicalizeProposalDiff } = await import('../src/core/util/scrub.js');
  const runId = `run-simple-authority-${++runOrdinal}`;
  const diff = canonicalizeProposalDiff('diff --git a/src/a.ts b/src/a.ts\n+export const value = 1;\n');
  const diffHash = hashDiff(diff);
  const engineModel = 'claude:test-model';
  const engineTier = 'frontier';
  const proposal = createProposal({
    repo: opts.sourceRepo as string,
    origin: 'agent',
    kind: 'patch',
    title: 'simple conductor real authority',
    summary: 'real store and verifier regression',
    diff,
    diffHash,
    provenanceSig: signProvenance(engineModel, engineTier, diffHash),
    sandboxId: `sandbox-${runId}`,
    workItemId: opts.workItemId as string,
    workItemGenerationId: opts.workItemGenerationId as string,
    runId,
    trajectoryId: `run:${runId}`,
    producerStatus: 'done',
    engineModel,
    engineTier,
    runEventSummary: {
      runId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      diffFiles: 1,
      diffLines: 1,
      actionCounts: {
        proposalCreated: 1,
        proposalBlocked: 0,
        proposalDisabled: 0,
        modelSteps: 1,
        toolSteps: 0,
        totalSteps: 1,
        diffFiles: 1,
        diffLines: 1,
      },
    },
  }, runCfg);
  if (corruptNextProposal) {
    const path = proposalFile(proposal.id);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Proposal;
    delete stored.pendingAuthoritySig;
    delete stored.pendingAuthorityVersion;
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    corruptNextProposal = false;
  }
  const proposalOutcome = {
    kind: 'filed' as const,
    reason: 'proposal filed',
    proposalId: proposal.id,
    files: 1,
    insertions: 1,
    deletions: 0,
  };
  return {
    state: {
      id: runId,
      status: 'done',
      usage: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, steps: 1 },
      proposalOutcome,
      runEventSummary: {
        ...proposal.runEventSummary,
        runId,
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: proposal.id,
      },
    },
    proposalId: proposal.id,
    proposalOutcome,
  };
}

beforeEach(() => {
  priorHome = process.env.HOME;
  priorAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  priorPulseUrl = process.env.PULSE_URL;
  home = mkdtempSync(join(tmpdir(), 'm280-authority-home-'));
  repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  process.env.HOME = home;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  delete process.env.PULSE_URL;
  corruptNextProposal = false;
  runOrdinal = 0;
  mockRunEngineSandboxed.mockReset();
  mockRunEngineSandboxed.mockImplementation(createRealProposalFromDispatch);
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (priorAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = priorAllowAnyRepo;
  if (priorPulseUrl === undefined) delete process.env.PULSE_URL;
  else process.env.PULSE_URL = priorPulseUrl;
  rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

describe('M280 real pending authority', () => {
  it('dispatches deterministic work identity and settles only a real signed pending proposal', async () => {
    const task = {
      id: 'task-real-authority',
      repo,
      instruction: 'make the authority proof real',
    };
    writeTasks([task]);

    const {
      runSimpleConductor,
      simpleConductorWorkItemGenerationId,
    } = await import('../src/core/simple-conductor.js');
    const result = await runSimpleConductor(cfg(), { once: true, dryRun: false, allowCloud: false });
    const { listProposals, loadProposal } = await import('../src/core/inbox/store.js');
    const { isAuthoritativeDurablePendingProposal } = await import('../src/core/inbox/pending-authority.js');
    const { verifyPendingProposalAuthorityV1 } = await import('../src/core/foundry/provenance.js');

    const generation = simpleConductorWorkItemGenerationId(task);
    const proposals = listProposals({ status: 'pending' });
    expect(result.proposalsFiled).toBe(1);
    expect(proposals).toHaveLength(1);
    expect(mockRunEngineSandboxed.mock.calls[0]?.[3]).toMatchObject({
      sourceRepo: repo,
      workItemId: task.id,
      workItemGenerationId: generation,
      propose: true,
    });

    const proposal = loadProposal(proposals[0]!.id);
    expect(proposal).toMatchObject({
      workItemId: task.id,
      workItemGenerationId: generation,
      pendingAuthorityVersion: 1,
      runEventSummary: {
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: proposals[0]!.id,
      },
    });
    expect(verifyPendingProposalAuthorityV1(proposal!).ok).toBe(true);
    expect(isAuthoritativeDurablePendingProposal(proposal, {
      id: proposal!.id,
      repo,
      origin: 'agent',
      kind: 'patch',
      diff: proposal!.diff,
      diffHash: proposal!.diffHash,
      runId: proposal!.runId,
      trajectoryId: proposal!.trajectoryId,
      workItemId: task.id,
      workItemGenerationId: generation,
      isPartial: false,
    }, cfg())).toBe(true);
    expect(readTasks()[0]).toEqual(expect.objectContaining({
      done: true,
      proposalId: proposal!.id,
      proposalDisposition: 'newly-filed',
    }));
  });

  it('retains a failed-verification durable candidate and does not double-file after restart cooldown', async () => {
    writeTasks([{
      id: 'task-real-recheck',
      repo,
      instruction: 'do not double file this proposal',
      attempts: 2,
    }]);
    corruptNextProposal = true;

    const { runSimpleConductor } = await import('../src/core/simple-conductor.js');
    const first = await runSimpleConductor(cfg(), { once: true, dryRun: false, allowCloud: false });
    const { listProposals } = await import('../src/core/inbox/store.js');
    const candidateId = listProposals({ status: 'pending' })[0]!.id;

    expect(first.proposalsFiled).toBe(0);
    expect(first.recoverableFailures).toBe(1);
    expect(mockRunEngineSandboxed).toHaveBeenCalledTimes(1);
    expect(readTasks()[0]).toEqual(expect.objectContaining({
      done: false,
      attempts: 3,
      candidateProposalId: candidateId,
      captureFailureState: 'cooling',
    }));

    writeTasks([{ ...readTasks()[0]!, retryAfter: new Date(Date.now() - 1_000).toISOString() }]);
    const second = await runSimpleConductor(cfg(), { once: true, dryRun: false, allowCloud: false });

    expect(second.tasksAttempted).toBe(0);
    expect(second.recoverableFailures).toBe(1);
    expect(mockRunEngineSandboxed).toHaveBeenCalledTimes(1);
    expect(listProposals({ status: 'pending' })).toHaveLength(1);
    expect(readTasks()[0]).toEqual(expect.objectContaining({
      done: false,
      attempts: 4,
      candidateProposalId: candidateId,
      captureFailureState: 'cooling',
    }));
  });
});
