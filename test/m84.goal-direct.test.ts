/**
 * M84 — `ashlr goal --direct` mode.
 *
 * Asserts that --direct:
 *  1. Skips milestone planning entirely and invokes runGoal exactly once with
 *     the verbatim objective + sandboxEngine:true + requireSandbox:true (the
 *     same frontier sandboxed path the daemon uses for non-builtin backends).
 *  2. Requires --project; errors clearly (exit 2) when absent.
 *  3. Correlates only the exact run outcome proposal id through a healthy,
 *     complete durable inbox read and signed pending-authority validation.
 *  4. Leaves the default (no --direct) path unchanged — it still creates a goal,
 *     plans milestones, and advances via cmdGoals.
 *
 * Everything outward (runGoal, routeBackend, assertMayMutate, inbox, config,
 * cmdGoals, listGoals store) is MOCKED — no real ~/.ashlr, no real engine runs.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the module-under-test is imported.
// ---------------------------------------------------------------------------

const mockRunGoal = vi.fn();
const mockLoadRun = vi.fn();
const mockRouteBackend = vi.fn();
const mockAssertMayMutate = vi.fn();
const mockListProposalsDetailed = vi.fn();
const mockIsAuthoritativeDurablePendingProposal = vi.fn();
const mockLoadConfig = vi.fn();
const mockCmdGoals = vi.fn();
const mockListGoals = vi.fn();

vi.mock('../src/core/run/orchestrator.js', () => ({
  runGoal: (...args: unknown[]) => mockRunGoal(...args),
  loadRun: (...args: unknown[]) => mockLoadRun(...args),
}));

vi.mock('../src/core/fleet/router.js', () => ({
  routeBackend: (...args: unknown[]) => mockRouteBackend(...args),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  assertMayMutate: (...args: unknown[]) => mockAssertMayMutate(...args),
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: (...args: unknown[]) => mockListProposalsDetailed(...args),
}));

vi.mock('../src/core/inbox/pending-authority.js', () => ({
  isAuthoritativeDurablePendingProposal: (...args: unknown[]) => mockIsAuthoritativeDurablePendingProposal(...args),
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

function makeRunState(id = 'run-direct-1', proposalId = 'prop-direct-1') {
  return {
    id,
    usage: { tokensIn: 120, tokensOut: 30, steps: 4, estCostUsd: 0.12 },
    status: 'done',
    trajectoryId: `run:${id}`,
    proposalOutcome: {
      kind: 'filed',
      proposalId,
      reason: 'proposal filed',
      isPartial: false,
    },
    runEventSummary: {
      runId: id,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
      proposalId,
    },
  };
}

function makeProposal(
  id = 'prop-direct-1',
  repo = '/tmp/enrolled-repo',
  runId = 'run-direct-1',
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    origin: 'agent',
    kind: 'patch',
    repo,
    status: 'pending',
    runId,
    ...overrides,
  };
}

function healthyProposalRead(proposals = [makeProposal()]) {
  return {
    proposals,
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesDiscovered: proposals.length,
    filesRead: proposals.length,
    bytesRead: 1,
    invalidFiles: 0,
    unreadableFiles: 0,
  };
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
  mockLoadRun.mockReset();
  mockRouteBackend.mockReset();
  mockAssertMayMutate.mockReset();
  mockListProposalsDetailed.mockReset();
  mockIsAuthoritativeDurablePendingProposal.mockReset();
  mockLoadConfig.mockReset();
  mockCmdGoals.mockReset();
  mockListGoals.mockReset();

  // Sensible defaults.
  mockAssertMayMutate.mockImplementation(() => { /* enrolled, allowed */ });
  mockLoadConfig.mockReturnValue(makeCfg());
  mockRouteBackend.mockReturnValue({ backend: 'codex', tier: 'frontier', reason: 'frontier-first' });
  mockRunGoal.mockResolvedValue(makeRunState());
  mockLoadRun.mockReturnValue(makeRunState());
  mockListProposalsDetailed.mockReturnValue(healthyProposalRead());
  mockIsAuthoritativeDurablePendingProposal.mockReturnValue(true);

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

  it('refuses builtin routing before runGoal instead of accepting a zero-yield fallback', async () => {
    mockRouteBackend.mockReturnValue({ backend: 'builtin', tier: 'low', reason: 'no productive engine' });

    const rc = await cmdGoal([
      'ship exact run', '--project', '/tmp/enrolled-repo', '--direct', '--json',
    ]);

    expect(rc).toBe(1);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(JSON.parse(String((console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0]))).toMatchObject({
      ok: false,
      terminalStage: 'admission',
      blockerCode: 'productive-backend-unavailable',
      backend: 'builtin',
    });
  });

  it('emits one bounded machine-readable direct result without objective or path data', async () => {
    const rc = await cmdGoal([
      'secret objective text',
      '--project', '/tmp/enrolled-repo',
      '--direct',
      '--json',
    ]);

    expect(rc).toBe(0);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const result = JSON.parse(String(calls[0]![0])) as Record<string, unknown>;
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'direct-proposal',
      ok: true,
      terminalStage: 'proposal-correlation',
      blockerCode: null,
      backend: 'codex',
      runId: 'run-direct-1',
      proposalId: 'prop-direct-1',
      usage: null,
      usageObserved: false,
      wrapperEffects: { inboxApplyInvoked: false, inboxMergeInvoked: false },
      authority: {
        wrapperController: 'proposal-only',
        unattendedExecutionAuthorized: false,
        verificationProven: false,
        confinementAttested: false,
        environmentUnchangedAttested: false,
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret objective text');
    expect(JSON.stringify(result)).not.toContain('/tmp/enrolled-repo');
  });

  it('returns a bounded JSON blocker without leaking proposal-store detail', async () => {
    mockListProposalsDetailed.mockReturnValue({
      ...healthyProposalRead(),
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['secret-store-detail'],
      invalidFiles: 1,
    });

    const rc = await cmdGoal([
      'ship exact run', '--project', '/tmp/enrolled-repo', '--direct', '--json',
    ]);

    expect(rc).toBe(1);
    const output = String((console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      terminalStage: 'proposal-correlation',
      blockerCode: 'proposal-source-degraded',
      proposalId: null,
    });
    expect(output).not.toContain('secret-store-detail');
  });

  it('returns one bounded JSON document when the durable run ledger throws', async () => {
    mockLoadRun.mockImplementation(() => { throw new Error('secret-run-ledger-detail'); });

    const rc = await cmdGoal([
      'ship exact run', '--project', '/tmp/enrolled-repo', '--direct', '--json',
    ]);

    expect(rc).toBe(1);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const output = String(calls[0]![0]);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      terminalStage: 'proposal-correlation',
      blockerCode: 'run-ledger-unavailable',
    });
    expect(output).not.toContain('secret-run-ledger-detail');
  });

  it('returns exit 0 only when the exact filed proposal has durable pending authority', async () => {
    const rc = await cmdGoal(['create docs/FOO.md with one line', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(0);
    expect(mockListProposalsDetailed).toHaveBeenCalledExactlyOnceWith({ requireComplete: true });
  });

  it('describes only the authority it actually proved', async () => {
    const rc = await cmdGoal(['create docs/FOO.md with one line', '--project', '/tmp/enrolled-repo', '--direct']);
    const output = (console.log as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('\n');

    expect(rc).toBe(0);
    expect(output).toContain('PENDING');
    expect(output).toContain('did not invoke inbox apply or merge');
    expect(output).toContain('not independently attested unchanged');
    expect(output).not.toContain('No real working tree was mutated');
  });

  it('correlates a canonical proposal for a symlink project caller', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-m84-goal-alias-'));
    try {
      const physical = join(root, 'physical-repo');
      const alias = join(root, 'repo-alias');
      mkdirSync(physical);
      symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir');
      mockRunGoal.mockResolvedValue(makeRunState('run-direct-1', 'prop-canonical'));
      mockLoadRun.mockReturnValue(makeRunState('run-direct-1', 'prop-canonical'));
      mockListProposalsDetailed.mockReturnValue(
        healthyProposalRead([makeProposal('prop-canonical', realpathSync.native(physical))]),
      );

      const rc = await cmdGoal(['ship through alias', '--project', alias, '--direct']);

      expect(rc).toBe(0);
      expect((mockRunGoal.mock.calls[0]![2] as { cwd: string }).cwd).toBe(alias);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exit 1 when the filed proposal is absent from the durable snapshot', async () => {
    mockListProposalsDetailed.mockReturnValue(healthyProposalRead([]));

    const rc = await cmdGoal(['create docs/FOO.md with one line', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
  });

  it('passes one preallocated work item id through the run and exact authority expectation', async () => {
    const rc = await cmdGoal(['create docs/FOO.md with one line', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(0);
    const opts = mockRunGoal.mock.calls[0]![2] as { workItemId?: string };
    expect(opts.workItemId).toMatch(/^direct-/);
    const expected = mockIsAuthoritativeDurablePendingProposal.mock.calls[0]![1] as {
      workItemId: string;
      id: string;
      runId: string;
      trajectoryId: string;
    };
    expect(expected).toMatchObject({
      workItemId: opts.workItemId,
      id: 'prop-direct-1',
      runId: 'run-direct-1',
      trajectoryId: 'run:run-direct-1',
    });
  });

  it('does not substitute an unrelated concurrent proposal from the same repository', async () => {
    mockRunGoal.mockResolvedValue(makeRunState('run-direct-1', 'prop-unrelated'));
    mockLoadRun.mockReturnValue(makeRunState('run-direct-1', 'prop-unrelated'));
    mockListProposalsDetailed.mockReturnValue(
      healthyProposalRead([
        makeProposal('prop-unrelated', '/tmp/enrolled-repo', 'run-other'),
        makeProposal('prop-direct-1'),
      ]),
    );

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockIsAuthoritativeDurablePendingProposal).not.toHaveBeenCalled();
  });

  it('allows unrelated proposals carrying a different run identity', async () => {
    mockListProposalsDetailed.mockReturnValue(
      healthyProposalRead([
        makeProposal('prop-other', '/tmp/enrolled-repo', 'run-other'),
        makeProposal('prop-direct-1'),
      ]),
    );

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(0);
  });

  it('fails closed when multiple proposals claim the same run', async () => {
    mockListProposalsDetailed.mockReturnValue(
      healthyProposalRead([makeProposal('prop-direct-1'), makeProposal('prop-conflict')]),
    );

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockIsAuthoritativeDurablePendingProposal).not.toHaveBeenCalled();
  });

  it.each([
    ['applied', 'patch', 'agent'],
    ['approved', 'patch', 'agent'],
    ['rejected', 'patch', 'agent'],
    ['pending', 'pr', 'agent'],
    ['pending', 'note', 'agent'],
    ['pending', 'patch', 'manual'],
  ])('fails closed when a same-run %s/%s/%s row coexists', async (status, kind, origin) => {
    mockListProposalsDetailed.mockReturnValue(
      healthyProposalRead([
        makeProposal('prop-direct-1'),
        makeProposal('prop-conflict', '/tmp/enrolled-repo', 'run-direct-1', { status, kind, origin }),
      ]),
    );

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockIsAuthoritativeDurablePendingProposal).not.toHaveBeenCalled();
  });

  it('fails closed on a degraded or incomplete proposal source', async () => {
    mockListProposalsDetailed.mockReturnValue({
      ...healthyProposalRead(),
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['invalid-file'],
      invalidFiles: 1,
    });

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
  });

  it('fails closed when signed pending authority validation refuses the exact proposal', async () => {
    mockIsAuthoritativeDurablePendingProposal.mockReturnValue(false);

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
  });

  it.each([
    {
      kind: 'proposal-disabled',
      proposalId: 'prop-direct-1',
      reason: 'deduplicated',
    },
    {
      kind: 'filed',
      proposalId: 'prop-direct-1',
      reason: 'partial',
      isPartial: true,
    },
    { kind: 'empty-diff', reason: 'no changes' },
  ])('does not treat $kind as an authoritative filed proposal', async (proposalOutcome) => {
    mockRunGoal.mockResolvedValue({
      ...makeRunState(),
      proposalOutcome,
    });

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockListProposalsDetailed).not.toHaveBeenCalled();
  });

  it.each(['aborted', 'failed', 'running'])('fails closed on a %s run even when it reports a filed proposal', async (status) => {
    mockRunGoal.mockResolvedValue({ ...makeRunState(), status });

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockLoadRun).not.toHaveBeenCalled();
    expect(mockListProposalsDetailed).not.toHaveBeenCalled();
    const output = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(output).toContain('[run-not-done]');
  });

  it('preserves required sandbox failure as a dedicated JSON blocker', async () => {
    mockRunGoal.mockResolvedValue({
      ...makeRunState(),
      status: 'failed',
      proposalOutcome: {
        kind: 'sandbox-unavailable',
        reason: 'required sandbox unavailable; fallback refused',
      },
    });

    const rc = await cmdGoal([
      'ship exact run', '--project', '/tmp/enrolled-repo', '--direct', '--json',
    ]);

    expect(rc).toBe(1);
    expect(JSON.parse(String((console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0]))).toMatchObject({
      blockerCode: 'sandbox-unavailable',
      proposalId: null,
    });
  });

  it.each([
    ['wrong status', { status: 'aborted' }],
    ['wrong outcome', { outcome: 'gate-blocked' }],
    ['false creation', { proposalCreated: false }],
    ['wrong proposal id', { proposalId: 'prop-other' }],
    ['wrong run id', { runId: 'run-other' }],
  ])('fails closed on returned run summary contradiction: %s', async (_case, summaryPatch) => {
    const state = makeRunState();
    mockRunGoal.mockResolvedValue({
      ...state,
      runEventSummary: { ...state.runEventSummary, ...summaryPatch },
    });

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockLoadRun).not.toHaveBeenCalled();
    expect(mockListProposalsDetailed).not.toHaveBeenCalled();
  });

  it.each([
    ['missing ledger', null],
    ['wrong trajectory', { ...makeRunState(), trajectoryId: 'run:other' }],
    ['wrong status', { ...makeRunState(), status: 'aborted' }],
    [
      'wrong durable summary',
      {
        ...makeRunState(),
        runEventSummary: { ...makeRunState().runEventSummary, proposalCreated: false },
      },
    ],
  ])('fails closed on durable run contradiction: %s', async (_case, durableRun) => {
    mockLoadRun.mockReturnValue(durableRun);

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    expect(mockListProposalsDetailed).not.toHaveBeenCalled();
  });

  it('emits a bounded source-quality blocker without leaking store details', async () => {
    mockListProposalsDetailed.mockReturnValue({
      ...healthyProposalRead(),
      sourceState: 'degraded',
      complete: false,
      stopReasons: ['invalid-file'],
      invalidFiles: 1,
    });

    const rc = await cmdGoal(['ship exact run', '--project', '/tmp/enrolled-repo', '--direct']);

    expect(rc).toBe(1);
    const output = (process.stderr.write as ReturnType<typeof vi.fn>).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .join('');
    expect(output).toContain('[proposal-source-degraded]');
    expect(output).not.toContain('invalid-file');
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

describe('cmdGoal --direct — strict agent-facing options', () => {
  it.each([
    ['unknown option', ['ship', '--project', '/tmp/enrolled-repo', '--direct', '--proove']],
    ['missing project value', ['ship', '--project', '--direct']],
    ['duplicate direct', ['ship', '--project', '/tmp/enrolled-repo', '--direct', '--direct']],
    ['conflicting modes', ['ship', '--project', '/tmp/enrolled-repo', '--direct', '--plan-only']],
    ['json without direct', ['ship', '--project', '/tmp/enrolled-repo', '--json']],
  ])('returns usage error for %s', async (_case, args) => {
    expect(await cmdGoal(args)).toBe(2);
    expect(mockRunGoal).not.toHaveBeenCalled();
    expect(mockCmdGoals).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid arguments', ['ship', '--direct', '--json', '--project', '/tmp/enrolled-repo', '--wat'], 'invalid-arguments'],
    ['missing objective', ['--direct', '--json', '--project', '/tmp/enrolled-repo'], 'objective-required'],
    ['missing project', ['ship', '--direct', '--json'], 'project-required'],
  ])('emits the same complete JSON schema for %s', async (_case, args, blockerCode) => {
    const rc = await cmdGoal(args);

    expect(rc).toBe(2);
    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const result = JSON.parse(String(calls[0]![0])) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual([
      'authority', 'backend', 'blockerCode', 'mode', 'ok', 'proposalId', 'runId',
      'schemaVersion', 'terminalStage', 'usage', 'usageObserved', 'wrapperEffects',
    ]);
    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'direct-proposal',
      ok: false,
      terminalStage: 'usage',
      blockerCode,
      usage: null,
      usageObserved: false,
    });
  });

  it('emits a bounded JSON admission result when config or routing throws', async () => {
    mockLoadConfig.mockImplementation(() => { throw new Error('secret-config-detail'); });

    const rc = await cmdGoal([
      'ship', '--project', '/tmp/enrolled-repo', '--direct', '--json',
    ]);

    expect(rc).toBe(1);
    const output = String((console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(JSON.parse(output)).toMatchObject({
      terminalStage: 'admission',
      blockerCode: 'routing-unavailable',
    });
    expect(output).not.toContain('secret-config-detail');
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
const ORCHESTRATOR_SRC = readFileSync(pathResolve(HERE, '../src/core/run/orchestrator.ts'), 'utf8');
const SANDBOX_ENGINE_SRC = readFileSync(pathResolve(HERE, '../src/core/run/sandboxed-engine.ts'), 'utf8');

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

  it('the direct core path reserves stdout for the one JSON document', () => {
    expect(ORCHESTRATOR_SRC).not.toMatch(/console\.log\s*\(/);
    expect(SANDBOX_ENGINE_SRC).not.toMatch(/console\.log\s*\(/);
  });
});
