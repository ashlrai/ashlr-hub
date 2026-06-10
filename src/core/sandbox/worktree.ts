/**
 * worktree.ts — isolated git-worktree sandbox (M21 SAFETY FOUNDATION).
 *
 * Creates an ISOLATED git worktree of a source repo on a NEW scratch branch
 * under ~/.ashlr/sandboxes/<id>/, so autonomous edits NEVER touch the user's
 * working tree, index, HEAD, or their checked-out branch. The worktree is
 * created, used, then discarded (git worktree remove + scratch-branch delete).
 *
 * ISOLATION + DESTRUCTIVE-SAFETY (the whole point):
 *  - Sandbox worktrees live ONLY under ~/.ashlr/sandboxes/.
 *  - Creating/removing them MUST NOT modify the source repo's working tree,
 *    index, HEAD, or the user's branches.
 *  - `git worktree add -b <branch> <path> <baseHead>` off the current HEAD;
 *    `git worktree remove --force` + `git branch -D` on cleanup.
 *  - NEVER `git reset --hard` / `git checkout` in the source repo. NEVER push.
 *    NEVER delete user branches. NEVER touch a repo that is not ENROLLED
 *    (except via the explicit allowAnyRepo test hatch on a tmp repo).
 *  - Every mutating op (and every refused/errored attempt) is audited.
 *  - All git invoked via node:child_process arg ARRAYS (execFile, no shell).
 *  - No new runtime deps; node builtins only.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Sandbox, SandboxDiff } from '../types.js';
import { isRepo } from '../git.js';
import { assertMayMutate } from './policy.js';
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 30_000; // ms — generous; worktree add can touch many files
const BRANCH_PREFIX = 'ashlr/sandbox/';
const META_FILE = 'sandbox.json';

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/** Absolute path to the sandboxes root: ~/.ashlr/sandboxes. Created lazily. */
export function sandboxesDir(): string {
  return join(homedir(), '.ashlr', 'sandboxes');
}

/** Directory holding one sandbox's worktree + metadata. */
function sandboxHome(id: string): string {
  return join(sandboxesDir(), id);
}

/** Path to a sandbox's persisted metadata file. */
function metaPath(id: string): string {
  return join(sandboxHome(id), META_FILE);
}

/** Path to the isolated worktree checkout for a sandbox. */
function worktreePathFor(id: string): string {
  return join(sandboxHome(id), 'worktree');
}

// ---------------------------------------------------------------------------
// git helper — execFile arg arrays, no shell
// ---------------------------------------------------------------------------

/**
 * Run a git command inside `cwd`. Throws on failure (callers decide whether
 * to tolerate). Always uses an arg array — never a shell string.
 */
function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

/** Run a git command, returning null on any error (never throws). */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return gitRun(cwd, args);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metadata persistence
// ---------------------------------------------------------------------------

function writeMeta(sb: Sandbox): void {
  const home = sandboxHome(sb.id);
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }
  writeFileSync(metaPath(sb.id), JSON.stringify(sb, null, 2) + '\n', 'utf8');
}

/** Read + validate one sandbox's metadata. Returns null on missing/malformed. */
function readMeta(id: string): Sandbox | null {
  const p = metaPath(id);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const o = parsed as Record<string, unknown>;
      if (
        typeof o['id'] === 'string' &&
        typeof o['sourceRepo'] === 'string' &&
        typeof o['worktreePath'] === 'string' &&
        typeof o['branch'] === 'string' &&
        typeof o['baseHead'] === 'string' &&
        typeof o['createdAt'] === 'string'
      ) {
        return {
          id: o['id'],
          sourceRepo: o['sourceRepo'],
          worktreePath: o['worktreePath'],
          branch: o['branch'],
          baseHead: o['baseHead'],
          createdAt: o['createdAt'],
        };
      }
    }
  } catch {
    // malformed — treat as absent
  }
  return null;
}

// ---------------------------------------------------------------------------
// createSandbox
// ---------------------------------------------------------------------------

/**
 * Create an isolated git-worktree sandbox of `sourceRepo` on a NEW scratch
 * branch under ~/.ashlr/sandboxes/<id>/.
 *
 * FIRST calls assertMayMutate(sourceRepo, opts) — refuses (throws + audits
 * result:'refused') if the kill switch is on OR the repo is not enrolled and
 * opts.allowAnyRepo is not set. Verifies sourceRepo is a git repo. Reads the
 * source HEAD WITHOUT mutating it. Adds the worktree via
 * `git worktree add -b <branch> <path> <baseHead>` run in sourceRepo — this
 * MUST NOT modify the source working tree, index, HEAD, or any user branch.
 */
