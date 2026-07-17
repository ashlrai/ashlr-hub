/**
 * M315 — remote PR handoff truth.
 *
 * A remote PR handoff prevents duplicate PR spam, but it is not proof that the
 * host merged the PR. The proposal must leave the pending queue without being
 * counted as applied/merged until a reconciler proves the host outcome.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const {
  createPrMock,
  viewPrMock,
  branchProtectionMock,
  originAuthorityMock,
  ghExecMock,
  localIntentPersistedHookMock,
} = vi.hoisted(() => ({
  createPrMock: vi.fn(),
  viewPrMock: vi.fn(),
  branchProtectionMock: vi.fn(),
  originAuthorityMock: vi.fn(),
  ghExecMock: vi.fn(),
  localIntentPersistedHookMock: vi.fn(),
}));
const privateStorageHarness = vi.hoisted(() => ({
  useSemanticAdapter: false,
  realCalls: 0,
}));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => {
      if (process.platform === 'win32' && privateStorageHarness.useSemanticAdapter) {
        return {
          ok: true,
          reason: args[2] === 'inspect-owned' ? 'owned-safe-path' : 'exact-private-dacl',
        };
      }
      privateStorageHarness.realCalls += 1;
      return actual.assurePrivateStoragePath(...args);
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => (
      args[0] === 'gh' ? ghExecMock(...args) : actual.execFileSync(...args)
    ),
  };
});

vi.mock('../src/core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/git.js')>();
  return {
    ...actual,
    getRemoteOrg: (_repoPath: string) => ({
      remote: 'https://github.com/ashlrai/fixture.git',
      org: 'ashlrai',
    }),
    resolveGitHubOriginAuthority: () => originAuthorityMock()?.nameWithOwner ?? null,
    resolveGitHubOriginAuthorityDetails: () => originAuthorityMock(),
  };
});

vi.mock('../src/core/integrations/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/integrations/github.js')>();
  return {
    ...actual,
    createPr: (...args: unknown[]) => createPrMock(...args),
    viewPr: (...args: unknown[]) => {
      const result = viewPrMock(...args) as Record<string, unknown> | null | undefined;
      if (!result || typeof result.headRefName !== 'string' || typeof result.headRefOid === 'string') return result;
      try {
        const headRefOid = execFileSync(
          'git',
          ['-C', String(args[0]), 'rev-parse', '--verify', `refs/heads/${result.headRefName}`],
          { stdio: 'pipe', encoding: 'utf8' },
        ).trim();
        return { ...result, headRefOid };
      } catch {
        return result;
      }
    },
    readBranchProtectionAttestation: (...args: unknown[]) => branchProtectionMock(...args),
  };
});

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return {
    ...actual,
    updateProposalField: (...args: Parameters<typeof actual.updateProposalField>) => {
      const persisted = actual.updateProposalField(...args);
      const fields = args[1] as Record<string, unknown> | undefined;
      if (persisted && fields && 'localMergeIntent' in fields) localIntentPersistedHookMock(args[0]);
      return persisted;
    },
  };
});

import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { evidencePath, readAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { reconcileRemoteHandoffs } from '../src/core/inbox/remote-handoff.js';
import { canonicalRealizedMergeIdentity } from '../src/core/inbox/realized-merge.js';
import {
  getRemoteHandoffKeyDiagnostic,
  MAX_REMOTE_HANDOFF_RECONCILIATION_LAG_MS,
  verifyRemoteHandoffReconciliation,
} from '../src/core/inbox/remote-handoff-attestation.js';
import {
  _setProposalReadRaceHookForTest,
  createProposal,
  listProposals,
  loadProposal,
  setStatus,
  updateProposalField,
} from '../src/core/inbox/store.js';
import { acquireProposalMutationLock, releaseProposalMutationLock } from '../src/core/inbox/proposal-mutation-lock.js';
import { readDecisions, recordDecision } from '../src/core/fleet/decisions-ledger.js';
import { hashDiff, signJudgeAttestation, signProvenance } from '../src/core/foundry/provenance.js';
import { enroll, setKill, unenroll } from '../src/core/sandbox/policy.js';
import type { AshlrConfig } from '../src/core/types.js';

const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
const origAshlrHome = process.env.ASHLR_HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;
let bareRepo: string;
let ghCallsFile: string;
const TEST_POLICY_SNAPSHOT = {
  schemaVersion: 2,
  classic: {
    ruleId: 'BPR_fixture',
    pattern: 'main',
    bypassForcePushAllowanceCount: 0,
    bypassForcePushAllowances: { users: [], teams: [], apps: [] },
    requiredDeployments: null,
    requiredStatusChecks: {
      strict: true,
      enforcementLevel: 'non_admins',
      checks: [{ context: 'ci/test', appId: '1' }],
    },
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

function setFixtureEnvironment(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
}

function restoreFixtureEnvironment(): void {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = origUserProfile;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
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

function addFileDiff(filename: string, content: string): string {
  return [
    `diff --git a/${filename} b/${filename}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${filename}`,
    '@@ -0,0 +1 @@',
    `+${content}`,
    '',
  ].join('\n');
}

function advanceRemoteMainWithoutFetching(filename: string, content: string): void {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-remote-'));
  const clone = path.join(parent, 'clone');
  try {
    execFileSync('git', ['clone', '--branch', 'main', bareRepo, clone], { stdio: 'pipe' });
    git(clone, ['config', 'user.email', 'remote@ashlr.test']);
    git(clone, ['config', 'user.name', 'Remote Writer']);
    fs.writeFileSync(path.join(clone, filename), content, 'utf8');
    git(clone, ['add', filename]);
    git(clone, ['commit', '-m', 'advance remote main']);
    git(clone, ['push', 'origin', 'main']);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function cfg(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        maxRisk: 'low',
        allowWithoutVerification: true,
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '1' }],
        },
      },
    },
  } as unknown as AshlrConfig;
}

function evidenceCfg(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [],
      autoMerge: {
        enabled: true,
        trustBasis: 'evidence',
        maxRisk: 'low',
        allowWithoutVerification: false,
        pushToRemote: true,
        protectedRemote: {
          branchProtection: true,
          requiredChecks: [{ context: 'ci/test', appId: '1' }],
        },
      },
    },
  } as unknown as AshlrConfig;
}

function verificationCfg(): AshlrConfig {
  const config = cfg();
  if (config.foundry?.autoMerge) {
    config.foundry.autoMerge.trustBasis = 'verification';
    config.foundry.autoMerge.allowWithoutVerification = false;
  }
  return config;
}

function recordVerificationAuthority(proposalId: string, diff: string): void {
  const ts = new Date().toISOString();
  const judgeEngine = 'claude-opus-4-5';
  recordDecision({
    ts,
    proposalId,
    action: 'judged',
    engine: judgeEngine,
    model: judgeEngine,
    verdict: 'ship',
    reason: 'frontier judge ship',
    detail: 'would-merge',
    judgeAttestationIssuedAt: ts,
    judgeAttestationIntent: 'would-merge',
    judgeAttestation: signJudgeAttestation({
      proposalId,
      judgeEngine,
      verdict: 'ship',
      diffHash: hashDiff(diff),
      issuedAt: ts,
      mergeIntent: 'would-merge',
    }),
  });
  recordDecision({
    ts: new Date(Date.parse(ts) + 1).toISOString(),
    proposalId,
    action: 'verified',
    verdict: 'approved',
    reason: 'independent verification confirmed',
  });
}

beforeEach(() => {
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-home-')));
  tmpRepo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-repo-')));
  bareRepo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-bare-')));
  setFixtureEnvironment(tmpHome);
  privateStorageHarness.useSemanticAdapter = true;
  ghCallsFile = path.join(tmpHome, 'gh-calls.jsonl');
  ghExecMock.mockReset();
  localIntentPersistedHookMock.mockReset();
  ghExecMock.mockImplementation((_file, rawArgs) => {
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    if (args[0] === 'pr' && args[1] === 'merge') {
      const inboxDir = path.join(process.env.ASHLR_HOME ?? '', 'inbox');
      const ready = fs.existsSync(inboxDir) && fs.readdirSync(inboxDir).some((name) => {
        try {
          const proposal = JSON.parse(fs.readFileSync(path.join(inboxDir, name), 'utf8')) as {
            status?: string;
            remoteHandoff?: { expectedHeadOid?: string };
          };
          return proposal.status === 'awaiting-host-merge' &&
            /^[0-9a-f]{40}$/.test(proposal.remoteHandoff?.expectedHeadOid ?? '');
        } catch {
          return false;
        }
      });
      if (!ready) throw new Error('host auto-merge invoked before durable handoff');
    }
    fs.appendFileSync(ghCallsFile, `${JSON.stringify(args)}\n`, 'utf8');
    return '';
  });
  setKill(false);
  initRepo(tmpRepo);
  originAuthorityMock.mockReset();
  originAuthorityMock.mockImplementation(() => ({
    nameWithOwner: 'ashlrai/fixture',
    fetchUrls: [bareRepo],
    pushUrls: [bareRepo],
    pushUrl: bareRepo,
  }));
  branchProtectionMock.mockReset();
  branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') => ({
    ok: true,
    available: true,
    protected: true,
    branchProtection: true,
    nameWithOwner: 'ashlrai/fixture',
    repositoryId: 'R_fixture',
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
  }));
  execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });
  git(tmpRepo, ['remote', 'add', 'origin', bareRepo]);
  git(tmpRepo, ['push', '-u', 'origin', 'main']);
  git(tmpRepo, ['fetch', 'origin']);
  git(tmpRepo, ['remote', 'set-head', 'origin', 'main']);
  enroll(tmpRepo);
  viewPrMock.mockReset();
  createPrMock.mockReset();
  createPrMock.mockImplementation(async (_repo: string, input: { head: string; base?: string }) => {
    viewPrMock.mockReturnValueOnce({
      url: 'https://github.com/ashlrai/fixture/pull/123',
      state: 'OPEN',
      headRefName: input.head,
      baseRefName: input.base ?? 'main',
    });
    return {
      ok: true,
      url: 'https://github.com/ashlrai/fixture/pull/123',
      detail: 'PR created',
    };
  });
});

afterEach(() => {
  _setProposalReadRaceHookForTest(undefined);
  try {
    try { unenroll(tmpRepo); } catch { /* ignore */ }
    try { setKill(false); } catch { /* ignore */ }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(bareRepo, { recursive: true, force: true });
  } finally {
    privateStorageHarness.useSemanticAdapter = false;
    restoreFixtureEnvironment();
  }
});

