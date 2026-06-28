/**
 * edv-verify.ts — M151: Execute-Distill-Verify independent-confirmation helper.
 *
 * The "self-confirmation trap": a Manager that accepts its own trajectory
 * provides no independent signal — a wrongly-accepted proposal positively
 * reinforces its source at full weight, compounding error over time.
 *
 * Fix: require an INDEPENDENT confirmation before treating a merged/accepted
 * outcome as a full-strength positive signal. Two objective signals are
 * recognised (in priority order):
 *
 *   1. testPass   — proposal.verifyResult.passed === true (a test/verify step
 *                   ran and passed; this is an OBJECTIVE result, not the same
 *                   Manager that made the accept decision).
 *   2. verifierVerdict — a DecisionEntry with action === 'verified' exists for
 *                   this proposal AND its verdict is not 'rejected'/'noise'/
 *                   'harmful' (a SEPARATE verifier agent signed off).
 *
 * When neither signal is present, or when both disagree (verify failed), the
 * accept is "unverified" and contributes EDV_UNVERIFIED_WEIGHT to the merged
 * accumulator rather than 1.0. This keeps the loop learning but prevents a
 * single wrongly-confident Manager from fully poisoning its source's prior.
 *
 * Weights:
 *   confirmed   → 1.0  (full positive reinforcement)
 *   unverified  → EDV_UNVERIFIED_WEIGHT = 0.3  (attenuated; still learns)
 *
 * Flag-off: when cfg.foundry?.edvVerify !== true, callers MUST use 1.0 and
 * never call edvConfirmationWeight (the feedback path is byte-identical to
 * pre-M151). The helper is exported for tests; it never throws.
 */

import type { AshlrConfig, DecisionEntry, Proposal } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Weight applied to a merged/accepted outcome that lacks independent
 * confirmation. Chosen conservatively (< 0.5) so unverified accepts cannot
 * flip a source's multiplier above the neutral 1.0 point on their own, while
 * still allowing incremental learning from partial signal.
 *
 * The full [0.5, 1.5] multiplier clamp in scoreAdjustment still applies on
 * top of this; this weight only governs how much a single unverified accept
 * contributes to `mergedWeightedSum`.
 */
export const EDV_UNVERIFIED_WEIGHT = 0.3;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type EdvConfirmationSource = 'testPass' | 'verifierVerdict' | 'none';

export interface EdvConfirmationResult {
  /** True when an independent signal confirms the accept. */
  confirmed: boolean;
  /** Which signal provided confirmation (or 'none'). */
  source: EdvConfirmationSource;
  /**
   * Fractional weight to add to the mergedWeightedSum accumulator.
   *   confirmed   → 1.0
   *   unverified  → EDV_UNVERIFIED_WEIGHT
   */
  weight: number;
}

// ---------------------------------------------------------------------------
// edvConfirmationWeight
// ---------------------------------------------------------------------------

/**
 * For a given proposal + the full set of decisions referencing it, determine
 * whether an independent confirmation exists and return the appropriate weight.
 *
 * Priority:
 *   1. proposal.verifyResult.passed === true  → confirmed via testPass
 *   2. proposal.verifyResult.passed === false → not confirmed (failed test)
 *   3. decisions include action==='verified' with a non-negative verdict
 *      (i.e. verdict is absent, 'approved', 'applied', or 'ship')  → confirmed
 *   4. decisions include action==='verified' with a negative verdict
 *      ('rejected'/'noise'/'harmful')  → not confirmed
 *   5. none of the above  → unverified (no signal either way)
 *
 * Never throws.
 *
 * @param cfg — optional operator config. When present, `cfg.foundry?.edvUnverifiedWeight`
 *   overrides EDV_UNVERIFIED_WEIGHT for the unverified/negative-signal paths so the
 *   operator can tighten (lower) or relax (raise, but never above 1.0) the weight
 *   without changing the module constant. Absent/undefined → module default (back-compat).
 */
export function edvConfirmationWeight(
  proposal: Proposal,
  decisionsForProposal: DecisionEntry[],
  cfg?: AshlrConfig,
): EdvConfirmationResult {
  // Resolve the unverified weight: honour operator override when it is a finite
  // number in (0, 1). Values outside that range (≤0 or ≥1) fall back to the
  // module default so a misconfiguration cannot accidentally confirm-all (≥1)
  // or zero-out signal (≤0).
  const rawOverride = (cfg?.foundry as Record<string, unknown> | undefined)?.['edvUnverifiedWeight'];
  const unverifiedWeight =
    typeof rawOverride === 'number' && rawOverride > 0 && rawOverride < 1
      ? rawOverride
      : EDV_UNVERIFIED_WEIGHT;

  try {
    // ── Signal 1 & 2: objective test/verify result on the proposal itself ─────
    if (proposal.verifyResult !== undefined) {
      if (proposal.verifyResult.passed) {
        return { confirmed: true, source: 'testPass', weight: 1.0 };
      }
      // verifyResult present but failed — explicit negative signal.
      return { confirmed: false, source: 'testPass', weight: unverifiedWeight };
    }

    // ── Signal 3 & 4: separate verifier entry in the decisions ledger ─────────
    const NEGATIVE_VERDICTS = new Set(['rejected', 'noise', 'harmful']);
    const verifierEntries = decisionsForProposal.filter((d) => d.action === 'verified');
    if (verifierEntries.length > 0) {
      // If ANY verifier verdict is negative, treat as not confirmed.
      const anyNegative = verifierEntries.some(
        (d) => d.verdict !== undefined && NEGATIVE_VERDICTS.has(d.verdict.toLowerCase()),
      );
      if (anyNegative) {
        return { confirmed: false, source: 'verifierVerdict', weight: unverifiedWeight };
      }
      // At least one verifier entry with a non-negative (or absent) verdict.
      return { confirmed: true, source: 'verifierVerdict', weight: 1.0 };
    }

    // ── Signal 5: no independent signal ───────────────────────────────────────
    return { confirmed: false, source: 'none', weight: unverifiedWeight };
  } catch {
    // Defensive: never throw, treat errors as unverified.
    return { confirmed: false, source: 'none', weight: unverifiedWeight };
  }
}
