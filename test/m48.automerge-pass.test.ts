/**
 * M48 auto-merge-pass unit tests — runAutoMergePass(cfg).
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - autoMergeProposal (the M47 gate) is MOCKED — the real merge-to-main gate
 *    (worktrees, git, gh, verify commands) NEVER runs here. The mock records
 *    every call and returns a controllable {ok,merged,reason} per proposal id.
 *  - listProposals is MOCKED so the pending set is fully controlled (a mix of
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

// listProposals — returns a controllable proposal set via a mutable holder.
let pendingProposals: Proposal[] = [];
const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
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

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m48-amp-home-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = tmpHome;

  mockAutoMergeProposal.mockReset();
  mockVerifyProposal.mockReset();
  mockListProposals.mockReset();
  mockJudgeProposal.mockReset();
  mockReadDecisions.mockReset();
  mockRecordDecision.mockReset();
  mergeResults = {};
  pendingProposals = [];

  mockReadDecisions.mockReturnValue([]);
  mockListProposals.mockImplementation(() => pendingProposals);
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
    expect(mockListProposals).not.toHaveBeenCalled();
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
    expect(mockListProposals).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('records a signed attestation for GPT-5/Codex frontier judges', async () => {
    pendingProposals = [makeProposal('frontier-gpt', {
      engineTier: 'frontier',
      workItemId: '/tmp/repo:issue:frontier-gpt',
      workSource: 'issue',
      runId: 'run-frontier-gpt',
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
    });
    expect(typeof judgedCall?.[0]?.judgeAttestation).toBe('string');
    expect(judgedCall?.[0]?.judgeAttestation).toHaveLength(64);
  });

  it('records auto-merge verification lifecycle telemetry in evidence-backed mode', async () => {
    pendingProposals = [makeProposal('evidence-verify', { engineTier: 'local' })];
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
      counts: { commands: 1 },
    });
    expect(events[1]).toMatchObject({
      actor: 'verifier',
      kind: 'verification',
      outcome: 'unknown',
      proposalId: 'evidence-verify',
      repo: '/tmp/repo',
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
