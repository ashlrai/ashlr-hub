import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Proposal } from '../types.js';
import { defaultBranch } from '../git.js';
import { listProposalsDetailed, type ProposalsReadResult } from '../inbox/store.js';
import { sanitizeGithubMergedAt } from '../inbox/remote-handoff-time.js';
import { readPostMergeObservations, type PostMergeObservationReadResult } from './post-merge-observations.js';
import {
  postMergeStabilityRepoDigest,
  readPostMergeStability,
  type PostMergeStabilityReadResult,
} from './post-merge-stability.js';
import { inspectPostMergeWindow, type PostMergeWindowResult } from './post-merge-window.js';
import {
  recordStableWindowWitnesses,
  type StableWindowCandidate,
  type StableWindowProductionResult,
} from './post-merge-stability-producer.js';
import type { RegressionGreenObservation } from './regression-sentinel.js';
import { verifyRemoteHandoffReconciliation } from '../inbox/remote-handoff-attestation.js';
import { outcomeCandidateKey, selectSuccessorsWithWrap, type MonitoringOutcomeCandidateCursor } from './monitoring-cursor.js';

const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const MAX_INSPECTIONS_PER_TICK = 1;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_GREEN_AGE_MS = 10 * 60 * 1_000;
const INSPECTION_DEADLINE_MS = 5_000;

export interface PostMergeStabilityObservationResult {
  attempted: number;
  stable: number;
  alreadyStable: number;
  adverse: number;
  inconclusive: number;
  witnessesRecorded: number;
  cohortsRecorded: number;
  cohortsReplayed: number;
  writeFailed: boolean;
  sourceComplete: boolean;
  candidateLimitReached: boolean;
  candidateAfter: MonitoringOutcomeCandidateCursor | null;
}

interface ObserverDependencies {
  listApplied: () => ProposalsReadResult;
  readAdverse: () => PostMergeObservationReadResult;
  readStability: () => PostMergeStabilityReadResult;
  inspect: typeof inspectPostMergeWindow;
  branch: (repo: string) => string;
  exists: (repo: string) => boolean;
  verifiedHandoff: (proposal: Proposal) => boolean;
  repoDigest: (repo: string) => string | null;
  record: (candidates: readonly StableWindowCandidate[]) => StableWindowProductionResult;
}

const DEFAULT_DEPENDENCIES: ObserverDependencies = {
  listApplied: () => listProposalsDetailed({ status: 'applied', requireComplete: true }),
  readAdverse: () => readPostMergeObservations({ requireComplete: true, lockWaitMs: 0 }),
  readStability: () => readPostMergeStability({ requireComplete: true, lockWaitMs: 0 }),
  inspect: inspectPostMergeWindow,
  branch: defaultBranch,
  exists: existsSync,
  verifiedHandoff: (proposal) => Boolean(proposal.repo && proposal.remoteHandoff &&
    verifyRemoteHandoffReconciliation(proposal.id, proposal.repo, proposal.remoteHandoff)),
  repoDigest: postMergeStabilityRepoDigest,
  record: recordStableWindowWitnesses,
};

function initialResult(): PostMergeStabilityObservationResult {
  return {
    attempted: 0, stable: 0, alreadyStable: 0, adverse: 0, inconclusive: 0,
    witnessesRecorded: 0, cohortsRecorded: 0, cohortsReplayed: 0,
    writeFailed: false, sourceComplete: true, candidateLimitReached: false,
    candidateAfter: null,
  };
}

function canonicalRepo(value: string): string | null {
  if (!isAbsolute(value) || value.length > 4_096) return null;
  try { return resolve(value); } catch { return null; }
}

