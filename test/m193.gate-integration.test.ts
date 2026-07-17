/**
 * M193 — Additive gate-module integration tests.
 *
 * Verifies that the three flag-gated pre-merge checks (red-team, blast-radius,
 * spec-contract) integrate correctly into runAutoMergePass:
 *
 *  Each flag ON + check fails → autoMergeProposal NOT called (stays pending).
 *  Each check passes          → merge proceeds normally.
 *  All flags OFF              → byte-identical (autoMergeProposal called exactly
 *                               as M172/M175; the 3 modules are never called).
 *  Enabled check throws       → proposal is skipped (fail-closed).
 *  Enabled check result shape → malformed/untrustworthy results are skipped.
 *  M153/M157 gate inside autoMergeProposal is untouched (mock-verified).
 *
 * FILE OWNERSHIP: automerge-pass.ts only — the modules are imported/mocked.
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir.
 *  - redTeamProposal MOCKED.
 *  - analyzeBlastRadius MOCKED.
 *  - checkSpecContract MOCKED.
 *  - loadSpec (spec-store) MOCKED (for spec-contract path).
 *  - autoMergeProposal MOCKED — no real git ops.
 *  - judgeProposal / resolveFrontierJudgeClient MOCKED (from manager.js).
 *  - readDecisions MOCKED — controls cache.
 *  - listProposalsDetailed MOCKED.
 *  - killSwitchOn MOCKED.
 *
 * Conventions mirror m172/m175 test file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (engine: string | undefined) => {
    const value = String(engine ?? '').toLowerCase();
    return value.startsWith('claude') || value.includes('claude') || value.startsWith('gpt-5');
  },
}));

const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: (...args: unknown[]) => ({
    proposals: mockListProposals(...args),
    sourceState: 'healthy',
    complete: true,
  }),
}));

const mockKillSwitchOn = vi.fn(() => false);
vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => mockKillSwitchOn(),
  isEnrolled: () => true,
}));

const mockReadDecisions = vi.fn(() => []);
vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: (...args: unknown[]) => mockReadDecisions(...args),
  recordDecision: vi.fn(),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

// M193 module mocks
const mockRedTeamProposal = vi.fn();
vi.mock('../src/core/fleet/red-team.js', () => ({
  redTeamProposal: (...args: unknown[]) => mockRedTeamProposal(...args),
}));

const mockAnalyzeBlastRadius = vi.fn();
vi.mock('../src/core/run/blast-radius.js', () => ({
  analyzeBlastRadius: (...args: unknown[]) => mockAnalyzeBlastRadius(...args),
}));

const mockCheckSpecContract = vi.fn();
vi.mock('../src/core/run/spec-contract.js', () => ({
  checkSpecContract: (...args: unknown[]) => mockCheckSpecContract(...args),
}));

const mockLoadSpec = vi.fn();
vi.mock('../src/core/spec/spec-store.js', () => ({
  loadSpec: (...args: unknown[]) => mockLoadSpec(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';
import { hashDiff, signJudgeAttestation } from '../src/core/foundry/provenance.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

/** A fresh ManagerVerdict for 'ship'. */
const shipVerdict = (id: string): ManagerVerdict => ({
  proposalId: id,
  verdict: 'ship',
  value: 5,
  correctness: 5,
  scope: 1,
  alignment: 5,
  rationale: 'mock ship',
  wouldMerge: true,
});

/** Red-team survived result. */
const rtSurvived = () => ({ broke: false, attacks: [], verdict: 'survived' as const, detail: 'no attacks' });

/** Red-team broken result. */
const rtBroken = (detail = 'injected-secret') => ({ broke: true, attacks: [{ vector: 'injected-secret', finding: 'test', severity: 'high' as const }], verdict: 'broken' as const, detail });

/** Blast-radius none result. */
const brNone = () => ({ affectedRepos: [], affectedConsumers: [], risk: 'none' as const, detail: 'isolated' });

/** Blast-radius high result. */
const brHigh = () => ({ affectedRepos: ['repo-a', 'repo-b'], affectedConsumers: [], risk: 'high' as const, detail: 'high risk' });

