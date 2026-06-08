/**
 * index-engine.ts
 *
 * Scans cfg.roots, builds an AshlrIndex of fully-populated IndexedItems,
 * and persists / loads the index from ~/.ashlr/index.json.
 *
 * Walk strategy
 * ─────────────
 * Each entry in cfg.roots is one of:
 *   A) A github/<category> parent  – walk category → repo (depth ≤ 3).
 *   B) A Desktop root              – index top-level folders + notable loose
 *      files; do NOT descend into a dir already covered by a github root,
 *      and do NOT descend into node_modules / .git / dist.
 *
 * Symlinks are detected with lstat. They are indexed once as kind:'symlink'
 * and are never followed for further repo discovery (avoids double-counting).
 *
 * One bad directory must never crash the whole walk – every stat/readdir call
 * is wrapped in a try/catch and failures are silently skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { INDEX_PATH, CONFIG_DIR } from './config.js';
import { categoryOf, describe, primaryLanguage, kindOf } from './classify.js';
import { isRepo, getGitStatus, getRemoteOrg } from './git.js';
import type { AshlrConfig, AshlrIndex, IndexedItem, ItemKind } from './types.js';

// ─── constants ────────────────────────────────────────────────────────────────

/** Index format version – bump when the shape changes. */
const INDEX_VERSION = 1;

/** Directory names to never descend into during any walk. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', 'coverage', '__pycache__']);

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a stable, filesystem-friendly ID from an absolute path.
 * Replace non-alphanumeric characters (except `-`) with `-` and
 * collapse runs; strip leading/trailing `-`.
 */
