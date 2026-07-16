import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../src/core/types.js';
import {
  PROPOSAL_PERSISTENCE_MISMATCH_REASON,
  PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
} from '../src/core/inbox/persistence-mismatch.js';

const mocks = vi.hoisted(() => ({
  canonicalRealizedMergeIdentity: vi.fn((proposal: Proposal) =>
    proposal.id === 'authenticated-applied' && proposal.isPartial !== true
      ? { key: 'authenticated-realized-merge' }
      : null),
}));

vi.mock('../src/core/inbox/realized-merge.js', () => ({
  canonicalRealizedMergeIdentity: mocks.canonicalRealizedMergeIdentity,
}));

import {
  classifyOperationalProposalMembership,
  operationalProposalMembershipExpiresAt,
} from '../src/core/inbox/operational-membership.js';

const CREATED_AT = '2026-07-10T12:00:00.000Z';
const DECIDED_AT = '2026-07-10T13:00:00.000Z';
const EXPIRES_AT = '2026-07-12T12:00:00.000Z';
const RUN_ID = 'attempt-12345678-1234-4123-8123-123456789abc';

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1',
    repo: '/tmp/ashlr-operational-membership',
    origin: 'agent',
    kind: 'patch',
    title: 'Operational proposal',
    summary: 'Classify projection membership',
    status: 'pending',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function rejectedRecovery(overrides: Partial<Proposal> = {}): Proposal {
  return proposal({
    status: 'rejected',
    isPartial: true,
    decidedAt: DECIDED_AT,
    decisionReason: 'auto-drained: permanent readiness blocker persisted for 2 pass(es): capture failed',
    stuckPassCount: 2,
    verifyResult: { passed: false, source: 'capture-gate' },
    diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+partial\n',
    runId: RUN_ID,
    trajectoryId: `run:${RUN_ID}`,
    ...overrides,
  });
}

