/**
 * safe-git — V3.10 Track B (owner: unit U2): how the DAEMON runs git on trees
 * an autonomous agent has touched.
 *
 * THE ESCAPE THIS CLOSES. The daemon runs git unconfined (capture, commit,
 * push, verify). Git executes configured programs — hooks, core.fsmonitor,
 * filter/diff drivers, credential helpers, core.sshCommand, aliases — and it
 * finds its config through `.git`, which sits INSIDE the agent's worktree. An
 * agent that replaces `.git` (or plants config git would read) turns the
 * daemon's next `git status` into code running as Mason, outside every
 * sandbox. So a daemon git call here:
 *   1. VERIFIES `.git`: for a linked worktree it must be a small regular file
 *      naming exactly the git dir the daemon created, whose back-link names
 *      this worktree, inside a common dir no agent can write; git then runs
 *      with that `--git-dir`/`--work-tree` explicitly, so nothing is ever
 *      discovered from the tree;
 *   2. NULLS every config-borne executable: core.hooksPath=/dev/null,
 *      core.fsmonitor=false, credential.helper reset, no gpg, no pager, no
 *      editor, no submodule recursion, attributes/excludes files null, no
 *      global or system config (GIT_CONFIG_GLOBAL/SYSTEM=/dev/null) and no
 *      inherited GIT_* environment at all (the env is built from nothing);
 *      and gitattributes are read from the EMPTY tree (--attr-source), so an
 *      agent's `.gitattributes` cannot route a file through any filter or
 *      diff driver, wherever that driver is configured;
 *   3. SPEAKS https ONLY (protocol.allow=never, https=always; `file` only
 *      when a caller explicitly asks), so ext::/ssh/file URLs planted in
 *      `.gitmodules` or config go nowhere;
 *   4. CARRIES A TOKEN ONLY AS AN EPHEMERAL HEADER: the GitHub App
 *      installation token (custody-client githubToken) becomes
 *      `http.https://github.com/.extraheader` via GIT_CONFIG_COUNT in the
 *      child's environment — never argv (argv is visible to every process),
 *      never a file, never the repo config — and only for that one call.
 *
 * Config in the verified COMMON dir (the fleet mirror) is daemon-written and
 * never agent-writable (the autonomous sandbox makes the mirror read-only),
 * but nothing above relies on it being free of executables. Use layout 'repo'
 * only for a tree no agent ever writes (the mirror itself).
 */
import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants, accessSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { STANDING_GRANT_PATTERNS } from '../authority/types.js';

export interface SafeGitTarget {
  /** Absolute working tree (possibly agent-touched). */
  workTree: string;
  /**
   * The git dir the daemon expects: `<mirror>/.git/worktrees/<name>` for a
   * linked worktree (layout 'linked'), `<repo>/.git` for layout 'repo'.
   */
  gitDir: string;
  /**
   * - `linked` (default): `<workTree>/.git` is a FILE naming exactly `gitDir`.
   * - `repo`: `<workTree>/.git` IS `gitDir` — only for trees no agent writes.
   */
  layout?: 'linked' | 'repo';
}

export type SafeGitVerification =
  | { ok: true; workTree: string; gitDir: string; commonDir: string }
  | { ok: false; reason: string };

export interface SafeGitAuth {
  /** SECRET — a GitHub App installation token (custody-client githubToken). Sent only to https://github.com/. */
  token: string;
}

export interface SafeGitOptions extends SafeGitTarget {
  args: readonly string[];
  auth?: SafeGitAuth;
  input?: string | Buffer;
  /** Default 60 s. */
  timeoutMs?: number;
  /** Per stream; default 16 MiB. */
  maxOutputBytes?: number;
  signal?: AbortSignal;
  /** Non-secret commit identity for commits the daemon makes. */
  identity?: { name: string; email: string };
  /** Transports beyond https (e.g. `file` to clone a local mirror). Default: https only. */
  allowProtocols?: readonly 'file'[];
  /** Set GIT_OPTIONAL_LOCKS=0 (read-only status calls must not rewrite the index). */
  noOptionalLocks?: boolean;
}

