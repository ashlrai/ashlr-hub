/**
 * m324.claude5-safety.test.ts — M324: safety invariants with ALL Claude 5
 * flags on, plus the new effective-config consistency warnings.
 *
 * The tri-tier trust invariants must hold regardless of claude5 /
 * modelGranularRouting state:
 *  - mid/local proposals never gain merge authority, even when listed;
 *  - empty mergeAuthority refuses everything (fail-closed);
 *  - Sonnet 5 merges ONLY via an explicit mergeAuthority entry.
 *
 * effective-config warnings:
 *  - autoMerge + mergeAuthority without sonnet-5 under claude5 → warn;
 *  - explicit Fable pin while claude5.fable is off → warn;
 *  - consistent configs → neither warning.
 */

import { describe, it, expect } from 'vitest';

import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { evaluateMergeAuthority } from '../src/core/inbox/merge.js';
import { buildEffectiveConfigSnapshot } from '../src/core/effective-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLAGS_ON = {
  claude5: { enabled: true, fable: true },
  modelGranularRouting: { enabled: true, minShipRate: 0.6 },
};

function cfgWith(foundry: Record<string, unknown>): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'] },
    foundry,
  } as unknown as AshlrConfig;
}

function makeProposal(engineTier: string, engineModel: string): Proposal {
  return { id: 'p-m324', status: 'pending', engineTier, engineModel } as unknown as Proposal;
}

// ---------------------------------------------------------------------------
// Tri-tier trust with all new flags on
// ---------------------------------------------------------------------------

describe('M324 tri-tier trust invariants (all Claude 5 flags on)', () => {
  it('local proposal never authorized, even when listed in mergeAuthority', () => {
    const cfg = cfgWith({
      ...FLAGS_ON,
      mergeAuthority: [{ engine: 'local-coder', model: 'qwen3-coder-next' }],
    });
    const v = evaluateMergeAuthority(makeProposal('local', 'local-coder:qwen3-coder-next'), cfg);
    expect(v.authorized).toBe(false);
    expect(v.reason).toContain('frontier');
  });

  it('mid proposal never authorized (branch-eligible only)', () => {
    const cfg = cfgWith({
      ...FLAGS_ON,
      mergeAuthority: [{ engine: 'nim', model: 'kimi-k2.6' }],
    });
    const v = evaluateMergeAuthority(makeProposal('mid', 'nim:kimi-k2.6'), cfg);
    expect(v.authorized).toBe(false);
  });

  it('empty mergeAuthority refuses a frontier sonnet-5 proposal (fail-closed)', () => {
    const cfg = cfgWith({ ...FLAGS_ON, mergeAuthority: [] });
    const v = evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-sonnet-5'), cfg);
    expect(v.authorized).toBe(false);
  });

  it('sonnet-5 merges ONLY via an explicit mergeAuthority entry', () => {
    const without = cfgWith({
      ...FLAGS_ON,
      mergeAuthority: [{ engine: 'claude', model: 'claude-opus-4-8' }],
    });
    expect(
      evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-sonnet-5'), without).authorized,
    ).toBe(false);

    const withEntry = cfgWith({
      ...FLAGS_ON,
      mergeAuthority: [
        { engine: 'claude', model: 'claude-opus-4-8' },
        { engine: 'claude', model: 'claude-sonnet-5' },
      ],
    });
    expect(
      evaluateMergeAuthority(makeProposal('frontier', 'claude:claude-sonnet-5'), withEntry).authorized,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// effective-config consistency warnings
// ---------------------------------------------------------------------------

describe('M324 effective-config warnings', () => {
  const snapOpts = { configExists: true, configParsed: true, now: new Date('2026-07-06T00:00:00Z') };

  it('warns when autoMerge is on but mergeAuthority lacks sonnet-5 under claude5', () => {
    const cfg = cfgWith({
      autoMerge: { enabled: true },
      mergeAuthority: [{ engine: 'claude', model: 'claude-opus-4-8' }],
    });
    const snap = buildEffectiveConfigSnapshot(cfg, snapOpts);
    expect(snap.warnings.some((w) => w.includes('claude-sonnet-5'))).toBe(true);
  });

  it('no sonnet-5 warning when the entry exists or claude5 is off', () => {
    const withEntry = cfgWith({
      autoMerge: { enabled: true },
      mergeAuthority: [
        { engine: 'claude', model: 'claude-opus-4-8' },
        { engine: 'claude', model: 'claude-sonnet-5' },
      ],
    });
    expect(
      buildEffectiveConfigSnapshot(withEntry, snapOpts).warnings.some((w) =>
        w.includes('never auto-merge'),
      ),
    ).toBe(false);

    const rolledBack = cfgWith({
      autoMerge: { enabled: true },
      mergeAuthority: [{ engine: 'claude', model: 'claude-opus-4-8' }],
      claude5: { enabled: false },
    });
    expect(
      buildEffectiveConfigSnapshot(rolledBack, snapOpts).warnings.some((w) =>
        w.includes('never auto-merge'),
      ),
    ).toBe(false);
  });

  it('warns when a Fable pin contradicts claude5.fable:false', () => {
    const cfg = cfgWith({
      claude5: { fable: false },
      strategistModel: 'claude-fable-5',
    });
    const snap = buildEffectiveConfigSnapshot(cfg, snapOpts);
    expect(snap.warnings.some((w) => w.includes('Fable'))).toBe(true);
  });

  it('M340: warns on unknown foundry keys (typo detection)', () => {
    const cfg = cfgWith({ modelGranularRoutng: { enabled: true }, verifyToGren: { enabled: true } });
    const snap = buildEffectiveConfigSnapshot(cfg, snapOpts);
    const w = snap.warnings.find((x) => x.includes('not recognized'));
    expect(w).toBeDefined();
    expect(w).toContain('modelGranularRoutng');
    expect(w).toContain('verifyToGren');
  });

  it('M340: no unknown-key warning for a fully-known foundry block', () => {
    const cfg = cfgWith({
      allowedBackends: ['claude'],
      claude5: { enabled: true },
      modelGranularRouting: { enabled: false },
      verifyToGreen: { enabled: true },
      bestOfN: 3,
      mergeAuthority: [{ engine: 'claude', model: 'claude-sonnet-5' }],
    });
    const snap = buildEffectiveConfigSnapshot(cfg, snapOpts);
    expect(snap.warnings.some((x) => x.includes('not recognized'))).toBe(false);
  });

  it('no Fable warning when the pin and the flag agree', () => {
    const pinnedAndOn = cfgWith({ strategistModel: 'claude-fable-5' });
    expect(
      buildEffectiveConfigSnapshot(pinnedAndOn, snapOpts).warnings.some((w) => w.includes('Fable')),
    ).toBe(false);

    const offAndUnpinned = cfgWith({ claude5: { fable: false } });
    expect(
      buildEffectiveConfigSnapshot(offAndUnpinned, snapOpts).warnings.some((w) =>
        w.includes('Fable'),
      ),
    ).toBe(false);
  });
});
