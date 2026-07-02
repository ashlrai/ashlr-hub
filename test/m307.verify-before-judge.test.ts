/**
 * M307 — verification-mode auto-merge verifies before spending judge calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { AutoMergeResult, VerifyProposalResult } from '../src/core/inbox/merge.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';

const docDiff = [
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const mockAutoMergeProposal = vi.fn();
const mockVerifyProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
  return {
    ...actual,
    autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
    verifyProposal: (...args: unknown[]) => mockVerifyProposal(...args),
  };
});

const mockListProposals = vi.fn();
const mockUpdateProposalField = vi.fn();
const mockSetStatus = vi.fn();
vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposals: (...args: unknown[]) => mockListProposals(...args),
    updateProposalField: (...args: unknown[]) => mockUpdateProposalField(...args),
    setStatus: (...args: unknown[]) => mockSetStatus(...args),
  };
});

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: vi.fn(() => false),
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: vi.fn(() => []),
  recordDecision: vi.fn(),
}));

vi.mock('../src/core/integrations/fleet-pulse-emit.js', () => ({
  emitMerge: vi.fn(async () => {}),
  emitJudgeVerdict: vi.fn(async () => {}),
}));

vi.mock('../src/core/comms/events.js', () => ({
  notifyFleetEvent: vi.fn(async () => {}),
}));

vi.mock('../src/core/fleet/self-improve.js', () => ({
  learnFromRejection: vi.fn(),
}));

vi.mock('../src/core/fleet/skill-library.js', () => ({
  learnFromApplied: vi.fn(),
}));

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';

function cfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    foundry: {
      mergeAuthority: [{ engine: 'claude', model: 'opus-4-8' }],
      judgePerPass: 4,
      autoMerge: {
        enabled: true,
        trustBasis: 'verification',
        maxRisk: 'low',
        maxAutomergeFiles: 4,
        maxAutomergeLines: 150,
        ...over,
      },
    },
  } as unknown as AshlrConfig;
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  const engineModel = over.engineModel ?? 'claude:opus-4-8';
  const engineTier = over.engineTier ?? 'frontier';
  const diff = over.diff ?? docDiff;
  const diffHash = hashDiff(diff);
  return {
    id: 'm307-prop',
    repo: '/tmp/m307-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'm307 proposal',
    summary: 'test',
    diff,
    diffHash,
    provenanceSig: signProvenance(engineModel, engineTier, diffHash),
    engineModel,
    engineTier,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  } as Proposal;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListProposals.mockReturnValue([proposal()]);
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"ship"}',
  });
  mockJudgeProposal.mockResolvedValue({ verdict: 'ship', wouldMerge: true, rationale: 'ship it' });
  mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true } satisfies AutoMergeResult);
  mockVerifyProposal.mockResolvedValue({
    ok: true,
    ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
    detail: 'passed',
  } satisfies VerifyProposalResult);
});

describe('M307 verify-before-judge', () => {
  it('skips judge and merge when verification fails', async () => {
    mockVerifyProposal.mockResolvedValue({
      ok: false,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      detail: 'vitest failed',
    } satisfies VerifyProposalResult);

    const r = await runAutoMergePass(cfg());

    expect(mockVerifyProposal).toHaveBeenCalledTimes(1);
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockUpdateProposalField).toHaveBeenCalledWith(
      'm307-prop',
      expect.objectContaining({
        verifyResult: expect.objectContaining({
          passed: false,
          failed: ['vitest failed'],
          source: 'auto-merge-preflight',
        }),
      }),
    );
    expect(r.results[0]?.reason).toMatch(/verify-before-judge: verification failed/);
  });

  it('judges and attempts merge after verification passes', async () => {
    const r = await runAutoMergePass(cfg());

    expect(mockVerifyProposal).toHaveBeenCalledTimes(1);
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
	    expect(mockAutoMergeProposal).toHaveBeenCalledWith('m307-prop', expect.any(Object));
	    expect(r.judgePerPass).toBe(4);
	    expect(r.judged).toBe(1);
	    expect(r.verifyBeforeJudgePerPass).toBe(4);
	    expect(r.verifyBeforeJudgeRan).toBe(1);
	    expect(r.verifyBeforeJudgeCapped).toBe(0);
	    expect(r.judgeEstimatedSpendUsd).toBeGreaterThan(0);
	    expect(r.attempted).toBe(1);
	    expect(r.merged).toBe(1);
  });

  it('uses a cached passing verifyResult without re-running verification', async () => {
    mockListProposals.mockReturnValue([
      proposal({ verifyResult: { passed: true, source: 'auto-merge-preflight' } }),
    ]);

    await runAutoMergePass(cfg());

    expect(mockVerifyProposal).not.toHaveBeenCalled();
    expect(mockJudgeProposal).toHaveBeenCalledTimes(1);
  });

  it('respects the verify-before-judge cap before spending judge calls', async () => {
    const r = await runAutoMergePass(cfg({ verifyBeforeJudgePerPass: 0 }));

	    expect(mockVerifyProposal).not.toHaveBeenCalled();
	    expect(mockJudgeProposal).not.toHaveBeenCalled();
	    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
	    expect(r.verifyBeforeJudgePerPass).toBe(0);
	    expect(r.verifyBeforeJudgeRan).toBe(0);
	    expect(r.verifyBeforeJudgeCapped).toBe(1);
	    expect(r.skipped).toEqual([
      {
        proposalId: 'm307-prop',
        check: 'verify-before-judge-cap',
        reason: 'verify-before-judge: cap reached (0/pass)',
      },
    ]);
  });

  it('increments stuckPassCount for known failed verification without judge or merge spend', async () => {
    mockListProposals.mockReturnValue([
      proposal({
        verifyResult: {
          passed: false,
          source: 'auto-merge-preflight',
          failed: ['npm run test failed'],
        },
      }),
    ]);

    const r = await runAutoMergePass(cfg());

    expect(mockVerifyProposal).not.toHaveBeenCalled();
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockUpdateProposalField).toHaveBeenCalledWith('m307-prop', { stuckPassCount: 1 });
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(r.autoArchived).toBe(0);
    expect(r.results[0]?.reason).toMatch(/readiness preflight: known verification failure/);
  });

  it('rejects known failed verification when the stuck threshold is reached', async () => {
    mockListProposals.mockReturnValue([
      proposal({
        stuckPassCount: 2,
        verifyResult: {
          passed: false,
          source: 'auto-merge-preflight',
          failed: ['npm run test failed'],
        },
      }),
    ]);
    const config = cfg();
    (config.foundry as Record<string, unknown>)['autoArchiveAfterRejects'] = 3;

    const r = await runAutoMergePass(config);

    expect(mockVerifyProposal).not.toHaveBeenCalled();
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith(
      'm307-prop',
      'rejected',
      undefined,
      expect.stringMatching(/known failed verification persisted for 3 pass/),
    );
    expect(mockUpdateProposalField).not.toHaveBeenCalledWith('m307-prop', expect.objectContaining({ stuckPassCount: 3 }));
    expect(r.autoArchived).toBe(1);
  });
});
