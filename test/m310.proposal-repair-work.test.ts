import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import {
  beginRejectedCaptureRecoveryDispatch,
  proposalRepairParentRevision,
  proposalRepairWorkItem,
  queueProposalRepairWorkForPendingProposals,
} from '../src/core/fleet/proposal-repair-work.js';
import {
  generatedRepairGenerationId,
  readGeneratedRepairLifecycle,
} from '../src/core/fleet/generated-repair-lifecycle.js';
import { createProposal, updateProposalField } from '../src/core/inbox/store.js';
import {
  acquireProposalMutationLock,
  releaseProposalMutationLock,
} from '../src/core/inbox/proposal-mutation-lock.js';
import type { Proposal, WorkItem } from '../src/core/types.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

function persistedRepairParent(): { parent: Proposal; item: WorkItem; now: Date } {
  const repo = fx.makeRepo();
  repo.enroll();
  const parent = createProposal({
    repo: repo.dir,
    origin: 'agent',
    kind: 'patch',
    title: 'Repair a partially verified scheduler change',
    summary: 'The captured change needs a complete verified replacement.',
    diff:
      'diff --git a/src/scheduler.ts b/src/scheduler.ts\n' +
      '--- a/src/scheduler.ts\n' +
      '+++ b/src/scheduler.ts\n' +
      '@@ -1 +1 @@\n' +
      '-export const ready = false;\n' +
      '+export const ready = true;\n',
    workItemId: 'repo:goal:scheduler-repair',
    isPartial: true,
    verifyResult: {
      passed: false,
      detail: 'merge verification failed in scheduler.test.ts',
      source: 'capture-gate',
    },
  });
  expect(parent.status).toBe('pending');
  const now = new Date(Date.parse(parent.createdAt) + 60_000);
  const item = proposalRepairWorkItem(parent, now);
  expect(item).not.toBeNull();
  return { parent, item: item!, now };
}

function generatedChild(parent: Proposal, item: WorkItem): Proposal {
  const attemptId = 'attempt-12345678-1234-4123-8123-123456789abc';
  const parentId = item.repairParentProposalId;
  const parentRevision = item.repairParentProposalRevision;
  return {
    id: 'prop-generated-parent-repair',
    repo: parent.repo,
    origin: 'agent',
    kind: 'patch',
    title: 'Complete verified scheduler repair',
    summary: 'Replaces the partial parent with a verified implementation.',
    diff:
      'diff --git a/src/scheduler.ts b/src/scheduler.ts\n' +
      '--- a/src/scheduler.ts\n' +
      '+++ b/src/scheduler.ts\n' +
      '@@ -1 +1 @@\n' +
      '-export const ready = false;\n' +
      '+export const ready = true;\n',
    workItemId: item.id,
    workItemGenerationId: generatedRepairGenerationId(item)!,
    workSource: 'self',
    runId: attemptId,
    trajectoryId: `run:${attemptId}`,
    runEventSummary: {
      runId: attemptId,
      status: 'done',
      outcome: 'proposal-created',
      proposalCreated: true,
    },
    delegationScope: {
      schemaVersion: 1,
      memoryMode: 'bounded',
      repairParentProposalId: parentId,
      repairParentProposalRevision: parentRevision,
    } as NonNullable<Proposal['delegationScope']>,
    status: 'pending',
    createdAt: new Date(Date.parse(parent.createdAt) + 30_000).toISOString(),
  };
}

