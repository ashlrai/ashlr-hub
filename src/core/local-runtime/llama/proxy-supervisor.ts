/**
 * The proxy supervisor: start, adopt, stop and inspect the Anthropic lane.
 *
 * supervisor.ts, for the second process. The lifecycle is deliberately the same
 * boring, idempotent shape, because an operator who has learned how
 * `local-runtime start` treats llama-server should not have to learn a second
 * set of rules for the listener in front of it:
 *
 *   * `ensure` on a healthy proxy of ours is a no-op that says so;
 *   * a proxy already on the port that we can PROVE is ours is ADOPTED, never
 *     duplicated — the ordinary case, since every CLI invocation is a new
 *     process that spawned none of them;
 *   * a listener we cannot prove is ours is REFUSED, never killed;
 *   * `stop` with nothing running is a success, not an error;
 *   * a record that no longer describes a live process of ours is discarded
 *     rather than acted on, so a recycled pid can never become a kill.
 *
 * ONE DEPARTURE from llama-server's lifecycle, and it is deliberate: when we
 * own the proxy but it is forwarding to a DIFFERENT llama-server than the one
 * being started, it is restarted rather than reported. llama-server cannot be
 * repointed cheaply — it holds 27 GB of mapped weights — so `start` there can
 * only describe the drift. A proxy is a socket and a pipe; leaving one quietly
 * forwarding to a runtime nobody is using is the two-endpoints failure this
 * module family exists to make impossible, and here we can simply fix it.
 *
 * Nothing here consults `~/.ashlr/KILL`, creates it, or removes it.
 */

import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  allowsNonLoopback,
  gateBindHost,
  originFor,
  resolveLlamaRuntimeConfig,
} from './config.js';
import { anthropicProxyStderrLogPath, anthropicProxyStdoutLogPath, logsDir } from './paths.js';
import { isPortFree } from './port.js';
import { processAlive, processArgv, sleep, terminateTree } from './process.js';
import {
  anthropicProxyHostInvocation,
  argvMatchesProxyRecord,
  currentHostInvocationContext,
  findAnthropicProxiesOnPort,
} from './proxy-process.js';
import {
  clearAnthropicProxyRecord,
  readAnthropicProxyRecord,
  writeAnthropicProxyRecord,
} from './proxy-record.js';
import type { AshlrConfig } from '../../types.js';
import type { AnthropicProxyLifecycleResult, AnthropicProxyOwnershipRecord } from './types.js';

/**
 * How long `ensure` waits for a freshly spawned host to answer.
 *
 * Unlike llama-server's five minutes this is short on purpose: the child binds
 * a socket and opens a pipe. It loads no weights, so anything past a couple of
 * seconds is a failure to launch, not a slow start, and a generous deadline
 * would only delay the operator learning that.
 */
export const DEFAULT_PROXY_START_TIMEOUT_MS = 10_000;

/** Poll interval while waiting for the host to answer. */
const PROXY_POLL_MS = 100;

/** How long a single liveness probe may take. Loopback; nothing to wait for. */
const PROBE_TIMEOUT_MS = 1_500;

/** How long `stop` waits for the port to be released after the kill. */
const PORT_RELEASE_TIMEOUT_MS = 5_000;

export interface DetachedProxyOptions {
  /** Config the ports, bind host and loopback opt-in are resolved from. */
  cfg?: AshlrConfig;
  /** Override the proxy's own port. */
  port?: number;
  /** Override llama-server's port — what the proxy forwards to. */
  upstreamPort?: number;
  /** Deadline for a freshly spawned host to start answering. */
  timeoutMs?: number;
  /** Terminate a listener on our port that we have no record for. */
  force?: boolean;
  /**
   * How to build the child's command line. Injected ONLY by tests, which run
   * under a test runner whose `process.argv[1]` is the runner rather than this
   * CLI, so the real resolution would produce an argv that re-enters vitest.
   */
  invocation?: (port: number, upstreamPort: number) => { command: string; args: string[] };
}

/** Where a proxy would live, with the bind host already gated. */
interface ResolvedProxyTarget {
  host: string;
  port: number;
  upstreamPort: number;
  upstreamOrigin: string;
  origin: string;
  baseUrl: string;
}