/** Spec-contract satisfied result. */
const scSatisfied = () => ({ satisfied: true, total: 2, met: 2, unmet: [], detail: { reason: '2/2 met', deferred: 0, generic: 0, checkable: 2, assertions: [] } });

/** Spec-contract unsatisfied result. */
const scUnsatisfied = () => ({ satisfied: false, total: 2, met: 0, unmet: [{ criterion: 'file exists', why: 'not found' }], detail: { reason: 'spec contract unsatisfied', deferred: 0, generic: 0, checkable: 2, assertions: [] } });

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m193-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();

  // Safe defaults: kill switch off, no proposals, cached ship verdict.
  mockKillSwitchOn.mockReturnValue(false);
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
  mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true, branched: false });
  mockResolveFrontierJudgeClient.mockReturnValue({
    model: 'claude-opus-4-8',
    complete: async () => '{"verdict":"ship"}',
  });
  mockJudgeProposal.mockResolvedValue(shipVerdict('default'));

  // M193 module defaults: all checks pass / survived / satisfied
  mockRedTeamProposal.mockResolvedValue(rtSurvived());
  mockAnalyzeBlastRadius.mockResolvedValue(brNone());
  mockCheckSpecContract.mockResolvedValue(scSatisfied());
  mockLoadSpec.mockReturnValue(null); // no spec by default
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

/** Minimal enabled config with optional M193 foundry flags. */
function enabledCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true },
      ...over,
    },
  } as unknown as AshlrConfig;
}

/** Minimal frontier proposal fixture (already judged = skip judge call). */
function makeProp(id: string, tier: 'frontier' | 'mid' | 'local' = 'frontier', specId?: string): Proposal {
  return {
    id,
    repo: '/tmp/m193-repo',
    origin: 'agent',
    kind: 'patch',
    title: `m193 prop ${id}`,
    summary: 'test',
    diff: `+++ a/src/foo.ts\n+fix ${id}\n`,
    diffHash: `hash-${id}`,
    engineModel: 'local:qwen3-coder',
    engineTier: tier,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...(specId ? { specId } : { specId: null }),
  } as unknown as Proposal;
}

/** A recent decisions-ledger entry (ship + attestation) so judge is skipped. */
function recentShipEntry(proposalId: string): Record<string, unknown> {
  const judgeEngine = 'claude-opus-4-5';
  return {
    ts: new Date().toISOString(),
    proposalId,
    action: 'judged',
    verdict: 'ship',
    engine: judgeEngine,
    model: judgeEngine,
    reason: 'cached',
    detail: 'would-merge',
    judgeAttestation: signJudgeAttestation({
      proposalId,
      judgeEngine,
      verdict: 'ship',
      diffHash: hashDiff(`+++ a/src/foo.ts\n+fix ${proposalId}\n`),
    }),
  };
}

// ===========================================================================
// [R1–R3] Red-team flag
// ===========================================================================

