import { createHash, createHmac } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { Proposal } from '../types.js';
import type { ProposalsReadResult } from '../inbox/store.js';
import { verifyRemoteHandoffReconciliation } from '../inbox/remote-handoff-attestation.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import type { PostMergeObservationReadResult } from './post-merge-observations.js';
import type { PostMergeStabilityReadResult } from './post-merge-stability.js';

const SCOPE = 'cutoff-enrolled-local-receipt-qualified-applied-proposals/v1';
const SHA_RE = /^[a-f0-9]{40}$/;
const MAX_PROPOSALS = 4_096;
const MAX_ENROLLED = 1_024;
const MAX_EVIDENCE_ROWS = 25_000;
const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;

export type PostMergePopulationExclusionReason =
  | 'not-applied'
  | 'repo-missing'
  | 'repo-not-enrolled'
  | 'handoff-missing'
  | 'handoff-not-merged'
  | 'base-mismatch'
  | 'merge-oid-invalid'
  | 'merge-time-invalid'
  | 'outside-window'
  | 'receipt-invalid';

export type PostMergePopulationRefusalReason =
  | 'invalid-input'
  | 'proposal-source-incomplete'
  | 'enrollment-source-incomplete'
  | 'adverse-source-incomplete'
  | 'stability-source-incomplete'
  | 'source-limit'
  | 'identity-key-unavailable'
  | 'receipt-verifier-unavailable'
  | 'duplicate-proposal'
  | 'duplicate-merge'
  | 'duplicate-evidence';

export interface ProposalSnapshotV2 extends ProposalsReadResult {
  snapshotDigest: string;
  capturedAt: string;
}

export interface EnrollmentSnapshotV2 {
  repos: readonly string[];
  defaultBranches: readonly { repo: string; branch: string }[];
  sourceState: 'missing' | 'healthy' | 'degraded';
  complete: boolean;
  snapshotDigest: string;
  capturedAt: string;
}

export interface ObservationSnapshotV2 extends PostMergeObservationReadResult {
  snapshotDigest: string;
  capturedAt: string;
}

export interface StabilitySnapshotV2 extends PostMergeStabilityReadResult {
  snapshotDigest: string;
  capturedAt: string;
}

export interface PostMergePopulationMemberV2 {
  memberId: string;
  repoDigest: string;
  proposalDigest: string;
  mergeDigest: string;
  classification: 'adverse' | 'inconclusive';
  reason: 'deterministic-adverse' | 'heuristic-adverse' | 'legacy-isolation-unknown' | 'no-terminal-evidence';
  evidenceDigest: string;
}

export interface PostMergePopulationV2 {
  schemaVersion: 2;
  authority: 'observation-only';
  scope: typeof SCOPE;
  policyEligible: false;
  denominatorComplete: false;
  conclusiveComplete: boolean;
  cohortId: string;
  cohortStartedAt: string;
  eligibleThroughAt: string;
  cutoffAt: string;
  windowMs: number;
  enrollmentDigest: string;
  proposalSourceDigest: string;
  adverseSourceDigest: string;
  stabilitySourceDigest: string;
  populationDigest: string;
  eligible: number;
  excluded: number;
  adverse: number;
  inconclusive: number;
  exclusions: Record<PostMergePopulationExclusionReason, number>;
  members: PostMergePopulationMemberV2[];
}

export type BuildPostMergePopulationV2Result =
  | { ok: true; population: PostMergePopulationV2 }
  | { ok: false; reason: PostMergePopulationRefusalReason };

interface PopulationDependencies {
  verifyReceipt: (proposal: Proposal) => boolean;
  identityKey: () => Buffer | null;
}

function sha(tuple: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
}

function hmac(key: Buffer, domain: string, value: string): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, value])).digest('hex');
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

function canonicalBranch(value: unknown): string | null {
  const forbidden = '~^:?*[\\';
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 1_024 ||
    value === '@' || [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code <= 32 || code === 127 || forbidden.includes(char);
    }) || value.includes('..') ||
    value.includes('@{') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return null;
  const components = value.split('/');
  if (components.some((part) => !part || part.startsWith('.') || part.endsWith('.lock'))) return null;
  return value;
}

function emptyExclusions(): Record<PostMergePopulationExclusionReason, number> {
  return {
    'not-applied': 0, 'repo-missing': 0, 'repo-not-enrolled': 0,
    'handoff-missing': 0, 'handoff-not-merged': 0,
    'base-mismatch': 0, 'merge-oid-invalid': 0, 'merge-time-invalid': 0,
    'outside-window': 0, 'receipt-invalid': 0,
  };
}

