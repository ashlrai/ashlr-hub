/**
 * routes/verse/workspace-model.ts — pure helpers for multi-root sessions.
 * No React, no I/O, so every rule below is testable without a DOM.
 *
 * The honesty rules these encode, and why each exists:
 *
 *  - A root with no git repo shows "not a git repo", never a blank space where
 *    a branch would be. An empty slot reads as "clean on the default branch".
 *  - `dirty` is a COUNT of changed entries, so it is rendered as a count.
 *    "modified" alone hides whether that is one file or forty.
 *  - An unenrolled root says the autonomous lane refuses it, rather than
 *    showing a warning that could be read as "this chat cannot use it" — it
 *    can, and does.
 *  - An unreachable root (a Grok seat, which has no additional-directory flag)
 *    is listed and marked, never hidden. Hiding it would misrepresent the
 *    workspace the operator chose.
 */
import type {
  VerseEngine,
  VerseRootPriority,
  VerseRootStatus,
  VerseSession,
  VerseWorkspace,
  VerseWorkspaceRoot,
} from '../../data/api-types.js';
import { isAbsolutePath } from './verse-model.js';

/** Hard cap, mirroring VERSE_MAX_WORKSPACE_ROOTS on the server. */
export const MAX_WORKSPACE_ROOTS = 8;

/** Every root a session can reach, primary first. Mirrors `verseSessionRoots`. */
export function sessionRootPaths(session: Pick<VerseSession, 'projectPath' | 'extraRoots'>): string[] {
  const out = [session.projectPath];
  for (const root of session.extraRoots ?? []) {
    if (typeof root === 'string' && root.length > 0 && !out.includes(root)) out.push(root);
  }
  return out;
}

/** True when this session reaches more than its primary folder. */
export function isMultiRoot(session: Pick<VerseSession, 'projectPath' | 'extraRoots'>): boolean {
  return sessionRootPaths(session).length > 1;
}

/**
 * Short label for a session's folder scope: the primary's name, plus how many
 * more it carries. Used where only one line fits (a sidebar row, a pill).
 */
export function rootScopeLabel(
  session: Pick<VerseSession, 'projectPath' | 'extraRoots'>,
  primaryName: string,
): string {
  const extra = sessionRootPaths(session).length - 1;
  return extra > 0 ? `${primaryName} +${extra}` : primaryName;
}

/**
 * One line of git identity for a root.
 *
 * Returns null when the root is not a repo, so the caller renders the "not a
 * git repo" wording ONCE rather than each caller inventing its own.
 */
export function rootGitLine(root: VerseRootStatus): string | null {
  if (root.git === null) return null;
  const parts = [root.git.branch];
  parts.push(root.git.dirty === 0 ? 'clean' : `${root.git.dirty} changed`);
  if (root.git.ahead > 0) parts.push(`${root.git.ahead} ahead`);
  if (root.git.behind > 0) parts.push(`${root.git.behind} behind`);
  return parts.join(' · ');
}

export type RootTone = 'primary' | 'extra' | 'unreachable' | 'missing';

/** Which visual treatment a root row gets. Missing beats unreachable. */
export function rootTone(root: VerseRootStatus): RootTone {
  if (!root.exists) return 'missing';
  if (!root.reachable) return 'unreachable';
  return root.primary ? 'primary' : 'extra';
}

/**
 * The plain-language caveat for one root, or null when there is nothing to
 * say. Word, never colour alone (DESIGN-V2 §6).
 */
export function rootCaveat(root: VerseRootStatus): string | null {
  if (!root.exists) return 'missing on disk';
  if (!root.reachable) return 'this engine cannot reach it';
  if (!root.enrolled) return 'not enrolled — autonomous lane refuses it';
  return null;
}

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

