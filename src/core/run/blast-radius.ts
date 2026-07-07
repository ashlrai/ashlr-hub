/**
 * blast-radius.ts — M188: cross-repo blast-radius simulator.
 *
 * Turns the ecosystem map + a real cross-repo dependency graph into an
 * executable safety engine. Given a proposed change to one repo, it estimates
 * the change's impact across the ~13-repo dev-tools ecosystem: which downstream
 * consumers could be affected, and how risky shipping it is.
 *
 * The fleet uses this to refuse ecosystem-level regressions that single-repo
 * verification can't catch (a green test suite in repo A says nothing about
 * repos B/C that depend on A's public surface).
 *
 * APPROACH — dependency graph + symbol mapping:
 *   1. Build a cross-repo dependency view by scanning every
 *      `<devToolsRoot>/* /package.json`, mapping each repo directory to its
 *      declared package name, and parsing its dependency blocks. A directed
 *      edge `consumer -> producer` is recorded when a consumer's dependency
 *      value references the producer by:
 *        - package name        ("@ashlr/core-efficiency": "^1")
 *        - workspace file link  ("@ashlr/core-efficiency": "file:../ashlr-core-efficiency")
 *        - github ref           ("...": "github:ashlrai/ashlr-core-efficiency#v0.3.0")
 *      The ecosystem map (docs/ECOSYSTEM-MAP.md) supplies a softer signal:
 *      repos named in another repo's composition profile are treated as a
 *      weak (composition) edge when no hard package edge exists.
 *   2. Map changed exports/symbols -> consumers that import them via a
 *      best-effort static grep of each direct consumer's source tree. A
 *      consumer that actually imports a changed symbol is "close"; one that
 *      merely declares the dependency is "far".
 *   3. Risk scales with the number AND closeness of affected consumers.
 *
 * CONTRACT: pure-ish (only reads the filesystem), bounded (caps repos / files /
 * bytes scanned), and NEVER throws — every public entry point is wrapped and
 * degrades to a safe `'none'` result on any error.
 *
 * Flag-gated (default OFF): callers consult
 *   (cfg.foundry as Record<string, unknown>)['blastRadius'] === true
 * This module does not wire itself into the merge gate — build-only.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BlastRisk = 'none' | 'low' | 'medium' | 'high';

export interface BlastRadiusInput {
  /** The repo being changed — absolute path, repo dir name, or package name. */
  repo: string;
  /** Files changed in the proposal (repo-relative or absolute). */
  changedFiles: string[];
  /** Optional changed/affected export symbol names (best-effort). */
  changedSymbols?: string[];
}

export interface AffectedConsumer {
  /** Consumer repo (directory name within the dev-tools root). */
  repo: string;
  /** Human-readable reason this consumer is considered affected. */
  reason: string;
}

export interface BlastRadiusResult {
  /** Distinct repo dir-names affected (consumers of the changed repo). */
  affectedRepos: string[];
  /** Per-consumer detail with the reason each is implicated. */
  affectedConsumers: AffectedConsumer[];
  /** Aggregate risk for shipping this change ecosystem-wide. */
  risk: BlastRisk;
  /** One-line human-readable explanation of the verdict. */
  detail: string;
}

/**
 * Minimal config shape this module reads. We accept the broader fleet `cfg`
 * via the same `foundry`-as-record cast the rest of the foundry uses, so the
 * flag stays consistent with M154/M158 conventions.
 */
export interface BlastRadiusConfig {
  foundry?: unknown;
  /** Optional override for the ecosystem root (defaults to the dev-tools dir). */
  ecosystemRoot?: string;
}

// ---------------------------------------------------------------------------
// Bounds (keep the scan cheap + safe on any tree)
// ---------------------------------------------------------------------------

const MAX_REPOS = 40;
const MAX_FILES_PER_CONSUMER = 600;
const MAX_BYTES_PER_FILE = 200_000;
const MAX_DEPTH = 6;
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.py', '.swift']);
const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.next', '.cache', '.turbo',
  '__pycache__', '.venv', 'vendor', 'target', 'coverage', '.ashlr',
]);

// ---------------------------------------------------------------------------
// Flag helper
// ---------------------------------------------------------------------------

/**
 * blastRadiusEnabled — true only when cfg.foundry.blastRadius === true.
 * Default OFF. Never throws.
 */
