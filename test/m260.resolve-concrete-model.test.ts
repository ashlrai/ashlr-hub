/**
 * M260 — fix Blocker 3: frontier proposals carry ':default' model aliases which
 * evaluateMergeAuthority refuses, so even ship-judged frontier work can never
 * auto-merge.
 *
 * FIX: resolveConcreteModel now uses spec.defaultModel (priority 4) before
 * falling through to bare 'default', so `codex` → `codex:gpt-5.5` and
 * `claude` → `claude:claude-opus-4-8` when no explicit model is configured.
 *
 * SAFETY invariants verified here:
 *  - Frontier engines (codex, claude) resolve to their authorised concrete model
 *    and pass evaluateMergeAuthority.
 *  - Non-frontier engines (local-coder, nim, hermes) are still REFUSED — the
 *    engineTier check in evaluateMergeAuthority fires before the model check.
 *  - The ':default' rejection path in evaluateMergeAuthority is still reachable
 *    (e.g. a custom unknown engine with no registry entry).
 *  - All other gate conditions (no mergeAuthority config, model not in list,
 *    wrong tier) remain unchanged.
 *
 * HERMETICITY:
 *  - No subprocess spawns, no network, no real ~/.ashlr state touched.
 *  - process.env.ASHLR_MODEL is set/cleared within each test that needs it.
 *  - vi.fn() stubs used where needed; no module mocking of the registry.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { resolveConcreteModel } from '../src/core/run/sandboxed-engine.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AshlrConfig with the given mergeAuthority entries and
 *  optional cfg.foundry.models overrides. */
function makeCfg(
  mergeAuthority: Array<{ engine: string; model: string }>,
  models?: Record<string, string>,
): AshlrConfig {
  return {
    foundry: {
      mergeAuthority,
      ...(models ? { models } : {}),
    },
  } as unknown as AshlrConfig;
}

/** Build a minimal Proposal with defaults for all required fields. */
function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-m260',
    repo: '/tmp/test-repo',
    origin: 'agent',
    kind: 'patch',
    title: 'test',
    summary: 'test',
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...over,
  } as Proposal;
}

// ---------------------------------------------------------------------------
// M260 — resolveConcreteModel: registry defaultModel fallback (priority 4)
// ---------------------------------------------------------------------------

describe('M260 resolveConcreteModel — registry defaultModel fallback', () => {
  afterEach(() => {
    delete process.env.ASHLR_MODEL;
  });

  it('codex: no cfg.foundry.models, no capturedModel, no ASHLR_MODEL → registry defaultModel gpt-5.5', () => {
    const cfg = makeCfg([{ engine: 'codex', model: 'gpt-5.5' }]);
    expect(resolveConcreteModel('codex', cfg)).toBe('gpt-5.5');
  });

  it('claude: no cfg.foundry.models, no capturedModel, no ASHLR_MODEL → registry defaultModel claude-opus-4-8', () => {
    const cfg = makeCfg([{ engine: 'claude', model: 'claude-opus-4-8' }]);
    expect(resolveConcreteModel('claude', cfg)).toBe('claude-opus-4-8');
  });

  it('cfg.foundry.models still wins over registry defaultModel (priority 1 > 4)', () => {
    const cfg = makeCfg(
      [{ engine: 'codex', model: 'gpt-5.5' }],
      { codex: 'gpt-5.5-turbo' },
    );
    expect(resolveConcreteModel('codex', cfg, undefined)).toBe('gpt-5.5-turbo');
  });

  it('capturedModel wins over registry defaultModel (priority 2 > 4)', () => {
    const cfg = makeCfg([{ engine: 'codex', model: 'gpt-5.5' }]);
    expect(resolveConcreteModel('codex', cfg, 'gpt-5.5-captured')).toBe('gpt-5.5-captured');
  });

  it('ASHLR_MODEL wins over registry defaultModel (priority 3 > 4)', () => {
    process.env.ASHLR_MODEL = 'gpt-5.5-env';
    const cfg = makeCfg([{ engine: 'codex', model: 'gpt-5.5' }]);
    expect(resolveConcreteModel('codex', cfg)).toBe('gpt-5.5-env');
  });

  it('unknown engine (no registry entry) still falls through to bare default', () => {
    const cfg = makeCfg([]);
    expect(resolveConcreteModel('unknown-engine' as any, cfg)).toBe('default');
  });

  it('local-coder uses api.defaultModel (priority 5) when no override', () => {
    const cfg = makeCfg([]);
    // local-coder registry api.defaultModel = 'qwen2.5:72b-instruct-q4_K_M'
    expect(resolveConcreteModel('local-coder', cfg)).toBe('qwen2.5:72b-instruct-q4_K_M');
  });
});

