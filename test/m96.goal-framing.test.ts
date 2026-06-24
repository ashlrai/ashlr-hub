/**
 * m96.goal-framing.test.ts — buildItemGoal framing helper.
 *
 * Verifies that buildItemGoal:
 *  1. Always includes the item title.
 *  2. Includes the summary/detail when present and non-duplicate.
 *  3. Always appends the focused-diff / no-op guidance string.
 *  4. Includes repo + source + tags context anchoring when present.
 *  5. Never throws on missing / undefined optional fields.
 *  6. Works correctly for representative item types: skipped-test, issue, TODO.
 */

import { describe, it, expect } from 'vitest';
import type { WorkItem } from '../src/core/types.js';
import { buildItemGoal } from '../src/core/daemon/loop.js';

// ---------------------------------------------------------------------------
// Shared guidance sentinel — substring that must appear in every goal.
// ---------------------------------------------------------------------------
const GUIDANCE_SENTINEL =
  'If on inspection this is NOT actionable as a code change';
const FOCUSED_SENTINEL = 'Make the smallest focused change';
const NOOP_SENTINEL = 'make NO changes and stop';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------
function makeItem(overrides: Partial<WorkItem>): WorkItem {
  return {
    id: 'test:todo:abc123',
    repo: '/home/user/project',
    source: 'todo' as WorkItem['source'],
    title: 'Default title',
    detail: 'Default detail',
    value: 3,
    effort: 2,
    score: 1.5,
    tags: [],
    ts: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
describe('buildItemGoal', () => {
  describe('always includes title + guidance', () => {
    it('contains the item title', () => {
      const item = makeItem({ title: 'Fix the broken import path in utils.ts' });
      const goal = buildItemGoal(item);
      expect(goal).toContain('Fix the broken import path in utils.ts');
    });

    it('contains the focused-diff instruction', () => {
      const goal = buildItemGoal(makeItem({}));
      expect(goal).toContain(FOCUSED_SENTINEL);
    });

    it('contains the no-op guidance', () => {
      const goal = buildItemGoal(makeItem({}));
      expect(goal).toContain(GUIDANCE_SENTINEL);
    });

    it('contains the "make NO changes and stop" escape hatch', () => {
      const goal = buildItemGoal(makeItem({}));
      expect(goal).toContain(NOOP_SENTINEL);
    });
  });

  describe('skipped-test item', () => {
    const item = makeItem({
      id: 'myrepo:todo:skip001',
      repo: '/repos/myrepo',
      source: 'todo' as WorkItem['source'],
      title: 'Un-skip flaky test: m42.something.test.ts line 88',
      detail:
        'Test is marked `it.skip` due to a platform dependency on Darwin only. ' +
        'Either fix the underlying assumption or document why the skip is permanent.',
      tags: ['test', 'skip'],
    });

    it('includes title', () => {
      expect(buildItemGoal(item)).toContain(item.title);
    });

    it('includes detail', () => {
      expect(buildItemGoal(item)).toContain('marked `it.skip`');
    });

    it('includes no-op guidance (platform-gated test example is explicitly named)', () => {
      const goal = buildItemGoal(item);
      expect(goal).toContain('platform-gated');
      expect(goal).toContain(NOOP_SENTINEL);
    });

    it('includes repo anchor', () => {
      expect(buildItemGoal(item)).toContain('Repo: /repos/myrepo');
    });

    it('includes tags', () => {
      expect(buildItemGoal(item)).toContain('test, skip');
    });
  });

  describe('issue item', () => {
    const item = makeItem({
      id: 'proj:issue:42',
      repo: '/repos/proj',
      source: 'issue' as WorkItem['source'],
      title: 'Issue #42: Support dark mode toggle in settings panel',
      detail:
        'Users requested a dark mode toggle. The UI framework supports it via ' +
        'a `theme` prop on <AppRoot>. Requires a product decision on the default.',
      tags: ['ui', 'feature-request'],
    });

    it('includes title', () => {
      expect(buildItemGoal(item)).toContain('Issue #42');
    });

    it('includes detail', () => {
      expect(buildItemGoal(item)).toContain('theme');
    });

    it('names the "product decisions" no-op case explicitly in guidance', () => {
      expect(buildItemGoal(item)).toContain('product decisions');
    });

    it('includes source anchor', () => {
      expect(buildItemGoal(item)).toContain('Source: issue');
    });
  });

  describe('TODO item', () => {
    const item = makeItem({
      id: 'svc:todo:deadcode',
      repo: '/repos/svc',
      source: 'todo' as WorkItem['source'],
      title: 'Remove dead utility: src/utils/legacy-hash.ts',
      detail:
        'No callers found via grep. Safe to delete. ' +
        'Confirm by running: grep -r "legacy-hash" src/',
      tags: ['cleanup', 'dead-code'],
    });

    it('includes title', () => {
      expect(buildItemGoal(item)).toContain('legacy-hash.ts');
    });

    it('includes detail', () => {
      expect(buildItemGoal(item)).toContain('No callers found');
    });

    it('appends focused-diff guidance', () => {
      expect(buildItemGoal(item)).toContain(FOCUSED_SENTINEL);
    });

    it('references tests green instruction', () => {
      expect(buildItemGoal(item)).toContain('tests green');
    });
  });

  describe('robustness — never throws on missing fields', () => {
    it('handles empty detail gracefully', () => {
      const item = makeItem({ detail: '' });
      expect(() => buildItemGoal(item)).not.toThrow();
      const goal = buildItemGoal(item);
      expect(goal).toContain(item.title);
      expect(goal).toContain(GUIDANCE_SENTINEL);
    });

    it('handles detail equal to title (does not double-print)', () => {
      const title = 'Fix thing';
      const item = makeItem({ title, detail: title });
      const goal = buildItemGoal(item);
      // Should appear exactly once, not twice back-to-back
      const firstIdx = goal.indexOf(title);
      const secondIdx = goal.indexOf(title, firstIdx + 1);
      expect(secondIdx).toBe(-1);
    });

    it('handles empty tags array', () => {
      const item = makeItem({ tags: [] });
      expect(() => buildItemGoal(item)).not.toThrow();
      expect(buildItemGoal(item)).not.toContain('Tags:');
    });

    it('handles missing repo gracefully (empty string)', () => {
      const item = makeItem({ repo: '' });
      expect(() => buildItemGoal(item)).not.toThrow();
      const goal = buildItemGoal(item);
      expect(goal).not.toContain('Repo:');
    });

    it('returns a non-empty string for a minimal item', () => {
      const item = makeItem({ title: 'x', detail: '', tags: [], repo: '', source: 'todo' as WorkItem['source'] });
      const goal = buildItemGoal(item);
      expect(typeof goal).toBe('string');
      expect(goal.length).toBeGreaterThan(0);
    });
  });

  describe('output is a plain string — no leakage of internal state', () => {
    it('does not contain undefined or [object Object]', () => {
      const goal = buildItemGoal(makeItem({}));
      expect(goal).not.toContain('undefined');
      expect(goal).not.toContain('[object Object]');
    });

    it('is deterministic — same item always produces same output', () => {
      const item = makeItem({ title: 'Stable title', detail: 'Stable detail' });
      expect(buildItemGoal(item)).toBe(buildItemGoal(item));
    });
  });
});