function freshGreenObservation(
  green: RegressionGreenObservation,
  nowMs: number,
): green is RegressionGreenObservation {
  const verifiedAt = Date.parse(green?.verifiedAt ?? '');
  return green?.authority === 'observation-only' &&
    (green.isolation === 'clean-workspace' || green.isolation === 'detached-worktree') &&
    GIT_SHA_RE.test(green.head) && /^[a-f0-9]{64}$/.test(green.manifestDigest) &&
    Number.isSafeInteger(green.requiredCommandCount) && green.requiredCommandCount > 0 &&
    green.workspaceClean === true && Number.isFinite(verifiedAt) &&
    verifiedAt <= nowMs + 60_000 && nowMs - verifiedAt <= MAX_GREEN_AGE_MS;
}

function sameAdverseMember(
  row: { repo?: string; proposalId: string; mergeCommit: string },
  repo: string,
  proposal: Proposal,
): boolean {
  return canonicalRepo(row.repo ?? '') === repo &&
    row.proposalId === proposal.id && row.mergeCommit === proposal.remoteHandoff?.mergeCommitOid;
}

function sameStableMember(
  row: { repoDigest?: string; proposalId: string; mergeCommit: string },
  repoDigest: string,
  proposal: Proposal,
): boolean {
  return row.repoDigest === repoDigest &&
    row.proposalId === proposal.id && row.mergeCommit === proposal.remoteHandoff?.mergeCommitOid;
}

/**
 * Produce positive stable-window observations only after the selected repo has
 * a fresh same-run green HEAD. This never claims denominator completeness and
 * never mutates routing, proposals, skills, or merge policy.
 */
