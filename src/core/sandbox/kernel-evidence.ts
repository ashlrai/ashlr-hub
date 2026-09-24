/**
 * Kernel sandbox-denial evidence — V3.10 review finding d0.
 *
 * The rollout's "0 sandbox violations" criterion used to rest on two signals:
 * the engine's own output (sandboxViolationsInOutput) and a SIGKILL of the
 * ENGINE process. The agent under evaluation controls the first (`2>/dev/null`,
 * `|| true`, not echoing tool output) and dodges the second by letting only a
 * CHILD touch a tripwire. The source of truth now is the kernel's own record
 * of the denial, which the agent cannot suppress:
 *
 *   1. Every protected deny rule in the run's SBPL profile carries
 *      `(with message "<tag>")`, a per-run random tag (confine.ts). The kernel
 *      then logs each such denial as a `Sandbox` event whose message ends in
 *      the tag — for the engine AND every descendant, whatever they print.
 *   2. Before the engine starts, `log stream` is started with a predicate on
 *      exactly that tag, writing NDJSON to a private 0700 dir that the
 *      confined run can neither read nor write (it lives outside the run's
 *      writable set, and the temp dirs are read-jailed). Start-up blocks
 *      (bounded) until the stream prints its header, so a denial in the first
 *      millisecond of the run is not missed.
 *   3. After the engine exits, a BARRIER: one extra sandbox-exec denial tagged
 *      `<tag>-end`. Kernel events arrive in order, so seeing the barrier in the
 *      stream proves every earlier denial of this run has been delivered.
 *
 * Measured on macOS 26 (Darwin 25): ready ≈ 85 ms, barrier ≈ 40 ms. A
 * sandbox-exec denial is NOT persisted for `log show` afterwards (only the
 * live stream sees it) — which is why this streams for the run's lifetime
 * rather than querying the log after the fact.
 *
 * Honesty: `complete` only when the stream was ready before the run, the
 * barrier arrived, and the stream reported no dropped messages. Anything else
 * is `unavailable` / `incomplete` — violations UNKNOWN, never "zero".
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const LOG_BINARY = '/usr/bin/log';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Longest the daemon blocks for the stream to come up before the run starts. */
export const STREAM_READY_TIMEOUT_MS = 3_000;
/** Longest it waits for the end barrier after the run. */
export const BARRIER_TIMEOUT_MS = 3_000;
const POLL_MS = 10;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

const TAG_RE = /^ashlr-sbx-[0-9a-f]{32}$/;

/** A fresh, unguessable per-run tag (hex only: safe inside SBPL strings and log predicates). */
export function newViolationTag(): string {
  return `ashlr-sbx-${randomBytes(16).toString('hex')}`;
}

export function isViolationTag(value: unknown): value is string {
  return typeof value === 'string' && TAG_RE.test(value);
}

export interface KernelDenial {
  /** Process name as the kernel reported it (`cat`, `bash`, `node`). */
  process: string;
  pid: number | null;
  /** SBPL operation, e.g. `file-read-data`, `process-exec*`, `mach-lookup`. */
  operation: string;
  /** Path / service name; '' when the event names none. */
  target: string;
}

export interface KernelEvidence {
  source: 'kernel-log';
  /**
   * complete    — every tagged denial of the run was observed (possibly none).
   * incomplete  — the stream ran, but the barrier never arrived or messages were dropped.
   * unavailable — no stream (not macOS, no `log`, not permitted, never ready, disabled).
   */
  state: 'complete' | 'incomplete' | 'unavailable';
  /** Why it is not complete; null when complete. Plain sentence, no paths. */
  reason: string | null;
  denials: KernelDenial[];
}

export interface SandboxDenialWatch {
  readonly tag: string;
  /** Stop the stream (after the barrier) and return what the kernel reported. Idempotent; never throws. */
  finish(): KernelEvidence;
  /** Stop without collecting (a run that never started). Idempotent. */
  abort(): void;
}

/** Injection seam: the process pieces, so tests never start a real `log stream`. */
export interface KernelEvidenceDeps {
  platform: NodeJS.Platform;
  startStream(predicate: string, outFd: number): ChildProcess | { kill(signal?: NodeJS.Signals): boolean; unref?(): void };
  /** Trigger the end barrier: a sandboxed read of `markerPath` denied with message `message`. */
  barrier(markerPath: string, message: string): void;
  sleepSync(ms: number): void;
  nowMs(): number;
}

