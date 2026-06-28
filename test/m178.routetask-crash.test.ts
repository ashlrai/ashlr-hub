/**
 * test/m178.routetask-crash.test.ts — M178: routeTask defensive crash fix.
 *
 * Root cause: engineAvailable() called ctx.availableEngines.includes(engine)
 * without guarding ctx.availableEngines — when ctx={} (empty object),
 * ctx.availableEngines is undefined → TypeError: Cannot read properties of
 * undefined (reading 'includes') → caught by routeTask try/catch → builtin
 * fallback → entire frontier-first routing (M164) was dead.
 *
 * Fix: treat ctx.availableEngines === undefined as "all engines available"
 * (permissive default), not "no engines available" (block-all).
 *
 * Invariants proven here:
 *  1. CRASH REPRO: the exact repro from M178 spec no longer returns builtin.
 *  2. MINIMAL-CTX FRONTIER: goal/issue/security with ctx={} under quality policy
 *     routes to claude or codex (not builtin, not an error).
 *  3. MINIMAL-ITEM: routeTask never throws when item is missing tags/score/effort.
 *  4. TRIVIAL LOCAL: trivial item (effort=1, score≤3, source=todo) still routes
 *     local under cost/balanced with full ctx.
 *  5. CTX-GATING: when ctx.availableEngines is explicit and excludes claude,
 *     a goal/quality item falls to codex (not claude).
 *  6. REASON STRING: frontier decisions mention 'quality' in the reason.
 *  7. NO-THROW GUARANTEE: routeTask never throws on any combination of missing
 *     fields (undefined tags, missing ctx fields, empty ctx).
 *
 * Mirrors m128/m164 conventions: baseConfig()+withFoundry(), makeItem() with
 * _seq, vi.mock() for engines/quota/subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Helpers (mirror m164 conventions)
// ---------------------------------------------------------------------------

let _seq = 0;
beforeEach(() => {
  _seq = 0;
  vi.mocked(withinLimit).mockReturnValue(true);
  vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
});

function makeItem(over: Partial<WorkItem> & { source: WorkSource | 'feature' | 'goal' }): WorkItem {
  _seq++;
  return {
    id: `m178-item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 2,
    score: 4,
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
  return { ...baseConfig(), foundry } as AshlrConfig;
}

function qualityCfg(extra?: Partial<NonNullable<AshlrConfig['foundry']>>): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any,
    routingPolicy: 'quality',
    ...extra,
  } as any);
}

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

/** Full ctx — all engines available. */
const ALL_CTX: RoutingContext = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any[],
};

/** Local-only ctx. */
const LOCAL_CTX: RoutingContext = {
  availableEngines: ['local-coder', 'builtin'] as any[],
};

/** Codex-only ctx (claude absent). */
const CODEX_ONLY_CTX: RoutingContext = {
  availableEngines: ['codex', 'local-coder', 'builtin'] as any[],
};

const FRONTIER_ENGINES = new Set(['claude', 'codex']);

// ---------------------------------------------------------------------------
// 1. CRASH REPRO — exact M178 spec repro must NOT return builtin/error
// ---------------------------------------------------------------------------

describe('M178: crash repro', () => {
  it('exact repro: routeTask({source:goal, value:5, effort:4, tags:[goal]}, cfg, {}) → frontier', () => {
    const item = makeItem({ source: 'goal' as WorkSource, title: '...', value: 5, effort: 4, tags: ['goal'] as any });
    const cfg = qualityCfg();
    const ctx = {} as RoutingContext; // the crash-inducing ctx

    let result: ReturnType<typeof routeTask>;
    expect(() => {
      result = routeTask(item, cfg, ctx);
    }).not.toThrow();

    expect(result!.engine).not.toBe('builtin');
    expect(FRONTIER_ENGINES.has(result!.engine as string)).toBe(true);
    expect(result!.reason).not.toMatch(/routeTask error/);
  });

  it('reason mentions quality policy — not an error string', () => {
    const item = makeItem({ source: 'goal' as WorkSource, value: 5, effort: 4 });
    const result = routeTask(item, qualityCfg(), {} as RoutingContext);
    expect(result.reason).toMatch(/quality/i);
    expect(result.reason).not.toMatch(/error/i);
  });
});

// ---------------------------------------------------------------------------
// 2. MINIMAL-CTX FRONTIER: goal/issue/security with ctx={} under quality
// ---------------------------------------------------------------------------

