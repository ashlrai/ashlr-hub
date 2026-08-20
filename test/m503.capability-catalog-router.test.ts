import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CATALOG_EPOCH,
  CAPABILITY_CATALOG_DIGEST,
  CAPABILITY_CATALOG_VERSION,
  CAPABILITY_MODELS,
  canonicalSerializeBounded,
  digestCanonical,
  resolveCapabilityModelId,
  standardTokenPrice,
  type CatalogFact,
  type CapabilityModelEntry,
} from "../src/core/run/capability-catalog.js";
import {
  OUTCOME_ROUTER_ADOPTION_CONTRACT,
  OUTCOME_ROUTER_POLICY_VERSION,
  compareCanonicalModelIds,
  routeOutcome,
  type OuterRouteEligibility,
  type OutcomeRouteInput,
} from "../src/core/run/outcome-router.js";

const ELIGIBLE: OuterRouteEligibility["availability"] = "eligible";

function allEligible(): OuterRouteEligibility[] {
  return CAPABILITY_MODELS.map((entry) => ({
    canonicalModelId: entry.canonicalId,
    availability: ELIGIBLE,
    quota: ELIGIBLE,
    spend: ELIGIBLE,
    authority: ELIGIBLE,
  }));
}

function input(
  overrides: Partial<OutcomeRouteInput["requirements"]> = {},
): OutcomeRouteInput {
  const requirements = {
    asOfDate: CAPABILITY_CATALOG_EPOCH,
    priority: "balanced" as const,
    minimumContextTokens: 100_000,
    minimumOutputTokens: 16_000,
    estimatedInputTokens: 100_000,
    estimatedOutputTokens: 10_000,
    estimatedReasoningTokens: 5_000,
    effort: "medium" as const,
    ...overrides,
  };
  for (const key of Object.keys(requirements) as Array<
    keyof typeof requirements
  >) {
    if (requirements[key] === undefined) delete requirements[key];
  }
  return {
    requirements,
    outerEligibility: allEligible(),
  };
}

function sourceFacts(entry: CapabilityModelEntry): Array<CatalogFact<unknown>> {
  return [
    entry.availability,
    entry.limits,
    entry.toolProtocol,
    entry.reasoning,
    entry.promptCache,
    entry.conversationState,
    entry.features.structuredOutputs,
    entry.features.imageInput,
    entry.pricing,
  ];
}

