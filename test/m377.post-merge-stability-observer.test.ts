import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { Proposal } from '../src/core/types.js';
import type { RegressionGreenObservation } from '../src/core/fleet/regression-sentinel.js';
import { observePostMergeStability } from '../src/core/fleet/post-merge-stability-observer.js';

const NOW = Date.parse('2026-07-12T12:00:00.000Z');
const WINDOW = 7 * 24 * 60 * 60 * 1_000;
const REPO = resolve('/repo');

function green(overrides: Partial<RegressionGreenObservation> = {}): RegressionGreenObservation {
  return {
    authority: 'observation-only',
    head: 'b'.repeat(40),
    verifiedAt: new Date(NOW).toISOString(),
    manifestDigest: 'd'.repeat(64),
    requiredCommandCount: 1,
    workspaceClean: true,
    isolation: 'clean-workspace',
    ...overrides,
  };
}

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  const value = {
    id: 'proposal-1', repo: REPO, origin: 'swarm', kind: 'patch', title: 'fixture', summary: 'fixture',
    status: 'applied', createdAt: '2026-07-01T12:00:00.000Z',
    remoteHandoff: {
      provider: 'github', state: 'merged', base: 'main', branch: 'ashlr/fixture',
      prUrl: 'https://github.com/ashlrai/fixture/pull/1',
      expectedHeadOid: '9'.repeat(40),
      mergeCommitOid: 'a'.repeat(40), mergedAt: '2026-07-01T12:00:00.000Z',
      createdAt: '2026-07-01T11:00:00.000Z',
      reconciliation: {
        schemaVersion: 1, observedAt: '2026-07-01T12:01:00.000Z', attestation: '8'.repeat(64),
      },
    },
    ...overrides,
  } as Proposal;
  if (!Object.hasOwn(overrides, 'realizedMerge')) {
    const handoff = value.remoteHandoff!;
    value.realizedMerge = {
      schemaVersion: 1, source: 'github-host', provider: 'github',
      prUrl: handoff.prUrl!, branch: handoff.branch!, base: handoff.base!,
      expectedHeadOid: handoff.expectedHeadOid!, mergeCommitOid: handoff.mergeCommitOid!,
      mergedAt: handoff.mergedAt!, reconciliation: handoff.reconciliation!,
    };
  }
  return value;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    exists: () => true,
    branch: () => 'main',
    verifiedHandoff: () => true,
    repoDigest: () => 'e'.repeat(64),
    listApplied: () => ({ sourceState: 'healthy', complete: true, proposals: [proposal()] }),
    readAdverse: () => ({ sourceState: 'missing', complete: true, observations: [] }),
    readStability: () => ({ sourceState: 'missing', complete: true, witnesses: [] }),
    inspect: () => ({
      state: 'complete', mergeCommit: 'a'.repeat(40), observedHead: 'b'.repeat(40),
      mergeTimeMs: Date.parse('2026-07-01T12:00:00.000Z'),
      windowStartedAtMs: Date.parse('2026-07-01T12:00:00.000Z'),
      followUpWindowEndMs: Date.parse('2026-07-08T12:00:00.000Z'),
      windowElapsed: true, commitsInspected: 0, adverse: null,
    }),
    record: vi.fn(() => ({
      candidates: 1, eligible: 1, ineligible: 0, cohortsAttempted: 1,
      cohortsRecorded: 1, cohortsReplayed: 0, cohortsFailed: 0, witnessesRecorded: 1,
    })),
    ...overrides,
  };
}

