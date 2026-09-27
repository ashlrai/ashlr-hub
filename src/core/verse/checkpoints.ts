/**
 * core/verse/checkpoints.ts — the git plumbing behind per-turn checkpoints,
 * the Changes pane and Undo/Redo (wire shapes: checkpoint-types.ts; policy,
 * journal and plans: checkpoint-service.ts; routes: checkpoints-api.ts).
 *
 * WHAT A CHECKPOINT IS. A commit object whose tree is the repository's working
 * tree at one moment — tracked files as they are ON DISK (staged or not) plus
 * untracked, non-ignored files — kept alive by a hidden ref under
 * `refs/ashlr/checkpoints/…`. It is built the way `git stash -u` builds its
 * untracked commit, with one difference that matters: it never writes the
 * stash reflog, the operator's index, HEAD or any branch.
 *
 * THE RULES THIS FILE KEEPS (tests assert each one on real repositories)
 *
 *  1. NEVER THE OPERATOR'S INDEX. Every command that needs an index gets a
 *     private one through GIT_INDEX_FILE, in a fresh 0700 temp directory that
 *     is removed afterwards. The real index is only ever READ (copied, with its
 *     mtime, so git's racy-clean check still works on the copy).
 *  2. NEVER THE STASH, HEAD OR A BRANCH. No `stash`, `reset`, `checkout`,
 *     `switch`, `restore`, `commit` or `merge`. The only ref writes are
 *     `update-ref` / `update-ref -d` under VERSE_CHECKPOINT_REF_ROOT, and every
 *     ref name is built here from validated parts.
 *  3. RESTORE WRITES ONLY THE FILES IT WAS ASKED TO. Files come out of a
 *     checkpoint through `checkout-index` against a PRIVATE index (so modes,
 *     symlinks, binaries and filters behave exactly like git), and a file the
 *     checkpoint does not have is unlinked — a file or symlink only, never a
 *     directory, never anything whose real parent lies outside the repository.
 *  4. BOUNDED. A changed file over VERSE_CHECKPOINT_MAX_FILE_BYTES, or past the
 *     VERSE_CHECKPOINT_MAX_TOTAL_BYTES budget, is not hashed; it is listed in
 *     the checkpoint's manifest as skipped, and every restore leaves skipped
 *     files alone (restoring a stale copy would be silent data loss). More than
 *     VERSE_CHECKPOINT_MAX_CHANGED_PATHS changed paths and there is no
 *     checkpoint at all, said so plainly.
 *  5. NOTHING BLOCKS THE SERVER (#523). Every child is async, named with
 *     `git -C <repo>` and started in `/` (so the chdir into a TCC-guarded
 *     folder happens inside git, not on the event loop), and every project
 *     file read or write is fs/promises through withFolderIo.
 *  6. NO SURPRISE PROGRAMS. `core.fsmonitor=false`, and every diff runs with
 *     `--no-ext-diff --no-textconv`: a repository's config cannot make a
 *     checkpoint launch a helper.
 *
 * NODE-ONLY.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdtemp, readFile, realpath, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { mapLimited, withFolderIo } from './folder-io.js';
import { EMPTY_TREE_SHA, gitChildEnv, isSafeRepoPath, parseNameStatusZ, parseNumstatZ } from './git-ops.js';
import {
  VERSE_CHECKPOINT_MAX_CHANGED_PATHS,
  VERSE_CHECKPOINT_MAX_FILE_BYTES,
  VERSE_CHECKPOINT_MAX_TOTAL_BYTES,
  VERSE_CHECKPOINT_MERGE_MAX_BYTES,
  VERSE_CHECKPOINT_REF_ROOT,
  type VerseCheckpointFileStatus,
  type VerseCheckpointMergePreview,
  type VerseCheckpointSkipped,
} from './checkpoint-types.js';
import { VERSE_GIT_PATCH_MAX_BYTES, VERSE_GIT_TIMEOUT_MS } from './workbench-types.js';

// ===========================================================================
// Runner — the seam tests can fake; production spawns git -C <repo> from /
// ===========================================================================

export interface CheckpointRunOptions {
  /** Extra environment (GIT_INDEX_FILE, GIT_LITERAL_PATHSPECS, identity). */
  env?: Record<string, string>;
  /** Written to stdin, then closed. Absent: stdin is closed at once. */
  input?: string | Buffer;
  timeoutMs?: number;
  maxStdoutBytes?: number;
}

export interface CheckpointRunResult {
  /** null when killed (timeout, truncation) or never started. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  missing: boolean;
}

export type CheckpointGitRunner = (gitRoot: string, args: readonly string[], opts?: CheckpointRunOptions) => Promise<CheckpointRunResult>;

/** Prepended to every command: stable output, no helper programs. */
const GIT_BASE = [
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'gc.auto=0',
] as const;

/** Variables that would point git somewhere other than the repository we name. */
const REPO_ENV_KEYS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXTERNAL_DIFF', 'GIT_DIFF_OPTS', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
];

export function checkpointChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env = gitChildEnv();
  for (const key of REPO_ENV_KEYS) delete env[key];
  return { ...env, ...extra };
}

