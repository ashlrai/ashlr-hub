/** Strict, side-effect-free selection-canary configuration resolution. */

import { randomBytes } from 'node:crypto';
import type { FinalConcurrentDispatchRoute } from './concurrent-dispatch.js';
import { isOrdinaryFleetGatewayDecision, type GatewayDecision } from './gateway.js';

export const SELECTION_CANARY_PROTOCOL = 'binary-uniform-v1' as const;

export type SelectionCanaryDisabledReason =
  | 'not-requested'
  | 'invalid-config'
  | 'unsupported-protocol'
  | 'gateway-disabled'
  | 'concurrent-dispatch-disabled';

export interface SelectionCanaryResolution {
  requested: boolean;
  protocol: typeof SELECTION_CANARY_PROTOCOL | null;
  eligible: boolean;
  disabledReason: SelectionCanaryDisabledReason | null;
}

export interface SelectionCanaryPrerequisites {
  gateway: boolean;
  concurrentDispatch: boolean;
}

/** Closed execution contexts; only a direct ordinary route can ever qualify. */
export type SelectionCanaryContext =
  | 'ordinary-direct'
  | 'best-of-n'
  | 'generated-repair'
  | 'diagnostic-reslice'
  | 'retry'
  | 'quota-fallback'
  | 'resource-fallback'
  | 'budget-pause'
  | 'local-only'
  | 'executor-substitution';

/** Ephemeral capacity evidence only; it is never a reservation or receipt. */
export interface SelectionCanaryCandidate {
  route: Readonly<Pick<FinalConcurrentDispatchRoute, 'backend' | 'tier' | 'model' | 'reason' | 'disposition'>>;
  candidateAllowed: boolean;
  slotsAtPlan: number;
  remainingBefore: number;
}

export interface SelectionCanaryEligibilityInput {
  candidates: readonly SelectionCanaryCandidate[];
  context: SelectionCanaryContext;
  snapshotState: 'fresh' | 'stale' | 'missing' | 'unknown';
}

export interface SelectionCanaryEligiblePair {
  protocol: typeof SELECTION_CANARY_PROTOCOL;
  candidates: readonly [SelectionCanaryCandidate, SelectionCanaryCandidate];
}

/** One cryptographic 50/50 choice from an already eligible pair. */
export interface SelectionCanaryDraw {
  protocol: typeof SELECTION_CANARY_PROTOCOL;
  selectedIndex: 0 | 1;
  selectionProbabilityPpm: 500_000;
  selected: SelectionCanaryCandidate;
}

/** Inputs from one real gateway decision and its final concurrent assignment. */
export interface CanonicalSelectionCanaryCandidateInput {
  gatewayDecision: GatewayDecision;
  finalRoute: FinalConcurrentDispatchRoute;
  candidateAllowed: boolean;
  slotsAtPlan: number;
  remainingBefore: number;
}

/**
 * Construct a candidate only when gateway intent survived planning unchanged.
 * It creates no alternative route and never infers ordinary status from text.
 */
export function canonicalSelectionCanaryCandidate(
  input: CanonicalSelectionCanaryCandidateInput,
): SelectionCanaryCandidate | null {
  const gatewayModel = input.gatewayDecision.model ?? null;
  if (!isOrdinaryFleetGatewayDecision(input.gatewayDecision) ||
    input.finalRoute.disposition !== 'gateway-exact' ||
    input.finalRoute.backend !== input.gatewayDecision.backend ||
    input.finalRoute.tier !== input.gatewayDecision.tier ||
    input.finalRoute.model !== gatewayModel) return null;
  return {
    route: input.finalRoute,
    candidateAllowed: input.candidateAllowed,
    slotsAtPlan: input.slotsAtPlan,
    remainingBefore: input.remainingBefore,
  };
}

function hasPositiveCapacity(candidate: SelectionCanaryCandidate): boolean {
  return Number.isSafeInteger(candidate.slotsAtPlan) && candidate.slotsAtPlan >= 1 &&
    Number.isSafeInteger(candidate.remainingBefore) && candidate.remainingBefore >= 1 &&
    candidate.remainingBefore <= candidate.slotsAtPlan;
}

/**
 * Pure eligibility classification for a future binary producer. It neither
 * samples nor reserves candidates, and it intentionally parses no reason text.
 */
export function selectEligibleBinaryCanaryPair(
  input: SelectionCanaryEligibilityInput,
): SelectionCanaryEligiblePair | null {
  if (input.context !== 'ordinary-direct' || input.snapshotState !== 'fresh' ||
    input.candidates.length !== 2) return null;
  const [first, second] = input.candidates;
  if (!first || !second || first.route.backend === 'builtin' || second.route.backend === 'builtin' ||
    first.route.backend === second.route.backend || first.route.tier === null || second.route.tier === null ||
    first.route.tier !== second.route.tier || first.route.disposition !== 'gateway-exact' ||
    second.route.disposition !== 'gateway-exact' || !first.candidateAllowed || !second.candidateAllowed ||
    !hasPositiveCapacity(first) || !hasPositiveCapacity(second)) return null;
  return { protocol: SELECTION_CANARY_PROTOCOL, candidates: [first, second] };
}

/**
 * Draw one route with an unbiased cryptographic bit after eligibility has
 * already excluded every non-ordinary context. There is deliberately no seed,
 * weighting, retry, or fallback input: callers either launch the selected route
 * with a matching signed receipt or do not launch a canary at all.
 */
export function drawEligibleBinaryCanaryRoute(
  pair: SelectionCanaryEligiblePair,
): SelectionCanaryDraw {
  const selectedIndex: 0 | 1 = (randomBytes(1)[0]! & 1) === 0 ? 0 : 1;
  return {
    protocol: pair.protocol,
    selectedIndex,
    selectionProbabilityPpm: 500_000,
    selected: pair.candidates[selectedIndex],
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function disabled(
  disabledReason: SelectionCanaryDisabledReason,
  requested = false,
  protocol: typeof SELECTION_CANARY_PROTOCOL | null = null,
): SelectionCanaryResolution {
  return { requested, protocol, eligible: false, disabledReason };
}

/**
 * Configuration eligibility only. This module has no dispatch dependency and
 * cannot activate a producer or alter route selection.
 */
export function resolveSelectionCanary(
  raw: unknown,
  prerequisites: SelectionCanaryPrerequisites,
): SelectionCanaryResolution {
  if (raw === undefined) return disabled('not-requested');
  if (!isPlainRecord(raw)) return disabled('invalid-config');
  if (Object.keys(raw).some((key) => key !== 'enabled' && key !== 'protocol')) {
    return disabled('invalid-config');
  }
  if (raw.enabled === undefined || raw.enabled === false) return disabled('not-requested');
  if (raw.enabled !== true) return disabled('invalid-config');
  if (raw.protocol !== undefined && raw.protocol !== SELECTION_CANARY_PROTOCOL) {
    return disabled(typeof raw.protocol === 'string' ? 'unsupported-protocol' : 'invalid-config', true);
  }
  if (!prerequisites.gateway) return disabled('gateway-disabled', true, SELECTION_CANARY_PROTOCOL);
  if (!prerequisites.concurrentDispatch) return disabled('concurrent-dispatch-disabled', true, SELECTION_CANARY_PROTOCOL);
  return { requested: true, protocol: SELECTION_CANARY_PROTOCOL, eligible: true, disabledReason: null };
}