function sourceHealthy(source: { sourceState: string; complete: boolean }): boolean {
  return source.sourceState !== 'degraded' && source.complete;
}

function metadataTuple(key: Buffer, proposal: Proposal): unknown[] {
  const repo = canonicalRepo(proposal.repo);
  const handoff = proposal.remoteHandoff;
  return [
    hmac(key, 'ashlr:post-merge-v2:proposal', proposal.id),
    repo ? hmac(key, 'ashlr:post-merge-v2:repo', repo) : null,
    proposal.status,
    handoff?.provider ?? null,
    handoff?.state ?? null,
    handoff?.base ?? null,
    handoff?.mergeCommitOid ? hmac(key, 'ashlr:post-merge-v2:merge', handoff.mergeCommitOid) : null,
    handoff?.mergedAt ?? null,
    handoff?.reconciliation?.schemaVersion ?? null,
    handoff?.reconciliation?.observedAt ?? null,
    handoff?.reconciliation?.attestation ?? null,
  ];
}

function adverseTuple(
  key: Buffer,
  repo: string,
  row: PostMergeObservationReadResult['observations'][number],
): unknown[] {
  return [
    hmac(key, 'ashlr:post-merge-v2:repo', repo),
    hmac(key, 'ashlr:post-merge-v2:proposal', row.proposalId),
    hmac(key, 'ashlr:post-merge-v2:merge', row.mergeCommit),
    row.schemaVersion, row.eventId, row.observedAt, row.authority, row.outcome, row.basis,
    row.confidence, row.runId ?? null, row.trajectoryId ?? null, row.workItemId ?? null,
    row.observedHead, row.baselineHead ?? null, row.candidateCount ?? null,
    row.commandKinds ?? null, row.labelBasis, row.attestation,
  ];
}

function stabilityTuple(
  key: Buffer,
  row: PostMergeStabilityReadResult['witnesses'][number],
): unknown[] {
  return [
    row.repoDigest, hmac(key, 'ashlr:post-merge-v2:proposal', row.proposalId),
    hmac(key, 'ashlr:post-merge-v2:merge', row.mergeCommit), row.schemaVersion, row.recordType,
    row.authority, row.witnessId, row.cohortId, row.observedHead, row.windowStartedAt,
    row.stableAt, row.windowMs, row.verificationDigest, row.witnessDigest, row.attestation,
  ];
}

function stabilityManifestTuple(row: PostMergeStabilityReadResult['manifests'][number]): unknown[] {
  return [
    row.schemaVersion, row.recordType, row.authority, row.manifestId, row.cohortId,
    row.partitionDate, row.completedAt, row.memberCount, row.members, row.attestation,
  ];
}

function exclusionReason(
  proposal: Proposal,
  enrolled: ReadonlySet<string>,
  defaultBranches: ReadonlyMap<string, string>,
  startedMs: number,
  eligibleThroughMs: number,
  deps: PopulationDependencies,
): { reason: PostMergePopulationExclusionReason } |
  { refusal: 'receipt-verifier-unavailable' } |
  { repo: string; mergedAt: string } {
  if (proposal.status !== 'applied') return { reason: 'not-applied' };
  const repo = canonicalRepo(proposal.repo);
  if (!repo) return { reason: 'repo-missing' };
  if (!enrolled.has(repo)) return { reason: 'repo-not-enrolled' };
  const handoff = proposal.remoteHandoff;
  if (!handoff || handoff.provider !== 'github') return { reason: 'handoff-missing' };
  if (handoff.state !== 'merged') return { reason: 'handoff-not-merged' };
  const branch = defaultBranches.get(repo)!;
  if (handoff.base !== branch) return { reason: 'base-mismatch' };
  if (!SHA_RE.test(handoff.mergeCommitOid ?? '')) return { reason: 'merge-oid-invalid' };
  const mergedAt = canonicalTimestamp(handoff.mergedAt);
  if (!mergedAt) return { reason: 'merge-time-invalid' };
  const mergedMs = Date.parse(mergedAt);
  if (mergedMs < startedMs || mergedMs > eligibleThroughMs) return { reason: 'outside-window' };
  try {
    if (!deps.verifyReceipt(proposal)) return { reason: 'receipt-invalid' };
  } catch { return { refusal: 'receipt-verifier-unavailable' }; }
  return { repo, mergedAt };
}

