/**
 * M419 - remote handoff intent and fence ordering.
 *
 * The authenticated intent and exact reconciliation selector must be durable
 * before staging push. The outward fence then remains held until the host
 * result is durably attached, including mid-tier review PRs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const {
  branchProtectionMock,
  createPrMock,
  evidencePersistHookMock,
  hostAutoMergeMock,
  originAuthorityMock,
  stagingPushHookMock,
  viewPrMock,
} = vi.hoisted(() => ({
  branchProtectionMock: vi.fn(),
  createPrMock: vi.fn(),
  evidencePersistHookMock: vi.fn(),
  hostAutoMergeMock: vi.fn(),
  originAuthorityMock: vi.fn(),
  stagingPushHookMock: vi.fn(),
  viewPrMock: vi.fn(),
}));

vi.mock('../src/core/autonomy/evidence-pack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/autonomy/evidence-pack.js')>();
  return {
    ...actual,
    persistAutonomyEvidencePack(
      pack: Parameters<typeof actual.persistAutonomyEvidencePack>[0],
    ) {
      const persisted = actual.persistAutonomyEvidencePack(pack);
      if (persisted) evidencePersistHookMock(pack.proposal.id, actual.evidencePath(pack.proposal.id));
      return persisted;
    },
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      const commandArgs = Array.isArray(args[1]) ? args[1].map(String) : [];
      if (args[0] === 'gh' && commandArgs[0] === 'pr' && commandArgs[1] === 'merge') {
        hostAutoMergeMock(commandArgs);
      }
      if (args[0] === 'git' && commandArgs.includes('push') && commandArgs.some((arg) => (
        arg.includes('refs/heads/ashlr/merge/')
      ))) {
        stagingPushHookMock(commandArgs);
      }
      return actual.execFileSync(...args);
    },
  };
});

vi.mock('../src/core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/git.js')>();
  return {
    ...actual,
    getRemoteOrg: () => ({ remote: 'https://github.com/ashlrai/fixture.git', org: 'ashlrai' }),
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
import {
  readAutonomyEvidencePack,
  sealAutonomyEvidencePackV3,
  verifyAutonomyEvidencePackV3,
  type AutonomyEvidencePackLegacy,
} from '../src/core/autonomy/evidence-pack.js';
import { createProposal, inboxDir, loadProposal, setStatus } from '../src/core/inbox/store.js';
import {
  canonicalEvidencePackJsonV3,
  hashDiff,
  signProvenance,
  verifyLocalMergeIntent,
} from '../src/core/foundry/provenance.js';
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
    stdout: JSON.stringify({
      nonce: request.nonce,
      operation: request.operation,
      ok: true,
      reason,
    }),
  };
};

function useNativePrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined);
}

function useSemanticPrivateStorageRunner(): void {
  _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
    runner: semanticPrivateStorageRunner,
  });
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
    '+durable remote handoff intent',
    '',
  ].join('\n');
}

function config(): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      autoMerge: {
        enabled: true,
        midToBranch: true,
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

function protectionAttestation(branch = 'main', ruleId = 'BPR_fixture') {
  return {
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
    policySnapshot: {
      ...TEST_POLICY_SNAPSHOT,
      classic: { ...TEST_POLICY_SNAPSHOT.classic, ruleId },
    },
    detail: 'Live branch protection confirmed with required checks',
  };
}

function makeProposal(tier: EngineTier, filename: string): Proposal {
  const diff = diffFor(filename);
  const diffHash = hashDiff(diff);
  const engineModel = tier === 'frontier' ? 'codex:gpt-5.5' : 'hermes:hermes-3-llama-3.1-70b';
  const proposal = createProposal({
    repo: tmpRepo,
    origin: 'agent',
    kind: 'patch',
    title: `${tier} remote handoff`,
    summary: 'Exercise pre-effect handoff ordering.',
    diff,
    diffHash,
    provenanceSig: signProvenance(engineModel, tier, diffHash),
    engineModel,
    engineTier: tier,
  });
  expect(setStatus(proposal.id, 'approved')).toBe(true);
  return proposal;
}

function expectDurableIntentAtPush(proposal: Proposal): void {
  const persisted = loadProposal(proposal.id);
  const evidence = readAutonomyEvidencePack(proposal.id);
  expect(evidence?.version).toBe(3);
  if (!evidence || evidence.version !== 3) throw new Error('expected persisted evidence pack v3');
  expect(verifyAutonomyEvidencePackV3(evidence)).toMatchObject({ ok: true });
  expect(persisted).toMatchObject({
    status: 'awaiting-host-merge',
    remoteHandoff: {
      state: 'awaiting-host-merge',
      branch: `ashlr/merge/${proposal.id}`,
      base: 'main',
      expectedHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      authority: {
        provider: 'github',
        nameWithOwner: 'ashlrai/fixture',
        pushAuthorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      intentAttestation: expect.stringMatching(/^[0-9a-f]{64}$/),
      detail: expect.stringContaining('signed remote handoff intent persisted'),
    },
    localMergeIntent: {
      branch: `ashlr/merge/${proposal.id}`,
      base: 'main',
      proposalHeadOid: expect.stringMatching(/^[0-9a-f]{40}$/),
      remoteAuthority: {
        provider: 'github',
        nameWithOwner: 'ashlrai/fixture',
        pushAuthorityDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      attestation: expect.stringMatching(/^[0-9a-f]{64}$/),
    },
  });
  expect(persisted?.repo && persisted.localMergeIntent &&
    verifyLocalMergeIntent(proposal.id, persisted.repo, persisted.localMergeIntent)).toBe(true);
  expect(persisted?.localMergeIntent?.proposalHeadOid).toBe(persisted?.remoteHandoff?.expectedHeadOid);
  expect(persisted?.localMergeIntent?.evidencePackDigest).toBe(evidence.sealedPackDigest);
  expect(persisted?.localMergeIntent?.remoteAuthority).toEqual(persisted?.remoteHandoff?.authority);
  expect(persisted?.localMergeIntent?.attestation).toBe(persisted?.remoteHandoff?.intentAttestation);
}

function afterEvidencePersist(mutate: (id: string, file: string) => void): void {
  evidencePersistHookMock.mockImplementationOnce(mutate);
}

beforeEach(() => {
  useNativePrivateStorageRunner();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m419-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m419-repo-'));
  bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m419-bare-'));
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

  stagingPushHookMock.mockReset();
  evidencePersistHookMock.mockReset();
  hostAutoMergeMock.mockReset();
  originAuthorityMock.mockReset();
  originAuthorityMock.mockReturnValue({
    nameWithOwner: 'ashlrai/fixture',
    fetchUrls: [bareRepo],
    pushUrls: [bareRepo],
    pushUrl: bareRepo,
  });
  branchProtectionMock.mockReset();
  branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') =>
    protectionAttestation(branch));
  viewPrMock.mockReset();
  viewPrMock.mockReturnValue(null);
  createPrMock.mockReset();
  createPrMock.mockImplementation(async (_repo: string, input: { head: string; base?: string }) => {
    const url = 'https://github.com/ashlrai/fixture/pull/419';
    viewPrMock.mockReturnValueOnce({
      url,
      state: 'OPEN',
      headRefName: input.head,
      headRefOid: git(tmpRepo, ['rev-parse', `refs/heads/${input.head}`]),
      baseRefName: input.base ?? 'main',
    });
    return { ok: true, url, detail: 'PR created' };
  });
}, 60_000);

afterEach(() => {
  try {
    try { setKill(false); } catch { /* ignore */ }
    try { unenroll(tmpRepo); } catch { /* ignore */ }
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(bareRepo, { recursive: true, force: true });
  } finally {
    useNativePrivateStorageRunner();
    process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = originalAshlrHome;
    if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
  }
});