export function observePostMergeStability(
  input: {
    repo: string;
    enrolledRepos: readonly string[];
    greenObservation: RegressionGreenObservation;
    nowMs?: number;
    windowMs?: number;
    candidateAfter?: MonitoringOutcomeCandidateCursor | null;
  },
  dependencies: Partial<ObserverDependencies> = {},
): PostMergeStabilityObservationResult {
  const result = initialResult();
  try {
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const nowMs = input.nowMs ?? Date.now();
    const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;
    const repo = canonicalRepo(input.repo);
    const enrollment = new Set(input.enrolledRepos.map(canonicalRepo).filter((value): value is string => value !== null));
    if (!repo || !deps.exists(repo) || !enrollment.has(repo) ||
      !Number.isSafeInteger(windowMs) || windowMs < 1 || !freshGreenObservation(input.greenObservation, nowMs)) {
      result.sourceComplete = false;
      return result;
    }
    const proposals = deps.listApplied();
    const adverse = deps.readAdverse();
    const stability = deps.readStability();
    if (proposals.sourceState !== 'healthy' || !proposals.complete ||
      adverse.sourceState === 'degraded' || !adverse.complete ||
      stability.sourceState === 'degraded' || !stability.complete) {
      result.sourceComplete = false;
      return result;
    }
    const base = deps.branch(repo);
    const digest = deps.repoDigest(repo);
    if (!digest) {
      result.sourceComplete = false;
      return result;
    }
    const repoProposals = proposals.proposals.filter((proposal) => proposal.repo !== null &&
      canonicalRepo(proposal.repo) === repo);
    const ordered = [...repoProposals].sort((left, right) => {
      const leftAt = Date.parse(left.remoteHandoff?.mergedAt ?? '') || 0;
      const rightAt = Date.parse(right.remoteHandoff?.mergedAt ?? '') || 0;
      return leftAt - rightAt || left.id.localeCompare(right.id);
    });
    const stableCandidates: StableWindowCandidate[] = [];
    const inspectable: Array<{ proposal: Proposal; mergedAt: string }> = [];
    for (const proposal of ordered) {
      result.attempted++;
      const handoff = proposal.remoteHandoff;
      const mergedAt = sanitizeGithubMergedAt(handoff?.mergedAt);
      if (proposal.status !== 'applied' || handoff?.provider !== 'github' || handoff.state !== 'merged' ||
        handoff.base !== base || !GIT_SHA_RE.test(handoff.mergeCommitOid ?? '') || !mergedAt ||
        !deps.verifiedHandoff(proposal)) {
        result.inconclusive++;
        continue;
      }
      // Signed adverse evidence has monotonic precedence over a positive
      // window witness if historical or concurrent stores ever overlap.
      if (adverse.observations.some((row) => sameAdverseMember(row, repo, proposal))) {
        result.adverse++;
        continue;
      }
      if (stability.witnesses.some((row) => sameStableMember(row, digest, proposal))) {
        result.alreadyStable++;
        continue;
      }
      if (Date.parse(mergedAt) + windowMs > nowMs) {
        result.inconclusive++;
        continue;
      }
      inspectable.push({ proposal, mergedAt });
    }
    if (inspectable.length > MAX_INSPECTIONS_PER_TICK) {
      result.candidateLimitReached = true;
      result.sourceComplete = false;
    }
    const selected = selectSuccessorsWithWrap(
      inspectable,
      input.candidateAfter ? outcomeCandidateKey(input.candidateAfter) : null,
      MAX_INSPECTIONS_PER_TICK,
      ({ proposal }) => outcomeCandidateKey({
        proposalId: proposal.id,
        mergeCommitOid: proposal.remoteHandoff!.mergeCommitOid!,
      }),
    ).selected;
    for (const { proposal, mergedAt } of selected) {
      const handoff = proposal.remoteHandoff!;
      result.candidateAfter = { proposalId: proposal.id, mergeCommitOid: handoff.mergeCommitOid! };
      const inspection: PostMergeWindowResult = deps.inspect({
        repo,
        mergeCommit: handoff.mergeCommitOid!,
        observedAtMs: nowMs,
        followUpWindowMs: windowMs,
        windowStartedAtMs: Date.parse(mergedAt),
      }, { deadlineMs: INSPECTION_DEADLINE_MS });
      if (inspection.state !== 'complete' || !inspection.windowElapsed ||
        inspection.observedHead !== input.greenObservation.head) {
        result.inconclusive++;
        continue;
      }
      if (inspection.adverse !== null) {
        result.adverse++;
        continue;
      }
      stableCandidates.push({
        repo,
        proposalId: proposal.id,
        mergeCommit: inspection.mergeCommit,
        observedHead: inspection.observedHead,
        windowStartedAtMs: inspection.windowStartedAtMs,
        stableAtMs: inspection.followUpWindowEndMs,
        windowMs,
        verificationDigest: input.greenObservation.manifestDigest,
      });
    }
    if (stableCandidates.length === 0) return result;
    // Re-read both signed stores after the expensive Git inspection. Adverse
    // evidence wins, and a concurrent stable replay suppresses duplicate work.
    const finalAdverse = deps.readAdverse();
    const finalStability = deps.readStability();
    if (finalAdverse.sourceState === 'degraded' || !finalAdverse.complete ||
      finalStability.sourceState === 'degraded' || !finalStability.complete) {
      result.inconclusive += stableCandidates.length;
      result.sourceComplete = false;
      return result;
    }
    const finalCandidates = stableCandidates.filter((candidate) => {
      const identity = { id: candidate.proposalId, remoteHandoff: { mergeCommitOid: candidate.mergeCommit } } as Proposal;
      if (finalAdverse.observations.some((row) => sameAdverseMember(row, repo, identity))) {
        result.adverse++;
        return false;
      }
      if (finalStability.witnesses.some((row) => sameStableMember(row, digest, identity))) {
        result.alreadyStable++;
        return false;
      }
      return true;
    });
    result.stable = finalCandidates.length;
    if (finalCandidates.length === 0) return result;
    const written = deps.record(finalCandidates);
    result.witnessesRecorded = written.witnessesRecorded;
    result.cohortsRecorded = written.cohortsRecorded;
    result.cohortsReplayed = written.cohortsReplayed;
    result.writeFailed = written.cohortsFailed > 0 ||
      written.cohortsRecorded + written.cohortsReplayed < 1;
    if (result.writeFailed) result.sourceComplete = false;
    return result;
  } catch {
    result.sourceComplete = false;
    return result;
  }
}
