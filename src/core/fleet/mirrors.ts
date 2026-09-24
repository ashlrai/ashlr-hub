/**
 * Fleet mirrors — V3.10 Track B unit U6. SPEC-310B §2 "Mirrors".
 *
 * WHY MIRRORS. Every checkout Mason enrolled is dirty or on a feature branch
 * (ashlr-hub sits on v310-foundation; phantom-secrets has 176 dirty files).
 * An autonomous fleet working there would (a) trip every "unprovable-dirty"
 * post-merge check, (b) leave `update-ref` on a branch he has checked out
 * with his working tree out of sync, and (c) run daemon git inside a tree
 * whose `.git/config` his own tools — and any agent worktree linked to it —
 * can write. So the fleet works ONLY in its own clones:
 *
 *     ~/.ashlr/fleet/mirrors/<owner>__<repo>      (0700)
 *
 * one per repo in the standing grant, reset to `origin/<base>` every tick so
 * it is never dirty, created automatically, and never linked to — never even
 * read from — Mason's checkouts. Autonomous enrollment is exactly the grant's
 * repo list, as mirror paths (`planAutonomousEnrollment`).
 *
 * WHY ENROLLMENT IS A LANE, NOT A REWRITE (3.10 R3f). The autonomous lane is a
 * VIEW of the registry — the enrolled fleet mirrors — not the registry itself:
 *   - the standing daemon runs inside `narrowToAutonomousLane()` (an async-
 *     scoped, read-only lens in sandbox/policy.ts), so every enrolled read it
 *     makes — backlog, self-heal, the post-merge gate, sandbox creation's
 *     assertMayMutate — sees only mirrors, exactly as if the registry held
 *     nothing else;
 *   - reconcile only ADDS the grant's mirrors and only REMOVES fleet mirrors
 *     that left the grant. Mason's own enrolled checkouts are never
 *     unenrolled: ~/.ashlr/enrollment.json is shared with Verse, the MCP
 *     tools, inbox apply, knowledge / quality scans and the CLI, and a grant
 *     must not switch those off for his repos (U6's first cut did, and
 *     nothing restored them when the grant ended).
 * The one registry write that remains — mirror paths — is required because
 * isEnrolled is the sandbox gate every autonomous mutation passes. It is
 * visible (each reconcile writes a `daemon:autonomous-enrollment` audit row;
 * `ashlr mirror reconcile` lists the checkouts it leaves alone) and
 * reversible (`ashlr mirror release --apply` unenrolls every mirror and
 * nothing else; `ashlr mirror remove` drops one).
 *
 * WHY THE GIT HERE IS PARANOID. An agent's sandbox worktree is linked to its
 * mirror, and a linked worktree shares the mirror's `.git/config` and
 * `.git/hooks`: an agent that runs `git config core.fsmonitor <cmd>` or plants
 * a filter driver would get code execution the next time the DAEMON runs git
 * in the mirror — unconfined. So every mirror git call here:
 *   - runs with a minimal env (no inherited GIT_DIR / GIT_WORK_TREE / …),
 *     no system or global config, no terminal prompt, no askpass;
 *   - forces core.hooksPath=/dev/null and core.fsmonitor=false on the command
 *     line (command scope beats repo config);
 *   - allows only the https transport (a planted `ext::` / file remote cannot
 *     run or read anything);
 *   - and every sync REWRITES `.git/config` from a fixed template, which
 *     drops any filter driver, credential helper, alias, include or remote
 *     an agent added. The mirror is ours; nothing in its config is worth
 *     keeping.
 *   - 3.10 integration (INT4, B-U6 request 5): every call INSIDE a mirror goes
 *     through sandbox/safe-git.ts (layout 'repo'): `.git` is verified to be
 *     the mirror's own directory before git runs, git is the trusted absolute
 *     binary (never a PATH lookup a user-level process could plant), the env
 *     is built from nothing, gitattributes come from the empty tree (no filter
 *     or diff driver an agent routes a file to can run), and the token rides
 *     only in the child's env for github.com. The two calls with no mirror yet
 *     (`init`, `ls-remote`) keep the command-line hardening below with the
 *     same trusted binary.
 *
 * CONCURRENCY. Clone and sync take the mirror's repo lease
 * (sandbox/execution-leases.ts) — the same lease sandbox creation, proposal
 * filing and ref/push take — so a reset never interleaves with an agent's
 * `git worktree add` or a fleet push. Resetting the mirror's own working tree
 * does not disturb running agents: their worktrees live under
 * ~/.ashlr/sandboxes, not inside the mirror.
 *
 * CREDENTIALS. Public repos fetch anonymously. For private repos the fetch
 * carries a 1-hour, single-repo installation token from the custody helper
 * (`githubToken`, U2), passed as an `http.extraheader` through GIT_CONFIG_*
 * env vars — never argv (visible in `ps`), never written to disk, never
 * logged. When custody is unavailable the fetch is anonymous and a private
 * repo fails with a specific reason.
 *
 * DEPENDENCIES (3.10 review c0). A clone has no toolchain, yet G3 verifies
 * and the post-merge watch re-tests IN the mirror (inbox/merge.ts
 * linkNodeModules and post-merge-watch.ts symlink `<mirror>/node_modules`
 * into their worktrees and re-allow reading it under confinement). Without
 * it `vitest` / `tsc` exit 127, G3 answers `wait` (verify-infra) forever and
 * nothing a Node repo proposes can ever merge. So after every successful
 * reset the daemon — a TRUSTED step, never an agent — installs the repo's
 * dependencies from its COMMITTED lockfile (npm / pnpm / yarn / bun, frozen,
 * lifecycle scripts off) into `<mirror>/node_modules`, and only when the
 * lockfile hash changed since the last good install (`MirrorState.deps`).
 * `git clean` excludes `node_modules` so the reset does not wipe them each
 * tick; a changed lockfile (or a node_modules that is not the directory we
 * installed) gets a FULL clean first, so nothing stale or planted survives
 * a reinstall. A repo whose install fails — or that declares dependencies
 * with no lockfile, or with ambiguous lockfiles — is NOT current: its sync
 * fails with the reason, which pauses the repo (fail closed, never a guess).
 *
 * NOTHING HERE RUNS BY ITSELF. The daemon calls `prepareMirrorsForTick` from
 * its beforeTick hook (U5) only under a live standing policy; `ashlr mirror`
 * (src/cli/mirror.ts) is Mason's manual surface.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EffectivePolicy } from '../authority/types.js';
import { withRepoLease, countLiveExecutionLeases } from '../sandbox/execution-leases.js';
import { resolveGitExecutable, runSafeGit, SafeGitError } from '../sandbox/safe-git.js';
import {
  canonicalEnrollmentPath,
  enroll,
  killSwitchOn,
  listEnrolled,
  narrowEnrollmentScope,
  runWithEnrollmentLens,
  unenrollAndDrain,
  type EnrollmentLens,
} from '../sandbox/policy.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Clone / fetch budget. A first clone of a large repo is the slow case. */
export const MIRROR_NETWORK_TIMEOUT_MS = 10 * 60_000;
/** Local git operations (checkout, clean, rev-parse). */
export const MIRROR_LOCAL_TIMEOUT_MS = 2 * 60_000;
/** How long a mirror operation waits for the repo lease (agents hold it for seconds). */
export const MIRROR_LEASE_WAIT_MS = 5 * 60_000;
/** Mirrors synced in parallel by `prepareMirrorsForTick` (network-bound, but gentle on the machine). */
export const MIRROR_TICK_CONCURRENCY = 2;
/** A lockfile install (first install of a large monorepo is the slow case). */
export const MIRROR_DEPS_INSTALL_TIMEOUT_MS = 10 * 60_000;
/**
 * After a failed install for a given lockfile, how long later syncs report the
 * recorded failure instead of re-running the same doomed install every tick.
 * A new lockfile (a fix landed) retries at once.
 */
export const MIRROR_DEPS_RETRY_MS = 30 * 60_000;
/**
 * Directories `git clean` must leave alone: the installed dependencies. The
 * pattern is unanchored on purpose — workspace installs (pnpm, npm
 * workspaces) put `node_modules` inside packages too.
 */
export const MIRROR_DEPENDENCY_DIRS: readonly string[] = Object.freeze(['node_modules']);

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_SEPARATOR = '__';
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Identity and paths
// ---------------------------------------------------------------------------

