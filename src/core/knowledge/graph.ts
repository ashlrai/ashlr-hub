/**
 * graph.ts — Knowledge Graph + Impact analysis for enrolled repos.
 *
 * INVARIANTS (CONTRACT-M25):
 *  1. READ-ONLY: never modifies any enrolled repo; analysis only.
 *  2. ENROLLMENT-SCOPED: default repos = listEnrolled() (DEFAULT EMPTY => empty graph).
 *  3. BOUNDED: caps file walk depth, file count, and skips node_modules/.git/dist/binaries.
 *  4. NEVER THROWS: all functions catch internally; callers get empty structures on error.
 *  5. LOCAL-ONLY: no network calls; pure filesystem analysis.
 *  6. NO SECRETS: skips .env/key files; does not emit secret-shaped content.
 *
 * buildGraph(repos?): construct KnowledgeGraph from persisted index + package.json manifests
 *   + import/require statements. Nodes: repos, key modules, shared deps.
 *   Edges: imports/depends/shared-dep. CrossRepo: same dep across repos, duplicated modules.
 *
 * impact(target, repos?): find all references to a file path or symbol across enrolled repos
 *   via the persisted index + grep-style scan. Returns ImpactResult with references + dependents.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listEnrolled, isEnrolled } from '../sandbox/policy.js';
import type { KnowledgeGraph, ImpactResult } from '../types.js';

// ---------------------------------------------------------------------------
// Constants — bounds
// ---------------------------------------------------------------------------

/** Max files to scan per repo during import analysis. */
const MAX_FILES_PER_REPO = 2000;

/** Max bytes to read from a single file for import extraction. */
const MAX_FILE_BYTES = 256 * 1024; // 256 KB

/** Max recursion depth during directory walk. */
const MAX_WALK_DEPTH = 10;

/** Max references to collect for an impact query (keeps output bounded). */
const MAX_REFERENCES = 500;

/** Directories to skip unconditionally. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '.turbo', 'coverage',
  '__pycache__', 'build', 'out', '.cache', '.parcel-cache', 'vendor',
  '.venv', 'venv', 'target', '.idea', '.vscode',
]);

/** File extensions considered source code (import-bearing). */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
]);

/** Binary / compiled extensions to skip entirely. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.wav', '.ogg',
  '.zip', '.tar', '.gz', '.bz2', '.rar',
  '.bin', '.exe', '.dll', '.so', '.dylib',
  '.lock', '.map',
]);

/** Secret-adjacent filenames to skip when reading. */
const SECRET_FILES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
  '.env.staging', '.envrc',
  'credentials.json', 'secrets.json', 'secret.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.npmrc', '.netrc',
  'service-account.json', 'serviceaccount.json',
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Derive a stable short ID from an absolute path (basename). */
function repoId(absPath: string): string {
  return `repo:${path.basename(absPath)}`;
}

/** Returns true if the file should be skipped entirely (binary, secret, skip-dir). */
function shouldSkipFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (SECRET_FILES.has(base)) return true;
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  return false;
}

/** Returns true if the directory entry should not be descended into. */
function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

// ---------------------------------------------------------------------------
// Filesystem helpers — always safe, never throw
// ---------------------------------------------------------------------------

