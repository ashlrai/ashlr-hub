/**
 * terminal/file-links.ts — `file:line[:col]` references in terminal output
 * (3.15). Clicking one opens the file in the operator's editor; the SERVER
 * decides whether it may (POST …/open-file: inside the chat's roots only).
 *
 * Recognised, as compilers, test runners and stack traces print them:
 *   src/app.ts:12:5   ./a.js:3   /abs/x.py:10   ~/p/y.rs:4:2
 *   src/app.ts(12,5)                    (tsc, MSBuild)
 *   at fn (/path/file.js:10:15)         (node stack; the parens are not the link)
 *   File "/path/x.py", line 12          (Python traceback)
 *   src/app.ts                           (a bare path — only with a `/`)
 *
 * NOT recognised: a bare `name.ext` with no line and no directory (every
 * "node.js" or "v1.2" in prose would light up), and anything that is part of
 * a URL (`https://host/a.js` is the web-links addon's).
 */

export interface FileLink {
  /** As printed (`~/…` and relative paths are resolved by the server). */
  path: string;
  line: number | null;
  column: number | null;
  /** [start, end) in the line's text. */
  start: number;
  end: number;
}

const PATH = String.raw`(?:~|\.{1,2})?\/?(?:[\w.@+\-]+\/)*[\w.@+\-]*[\w@+\-]\.[A-Za-z0-9]{1,12}`;
// `path:line[:col]` or `path(line,col)`. The look-behind keeps URL tails and
// longer words out; the look-ahead stops `a.ts:12abc` from counting.
const FILE_RE = new RegExp(String.raw`(?<![\w/.~:\-@])(${PATH})(?::(\d{1,7})(?::(\d{1,5}))?|\((\d{1,7}),(\d{1,5})\))?(?![\w/])`, 'g');
const PYTHON_RE = /File "([^"\n]{1,1024})", line (\d{1,7})/g;

function inUrl(text: string, index: number): boolean {
  // The token this match sits in, back to the previous whitespace or quote.
  let i = index;
  while (i > 0 && !/[\s"'`(<[]/.test(text[i - 1]!)) i--;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(i, index + 1)) || /^[a-z][a-z0-9+.-]*:\/\//i.test(text.slice(i));
}

/** Every file reference in one line of terminal text, left to right, non-overlapping. */
export function findFileLinks(text: string): FileLink[] {
  const out: FileLink[] = [];
  if (text.length === 0 || text.length > 4096) return out;

  for (const m of text.matchAll(PYTHON_RE)) {
    out.push({ path: m[1]!, line: Number(m[2]), column: null, start: m.index!, end: m.index! + m[0].length });
  }

  for (const m of text.matchAll(FILE_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (out.some((l) => start < l.end && end > l.start)) continue;
    const path = m[1]!;
    const line = m[2] ?? m[4];
    const col = m[3] ?? m[5];
    // A bare name with no line and no directory is prose, not a path.
    if (line === undefined && !path.includes('/')) continue;
    // A version string (v1.2.3) or a number (3.14) is not a file.
    if (/^v?\d+(?:\.\d+)+$/.test(path)) continue;
    if (inUrl(text, start)) continue;
    out.push({
      path,
      line: line === undefined ? null : Number(line),
      column: col === undefined ? null : Number(col),
      start,
      end,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}
