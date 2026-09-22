/**
 * Health and capacity reporting for the serving runtime.
 *
 * Two rules govern everything here:
 *
 *  1. **Never throw.** A runtime that is down, half-started, or answering
 *     something unparseable is a VALUE (`state: 'down' | 'loading' |
 *     'unknown'`), not an exception. Callers include a status command, the
 *     provider registry and the dispatch path; any of them crashing because a
 *     model server is restarting would be a worse failure than the restart.
 *
 *  2. **Read capacity back from the server, never from our own flags.** The
 *     `--parallel N` we passed is a REQUEST. `/props.total_slots` is what the
 *     server actually built. Reporting the request as if it were the truth is
 *     how a fleet ends up dispatching more agents than there are slots, and
 *     the resulting queue is invisible — every request "succeeds", just later
 *     and later.
 *
 * The HTTP layer is injectable so the composition rules can be unit-tested
 * against fixed payloads without binding a socket.
 */

import { readKillSwitch } from '../../sandbox/policy.js';
import { launchAgentInstalled } from './launchd.js';
import { argvMatchesRecord, findLlamaServersOnPort, processAlive, processArgv } from './process.js';
import { readOwnershipRecord } from './record.js';
import { resolveLlamaServerBaseUrl } from './config.js';
import type {
  LlamaOwnershipRecord,
  LlamaRuntimeSnapshot,
  LlamaRuntimeState,
  LlamaSlotCapacity,
  ServingRuntimeIdentity,
} from './types.js';

/** Same 2s bound the provider registry uses — a status command must stay snappy. */
const PROBE_TIMEOUT_MS = 2_000;

/** Minimal fetch surface, so a test can supply a function instead of a server. */
export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** One endpoint's answer, already reduced to something that cannot throw. */
export interface EndpointReading {
  httpStatus: number | null;
  body: unknown | null;
  error: string | null;
}

/** The readings a snapshot is composed from. */
export interface LlamaProbeReadings {
  health: EndpointReading;
  props: EndpointReading;
  slots: EndpointReading;
  /**
   * `GET <origin>/api/version`, read ONLY when the first three could not prove
   * a llama-server. Ollama serves it; llama-server 404s it. Absent means the
   * identifying probe was not needed, not that it failed.
   */
  ollamaVersion?: EndpointReading;
}

/**
 * Ollama's own reason for serialising this model, recorded from its server log
 * while measuring docs/LOCAL-FLEET.md. Carried verbatim as the runtime's words
 * so a surface can show evidence beside its own sentence.
 */
export const OLLAMA_PARALLEL_REFUSAL =
  'ollama: "model architecture does not currently support parallel requests" ' +
  '(architecture=qwen35) — requests queue rather than batch, and OLLAMA_NUM_PARALLEL ' +
  'does not change it';

/**
 * Identify the runtime from what it answered.
 *
 * Evidence first, assumption last: a readable slot count is proof of
 * llama-server; `/api/version` answering is proof of Ollama; a llama-server
 * shaped `/health` is good enough when nothing contradicts it; anything else
 * is honestly 'unknown'.
 */
export function identifyRuntime(
  readings: LlamaProbeReadings,
  slots: LlamaSlotCapacity,
  state: LlamaRuntimeState,
): ServingRuntimeIdentity {
  if (slots.source !== 'unknown') return 'llama-server';
  const version = readings.ollamaVersion;
  if (version && version.httpStatus === 200 && strField(version.body, 'version') !== null) {
    return 'ollama';
  }
  if (state === 'up' || state === 'loading') return 'llama-server';
  if (state === 'down') return 'unknown';
  return 'unknown';
}