function pathToId(absPath: string): string {
  return absPath
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** Safe lstat — returns null on any error. */
function safeLstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** Safe stat (follows symlinks) — returns null on any error. */
function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Safe readdir with file types — returns [] on any error. */
function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Safe readlink — returns null on any error. */
function safeReadlink(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/**
 * Determine whether an item is "active" based on its last-modified ISO string
 * and the configured staleDays threshold.
 */
function computeActive(lastModified: string, staleDays: number): boolean {
  const ms = Date.parse(lastModified);
  if (Number.isNaN(ms)) return false;
  return Date.now() - ms <= staleDays * 86_400_000;
}

/**
 * Build a fully-populated IndexedItem for a single path.
 *
 * @param absPath   Absolute path to the filesystem entry.
 * @param cfg       Current hub config.
 * @param forcedKind  When the caller has already determined the kind (e.g.
 *                    symlinks detected before kindOf runs), pass it here.
 */
function buildItem(
  absPath: string,
  cfg: AshlrConfig,
  forcedKind?: ItemKind,
): IndexedItem | null {
  const lstat = safeLstat(absPath);
  if (!lstat) return null;

  const isSymlink = lstat.isSymbolicLink();
  const kind: ItemKind = forcedKind ?? kindOf(absPath);

  // For the modification timestamp prefer the real target's mtime for
  // symlinks so we don't always show the link creation time.
  const statForTime = isSymlink ? (safeStat(absPath) ?? lstat) : lstat;
  let lastModified = statForTime.mtime.toISOString();

  // Link target (for symlinks)
  const linkTarget: string | undefined = isSymlink
    ? (safeReadlink(absPath) ?? undefined)
    : undefined;

  // Git metadata (repos only)
  let gitStatus = undefined;
  let remote: string | null = null;
  let org: string | null = null;

  if (kind === 'repo') {
    try {
      gitStatus = getGitStatus(absPath) ?? undefined;
      const remoteOrg = getRemoteOrg(absPath);
      remote = remoteOrg.remote;
      org = remoteOrg.org;

      // Prefer git's last-commit timestamp over mtime when available.
      if (gitStatus?.lastCommit) {
        lastModified = gitStatus.lastCommit;
      }
    } catch {
      // git unavailable or not a real repo — continue without git info
    }
  }

  const active = computeActive(lastModified, cfg.staleDays);

  const item: IndexedItem = {
    id: pathToId(absPath),
    name: path.basename(absPath),
    path: absPath,
    kind,
    category: categoryOf(absPath),
    description: describe(absPath),
    org,
    remote,
    language: kind === 'repo' ? primaryLanguage(absPath) : null,
    lastModified,
    active,
    sizeBytes: lstat.isFile() ? lstat.size : undefined,
    ...(gitStatus !== undefined ? { git: gitStatus } : {}),
    ...(linkTarget !== undefined ? { linkTarget } : {}),
  };

  return item;
}

// ─── github walk ─────────────────────────────────────────────────────────────

/**
 * Walk a single github/<category> root.
 *
 * Layout expected:
 *   <categoryRoot>/
 *     <repo>/          ← depth 1 repo
 *     <monorepo>/
 *       <nested-repo>/ ← depth 2 repo (e.g. artist-encyclopedias/factory)
 *
 * Symlinks at any depth are recorded as kind:'symlink' and NOT descended.
 */
function walkGithubCategory(
  categoryRoot: string,
  cfg: AshlrConfig,
  seenPaths: Set<string>,
): IndexedItem[] {
  const items: IndexedItem[] = [];

  for (const dirent of safeReaddir(categoryRoot)) {
    const absPath = path.join(categoryRoot, dirent.name);

    // Canonical/resolved path used for dedup (handles cases where two roots
    // resolve to the same underlying directory).
    let realPath: string;
    try {
      realPath = fs.realpathSync(absPath);
    } catch {
      realPath = absPath;
    }

    if (seenPaths.has(realPath)) continue;

    const lstat = safeLstat(absPath);
    if (!lstat) continue;

    // ── Symlink ──
    if (lstat.isSymbolicLink()) {
      seenPaths.add(realPath);
      const item = buildItem(absPath, cfg, 'symlink');
      if (item) items.push(item);
      continue; // never follow symlinks for repo discovery
    }

    if (!lstat.isDirectory()) continue;

    // ── Check depth-1 repo ──
    if (isRepo(absPath)) {
      seenPaths.add(realPath);
      const item = buildItem(absPath, cfg, 'repo');
      if (item) items.push(item);
      continue;
    }

    // ── Not a repo at depth-1: check for nested repos (depth 2) ──
    // This handles monorepos like artist-encyclopedias/artist-encyclopedia-factory.
    let foundNested = false;
    for (const nested of safeReaddir(absPath)) {
      if (SKIP_DIRS.has(nested.name)) continue;
      const nestedPath = path.join(absPath, nested.name);

      let nestedReal: string;
      try {
        nestedReal = fs.realpathSync(nestedPath);
      } catch {
        nestedReal = nestedPath;
      }

      if (seenPaths.has(nestedReal)) continue;

      const nestedLstat = safeLstat(nestedPath);
      if (!nestedLstat) continue;

      if (nestedLstat.isSymbolicLink()) {
        seenPaths.add(nestedReal);
        const item = buildItem(nestedPath, cfg, 'symlink');
        if (item) items.push(item);
        foundNested = true;
        continue;
      }

      if (!nestedLstat.isDirectory()) continue;

      if (isRepo(nestedPath)) {
        seenPaths.add(nestedReal);
        foundNested = true;
        const item = buildItem(nestedPath, cfg, 'repo');
        if (item) items.push(item);
      }
    }

    // If we found nested repos, also index the parent dir as a doc-folder
    // (it's a grouping container, not a repo itself).
    if (foundNested) {
      seenPaths.add(realPath);
      const parentItem = buildItem(absPath, cfg, 'doc-folder');
      if (parentItem) items.push(parentItem);
    }
  }

  return items;
}

// ─── Desktop root walk ───────────────────────────────────────────────────────

/**
 * Index the top-level entries of a Desktop root directory.
 *
 * Rules:
 * - Skip anything already in seenPaths (already covered by github walk).
 * - Skip SKIP_DIRS basenames.
 * - Symlinks → kind:'symlink', do not follow.
 * - Directories that are git repos → kind:'repo' (record but don't double-count).
 * - Everything else → classify normally (doc-folder, doc, asset, other).
 * - Do NOT recurse — only top-level entries.
 *
 * The github/ subdirectory itself is covered by the github walk; skip it here.
 */
function walkDesktopRoot(
  root: string,
  cfg: AshlrConfig,
  seenPaths: Set<string>,
): IndexedItem[] {
  const items: IndexedItem[] = [];

  for (const dirent of safeReaddir(root)) {
    if (SKIP_DIRS.has(dirent.name)) continue;

    const absPath = path.join(root, dirent.name);

    const lstat = safeLstat(absPath);
    if (!lstat) continue;

    // ── Symlink ──
    // Check symlinks BEFORE the realpath-based seenPaths guard. A top-level
    // symlink (e.g. 'tts agents' -> github/side-projects/precious-grove)
    // resolves to a repo path the github walk already added to seenPaths; if
    // we deduped on the resolved realpath we'd drop the link entirely. Dedup
    // symlinks by their OWN path so they are still emitted as kind:'symlink'.
    if (lstat.isSymbolicLink()) {
      if (seenPaths.has(absPath)) continue;
      seenPaths.add(absPath);
      const item = buildItem(absPath, cfg, 'symlink');
      if (item) items.push(item);
      continue;
    }

    // Non-symlink: dedup by resolved realpath so a dir already covered by the
    // github walk is not re-indexed.
    let realPath: string;
    try {
      realPath = fs.realpathSync(absPath);
    } catch {
      realPath = absPath;
    }

    if (seenPaths.has(realPath)) continue;

    // ── Directory ──
    if (lstat.isDirectory()) {
      // Skip the github directory — it's covered by the dedicated github walk.
      if (dirent.name === 'github') {
        seenPaths.add(realPath);
        continue;
      }
      seenPaths.add(realPath);
      // Repos found at desktop top-level (unusual but possible).
      const kind: ItemKind = isRepo(absPath) ? 'repo' : kindOf(absPath);
      const item = buildItem(absPath, cfg, kind);
      if (item) items.push(item);
      continue;
    }

    // ── Regular file ──
    if (lstat.isFile()) {
      seenPaths.add(realPath);
      const item = buildItem(absPath, cfg, kindOf(absPath));
      if (item) items.push(item);
    }
  }

  return items;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Build a fresh AshlrIndex by scanning all cfg.roots.
 *
 * Walk order:
 *  1. Treat each root that ends in `/github/<category>` as a github category root.
 *  2. Treat every remaining root as a "desktop" root (top-level only).
 *  3. Track seenPaths (via realpath) across all roots to avoid double-counting.
 */
export function buildIndex(cfg: AshlrConfig): AshlrIndex {
  const seenPaths = new Set<string>();
  const allItems: IndexedItem[] = [];

  // Partition roots into github-category roots vs desktop roots.
  // A github-category root is any directory whose parent is named "github"
  // OR that matches one of the category paths in cfg.categories.
  const categoryPaths = new Set(Object.values(cfg.categories).map((p) => path.normalize(p)));

  const githubRoots: string[] = [];
  const desktopRoots: string[] = [];

  for (const root of cfg.roots) {
    const normalized = path.normalize(root);
    const parentName = path.basename(path.dirname(normalized));
    const baseName = path.basename(normalized);

    if (categoryPaths.has(normalized) || parentName === 'github') {
      // A category root itself (e.g. .../github/dev-tools).
      githubRoots.push(root);
    } else if (baseName === 'github') {
      // The github/ container root: each child directory is a category root
      // (dev-tools, side-projects, …). Expand it into per-category github roots
      // so walkGithubCategory descends to the actual repos.
      for (const dirent of safeReaddir(normalized)) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        const categoryRoot = path.join(normalized, dirent.name);
        const lstat = safeLstat(categoryRoot);
        if (!lstat) continue;
        // Don't follow symlinked category dirs; only real directories hold repos.
        if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
          githubRoots.push(categoryRoot);
        }
      }
    } else {
      desktopRoots.push(root);
    }
  }

  // Walk github category roots first so their realpath entries are in seenPaths
  // before the desktop walk processes symlinks that point into github/.
  for (const root of githubRoots) {
    try {
      const items = walkGithubCategory(root, cfg, seenPaths);
      allItems.push(...items);
    } catch {
      // One bad root must not crash everything.
    }
  }

  // Walk desktop roots (top-level only).
  for (const root of desktopRoots) {
    try {
      const items = walkDesktopRoot(root, cfg, seenPaths);
      allItems.push(...items);
    } catch {
      // One bad root must not crash everything.
    }
  }

  // Primary root for the index metadata: first desktop root, falling back to
  // the first root overall.
  const primaryRoot = desktopRoots[0] ?? cfg.roots[0] ?? '';

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    root: primaryRoot,
    items: allItems,
  };
}

/**
 * Load the index from INDEX_PATH.
 * Returns null if the file is absent, unreadable, or not valid JSON.
 */
export function loadIndex(): AshlrIndex | null {
  try {
    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Minimal shape validation: must have version + items array.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('items' in parsed) ||
      !Array.isArray((parsed as { items: unknown }).items)
    ) {
      return null;
    }
    return parsed as AshlrIndex;
  } catch {
    return null;
  }
}

/**
 * Persist the index to INDEX_PATH as pretty-printed JSON.
 * Creates CONFIG_DIR if it does not exist.
 */
export function writeIndex(index: AshlrIndex): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), 'utf8');
}
