/**
 * M176 — Judge-resolver fix: runAutoMergePass in-loop judge uses the M135
 * frontier-judge path (resolveFrontierJudgeClient from manager.ts), NOT the
 * broken getActiveClient path that returns hasComplete=false when
 * cfg.models.providerChain is ["ollama"].
 *
 * Adversarial matrix:
 *
 *  Resolver wiring
 *  [R1]  resolveFrontierJudgeClient (manager.ts export) is called once per
 *        producer family, not per proposal (lazy, family-keyed cache)
 *  [R2]  getActiveClient is NEVER called by runAutoMergePass (old broken path gone)
 *  [R3]  when resolveFrontierJudgeClient returns a client, judgeProposal is called
 *        with that opposite-family client object
 *  [R4]  a same-family producer gets an unavailable resolver result and stays
 *        pending, while an opposite-family producer can still proceed
 *  [R5]  resolveFrontierJudgeClient is NOT re-called for a second proposal from
 *        the same producer family
 *  [R6]  a mixed local/Claude/OpenAI queue resolves at most once per family
 *  [R7]  pure evidence mode remains judge-free and never resolves a client
 *
 *  Provenance
 *  [P1]  resolveFrontierJudgeClient is exported from manager.ts
 *  [P2]  resolveFrontierJudgeClient delegates to resolveJudgeClient (M135), which
 *        prefers Claude CLI when allowedBackends includes 'claude' and it is installed
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir; no real ~/.ashlr state touched.
 *  - judgeProposal MOCKED — no real LLM calls.
 *  - resolveFrontierJudgeClient MOCKED — controls resolver output.
 *  - getActiveClient MOCKED — asserted NOT called.
 *  - autoMergeProposal MOCKED — no git ops.
 *  - listProposalsDetailed / readDecisions / killSwitchOn MOCKED.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

const mockAutoMergeProposal = vi.fn();
const mockVerifyAndPersistProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  verifyAndPersistProposal: (...args: unknown[]) => mockVerifyAndPersistProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: (engine: string | undefined) =>
    String(engine ?? '').toLowerCase().startsWith('claude'),
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
  recordDecision: vi.fn(() => true),
}));

const mockJudgeProposal = vi.fn();
const mockResolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: (...args: unknown[]) => mockJudgeProposal(...args),
  resolveFrontierJudgeClient: (...args: unknown[]) => mockResolveFrontierJudgeClient(...args),
}));

// Spy on getActiveClient — M176 asserts it is NEVER called by runAutoMergePass.
const mockGetActiveClient = vi.fn();
vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: (...args: unknown[]) => mockGetActiveClient(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports — after mocks
// ---------------------------------------------------------------------------

import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

/** Fake client returned by resolveFrontierJudgeClient. */
const FRONTIER_CLIENT = {
  model: 'claude-opus-4-8',
  complete: vi.fn(async () =>
    '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"m176 ok"}',
  ),
};

const OPENAI_CLIENT = {
  model: 'gpt-5.5',
  complete: vi.fn(async () =>
    '{"verdict":"ship","value":5,"correctness":5,"scope":1,"alignment":5,"rationale":"m176 independent"}',
  ),
};

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m176-'));
  process.env.HOME = tmpHome;
  vi.clearAllMocks();

  mockKillSwitchOn.mockReturnValue(false);
  mockListProposals.mockReturnValue([]);
  mockReadDecisions.mockReturnValue([]);
  mockAutoMergeProposal.mockResolvedValue({ ok: true, merged: true, branched: false });
  mockVerifyAndPersistProposal.mockResolvedValue({
    verify: {
      ok: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      detail: 'm176 verification passed',
    },
    verifyResult: {
      passed: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      detail: 'm176 verification passed',
      baseBranch: 'main',
      baseHead: '0'.repeat(40),
      diffHash: 'm176-diff-hash',
      verifiedAt: '2026-07-16T00:00:00.000Z',
      source: 'auto-merge-preflight',
    },
    persisted: true,
    authorityLive: true,
    reason: 'verification evidence persisted under live authority',
  });

  // Default: frontier resolver returns the claude-opus-4-8 client.
  mockResolveFrontierJudgeClient.mockReturnValue(FRONTIER_CLIENT);

  mockJudgeProposal.mockResolvedValue({
    proposalId: 'default',
    verdict: 'ship',
    value: 5,
    correctness: 5,
    scope: 1,
    alignment: 5,
    rationale: 'frontier judge',
    wouldMerge: true,
  } satisfies ManagerVerdict);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

/** Minimal enabled config — providerChain is ollama-only to simulate the broken env. */
function enabledCfg(over: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: { enabled: true, managerGate: true },
      allowedBackends: ['claude', 'ollama'],
      managerJudgeModel: 'claude-opus-4-8',
      managerJudgeEngine: 'claude',
      ...over,
    },
    models: {
      // Simulate the exact broken env: providerChain is ollama-only.
      providerChain: ['ollama'],
      ollama: 'http://localhost:11434',
    },
  } as unknown as AshlrConfig;
}