describe("M503 source-stamped capability catalog", () => {
  it("has a stable version/epoch and only primary-doc-verified current provider ids", () => {
    expect(CAPABILITY_CATALOG_VERSION).toBe("capability-catalog-v1");
    expect(CAPABILITY_CATALOG_EPOCH).toBe("2026-08-10");
    expect(CAPABILITY_CATALOG_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(CAPABILITY_MODELS.map((entry) => entry.providerModelId)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(
      new Set(CAPABILITY_MODELS.map((entry) => entry.canonicalId)).size,
    ).toBe(CAPABILITY_MODELS.length);
    const everyIdentity = CAPABILITY_MODELS.flatMap((entry) => [
      entry.canonicalId,
      entry.providerModelId,
      ...entry.identities.map((identity) => identity.id),
    ]);
    expect(new Set(everyIdentity).size).toBe(everyIdentity.length);
  });

  it("source-stamps every known fact and keeps unknown facts explicitly null", () => {
    for (const entry of CAPABILITY_MODELS) {
      for (const fact of sourceFacts(entry)) {
        if (fact.confidence === "primary-source-verified") {
          expect(fact.value).not.toBeNull();
          expect(fact.source.url).toMatch(
            /^https:\/\/(developers\.openai\.com|platform\.claude\.com)\//,
          );
          expect(fact.source.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          expect(fact.source.verifiedAt).toBe(CAPABILITY_CATALOG_EPOCH);
        } else {
          expect(fact.value).toBeNull();
          expect(fact.source).toBeNull();
        }
      }
      if (entry.pricing.confidence === "primary-source-verified") {
        for (const nested of [
          entry.pricing.value.cachedInput,
          entry.pricing.value.cacheWrite5m,
          entry.pricing.value.longContextSurcharge,
        ]) {
          if (nested.confidence === "primary-source-verified") {
            expect(nested.source.url).toMatch(
              /^https:\/\/(developers\.openai\.com|platform\.claude\.com)\//,
            );
            expect(nested.source.verifiedAt).toBe(CAPABILITY_CATALOG_EPOCH);
          } else {
            expect(nested.value).toBeNull();
            expect(nested.source).toBeNull();
          }
        }
      }
      expect(entry.positioning.basis).toBe("provider-positioning-inference");
      expect(entry.positioning.source.url).toMatch(/^https:\/\//);
    }
  });

  it("records ceilings, protocols, reasoning, cache/state, availability and positive pricing", () => {
    for (const entry of CAPABILITY_MODELS) {
      expect(entry.availability.value).toBe("generally-available");
      expect(entry.limits.value?.contextTokens).toBeGreaterThan(0);
      expect(entry.limits.value?.maxOutputTokens).toBeGreaterThan(0);
      expect(entry.conversationState.value?.modes.length).toBeGreaterThan(0);
      expect(entry.pricing.value?.input).toBeGreaterThan(0);
      expect(entry.pricing.value?.output).toBeGreaterThan(0);
    }
    expect(
      resolveCapabilityModelId("gpt-5.6-sol")?.entry.toolProtocol.value,
    ).toBe("openai-responses-tools-v1");
    expect(
      resolveCapabilityModelId("claude-sonnet-5")?.entry.reasoning.value
        ?.efforts,
    ).toContain("max");
    expect(
      resolveCapabilityModelId("gpt-5.6-sol")?.entry.conversationState.value
        ?.modes,
    ).toEqual(["client-replay-stateless", "server-continuation"]);
    expect(
      resolveCapabilityModelId("claude-opus-5")?.entry.toolProtocol.value,
    ).toBe("anthropic-messages-tools-v1");
    expect(
      resolveCapabilityModelId("claude-opus-5")?.entry.promptCache.value?.modes,
    ).toContain("explicit-breakpoint");
    expect(
      resolveCapabilityModelId("claude-opus-5")?.entry.features
        .structuredOutputs.confidence,
    ).toBe("primary-source-verified");
    expect(
      resolveCapabilityModelId("claude-opus-5")?.entry.features
        .structuredOutputs,
    ).toMatchObject({
      value: true,
      source: {
        url: "https://platform.claude.com/docs/en/build-with-claude/structured-outputs#compatibility",
      },
    });
  });

  it("resolves exact legacy identities without making them dispatchable", () => {
    const legacyClaude = resolveCapabilityModelId("claude:sonnet-5");
    expect(legacyClaude?.entry.canonicalId).toBe("anthropic:claude-sonnet-5");
    expect(legacyClaude?.identityKind).toBe("legacy-compatibility");
    expect(legacyClaude?.dispatchable).toBe(false);
    expect(legacyClaude?.dispatchModelId).toBeNull();

    const currentAlias = resolveCapabilityModelId("gpt-5.6");
    expect(currentAlias?.entry.canonicalId).toBe("openai:gpt-5.6-sol");
    expect(currentAlias?.identityKind).toBe("provider-alias");
    expect(currentAlias?.dispatchModelId).toBe("gpt-5.6-sol");

    // A previous model is not an alias for a newer model.
    expect(resolveCapabilityModelId("codex:gpt-5.5")).toBeNull();
  });

  it("fails unknown cost closed instead of inventing $0", () => {
    expect(standardTokenPrice("not-a-model")).toEqual({
      known: false,
      reason: "unknown-model",
    });
    expect(standardTokenPrice("openai:gpt-5.6-luna")).toMatchObject({
      known: true,
      inputUsdPerMTok: 0.2,
      outputUsdPerMTok: 1.2,
    });
    expect(standardTokenPrice("openai:gpt-5.6-terra")).toMatchObject({
      known: true,
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 12,
    });
    expect(
      resolveCapabilityModelId("gpt-5.6-terra")?.entry.pricing.value,
    ).toMatchObject({
      cachedInput: { value: 0.2 },
      cacheWrite5m: { value: 2.5 },
    });
    expect(
      resolveCapabilityModelId("gpt-5.6-luna")?.entry.pricing.value,
    ).toMatchObject({
      cachedInput: { value: 0.02 },
      cacheWrite5m: { value: 0.25 },
    });
    expect(
      resolveCapabilityModelId("claude-opus-5")?.entry.pricing.value,
    ).toMatchObject({
      cachedInput: { value: 0.5 },
      cacheWrite5m: { value: 6.25 },
    });
  });

  it("freezes the public catalog deeply", () => {
    expect(Object.isFrozen(CAPABILITY_MODELS)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_MODELS[0])).toBe(true);
    expect(Object.isFrozen(CAPABILITY_MODELS[0]?.pricing)).toBe(true);
  });
});

describe("M503 pure outcome routing policy", () => {
  it("carries epoch, policy, model, effort, policy score, selection propensity and reason", () => {
    const result = routeOutcome(
      input({ priority: "quality-first", effort: "max" }),
    );
    expect(result).toMatchObject({
      status: "selected",
      catalogVersion: CAPABILITY_CATALOG_VERSION,
      catalogEpoch: CAPABILITY_CATALOG_EPOCH,
      policyVersion: OUTCOME_ROUTER_POLICY_VERSION,
      effort: "max",
    });
    expect(result.model).toMatch(/^(openai|anthropic):/);
    expect(result.policyScore).toBeGreaterThan(0);
    expect(result.policyScore).toBeLessThanOrEqual(1);
    expect(result.selectionPropensity).toBe(1);
    expect(result.reason).toContain("inference");
    expect(result.reason).toContain("observation-only");
  });

  it("requires caller-owned availability, quota, spend, and authority eligibility", () => {
    const fields = ["availability", "quota", "spend", "authority"] as const;
    for (const field of fields) {
      const outerEligibility = allEligible().map((entry) =>
        entry.canonicalModelId === "openai:gpt-5.6-luna"
          ? { ...entry, [field]: "unknown" as const }
          : { ...entry, [field]: "blocked" as const },
      );
      const result = routeOutcome({
        ...input({ priority: "cost-first" }),
        outerEligibility,
      });
      expect(result.status).toBe("no-route");
      expect(result.rejected.flatMap((entry) => entry.codes)).toContain(
        `outer-${field}-unknown`,
      );
    }

    const missing = routeOutcome({ ...input(), outerEligibility: [] });
    expect(missing.status).toBe("no-route");
    expect(
      missing.rejected.every((entry) =>
        entry.codes.includes("outer-eligibility-missing"),
      ),
    ).toBe(true);

    const duplicate = routeOutcome({
      ...input(),
      outerEligibility: [...allEligible(), allEligible()[0]!],
    });
    expect(
      duplicate.rejected.find(
        (entry) =>
          entry.canonicalModelId === allEligible()[0]!.canonicalModelId,
      )?.codes,
    ).toContain("outer-eligibility-duplicate");
  });

  it("fails unknown or mismatched capability facts closed", () => {
    const anthropicOnly = allEligible().map((entry) => ({
      ...entry,
      availability: entry.canonicalModelId.startsWith("anthropic:")
        ? ELIGIBLE
        : ("blocked" as const),
    }));
    const result = routeOutcome({
      ...input({
        priority: "quality-first",
        toolProtocol: "anthropic-messages-tools-v1",
        structuredOutputs: true,
      }),
      outerEligibility: anthropicOnly,
    });
    expect(result.status).toBe("selected");
    expect(result.model).toBe("anthropic:claude-opus-5");
    const fable = result.rejected.find(
      (entry) => entry.canonicalModelId === "anthropic:claude-fable-5",
    );
    const opus = result.rejected.find(
      (entry) => entry.canonicalModelId === "anthropic:claude-opus-5",
    );
    expect(fable?.codes).toContain("tool-protocol-unknown");
    expect(opus).toBeUndefined();
  });

  it("enforces context/output ceilings and temporary pricing expiry", () => {
    const tooLarge = routeOutcome(input({ minimumContextTokens: 2_000_000 }));
    expect(tooLarge.status).toBe("no-route");
    expect(
      tooLarge.rejected.every((entry) =>
        entry.codes.includes("context-ceiling"),
      ),
    ).toBe(true);

    const afterPromo = routeOutcome({
      ...input({
        asOfDate: "2026-09-01",
        toolProtocol: "anthropic-messages-tools-v1",
      }),
      outerEligibility: allEligible().map((entry) => ({
        ...entry,
        availability:
          entry.canonicalModelId === "anthropic:claude-sonnet-5"
            ? ELIGIBLE
            : "blocked",
      })),
    });
    expect(afterPromo.status).toBe("no-route");
    expect(
      afterPromo.rejected.find(
        (entry) => entry.canonicalModelId === "anthropic:claude-sonnet-5",
      )?.codes,
    ).toContain("pricing-expired");
  });

  it("applies OpenAI long-context pricing above 272K and fails indeterminate cost routes closed", () => {
    const terraAndSonnet = allEligible().map((entry) => ({
      ...entry,
      availability: [
        "openai:gpt-5.6-terra",
        "anthropic:claude-sonnet-5",
      ].includes(entry.canonicalModelId)
        ? ELIGIBLE
        : ("blocked" as const),
    }));
    const atThreshold = routeOutcome({
      ...input({
        priority: "balanced",
        effort: "provider-default",
        estimatedInputTokens: 272_000,
        estimatedOutputTokens: 10_000,
      }),
      outerEligibility: terraAndSonnet,
    });
    expect(atThreshold.model).toBe("openai:gpt-5.6-terra");

    const aboveThreshold = routeOutcome({
      ...input({
        priority: "balanced",
        effort: "provider-default",
        estimatedInputTokens: 272_001,
        estimatedOutputTokens: 10_000,
      }),
      outerEligibility: terraAndSonnet,
    });
    expect(aboveThreshold.model).toBe("anthropic:claude-sonnet-5");

    const openaiOnly = allEligible().map((entry) => ({
      ...entry,
      availability: entry.canonicalModelId.startsWith("openai:")
        ? ELIGIBLE
        : ("blocked" as const),
    }));
    const indeterminate = routeOutcome({
      ...input({
        priority: "cost-first",
        estimatedInputTokens: undefined,
        estimatedOutputTokens: undefined,
        estimatedReasoningTokens: undefined,
      }),
      outerEligibility: openaiOnly,
    });
    expect(indeterminate.status).toBe("no-route");
    expect(
      indeterminate.rejected
        .filter((entry) => entry.canonicalModelId.startsWith("openai:"))
        .every((entry) =>
          entry.codes.includes("long-context-tier-indeterminate"),
        ),
    ).toBe(true);

    const globallyIndeterminate = routeOutcome(
      input({
        priority: "balanced",
        estimatedInputTokens: undefined,
        estimatedOutputTokens: undefined,
        estimatedReasoningTokens: undefined,
      }),
    );
    expect(globallyIndeterminate.status).toBe("no-route");
    expect(
      globallyIndeterminate.rejected.every((entry) =>
        entry.codes.includes("long-context-tier-indeterminate"),
      ),
    ).toBe(true);
  });

  it("rejects malformed numeric/strict-calendar-date requirements and unknown capabilities", () => {
    const malformed = routeOutcome(
      input({
        asOfDate: "tomorrow",
        minimumContextTokens: Number.NaN,
      }),
    );
    expect(malformed.status).toBe("no-route");
    expect(
      malformed.rejected.every((entry) =>
        entry.codes.includes("invalid-input"),
      ),
    ).toBe(true);

    for (const asOfDate of ["2026-02-29", "2026-13-01", "2026-04-31"]) {
      const invalidDate = routeOutcome(input({ asOfDate }));
      expect(
        invalidDate.rejected.every((entry) =>
          entry.codes.includes("invalid-input"),
        ),
      ).toBe(true);
    }
    const validLeapDay = routeOutcome(
      input({ asOfDate: "2028-02-29", priority: "quality-first" }),
    );
    expect(validLeapDay.rejected.flatMap((entry) => entry.codes)).not.toContain(
      "invalid-input",
    );

    const opusOnly = routeOutcome({
      ...input({
        promptCacheMode: "explicit-breakpoint",
        effort: "high",
        structuredOutputs: true,
      }),
      outerEligibility: allEligible().map((entry) => ({
        ...entry,
        availability:
          entry.canonicalModelId === "anthropic:claude-opus-5"
            ? ELIGIBLE
            : "blocked",
      })),
    });
    expect(opusOnly.status).toBe("selected");
    expect(opusOnly.model).toBe("anthropic:claude-opus-5");
  });

  it("keeps learned evidence observation-only and selection-inert", () => {
    const base = input({ priority: "cost-first" });
    const withoutEvidence = routeOutcome(base);
    const withEvidence = routeOutcome({
      ...base,
      learnedEvidence: [
        {
          canonicalModelId: "openai:gpt-5.6-sol",
          sampleCount: 10_000,
          observedSuccessRate: 1,
        },
        {
          canonicalModelId: "openai:gpt-5.6-luna",
          sampleCount: 10_000,
          observedSuccessRate: 0,
        },
      ],
    });
    expect(withEvidence.model).toBe(withoutEvidence.model);
    expect(withEvidence.policyScore).toBe(withoutEvidence.policyScore);
    expect(withEvidence.selectionPropensity).toBe(
      withoutEvidence.selectionPropensity,
    );
    expect(withEvidence.learnedEvidence).toEqual({
      mode: "observation-only",
      observationCount: 2,
      appliedToSelection: false,
    });
  });

  it("rejects every malformed runtime field and bounded-collection violation as invalid-input", () => {
    const expectInvalid = (value: unknown): void => {
      const result = routeOutcome(value as OutcomeRouteInput);
      expect(result.status).toBe("no-route");
      expect(
        result.rejected.every((entry) => entry.codes.includes("invalid-input")),
      ).toBe(true);
      expect(result.receipt.basis).toMatchObject({
        priority: "invalid-input",
        costBasis: "invalid-input",
      });
    };

    expectInvalid({
      ...input(),
      requirements: { ...input().requirements, priority: "bogus" },
    });
    expectInvalid({
      ...input(),
      requirements: { ...input().requirements, structuredOutputs: "true" },
    });
    expectInvalid({
      ...input(),
      requirements: { ...input().requirements, imageInput: 1 },
    });
    expectInvalid({ ...input(), extra: true });
    expectInvalid({ ...input(), outerEligibility: "all" });
    expectInvalid({
      ...input(),
      outerEligibility: Array.from({ length: 65 }, () => allEligible()[0]),
    });
    expectInvalid({
      ...input(),
      outerEligibility: [
        { ...allEligible()[0], canonicalModelId: "x".repeat(161) },
      ],
    });
    expectInvalid({
      ...input(),
      outerEligibility: [{ ...allEligible()[0], quota: "maybe" }],
    });
    expectInvalid({
      ...input(),
      learnedEvidence: Array.from({ length: 129 }, () => ({
        canonicalModelId: "openai:gpt-5.6-sol",
        sampleCount: 1,
        observedSuccessRate: 1,
      })),
    });
    expectInvalid({
      ...input(),
      learnedEvidence: [
        {
          canonicalModelId: "openai:gpt-5.6-sol",
          sampleCount: 1_000_001,
          observedSuccessRate: 2,
        },
      ],
    });

    let getterCalled = false;
    const accessorRequirements = Object.defineProperty({}, "priority", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return "balanced";
      },
    });
    expectInvalid({ ...input(), requirements: accessorRequirements });
    expect(getterCalled).toBe(false);

    const symbolInput = input() as OutcomeRouteInput & {
      [key: symbol]: boolean;
    };
    symbolInput[Symbol("private")] = true;
    expectInvalid(symbolInput);
    expectInvalid(Object.assign(Object.create({ inherited: true }), input()));
  });

  it("enforces combined input + visible output + reasoning against context and output ceilings", () => {
    const contextOverflow = routeOutcome(
      input({
        estimatedInputTokens: 1_000_000,
        estimatedOutputTokens: 50_000,
        estimatedReasoningTokens: 1,
      }),
    );
    expect(contextOverflow.status).toBe("no-route");
    expect(
      contextOverflow.rejected.every((entry) =>
        entry.codes.includes("estimated-context-ceiling"),
      ),
    ).toBe(true);

    const generatedOverflow = routeOutcome(
      input({
        estimatedInputTokens: 10_000,
        estimatedOutputTokens: 70_000,
        estimatedReasoningTokens: 60_000,
      }),
    );
    expect(generatedOverflow.status).toBe("no-route");
    expect(
      generatedOverflow.rejected.every((entry) =>
        entry.codes.includes("estimated-output-ceiling"),
      ),
    ).toBe(true);
  });

  it("makes quality-first cost-independent when estimates are absent", () => {
    const noEstimates = input({
      priority: "quality-first",
      effort: "provider-default",
      estimatedInputTokens: undefined,
      estimatedOutputTokens: undefined,
      estimatedReasoningTokens: undefined,
    });
    const result = routeOutcome(noEstimates);
    expect(result.status).toBe("selected");
    expect(result.model).toBe("anthropic:claude-fable-5");
    expect(result.reason).toContain("cost was excluded");
    expect(result.receipt.basis.costBasis).toBe("excluded-quality-first");

    const withEstimates = routeOutcome(
      input({
        priority: "quality-first",
        effort: "provider-default",
        estimatedInputTokens: 200_000,
        estimatedOutputTokens: 20_000,
        estimatedReasoningTokens: 20_000,
      }),
    );
    expect(withEstimates.model).toBe(result.model);
    expect(withEstimates.policyScore).toBe(result.policyScore);
  });

  it("emits domain-separated, replay-stable catalog/input/decision receipts", () => {
    const first = routeOutcome({
      ...input(),
      learnedEvidence: [
        {
          canonicalModelId: "openai:gpt-5.6-sol",
          sampleCount: 2,
          observedSuccessRate: 0.5,
        },
        {
          canonicalModelId: "openai:gpt-5.6-luna",
          sampleCount: 1,
          observedSuccessRate: null,
        },
      ],
    });
    const reordered = routeOutcome({
      ...input(),
      outerEligibility: allEligible().reverse(),
      learnedEvidence: [
        {
          canonicalModelId: "openai:gpt-5.6-luna",
          sampleCount: 1,
          observedSuccessRate: null,
        },
        {
          canonicalModelId: "openai:gpt-5.6-sol",
          sampleCount: 2,
          observedSuccessRate: 0.5,
        },
      ],
    });
    expect(first.receipt).toMatchObject({
      schemaVersion: "outcome-route-receipt-v1",
      catalogDigest: CAPABILITY_CATALOG_DIGEST,
      basis: {
        catalogEpoch: CAPABILITY_CATALOG_EPOCH,
        policyVersion: OUTCOME_ROUTER_POLICY_VERSION,
        costBasis: "estimated-workload",
        learnedEvidence: "observation-only",
      },
    });
    expect(first.receipt.inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.decisionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered.receipt.inputDigest).toBe(first.receipt.inputDigest);
    expect(reordered.receipt.decisionDigest).toBe(first.receipt.decisionDigest);

    const changed = routeOutcome(input({ estimatedReasoningTokens: 5_001 }));
    expect(changed.receipt.inputDigest).not.toBe(first.receipt.inputDigest);
    expect(changed.receipt.decisionDigest).not.toBe(
      first.receipt.decisionDigest,
    );
    expect(digestCanonical("ashlr.domain-a.v1", { same: true })).not.toBe(
      digestCanonical("ashlr.domain-b.v1", { same: true }),
    );
  });

  it("bounds canonical serialization and rejects accessors, symbols, cycles, and excess depth", () => {
    expect(canonicalSerializeBounded({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(() =>
      canonicalSerializeBounded({ text: "x".repeat(2_049) }),
    ).toThrow("canonical-string-limit");
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "no",
    });
    expect(() => canonicalSerializeBounded(accessor)).toThrow(
      "canonical-accessor",
    );
    expect(() => canonicalSerializeBounded({ [Symbol("x")]: true })).toThrow(
      "canonical-symbol",
    );
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => canonicalSerializeBounded(cycle)).toThrow(
      "canonical-depth-limit",
    );
    let nested: unknown = null;
    for (let depth = 0; depth < 14; depth += 1) nested = { nested };
    expect(() => canonicalSerializeBounded(nested)).toThrow(
      "canonical-depth-limit",
    );
  });

  it("rejects root, nested, array, and revoked proxies without invoking traps or exposing details", () => {
    const trapped = <T extends object>(target: T) => {
      let trapCount = 0;
      const handler: ProxyHandler<T> = {
        get() {
          trapCount += 1;
          throw new Error("proxy-get-trap");
        },
        getOwnPropertyDescriptor() {
          trapCount += 1;
          throw new Error("proxy-descriptor-trap");
        },
        getPrototypeOf() {
          trapCount += 1;
          throw new Error("proxy-prototype-trap");
        },
        ownKeys() {
          trapCount += 1;
          throw new Error("proxy-own-keys-trap");
        },
      };
      return {
        proxy: new Proxy(target, handler),
        trapCount: () => trapCount,
        handler,
      };
    };

    const root = trapped(input());
    const nested = trapped(input().requirements);
    const array = trapped(allEligible());
    const revoked = trapped(input());
    const revocable = Proxy.revocable(input(), revoked.handler);
    revocable.revoke();

    const invalidBaseline = routeOutcome({} as OutcomeRouteInput);
    const outcomes = [
      routeOutcome(root.proxy),
      routeOutcome({ ...input(), requirements: nested.proxy }),
      routeOutcome({ ...input(), outerEligibility: array.proxy }),
      routeOutcome(revocable.proxy),
    ];
    for (const outcome of outcomes) {
      expect(outcome).toEqual(invalidBaseline);
      expect(outcome).toMatchObject({
        status: "no-route",
        reason:
          "Input envelope failed exact bounded validation; routing failed closed.",
        receipt: {
          basis: { priority: "invalid-input", costBasis: "invalid-input" },
        },
      });
    }
    expect([
      root.trapCount(),
      nested.trapCount(),
      array.trapCount(),
      revoked.trapCount(),
    ]).toEqual([0, 0, 0, 0]);

    const canonicalRoot = trapped({ safe: true });
    const canonicalNested = trapped({ safe: true });
    const canonicalArray = trapped(["safe"]);
    const canonicalRevoked = trapped({ safe: true });
    const revokedCanonical = Proxy.revocable(
      { safe: true },
      canonicalRevoked.handler,
    );
    revokedCanonical.revoke();
    const canonicalInputs = [
      canonicalRoot.proxy,
      { nested: canonicalNested.proxy },
      canonicalArray.proxy,
      revokedCanonical.proxy,
    ];
    for (const value of canonicalInputs) {
      expect(() => canonicalSerializeBounded(value)).toThrow("canonical-proxy");
    }
    expect([
      canonicalRoot.trapCount(),
      canonicalNested.trapCount(),
      canonicalArray.trapCount(),
      canonicalRevoked.trapCount(),
    ]).toEqual([0, 0, 0, 0]);
  });

  it("publishes a planning-only controlled-adoption contract and imports no authority modules", () => {
    expect(OUTCOME_ROUTER_ADOPTION_CONTRACT).toMatchObject({
      mode: "planning-only",
      liveDispatchWired: false,
      grantsAuthority: false,
    });
    expect(OUTCOME_ROUTER_ADOPTION_CONTRACT.gates).toContain(
      "legacy-unknown-cost-zero-seam-removed-after-pr-261",
    );
    expect(OUTCOME_ROUTER_ADOPTION_CONTRACT.forbiddenAuthorities).toEqual([
      "execute",
      "apply",
      "merge",
      "push",
      "publish",
      "deploy",
    ]);

    const source = readFileSync(
      fileURLToPath(
        new URL("../src/core/run/outcome-router.ts", import.meta.url),
      ),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(imports).toEqual(["node:util", "./capability-catalog.js"]);
  });

  it("uses an ordinal ASCII canonical-id tie-break independent of locale", () => {
    expect(compareCanonicalModelIds("A:model", "a:model")).toBeLessThan(0);
    expect(compareCanonicalModelIds("a:model", "A:model")).toBeGreaterThan(0);
    expect(compareCanonicalModelIds("same", "same")).toBe(0);
    const forward = routeOutcome(input());
    const reverse = routeOutcome({
      ...input(),
      outerEligibility: allEligible().reverse(),
    });
    expect(reverse.model).toBe(forward.model);
    expect(reverse.policyScore).toBe(forward.policyScore);
  });
});
