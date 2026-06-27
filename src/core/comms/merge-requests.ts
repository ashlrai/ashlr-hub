/**
 * M139: post-ship-proposals-for-approval helper.
 *
 * Runs runManager (or reads a recent report) to get verdicts, then posts
 * one postRequest per 'ship' verdict with a pending proposal — highest value
 * first. ONE outstanding at a time (the dispatch layer serialises anyway, but
 * we only post the top candidate to avoid flooding Mason).
 *
 * Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { postRequest, listRequests } from './requests.js';
import { listProposals } from '../inbox/store.js';

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

export interface PostShipResult {
  posted: number;
}

/**
 * Run the fleet manager, find 'ship' verdicts whose proposals are still
 * PENDING, and post the highest-value one as a 'manager-approval' comms
 * request. Subsequent requests are not posted — Mason answers one at a time.
 *
 * A 'borderline-high' review verdict (value >= 4 AND correctness >= 4) is
 * also eligible when cfg.foundry.askBorderlineReview is truthy.
 *
 * Never throws.
 */
export async function postShipProposalsForApproval(
  cfg: AshlrConfig,
): Promise<PostShipResult> {
  try {
    // Skip if there's already an outstanding manager-approval request.
    const existing = listRequests({ kind: 'manager-approval', status: ['pending', 'sent'] });
    if (existing.length > 0) {
      return { posted: 0 };
    }

    // Lazy-import to avoid pulling the full manager into non-fleet paths.
    const { runManager } = await import('../fleet/manager.js');
    const report = await runManager(cfg);

    // Collect pending proposal ids for quick lookup.
    const pendingProposals = listProposals({ status: 'pending' });
    const pendingIds = new Set(pendingProposals.map((p) => p.id));

    const askBorderline =
      (cfg.foundry as Record<string, unknown> | undefined)?.['askBorderlineReview'] === true;

    // Filter verdicts to eligible candidates.
    const eligible = report.verdicts
      .filter((v) => {
        if (!pendingIds.has(v.proposalId)) return false;
        if (v.verdict === 'ship') return true;
        if (
          askBorderline &&
          v.verdict === 'review' &&
          v.value >= 4 &&
          v.correctness >= 4
        ) return true;
        return false;
      })
      // Highest value first; tie-break by correctness.
      .sort((a, b) =>
        b.value !== a.value ? b.value - a.value : b.correctness - a.correctness,
      );

    if (eligible.length === 0) {
      return { posted: 0 };
    }

    const top = eligible[0]!;
    const proposal = pendingProposals.find((p) => p.id === top.proposalId);
    if (!proposal) return { posted: 0 };

    const verdictLabel = top.verdict === 'ship' ? 'SHIP' : 'REVIEW (borderline-high)';
    const scores = `v${top.value}/c${top.correctness}/s${top.scope}/a${top.alignment}`;
    const text =
      `Merge "${proposal.title}" → ${proposal.repo ?? '(unknown repo)'}? ` +
      `Judged ${verdictLabel} (${scores}). ${top.rationale}`;

    postRequest({
      kind: 'manager-approval',
      type: 'approval',
      text,
      options: ['Approve & merge', 'Reject', 'Show diff'],
      meta: { proposalId: proposal.id },
    });

    return { posted: 1 };
  } catch {
    return { posted: 0 };
  }
}
