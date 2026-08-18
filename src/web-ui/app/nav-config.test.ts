import { describe, expect, it } from 'vitest';
import { NAV_GROUPS, ALL_NAV_LEAVES } from './nav-config.js';

describe('nav-config', () => {
  it('has no duplicate paths across groups', () => {
    const paths = ALL_NAV_LEAVES.map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every leaf path is absolute and starts with /', () => {
    for (const leaf of ALL_NAV_LEAVES) {
      expect(leaf.path.startsWith('/')).toBe(true);
    }
  });

  it('the Fleet Dashboard reference view stays marked implemented', () => {
    // Was "exactly one leaf is implemented" back when Fleet Dashboard was the
    // foundation's only built view. Multiple view agents now build against
    // this same config in parallel, each flipping their own leaf(s) to
    // `implemented: true` as they land — a fixed count here would just be a
    // race between agents' PRs. The invariant that still matters: the
    // reference view never regresses back to a placeholder, and at least one
    // leaf is implemented (the config isn't accidentally fully unbuilt).
    const implemented = ALL_NAV_LEAVES.filter((l) => l.implemented);
    expect(implemented.length).toBeGreaterThan(0);
    expect(implemented.some((l) => l.path === '/overview')).toBe(true);
  });

  it('every group has at least one leaf', () => {
    for (const group of NAV_GROUPS) {
      expect(group.leaves.length).toBeGreaterThan(0);
    }
  });
});
