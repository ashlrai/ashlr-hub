/**
 * routes/verse/git/git-model.ts — the branch bar's and Review pane's words
 * and decisions, as pure functions (unit C5; SPEC-310C §2, §3).
 *
 * Kept apart from the components so the copy, the suggested-action labels and
 * the menu's disabled reasons are tested as a table, and so the bar's chunk
 * stays small (no React here, no DOM).
 *
 * Copy rules (DESIGN §13.8): operator language with units; "—" for a value
 * that was not measured; a state is always a WORD beside any colour or icon.
 */
import type {
  VerseGitDiffFile,
  VerseGitPr,
  VerseGitStatus,
  VerseGitSuggestedAction,
} from '../../../data/api-types.js';
import type { VerseGitCheckCounts, VerseGitPrLookup, VerseGitStatusDetail } from '../../../../core/verse/workbench-types.js';

// ---------------------------------------------------------------------------
// Wire additions the server sends beyond the frozen VerseGitStatus — contract
// now (workbench-types.ts §7 VerseGitStatusDetail). Optional HERE, so an
// older server that omits them still renders; the names alias the contract
// so the two can never drift.
// ---------------------------------------------------------------------------

export type GitPrLookup = VerseGitPrLookup;
export type GitCheckCounts = VerseGitCheckCounts;

export interface GitStatusView extends VerseGitStatus, Partial<Omit<VerseGitStatusDetail, keyof VerseGitStatus>> {}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('en-US');

/** 35079 → "35,079". */
export function formatCount(n: number): string {
  return NUMBER.format(Math.max(0, Math.round(n)));
}

/** "+35,079 −1,074" — a real minus sign, grouped digits. */
export function diffstatText(additions: number, deletions: number): string {
  return `+${formatCount(additions)} −${formatCount(deletions)}`;
}

