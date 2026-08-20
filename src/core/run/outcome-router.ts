/**
 * outcome-router.ts — pure, planning-only outcome route projection.
 *
 * This module has no execution, provider, quota, spend, apply, merge, push, or
 * deploy authority. Callers must supply affirmative outer eligibility for all
 * four constraints. Learned evidence is reported but never changes selection.
 */

import { types as nodeUtilTypes } from "node:util";

import {
  CAPABILITY_CATALOG_EPOCH,
  CAPABILITY_CATALOG_DIGEST,
  CAPABILITY_CATALOG_VERSION,
  CAPABILITY_MODELS,
  digestCanonical,
  type CapabilityModelEntry,
  type ConversationStateMode,
  type PromptCacheMode,
  type ReasoningEffort,
  type ToolProtocol,
} from "./capability-catalog.js";

export const OUTCOME_ROUTER_POLICY_VERSION = "outcome-router-v1" as const;

export type OuterEligibilityState = "eligible" | "blocked" | "unknown";
export type OutcomePriority = "quality-first" | "balanced" | "cost-first";

export interface OuterRouteEligibility {
  readonly canonicalModelId: string;
  readonly availability: OuterEligibilityState;
  readonly quota: OuterEligibilityState;
  readonly spend: OuterEligibilityState;
  readonly authority: OuterEligibilityState;
}

export interface OutcomeRequirements {
  readonly asOfDate: string;
  readonly priority: OutcomePriority;
  readonly minimumContextTokens: number;
  readonly minimumOutputTokens: number;
  /** Expected billable workload, required to rank OpenAI by cost. */
  readonly estimatedInputTokens?: number;
  readonly estimatedOutputTokens?: number;
  readonly estimatedReasoningTokens?: number;
  readonly effort: ReasoningEffort | "provider-default";
  readonly toolProtocol?: ToolProtocol;
  readonly promptCacheMode?: PromptCacheMode;
  readonly conversationState?: ConversationStateMode;
  readonly structuredOutputs?: boolean;
  readonly imageInput?: boolean;
}

export interface LearnedOutcomeObservation {
  readonly canonicalModelId: string;
  readonly sampleCount: number;
  readonly observedSuccessRate: number | null;
}

export interface OutcomeRouteInput {
  readonly requirements: OutcomeRequirements;
  /** Every candidate requires a caller-provided envelope; omission is unknown. */
  readonly outerEligibility: readonly OuterRouteEligibility[];
  /** Observation-only until a separately governed promotion changes this contract. */
  readonly learnedEvidence?: readonly LearnedOutcomeObservation[];
}

export type OutcomeRouteRejectionCode =
  | "outer-eligibility-missing"
  | "outer-availability-blocked"
  | "outer-availability-unknown"
  | "outer-quota-blocked"
  | "outer-quota-unknown"
  | "outer-spend-blocked"
  | "outer-spend-unknown"
  | "outer-authority-blocked"
  | "outer-authority-unknown"
  | "outer-eligibility-duplicate"
  | "invalid-input"
  | "catalog-availability-unknown"
  | "catalog-limits-unknown"
  | "context-ceiling"
  | "output-ceiling"
  | "estimated-input-ceiling"
  | "estimated-output-ceiling"
  | "estimated-context-ceiling"
  | "long-context-tier-indeterminate"
  | "tool-protocol-unknown"
  | "tool-protocol-mismatch"
  | "reasoning-unknown"
  | "reasoning-effort-unsupported"
  | "cache-support-unknown"
  | "cache-mode-unsupported"
  | "state-support-unknown"
  | "state-mode-unsupported"
  | "structured-output-unknown"
  | "structured-output-unsupported"
  | "image-input-unknown"
  | "image-input-unsupported"
  | "pricing-unknown"
  | "pricing-expired";

export interface OutcomeRouteRejection {
  readonly canonicalModelId: string;
  readonly codes: readonly OutcomeRouteRejectionCode[];
}