describe('M315 remote PR handoff truth', { timeout: 60_000 }, () => {
  async function createRemoteHandoffProposal(beforeMerge?: (proposal: Proposal) => void) {
    const diff = addFileDiff('docs/handoff.md', 'truthful remote handoff');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'remote handoff truth',
      summary: 'Open a PR and wait for host merge truth.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(proposal.id, 'approved');
    beforeMerge?.(proposal);

    const result = await autoMergeProposal(proposal.id, cfg());
    return { proposal, result };
  }

  it('records a remote PR handoff without marking the proposal applied or merged', async () => {
    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({
      ok: true,
      merged: false,
      handoff: true,
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(createPrMock).toHaveBeenCalledWith(tmpRepo, expect.objectContaining({
      repo: 'ashlrai/fixture',
      base: 'main',
    }));
    const stagedHead = git(tmpRepo, ['rev-parse', `refs/heads/ashlr/merge/${proposal.id}`]);
    const ghCalls = (fs.existsSync(ghCallsFile) ? fs.readFileSync(ghCallsFile, 'utf8') : '').trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(ghCalls).not.toContainEqual([
      'pr', 'merge', '--auto', '--squash', '--match-head-commit', stagedHead,
      '--repo', 'ashlrai/fixture',
      'https://github.com/ashlrai/fixture/pull/123',
    ]);
    expect(branchProtectionMock.mock.calls.every((call) => (
      call[2]?.forceFresh === true && call[2]?.expectedNameWithOwner === 'ashlrai/fixture'
    ))).toBe(true);

    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      provider: 'github',
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
      base: 'main',
      expectedHeadOid: stagedHead,
    });
    expect(loaded?.remoteHandoff?.detail).toMatch(/host auto-merge (?:not enabled|is disabled).*durable revocation/i);
    expect(listProposals({ status: 'pending' }).some((p) => p.id === proposal.id)).toBe(false);
    expect(listProposals({ status: 'applied' }).some((p) => p.id === proposal.id)).toBe(false);

    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'handoff')).toBe(true);
  }, 60_000);

  it.each([
    ['kill switch', () => setKill(true), /kill switch/i],
    ['enrollment', () => unenroll(tmpRepo), /not enrolled/i],
  ])('rechecks %s inside the final fence before staging', async (_label, revoke, expectedReason) => {
    const readProtection = branchProtectionMock.getMockImplementation() as (...args: unknown[]) => unknown;
    branchProtectionMock.mockImplementation(async (...args: unknown[]) => {
      const result = await readProtection(...args);
      revoke();
      return result;
    });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(expectedReason);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).not.toContain(`ashlr/merge/${proposal.id}`);
    expect(() => git(tmpRepo, ['rev-parse', '--verify', `refs/heads/ashlr/merge/${proposal.id}`])).toThrow();
  }, 60_000);

  it('rechecks authority immediately before pushing the staging branch', async () => {
    const readProtection = branchProtectionMock.getMockImplementation() as (...args: unknown[]) => unknown;
    let protectionReads = 0;
    branchProtectionMock.mockImplementation(async (...args: unknown[]) => {
      const result = await readProtection(...args);
      protectionReads++;
      if (protectionReads === 3) setKill(true);
      return result;
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/kill switch/i);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).not.toContain(branch);
    expect(git(tmpRepo, ['rev-parse', '--verify', `refs/heads/${branch}`])).toMatch(/^[a-f0-9]{40}$/);
  }, 60_000);

  it('refuses staging push when signed evidence disappears after intent persistence', async () => {
    localIntentPersistedHookMock.mockImplementationOnce((proposalId: string) => {
      fs.unlinkSync(evidencePath(proposalId));
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/signed evidence seal is no longer live; staging push not started/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', branch])).toBe('');
  }, 60_000);

  it('atomically refuses staging push when the verified remote base advances at push time', async () => {
    localIntentPersistedHookMock.mockImplementationOnce(() => {
      advanceRemoteMainWithoutFetching('REMOTE-RACE.md', 'advanced at push boundary\n');
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/staging push outcome is unknown/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', branch])).toBe('');
  }, 60_000);

  it('atomically refuses staging push when the verified remote base rewinds at push time', async () => {
    fs.writeFileSync(path.join(tmpRepo, 'BASE-RACE.md'), 'second base commit\n', 'utf8');
    git(tmpRepo, ['add', 'BASE-RACE.md']);
    git(tmpRepo, ['commit', '-m', 'second base commit']);
    git(tmpRepo, ['push', 'origin', 'main']);
    const verifiedBase = git(tmpRepo, ['rev-parse', 'main']);
    const priorBase = git(tmpRepo, ['rev-parse', 'main^']);
    localIntentPersistedHookMock.mockImplementationOnce(() => {
      git(bareRepo, ['update-ref', 'refs/heads/main', priorBase, verifiedBase]);
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/staging push outcome is unknown/);
    expect(git(bareRepo, ['rev-parse', 'main'])).toBe(priorBase);
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', branch])).toBe('');
  }, 60_000);

  it('atomically refuses staging push when the verified remote base is deleted at push time', async () => {
    const verifiedBase = git(tmpRepo, ['rev-parse', 'main']);
    localIntentPersistedHookMock.mockImplementationOnce(() => {
      git(bareRepo, ['update-ref', '-d', 'refs/heads/main', verifiedBase]);
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/staging push outcome is unknown/);
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', 'main'])).toBe('');
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', branch])).toBe('');
  }, 60_000);

  it.each([
    ['initial evidence capture', 1, false, false, false],
    ['post-persistence authority check', 2, false, false, false],
    ['pre-push authority check', 3, false, false, false],
    ['post-push authority check', 4, true, false, false],
    ['post-PR authority check', 5, true, true, true],
  ] as const)(
    'refuses unsafe protected-remote policy drift at the %s',
    async (_checkpoint, unsafeRead, remoteBranchExists, prExists, handoffExists) => {
      const readProtection = branchProtectionMock.getMockImplementation() as (...args: unknown[]) => unknown;
      let protectionReads = 0;
      branchProtectionMock.mockImplementation(async (...args: unknown[]) => {
        const result = await readProtection(...args) as Record<string, unknown>;
        protectionReads++;
        if (protectionReads !== unsafeRead) return result;
        return {
          ...result,
          policySnapshot: {
            ...TEST_POLICY_SNAPSHOT,
            classic: {
              ...TEST_POLICY_SNAPSHOT.classic,
              allowDeletions: true,
            },
          },
        };
      });

      const { proposal, result } = await createRemoteHandoffProposal();
      const branch = `ashlr/merge/${proposal.id}`;
      const remoteBranches = git(tmpRepo, ['ls-remote', '--heads', 'origin', branch]);

      expect(remoteBranches.includes(branch)).toBe(remoteBranchExists);
      expect(createPrMock).toHaveBeenCalledTimes(prExists ? 1 : 0);
      expect(branchProtectionMock).toHaveBeenCalledTimes(unsafeRead);
      if (handoffExists) {
        expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
        expect(loadProposal(proposal.id)?.remoteHandoff?.detail)
          .toContain('host auto-merge refused because live protection changed');
      } else {
        expect(result).toMatchObject({ ok: false, merged: false });
        expect(result.reason).toMatch(/safe-minimum protected-remote policy unavailable|live branch protection changed/);
      }
    },
    60_000,
  );

  it('does not let pause report quiescence between push and PR creation', async () => {
    let pauseResult: ReturnType<typeof setKill> | undefined;
    viewPrMock.mockImplementationOnce(() => {
      pauseResult = setKill(true, { waitMs: 25 });
      return null;
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;

    expect(pauseResult).toMatchObject({ ok: false, quiesced: false });
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).toContain(branch);
    expect(git(tmpRepo, ['rev-parse', '--verify', `refs/heads/${branch}`])).toMatch(/^[a-f0-9]{40}$/);
  }, 60_000);

  it('keeps the fence through the durable receipt when pause races PR observation', async () => {
    let pauseResult: ReturnType<typeof setKill> | undefined;
    createPrMock.mockImplementationOnce(async (_repo: string, input: { head: string; base?: string }) => {
      viewPrMock.mockImplementationOnce(() => {
        pauseResult = setKill(true, { waitMs: 25 });
        return {
          url: 'https://github.com/ashlrai/fixture/pull/123',
          state: 'OPEN',
          headRefName: input.head,
          baseRefName: input.base ?? 'main',
        };
      });
      return {
        ok: true,
        url: 'https://github.com/ashlrai/fixture/pull/123',
        detail: 'PR created',
      };
    });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(pauseResult).toMatchObject({ ok: false, quiesced: false });
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(ghExecMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { prUrl: 'https://github.com/ashlrai/fixture/pull/123' },
    });
  }, 60_000);

  it('rechecks authority immediately before a local default-branch merge', async () => {
    const localCfg = cfg();
    localCfg.foundry!.autoMerge!.pushToRemote = false;
    git(tmpRepo, ['checkout', '-b', 'operator']);
    const mainBefore = git(tmpRepo, ['rev-parse', 'main']);
    const diff = addFileDiff('docs/local-authority.md', 'local merge requires live authority');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'local merge authority',
      summary: 'Recheck authority after durable local intent.',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
    });
    setStatus(proposal.id, 'approved');
    localIntentPersistedHookMock.mockImplementationOnce(() => setKill(true));

    const result = await autoMergeProposal(proposal.id, localCfg);

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/kill switch/i);
    expect(localIntentPersistedHookMock).toHaveBeenCalledTimes(1);
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(git(tmpRepo, ['rev-parse', '--verify', `refs/heads/ashlr/merge/${proposal.id}`])).toMatch(/^[a-f0-9]{40}$/);
  }, 60_000);

  it('tier mode refuses an unprotected remote before any push or PR creation', async () => {
    branchProtectionMock.mockResolvedValue({
      ok: false,
      available: true,
      protected: false,
      branchProtection: false,
      detail: 'No enforceable branch protection requirements were found',
    });

    const { result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/protected remote handoff denied: live branch protection unavailable/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).not.toContain('refs/heads/ashlr/');
  }, 30_000);

  it('verification mode refuses an unprotected remote before any push or PR creation', async () => {
    const diff = addFileDiff('docs/verification-protection.md', 'verification still needs host protection');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'verification remote protection',
      summary: 'Bind judge-backed delivery to live protection.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });
    recordVerificationAuthority(proposal.id, diff);
    branchProtectionMock.mockResolvedValue({
      ok: false,
      available: true,
      protected: false,
      branchProtection: false,
      detail: 'No enforceable branch protection requirements were found',
    });

    const result = await autoMergeProposal(proposal.id, verificationCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/protected remote handoff denied: live branch protection unavailable/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).not.toContain('refs/heads/ashlr/');
  }, 30_000);

  it('refuses PR creation when protection changes during the staging-branch push', async () => {
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const protectedEvidence = {
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch: 'main',
      baseHead,
      observedAt: new Date().toISOString(),
      requirements: ['required_status_checks'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
      sources: ['classic'],
      policySnapshot: TEST_POLICY_SNAPSHOT,
      detail: 'Live branch protection confirmed with required checks',
    };
    branchProtectionMock
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce({
        ...protectedEvidence,
        ok: false,
        protected: false,
        branchProtection: false,
        requirements: [],
        requiredChecks: [],
        requiredCheckBindings: [],
        sources: [],
        detail: 'No enforceable branch protection requirements were found',
      });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/live branch protection changed after push; PR creation not started/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(branchProtectionMock).toHaveBeenCalledTimes(4);
    expect(git(tmpRepo, ['branch', '--list', `ashlr/merge/${proposal.id}`])).toContain(`ashlr/merge/${proposal.id}`);
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', `ashlr/merge/${proposal.id}`]))
      .toContain(`ashlr/merge/${proposal.id}`);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { detail: expect.stringContaining('PR creation not started') },
    });
  }, 30_000);

  it('refuses PR creation when merge-critical policy semantics drift with identical checks', async () => {
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const protectedEvidence = {
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch: 'main',
      baseHead,
      observedAt: new Date().toISOString(),
      requirements: ['required_status_checks', 'enforce_admins'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
      sources: ['classic'] as const,
      policySnapshot: TEST_POLICY_SNAPSHOT,
      detail: 'Live branch protection confirmed with required checks',
    };
    branchProtectionMock
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce(protectedEvidence)
      .mockResolvedValueOnce({
        ...protectedEvidence,
        requirements: ['required_status_checks'],
        policySnapshot: {
          ...TEST_POLICY_SNAPSHOT,
          classic: { enforceAdmins: false },
        },
      });

    const { result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/live branch protection changed after push; PR creation not started/);
    expect(createPrMock).not.toHaveBeenCalled();
  }, 30_000);

  it('refuses an ambiguous origin before any protected remote mutation', async () => {
    originAuthorityMock.mockReturnValue(null);

    const { result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/protected remote handoff requires a canonical GitHub origin/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin'])).not.toContain('refs/heads/ashlr/');
  }, 30_000);

  it('quarantines an untrusted PR URL instead of recording cross-repository authority', async () => {
    createPrMock.mockResolvedValueOnce({
      ok: true,
      url: 'https://github.com/attacker/fixture/pull/123',
      detail: 'host returned a different repository',
    });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/PR creation outcome is unknown: PR creation returned no canonical URL/);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: {
        state: 'awaiting-host-merge',
        branch: `ashlr/merge/${proposal.id}`,
        base: 'main',
        expectedHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });
    expect(loadProposal(proposal.id)?.remoteHandoff?.prUrl).toBeUndefined();
    expect(fs.existsSync(ghCallsFile) ? fs.readFileSync(ghCallsFile, 'utf8') : '').toBe('');
  }, 30_000);

  it('refuses host auto-merge when the remote PR head changes during PR creation', async () => {
    let replacement = '';
    createPrMock.mockImplementation(async (_repo: string, input: { head: string }) => {
      replacement = git(tmpRepo, ['commit-tree', git(tmpRepo, ['rev-parse', 'main^{tree}']), '-m', 'replacement']);
      git(tmpRepo, ['push', '--force', 'origin', `${replacement}:refs/heads/${input.head}`]);
      return {
        ok: true,
        url: 'https://github.com/ashlrai/fixture/pull/123',
        detail: 'PR created after remote head replacement',
      };
    });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(result.reason).toMatch(/host auto-merge refused because the remote PR head changed/);
    const quarantined = loadProposal(proposal.id);
    expect(quarantined).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: {
        state: 'awaiting-host-merge',
        prUrl: 'https://github.com/ashlrai/fixture/pull/123',
        expectedHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/),
        detail: expect.stringContaining('remote PR head mismatch'),
      },
    });
    expect(quarantined?.remoteHandoff?.expectedHeadOid).not.toBe(replacement);
    expect(fs.existsSync(ghCallsFile) ? fs.readFileSync(ghCallsFile, 'utf8') : '').toBe('');

    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: quarantined?.remoteHandoff?.prUrl,
      headRefName: quarantined?.remoteHandoff?.branch,
      headRefOid: replacement,
      baseRefName: quarantined?.remoteHandoff?.base,
    });
    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  }, 30_000);

  it('quarantines a newly created PR whose observed base does not match the intent', async () => {
    createPrMock.mockImplementationOnce(async (_repo: string, input: { head: string }) => {
      viewPrMock.mockReturnValueOnce({
        url: 'https://github.com/ashlrai/fixture/pull/123',
        state: 'OPEN',
        headRefName: input.head,
        baseRefName: 'release',
      });
      return {
        ok: true,
        url: 'https://github.com/ashlrai/fixture/pull/123',
        detail: 'PR created on the wrong base',
      };
    });

    const { proposal, result } = await createRemoteHandoffProposal();

    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(result.reason).toMatch(/post-create PR identity was not confirmed/);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: {
        prUrl: 'https://github.com/ashlrai/fixture/pull/123',
        detail: expect.stringContaining('post-create PR identity was not confirmed'),
      },
    });
    expect(fs.existsSync(ghCallsFile) ? fs.readFileSync(ghCallsFile, 'utf8') : '').toBe('');
  }, 30_000);

  it('refuses to overwrite a pre-existing remote staging branch', async () => {
    let preExistingHead = '';
    const { proposal, result } = await createRemoteHandoffProposal((created) => {
      const branch = `ashlr/merge/${created.id}`;
      preExistingHead = git(tmpRepo, ['rev-parse', 'main']);
      git(tmpRepo, ['push', 'origin', `${preExistingHead}:refs/heads/${branch}`]);
    });

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/staging push outcome is unknown.*signed intent retained/i);
    expect(git(tmpRepo, ['ls-remote', '--heads', 'origin', `ashlr/merge/${proposal.id}`]))
      .toContain(preExistingHead);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      localMergeIntent: { proposalHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/) },
    });
    expect(createPrMock).not.toHaveBeenCalled();
    expect(fs.existsSync(ghCallsFile) ? fs.readFileSync(ghCallsFile, 'utf8') : '').toBe('');
  }, 30_000);

  it('persists intent before an ambiguous PR failure and binds the exact PR during reconciliation', async () => {
    createPrMock.mockImplementationOnce(async () => {
      const intents = listProposals({ status: 'awaiting-host-merge' });
      expect(intents).toHaveLength(1);
      expect(intents[0]?.remoteHandoff).toMatchObject({
        state: 'awaiting-host-merge',
        branch: expect.stringMatching(/^ashlr\/merge\//),
        base: 'main',
        expectedHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      });
      expect(intents[0]?.remoteHandoff?.prUrl).toBeUndefined();
      return { ok: false, detail: 'request timed out' };
    });

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;
    const remoteHead = git(tmpRepo, ['ls-remote', '--heads', 'origin', branch]).split(/\s+/)[0];

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/PR creation outcome is unknown/);
    expect(remoteHead).toMatch(/^[0-9a-f]{40}$/);
    expect(git(tmpRepo, ['branch', '--list', branch])).toContain(branch);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { branch, base: 'main', expectedHeadOid: remoteHead },
    });
    const mergedAt = loadProposal(proposal.id)!.remoteHandoff!.createdAt;

    viewPrMock.mockReturnValue({
      number: 123,
      url: 'https://github.com/ashlrai/fixture/pull/123',
      state: 'MERGED',
      mergedAt,
      mergeCommitOid: 'a'.repeat(40),
      headRefName: branch,
      headRefOid: remoteHead,
      baseRefName: 'main',
    });
    const bound = reconcileRemoteHandoffs();

    expect(bound).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { branch, base: 'main', prUrl: 'https://github.com/ashlrai/fixture/pull/123' },
    });

    let terminal = reconcileRemoteHandoffs();
    if (terminal.unknown === 1 && getRemoteHandoffKeyDiagnostic() === 'adapter-failed') {
      expect(loadProposal(proposal.id)).toMatchObject({
        status: 'awaiting-host-merge',
        remoteHandoff: {
          state: 'awaiting-host-merge',
          prUrl: 'https://github.com/ashlrai/fixture/pull/123',
        },
      });
      terminal = reconcileRemoteHandoffs();
    }
    expect(terminal).toEqual({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'applied',
      remoteHandoff: { state: 'merged', expectedHeadOid: remoteHead },
    });
  }, 30_000);

  it('retries the same URL-less proposal through full gates when host proves no PR for its exact branch', async () => {
    createPrMock.mockImplementationOnce(async () => ({ ok: false, detail: 'request timed out' }));

    const { proposal, result } = await createRemoteHandoffProposal();
    const branch = `ashlr/merge/${proposal.id}`;
    const expectedHead = loadProposal(proposal.id)?.remoteHandoff?.expectedHeadOid;
    expect(result).toMatchObject({ ok: false, merged: false });
    expect(expectedHead).toMatch(/^[0-9a-f]{40}$/);
    expect(loadProposal(proposal.id)?.remoteHandoff?.prUrl).toBeUndefined();

    ghExecMock.mockImplementation((_file, rawArgs) => {
      const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
      return args[0] === 'pr' && args[1] === 'list' ? '[]' : '';
    });
    viewPrMock.mockReturnValue(null);

    expect(reconcileRemoteHandoffs()).toMatchObject({ checked: 1, recovered: 1, merged: 0 });
    expect(loadProposal(proposal.id)).toMatchObject({
      id: proposal.id,
      status: 'approved',
      remoteHandoff: {
        state: 'unknown',
        branch,
        expectedHeadOid: expectedHead,
        detail: expect.stringContaining('[ashlr-remote-handoff-retry:1]'),
      },
    });

    createPrMock.mockImplementationOnce(async (_repo: string, input: { head: string; base?: string }) => {
      viewPrMock.mockReturnValueOnce({
        url: 'https://github.com/ashlrai/fixture/pull/124',
        state: 'OPEN',
        headRefName: input.head,
        headRefOid: expectedHead,
        baseRefName: input.base ?? 'main',
      });
      return {
        ok: true,
        url: 'https://github.com/ashlrai/fixture/pull/124',
        detail: 'PR created on bounded retry',
      };
    });
    const retried = await autoMergeProposal(proposal.id, cfg());

    expect(retried).toMatchObject({
      ok: true,
      merged: false,
      handoff: true,
      prUrl: 'https://github.com/ashlrai/fixture/pull/124',
    });
    expect(createPrMock).toHaveBeenCalledTimes(2);
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { prUrl: 'https://github.com/ashlrai/fixture/pull/124' },
    });
  }, 60_000);

  it('evidence mode opens a protected remote handoff only with command-bound evidence', async () => {
    const diff = addFileDiff('docs/evidence-handoff.md', 'protected evidence handoff');
    const diffHash = hashDiff(diff);
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'evidence remote handoff',
      summary: 'Open a protected PR from deterministic evidence.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'command-bound verification passed',
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
        baseBranch: 'main',
        baseHead,
        diffHash,
        verifiedAt: '2026-07-03T00:00:00.000Z',
        source: 'auto-merge-preflight',
      },
    });
    setStatus(proposal.id, 'pending');

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({
      ok: true,
      merged: false,
      handoff: true,
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      provider: 'github',
      state: 'awaiting-host-merge',
      base: 'main',
    });
    const pack = readAutonomyEvidencePack(proposal.id);
    expect(pack?.diff.hash).toBe(diffHash);
    expect(pack?.verification).toMatchObject({
      baseBranch: 'main',
      baseHead,
      diffHash,
      verifiedAt: expect.any(String),
      source: 'auto-merge',
      commandKinds: ['test'],
    });
    expect(pack?.policy).toMatchObject({
      action: 'merge-main',
      allowed: true,
    });
    expect(pack?.gates.remoteProtection).toMatchObject({
      ok: true,
      live: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      branch: 'main',
      baseHead,
      requirements: ['required_status_checks'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
      policySources: ['classic'],
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(branchProtectionMock).toHaveBeenCalledTimes(5);
  });

  it('evidence mode refuses static protection claims when live GitHub is unprotected', async () => {
    branchProtectionMock.mockResolvedValue({
      ok: false,
      available: true,
      protected: false,
      branchProtection: false,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch: 'main',
      baseHead: git(tmpRepo, ['rev-parse', 'main']),
      observedAt: new Date().toISOString(),
      requirements: [],
      requiredChecks: [],
      requiredCheckBindings: [],
      sources: [],
      detail: 'No enforceable branch protection requirements were found',
    });
    const diff = addFileDiff('docs/unprotected.md', 'must not hand off');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'static protection is not authority',
      summary: 'Live policy must win.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/live branch protection unavailable/);
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it('evidence mode refuses a required check without an app or integration binding', async () => {
    branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') => ({
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch,
      baseHead: git(tmpRepo, ['rev-parse', branch]),
      observedAt: new Date().toISOString(),
      requirements: ['required_status_checks'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: null }],
      sources: ['classic'],
      policySnapshot: TEST_POLICY_SNAPSHOT,
      detail: 'Required status context accepts any producer',
    }));
    const diff = addFileDiff('docs/unbound-check.md', 'must not hand off');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'unbound check is not authority',
      summary: 'Require a concrete status producer.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/do not match live GitHub App identities/);
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it('evidence mode refuses a required check produced by the wrong GitHub App', async () => {
    branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') => ({
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch,
      baseHead: git(tmpRepo, ['rev-parse', branch]),
      observedAt: new Date().toISOString(),
      requirements: ['required_status_checks'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: '999' }],
      sources: ['classic'],
      policySnapshot: TEST_POLICY_SNAPSHOT,
      detail: 'Required context is produced by an unexpected App',
    }));
    const diff = addFileDiff('docs/wrong-app.md', 'must not hand off');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'wrong App identity is not authority',
      summary: 'Require the configured GitHub App.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/ci\/test@1/);
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it('evidence mode aborts before push when live protection changes after capture', async () => {
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    branchProtectionMock
      .mockImplementationOnce(async () => ({
        ok: true,
        available: true,
        protected: true,
        branchProtection: true,
        nameWithOwner: 'ashlrai/fixture',
        repositoryId: 'R_fixture',
        defaultBranch: 'main',
        branch: 'main',
        baseHead,
        observedAt: new Date().toISOString(),
        requirements: ['required_status_checks'],
        requiredChecks: ['ci/test'],
        requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
        sources: ['classic'],
        policySnapshot: TEST_POLICY_SNAPSHOT,
        detail: 'Live branch protection confirmed with required checks',
      }))
      .mockResolvedValueOnce({
        ok: false,
        available: true,
        protected: false,
        branchProtection: false,
        nameWithOwner: 'ashlrai/fixture',
        repositoryId: 'R_fixture',
        defaultBranch: 'main',
        branch: 'main',
        baseHead,
        observedAt: new Date().toISOString(),
        requirements: [],
        requiredChecks: [],
        requiredCheckBindings: [],
        sources: [],
        detail: 'No enforceable branch protection requirements were found',
      });
    const diff = addFileDiff('docs/evidence-race.md', 'must not push');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'evidence race before push',
      summary: 'Re-attest immediately before remote handoff.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/live branch protection changed after signed evidence persistence/);
    expect(branchProtectionMock).toHaveBeenCalledTimes(2);
    expect(createPrMock).not.toHaveBeenCalled();
  }, 30_000);

  it('evidence mode refuses host auto-merge when protection changes after PR creation', async () => {
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const protectedEvidence = {
      ok: true,
      available: true,
      protected: true,
      branchProtection: true,
      nameWithOwner: 'ashlrai/fixture',
      repositoryId: 'R_fixture',
      defaultBranch: 'main',
      branch: 'main',
      baseHead,
      observedAt: new Date().toISOString(),
      requirements: ['required_status_checks'],
      requiredChecks: ['ci/test'],
      requiredCheckBindings: [{ context: 'ci/test', appId: '1' }],
      sources: ['classic'],
      policySnapshot: TEST_POLICY_SNAPSHOT,
      detail: 'Live branch protection confirmed with required checks',
    };
    branchProtectionMock
      .mockImplementationOnce(async () => ({ ...protectedEvidence, observedAt: new Date().toISOString() }))
      .mockImplementationOnce(async () => ({ ...protectedEvidence, observedAt: new Date().toISOString() }))
      .mockImplementationOnce(async () => ({ ...protectedEvidence, observedAt: new Date().toISOString() }))
      .mockImplementationOnce(async () => ({ ...protectedEvidence, observedAt: new Date().toISOString() }))
      .mockResolvedValueOnce({
        ...protectedEvidence,
        ok: false,
        protected: false,
        branchProtection: false,
        requirements: [],
        requiredChecks: [],
        requiredCheckBindings: [],
        sources: [],
        detail: 'No enforceable branch protection requirements were found',
      });
    const diff = addFileDiff('docs/post-pr-race.md', 'host auto-merge must remain off');
    const diffHash = hashDiff(diff);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'post PR evidence race',
      summary: 'Check again before enabling host automation.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
    });

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(result.reason).toMatch(/host auto-merge refused because live protection changed/);
    expect(branchProtectionMock).toHaveBeenCalledTimes(5);
    expect(createPrMock).toHaveBeenCalledTimes(1);
  });

  it('evidence mode replaces stored verification that lacks freshness metadata', async () => {
    const diff = addFileDiff('docs/evidence-legacy.md', 'legacy evidence without freshness');
    const diffHash = hashDiff(diff);
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'legacy evidence handoff',
      summary: 'Reverify before handoff when stored verification source/timestamp is missing.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'legacy command-bound verification passed',
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
        baseBranch: 'main',
        baseHead,
        diffHash,
      },
    });
    setStatus(proposal.id, 'pending');

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result.ok).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.handoff).toBe(true);
    expect(createPrMock).toHaveBeenCalledTimes(1);
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.verifyResult).toMatchObject({
      passed: true,
      source: 'auto-merge',
      verifiedAt: expect.any(String),
      diffHash,
    });
    const pack = readAutonomyEvidencePack(proposal.id);
    expect(pack?.policy).toMatchObject({
      action: 'merge-main',
      allowed: true,
    });
  });

  it('evidence mode reruns verification instead of trusting an injected passing result', async () => {
    const diff = addFileDiff('docs/forged-verification.md', 'stored verification is not authority');
    const diffHash = hashDiff(diff);
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    fs.writeFileSync(path.join(tmpRepo, 'ashlr.verify.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'replace-detected',
      commands: [{
        id: 'merge-test',
        kind: 'test',
        cmd: ['node', '-e', 'process.exit(1)'],
        required: true,
        profiles: ['merge'],
      }],
    }), 'utf8');
    git(tmpRepo, ['add', 'ashlr.verify.json']);
    git(tmpRepo, ['commit', '-m', 'make verification fail']);
    git(tmpRepo, ['push', 'origin', 'main']);
    const failingBaseHead = git(tmpRepo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'forged stored verification',
      summary: 'A stored passing result must not bypass current verification.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'injected pass',
        ran: [{ kind: 'test', cmd: ['node', '-e', 'process.exit(0)'] }],
        baseBranch: 'main',
        baseHead: failingBaseHead,
        diffHash,
        verifiedAt: new Date().toISOString(),
        source: 'auto-merge',
      },
    });
    setStatus(proposal.id, 'pending');

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(baseHead).not.toBe(failingBaseHead);
    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/verification failed/);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.verifyResult).toMatchObject({ passed: false, source: 'auto-merge' });
  });

  it('evidence mode refuses handoff when protected remote base advanced without local fetch', async () => {
    const diff = addFileDiff('docs/stale-remote-evidence.md', 'stale remote evidence handoff');
    const diffHash = hashDiff(diff);
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'stale remote evidence handoff',
      summary: 'Refuse when origin/main moved after verification.',
      diff,
      diffHash,
      provenanceSig: signProvenance('local:qwen3-coder', 'local', diffHash),
      engineModel: 'local:qwen3-coder',
      engineTier: 'local',
      verifyResult: {
        passed: true,
        detail: 'command-bound verification passed before remote advanced',
        ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
        baseBranch: 'main',
        baseHead,
        diffHash,
      },
    });
    setStatus(proposal.id, 'pending');

    advanceRemoteMainWithoutFetching('REMOTE.md', 'remote changed after verification\n');
    expect(git(tmpRepo, ['rev-parse', 'main'])).toBe(baseHead);
    expect(git(tmpRepo, ['rev-parse', 'origin/main'])).toBe(baseHead);

    const result = await autoMergeProposal(proposal.id, evidenceCfg());

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.handoff).toBeUndefined();
    expect(result.reason).toMatch(/protected remote branch 'main' moved since verification/);
    expect(createPrMock).not.toHaveBeenCalled();
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('pending');
    expect(loaded?.remoteHandoff).toBeUndefined();
    expect(readAutonomyEvidencePack(proposal.id)).toBeNull();
  });

  it('reconciles a host-merged PR to applied only with positive merge evidence', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    if (process.platform !== 'win32') fs.chmodSync(path.join(tmpHome, '.ashlr'), 0o755);
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    const mergedAt = handoff!.createdAt;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt,
      mergeCommitOid: 'A'.repeat(40),
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r, getRemoteHandoffKeyDiagnostic() ?? undefined)
      .toEqual({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('applied');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'merged',
      mergedAt,
      mergeCommitOid: 'a'.repeat(40),
      reconciliation: {
        schemaVersion: 1,
        observedAt: expect.any(String),
        attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      detail: expect.stringContaining('remote PR merged'),
    });
    expect(loaded?.realizedMerge).toMatchObject({
      schemaVersion: 1,
      source: 'github-host',
      provider: 'github',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
      branch: handoff?.branch,
      base: handoff?.base,
      expectedHeadOid: handoff?.expectedHeadOid,
      mergeCommitOid: 'a'.repeat(40),
      mergedAt,
      reconciliation: expect.objectContaining({
        schemaVersion: 1,
        observedAt: expect.any(String),
        attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    });
    expect(canonicalRealizedMergeIdentity(loaded)).toEqual({
      source: 'github-host',
      repo: 'ashlrai/fixture',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
      mergeCommitOid: 'a'.repeat(40),
      key: JSON.stringify([
        'github-host',
        'ashlrai/fixture',
        'https://github.com/ashlrai/fixture/pull/123',
        'a'.repeat(40),
      ]),
    });
    expect(verifyRemoteHandoffReconciliation(proposal.id, tmpRepo, loaded!.remoteHandoff!)).toBe(true);
    expect(verifyRemoteHandoffReconciliation(proposal.id, tmpRepo, {
      ...loaded!.remoteHandoff!,
      branch: 'ashlr/merge/different-generation',
    })).toBe(false);
    expect(verifyRemoteHandoffReconciliation(proposal.id, tmpRepo, {
      ...loaded!.remoteHandoff!,
      createdAt: new Date(Date.parse(loaded!.remoteHandoff!.createdAt) - 1).toISOString(),
    })).toBe(false);
    const reconciliationKeyPath = process.platform === 'win32'
      ? path.join(tmpHome, '.ashlr', 'foundry', 'reconciliation', 'key')
      : path.join(tmpHome, '.ashlr', 'foundry', 'remote-handoff-reconciliation.key');
    const reconciliationKey = fs.lstatSync(reconciliationKeyPath);
    expect(reconciliationKey.isFile()).toBe(true);
    expect(reconciliationKey.size).toBe(32);
    if (process.platform !== 'win32') {
      expect(reconciliationKey.mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(path.join(tmpHome, '.ashlr')).mode & 0o777).toBe(0o700);
    }
    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'merged' && d.verdict === 'merged' &&
      d.labelBasis === 'realized-merge-v1')).toBe(true);
    expect(loaded?.realizedMergeFanoutVersion).toBe(3);
  }, 30_000);

  it('refuses a host merge reported before the awaiting handoff intent existed', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: new Date(Date.parse(handoff.createdAt) - 1).toISOString(),
      mergeCommitOid: 'a'.repeat(40),
      url: handoff.prUrl,
      headRefName: handoff.branch,
      headRefOid: handoff.expectedHeadOid,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge' },
    });
  }, 30_000);

  it('refuses terminal credit after the bounded reconciliation window expires', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    const expiredCreatedAt = new Date(
      Date.now() - MAX_REMOTE_HANDOFF_RECONCILIATION_LAG_MS - 60_000,
    ).toISOString();
    expect(updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, createdAt: expiredCreatedAt },
    })).toBe(true);
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: expiredCreatedAt,
      mergeCommitOid: 'a'.repeat(40),
      url: handoff.prUrl,
      headRefName: handoff.branch,
      headRefOid: handoff.expectedHeadOid,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  }, 30_000);

  it('does not split merge evidence from applied status when the proposal mutation lock is held', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff.branch,
      baseRefName: handoff.base,
    });
    const lock = acquireProposalMutationLock(proposal.id)!;

    try {
      expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    } finally {
      releaseProposalMutationLock(lock);
    }

    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff?.state).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff?.mergedAt).toBeUndefined();
  }, 30_000);

  it('holds the proposal lock while reading a closed host response', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(setStatus(proposal.id, 'applied', 'concurrent merge', undefined, undefined, {
        remoteHandoff: {
          ...handoff,
          state: 'merged',
          mergedAt: '2026-07-03T01:00:00Z',
          mergeCommitOid: 'c'.repeat(40),
        },
      })).toBe(false);
      return {
        state: 'CLOSED',
        closed: true,
        url: handoff.prUrl,
        headRefName: handoff.branch,
        baseRefName: handoff.base,
      };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 1, open: 0, unknown: 0 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'rejected',
      remoteHandoff: { state: 'closed' },
    });
  }, 30_000);

  it('holds the proposal lock while reading an open host response', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(setStatus(proposal.id, 'applied', 'concurrent merge', undefined, undefined, {
        remoteHandoff: {
          ...handoff,
          state: 'merged',
          mergedAt: '2026-07-03T01:00:00Z',
          mergeCommitOid: 'd'.repeat(40),
        },
      })).toBe(false);
      return {
        state: 'OPEN',
        url: handoff.prUrl,
        headRefName: handoff.branch,
        baseRefName: handoff.base,
      };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 1, unknown: 0 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge' },
    });
  }, 30_000);

  it('does not reject an awaiting handoff that already has authoritative merge evidence', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, mergedAt: '2026-07-03T01:00:00Z' },
    });
    viewPrMock.mockReturnValueOnce({
      state: 'CLOSED',
      closed: true,
      url: handoff.prUrl,
      headRefName: handoff.branch,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge', mergedAt: '2026-07-03T01:00:00Z' },
    });
  }, 30_000);

  it('blocks replacement handoff writes while the host read is in flight', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(updateProposalField(proposal.id, {
        remoteHandoff: {
          ...handoff,
          branch: 'ashlr/replacement-generation',
          prUrl: undefined,
        },
      })).toBe(false);
      return { state: 'OPEN', url: handoff.prUrl };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 1, unknown: 0 });
    expect(loadProposal(proposal.id)?.remoteHandoff).toMatchObject({
      branch: handoff.branch,
      state: 'awaiting-host-merge',
    });
    expect(loadProposal(proposal.id)?.remoteHandoff?.prUrl).toBe(handoff.prUrl);
  }, 30_000);

  it('blocks same-selector generation replacement while the host read is in flight', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(updateProposalField(proposal.id, {
        remoteHandoff: {
          ...handoff,
          createdAt: '2026-07-03T00:30:00.000Z',
          updatedAt: '2026-07-03T00:30:00.000Z',
        },
      })).toBe(false);
      return {
        state: 'MERGED',
        mergedAt: '2026-07-03T01:00:00Z',
        mergeCommitOid: 'e'.repeat(40),
        url: handoff.prUrl,
        headRefName: handoff.branch,
        baseRefName: handoff.base,
      };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { createdAt: handoff.createdAt, state: 'awaiting-host-merge' },
    });
  }, 30_000);

  it('keeps a sparse merged response awaiting when GitHub omits the merge time', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergeCommitOid: 'b'.repeat(40),
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff?.state).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff?.mergedAt).toBeUndefined();
  });

  it('does not terminally attribute a sparse read even when an earlier merge time was stored', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, mergedAt: '2026-07-03T01:00:00Z' },
    });
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergeCommitOid: 'b'.repeat(40),
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff.branch,
      baseRefName: handoff.base,
    });

    const result = reconcileRemoteHandoffs();

    expect(result).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
    expect(loadProposal(proposal.id)?.remoteHandoff?.mergedAt).toBe('2026-07-03T01:00:00Z');
  }, 30_000);

  it('keeps a sparse merged response awaiting when GitHub omits the merge commit OID', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      url: handoff.prUrl,
      headRefName: handoff.branch,
      headRefOid: handoff.expectedHeadOid,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge' },
    });
  });

  it('keeps a merged response awaiting when the observed base is missing', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: handoff.prUrl,
      headRefName: handoff.branch,
      headRefOid: handoff.expectedHeadOid,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('keeps a merged response awaiting when the observed branch is missing', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: handoff.prUrl,
      headRefOid: handoff.expectedHeadOid,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('fails closed when GitHub returns a merge time that conflicts with stored evidence', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, mergedAt: '2026-07-03T01:00:00Z' },
    });
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T02:00:00Z',
      url: handoff.prUrl,
      headRefName: handoff.branch,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { mergedAt: '2026-07-03T01:00:00Z' },
    });
  }, 30_000);

  it('fails closed when GitHub returns a merge OID that conflicts with stored evidence', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, mergeCommitOid: 'a'.repeat(40) },
    });
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergeCommitOid: 'b'.repeat(40),
      url: handoff.prUrl,
      headRefName: handoff.branch,
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { mergeCommitOid: 'a'.repeat(40) },
    });
  }, 30_000);

  it('rejects malformed GitHub mergedAt instead of persisting or trusting it', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    viewPrMock.mockReturnValueOnce({
      state: 'OPEN',
      mergedAt: '2026-02-30T01:00:00Z',
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 1, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff?.mergedAt).toBeUndefined();
  }, 30_000);

  it('strips a malformed mergedAt at the proposal persistence boundary', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;

    updateProposalField(proposal.id, {
      remoteHandoff: { ...handoff, mergedAt: 'not-a-host-timestamp' },
    });

    expect(loadProposal(proposal.id)?.remoteHandoff?.mergedAt).toBeUndefined();
  });

  it('reconciles a closed-unmerged host PR to rejected without claiming a merge', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    viewPrMock.mockReturnValueOnce({
      state: 'CLOSED',
      closed: true,
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 1, open: 0, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('rejected');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'closed',
      detail: expect.stringContaining('closed without merge'),
    });
    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'rejected' && d.verdict === 'rejected')).toBe(true);
    expect(listProposals({ status: 'applied' }).some((p) => p.id === proposal.id)).toBe(false);
  });

  it('leaves the proposal awaiting host merge when GitHub state is unavailable', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    viewPrMock.mockReturnValueOnce(null);

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
  });

  it('keeps an open host PR awaiting merge and refreshes the PR URL', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    expect(handoff?.branch).toBeTruthy();
    expect(handoff?.base).toBe('main');
    if (handoff) {
      const { prUrl: _prUrl, ...handoffWithoutUrl } = handoff;
      updateProposalField(proposal.id, { remoteHandoff: handoffWithoutUrl });
    }
    viewPrMock.mockReturnValueOnce({
      state: 'OPEN',
      closed: false,
      url: 'https://github.com/ashlrai/fixture/pull/124',
      headRefName: handoff?.branch,
      baseRefName: 'main',
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 1, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/124',
    });
  }, 30_000);

  it('does not advance when GitHub resolves a different branch/base than the handoff', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      url: 'https://github.com/ashlrai/fixture/pull/999',
      headRefName: 'somebody-elses-branch',
      baseRefName: 'main',
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
  });

  it('does not advance a terminal response that lacks PR identity evidence', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
  });

  it('does not advance a terminal response when the PR URL conflicts with the handoff', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      url: 'https://github.com/ashlrai/fixture/pull/999',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
    });
  });

  it('does not attribute a host merge when the PR head differs from the verified handoff commit', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: handoff.prUrl,
      headRefName: handoff.branch,
      headRefOid: 'b'.repeat(40),
      baseRefName: handoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'awaiting-host-merge',
      remoteHandoff: { state: 'awaiting-host-merge', expectedHeadOid: handoff.expectedHeadOid },
    });
  });

  it('quarantines a legacy handoff that has no expected PR head OID', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    const { expectedHeadOid: _expectedHeadOid, ...legacyHandoff } = handoff;
    expect(updateProposalField(proposal.id, { remoteHandoff: legacyHandoff })).toBe(true);
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      url: legacyHandoff.prUrl,
      headRefName: legacyHandoff.branch,
      headRefOid: 'b'.repeat(40),
      baseRefName: legacyHandoff.base,
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('refuses reconciliation when the proposal source contains a corrupt row', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const inboxDir = path.join(process.env.ASHLR_HOME!, 'inbox');
    fs.writeFileSync(path.join(inboxDir, 'corrupt.json'), '{not-json', 'utf8');
    viewPrMock.mockClear();

    const result = reconcileRemoteHandoffs();

    expect(result).toMatchObject({
      checked: 0,
      merged: 0,
      closed: 0,
      open: 0,
      unknown: 0,
      sourceQuality: {
        sourceState: 'degraded',
        sourcePresent: true,
        complete: false,
        stopReasons: ['invalid-file'],
        invalidFiles: 1,
      },
    });
    expect(viewPrMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('refuses reconciliation when the proposal directory changes during enumeration', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    let injected = false;
    _setProposalReadRaceHookForTest((point, inboxDir) => {
      if (point !== 'after-directory-scan' || injected) return;
      injected = true;
      fs.writeFileSync(path.join(inboxDir, 'late-entry.txt'), 'raced', 'utf8');
    });
    viewPrMock.mockClear();

    const result = reconcileRemoteHandoffs();

    expect(result).toMatchObject({
      checked: 0,
      merged: 0,
      closed: 0,
      open: 0,
      unknown: 0,
      sourceQuality: {
        sourceState: 'degraded',
        sourcePresent: true,
        complete: false,
        stopReasons: ['io-error'],
        unreadableFiles: 1,
      },
    });
    expect(viewPrMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('is idempotent after a terminal host merge reconciliation', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: handoff.createdAt,
      mergeCommitOid: 'a'.repeat(40),
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff.branch,
      headRefOid: handoff.expectedHeadOid,
      baseRefName: handoff.base,
    });

    const first = reconcileRemoteHandoffs();
    const second = reconcileRemoteHandoffs();

    expect(first.merged).toBe(1);
    expect(second).toEqual({ checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 });
    expect(loadProposal(proposal.id)?.status).toBe('applied');
  }, 60_000);
});
