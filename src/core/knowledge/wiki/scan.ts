/**
 * wiki/scan.ts — list and read a repo for the wiki, READ-ONLY and ASYNC.
 *
 * Listing prefers `git ls-tree -r -l HEAD`: it is exactly the committed tree
 * (no node_modules, no ignored build output, no untracked scratch files) and it
 * hands us each file's BLOB ID for free — the wiki's staleness hashes are built
 * from blob ids, so "did this page's inputs change since commit X" costs one
 * git call and zero file reads. Outside git, a bounded async walk stands in and
 * `size:mtime` plays the blob id.
 *
 * Same exclusions as the knowledge index (knowledge/index.ts): secret-named
 * files (.env*, keys, credentials.json, .npmrc …), lockfiles, binaries, symlinks
 * and submodules are never listed, so they are never read, hashed or cited.
 * Everything here is async: this module runs inside the Verse sidecar, where a
 * synchronous read into ~/Desktop can freeze every route behind a macOS
 * privacy prompt (scripts/check-verse-sync-io.mjs).
 */

import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Hard cap on files listed per repo. */
export const MAX_LISTED_FILES = 6000;
/** Max bytes read from one file. */
export const MAX_READ_BYTES = 256 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const WALK_MAX_DEPTH = 12;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'coverage', '__pycache__',
  '.cache', 'vendor', 'out', '.output', '.vercel', '.serverless', 'target', '.yarn',
  '.venv', 'venv', '.idea', '.vscode', '.parcel-cache',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.icns', '.bmp', '.tiff',
  '.mp4', '.mp3', '.wav', '.ogg', '.mov', '.avi', '.webm', '.m4a',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.7z', '.rar', '.xz',
  '.wasm', '.exe', '.dylib', '.so', '.dll', '.a', '.o', '.class', '.jar', '.pyc',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.lock', '.map', '.snap',
]);

/** Secret-shaped filenames (same shapes knowledge/index.ts refuses). */
const SECRET_FILENAME_RE = /^\.env(\.|$)|\.pem$|\.key$|\.p12$|\.pfx$|\.crt$|\.jks$|\.keystore$|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.tfvars$|\.tfstate$/i;
const SECRET_FILES = new Set([
  '.envrc', 'credentials.json', 'secrets.json', 'secret.json', '.npmrc', '.netrc', '.pypirc',
  'service-account.json', 'serviceaccount.json', 'auth.json', '.git-credentials',
]);
const LOCKFILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'Gemfile.lock',
  'poetry.lock', 'go.sum', 'composer.lock', 'mix.lock', 'uv.lock',
]);

export interface ScannedFile {
  /** Repo-relative, forward slashes. */
  rel: string;
  size: number;
  /** Git blob id, or `size:mtimeMs` outside git. */
  blob: string;
}

export interface RepoScan {
  repo: string;
  name: string;
  /** HEAD commit, or null outside git / on an unborn branch. */
  head: string | null;
  git: boolean;
  files: ScannedFile[];
  /** True when MAX_LISTED_FILES cut the listing short. */
  truncated: boolean;
}

/** True when a repo-relative path may be listed/read at all. */
export function isWikiReadable(rel: string, ignorePaths: readonly string[] = []): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || norm.split('/').includes('..')) return false;
  const parts = norm.split('/');
  const base = parts[parts.length - 1]!;
  for (const dir of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(dir)) return false;
  }
  if (SECRET_FILENAME_RE.test(base) || SECRET_FILES.has(base) || LOCKFILES.has(base)) return false;
  const ext = path.extname(base).toLowerCase();
  if (BINARY_EXTS.has(ext)) return false;
  if (base.endsWith('.min.js') || base.endsWith('.min.css')) return false;
  for (const prefix of ignorePaths) {
    if (norm === prefix || norm.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) return false;
  }
  return true;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string' && !/^ashlr_/i.test(k)) env[k] = v;
  }
  // Reads never take the index lock an agent may need; nothing may prompt.
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
}

