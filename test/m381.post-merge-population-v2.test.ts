import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Proposal } from '../src/core/types.js';
import type { PostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import type {
  PostMergeStabilityCohortManifest,
  PostMergeStabilityWitness,
} from '../src/core/fleet/post-merge-stability.js';
import {
  buildPostMergePopulationV2,
  type ObservationSnapshotV2,
  type ProposalSnapshotV2,
  type StabilitySnapshotV2,
} from '../src/core/fleet/post-merge-population-v2.js';

const repo = resolve('/tmp/ashlr-v2-repo');
const key = Buffer.alloc(32, 7);
const merge = 'a'.repeat(40);

function legacyRepoDigest(): string {
  return createHmac('sha256', key)
    .update(JSON.stringify(['ashlr:post-merge-stability-repo:v1', repo]))
    .digest('hex');
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'proposal-1', repo, origin: 'swarm', kind: 'pr', title: 'test', summary: 'test',
    status: 'applied', createdAt: '2026-06-01T00:00:00.000Z',
    remoteHandoff: {
      provider: 'github', state: 'merged', base: 'main', mergeCommitOid: merge,
      mergedAt: '2026-06-10T00:00:00.000Z', createdAt: '2026-06-09T00:00:00.000Z',
      reconciliation: { schemaVersion: 1, observedAt: '2026-06-10T00:01:00.000Z', attestation: 'b'.repeat(64) },
    },
    ...overrides,
  } as Proposal;
}

function proposals(rows: Proposal[], complete = true): ProposalSnapshotV2 {
  return {
    proposals: rows, sourceState: complete ? 'healthy' : 'degraded', sourcePresent: true,
    complete, stopReasons: complete ? [] : ['invalid-file'], filesDiscovered: rows.length,
    filesRead: rows.length, bytesRead: 100, invalidFiles: complete ? 0 : 1, unreadableFiles: 0,
    snapshotDigest: '8'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
  };
}

function adverse(rows: PostMergeObservation[] = [], complete = true): ObservationSnapshotV2 {
  return {
    observations: rows, sourceState: complete ? (rows.length ? 'healthy' : 'missing') : 'degraded',
    sourcePresent: rows.length > 0, complete, stopReasons: complete ? [] : ['invalid-row'],
    filesRead: rows.length ? 1 : 0, bytesRead: 0, physicalRows: rows.length, invalidRows: 0,
    conflictingEvents: 0, duplicateRows: 0, supersededRows: 0, limitExceeded: false,
    snapshotDigest: '7'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
  };
}

function stability(
  rows: PostMergeStabilityWitness[] = [],
  complete = true,
  manifests?: PostMergeStabilityCohortManifest[],
): StabilitySnapshotV2 {
  const releasedManifests = manifests ?? (rows.length ? [{
    schemaVersion: 1 as const,
    recordType: 'cohort-manifest' as const,
    authority: 'observation-only' as const,
    manifestId: '5'.repeat(64),
    cohortId: 'cohort-1',
    partitionDate: '2026-06-17',
    completedAt: rows.map((row) => row.stableAt).sort().at(-1)!,
    memberCount: rows.length,
    members: rows.map((row) => ({ witnessId: row.witnessId, witnessDigest: row.witnessDigest })),
    attestation: '6'.repeat(64),
  }] : []);
  return {
    witnesses: rows, manifests: releasedManifests, cohortSummary: {
      completeCohorts: rows.length ? 1 : 0, releasedWitnesses: rows.length,
      distinctRepoDigests: rows.length ? 1 : 0,
    },
    sourceState: complete ? (rows.length ? 'healthy' : 'missing') : 'degraded',
    sourcePresent: rows.length > 0, complete, stopReasons: complete ? [] : ['invalid-row'],
    filesRead: rows.length ? 1 : 0, bytesRead: 0, physicalRows: rows.length,
    invalidRows: 0, oversizedRows: 0, orphanWitnesses: 0, incompleteManifests: 0,
    conflictingCohorts: 0, duplicateRows: 0, releasedCohorts: rows.length ? 1 : 0,
    limitExceeded: false,
    snapshotDigest: '6'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
  };
}

