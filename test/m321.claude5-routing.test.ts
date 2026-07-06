/**
 * m321.claude5-routing.test.ts — M321: Sonnet 5 workhorse routing.
 *
 * Default-on behavior of the Claude 5 rollout inside routeTask:
 *  - hard/medium claude picks route to claude-sonnet-5 (frontier quality,
 *    cheapest-large) and dispatch the FULL API id (bare 'sonnet-5' is not a
 *    documented CLI alias);
 *  - quality-policy substantive fast-path routes to claude-fable-5 (fable on)
 *    or claude-opus-4-8 (fable off) — Sonnet 5 never shadows the strong pick;
 *  - cost policy escalates local → nim → sonnet-5, never opus;
 *  - claude5.enabled:false reproduces the pre-M321 decisions byte-identically
 *    (the m128/m164/m155 suites remain the full parity baselines);
 *  - cfg.foundry.models overrides still win; trivial path unchanged.
 *
 * Mirrors m128 conventions: baseConfig()+withFoundry(), makeItem(), vi.mock
 * for engineInstalled / quota / subscription.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Imports under test
// ---------------------------------------------------------------------------

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import { routeTask } from '../src/core/run/router.js';
import { withinLimit } from '../src/core/fleet/quota.js';
import { subscriptionAllows } from '../src/core/fleet/subscription-usage.js';

// ---------------------------------------------------------------------------
// Helpers (m128 conventions)
// ---------------------------------------------------------------------------

const roots = ['/tmp'];
const editor = { name: 'vscode' as const };

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots,
    editor,
    models: { providerChain: ['ollama'], routing: [] },
  } as unknown as AshlrConfig;
}

/** Foundry cfg with claude5 at its DEFAULT (on) unless overridden. */
function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry } as AshlrConfig;
}

const ALL_BACKENDS = ['claude', 'codex', 'local-coder', 'nim', 'builtin'] as never[];

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
  } as WorkItem;
}

const ALL_ENGINES_CTX = {
  availableEngines: ['claude', 'codex', 'local-coder', 'nim', 'builtin'],
} as never;
const CLAUDE_ONLY_CTX = {
  availableEngines: ['claude', 'builtin'],
} as never;

beforeEach(() => {
  _seq = 0;
  vi.mocked(withinLimit).mockReturnValue(true);
  vi.mocked(subscriptionAllows).mockReturnValue({ allowed: true, reason: 'mock' });
});

// ---------------------------------------------------------------------------
// Default-on: Sonnet 5 workhorse
// ---------------------------------------------------------------------------

describe('M321 Sonnet 5 workhorse (claude5 default on)', () => {
  it('hard reasoning item → claude with FULL id claude-sonnet-5', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const cfg = withFoundry({ allowedBackends: ALL_BACKENDS });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.catalogEntry?.id).toBe('claude:sonnet-5');
  });

  it('hard coding item with codex unavailable → claude-sonnet-5', () => {
    const item = makeItem({ source: 'todo', effort: 5, score: 8 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'builtin'] as never[] });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-sonnet-5');
  });

  it('balanced medium (claude only) → claude-sonnet-5, not legacy sonnet', () => {
    const item = makeItem({ source: 'feature', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'builtin'] as never[] });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).toContain('sonnet-5');
  });

  it('cost policy medium escalates local → sonnet-5, never opus', () => {
    const item = makeItem({ source: 'feature', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'builtin'] as never[],
      routingPolicy: 'cost',
    });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.reason).toMatch(/cost policy/i);
  });

  it('trivial item unchanged → local-small or haiku', () => {
    const item = makeItem({ source: 'doc', effort: 1, score: 2 });
    const cfg = withFoundry({ allowedBackends: ALL_BACKENDS });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    const isCheap =
      String(result.engine) === 'local-coder' ||
      (result.engine === 'claude' && result.model === 'haiku');
    expect(isCheap).toBe(true);
  });

  it('cfg.foundry.models override still wins over sonnet-5', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'builtin'] as never[],
      models: { claude: 'opus' } as never,
    });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toContain('cfg override');
  });
});

// ---------------------------------------------------------------------------
// Quality policy: Fable 5 / Opus on the strong path
// ---------------------------------------------------------------------------

describe('M321 quality fast-path (preferStrong)', () => {
  it('substantive issue on quality policy → claude-fable-5 (fable default on)', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 6 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as never[],
      routingPolicy: 'quality',
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('claude-fable-5');
    expect(result.reason).toMatch(/quality policy/i);
    expect(result.reason).toContain('fable-5');
  });

  it('substantive issue with fable:false → opus (Sonnet 5 never shadows it)', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 6 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as never[],
      routingPolicy: 'quality',
      claude5: { fable: false },
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toContain('opus');
  });

  it('implementation-heavy substantive (feature) still prefers codex gpt-5.5', () => {
    const item = makeItem({ source: 'feature', effort: 4, score: 8 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as never[],
      routingPolicy: 'quality',
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    // preferredFrontierEngine for implementation-heavy sources is codex
    if (result.engine === 'codex') {
      expect(result.model).toBe('gpt-5.5');
    } else {
      // claude fallback path — must be the strong pick, not sonnet-5
      expect(['claude-fable-5', 'opus']).toContain(result.model);
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback parity: claude5.enabled:false === pre-M321
// ---------------------------------------------------------------------------

describe('M321 rollback parity (claude5.enabled:false)', () => {
  const off = { claude5: { enabled: false } };

  it('hard reasoning → opus (pre-M321)', () => {
    const item = makeItem({ source: 'issue', effort: 5, score: 9 });
    const cfg = withFoundry({ allowedBackends: ALL_BACKENDS, ...off });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
  });

  it('balanced medium → legacy sonnet tag (pre-M321)', () => {
    const item = makeItem({ source: 'feature', effort: 3, score: 5 });
    const cfg = withFoundry({ allowedBackends: ['claude', 'builtin'] as never[], ...off });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('sonnet');
    expect(result.reason).toContain('claude:sonnet (balanced medium)');
  });

  it('quality substantive → opus with pre-M321 reason label', () => {
    const item = makeItem({ source: 'issue', effort: 3, score: 6 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'codex', 'builtin'] as never[],
      routingPolicy: 'quality',
      ...off,
    });
    const result = routeTask(item, cfg, ALL_ENGINES_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('opus');
    expect(result.reason).toContain('opus (reasoning/architecture)');
  });

  it('cost policy medium → legacy sonnet (pre-M321)', () => {
    const item = makeItem({ source: 'feature', effort: 3, score: 5 });
    const cfg = withFoundry({
      allowedBackends: ['claude', 'builtin'] as never[],
      routingPolicy: 'cost',
      ...off,
    });
    const result = routeTask(item, cfg, CLAUDE_ONLY_CTX);
    expect(result.engine).toBe('claude');
    expect(result.model).toBe('sonnet');
  });
});