/** Run git read-only in `repo`. Resolves stdout, or null on any failure. */
export function gitRead(repo: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', repo, ...args],
        { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

/** Current HEAD commit (40-hex) or null. */
export async function readHead(repo: string): Promise<string | null> {
  const out = await gitRead(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const sha = out?.trim() ?? '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/**
 * Parse `git ls-tree -r -l -z HEAD`: `<mode> SP <type> SP <oid> SP+ <size>\t<path>\0`.
 * Symlinks (120000) and submodules (type commit) are dropped.
 */
export function parseLsTree(raw: string, ignorePaths: readonly string[] = []): { files: ScannedFile[]; truncated: boolean } {
  const files: ScannedFile[] = [];
  let truncated = false;
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).trim().split(/\s+/);
    const rel = rec.slice(tab + 1);
    if (meta.length < 4) continue;
    const [mode, type, oid, sizeRaw] = meta as [string, string, string, string];
    if (type !== 'blob' || mode === '120000') continue;
    if (!isWikiReadable(rel, ignorePaths)) continue;
    if (files.length >= MAX_LISTED_FILES) {
      truncated = true;
      break;
    }
    const size = Number(sizeRaw);
    files.push({ rel, size: Number.isFinite(size) ? size : 0, blob: oid });
  }
  return { files, truncated };
}

async function walkFiles(repo: string, ignorePaths: readonly string[]): Promise<{ files: ScannedFile[]; truncated: boolean }> {
  const files: ScannedFile[] = [];
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: repo, depth: 0 }];
  while (queue.length > 0 && !truncated) {
    const { dir, depth } = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(repo, abs).split(path.sep).join('/');
      if (ent.isDirectory()) {
        if (depth < WALK_MAX_DEPTH && !SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile() || !isWikiReadable(rel, ignorePaths)) continue;
      if (files.length >= MAX_LISTED_FILES) {
        truncated = true;
        break;
      }
      try {
        const st = await lstat(abs);
        files.push({ rel, size: st.size, blob: `${st.size}:${Math.floor(st.mtimeMs)}` });
      } catch {
        // vanished mid-walk
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files, truncated };
}

/** List the repo. Never throws; an unreadable repo is an empty scan. */
export async function scanRepo(repo: string, ignorePaths: readonly string[] = []): Promise<RepoScan> {
  const abs = path.resolve(repo);
  const name = path.basename(abs);
  const head = await readHead(abs);
  if (head) {
    const raw = await gitRead(abs, ['ls-tree', '-r', '-l', '-z', 'HEAD']);
    if (raw !== null) {
      const { files, truncated } = parseLsTree(raw, ignorePaths);
      return { repo: abs, name, head, git: true, files, truncated };
    }
  }
  const { files, truncated } = await walkFiles(abs, ignorePaths);
  return { repo: abs, name, head: null, git: false, files, truncated };
}

/**
 * `owner/name` when the repo's `origin` is on github.com (https or ssh), else
 * null. Used to build "open on GitHub" links for citations; never a network call.
 */
export function parseGithubRemote(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function githubNameWithOwner(repo: string): Promise<string | null> {
  const out = await gitRead(repo, ['remote', 'get-url', 'origin']);
  return out ? parseGithubRemote(out) : null;
}

/** Current blob ids only (for cheap staleness checks). Null when unavailable. */
export async function currentBlobs(repo: string): Promise<{ head: string | null; blobs: Map<string, string> } | null> {
  const scan = await scanRepo(repo);
  if (scan.files.length === 0 && !scan.git) return null;
  return { head: scan.head, blobs: new Map(scan.files.map((f) => [f.rel, f.blob])) };
}

/**
 * Read one repo file as UTF-8 text. Refuses anything that is not a regular file
 * inside the repo (no symlinks — a link to ~/.ssh must never be read), anything
 * over MAX_READ_BYTES, and anything that looks binary. Null on refusal/failure.
 */
export async function readRepoText(repo: string, rel: string, maxBytes = MAX_READ_BYTES): Promise<string | null> {
  if (!isWikiReadable(rel)) return null;
  const abs = path.resolve(repo, rel);
  const root = path.resolve(repo);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const st = await lstat(abs);
    if (!st.isFile() || st.size > maxBytes) return null;
    const buf = await readFile(abs);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** Language label by extension (for the overview's language mix). */
export function languageOf(rel: string): string | null {
  const ext = path.extname(rel).toLowerCase();
  switch (ext) {
    case '.ts': case '.tsx': case '.mts': case '.cts': return 'TypeScript';
    case '.js': case '.jsx': case '.mjs': case '.cjs': return 'JavaScript';
    case '.py': return 'Python';
    case '.go': return 'Go';
    case '.rs': return 'Rust';
    case '.rb': return 'Ruby';
    case '.java': return 'Java';
    case '.kt': case '.kts': return 'Kotlin';
    case '.swift': return 'Swift';
    case '.c': case '.h': return 'C';
    case '.cc': case '.cpp': case '.hpp': return 'C++';
    case '.cs': return 'C#';
    case '.php': return 'PHP';
    case '.sql': return 'SQL';
    case '.sh': case '.bash': case '.zsh': return 'Shell';
    case '.css': case '.scss': return 'CSS';
    case '.html': return 'HTML';
    case '.md': case '.mdx': return 'Markdown';
    default: return null;
  }
}

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb',
  '.java', '.kt', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.sh',
]);

export function isSourceFile(rel: string): boolean {
  return SOURCE_EXTS.has(path.extname(rel).toLowerCase());
}

export function isTestFile(rel: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || /_test\.go$/.test(rel) || /(^|\/)test_[^/]+\.py$/.test(rel);
}
