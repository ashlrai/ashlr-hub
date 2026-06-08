/**
 * src/core/tidy.ts
 *
 * Plan and apply tidy moves for loose top-level files on the Desktop root.
 *
 * planTidy()  — dry-run; examines only direct children of the Desktop root
 *               (the root in cfg.roots that is NOT under github/).
 *               Never plans to move: keepers, category folders, symlinks,
 *               the github/ dir, or git repos.
 *
 * applyTidy() — execute plan.moves; collision-safe (skip if dest exists or
 *               source is already gone); mkdir -p dest dirs as needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AshlrConfig, TidyMove, TidyPlan, TidyRule } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Desktop root from cfg.roots.
 * We want the root that is NOT inside a github/ subtree — i.e. the Desktop
 * itself, not the github scan root that may also be listed.
 */
function isGithubPath(p: string): boolean {
  const normalized = path.normalize(p);
  if (path.basename(normalized) === 'github') return true;
  return normalized.split(path.sep).includes('github');
}

function desktopRoot(cfg: AshlrConfig): string | null {
  for (const r of cfg.roots) {
    // If this root is NOT the github/ dir itself (and not inside one), treat
    // it as the Desktop root.
    if (!isGithubPath(r)) {
      return r;
    }
  }
  // No non-github root exists — refuse to operate (do NOT fall back to
  // cfg.roots[0], which would be the github container and risk moving the
  // category dirs). Caller treats null as "empty plan".
  return null;
}

/**
 * Detect a git repo without importing git.ts (which may be an unimplemented
 * stub in early build stages). A directory is a repo when it contains a
 * `.git` entry (directory OR file — the latter covers worktrees/submodules).
 */
