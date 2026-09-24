/**
 * Custody client — V3.10 Track B (owner: unit U2).
 *
 * The daemon-side wrapper around `ashlr-custody` (tools/custody, Swift): a
 * root-owned helper holding a non-exportable Secure Enclave P-256 key behind
 * Touch ID plus Keychain items only the helper can read. `sign-grant` is the
 * ONLY signing path (the helper strictly parses StandingGrantV1, refuses
 * unknown keys and over-ceiling values, and shows the full scope in the Touch
 * ID prompt). Token minting needs no presence, so the fleet can run 24/7.
 *
 * The exported names and signatures of the day-0 stub are a FROZEN cross-unit
 * contract (U1 signs grants and runs setup through them; U3/U4 mint GitHub
 * tokens; U7/U8 fetch the claude-a token for restricted judge / Leader calls).
 * Everything else here is additive.
 *
 * TRUST BOUNDARY. The helper is trusted only when it is exactly the root-owned
 * binary at CUSTODY_HELPER_PATH inside root-owned, non-writable directories —
 * checked before EVERY call. No environment variable, config value or file can
 * point this client at another binary (tests inject a runner in-process).
 * Even so, nothing the helper returns is taken on faith: a signed grant must
 * carry byte-for-byte the payload that was asked for and verify against the
 * helper's own public key, and tokens must have the expected shape.
 *
 * Secrets rule: tokens returned here are never logged, persisted, placed in
 * argv, or returned from an API — they go straight into a child env / header.
 * Secrets travel to the helper on stdin and back on stdout only, and no error
 * message ever includes them (helper stderr is scrubbed before it is shown).
 *
 * Honesty rule: in CustodyStatus, `null` means unknown (e.g. helper missing).
 */
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { scrubPrivateText } from '../util/scrub.js';
import { canonicalJson } from './canonical-json.js';
import {
  STANDING_GRANT_PATTERNS,
  STANDING_GRANT_SIGNING_DOMAIN,
  type SignedStandingGrantV1,
  type StandingGrantV1,
} from './types.js';

/** Where Phase 0 installs the helper (root-owned; confined agents are denied exec of it). */
export const CUSTODY_HELPER_PATH = '/usr/local/libexec/ashlr-custody';

/**
 * The helper's private data directory relative to the user's home (key blob +
 * public-key record). Every autonomous sandbox profile denies reading it.
 */
export const CUSTODY_DATA_DIR_RELATIVE = 'Library/Application Support/ashlr-custody';

/** `<home>/Library/Application Support/ashlr-custody`. */
export function custodyDataDir(home: string): string {
  return join(home, CUSTODY_DATA_DIR_RELATIVE);
}

export interface CustodyStatus {
  /** Helper present at CUSTODY_HELPER_PATH, root-owned, not writable by Mason's uid. */
  installed: boolean;
  version: string | null;
  /** null = unknown (e.g. helper missing). */
  keyInitialized: boolean | null;
  keyId: string | null;
  /** The GitHub App private key is stored in the custody Keychain item. */
  githubApp: boolean | null;
  /** The claude-a setup token is stored. */
  claudeToken: boolean | null;
  checkedAt: string;
  /** Specific sentences for whatever is missing. */
  reasons: string[];
}

/** `ashlr-custody init` output. */
export interface CustodyKeyInfo {
  keyId: string;
  /** SPKI PEM — becomes a StandingGrantTrustRoot in Mason's own trust-roots PR. */
  publicKeyPem: string;
}

export interface CustodyToken {
  /** SECRET. Never log, persist or echo it. */
  token: string;
  /** ISO expiry when known (GitHub installation tokens: 1 h); null = unknown. */
  expiresAt: string | null;
}

/** From the GitHub App Manifest flow; the PEM goes to the helper over stdin and never touches disk. */
export interface GithubAppCredential {
  appId: string;
  /** SECRET. */
  privateKeyPem: string;
}

