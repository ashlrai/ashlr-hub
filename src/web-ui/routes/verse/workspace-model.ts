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
  VerseRootPriority,
  VerseRootStatus,
  VerseSession,
  VerseWorkspace,
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
