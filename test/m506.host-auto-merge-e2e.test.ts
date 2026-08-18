/**
 * M506 - end-to-end proof that autoMergeProposal's remote-handoff call site
 * actually reaches attemptHostAutoMerge (not just the helper in isolation).
 * Harness mirrors test/m419.remote-handoff-intent.test.ts; test/m505 covers
 * every attemptHostAutoMerge edge case (revocation, kill switch,
 * reconciliation) in isolation without needing a real git repo.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const {
  branchProtectionMock,
  createPrMock,
  ghMergeMock,
  originAuthorityMock,
  viewPrMock,
} = vi.hoisted(() => ({
  branchProtectionMock: vi.fn(),
  createPrMock: vi.fn(),
  ghMergeMock: vi.fn(),
  originAuthorityMock: vi.fn(),
  viewPrMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const commandArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
      if (args[0] === 'gh' && commandArgs[0] === 'pr' && commandArgs[1] === 'merge') {
        return ghMergeMock(commandArgs) as ReturnType<typeof actual.execFileSync>;
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock('../src/core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/git.js')>();
  return {
    ...actual,
    resolveGitHubOriginAuthority: () => originAuthorityMock()?.nameWithOwner ?? null,
    resolveGitHubOriginAuthorityDetails: () => originAuthorityMock(),
  };
});

vi.mock('../src/core/integrations/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/github.js')>();
  return {
    ...actual,
    createPr: (...args: unknown[]) => createPrMock(...args),
    viewPr: (...args: unknown[]) => viewPrMock(...args),
    readBranchProtectionAttestation: (...args: unknown[]) => branchProtectionMock(...args),
  };
});

import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { enroll, setKill, unenroll } from '../src/core/sandbox/policy.js';
import {
  PRIVATE_STORAGE_TEST_CONTROL,
  _setPrivateStorageTestControlForTest,
  type PrivateStorageRunner,
} from '../src/core/util/private-storage.js';
import type { AshlrConfig, EngineTier, Proposal } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
const originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
const TEST_POLICY_SNAPSHOT = {
  schemaVersion: 2,
  classic: {
    ruleId: 'BPR_m506',
    pattern: 'main',
    bypassForcePushAllowanceCount: 0,
    bypassForcePushAllowances: { users: [], teams: [], apps: [] },
    requiredDeployments: null,
    requiredStatusChecks: { strict: true, enforcementLevel: 'non_admins', checks: [{ context: 'ci/test', appId: '1' }] },
    enforceAdmins: true,
    requiredPullRequestReviews: null,
    pushRestrictions: null,
    requiredSignatures: false,
    requiredLinearHistory: false,
    allowForcePushes: false,
    allowDeletions: false,
    blockCreations: false,
    requiredConversationResolution: false,
    lockBranch: false,
    allowForkSyncing: false,
  },
  rulesets: [],
} as const;

let tmpHome: string;
let tmpRepo: string;
let bareRepo: string;

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

function useNativePrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
}

function useSemanticPrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, { runner: semanticPrivateStorageRunner });
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main', dir], { stdio: 'pipe' });
  git(dir, ['config', 'user.email', 'test@ashlr.test']);
  git(dir, ['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'ashlr.verify.json'), JSON.stringify({
    schemaVersion: 1,
    mode: 'replace-detected',
    commands: [{
      id: 'merge-test',
      kind: 'test',
      cmd: ['node', '-e', 'process.exit(0)'],
      required: true,
      profiles: ['merge'],
    }],
  }), 'utf8');
  git(dir, ['add', 'README.md', 'ashlr.verify.json']);
  git(dir, ['commit', '-m', 'init']);
}

function diffFor(filename: string): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${filename}`,
    '@@ -0,0 +1 @@',
    '+host auto-merge e2e wiring',
    '',
  ].join('\n');
}

function config(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: true,
        pushToRemote: true,
        hostAutoMerge: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '1' }],
        },
      },
    },
  } as unknown as AshlrConfig;
}

function protectionAttestation(branch = 'main') {
  return {
    ok: true,
    available: true,
    protected: true,
    branchProtection: true,
    nameWithOwner: 'ashlrai/fixture',
    repositoryId: 'R_m506fixture',
    defaultBranch: 'main',
    branch,
    baseHead: git(tmpRepo, ['rev-parse', branch]),
    observedAt: new Date().toISOString(),
    requirements: ['required_status_checks'],
    requiredChecks: ['ci/test'],
    requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
    sources: ['classic'],
    policySnapshot: TEST_POLICY_SNAPSHOT,
    detail: 'Live branch protection confirmed with required checks',
  };
}

function makeProposal(filename: string): Proposal {
  const diff = diffFor(filename);
  const diffHash = hashDiff(diff);
  const proposal = createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'host auto-merge e2e',
    summary: 'Exercise the real autoMergeProposal call site through to gh pr merge.',
    diff,
    diffHash,
    provenanceSig: signProvenance('codex:gpt-5.5', 'frontier' as EngineTier, diffHash),
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier' as EngineTier,
  });
  expect(setStatus(proposal.id, 'approved')).toBe(true);
  return proposal;
}

beforeEach(() => {
  useNativePrivateStorageRunner();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m506-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m506-repo-'));
  bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m506-bare-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
  initRepo(tmpRepo);
  execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });
  git(tmpRepo, ['remote', 'add', 'origin', bareRepo]);
  git(tmpRepo, ['push', '-u', 'origin', 'main']);
  git(tmpRepo, ['fetch', 'origin']);
  git(tmpRepo, ['remote', 'set-head', 'origin', 'main']);
  expect(enroll(tmpRepo).ok).toBe(true);
  if (process.platform === 'win32') useSemanticPrivateStorageRunner();

  ghMergeMock.mockReset();
  ghMergeMock.mockReturnValue('Merged pull request #506');
  originAuthorityMock.mockReset();
  originAuthorityMock.mockReturnValue({
    nameWithOwner: 'ashlrai/fixture',
    fetchUrls: [bareRepo],
    pushUrls: [bareRepo],
    pushUrl: bareRepo,
  });
  branchProtectionMock.mockReset();
  branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') => protectionAttestation(branch));
  viewPrMock.mockReset();
  viewPrMock.mockReturnValue(null);
  createPrMock.mockReset();
  createPrMock.mockImplementation(async (_repo: string, input: { head: string; base?: string }) => {
    const url = 'https://github.com/ashlrai/fixture/pull/506';
    const headRefOid = git(tmpRepo, ['rev-parse', `refs/heads/${input.head}`]);
    // M506: the post-create protected-handoff check requires the observed PR's
    // baseRefOid to still equal the base head this merge was bound to. Real PRs
    // always carry it; this fixture must too, or the gate correctly refuses with
    // "the PR base OID changed" before host auto-merge is ever attempted.
    const baseRefOid = git(tmpRepo, ['rev-parse', `refs/heads/${input.base ?? 'main'}`]);
    // Consumed in order by the call site: post-create identity confirmation,
    // then attemptHostAutoMerge's pre-merge re-read, then its post-merge re-read.
    viewPrMock
      .mockReturnValueOnce({
        id: 'PR_kwDOm506',
        number: 506,
        url,
        state: 'OPEN',
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
      })
      .mockReturnValueOnce({
        id: 'PR_kwDOm506',
        number: 506,
        url,
        state: 'OPEN',
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
      })
      .mockReturnValueOnce({
        id: 'PR_kwDOm506',
        number: 506,
        url,
        state: 'MERGED',
        mergedAt: new Date().toISOString(),
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
        mergeCommitOid: 'a'.repeat(40),
      });
    return { ok: true, url, detail: 'PR created' };
  });
}, 60_000);

afterEach(() => {
  try { setKill(false); } catch { /* ignore */ }
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(bareRepo, { recursive: true, force: true });
  useNativePrivateStorageRunner();
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
});

describe('M506 host auto-merge end-to-end wiring', { timeout: 60_000 }, () => {
  it('reaches gh pr merge through the real autoMergeProposal call site when hostAutoMerge=true', async () => {
    const proposal = makeProposal('docs/m506-e2e.md');

    const result = await autoMergeProposal(proposal.id, config());

    expect(result.ok, result.reason).toBe(true);
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(result.reason).toMatch(/merged via host auto-merge/);
    expect(ghMergeMock).toHaveBeenCalledTimes(1);
    expect(ghMergeMock.mock.calls[0]?.[0]).toEqual([
      'pr', 'merge', 'https://github.com/ashlrai/fixture/pull/506', '--repo', 'ashlrai/fixture', '--squash',
    ]);
  });
});
