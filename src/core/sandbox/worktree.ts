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

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  appendFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type {
  Sandbox,
  SandboxCleanupEvidence,
  SandboxCleanupFailureClass,
  SandboxCleanupPostcondition,
  SandboxCleanupResult,
  SandboxDiff,
  SandboxInventory,
  SandboxSweepResult,
} from '../types.js';
import { isRepo } from '../git.js';
import { assertMayMutate } from './policy.js';
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 30_000; // ms — generous; worktree add can touch many files
const BRANCH_PREFIX = 'ashlr/sandbox/';
const META_FILE = 'sandbox.json';
const CLEANUP_LOCK_WAIT_MS = 2_000;
const CLEANUP_LOCK_INIT_MS = 1_000;
const cleanupLockSleep = new Int32Array(new SharedArrayBuffer(4));

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
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
// M286: node_modules symlink for worktree verify environment
// ---------------------------------------------------------------------------

/**
 * Symlink the source repo's node_modules into the worktree so that verify
 * commands (typecheck/test) can resolve the local toolchain (tsc, vitest, etc.)
 * without a separate install.
 *
 * Rules (SAFETY — never throws, never mutates source repo):
 *  - Only attempted when sourceRepo/node_modules exists (real install present).
 *  - Only attempted when worktreePath/node_modules does NOT already exist (no
 *    clobber; a future install in the worktree would pre-empt the symlink).
 *  - node_modules is gitignored — the symlink is never staged or captured in
 *    the proposal diff (M283 layer 1 would need to exclude it, but gitignore
 *    handles it; layer 2 is not needed for an ignored path).
 *  - Any failure (EPERM, EXDEV, etc.) is swallowed — the worktree creation
 *    succeeds regardless; verify commands will fail gracefully if they still
 *    can't find the toolchain (safe fallback).
 */
function symlinkNodeModules(sourceRepo: string, worktreePath: string): void {
  try {
    const src = join(sourceRepo, 'node_modules');
    const dst = join(worktreePath, 'node_modules');
    if (!existsSync(src)) return; // source has no install — nothing to link
    if (existsSync(dst)) return;  // already present — don't clobber
    symlinkSync(src, dst, 'dir');

    // Register node_modules in the worktree's .git/info/exclude so that
    // `git add -A` (called by sandboxDiff) never stages the symlink. Without
    // this, git treats the symlink as a new tracked entry (mode 120000) and it
    // appears in the proposal diff — which is wrong and confusing for reviewers.
    //
    // The worktree's gitdir is NOT the source repo's .git — it has its own
    // .git FILE (a gitfile) pointing at the worktree's entry under the source
    // repo's .git/worktrees/<id>/. The info/exclude for a worktree lives at
    // <worktreePath>/.git (which is a FILE, not a dir, for a worktree) and
    // git resolves info/exclude via the gitdir. We resolve it by reading the
    // .git file to find the actual gitdir, then appending to info/exclude there.
    // Best-effort: any failure is silently suppressed (sandboxDiff layer 2 is
    // an independent fallback via SANDBOX_INFRA_FILES).
    try {
      // The worktree's .git is a FILE containing "gitdir: <path>"
      const gitFile = join(worktreePath, '.git');
      if (!existsSync(gitFile)) return;
      const raw = readFileSync(gitFile, 'utf8').trim();
      const prefix = 'gitdir: ';
      if (!raw.startsWith(prefix)) return;
      const gitdir = raw.slice(prefix.length).trim();
      // gitdir is absolute or relative to the worktree
      const absGitdir = gitdir.startsWith('/') ? gitdir : join(worktreePath, gitdir);
      const excludeDir = join(absGitdir, 'info');
      const excludeFile = join(excludeDir, 'exclude');
      if (!existsSync(excludeDir)) mkdirSync(excludeDir, { recursive: true });
      // Append only if node_modules isn't already excluded there
      const existing = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
      if (!existing.includes('node_modules')) {
        appendFileSync(excludeFile, '\n# M286: fleet-symlinked node_modules — never stage\nnode_modules\n', 'utf8');
      }
    } catch {
      // info/exclude registration is best-effort; a failure here does NOT
      // break the worktree — sandboxDiff's layer-2 pathspec exclusion handles it.
    }
  } catch {
    // Graceful fallback: symlink failure (cross-device, permissions, etc.)
    // must never crash the sandbox creation. Verify may still fail if the
    // toolchain is absent, but that is a deterministic, audited failure — not
    // an infrastructure crash.
  }
}

