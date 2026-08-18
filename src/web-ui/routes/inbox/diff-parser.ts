/**
 * routes/inbox/diff-parser.ts — pure parsing of a unified diff string
 * (Proposal.diff, src/core/types.ts) into a per-file, per-hunk structure the
 * DiffViewer can render with a file tree and syntax highlighting, instead of
 * dumping the raw string into an escaped <pre> block (the old UI's
 * approach — "not acceptable for a tool meant to be elite" per the
 * operator-console brief). No dependency: hand-rolled parser over the
 * unified diff format, which is regular enough (`--- `/`+++ `/`@@ `/leading
 * `-`/`+`/` `) that a small line-scan state machine covers it completely.
 *
 * Pure functions only — no React, no DOM — so this is trivially unit
 * testable (see diff-parser.test.ts) independent of rendering.
 */

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type FileChangeStatus = 'added' | 'deleted' | 'renamed' | 'modified';

export interface DiffFile {
  /** Stable key for React lists / file-tree selection. */
  id: string;
  oldPath: string | null;
  newPath: string | null;
  /** The path to show — newPath, falling back to oldPath for deletes. */
  displayPath: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  /** Raw text that didn't parse as hunks (e.g. a "Binary files differ"
   * notice) — preserved verbatim so nothing is silently dropped. */
  unparsedNotice: string | null;
}

export interface ParsedDiff {
  files: DiffFile[];
  /** True when the input didn't look like a unified diff at all (no
   * `--- `/`+++ ` pairs found) — the raw string is returned as one
   * unparsed "file" so the viewer can still show *something*. */
  malformed: boolean;
}

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|(\/dev\/null))\s*$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|(\/dev\/null))\s*$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPathPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/** Split raw text into per-file chunks: before each `diff --git` line if
 * any are present, otherwise before each `--- ` line. */
function splitFileChunks(text: string): string[] {
  const lines = text.split('\n');
  const hasGitHeaders = lines.some((l) => FILE_HEADER_RE.test(l));
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (hasGitHeaders ? FILE_HEADER_RE.test(line) : OLD_PATH_RE.test(line)) starts.push(i);
  }
  if (starts.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]!;
    const to = i + 1 < starts.length ? starts[i + 1]! : lines.length;
    chunks.push(lines.slice(from, to).join('\n'));
  }
  return chunks;
}

function parseFileChunk(chunk: string, index: number): DiffFile {
  const lines = chunk.split('\n');
  // A trailing '\n' in the source text produces one trailing empty array
  // element that is never real diff content — every genuine line (context/
  // add/del) carries at least its 1-char marker (' '/'+'/'-'), so an empty
  // string here can only be that artifact. Drop it before parsing so it
  // isn't mistaken for a blank context line inside the last hunk.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let bodyStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const oldMatch = OLD_PATH_RE.exec(line);
    if (oldMatch) {
      oldPath = oldMatch[2] ? null : stripPathPrefix(oldMatch[1]!);
      continue;
    }
    const newMatch = NEW_PATH_RE.exec(line);
    if (newMatch) {
      newPath = newMatch[2] ? null : stripPathPrefix(newMatch[1]!);
      bodyStart = i + 1;
      break;
    }
    const gitHeader = FILE_HEADER_RE.exec(line);
    if (gitHeader && oldPath === null && newPath === null) {
      // Fallback path source used only if the chunk never reaches a proper
      // `+++` line (e.g. a binary-file notice with no hunks at all).
      oldPath = gitHeader[1] ?? null;
      newPath = gitHeader[2] ?? null;
    }
  }

  let status: FileChangeStatus = 'modified';
  if (oldPath === null && newPath !== null) status = 'added';
  else if (oldPath !== null && newPath === null) status = 'deleted';
  else if (oldPath !== null && newPath !== null && oldPath !== newPath) status = 'renamed';

  const displayPath = newPath ?? oldPath ?? `(unknown file ${index + 1})`;

  const hunks: DiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let unparsedNotice: string | null = null;

  if (bodyStart === -1) {
    // Never found a `+++` line at all — likely a binary-file notice or a
    // chunk this parser doesn't understand. Preserve it verbatim.
    const trimmed = lines.join('\n').trim();
    return {
      id: `${index}:${displayPath}`,
      oldPath,
      newPath,
      displayPath,
      status,
      hunks: [],
      additions: 0,
      deletions: 0,
      unparsedNotice: trimmed || null,
    };
  }

  let i = bodyStart;
  while (i < lines.length) {
    const header = HUNK_HEADER_RE.exec(lines[i]!);
    if (!header) {
      // Stray text between the file header and the first hunk (rare) —
      // fold into the notice rather than lose it.
      if (lines[i]!.trim()) {
        unparsedNotice = ((unparsedNotice ? unparsedNotice + '\n' : '') + lines[i]).trim();
      }
      i++;
      continue;
    }
    const oldStart = Number(header[1]);
    const oldLines = header[2] !== undefined ? Number(header[2]) : 1;
    const newStart = Number(header[3]);
    const newLines = header[4] !== undefined ? Number(header[4]) : 1;
    const hunk: DiffHunk = { header: lines[i]!, oldStart, oldLines, newStart, newLines, lines: [] };
    i++;
    let oldNo = oldStart;
    let newNo = newStart;
    while (i < lines.length && !HUNK_HEADER_RE.test(lines[i]!)) {
      const raw = lines[i]!;
      if (raw.startsWith('\\')) {
        i++;
        continue; // "\ No newline at end of file"
      }
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === '+') {
        hunk.lines.push({ kind: 'add', text, oldLineNo: null, newLineNo: newNo });
        newNo++;
        additions++;
      } else if (marker === '-') {
        hunk.lines.push({ kind: 'del', text, oldLineNo: oldNo, newLineNo: null });
        oldNo++;
        deletions++;
      } else {
        // Context line (leading space), or an empty line inside a hunk.
        hunk.lines.push({ kind: 'context', text: marker === ' ' ? text : raw, oldLineNo: oldNo, newLineNo: newNo });
        oldNo++;
        newNo++;
      }
      i++;
    }
    hunks.push(hunk);
  }

  return { id: `${index}:${displayPath}`, oldPath, newPath, displayPath, status, hunks, additions, deletions, unparsedNotice };
}

export function parseUnifiedDiff(raw: string | undefined | null): ParsedDiff {
  const text = raw ?? '';
  if (!text.trim()) return { files: [], malformed: false };
  const chunks = splitFileChunks(text);
  if (chunks.length === 0) {
    return {
      malformed: true,
      files: [
        {
          id: 'raw',
          oldPath: null,
          newPath: null,
          displayPath: '(unparsed diff)',
          status: 'modified',
          hunks: [],
          additions: 0,
          deletions: 0,
          unparsedNotice: text,
        },
      ],
    };
  }
  return { files: chunks.map((c, idx) => parseFileChunk(c, idx)), malformed: false };
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Zip a hunk's lines into side-by-side rows for the split view: a run of
 * consecutive deletions is paired with the following run of consecutive
 * additions (the usual shape of a changed block), padding the shorter side
 * with a blank cell. Pure context lines occupy both sides identically. */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') {
      dels.push(lines[i]!);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'add') {
      adds.push(lines[i]!);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
  }
  return rows;
}