describe('M419 remote handoff intent', { timeout: 60_000 }, () => {
  it('persists authenticated to-main intent before staging push', async () => {
    const proposal = makeProposal('frontier', 'docs/frontier-intent.md');
    stagingPushHookMock.mockImplementationOnce(() => expectDurableIntentAtPush(proposal));

    const result = await autoMergeProposal(proposal.id, config());

    expect(result.ok, result.reason).toBe(true);
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true });
    expect(stagingPushHookMock).toHaveBeenCalledTimes(1);
    expect(hostAutoMergeMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it('persists authenticated mid-tier handoff intent before staging push', async () => {
    const proposal = makeProposal('mid', 'docs/mid-intent.md');
    stagingPushHookMock.mockImplementationOnce(() => expectDurableIntentAtPush(proposal));

    const result = await autoMergeProposal(proposal.id, config());

    expect(result.ok, result.reason).toBe(true);
    expect(result).toMatchObject({ ok: true, merged: false, handoff: true, branched: true });
    expect(stagingPushHookMock).toHaveBeenCalledTimes(1);
    expect(loadProposal(proposal.id)?.status).toBe('awaiting-host-merge');
  });

  it.each([
    ['missing', (_id: string, file: string) => fs.unlinkSync(file)],
    ['tampered seal', (_id: string, file: string) => {
      const pack = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      pack['sealedPackDigest'] = '0'.repeat(64);
      fs.writeFileSync(file, `${canonicalEvidencePackJsonV3(pack)}\n`, { mode: 0o600 });
    }],
    ['different valid seal', (_id: string, file: string) => {
      const pack = readAutonomyEvidencePack(path.basename(file, '.json'));
      if (!pack || pack.version !== 3) throw new Error('expected signed v3 fixture');
      const {
        payloadDigest: _payloadDigest,
        signatureAlgorithm: _signatureAlgorithm,
        signingKeyId: _signingKeyId,
        signature: _signature,
        sealedPackDigest: _sealedPackDigest,
        ...payload
      } = pack;
      const replacement = sealAutonomyEvidencePackV3({
        ...payload,
        version: 2,
        generatedAt: new Date(Date.parse(pack.generatedAt) + 1_000).toISOString(),
      } as AutonomyEvidencePackLegacy);
      if (!replacement) throw new Error('expected replacement signed v3 fixture');
      fs.writeFileSync(file, `${canonicalEvidencePackJsonV3(replacement)}\n`, { mode: 0o600 });
    }],
  ] as const)('refuses before staging when persisted v3 evidence is %s', async (_label, mutate) => {
    const proposal = makeProposal('frontier', `docs/${_label.replaceAll(' ', '-')}-v3-evidence.md`);
    afterEvidencePersist(mutate);

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/evidence pack (could not be reread|changed after persistence)/i);
    expect(stagingPushHookMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
    expect(loadProposal(proposal.id)?.localMergeIntent).toBeUndefined();
    expect(git(tmpRepo, ['branch', '--list', `ashlr/merge/${proposal.id}`])).toBe('');
  });

  it('refuses before staging when the live proposal identity changes after evidence persistence', async () => {
    const proposal = makeProposal('frontier', 'docs/proposal-identity-drift.md');
    afterEvidencePersist((id) => {
      const file = path.join(inboxDir(), `${id}.json`);
      const row = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      row['origin'] = 'manual';
      fs.writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`, { mode: 0o600 });
    });

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/no longer matches the live proposal/i);
    expect(stagingPushHookMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['branch', '--list', `ashlr/merge/${proposal.id}`])).toBe('');
  });

  it('refuses before staging when the safe remote policy digest changes after persistence', async () => {
    const proposal = makeProposal('frontier', 'docs/remote-policy-drift.md');
    afterEvidencePersist(() => {
      branchProtectionMock.mockImplementation(async (_repo: string, branch = 'main') =>
        protectionAttestation(branch, 'BPR_drifted'));
    });

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/branch protection changed after signed evidence persistence/i);
    expect(stagingPushHookMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['branch', '--list', `ashlr/merge/${proposal.id}`])).toBe('');
  });

  it('refuses before staging when the protected remote base moves after persistence', async () => {
    const proposal = makeProposal('frontier', 'docs/remote-base-drift.md');
    afterEvidencePersist(() => {
      const clone = path.join(tmpHome, 'remote-advance');
      execFileSync('git', ['clone', '--branch', 'main', bareRepo, clone], { stdio: 'pipe' });
      git(clone, ['config', 'user.email', 'test@ashlr.test']);
      git(clone, ['config', 'user.name', 'Ashlr Test']);
      fs.writeFileSync(path.join(clone, 'REMOTE.md'), '# advanced\n', 'utf8');
      git(clone, ['add', 'REMOTE.md']);
      git(clone, ['commit', '-m', 'advance remote']);
      git(clone, ['push', 'origin', 'main']);
    });

    const result = await autoMergeProposal(proposal.id, config());

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/protected remote branch 'main' moved after signed evidence persistence/i);
    expect(stagingPushHookMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
    expect(git(tmpRepo, ['branch', '--list', `ashlr/merge/${proposal.id}`])).toBe('');
  });

  it('reports non-quiescence while PR creation is in flight and persists the receipt before release', async () => {
    const proposal = makeProposal('frontier', 'docs/in-flight-pause.md');
    let resolveCreate!: (value: { ok: true; url: string; detail: string }) => void;
    const createStarted = new Promise<void>((resolve) => {
      createPrMock.mockImplementationOnce(async (_repo: string, input: { head: string; base?: string }) => {
        const url = 'https://github.com/ashlrai/fixture/pull/420';
        viewPrMock.mockReturnValueOnce({
          url,
          state: 'OPEN',
          headRefName: input.head,
          headRefOid: git(tmpRepo, ['rev-parse', `refs/heads/${input.head}`]),
          baseRefName: input.base ?? 'main',
        });
        resolve();
        return new Promise((finish) => { resolveCreate = finish; });
      });
    });

    const merging = autoMergeProposal(proposal.id, config());
    await createStarted;
    const paused = setKill(true, { waitMs: 25 });

    expect(paused).toMatchObject({ ok: false, quiesced: false });
    expect(paused.reason).toMatch(/has not quiesced/);
    expectDurableIntentAtPush(proposal);

    resolveCreate({
      ok: true,
      url: 'https://github.com/ashlrai/fixture/pull/420',
      detail: 'PR created',
    });
    const result = await merging;

    expect(result).toMatchObject({
      ok: true,
      merged: false,
      handoff: true,
      prUrl: 'https://github.com/ashlrai/fixture/pull/420',
    });
    expect(loadProposal(proposal.id)?.remoteHandoff).toMatchObject({
      prUrl: 'https://github.com/ashlrai/fixture/pull/420',
      detail: expect.stringContaining('PR opened'),
    });
  });
});
