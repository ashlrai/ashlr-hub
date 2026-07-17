import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, WorkItem } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  loadProposal: vi.fn(),
  setStatus: vi.fn(),
  acquireAuthority: vi.fn(),
  releaseAuthority: vi.fn(),
  parentCurrent: vi.fn(),
  acquireChildLock: vi.fn(),
  releaseChildLock: vi.fn(),
}));

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    loadProposal: (...args: unknown[]) => mocks.loadProposal(...args),
    setStatus: (...args: unknown[]) => mocks.setStatus(...args),
  };
});

vi.mock('../src/core/fleet/proposal-repair-parent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/proposal-repair-parent.js')>();
  return {
    ...actual,
    acquireProposalRepairParentAuthority: (...args: unknown[]) => mocks.acquireAuthority(...args),
    releaseProposalRepairParentAuthority: (...args: unknown[]) => mocks.releaseAuthority(...args),
    proposalRepairChildParentCurrent: (...args: unknown[]) => mocks.parentCurrent(...args),
  };
});

vi.mock('../src/core/inbox/proposal-mutation-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/proposal-mutation-lock.js')>();
  return {
    ...actual,
    acquireProposalMutationLock: (...args: unknown[]) => mocks.acquireChildLock(...args),
    releaseProposalMutationLock: (...args: unknown[]) => mocks.releaseChildLock(...args),
  };
});

import { withGeneratedRepairChildLifecycleAuthority } from '../src/core/daemon/loop.js';

function repairItem(): WorkItem {
  return {
    id: 'repo:proposal-repair:abcdef123456',
    repo: '/tmp/repo',
    source: 'self',
    title: 'Proposal repair: restore verification',
    detail:
      'Proposal repair: restore verification.\n' +
      'Proposal: prop-parent\n' +
      'Original work item: repo:goal:verification\n' +
      'Produce a fresh complete fix and verify it.',
    value: 5,
    effort: 1,
    score: 5,
    tags: ['self-heal', 'proposal-repair', 'verify'],
    ts: '2026-07-16T00:00:00.000Z',
  };
}

function pendingChild(): Proposal {
  return {
    id: 'prop-child',
    repo: '/tmp/repo',
    origin: 'agent',
    kind: 'patch',
    title: 'Repair child',
    summary: 'Repair child proposal.',
    status: 'pending',
    createdAt: '2026-07-16T00:01:00.000Z',
    workItemId: 'repo:proposal-repair:abcdef123456',
    workSource: 'self',
  } as Proposal;
}

describe('daemon generated repair child parent authority', () => {
  beforeEach(() => {
    mocks.loadProposal.mockReset();
    mocks.setStatus.mockReset();
    mocks.acquireAuthority.mockReset();
    mocks.releaseAuthority.mockReset();
    mocks.parentCurrent.mockReset();
    mocks.parentCurrent.mockReturnValue(true);
    mocks.acquireChildLock.mockReset();
    mocks.acquireChildLock.mockReturnValue({ key: 'child-lock', token: Symbol('child-lock') });
    mocks.releaseChildLock.mockReset();
  });

  it('runs lifecycle conversion while the current parent authority lease is held', () => {
    const child = pendingChild();
    const authority = {
      applies: true,
      authorized: true,
      parentId: 'prop-parent',
      lock: { proposalId: 'prop-parent' },
    };
    mocks.loadProposal.mockReturnValue(child);
    mocks.acquireAuthority.mockReturnValue(authority);

    const converted = withGeneratedRepairChildLifecycleAuthority(
      repairItem(),
      child.id,
      (admitted) => {
        expect(admitted).toBe(child);
        expect(mocks.releaseAuthority).not.toHaveBeenCalled();
        expect(mocks.releaseChildLock).not.toHaveBeenCalled();
        return 'converted';
      },
    );

    expect(converted).toBe('converted');
    expect(mocks.acquireAuthority).toHaveBeenCalledWith(child, expect.any(Function));
    expect(mocks.releaseAuthority).toHaveBeenCalledWith(authority);
    expect(mocks.releaseChildLock).toHaveBeenCalledOnce();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('fails closed and conditionally rejects a pending child when parent authority is stale', () => {
    const child = pendingChild();
    mocks.loadProposal.mockReturnValue(child);
    mocks.acquireAuthority.mockReturnValue({
      applies: true,
      authorized: false,
      reason: 'parent-changed',
    });
    const convert = vi.fn();

    expect(withGeneratedRepairChildLifecycleAuthority(repairItem(), child.id, convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
    expect(mocks.releaseAuthority).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenCalledWith(
      child.id,
      'rejected',
      'generated repair parent authority unavailable',
      'stale-repair-parent-authority',
      undefined,
      {},
      'pending',
    );
  });

  it('releases parent authority when lifecycle recording throws', () => {
    const child = pendingChild();
    const authority = {
      applies: true,
      authorized: true,
      parentId: 'prop-parent',
      lock: { proposalId: 'prop-parent' },
    };
    mocks.loadProposal.mockReturnValue(child);
    mocks.acquireAuthority.mockReturnValue(authority);

    expect(() => withGeneratedRepairChildLifecycleAuthority(
      repairItem(),
      child.id,
      () => { throw new Error('lifecycle store unavailable'); },
    )).toThrow('lifecycle store unavailable');
    expect(mocks.releaseAuthority).toHaveBeenCalledWith(authority);
    expect(mocks.releaseChildLock).toHaveBeenCalledOnce();
  });

  it('does not convert when the child lock is unavailable', () => {
    const child = pendingChild();
    const authority = {
      applies: true,
      authorized: true,
      parentId: 'prop-parent',
      lock: { proposalId: 'prop-parent' },
    };
    mocks.loadProposal.mockReturnValue(child);
    mocks.acquireAuthority.mockReturnValue(authority);
    mocks.acquireChildLock.mockReturnValue(null);
    const convert = vi.fn();

    expect(withGeneratedRepairChildLifecycleAuthority(repairItem(), child.id, convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
    expect(mocks.releaseAuthority).toHaveBeenCalledWith(authority);
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });

  it('rejects a child whose parent witness changes before the child lock reload', () => {
    const child = {
      ...pendingChild(),
      delegationScope: {
        schemaVersion: 1 as const,
        memoryMode: 'none' as const,
        repairParentProposalId: 'prop-parent',
        repairParentProposalRevision: 'a'.repeat(64),
      },
    };
    const changed = {
      ...child,
      delegationScope: {
        ...child.delegationScope,
        repairParentProposalRevision: 'b'.repeat(64),
      },
    };
    mocks.loadProposal.mockReturnValueOnce(child).mockReturnValueOnce(changed);
    mocks.acquireAuthority.mockReturnValue({
      applies: true,
      authorized: true,
      parentId: 'prop-parent',
      lock: { proposalId: 'prop-parent' },
    });
    const convert = vi.fn();

    expect(withGeneratedRepairChildLifecycleAuthority(repairItem(), child.id, convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenCalledWith(
      child.id,
      'rejected',
      'generated repair parent authority unavailable',
      'stale-repair-parent-authority',
      undefined,
      {},
      'pending',
    );
  });

  it('does not mutate status when the child cannot be reloaded', () => {
    mocks.loadProposal.mockReturnValue(null);
    const convert = vi.fn();

    expect(withGeneratedRepairChildLifecycleAuthority(repairItem(), 'prop-missing', convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
    expect(mocks.acquireAuthority).not.toHaveBeenCalled();
    expect(mocks.acquireChildLock).not.toHaveBeenCalled();
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
});
