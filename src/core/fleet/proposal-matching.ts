import type { AshlrConfig, Proposal, WorkItem } from '../types.js';
import { resolve } from 'node:path';
import { canonicalFilesystemPathIdentity } from '../sandbox/policy.js';
import { resolveProductionVelocityProfile } from '../fabric/production-velocity.js';
import { generatedRepairGenerationIds } from './generated-repair-lifecycle.js';

type ProposalItemMatch = Pick<Proposal, 'id' | 'title' | 'summary' | 'workItemId' | 'repo'> &
  Partial<Pick<Proposal, 'createdAt' | 'status' | 'workItemGenerationId'>>;

type PendingProposalConfig = Pick<AshlrConfig, 'foundry'> | undefined;

export interface PendingProposalBlockingOptions {
  now?: Date | number | string;
}

export function workItemCoverageKey(item: Pick<WorkItem, 'repo' | 'id' | 'repairGenerationId'>): string {
  return `${resolve(item.repo)}\0${item.id}\0${item.repairGenerationId ?? ''}`;
}

/**
 * Canonical identity for execution authority, distinct from the compatibility
 * coverage key. Shared queue claims must fail closed when a repository path
 * cannot be physically identified, rather than inventing a durable alias.
 */
export function workItemExecutionKey(
  item: Pick<WorkItem, 'repo' | 'id' | 'repairGenerationId'>,
): string | null {
  const repo = canonicalFilesystemPathIdentity(item.repo, { foldWindowsCase: false });
  return repo === null ? null : `${repo}\0${item.id}\0${item.repairGenerationId ?? ''}`;
}

/**
 * Finds the pending proposal that is authoritative for one exact work item.
 * Raw scanner ids are not globally unique: repository and repair generation
 * must agree before a proposal may be attached to a dispatch outcome.
 */
export function pendingProposalForWorkItem<T extends ProposalItemMatch>(
  item: WorkItem,
  proposals: ReadonlyArray<T>,
): T | undefined {
  return proposals.find((proposal) => {
    if (proposal.workItemId?.trim() !== item.id) return false;
    if (!proposalRepoMatchesItem(proposal, item)) return false;
    return !item.repairGenerationId ||
      generatedRepairGenerationIds(item).includes(proposal.workItemGenerationId ?? '');
  });
}

function exactItemIdRegex(itemId: string): RegExp {
  const escaped = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
}

function proposalRepoMatchesItem(proposal: Pick<Proposal, 'repo'>, item: Pick<WorkItem, 'repo'>): boolean {
  return proposal.repo === null || resolve(proposal.repo) === resolve(item.repo);
}

function nowToMs(now: Date | number | string | undefined): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  if (typeof now === 'string') {
    const parsed = Date.parse(now);
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  return Date.now();
}

export function pendingProposalIsStaleForProductionVelocity(
  proposal: ProposalItemMatch,
  cfg: PendingProposalConfig,
  opts?: PendingProposalBlockingOptions,
): boolean {
  if (proposal.status !== undefined && proposal.status !== 'pending') return false;
  const profile = resolveProductionVelocityProfile({ foundry: cfg?.foundry } as AshlrConfig);
  if (!profile.enabled || !Number.isFinite(profile.stalePendingTtlHours)) return false;
  const activityAt = proposal.createdAt;
  if (!activityAt) return false;
  const activityMs = Date.parse(activityAt);
  if (!Number.isFinite(activityMs)) return false;
  const ageMs = Math.max(0, nowToMs(opts?.now) - activityMs);
  return ageMs >= profile.stalePendingTtlHours * 60 * 60 * 1000;
}

export function blockingPendingProposalsForBacklog<T extends ProposalItemMatch>(
  pendingProposals: ReadonlyArray<T>,
  cfg: PendingProposalConfig,
  opts?: PendingProposalBlockingOptions,
): T[] {
  return pendingProposals.filter((proposal) =>
    !pendingProposalIsStaleForProductionVelocity(proposal, cfg, opts),
  );
}

export function proposalTextMentionsItemId(proposal: Pick<Proposal, 'id' | 'title' | 'summary'>, itemId: string): boolean {
  return exactItemIdRegex(itemId).test(`${proposal.id} ${proposal.title} ${proposal.summary}`);
}

export function pendingProposalItemKeysForBacklog(
  items: ReadonlyArray<WorkItem>,
  pendingProposals: ReadonlyArray<ProposalItemMatch>,
): Set<string> {
  const itemsById = new Map<string, WorkItem[]>();
  const pendingItemKeys = new Set<string>();

  for (const item of items) {
    const group = itemsById.get(item.id);
    if (group) group.push(item);
    else itemsById.set(item.id, [item]);
  }

  for (const proposal of pendingProposals) {
    const workItemId = proposal.workItemId?.trim();
    if (workItemId) {
      for (const item of itemsById.get(workItemId) ?? []) {
        const generationMatches = !item.repairGenerationId ||
          generatedRepairGenerationIds(item).includes(proposal.workItemGenerationId ?? '');
        if (proposalRepoMatchesItem(proposal, item) && generationMatches) {
          pendingItemKeys.add(workItemCoverageKey(item));
        }
      }
      continue;
    }

    for (const item of items) {
      // Legacy text-only proposals carry no generation authority. They may
      // suppress ordinary work for compatibility, but never a newer durable
      // repair generation that intentionally reuses a stable child item id.
      if (item.repairGenerationId) continue;
      if (proposalRepoMatchesItem(proposal, item) && proposalTextMentionsItemId(proposal, item.id)) {
        pendingItemKeys.add(workItemCoverageKey(item));
      }
    }
  }

  return pendingItemKeys;
}
