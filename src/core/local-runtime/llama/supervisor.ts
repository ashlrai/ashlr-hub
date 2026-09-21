/**
 * The supervisor: start, stop, restart and inspect the local serving runtime.
 *
 * The lifecycle is deliberately boring and idempotent. `start` on a healthy
 * runtime is a no-op that tells you so; `stop` with nothing running is a
 * success, not an error; a crashed runtime leaves a record the next `start`
 * can reclaim, and a record that no longer describes a live process of ours is
 * discarded rather than acted on.
 *
 * Nothing here consults `~/.ashlr/KILL`, creates it, or removes it. The
 * switch governs standing autonomous authority — the launch agent — and that
 * check lives at the CLI boundary where refusals are explained to a person.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, openSync, closeSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  DEFAULT_LLAMA_HOST,
  buildLlamaServerArgs,
  isLoopbackHost,
  originFor,
  resolveLlamaRuntimeConfig,
} from './config.js';
import { probeLlamaRuntime } from './health.js';
import { bootoutLaunchAgent, launchAgentLoaded } from './launchd.js';
import { resolveOllamaModelBlob, resolveOllamaRefForBlobPath } from './ollama-blob.js';
import { logsDir, stderrLogPath, stdoutLogPath } from './paths.js';
import {
  findLlamaServersOnPort,
  livenessFactsFor,
  processAlive,
  shouldReclaim,
  sleep,
  terminateTree,
} from './process.js';
import { clearOwnershipRecord, readOwnershipRecord, writeOwnershipRecord } from './record.js';
import type { AshlrConfig } from '../../types.js';
import type {
  LlamaLifecycleResult,
  LlamaOwnershipRecord,
  LlamaRuntimeConfig,
  LlamaRuntimeSnapshot,
} from './types.js';

/**
 * How long `start` waits for `/health` to say ok.
 *
 * A 27 GB Q8 blob that is not in the page cache takes minutes to map. A short
 * deadline here would report failure for a runtime that was about to work,
 * and the operator would then kill it and try again — the worst outcome.
 */
export const DEFAULT_START_TIMEOUT_MS = 300_000;

/** Poll interval while waiting for health. */
const HEALTH_POLL_MS = 500;

/** Bytes of stderr shown when a launch fails. Enough to see the real reason. */
const STDERR_TAIL_BYTES = 4_000;

/** Options shared by the lifecycle commands. */
export interface LifecycleOptions {
  cfg?: AshlrConfig;
  /** Override the resolved runtime config (port, slots, model...). */
  runtime?: Partial<LlamaRuntimeConfig>;
  /** Deadline for `start` to see a healthy `/health`. */
  timeoutMs?: number;
  /** Terminate a llama-server on our port that we have no record for. */
  force?: boolean;
}

/**
 * Merge an override over the resolved configuration.
 *
 * The bind host is re-gated AFTER the merge, not before: an override object is
 * an ordinary function argument, and letting one carry `host: '0.0.0.0'` past
 * the resolver's loopback rule would reopen the hole that rule exists to close
 * (llama-server has no authentication, and `install` freezes this argv into a
 * KeepAlive launchd job). The persisted `models.llamaServer.allowNonLoopback`
 * opt-in remains the only way out of loopback.
 */
function effectiveRuntime(options: LifecycleOptions): LlamaRuntimeConfig {
  const base = resolveLlamaRuntimeConfig(options.cfg);
  const merged = { ...base, ...(options.runtime ?? {}) };
  const allowNonLoopback = base.hostDowngradedFrom === null && !isLoopbackHost(base.host);
  if (isLoopbackHost(merged.host) || allowNonLoopback) {
    return { ...merged, hostDowngradedFrom: base.hostDowngradedFrom };
  }
  return { ...merged, host: DEFAULT_LLAMA_HOST, hostDowngradedFrom: merged.host };
}

/**
 * One sentence appended to a lifecycle detail when the bind host was refused.
 * Empty when nothing was downgraded, so the happy path reads unchanged.
 */
