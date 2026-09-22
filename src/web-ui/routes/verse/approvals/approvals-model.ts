/**
 * routes/verse/approvals/approvals-model.ts — the pure decisions behind the
 * approvals queue: what order rows come in, and exactly what a human is
 * agreeing to when they press Approve.
 *
 * Kept framework-free and unit-tested because both are easy to get subtly
 * wrong: "pending first" must survive a status filter that also returns
 * decided rows, and the approve consequence sentence is the last thing
 * standing between a click and a real pull request against a real remote.
 */
import type { Proposal, ProposalKind } from '../../../data/api-types.js';

/** Pending first, then newest first within each group. Stable and total. */
export function orderProposals(rows: readonly Proposal[]): Proposal[] {
  return [...rows].sort((a, b) => {
    const pendingA = a.status === 'pending' ? 0 : 1;
    const pendingB = b.status === 'pending' ? 0 : 1;
    if (pendingA !== pendingB) return pendingA - pendingB;
    const tsA = Date.parse(a.createdAt);
    const tsB = Date.parse(b.createdAt);
    const safeA = Number.isNaN(tsA) ? 0 : tsA;
    const safeB = Number.isNaN(tsB) ? 0 : tsB;
    if (safeA !== safeB) return safeB - safeA;
    return a.id.localeCompare(b.id);
  });
}

export type RiskClass = NonNullable<Proposal['riskClass']>;

/** high → medium → low → unstated. Used for the risk column's sort affordance. */
export function riskRank(risk: Proposal['riskClass']): number {
  switch (risk) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    case 'low':
      return 2;
    default:
      return 3;
  }
}

/** Client-side narrowing over whatever page the server returned. */
export function filterProposals(rows: readonly Proposal[], search: string, repo: string): Proposal[] {
  const s = search.trim().toLowerCase();
  const r = repo.trim().toLowerCase();
  if (!s && !r) return [...rows];
  return rows.filter((p) => {
    if (s && !p.title.toLowerCase().includes(s) && !(p.summary ?? '').toLowerCase().includes(s)) return false;
    if (r && !(p.repo ?? '').toLowerCase().includes(r)) return false;
    return true;
  });
}

/**
 * What approving this proposal actually does, in one sentence, naming the
 * repo. `pr` is the dangerous one: it pushes a branch to the remote and opens
 * a real pull request, which is visible to other people and cannot be undone
 * from the dialog. The confirm step MUST show this before the click.
 */
export function describeApproveConsequence(kind: ProposalKind | string, repo: string | null): string {
  const where = repo ? repo : 'the target repository';
  switch (kind) {
    case 'pr':
      return `Pushes a branch to ${where}'s remote and opens a real pull request. Other people can see it immediately, and this dialog cannot undo it.`;
    case 'patch':
      return `Writes the diff to ${where} on disk now. Nothing is pushed, but the working tree changes.`;
    default:
      return `Applies this ${String(kind)} proposal to ${where} now.`;
  }
}

/** True when approving reaches a remote — the loudest confirm wording. */
export function reachesRemote(kind: ProposalKind | string): boolean {
  return kind === 'pr';
}

/** The engine that produced the diff, as a short display string. */
export function engineOf(proposal: Pick<Proposal, 'engineModel' | 'engineTier'>): string | null {
  if (proposal.engineModel) return proposal.engineModel;
  if (proposal.engineTier) return proposal.engineTier;
  return null;
}