describe('M377 same-run green stable-window observer', () => {
  it('records a stable witness only when complete history matches the fresh green HEAD', () => {
    const deps = dependencies();

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never)).toMatchObject({
      attempted: 1, stable: 1, adverse: 0, inconclusive: 0,
      cohortsRecorded: 1, witnessesRecorded: 1, sourceComplete: true,
    });
    expect(deps.record).toHaveBeenCalledWith([expect.objectContaining({
      repo: REPO,
      proposalId: 'proposal-1',
      mergeCommit: 'a'.repeat(40),
      observedHead: green().head,
      verificationDigest: green().manifestDigest,
      stableAtMs: Date.parse('2026-07-08T12:00:00.000Z'),
    })]);
  });

  it('suppresses known adverse and already-stable members before inspection', () => {
    const inspect = vi.fn();
    const adverse = dependencies({
      inspect,
      readAdverse: () => ({
        sourceState: 'healthy', complete: true,
        observations: [{ repo: REPO, proposalId: 'proposal-1', mergeCommit: 'a'.repeat(40) }],
      }),
    });
    const stable = dependencies({
      inspect,
      readStability: () => ({
        sourceState: 'healthy', complete: true,
        witnesses: [{ repoDigest: 'e'.repeat(64), proposalId: 'proposal-1', mergeCommit: 'a'.repeat(40) }],
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, adverse as never)).toMatchObject({ adverse: 1, stable: 0 });
    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, stable as never)).toMatchObject({ alreadyStable: 1, stable: 0 });
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps missing host identity, time, base, and nonelapsed windows inconclusive', () => {
    const malformed = [
      proposal({ remoteHandoff: { ...proposal().remoteHandoff!, mergeCommitOid: undefined } }),
      proposal({ id: 'proposal-2', remoteHandoff: { ...proposal().remoteHandoff!, mergedAt: undefined } }),
      proposal({ id: 'proposal-3', remoteHandoff: { ...proposal().remoteHandoff!, base: 'develop' } }),
    ];
    const deps = dependencies({
      listApplied: () => ({ sourceState: 'healthy', complete: true, proposals: malformed }),
      inspect: () => ({
        state: 'complete', mergeCommit: 'a'.repeat(40), observedHead: green().head,
        mergeTimeMs: NOW - WINDOW, windowStartedAtMs: NOW - WINDOW,
        followUpWindowEndMs: NOW, windowElapsed: false, commitsInspected: 0, adverse: null,
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, deps as never)).toMatchObject({ attempted: 3, stable: 0, inconclusive: 3 });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('fails closed on degraded sources, stale green evidence, and HEAD mismatch', () => {
    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, dependencies({
      listApplied: () => ({ sourceState: 'degraded', complete: false, proposals: [] }),
    }) as never)).toMatchObject({ attempted: 0, sourceComplete: false });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO],
      greenObservation: green({ verifiedAt: new Date(NOW - 11 * 60 * 1_000).toISOString() }), nowMs: NOW,
    }, dependencies() as never)).toMatchObject({ attempted: 0, sourceComplete: false });

    const mismatch = dependencies({ inspect: () => ({
      state: 'complete', mergeCommit: 'a'.repeat(40), observedHead: 'c'.repeat(40),
      mergeTimeMs: NOW - WINDOW, windowStartedAtMs: NOW - WINDOW,
      followUpWindowEndMs: NOW, windowElapsed: true, commitsInspected: 0, adverse: null,
    }) });
    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, mismatch as never)).toMatchObject({ stable: 0, inconclusive: 1, sourceComplete: true });
  });

  it('contains writer failures and keeps the observation source incomplete', () => {
    const deps = dependencies({ record: vi.fn(() => ({
      candidates: 1, eligible: 1, ineligible: 0, cohortsAttempted: 1,
      cohortsRecorded: 0, cohortsReplayed: 0, cohortsFailed: 1, witnessesRecorded: 0,
    })) });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, deps as never)).toMatchObject({ stable: 1, writeFailed: true, sourceComplete: false });
  });

  it('filters terminal and malformed prefixes before the bounded inspection', () => {
    const terminal = Array.from({ length: 21 }, (_, index) => proposal({
      id: `terminal-${index}`,
      remoteHandoff: { ...proposal().remoteHandoff!, mergeCommitOid: index.toString(16).padStart(40, '0') },
    }));
    const malformed = proposal({ id: 'malformed', remoteHandoff: { ...proposal().remoteHandoff!, mergedAt: undefined } });
    const target = proposal({ id: 'target', remoteHandoff: { ...proposal().remoteHandoff!, mergeCommitOid: 'f'.repeat(40) } });
    const inspect = vi.fn(() => ({
      state: 'complete', mergeCommit: 'f'.repeat(40), observedHead: green().head,
      mergeTimeMs: NOW - WINDOW, windowStartedAtMs: NOW - WINDOW,
      followUpWindowEndMs: NOW, windowElapsed: true, commitsInspected: 0, adverse: null,
    }));
    const deps = dependencies({
      inspect,
      listApplied: () => ({ sourceState: 'healthy', complete: true, proposals: [...terminal, malformed, target] }),
      readStability: () => ({
        sourceState: 'healthy', complete: true,
        witnesses: terminal.map((item) => ({
          repoDigest: 'e'.repeat(64), proposalId: item.id, mergeCommit: item.remoteHandoff!.mergeCommitOid,
        })),
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never)).toMatchObject({ stable: 1, alreadyStable: 21, inconclusive: 1, candidateLimitReached: false });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('bounds synchronous Git inspection to one member and reports incomplete backlog', () => {
    const proposals = [proposal(), proposal({
      id: 'proposal-2', remoteHandoff: { ...proposal().remoteHandoff!, mergeCommitOid: 'c'.repeat(40) },
    })];
    const deps = dependencies({
      listApplied: () => ({ sourceState: 'healthy', complete: true, proposals }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never)).toMatchObject({ candidateLimitReached: true, sourceComplete: false, stable: 1 });
    expect(deps.record).toHaveBeenCalledTimes(1);
  });

  it('advances past an inconclusive member so a bounded observer cannot pin the queue', () => {
    const proposals = [proposal(), proposal({
      id: 'proposal-2', remoteHandoff: { ...proposal().remoteHandoff!, mergeCommitOid: 'c'.repeat(40) },
    })];
    let inspections = 0;
    const deps = dependencies({
      listApplied: () => ({ sourceState: 'healthy', complete: true, proposals }),
      inspect: () => inspections++ === 0
        ? { state: 'inconclusive', reason: 'timeout' }
        : {
            state: 'complete', mergeCommit: 'c'.repeat(40), observedHead: green().head,
            mergeTimeMs: NOW - WINDOW, windowStartedAtMs: NOW - WINDOW,
            followUpWindowEndMs: NOW, windowElapsed: true, commitsInspected: 0, adverse: null,
          },
    });

    const first = observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never);
    expect(first).toMatchObject({ stable: 0, inconclusive: 1, candidateLimitReached: true,
      candidateAfter: { proposalId: 'proposal-1', mergeCommitOid: 'a'.repeat(40) } });
    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
      candidateAfter: first.candidateAfter,
    }, deps as never)).toMatchObject({ stable: 1, candidateLimitReached: true });
    expect(deps.record).toHaveBeenCalledWith([expect.objectContaining({ proposalId: 'proposal-2' })]);
  });

  it('does not let another repository suppress a member with the same public IDs', () => {
    const deps = dependencies({
      readAdverse: () => ({
        sourceState: 'healthy', complete: true,
        observations: [{ repo: resolve('/other'), proposalId: 'proposal-1', mergeCommit: 'a'.repeat(40) }],
      }),
      readStability: () => ({
        sourceState: 'healthy', complete: true,
        witnesses: [{ repoDigest: 'f'.repeat(64), proposalId: 'proposal-1', mergeCommit: 'a'.repeat(40) }],
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never)).toMatchObject({ stable: 1, adverse: 0, alreadyStable: 0 });
  });

  it('lets a concurrent adverse observation supersede a just-inspected stable candidate', () => {
    let reads = 0;
    const deps = dependencies({
      readAdverse: () => ({
        sourceState: 'healthy', complete: true,
        observations: reads++ === 0 ? [] : [{ repo: REPO, proposalId: 'proposal-1', mergeCommit: 'a'.repeat(40) }],
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW, windowMs: WINDOW,
    }, deps as never)).toMatchObject({ stable: 0, adverse: 1, witnessesRecorded: 0 });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('requires a provenance-verified host reconciliation receipt', () => {
    const deps = dependencies({ verifiedHandoff: () => false });
    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, deps as never)).toMatchObject({ stable: 0, inconclusive: 1 });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('rejects legacy applied handoffs without a canonical realized witness', () => {
    const inspect = vi.fn();
    const deps = dependencies({
      inspect,
      listApplied: () => ({
        sourceState: 'healthy', complete: true,
        proposals: [proposal({ realizedMerge: undefined })],
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, deps as never)).toMatchObject({ attempted: 1, stable: 0, inconclusive: 1 });
    expect(inspect).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });

  it('rejects malformed, local, and handoff-mismatched realized witnesses', () => {
    const malformed = proposal({ realizedMerge: {
      schemaVersion: 1, source: 'github-host', provider: 'github',
      prUrl: 'https://github.com/ashlrai/fixture/pull/1', branch: 'ashlr/fixture', base: 'main',
      expectedHeadOid: '9'.repeat(40), mergeCommitOid: 'not-an-oid',
      mergedAt: '2026-07-01T12:00:00.000Z',
      reconciliation: { schemaVersion: 1, observedAt: '2026-07-01T12:01:00.000Z', attestation: '8'.repeat(64) },
    } as Proposal['realizedMerge'] });
    const local = proposal({ id: 'local', realizedMerge: {
      schemaVersion: 1, source: 'local-default-branch', base: 'main',
      baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: 'a'.repeat(40), observedAt: '2026-07-01T12:01:00.000Z',
    } });
    const mismatch = proposal({ id: 'mismatch', realizedMerge: {
      ...proposal().realizedMerge!, mergeCommitOid: 'c'.repeat(40),
    } });
    const inspect = vi.fn();
    const deps = dependencies({
      inspect,
      listApplied: () => ({
        sourceState: 'healthy', complete: true, proposals: [malformed, local, mismatch],
      }),
    });

    expect(observePostMergeStability({
      repo: REPO, enrolledRepos: [REPO], greenObservation: green(), nowMs: NOW,
    }, deps as never)).toMatchObject({ attempted: 3, stable: 0, inconclusive: 3 });
    expect(inspect).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
  });
});