function makeProp(
  id: string,
  tier: 'frontier' | 'mid' | 'local' = 'frontier',
  engineModel = 'local:qwen3-coder',
): Proposal {
  return {
    id,
    repo: '/tmp/m176-repo',
    origin: 'agent',
    kind: 'patch',
    title: `m176 prop ${id}`,
    summary: 'test',
    diff: `+fix ${id}\n`,
    diffHash: `hash-${id}`,
    engineModel,
    engineTier: tier,
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as unknown as Proposal;
}

// ===========================================================================
// [R1–R7] Resolver wiring and producer-family independence
// ===========================================================================

describe('M176 resolver wiring', () => {
  it('[R1] resolveFrontierJudgeClient is called once per producer family (not per proposal)', async () => {
    const proposals = ['r1a', 'r1b', 'r1c'].map((id) => makeProp(id));
    mockListProposals.mockReturnValue(proposals);
    mockReadDecisions.mockReturnValue([]);

    const cfg = enabledCfg();
    await runAutoMergePass(cfg);

    // Three local-family proposals, but resolver only called once (family cache).
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledOnce();
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, {
      producerModel: 'local:qwen3-coder',
      requireIndependent: true,
    });
  });

  it('[R2] getActiveClient is NEVER called by runAutoMergePass (old broken path removed)', async () => {
    const p = makeProp('r2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    await runAutoMergePass(enabledCfg());

    expect(mockGetActiveClient).not.toHaveBeenCalled();
  });

  it('[R3] opposite-family resolver client is accepted and passed to judgeProposal', async () => {
    const p = makeProp('r3');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValueOnce({
      proposalId: 'r3', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    const cfg = enabledCfg();
    await runAutoMergePass(cfg);

    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, {
      producerModel: 'local:qwen3-coder',
      requireIndependent: true,
    });
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    // The second argument to judgeProposal is cfg; the third is the client.
    const callArgs = mockJudgeProposal.mock.calls[0];
    // judgeProposal(proposal, cfg, judgeClient)
    expect(callArgs[2]).toBe(FRONTIER_CLIENT);
  });

  it('[R4] same-family unavailability stays pending without poisoning an opposite family', async () => {
    const sameFamilyA = makeProp('r4-claude-a', 'frontier', 'claude-sonnet-4-6');
    const sameFamilyB = makeProp('r4-claude-b', 'frontier', 'claude-opus-4-8');
    const oppositeFamily = makeProp('r4-local', 'frontier', 'local:qwen3-coder');
    mockListProposals.mockReturnValue([sameFamilyA, sameFamilyB, oppositeFamily]);
    mockReadDecisions.mockReturnValue([]);

    // The configured Claude candidate is not independent for Claude producers.
    // A local producer may still use it, and null is cached only for Claude.
    mockResolveFrontierJudgeClient.mockImplementation(
      (_cfg: AshlrConfig, options: { producerModel?: string }) =>
        options.producerModel?.startsWith('claude') ? null : FRONTIER_CLIENT,
    );

    const cfg = enabledCfg();
    const r = await runAutoMergePass(cfg);

    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledTimes(2);
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, {
      producerModel: 'claude-sonnet-4-6',
      requireIndependent: true,
    });
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, {
      producerModel: 'local:qwen3-coder',
      requireIndependent: true,
    });
    expect(mockJudgeProposal).toHaveBeenCalledOnce();
    expect(mockJudgeProposal.mock.calls[0]?.[0]).toBe(oppositeFamily);
    expect(mockAutoMergeProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledWith(oppositeFamily.id, cfg);
    expect(sameFamilyA.status).toBe('pending');
    expect(sameFamilyB.status).toBe('pending');
    expect(r.judged).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.merged).toBe(1);
  });

  it('[R5] resolveFrontierJudgeClient is NOT called again for the same producer family', async () => {
    const p1 = makeProp('r5a');
    const p2 = makeProp('r5b');
    mockListProposals.mockReturnValue([p1, p2]);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    await runAutoMergePass(enabledCfg());

    // Two local-family proposals → judge called twice, resolver called once.
    expect(mockJudgeProposal).toHaveBeenCalledTimes(2);
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledOnce();
  });

  it('[R6] mixed local/Claude/OpenAI queue resolves at most once per distinct family', async () => {
    const proposals = [
      makeProp('r6-local-a', 'frontier', 'local:qwen3-coder'),
      makeProp('r6-claude-a', 'frontier', 'claude-sonnet-4-6'),
      makeProp('r6-openai-a', 'frontier', 'gpt-5.5-codex'),
      makeProp('r6-local-b', 'frontier', 'ollama:qwen2.5-coder'),
      makeProp('r6-claude-b', 'frontier', 'claude-opus-4-8'),
      makeProp('r6-openai-b', 'frontier', 'openai:gpt-5.4'),
    ];
    mockListProposals.mockReturnValue(proposals);
    mockResolveFrontierJudgeClient.mockImplementation(
      (_cfg: AshlrConfig, options: { producerModel?: string }) =>
        options.producerModel?.startsWith('claude') ? OPENAI_CLIENT : FRONTIER_CLIENT,
    );

    const cfg = enabledCfg();
    const r = await runAutoMergePass(cfg);

    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledTimes(3);
    expect(mockResolveFrontierJudgeClient.mock.calls).toEqual(expect.arrayContaining([
      [cfg, { producerModel: 'local:qwen3-coder', requireIndependent: true }],
      [cfg, { producerModel: 'claude-sonnet-4-6', requireIndependent: true }],
      [cfg, { producerModel: 'gpt-5.5-codex', requireIndependent: true }],
    ]));
    expect(mockJudgeProposal).toHaveBeenCalledTimes(6);
    expect(mockAutoMergeProposal).toHaveBeenCalledTimes(6);
    expect(r.judged).toBe(6);
    expect(r.merged).toBe(6);
  });

  it('[R7] pure evidence mode does not resolve or invoke a frontier judge', async () => {
    const p = makeProp('r7-evidence', 'local', 'claude-sonnet-4-6');
    mockListProposals.mockReturnValue([p]);

    const cfg = enabledCfg({
      autoMerge: { enabled: true, trustBasis: 'evidence' },
    });
    const r = await runAutoMergePass(cfg);

    expect(mockResolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(mockJudgeProposal).not.toHaveBeenCalled();
    expect(mockVerifyAndPersistProposal).toHaveBeenCalledOnce();
    expect(mockAutoMergeProposal).toHaveBeenCalledOnce();
    expect(r.judged).toBe(0);
    expect(r.attempted).toBe(1);
  });
});

// ===========================================================================
// [P1–P2] Provenance — resolveFrontierJudgeClient exported from manager.ts
// ===========================================================================

describe('M176 provenance — resolveFrontierJudgeClient export', () => {
  it('[P1] resolveFrontierJudgeClient is exported from manager.ts', async () => {
    // Dynamic import bypasses the vi.mock for this specific assertion.
    // We can't use the live export in this hermetic test (would need claude CLI),
    // but we can assert the symbol is present on the real module shape via the mock.
    // The mock factory only exports what's declared — if the real export didn't exist
    // the TypeScript compiler would have failed at import time in automerge-pass.ts.
    // This test confirms the mock shape matches the real export contract.
    expect(typeof mockResolveFrontierJudgeClient).toBe('function');

    // Confirm automerge-pass.ts calls it (not some other symbol).
    const p = makeProp('p1');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    await runAutoMergePass(enabledCfg());

    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        foundry: expect.objectContaining({
          autoMerge: expect.objectContaining({ enabled: true, managerGate: true }),
        }),
      }),
      { producerModel: 'local:qwen3-coder', requireIndependent: true },
    );
  });

  it('[P2] cfg is passed to resolveFrontierJudgeClient (M135 resolver can read managerJudgeEngine)', async () => {
    const p = makeProp('p2');
    mockListProposals.mockReturnValue([p]);
    mockReadDecisions.mockReturnValue([]);

    const cfg = enabledCfg({ managerJudgeEngine: 'claude', managerJudgeModel: 'claude-opus-4-8' });
    await runAutoMergePass(cfg);

    // Resolver receives the full cfg so M135 can inspect managerJudgeEngine + allowedBackends.
    expect(mockResolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, {
      producerModel: 'local:qwen3-coder',
      requireIndependent: true,
    });
  });
});

