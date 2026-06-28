/**
 * M139 — iMessage/Telegram "approve merges by text" path.
 *
 * Modules under test:
 *   src/core/comms/merge-requests.ts  — postShipProposalsForApproval
 *   src/core/comms/handlers.ts        — handleManagerApproval (index 0/1/2)
 *   src/cli/comms.ts                  — cmdComms 'ask-merges'
 *
 * All external I/O is mocked:
 *   - sendIMessage          → vi.fn()
 *   - runManager            → vi.fn() (returns deterministic ManagerReport)
 *   - applyProposal         → vi.fn() (the human-authorized path, mocked at boundary)
 *   - runCommsCycle         → vi.fn()
 *   - loadConfig            → vi.fn()
 *   - inbox/store           → real (tmp HOME isolation via process.env.HOME)
 *
 * Architecture invariant: index 0 (human tap) uses applyProposal (human path),
 * NOT autoMergeProposal (autonomous frontier-only path). A Telegram/iMessage tap
 * from the authenticated owner IS a human approval — the human IS the authority,
 * so it merges work of ANY tier (local/mid/frontier).
 *
 * Test counts (16):
 *   postShipProposalsForApproval:
 *    1. posts one request for the highest-value ship verdict with a pending proposal
 *    2. skips non-pending proposals (already merged/rejected)
 *    3. skips non-ship verdicts (review/noise/harmful)
 *    4. posts nothing when no ship verdicts
 *    5. posts nothing when an outstanding manager-approval already exists
 *   handleManagerApproval:
 *    6. index 0 (Approve): calls setStatus approved + applyProposal (human-authorized path)
 *    7. index 0 apply succeeds → sendIMessage "✅ Merged"
 *    8. index 0 apply fails → sendIMessage "Approved but apply failed: <reason>"
 *    9. index 1 (Reject): setStatus rejected + sendIMessage "Rejected"
 *   10. index 2 (Show diff): sendIMessage scrubbed diff + re-posts approval question
 *   11. index 2 scrubs secrets from diff text
 *   12. index 2 truncates long diffs to MAX_DIFF_SMS chars
 *   13. index 0 with missing proposal → no-op, no throw
 *   14. handler never throws even when applyProposal rejects
 *   15. index 0 with a LOCAL-tier proposal → applyProposal called (no tier gate)
 *   cmdComms ask-merges:
 *   16. ask-merges calls postShipProposalsForApproval + runCommsCycle, returns 0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const {
  mockSendIMessage,
  mockRunManager,
  mockApplyProposal,
  mockRunCommsCycle,
  mockLoadConfig,
} = vi.hoisted(() => ({
  mockSendIMessage: vi.fn().mockResolvedValue({ ok: true }),
  mockRunManager: vi.fn(),
  mockApplyProposal: vi.fn(),
  mockRunCommsCycle: vi.fn().mockResolvedValue({ sent: 1, resolved: 0 }),
  mockLoadConfig: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (p: unknown): boolean => {
      if (typeof p === 'string' && p.endsWith('chat.db')) return true;
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0]);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, '', '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

vi.mock('../src/core/integrations/imessage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/imessage.js')>();
  return {
    ...actual,
    sendIMessage: mockSendIMessage,
    commsEnabled: (_cfg: unknown) => {
      const c = (_cfg as { comms?: { enabled?: boolean; imessageHandle?: string } }).comms;
      return !!(c?.enabled && c?.imessageHandle);
    },
  };
});

vi.mock('../src/core/fleet/manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/manager.js')>();
  return { ...actual, runManager: mockRunManager };
});

vi.mock('../src/core/inbox/apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/apply.js')>();
  return { ...actual, applyProposal: mockApplyProposal };
});

vi.mock('../src/core/comms/dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/dispatch.js')>();
  return { ...actual, runCommsCycle: mockRunCommsCycle };
});

vi.mock('../src/core/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

// strategist — not needed in these tests but handlers.ts imports it
vi.mock('../src/core/vision/strategist.js', () => ({
  loadLatestBriefing: vi.fn().mockReturnValue(null),
  adoptBriefing: vi.fn(),
  runStrategist: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { postShipProposalsForApproval } from '../src/core/comms/merge-requests.js';
import { registerCommsHandlers } from '../src/core/comms/handlers.js';
import { postRequest, listRequests, markSent, resolveRequest } from '../src/core/comms/requests.js';
import { createProposal, setStatus, loadProposal } from '../src/core/inbox/store.js';
import { cmdComms } from '../src/cli/comms.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { ManagerReport, ManagerVerdict } from '../src/core/fleet/manager.js';
import type { QualityMetrics } from '../src/core/types.js';
import { makeCfg } from './helpers/h1-fixture.js';
import * as dispatchModule from '../src/core/comms/dispatch.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cfgEnabled(): AshlrConfig {
  return makeCfg({
    comms: { enabled: true, imessageHandle: '+15555550100', service: 'iMessage' },
    foundry: { autoMerge: { enabled: true } },
  });
}

function zeroMetrics(): QualityMetrics {
  return {
    proposalsCreated: 5,
    merged: 3,
    rejected: 1,
    pending: 1,
    emptyRate: 0.0,
    trivialRatio: 0.1,
    acceptRate: 0.6,
    avgDiffLines: 10,
    byEngine: {},
    byRepo: {},
    trends: [],
    windowLabel: '7d',
  };
}

function makeVerdict(
  proposalId: string,
  verdict: ManagerVerdict['verdict'] = 'ship',
  value = 4,
): ManagerVerdict {
  return {
    proposalId,
    verdict,
    value,
    correctness: 4,
    scope: 1,
    alignment: 4,
    rationale: 'small low-risk change',
    wouldMerge: verdict === 'ship',
  };
}

function makeReport(verdicts: ManagerVerdict[]): ManagerReport {
  return {
    generatedAt: new Date().toISOString(),
    window: '7d',
    metrics: zeroMetrics(),
    verdicts,
    wins: verdicts.filter((v) => v.verdict === 'ship').map((v) => v.proposalId),
    concerns: [],
    recommendations: ['Fleet nominal.'],
    narrative: 'All good.',
    judgeEngine: 'mock-judge',
  };
}

function makePendingProposal(title = 'Test proposal'): ReturnType<typeof createProposal> {
  return createProposal({
    repo: '/fake/repo',
    origin: 'agent',
    kind: 'patch',
    title,
    summary: 'test',
    diff: `diff --git a/docs/x.md b/docs/x.md\n--- /dev/null\n+++ b/docs/x.md\n@@ -0,0 +1 @@\n+content\n`,
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let _tmpHome: string;
let _prevHome: string | undefined;

beforeEach(() => {
  _prevHome = process.env.HOME;
  _tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m139-'));
  process.env.HOME = _tmpHome;

  mockSendIMessage.mockClear();
  mockRunManager.mockClear();
  mockApplyProposal.mockClear();
  mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });
  mockLoadConfig.mockResolvedValue(cfgEnabled());
});

afterEach(() => {
  vi.clearAllMocks();
  if (_prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = _prevHome;
  try { rmSync(_tmpHome, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ===========================================================================
// postShipProposalsForApproval
// ===========================================================================

describe('postShipProposalsForApproval', () => {
  it('[1] posts one request for the highest-value ship verdict with a pending proposal', async () => {
    const p = makePendingProposal('My feature');
    mockRunManager.mockResolvedValue(makeReport([makeVerdict(p.id, 'ship', 4)]));

    const result = await postShipProposalsForApproval(cfgEnabled());

    expect(result.posted).toBe(1);
    const reqs = listRequests({ kind: 'manager-approval' });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.type).toBe('approval');
    expect(reqs[0]!.options).toEqual(['Approve & merge', 'Reject', 'Show diff']);
    expect(reqs[0]!.meta?.proposalId).toBe(p.id);
    expect(reqs[0]!.text).toContain('My feature');
    expect(reqs[0]!.text).toContain('SHIP');
  });

  it('[2] skips non-pending proposals (already applied)', async () => {
    const p = makePendingProposal('Merged already');
    setStatus(p.id, 'applied');
    mockRunManager.mockResolvedValue(makeReport([makeVerdict(p.id, 'ship', 4)]));

    const result = await postShipProposalsForApproval(cfgEnabled());
    expect(result.posted).toBe(0);
    expect(listRequests({ kind: 'manager-approval' })).toHaveLength(0);
  });

  it('[3] skips non-ship verdicts (review/noise/harmful)', async () => {
    const p = makePendingProposal('Noisy proposal');
    const verdicts: ManagerVerdict[] = [
      makeVerdict(p.id, 'review', 3),
      makeVerdict(p.id, 'noise', 2),
      makeVerdict(p.id, 'harmful', 1),
    ];
    mockRunManager.mockResolvedValue(makeReport(verdicts));

    const result = await postShipProposalsForApproval(cfgEnabled());
    expect(result.posted).toBe(0);
  });

  it('[4] posts nothing when no ship verdicts exist', async () => {
    mockRunManager.mockResolvedValue(makeReport([]));
    const result = await postShipProposalsForApproval(cfgEnabled());
    expect(result.posted).toBe(0);
  });

  it('[5] posts nothing when an outstanding manager-approval already exists', async () => {
    const p = makePendingProposal('Blocked');
    mockRunManager.mockResolvedValue(makeReport([makeVerdict(p.id, 'ship', 5)]));

    // Post and mark as sent (outstanding)
    const existingId = postRequest({
      kind: 'manager-approval',
      type: 'approval',
      text: 'Old approval',
      options: ['Approve & merge', 'Reject', 'Show diff'],
      meta: { proposalId: 'old-id' },
    });
    markSent(existingId);

    const result = await postShipProposalsForApproval(cfgEnabled());
    expect(result.posted).toBe(0);
    // Only the original outstanding request exists
    expect(listRequests({ kind: 'manager-approval' })).toHaveLength(1);
  });
});

// ===========================================================================
// handleManagerApproval — via registerCommsHandlers + spy pattern
// ===========================================================================

describe('handleManagerApproval', () => {
  /** Invoke the manager-approval handler directly by capturing it via spy. */
  async function invokeApprovalHandler(
    cfg: AshlrConfig,
    answerIndex: number,
    meta: Record<string, unknown>,
  ): Promise<void> {
    let capturedFn: ((req: unknown) => void | Promise<void>) | undefined;

    const spy = vi.spyOn(dispatchModule, 'registerResolutionHandler').mockImplementation(
      (kind: string, fn: (req: unknown) => void | Promise<void>) => {
        if (kind === 'manager-approval') capturedFn = fn;
      },
    );

    registerCommsHandlers(cfg);
    spy.mockRestore();

    if (capturedFn) {
      const req = {
        id: `test-${answerIndex}`,
        kind: 'manager-approval',
        type: 'approval' as const,
        text: 'Merge "Test proposal"?',
        options: ['Approve & merge', 'Reject', 'Show diff'],
        status: 'answered' as const,
        answerIndex,
        answerText: ['Approve & merge', 'Reject', 'Show diff'][answerIndex],
        createdAt: new Date().toISOString(),
        meta,
      };
      await capturedFn(req);
    }
  }

  it('[6] index 0 (Approve): calls setStatus approved + applyProposal (human-authorized path)', async () => {
    const p = makePendingProposal('Human-approved proposal');
    mockApplyProposal.mockResolvedValue({ ok: true, status: 'applied', detail: 'patch applied' });

    await invokeApprovalHandler(cfgEnabled(), 0, { proposalId: p.id });

    // setStatus called — proposal is now approved (set before applyProposal)
    const loaded = loadProposal(p.id);
    expect(loaded?.status).toBe('approved');
    // applyProposal called with confirmed:true — human-authorized path, no tier gate
    expect(mockApplyProposal).toHaveBeenCalledWith(p.id, { confirmed: true });
  });

  it('[7] index 0 apply succeeds → sendIMessage "✅ Merged"', async () => {
    const p = makePendingProposal('Ships fine');
    mockApplyProposal.mockResolvedValue({ ok: true, status: 'applied', detail: 'patch applied' });

    await invokeApprovalHandler(cfgEnabled(), 0, { proposalId: p.id });

    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('✅ Merged');
    expect(text).toContain('Ships fine');
  });

  it('[8] index 0 apply fails → sendIMessage "Approved but apply failed: <reason>"', async () => {
    const p = makePendingProposal('Apply failed');
    mockApplyProposal.mockResolvedValue({
      ok: false,
      status: 'failed',
      detail: 'git apply failed: patch does not apply',
    });

    await invokeApprovalHandler(cfgEnabled(), 0, { proposalId: p.id });

    // Status was set to approved (human gate done before apply)
    expect(loadProposal(p.id)?.status).toBe('approved');
    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('Approved but apply failed');
    expect(text).toContain('patch does not apply');
    expect(text).toContain('needs manual review');
  });

  it('[9] index 1 (Reject): setStatus rejected + sendIMessage "Rejected"', async () => {
    const p = makePendingProposal('Rejected proposal');

    await invokeApprovalHandler(cfgEnabled(), 1, { proposalId: p.id });

    expect(loadProposal(p.id)?.status).toBe('rejected');
    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('Rejected');
    expect(text).toContain('Rejected proposal');
  });

  it('[10] index 2 (Show diff): sendIMessage scrubbed diff + re-posts approval question', async () => {
    const p = makePendingProposal('Show me the diff');

    await invokeApprovalHandler(cfgEnabled(), 2, { proposalId: p.id });

    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('Diff for "Show me the diff"');

    // Re-post: a new manager-approval request appears in the store
    const reqs = listRequests({ kind: 'manager-approval', status: 'pending' });
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs[reqs.length - 1]!.meta?.proposalId).toBe(p.id);
  });

  it('[11] index 2 scrubs secrets from diff text', async () => {
    const p = createProposal({
      repo: '/fake/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'Secret diff',
      summary: 'test',
      diff: `+token=sk-abc12345678901234567890\n+api_key=ghp_abc12345678901234567890\n`,
    });

    await invokeApprovalHandler(cfgEnabled(), 2, { proposalId: p.id });

    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).not.toContain('sk-abc');
    expect(text).not.toContain('ghp_abc');
    expect(text).toContain('[REDACTED]');
  });

  it('[12] index 2 truncates long diffs', async () => {
    const longLine = '+' + 'x'.repeat(200);
    const bigDiff = Array.from({ length: 20 }, () => longLine).join('\n');
    const p = createProposal({
      repo: '/fake/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'Long diff',
      summary: 'test',
      diff: bigDiff,
    });

    await invokeApprovalHandler(cfgEnabled(), 2, { proposalId: p.id });

    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    // 1500 chars max + header, so total text length is bounded
    expect(text.length).toBeLessThan(1500 + 100);
    expect(text).toContain('…[truncated]');
  });

  it('[13] index 0 with missing proposal → no-op, no throw', async () => {
    await expect(
      invokeApprovalHandler(cfgEnabled(), 0, { proposalId: 'does-not-exist-m139' }),
    ).resolves.not.toThrow();
    expect(mockApplyProposal).not.toHaveBeenCalled();
    expect(mockSendIMessage).not.toHaveBeenCalled();
  });

  it('[14] handler never throws even when applyProposal rejects', async () => {
    const p = makePendingProposal('Crash test');
    mockApplyProposal.mockRejectedValue(new Error('unexpected crash'));

    await expect(
      invokeApprovalHandler(cfgEnabled(), 0, { proposalId: p.id }),
    ).resolves.not.toThrow();
  });

  it('[15] LOCAL-tier proposal is mergeable via human approve (no tier gate in applyProposal)', async () => {
    // Create a proposal without any tier/trust field — this is "local" tier.
    // The human tap must route to applyProposal, which has no tier gate.
    const p = createProposal({
      repo: '/fake/repo',
      origin: 'agent',
      kind: 'patch',
      title: 'Local tier work',
      summary: 'Small local change',
      diff: `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n`,
    });
    // applyProposal succeeds — local tier, no frontier gate
    mockApplyProposal.mockResolvedValue({ ok: true, status: 'applied', detail: 'patch applied on branch ashlr/proposal/...' });

    await invokeApprovalHandler(cfgEnabled(), 0, { proposalId: p.id });

    // applyProposal was called (not blocked by any tier check)
    expect(mockApplyProposal).toHaveBeenCalledWith(p.id, { confirmed: true });
    // Success message sent
    expect(mockSendIMessage).toHaveBeenCalledOnce();
    const [text] = mockSendIMessage.mock.calls[0] as [string, unknown];
    expect(text).toContain('✅ Merged');
    expect(text).toContain('Local tier work');
  });
});

// ===========================================================================
// cmdComms ask-merges
// ===========================================================================

describe('cmdComms ask-merges', () => {
  it('[16] ask-merges posts ship proposals and runs cycle, returns 0', async () => {
    const p = makePendingProposal('CLI ship');
    mockRunManager.mockResolvedValue(makeReport([makeVerdict(p.id, 'ship', 4)]));
    mockRunCommsCycle.mockResolvedValue({ sent: 1, resolved: 0 });

    const exitCode = await cmdComms(['ask-merges']);

    expect(exitCode).toBe(0);
    expect(mockRunCommsCycle).toHaveBeenCalledOnce();
    // A manager-approval request was posted
    const reqs = listRequests({ kind: 'manager-approval' });
    expect(reqs.length).toBeGreaterThan(0);
  });

  it('ask-merges returns 1 when comms disabled', async () => {
    mockLoadConfig.mockResolvedValue(makeCfg({ comms: { enabled: false } }));
    const exitCode = await cmdComms(['ask-merges']);
    expect(exitCode).toBe(1);
  });
});
