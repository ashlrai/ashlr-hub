/**
 * diff.ts — M140: fuzzy patch-apply ladder for edit_file.
 *
 * Replaces the exact-match-or-fail approach with a 4-rung ladder, ported from
 * aider's editblock_coder.py algorithm (MIT licence, algorithm only):
 *
 *   (a) exact          — indexOf(oldString) → trivially fast, zero allocation.
 *   (b) whitespace     — uniform leading-whitespace normalization; handles model
 *                        outdent/indent drift on indented blocks.
 *   (c) elision        — "..." on a line by itself matches any span of lines;
 *                        used when the model elides unchanged middle sections.
 *   (d) fuzzy          — SequenceMatcher-style 0.8-similarity line scan; the
 *                        closest contiguous window is matched when similarity ≥
 *                        FUZZY_THRESHOLD.
 *
 * On total failure the caller receives a structured ApplyResult with
 * ok:false and a `hint` field pointing at the closest lines in the file so
 * the model can self-correct without re-reading the whole file.
 *
 * PURITY: no I/O, no process.env, no external deps — pure string transforms.
 * The caller (handleEditFile in mcp-native-engineer.ts) owns the fs ops.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApplyRung = 'exact' | 'whitespace' | 'elision' | 'fuzzy' | 'failed';

export interface ApplyResult {
  ok: boolean;
  /** The updated file content when ok:true. */
  updated?: string;
  /** Which rung succeeded. */
  rung: ApplyRung;
  /** Structured hint for the model when ok:false. */
  hint?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum similarity (0–1) required for a fuzzy window to be accepted. */
export const FUZZY_THRESHOLD = 0.8;

/** Elision sentinel — a line containing only "..." (trimmed). */
const ELLIPSIS = '...';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Normalize uniform leading whitespace: strip the common indent prefix. */
function stripCommonIndent(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return lines;
  const minIndent = nonEmpty.reduce((min, l) => {
    const m = l.match(/^(\s*)/);
    const len = m ? m[1].length : 0;
    return len < min ? len : min;
  }, Infinity);
  if (minIndent === 0 || !isFinite(minIndent)) return lines;
  return lines.map((l) => (l.length >= minIndent ? l.slice(minIndent) : l));
}

/**
 * Longest-Common-Subsequence length between two string arrays.
 * O(n*m) — only called on small windows (≤ 200 lines per chunk).
 */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  // Use two rolling rows to keep memory O(m).
  let prev = new Uint32Array(m + 1);
  let curr = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return prev[m];
}

/** Similarity ratio in [0,1]: 2*LCS / (|a|+|b|). Mirrors difflib.SequenceMatcher. */
function similarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const total = a.length + b.length;
  if (total === 0) return 1;
  return (2 * lcsLength(a, b)) / total;
}

