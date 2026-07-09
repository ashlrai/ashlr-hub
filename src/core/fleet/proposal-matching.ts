import type { Proposal, WorkItem } from '../types.js';
import { resolve } from 'node:path';

type ProposalItemMatch = Pick<Proposal, 'id' | 'title' | 'summary' | 'workItemId' | 'repo'>;

export function workItemCoverageKey(item: Pick<WorkItem, 'repo' | 'id'>): string {
  return `${resolve(item.repo)}\0${item.id}`;
}

function exactItemIdRegex(itemId: string): RegExp {
  const escaped = itemId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
}

function proposalRepoMatchesItem(proposal: Pick<Proposal, 'repo'>, item: Pick<WorkItem, 'repo'>): boolean {
  return proposal.repo === null || resolve(proposal.repo) === resolve(item.repo);
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
        if (proposalRepoMatchesItem(proposal, item)) pendingItemKeys.add(workItemCoverageKey(item));
      }
      continue;
    }

    for (const item of items) {
      if (proposalRepoMatchesItem(proposal, item) && proposalTextMentionsItemId(proposal, item.id)) {
        pendingItemKeys.add(workItemCoverageKey(item));
      }
    }
  }

  return pendingItemKeys;
}
