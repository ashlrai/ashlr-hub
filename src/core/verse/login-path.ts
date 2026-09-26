/**
 * core/verse/login-path.ts — the PATH and environment for every child process
 * the WORKBENCH starts on the operator's behalf: terminal tabs (C4), Apps
 * detection / [Launch ▸] (C6), dev servers (C4 Preview). Contract unit C0.
 *
 * WHY A LOGIN SHELL. The desktop sidecar is started by launchd, whose PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`. Homebrew, `~/.local/bin` (claude, hermes,
 * aider) and `~/.grok/bin` are all missing from it, so every Apps row would
 * say "not installed" and a terminal tab could not find `npm`. The operator's
 * real PATH is whatever their login + interactive startup files build, so we
 * ask that shell once — `$SHELL -l -i -c` — and cache the answer for the life
 * of the process. When that fails (no shell, a startup file that hangs or
 * errors), we fall back to the process PATH plus the directories tools
 * actually install into on macOS (FALLBACK_PATH_DIRS), keeping only those that
 * exist.
 *
 * WHY STRIP THE ENVIRONMENT. These children are driven from the PAGE (a
 * terminal the operator types into, a launch button). The sidecar's own
 * environment can carry Ashlr's private settings (`ASHLR_*`) and provider
 * credentials exported by whoever started it; none of that may leak into a
 * process the page controls. `sanitizeChildEnv` drops `ASHLR_*`, anything
 * named like a credential, and the seat-pinning variables Verse sets per turn
 * (a stray `CLAUDE_CONFIG_DIR` would silently run a terminal `claude` on the
 * wrong account). A login shell re-reads the operator's OWN profile, so
 * anything they export themselves comes back — only what the SIDECAR carried
 * is removed.
 *
 * NEVER BLOCKS: the probe is one async spawn in its own session with a hard
 * timeout enforced by our own timer, which kills the probe's whole process
 * group and resolves even when stdio never closes (createShellRunner). The
 * result is cached (single-flight), so a request handler awaits a resolved
 * promise after the first call. Nothing that serves a page awaits it: only
 * the Apps family, terminal tabs and launches do.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute } from 'node:path';

export type LoginPathSource = 'login-shell' | 'fallback';

export interface LoginPathResult {
  /** Ready for `env.PATH`. */
  path: string;
  entries: readonly string[];
  source: LoginPathSource;
  /** The shell that was asked; null when none was usable. */
  shell: string | null;
  /** Why the login shell's answer was not used; null when it was. Never contains output. */
  fallbackReason: string | null;
  resolvedAt: string;
}

export interface ShellRunResult {
  stdout: string;
  /** Exit code; null when killed. */
  code: number | null;
  timedOut: boolean;
}

/** Injectable for tests (vitest runs on Node with a fake runner — no real shell). */
export type ShellRunner = (
  file: string,
  args: readonly string[],
  opts: { timeoutMs: number; env: Record<string, string> },
) => Promise<ShellRunResult>;

export interface LoginPathOptions {
  runShell?: ShellRunner;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isDirectory?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  now?: () => Date;
}

/** A startup file that waits on input or prints a banner forever must not stall a request. */
export const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/**
 * Where macOS tools install, in resolution order. `~` is the home directory.
 * Appended (only if they exist) AFTER the login shell's own entries, so the
 * operator's order always wins and a tool installed somewhere they never put
 * on PATH (`~/.grok/bin` is the common case) is still detected.
 */
export const FALLBACK_PATH_DIRS: readonly string[] = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '~/.local/bin',
  '~/.grok/bin',
  '~/.bun/bin',
  '~/.cargo/bin',
  '~/.npm-global/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

const MARK_BEGIN = '__VERSE_LOGIN_PATH_BEGIN__';
const MARK_END = '__VERSE_LOGIN_PATH_END__';
const POSIX_SHELLS = new Set(['zsh', 'bash', 'sh', 'ksh', 'dash']);

