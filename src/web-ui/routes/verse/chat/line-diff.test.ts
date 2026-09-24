import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../../inbox/diff-parser.js';
import { diffLines, intralineSpans, splitLines, toUnifiedDiff, unifiedDiffFor } from './line-diff.js';

describe('splitLines', () => {
  it('keeps empty lines but not the artefact of a trailing newline', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(splitLines('a\n')).toEqual(['a']);
  });
});

describe('diffLines', () => {
  it('keeps the unchanged lines and marks only what moved', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(ops.map((o) => `${o.kind}:${o.text}`)).toEqual(['same:a', 'del:b', 'add:B', 'same:c']);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(diffLines([], ['x'])).toEqual([{ kind: 'add', text: 'x' }]);
    expect(diffLines(['x'], [])).toEqual([{ kind: 'del', text: 'x' }]);
    expect(diffLines([], [])).toEqual([]);
  });

  it('finds the common subsequence rather than replacing everything', () => {
    const ops = diffLines(['1', '2', '3', '4', '5'], ['1', '3', '4', '9', '5']);
    expect(ops.filter((o) => o.kind === 'same').map((o) => o.text)).toEqual(['1', '3', '4', '5']);
    expect(ops.filter((o) => o.kind === 'del').map((o) => o.text)).toEqual(['2']);
    expect(ops.filter((o) => o.kind === 'add').map((o) => o.text)).toEqual(['9']);
  });
});

describe('unifiedDiffFor', () => {
  it('produces text the inbox parser reads back as the same change', () => {
    const before = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
    const after = ['const a = 1;', 'const b = 22;', 'const c = 3;'].join('\n');
    const text = unifiedDiffFor(before, after, { path: 'src/x.ts' });
    const parsed = parseUnifiedDiff(text);
    expect(parsed.malformed).toBe(false);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0]!;
    expect(file.displayPath).toBe('src/x.ts');
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.hunks[0]!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'context:const a = 1;',
      'del:const b = 2;',
      'add:const b = 22;',
      'context:const c = 3;',
    ]);
  });

  it('returns nothing when the two sides are identical', () => {
    expect(unifiedDiffFor('same', 'same', { path: 'a.ts' })).toBe('');
  });

  it('splits distant changes into separate hunks instead of one huge block', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const after = before.split('\n').map((l, i) => (i === 2 || i === 30 ? `${l} changed` : l)).join('\n');
    const parsed = parseUnifiedDiff(unifiedDiffFor(before, after, { path: 'a.ts', context: 2 }));
    expect(parsed.files[0]!.hunks).toHaveLength(2);
    expect(parsed.files[0]!.additions).toBe(2);
    expect(parsed.files[0]!.deletions).toBe(2);
  });

  it('carries the section text into the hunk header', () => {
    const text = unifiedDiffFor('a', 'b', { path: 'a.ts', section: 'edit 2 of 3' });
    expect(text).toContain('@@ -1,1 +1,1 @@ edit 2 of 3');
  });

  it('degrades a very large rewrite to delete-all/add-all rather than hanging', () => {
    const before = Array.from({ length: 1400 }, (_, i) => `a${i}`);
    const after = Array.from({ length: 1400 }, (_, i) => `b${i}`);
    const ops = diffLines(before, after);
    expect(ops.filter((o) => o.kind === 'del')).toHaveLength(1400);
    expect(ops.filter((o) => o.kind === 'add')).toHaveLength(1400);
    expect(ops.some((o) => o.kind === 'same')).toBe(false);
  });
});

describe('toUnifiedDiff', () => {
  it('emits nothing when there is no change to emit', () => {
    expect(toUnifiedDiff([{ kind: 'same', text: 'a' }], { path: 'a.ts' })).toBe('');
    expect(toUnifiedDiff([], { path: 'a.ts' })).toBe('');
  });

  it('honours an explicit anchor so a known offset survives the round trip', () => {
    const text = toUnifiedDiff(
      [{ kind: 'same', text: 'x' }, { kind: 'add', text: 'y' }],
      { path: 'a.ts', oldStart: 100, newStart: 100 },
    );
    const hunk = parseUnifiedDiff(text).files[0]!.hunks[0]!;
    expect(hunk.oldStart).toBe(100);
    expect(hunk.lines.find((l) => l.kind === 'add')!.newLineNo).toBe(101);
  });
});

describe('intralineSpans (3.10 Review pane)', () => {
  const cut = (line: string, [a, b]: [number, number]) => line.slice(a, b);

  it('emphasises only the changed word, widened to word boundaries', () => {
    const oldLine = 'const count = items.length;';
    const newLine = 'const counts = items.length;';
    const spans = intralineSpans(oldLine, newLine)!;
    expect(cut(oldLine, spans.old)).toBe('count');
    expect(cut(newLine, spans.new)).toBe('counts');
  });

  it('marks a pure insertion as an empty old span', () => {
    const spans = intralineSpans('call(a, b)', 'call(a, b, c)')!;
    expect(spans.old[0]).toBe(spans.old[1]);
    expect(cut('call(a, b, c)', spans.new)).toBe(', c');
  });

  it('declines identical lines, rewrites and very long lines', () => {
    expect(intralineSpans('same', 'same')).toBeNull();
    expect(intralineSpans('import { a } from "x";', 'return total / count;')).toBeNull();
    expect(intralineSpans('x'.repeat(3000), 'y'.repeat(3000))).toBeNull();
  });

  it('never produces an inverted span', () => {
    for (const [a, b] of [['aaa', 'aa'], ['ab', 'aab'], ['foo.bar()', 'foo.baz()'], ['', 'x']]) {
      const s = intralineSpans(a!, b!);
      if (!s) continue;
      expect(s.old[0]).toBeLessThanOrEqual(s.old[1]);
      expect(s.new[0]).toBeLessThanOrEqual(s.new[1]);
    }
  });
});
