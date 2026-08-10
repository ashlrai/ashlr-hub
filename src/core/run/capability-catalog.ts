import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

/**
 * capability-catalog.ts — source-stamped provider capability facts.
 *
 * This is an additive, PURE planning surface. It is deliberately not wired to
 * model-catalog.ts, router.ts, provider clients, dispatch, spend, or authority.
 * Provider facts and Ashlr policy inferences use different types so a ranking
 * can never masquerade as a provider guarantee.
 */

export const CAPABILITY_CATALOG_VERSION = "capability-catalog-v1" as const;
export const CAPABILITY_CATALOG_EPOCH = "2026-08-10" as const;

export type CapabilityProvider = "openai" | "anthropic";
export type FactConfidence = "primary-source-verified" | "unknown";
export type ModelAvailability = "generally-available";
export type ToolProtocol =
  "openai-responses-tools-v1" | "anthropic-messages-tools-v1";
export type PromptCacheMode = "implicit" | "explicit-breakpoint";
export type ConversationStateMode =
  "server-continuation" | "client-replay-stateless";
export type ReasoningEffort =
  "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningMode = "standard" | "pro" | "adaptive" | "extended";

export interface SourceStamp {
  /** Primary provider documentation only. */
  readonly url: string;
  /** Date from which this catalog snapshot treats the cited fact as effective. */
  readonly effectiveDate: string;
  /** Date Ashlr last checked the source. */
  readonly verifiedAt: string;
}

export type CatalogFact<T> =
  | {
      readonly confidence: "primary-source-verified";
      readonly value: T;
      readonly source: SourceStamp;
    }
  | {
      readonly confidence: "unknown";
      readonly value: null;
      readonly source: null;
    };

export interface ModelPricing {
  readonly currency: "USD";
  readonly unit: "million-tokens";
  readonly input: number;
  readonly output: number;
  readonly cachedInput: CatalogFact<number>;
  readonly cacheWrite5m: CatalogFact<number>;
  readonly longContextSurcharge: CatalogFact<{
    readonly inputThresholdTokens: number;
    readonly inputMultiplier: number;
    readonly outputMultiplier: number;
  }>;
  /** Inclusive last date for a temporary price. Absent means no cited expiry. */
  readonly validThrough?: string;
}

export interface ModelLimits {
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
}

export interface ReasoningSupport {
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort | null;
  readonly modes: readonly ReasoningMode[];
}

export interface CacheSupport {
  readonly modes: readonly PromptCacheMode[];
}

export interface ConversationStateSupport {
  readonly modes: readonly ConversationStateMode[];
}

export interface ModelFeatureFacts {
  readonly structuredOutputs: CatalogFact<boolean>;
  readonly imageInput: CatalogFact<boolean>;
}

export interface CompatibilityIdentity {
  readonly id: string;
  readonly kind: "provider-alias" | "legacy-compatibility";
  /** Only current provider aliases may be sent to a provider. */
  readonly dispatchable: boolean;
}

/**
 * Ashlr's interpretation of provider positioning. This is explicitly an
 * inference, not a measured outcome and not a provider capability guarantee.
 */
export interface PolicyPositioningInference {
  readonly basis: "provider-positioning-inference";
  readonly qualityBand: 1 | 2 | 3 | 4;
  readonly summary: string;
  readonly source: SourceStamp;
}

export interface CapabilityModelEntry {
  /** Stable Ashlr identity; never sent to a provider. */
  readonly canonicalId: `${CapabilityProvider}:${string}`;
  readonly provider: CapabilityProvider;
  /** Current provider API id. */
  readonly providerModelId: string;
  readonly identities: readonly CompatibilityIdentity[];
  readonly availability: CatalogFact<ModelAvailability>;
  readonly limits: CatalogFact<ModelLimits>;
  readonly toolProtocol: CatalogFact<ToolProtocol>;
  readonly reasoning: CatalogFact<ReasoningSupport>;
  readonly promptCache: CatalogFact<CacheSupport>;
  readonly conversationState: CatalogFact<ConversationStateSupport>;
  readonly features: ModelFeatureFacts;
  readonly pricing: CatalogFact<ModelPricing>;
  readonly positioning: PolicyPositioningInference;
}

