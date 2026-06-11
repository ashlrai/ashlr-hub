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
// H5 — bounded sandbox lifecycle (LOCAL-ONLY resource guards)
// ---------------------------------------------------------------------------

/**
 * H5 CHANGE 4 — hard cap on concurrent on-disk sandboxes. Conservative default:
 * the daemon caps swarm concurrency at 8 (loop.ts) + runner MAX_PARALLEL=8, so
 * 16 leaves ~2x headroom for concurrent daemon swarms + a manual `ashlr swarm`
 * + transient overlap, while still bounding unbounded accumulation. createSandbox
 * sweeps STALE orphans first, then REFUSES (clean audited error) if still over.
 *
 * CONFIGURABLE: an operator (or a deterministic test) may override the default
 * via ASHLR_MAX_SANDBOXES (a positive integer). Resolved at CALL TIME — like the
 * HOME-sensitive path helpers — so a test can set a small cap without restarting
 * the process. An absent/blank/invalid/non-positive value falls back to the
 * conservative default; the override can only ever SET a finite positive bound
 * (it can never disable the cap), keeping this a strictly LOCAL resource guard.
 */
const MAX_SANDBOXES_DEFAULT = 16;

/** Resolve the effective sandbox cap (env override, else conservative default). */
function maxSandboxes(): number {
  const raw = process.env.ASHLR_MAX_SANDBOXES;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    // Only a finite, positive integer override takes effect; anything else
    // (NaN, <=0, non-numeric) falls back to the safe default. The override can
    // never remove the bound — it can only set a different finite positive one.
    if (Number.isInteger(n) && n > 0) return n;
  }
  return MAX_SANDBOXES_DEFAULT;
}

/**
 * H5 CHANGE 1 — orphan-sweep staleness threshold (ms). This is the FALLBACK
 * liveness proxy used ONLY for a sandbox that carries no usable `ownerPid`
 * marker (older metadata, or a crash fixture that models a GONE owner). The
 * PRIMARY liveness signal is the positive `ownerPid` marker (see Sandbox.ownerPid
 * + ownerAlive() below): a sandbox whose owner pid is still alive is skipped by
 * the sweep / disk-cap pre-sweep REGARDLESS of age, so a live in-flight worktree
 * is never reclaimed out from under a running swarm — even a cross-process one.
 *
 * Because there is NO hard wall-clock cap on a swarm (the runner bounds a swarm
 * by step count <= 200 and the token budget only — there is no elapsed-time
 * deadline), createdAt-age is NOT by itself a sound liveness proxy. So this
 * threshold is set FAR above any plausible 200-step run (6 hours) as a
 * belt-and-suspenders bound for the only residual gap: the rare pid-reuse case
 * where a crashed swarm's recorded pid was recycled by an unrelated live process
 * (ownerAlive() would then falsely read 'alive', so age must also have elapsed
 * before we'd ever reclaim). The cost of a too-LARGE value (a stale orphan
 * lingering a few hours longer) is far cheaper than the cost of a too-SMALL one
 * (force-removing a live worktree), so we err large. Shared by the daemon-start
 * sweep wiring (loop.ts) and the disk-cap pre-sweep below.
 *
 * CROSS-PROCESS LIVENESS LIMITATION (documented): the only way a live worktree
 * could still be reclaimed is if BOTH (a) its owner process crashed AND (b) the
 * OS recycled its exact pid for a new live process AND (c) >6h elapsed — a
 * vanishingly small window that, even if hit, only reclaims a worktree whose
 * original owner is provably dead.
 */
export const ORPHAN_STALE_MS = 6 * 60 * 60_000;

/**
 * Positive liveness check for a sandbox's recorded owner process. Returns true
 * ONLY when `ownerPid` is a positive integer AND `process.kill(ownerPid, 0)`
 * succeeds (the process exists and is signalable by us) — i.e. a swarm is
 * provably still running and holding this worktree. Any throw (ESRCH = gone,
 * EPERM = exists-but-not-ours, EINVAL, etc.) or an absent/invalid pid returns
 * false, falling back to the conservative createdAt-age staleMs guard. NEVER
 * throws and NEVER sends a real signal (signal 0 is error-check-only).
 */
