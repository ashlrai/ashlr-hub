/**
 * V3.10 Track B unit U3 — runAutoMergePass dispatch (fleet/automerge-pass.ts).
 *
 * Under a standing grant the standing gates are the ONLY merge path: the
 * legacy M47 gate (local-merge fallback, Mason-credential handoff PRs) must
 * never run, even for one tick. With no grant the legacy path is master's,
 * except that a proposal that already has an ashlr-fleet PR never lands twice.
 * All collaborators are mocked; nothing touches git, GitHub or a model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';

const h = vi.hoisted(() => ({
  policy: { current: null as unknown },
  fleetPrIds: new Set<string>(),
  proposals: [] as unknown[],
  standingCalls: [] as unknown[],
  autoMerge: vi.fn(),
}));

vi.mock('../src/core/authority/effective-config.js', () => ({
  currentStandingPolicy: () => h.policy.current,
}));

vi.mock('../src/core/fleet/fleet-merge-state.js', () => ({
  proposalHasFleetPr: (id: string) => h.fleetPrIds.has(id),
}));

vi.mock('../src/core/fleet/standing-merge-pass.js', () => ({
  runStandingMergePass: async (input: { out: { merged: number; landings?: unknown[] }; pending: Proposal[] }) => {
    h.standingCalls.push(input.pending.map((p) => p.id));
    input.out.merged = 1;
    input.out.landings = [{ id: 'ashlrai/canary#1@abc' }];
    return { mode: 'standing' };
  },
}));

vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: () => ({ sourceState: 'healthy', complete: true, proposals: h.proposals }),
  replayRealizedMergeFanout: () => true,
  setStatus: () => true,
  updateProposalField: () => true,
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => h.autoMerge(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  hasCurrentVerificationBinding: () => false,
  isFrontierJudge: () => true,
  verifyAndPersistProposal: vi.fn(),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  killSwitchOn: () => false,
  isEnrolled: () => true,
}));

vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: vi.fn(),
  resolveFrontierJudgeClient: () => null,
}));

vi.mock('../src/core/fleet/decisions-ledger.js', () => ({
  readDecisions: () => [],
  recordDecision: vi.fn(),
}));

const { runAutoMergePass } = await import('../src/core/fleet/automerge-pass.js');

function proposal(id: string): Proposal {
  return {
    id,
    repo: '/tmp/repo',
    origin: 'swarm',
    kind: 'patch',
    title: id,
    summary: '',
    diff: 'diff --git a/x b/x\n',
    status: 'pending',
    createdAt: new Date().toISOString(),
    engineTier: 'frontier',
    engineModel: 'claude:claude-opus-4-8',
  } as Proposal;
}

const legacyCfg = { foundry: { autoMerge: { enabled: true } } } as unknown as AshlrConfig;

beforeEach(() => {
  h.policy.current = null;
  h.fleetPrIds.clear();
  h.proposals = [proposal('p1'), proposal('p2')];
  h.standingCalls.length = 0;
  h.autoMerge.mockReset();
  h.autoMerge.mockResolvedValue({ ok: false, merged: false, reason: 'test' });
});

describe('runAutoMergePass dispatch (V3.10)', () => {
  it('a live standing grant runs ONLY the standing pass — the legacy gate never runs', async () => {
    h.policy.current = { grantId: 'g' } as unknown as EffectivePolicy;
    const out = await runAutoMergePass(legacyCfg);
    expect(h.standingCalls).toEqual([['p1', 'p2']]);
    expect(h.autoMerge).not.toHaveBeenCalled();
    expect(out.merged).toBe(1);
    expect(out.landings).toEqual([{ id: 'ashlrai/canary#1@abc' }]);
  });

  it('runs under a grant even with the legacy opt-in off (the grant is the authority; config folds into the policy)', async () => {
    h.policy.current = { grantId: 'g' } as unknown as EffectivePolicy;
    await runAutoMergePass({ foundry: { autoMerge: { enabled: false } } } as unknown as AshlrConfig);
    expect(h.standingCalls).toHaveLength(1);
  });

  it('a resident-standing tick whose policy vanished does nothing at all (never the legacy path)', async () => {
    const out = await runAutoMergePass(legacyCfg, { capabilityKind: 'resident-standing' });
    expect(h.standingCalls).toHaveLength(0);
    expect(h.autoMerge).not.toHaveBeenCalled();
    expect(out.attempted).toBe(0);
  });

  it('with no grant the legacy path runs as on master, but skips proposals that already have a fleet PR', async () => {
    h.fleetPrIds.add('p2');
    await runAutoMergePass(legacyCfg);
    expect(h.standingCalls).toHaveLength(0);
    expect(h.autoMerge.mock.calls.map((call) => call[0])).toEqual(['p1']);
  });

  it('with no grant and the opt-in off, nothing runs (master\'s default)', async () => {
    await runAutoMergePass({} as AshlrConfig);
    expect(h.autoMerge).not.toHaveBeenCalled();
    expect(h.standingCalls).toHaveLength(0);
  });
});
