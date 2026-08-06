import { isAbsolute, resolve } from 'node:path';
import type { Proposal } from '../types.js';
import { authenticatedRealizedMergeOf } from '../inbox/realized-merge.js';
import type { PostMergeObservationReadResult } from './post-merge-observations.js';
import {
  postMergeStabilityRepoDigest,
  type PostMergeStabilityReadResult,
} from './post-merge-stability.js';

const GIT_SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DEFAULT_MINIMUM_STABLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 60_000;

export interface ProtectedMergePopulationSnapshot {
  merges: Array<{
    repo: string;
    proposalId: string;
    mergeCommit: string;
    mergedAt: string;
  }>;
  sourceState: 'missing' | 'healthy' | 'degraded';
  sourcePresent: boolean;
  complete: boolean;
  stopReasons: string[];
  capturedAt: string;
}

export interface PostMergeDenominatorProjection {
  sourceComplete: boolean;
  denominatorComplete: boolean;
  protectedMerges: number;
  observedMerges: number;
  unmatchedMerges: number;
  matchedAdverse: PostMergeObservationReadResult['observations'];
  matchedStability: PostMergeStabilityReadResult['witnesses'];
  stopReasons: string[];
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function canonicalRepo(value: unknown): string | null {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) return null;
  try { return resolve(value); } catch { return null; }
}

function rawIdentity(repo: string, proposalId: string, mergeCommit: string): string {
  return JSON.stringify([repo, proposalId, mergeCommit]);
}

function digestIdentity(repoDigest: string, proposalId: string, mergeCommit: string): string {
  return JSON.stringify([repoDigest, proposalId, mergeCommit]);
}

/**
 * Build the exact protected-host merge population from authenticated proposal
 * receipts. A partial proposal source or one malformed protected merge makes
 * the whole snapshot unusable instead of silently shrinking the denominator.
 */
export function buildProtectedMergePopulationSnapshot(input: {
  proposals: readonly Proposal[];
  proposalSource: {
    sourceState: 'missing' | 'healthy' | 'degraded';
    sourcePresent: boolean;
    complete: boolean;
    stopReasons: readonly string[];
  };
  capturedAt: string;
}, dependencies: {
  readRealizedMerge?: typeof authenticatedRealizedMergeOf;
} = {}): ProtectedMergePopulationSnapshot {
  const readRealizedMerge = dependencies.readRealizedMerge ?? authenticatedRealizedMergeOf;
  const capturedAt = canonicalTimestamp(input.capturedAt);
  const unavailable = (reason: string): ProtectedMergePopulationSnapshot => ({
    merges: [],
    sourceState: input.proposalSource.sourceState === 'missing' ? 'missing' : 'degraded',
    sourcePresent: input.proposalSource.sourcePresent,
    complete: false,
    stopReasons: [...new Set([...input.proposalSource.stopReasons, reason])],
    capturedAt: capturedAt ?? input.capturedAt,
  });
  if (!capturedAt) return unavailable('protected-merge-snapshot-time-invalid');
  if (input.proposalSource.sourceState !== 'healthy' || !input.proposalSource.complete) {
    return unavailable(input.proposalSource.sourceState === 'missing'
      ? 'protected-merge-source-missing'
      : 'protected-merge-source-incomplete');
  }

  const merges: ProtectedMergePopulationSnapshot['merges'] = [];
  const identities = new Set<string>();
  for (const proposal of input.proposals) {
    const claimsHostMerge = proposal.remoteHandoff?.state === 'merged' ||
      proposal.realizedMerge?.source === 'github-host';
    if (!claimsHostMerge) continue;
    if (proposal.status !== 'applied') return unavailable('protected-merge-reconciliation-failed');

    let realized: ReturnType<typeof authenticatedRealizedMergeOf>;
    try { realized = readRealizedMerge(proposal); } catch { realized = null; }
    const repo = canonicalRepo(proposal.repo);
    if (!repo || realized?.source !== 'github-host' ||
      !GIT_SHA_RE.test(realized.mergeCommitOid) || !canonicalTimestamp(realized.mergedAt) ||
      Date.parse(realized.mergedAt) > Date.parse(capturedAt)) {
      return unavailable('protected-merge-reconciliation-failed');
    }
    const identity = rawIdentity(repo, proposal.id, realized.mergeCommitOid);
    if (identities.has(identity)) return unavailable('protected-merge-duplicate');
    identities.add(identity);
    merges.push({
      repo,
      proposalId: proposal.id,
      mergeCommit: realized.mergeCommitOid,
      mergedAt: realized.mergedAt,
    });
  }
  merges.sort((left, right) => rawIdentity(left.repo, left.proposalId, left.mergeCommit)
    .localeCompare(rawIdentity(right.repo, right.proposalId, right.mergeCommit)));
  return {
    merges,
    sourceState: 'healthy',
    sourcePresent: input.proposalSource.sourcePresent,
    complete: true,
    stopReasons: [],
    capturedAt,
  };
}

/**
 * Join one coherent protected-merge snapshot to authenticated adverse and
 * manifest-released stability rows. This is observation-only bookkeeping: it
 * cannot grant readiness, learning, merge, rollback, or deployment authority.
 */
