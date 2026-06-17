/**
 * automerge-pass.ts — M48: the daemon's OPT-IN auto-merge pass.
 *
 * Kept DELIBERATELY OUT of daemon/loop.ts so the daemon file itself imports no
 * merge/apply/push primitive (the `daemon-no-primitive` safety contract stays
 * literally true: loop.ts only *triggers* this pass). All merge authority lives
 * behind the M47 gate (`autoMergeProposal`), which enforces, per proposal:
 *   frontier merge-authority model ∈ cfg.foundry.mergeAuthority
 *   AND risk class ≤ maxRisk AND full verification passes
 *   AND kill-switch off AND repo enrolled.
 *
 * DEFAULT OFF: a no-op unless cfg.foundry.autoMerge.enabled === true. Only
 * 'frontier'-tier proposals are even considered; the gate re-checks everything.
 * Never throws.
 */

import type { AshlrConfig } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { autoMergeProposal, type AutoMergeResult } from '../inbox/merge.js';
import { killSwitchOn } from '../sandbox/policy.js';

export interface AutoMergePassResult {
  /** Proposals the gate was run against this pass (frontier + branch-eligible mid). */
  attempted: number;
  /** Of those, how many actually merged to main (frontier only). */
  merged: number;
  /** Of those, how many a MID-tier proposal applied to a branch/PR (M56). */
  branched: number;
  /** Per-proposal gate results (for observability/audit). */
  results: AutoMergeResult[];
}

/**
 * Run the M47 tiered-trust gate over PENDING proposals. No-op (returns zeros)
 * unless auto-merge is explicitly enabled. Honors the kill switch before and
 * during the pass. Never throws.
 */
export async function runAutoMergePass(cfg: AshlrConfig): Promise<AutoMergePassResult> {
  const out: AutoMergePassResult = { attempted: 0, merged: 0, branched: 0, results: [] };
  if (cfg.foundry?.autoMerge?.enabled !== true) return out;
  if (killSwitchOn()) return out;

  let pending;
  try {
    pending = listProposals({ status: 'pending' });
  } catch {
    return out;
  }

  for (const p of pending) {
    if (killSwitchOn()) break;
    // Frontier proposals are main-merge-eligible; MID proposals are branch/PR-
    // eligible ONLY when the separate default-off midToBranch flag is on. The
    // gate re-verifies authority/risk/verification — this is a fast pre-filter.
    const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
    if (p.engineTier !== 'frontier' && !midEligible) continue;
    out.attempted++;
    try {
      const res = await autoMergeProposal(p.id, cfg);
      out.results.push(res);
      if (res.merged) out.merged++;
      if (res.branched) out.branched++;
    } catch {
      // autoMergeProposal never throws by contract; defensive only.
    }
  }
  return out;
}
