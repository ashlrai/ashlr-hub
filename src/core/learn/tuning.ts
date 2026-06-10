/**
 * tuning.ts — M26 PROPOSAL-ONLY routing/policy/prompt tuning suggestions.
 *
 * Derives tuning suggestions from a deterministic ReflectionReport and — only
 * when explicitly asked — routes them to the M23 Approval Inbox as PENDING
 * proposals. It NEVER auto-applies anything.
 *
 * HARD SAFETY INVARIANTS (M26) — paramount:
 *  - PROPOSAL-ONLY. The ONLY sink is the inbox via createProposal (status
 *    pending). There is NO code path here that writes the global config path,
 *    saves config, or mutates routing policy or prompts. Suggestions reason
 *    ABOUT routing but never change it. Each proposal is kind 'note' (a no-op
 *    record that, even when applied, mutates nothing).
 *  - DETERMINISTIC. deriveTuning() is pure over the report — no LLM, no network.
 *  - NO OUTWARD ACTION. Proposals sit pending; nothing is shipped or deployed.
 *  - BOUNDED. Caps the number of suggestions emitted.
 *  - NEVER THROWS. Degrades to [] / a no-op emit.
 *
 * METADATA ONLY — proposals carry titles + rationale grounded in metrics; never
 * secret values, never raw payloads.
 */

import type {
  Proposal,
  ReflectionReport,
  TuningProposal,
} from '../types.js';
import { createProposal } from '../inbox/store.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Max tuning suggestions derived/emitted per reflection. */
const MAX_TUNING = 6;

/** Minimum analyzed swarms before any quantitative heuristic fires (avoids
 *  drawing conclusions from a 1-2 run sample). */
const MIN_SAMPLE = 3;

/** A localShare at/above this with zero cloud spend => the org is already
 *  local-first; suggest raising the local-first routing threshold. */
const HIGH_LOCAL_SHARE = 0.9;

/** A failure cluster this size (or larger) is "recurring" => playbook-worthy. */
const RECURRING_FAILURE_MIN = 2;

/** A category costing at least this multiple of the fleet average looks
 *  over-provisioned => flag as over-budget. */
const OVER_BUDGET_MULTIPLE = 1.75;

// ---------------------------------------------------------------------------
// Pure derivation (exported for testing) — NO I/O, NO LLM, NO MUTATION
// ---------------------------------------------------------------------------

/** Round a 0..1 confidence to 2 decimals, clamped into [0,1]. */
function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const c = Math.max(0, Math.min(1, n));
  return Math.round(c * 100) / 100;
}

/**
 * Derive PROPOSAL-ONLY tuning suggestions from a ReflectionReport. Pure over
 * the report; never throws; never mutates anything; makes ZERO I/O or network
 * calls. Returns at most MAX_TUNING suggestions, highest-confidence first.
 *
 * Heuristics (deterministic, grounded in report metrics):
 *  - High localShare + zero cloud spend     -> "raise local-first threshold".
 *  - A recurring failure cluster            -> "add a playbook for failure Y".
 *  - A category succeeding ~every time      -> "lower retry cap for category X".
 *  - A category far costlier than the fleet -> "flag over-budget category X".
 *  - Effectiveness regressed vs prior        -> "review recent routing/policy".
 *
 * NOTE: every suggestion only DESCRIBES a possible change. Nothing here applies
 * it — emitTuningProposals() routes them to the inbox as inert pending notes.
 */