function ownerAlive(sb: Sandbox): boolean {
  const pid = sb.ownerPid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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
        // ownerPid is OPTIONAL (back-compat): only carried through when it is a
        // positive integer; anything else (absent/malformed/<=0) is dropped so
        // ownerAlive() falls back to the createdAt-age guard for that sandbox.
        const rawPid = o['ownerPid'];
        const ownerPid =
          typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0
            ? rawPid
            : undefined;
        return {
          id: o['id'],
          sourceRepo: o['sourceRepo'],
          worktreePath: o['worktreePath'],
          branch: o['branch'],
          baseHead: o['baseHead'],
          createdAt: o['createdAt'],
          ...(ownerPid !== undefined ? { ownerPid } : {}),
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
  //
  // H5 CHANGE 3 (env-gate allowAnyRepo) EDIT SITE — integration applies the real
  // edit. The env-gate lives in assertMayMutate (policy.ts) as the single source
  // of truth: `opts.allowAnyRepo` is honored ONLY when ASHLR_TEST_ALLOW_ANY_REPO
  // ==='1' (mirrors advance.ts:156). createSandbox passes opts straight through,
  // so it inherits the gate transitively — NO separate env check is needed here.
  // The kill switch ALWAYS wins (assertMayMutate checks it first, unconditional).
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

  // -------------------------------------------------------------------------
  // H5 CHANGE 4 — DISK/COUNT CAP (LOCAL-ONLY resource guard). When the live
  // sandbox count is at/over the cap, FIRST sweep crash-leftover orphans (NEVER a
  // live one — sweepOrphanSandboxes skips any sandbox whose ownerPid is still
  // alive regardless of age, and falls back to the ORPHAN_STALE_MS age guard only
  // for ones with no live owner; so a same-process in-flight worktree held by a
  // concurrent daemon swarm is protected here), then re-count; if STILL at/over
  // the cap, REFUSE (audit result:'refused' + throw a
  // clean error) rather than accumulate unboundedly. This removes NOTHING in-use
  // and opens no outward capability — it only bounds on-disk worktree growth so a
  // pathological crash/restart loop can never fill the disk. The cap is resolved
  // at call time (env-overridable; conservative default) — see maxSandboxes().
  const cap = maxSandboxes();
  if (listSandboxes().length >= cap) {
    // Reclaim genuine crash leftovers first (stale-guarded — a live sandbox is
    // skipped). A healthy install with a transient burst self-heals here.
    sweepOrphanSandboxes({ staleMs: ORPHAN_STALE_MS });
    if (listSandboxes().length >= cap) {
      audit({
        action: 'sandbox:create',
        repo: sourceRepo,
        sandboxId: null,
        summary: `sandbox cap reached (MAX_SANDBOXES=${cap})`,
        result: 'refused',
      });
      throw new Error(`sandbox cap reached (MAX_SANDBOXES=${cap})`);
    }
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
    // H5 — stamp the OWNING process pid as a positive liveness marker so the
    // orphan sweep / disk-cap pre-sweep never force-remove this worktree while
    // this process (or any process holding the same pid) is still alive.
    ownerPid: process.pid,
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
 * LIVENESS (important — read before wiring a caller): a persisted sandbox is NOT
 * necessarily an orphan. A `runSwarm` keeps its sandbox metadata on disk for the
 * WHOLE run (createSandbox writes it at start, removeSandbox deletes it at the
 * end), and the daemon runs several sandboxed swarms CONCURRENTLY, each with a
 * live on-disk sandbox; a separately-launched `ashlr swarm` in another process is
 * also possible (the re-entrancy guards are per-process). To NEVER force-remove a
 * live worktree, the sweep uses TWO guards, in order:
 *
 *  1. POSITIVE liveness (primary, age-independent): a sandbox whose recorded
 *     `ownerPid` is still alive (ownerAlive()) is SKIPPED regardless of age — so
 *     a long-running swarm (same- OR cross-process) older than any staleMs is
 *     never reclaimed out from under its owner. This closes the central gap that
 *     createdAt-age alone could not (there is no wall-clock cap on a swarm).
 *  2. AGE fallback (secondary): for a sandbox with NO usable ownerPid (older
 *     metadata, or a crash fixture that models a GONE owner), the OPTIONAL
 *     `staleMs` guard applies — a sandbox whose `createdAt` is younger than
 *     `staleMs` is SKIPPED (conservatively assumed possibly-live). With NO
 *     `staleMs` (the default, used by recovery PROOF tests where every sandbox is
 *     a deliberately-dropped orphan with a dead/absent owner) it sweeps every
 *     listed sandbox not protected by guard 1.
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
 * has nothing to sweep). H5 wires this into daemon start (loop.ts, staleMs=
 * ORPHAN_STALE_MS), the disk-cap pre-sweep above, and `ashlr sandbox gc` — every
 * caller passes a staleMs and is additionally protected by the age-independent
 * ownerAlive() guard, so no LIVE worktree is ever force-removed. Idempotent
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
    // GUARD 1 — POSITIVE liveness (age-independent): never reclaim a worktree
    // whose owning process is still alive, even if it is older than staleMs.
    // This is what makes the sweep safe despite the absence of a swarm
    // wall-clock cap — a live in-flight worktree (any process, any age) is
    // protected by its still-alive owner pid.
    if (ownerAlive(sb)) {
      continue;
    }
    // GUARD 2 — AGE fallback for a sandbox with no usable ownerPid (owner gone
    // or older metadata).
    if (staleMs !== undefined) {
      const createdMs = Date.parse(sb.createdAt);
      // Skip not-yet-stale sandboxes (possibly a live owner whose pid we could
      // not read). An unparseable createdAt is treated as stale=0
      // (Number.isNaN) so a corrupt timestamp is still reclaimable rather than
      // stranded forever.
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

// ---------------------------------------------------------------------------
// sweepRepoSandboxes (H7 — scoped one-command rollback cleanup, LOCAL-ONLY)
// ---------------------------------------------------------------------------

/**
 * Reclaim the on-disk sandboxes belonging to ONE specific source repo — the
 * scoped cleanup behind `ashlr onboard --rollback <repo>` (H7 BUILD ITEM 4).
 *
 * WHY a distinct sweep (not sweepOrphanSandboxes): the generic orphan sweep is a
 * BACKGROUND restart heuristic — it protects a possibly-live owner whose pid is
 * unreadable by ALSO requiring `createdAt` to be older than `staleMs` (6h). But a
 * crash-leftover worktree from the VERY activation the user is now explicitly
 * undoing is, by definition, fresh (< 6h old), so the generic sweep would SKIP it
 * and the rollback would leave it on disk — contradicting "one-command undo of a
 * first activation". For an explicit, user-requested cleanup of a NAMED repo that
 * the user just unenrolled, the age heuristic is unwarranted.
 *
 * SAFETY (the real boundary is preserved): this drops ONLY the age guard, never
 * the LIVE-OWNER guard. It still SKIPS any sandbox whose recorded `ownerPid` is
 * still alive (ownerAlive()), so a running in-flight swarm's worktree is NEVER
 * force-removed — even a fresh one. It is SCOPED: only sandboxes whose
 * `sourceRepo` resolves to `resolve(repo)` are considered, so it never touches a
 * different repo's sandboxes. Each removal goes through removeSandbox(), so it
 * inherits the full branch-prefix / path-containment guards verbatim and can
 * NEVER touch a user's working tree, index, HEAD, or any user branch.
 *
 * LOCAL-ONLY by construction: adds NO outward capability (inward cleanup only —
 * removes only ashlr/sandbox/* worktrees + scratch refs), weakens NO guard.
 * Idempotent; never throws — a failure on one id is swallowed so the sweep makes
 * maximal progress. Returns the ids it reclaimed.
 *
 * @param repo The source repo whose sandboxes to reclaim (resolved internally).
 */
export function sweepRepoSandboxes(repo: string): string[] {
  const target = resolve(repo);
  const swept: string[] = [];
  for (const sb of listSandboxes()) {
    // SCOPE: only this repo's sandboxes.
    if (resolve(sb.sourceRepo) !== target) {
      continue;
    }
    // GUARD — POSITIVE liveness (the one guard we KEEP): never reclaim a
    // worktree whose owning process is still alive, regardless of age. A live
    // in-flight swarm (any age) is protected; the age guard is intentionally
    // dropped because this is an explicit user-requested cleanup of a just-
    // unenrolled repo, not a background restart heuristic.
    if (ownerAlive(sb)) {
      continue;
    }
    try {
      removeSandbox(sb);
      swept.push(sb.id);
    } catch {
      // removeSandbox is best-effort/idempotent; guard so one bad entry never
      // aborts the whole scoped sweep.
    }
  }
  return swept;
}