function observation(overrides: Partial<PostMergeObservation> = {}): PostMergeObservation {
  return {
    schemaVersion: 1, eventId: 'event-1', observedAt: '2026-06-12T00:00:00.000Z',
    authority: 'observation-only', outcome: 'regressed', basis: 'bisect-first-bad',
    confidence: 'deterministic', repo, proposalId: 'proposal-1', mergeCommit: merge,
    observedHead: 'c'.repeat(40), labelBasis: 'post-merge-regression', attestation: 'd'.repeat(64),
    ...overrides,
  };
}

function stableWitness(repoDigest: string, overrides: Partial<PostMergeStabilityWitness> = {}): PostMergeStabilityWitness {
  return {
    schemaVersion: 1, recordType: 'stable-after-window', authority: 'observation-only',
    witnessId: 'e'.repeat(64), cohortId: 'cohort-1', repoDigest, proposalId: 'proposal-1',
    mergeCommit: merge, observedHead: 'f'.repeat(40), windowStartedAt: '2026-06-10T00:00:00.000Z',
    stableAt: '2026-06-17T00:00:00.000Z', windowMs: 604_800_000,
    verificationDigest: '1'.repeat(64), witnessDigest: '2'.repeat(64), attestation: '3'.repeat(64),
    ...overrides,
  };
}

function build(
  proposalRows: Proposal[],
  adverseRows: PostMergeObservation[] = [],
  stabilityRows: PostMergeStabilityWitness[] = [],
  overrides: Record<string, unknown> = {},
) {
  return buildPostMergePopulationV2({
    proposals: proposals(proposalRows),
    enrollment: {
      repos: [repo], sourceState: 'healthy', complete: true,
      defaultBranches: [{ repo, branch: 'main' }],
      snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
    },
    adverse: adverse(adverseRows), stability: stability(stabilityRows),
    cohortStartedAt: '2026-06-01T00:00:00.000Z', cutoffAt: '2026-06-20T00:00:00.000Z',
    windowMs: 7 * 24 * 60 * 60 * 1_000,
    ...overrides,
  }, {
    identityKey: () => key,
    verifyReceipt: () => true,
  });
}

