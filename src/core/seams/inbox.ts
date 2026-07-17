/**
 * core/seams/inbox.ts — InboxStore seam (M30).
 *
 * SEAM over core/inbox/store.ts (listProposals / createProposal / loadProposal
 * / setStatus / pendingCount).
 *
 *   (a) InboxStore        — the interface.
 *   (b) LocalInboxStore   — DEFAULT. Behavior-preserving adapter; delegates 1:1.
 *                           Pure persistence — never applies anything (the
 *                           store's own guardrail is preserved untouched).
 *   (c) CloudInboxStore   — GATED stub; every method throws before any I/O.
 *   (d) selectInboxStore  — local by default; gated stub ONLY when an endpoint
 *                           is explicitly configured (still refuses).
 *
 * HARD SAFETY: local-first + self-hostable + cloud-gated. No new deps.
 */

import {
  createProposal,
  listProposals,
  loadProposal,
  pendingCount,
  setStatus,
} from '../inbox/store.js';
import type { AshlrConfig, Proposal, ProposalStatus } from '../types.js';
import { seamEndpoint } from './registry.js';
import { cloudGatedError } from './types.js';

export const INBOX_SEAM = {
  id: 'inbox' as const,
  name: 'InboxStore',
  delegatesTo: 'core/inbox/store.ts',
  summary: 'Approval inbox proposals — the outward-action gate (pure persistence).',
};

/** Proposal persistence for the approval inbox. */
export interface InboxStore {
  /** List proposals, most-recent first; optional status filter. */
  list(filter?: { status?: ProposalStatus }): Proposal[];
  /** Create + persist a new pending proposal (never applies anything). */
  create(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal;
  /** Load one proposal by id, or null when absent/malformed. */
  load(id: string): Proposal | null;
  /** Persist a new status for an existing proposal (pure persistence). */
  setStatus(id: string, status: ProposalStatus, result?: string, reason?: string): boolean;
  /** Count proposals with status === 'pending'. */
  pendingCount(): number;
}

/** DEFAULT local impl — pass-through adapter over core/inbox/store.ts. */
export class LocalInboxStore implements InboxStore {
  list(filter?: { status?: ProposalStatus }): Proposal[] {
    return listProposals(filter);
  }
  create(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal {
    return createProposal(p);
  }
  load(id: string): Proposal | null {
    return loadProposal(id);
  }
  setStatus(id: string, status: ProposalStatus, result?: string, reason?: string): boolean {
    return setStatus(id, status, result, reason);
  }
  pendingCount(): number {
    return pendingCount();
  }
}

/** GATED cloud stub — a shared team inbox WOULD live here. Throws first. */
export class CloudInboxStore implements InboxStore {
  list(_filter?: { status?: ProposalStatus }): Proposal[] {
    throw cloudGatedError(INBOX_SEAM.name, 'list');
  }
  create(_p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal {
    throw cloudGatedError(INBOX_SEAM.name, 'create');
  }
  load(_id: string): Proposal | null {
    throw cloudGatedError(INBOX_SEAM.name, 'load');
  }
  setStatus(_id: string, _status: ProposalStatus, _result?: string, _reason?: string): boolean {
    throw cloudGatedError(INBOX_SEAM.name, 'setStatus');
  }
  pendingCount(): number {
    throw cloudGatedError(INBOX_SEAM.name, 'pendingCount');
  }
}

/** Local by default; gated stub only when an endpoint is configured (refuses). */
export function selectInboxStore(cfg: AshlrConfig): InboxStore {
  return seamEndpoint(cfg, 'inbox') ? new CloudInboxStore() : new LocalInboxStore();
}