function safeReadFile(filePath: string): string | null {
  try {
    if (shouldSkipFile(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Directory walker — bounded, read-only, never throws
// ---------------------------------------------------------------------------

/**
 * Walk a repo directory and collect all source file paths up to MAX_FILES_PER_REPO.
 * Skips SKIP_DIRS, hidden dirs, binaries, and secret files.
 */
function walkSourceFiles(repoPath: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_WALK_DEPTH) return;
    if (results.length >= MAX_FILES_PER_REPO) return;

    for (const dirent of safeReaddir(dir)) {
      if (results.length >= MAX_FILES_PER_REPO) return;

      // Skip symlinks (files + dirs) so the walk cannot escape the repo boundary.
      if (dirent.isSymbolicLink()) continue;

      if (dirent.isDirectory()) {
        if (shouldSkipDir(dirent.name)) continue;
        walk(path.join(dir, dirent.name), depth + 1);
      } else if (dirent.isFile()) {
        const filePath = path.join(dir, dirent.name);
        if (shouldSkipFile(filePath)) continue;
        const ext = path.extname(dirent.name).toLowerCase();
        if (SOURCE_EXTS.has(ext)) {
          results.push(filePath);
        }
      }
    }
  }

  try {
    walk(repoPath, 0);
  } catch {
    // bounded walk never propagates errors
  }

  return results;
}

// ---------------------------------------------------------------------------
// Package.json dependency extraction
// ---------------------------------------------------------------------------

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readPackageJson(repoPath: string): PackageJson | null {
  try {
    const pkgPath = path.join(repoPath, 'package.json');
    const raw = safeReadFile(pkgPath);
    if (!raw) return null;
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

/** Collect all dependency names from a package.json. */
function collectDeps(pkg: PackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
}

// ---------------------------------------------------------------------------
// Import/require extraction — regex-based, fast, bounded
// ---------------------------------------------------------------------------

/**
 * Extract import/require targets from a source file's text.
 * Returns both external package names and relative path imports.
 * Never throws.
 */
function extractImports(source: string): string[] {
  const imports: string[] = [];

  try {
    // ES module: import ... from 'target'  /  import 'target'
    const esImportRe = /\bimport\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = esImportRe.exec(source)) !== null) {
      if (m[1]) imports.push(m[1]);
    }

    // CommonJS: require('target')
    const cjsRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = cjsRe.exec(source)) !== null) {
      if (m[1]) imports.push(m[1]);
    }

    // Dynamic import: import('target')
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynRe.exec(source)) !== null) {
      if (m[1]) imports.push(m[1]);
    }

    // Python: from target import  /  import target
    const pyFromRe = /^from\s+([\w.]+)\s+import/gm;
    while ((m = pyFromRe.exec(source)) !== null) {
      if (m[1]) imports.push(m[1]);
    }
    const pyImportRe = /^import\s+([\w.,\s]+)/gm;
    while ((m = pyImportRe.exec(source)) !== null) {
      if (m[1]) {
        for (const part of m[1].split(',')) {
          const trimmed = part.trim().split(' ')[0];
          if (trimmed) imports.push(trimmed);
        }
      }
    }
  } catch {
    // regex errors are non-fatal
  }

  return imports;
}

/**
 * Classify an import string:
 * - 'relative': starts with ./ or ../
 * - 'package': external npm/pip package name
 */
function importKind(imp: string): 'relative' | 'package' {
  return imp.startsWith('.') ? 'relative' : 'package';
}

/** Extract just the package name (before any slash for scoped/sub-path). */
function packageName(imp: string): string {
  if (imp.startsWith('@')) {
    // scoped: @scope/name/sub => @scope/name
    const parts = imp.split('/');
    return parts.slice(0, 2).join('/');
  }
  return imp.split('/')[0] ?? imp;
}

// ---------------------------------------------------------------------------
// Secret-scrubbing helper (for display; not stored in graph)
// ---------------------------------------------------------------------------

const SECRET_PATTERN = /(?:key|token|secret|password|passwd|pwd|api_?key|auth)[^\s]*\s*[:=]\s*\S+/gi;

function scrubSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, '[REDACTED]');
}

// ---------------------------------------------------------------------------
// Per-repo analysis result
// ---------------------------------------------------------------------------

interface RepoAnalysis {
  repoPath: string;
  repoLabel: string;
  packageName: string | null;
  deps: string[];
  /** module name (relative to repo) -> set of imported package names */
  moduleImports: Map<string, Set<string>>;
  /** source files found */
  sourceFiles: string[];
}

function analyseRepo(repoPath: string): RepoAnalysis {
  const label = path.basename(repoPath);
  const pkg = readPackageJson(repoPath);
  const deps = pkg ? collectDeps(pkg) : [];
  const moduleImports = new Map<string, Set<string>>();
  const sourceFiles = walkSourceFiles(repoPath);

  for (const filePath of sourceFiles) {
    const src = safeReadFile(filePath);
    if (!src) continue;

    const relPath = path.relative(repoPath, filePath);
    const pkgImports = new Set<string>();

    for (const imp of extractImports(src)) {
      if (importKind(imp) === 'package') {
        pkgImports.add(packageName(imp));
      }
    }

    if (pkgImports.size > 0) {
      moduleImports.set(relPath, pkgImports);
    }
  }

  return {
    repoPath,
    repoLabel: label,
    packageName: pkg?.name ?? null,
    deps,
    moduleImports,
    sourceFiles,
  };
}

// ---------------------------------------------------------------------------
// buildGraph — public API
// ---------------------------------------------------------------------------

