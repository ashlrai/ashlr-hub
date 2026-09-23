/**
 * How big is the code a session could reach, in tokens? — zero spend.
 *
 * Feeds the per-model fit badges (context-math `fitVerdict`: fits / tight /
 * needs expansive / split) in the new-chat dialog and the handoff picker. It
 * is an ESTIMATE and says so: `estimator: 'bytes/4'`, and `truncated` marks a
 * root whose scan hit a cap, in which case its figure is a FLOOR.
 *
 * METHOD, per root:
 *   git repository  — `git -C <root> ls-files -z` (tracked files only: the set
 *                     an agent is actually asked to reason about; build output
 *                     and node_modules are untracked by convention), streamed
 *                     and cut off at `maxFiles`.
 *   not a repository — a bounded directory walk that skips the usual heavy,
 *                     generated directories (node_modules, .git, dist, …).
 *   Each file is lstat'ed: symlinks, gitlinks (submodules), files over 1 MB,
 *   binary extensions and dependency lockfiles are skipped — none of them is
 *   text an agent would read whole. Tokens = ceil(bytes / 4) (CHARS_PER_TOKEN, the same estimator the
 *   handoff preview uses, so the two numbers are comparable).
 *
 * BOUNDS: ≤ `maxFiles` (20k) entries and `timeoutMs` (5 s) wall clock per root;
 * the git child is killed when either trips. Roots are scanned concurrently.
 *
 * CACHE: 60 s per root, keyed by the canonical root path + HEAD sha, so a new
 * commit is re-measured immediately and a busy dialog does not rescan on every
 * keystroke. Uncommitted edits are covered by the TTL, not the key.
 *
 * HARDENING: git runs with `core.fsmonitor=false` (a repo-local fsmonitor hook
 * is an arbitrary command), GIT_OPTIONAL_LOCKS=0 (never take the index lock
 * under an agent that is editing), no pager and no terminal prompt.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { basename, extname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import { estimateTokensFromChars } from './context-math.js';
import { isDirectoryPath, physicalPath } from './path-guard.js';
import { VerseServiceError } from './preferences.js';
import { VERSE_MAX_WORKSPACE_ROOTS, type VerseContextFit, type VerseContextFitRoot } from './types.js';

export const CONTEXT_FIT_DEFAULT_MAX_FILES = 20_000;
export const CONTEXT_FIT_DEFAULT_TIMEOUT_MS = 5_000;
export const CONTEXT_FIT_CACHE_TTL_MS = 60_000;
/** Files larger than this are data, vendored bundles or fixtures — not read whole. */
export const CONTEXT_FIT_MAX_FILE_BYTES = 1024 * 1024;
const STAT_BATCH = 128;
const HEAD_TIMEOUT_MS = 2_000;
const CACHE_MAX_ENTRIES = 256;

/** Extensions that are never source text. Lower-case, with the dot. */
export const CONTEXT_FIT_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.tif', '.tiff', '.psd', '.heic', '.avif',
  // media
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.flac', '.mov', '.avi', '.mkv', '.webm',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives / packages
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar', '.jar', '.war', '.whl', '.dmg', '.pkg', '.deb', '.rpm', '.apk', '.ipa',
  // compiled / native
  '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.class', '.pyc', '.pyo', '.wasm', '.node', '.bin', '.dat',
  // documents / data blobs
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.sqlite', '.sqlite3', '.db', '.parquet', '.npy', '.npz', '.pkl',
  // ML weights
  '.gguf', '.safetensors', '.onnx', '.pt', '.pth', '.ckpt', '.h5',
  // misc
  '.lockb', '.map',
]);

/**
 * Generated dependency lockfiles: tracked text, often hundreds of KB, and never
 * read whole by an agent — counting them would inflate every JS/Rust/Python
 * working set with tokens nobody will spend.
 */
export const CONTEXT_FIT_SKIP_FILENAMES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum',
  'Podfile.lock', 'pubspec.lock', 'mix.lock', 'flake.lock',
]);