export function projectPostMergeDenominator(input: {
  population: ProtectedMergePopulationSnapshot;
  adverse: PostMergeObservationReadResult;
  stability: PostMergeStabilityReadResult;
  observedAt: string;
  now?: string;
  minimumStableWindowMs?: number;
  maxSnapshotAgeMs?: number;
}): PostMergeDenominatorProjection {
  const stopReasons = new Set<string>([
    ...input.population.stopReasons,
    ...input.adverse.stopReasons,
    ...input.stability.stopReasons,
  ]);
  const refuse = (reason: string): PostMergeDenominatorProjection => {
    stopReasons.add(reason);
    return {
      sourceComplete: false,
      denominatorComplete: false,
      protectedMerges: input.population.merges.length,
      observedMerges: 0,
      unmatchedMerges: input.population.merges.length,
      matchedAdverse: [],
      matchedStability: [],
      stopReasons: [...stopReasons],
    };
  };
  const observedAt = canonicalTimestamp(input.observedAt);
  const now = canonicalTimestamp(input.now ?? input.observedAt);
  const minimumStableWindowMs = input.minimumStableWindowMs ?? DEFAULT_MINIMUM_STABLE_WINDOW_MS;
  const maxSnapshotAgeMs = input.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  if (!observedAt || !now || !Number.isSafeInteger(minimumStableWindowMs) || minimumStableWindowMs < 1 ||
    !Number.isSafeInteger(maxSnapshotAgeMs) || maxSnapshotAgeMs < 0) {
    return refuse('post-merge-snapshot-time-invalid');
  }
  if (input.population.sourceState !== 'healthy' || !input.population.complete ||
    input.adverse.sourceState !== 'healthy' || !input.adverse.complete ||
    input.stability.sourceState !== 'healthy' || !input.stability.complete) {
    if (input.population.sourceState === 'missing') stopReasons.add('protected-merge-source-missing');
    if (input.adverse.sourceState === 'missing') stopReasons.add('adverse-source-missing');
    if (input.stability.sourceState === 'missing') stopReasons.add('stability-source-missing');
    return refuse('post-merge-source-incomplete');
  }
  if (input.population.capturedAt !== observedAt || Date.parse(now) < Date.parse(observedAt) ||
    Date.parse(now) - Date.parse(observedAt) > maxSnapshotAgeMs) {
    return refuse('post-merge-snapshot-stale');
  }

  const rawPopulation = new Map<string, ProtectedMergePopulationSnapshot['merges'][number]>();
  const digestPopulation = new Map<string, ProtectedMergePopulationSnapshot['merges'][number]>();
  for (const merge of input.population.merges) {
    const repo = canonicalRepo(merge.repo);
    const mergedAt = canonicalTimestamp(merge.mergedAt);
    const repoDigest = repo ? postMergeStabilityRepoDigest(repo) : null;
    if (!repo || !repoDigest || !mergedAt || !GIT_SHA_RE.test(merge.mergeCommit) ||
      Date.parse(mergedAt) > Date.parse(observedAt)) {
      return refuse('protected-merge-reconciliation-failed');
    }
    const raw = rawIdentity(repo, merge.proposalId, merge.mergeCommit);
    const digest = digestIdentity(repoDigest, merge.proposalId, merge.mergeCommit);
    if (rawPopulation.has(raw) || digestPopulation.has(digest)) {
      return refuse('protected-merge-duplicate');
    }
    rawPopulation.set(raw, merge);
    digestPopulation.set(digest, merge);
  }

  const matchedAdverse: PostMergeObservationReadResult['observations'] = [];
  const matchedStability: PostMergeStabilityReadResult['witnesses'] = [];
  const observed = new Set<string>();
  const adverseIdentities = new Set<string>();
  for (const row of input.adverse.observations) {
    const repo = canonicalRepo(row.repo);
    const observedAtRow = canonicalTimestamp(row.observedAt);
    if (!repo || !observedAtRow) return refuse('post-merge-evidence-invalid');
    const identity = rawIdentity(repo, row.proposalId, row.mergeCommit);
    const merge = rawPopulation.get(identity);
    if (!merge) return refuse('post-merge-evidence-orphaned');
    if (adverseIdentities.has(identity)) return refuse('post-merge-evidence-duplicate');
    if (Date.parse(observedAtRow) < Date.parse(merge.mergedAt) ||
      Date.parse(observedAtRow) > Date.parse(observedAt)) {
      return refuse('post-merge-evidence-stale');
    }
    adverseIdentities.add(identity);
    observed.add(identity);
    matchedAdverse.push(row);
  }

  const stabilityIdentities = new Set<string>();
  for (const row of input.stability.witnesses) {
    const stableAt = canonicalTimestamp(row.stableAt);
    const windowStartedAt = canonicalTimestamp(row.windowStartedAt);
    const identity = digestIdentity(row.repoDigest, row.proposalId, row.mergeCommit);
    const merge = digestPopulation.get(identity);
    if (!merge) return refuse('post-merge-evidence-orphaned');
    if (stabilityIdentities.has(identity)) return refuse('post-merge-evidence-duplicate');
    if (!stableAt || !windowStartedAt || row.windowMs < minimumStableWindowMs ||
      Date.parse(windowStartedAt) < Date.parse(merge.mergedAt) ||
      Date.parse(stableAt) > Date.parse(observedAt) ||
      Date.parse(stableAt) - Date.parse(merge.mergedAt) < minimumStableWindowMs) {
      return refuse('post-merge-evidence-stale');
    }
    stabilityIdentities.add(identity);
    const raw = rawIdentity(merge.repo, merge.proposalId, merge.mergeCommit);
    if (!adverseIdentities.has(raw)) matchedStability.push(row);
    observed.add(raw);
  }

  const unmatchedMerges = Math.max(0, rawPopulation.size - observed.size);
  return {
    sourceComplete: true,
    denominatorComplete: unmatchedMerges === 0,
    protectedMerges: rawPopulation.size,
    observedMerges: observed.size,
    unmatchedMerges,
    matchedAdverse,
    matchedStability,
    stopReasons: [...stopReasons],
  };
}
