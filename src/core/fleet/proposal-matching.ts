import type { AshlrConfig, Proposal, WorkItem } from '../types.js';
import { resolve } from 'node:path';
import {
  pendingProposalIsStaleForProductionVelocity,
  type PendingProposalBlockingOptions,
} from '../fabric/production-velocity-pending.js';

export {
  pendingProposalIsStaleForProductionVelocity,
  type PendingProposalBlockingOptions,
} from '../fabric/production-velocity-pending.js';
import { generatedRepairGenerationIds } from './generated-repair-lifecycle.js';

type ProposalItemMatch = Pick<Proposal, 'id' | 'title' | 'summary' | 'workItemId' | 'repo'> &
  Partial<Pick<Proposal, 'createdAt' | 'status' | 'workItemGenerationId'>>;

type PendingProposalConfig = Pick<AshlrConfig, 'foundry'> | undefined;

export function workItemCoverageKey(item: Pick<WorkItem, 'repo' | 'id' | 'repairGenerationId'>): string {
  return `${resolve(item.repo)}\0${item.id}\0${item.repairGenerationId ?? ''}`;
}

function exactItemIdRegex(itemId: string): RegExp {
  const escaped = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
}

function proposalRepoMatchesItem(proposal: Pick<Proposal, 'repo'>, item: Pick<WorkItem, 'repo'>): boolean {
  return proposal.repo === null || resolve(proposal.repo) === resolve(item.repo);
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
