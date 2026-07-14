/**
 * M48 auto-merge-pass unit tests — runAutoMergePass(cfg).
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - autoMergeProposal (the M47 gate) is MOCKED — the real merge-to-main gate
 *    (worktrees, git, gh, verify commands) NEVER runs here. The mock records
 *    every call and returns a controllable {ok,merged,reason} per proposal id.
 *  - listProposalsDetailed is MOCKED so the pending set is fully controlled (a mix of
 *    frontier / local / undefined engineTier).
 *  - Kill switch is cleared in afterEach.
 *
 * Contract under test (src/core/fleet/automerge-pass.ts):
 *  - DEFAULT OFF: no-op {attempted:0,merged:0} unless cfg.foundry.autoMerge
 *    .enabled === true; the gate is NEVER called.
 *  - When enabled: only 'frontier'-tier proposals are passed to the gate
 *    (local / undefined are skipped); merged count reflects the gate's
 *    merged results.
 *  - Kill switch ON ⇒ immediate no-op {attempted:0}.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { AutoMergeResult } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// HOME isolation — before any module resolves homedir()
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// Mocks — declared before lazy imports.
// ---------------------------------------------------------------------------

// autoMergeProposal (the M47 gate). Records (id) calls; returns a controllable
// result per id via a mutable map (default: merged:false).
const mockAutoMergeProposal = vi.fn();
const mockVerifyProposal = vi.fn();
let mergeResults: Record<string, AutoMergeResult> = {};
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  verifyProposal: (...args: unknown[]) => mockVerifyProposal(...args),
  verifyResultFromProposalResult: (
    result: { ok: boolean; ran: Array<{ kind: 'typecheck' | 'lint' | 'build' | 'test'; cmd: string[] }>; detail: string; baseBranch?: string; baseHead?: string },
    source = 'auto-merge',
    verifiedAt = new Date().toISOString(),
    diffHash?: string,
  ) => ({
    passed: result.ok,
    ...(result.ok ? {} : { failed: [result.detail] }),
    detail: result.detail,
    ran: [...result.ran],
    ...(result.baseBranch ? { baseBranch: result.baseBranch } : {}),
    ...(result.baseHead ? { baseHead: result.baseHead } : {}),
    ...(diffHash ? { diffHash } : {}),
    verifiedAt,
    source,
  }),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (judgeEngine: string | undefined) => {
    const lc = (judgeEngine ?? '').toLowerCase();
    return lc.startsWith('claude') || lc.includes('claude') || lc.startsWith('gpt-5') || lc.startsWith('codex-') || lc === 'codex';
  },
}));

// listProposalsDetailed — returns a controllable proposal set + source quality.
let pendingProposals: Proposal[] = [];
const mockListProposalsDetailed = vi.fn();
const mockSetStatus = vi.fn();
const mockUpdateProposalField = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: (...args: unknown[]) => mockListProposalsDetailed(...args),
  setStatus: (...args: unknown[]) => mockSetStatus(...args),
  updateProposalField: (...args: unknown[]) => mockUpdateProposalField(...args),
}));

// M172: mock the judge chain so these pre-M172 tests remain hermetic.
// judgeProposal returns 'ship' by default so all frontier proposals still
// proceed to autoMergeProposal (preserving the existing test expectations).
const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

const mockReadDecisions = vi.fn(() => []);
const mockRecordDecision = vi.fn();
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  recordDecision: (...args: unknown[]) => mockRecordDecision(...args),
}));

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn(async () => ({
    model: 'claude-opus-4-5',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
  })),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks + HOME isolation
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import { readAgentActions } from '../src/core/fleet/agent-action-ledger.js';
import { setKill } from '../src/core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProposal(id: string, over?: Partial<Proposal>): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'swarm',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'summary',
    diff: 'diff --git a/x.ts b/x.ts\n',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function enabledCfg(): AshlrConfig {
  return { version: 1, foundry: { autoMerge: { enabled: true } } } as AshlrConfig;
}

function managerGateCfg(): AshlrConfig {
  return { version: 1, foundry: { autoMerge: { enabled: true, managerGate: true } } } as AshlrConfig;
}

function evidenceCfg(): AshlrConfig {
  return { version: 1, foundry: { autoMerge: { enabled: true, trustBasis: 'evidence' } } } as AshlrConfig;
}

function verificationCfg(): AshlrConfig {
  return { version: 1, foundry: { autoMerge: { enabled: true, trustBasis: 'verification' } } } as AshlrConfig;
}

function proposalRead(
  proposals: Proposal[],
  over?: Partial<{ sourceState: 'missing' | 'healthy' | 'degraded'; complete: boolean }>,
) {
  return {
    proposals,
    sourceState: 'healthy' as const,
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesDiscovered: proposals.length,
    filesRead: proposals.length,
    bytesRead: 0,
    invalidFiles: 0,
    unreadableFiles: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m48-amp-home-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = tmpHome;

  mockAutoMergeProposal.mockReset();
  mockVerifyProposal.mockReset();
  mockListProposalsDetailed.mockReset();
  mockSetStatus.mockReset();
  mockUpdateProposalField.mockReset();
  mockJudgeProposal.mockReset();
  mockReadDecisions.mockReset();
  mockRecordDecision.mockReset();
  mergeResults = {};
  pendingProposals = [];

  mockReadDecisions.mockReturnValue([]);
  mockListProposalsDetailed.mockImplementation(() => proposalRead(pendingProposals));
  mockSetStatus.mockReturnValue(true);
  mockUpdateProposalField.mockReturnValue(true);
  mockAutoMergeProposal.mockImplementation(async (id: string) => {
    return mergeResults[id] ?? { ok: false, merged: false, reason: 'default-not-merged' };
  });
  mockVerifyProposal.mockResolvedValue({
    ok: true,
    ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
    detail: 'mock verification passed',
    baseBranch: 'main',
    baseHead: '0123456789abcdef',
  });
  // M172: default judge verdict is 'ship' so frontier proposals reach autoMergeProposal.
  mockJudgeProposal.mockResolvedValue({
    proposalId: 'any',
    verdict: 'ship',
    value: 5, correctness: 5, scope: 1, alignment: 5,
    rationale: 'mock ship — m48 compat',
    wouldMerge: true,
  });
  // M176: resolveFrontierJudgeClient default — returns a working frontier client.
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
  });

  // Ensure kill switch off for the standard path (fresh HOME = off anyway).
  try { setKill(false); } catch { /* ignore */ }
});

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  vi.clearAllMocks();
});

