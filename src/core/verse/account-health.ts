/**
 * core/verse/account-health.ts — the seat health sweep (V3.10, unit A2).
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 * The account collector (accounts.ts) suspends after five minutes without a
 * client, and the web app stops polling while its window is hidden. So a
 * sign-out, an expiring credential or an exhausted window was discovered only
 * when Mason happened to be looking, or when a turn failed at the provider
 * (research r2/accounts.md, silent-break #2). This module runs a SEPARATE,
 * deliberately tiny sweep every ten minutes whether or not anyone is looking,
 * and answers one question per seat: can it run a turn right now, and if not,
 * what fixes it (`SeatHealthReport`, core/verse/health-types.ts).
 *
 * ── ZERO COST, BY CONSTRUCTION ─────────────────────────────────────────────
 * Only status commands ever run here — never a prompt, never a model call:
 *   - claude  `<launcher> auth status --json`   (probeClaudeAccountStatus)
 *   - codex   `<launcher> login status`
 *   - grok    the ACP `_x.ai/auth/info` metadata probe (probeGrokAccount,
 *             via grok-account-probe-process.ts — the CLI has no auth-status
 *             subcommand)
 *   - Ollama  `GET /api/version`
 *   - `<binary> --version`, only for a codex build whose version cannot be
 *     read from its path (the one inside ChatGPT.app), cached by file identity.
 * One sweep is four to six short-lived processes, run ONE AT A TIME.
 *
 * ── SECRETS ────────────────────────────────────────────────────────────────
 * Expiry warnings come from TIMESTAMPS ONLY. Codex's and Grok's `auth.json`
 * are parsed just far enough to lift `last_refresh`, the access token's `exp`
 * claim, `expires_at` and whether a refresh token EXISTS; the token strings
 * are never stored, logged or returned. Claude's credential lives in the
 * macOS keychain; `security find-generic-password` WITHOUT `-w` prints only
 * the item's attributes, from which only `mdat` (last write) is read.
 *
 * Launcher commands and profile paths are an account's identity
 * (accounts.ts, seats.ts): they stay inside this process. The one exception
 * is the operator-facing repin command, which names the profile directory
 * home-relative exactly as seats.ts's existing repin note already does.
 */

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { probeClaudeAccountStatus } from '../resources/claude-account-status.js';
import { probeGrokAccount } from '../resources/grok-account-probe.js';
import { workerEnvironment } from '../resources/worker.js';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import { VERSE_GROK_SIGNED_OUT_REASONS } from './accounts.js';
import type { SeatConnection, SeatHealthFix, SeatHealthReport } from './health-types.js';
import {
  cliVersionFromExecutable,
  compareCliVersions,
  defaultClaudeVersionsRoot,
  newestInstalledClaudeVersion,
} from './model-windows.js';
import { seatReopening } from './seat-readiness.js';
import type { VerseSeat } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Background cadence. Status commands only, so ten minutes costs nothing. */
export const VERSE_HEALTH_SWEEP_MS = 10 * 60_000;

/** First sweep after start — late enough not to compete with server boot. */
export const VERSE_HEALTH_INITIAL_DELAY_MS = 3_000;

/** A credential that expires within this window is `expiring`. */
export const VERSE_CREDENTIAL_WARN_MS = 48 * 60 * 60 * 1000;

/** Per status command. The CLIs answer in well under a second when healthy. */
const LOGIN_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const OLLAMA_TIMEOUT_MS = 2_000;
const MAX_CREDENTIAL_FILE_BYTES = 256 * 1024;
const MAX_CONNECTIONS_FILE_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_DIR_ENTRIES = 256;

export type NativeEngine = 'claude' | 'codex' | 'grok';

/**
 * The seat's own sign-in command suffix, appended to its launcher — exactly
 * what `prepareResourceNativeProfile` records as `loginCommand`
 * (core/resources/native-profile.ts). Derived here rather than read from
 * profile.json so a hand-edited manifest can never make Verse run argv it did
 * not build itself.
 */
export const SEAT_LOGIN_SUFFIX: Readonly<Record<NativeEngine, readonly string[]>> = {
  claude: ['auth', 'login', '--claudeai'],
  codex: ['login'],
  grok: ['--no-auto-update', 'login', '--oauth'],
};

