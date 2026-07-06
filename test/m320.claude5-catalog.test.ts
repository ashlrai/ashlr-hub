/**
 * m320.claude5-catalog.test.ts — M320: Claude 5 generation in the model catalog.
 *
 * Covers:
 *  - claude:sonnet-5 / claude:fable-5 entries (tier, capabilities, minEffort,
 *    apiModelId, qualityRank) + corrected Opus/Haiku pricing.
 *  - pickModel: Claude 5 ids excluded BY DEFAULT (pre-M320 byte-identical for
 *    every legacy call site); claude5ExcludeIds(cfg) opts a caller in;
 *    preferStrong sorts by qualityRank.
 *  - canonicalModelTag spelling table.
 *  - claude5Enabled / fableEnabled / defaultStrategistModel flag matrix.
 *  - evaluateMergeAuthority: spelling-variant-safe matching for sonnet-5;
 *    tri-tier trust invariants unchanged (mid/local never authorized).
 */

import { describe, it, expect } from 'vitest';

import type { AshlrConfig, Proposal } from '../src/core/types.js';
import {
  KNOWN_MODELS,
  pickModel,
  costOf,
  canonicalModelTag,
  claude5Enabled,
  fableEnabled,
  claude5ExcludeIds,
  defaultStrategistModel,
  CLAUDE5_CATALOG_IDS,
  CLAUDE5_SONNET_API_ID,
  CLAUDE5_FABLE_API_ID,
  CLAUDE_OPUS_API_ID,
} from '../src/core/run/model-catalog.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfgWith(claude5?: { enabled?: boolean; fable?: boolean }): AshlrConfig {
  return { foundry: claude5 ? { claude5 } : {} } as AshlrConfig;
}

function makeProposal(engineTier: string, engineModel: string): Proposal {
  return {
    id: 'p-m320',
    status: 'pending',
    engineTier,
    engineModel,
  } as unknown as Proposal;
}

function authorityCfg(entries: Array<{ engine: string; model: string }>): AshlrConfig {
  return { foundry: { mergeAuthority: entries } } as unknown as AshlrConfig;
}

// ---------------------------------------------------------------------------
// Catalog entries
// ---------------------------------------------------------------------------

