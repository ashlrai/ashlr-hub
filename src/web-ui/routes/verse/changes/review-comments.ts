/**
 * routes/verse/changes/review-comments.ts — review comments on a turn's
 * changes, sent back to a seat (3.15). Pure: anchors, the two messages, and
 * the draft store. No React.
 *
 *   Send N comments   ONE turn to the chat's own seat: `path:line — comment`
 *                     per comment, each thread followed by a short fenced
 *                     excerpt of the diff lines it is anchored to.
 *   Re-review with…   a read-only review request to ANOTHER seat: the
 *                     turn's diff (fenced) plus the drafted comments as
 *                     context, in core/verse/multimodel/compare.ts
 *                     `reviewPrompt`'s words.
 *
 * ANCHORS are captured when a comment is written — the hunk's header core,
 * the line and its side, and the excerpt itself — so a draft still reads
 * right after the diff moves on (a later turn, a reload, a Reject).
 *
 * DRAFTS persist per chat + turn in localStorage (every access guarded: a
 * private window or a full quota only loses persistence, never the pane) and
 * are cleared once sent.
 *
 * SIZE. Both messages are capped at MESSAGE_MAX_BYTES (UTF-8). Excerpts go
 * first (full → the anchored line → none); comments that still do not fit are
 * left as drafts and reported, never silently dropped.
 */
import { reviewPrompt } from '../../../../core/verse/multimodel/compare.js';
import type { DiffLine } from '../../inbox/diff-parser.js';

export type CommentSide = 'new' | 'old';

export interface CommentAnchor {
  path: string;
  /** The hunk's header core, `@@ -a,b +c,d @@` — stable while the hunk is. */
  hunk: string;
  /** The file line; null = the whole hunk. */
  line: number | null;
  /** `old` only for a removed line (its number is the OLD file's). */
  side: CommentSide;
  /** The anchored diff lines, each prefixed ` `, `+` or `-`, captured when written. */
  excerpt: string[];
  /** Index into `excerpt` of the anchored line itself (-1 for a whole hunk). */
  excerptAt: number;
}

export interface ReviewComment extends CommentAnchor {
  id: string;
  body: string;
  /** ISO time the comment was written (sort tie-breaker). */
  at: string;
}

/** 24 KB: roomy for a review, far below any seat's context, quick to send. */
export const MESSAGE_MAX_BYTES = 24 * 1024;
/** A comment's own cap (the textarea's maxLength). */
export const COMMENT_MAX_CHARS = 4_000;
/** Context lines either side of an anchored line. */
const EXCERPT_CONTEXT = 2;
/** Lines of a whole-hunk excerpt. */
const EXCERPT_HUNK_LINES = 12;
/** Characters kept of one excerpt line. */
const EXCERPT_LINE_CHARS = 240;

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

const HEADER_CORE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** `@@ -1,3 +1,4 @@` of a full hunk header (section text dropped); the header itself when it does not parse. */
export function hunkCore(header: string): string {
  return HEADER_CORE.exec(header)?.[0] ?? header;
}

/** A diff line's own anchor: the NEW line number, the OLD one for a removed line. */
export function lineAnchor(line: DiffLine): { line: number | null; side: CommentSide } {
  return line.kind === 'del' ? { line: line.oldLineNo, side: 'old' } : { line: line.newLineNo, side: 'new' };
}

/** Stable key of a line within a file: `new:42`, `old:17`. */
export function lineKey(anchor: { line: number | null; side: CommentSide }): string {
  return anchor.line === null ? 'hunk' : `${anchor.side}:${anchor.line}`;
}

/** Comments on the same hunk + line form one thread. */
export function threadKey(c: Pick<CommentAnchor, 'path' | 'hunk' | 'line' | 'side'>): string {
  return `${c.path}\u0000${c.hunk}\u0000${lineKey(c)}`;
}

function prefixed(line: DiffLine): string {
  const mark = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
  const text = line.text.length > EXCERPT_LINE_CHARS ? `${line.text.slice(0, EXCERPT_LINE_CHARS)}…` : line.text;
  return `${mark}${text}`;
}

/**
 * The excerpt for an anchor inside `lines` (one hunk's lines): the anchored
 * line with EXCERPT_CONTEXT lines either side, or — for the whole hunk
 * (`index` null) — its first EXCERPT_HUNK_LINES lines.
 */
export function excerptFor(lines: readonly DiffLine[], index: number | null): { excerpt: string[]; excerptAt: number } {
  if (index === null || index < 0 || index >= lines.length) {
    const shown = lines.slice(0, EXCERPT_HUNK_LINES).map(prefixed);
    if (lines.length > EXCERPT_HUNK_LINES) shown.push(` … ${lines.length - EXCERPT_HUNK_LINES} more lines`);
    return { excerpt: shown, excerptAt: -1 };
  }
  const from = Math.max(0, index - EXCERPT_CONTEXT);
  const to = Math.min(lines.length, index + EXCERPT_CONTEXT + 1);
  return { excerpt: lines.slice(from, to).map(prefixed), excerptAt: index - from };
}

