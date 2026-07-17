import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Proposal, WorkSource } from '../types.js';
import { canonicalizeProposalDiff, scrubSecrets } from '../util/scrub.js';
import {
  acquireProposalMutationLock,
  releaseProposalMutationLock,
  type ProposalMutationLock,
} from '../inbox/proposal-mutation-lock.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_REPAIR_ITEM_RE = /^[^:]+:proposal-repair:[a-f0-9]{12}$/;
const MAX_REASON = 260;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedRepairReason(value: unknown): string {
  const stripped = scrubSecrets(String(value ?? ''))
    .replace(/\b(stdout|stderr|diff|prompt|env|argv)\s*[:=]\s*[^;,\n]+/gi, '$1=[omitted]')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > MAX_REASON
    ? `${stripped.slice(0, MAX_REASON - 3)}...`
    : stripped;
}

function repairReason(proposal: Proposal): string {
  const verify = proposal.verifyResult;
  const failed = Array.isArray(verify?.failed)
    ? verify.failed.find((line) => typeof line === 'string' && line.trim())
    : undefined;
  return boundedRepairReason(
    verify?.detail ?? failed ?? (proposal.isPartial === true
      ? 'partial proposal capture needs a complete verified repair'
      : 'verification failed'),
  );
}

/** Immutable witness for the exact parent state that made a proposal repairable. */
export function proposalRepairParentRevision(proposal: Proposal): string | null {
  if (!proposal.repo || typeof proposal.id !== 'string' || !proposal.id) return null;
  let repo: string;
  try { repo = resolve(proposal.repo); } catch { return null; }
  const verify = proposal.verifyResult;
  const diffDigest = typeof proposal.diff === 'string'
    ? sha256(canonicalizeProposalDiff(proposal.diff))
    : null;
  const verifyDigest = verify === undefined
    ? null
    : sha256(JSON.stringify([
        verify.passed,
        verify.failed ?? null,
        verify.detail ?? null,
        verify.baseBranch ?? null,
        verify.baseHead ?? null,
        verify.diffHash ?? null,
        verify.verifiedAt ?? null,
        verify.source ?? null,
      ]));
  const stuckPassCount = (proposal as unknown as Record<string, unknown>)['stuckPassCount'];
  return sha256(JSON.stringify([
    'ashlr:proposal-repair-parent:v1',
    repo,
    proposal.id,
    proposal.status,
    proposal.kind,
    proposal.origin,
    proposal.title,
    proposal.summary,
    proposal.createdAt,
    proposal.decidedAt ?? null,
    proposal.isPartial === true,
    diffDigest,
    proposal.diffHash ?? null,
    verifyDigest,
    repairReason(proposal),
    proposal.result ?? null,
    proposal.decisionReason ?? null,
    Number.isSafeInteger(stuckPassCount) ? stuckPassCount : null,
    proposal.workItemId ?? null,
    proposal.workItemGenerationId ?? null,
    proposal.workSource ?? null,
  ]));
}

export function proposalRepairGenerationId(input: {
  repo: string;
  itemId: string;
  source: WorkSource;
  ts: string;
  parentProposalId: string;
  parentProposalRevision: string;
}): string | null {
  if (!input.parentProposalId || !SHA256_RE.test(input.parentProposalRevision)) return null;
  const ts = Date.parse(input.ts);
  if (!Number.isFinite(ts)) return null;
  let repo: string;
  try { repo = resolve(input.repo); } catch { return null; }
  return sha256(JSON.stringify([
    'ashlr:generated-repair-generation:v2',
    repo,
    input.itemId,
    input.source,
    new Date(ts).toISOString(),
    input.parentProposalId,
    input.parentProposalRevision,
  ]));
}

export function isProposalRepairChild(proposal: Proposal): boolean {
  return proposal.workSource === 'self' &&
    typeof proposal.workItemId === 'string' &&
    PROPOSAL_REPAIR_ITEM_RE.test(proposal.workItemId);
}

export type ProposalRepairParentAuthority =
  | { applies: false; authorized: true }
  | { applies: true; authorized: false; reason: 'witness-missing' | 'lock-unavailable' | 'parent-missing' | 'parent-changed' | 'nested-parent' | 'generation-mismatch' }
  | { applies: true; authorized: true; parentId: string; lock: ProposalMutationLock };

function proposalRepairChildParentFailure(
  child: Proposal,
  loadParent: (id: string) => Proposal | null,
): Exclude<ProposalRepairParentAuthority, { authorized: true }>['reason'] | null {
  const parentId = child.delegationScope?.repairParentProposalId;
  const parentRevision = child.delegationScope?.repairParentProposalRevision;
  if (
    typeof parentId !== 'string' || !parentId ||
    typeof parentRevision !== 'string' || !SHA256_RE.test(parentRevision)
  ) return 'witness-missing';
  const parent = loadParent(parentId);
  if (!parent || !parent.repo || !child.repo) return 'parent-missing';
  if (isProposalRepairChild(parent)) return 'nested-parent';
  try {
    if (resolve(parent.repo) !== resolve(child.repo)) return 'parent-changed';
  } catch {
    return 'parent-changed';
  }
  if (proposalRepairParentRevision(parent) !== parentRevision) return 'parent-changed';
  const expectedGeneration = proposalRepairGenerationId({
    repo: parent.repo,
    itemId: child.workItemId!,
    source: child.workSource!,
    ts: parent.createdAt,
    parentProposalId: parentId,
    parentProposalRevision: parentRevision,
  });
  return !expectedGeneration || child.workItemGenerationId !== expectedGeneration
    ? 'generation-mismatch'
    : null;
}

/** Validate while a caller-owned parent mutation fence is held. */
export function proposalRepairChildParentCurrent(
  child: Proposal,
  loadParent: (id: string) => Proposal | null,
): boolean {
  return !isProposalRepairChild(child) || proposalRepairChildParentFailure(child, loadParent) === null;
}

export function acquireProposalRepairParentAuthority(
  child: Proposal,
  loadParent: (id: string) => Proposal | null,
): ProposalRepairParentAuthority {
  if (!isProposalRepairChild(child)) return { applies: false, authorized: true };
  const parentId = child.delegationScope?.repairParentProposalId;
  if (typeof parentId !== 'string' || !parentId) {
    return { applies: true, authorized: false, reason: 'witness-missing' };
  }

  const lock = acquireProposalMutationLock(parentId);
  if (!lock) return { applies: true, authorized: false, reason: 'lock-unavailable' };
  const fail = (reason: Exclude<ProposalRepairParentAuthority, { authorized: true }>['reason']): ProposalRepairParentAuthority => {
    releaseProposalMutationLock(lock);
    return { applies: true, authorized: false, reason };
  };
  const failure = proposalRepairChildParentFailure(child, loadParent);
  if (failure) return fail(failure);
  return { applies: true, authorized: true, parentId, lock };
}

export function releaseProposalRepairParentAuthority(
  authority: ProposalRepairParentAuthority | null | undefined,
): void {
  if (authority?.applies && authority.authorized) releaseProposalMutationLock(authority.lock);
}