export function deriveTuning(report: ReflectionReport): TuningProposal[] {
  const out: TuningProposal[] = [];
  try {
    const analyzed = report.swarmsAnalyzed | 0;

    // -- 1. Routing: already local-first => suggest raising the threshold. ----
    // Only when we have a real sample, the local share is dominant, and there
    // was no cloud spend to justify keeping headroom for escalation.
    if (
      analyzed >= MIN_SAMPLE &&
      report.localShare >= HIGH_LOCAL_SHARE &&
      report.totalCostUsd <= 0
    ) {
      const localPct = Math.round(report.localShare * 100);
      out.push({
        key: 'routing.local-first-threshold',
        area: 'routing',
        title: 'Raise the local-first routing threshold',
        rationale:
          `${localPct}% of token usage already ran on LOCAL providers across ` +
          `${analyzed} swarms with $0 cloud spend. Routing could bias even more ` +
          `work to local models before escalating to cloud. (Suggestion only — ` +
          `routing is not changed.)`,
        // More confident the larger the sample and the higher the local share.
        confidence: clampConfidence(
          0.4 + report.localShare * 0.4 + (Math.min(analyzed, 20) / 20) * 0.2,
        ),
      });
    }

    // -- 2. Playbook: recurring failure clusters => suggest a playbook. -------
    for (const fm of report.topFailures ?? []) {
      if (fm.count < RECURRING_FAILURE_MIN) continue;
      const phases = (fm.phases ?? []).filter(Boolean);
      const where = phases.length ? ` (most often in phase ${phases[0]})` : '';
      out.push({
        key: `playbook.failure.${fm.key}`,
        area: 'playbook',
        title: `Add a playbook for recurring failure: ${fm.label}`,
        rationale:
          `"${fm.label}" recurred ${fm.count} time(s)${where}. A distilled ` +
          `playbook capturing the fix would auto-inject into future agents and ` +
          `reduce repeat failures.`,
        // Confidence scales with how often the failure recurred (caps at 1.0).
        confidence: clampConfidence(0.45 + (Math.min(fm.count, 8) / 8) * 0.45),
      });
    }

    // -- 3/4. Per-category retry + budget heuristics. ------------------------
    const cats = report.goalCategories ?? [];
    const fleetAvgCost = report.avgCostUsd;
    for (const cat of cats) {
      // 3. A category that essentially always succeeds first-try => the retry
      //    cap for that kind of work is likely larger than needed.
      if (cat.swarms >= MIN_SAMPLE && cat.successRate >= 1) {
        out.push({
          key: `policy.retry-cap.${cat.category}`,
          area: 'policy',
          title: `Lower the retry cap for "${cat.category}" work`,
          rationale:
            `"${cat.category}" succeeded on ${cat.swarms}/${cat.swarms} swarms ` +
            `(100%). Retries for this category may rarely fire — a lower retry ` +
            `cap could cut wasted steps with little risk. (Suggestion only.)`,
          confidence: clampConfidence(
            0.35 + (Math.min(cat.swarms, 12) / 12) * 0.4,
          ),
        });
      }

      // 4. A category costing far more than the fleet average => flag it.
      if (
        cat.swarms >= MIN_SAMPLE &&
        fleetAvgCost > 0 &&
        cat.avgCostUsd >= fleetAvgCost * OVER_BUDGET_MULTIPLE
      ) {
        const x = cat.avgCostUsd / fleetAvgCost;
        out.push({
          key: `policy.budget.${cat.category}`,
          area: 'policy',
          title: `Flag over-budget goal category: "${cat.category}"`,
          rationale:
            `"${cat.category}" averaged $${cat.avgCostUsd.toFixed(4)} per swarm ` +
            `— ${x.toFixed(1)}x the fleet average of ` +
            `$${fleetAvgCost.toFixed(4)}. Worth a budget cap or a cheaper ` +
            `routing tier for this category. (Suggestion only.)`,
          confidence: clampConfidence(0.4 + (Math.min(x - 1, 3) / 3) * 0.4),
        });
      }
    }

    // -- 5. Regression watch: effectiveness dropped week-over-week. ----------
    const eff = report.delta?.effectivenessPct;
    if (analyzed >= MIN_SAMPLE && typeof eff === 'number' && eff <= -10) {
      out.push({
        key: 'policy.effectiveness-regression',
        area: 'policy',
        title: 'Review recent routing/policy: effectiveness regressed',
        rationale:
          `Success rate fell ${Math.abs(Math.round(eff))} points vs the prior ` +
          `snapshot. Recent routing or policy changes may be worth reviewing. ` +
          `(Suggestion only — nothing is reverted.)`,
        confidence: clampConfidence(
          0.4 + (Math.min(Math.abs(eff), 50) / 50) * 0.4,
        ),
      });
    }

    // Highest-confidence first, then stable by key. Bounded by MAX_TUNING.
    out.sort(
      (a, b) => b.confidence - a.confidence || a.key.localeCompare(b.key),
    );
    return out.slice(0, MAX_TUNING);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public: emit to the Approval Inbox (the SOLE sink)
// ---------------------------------------------------------------------------

/**
 * Convert derived TuningProposals into PENDING M23 inbox proposals via
 * createProposal(). Returns the created Proposal records.
 *
 * GUARDRAIL: this is the ONLY outward sink for tuning. Each proposal is created
 * with kind 'note' (a no-op record — applying it mutates NOTHING), origin
 * 'manual', repo null, status 'pending'. There is NO path here that touches the
 * global config, routing policy, or prompts. Never throws.
 */
export function emitTuningProposals(suggestions: TuningProposal[]): Proposal[] {
  const created: Proposal[] = [];
  try {
    // Bounded defensively even though deriveTuning already caps the input.
    for (const s of (suggestions ?? []).slice(0, MAX_TUNING)) {
      try {
        const pct = Math.round(clampConfidence(s.confidence) * 100);
        const proposal = createProposal({
          repo: null,
          origin: 'manual',
          // 'note' is a no-op record: approving/applying it mutates NOTHING.
          kind: 'note',
          title: `[tuning] ${s.title}`,
          summary:
            `${s.rationale}\n\n` +
            `area: ${s.area} · key: ${s.key} · confidence: ${pct}%\n` +
            `This is a tuning SUGGESTION only — approving it records the ` +
            `decision but changes no configuration, routing, policy, or prompt.`,
        });
        created.push(proposal);
      } catch {
        // Skip a single failed proposal; keep emitting the rest.
      }
    }
    return created;
  } catch {
    return created;
  }
}
