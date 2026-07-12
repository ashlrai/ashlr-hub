import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  postMergeStabilityRepoDigest,
  recordPostMergeStabilityCohort,
  type PostMergeStabilityCohortInput,
  type PostMergeStabilityWriteResult,
  type PostMergeStabilityWitnessInput,
} from './post-merge-stability.js';

const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const MAX_CANDIDATES = 64;

export interface StableWindowCandidate {
  repo: string;
  proposalId: string;
  mergeCommit: string;
  observedHead: string;
  windowStartedAtMs: number;
  stableAtMs: number;
  windowMs: number;
  /** Same-run green verification manifest supplied by the stability observer. */
  verificationDigest: string;
}

export interface StableWindowProductionResult {
  candidates: number;
  eligible: number;
  ineligible: number;
  cohortsAttempted: number;
  cohortsRecorded: number;
  cohortsReplayed: number;
  cohortsFailed: number;
  witnessesRecorded: number;
}

export type StabilityCohortWriter = (input: PostMergeStabilityCohortInput) => PostMergeStabilityWriteResult;

function canonicalTimestamp(value: number): string | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  try {
    const timestamp = new Date(value).toISOString();
    return Date.parse(timestamp) === value ? timestamp : null;
  } catch {
    return null;
  }
}

function qualifiedWitness(candidate: StableWindowCandidate): Omit<PostMergeStabilityWitnessInput, 'cohortId'> | null {
  if (!candidate || !isAbsolute(candidate.repo) || !candidate.proposalId || candidate.proposalId.length > 240 ||
    !GIT_SHA_RE.test(candidate.mergeCommit) || !GIT_SHA_RE.test(candidate.observedHead) ||
    !Number.isSafeInteger(candidate.windowMs) || candidate.windowMs < 1 ||
    !/^[a-f0-9]{64}$/.test(candidate.verificationDigest)) return null;
  const windowStartedAt = canonicalTimestamp(candidate.windowStartedAtMs);
  const stableAt = canonicalTimestamp(candidate.stableAtMs);
  if (!windowStartedAt || !stableAt || candidate.stableAtMs - candidate.windowStartedAtMs < candidate.windowMs) return null;
  return {
    repo: resolve(candidate.repo),
    proposalId: candidate.proposalId,
    mergeCommit: candidate.mergeCommit,
    observedHead: candidate.observedHead,
    windowStartedAt,
    stableAt,
    windowMs: candidate.windowMs,
    verificationDigest: candidate.verificationDigest,
  };
}

function cohortId(witness: Omit<PostMergeStabilityWitnessInput, 'cohortId'>): string {
  const digest = witness.repo ? postMergeStabilityRepoDigest(witness.repo) : witness.repoDigest;
  return `stable-${createHash('sha256').update(JSON.stringify([
    'ashlr:stable-window-production-member:v1', digest ?? '',
    witness.proposalId, witness.mergeCommit,
  ])).digest('hex')}`;
}

/**
 * Persist only positive, window-complete observations. This deliberately does
 * not claim denominator completeness; adverse and inconclusive members belong
 * in the separate observation ledger until a signed population manifest exists.
 */
export function recordStableWindowWitnesses(
  candidates: readonly StableWindowCandidate[],
  writer: StabilityCohortWriter = (input) => recordPostMergeStabilityCohort(input, { lockWaitMs: 0 }),
): StableWindowProductionResult {
  const result: StableWindowProductionResult = {
    candidates: Array.isArray(candidates) ? candidates.length : 0,
    eligible: 0,
    ineligible: 0,
    cohortsAttempted: 0,
    cohortsRecorded: 0,
    cohortsReplayed: 0,
    cohortsFailed: 0,
    witnessesRecorded: 0,
  };
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    result.ineligible = result.candidates;
    return result;
  }
  const unique = new Map<string, Omit<PostMergeStabilityWitnessInput, 'cohortId'>>();
  const conflicts = new Set<string>();
  for (const candidate of candidates) {
    const witness = qualifiedWitness(candidate);
    if (!witness) {
      result.ineligible++;
      continue;
    }
    const key = JSON.stringify([witness.proposalId, witness.mergeCommit]);
    if (conflicts.has(key)) {
      result.ineligible++;
      continue;
    }
    const existing = unique.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(witness)) {
      result.ineligible++;
      unique.delete(key);
      conflicts.add(key);
      continue;
    }
    if (!existing) unique.set(key, witness);
  }
  result.eligible = unique.size;
  const ordered = [...unique.values()].sort((left, right) => JSON.stringify([
    left.repo, left.proposalId, left.mergeCommit,
  ]).localeCompare(JSON.stringify([right.repo, right.proposalId, right.mergeCommit])));
  // One logical member per cohort makes replay identity independent of which
  // other repositories or proposals happened to be observed in the same tick.
  for (const witness of ordered) {
    const id = cohortId(witness);
    result.cohortsAttempted++;
    let written: PostMergeStabilityWriteResult;
    try {
      written = writer({
        cohortId: id,
        completedAt: witness.stableAt,
        witnesses: [{ ...witness, cohortId: id }],
      });
    } catch {
      result.cohortsFailed++;
      continue;
    }
    result.cohortsRecorded += written.recorded;
    result.cohortsReplayed += written.replayed;
    result.witnessesRecorded += written.witnessesRecorded;
    result.cohortsFailed += written.failed + written.invalid + written.conflicted;
  }
  return result;
}
