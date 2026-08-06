import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import {
  readPostMergeObservations,
  recordPostMergeObservation,
  type PostMergeObservationReadResult,
} from '../src/core/fleet/post-merge-observations.js';
import {
  readPostMergeStability,
  recordPostMergeStabilityCohort,
} from '../src/core/fleet/post-merge-stability.js';
import {
  buildProtectedMergePopulationSnapshot,
  projectPostMergeDenominator,
  type ProtectedMergePopulationSnapshot,
} from '../src/core/fleet/post-merge-denominator.js';
import { projectPostMergeComposite } from '../src/core/fleet/status.js';
import type { Proposal, RealizedMergeEvidence } from '../src/core/types.js';

const CAPTURED_AT = '2026-08-01T00:00:00.000Z';
const MERGED_AT = '2026-07-20T00:00:00.000Z';
const STABLE_AT = '2026-07-27T00:00:00.000Z';
const WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const stableCommit = 'a'.repeat(40);
const adverseCommit = 'b'.repeat(40);
let home: string;
let previousHome: string | undefined;
let previousAshlrHome: string | undefined;
let stableRepo: string;
let adverseRepo: string;

beforeEach(() => {
  expect.hasAssertions();
  previousHome = process.env.HOME;
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-m488-denominator-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
  stableRepo = resolve(join(home, 'stable-repo'));
  adverseRepo = resolve(join(home, 'adverse-repo'));
  expect(loadOrCreateKey()).toHaveLength(32);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

function population(extra: ProtectedMergePopulationSnapshot['merges'] = []): ProtectedMergePopulationSnapshot {
  return {
    merges: [
      { repo: stableRepo, proposalId: 'proposal-stable', mergeCommit: stableCommit, mergedAt: MERGED_AT },
      { repo: adverseRepo, proposalId: 'proposal-adverse', mergeCommit: adverseCommit, mergedAt: MERGED_AT },
      ...extra,
    ],
    sourceState: 'healthy',
    sourcePresent: true,
    complete: true,
    stopReasons: [],
    capturedAt: CAPTURED_AT,
  };
}

function writeSignedEvidence(): {
  adverse: PostMergeObservationReadResult;
  stability: ReturnType<typeof readPostMergeStability>;
} {
  expect(recordPostMergeObservation({
    observedAt: '2026-07-22T00:00:00.000Z',
    outcome: 'regressed',
    basis: 'bisect-first-bad',
    confidence: 'deterministic',
    repo: adverseRepo,
    proposalId: 'proposal-adverse',
    mergeCommit: adverseCommit,
    observedHead: 'c'.repeat(40),
  })).toMatchObject({ recorded: 1 });
  expect(recordPostMergeStabilityCohort({
    cohortId: 'cohort-stable',
    completedAt: STABLE_AT,
    witnesses: [{
      cohortId: 'cohort-stable',
      repo: stableRepo,
      proposalId: 'proposal-stable',
      mergeCommit: stableCommit,
      observedHead: 'd'.repeat(40),
      windowStartedAt: MERGED_AT,
      stableAt: STABLE_AT,
      windowMs: WINDOW_MS,
      verificationDigest: 'e'.repeat(64),
    }],
  })).toMatchObject({ recorded: 1, witnessesRecorded: 1 });
  return {
    adverse: readPostMergeObservations({ requireComplete: true }),
    stability: readPostMergeStability({ requireComplete: true }),
  };
}

function proposal(): Proposal {
  return {
    id: 'proposal-stable',
    repo: stableRepo,
    origin: 'swarm',
    kind: 'pr',
    title: 'protected merge',
    summary: 'fixture',
    status: 'applied',
    createdAt: '2026-07-19T00:00:00.000Z',
    remoteHandoff: {
      provider: 'github',
      state: 'merged',
      prUrl: 'https://github.com/ashlrai/example/pull/1',
      branch: 'ashlr/proposal-stable',
      base: 'main',
      expectedHeadOid: 'f'.repeat(40),
      mergeCommitOid: stableCommit,
      mergedAt: MERGED_AT,
      createdAt: '2026-07-19T00:00:00.000Z',
      reconciliation: {
        schemaVersion: 1,
        observedAt: '2026-07-20T00:01:00.000Z',
        attestation: '1'.repeat(64),
      },
    },
  };
}

function realized(): RealizedMergeEvidence {
  const handoff = proposal().remoteHandoff!;
  return {
    schemaVersion: 1,
    source: 'github-host',
    provider: 'github',
    prUrl: handoff.prUrl!,
    branch: handoff.branch!,
    base: handoff.base!,
    expectedHeadOid: handoff.expectedHeadOid!,
    mergeCommitOid: handoff.mergeCommitOid!,
    mergedAt: handoff.mergedAt!,
    reconciliation: handoff.reconciliation!,
  };
}

describe('M488 protected post-merge denominator projection', () => {
  it('marks the denominator complete only when every protected merge has signed terminal evidence', () => {
    const evidence = writeSignedEvidence();
    const projected = projectPostMergeDenominator({
      population: population(),
      ...evidence,
      observedAt: CAPTURED_AT,
    });
    expect(projected).toMatchObject({
      sourceComplete: true,
      denominatorComplete: true,
      protectedMerges: 2,
      observedMerges: 2,
      unmatchedMerges: 0,
    });
    expect(projected.matchedAdverse).toHaveLength(1);
    expect(projected.matchedStability).toHaveLength(1);

    const composite = projectPostMergeComposite(
      evidence.adverse,
      evidence.stability,
      population(),
      CAPTURED_AT,
    );
    expect(composite).toMatchObject({
      source: { sourceState: 'healthy', complete: true },
      cohort: {
        policyEligible: false,
        denominatorComplete: true,
        adverseObservations: 1,
        stability: { releasedWitnesses: 1 },
      },
    });
  });

  it('keeps a healthy but uncovered protected merge denominator incomplete', () => {
    const evidence = writeSignedEvidence();
    const projected = projectPostMergeDenominator({
      population: population([{
        repo: resolve(join(home, 'unobserved-repo')),
        proposalId: 'proposal-unobserved',
        mergeCommit: '9'.repeat(40),
        mergedAt: MERGED_AT,
      }]),
      ...evidence,
      observedAt: CAPTURED_AT,
    });
    expect(projected).toMatchObject({
      sourceComplete: true,
      denominatorComplete: false,
      protectedMerges: 3,
      observedMerges: 2,
      unmatchedMerges: 1,
    });
  });

  it('fails closed on missing or unreadable outcome sources', () => {
    const evidence = writeSignedEvidence();
    const missing = projectPostMergeDenominator({
      population: population(),
      adverse: {
        ...evidence.adverse,
        observations: [],
        sourceState: 'missing',
        sourcePresent: false,
      },
      stability: evidence.stability,
      observedAt: CAPTURED_AT,
    });
    expect(missing).toMatchObject({ sourceComplete: false, denominatorComplete: false });
    expect(missing.stopReasons).toEqual(expect.arrayContaining([
      'adverse-source-missing', 'post-merge-source-incomplete',
    ]));

    const unreadable = projectPostMergeDenominator({
      population: population(),
      adverse: evidence.adverse,
      stability: {
        ...evidence.stability,
        witnesses: [],
        sourceState: 'degraded',
        complete: false,
        stopReasons: ['io-error'],
      },
      observedAt: CAPTURED_AT,
    });
    expect(unreadable).toMatchObject({ sourceComplete: false, denominatorComplete: false });
    expect(unreadable.stopReasons).toEqual(expect.arrayContaining(['io-error', 'post-merge-source-incomplete']));
  });

  it('rejects stale snapshots and stability windows shorter than the required observation period', () => {
    const evidence = writeSignedEvidence();
    const staleSnapshot = projectPostMergeDenominator({
      population: population(),
      ...evidence,
      observedAt: CAPTURED_AT,
      now: '2026-08-01T00:01:00.001Z',
    });
    expect(staleSnapshot).toMatchObject({ sourceComplete: false, denominatorComplete: false });
    expect(staleSnapshot.stopReasons).toContain('post-merge-snapshot-stale');

    const shortWindow = projectPostMergeDenominator({
      population: population(),
      adverse: evidence.adverse,
      stability: {
        ...evidence.stability,
        witnesses: evidence.stability.witnesses.map((row) => ({ ...row, windowMs: 1 })),
      },
      observedAt: CAPTURED_AT,
    });
    expect(shortWindow).toMatchObject({ sourceComplete: false, denominatorComplete: false });
    expect(shortWindow.stopReasons).toContain('post-merge-evidence-stale');
  });

  it('rejects signed evidence that cannot reconcile to the protected merge population', () => {
    const evidence = writeSignedEvidence();
    const projected = projectPostMergeDenominator({
      population: {
        ...population(),
        merges: population().merges.filter((merge) => merge.proposalId !== 'proposal-adverse'),
      },
      ...evidence,
      observedAt: CAPTURED_AT,
    });
    expect(projected).toMatchObject({ sourceComplete: false, denominatorComplete: false });
    expect(projected.stopReasons).toContain('post-merge-evidence-orphaned');
  });

  it('builds the protected population only from a complete authenticated proposal snapshot', () => {
    const healthy = buildProtectedMergePopulationSnapshot({
      proposals: [proposal()],
      proposalSource: {
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      },
      capturedAt: CAPTURED_AT,
    }, { readRealizedMerge: () => realized() });
    expect(healthy).toMatchObject({
      sourceState: 'healthy', complete: true, merges: [{ proposalId: 'proposal-stable' }],
    });

    const missing = buildProtectedMergePopulationSnapshot({
      proposals: [proposal()],
      proposalSource: {
        sourceState: 'missing', sourcePresent: false, complete: true, stopReasons: [],
      },
      capturedAt: CAPTURED_AT,
    }, { readRealizedMerge: () => realized() });
    expect(missing).toMatchObject({ sourceState: 'missing', complete: false, merges: [] });
    expect(missing.stopReasons).toContain('protected-merge-source-missing');

    const invalid = buildProtectedMergePopulationSnapshot({
      proposals: [proposal()],
      proposalSource: {
        sourceState: 'healthy', sourcePresent: true, complete: true, stopReasons: [],
      },
      capturedAt: CAPTURED_AT,
    }, { readRealizedMerge: () => null });
    expect(invalid).toMatchObject({ sourceState: 'degraded', complete: false, merges: [] });
    expect(invalid.stopReasons).toContain('protected-merge-reconciliation-failed');
  });
});