/** The operator command that re-points a profile at another binary (src/cli/resource-profile.ts). */
export const SEAT_REPIN_ARGV: readonly string[] = ['ashlr', 'resources', 'profile', 'repin'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNativeEngine(value: unknown): value is NativeEngine {
  return value === 'claude' || value === 'codex' || value === 'grok';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readJsonCapped(path: string, maxBytes: number): unknown {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** `~/…` for a path under home, so operator-facing commands are copyable but not machine-specific. */
export function homeRelative(path: string, home: string = homedir()): string {
  const rel = relative(home, path);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return path;
  return `~/${rel.split(sep).join('/')}`;
}

// ---------------------------------------------------------------------------
// Account roster + native profile (PRIVATE: launchers never leave the process)
// ---------------------------------------------------------------------------

export interface NativeAccount {
  id: string;
  label: string;
  provider: NativeEngine;
  /** The launcher argv — the account's identity. Never serialize. */
  command: string[];
}

/**
 * connections.json → the native account roster, launcher included. The single
 * parse both seat discovery (seats.ts) and this sweep use, so the two can
 * never disagree about which accounts exist. Never throws.
 */
export function readNativeAccounts(accountsRoot: string): NativeAccount[] {
  const parsed = readJsonCapped(join(accountsRoot, 'connections.json'), MAX_CONNECTIONS_FILE_BYTES);
  if (!isRecord(parsed) || !Array.isArray(parsed['accounts'])) return [];
  const out: NativeAccount[] = [];
  const seen = new Set<string>();
  for (const entry of parsed['accounts']) {
    if (!isRecord(entry)) continue;
    const id = entry['id'];
    const provider = entry['provider'];
    const command = entry['command'];
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (!isNativeEngine(provider)) continue;
    if (!isStringArray(command) || command.length === 0) continue;
    const label = typeof entry['label'] === 'string' && entry['label'].length > 0 ? entry['label'] : id;
    seen.add(id);
    out.push({ id, label, provider, command: [...command] });
  }
  return out;
}

export interface NativeProfileManifest {
  /** The profile directory (`<…>/native-profiles/<account>`). */
  directory: string;
  /** CODEX_HOME / GROK_HOME / CLAUDE_CONFIG_DIR. */
  nativeStatePath: string | null;
  /** The one binary the launcher execs. */
  executable: string | null;
}

/**
 * `<profile>/profile.json` for an account's launcher argv (`…/launcher.mjs` ⇒
 * its directory). A manifest whose provider disagrees with the account is
 * IGNORED rather than half-trusted. Null whenever anything is missing.
 */
export function readNativeProfileManifest(command: readonly string[], provider: NativeEngine): NativeProfileManifest | null {
  const launcher = command.find((part) => typeof part === 'string' && part.endsWith('launcher.mjs'));
  if (launcher === undefined || !isAbsolute(launcher)) return null;
  const directory = dirname(launcher);
  const manifest = readJsonCapped(join(directory, 'profile.json'), MAX_PROFILE_BYTES);
  if (!isRecord(manifest)) return null;
  if (manifest['provider'] !== undefined && manifest['provider'] !== provider) return null;
  const absolute = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && isAbsolute(value) ? value : null;
  return {
    directory,
    nativeStatePath: absolute(manifest['nativeStatePath']),
    executable: absolute(manifest['executable']),
  };
}

/** The seat's sign-in argv: its own launcher plus the provider's login suffix. PRIVATE. */
export function seatLoginCommand(account: Pick<NativeAccount, 'command' | 'provider'>): string[] {
  return [...account.command, ...SEAT_LOGIN_SUFFIX[account.provider]];
}

// ---------------------------------------------------------------------------
// Credential timestamps — never the credential
// ---------------------------------------------------------------------------

export interface CredentialFacts {
  /** ISO expiry of the access credential; null when unknown. */
  expiresAt: string | null;
  /** ISO time the credential was last written/refreshed; null when unknown. */
  lastRefreshAt: string | null;
  /** Whether a refresh token is present (so expiry self-heals); null when unknown. */
  refreshable: boolean | null;
}

const NO_CREDENTIAL_FACTS: CredentialFacts = { expiresAt: null, lastRefreshAt: null, refreshable: null };

/**
 * The `exp` claim of a JWT as ISO, or null. Decodes the PAYLOAD segment only;
 * the signature and the token itself are discarded with the local variable.
 */
export function jwtExpiry(token: unknown): string | null {
  if (typeof token !== 'string' || token.length > 16_384) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) return null;
    const exp = payload['exp'];
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0 || exp > 253_402_300_799) return null;
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
}

/**
 * Codex `auth.json` (CODEX_HOME): `last_refresh` and the access token's `exp`.
 * Verified shape 2026-09-23: `{auth_mode, OPENAI_API_KEY, tokens: {id_token,
 * access_token, refresh_token, account_id}, last_refresh}` — the access JWT
 * lives ~10 days and codex refreshes it itself about 8 days in.
 */
export function readCodexCredentialFacts(nativeStatePath: string): CredentialFacts {
  const parsed = readJsonCapped(join(nativeStatePath, 'auth.json'), MAX_CREDENTIAL_FILE_BYTES);
  if (!isRecord(parsed)) return NO_CREDENTIAL_FACTS;
  const tokens = isRecord(parsed['tokens']) ? parsed['tokens'] : null;
  return {
    expiresAt: tokens ? jwtExpiry(tokens['access_token']) : null,
    lastRefreshAt: isoOrNull(parsed['last_refresh']),
    refreshable: tokens ? typeof tokens['refresh_token'] === 'string' && tokens['refresh_token'].length > 0 : null,
  };
}

/**
 * Grok `auth.json` (GROK_HOME): one entry per issuer, each with `expires_at`,
 * `create_time` and a `refresh_token`. The access key lives SIX HOURS by
 * design and the CLI refreshes it from the refresh token, so an entry with a
 * refresh token is `refreshable` and its short expiry is not a warning.
 */
export function readGrokCredentialFacts(nativeStatePath: string): CredentialFacts {
  const parsed = readJsonCapped(join(nativeStatePath, 'auth.json'), MAX_CREDENTIAL_FILE_BYTES);
  if (!isRecord(parsed)) return NO_CREDENTIAL_FACTS;
  let best: CredentialFacts | null = null;
  for (const entry of Object.values(parsed).slice(0, 16)) {
    if (!isRecord(entry)) continue;
    const facts: CredentialFacts = {
      expiresAt: isoOrNull(entry['expires_at']),
      lastRefreshAt: isoOrNull(entry['create_time']),
      refreshable: typeof entry['refresh_token'] === 'string' && entry['refresh_token'].length > 0,
    };
    // Several issuers: the most recently written entry is the live one.
    if (best === null || (facts.lastRefreshAt ?? '') > (best.lastRefreshAt ?? '')) best = facts;
  }
  return best ?? NO_CREDENTIAL_FACTS;
}

/**
 * The keychain service Claude Code stores a profile's OAuth credential under:
 * `Claude Code-credentials-<first 8 hex of sha256(CLAUDE_CONFIG_DIR)>`.
 * Verified 2026-09-23 against claude-a (`…780a8a19`).
 */
export function claudeKeychainService(configDir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

/**
 * `mdat` from `security find-generic-password` attribute output, as ISO.
 * The line looks like `"mdat"<timedate>=0x3230…00  "20260923210052Z\000"`.
 */
export function parseKeychainModifiedAt(output: string): string | null {
  const match = /"mdat"<timedate>=[^"\n]*"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(output);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return isoOrNull(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

// ---------------------------------------------------------------------------
// CLI builds — the pinned one versus the newest installed
// ---------------------------------------------------------------------------

export interface CliBuild {
  version: string;
  /** Canonical absolute path (repin refuses symlinks). PRIVATE until home-relativised. */
  executable: string;
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function canonical(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Newest `~/.local/share/claude/versions/<x.y.z>`. */
export function newestClaudeBuild(versionsRoot: string = defaultClaudeVersionsRoot()): CliBuild | null {
  const version = newestInstalledClaudeVersion(versionsRoot);
  return version === null ? null : { version, executable: join(versionsRoot, version) };
}

export function defaultGrokDownloadsRoot(home: string = homedir()): string {
  return join(home, '.grok', 'downloads');
}

/** Newest `~/.grok/downloads/grok-<x.y.z>-<platform>`; the unversioned `grok-<platform>` is skipped. */
export function newestGrokBuild(downloadsRoot: string = defaultGrokDownloadsRoot()): CliBuild | null {
  let names: string[];
  try {
    names = readdirSync(downloadsRoot).slice(0, MAX_DIR_ENTRIES);
  } catch {
    return null;
  }
  let best: CliBuild | null = null;
  for (const name of names) {
    const match = /^grok-(\d+\.\d+\.\d+)-/.exec(name);
    if (!match) continue;
    const path = join(downloadsRoot, name);
    if (!isExecutableFile(path)) continue;
    if (best === null || compareCliVersions(match[1]!, best.version) > 0) best = { version: match[1]!, executable: path };
  }
  return best;
}

/** `codex-cli 0.155.0-alpha.9.2` → `0.155.0-alpha.9.2`. */
export function parseCliVersionOutput(stdout: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(stdout);
  return match ? match[1]!.slice(0, 64) : null;
}

/**
 * Where codex builds live on a Mac (research r2/accounts.md): the npm global
 * package (Homebrew or /usr/local prefix), the Homebrew cask, and the copy
 * bundled inside ChatGPT.app. Only files that exist and are executable count.
 */
export function defaultCodexCandidates(home: string = homedir()): string[] {
  const out = [
    '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js',
    '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    join(home, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
  ];
  for (const caskRoot of ['/opt/homebrew/Caskroom/codex', '/usr/local/Caskroom/codex']) {
    let versions: string[];
    try {
      versions = readdirSync(caskRoot).slice(0, 32);
    } catch {
      continue;
    }
    for (const version of versions) {
      let files: string[];
      try {
        files = readdirSync(join(caskRoot, version)).slice(0, 32);
      } catch {
        continue;
      }
      for (const file of files) if (file.startsWith('codex')) out.push(join(caskRoot, version, file));
    }
  }
  return out;
}

/** Paths whose binary is replaced underneath the pin by an updater (npm, an app bundle). */
export function isFloatingInstall(path: string): boolean {
  return path.includes(`${sep}node_modules${sep}`) || /\.app\//.test(path);
}

// ---------------------------------------------------------------------------
// Login status parsing
// ---------------------------------------------------------------------------

/**
 * `codex login status`: "Logged in using ChatGPT" (exit 0) / "Not logged in"
 * (exit 1), verified on 0.136 and 0.155. Anything else is unknown. Only the
 * leading words are matched and the output is dropped immediately — the API-key
 * variant of the message carries a key prefix.
 */
export function parseCodexLoginStatus(stdout: string, stderr: string, exitCode: number): boolean | null {
  const text = `${stdout}\n${stderr}`.trim();
  if (/^Not logged in\b/im.test(text)) return false;
  if (exitCode === 0 && /^Logged in\b/im.test(text)) return true;
  return null;
}

// ---------------------------------------------------------------------------
// Probes (injectable)
// ---------------------------------------------------------------------------

export interface LoginProbeResult {
  /** true = signed in, false = the CLI said signed out, null = no answer. */
  loggedIn: boolean | null;
  /** Machine-readable probe reason, verbatim (never output text). */
  reason: string;
}

export interface SeatHealthProbes {
  claudeLogin(command: string[], cwd: string): Promise<LoginProbeResult>;
  codexLogin(command: string[], cwd: string): Promise<LoginProbeResult>;
  grokLogin(command: string[], cwd: string): Promise<LoginProbeResult>;
  /** Keychain `mdat` for a Claude config dir; null when absent/unreadable/not macOS. */
  claudeKeychainRefreshedAt(configDir: string): Promise<string | null>;
  /** `<executable> --version` for a build whose path does not name its version. */
  cliVersion(executable: string): Promise<string | null>;
  /** Ollama `/api/version`, or null when it does not answer. */
  ollamaVersion(baseUrl: string): Promise<string | null>;
}

function execFileText(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; code: number } | null> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024, env: workerEnvironment(), encoding: 'utf8' },
        (error, stdout) => {
          const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1) : 0;
          resolve({ stdout: typeof stdout === 'string' ? stdout : '', code });
        });
    } catch {
      resolve(null);
    }
  });
}

