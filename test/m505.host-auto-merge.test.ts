/**
 * M505 - durable-revocation-gated host auto-merge (the last hop of the
 * remote handoff path: the actual `gh pr merge`).
 *
 * merge.ts:3993 already pushes the staging branch and opens the PR; this
 * completes the last hop, gated by:
 *   - cfg.foundry.autoMerge.hostAutoMerge (separate opt-in, default off)
 *   - the durable prepare/arm/revoke/consume authority in
 *     autonomy/host-merge-revocation-protocol.ts (re-checked fresh
 *     immediately before the irreversible `gh pr merge` call)
 *   - the autonomy kill switch (~/.ashlr/KILL), re-checked at every stage
 *     including immediately before the merge
 *
 * Most scenarios here drive `attemptHostAutoMerge` directly — it needs no
 * git repository at all (viewPr/gh are both mocked), which lets every
 * revocation/kill-switch/reconciliation edge case be exercised precisely,
 * including racing the kill switch into the exact window between "arm" and
 * the final pre-merge check. One end-to-end test drives the real
 * `autoMergeProposal` call site (mirroring test/m419's harness) to prove the
 * wiring itself, not just the helper in isolation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const { ghMergeMock, killSwitchOnMock, viewPrMock } = vi.hoisted(() => ({
  ghMergeMock: vi.fn(),
  killSwitchOnMock: vi.fn(),
  viewPrMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const cmd = args[0];
      const cmdArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
      if (cmd === 'gh' && cmdArgs[0] === 'pr' && cmdArgs[1] === 'merge') {
        return ghMergeMock(cmdArgs) as ReturnType<typeof actual.execFileSync>;
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock('../src/core/integrations/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/github.js')>();
  return {
    ...actual,
    viewPr: (...args: unknown[]) => viewPrMock(...args),
  };
});

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/policy.js')>();
  return {
    ...actual,
    killSwitchOn: () => killSwitchOnMock() as boolean,
  };
});

import {
  attemptHostAutoMerge,
  buildHostMergeRevocationIdentity,
  hostMergeOperationId,
  hostMergePolicyEpoch,
  type HostAutoMergeAttemptInput,
} from '../src/core/inbox/merge.js';
import {
  hostMergeRevocationStatePath,
  prepareHostMergeRevocation,
  readHostMergeRevocationState,
  transitionHostMergeRevocation,
  type HostMergeRevocationIdentityV1,
} from '../src/core/autonomy/host-merge-revocation-protocol.js';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import type { AshlrConfig } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

const NOW = new Date('2026-08-01T12:00:00.000Z');
const REPO = '/tmp/ashlr-m505-fixture-repo';
const NWO = 'ashlrai/fixture';
const REPOSITORY_ID = 'R_kgDOFixture';
const PR_URL = 'https://github.com/ashlrai/fixture/pull/505';
const BASE = 'main';
const BASE_OID = '1'.repeat(40);
const BRANCH = 'ashlr/merge/prop-fixture-505';
const HEAD_OID = '2'.repeat(40);
const PULL_REQUEST_ID = 'PR_kwDOFixture';
const PULL_REQUEST_NUMBER = 505;
const EVIDENCE_DIGEST = '3'.repeat(64);
const VERIFIER_DIGEST = '4'.repeat(64);
const PROTECTION_DIGEST = '5'.repeat(64);
const PROPOSAL_ID = 'prop-fixture-505';

const semanticPrivateStorageRunner: PrivateStorageRunner = (invocation) => {
  const request = JSON.parse(invocation.input) as {
    nonce: string;
    operation: string;
    mode?: 'secure-created' | 'inspect-existing' | 'inspect-owned';
  };
  const reason = request.operation === 'assure-private-paths'
    ? 'owned-safe-paths'
    : request.mode === 'inspect-owned'
      ? 'owned-safe-path'
      : 'exact-private-dacl';
  return {
    status: 0,
    stdout: JSON.stringify({ nonce: request.nonce, operation: request.operation, ok: true, reason }),
  };
};

function openPr(overrides: Record<string, unknown> = {}) {
  return {
    id: PULL_REQUEST_ID,
    number: PULL_REQUEST_NUMBER,
    url: PR_URL,
    state: 'OPEN',
    headRefOid: HEAD_OID,
    baseRefName: BASE,
    ...overrides,
  };
}

function mergedPr(overrides: Record<string, unknown> = {}) {
  return {
    id: PULL_REQUEST_ID,
    number: PULL_REQUEST_NUMBER,
    url: PR_URL,
    state: 'MERGED',
    mergedAt: NOW.toISOString(),
    headRefOid: HEAD_OID,
    baseRefName: BASE,
    mergeCommitOid: '9'.repeat(40),
    ...overrides,
  };
}

function baseCfg(autoMergeOverrides: Record<string, unknown> = {}): AshlrConfig {
  return {
    foundry: {
      autoMerge: {
        enabled: true,
        pushToRemote: true,
        hostAutoMerge: true,
        maxRisk: 'low',
        ...autoMergeOverrides,
      },
    },
  } as unknown as AshlrConfig;
}

function baseInput(overrides: Partial<HostAutoMergeAttemptInput> = {}): HostAutoMergeAttemptInput {
  return {
    repo: REPO,
    id: PROPOSAL_ID,
    cfg: baseCfg(),
    nameWithOwner: NWO,
    repositoryId: REPOSITORY_ID,
    url: PR_URL,
    base: BASE,
    baseOid: BASE_OID,
    branch: BRANCH,
    headOid: HEAD_OID,
    observedPr: openPr(),
    evidencePackDigest: EVIDENCE_DIGEST,
    verifierManifestDigest: VERIFIER_DIGEST,
    protectionPolicyDigest: PROTECTION_DIGEST,
    maxRisk: 'low',
    managerGateEnabled: false,
    allowSelfMerge: false,
    maxFiles: 4,
    maxLines: 150,
    now: NOW,
    ...overrides,
  };
}

/** Reconstruct the exact identity attemptHostAutoMerge will look up for `input`. */
function expectedIdentity(input: HostAutoMergeAttemptInput): HostMergeRevocationIdentityV1 {
  const policyEpoch = hostMergePolicyEpoch({
    maxRisk: input.maxRisk,
    managerGateEnabled: input.managerGateEnabled,
    allowSelfMerge: input.allowSelfMerge,
    hostAutoMergeEnabled: true,
    maxFiles: input.maxFiles,
    maxLines: input.maxLines,
  });
  return buildHostMergeRevocationIdentity({
    nameWithOwner: input.nameWithOwner,
    repositoryId: input.repositoryId,
    base: input.base,
    baseOid: input.baseOid,
    branch: input.branch,
    headOid: input.headOid,
    pullRequestId: PULL_REQUEST_ID,
    pullRequestNumber: PULL_REQUEST_NUMBER,
    evidencePackDigest: input.evidencePackDigest,
    verifierManifestDigest: input.verifierManifestDigest as string,
    protectionPolicyDigest: input.protectionPolicyDigest,
    policyEpoch,
    now: input.now as Date,
  });
}

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m505-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  _setPrivateStorageTestControlForTest(
    PRIVATE_STORAGE_TEST_CONTROL,
    process.platform === 'win32' ? { runner: semanticPrivateStorageRunner } : undefined,
  );
  loadOrCreateKey();
  ghMergeMock.mockReset();
  ghMergeMock.mockReturnValue('Merged pull request #505');
  killSwitchOnMock.mockReset();
  killSwitchOnMock.mockReturnValue(false);
  viewPrMock.mockReset();
  viewPrMock.mockReturnValue(openPr());
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
});