/**
 * Stable failure codes: the helper's own (usage, refused, key-missing,
 * key-exists, keyid-mismatch, host-mismatch, not-stored, auth-cancelled,
 * auth-failed, keystore, secure-enclave, github, network, internal) plus the
 * client's (not-installed, not-root-owned, timeout, helper-failed, bad-output,
 * signature-mismatch).
 */
export class CustodyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CustodyError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Helper invocation
// ---------------------------------------------------------------------------

export interface CustodyRunRequest {
  args: readonly string[];
  /** Written to the helper's stdin (payloads and secrets never go in argv). */
  input?: string;
  timeoutMs: number;
}

export interface CustodyRunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CustodyRunner = (request: CustodyRunRequest) => Promise<CustodyRunResult>;

const MAX_OUTPUT_BYTES = 1024 * 1024;

const TIMEOUT_MS = {
  quick: 10_000,
  /** Touch ID waits on Mason reading the prompt. */
  presence: 180_000,
  store: 30_000,
  /** Two HTTPS calls to api.github.com, 20 s each inside the helper. */
  github: 60_000,
} as const;

/**
 * Why the installed helper cannot be trusted, or null when it can. The binary
 * and every directory above it must be root-owned, not symlinks, and not
 * group/world-writable — otherwise a process running as Mason could swap it.
 */
export function custodyHelperInstallProblem(path: string = CUSTODY_HELPER_PATH): string | null {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return `ashlr-custody is not installed at ${path} — run \`sudo scripts/install-custody.sh\``;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return `${path} is not a regular file`;
  if (stat.uid !== 0) return `${path} is not owned by root — reinstall with \`sudo scripts/install-custody.sh\``;
  if ((stat.mode & 0o022) !== 0) return `${path} is group- or world-writable`;
  if ((stat.mode & 0o111) === 0) return `${path} is not executable`;
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      return `cannot inspect ${dir}`;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return `${dir} is not a plain directory`;
    if (dirStat.uid !== 0) return `${dir} is not owned by root`;
    if ((dirStat.mode & 0o022) !== 0) return `${dir} is group- or world-writable`;
    if (dir === dirname(dir)) break;
  }
  return null;
}

/**
 * A fixed, minimal environment: nothing from the caller's env (DYLD_*,
 * GIT_*, tokens) reaches the helper. HOME/USER come from the password
 * database, like the helper's own key directory, never from $HOME.
 */
function helperEnv(): NodeJS.ProcessEnv {
  let home = '/var/empty';
  let user = 'nobody';
  try {
    const info = userInfo();
    home = info.homedir;
    user = info.username;
  } catch {
    /* fall back to inert values; the helper resolves its own home */
  }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: user, LOGNAME: user, LANG: 'en_US.UTF-8' };
}