const DEFAULT_MAX_STDOUT = 32 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;

export const defaultCheckpointGit: CheckpointGitRunner = (gitRoot, args, opts = {}) =>
  new Promise<CheckpointRunResult>((resolveRun) => {
    const timeoutMs = opts.timeoutMs ?? VERSE_GIT_TIMEOUT_MS;
    const maxStdout = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const clock: { timer?: NodeJS.Timeout } = {};
    const finish = (code: number | null, missing: boolean): void => {
      if (settled) return;
      settled = true;
      if (clock.timer) clearTimeout(clock.timer);
      resolveRun({ code: truncated || timedOut ? null : code, stdout: Buffer.concat(out), stderr: err, timedOut, truncated, missing });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', ['-C', gitRoot, ...GIT_BASE, ...args], {
        // #523: never start a child IN a project folder; git enters it itself.
        cwd: '/',
        env: checkpointChildEnv(opts.env),
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolveRun({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, truncated: false, missing: true });
      return;
    }
    clock.timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxStdout - outBytes;
      if (chunk.length > room) {
        out.push(chunk.subarray(0, Math.max(0, room)));
        outBytes = maxStdout;
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < MAX_STDERR) err += chunk.toString('utf8').slice(0, MAX_STDERR - err.length);
    });
    child.on('error', (e: NodeJS.ErrnoException) => finish(null, e.code === 'ENOENT'));
    child.on('close', (code) => finish(code, false));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* EPIPE when git exits early; the exit code tells */ });
      child.stdin.end(opts.input);
    }
  });

// ===========================================================================
// Errors — a code, an HTTP status, one operator sentence (stderr never leaks)
// ===========================================================================

export type CheckpointErrorCode =
  | 'VERSE_INVALID'
  | 'VERSE_NOT_FOUND'
  | 'VERSE_CHECKPOINT_UNAVAILABLE'
  | 'VERSE_CHECKPOINT_STALE'
  | 'VERSE_CHECKPOINT_BUSY'
  | 'VERSE_CHECKPOINT_FAILED';

const ERROR_HTTP: Record<CheckpointErrorCode, number> = {
  VERSE_INVALID: 400,
  VERSE_NOT_FOUND: 404,
  VERSE_CHECKPOINT_UNAVAILABLE: 409,
  VERSE_CHECKPOINT_STALE: 409,
  VERSE_CHECKPOINT_BUSY: 409,
  VERSE_CHECKPOINT_FAILED: 502,
};

export class CheckpointError extends Error {
  readonly code: CheckpointErrorCode;
  readonly status: number;
  constructor(code: CheckpointErrorCode, message: string) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
    this.status = ERROR_HTTP[code];
  }
}

function failed(action: string, res: CheckpointRunResult): CheckpointError {
  if (res.timedOut) return new CheckpointError('VERSE_CHECKPOINT_FAILED', `${action} took too long and was stopped.`);
  if (res.missing) return new CheckpointError('VERSE_CHECKPOINT_FAILED', `${action} needs git, which is not installed.`);
  const e = res.stderr.toLowerCase();
  if (e.includes('index.lock') || e.includes('another git process') || (e.includes('.lock') && e.includes('exists'))) {
    return new CheckpointError('VERSE_CHECKPOINT_BUSY', 'Another git process is working in this repository. Try again when it finishes.');
  }
  if (e.includes('beyond a symbolic link')) {
    return new CheckpointError('VERSE_CHECKPOINT_FAILED', `${action} refused to write through a symbolic link.`);
  }
  return new CheckpointError('VERSE_CHECKPOINT_FAILED', `${action} failed${res.code === null ? '' : ` (git exit ${res.code})`}.`);
}

// ===========================================================================
// Names
// ===========================================================================

export type CheckpointRefKind = 'pre' | 'post' | 'undo' | 'undone';

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A ref path segment for any id: itself when plain, else a stable hash. Never `.`, `..`, `/`, `~`, `^`, `:`. */
export function refSegment(id: string): string {
  if (SAFE_SEGMENT.test(id)) return id;
  return `h${createHash('sha256').update(id).digest('hex').slice(0, 40)}`;
}

export function chatRefPrefix(chatId: string): string {
  return `${VERSE_CHECKPOINT_REF_ROOT}/${refSegment(chatId)}`;
}

/**
 * `refs/ashlr/checkpoints/<chat>/<turn>/<root>/<kind>`. The root segment keeps
 * two roots of one chat apart even when they share a repository (a linked
 * worktree shares its refs with the main one).
 */
export function checkpointRefName(chatId: string, turnId: string, rootId: string, kind: CheckpointRefKind): string {
  return `${chatRefPrefix(chatId)}/${refSegment(turnId)}/${refSegment(rootId)}/${kind}`;
}

/** The opaque id of a repository root: stable, path-free on the wire. */
export function rootIdFor(gitRoot: string): string {
  return createHash('sha256').update(resolvePath(gitRoot)).digest('hex').slice(0, 12);
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA.test(value);
}

// ===========================================================================
// Repository identity
// ===========================================================================

