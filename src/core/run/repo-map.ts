/**
 * repo-map.ts — M154: lightweight, dependency-free repository map.
 *
 * Extracts top-level symbols (functions / classes / exports) from first-party
 * source files via language-agnostic regex, ranks files by how frequently their
 * exports are imported across the repo, and renders a TOKEN-BUDGETED map
 * (signatures only — no bodies).
 *
 * DESIGN INVARIANTS:
 *  - ZERO runtime dependencies: pure Node built-ins only (fs, path, os, crypto).
 *  - Never throws: every public entry point returns a safe default on any error.
 *  - Flag-gated: only reached when cfg.foundry?.repoMap === true (default OFF).
 *  - Reuses the IGNORE_DIRS / isIgnoredPath predicate from M136 scanners.
 *  - Cache: keyed on repository, git HEAD sha, and scan-policy version under
 *    ~/.ashlr/repo-map; stale entries are silently discarded and rebuilt.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs';
import { join, relative, extname, basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Re-use M136 ignore rules (import-side-effect-free)
// ---------------------------------------------------------------------------

/** Mirror of IGNORE_DIRS from scanners.ts — kept local to avoid a circular dep. */
const IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.next', 'target',
  '.vscode', '.git', '.claude', '.codex', '.agents', '.worktrees', '.ashlr',
  'vendor', '.turbo', 'bench', 'benchmark', 'benchmarks',
  'refs', 'third_party', 'third-party', 'vendors', 'examples', 'fixtures',
  '__pycache__', '.venv', 'site-packages', 'migrations', 'pandas',
]);

const IGNORE_FILE_RE =
  /(?:^|[/])(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.min\.[cm]?[jt]sx?$|\.min\.css$|\.generated\.[^.]+$|\.map$/i;

const IGNORE_VENDORED_PATH_RE = /(?:^|\/)(?:[a-z0-9_-]+-lib|site-packages)\//i;

function isIgnoredPath(filePath: string): boolean {
  const normalised = filePath.replace(/\\/g, '/');
  const segments = normalised.split('/');
  for (const seg of segments) {
    if (seg && IGNORE_DIRS.has(seg)) return true;
  }
  if (IGNORE_FILE_RE.test(normalised)) return true;
  if (IGNORE_VENDORED_PATH_RE.test(normalised)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Supported source extensions
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs']);

// ---------------------------------------------------------------------------
// Per-language symbol extractors (regex-based, no AST)
// ---------------------------------------------------------------------------

/** A single extracted symbol: its name + the one-liner signature. */
export interface SymbolEntry {
  name: string;
  sig: string;
}

/**
 * Extract top-level symbols from `src` for the given file extension.
 * Returns at most `maxSymbols` entries. Never throws.
 */
function extractSymbols(src: string, ext: string, maxSymbols = 40): SymbolEntry[] {
  const results: SymbolEntry[] = [];

  try {
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
      // exported functions: export [async] function name(...) / export const name = ...
      const fnRe = /^export\s+(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]{0,120})\)/gm;
      let m: RegExpExecArray | null;
      while ((m = fnRe.exec(src)) !== null && results.length < maxSymbols) {
        const params = m[3].trim().replace(/\s+/g, ' ');
        results.push({ name: m[1], sig: `export function ${m[1]}(${params})` });
      }
      // exported classes
      const clsRe = /^export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+[^{]+)?/gm;
      while ((m = clsRe.exec(src)) !== null && results.length < maxSymbols) {
        const ext2 = m[2] ? ` extends ${m[2]}` : '';
        results.push({ name: m[1], sig: `export class ${m[1]}${ext2}` });
      }
      // export const/let/var (arrow functions + plain values)
      const varRe = /^export\s+(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]{0,60})?\s*=/gm;
      while ((m = varRe.exec(src)) !== null && results.length < maxSymbols) {
        results.push({ name: m[1], sig: `export const ${m[1]}` });
      }
      // export type / interface
      const typeRe = /^export\s+(?:type|interface)\s+(\w+)/gm;
      while ((m = typeRe.exec(src)) !== null && results.length < maxSymbols) {
        results.push({ name: m[1], sig: `export type ${m[1]}` });
      }
    } else if (ext === '.py') {
      // top-level def / class
      const pyRe = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]{0,100})\)|^class\s+(\w+)(?:\s*\([^)]*\))?/gm;
      let m: RegExpExecArray | null;
      while ((m = pyRe.exec(src)) !== null && results.length < maxSymbols) {
        if (m[1]) {
          results.push({ name: m[1], sig: `def ${m[1]}(${m[2].trim()})` });
        } else if (m[3]) {
          results.push({ name: m[3], sig: `class ${m[3]}` });
        }
      }
    } else if (ext === '.go') {
      // func / type
      const goRe = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\([^)]{0,100}\)|^type\s+(\w+)\s+(?:struct|interface)/gm;
      let m: RegExpExecArray | null;
      while ((m = goRe.exec(src)) !== null && results.length < maxSymbols) {
        const name = m[1] || m[2];
        results.push({ name, sig: m[0].slice(0, 80).trim() });
      }
    } else if (ext === '.rs') {
      // pub fn / pub struct / pub enum
      const rsRe = /^pub(?:\s+\w+)?\s+(?:fn|struct|enum|trait)\s+(\w+)/gm;
      let m: RegExpExecArray | null;
      while ((m = rsRe.exec(src)) !== null && results.length < maxSymbols) {
        results.push({ name: m[1], sig: m[0].slice(0, 80).trim() });
      }
    }
  } catch {
    // regex extraction is best-effort
  }

  return results;
}