export function blastRadiusEnabled(cfg: BlastRadiusConfig | undefined): boolean {
  try {
    const foundry = (cfg?.foundry ?? {}) as Record<string, unknown>;
    return foundry['blastRadius'] === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ecosystem root resolution
// ---------------------------------------------------------------------------

const DEFAULT_ECOSYSTEM_ROOT = '/Users/masonwyatt/Desktop/github/dev-tools';

/**
 * Resolve the directory that contains all the sibling repos. Prefers an
 * explicit cfg override, else the parent of the changed repo (when given as an
 * absolute path), else the well-known dev-tools default.
 */
function resolveEcosystemRoot(input: BlastRadiusInput, cfg?: BlastRadiusConfig): string {
  if (cfg?.ecosystemRoot && existsSync(cfg.ecosystemRoot)) return resolve(cfg.ecosystemRoot);
  // If repo is an absolute path that exists, its parent is the ecosystem root.
  if (input.repo && input.repo.startsWith('/') && existsSync(input.repo)) {
    return dirname(resolve(input.repo));
  }
  return DEFAULT_ECOSYSTEM_ROOT;
}

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

interface RepoNode {
  /** Directory name within the ecosystem root (the canonical repo id). */
  dir: string;
  /** Absolute path. */
  abs: string;
  /** Declared package name, if any. */
  pkgName: string | null;
  /** Dependency value strings from all dep blocks (for ref matching). */
  depEntries: Array<{ name: string; value: string }>;
}

interface EcosystemGraph {
  root: string;
  /** dir-name -> node */
  nodes: Map<string, RepoNode>;
  /** package-name -> dir-name (for resolving deps to a producer repo). */
  pkgToDir: Map<string, string>;
}

function safeReadJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_BYTES_PER_FILE) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function collectDepEntries(pkg: Record<string, unknown>): Array<{ name: string; value: string }> {
  const blocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  const out: Array<{ name: string; value: string }> = [];
  for (const block of blocks) {
    const obj = pkg[block];
    if (obj && typeof obj === 'object') {
      for (const [name, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === 'string') out.push({ name, value });
      }
    }
  }
  return out;
}

/** List immediate subdirectories of the ecosystem root (bounded). */
function listRepoDirs(root: string): string[] {
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (dirs.length >= MAX_REPOS) break;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      dirs.push(e.name);
    }
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Build the ecosystem dependency graph by scanning every sibling repo's
 * package.json. Never throws; returns a best-effort partial graph.
 */
function buildEcosystemGraph(root: string): EcosystemGraph {
  const nodes = new Map<string, RepoNode>();
  const pkgToDir = new Map<string, string>();

  for (const dir of listRepoDirs(root)) {
    const abs = join(root, dir);
    const pkg = safeReadJson(join(abs, 'package.json'));
    const pkgName = pkg && typeof pkg['name'] === 'string' ? (pkg['name'] as string) : null;
    const depEntries = pkg ? collectDepEntries(pkg) : [];
    nodes.set(dir, { dir, abs, pkgName, depEntries });
    if (pkgName) pkgToDir.set(pkgName, dir);
  }

  return { root, nodes, pkgToDir };
}

// ---------------------------------------------------------------------------
// Changed-repo identification
// ---------------------------------------------------------------------------

/**
 * Resolve the input.repo to a canonical dir-name within the graph. Accepts an
 * absolute path, a bare dir-name, or a package name.
 */
function resolveChangedRepoDir(input: BlastRadiusInput, graph: EcosystemGraph): string | null {
  const repo = (input.repo ?? '').trim();
  if (!repo) return null;

  // Absolute path → last segment if it's a known node.
  if (repo.startsWith('/')) {
    const base = repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''; // M341b: win32 paths use '\'
    if (graph.nodes.has(base)) return base;
  }
  // Direct dir-name match.
  if (graph.nodes.has(repo)) return repo;
  // Package-name match.
  if (graph.pkgToDir.has(repo)) return graph.pkgToDir.get(repo)!;

  // Last path segment fallback (e.g. trailing-slash, nested path).
  const base = repo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''; // M341b: win32 paths use '\'
  if (graph.nodes.has(base)) return base;

  return null;
}

// ---------------------------------------------------------------------------
// Edge detection: does `consumer` depend on `producer`?
// ---------------------------------------------------------------------------

/**
 * A dependency value references the producer when:
 *   - the dep name equals the producer's package name, OR
 *   - the value is a file: link whose path resolves to the producer dir, OR
 *   - the value is a github:/git ref whose repo segment matches the producer
 *     dir (or package basename).
 */
function depReferencesProducer(
  entry: { name: string; value: string },
  producer: RepoNode,
): boolean {
  // 1. package name match
  if (producer.pkgName && entry.name === producer.pkgName) return true;

  const value = entry.value;

  // 2. file:../<dir> link
  const fileMatch = /^(?:file:|link:)(.+)$/.exec(value);
  if (fileMatch) {
    const target = fileMatch[1].replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''; // M341b
    if (target === producer.dir) return true;
  }

  // 3. github:owner/repo[#ref] or git+https://.../repo.git
  const ghMatch = /(?:github:[^/]+\/|[/:])([\w.-]+?)(?:\.git)?(?:#.*)?$/.exec(value);
  if (ghMatch) {
    const repoSeg = ghMatch[1];
    if (repoSeg === producer.dir) return true;
    // also match against package basename (e.g. @ashlr/core-efficiency -> core-efficiency)
    const pkgBase = producer.pkgName?.split('/').pop();
    if (pkgBase && repoSeg === pkgBase) return true;
  }

  return false;
}

interface ConsumerEdge {
  dir: string;
  /** 'hard' = real package dependency; 'composition' = ecosystem-map signal. */
  kind: 'hard' | 'composition';
}

/** Find every repo that has a hard package dependency on the changed repo. */
function findHardConsumers(changedDir: string, graph: EcosystemGraph): ConsumerEdge[] {
  const producer = graph.nodes.get(changedDir);
  if (!producer) return [];
  const consumers: ConsumerEdge[] = [];
  for (const node of graph.nodes.values()) {
    if (node.dir === changedDir) continue;
    if (node.depEntries.some((e) => depReferencesProducer(e, producer))) {
      consumers.push({ dir: node.dir, kind: 'hard' });
    }
  }
  return consumers;
}

// ---------------------------------------------------------------------------
// Composition signal (soft edges from the ecosystem map)
// ---------------------------------------------------------------------------

/**
 * Best-effort: find repos whose ecosystem-map profile mentions the changed
 * repo by name. These are weak "composition" edges — we surface them only when
 * there are no hard edges (to avoid drowning the real signal). Never throws.
 *
 * We read docs/ECOSYSTEM-MAP.md relative to the hub repo root (the directory
 * of this module, walked up to package.json). This is an import-free, local
 * read — we do NOT depend on ecosystem/map.ts to keep this module standalone.
 */
function findCompositionConsumers(
  changedDir: string,
  graph: EcosystemGraph,
): ConsumerEdge[] {
  try {
    const mapText = readEcosystemMapText();
    if (!mapText) return [];

    // The changed repo can be referenced by its dir-name or package name.
    const producer = graph.nodes.get(changedDir);
    const aliases = new Set<string>([changedDir]);
    if (producer?.pkgName) {
      aliases.add(producer.pkgName);
      const base = producer.pkgName.split('/').pop();
      if (base) aliases.add(base);
    }

    // Split the map into per-repo profile bullet lines: "- **<repo>** — ...".
    const lines = mapText.split('\n');
    const edges: ConsumerEdge[] = [];
    const bulletRe = /^-\s+\*\*([\w@/.-]+)\*\*/;

    for (const line of lines) {
      const m = bulletRe.exec(line.trim());
      if (!m) continue;
      const profiledName = m[1];
      const profiledDir = resolveNameToDir(profiledName, graph);
      if (!profiledDir || profiledDir === changedDir) continue;
      // Does this repo's profile line mention the changed repo?
      const mentions = [...aliases].some((a) => a.length > 2 && line.includes(a));
      if (mentions) edges.push({ dir: profiledDir, kind: 'composition' });
    }
    return edges;
  } catch {
    return [];
  }
}

/** Map a name found in the map (dir, pkg, or pkg-basename) back to a dir. */
function resolveNameToDir(name: string, graph: EcosystemGraph): string | null {
  if (graph.nodes.has(name)) return name;
  if (graph.pkgToDir.has(name)) return graph.pkgToDir.get(name)!;
  const base = name.split('/').pop() ?? name;
  if (graph.nodes.has(base)) return base;
  return null;
}

let _mapCache: string | null | undefined; // undefined = unread; null = absent

/** Read docs/ECOSYSTEM-MAP.md from the hub repo root. Cached, never throws. */
function readEcosystemMapText(): string | null {
  if (_mapCache !== undefined) return _mapCache;
  try {
    // Walk up from this module's location to the nearest package.json dir.
    let dir = __dirnameSafe();
    const fsRoot = resolve('/');
    let repoRoot: string | null = null;
    while (dir !== fsRoot) {
      if (existsSync(join(dir, 'package.json'))) { repoRoot = dir; break; }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    if (!repoRoot) { _mapCache = null; return null; }
    const mapPath = join(repoRoot, 'docs', 'ECOSYSTEM-MAP.md');
    if (!existsSync(mapPath)) { _mapCache = null; return null; }
    _mapCache = readFileSync(mapPath, 'utf8');
    return _mapCache;
  } catch {
    _mapCache = null;
    return null;
  }
}

/** ESM/CJS-safe __dirname. */
function __dirnameSafe(): string {
  try {
    // In CJS this is the directory; in ESM the bundler/tsc provides it too.
    // Fall back to cwd if unavailable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (typeof __dirname !== 'undefined' ? __dirname : undefined) as string | undefined;
    return d ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

/** Reset the ecosystem-map cache. Only needed in tests. */
export function _resetBlastRadiusCache(): void {
  _mapCache = undefined;
}

// ---------------------------------------------------------------------------
// Symbol mapping: which consumers import the changed symbols?
// ---------------------------------------------------------------------------

/** Walk a consumer's source tree (bounded) and collect source file paths. */
function listConsumerSourceFiles(rootAbs: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES_PER_CONSUMER) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_PER_CONSUMER) return;
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot >= 0 ? e.name.slice(dot) : '';
        if (SOURCE_EXT.has(ext)) out.push(full);
      }
    }
  };
  walk(rootAbs, 0);
  return out;
}

