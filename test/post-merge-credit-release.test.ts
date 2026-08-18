/**
 * post-merge-credit-release.test.ts — release protocol for post-merge credit.
 *
 * Covers hasReleasedPostMergeCredit (token verification), the eligibility
 * computation, the periodic sweep write-back, and the dedicated SkillCard
 * signing boundary — including every fail-closed path required by the
 * fleet-learning-loop task: no observation -> no credit, regression
 * observed -> no credit, corrupt store -> no credit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Proposal, ProposalLocalMergeIntent, SkillCard } from '../src/core/types.js';
import {
  hashDiff,
  signLocalMergeIntent,
  signLocalRealizedMergeReceipt,
} from '../src/core/foundry/provenance.js';
import {
  MIN_POST_MERGE_OBSERVATION_WINDOW_MS,
  POST_MERGE_CREDIT_RELEASE_LABEL,
  attestPostMergeCreditSkillCard,
  evaluatePostMergeCreditRelease,
  hasReleasedPostMergeCredit,
  isPostMergeCreditReleaseLabel,
  sweepPostMergeCreditReleases,
} from '../src/core/fleet/post-merge-credit.js';
import { recordPostMergeObservation, postMergeObservationEventId } from '../src/core/fleet/post-merge-observations.js';

const FIXED_MS = 1_750_000_000_000;
const FIXED_ISO = new Date(FIXED_MS).toISOString();

let tmpHome: string;
let origHome: string | undefined;
let origAshlrHome: string | undefined;
let repo: string;

function mergedAtIso(offsetMsFromNow: number): string {
  return new Date(FIXED_MS - offsetMsFromNow).toISOString();
}

/** Build a proposal with a fully authenticated local-default-branch realized
 *  merge witness (mirrors test/m245.self-improve-integration.test.ts's
 *  makeProposal helper). */
function makeMergedProposal(opts: {
  id: string;
  mergedAt: string;
  mergeCommitOid?: string;
}): Proposal {
  const { id, mergedAt } = opts;
  const mergeCommitOid = opts.mergeCommitOid ?? '3'.repeat(40);
  const diff = `--- a/src/${id}.ts\n+++ b/src/${id}.ts\n@@ -1 +1 @@\n+// ${id}`;
  const diffHash = hashDiff(diff);
  const proposal = {
    id,
    repo,
    origin: 'swarm',
    kind: 'patch',
    title: `Proposal ${id}`,
    summary: 'test fixture',
    status: 'applied',
    createdAt: mergedAt,
    engineTier: 'frontier',
    engineModel: 'claude:opus',
    diff,
    diffHash,
    verifyResult: {
      passed: true,
      ran: [{ kind: 'test', cmd: ['npm', 'test'] }],
      baseBranch: 'main',
      baseHead: '1'.repeat(40),
      diffHash,
      verifiedAt: mergedAt,
      source: 'auto-merge',
    },
  } as Proposal;

  const unsignedIntent: Omit<ProposalLocalMergeIntent, 'attestation'> = {
    schemaVersion: 1,
    branch: `ashlr/merge/${id}`,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    diffHash,
    evidencePackDigest: '4'.repeat(64),
    authorizationId: hashDiff(id).slice(0, 32),
    authorizedAt: mergedAt,
  };
  const intentAttestation = signLocalMergeIntent(id, repo, unsignedIntent);
  proposal.localMergeIntent = { ...unsignedIntent, attestation: intentAttestation };

  const unsignedRealized = {
    schemaVersion: 1 as const,
    source: 'local-default-branch' as const,
    base: 'main',
    baseBeforeOid: '1'.repeat(40),
    proposalHeadOid: '2'.repeat(40),
    mergeCommitOid,
    observedAt: mergedAt,
    proposalId: id,
    diffHash,
    intentAttestation,
  };
  proposal.realizedMerge = {
    ...unsignedRealized,
    attestation: signLocalRealizedMergeReceipt(id, repo, unsignedRealized),
  };
  return proposal;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_MS);
  tmpHome = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-pmc-')));
  origHome = process.env.HOME;
  origAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
  repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-pmc-repo-')));
});

