/**
 * routes/verse/chat/line-diff.ts — a unified diff for edits that never came
 * with one.
 *
 * `routes/inbox/diff-parser.ts` parses unified diffs and `DiffViewer.tsx`
 * renders them; neither is rewritten here. What is missing for the chat
 * transcript is the other direction: an `Edit` tool call carries
 * `old_string` / `new_string`, a `Write` carries `content`, and nothing in
 * the payload is a diff. This module produces the unified-diff TEXT for
 * those, so the existing parser and highlighter do the rest.
 *
 * Honesty (DESIGN §6). A tool payload says what was replaced, never where in
 * the file it sat, so the emitted hunk header starts at line 1 and callers
 * are told the result is `anchored: false`; the viewer then hides the
 * line-number gutter rather than printing numbers that are not the file's.
 *
 * Pure, no React, no DOM.
 */

/** Above this many lines on either side the LCS table is too large to be
 * worth it, and a wholesale replacement is a truthful rendering anyway. */
const LCS_LINE_LIMIT = 1200;

export type DiffOp = { kind: 'same' | 'add' | 'del'; text: string };

/**
 * Longest-common-subsequence line diff. O(n·m) time and memory, which is why
 * `LCS_LINE_LIMIT` exists; past it the caller gets one delete-all/add-all
 * block, which is what a wholesale rewrite genuinely is.
 */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return newLines.map((text) => ({ kind: 'add' as const, text }));
  if (m === 0) return oldLines.map((text) => ({ kind: 'del' as const, text }));
  if (n > LCS_LINE_LIMIT || m > LCS_LINE_LIMIT) {
    return [
      ...oldLines.map((text) => ({ kind: 'del' as const, text })),
      ...newLines.map((text) => ({ kind: 'add' as const, text })),
    ];
  }

  // Trim the common prefix/suffix first: edits are usually local, and this
  // keeps the table small for the cases that matter most.
  let start = 0;
  while (start < n && start < m && oldLines[start] === newLines[start]) start++;
  let endOld = n - 1;
  let endNew = m - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }

  const a = oldLines.slice(start, endOld + 1);
  const b = newLines.slice(start, endNew + 1);
  const rows = a.length;
  const cols = b.length;
  const width = cols + 1;
  const table = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + (j + 1)]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const ops: DiffOp[] = [];
  for (let k = 0; k < start; k++) ops.push({ kind: 'same', text: oldLines[k]! });
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      ops.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < rows) ops.push({ kind: 'del', text: a[i++]! });
  while (j < cols) ops.push({ kind: 'add', text: b[j++]! });
  for (let k = endOld + 1; k < n; k++) ops.push({ kind: 'same', text: oldLines[k]! });
  return ops;
}

export interface UnifiedDiffOptions {
  /** Path written into the `---`/`+++` headers. */
  path: string;
  /** Context lines kept around each change. */
  context?: number;
  /** Free text after the `@@` markers (e.g. `edit 2 of 3`). */
  section?: string;
  /** 1-based line the old side starts at, when it is genuinely known. */
  oldStart?: number;
  /** 1-based line the new side starts at, when it is genuinely known. */
  newStart?: number;
}

/**
 * Render ops as unified-diff text. Unchanged runs longer than 2×context
 * collapse into separate hunks, exactly as `diff -u` does, so an edit deep
 * in a long block does not drag the whole block into the view.
 */
export function toUnifiedDiff(ops: readonly DiffOp[], options: UnifiedDiffOptions): string {
  const context = Math.max(0, options.context ?? 3);
  const baseOld = options.oldStart ?? 1;
  const baseNew = options.newStart ?? 1;
  if (ops.length === 0 || !ops.some((op) => op.kind !== 'same')) return '';

  // Index every op with the line numbers it occupies on each side.
  interface Placed extends DiffOp { oldNo: number; newNo: number }
  const placed: Placed[] = [];
  let oldNo = baseOld;
  let newNo = baseNew;
  for (const op of ops) {
    placed.push({ ...op, oldNo, newNo });
    if (op.kind !== 'add') oldNo++;
    if (op.kind !== 'del') newNo++;
  }

  // Group changed ops into runs, each padded by `context` unchanged lines,
  // merging runs whose padding overlaps.
  const ranges: Array<{ from: number; to: number }> = [];
  for (let k = 0; k < placed.length; k++) {
    if (placed[k]!.kind === 'same') continue;
    const from = Math.max(0, k - context);
    const to = Math.min(placed.length - 1, k + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  const out: string[] = [`--- a/${options.path}`, `+++ b/${options.path}`];
  for (const range of ranges) {
    const slice = placed.slice(range.from, range.to + 1);
    const oldCount = slice.filter((op) => op.kind !== 'add').length;
    const newCount = slice.filter((op) => op.kind !== 'del').length;
    const firstOld = slice.find((op) => op.kind !== 'add')?.oldNo ?? baseOld;
    const firstNew = slice.find((op) => op.kind !== 'del')?.newNo ?? baseNew;
    const section = options.section ? ` ${options.section}` : '';
    out.push(`@@ -${oldCount === 0 ? firstOld - 1 : firstOld},${oldCount} +${newCount === 0 ? firstNew - 1 : firstNew},${newCount} @@${section}`);
    for (const op of slice) out.push(`${op.kind === 'add' ? '+' : op.kind === 'del' ? '-' : ' '}${op.text}`);
  }
  return out.join('\n');
}

/** `old` → `new` as unified-diff text, or `''` when they are identical. */
export function unifiedDiffFor(oldText: string, newText: string, options: UnifiedDiffOptions): string {
  if (oldText === newText) return '';
  return toUnifiedDiff(diffLines(splitLines(oldText), splitLines(newText)), options);
}

/** Split preserving empty lines; a lone trailing newline is not a line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