/** Directories a non-git walk never enters. */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo',
  '.cache', 'coverage', '.venv', 'venv', '__pycache__', '.gradle', '.idea', 'vendor', 'Pods', 'DerivedData',
]);

export interface ContextFitOptions {
  maxFiles?: number;
  timeoutMs?: number;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  storedAt: number;
  sampledAt: string;
  root: VerseContextFitRoot;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: forget every cached measurement. */
export function clearContextFitCache(): void {
  cache.clear();
}

function cacheGet(key: string, nowMs: number): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (nowMs - entry.storedAt >= CONTEXT_FIT_CACHE_TTL_MS || nowMs < entry.storedAt) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function cachePut(entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Evict the oldest insertion (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(entry.key, entry);
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

const GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
};

/** Hardened git argv prefix for a root. */
export function gitArgs(root: string, args: readonly string[]): string[] {
  return ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-C', root, ...args];
}

type GitChild = ChildProcessByStdio<null, Readable, null>;

/** Spawn git with stdout piped and everything else closed; null when spawn itself throws. */
function spawnGit(root: string, args: readonly string[]): GitChild | null {
  try {
    return spawn('git', gitArgs(root, args), {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...GIT_ENV_OVERRIDES },
    });
  } catch {
    return null;
  }
}

/** HEAD sha, or null for a non-repository / unborn branch / timeout. */
function headSha(root: string): Promise<string | null> {
  return new Promise((resolveHead) => {
    let out = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveHead(value);
    };
    const child = spawnGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!child) {
      resolveHead(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, HEAD_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (out.length < 256) out += chunk;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const sha = out.trim();
      finish(code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null);
    });
  });
}

/**
 * Stream `git ls-files -z`, stopping at `maxFiles` (+1, to learn whether the
 * list was longer) or the deadline. Null when git fails outright (not a repo).
 */
function listTrackedFiles(
  root: string,
  maxFiles: number,
  deadline: number,
): Promise<{ files: string[]; truncated: boolean } | null> {
  return new Promise((resolveList) => {
    const files: string[] = [];
    let pending = '';
    let truncated = false;
    let settled = false;
    const child = spawnGit(root, ['ls-files', '-z', '--cached']);
    if (!child) {
      resolveList(null);
      return;
    }
    const finish = (value: { files: string[]; truncated: boolean } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveList(value);
    };
    const stop = (): void => {
      truncated = true;
      child.kill('SIGKILL');
      finish({ files, truncated });
    };
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      pending += chunk;
      let nul = pending.indexOf('\0');
      while (nul !== -1) {
        const name = pending.slice(0, nul);
        pending = pending.slice(nul + 1);
        if (name.length > 0) {
          if (files.length >= maxFiles) {
            stop();
            return;
          }
          files.push(name);
        }
        nul = pending.indexOf('\0');
      }
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (settled) return;
      finish(code === 0 ? { files, truncated } : null);
    });
  });
}

// ---------------------------------------------------------------------------
// Directory walk (non-git roots)
// ---------------------------------------------------------------------------

async function walkFiles(root: string, maxFiles: number, deadline: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue: string[] = [''];
  while (queue.length > 0) {
    if (Date.now() >= deadline) return { files, truncated: true };
    const rel = queue.shift() as string;
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(entry.name)) queue.push(child);
      } else if (entry.isFile()) {
        if (files.length >= maxFiles) return { files, truncated: true };
        files.push(child);
      }
      // Symlinks are never followed: they can point anywhere, including back up.
    }
  }
  return { files, truncated: false };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