export function createSandbox(
  sourceRepo: string,
  opts?: { allowAnyRepo?: boolean },
): Sandbox {
  // Gate FIRST — kill switch / enrollment. Audit refusals.
  try {
    assertMayMutate(sourceRepo, opts);
  } catch (err) {
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'refused by policy gate',
      result: 'refused',
    });
    throw err;
  }

  // Must be a real git repo.
  if (!isRepo(sourceRepo)) {
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'sourceRepo is not a git repository',
      result: 'error',
    });
    throw new Error(`not a git repository: ${sourceRepo}`);
  }

  // Read the source HEAD commit WITHOUT mutating it.
  const baseHead = gitTry(sourceRepo, ['rev-parse', 'HEAD']);
  if (!baseHead) {
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'could not resolve source HEAD',
      result: 'error',
    });
    throw new Error(`could not resolve HEAD in repo: ${sourceRepo}`);
  }

  // Generate a unique id; the scratch branch contains it.
  const id = randomBytes(6).toString('hex');
  const branch = `${BRANCH_PREFIX}${id}`;
  const worktreePath = worktreePathFor(id);

  // Ensure the per-sandbox home exists (parent of the worktree). The worktree
  // dir itself must NOT pre-exist — git worktree add creates it.
  const home = sandboxHome(id);
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
  }

  // Add the isolated worktree on a NEW scratch branch off baseHead, run IN the
  // source repo. This does NOT touch the source working tree, index, HEAD, or
  // any user branch — it only creates a new ref + a separate checkout.
  try {
    gitRun(sourceRepo, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      baseHead,
    ]);
  } catch (err) {
    // Best-effort cleanup of the partially-created sandbox home, then audit.
    // A partial `worktree add` (ref created, then checkout failed) can leave an
    // orphan scratch branch and/or a dangling worktree registration in the
    // SOURCE repo. Both are namespaced/harmless, but the sandbox invariant is
    // "created, used, then discarded — bounded", so we prune them defensively.
    // Guarded by the BRANCH_PREFIX assertion so we can NEVER `branch -D` a user
    // branch even if `branch` were somehow corrupted.
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    gitTry(sourceRepo, ['worktree', 'prune']);
    if (branch.startsWith(BRANCH_PREFIX)) {
      gitTry(sourceRepo, ['branch', '-D', branch]);
    }
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: id,
      summary: 'git worktree add failed',
      result: 'error',
    });
    throw err instanceof Error ? err : new Error(String(err));
  }

  const sb: Sandbox = {
    id,
    sourceRepo,
    worktreePath,
    branch,
    baseHead,
    createdAt: new Date().toISOString(),
  };

  writeMeta(sb);

  audit({
    action: 'sandbox:create',
    repo: sourceRepo,
    sandboxId: id,
    summary: `worktree on ${branch} @ ${baseHead.slice(0, 8)}`,
    result: 'ok',
  });

  return sb;
}

// ---------------------------------------------------------------------------
// sandboxDiff
// ---------------------------------------------------------------------------

/**
 * Capture the git diff of the sandbox worktree vs its base HEAD. Read-only —
 * never mutates the worktree or the source repo. Counts come from --numstat;
 * the unified patch from a plain `git diff <baseHead>` inside the worktree.
 */
export function sandboxDiff(sb: Sandbox): SandboxDiff {
  const cwd = sb.worktreePath;

  // Stage everything (including UNTRACKED new files) against the worktree's OWN
  // index so plain `git diff` captures new files too. `git diff` ignores
  // untracked files by design, and the autonomous write path writes files
  // without `git add`/`commit` — so without this, brand-new files an autonomous
  // run creates would be silently omitted from the captured proposal diff and
  // then DESTROYED by removeSandbox's `worktree remove --force`. Staging in the
  // SANDBOX worktree is safe: it touches only the worktree's index, never the
  // source repo's index/working-tree/HEAD (the worktree has its own index).
  // `add -A` records adds/mods/deletes; we then diff the index vs baseHead.
  gitTry(cwd, ['add', '-A']);

  // numstat: one line per file "<ins>\t<del>\t<path>" (binary => "-\t-\t..").
  // `--staged` diffs the index (now including new files) against baseHead.
  const numstat = gitTry(cwd, ['diff', '--staged', '--numstat', sb.baseHead]) ?? '';
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    const ins = parseInt(parts[0] ?? '0', 10);
    const del = parseInt(parts[1] ?? '0', 10);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
  }

  // Full unified patch — staged vs baseHead so new files are included.
  const patch = gitTry(cwd, ['diff', '--staged', sb.baseHead]) ?? '';

  return {
    sandboxId: sb.id,
    files,
    insertions,
    deletions,
    patch,
  };
}