const versionCache = new Map<string, { key: string; version: string | null }>();

async function probeCodexLoginDefault(command: string[], cwd: string): Promise<LoginProbeResult> {
  try {
    const executed = await runVerifySubprocessAsync([...command, 'login', 'status'], {
      cwd, env: workerEnvironment(), timeoutMs: LOGIN_PROBE_TIMEOUT_MS, maxOutputChars: 4096, requireProcessGroupExit: true,
    });
    if (executed.timedOut) return { loggedIn: null, reason: 'status-timed-out' };
    if (executed.error && executed.exitCode !== 1) return { loggedIn: null, reason: 'status-process-failed' };
    const loggedIn = parseCodexLoginStatus(executed.stdout, executed.stderr, executed.exitCode);
    return {
      loggedIn,
      reason: loggedIn === true ? 'status-login-observed' : loggedIn === false ? 'status-not-logged-in' : 'status-output-invalid',
    };
  } catch {
    return { loggedIn: null, reason: 'status-process-failed' };
  }
}

export function defaultSeatHealthProbes(): SeatHealthProbes {
  return {
    async claudeLogin(command, cwd) {
      try {
        const result = await probeClaudeAccountStatus({ command, cwd, timeoutMs: LOGIN_PROBE_TIMEOUT_MS });
        return { loggedIn: result.status === 'observed' ? result.loggedIn : null, reason: result.reason };
      } catch {
        return { loggedIn: null, reason: 'status-configuration-invalid' };
      }
    },
    codexLogin: probeCodexLoginDefault,
    async grokLogin(command, cwd) {
      try {
        const result = await probeGrokAccount({ command, cwd, timeoutMs: LOGIN_PROBE_TIMEOUT_MS });
        if (result.status === 'observed' && result.loggedIn === true) return { loggedIn: true, reason: result.reason };
        // Only the reason that MEANS "no usable account" is a sign-out; a
        // transport failure is no reading (see VERSE_GROK_SIGNED_OUT_REASONS).
        if (VERSE_GROK_SIGNED_OUT_REASONS.includes(result.reason)) return { loggedIn: false, reason: result.reason };
        return { loggedIn: null, reason: result.reason };
      } catch {
        return { loggedIn: null, reason: 'probe-configuration-invalid' };
      }
    },
    async claudeKeychainRefreshedAt(configDir) {
      if (process.platform !== 'darwin') return null;
      // No `-w`: attributes only, so the secret is never read and no keychain
      // prompt can appear.
      const out = await execFileText('/usr/bin/security', ['find-generic-password', '-s', claudeKeychainService(configDir)], 3_000);
      return out && out.code === 0 ? parseKeychainModifiedAt(out.stdout) : null;
    },
    async cliVersion(executable) {
      let key: string;
      try {
        const stat = statSync(executable);
        key = `${stat.size}:${stat.mtimeMs}`;
      } catch {
        return null;
      }
      const cached = versionCache.get(executable);
      if (cached && cached.key === key) return cached.version;
      const out = await execFileText(executable, ['--version'], VERSION_PROBE_TIMEOUT_MS);
      const version = out && out.code === 0 ? parseCliVersionOutput(out.stdout) : null;
      versionCache.set(executable, { key, version });
      return version;
    },
    async ollamaVersion(baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS) });
        if (!res.ok) return null;
        const body = (await res.json()) as unknown;
        return isRecord(body) && typeof body['version'] === 'string' ? body['version'].slice(0, 64) : null;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** What one sweep learned about one native account. */