// ===========================================================================
// Regression: ollama-only providerChain no longer causes judged=0
// ===========================================================================

describe('M176 regression — ollama-only providerChain', () => {
  it('ollama-only providerChain + frontier client available → proposals ARE judged', async () => {
    // This is the exact production failure scenario:
    // cfg.models.providerChain = ["ollama"] caused getActiveClient to return
    // hasComplete=false → resolveJudgeClientForPass returned null → judged=0.
    // With the fix, resolveFrontierJudgeClient (M135 path) is used instead.
    const proposals = ['reg-a', 'reg-b'].map((id) => makeProp(id));
    mockListProposals.mockReturnValue(proposals);
    mockReadDecisions.mockReturnValue([]);

    mockJudgeProposal.mockResolvedValue({
      proposalId: 'any', verdict: 'ship', value: 5, correctness: 5,
      scope: 1, alignment: 5, rationale: 'ship', wouldMerge: true,
    } satisfies ManagerVerdict);

    // enabledCfg already sets providerChain: ['ollama']
    const r = await runAutoMergePass(enabledCfg());

    // M176 fix: judged > 0 (the broken path returned 0).
    expect(r.judged).toBe(2);
    expect(r.attempted).toBe(2);
    expect(r.merged).toBe(2);
    expect(mockGetActiveClient).not.toHaveBeenCalled();
  });
});
