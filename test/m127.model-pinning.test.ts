/**
 * M127 — :default model-pinning fix tests.
 *
 * Verifies that resolveConcreteModel captures a concrete model from
 * cfg.foundry.models or the captured/env model, and that frontier proposals
 * built with a configured model can now pass evaluateMergeAuthority while
 * an unconfigured engine still yields ':default' (which stays REJECTED).
 *
 * SAFETY / HERMETICITY:
 *  - No subprocess spawns, no network, no real ~/.ashlr state touched.
 *  - process.env.ASHLR_MODEL is set/cleared within each test that needs it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { resolveConcreteModel } from '../src/core/run/sandboxed-engine.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(models?: Record<string, string>): AshlrConfig {
  return {
    foundry: {
      mergeAuthority: models
        ? Object.entries(models).map(([engine, model]) => ({ engine, model }))
        : [],
      ...(models ? { models } : {}),
    },
  } as unknown as AshlrConfig;
}

function makeProposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'prop-m127',
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
// resolveConcreteModel — unit
// ---------------------------------------------------------------------------

describe('M127 resolveConcreteModel', () => {
  afterEach(() => {
    delete process.env.ASHLR_MODEL;
  });

  it('returns cfg.foundry.models[engine] when configured (priority 1)', () => {
    const cfg = makeCfg({ codex: 'gpt-5.5' });
    expect(resolveConcreteModel('codex', cfg)).toBe('gpt-5.5');
  });

  it('cfg.foundry.models wins over capturedModel (priority 1 > 2)', () => {
    const cfg = makeCfg({ codex: 'gpt-5.5' });
    expect(resolveConcreteModel('codex', cfg, 'gpt-4o')).toBe('gpt-5.5');
  });

  it('returns capturedModel when no cfg entry (priority 2)', () => {
    const cfg = makeCfg();
    expect(resolveConcreteModel('codex', cfg, 'gpt-4o')).toBe('gpt-4o');
  });

  it('returns ASHLR_MODEL env when no cfg entry and no capturedModel (priority 3)', () => {
    process.env.ASHLR_MODEL = 'env-model-x';
    const cfg = makeCfg();
    expect(resolveConcreteModel('codex', cfg)).toBe('env-model-x');
  });

  it('capturedModel wins over ASHLR_MODEL (priority 2 > 3)', () => {
    process.env.ASHLR_MODEL = 'env-model-x';
    const cfg = makeCfg();
    expect(resolveConcreteModel('codex', cfg, 'captured-model')).toBe('captured-model');
  });

  it('M260: returns registry defaultModel (gpt-5.5) for codex when nothing else is configured (priority 4)', () => {
    // Pre-M260 this returned 'default'; M260 adds spec.defaultModel as priority 4
    // so codex now resolves to its registry canonical model instead of 'default'.
    const cfg = makeCfg();
    expect(resolveConcreteModel('codex', cfg)).toBe('gpt-5.5');
  });

  it('works for claude engine as well', () => {
    const cfg = makeCfg({ claude: 'claude-opus-4-5' });
    expect(resolveConcreteModel('claude', cfg)).toBe('claude-opus-4-5');
  });

  it('M260: different engines do not share configured models; unconfigured engine uses registry defaultModel', () => {
    const cfg = makeCfg({ codex: 'gpt-5.5' });
    // claude has no cfg.foundry.models entry, no capturedModel, no ASHLR_MODEL —
    // M260: falls to spec.defaultModel from the registry ('claude-opus-4-8').
    expect(resolveConcreteModel('claude', cfg)).toBe('claude-opus-4-8');
  });
});

// ---------------------------------------------------------------------------
// evaluateMergeAuthority — end-to-end proof
// ---------------------------------------------------------------------------

describe('M127 evaluateMergeAuthority — concrete model authorizes', () => {
  it('frontier proposal with codex:gpt-5.5 + matching mergeAuthority entry → authorized', () => {
    const cfg = {
      foundry: {
        models: { codex: 'gpt-5.5' },
        mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      },
    } as unknown as AshlrConfig;

    const engineModel = `codex:${resolveConcreteModel('codex', cfg)}`;
    expect(engineModel).toBe('codex:gpt-5.5');

    const p = makeProposal({ engineTier: 'frontier', engineModel });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(true);
    expect(v.reason).toMatch(/authorized/i);
  });

  it('M260: unconfigured codex resolves to registry defaultModel (gpt-5.5) and is AUTHORIZED when in mergeAuthority', () => {
    // Pre-M260: resolveConcreteModel('codex', cfg) → 'default' → rejected.
    // Post-M260: resolveConcreteModel('codex', cfg) → 'gpt-5.5' (spec.defaultModel) → authorized.
    const cfg = {
      foundry: {
        mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      },
    } as unknown as AshlrConfig;

    const engineModel = `codex:${resolveConcreteModel('codex', cfg)}`;
    expect(engineModel).toBe('codex:gpt-5.5');

    const p = makeProposal({ engineTier: 'frontier', engineModel });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(true);
    expect(v.reason).toMatch(/authorized/i);
  });

  it('captured model enables authorization when cfg.models is absent', () => {
    const cfg = {
      foundry: {
        mergeAuthority: [{ engine: 'codex', model: 'gpt-4o' }],
      },
    } as unknown as AshlrConfig;

    const engineModel = `codex:${resolveConcreteModel('codex', cfg, 'gpt-4o')}`;
    expect(engineModel).toBe('codex:gpt-4o');

    const p = makeProposal({ engineTier: 'frontier', engineModel });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(true);
  });

  it('non-frontier tier is REJECTED even with concrete model', () => {
    const cfg = {
      foundry: {
        models: { codex: 'gpt-5.5' },
        mergeAuthority: [{ engine: 'codex', model: 'gpt-5.5' }],
      },
    } as unknown as AshlrConfig;

    const engineModel = `codex:${resolveConcreteModel('codex', cfg)}`;
    const p = makeProposal({ engineTier: 'local', engineModel });
    const v = evaluateMergeAuthority(p, cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/frontier/i);
  });
});
