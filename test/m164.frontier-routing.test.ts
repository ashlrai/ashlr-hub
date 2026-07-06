/**
 * test/m164.frontier-routing.test.ts — M164: Quality-policy substantive routing.
 *
 * Proves the following invariants:
 *
 *  1. SUBSTANTIVE-TO-FRONTIER: under routingPolicy='quality', sources in
 *     {issue, goal, security, feature} route to claude:opus (reasoning) or
 *     codex:gpt-5.5 (implementation) regardless of effort level.
 *
 *  2. ENGINE SELECTION: reasoning-heavy sources (issue, goal, security) prefer
 *     claude:opus; implementation-heavy sources (feature, todo) prefer codex:gpt-5.5.
 *
 *  3. QUOTA FALLBACK: when the primary frontier engine is quota-exhausted, the
 *     router falls to the alternate frontier engine, then local-coder.
 *
 *  4. POLICY GATING: cost/balanced/absent policy does NOT trigger the quality
 *     fast-path; existing behavior is preserved for those policies.
 *
 *  5. TRIVIAL LOCAL: trivial items (effort=1, score<=3) still route to local
 *     under cost/balanced policy; quality policy overrides trivial-fast-path
 *     for substantive sources.
 *
 *  6. REASON STRING: reason includes 'quality policy' + engine name for all
 *     quality-policy substantive routes.
 *
 *  7. LARGE-SCOPE SIGNAL: localizedScope with fileCount > 5 or symbolCount > 20
 *     is treated as substantive under quality policy.
 *
 *  8. SOURCE GREP-GUARD: router.ts M164 section has no auto-apply primitives.
 *
 * Mirrors m128/m155 conventions: baseConfig()+withFoundry(), makeItem() with _seq,
 * vi.mock() for engines/quota/subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Mocks — hoisted before module imports
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn(() => true),
  evalQuota: vi.fn(() => 'ok'),
  recordUse: vi.fn(),
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock: within limit' })),
  isSubscriptionEngine: vi.fn((e: string) => e === 'claude' || e === 'codex'),
  subscriptionUsage: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import { routeTask, type RoutingContext } from '../src/core/run/router.js';
import { withinLimit } from '../src/core/fleet/quota.js';
import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  vi.mocked(withinLimit).mockReturnValue(true);
  vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
});

function makeItem(over: Partial<WorkItem> & { source: WorkSource | 'feature' }): WorkItem {
  _seq++;
  return {
    id: `m164-item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 2,   // medium by default
    score: 4,    // below FRONTIER_SCORE_THRESHOLD=8
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  } as WorkItem;
}

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  // M321: this suite pins PRE-Claude-5 routing expectations — claude5 is
  // disabled here so it stays the flag-off parity baseline (byte-identical
  // guarantee). Default-on behavior lives in m321.claude5-routing.test.ts.
  return { ...baseConfig(), foundry: { claude5: { enabled: false }, ...foundry } } as AshlrConfig;
}

/** Config with quality routing policy, all backends allowed. */
function qualityCfg(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any,
    routingPolicy: 'quality',
    ...extra,
  } as any);
}

/** Config with balanced/cost policy (default behavior). */
function balancedCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any,
    routingPolicy: 'balanced',
  } as any);
}

function costCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any,
    routingPolicy: 'cost',
  } as any);
}

/** RoutingContext with all engines available. */
const ALL_CTX: RoutingContext = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any[],
};

/** RoutingContext with only local/mid engines (no frontier). */
const LOCAL_CTX: RoutingContext = {
  availableEngines: ['local-coder', 'builtin'] as any[],
};

/** RoutingContext with only codex available (claude absent). */
const CODEX_ONLY_CTX: RoutingContext = {
  availableEngines: ['codex', 'local-coder', 'builtin'] as any[],
};

/** RoutingContext with only claude available (codex absent). */
const CLAUDE_ONLY_CTX: RoutingContext = {
  availableEngines: ['claude', 'local-coder', 'builtin'] as any[],
};

