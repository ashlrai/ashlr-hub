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
 *     dot-directories, node_modules, dist/build output; ≤ 20,000 entries);
 *   - cached per root for 30 s, and concurrent requests share one listing.
 *
 * Matching is a subsequence fuzzy score (fzf-style bonuses for a basename
 * hit, word starts and consecutive runs). 20k paths score in a few ms. The
 * index reads names only — never file contents.
 */
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
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

/** Breadth-first, bounded walk for a root that is not a git work tree. */
export function walkFiles(root: string, limit = FILE_INDEX_MAX_FILES): string[] {
  const out: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && out.length < limit && visited < limit * 2) {
    const dir = queue.shift()!;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
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
  // The walk is synchronous; yield first so a burst of keystrokes cannot
  // stack several walks inside one tick.
  await new Promise((resolve) => setImmediate(resolve));
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
  const cache = new Map<string, { at: number; files: Promise<string[]> }>();

  function filesFor(root: string): Promise<string[]> {
    const hit = cache.get(root);
    if (hit && now() - hit.at < ttl) return hit.files;
    const files = list(root).catch(() => [] as string[]);
    cache.set(root, { at: now(), files });
    // Bounded: a long-lived server that saw many projects keeps the newest few.
    if (cache.size > 16) cache.delete(cache.keys().next().value as string);
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