export interface SeatAccountFacts {
  accountId: string;
  provider: NativeEngine;
  checkedAt: string;
  loggedIn: boolean | null;
  probeReason: string | null;
  cliVersion: string | null;
  /** Newest installed build of this provider's CLI (PRIVATE path inside). */
  newest: CliBuild | null;
  /** PRIVATE profile directory, for the repin command only. */
  profileDirectory: string | null;
  credential: CredentialFacts;
}

export interface OllamaFacts {
  baseUrl: string;
  /** null = never checked. */
  reachable: boolean | null;
  version: string | null;
  checkedAt: string | null;
}

export interface SeatHealthSweepSnapshot {
  /** When the last complete sweep finished; null before the first. */
  sweptAt: string | null;
  sweeping: boolean;
  sweeps: number;
  accounts: ReadonlyMap<string, SeatAccountFacts>;
  ollama: OllamaFacts;
}

export interface SeatHealthSweepOptions {
  accountsRoot: string;
  ollamaBaseUrl: string;
  intervalMs?: number;
  initialDelayMs?: number;
  probes?: SeatHealthProbes;
  claudeVersionsRoot?: string;
  grokDownloadsRoot?: string;
  codexCandidates?: () => string[];
  /** Called after every completed sweep (A10's desktop shell reads /health instead). */
  onSweep?: (snapshot: SeatHealthSweepSnapshot) => void;
  /** Plain sentences only — never a command, path or token. */
  log?: (message: string) => void;
  now?: () => number;
}