// ---------------------------------------------------------------------------
// 1. SUBSTANTIVE-TO-FRONTIER: quality policy routes {issue,goal,security,feature}
// ---------------------------------------------------------------------------

describe('M164 invariant 1 — substantive sources → frontier under quality policy', () => {
  it('issue (medium effort) → claude:opus (quality policy)', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toMatch(/quality policy/i);
  });

  it('goal (medium effort) → claude:opus (quality policy)', () => {
    const item = makeItem({ source: 'goal', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toMatch(/quality policy/i);
  });

  it('security (medium effort) → claude:opus (quality policy)', () => {
    const item = makeItem({ source: 'security', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toMatch(/quality policy/i);
  });

  it('feature (medium effort) → codex:gpt-5.5 (quality policy, implementation-heavy)', () => {
    const item = makeItem({ source: 'feature' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('codex');
    expect(result.model).toBe('gpt-5.5');
    expect(result.reason).toMatch(/quality policy/i);
  });

  it('issue (trivial effort=1) → still frontier under quality policy', () => {
    const item = makeItem({ source: 'issue', effort: 1, score: 2 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    // quality policy substantive fast-path fires before trivial fast-path
    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
    expect(result.reason).toMatch(/quality policy/i);
  });

  it('goal (trivial effort=1) → still frontier under quality policy', () => {
    const item = makeItem({ source: 'goal', effort: 1, score: 2 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. ENGINE SELECTION: reasoning sources → claude; implementation → codex
// ---------------------------------------------------------------------------

describe('M164 invariant 2 — engine selection: reasoning→claude, implementation→codex', () => {
  it('issue → claude (reasoning/architecture)', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
    expect(result.reason).toMatch(/opus.*reason|reason.*opus/i);
  });

  it('goal → claude (reasoning/architecture)', () => {
    const item = makeItem({ source: 'goal', effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
  });

  it('security → claude (reasoning)', () => {
    const item = makeItem({ source: 'security', effort: 3, score: 6 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('claude');
  });

  it('feature → codex (large multi-file implementation)', () => {
    const item = makeItem({ source: 'feature' as WorkSource, effort: 3, score: 6 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).toBe('codex');
    expect(result.reason).toMatch(/gpt-5\.5.*impl|implementation/i);
  });

  it('model tag is non-null for frontier engines under quality policy', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.model).not.toBeNull();
    expect(typeof result.model).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 3. QUOTA FALLBACK: rate-limited primary → alt frontier → local
// ---------------------------------------------------------------------------

describe('M164 invariant 3 — quota fallback: primary rate-limited → alt frontier → local', () => {
  it('claude quota-exhausted for issue → falls to codex (alt frontier)', () => {
    vi.mocked(subscriptionAllows).mockImplementation((engine) => {
      if (engine === 'claude') return { allowed: false, reason: 'claude window saturated' };
      return { allowed: true, reason: 'mock' };
    });

    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    // claude saturated → should fall to codex
    expect(result.engine).toBe('codex');
    expect(result.reason).toMatch(/fallback|rate-limited|primary frontier/i);
  });

  it('codex quota-exhausted for feature → falls to claude (alt frontier)', () => {
    vi.mocked(withinLimit).mockImplementation((engine) => {
      if (engine === 'codex') return false;
      return true;
    });

    const item = makeItem({ source: 'feature' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    // codex over quota → claude is alt
    expect(result.engine).toBe('claude');
    expect(result.reason).toMatch(/fallback|rate-limited|primary frontier/i);
  });

  it('both frontiers quota-exhausted → cascades to local-coder', () => {
    vi.mocked(withinLimit).mockImplementation((engine) => {
      if (engine === 'claude' || engine === 'codex') return false;
      return true;
    });

    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    // Both frontiers exhausted → local-coder cascade fallback
    expect(result.engine).toBe('local-coder' as any);
    expect(result.reason).toMatch(/quota-exhausted|cascade fallback/i);
  });

  it('claude subscription window closed for goal → codex', () => {
    vi.mocked(subscriptionAllows).mockImplementation((engine) => {
      if (engine === 'claude') return { allowed: false, reason: 'window 91% used' };
      return { allowed: true, reason: 'mock' };
    });

    const item = makeItem({ source: 'goal', effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.engine).not.toBe('claude');
    expect(result.engine).toBe('codex');
  });

  it('claude not in availableEngines for issue → codex (alt frontier)', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), CODEX_ONLY_CTX);

    expect(result.engine).toBe('codex');
  });

  it('codex not in availableEngines for feature → claude (alt frontier)', () => {
    const item = makeItem({ source: 'feature' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), CLAUDE_ONLY_CTX);

    expect(result.engine).toBe('claude');
  });

  it('no frontier in ctx for quality+issue → local-coder (graceful cascade)', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), LOCAL_CTX);

    // No frontier available → local cascade
    const isLocal =
      result.engine === ('local-coder' as any) || result.engine === 'builtin';
    expect(isLocal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. POLICY GATING: cost/balanced/absent do not trigger quality fast-path
// ---------------------------------------------------------------------------

describe('M164 invariant 4 — policy gating: cost/balanced/absent preserve existing behavior', () => {
  it('balanced policy: medium issue (effort=3, score=5) → not necessarily opus', () => {
    // Under balanced policy, medium issue is NOT forced to frontier unless hard.
    // It may route to sonnet or local. The invariant is: quality fast-path NOT triggered.
    const item = makeItem({ source: 'issue', effort: 3, score: 5 });
    const result = routeTask(item, balancedCfg(), ALL_CTX);

    // reason should NOT contain 'quality policy' (that's M164's tag)
    expect(result.reason).not.toMatch(/quality policy/i);
  });

  it('cost policy: medium goal (effort=2, score=4) → local (free)', () => {
    const item = makeItem({ source: 'goal', effort: 2, score: 4 });
    const result = routeTask(item, costCfg(), ALL_CTX);

    // cost policy prefers free local for medium items
    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
    expect(result.reason).not.toMatch(/quality policy/i);
  });

  it('balanced policy: trivial doc item → local (unchanged)', () => {
    const item = makeItem({ source: 'doc', effort: 1, score: 2 });
    const result = routeTask(item, balancedCfg(), ALL_CTX);

    expect(result.reason).not.toMatch(/quality policy/i);
    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
  });

  it('absent foundry.routingPolicy → balanced defaults apply (not quality)', () => {
    // No routingPolicy set → defaults to 'balanced'
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'] as any,
    } as any);
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, cfg, ALL_CTX);

    expect(result.reason).not.toMatch(/quality policy/i);
  });

  it('quality policy: non-substantive source (todo, medium) → still frontier (quality forces all to strong)', () => {
    // Under quality policy, even non-substantive items go frontier (via the existing
    // preferQuality || hard branch). This tests that M164 doesn't break that behavior.
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. TRIVIAL LOCAL: trivial items under cost/balanced stay local
// ---------------------------------------------------------------------------

describe('M164 invariant 5 — trivial items stay local under cost/balanced policy', () => {
  it('trivial todo (effort=1, score=2) under balanced → local or haiku (not opus)', () => {
    const item = makeItem({ source: 'todo', effort: 1, score: 2 });
    const result = routeTask(item, balancedCfg(), ALL_CTX);

    // Should NOT be opus
    const isOpus = result.engine === 'claude' && result.model === 'opus';
    expect(isOpus).toBe(false);
    expect(result.reason).toMatch(/trivial/i);
  });

  it('trivial doc (effort=1, score=2) under cost → free local', () => {
    const item = makeItem({ source: 'doc', effort: 1, score: 2 });
    const result = routeTask(item, costCfg(), ALL_CTX);

    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
  });

  it('trivial item under quality policy → frontier (quality overrides trivial fast-path)', () => {
    const item = makeItem({ source: 'todo', effort: 1, score: 2 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    // quality policy: trivial fast-path is skipped (trivial && policy !== 'quality')
    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. REASON STRING: quality policy substantive routes include 'quality policy'
// ---------------------------------------------------------------------------

describe('M164 invariant 6 — reason string includes policy + engine for quality substantive routes', () => {
  it('issue under quality policy: reason mentions "quality policy"', () => {
    const item = makeItem({ source: 'issue', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.reason).toMatch(/quality policy/i);
  });

  it('goal under quality policy: reason mentions engine name', () => {
    const item = makeItem({ source: 'goal', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.reason).toMatch(/claude|codex/i);
  });

  it('security under quality policy: reason mentions "reasoning" or "architecture"', () => {
    const item = makeItem({ source: 'security', effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.reason).toMatch(/reasoning|architecture|opus/i);
  });

  it('feature under quality policy: reason mentions "implementation" or "gpt-5.5"', () => {
    const item = makeItem({ source: 'feature' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);

    expect(result.reason).toMatch(/impl|gpt-5\.5|codex/i);
  });

  it('reason is always non-empty string', () => {
    const sources: Array<WorkSource | 'feature'> = ['issue', 'goal', 'security', 'feature'];
    for (const source of sources) {
      _seq = 0;
      const item = makeItem({ source: source as WorkSource, effort: 2, score: 4 });
      const result = routeTask(item, qualityCfg(), ALL_CTX);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. LARGE-SCOPE SIGNAL: localizedScope large → treated as substantive
// ---------------------------------------------------------------------------

describe('M164 invariant 7 — large localizedScope treated as substantive under quality policy', () => {
  it('todo with fileCount=8 under quality → frontier (large scope overrides non-substantive source)', () => {
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 2, score: 4 }),
      localizedScope: { fileCount: 8, symbolCount: 5 },
    };
    const result = routeTask(item as any, qualityCfg(), ALL_CTX);

    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });

  it('todo with symbolCount=25 under quality → frontier', () => {
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 1, score: 3 }),
      localizedScope: { fileCount: 2, symbolCount: 25 },
    };
    const result = routeTask(item as any, qualityCfg(), ALL_CTX);

    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });

  it('small scope (fileCount=2, symbolCount=5) non-substantive source under quality → frontier anyway (quality forces it)', () => {
    // Under quality policy, even small scope goes to frontier via the hard/quality branch
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 2, score: 4 }),
      localizedScope: { fileCount: 2, symbolCount: 5 },
    };
    const result = routeTask(item as any, qualityCfg(), ALL_CTX);

    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });

  it('large scope under balanced policy: does NOT force quality fast-path', () => {
    const item = {
      ...makeItem({ source: 'todo' as WorkSource, effort: 2, score: 4 }),
      localizedScope: { fileCount: 10, symbolCount: 30 },
    };
    const result = routeTask(item as any, balancedCfg(), ALL_CTX);

    // balanced policy: large scope does not trigger quality fast-path
    expect(result.reason).not.toMatch(/quality policy/i);
  });
});

// ---------------------------------------------------------------------------
// 8. SOURCE GREP-GUARD: no auto-apply primitives in M164 section
// ---------------------------------------------------------------------------

describe('M164 invariant 8 — source grep-guard: no auto-apply in router.ts M164 section', () => {
  it('router.ts carries no apply/merge/createPr/push/deploy primitive', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/router.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/applyProposal/);
    expect(src).not.toMatch(/inbox\/apply/);
    expect(src).not.toMatch(/\bgit push\b/);
    expect(src).not.toMatch(/gh pr create/);
    expect(src).not.toMatch(/createPr\b/);
    expect(src).not.toMatch(/mergeProposal/);
    expect(src).not.toMatch(/autoMerge\s*\(/);
    expect(src).not.toMatch(/\bdeploy\s*\(/);
  });

  it('router.ts contains M164 isSubstantiveItem and preferredFrontierEngine functions', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/router.ts'),
      'utf8',
    );
    expect(src).toMatch(/isSubstantiveItem/);
    expect(src).toMatch(/preferredFrontierEngine/);
    expect(src).toMatch(/SUBSTANTIVE_SOURCES/);
  });

  it('router.ts quality fast-path reason includes "quality policy"', () => {
    const src = readFileSync(
      resolve(HERE, '../src/core/run/router.ts'),
      'utf8',
    );
    expect(src).toMatch(/quality policy/);
  });
});