// ---------------------------------------------------------------------------
// Environment sanitising
// ---------------------------------------------------------------------------

/**
 * Credential-shaped names, matched as whole `_`-separated words so
 * `SSH_AUTH_SOCK` (git over ssh needs it) and `TOKENIZERS_PARALLELISM` survive
 * while `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY` and
 * `CLAUDE_CODE_OAUTH_TOKEN` do not.
 */
const CREDENTIAL_NAME_RE =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_KEY(?:_ID)?|PRIVATE_KEY|CLIENT_SECRET|CREDENTIALS?|COOKIE)(?:_|$)/i;

/**
 * The same words glued to a prefix with no underscore — Postgres' standard
 * `PGPASSWORD`, `DBPASSWORD`, `GHTOKEN`. SUFFIX-only, so a name that merely
 * starts with one (`TOKENIZERS_PARALLELISM`) survives. `PWD` is deliberately
 * not a suffix here: `PWD` / `OLDPWD` are the shell's working directory.
 */
const CREDENTIAL_SUFFIX_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY)$/i;

/** Credentials whose names match no word rule above. */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set(['MYSQL_PWD']);

/**
 * Set PER TURN by Verse's seat launchers; inherited by accident they re-point
 * a terminal's `claude`/`codex`/`grok` at a seat's private profile or at
 * Ollama.
 */
const SEAT_PIN_NAMES: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GROK_HOME',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
]);

/** True for a variable no page-driven child may inherit. */
export function isStrippedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('ASHLR_')
    || SEAT_PIN_NAMES.has(name)
    || CREDENTIAL_NAMES.has(upper)
    || CREDENTIAL_NAME_RE.test(name)
    || CREDENTIAL_SUFFIX_RE.test(name);
}

/**
 * A copy of `env` without Ashlr's private settings, credentials or seat pins.
 * `keep` re-admits exact names a caller has a reason to pass through.
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv,
  opts: { keep?: readonly string[] } = {},
): Record<string, string> {
  const keep = new Set(opts.keep ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!keep.has(name) && isStrippedEnvName(name)) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PATH resolution
// ---------------------------------------------------------------------------

function expandHome(entry: string, home: string): string {
  return entry === '~' ? home : entry.startsWith('~/') ? `${home}${entry.slice(1)}` : entry;
}

/**
 * Absolute entries only, first occurrence wins. A relative entry (`.`, `bin`,
 * an empty segment) would resolve against whatever directory a child happens
 * to start in — a repo the agent just wrote — so it is dropped, never kept.
 */