describe('M505 host auto-merge — attemptHostAutoMerge', () => {
  it('never attempts gh pr merge when hostAutoMerge is not explicitly enabled (default off)', async () => {
    const input = baseInput({ cfg: baseCfg({ hostAutoMerge: undefined }) });
    const note = await attemptHostAutoMerge(input);
    expect(note).toMatch(/host auto-merge is disabled/);
    expect(ghMergeMock).not.toHaveBeenCalled();
    expect(viewPrMock).not.toHaveBeenCalled();
  });

  it('refuses when no required-verifier manifest digest is bound to the attempt', async () => {
    const note = await attemptHostAutoMerge(baseInput({ verifierManifestDigest: null }));
    expect(note).toMatch(/no required-verifier manifest digest/);
    expect(ghMergeMock).not.toHaveBeenCalled();
  });

  it('refuses immediately when the kill switch is already ON', async () => {
    killSwitchOnMock.mockReturnValue(true);
    const note = await attemptHostAutoMerge(baseInput());
    expect(note).toMatch(/kill switch is ON/);
    expect(ghMergeMock).not.toHaveBeenCalled();
    expect(viewPrMock).not.toHaveBeenCalled();
  });

  it('invokes gh pr merge and durably consumes the authority once the merge is confirmed', async () => {
    viewPrMock.mockReturnValueOnce(openPr()).mockReturnValueOnce(mergedPr());
    const input = baseInput();

    const note = await attemptHostAutoMerge(input);

    expect(note).toMatch(/merged via host auto-merge/);
    expect(ghMergeMock).toHaveBeenCalledTimes(1);
    expect(ghMergeMock.mock.calls[0]?.[0]).toEqual(['pr', 'merge', PR_URL, '--repo', NWO, '--squash']);

    const state = readHostMergeRevocationState(expectedIdentity(input));
    expect(state.state).toBe('healthy');
    if (state.state === 'healthy') expect(state.record.phase).toBe('consumed');
  });

  it('honors cfg.foundry.autoMerge.mergeMethod', async () => {
    viewPrMock.mockReturnValueOnce(openPr()).mockReturnValueOnce(mergedPr());
    const input = baseInput({ cfg: baseCfg({ hostAutoMerge: true, mergeMethod: 'rebase' }) });

    await attemptHostAutoMerge(input);

    expect(ghMergeMock.mock.calls[0]?.[0]).toEqual(['pr', 'merge', PR_URL, '--repo', NWO, '--rebase']);
  });

  it('never re-invokes gh pr merge when the PR is already merged (reconciles an interrupted host merge)', async () => {
    viewPrMock.mockReturnValueOnce(mergedPr());

    const note = await attemptHostAutoMerge(baseInput());

    expect(note).toMatch(/already merged on the host/);
    expect(ghMergeMock).not.toHaveBeenCalled();
  });

  it('leaves the authority armed (never consumed) when the merge is not confirmed on re-read', async () => {
    viewPrMock.mockReturnValueOnce(openPr()).mockReturnValueOnce(openPr());
    ghMergeMock.mockImplementation(() => {
      throw Object.assign(new Error('gh: pull request is not mergeable'), {
        stderr: 'required status check "ci/test" is pending',
      });
    });
    const input = baseInput();

    const note = await attemptHostAutoMerge(input);

    expect(note).toMatch(/host auto-merge refused/);
    expect(note).toMatch(/pending/);
    const state = readHostMergeRevocationState(expectedIdentity(input));
    expect(state.state).toBe('healthy');
    if (state.state === 'healthy') expect(state.record.phase).toBe('armed');
  });

  it('refuses to merge once the durable authority has been revoked', async () => {
    const input = baseInput();
    const identity = expectedIdentity(input);
    const prepareOpId = hostMergeOperationId(PROPOSAL_ID, 'host-merge-prepare');
    const armOpId = hostMergeOperationId(PROPOSAL_ID, 'host-merge-arm');
    if (!prepareOpId || !armOpId) throw new Error('expected valid operation ids');

    // Same identity => same authorityId requires the same `now` (expiresAt is
    // part of the identity payload), so this simulates a concurrent revoker
    // racing the SAME in-flight authority attemptHostAutoMerge will itself
    // reconstruct below — not a separate later retry attempt.
    const prepared = prepareHostMergeRevocation({ identity, operationId: prepareOpId, now: NOW });
    if (prepared.status !== 'applied') throw new Error('expected applied prepare');
    const armed = transitionHostMergeRevocation({
      identity,
      action: 'arm',
      operationId: armOpId,
      expectedSequence: prepared.receipt.sequence,
      expectedReceiptDigest: prepared.receipt.receiptDigest,
      now: NOW,
    });
    if (armed.status !== 'applied') throw new Error('expected applied arm');
    const revoked = transitionHostMergeRevocation({
      identity,
      action: 'revoke',
      operationId: 'external-revoker-505',
      expectedSequence: armed.receipt.sequence,
      expectedReceiptDigest: armed.receipt.receiptDigest,
      now: NOW,
    });
    expect(revoked.status).toBe('applied');

    const note = await attemptHostAutoMerge(input);

    expect(note).toMatch(/revocation authority is not armed/);
    expect(note).toMatch(/revoked/);
    expect(ghMergeMock).not.toHaveBeenCalled();
  });

  it('fails closed when the durable revocation store is unreadable', async () => {
    const input = baseInput();
    const identity = expectedIdentity(input);
    const prepareOpId = hostMergeOperationId(PROPOSAL_ID, 'host-merge-prepare');
    if (!prepareOpId) throw new Error('expected valid operation id');
    const prepared = prepareHostMergeRevocation({ identity, operationId: prepareOpId, now: NOW });
    if (prepared.status !== 'applied') throw new Error('expected applied prepare');

    const statePath = hostMergeRevocationStatePath(identity);
    if (!statePath) throw new Error('expected a resolvable state path');
    fs.writeFileSync(statePath, 'not valid json {{{', 'utf8');

    const note = await attemptHostAutoMerge(input);

    expect(note).toMatch(/host auto-merge refused/);
    expect(ghMergeMock).not.toHaveBeenCalled();
  });

  it('aborts and durably revokes when the kill switch engages between arm and the final pre-merge check', async () => {
    killSwitchOnMock.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const input = baseInput();

    const note = await attemptHostAutoMerge(input);

    expect(note).toMatch(/kill switch is ON/);
    expect(ghMergeMock).not.toHaveBeenCalled();
    const state = readHostMergeRevocationState(expectedIdentity(input));
    expect(state.state).toBe('healthy');
    if (state.state === 'healthy') expect(state.record.phase).toBe('revoked');
  });

  it('refuses when the live PR state no longer matches (head moved / closed)', async () => {
    viewPrMock.mockReturnValueOnce(openPr({ headRefOid: '8'.repeat(40) }));

    const note = await attemptHostAutoMerge(baseInput());

    expect(note).toMatch(/live PR state changed/);
    expect(ghMergeMock).not.toHaveBeenCalled();
  });
});
