import { describe, expect, it } from 'vitest';
import {
  buildOutcomeAssurance,
  type FleetStatus,
} from '../src/core/fleet/status.js';

function metric(count: number, denominator = 10): { count: number; rate: number } {
  return { count, rate: denominator > 0 ? count / denominator : 0 };
}

function statusWithOutcomes(input: {
  observed?: number;
  eligible?: number;
  incomplete?: number;
  degraded?: number;
  proposals?: number;
  evidence?: number;
  merged?: number;
  followedUp?: number;
  reverted?: number;
  regressed?: number;
  stable?: number;
  denominatorComplete?: boolean;
} = {}): FleetStatus {
  const eligible = input.eligible ?? 10;
  const merged = input.merged ?? 3;
  return {
    learningMetrics: {
      trajectoryLearning: { state: 'available', reasons: [], sources: [], withheldMetrics: [] },
    },
    postMergeSource: {
      sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      filesRead: 1, bytesRead: 1, rowsScanned: 1, invalidRows: 0, unreadableFiles: 0,
    },
    postMergeCohort: {
      policyEligible: false,
      denominatorComplete: input.denominatorComplete ?? true,
      adverseObservations: (input.followedUp ?? 0) + (input.reverted ?? 0) + (input.regressed ?? 0),
      stability: {
        completeCohorts: 1,
        releasedWitnesses: input.stable ?? Math.max(
          0,
          merged - (input.followedUp ?? 0) - (input.reverted ?? 0) - (input.regressed ?? 0),
        ),
        distinctRepoDigests: 1,
      },
    },
    trajectoryLearning: {
      version: 1,
      windowHours: 24,
      trajectories: eligible,
      population: {
        observed: input.observed ?? eligible,
        learningEligible: eligible,
        incomplete: input.incomplete ?? 0,
        degraded: input.degraded ?? 0,
      },
      terminalOutcomes: {
        merged,
        rejected: 0,
        handoff: 0,
        pending: Math.max(0, eligible - merged),
        'no-proposal': 0,
        cancelled: 0,
        failed: 0,
        unknown: 0,
      },
      realizedOutcomes: {
        'followed-up': input.followedUp ?? 0,
        reverted: input.reverted ?? 0,
        regressed: input.regressed ?? 0,
      },
      coverage: {
        proposal: metric(input.proposals ?? eligible, eligible),
        evidence: metric(input.evidence ?? eligible, eligible),
      },
    },
  } as unknown as FleetStatus;
}

describe('outcome assurance', () => {
  it('withholds exact outcome claims when joined sources are unavailable', () => {
    const status = buildOutcomeAssurance({} as FleetStatus);

    expect(status).toMatchObject({
      verdict: 'withheld',
      authority: {
        mode: 'observation-only',
        readinessEligible: false,
        learningEligible: false,
      },
      topGap: { id: 'source-withheld' },
    });
    expect(status.funnel.postMergeCoverage).toBeNull();
  });

  it('requires a minimum eligible cohort before supporting an autonomy claim', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({
      observed: 5,
      eligible: 5,
      proposals: 5,
      evidence: 5,
      merged: 3,
      stable: 3,
    }));

    expect(status).toMatchObject({
      verdict: 'insufficient-sample',
      cohort: { observed: 5, eligible: 5, excluded: 0 },
      topGap: { id: 'sample-floor', count: 5 },
    });
  });

  it('supports the claim only with complete evidence and observed stable merges', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes());

    expect(status).toMatchObject({
      verdict: 'supported',
      cohort: { observed: 10, eligible: 10, excluded: 0 },
      funnel: {
        dispatched: 10,
        proposals: 10,
        evidence: 10,
        protectedMerges: 3,
        postMergeObserved: 3,
        stableWitnesses: 3,
        adverseObservations: 0,
        proposalRate: 1,
        evidenceRate: 1,
        mergeRate: 0.3,
        postMergeCoverage: 1,
      },
      outcomes: { followedUp: 0, adverse: 0, adverseRate: 0 },
      topGap: null,
    });
  });

  it('reports explicit incomplete and degraded cohort exclusions', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({
      observed: 13,
      incomplete: 2,
      degraded: 1,
    }));

    expect(status).toMatchObject({
      verdict: 'evidence-incomplete',
      cohort: {
        observed: 13,
        eligible: 10,
        excluded: 3,
        exclusions: { incomplete: 2, degraded: 1 },
      },
      topGap: { id: 'excluded-population', count: 3 },
    });
  });

  it('surfaces adverse outcomes ahead of otherwise complete cohort evidence', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({
      followedUp: 1,
    }));

    expect(status).toMatchObject({
      verdict: 'adverse-outcome',
      outcomes: { followedUp: 1, reverted: 0, adverse: 1, adverseRate: 1 / 3 },
      topGap: { id: 'adverse-outcome', count: 1 },
    });
  });

  it('fails closed when protected merges lack realized-outcome coverage', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({ stable: 2 }));

    expect(status).toMatchObject({
      verdict: 'evidence-incomplete',
      funnel: { protectedMerges: 3, postMergeObserved: 2, postMergeCoverage: 2 / 3 },
      topGap: { id: 'post-merge-coverage', count: 1 },
    });
  });

  it('refuses a supported claim while the post-merge denominator is incomplete', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({ denominatorComplete: false }));

    expect(status).toMatchObject({
      verdict: 'evidence-incomplete',
      topGap: { id: 'post-merge-denominator' },
    });
  });

  it('withholds rates when cohort or funnel counts do not reconcile', () => {
    const status = buildOutcomeAssurance(statusWithOutcomes({ observed: 9, proposals: 11 }));

    expect(status).toMatchObject({
      verdict: 'evidence-incomplete',
      funnel: { proposalRate: null },
      topGap: { id: 'denominator-reconciliation' },
    });
  });
});
