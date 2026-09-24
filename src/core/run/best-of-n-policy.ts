import type { BestOfNCandidateSpec, EngineId } from '../types.js';
import type { BudgetMode } from '../routing/types.js';

/** Hard process/cost containment for one best-of-N selection. */
export const MAX_BEST_OF_N_CANDIDATES = 8;

/**
 * A best-of-N call already consumes one outer daemon slot. Keep its internal
 * producer and critic fan-out smaller so it cannot bypass the fleet governor.
 */
export const MAX_BEST_OF_N_CONCURRENCY = 2;

/** Maximum configured candidate specs inspected before dispatch. */
export const MAX_BEST_OF_N_CANDIDATE_SPECS_INSPECTED = 64;

/**
 * Resolve an untrusted/configured candidate count conservatively.
 * Invalid values fail closed to one candidate; valid values are floored and
 * clamped to the hard maximum.
 */
export function resolveBestOfNCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_BEST_OF_N_CANDIDATES, Math.floor(value));
}

// ---------------------------------------------------------------------------
// V3.10 (SPEC-310B §3 Routing): autonomous best-of-N candidate plan
// ---------------------------------------------------------------------------


export type AutonomousDifficulty = 'low' | 'medium' | 'high';

export interface AutonomousBestOfNInput {
  difficulty: AutonomousDifficulty;
  /** Earlier failed attempts at this work item (rejects, reverts, empty diffs). */
  priorFailures: number;
  mode: BudgetMode;
  /** The SeatRouter admitted the grok-a seat for producing right now. */
  grokEligible: boolean;
  grokModel?: string;
  /** The free local lane, or null when no local runtime is up. */
  local: { engine: 'llama-server' | 'local-coder'; model: string } | null;
  /** The SeatRouter admitted claude-a for producing right now (all-in only is honoured). */
  claudeEligible: boolean;
  claudeModel?: string;
}

export interface AutonomousBestOfNPlan {
  run: boolean;
  /** Stable machine reason — surfaced in the fleet's "why" views. */
  reason: 'not-needed' | 'no-local-lane' | 'no-engine-diversity' | 'planned';
  candidates: BestOfNCandidateSpec[];
}

/** Local candidates per plan: free compute, varied by best-of-n's temperature/seed schedule. */
const LOCAL_CANDIDATES = 2;

/**
 * Plan a best-of-N fan-out for one autonomous work item. PURE.
 *
 * When: difficulty `high`, or the item already failed once — a single cheap
 * attempt is the default everywhere else (best-of-N costs N producers).
 *
 * What: one frontier candidate + two local candidates. The frontier candidate
 * is grok-cli (Grok reserve 0%, so it is the seat autonomy is meant to use);
 * Claude joins ONLY in `all-in` mode, and only replaces Grok when Grok is not
 * admitted — `balanced` and `reserve` keep claude-a for Mason. Engine
 * diversity is REQUIRED: without a frontier candidate the set would be two
 * samples of one local model, which best-of-n's judge cannot meaningfully
 * separate, so the plan declines (`no-engine-diversity`) and the item runs as
 * a single local attempt.
 */
export function planAutonomousBestOfN(input: AutonomousBestOfNInput): AutonomousBestOfNPlan {
  const failures = Number.isFinite(input.priorFailures) ? Math.max(0, Math.floor(input.priorFailures)) : 0;
  if (input.difficulty !== 'high' && failures < 1) return { run: false, reason: 'not-needed', candidates: [] };
  if (!input.local || !input.local.model.trim()) return { run: false, reason: 'no-local-lane', candidates: [] };
  let frontier: BestOfNCandidateSpec | null = null;
  if (input.grokEligible) {
    frontier = { engine: 'grok-cli' as EngineId, ...(input.grokModel ? { model: input.grokModel } : {}) };
  } else if (input.claudeEligible && input.mode === 'all-in') {
    frontier = { engine: 'claude', ...(input.claudeModel ? { model: input.claudeModel } : {}) };
  }
  if (!frontier) return { run: false, reason: 'no-engine-diversity', candidates: [] };
  const localSpec: BestOfNCandidateSpec = { engine: input.local.engine as EngineId, model: input.local.model };
  const candidates = [frontier, ...Array.from({ length: LOCAL_CANDIDATES }, () => ({ ...localSpec }))];
  // In all-in mode with both seats admitted, Claude is an ADDITIONAL candidate.
  if (input.mode === 'all-in' && input.grokEligible && input.claudeEligible) {
    candidates.splice(1, 0, { engine: 'claude', ...(input.claudeModel ? { model: input.claudeModel } : {}) });
  }
  return { run: true, reason: 'planned', candidates: candidates.slice(0, MAX_BEST_OF_N_CANDIDATES) };
}