// ---------------------------------------------------------------------------
// Metadata persistence
// ---------------------------------------------------------------------------

function writeMeta(sb: Sandbox): void {
  const home = sandboxHome(sb.id);
  const root = sandboxesDir();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  const expectedDirs = new Map<string, { dev: number; ino: number }>();
  for (const dir of [root, home]) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      throw new Error('unsafe sandbox metadata directory');
    }
    chmodSync(dir, 0o700);
    expectedDirs.set(dir, { dev: stat.dev, ino: stat.ino });
  }
  const target = metaPath(sb.id);
  if (existsSync(target)) {
    const current = lstatSync(target);
    if (current.isSymbolicLink() || !current.isFile() ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid())) {
      throw new Error('unsafe sandbox metadata file');
    }
  }
  const temp = join(home, `.sandbox.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const bytes = Buffer.from(JSON.stringify(sb, null, 2) + '\n', 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short sandbox metadata write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (const dir of [root, home]) {
      const expected = expectedDirs.get(dir)!;
      const current = lstatSync(dir);
      if (current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error('sandbox metadata directory changed during write');
      }
    }
    renameSync(temp, target);
    const persisted = lstatSync(target);
    if (persisted.isSymbolicLink() || !persisted.isFile()) throw new Error('invalid sandbox metadata replacement');
    chmodSync(target, 0o600);
    let dirFd: number | undefined;
    try {
      dirFd = openSync(home, fsConstants.O_RDONLY);
      fsyncSync(dirFd);
    } catch {
      // Some platforms/filesystems do not support fsync on directories. The
      // atomically renamed, fsynced file remains valid; directory durability is
      // a best-effort power-loss enhancement, not a sandbox availability gate.
    } finally {
      if (dirFd !== undefined) { try { closeSync(dirFd); } catch { /* best effort */ } }
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function rollbackUnpersistedSandbox(sb: Sandbox): void {
  const safeBranch = `${BRANCH_PREFIX}${sb.id}`;
  const safeWorktree = worktreePathFor(sb.id);
  if (sb.branch !== safeBranch || resolve(sb.worktreePath) !== resolve(safeWorktree) || !isRepo(sb.sourceRepo)) return;
  gitTry(sb.sourceRepo, ['worktree', 'remove', '--force', safeWorktree]);
  gitTry(sb.sourceRepo, ['worktree', 'prune']);
  gitTry(sb.sourceRepo, ['branch', '-D', safeBranch]);
  const registration = registrationState(sb.sourceRepo, safeWorktree);
  const branch = branchState(sb.sourceRepo, safeBranch);
  if (registration === 'absent' && branch === 'absent') {
    try { rmSync(sandboxHome(sb.id), { recursive: true, force: true }); } catch { /* surfaced by inventory */ }
  }
  const home = sandboxHomeState(sandboxHome(sb.id));
  const complete = registration === 'absent' && branch === 'absent' && home === 'absent';
  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: `creation rollback registration=${registration} branch=${branch} home=${home}`,
    result: complete ? 'ok' : 'error',
  });
}

function parseCleanupEvidence(value: unknown): SandboxCleanupEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const p = o['postconditions'];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const post = p as Record<string, unknown>;
  const states = new Set<SandboxCleanupPostcondition>(['absent', 'present', 'unknown', 'unsafe']);
  const failures = new Set<SandboxCleanupFailureClass>([
    'cleanup-locked', 'unsafe-metadata', 'source-repo-unavailable', 'worktree-remaining',
    'branch-remaining', 'postcondition-unavailable', 'home-remove-failed',
  ]);
  if (
    o['schemaVersion'] !== 1 ||
    typeof o['attemptedAt'] !== 'string' ||
    o['attemptedAt'].length > 32 ||
    Number.isNaN(Date.parse(o['attemptedAt'])) ||
    typeof o['attempt'] !== 'number' ||
    !Number.isInteger(o['attempt']) ||
    o['attempt'] < 1 ||
    o['attempt'] > 1_000 ||
    (o['status'] !== 'residual' && o['status'] !== 'refused' && o['status'] !== 'unavailable') ||
    typeof o['retryable'] !== 'boolean' ||
    !Array.isArray(o['failureClasses']) ||
    !o['failureClasses'].every((v) => failures.has(v as SandboxCleanupFailureClass)) ||
    !states.has(post['registration'] as SandboxCleanupPostcondition) ||
    !states.has(post['branch'] as SandboxCleanupPostcondition) ||
    !states.has(post['home'] as SandboxCleanupPostcondition)
  ) return undefined;
  return {
    schemaVersion: 1,
    attemptedAt: o['attemptedAt'],
    attempt: o['attempt'],
    status: o['status'],
    postconditions: {
      registration: post['registration'] as SandboxCleanupPostcondition,
      branch: post['branch'] as SandboxCleanupPostcondition,
      home: post['home'] as SandboxCleanupPostcondition,
    },
    failureClasses: [...new Set(o['failureClasses'] as SandboxCleanupFailureClass[])].slice(0, 8),
    retryable: o['retryable'],
  };
}

/** Read + validate one sandbox's metadata. Returns null on missing/malformed. */
function readMeta(id: string): Sandbox | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return null;
  const p = metaPath(id);
  if (!existsSync(p)) return null;
  let fd: number | undefined;
  try {
    const before = lstatSync(p);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 64 * 1024 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) return null;
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const o = parsed as Record<string, unknown>;
      if (
        typeof o['id'] === 'string' &&
        o['id'] === id &&
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
        const cleanup = parseCleanupEvidence(o['cleanup']);
        return {
          id: o['id'],
          sourceRepo: o['sourceRepo'],
          worktreePath: o['worktreePath'],
          branch: o['branch'],
          baseHead: o['baseHead'],
          createdAt: o['createdAt'],
          ...(ownerPid !== undefined ? { ownerPid } : {}),
          ...(cleanup ? { cleanup } : {}),
        };
      }
    }
  } catch {
    // malformed — treat as absent
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
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
  const creationLock = acquireCleanupLock('creation');
  if (!creationLock) throw new Error('sandbox creation lock unavailable');
  let id: string;
  let branch: string;
  let worktreePath: string;
  let home: string;
  try {
    const cap = maxSandboxes();
    if (sandboxInventory().totalHomes >= cap) {
      sweepOrphanSandboxes({ staleMs: ORPHAN_STALE_MS });
      if (sandboxInventory().totalHomes >= cap) {
        audit({
          action: 'sandbox:create', repo: sourceRepo, sandboxId: null,
          summary: `sandbox cap reached (MAX_SANDBOXES=${cap})`, result: 'refused',
        });
        throw new Error(`sandbox cap reached (MAX_SANDBOXES=${cap})`);
      }
    }

    // Reserve the home while holding the cross-process lock. Inventory counts
    // the reservation immediately, so another creator cannot pass the same cap.
    id = randomBytes(6).toString('hex');
    branch = `${BRANCH_PREFIX}${id}`;
    worktreePath = worktreePathFor(id);
    home = sandboxHome(id);
    mkdirSync(home, { recursive: false, mode: 0o700 });
  } finally {
    releaseCleanupLock(creationLock);
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
    // A partial add can leave either registration or branch behind. The same
    // narrowly scoped rollback used for metadata failures verifies all three
    // postconditions and retains a malformed home if operator recovery is needed.
    rollbackUnpersistedSandbox({
      id, sourceRepo, worktreePath, branch, baseHead,
      createdAt: new Date().toISOString(), ownerPid: process.pid,
    });
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: id,
      summary: 'git worktree add failed',
      result: 'error',
    });
    throw err instanceof Error ? err : new Error(String(err));
  }

  // M286 — symlink source node_modules into the worktree so verify commands
  // (npm run typecheck, npm run test) can resolve the local toolchain without
  // a separate install. Graceful: never throws; never mutates source repo.
  symlinkNodeModules(sourceRepo, worktreePath);

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

  try {
    writeMeta(sb);
  } catch (err) {
    rollbackUnpersistedSandbox(sb);
    throw err;
  }

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

// ---------------------------------------------------------------------------
// M283: sandbox-infra files written by the fleet that must never appear in a
// proposal diff. These files are injected by ashlr for agent tool access and
// are meaningless to the judge/reviewer. Each entry is an exact filename
// relative to the worktree root (no glob, no path prefix).
//
// Why two layers?
//   Layer 1 (writeMcpConfigIfAvailable): registers each file in the worktree's
//     `.git/info/exclude` BEFORE the agent runs, so `git add -A` never stages it.
//   Layer 2 (here): pass `:(exclude)<file>` pathspecs to `git diff --staged` so
//     even if layer 1 failed (e.g. gitdir not writable) the file is still absent
//     from the captured patch and numstat. Belt-and-suspenders: either layer alone
//     is sufficient; both together make the guarantee unconditional.
//
// IMPORTANT: these exclusions apply ONLY to fleet-written files (ones that did not
// exist in the source repo before the run). A repo that already has its own
// `.mcp.json` is a legacy fleet-infra filename, while `.ashlr-fleet.mcp.json`
// is the current sidecar. If a repo has a legitimate tracked file with either
// name, the baseHead check below allows that edit through; otherwise new
// fleet-written infra is suppressed from the proposal diff.
// ---------------------------------------------------------------------------
const SANDBOX_INFRA_FILES = ['.mcp.json', '.ashlr-fleet.mcp.json', 'node_modules'] as const;

/**
 * Capture the git diff of the sandbox worktree vs its base HEAD. Read-only —
 * never mutates the worktree or the source repo. Counts come from --numstat;
 * the unified patch from a plain `git diff <baseHead>` inside the worktree.
 *
 * M283: fleet-written sandbox-infra files (SANDBOX_INFRA_FILES) are excluded
 * from the diff. See the constant above for the two-layer exclusion strategy.
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

  // M283 LAYER 2: build :(exclude) pathspecs for fleet-infra files that were NOT
  // present in the base commit. If the file existed at baseHead (the agent has a
  // legitimate edit), we allow it through; only fleet-written (new) files are
  // suppressed. `git cat-file -e <baseHead>:<file>` exits 0 iff the blob exists.
  const infraExcludeSpecs: string[] = [];
  for (const infraFile of SANDBOX_INFRA_FILES) {
    try {
      execFileSync('git', ['cat-file', '-e', `${sb.baseHead}:${infraFile}`], {
        cwd,
        stdio: 'ignore',
        timeout: 5_000,
      });
      // Exit 0 → file exists at baseHead → agent may legitimately edit it → do NOT exclude.
    } catch {
      // Non-zero exit → file did NOT exist at baseHead → fleet-written → exclude from diff.
      infraExcludeSpecs.push(`:(exclude)${infraFile}`);
    }
  }

  // numstat: one line per file "<ins>\t<del>\t<path>" (binary => "-\t-\t..").
  // `--staged` diffs the index (now including new files) against baseHead.
  // M283: append :(exclude) pathspecs after '--' to suppress fleet-infra files.
  const numstatArgs = ['diff', '--staged', '--numstat', sb.baseHead];
  if (infraExcludeSpecs.length > 0) numstatArgs.push('--', ...infraExcludeSpecs);
  const numstat = gitTry(cwd, numstatArgs) ?? '';
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
  // M283: append :(exclude) pathspecs after '--' to suppress fleet-infra files.
  const patchArgs = ['diff', '--staged', sb.baseHead];
  if (infraExcludeSpecs.length > 0) patchArgs.push('--', ...infraExcludeSpecs);
  const patch = gitTry(cwd, patchArgs) ?? '';

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
function sandboxHomeState(home: string): SandboxCleanupPostcondition {
  if (!existsSync(home)) return 'absent';
  try {
    const stat = lstatSync(home);
    return stat.isSymbolicLink() || !stat.isDirectory() ? 'unsafe' : 'present';
  } catch {
    return 'unknown';
  }
}

function registrationState(repo: string, worktreePath: string): SandboxCleanupPostcondition {
  const raw = gitTry(repo, ['worktree', 'list', '--porcelain']);
  if (raw === null) return 'unknown';
  const registered = raw.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => resolve(line.slice('worktree '.length)))
    .includes(resolve(worktreePath));
  return registered ? 'present' : 'absent';
}

function branchState(repo: string, branch: string): SandboxCleanupPostcondition {
  try {
    gitRun(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return 'present';
  } catch (error) {
    return (error as { status?: unknown }).status === 1 ? 'absent' : 'unknown';
  }
}

function worktreeBelongsToRepo(repo: string, worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const worktreeCommon = gitTry(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repoCommon = gitTry(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return worktreeCommon !== null && repoCommon !== null && resolve(worktreeCommon) === resolve(repoCommon);
}

function processStartRef(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 1_024,
    });
    const value = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return value && value.length <= 128 ? createHash('sha256').update(value).digest('hex') : undefined;
  } catch { return undefined; }
}

let ownStartRef: string | undefined;
function currentStartRef(): string | undefined {
  ownStartRef ??= processStartRef(process.pid) ?? createHash('sha256')
    .update(`${process.pid}:${Date.now() - performance.now()}`)
    .digest('hex');
  return ownStartRef;
}

function safelyUnlinkLock(path: string, expected: { dev: number; ino: number }): boolean {
  try {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile() ||
      current.dev !== expected.dev || current.ino !== expected.ino ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid())) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function cleanupLockOwnerState(
  path: string,
  expected: { dev: number; ino: number },
): 'alive' | 'dead' | 'unknown' {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size < 1 || opened.size > 160) {
      return 'unknown';
    }
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return 'unknown';
    const owner = JSON.parse(bytes.toString('utf8')) as { pid?: unknown; startRef?: unknown };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1 ||
      typeof owner.startRef !== 'string' || !/^[a-f0-9]{64}$/.test(owner.startRef)) return 'unknown';
    const pid = Number(owner.pid);
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive'; }
    const observed = pid === process.pid ? currentStartRef() : processStartRef(pid);
    if (observed && observed !== owner.startRef) {
      const confirmed = processStartRef(pid);
      if (confirmed && confirmed !== owner.startRef) return 'dead';
    }
    return 'alive';
  } catch { return 'unknown'; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function acquireCleanupLock(id: string): { fd: number; path: string } | null {
  const root = sandboxesDir();
  const dir = join(root, '.cleanup-locks');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const candidate of [root, dir]) {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
      chmodSync(candidate, 0o700);
    }
  } catch { return null; }
  const path = join(dir, `${id}.lock`);
  const deadline = performance.now() + CLEANUP_LOCK_WAIT_MS;
  let unknown: { dev: number; ino: number; seenAt: number } | undefined;
  let attempt = 0;
  while (true) {
    try {
      const fd = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const stat = fstatSync(fd);
      if (!stat.isFile()) { closeSync(fd); return null; }
      const startRef = currentStartRef();
      if (!startRef) { closeSync(fd); safelyUnlinkLock(path, stat); return null; }
      try {
        const owner = Buffer.from(`${JSON.stringify({ pid: process.pid, startRef })}\n`, 'utf8');
        if (writeSync(fd, owner) !== owner.length) throw new Error('short cleanup lock write');
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
      } catch {
        try { closeSync(fd); } catch { /* best effort */ }
        safelyUnlinkLock(path, stat);
        return null;
      }
      return { fd, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        const state = cleanupLockOwnerState(path, stat);
        const now = performance.now();
        if (state === 'dead') {
          if (!safelyUnlinkLock(path, stat)) return null;
          unknown = undefined;
          continue;
        }
        if (state === 'unknown') {
          if (!unknown || unknown.dev !== stat.dev || unknown.ino !== stat.ino) {
            unknown = { dev: stat.dev, ino: stat.ino, seenAt: now };
          }
          if (now - unknown.seenAt >= CLEANUP_LOCK_INIT_MS) {
            if (!safelyUnlinkLock(path, stat)) return null;
            unknown = undefined;
            continue;
          }
        } else {
          unknown = undefined;
        }
      } catch { /* pathname changed; retry within the monotonic deadline */ }
      if (performance.now() >= deadline) return null;
      const remaining = deadline - performance.now();
      Atomics.wait(cleanupLockSleep, 0, 0, Math.min(remaining, 10 + (attempt % 7) * 5));
      attempt += 1;
    }
  }
}

function releaseCleanupLock(lock: { fd: number; path: string } | null | undefined): void {
  if (!lock) return;
  let snapshot: { dev: number; ino: number } | undefined;
  try { const stat = fstatSync(lock.fd); snapshot = { dev: stat.dev, ino: stat.ino }; } catch { /* best effort */ }
  try { closeSync(lock.fd); } catch { /* best effort */ }
  if (snapshot) safelyUnlinkLock(lock.path, snapshot);
}

function persistCleanupEvidence(sb: Sandbox, evidence: SandboxCleanupEvidence): boolean {
  try {
    const canonical = readMeta(sb.id);
    if (!canonical || sandboxHomeState(sandboxHome(sb.id)) !== 'present') return false;
    const { ownerPid: _ownerPid, ...rest } = canonical;
    writeMeta({ ...rest, cleanup: evidence });
    return true;
  } catch {
    return false;
  }
}

export function removeSandbox(sb: Sandbox): SandboxCleanupResult {
  const home = sandboxHome(sb.id);
  const attempt = Math.min(1_000, (sb.cleanup?.attempt ?? 0) + 1);

  // ---- Defense-in-depth: NEVER trust on-disk metadata to drive a destructive
  // git op. Metadata can be tampered/corrupted/future-format, so before ANY
  // mutating git call we (a) re-derive the safe branch + worktree path from the
  // sandbox id, (b) require the stored values to match those safe values, and
  // (c) require the branch to be inside our namespace and the worktree path to
  // be contained under sandboxesDir(). A trip on any guard refuses the git ops
  // (audited result:'refused') and preserves the recovery home. We NEVER run
  // `branch -D` / `worktree remove` against an arbitrary branch/path/repo.
  const safeBranch = `${BRANCH_PREFIX}${sb.id}`;
  const safeWorktree = worktreePathFor(sb.id);
  const sandboxesRoot = sandboxesDir() + sep;

  const branchInNamespace = sb.branch.startsWith(BRANCH_PREFIX);
  const branchMatches = sb.branch === safeBranch;
  const worktreeContained =
    resolve(sb.worktreePath).startsWith(sandboxesRoot) &&
    resolve(sb.worktreePath) === resolve(safeWorktree);

  const rootState = sandboxHomeState(sandboxesDir());
  const homeBefore = sandboxHomeState(home);
  const canonical = homeBefore === 'present' ? readMeta(sb.id) : null;
  const canonicalMatches = (
    canonical !== null &&
    canonical.id === sb.id &&
    canonical.sourceRepo === sb.sourceRepo &&
    canonical.worktreePath === sb.worktreePath &&
    canonical.branch === sb.branch &&
    canonical.baseHead === sb.baseHead
  );
  const worktreeSymlink = (() => {
    try { return lstatSync(safeWorktree).isSymbolicLink(); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : true; }
  })();
  const sourceRepoAvailable = isRepo(sb.sourceRepo);
  const registrationBefore = sourceRepoAvailable ? registrationState(sb.sourceRepo, safeWorktree) : 'unknown';
  const branchBefore = sourceRepoAvailable ? branchState(sb.sourceRepo, safeBranch) : 'unknown';
  const repoAuthority = existsSync(safeWorktree)
    ? worktreeBelongsToRepo(sb.sourceRepo, safeWorktree)
    : registrationBefore === 'present';
  const guardsPass = branchInNamespace && branchMatches && worktreeContained &&
    rootState === 'present' && homeBefore === 'present' && canonicalMatches &&
    !worktreeSymlink && (!sourceRepoAvailable || repoAuthority);
  const lock = guardsPass ? acquireCleanupLock(sb.id) : undefined;
  let result: SandboxCleanupResult;

  if (homeBefore === 'absent' && branchInNamespace && branchMatches && worktreeContained &&
    rootState === 'present' && sourceRepoAvailable &&
    registrationBefore === 'absent' && branchBefore === 'absent') {
    result = {
      status: 'complete',
      postconditions: { registration: registrationBefore, branch: branchBefore, home: 'absent' },
      failureClasses: [],
      retryable: false,
      attempt,
      evidencePersisted: false,
    };
  } else if (!guardsPass) {
    result = {
      status: 'refused',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['unsafe-metadata'],
      retryable: false,
      attempt,
      evidencePersisted: false,
    };
  } else if (lock === null) {
    result = {
      status: 'unavailable',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['cleanup-locked'],
      retryable: true,
      attempt,
      evidencePersisted: false,
    };
  } else if (!sourceRepoAvailable) {
    result = {
      status: 'unavailable',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['source-repo-unavailable'],
      retryable: true,
      attempt,
      evidencePersisted: false,
    };
  } else {

  // 1. Remove the worktree registration from the source repo (best-effort).
  //    --force handles a dirty / committed-in worktree. Only attempted when the
  //    source repo still exists as a git repo AND the guards passed. We target
  //    the RE-DERIVED safe values, not the raw metadata.
    // `git worktree remove` also deletes the worktree directory. If the dir is
    // already gone, prune first so git's bookkeeping is consistent, then ignore.
    gitTry(sb.sourceRepo, ['worktree', 'remove', '--force', safeWorktree]);
    gitTry(sb.sourceRepo, ['worktree', 'prune']);

    // 2. Delete the scratch branch (a sandbox-only ref — never a user branch).
    //    safeBranch is guaranteed to start with BRANCH_PREFIX.
    gitTry(sb.sourceRepo, ['branch', '-D', safeBranch]);
    const registration = registrationState(sb.sourceRepo, safeWorktree);
    const branch = branchState(sb.sourceRepo, safeBranch);
    const failureClasses: SandboxCleanupFailureClass[] = [];
    if (registration === 'present') failureClasses.push('worktree-remaining');
    if (branch === 'present') failureClasses.push('branch-remaining');
    if (registration === 'unknown' || branch === 'unknown') failureClasses.push('postcondition-unavailable');

    if (registration === 'absent' && branch === 'absent') {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* verified below */ }
    }
    const homeAfter = sandboxHomeState(home);
    if (homeAfter !== 'absent') failureClasses.push('home-remove-failed');
    const complete = registration === 'absent' && branch === 'absent' && homeAfter === 'absent';
    const retryable = !complete && (registration !== 'absent' || existsSync(safeWorktree));
    result = {
      status: complete ? 'complete' : (registration === 'unknown' || branch === 'unknown' ? 'unavailable' : 'residual'),
      postconditions: { registration, branch, home: homeAfter },
      failureClasses: [...new Set(failureClasses)],
      retryable,
      attempt,
      evidencePersisted: false,
    };
  }

  if (
    result.status !== 'complete' &&
    !result.failureClasses.includes('cleanup-locked') &&
    !result.failureClasses.includes('unsafe-metadata')
  ) {
    const evidence: SandboxCleanupEvidence = {
      schemaVersion: 1,
      attemptedAt: new Date().toISOString(),
      attempt,
      status: result.status,
      postconditions: result.postconditions,
      failureClasses: result.failureClasses,
      retryable: result.retryable,
    };
    result.evidencePersisted = persistCleanupEvidence(sb, evidence);
  }

  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: result.status === 'complete'
      ? `removed worktree + branch ${safeBranch}; postconditions verified`
      : result.status === 'refused'
        ? 'refused git cleanup: metadata failed branch-prefix/containment guard'
        : `cleanup status=${result.status} failures=${result.failureClasses.join(',') || 'none'}`,
    result: result.status === 'complete' ? 'ok' : result.status === 'refused' ? 'refused' : 'error',
  });
  releaseCleanupLock(lock);
  return result;
}

export function sandboxInventory(): SandboxInventory {
  const root = sandboxesDir();
  const inventory: SandboxInventory = { totalHomes: 0, validHomes: 0, malformedHomes: 0, unsafeEntries: 0 };
  if (!existsSync(root)) return inventory;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === '.cleanup-locks') continue;
      if (entry.name.startsWith('.')) { inventory.unsafeEntries += 1; continue; }
      if (!entry.isDirectory()) { inventory.unsafeEntries += 1; continue; }
      inventory.totalHomes += 1;
      if (readMeta(entry.name)) inventory.validHomes += 1;
      else inventory.malformedHomes += 1;
    }
  } catch { inventory.unsafeEntries += 1; }
  return inventory;
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
 * and never throws — an unexpected removal exception is recorded so callers
 * cannot report a false-green sweep while cleanup continues for other ids.
 *
 * @param opts.staleMs Optional age guard (ms). Skip any sandbox whose `createdAt`
 *   is younger than this — a conservative liveness proxy so a concurrently-live
 *   sandbox is never force-removed. Omit to sweep all listed sandboxes.
 */
export function sweepOrphanSandboxesDetailed(opts?: { staleMs?: number }): SandboxSweepResult {
  const staleMs = opts?.staleMs;
  const now = Date.now();
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
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
      const cleanup = removeSandbox(sb);
      result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
    } catch {
      // removeSandbox is already best-effort/idempotent and should not throw;
      // guard anyway so one bad entry never aborts the whole restart sweep.
      result.unexpectedErrors.push(sb.id);
    }
  }
  return result;
}

export function sweepOrphanSandboxes(opts?: { staleMs?: number }): string[] {
  return sweepOrphanSandboxesDetailed(opts).completed;
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
 * Idempotent; never throws — unexpected failures are surfaced in the detailed
 * result while the sweep continues making progress on other ids.
 *
 * @param repo The source repo whose sandboxes to reclaim (resolved internally).
 */
export function sweepRepoSandboxesDetailed(repo: string): SandboxSweepResult {
  const target = resolve(repo);
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
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
      const cleanup = removeSandbox(sb);
      result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
    } catch {
      // removeSandbox is best-effort/idempotent; guard so one bad entry never
      // aborts the whole scoped sweep.
      result.unexpectedErrors.push(sb.id);
    }
  }
  return result;
}

export function sweepRepoSandboxes(repo: string): string[] {
  return sweepRepoSandboxesDetailed(repo).completed;
}