describe('M432 operational proposal membership', () => {
  it('keeps pending proposals active regardless of partial metadata', () => {
    expect(classifyOperationalProposalMembership(proposal({
      isPartial: true,
      createdAt: 'not-a-timestamp',
    }))).toEqual({
      class: 'active', type: 'lifecycle', reason: 'pending', expiresAt: null,
    });
  });

  it.each(['approved', 'awaiting-host-merge'] as const)(
    'keeps complete %s proposals active and classifies partial ones as invalid',
    (status) => {
      expect(classifyOperationalProposalMembership(proposal({ status }))).toMatchObject({
        class: 'active', type: 'lifecycle', reason: status,
      });
      expect(classifyOperationalProposalMembership(proposal({ status, isPartial: true }))).toEqual({
        class: 'invalid', type: 'lifecycle', reason: 'partial-active-lifecycle', expiresAt: null,
      });
    },
  );

  it('activates only authenticated applied merges whose v3 fanout is incomplete', () => {
    for (const realizedMergeFanoutVersion of [undefined, 1, 2] as const) {
      expect(classifyOperationalProposalMembership(proposal({
        id: 'authenticated-applied', status: 'applied', realizedMergeFanoutVersion,
      }))).toEqual({
        class: 'active',
        type: 'realized-merge-fanout',
        reason: 'realized-merge-fanout-incomplete',
        expiresAt: null,
      });
    }

    expect(classifyOperationalProposalMembership(proposal({ status: 'applied' }))).toMatchObject({
      class: 'excluded', reason: 'realized-merge-missing-or-invalid',
    });
    expect(classifyOperationalProposalMembership(proposal({
      id: 'authenticated-applied', status: 'applied', isPartial: true,
    }))).toMatchObject({ class: 'excluded', reason: 'realized-merge-missing-or-invalid' });
  });

  it('excludes fanout-v3 applied proposals only after authenticating the merge', () => {
    mocks.canonicalRealizedMergeIdentity.mockClear();
    expect(classifyOperationalProposalMembership(proposal({
      id: 'authenticated-applied', status: 'applied', realizedMergeFanoutVersion: 3,
    }))).toEqual({
      class: 'excluded',
      type: 'realized-merge-fanout',
      reason: 'realized-merge-fanout-complete',
      expiresAt: null,
    });
    expect(mocks.canonicalRealizedMergeIdentity).toHaveBeenCalledOnce();
    expect(classifyOperationalProposalMembership(proposal({
      status: 'applied', realizedMergeFanoutVersion: 3,
    }))).toMatchObject({
      class: 'excluded', reason: 'realized-merge-missing-or-invalid',
    });
  });

  it('uses an inclusive exact 48-hour recovery window', () => {
    const candidate = rejectedRecovery();
    expect(operationalProposalMembershipExpiresAt(candidate)).toBe(EXPIRES_AT);
    expect(classifyOperationalProposalMembership(candidate, new Date(DECIDED_AT))).toMatchObject({
      class: 'active', type: 'rejected-partial-recovery', expiresAt: EXPIRES_AT,
    });
    expect(classifyOperationalProposalMembership(candidate, new Date(EXPIRES_AT))).toMatchObject({
      class: 'active', reason: 'rejected-partial-recovery', expiresAt: EXPIRES_AT,
    });
    expect(classifyOperationalProposalMembership(
      candidate,
      new Date(Date.parse(EXPIRES_AT) + 1),
    )).toMatchObject({
      class: 'excluded', reason: 'rejected-partial-recovery-expired-or-invalid', expiresAt: EXPIRES_AT,
    });
    expect(classifyOperationalProposalMembership(
      candidate,
      new Date(Date.parse(DECIDED_AT) - 1),
    )).toMatchObject({ class: 'excluded' });
  });

  it('accepts only the exact proposal-local persistence-mismatch marker within 60 seconds', () => {
    const exactBoundary = rejectedRecovery({
      decidedAt: '2026-07-10T12:01:00.000Z',
      decisionReason: PROPOSAL_PERSISTENCE_MISMATCH_REASON,
      result: PROPOSAL_PERSISTENCE_MISMATCH_RESULT,
      stuckPassCount: undefined,
    });
    expect(classifyOperationalProposalMembership(
      exactBoundary,
      new Date('2026-07-10T12:01:00.000Z'),
    )).toMatchObject({ class: 'active', type: 'rejected-partial-recovery' });

    for (const candidate of [
      { ...exactBoundary, decidedAt: '2026-07-10T12:01:00.001Z' },
      { ...exactBoundary, decisionReason: undefined },
      { ...exactBoundary, decisionReason: 'human rejection' },
      { ...exactBoundary, result: undefined },
    ]) {
      expect(operationalProposalMembershipExpiresAt(candidate)).toBeNull();
    }
  });

  it.each([
    ['noncanonical createdAt', { createdAt: '2026-07-10T12:00:00Z' }],
    ['noncanonical decidedAt', { decidedAt: '2026-07-10T13:00:00Z' }],
    ['invalid createdAt', { createdAt: 'not-a-time' }],
    ['invalid decidedAt', { decidedAt: 'not-a-time' }],
    ['decision before creation', { decidedAt: '2026-07-10T11:59:59.999Z' }],
    ['decision after expiry', { decidedAt: '2026-07-12T12:00:00.001Z' }],
    ['ordinary origin', { origin: 'manual' as const }],
    ['non-capture verification', { verifyResult: { passed: false, source: 'judge' } }],
    ['empty diff', { diff: '  ' }],
    ['missing run id', { runId: undefined }],
    ['unbound trajectory', { trajectoryId: 'run:other' }],
    ['non-repair kind', { kind: 'note' as const }],
    ['missing repo', { repo: null }],
    ['missing machine counter', { stuckPassCount: undefined }],
    ['zero machine counter', { stuckPassCount: 0 }],
    ['non-integer machine counter', { stuckPassCount: 1.5 }],
    ['unrecognized rejection marker', { decisionReason: 'human rejected' }],
  ])('excludes rejected recovery with %s', (_name, overrides) => {
    const candidate = rejectedRecovery(overrides as Partial<Proposal>);
    expect(operationalProposalMembershipExpiresAt(candidate)).toBeNull();
    expect(classifyOperationalProposalMembership(
      candidate,
      new Date('2026-07-10T14:00:00.000Z'),
    )).toMatchObject({
      class: 'excluded', reason: 'rejected-partial-recovery-expired-or-invalid',
    });
  });

  it('excludes invalid clocks, ordinary rejection, complete rejection, and failure', () => {
    expect(classifyOperationalProposalMembership(
      rejectedRecovery(),
      new Date(Number.NaN),
    )).toMatchObject({ class: 'excluded' });
    expect(classifyOperationalProposalMembership(proposal({ status: 'rejected' }))).toEqual({
      class: 'excluded', type: null, reason: 'rejected', expiresAt: null,
    });
    expect(classifyOperationalProposalMembership(rejectedRecovery({
      isPartial: false,
    }))).toEqual({
      class: 'excluded', type: null, reason: 'rejected', expiresAt: null,
    });
    expect(classifyOperationalProposalMembership(proposal({ status: 'failed' }))).toEqual({
      class: 'excluded', type: null, reason: 'failed', expiresAt: null,
    });
  });

  it('has no decision-ledger dependency', () => {
    const source = readFileSync(
      new URL('../src/core/inbox/operational-membership.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toContain('decisions-ledger');
    expect(source).not.toContain('readDecisions');
  });
});
