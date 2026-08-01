import type { AshlrConfig, Proposal } from '../types.js';
import { pendingProposalIsStaleForProductionVelocity } from '../fabric/production-velocity-pending.js';
import { hashDiff, verifyProvenance } from '../foundry/provenance.js';
import { canonicalizeProposalDiff } from '../util/scrub.js';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';

type PendingAuthorityConfig = Pick<AshlrConfig, 'foundry'> | undefined;

export interface AuthoritativePendingProposalExpectation {
  id?: string;
  repo: string;
  origin: Proposal['origin'];
  kind: Proposal['kind'];
  diff?: string;
  diffHash?: string;
  provenanceSig?: string;
  sandboxId?: string;
  runId?: string;
  trajectoryId?: string;
  workItemId?: string;
  workItemGenerationId?: string;
  isPartial?: boolean;
}

export interface AuthoritativePendingProposalOptions {
  now?: Date | number | string;
}

function authorityNowMs(now: AuthoritativePendingProposalOptions['now']): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

export function canonicalProposalDiffHash(
  proposal: Pick<Proposal, 'diff' | 'diffHash'>,
): string | null {
  if (
    typeof proposal.diff !== 'string' ||
    proposal.diff.trim().length === 0 ||
    typeof proposal.diffHash !== 'string'
  ) return null;
  try {
    const canonicalDiff = canonicalizeProposalDiff(proposal.diff);
    const recomputed = hashDiff(canonicalDiff);
    return proposal.diff === canonicalDiff && proposal.diffHash === recomputed ? recomputed : null;
  } catch {
    return null;
  }
}

function hasExactRunSummary(proposal: Proposal): boolean {
  const runId = proposal.runId;
  const summary = proposal.runEventSummary;
  if (!runId || !summary || summary.runId !== runId) return false;

  if (proposal.isPartial === true) {
    return (summary.status === 'failed' || summary.status === 'aborted') &&
      summary.outcome === 'gate-blocked' &&
      summary.proposalCreated === false &&
      summary.proposalId === undefined;
  }

  return summary.status === 'done' &&
    summary.outcome === 'filed' &&
    summary.proposalCreated === true &&
    summary.proposalId === proposal.id;
}

/**
 * One fail-closed authority predicate for autonomous pending proposals.
 * Structural inbox readability is insufficient: bytes, provenance, freshness,
 * causal identity, work generation, and filed run truth must all agree.
 */
export function isAuthoritativeDurablePendingProposal(
  proposal: Proposal | null | undefined,
  expected: AuthoritativePendingProposalExpectation,
  cfg?: PendingAuthorityConfig,
  opts: AuthoritativePendingProposalOptions = {},
): proposal is Proposal {
  const expectedRepo = canonicalFilesystemPathIdentity(expected.repo, { foldWindowsCase: false });
  if (
    !proposal ||
    expectedRepo === null ||
    proposal.status !== 'pending' ||
    (expected.id !== undefined && proposal.id !== expected.id) ||
    proposal.repo !== expectedRepo ||
    proposal.origin !== expected.origin ||
    proposal.kind !== expected.kind ||
    proposal.workItemId !== expected.workItemId ||
    proposal.workItemGenerationId !== expected.workItemGenerationId ||
    (expected.sandboxId !== undefined && proposal.sandboxId !== expected.sandboxId) ||
    (expected.runId !== undefined && proposal.runId !== expected.runId) ||
    (expected.trajectoryId !== undefined && proposal.trajectoryId !== expected.trajectoryId) ||
    (expected.provenanceSig !== undefined && proposal.provenanceSig !== expected.provenanceSig) ||
    (expected.isPartial !== undefined && (proposal.isPartial === true) !== expected.isPartial)
  ) return false;

  if (!proposal.runId || proposal.trajectoryId !== `run:${proposal.runId}`) return false;

  const createdAtMs = Date.parse(proposal.createdAt);
  const nowMs = authorityNowMs(opts.now);
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs + 60_000) return false;
  if (pendingProposalIsStaleForProductionVelocity(proposal, cfg, { now: nowMs })) return false;

  const durableHash = canonicalProposalDiffHash(proposal);
  if (durableHash === null || !verifyProvenance(proposal).ok) return false;

  if (expected.diff !== undefined) {
    try {
      const expectedDiff = canonicalizeProposalDiff(expected.diff);
      const expectedHash = hashDiff(expectedDiff);
      if (
        expected.diff !== expectedDiff ||
        proposal.diff !== expectedDiff ||
        durableHash !== expectedHash ||
        (expected.diffHash !== undefined && expected.diffHash !== expectedHash)
      ) return false;
    } catch {
      return false;
    }
  } else if (expected.diffHash !== undefined && durableHash !== expected.diffHash) {
    return false;
  }

  return hasExactRunSummary(proposal);
}
