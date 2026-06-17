/**
 * test/m67.security-panel.test.ts — M67: Security panel unit tests.
 *
 * Tests buildSecurity() aggregation purely from seeded WorkItem data.
 * No network, no live binshield, no real ~/.ashlr reads.
 *
 * Strategy: mock `../src/core/portfolio/backlog.js` so that `loadBacklog()`
 * returns an in-memory Backlog we control, then call the real `buildSecurity()`
 * from control.ts. All assertions run against the pure aggregation logic.
 *
 * Invariants proven:
 *   - Returns the correct shape (available, findings, counts).
 *   - Never throws on empty/missing/malformed backlog.
 *   - available:false when loadBacklog returns null.
 *   - available:false when no security-source items exist.
 *   - Counts aggregate correctly across seeded findings.
 *   - Severity derived from tags[2] per the binshield scanner convention.
 *   - Findings sorted critical-first.
 *   - finding.repo is the basename of WorkItem.repo.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkItem, Backlog } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock loadBacklog before importing control.ts so the module sees our mock.
// ---------------------------------------------------------------------------

vi.mock('../src/core/portfolio/backlog.js', () => ({
  loadBacklog: vi.fn(),
}));

import { loadBacklog } from '../src/core/portfolio/backlog.js';
import { buildSecurity } from '../src/core/web/control.js';

const mockLoadBacklog = vi.mocked(loadBacklog);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'source' | 'title' | 'tags'>): WorkItem {
  return {
    id: `repo:${overrides.source}:abc`,
    repo: '/home/user/my-project',
    source: overrides.source,
    title: overrides.title,
    detail: 'test detail',
    value: 3,
    effort: 2,
    score: 1.5,
    tags: overrides.tags,
    ts: new Date().toISOString(),
    ...overrides,
  };
}

function makeBacklog(items: WorkItem[]): Backlog {
  return {
    generatedAt: new Date().toISOString(),
    repos: ['/home/user/my-project'],
    items,
  };
}

beforeEach(() => {
  mockLoadBacklog.mockReturnValue(null);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M67 buildSecurity()', () => {

  it('returns the correct shape', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ source: 'security', title: 'CVE-001', tags: ['security', 'binshield', 'critical'] }),
    ]));
    const result = buildSecurity();

    expect(result).toHaveProperty('available');
    expect(result).toHaveProperty('findings');
    expect(result).toHaveProperty('counts');
    expect(result.counts).toHaveProperty('critical');
    expect(result.counts).toHaveProperty('high');
    expect(result.counts).toHaveProperty('medium');
    expect(result.counts).toHaveProperty('low');
    expect(Array.isArray(result.findings)).toBe(true);
    expect(typeof result.available).toBe('boolean');
  });

  it('never throws when loadBacklog returns null', () => {
    mockLoadBacklog.mockReturnValue(null);
    expect(() => buildSecurity()).not.toThrow();
  });

  it('never throws when loadBacklog throws', () => {
    mockLoadBacklog.mockImplementation(() => { throw new Error('disk error'); });
    expect(() => buildSecurity()).not.toThrow();
  });

  it('returns available:false when backlog is null', () => {
    mockLoadBacklog.mockReturnValue(null);
    const result = buildSecurity();
    expect(result.available).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.counts.critical).toBe(0);
    expect(result.counts.high).toBe(0);
    expect(result.counts.medium).toBe(0);
    expect(result.counts.low).toBe(0);
  });

  it('returns available:false when backlog has no security-source items', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ source: 'dep', title: 'Outdated lodash', tags: ['dep', 'npm-audit'] }),
      makeItem({ id: 'r:t:0', source: 'todo', title: 'TODO: fix this', tags: ['todo'] }),
    ]));
    const result = buildSecurity();
    expect(result.available).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it('returns available:false when backlog items array is empty', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([]));
    const result = buildSecurity();
    expect(result.available).toBe(false);
  });

  it('returns available:true when security-source items are present', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ source: 'security', title: 'Supply chain risk', tags: ['security', 'binshield', 'high'] }),
    ]));
    const result = buildSecurity();
    expect(result.available).toBe(true);
    expect(result.findings).toHaveLength(1);
  });

  it('counts aggregate correctly across mixed severities', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ id: 'r:s:0', source: 'security', title: 'A', tags: ['security', 'binshield', 'critical'] }),
      makeItem({ id: 'r:s:1', source: 'security', title: 'B', tags: ['security', 'binshield', 'critical'] }),
      makeItem({ id: 'r:s:2', source: 'security', title: 'C', tags: ['security', 'binshield', 'high'] }),
      makeItem({ id: 'r:s:3', source: 'security', title: 'D', tags: ['security', 'binshield', 'medium'] }),
      makeItem({ id: 'r:s:4', source: 'security', title: 'E', tags: ['security', 'binshield', 'low'] }),
      makeItem({ id: 'r:s:5', source: 'security', title: 'F', tags: ['security', 'binshield', 'low'] }),
    ]));
    const result = buildSecurity();
    expect(result.counts.critical).toBe(2);
    expect(result.counts.high).toBe(1);
    expect(result.counts.medium).toBe(1);
    expect(result.counts.low).toBe(2);
    expect(result.findings).toHaveLength(6);
  });

  it('findings are sorted critical-first', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ id: 'r:s:0', source: 'security', title: 'Low finding',      tags: ['security', 'binshield', 'low'] }),
      makeItem({ id: 'r:s:1', source: 'security', title: 'Critical finding', tags: ['security', 'binshield', 'critical'] }),
      makeItem({ id: 'r:s:2', source: 'security', title: 'High finding',     tags: ['security', 'binshield', 'high'] }),
    ]));
    const result = buildSecurity();
    expect(result.findings[0].severity).toBe('critical');
    expect(result.findings[1].severity).toBe('high');
    expect(result.findings[2].severity).toBe('low');
  });

  it('finding.repo is the basename of the WorkItem.repo path', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ source: 'security', title: 'X', tags: ['security', 'binshield', 'high'], repo: '/Users/me/projects/my-app' }),
    ]));
    const result = buildSecurity();
    expect(result.findings[0].repo).toBe('my-app');
  });

  it('non-security items in backlog are excluded from findings', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ id: 'r:s:0', source: 'security', title: 'Sec finding', tags: ['security', 'binshield', 'medium'] }),
      makeItem({ id: 'r:d:0', source: 'dep',      title: 'Dep issue',   tags: ['dep'] }),
      makeItem({ id: 'r:t:0', source: 'todo',     title: 'TODO',        tags: ['todo'] }),
    ]));
    const result = buildSecurity();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].title).toBe('Sec finding');
  });

  it('severity falls back gracefully when tags[2] is not a known keyword', () => {
    mockLoadBacklog.mockReturnValue(makeBacklog([
      makeItem({ source: 'security', title: 'Mystery', tags: ['security', 'binshield', 'unknown-sev'] }),
    ]));
    const result = buildSecurity();
    // Falls through to the low bucket (the else branch)
    expect(result.counts.low).toBe(1);
    expect(result.findings[0].severity).toBe('unknown-sev');
  });

});
