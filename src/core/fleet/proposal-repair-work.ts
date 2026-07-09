import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import type { Proposal, WorkItem } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { scrubSecrets } from '../util/scrub.js';
import { queueSelfHealItem } from './self-heal.js';

const MAX_TITLE = 140;
const MAX_REASON = 260;

export interface ProposalRepairWorkResult {
  scanned: number;
  eligible: number;
  queued: number;
  failed: number;
}

function bounded(value: unknown, max: number): string {
  const text = scrubSecrets(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function repairId(repo: string, proposalId: string): string {
  const hash = createHash('sha1')
    .update(`${resolve(repo)}\0${proposalId}\0proposal-repair`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(repo)}:proposal-repair:${hash}`;
}

function proposalNeedsRepair(proposal: Proposal): boolean {
  if (proposal.status !== 'pending') return false;
  if (proposal.kind !== 'patch' && proposal.kind !== 'pr') return false;
  if (!proposal.repo) return false;
  return proposal.isPartial === true || proposal.verifyResult?.passed === false;
}

function repairReason(proposal: Proposal): string {
  const verify = proposal.verifyResult;
  const failed = Array.isArray(verify?.failed)
    ? verify.failed.find((line) => typeof line === 'string' && line.trim())
    : undefined;
  const raw =
    verify?.detail ??
    failed ??
    (proposal.isPartial === true
      ? 'partial proposal capture needs a complete verified repair'
      : 'verification failed');
  return bounded(raw, MAX_REASON);
}

export function proposalRepairWorkItem(proposal: Proposal, now = new Date()): WorkItem | null {
  if (!proposalNeedsRepair(proposal) || !proposal.repo) return null;

  const title = bounded(proposal.title, MAX_TITLE) || proposal.id;
  const reason = repairReason(proposal);
  const value = 5;
  const effort = 1;
  const repairKind = proposal.isPartial === true ? 'partial' : 'verify';

  return {
    id: repairId(proposal.repo, proposal.id),
    repo: proposal.repo,
    source: 'self',
    title: `Repair proposal ${proposal.id}: ${title}`,
    detail:
      `Proposal repair: test failure or partial captured proposal needs a complete verified patch.\n` +
      `Proposal: ${bounded(proposal.id, 80)}\n` +
      `Original work item: ${bounded(proposal.workItemId ?? 'unknown', 120)}\n` +
      `Failure: ${reason}\n` +
      `Produce a fresh complete fix, rerun merge-grade verification, and do not apply the existing partial diff directly.`,
    value,
    effort,
    score: value / effort,
    tags: ['self-heal', 'proposal-repair', repairKind, 'verify', 'high-priority'],
    ts: now.toISOString(),
  };
}

export function queueProposalRepairWorkForPendingProposals(
  proposals?: Proposal[],
  now = new Date(),
): ProposalRepairWorkResult {
  let pending: Proposal[];
  try {
    pending = proposals ?? listProposals({ status: 'pending' });
  } catch {
    return {
      scanned: 0,
      eligible: 0,
      queued: 0,
      failed: 1,
    };
  }

  const result: ProposalRepairWorkResult = {
    scanned: pending.length,
    eligible: 0,
    queued: 0,
    failed: 0,
  };

  for (const proposal of pending) {
    const item = proposalRepairWorkItem(proposal, now);
    if (!item) continue;
    result.eligible++;
    if (queueSelfHealItem(item)) result.queued++;
    else result.failed++;
  }

  return result;
}
