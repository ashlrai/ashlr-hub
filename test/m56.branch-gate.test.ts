/**
 * M56 — mid→branch auto-apply gate.
 *
 * Hermetic; no spawn, no git. The PURE gate (`evaluateBranchAuthority`) is the
 * safety crux — mid earns a BRANCH/PR, never main, and only behind the separate
 * default-off `midToBranch` flag. Structural source-guards prove the executor
 * keeps the squash-merge + local-merge frontier-only.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { evaluateBranchAuthority, mergeTargetForTier } from '../src/core/inbox/merge.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function cfg(midToBranch: boolean | undefined, enabled = true): AshlrConfig {
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
    foundry: { autoMerge: { enabled, midToBranch } },
  } as AshlrConfig;
}

const p = (over: Partial<Proposal>): Proposal => ({ engineTier: 'mid', ...over }) as Proposal;

describe('M56 — evaluateBranchAuthority', () => {
  it('authorizes a mid proposal with a concrete model when midToBranch is ON', () => {
    const v = evaluateBranchAuthority(p({ engineTier: 'mid', engineModel: 'hermes:hermes-3-llama-3.1-70b' }), cfg(true));
    expect(v.authorized).toBe(true);
    expect(v.reason).toMatch(/never main/);
  });

  it('REFUSES when midToBranch is off/undefined (separate default-off flag)', () => {
    expect(evaluateBranchAuthority(p({ engineModel: 'hermes:h3' }), cfg(false)).authorized).toBe(false);
    expect(evaluateBranchAuthority(p({ engineModel: 'hermes:h3' }), cfg(undefined)).authorized).toBe(false);
  });

  it('REFUSES a frontier proposal (that is the MAIN path, not branch)', () => {
    const v = evaluateBranchAuthority(p({ engineTier: 'frontier', engineModel: 'claude:opus' }), cfg(true));
    expect(v.authorized).toBe(false);
    expect(v.reason).toMatch(/not branch-eligible/);
  });

  it('REFUSES a local proposal', () => {
    expect(evaluateBranchAuthority(p({ engineTier: 'local', engineModel: 'aw:llama' }), cfg(true)).authorized).toBe(false);
  });

  it('REFUSES a mid proposal with no concrete model (:default)', () => {
    expect(evaluateBranchAuthority(p({ engineTier: 'mid', engineModel: 'hermes:default' }), cfg(true)).authorized).toBe(false);
  });

  it('mergeTargetForTier stays the source of truth', () => {
    expect(mergeTargetForTier('mid')).toBe('branch');
    expect(mergeTargetForTier('frontier')).toBe('main');
  });
});

describe('M56 — executor keeps merge-to-main frontier-only (structural source guard)', () => {
  const merge = readFileSync(resolve(HERE, '../src/core/inbox/merge.ts'), 'utf8');

  it('autoMergeProposal branches on mergeTargetForTier', () => {
    expect(merge).toMatch(/const target = mergeTargetForTier\(proposal\.engineTier\)/);
    expect(merge).toMatch(/const toMain = target === 'main'/);
  });

  it('the squash-merge to main is guarded by toMain', () => {
    // The `gh pr merge --squash` step only runs for a frontier (toMain) proposal.
    expect(merge).toMatch(/if \(toMain && prUrl\)/);
  });

  it('the local merge-to-main is guarded by toMain (mid leaves a staged branch)', () => {
    expect(merge).toMatch(/\} else if \(toMain\) \{/);
    expect(merge).toMatch(/staged branch for review \(mid-tier/);
  });
});
