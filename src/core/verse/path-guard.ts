/**
 * core/verse/path-guard.ts — the roots a Verse path may never name.
 *
 * Extracted from control-api.ts because two callers now need exactly the same
 * rule and a second copy would drift:
 *
 *   1. ENROLLMENT (`checkVerseScopePath`) — which repos the AUTONOMOUS lane
 *      may mutate.
 *   2. WORKSPACE ROOTS (`checkWorkspaceRootPath`) — which directories an
 *      INTERACTIVE session may be granted beyond its primary.
 *
 * Those are different registries with different consequences, but the set of
 * directories that must never appear in either is identical: the filesystem
 * root, the home directory, `~/.ashlr` (config.json with provider tokens in
 * plaintext, enrollment.json, the KILL sentinel, the 0600 `verse/*.launch.json`
 * launcher records) and `~/.codex/artifacts`.
 *
 * Only the WORDING differs between the two, so the phrasing is a parameter
 * and every existing enrollment error string is reproduced byte for byte.
 *
 * Node builtins only, and it imports nothing from `core/verse/**` — so both
 * `control-api.ts` and the workspace store can depend on it without a cycle.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath, sep } from 'node:path';

/** Longest path any guarded surface accepts. */
export const MAX_GUARDED_PATH_CHARS = 4096;

export type GuardedPathCheck =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * `~` is how `sanitizePublicJson` spells the home directory on every outbound
 * payload, so a path the UI read back from us arrives in that form. Expand it
 * before anything else looks at it.
 */
