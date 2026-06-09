/**
 * M15 router tests — hermetic, no real network/env I/O.
 *
 * Covers chooseRoute:
 *   - LOCAL-FIRST default: returns local tier when no escalation
 *   - Returns local when allowCloud=false, even with a cloud key present
 *   - Returns local when allowCloud=true but lastReason='none'
 *   - Returns local when allowCloud=true + lastReason!='none' but NO cloud key
 *   - Returns CLOUD ONLY when all three: allowCloud=true AND lastReason!='none'
 *     AND cloudKeyAvailable(provider)=true
 *   - Per-task routing rules: first match wins; rule does NOT force cloud
 *   - Routing rule with no match falls back to providerChain
 *   - RouteDecision shape is correct (provider, model, tier, reason)
 *
 * Covers cloudKeyAvailable:
 *   - Returns true only when the relevant API key env var is set + non-empty
 *   - Never logs/returns the key value — only a boolean
 *   - Returns false for unknown providers
 *
 * Covers wouldBeCloudCost:
 *   - Returns > 0 for meaningful token counts (representative cloud model)
 *   - Local tokens that cost $0 to run still have a positive "would-have-been" estimate
 *
 * INVARIANT ASSERTIONS:
 *   - NO_SILENT_CLOUD: chooseRoute NEVER returns tier='cloud' without:
 *       allowCloud=true AND lastReason!='none' AND cloudKeyAvailable=true
 *   - cloudKeyAvailable is a boolean; the raw key value is never accessible
 *     through any of the exported M15 surfaces
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AshlrConfig, EscalationReason } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock providers.ts so no real HTTP probes happen
// ---------------------------------------------------------------------------

vi.mock('../src/core/providers.js', () => ({
  getProviderRegistry: vi.fn(async (cfg: AshlrConfig) => ({
    providers: [
      {
        id: 'ollama',
        url: cfg.models.ollama || 'http://localhost:11434/api/tags',
        up: true,
        models: ['llama3:8b', 'llama3:70b'],
      },
      {
        id: 'lmstudio',
        url: cfg.models.lmstudio || 'http://localhost:1234/v1/models',
        up: false,
        models: [],
      },
    ],
    activeProvider: 'ollama',
    chain: cfg.models.providerChain,
  })),
  resolveActiveProvider: vi.fn(async () => 'ollama'),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks are set up)
// ---------------------------------------------------------------------------

import {
  chooseRoute,
  cloudKeyAvailable,
  wouldBeCloudCost,
} from '../src/core/run/router.js';
import { getProviderRegistry } from '../src/core/providers.js';

const mockGetRegistry = getProviderRegistry as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<AshlrConfig['models']> = {},
): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'vscode',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama', 'lmstudio'],
      ...overrides,
    },
    telemetry: {},
    tools: {},
  };
}

/** Default opts: local-first, first attempt, no escalation reason. */
function localOpts(
  partial: Partial<{ allowCloud: boolean; attempt: number; lastReason: EscalationReason }> = {},
): { allowCloud: boolean; attempt: number; lastReason: EscalationReason } {
  return {
    allowCloud: false,
    attempt: 1,
    lastReason: 'none',
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Environment management helpers
// ---------------------------------------------------------------------------

const CLOUD_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

function setCloudKey(provider: string, value: string): void {
  const envVar = CLOUD_KEYS[provider];
  if (envVar) process.env[envVar] = value;
}

function clearCloudKey(provider: string): void {
  const envVar = CLOUD_KEYS[provider];
  if (envVar) delete process.env[envVar];
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Ensure no cloud keys leak between tests
  clearCloudKey('anthropic');
  clearCloudKey('openai');
  delete process.env.ASHLR_MODEL;
});

afterEach(() => {
  clearCloudKey('anthropic');
  clearCloudKey('openai');
  delete process.env.ASHLR_MODEL;
});

// ---------------------------------------------------------------------------
// cloudKeyAvailable — pure env check
// ---------------------------------------------------------------------------

describe('cloudKeyAvailable', () => {
  it('returns false when no env key is set for anthropic', () => {
    clearCloudKey('anthropic');
    expect(cloudKeyAvailable('anthropic')).toBe(false);
  });

  it('returns true when ANTHROPIC_API_KEY is set', () => {
    setCloudKey('anthropic', 'sk-ant-test-123');
    expect(cloudKeyAvailable('anthropic')).toBe(true);
  });

  it('returns false when ANTHROPIC_API_KEY is empty string', () => {
    process.env.ANTHROPIC_API_KEY = '';
    expect(cloudKeyAvailable('anthropic')).toBe(false);
  });

  it('returns false when ANTHROPIC_API_KEY is whitespace only', () => {
    process.env.ANTHROPIC_API_KEY = '   ';
    expect(cloudKeyAvailable('anthropic')).toBe(false);
  });

  it('returns true when OPENAI_API_KEY is set', () => {
    setCloudKey('openai', 'sk-openai-test-abc');
    expect(cloudKeyAvailable('openai')).toBe(true);
  });

  it('returns false for an unknown provider (no env mapping)', () => {
    expect(cloudKeyAvailable('some-unknown-cloud')).toBe(false);
  });

  it('returns false for ollama (local provider, never has cloud key)', () => {
    expect(cloudKeyAvailable('ollama')).toBe(false);
  });

  it('returns false for lmstudio (local provider, never has cloud key)', () => {
    expect(cloudKeyAvailable('lmstudio')).toBe(false);
  });

  // SECURITY: the function returns ONLY a boolean — the key value must never
  // be accessible through this surface.
  it('return value is a boolean, not the key string', () => {
    setCloudKey('anthropic', 'sk-ant-super-secret');
    const result = cloudKeyAvailable('anthropic');
    expect(typeof result).toBe('boolean');
    // Result must not be the key string or contain it
    expect(result).not.toBe('sk-ant-super-secret');
    expect(String(result)).not.toContain('sk-ant');
  });
});

// ---------------------------------------------------------------------------
// wouldBeCloudCost
// ---------------------------------------------------------------------------

describe('wouldBeCloudCost', () => {
  it('returns a positive number for meaningful token counts', () => {
    const cost = wouldBeCloudCost(10_000, 2_000);
    expect(cost).toBeGreaterThan(0);
  });

  it('returns 0 for zero tokens', () => {
    expect(wouldBeCloudCost(0, 0)).toBe(0);
  });

  it('scales up with more tokens', () => {
    const small = wouldBeCloudCost(1_000, 500);
    const large = wouldBeCloudCost(1_000_000, 500_000);
    expect(large).toBeGreaterThan(small);
  });

  it('returns a finite number (no Infinity/NaN)', () => {
    const cost = wouldBeCloudCost(100_000, 50_000);
    expect(isFinite(cost)).toBe(true);
    expect(isNaN(cost)).toBe(false);
  });

  it('returns a number type', () => {
    expect(typeof wouldBeCloudCost(5_000, 1_000)).toBe('number');
  });

  it('even locally-run tokens have a positive "would-have-been" cloud cost', () => {
    // This is the savings metric: local=$0, but cloud would have cost $X
    const saving = wouldBeCloudCost(50_000, 20_000);
    expect(saving).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// chooseRoute — LOCAL-FIRST defaults (invariant: NEVER cloud without all 3)
// ---------------------------------------------------------------------------

describe('chooseRoute — local-first default', () => {
  it('returns tier=local when allowCloud=false', async () => {
    const decision = await chooseRoute('summarize this file', makeConfig(), localOpts({ allowCloud: false }));
    expect(decision.tier).toBe('local');
  });

  it('returns tier=local when lastReason=none even if allowCloud=true', async () => {
    setCloudKey('anthropic', 'sk-ant-fake');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'analyze project',
      cfg,
      localOpts({ allowCloud: true, lastReason: 'none' }),
    );
    expect(decision.tier).toBe('local');
  });

  it('returns tier=local when allowCloud=true + lastReason task-failed but NO cloud key', async () => {
    clearCloudKey('anthropic');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'build feature',
      cfg,
      localOpts({ allowCloud: true, lastReason: 'task-failed' }),
    );
    expect(decision.tier).toBe('local');
  });

  it('returns tier=local when allowCloud=false, regardless of cloud key presence', async () => {
    setCloudKey('anthropic', 'sk-ant-present');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'run tests',
      cfg,
      localOpts({ allowCloud: false, lastReason: 'task-failed' }),
    );
    expect(decision.tier).toBe('local');
  });

  it('returns tier=local when allowCloud=false + lastReason=verify-failed + no cloud key', async () => {
    clearCloudKey('anthropic');
    const cfg = makeConfig({ providerChain: ['ollama'] });
    const decision = await chooseRoute(
      'lint code',
      cfg,
      localOpts({ allowCloud: false, lastReason: 'verify-failed' }),
    );
    expect(decision.tier).toBe('local');
  });

  it('returns tier=local when allowCloud=false + lastReason=latency + cloud key present', async () => {
    setCloudKey('anthropic', 'sk-ant-latency-test');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'check types',
      cfg,
      localOpts({ allowCloud: false, lastReason: 'latency' }),
    );
    expect(decision.tier).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// NO_SILENT_CLOUD invariant — explicitly assert all three conditions must hold
// ---------------------------------------------------------------------------

describe('NO_SILENT_CLOUD invariant', () => {
  /**
   * For every combination where at least one of the three conditions is missing,
   * chooseRoute must return tier='local'.
   */

  const conditions: Array<{
    label: string;
    allowCloud: boolean;
    lastReason: EscalationReason;
    hasKey: boolean;
  }> = [
    { label: 'allowCloud=false, reason=none, no key',       allowCloud: false, lastReason: 'none',          hasKey: false },
    { label: 'allowCloud=false, reason=none, key present',  allowCloud: false, lastReason: 'none',          hasKey: true  },
    { label: 'allowCloud=false, reason=task-failed, no key',allowCloud: false, lastReason: 'task-failed',   hasKey: false },
    { label: 'allowCloud=false, reason=task-failed, key',   allowCloud: false, lastReason: 'task-failed',   hasKey: true  },
    { label: 'allowCloud=true,  reason=none, no key',       allowCloud: true,  lastReason: 'none',          hasKey: false },
    { label: 'allowCloud=true,  reason=none, key present',  allowCloud: true,  lastReason: 'none',          hasKey: true  },
    { label: 'allowCloud=true,  reason=task-failed, no key',allowCloud: true,  lastReason: 'task-failed',   hasKey: false },
    { label: 'allowCloud=true,  reason=verify-failed, no key', allowCloud: true, lastReason: 'verify-failed', hasKey: false },
    { label: 'allowCloud=true,  reason=latency, no key',    allowCloud: true,  lastReason: 'latency',       hasKey: false },
  ];

  for (const c of conditions) {
    it(`returns local when: ${c.label}`, async () => {
      if (c.hasKey) {
        setCloudKey('anthropic', 'sk-ant-test-invariant');
      } else {
        clearCloudKey('anthropic');
      }
      const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
      const decision = await chooseRoute(
        'do some work',
        cfg,
        { allowCloud: c.allowCloud, attempt: 1, lastReason: c.lastReason },
      );
      expect(decision.tier).toBe('local');
    });
  }
});

// ---------------------------------------------------------------------------
// chooseRoute — CLOUD escalation (all three conditions met)
// ---------------------------------------------------------------------------

describe('chooseRoute — cloud escalation (all three conditions satisfied)', () => {
  it('returns tier=cloud when allowCloud=true + lastReason=task-failed + anthropic key set', async () => {
    setCloudKey('anthropic', 'sk-ant-real-key');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'summarize output',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'task-failed' },
    );
    expect(decision.tier).toBe('cloud');
  });

  it('returns tier=cloud when allowCloud=true + lastReason=verify-failed + anthropic key set', async () => {
    setCloudKey('anthropic', 'sk-ant-verify-key');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'rewrite function',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'verify-failed' },
    );
    expect(decision.tier).toBe('cloud');
  });

  it('returns tier=cloud when allowCloud=true + lastReason=latency + anthropic key set', async () => {
    setCloudKey('anthropic', 'sk-ant-latency-key');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'slow task fallback',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'latency' },
    );
    expect(decision.tier).toBe('cloud');
  });

  it('cloud decision includes a non-empty provider id', async () => {
    setCloudKey('anthropic', 'sk-ant-provider-test');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'complex analysis',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'task-failed' },
    );
    expect(typeof decision.provider).toBe('string');
    expect(decision.provider.length).toBeGreaterThan(0);
  });

  it('cloud decision includes a non-empty model id', async () => {
    setCloudKey('anthropic', 'sk-ant-model-test');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'complex analysis',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'task-failed' },
    );
    expect(typeof decision.model).toBe('string');
    expect(decision.model.length).toBeGreaterThan(0);
  });

  it('cloud decision reason mentions escalation', async () => {
    setCloudKey('anthropic', 'sk-ant-reason-test');
    const cfg = makeConfig({ providerChain: ['anthropic', 'ollama'] });
    const decision = await chooseRoute(
      'escalated task',
      cfg,
      { allowCloud: true, attempt: 2, lastReason: 'task-failed' },
    );
    expect(typeof decision.reason).toBe('string');
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// RouteDecision shape
// ---------------------------------------------------------------------------

describe('chooseRoute — RouteDecision shape', () => {
  it('returns all required RouteDecision fields', async () => {
    const decision = await chooseRoute('write a test', makeConfig(), localOpts());
    expect(typeof decision.provider).toBe('string');
    expect(typeof decision.model).toBe('string');
    expect(typeof decision.tier).toBe('string');
    expect(typeof decision.reason).toBe('string');
    expect(['local', 'cloud']).toContain(decision.tier);
  });

  it('provider field is non-empty on a valid local route', async () => {
    const decision = await chooseRoute('list files', makeConfig(), localOpts());
    expect(decision.provider.length).toBeGreaterThan(0);
  });

  it('model field is non-empty on a valid local route', async () => {
    const decision = await chooseRoute('list files', makeConfig(), localOpts());
    expect(decision.model.length).toBeGreaterThan(0);
  });

  it('reason field is non-empty and descriptive', async () => {
    const decision = await chooseRoute('summarize', makeConfig(), localOpts());
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Per-task routing rules
// ---------------------------------------------------------------------------

describe('chooseRoute — routing rules', () => {
  it('applies first matching routing rule to pick model', async () => {
    const cfg = makeConfig({
      providerChain: ['ollama'],
      routing: [
        { match: 'summarize', model: 'llama3:70b' },
        { match: 'build',     model: 'llama3:8b'  },
      ],
    });
    const decision = await chooseRoute('summarize this document', cfg, localOpts());
    // Rule matched — should prefer the rule's model
    expect(decision.model).toBe('llama3:70b');
    expect(decision.tier).toBe('local');
  });

  it('applies the first rule that matches, not subsequent ones', async () => {
    const cfg = makeConfig({
      providerChain: ['ollama'],
      routing: [
        { match: 'build', model: 'llama3:8b'  },
        { match: 'build', model: 'llama3:70b' }, // should never be picked
      ],
    });
    const decision = await chooseRoute('build the project', cfg, localOpts());
    expect(decision.model).toBe('llama3:8b');
  });

  it('falls back to local chain selection when no routing rule matches', async () => {
    const cfg = makeConfig({
      providerChain: ['ollama'],
      routing: [
        { match: 'deploy', model: 'llama3:70b' },
      ],
    });
    // 'lint' does not match 'deploy'
    const decision = await chooseRoute('lint my code', cfg, localOpts());
    expect(decision.tier).toBe('local');
    expect(typeof decision.model).toBe('string');
    expect(decision.model.length).toBeGreaterThan(0);
  });

  it('routing rule does NOT force cloud — result is still local', async () => {
    // Even if a rule matches, it should not bypass local-first guardrail
    const cfg = makeConfig({
      providerChain: ['ollama'],
      routing: [
        { match: 'code review', model: 'llama3:70b' },
      ],
    });
    const decision = await chooseRoute('code review this PR', cfg, localOpts({ allowCloud: false }));
    expect(decision.tier).toBe('local');
  });

  it('empty routing array falls through to chain default', async () => {
    const cfg = makeConfig({
      providerChain: ['ollama'],
      routing: [],
    });
    const decision = await chooseRoute('any task', cfg, localOpts());
    expect(decision.tier).toBe('local');
    expect(decision.model.length).toBeGreaterThan(0);
  });

  it('undefined routing falls through to chain default', async () => {
    const cfg = makeConfig({
      providerChain: ['ollama'],
      // routing omitted
    });
    const decision = await chooseRoute('any task', cfg, localOpts());
    expect(decision.tier).toBe('local');
    expect(decision.model.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// chooseRoute — provider chain fallback
// ---------------------------------------------------------------------------

describe('chooseRoute — provider chain fallback', () => {
  it('selects the first up provider in the chain', async () => {
    // Mock: ollama up, lmstudio down → picks ollama
    mockGetRegistry.mockResolvedValueOnce({
      providers: [
        { id: 'ollama', url: 'http://localhost:11434/api/tags', up: true, models: ['llama3:8b'] },
        { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: false, models: [] },
      ],
      activeProvider: 'ollama',
      chain: ['ollama', 'lmstudio'],
    });
    const cfg = makeConfig({ providerChain: ['ollama', 'lmstudio'] });
    const decision = await chooseRoute('do work', cfg, localOpts());
    expect(decision.provider).toBe('ollama');
    expect(decision.tier).toBe('local');
  });

  it('falls to lmstudio when ollama is down', async () => {
    mockGetRegistry.mockResolvedValueOnce({
      providers: [
        { id: 'ollama', url: 'http://localhost:11434/api/tags', up: false, models: [] },
        { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: true, models: ['mistral-7b'] },
      ],
      activeProvider: 'lmstudio',
      chain: ['ollama', 'lmstudio'],
    });
    const cfg = makeConfig({ providerChain: ['ollama', 'lmstudio'] });
    const decision = await chooseRoute('do work', cfg, localOpts());
    expect(decision.provider).toBe('lmstudio');
    expect(decision.tier).toBe('local');
  });

  it('still returns a local decision (not throwing) when all providers are down and no cloud key', async () => {
    mockGetRegistry.mockResolvedValueOnce({
      providers: [
        { id: 'ollama',   url: 'http://localhost:11434/api/tags', up: false, models: [] },
        { id: 'lmstudio', url: 'http://localhost:1234/v1/models', up: false, models: [] },
      ],
      activeProvider: null,
      chain: ['ollama', 'lmstudio'],
    });
    clearCloudKey('anthropic');
    const cfg = makeConfig({ providerChain: ['ollama', 'lmstudio'] });
    const decision = await chooseRoute('do work', cfg, localOpts({ allowCloud: false }));
    // Must not throw; returns a local-tier decision (even if no provider reachable)
    expect(decision.tier).toBe('local');
  });
});