function hostDowngradeNote(runtime: LlamaRuntimeConfig): string {
  if (runtime.hostDowngradedFrom === null) return '';
  return (
    ` — NOTE: the requested bind host '${runtime.hostDowngradedFrom}' is not loopback and was` +
    ` refused; llama-server has no authentication, so it is bound to ${runtime.host} instead.` +
    ` Set models.llamaServer.allowNonLoopback=true in your config if you genuinely want it on` +
    ' the network.'
  );
}

/** Probe a specific host/port pair rather than the globally-resolved one. */
async function snapshotFor(
  runtime: LlamaRuntimeConfig,
  record?: LlamaOwnershipRecord | null,
): Promise<LlamaRuntimeSnapshot> {
  const origin = originFor(runtime.host, runtime.port);
  return probeLlamaRuntime({ origin, baseUrl: `${origin}/v1`, record });
}

/** Read the current state without changing anything. Never throws. */
export async function statusLocalRuntime(
  options: LifecycleOptions = {},
): Promise<LlamaRuntimeSnapshot> {
  return snapshotFor(effectiveRuntime(options));
}

/**
 * Can we bind this port right now?
 *
 * A dead process is not the same as a released port: a socket in TIME_WAIT, or
 * a descendant still holding the listener, both keep the port busy while the
 * pid we killed is gone. `stop` reports the port free only when this says so.
 */
export function isPortFree(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // Already closed.
      }
      resolve(free);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    server.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    server.listen({ host, port, exclusive: true }, () => {
      clearTimeout(timer);
      finish(true);
    });
  });
}

/** Last few KB of the stderr log, so a launch failure explains itself. */
function stderrTail(path = stderrLogPath()): string {
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - STDERR_TAIL_BYTES);
    const text = readFileSync(path, 'utf8');
    return text.slice(start).trim();
  } catch {
    return '';
  }
}

/** Resolve the GGUF to serve: an explicit path wins, else Ollama's store. */
function resolveModelPath(runtime: LlamaRuntimeConfig): { path: string } | { error: string } {
  if (runtime.modelPath) {
    try {
      if (statSync(runtime.modelPath).isFile()) return { path: runtime.modelPath };
      return { error: `configured modelPath is not a file: ${runtime.modelPath}` };
    } catch {
      return { error: `configured modelPath does not exist: ${runtime.modelPath}` };
    }
  }
  const resolved = resolveOllamaModelBlob(runtime.modelRef);
  if (!resolved.ok) return { error: resolved.reason };
  return { path: resolved.blobPath };
}

/**
 * Deal with a record left over from a previous run.
 *
 * Three outcomes, and only one of them kills anything:
 *   * no record, or a record for a different port  -> nothing to do;
 *   * the record's process is gone or is no longer ours -> the record is
 *     worthless, so it is discarded (a recycled pid must never become a kill);
 *   * the record names a live llama-server of ours on this port -> it is an
 *     orphan of a crashed supervisor, and it is terminated so the port frees.
 */
async function reclaimOrphan(port: number): Promise<'none' | 'cleared' | 'killed'> {
  const record = readOwnershipRecord();
  if (record === null) return 'none';
  if (record.port !== port) return 'none';

  const facts = livenessFactsFor(record);
  if (shouldReclaim(record, port, facts)) {
    await terminateTree(record.pid);
    clearOwnershipRecord();
    return 'killed';
  }

  clearOwnershipRecord();
  return 'cleared';
}

/**
 * Adopt a llama-server someone else started on our port.
 *
 * Refusing to manage a runtime that is already serving correctly would be
 * pedantic — and would leave the operator with a port they cannot free through
 * this tool. Adoption still requires proof: the process table must show
 * exactly one llama-server bound to this port, and `/health` must be ok.
 * Ambiguity (two matches) is reported rather than guessed at.
 */