describe('proposal repair parent revision authority', () => {
  it('admits an unchanged exact parent revision', () => {
    const { parent, item, now } = persistedRepairParent();
    let calls = 0;

    const result = beginRejectedCaptureRecoveryDispatch(item, () => {
      calls += 1;
      return 'started';
    }, now);

    expect(item.repairParentProposalId).toBe(parent.id);
    expect(item.repairParentProposalRevision).toBe(proposalRepairParentRevision(parent));
    expect(item.repairParentProposalRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toEqual({ authorized: true, value: 'started' });
    expect(calls).toBe(1);
  });

  it('rejects a queued witness after its parent mutates without invoking the producer', () => {
    const { parent, item, now } = persistedRepairParent();
    expect(updateProposalField(parent.id, {
      verifyResult: {
        passed: false,
        detail: 'verification now fails in a different required suite',
        source: 'capture-gate',
      },
    })).toBe(true);
    let calls = 0;

    const result = beginRejectedCaptureRecoveryDispatch(item, () => {
      calls += 1;
      return 'must-not-start';
    }, now);

    expect(result).toEqual({ authorized: false });
    expect(calls).toBe(0);
  });

  it('invalidates the witness when the parent objective title changes', () => {
    const { parent, item, now } = persistedRepairParent();
    expect(updateProposalField(parent.id, {
      title: 'Repair a different scheduler objective',
    })).toBe(true);
    let calls = 0;

    const result = beginRejectedCaptureRecoveryDispatch(item, () => {
      calls += 1;
      return 'must-not-start';
    }, now);

    expect(result).toEqual({ authorized: false });
    expect(calls).toBe(0);
  });

  it('rejects a queued witness after its parent is deleted without invoking the producer', () => {
    const { parent, item, now } = persistedRepairParent();
    rmSync(join(fx.ashlrDir, 'inbox', `${parent.id}.json`));
    let calls = 0;

    const result = beginRejectedCaptureRecoveryDispatch(item, () => {
      calls += 1;
      return 'must-not-start';
    }, now);

    expect(result).toEqual({ authorized: false });
    expect(calls).toBe(0);
  });

  it('holds the parent mutation lock until an admitted producer promise settles', async () => {
    const { parent, item, now } = persistedRepairParent();
    let settle!: (value: string) => void;
    const pending = new Promise<string>((resolve) => { settle = resolve; });

    const result = beginRejectedCaptureRecoveryDispatch(item, () => pending, now);
    expect(result.authorized).toBe(true);
    expect(updateProposalField(parent.id, { stuckPassCount: 1 })).toBe(false);

    settle('done');
    if (!result.authorized) throw new Error('expected dispatch authority');
    await expect(result.value).resolves.toBe('done');
    expect(updateProposalField(parent.id, { stuckPassCount: 1 })).toBe(true);
  });

  it('does not recursively generate a repair from a failed repair child', () => {
    const { parent, item, now } = persistedRepairParent();
    const failedChild = {
      ...generatedChild(parent, item),
      isPartial: true,
      verifyResult: {
        passed: false,
        detail: 'the generated repair failed verification',
        source: 'capture-gate' as const,
      },
    };

    expect(proposalRepairWorkItem(failedChild, now)).toBeNull();
  });

  it('retires an unchanged generated child under current parent authority', () => {
    const { parent, item, now } = persistedRepairParent();
    const candidate = generatedChild(parent, item);
    const {
      id: _id,
      status: _status,
      createdAt: _createdAt,
      ...persistable
    } = candidate;
    const child = createProposal(persistable);

    const competingChildLock = acquireProposalMutationLock(child.id, 0);
    expect(competingChildLock).not.toBeNull();
    const blocked = queueProposalRepairWorkForPendingProposals([parent], now, {
      lifecycleProposals: [child],
    });
    expect(blocked.dispatchRepairRetired).toBe(0);
    releaseProposalMutationLock(competingChildLock);

    const result = queueProposalRepairWorkForPendingProposals([parent], now, {
      lifecycleProposals: [child],
    });

    expect(result.dispatchRepairRetired).toBe(1);
    expect(readGeneratedRepairLifecycle(item)).toMatchObject({
      available: true,
      disposition: 'retired',
    });
  });

  it.each(['mutation', 'deletion'] as const)(
    'does not retire a generated child after parent %s',
    (change) => {
      const { parent, item, now } = persistedRepairParent();
      const child = generatedChild(parent, item);
      if (change === 'mutation') {
        expect(updateProposalField(parent.id, {
          verifyResult: {
            passed: false,
            detail: 'parent authority changed before child reconciliation',
            source: 'capture-gate',
          },
        })).toBe(true);
      } else {
        rmSync(join(fx.ashlrDir, 'inbox', `${parent.id}.json`));
        expect(parent.id).toBe(item.repairParentProposalId);
      }

      const result = queueProposalRepairWorkForPendingProposals([parent], now, {
        lifecycleProposals: [child],
      });

      expect(result.dispatchRepairRetired).toBe(0);
      expect(readGeneratedRepairLifecycle(item)).toMatchObject({
        available: true,
        disposition: 'active',
      });
    },
  );
});