/** Build word-boundary matchers for the changed symbols. */
function buildSymbolMatchers(symbols: string[]): Array<{ sym: string; re: RegExp }> {
  const matchers: Array<{ sym: string; re: RegExp }> = [];
  for (const raw of symbols) {
    const sym = (raw ?? '').trim();
    if (!sym || !/^[\w$]+$/.test(sym)) continue; // only safe identifier-like symbols
    matchers.push({ sym, re: new RegExp(`\\b${sym}\\b`) });
  }
  return matchers;
}

/**
 * Best-effort static grep: does this consumer's source reference any of the
 * changed symbols? Returns the list of symbols it appears to use. Bounded +
 * never throws.
 */
function consumerUsesSymbols(
  consumerAbs: string,
  matchers: Array<{ sym: string; re: RegExp }>,
): string[] {
  if (matchers.length === 0) return [];
  const hits = new Set<string>();
  try {
    const files = listConsumerSourceFiles(consumerAbs);
    for (const file of files) {
      if (hits.size === matchers.length) break;
      let text: string;
      try {
        const st = statSync(file);
        if (st.size > MAX_BYTES_PER_FILE) continue;
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const { sym, re } of matchers) {
        if (!hits.has(sym) && re.test(text)) hits.add(sym);
      }
    }
  } catch {
    /* degrade silently */
  }
  return [...hits];
}

