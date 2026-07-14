/**
 * M51 — tri-tier trust: authority never leaks upward.
 *
 * Hermetic; no spawn, no network. Proves mid/local can never reach main, the
 * mergeTargetForTier policy seam, and that the tier is provenance-bound (a record
 * cannot claim a higher tier than its signed {engineModel, engineTier}).
 */

import { describe, it, expect } from 'vitest';
import type { AshlrConfig, EngineTier, Proposal } from '../src/core/types.js';
import { evaluateMergeAuthority, mergeTargetForTier } from '../src/core/inbox/merge.js';
import { engineTierOf } from '../src/core/run/sandboxed-engine.js';
import {
  hashDiff,
  signProducerProvenanceV2,
  signProvenance,
  verifyProducerProvenanceV2,
  verifyProvenance,
} from '../src/core/foundry/provenance.js';

function cfgWithAuthority(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    foundry: {
      mergeAuthority: [
        { engine: 'claude', model: 'opus-4.8' },
        { engine: 'codex', model: 'gpt-5.5' },
        // Adversarial: even if someone lists a mid/local model here, tier wins.
        { engine: 'hermes', model: 'hermes-3-llama-3.1-70b' },
      ],
    },
  } as AshlrConfig;
}

function proposal(over: Partial<Proposal>): Proposal {
  return { engineTier: 'local', ...over } as Proposal;
}

describe('M51 — EngineTier has three tiers', () => {
  it('hermes is mid; claude/codex frontier; builtin/aw/ashlrcode/opencode local', () => {
    expect(engineTierOf('hermes')).toBe('mid');
    expect(engineTierOf('claude')).toBe('frontier');
    expect(engineTierOf('codex')).toBe('frontier');
    for (const e of ['builtin', 'aw', 'ashlrcode', 'opencode'] as const) {
      expect(engineTierOf(e)).toBe('local');
    }
  });
});

describe('M51 — mid/local can NEVER reach main', () => {
  const cfg = cfgWithAuthority();

  it("refuses a 'mid' proposal for main even when its model is in mergeAuthority", () => {
    const v = evaluateMergeAuthority(
      proposal({ engineTier: 'mid', engineModel: 'hermes:hermes-3-llama-3.1-70b' }),
      cfg,
    );
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/mid/);
    expect(v.reason).toMatch(/never merge-authority for main/);
  });

  it("refuses a 'local' proposal for main", () => {
    const v = evaluateMergeAuthority(proposal({ engineTier: 'local', engineModel: 'aw:llama' }), cfg);
    expect(v.authorized).toBe(false);
  });

  it("authorizes a 'frontier' proposal whose model is in mergeAuthority", () => {
    const v = evaluateMergeAuthority(
      proposal({ engineTier: 'frontier', engineModel: 'claude:opus-4.8' }),
      cfg,
    );
    expect(v.authorized).toBe(true);
  });

  it("refuses a 'frontier' proposal whose model is NOT in mergeAuthority", () => {
    const v = evaluateMergeAuthority(
      proposal({ engineTier: 'frontier', engineModel: 'claude:some-unvetted' }),
      cfg,
    );
    expect(v.authorized).toBe(false);
  });
});

describe('M51 — mergeTargetForTier policy seam', () => {
  it('frontier→main, mid→branch, local/undefined→none', () => {
    expect(mergeTargetForTier('frontier')).toBe('main');
    expect(mergeTargetForTier('mid')).toBe('branch');
    expect(mergeTargetForTier('local')).toBe('none');
    expect(mergeTargetForTier(undefined)).toBe('none');
    expect(mergeTargetForTier('bogus' as EngineTier)).toBe('none');
  });
});

describe('M51 — tier is provenance-bound (cannot be forged upward)', () => {
  it('a record signed as mid cannot be re-labeled frontier without breaking the HMAC', () => {
    const diff = 'diff --git a/x b/x\n+hello\n';
    const diffHash = hashDiff(diff);
    // Producer signs honestly as 'mid'.
    const sig = signProvenance('hermes:hermes-3-llama-3.1-70b', 'mid', diffHash);

    // Honest record verifies.
    expect(
      verifyProvenance({ engineModel: 'hermes:hermes-3-llama-3.1-70b', engineTier: 'mid', diff, diffHash, provenanceSig: sig })
        .ok,
    ).toBe(true);

    // Forged upgrade to 'frontier' (reusing the mid signature) FAILS closed.
    expect(
      verifyProvenance({
        engineModel: 'hermes:hermes-3-llama-3.1-70b',
        engineTier: 'frontier',
        diff,
        diffHash,
        provenanceSig: sig,
      }).ok,
    ).toBe(false);
  });

  it('producer provenance v2 binds causal identity and rejects source reassignment', () => {
    const diff = 'diff --git a/x b/x\n+hello\n';
    const diffHash = hashDiff(diff);
    const record = {
      id: 'proposal-causal-v2',
      repo: process.cwd(),
      workItemId: 'repo:issue:42',
      workSource: 'issue',
      engineModel: 'codex:gpt-5.5',
      engineTier: 'frontier',
      diff,
      diffHash,
      provenanceSig: signProvenance('codex:gpt-5.5', 'frontier', diffHash),
      producerProvenanceVersion: 2,
    } as const;
    const signed = { ...record, producerProvenanceSig: signProducerProvenanceV2(record) };

    expect(verifyProducerProvenanceV2(signed).ok).toBe(true);
    for (const forged of [
      { ...signed, id: 'another-proposal' },
      { ...signed, repo: process.cwd() + '-other' },
      { ...signed, workItemId: 'repo:goal:42' },
      { ...signed, workSource: 'goal' },
      { ...signed, engineModel: 'claude:opus-4.8' },
    ]) {
      expect(verifyProducerProvenanceV2(forged).ok).toBe(false);
    }
  });
});