// ---------------------------------------------------------------------------
// removeSandbox
// ---------------------------------------------------------------------------

/**
 * Remove a sandbox: `git worktree remove --force` then delete the scratch
 * branch (`git branch -D`), both run against the source repo; then clean up
 * persisted metadata. MUST NOT touch the source working tree/index/HEAD/user
 * branches. Idempotent — tolerates an already-removed worktree, never throws
 * on a missing dir.
 */
export function removeSandbox(sb: Sandbox): void {
  const home = sandboxHome(sb.id);

  // ---- Defense-in-depth: NEVER trust on-disk metadata to drive a destructive
  // git op. Metadata can be tampered/corrupted/future-format, so before ANY
  // mutating git call we (a) re-derive the safe branch + worktree path from the
  // sandbox id, (b) require the stored values to match those safe values, and
  // (c) require the branch to be inside our namespace and the worktree path to
  // be contained under sandboxesDir(). A trip on any guard refuses the git ops
  // (audited result:'refused') and falls through to local-dir cleanup only —
  // we still rmSync the sandbox home, but we NEVER run `branch -D` / `worktree
  // remove` against an arbitrary branch/path in an arbitrary repo.
  const safeBranch = `${BRANCH_PREFIX}${sb.id}`;
  const safeWorktree = worktreePathFor(sb.id);
  const sandboxesRoot = sandboxesDir() + sep;

  const branchInNamespace = sb.branch.startsWith(BRANCH_PREFIX);
  const branchMatches = sb.branch === safeBranch;
  const worktreeContained =
    resolve(sb.worktreePath).startsWith(sandboxesRoot) &&
    resolve(sb.worktreePath) === resolve(safeWorktree);

  const guardsPass = branchInNamespace && branchMatches && worktreeContained;

  if (!guardsPass) {
    audit({
      action: 'sandbox:remove',
      repo: sb.sourceRepo,
      sandboxId: sb.id,
      summary:
        'refused git cleanup: metadata failed branch-prefix/containment guard',
      result: 'refused',
    });
  }

  // 1. Remove the worktree registration from the source repo (best-effort).
  //    --force handles a dirty / committed-in worktree. Only attempted when the
  //    source repo still exists as a git repo AND the guards passed. We target
  //    the RE-DERIVED safe values, not the raw metadata.
  if (guardsPass && isRepo(sb.sourceRepo)) {
    // `git worktree remove` also deletes the worktree directory. If the dir is
    // already gone, prune first so git's bookkeeping is consistent, then ignore.
    gitTry(sb.sourceRepo, ['worktree', 'remove', '--force', safeWorktree]);
    gitTry(sb.sourceRepo, ['worktree', 'prune']);

    // 2. Delete the scratch branch (a sandbox-only ref — never a user branch).
    //    safeBranch is guaranteed to start with BRANCH_PREFIX.
    gitTry(sb.sourceRepo, ['branch', '-D', safeBranch]);
  }

  // 3. Clean up the per-sandbox home (worktree leftovers + metadata).
  //    rmSync with force never throws on a missing path.
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // already gone / unremovable — idempotent cleanup, never throw
  }

  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: guardsPass
      ? `removed worktree + branch ${safeBranch}`
      : `local cleanup only (git ops refused) for ${sb.id}`,
    result: 'ok',
  });
}

// ---------------------------------------------------------------------------
// listSandboxes
// ---------------------------------------------------------------------------

/**
 * Enumerate persisted sandbox metadata under sandboxesDir(). Returns [] when
 * none. Never throws on a malformed/partial entry (skips it).
 */
export function listSandboxes(): Sandbox[] {
  const dir = sandboxesDir();
  if (!existsSync(dir)) return [];

  let ids: string[];
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: Sandbox[] = [];
  for (const id of ids) {
    const sb = readMeta(id);
    if (sb) out.push(sb);
  }
  return out;
}

// ---------------------------------------------------------------------------
// sweepOrphanSandboxes (H2 — crash-recovery, LOCAL-ONLY)
// ---------------------------------------------------------------------------