describe('M178: minimal-ctx frontier routing', () => {
  it('goal + ctx={} → frontier (claude)', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4, score: 5 });
    const result = routeTask(item, qualityCfg(), {} as RoutingContext);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(true);
  });

  it('issue + ctx={} → frontier', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), {} as RoutingContext);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(true);
  });

  it('security + ctx={} → frontier', () => {
    const item = makeItem({ source: 'security' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), {} as RoutingContext);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(true);
  });

  it('goal/issue/security prefer claude (reasoning-heavy)', () => {
    for (const src of ['goal', 'issue', 'security'] as WorkSource[]) {
      const item = makeItem({ source: src, effort: 4, score: 5 });
      const result = routeTask(item, qualityCfg(), {} as RoutingContext);
      expect(result.engine).toBe('claude');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. MINIMAL-ITEM: missing tags/score/effort never throws
// ---------------------------------------------------------------------------

describe('M178: minimal item — missing fields never throw', () => {
  it('item without tags field does not throw', () => {
    const item = { id: 'm178-notags', repo: '/r', title: 'x', source: 'goal', value: 5, effort: 4, ts: '' } as any;
    expect(() => routeTask(item, qualityCfg(), {} as RoutingContext)).not.toThrow();
  });

  it('item without effort/score defaults gracefully', () => {
    const item = { id: 'm178-noeffort', repo: '/r', title: 'x', source: 'goal', value: 5, ts: '' } as any;
    expect(() => routeTask(item, qualityCfg(), {} as RoutingContext)).not.toThrow();
  });

  it('item with undefined tags does not throw', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4 });
    (item as any).tags = undefined;
    expect(() => routeTask(item, qualityCfg(), {} as RoutingContext)).not.toThrow();
  });

  it('completely bare item {source, title} does not throw', () => {
    const item = { source: 'goal', title: 'bare' } as any;
    expect(() => routeTask(item, qualityCfg(), {} as RoutingContext)).not.toThrow();
  });

  it('routeTask never returns engine=undefined regardless of inputs', () => {
    const cases: any[] = [
      {},
      { source: 'goal' },
      { source: 'issue', effort: 4 },
      { source: 'security', score: 9 },
      { source: 'todo', effort: 1, score: 1 },
    ];
    for (const item of cases) {
      const result = routeTask(item, qualityCfg(), {} as RoutingContext);
      expect(result.engine).toBeDefined();
      expect(result.reason).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. TRIVIAL LOCAL: trivial non-substantive item still routes local
// ---------------------------------------------------------------------------

describe('M178: trivial items still route local', () => {
  it('todo effort=1 score=2 cost policy → non-frontier', () => {
    const item = makeItem({ source: 'todo' as WorkSource, effort: 1, score: 2 });
    const result = routeTask(item, costCfg(), ALL_CTX);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(false);
  });

  it('todo effort=1 score=2 balanced policy → non-frontier', () => {
    const item = makeItem({ source: 'todo' as WorkSource, effort: 1, score: 2 });
    const result = routeTask(item, balancedCfg(), ALL_CTX);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. CTX-GATING: explicit ctx still gates engines correctly
// ---------------------------------------------------------------------------

describe('M178: explicit ctx.availableEngines gates correctly', () => {
  it('claude-absent ctx: goal/quality falls back to codex', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4, score: 5 });
    const ctx: RoutingContext = { availableEngines: ['codex', 'local-coder', 'builtin'] as any[] };
    const result = routeTask(item, qualityCfg(), ctx);
    expect(result.engine).toBe('codex');
  });

  it('local-only ctx: goal/quality falls to local-coder (no frontier)', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4, score: 5 });
    const result = routeTask(item, qualityCfg(), LOCAL_CTX);
    expect(FRONTIER_ENGINES.has(result.engine as string)).toBe(false);
  });

  it('full ctx: goal/quality routes to claude', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);
    expect(result.engine).toBe('claude');
  });

  it('CODEX_ONLY_CTX: issue/quality routes to codex (claude absent)', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), CODEX_ONLY_CTX);
    expect(result.engine).toBe('codex');
  });
});

// ---------------------------------------------------------------------------
// 6. REASON STRING: frontier decisions mention 'quality'
// ---------------------------------------------------------------------------

describe('M178: reason string quality gate', () => {
  it('goal frontier decision reason includes "quality"', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 4, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);
    expect(result.reason).toMatch(/quality/i);
  });

  it('issue frontier decision reason includes "quality"', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 3, score: 5 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);
    expect(result.reason).toMatch(/quality/i);
  });

  it('security frontier decision reason includes "quality"', () => {
    const item = makeItem({ source: 'security' as WorkSource, effort: 2, score: 4 });
    const result = routeTask(item, qualityCfg(), ALL_CTX);
    expect(result.reason).toMatch(/quality/i);
  });
});

// ---------------------------------------------------------------------------
// 7. NO-THROW GUARANTEE across ctx variants
// ---------------------------------------------------------------------------

describe('M178: routeTask never throws on any ctx variant', () => {
  const ctxVariants: Array<[string, any]> = [
    ['ctx={}', {}],
    ['ctx={availableEngines:undefined}', { availableEngines: undefined }],
    ['ctx={availableEngines:null}', { availableEngines: null }],
    ['ctx=ALL_CTX', ALL_CTX],
    ['ctx=LOCAL_CTX', LOCAL_CTX],
  ];

  const itemVariants: Array<[string, any]> = [
    ['goal effort=4', makeItem({ source: 'goal' as WorkSource, effort: 4, value: 5 })],
    ['issue effort=3', makeItem({ source: 'issue' as WorkSource, effort: 3 })],
    ['security effort=2', makeItem({ source: 'security' as WorkSource, effort: 2 })],
    ['todo effort=1', makeItem({ source: 'todo' as WorkSource, effort: 1, score: 2 })],
  ];

  for (const [ctxLabel, ctx] of ctxVariants) {
    for (const [itemLabel, item] of itemVariants) {
      it(`${itemLabel} × ${ctxLabel} → does not throw`, () => {
        expect(() => routeTask(item, qualityCfg(), ctx)).not.toThrow();
      });
    }
  }
});