describe('M193 red-team gate (flag=redTeam)', () => {
  it('[R1] redTeam=true + verdict "broken" → autoMergeProposal NOT called', async () => {
    const p = makeProp('r1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('r1')]); // skip judge
    mockRedTeamProposal.mockResolvedValueOnce(rtBroken('injected-secret'));

    const r = await runAutoMergePass(enabledCfg({ redTeam: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ proposalId: 'r1', check: 'red-team' });
  });

  it('[R2] redTeam=true + verdict "survived" → merge proceeds normally', async () => {
    const p = makeProp('r2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('r2')]);
    mockRedTeamProposal.mockResolvedValueOnce(rtSurvived());

    const r = await runAutoMergePass(enabledCfg({ redTeam: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('r2', expect.anything());
    expect(r.merged).toBe(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('[R3] redTeam=false → redTeamProposal never called, merge proceeds', async () => {
    const p = makeProp('r3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('r3')]);

    const r = await runAutoMergePass(enabledCfg({ redTeam: false }));

    expect(mockRedTeamProposal).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('r3', expect.anything());
    expect(r.merged).toBe(1);
  });
});

// ===========================================================================
// [B1–B3] Blast-radius flag
// ===========================================================================

describe('M193 blast-radius gate (flag=blastRadius)', () => {
  it('[B1] blastRadius=true + risk "high" → autoMergeProposal NOT called', async () => {
    const p = makeProp('b1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('b1')]);
    mockAnalyzeBlastRadius.mockResolvedValueOnce(brHigh());

    const r = await runAutoMergePass(enabledCfg({ blastRadius: true }));

    expect(mockAnalyzeBlastRadius).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ proposalId: 'b1', check: 'blast-radius' });
  });

  it('[B2] blastRadius=true + risk "low" → merge proceeds', async () => {
    const p = makeProp('b2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('b2')]);
    mockAnalyzeBlastRadius.mockResolvedValueOnce({ affectedRepos: ['repo-c'], affectedConsumers: [], risk: 'low' as const, detail: 'low risk' });

    const r = await runAutoMergePass(enabledCfg({ blastRadius: true }));

    expect(mockAnalyzeBlastRadius).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('b2', expect.anything());
    expect(r.merged).toBe(1);
  });

  it('[B3] blastRadius=false → analyzeBlastRadius never called, merge proceeds', async () => {
    const p = makeProp('b3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('b3')]);

    const r = await runAutoMergePass(enabledCfg({ blastRadius: false }));

    expect(mockAnalyzeBlastRadius).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('b3', expect.anything());
    expect(r.merged).toBe(1);
  });
});

// ===========================================================================
// [S1–S4] Spec-contract flag
// ===========================================================================

describe('M193 spec-contract gate (flag=specContract)', () => {
  it('[S1] specContract=true + spec present + satisfied=false → autoMergeProposal NOT called', async () => {
    const p = makeProp('s1', 'frontier', 'my-spec-id');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('s1')]);
    mockLoadSpec.mockReturnValue({ meta: { id: 'my-spec-id', goal: 'g', version: 1, project: null, path: '/tmp/s', status: 'active', createdAt: '', updatedAt: '' }, body: '## Verification\n- file foo.ts exists\n' });
    mockCheckSpecContract.mockResolvedValueOnce(scUnsatisfied());

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    expect(mockCheckSpecContract).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]).toMatchObject({ proposalId: 's1', check: 'spec-contract' });
  });

  it('[S2] specContract=true + spec present + satisfied=true → merge proceeds', async () => {
    const p = makeProp('s2', 'frontier', 'my-spec-id-2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('s2')]);
    mockLoadSpec.mockReturnValue({ meta: { id: 'my-spec-id-2', goal: 'g', version: 1, project: null, path: '/tmp/s', status: 'active', createdAt: '', updatedAt: '' }, body: '## Verification\n- file bar.ts exists\n' });
    mockCheckSpecContract.mockResolvedValueOnce(scSatisfied());

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    expect(mockCheckSpecContract).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('s2', expect.anything());
    expect(r.merged).toBe(1);
    expect(r.skipped).toHaveLength(0);
  });

  it('[S3] specContract=true + NO specId on proposal → check is skipped, merge proceeds', async () => {
    // makeProp with no specId → specId: null
    const p = makeProp('s3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('s3')]);

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    // With no specId, the check must be a no-op
    expect(mockCheckSpecContract).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('s3', expect.anything());
    expect(r.merged).toBe(1);
  });

  it('[S4] specContract=false → checkSpecContract never called, merge proceeds', async () => {
    const p = makeProp('s4', 'frontier', 'some-spec');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('s4')]);

    const r = await runAutoMergePass(enabledCfg({ specContract: false }));

    expect(mockCheckSpecContract).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('s4', expect.anything());
    expect(r.merged).toBe(1);
  });
});

// ===========================================================================
// [F0] Flag-off byte-identical: all 3 modules never called
// ===========================================================================

describe('M193 flag-off byte-identical', () => {
  it('[F0] all flags absent → all 3 modules never called, autoMergeProposal called exactly as M172/M175', async () => {
    const p1 = makeProp('f0a');
    const p2 = makeProp('f0b');
    mockListProposals.mockReturnValue([p1, p2]);
    mockReadDecisions.mockReturnValue([recentShipEntry('f0a'), recentShipEntry('f0b')]);

    // enabledCfg() has no M193 flags → byte-identical path
    const r = await runAutoMergePass(enabledCfg());

    // M193 modules never touched
    expect(mockRedTeamProposal).not.toHaveBeenCalled();
    expect(mockAnalyzeBlastRadius).not.toHaveBeenCalled();
    expect(mockCheckSpecContract).not.toHaveBeenCalled();
    // autoMergeProposal called for each proposal (same as M172/M175)
    expect(mockAutoMergeProposal).toHaveBeenCalledTimes(2);
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('f0a', expect.anything());
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('f0b', expect.anything());
    expect(r.merged).toBe(2);
    expect(r.skipped).toHaveLength(0);
  });
});

// ===========================================================================
// [T1–T3] Fail-closed: an enabled check that throws blocks the merge
// ===========================================================================

describe('M193 fail-closed: throws block merge when flag is enabled', () => {
  it('[T1] redTeamProposal throws → skipped (fail-closed)', async () => {
    const p = makeProp('t1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('t1')]);
    mockRedTeamProposal.mockRejectedValueOnce(new Error('LLM timeout'));

    const r = await runAutoMergePass(enabledCfg({ redTeam: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.merged).toBe(0);
    expect(r.skipped).toEqual([
      expect.objectContaining({ proposalId: 't1', check: 'red-team' }),
    ]);
    expect(r.results).toEqual([
      expect.objectContaining({ ok: false, merged: false, branched: false }),
    ]);
  });

  it('[T2] analyzeBlastRadius throws → skipped (fail-closed)', async () => {
    const p = makeProp('t2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('t2')]);
    mockAnalyzeBlastRadius.mockRejectedValueOnce(new Error('fs error'));

    const r = await runAutoMergePass(enabledCfg({ blastRadius: true }));

    expect(mockAnalyzeBlastRadius).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.merged).toBe(0);
    expect(r.skipped).toEqual([
      expect.objectContaining({ proposalId: 't2', check: 'blast-radius' }),
    ]);
    expect(r.results).toEqual([
      expect.objectContaining({ ok: false, merged: false, branched: false }),
    ]);
  });

  it('[T3] checkSpecContract throws → skipped (fail-closed)', async () => {
    const p = makeProp('t3', 'frontier', 'spec-t3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('t3')]);
    mockLoadSpec.mockReturnValue({ meta: { id: 'spec-t3', goal: 'g', version: 1, project: null, path: '/tmp/s', status: 'active', createdAt: '', updatedAt: '' }, body: '## Verification\n- something\n' });
    mockCheckSpecContract.mockRejectedValueOnce(new Error('contract error'));

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    expect(mockCheckSpecContract).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.merged).toBe(0);
    expect(r.skipped).toEqual([
      expect.objectContaining({ proposalId: 't3', check: 'spec-contract' }),
    ]);
    expect(r.results).toEqual([
      expect.objectContaining({ ok: false, merged: false, branched: false }),
    ]);
  });
});

// ===========================================================================
// [U1-U4] Fail-closed: untrustworthy enabled-check results block the merge
// ===========================================================================

describe('M193 fail-closed: untrustworthy enabled-check results block merge', () => {
  it('[U1] redTeamProposal returns malformed result → skipped', async () => {
    const p = makeProp('u1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('u1')]);
    mockRedTeamProposal.mockResolvedValueOnce({ detail: 'missing verdict' });

    const r = await runAutoMergePass(enabledCfg({ redTeam: true }));

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped[0]).toMatchObject({ proposalId: 'u1', check: 'red-team' });
    expect(r.results[0]).toMatchObject({ ok: false, merged: false, branched: false });
  });

  it('[U2] analyzeBlastRadius returns malformed result → skipped', async () => {
    const p = makeProp('u2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('u2')]);
    mockAnalyzeBlastRadius.mockResolvedValueOnce({ detail: 'missing risk' });

    const r = await runAutoMergePass(enabledCfg({ blastRadius: true }));

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped[0]).toMatchObject({ proposalId: 'u2', check: 'blast-radius' });
    expect(r.results[0]).toMatchObject({ ok: false, merged: false, branched: false });
  });

  it('[U3] checkSpecContract returns malformed result → skipped', async () => {
    const p = makeProp('u3', 'frontier', 'spec-u3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('u3')]);
    mockLoadSpec.mockReturnValue({ meta: { id: 'spec-u3', goal: 'g', version: 1, project: null, path: '/tmp/s', status: 'active', createdAt: '', updatedAt: '' }, body: '## Verification\n- something\n' });
    mockCheckSpecContract.mockResolvedValueOnce({ detail: { reason: 'missing satisfied' } });

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped[0]).toMatchObject({ proposalId: 'u3', check: 'spec-contract' });
    expect(r.results[0]).toMatchObject({ ok: false, merged: false, branched: false });
  });

  it('[U4] specContract=true + specId present + loadSpec cannot load → skipped', async () => {
    const p = makeProp('u4', 'frontier', 'spec-u4');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('u4')]);
    mockLoadSpec.mockReturnValueOnce(null);

    const r = await runAutoMergePass(enabledCfg({ specContract: true }));

    expect(mockCheckSpecContract).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped[0]).toMatchObject({ proposalId: 'u4', check: 'spec-contract' });
    expect(r.results[0]).toMatchObject({ ok: false, merged: false, branched: false });
  });
});

// ===========================================================================
// [C1] Core gate (autoMergeProposal / M153/M157) is untouched
// ===========================================================================

describe('M193 core gate untouched', () => {
  it('[C1] autoMergeProposal result (e.g. merged=false from M153/M157 gate) is passed through unchanged', async () => {
    const p = makeProp('c1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('c1')]);
    // All M193 flags off → straight through to autoMergeProposal
    // The gate inside refuses the merge (merged=false, branched=false)
    mockAutoMergeProposal.mockResolvedValueOnce({ ok: false, merged: false, branched: false });

    const r = await runAutoMergePass(enabledCfg());

    expect(mockAutoMergeProposal).toHaveBeenCalledWith('c1', expect.anything());
    // The M153/M157 gate's refusal must propagate exactly — M193 doesn't alter it
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(0);
    expect(r.branched).toBe(0);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ ok: false, merged: false, branched: false });
  });
});

// ===========================================================================
// [M1] Multi-check interaction: two flags on, first fails → second not run
// ===========================================================================

describe('M193 multi-check interaction', () => {
  it('[M1] redTeam=true (broken) + blastRadius=true → blastRadius never called (short-circuit)', async () => {
    const p = makeProp('m1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('m1')]);
    mockRedTeamProposal.mockResolvedValueOnce(rtBroken());

    const r = await runAutoMergePass(enabledCfg({ redTeam: true, blastRadius: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    // Short-circuit: blast-radius not called once red-team blocked
    expect(mockAnalyzeBlastRadius).not.toHaveBeenCalled();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].check).toBe('red-team');
  });

  it('[M2] redTeam=true (survived) + blastRadius=true (high) → blast-radius blocks', async () => {
    const p = makeProp('m2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('m2')]);
    mockRedTeamProposal.mockResolvedValueOnce(rtSurvived());
    mockAnalyzeBlastRadius.mockResolvedValueOnce(brHigh());

    const r = await runAutoMergePass(enabledCfg({ redTeam: true, blastRadius: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    expect(mockAnalyzeBlastRadius).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].check).toBe('blast-radius');
  });

  it('[M3] all 3 flags on + all pass → merge proceeds, skipped=0', async () => {
    const p = makeProp('m3', 'frontier', 'spec-m3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([recentShipEntry('m3')]);
    mockRedTeamProposal.mockResolvedValueOnce(rtSurvived());
    mockAnalyzeBlastRadius.mockResolvedValueOnce(brNone());
    mockLoadSpec.mockReturnValue({ meta: { id: 'spec-m3', goal: 'g', version: 1, project: null, path: '/tmp/s', status: 'active', createdAt: '', updatedAt: '' }, body: '## Verification\n- something\n' });
    mockCheckSpecContract.mockResolvedValueOnce(scSatisfied());

    const r = await runAutoMergePass(enabledCfg({ redTeam: true, blastRadius: true, specContract: true }));

    expect(mockRedTeamProposal).toHaveBeenCalledOnce();
    expect(mockAnalyzeBlastRadius).toHaveBeenCalledOnce();
    expect(mockCheckSpecContract).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith('m3', expect.anything());
    expect(r.merged).toBe(1);
    expect(r.skipped).toHaveLength(0);
  });
});
