import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TrajectoryRecord } from '../src/core/autonomy/trajectory-records.js';
import type {
  PostMergePopulationMemberV2,
  PostMergePopulationV2,
} from '../src/core/fleet/post-merge-population-v2.js';
import {
  buildLearningEligibilityProjectionV1,
  LEARNING_ELIGIBILITY_POLICY_VERSION,
} from '../src/core/learning/learning-eligibility.js';

const KEY = Buffer.alloc(32, 7);
const STARTED_AT = '2026-07-01T00:00:00.000Z';
const LATEST_AT = '2026-07-01T00:01:00.000Z';

function hmac(domain: string, value: string): string {
  return createHmac('sha256', KEY).update(JSON.stringify([domain, value])).digest('hex');
}

function trajectory(overrides: Partial<TrajectoryRecord> = {}): TrajectoryRecord {
  return {
    version: 1,
    id: 'record-1',
    key: 'raw-key-must-not-persist',
    startedAt: STARTED_AT,
    latestAt: LATEST_AT,
    terminalOutcome: 'merged',
    proposalId: 'proposal-secret-1',
    runId: 'run-secret-1',
    trajectoryId: 'trajectory-secret-1',
    evidenceOutcome: { verificationPassed: true },
    coverage: {
      dispatch: true,
      proposal: true,
      evidence: true,
      decision: true,
      agentAction: true,
      skillUse: false,
    },
    timeline: [{
      ts: LATEST_AT,
      kind: 'evidence',
      outcome: 'passed',
      reason: 'RAW_SECRET_REASON_MUST_NOT_PERSIST',
      evidence: {
        target: 'branch',
        trustBasis: 'evidence',
        riskClass: 'low',
        verificationPassed: true,
        commandKinds: ['test'],
      },
    }],
    ...overrides,
  };
}

function populationMember(
  proposalId: string,
  classification: PostMergePopulationMemberV2['classification'] = 'inconclusive',
): PostMergePopulationMemberV2 {
  const proposalDigest = hmac('ashlr:post-merge-v2:proposal', proposalId);
  return {
    memberId: '1'.repeat(64),
    repoDigest: '2'.repeat(64),
    proposalDigest,
    mergeDigest: '3'.repeat(64),
    classification,
    reason: classification === 'adverse' ? 'deterministic-adverse' : 'no-terminal-evidence',
    evidenceDigest: '4'.repeat(64),
  };
}

function population(members: PostMergePopulationMemberV2[]): PostMergePopulationV2 {
  return {
    schemaVersion: 2,
    authority: 'observation-only',
    scope: 'cutoff-enrolled-attested-github-realized-merges/v2',
    policyEligible: false,
    denominatorComplete: false,
    conclusiveComplete: members.every((member) => member.classification === 'adverse'),
    cohortId: '5'.repeat(64),
    cohortStartedAt: STARTED_AT,
    eligibleThroughAt: LATEST_AT,
    cutoffAt: LATEST_AT,
    windowMs: 60_000,
    enrollmentDigest: '6'.repeat(64),
    proposalSourceDigest: '7'.repeat(64),
    adverseSourceDigest: '8'.repeat(64),
    stabilitySourceDigest: '9'.repeat(64),
    populationDigest: 'a'.repeat(64),
    eligible: members.length,
    excluded: 0,
    adverse: members.filter((member) => member.classification === 'adverse').length,
    inconclusive: members.filter((member) => member.classification === 'inconclusive').length,
    exclusions: {
      'not-applied': 0,
      'repo-missing': 0,
      'repo-not-enrolled': 0,
      'realized-merge-missing-or-invalid': 0,
      'realized-merge-not-github': 0,
      'realized-merge-mismatch': 0,
      'handoff-missing': 0,
      'handoff-not-merged': 0,
      'base-mismatch': 0,
      'merge-oid-invalid': 0,
      'merge-time-invalid': 0,
      'outside-window': 0,
      'receipt-invalid': 0,
    },
    members,
  };
}

function build(
  records: TrajectoryRecord[],
  options: Partial<Parameters<typeof buildLearningEligibilityProjectionV1>[0]> = {},
) {
  return buildLearningEligibilityProjectionV1({
    records,
    trajectorySourceComplete: true,
    learningEpoch: '2026-07',
    ...options,
  }, { identityKey: () => KEY });
}