function isGitRepo(dir: string): boolean {
  try {
    const gitPath = path.join(dir, '.git');
    fs.accessSync(gitPath); // throws if absent
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve whether `name` (or `fullPath`) is a keeper.
 * Keepers may be stored as absolute paths OR bare basenames.
 */
function isKeeper(fullPath: string, name: string, keepers: string[]): boolean {
  for (const k of keepers) {
    if (k === name || k === fullPath) return true;
    // Treat entries like "Rent Application.pdf" as basename matchers.
    if (path.basename(k) === name) return true;
  }
  return false;
}

/**
 * Test whether `name` is a known category folder (the folder itself, not
 * contents — we never move the category container).
 */
function isCategoryFolder(fullPath: string, categories: Record<string, string>): boolean {
  return Object.values(categories).some((catPath) => catPath === fullPath);
}

// ---------------------------------------------------------------------------
// Glob / regex / ext matching
// ---------------------------------------------------------------------------

/**
 * Convert a shell glob pattern to a RegExp.
 * Supports: * (any chars except /), ** (any chars incl /), ? (single char),
 * and character classes [abc].
 * For tidy purposes we match against the basename only when the glob has
 * no path separator, or against the full path when it does.
 */
function globToRegex(glob: string): RegExp {
  let src = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      src += '.*';
      i += 2;
      // Consume optional trailing /
      if (glob[i] === '/') i++;
    } else if (ch === '*') {
      src += '[^/]*';
      i++;
    } else if (ch === '?') {
      src += '[^/]';
      i++;
    } else if (ch === '[') {
      // Pass character class through verbatim until ]
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        src += '\\[';
        i++;
      } else {
        src += glob.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      // Escape regex meta chars
      src += ch.replace(/[.+^${}()|\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${src}$`, 'i');
}

/**
 * Return true if `itemPath` matches a TidyRule.
 * For 'ext'  → compare lowercased extension (with leading dot).
 * For 'glob' → match against basename (no separator in glob) or full path.
 * For 'regex'→ match against basename.
 */
function matchesRule(itemPath: string, rule: TidyRule): boolean {
  const name = path.basename(itemPath);
  const ext = path.extname(name).toLowerCase();

  switch (rule.matchType) {
    case 'ext': {
      // Normalise: accept ".pdf" or "pdf"
      const ruleExt = rule.match.startsWith('.') ? rule.match.toLowerCase() : `.${rule.match.toLowerCase()}`;
      return ext === ruleExt;
    }

    case 'glob': {
      const globHasPath = rule.match.includes('/');
      if (globHasPath) {
        return globToRegex(rule.match).test(itemPath);
      }
      return globToRegex(rule.match).test(name);
    }

    case 'regex': {
      try {
        return new RegExp(rule.match, 'i').test(name);
      } catch {
        // Malformed regex — never match, don't crash.
        return false;
      }
    }

    default:
      return false;
  }
}

/**
 * Resolve a destination directory from a TidyRule.
 * If `dest` is relative, resolve it relative to `root`.
 * If `dest` is absolute, use it as-is.
 */
function resolveDest(dest: string, root: string): string {
  return path.isAbsolute(dest) ? dest : path.resolve(root, dest);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Plan a tidy pass over the Desktop root.
 *
 * Only direct children of the root are examined (depth 1).
 * Moves are first-match-wins against cfg.tidyRules.
 * Items with no matching rule are recorded in skipped[].
 */
export function planTidy(cfg: AshlrConfig): TidyPlan {
  const moves: TidyMove[] = [];
  const skipped: { path: string; reason: string }[] = [];

  const root = desktopRoot(cfg);
  if (!root) {
    return { moves, skipped };
  }

  // Unconditional github protection: never operate when the resolved root is
  // (or is under) a github container. desktopRoot() already excludes these,
  // but assert it here so the invariant holds even if selection logic changes.
  if (isGithubPath(root)) {
    return { moves, skipped };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // Root unreadable — return empty plan.
    return { moves, skipped };
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);

    // 1. Skip symlinks — never plan to move them.
    if (entry.isSymbolicLink()) {
      skipped.push({ path: fullPath, reason: 'symlink' });
      continue;
    }

    // 2. Skip the github/ directory itself.
    if (entry.name === 'github' && entry.isDirectory()) {
      skipped.push({ path: fullPath, reason: 'github directory' });
      continue;
    }

    // 3. Skip keepers.
    if (isKeeper(fullPath, entry.name, cfg.keepers)) {
      skipped.push({ path: fullPath, reason: 'keeper' });
      continue;
    }

    // 4. Skip category folders themselves (don't move the container).
    if (entry.isDirectory() && isCategoryFolder(fullPath, cfg.categories)) {
      skipped.push({ path: fullPath, reason: 'category folder' });
      continue;
    }

    // 5. Skip git repos — they are managed by the index, not tidy.
    if (entry.isDirectory() && isGitRepo(fullPath)) {
      skipped.push({ path: fullPath, reason: 'git repo' });
      continue;
    }

    // Tidy rules only apply to regular files. A loose top-level DIRECTORY that
    // passed the keeper/category/repo guards must never be moved wholesale by
    // a basename glob like 'Screenshot*' or '*Contract*' (which would relocate
    // an entire 'Contracts' or 'Q1 Invoices' folder). Record it as skipped.
    if (!entry.isFile()) {
      skipped.push({ path: fullPath, reason: 'directory — tidy rules apply to files only' });
      continue;
    }

    // 6. Find first matching tidy rule.
    let matched = false;
    for (const rule of cfg.tidyRules) {
      if (matchesRule(fullPath, rule)) {
        const destDir = resolveDest(rule.dest, root);
        const destPath = path.join(destDir, entry.name);
        const ruleLabel = rule.description ?? `${rule.matchType}:${rule.match} → ${rule.dest}`;
        matched = true;

        // Destination safety: never let a (possibly custom) rule write into a
        // github/ subtree or onto a keeper path. Skip with a clear reason.
        if (isGithubPath(destDir) || isKeeper(destPath, entry.name, cfg.keepers)) {
          skipped.push({ path: fullPath, reason: `unsafe destination: ${destDir}` });
          break;
        }

        // Collision: a file already exists at the destination. Surface this in
        // the dry-run plan as a skip rather than planning a move applyTidy()
        // would later refuse to perform (it never overwrites).
        if (fs.existsSync(destPath)) {
          skipped.push({ path: fullPath, reason: `collision: ${destPath} already exists` });
          break;
        }

        moves.push({ from: fullPath, to: destPath, rule: ruleLabel });
        break; // first-match-wins
      }
    }

    if (!matched) {
      skipped.push({ path: fullPath, reason: 'no matching rule' });
    }
  }

  return { moves, skipped };
}

/**
 * Execute a previously computed TidyPlan.
 *
 * For each move:
 *  - Create the destination directory (mkdir -p) if needed.
 *  - Skip (safe) if the source no longer exists.
 *  - Skip (safe) if the destination path already exists (collision).
 *  - Use fs.renameSync; falls back to copy+unlink if cross-device.
 */
export function applyTidy(plan: TidyPlan): void {
  for (const move of plan.moves) {
    // Safety: never write a move into a github/ subtree, even if a custom rule
    // produced one. planTidy already guards this, but applyTidy is the last
    // line of defense before an irreversible rename.
    if (isGithubPath(path.dirname(move.to))) {
      continue;
    }

    // Safety: re-check source exists.
    if (!fs.existsSync(move.from)) {
      continue; // Already gone — idempotent skip.
    }

    // Safety: skip if destination already occupied.
    if (fs.existsSync(move.to)) {
      continue; // Collision — do not overwrite.
    }

    // Ensure destination directory exists.
    const destDir = path.dirname(move.to);
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch {
      // If we can't create the dir, skip this move rather than crashing.
      continue;
    }

    // Attempt atomic rename.
    try {
      fs.renameSync(move.from, move.to);
    } catch (err: unknown) {
      // EXDEV = cross-device link — copy then unlink.
      if (isCrossDevice(err)) {
        try {
          fsCopyRecursive(move.from, move.to);
          fsRemoveRecursive(move.from);
        } catch {
          // Best-effort; if copy/remove fails, leave source in place.
        }
      }
      // Other errors: silently skip rather than crashing.
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-device fallback helpers (Node builtins only)
// ---------------------------------------------------------------------------

function isCrossDevice(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'EXDEV'
  );
}

/**
 * Recursively copy a file or directory tree to `dest`.
 * Simple implementation using Node builtins — no third-party deps.
 */
function fsCopyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      fsCopyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

/**
 * Recursively remove a file or directory tree.
 * Uses rm with recursive + force (Node 14.14+).
 */
function fsRemoveRecursive(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
