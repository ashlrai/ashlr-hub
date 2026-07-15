/**
 * M411: reconcile a realized local merge from its durable signed intent before
 * current auto-merge gates, while rejecting any non-exact Git ancestry.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashDiff, signLocalMergeIntent } from '../src/core/foundry/provenance.js';
import { readDecisions } from '../src/core/fleet/decisions-ledger.js';
import { autoMergeProposal } from '../src/core/inbox/merge.js';
import { createProposal, loadProposal, updateProposalField } from '../src/core/inbox/store.js';
import { enroll, setKill, unenroll } from '../src/core/sandbox/policy.js';
import type { AshlrConfig, ProposalLocalMergeIntent } from '../src/core/types.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalAshlrHome = process.env.ASHLR_HOME;
const originalAllowAnyRepo = process.env.ASHLR_TEST_ALLOW_ANY_REPO;

let home: string;
let repo: string;

function git(args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function commitTree(tree: string, parents: string[], message: string): string {
  const args = ['-C', repo, 'commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  return execFileSync('git', args, {
    encoding: 'utf8',
    input: `${message}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function config(enabled: boolean): AshlrConfig {
  return {
    foundry: {
      autoMerge: {
        enabled,
        maxRisk: 'low',
        allowWithoutVerification: true,
      },
    },
  } as unknown as AshlrConfig;
}

type Ancestry = 'exact' | 'unrelated' | 'reversed-parents';

interface MergeFixture {
  proposalId: string;
  baseBeforeOid: string;
  proposalHeadOid: string;
  mergeCommitOid: string;
  intent: ProposalLocalMergeIntent;
}

function createInterruptedMerge(ancestry: Ancestry): MergeFixture {
  const diff = [
    'diff --git a/docs/m411.md b/docs/m411.md',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/docs/m411.md',
    '@@ -0,0 +1 @@',
    '+local merge reconciliation',
    '',
  ].join('\n');
  const proposal = createProposal({
    repo,
    origin: 'agent',
    kind: 'patch',
    title: 'M411 local merge reconciliation',
    summary: 'Recover an exact local merge after receipt persistence was interrupted',
    diff,
    diffHash: hashDiff(diff),
  });
  const proposalRepo = proposal.repo;
  expect(proposalRepo).toBe(repo);
  if (!proposalRepo) throw new Error('proposal fixture lost its canonical repository identity');
  const baseBeforeOid = git(['rev-parse', 'main']);
  const branch = `ashlr/merge/${proposal.id}`;

  git(['checkout', '-b', branch]);
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'm411.md'), 'local merge reconciliation\n', 'utf8');
  git(['add', 'docs/m411.md']);
  git(['commit', '-m', 'stage M411 proposal']);
  const proposalHeadOid = git(['rev-parse', 'HEAD']);
  const unsignedIntent = {
    schemaVersion: 1 as const,
    branch,
    base: 'main',
    baseBeforeOid,
    proposalHeadOid,
    diffHash: proposal.diffHash!,
    evidencePackDigest: 'e'.repeat(64),
    authorizationId: '1'.repeat(32),
    authorizedAt: new Date().toISOString(),
  };
  const intent: ProposalLocalMergeIntent = {
    ...unsignedIntent,
    attestation: signLocalMergeIntent(proposal.id, proposalRepo, unsignedIntent),
  };
  expect(intent.attestation).toMatch(/^[a-f0-9]{64}$/);
  expect(updateProposalField(proposal.id, {
    localMergeIntent: intent,
    verifyResult: {
      passed: true,
      baseBranch: 'main',
      baseHead: baseBeforeOid,
      diffHash: proposal.diffHash,
      verifiedAt: new Date().toISOString(),
      source: 'auto-merge',
    },
  })).toBe(true);

  let mergeCommitOid: string;
  if (ancestry === 'exact') {
    git(['checkout', 'main']);
    git(['merge', '--no-ff', '--no-edit', branch]);
    mergeCommitOid = git(['rev-parse', 'main']);
  } else {
    const tree = git(['rev-parse', `${proposalHeadOid}^{tree}`]);
    const parents = ancestry === 'unrelated'
      ? []
      : [proposalHeadOid, baseBeforeOid];
    mergeCommitOid = commitTree(tree, parents, `M411 ${ancestry}`);
    git(['update-ref', 'refs/heads/main', mergeCommitOid, baseBeforeOid]);
    git(['checkout', 'main']);
  }

  const interrupted = loadProposal(proposal.id)!;
  expect(interrupted.status).toBe('pending');
  expect(interrupted.localMergeIntent).toEqual(intent);
  expect(interrupted.realizedMerge).toBeUndefined();
  return { proposalId: proposal.id, baseBeforeOid, proposalHeadOid, mergeCommitOid, intent };
}

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m411-home-')));
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m411-repo-')));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ASHLR_HOME = path.join(home, '.ashlr');
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  expect(setKill(false).ok).toBe(true);

  execFileSync('git', ['init', '--initial-branch=main', repo], { stdio: 'pipe' });
  git(['config', 'user.email', 'test@ashlr.test']);
  git(['config', 'user.name', 'Ashlr Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n', 'utf8');
  git(['add', 'README.md']);
  git(['commit', '-m', 'init']);
  expect(enroll(repo).ok).toBe(true);
});

afterEach(() => {
  try { setKill(false); } catch { /* best effort */ }
  try { unenroll(repo); } catch { /* best effort */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = originalAshlrHome;
  if (originalAllowAnyRepo === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = originalAllowAnyRepo;
});

