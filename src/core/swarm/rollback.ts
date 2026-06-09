/**
 * core/swarm/rollback.ts — M17 rollback support.
 *
 * snapshotProject: READ-ONLY git snapshot taken before a swarm operates.
 *   Never throws; degrades gracefully to isRepo:false on any failure.
 *
 * rollbackTo: CONFIRM-GATED restore of a prior snapshot.
 *   The CLI gates this behind an explicit `ashlr swarm rollback <id>` command
 *   with a --yes confirm and optional --force; this function assumes that
 *   confirmation has already happened.
 *
 * GUARDRAILS (top priority):
 *  - rollbackTo is the ONLY potentially-destructive operation in M17.
 *  - NEVER pushes to a remote, NEVER deletes branches.
 *  - NEVER force-resets without opts.force === true.
 *  - Refuses (ok:false) on non-repo, or dirty tree without --force.
 *  - Never throws — all error paths return { ok: false, detail }.
 *  - Uses execFileSync with 10 s timeout and stdio:'pipe'.
 */

import { execFileSync } from 'node:child_process';
import type { RollbackSnapshot } from '../types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 10_000; // ms — rollback ops may take longer than reads

/**
 * Run a git command inside `cwd`. Returns trimmed stdout or null on error.
 */
function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return typeof out === 'string' ? out.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Returns true when `dir` is the root of a git repository (standard .git dir,
 * worktree file, or submodule pointer).
 *
 * Uses rev-parse rather than filesystem inspection so detached/bare repos and
 * git worktrees are detected correctly. Returns false on any error.
 */
