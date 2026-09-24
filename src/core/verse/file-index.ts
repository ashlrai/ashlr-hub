/**
 * core/verse/file-index.ts — the composer's `@` file finder
 * (SPEC-310C §2 "Mentions and commands"; unit C3).
 *
 * `GET /api/verse/files?sessionId=&q=` fuzzy-finds files across the chat's
 * roots — the same roots the CLI may touch, never anything else. Listing:
 *
 *   - `git ls-files --cached --others --exclude-standard` per root, ASYNC
 *     (execFile, 5 s timeout, 32 MB output cap), so a huge repo never blocks
 *     the event loop and `.gitignore`d build output never pollutes results;
 *   - a bounded directory walk when the root is not a git work tree (skips
 *     dot-directories, node_modules, dist/build output; ≤ 20,000 entries,
 *     ≤ 40,000 directories, ≤ 5 s) — ASYNC as well: one `fs.promises.readdir`
 *     per directory, with the per-entry bookkeeping time-sliced, so no stretch
 *     on the loop approaches the 20 ms handler budget. (It was one synchronous
 *     readdirSync loop: 55–255 ms of a frozen server per walk — review 3.10 c12.)
 *   - cached per root for 30 s, and concurrent requests share one listing.
 *     An EXPIRED listing is served as-is while a fresh one is built in the
 *     background (stale-while-revalidate), so after the first `@` in a chat a
 *     keystroke never waits for a listing again.
 *
 * Matching is a subsequence fuzzy score (fzf-style bonuses for a basename
 * hit, word starts and consecutive runs). 20k paths score in a few ms. The
 * index reads names only — never file contents.
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { VerseFileMatch } from './workbench-types.js';

export const FILE_INDEX_TTL_MS = 30_000;
export const FILE_INDEX_MAX_FILES = 20_000;
export const FILE_INDEX_MAX_RESULTS = 50;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', 'vendor']);

export type ListFiles = (root: string) => Promise<string[]>;

/** `git ls-files` for a work tree; null when the root is not one (or git failed). */
function gitListFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' } },
      (err, stdout) => {
        if (err) { resolve(null); return; }
        resolve(String(stdout).split('\0').filter((name) => name.length > 0).slice(0, FILE_INDEX_MAX_FILES));
      },
    );
  });
}

/** A non-git walk stops (with what it found so far) after this long. */
export const FILE_INDEX_WALK_DEADLINE_MS = 5_000;
/** Longest synchronous stretch of walk bookkeeping before yielding to the loop. */
const WALK_SLICE_MS = 6;