/** The ± counts as a screen reader should hear them. */
export function diffstatLabel(files: number, additions: number, deletions: number): string {
  return `${formatCount(files)} ${files === 1 ? 'file' : 'files'} changed, ${formatCount(additions)} added, ${formatCount(deletions)} removed`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A root earns a bar row when there is something to do or to see. */
export function hasBranchActivity(s: GitStatusView): boolean {
  if (s.dirty > 0 || s.ahead > 0 || s.diffstat.files > 0) return true;
  if (s.pr && (s.pr.state === 'open' || s.pr.state === 'draft')) return true;
  return false;
}

/**
 * One row per repository: two chat roots inside the same repo would show the
 * same branch twice. The first root (the chat's priority order) keeps the row.
 */
export function dedupeByRepo<T extends GitStatusView>(statuses: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of statuses) {
    const key = s.gitRoot ?? s.root;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The primary button
// ---------------------------------------------------------------------------

export interface PrimaryAction {
  action: Exclude<VerseGitSuggestedAction, 'none'>;
  label: string;
  /** What the click will do, in one sentence (tooltip + accessible description). */
  disclosure: string;
}

export function primaryAction(s: GitStatusView): PrimaryAction | null {
  const branch = s.branch ?? 'HEAD';
  const base = s.base ?? 'the default branch';
  switch (s.suggested) {
    case 'commit':
      return { action: 'commit', label: 'Commit', disclosure: `Commit ${formatCount(s.dirty)} changed ${s.dirty === 1 ? 'file' : 'files'} on ${branch}.` };
    case 'push':
      return {
        action: 'push',
        label: 'Push',
        disclosure: s.upstream
          ? `Push ${formatCount(s.ahead)} ${s.ahead === 1 ? 'commit' : 'commits'} on ${branch} to ${s.upstream}.`
          : `Publish ${branch} to origin.`,
      };
    case 'create-pr':
      return {
        action: 'create-pr',
        label: 'Create PR',
        disclosure: `Open a pull request from ${branch} into ${base}${s.upstream === null || s.ahead > 0 ? ', pushing it first' : ''}.`,
      };
    case 'merge':
      return s.pr
        ? { action: 'merge', label: 'Merge', disclosure: `Squash-merge #${s.pr.number} into ${s.pr.baseRef || base}. Checks passed.` }
        : null;
    case 'view-pr':
      return s.pr ? { action: 'view-pr', label: 'View PR', disclosure: `Open #${s.pr.number} on GitHub.` } : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The ▾ menu (every item present; disabled WITH a reason, never hidden)
// ---------------------------------------------------------------------------

export type MenuActionId = 'draft-pr' | 'commit' | 'push' | 'open-github' | 'copy-branch' | 'review';

export interface MenuItem {
  id: MenuActionId;
  label: string;
  disabledReason: string | null;
}

export function menuItems(s: GitStatusView): MenuItem[] {
  const detached = s.branch === null;
  const onBase = s.branch !== null && s.base !== null && s.branch === s.base;
  const conflicts = (s.conflicts ?? 0) > 0;
  const openPr = s.pr !== null && (s.pr.state === 'open' || s.pr.state === 'draft');
  const draftReason = detached
    ? 'HEAD is detached'
    : onBase
      ? `You are on ${s.base}`
      : openPr
        ? `#${s.pr!.number} is already open`
        : s.prLookup === 'unavailable'
          ? 'GitHub is not reachable (is `gh` signed in?)'
          : null;
  return [
    { id: 'draft-pr', label: 'Create draft PR…', disabledReason: draftReason },
    {
      id: 'commit',
      label: 'Commit…',
      disabledReason: detached ? 'HEAD is detached' : conflicts ? 'Resolve the conflicts first' : s.dirty === 0 ? 'Nothing to commit' : null,
    },
    {
      id: 'push',
      label: s.upstream ? 'Push' : 'Publish branch',
      disabledReason: detached ? 'HEAD is detached' : s.upstream !== null && s.ahead === 0 ? 'Already pushed' : s.headSha === null ? 'No commits yet' : null,
    },
    { id: 'open-github', label: 'Open on GitHub', disabledReason: s.pr ? null : 'No pull request for this branch' },
    { id: 'copy-branch', label: 'Copy branch name', disabledReason: detached ? 'HEAD is detached' : null },
    { id: 'review', label: 'Review changes', disabledReason: s.diffstat.files === 0 && s.dirty === 0 ? 'No changes' : null },
  ];
}

// ---------------------------------------------------------------------------
// PR chip
// ---------------------------------------------------------------------------

export type PrTone = 'success' | 'danger' | 'warning' | 'running' | 'neutral' | 'merged';

export interface PrChipModel {
  /** "#463" */
  number: string;
  title: string;
  /** "Open", "Draft", "Merged", "Closed". */
  state: string;
  /** "checks passing", "2 of 9 checks failing", "checks running", "no checks", null. */
  checks: string | null;
  tone: PrTone;
  /** Everything above in one sentence, for the accessible name. */
  label: string;
}

export function prChip(pr: VerseGitPr, counts: GitCheckCounts | null | undefined): PrChipModel {
  const state = pr.state === 'open' ? 'Open' : pr.state === 'draft' ? 'Draft' : pr.state === 'merged' ? 'Merged' : 'Closed';
  let checks: string | null = null;
  let tone: PrTone = 'neutral';
  if (pr.state === 'merged') {
    tone = 'merged';
  } else if (pr.state === 'closed') {
    tone = 'neutral';
  } else {
    switch (pr.checks) {
      case 'passing':
        checks = counts && counts.total > 0 ? `${counts.passed}/${counts.total} checks passed` : 'checks passed';
        tone = pr.mergeable === false ? 'danger' : 'success';
        break;
      case 'failing':
        checks = counts ? `${counts.failed} of ${counts.total} checks failing` : 'checks failing';
        tone = 'danger';
        break;
      case 'pending':
        checks = counts ? `${counts.pending} of ${counts.total} checks running` : 'checks running';
        tone = 'running';
        break;
      case 'none':
        checks = 'no checks';
        break;
      default:
        checks = 'checks —';
    }
    if (pr.mergeable === false) checks = checks ? `${checks}, conflicts` : 'conflicts';
  }
  const label = [`Pull request #${pr.number}`, pr.title, state, checks].filter(Boolean).join(', ');
  return { number: `#${pr.number}`, title: pr.title, state, checks, tone, label };
}

// ---------------------------------------------------------------------------
// PR dialog defaults
// ---------------------------------------------------------------------------

/**
 * A PR title from the branch: the last commit's subject when there is one
 * (it is usually the best one-line summary), else the branch name made
 * readable (`feat/branch-bar` → "Branch bar").
 */
export function defaultPrTitle(s: GitStatusView): string {
  const subject = s.headSubject?.trim();
  if (subject) return subject;
  const leaf = (s.branch ?? '').split('/').pop() ?? '';
  const words = leaf.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}

// ---------------------------------------------------------------------------
// Review pane: file tree
// ---------------------------------------------------------------------------

export interface FileGroup {
  /** "src/core/verse", or "" for the repository root. */
  dir: string;
  files: Array<VerseGitDiffFile & { name: string }>;
}

/** Files grouped by directory, in path order — a flat, scannable tree. */
export function groupFiles(files: readonly VerseGitDiffFile[]): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    const cut = f.path.lastIndexOf('/');
    const dir = cut === -1 ? '' : f.path.slice(0, cut);
    const name = cut === -1 ? f.path : f.path.slice(cut + 1);
    let g = groups.get(dir);
    if (!g) {
      g = { dir, files: [] };
      groups.set(dir, g);
    }
    g.files.push({ ...f, name });
  }
  return [...groups.values()];
}

export const FILE_STATUS_WORD: Record<VerseGitDiffFile['status'], string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  U: 'conflicted',
};

// ---------------------------------------------------------------------------
// Review comments → a message draft
// ---------------------------------------------------------------------------

export interface ReviewComment {
  id: string;
  path: string;
  /** The file's line number (new side; old side for a deleted line). */
  line: number;
  side: 'new' | 'old';
  note: string;
}

/**
 * `path:line: note`, one per line (SPEC-310C §3), in file then line order so
 * the agent reads them top to bottom. A multi-line note keeps its line breaks,
 * indented under its anchor so each comment stays one visual block. A comment
 * on a deleted line says so — its number is the OLD file's.
 */
export function commentsToMessage(comments: readonly ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));
  return sorted
    .map((c) => {
      const [first, ...rest] = c.note.trim().split('\n');
      const anchor = `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`;
      return [`${anchor}: ${first ?? ''}`, ...rest.map((l) => `  ${l}`)].join('\n');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Errors → one sentence
// ---------------------------------------------------------------------------

/** What the page says when a git action fails. The server's sentence when it wrote one. */
export function describeGitError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; status?: number; detail?: string | null; code?: string | null; message?: string };
    if (e.name === 'DispatchDisabledError') return 'This server is read-only (started without dispatch), so git actions are off.';
    if (e.name === 'VerseMutationLockedError') return 'Unlock actions with the mutation token first.';
    if (e.status === 401) return 'The mutation token was rejected. Unlock again with the token `ashlr verse` printed.';
    if (e.detail) return e.detail;
    if (e.status === 404) return 'This server has no git routes yet. Update Ashlr and restart `ashlr verse`.';
    if (e.status === 409) return 'Git is busy in this repository. Try again in a moment.';
  }
  return 'The git action failed. The terminal will show why.';
}
