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
 *
 * M172: judge-then-merge loop.
 * Before merging, each PENDING proposal that has no recent frontier 'ship'
 * verdict + HMAC attestation (checked via the decisions ledger) is sent to the
 * frontier judge (judgeProposal from manager.ts). This closes the gap where
 * proposals accumulate in 'pending' state because the daily oversight cron is
 * the only place the judge ran.
 *
 * Cost guard: at most cfg.foundry.judgePerPass (default 5) unjudged proposals
 * are judged per pass. Proposals that already have a recent 'ship' verdict in
 * the decisions ledger are skipped (idempotent).
 *
 * Fail-closed: if the judge is unavailable the proposal stays unjudged and
 * autoMergeProposal will refuse it (no regression). If judgeProposal throws,
 * the error is swallowed and the pass continues.
 */

import type { AshlrConfig, Proposal } from '../types.js';
import { listProposals } from '../inbox/store.js';
import { autoMergeProposal, type AutoMergeResult } from '../inbox/merge.js';
import { killSwitchOn } from '../sandbox/policy.js';
import { readDecisions } from './decisions-ledger.js';
import { judgeProposal, type ManagerVerdict } from './manager.js';

export interface AutoMergePassResult {
  /** Proposals the gate was run against this pass (frontier + branch-eligible mid). */
  attempted: number;
  /** Of those, how many actually merged to main (frontier only). */
  merged: number;
  /** Of those, how many a MID-tier proposal applied to a branch/PR (M56). */
  branched: number;
  /** Per-proposal gate results (for observability/audit). */
  results: AutoMergeResult[];
  /** M172: how many proposals were judged inline this pass. */
  judged: number;
  /** M172: how many proposals were skipped by the judge-per-pass cap. */
  judgeCapped: number;
}

// ---------------------------------------------------------------------------
// M172: judge-cache helpers
// ---------------------------------------------------------------------------

const JUDGE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — mirrors Gate 7 staleness window

/**
 * Return true when the decisions ledger already contains a recent frontier
 * 'ship' verdict for this proposal (with a judge attestation field present).
 * "Recent" = within the last hour (idempotent skip).
 *
 * Never throws.
 */
function hasRecentShipVerdict(proposalId: string): boolean {
  try {
    const sinceMs = Date.now() - JUDGE_CACHE_TTL_MS;
    const decisions = readDecisions({ proposalId, sinceMs });
    return decisions.some(
      (d) =>
        d.action === 'judged' &&
        d.verdict === 'ship' &&
        typeof (d as unknown as Record<string, unknown>)['judgeAttestation'] === 'string' &&
        ((d as unknown as Record<string, unknown>)['judgeAttestation'] as string).length > 0,
    );
  } catch {
    return false;
  }
}

/**
 * Resolve a minimal judge client from cfg, mirroring the Step 2 path in
 * manager.ts (getActiveClient + wrapClient). Returns null when unavailable.
 *
 * Never throws.
 */
async function resolveJudgeClientForPass(
  cfg: AshlrConfig,
): Promise<{ complete: (system: string, user: string) => Promise<string>; model: string } | null> {
  try {
    const { getActiveClient } = await import('../run/provider-client.js');
    const foundry = cfg.foundry as Record<string, unknown> | undefined;
    const judgeModel =
      (foundry?.['managerJudgeModel'] as string | undefined) ||
      'qwen2.5:72b-instruct-q4_K_M';
    const rawClient = await getActiveClient(cfg, { allowCloud: true, model: judgeModel }) as {
      complete?: (s: string, u: string) => Promise<string>;
      model?: string;
    };
    if (typeof rawClient?.complete === 'function') {
      return { complete: rawClient.complete.bind(rawClient), model: rawClient.model ?? 'unknown' };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: runAutoMergePass
// ---------------------------------------------------------------------------

/**
 * Run the M47 tiered-trust gate over PENDING proposals. No-op (returns zeros)
 * unless auto-merge is explicitly enabled. Honors the kill switch before and
 * during the pass. Never throws.
 *
 * M172 extension: before attempting to merge each eligible proposal, if it has
 * no recent frontier 'ship' verdict in the decisions ledger, run the frontier
 * judge on it (via judgeProposal from manager.ts). The judge records a
 * decisions-ledger entry + HMAC attestation (on 'ship'), enabling
 * autoMergeProposal's verification gate to proceed. Only proposals that receive
 * a 'ship' verdict are forwarded to autoMergeProposal.
 *
 * Bounds: at most cfg.foundry.judgePerPass (default 5) unjudged proposals are
 * judged per pass. Already-judged proposals (cache hit) do NOT count against
 * the cap.
 */
export async function runAutoMergePass(cfg: AshlrConfig): Promise<AutoMergePassResult> {
  const out: AutoMergePassResult = {
    attempted: 0,
    merged: 0,
    branched: 0,
    results: [],
    judged: 0,
    judgeCapped: 0,
  };
  if (cfg.foundry?.autoMerge?.enabled !== true) return out;
  if (killSwitchOn()) return out;

  let pending: Proposal[];
  try {
    pending = listProposals({ status: 'pending' });
  } catch {
    return out;
  }

  // M172: resolve judge per-pass cap from config (default 5).
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const judgePerPass =
    typeof foundry?.['judgePerPass'] === 'number' && foundry['judgePerPass'] > 0
      ? (foundry['judgePerPass'] as number)
      : 5;

  // Lazily resolve judge client once per pass (avoid re-calling getActiveClient
  // for every proposal). null = judge unavailable → fail-closed (proposals stay unjudged).
  let judgeClient: { complete: (system: string, user: string) => Promise<string>; model: string } | null | undefined =
    undefined; // undefined = not yet resolved

  for (const p of pending) {
    if (killSwitchOn()) break;
    // Frontier proposals are main-merge-eligible; MID proposals are branch/PR-
    // eligible ONLY when the separate default-off midToBranch flag is on. The
    // gate re-verifies authority/risk/verification — this is a fast pre-filter.
    const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
    if (p.engineTier !== 'frontier' && !midEligible) continue;

    // ── M172: judge-then-merge ─────────────────────────────────────────────
    // Skip judging if there is already a recent ship verdict + attestation.
    if (!hasRecentShipVerdict(p.id)) {
      // Check per-pass cap before spending a frontier judge call.
      if (out.judged >= judgePerPass) {
        out.judgeCapped++;
        continue; // Skip: backlog will be processed in subsequent pass ticks.
      }

      // Lazily resolve the judge client.
      if (judgeClient === undefined) {
        judgeClient = await resolveJudgeClientForPass(cfg);
      }

      if (judgeClient !== null) {
        let verdict: ManagerVerdict | null = null;
        try {
          verdict = await judgeProposal(p, cfg, judgeClient);
        } catch {
          // judgeProposal should never throw, but be defensive.
          verdict = null;
        }
        out.judged++;

        // Only proposals that the judge ships proceed to the merge gate.
        // 'review', 'noise', 'harmful' → leave pending (no autoMergeProposal call).
        if (!verdict || verdict.verdict !== 'ship') {
          continue;
        }
      } else {
        // No judge available → fail-closed: skip this proposal entirely.
        continue;
      }
    }
    // ── End M172 ──────────────────────────────────────────────────────────

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