export function buildPostMergePopulationV2(
  input: {
    proposals: ProposalSnapshotV2;
    enrollment: EnrollmentSnapshotV2;
    adverse: ObservationSnapshotV2;
    stability: StabilitySnapshotV2;
    cohortStartedAt: string;
    cutoffAt: string;
    windowMs: number;
  },
  dependencies: Partial<PopulationDependencies> = {},
): BuildPostMergePopulationV2Result {
  const deps: PopulationDependencies = {
    verifyReceipt: (proposal) => Boolean(proposal.repo && proposal.remoteHandoff &&
      verifyRemoteHandoffReconciliation(proposal.id, proposal.repo, proposal.remoteHandoff)),
    identityKey: () => { try { return loadExistingProvenanceKey(); } catch { return null; } },
    ...dependencies,
  };
  const startedAt = canonicalTimestamp(input.cohortStartedAt);
  const cutoffAt = canonicalTimestamp(input.cutoffAt);
  if (!startedAt || !cutoffAt || !Number.isSafeInteger(input.windowMs) || input.windowMs < 1 ||
    input.windowMs > MAX_WINDOW_MS) return { ok: false, reason: 'invalid-input' };
  const proposalCapturedAt = canonicalTimestamp(input.proposals.capturedAt);
  const enrollmentCapturedAt = canonicalTimestamp(input.enrollment.capturedAt);
  const adverseCapturedAt = canonicalTimestamp(input.adverse.capturedAt);
  const stabilityCapturedAt = canonicalTimestamp(input.stability.capturedAt);
  if (!proposalCapturedAt || !enrollmentCapturedAt || !adverseCapturedAt || !stabilityCapturedAt ||
    !/^[a-f0-9]{64}$/.test(input.proposals.snapshotDigest) ||
    !/^[a-f0-9]{64}$/.test(input.enrollment.snapshotDigest) ||
    !/^[a-f0-9]{64}$/.test(input.adverse.snapshotDigest) ||
    !/^[a-f0-9]{64}$/.test(input.stability.snapshotDigest)) {
    return { ok: false, reason: 'invalid-input' };
  }
  const startedMs = Date.parse(startedAt);
  const cutoffMs = Date.parse(cutoffAt);
  const eligibleThroughMs = cutoffMs - input.windowMs;
  if (startedMs > eligibleThroughMs) return { ok: false, reason: 'invalid-input' };
  if (proposalCapturedAt !== cutoffAt || enrollmentCapturedAt !== cutoffAt ||
    adverseCapturedAt !== cutoffAt || stabilityCapturedAt !== cutoffAt) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (input.proposals.sourceState !== 'healthy' || !input.proposals.complete) {
    return { ok: false, reason: 'proposal-source-incomplete' };
  }
  if (input.enrollment.sourceState !== 'healthy' || !input.enrollment.complete) {
    return { ok: false, reason: 'enrollment-source-incomplete' };
  }
  if (!sourceHealthy(input.adverse)) return { ok: false, reason: 'adverse-source-incomplete' };
  if (!sourceHealthy(input.stability)) return { ok: false, reason: 'stability-source-incomplete' };
  if (input.proposals.proposals.length > MAX_PROPOSALS || input.enrollment.repos.length > MAX_ENROLLED ||
    input.adverse.observations.length > MAX_EVIDENCE_ROWS ||
    input.stability.witnesses.length > MAX_EVIDENCE_ROWS ||
    input.stability.manifests.length > MAX_EVIDENCE_ROWS ||
    input.stability.manifests.some((row) => row.members.length > MAX_EVIDENCE_ROWS) ||
    input.stability.manifests.reduce((sum, row) => sum + row.members.length, 0) > MAX_EVIDENCE_ROWS) {
    return { ok: false, reason: 'source-limit' };
  }
  let key: Buffer | null;
  try { key = deps.identityKey(); } catch { key = null; }
  if (!key || key.length < 32) return { ok: false, reason: 'identity-key-unavailable' };
  const enrolledRepos = input.enrollment.repos.map(canonicalRepo);
  if (enrolledRepos.some((repo) => repo === null)) return { ok: false, reason: 'invalid-input' };
  const enrolled = new Set(enrolledRepos as string[]);
  if (enrolled.size !== enrolledRepos.length) return { ok: false, reason: 'invalid-input' };
  const defaultBranches = new Map<string, string>();
  for (const row of input.enrollment.defaultBranches) {
    const repo = canonicalRepo(row.repo);
    const branch = canonicalBranch(row.branch);
    if (!repo || !branch || !enrolled.has(repo) || defaultBranches.has(repo)) {
      return { ok: false, reason: 'enrollment-source-incomplete' };
    }
    defaultBranches.set(repo, branch);
  }
  if (defaultBranches.size !== enrolled.size) {
    return { ok: false, reason: 'enrollment-source-incomplete' };
  }
  const proposalIds = new Set(input.proposals.proposals.map((proposal) => proposal.id));
  if (proposalIds.size !== input.proposals.proposals.length) {
    return { ok: false, reason: 'duplicate-proposal' };
  }
  const enrollmentDigest = sha(['ashlr:post-merge-v2:enrollment', input.enrollment.snapshotDigest,
    enrollmentCapturedAt, [...enrolled].sort().map((repo) => [
      hmac(key, 'ashlr:post-merge-v2:repo', repo), defaultBranches.get(repo),
    ])]);
  const proposalTuples = input.proposals.proposals.map((proposal) => metadataTuple(key, proposal))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const proposalSourceDigest = sha(['ashlr:post-merge-v2:proposals', input.proposals.snapshotDigest,
    proposalCapturedAt, proposalTuples]);
  const boundedAdverse: Array<{
    row: PostMergeObservationReadResult['observations'][number];
    repo: string;
  }> = [];
  for (const row of input.adverse.observations) {
    const repo = canonicalRepo(row.repo);
    const observedAt = canonicalTimestamp(row.observedAt);
    if (!repo || !observedAt) return { ok: false, reason: 'adverse-source-incomplete' };
    if (Date.parse(observedAt) <= cutoffMs) boundedAdverse.push({ row, repo });
  }
  const boundedManifests: PostMergeStabilityReadResult['manifests'] = [];
  const releaseByWitness = new Map<string, { witnessDigest: string; releaseDigest: string }>();
  for (const row of input.stability.manifests) {
    const completedAt = canonicalTimestamp(row.completedAt);
    if (!completedAt) return { ok: false, reason: 'stability-source-incomplete' };
    if (Date.parse(completedAt) > cutoffMs) continue;
    boundedManifests.push(row);
    const releaseDigest = sha(['ashlr:post-merge-v2:stability-release', stabilityManifestTuple(row)]);
    for (const member of row.members) {
      if (releaseByWitness.has(member.witnessId)) return { ok: false, reason: 'duplicate-evidence' };
      releaseByWitness.set(member.witnessId, { witnessDigest: member.witnessDigest, releaseDigest });
    }
  }
  const boundedStability: PostMergeStabilityReadResult['witnesses'] = [];
  for (const row of input.stability.witnesses) {
    const stableAt = canonicalTimestamp(row.stableAt);
    if (!stableAt) return { ok: false, reason: 'stability-source-incomplete' };
    const release = releaseByWitness.get(row.witnessId);
    if (Date.parse(stableAt) <= cutoffMs && release?.witnessDigest === row.witnessDigest) {
      boundedStability.push(row);
    }
  }
  const adverseSourceDigest = sha(['ashlr:post-merge-v2:adverse', input.adverse.snapshotDigest,
    adverseCapturedAt, boundedAdverse
    .map(({ row, repo }) => adverseTuple(key, repo, row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]);
  const stabilityWitnessTuples = boundedStability.map((row) => stabilityTuple(key, row))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const stabilityManifestTuples = boundedManifests.map(stabilityManifestTuple)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const stabilitySourceDigest = sha(['ashlr:post-merge-v2:stability', input.stability.snapshotDigest,
    stabilityCapturedAt, stabilityWitnessTuples, stabilityManifestTuples]);
  const exclusions = emptyExclusions();
  const members: PostMergePopulationMemberV2[] = [];
  const mergeIdentities = new Set<string>();
  const adverseByIdentity = new Map<string, PostMergeObservationReadResult['observations'][number]>();
  for (const { row, repo } of boundedAdverse) {
    const identity = JSON.stringify([repo, row.proposalId, row.mergeCommit]);
    if (adverseByIdentity.has(identity)) return { ok: false, reason: 'duplicate-evidence' };
    adverseByIdentity.set(identity, row);
  }
  const stabilityByIdentity = new Map<string, PostMergeStabilityReadResult['witnesses'][number]>();
  for (const row of boundedStability) {
    const identity = JSON.stringify([row.repoDigest, row.proposalId, row.mergeCommit]);
    if (stabilityByIdentity.has(identity)) return { ok: false, reason: 'duplicate-evidence' };
    stabilityByIdentity.set(identity, row);
  }
  for (const proposal of input.proposals.proposals) {
    const eligibility = exclusionReason(
      proposal, enrolled, defaultBranches, startedMs, eligibleThroughMs, deps,
    );
    if ('refusal' in eligibility) return { ok: false, reason: eligibility.refusal };
    if ('reason' in eligibility) {
      exclusions[eligibility.reason]++;
      continue;
    }
    const mergeCommit = proposal.remoteHandoff!.mergeCommitOid!;
    const repoDigest = hmac(key, 'ashlr:post-merge-v2:repo', eligibility.repo);
    const proposalDigest = hmac(key, 'ashlr:post-merge-v2:proposal', proposal.id);
    const mergeDigest = hmac(key, 'ashlr:post-merge-v2:merge', mergeCommit);
    const mergeIdentity = JSON.stringify([repoDigest, mergeDigest]);
    if (mergeIdentities.has(mergeIdentity)) return { ok: false, reason: 'duplicate-merge' };
    mergeIdentities.add(mergeIdentity);
    const mergedMs = Date.parse(eligibility.mergedAt);
    const adverseCandidate = adverseByIdentity.get(JSON.stringify([
      eligibility.repo, proposal.id, mergeCommit,
    ]));
    const observedAt = canonicalTimestamp(adverseCandidate?.observedAt);
    const adverse = adverseCandidate && observedAt !== null &&
      Date.parse(observedAt) >= mergedMs && Date.parse(observedAt) <= cutoffMs
      ? adverseCandidate : undefined;
    const legacyRepoDigest = hmac(key, 'ashlr:post-merge-stability-repo:v1', eligibility.repo);
    const stableCandidate = stabilityByIdentity.get(JSON.stringify([
      legacyRepoDigest, proposal.id, mergeCommit,
    ]));
    const stableAt = canonicalTimestamp(stableCandidate?.stableAt);
    const stable = stableCandidate && stableAt !== null &&
      Date.parse(stableAt) >= mergedMs && Date.parse(stableAt) <= cutoffMs
      ? stableCandidate : undefined;
    const deterministicAdverse = adverse && adverse.confidence === 'deterministic' &&
      (adverse.outcome === 'regressed' || adverse.outcome === 'reverted');
    const classification = deterministicAdverse ? 'adverse' : 'inconclusive';
    const reason = deterministicAdverse ? 'deterministic-adverse'
      : adverse ? 'heuristic-adverse'
        : stable ? 'legacy-isolation-unknown' : 'no-terminal-evidence';
    const evidenceDigest = sha(['ashlr:post-merge-v2:evidence', repoDigest, proposalDigest, mergeDigest,
      adverse ? sha(['adverse', adverseTuple(key, eligibility.repo, adverse)]) : null,
      stable ? sha(['stability', stabilityTuple(key, stable),
        releaseByWitness.get(stable.witnessId)?.releaseDigest]) : null,
      classification, reason]);
    members.push({
      memberId: sha(['ashlr:post-merge-v2:member', repoDigest, proposalDigest, mergeDigest]),
      repoDigest, proposalDigest, mergeDigest, classification, reason, evidenceDigest,
    });
  }
  members.sort((left, right) => left.memberId.localeCompare(right.memberId));
  const populationDigest = sha(['ashlr:post-merge-v2:population', members, exclusions]);
  const adverse = members.filter((member) => member.classification === 'adverse').length;
  const inconclusive = members.length - adverse;
  const excluded = Object.values(exclusions).reduce((sum, count) => sum + count, 0);
  const cohortId = sha(['ashlr:post-merge-v2:cohort', SCOPE, startedAt,
    new Date(eligibleThroughMs).toISOString(), cutoffAt, input.windowMs, enrollmentDigest,
    proposalSourceDigest, adverseSourceDigest, stabilitySourceDigest, populationDigest]);
  return {
    ok: true,
    population: {
      schemaVersion: 2, authority: 'observation-only', scope: SCOPE,
      policyEligible: false, denominatorComplete: false, conclusiveComplete: inconclusive === 0,
      cohortId, cohortStartedAt: startedAt, eligibleThroughAt: new Date(eligibleThroughMs).toISOString(),
      cutoffAt, windowMs: input.windowMs, enrollmentDigest, proposalSourceDigest,
      adverseSourceDigest, stabilitySourceDigest, populationDigest,
      eligible: members.length, excluded, adverse, inconclusive, exclusions, members,
    },
  };
}
