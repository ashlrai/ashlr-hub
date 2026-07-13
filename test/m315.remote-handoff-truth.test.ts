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

const { createPrMock, viewPrMock, branchProtectionMock } = vi.hoisted(() => ({
  createPrMock: vi.fn(),
  viewPrMock: vi.fn(),
  branchProtectionMock: vi.fn(),
}));

vi.mock('../src/core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/git.js')>();
  return {
    ...actual,
    getRemoteOrg: (repoPath: string) => ({
      remote: 'https://github.com/ashlrai/fixture.git',
      org: 'ashlrai',
    }),
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
import { readAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { reconcileRemoteHandoffs } from '../src/core/inbox/remote-handoff.js';
import {
  getRemoteHandoffKeyDiagnostic,
  verifyRemoteHandoffReconciliation,
} from '../src/core/inbox/remote-handoff-attestation.js';
import { createProposal, listProposals, loadProposal, setStatus, updateProposalField } from '../src/core/inbox/store.js';
import { acquireProposalMutationLock, releaseProposalMutationLock } from '../src/core/inbox/proposal-mutation-lock.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { enroll, setKill, unenroll } from '../src/core/sandbox/policy.js';
import type { AshlrConfig } from '../src/core/types.js';

const origHome = process.env.HOME;
const origAshlrHome = process.env.ASHLR_HOME;
const origAllowAny = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
let tmpHome: string;
let tmpRepo: string;
let bareRepo: string;

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

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-repo-'));
  bareRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m315-bare-'));
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
  initRepo(tmpRepo);
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
    detail: 'Live branch protection confirmed with required checks',
  }));
  execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });
  git(tmpRepo, ['remote', 'add', 'origin', bareRepo]);
  git(tmpRepo, ['push', '-u', 'origin', 'main']);
  git(tmpRepo, ['fetch', 'origin']);
  git(tmpRepo, ['remote', 'set-head', 'origin', 'main']);
  enroll(tmpRepo);
  createPrMock.mockReset();
  createPrMock.mockResolvedValue({
    ok: true,
    url: 'https://github.com/ashlrai/fixture/pull/123',
    detail: 'PR created',
  });
  viewPrMock.mockReset();
});

afterEach(() => {
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  try { setKill(false); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  fs.rmSync(bareRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = origAshlrHome;
  if (origAllowAny === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = origAllowAny;
});

describe('M315 remote PR handoff truth', () => {
  async function createRemoteHandoffProposal() {
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

    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('awaiting-host-merge');
    expect(loaded?.remoteHandoff).toMatchObject({
      provider: 'github',
      state: 'awaiting-host-merge',
      prUrl: 'https://github.com/ashlrai/fixture/pull/123',
      base: 'main',
    });
    expect(listProposals({ status: 'pending' }).some((p) => p.id === proposal.id)).toBe(false);
    expect(listProposals({ status: 'applied' }).some((p) => p.id === proposal.id)).toBe(false);

    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'handoff')).toBe(true);
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
    expect(branchProtectionMock).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce({
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
        detail: 'Live branch protection confirmed with required checks',
      })
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
    expect(result.reason).toMatch(/live branch protection changed before remote handoff/);
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
      detail: 'Live branch protection confirmed with required checks',
    };
    branchProtectionMock
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
    expect(branchProtectionMock).toHaveBeenCalledTimes(3);
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
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
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
      mergedAt: '2026-07-03T01:00:00Z',
      mergeCommitOid: 'a'.repeat(40),
      reconciliation: {
        schemaVersion: 1,
        observedAt: expect.any(String),
        attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      detail: expect.stringContaining('remote PR merged'),
    });
    expect(verifyRemoteHandoffReconciliation(proposal.id, tmpRepo, loaded!.remoteHandoff!)).toBe(true);
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
    expect(decisions.some((d) => d.action === 'merged' && d.verdict === 'applied')).toBe(true);
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

  it('does not let a stale closed response overwrite a concurrent merged transition', async () => {
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
      })).toBe(true);
      return {
        state: 'CLOSED',
        closed: true,
        url: handoff.prUrl,
        headRefName: handoff.branch,
        baseRefName: handoff.base,
      };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'applied',
      remoteHandoff: { state: 'merged', mergeCommitOid: 'c'.repeat(40) },
    });
  }, 30_000);

  it('does not let a stale open response replace a concurrent merged transition', async () => {
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
      })).toBe(true);
      return {
        state: 'OPEN',
        url: handoff.prUrl,
        headRefName: handoff.branch,
        baseRefName: handoff.base,
      };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)).toMatchObject({
      status: 'applied',
      remoteHandoff: { state: 'merged', mergeCommitOid: 'd'.repeat(40) },
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

  it('does not attach a sparse stale open response to a replacement handoff', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(updateProposalField(proposal.id, {
        remoteHandoff: {
          ...handoff,
          branch: 'ashlr/replacement-generation',
          prUrl: undefined,
        },
      })).toBe(true);
      return { state: 'OPEN', url: handoff.prUrl };
    });

    expect(reconcileRemoteHandoffs()).toEqual({ checked: 1, merged: 0, closed: 0, open: 0, unknown: 1 });
    expect(loadProposal(proposal.id)?.remoteHandoff).toMatchObject({
      branch: 'ashlr/replacement-generation',
      state: 'awaiting-host-merge',
    });
    expect(loadProposal(proposal.id)?.remoteHandoff?.prUrl).toBeUndefined();
  }, 30_000);

  it('does not apply a stale terminal response to a same-selector replacement generation', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    const handoff = loadProposal(proposal.id)!.remoteHandoff!;
    viewPrMock.mockImplementationOnce(() => {
      expect(updateProposalField(proposal.id, {
        remoteHandoff: {
          ...handoff,
          createdAt: '2026-07-03T00:30:00.000Z',
          updatedAt: '2026-07-03T00:30:00.000Z',
        },
      })).toBe(true);
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
      remoteHandoff: { createdAt: '2026-07-03T00:30:00.000Z', state: 'awaiting-host-merge' },
    });
  }, 30_000);

  it('does not fabricate mergedAt when GitHub reports merged state without a merge time', async () => {
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

    expect(r).toEqual({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('applied');
    expect(loaded?.remoteHandoff?.state).toBe('merged');
    expect(loaded?.remoteHandoff?.mergedAt).toBeUndefined();
    expect(loaded?.remoteHandoff?.detail).not.toContain(' at ');
  });

  it('preserves an earlier host merge time when a later GitHub read omits it', async () => {
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

    expect(result.merged).toBe(1);
    expect(loadProposal(proposal.id)?.remoteHandoff?.mergedAt).toBe('2026-07-03T01:00:00Z');
  }, 30_000);

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

  it('is idempotent after a terminal host merge reconciliation', async () => {
    const { proposal } = await createRemoteHandoffProposal();
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      url: 'https://github.com/ashlrai/fixture/pull/123',
    });

    const first = reconcileRemoteHandoffs();
    const second = reconcileRemoteHandoffs();

    expect(first.merged).toBe(1);
    expect(second).toEqual({ checked: 0, merged: 0, closed: 0, open: 0, unknown: 0 });
    expect(loadProposal(proposal.id)?.status).toBe('applied');
  });
});
