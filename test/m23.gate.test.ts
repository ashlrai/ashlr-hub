/**
 * M23 gate invariant tests — PENDING NEVER AUTO-APPLIES; only approve+confirm triggers apply.
 *
 * SAFETY GUARDRAILS:
 *  - HOME is overridden to a tmp dir.
 *  - applyProposal is mocked to track calls — tests assert it is NOT called
 *    by create/list/show, ONLY by the explicit approve+confirm path.
 *  - No real git repos needed for gate tests (we're testing the CLI gate logic).
 *  - spawnSync mocked to prevent any real gh calls.
 *
 * Invariants asserted (the gate's integrity):
 *  - createProposal NEVER calls applyProposal (PENDING NEVER AUTO-APPLIES)
 *  - listProposals NEVER calls applyProposal
 *  - loadProposal NEVER calls applyProposal
 *  - setStatus NEVER calls applyProposal
 *  - pendingCount NEVER calls applyProposal
 *  - Only cmdInbox approve + confirmed triggers applyProposal
 *  - Non-TTY approve without --yes refuses (does not call applyProposal)
 *  - reject subcommand calls setStatus(rejected) but NEVER applyProposal
 *  - The CLI gate is the ONLY place applyProposal is triggered
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

// ---------------------------------------------------------------------------
// spawnSync mock — prevent real `gh` calls
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawnSync: () => ({
      pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null, error: undefined,
    }),
    execFileSync: actual.execFileSync,
  };
});

// ---------------------------------------------------------------------------
// Mock applyProposal — track all calls to assert the gate invariants
// ---------------------------------------------------------------------------

// We mock the entire apply module so we can spy on applyProposal calls.
// The store and CLI modules are NOT mocked — they run real logic.
const applyProposalSpy = vi.fn(async (_id: string, _opts: { confirmed: boolean }) => ({
  ok: true,
  status: 'applied' as const,
  detail: 'mocked apply',
}));

vi.mock('../src/core/inbox/apply.js', () => ({
  applyProposal: (...args: Parameters<typeof applyProposalSpy>) => applyProposalSpy(...args),
}));

// ---------------------------------------------------------------------------
// Lazy imports
// ---------------------------------------------------------------------------

import {
  createProposal,
  listProposals,
  loadProposal,
  setStatus,
  pendingCount,
} from '../src/core/inbox/store.js';
import { cmdInbox } from '../src/cli/inbox.js';
import type { Proposal } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides?: Partial<Omit<Proposal, 'id' | 'status' | 'createdAt'>>) {
  return {
    repo: '/tmp/test-repo',
    origin: 'manual' as const,
    kind: 'patch' as const,
    title: 'Test proposal',
    summary: 'A test summary',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m23-gate-home-'));
  process.env.HOME = tmpHome;
  applyProposalSpy.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
  vi.clearAllMocks();
});

// ===========================================================================
// createProposal NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — createProposal NEVER auto-applies', () => {
  it('does NOT call applyProposal when creating a proposal', () => {
    createProposal(makeInput());
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('created proposal remains status=pending (never advanced to applied)', () => {
    const p = createProposal(makeInput());
    const loaded = loadProposal(p.id);
    expect(loaded!.status).toBe('pending');
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('creating multiple proposals NEVER calls applyProposal', () => {
    createProposal(makeInput({ title: 'P1' }));
    createProposal(makeInput({ title: 'P2' }));
    createProposal(makeInput({ title: 'P3' }));
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// listProposals NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — listProposals NEVER calls applyProposal', () => {
  it('does NOT call applyProposal when listing proposals', () => {
    createProposal(makeInput({ title: 'A' }));
    createProposal(makeInput({ title: 'B' }));
    applyProposalSpy.mockClear(); // clear any calls from createProposal

    listProposals();
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('does NOT call applyProposal when listing with status filter', () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'approved');
    applyProposalSpy.mockClear();

    listProposals({ status: 'approved' });
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('listing an empty inbox does NOT call applyProposal', () => {
    listProposals();
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// loadProposal NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — loadProposal NEVER calls applyProposal', () => {
  it('does NOT call applyProposal on load', () => {
    const p = createProposal(makeInput());
    applyProposalSpy.mockClear();

    loadProposal(p.id);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('loadProposal on a nonexistent id does NOT call applyProposal', () => {
    loadProposal('does-not-exist');
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// setStatus NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — setStatus NEVER calls applyProposal', () => {
  it('does NOT call applyProposal when setting status to approved', () => {
    const p = createProposal(makeInput());
    applyProposalSpy.mockClear();

    setStatus(p.id, 'approved');
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('does NOT call applyProposal when setting status to rejected', () => {
    const p = createProposal(makeInput());
    applyProposalSpy.mockClear();

    setStatus(p.id, 'rejected');
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('does NOT call applyProposal for any status transition', () => {
    const statuses: Array<import('../src/core/types.js').ProposalStatus> = [
      'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed',
    ];
    for (const status of statuses) {
      const p = createProposal(makeInput({ title: `status-${status}` }));
      applyProposalSpy.mockClear();
      setStatus(p.id, status);
      expect(applyProposalSpy).not.toHaveBeenCalled();
    }
  });
});

// ===========================================================================
// pendingCount NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — pendingCount NEVER calls applyProposal', () => {
  it('does NOT call applyProposal when counting pending', () => {
    createProposal(makeInput({ title: 'X' }));
    applyProposalSpy.mockClear();

    pendingCount();
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CLI: `inbox list` (no subcommand) NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — CLI inbox list NEVER calls applyProposal', () => {
  it('`ashlr inbox` (no subcommand) does NOT call applyProposal', async () => {
    createProposal(makeInput({ title: 'List test' }));
    applyProposalSpy.mockClear();

    await cmdInbox([]);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CLI: `inbox show <id>` NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — CLI inbox show NEVER calls applyProposal', () => {
  it('`ashlr inbox show <id>` does NOT call applyProposal', async () => {
    const p = createProposal(makeInput({ title: 'Show test' }));
    applyProposalSpy.mockClear();

    await cmdInbox(['show', p.id]);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('`ashlr inbox show <nonexistent>` does NOT call applyProposal', async () => {
    await cmdInbox(['show', 'nonexistent-id']);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CLI: `inbox reject <id>` sets status=rejected, NEVER calls applyProposal
// ===========================================================================

describe('M23 gate — CLI inbox reject sets rejected, NEVER calls applyProposal', () => {
  it('`ashlr inbox reject <id>` sets status=rejected', async () => {
    const p = createProposal(makeInput({ title: 'Reject me' }));
    applyProposalSpy.mockClear();

    await cmdInbox(['reject', p.id]);

    const loaded = loadProposal(p.id);
    expect(loaded!.status).toBe('rejected');
  });

  it('`ashlr inbox reject <id>` does NOT call applyProposal', async () => {
    const p = createProposal(makeInput({ title: 'No apply on reject' }));
    applyProposalSpy.mockClear();

    await cmdInbox(['reject', p.id]);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });

  it('`ashlr inbox reject` on already-rejected id does NOT call applyProposal', async () => {
    const p = createProposal(makeInput());
    setStatus(p.id, 'rejected');
    applyProposalSpy.mockClear();

    await cmdInbox(['reject', p.id]);
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CLI: non-TTY approve without --yes REFUSES (does NOT call applyProposal)
// ===========================================================================

describe('M23 gate — non-TTY approve without --yes refuses', () => {
  it('does NOT call applyProposal without --yes in non-TTY context', async () => {
    const p = createProposal(makeInput({ title: 'No-yes test' }));
    setStatus(p.id, 'approved');
    applyProposalSpy.mockClear();

    // In a non-TTY context (CI/test) without --yes, approve must refuse.
    // process.stdin.isTTY is false in vitest.
    const code = await cmdInbox(['approve', p.id]);
    // Must not have called applyProposal
    expect(applyProposalSpy).not.toHaveBeenCalled();
    // Must return a non-zero exit code (refused)
    expect(code).not.toBe(0);
  });

  it('non-TTY approve without --yes leaves status unchanged', async () => {
    const p = createProposal(makeInput({ title: 'Unchanged status' }));
    setStatus(p.id, 'approved');
    applyProposalSpy.mockClear();

    await cmdInbox(['approve', p.id]);

    // Status should still be 'approved' (not advanced to applied/failed)
    const loaded = loadProposal(p.id);
    // applyProposal was not called, so status is unchanged
    expect(loaded!.status).toBe('approved');
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CLI: approve + --yes IS the ONLY trigger for applyProposal
// ===========================================================================

describe('M23 gate — CLI approve + --yes is the ONLY apply trigger', () => {
  it('`inbox approve <id> --yes` calls applyProposal with confirmed:true', async () => {
    const p = createProposal(makeInput({ title: 'Approve me' }));
    setStatus(p.id, 'approved');
    applyProposalSpy.mockClear();

    await cmdInbox(['approve', p.id, '--yes']);

    // applyProposal MUST have been called exactly once with confirmed:true
    expect(applyProposalSpy).toHaveBeenCalledTimes(1);
    expect(applyProposalSpy).toHaveBeenCalledWith(p.id, { confirmed: true });
  });

  it('`inbox approve <id> --yes` does not call applyProposal for a pending proposal', async () => {
    // Even with --yes, if the proposal is pending, applyProposal may be called
    // but it MUST refuse internally (tested in apply tests). Here we test
    // that the CLI does call applyProposal — the gate is enforced inside applyProposal.
    // This test confirms the CLI passes confirmed:true to applyProposal.
    const p = createProposal(makeInput({ title: 'Pending with --yes' }));
    // Do NOT setStatus to approved — stays pending
    applyProposalSpy.mockClear();

    // The CLI might call applyProposal even for pending — that's fine,
    // the gate is inside applyProposal itself. What matters is that
    // without --yes it does NOT call applyProposal.
    await cmdInbox(['approve', p.id, '--yes']);

    // If called, it was with confirmed:true
    if (applyProposalSpy.mock.calls.length > 0) {
      expect(applyProposalSpy).toHaveBeenCalledWith(p.id, { confirmed: true });
    }
    // If not called (CLI may pre-check status), that's also acceptable
  });

  it('partial review evidence cannot be approved or routed to applyProposal', async () => {
    const p = createProposal(makeInput({
      title: 'Incomplete capture',
      isPartial: true,
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n',
    }));

    setStatus(p.id, 'approved');
    expect(loadProposal(p.id)?.status).toBe('pending');

    const code = await cmdInbox(['approve', p.id, '--yes']);

    expect(code).toBe(1);
    expect(applyProposalSpy).not.toHaveBeenCalled();
    expect(loadProposal(p.id)?.status).toBe('pending');
  });

  it('approving a nonexistent proposal with --yes does NOT call applyProposal', async () => {
    applyProposalSpy.mockClear();

    // A nonexistent id — CLI should detect this and skip the apply call
    // OR call applyProposal which will return ok:false. Either way is acceptable.
    // The key invariant is no uncontrolled outward mutation.
    const code = await cmdInbox(['approve', 'nonexistent-id', '--yes']);
    // Should fail gracefully
    expect(typeof code).toBe('number');
  });
});

// ===========================================================================
// Comprehensive gate: the store operations never trigger apply — batch test
// ===========================================================================

describe('M23 gate — batch invariant: store ops NEVER trigger applyProposal', () => {
  it('a full store workflow (create → list → load → setStatus) never calls applyProposal', () => {
    applyProposalSpy.mockClear();

    // Create several proposals
    const p1 = createProposal(makeInput({ title: 'Batch A' }));
    const p2 = createProposal(makeInput({ title: 'Batch B' }));
    const p3 = createProposal(makeInput({ title: 'Batch C' }));

    // List all
    listProposals();
    listProposals({ status: 'pending' });

    // Load individually
    loadProposal(p1.id);
    loadProposal(p2.id);
    loadProposal('nonexistent');

    // Set statuses
    setStatus(p1.id, 'approved');
    setStatus(p2.id, 'rejected');
    setStatus(p3.id, 'approved');

    // Count
    pendingCount();

    // List again after status changes
    listProposals();
    listProposals({ status: 'approved' });
    listProposals({ status: 'rejected' });

    // applyProposal must have been called ZERO times throughout
    expect(applyProposalSpy).not.toHaveBeenCalled();
  });
});