export function isContextFitBinaryPath(path: string): boolean {
  return CONTEXT_FIT_BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Paths never counted: binaries by extension, lockfiles by name. */
export function isContextFitSkippedPath(path: string): boolean {
  return isContextFitBinaryPath(path) || CONTEXT_FIT_SKIP_FILENAMES.has(basename(path));
}

async function sumSizes(
  root: string,
  names: readonly string[],
  deadline: number,
): Promise<{ files: number; bytes: number; timedOut: boolean }> {
  let files = 0;
  let bytes = 0;
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    if (Date.now() >= deadline) return { files, bytes, timedOut: true };
    const batch = names.slice(i, i + STAT_BATCH).filter((name) => !isContextFitSkippedPath(name));
    const sizes = await Promise.all(batch.map(async (name) => {
      try {
        const stat = await lstat(join(root, name));
        // lstat: a tracked symlink is a pointer, not content; a gitlink shows
        // up as a directory. Neither is counted.
        if (!stat.isFile() || stat.size > CONTEXT_FIT_MAX_FILE_BYTES) return null;
        return stat.size;
      } catch {
        return null; // Tracked but deleted in the working tree.
      }
    }));
    for (const size of sizes) {
      if (size === null) continue;
      files += 1;
      bytes += size;
    }
  }
  return { files, bytes, timedOut: false };
}

async function measureRoot(root: string, maxFiles: number, timeoutMs: number): Promise<VerseContextFitRoot> {
  const deadline = Date.now() + timeoutMs;
  const listed = (await listTrackedFiles(root, maxFiles, deadline)) ?? (await walkFiles(root, maxFiles, deadline));
  const summed = await sumSizes(root, listed.files, deadline);
  return {
    path: root,
    files: summed.files,
    bytes: summed.bytes,
    estTokens: estimateTokensFromChars(summed.bytes),
    truncated: listed.truncated || summed.timedOut,
  };
}

function canonicalRoot(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.includes('\0') || !isAbsolute(raw)) {
    throw new VerseServiceError('VERSE_INVALID', `context-fit root must be an absolute path: ${String(raw)}`);
  }
  const lexical = resolvePath(raw);
  if (!isDirectoryPath(lexical)) {
    throw new VerseServiceError('VERSE_INVALID', `context-fit root must be an existing directory: ${raw}`);
  }
  return physicalPath(lexical) ?? lexical;
}

/**
 * Estimate the token size of the code reachable from `roots`. Callers validate
 * the roots against path-guard first (the API applies the same rules
 * createSession uses); this re-checks only shape and existence.
 */
export async function estimateContextFit(roots: string[], opts: ContextFitOptions = {}): Promise<VerseContextFit> {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new VerseServiceError('VERSE_INVALID', 'context-fit needs at least one root');
  }
  if (roots.length > VERSE_MAX_WORKSPACE_ROOTS) {
    throw new VerseServiceError('VERSE_INVALID', `context-fit takes at most ${VERSE_MAX_WORKSPACE_ROOTS} roots`);
  }
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? CONTEXT_FIT_DEFAULT_MAX_FILES));
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? CONTEXT_FIT_DEFAULT_TIMEOUT_MS));
  const now = opts.now ?? (() => new Date());

  const unique: string[] = [];
  for (const raw of roots) {
    const root = canonicalRoot(raw);
    if (!unique.includes(root)) unique.push(root);
  }

  const measured = await Promise.all(unique.map(async (root) => {
    const sha = await headSha(root);
    // A different cap is a different measurement: key on it too.
    const key = `${root}\0${sha ?? 'no-head'}\0${maxFiles}`;
    const hit = cacheGet(key, now().getTime());
    if (hit) return { root: hit.root, sampledAt: hit.sampledAt };
    const result = await measureRoot(root, maxFiles, timeoutMs);
    const sampledAt = now().toISOString();
    cachePut({ key, storedAt: now().getTime(), sampledAt, root: result });
    return { root: result, sampledAt };
  }));

  // The response is as old as its oldest part — never imply a fresher reading.
  const sampledAt = measured.map((m) => m.sampledAt).sort()[0] ?? now().toISOString();
  return {
    roots: measured.map((m) => ({ ...m.root })),
    totalEstTokens: measured.reduce((sum, m) => sum + m.root.estTokens, 0),
    estimator: 'bytes/4',
    sampledAt,
  };
}
