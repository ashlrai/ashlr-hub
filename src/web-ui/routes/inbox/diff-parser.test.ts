import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, toSplitRows } from './diff-parser.js';

const SINGLE_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc123..def456 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 line one
-line two
+line two edited
+line two point five
 line three
 line four
`;

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-old a
+new a
 unchanged
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+first line
+second line
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index abc123..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;

const NO_GIT_HEADER_DIFF = `--- a/plain.txt
+++ b/plain.txt
@@ -1,1 +1,1 @@
-before
+after
`;

describe('parseUnifiedDiff', () => {
  it('returns an empty, non-malformed result for an empty/undefined diff', () => {
    expect(parseUnifiedDiff(undefined)).toEqual({ files: [], malformed: false });
    expect(parseUnifiedDiff('')).toEqual({ files: [], malformed: false });
    expect(parseUnifiedDiff('   \n  ')).toEqual({ files: [], malformed: false });
  });

  it('parses a single-file diff into one modified file with correct line numbers', () => {
    const { files, malformed } = parseUnifiedDiff(SINGLE_FILE_DIFF);
    expect(malformed).toBe(false);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.displayPath).toBe('src/foo.ts');
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    expect(f.hunks).toHaveLength(1);
    const lines = f.hunks[0]!.lines;
    expect(lines.map((l) => l.kind)).toEqual(['context', 'del', 'add', 'add', 'context', 'context']);
    expect(lines[0]).toMatchObject({ text: 'line one', oldLineNo: 1, newLineNo: 1 });
    expect(lines[1]).toMatchObject({ text: 'line two', oldLineNo: 2, newLineNo: null });
    expect(lines[2]).toMatchObject({ text: 'line two edited', oldLineNo: null, newLineNo: 2 });
  });

  it('splits a multi-file diff and classifies added/deleted/modified correctly', () => {
    const { files } = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files).toHaveLength(3);
    expect(files[0]).toMatchObject({ displayPath: 'src/a.ts', status: 'modified' });
    expect(files[1]).toMatchObject({ displayPath: 'src/new.ts', status: 'added', oldPath: null });
    expect(files[2]).toMatchObject({ displayPath: 'src/gone.ts', status: 'deleted', newPath: null });
    expect(files[1]!.hunks[0]!.lines).toHaveLength(2);
  });

  it('parses a diff with no `diff --git` headers by splitting on `--- ` lines', () => {
    const { files, malformed } = parseUnifiedDiff(NO_GIT_HEADER_DIFF);
    expect(malformed).toBe(false);
    expect(files).toHaveLength(1);
    expect(files[0]!.displayPath).toBe('plain.txt');
  });

  it('marks genuinely unparseable input as malformed but preserves the raw text', () => {
    const raw = 'This is not a diff at all, just prose.';
    const { files, malformed } = parseUnifiedDiff(raw);
    expect(malformed).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]!.unparsedNotice).toBe(raw);
  });
});

describe('toSplitRows', () => {
  it('pairs equal-length del/add runs one-to-one', () => {
    const { files } = parseUnifiedDiff(SINGLE_FILE_DIFF);
    const rows = toSplitRows(files[0]!.hunks[0]!.lines);
    // context, [del vs add], [blank vs add], context, context
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ left: { kind: 'context' }, right: { kind: 'context' } });
    expect(rows[1]!.left).toMatchObject({ kind: 'del', text: 'line two' });
    expect(rows[1]!.right).toMatchObject({ kind: 'add', text: 'line two edited' });
    expect(rows[2]!.left).toBeNull();
    expect(rows[2]!.right).toMatchObject({ kind: 'add', text: 'line two point five' });
  });

  it('pads a pure-addition run on the left with nulls', () => {
    const { files } = parseUnifiedDiff(MULTI_FILE_DIFF);
    const addedFile = files.find((f) => f.status === 'added')!;
    const rows = toSplitRows(addedFile.hunks[0]!.lines);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.left).toBeNull();
      expect(row.right).not.toBeNull();
    }
  });
});