describe('M411 local merge reconciliation', () => {
  it.each([
    { gate: 'auto-merge disabled', enabled: false, killArmed: false },
    { gate: 'kill armed', enabled: true, killArmed: true },
  ])('records an exact interrupted merge before the $gate gate', async ({ enabled, killArmed }) => {
    const fixture = createInterruptedMerge('exact');
    const parents = git(['rev-list', '--parents', '-n', '1', fixture.mergeCommitOid]).split(/\s+/).slice(1);
    expect(parents).toEqual([fixture.baseBeforeOid, fixture.proposalHeadOid]);
    setKill(killArmed);

    const result = await autoMergeProposal(fixture.proposalId, config(enabled));

    expect(result).toMatchObject({ ok: true, merged: true });
    expect(result.reason).toMatch(/reconciled realized local merge/i);
    const applied = loadProposal(fixture.proposalId)!;
    expect(applied.status).toBe('applied');
    expect(applied.realizedMerge).toMatchObject({
      schemaVersion: 1,
      source: 'local-default-branch',
      base: 'main',
      baseBeforeOid: fixture.baseBeforeOid,
      proposalHeadOid: fixture.proposalHeadOid,
      mergeCommitOid: fixture.mergeCommitOid,
      proposalId: fixture.proposalId,
      diffHash: fixture.intent.diffHash,
      intentAttestation: fixture.intent.attestation,
      observedAt: expect.any(String),
      attestation: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(applied.realizedMergeFanoutVersion).toBeUndefined();
    expect(readDecisions({ proposalId: fixture.proposalId, requireComplete: true })
      .filter((decision) => decision.action === 'merged')).toHaveLength(0);
    expect(git(['rev-parse', 'main'])).toBe(fixture.mergeCommitOid);
  }, 15_000);

  it('completes realized-merge fanout when reconciliation retains live authority', async () => {
    const fixture = createInterruptedMerge('exact');

    const result = await autoMergeProposal(fixture.proposalId, config(true));

    expect(result).toMatchObject({ ok: true, merged: true });
    const applied = loadProposal(fixture.proposalId)!;
    expect(applied.realizedMergeFanoutVersion).toBe(3);
    expect(readDecisions({ proposalId: fixture.proposalId, requireComplete: true })
      .filter((decision) => decision.action === 'merged' && decision.verdict === 'merged'))
      .toHaveLength(1);
  });

  it('finds the exact interrupted merge after the base advances again', async () => {
    const fixture = createInterruptedMerge('exact');
    fs.writeFileSync(path.join(repo, 'after-merge.txt'), 'later base work\n', 'utf8');
    git(['add', 'after-merge.txt']);
    git(['commit', '-m', 'advance base after interrupted receipt']);
    const advancedHead = git(['rev-parse', 'main']);

    const result = await autoMergeProposal(fixture.proposalId, config(false));

    expect(result).toMatchObject({ ok: true, merged: true });
    expect(loadProposal(fixture.proposalId)?.realizedMerge).toMatchObject({
      mergeCommitOid: fixture.mergeCommitOid,
      baseBeforeOid: fixture.baseBeforeOid,
      proposalHeadOid: fixture.proposalHeadOid,
    });
    expect(git(['rev-parse', 'main'])).toBe(advancedHead);
  });

  it('refuses an exact-looking merge beyond the bounded first-parent window', async () => {
    const fixture = createInterruptedMerge('exact');
    const tree = git(['rev-parse', `${fixture.mergeCommitOid}^{tree}`]);
    let head = fixture.mergeCommitOid;
    for (let index = 0; index < 256; index++) {
      head = commitTree(tree, [head], `post-merge advance ${index}`);
    }
    git(['update-ref', 'refs/heads/main', head, fixture.mergeCommitOid]);

    const result = await autoMergeProposal(fixture.proposalId, config(false));

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/auto-merge disabled/i);
    expect(loadProposal(fixture.proposalId)?.realizedMerge).toBeUndefined();
    expect(git(['rev-parse', 'main'])).toBe(head);
  }, 45_000);

  it.each([
    { ancestry: 'unrelated' as const, expectedParents: 0 },
    { ancestry: 'reversed-parents' as const, expectedParents: 2 },
  ])('does not reconcile $ancestry ancestry', async ({ ancestry, expectedParents }) => {
    const fixture = createInterruptedMerge(ancestry);
    const parents = git(['rev-list', '--parents', '-n', '1', fixture.mergeCommitOid]).split(/\s+/).slice(1);
    expect(parents).toHaveLength(expectedParents);
    expect(parents).not.toEqual([fixture.baseBeforeOid, fixture.proposalHeadOid]);

    const result = await autoMergeProposal(fixture.proposalId, config(false));

    expect(result).toMatchObject({ ok: false, merged: false });
    expect(result.reason).toMatch(/auto-merge disabled/i);
    expect(git(['rev-parse', 'main'])).toBe(fixture.mergeCommitOid);
    const pending = loadProposal(fixture.proposalId)!;
    expect(pending.status).toBe('pending');
    expect(pending.localMergeIntent).toEqual(fixture.intent);
    expect(pending.realizedMerge).toBeUndefined();
  });
});
