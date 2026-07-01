/**
 * M214 — automerge-pass hook wiring.
 *
 * Verifies that the additive fire-and-forget hooks in automerge-pass.ts
 * correctly call emitMerge / emitJudgeVerdict at the right observation points,
 * and that failures in those hooks never alter the pass result.
 *
 *  [A1]  emitMerge called when res.merged===true (next to M212 notifyFleetEvent)
 *  [A2]  emitJudgeVerdict called for each inline judge call (ship + non-ship)
 *  [A3]  hooks are fire-and-forget — automerge result unchanged when emit fails
 *
 * HERMETICITY:
 *  - HOME overridden to tmp dir.
 *  - fleet-pulse-emit MOCKED (isolates hook wiring from OTLP transport).
 *  - All automerge-pass dependencies mocked (no real LLM/git calls).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Hermetic HOME
// ---------------------------------------------------------------------------
let tmpHome: string;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'm214a-'));
  process.env['HOME'] = tmpHome;
});
afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock fleet-pulse-emit to isolate hook wiring from OTLP transport
// ---------------------------------------------------------------------------
const mockEmitMerge = vi.fn().mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' });
const mockEmitJudgeVerdict = vi.fn().mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' });

vi.mock('../src/core/integrations/fleet-pulse-emit.js', () => ({
  fleetPulseEnabled: () => true,
  emitMerge: (...args: unknown[]) => mockEmitMerge(...args),
  emitJudgeVerdict: (...args: unknown[]) => mockEmitJudgeVerdict(...args),
  emitProposalCreated: vi.fn().mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' }),
  emitTickCost: vi.fn().mockResolvedValue({ ok: true, skipped: false, status: 200, spanCount: 1, detail: 'ok' }),
}));

// ---------------------------------------------------------------------------
// Mock automerge-pass dependencies
// ---------------------------------------------------------------------------
const mockAutoMergeProposal = vi.fn();
vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => mockAutoMergeProposal(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
}));

const mockListProposals = vi.fn();
vi.mock('../src/core/inbox/store.js', () => ({
  listProposals: (...args: unknown[]) => mockListProposals(...args),
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

vi.mock('../src/core/fleet/red-team.js', () => ({ redTeamProposal: vi.fn().mockResolvedValue({ verdict: 'ok' }) }));
vi.mock('../src/core/run/blast-radius.js', () => ({ analyzeBlastRadius: vi.fn().mockResolvedValue({ risk: 'low', detail: '' }) }));
vi.mock('../src/core/run/spec-contract.js', () => ({ checkSpecContract: vi.fn().mockResolvedValue({ satisfied: true, detail: { reason: '' } }) }));
vi.mock('../src/core/comms/events.js', () => ({ notifyFleetEvent: vi.fn().mockResolvedValue(undefined) }));

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------
import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const baseCfg = {
  foundry: {
    pulseEmit: true,
    autoMerge: { enabled: true },
  },
};

const proposal = {
  id: 'prop-merge-test',
  title: 'test proposal',
  status: 'pending',
  engineTier: 'frontier',
  repo: '/repos/test',
  diff: '',
  createdAt: new Date().toISOString(),
};

const fakeJudgeClient = { complete: vi.fn(), model: 'claude-3-5-sonnet' };

beforeEach(() => {
  mockListProposals.mockReturnValue([proposal]);
  mockKillSwitchOn.mockReturnValue(false);
  mockReadDecisions.mockReturnValue([]);
  mockResolveFrontierJudgeClient.mockReturnValue(fakeJudgeClient);
  mockEmitMerge.mockClear();
  mockEmitJudgeVerdict.mockClear();
  mockJudgeProposal.mockClear();
  mockAutoMergeProposal.mockClear();
});

// ---------------------------------------------------------------------------
// [A1] emitMerge called when merge succeeds
// ---------------------------------------------------------------------------
describe('[A1] emitMerge called on successful merge', () => {
  it('calls emitMerge with correct args when res.merged===true', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, reason: 'ok' });

    await runAutoMergePass(baseCfg as never);
    // Allow fire-and-forget microtasks to settle
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEmitMerge).toHaveBeenCalledWith(
      baseCfg,
      proposal.id,
      proposal.repo,
      proposal.engineTier,
    );
  });

  it('does NOT call emitMerge when merge did not happen (merged===false)', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: false, branched: false, reason: 'gate-fail' });

    await runAutoMergePass(baseCfg as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEmitMerge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [A2] emitJudgeVerdict called for every inline judge call
// ---------------------------------------------------------------------------
describe('[A2] emitJudgeVerdict called for every inline judge call', () => {
  it('called with ship verdict when judge ships', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, reason: 'ok' });

    await runAutoMergePass(baseCfg as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEmitJudgeVerdict).toHaveBeenCalledWith(
      baseCfg,
      proposal.id,
      'ship',
      proposal.repo,
      proposal.engineTier,
    );
  });

  it('called with review verdict (non-ship) — no merge', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'review', proposalId: proposal.id });
    // autoMergeProposal should NOT be called for non-ship
    mockAutoMergeProposal.mockResolvedValue({ merged: false, branched: false, reason: 'review' });

    await runAutoMergePass(baseCfg as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEmitJudgeVerdict).toHaveBeenCalledWith(
      baseCfg,
      proposal.id,
      'review',
      proposal.repo,
      proposal.engineTier,
    );
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });

  it('called with noise verdict — no merge', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'noise', proposalId: proposal.id });

    await runAutoMergePass(baseCfg as never);
    await new Promise((r) => setTimeout(r, 20));

    expect(mockEmitJudgeVerdict).toHaveBeenCalledWith(
      baseCfg,
      proposal.id,
      'noise',
      proposal.repo,
      proposal.engineTier,
    );
    expect(mockAutoMergeProposal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [A3] hooks are fire-and-forget — automerge result unchanged when emit fails
// ---------------------------------------------------------------------------
describe('[A3] automerge result unchanged when hooks fail', () => {
  it('merged count correct even when emitMerge rejects', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, reason: 'ok' });
    mockEmitMerge.mockRejectedValueOnce(new Error('emit network error'));

    const result = await runAutoMergePass(baseCfg as never);
    expect(result.merged).toBe(1);
    expect(result.attempted).toBe(1);
  });

  it('judged count correct even when emitJudgeVerdict rejects', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, reason: 'ok' });
    mockEmitJudgeVerdict.mockRejectedValueOnce(new Error('emit error'));

    const result = await runAutoMergePass(baseCfg as never);
    expect(result.judged).toBe(1);
  });

  it('runAutoMergePass never throws when both hooks fail', async () => {
    mockJudgeProposal.mockResolvedValue({ verdict: 'ship', proposalId: proposal.id });
    mockAutoMergeProposal.mockResolvedValue({ merged: true, branched: false, reason: 'ok' });
    mockEmitMerge.mockRejectedValue(new Error('emit error'));
    mockEmitJudgeVerdict.mockRejectedValue(new Error('emit error'));

    await expect(runAutoMergePass(baseCfg as never)).resolves.toBeDefined();
  });
});
