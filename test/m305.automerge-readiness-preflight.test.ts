/**
 * M305 — cheap auto-merge readiness preflight.
 *
 * The pass should not spend a frontier judge call on proposals that already
 * fail permanent, no-I/O merge prerequisites. The merge gate remains the source
 * of truth; this preflight only short-circuits static blockers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import {
  evaluateAutoMergeReadinessPreflight,
  evaluateEvidenceRemoteProtectionSignal,
  type AutoMergeResult,
} from '../src/core/inbox/merge.js';
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

const packageDiff = [
  'diff --git a/package.json b/package.json',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -1 +1 @@',
  '-{"scripts":{}}',
  '+{"scripts":{"postinstall":"node x.js"}}',
  '',
].join('\n');

function cfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    version: 1,
    foundry: {
      mergeAuthority: [{ engine: 'claude', model: 'opus-4-8' }],
      autoMerge: { enabled: true, maxRisk: 'low', ...over },
    },
  } as unknown as AshlrConfig;
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  const engineModel = over.engineModel ?? 'claude:opus-4-8';
  const engineTier = over.engineTier ?? 'frontier';
  const diff = over.diff ?? docDiff;
  const diffHash = hashDiff(diff);
  return {
    id: 'm305-prop',
    repo: '/tmp/m305-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'm305 proposal',
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

describe('M305 evaluateAutoMergeReadinessPreflight', () => {
  it('allows a low-risk authorized proposal with valid provenance', () => {
    const r = evaluateAutoMergeReadinessPreflight(proposal(), cfg());
    expect(r).toMatchObject({ ready: true, advisories: [] });
  });

  it('blocks missing merge inputs before judge spend', () => {
    expect(evaluateAutoMergeReadinessPreflight(proposal({ kind: 'note' }), cfg()).reason)
      .toMatch(/kind 'note' is not mergeable/);
    expect(evaluateAutoMergeReadinessPreflight(proposal({ diff: '   ' }), cfg()).reason)
      .toMatch(/no diff/);
    expect(evaluateAutoMergeReadinessPreflight(proposal({ repo: undefined }), cfg()).reason)
      .toMatch(/no repo/);
  });

  it('blocks known failed verification without re-judging', () => {
    const r = evaluateAutoMergeReadinessPreflight(
      proposal({ verifyResult: { passed: false, failed: ['vitest'] } }),
      cfg({ trustBasis: 'verification' }),
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/known verification failure/);
    expect(r.reason).toMatch(/vitest/);
  });

  it('fails closed on an unknown trust basis instead of downgrading to tier authority', () => {
    const r = evaluateAutoMergeReadinessPreflight(proposal(), cfg({ trustBasis: 'future-unsafe-mode' }));
    expect(r).toMatchObject({ ready: false, permanent: false });
    expect(r.reason).toMatch(/invalid auto-merge trustBasis/);
  });

  it('fails closed on an unknown maxRisk instead of treating it as low risk', () => {
    const r = evaluateAutoMergeReadinessPreflight(proposal(), cfg({ maxRisk: 'extreme' }));
    expect(r).toMatchObject({ ready: false, permanent: false });
    expect(r.reason).toMatch(/invalid auto-merge maxRisk/);
  });

  it('reuses authority, provenance, and risk basics as blockers', () => {
    expect(
      evaluateAutoMergeReadinessPreflight(
        proposal({ engineModel: 'claude:unapproved' }),
        cfg(),
      ).reason,
    ).toMatch(/merge authority denied/);

    expect(
      evaluateAutoMergeReadinessPreflight(
        proposal({ provenanceSig: 'bad-signature' }),
        cfg(),
      ).reason,
    ).toMatch(/provenance check failed/);

    expect(
      evaluateAutoMergeReadinessPreflight(
        proposal({ diff: packageDiff }),
        cfg(),
      ).reason,
    ).toMatch(/risk class 'high' exceeds maxRisk 'low'/);
  });
});

describe('M305 evidence remote check identity expectations', () => {
  const signal = (requiredChecks: unknown[]) => evaluateEvidenceRemoteProtectionSignal(cfg({
    trustBasis: 'evidence',
    protectedRemote: { branchProtection: true, requiredChecks },
  }));

  it('accepts unique context and App identity pairs and normalizes numeric ids', () => {
    expect(signal([
      { context: 'CI (Node 22, ubuntu-latest)', appId: 15368 },
      { context: 'CI (Node 22, windows-latest)', appId: '15368' },
    ])).toMatchObject({
      ok: true,
      expectationMode: 'exact',
      requiredChecks: ['CI (Node 22, ubuntu-latest)', 'CI (Node 22, windows-latest)'],
      requiredCheckBindings: [
        { context: 'CI (Node 22, ubuntu-latest)', appId: '15368' },
        { context: 'CI (Node 22, windows-latest)', appId: '15368' },
      ],
    });
  });

  it('keeps legacy string input visible but non-authoritative', () => {
    expect(signal(['ci/test'])).toMatchObject({
      ok: false,
      expectationMode: 'legacy',
      requiredChecks: [],
      requiredCheckBindings: [],
    });
    expect(signal(['ci/test']).detail).toMatch(/legacy required-check names/);
    expect(evaluateAutoMergeReadinessPreflight(proposal(), cfg({
      trustBasis: 'evidence',
      pushToRemote: true,
      protectedRemote: { branchProtection: true, requiredChecks: ['ci/test'] },
    }))).toMatchObject({ ready: false, permanent: false });
  });

  it('rejects null App identity and duplicate or conflicting contexts', () => {
    const nullApp = signal([{ context: 'ci/test', appId: null }]);
    expect(nullApp).toMatchObject({ ok: false, expectationMode: 'invalid' });
    expect(nullApp.detail).toMatch(/positive GitHub App id/);

    const duplicate = signal([
      { context: 'ci/test', appId: 1 },
      { context: 'ci/test', appId: '1' },
    ]);
    expect(duplicate).toMatchObject({ ok: false, expectationMode: 'invalid' });
    expect(duplicate.detail).toMatch(/duplicate configured required-check context/);

    const conflict = signal([
      { context: 'ci/test', appId: 1 },
      { context: 'ci/test', appId: 2 },
    ]);
    expect(conflict).toMatchObject({ ok: false, expectationMode: 'invalid' });
    expect(conflict.detail).toMatch(/conflicting GitHub App identities/);
  });
});

// ---------------------------------------------------------------------------
// Pass integration: readiness hold is surfaced and no judge call is spent.
// ---------------------------------------------------------------------------

const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/merge.js')>();
  return {
    ...actual,
    autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  };
});

const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    listProposalsDetailed: (...args: unknown[]) => ({
      proposals: mockListProposals(...args),
      sourceState: 'healthy',
      complete: true,
    }),
    setStatus: vi.fn(),
    updateProposalField: vi.fn(),
  };
});

const mockKillSwitchOn = vi.fn(() => false);
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
  assertMayMutate: vi.fn(),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
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

describe('M305 runAutoMergePass readiness preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKillSwitchOn.mockReturnValue(false);
    mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true } satisfies AutoMergeResult);
    mockResolveFrontierJudgeClient.mockReturnValue({
      model: 'claude-opus-4-8',
      complete: async () => '{"verdict":"ship"}',
    });
  });

  it('surfaces readiness hold in results and skips judge + merge gate', async () => {
    mockListProposals.mockReturnValue([proposal({ diff: '' })]);

    const r = await runAutoMergePass(cfg());

    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(0);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({
      ok: false,
      merged: false,
      branched: false,
    });
    expect(r.results[0]?.reason).toMatch(/readiness preflight: proposal has no diff/);
    expect(r.skipped).toEqual([
      {
        proposalId: 'm305-prop',
        check: 'readiness-preflight',
        reason: 'readiness preflight: proposal has no diff to merge',
      },
    ]);
  });
});