/**
 * Resolve where the proxy belongs.
 *
 * The host comes from the PERSISTED config and is re-gated here; it is
 * deliberately not an option on this interface. Ports are ordinary overrides —
 * `--port` genuinely has to move both endpoints — but a bind host is the one
 * value an argument must never be able to supply, because the thing behind this
 * listener has no authentication at all.
 */
function resolveTarget(options: DetachedProxyOptions): ResolvedProxyTarget {
  const runtime = resolveLlamaRuntimeConfig(options.cfg);
  const { host } = gateBindHost(runtime.host, allowsNonLoopback(options.cfg));
  const port = options.port ?? runtime.anthropicPort;
  const upstreamPort = options.upstreamPort ?? runtime.port;
  const origin = originFor(host, port);
  return {
    host,
    port,
    upstreamPort,
    upstreamOrigin: originFor(host, upstreamPort),
    origin,
    baseUrl: `${origin}/v1`,
  };
}

/**
 * Does this port accept a TCP connection?
 *
 * This — not an HTTP round trip — is what "the child we just spawned has bound
 * its socket" actually means, and it is deliberately the weaker question.
 *
 * The proxy pipes every path but `/v1/messages` byte-for-byte to llama-server
 * and answers NOTHING for itself; that invariant is load-bearing (see the
 * anthropic-proxy.ts header) and is not worth breaking for a health endpoint.
 * The consequence is that an HTTP probe through the proxy measures llama-server
 * too: a wedged upstream that accepts connections and never replies would make
 * a perfectly healthy proxy look dead, and `start` would then report failure
 * for a lane that was working. Asking the narrower question keeps the two
 * processes' health independent, which is the whole reason they are two
 * processes.
 *
 * Paired with `processAlive(pid)` on a pid we spawned, onto a port `isPortFree`
 * said was free moments earlier, this is a sound proof of ownership.
 *
 * Never throws; an unreachable port is `false`, not an exception.
 */
export function anthropicProxyAccepts(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
      resolve(alive);
    };
    const socket = connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/**
 * Is a proxy answering HTTP on this host/port, end to end?
 *
 * ANY HTTP response counts, including a 502. That is not laziness: a 502 from
 * this listener means the proxy is up and llama-server is not, which is exactly
 * the proxy being healthy at the only job it has. Requiring a 200 would make
 * the Anthropic lane un-reportable whenever the runtime behind it was still
 * loading.
 *
 * Used for REPORTING (`status`), not for lifecycle decisions — see
 * {@link anthropicProxyAccepts} for why the two are separate questions.
 *
 * Never throws; an unreachable port is `false`, not an exception.
 */
export function anthropicProxyResponds(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };
    let req: ReturnType<typeof httpRequest>;
    try {
      req = httpRequest(
        { hostname: host, port, path: '/health', method: 'GET', timeout: timeoutMs },
        (res) => {
          // The status is irrelevant — that bytes came back at all is the fact.
          res.resume();
          finish(true);
        },
      );
    } catch {
      finish(false);
      return;
    }
    req.on('error', () => finish(false));
    req.on('timeout', () => {
      req.destroy();
      finish(false);
    });
    req.end();
  });
}

/** Does the record describe a live proxy host of ours on this port? */
function recordIsLive(record: AnthropicProxyOwnershipRecord, port: number): boolean {
  if (record.port !== port || record.pid <= 1) return false;
  if (!processAlive(record.pid)) return false;
  const argv = processArgv(record.pid);
  return argv !== null && argvMatchesProxyRecord(argv, record);
}

/** Build the record for a host process we spawned or adopted. */
function recordFor(
  target: ResolvedProxyTarget,
  pid: number,
  execPath: string,
  owner: AnthropicProxyOwnershipRecord['owner'],
): AnthropicProxyOwnershipRecord {
  return {
    schemaVersion: 1,
    pid,
    port: target.port,
    host: target.host,
    execPath,
    upstreamPort: target.upstreamPort,
    upstreamOrigin: target.upstreamOrigin,
    startedAt: new Date().toISOString(),
    owner,
  };
}

/**
 * Adopt a proxy host already on our port that we can prove is ours.
 *
 * "Prove" is the process table showing exactly ONE process whose argv is this
 * CLI re-entering itself on this port. Ambiguity (two matches) is reported
 * rather than guessed at, exactly as llama-server's adoption does — the cost of
 * guessing wrong is terminating a stranger.
 */
