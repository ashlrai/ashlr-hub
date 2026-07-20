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
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve, sep } from 'node:path';
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
import {
  assertMayMutate,
  canonicalFilesystemPathIdentity,
  killSwitchOn,
} from './policy.js';
import { audit } from './audit.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from './mutation-fence.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 30_000; // ms — generous; worktree add can touch many files
const BRANCH_PREFIX = 'ashlr/sandbox/';
const META_FILE = 'sandbox.json';
const CLEANUP_LOCK_WAIT_MS = 2_000;
const CLEANUP_LOCK_INIT_MS = 1_000;
const RESERVATION_RECOVERY_MIN_AGE_MS = 60_000;
const MAX_RESERVATION_RECOVERIES_PER_SWEEP = 16;
const SANDBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const META_TEMP_RE = /^\.sandbox\.json\.\d+\.[a-f0-9]{12}\.tmp$/;
const cleanupLockSleep = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cleanup may borrow authority only from an operation that already crossed the
 * policy gate while holding this exact fence. Supplying an invalid borrowed
 * token fails closed; it never falls back to recursively acquiring the lock.
 */
const sandboxCleanupAuthorityBrand: unique symbol = Symbol('sandbox-cleanup-authority');

export interface BorrowedSandboxCleanupAuthority {
  readonly outwardFence: OutwardMutationFence;
  readonly [sandboxCleanupAuthorityBrand]: true;
}

export interface SandboxCleanupAuthorityOptions {
  borrowedAuthority?: BorrowedSandboxCleanupAuthority | null;
  authorityWaitMs?: number;
}

interface SandboxCleanupAuthorityLease {
  fence: OutwardMutationFence | null;
  token: BorrowedSandboxCleanupAuthority | null;
  borrowed: boolean;
  allowed: boolean;
  reason?: 'authority-unavailable' | 'paused';
}

function mintSandboxCleanupAuthority(
  outwardFence: OutwardMutationFence | null | undefined,
): BorrowedSandboxCleanupAuthority | null {
  if (!outwardFence || !ownsOutwardMutationFence(outwardFence) || killSwitchOn()) return null;
  const authority: BorrowedSandboxCleanupAuthority = {
    outwardFence,
    [sandboxCleanupAuthorityBrand]: true,
  };
  return Object.freeze(authority);
}

/**
 * Borrow cleanup authority from an operation that has crossed its policy gate.
 * Mint immediately after that gate and retain the outward fence until cleanup
 * returns. KILL may be armed later while pause waits on the retained fence.
 */
export function borrowSandboxCleanupAuthority(
  outwardFence: OutwardMutationFence | null | undefined,
): BorrowedSandboxCleanupAuthority | null {
  return mintSandboxCleanupAuthority(outwardFence);
}

function acquireSandboxCleanupAuthority(
  opts?: SandboxCleanupAuthorityOptions,
): SandboxCleanupAuthorityLease {
  const borrowed = opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, 'borrowedAuthority');
  if (borrowed) {
    const token = opts?.borrowedAuthority ?? null;
    const fence = token?.outwardFence ?? null;
    const valid = token?.[sandboxCleanupAuthorityBrand] === true && ownsOutwardMutationFence(fence);
    return valid
      ? { fence, token, borrowed: true, allowed: true }
      : { fence, token: null, borrowed: true, allowed: false, reason: 'authority-unavailable' };
  }

  const fence = acquireOutwardMutationFence(opts?.authorityWaitMs);
  if (!ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'authority-unavailable' };
  }
  // KILL is installed before pause waits on the fence. Rechecking only after
  // acquisition ensures no cleanup can begin after pause reports quiescence.
  if (killSwitchOn()) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'paused' };
  }
  const token = mintSandboxCleanupAuthority(fence);
  if (!token) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'paused' };
  }
  return { fence, token, borrowed: false, allowed: true };
}

function releaseSandboxCleanupAuthority(lease: SandboxCleanupAuthorityLease): void {
  if (!lease.borrowed) releaseOutwardMutationFence(lease.fence);
}

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
function pidAlive(pid: unknown): boolean {
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

function ownerAlive(sb: Sandbox): boolean {
  return pidAlive(sb.ownerPid);
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

type SandboxGitRunFaultHookForTest = (
  cwd: string,
  args: readonly string[],
) => void;

let sandboxGitRunFaultHookForTest: SandboxGitRunFaultHookForTest | undefined;

export function _setSandboxGitRunFaultHookForTest(
  hook: SandboxGitRunFaultHookForTest | undefined,
): void {
  sandboxGitRunFaultHookForTest = hook;
}

/**
 * Run a git command inside `cwd`. Throws on failure (callers decide whether
 * to tolerate). Always uses an arg array — never a shell string.
 */
function gitRun(cwd: string, args: string[]): string {
  sandboxGitRunFaultHookForTest?.(cwd, [...args]);
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', args, {
    cwd,
    env,
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

interface PinnedWorktreeCreationResult {
  ok: boolean;
  cleanupComplete: boolean;
  error?: string;
  worktreeDev?: string;
  worktreeIno?: string;
}

const PINNED_GIT_SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const { lstatSync } = require('node:fs');

const [cwd, repositoryContext, sourceRepo, ...gitArgs] = process.argv.slice(1);
const gitEnv = { ...process.env };
if (gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS) {
  gitEnv.NODE_OPTIONS = gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
} else {
  delete gitEnv.NODE_OPTIONS;
}
delete gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
delete gitEnv.GIT_COMMON_DIR;
if (repositoryContext === 'pinned') {
  gitEnv.GIT_DIR = '.';
}

const destinationPin = gitEnv.ASHLR_PINNED_DESTINATION === '1' ? {
  parentPath: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_PATH,
  parentDev: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_DEV,
  parentIno: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_INO,
  homePath: gitEnv.ASHLR_PINNED_DESTINATION_HOME_PATH,
  homeDev: gitEnv.ASHLR_PINNED_DESTINATION_HOME_DEV,
  homeIno: gitEnv.ASHLR_PINNED_DESTINATION_HOME_INO,
  metadataPath: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_PATH,
  metadataDev: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_DEV,
  metadataIno: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_INO,
  worktreePath: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_PATH,
  worktreeDev: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_DEV,
  worktreeIno: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_INO,
  allowWorktreeAbsence: gitEnv.ASHLR_PINNED_DESTINATION_ALLOW_WORKTREE_ABSENCE === '1',
  requireWorktreeAbsence: gitEnv.ASHLR_PINNED_DESTINATION_REQUIRE_WORKTREE_ABSENCE === '1',
} : null;
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('ASHLR_PINNED_DESTINATION')) delete gitEnv[key];
}

let sent = false;
let stdout = '';
let stderr = '';
const maxCapture = 64 * 1024;
function send(result) {
  if (sent) return;
  sent = true;
  if (typeof process.send === 'function') process.send(result);
}
function capture(current, chunk) {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > maxCapture) {
    send({ status: null, stdout: '', stderr: '', error: 'git command output limit exceeded' });
    return current;
  }
  return next;
}

