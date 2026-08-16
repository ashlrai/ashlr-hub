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

  it('exactly one leaf is marked implemented (the Fleet Dashboard reference view)', () => {
    const implemented = ALL_NAV_LEAVES.filter((l) => l.implemented);
    expect(implemented).toHaveLength(1);
    expect(implemented[0]?.path).toBe('/overview');
  });

  it('every group has at least one leaf', () => {
    for (const group of NAV_GROUPS) {
      expect(group.leaves.length).toBeGreaterThan(0);
    }
  });
});