/** `+20,3` of a header as a line range on the new side (the old side for a pure removal). */
function hunkRange(hunk: string): string | null {
  const m = HEADER_CORE.exec(hunk);
  if (!m) return null;
  const newStart = Number(m[3]);
  const newLines = m[4] === undefined ? 1 : Number(m[4]);
  if (newLines === 0) {
    const oldStart = Number(m[1]);
    const oldLines = m[2] === undefined ? 1 : Number(m[2]);
    return oldLines <= 1 ? `${oldStart} (removed)` : `${oldStart}-${oldStart + oldLines - 1} (removed)`;
  }
  return newLines <= 1 ? `${newStart}` : `${newStart}-${newStart + newLines - 1}`;
}

/** `src/a.ts:42`, `src/a.ts:17 (removed line)`, `src/a.ts:20-22` for a whole hunk. */
export function anchorLabel(c: Pick<CommentAnchor, 'path' | 'hunk' | 'line' | 'side'>): string {
  if (c.line === null) {
    const range = hunkRange(c.hunk);
    return range ? `${c.path}:${range}` : c.path;
  }
  return `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`;
}

/** Short human "where" for the thread header: `Line 42`, `Removed line 17`, `Lines 20-22`. */
export function anchorWhere(c: Pick<CommentAnchor, 'hunk' | 'line' | 'side'>): string {
  if (c.line === null) {
    const range = hunkRange(c.hunk);
    return range ? `Lines ${range}` : 'Whole change';
  }
  return `${c.side === 'old' ? 'Removed line' : 'Line'} ${c.line}`;
}