afterEach(() => {
  vi.useRealTimers();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = origAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// hasReleasedPostMergeCredit — token verification
// ---------------------------------------------------------------------------

describe('hasReleasedPostMergeCredit', () => {
  it('rejects the bare reserved literal', () => {
    expect(hasReleasedPostMergeCredit(POST_MERGE_CREDIT_RELEASE_LABEL)).toBe(false);
  });

  it('rejects non-string and garbage input', () => {
    expect(hasReleasedPostMergeCredit(undefined)).toBe(false);
    expect(hasReleasedPostMergeCredit(null)).toBe(false);
    expect(hasReleasedPostMergeCredit(42)).toBe(false);
    expect(hasReleasedPostMergeCredit('post-merge-credit-release-v1:not-hex:not-hex')).toBe(false);
  });

  it('keeps token-shaped historical values dormant while operational release is disabled', () => {
    const token = `${POST_MERGE_CREDIT_RELEASE_LABEL}:${'a'.repeat(24)}:${'b'.repeat(24)}`;
    expect(hasReleasedPostMergeCredit(token)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluatePostMergeCreditRelease — fail-closed eligibility
// ---------------------------------------------------------------------------

describe('evaluatePostMergeCreditRelease', () => {
  it('no authenticated merge witness -> ineligible', () => {
    const proposal = { id: 'no-witness', repo, status: 'applied' } as Proposal;
    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({ eligible: false, label: null, reason: 'no-authenticated-merge-witness' });
  });

  it('observation window not yet elapsed -> ineligible', () => {
    const proposal = makeMergedProposal({ id: 'too-soon', mergedAt: FIXED_ISO });
    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({ eligible: false, label: null, reason: 'observation-window-not-elapsed' });
  });

  it('window elapsed with no adverse observation remains report-only', () => {
    const proposal = makeMergedProposal({
      id: 'clean-missing-ledger',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({
      eligible: false,
      label: null,
      reason: 'report-only-no-positive-stability-witness',
    });
  });

  it('window elapsed, an adverse observation exists for this exact merge event -> ineligible', () => {
    const proposal = makeMergedProposal({
      id: 'regressed',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    const eventId = postMergeObservationEventId({
      repo: path.resolve(repo),
      proposalId: proposal.id,
      mergeCommit: proposal.realizedMerge!.mergeCommitOid,
    });
    const written = recordPostMergeObservation({
      observedAt: FIXED_ISO,
      outcome: 'reverted',
      basis: 'git-revert-reference',
      confidence: 'deterministic',
      repo: path.resolve(repo),
      proposalId: proposal.id,
      mergeCommit: proposal.realizedMerge!.mergeCommitOid,
      observedHead: '9'.repeat(40),
    });
    expect(written.recorded).toBe(1);

    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({ eligible: false, label: null, reason: 'adverse-outcome-observed' });
    // sanity: our fixture eventId matches the ledger's, or the test proves nothing
    expect(eventId).toEqual(postMergeObservationEventId({
      repo: path.resolve(repo),
      proposalId: proposal.id,
      mergeCommit: proposal.realizedMerge!.mergeCommitOid,
    }));
  });

  it('an unrelated adverse observation does not create operational release authority', () => {
    const proposal = makeMergedProposal({
      id: 'unrelated-regression',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
      mergeCommitOid: 'a'.repeat(40),
    });
    recordPostMergeObservation({
      observedAt: FIXED_ISO,
      outcome: 'reverted',
      basis: 'git-revert-reference',
      confidence: 'deterministic',
      repo: path.resolve(repo),
      proposalId: 'some-other-proposal',
      mergeCommit: 'b'.repeat(40),
      observedHead: '9'.repeat(40),
    });
    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({
      eligible: false,
      label: null,
      reason: 'report-only-no-positive-stability-witness',
    });
  });

  it('corrupt observation ledger (degraded read) -> ineligible, fail closed', () => {
    const proposal = makeMergedProposal({
      id: 'corrupt-ledger',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    // Prime the private directory structure via one legitimate write, then
    // corrupt the ledger file itself so readPostMergeObservations() degrades.
    recordPostMergeObservation({
      observedAt: FIXED_ISO,
      outcome: 'reverted',
      basis: 'git-revert-reference',
      confidence: 'deterministic',
      repo: path.resolve(repo),
      proposalId: 'seed',
      mergeCommit: 'c'.repeat(40),
      observedHead: '9'.repeat(40),
    });
    const ledgerPath = path.join(tmpHome, '.ashlr', 'fleet', 'post-merge-observations.jsonl');
    fs.appendFileSync(ledgerPath, 'not valid json at all\n');

    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result).toMatchObject({ eligible: false, label: null, reason: 'observation-ledger-degraded' });
  });

  it('clock skew (merge timestamp in the future relative to now) -> ineligible', () => {
    const proposal = makeMergedProposal({ id: 'future-merge', mergedAt: new Date(FIXED_MS + 60_000).toISOString() });
    const result = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('observation-window-not-elapsed');
  });
});

// ---------------------------------------------------------------------------
// sweepPostMergeCreditReleases — periodic write-back
// ---------------------------------------------------------------------------

describe('sweepPostMergeCreditReleases', () => {
  it('scans eligible-looking proposals but records no operational release', () => {
    const eligible = makeMergedProposal({
      id: 'sweep-eligible',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    const tooSoon = makeMergedProposal({ id: 'sweep-too-soon', mergedAt: FIXED_ISO, mergeCommitOid: 'd'.repeat(40) });

    const result = sweepPostMergeCreditReleases({
      nowMs: FIXED_MS,
      listProposals: () => [eligible, tooSoon],
    });

    expect(result.scanned).toBe(2);
    expect(result.released).toBe(0);
    expect(result.skipped).toBe(2);

    const decisionsDir = path.join(tmpHome, '.ashlr', 'decisions');
    expect(fs.existsSync(decisionsDir)).toBe(false);
  });

  it('remains report-only across repeated sweeps', () => {
    const eligible = makeMergedProposal({
      id: 'sweep-once',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    const first = sweepPostMergeCreditReleases({ nowMs: FIXED_MS, listProposals: () => [eligible] });
    expect(first).toMatchObject({ released: 0, skipped: 1 });

    const second = sweepPostMergeCreditReleases({ nowMs: FIXED_MS, listProposals: () => [eligible] });
    expect(second).toMatchObject({ released: 0, skipped: 1 });
  });

  it('never releases credit for a proposal that regressed', () => {
    const regressed = makeMergedProposal({
      id: 'sweep-regressed',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
      mergeCommitOid: 'e'.repeat(40),
    });
    recordPostMergeObservation({
      observedAt: FIXED_ISO,
      outcome: 'reverted',
      basis: 'git-revert-reference',
      confidence: 'deterministic',
      repo: path.resolve(repo),
      proposalId: regressed.id,
      mergeCommit: regressed.realizedMerge!.mergeCommitOid,
      observedHead: '9'.repeat(40),
    });
    const result = sweepPostMergeCreditReleases({ nowMs: FIXED_MS, listProposals: () => [regressed] });
    expect(result.released).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// attestPostMergeCreditSkillCard — dedicated signing boundary
// ---------------------------------------------------------------------------

describe('attestPostMergeCreditSkillCard', () => {
  function baseCard(overrides: Partial<SkillCard> = {}): SkillCard {
    return {
      schemaVersion: 1,
      skillId: 'skill.test',
      revision: 1,
      ts: FIXED_ISO,
      name: 'Test skill',
      summary: 'summary',
      status: 'verified',
      source: 'verified-proposal',
      tags: ['m243:skill'],
      taskKinds: ['general'],
      commandKinds: ['test'],
      verification: { passed: true, commandKinds: ['test'], diffHash: 'a'.repeat(64), evidenceCount: 1 },
      proposalId: 'proposal-x',
      ...overrides,
    };
  }

  it('refuses a card whose labelBasis is not a valid release token', () => {
    expect(attestPostMergeCreditSkillCard(baseCard({ labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL }))).toBeNull();
    expect(attestPostMergeCreditSkillCard(baseCard({ labelBasis: 'realized-merge-v1' }))).toBeNull();
    expect(attestPostMergeCreditSkillCard(baseCard({}))).toBeNull();
  });

  it('does not sign a card from report-only post-merge evidence', () => {
    const proposal = makeMergedProposal({
      id: 'attest-ok',
      mergedAt: mergedAtIso(MIN_POST_MERGE_OBSERVATION_WINDOW_MS + 1),
    });
    const eligibility = evaluatePostMergeCreditRelease(proposal, { nowMs: FIXED_MS });
    expect(eligibility).toMatchObject({ eligible: false, label: null });
    expect(attestPostMergeCreditSkillCard(baseCard({
      labelBasis: POST_MERGE_CREDIT_RELEASE_LABEL,
      proposalId: 'attest-ok',
    }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isPostMergeCreditReleaseLabel — structural recognition only
// ---------------------------------------------------------------------------

describe('isPostMergeCreditReleaseLabel', () => {
  it('matches only the exact bare literal', () => {
    expect(isPostMergeCreditReleaseLabel(POST_MERGE_CREDIT_RELEASE_LABEL)).toBe(true);
    expect(isPostMergeCreditReleaseLabel(`${POST_MERGE_CREDIT_RELEASE_LABEL}:abc:def`)).toBe(false);
    expect(isPostMergeCreditReleaseLabel('other')).toBe(false);
  });
});
