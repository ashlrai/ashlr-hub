/**
 * test/m182.routebackend-frontier.test.ts — M182: routeBackend substantive→frontier
 * under quality policy.
 *
 * Proves the following invariants:
 *
 *  1. QUALITY+SUBSTANTIVE→FRONTIER: under routingPolicy='quality', a goal/issue/
 *     security/invent item (low effort, low score — NOT hard by M115 thresholds)
 *     routes to a FRONTIER engine (claude or codex), NOT local-coder.
 *
 *  2. QUALITY+TRIVIAL→LOCAL-MID: a trivial dep/lint/hygiene item (effort=1,
 *     score=2) under quality policy still routes local-mid — frontier is for
 *     substantive + hard only.
 *
 *  3. COST-POLICY PARITY: under routingPolicy='cost' (or absent policy), a
 *     goal/issue/security/invent item with low effort/score does NOT route to
 *     frontier (parity with pre-M182 behavior — substantive widening is
 *     quality-policy-only).
 *
 *  4. HARD-ITEMS ALWAYS FRONTIER: isFrontierItem hard items (effort>=4 or
 *     score>=8) still route frontier under any policy (M115 unchanged).
 *
 *  5. INVENT IS SUBSTANTIVE: source='invent' (M181) is in SUBSTANTIVE_SOURCES
 *     and routes frontier under quality policy.
 *
 *  6. BUILTIN FALLBACK: when no frontier AND no mid is allowed+installed,
 *     routeBackend returns backend='builtin' (tier='local') regardless of policy.
 *
 *  7. REASON STRING: quality-policy substantive routes include 'quality policy'
 *     in the reason; cost-policy routes do not.
 *
 * Mirrors m115/m164/m128 conventions: baseConfig()+withFoundry(), makeItem(),
 * vi.mock() for engines/quota/subscription.
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
import { routeBackend } from '../src/core/fleet/router.js';
import { SUBSTANTIVE_SOURCES } from '../src/core/run/router.js';
import { engineInstalled } from '../src/core/run/engines.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors m115/m128/m164 conventions)
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: 'http://localhost:11434', providerChain: [] },
  } as unknown as AshlrConfig;
}

function withFoundry(foundry: NonNullable<AshlrConfig['foundry']>): AshlrConfig {
  return { ...baseConfig(), foundry } as AshlrConfig;
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
    effort: 2,  // deliberately LOW — NOT hard by M115 thresholds
    score: 4,   // deliberately LOW — NOT hard by M115 thresholds
    tags: [],
    ts: new Date().toISOString(),
    ...over,
  };
}

/** Frontier-tier engine ids. */
const FRONTIER_ENGINES = new Set(['claude', 'codex']);

function isFrontierBackend(backend: string): boolean {
  return FRONTIER_ENGINES.has(backend);
}

/** Config with both frontier (claude+codex) and mid (local-coder) available. */
function qualityCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'],
    routingPolicy: 'quality',
  });
}

function costCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'],
    routingPolicy: 'cost',
  });
}