describe('M381 denominator-complete post-merge population v2', () => {
  it('accounts for an eligible receipt-qualified merge as explicitly inconclusive', () => {
    const result = build([proposal()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.population).toMatchObject({
      authority: 'observation-only', policyEligible: false, denominatorComplete: false,
      conclusiveComplete: false, eligible: 1, excluded: 0, adverse: 0, inconclusive: 1,
    });
    expect(result.population.members[0]).toMatchObject({
      classification: 'inconclusive', reason: 'no-terminal-evidence',
    });
  });

  it('gives deterministic adverse evidence precedence over stability', () => {
    const first = build([proposal()]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const witness = stableWitness(legacyRepoDigest());
    const result = build([proposal()], [observation()], [witness]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.population).toMatchObject({ adverse: 1, inconclusive: 0, conclusiveComplete: true });
    expect(result.population.members[0]).toMatchObject({
      classification: 'adverse', reason: 'deterministic-adverse',
    });
  });

  it('reserves legacy stability and heuristic adverse evidence as inconclusive', () => {
    const first = build([proposal()]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const stable = build([proposal()], [], [stableWitness(legacyRepoDigest())]);
    expect(stable.ok && stable.population.members[0]?.reason).toBe('legacy-isolation-unknown');
    const heuristic = build([proposal()], [observation({
      outcome: 'followed-up', basis: 'overlapping-fix', confidence: 'heuristic',
    })]);
    expect(heuristic.ok && heuristic.population.members[0]?.reason).toBe('heuristic-adverse');
  });

  it('binds excluded proposals into the source digest and accounts exclusion reasons', () => {
    const pending = proposal({ id: 'pending', status: 'pending' });
    const notEnrolled = proposal({ id: 'other', repo: resolve('/tmp/other') });
    const badBase = proposal({
      id: 'base', remoteHandoff: { ...proposal().remoteHandoff!, base: 'release' },
    });
    const result = build([proposal(), pending, notEnrolled, badBase]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.population).toMatchObject({ eligible: 1, excluded: 3 });
    expect(result.population.exclusions).toMatchObject({
      'not-applied': 1, 'repo-not-enrolled': 1, 'base-mismatch': 1,
    });
    const changed = build([proposal(), { ...pending, status: 'rejected' }]);
    expect(changed.ok && changed.population.proposalSourceDigest)
      .not.toBe(result.population.proposalSourceDigest);
  });

  it('accepts exact historical window boundaries and excludes outside members', () => {
    const lower = proposal({ id: 'lower', remoteHandoff: {
      ...proposal().remoteHandoff!, mergeCommitOid: '4'.repeat(40), mergedAt: '2026-06-01T00:00:00.000Z',
    } });
    const upper = proposal({ id: 'upper', remoteHandoff: {
      ...proposal().remoteHandoff!, mergeCommitOid: '5'.repeat(40), mergedAt: '2026-06-13T00:00:00.000Z',
    } });
    const late = proposal({ id: 'late', remoteHandoff: {
      ...proposal().remoteHandoff!, mergeCommitOid: '6'.repeat(40), mergedAt: '2026-06-13T00:00:00.001Z',
    } });
    const result = build([lower, upper, late]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.population).toMatchObject({ eligible: 2, excluded: 1 });
    expect(result.population.exclusions['outside-window']).toBe(1);
  });

  it('refuses duplicate repository/merge identities instead of double counting', () => {
    expect(build([proposal(), proposal({ id: 'proposal-2' })])).toEqual({
      ok: false, reason: 'duplicate-merge',
    });
  });

  it('refuses every incomplete authority source and unavailable identity keys', () => {
    const base = {
      proposals: proposals([proposal()]),
      enrollment: {
        repos: [repo], sourceState: 'healthy' as const, complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
      },
      adverse: adverse(), stability: stability(), cohortStartedAt: '2026-06-01T00:00:00.000Z',
      cutoffAt: '2026-06-20T00:00:00.000Z', windowMs: 604_800_000,
    };
    const deps = { identityKey: () => key, verifyReceipt: () => true };
    expect(buildPostMergePopulationV2({ ...base, proposals: proposals([proposal()], false) }, deps))
      .toEqual({ ok: false, reason: 'proposal-source-incomplete' });
    expect(buildPostMergePopulationV2({
      ...base, enrollment: { ...base.enrollment, sourceState: 'degraded', complete: false },
    }, deps)).toEqual({ ok: false, reason: 'enrollment-source-incomplete' });
    expect(buildPostMergePopulationV2({ ...base, adverse: adverse([], false) }, deps))
      .toEqual({ ok: false, reason: 'adverse-source-incomplete' });
    expect(buildPostMergePopulationV2({ ...base, stability: stability([], false) }, deps))
      .toEqual({ ok: false, reason: 'stability-source-incomplete' });
    expect(buildPostMergePopulationV2(base, { ...deps, identityKey: () => null }))
      .toEqual({ ok: false, reason: 'identity-key-unavailable' });
  });

  it('is ordering-invariant and emits no raw repo, proposal, or merge identity', () => {
    const second = proposal({ id: 'proposal-2', remoteHandoff: {
      ...proposal().remoteHandoff!, mergeCommitOid: '7'.repeat(40), mergedAt: '2026-06-11T00:00:00.000Z',
    } });
    const left = build([proposal(), second]);
    const right = build([second, proposal()]);
    expect(left).toEqual(right);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    const serialized = JSON.stringify(left.population);
    expect(serialized).not.toContain(repo);
    expect(serialized).not.toContain('proposal-1');
    expect(serialized).not.toContain(merge);
    expect(serialized).not.toContain('2026-06-10T00:00:00.000Z');
  });

  it('rejects invalid enrollment identities and unsafe time geometry', () => {
    expect(build([proposal()], [], [], {
      enrollment: {
        repos: [repo, repo], sourceState: 'healthy', complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
      },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([proposal()], [], [], {
      cohortStartedAt: '2026-06-15T00:00:00.000Z', cutoffAt: '2026-06-20T00:00:00.000Z',
    })).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('requires independently witnessed proposal and enrollment snapshots', () => {
    expect(build([proposal()], [], [], {
      proposals: { ...proposals([proposal()]), snapshotDigest: 'not-a-digest' },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([proposal()], [], [], {
      enrollment: {
        repos: [repo], sourceState: 'healthy', complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00Z',
      },
    })).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses malformed adverse identities without throwing', () => {
    expect(build([proposal()], [observation({ repo: 'relative/repo' })])).toEqual({
      ok: false, reason: 'adverse-source-incomplete',
    });
  });

  it('requires snapshots captured at the cohort cutoff', () => {
    expect(build([proposal()], [], [], {
      proposals: { ...proposals([proposal()]), capturedAt: '2026-06-19T23:59:59.999Z' },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([proposal()], [], [], {
      enrollment: {
        repos: [repo], sourceState: 'healthy', complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.001Z',
      },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([proposal()], [], [], {
      adverse: { ...adverse(), capturedAt: '2026-06-20T00:00:00.001Z' },
    })).toEqual({ ok: false, reason: 'invalid-input' });
    expect(build([proposal()], [], [], {
      stability: { ...stability(), snapshotDigest: 'not-a-digest' },
    })).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('refuses incomplete branch authority and thrown identity key providers', () => {
    const input = {
      proposals: proposals([proposal()]),
      enrollment: {
        repos: [repo], sourceState: 'healthy' as const, complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
      },
      adverse: adverse(), stability: stability(), cohortStartedAt: '2026-06-01T00:00:00.000Z',
      cutoffAt: '2026-06-20T00:00:00.000Z', windowMs: 604_800_000,
    };
    expect(buildPostMergePopulationV2({
      ...input, enrollment: { ...input.enrollment, defaultBranches: [] },
    }, { identityKey: () => key, verifyReceipt: () => true }))
      .toEqual({ ok: false, reason: 'enrollment-source-incomplete' });
    expect(buildPostMergePopulationV2(input, {
      identityKey: () => { throw new Error('key unavailable'); },
      verifyReceipt: () => true,
    })).toEqual({ ok: false, reason: 'identity-key-unavailable' });
    expect(buildPostMergePopulationV2(input, {
      identityKey: () => key,
      verifyReceipt: () => { throw new Error('verifier unavailable'); },
    })).toEqual({ ok: false, reason: 'receipt-verifier-unavailable' });
  });

  it('accepts Git-valid at-sign and Unicode default branches', () => {
    for (const branch of ['release@next', '发布/稳定']) {
      const result = build([proposal({ remoteHandoff: { ...proposal().remoteHandoff!, base: branch } })],
        [], [], { enrollment: {
          repos: [repo], defaultBranches: [{ repo, branch }], sourceState: 'healthy', complete: true,
          snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
        } });
      expect(result.ok).toBe(true);
    }
  });

  it('uses only evidence observed between the merge and cohort cutoff', () => {
    const before = build([proposal()], [observation({ observedAt: '2026-06-09T23:59:59.999Z' })]);
    expect(before.ok && before.population.members[0]?.reason).toBe('no-terminal-evidence');
    const after = build([proposal()], [observation({ observedAt: '2026-06-20T00:00:00.001Z' })]);
    expect(after.ok && after.population.members[0]?.reason).toBe('no-terminal-evidence');
    const atCutoff = build([proposal()], [observation({ observedAt: '2026-06-20T00:00:00.000Z' })]);
    expect(atCutoff.ok && atCutoff.population.members[0]?.reason).toBe('deterministic-adverse');
  });

  it('refuses duplicate terminal evidence independent of source order', () => {
    expect(build([proposal()], [observation(), observation({ eventId: 'event-2' })])).toEqual({
      ok: false, reason: 'duplicate-evidence',
    });
    const first = build([proposal()]);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const witness = stableWitness(legacyRepoDigest());
    expect(build([proposal()], [], [witness, { ...witness, witnessId: '4'.repeat(64) }])).toEqual({
      ok: false, reason: 'duplicate-evidence',
    });
  });

  it('refuses duplicate proposal ids even when merge identities differ', () => {
    const secondMerge = proposal({ remoteHandoff: {
      ...proposal().remoteHandoff!, mergeCommitOid: '7'.repeat(40),
    } });
    expect(build([proposal(), secondMerge])).toEqual({
      ok: false, reason: 'duplicate-proposal',
    });
  });

  it('keeps historical cohort identity stable when future evidence arrives', () => {
    const baseline = build([proposal()]);
    const futureAdverse = build([proposal()], [observation({
      observedAt: '2026-06-20T00:00:00.001Z',
    })]);
    const futureStable = build([proposal()], [], [stableWitness(legacyRepoDigest(), {
      stableAt: '2026-06-20T00:00:00.001Z',
    })]);
    expect(baseline.ok && futureAdverse.ok &&
      baseline.population.cohortId === futureAdverse.population.cohortId).toBe(true);
    expect(baseline.ok && futureStable.ok &&
      baseline.population.cohortId === futureStable.population.cohortId).toBe(true);

    const witness = stableWitness(legacyRepoDigest());
    const futureManifest: PostMergeStabilityCohortManifest = {
      schemaVersion: 1, recordType: 'cohort-manifest', authority: 'observation-only',
      manifestId: '8'.repeat(64), cohortId: 'cohort-1', partitionDate: '2026-06-21',
      completedAt: '2026-06-21T00:00:00.000Z', memberCount: 1,
      members: [{ witnessId: witness.witnessId, witnessDigest: witness.witnessDigest }],
      attestation: '9'.repeat(64),
    };
    const unreleasedAtCutoff = build([proposal()], [], [], {
      stability: stability([witness], true, [futureManifest]),
    });
    expect(baseline.ok && unreleasedAtCutoff.ok &&
      baseline.population.cohortId === unreleasedAtCutoff.population.cohortId).toBe(true);
  });

  it('binds signed receipt and observation metadata into source digests', () => {
    const original = build([proposal()], [observation()]);
    const changedReceipt = build([proposal({ remoteHandoff: {
      ...proposal().remoteHandoff!, reconciliation: {
        ...proposal().remoteHandoff!.reconciliation!, attestation: 'c'.repeat(64),
      },
    } })], [observation()]);
    const changedEvidence = build([proposal()], [observation({ observedHead: '9'.repeat(40) })]);
    expect(original.ok && changedReceipt.ok &&
      original.population.proposalSourceDigest !== changedReceipt.population.proposalSourceDigest).toBe(true);
    expect(original.ok && changedEvidence.ok &&
      original.population.adverseSourceDigest !== changedEvidence.population.adverseSourceDigest).toBe(true);
    expect(original.ok && changedEvidence.ok &&
      original.population.members[0]?.evidenceDigest !== changedEvidence.population.members[0]?.evidenceDigest)
      .toBe(true);
  });

  it('binds exclusion outcomes and signed release manifests into roots', () => {
    const baseInput = {
      proposals: proposals([proposal()]),
      enrollment: {
        repos: [repo], sourceState: 'healthy' as const, complete: true,
        defaultBranches: [{ repo, branch: 'main' }],
        snapshotDigest: '9'.repeat(64), capturedAt: '2026-06-20T00:00:00.000Z',
      },
      adverse: adverse(), stability: stability(), cohortStartedAt: '2026-06-01T00:00:00.000Z',
      cutoffAt: '2026-06-20T00:00:00.000Z', windowMs: 604_800_000,
    };
    const eligible = buildPostMergePopulationV2(baseInput, {
      identityKey: () => key, verifyReceipt: () => true,
    });
    const invalidReceipt = buildPostMergePopulationV2(baseInput, {
      identityKey: () => key, verifyReceipt: () => false,
    });
    expect(eligible.ok && invalidReceipt.ok &&
      eligible.population.populationDigest !== invalidReceipt.population.populationDigest).toBe(true);

    const manifest: PostMergeStabilityCohortManifest = {
      schemaVersion: 1, recordType: 'cohort-manifest', authority: 'observation-only',
      manifestId: '1'.repeat(64), cohortId: 'cohort-1', partitionDate: '2026-06-17',
      completedAt: '2026-06-17T00:00:00.000Z', memberCount: 0, members: [],
      attestation: '2'.repeat(64),
    };
    const withoutManifest = build([proposal()]);
    const withManifest = build([proposal()], [], [], { stability: stability([], true, [manifest]) });
    expect(withoutManifest.ok && withManifest.ok &&
      withoutManifest.population.stabilitySourceDigest !== withManifest.population.stabilitySourceDigest).toBe(true);
  });

  it('refuses over-limit stability manifest membership', () => {
    const member = { witnessId: '1'.repeat(64), witnessDigest: '2'.repeat(64) };
    const manifest: PostMergeStabilityCohortManifest = {
      schemaVersion: 1, recordType: 'cohort-manifest', authority: 'observation-only',
      manifestId: '3'.repeat(64), cohortId: 'cohort-1', partitionDate: '2026-06-17',
      completedAt: '2026-06-17T00:00:00.000Z', memberCount: 25_001,
      members: Array.from({ length: 25_001 }, () => member), attestation: '4'.repeat(64),
    };
    expect(build([proposal()], [], [], { stability: stability([], true, [manifest]) })).toEqual({
      ok: false, reason: 'source-limit',
    });
  });
});
