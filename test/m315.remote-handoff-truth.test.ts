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

const { createPrMock, viewPrMock } = vi.hoisted(() => ({
  createPrMock: vi.fn(),
  viewPrMock: vi.fn(),
}));

vi.mock('../src/core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/git.js')>();
  return {
    ...actual,
    getRemoteOrg: (repoPath: string) => ({
      remote: `https://github.com/ashlrai/${path.basename(repoPath)}.git`,
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
  };
});

import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { readAutonomyEvidencePack } from '../src/core/autonomy/evidence-pack.js';
import { reconcileRemoteHandoffs } from '../src/core/inbox/remote-handoff.js';
import { createProposal, listProposals, loadProposal, setStatus, updateProposalField } from '../src/core/inbox/store.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { hashDiff, signProvenance } from '../src/core/foundry/provenance.js';
import { enroll, setKill, unenroll } from '../src/core/sandbox/policy.js';
import type { AshlrConfig } from '../src/core/types.js';

const origHome = process.env.HOME;
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
  git(dir, ['add', 'README.md']);
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
          requiredChecks: ['ci/test'],
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
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  setKill(false);
  initRepo(tmpRepo);
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
  });

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
      verifiedAt: '2026-07-03T00:00:00.000Z',
      source: 'auto-merge-preflight',
      commandKinds: ['test'],
    });
    expect(pack?.policy).toMatchObject({
      action: 'merge-main',
      allowed: true,
    });
  });

  it('evidence mode refuses handoff when stored verification lacks freshness metadata', async () => {
    const diff = addFileDiff('docs/evidence-legacy.md', 'legacy evidence without freshness');
    const diffHash = hashDiff(diff);
    const baseHead = git(tmpRepo, ['rev-parse', 'main']);
    const proposal = createProposal({
      repo: tmpRepo,
      origin: 'agent',
      kind: 'patch',
      title: 'legacy evidence handoff',
      summary: 'Refuse evidence handoff when verification source/timestamp is missing.',
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

    expect(result.ok).toBe(false);
    expect(result.merged).toBe(false);
    expect(result.handoff).toBeUndefined();
    expect(result.reason).toMatch(/verification freshness metadata/);
    expect(createPrMock).not.toHaveBeenCalled();
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('pending');
    expect(loaded?.remoteHandoff).toBeUndefined();
    const pack = readAutonomyEvidencePack(proposal.id);
    expect(pack?.policy).toMatchObject({
      action: 'escalate-human',
      allowed: false,
    });
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
    const handoff = loadProposal(proposal.id)?.remoteHandoff;
    viewPrMock.mockReturnValueOnce({
      state: 'MERGED',
      mergedAt: '2026-07-03T01:00:00Z',
      url: 'https://github.com/ashlrai/fixture/pull/123',
      headRefName: handoff?.branch,
      baseRefName: handoff?.base,
    });

    const r = reconcileRemoteHandoffs();

    expect(r).toEqual({ checked: 1, merged: 1, closed: 0, open: 0, unknown: 0 });
    const loaded = loadProposal(proposal.id);
    expect(loaded?.status).toBe('applied');
    expect(loaded?.remoteHandoff).toMatchObject({
      state: 'merged',
      detail: expect.stringContaining('remote PR merged'),
    });
    const decisions = readDecisions({ proposalId: proposal.id });
    expect(decisions.some((d) => d.action === 'merged' && d.verdict === 'applied')).toBe(true);
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
  });

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