function samePinnedDirectory(path, dev, ino) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function samePinnedFile(path, dev, ino) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function pathAbsent(path) {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

function destinationStillPinned() {
  if (destinationPin === null) return true;
  const worktreePinned = !destinationPin.worktreePath ||
    (destinationPin.requireWorktreeAbsence
      ? pathAbsent(destinationPin.worktreePath)
      : samePinnedDirectory(
          destinationPin.worktreePath,
          destinationPin.worktreeDev,
          destinationPin.worktreeIno,
        ) || (destinationPin.allowWorktreeAbsence && pathAbsent(destinationPin.worktreePath)));
  return (
    samePinnedDirectory(destinationPin.parentPath, destinationPin.parentDev, destinationPin.parentIno) &&
    samePinnedDirectory(destinationPin.homePath, destinationPin.homeDev, destinationPin.homeIno) &&
    samePinnedFile(destinationPin.metadataPath, destinationPin.metadataDev, destinationPin.metadataIno) &&
    worktreePinned
  );
}

let git;
try {
  if (!destinationStillPinned()) {
    send({ status: null, stdout: '', stderr: '', error: 'sandbox reservation identity changed before git command' });
  } else {
    git = spawn('git', gitArgs, {
      cwd,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
} catch (error) {
  send({ status: null, stdout: '', stderr: '', error: String(error) });
}
if (git) {
  const destinationMonitor = destinationPin === null ? null : setInterval(() => {
    if (!destinationStillPinned()) {
      send({ status: null, stdout, stderr, error: 'sandbox reservation identity changed during git command' });
    }
  }, 1);
  git.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
  git.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
  git.on('error', (error) => {
    if (destinationMonitor !== null) clearInterval(destinationMonitor);
    send({ status: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
  });
  git.on('close', (status, signal) => {
    if (destinationMonitor !== null) clearInterval(destinationMonitor);
    send(destinationStillPinned()
      ? { status, stdout, stderr, ...(signal ? { error: 'git exited on ' + signal } : {}) }
      : { status: null, stdout, stderr, error: 'sandbox reservation identity changed during git command' });
  });
}

// The command runner owns this supervisor's process group/tree and kills it
// only after receiving a result or reaching its deadline.
setInterval(() => {}, 60_000);
`;

const PINNED_POST_CREATE_WRITER = String.raw`
const fs = require('node:fs');
const path = require('node:path');

const [sourceDev, sourceIno, sourceRepo, parentDev, parentIno, sandboxParent,
  homeDev, homeIno, sandboxHome, metadataDev, metadataIno, metadataPath,
  worktreeDev, worktreeIno, worktreePath,
  commonDev, commonIno, commonPath] = process.argv.slice(1);

function sameDirectory(value, dev, ino) {
  try {
    const stat = fs.lstatSync(value, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function sameFile(value, dev, ino) {
  try {
    const stat = fs.lstatSync(value, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function destinationStillExact() {
  return sameDirectory(sandboxParent, parentDev, parentIno) &&
    sameDirectory(sandboxHome, homeDev, homeIno) &&
    sameFile(metadataPath, metadataDev, metadataIno) &&
    sameDirectory(worktreePath, worktreeDev, worktreeIno);
}

function safeRegularFile(value) {
  try {
    const stat = fs.lstatSync(value);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

try {
  if (!destinationStillExact() || !sameDirectory('.', worktreeDev, worktreeIno) ||
      !sameDirectory(sourceRepo, sourceDev, sourceIno)) process.exit(0);
  const sourceModules = path.join(sourceRepo, 'node_modules');
  if (sameDirectory(sourceModules, String(fs.lstatSync(sourceModules, { bigint: true }).dev),
      String(fs.lstatSync(sourceModules, { bigint: true }).ino)) && !fs.existsSync('node_modules') &&
      destinationStillExact() && sameDirectory('.', worktreeDev, worktreeIno) &&
      sameDirectory(sourceRepo, sourceDev, sourceIno)) {
    fs.symlinkSync(sourceModules, 'node_modules', 'dir');
  }
} catch { /* node_modules linking is best effort */ }

try {
  if (!destinationStillExact() || !sameDirectory('.', worktreeDev, worktreeIno)) process.exit(0);
  const raw = fs.readFileSync('.git', 'utf8').trim();
  if (!raw.startsWith('gitdir: ')) process.exit(0);
  const rawGitdir = raw.slice('gitdir: '.length).trim();
  const gitdir = fs.realpathSync.native(path.resolve(worktreePath, rawGitdir));
  const relative = path.relative(commonPath, gitdir);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    process.exit(0);
  }
  const gitdirStat = fs.lstatSync(gitdir, { bigint: true });
  if (!gitdirStat.isDirectory() || gitdirStat.isSymbolicLink() ||
      !sameDirectory(commonPath, commonDev, commonIno)) process.exit(0);
  process.chdir(gitdir);
  const gitdirDev = String(gitdirStat.dev);
  const gitdirIno = String(gitdirStat.ino);
  const authorityStillExact = () => destinationStillExact() &&
    sameDirectory(gitdir, gitdirDev, gitdirIno) && sameDirectory(commonPath, commonDev, commonIno);
  if (!authorityStillExact()) process.exit(0);
  if (!fs.existsSync('info')) fs.mkdirSync('info', { mode: 0o700 });
  const infoStat = fs.lstatSync('info', { bigint: true });
  if (!infoStat.isDirectory() || infoStat.isSymbolicLink() || !authorityStillExact()) process.exit(0);
  process.chdir('info');
  const infoDev = String(infoStat.dev);
  const infoIno = String(infoStat.ino);
  const writerAuthorityStillExact = () => authorityStillExact() && sameDirectory('.', infoDev, infoIno);
  if (!writerAuthorityStillExact() || !safeRegularFile('exclude')) process.exit(0);
  const exclude = 'exclude';
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!existing.includes('node_modules') && writerAuthorityStillExact() && safeRegularFile(exclude)) {
    const fd = fs.openSync(exclude,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600);
    try {
      if (writerAuthorityStillExact()) {
        fs.writeSync(fd, '\n# M286: fleet-symlinked node_modules - never stage\nnode_modules\n');
      }
    } finally {
      fs.closeSync(fd);
    }
  }
} catch { /* exclude registration is best effort */ }
`;

const PINNED_WORKTREE_RUNNER = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { lstatSync, realpathSync } = require('node:fs');
const path = require('node:path');
const supervisorSource = ${JSON.stringify(PINNED_GIT_SUPERVISOR)};
const postCreateWriterSource = ${JSON.stringify(PINNED_POST_CREATE_WRITER)};

const [commonDev, commonIno, expectedCommonPath, sourceDev, sourceIno, sourceRepo,
  parentDev, parentIno, sandboxParent, homeDev, homeIno, sandboxHome,
  metadataDev, metadataIno, metadataPath, worktreePath, branch, baseHead] = process.argv.slice(1);
const childEnv = { ...process.env };
if (childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS) {
  childEnv.NODE_OPTIONS = childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS;
} else {
  delete childEnv.NODE_OPTIONS;
}
delete childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskkillOnce(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function joinOwnedTree(supervisor, closed) {
  const pid = supervisor.pid;
  if (typeof pid !== 'number' || pid < 1) {
    await closed;
    return;
  }
  if (process.platform === 'win32') {
    while (supervisor.exitCode === null && supervisor.signalCode === null) {
      await taskkillOnce(pid);
      if (supervisor.exitCode === null && supervisor.signalCode === null) await delay(10);
    }
    await closed;
    return;
  }

  while (true) {
    try {
      process.kill(-pid, 'SIGKILL');
      break;
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      await delay(10);
    }
  }
  await closed;
  while (true) {
    try {
      process.kill(-pid, 0);
      await delay(10);
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      await delay(10);
    }
  }
}

function run(cwd, args, options = {}) {
  return new Promise((resolve) => {
    const supervisorEnv = { ...childEnv };
    if (supervisorEnv.NODE_OPTIONS) {
      supervisorEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS = supervisorEnv.NODE_OPTIONS;
    } else {
      delete supervisorEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
    }
    delete supervisorEnv.NODE_OPTIONS;
    if (options.monitorDestination) {
      supervisorEnv.ASHLR_PINNED_DESTINATION = '1';
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_PATH = sandboxParent;
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_DEV = parentDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_INO = parentIno;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_PATH = sandboxHome;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_DEV = homeDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_INO = homeIno;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_PATH = metadataPath;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_DEV = metadataDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_INO = metadataIno;
      if (options.worktreePin || options.requireWorktreeAbsence) {
        supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_PATH = worktreePath;
        if (options.worktreePin) {
          supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_DEV = options.worktreePin.dev;
          supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_INO = options.worktreePin.ino;
        }
        supervisorEnv.ASHLR_PINNED_DESTINATION_ALLOW_WORKTREE_ABSENCE =
          options.allowWorktreeAbsence ? '1' : '0';
        supervisorEnv.ASHLR_PINNED_DESTINATION_REQUIRE_WORKTREE_ABSENCE =
          options.requireWorktreeAbsence ? '1' : '0';
      }
    }

    let supervisor;
    try {
      supervisor = spawn(process.execPath, [
        '-e', supervisorSource, '--', cwd,
        options.pinnedRepository ? 'pinned' : 'plain', sourceRepo, ...args,
      ], {
        cwd,
        env: supervisorEnv,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: String(error) });
      return;
    }

    let finishing = false;
    const closed = new Promise((resolveClosed) => supervisor.once('close', resolveClosed));
    const finish = async (result) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      await joinOwnedTree(supervisor, closed);
      resolve(result);
    };
    const timer = setTimeout(() => {
      void finish({ status: null, stdout: '', stderr: '', error: 'git command timed out' });
    }, ${GIT_TIMEOUT});
    supervisor.once('message', (message) => {
      const result = message && typeof message === 'object'
        ? message
        : { status: null, stdout: '', stderr: '', error: 'invalid git supervisor result' };
      void finish(result);
    });
    supervisor.once('error', (error) => {
      void finish({ status: null, stdout: '', stderr: '', error: error.message });
    });
    supervisor.once('close', () => {
      if (!finishing) {
        void finish({ status: null, stdout: '', stderr: '', error: 'git supervisor exited without a result' });
      }
    });
  });
}

function sameDirectoryIdentity(stat, dev, ino) {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    String(stat.dev) === dev && String(stat.ino) === ino;
}

function sameFileIdentity(stat, dev, ino) {
  return stat.isFile() && !stat.isSymbolicLink() &&
    String(stat.dev) === dev && String(stat.ino) === ino;
}

function sameCanonicalPath(left, right) {
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return fold(path.resolve(left)) === fold(path.resolve(right));
}

function runPinned(args, options = {}) {
  return run('.', args, { ...options, pinnedRepository: true });
}

async function registrationPresent() {
  const listed = await runPinned(['worktree', 'list', '--porcelain']);
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null;
  const target = path.resolve(worktreePath);
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return listed.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => fold(path.resolve(line.slice('worktree '.length).trimEnd())) === fold(target));
}

async function branchPresent() {
  const shown = await runPinned(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
  return shown.status === 0 ? true : shown.status === 1 ? false : null;
}

async function rollback() {
  if (!currentDestinationIsPinned()) return false;
  let worktreePin = null;
  try {
    const stat = lstatSync(worktreePath, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      worktreePin = { dev: String(stat.dev), ino: String(stat.ino) };
    }
  } catch { /* an incomplete add may not have created the worktree */ }

  const runRollbackMutation = async (args, options = {}) => {
    if (!currentDestinationIsPinned()) return false;
    const mutation = await runPinned(args, { monitorDestination: true, ...options });
    return currentDestinationIsPinned() &&
      !(mutation.error && mutation.error.includes('sandbox reservation identity changed'));
  };

  if (!await runRollbackMutation(
    ['worktree', 'remove', '--force', worktreePath],
    worktreePin
      ? { worktreePin, allowWorktreeAbsence: true }
      : { requireWorktreeAbsence: true },
  )) return false;
  if (!await runRollbackMutation(['worktree', 'prune'])) return false;
  if (!await runRollbackMutation(['branch', '-D', branch])) return false;
  if (!currentDestinationIsPinned()) return false;
  const registrationAbsent = await registrationPresent() === false;
  if (!currentDestinationIsPinned()) return false;
  const branchAbsent = await branchPresent() === false;
  return currentDestinationIsPinned() && registrationAbsent && branchAbsent;
}

function currentDestinationIsPinned() {
  try {
    return sameDirectoryIdentity(lstatSync(sandboxParent, { bigint: true }), parentDev, parentIno) &&
      sameDirectoryIdentity(lstatSync(sandboxHome, { bigint: true }), homeDev, homeIno) &&
      sameFileIdentity(lstatSync(metadataPath, { bigint: true }), metadataDev, metadataIno) &&
      sameCanonicalPath(path.dirname(sandboxHome), sandboxParent) &&
      sameCanonicalPath(path.dirname(metadataPath), sandboxHome) &&
      path.basename(worktreePath) === 'worktree' &&
      sameCanonicalPath(realpathSync.native(path.dirname(worktreePath)), sandboxHome);
  } catch {
    return false;
  }
}

async function currentSourceIsPinned() {
  try {
    if (!sameDirectoryIdentity(lstatSync(sourceRepo, { bigint: true }), sourceDev, sourceIno)) return false;
    const common = await run(sourceRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.status !== 0 || typeof common.stdout !== 'string' || !common.stdout.trim()) return false;
    const commonPath = realpathSync.native(common.stdout.trim());
    return sameCanonicalPath(commonPath, expectedCommonPath) &&
      sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno);
  } catch {
    return false;
  }
}

async function retainedSourceMatchesDiscovery() {
  try {
    if (!sameDirectoryIdentity(lstatSync('.', { bigint: true }), sourceDev, sourceIno) ||
        !sameCanonicalPath(realpathSync.native('.'), sourceRepo)) return false;
    const common = await run('.', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const head = await run('.', ['rev-parse', 'HEAD']);
    if (common.status !== 0 || !common.stdout.trim() ||
        head.status !== 0 || head.stdout.trim() !== baseHead) return false;
    const commonPath = realpathSync.native(common.stdout.trim());
    return sameCanonicalPath(commonPath, expectedCommonPath) &&
      sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno) &&
      sameDirectoryIdentity(lstatSync('.', { bigint: true }), sourceDev, sourceIno);
  } catch {
    return false;
  }
}

function runPinnedPostCreateWriter() {
  try {
    const worktree = lstatSync(worktreePath, { bigint: true });
    if (!worktree.isDirectory() || worktree.isSymbolicLink() || !currentDestinationIsPinned()) return;
    const writerEnv = { ...childEnv };
    delete writerEnv.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [
      '-e', postCreateWriterSource, '--', sourceDev, sourceIno, sourceRepo,
      parentDev, parentIno, sandboxParent, homeDev, homeIno, sandboxHome,
      metadataDev, metadataIno, metadataPath,
      String(worktree.dev), String(worktree.ino), worktreePath,
      commonDev, commonIno, expectedCommonPath,
    ], {
      cwd: worktreePath,
      env: writerEnv,
      stdio: 'ignore',
      windowsHide: true,
      timeout: ${GIT_TIMEOUT},
    });
    void result;
  } catch { /* post-create writes are best effort */ }
}

async function validateCreatedWorktree() {
  let worktreePin;
  try {
    const stat = lstatSync(worktreePath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { exact: false, reservationChanged: true };
    }
    worktreePin = { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return { exact: false, reservationChanged: true };
  }
  const monitor = { monitorDestination: true, worktreePin };
  const head = await run(worktreePath, ['rev-parse', 'HEAD'], monitor);
  const currentBranch = await run(worktreePath, ['branch', '--show-current'], monitor);
  const common = await run(
    worktreePath,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    monitor,
  );
  const reservationChanged = [head, currentBranch, common].some((entry) =>
    entry.error && entry.error.includes('sandbox reservation identity changed'));
  if (head.status !== 0 || head.stdout.trim() !== baseHead ||
      currentBranch.status !== 0 || currentBranch.stdout.trim() !== branch ||
      common.status !== 0 || !common.stdout.trim()) return { exact: false, reservationChanged };
  try {
    const commonPath = realpathSync.native(common.stdout.trim());
    return {
      exact: sameCanonicalPath(commonPath, expectedCommonPath) &&
        sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno),
      reservationChanged,
    };
  } catch {
    return { exact: false, reservationChanged };
  }
}

(async () => {
  let result;
  try {
    if (!await retainedSourceMatchesDiscovery()) {
      result = { ok: false, cleanupComplete: true, error: 'source repository discovery identity changed before worktree creation' };
    } else if (!currentDestinationIsPinned()) {
      result = { ok: false, cleanupComplete: false, error: 'sandbox reservation identity changed before worktree creation' };
    } else {
      process.chdir(expectedCommonPath);
      if (!sameCanonicalPath(realpathSync.native('.'), expectedCommonPath) ||
          !sameDirectoryIdentity(lstatSync('.', { bigint: true }), commonDev, commonIno) ||
          !await currentSourceIsPinned()) {
        result = { ok: false, cleanupComplete: true, error: 'repository association changed before worktree creation' };
      } else {
      const added = await runPinned([
        'worktree', 'add', '-b', branch, worktreePath, baseHead,
      ], { monitorDestination: true });
      if (added.status !== 0) {
        result = {
          ok: false,
          cleanupComplete: await rollback(),
          error: added.error && added.error.includes('sandbox reservation identity changed')
            ? added.error
            : 'git worktree add failed',
        };
      } else {
        const destinationPinnedBeforeValidation = currentDestinationIsPinned();
        const worktreeValidation = destinationPinnedBeforeValidation
          ? await validateCreatedWorktree()
          : { exact: false, reservationChanged: true };
        const worktreeExact = destinationPinnedBeforeValidation && worktreeValidation.exact;
        const destinationPinnedAfterValidation = currentDestinationIsPinned();
        if (!destinationPinnedBeforeValidation || !worktreeExact ||
            !destinationPinnedAfterValidation) {
          const reservationChanged = !destinationPinnedBeforeValidation ||
            !destinationPinnedAfterValidation || worktreeValidation.reservationChanged;
          result = {
            ok: false,
            cleanupComplete: await rollback(),
            error: reservationChanged
              ? 'sandbox reservation identity changed during worktree creation'
              : 'sandbox reservation or repository/Git common directory identity changed during worktree creation',
          };
        } else {
          runPinnedPostCreateWriter();
          const destinationPinnedBeforePostValidation = currentDestinationIsPinned();
          const postValidation = destinationPinnedBeforePostValidation
            ? await validateCreatedWorktree()
            : { exact: false, reservationChanged: true };
          const postWorktreeExact = destinationPinnedBeforePostValidation && postValidation.exact;
          const destinationPinnedAfterPostValidation = currentDestinationIsPinned();
          if (!destinationPinnedBeforePostValidation || !postWorktreeExact ||
              !destinationPinnedAfterPostValidation) {
            const reservationChanged = !destinationPinnedBeforePostValidation ||
              !destinationPinnedAfterPostValidation || postValidation.reservationChanged;
            result = {
              ok: false,
              cleanupComplete: await rollback(),
              error: reservationChanged
                ? 'sandbox reservation identity changed after worktree creation'
                : 'sandbox reservation or repository/Git common directory identity changed after worktree creation',
            };
          } else {
            try {
              const worktree = lstatSync(worktreePath, { bigint: true });
              result = worktree.isDirectory() && !worktree.isSymbolicLink()
                ? {
                    ok: true,
                    cleanupComplete: false,
                    worktreeDev: String(worktree.dev),
                    worktreeIno: String(worktree.ino),
                  }
                : {
                    ok: false,
                    cleanupComplete: false,
                    error: 'worktree identity unavailable after creation',
                  };
            } catch {
              result = {
                ok: false,
                cleanupComplete: false,
                error: 'worktree identity unavailable after creation',
              };
            }
          }
        }
      }
      }
    }
  } catch {
    let cleanupComplete = false;
    try { cleanupComplete = await rollback(); } catch { /* retain recovery metadata */ }
    result = { ok: false, cleanupComplete, error: 'pinned worktree creation failed' };
  }
  process.stdout.write(JSON.stringify(result));
})().catch(() => {
  process.stdout.write(JSON.stringify({
    ok: false,
    cleanupComplete: false,
    error: 'pinned worktree runner failed',
  }));
});
`;

/**
 * Bind the child to the pinned common-directory inode before Git starts. The
 * child retains that cwd through add, validation, and rollback, so pathname
 * retargeting cannot redirect any repository mutation during the Git effect.
 */
function createPinnedWorktree(
  identity: PinnedRepositoryIdentity,
  destination: PinnedSandboxDestinationIdentity,
  sb: Sandbox,
): PinnedWorktreeCreationResult {
  const env = { ...process.env };
  if (env.NODE_OPTIONS) env.ASHLR_PINNED_GIT_NODE_OPTIONS = env.NODE_OPTIONS;
  else delete env.ASHLR_PINNED_GIT_NODE_OPTIONS;
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [
    '-e',
    PINNED_WORKTREE_RUNNER,
    '--',
    String(identity.commonDirectory.dev),
    String(identity.commonDirectory.ino),
    identity.commonDirectory.path,
    String(identity.source.dev),
    String(identity.source.ino),
    identity.source.path,
    String(destination.parent.dev),
    String(destination.parent.ino),
    destination.parent.path,
    String(destination.home.dev),
    String(destination.home.ino),
    destination.home.path,
    String(destination.metadata.dev),
    String(destination.metadata.ino),
    destination.metadata.path,
    sb.worktreePath,
    sb.branch,
    sb.baseHead,
  ], {
    cwd: identity.source.path,
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return { ok: false, cleanupComplete: false, error: 'pinned worktree runner failed' };
  }
  try {
    const parsed = JSON.parse(result.stdout) as Partial<PinnedWorktreeCreationResult>;
    if (typeof parsed.ok !== 'boolean' || typeof parsed.cleanupComplete !== 'boolean') {
      throw new Error('invalid pinned worktree result');
    }
    if (parsed.ok && (
      typeof parsed.worktreeDev !== 'string' || !/^\d+$/u.test(parsed.worktreeDev) ||
      typeof parsed.worktreeIno !== 'string' || !/^\d+$/u.test(parsed.worktreeIno)
    )) throw new Error('invalid pinned worktree identity');
    return {
      ok: parsed.ok,
      cleanupComplete: parsed.cleanupComplete,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      ...(typeof parsed.worktreeDev === 'string' ? { worktreeDev: parsed.worktreeDev } : {}),
      ...(typeof parsed.worktreeIno === 'string' ? { worktreeIno: parsed.worktreeIno } : {}),
    };
  } catch {
    return { ok: false, cleanupComplete: false, error: 'invalid pinned worktree result' };
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
  const expectedDirs = new Map<string, { dev: bigint; ino: bigint }>();
  for (const dir of [root, home]) {
    const stat = lstatSync(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) {
      throw new Error('unsafe sandbox metadata directory');
    }
    chmodSync(dir, 0o700);
    expectedDirs.set(dir, { dev: stat.dev, ino: stat.ino });
  }
  const target = metaPath(sb.id);
  if (existsSync(target)) {
    const current = lstatSync(target, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() ||
      (typeof process.getuid === 'function' && current.uid !== BigInt(process.getuid()))) {
      throw new Error('unsafe sandbox metadata file');
    }
  }
  const temp = join(home, `.sandbox.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  let tempIdentity: { dev: bigint; ino: bigint } | null = null;
  try {
    fd = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error('invalid sandbox metadata temporary file');
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    const bytes = Buffer.from(JSON.stringify(sb, null, 2) + '\n', 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short sandbox metadata write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (const dir of [root, home]) {
      const expected = expectedDirs.get(dir)!;
      const current = lstatSync(dir, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error('sandbox metadata directory changed during write');
      }
    }
    renameSync(temp, target);
    const persisted = lstatSync(target, { bigint: true });
    if (persisted.isSymbolicLink() || !persisted.isFile() || tempIdentity === null ||
        persisted.dev !== tempIdentity.dev || persisted.ino !== tempIdentity.ino) {
      throw new Error('invalid sandbox metadata replacement');
    }
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
  if (!SANDBOX_ID_RE.test(id)) return null;
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

interface PinnedDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface PinnedRepositoryIdentity {
  source: PinnedDirectoryIdentity;
  commonDirectory: PinnedDirectoryIdentity;
}

interface PinnedSandboxDestinationIdentity {
  parent: PinnedDirectoryIdentity;
  home: PinnedDirectoryIdentity;
  metadata: PinnedFileIdentity;
}

interface PinnedFileIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

function pinDirectoryIdentity(value: string): PinnedDirectoryIdentity | null {
  const path = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  if (!path) return null;
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? { path, dev: stat.dev, ino: stat.ino }
      : null;
  } catch {
    return null;
  }
}

function directoryIdentityStillPinned(identity: PinnedDirectoryIdentity): boolean {
  try {
    const stat = lstatSync(identity.path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function pinFileIdentity(value: string): PinnedFileIdentity | null {
  const path = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  if (!path) return null;
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink()
      ? { path, dev: stat.dev, ino: stat.ino }
      : null;
  } catch {
    return null;
  }
}

function fileIdentityStillPinned(identity: PinnedFileIdentity): boolean {
  try {
    const stat = lstatSync(identity.path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function pinGitCommonDirectory(sourceRepo: string): PinnedDirectoryIdentity | null {
  const commonDirectory = gitTry(sourceRepo, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return commonDirectory ? pinDirectoryIdentity(commonDirectory) : null;
}

function repositoryIdentityStillPinned(identity: PinnedRepositoryIdentity): boolean {
  if (!directoryIdentityStillPinned(identity.source) ||
      !directoryIdentityStillPinned(identity.commonDirectory)) return false;
  const currentCommonDirectory = pinGitCommonDirectory(identity.source.path);
  return currentCommonDirectory !== null &&
    currentCommonDirectory.path === identity.commonDirectory.path &&
    currentCommonDirectory.dev === identity.commonDirectory.dev &&
    currentCommonDirectory.ino === identity.commonDirectory.ino;
}

function sandboxDestinationStillPinned(identity: PinnedSandboxDestinationIdentity): boolean {
  return directoryIdentityStillPinned(identity.parent) &&
    directoryIdentityStillPinned(identity.home) &&
    fileIdentityStillPinned(identity.metadata) &&
    dirname(identity.home.path) === identity.parent.path &&
    dirname(identity.metadata.path) === identity.home.path;
}

function createdWorktreeStillExact(
  sb: Sandbox,
  worktree: PinnedDirectoryIdentity,
  repository: PinnedRepositoryIdentity,
  destination: PinnedSandboxDestinationIdentity,
): boolean {
  const authorityStillExact = (): boolean =>
    directoryIdentityStillPinned(repository.source) &&
    directoryIdentityStillPinned(repository.commonDirectory) &&
    sandboxDestinationStillPinned(destination) &&
    directoryIdentityStillPinned(worktree) &&
    canonicalFilesystemPathIdentity(dirname(sb.worktreePath), { foldWindowsCase: false }) ===
      destination.home.path;
  if (!authorityStillExact()) return false;

  const head = gitTry(sb.worktreePath, ['rev-parse', 'HEAD']);
  if (!authorityStillExact()) return false;
  const branch = gitTry(sb.worktreePath, ['branch', '--show-current']);
  if (!authorityStillExact()) return false;
  const commonPath = gitTry(sb.worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!authorityStillExact() || !head || !branch || !commonPath) return false;
  const currentCommon = pinDirectoryIdentity(commonPath);
  return head === sb.baseHead && branch === sb.branch && currentCommon !== null &&
    currentCommon.path === repository.commonDirectory.path &&
    currentCommon.dev === repository.commonDirectory.dev &&
    currentCommon.ino === repository.commonDirectory.ino &&
    authorityStillExact();
}

function removePinnedSandboxHomeReservation(
  parent: PinnedDirectoryIdentity,
  home: PinnedDirectoryIdentity,
): boolean {
  if (!directoryIdentityStillPinned(parent) || !directoryIdentityStillPinned(home) ||
      dirname(home.path) !== parent.path) return false;
  try {
    rmSync(home.path, { recursive: true, force: true });
    return !existsSync(home.path);
  } catch {
    return false;
  }
}

function removePinnedSandboxReservation(identity: PinnedSandboxDestinationIdentity): boolean {
  if (!sandboxDestinationStillPinned(identity)) return false;
  try {
    rmSync(identity.home.path, { recursive: true, force: true });
    return !existsSync(identity.home.path);
  } catch {
    return false;
  }
}

/**
 * Create an isolated git-worktree sandbox of `sourceRepo` on a NEW scratch
 * branch under ~/.ashlr/sandboxes/<id>/.
 *
 * Pins the physical repository and Git common directory, then calls
 * assertMayMutate with that canonical physical repository.
 * Refuses (throws + audits result:'refused') if the kill switch is on OR the
 * repo is not enrolled and opts.allowAnyRepo is not set. Verifies sourceRepo
 * is a git repo. Reads the
 * source HEAD WITHOUT mutating it. Adds the worktree via
 * `git worktree add -b <branch> <path> <baseHead>` run in sourceRepo — this
 * MUST NOT modify the source working tree, index, HEAD, or any user branch.
 */
export function createSandbox(
  sourceRepo: string,
  opts?: { allowAnyRepo?: boolean },
): Sandbox {
  const outwardFence = acquireOutwardMutationFence();
  if (!ownsOutwardMutationFence(outwardFence)) {
    releaseOutwardMutationFence(outwardFence);
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'refused: outward mutation fence unavailable',
      result: 'refused',
    });
    throw new Error('outward mutation fence unavailable; sandbox creation did not start');
  }
  try {
    return createSandboxWhileFenced(sourceRepo, outwardFence, opts);
  } finally {
    releaseOutwardMutationFence(outwardFence);
  }
}

function createSandboxWhileFenced(
  sourceRepo: string,
  outwardFence: OutwardMutationFence | null,
  opts?: { allowAnyRepo?: boolean },
): Sandbox {
  const sourceIdentity = pinDirectoryIdentity(sourceRepo);
  if (!sourceIdentity) {
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'source repository identity is unavailable',
      result: 'error',
    });
    throw new Error(`could not pin repository identity: ${sourceRepo}`);
  }
  const canonicalSourceRepo = sourceIdentity.path;

  // Gate the pinned physical pathname before Git discovery. The retained
  // runner independently verifies this source inode before using its cwd, so
  // a pathname replacement cannot carry policy authority into Git effects.
  try {
    assertMayMutate(canonicalSourceRepo, opts);
  } catch (err) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'refused by policy gate',
      result: 'refused',
    });
    throw err;
  }
  if (!directoryIdentityStillPinned(sourceIdentity)) {
    throw new Error('source repository identity changed during policy gate');
  }

  if (!isRepo(canonicalSourceRepo)) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'sourceRepo is not a git repository',
      result: 'error',
    });
    throw new Error(`not a git repository: ${canonicalSourceRepo}`);
  }
  const commonDirectoryIdentity = pinGitCommonDirectory(canonicalSourceRepo);
  if (!commonDirectoryIdentity) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'Git common directory identity is unavailable',
      result: 'error',
    });
    throw new Error(`could not pin Git common directory identity: ${canonicalSourceRepo}`);
  }
  const repositoryIdentity: PinnedRepositoryIdentity = {
    source: sourceIdentity,
    commonDirectory: commonDirectoryIdentity,
  };

  const cleanupAuthority = borrowSandboxCleanupAuthority(outwardFence);
  if (!cleanupAuthority) {
    throw new Error('outward mutation authority became invalid before sandbox creation');
  }

  // Read the source HEAD commit WITHOUT mutating it.
  const baseHead = gitTry(canonicalSourceRepo, ['rev-parse', 'HEAD']);
  if (!baseHead) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'could not resolve source HEAD',
      result: 'error',
    });
    throw new Error(`could not resolve HEAD in repo: ${canonicalSourceRepo}`);
  }
  if (!repositoryIdentityStillPinned(repositoryIdentity)) {
    throw new Error('repository or Git common directory identity changed while reading source HEAD');
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
  let sb: Sandbox;
  let destinationIdentity: PinnedSandboxDestinationIdentity;
  try {
    const cap = maxSandboxes();
    if (sandboxInventory().totalHomes >= cap) {
      sweepOrphanSandboxesWhileCreationLocked({
        staleMs: ORPHAN_STALE_MS,
        borrowedAuthority: cleanupAuthority,
      });
      if (sandboxInventory().totalHomes >= cap) {
        audit({
          action: 'sandbox:create', repo: canonicalSourceRepo, sandboxId: null,
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
    const parentIdentity = pinDirectoryIdentity(sandboxesDir());
    if (!parentIdentity ||
        canonicalFilesystemPathIdentity(dirname(home), { foldWindowsCase: false }) !== parentIdentity.path) {
      throw new Error('could not pin sandbox destination parent identity');
    }
    mkdirSync(home, { recursive: false, mode: 0o700 });
    const homeIdentity = pinDirectoryIdentity(home);
    if (!homeIdentity || dirname(homeIdentity.path) !== parentIdentity.path) {
      throw new Error('could not pin sandbox destination home identity');
    }
    sb = {
      id,
      sourceRepo: canonicalSourceRepo,
      worktreePath,
      branch,
      baseHead,
      createdAt: new Date().toISOString(),
      ownerPid: process.pid,
    };

    // Publish durable owner-bearing recovery authority before another creator
    // or reservation sweep can observe this home outside creation serialization.
    // A crash after this point is handled by normal dead-owner recovery; a crash
    // during the atomic write leaves only a metadata-free pre-effect home.
    try {
      writeMeta(sb);
    } catch (err) {
      removePinnedSandboxHomeReservation(parentIdentity, homeIdentity);
      throw err;
    }
    const metadataIdentity = pinFileIdentity(metaPath(id));
    if (!metadataIdentity || dirname(metadataIdentity.path) !== homeIdentity.path) {
      removePinnedSandboxHomeReservation(parentIdentity, homeIdentity);
      throw new Error('could not pin sandbox reservation metadata identity');
    }
    destinationIdentity = {
      parent: parentIdentity,
      home: homeIdentity,
      metadata: metadataIdentity,
    };
    if (!repositoryIdentityStillPinned(repositoryIdentity) ||
        !sandboxDestinationStillPinned(destinationIdentity)) {
      removePinnedSandboxReservation(destinationIdentity);
      throw new Error('repository or sandbox destination identity changed before sandbox publication');
    }
  } finally {
    releaseCleanupLock(creationLock);
  }

  // Add the isolated worktree on a NEW scratch branch off baseHead, run IN the
  // source repo. This does NOT touch the source working tree, index, HEAD, or
  // any user branch — it only creates a new ref + a separate checkout.
  if (!repositoryIdentityStillPinned(repositoryIdentity) ||
      !sandboxDestinationStillPinned(destinationIdentity)) {
    removePinnedSandboxReservation(destinationIdentity);
    throw new Error('repository or sandbox destination identity changed before worktree creation');
  }
  const creation = createPinnedWorktree(repositoryIdentity, destinationIdentity, sb);
  if (!creation.ok) {
    if (creation.cleanupComplete) {
      removePinnedSandboxReservation(destinationIdentity);
    }
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: id,
      summary: creation.error ?? 'pinned worktree creation failed',
      result: 'error',
    });
    throw new Error(creation.error ?? 'pinned worktree creation failed');
  }
  const worktreeIdentity = creation.worktreeDev !== undefined && creation.worktreeIno !== undefined
    ? {
        path: sb.worktreePath,
        dev: BigInt(creation.worktreeDev),
        ino: BigInt(creation.worktreeIno),
      }
    : null;
  if (!worktreeIdentity || !createdWorktreeStillExact(
    sb,
    worktreeIdentity,
    repositoryIdentity,
    destinationIdentity,
  )) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: id,
      summary: 'repository or sandbox identity changed after worktree creation',
      result: 'error',
    });
    throw new Error('repository or sandbox identity changed after worktree creation');
  }

  audit({
    action: 'sandbox:create',
    repo: canonicalSourceRepo,
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

/**
 * Resolve aliases for the longest existing prefix, then append the normalized
 * missing suffix. This keeps cleanup identity stable after a worktree vanishes
 * and across Windows long/8.3 path spellings. Windows path identity is
 * case-insensitive; other platforms retain their native case semantics.
 */
export function canonicalPathIdentity(value: string): string | null {
  return canonicalFilesystemPathIdentity(value);
}

function registrationState(repo: string, worktreePath: string): SandboxCleanupPostcondition {
  const raw = gitTry(repo, ['worktree', 'list', '--porcelain']);
  if (raw === null) return 'unknown';
  const target = canonicalPathIdentity(worktreePath);
  if (target === null) return 'unknown';
  const registered = raw.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => canonicalPathIdentity(line.slice('worktree '.length).trimEnd()) === target);
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
  if (worktreeCommon === null || repoCommon === null) return false;
  const worktreeIdentity = canonicalPathIdentity(worktreeCommon);
  const repoIdentity = canonicalPathIdentity(repoCommon);
  return worktreeIdentity !== null && repoIdentity !== null && worktreeIdentity === repoIdentity;
}

export type SandboxSourceRevisionRefusal =
  | 'source-repo-unavailable'
  | 'source-repo-mismatch'
  | 'sandbox-worktree-mismatch'
  | 'base-revision-unavailable'
  | 'source-revision-stale'
  | 'source-revision-raced';

export type SandboxSourceRevisionAdmission =
  | { ok: true; baseHead: string; currentHead: string }
  | { ok: false; reason: SandboxSourceRevisionRefusal; baseHead?: string; currentHead?: string };

function canonicalGitDirectory(repo: string): string | null {
  const common = gitTry(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  try { return realpathSync.native(common); } catch { return null; }
}

/** Read-only, fail-closed proof that a sandbox still represents its source base. */
export function inspectSandboxSourceRevision(
  sb: Sandbox,
  expectedSourceRepo: string = sb.sourceRepo,
): SandboxSourceRevisionAdmission {
  try {
    const sourceHeadBefore = gitTry(expectedSourceRepo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!sourceHeadBefore) return { ok: false, reason: 'source-repo-unavailable' };
    const expectedCommon = canonicalGitDirectory(expectedSourceRepo);
    const recordedCommon = canonicalGitDirectory(sb.sourceRepo);
    if (!expectedCommon || !recordedCommon) return { ok: false, reason: 'source-repo-unavailable' };
    if (expectedCommon !== recordedCommon) return { ok: false, reason: 'source-repo-mismatch', currentHead: sourceHeadBefore };
    const worktreeCommon = canonicalGitDirectory(sb.worktreePath);
    if (!worktreeCommon || worktreeCommon !== expectedCommon) return { ok: false, reason: 'sandbox-worktree-mismatch', currentHead: sourceHeadBefore };
    const baseHead = gitTry(sb.worktreePath, ['rev-parse', '--verify', `${sb.baseHead}^{commit}`]);
    if (!baseHead) return { ok: false, reason: 'base-revision-unavailable', currentHead: sourceHeadBefore };
    const sourceHeadAfter = gitTry(expectedSourceRepo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    if (!sourceHeadAfter) return { ok: false, reason: 'source-repo-unavailable', baseHead };
    if (sourceHeadBefore !== sourceHeadAfter) return { ok: false, reason: 'source-revision-raced', baseHead, currentHead: sourceHeadAfter };
    if (baseHead !== sourceHeadAfter) return { ok: false, reason: 'source-revision-stale', baseHead, currentHead: sourceHeadAfter };
    return { ok: true, baseHead, currentHead: sourceHeadAfter };
  } catch {
    return { ok: false, reason: 'source-repo-unavailable' };
  }
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

function cleanupAuthorityUnavailableResult(
  sb: Sandbox,
  reason: SandboxCleanupAuthorityLease['reason'],
): SandboxCleanupResult {
  const home = sandboxHomeState(sandboxHome(sb.id));
  const result: SandboxCleanupResult = {
    status: 'unavailable',
    postconditions: { registration: 'unknown', branch: 'unknown', home },
    failureClasses: ['cleanup-locked'],
    retryable: true,
    attempt: Math.min(1_000, (sb.cleanup?.attempt ?? 0) + 1),
    evidencePersisted: false,
  };
  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: reason === 'paused'
      ? 'cleanup deferred: autonomy kill switch is ON'
      : 'cleanup deferred: outward mutation authority unavailable',
    result: 'refused',
  });
  return result;
}

export function removeSandbox(
  sb: Sandbox,
  opts?: SandboxCleanupAuthorityOptions,
): SandboxCleanupResult {
  const authority = acquireSandboxCleanupAuthority(opts);
  if (!authority.allowed) return cleanupAuthorityUnavailableResult(sb, authority.reason);
  try {
    return removeSandboxWhileFenced(sb);
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
}

export function removeSandboxWithBorrowedAuthority(
  sb: Sandbox,
  borrowedAuthority: BorrowedSandboxCleanupAuthority | null,
): SandboxCleanupResult {
  return removeSandbox(sb, { borrowedAuthority });
}

function removeSandboxWhileFenced(sb: Sandbox): SandboxCleanupResult {
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
  const recoverableReservation = canonicalMatches && sourceRepoAvailable &&
    !existsSync(safeWorktree) && registrationBefore === 'absent' && branchBefore === 'absent';
  const guardsPass = branchInNamespace && branchMatches && worktreeContained &&
    rootState === 'present' && homeBefore === 'present' && canonicalMatches &&
    !worktreeSymlink && (!sourceRepoAvailable || repoAuthority || recoverableReservation);
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

interface OwnedPathIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
}

interface ReservationFile {
  path: string;
  identity: OwnedPathIdentity;
}

type ReservationRecoveryStatus = 'complete' | 'skipped' | 'refused' | 'unavailable' | 'error';

function ownedDirectoryIdentity(path: string): OwnedPathIdentity | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function samePathIdentity(path: string, expected: OwnedPathIdentity, directory: boolean): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile()) &&
      stat.dev === expected.dev && stat.ino === expected.ino &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

function readReservationJson(file: ReservationFile): Record<string, unknown> | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== file.identity.dev || opened.ino !== file.identity.ino ||
      opened.size > 64 * 1024 ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())) return undefined;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return undefined;
    try {
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function partialIdentitySafe(id: string, value: Record<string, unknown>): boolean {
  const canonicalWorktree = worktreePathFor(id);
  const canonicalBranch = `${BRANCH_PREFIX}${id}`;
  if (Object.prototype.hasOwnProperty.call(value, 'id') && value['id'] !== id) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'worktreePath') &&
    (typeof value['worktreePath'] !== 'string' || resolve(value['worktreePath']) !== resolve(canonicalWorktree))) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'branch') && value['branch'] !== canonicalBranch) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'ownerPid') &&
    (typeof value['ownerPid'] !== 'number' || !Number.isInteger(value['ownerPid']) || value['ownerPid'] <= 0)) {
    return false;
  }
  return true;
}

function safelyUnlinkReservationFile(file: ReservationFile): boolean {
  if (!samePathIdentity(file.path, file.identity, false)) return false;
  try {
    unlinkSync(file.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim one reservation that crashed before any Git effect. This deliberately
 * refuses homes containing a worktree or any unrecognized entry: incomplete
 * metadata is never promoted into authority to mutate a repository.
 */
function recoverReservationHome(id: string, staleMs: number | undefined, now: number): ReservationRecoveryStatus {
  if (!SANDBOX_ID_RE.test(id)) return 'refused';
  const root = sandboxesDir();
  const home = sandboxHome(id);
  const rootIdentity = ownedDirectoryIdentity(root);
  const homeIdentity = ownedDirectoryIdentity(home);
  if (!rootIdentity || !homeIdentity) return 'refused';

  const lock = acquireCleanupLock(id);
  if (!lock) return 'unavailable';
  try {
    if (!samePathIdentity(root, rootIdentity, true) || !samePathIdentity(home, homeIdentity, true)) {
      return 'refused';
    }
    // A creator may have completed metadata before this candidate acquired its
    // lock. Valid metadata always wins and is handled by the normal sweep path.
    if (readMeta(id)) return 'skipped';

    const entries = readdirSync(home, { withFileTypes: true });
    if (entries.length > 4) return 'refused';
    const files: ReservationFile[] = [];
    let freshestMs = homeIdentity.mtimeMs;
    for (const entry of entries) {
      if (entry.name === 'worktree') return 'refused';
      if (entry.name !== META_FILE && !META_TEMP_RE.test(entry.name)) return 'refused';
      const path = join(home, entry.name);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(path); } catch { return 'refused'; }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return 'refused';
      const file = { path, identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs } };
      const partial = readReservationJson(file);
      if (partial === undefined) return 'refused';
      if (partial && !partialIdentitySafe(id, partial)) return 'refused';
      if (partial && pidAlive(partial['ownerPid'])) return 'skipped';
      if (partial && typeof partial['createdAt'] === 'string') {
        const createdMs = Date.parse(partial['createdAt']);
        if (!Number.isNaN(createdMs)) freshestMs = Math.max(freshestMs, createdMs);
      }
      freshestMs = Math.max(freshestMs, stat.mtimeMs);
      files.push(file);
    }

    const recoveryAgeMs = Math.max(staleMs ?? 0, RESERVATION_RECOVERY_MIN_AGE_MS);
    if (now - freshestMs < recoveryAgeMs) return 'skipped';
    if (!samePathIdentity(root, rootIdentity, true) || !samePathIdentity(home, homeIdentity, true) || readMeta(id)) {
      return 'refused';
    }
    for (const file of files) {
      if (!safelyUnlinkReservationFile(file)) return 'refused';
    }
    if (readdirSync(home).length !== 0 || !samePathIdentity(home, homeIdentity, true)) return 'refused';
    rmdirSync(home);
    if (existsSync(home)) return 'error';
    audit({
      action: 'sandbox:remove',
      repo: home,
      sandboxId: id,
      summary: 'reclaimed incomplete pre-effect sandbox reservation',
      result: 'ok',
    });
    return 'complete';
  } catch {
    return 'error';
  } finally {
    releaseCleanupLock(lock);
  }
}

function recoverReservationHomes(
  staleMs: number | undefined,
  now: number,
  result: SandboxSweepResult,
  creationLockHeld: boolean,
): void {
  const root = sandboxesDir();
  if (!ownedDirectoryIdentity(root)) return;
  const creationLock = creationLockHeld ? undefined : acquireCleanupLock('creation');
  if (!creationLockHeld && !creationLock) return;
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SANDBOX_ID_RE.test(entry.name) && readMeta(entry.name) === null)
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_RESERVATION_RECOVERIES_PER_SWEEP);
  } catch {
    releaseCleanupLock(creationLock);
    return;
  }
  try {
    for (const id of ids) {
      const status = recoverReservationHome(id, staleMs, now);
      if (status === 'complete') result.completed.push(id);
      else if (status === 'refused') result.refused.push(id);
      else if (status === 'unavailable') result.unavailable.push(id);
      else if (status === 'error') result.unexpectedErrors.push(id);
    }
  } finally {
    releaseCleanupLock(creationLock);
  }
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
function sweepOrphanSandboxesDetailedInternal(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
  creationLockHeld = false,
): SandboxSweepResult {
  const staleMs = opts?.staleMs;
  const now = Date.now();
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
  const authority = acquireSandboxCleanupAuthority(opts);
  try {
    if (authority.allowed) recoverReservationHomes(staleMs, now, result, creationLockHeld);
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
      if (!authority.allowed) {
        result.unavailable.push(sb.id);
        continue;
      }
      try {
        const cleanup = removeSandbox(sb, { borrowedAuthority: authority.token });
        result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
      } catch {
        // removeSandbox is already best-effort/idempotent and should not throw;
        // guard anyway so one bad entry never aborts the whole restart sweep.
        result.unexpectedErrors.push(sb.id);
      }
    }
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
  return result;
}

export function sweepOrphanSandboxesDetailed(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): SandboxSweepResult {
  return sweepOrphanSandboxesDetailedInternal(opts);
}

function sweepOrphanSandboxesWhileCreationLocked(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): string[] {
  return sweepOrphanSandboxesDetailedInternal(opts, true).completed;
}

export function sweepOrphanSandboxes(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): string[] {
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
export function sweepRepoSandboxesDetailed(
  repo: string,
  opts?: SandboxCleanupAuthorityOptions,
): SandboxSweepResult {
  const target = resolve(repo);
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
  const authority = acquireSandboxCleanupAuthority(opts);
  try {
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
      if (!authority.allowed) {
        result.unavailable.push(sb.id);
        continue;
      }
      try {
        const cleanup = removeSandbox(sb, { borrowedAuthority: authority.token });
        result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
      } catch {
        // removeSandbox is best-effort/idempotent; guard so one bad entry never
        // aborts the whole scoped sweep.
        result.unexpectedErrors.push(sb.id);
      }
    }
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
  return result;
}

export function sweepRepoSandboxes(repo: string, opts?: SandboxCleanupAuthorityOptions): string[] {
  return sweepRepoSandboxesDetailed(repo, opts).completed;
}