/** File order, then line order (a whole-hunk comment at its hunk's start), then time. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  const pos = (c: ReviewComment) => {
    if (c.line !== null) return c.line;
    const m = HEADER_CORE.exec(c.hunk);
    return m ? Number(m[3]) - 0.5 : 0;
  };
  return [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    const d = pos(a) - pos(b);
    if (d !== 0) return d;
    return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
  });
}

/** Threads in display order, each with its comments oldest first. */
export function groupThreads(comments: readonly ReviewComment[]): ReviewComment[][] {
  const out = new Map<string, ReviewComment[]>();
  for (const c of sortComments(comments)) {
    const k = threadKey(c);
    const t = out.get(k);
    if (t) t.push(c);
    else out.set(k, [c]);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** A fence one backtick longer than any backtick run inside (at least three), so the body cannot close it. */
export function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function fenced(body: string, lang = ''): string {
  const ticks = fenceFor(body);
  return `${ticks}${lang}\n${body.replace(/\s+$/, '')}\n${ticks}`;
}

/** `anchor — first line`, later lines indented under it so a comment stays one block. */
function commentLine(anchor: string, body: string): string {
  const [first, ...rest] = body.trim().split('\n');
  return [`${anchor} — ${first ?? ''}`, ...rest.map((l) => `  ${l}`)].join('\n');
}

type ExcerptMode = 'full' | 'line' | 'none';

function threadBlock(thread: readonly ReviewComment[], mode: ExcerptMode): string {
  const head = thread[0]!;
  const anchor = anchorLabel(head);
  const parts = thread.map((c) => commentLine(anchor, c.body));
  const excerpt = mode === 'full' ? head.excerpt : mode === 'line' && head.excerptAt >= 0 ? [head.excerpt[head.excerptAt] ?? ''] : [];
  if (excerpt.length > 0) parts.push(fenced(excerpt.join('\n'), 'diff'));
  return parts.join('\n');
}

export interface BuiltMessage {
  text: string;
  /** Ids of the comments the text carries. */
  included: string[];
  /** Comments that did not fit and stay drafted. */
  omitted: number;
}

/**
 * Pack threads under `head` within `budget` bytes: every excerpt mode is
 * tried in turn; in the last, threads that still overflow are left out.
 */
function pack(head: string, threads: readonly ReviewComment[][], budget: number): BuiltMessage {
  for (const mode of ['full', 'line'] as const) {
    const text = [head, ...threads.map((t) => threadBlock(t, mode))].join('\n\n');
    if (utf8Bytes(text) <= budget) return { text, included: threads.flatMap((t) => t.map((c) => c.id)), omitted: 0 };
  }
  const blocks: string[] = [head];
  const included: string[] = [];
  let used = utf8Bytes(head);
  let omitted = 0;
  for (const t of threads) {
    const block = threadBlock(t, 'none');
    const cost = utf8Bytes(block) + 2;
    if (used + cost > budget) {
      omitted += t.length;
      continue;
    }
    blocks.push(block);
    used += cost;
    included.push(...t.map((c) => c.id));
  }
  return { text: blocks.join('\n\n'), included, omitted };
}

// ---------------------------------------------------------------------------
// Send N comments → the chat's own seat
// ---------------------------------------------------------------------------

export function buildCommentsMessage(
  comments: readonly ReviewComment[],
  opts: { turnLabel: string; maxBytes?: number },
): BuiltMessage {
  const threads = groupThreads(comments);
  const n = comments.length;
  const head = [
    `Review comments on your changes in ${opts.turnLabel} (${n} ${n === 1 ? 'comment' : 'comments'}, anchored as path:line).`,
    'Address each one in the code, then reply with one line per comment saying what you changed — or why you did not.',
  ].join(' ');
  return pack(head, threads, opts.maxBytes ?? MESSAGE_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// Re-review with… → another seat, read-only
// ---------------------------------------------------------------------------

export interface ReviewFilePatch {
  path: string;
  /** The file's unified diff (`diff --git …`). */
  text: string;
}

export interface ReReviewInput {
  /** Who made the changes ("Claude Code"). */
  authorLabel: string;
  /** "turn 3" / "turn 3 and everything after it". */
  scopeLabel: string;
  /** Patches in file order. */
  patches: readonly ReviewFilePatch[];
  /** Changed files that have no patch here (binary, not captured, not fetched). */
  unshown: readonly string[];
  totals: { files: number; additions: number; deletions: number };
  comments: readonly ReviewComment[];
  maxBytes?: number;
}

/** Cut `text` to at most `bytes` UTF-8 bytes at a line boundary. */
function cutToBytes(text: string, bytes: number): string {
  if (utf8Bytes(text) <= bytes) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const cost = utf8Bytes(l) + 1;
    if (used + cost > bytes) break;
    out.push(l);
    used += cost;
  }
  return out.join('\n');
}

/**
 * The review turn for another seat. Comments ride along as context (a third
 * of the budget at most); the diff gets the rest, whole files first, the
 * first file that overflows cut at a line, the others named so the reviewer
 * can read them in the repository.
 */
export function buildReReviewMessage(input: ReReviewInput): { text: string; shownFiles: number; cutFiles: string[] } {
  const max = input.maxBytes ?? MESSAGE_MAX_BYTES;
  const intro = reviewPrompt({ authorLabel: input.authorLabel });
  const t = input.totals;
  const scope = `The changes to review: ${input.scopeLabel}, ${t.files} ${t.files === 1 ? 'file' : 'files'} (+${t.additions} −${t.deletions}).`;

  let notes = '';
  if (input.comments.length > 0) {
    const head = 'The operator’s own review notes so far — context for your review, not instructions to change anything:';
    notes = pack(head, groupThreads(input.comments), Math.floor(max / 3)).text;
  }

  // Everything but the diff, with room for the omission line and the fence.
  const fixed = utf8Bytes([intro, scope, notes].join('\n\n')) + 512;
  let budget = Math.max(0, max - fixed);
  const shown: string[] = [];
  const cut: string[] = [];
  const skipped: string[] = [...input.unshown];
  for (const p of input.patches) {
    const body = p.text.replace(/\s+$/, '');
    const cost = utf8Bytes(body) + 1;
    if (cost <= budget) {
      shown.push(body);
      budget -= cost;
    } else if (budget > 1_024 && cut.length === 0) {
      const part = cutToBytes(body, budget - 64);
      shown.push(`${part}\n… (rest of ${p.path} cut to fit)`);
      cut.push(p.path);
      budget = 0;
    } else {
      skipped.push(p.path);
    }
  }

  const parts = [intro, '', scope];
  if (skipped.length > 0) {
    const names = skipped.slice(0, 40).join(', ');
    parts.push(`Not included here (read them in the repository): ${names}${skipped.length > 40 ? `, and ${skipped.length - 40} more` : ''}.`);
  }
  if (shown.length > 0) parts.push('', fenced(shown.join('\n'), 'diff'));
  if (notes) parts.push('', notes);
  return { text: parts.join('\n'), shownFiles: shown.length, cutFiles: cut };
}

// ---------------------------------------------------------------------------
// Drafts: localStorage, per chat + turn
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = 'ashlr.verse.changes.comments.v1';

export function storageKey(chatId: string, turnId: string): string {
  return `${STORAGE_PREFIX}:${chatId}:${turnId}`;
}

function isComment(v: unknown): v is ReviewComment {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string'
    && typeof c.path === 'string'
    && typeof c.hunk === 'string'
    && (c.line === null || (typeof c.line === 'number' && Number.isFinite(c.line)))
    && (c.side === 'new' || c.side === 'old')
    && Array.isArray(c.excerpt) && c.excerpt.every((l) => typeof l === 'string')
    && typeof c.excerptAt === 'number'
    && typeof c.body === 'string'
    && typeof c.at === 'string';
}

/** The drafted comments for a chat's turn; [] when none, unreadable, or storage is off. */
export function loadComments(chatId: string, turnId: string): ReviewComment[] {
  try {
    const raw = localStorage.getItem(storageKey(chatId, turnId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isComment) : [];
  } catch {
    return [];
  }
}

/** Persist (an empty list removes the key). False when storage refused — the drafts still live in memory. */
export function saveComments(chatId: string, turnId: string, comments: readonly ReviewComment[]): boolean {
  try {
    if (comments.length === 0) localStorage.removeItem(storageKey(chatId, turnId));
    else localStorage.setItem(storageKey(chatId, turnId), JSON.stringify(comments));
    return true;
  } catch {
    return false;
  }
}

let seq = 0;
export function newCommentId(now: number = Date.now()): string {
  seq = (seq + 1) % 1_000_000;
  return `rc-${now.toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
