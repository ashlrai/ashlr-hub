import { describe, expect, it } from 'vitest';
import type { VerseCheckpointDiffFile, VerseCheckpointPreviewResponse } from '../../../../core/verse/checkpoint-types.js';
import { groupByDirectory, initialResolutions, planCounts, totals, undecided, wordDiff } from './changes-model.js';

const file = (path: string, over: Partial<VerseCheckpointDiffFile> = {}): VerseCheckpointDiffFile => ({
  path,
  oldPath: null,
  status: 'M',
  additions: 1,
  deletions: 1,
  binary: false,
  captured: true,
  editedAfterTurn: false,
  accepted: false,
  ...over,
});

describe('wordDiff', () => {
  it('marks only the words that changed, on both sides', () => {
    const w = wordDiff('const total = count + 1;', 'const total = counts + 2;');
    expect(w).not.toBeNull();
    const pick = (s: string, spans: Array<[number, number]>) => spans.map(([a, b]) => s.slice(a, b));
    expect(pick('const total = count + 1;', w!.old)).toEqual(['count', '1']);
    expect(pick('const total = counts + 2;', w!.new)).toEqual(['counts', '2']);
  });

  it('merges neighbouring changed words into one span', () => {
    const w = wordDiff('a b c d', 'a x y d');
    expect(w!.new).toEqual([[2, 5]]);
  });

  it('gives up on equal, empty or wholly different lines', () => {
    expect(wordDiff('same', 'same')).toBeNull();
    expect(wordDiff('', 'x')).toBeNull();
    expect(wordDiff('alpha beta gamma', 'one two three four')).toBeNull();
  });
});

describe('file tree', () => {
  it('groups by directory, root first, both levels sorted', () => {
    const groups = groupByDirectory([file('src/b.ts'), file('README.md'), file('src/a.ts'), file('lib/x/y.ts')]);
    expect(groups.map((g) => [g.dir, g.files.map((f) => f.name)])).toEqual([
      ['', ['README.md']],
      ['lib/x', ['y.ts']],
      ['src', ['a.ts', 'b.ts']],
    ]);
    expect(totals([file('a', { additions: 3, deletions: 2 }), file('b', { additions: 1, deletions: 0 })])).toEqual({ files: 2, additions: 4, deletions: 2 });
  });
});

describe('undo plan bookkeeping', () => {
  const preview: VerseCheckpointPreviewResponse = {
    previewId: 'abc12345',
    kind: 'undo',
    chatId: 'c',
    turnId: 't',
    expiresAt: '',
    roots: [
      {
        rootId: 'r1',
        apply: [{ path: 'a', action: 'restore' }, { path: 'n', action: 'delete' }],
        conflicts: [
          { path: 'clean', action: 'restore', kind: 'edited-after', merge: { clean: true, text: 'x', conflicts: 0 }, diff: '' },
          { path: 'dirty', action: 'restore', kind: 'edited-after', merge: { clean: false, text: '<<<', conflicts: 1 }, diff: '' },
        ],
        kept: ['k'],
        uncaptured: [],
        unavailable: null,
      },
      { rootId: 'r2', apply: [], conflicts: [], kept: [], uncaptured: [], unavailable: 'No checkpoint.' },
    ],
  };

  it('starts clean merges on "merge" and leaves the rest undecided', () => {
    const r = initialResolutions(preview);
    expect(r).toEqual({ r1: { clean: 'merge' }, r2: {} });
    expect(undecided(preview, r)).toEqual(['dirty']);
    expect(undecided(preview, { r1: { clean: 'merge', dirty: 'keep' } })).toEqual([]);
  });

  it('counts what the plan does', () => {
    expect(planCounts(preview)).toEqual({ restore: 1, remove: 1, conflicts: 2, kept: 1, uncaptured: 0, unavailable: 1 });
  });
});