// ---------------------------------------------------------------------------
// Risk model
// ---------------------------------------------------------------------------

/**
 * Risk scales with the number AND closeness of affected consumers:
 *   - "close"  consumer = imports a changed symbol (proven coupling), or a
 *              hard dep when no symbols were supplied to check against.
 *   - "far"    consumer = declares the dependency but no symbol coupling found,
 *              or a composition-only (soft) edge.
 *
 *   none   — no consumers at all (isolated change).
 *   low    — exactly 1 far consumer (declares dep, no proven symbol coupling),
 *            or composition-only signal.
 *   medium — 1 close consumer, or 2 far consumers.
 *   high   — ≥2 close consumers, or ≥3 affected consumers total, or a close
 *            consumer alongside other affected consumers.
 */
function scoreRisk(close: number, far: number): BlastRisk {
  const total = close + far;
  if (total === 0) return 'none';
  if (close >= 2) return 'high';
  if (total >= 3) return 'high';
  if (close === 1 && total >= 2) return 'high';
  if (close === 1) return 'medium';
  if (far >= 2) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * analyzeBlastRadius — estimate the cross-repo impact of a proposed change.
 *
 * Never throws. Returns `{ affectedRepos: [], affectedConsumers: [],
 * risk: 'none', detail }` for an isolated change, a flag-off call, or any
 * internal failure.
 */
export async function analyzeBlastRadius(
  input: BlastRadiusInput,
  cfg?: BlastRadiusConfig,
): Promise<BlastRadiusResult> {
  const none = (detail: string): BlastRadiusResult => ({
    affectedRepos: [],
    affectedConsumers: [],
    risk: 'none',
    detail,
  });

  try {
    if (!input || typeof input.repo !== 'string' || !input.repo.trim()) {
      return none('no repo specified — blast radius indeterminate, treated as none');
    }

    const root = resolveEcosystemRoot(input, cfg);
    if (!existsSync(root)) {
      return none(`ecosystem root not found (${root}); cannot compute blast radius`);
    }

    const graph = buildEcosystemGraph(root);
    const changedDir = resolveChangedRepoDir(input, graph);
    if (!changedDir) {
      return none(`changed repo '${input.repo}' not found in ecosystem at ${root}`);
    }

    // 1. Hard dependency edges (real package consumers).
    const hard = findHardConsumers(changedDir, graph);

    // 2. Composition edges — only when there are no hard edges, as a weaker
    //    "could be affected" signal so the result is never silently empty for
    //    a clearly-central repo.
    const composition = hard.length === 0 ? findCompositionConsumers(changedDir, graph) : [];

    // Merge, de-dupe by dir (hard wins over composition).
    const edgeByDir = new Map<string, ConsumerEdge>();
    for (const e of [...hard, ...composition]) {
      const existing = edgeByDir.get(e.dir);
      if (!existing || (existing.kind === 'composition' && e.kind === 'hard')) {
        edgeByDir.set(e.dir, e);
      }
    }

    if (edgeByDir.size === 0) {
      return none(
        `no repo depends on '${changedDir}' — change is isolated to that repo`,
      );
    }

    // 3. Symbol mapping over hard consumers (proves closeness).
    const matchers = buildSymbolMatchers(input.changedSymbols ?? []);
    const consumers: AffectedConsumer[] = [];
    let close = 0;
    let far = 0;

    for (const edge of edgeByDir.values()) {
      const node = graph.nodes.get(edge.dir);
      if (edge.kind === 'composition') {
        far += 1;
        consumers.push({
          repo: edge.dir,
          reason: `ecosystem-map composition link to '${changedDir}' (no hard package dependency)`,
        });
        continue;
      }

      // Hard edge — check symbol coupling when symbols were supplied.
      if (matchers.length > 0 && node) {
        const used = consumerUsesSymbols(node.abs, matchers);
        if (used.length > 0) {
          close += 1;
          consumers.push({
            repo: edge.dir,
            reason: `depends on '${changedDir}' and imports changed symbol(s): ${used.join(', ')}`,
          });
        } else {
          far += 1;
          consumers.push({
            repo: edge.dir,
            reason: `depends on '${changedDir}' (no changed symbol referenced in its source)`,
          });
        }
      } else {
        // No symbols to check against → a hard dep is treated as close (we
        // cannot rule out coupling, so we err toward caution).
        close += 1;
        consumers.push({
          repo: edge.dir,
          reason: matchers.length === 0
            ? `depends on '${changedDir}' (no changed symbols supplied — assuming coupling)`
            : `depends on '${changedDir}'`,
        });
      }
    }

    const risk = scoreRisk(close, far);
    const affectedRepos = consumers.map((c) => c.repo).sort();

    const detail =
      `change to '${changedDir}' (${(input.changedFiles ?? []).length} file(s)` +
      `${matchers.length ? `, ${matchers.length} symbol(s)` : ''}) ` +
      `affects ${affectedRepos.length} downstream consumer(s): ${affectedRepos.join(', ')} ` +
      `— risk=${risk} (${close} close, ${far} far)`;

    return { affectedRepos, affectedConsumers: consumers, risk, detail };
  } catch (err) {
    return none(
      `blast-radius analysis failed safely: ${(err as Error)?.message ?? 'unknown error'}`,
    );
  }
}