export interface RepoIdentity {
  owner: string;
  name: string;
  /** `owner/name`, exactly as validated. */
  nameWithOwner: string;
}

/**
 * Parse a GitHub `owner/name`. Strict on purpose: the result becomes a
 * directory name and part of a URL, so anything GitHub itself would refuse
 * (and every path trick: `..`, separators, a leading dash) is refused here.
 */
export function parseNameWithOwner(value: unknown): RepoIdentity | null {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, rawName] = parts as [string, string];
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (!OWNER_RE.test(owner) || owner.endsWith('-')) return null;
  if (!NAME_RE.test(name) || name === '.' || name === '..' || name.startsWith('-')) return null;
  // The slug joins owner and name with `__`; an owner cannot contain `_`, so
  // the split back is unambiguous.
  return { owner, name, nameWithOwner: `${owner}/${name}` };
}

function requireIdentity(nameWithOwner: string): RepoIdentity {
  const identity = parseNameWithOwner(nameWithOwner);
  if (!identity) throw new Error(`not a GitHub owner/name: ${JSON.stringify(String(nameWithOwner).slice(0, 120))}`);
  return identity;
}

function canonicalHome(): string {
  const home = homedir();
  if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) {
    throw new Error('invalid home directory for fleet mirrors');
  }
  return resolve(home);
}

/** ~/.ashlr/fleet/mirrors */
export function fleetMirrorsRoot(): string {
  return join(canonicalHome(), '.ashlr', 'fleet', 'mirrors');
}

/** ~/.ashlr/fleet/mirror-state — one small JSON record per mirror, outside the clone (agents can reach the clone's tree). */
export function mirrorStateRoot(): string {
  return join(canonicalHome(), '.ashlr', 'fleet', 'mirror-state');
}

/** `owner__name` */
export function mirrorSlug(nameWithOwner: string): string {
  const { owner, name } = requireIdentity(nameWithOwner);
  return `${owner}${SLUG_SEPARATOR}${name}`;
}

/** The fleet's clone of `owner/name`. */
export function mirrorPathFor(nameWithOwner: string): string {
  return join(fleetMirrorsRoot(), mirrorSlug(nameWithOwner));
}

function slugToIdentity(slug: string): RepoIdentity | null {
  const at = slug.indexOf(SLUG_SEPARATOR);
  if (at <= 0) return null;
  const identity = parseNameWithOwner(`${slug.slice(0, at)}/${slug.slice(at + SLUG_SEPARATOR.length)}`);
  return identity && `${identity.owner}${SLUG_SEPARATOR}${identity.name}` === slug ? identity : null;
}

/**
 * Inverse of `mirrorPathFor`: the `owner/name` a path is the mirror of, or
 * null when it is not exactly a mirror directory (a Mason checkout, a path
 * inside a mirror, the mirrors root itself …). Compares canonical paths, so a
 * symlinked spelling of a mirror still resolves.
 */
export function mirrorNameForPath(path: string): string | null {
  let root: string;
  try {
    root = fleetMirrorsRoot();
  } catch {
    return null;
  }
  const candidates = new Set<string>([resolve(path)]);
  const canonical = canonicalEnrollmentPath(path);
  if (canonical) candidates.add(canonical);
  const roots = new Set<string>([root]);
  const canonicalRoot = canonicalEnrollmentPath(root);
  if (canonicalRoot) roots.add(canonicalRoot);
  for (const candidate of candidates) {
    for (const base of roots) {
      const rel = relative(base, candidate);
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) continue;
      const identity = slugToIdentity(rel);
      if (identity) return identity.nameWithOwner;
    }
  }
  return null;
}

/** mirrorPathFor, or '' when HOME is unusable (for results that must never throw). */
function safeMirrorPath(nameWithOwner: string): string {
  try {
    return mirrorPathFor(nameWithOwner);
  } catch {
    return '';
  }
}

export function isMirrorPath(path: string): boolean {
  return mirrorNameForPath(path) !== null;
}

/** The only production origin: GitHub over https. */
export function githubOriginUrl(nameWithOwner: string): string {
  const { owner, name } = requireIdentity(nameWithOwner);
  return `https://github.com/${owner}/${name}.git`;
}

/** Lease key for a mirror — the same canonical form sandboxed-engine uses for the repo. */
export function mirrorLeaseKey(mirrorPath: string): string {
  return canonicalEnrollmentPath(mirrorPath) ?? resolve(mirrorPath);
}

// ---------------------------------------------------------------------------
// Hardened git
// ---------------------------------------------------------------------------

export interface MirrorDeps {
  /**
   * Origin URL override. Production leaves this unset and always uses
   * `https://github.com/<owner>/<name>.git`; tests point it at a local bare
   * repo (which also needs `allowLocalOrigin`).
   */
  originUrlFor?: (nameWithOwner: string) => string;
  /** Permit a file:// or absolute-path origin (tests only; production is https-only). */
  allowLocalOrigin?: boolean;
  /**
   * Short-lived token for `nameWithOwner`, or null for an anonymous fetch.
   * Default: the custody helper's single-repo installation token (U2); any
   * failure there means anonymous. SECRET — only ever placed in a child env.
   */
  githubToken?: (nameWithOwner: string) => Promise<string | null>;
  /** Clock for state records (tests). */
  now?: () => Date;
  /** Cancels waits and in-flight git (the child is killed). */
  signal?: AbortSignal;
  /** Repo-lease wait override (tests). */
  leaseWaitMs?: number;
  /**
   * Runs one dependency install (tests inject a fake; production spawns the
   * package manager — `installMirrorDependencies`). Never throws; the result
   * says what happened.
   */
  installDependencies?: (plan: MirrorDependencyInstallPlan, mirrorPath: string, signal?: AbortSignal) => Promise<MirrorInstallRun>;
}

interface GitRun {
  ok: boolean;
  stdout: string;
  /** Scrubbed, bounded. */
  stderr: string;
  code: number | null;
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * The env every mirror git call gets: built from scratch, never inherited
 * wholesale, so a GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_SSH_COMMAND /
 * credential variable in the daemon's own env cannot redirect or observe it.
 */
function mirrorGitEnv(token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'SystemRoot']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_PAGER: 'cat',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  if (token) {
    // Command-scope config through the environment: not in argv (ps), not on
    // disk, gone when the child exits. Scoped to github.com only.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 =
      `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
  }
  return env;
}

function hardeningArgs(allowLocalOrigin: boolean): string[] {
  return [
    '-c', `core.hooksPath=${NULL_DEVICE}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'credential.helper=',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    ...(allowLocalOrigin ? ['-c', 'protocol.file.allow=always'] : []),
    '-c', 'submodule.recurse=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
    '-c', 'advice.detachedHead=false',
  ];
}

function boundedScrub(text: string): string {
  const scrubbed = scrubSecrets(text).replace(/AUTHORIZATION:[^\n]*/gi, 'AUTHORIZATION: [redacted]');
  const trimmed = scrubbed.trim();
  return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}

