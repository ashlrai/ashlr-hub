import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../src/core/types.js';
import { isNonCodeMarkerItem, isNonCodePath, isTrivialItem } from '../src/core/portfolio/value-filter.js';

function item(title: string, detail = 'File marker: "TODO: preserve deterministic ordering for pending batches".'): WorkItem {
  return { id: 'marker-path', repo: '/fixture/repo', source: 'todo', title, detail,
    value: 3, effort: 2, score: 1.5, tags: ['todo'], ts: '2026-09-10T00:00:00.000Z' };
}

const nonCodePaths = [
  'Release Notes.md', 'notes/release notes.txt', 'src/über component.test.ts', 'src/My Component.spec.ts',
  'src/my:file.test.ts', 'docs\\guide.ts', 'src\\tests\\helper.ts', 'C:\\repo\\docs\\guide.ts',
  'C:\\repo\\src\\My Component.test.ts', 'C:/repo/docs/guide.ts', 'fixtures/example data.ts',
  'third-party/utility.ts', 'python-lib/helpers.ts',
];
const sourcePaths = [
  'src/My Component.ts', 'src/über component.ts', 'src/my:file.ts', 'C:\\repo\\src\\handler.ts',
  'src/docs-handler.ts', 'src/contest.ts', 'src/scanner.test-helpers.ts', 'packages/app/src/worker.ts',
  // This repair preserves the existing raw-path policy; underscore libraries are not newly excluded.
  'python_lib/helpers.ts',
];

describe('marker titles preserve the complete raw path policy', () => {
  for (const [prefix, location] of [['1 marker in', ':17'], ['2 markers in', ''], ['2 MARKERS IN', ':17:8']] as const) {
    it.each(nonCodePaths)(`${prefix} %s${location} filters a substantive non-code marker`, path => {
      expect(isNonCodePath(path)).toBe(true);
      const value = item(`${prefix} ${path}${location}`);
      expect(isNonCodeMarkerItem(value)).toBe(true);
      expect(isTrivialItem(value)).toMatchObject({ trivial: true, reason: expect.stringContaining('non-code-marker') });
    });
    it.each(sourcePaths)(`${prefix} %s${location} preserves substantive source work`, path => {
      expect(isNonCodePath(path)).toBe(false);
      const value = item(`${prefix} ${path}${location}`);
      expect(isNonCodeMarkerItem(value)).toBe(false); expect(isTrivialItem(value).trivial).toBe(false);
    });
  }

  it.each(['Implement docs/guide.ts behavior', '1 marker in ', '1 marker in', 'marker in docs/guide.ts',
    'Discuss 1 marker in docs/guide.ts'])('does not reinterpret non-marker/empty title %s', title => {
    expect(isNonCodeMarkerItem(item(title))).toBe(false);
  });
  it('strips numeric locations without treating arbitrary colon text as a location', () => {
    expect(isNonCodeMarkerItem(item('1 marker in notes/release notes.md:17:8'))).toBe(true);
    expect(isNonCodeMarkerItem(item('1 marker in notes/release notes.md:summary'))).toBe(false);
    expect(isNonCodeMarkerItem(item('1 marker in src/my:file.test.ts:17:8'))).toBe(true);
    expect(isNonCodeMarkerItem(item('1 marker in src/my:file.ts:17:8'))).toBe(false);
  });
  it.each(['Security vulnerability must be addressed.', 'Breaking change requires a migration guide.'])(
    'preserves the existing exception: %s', detail => {
      const value = item('1 marker in Release Notes.md:17', detail);
      expect(isNonCodeMarkerItem(value)).toBe(true); expect(isTrivialItem(value).trivial).toBe(false);
    });
  it('does not change ordinary test failures, bare source markers or comment-only requests', () => {
    expect(isTrivialItem(item('CI is failing', 'test("preserves pending ordering") fails.')).trivial).toBe(false);
    expect(isTrivialItem(item('1 marker in src/batch.ts:17', '"TODO:"')).trivial).toBe(true);
    expect(isTrivialItem(item('Add a doc-comment', 'Describe this helper.')).trivial).toBe(true);
    expect(isTrivialItem(item('CI is failing', 'Please investigate.')).trivial).toBe(true);
  });
});
