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
  /** Frontier proposals the gate was run against this pass. */
  attempted: number;
  /** Of those, how many actually merged. */
  merged: number;
  /** Per-proposal gate results (for observability/audit). */
  results: AutoMergeResult[];
}

/**
 * Run the M47 tiered-trust gate over PENDING proposals. No-op (returns zeros)
 * unless auto-merge is explicitly enabled. Honors the kill switch before and
 * during the pass. Never throws.
 */
export async function runAutoMergePass(cfg: AshlrConfig): Promise<AutoMergePassResult> {
  const out: AutoMergePassResult = { attempted: 0, merged: 0, results: [] };
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
    // Only frontier-tier proposals are merge-eligible; the gate re-verifies
    // authority/risk/verification, so this is a fast pre-filter, not the gate.
    if (p.engineTier !== 'frontier') continue;
    out.attempted++;
    try {
      const res = await autoMergeProposal(p.id, cfg);
      out.results.push(res);
      if (res.merged) out.merged++;
    } catch {
      // autoMergeProposal never throws by contract; defensive only.
    }
  }
  return out;
}
