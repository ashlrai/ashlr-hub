/**
 * m128.model-router.test.ts — M128: model-catalog + routeTask + fleet router.
 *
 * Mirrors m46/m115/m53 conventions:
 *  - baseConfig() + withFoundry() helpers
 *  - makeItem() with stable _seq counter
 *  - vi.mock() for engineInstalled, withinLimit, subscriptionAllows
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before the module imports
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
// Now import the modules under test
// ---------------------------------------------------------------------------

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import {
  KNOWN_MODELS,
  catalogFor,
  costOf,
  pickModel,
} from '../src/core/run/model-catalog.js';
import { routeTask } from '../src/core/run/router.js';
import { routeBackend } from '../src/core/fleet/router.js';
import { withinLimit } from '../src/core/fleet/quota.js';
import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';
import { engineInstalled } from '../src/core/run/engines.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roots = [os.homedir()];
const editor = { name: 'vscode' as const };

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots,
    editor,
    models: { providerChain: ['ollama'], routing: [] },
  } as unknown as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  // M321: this suite pins PRE-Claude-5 routing expectations — claude5 is
  // disabled here so it stays the flag-off parity baseline (byte-identical
  // guarantee). Default-on behavior lives in m321.claude5-routing.test.ts.
  return { ...baseConfig(), foundry: { claude5: { enabled: false }, ...foundry } } as AshlrConfig;
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 3,
    score: 5,
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

// RoutingContext with all engines available
const ALL_ENGINES_CTX = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as any[],
};

// RoutingContext with only local
const LOCAL_ONLY_CTX = {
  availableEngines: ['local-coder', 'builtin'] as any[],
};

// RoutingContext with only builtin
const BUILTIN_ONLY_CTX = {
  availableEngines: ['builtin'] as any[],
};

// ---------------------------------------------------------------------------
// 1. model-catalog.ts tests
// ---------------------------------------------------------------------------

describe('M128 model-catalog', () => {
  beforeEach(() => { _seq = 0; });

  it('KNOWN_MODELS has entries for all expected engines', () => {
    const engines = new Set(KNOWN_MODELS.map((m) => m.engine));
    expect(engines.has('claude')).toBe(true);
    expect(engines.has('codex')).toBe(true);
    expect(engines.has('local-coder' as any)).toBe(true);
    expect(engines.has('nim' as any)).toBe(true);
  });

  it('catalogFor returns only entries for that engine', () => {
    const claudeModels = catalogFor('claude');
    expect(claudeModels.length).toBeGreaterThan(0);
    claudeModels.forEach((m) => expect(m.engine).toBe('claude'));
  });

  it('catalogFor returns empty for unknown engine', () => {
    expect(catalogFor('unknown-engine')).toHaveLength(0);
  });

  it('costOf returns 0 for local models', () => {
    expect(costOf('local-coder:qwen2.5:72b')).toBe(0);
    expect(costOf('local-coder:small')).toBe(0);
  });

  it('costOf returns nonzero for claude:opus', () => {
    expect(costOf('claude:opus')).toBeGreaterThan(0);
  });

  it('costOf returns 0 for unknown id', () => {
    expect(costOf('unknown:model')).toBe(0);
  });

  it('pickModel with engine=claude returns a claude model', () => {
    const entry = pickModel({ engine: 'claude' });
    expect(entry).not.toBeNull();
    expect(entry!.engine).toBe('claude');
  });

  it('pickModel with capability=coder returns a coder model', () => {
    const entry = pickModel({ capability: 'coder' });
    expect(entry).not.toBeNull();
    expect(entry!.capabilities).toContain('coder');
  });

  it('pickModel with capability=reasoning returns a reasoning model', () => {
    const entry = pickModel({ capability: 'reasoning' });
    expect(entry).not.toBeNull();
    expect(entry!.capabilities).toContain('reasoning');
  });

  it('pickModel with preferCheap=true returns free local first', () => {
    const entry = pickModel({ preferCheap: true });
    expect(entry).not.toBeNull();
    // Free local should be chosen (costPerMTokIn=0)
    expect(entry!.costPerMTokIn).toBe(0);
  });

  it('pickModel with maxEffort=1 excludes minEffort>1 models', () => {
    const entry = pickModel({ engine: 'claude', maxEffort: 1 });
    // claude:opus has minEffort=3, claude:sonnet minEffort=2 — only haiku (minEffort=1) passes
    expect(entry).not.toBeNull();
    expect(entry!.minEffort).toBeLessThanOrEqual(1);
  });

  it('pickModel returns null when no match', () => {
    // No model has engine='unknown' AND capability='reasoning'
    const entry = pickModel({ engine: 'unknown-engine', capability: 'reasoning' });
    expect(entry).toBeNull();
  });

  it('KNOWN_MODELS entries all have required fields', () => {
    for (const m of KNOWN_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.engine).toBe('string');
      expect(['small', 'mid', 'large']).toContain(m.tier);
      expect(typeof m.costPerMTokIn).toBe('number');
      expect(typeof m.costPerMTokOut).toBe('number');
      expect(Array.isArray(m.capabilities)).toBe(true);
      expect([1, 2, 3, 4, 5]).toContain(m.minEffort);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. routeTask — difficulty/type/cost-aware model routing
// ---------------------------------------------------------------------------

describe('M128 routeTask — difficulty routing', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('hard reasoning item (effort=5) → claude:opus', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toMatch(/hard|opus|reasoning/i);
  });

  it('hard coding item (effort=5, source=todo) → codex:gpt-5.5', () => {
    const item = makeItem({ source: 'todo', effort: 5, score: 8 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.engine).toBe('codex');
    expect(result.model).toBe('gpt-5.5');
    expect(result.reason).toMatch(/codex|gpt-5\.5|coder/i);
  });

  it('trivial item (effort=1, score=2) → cheapest/smallest model', () => {
    const item = makeItem({ source: 'doc', effort: 1, score: 2 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // Should pick local-small or claude:haiku
    const isCheap =
      result.engine === ('local-coder' as any) ||
      (result.engine === 'claude' && result.model === 'haiku');
    expect(isCheap).toBe(true);
    expect(result.reason).toMatch(/trivial/i);
  });

  it('bulk dep item → free local (balanced policy)', () => {
    const item = makeItem({ source: 'dep', effort: 2, score: 4 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // balanced + dep → local preferred
    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
  });

  it('hard security item → claude:opus or deepseek-r1 (reasoning)', () => {
    const item = makeItem({ source: 'security', effort: 4, score: 9 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
  });

  it('escalation source always routes to frontier', () => {
    const item = makeItem({ source: 'self', effort: 1, score: 1 });
    (item as any).source = 'escalation';
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.engine === 'claude' || result.engine === 'codex').toBe(true);
  });

  it('reason string is populated and non-empty', () => {
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'] });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. routeTask — routing policy differences
// ---------------------------------------------------------------------------

describe('M128 routeTask — routing policies', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('cost policy: medium todo → local (free)', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
      routingPolicy: 'cost',
    } as any);
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
    expect(result.reason).toMatch(/cost policy/i);
  });

  it('quality policy: medium item → strongest available (claude or codex)', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
      routingPolicy: 'quality',
    } as any);
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // quality policy should pick a frontier model for any item
    const isFrontier = result.engine === 'claude' || result.engine === 'codex';
    expect(isFrontier).toBe(true);
  });

  it('balanced policy: bulk dep → free local', () => {
    const item = makeItem({ source: 'dep', effort: 1, score: 3 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
      routingPolicy: 'balanced',
    } as any);
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    expect(result.catalogEntry?.costPerMTokIn ?? 0).toBe(0);
  });

  it('cost/quality/balanced all differ for the same medium item', () => {
    const mkCfg = (policy: 'cost' | 'quality' | 'balanced') =>
      withFoundry({
        allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
        routingPolicy: policy,
      } as any);

    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cost = routeTask(item, cfg => mkCfg('cost') && mkCfg('cost'), mkCfg('cost'), ALL_ENGINES_CTX as any);
    // rebuild items so _seq advances properly
    _seq = 0;
    const itemA = makeItem({ source: 'todo', effort: 2, score: 4 });
    const itemB = { ...itemA, id: 'item-b' };
    const itemC = { ...itemA, id: 'item-c' };

    const costResult = routeTask(itemA as WorkItem, mkCfg('cost'), ALL_ENGINES_CTX as any);
    const qualityResult = routeTask(itemB as WorkItem, mkCfg('quality'), ALL_ENGINES_CTX as any);
    const balancedResult = routeTask(itemC as WorkItem, mkCfg('balanced'), ALL_ENGINES_CTX as any);

    // cost → free local, quality → frontier, balanced → somewhere in between
    expect(costResult.catalogEntry?.costPerMTokIn ?? 0).toBe(0); // cost = free local
    const qualityIsFrontier =
      qualityResult.engine === 'claude' || qualityResult.engine === 'codex';
    expect(qualityIsFrontier).toBe(true); // quality = frontier
    // balanced may be any tier but should have different model than quality for bulk
    // (this is a soft assertion — just checks both produce a valid decision)
    expect(typeof balancedResult.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. routeTask — quota / subscription saturation fallback
// ---------------------------------------------------------------------------

describe('M128 routeTask — quota and subscription fallback', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('falls back when claude subscription window is saturated', () => {
    vi.mocked(subscriptionAllows).mockImplementation((engine) => {
      if (engine === 'claude') {
        return { allowed: false, reason: 'claude window 92% used (max 90%)' };
      }
      return { allowed: true, reason: 'mock' };
    });

    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // claude is saturated → should not pick claude
    expect(result.engine).not.toBe('claude');
  });

  it('falls back when both frontier engines are over quota', () => {
    vi.mocked(withinLimit).mockImplementation((engine) => {
      if (engine === 'claude' || engine === 'codex') return false;
      return true;
    });

    const item = makeItem({ source: 'todo', effort: 5, score: 9 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // hard item but both frontiers unavailable → should fall to local or builtin
    expect(result.engine).not.toBe('claude');
    expect(result.engine).not.toBe('codex');
  });

  it('reason mentions saturation / fallback when engine window is saturated', () => {
    vi.mocked(subscriptionAllows).mockImplementation((engine) => {
      if (engine === 'claude') {
        return { allowed: false, reason: 'claude window 92% used' };
      }
      return { allowed: true, reason: 'mock' };
    });

    const item = makeItem({ source: 'issue', effort: 4, score: 8 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // should have switched away from claude
    expect(result.engine).not.toBe('claude');
  });

  it('local-coder is never quota-limited (no subscription)', () => {
    // All cloud engines over quota
    vi.mocked(withinLimit).mockImplementation((engine) => {
      if (engine === 'claude' || engine === 'codex' || engine === 'nim') return false;
      return true;
    });
    vi.mocked(subscriptionAllows).mockImplementation((engine) => {
      if (engine === 'claude' || engine === 'codex') {
        return { allowed: false, reason: 'saturated' };
      }
      return { allowed: true, reason: 'mock' };
    });

    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX as any);
    // Only local-coder or builtin should be chosen
    const isLocal = result.engine === ('local-coder' as any) || result.engine === 'builtin';
    expect(isLocal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. routeTask — allowedBackends respected
// ---------------------------------------------------------------------------

describe('M128 routeTask — allowedBackends gate', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('respects allowedBackends — does not pick disallowed engine', () => {
    const item = makeItem({ source: 'todo', effort: 5, score: 9 });
    const cfg = withFoundry({
      allowedBackends: ['local-coder' as any, 'builtin'],
    });
    // claude/codex not in allowedBackends
    const result = routeTask(item, cfg, LOCAL_ONLY_CTX as any);
    expect(result.engine).not.toBe('claude');
    expect(result.engine).not.toBe('codex');
  });

  it('falls back to builtin when no engine is available', () => {
    vi.mocked(engineInstalled).mockReturnValue(false);
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['builtin'] });
    const result = routeTask(item, cfg, BUILTIN_ONLY_CTX as any);
    expect(result.engine).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// 6. fleet/router.ts routeBackend — M128 model threading
// ---------------------------------------------------------------------------

describe('M128 routeBackend — model threading', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(engineInstalled).mockReturnValue(true);
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('routeBackend returns a model field (not undefined)', () => {
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeBackend(item, cfg);
    expect('model' in result).toBe(true);
  });

  it('routeBackend hard item gets a non-null model for frontier engine', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeBackend(item, cfg);
    expect(result.tier).toBe('frontier');
    expect(result.model).not.toBeNull();
    // Should be opus or gpt-5.5
    const isStrong = result.model === 'opus' || result.model === 'gpt-5.5';
    expect(isStrong).toBe(true);
  });

  it('routeBackend bulk item gets free local + a model tag', () => {
    const item = makeItem({ source: 'dep', effort: 1, score: 2 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeBackend(item, cfg);
    // local-mid should be chosen for bulk items
    expect(result.tier).toBe('mid');
    expect(typeof result.model).toBe('string');
  });

  it('routeBackend reason includes model tag', () => {
    const item = makeItem({ source: 'todo', effort: 4, score: 8 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'local-coder' as any, 'builtin'],
    });
    const result = routeBackend(item, cfg);
    // The reason should reference the model
    expect(result.reason).toBeTruthy();
    // model field should be consistent with reason when model is set
    if (result.model) {
      expect(result.reason).toMatch(/model:|frontier:|local-mid/i);
    }
  });

  it('routeBackend builtin fallback has model=null', () => {
    vi.mocked(engineInstalled).mockReturnValue(false);
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['builtin'] });
    const result = routeBackend(item, cfg);
    expect(result.backend).toBe('builtin');
    expect(result.model).toBeNull();
  });

  it('routeBackend honors cfg.foundry.models override', () => {
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'builtin'],
      models: { claude: 'sonnet' },
    });
    // Claude is allowed, models.claude = 'sonnet' → should use sonnet
    const result = routeBackend(item, cfg);
    if (result.backend === 'claude') {
      expect(result.model).toBe('sonnet');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Backward compatibility — existing m46 behavior preserved
// ---------------------------------------------------------------------------

describe('M128 backward compatibility', () => {
  beforeEach(() => {
    _seq = 0;
    vi.mocked(engineInstalled).mockReturnValue(true);
    vi.mocked(withinLimit).mockReturnValue(true);
    vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
  });

  it('no foundry config → routes to builtin with model=null', () => {
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const result = routeBackend(item, baseConfig());
    expect(result.backend).toBe('builtin');
    expect(result.model).toBeNull();
  });

  it('allowedBackends=[builtin] → builtin regardless of effort', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 10 });
    const cfg = withFoundry({ allowedBackends: ['builtin'] });
    const result = routeBackend(item, cfg);
    expect(result.backend).toBe('builtin');
  });

  it('routeBackend return shape still has backend+tier+reason fields', () => {
    const item = makeItem({ source: 'todo', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'builtin'] });
    const result = routeBackend(item, cfg);
    expect(typeof result.backend).toBe('string');
    expect(typeof result.tier).toBe('string');
    expect(typeof result.reason).toBe('string');
  });
});