function isGitRepo(dir: string): boolean {
  // git rev-parse --git-dir exits 0 only inside a git repo.
  const result = git(dir, ['rev-parse', '--git-dir']);
  return result !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Take a READ-ONLY snapshot of the project's git state.
 *
 * Contract:
 *  - NEVER throws; degrades to { isRepo: false, ... } on any failure.
 *  - Does NOT modify the working tree (no commit, no stash pop, no checkout).
 *  - If the tree is dirty, creates a stash object via `git stash create`
 *    (which writes the object to the ODB but does NOT touch HEAD or the index)
 *    and stores the resulting object sha as `stashRef`. This ensures the dirty
 *    tree is preserved in the ODB and can be restored later via `git stash apply`.
 */
export function snapshotProject(project: string | null): RollbackSnapshot {
  const ts = new Date().toISOString();

  const base: RollbackSnapshot = {
    project,
    isRepo: false,
    head: null,
    dirty: false,
    stashRef: null,
    ts,
  };

  if (!project) return base;

  try {
    if (!isGitRepo(project)) return base;

    // Resolve HEAD sha.
    const head = git(project, ['rev-parse', 'HEAD']);
    if (!head) {
      // Repo exists but HEAD is unresolvable (e.g. fresh repo with no commits).
      return { ...base, isRepo: true };
    }

    // Record the branch name HEAD points at (null when detached: rev-parse
    // --abbrev-ref HEAD prints 'HEAD' in detached state). Lets a non-force
    // rollback return to the original branch instead of leaving detached HEAD.
    const abbrev = git(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = abbrev && abbrev !== 'HEAD' ? abbrev : null;

    // Determine whether the working tree is dirty (any tracked/untracked changes).
    const porcelain = git(project, ['status', '--porcelain']);
    const dirty = porcelain !== null && porcelain.length > 0;

    let stashRef: string | null = null;
    if (dirty) {
      // `git stash create` writes a stash commit to the ODB and prints its sha,
      // WITHOUT modifying HEAD, the index, or the working tree. Safe and
      // non-destructive. Returns empty/null if nothing to stash.
      const sha = git(project, ['stash', 'create', '--include-untracked']);
      if (sha && sha.length > 0) {
        stashRef = sha;
        // DURABILITY: a raw `stash create` object is not referenced by any ref,
        // so `git gc`/prune can collect it before rollback. Anchor it with a
        // content-addressed ref so it survives GC until we apply + clean it up.
        // Best-effort: if update-ref fails the sha is still recorded (it may
        // simply be lost to GC after a long delay — same as before this change).
        git(project, ['update-ref', `refs/ashlr/stash/${sha}`, sha]);
      }
    }

    return {
      project,
      isRepo: true,
      head,
      branch,
      dirty,
      stashRef,
      ts,
    };
  } catch {
    // Belt-and-suspenders: the inner git() calls never throw, but we guard the
    // whole body so snapshot is unconditionally safe to call.
    return base;
  }
}

/**
 * Restore a project to a previously snapshotted git state.
 *
 * Contract:
 *  - CONFIRM-GATED by the CLI; this function assumes confirmation happened.
 *  - NEVER pushes to a remote.
 *  - NEVER deletes branches.
 *  - NEVER force-resets without opts.force === true.
 *  - Refuses (returns { ok: false, detail }) without throwing when:
 *      • snap.isRepo is false (nothing to restore)
 *      • the current working tree is dirty and opts.force is false
 *      • any git operation fails
 *  - With opts.force: uses `git reset --hard <head>` so local uncommitted
 *    changes are discarded. Without opts.force: uses `git checkout <head>`
 *    which refuses to overwrite a dirty tree, giving the user a safe fallback.
 *  - After restoring HEAD, if snap.stashRef is set, attempts `git stash apply`
 *    to re-apply the dirty tree captured at snapshot time.
 */
export async function rollbackTo(
  snap: RollbackSnapshot,
  opts: { force: boolean },
): Promise<{ ok: boolean; detail: string }> {
  // --- Pre-condition: must be a git repo ---
  if (!snap.isRepo || !snap.project) {
    return {
      ok: false,
      detail:
        'Rollback refused: the project is not a git repository. ' +
        'No git state can be restored.',
    };
  }

  if (!snap.head) {
    return {
      ok: false,
      detail:
        'Rollback refused: no HEAD sha was recorded in the snapshot ' +
        '(the repo may have had no commits when the snapshot was taken).',
    };
  }

  const project = snap.project;

  // --- Check current dirty state ---
  try {
    const porcelain = git(project, ['status', '--porcelain']);
    const nowDirty = porcelain !== null && porcelain.length > 0;

    if (nowDirty && !opts.force) {
      return {
        ok: false,
        detail:
          'Rollback refused: the working tree has uncommitted changes. ' +
          'Pass --force to discard them and restore the snapshot, or commit/stash ' +
          'your work first.',
      };
    }

    const restoredLines: string[] = [];

    // --- Restore HEAD ---
    // With --force: hard reset (discards all local changes, replaces working tree).
    // Without --force: checkout (safe; refuses to overwrite dirty files — but we
    //   already checked dirty above, so at this point nowDirty must be false).
    let restoreResult: string | null;
    let restoreMethod: string;

    if (opts.force) {
      // DESTRUCTIVE-TO-COMMITTED-WORK WARNING: `reset --hard` to an older sha
      // silently discards any commits made AFTER the snapshot (they become
      // unreferenced, recoverable only via reflog/GC window). Surface the count
      // so the human approving this op sees exactly what is lost — the working
      // tree warning alone understates the loss of committed work.
      const aheadStr = git(project, ['rev-list', '--count', `${snap.head}..HEAD`]);
      const ahead = aheadStr !== null ? parseInt(aheadStr, 10) : NaN;
      if (Number.isFinite(ahead) && ahead > 0) {
        restoredLines.push(
          `WARNING: this discarded ${ahead} commit(s) made since the snapshot. ` +
          `They are unreferenced now and recoverable only via \`git reflog\` ` +
          `until garbage-collected.`,
        );
      }
      // ONLY force-reset when the caller explicitly passed --force.
      restoreResult = git(project, ['reset', '--hard', snap.head]);
      restoreMethod = `git reset --hard ${snap.head}`;
    } else {
      // Prefer returning to the ORIGINAL BRANCH (avoids detached HEAD) when the
      // recorded branch still resolves to the snapshot sha. Otherwise fall back
      // to checking out the raw sha (which detaches HEAD — noted below).
      const branchSha = snap.branch ? git(project, ['rev-parse', snap.branch]) : null;
      if (snap.branch && branchSha === snap.head) {
        restoreResult = git(project, ['checkout', snap.branch]);
        restoreMethod = `git checkout ${snap.branch}`;
      } else {
        restoreResult = git(project, ['checkout', snap.head]);
        restoreMethod = `git checkout ${snap.head}`;
      }
    }

    if (restoreResult === null) {
      return {
        ok: false,
        detail: `Rollback failed: \`${restoreMethod}\` returned an error. ` +
          'The repository state was not modified.',
      };
    }

    restoredLines.push(`Restored HEAD to ${snap.head} (via ${restoreMethod}).`);

    // Detect a detached-HEAD result and tell the user how to reattach. This
    // happens on the non-force path when the original branch no longer points
    // at the snapshot sha (or none was recorded), so we checked out a raw sha.
    const afterBranch = git(project, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (afterBranch === 'HEAD') {
      restoredLines.push(
        snap.branch
          ? `Note: HEAD is now DETACHED (branch "${snap.branch}" has moved past the ` +
            `snapshot). Reattach with \`git checkout ${snap.branch}\` when ready.`
          : `Note: HEAD is now DETACHED at ${snap.head}. ` +
            `Reattach to a branch with \`git checkout <branch>\` when ready.`,
      );
    }

    // --- Re-apply stash if one was recorded ---
    if (snap.stashRef) {
      const applyResult = git(project, ['stash', 'apply', snap.stashRef]);
      if (applyResult !== null) {
        restoredLines.push(
          `Re-applied dirty-tree stash ${snap.stashRef}.`,
        );
        // Clean up the anchor ref we created at snapshot time (best-effort).
        git(project, ['update-ref', '-d', `refs/ashlr/stash/${snap.stashRef}`]);
      } else {
        // Non-fatal: stash apply failure leaves the repo at the restored HEAD
        // which is still the correct base. Report but don't fail the rollback.
        // Leave the anchor ref in place so the stash is not lost to GC and the
        // user can apply it manually.
        restoredLines.push(
          `Warning: could not re-apply dirty-tree stash ${snap.stashRef}. ` +
          `HEAD was still restored to ${snap.head}. ` +
          'You may need to apply the stash manually: ' +
          `\`git stash apply ${snap.stashRef}\``,
        );
      }
    }

    return {
      ok: true,
      detail: restoredLines.join('\n'),
    };
  } catch {
    // Belt-and-suspenders: inner calls never throw, but guard the whole body.
    return {
      ok: false,
      detail:
        'Rollback failed: an unexpected error occurred. ' +
        'The repository state may be unmodified.',
    };
  }
}