/** Build a human-readable "closest lines" hint from file lines around `idx`. */
function closestHint(fileLines: string[], idx: number, windowSize: number): string {
  const start = Math.max(0, idx);
  const end = Math.min(fileLines.length, start + windowSize);
  return fileLines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Rung (a): exact match
// ---------------------------------------------------------------------------

function tryExact(original: string, oldString: string, newString: string): ApplyResult | null {
  const idx = original.indexOf(oldString);
  if (idx === -1) return null;
  const updated = original.slice(0, idx) + newString + original.slice(idx + oldString.length);
  return { ok: true, updated, rung: 'exact' };
}

// ---------------------------------------------------------------------------
// Rung (b): whitespace-flexible match
// ---------------------------------------------------------------------------

/**
 * Try matching after stripping common indent from both old_string lines and
 * each candidate window of equal size in the file. Reconstructs the replacement
 * preserving the file's original indentation.
 */
function tryWhitespace(
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
): ApplyResult | null {
  if (oldLines.length === 0) return null;
  const normOld = stripCommonIndent(oldLines).map((l) => l.trimEnd());
  const wLen = oldLines.length;

  for (let i = 0; i <= fileLines.length - wLen; i++) {
    const window = fileLines.slice(i, i + wLen);
    const normWindow = stripCommonIndent(window).map((l) => l.trimEnd());
    if (normWindow.every((l, j) => l === normOld[j])) {
      // Reconstruct: detect the indent of the first matched line.
      const origIndent = (fileLines[i].match(/^(\s*)/) ?? ['', ''])[1];
      const normNew = stripCommonIndent(newLines);
      const reindented = normNew.map((l) => (l.trim() === '' ? l : origIndent + l));
      const updated = [
        ...fileLines.slice(0, i),
        ...reindented,
        ...fileLines.slice(i + wLen),
      ].join('\n');
      return { ok: true, updated, rung: 'whitespace' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rung (c): elision ("..." spans)
// ---------------------------------------------------------------------------

/**
 * Handle old_string blocks where the model used "..." on its own line to mean
 * "any number of lines here". Splits the old block at ellipsis sentinels and
 * finds the corresponding anchors in the file.
 */
function tryElision(
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
): ApplyResult | null {
  // Only attempt when an ellipsis is present.
  if (!oldLines.some((l) => l.trim() === ELLIPSIS)) return null;

  // Split old into segments separated by ellipsis lines.
  const segments: string[][] = [];
  let cur: string[] = [];
  for (const l of oldLines) {
    if (l.trim() === ELLIPSIS) {
      segments.push(cur);
      cur = [];
    } else {
      cur.push(l);
    }
  }
  segments.push(cur);

  // We need at least the first and last anchor to be non-empty.
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first.length === 0 && last.length === 0) return null;

  // Find start: scan for first segment.
  let startIdx = -1;
  if (first.length === 0) {
    startIdx = 0;
  } else {
    for (let i = 0; i <= fileLines.length - first.length; i++) {
      if (fileLines.slice(i, i + first.length).every((l, j) => l.trimEnd() === first[j].trimEnd())) {
        startIdx = i;
        break;
      }
    }
  }
  if (startIdx === -1) return null;

  // Find end: scan for last segment after startIdx.
  let endIdx = startIdx + first.length;
  if (last.length === 0) {
    endIdx = fileLines.length;
  } else {
    for (let i = startIdx + first.length; i <= fileLines.length - last.length; i++) {
      if (fileLines.slice(i, i + last.length).every((l, j) => l.trimEnd() === last[j].trimEnd())) {
        endIdx = i + last.length;
        break;
      }
    }
  }
  if (endIdx < startIdx + first.length) return null;

  const updated = [
    ...fileLines.slice(0, startIdx),
    ...newLines,
    ...fileLines.slice(endIdx),
  ].join('\n');
  return { ok: true, updated, rung: 'elision' };
}

// ---------------------------------------------------------------------------
// Rung (d): fuzzy SequenceMatcher-style
// ---------------------------------------------------------------------------

/**
 * Slide a window of oldLines.length over fileLines; compute similarity for each
 * position; accept the best ≥ FUZZY_THRESHOLD. Returns null if no window meets
 * the threshold.
 */
function tryFuzzy(
  fileLines: string[],
  oldLines: string[],
  newLines: string[],
): ApplyResult | null {
  if (oldLines.length === 0) return null;
  const wLen = oldLines.length;
  let bestSim = -1;
  let bestIdx = -1;

  for (let i = 0; i <= fileLines.length - wLen; i++) {
    const window = fileLines.slice(i, i + wLen);
    const sim = similarity(
      window.map((l) => l.trim()),
      oldLines.map((l) => l.trim()),
    );
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
    }
  }

  if (bestSim < FUZZY_THRESHOLD) return null;

  const updated = [
    ...fileLines.slice(0, bestIdx),
    ...newLines,
    ...fileLines.slice(bestIdx + wLen),
  ].join('\n');
  return { ok: true, updated, rung: 'fuzzy' };
}

// ---------------------------------------------------------------------------
// Public: applyEdit
// ---------------------------------------------------------------------------

/**
 * Attempt to apply `oldString → newString` on `original` via the 4-rung ladder.
 * Returns `ApplyResult` — never throws.
 *
 * On failure, `hint` contains the closest matching window in the file so the
 * model can self-correct with the minimum context needed.
 */
export function applyEdit(original: string, oldString: string, newString: string): ApplyResult {
  // Rung (a): exact.
  const exact = tryExact(original, oldString, newString);
  if (exact) return exact;

  // Split into lines for line-oriented rungs.
  // Preserve the original line ending style by tracking whether it uses \r\n.
  const hasCRLF = original.includes('\r\n');
  const normalize = (s: string) => (hasCRLF ? s.replace(/\r\n/g, '\n') : s);
  const denormalize = (s: string) => (hasCRLF ? s.replace(/\n/g, '\r\n') : s);

  const fileLines = normalize(original).split('\n');
  const oldLines = normalize(oldString).split('\n');
  const newLines = normalize(newString).split('\n');

  // Rung (b): whitespace-flexible.
  const ws = tryWhitespace(fileLines, oldLines, newLines);
  if (ws) return { ...ws, updated: ws.updated !== undefined ? denormalize(ws.updated) : undefined };

  // Rung (c): elision ("..." spans).
  const elision = tryElision(fileLines, oldLines, newLines);
  if (elision) return { ...elision, updated: elision.updated !== undefined ? denormalize(elision.updated) : undefined };

  // Rung (d): fuzzy.
  const fuzzy = tryFuzzy(fileLines, oldLines, newLines);
  if (fuzzy) return { ...fuzzy, updated: fuzzy.updated !== undefined ? denormalize(fuzzy.updated) : undefined };

  // All rungs failed — build a structured hint.
  // Find the best fuzzy window to show the model.
  let hintText = 'No close match found.';
  if (fileLines.length > 0 && oldLines.length > 0) {
    const wLen = Math.min(oldLines.length, fileLines.length);
    let bestSim = -1;
    let bestIdx = 0;
    for (let i = 0; i <= fileLines.length - wLen; i++) {
      const sim = similarity(
        fileLines.slice(i, i + wLen).map((l) => l.trim()),
        oldLines.slice(0, wLen).map((l) => l.trim()),
      );
      if (sim > bestSim) { bestSim = sim; bestIdx = i; }
    }
    const hint = closestHint(fileLines, bestIdx, wLen + 2);
    hintText =
      `Closest match in file (similarity ${(bestSim * 100).toFixed(0)}%):\n${hint}\n` +
      `Your old_string had ${oldLines.length} line(s). ` +
      `Only fix the failed block — leave already-applied hunks alone.`;
  }

  return { ok: false, rung: 'failed', hint: hintText };
}

// ---------------------------------------------------------------------------
// Public: parsePatchBlocks (for multi-hunk patches fed as a unified diff string)
// ---------------------------------------------------------------------------

export interface PatchBlock {
  oldString: string;
  newString: string;
}

/**
 * Parse a naive "search/replace fence" format (the format aider uses in its
 * editblock mode) from a raw string the model emits.
 *
 * Format expected (one or more blocks):
 *   <<<<<<< SEARCH
 *   <old lines>
 *   =======
 *   <new lines>
 *   >>>>>>> REPLACE
 *
 * Returns all parsed blocks; blocks that don't parse cleanly are skipped.
 */
export function parsePatchBlocks(raw: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  const searchMarker = /^<{6,7}\s*SEARCH\s*$/m;
  const dividerMarker = /^={6,7}\s*$/m;
  const replaceMarker = /^>{6,7}\s*REPLACE\s*$/m;

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (searchMarker.test(lines[i])) {
      const oldStart = i + 1;
      let divider = -1;
      let replaceEnd = -1;
      for (let j = oldStart; j < lines.length; j++) {
        if (dividerMarker.test(lines[j])) { divider = j; break; }
      }
      if (divider === -1) { i++; continue; }
      for (let j = divider + 1; j < lines.length; j++) {
        if (replaceMarker.test(lines[j])) { replaceEnd = j; break; }
      }
      if (replaceEnd === -1) { i++; continue; }
      blocks.push({
        oldString: lines.slice(oldStart, divider).join('\n'),
        newString: lines.slice(divider + 1, replaceEnd).join('\n'),
      });
      i = replaceEnd + 1;
    } else {
      i++;
    }
  }
  return blocks;
}