/**
 * Sweep ORPHANED sandboxes on restart (H2 crash-recovery). A swarm creates a
 * worktree, uses it, then `removeSandbox`es it — all within a single in-memory
 * `runSwarm` call. The sandbox lifetime is NOT persisted on the SwarmRun (there
 * is no `sandboxId` field on a SwarmRun; the only `sandboxId` references are
 * audit-log entries), so a process killed AFTER `git worktree add` but BEFORE
 * `removeSandbox` leaves a worktree on disk under ~/.ashlr/sandboxes/<id>/ with
 * no record linking it back to any swarm. Such a leftover would otherwise
 * accumulate forever.
 *
 * LIVENESS CAVEAT (important — read before wiring a caller): a persisted sandbox
 * is NOT necessarily an orphan. A `runSwarm` keeps its sandbox metadata on disk
 * for the WHOLE run (createSandbox writes it at start, removeSandbox deletes it
 * at the end), and the daemon runs several sandboxed swarms CONCURRENTLY, each
 * with a live on-disk sandbox; a separately-launched `ashlr swarm` in another
 * process is also possible (the re-entrancy guards are per-process). The Sandbox
 * record carries no pid/owner/lock — only `createdAt` — so the sweep cannot
 * positively distinguish a true orphan from an actively-running sandbox. To stay
 * safe for any future restart wire-up, the sweep accepts an OPTIONAL `staleMs`
 * guard: when provided, a sandbox whose `createdAt` is younger than `staleMs` is
 * SKIPPED (assumed possibly-live), so only sandboxes older than a conservative
 * threshold (e.g. > the max swarm wall-clock) are reclaimed. With NO `staleMs`
 * (the default, used by the recovery PROOF tests where every sandbox is a
 * deliberately-dropped orphan) it sweeps every listed sandbox.
 *
 * This sweep composes the two EXISTING safe primitives — `listSandboxes()` to
 * enumerate persisted sandbox metadata, then `removeSandbox()` for each — so it
 * inherits all of removeSandbox's containment guards verbatim: it only ever runs
 * `git worktree remove` / `git branch -D` against a path RE-DERIVED to live under
 * `sandboxesDir()` and a branch RE-DERIVED into the `ashlr/sandbox/<id>` namespace
 * (a metadata mismatch falls through to LOCAL dir cleanup only — never a git op on
 * an arbitrary branch/path). It therefore can NEVER touch a user's working tree,
 * index, HEAD, or any user branch.
 *
 * LOCAL-ONLY by construction: it adds NO outward capability (cleanup is purely
 * inward — it removes only ashlr/sandbox/* worktrees + scratch refs, pushes
 * nothing, opens no PR, applies no proposal), weakens NO guard (every removal
 * goes through removeSandbox's full guard set), and changes NO happy-path
 * behavior (a clean run already removes its own sandbox, so a healthy install
 * has nothing to sweep). NOTE: this function has NO production caller — it is the
 * reclaim primitive only; H2 deliberately does NOT auto-run it on startup (the
 * safest default), so no live worktree is ever force-removed today. Idempotent
 * and never throws — a removal failure on one id is swallowed so the sweep always
 * makes maximal progress. Returns the ids it swept so a caller / test can assert
 * what was reclaimed.
 *
 * @param opts.staleMs Optional age guard (ms). Skip any sandbox whose `createdAt`
 *   is younger than this — a conservative liveness proxy so a concurrently-live
 *   sandbox is never force-removed. Omit to sweep all listed sandboxes.
 */
export function sweepOrphanSandboxes(opts?: { staleMs?: number }): string[] {
  const staleMs = opts?.staleMs;
  const now = Date.now();
  const swept: string[] = [];
  for (const sb of listSandboxes()) {
    if (staleMs !== undefined) {
      const createdMs = Date.parse(sb.createdAt);
      // Skip not-yet-stale sandboxes (possibly a live owner). An unparseable
      // createdAt is treated as stale=0 (Number.isNaN) so a corrupt timestamp is
      // still reclaimable rather than stranded forever.
      if (!Number.isNaN(createdMs) && now - createdMs < staleMs) {
        continue;
      }
    }
    try {
      removeSandbox(sb);
      swept.push(sb.id);
    } catch {
      // removeSandbox is already best-effort/idempotent and should not throw;
      // guard anyway so one bad entry never aborts the whole restart sweep.
    }
  }
  return swept;
}
