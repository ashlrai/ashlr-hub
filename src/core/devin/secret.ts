/**
 * Where the Devin API key lives (3.15): the macOS login Keychain, and nowhere
 * else Verse writes.
 *
 * WHY NOT CUSTODY: the custody helper (/usr/local/libexec/ashlr-custody,
 * tools/custody) stores exactly two fixed secrets — the GitHub App key and the
 * Claude token — with no generic-secret command. Adding `store-devin-key`
 * means a Swift change and a root-installed helper rebuild, which is Mason's
 * to do; until then the key goes to the Keychain under the same rules custody
 * follows:
 *
 *   - one dedicated item: service `ai.ashlr.devin`, account `api-key`;
 *   - the secret travels on STDIN only (`security -i`), never in argv, so it
 *     never shows in `ps` or a process audit;
 *   - the item trusts only /usr/bin/security (no `-A`); confined fleet agents
 *     are denied /usr/bin/security outright (sandbox/confine.ts), so they can
 *     never read it;
 *   - reads are bounded and non-interactive from our side (stdin closed, a
 *     timeout) — a Keychain that wants a prompt reads as "not connected"
 *     instead of hanging a request;
 *   - the key is never cached on disk, never written to config, never logged;
 *     errors are fixed sentences.
 *
 * The runner is injectable so tests never touch the real Keychain.
 */
import { spawn } from 'node:child_process';

import { DEVIN_KEY_PATTERN } from './types.js';

export const DEVIN_KEYCHAIN_SERVICE = 'ai.ashlr.devin' as const;
export const DEVIN_KEYCHAIN_ACCOUNT = 'api-key' as const;
export const SECURITY_BIN = '/usr/bin/security' as const;
const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 16 * 1024;

export type SecurityRunner = (args: string[], stdin: string | null) => Promise<{ code: number | null; stdout: string; timedOut: boolean }>;

export interface DevinKeyStoreDeps {
  run?: SecurityRunner;
  platform?: NodeJS.Platform;
}

export class DevinKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DevinKeyError';
  }
}

/** Production runner: argv only (never a shell), empty environment beyond PATH/HOME, bounded. */
export const defaultSecurityRunner: SecurityRunner = (args, stdin) => new Promise((resolve) => {
  let child: ReturnType<typeof spawn>;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  let timedOut = false;
  const finish = (code: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ code, stdout: Buffer.concat(chunks).toString('utf8'), timedOut });
  };
  try {
    child = spawn(SECURITY_BIN, args, {
      env: { PATH: '/usr/bin:/bin', HOME: process.env['HOME'] ?? '' },
      stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'ignore'],
    });
  } catch {
    resolve({ code: null, stdout: '', timedOut: false });
    return;
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    finish(null);
  }, TIMEOUT_MS);
  timer.unref?.();
  child.stdout?.on('data', (chunk: Buffer) => {
    if (bytes >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - bytes));
    bytes += chunk.length;
  });
  child.on('error', () => finish(null));
  child.on('close', (code) => finish(code));
  if (stdin !== null) {
    child.stdin?.on('error', () => { /* EPIPE after exit */ });
    child.stdin?.end(stdin);
  }
});

function supported(deps: DevinKeyStoreDeps): boolean {
  return (deps.platform ?? process.platform) === 'darwin';
}

/** True when the key is well formed: `cog_` + the documented charset. */
export function isDevinApiKey(value: unknown): value is string {
  return typeof value === 'string' && DEVIN_KEY_PATTERN.test(value);
}

/**
 * Store (or replace) the key. The key is validated BEFORE it goes anywhere,
 * and its charset (`[A-Za-z0-9_-]`) needs no quoting in `security -i`'s
 * command line — nothing in it can end the argument or start another.
 */
export async function storeDevinKey(key: string, deps: DevinKeyStoreDeps = {}): Promise<void> {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!isDevinApiKey(trimmed)) {
    throw new DevinKeyError('That does not look like a Devin API key. v3 keys start with cog_ (legacy apk_ keys do not work with the current API).');
  }
  if (!supported(deps)) throw new DevinKeyError('Storing the Devin key needs the macOS Keychain; this machine is not macOS.');
  const command = [
    'add-generic-password', '-U',
    '-s', DEVIN_KEYCHAIN_SERVICE,
    '-a', DEVIN_KEYCHAIN_ACCOUNT,
    '-l', 'ashlr-verse-devin-api-key',
    '-T', SECURITY_BIN,
    '-w', trimmed,
  ].join(' ');
  const result = await (deps.run ?? defaultSecurityRunner)(['-i'], `${command}\n`);
  if (result.timedOut || result.code !== 0) throw new DevinKeyError('The Keychain did not accept the Devin key.');
  // Read it back: an interactive-mode error does not always change the exit code.
  const stored = await readDevinKey(deps);
  if (stored !== trimmed) throw new DevinKeyError('The Keychain did not keep the Devin key.');
}

/** The key, or null when absent / unreadable / not macOS. Never throws. */
export async function readDevinKey(deps: DevinKeyStoreDeps = {}): Promise<string | null> {
  if (!supported(deps)) return null;
  try {
    const result = await (deps.run ?? defaultSecurityRunner)(
      ['find-generic-password', '-s', DEVIN_KEYCHAIN_SERVICE, '-a', DEVIN_KEYCHAIN_ACCOUNT, '-w'],
      null,
    );
    if (result.timedOut || result.code !== 0) return null;
    const key = result.stdout.trim();
    return isDevinApiKey(key) ? key : null;
  } catch {
    return null;
  }
}

/** Whether an item exists — reads attributes only, never the secret. Never throws. */
export async function hasDevinKey(deps: DevinKeyStoreDeps = {}): Promise<boolean> {
  if (!supported(deps)) return false;
  try {
    const result = await (deps.run ?? defaultSecurityRunner)(
      ['find-generic-password', '-s', DEVIN_KEYCHAIN_SERVICE, '-a', DEVIN_KEYCHAIN_ACCOUNT],
      null,
    );
    return !result.timedOut && result.code === 0;
  } catch {
    return false;
  }
}

/** Remove the key (idempotent). Never throws. */
export async function removeDevinKey(deps: DevinKeyStoreDeps = {}): Promise<boolean> {
  if (!supported(deps)) return false;
  try {
    const result = await (deps.run ?? defaultSecurityRunner)(
      ['delete-generic-password', '-s', DEVIN_KEYCHAIN_SERVICE, '-a', DEVIN_KEYCHAIN_ACCOUNT],
      null,
    );
    return !result.timedOut && result.code === 0;
  } catch {
    return false;
  }
}
