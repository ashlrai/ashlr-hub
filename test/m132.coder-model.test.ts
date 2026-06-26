/**
 * m132.coder-model.test.ts — M132: qwen2.5-coder:32b verified as local coding model.
 *
 * FINDING (live-tested 2026-06-26 with CODER_LIVE=1 on m118):
 *   qwen2.5-coder:32b emits tool calls as JSON in message.content with
 *   finish_reason='stop' (NOT in the structured tool_calls field). M118's
 *   parseContentToolCalls() synthesizes toolCalls from content, so the
 *   agent-loop now executes them and produces real diffs.
 *
 *   Live evidence: `[M118 live] parsed tool call: read_file {"path":"/real.ts"}`
 *   All 25 m118 tests pass with CODER_LIVE=1 (165 ms total).
 *
 * WIRING DECISION:
 *   NO change to router.ts / engine-registry.ts / model-catalog.ts required.
 *   The router already routes correctly:
 *
 *   routeTask (balanced policy, cap='coder'):
 *     tryEngine('local-coder', 'coder', ...) →
 *     pickModel({engine:'local-coder', capability:'coder'}) →
 *     qwen2.5-coder:32b  ← only local-coder entry with capabilities:['coder']
 *
    *   The 72b (capabilities:['general','long-context'] after M132) is preferred
 *   for hard/general tasks where tier:large wins (no capability filter or 'general').
 *   deepseek-r1:32b owns 'reasoning'. coder:32b owns 'coder'.
 *
 *   To override at the operator level:
 *     cfg.foundry.models['local-coder'] = 'qwen2.5-coder:32b'
 *   This is wired in router.ts:317 (tryEngine checks cfg.foundry.models first).
 *
 * TEST GROUPS:
 *   1. Catalog shape — coder:32b has the right capability/tier/engine
 *   2. pickModel routing — coder:32b wins for coder tasks (preferCheap=false)
 *   3. pickModel routing — 72b wins for general/reasoning tasks (tier:large > mid)
 *   4. routeTask wiring — balanced + coder source → model='qwen2.5-coder:32b'
 *   5. cfg.foundry.models override — operator can force coder:32b for all local tasks
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pickModel, KNOWN_MODELS } from '../src/core/run/model-catalog.js';
import { routeTask } from '../src/core/run/router.js';
import type { AshlrConfig, WorkItem } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mocks — engines.js + quota + subscription (mirrors m128 pattern)
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn().mockReturnValue(true),
}));
vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn().mockReturnValue(true),
}));
vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn().mockReturnValue({ allowed: true }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: `item-${++_seq}`,
    source: 'todo',
    goal: 'test task',
    effort: 2,
    score: 4,
    repoPath: '/tmp/repo',
    ...overrides,
  } as WorkItem;
}

function baseConfig(): AshlrConfig {
  return {
    models: { providerChain: ['ollama'], routing: [] },
    foundry: {
      allowedBackends: ['local-coder', 'claude', 'builtin'],
    },
  } as unknown as AshlrConfig;
}

function withFoundry(overrides: Record<string, unknown>): AshlrConfig {
  const cfg = baseConfig();
  Object.assign(cfg.foundry as Record<string, unknown>, overrides);
  return cfg;
}

const CTX_LOCAL_ONLY = { availableEngines: ['local-coder', 'builtin'] as never[] };
const CTX_WITH_CLAUDE = { availableEngines: ['local-coder', 'claude', 'builtin'] as never[] };

// ---------------------------------------------------------------------------
// 1. Catalog shape
// ---------------------------------------------------------------------------

describe('M132 catalog — qwen2.5-coder:32b entry', () => {
  it('exists in KNOWN_MODELS', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b');
    expect(entry).toBeDefined();
  });

  it('has engine=local-coder', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b')!;
    expect(entry.engine).toBe('local-coder');
  });

  it('has tier=mid (faster/cheaper than 72b large)', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b')!;
    expect(entry.tier).toBe('mid');
  });

  it('has capabilities=[coder] — specialist, not general', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b')!;
    expect(entry.capabilities).toContain('coder');
    expect(entry.capabilities).not.toContain('general');
    expect(entry.capabilities).not.toContain('reasoning');
  });

  it('has minEffort=1 (handles all task difficulties)', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b')!;
    expect(entry.minEffort).toBe(1);
  });

  it('is free (costPerMTokIn=0, costPerMTokOut=0)', () => {
    const entry = KNOWN_MODELS.find((m) => m.id === 'local-coder:qwen2.5-coder:32b')!;
    expect(entry.costPerMTokIn).toBe(0);
    expect(entry.costPerMTokOut).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. pickModel — coder:32b wins for coder tasks on local-coder
// ---------------------------------------------------------------------------

describe('M132 pickModel — coder:32b selected for coder tasks', () => {
  it('pickModel({engine:local-coder, capability:coder}) → coder:32b (sole coder specialist)', () => {
    // After M132: 72b no longer has 'coder' capability → coder:32b is the only match
    const entry = pickModel({ engine: 'local-coder', capability: 'coder' });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('local-coder:qwen2.5-coder:32b');
  });

  it('pickModel with preferCheap=true still picks coder:32b for coder (only match)', () => {
    const entry = pickModel({ engine: 'local-coder', capability: 'coder', preferCheap: true });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('local-coder:qwen2.5-coder:32b');
  });

  it('pickModel({engine:local-coder, capability:coder, maxEffort:1}) → coder:32b (minEffort=1)', () => {
    const entry = pickModel({ engine: 'local-coder', capability: 'coder', maxEffort: 1 });
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe('local-coder:qwen2.5-coder:32b');
  });
});

// ---------------------------------------------------------------------------
// 3. pickModel — 72b wins for general/reasoning (tier:large > mid)
// ---------------------------------------------------------------------------

describe('M132 pickModel — 72b preferred for general/reasoning', () => {
  it('pickModel({engine:local-coder, capability:general}) → 72b (only general entry)', () => {
    const entry = pickModel({ engine: 'local-coder', capability: 'general' });
    expect(entry).not.toBeNull();
    // coder:32b has no 'general' capability → 72b is the only match
    expect(entry!.id).toBe('local-coder:qwen2.5:72b');
  });

  it('pickModel({engine:local-coder, capability:reasoning}) → deepseek-r1:32b (only reasoning entry after M132)', () => {
    const entry = pickModel({ engine: 'local-coder', capability: 'reasoning' });
    expect(entry).not.toBeNull();
    // After M132: 72b lost 'coder' but retains 'general'/'long-context', NOT 'reasoning'.
    // deepseek-r1:32b is the only local-coder entry with 'reasoning'.
    expect(entry!.id).toBe('local-coder:deepseek-r1:32b');
  });

  it('pickModel({engine:local-coder}) no capability filter → 72b wins (tier:large)', () => {
    const entry = pickModel({ engine: 'local-coder' });
    expect(entry).not.toBeNull();
    // Without capability filter, all local-coder entries compete; 72b is tier:large
    expect(entry!.id).toBe('local-coder:qwen2.5:72b');
  });
});

// ---------------------------------------------------------------------------
// 4. routeTask wiring — balanced + coder source → coder:32b
// ---------------------------------------------------------------------------

describe('M132 routeTask — balanced policy routes coding tasks to coder:32b', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('todo source (effort 2) → local-coder:qwen2.5-coder:32b in balanced mode', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cfg = withFoundry({ routingPolicy: 'balanced' });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    expect(result.model).toBe('qwen2.5-coder:32b');
    expect(result.catalogEntry?.id).toBe('local-coder:qwen2.5-coder:32b');
  });

  it('lint source (effort 2) → local-coder:qwen2.5-coder:32b in balanced mode', () => {
    const item = makeItem({ source: 'lint', effort: 2, score: 3 });
    const cfg = withFoundry({ routingPolicy: 'balanced' });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    expect(result.model).toBe('qwen2.5-coder:32b');
  });

  it('reason string mentions coder:32b for bulk coding path', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cfg = withFoundry({ routingPolicy: 'balanced' });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.reason).toMatch(/coder/i);
  });

  it('hard todo (effort 4) → NOT coder:32b (hard path uses 72b general fallback)', () => {
    const item = makeItem({ source: 'todo', effort: 4, score: 9 });
    const cfg = withFoundry({ routingPolicy: 'balanced' });
    // With only local-coder available: hard path falls back to local 72b.
    // modelTagFrom strips 'local-coder:' prefix: 'local-coder:qwen2.5:72b' → 'qwen2.5:72b'
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    expect(result.model).toBe('qwen2.5:72b');
  });

  it('issue source (reasoning) → deepseek-r1:32b (sole reasoning specialist after M132)', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 6 });
    const cfg = withFoundry({ routingPolicy: 'balanced' });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    // issue → reasoning cap → deepseek-r1:32b (only local-coder entry with 'reasoning')
    expect(result.model).toBe('deepseek-r1:32b');
    expect(result.model).not.toBe('qwen2.5-coder:32b');
  });
});

// ---------------------------------------------------------------------------
// 5. cfg.foundry.models override — operator forces coder:32b for all local tasks
// ---------------------------------------------------------------------------

describe('M132 cfg.foundry.models override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('models["local-coder"]="qwen2.5-coder:32b" overrides even non-coder tasks', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 6 });
    const cfg = withFoundry({
      routingPolicy: 'balanced',
      models: { 'local-coder': 'qwen2.5-coder:32b' },
    });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    expect(result.model).toBe('qwen2.5-coder:32b');
    expect(result.reason).toMatch(/cfg override/i);
  });

  it('models["local-coder"]="qwen2.5-coder:32b" override respected for todo source', () => {
    const item = makeItem({ source: 'todo', effort: 2, score: 4 });
    const cfg = withFoundry({
      models: { 'local-coder': 'qwen2.5-coder:32b' },
    });
    const result = routeTask(item, cfg, CTX_LOCAL_ONLY);
    expect(result.engine).toBe('local-coder');
    expect(result.model).toBe('qwen2.5-coder:32b');
  });

  it('override does not affect claude routing when claude is available', () => {
    const item = makeItem({ source: 'todo', effort: 4, score: 9 });
    const cfg = withFoundry({
      routingPolicy: 'balanced',
      models: { 'local-coder': 'qwen2.5-coder:32b' },
    });
    // Hard todo with claude available → tries codex then claude before local fallback
    const result = routeTask(item, cfg, CTX_WITH_CLAUDE);
    // Claude is available and hard → claude:opus (hard coder path after codex fails)
    expect(result.engine).toBe('claude');
  });
});
