/**
 * core/verse/terminal-history.ts — every command the operator's shells
 * finished, kept across restarts (3.15). The input editor's ghost text, ↑/↓,
 * and the ⌃R palette read it; other units may too (see the API below).
 *
 *   ~/.ashlr/verse/terminal-history.jsonl   (0600, one JSON record per line)
 *   { cmd, cwd, repo, exit, durMs, ts }
 *
 * WHAT IS WRITTEN. One record per CLOSED command block (terminal-blocks.ts):
 * the command line as the shell reported it, where it ran, the git repo
 * that directory is in, its exit code and duration. Never its output. Every
 * string goes through scrubSecrets BEFORE it touches the disk, so a key typed
 * on a command line is stored as `[REDACTED]`. Recording is on by default and
 * can be turned off (terminal-settings.ts); off also stops reading it back.
 * "Clear history" deletes the file.
 *
 * BOUNDED. At most TERMINAL_HISTORY_MAX_LINES records: past ~10 % over, the
 * file is rewritten (temp file + rename, 0600) keeping the newest. A command
 * longer than TERMINAL_HISTORY_MAX_CMD_CHARS is not recorded.
 *
 * ASYNC ONLY (lint:verse-sync-io), and SERIAL: appends, the first load, a
 * compaction and a clear run one after another on one promise chain, so a
 * clear can never be undone by an append that was already in flight.
 *
 * RANKING (one row per distinct command):
 *   1. match — the query is a PREFIX of the command, else every word of it
 *      appears in the command (case-insensitive);
 *   2. it ran in this cwd, 3. in this repo, 4. it succeeded (last exit 0;
 *      unknown ranks between), 5. most recent.
 * An empty query ranks everything as a prefix match (the ghost text asks for
 * the list once per prompt and filters it as the operator types).
 */
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { scrubSecrets } from '../util/scrub.js';
import { expandHomePrefix } from './path-guard.js';
import { loadTerminalSettings, terminalVerseDir } from './terminal-settings.js';
import {
  VERSE_TERMINAL_HISTORY_MAX_LIMIT,
  type VerseTerminalHistoryEntry,
} from './workbench-types.js';

export const TERMINAL_HISTORY_FILE = 'terminal-history.jsonl';
export const TERMINAL_HISTORY_MAX_LINES = 50_000;
export const TERMINAL_HISTORY_MAX_CMD_CHARS = 4_096;
/** Distinct directories / repos remembered per command (for the cwd / repo signals). */
const PLACES_PER_COMMAND = 32;

/** One line of the file. */
export interface TerminalHistoryRecord {
  cmd: string;
  cwd: string | null;
  repo: string | null;
  exit: number | null;
  durMs: number | null;
  /** ISO time the command finished. */
  ts: string;
}

export interface TerminalHistoryQuery {
  q?: string;
  /** Absolute, or `~/…` (how cwds reach the page). */
  cwd?: string | null;
  /** Default: the repo `cwd` is in. */
  repo?: string | null;
  limit?: number;
}

export interface TerminalHistoryInput {
  cmd: string;
  cwd: string | null;
  exit: number | null;
  durMs: number | null;
  /** Default: now. */
  at?: number;
}

export interface TerminalHistoryStore {
  /** Record one finished command. False when recording is off or the command was skipped. */
  record(input: TerminalHistoryInput): Promise<boolean>;
  query(q: TerminalHistoryQuery): Promise<VerseTerminalHistoryEntry[]>;
  /** Delete every record (the file too). */
  clear(): Promise<void>;
  /** Wait for every queued write (tests, shutdown). */
  idle(): Promise<void>;
  readonly path: string;
}

export interface TerminalHistoryOptions {
  /** Directory holding the file (default ~/.ashlr/verse). */
  dir?: string;
  maxLines?: number;
  now?: () => number;
  /** Is recording on? (default: terminal-settings.json `history`). */
  enabled?: () => Promise<boolean>;
  /** The repo root a directory is in, or null (default: walk up for `.git`). */
  repoOf?: (cwd: string) => Promise<string | null>;
}

interface Aggregate {
  cmd: string;
  count: number;
  okCount: number;
  last: TerminalHistoryRecord;
  lastMs: number;
  cwds: Map<string, number>;
  repos: Map<string, number>;
}