export const ROOT_PRIORITY_LABEL: Record<VerseRootPriority, string> = {
  critical: 'Critical',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const ROOT_PRIORITY_ORDER: readonly VerseRootPriority[] =
  ['critical', 'high', 'normal', 'low'];

/**
 * How a priority must be explained wherever it is offered.
 *
 * Priority orders what the autonomous lane already reaches. It is NOT a grant,
 * and the copy has to say so at the point of the choice — otherwise ranking a
 * repo `critical` reads as turning it on.
 */
export const ROOT_PRIORITY_NOTE =
  'Priority orders the repositories the fleet already has. It never adds one — a repository that is not enrolled stays out of reach at every priority.';

/**
 * Sort weight; lower sorts first. Mirrors `VERSE_ROOT_PRIORITY_RANK` on the
 * server so the list the operator re-ranks here and the list the autonomous
 * lane walks cannot be ordered differently.
 */
export const ROOT_PRIORITY_RANK: Record<VerseRootPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/** A path's priority, treating an absent key as `normal` (as the server does). */
export function priorityOf(
  path: string,
  priorities: Readonly<Record<string, VerseRootPriority>> | undefined,
): VerseRootPriority {
  return priorities?.[path] ?? 'normal';
}

/**
 * Paths most-important-first.
 *
 * STABLE: two paths at the same priority keep the order they were given, so
 * re-ranking one repo never silently shuffles the rest. Ordering only — this
 * neither adds nor removes a path.
 */
export function rankPathsByPriority(
  paths: readonly string[],
  priorities: Readonly<Record<string, VerseRootPriority>> | undefined,
): string[] {
  return paths
    .map((path, index) => ({ path, index, rank: ROOT_PRIORITY_RANK[priorityOf(path, priorities)] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.path);
}

// ---------------------------------------------------------------------------
// Root-set editing (the new-chat dialog and the workspace editor share this)
// ---------------------------------------------------------------------------

export interface RootSetValidation {
  ok: boolean;
  /** One message, or null when the set is usable. */
  error: string | null;
  /** The set as it would be sent: trimmed, de-duplicated, primary first. */
  roots: string[];
}

/**
 * Validate a root set typed by hand.
 *
 * COURTESY ONLY. The server re-checks every path against the same deny roots
 * the enrollment registry uses, and it is the authority — this cannot know the
 * real home directory behind a `~`, and it must not pretend to.
 */
export function validateRootSet(primary: string, extras: readonly string[]): RootSetValidation {
  const trimmedPrimary = primary.trim();
  if (trimmedPrimary.length === 0) {
    return { ok: false, error: 'Pick a primary folder.', roots: [] };
  }
  if (!isAbsolutePath(trimmedPrimary)) {
    return { ok: false, error: 'The primary folder must be an absolute path on this machine.', roots: [] };
  }
  const roots = [trimmedPrimary];
  for (const raw of extras) {
    const root = raw.trim();
    if (root.length === 0) continue;
    if (!isAbsolutePath(root)) {
      return { ok: false, error: `Not an absolute path: ${root}`, roots: [] };
    }
    if (roots.includes(root)) continue;
    roots.push(root);
  }
  if (roots.length > MAX_WORKSPACE_ROOTS) {
    return { ok: false, error: `A workspace holds at most ${MAX_WORKSPACE_ROOTS} folders.`, roots: [] };
  }
  return { ok: true, error: null, roots };
}

/** The primary root of a stored workspace (the one a session uses as its cwd). */
export function workspacePrimary(workspace: VerseWorkspace): string | null {
  return (workspace.roots.find((r) => r.primary) ?? workspace.roots[0])?.path ?? null;
}

/** "service +2 folders" — how a workspace reads in a picker. */
export function workspaceSummary(workspace: VerseWorkspace): string {
  const extra = workspace.roots.length - 1;
  if (extra <= 0) return '1 folder';
  return `${workspace.roots.length} folders`;
}

/**
 * A workspace's roots in SEND order: the primary first, then the rest as
 * stored.
 *
 * `VerseWorkspace.roots` is documented primary-first, but the flag is the
 * authority and an update replaces the set wholesale with "first entry is
 * primary". Normalising here means a reorder can never accidentally demote
 * the primary because a stored record listed it second.
 */
export function orderedWorkspaceRoots(workspace: VerseWorkspace): VerseWorkspaceRoot[] {
  const primary = workspace.roots.find((r) => r.primary);
  if (!primary) return [...workspace.roots];
  return [primary, ...workspace.roots.filter((r) => r !== primary)];
}

/** The same order, as the bare paths `updateVerseWorkspace` takes. */
export function workspaceRootPaths(workspace: VerseWorkspace): string[] {
  return orderedWorkspaceRoots(workspace).map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Which engines reach more than the primary folder
// ---------------------------------------------------------------------------

/**
 * Whether this engine's CLI takes an additional-directory flag.
 *
 * Mirrors `engineSupportsExtraRoots` in src/core/verse/workspaces.ts. Grok
 * exposes no such flag at all (checked on grok 0.2.118), so a Grok seat gets
 * its primary root and nothing else — and the UI has to SAY that at the point
 * the seat is chosen rather than let the operator discover it from a diff that
 * never applies.
 *
 * `null` (no seat picked yet) reaches everything: there is nothing to warn
 * about until a seat exists.
 */
export function engineReachesExtraRoots(engine: VerseEngine | null | undefined): boolean {
  if (engine === null || engine === undefined) return true;
  return engine === 'claude' || engine === 'codex' || engine === 'local';
}

export const EXTRA_ROOTS_REACHABLE_NOTE =
  'The agent can read and write these folders for the life of this chat. Enrolment is separate — an unenrolled folder stays out of reach of the autonomous lane.';

export const EXTRA_ROOTS_UNREACHABLE_NOTE =
  'This seat’s CLI takes no additional-directory flag, so it will reach only the primary folder. The other folders will be unreachable — pick a Claude, Codex or local seat to use more than one.';

/**
 * The caveat for handing `rootCount` folders to a seat, or null when there is
 * nothing to warn about. Only ever the BAD news, so a caller can render it as
 * a warning without having to decide which sentence it got.
 */
export function extraRootsCaveat(
  engine: VerseEngine | null | undefined,
  rootCount: number,
): string | null {
  if (rootCount <= 1) return null;
  return engineReachesExtraRoots(engine) ? null : EXTRA_ROOTS_UNREACHABLE_NOTE;
}

/** The full note for a multi-folder set: the caveat when there is one, the
 *  enrolment reminder otherwise. Null when only one folder is in play. */
export function extraRootsNote(
  engine: VerseEngine | null | undefined,
  rootCount: number,
): string | null {
  if (rootCount <= 1) return null;
  return extraRootsCaveat(engine, rootCount) ?? EXTRA_ROOTS_REACHABLE_NOTE;
}

/** Said once wherever a multi-folder project is DEFINED, where no seat is
 *  chosen yet and so no per-seat caveat can be given. */
export const MULTI_ROOT_ENGINE_NOTE =
  'Claude, Codex and local seats reach every folder here. A Grok seat reaches only the primary one.';

// ---------------------------------------------------------------------------
// Saved projects (the create/edit form behind the workspace routes)
// ---------------------------------------------------------------------------

/** The folder's own name, used when the operator names nothing. */
export function defaultWorkspaceName(primaryPath: string): string {
  const trimmed = primaryPath.trim().replace(/[/\\]+$/, '');
  const base = trimmed.split(/[/\\]/).pop() ?? '';
  return base.length > 0 ? base : trimmed;
}

export interface WorkspaceDraftValidation {
  ok: boolean;
  /** One message, or null when the draft is sendable. */
  error: string | null;
  /** The name as it would be sent — never empty when `ok`. */
  name: string;
  /** Trimmed, de-duplicated, primary first. */
  roots: string[];
}

/**
 * Validate a saved project before it is sent.
 *
 * COURTESY ONLY, exactly like `validateRootSet`: the server re-checks every
 * path against the enrollment registry's deny roots and is the authority.
 */
export function validateWorkspaceDraft(
  name: string,
  roots: readonly string[],
): WorkspaceDraftValidation {
  const [primary = '', ...extras] = roots;
  const set = validateRootSet(primary, extras);
  if (!set.ok) return { ok: false, error: set.error, name: '', roots: [] };
  const trimmed = name.trim();
  const resolved = trimmed.length > 0 ? trimmed : defaultWorkspaceName(set.roots[0]!);
  if (resolved.length === 0) {
    return { ok: false, error: 'Give this project a name.', name: '', roots: [] };
  }
  return { ok: true, error: null, name: resolved, roots: set.roots };
}

/**
 * Move one entry up or down by one place.
 *
 * Returns a NEW array, and returns the order unchanged when the move would
 * fall off either end — so a caller can wire it to a button that is disabled
 * at the ends without the two disagreeing.
 */
export function moveRoot<T>(roots: readonly T[], index: number, direction: 'up' | 'down'): T[] {
  const next = [...roots];
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next;
  const moved = next[index]!;
  next[index] = next[target]!;
  next[target] = moved;
  return next;
}

/**
 * How the first row must be described. The first root IS the primary — it is
 * the session's cwd and the only folder a Grok seat reaches — so the reorder
 * control is not cosmetic and the label has to say what it does.
 */
export function rootRowLabel(index: number): string {
  return index === 0 ? 'Primary folder' : `Folder ${index + 1}`;
}