function adoptRunning(
  runtime: LlamaRuntimeConfig,
  snapshot: LlamaRuntimeSnapshot,
): LlamaOwnershipRecord | null {
  const candidates = findLlamaServersOnPort(runtime.port);
  if (candidates.length !== 1) return null;
  const found = candidates[0] as (typeof candidates)[number];
  const modelPath = found.modelPath ?? snapshot.model;
  if (!modelPath) return null;

  return {
    schemaVersion: 1,
    pid: found.pid,
    port: runtime.port,
    host: runtime.host,
    binPath: found.binPath,
    modelPath,
    // Recover the reference from the blob digest. An adopted runtime was
    // started by hand, so nobody told us which model it serves — and without
    // this the only name available downstream is `sha256-2bb22714…`, which
    // every honest surface then has to drop and render as "unknown". The
    // manifest tree knows the answer; it is a read-only scan of a handful of
    // small files, and null when the digest matches nothing.
    modelRef: resolveOllamaRefForBlobPath(modelPath),
    args: found.argv.split(/\s+/).slice(1),
    requestedSlots: snapshot.slots.configured ?? 0,
    requestedContext: snapshot.contextTotal ?? 0,
    startedAt: new Date().toISOString(),
    owner: 'adopted',
  };
}

/**
 * Start (or adopt) the serving runtime.
 *
 * Returns a result rather than throwing for every expected outcome: already
 * running, adopted, refused for a missing binary, failed to become healthy.
 * Only a genuine programming error escapes.
 */