function noPolicyCfg(): AshlrConfig {
  return withFoundry({
    allowedBackends: ['claude', 'codex', 'local-coder', 'builtin'],
    // no routingPolicy
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(engineInstalled).mockReturnValue(true);
});

describe('M182 routeBackend — quality policy substantive→frontier', () => {

  // ── 1. Quality + substantive → frontier ─────────────────────────────────

  it('routes goal to frontier under quality policy (low effort+score)', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('routes issue to frontier under quality policy (low effort+score)', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('routes security to frontier under quality policy (low effort+score)', () => {
    const item = makeItem({ source: 'security' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('routes feature to frontier under quality policy (low effort+score)', () => {
    const item = makeItem({ source: 'feature' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  // ── 5. invent is substantive ─────────────────────────────────────────────

  it('routes invent to frontier under quality policy (M181 — invent in SUBSTANTIVE_SOURCES)', () => {
    expect(SUBSTANTIVE_SOURCES.has('invent')).toBe(true);
    const item = makeItem({ source: 'invent' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  // ── 2. Quality + trivial bulk → local-mid ────────────────────────────────

  it('routes dep item to local-mid under quality policy (trivial, not substantive)', () => {
    const item = makeItem({ source: 'dep' as WorkSource, effort: 1, score: 2 });
    const d = routeBackend(item, qualityCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('routes lint item to local-mid under quality policy', () => {
    const item = makeItem({ source: 'lint' as WorkSource, effort: 1, score: 2 });
    const d = routeBackend(item, qualityCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('routes hygiene item to local-mid under quality policy', () => {
    const item = makeItem({ source: 'hygiene' as WorkSource, effort: 1, score: 2 });
    const d = routeBackend(item, qualityCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('routes docs item to local-mid under quality policy', () => {
    const item = makeItem({ source: 'docs' as WorkSource, effort: 1, score: 2 });
    const d = routeBackend(item, qualityCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  // ── 3. Cost-policy parity — substantive stays local-mid ──────────────────

  it('cost policy: goal with low effort/score → local-mid (NOT frontier)', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, costCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('cost policy: issue with low effort/score → local-mid (NOT frontier)', () => {
    const item = makeItem({ source: 'issue' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, costCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('cost policy: invent with low effort/score → local-mid (NOT frontier)', () => {
    const item = makeItem({ source: 'invent' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, costCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  it('no routingPolicy: goal with low effort/score → local-mid (NOT frontier)', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, noPolicyCfg());
    expect(d.backend).toBe('local-coder');
    expect(d.tier).toBe('mid');
  });

  // ── 4. Hard items always frontier regardless of policy ────────────────────

  it('hard item (effort=4) → frontier under cost policy (M115 unchanged)', () => {
    const item = makeItem({ source: 'todo' as WorkSource, effort: 4, score: 5 });
    const d = routeBackend(item, costCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('high-score item (score=8) → frontier under cost policy (M115 unchanged)', () => {
    const item = makeItem({ source: 'dep' as WorkSource, effort: 2, score: 8 });
    const d = routeBackend(item, costCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('escalation source → frontier under cost policy (M115 unchanged)', () => {
    const item = makeItem({ source: 'escalation' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, costCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  it('hard item (effort=5) → frontier under quality policy (M115 still applies)', () => {
    const item = makeItem({ source: 'dep' as WorkSource, effort: 5, score: 5 });
    const d = routeBackend(item, qualityCfg());
    expect(isFrontierBackend(d.backend)).toBe(true);
    expect(d.tier).toBe('frontier');
  });

  // ── 6. Builtin fallback ───────────────────────────────────────────────────

  it('returns builtin when no frontier or mid is allowed+installed', () => {
    // Only builtin allowed
    const cfg = withFoundry({
      allowedBackends: ['builtin'],
      routingPolicy: 'quality',
    });
    const item = makeItem({ source: 'goal' as WorkSource });
    const d = routeBackend(item, cfg);
    expect(d.backend).toBe('builtin');
    expect(d.tier).toBe('local');
  });

  it('returns builtin when all external engines fail engineInstalled', () => {
    vi.mocked(engineInstalled).mockReturnValue(false);
    const item = makeItem({ source: 'goal' as WorkSource });
    const d = routeBackend(item, qualityCfg());
    expect(d.backend).toBe('builtin');
    expect(d.tier).toBe('local');
  });

  // ── 7. Reason string ─────────────────────────────────────────────────────

  it('quality-policy substantive reason includes "quality policy"', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, qualityCfg());
    expect(d.reason).toMatch(/quality policy/i);
  });

  it('cost-policy route reason does NOT include "quality policy"', () => {
    const item = makeItem({ source: 'goal' as WorkSource, effort: 2, score: 4 });
    const d = routeBackend(item, costCfg());
    expect(d.reason).not.toMatch(/quality policy/i);
  });

  it('hard-item reason (even under quality) uses the hard-item reason format', () => {
    // Hard items (isFrontierItem) take the non-substantive reason branch
    const item = makeItem({ source: 'dep' as WorkSource, effort: 4, score: 5 });
    const d = routeBackend(item, qualityCfg());
    expect(d.reason).toMatch(/frontier/i);
    // Hard items get hard/escalation reason format, not quality-policy format
    expect(d.reason).toMatch(/effort|score|escalation/i);
  });
});

describe('M182 SUBSTANTIVE_SOURCES export', () => {
  it('SUBSTANTIVE_SOURCES is exported from run/router.ts', () => {
    expect(SUBSTANTIVE_SOURCES).toBeDefined();
    expect(SUBSTANTIVE_SOURCES instanceof Set).toBe(true);
  });

  it('SUBSTANTIVE_SOURCES contains goal, issue, security, feature, invent', () => {
    expect(SUBSTANTIVE_SOURCES.has('goal')).toBe(true);
    expect(SUBSTANTIVE_SOURCES.has('issue')).toBe(true);
    expect(SUBSTANTIVE_SOURCES.has('security')).toBe(true);
    expect(SUBSTANTIVE_SOURCES.has('feature')).toBe(true);
    expect(SUBSTANTIVE_SOURCES.has('invent')).toBe(true);
  });

  it('SUBSTANTIVE_SOURCES does NOT contain trivial sources', () => {
    expect(SUBSTANTIVE_SOURCES.has('dep')).toBe(false);
    expect(SUBSTANTIVE_SOURCES.has('lint')).toBe(false);
    expect(SUBSTANTIVE_SOURCES.has('hygiene')).toBe(false);
    expect(SUBSTANTIVE_SOURCES.has('docs')).toBe(false);
    expect(SUBSTANTIVE_SOURCES.has('todo')).toBe(false);
  });
});