export interface SafeGitResult {
  ok: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class SafeGitError extends Error {
  constructor(message: string) {
    super(`safe-git: ${message}`);
    this.name = 'SafeGitError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_POINTER_BYTES = 4096;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function readPointer(path: string): string | null {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_POINTER_BYTES) return null;
  return readFileSync(path, 'utf8');
}

/**
 * Check the worktree's `.git` points exactly where the daemon expects, BEFORE
 * any git runs. Pure filesystem reads; never throws.
 */
export function verifyGitTarget(target: SafeGitTarget): SafeGitVerification {
  const fail = (reason: string): SafeGitVerification => ({ ok: false, reason });
  try {
    if (!isAbsolute(target.workTree) || !isAbsolute(target.gitDir)) return fail('workTree and gitDir must be absolute');
    const workTree = realpathSync(target.workTree);
    const gitDir = realpathSync(target.gitDir);
    if (workTree !== resolve(target.workTree)) return fail('workTree must be canonical (no symlinks)');
    const wtStat = lstatSync(workTree);
    if (!wtStat.isDirectory()) return fail('workTree is not a directory');
    const gdStat = lstatSync(gitDir);
    if (gdStat.isSymbolicLink() || !gdStat.isDirectory()) return fail('gitDir is not a plain directory');
    const dotGit = join(workTree, '.git');
    let dotStat;
    try {
      dotStat = lstatSync(dotGit);
    } catch {
      return fail('.git is missing from the worktree');
    }
    const layout = target.layout ?? 'linked';

    if (layout === 'repo') {
      if (dotStat.isSymbolicLink() || !dotStat.isDirectory()) return fail('.git is not the repository directory');
      if (realpathSync(dotGit) !== gitDir) return fail('.git is not the expected repository');
      return { ok: true, workTree, gitDir, commonDir: gitDir };
    }

    // linked worktree
    if (dotStat.isSymbolicLink() || !dotStat.isFile()) {
      return fail('.git was replaced (expected the worktree pointer file)');
    }
    if (isInside(gitDir, workTree)) return fail('gitDir lives inside the worktree an agent can write');
    const pointer = readPointer(dotGit);
    const match = pointer === null ? null : /^gitdir: (.+)\n?$/.exec(pointer);
    if (!match) return fail('.git is not a gitdir pointer');
    let named: string;
    try {
      named = realpathSync(resolve(workTree, match[1]!));
    } catch {
      return fail('.git points at a directory that does not exist');
    }
    if (named !== gitDir) return fail('.git points at a different git directory');
    const back = readPointer(join(gitDir, 'gitdir'));
    if (back === null) return fail('the git directory has no worktree back-link');
    let backTarget: string;
    try {
      backTarget = realpathSync(resolve(gitDir, back.trim()));
    } catch {
      return fail('the git directory back-link is dangling');
    }
    if (backTarget !== realpathSync(dotGit)) return fail('the git directory belongs to another worktree');
    const common = readPointer(join(gitDir, 'commondir'));
    if (common === null) return fail('the git directory has no commondir');
    const commonDir = realpathSync(resolve(gitDir, common.trim()));
    if (isInside(commonDir, workTree)) return fail('the common git directory lives inside the worktree');
    if (!isInside(gitDir, join(commonDir, 'worktrees'))) return fail('gitDir is not a worktree of its common directory');
    const config = lstatSync(join(commonDir, 'config'));
    if (config.isSymbolicLink() || !config.isFile()) return fail('the repository config is not a regular file');
    return { ok: true, workTree, gitDir, commonDir };
  } catch (error) {
    return fail(`cannot inspect the git layout (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
  }
}

let gitExecutableCache: string | null = null;

/**
 * An absolute git binary, not group/world-writable, found outside HOME (the
 * PATH entries under HOME are the ones a user-level process could plant).
 */
export function resolveGitExecutable(): string {
  if (gitExecutableCache) return gitExecutableCache;
  const home = process.env['HOME'] ?? '';
  const candidates: string[] = [];
  for (const entry of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!entry || !isAbsolute(entry) || (home && isInside(resolve(entry), home))) continue;
    candidates.push(join(entry, 'git'));
  }
  candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      const stat = lstatSync(real);
      if (!stat.isFile() || (stat.mode & 0o022) !== 0) continue;
      if (uid !== null && stat.uid !== 0 && stat.uid !== uid) continue;
      accessSync(real, fsConstants.X_OK);
      gitExecutableCache = real;
      return real;
    } catch {
      /* next candidate */
    }
  }
  throw new SafeGitError('no trustworthy git executable found');
}

/** `https://github.com/<owner>/<name>.git` for a validated nameWithOwner. */
export function githubRemoteUrl(nameWithOwner: string): string {
  if (!STANDING_GRANT_PATTERNS.nameWithOwner.test(nameWithOwner)) throw new SafeGitError('repo must be owner/name');
  return `https://github.com/${nameWithOwner}.git`;
}

/**
 * The empty tree per object format. Daemon git reads gitattributes from it
 * (`--attr-source`), so no `.gitattributes` an agent writes can route a file
 * through ANY filter or diff driver — even one that exists in the mirror's
 * config (e.g. planted by unconfined code, or a repo-local LFS install).
 * Trade-off: no eol/LFS attribute processing in daemon captures; files are
 * committed byte-for-byte as the agent left them.
 */
const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const;

/** `sha256` when the common config declares extensions.objectFormat = sha256. */
function objectFormatOf(commonDir: string): keyof typeof EMPTY_TREE {
  try {
    const config = readFileSync(join(commonDir, 'config'), 'utf8');
    return /^\s*objectformat\s*=\s*sha256\s*$/im.test(config) ? 'sha256' : 'sha1';
  } catch {
    return 'sha1';
  }
}

/** The global options every call carries (no secrets — these are visible in argv). */
export function safeGitConfigArgs(allowProtocols: readonly 'file'[] = [], objectFormat: keyof typeof EMPTY_TREE = 'sha1'): string[] {
  const pairs: [string, string][] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['core.attributesFile', '/dev/null'],
    ['core.excludesFile', '/dev/null'],
    ['core.askPass', ''],
    ['core.pager', 'cat'],
    ['core.editor', '/usr/bin/true'],
    ['sequence.editor', '/usr/bin/true'],
    ['credential.helper', ''],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['push.gpgSign', 'false'],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
    ['submodule.recurse', 'false'],
    ['fetch.recurseSubmodules', 'false'],
    ['push.recurseSubmodules', 'no'],
    ['protocol.allow', 'never'],
    ['protocol.https.allow', 'always'],
    ...allowProtocols.map((p): [string, string] => [`protocol.${p}.allow`, 'always']),
  ];
  const out: string[] = ['--no-replace-objects', `--attr-source=${EMPTY_TREE[objectFormat]}`];
  for (const [key, value] of pairs) out.push('-c', `${key}=${value}`);
  return out;
}

/** GitHub's documented form for an installation token over https. */
function authHeader(token: string): string {
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new SafeGitError('the auth token has an unexpected shape');
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`;
}

/**
 * The exact command for one hardened git call: executable, argv and an env
 * built from nothing. Throws SafeGitError when `.git` fails verification.
 * Exposed so callers with their own process plumbing get the same hardening.
 */
export function safeGitCommand(opts: SafeGitOptions): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const verified = verifyGitTarget(opts);
  if (!verified.ok) throw new SafeGitError(`refusing to run git: ${verified.reason}`);
  if (!Array.isArray(opts.args) || opts.args.length === 0 || opts.args.some((a) => typeof a !== 'string')) {
    throw new SafeGitError('args must be a subcommand followed by string arguments');
  }
  // Global options (-c, -C, --git-dir, --exec-path, …) can only appear BEFORE
  // the subcommand; requiring args[0] to be a bare subcommand name keeps
  // every one of them under this module's control.
  if (!/^[a-z][a-z0-9-]*$/.test(opts.args[0]!)) {
    throw new SafeGitError('the first argument must be a git subcommand (global options are set by safe-git)');
  }
  const file = resolveGitExecutable();
  const args = [
    ...safeGitConfigArgs(opts.allowProtocols ?? [], objectFormatOf(verified.commonDir)),
    `--git-dir=${verified.gitDir}`,
    `--work-tree=${verified.workTree}`,
    ...opts.args,
  ];
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(file)}${delimiter}/usr/bin${delimiter}/bin${delimiter}/usr/sbin${delimiter}/sbin`,
    // Nothing in a real home is consulted: global/system config and the
    // global attributes/excludes files are nulled below and above.
    HOME: '/var/empty',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: '/usr/bin/true',
    GIT_SEQUENCE_EDITOR: '/usr/bin/true',
  };
  if (opts.noOptionalLocks) env['GIT_OPTIONAL_LOCKS'] = '0';
  if (opts.identity) {
    const { name, email } = opts.identity;
    if (!/^[^\n<>]{1,100}$/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email)) throw new SafeGitError('invalid commit identity');
    env['GIT_AUTHOR_NAME'] = name;
    env['GIT_AUTHOR_EMAIL'] = email;
    env['GIT_COMMITTER_NAME'] = name;
    env['GIT_COMMITTER_EMAIL'] = email;
  }
  // Ordered config entries from the environment (never argv): first clear any
  // configured extra headers, then add the token header for github.com only.
  const configPairs: [string, string][] = [['http.extraHeader', '']];
  if (opts.auth) configPairs.push(['http.https://github.com/.extraHeader', authHeader(opts.auth.token)]);
  env['GIT_CONFIG_COUNT'] = String(configPairs.length);
  configPairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return { file, args, env };
}

function collect(max: number): { push(chunk: Buffer): boolean; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    push(chunk: Buffer): boolean {
      size += chunk.length;
      if (size > max) return false;
      chunks.push(chunk);
      return true;
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
}

/** Run one hardened git call (async). Throws SafeGitError only for refusals before spawning. */
export function runSafeGit(opts: SafeGitOptions): Promise<SafeGitResult> {
  const { file, args, env } = safeGitCommand(opts);
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd: opts.workTree, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = collect(max);
    const err = collect(max);
    let timedOut = false;
    let overflow = false;
    const kill = (): void => { child.kill('SIGKILL'); };
    child.stdout.on('data', (c: Buffer) => { if (!out.push(c)) { overflow = true; kill(); } });
    child.stderr.on('data', (c: Buffer) => { if (!err.push(c)) { overflow = true; kill(); } });
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const onAbort = (): void => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        ok: code === 0 && !timedOut && !overflow,
        code,
        signal,
        stdout: out.text(),
        stderr: overflow ? `${err.text()}\n[safe-git: output limit exceeded]` : err.text(),
        timedOut,
      });
    };
    child.on('error', () => finish(null, null));
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* git exited before reading stdin */ });
    child.stdin.end(opts.input ?? '');
  });
}

/** Run one hardened git call synchronously (for callers already on a sync path). */
export function runSafeGitSync(opts: SafeGitOptions): SafeGitResult {
  const { file, args, env } = safeGitCommand(opts);
  const max = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const result = spawnSync(file, args, {
    cwd: opts.workTree,
    env,
    input: opts.input ?? '',
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: max,
    windowsHide: true,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  return {
    ok: result.status === 0 && !result.error,
    code: result.status,
    signal: result.signal,
    stdout: result.stdout ? result.stdout.toString('utf8') : '',
    stderr: result.stderr ? result.stderr.toString('utf8') : '',
    timedOut,
  };
}