/**
 * Build a KnowledgeGraph from enrolled repos (or the provided list).
 *
 * Nodes:
 *   - kind:'repo'    — each enrolled repo
 *   - kind:'module'  — key source files within a repo (those that import packages)
 *   - kind:'dep'     — external dependencies (package names)
 *
 * Edges:
 *   - kind:'depends'   — repo -> dep (from package.json)
 *   - kind:'imports'   — module -> dep (from import statements)
 *   - kind:'shared-dep' — dep -> dep node (already in graph; used for cross-repo detection)
 *
 * CrossRepo:
 *   - kind:'shared-dep' when a dep appears in 2+ repos
 *   - kind:'duplicate-module' when the same relative module path exists in 2+ repos
 *
 * BOUNDED, READ-ONLY, NEVER THROWS.
 */
export function buildGraph(repos?: string[]): KnowledgeGraph {
  const graph: KnowledgeGraph = { nodes: [], edges: [], crossRepo: [] };

  try {
    const targetRepos = repos ?? listEnrolled();
    if (targetRepos.length === 0) return graph;

    const nodeIds = new Set<string>();
    const edgeKeys = new Set<string>();

    function addNode(id: string, kind: string, label: string): void {
      if (!nodeIds.has(id)) {
        nodeIds.add(id);
        graph.nodes.push({ id, kind, label });
      }
    }

    function addEdge(from: string, to: string, kind: string): void {
      const key = `${from}||${to}||${kind}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        graph.edges.push({ from, to, kind });
      }
    }

    // Analyse all repos
    const analyses: RepoAnalysis[] = [];
    for (const repoPath of targetRepos) {
      try {
        // ENROLLMENT-SCOPED (CONTRACT-M25 invariant 3): only ever walk enrolled
        // repos — an explicit repos list from the CLI (--repo / positional) is
        // validated here so a non-enrolled directory is never read.
        if (!isEnrolled(repoPath)) continue;
        if (!fs.existsSync(repoPath)) continue;
        const analysis = analyseRepo(repoPath);
        analyses.push(analysis);
      } catch {
        // one bad repo must not crash the whole graph
      }
    }

    // dep name -> set of repo ids that declare it
    const depToRepos = new Map<string, Set<string>>();
    // module relPath -> set of repo ids that have it
    const moduleToRepos = new Map<string, Set<string>>();

    for (const analysis of analyses) {
      const rId = repoId(analysis.repoPath);
      addNode(rId, 'repo', analysis.repoLabel);

      // Edges: repo -> declared dep (from package.json)
      for (const dep of analysis.deps) {
        const depId = `dep:${dep}`;
        addNode(depId, 'dep', dep);
        addEdge(rId, depId, 'depends');

        if (!depToRepos.has(dep)) depToRepos.set(dep, new Set());
        depToRepos.get(dep)!.add(rId);
      }

      // Edges: module -> imported package dep
      for (const [relPath, pkgImports] of analysis.moduleImports) {
        const moduleId = `module:${analysis.repoLabel}/${relPath}`;
        addNode(moduleId, 'module', relPath);
        addEdge(rId, moduleId, 'contains');

        for (const imp of pkgImports) {
          const depId = `dep:${imp}`;
          addNode(depId, 'dep', imp);
          addEdge(moduleId, depId, 'imports');

          // Also track dep->repo for cross-repo detection
          if (!depToRepos.has(imp)) depToRepos.set(imp, new Set());
          depToRepos.get(imp)!.add(rId);
        }

        if (!moduleToRepos.has(relPath)) moduleToRepos.set(relPath, new Set());
        moduleToRepos.get(relPath)!.add(rId);
      }
    }

    // Cross-repo: shared deps (appear in 2+ repos)
    for (const [dep, repoSet] of depToRepos) {
      if (repoSet.size >= 2) {
        // Find the version strings for detail
        const repoVersions: string[] = [];
        for (const analysis of analyses) {
          if (repoSet.has(repoId(analysis.repoPath))) {
            const pkg = readPackageJson(analysis.repoPath);
            const version =
              pkg?.dependencies?.[dep] ??
              pkg?.devDependencies?.[dep] ??
              pkg?.peerDependencies?.[dep] ??
              '*';
            repoVersions.push(`${path.basename(analysis.repoPath)}@${version}`);
          }
        }
        graph.crossRepo.push({
          kind: 'shared-dep',
          detail: scrubSecrets(
            `${dep} shared across ${repoSet.size} repos: ${repoVersions.join(', ')}`,
          ),
          repos: Array.from(repoSet),
        });
      }
    }

    // Cross-repo: duplicate module paths (same relPath in 2+ repos)
    for (const [relPath, repoSet] of moduleToRepos) {
      if (repoSet.size >= 2) {
        graph.crossRepo.push({
          kind: 'duplicate-module',
          detail: `Module path "${relPath}" exists in ${repoSet.size} repos`,
          repos: Array.from(repoSet),
        });
      }
    }
  } catch {
    // top-level safety net: always return a valid (possibly partial) graph
  }

  return graph;
}

// ---------------------------------------------------------------------------
// impact — public API
// ---------------------------------------------------------------------------

/**
 * Find all references to a file path or symbol across enrolled repos.
 *
 * For a file target: searches for import/require of that file (by basename and
 * relative paths) and any text occurrence of the path.
 * For a symbol target (no path separators, no extension): searches for usage
 * occurrences in source files via text scan.
 *
 * Returns references (repo/file:line) and a list of dependent module names.
 * BOUNDED (MAX_REFERENCES cap). READ-ONLY. NEVER THROWS.
 */
export function impact(target: string, repos?: string[]): ImpactResult {
  const result: ImpactResult = { target, references: [], dependents: [] };

  try {
    if (!target || target.trim().length === 0) return result;

    const targetRepos = repos ?? listEnrolled();
    if (targetRepos.length === 0) return result;

    const cleanTarget = target.trim();
    // A target is a FILE PATH only when it has a path separator OR ends with a
    // real file extension (.ts/.tsx/.js/.py/…). A bare dotted symbol like
    // `React.useState` or `obj.method` has no path separator and no trailing
    // file extension, so it falls through to word-boundary SYMBOL matching.
    const FILE_EXT_RE = /\.[a-z0-9]{1,5}$/i;
    const isFilePath = cleanTarget.includes('/') || cleanTarget.includes('\\') ||
      FILE_EXT_RE.test(cleanTarget);
    const targetBasename = path.basename(cleanTarget);
    // For searching: strip extension for module-name matching
    const targetNoExt = targetBasename.replace(/\.[^.]+$/, '');

    const dependentSet = new Set<string>();

    for (const repoPath of targetRepos) {
      try {
        // ENROLLMENT-SCOPED (CONTRACT-M25 invariant 3): never walk a directory
        // that is not enrolled, even if passed explicitly via --repo.
        if (!isEnrolled(repoPath)) continue;
        if (!fs.existsSync(repoPath)) continue;

        const sourceFiles = walkSourceFiles(repoPath);

        for (const filePath of sourceFiles) {
          if (result.references.length >= MAX_REFERENCES) break;

          // Skip the target file itself if it's a file path
          if (isFilePath) {
            const absTarget = path.isAbsolute(cleanTarget)
              ? cleanTarget
              : path.join(repoPath, cleanTarget);
            if (filePath === absTarget) continue;
          }

          const src = safeReadFile(filePath);
          if (!src) continue;

          const lines = src.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (result.references.length >= MAX_REFERENCES) break;

            const line = lines[i];
            if (!line) continue;

            let matched = false;

            if (isFilePath) {
              // File path target: look for imports that reference this file
              // Match by basename (without ext) in import strings
              if (
                line.includes(targetBasename) ||
                (targetNoExt && line.includes(targetNoExt) &&
                  (line.includes('import') || line.includes('require') || line.includes('from')))
              ) {
                matched = true;
              }
            } else {
              // Symbol target: look for usage of the symbol name in source
              // Use word-boundary-style matching to avoid partial matches
              const symbolRe = new RegExp(`\\b${escapeRegex(cleanTarget)}\\b`);
              if (symbolRe.test(line)) {
                matched = true;
              }
            }

            if (matched) {
              const relFile = path.relative(repoPath, filePath);
              const repo = path.basename(repoPath);
              result.references.push({
                repo,
                file: relFile,
                line: i + 1,
              });

              // Track this file as a dependent module
              const modName = relFile.replace(/\.[^.]+$/, '');
              dependentSet.add(`${repo}/${modName}`);
            }
          }
        }
      } catch {
        // one bad repo must not crash the whole impact
      }
    }

    result.dependents = Array.from(dependentSet);
  } catch {
    // top-level safety net
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/** Escape a string for use in a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
