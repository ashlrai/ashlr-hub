import { describe, expect, it } from 'vitest';
import {
  compareReposByStrategicFocus,
  loadEcosystemFocus,
  strategicRepoMultiplier,
  strategicTierOfRepo,
} from '../src/core/ecosystem/focus.js';

describe('M312 — strategic ecosystem focus', () => {
  it('loads the core fleet spine and external mux candidate from the index', () => {
    const focus = loadEcosystemFocus();

    expect(focus.coreFleetRepos).toEqual([
      'ashlr-hub',
      'phantom-secrets',
      'ashlr-plugin',
      'binshield',
      'ashlr-md',
      'stack',
      'ashlr-pulse',
      'ashlrcode',
      'ashlr-workbench',
    ]);
    expect(focus.externalCoreCandidates).toContainEqual(expect.objectContaining({
      id: 'ashlr-mux',
      status: 'not-in-local-dev-tools-inventory',
    }));
  });

  it('classifies repo paths by strategic tier with neutral fallback', () => {
    expect(strategicTierOfRepo('/tmp/dev-tools/ashlr-hub')).toBe('core-fleet');
    expect(strategicTierOfRepo('/tmp/dev-tools/stack')).toBe('core-fleet');
    expect(strategicTierOfRepo('/tmp/dev-tools/ashlr-stack')).toBe('core-fleet');
    expect(strategicTierOfRepo('/tmp/dev-tools/morphkit')).toBe('force-multiplier');
    expect(strategicTierOfRepo('/tmp/dev-tools/ashlr-config')).toBe('supporting');
    expect(strategicTierOfRepo('/tmp/dev-tools/random-product')).toBe('inventory');
  });

  it('biases close calls toward the core fleet while preserving support visibility', () => {
    expect(strategicRepoMultiplier('/tmp/dev-tools/ashlr-hub')).toBeGreaterThan(1);
    expect(strategicRepoMultiplier('/tmp/dev-tools/morphkit')).toBeGreaterThan(1);
    expect(strategicRepoMultiplier('/tmp/dev-tools/ashlr-config')).toBeLessThan(1);
    expect(strategicRepoMultiplier('/tmp/dev-tools/random-product')).toBe(1);

    const repos = [
      '/tmp/dev-tools/ashlr-config',
      '/tmp/dev-tools/random-product',
      '/tmp/dev-tools/morphkit',
      '/tmp/dev-tools/ashlr-hub',
    ].sort(compareReposByStrategicFocus);

    expect(repos.map((repo) => repo.split('/').pop())).toEqual([
      'ashlr-hub',
      'morphkit',
      'random-product',
      'ashlr-config',
    ]);
  });
});