export interface WalkOptions {
  limit?: number;
  deadlineMs?: number;
  now?: () => number;
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Breadth-first, bounded, ASYNC walk for a root that is not a git work tree:
 * at most `limit` files, `limit × 2` directories and `deadlineMs` of wall
 * time. Every directory read is `fs.promises.readdir` (the event loop runs
 * other requests while the disk works), and the synchronous bookkeeping
 * between reads yields every {@link WALK_SLICE_MS}. Symlinks are never
 * followed (they can point anywhere, including back up).
 */
export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const limit = opts.limit ?? FILE_INDEX_MAX_FILES;
  const now = opts.now ?? (() => performance.now());
  const deadline = now() + (opts.deadlineMs ?? FILE_INDEX_WALK_DEADLINE_MS);
  const out: string[] = [];
  const queue: string[] = [root];
  let head = 0;
  let visited = 0;
  let sliceStart = performance.now();
  while (head < queue.length && out.length < limit && visited < limit * 2) {
    if (now() >= deadline) break;
    const dir = queue[head]!;
    head += 1;
    visited += 1;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    sliceStart = performance.now();
    for (let i = 0; i < entries.length; i += 1) {
      if ((i & 255) === 255 && performance.now() - sliceStart > WALK_SLICE_MS) {
        await yieldToLoop();
        sliceStart = performance.now();
      }
      const entry = entries[i]!;
      if (entry.name.startsWith('.')) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(abs);
      } else if (entry.isFile()) {
        out.push(relative(root, abs).split(sep).join('/'));
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export const defaultListFiles: ListFiles = async (root) => {
  const fromGit = await gitListFiles(root);
  if (fromGit !== null) return fromGit;
  return walkFiles(root);
};

// ---------------------------------------------------------------------------
// Fuzzy scoring
// ---------------------------------------------------------------------------

const WORD_BREAK = new Set(['/', '-', '_', '.', ' ']);

/**
 * Score `path` against `query` (lower-cased, no spaces), or null for no match.
 * Every query character must appear in order. Higher is better:
 *   +8 per char at a word start (after / - _ . or a camelCase hump)
 *   +5 per char continuing a consecutive run
 *   +12 when the whole match lands inside the basename
 *   +20 for a basename that starts with the query; +30 for an exact basename
 *   −1 per 12 characters of path length (shorter wins ties)
 */
export function fuzzyScore(path: string, query: string): number | null {
  if (query.length === 0) return 0;
  const lower = path.toLowerCase();
  const baseStart = lower.lastIndexOf('/') + 1;
  const base = lower.slice(baseStart);
  let score = 0;
  let qi = 0;
  let prev = -2;
  let firstMatch = -1;
  for (let i = 0; i < lower.length && qi < query.length; i += 1) {
    if (lower[i] !== query[qi]) continue;
    if (firstMatch < 0) firstMatch = i;
    const before = i === 0 ? '/' : path[i - 1]!;
    const hump = i > 0 && path[i] !== lower[i] && path[i - 1] === lower[i - 1];
    if (WORD_BREAK.has(before) || hump) score += 8;
    if (prev === i - 1) score += 5;
    prev = i;
    qi += 1;
  }
  if (qi < query.length) return null;
  if (firstMatch >= baseStart) score += 12;
  if (base.startsWith(query)) score += 20;
  if (base === query || base.replace(/\.[^.]+$/, '') === query) score += 30;
  score -= Math.floor(path.length / 12);
  return score;
}

export function rankFiles(entries: readonly VerseFileMatch[], rawQuery: string, limit = FILE_INDEX_MAX_RESULTS): { files: VerseFileMatch[]; truncated: boolean } {
  const query = rawQuery.toLowerCase().replace(/\s+/g, '');
  if (query.length === 0) {
    // No query: the shortest paths first (top-level files are the likely ask).
    const sorted = [...entries].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return { files: sorted.slice(0, limit), truncated: sorted.length > limit };
  }
  const scored: Array<{ entry: VerseFileMatch; score: number }> = [];
  for (const entry of entries) {
    const score = fuzzyScore(entry.path, query);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
  return { files: scored.slice(0, limit).map((s) => s.entry), truncated: scored.length > limit };
}

// ---------------------------------------------------------------------------
// Cached index
// ---------------------------------------------------------------------------

export interface FileIndexOptions {
  list?: ListFiles;
  now?: () => number;
  ttlMs?: number;
}

export interface VerseFileIndex {
  search(roots: readonly string[], query: string, limit?: number): Promise<{ files: VerseFileMatch[]; truncated: boolean }>;
  /** Drop cached listings (tests; a root whose files the operator just changed wholesale). */
  clear(): void;
}

export function createFileIndex(opts: FileIndexOptions = {}): VerseFileIndex {
  const list = opts.list ?? defaultListFiles;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? FILE_INDEX_TTL_MS;
  const cache = new Map<string, { at: number; files: Promise<string[]>; refreshing: boolean }>();

  function remember(root: string, entry: { at: number; files: Promise<string[]>; refreshing: boolean }): void {
    cache.delete(root);
    cache.set(root, entry);
    // Bounded: a long-lived server that saw many projects keeps the newest few.
    if (cache.size > 16) cache.delete(cache.keys().next().value as string);
  }

  function filesFor(root: string): Promise<string[]> {
    const hit = cache.get(root);
    if (hit && now() - hit.at < ttl) return hit.files;
    if (hit) {
      // STALE-WHILE-REVALIDATE (review 3.10 c12): the expired listing answers
      // this keystroke now; a fresh one replaces it when it is ready. One
      // refresh per root at a time.
      if (!hit.refreshing) {
        hit.refreshing = true;
        const next = list(root).catch(() => null);
        void next.then((files) => {
          if (cache.get(root) !== hit) return; // cleared or evicted meanwhile
          if (files === null) {
            // A failed refresh keeps the old listing; the next keystroke retries.
            hit.refreshing = false;
            return;
          }
          remember(root, { at: now(), files: Promise.resolve(files), refreshing: false });
        });
      }
      return hit.files;
    }
    const files = list(root).catch(() => [] as string[]);
    remember(root, { at: now(), files, refreshing: false });
    return files;
  }

  return {
    async search(roots, query, limit = FILE_INDEX_MAX_RESULTS) {
      const lists = await Promise.all(roots.map((root) => filesFor(root)));
      const entries: VerseFileMatch[] = [];
      lists.forEach((files, index) => {
        const root = roots[index]!;
        for (const path of files) entries.push({ path, root });
      });
      return rankFiles(entries, query, limit);
    },
    clear() {
      cache.clear();
    },
  };
}

let shared: VerseFileIndex | null = null;
/** The process-wide index the API uses. */
export function sharedFileIndex(): VerseFileIndex {
  shared ??= createFileIndex();
  return shared;
}
