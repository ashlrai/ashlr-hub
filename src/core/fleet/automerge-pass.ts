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
import { judgeProposal, resolveFrontierJudgeClient, type ManagerVerdict } from './manager.js';
// M193: additive gate-modules (flag-gated, default OFF, only tighten)
import { redTeamProposal } from './red-team.js';
import { analyzeBlastRadius } from '../run/blast-radius.js';
import { checkSpecContract } from '../run/spec-contract.js';
// M212: proactive notifications (fire-and-forget, never throws, never alters control flow)
import { notifyFleetEvent } from '../comms/events.js';
// M214: fleet→pulse OTLP emit (fire-and-forget, flag-gated cfg.foundry.pulseEmit, default OFF)
import { emitMerge, emitJudgeVerdict } from '../integrations/fleet-pulse-emit.js';
// M235: recursive self-improvement write-back (fire-and-forget, gated cfg.foundry.selfImprove, default ON)
import { learnFromRejection } from './self-improve.js';

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
  /**
   * M193: proposals that passed the ship-verdict gate but were blocked by an
   * additive check (red-team / blast-radius / spec-contract). Per-skip detail
   * recorded here for observability.
   */
  skipped: Array<{ proposalId: string; check: string; reason: string }>;
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
    skipped: [],
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
    undefined; // undefined = not yet resolved; null = unavailable (fail-closed)

  for (const p of pending) {
    if (killSwitchOn()) break;
    // Pre-filter: decide whether this proposal is eligible to be judged/merged
    // this pass. The decision is trust-basis-aware (M175).
    //
    // trustBasis='verification' (M153/M175): ANY tier may be judged. The full
    // verification gate (frontier-judge-ship + verifyResult + risk + scope +
    // EDV + signed attestation) enforces the safety bar — the GATE is the
    // trust, not the producer's tier.  We do NOT skip local/mid proposals here;
    // autoMergeProposal will refuse them if any criterion is unmet.
    //
    // trustBasis='tier' or absent (default / M51): frontier proposals are
    // main-merge-eligible; mid proposals are branch/PR-eligible ONLY when the
    // separate default-off midToBranch flag is on; local/undefined are skipped.
    // This path is BYTE-IDENTICAL to pre-M175 behaviour — M51 is untouched.
    const trustBasis = (cfg.foundry as Record<string, unknown> | undefined)
      ?.['autoMerge'] as Record<string, unknown> | undefined;
    const isVerificationMode =
      (trustBasis?.['trustBasis'] as string | undefined) === 'verification';

    if (!isVerificationMode) {
      // Tier-mode pre-filter (M51 — unchanged).
      const midEligible = cfg.foundry?.autoMerge?.midToBranch === true && p.engineTier === 'mid';
      if (p.engineTier !== 'frontier' && !midEligible) continue;
    }
    // In verification mode: no tier pre-filter — fall through to judge-then-merge.

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
        judgeClient = resolveFrontierJudgeClient(cfg);
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
        // M214: fire-and-forget judge-verdict emit — additive, never throws, no control-flow change.
        void emitJudgeVerdict(cfg, p.id, verdict?.verdict ?? 'null', p.repo, p.engineTier).catch(() => {});

        // Only proposals that the judge ships proceed to the merge gate.
        // 'review', 'noise', 'harmful' → leave pending (no autoMergeProposal call).
        if (!verdict || verdict.verdict !== 'ship') {
          // M235: fire-and-forget self-improvement write-back — additive, never throws, no control-flow change.
          try {
            learnFromRejection(
              p.id,
              p.title ?? '',
              verdict?.verdict ?? 'review',
              (verdict as unknown as Record<string, unknown>)?.['rationale'] as string ?? '',
              cfg,
            );
          } catch { /* learnFromRejection never throws; defensive */ }
          continue;
        }
      } else {
        // No judge available → fail-closed: skip this proposal entirely.
        continue;
      }
    }
    // ── End M172 ──────────────────────────────────────────────────────────

    out.attempted++;

    // ── M193: additive gate-checks (flag-gated, default OFF, only tighten) ──
    // Each check runs only when its feature flag is enabled. A check that
    // throws is treated as passed (fail-open) — the module's own never-throws
    // contract governs the actual verdict, but a caught exception must not
    // block a merge the core gate approved. When a check FAILS (explicit
    // result), the proposal is skipped (stays pending) and the reason is
    // recorded. These checks NEVER cause a merge that wouldn't happen otherwise.

    // M191 — Red-team critic
    if ((foundry as Record<string, unknown> | undefined)?.['redTeam'] === true) {
      let shouldSkip = false;
      try {
        const rt = await redTeamProposal(p, cfg);
        if (rt.verdict === 'broken') {
          shouldSkip = true;
          out.skipped.push({ proposalId: p.id, check: 'red-team', reason: rt.detail });
        }
      } catch {
        // fail-open: a thrown exception does not block the merge
      }
      if (shouldSkip) continue;
    }

    // M188 — Blast-radius
    if ((foundry as Record<string, unknown> | undefined)?.['blastRadius'] === true) {
      let shouldSkip = false;
      try {
        const changedFiles = p.diff
          ? p.diff
              .split('\n')
              .filter((l: string) => l.startsWith('+++ '))
              .map((l: string) => l.slice(4).replace(/^[ab]\//, '').trim())
              .filter((f: string) => f && f !== '/dev/null')
          : [];
        const br = await analyzeBlastRadius(
          { repo: p.repo ?? '', changedFiles },
          cfg as unknown as import('../run/blast-radius.js').BlastRadiusConfig,
        );
        if (br.risk === 'high') {
          shouldSkip = true;
          out.skipped.push({ proposalId: p.id, check: 'blast-radius', reason: br.detail });
        }
      } catch {
        // fail-open
      }
      if (shouldSkip) continue;
    }

    // M190 — Spec-contract
    if ((foundry as Record<string, unknown> | undefined)?.['specContract'] === true) {
      const specId = (p as unknown as Record<string, unknown>)['specId'];
      if (specId && typeof specId === 'string') {
        let shouldSkip = false;
        try {
          // Lazily load the spec body so this path costs nothing when no spec is present.
          let specInput: import('../run/spec-contract.js').SpecInput = null;
          try {
            const { loadSpec } = await import('../spec/spec-store.js');
            const loaded = loadSpec(specId, p.repo ?? undefined);
            if (loaded) specInput = { meta: loaded.meta, body: loaded.body };
          } catch {
            // Spec load failed — treat as "no spec" (check is a no-op when spec is absent)
            specInput = null;
          }
          if (specInput !== null) {
            const sc = await checkSpecContract(
              { spec: specInput, repoDir: p.repo ?? undefined, diff: p.diff },
              cfg,
            );
            if (!sc.satisfied) {
              shouldSkip = true;
              out.skipped.push({ proposalId: p.id, check: 'spec-contract', reason: sc.detail.reason ?? 'spec contract unsatisfied' });
            }
          }
        } catch {
          // fail-open
        }
        if (shouldSkip) continue;
      }
    }
    // ── End M193 ──────────────────────────────────────────────────────────

    try {
      const res = await autoMergeProposal(p.id, cfg);
      out.results.push(res);
      if (res.merged) {
        out.merged++;
        // M212: fire-and-forget merge notification — additive, never throws, no control-flow change.
        notifyFleetEvent('merge', { repo: p.repo ?? undefined, title: p.title, engine: p.engineTier }, cfg).catch(() => {});
        // M214: fire-and-forget merge emit to Pulse OTLP — additive, never throws, no control-flow change.
        void emitMerge(cfg, p.id, p.repo, p.engineTier).catch(() => {});
      }
      if (res.branched) out.branched++;
    } catch {
      // autoMergeProposal never throws by contract; defensive only.
    }
  }
  return out;
}
