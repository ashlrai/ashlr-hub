/**
 * M520 - genuine end-to-end proof of the FULL autonomous merge chain, mirroring
 * the operator's LIVE production config (trustBasis='verification',
 * managerGate=true, hostAutoMerge=true) rather than the simplified 'tier' +
 * no-manager-gate config m506 uses to isolate the last hop.
 *
 * m506 (test/m506.host-auto-merge-e2e.test.ts) already proves autoMergeProposal
 * reaches attemptHostAutoMerge/gh pr merge under trustBasis='tier' with
 * allowWithoutVerification=true and managerGate=false — i.e. it pins the LAST
 * hop only, with Gates 4b/6/7 short-circuited or skipped.
 *
 * This file drives a proposal from creation through EVERY gate a real
 * production proposal must clear under the operator's actual config:
 *
 *   1. enabled                         — cfg.foundry.autoMerge.enabled
 *   2. proposal exists / mergeable kind
 *   3. kill switch + enrollment
 *   4b. verification trust basis        — REAL frontier-judge 'ship' HMAC
 *       attestation (planted via the real, unmocked decisions ledger) +
 *       REAL verifyResult.passed (from an ACTUAL isolated-worktree verify
 *       run below, not a pre-set field) + risk/scope + EDV + provenance
 *   4.5 signed provenance (belt-and-suspenders re-check)
 *   5/5.5 risk class + scope cap
 *   6   full verification in an isolated worktree (REAL `ashlr.verify.json`
 *       command execution — not allowWithoutVerification)
 *   7   manager quality gate — REAL decisions-ledger cache lookup finds the
 *       same planted frontier-judge 'ship' attestation and reuses it (no
 *       judge/model client is mocked or invoked)
 *   7.5 self-target escalation — proposal targets a NON-self repo, so this
 *       gate is a pass-through (self-target's Gate 7.5 hold is covered by
 *       test/m153.verification-gate.test.ts [A10] and test/m126.* already;
 *       re-proving it here would require running the real self-eval-parity
 *       invariant suite in a throwaway repo, which is redundant and slow)
 *   8   autonomy policy + sealed evidence pack
 *   branch push -> PR creation -> attemptHostAutoMerge -> `gh pr merge`
 *
 * Only true network/process boundaries are mocked: `gh` itself (child_process
 * execFileSync), and the GitHub REST/GraphQL calls behind createPr/viewPr/
 * readBranchProtectionAttestation. Everything else — git, the proposal store,
 * the decisions ledger, provenance signing/verification, risk classification,
 * scope measurement, the isolated-worktree verify run, and the host-merge
 * revocation protocol — is the REAL production code running against a real
 * temp git repo.
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
import { hashDiff, signProvenance, signJudgeAttestation } from '../src/core/foundry/provenance.js';
import { recordDecision, readDecisions } from '../src/core/fleet/decisions-ledger.js';
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
    ruleId: 'BPR_m520',
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
  // Real verify command — Gate 6 (and the pre-Gate-4 verification-mode run)
  // executes this for real in an isolated worktree; there is no
  // allowWithoutVerification shortcut in this test.
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
    '+full-chain e2e wiring',
    '',
  ].join('\n');
}

/** Config mirroring the operator's live ~/.ashlr/config.json foundry.autoMerge
 *  block: trustBasis='verification', managerGate=true, hostAutoMerge=true. */
