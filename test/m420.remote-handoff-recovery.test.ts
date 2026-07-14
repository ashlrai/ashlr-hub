/** M420 - bounded recovery for URL-less remote handoff intents. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../src/core/types.js';

const {
  autoMergeProposalMock,
  execFileSyncMock,
  loadProposalMock,
  originAuthorityMock,
  outwardOwnsMock,
  recordRealizedMergeMock,
  setStatusMock,
  updateProposalFieldMock,
  viewPrWithReconciliationMock,
} = vi.hoisted(() => ({
  autoMergeProposalMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  loadProposalMock: vi.fn(),
  originAuthorityMock: vi.fn(),
  outwardOwnsMock: vi.fn(),
  recordRealizedMergeMock: vi.fn(),
  setStatusMock: vi.fn(),
  updateProposalFieldMock: vi.fn(),
  viewPrWithReconciliationMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => execFileSyncMock(...args) }));

vi.mock('../src/core/git.js', () => ({
  resolveGitHubOriginAuthorityDetails: () => originAuthorityMock(),
}));

vi.mock('../src/core/foundry/provenance.js', () => ({
  hashDiff: () => 'c'.repeat(64),
  signJudgeAttestation: vi.fn(),
  signLocalMergeIntent: () => '9'.repeat(64),
  verifyJudgeAttestation: vi.fn(),
  verifyLocalMergeIntent: () => true,
}));

vi.mock('../src/core/inbox/merge.js', () => ({
  autoMergeProposal: (...args: unknown[]) => autoMergeProposalMock(...args),
  evaluateAutoMergeReadinessPreflight: () => ({ ready: true, advisories: [] }),
  isFrontierJudge: () => true,
  verifyProposal: vi.fn(),
  verifyResultFromProposalResult: vi.fn(),
}));

vi.mock('../src/core/inbox/proposal-mutation-lock.js', () => ({
  acquireProposalMutationLock: () => ({ token: 'm420' }),
  releaseProposalMutationLock: vi.fn(),
}));

vi.mock('../src/core/sandbox/mutation-fence.js', () => ({
  acquireOutwardMutationFence: () => ({ token: 'm420-outward' }),
  ownsOutwardMutationFence: () => outwardOwnsMock(),
  releaseOutwardMutationFence: vi.fn(),
}));

vi.mock('../src/core/sandbox/policy.js', () => ({
  isEnrolled: () => true,
  killSwitchOn: () => false,
}));

vi.mock('../src/core/inbox/remote-handoff-attestation.js', () => ({
  verifyRemoteHandoffReconciliation: vi.fn(),
  viewPrWithReconciliation: (...args: unknown[]) => viewPrWithReconciliationMock(...args),
}));

let proposal: Proposal;

vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: () => ({
    proposals: [proposal],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    filesDiscovered: 1,
    filesRead: 1,
    bytesRead: 1,
    invalidFiles: 0,
    unreadableFiles: 0,
  }),
  loadProposal: (...args: unknown[]) => loadProposalMock(...args),
  recordRealizedMerge: (...args: unknown[]) => recordRealizedMergeMock(...args),
  setStatus: (...args: unknown[]) => setStatusMock(...args),
  updateProposalField: (...args: unknown[]) => updateProposalFieldMock(...args),
}));

import {
  reconcileRemoteHandoffs,
  remoteAuthorityBinding,
  remoteIntentAuthorizationId,
} from '../src/core/inbox/remote-handoff.js';
import { runAutoMergePass } from '../src/core/fleet/automerge-pass.js';

const HEAD = 'a'.repeat(40);
const BRANCH = 'ashlr/merge/prop-m420';
const RECOVERY_MARKER = '[ashlr-remote-handoff-retry:1]';
const ORIGIN_A = {
  nameWithOwner: 'ashlrai/fixture',
  fetchUrls: ['https://github.com/ashlrai/fixture.git'],
  pushUrls: ['https://github.com/ashlrai/fixture.git'],
  pushUrl: 'https://github.com/ashlrai/fixture.git',
};
const ORIGIN_B = {
  nameWithOwner: 'other/repository',
  fetchUrls: ['https://github.com/other/repository.git'],
  pushUrls: ['https://github.com/other/repository.git'],
  pushUrl: 'https://github.com/other/repository.git',
};

function makeProposal(): Proposal {
  const authority = remoteAuthorityBinding(ORIGIN_A)!;
  const intentWithoutAuthorization = {
    schemaVersion: 1 as const,
    branch: BRANCH,
    base: 'main',
    baseBeforeOid: 'b'.repeat(40),
    proposalHeadOid: HEAD,
    diffHash: 'c'.repeat(64),
    evidencePackDigest: 'd'.repeat(64),
    authorizedAt: '2026-07-14T00:00:30.000Z',
    remoteAuthority: authority,
  };
  const intentAttestation = 'f'.repeat(64);
  return {
    id: 'prop-m420',
    origin: 'agent',
    kind: 'patch',
    title: 'recover URL-less handoff',
    summary: 'bounded retry',
    status: 'awaiting-host-merge',
    createdAt: '2026-07-14T00:00:00.000Z',
    repo: process.cwd(),
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    localMergeIntent: {
      ...intentWithoutAuthorization,
      authorizationId: remoteIntentAuthorizationId('pre-effect', intentWithoutAuthorization),
      attestation: intentAttestation,
    },
    remoteHandoff: {
      provider: 'github',
      state: 'awaiting-host-merge',
      branch: BRANCH,
      base: 'main',
      expectedHeadOid: HEAD,
      authority,
      intentAttestation,
      createdAt: '2026-07-14T00:01:00.000Z',
      detail: `signed remote handoff intent persisted for ${BRANCH}@${HEAD}`,
    },
  } as Proposal;
}

beforeEach(() => {
  autoMergeProposalMock.mockReset();
  autoMergeProposalMock.mockResolvedValue({ ok: true, merged: false, handoff: true, reason: 'retried' });
  originAuthorityMock.mockReset();
  originAuthorityMock.mockReturnValue(ORIGIN_A);
  outwardOwnsMock.mockReset();
  outwardOwnsMock.mockReturnValue(true);
  proposal = makeProposal();
  viewPrWithReconciliationMock.mockReset();
  viewPrWithReconciliationMock.mockReturnValue(null);
  execFileSyncMock.mockReset();
  loadProposalMock.mockReset();
  loadProposalMock.mockImplementation(() => proposal);
  recordRealizedMergeMock.mockReset();
  updateProposalFieldMock.mockReset();
  updateProposalFieldMock.mockImplementation((_id: string, patch: Partial<Proposal>) => {
    proposal = { ...proposal, ...patch };
    return true;
  });
  setStatusMock.mockReset();
  setStatusMock.mockImplementation((
    _id: string,
    status: Proposal['status'],
    result?: string,
    reason?: string,
    _lock?: unknown,
    patch?: Partial<Proposal>,
  ) => {
    proposal = { ...proposal, ...patch, status, result, decisionReason: reason };
    return true;
  });
});

describe('M420 URL-less remote handoff recovery', () => {
  it('returns an exact remote branch with no PR for one retry, then terminates on repeated proof', () => {
    execFileSyncMock.mockImplementation((file: string) => (
      file === 'gh' ? '[]' : `${HEAD}\trefs/heads/${BRANCH}\n`
    ));

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, recovered: 1, merged: 0 });
    expect(proposal).toMatchObject({
      id: 'prop-m420',
      status: 'approved',
      remoteHandoff: { state: 'unknown', detail: expect.stringContaining(RECOVERY_MARKER) },
    });
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();

    const recoveredIntent = proposal.localMergeIntent!;
    const {
      attestation: _recoveryAttestation,
      authorizationId: _recoveryAuthorizationId,
      ...retryIntentFields
    } = recoveredIntent;
    const retryAttestation = '8'.repeat(64);
    proposal = {
      ...proposal,
      status: 'awaiting-host-merge',
      localMergeIntent: {
        ...retryIntentFields,
        authorizationId: remoteIntentAuthorizationId('recovery', retryIntentFields),
        attestation: retryAttestation,
      },
      remoteHandoff: {
        ...proposal.remoteHandoff!,
        state: 'awaiting-host-merge',
        intentAttestation: retryAttestation,
      },
    };
    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, closed: 1, merged: 0 });
    expect(proposal).toMatchObject({ status: 'rejected', remoteHandoff: { state: 'closed' } });
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('returns a definitely absent remote branch and PR to the same proposal for gated retry', () => {
    execFileSyncMock.mockImplementation((file: string) => file === 'gh' ? '[]' : '');

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, recovered: 1, merged: 0 });
    expect(proposal).toMatchObject({
      id: 'prop-m420',
      status: 'approved',
      remoteHandoff: {
        state: 'unknown',
        detail: expect.stringContaining('staging branch is absent'),
      },
    });
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('completes recovery after a crash between the signed intent and status writes', () => {
    execFileSyncMock.mockImplementation((file: string) => (
      file === 'gh' ? '[]' : `${HEAD}\trefs/heads/${BRANCH}\n`
    ));
    setStatusMock.mockImplementationOnce(() => false);

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, unknown: 1 });
    expect(proposal.status).toBe('awaiting-host-merge');
    expect(proposal.remoteHandoff?.recovery).toBeUndefined();
    const interruptedIntent = proposal.localMergeIntent!;
    const { attestation: _attestation, authorizationId: _authorizationId, ...unsigned } = interruptedIntent;
    expect(interruptedIntent.authorizationId).toBe(remoteIntentAuthorizationId('recovery', unsigned));

    execFileSyncMock.mockImplementation(() => { throw new Error('host must not be reread'); });
    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, recovered: 1, unknown: 0 });
    expect(proposal).toMatchObject({
      status: 'approved',
      remoteHandoff: { state: 'unknown', recovery: { attempt: 1, marker: RECOVERY_MARKER } },
    });
  });

  it('resumes a crash after a signed pre-effect intent but before handoff status', async () => {
    proposal = { ...makeProposal(), status: 'approved', remoteHandoff: undefined };

    const result = await runAutoMergePass({
      foundry: { autoMerge: { enabled: true } },
    } as never);

    expect(result).toMatchObject({ attempted: 1, handoffs: 1 });
    expect(autoMergeProposalMock).toHaveBeenCalledWith(proposal.id, expect.any(Object));
  });

  it('keeps host/API unknown awaiting and never treats it as PR absence', () => {
    execFileSyncMock.mockImplementation((file: string) => {
      if (file === 'gh') throw new Error('GitHub unavailable');
      throw new Error('remote must not be consulted after an unknown host read');
    });

    expect(reconcileRemoteHandoffs()).toEqual({
      checked: 1,
      merged: 0,
      closed: 0,
      open: 0,
      unknown: 1,
    });
    expect(proposal).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge' },
    });
    expect(proposal.remoteHandoff?.prUrl).toBeUndefined();
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('fails closed when origin changes between host and branch evidence', () => {
    execFileSyncMock.mockImplementation((file: string) => {
      if (file === 'gh') {
        originAuthorityMock.mockReturnValue(ORIGIN_B);
        return '[]';
      }
      throw new Error('branch evidence must not cross the origin change');
    });

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, unknown: 1 });
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('uses the captured push authority and rejects an origin change after branch evidence', () => {
    execFileSyncMock.mockImplementation((file: string, args: string[]) => {
      if (file === 'gh') return '[]';
      expect(args).toContain(ORIGIN_A.pushUrl);
      originAuthorityMock.mockReturnValue(ORIGIN_B);
      return `${HEAD}\trefs/heads/${BRANCH}\n`;
    });

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, unknown: 1 });
    expect(setStatusMock).not.toHaveBeenCalled();
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('does not read or credit a URL-bearing handoff for another GitHub repository', () => {
    proposal = {
      ...proposal,
      remoteHandoff: {
        ...proposal.remoteHandoff!,
        prUrl: 'https://github.com/other/repository/pull/420',
      },
    };

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, unknown: 1, merged: 0 });
    expect(viewPrWithReconciliationMock).not.toHaveBeenCalled();
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('rechecks outward authority after the host read before merge credit', () => {
    const prUrl = 'https://github.com/ashlrai/fixture/pull/420';
    proposal = { ...proposal, remoteHandoff: { ...proposal.remoteHandoff!, prUrl } };
    viewPrWithReconciliationMock.mockImplementationOnce(() => {
      outwardOwnsMock.mockReturnValue(false);
      return {
        pr: {
          url: prUrl,
          state: 'MERGED',
          mergedAt: '2026-07-14T00:02:00.000Z',
          mergeCommitOid: 'e'.repeat(40),
          headRefName: BRANCH,
          headRefOid: HEAD,
          baseRefName: 'main',
        },
        reconciliation: {
          schemaVersion: 1,
          observedAt: '2026-07-14T00:03:00.000Z',
          attestation: '7'.repeat(64),
        },
      };
    });

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, unknown: 1, merged: 0 });
    expect(recordRealizedMergeMock).not.toHaveBeenCalled();
  });

  it('lets the daemon retry only the recovered approved proposal', async () => {
    execFileSyncMock.mockImplementation((file: string) => (
      file === 'gh' ? '[]' : `${HEAD}\trefs/heads/${BRANCH}\n`
    ));
    expect(reconcileRemoteHandoffs()).toMatchObject({ recovered: 1 });

    const result = await runAutoMergePass({
      foundry: { autoMerge: { enabled: true } },
    } as never);
    expect(result).toMatchObject({ attempted: 1, handoffs: 1 });
    expect(autoMergeProposalMock).toHaveBeenCalledWith(proposal.id, expect.any(Object));

    autoMergeProposalMock.mockClear();
    proposal = {
      ...makeProposal(),
      status: 'approved',
      remoteHandoff: undefined,
      localMergeIntent: undefined,
    };
    const ordinaryApproved = await runAutoMergePass({
      foundry: { autoMerge: { enabled: true } },
    } as never);
    expect(ordinaryApproved.attempted).toBe(0);
    expect(autoMergeProposalMock).not.toHaveBeenCalled();
  });
});