// ---------------------------------------------------------------------------
// M260 — core invariant: frontier proposals now PASS evaluateMergeAuthority
// ---------------------------------------------------------------------------

describe('M260 evaluateMergeAuthority — frontier resolved concrete model passes', () => {
  const frontierCfg = makeCfg([
    { engine: 'codex', model: 'gpt-5.5' },
    { engine: 'claude', model: 'claude-opus-4-8' },
  ]);

  it('codex proposal with resolved concrete model (gpt-5.5) is AUTHORIZED', () => {
    const engineModel = `codex:${resolveConcreteModel('codex', frontierCfg)}`;
    expect(engineModel).toBe('codex:gpt-5.5');

    const p = makeProposal({ engineTier: 'frontier', engineModel });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(true);
    expect(v.reason).toMatch(/authorized/);
  });

  it('claude proposal with resolved concrete model (claude-opus-4-8) is AUTHORIZED', () => {
    const engineModel = `claude:${resolveConcreteModel('claude', frontierCfg)}`;
    expect(engineModel).toBe('claude:claude-opus-4-8');

    const p = makeProposal({ engineTier: 'frontier', engineModel });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(true);
    expect(v.reason).toMatch(/authorized/);
  });

  it('codex:default is still REJECTED (old broken path — no regression)', () => {
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:default' });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/:default/);
  });

  it('claude:default is still REJECTED (old broken path — no regression)', () => {
    const p = evaluateMergeAuthority(
      makeProposal({ engineTier: 'frontier', engineModel: 'claude:default' }),
      frontierCfg,
    );
    expect(p.authorized).toBe(false);
    expect(p.reason).toMatch(/:default/);
  });
});

// ---------------------------------------------------------------------------
// M260 — SAFETY: non-frontier engines are STILL REFUSED
// ---------------------------------------------------------------------------

describe('M260 safety — non-frontier engines remain refused regardless of model', () => {
  const frontierCfg = makeCfg([
    { engine: 'codex', model: 'gpt-5.5' },
    { engine: 'claude', model: 'claude-opus-4-8' },
    // Even if someone accidentally added a non-frontier engine here:
    { engine: 'local-coder', model: 'qwen2.5:72b-instruct-q4_K_M' },
    { engine: 'nim', model: 'meta/llama-3.1-70b-instruct' },
    { engine: 'hermes', model: 'hermes-3' },
  ]);

  it('local-coder (tier=mid) is REFUSED even with concrete model in mergeAuthority', () => {
    const engineModel = `local-coder:${resolveConcreteModel('local-coder', frontierCfg)}`;
    const p = makeProposal({ engineTier: 'mid', engineModel });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/mid.*branch-eligible but never merge-authority/i);
  });

  it('nim (tier=mid) is REFUSED — even when engine is in mergeAuthority', () => {
    const p = makeProposal({
      engineTier: 'mid',
      engineModel: 'nim:meta/llama-3.1-70b-instruct',
    });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/mid/i);
  });

  it('hermes (tier=mid) is REFUSED', () => {
    const p = makeProposal({ engineTier: 'mid', engineModel: 'hermes:hermes-3' });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(false);
  });

  it('local tier is REFUSED', () => {
    const p = makeProposal({ engineTier: 'local', engineModel: 'codex:gpt-5.5' });
    const v = evaluateMergeAuthority(p, frontierCfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/frontier/i);
  });
});

// ---------------------------------------------------------------------------
// M260 — gate otherwise unchanged: other refusal conditions still hold
// ---------------------------------------------------------------------------

describe('M260 gate unchanged — other refusal conditions still hold', () => {
  it('no engineModel → REFUSED', () => {
    const cfg = makeCfg([{ engine: 'codex', model: 'gpt-5.5' }]);
    const p = makeProposal({ engineTier: 'frontier', engineModel: undefined });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/no engineModel/i);
  });

  it('empty mergeAuthority config → REFUSED even for frontier concrete model', () => {
    const cfg = makeCfg([]);
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-5.5' });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/mergeAuthority is empty/i);
  });

  it('model not in mergeAuthority list → REFUSED', () => {
    const cfg = makeCfg([{ engine: 'codex', model: 'gpt-5.5' }]);
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-9' });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/not in cfg\.foundry\.mergeAuthority/i);
  });

  it('no foundry config at all → REFUSED', () => {
    const cfg = {} as AshlrConfig;
    const p = makeProposal({ engineTier: 'frontier', engineModel: 'codex:gpt-5.5' });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
  });
});