// ===========================================================================
// DISABLED — DEFAULT OFF: no-op + gate never called
// ===========================================================================

describe('M48 runAutoMergePass — DISABLED is a no-op', () => {
  it('returns {attempted:0,merged:0} when cfg.foundry is absent', async () => {
    pendingProposals = [makeProposal('p1', { engineTier: 'frontier' })];
    const out = await runAutoMergePass({ version: 1 } as AshlrConfig);
    expect(out.attempted).toBe(0);
    expect(out.merged).toBe(0);
    expect(out.results).toEqual([]);
  });

  it('returns {attempted:0,merged:0} when autoMerge.enabled === false', async () => {
    pendingProposals = [makeProposal('p1', { engineTier: 'frontier' })];
    const cfg = { version: 1, foundry: { autoMerge: { enabled: false } } } as AshlrConfig;
    const out = await runAutoMergePass(cfg);
    expect(out.attempted).toBe(0);
    expect(out.merged).toBe(0);
  });

  it('NEVER calls autoMergeProposal when disabled', async () => {
    pendingProposals = [makeProposal('p1', { engineTier: 'frontier' })];
    await runAutoMergePass({ version: 1 } as AshlrConfig);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('does not even list proposals when disabled (short-circuits first)', async () => {
    await runAutoMergePass({ version: 1 } as AshlrConfig);
    expect(mockListProposalsDetailed).not.toHaveBeenCalled();
  });
});

describe('M48 runAutoMergePass — proposal source authority', () => {
  const assertNoMutationProgression = () => {
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockUpdateProposalField).not.toHaveBeenCalled();
    expect(mockVerifyProposal).not.toHaveBeenCalled();
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  };

  it.each([
    ['degraded', { sourceState: 'degraded' as const, complete: true }],
    ['incomplete', { sourceState: 'healthy' as const, complete: false }],
  ])('aborts before all mutations when the initial source is %s', async (_label, quality) => {
    const adversarial = makeProposal('initial-untrusted', {
      engineTier: 'frontier',
    });
    mockListProposalsDetailed.mockReturnValue(proposalRead([adversarial], quality));

    const out = await runAutoMergePass(verificationCfg());

    expect(out).toMatchObject({ attempted: 0, merged: 0, judged: 0, ttlRejected: 0 });
    expect(mockListProposalsDetailed).toHaveBeenCalledWith({ status: 'pending', requireComplete: true });
    assertNoMutationProgression();
  });

  it.each([
    ['degraded', { sourceState: 'degraded' as const, complete: true }],
    ['incomplete', { sourceState: 'healthy' as const, complete: false }],
  ])('aborts before all mutations when the cleanup refresh is %s', async (_label, quality) => {
    const stale = makeProposal('refresh-untrusted', {
      engineTier: 'local',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const actionable = makeProposal('refresh-actionable', {
      engineTier: 'frontier',
    });
    mockListProposalsDetailed
      .mockReturnValueOnce(proposalRead([stale, actionable]))
      .mockReturnValueOnce(proposalRead([stale, actionable], quality));

    const out = await runAutoMergePass(verificationCfg());

    expect(out).toMatchObject({ attempted: 0, merged: 0, judged: 0, ttlRejected: 0 });
    expect(mockListProposalsDetailed).toHaveBeenCalledTimes(2);
    expect(mockListProposalsDetailed).toHaveBeenNthCalledWith(1, { status: 'pending', requireComplete: true });
    expect(mockListProposalsDetailed).toHaveBeenNthCalledWith(2, { status: 'pending', requireComplete: true });
    assertNoMutationProgression();
  });
});

describe('M48 runAutoMergePass — cleanup persistence authority', () => {
  const invalidProposal = (id: string, createdAt: string): Proposal => makeProposal(id, {
    engineTier: 'local',
    workSource: 'goal',
    title: `Fix regression in /tmp/.ashlr/tmp/vwt-${id}/src.ts`,
    createdAt,
  });

  it('counts and filters only durably rejected invalid proposals', async () => {
    const invalid = invalidProposal('invalid-persisted', '2026-07-14T00:00:00.000Z');
    const actionable = makeProposal('actionable-after-cleanup', { engineTier: 'frontier' });
    pendingProposals = [actionable, invalid];

    const out = await runAutoMergePass(enabledCfg());

    expect(out.invalidRejected).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledWith(
      invalid.id,
      'rejected',
      undefined,
      expect.stringContaining('ephemeral Ashlr temp-worktree'),
      undefined,
      {},
      'pending',
    );
    expect(mockAutoMergeProposal).toHaveBeenCalledWith(actionable.id, expect.anything());
    expect(mockAutoMergeProposal).not.toHaveBeenCalledWith(invalid.id, expect.anything());
  });

  it('stops before judge or merge when invalid cleanup persistence returns false', async () => {
    pendingProposals = [
      invalidProposal('invalid-not-persisted', '2026-07-14T00:00:00.000Z'),
      makeProposal('actionable-blocked', { engineTier: 'frontier' }),
    ];
    mockSetStatus.mockReturnValueOnce(false);

    const out = await runAutoMergePass(enabledCfg());

    expect(out).toMatchObject({ invalidRejected: 0, ttlRejected: 0, judged: 0, attempted: 0 });
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('stops before judge or merge when TTL cleanup persistence returns false', async () => {
    pendingProposals = [
      makeProposal('ttl-not-persisted', {
        engineTier: 'local',
        createdAt: '2000-01-01T00:00:00.000Z',
      }),
      makeProposal('actionable-after-ttl', { engineTier: 'frontier' }),
    ];
    mockSetStatus.mockReturnValueOnce(false);

    const out = await runAutoMergePass(enabledCfg());

    expect(out).toMatchObject({ invalidRejected: 0, ttlRejected: 0, judged: 0, attempted: 0 });
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('checks the kill switch again before every cleanup write', async () => {
    pendingProposals = [
      invalidProposal('invalid-first', '2026-07-13T00:00:00.000Z'),
      invalidProposal('invalid-second', '2026-07-14T00:00:00.000Z'),
    ];
    mockSetStatus.mockImplementationOnce(() => {
      setKill(true);
      return true;
    });

    const out = await runAutoMergePass(enabledCfg());

    expect(out.invalidRejected).toBe(1);
    expect(mockSetStatus).toHaveBeenCalledTimes(1);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

});

describe('M48 runAutoMergePass — mutation progression', () => {
  it('does not judge or merge when verification evidence persistence returns false', async () => {
    pendingProposals = [makeProposal('verification-not-persisted', { engineTier: 'frontier' })];
    mockUpdateProposalField.mockReturnValueOnce(false);

    const out = await runAutoMergePass(verificationCfg());

    expect(mockVerifyProposal).toHaveBeenCalledTimes(1);
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'verification-not-persisted',
      expect.objectContaining({ verifyResult: expect.any(Object) }),
    );
    expect(out.skipped).toContainEqual(expect.objectContaining({
      proposalId: 'verification-not-persisted',
      check: 'verify-before-judge-persistence',
    }));
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ENABLED — only frontier proposals go to the gate; merged count reflects it
// ===========================================================================

describe('M48 runAutoMergePass — ENABLED frontier-only filtering', () => {
  it('calls autoMergeProposal ONLY for frontier-tier proposals', async () => {
    pendingProposals = [
      makeProposal('frontier-1', { engineTier: 'frontier' }),
      makeProposal('local-1', { engineTier: 'local' }),
      makeProposal('undef-1'), // engineTier undefined
      makeProposal('frontier-2', { engineTier: 'frontier' }),
    ];

    await runAutoMergePass(enabledCfg());

    const calledIds = mockAutoMergeProposal.mock.calls.map((c) => c[0]);
    expect(calledIds).toEqual(['frontier-1', 'frontier-2']);
    expect(calledIds).not.toContain('local-1');
    expect(calledIds).not.toContain('undef-1');
  });

  it('attempted counts only frontier proposals', async () => {
    pendingProposals = [
      makeProposal('frontier-1', { engineTier: 'frontier' }),
      makeProposal('local-1', { engineTier: 'local' }),
      makeProposal('undef-1'),
    ];
    const out = await runAutoMergePass(enabledCfg());
    expect(out.attempted).toBe(1);
  });

  it('merged count reflects the gate merged results', async () => {
    pendingProposals = [
      makeProposal('frontier-1', { engineTier: 'frontier' }),
      makeProposal('frontier-2', { engineTier: 'frontier' }),
      makeProposal('frontier-3', { engineTier: 'frontier' }),
    ];
    mergeResults = {
      'frontier-1': { ok: true, merged: true, reason: 'merged ok' },
      'frontier-2': { ok: false, merged: false, reason: 'risk too high' },
      'frontier-3': { ok: true, merged: true, reason: 'merged ok' },
    };

    const out = await runAutoMergePass(enabledCfg());
    expect(out.attempted).toBe(3);
    expect(out.merged).toBe(2);
    expect(out.results).toHaveLength(3);
  });

  it('passes the cfg through to autoMergeProposal', async () => {
    pendingProposals = [makeProposal('frontier-1', { engineTier: 'frontier' })];
    const cfg = enabledCfg();
    await runAutoMergePass(cfg);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('frontier-1', cfg);
  });

  it('lists ONLY pending proposals (status filter)', async () => {
    pendingProposals = [makeProposal('frontier-1', { engineTier: 'frontier' })];
    await runAutoMergePass(enabledCfg());
    expect(mockListProposalsDetailed).toHaveBeenCalledWith({ status: 'pending', requireComplete: true });
  });

  it('records a signed attestation for GPT-5/Codex frontier judges', async () => {
    pendingProposals = [makeProposal('frontier-gpt', {
      engineTier: 'frontier',
      workItemId: '/tmp/repo:issue:frontier-gpt',
      workSource: 'issue',
      runId: 'run-frontier-gpt',
      trajectoryId: 'trajectory-frontier-gpt',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        assignedBy: 'gateway',
        reason: 'test route',
        routerPolicyVersion: 'router-policy-test',
      },
      runEventSummary: {
        runId: 'run-frontier-gpt',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'frontier-gpt',
        diffFiles: 1,
        diffLines: 8,
        actionCounts: { proposalCreated: 1, totalSteps: 3 },
      },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'merge-main',
        gateCount: 8,
      },
      routerPolicyVersion: 'router-policy-test',
      learningEpoch: '2026-07-10',
    })];
    mockResolveFrontierJudgeClient.mockReturnValue({
      model: 'gpt-5.5',
      complete: async () => '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"mock"}',
    });

    await runAutoMergePass(managerGateCfg());

    const judgedCall = mockRecordDecision.mock.calls.find((c) => c[0]?.action === 'judged');
    expect(judgedCall).toBeDefined();
    expect(judgedCall?.[0]).toMatchObject({
      proposalId: 'frontier-gpt',
      action: 'judged',
      engine: 'gpt-5.5',
      model: 'gpt-5.5',
      verdict: 'ship',
      workItemId: '/tmp/repo:issue:frontier-gpt',
      workSource: 'issue',
      runId: 'run-frontier-gpt',
      trajectoryId: 'trajectory-frontier-gpt',
      routeSnapshot: {
        backend: 'codex',
        tier: 'frontier',
        model: 'gpt-5.5',
        assignedBy: 'gateway',
        reason: 'test route',
        routerPolicyVersion: 'router-policy-test',
      },
      runEventSummary: {
        runId: 'run-frontier-gpt',
        status: 'done',
        proposalCreated: true,
        proposalId: 'frontier-gpt',
        diffFiles: 1,
        diffLines: 8,
      },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'verification',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'merge-main',
        gateCount: 8,
      },
      learningSource: 'decision-ledger',
      labelBasis: 'judge-verdict',
      routerPolicyVersion: 'router-policy-test',
      learningEpoch: '2026-07-10',
    });
    expect(typeof judgedCall?.[0]?.judgeAttestation).toBe('string');
    expect(judgedCall?.[0]?.judgeAttestation).toHaveLength(64);
    expect(mockReadDecisions).toHaveBeenCalledWith(expect.objectContaining({ requireComplete: true }));
  });

  it('stops judge and merge progression when the decisions source is degraded', async () => {
    pendingProposals = [makeProposal('degraded-decisions', { engineTier: 'frontier' })];
    const degraded: unknown[] = [];
    Object.defineProperty(degraded, 'sourceQuality', {
      value: { sourceState: 'degraded', complete: false },
      enumerable: false,
    });
    mockReadDecisions.mockReturnValue(degraded);

    const out = await runAutoMergePass(managerGateCfg());

    expect(out.skipped).toContainEqual(expect.objectContaining({
      proposalId: 'degraded-decisions',
      check: 'decision-source',
    }));
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('records auto-merge verification lifecycle telemetry in evidence-backed mode', async () => {
    pendingProposals = [makeProposal('evidence-verify', {
      engineTier: 'local',
      workItemId: '/tmp/repo:goal:evidence-verify',
      workSource: 'goal',
      runId: 'run-evidence-verify',
      trajectoryId: 'trajectory-evidence-verify',
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'local',
        model: 'qwen2.5-coder',
        assignedBy: 'daemon',
        reason: 'evidence mode local verification',
        routerPolicyVersion: 'router-policy-test',
      },
      runEventSummary: {
        runId: 'run-evidence-verify',
        status: 'done',
        outcome: 'proposal-created',
        proposalCreated: true,
        proposalId: 'evidence-verify',
        diffFiles: 1,
        diffLines: 3,
        actionCounts: { proposalCreated: 1, totalSteps: 2 },
      },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'evidence',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'merge-main',
      },
      routerPolicyVersion: 'router-policy-test',
      learningEpoch: '2026-07-10',
    })];
    mergeResults['evidence-verify'] = { ok: true, merged: true, reason: 'merged' };
    const cfg = evidenceCfg();

    const out = await runAutoMergePass(cfg);

    expect(out.verifyBeforeJudgeRan).toBe(1);
    expect(out.attempted).toBe(1);
    expect(out.merged).toBe(1);
    expect(mockVerifyProposal).toHaveBeenCalledTimes(1);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('evidence-verify', cfg);
    const events = readAgentActions().filter((event) => event.action.startsWith('auto-merge:verify-before-merge'));
    expect(events.map((event) => event.action)).toEqual([
      'auto-merge:verify-before-merge-finish',
      'auto-merge:verify-before-merge-start',
    ]);
    expect(events[0]).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      outcome: 'verified',
      proposalId: 'evidence-verify',
      repo: '/tmp/repo',
      itemId: '/tmp/repo:goal:evidence-verify',
      source: 'goal',
      runId: 'run-evidence-verify',
      trajectoryId: 'trajectory-evidence-verify',
      routeSnapshot: {
        backend: 'local-coder',
        tier: 'local',
        model: 'qwen2.5-coder',
        assignedBy: 'daemon',
        reason: 'evidence mode local verification',
        routerPolicyVersion: 'router-policy-test',
      },
      runEventSummary: {
        runId: 'run-evidence-verify',
        status: 'done',
        proposalCreated: true,
        proposalId: 'evidence-verify',
        diffFiles: 1,
        diffLines: 3,
      },
      evidenceOutcome: {
        target: 'main',
        trustBasis: 'evidence',
        riskClass: 'low',
        verificationPassed: true,
        policyAllowed: true,
        policyAction: 'merge-main',
      },
      learningSource: 'agent-action',
      labelBasis: 'verification-outcome',
      routerPolicyVersion: 'router-policy-test',
      learningEpoch: '2026-07-10',
      counts: { commands: 1 },
    });
    expect(events[1]).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      outcome: 'unknown',
      proposalId: 'evidence-verify',
      repo: '/tmp/repo',
      itemId: '/tmp/repo:goal:evidence-verify',
      source: 'goal',
      runId: 'run-evidence-verify',
      trajectoryId: 'trajectory-evidence-verify',
      learningSource: 'agent-action',
      labelBasis: 'verification-outcome',
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('diff --git');
    expect(serialized).not.toContain('stdout');
    expect(serialized).not.toContain('stderr');
  });

  it('records failed auto-merge verification telemetry before skipping merge', async () => {
    pendingProposals = [makeProposal('evidence-fail', { engineTier: 'local' })];
    mockVerifyProposal.mockResolvedValueOnce({
      ok: false,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      detail: 'mock verification failed',
    });

    const out = await runAutoMergePass(evidenceCfg());

    expect(out.verifyBeforeJudgeRan).toBe(1);
    expect(out.attempted).toBe(0);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    const finish = readAgentActions().find((event) => event.action === 'auto-merge:verify-before-merge-finish');
    expect(finish).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      outcome: 'failed',
      proposalId: 'evidence-fail',
      reason: 'mock verification failed',
      counts: { commands: 1 },
    });
  });

  it('returns {attempted:0,merged:0} when there are no frontier proposals', async () => {
    pendingProposals = [
      makeProposal('local-1', { engineTier: 'local' }),
      makeProposal('undef-1'),
    ];
    const out = await runAutoMergePass(enabledCfg());
    expect(out.attempted).toBe(0);
    expect(out.merged).toBe(0);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// KILL-SWITCH — ON ⇒ immediate no-op even when enabled
// ===========================================================================

describe('M48 runAutoMergePass — KILL-SWITCH halts the pass', () => {
  it('returns {attempted:0} and calls the gate for nobody when kill switch is on', async () => {
    pendingProposals = [
      makeProposal('frontier-1', { engineTier: 'frontier' }),
      makeProposal('frontier-2', { engineTier: 'frontier' }),
    ];
    setKill(true);

    const out = await runAutoMergePass(enabledCfg());

    expect(out.attempted).toBe(0);
    expect(out.merged).toBe(0);
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});
