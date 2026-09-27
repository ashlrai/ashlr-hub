/**
 * Is the local Devin CLI usable right now? (3.15 follow-up)
 *
 * One cheap, async, briefly cached answer shared by the two places that need
 * it: the seat picker (verse/devin-seats.ts — the "Devin (CLI)" seat's
 * disabled reason) and every turn on a CLI chat (the turns route awaits it,
 * and the engine's synchronous readiness gate reads the last answer), so a
 * chat whose CLI was logged out is refused up front with the fixing command
 * instead of failing inside Devin's own tool.
 *
 * WHAT IT CHECKS, AND HOW. Two `access()` calls — never a sync fs call, never
 * running the CLI:
 *   1. the binary: the first executable of the documented install paths;
 *   2. the login: the CLI's credentials file. `devin auth logout` is
 *      documented as "Log out and remove stored credentials", and
 *      `devin auth status` names that file as where the login lives
 *      (checked on devin 3000.11.3), so its absence is exactly "logged out".
 * Running `devin auth status` would also catch a revoked token, but it makes
 * a network call and prints the account's email — too heavy for a per-turn
 * check. A revoked token still fails the turn with the bridge's own
 * "not logged in" sentence (acp-bridge.ts).
 */
import { access, constants as fsConstants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The fixing command for a logged-out CLI (`devin auth --help` on 3000.11.3: login | logout | status). */
export const DEVIN_CLI_LOGIN_COMMAND = 'devin auth login';
/** The fixing command for a missing CLI (the Homebrew cask the install paths below come from). */
export const DEVIN_CLI_INSTALL_COMMAND = 'brew install --cask devin-cli';

/** The seat picker's short disabled reason. */
export const DEVIN_CLI_LOGIN_HINT = `Log in: \`${DEVIN_CLI_LOGIN_COMMAND}\``;

/** How long an answer is reused by default (the turns route; discovery asks fresh). */
export const DEVIN_CLI_PROBE_TTL_MS = 5_000;
/** How old an answer the synchronous engine gate still trusts (queued turns that bypass the route). */
export const DEVIN_CLI_PROBE_TRUST_MS = 60_000;

export type DevinCliProbeState = 'ready' | 'missing' | 'logged-out';

export interface DevinCliProbe {
  state: DevinCliProbeState;
  /** The executable found, or null when none was. */
  cliPath: string | null;
  /** Why the CLI cannot run a turn, with the command that fixes it; null when ready. */
  reason: string | null;
  checkedAt: number;
}

export interface DevinCliProbeOptions {
  /** Paths to look for the CLI at, first executable wins (tests; default: the install paths). */
  cliCandidates?: readonly string[];
  /** Where the CLI keeps its login (tests). */
  cliCredentialsPath?: string;
  /** Reuse an answer at most this old (ms). 0 = always probe. Default DEVIN_CLI_PROBE_TTL_MS. */
  maxAgeMs?: number;
  now?: () => number;
}

/** Where the documented installers put the binary (brew cask, curl installer). */
export function defaultDevinCliCandidates(home: string = homedir()): string[] {
  return ['/opt/homebrew/bin/devin', '/usr/local/bin/devin', join(home, '.local', 'bin', 'devin')];
}

/** `$XDG_DATA_HOME/devin/credentials.toml`, else `~/.local/share/devin/credentials.toml` (docs.devin.ai/cli/enterprise/devin-auth). */
export function devinCliCredentialsPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env['XDG_DATA_HOME'];
  return join(xdg && xdg.startsWith('/') ? xdg : join(home, '.local', 'share'), 'devin', 'credentials.toml');
}

/** The sentence a refused turn shows. Pure. */
export function devinCliRefusal(state: Exclude<DevinCliProbeState, 'ready'>): string {
  return state === 'missing'
    ? `The Devin CLI is not installed on this Mac. Install it with \`${DEVIN_CLI_INSTALL_COMMAND}\`, run \`${DEVIN_CLI_LOGIN_COMMAND}\`, then send again.`
    : `The Devin CLI is logged out. Run \`${DEVIN_CLI_LOGIN_COMMAND}\` in a terminal, then send again.`;
}

async function accessible(path: string, mode: number): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function runProbe(candidates: readonly string[], credentials: string, now: () => number): Promise<DevinCliProbe> {
  let cliPath: string | null = null;
  for (const candidate of candidates) {
    if (candidate.startsWith('/') && await accessible(candidate, fsConstants.X_OK)) {
      cliPath = candidate;
      break;
    }
  }
  if (!cliPath) return { state: 'missing', cliPath: null, reason: devinCliRefusal('missing'), checkedAt: now() };
  if (!(await accessible(credentials, fsConstants.F_OK))) {
    return { state: 'logged-out', cliPath, reason: devinCliRefusal('logged-out'), checkedAt: now() };
  }
  return { state: 'ready', cliPath, reason: null, checkedAt: now() };
}

let last: { key: string; probe: DevinCliProbe } | null = null;
const inFlight = new Map<string, Promise<DevinCliProbe>>();

/** Probe (or reuse a recent answer). Never throws. */
export async function probeDevinCli(opts: DevinCliProbeOptions = {}): Promise<DevinCliProbe> {
  const now = opts.now ?? Date.now;
  const candidates = opts.cliCandidates ?? defaultDevinCliCandidates();
  const credentials = opts.cliCredentialsPath ?? devinCliCredentialsPath();
  const key = JSON.stringify([candidates, credentials]);
  const maxAge = typeof opts.maxAgeMs === 'number' && opts.maxAgeMs >= 0 ? opts.maxAgeMs : DEVIN_CLI_PROBE_TTL_MS;
  if (maxAge > 0 && last && last.key === key && now() - last.probe.checkedAt <= maxAge) return last.probe;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const started = runProbe(candidates, credentials, now)
    .catch((): DevinCliProbe => ({ state: 'missing', cliPath: null, reason: devinCliRefusal('missing'), checkedAt: now() }))
    .then((probe) => {
      last = { key, probe };
      return probe;
    })
    .finally(() => { inFlight.delete(key); });
  inFlight.set(key, started);
  return started;
}

/**
 * The latest answer if it is at most `maxAgeMs` old, else null (unknown).
 * Synchronous — for the engine's readiness gate. A stale answer also starts a
 * fresh probe in the background (with the options it was made with).
 */
export function peekDevinCliProbe(maxAgeMs: number = DEVIN_CLI_PROBE_TRUST_MS, now: () => number = Date.now): DevinCliProbe | null {
  if (!last) return null;
  const age = now() - last.probe.checkedAt;
  if (age > DEVIN_CLI_PROBE_TTL_MS) {
    const [candidates, credentials] = JSON.parse(last.key) as [string[], string];
    void probeDevinCli({ cliCandidates: candidates, cliCredentialsPath: credentials, maxAgeMs: 0 });
  }
  return age <= maxAgeMs ? last.probe : null;
}

/** Test hook: forget every answer. */
export function resetDevinCliProbeForTest(): void {
  last = null;
  inFlight.clear();
}