/**
 * Extract all import/require paths from `src` (TS/JS/Go/Rust/Python).
 * Used to build the reference-frequency ranking.
 */
function extractImports(src: string, ext: string): string[] {
  const refs: string[] = [];
  try {
    if (SOURCE_EXTS.has(ext)) {
      // ES import / require
      const importRe = /(?:import\s+[^'"]*from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(src)) !== null) refs.push(m[1]);
    }
    if (ext === '.py') {
      // from X import / import X
      const pyRe = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
      let m: RegExpExecArray | null;
      while ((m = pyRe.exec(src)) !== null) refs.push((m[1] || m[2]).replace(/\./g, '/'));
    }
    if (ext === '.go') {
      const goRe = /"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = goRe.exec(src)) !== null) refs.push(m[1]);
    }
    if (ext === '.rs') {
      const rsRe = /use\s+([\w:]+)/g;
      let m: RegExpExecArray | null;
      while ((m = rsRe.exec(src)) !== null) refs.push(m[1].replace(/::/g, '/'));
    }
  } catch {
    // best-effort
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-file entry in the repo map. */
export interface RepoMapFile {
  /** Repo-relative path (forward slashes). */
  path: string;
  /** Extracted top-level symbols. */
  symbols: SymbolEntry[];
  /**
   * How many other files import this file (reference frequency).
   * Higher = more central; used for ranking.
   */
  refCount: number;
}

/** The full repo map for one git sha. */
export interface RepoMap {
  /** Git HEAD sha this map was built from (or '' if git unavailable). */
  sha: string;
  /** All scanned first-party files, sorted by refCount descending. */
  files: RepoMapFile[];
}

/** Options for buildRepoMap. */
export interface RepoMapOptions {
  /**
   * Max tokens to budget for the rendered map string.
   * Approximate: 1 token ≈ 4 chars. Default 8000 tokens → 32000 chars.
   */
  tokenBudget?: number;
  /** Max files to include (default 200). */
  maxFiles?: number;
  /** Max symbols per file (default 30). */
  maxSymbolsPerFile?: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Bump whenever scanning policy changes so old HEAD-keyed maps are not reused. */
const CACHE_POLICY_VERSION = 2;

interface RepoMapCache {
  policyVersion: number;
  map: RepoMap;
}

function cacheDir(): string {
  return join(homedir(), '.ashlr', 'repo-map');
}

function cacheKey(repoDir: string, sha: string): string {
  const repoHash = createHash('sha1').update(repoDir).digest('hex').slice(0, 8);
  return join(cacheDir(), `${repoHash}-${sha}-p${CACHE_POLICY_VERSION}.json`);
}

function loadCache(repoDir: string, sha: string): RepoMap | null {
  if (!sha) return null;
  try {
    const p = cacheKey(repoDir, sha);
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as RepoMapCache;
    if (parsed.policyVersion === CACHE_POLICY_VERSION && parsed.map?.sha === sha) {
      return parsed.map;
    }
  } catch {
    // cache miss or corrupt — rebuild
  }
  return null;
}

function saveCache(repoDir: string, map: RepoMap): void {
  if (!map.sha) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const p = cacheKey(repoDir, map.sha);
    const cache: RepoMapCache = { policyVersion: CACHE_POLICY_VERSION, map };
    writeFileSync(p, JSON.stringify(cache), 'utf8');
  } catch {
    // cache save is best-effort
  }
}

// ---------------------------------------------------------------------------
// Git HEAD sha
// ---------------------------------------------------------------------------

function getHeadSha(repoDir: string): string {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 5_000,
    }).trim();
  } catch {
    return '';
  }
}

function isWorktreeClean(repoDir: string): boolean {
  try {
    return execFileSync(
      'git',
      ['-C', repoDir, 'status', '--porcelain=v1', '--untracked-files=all'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 },
    ).trim().length === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// File walker
// ---------------------------------------------------------------------------

function walkSources(dir: string, repoDir: string, out: string[], depth = 0): void {
  if (depth > 12) return;
  let entries: string[];
  try {
    entries = readdirSync(dir) as string[];
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = relative(repoDir, abs).replace(/\\/g, '/');
    if (isIgnoredPath(rel)) continue;
    let isDir = false;
    let isFile = false;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      continue;
    }
    if (isDir) {
      walkSources(abs, repoDir, out, depth + 1);
    } else if (isFile) {
      const ext = extname(name).toLowerCase();
      if (SOURCE_EXTS.has(ext)) out.push(abs);
    }
  }
}

// ---------------------------------------------------------------------------
// Core builder
// ---------------------------------------------------------------------------

/**
 * Build a repo map for `repoDir`. Results are cached per git HEAD sha.
 * Never throws — returns an empty map on any failure.
 */
export function buildRepoMap(repoDir: string, opts?: RepoMapOptions): RepoMap {
  const maxFiles = opts?.maxFiles ?? 200;
  const maxSymsPerFile = opts?.maxSymbolsPerFile ?? 30;

  try {
    const sha = getHeadSha(repoDir);
    const cacheable = sha.length > 0 && isWorktreeClean(repoDir);

    // Dirty trees are always rebuilt so uncommitted source cannot survive in a
    // cache keyed only by HEAD. Clean trees remain stable and cacheable.
    if (cacheable) {
      const cached = loadCache(repoDir, sha);
      if (cached) return cached;
    }

    // Walk first-party sources
    const absFiles: string[] = [];
    walkSources(repoDir, repoDir, absFiles);

    // Read files + extract symbols + imports in one pass
    const symMap = new Map<string, SymbolEntry[]>(); // relPath → symbols
    const importSets = new Map<string, string[]>();  // relPath → raw import specifiers
    const nameMap = new Map<string, string>();       // exported name → relPath (for ref counting)

    for (const abs of absFiles) {
      const rel = relative(repoDir, abs).replace(/\\/g, '/');
      const ext = extname(abs).toLowerCase();
      let src = '';
      try { src = readFileSync(abs, 'utf8'); } catch { continue; }
      const syms = extractSymbols(src, ext, maxSymsPerFile);
      symMap.set(rel, syms);
      importSets.set(rel, extractImports(src, ext));
      for (const s of syms) nameMap.set(s.name, rel);
    }

    // Build reference-frequency counts
    // For each file's imports, try to resolve the specifier to a known rel path
    const refCounts = new Map<string, number>();

    /**
     * Strip a known source extension from a specifier so we can try adding
     * alternative extensions (e.g. './types.js' → './types').
     */
    function stripSrcExt(s: string): string {
      for (const ext of SOURCE_EXTS) {
        if (s.endsWith(ext)) return s.slice(0, -ext.length);
      }
      return s;
    }

    for (const [importingRel, imports] of importSets) {
      const importingDir = dirname(join(repoDir, importingRel));
      for (const spec of imports) {
        let matched = false;

        // Only attempt path resolution for relative imports (start with . or /)
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const base = stripSrcExt(spec); // remove trailing .js/.ts/.mjs etc.
          const absBase = resolve(importingDir, base);
          const relBase = relative(repoDir, absBase).replace(/\\/g, '/');

          // Try adding each source extension
          for (const ext of SOURCE_EXTS) {
            const candidate = relBase + ext;
            if (symMap.has(candidate)) {
              refCounts.set(candidate, (refCounts.get(candidate) ?? 0) + 1);
              matched = true;
              break;
            }
          }

          // Try the path as-is (already has extension or extensionless match)
          if (!matched && symMap.has(relBase)) {
            refCounts.set(relBase, (refCounts.get(relBase) ?? 0) + 1);
            matched = true;
          }
        }

        // Fallback: match by basename (handles index files and aliases)
        if (!matched) {
          const base = basename(stripSrcExt(spec));
          if (base && nameMap.has(base)) {
            const target = nameMap.get(base)!;
            refCounts.set(target, (refCounts.get(target) ?? 0) + 1);
          }
        }
      }
    }

    // Assemble file entries
    const entries: RepoMapFile[] = [];
    for (const [path, symbols] of symMap) {
      entries.push({ path, symbols, refCount: refCounts.get(path) ?? 0 });
    }

    // Sort by refCount desc, then alphabetically for stability
    entries.sort((a, b) =>
      b.refCount !== a.refCount ? b.refCount - a.refCount : a.path.localeCompare(b.path)
    );

    // Cap to maxFiles
    const capped = entries.slice(0, maxFiles);

    const map: RepoMap = { sha, files: capped };
    if (cacheable) saveCache(repoDir, map);
    return map;
  } catch {
    return { sha: '', files: [] };
  }
}

// ---------------------------------------------------------------------------
// Renderer — token-budgeted string for engine context
// ---------------------------------------------------------------------------

/**
 * Render `map` as a compact string that fits within `tokenBudget` tokens
 * (approx 4 chars/token). Higher-ranked files come first; lower-ranked files
 * are dropped when the budget is exhausted.
 *
 * Format per file:
 *   # path/to/file.ts  (refs: N)
 *   export function foo(a: string, b: number)
 *   export class Bar
 *   ...
 */
export function renderRepoMap(map: RepoMap, opts?: RepoMapOptions): string {
  const budget = (opts?.tokenBudget ?? 8_000) * 4; // chars
  const lines: string[] = ['<!-- repo-map (M154) -->'];
  let chars = lines[0].length + 1;

  for (const file of map.files) {
    const header = `# ${file.path}  (refs: ${file.refCount})`;
    const symLines = file.symbols.map((s) => `  ${s.sig}`);
    const block = [header, ...symLines, ''].join('\n');
    if (chars + block.length > budget) break;
    lines.push(block);
    chars += block.length;
  }

  return lines.join('\n');
}
