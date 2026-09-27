/**
 * routes/verse/changes/changes-model.ts — pure helpers for the Changes pane:
 * word-level diff, the file tree, labels, and Undo plan bookkeeping.
 * No React, no DOM.
 */
import type {
  VerseCheckpointDiffFile,
  VerseCheckpointPreviewResponse,
  VerseCheckpointResolution,
  VerseCheckpointTurn,
} from '../../../../core/verse/checkpoint-types.js';

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

export type Span = [number, number];

export interface WordSpans {
  old: Span[];
  new: Span[];
}

/** Words, runs of whitespace, and single punctuation characters. */
const TOKEN = /[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g;
const WORD_DIFF_MAX_TOKENS = 400;
/** Below this share of unchanged text, emphasis is noise: the whole line changed. */
const WORD_DIFF_MIN_SHARED = 0.3;

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Merge touching spans (and spans separated only by whitespace) into one. */
function coalesce(spans: Span[], text: string): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && (last[1] === s[0] || /^\s*$/.test(text.slice(last[1], s[0])))) last[1] = s[1];
    else out.push([s[0], s[1]]);
  }
  return out;
}

/**
 * Which parts of a changed line changed, word by word (LCS over tokens).
 * Null when the lines are equal, too long, or so different that highlighting
 * every word says nothing.
 */
export function wordDiff(oldLine: string, newLine: string): WordSpans | null {
  if (oldLine === newLine) return null;
  const a = tokens(oldLine);
  const b = tokens(newLine);
  if (a.length === 0 || b.length === 0 || a.length > WORD_DIFF_MAX_TOKENS || b.length > WORD_DIFF_MAX_TOKENS) return null;
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const oldSpans: Span[] = [];
  const newSpans: Span[] = [];
  let i = 0;
  let j = 0;
  let pa = 0;
  let pb = 0;
  let shared = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      shared += a[i]!.length;
      pa += a[i]!.length;
      pb += b[j]!.length;
      i++;
      j++;
    } else if (j < m && (i === n || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      newSpans.push([pb, pb + b[j]!.length]);
      pb += b[j]!.length;
      j++;
    } else {
      oldSpans.push([pa, pa + a[i]!.length]);
      pa += a[i]!.length;
      i++;
    }
  }
  const longest = Math.max(oldLine.length, newLine.length);
  if (longest > 0 && shared / longest < WORD_DIFF_MIN_SHARED) return null;
  return { old: coalesce(oldSpans, oldLine), new: coalesce(newSpans, newLine) };
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export interface FileGroup {
  /** Directory ('' for the repository root). */
  dir: string;
  files: Array<VerseCheckpointDiffFile & { name: string }>;
}

/** Files grouped by directory, directories and files in path order. */
export function groupByDirectory(files: readonly VerseCheckpointDiffFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const f of files) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut < 0 ? '' : f.path.slice(0, cut);
    const name = cut < 0 ? f.path : f.path.slice(cut + 1);
    let g = groups.get(dir);
    if (!g) {
      g = { dir, files: [] };
      groups.set(dir, g);
    }
    g.files.push({ ...f, name });
  }
  const out = [...groups.values()];
  out.sort((x, y) => (x.dir === y.dir ? 0 : x.dir === '' ? -1 : y.dir === '' ? 1 : x.dir < y.dir ? -1 : 1));
  for (const g of out) g.files.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out;
}

export function totals(files: readonly VerseCheckpointDiffFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

export const STATUS_WORD: Record<VerseCheckpointDiffFile['status'], string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed' };

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function turnLabel(turn: VerseCheckpointTurn): string {
  const bits = [`Turn ${turn.index}`];
  if (turn.filesChanged !== null) bits.push(`${turn.filesChanged} ${turn.filesChanged === 1 ? 'file' : 'files'}`);
  if (turn.state === 'running') bits.push('running');
  else if (turn.state === 'undone') bits.push('undone');
  const at = formatTime(turn.startedAt);
  if (at) bits.push(at);
  return bits.join(' · ');
}

/** Whether a turn has a usable `pre` checkpoint in at least one repository. */
export function turnHasCheckpoint(turn: VerseCheckpointTurn): boolean {
  return turn.roots.some((r) => r.pre?.commit);
}

/** The first checkpoint error of a turn, for the "no checkpoint" notice. */
export function turnCheckpointError(turn: VerseCheckpointTurn): string | null {
  for (const r of turn.roots) if (r.pre && !r.pre.commit && r.pre.error) return r.pre.error;
  return null;
}

// ---------------------------------------------------------------------------
// Undo / Redo plan
// ---------------------------------------------------------------------------

export type Resolutions = Record<string, Record<string, VerseCheckpointResolution>>;

/**
 * The starting decisions for a preview: a conflict that merges cleanly starts
 * on "merge" (it keeps the later edit AND reverts the agent's); every other
 * conflict starts undecided — the operator must choose.
 */
export function initialResolutions(preview: VerseCheckpointPreviewResponse): Resolutions {
  const out: Resolutions = {};
  for (const root of preview.roots) {
    const inner: Record<string, VerseCheckpointResolution> = {};
    for (const c of root.conflicts) if (c.merge.clean) inner[c.path] = 'merge';
    out[root.rootId] = inner;
  }
  return out;
}

export function undecided(preview: VerseCheckpointPreviewResponse, resolutions: Resolutions): string[] {
  const out: string[] = [];
  for (const root of preview.roots) {
    for (const c of root.conflicts) if (!resolutions[root.rootId]?.[c.path]) out.push(c.path);
  }
  return out;
}

export interface PlanCounts {
  restore: number;
  remove: number;
  conflicts: number;
  kept: number;
  uncaptured: number;
  unavailable: number;
}

export function planCounts(preview: VerseCheckpointPreviewResponse): PlanCounts {
  const c: PlanCounts = { restore: 0, remove: 0, conflicts: 0, kept: 0, uncaptured: 0, unavailable: 0 };
  for (const r of preview.roots) {
    for (const f of r.apply) {
      if (f.action === 'delete') c.remove += 1;
      else c.restore += 1;
    }
    c.conflicts += r.conflicts.length;
    c.kept += r.kept.length;
    c.uncaptured += r.uncaptured.length;
    if (r.unavailable) c.unavailable += 1;
  }
  return c;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}