/** The repo a directory is in: the nearest ancestor holding `.git` (a dir, or a worktree's file). */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  if (!isAbsolute(cwd)) return null;
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    try {
      await stat(join(dir, '.git'));
      return dir;
    } catch {
      /* not here */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function remember(places: Map<string, number>, key: string | null, at: number): void {
  if (!key) return;
  places.delete(key);
  places.set(key, at);
  if (places.size > PLACES_PER_COMMAND) places.delete(places.keys().next().value!);
}

/** A record read back from the file; null for a line that is not one (hand-edited, torn). */
export function parseHistoryLine(line: string): TerminalHistoryRecord | null {
  if (!line) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || typeof r['cmd'] !== 'string' || r['cmd'].length === 0 || typeof r['ts'] !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { cmd: r['cmd'], cwd: str(r['cwd']), repo: str(r['repo']), exit: num(r['exit']), durMs: num(r['durMs']), ts: r['ts'] };
}

/**
 * Rank aggregates for a query (pure; exported for tests and for other units
 * that hold their own records).
 */
export function rankHistory(
  aggregates: Iterable<Aggregate>,
  query: { q: string; cwd: string | null; repo: string | null; limit: number },
): VerseTerminalHistoryEntry[] {
  const q = query.q;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ agg: Aggregate; match: number; here: boolean; sameRepo: boolean; ok: number }> = [];
  for (const agg of aggregates) {
    let match = 0;
    if (q.length === 0 || agg.cmd.startsWith(q)) match = 2;
    else {
      const lower = agg.cmd.toLowerCase();
      if (words.length > 0 && words.every((w) => lower.includes(w))) match = 1;
    }
    if (match === 0) continue;
    const here = query.cwd !== null && agg.cwds.has(query.cwd);
    const sameRepo = query.repo !== null && agg.repos.has(query.repo);
    const exit = agg.last.exit;
    const ok = exit === 0 ? 2 : exit === null ? 1 : 0;
    scored.push({ agg, match, here, sameRepo, ok });
  }
  scored.sort((a, b) =>
    b.match - a.match
    || Number(b.here) - Number(a.here)
    || Number(b.sameRepo) - Number(a.sameRepo)
    || b.ok - a.ok
    || b.agg.lastMs - a.agg.lastMs);
  return scored.slice(0, query.limit).map(({ agg, here, sameRepo }) => ({
    cmd: agg.cmd,
    cwd: agg.last.cwd,
    repo: agg.last.repo,
    exit: agg.last.exit,
    durMs: agg.last.durMs,
    ts: agg.last.ts,
    count: agg.count,
    okCount: agg.okCount,
    here,
    sameRepo,
  }));
}