export function expandHomePrefix(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function isDirectoryPath(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Fully resolved physical path, or null when it cannot be resolved. */
export function physicalPath(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync.native(path) : null;
  } catch {
    return null;
  }
}

export function isUnderPath(path: string, root: string): boolean {
  const r = resolvePath(root);
  const p = resolvePath(path);
  return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * A directory a guarded surface may never cover, and how far the ban reaches.
 *
 *  - `exact`    — only the root itself (the filesystem root: everything is
 *                 "under" it, so containment would reject every path).
 *  - `ancestor` — the root itself, plus any directory that CONTAINS it. The
 *                 home directory: ordinary repos live inside it, so being
 *                 under it is fine, but naming `/Users` (which would drag the
 *                 whole home in) is not.
 *  - `both`     — the root itself, anything under it, and anything containing
 *                 it. Used for the two control directories.
 */
export interface ScopeDenyRoot {
  path: string;
  label: string;
  reach: 'exact' | 'ancestor' | 'both';
}

/**
 * Re-resolved from `homedir()` on every call so a relocated HOME (tests, a
 * moved home dir) is honored — the same rule config.ts follows.
 */
export function scopeDenyRoots(artifactsRoot: string): ScopeDenyRoot[] {
  const home = resolvePath(homedir());
  return [
    { path: resolvePath(sep), label: 'the filesystem root', reach: 'exact' },
    { path: home, label: 'your home directory', reach: 'ancestor' },
    { path: join(home, '.ashlr'), label: '~/.ashlr', reach: 'both' },
    { path: artifactsRoot, label: '~/.codex/artifacts', reach: 'both' },
  ];
}

/**
 * How a denial is worded. `self` names the root itself; `short` completes the
 * containment sentences. Existing enrollment copy is
 * `{ self: 'enrolled as autonomous scope', short: 'enrolled' }`.
 */
export interface DenyPhrasing {
  self: string;
  short: string;
}

/**
 * First deny rule `candidate` trips, or null. `verb` distinguishes the lexical
 * pass ("is under") from the physical one ("resolves under") so the operator
 * can tell a plain path from a symlink escape.
 */
export function deniedScopeRoot(
  candidate: string,
  roots: readonly ScopeDenyRoot[],
  verb: 'is' | 'resolves',
  phrasing: DenyPhrasing,
): string | null {
  for (const root of roots) {
    if (candidate === root.path) {
      return `${root.label} cannot be ${phrasing.self}`;
    }
    if (root.reach === 'both' && isUnderPath(candidate, root.path)) {
      return `path ${verb === 'is' ? 'is' : 'resolves'} under ${root.label} and cannot be ${phrasing.short}`;
    }
    if (root.reach !== 'exact' && isUnderPath(root.path, candidate)) {
      return `path contains ${root.label} and cannot be ${phrasing.short}`;
    }
  }
  return null;
}

export interface GuardedPathOptions {
  /**
   * True when the path must exist as a directory. Enrollment sets it for
   * `enroll` and clears it for `unenroll` (a repo deleted from disk must
   * still be removable from the registry). Workspace roots always set it.
   */
  requireDirectory: boolean;
  phrasing: DenyPhrasing;
  artifactsRoot?: string;
}

/**
 * Validate a path before it reaches a registry.
 *
 * Rejects: relative paths, NUL bytes, over-long paths, and anything that
 * resolves — LEXICALLY OR PHYSICALLY — into (or around) one of the forbidden
 * roots. Checking both spellings is the symlink-escape guard: a symlink whose
 * target sits inside a forbidden root is rejected even though its own path
 * looks innocent.
 *
 * Returns the PHYSICAL path when one exists, so the value stored and the
 * value listed are the same spelling and no caller has to reconcile two.
 */
export function checkGuardedPath(raw: string, opts: GuardedPathOptions): GuardedPathCheck {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'path is required' };
  }
  if (raw.length > MAX_GUARDED_PATH_CHARS) {
    return { ok: false, error: `path must be at most ${MAX_GUARDED_PATH_CHARS} characters` };
  }
  if (raw.includes('\0')) {
    return { ok: false, error: 'path must not contain NUL bytes' };
  }
  const expanded = expandHomePrefix(raw);
  if (!isAbsolute(expanded)) {
    return { ok: false, error: 'path must be absolute' };
  }

  const lexical = resolvePath(expanded);
  const artifactsRoot = opts.artifactsRoot ?? join(homedir(), '.codex', 'artifacts');
  const lexicalRoots = scopeDenyRoots(artifactsRoot);
  const lexicalDenial = deniedScopeRoot(lexical, lexicalRoots, 'is', opts.phrasing);
  if (lexicalDenial !== null) return { ok: false, error: lexicalDenial };

  // Physical identity: resolves symlinks, so an escape into a forbidden root
  // is caught even when the spelling hides it. Both sides are resolved — the
  // home directory itself can sit behind a symlink (macOS /var → /private/var),
  // and comparing a resolved path against an unresolved root would miss.
  const physical = physicalPath(lexical);
  if (physical !== null) {
    const physicalRoots = lexicalRoots.map((root) => ({
      ...root,
      path: physicalPath(root.path) ?? root.path,
    }));
    const physicalDenial = deniedScopeRoot(physical, physicalRoots, 'resolves', opts.phrasing);
    if (physicalDenial !== null) return { ok: false, error: physicalDenial };
  }

  if (opts.requireDirectory && !isDirectoryPath(lexical)) {
    return { ok: false, error: 'path must be an existing directory' };
  }
  return { ok: true, path: physical ?? lexical };
}

/** Phrasing for the enrollment registry — the pre-existing copy, verbatim. */
export const ENROLLMENT_PHRASING: DenyPhrasing = {
  self: 'enrolled as autonomous scope',
  short: 'enrolled',
};

/** Phrasing for a workspace root, which grants reach but never enrollment. */
export const WORKSPACE_ROOT_PHRASING: DenyPhrasing = {
  self: 'used as a workspace root',
  short: 'used as a workspace root',
};

/**
 * Validate one directory a session may be granted beyond its primary.
 *
 * Same forbidden roots as enrollment, different consequence: passing here
 * means an INTERACTIVE agent may read and write the directory for the life of
 * a chat. It says nothing about the autonomous lane, which still consults
 * `~/.ashlr/enrollment.json` and refuses anything absent from it.
 */
export function checkWorkspaceRootPath(raw: string, artifactsRoot?: string): GuardedPathCheck {
  return checkGuardedPath(raw, {
    requireDirectory: true,
    phrasing: WORKSPACE_ROOT_PHRASING,
    ...(artifactsRoot === undefined ? {} : { artifactsRoot }),
  });
}