function runGit(
  args: readonly string[],
  opts: {
    cwd?: string;
    token?: string | null;
    timeoutMs: number;
    allowLocalOrigin: boolean;
    signal?: AbortSignal;
  },
): Promise<GitRun> {
  return new Promise((resolveRun) => {
    if (opts.signal?.aborted) {
      resolveRun({ ok: false, stdout: '', stderr: 'cancelled', code: null });
      return;
    }
    let gitBin: string;
    try {
      // The trusted absolute git (outside HOME, not group/world-writable): a
      // `git` planted earlier on the daemon's PATH never runs here.
      gitBin = resolveGitExecutable();
    } catch (error) {
      resolveRun({ ok: false, stdout: '', stderr: boundedScrub((error as Error).message), code: null });
      return;
    }
    execFile(
      gitBin,
      [...hardeningArgs(opts.allowLocalOrigin), ...args],
      {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: mirrorGitEnv(opts.token ?? null),
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
        encoding: 'utf8',
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (error as unknown as { code: number }).code
          : error ? null : 0;
        resolveRun({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: boundedScrub(String(stderr ?? '') || (error ? String(error.message ?? '') : '')),
          code,
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Layout checks and the config template
// ---------------------------------------------------------------------------

function ownedByMe(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

/**
 * Prepare ~/.ashlr/fleet/<dir> as a private directory we own (0700). Refuses a
 * symlink or a foreign-owned directory rather than writing through it.
 */
function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByMe(stat.uid)) {
    throw new Error(`refusing unsafe fleet directory ${path}`);
  }
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

type LayoutVerdict =
  | { state: 'missing' }
  | { state: 'mirror' }
  | { state: 'invalid'; reason: string };

/**
 * Is `path` a mirror we made? A real directory we own, holding a real `.git`
 * DIRECTORY (not a gitfile pointing elsewhere, not a symlink) that is a
 * primary repository (no `commondir`).
 */
function inspectMirrorLayout(path: string): LayoutVerdict {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'invalid', reason: `cannot inspect: ${(error as Error).message}` };
  }
  if (stat.isSymbolicLink()) return { state: 'invalid', reason: 'mirror path is a symlink' };
  if (!stat.isDirectory()) return { state: 'invalid', reason: 'mirror path is not a directory' };
  if (!ownedByMe(stat.uid)) return { state: 'invalid', reason: 'mirror directory is not owned by this user' };
  let gitStat;
  try {
    gitStat = lstatSync(join(path, '.git'));
  } catch {
    return { state: 'invalid', reason: 'no .git directory' };
  }
  if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) {
    return { state: 'invalid', reason: '.git is not a real directory' };
  }
  if (existsSync(join(path, '.git', 'commondir'))) {
    return { state: 'invalid', reason: '.git belongs to a linked worktree' };
  }
  return { state: 'mirror' };
}

/**
 * The whole of a mirror's `.git/config`, rewritten on every sync. Anything an
 * agent (or anyone) added — filter drivers, credential helpers, aliases,
 * includes, extra remotes, fsmonitor, hooksPath — is dropped.
 */
function mirrorConfigText(originUrl: string, base: string): string {
  return [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    `\thooksPath = ${NULL_DEVICE}`,
    '\tfsmonitor = false',
    '[gc]',
    '\tauto = 0',
    '[maintenance]',
    '\tauto = false',
    '[remote "origin"]',
    `\turl = ${originUrl}`,
    `\tfetch = +refs/heads/${base}:refs/remotes/origin/${base}`,
    '',
  ].join('\n');
}

function writeMirrorConfig(mirrorPath: string, originUrl: string, base: string): void {
  const gitDir = join(mirrorPath, '.git');
  const target = join(gitDir, 'config');
  const temporary = join(gitDir, `config.ashlr-${randomBytes(6).toString('hex')}.tmp`);
  writePrivateFileAtomically(temporary, target, mirrorConfigText(originUrl, base), {
    anchorPath: gitDir,
    label: 'fleet mirror git config',
  });
}

/**
 * The hooks directory is inert (hooksPath is forced), but an empty one keeps
 * a later reader — a human running plain `git` in the mirror — safe too.
 */
function clearMirrorHooks(mirrorPath: string): void {
  const hooks = join(mirrorPath, '.git', 'hooks');
  try {
    const stat = lstatSync(hooks);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      rmSync(hooks, { force: true, recursive: false });
      return;
    }
    for (const entry of readdirSync(hooks)) {
      rmSync(join(hooks, entry), { force: true, recursive: true });
    }
  } catch {
    // absent is the goal
  }
}

// ---------------------------------------------------------------------------
// State records
// ---------------------------------------------------------------------------

export interface MirrorState {
  v: 1;
  nameWithOwner: string;
  path: string;
  /** Default branch the mirror tracks; null until first resolved. */
  base: string | null;
  /** Credential-free origin URL. */
  originUrl: string;
  createdAt: string;
  lastSyncAt: string | null;
  /** null = never synced. */
  lastSyncOk: boolean | null;
  /** HEAD after the last successful sync; null = unknown. */
  headSha: string | null;
  /** Scrubbed; null after a successful sync. */
  lastError: string | null;
  /** How the last fetch authenticated. */
  lastAuth: 'token' | 'anonymous' | null;
  /** The mirror's installed dependencies (review c0); null = never prepared. */
  deps?: MirrorDepsState | null;
}

/**
 * What the daemon last installed into `<mirror>/node_modules`. Kept OUTSIDE
 * the clone (agents can reach the clone's tree, never mirror-state).
 */
export interface MirrorDepsState {
  /** 'installed' = node_modules matches `key`; 'none' = nothing to install; 'failed' = the install for `key` failed. */
  status: 'installed' | 'none' | 'failed';
  manager: MirrorPackageManager | null;
  /** sha256 over the manager, argv, lockfile and root package.json; null for 'none'. */
  key: string | null;
  at: string;
  /** Identity of the node_modules directory we installed (a swapped directory is reinstalled). */
  nodeModulesIno: number | null;
  nodeModulesMtimeMs: number | null;
  /** Scrubbed; null unless 'failed'. */
  error: string | null;
}

function statePath(nameWithOwner: string): string {
  return join(mirrorStateRoot(), `${mirrorSlug(nameWithOwner)}.json`);
}

export function readMirrorState(nameWithOwner: string): MirrorState | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(nameWithOwner), 'utf8')) as Partial<MirrorState>;
    if (raw?.v !== 1 || raw.nameWithOwner !== requireIdentity(nameWithOwner).nameWithOwner) return null;
    return {
      v: 1,
      nameWithOwner: raw.nameWithOwner,
      path: typeof raw.path === 'string' ? raw.path : mirrorPathFor(nameWithOwner),
      base: typeof raw.base === 'string' && BRANCH_RE.test(raw.base) ? raw.base : null,
      originUrl: typeof raw.originUrl === 'string' ? raw.originUrl : githubOriginUrl(nameWithOwner),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      lastSyncAt: typeof raw.lastSyncAt === 'string' ? raw.lastSyncAt : null,
      lastSyncOk: typeof raw.lastSyncOk === 'boolean' ? raw.lastSyncOk : null,
      headSha: typeof raw.headSha === 'string' && SHA_RE.test(raw.headSha) ? raw.headSha : null,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
      lastAuth: raw.lastAuth === 'token' || raw.lastAuth === 'anonymous' ? raw.lastAuth : null,
      deps: parseDepsState(raw.deps),
    };
  } catch {
    return null;
  }
}

function parseDepsState(raw: unknown): MirrorDepsState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['status'] !== 'installed' && r['status'] !== 'none' && r['status'] !== 'failed') return null;
  const manager = typeof r['manager'] === 'string' && (PACKAGE_MANAGERS as readonly string[]).includes(r['manager'])
    ? r['manager'] as MirrorPackageManager
    : null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    status: r['status'],
    manager,
    key: typeof r['key'] === 'string' && /^[0-9a-f]{64}$/.test(r['key']) ? r['key'] : null,
    at: typeof r['at'] === 'string' && Number.isFinite(Date.parse(r['at'])) ? r['at'] : new Date(0).toISOString(),
    nodeModulesIno: num(r['nodeModulesIno']),
    nodeModulesMtimeMs: num(r['nodeModulesMtimeMs']),
    error: typeof r['error'] === 'string' ? r['error'].slice(0, 600) : null,
  };
}