export function createTerminalHistory(opts: TerminalHistoryOptions = {}): TerminalHistoryStore {
  const dir = opts.dir ?? terminalVerseDir();
  const file = join(dir, TERMINAL_HISTORY_FILE);
  const maxLines = opts.maxLines ?? TERMINAL_HISTORY_MAX_LINES;
  const compactAt = Math.max(maxLines + 1, Math.ceil(maxLines * 1.1));
  const now = opts.now ?? Date.now;
  const enabled = opts.enabled ?? (async () => (await loadTerminalSettings(dir)).history);
  const repoCache = new Map<string, string | null>();
  const repoOf = async (cwd: string | null): Promise<string | null> => {
    if (!cwd) return null;
    if (repoCache.has(cwd)) return repoCache.get(cwd)!;
    const repo = await (opts.repoOf ?? findRepoRoot)(cwd).catch(() => null);
    repoCache.set(cwd, repo);
    if (repoCache.size > 256) repoCache.delete(repoCache.keys().next().value!);
    return repo;
  };

  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  };

  /** Null until the file has been read once. */
  let index: Map<string, Aggregate> | null = null;
  let lineCount = 0;
  let modeChecked = false;

  function add(map: Map<string, Aggregate>, rec: TerminalHistoryRecord): void {
    const ms = Date.parse(rec.ts);
    const at = Number.isFinite(ms) ? ms : 0;
    let agg = map.get(rec.cmd);
    if (!agg) {
      agg = { cmd: rec.cmd, count: 0, okCount: 0, last: rec, lastMs: at, cwds: new Map(), repos: new Map() };
      map.set(rec.cmd, agg);
    }
    agg.count += 1;
    if (rec.exit === 0) agg.okCount += 1;
    if (at >= agg.lastMs) {
      agg.last = rec;
      agg.lastMs = at;
    }
    remember(agg.cwds, rec.cwd, at);
    remember(agg.repos, rec.repo, at);
  }

  async function readLines(): Promise<string[]> {
    try {
      return (await readFile(file, 'utf8')).split('\n').filter((l) => l.length > 0);
    } catch {
      return [];
    }
  }

  async function load(): Promise<Map<string, Aggregate>> {
    if (index) return index;
    const lines = await readLines();
    const map = new Map<string, Aggregate>();
    for (const line of lines) {
      const rec = parseHistoryLine(line);
      if (rec) add(map, rec);
    }
    lineCount = lines.length;
    index = map;
    return map;
  }

  async function compact(): Promise<void> {
    const lines = await readLines();
    const keep = lines.slice(-maxLines);
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(keep.length > 0 ? `${keep.join('\n')}\n` : '');
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    lineCount = keep.length;
    // The index keeps counting what was dropped: rebuild it from what is left.
    index = null;
    await load();
  }

  async function append(rec: TerminalHistoryRecord): Promise<void> {
    await load();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(file, 'a', 0o600);
    try {
      await handle.write(`${JSON.stringify(rec)}\n`);
    } finally {
      await handle.close();
    }
    if (!modeChecked) {
      modeChecked = true;
      // `open`'s mode applies only when it creates the file; tighten one made wider elsewhere.
      await chmod(file, 0o600).catch(() => {});
    }
    lineCount += 1;
    if (index) add(index, rec);
    if (lineCount >= compactAt) await compact();
  }

  return {
    path: file,

    record(input) {
      const trimmed = typeof input.cmd === 'string' ? input.cmd.trim() : '';
      if (trimmed.length === 0 || trimmed.length > TERMINAL_HISTORY_MAX_CMD_CHARS) return Promise.resolve(false);
      const at = typeof input.at === 'number' && Number.isFinite(input.at) ? input.at : now();
      // Queued whole, at the call: a clear() made after this call runs after it, and wipes it.
      return serial(async () => {
        if (!(await enabled().catch(() => false))) return false;
        const cwd = input.cwd && isAbsolute(input.cwd) ? input.cwd : null;
        const repo = await repoOf(cwd);
        await append({
          cmd: scrubSecrets(trimmed),
          cwd: cwd === null ? null : scrubSecrets(cwd),
          repo: repo === null ? null : scrubSecrets(repo),
          exit: typeof input.exit === 'number' && Number.isFinite(input.exit) ? input.exit : null,
          durMs: typeof input.durMs === 'number' && Number.isFinite(input.durMs) ? Math.max(0, Math.round(input.durMs)) : null,
          ts: new Date(at).toISOString(),
        });
        return true;
      });
    },

    async query(q) {
      if (!(await enabled().catch(() => false))) return [];
      const cwdRaw = typeof q.cwd === 'string' && q.cwd.length > 0 ? expandHomePrefix(q.cwd) : null;
      const cwd = cwdRaw && isAbsolute(cwdRaw) ? cwdRaw : null;
      const repoRaw = typeof q.repo === 'string' && q.repo.length > 0 ? expandHomePrefix(q.repo) : null;
      const repo = repoRaw && isAbsolute(repoRaw) ? repoRaw : await repoOf(cwd);
      const limit = Math.max(1, Math.min(VERSE_TERMINAL_HISTORY_MAX_LIMIT, Math.floor(q.limit ?? 50)));
      const map = await serial(load);
      return rankHistory(map.values(), { q: typeof q.q === 'string' ? q.q : '', cwd, repo, limit });
    },

    clear() {
      return serial(async () => {
        await rm(file, { force: true });
        index = new Map();
        lineCount = 0;
      });
    },

    idle() {
      return serial(async () => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The process's store (per HOME: a relocated HOME gets its own)
// ---------------------------------------------------------------------------

let shared: TerminalHistoryStore | null = null;
let installed: TerminalHistoryStore | null = null;

/** The server's history store, created on first use for the current HOME. */
export function getTerminalHistory(): TerminalHistoryStore {
  if (installed) return installed;
  const path = join(terminalVerseDir(), TERMINAL_HISTORY_FILE);
  if (!shared || shared.path !== path) shared = createTerminalHistory();
  return shared;
}

/** Test hook: install a store (or null to go back to the default). */
export function setTerminalHistoryForTest(next: TerminalHistoryStore | null): void {
  installed = next;
  shared = null;
}