function adoptRunning(target: ResolvedProxyTarget): AnthropicProxyOwnershipRecord | null {
  const candidates = findAnthropicProxiesOnPort(target.port);
  if (candidates.length !== 1) return null;
  const found = candidates[0] as (typeof candidates)[number];
  // The upstream is NOT recoverable from an adopted process's argv with any
  // confidence beyond the port it was told to forward to, and that is exactly
  // what argv carries — so it is read back from there rather than assumed to be
  // the one we wanted. A mismatch is then visible to the caller instead of
  // being overwritten by a record that says what we hoped.
  const upstreamPort = upstreamPortFromArgv(found.argv) ?? target.upstreamPort;
  return {
    schemaVersion: 1,
    pid: found.pid,
    port: target.port,
    host: target.host,
    execPath: found.execPath,
    upstreamPort,
    upstreamOrigin: originFor(target.host, upstreamPort),
    startedAt: new Date().toISOString(),
    owner: 'adopted',
  };
}

/** Recover `--upstream-port` from an argv line. Pure; null when absent. */
export function upstreamPortFromArgv(argv: string): number | null {
  const match = /(?:^|\s)--upstream-port(?:=|\s+)(\d{1,5})(?:\s|$)/.exec(argv);
  if (match === null) return null;
  const port = Number.parseInt(match[1] as string, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

/** Spawn the detached host. Returns its pid, or an error to report. */
function spawnHost(
  target: ResolvedProxyTarget,
  options: DetachedProxyOptions,
): { pid: number; execPath: string } | { error: string } {
  let outFd: number;
  let errFd: number;
  try {
    mkdirSync(logsDir(), { recursive: true, mode: 0o700 });
    outFd = openSync(anthropicProxyStdoutLogPath(), 'a', 0o600);
    errFd = openSync(anthropicProxyStderrLogPath(), 'a', 0o600);
  } catch (err: unknown) {
    return { error: `could not open the proxy logs: ${err instanceof Error ? err.message : String(err)}` };
  }

  const build = options.invocation ??
    ((port: number, upstreamPort: number) =>
      anthropicProxyHostInvocation(
        port,
        upstreamPort,
        currentHostInvocationContext(import.meta.url),
      ));
  const invocation = build(target.port, target.upstreamPort);

  try {
    const child = spawn(invocation.command, invocation.args, {
      // Detached + unref, for the same reason llama-server is: the listener
      // must outlive the CLI invocation that started it. That is the entire
      // difference between a service and a process that dies with its terminal.
      detached: true,
      stdio: ['ignore', outFd, errFd],
      cwd: homedir(),
    });
    child.unref();
    if (child.pid === undefined) return { error: 'the proxy host was spawned but reported no pid' };
    return { pid: child.pid, execPath: invocation.command };
  } catch (err: unknown) {
    return {
      error: `could not spawn the proxy host: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      closeSync(outFd);
      closeSync(errFd);
    } catch {
      // The child holds its own duplicates; ours are merely tidied up.
    }
  }
}

function failed(detail: string, target: ResolvedProxyTarget): AnthropicProxyLifecycleResult {
  return { ok: false, action: 'failed', detail, record: null, baseUrl: target.baseUrl };
}

/**
 * Bring up the detached proxy, or prove one is already up.
 *
 * Never throws and never fails loudly for an expected state: llama-server
 * serving correctly is still a success even when the Anthropic lane in front of
 * it could not bind, so the caller gets a value it can fold into its own
 * sentence rather than an exception it can forget to catch.
 */
export async function ensureDetachedAnthropicProxy(
  options: DetachedProxyOptions = {},
): Promise<AnthropicProxyLifecycleResult> {
  const target = resolveTarget(options);
  const existing = readAnthropicProxyRecord();

  if (existing !== null && recordIsLive(existing, target.port)) {
    if (existing.upstreamOrigin === target.upstreamOrigin) {
      return {
        ok: true,
        action: 'already-running',
        detail:
          `the Anthropic proxy is already serving on ${target.origin} ` +
          `(pid ${existing.pid}) and forwarding to ${existing.upstreamOrigin}`,
        record: existing,
        baseUrl: target.baseUrl,
      };
    }
    // Ours, but pointed at the wrong llama-server. See the module header: a
    // proxy is cheap to replace and a mis-pointed one is a lane that accepts
    // every request and answers none of them usefully.
    await terminateTree(existing.pid);
    clearAnthropicProxyRecord();
    const respawned = await launch(target, options);
    return respawned.ok && respawned.action === 'started'
      ? {
          ...respawned,
          action: 'restarted',
          detail:
            `repointed the Anthropic proxy on ${target.origin} from ` +
            `${existing.upstreamOrigin} to ${target.upstreamOrigin}`,
        }
      : respawned;
  }

  // A record that does not describe a live process of ours is worthless, and a
  // worthless record must never become a kill decision.
  if (existing !== null) clearAnthropicProxyRecord();

  const portBusy = !(await isPortFree(target.host, target.port));
  if (portBusy) {
    const adopted = adoptRunning(target);
    if (adopted !== null) {
      writeAnthropicProxyRecord(adopted);
      if (adopted.upstreamOrigin !== target.upstreamOrigin) {
        // Adopted, then repointed: now that it is ours we can fix it, and the
        // alternative is a managed proxy we know is wrong.
        await terminateTree(adopted.pid);
        clearAnthropicProxyRecord();
        const respawned = await launch(target, options);
        return respawned.ok && respawned.action === 'started'
          ? {
              ...respawned,
              action: 'restarted',
              detail:
                `adopted the Anthropic proxy on ${target.origin} and repointed it from ` +
                `${adopted.upstreamOrigin} to ${target.upstreamOrigin}`,
            }
          : respawned;
      }
      return {
        ok: true,
        action: 'adopted',
        detail:
          `adopted the Anthropic proxy already running on ${target.origin} ` +
          `(pid ${adopted.pid}) — it is now managed`,
        record: adopted,
        baseUrl: target.baseUrl,
      };
    }

    // REFUSED, not killed. Whatever is on this port, we cannot prove it is
    // ours, and the convention across this module family is that an
    // unidentifiable listener is the operator's to deal with.
    const strangers = findAnthropicProxiesOnPort(target.port);
    return {
      ok: false,
      action: 'refused',
      detail:
        `${target.host}:${target.port} is occupied by something we do not own` +
        (strangers.length > 1
          ? ` (${strangers.length} proxy hosts claim it: pids ${strangers.map((s) => s.pid).join(', ')})`
          : '') +
        `, so the Anthropic proxy was not started. Free it, or choose another port with ` +
        'models.llamaServer.anthropicPort.',
      record: null,
      baseUrl: target.baseUrl,
    };
  }

  return launch(target, options);
}

/** Spawn, record, and wait for the host to answer. */
async function launch(
  target: ResolvedProxyTarget,
  options: DetachedProxyOptions,
): Promise<AnthropicProxyLifecycleResult> {
  const spawned = spawnHost(target, options);
  if ('error' in spawned) return failed(spawned.error, target);

  const record = recordFor(target, spawned.pid, spawned.execPath, 'cli');
  // Recorded BEFORE the wait: a supervisor killed mid-wait must still leave
  // behind something the next start can reclaim.
  const recorded = writeAnthropicProxyRecord(record);

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_PROXY_START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (!processAlive(spawned.pid)) {
      clearAnthropicProxyRecord();
      return failed(
        `the Anthropic proxy host exited while starting; see ${anthropicProxyStderrLogPath()}`,
        target,
      );
    }
    if (await anthropicProxyAccepts(target.host, target.port)) {
      return {
        ok: true,
        action: 'started',
        detail:
          `the Anthropic proxy is serving on ${target.origin} (pid ${spawned.pid}) and ` +
          `forwarding to ${target.upstreamOrigin}` +
          (recorded ? '' : ' — WARNING: the ownership record could not be written'),
        record,
        baseUrl: target.baseUrl,
      };
    }
    await sleep(PROXY_POLL_MS);
  }

  return failed(
    `the Anthropic proxy host did not answer on ${target.origin} within ` +
      `${Math.round((options.timeoutMs ?? DEFAULT_PROXY_START_TIMEOUT_MS) / 1000)}s ` +
      `(pid ${spawned.pid}); see ${anthropicProxyStderrLogPath()}`,
    target,
  );
}

/**
 * Stop the detached proxy and release the port.
 *
 * Idempotent: stopping what is not running is `not-running` and `ok: true`, not
 * an error. A listener we cannot prove is ours is refused rather than killed,
 * unless `force` is given — the same bargain `local-runtime stop --force`
 * offers for llama-server.
 */
export async function stopDetachedAnthropicProxy(
  options: DetachedProxyOptions = {},
): Promise<AnthropicProxyLifecycleResult> {
  const target = resolveTarget(options);
  const record = readAnthropicProxyRecord();

  let killedPid: number | null = null;

  if (record !== null && recordIsLive(record, target.port)) {
    await terminateTree(record.pid);
    killedPid = record.pid;
    clearAnthropicProxyRecord();
  } else {
    // A proxy host carrying our internal flag on our port IS one of ours even
    // with no record: the flag is undocumented, absent from parsing, help and
    // completions, and reachable only from this program spawning itself. A
    // previous CLI run whose record was lost is the ordinary way to get here,
    // and refusing would leave a port nothing in this tool could ever free.
    const ours = findAnthropicProxiesOnPort(target.port).filter((found) =>
      processAlive(found.pid),
    );
    if (ours.length > 0) {
      for (const found of ours) {
        await terminateTree(found.pid);
        killedPid = found.pid;
      }
      clearAnthropicProxyRecord();
    } else if (record !== null) {
      // The record describes a corpse; dropping it is safe.
      clearAnthropicProxyRecord();
    }
  }

  if (killedPid === null) {
    // Nothing of ours was there. Is something ELSE holding the port?
    const free = await isPortFree(target.host, target.port);
    if (!free && options.force !== true) {
      return {
        ok: false,
        action: 'refused',
        detail:
          `${target.host}:${target.port} is held by a listener we do not own, so it was left ` +
          'alone. Re-run with --force to terminate it.',
        record: null,
        baseUrl: target.baseUrl,
      };
    }
    return {
      ok: true,
      action: 'not-running',
      detail: `no Anthropic proxy of ours was serving on ${target.origin}`,
      record: null,
      baseUrl: target.baseUrl,
    };
  }

  // A dead process is not a released port: wait for the socket to actually go.
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  let portFree = await isPortFree(target.host, target.port);
  while (!portFree && Date.now() < deadline) {
    await sleep(PROXY_POLL_MS);
    portFree = await isPortFree(target.host, target.port);
  }

  return {
    ok: portFree,
    action: portFree ? 'stopped' : 'failed',
    detail: portFree
      ? `stopped the Anthropic proxy (pid ${killedPid}); ${target.host}:${target.port} is free`
      : `terminated pid ${killedPid} but ${target.host}:${target.port} is not free yet`,
    record: null,
    baseUrl: target.baseUrl,
  };
}

/** Read the proxy's state without changing anything. Never throws. */
export async function statusDetachedAnthropicProxy(
  options: DetachedProxyOptions = {},
): Promise<AnthropicProxyLifecycleResult> {
  const target = resolveTarget(options);
  const record = readAnthropicProxyRecord();
  const live = record !== null && recordIsLive(record, target.port);
  // The narrow question here too. `status` must answer about the PROXY, not
  // about llama-server: this command family already has a surface that reports
  // the runtime's health (`local-runtime status`), and a second one that
  // silently conflates the two is how an operator ends up restarting the wrong
  // process. It also means `status` cannot hang on a wedged upstream.
  const responds = await anthropicProxyAccepts(target.host, target.port);

  if (live && responds) {
    return {
      ok: true,
      action: 'already-running',
      detail:
        `the Anthropic proxy is serving on ${target.origin} (pid ${(record as AnthropicProxyOwnershipRecord).pid}, ` +
        `${(record as AnthropicProxyOwnershipRecord).owner}) and forwarding to ` +
        `${(record as AnthropicProxyOwnershipRecord).upstreamOrigin}`,
      record,
      baseUrl: target.baseUrl,
    };
  }
  if (responds) {
    const ours = findAnthropicProxiesOnPort(target.port);
    return {
      ok: true,
      action: 'already-running',
      detail:
        `something is answering on ${target.origin}` +
        (ours.length === 1
          ? ` — an unmanaged proxy host (pid ${(ours[0] as (typeof ours)[number]).pid}); \`start\` will adopt it`
          : ', but we do not own it'),
      record: null,
      baseUrl: target.baseUrl,
    };
  }
  return {
    ok: false,
    action: 'not-running',
    detail: `nothing is answering on ${target.origin}`,
    record: null,
    baseUrl: target.baseUrl,
  };
}