function writeMirrorState(state: MirrorState): void {
  const root = mirrorStateRoot();
  ensurePrivateDir(join(canonicalHome(), '.ashlr', 'fleet'));
  ensurePrivateDir(root);
  const target = statePath(state.nameWithOwner);
  writePrivateFileAtomically(
    join(root, `.${mirrorSlug(state.nameWithOwner)}.${randomBytes(6).toString('hex')}.tmp`),
    target,
    `${JSON.stringify(state, null, 2)}\n`,
    { anchorPath: root, label: 'fleet mirror state' },
  );
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface MirrorSyncResult {
  ok: boolean;
  nameWithOwner: string;
  path: string;
  /** Branch the mirror tracks; null when it could not be determined. */
  base: string | null;
  /** HEAD after the sync; null on failure. */
  headSha: string | null;
  /** This call cloned the mirror. */
  created: boolean;
  /** HEAD moved (or the mirror was created). */
  changed: boolean;
  /** A previous directory at the mirror path was not a valid mirror and was moved aside. */
  quarantinedTo: string | null;
  auth: 'token' | 'anonymous' | null;
  /** One specific sentence. Scrubbed. */
  reason: string;
  durationMs: number;
}

/**
 * Minted installation tokens, in memory only, reused until 5 minutes before
 * they expire. WHY: the tick syncs every grant repo every minute; minting a
 * fresh token per repo per tick would be ~500 helper execs and GitHub token
 * requests an hour for no added safety (each token is already 1 h, one repo).
 */
const tokenCache = new Map<string, { token: string; reuseUntilMs: number }>();
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;
/** When the helper does not say when a token expires, reuse it this long at most. */
const TOKEN_UNKNOWN_EXPIRY_REUSE_MS = 10 * 60_000;

async function defaultGithubToken(nameWithOwner: string): Promise<string | null> {
  const cached = tokenCache.get(nameWithOwner);
  if (cached && Date.now() < cached.reuseUntilMs) return cached.token;
  tokenCache.delete(nameWithOwner);
  try {
    const { githubToken } = await import('../authority/custody-client.js');
    const minted = await githubToken(nameWithOwner);
    if (typeof minted?.token !== 'string' || minted.token.length === 0) return null;
    const expiresMs = minted.expiresAt ? Date.parse(minted.expiresAt) : Number.NaN;
    const reuseUntilMs = Number.isFinite(expiresMs)
      ? expiresMs - TOKEN_REUSE_MARGIN_MS
      : Date.now() + TOKEN_UNKNOWN_EXPIRY_REUSE_MS;
    if (reuseUntilMs > Date.now()) tokenCache.set(nameWithOwner, { token: minted.token, reuseUntilMs });
    return minted.token;
  } catch {
    // No custody helper (not installed, not implemented, no App key): anonymous.
    return null;
  }
}

function resolveOrigin(nameWithOwner: string, deps: MirrorDeps): { url: string } | { error: string } {
  const url = deps.originUrlFor ? deps.originUrlFor(nameWithOwner) : githubOriginUrl(nameWithOwner);
  if (/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(url)) return { url };
  if (deps.allowLocalOrigin === true && (url.startsWith('file://') || isAbsolute(url))) return { url };
  return { error: `origin ${JSON.stringify(url.slice(0, 120))} is not an allowed https://github.com URL` };
}

async function resolveRemoteDefaultBranch(
  originUrl: string,
  token: string | null,
  deps: MirrorDeps,
): Promise<{ base: string } | { error: string }> {
  const listed = await runGit(['ls-remote', '--symref', originUrl, 'HEAD'], {
    token,
    timeoutMs: MIRROR_NETWORK_TIMEOUT_MS,
    allowLocalOrigin: deps.allowLocalOrigin === true,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!listed.ok) return { error: `could not read the remote default branch: ${listed.stderr || 'git ls-remote failed'}` };
  const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout);
  const base = match?.[1];
  if (!base || !BRANCH_RE.test(base)) return { error: 'the remote did not report a usable default branch' };
  return { base };
}

/** Move an invalid directory at a mirror path aside (never delete what we did not verify we made). */
function quarantineInvalidMirror(path: string): string {
  const trash = join(fleetMirrorsRoot(), '.trash');
  ensurePrivateDir(trash);
  const target = join(trash, `${relative(fleetMirrorsRoot(), path)}-${Date.now()}-${randomBytes(3).toString('hex')}`);
  renameSync(path, target);
  return target;
}

interface SyncContext {
  identity: RepoIdentity;
  path: string;
  originUrl: string;
  token: string | null;
  deps: MirrorDeps;
}

/**
 * One git call inside an existing mirror, through safe-git (layout 'repo').
 * A refusal (`.git` is not the mirror's own directory, no trustworthy git, a
 * malformed token) is a failed run with the reason — never a throw, and never
 * a fallback to unhardened git.
 */
async function runMirrorRepoGit(
  mirrorPath: string,
  args: readonly string[],
  opts: { token?: string | null; timeoutMs: number; allowLocalOrigin: boolean; signal?: AbortSignal },
): Promise<GitRun> {
  if (opts.signal?.aborted) return { ok: false, stdout: '', stderr: 'cancelled', code: null };
  let workTree: string;
  try {
    // safe-git wants canonical paths; HOME itself may sit behind a symlink
    // (/var → /private/var on macOS temp homes).
    workTree = realpathSync(mirrorPath);
  } catch {
    return { ok: false, stdout: '', stderr: 'the mirror directory is missing', code: null };
  }
  try {
    const run = await runSafeGit({
      workTree,
      gitDir: join(workTree, '.git'),
      layout: 'repo',
      args,
      ...(opts.token ? { auth: { token: opts.token } } : {}),
      ...(opts.allowLocalOrigin ? { allowProtocols: ['file'] as const } : {}),
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: MAX_GIT_OUTPUT,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return {
      ok: run.ok,
      stdout: run.stdout,
      stderr: boundedScrub(run.stderr || (run.timedOut ? 'git timed out' : run.ok ? '' : `git exited ${String(run.code ?? run.signal)}`)),
      code: run.code,
    };
  } catch (error) {
    const message = error instanceof SafeGitError ? error.message : `safe-git failed: ${(error as Error).message}`;
    return { ok: false, stdout: '', stderr: boundedScrub(message), code: null };
  }
}

async function git(ctx: SyncContext, args: readonly string[], network = false): Promise<GitRun> {
  return runMirrorRepoGit(ctx.path, args, {
    token: network ? ctx.token : null,
    timeoutMs: network ? MIRROR_NETWORK_TIMEOUT_MS : MIRROR_LOCAL_TIMEOUT_MS,
    allowLocalOrigin: ctx.deps.allowLocalOrigin === true,
    ...(ctx.deps.signal ? { signal: ctx.deps.signal } : {}),
  });
}

/** Fetch `base` and hard-reset the mirror's working tree to it. Returns HEAD. */
async function fetchAndReset(ctx: SyncContext, base: string): Promise<{ headSha: string } | { error: string }> {
  // The config is rewritten BEFORE any git reads it in this sync.
  writeMirrorConfig(ctx.path, ctx.originUrl, base);
  clearMirrorHooks(ctx.path);
  const remoteRef = `refs/remotes/origin/${base}`;
  const fetched = await git(ctx, ['fetch', '--quiet', '--no-tags', '--prune', '--no-recurse-submodules',
    'origin', `+refs/heads/${base}:${remoteRef}`], true);
  if (!fetched.ok) return { error: `fetch of ${base} failed: ${fetched.stderr || 'git fetch failed'}` };
  const checkout = await git(ctx, ['checkout', '--quiet', '--force', '--no-recurse-submodules', '-B', base, remoteRef]);
  if (!checkout.ok) return { error: `reset to origin/${base} failed: ${checkout.stderr || 'git checkout failed'}` };
  const reset = await git(ctx, ['reset', '--quiet', '--hard', remoteRef]);
  if (!reset.ok) return { error: `reset to origin/${base} failed: ${reset.stderr || 'git reset failed'}` };
  // -ff also removes nested repositories an agent might have planted. The
  // installed dependencies are excluded (`-e` still applies under -x): wiping
  // them every tick is what left G3 without a toolchain (review c0). They are
  // re-validated right after the reset (`prepareMirrorDependencies`), and a
  // reinstall starts from a FULL clean (`cleanAll`).
  const clean = await git(ctx, ['clean', '-ffdxq', ...MIRROR_DEPENDENCY_DIRS.flatMap((dir) => ['-e', dir])]);
  if (!clean.ok) return { error: `clean failed: ${clean.stderr || 'git clean failed'}` };
  // Drops admin entries of sandbox worktrees whose directories are gone
  // (crash leftovers); live worktrees are untouched.
  await git(ctx, ['worktree', 'prune']);
  const head = await git(ctx, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const sha = head.stdout.trim();
  if (!head.ok || !SHA_RE.test(sha)) return { error: 'could not read HEAD after reset' };
  return { headSha: sha };
}

async function cloneInto(ctx: SyncContext, base: string): Promise<{ headSha: string } | { error: string }> {
  const root = fleetMirrorsRoot();
  const staging = join(root, `.${mirrorSlug(ctx.identity.nameWithOwner)}.clone-${randomBytes(6).toString('hex')}`);
  // `init --template=` creates NO hooks directory at all; fetch + checkout
  // then populate it exactly like a clone would, minus every template hook.
  const init = await runGit(['init', '--quiet', '--template=', staging], {
    timeoutMs: MIRROR_LOCAL_TIMEOUT_MS,
    allowLocalOrigin: ctx.deps.allowLocalOrigin === true,
    ...(ctx.deps.signal ? { signal: ctx.deps.signal } : {}),
  });
  if (!init.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { error: `git init failed: ${init.stderr || 'unknown error'}` };
  }
  if (process.platform !== 'win32') chmodSync(staging, 0o700);
  const staged = await fetchAndReset({ ...ctx, path: staging }, base);
  if ('error' in staged) {
    rmSync(staging, { recursive: true, force: true });
    return staged;
  }
  // Publish atomically: a half-cloned mirror is never visible at the real path.
  try {
    renameSync(staging, ctx.path);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { error: `could not publish the clone: ${(error as Error).message}` };
  }
  return staged;
}

// ---------------------------------------------------------------------------
// Dependencies (review c0) — see "DEPENDENCIES" in the header
// ---------------------------------------------------------------------------

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type MirrorPackageManager = typeof PACKAGE_MANAGERS[number];

/** Root lockfiles by manager, in the order they are looked for. */
const LOCKFILES: Readonly<Record<MirrorPackageManager, readonly string[]>> = Object.freeze({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
});

export interface MirrorDependencyInstallPlan {
  kind: 'install';
  manager: MirrorPackageManager;
  /** Lockfile name at the mirror root. */
  lockfile: string;
  /** Binary name looked up on the daemon's PATH, then its arguments. */
  argv: readonly string[];
  /** sha256 over manager, argv, lockfile and root package.json — a new key means a reinstall. */
  key: string;
}

export type MirrorDependencyPlan =
  | MirrorDependencyInstallPlan
  | { kind: 'none'; reason: string }
  | { kind: 'refuse'; reason: string };

export interface MirrorInstallRun {
  ok: boolean;
  /** One scrubbed sentence. */
  reason: string;
}

function readRootFile(root: string, name: string, maxBytes = 64 * 1024 * 1024): Buffer | null {
  try {
    const path = join(root, name);
    const stat = lstatSync(path);
    // A symlinked lockfile could point anywhere; the committed file is a regular file.
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function declaresDependencies(pkg: Record<string, unknown>): boolean {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = pkg[field];
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) return true;
  }
  const workspaces = pkg['workspaces'];
  return Array.isArray(workspaces) ? workspaces.length > 0 : !!(workspaces && typeof workspaces === 'object');
}

/**
 * Which install (if any) the mirror at `root` needs. Pure over the tree:
 *   - no root package.json → nothing to install;
 *   - `packageManager` names the manager, else exactly one manager's lockfile
 *     must be committed (several is ambiguous → refuse, never guess);
 *   - dependencies with no lockfile → refuse: the fleet installs only
 *     lockfile-pinned versions (an unpinned install is a different tree than
 *     the one CI and Mason test).
 * Every install is frozen (the lockfile is never rewritten) and runs with
 * lifecycle scripts OFF: the daemon runs unconfined, and a dependency's
 * postinstall is exactly the supply-chain code it must not execute.
 */
export function planMirrorDependencies(root: string): MirrorDependencyPlan {
  const pkgRaw = readRootFile(root, 'package.json', 4 * 1024 * 1024);
  if (!pkgRaw) return { kind: 'none', reason: 'no package.json at the repo root' };
  let pkg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(pkgRaw.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'refuse', reason: 'package.json is not a JSON object' };
    pkg = parsed as Record<string, unknown>;
  } catch {
    return { kind: 'refuse', reason: 'package.json is not valid JSON' };
  }
  const present = PACKAGE_MANAGERS
    .map((manager) => ({ manager, lockfile: LOCKFILES[manager].find((name) => existsSync(join(root, name))) ?? null }))
    .filter((row): row is { manager: MirrorPackageManager; lockfile: string } => row.lockfile !== null);
  const declared = typeof pkg['packageManager'] === 'string' ? /^([a-z]+)@(\d+)/.exec(pkg['packageManager']) : null;
  let chosen: { manager: MirrorPackageManager; lockfile: string } | null = null;
  if (declared) {
    const name = declared[1] as string;
    if (!(PACKAGE_MANAGERS as readonly string[]).includes(name)) {
      return { kind: 'refuse', reason: `package.json names packageManager ${name}, which the fleet cannot install with` };
    }
    chosen = present.find((row) => row.manager === name) ?? null;
    if (!chosen) {
      if (!declaresDependencies(pkg)) return { kind: 'none', reason: 'package.json declares no dependencies' };
      return { kind: 'refuse', reason: `package.json names packageManager ${name} but its lockfile (${LOCKFILES[name as MirrorPackageManager].join(' / ')}) is not committed` };
    }
  } else if (present.length > 1) {
    return {
      kind: 'refuse',
      reason: `several lockfiles are committed (${present.map((row) => row.lockfile).join(', ')}) and package.json names no packageManager, so the install would be a guess`,
    };
  } else if (present.length === 1) {
    chosen = present[0]!;
  } else {
    if (!declaresDependencies(pkg)) return { kind: 'none', reason: 'package.json declares no dependencies' };
    return { kind: 'refuse', reason: 'package.json declares dependencies but no lockfile is committed; the fleet installs only lockfile-pinned dependencies' };
  }
  const lockBytes = readRootFile(root, chosen.lockfile);
  if (!lockBytes) return { kind: 'refuse', reason: `${chosen.lockfile} is not a regular file the fleet can read` };
  const berry = chosen.manager === 'yarn'
    && ((declared !== null && declared[1] === 'yarn' && Number(declared[2]) >= 2) || existsSync(join(root, '.yarnrc.yml')));
  const argv: string[] = (() => {
    switch (chosen.manager) {
      case 'npm':
        return ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'];
      case 'pnpm':
        return ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--config.confirmModulesPurge=false'];
      case 'yarn':
        return berry
          ? ['yarn', 'install', '--immutable', '--mode=skip-build']
          : ['yarn', 'install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive'];
      case 'bun':
        return ['bun', 'install', '--frozen-lockfile', '--ignore-scripts'];
    }
  })();
  const key = createHash('sha256')
    .update(`ashlr:mirror-deps:v1\0${chosen.manager}\0${argv.join(' ')}\0${chosen.lockfile}\0`)
    .update(lockBytes)
    .update('\0')
    .update(pkgRaw)
    .digest('hex');
  return { kind: 'install', manager: chosen.manager, lockfile: chosen.lockfile, argv, key };
}

/**
 * The package manager binary on the daemon's PATH. Only absolute PATH entries
 * count, and never one inside the fleet's own tree (mirrors / sandboxes are
 * where an agent could plant a `npm`): the install runs unconfined.
 */
function resolveManagerBinary(name: string): string | null {
  let fleetRoot: string | null = null;
  try {
    fleetRoot = join(canonicalHome(), '.ashlr');
  } catch {
    fleetRoot = null;
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    if (fleetRoot && (resolve(dir) === fleetRoot || resolve(dir).startsWith(`${fleetRoot}${sep}`))) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** The env an install gets: built from nothing, no git token, prompts and scripts off. */
function installEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SystemRoot']) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    CI: '1',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
    YARN_ENABLE_SCRIPTS: 'false',
    YARN_ENABLE_TELEMETRY: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    DISABLE_OPENCOLLECTIVE: '1',
    ADBLOCK: '1',
  });
  return env;
}

/** Production installer: spawn the planned package manager in the mirror. Never throws. */
export function installMirrorDependencies(
  plan: MirrorDependencyInstallPlan,
  mirrorPath: string,
  signal?: AbortSignal,
): Promise<MirrorInstallRun> {
  return new Promise((resolveRun) => {
    if (signal?.aborted) {
      resolveRun({ ok: false, reason: 'cancelled' });
      return;
    }
    const [name, ...args] = plan.argv;
    const bin = name ? resolveManagerBinary(name) : null;
    if (!bin) {
      resolveRun({ ok: false, reason: `${name ?? 'the package manager'} is not installed on the daemon's PATH, so ${plan.lockfile} cannot be installed` });
      return;
    }
    execFile(bin, args, {
      cwd: mirrorPath,
      env: installEnv(),
      timeout: MIRROR_DEPS_INSTALL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_GIT_OUTPUT,
      windowsHide: true,
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolveRun({ ok: true, reason: `${plan.argv.slice(0, 2).join(' ')} installed ${plan.lockfile}` });
        return;
      }
      const tail = String(stderr ?? '').trim().split('\n').slice(-4).join(' ').trim() || String(error.message ?? '');
      resolveRun({ ok: false, reason: boundedScrub(`${plan.argv.slice(0, 2).join(' ')} failed: ${tail}`) });
    });
  });
}

function nodeModulesIdentity(mirrorPath: string): { ino: number; mtimeMs: number } | 'absent' | 'not-a-directory' {
  try {
    const stat = lstatSync(join(mirrorPath, 'node_modules'));
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'not-a-directory';
    return { ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return 'absent';
  }
}

/**
 * After a reset (under the mirror's lease): make `<mirror>/node_modules` match
 * the committed lockfile, or say exactly why it cannot. Reuses the previous
 * install when its key and directory identity still match; otherwise a FULL
 * clean (nothing stale or planted survives) and a fresh frozen install.
 */
async function prepareMirrorDependencies(
  ctx: SyncContext,
  previous: MirrorDepsState | null,
  nowIso: string,
): Promise<{ ok: true; deps: MirrorDepsState } | { ok: false; deps: MirrorDepsState; error: string }> {
  const plan = planMirrorDependencies(ctx.path);
  const cleanAll = async (): Promise<string | null> => {
    const clean = await git(ctx, ['clean', '-ffdxq']);
    return clean.ok ? null : `clean before the dependency install failed: ${clean.stderr || 'git clean failed'}`;
  };
  const current = nodeModulesIdentity(ctx.path);
  if (plan.kind === 'none' || plan.kind === 'refuse') {
    // Nothing of ours may linger: a node_modules without a plan is stale or planted.
    if (current !== 'absent') {
      const cleaned = await cleanAll();
      if (cleaned) {
        return { ok: false, error: cleaned, deps: { status: 'failed', manager: null, key: null, at: nowIso, nodeModulesIno: null, nodeModulesMtimeMs: null, error: cleaned } };
      }
    }
    if (plan.kind === 'none') {
      return { ok: true, deps: { status: 'none', manager: null, key: null, at: nowIso, nodeModulesIno: null, nodeModulesMtimeMs: null, error: null } };
    }
    const error = `dependencies cannot be installed: ${plan.reason}`;
    return { ok: false, error, deps: { status: 'failed', manager: null, key: null, at: nowIso, nodeModulesIno: null, nodeModulesMtimeMs: null, error } };
  }
  // Directory identity (inode), not mtime: a replaced or re-created
  // node_modules is not the tree we installed, but a tool legitimately
  // touching it must not force a full reinstall every tick. Writes INTO it
  // from agents and verification are denied by confinement (it is outside
  // their worktrees and re-allowed read-only).
  if (previous?.status === 'installed' && previous.key === plan.key
    && ((typeof current === 'object' && current.ino === previous.nodeModulesIno)
      || (current === 'absent' && previous.nodeModulesIno === null))) {
    return { ok: true, deps: previous };
  }
  if (previous?.status === 'failed' && previous.key === plan.key) {
    const failedAt = Date.parse(previous.at);
    const nowMs = Date.parse(nowIso);
    if (Number.isFinite(failedAt) && Number.isFinite(nowMs) && nowMs - failedAt < MIRROR_DEPS_RETRY_MS) {
      const error = previous.error ?? `the ${plan.manager} install for ${plan.lockfile} failed`;
      return { ok: false, error: `${error} (retried after ${new Date(failedAt + MIRROR_DEPS_RETRY_MS).toISOString()} or when the lockfile changes)`, deps: previous };
    }
  }
  const failed = (error: string): { ok: false; deps: MirrorDepsState; error: string } => {
    const scrubbed = boundedScrub(error);
    return {
      ok: false,
      error: scrubbed,
      deps: { status: 'failed', manager: plan.manager, key: plan.key, at: nowIso, nodeModulesIno: null, nodeModulesMtimeMs: null, error: scrubbed },
    };
  };
  const cleaned = await cleanAll();
  if (cleaned) return failed(cleaned);
  const run = await (ctx.deps.installDependencies ?? installMirrorDependencies)(plan, ctx.path, ctx.deps.signal);
  if (!run.ok) {
    // A half-written tree is worse than none: verification would run against it.
    rmSync(join(ctx.path, 'node_modules'), { recursive: true, force: true });
    return failed(`dependencies could not be installed from ${plan.lockfile}: ${run.reason}`);
  }
  const installed = nodeModulesIdentity(ctx.path);
  if (installed === 'not-a-directory') {
    return failed(`${plan.argv.slice(0, 2).join(' ')} finished but node_modules is not a plain directory`);
  }
  // 'absent' is legitimate: a lockfile that pins nothing installs nothing
  // (npm ci creates no node_modules for it) — recorded as ino null.
  // The install must not have rewritten the committed lockfile (frozen flags
  // say it cannot; this proves it) — verification must see origin's tree.
  const after = planMirrorDependencies(ctx.path);
  if (after.kind !== 'install' || after.key !== plan.key) {
    return failed(`the ${plan.manager} install changed ${plan.lockfile} or package.json; the mirror is not origin's tree`);
  }
  return {
    ok: true,
    deps: {
      status: 'installed',
      manager: plan.manager,
      key: plan.key,
      at: nowIso,
      nodeModulesIno: installed === 'absent' ? null : installed.ino,
      nodeModulesMtimeMs: installed === 'absent' ? null : installed.mtimeMs,
      error: null,
    },
  };
}

/**
 * Make sure the fleet's mirror of `nameWithOwner` exists and matches
 * `origin/<base>` exactly: clone it if missing (or if what is at the path is
 * not a valid mirror — that is moved to `.trash`), otherwise fetch and
 * hard-reset. Runs under the mirror's repo lease. Never throws; the result
 * says what happened.
 *
 * `base` defaults to the last base recorded for this mirror, else the
 * remote's default branch.
 */
export async function ensureMirror(
  spec: { nameWithOwner: string; base?: string | null },
  deps: MirrorDeps = {},
): Promise<MirrorSyncResult> {
  const started = Date.now();
  const now = (): string => (deps.now ? deps.now() : new Date()).toISOString();
  const identity = parseNameWithOwner(spec.nameWithOwner);
  const fail = (reason: string, extra: Partial<MirrorSyncResult> = {}): MirrorSyncResult => ({
    ok: false,
    nameWithOwner: identity?.nameWithOwner ?? String(spec.nameWithOwner),
    path: identity ? safeMirrorPath(identity.nameWithOwner) : '',
    base: null,
    headSha: null,
    created: false,
    changed: false,
    quarantinedTo: null,
    auth: null,
    reason: boundedScrub(reason),
    durationMs: Date.now() - started,
    ...extra,
  });
  if (!identity) return fail(`not a GitHub owner/name: ${String(spec.nameWithOwner).slice(0, 120)}`);
  if (spec.base !== undefined && spec.base !== null && !BRANCH_RE.test(spec.base)) {
    return fail(`not a valid branch name: ${JSON.stringify(spec.base.slice(0, 120))}`);
  }
  const origin = resolveOrigin(identity.nameWithOwner, deps);
  if ('error' in origin) return fail(origin.error);

  let path: string;
  try {
    ensurePrivateDir(join(canonicalHome(), '.ashlr', 'fleet'));
    ensurePrivateDir(fleetMirrorsRoot());
    path = mirrorPathFor(identity.nameWithOwner);
  } catch (error) {
    return fail((error as Error).message);
  }

  const leased = await withRepoLease(mirrorLeaseKey(path), async () => {
    const previous = readMirrorState(identity.nameWithOwner);
    const token = await (deps.githubToken ?? defaultGithubToken)(identity.nameWithOwner);
    const auth: MirrorSyncResult['auth'] = token ? 'token' : 'anonymous';
    const ctx: SyncContext = { identity, path, originUrl: origin.url, token, deps };

    let base = spec.base ?? previous?.base ?? null;
    if (base === null) {
      const resolved = await resolveRemoteDefaultBranch(origin.url, token, deps);
      if ('error' in resolved) return fail(resolved.error, { path, auth });
      base = resolved.base;
    }

    let quarantinedTo: string | null = null;
    const layout = inspectMirrorLayout(path);
    let outcome: { headSha: string } | { error: string };
    let created = false;
    if (layout.state === 'mirror') {
      outcome = await fetchAndReset(ctx, base);
    } else {
      if (layout.state === 'invalid') {
        try {
          quarantinedTo = quarantineInvalidMirror(path);
        } catch (error) {
          return fail(`mirror path holds something that is not a mirror (${layout.reason}) and could not be moved aside: ${(error as Error).message}`, { path, base, auth });
        }
      }
      outcome = await cloneInto(ctx, base);
      created = !('error' in outcome);
    }

    const at = now();
    // Review c0: a mirror whose dependencies are not installed is NOT
    // current — G3 and the post-merge watch would run with no toolchain.
    let depsState: MirrorDepsState | null = previous?.deps ?? null;
    if (!('error' in outcome)) {
      const prepared = await prepareMirrorDependencies(ctx, depsState, at);
      depsState = prepared.deps;
      if (!prepared.ok) outcome = { error: prepared.error };
    }
    if ('error' in outcome) {
      try {
        writeMirrorState({
          v: 1,
          nameWithOwner: identity.nameWithOwner,
          path,
          base,
          originUrl: origin.url,
          createdAt: previous?.createdAt ?? at,
          lastSyncAt: at,
          lastSyncOk: false,
          headSha: previous?.headSha ?? null,
          lastError: boundedScrub(outcome.error),
          lastAuth: auth,
          deps: depsState,
        });
      } catch { /* state is advisory; the result carries the failure */ }
      return fail(outcome.error, { path, base, auth, quarantinedTo });
    }
    const changed = created || previous?.headSha !== outcome.headSha;
    try {
      writeMirrorState({
        v: 1,
        nameWithOwner: identity.nameWithOwner,
        path,
        base,
        originUrl: origin.url,
        createdAt: created ? at : previous?.createdAt ?? at,
        lastSyncAt: at,
        lastSyncOk: true,
        headSha: outcome.headSha,
        lastError: null,
        lastAuth: auth,
        deps: depsState,
      });
    } catch { /* advisory */ }
    const result: MirrorSyncResult = {
      ok: true,
      nameWithOwner: identity.nameWithOwner,
      path,
      base,
      headSha: outcome.headSha,
      created,
      changed,
      quarantinedTo,
      auth,
      reason: created
        ? `cloned ${identity.nameWithOwner} at ${base} ${outcome.headSha.slice(0, 12)}`
        : `reset to origin/${base} ${outcome.headSha.slice(0, 12)}${changed ? '' : ' (unchanged)'}`,
      durationMs: Date.now() - started,
    };
    return result;
  }, {
    waitMs: deps.leaseWaitMs ?? MIRROR_LEASE_WAIT_MS,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!leased.ok) return fail(`mirror busy: ${leased.reason}`, { path });
  return { ...leased.value, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Listing and removal
// ---------------------------------------------------------------------------

export interface MirrorStatus {
  nameWithOwner: string;
  path: string;
  /** A valid mirror directory is present. */
  present: boolean;
  /** Layout problem when present but invalid; null when valid or absent. */
  problem: string | null;
  state: MirrorState | null;
}

/** Every mirror directory under the root plus every recorded state, sorted by name. */
export function listMirrors(): MirrorStatus[] {
  const names = new Set<string>();
  try {
    for (const entry of readdirSync(fleetMirrorsRoot())) {
      if (entry.startsWith('.')) continue;
      const identity = slugToIdentity(entry);
      if (identity) names.add(identity.nameWithOwner);
    }
  } catch { /* no mirrors yet */ }
  try {
    for (const entry of readdirSync(mirrorStateRoot())) {
      if (!entry.endsWith('.json') || entry.startsWith('.')) continue;
      const identity = slugToIdentity(entry.slice(0, -5));
      if (identity) names.add(identity.nameWithOwner);
    }
  } catch { /* no state yet */ }
  return [...names].sort().map((nameWithOwner) => {
    const path = mirrorPathFor(nameWithOwner);
    const layout = inspectMirrorLayout(path);
    return {
      nameWithOwner,
      path,
      present: layout.state === 'mirror',
      problem: layout.state === 'invalid' ? layout.reason : null,
      state: readMirrorState(nameWithOwner),
    };
  });
}

export interface MirrorRemoveResult {
  ok: boolean;
  reason: string;
  /** Unenrollment of the mirror path, when it was enrolled. */
  unenrolled: boolean;
}

/**
 * Delete the fleet's mirror of `nameWithOwner` (a regenerable clone) and its
 * state record. Unenrolls and drains the mirror first; refuses while any
 * agent still runs on it, or while sandbox worktrees are linked to it (unless
 * `force`, for crash leftovers — their directories are then orphans the
 * sandbox sweep reclaims).
 */
export async function removeMirror(
  nameWithOwner: string,
  opts: { force?: boolean; drainMs?: number } = {},
): Promise<MirrorRemoveResult> {
  const identity = parseNameWithOwner(nameWithOwner);
  if (!identity) return { ok: false, reason: 'not a GitHub owner/name', unenrolled: false };
  const path = mirrorPathFor(identity.nameWithOwner);
  let unenrolled = false;
  if (listEnrolled().some((repo) => mirrorNameForPath(repo) === identity.nameWithOwner)) {
    const drained = await unenrollAndDrain(path, opts.drainMs !== undefined ? { drainMs: opts.drainMs } : {});
    if (!drained.quiesced) {
      return { ok: false, reason: `could not unenroll the mirror: ${drained.reason}`, unenrolled: drained.changed };
    }
    unenrolled = true;
  }
  const leaseKey = mirrorLeaseKey(path);
  if (countLiveExecutionLeases({ repoKeys: [leaseKey] }) > 0) {
    return { ok: false, reason: 'an autonomous run is still using this mirror', unenrolled };
  }
  const removed = await withRepoLease(leaseKey, async (): Promise<MirrorRemoveResult> => {
    const layout = inspectMirrorLayout(path);
    if (layout.state === 'invalid') {
      return { ok: false, reason: `refusing to delete ${path}: ${layout.reason}`, unenrolled };
    }
    if (layout.state === 'mirror' && opts.force !== true) {
      const listed = await runMirrorRepoGit(path, ['worktree', 'list', '--porcelain'], {
        timeoutMs: MIRROR_LOCAL_TIMEOUT_MS,
        allowLocalOrigin: false,
      });
      const linked = listed.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length - 1;
      if (!listed.ok || linked > 0) {
        return {
          ok: false,
          reason: listed.ok
            ? `${linked} sandbox worktree(s) are still linked to this mirror (use --force for crash leftovers)`
            : `could not list linked worktrees: ${listed.stderr}`,
          unenrolled,
        };
      }
    }
    if (layout.state === 'mirror') rmSync(path, { recursive: true, force: true });
    rmSync(statePath(identity.nameWithOwner), { force: true });
    return {
      ok: true,
      reason: layout.state === 'mirror' ? `removed ${path}` : 'no mirror directory; state cleared',
      unenrolled,
    };
  }, { waitMs: MIRROR_LEASE_WAIT_MS });
  return removed.ok ? removed.value : { ok: false, reason: `mirror busy: ${removed.reason}`, unenrolled };
}

// ---------------------------------------------------------------------------
// Tick integration (U5 calls these from its beforeTick hook)
// ---------------------------------------------------------------------------

export interface MirrorTickPreparation {
  /** Mirrors ready for dispatch this tick. */
  ready: { nameWithOwner: string; path: string; base: string; headSha: string }[];
  /** Mirrors that could not be made current; their paths must not be dispatched this tick. */
  failed: { nameWithOwner: string; path: string; reason: string }[];
  /** `failed[].path` — exactly the shape of BeforeTickResult.pausedRepos. */
  pausedRepoPaths: string[];
}

/**
 * Create and reset every mirror the standing policy's current stage names
 * (SPEC-310B §2: "reset to origin/<base> every tick"), at most
 * MIRROR_TICK_CONCURRENCY at a time. A repo whose mirror is not current is
 * reported for pausing rather than dispatched on stale code. Under KILL it
 * does nothing and pauses everything.
 */
export async function prepareMirrorsForTick(
  policy: Pick<EffectivePolicy, 'repos'>,
  deps: MirrorDeps & { concurrency?: number } = {},
): Promise<MirrorTickPreparation> {
  const repos = [...new Set(policy.repos.map((repo) => repo.nameWithOwner))];
  const result: MirrorTickPreparation = { ready: [], failed: [], pausedRepoPaths: [] };
  const pathOf = safeMirrorPath;
  let killed = false;
  try { killed = killSwitchOn(); } catch { killed = true; }
  if (killed) {
    for (const nameWithOwner of repos) {
      result.failed.push({ nameWithOwner, path: pathOf(nameWithOwner), reason: 'kill switch armed; mirrors not synced' });
    }
  } else {
    const queue = [...repos];
    const workers = Array.from(
      { length: Math.min(queue.length, Math.max(1, Math.floor(deps.concurrency ?? MIRROR_TICK_CONCURRENCY))) },
      async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const synced = await ensureMirror({ nameWithOwner: next }, deps);
          if (synced.ok && synced.base && synced.headSha) {
            result.ready.push({ nameWithOwner: synced.nameWithOwner, path: synced.path, base: synced.base, headSha: synced.headSha });
          } else {
            result.failed.push({ nameWithOwner: next, path: synced.path || pathOf(next), reason: synced.reason });
          }
        }
      },
    );
    await Promise.all(workers);
  }
  result.ready.sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
  result.failed.sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
  result.pausedRepoPaths = result.failed.map((row) => row.path).filter((path) => path.length > 0);
  return result;
}

// ---------------------------------------------------------------------------
// The autonomous lane (3.10 R3f) — see "WHY ENROLLMENT IS A LANE" above
// ---------------------------------------------------------------------------

/**
 * The lane: a registry path is admitted only when it IS a fleet mirror
 * directory (`mirrorNameForPath`, canonical — a symlink to a checkout
 * canonicalizes to the checkout and is refused). Paths only; no git runs.
 */
export const AUTONOMOUS_LANE_LENS: EnrollmentLens = Object.freeze({
  label: 'autonomous lane: fleet mirrors under ~/.ashlr/fleet/mirrors only',
  admits: (path: string) => isMirrorPath(path),
});

/**
 * Narrow the caller's CURRENT enrollment scope (sandbox/policy.ts
 * `withEnrollmentScope`) to the lane, for the rest of that scope. runDaemon
 * calls this once a standing session opens. false = no scope to narrow: the
 * caller must refuse to run standing work rather than run it on the full
 * registry.
 */
export function narrowToAutonomousLane(): boolean {
  return narrowEnrollmentScope(AUTONOMOUS_LANE_LENS);
}

/** Run `fn` with every enrolled read narrowed to the lane. */
export function runInAutonomousLane<T>(fn: () => T): T {
  return runWithEnrollmentLens(AUTONOMOUS_LANE_LENS, fn);
}

export interface AutonomousEnrollmentPlan {
  /** Mirror paths the standing policy wants enrolled. */
  desired: string[];
  /** Desired mirror paths not yet enrolled (only mirrors that exist). */
  enroll: string[];
  /** Enrolled FLEET MIRRORS the grant no longer names. Registry only; the clones stay (see `removeMirror`). */
  unenroll: string[];
  /** Desired mirrors that do not exist yet (enrolled after their first sync). */
  pendingMirrors: string[];
  /**
   * Enrolled paths that are not fleet mirrors — Mason's checkouts. Never
   * unenrolled and never dispatched on by the standing daemon (the lane lens
   * hides them); listed so the plan says so. Empty when the caller's own
   * enrolled view was already lane-narrowed.
   */
  untouched: string[];
}

function emptyPlan(): AutonomousEnrollmentPlan {
  return { desired: [], enroll: [], unenroll: [], pendingMirrors: [], untouched: [] };
}

/**
 * SPEC-310B §2: "Autonomous enrollment is exactly the grant's repo list" —
 * read as the LANE (the enrolled mirrors), not the whole registry. Pure over
 * paths: compares the policy's repos (as mirror paths) with `enrolled`. With
 * no standing policy the plan is empty: outside a grant nothing is reconciled
 * (`planAutonomousRelease` is the explicit way back).
 */
export function planAutonomousEnrollment(
  policy: Pick<EffectivePolicy, 'repos'> | null,
  enrolled: readonly string[],
  exists: (path: string) => boolean = (path) => inspectMirrorLayout(path).state === 'mirror',
): AutonomousEnrollmentPlan {
  if (!policy) return emptyPlan();
  const keyOf = (path: string): string => canonicalEnrollmentPath(path) ?? resolve(path);
  const desired = [...new Set(policy.repos
    .map((repo) => parseNameWithOwner(repo.nameWithOwner))
    .filter((identity): identity is RepoIdentity => identity !== null)
    .map((identity) => mirrorPathFor(identity.nameWithOwner)))].sort();
  const desiredKeys = new Set(desired.map(keyOf));
  const enrolledKeys = new Set(enrolled.map(keyOf));
  const enroll: string[] = [];
  const pendingMirrors: string[] = [];
  for (const path of desired) {
    if (enrolledKeys.has(keyOf(path))) continue;
    if (exists(path)) enroll.push(path);
    else pendingMirrors.push(path);
  }
  const unenroll: string[] = [];
  const untouched: string[] = [];
  for (const path of enrolled) {
    if (!isMirrorPath(path)) untouched.push(path);
    else if (!desiredKeys.has(keyOf(path))) unenroll.push(path);
  }
  return { desired, enroll, unenroll: unenroll.sort(), pendingMirrors, untouched: untouched.sort() };
}

export interface AutonomousEnrollmentResult {
  plan: AutonomousEnrollmentPlan;
  applied: boolean;
  enrolled: string[];
  unenrolled: string[];
  /** Per-path failures, scrubbed. */
  errors: { path: string; reason: string }[];
}

async function unenrollMirrors(
  paths: readonly string[],
  drainMs: number | undefined,
  result: { unenrolled: string[]; errors: { path: string; reason: string }[] },
): Promise<void> {
  for (const path of paths) {
    // Belt and braces: the plans only ever list mirrors, but this is the one
    // place that removes registry entries, so it re-checks rather than trusts.
    if (!isMirrorPath(path)) {
      result.errors.push({ path, reason: 'not a fleet mirror; the autonomous lane never unenrolls anything else' });
      continue;
    }
    const drained = await unenrollAndDrain(path, drainMs !== undefined ? { drainMs } : {});
    if (drained.ok && drained.quiesced) result.unenrolled.push(path);
    else result.errors.push({ path, reason: scrubSecrets(drained.reason) });
  }
}

/**
 * Apply `planAutonomousEnrollment`: unenroll (and drain) the fleet mirrors
 * the grant dropped first — restrictive changes before permissive ones —
 * then enroll the grant's mirrors that exist. Mason's checkouts are never
 * touched. `apply:false` only reports the plan.
 */
export async function reconcileAutonomousEnrollment(
  policy: Pick<EffectivePolicy, 'repos'> | null,
  opts: { apply: boolean; drainMs?: number },
): Promise<AutonomousEnrollmentResult> {
  const plan = planAutonomousEnrollment(policy, listEnrolled());
  const result: AutonomousEnrollmentResult = { plan, applied: false, enrolled: [], unenrolled: [], errors: [] };
  if (!opts.apply || !policy) return result;
  result.applied = true;
  await unenrollMirrors(plan.unenroll, opts.drainMs, result);
  for (const path of plan.enroll) {
    const added = enroll(path);
    if (added.ok) result.enrolled.push(path);
    else result.errors.push({ path, reason: scrubSecrets(added.reason) });
  }
  return result;
}

export interface AutonomousReleasePlan {
  /** Every enrolled fleet mirror — all of it goes. */
  unenroll: string[];
  /** Everything else enrolled — stays exactly as it is. */
  untouched: string[];
}

/** The undo of the lane's registry footprint: every enrolled mirror, nothing else. Pure. */
export function planAutonomousRelease(enrolled: readonly string[]): AutonomousReleasePlan {
  const unenroll: string[] = [];
  const untouched: string[] = [];
  for (const path of enrolled) (isMirrorPath(path) ? unenroll : untouched).push(path);
  return { unenroll: unenroll.sort(), untouched: untouched.sort() };
}

export interface AutonomousReleaseResult {
  plan: AutonomousReleasePlan;
  applied: boolean;
  unenrolled: string[];
  errors: { path: string; reason: string }[];
}

/**
 * Unenroll (and drain) every fleet mirror — the reversal of everything
 * reconcile ever wrote. The clones stay on disk (`ashlr mirror remove`
 * deletes one). A standing daemon still running re-enrolls its grant's
 * mirrors on its next tick, so release is for after the grant ends.
 */
export async function releaseAutonomousEnrollment(
  opts: { apply: boolean; drainMs?: number },
): Promise<AutonomousReleaseResult> {
  const plan = planAutonomousRelease(listEnrolled());
  const result: AutonomousReleaseResult = { plan, applied: false, unenrolled: [], errors: [] };
  if (!opts.apply) return result;
  result.applied = true;
  await unenrollMirrors(plan.unenroll, opts.drainMs, result);
  return result;
}