export async function startLocalRuntime(
  options: LifecycleOptions = {},
): Promise<LlamaLifecycleResult> {
  const runtime = effectiveRuntime(options);
  const logs = { stdout: stdoutLogPath(), stderr: stderrLogPath() };

  const existing = await snapshotFor(runtime);
  if (existing.state === 'up') {
    if (existing.managed) {
      return {
        ok: true,
        action: 'already-running',
        detail:
          `llama-server is already serving on ${existing.origin} ` +
          `(pid ${existing.pid ?? '?'}, ${existing.slots.configured ?? '?'} slots)`,
        snapshot: existing,
        logs,
      };
    }
    const adopted = adoptRunning(runtime, existing);
    if (adopted === null) {
      return {
        ok: true,
        action: 'already-running',
        detail:
          `a healthy llama-server is on ${existing.origin} but its process could not be ` +
          'identified unambiguously, so it was left unmanaged — `stop --force` can still free the port',
        snapshot: existing,
        logs,
      };
    }
    writeOwnershipRecord(adopted);
    const after = await snapshotFor(runtime, adopted);
    return {
      ok: true,
      action: 'adopted',
      detail:
        `adopted the llama-server already running on ${after.origin} ` +
        `(pid ${adopted.pid}, ${after.slots.configured ?? '?'} slots) — it is now managed`,
      snapshot: after,
      logs,
    };
  }

  if (runtime.binPath === null) {
    return {
      ok: false,
      action: 'refused',
      detail:
        'llama-server is not on PATH. Install llama.cpp (`brew install llama.cpp`) or set ' +
        'LLAMA_SERVER_BIN / models.llamaServer.bin to its absolute path.',
      snapshot: existing,
      logs,
    };
  }

  const model = resolveModelPath(runtime);
  if ('error' in model) {
    return { ok: false, action: 'refused', detail: model.error, snapshot: existing, logs };
  }

  await reclaimOrphan(runtime.port);

  if (!(await isPortFree(runtime.host, runtime.port))) {
    return {
      ok: false,
      action: 'refused',
      detail:
        `${runtime.host}:${runtime.port} is occupied by something that is not a healthy ` +
        'llama-server. Free it, or choose another port with --port.',
      snapshot: existing,
      logs,
    };
  }

  const args = buildLlamaServerArgs(runtime, model.path);

  let outFd: number;
  let errFd: number;
  try {
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    outFd = openSync(logs.stdout, 'a', 0o600);
    errFd = openSync(logs.stderr, 'a', 0o600);
  } catch (err: unknown) {
    return {
      ok: false,
      action: 'failed',
      detail: `could not open the runtime logs: ${err instanceof Error ? err.message : String(err)}`,
      snapshot: existing,
      logs,
    };
  }

  let pid: number | undefined;
  try {
    const child = spawn(runtime.binPath, args, {
      // Detached + unref: the runtime must outlive the CLI invocation that
      // started it. That is the whole difference between a service and a
      // process that dies with its terminal.
      detached: true,
      stdio: ['ignore', outFd, errFd],
      cwd: homedir(),
    });
    child.unref();
    pid = child.pid;
  } catch (err: unknown) {
    return {
      ok: false,
      action: 'failed',
      detail: `could not spawn llama-server: ${err instanceof Error ? err.message : String(err)}`,
      snapshot: existing,
      logs,
    };
  } finally {
    try {
      closeSync(outFd);
      closeSync(errFd);
    } catch {
      // The child holds its own duplicates; ours are merely tidied up.
    }
  }

  if (pid === undefined) {
    return {
      ok: false,
      action: 'failed',
      detail: 'llama-server was spawned but reported no pid',
      snapshot: existing,
      logs,
    };
  }

  const record: LlamaOwnershipRecord = {
    schemaVersion: 1,
    pid,
    port: runtime.port,
    host: runtime.host,
    binPath: runtime.binPath,
    modelPath: model.path,
    modelRef: runtime.modelPath ? null : runtime.modelRef,
    args,
    requestedSlots: runtime.slots,
    requestedContext: runtime.context,
    startedAt: new Date().toISOString(),
    owner: 'cli',
  };
  // Recorded BEFORE the health wait: a supervisor killed mid-wait must still
  // leave behind something the next start can reclaim.
  const recorded = writeOwnershipRecord(record);

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  let snapshot = await snapshotFor(runtime, record);
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      clearOwnershipRecord();
      const tail = stderrTail(logs.stderr);
      return {
        ok: false,
        action: 'failed',
        detail:
          `llama-server exited while loading${tail ? `:\n${tail}` : ' (see the stderr log)'}`,
        snapshot: await snapshotFor(runtime, null),
        logs,
      };
    }
    snapshot = await snapshotFor(runtime, record);
    if (snapshot.state === 'up') {
      return {
        ok: true,
        action: 'started',
        detail:
          `llama-server is serving on ${snapshot.origin} (pid ${pid}, ` +
          `${snapshot.slots.configured ?? '?'} slots, ` +
          `${snapshot.contextPerSlot ?? '?'} ctx/slot)` +
          (recorded ? '' : ' — WARNING: the ownership record could not be written') +
          hostDowngradeNote(runtime),
        snapshot,
        logs,
      };
    }
    await sleep(HEALTH_POLL_MS);
  }

  return {
    ok: false,
    action: 'failed',
    detail:
      `llama-server did not report healthy within ${Math.round(
        (options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS) / 1000,
      )}s — it is still running (pid ${pid}); check ${logs.stderr}`,
    snapshot,
    logs,
  };
}

/**
 * Stop the serving runtime and release the port.
 *
 * A loaded launch agent is booted out FIRST. `KeepAlive` means launchd would
 * otherwise restart the process within seconds of us killing it, and "stop"
 * that does not stop anything is worse than a refusal. The plist is left in
 * place — `uninstall` is the command that removes it — so the operator can
 * bring 24/7 operation back with `start` without reinstalling.
 */
