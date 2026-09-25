/**
 * PTY-wrapped `claude --cloud` launcher (unit C1). New cloud sessions can
 * only be created by the interactive CLI, so the seat launcher runs under a
 * pseudo-terminal: macOS `script -q /dev/null <argv…>`, Linux
 * `script -qec "<quoted argv>" /dev/null`. Output is ANSI-stripped and
 * parsed. The seat launcher argv comes from the seat's native profile
 * (`~/.ashlr/native-profiles/<seat>/command.json`, an argv array) — never a
 * shell string, never the ambient `claude` (it may be API-key authed).
 *
 * Environment: the child gets only what the native-profile launcher itself
 * keeps (PATH, HOME, TMPDIR, LANG, LC_ALL) plus the terminal variables the
 * PTY needs. The launcher strips everything else again before exec'ing the
 * pinned CLI — an inherited ANTHROPIC_API_KEY would turn a claude.ai seat
 * into an API-key one, which cloud sessions refuse.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { readPrivateFileCapped } from '../verse/preferences.js';
import { ashlrHome } from './store.js';
import { CLOUD_LAUNCH_TIMEOUT_MS, CLOUD_SEAT_ID, type CloudLaunchFailureCode } from './types.js';

export type CloudLaunchResult =
  | { ok: true; sessionId: string; url: string; title: string }
  | { ok: false; failure: CloudLaunchFailureCode; message: string };

export interface CloudLaunchDeps {
  /** Seat launcher argv (default: read the claude-a native profile command.json). */
  seatArgv?: () => string[] | null;
  /** Spawn override for tests: returns combined output + exit code. */
  run?: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ output: string; code: number | null; timedOut: boolean }>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export const SEAT_NOT_READY_REASON = "The Claude seat isn't set up on this Mac.";

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_ARGV = 32;
/** The CLI prints three lines on success; anything this large is a runaway TUI. */
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DETAIL_CHARS = 300;

// ---------------------------------------------------------------------------
// Seat argv
// ---------------------------------------------------------------------------

export function cloudSeatCommandPath(seat: string = CLOUD_SEAT_ID): string {
  return join(ashlrHome(), 'native-profiles', seat, 'command.json');
}

/**
 * The seat's launcher argv from its native profile's command.json, or null
 * when it is missing, unreadable, or not a non-empty array of non-empty
 * strings. Reads a file only — never runs anything.
 */
export function readCloudSeatArgv(seat: string = CLOUD_SEAT_ID): string[] | null {
  const file = readPrivateFileCapped(cloudSeatCommandPath(seat), MAX_COMMAND_BYTES);
  if (!file || file.truncated) return null;
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGV) return null;
  if (!value.every((arg) => typeof arg === 'string' && arg !== '' && !arg.includes('\0'))) return null;
  return value as string[];
}

// ---------------------------------------------------------------------------
// PTY wrapping
// ---------------------------------------------------------------------------

/** POSIX single-quote one word: `it's` → `'it'\''s'`. Safe for any byte but NUL. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The argv that runs `<seat argv…> --cloud <prompt>` under a pseudo-terminal,
 * or null on a platform with no known `script(1)` form.
 *
 * macOS (BSD script) takes the command as argv, so the prompt stays ONE argv
 * element and never meets a shell. util-linux script only takes a command
 * string (`-c`), so there each word is single-quoted; `-e` returns the
 * child's exit code instead of script's own.
 */
export function cloudPtyArgv(seatArgv: readonly string[], prompt: string, platform: NodeJS.Platform): string[] | null {
  // A prompt starting with "-" would be read as another option by the CLI's
  // argument parser; a leading space is invisible to the model.
  const safePrompt = prompt.startsWith('-') ? ` ${prompt}` : prompt;
  const command = [...seatArgv, '--cloud', safePrompt];
  if (platform === 'darwin') return ['/usr/bin/script', '-q', '/dev/null', ...command];
  if (platform === 'linux') return ['script', '-qec', command.map(shellQuote).join(' '), '/dev/null'];
  return null;
}

/** The environment the PTY wrapper runs with — the native launcher's keep-list plus terminal basics. */
export function cloudLaunchEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  // util-linux script runs its -c string through $SHELL; pin a POSIX shell so
  // the quoting above means what it says whatever the operator's login shell is.
  env['SHELL'] = '/bin/sh';
  env['TERM'] = 'xterm-256color';
  return env;
}

/** Production runner: own process group (a timeout kills the CLI and its children), bounded output. */
function defaultRun(argv: string[], opts: { cwd: string; timeoutMs: number }): Promise<{ output: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* already closed */ }
      resolve({ output: Buffer.concat(chunks).toString('utf8'), code, timedOut });
    };
    const killGroup = (): void => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    };
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: cloudLaunchEnv(),
        // stdin stays open (never written) so script(1) does not forward an
        // EOF to the CLI before it has printed the session.
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
    } catch {
      resolve({ output: '', code: null, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      finish(null);
    }, opts.timeoutMs);
    const collect = (chunk: Buffer): void => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - bytes));
      bytes += chunk.length;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.stdin?.on('error', () => { /* EPIPE after exit */ });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Terminal control sequences: OSC (`ESC ]` … BEL / ST — hyperlinks, titles),
 * CSI (`ESC [` … final byte — colour, cursor), 8-bit CSI, and the remaining
 * escapes (`ESC 7` cursor save, `ESC ( B` charset: intermediates + final).
 * OSC first, so a hyperlink's URL payload goes with it.
 */