const defaultRunner: CustodyRunner = (request) =>
  new Promise((resolve) => {
    const problem = custodyHelperInstallProblem();
    if (problem !== null) {
      resolve({ code: null, signal: null, stdout: '', stderr: installProblemLine(problem), timedOut: false });
      return;
    }
    const child = spawn(CUSTODY_HELPER_PATH, [...request.args], {
      env: helperEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let overflow = false;
    let timedOut = false;
    const cap = (current: string, chunk: Buffer): string => {
      if (current.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = cap(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = cap(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: overflow ? null : code, signal, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => { /* helper exited before reading stdin; its exit code says why */ });
    child.stdin.end(request.input ?? '');
  });

/** Marker line the default runner uses to report an untrusted install without spawning. */
function installProblemLine(problem: string): string {
  return JSON.stringify({ error: { code: 'not-installed', message: problem } });
}

let runner: CustodyRunner = defaultRunner;

/** TEST SEAM (in-process only): replace how the helper is run. null restores the real helper. */
export function _setCustodyRunnerForTest(next: CustodyRunner | null): void {
  runner = next ?? defaultRunner;
  resetCaches();
}

/** TEST SEAM: forget cached status / tokens. */
export function _resetCustodyClientForTest(): void {
  resetCaches();
}

function scrub(text: string): string {
  return scrubPrivateText(text).slice(0, 500);
}

/** Run one helper command and return its parsed stdout object, or throw CustodyError. */
async function runHelper(args: readonly string[], timeoutMs: number, input?: string): Promise<Record<string, unknown>> {
  const result = await runner({ args, timeoutMs, ...(input !== undefined ? { input } : {}) });
  if (result.timedOut) {
    throw new CustodyError('timeout', `ashlr-custody ${args[0]} did not finish within ${Math.round(timeoutMs / 1000)} s`);
  }
  if (result.code !== 0) {
    const reported = lastErrorLine(result.stderr);
    if (reported) {
      const code = reported.code === 'not-installed' && /not owned by root|writable|symlink|not a/.test(reported.message)
        ? 'not-root-owned'
        : reported.code;
      throw new CustodyError(code, scrub(reported.message));
    }
    const how = result.signal ? `was killed by ${result.signal}` : result.code === null ? 'could not run' : `exited with code ${result.code}`;
    throw new CustodyError('helper-failed', `ashlr-custody ${args[0]} ${how}`);
  }
  const lines = result.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new CustodyError('bad-output', `ashlr-custody ${args[0]} printed ${lines.length} lines; expected 1`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines[0]!);
  } catch {
    throw new CustodyError('bad-output', `ashlr-custody ${args[0]} printed something that is not JSON`);
  }
  if (!isPlainRecord(parsed)) throw new CustodyError('bad-output', `ashlr-custody ${args[0]} did not print a JSON object`);
  return parsed;
}

/** The helper's protocol: the LAST stderr line is {"error":{"code","message"}}. */
function lastErrorLine(stderr: string): { code: string; message: string } | null {
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    if (!isPlainRecord(parsed) || !isPlainRecord(parsed['error'])) return null;
    const { code, message } = parsed['error'];
    if (typeof code !== 'string' || !/^[a-z-]{1,40}$/.test(code) || typeof message !== 'string') return null;
    return { code, message };
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], command: string): void {
  const got = Object.keys(value).sort();
  const want = [...keys].sort();
  if (got.length !== want.length || got.some((key, i) => key !== want[i])) {
    throw new CustodyError('bad-output', `ashlr-custody ${command} returned keys [${got.join(', ')}]; expected [${want.join(', ')}]`);
  }
}

// ---------------------------------------------------------------------------
// Public key helpers (shared with the Swift helper's KeyMaterial)
// ---------------------------------------------------------------------------

/**
 * `se-p256-` + first 16 hex of sha256(SPKI DER) — the helper's deterministic
 * key id, recomputable by anyone reviewing a trust-roots PR.
 */
export function keyIdForPublicKeyPem(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `se-p256-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function p256PublicKey(pem: unknown, command: string): KeyObject {
  if (typeof pem !== 'string' || pem.length > 4096 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new CustodyError('bad-output', `ashlr-custody ${command} returned no public key PEM`);
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new CustodyError('bad-output', `ashlr-custody ${command} returned an unreadable public key`);
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new CustodyError('bad-output', `ashlr-custody ${command} returned a key that is not P-256`);
  }
  return key;
}

function keyInfo(out: Record<string, unknown>, command: string): CustodyKeyInfo {
  exactKeys(out, ['keyId', 'publicKeyPem'], command);
  p256PublicKey(out['publicKeyPem'], command);
  const publicKeyPem = out['publicKeyPem'] as string;
  const keyId = out['keyId'];
  if (typeof keyId !== 'string' || !STANDING_GRANT_PATTERNS.keyId.test(keyId) || keyId !== keyIdForPublicKeyPem(publicKeyPem)) {
    throw new CustodyError('bad-output', `ashlr-custody ${command} returned a key id that does not match its public key`);
  }
  return { keyId, publicKeyPem };
}

// ---------------------------------------------------------------------------
// Caches (tokens live in memory only, never on disk)
// ---------------------------------------------------------------------------

const STATUS_CACHE_MS = 5_000;
/** Re-mint a GitHub token when it has less than this left (runs can take a while). */
const GITHUB_TOKEN_MIN_REMAINING_MS = 10 * 60_000;
const CLAUDE_TOKEN_CACHE_MS = 10 * 60_000;

let statusCache: { at: number; value: CustodyStatus } | null = null;
const githubTokens = new Map<string, { value: CustodyToken; expiresAtMs: number }>();
const githubInflight = new Map<string, Promise<CustodyToken>>();
let claudeCache: { at: number; value: CustodyToken } | null = null;

function resetCaches(): void {
  statusCache = null;
  githubTokens.clear();
  githubInflight.clear();
  claudeCache = null;
}

// ---------------------------------------------------------------------------
// Frozen contract
// ---------------------------------------------------------------------------

/** Zero-cost status probe (no Touch ID, no network). Never throws. */
export async function custodyStatus(): Promise<CustodyStatus> {
  const now = Date.now();
  if (statusCache && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const checkedAt = new Date(now).toISOString();
  let value: CustodyStatus;
  try {
    const out = await runHelper(['status'], TIMEOUT_MS.quick);
    exactKeys(out, ['v', 'version', 'secureEnclave', 'keyInitialized', 'keyId', 'githubApp', 'claudeToken'], 'status');
    const version = typeof out['version'] === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(out['version']) ? out['version'] : null;
    const flag = (key: string): boolean | null => (typeof out[key] === 'boolean' ? (out[key] as boolean) : null);
    const keyId = typeof out['keyId'] === 'string' && STANDING_GRANT_PATTERNS.keyId.test(out['keyId']) ? out['keyId'] : null;
    const reasons: string[] = [];
    if (flag('secureEnclave') === false) reasons.push('This Mac has no Secure Enclave, so it cannot hold the custody key.');
    const keyInitialized = flag('keyInitialized');
    if (keyInitialized === false) reasons.push('No custody key yet — run `/usr/local/libexec/ashlr-custody init` (Touch ID).');
    if (keyInitialized === null) reasons.push('The custody key files could not be read — check ~/Library/Application Support/ashlr-custody.');
    const githubApp = flag('githubApp');
    if (githubApp === false) reasons.push('The ashlr-fleet GitHub App key is not stored — run `ashlr authority github-app`.');
    const claudeToken = flag('claudeToken');
    if (claudeToken === false) reasons.push('No Claude token stored — run `claude setup-token`, then `ashlr-custody store-claude-token`.');
    value = { installed: true, version, keyInitialized, keyId, githubApp, claudeToken, checkedAt, reasons };
  } catch (error) {
    const custody = error instanceof CustodyError ? error : new CustodyError('helper-failed', 'ashlr-custody status failed');
    const installed = custody.code === 'not-installed' || custody.code === 'not-root-owned' ? false : true;
    value = {
      installed,
      version: null,
      keyInitialized: null,
      keyId: null,
      githubApp: null,
      claudeToken: null,
      checkedAt,
      reasons: [custody.message],
    };
  }
  statusCache = { at: now, value };
  return value;
}

/** `ashlr-custody init` — creates the Secure Enclave key (Touch ID). */
export async function custodyInit(): Promise<CustodyKeyInfo> {
  statusCache = null;
  const out = await runHelper(['init'], TIMEOUT_MS.presence);
  statusCache = null;
  return keyInfo(out, 'init');
}

/** `ashlr-custody pubkey` — the current key's id and SPKI PEM (no Touch ID). */
export async function custodyPublicKey(): Promise<CustodyKeyInfo> {
  return keyInfo(await runHelper(['pubkey'], TIMEOUT_MS.quick), 'pubkey');
}

/** `ashlr-custody host-binding` — sha256 hex of this Mac's IOPlatformUUID (StandingGrantV1.hostBinding). */
export async function custodyHostBinding(): Promise<string> {
  const out = await runHelper(['host-binding'], TIMEOUT_MS.quick);
  exactKeys(out, ['hostBinding'], 'host-binding');
  const binding = out['hostBinding'];
  if (typeof binding !== 'string' || !STANDING_GRANT_PATTERNS.sha256Hex.test(binding)) {
    throw new CustodyError('bad-output', 'ashlr-custody host-binding returned an invalid digest');
  }
  return binding;
}

/**
 * `ashlr-custody sign-grant` — Touch ID, with the grant's scope rendered in
 * the prompt by the helper itself. Resolves to the signed envelope; rejects
 * when Mason cancels or the helper refuses the payload.
 *
 * The envelope is accepted only if its payload is byte-for-byte (canonically)
 * the one requested and its ES256 signature verifies against the helper's
 * public key — so a misbehaving helper can never hand back a different grant.
 */
export async function signGrant(payload: StandingGrantV1): Promise<SignedStandingGrantV1> {
  let requested: string;
  try {
    requested = canonicalJson(payload);
  } catch {
    throw new CustodyError('refused', 'the grant payload is not plain JSON');
  }
  const key = await custodyPublicKey();
  if (payload.keyId !== key.keyId) {
    throw new CustodyError('keyid-mismatch', `the grant names key ${String(payload.keyId)} but the custody helper holds ${key.keyId}`);
  }
  const out = await runHelper(['sign-grant', '-'], TIMEOUT_MS.presence, requested);
  exactKeys(out, ['payload', 'signature'], 'sign-grant');
  const signature = out['signature'];
  if (typeof signature !== 'string' || !STANDING_GRANT_PATTERNS.signature.test(signature)) {
    throw new CustodyError('bad-output', 'ashlr-custody sign-grant returned a malformed signature');
  }
  let returned: string;
  try {
    returned = canonicalJson(out['payload']);
  } catch {
    throw new CustodyError('bad-output', 'ashlr-custody sign-grant returned an unreadable payload');
  }
  if (returned !== requested) {
    throw new CustodyError('signature-mismatch', 'ashlr-custody signed a payload different from the one requested');
  }
  const message = Buffer.from(`${STANDING_GRANT_SIGNING_DOMAIN}${requested}`, 'utf8');
  const ok = verifySignature('sha256', message, { key: p256PublicKey(key.publicKeyPem, 'pubkey'), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64'));
  if (!ok) throw new CustodyError('signature-mismatch', "the signature does not verify against the custody helper's public key");
  return { payload: JSON.parse(requested) as StandingGrantV1, signature };
}

/** `ashlr-custody store-github-app` — Keychain item whose ACL trusts only the helper. */
export async function storeGithubApp(credential: GithubAppCredential): Promise<void> {
  if (typeof credential.appId !== 'string' || !/^[0-9]{1,20}$/.test(credential.appId)) {
    throw new CustodyError('refused', 'appId must be the GitHub App numeric id');
  }
  let details;
  try {
    details = createPrivateKey(credential.privateKeyPem);
  } catch {
    throw new CustodyError('refused', 'privateKeyPem is not a private key PEM');
  }
  if (details.asymmetricKeyType !== 'rsa' || (details.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new CustodyError('refused', 'the GitHub App key must be RSA, at least 2048 bits');
  }
  statusCache = null;
  const out = await runHelper(['store-github-app'], TIMEOUT_MS.store,
    JSON.stringify({ appId: credential.appId, privateKeyPem: credential.privateKeyPem }));
  exactKeys(out, ['ok', 'appId'], 'store-github-app');
  if (out['ok'] !== true || out['appId'] !== credential.appId) {
    throw new CustodyError('bad-output', 'ashlr-custody did not confirm the stored App credential');
  }
  statusCache = null;
  githubTokens.clear();
}

/** `ashlr-custody store-claude-token` — the `claude setup-token` output, via stdin. */
export async function storeClaudeToken(token: string): Promise<void> {
  const trimmed = typeof token === 'string' ? token.trim() : '';
  if (!isOpaqueToken(trimmed)) throw new CustodyError('refused', 'that does not look like a Claude setup token');
  statusCache = null;
  const out = await runHelper(['store-claude-token'], TIMEOUT_MS.store, `${trimmed}\n`);
  exactKeys(out, ['ok'], 'store-claude-token');
  if (out['ok'] !== true) throw new CustodyError('bad-output', 'ashlr-custody did not confirm the stored token');
  statusCache = null;
  claudeCache = null;
}

/**
 * `ashlr-custody gh-token --repo owner/name` — a 1-hour installation token
 * scoped to ONE repo with only the fleet's permissions. Cached in memory
 * until it has less than 10 minutes left; concurrent callers share one mint.
 */
export async function githubToken(repo: string): Promise<CustodyToken> {
  if (typeof repo !== 'string' || !STANDING_GRANT_PATTERNS.nameWithOwner.test(repo)) {
    throw new CustodyError('refused', 'repo must be owner/name');
  }
  const cacheKey = repo.toLowerCase();
  const cached = githubTokens.get(cacheKey);
  if (cached && cached.expiresAtMs - Date.now() > GITHUB_TOKEN_MIN_REMAINING_MS) return cached.value;
  const pending = githubInflight.get(cacheKey);
  if (pending) return pending;
  const mint = (async (): Promise<CustodyToken> => {
    const out = await runHelper(['gh-token', '--repo', repo], TIMEOUT_MS.github);
    exactKeys(out, ['token', 'expiresAt'], 'gh-token');
    const token = out['token'];
    const expiresAt = out['expiresAt'];
    if (typeof token !== 'string' || !/^ghs_[A-Za-z0-9_]{20,251}$/.test(token)) {
      throw new CustodyError('bad-output', 'ashlr-custody gh-token did not return an installation token');
    }
    const expiresAtMs = typeof expiresAt === 'string' && STANDING_GRANT_PATTERNS.isoInstant.test(expiresAt) ? Date.parse(expiresAt) : NaN;
    const remaining = expiresAtMs - Date.now();
    if (!Number.isFinite(expiresAtMs) || remaining <= 0 || remaining > 65 * 60_000) {
      throw new CustodyError('bad-output', 'ashlr-custody gh-token returned an implausible expiry');
    }
    const value: CustodyToken = { token, expiresAt: expiresAt as string };
    githubTokens.set(cacheKey, { value, expiresAtMs });
    return value;
  })();
  githubInflight.set(cacheKey, mint);
  try {
    return await mint;
  } finally {
    githubInflight.delete(cacheKey);
  }
}

/** `ashlr-custody claude-token` — only for `claude --restricted` judge / Leader calls. */
export async function claudeToken(): Promise<CustodyToken> {
  if (claudeCache && Date.now() - claudeCache.at < CLAUDE_TOKEN_CACHE_MS) return claudeCache.value;
  const out = await runHelper(['claude-token'], TIMEOUT_MS.quick);
  exactKeys(out, ['token', 'expiresAt'], 'claude-token');
  const token = out['token'];
  if (typeof token !== 'string' || !isOpaqueToken(token) || out['expiresAt'] !== null) {
    throw new CustodyError('bad-output', 'ashlr-custody claude-token returned an unexpected value');
  }
  const value: CustodyToken = { token, expiresAt: null };
  claudeCache = { at: Date.now(), value };
  return value;
}

/** One line of printable, whitespace-free ASCII, 20–4096 chars (the helper applies the same rule). */
function isOpaqueToken(token: string): boolean {
  return token.length >= 20 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token);
}