export async function stopLocalRuntime(
  options: LifecycleOptions = {},
): Promise<LlamaLifecycleResult> {
  const runtime = effectiveRuntime(options);
  const record = readOwnershipRecord();

  const notes: string[] = [];
  if (launchAgentLoaded()) {
    notes.push(
      bootoutLaunchAgent()
        ? 'the launch agent was booted out (its plist is still installed)'
        : 'the launch agent could not be booted out — it may restart the runtime',
    );
  }

  let killedPid: number | null = null;
  let recordIsSpent = false;

  if (record !== null && record.port === runtime.port) {
    const facts = livenessFactsFor(record);
    if (shouldReclaim(record, runtime.port, facts)) {
      await terminateTree(record.pid);
      killedPid = record.pid;
      recordIsSpent = true;
    }
  }

  if (killedPid === null) {
    const strangers = findLlamaServersOnPort(runtime.port);
    if (strangers.length > 0) {
      // A process our OWN launch agent started is not a stranger. launchd's
      // `KeepAlive` gives it a fresh pid nothing rewrote into the record, so
      // the recorded-pid check above necessarily fails for the one case the
      // launch agent exists to produce. When the record names the same binary
      // this process is running from, `stop` may act without --force: we just
      // booted the job out, so nothing will bring it back.
      const ours = record !== null && record.port === runtime.port
        ? strangers.filter((found) => found.binPath === record.binPath)
        : [];
      const reclaimable = ours.length === strangers.length && ours.length > 0 ? ours : null;

      if (reclaimable === null && options.force !== true) {
        // REFUSING. The record is the only evidence of what we once owned, so
        // it must survive a refusal — clearing it here would make the next
        // `stop` refuse from a worse position, permanently.
        const snapshot = await snapshotFor(runtime, record);
        return {
          ok: false,
          action: 'refused',
          detail:
            `a llama-server we do not own is on ${runtime.host}:${runtime.port} ` +
            `(pid ${strangers.map((s) => s.pid).join(', ')}). ` +
            'Re-run with --force to terminate it, or `start` first to adopt it.',
          snapshot,
        };
      }
      for (const stranger of reclaimable ?? strangers) {
        await terminateTree(stranger.pid);
        killedPid = stranger.pid;
      }
      recordIsSpent = true;
      notes.push(
        reclaimable !== null
          ? 'terminated the llama-server our launch agent had restarted'
          : 'terminated an unmanaged llama-server because --force was given',
      );
    } else if (record !== null && record.port === runtime.port) {
      // Nothing is on the port and the recorded process is gone: the record
      // describes a corpse and is safe to drop.
      recordIsSpent = true;
    }
  }

  if (recordIsSpent) clearOwnershipRecord();

  const snapshot = await snapshotFor(runtime, null);
  const portFree = await isPortFree(runtime.host, runtime.port);
  const orphans = findLlamaServersOnPort(runtime.port).filter((found) => processAlive(found.pid));

  if (killedPid === null && orphans.length === 0) {
    return {
      ok: true,
      action: 'not-running',
      detail:
        `nothing was serving on ${runtime.host}:${runtime.port}` +
        (notes.length > 0 ? ` (${notes.join('; ')})` : ''),
      snapshot,
    };
  }

  const clean = orphans.length === 0 && portFree;
  return {
    ok: clean,
    action: clean ? 'stopped' : 'failed',
    detail: clean
      ? `stopped llama-server (pid ${killedPid ?? '?'}); ${runtime.host}:${runtime.port} is free` +
        (notes.length > 0 ? ` — ${notes.join('; ')}` : '')
      : `terminated pid ${killedPid ?? '?'} but ${
          orphans.length > 0
            ? `orphans remain (${orphans.map((o) => o.pid).join(', ')})`
            : `${runtime.host}:${runtime.port} is not free yet`
        }`,
    snapshot,
  };
}

/** Stop then start. Reports the start's outcome, with the stop folded in. */
export async function restartLocalRuntime(
  options: LifecycleOptions = {},
): Promise<LlamaLifecycleResult> {
  const stopped = await stopLocalRuntime(options);
  if (!stopped.ok && stopped.action === 'refused') return stopped;

  const started = await startLocalRuntime(options);
  return {
    ...started,
    action: started.ok && started.action === 'started' ? 'restarted' : started.action,
    detail: `${stopped.detail}; ${started.detail}`,
  };
}