describe('M320 catalog entries', () => {
  it('claude:sonnet-5 exists with frontier-class shape', () => {
    const m = KNOWN_MODELS.find((e) => e.id === 'claude:sonnet-5');
    expect(m).toBeDefined();
    expect(m!.engine).toBe('claude');
    expect(m!.tier).toBe('large');
    expect(m!.costPerMTokIn).toBe(3.0);
    expect(m!.costPerMTokOut).toBe(15.0);
    expect(m!.capabilities).toContain('coder');
    expect(m!.capabilities).toContain('reasoning');
    expect(m!.minEffort).toBe(2);
    expect(m!.apiModelId).toBe(CLAUDE5_SONNET_API_ID);
    expect(m!.qualityRank).toBe(3);
  });

  it('claude:fable-5 exists, priced above Opus, minEffort 5', () => {
    const m = KNOWN_MODELS.find((e) => e.id === 'claude:fable-5');
    expect(m).toBeDefined();
    expect(m!.tier).toBe('large');
    expect(m!.costPerMTokIn).toBe(10.0);
    expect(m!.costPerMTokOut).toBe(50.0);
    expect(m!.minEffort).toBe(5);
    expect(m!.apiModelId).toBe(CLAUDE5_FABLE_API_ID);
    expect(m!.qualityRank).toBe(5);
  });

  it('legacy claude entries survive (back-compat) with corrected pricing', () => {
    const opus = KNOWN_MODELS.find((e) => e.id === 'claude:opus');
    const sonnet = KNOWN_MODELS.find((e) => e.id === 'claude:sonnet');
    const haiku = KNOWN_MODELS.find((e) => e.id === 'claude:haiku');
    expect(opus).toBeDefined();
    expect(sonnet).toBeDefined();
    expect(haiku).toBeDefined();
    // M320 price corrections (Opus 4.8 $5/$25, Haiku 4.5 $1/$5)
    expect(opus!.costPerMTokIn).toBe(5.0);
    expect(opus!.costPerMTokOut).toBe(25.0);
    expect(haiku!.costPerMTokIn).toBe(1.0);
    expect(haiku!.costPerMTokOut).toBe(5.0);
    expect(opus!.apiModelId).toBe(CLAUDE_OPUS_API_ID);
    // costOf still behaves (combined/2)
    expect(costOf('claude:opus')).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// pickModel — default exclusion (byte-identical legacy behavior)
// ---------------------------------------------------------------------------

describe('M320 pickModel exclusion + preferStrong', () => {
  it('excludes Claude 5 ids by default — legacy call sites unchanged', () => {
    const picked = pickModel({ engine: 'claude', maxEffort: 3 });
    expect(picked).not.toBeNull();
    expect(CLAUDE5_CATALOG_IDS.has(picked!.id)).toBe(false);
    expect(picked!.id).toBe('claude:opus'); // large tier still wins, opus only large
  });

  it('opted-in caller (claude5 enabled) gets sonnet-5 as cheapest-large', () => {
    const picked = pickModel({
      engine: 'claude',
      maxEffort: 3,
      excludeIds: claude5ExcludeIds(cfgWith()),
    });
    expect(picked!.id).toBe('claude:sonnet-5');
  });

  it('claude5.enabled:false excludes both new ids even for opted-in callers', () => {
    const picked = pickModel({
      engine: 'claude',
      maxEffort: 3,
      excludeIds: claude5ExcludeIds(cfgWith({ enabled: false })),
    });
    expect(picked!.id).toBe('claude:opus');
  });

  it('preferStrong at effort 5 picks fable-5; at effort 3 picks opus', () => {
    const none = claude5ExcludeIds(cfgWith());
    const strong5 = pickModel({ engine: 'claude', maxEffort: 5, preferStrong: true, excludeIds: none });
    expect(strong5!.id).toBe('claude:fable-5');
    const strong3 = pickModel({ engine: 'claude', maxEffort: 3, preferStrong: true, excludeIds: none });
    expect(strong3!.id).toBe('claude:opus'); // fable filtered by minEffort, opus outranks sonnet-5
  });

  it('fable:false excludes only fable-5 — sonnet-5 still routable', () => {
    const excludes = claude5ExcludeIds(cfgWith({ fable: false }));
    expect(excludes.has('claude:fable-5')).toBe(true);
    expect(excludes.has('claude:sonnet-5')).toBe(false);
    const strong = pickModel({ engine: 'claude', maxEffort: 5, preferStrong: true, excludeIds: excludes });
    expect(strong!.id).toBe('claude:opus');
  });
});

// ---------------------------------------------------------------------------
// Flags + strategist default
// ---------------------------------------------------------------------------

describe('M320 flags', () => {
  it('claude5Enabled defaults on; false only when explicitly disabled', () => {
    expect(claude5Enabled(undefined)).toBe(true);
    expect(claude5Enabled(cfgWith())).toBe(true);
    expect(claude5Enabled(cfgWith({ enabled: false }))).toBe(false);
  });

  it('fableEnabled requires claude5Enabled', () => {
    expect(fableEnabled(cfgWith())).toBe(true);
    expect(fableEnabled(cfgWith({ fable: false }))).toBe(false);
    expect(fableEnabled(cfgWith({ enabled: false }))).toBe(false);
    expect(fableEnabled(cfgWith({ enabled: false, fable: true }))).toBe(false);
  });

  it('defaultStrategistModel: fable-5 when on, opus-4-8 otherwise', () => {
    expect(defaultStrategistModel(cfgWith())).toBe(CLAUDE5_FABLE_API_ID);
    expect(defaultStrategistModel(cfgWith({ fable: false }))).toBe(CLAUDE_OPUS_API_ID);
    expect(defaultStrategistModel(cfgWith({ enabled: false }))).toBe(CLAUDE_OPUS_API_ID);
  });
});

// ---------------------------------------------------------------------------
// canonicalModelTag
// ---------------------------------------------------------------------------

describe('M320 canonicalModelTag', () => {
  const table: Array<[string, string, string]> = [
    ['claude', 'sonnet-5', 'sonnet-5'],
    ['claude', 'claude-sonnet-5', 'sonnet-5'],
    ['claude', 'claude:sonnet-5', 'sonnet-5'],
    ['claude', 'claude:claude-sonnet-5', 'sonnet-5'],
    ['claude', 'claude-fable-5', 'fable-5'],
    ['claude', 'claude-opus-4-8', 'opus'],
    ['claude', 'opus', 'opus'],
    ['claude', 'claude-haiku-4-5', 'haiku'],
    ['claude', 'some-unknown-model', 'some-unknown-model'],
    ['local-coder', 'local-coder:qwen2.5:72b', 'qwen2.5:72b'],
    ['codex', 'gpt-5.5', 'gpt-5.5'],
  ];
  for (const [engine, input, want] of table) {
    it(`${engine} / '${input}' → '${want}'`, () => {
      expect(canonicalModelTag(engine, input)).toBe(want);
    });
  }

  it('empty/null-ish input → empty string', () => {
    expect(canonicalModelTag('claude', '')).toBe('');
    expect(canonicalModelTag('claude', null)).toBe('');
    expect(canonicalModelTag('claude', undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Merge authority — spelling-variant-safe, invariants unchanged
// ---------------------------------------------------------------------------

describe('M320 evaluateMergeAuthority spelling safety', () => {
  it('exact match keeps working (pre-M320 byte-identical)', () => {
    const cfg = authorityCfg([{ engine: 'claude', model: 'claude-opus-4-8' }]);
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-opus-4-8'), cfg);
    expect(v.authorized).toBe(true);
  });

  it("authority entry 'sonnet-5' matches proposal 'claude:claude-sonnet-5'", () => {
    const cfg = authorityCfg([{ engine: 'claude', model: 'sonnet-5' }]);
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-sonnet-5'), cfg);
    expect(v.authorized).toBe(true);
  });

  it("authority entry 'claude-sonnet-5' matches proposal 'claude:sonnet-5'", () => {
    const cfg = authorityCfg([{ engine: 'claude', model: 'claude-sonnet-5' }]);
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:sonnet-5'), cfg);
    expect(v.authorized).toBe(true);
  });

  it('unauthorized model still refused', () => {
    const cfg = authorityCfg([{ engine: 'claude', model: 'claude-sonnet-5' }]);
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-fable-5'), cfg);
    expect(v.authorized).toBe(false);
  });

  it('mid tier never authorized even with a matching entry (tri-tier invariant)', () => {
    const cfg = authorityCfg([{ engine: 'local-coder', model: 'qwen3-coder-next' }]);
    const v = evaluateMergeAuthority(makeProposal('mid', 'local-coder:qwen3-coder-next'), cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toContain('frontier');
  });

  it(":default still rejected (no canonical rescue for unpinned models)", () => {
    const cfg = authorityCfg([{ engine: 'claude', model: 'default' }]);
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:default'), cfg);
    expect(v.authorized).toBe(false);
  });
});