export function normalizePathEntries(entries: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0 || !isAbsolute(entry) || entry.includes('\0')) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The shell to ask: `$SHELL` when it is an absolute path to a shell we know how to drive. */
export function pickLoginShell(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return null;
  const shell = env['SHELL'];
  if (typeof shell === 'string' && isAbsolute(shell)) {
    const name = basename(shell);
    if (POSIX_SHELLS.has(name) || name === 'fish') return shell;
  }
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

/** argv for the probe. Markers make the answer findable among whatever a startup file prints. */
export function loginShellArgs(shell: string): string[] {
  const print = basename(shell) === 'fish'
    ? `printf '%s' '${MARK_BEGIN}'; string join : $PATH; printf '%s' '${MARK_END}'`
    : `printf '%s%s%s' '${MARK_BEGIN}' "$PATH" '${MARK_END}'`;
  return ['-l', '-i', '-c', print];
}

/** Extract the PATH between the markers; null when they are missing or the value is empty. */
export function parseLoginShellOutput(stdout: string): string[] | null {
  const start = stdout.lastIndexOf(MARK_BEGIN);
  if (start === -1) return null;
  const end = stdout.indexOf(MARK_END, start + MARK_BEGIN.length);
  if (end === -1) return null;
  const value = stdout.slice(start + MARK_BEGIN.length, end).replace(/[\r\n]+/g, '');
  const entries = normalizePathEntries(value.split(':'));
  return entries.length > 0 ? entries : null;
}

/** Bytes of probe stdout kept; the rest is drained and dropped so the shell never blocks on a full pipe. */
const MAX_PROBE_STDOUT = 1024 * 1024;

/**
 * How long, after the shell itself exits, the probe waits for its stdout to
 * close. A background job a startup file left running (an async prompt
 * worker, an updater, `cmd &`) inherits the pipe and can hold it open for
 * ever; the answer is already printed by then, so it is read and the job's
 * process group is killed.
 */
export const LOGIN_SHELL_EXIT_GRACE_MS = 250;

/** The seams `createShellRunner` spawns and kills through (tests pass fakes). */
export interface ShellRunnerDeps {
  spawn?: (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Kill every process in the probe's own process group. Never throws. */
  killGroup?: (pid: number) => void;
  platform?: NodeJS.Platform;
  exitGraceMs?: number;
}

function defaultKillGroup(pid: number): void {
  try {
    // Negative pid: the whole group. The probe is its own group leader
    // (detached ⇒ setsid), so this reaches the shell AND every background job
    // its startup files started, and nothing of the sidecar's.
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: the group is already gone.
  }
}

/**
 * The real probe runner. Every guarantee here is about NOT depending on the
 * operator's startup files behaving:
 *
 *   - its own session and process group (`detached` ⇒ setsid): an
 *     interactive shell may do job control (tcsetpgrp, SIGTTIN/SIGTTOU,
 *     `kill 0`) on the group it lives in, and without this that group is the
 *     sidecar's. In a fresh session it also has no controlling terminal to
 *     fight over, even when the sidecar was started from one;
 *   - stdin is /dev/null (`ignore`), stderr is discarded (a chatty startup
 *     file can never fill a pipe nobody reads and block), stdout is drained
 *     continuously and capped;
 *   - the timeout is OUR timer: it kills the whole group and resolves at once,
 *     without waiting for stdio to close (a grandchild holding stdout open
 *     would otherwise keep `execFile`'s callback — and so the probe — pending
 *     after the shell was killed);
 *   - a shell that exits but leaves stdout held resolves after a short grace.
 *
 * `-l -i` semantics are kept (the interactive startup files are where most
 * operators set PATH); only the ways they could stall the caller are removed.
 */
export function createShellRunner(deps: ShellRunnerDeps = {}): ShellRunner {
  const spawnChild = deps.spawn ?? ((file, args, opts) => spawn(file, args, opts));
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const platform = deps.platform ?? process.platform;
  const exitGraceMs = deps.exitGraceMs ?? LOGIN_SHELL_EXIT_GRACE_MS;

  return (file, args, opts) => new Promise<ShellRunResult>((resolve) => {
    const chunks: Buffer[] = [];
    let kept = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;

    const reap = (): void => {
      const pid = child?.pid;
      if (typeof pid === 'number' && pid > 0 && platform !== 'win32') killGroup(pid);
      try { child?.kill('SIGKILL'); } catch { /* already gone */ }
    };
    const settle = (code: number | null, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      // Stop reading: whoever still holds the pipe gets EPIPE, not our memory.
      try { child?.stdout?.destroy(); } catch { /* ignore */ }
      resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code, timedOut });
    };

    try {
      child = spawnChild(file, [...args], {
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: opts.env,
        windowsHide: true,
      });
    } catch {
      settle(null, false);
      return;
    }

    timer = setTimeout(() => {
      reap();
      settle(null, true);
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (kept >= MAX_PROBE_STDOUT) return;
      const slice = chunk.length > MAX_PROBE_STDOUT - kept ? chunk.subarray(0, MAX_PROBE_STDOUT - kept) : chunk;
      chunks.push(slice);
      kept += slice.length;
    });
    child.stdout?.on('error', () => { /* destroyed on settle, or the writer died */ });
    // Spawn failure (ENOENT, EACCES): 'error' without 'exit'.
    child.on('error', () => {
      reap();
      settle(null, false);
    });
    child.on('exit', (code) => {
      if (settled) return;
      grace = setTimeout(() => {
        // The shell is gone but something it started still holds stdout.
        reap();
        settle(code, false);
      }, exitGraceMs);
    });
    child.on('close', (code) => settle(code, false));
  });
}

