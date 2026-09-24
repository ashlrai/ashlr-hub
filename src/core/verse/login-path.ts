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
 * NEVER BLOCKS: the probe is one async execFile with a hard timeout; the
 * result is cached (single-flight), so a request handler awaits a resolved
 * promise after the first call.
 */
import { execFile } from 'node:child_process';
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

const defaultRunShell: ShellRunner = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      [...args],
      { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: opts.env, windowsHide: true },
      (error, stdout) => {
        // Non-zero exit: `code` is the number. Timeout: `killed`. Spawn failure: `code` is 'ENOENT'.
        const err = error as { killed?: boolean; code?: unknown } | null;
        resolve({
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          timedOut: Boolean(err?.killed),
        });
      },
    );
    // A startup file that reads stdin gets EOF instead of waiting for the timeout.
    child.stdin?.end();
  });

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