/** The repository's top level for `dir`, or null when it is not in a work tree (bare, missing, not git). */
export async function resolveRepoTop(dir: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<string | null> {
  const res = await run(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
  const top = res.stdout.toString('utf8').trim();
  return res.code === 0 && top && isAbsolute(top) ? resolvePath(top) : null;
}

async function headCommit(gitRoot: string, run: CheckpointGitRunner): Promise<string | null> {
  const res = await run(gitRoot, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isSha(sha) ? sha : null;
}

async function gitPath(gitRoot: string, name: string, run: CheckpointGitRunner): Promise<string | null> {
  const res = await run(gitRoot, ['rev-parse', '--git-path', name]);
  const rel = res.stdout.toString('utf8').trim();
  if (res.code !== 0 || !rel) return null;
  return isAbsolute(rel) ? rel : join(gitRoot, rel);
}

// ===========================================================================
// Private index
// ===========================================================================

/** A fresh private temp directory (0700 by mkdtemp) for an index or merge scratch files; removed afterwards. */
async function withPrivateIndex<T>(fn: (indexFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ashlr-checkpoint-'));
  try {
    return await fn(join(dir, 'index'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Identity for checkpoint commits: never the operator's, never a prompt, never a signature. */
const CHECKPOINT_IDENT: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Ashlr Verse',
  GIT_AUTHOR_EMAIL: 'checkpoints@verse.ashlr.invalid',
  GIT_COMMITTER_NAME: 'Ashlr Verse',
  GIT_COMMITTER_EMAIL: 'checkpoints@verse.ashlr.invalid',
};

// ===========================================================================
// Snapshot
// ===========================================================================

export interface SnapshotLimits {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxChangedPaths?: number;
}

export interface SnapshotOptions extends SnapshotLimits {
  run?: CheckpointGitRunner;
  /** One line for the commit subject. */
  label?: string;
}

export interface SnapshotResult {
  commit: string;
  tree: string;
  head: string | null;
  skipped: VerseCheckpointSkipped[];
  /** Changed paths (vs the index) that were considered. */
  changed: number;
  bytesHashed: number;
  ms: number;
}

const MANIFEST_PREFIX = 'ashlr-checkpoint: ';
/** Skipped entries recorded in a manifest; past this the checkpoint is refused (restore needs the full list). */
const MAX_SKIPPED_RECORDED = 2_000;

/** Split `ls-files -z` style output into unique paths, in order. */
function splitZ(buf: Buffer): string[] {
  const seen = new Set<string>();
  for (const p of buf.toString('utf8').split('\0')) if (p) seen.add(p);
  return [...seen];
}

/**
 * Snapshot the working tree of `gitRoot` into a checkpoint commit. Nothing
 * visible to the operator changes: the commit is unreferenced until the
 * caller points a hidden ref at it.
 */
export async function snapshotWorkingTree(gitRoot: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
  const run = opts.run ?? defaultCheckpointGit;
  const started = Date.now();
  const [head, realIndex] = await Promise.all([headCommit(gitRoot, run), gitPath(gitRoot, 'index', run)]);
  if (realIndex === null) throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', 'This folder is not a git repository.');
  return withPrivateIndex(async (indexFile) => {
    // Seed from a COPY of the real index: git then re-hashes only what
    // changed. A copy that git cannot use (split index, conflicts it cannot
    // write a tree from) falls back to a fresh index built from HEAD.
    let seeded = false;
    try {
      const info = await withFolderIo(() => stat(realIndex));
      await withFolderIo(() => copyFile(realIndex, indexFile));
      // The copy keeps the original mtime: git's racy-clean check compares
      // entry mtimes against the INDEX FILE's mtime.
      await utimes(indexFile, info.atime, info.mtime);
      seeded = true;
    } catch {
      seeded = false;
    }
    let built = await buildTree(gitRoot, indexFile, head, seeded, run, opts);
    if (built === null && seeded) {
      await rm(indexFile, { force: true });
      built = await buildTree(gitRoot, indexFile, head, false, run, opts);
    }
    if (built === null) throw new CheckpointError('VERSE_CHECKPOINT_FAILED', 'Git could not record a snapshot of this working tree.');
    const manifest = JSON.stringify({ v: 1, head, skipped: built.skipped });
    const message = `${opts.label ?? 'Ashlr Verse checkpoint'}\n\n${MANIFEST_PREFIX}${manifest}\n`;
    const commitArgs = ['commit-tree', '--no-gpg-sign', built.tree, ...(head ? ['-p', head] : []), '-F', '-'];
    const res = await run(gitRoot, commitArgs, { env: CHECKPOINT_IDENT, input: message });
    const commit = res.stdout.toString('utf8').trim();
    if (res.code !== 0 || !isSha(commit)) throw failed('Recording the checkpoint', res);
    return { commit, tree: built.tree, head, skipped: built.skipped, changed: built.changed, bytesHashed: built.bytes, ms: Date.now() - started };
  });
}

async function buildTree(
  gitRoot: string,
  indexFile: string,
  head: string | null,
  seeded: boolean,
  run: CheckpointGitRunner,
  limits: SnapshotLimits,
): Promise<{ tree: string; skipped: VerseCheckpointSkipped[]; changed: number; bytes: number } | null> {
  const env = { GIT_INDEX_FILE: indexFile };
  if (!seeded && head) {
    const rt = await run(gitRoot, ['read-tree', head], { env });
    if (rt.code !== 0) return null;
  }
  // Modified, deleted and untracked-but-not-ignored, relative to the (copied) index.
  const ls = await run(gitRoot, ['ls-files', '-z', '--modified', '--deleted', '--others', '--exclude-standard'], { env });
  if (ls.code !== 0) return null;
  // `--others` names an untracked nested repository as `dir/`: never captured.
  const listed = splitZ(ls.stdout);
  const maxPaths = limits.maxChangedPaths ?? VERSE_CHECKPOINT_MAX_CHANGED_PATHS;
  if (listed.length > maxPaths) {
    throw new CheckpointError(
      'VERSE_CHECKPOINT_UNAVAILABLE',
      `More than ${maxPaths.toLocaleString('en-US')} files changed; this working tree is too large to checkpoint.`,
    );
  }
  const maxFile = limits.maxFileBytes ?? VERSE_CHECKPOINT_MAX_FILE_BYTES;
  const maxTotal = limits.maxTotalBytes ?? VERSE_CHECKPOINT_MAX_TOTAL_BYTES;
  const infos = await mapLimited(listed, 8, (p) =>
    p.endsWith('/')
      ? Promise.resolve<'dir' | 'missing' | { size: number; dir: boolean }>('dir')
      : withFolderIo(() => lstat(join(gitRoot, p))).then(
        (s) => ({ size: s.size, dir: s.isDirectory() }),
        () => 'missing' as const,
      ));
  const update: string[] = [];
  const skipped: VerseCheckpointSkipped[] = [];
  let bytes = 0;
  listed.forEach((p, i) => {
    const info = infos[i]!;
    if (info === 'missing') {
      update.push(p); // a deletion: update-index --remove records it
      return;
    }
    if (info === 'dir' || info.dir) {
      skipped.push({ path: p.replace(/\/$/, ''), reason: 'not-a-file' });
      return;
    }
    if (info.size > maxFile) {
      skipped.push({ path: p, reason: 'too-large' });
      return;
    }
    if (bytes + info.size > maxTotal) {
      skipped.push({ path: p, reason: 'budget' });
      return;
    }
    bytes += info.size;
    update.push(p);
  });
  if (skipped.length > MAX_SKIPPED_RECORDED) {
    throw new CheckpointError('VERSE_CHECKPOINT_UNAVAILABLE', 'Too many files are too large to checkpoint in this working tree.');
  }
  if (update.length > 0) {
    const up = await run(gitRoot, ['update-index', '-z', '--add', '--remove', '--stdin'], {
      env,
      input: `${update.join('\0')}\0`,
      timeoutMs: VERSE_GIT_TIMEOUT_MS,
    });
    if (up.code !== 0) return null;
  }
  const wt = await run(gitRoot, ['write-tree'], { env });
  const tree = wt.stdout.toString('utf8').trim();
  if (wt.code !== 0 || !isSha(tree)) return null;
  return { tree, skipped, changed: listed.length, bytes };
}

export interface CheckpointManifest {
  head: string | null;
  skipped: VerseCheckpointSkipped[];
}

/** The manifest a checkpoint commit carries (skipped files), or null when `commit` is not a checkpoint. */
export async function readCheckpointManifest(gitRoot: string, commit: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<CheckpointManifest | null> {
  if (!isSha(commit)) return null;
  const res = await run(gitRoot, ['cat-file', 'commit', commit], { maxStdoutBytes: 4 * 1024 * 1024 });
  if (res.code !== 0) return null;
  const text = res.stdout.toString('utf8');
  const line = text.split('\n').find((l) => l.startsWith(MANIFEST_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(MANIFEST_PREFIX.length)) as { head?: unknown; skipped?: unknown };
    const skipped = Array.isArray(parsed.skipped)
      ? parsed.skipped.filter((s): s is VerseCheckpointSkipped =>
        !!s && typeof s === 'object' && typeof (s as VerseCheckpointSkipped).path === 'string')
      : [];
    return { head: isSha(parsed.head) ? parsed.head : null, skipped };
  } catch {
    return null;
  }
}

// ===========================================================================
// Hidden refs
// ===========================================================================

function assertCheckpointRef(ref: string): void {
  if (!ref.startsWith(`${VERSE_CHECKPOINT_REF_ROOT}/`) || ref.includes('..') || /[\s~^:?*[\\]/.test(ref)) {
    throw new CheckpointError('VERSE_INVALID', 'not a checkpoint ref');
  }
}

export async function setCheckpointRef(gitRoot: string, ref: string, commit: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<void> {
  assertCheckpointRef(ref);
  if (!isSha(commit)) throw new CheckpointError('VERSE_INVALID', 'not a commit');
  const res = await run(gitRoot, ['update-ref', '-m', 'ashlr verse checkpoint', ref, commit]);
  if (res.code !== 0) throw failed('Saving the checkpoint', res);
}

export async function readCheckpointRef(gitRoot: string, ref: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<string | null> {
  assertCheckpointRef(ref);
  const res = await run(gitRoot, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  const sha = res.stdout.toString('utf8').trim();
  return res.code === 0 && isSha(sha) ? sha : null;
}

/** Every ref under `prefix` (a checkpoint namespace) → its commit. */
export async function listCheckpointRefs(gitRoot: string, prefix: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<Map<string, string>> {
  assertCheckpointRef(`${prefix}/x`);
  const res = await run(gitRoot, ['for-each-ref', '--format=%(objectname) %(refname)', `${prefix}/`]);
  const out = new Map<string, string>();
  if (res.code !== 0) return out;
  for (const line of res.stdout.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space <= 0) continue;
    const sha = line.slice(0, space);
    if (isSha(sha)) out.set(line.slice(space + 1), sha);
  }
  return out;
}

/** Remove every ref under `prefix` (a deleted chat's checkpoints). Objects are left to git gc. */
export async function deleteCheckpointRefs(gitRoot: string, prefix: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<number> {
  const refs = await listCheckpointRefs(gitRoot, prefix, run);
  if (refs.size === 0) return 0;
  const script = [...refs.keys()].map((ref) => `delete ${ref}\n`).join('');
  const res = await run(gitRoot, ['update-ref', '--stdin'], { input: script });
  if (res.code !== 0) throw failed('Removing old checkpoints', res);
  return refs.size;
}

// ===========================================================================
// Diffs between checkpoints
// ===========================================================================

export interface CheckpointDiffEntry {
  path: string;
  oldPath: string | null;
  status: VerseCheckpointFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

const DIFF_SAFE = ['--no-ext-diff', '--no-textconv', '--no-color'] as const;

/** Files that differ between two checkpoint commits (renames detected). */
export async function diffCheckpoints(gitRoot: string, a: string, b: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<CheckpointDiffEntry[]> {
  if (!isSha(a) || !isSha(b)) throw new CheckpointError('VERSE_INVALID', 'not a commit');
  const [numstat, names] = await Promise.all([
    run(gitRoot, ['diff', ...DIFF_SAFE, '-z', '--numstat', '-M', a, b, '--']),
    run(gitRoot, ['diff', ...DIFF_SAFE, '-z', '--name-status', '-M', a, b, '--']),
  ]);
  if (numstat.code !== 0 || names.code !== 0) throw failed('Reading the changes', numstat.code !== 0 ? numstat : names);
  const statusByPath = parseNameStatusZ(names.stdout.toString('utf8'));
  const files: CheckpointDiffEntry[] = [];
  for (const entry of parseNumstatZ(numstat.stdout.toString('utf8'))) {
    const named = statusByPath.get(entry.path);
    const raw = named?.status ?? (entry.oldPath ? 'R' : 'M');
    const status: VerseCheckpointFileStatus = raw === 'U' ? 'M' : raw;
    files.push({
      path: entry.path,
      oldPath: entry.oldPath ?? named?.oldPath ?? null,
      status,
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
    });
  }
  files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return files;
}

/** Every path whose content differs between two commits (no rename pairing: each side separately). */
export async function changedPathsBetween(gitRoot: string, a: string, b: string, run: CheckpointGitRunner = defaultCheckpointGit): Promise<string[]> {
  const res = await run(gitRoot, ['diff', ...DIFF_SAFE, '-z', '--name-only', '--no-renames', a, b, '--']);
  if (res.code !== 0) throw failed('Reading the changes', res);
  return splitZ(res.stdout);
}

export interface CheckpointPatch {
  /** Byte-exact (latin1) text: what hunk hashes and reverts operate on. */
  raw: string;
  truncated: boolean;
  binary: boolean;
}

/** The unified patch for one file between two commits, cut at VERSE_GIT_PATCH_MAX_BYTES. */
export async function patchBetween(
  gitRoot: string,
  a: string,
  b: string,
  path: string,
  oldPath: string | null,
  run: CheckpointGitRunner = defaultCheckpointGit,
): Promise<CheckpointPatch> {
  if (!isSafeRepoPath(path) || (oldPath !== null && !isSafeRepoPath(oldPath))) throw new CheckpointError('VERSE_INVALID', 'file must be a path inside the repository.');
  const res = await run(
    gitRoot,
    ['diff', ...DIFF_SAFE, '-M', a, b, '--', ...(oldPath && oldPath !== path ? [oldPath] : []), path],
    { env: { GIT_LITERAL_PATHSPECS: '1' }, maxStdoutBytes: VERSE_GIT_PATCH_MAX_BYTES + 1 },
  );
  if (!res.truncated && res.code !== 0) throw failed('Reading the patch', res);
  let raw = res.stdout.toString('latin1');
  const truncated = res.truncated || res.stdout.length > VERSE_GIT_PATCH_MAX_BYTES;
  if (truncated) {
    raw = res.stdout.subarray(0, VERSE_GIT_PATCH_MAX_BYTES).toString('latin1');
    const nl = raw.lastIndexOf('\n');
    if (nl > 0) raw = raw.slice(0, nl + 1);
  }
  const binary = /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw);
  return { raw, truncated, binary };
}

/** latin1 bytes → display text (UTF-8 where valid). */
export function latin1ToUtf8(raw: string): string {
  return Buffer.from(raw, 'latin1').toString('utf8');
}

// ===========================================================================
// Tree entries and blobs
// ===========================================================================

export interface TreeEntry {
  mode: string;
  type: 'blob' | 'commit' | 'tree';
  oid: string;
}

/** `path → entry` for the given paths in `treeish` (absent paths are simply missing from the map). */
export async function treeEntries(
  gitRoot: string,
  treeish: string,
  paths: readonly string[],
  run: CheckpointGitRunner = defaultCheckpointGit,
): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  if (paths.length === 0) return out;
  if (!isSha(treeish)) throw new CheckpointError('VERSE_INVALID', 'not a commit');
  for (let i = 0; i < paths.length; i += 256) {
    const batch = paths.slice(i, i + 256);
    const res = await run(gitRoot, ['ls-tree', '-z', '--full-tree', treeish, '--', ...batch], { env: { GIT_LITERAL_PATHSPECS: '1' } });
    if (res.code !== 0) throw failed('Reading the checkpoint', res);
    for (const rec of res.stdout.toString('utf8').split('\0')) {
      if (!rec) continue;
      // <mode> SP <type> SP <oid> TAB <path>
      const tab = rec.indexOf('\t');
      if (tab < 0) continue;
      const [mode, type, oid] = rec.slice(0, tab).split(' ');
      if (!mode || !oid || (type !== 'blob' && type !== 'commit' && type !== 'tree')) continue;
      out.set(rec.slice(tab + 1), { mode, type, oid });
    }
  }
  return out;
}

/** One blob's bytes, or null past `maxBytes` / missing. */
export async function readBlob(gitRoot: string, oid: string, maxBytes: number, run: CheckpointGitRunner = defaultCheckpointGit): Promise<Buffer | null> {
  if (!isSha(oid)) return null;
  const res = await run(gitRoot, ['cat-file', 'blob', oid], { maxStdoutBytes: maxBytes + 1 });
  if (res.code !== 0 || res.truncated || res.stdout.length > maxBytes) return null;
  return res.stdout;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

// ===========================================================================
// Writing files out of a checkpoint (never the index, never a directory)
// ===========================================================================

/** `rel` inside `gitRoot`, with its real parent directory also inside the repository. */
async function safeTarget(gitRoot: string, realRoot: string, rel: string): Promise<string> {
  if (!isSafeRepoPath(rel)) throw new CheckpointError('VERSE_INVALID', 'file must be a path inside the repository.');
  const abs = resolvePath(gitRoot, rel);
  const within = (root: string, p: string) => {
    const r = relative(root, p);
    return r !== '' && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r);
  };
  if (!within(gitRoot, abs)) throw new CheckpointError('VERSE_INVALID', 'file must be a path inside the repository.');
  // Walk up to the nearest existing ancestor; its REAL path must stay in the repo.
  let dir = dirname(abs);
  for (;;) {
    try {
      const real = await withFolderIo(() => realpath(dir));
      if (real !== realRoot && !within(realRoot, real)) {
        throw new CheckpointError('VERSE_INVALID', `${rel} is behind a link that leaves the repository.`);
      }
      break;
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
      const parent = dirname(dir);
      if (parent === dir || !within(gitRoot, dir)) break;
      dir = parent;
    }
  }
  if (rel.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git')) throw new CheckpointError('VERSE_INVALID', 'Verse never writes inside .git.');
  return abs;
}

export interface WriteOutResult {
  written: string[];
  deleted: string[];
  /** Paths the checkpoint names as a directory or submodule: left alone. */
  leftAlone: string[];
}

/**
 * Make each of `paths` on disk match `commit`: files the commit has are
 * checked out through a PRIVATE index; files it lacks are unlinked.
 */
export async function writePathsFromCheckpoint(
  gitRoot: string,
  commit: string,
  paths: readonly string[],
  run: CheckpointGitRunner = defaultCheckpointGit,
): Promise<WriteOutResult> {
  const result: WriteOutResult = { written: [], deleted: [], leftAlone: [] };
  if (paths.length === 0) return result;
  const realRoot = await withFolderIo(() => realpath(gitRoot));
  const unique = [...new Set(paths)];
  for (const p of unique) await safeTarget(gitRoot, realRoot, p);
  const entries = await treeEntries(gitRoot, commit, unique, run);
  const present: string[] = [];
  const absent: string[] = [];
  for (const p of unique) {
    const e = entries.get(p);
    if (!e) {
      absent.push(p);
    } else if (e.type !== 'blob') {
      result.leftAlone.push(p);
    } else {
      // `checkout-index -f` would remove a DIRECTORY in the way, with whatever
      // it holds. A directory where the checkpoint has a file stays put.
      const onDisk = await withFolderIo(() => lstat(resolvePath(gitRoot, p))).catch(() => null);
      if (onDisk?.isDirectory()) result.leftAlone.push(p);
      else present.push(p);
    }
  }
  // Removals first: a path that was a file may be a directory in the checkpoint
  // (or the reverse), and checkout-index needs the way cleared.
  for (const p of absent) {
    const abs = await safeTarget(gitRoot, realRoot, p);
    let info;
    try {
      info = await withFolderIo(() => lstat(abs));
    } catch {
      continue; // already gone
    }
    if (info.isDirectory()) {
      result.leftAlone.push(p);
      continue;
    }
    await withFolderIo(() => rm(abs, { force: true }));
    result.deleted.push(p);
    await pruneEmptyParents(gitRoot, abs);
  }
  if (present.length > 0) {
    await withPrivateIndex(async (indexFile) => {
      const env = { GIT_INDEX_FILE: indexFile };
      const rt = await run(gitRoot, ['read-tree', commit], { env });
      if (rt.code !== 0) throw failed('Reading the checkpoint', rt);
      const co = await run(gitRoot, ['checkout-index', '-f', '-z', '--stdin'], { env, input: `${present.join('\0')}\0` });
      if (co.code !== 0) throw failed('Restoring files', co);
    });
    result.written.push(...present);
  }
  return result;
}

async function pruneEmptyParents(gitRoot: string, abs: string): Promise<void> {
  let dir = dirname(abs);
  while (dir !== gitRoot && dir.startsWith(`${gitRoot}${sep}`)) {
    try {
      await withFolderIo(() => rmdir(dir)); // fails (ENOTEMPTY) the moment a directory holds anything
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

/** Write `content` to `rel` (an existing or new regular file), keeping its mode. */
export async function writeRepoFile(gitRoot: string, rel: string, content: Buffer): Promise<void> {
  const realRoot = await withFolderIo(() => realpath(gitRoot));
  const abs = await safeTarget(gitRoot, realRoot, rel);
  try {
    const info = await withFolderIo(() => lstat(abs));
    if (!info.isFile()) throw new CheckpointError('VERSE_CHECKPOINT_STALE', `${rel} is no longer a regular file.`);
  } catch (err) {
    if (err instanceof CheckpointError) throw err;
  }
  await withFolderIo(() => writeFile(abs, content));
}

export async function readRepoFile(gitRoot: string, rel: string, maxBytes: number): Promise<Buffer | null> {
  const realRoot = await withFolderIo(() => realpath(gitRoot));
  const abs = await safeTarget(gitRoot, realRoot, rel);
  try {
    const info = await withFolderIo(() => lstat(abs));
    if (!info.isFile() || info.size > maxBytes) return null;
    return await withFolderIo(() => readFile(abs));
  } catch {
    return null;
  }
}

// ===========================================================================
// Three-way merge preview (git merge-file on private temp copies)
// ===========================================================================

/**
 * Merge `ours` (what is on disk now) with `theirs` (the checkpoint) over
 * `base` (what the agent left): a clean result keeps later edits AND reverts
 * the agent's. Never touches the repository: the three sides are private
 * temp files and the result comes back on stdout.
 */
export async function mergeThreeWay(
  ours: Buffer | null,
  base: Buffer | null,
  theirs: Buffer | null,
  run: CheckpointGitRunner = defaultCheckpointGit,
): Promise<VerseCheckpointMergePreview> {
  if (ours === null || base === null || theirs === null) return { clean: false, text: null, conflicts: 1 };
  if ([ours, base, theirs].some((b) => b.length > VERSE_CHECKPOINT_MERGE_MAX_BYTES || looksBinary(b))) {
    return { clean: false, text: null, conflicts: 1 };
  }
  return withPrivateIndex(async (scratch) => {
    const dir = dirname(scratch);
    const [o, b, t] = [join(dir, 'yours'), join(dir, 'base'), join(dir, 'checkpoint')];
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    const res = await run(dir, ['merge-file', '-p', '--diff3', '-L', 'on disk now', '-L', 'after the agent', '-L', 'checkpoint', o, b, t], {
      maxStdoutBytes: VERSE_CHECKPOINT_MERGE_MAX_BYTES * 3,
    });
    // Exit status: 0 clean, N > 0 conflicts, negative (255) on error.
    if (res.code === null || res.code < 0 || res.code >= 128) return { clean: false, text: null, conflicts: 1 };
    return { clean: res.code === 0, text: res.stdout.toString('utf8'), conflicts: res.code };
  });
}

/** Merged bytes, only when the merge was clean. */
export async function mergedBytes(ours: Buffer, base: Buffer, theirs: Buffer, run: CheckpointGitRunner = defaultCheckpointGit): Promise<Buffer | null> {
  return withPrivateIndex(async (scratch) => {
    const dir = dirname(scratch);
    const [o, b, t] = [join(dir, 'yours'), join(dir, 'base'), join(dir, 'checkpoint')];
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    const res = await run(dir, ['merge-file', '-p', o, b, t], { maxStdoutBytes: VERSE_CHECKPOINT_MERGE_MAX_BYTES * 3 });
    return res.code === 0 ? res.stdout : null;
  });
}

// ===========================================================================
// Hunks — pure, byte-exact (latin1 strings map 1:1 to bytes)
// ===========================================================================

export interface ParsedHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Body lines, each with its ' ', '-', '+' or '\\' prefix, no newline. */
  lines: string[];
  hash: string;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function hunkHash(header: string, lines: readonly string[]): string {
  return createHash('sha256').update(header.replace(/ @@.*$/, ' @@')).update('\n').update(lines.join('\n')).digest('hex').slice(0, 20);
}

/** The hunks of a one-file unified patch (latin1 text). */
export function parsePatchHunks(raw: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = [];
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let cur: Omit<ParsedHunk, 'hash'> | null = null;
  const close = () => {
    if (cur) hunks.push({ ...cur, hash: hunkHash(cur.header, cur.lines) });
    cur = null;
  };
  for (const line of lines) {
    const m = HUNK_HEADER.exec(line);
    if (m) {
      close();
      cur = {
        index: hunks.length,
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      continue;
    }
    if (!cur) continue;
    const c = line[0];
    if (c === ' ' || c === '-' || c === '+' || c === '\\') (cur as Omit<ParsedHunk, 'hash'>).lines.push(line);
    else if (line === '') (cur as Omit<ParsedHunk, 'hash'>).lines.push(' '); // a blank context line some tools emit bare
    else close();
  }
  close();
  return hunks;
}

/** Split bytes-as-latin1 into lines that keep their '\n' (the last may lack one). */
function splitKeep(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** The two sides of a hunk as full lines (with '\n' unless git said "No newline at end of file"). */
function hunkSides(h: ParsedHunk): { oldSide: string[]; newSide: string[] } {
  const oldSide: string[] = [];
  const newSide: string[] = [];
  let last: 'old' | 'new' | 'both' | null = null;
  for (const line of h.lines) {
    const c = line[0];
    const body = line.slice(1);
    if (c === '\\') {
      // Applies to the line just before it.
      if (last === 'old' || last === 'both') oldSide[oldSide.length - 1] = oldSide[oldSide.length - 1]!.replace(/\n$/, '');
      if (last === 'new' || last === 'both') newSide[newSide.length - 1] = newSide[newSide.length - 1]!.replace(/\n$/, '');
      continue;
    }
    if (c === ' ') {
      oldSide.push(`${body}\n`);
      newSide.push(`${body}\n`);
      last = 'both';
    } else if (c === '-') {
      oldSide.push(`${body}\n`);
      last = 'old';
    } else if (c === '+') {
      newSide.push(`${body}\n`);
      last = 'new';
    }
  }
  return { oldSide, newSide };
}

/**
 * Undo one hunk in `current` (the NEW side of the patch, latin1): its new-side
 * lines must sit exactly where the header says, else null (the file moved on;
 * the caller refuses rather than guesses).
 */
export function revertHunk(current: string, hunk: ParsedHunk): string | null {
  const lines = splitKeep(current);
  const { oldSide, newSide } = hunkSides(hunk);
  const at = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1;
  if (at < 0 || at + newSide.length > lines.length) return null;
  for (let i = 0; i < newSide.length; i++) if (lines[at + i] !== newSide[i]) return null;
  // A hunk that ends at EOF with the file's last line lacking '\n' is covered
  // by the equality above; the rest of the file is untouched.
  return [...lines.slice(0, at), ...oldSide, ...lines.slice(at + newSide.length)].join('');
}

// ===========================================================================
// Hunk reject on disk
// ===========================================================================

export interface RejectHunkInput {
  gitRoot: string;
  /** Checkpoint the hunk is reverted to. */
  base: string;
  /** A fresh snapshot of the working tree (the patch's new side). */
  now: string;
  path: string;
  oldPath: string | null;
  hash: string;
  run?: CheckpointGitRunner;
}

/** Revert one hunk of `base → now` in the file on disk. Refuses a stale or unknown hunk. */
export async function rejectHunkOnDisk(input: RejectHunkInput): Promise<void> {
  const run = input.run ?? defaultCheckpointGit;
  const patch = await patchBetween(input.gitRoot, input.base, input.now, input.path, input.oldPath, run);
  if (patch.binary) throw new CheckpointError('VERSE_INVALID', 'A binary file can only be rejected as a whole.');
  if (patch.truncated) throw new CheckpointError('VERSE_INVALID', 'This file’s diff is too large to reject hunk by hunk; reject the whole file.');
  const hunk = parsePatchHunks(patch.raw).find((h) => h.hash === input.hash);
  if (!hunk) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'That change is no longer in the file. Refresh the diff and try again.');
  const bytes = await readRepoFile(input.gitRoot, input.path, VERSE_GIT_PATCH_MAX_BYTES * 16);
  if (bytes === null) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'That file changed or is no longer readable. Refresh the diff and try again.');
  const next = revertHunk(bytes.toString('latin1'), hunk);
  if (next === null) throw new CheckpointError('VERSE_CHECKPOINT_STALE', 'That file changed since the diff was read. Refresh the diff and try again.');
  await writeRepoFile(input.gitRoot, input.path, Buffer.from(next, 'latin1'));
}

export { EMPTY_TREE_SHA };