const defaultRunShell: ShellRunner = createShellRunner();

function fallbackEntries(env: NodeJS.ProcessEnv, home: string, isDirectory: (p: string) => boolean): string[] {
  const inherited = typeof env['PATH'] === 'string' ? env['PATH'].split(':') : [];
  const known = FALLBACK_PATH_DIRS.map((dir) => expandHome(dir, home)).filter((dir) => isDirectory(dir));
  return normalizePathEntries([...inherited, ...known]);
}

/** Resolve without the cache (tests, and `refreshLoginPath`). */
export async function probeLoginPath(opts: LoginPathOptions = {}): Promise<LoginPathResult> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const isDirectory = opts.isDirectory ?? defaultIsDirectory;
  const now = opts.now ?? (() => new Date());
  const shell = pickLoginShell(env, platform);

  const finish = (entries: string[], source: LoginPathSource, fallbackReason: string | null): LoginPathResult => ({
    path: entries.join(':'),
    entries,
    source,
    shell,
    fallbackReason,
    resolvedAt: now().toISOString(),
  });

  if (!shell) return finish(fallbackEntries(env, home, isDirectory), 'fallback', 'no login shell on this platform');

  let reason: string;
  try {
    const run = await (opts.runShell ?? defaultRunShell)(shell, loginShellArgs(shell), {
      timeoutMs: opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS,
      // The probe itself runs sanitised: the operator's startup files never see
      // the sidecar's secrets either.
      env: { ...sanitizeChildEnv(env), HOME: home },
    });
    const parsed = parseLoginShellOutput(run.stdout);
    if (parsed) {
      const known = FALLBACK_PATH_DIRS.map((dir) => expandHome(dir, home)).filter((dir) => isDirectory(dir));
      return finish(normalizePathEntries([...parsed, ...known]), 'login-shell', null);
    }
    reason = run.timedOut
      ? `login shell timed out after ${opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS} ms`
      : `login shell printed no PATH (exit ${run.code ?? 'killed'})`;
  } catch {
    reason = 'login shell could not be started';
  }
  return finish(fallbackEntries(env, home, isDirectory), 'fallback', reason);
}

let cached: Promise<LoginPathResult> | null = null;

/**
 * The login PATH, resolved once per process and shared by every caller
 * (single-flight: concurrent first calls await the same probe).
 */
export function resolveLoginPath(opts?: LoginPathOptions): Promise<LoginPathResult> {
  if (!cached) cached = probeLoginPath(opts);
  return cached;
}

/** Apps' refresh button: re-ask the shell (a PATH edited since launch is picked up). */
export function refreshLoginPath(opts?: LoginPathOptions): Promise<LoginPathResult> {
  cached = probeLoginPath(opts);
  return cached;
}

/** Test hygiene. */
export function resetLoginPathCache(): void {
  cached = null;
}

/**
 * The environment for a page-driven child: the sanitised base, PATH from the
 * login shell, then `set` (the caller's own additions — `TERM`, `COLORTERM` —
 * applied last and not filtered: the caller owns what it adds explicitly).
 */
export async function childProcessEnv(opts: {
  set?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
  keep?: readonly string[];
  loginPath?: LoginPathOptions;
} = {}): Promise<Record<string, string>> {
  const login = await resolveLoginPath(opts.loginPath);
  const env = sanitizeChildEnv(opts.base ?? process.env, opts.keep ? { keep: opts.keep } : {});
  env['PATH'] = login.path;
  return { ...env, ...(opts.set ?? {}) };
}