/* eslint-disable no-control-regex -- matching terminal control bytes is the point */
const OSC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g;
const CSI_RE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_RE = /\u001b[ -/]*[0-~]/g;
/* eslint-enable no-control-regex */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripTerminalSequences(raw: string): string {
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(ESC_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, '');
}

const SESSION_ID = String.raw`session_[A-Za-z0-9_-]+`;
const CREATED_RE = /Created cloud session:[ \t]*([^\n]*)/;
const VIEW_RE = new RegExp(String.raw`View:[ \t]*(https://claude\.ai/code/(${SESSION_ID})[^\s]*)`);
const TELEPORT_RE = new RegExp(String.raw`--teleport[ \t]+(${SESSION_ID})`);

const FAILURE_MESSAGES: Record<Exclude<CloudLaunchFailureCode, 'unparsed' | 'unknown' | 'budget' | 'checkout-failed' | 'seat-unavailable' | 'timeout'>, string> = {
  'auth': "The Claude seat isn't signed in with a Claude.ai account, so it can't start cloud sessions. Sign it in again and retry.",
  'not-enabled': "Claude Code cloud sessions aren't enabled for this Claude account.",
  'rate-limited': 'Claude refused the cloud session: the account is out of credits or hit a usage limit.',
  'no-remote': "Claude couldn't start the session from this checkout: it needs a GitHub origin with the branch pushed.",
};

/** Error text → failure code, most specific first (the auth message also says "API key … not sufficient"). */
function classifyFailure(text: string): keyof typeof FAILURE_MESSAGES | null {
  const lower = text.toLowerCase();
  if (lower.includes('requires authentication with a claude.ai account') || lower.includes('require authentication with a claude.ai account')) return 'auth';
  if (lower.includes('not enabled')) return 'not-enabled';
  if (lower.includes('rate limit') || lower.includes('usage limit') || lower.includes('out of credits')) return 'rate-limited';
  if (lower.includes('not a git repository') || lower.includes('no remote') || /\bpush/.test(lower)) return 'no-remote';
  return null;
}

/** One line of the CLI's own words for an unclassified failure, with machine paths removed. */
function detailLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const line = lines.find((l) => /error|failed|fatal|cannot|can't|unable/i.test(l)) ?? lines[lines.length - 1] ?? '';
  const scrubbed = line.replace(/(?:~|\/)[^\s'"`]*\/[^\s'"`]*/g, '…');
  return scrubbed.length > MAX_DETAIL_CHARS ? `${scrubbed.slice(0, MAX_DETAIL_CHARS - 1).trimEnd()}…` : scrubbed;
}

/** Pure: ANSI-strip + find "Created cloud session: <title>" / "View: <url>" / session id, or classify the error text. */
export function parseCloudLaunchOutput(raw: string): CloudLaunchResult {
  const text = stripTerminalSequences(typeof raw === 'string' ? raw : '');
  const created = CREATED_RE.exec(text);
  const view = VIEW_RE.exec(text);
  const teleport = TELEPORT_RE.exec(text);
  const sessionId = view?.[2] ?? teleport?.[1] ?? null;
  if (created && sessionId) {
    return {
      ok: true,
      sessionId,
      // The printed URL carries `?from=cli&m=0`; keep it — it is the link Claude itself offers.
      url: view?.[1] ?? `https://claude.ai/code/${sessionId}`,
      title: (created[1] ?? '').trim().slice(0, 200),
    };
  }
  const failure = classifyFailure(text);
  if (failure) return { ok: false, failure, message: FAILURE_MESSAGES[failure] };
  const detail = detailLine(text);
  if (detail === '') return { ok: false, failure: 'unknown', message: 'Claude Code exited without saying anything, so no cloud session was created.' };
  if (/error|failed|fatal/i.test(detail)) {
    return { ok: false, failure: 'unknown', message: `Claude Code couldn't create the cloud session. It said: ${detail}` };
  }
  return { ok: false, failure: 'unparsed', message: `Claude Code finished but printed no cloud session. Last line: ${detail}` };
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export async function launchCloudSession(opts: { cwd: string; prompt: string }, deps: CloudLaunchDeps = {}): Promise<CloudLaunchResult> {
  if (typeof opts.prompt !== 'string' || opts.prompt.trim() === '') {
    return { ok: false, failure: 'unknown', message: 'There was no task text to launch.' };
  }
  const seatArgv = (deps.seatArgv ?? readCloudSeatArgv)();
  if (!seatArgv || seatArgv.length === 0) return { ok: false, failure: 'seat-unavailable', message: SEAT_NOT_READY_REASON };
  const argv = cloudPtyArgv(seatArgv, opts.prompt, deps.platform ?? process.platform);
  if (!argv) return { ok: false, failure: 'unknown', message: 'Cloud sessions can only be launched on macOS or Linux.' };
  const timeoutMs = deps.timeoutMs ?? CLOUD_LAUNCH_TIMEOUT_MS;
  let result: { output: string; code: number | null; timedOut: boolean };
  try {
    result = await (deps.run ?? defaultRun)(argv, { cwd: opts.cwd, timeoutMs });
  } catch {
    return { ok: false, failure: 'unknown', message: "The Claude seat couldn't be started." };
  }
  const parsed = parseCloudLaunchOutput(result.output);
  // A session that was printed counts even if the CLI then hung or exited
  // non-zero: it exists and is running on the account's credits.
  if (parsed.ok) return parsed;
  if (result.timedOut && (parsed.failure === 'unparsed' || parsed.failure === 'unknown')) {
    return { ok: false, failure: 'timeout', message: `Claude Code didn't create a cloud session within ${Math.round(timeoutMs / 1000)} seconds, so it was stopped.` };
  }
  return parsed;
}