/** GET a JSON endpoint under a hard timeout. Never throws. */
async function readEndpoint(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<EndpointReading> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    let body: unknown = null;
    let parseError: string | null = null;
    try {
      body = await response.json();
    } catch {
      parseError = 'response body is not valid JSON';
    }
    return { httpStatus: response.status, body, error: parseError };
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timed out after ${timeoutMs}ms`
          : err.message
        : String(err);
    return { httpStatus: null, body: null, error: message };
  } finally {
    // Cleared only after the body read, so a server that hangs the body is
    // still bounded by the same timeout as the request.
    clearTimeout(timer);
  }
}

/** Read a numeric field out of an unknown object. */
function numField(body: unknown, key: string): number | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Read a string field out of an unknown object. */
function strField(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Interpret `/health`.
 *
 * llama-server answers 200 `{"status":"ok"}` when serving and 503
 * `{"status":"loading model"}` while the weights are still being mapped — a
 * 27 GB model makes that window minutes long on a cold page cache, and calling
 * it "down" would make the supervisor give up on a runtime that is working.
 */
export function interpretHealth(reading: EndpointReading): LlamaRuntimeState {
  if (reading.httpStatus === null) {
    const error = reading.error ?? '';
    // A refused connection is a definite answer: nothing is listening.
    if (/ECONNREFUSED|refused|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed/i.test(error)) {
      return 'down';
    }
    return 'unknown';
  }
  const status = strField(reading.body, 'status');
  if (reading.httpStatus === 200 && (status === null || status === 'ok')) return 'up';
  if (reading.httpStatus === 503) return 'loading';
  return 'unknown';
}

/**
 * Derive slot capacity from `/props` and `/slots`.
 *
 * `configured` comes from `/props.total_slots` and falls back to the LENGTH of
 * the `/slots` array — both are the live server describing itself. Neither
 * falls back to the `--parallel` value we asked for: an unreadable server
 * yields `null`, and `null` must make a caller refuse to size a fleet rather
 * than quietly substituting an optimistic number.
 */
export function deriveSlotCapacity(props: EndpointReading, slots: EndpointReading): LlamaSlotCapacity {
  const fromProps = numField(props.body, 'total_slots');
  const slotList = Array.isArray(slots.body) ? (slots.body as unknown[]) : null;

  let configured: number | null = null;
  let source: LlamaSlotCapacity['source'] = 'unknown';
  if (fromProps !== null && fromProps > 0) {
    configured = Math.trunc(fromProps);
    source = 'props';
  } else if (slotList !== null && slotList.length > 0) {
    configured = slotList.length;
    source = 'slots';
  }

  let busy: number | null = null;
  if (slotList !== null) {
    busy = slotList.filter((slot) => {
      if (typeof slot !== 'object' || slot === null) return false;
      const record = slot as Record<string, unknown>;
      if (record['is_processing'] === true) return true;
      // Older builds report a numeric state; 0 is idle, anything else is not.
      const state = record['state'];
      return typeof state === 'number' && state !== 0;
    }).length;
  }

  const idle = configured !== null && busy !== null ? Math.max(0, configured - busy) : null;
  return { configured, busy, idle, source };
}

/** Options for {@link probeLlamaRuntime}. */
export interface ProbeOptions {
  /** Origin to probe, e.g. http://127.0.0.1:8080. Defaults to the resolved one. */
  origin?: string;
  /** OpenAI-compatible base to report. Defaults to `<origin>/v1`. */
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Pre-read ownership record, so a caller that already has one does not re-read. */
  record?: LlamaOwnershipRecord | null;
  /** Skip the process-table check (used when the caller already proved ownership). */
  skipOwnershipCheck?: boolean;
}

/**
 * Compose a snapshot from readings that have already been taken.
 *
 * Pure apart from the clock, which is why the interesting rules — how a
 * loading server is reported, when a record counts as ours, what happens when
 * `/props` is unreadable — are testable without a socket.
 */
export function composeSnapshot(args: {
  origin: string;
  baseUrl: string;
  host: string;
  port: number;
  readings: LlamaProbeReadings;
  record: LlamaOwnershipRecord | null;
  ownershipVerified: boolean;
  /**
   * The pid actually serving, when it is NOT the one the record names — a
   * launchd `KeepAlive` restart produces exactly that: our job, our argv, a
   * new pid, and a record nothing rewrote. Supplying it keeps `managed` true
   * across a restart; `startedAt` then goes null, because the record timed a
   * process that is gone and quoting its clock would be a fabricated uptime.
   */
  observedPid?: number | null;
  launchAgent: boolean;
  killSwitch: boolean;
  now?: number;
}): LlamaRuntimeSnapshot {
  const now = args.now ?? Date.now();
  const state = interpretHealth(args.readings.health);
  const slots = deriveSlotCapacity(args.readings.props, args.readings.slots);
  const runtimeKind = identifyRuntime(args.readings, slots, state);

  const model =
    strField(args.readings.props.body, 'model_path') ??
    strField(args.readings.props.body, 'model_alias') ??
    args.record?.modelPath ??
    null;

  // A HUMANE name, or nothing. The record's Ollama reference is one. The
  // basename of `model_path` usually is too — but when the GGUF was resolved
  // out of Ollama's content-addressed store it is `sha256-2bb22714…`, a digest
  // that describes this machine's storage layout, names no model, and has no
  // business on a transport that deliberately carries no machine detail. Null
  // renders as "unknown", which is the honest answer: we can see the server
  // serving a model and cannot name it.
  const basename = model === null ? null : (model.split('/').pop() ?? model);
  const modelName =
    args.record?.modelRef ??
    (basename !== null && !/^sha256[-:][0-9a-f]{16,}$/i.test(basename) ? basename : null);

  const generation = (args.readings.props.body as Record<string, unknown> | null)?.[
    'default_generation_settings'
  ];
  const contextPerSlot = numField(generation ?? null, 'n_ctx');
  const contextTotal =
    contextPerSlot !== null && slots.configured !== null
      ? contextPerSlot * slots.configured
      : (args.record?.requestedContext ?? 0) > 0
        ? (args.record as LlamaOwnershipRecord).requestedContext
        : null;

  const readopted = typeof args.observedPid === 'number' && args.observedPid > 1;
  const startedAt = args.ownershipVerified && !readopted
    ? (args.record?.startedAt ?? null)
    : null;
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);

  const lastError =
    args.readings.health.error ??
    (state === 'up' ? (args.readings.props.error ?? args.readings.slots.error) : null);

  return {
    schemaVersion: 1,
    state,
    runtimeKind,
    parallelRefusal: runtimeKind === 'ollama' ? OLLAMA_PARALLEL_REFUSAL : null,
    baseUrl: args.baseUrl,
    origin: args.origin,
    host: args.host,
    port: args.port,
    model,
    modelName,
    quant: strField(args.readings.props.body, 'model_ftype'),
    contextTotal,
    contextPerSlot,
    slots,
    pid: args.ownershipVerified
      ? (readopted ? (args.observedPid as number) : (args.record?.pid ?? null))
      : null,
    owner: args.ownershipVerified
      ? (readopted ? 'launchd' : (args.record?.owner ?? null))
      : null,
    managed: args.ownershipVerified,
    startedAt,
    uptimeMs: Number.isNaN(startedMs) ? null : Math.max(0, now - startedMs),
    launchAgentInstalled: args.launchAgent,
    killSwitchEngaged: args.killSwitch,
    lastError,
    checkedAt: new Date(now).toISOString(),
  };
}

/** Default fetch adapter over the platform `fetch`. */
const defaultFetch: FetchLike = (url, init) =>
  fetch(url, { method: 'GET', signal: init.signal, headers: { Accept: 'application/json' } });

/**
 * Probe the runtime and return a full snapshot. Never throws.
 *
 * `/props` and `/slots` are read concurrently with `/health` rather than after
 * it: a server that is up answers all three in a millisecond, and a server
 * that is down fails all three at the same timeout instead of serially.
 */
export async function probeLlamaRuntime(options: ProbeOptions = {}): Promise<LlamaRuntimeSnapshot> {
  const record = options.record !== undefined ? options.record : readOwnershipRecord();
  const baseUrl = options.baseUrl ?? resolveLlamaServerBaseUrl();
  let origin = options.origin ?? null;
  if (origin === null) {
    try {
      origin = new URL(baseUrl).origin;
    } catch {
      origin = baseUrl.replace(/\/v1\/?$/, '');
    }
  }

  let host = record?.host ?? '';
  let port = record?.port ?? 0;
  try {
    const parsed = new URL(origin);
    host = parsed.hostname;
    port = Number.parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
  } catch {
    // Keep whatever the record told us; a malformed origin is reported, not thrown.
  }

  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const [health, props, slots] = await Promise.all([
    readEndpoint(`${origin}/health`, fetchImpl, timeoutMs),
    readEndpoint(`${origin}/props`, fetchImpl, timeoutMs),
    readEndpoint(`${origin}/slots`, fetchImpl, timeoutMs),
  ]);

  // IDENTIFY only when the three above did not already prove a llama-server.
  // This sits on the dispatcher's hot path, so the healthy case costs nothing:
  // a serving llama-server answers /props with total_slots and never reaches
  // here. It is the FAILING case that needs the extra round trip, because
  // "llama-server · state unknown" and "you pointed this at Ollama, which
  // serialises this architecture" are completely different problems.
  const provenLlamaServer =
    deriveSlotCapacity(props, slots).source !== 'unknown';
  const ollamaVersion = provenLlamaServer
    ? undefined
    : await readEndpoint(`${origin}/api/version`, fetchImpl, timeoutMs);

  let ownershipVerified = false;
  let observedPid: number | null = null;
  if (record !== null && record.port === port) {
    if (options.skipOwnershipCheck === true) {
      ownershipVerified = true;
    } else if (processAlive(record.pid)) {
      const argv = processArgv(record.pid);
      ownershipVerified = argv !== null && argvMatchesRecord(argv, record);
    }
    if (!ownershipVerified) {
      // RE-ADOPTION. The recorded pid is dead or is no longer a llama-server —
      // which is the NORMAL state after a launchd `KeepAlive` restart, the
      // entire point of the launch agent. Nothing in this codebase learns the
      // new pid, so a record-only check would report `managed: false` for a job
      // we installed ourselves, hide the cockpit's start/stop controls, and
      // send `stop` down its "a llama-server we do not own" refusal.
      //
      // A single llama-server bound to this port, launched from the binary the
      // record names, IS that job. Accepting it is evidence-based, not a guess:
      // exactly one match is required, so an ambiguous port stays unmanaged.
      // This probe stays READ-ONLY — it is on the dispatcher's hot path and a
      // health check must never write to the ownership record.
      const candidates = findLlamaServersOnPort(port)
        .filter((found) => found.binPath === record.binPath && processAlive(found.pid));
      if (candidates.length === 1) {
        ownershipVerified = true;
        observedPid = (candidates[0] as (typeof candidates)[number]).pid;
      }
    }
  }

  return composeSnapshot({
    origin,
    baseUrl,
    host,
    port,
    readings: { health, props, slots, ...(ollamaVersion ? { ollamaVersion } : {}) },
    record,
    ownershipVerified,
    observedPid,
    launchAgent: launchAgentInstalled(),
    killSwitch: readKillSwitch().state !== 'inactive',
  });
}

/**
 * The number of agents the fleet may dispatch at once.
 *
 * Deliberately returns `null` rather than a fallback when the server cannot be
 * read. There is no safe default here: guessing high queues requests behind
 * one another with no visible signal, and guessing low wastes the capacity the
 * runtime exists to provide. A caller that gets `null` must say "unknown", not
 * pick a number.
 */
export function fleetConcurrencyLimit(snapshot: LlamaRuntimeSnapshot): number | null {
  if (snapshot.state !== 'up') return null;
  return snapshot.slots.configured;
}