const OPENAI_MODELS_SOURCE: SourceStamp = {
  url: "https://developers.openai.com/api/docs/models",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const OPENAI_GUIDANCE_SOURCE: SourceStamp = {
  url: "https://developers.openai.com/api/docs/guides/latest-model",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const OPENAI_STATE_SOURCE: SourceStamp = {
  url: "https://developers.openai.com/api/docs/guides/conversation-state",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_MODELS_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/about-claude/models/overview",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_EFFORT_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/build-with-claude/effort",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_CACHE_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_TOOL_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_STRUCTURED_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs#compatibility",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

const ANTHROPIC_STATE_SOURCE: SourceStamp = {
  url: "https://platform.claude.com/docs/en/build-with-claude/working-with-messages",
  effectiveDate: CAPABILITY_CATALOG_EPOCH,
  verifiedAt: CAPABILITY_CATALOG_EPOCH,
};

function fact<T>(value: T, source: SourceStamp): CatalogFact<T> {
  return { confidence: "primary-source-verified", value, source };
}

function unknown<T>(): CatalogFact<T> {
  return { confidence: "unknown", value: null, source: null };
}

function pricing(
  input: number,
  output: number,
  cachedInput: CatalogFact<number>,
  cacheWrite5m: CatalogFact<number>,
  source: SourceStamp,
  validThrough?: string,
  longContextSurcharge: ModelPricing["longContextSurcharge"] = unknown(),
): CatalogFact<ModelPricing> {
  return fact(
    {
      currency: "USD",
      unit: "million-tokens",
      input,
      output,
      cachedInput,
      cacheWrite5m,
      longContextSurcharge,
      ...(validThrough ? { validThrough } : {}),
    },
    source,
  );
}

const OPENAI_REASONING = fact<ReasoningSupport>(
  {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    modes: ["standard", "pro"],
  },
  OPENAI_GUIDANCE_SOURCE,
);

const ANTHROPIC5_REASONING = fact<ReasoningSupport>(
  {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    modes: ["adaptive"],
  },
  ANTHROPIC_EFFORT_SOURCE,
);

const OPENAI_CACHE = fact<CacheSupport>(
  { modes: ["implicit", "explicit-breakpoint"] },
  OPENAI_GUIDANCE_SOURCE,
);
const ANTHROPIC_CACHE = fact<CacheSupport>(
  { modes: ["implicit", "explicit-breakpoint"] },
  ANTHROPIC_CACHE_SOURCE,
);

const OPENAI_TOOL = fact<ToolProtocol>(
  "openai-responses-tools-v1",
  OPENAI_MODELS_SOURCE,
);
const ANTHROPIC_TOOL = fact<ToolProtocol>(
  "anthropic-messages-tools-v1",
  ANTHROPIC_TOOL_SOURCE,
);
const OPENAI_STATE = fact<ConversationStateSupport>(
  { modes: ["client-replay-stateless", "server-continuation"] },
  OPENAI_STATE_SOURCE,
);
const ANTHROPIC_STATE = fact<ConversationStateSupport>(
  { modes: ["client-replay-stateless"] },
  ANTHROPIC_STATE_SOURCE,
);
const OPENAI_STRUCTURED = fact(true, OPENAI_MODELS_SOURCE);
const ANTHROPIC_STRUCTURED = fact(true, ANTHROPIC_STRUCTURED_SOURCE);
const OPENAI_IMAGE = fact(true, OPENAI_MODELS_SOURCE);
const ANTHROPIC_IMAGE = fact(true, ANTHROPIC_MODELS_SOURCE);

function openaiEntry(input: {
  id: "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number;
  cacheWritePrice: number;
  qualityBand: 2 | 3 | 4;
  summary: string;
  identities?: readonly CompatibilityIdentity[];
}): CapabilityModelEntry {
  return {
    canonicalId: `openai:${input.id}`,
    provider: "openai",
    providerModelId: input.id,
    identities: input.identities ?? [],
    availability: fact("generally-available", OPENAI_MODELS_SOURCE),
    limits: fact(
      { contextTokens: 1_050_000, maxOutputTokens: 128_000 },
      OPENAI_MODELS_SOURCE,
    ),
    toolProtocol: OPENAI_TOOL,
    reasoning: OPENAI_REASONING,
    promptCache: OPENAI_CACHE,
    conversationState: OPENAI_STATE,
    features: {
      structuredOutputs: OPENAI_STRUCTURED,
      imageInput: OPENAI_IMAGE,
    },
    pricing: pricing(
      input.inputPrice,
      input.outputPrice,
      fact(input.cachedInputPrice, OPENAI_MODELS_SOURCE),
      fact(input.cacheWritePrice, OPENAI_GUIDANCE_SOURCE),
      OPENAI_MODELS_SOURCE,
      undefined,
      fact(
        {
          inputThresholdTokens: 272_000,
          inputMultiplier: 2,
          outputMultiplier: 1.5,
        },
        OPENAI_MODELS_SOURCE,
      ),
    ),
    positioning: {
      basis: "provider-positioning-inference",
      qualityBand: input.qualityBand,
      summary: input.summary,
      source: OPENAI_MODELS_SOURCE,
    },
  };
}

function anthropicEntry(input: {
  id:
    | "claude-fable-5"
    | "claude-opus-5"
    | "claude-sonnet-5"
    | "claude-haiku-4-5-20251001";
  inputPrice: number;
  outputPrice: number;
  cachedInputPrice: number | null;
  cacheWritePrice: number | null;
  contextTokens: number;
  maxOutputTokens: number;
  qualityBand: 1 | 2 | 3 | 4;
  summary: string;
  reasoning: CatalogFact<ReasoningSupport>;
  toolProtocol: CatalogFact<ToolProtocol>;
  promptCache: CatalogFact<CacheSupport>;
  structuredOutputs: CatalogFact<boolean>;
  identities: readonly CompatibilityIdentity[];
  validThrough?: string;
}): CapabilityModelEntry {
  return {
    canonicalId: `anthropic:${input.id}`,
    provider: "anthropic",
    providerModelId: input.id,
    identities: input.identities,
    availability: fact("generally-available", ANTHROPIC_MODELS_SOURCE),
    limits: fact(
      {
        contextTokens: input.contextTokens,
        maxOutputTokens: input.maxOutputTokens,
      },
      ANTHROPIC_MODELS_SOURCE,
    ),
    toolProtocol: input.toolProtocol,
    reasoning: input.reasoning,
    promptCache: input.promptCache,
    conversationState: ANTHROPIC_STATE,
    features: {
      structuredOutputs: input.structuredOutputs,
      imageInput: ANTHROPIC_IMAGE,
    },
    pricing: pricing(
      input.inputPrice,
      input.outputPrice,
      input.cachedInputPrice === null
        ? unknown<number>()
        : fact(input.cachedInputPrice, ANTHROPIC_CACHE_SOURCE),
      input.cacheWritePrice === null
        ? unknown<number>()
        : fact(input.cacheWritePrice, ANTHROPIC_CACHE_SOURCE),
      ANTHROPIC_MODELS_SOURCE,
      input.validThrough,
    ),
    positioning: {
      basis: "provider-positioning-inference",
      qualityBand: input.qualityBand,
      summary: input.summary,
      source: ANTHROPIC_MODELS_SOURCE,
    },
  };
}

const RAW_CAPABILITY_MODELS: readonly CapabilityModelEntry[] = [
  openaiEntry({
    id: "gpt-5.6-sol",
    inputPrice: 5,
    outputPrice: 30,
    cachedInputPrice: 0.5,
    cacheWritePrice: 6.25,
    qualityBand: 4,
    summary: "Flagship tier for complex reasoning and coding.",
    identities: [
      { id: "gpt-5.6", kind: "provider-alias", dispatchable: true },
      {
        id: "codex:gpt-5.6-sol",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
      {
        id: "codex:gpt-5.6",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
  openaiEntry({
    id: "gpt-5.6-terra",
    inputPrice: 2,
    outputPrice: 12,
    cachedInputPrice: 0.2,
    cacheWritePrice: 2.5,
    qualityBand: 3,
    summary: "Balanced intelligence and cost tier.",
    identities: [
      {
        id: "codex:gpt-5.6-terra",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
  openaiEntry({
    id: "gpt-5.6-luna",
    inputPrice: 0.2,
    outputPrice: 1.2,
    cachedInputPrice: 0.02,
    cacheWritePrice: 0.25,
    qualityBand: 2,
    summary: "Cost-sensitive, high-volume tier.",
    identities: [
      {
        id: "codex:gpt-5.6-luna",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
  anthropicEntry({
    id: "claude-fable-5",
    inputPrice: 10,
    outputPrice: 50,
    cachedInputPrice: 1,
    cacheWritePrice: 12.5,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    qualityBand: 4,
    summary: "Highest-capability tier for long-running agents.",
    reasoning: ANTHROPIC5_REASONING,
    // The current tool-use table does not enumerate Fable 5. Unknown is safer
    // than projecting API-wide support onto a model-specific contract.
    toolProtocol: unknown<ToolProtocol>(),
    promptCache: ANTHROPIC_CACHE,
    structuredOutputs: ANTHROPIC_STRUCTURED,
    identities: [
      {
        id: "claude:fable-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
      {
        id: "claude:claude-fable-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
  anthropicEntry({
    id: "claude-opus-5",
    inputPrice: 5,
    outputPrice: 25,
    cachedInputPrice: 0.5,
    cacheWritePrice: 6.25,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    qualityBand: 3,
    summary: "Complex agentic coding and enterprise-work tier.",
    reasoning: ANTHROPIC5_REASONING,
    toolProtocol: ANTHROPIC_TOOL,
    promptCache: ANTHROPIC_CACHE,
    structuredOutputs: ANTHROPIC_STRUCTURED,
    identities: [
      {
        id: "claude:opus-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
      {
        id: "claude:claude-opus-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
  anthropicEntry({
    id: "claude-sonnet-5",
    inputPrice: 2,
    outputPrice: 10,
    cachedInputPrice: 0.2,
    cacheWritePrice: 2.5,
    contextTokens: 1_000_000,
    maxOutputTokens: 128_000,
    qualityBand: 2,
    summary: "Speed-and-intelligence tier for scaled agentic work.",
    reasoning: ANTHROPIC5_REASONING,
    toolProtocol: ANTHROPIC_TOOL,
    promptCache: ANTHROPIC_CACHE,
    structuredOutputs: ANTHROPIC_STRUCTURED,
    identities: [
      {
        id: "claude:sonnet-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
      {
        id: "claude:claude-sonnet-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
    // Introductory price documented through August 31, 2026. Routing after
    // this date must fail closed until a new catalog epoch records $3/$15.
    validThrough: "2026-08-31",
  }),
  anthropicEntry({
    id: "claude-haiku-4-5-20251001",
    inputPrice: 1,
    outputPrice: 5,
    cachedInputPrice: 0.1,
    cacheWritePrice: 1.25,
    contextTokens: 200_000,
    maxOutputTokens: 64_000,
    qualityBand: 1,
    summary: "Fast, economical near-frontier tier.",
    reasoning: fact(
      { efforts: [], defaultEffort: null, modes: ["extended"] },
      ANTHROPIC_MODELS_SOURCE,
    ),
    toolProtocol: ANTHROPIC_TOOL,
    promptCache: ANTHROPIC_CACHE,
    structuredOutputs: ANTHROPIC_STRUCTURED,
    identities: [
      { id: "claude-haiku-4-5", kind: "provider-alias", dispatchable: true },
      { id: "claude:haiku", kind: "legacy-compatibility", dispatchable: false },
      {
        id: "claude:haiku-4-5",
        kind: "legacy-compatibility",
        dispatchable: false,
      },
    ],
  }),
];

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (nodeUtilTypes.isProxy(value)) throw new Error("catalog-proxy");
    if (!Object.isFrozen(value)) {
      for (const nested of Object.values(value as Record<string, unknown>))
        deepFreeze(nested);
      Object.freeze(value);
    }
  }
  return value;
}

/** Immutable provider-fact snapshot. */
export const CAPABILITY_MODELS: readonly CapabilityModelEntry[] = deepFreeze([
  ...RAW_CAPABILITY_MODELS,
]);

export const CANONICAL_SERIALIZATION_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 4_096,
  maxStringLength: 2_048,
  maxBytes: 262_144,
});

/** Bounded JSON canonicalization with ordinal ASCII object-key ordering. */
export function canonicalSerializeBounded(value: unknown): string {
  let nodes = 0;
  const visit = (current: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > CANONICAL_SERIALIZATION_LIMITS.maxNodes)
      throw new Error("canonical-node-limit");
    if (depth > CANONICAL_SERIALIZATION_LIMITS.maxDepth)
      throw new Error("canonical-depth-limit");
    if (
      ((typeof current === "object" && current !== null) ||
        typeof current === "function") &&
      nodeUtilTypes.isProxy(current)
    ) {
      throw new Error("canonical-proxy");
    }
    if (current === null || typeof current === "boolean")
      return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current))
        throw new Error("canonical-non-finite-number");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current === "string") {
      if (current.length > CANONICAL_SERIALIZATION_LIMITS.maxStringLength) {
        throw new Error("canonical-string-limit");
      }
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0)
        throw new Error("canonical-symbol");
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const items: string[] = [];
      for (const key of Object.keys(descriptors)) {
        if (key === "length") continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) {
          throw new Error("canonical-array-property");
        }
      }
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor))
          throw new Error("canonical-array-accessor");
        items.push(visit(descriptor.value, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    if (typeof current !== "object")
      throw new Error("canonical-unsupported-type");
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("canonical-prototype");
    const descriptors = Object.getOwnPropertyDescriptors(current);
    if (Object.getOwnPropertySymbols(current).length > 0)
      throw new Error("canonical-symbol");
    const keys = Object.keys(descriptors).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const fields = keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor))
        throw new Error("canonical-accessor");
      return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
    });
    return `{${fields.join(",")}}`;
  };
  const serialized = visit(value, 0);
  if (
    Buffer.byteLength(serialized, "utf8") >
    CANONICAL_SERIALIZATION_LIMITS.maxBytes
  ) {
    throw new Error("canonical-byte-limit");
  }
  return serialized;
}

export function digestCanonical(domain: string, value: unknown): string {
  if (!/^[a-z0-9.-]{1,64}$/.test(domain)) throw new Error("canonical-domain");
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(canonicalSerializeBounded(value), "utf8")
    .digest("hex");
}

export const CAPABILITY_CATALOG_DIGEST = digestCanonical(
  "ashlr.capability-catalog.v1",
  {
    epoch: CAPABILITY_CATALOG_EPOCH,
    models: CAPABILITY_MODELS,
    version: CAPABILITY_CATALOG_VERSION,
  },
);

export interface ResolvedCapabilityModel {
  readonly entry: CapabilityModelEntry;
  readonly identityKind:
    "canonical" | "provider-model-id" | CompatibilityIdentity["kind"];
  readonly dispatchable: boolean;
  /** Exact current provider id, present only for dispatchable identities. */
  readonly dispatchModelId: string | null;
}

/**
 * Resolve canonical, current-provider, or compatibility identity without ever
 * converting a legacy name into a dispatchable provider id.
 */
export function resolveCapabilityModelId(
  id: string,
): ResolvedCapabilityModel | null {
  const normalized = id.trim();
  if (!normalized) return null;

  for (const entry of CAPABILITY_MODELS) {
    if (normalized === entry.canonicalId) {
      return {
        entry,
        identityKind: "canonical",
        dispatchable: true,
        dispatchModelId: entry.providerModelId,
      };
    }
    if (normalized === entry.providerModelId) {
      return {
        entry,
        identityKind: "provider-model-id",
        dispatchable: true,
        dispatchModelId: entry.providerModelId,
      };
    }
    const identity = entry.identities.find(
      (candidate) => candidate.id === normalized,
    );
    if (identity) {
      return {
        entry,
        identityKind: identity.kind,
        dispatchable: identity.dispatchable,
        dispatchModelId: identity.dispatchable ? entry.providerModelId : null,
      };
    }
  }
  return null;
}

export type KnownStandardTokenPrice =
  | {
      readonly known: true;
      readonly inputUsdPerMTok: number;
      readonly outputUsdPerMTok: number;
      readonly source: SourceStamp;
      readonly validThrough?: string;
    }
  | {
      readonly known: false;
      readonly reason: "unknown-model" | "unknown-pricing";
    };

/** Unknown models/pricing are explicit failures, never free ($0) fallbacks. */
export function standardTokenPrice(id: string): KnownStandardTokenPrice {
  const resolved = resolveCapabilityModelId(id);
  if (!resolved) return { known: false, reason: "unknown-model" };
  if (resolved.entry.pricing.confidence !== "primary-source-verified") {
    return { known: false, reason: "unknown-pricing" };
  }
  const price = resolved.entry.pricing.value;
  return {
    known: true,
    inputUsdPerMTok: price.input,
    outputUsdPerMTok: price.output,
    source: resolved.entry.pricing.source,
    ...(price.validThrough ? { validThrough: price.validThrough } : {}),
  };
}