interface RouteMetadata {
  readonly catalogVersion: typeof CAPABILITY_CATALOG_VERSION;
  readonly catalogEpoch: typeof CAPABILITY_CATALOG_EPOCH;
  readonly policyVersion: typeof OUTCOME_ROUTER_POLICY_VERSION;
  readonly effort: ReasoningEffort | "provider-default";
  readonly learnedEvidence: {
    readonly mode: "observation-only";
    readonly observationCount: number;
    readonly appliedToSelection: false;
  };
}

export interface OutcomeRouteReceipt {
  readonly schemaVersion: "outcome-route-receipt-v1";
  readonly catalogDigest: string;
  readonly inputDigest: string;
  readonly decisionDigest: string;
  readonly basis: {
    readonly catalogEpoch: typeof CAPABILITY_CATALOG_EPOCH;
    readonly policyVersion: typeof OUTCOME_ROUTER_POLICY_VERSION;
    readonly priority: OutcomePriority | "invalid-input";
    readonly costBasis:
      "excluded-quality-first" | "estimated-workload" | "invalid-input";
    readonly learnedEvidence: "observation-only";
  };
}

export type OutcomeRouteDecision =
  | (RouteMetadata & {
      readonly status: "selected";
      readonly model: string;
      readonly providerModelId: string;
      readonly policyScore: number;
      readonly selectionPropensity: 1;
      readonly reason: string;
      readonly rejected: readonly OutcomeRouteRejection[];
      readonly receipt: OutcomeRouteReceipt;
    })
  | (RouteMetadata & {
      readonly status: "no-route";
      readonly model: null;
      readonly providerModelId: null;
      readonly policyScore: 0;
      readonly selectionPropensity: 0;
      readonly reason: string;
      readonly rejected: readonly OutcomeRouteRejection[];
      readonly receipt: OutcomeRouteReceipt;
    });

type WithoutReceipt<T> = T extends unknown ? Omit<T, "receipt"> : never;
type OutcomeRouteDecisionCore = WithoutReceipt<OutcomeRouteDecision>;

interface RankedCandidate {
  readonly entry: CapabilityModelEntry;
  readonly policyScore: number;
  readonly workloadCost: number;
}

const INPUT_LIMITS = Object.freeze({
  maxOuterEligibility: 64,
  maxLearnedEvidence: 128,
  maxModelIdLength: 160,
});

const PRIORITIES: readonly OutcomePriority[] = [
  "quality-first",
  "balanced",
  "cost-first",
];
const EFFORTS: readonly OutcomeRequirements["effort"][] = [
  "provider-default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const TOOL_PROTOCOLS: readonly ToolProtocol[] = [
  "openai-responses-tools-v1",
  "anthropic-messages-tools-v1",
];
const CACHE_MODES: readonly PromptCacheMode[] = [
  "implicit",
  "explicit-breakpoint",
];
const STATE_MODES: readonly ConversationStateMode[] = [
  "server-continuation",
  "client-replay-stateless",
];
const ELIGIBILITY_STATES: readonly OuterEligibilityState[] = [
  "eligible",
  "blocked",
  "unknown",
];

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | null {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value)
  )
    return null;
  if (Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowed = new Set(allowedKeys);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(descriptors)) {
    if (!allowed.has(key)) return null;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function exactArray(value: unknown, maxLength: number): unknown[] | null {
  if (
    value === null ||
    typeof value !== "object" ||
    nodeUtilTypes.isProxy(value)
  )
    return null;
  if (!Array.isArray(value) || value.length > maxLength) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: unknown[] = [];
  for (const key of Object.keys(descriptors)) {
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) return null;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) return null;
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function boundedModelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= INPUT_LIMITS.maxModelIdLength &&
    value.trim() === value
  );
}

function optionalEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && allowed.includes(value as T))
  );
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOutcomeRouteInput(value: unknown): OutcomeRouteInput | null {
  try {
    const root = exactRecord(value, [
      "requirements",
      "outerEligibility",
      "learnedEvidence",
    ]);
    if (
      !root ||
      root.requirements === undefined ||
      root.outerEligibility === undefined
    )
      return null;
    const requirements = exactRecord(root.requirements, [
      "asOfDate",
      "priority",
      "minimumContextTokens",
      "minimumOutputTokens",
      "estimatedInputTokens",
      "estimatedOutputTokens",
      "estimatedReasoningTokens",
      "effort",
      "toolProtocol",
      "promptCacheMode",
      "conversationState",
      "structuredOutputs",
      "imageInput",
    ]);
    if (!requirements) return null;
    if (
      typeof requirements.asOfDate !== "string" ||
      requirements.asOfDate.length !== 10 ||
      !PRIORITIES.includes(requirements.priority as OutcomePriority) ||
      !nonnegativeSafeInteger(requirements.minimumContextTokens) ||
      !nonnegativeSafeInteger(requirements.minimumOutputTokens) ||
      !EFFORTS.includes(requirements.effort as OutcomeRequirements["effort"]) ||
      !optionalEnum(requirements.toolProtocol, TOOL_PROTOCOLS) ||
      !optionalEnum(requirements.promptCacheMode, CACHE_MODES) ||
      !optionalEnum(requirements.conversationState, STATE_MODES) ||
      !optionalBoolean(requirements.structuredOutputs) ||
      !optionalBoolean(requirements.imageInput)
    ) {
      return null;
    }

    const estimates = [
      requirements.estimatedInputTokens,
      requirements.estimatedOutputTokens,
      requirements.estimatedReasoningTokens,
    ];
    const estimatesAbsent = estimates.every(
      (estimate) => estimate === undefined,
    );
    const estimatesPresent = estimates.every(nonnegativeSafeInteger);
    if (!estimatesAbsent && !estimatesPresent) return null;
    if (
      estimatesPresent &&
      (estimates[0] as number) +
        (estimates[1] as number) +
        (estimates[2] as number) <=
        0
    ) {
      return null;
    }

    const outerValues = exactArray(
      root.outerEligibility,
      INPUT_LIMITS.maxOuterEligibility,
    );
    if (!outerValues) return null;
    const outerEligibility: OuterRouteEligibility[] = [];
    for (const candidate of outerValues) {
      const record = exactRecord(candidate, [
        "canonicalModelId",
        "availability",
        "quota",
        "spend",
        "authority",
      ]);
      if (
        !record ||
        !boundedModelId(record.canonicalModelId) ||
        !ELIGIBILITY_STATES.includes(
          record.availability as OuterEligibilityState,
        ) ||
        !ELIGIBILITY_STATES.includes(record.quota as OuterEligibilityState) ||
        !ELIGIBILITY_STATES.includes(record.spend as OuterEligibilityState) ||
        !ELIGIBILITY_STATES.includes(record.authority as OuterEligibilityState)
      ) {
        return null;
      }
      outerEligibility.push({
        canonicalModelId: record.canonicalModelId,
        availability: record.availability as OuterEligibilityState,
        quota: record.quota as OuterEligibilityState,
        spend: record.spend as OuterEligibilityState,
        authority: record.authority as OuterEligibilityState,
      });
    }
    outerEligibility.sort((left, right) =>
      compareCanonicalModelIds(left.canonicalModelId, right.canonicalModelId),
    );

    let learnedEvidence: LearnedOutcomeObservation[] | undefined;
    if (root.learnedEvidence !== undefined) {
      const learnedValues = exactArray(
        root.learnedEvidence,
        INPUT_LIMITS.maxLearnedEvidence,
      );
      if (!learnedValues) return null;
      learnedEvidence = [];
      for (const candidate of learnedValues) {
        const record = exactRecord(candidate, [
          "canonicalModelId",
          "sampleCount",
          "observedSuccessRate",
        ]);
        if (
          !record ||
          !boundedModelId(record.canonicalModelId) ||
          !nonnegativeSafeInteger(record.sampleCount) ||
          record.sampleCount > 1_000_000 ||
          !(
            record.observedSuccessRate === null ||
            (typeof record.observedSuccessRate === "number" &&
              Number.isFinite(record.observedSuccessRate) &&
              record.observedSuccessRate >= 0 &&
              record.observedSuccessRate <= 1)
          )
        ) {
          return null;
        }
        learnedEvidence.push({
          canonicalModelId: record.canonicalModelId,
          sampleCount: record.sampleCount,
          observedSuccessRate: record.observedSuccessRate,
        });
      }
      learnedEvidence.sort(
        (left, right) =>
          compareCanonicalModelIds(
            left.canonicalModelId,
            right.canonicalModelId,
          ) ||
          left.sampleCount - right.sampleCount ||
          (left.observedSuccessRate ?? -1) - (right.observedSuccessRate ?? -1),
      );
    }

    const normalizedRequirements: OutcomeRequirements = {
      asOfDate: requirements.asOfDate,
      priority: requirements.priority as OutcomePriority,
      minimumContextTokens: requirements.minimumContextTokens,
      minimumOutputTokens: requirements.minimumOutputTokens,
      effort: requirements.effort as OutcomeRequirements["effort"],
      ...(estimatesPresent
        ? {
            estimatedInputTokens: requirements.estimatedInputTokens as number,
            estimatedOutputTokens: requirements.estimatedOutputTokens as number,
            estimatedReasoningTokens:
              requirements.estimatedReasoningTokens as number,
          }
        : {}),
      ...(requirements.toolProtocol !== undefined
        ? { toolProtocol: requirements.toolProtocol as ToolProtocol }
        : {}),
      ...(requirements.promptCacheMode !== undefined
        ? { promptCacheMode: requirements.promptCacheMode as PromptCacheMode }
        : {}),
      ...(requirements.conversationState !== undefined
        ? {
            conversationState:
              requirements.conversationState as ConversationStateMode,
          }
        : {}),
      ...(requirements.structuredOutputs !== undefined
        ? { structuredOutputs: requirements.structuredOutputs }
        : {}),
      ...(requirements.imageInput !== undefined
        ? { imageInput: requirements.imageInput }
        : {}),
    };
    return {
      requirements: normalizedRequirements,
      outerEligibility,
      ...(learnedEvidence ? { learnedEvidence } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Controlled-adoption roadmap. Nothing in this contract performs an action.
 * The legacy model-catalog costOf(unknown) => $0 seam stays unresolved here;
 * it may only change after preventive reservations in #261 land and are proven.
 */
export const OUTCOME_ROUTER_ADOPTION_CONTRACT = Object.freeze({
  mode: "planning-only" as const,
  liveDispatchWired: false,
  grantsAuthority: false,
  gates: Object.freeze([
    "provider-adapter-contract-tests",
    "caller-owned-availability-quota-spend-authority-envelope",
    "preventive-spend-reservations-from-pr-261",
    "legacy-unknown-cost-zero-seam-removed-after-pr-261",
    "shadow-route-observation",
    "operator-approved-live-routing-promotion",
  ] as const),
  forbiddenAuthorities: Object.freeze([
    "execute",
    "apply",
    "merge",
    "push",
    "publish",
    "deploy",
  ] as const),
});

function outerCodes(
  envelope: OuterRouteEligibility | undefined,
  duplicate: boolean,
): OutcomeRouteRejectionCode[] {
  if (!envelope) return ["outer-eligibility-missing"];
  if (duplicate) return ["outer-eligibility-duplicate"];
  const codes: OutcomeRouteRejectionCode[] = [];
  const fields = ["availability", "quota", "spend", "authority"] as const;
  for (const field of fields) {
    const value = envelope[field];
    if (value === "eligible") continue;
    const suffix = value === "blocked" ? "blocked" : "unknown";
    codes.push(`outer-${field}-${suffix}` as OutcomeRouteRejectionCode);
  }
  return codes;
}

function factSupportsBoolean(
  fact: CapabilityModelEntry["features"]["structuredOutputs"],
  required: boolean | undefined,
  unknownCode: OutcomeRouteRejectionCode,
  unsupportedCode: OutcomeRouteRejectionCode,
): OutcomeRouteRejectionCode[] {
  if (required !== true) return [];
  if (fact.confidence !== "primary-source-verified") return [unknownCode];
  return fact.value ? [] : [unsupportedCode];
}

function rejectEntry(
  entry: CapabilityModelEntry,
  requirements: OutcomeRequirements,
  envelope: OuterRouteEligibility | undefined,
  duplicateEnvelope: boolean,
): OutcomeRouteRejectionCode[] {
  const codes = outerCodes(envelope, duplicateEnvelope);

  if (entry.availability.confidence !== "primary-source-verified") {
    codes.push("catalog-availability-unknown");
  }
  if (entry.limits.confidence !== "primary-source-verified") {
    codes.push("catalog-limits-unknown");
  } else {
    if (requirements.minimumContextTokens > entry.limits.value.contextTokens) {
      codes.push("context-ceiling");
    }
    if (requirements.minimumOutputTokens > entry.limits.value.maxOutputTokens) {
      codes.push("output-ceiling");
    }
    if (
      requirements.estimatedInputTokens !== undefined &&
      requirements.estimatedInputTokens > entry.limits.value.contextTokens
    ) {
      codes.push("estimated-input-ceiling");
    }
    if (requirements.estimatedOutputTokens !== undefined) {
      const estimatedGeneratedTokens =
        requirements.estimatedOutputTokens +
        (requirements.estimatedReasoningTokens ?? 0);
      const estimatedTotalTokens =
        (requirements.estimatedInputTokens ?? 0) + estimatedGeneratedTokens;
      if (estimatedGeneratedTokens > entry.limits.value.maxOutputTokens) {
        codes.push("estimated-output-ceiling");
      }
      if (estimatedTotalTokens > entry.limits.value.contextTokens) {
        codes.push("estimated-context-ceiling");
      }
    }
  }

  if (requirements.toolProtocol) {
    if (entry.toolProtocol.confidence !== "primary-source-verified") {
      codes.push("tool-protocol-unknown");
    } else if (entry.toolProtocol.value !== requirements.toolProtocol) {
      codes.push("tool-protocol-mismatch");
    }
  }

  if (entry.reasoning.confidence !== "primary-source-verified") {
    codes.push("reasoning-unknown");
  } else if (
    requirements.effort !== "provider-default" &&
    !entry.reasoning.value.efforts.includes(requirements.effort)
  ) {
    codes.push("reasoning-effort-unsupported");
  }

  if (requirements.promptCacheMode) {
    if (entry.promptCache.confidence !== "primary-source-verified") {
      codes.push("cache-support-unknown");
    } else if (
      !entry.promptCache.value.modes.includes(requirements.promptCacheMode)
    ) {
      codes.push("cache-mode-unsupported");
    }
    if (
      entry.pricing.confidence !== "primary-source-verified" ||
      entry.pricing.value.cachedInput.confidence !==
        "primary-source-verified" ||
      entry.pricing.value.cacheWrite5m.confidence !== "primary-source-verified"
    ) {
      codes.push("pricing-unknown");
    }
  }

  if (requirements.conversationState) {
    if (entry.conversationState.confidence !== "primary-source-verified") {
      codes.push("state-support-unknown");
    } else if (
      !entry.conversationState.value.modes.includes(
        requirements.conversationState,
      )
    ) {
      codes.push("state-mode-unsupported");
    }
  }

  codes.push(
    ...factSupportsBoolean(
      entry.features.structuredOutputs,
      requirements.structuredOutputs,
      "structured-output-unknown",
      "structured-output-unsupported",
    ),
  );
  codes.push(
    ...factSupportsBoolean(
      entry.features.imageInput,
      requirements.imageInput,
      "image-input-unknown",
      "image-input-unsupported",
    ),
  );

  if (entry.pricing.confidence !== "primary-source-verified") {
    codes.push("pricing-unknown");
  } else if (
    entry.pricing.value.validThrough &&
    requirements.asOfDate > entry.pricing.value.validThrough
  ) {
    codes.push("pricing-expired");
  }
  if (
    requirements.priority !== "quality-first" &&
    (requirements.estimatedInputTokens === undefined ||
      requirements.estimatedOutputTokens === undefined ||
      requirements.estimatedReasoningTokens === undefined)
  ) {
    codes.push("long-context-tier-indeterminate");
  }
  return codes;
}

function policyScore(
  entry: CapabilityModelEntry,
  workloadCost: number,
  priority: OutcomePriority,
  minimumCost: number,
): number {
  const quality = entry.positioning.qualityBand / 4;
  if (priority === "quality-first") return quality;
  const cost = minimumCost / workloadCost;
  const raw =
    priority === "cost-first"
      ? 0.1 * quality + 0.9 * cost
      : 0.6 * quality + 0.4 * cost;
  return Math.round(raw * 1_000_000) / 1_000_000;
}

function workloadCost(
  entry: CapabilityModelEntry,
  requirements: OutcomeRequirements,
): number {
  if (entry.pricing.confidence !== "primary-source-verified")
    return Number.POSITIVE_INFINITY;
  const price = entry.pricing.value;
  const estimatedInput = requirements.estimatedInputTokens;
  const estimatedOutput = requirements.estimatedOutputTokens;
  const estimatedReasoning = requirements.estimatedReasoningTokens;
  if (
    estimatedInput === undefined ||
    estimatedOutput === undefined ||
    estimatedReasoning === undefined
  ) {
    return price.input + price.output;
  }

  let inputRate = price.input;
  let outputRate = price.output;
  if (
    entry.provider === "openai" &&
    price.longContextSurcharge.confidence === "primary-source-verified" &&
    estimatedInput > price.longContextSurcharge.value.inputThresholdTokens
  ) {
    inputRate *= price.longContextSurcharge.value.inputMultiplier;
    outputRate *= price.longContextSurcharge.value.outputMultiplier;
  }
  return (
    (estimatedInput * inputRate +
      (estimatedOutput + estimatedReasoning) * outputRate) /
    1_000_000
  );
}

export function compareCanonicalModelIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isStrictCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function routeMetadata(input: OutcomeRouteInput): RouteMetadata {
  return {
    catalogVersion: CAPABILITY_CATALOG_VERSION,
    catalogEpoch: CAPABILITY_CATALOG_EPOCH,
    policyVersion: OUTCOME_ROUTER_POLICY_VERSION,
    effort: input.requirements.effort,
    learnedEvidence: {
      mode: "observation-only",
      observationCount: input.learnedEvidence?.length ?? 0,
      appliedToSelection: false,
    },
  };
}

function finalizeDecision(
  decision: OutcomeRouteDecisionCore,
  input: OutcomeRouteInput | null,
): OutcomeRouteDecision {
  const priority = input?.requirements.priority ?? "invalid-input";
  const costBasis =
    priority === "invalid-input"
      ? "invalid-input"
      : priority === "quality-first"
        ? "excluded-quality-first"
        : "estimated-workload";
  const inputDigest = digestCanonical(
    "ashlr.outcome-router.input.v1",
    input ?? { invalidInput: true },
  );
  const basis: OutcomeRouteReceipt["basis"] = {
    catalogEpoch: CAPABILITY_CATALOG_EPOCH,
    policyVersion: OUTCOME_ROUTER_POLICY_VERSION,
    priority,
    costBasis,
    learnedEvidence: "observation-only",
  };
  const decisionDigest = digestCanonical("ashlr.outcome-router.decision.v1", {
    basis,
    catalogDigest: CAPABILITY_CATALOG_DIGEST,
    decision,
    inputDigest,
  });
  return {
    ...decision,
    receipt: {
      schemaVersion: "outcome-route-receipt-v1",
      catalogDigest: CAPABILITY_CATALOG_DIGEST,
      inputDigest,
      decisionDigest,
      basis,
    },
  } as OutcomeRouteDecision;
}

function invalidInputDecision(): OutcomeRouteDecision {
  const core: OutcomeRouteDecisionCore = {
    catalogVersion: CAPABILITY_CATALOG_VERSION,
    catalogEpoch: CAPABILITY_CATALOG_EPOCH,
    policyVersion: OUTCOME_ROUTER_POLICY_VERSION,
    effort: "provider-default",
    learnedEvidence: {
      mode: "observation-only",
      observationCount: 0,
      appliedToSelection: false,
    },
    status: "no-route",
    model: null,
    providerModelId: null,
    policyScore: 0,
    selectionPropensity: 0,
    reason:
      "Input envelope failed exact bounded validation; routing failed closed.",
    rejected: CAPABILITY_MODELS.map((entry) => ({
      canonicalModelId: entry.canonicalId,
      codes: ["invalid-input"],
    })),
  };
  return finalizeDecision(core, null);
}

/**
 * Project a route from verified facts plus explicit outer eligibility.
 * Unknowns reject candidates. Learned evidence is never read by the scorer.
 */
export function routeOutcome(input: OutcomeRouteInput): OutcomeRouteDecision {
  const normalizedInput = parseOutcomeRouteInput(input as unknown);
  if (
    !normalizedInput ||
    !isStrictCalendarDate(normalizedInput.requirements.asOfDate)
  ) {
    return invalidInputDecision();
  }
  const metadata = routeMetadata(normalizedInput);
  const eligibility = new Map<string, OuterRouteEligibility>();
  const duplicateEligibility = new Set<string>();
  for (const entry of normalizedInput.outerEligibility) {
    if (eligibility.has(entry.canonicalModelId))
      duplicateEligibility.add(entry.canonicalModelId);
    else eligibility.set(entry.canonicalModelId, entry);
  }
  const rejected: OutcomeRouteRejection[] = [];
  const feasible: Array<{ entry: CapabilityModelEntry; workloadCost: number }> =
    [];

  for (const entry of CAPABILITY_MODELS) {
    const codes = rejectEntry(
      entry,
      normalizedInput.requirements,
      eligibility.get(entry.canonicalId),
      duplicateEligibility.has(entry.canonicalId),
    );
    if (codes.length > 0) {
      rejected.push({ canonicalModelId: entry.canonicalId, codes });
      continue;
    }
    // rejectEntry proves pricing is verified.
    feasible.push({
      entry,
      workloadCost: workloadCost(entry, normalizedInput.requirements),
    });
  }

  if (feasible.length === 0) {
    return finalizeDecision(
      {
        ...metadata,
        status: "no-route",
        model: null,
        providerModelId: null,
        policyScore: 0,
        selectionPropensity: 0,
        reason:
          "No model satisfied verified catalog facts and all caller-supplied outer constraints.",
        rejected,
      },
      normalizedInput,
    );
  }

  const minimumCost = Math.min(
    ...feasible.map((candidate) => candidate.workloadCost),
  );
  const ranked: RankedCandidate[] = feasible.map(
    ({ entry, workloadCost: estimatedCost }) => ({
      entry,
      workloadCost: estimatedCost,
      policyScore: policyScore(
        entry,
        estimatedCost,
        normalizedInput.requirements.priority,
        minimumCost,
      ),
    }),
  );
  ranked.sort(
    (a, b) =>
      b.policyScore - a.policyScore ||
      (normalizedInput.requirements.priority === "quality-first"
        ? 0
        : a.workloadCost - b.workloadCost) ||
      compareCanonicalModelIds(a.entry.canonicalId, b.entry.canonicalId),
  );
  const selected = ranked[0];
  if (!selected) {
    return finalizeDecision(
      {
        ...metadata,
        status: "no-route",
        model: null,
        providerModelId: null,
        policyScore: 0,
        selectionPropensity: 0,
        reason: "No ranked candidate remained after fail-closed filtering.",
        rejected,
      },
      normalizedInput,
    );
  }

  return finalizeDecision(
    {
      ...metadata,
      status: "selected",
      model: selected.entry.canonicalId,
      providerModelId: selected.entry.providerModelId,
      policyScore: selected.policyScore,
      selectionPropensity: 1,
      reason:
        normalizedInput.requirements.priority === "quality-first"
          ? "quality-first policy selected by positioning inference and ordinal id; cost was excluded and learned evidence was observation-only."
          : `${normalizedInput.requirements.priority} policy selected a verified-feasible model using estimated workload cost; ` +
            "quality band is an Ashlr provider-positioning inference and learned evidence was observation-only.",
      rejected,
    },
    normalizedInput,
  );
}