export interface SeatHealthSweep {
  readonly intervalMs: number;
  start(): void;
  stop(): void;
  /** Run one sweep now (joins one already running). Never rejects. */
  sweep(): Promise<SeatHealthSweepSnapshot>;
  /** Re-check Ollama only (cheap; joins one in flight). Never rejects. */
  checkOllama(): Promise<OllamaFacts>;
  snapshot(): SeatHealthSweepSnapshot;
}

export function createSeatHealthSweep(options: SeatHealthSweepOptions): SeatHealthSweep {
  const intervalMs = Math.max(60_000, options.intervalMs ?? VERSE_HEALTH_SWEEP_MS);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? VERSE_HEALTH_INITIAL_DELAY_MS);
  const probes = options.probes ?? defaultSeatHealthProbes();
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const codexCandidates = options.codexCandidates ?? (() => defaultCodexCandidates());

  const accounts = new Map<string, SeatAccountFacts>();
  let ollama: OllamaFacts = { baseUrl: options.ollamaBaseUrl, reachable: null, version: null, checkedAt: null };
  let sweptAt: string | null = null;
  let sweeps = 0;
  let inFlight: Promise<SeatHealthSweepSnapshot> | null = null;
  let ollamaInFlight: Promise<OllamaFacts> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;

  const iso = (): string => new Date(now()).toISOString();

  function snapshot(): SeatHealthSweepSnapshot {
    return { sweptAt, sweeping: inFlight !== null, sweeps, accounts: new Map(accounts), ollama: { ...ollama } };
  }

  async function checkOllama(): Promise<OllamaFacts> {
    if (ollamaInFlight) return ollamaInFlight;
    ollamaInFlight = (async () => {
      let version: string | null = null;
      try { version = await probes.ollamaVersion(options.ollamaBaseUrl); } catch { version = null; }
      ollama = { baseUrl: options.ollamaBaseUrl, reachable: version !== null, version, checkedAt: iso() };
      return { ...ollama };
    })().finally(() => { ollamaInFlight = null; });
    return ollamaInFlight;
  }

  /** Newest codex across the known install locations, versions read from path or `--version`. */
  async function newestCodex(): Promise<CliBuild | null> {
    let best: CliBuild | null = null;
    const seen = new Set<string>();
    for (const candidate of codexCandidates()) {
      const path = canonical(candidate);
      if (path === null || seen.has(path) || !isExecutableFile(path)) continue;
      seen.add(path);
      const version = cliVersionFromExecutable(path) ?? await safe(() => probes.cliVersion(path), null);
      if (version === null) continue;
      if (best === null || compareCliVersions(version, best.version) > 0) best = { version, executable: path };
    }
    return best;
  }

  async function sweepAccount(
    account: NativeAccount,
    cwd: string | null,
    newestByProvider: Map<NativeEngine, CliBuild | null>,
  ): Promise<SeatAccountFacts> {
    const profile = readNativeProfileManifest(account.command, account.provider);
    let login: LoginProbeResult = { loggedIn: null, reason: 'status-not-checked' };
    if (cwd !== null) {
      const probe = account.provider === 'claude' ? probes.claudeLogin
        : account.provider === 'codex' ? probes.codexLogin : probes.grokLogin;
      login = await safe(() => probe(account.command, cwd), { loggedIn: null, reason: 'status-process-failed' });
    }

    let credential = NO_CREDENTIAL_FACTS;
    const statePath = profile?.nativeStatePath ?? null;
    if (statePath !== null) {
      if (account.provider === 'codex') credential = readCodexCredentialFacts(statePath);
      else if (account.provider === 'grok') credential = readGrokCredentialFacts(statePath);
      else {
        const refreshedAt = await safe(() => probes.claudeKeychainRefreshedAt(statePath), null);
        credential = { expiresAt: null, lastRefreshAt: refreshedAt, refreshable: null };
      }
    }

    const executable = profile?.executable ?? null;
    let cliVersion = executable ? cliVersionFromExecutable(executable) : null;
    if (cliVersion === null && executable !== null && account.provider === 'codex' && isExecutableFile(executable)) {
      cliVersion = await safe(() => probes.cliVersion(executable), null);
    }
    if (!newestByProvider.has(account.provider)) {
      const newest = account.provider === 'claude' ? newestClaudeBuild(options.claudeVersionsRoot)
        : account.provider === 'grok' ? newestGrokBuild(options.grokDownloadsRoot)
          : await newestCodex();
      newestByProvider.set(account.provider, newest);
    }
    return {
      accountId: account.id,
      provider: account.provider,
      checkedAt: iso(),
      loggedIn: login.loggedIn,
      probeReason: login.reason,
      cliVersion,
      newest: newestByProvider.get(account.provider) ?? null,
      profileDirectory: profile?.directory ?? null,
      credential,
    };
  }

  async function runSweep(): Promise<SeatHealthSweepSnapshot> {
    // Probes run in a fresh private (0700) scratch cwd; each native probe
    // makes its own scratch below tmpdir too, so this stays empty and is
    // removed non-recursively afterwards.
    let cwd: string | null = null;
    try {
      cwd = mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-seat-health-'));
    } catch {
      log('Verse seat health: could not create a private scratch directory; login status is unknown this sweep.');
    }
    try {
      const roster = readNativeAccounts(options.accountsRoot);
      const newestByProvider = new Map<NativeEngine, CliBuild | null>();
      const live = new Set<string>();
      // ONE AT A TIME: a sweep is background hygiene, never a burst.
      for (const account of roster) {
        live.add(account.id);
        accounts.set(account.id, await sweepAccount(account, cwd, newestByProvider));
      }
      for (const id of [...accounts.keys()]) if (!live.has(id)) accounts.delete(id);
      await checkOllama();
      sweeps += 1;
      sweptAt = iso();
    } catch {
      log('Verse seat health: a sweep failed part-way; the previous readings are kept.');
    } finally {
      if (cwd !== null) { try { rmdirSync(cwd); } catch { /* a probe left something behind; leave it private */ } }
    }
    const out = snapshot();
    try { options.onSweep?.(out); } catch { /* observer errors never stop the sweep */ }
    return out;
  }

  function sweep(): Promise<SeatHealthSweepSnapshot> {
    if (inFlight) return inFlight;
    inFlight = runSweep().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    intervalMs,
    start() {
      if (timer !== null || first !== null) return;
      first = setTimeout(() => { first = null; void sweep(); }, initialDelayMs);
      first.unref?.();
      // Deliberately NOT tied to client interest: the whole point is to notice
      // a sign-out while the app is hidden.
      timer = setInterval(() => { void sweep(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (first !== null) { clearTimeout(first); first = null; }
      if (timer !== null) { clearInterval(timer); timer = null; }
    },
    sweep,
    checkOllama,
    snapshot,
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const PROVIDER_CLI: Record<NativeEngine, string> = { claude: 'Claude Code', codex: 'Codex CLI', grok: 'Grok CLI' };

function atMs(iso: string | null | undefined): number {
  if (typeof iso !== 'string') return Number.NaN;
  return Date.parse(iso);
}

/**
 * Is this credential about to lapse? Codex: its access token's `exp` is
 * within the warning window (it refreshes only while a codex process runs,
 * so a long idle gap is exactly when it lapses). Grok: only without a refresh
 * token — its six-hour key is designed to be short. Claude: no machine-read
 * expiry exists, so never.
 */
export function credentialExpiring(provider: NativeEngine, credential: CredentialFacts, now: number): boolean {
  const expires = atMs(credential.expiresAt);
  if (!Number.isFinite(expires) || expires - now > VERSE_CREDENTIAL_WARN_MS) return false;
  if (provider === 'codex') return true;
  if (provider === 'grok') return credential.refreshable === false;
  return false;
}

function repinFix(facts: SeatAccountFacts): SeatHealthFix {
  if (facts.profileDirectory === null || facts.newest === null) return { kind: 'repin' };
  return {
    kind: 'repin',
    command: [
      ...SEAT_REPIN_ARGV,
      '--directory', homeRelative(facts.profileDirectory),
      '--executable', homeRelative(facts.newest.executable),
    ],
  };
}

function localDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Plain words for the probe reasons an operator is likely to see; the code itself otherwise. */
export function probeReasonText(reason: string | null): string {
  switch (reason) {
    case null: return 'no answer';
    case 'status-not-checked': return 'the sweep could not run the status command';
    case 'status-timed-out':
    case 'probe-timed-out': return 'the status command timed out';
    case 'status-process-failed':
    case 'probe-native-unavailable': return 'the CLI could not be started';
    case 'status-output-invalid':
    case 'probe-protocol-invalid': return 'the CLI answered in a shape Verse does not recognise';
    case 'status-termination-uncertain': return 'the status command did not exit cleanly';
    case 'probe-account-hint-mismatch':
    case 'probe-account-changed': return 'the CLI is signed in to a different account than expected';
    default: return reason;
  }
}

function nativeReport(seat: VerseSeat, facts: SeatAccountFacts | null, checkedAt: string, now: number): SeatHealthReport {
  const engine = seat.engine as NativeEngine;
  const capacity = seat.capacity ?? null;

  // Two witnesses of sign-in state: this sweep's status command, and the live
  // collector's projection (seat.capacity/health). When they disagree the
  // NEWER one wins — a sign-in done after a failed sweep must clear the alarm
  // at the collector's next cycle, not ten minutes later.
  const liveAt = atMs(capacity?.observedAt ?? seat.health.observedAt);
  const liveSignedOut = capacity?.usability === 'signed-out';
  const liveSignedIn = !liveSignedOut && seat.health.state === 'ready' && Number.isFinite(liveAt);
  const sweepAt = atMs(facts?.checkedAt);
  const sweepSignedOut = facts?.loggedIn === false;
  const sweepSignedIn = facts?.loggedIn === true;
  let signedOut: boolean;
  if (liveSignedOut && sweepSignedIn) signedOut = !(sweepAt > liveAt);
  else if (sweepSignedOut && liveSignedIn) signedOut = !(liveAt > sweepAt);
  else signedOut = liveSignedOut || sweepSignedOut;
  const signedIn = !signedOut && (sweepSignedIn || liveSignedIn);

  const exhausted = !signedOut && capacity?.usability === 'exhausted';
  const credential = facts?.credential ?? NO_CREDENTIAL_FACTS;
  const expiring = !signedOut && credentialExpiring(engine, credential, now);
  const cliVersion = facts?.cliVersion ?? seat.cliVersion ?? null;
  const newest = facts?.newest ?? null;
  const skew = cliVersion !== null && newest !== null && compareCliVersions(newest.version, cliVersion) > 0;

  let connection: SeatConnection;
  if (signedOut) connection = 'signed-out';
  else if (exhausted) connection = 'exhausted';
  else if (!signedIn && capacity?.usability !== 'tight' && capacity?.usability !== 'ready') connection = 'unknown';
  else if (expiring) connection = 'expiring';
  else if (skew) connection = 'binary-skew';
  else connection = 'connected';

  const reasons: string[] = [];
  let fix: SeatHealthFix = { kind: 'none' };
  let resetAt: string | null = null;

  if (connection === 'signed-out') {
    reasons.push(`${PROVIDER_CLI[engine]} reports this account is not signed in.`);
    reasons.push("Reconnect opens the account's own sign-in in Terminal; Verse never sees the credentials.");
    fix = { kind: 'reauth' };
  } else if (connection === 'exhausted') {
    // When the seat actually REOPENS — the latest spent-window reset — not the
    // binding window's: `binding` keeps the first window among equal
    // percentages, so two spent windows named the earlier reset while Accounts
    // and Fleet said the later one. A spent window with only prose makes the
    // instant unknown (null), and its prose is shown instead.
    const reopening = seatReopening(capacity);
    resetAt = reopening.resetAt;
    const prose = reopening.resetDescription;
    reasons.push(resetAt !== null
      ? `Every usage window with a reading is spent; it resets ${localDate(resetAt)}.`
      : prose !== null
        ? `Every usage window with a reading is spent (${prose}).`
        : 'Every usage window with a reading is spent; the provider gave no reset time.');
    fix = { kind: 'wait' };
  } else if (connection === 'unknown') {
    reasons.push(facts === null
      ? 'No status reading yet — the background health sweep has not reached this seat.'
      : `The sign-in status could not be read: ${probeReasonText(facts.probeReason)}.`);
  } else if (connection === 'expiring') {
    const expiresAt = credential.expiresAt!;
    const refreshed = credential.lastRefreshAt !== null ? `; last refreshed ${localDate(credential.lastRefreshAt)}` : '';
    reasons.push(`The access credential expires ${localDate(expiresAt)}${refreshed}. Use this seat or reconnect before then.`);
    fix = { kind: 'reauth' };
  } else if (connection === 'binary-skew') {
    reasons.push(`Pinned to ${PROVIDER_CLI[engine]} ${cliVersion}; ${newest!.version} is installed. Re-pin to pick up newer models.`);
    if (isFloatingInstall(newest!.executable)) {
      reasons.push('That build lives where an updater replaces it; copy it into a versioned directory before pinning to it.');
    }
    fix = repinFix(facts!);
  }

  return {
    seatId: seat.id,
    engine,
    connection,
    checkedAt,
    cliVersion,
    newestCliVersion: newest?.version ?? null,
    credentialExpiresAt: credential.expiresAt,
    lastRefreshAt: credential.lastRefreshAt,
    resetAt,
    reasons,
    fix,
  };
}

function localReport(seat: VerseSeat, ollama: OllamaFacts, checkedAt: string): SeatHealthReport {
  const connection: SeatConnection = ollama.reachable === true ? 'connected' : 'unknown';
  // Never checked yet: unknown with no reasons (no signal is not a fault).
  const reasons = ollama.reachable === false
    ? [`Ollama is not answering at ${ollama.baseUrl}. Start it (\`ollama serve\`) to use local models.`]
    : [];
  return {
    seatId: seat.id,
    engine: 'local',
    connection,
    checkedAt,
    cliVersion: null,
    newestCliVersion: null,
    credentialExpiresAt: null,
    lastRefreshAt: null,
    resetAt: null,
    reasons,
    fix: { kind: 'none' },
  };
}

/**
 * One report per seat, from this sweep's facts fused with the seat's LIVE
 * telemetry (which the caller refreshes from the account collector on every
 * read). Pure: no I/O, so it is safe on any request path.
 */
export function buildSeatHealthReports(input: {
  seats: readonly VerseSeat[];
  snapshot: SeatHealthSweepSnapshot;
  now?: number;
}): SeatHealthReport[] {
  const now = input.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  return input.seats.map((seat) => seat.engine === 'local'
    ? localReport(seat, input.snapshot.ollama, checkedAt)
    : nativeReport(seat, input.snapshot.accounts.get(seat.accountId) ?? null, checkedAt, now));
}

// ---------------------------------------------------------------------------
// Reconnect — open the seat's own login in Terminal
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Printable, single-line label for the script banner (it is quoted anyway). */
function bannerLabel(label: string): string {
  return label.replace(/[^\x20-\x7e]/g, '').slice(0, 80) || 'this seat';
}

/**
 * The `.command` script Terminal runs. It deletes itself first (it names the
 * private launcher), prints why the window opened, then EXECs the login so
 * the provider's own flow owns the terminal. Every argv element is quoted;
 * nothing is interpolated unquoted.
 */
export function buildReconnectScript(login: readonly string[], label: string): string {
  return [
    '#!/bin/sh',
    'rm -f -- "$0"',
    `printf '%s\\n' ${shellQuote(`Ashlr Verse: signing in ${bannerLabel(label)}. Follow the prompts; Verse never sees your credentials.`)}`,
    `exec ${login.map(shellQuote).join(' ')}`,
    '',
  ].join('\n');
}

export interface ReconnectOpener {
  (scriptPath: string): Promise<void>;
}

/** macOS: `open -a Terminal <script>` (no shell). */
export const openInTerminal: ReconnectOpener = (scriptPath) => new Promise((resolve, reject) => {
  execFile('/usr/bin/open', ['-a', 'Terminal', scriptPath], { timeout: 10_000 }, (error) => {
    if (error) reject(new Error('Terminal could not be opened'));
    else resolve();
  });
});

/** Where reconnect scripts are written: a private 0700 directory under ~/.ashlr/verse. */
export function reconnectScriptDir(home: string = homedir()): string {
  return join(home, '.ashlr', 'verse', 'health');
}

/**
 * Write the reconnect script (0700, in a 0700 directory) and hand it to
 * Terminal. Throws with a plain, path-free sentence on failure.
 */
export async function openSeatLogin(input: {
  account: Pick<NativeAccount, 'command' | 'provider' | 'label' | 'id'>;
  dir?: string;
  open?: ReconnectOpener;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin') {
    throw new Error('Opening a sign-in window is supported on macOS only; run the seat\'s login command in a terminal.');
  }
  const dir = input.dir ?? reconnectScriptDir();
  let script: string;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const safeId = input.account.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
    script = join(dir, `reconnect-${safeId}-${randomBytes(4).toString('hex')}.command`);
    writeFileSync(script, buildReconnectScript(seatLoginCommand(input.account), input.account.label), { mode: 0o700, flag: 'wx' });
  } catch {
    throw new Error('The sign-in script could not be written.');
  }
  await (input.open ?? openInTerminal)(script);
}

// ---------------------------------------------------------------------------
// Process-wide registry
// ---------------------------------------------------------------------------
//
// The engine's admission gate (`getSeatReadiness` in seats.ts) has only a seat
// id in hand. The health service — created by core/verse/health-api.ts, which
// owns seat discovery — registers here so the gate can read the current seats
// and reports without seats.ts importing the API layer (which imports seats.ts).

export interface VerseHealthCurrent {
  seats: VerseSeat[];
  reports: SeatHealthReport[];
  checkedAt: string;
}

export interface VerseHealthService {
  readonly sweep: SeatHealthSweep;
  /** Seats with LIVE telemetry fused with the latest sweep. Sync and cheap. */
  current(): VerseHealthCurrent;
  close(): void;
}

let healthService: VerseHealthService | null = null;

export function setVerseHealthService(service: VerseHealthService | null): void {
  healthService = service;
}

export function getVerseHealthService(): VerseHealthService | null {
  return healthService;
}