function productionLikeConfig(): AshlrConfig {
  return {
    foundry: {
      autoMerge: {
        enabled: true,
        maxRisk: 'medium',
        maxAutomergeFiles: 40,
        maxAutomergeLines: 3000,
        managerGate: true,
        allowSelfMerge: false,
        pushToRemote: true,
        trustBasis: 'verification',
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
    repositoryId: 'R_m520fixture',
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

/** A real, non-frontier ('local') producer — proving verification mode does
 *  what tier mode cannot: authorize ordinary swarm output once a frontier
 *  judge ships it, instead of requiring the producer itself to be frontier. */
function makeProposal(filename: string): Proposal {
  const diff = diffFor(filename);
  const diffHash = hashDiff(diff);
  const proposal = createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: 'full-chain e2e',
    summary: 'Exercise the real autoMergeProposal call site end-to-end under the production-like verification config.',
    diff,
    diffHash,
    provenanceSig: signProvenance('local:qwen3-coder', 'local' as EngineTier, diffHash),
    engineModel: 'local:qwen3-coder',
    engineTier: 'local' as EngineTier,
  });
  expect(setStatus(proposal.id, 'approved')).toBe(true);
  return proposal;
}

/** Plant a REAL frontier-judge 'ship' decision in the (unmocked) decisions
 *  ledger, HMAC-signed exactly as the real judge path signs it (M157/M153),
 *  including the issuedAt/mergeIntent fields Gate 7's cache lookup requires
 *  (src/core/inbox/merge.ts ~3692-3708) so this single planted entry
 *  satisfies BOTH Gate 4b criterion 1 AND Gate 7's cache check without
 *  mocking judgeProposal or any provider client. */
function plantFrontierShipDecision(proposalId: string, diff: string): void {
  const ts = new Date().toISOString();
  const judgeAttestation = signJudgeAttestation({
    proposalId,
    judgeEngine: 'claude-opus-4-5',
    verdict: 'ship',
    diffHash: hashDiff(diff),
    issuedAt: ts,
    mergeIntent: 'would-merge',
  });
  recordDecision({
    ts,
    proposalId,
    action: 'judged',
    engine: 'claude-opus-4-5',
    model: 'claude-opus-4-5',
    verdict: 'ship',
    reason: 'frontier judge ship (m520 e2e)',
    detail: 'would-merge',
    judgeAttestation,
    judgeAttestationIssuedAt: ts,
    judgeAttestationIntent: 'would-merge',
  });
}

beforeEach(() => {
  useNativePrivateStorageRunner();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m520-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m520-repo-'));
  bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m520-bare-'));
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
  ghMergeMock.mockReturnValue('Merged pull request #520');
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
    const url = 'https://github.com/ashlrai/fixture/pull/520';
    const headRefOid = git(tmpRepo, ['rev-parse', `refs/heads/${input.head}`]);
    const baseRefOid = git(tmpRepo, ['rev-parse', `refs/heads/${input.base ?? 'main'}`]);
    viewPrMock
      .mockReturnValueOnce({
        id: 'PR_kwDOm520',
        number: 520,
        url,
        state: 'OPEN',
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
      })
      .mockReturnValueOnce({
        id: 'PR_kwDOm520',
        number: 520,
        url,
        state: 'OPEN',
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
      })
      .mockReturnValueOnce({
        id: 'PR_kwDOm520',
        number: 520,
        url,
        state: 'MERGED',
        mergedAt: new Date().toISOString(),
        headRefName: input.head,
        headRefOid,
        baseRefName: input.base ?? 'main',
        baseRefOid,
        mergeCommitOid: 'b'.repeat(40),
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

describe('M520 full-chain merge e2e (production-like verification config)', () => {
  it('a non-frontier, non-self-target proposal clears every gate and reaches gh pr merge', async () => {
    const proposal = makeProposal('docs/m520-e2e.md');
    plantFrontierShipDecision(proposal.id, proposal.diff ?? '');

    const cfg = productionLikeConfig();
    const result = await autoMergeProposal(proposal.id, cfg);

    expect(result.ok, result.reason).toBe(true);
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(result.reason).toMatch(/merged via host auto-merge/);

    // Gate 6 really ran (not allowWithoutVerification) and Gate 4b/7 really
    // consulted the real, unmocked decisions ledger.
    expect(ghMergeMock).toHaveBeenCalledTimes(1);
    expect(ghMergeMock.mock.calls[0]?.[0]).toEqual([
      'pr', 'merge', 'https://github.com/ashlrai/fixture/pull/520', '--repo', 'ashlrai/fixture', '--squash',
    ]);
    expect(createPrMock).toHaveBeenCalledTimes(1);

    // Gate 7 recorded its own authorization decision (either by reusing the
    // planted attestation from the cache, or — if it judged inline instead —
    // it would have thrown on the mocked provider client; the fact that no
    // judge/provider mock was ever installed and the merge still succeeded
    // proves the cache path, not an inline judge call, authorized it).
    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'merge-authorized')).toBe(true);
    expect(decisions.filter((d) => d.action === 'judged')).toHaveLength(1);
  });
});