function sleepSyncDefault(ms: number): void {
  // Blocks only this thread; the stream writes to a FILE, so no event-loop
  // turn is needed to observe its progress.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export const defaultKernelEvidenceDeps: KernelEvidenceDeps = {
  platform: process.platform,
  startStream: (predicate, outFd) => {
    const child = spawn(LOG_BINARY, ['stream', '--style', 'ndjson', '--predicate', predicate], {
      stdio: ['ignore', outFd, outFd],
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
    child.on('error', () => { /* surfaces as "never ready" */ });
    child.unref();
    return child;
  },
  barrier: (markerPath, message) => {
    spawnSync(SANDBOX_EXEC, [
      '-p',
      `(version 1)(allow default)(deny file-read* (with message "${message}") (literal "${markerPath.replace(/["\\]/g, '')}"))`,
      '/bin/cat',
      markerPath,
    ], { stdio: 'ignore', timeout: 5_000, env: { PATH: '/usr/bin:/bin' } });
  },
  sleepSync: sleepSyncDefault,
  nowMs: () => Date.now(),
};

function readCapped(path: string): string {
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > MAX_EVIDENCE_BYTES ? text.slice(0, MAX_EVIDENCE_BYTES) : text;
  } catch {
    return '';
  }
}

const DENIAL_RE = /Sandbox:\s+(.+?)\((\d+)\)\s+deny\(\d+\)\s+(\S+)\s*([^\n]*)/;

/** PURE: the tagged denials in a `log stream --style ndjson` capture. */
export function parseKernelDenials(capture: string, tag: string): { denials: KernelDenial[]; barrier: boolean; dropped: boolean } {
  const denials: KernelDenial[] = [];
  let barrier = false;
  let dropped = false;
  const endMarker = `${tag}-end`;
  for (const raw of capture.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('{')) {
      if (/dropped/i.test(line)) dropped = true;
      continue;
    }
    let message: unknown;
    try {
      message = (JSON.parse(line) as { eventMessage?: unknown }).eventMessage;
    } catch {
      continue;
    }
    if (typeof message !== 'string' || !message.includes(tag)) continue;
    if (message.includes(endMarker)) {
      barrier = true;
      continue;
    }
    const match = DENIAL_RE.exec(message);
    if (!match) continue;
    const target = (match[4] ?? '').trim();
    denials.push({
      process: match[1]!.slice(0, 64),
      pid: Number.isSafeInteger(Number(match[2])) ? Number(match[2]) : null,
      operation: match[3]!.slice(0, 64),
      // The tag rides on the next line of the same event; never part of the target.
      target: target.includes(tag) ? '' : target.slice(0, 512),
    });
  }
  return { denials, barrier, dropped };
}

const unavailable = (reason: string): KernelEvidence => ({ source: 'kernel-log', state: 'unavailable', reason, denials: [] });

/**
 * Start watching the kernel for this run's tagged denials. Blocks (≤
 * STREAM_READY_TIMEOUT_MS) until the stream is live. Never throws: a watch
 * that could not start returns `unavailable` from finish().
 */
export function startSandboxDenialWatch(
  tag: string,
  options: { parent?: string; deps?: KernelEvidenceDeps } = {},
): SandboxDenialWatch {
  const deps = options.deps ?? defaultKernelEvidenceDeps;
  let done: KernelEvidence | null = null;
  const inert = (reason: string): SandboxDenialWatch => ({
    tag,
    finish: () => (done ??= unavailable(reason)),
    abort: () => { done ??= unavailable(reason); },
  });
  if (!isViolationTag(tag)) return inert('the run has no valid violation tag');
  if (deps.platform !== 'darwin') return inert(`no kernel sandbox log on ${deps.platform}`);

  let dir: string;
  try {
    dir = realpathSync(mkdtempSync(join(realpathSync(options.parent ?? tmpdir()), 'ashlr-sbxlog-')));
  } catch {
    return inert('the private evidence directory could not be created');
  }
  const capture = join(dir, 'stream.ndjson');
  const cleanup = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
  let stream: ReturnType<KernelEvidenceDeps['startStream']> | null = null;
  try {
    const fd = openSync(capture, 'wx', 0o600);
    try {
      stream = deps.startStream(`sender == "Sandbox" AND eventMessage CONTAINS "${tag}"`, fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    cleanup();
    return inert('`log stream` could not be started');
  }
  const stop = (): void => {
    try { stream?.kill('SIGTERM'); } catch { /* already gone */ }
    stream = null;
  };

  // Ready = the stream printed its "Filtering the log data…" header.
  const readyBy = deps.nowMs() + STREAM_READY_TIMEOUT_MS;
  let ready = false;
  for (;;) {
    if (/Filtering the log data/.test(readCapped(capture))) { ready = true; break; }
    if (deps.nowMs() >= readyBy) break;
    deps.sleepSync(POLL_MS);
  }
  if (!ready) {
    const head = readCapped(capture).slice(0, 200);
    stop();
    cleanup();
    // e.g. "log: Must be admin to run 'stream' command" on a standard account.
    return inert(/admin|permission|not permitted/i.test(head)
      ? 'the kernel log stream is not permitted for this user'
      : 'the kernel log stream did not start in time');
  }

  return {
    tag,
    finish(): KernelEvidence {
      if (done) return done;
      try {
        const marker = join(dir, 'barrier');
        try {
          writeFileSync(marker, 'b\n', { mode: 0o600 });
          deps.barrier(marker, `${tag}-end`);
        } catch { /* no barrier ⇒ incomplete below */ }
        const until = deps.nowMs() + BARRIER_TIMEOUT_MS;
        let parsed = parseKernelDenials(readCapped(capture), tag);
        while (!parsed.barrier && deps.nowMs() < until) {
          deps.sleepSync(POLL_MS);
          parsed = parseKernelDenials(readCapped(capture), tag);
        }
        const reason = !parsed.barrier
          ? 'the end-of-run barrier never reached the kernel log stream'
          : parsed.dropped ? 'the kernel log stream dropped messages during the run' : null;
        done = { source: 'kernel-log', state: reason ? 'incomplete' : 'complete', reason, denials: parsed.denials };
      } catch {
        done = { source: 'kernel-log', state: 'incomplete', reason: 'the kernel evidence could not be read', denials: [] };
      } finally {
        stop();
        cleanup();
      }
      return done;
    },
    abort(): void {
      if (done) return;
      done = unavailable('the run was aborted before it started');
      stop();
      cleanup();
    },
  };
}