describe('LearningEligibilityV1', () => {
  it('joins protected merge identity but keeps inconclusive credit dormant', () => {
    const result = build([trajectory()], {
      population: population([populationMember('proposal-secret-1')]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection).toMatchObject({
      schemaVersion: 1,
      authority: 'observation-only',
      policyVersion: LEARNING_ELIGIBILITY_POLICY_VERSION,
      policyEligible: false,
      recursiveLearningEligible: false,
      denominatorComplete: false,
      evaluated: 1,
    });
    expect(result.projection.members[0]).toMatchObject({
      stages: {
        dispatch: 'observed',
        proposal: 'observed',
        verification: 'passed',
        decision: 'observed',
        terminal: 'protected-merge',
        postMerge: 'inconclusive',
      },
      refusalCodes: expect.arrayContaining([
        'post-merge-inconclusive',
        'denominator-incomplete',
        'selection-propensity-unavailable',
      ]),
      policyEligible: false,
      recursiveLearningEligible: false,
    });
  });

  it('gives deterministic adverse evidence precedence without positive authority', () => {
    const member = populationMember('proposal-secret-1', 'adverse');
    const result = build([trajectory({
      selectionObservation: {
        schemaVersion: 1,
        authority: 'observation-only',
        mode: 'randomized-canary',
        selectionPolicyVersion: 'canary-v1',
        randomizationProtocolVersion: 'uniform-v1',
        candidateSetDigest: 'a'.repeat(64),
        assignmentDigest: 'b'.repeat(64),
        candidateCount: 2,
        selectedRank: 0,
        selectionProbabilityPpm: 500_000,
        selectedBackend: 'codex',
        selectedTier: 'frontier',
        selectedModel: 'gpt-5.6',
      },
    })], {
      population: population([member]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.members[0]).toMatchObject({
      stages: { postMerge: 'adverse' },
      selectionPropensityAvailable: true,
      refusalCodes: expect.arrayContaining(['post-merge-adverse', 'denominator-incomplete']),
    });
    expect(result.projection.members[0]?.refusalCodes)
      .not.toContain('selection-propensity-unavailable');
  });

  it('does not accept caller-injected propensity identities without a dispatch observation', () => {
    const result = build([trajectory()], {
      selectionPropensityTrajectoryIds: new Set(['trajectory-secret-1']),
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.members[0]).toMatchObject({
      selectionPropensityAvailable: false,
      refusalCodes: expect.arrayContaining(['selection-propensity-unavailable']),
      policyEligible: false,
      recursiveLearningEligible: false,
    });
  });

  it('records no-proposal, rejection, verification, and source gaps explicitly', () => {
    const noProposal = trajectory({
      id: 'record-no-proposal',
      trajectoryId: 'trajectory-no-proposal',
      proposalId: undefined,
      terminalOutcome: 'no-proposal',
      evidenceOutcome: undefined,
      coverage: {
        dispatch: true,
        proposal: false,
        evidence: false,
        decision: false,
        agentAction: false,
        skillUse: false,
      },
      timeline: [],
    });
    const rejected = trajectory({
      id: 'record-rejected',
      trajectoryId: 'trajectory-rejected',
      proposalId: 'proposal-rejected',
      terminalOutcome: 'rejected',
      evidenceOutcome: { verificationPassed: false },
      decisionSourceQuality: {
        sourceState: 'degraded',
        sourcePresent: true,
        complete: false,
        stopReasons: ['row-limit'],
        filesRead: 1,
        bytesRead: 10,
        rowsScanned: 1,
        invalidRows: 0,
        unreadableFiles: 0,
      },
    });
    const result = build([noProposal, rejected], { trajectorySourceComplete: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projection.sourceComplete).toBe(false);
    expect(result.projection.refusalCounts).toMatchObject({
      'trajectory-source-incomplete': 2,
      'proposal-not-produced': 1,
      'verification-missing': 1,
      'verification-failed': 1,
      'decision-missing': 1,
      'decision-source-incomplete': 1,
      'terminal-rejected': 1,
    });
  });

  it('is ordering invariant and persists no raw identity or free-form event text', () => {
    const second = trajectory({
      id: 'record-2',
      runId: 'run-secret-2',
      trajectoryId: 'trajectory-secret-2',
      proposalId: 'proposal-secret-2',
      terminalOutcome: 'pending',
    });
    const left = build([trajectory(), second]);
    const right = build([second, trajectory()]);
    expect(left.ok && right.ok && left.projection.candidateSetDigest === right.projection.candidateSetDigest)
      .toBe(true);
    expect(left.ok && right.ok && left.projection.members).toEqual(right.ok ? right.projection.members : []);
    if (!left.ok) return;
    const serialized = JSON.stringify(left.projection);
    for (const raw of [
      'record-1',
      'raw-key-must-not-persist',
      'proposal-secret-1',
      'run-secret-1',
      'trajectory-secret-1',
      'RAW_SECRET_REASON_MUST_NOT_PERSIST',
    ]) expect(serialized).not.toContain(raw);
  });

  it('refuses partial candidate sets, duplicate subjects, invalid input, and missing keys', () => {
    expect(build([trajectory(), trajectory({ id: 'record-2' })])).toEqual({
      ok: false,
      reason: 'duplicate-subject',
    });
    expect(build([trajectory()], { maxMembers: 0 })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([trajectory({ trajectoryId: 'bad\nidentity' })])).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(build([trajectory()], {
      population: {
        ...population([populationMember('proposal-secret-1')]),
        members: [{ ...populationMember('proposal-secret-1'), proposalDigest: 'not-a-digest' }],
      },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([trajectory(), trajectory({
      id: 'record-2',
      trajectoryId: 'trajectory-2',
    })], { maxMembers: 1 })).toEqual({ ok: false, reason: 'source-limit' });
    expect(buildLearningEligibilityProjectionV1({
      records: [trajectory()],
      trajectorySourceComplete: true,
      learningEpoch: '2026-07',
    }, { identityKey: () => null })).toEqual({ ok: false, reason: 'identity-key-unavailable' });
  });
});
