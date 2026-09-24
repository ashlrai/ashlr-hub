/**
 * local-fleet.ts — many local coding agents at once, running unattended.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 * `docs/LOCAL-FLEET.md` records a measurement, not a preference: Ollama
 * REFUSES to serve Qwen3.8 concurrently. Four concurrent requests to
 * `qwen3.8:27b-ctx64k` returned at 3.7 / 7.6 / 11.4 / 15.2 s — a four-second
 * stagger, which is a queue. The server says why:
 *
 *   WARN sched.go msg="model architecture does not currently support parallel
 *        requests" architecture=qwen35
 *
 * `OLLAMA_NUM_PARALLEL` does not move it; the scheduler refuses before the knob
 * is consulted. llama-server, given the SAME GGUF, finished four concurrent
 * requests together at 8.6 / 8.9 / 9.0 / 9.0 s — continuous batching across
 * four slots sharing ONE 27 GB copy of the weights.
 *
 * So the fleet runs on llama-server (OpenAI-compatible at `/v1`), and Ollama
 * keeps what it is good at: model discovery, embeddings, single interactive
 * chats.
 *
 * ── THE ONE INVARIANT ──────────────────────────────────────────────────────
 * **Fleet parallelism is DERIVED from the serving runtime's real slot count.**
 * It is never an independently configured number. Dispatching 8 agents against
 * 4 slots does not double throughput; it hides a queue inside llama-server and
 * turns every latency figure the cockpit prints into a lie. Configuration may
 * only ever LOWER the derived number (`deriveLocalFleetConcurrency`). When the
 * runtime is down, or the slot count cannot be read, the fleet fails CLOSED to
 * a single agent — one honest agent beats four imaginary ones.
 *
 * ── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
 * It grants NO authority. It never applies, merges, pushes, or approves; it
 * never reads or writes `~/.ashlr/KILL`, `config.json`, or `enrollment.json`;
 * it holds no token and copies no credential into any payload or log. Its
 * outputs are a concurrency number, a health verdict, a hang watchdog, and a
 * metadata-only observation snapshot. Proposal-only, sandboxed worktrees, the
 * kill switch, enrollment scope and the budget cap all remain exactly where
 * they were and keep their existing meaning.
 *
 * ── THE LIMITER, STATED OUT LOUD ───────────────────────────────────────────
 * A local dispatch costs zero dollars. A daily USD cap therefore CANNOT be
 * what bounds a local fleet — the guard never fires, and "bounded by budget"
 * would be a comfortable fiction wrapped around an unbounded loop. The real
 * limiters for local work are named explicitly and reported in every snapshot
 * (`LocalFleetSnapshotV1.limiter`):
 *
 *   1. serving slots        — the hard ceiling on genuine parallelism
 *   2. daemon.perTickItems  — how many items one tick may claim
 *   3. localFleet.maxDispatchesPerDay — an explicit, durable, NON-monetary
 *                             daily ceiling on local dispatches, counted in
 *                             this module's own journal (default: unset, and
 *                             an unset ceiling is reported as unbounded rather
 *                             than quietly implied to be safe)
 *
 * No new runtime dependencies; Node builtins only. No public API throws.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AshlrConfig, EngineId } from '../types.js';
// The local runtime lane owns how the serving runtime is inspected; this lane
// owns what the fleet does with the answer. `fleetConcurrencyLimit` is their
// declared contract for exactly this question, and it returns null rather than
// a guess when the server cannot be read — which is the behaviour the fleet's
// fail-closed rule depends on.
import {
  fleetConcurrencyLimit,
  probeLlamaRuntime,
} from '../local-runtime/llama/health.js';
import { resolveLlamaServerBaseUrl } from '../local-runtime/llama/config.js';
import type { LlamaRuntimeSnapshot } from '../local-runtime/llama/types.js';
// LOCAL-ONLY is one predicate with one resolution, owned by the policy lane.
// This lane consumes it; it never re-derives "are we local" from its own key.
import { localOnlyEnabled, resolveLocalOnlyMode, type LocalOnlyMode } from '../policy/local-only.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The engine id the local fleet dispatches through. */
export const LOCAL_FLEET_ENGINE = 'llama-server' as EngineId;

/**
 * Engines whose sandboxed dispatch holds the process-wide outward mutation
 * fence for the WHOLE run, inference included.
 *
 * 'builtin' goes through `runSwarm`, which acquires the fence for the entire
 * retained swarm lifecycle (src/core/swarm/runner.ts). While that is true,
 * exactly one such agent executes machine-wide no matter how many serving
 * slots exist — a real bound, and a tighter one than slots, so the derivation
 * must name it rather than quote a concurrency the fence will not permit.
 *
 * Both sandboxed producers — the api-model path (`runApiModelSandboxed`, which
 * is what LOCAL_FLEET_ENGINE uses) and, since V3.10 U6, the CLI-agent path
 * (`runEngineSandboxed`: claude, codex, grok-cli) — hold the fence only for
 * the policy gate, proposal filing and cleanup. Across inference they hold a
 * shared execution lease (src/core/sandbox/execution-leases.ts) that any
 * number of agents hold at once, so they are deliberately absent here.
 */
export const FENCE_SERIALIZED_ENGINES: ReadonlySet<EngineId> = new Set<EngineId>([
  'builtin' as EngineId,
]);

/**
 * Fail-closed parallelism. When the runtime is unreachable, or reachable but
 * unwilling to say how many slots it has, ONE is the only number that cannot
 * be a lie.
 */
export const LOCAL_FLEET_FAIL_CLOSED_CONCURRENCY = 1;

/** Ceiling on derived parallelism, so a misreporting runtime cannot uncap us. */
export const LOCAL_FLEET_MAX_CONCURRENCY = 32;

/** Default hang watchdog. A local agent that has produced nothing in 20 minutes is wedged. */
export const DEFAULT_LOCAL_FLEET_TASK_TIMEOUT_MS = 20 * 60_000;

/** Default park when the serving runtime is unreachable. Long enough not to hot-spin. */
export const DEFAULT_LOCAL_FLEET_RUNTIME_DOWN_BACKOFF_MS = 30_000;

/** Default capacity-probe deadline. Localhost; anything slower is effectively down. */
export const DEFAULT_LOCAL_FLEET_PROBE_TIMEOUT_MS = 1_500;

/** How long a capacity observation may be reused before re-probing. */
export const LOCAL_FLEET_CAPACITY_TTL_MS = 2_000;

/** Snapshot is considered stale (daemon likely gone) past this age. */
export const LOCAL_FLEET_SNAPSHOT_STALE_MS = 90_000;

/** Bounded recent-completion ring. */
const DEFAULT_RECENT_LIMIT = 20;

/** Bounded free text so a snapshot can never grow a prose payload. */
const MAX_TEXT = 200;
const MAX_SNAPSHOT_BYTES = 256 * 1024;

/** Consecutive runtime failures before health degrades from 'degraded' to 'runtime-down'. */
const RUNTIME_DOWN_THRESHOLD = 2;

/**
 * The default daily ceiling on local dispatches.
 *
 * This module's header argues that a USD cap cannot bound free local work and
 * names this as the knob that can. Shipping it OFF made that argument
 * decorative: what remained was serving slots (a concurrency rate, not a total)
 * and `daemon.perTickItems` (a per-tick rate), neither of which caps a
 * continuous loop with a 5s idle backoff and a healthy 4-slot runtime. So it
 * has a finite default — high enough that ordinary use never meets it, low
 * enough that an operator notices crossing it — and `null` remains reachable
 * as an EXPLICIT opt-out, reported as such rather than as silence.
 */
export const DEFAULT_LOCAL_FLEET_MAX_DISPATCHES_PER_DAY = 400;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ashlrDir(): string {
  // Same convention as daemon/state.ts: resolved at CALL time from homedir(),
  // so relocating HOME (test/helpers/h1-fixture.ts) isolates this module too.
  return join(homedir(), '.ashlr');
}

/** Directory holding the fleet's own observation artefacts. Never config, never secrets. */
export function localFleetDirectory(): string {
  return join(ashlrDir(), 'local-fleet');
}

/** The cross-process "what is the fleet doing right now" file. */
export function localFleetSnapshotPath(): string {
  return join(localFleetDirectory(), 'snapshot.json');
}

/** The durable daily dispatch counter backing `maxDispatchesPerDay`. */
export function localFleetLedgerPath(): string {
  return join(localFleetDirectory(), 'dispatch-ledger.json');
}

/**
 * Bound and flatten a string before it enters a snapshot.
 *
 * Control characters are stripped because this text lands in a JSON record a
 * terminal and a browser both render: a title carrying an escape sequence would
 * otherwise be able to rewrite the operator's screen.
 */
function text(value: unknown, max = MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  let flat = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    flat += (code < 0x20 || code === 0x7f) ? ' ' : ch;
  }
  flat = flat.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function positiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

function boundedMs(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Resolved local-fleet settings. Read from `cfg.daemon.localFleet` with an env
 * override, all values clamped. Nothing here grants authority — every field is
 * a cap, a URL, or a deadline.
 */
export interface LocalFleetSettings {
  /**
   * True when the fleet is armed. This is NOT a switch of its own: it is
   * `localOnlyEnabled(cfg)` from the local-only policy. A second mechanism for
   * "are we local right now" is exactly the bypass that policy exists to make
   * impossible, so this lane consumes the predicate and adds nothing beside it.
   */
  readonly enabled: boolean;
  /** Engine local work is dispatched through. Always the llama-server engine. */
  readonly engine: EngineId;
  /** OpenAI-compatible base URL (…/v1). */
  readonly baseUrl: string;
  /** Operator-pinned model, or null to let the runtime's loaded model answer. */
  readonly model: string | null;
  /** Hard deadline for one agent's turn. A task past this is wedged, not slow. */
  readonly taskTimeoutMs: number;
  /** How long the unattended loop parks when the serving runtime is unreachable. */
  readonly runtimeDownBackoffMs: number;
  /** Capacity-probe deadline. */
  readonly probeTimeoutMs: number;
  /**
   * Explicit NON-monetary daily dispatch ceiling, or null for unbounded.
   * A dollar cap cannot bound free work; this is the knob that actually can.
   */
  readonly maxDispatchesPerDay: number | null;
  /** How local-only resolved, carried verbatim from the policy. */
  readonly source: LocalOnlyMode['source'];
  /** The policy's own explanation, so no surface has to invent one. */
  readonly detail: string;
}

/**
 * Read local-fleet settings.
 *
 * `enabled` and `source` come from the local-only policy — this lane never
 * decides whether the machine is local-only, it only decides how many agents
 * to run once it is.
 *
 * The remaining knobs live under `cfg.daemon.localFleet` and are read through a
 * narrow validated cast rather than a `types.ts` edit — the same pattern
 * `buildLlamaServerBaseUrl` already uses for `cfg.models.llamaServer`, and for
 * the same reason: `types.ts` is shared and this lane owns neither it nor the
 * merge order of everyone else's fields. Every value is validated and clamped
 * here, so an arbitrary config body can only ever produce a legal settings
 * object. There is deliberately no `baseUrl` here: the serving endpoint is the
 * runtime lane's to resolve, and a second copy of it is how two components end
 * up talking to two different servers.
 */
export function readLocalFleetSettings(cfg: AshlrConfig): LocalFleetSettings {
  const daemon = plainObject((cfg as unknown as Record<string, unknown>)['daemon']);
  const raw = plainObject(daemon?.['localFleet']) ?? {};
  const mode = resolveLocalOnlyMode(cfg);

  const model = typeof raw['model'] === 'string' && raw['model'].trim()
    ? raw['model'].trim()
    : null;

  return {
    enabled: mode.enabled,
    engine: LOCAL_FLEET_ENGINE,
    baseUrl: resolveLlamaServerBaseUrl(cfg),
    model,
    taskTimeoutMs: boundedMs(
      raw['taskTimeoutMs'], DEFAULT_LOCAL_FLEET_TASK_TIMEOUT_MS, 10_000, 6 * 60 * 60_000,
    ),
    runtimeDownBackoffMs: boundedMs(
      raw['runtimeDownBackoffMs'], DEFAULT_LOCAL_FLEET_RUNTIME_DOWN_BACKOFF_MS, 1_000, 15 * 60_000,
    ),
    probeTimeoutMs: boundedMs(
      raw['probeTimeoutMs'], DEFAULT_LOCAL_FLEET_PROBE_TIMEOUT_MS, 100, 30_000,
    ),
    // `null` only when the operator WROTE null — an explicit opt-out. An
    // absent key takes the finite default; an unset ceiling that quietly means
    // "unbounded" is the failure this default exists to end.
    maxDispatchesPerDay: raw['maxDispatchesPerDay'] === null
      ? null
      : positiveInt(raw['maxDispatchesPerDay']) ?? DEFAULT_LOCAL_FLEET_MAX_DISPATCHES_PER_DAY,
    source: mode.source,
    detail: text(mode.detail, 240),
  };
}

/** True when the local-only fleet is armed for this config. Never throws. */
export function localFleetEnabled(cfg: AshlrConfig): boolean {
  try {
    return localOnlyEnabled(cfg);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Serving capacity — the slot count everything else derives from
// ---------------------------------------------------------------------------

export type ServingRuntimeState = 'up' | 'down' | 'unknown';

/**
 * A point-in-time observation of the serving runtime, in the terms the FLEET
 * needs. METADATA ONLY — and deliberately host:port rather than a URL, so no
 * surface downstream of here can ever print a credential-bearing endpoint.
 *
 * `slots === null` means "reachable but it would not say", which is treated
 * exactly like unreachable for concurrency purposes: fail closed.
 */
export interface ServingRuntimeCapacity {
  readonly runtime: 'llama-server';
  /** host:port. Never a full URL, never a token. */
  readonly endpoint: string;
  readonly state: ServingRuntimeState;
  /** Total slots the runtime reports (`/props.total_slots`), or null when unknown. */
  readonly slots: number | null;
  /** Slots currently generating, when the runtime reports per-slot state. */
  readonly busySlots: number | null;
  /** Loaded model, as the runtime names it. */
  readonly model: string | null;
  /** True when this hub started the process and can supervise it. */
  readonly managed: boolean;
  readonly startedAt: string | null;
  readonly observedAt: string;
  /** Short reason string suitable for a log line or a cockpit row. */
  readonly detail: string;
}

/**
 * Injectable capacity source.
 *
 * Production uses the local-runtime lane's `probeLlamaRuntime`. Tests register
 * a stub here so the fleet's derivation rules can be proven without a socket,
 * a port, or a 27 GB model.
 */
export type ServingCapacityProbe = (
  opts: { cfg: AshlrConfig; timeoutMs: number; nowMs: number },
) => Promise<ServingRuntimeCapacity>;

let registeredProbe: ServingCapacityProbe | null = null;

/** Override the capacity probe. Pass null to restore the runtime lane's probe. */
export function registerServingCapacityProbe(probe: ServingCapacityProbe | null): void {
  registeredProbe = probe;
}

function downCapacity(endpoint: string, nowMs: number, detail: string): ServingRuntimeCapacity {
  return {
    runtime: 'llama-server',
    endpoint: text(endpoint, 120),
    state: 'down',
    slots: null,
    busySlots: null,
    model: null,
    managed: false,
    startedAt: null,
    observedAt: isoNow(nowMs),
    detail: text(detail),
  };
}

/**
 * Adapt the runtime lane's snapshot into the fleet's capacity shape.
 *
 * The slot count comes from `fleetConcurrencyLimit`, NOT from
 * `snapshot.slots.configured` read directly — that function is the runtime
 * lane's declared answer to "how many agents may run at once", including its
 * rule that a runtime which is not `up` has no number at all. Reading the raw
 * field here would fork that rule into two places, which is the exact mistake
 * this module exists to avoid.
 *
 * A `loading` runtime maps to `unknown`, not `up`: a model still loading has no
 * usable slots, and reporting it as up would let the fleet dispatch into a wall.
 */
export function capacityFromRuntimeSnapshot(
  snapshot: LlamaRuntimeSnapshot,
  nowMs = Date.now(),
): ServingRuntimeCapacity {
  const limit = fleetConcurrencyLimit(snapshot);
  const state: ServingRuntimeState = snapshot.state === 'up'
    ? 'up'
    : snapshot.state === 'down' ? 'down' : 'unknown';
  const endpoint = snapshot.host && snapshot.port
    ? `${snapshot.host}:${snapshot.port}`
    : text(snapshot.origin, 120);
  const detail = snapshot.lastError
    ? text(snapshot.lastError)
    : state === 'up' && limit !== null
      ? `llama-server up with ${limit} slot(s) (source=${snapshot.slots.source})`
      : state === 'up'
        ? 'llama-server up but did not report a slot count'
        : `llama-server ${snapshot.state}`;
  return {
    runtime: 'llama-server',
    endpoint: text(endpoint, 120),
    state,
    slots: limit === null ? null : Math.min(limit, LOCAL_FLEET_MAX_CONCURRENCY),
    busySlots: snapshot.slots.busy,
    model: snapshot.modelName ?? snapshot.model ?? null,
    managed: snapshot.managed === true,
    startedAt: snapshot.startedAt ?? null,
    observedAt: isoNow(nowMs),
    detail,
  };
}

interface CapacityCacheEntry {
  readonly key: string;
  readonly atMs: number;
  readonly capacity: ServingRuntimeCapacity;
}
let capacityCache: CapacityCacheEntry | null = null;

/** Drop the memoised capacity observation. Used by tests and on explicit refresh. */
export function resetServingCapacityCache(): void {
  capacityCache = null;
}

/**
 * The capacity observation the fleet acts on, memoised for
 * `LOCAL_FLEET_CAPACITY_TTL_MS` so a continuous loop ticking every few seconds
 * does not turn its own health check into load on the thing it is checking.
 *
 * Never throws: a probe that rejects is reported as `down`, which is the
 * fail-closed direction.
 */
export async function resolveServingCapacity(
  cfg: AshlrConfig,
  settings: LocalFleetSettings,
  opts?: { nowMs?: number; force?: boolean },
): Promise<ServingRuntimeCapacity> {
  const nowMs = opts?.nowMs ?? Date.now();
  const key = `${settings.baseUrl}\u0000${settings.probeTimeoutMs}`;
  if (
    !opts?.force && capacityCache !== null && capacityCache.key === key &&
    nowMs - capacityCache.atMs >= 0 && nowMs - capacityCache.atMs < LOCAL_FLEET_CAPACITY_TTL_MS
  ) {
    return capacityCache.capacity;
  }
  let capacity: ServingRuntimeCapacity;
  try {
    capacity = registeredProbe
      ? await registeredProbe({ cfg, timeoutMs: settings.probeTimeoutMs, nowMs })
      : capacityFromRuntimeSnapshot(
        await probeLlamaRuntime({ baseUrl: settings.baseUrl, timeoutMs: settings.probeTimeoutMs }),
        nowMs,
      );
  } catch (err) {
    capacity = downCapacity(
      settings.baseUrl,
      nowMs,
      `serving capacity probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  capacityCache = { key, atMs: nowMs, capacity };
  return capacity;
}

// ---------------------------------------------------------------------------
// Concurrency derivation — requirement 1
// ---------------------------------------------------------------------------

/** What is actually holding the fleet's parallelism down. */
export type LocalFleetLimiter =
  /** The serving runtime's real slot count. The honest, normal case. */
  | 'serving-slots'
  /** An operator cap below the slot count. */
  | 'config'
  /**
   * A per-tick lane cap below the slot count (V3.10: the fleet runtime's
   * `laneCaps.local` — operator presence, a Leader lane decision, the budget
   * or the grant). Named separately from 'config' so the panel says WHY.
   */
  | 'lane-cap'
  /**
   * The process-wide outward mutation fence is held across dispatch, so at
   * most ONE sandboxed agent executes machine-wide no matter how many slots
   * the runtime has. A real bound, and the tightest one when it applies.
   */
  | 'mutation-fence'
  /** Runtime down or slot count unknown — one agent, by refusal. */
  | 'fail-closed';

export interface LocalFleetConcurrency {
  /** Slots observed on the serving runtime. 0 when unknown or down. */
  readonly slots: number;
  /** `daemon.concurrency.local`, or null when the operator set nothing. */
  readonly configuredLocal: number | null;
  /** The number the dispatcher must use. Always >= 1. */
  readonly effective: number;
  readonly limiter: LocalFleetLimiter;
  readonly reason: string;
}

/**
 * Derive fleet parallelism from measured slots.
 *
 * THE RULE: slots are a CEILING. Config may lower it and may never raise it.
 *
 * On the default: `daemon.concurrency.local` defaults to 2 in `resolveCfg`, and
 * `foundry.local.maxConcurrent` defaults to 1 — both correct for Ollama, which
 * serialises this model architecture outright, and both WRONG for llama-server,
 * where 1 leaves three measured slots idle and pays the full 27 GB residency
 * for a quarter of the throughput. So when the operator has configured nothing,
 * the default is the observed slot count — deliberately, because the runtime's
 * `--parallel` IS the operator's statement of how many agents this machine
 * should run, and duplicating that number in a second place is precisely how a
 * queue becomes invisible.
 *
 * A configured value ABOVE the slot count is not honoured and says so: it would
 * buy nothing but a hidden queue inside llama-server.
 */
export function deriveLocalFleetConcurrency(
  capacity: ServingRuntimeCapacity,
  configuredLocal: number | null,
  opts?: {
    /**
     * True when the fleet's dispatch path holds the process-wide outward
     * mutation fence across the whole run. Then the binding limit is ONE, and
     * quoting the slot count would be a number the machine cannot deliver.
     */
    fenceSerialized?: boolean;
    /**
     * V3.10: this tick's cap on the `local` lane (TickHooks.beforeTick
     * `laneCaps.local`, e.g. 2 while Mason is present) and the sentence that
     * explains it. Like config, it may only LOWER the answer — and when it is
     * the binding bound the snapshot says so instead of quoting a slot count
     * the dispatcher will not use. null / absent = no lane cap this tick.
     */
    laneCap?: { limit: number; reason: string } | null;
  },
): LocalFleetConcurrency {
  const derived = deriveUncappedLocalFleetConcurrency(capacity, configuredLocal, opts);
  const laneLimit = opts?.laneCap ? positiveInt(opts.laneCap.limit) : null;
  // A lane cap of 0 means "lane off"; the dispatcher never asks this function
  // then (no local items are dispatched). Floor it at 1 so `effective` keeps
  // its >= 1 contract, and say that the lane is off in the reason.
  if (opts?.laneCap && laneLimit === null) {
    return {
      ...derived,
      effective: 1,
      limiter: 'lane-cap',
      reason: `local lane is off this tick: ${opts.laneCap.reason}`,
    };
  }
  if (laneLimit !== null && laneLimit < derived.effective) {
    return {
      ...derived,
      effective: laneLimit,
      limiter: 'lane-cap',
      reason: `lane cap ${laneLimit} is below ${derived.effective} (${derived.limiter}): ${opts!.laneCap!.reason}`,
    };
  }
  return derived;
}

function deriveUncappedLocalFleetConcurrency(
  capacity: ServingRuntimeCapacity,
  configuredLocal: number | null,
  opts?: { fenceSerialized?: boolean },
): LocalFleetConcurrency {
  const configured = positiveInt(configuredLocal);
  const slots = capacity.state === 'up' ? (positiveInt(capacity.slots) ?? 0) : 0;

  if (opts?.fenceSerialized === true) {
    return {
      slots: Math.min(slots, LOCAL_FLEET_MAX_CONCURRENCY),
      configuredLocal: configured,
      effective: 1,
      limiter: 'mutation-fence',
      reason:
        'this engine holds the process-wide outward mutation fence for its whole run, so ' +
        'exactly one sandboxed agent can execute at a time machine-wide' +
        (slots > 0 ? ` — the runtime's ${slots} slot(s) cannot be used` : ''),
    };
  }

  if (slots < 1) {
    return {
      slots: 0,
      configuredLocal: configured,
      effective: LOCAL_FLEET_FAIL_CLOSED_CONCURRENCY,
      limiter: 'fail-closed',
      reason: capacity.state === 'up'
        ? 'serving runtime reachable but reported no slot count — failing closed to 1 agent'
        : `serving runtime ${capacity.state} — failing closed to 1 agent`,
    };
  }

  const ceiling = Math.min(slots, LOCAL_FLEET_MAX_CONCURRENCY);
  if (configured === null) {
    return {
      slots: ceiling,
      configuredLocal: null,
      effective: ceiling,
      limiter: 'serving-slots',
      reason: `derived from the serving runtime's ${ceiling} slot(s); no operator cap configured`,
    };
  }
  if (configured < ceiling) {
    return {
      slots: ceiling,
      configuredLocal: configured,
      effective: configured,
      limiter: 'config',
      reason: `operator cap ${configured} is below the runtime's ${ceiling} slot(s)`,
    };
  }
  return {
    slots: ceiling,
    configuredLocal: configured,
    effective: ceiling,
    limiter: 'serving-slots',
    reason: configured > ceiling
      ? `operator cap ${configured} exceeds the runtime's ${ceiling} slot(s) and is NOT honoured — ` +
        'extra agents would queue inside llama-server, not run'
      : `operator cap ${configured} equals the runtime's slot count`,
  };
}

// ---------------------------------------------------------------------------
// Hang watchdog — requirement 3
// ---------------------------------------------------------------------------

/**
 * Arm a one-shot watchdog for a single agent turn.
 *
 * The failure this exists for is not a crash — a crash is loud and the pool
 * slot is released. It is the agent that never returns: the pool slot is held
 * forever, the tick never settles, and the daemon looks alive while doing
 * nothing. `onExpire` is where the caller aborts that turn's dispatch signal.
 *
 * Returns a cancel function, which is idempotent and MUST be called in a
 * `finally` so a completed turn cannot fire the watchdog later. The timer is
 * `unref`'d where the runtime supports it, so a pending watchdog never keeps
 * the process alive by itself.
 */
export function startLocalFleetHangWatchdog(
  opts: { timeoutMs: number; onExpire: () => void },
): () => void {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs));
  let fired = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (cancelled || fired) return;
    fired = true;
    try {
      opts.onExpire();
    } catch {
      // A watchdog that throws would be a second failure on top of the first.
    }
  }, timeoutMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
  return (): void => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Health — requirement 3
// ---------------------------------------------------------------------------

export type LocalFleetHealthState = 'healthy' | 'degraded' | 'runtime-down';

export interface LocalFleetHealth {
  readonly state: LocalFleetHealthState;
  /** Consecutive capacity observations or dispatches that failed at the runtime. */
  readonly consecutiveRuntimeFailures: number;
  readonly lastRuntimeFailureAt: string | null;
  readonly lastRuntimeSuccessAt: string | null;
  /** How long an unattended loop should park before trying again. 0 when healthy. */
  readonly backoffMs: number;
  /** Agent turns killed by the hang watchdog since the process started. */
  readonly timeouts: number;
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// Observation snapshot — requirement 4
// ---------------------------------------------------------------------------

/** How an agent turn ended. */
export type LocalFleetAgentOutcome =
  | 'proposed'
  | 'no-proposal'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'skipped';

/** One agent currently holding a slot. */
export interface LocalFleetAgentView {
  readonly agentId: string;
  readonly itemId: string;
  readonly repo: string;
  /** What this agent is working on, in the operator's words. */
  readonly title: string;
  readonly engine: string;
  readonly model: string | null;
  readonly startedAt: string;
  readonly elapsedMs: number;
  /**
   * 'queued' while the turn is waiting (sandbox creation, the process-wide
   * mutation fence), 'running' once the serving runtime has been contacted.
   * Never assumed: a queued agent labelled 'running' is the difference between
   * "four agents working" and "one working and three blocked".
   */
  readonly state: LocalFleetAgentProjection['state'];
}

/** One finished agent turn, newest first in the snapshot. */
export interface LocalFleetCompletionView {
  readonly agentId: string;
  readonly itemId: string;
  readonly repo: string;
  readonly title: string;
  readonly engine: string;
  readonly outcome: LocalFleetAgentOutcome;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly detail: string;
}

/** What is actually bounding the fleet, named rather than implied. */
export interface LocalFleetLimiterView {
  readonly kind: LocalFleetLimiter;
  readonly concurrency: number;
  /** Per-day dispatch ceiling, or null when the operator has set none. */
  readonly maxDispatchesPerDay: number | null;
  readonly dispatchesToday: number;
  /**
   * Stated plainly for the reader: a spend cap does NOT bound local work,
   * because local work costs nothing.
   */
  readonly note: string;
}

/**
 * The answer to "is it working, and on what". Designed to be rendered directly:
 * every field is either a number a meter can use or a string a row can print.
 *
 * METADATA ONLY — ids, titles, engine names, timings. No diffs, no prompts, no
 * tokens, no paths beyond the enrolled repo the operator already chose.
 */
export interface LocalFleetSnapshotV1 {
  readonly schemaVersion: 1;
  /** This file is observational. It authorises nothing. */
  readonly authority: 'none';
  readonly observedAt: string;
  /** Owning daemon process, so a reader can tell a live fleet from a corpse. */
  readonly pid: number;
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly runtime: ServingRuntimeCapacity;
  readonly slots: {
    readonly total: number;
    readonly busy: number;
    readonly idle: number;
    /** 0–100, busy/total. 0 when there are no slots to utilise. */
    readonly utilizationPct: number;
  };
  readonly concurrency: LocalFleetConcurrency;
  readonly inFlight: readonly LocalFleetAgentView[];
  readonly queue: {
    /** Claimable items this tick did not take. */
    readonly depth: number;
    /** A few titles, so "queue depth 12" has faces. */
    readonly next: readonly string[];
  };
  readonly recent: readonly LocalFleetCompletionView[];
  readonly health: LocalFleetHealth;
  readonly limiter: LocalFleetLimiterView;
  /** Totals since this daemon process started. */
  readonly totals: {
    readonly started: number;
    readonly completed: number;
    readonly proposed: number;
    readonly failed: number;
    readonly timedOut: number;
  };
}

export type LocalFleetSnapshotFreshness = 'fresh' | 'stale' | 'missing' | 'unreadable';

export interface LocalFleetSnapshotRead {
  readonly freshness: LocalFleetSnapshotFreshness;
  readonly snapshot: LocalFleetSnapshotV1 | null;
  readonly ageMs: number | null;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

interface ActiveAgent {
  agentId: string;
  itemId: string;
  repo: string;
  title: string;
  engine: string;
  model: string | null;
  startedAtMs: number;
  /**
   * 'queued' until the model is actually contacted.
   *
   * `beginAgent` runs BEFORE sandbox creation, before the outward mutation
   * fence, and before a single token is generated — so a row that said
   * 'running' from that moment described waiting as work, with a ticking
   * Elapsed column beside a slot meter reading 0 busy. The dispatch path
   * promotes it with {@link LocalFleetMonitor.markRunning} when the provider
   * request starts.
   */
  state: LocalFleetAgentProjection['state'];
  /** When the model was actually contacted, for an honest elapsed time. */
  runningAtMs: number | null;
}

export interface LocalFleetMonitorOptions {
  readonly now?: () => number;
  readonly recentLimit?: number;
  readonly pid?: number;
  readonly instanceId?: string;
}

/**
 * In-process record of what the local fleet is doing, plus a durable projection
 * of it so a different process (the cockpit's API) can read the same answer.
 *
 * Holds NO lock and gates NO dispatch. If every method here were a no-op the
 * fleet would still run correctly and safely — it would just be invisible,
 * which is the exact failure this exists to prevent.
 */
export class LocalFleetMonitor {
  private readonly _now: () => number;
  private readonly _recentLimit: number;
  private readonly _pid: number;
  private readonly _instanceId: string;

  private _enabled = false;
  private _capacity: ServingRuntimeCapacity;
  private _concurrency: LocalFleetConcurrency;
  private _settings: LocalFleetSettings | null = null;

  private readonly _active = new Map<string, ActiveAgent>();
  private _recent: LocalFleetCompletionView[] = [];
  private _queueDepth = 0;
  private _queueNext: string[] = [];

  /**
   * Two failure streaks, because two different observations clear them.
   *
   * A PROBE failure (runtime down, or mute about its slots) is cleared by a
   * probe that succeeds: that observation is direct evidence the cause is
   * gone. A DISPATCH failure is not — the failure this separation exists for
   * is a runtime that answers `/health` and `/props` while refusing every
   * completion request, and a single counter reset by the per-tick probe made
   * that state report 'healthy' with backoff 0 forever, so the continuous loop
   * shed the entire backlog into failures at full speed while every surface
   * said running. Only a completed turn clears a dispatch failure — plus a
   * slow time-based decay, so a runtime that genuinely recovered while the
   * loop was parked can earn its way back without a dispatch it is not
   * allowed to attempt.
   */
  private _probeFailures = 0;
  private _dispatchFailures = 0;
  private _lastRuntimeFailureAt: string | null = null;
  private _lastRuntimeFailureMs: number | null = null;
  private _lastRuntimeSuccessAt: string | null = null;
  private _healthReasons: string[] = [];

  private _started = 0;
  private _completed = 0;
  private _proposed = 0;
  private _failed = 0;
  private _timedOut = 0;

  constructor(options: LocalFleetMonitorOptions = {}) {
    this._now = options.now ?? ((): number => Date.now());
    this._recentLimit = Math.max(1, Math.min(200, options.recentLimit ?? DEFAULT_RECENT_LIMIT));
    this._pid = options.pid ?? process.pid;
    this._instanceId = options.instanceId ?? randomUUID();
    const nowMs = this._now();
    this._capacity = downCapacity('', nowMs, 'not yet probed');
    this._concurrency = {
      slots: 0,
      configuredLocal: null,
      effective: LOCAL_FLEET_FAIL_CLOSED_CONCURRENCY,
      limiter: 'fail-closed',
      reason: 'serving capacity not yet observed — failing closed to 1 agent',
    };
  }

  get instanceId(): string { return this._instanceId; }
  get inFlightCount(): number { return this._active.size; }

  /** Record the resolved settings so the snapshot can explain the limiter. */
  setSettings(settings: LocalFleetSettings): void {
    this._settings = settings;
    this._enabled = settings.enabled;
  }

  /**
   * Record a capacity observation AND fold it into health. A runtime that is
   * down or mute is a runtime failure; anything else resets the failure streak.
   */
  setCapacity(capacity: ServingRuntimeCapacity): void {
    this._capacity = capacity;
    const nowMs = this._now();
    const nowIso = isoNow(nowMs);
    if (capacity.state === 'up' && positiveInt(capacity.slots) !== null) {
      this._lastRuntimeSuccessAt = nowIso;
      // A successful probe clears PROBE failures outright — it is exactly the
      // evidence that unreachability is over.
      this._probeFailures = 0;
      // It does NOT clear dispatch failures: a runtime answering /health while
      // refusing every completion would otherwise be wiped clean on the next
      // tick and report 'healthy' forever. They decay slowly instead, one per
      // backoff period of quiet, so a runtime that really did recover while
      // the loop was parked can return to healthy without having to complete a
      // dispatch it is currently not allowed to attempt.
      const quietFor = this._lastRuntimeFailureMs === null
        ? Number.POSITIVE_INFINITY
        : nowMs - this._lastRuntimeFailureMs;
      const backoff = this._settings?.runtimeDownBackoffMs
        ?? DEFAULT_LOCAL_FLEET_RUNTIME_DOWN_BACKOFF_MS;
      if (this._dispatchFailures > 0 && quietFor >= backoff) {
        this._dispatchFailures -= 1;
        this._lastRuntimeFailureMs = nowMs;
      }
      if (this._dispatchFailures === 0) this._healthReasons = [];
    } else {
      this._probeFailures += 1;
      this._lastRuntimeFailureAt = nowIso;
      this._lastRuntimeFailureMs = nowMs;
      this._healthReasons = [text(capacity.detail) || `serving runtime ${capacity.state}`];
    }
  }

  setConcurrency(concurrency: LocalFleetConcurrency): void {
    this._concurrency = concurrency;
  }

  setQueue(depth: number, nextTitles: readonly string[] = []): void {
    this._queueDepth = Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0));
    this._queueNext = nextTitles.slice(0, 5).map((title) => text(title, 120)).filter(Boolean);
  }

  /** A dispatch failed in a way that implicates the runtime, not the work item. */
  recordRuntimeFailure(reason: string): void {
    const nowMs = this._now();
    this._dispatchFailures += 1;
    this._lastRuntimeFailureAt = isoNow(nowMs);
    this._lastRuntimeFailureMs = nowMs;
    const detail = text(reason);
    if (detail) this._healthReasons = [detail];
  }

  /**
   * A dispatch completed against the serving runtime.
   *
   * The ONE observation that proves a reachable runtime can actually serve,
   * and therefore the only one allowed to let a capacity probe clear the
   * failure streak.
   */
  recordRuntimeSuccess(): void {
    this._dispatchFailures = 0;
    this._lastRuntimeSuccessAt = isoNow(this._now());
    this._healthReasons = [];
  }

  /** Claim a slot. Returns the agent id used by `endAgent`. */
  beginAgent(input: {
    agentId?: string;
    itemId: string;
    repo: string;
    title: string;
    engine: string;
    model: string | null;
  }): string {
    const agentId = input.agentId && input.agentId.trim()
      ? text(input.agentId, 80)
      : randomUUID();
    this._active.set(agentId, {
      agentId,
      itemId: text(input.itemId, 120),
      repo: text(input.repo, 240),
      title: text(input.title, 120),
      engine: text(input.engine, 40),
      model: input.model ? text(input.model, 80) : null,
      startedAtMs: this._now(),
      // QUEUED, not running. Nothing has been asked of the runtime yet.
      state: 'queued',
      runningAtMs: null,
    });
    this._started += 1;
    return agentId;
  }

  /**
   * The provider request for this agent has started — it is now genuinely
   * running. Unknown ids are ignored, and a second call is a no-op, so the
   * dispatch path can wire this to a per-request hook without bookkeeping.
   */
  markRunning(agentId: string): void {
    const active = this._active.get(agentId);
    if (!active || active.state === 'running') return;
    active.state = 'running';
    active.runningAtMs = this._now();
  }

  /** Release a slot and push a completion row. Unknown ids are ignored. */
  endAgent(agentId: string, outcome: LocalFleetAgentOutcome, detail = ''): void {
    const active = this._active.get(agentId);
    if (!active) return;
    this._active.delete(agentId);
    const finishedMs = this._now();
    this._completed += 1;
    if (outcome === 'proposed') this._proposed += 1;
    if (outcome === 'failed') this._failed += 1;
    if (outcome === 'timeout') {
      this._timedOut += 1;
      this.recordRuntimeFailure(detail || 'agent turn exceeded the hang watchdog');
    }
    this._recent = [
      {
        agentId,
        itemId: active.itemId,
        repo: active.repo,
        title: active.title,
        engine: active.engine,
        outcome,
        startedAt: isoNow(active.startedAtMs),
        finishedAt: isoNow(finishedMs),
        durationMs: Math.max(0, finishedMs - active.startedAtMs),
        detail: text(detail),
      },
      ...this._recent,
    ].slice(0, this._recentLimit);
  }

  /** Drop any agent still marked in-flight. Called when a tick unwinds. */
  clearInFlight(reason = 'tick ended'): void {
    for (const agentId of [...this._active.keys()]) {
      this.endAgent(agentId, 'cancelled', reason);
    }
  }

  health(): LocalFleetHealth {
    const failures = this._probeFailures + this._dispatchFailures;
    const state: LocalFleetHealthState = failures === 0
      ? 'healthy'
      : failures >= RUNTIME_DOWN_THRESHOLD ? 'runtime-down' : 'degraded';
    const configuredBackoff = this._settings?.runtimeDownBackoffMs
      ?? DEFAULT_LOCAL_FLEET_RUNTIME_DOWN_BACKOFF_MS;
    // Exponential, capped at 8x the configured park: a runtime that has been
    // gone for an hour should not be probed as eagerly as one that just
    // restarted, and an unattended loop must not spin on a dead socket.
    const backoffMs = state === 'healthy'
      ? 0
      : Math.min(configuredBackoff * Math.min(8, 2 ** Math.max(0, failures - 1)), configuredBackoff * 8);
    return {
      state,
      consecutiveRuntimeFailures: failures,
      lastRuntimeFailureAt: this._lastRuntimeFailureAt,
      lastRuntimeSuccessAt: this._lastRuntimeSuccessAt,
      backoffMs,
      timeouts: this._timedOut,
      reasons: [...this._healthReasons],
    };
  }

  snapshot(): LocalFleetSnapshotV1 {
    const nowMs = this._now();
    const inFlight: LocalFleetAgentView[] = [...this._active.values()]
      .sort((left, right) => left.startedAtMs - right.startedAtMs)
      .map((agent) => ({
        agentId: agent.agentId,
        itemId: agent.itemId,
        repo: agent.repo,
        title: agent.title,
        engine: agent.engine,
        model: agent.model,
        startedAt: isoNow(agent.startedAtMs),
        elapsedMs: Math.max(0, nowMs - agent.startedAtMs),
        state: agent.state,
      }));
    // Slot utilisation is reported against the number the dispatcher is
    // actually allowed to use, not the runtime's raw slot count, so a fleet
    // capped below its hardware does not look permanently under-used.
    const total = Math.max(this._concurrency.effective, inFlight.length);
    // Only agents that actually reached the serving runtime occupy a slot. A
    // queued agent counted as busy is how a utilisation meter reads 100% while
    // the runtime's own /slots says 1/4.
    const busy = Math.min(inFlight.filter((agent) => agent.state === 'running').length, total);
    const ledger = { dispatches: currentLocalFleetDispatchCount(nowMs) };
    const maxPerDay = this._settings?.maxDispatchesPerDay ?? null;
    return {
      schemaVersion: 1,
      authority: 'none',
      observedAt: isoNow(nowMs),
      pid: this._pid,
      instanceId: this._instanceId,
      enabled: this._enabled,
      runtime: this._capacity,
      slots: {
        total,
        busy,
        idle: Math.max(0, total - busy),
        utilizationPct: total > 0 ? Math.round((busy / total) * 100) : 0,
      },
      concurrency: this._concurrency,
      inFlight,
      queue: { depth: this._queueDepth, next: [...this._queueNext] },
      recent: [...this._recent],
      health: this.health(),
      limiter: {
        kind: this._concurrency.limiter,
        concurrency: this._concurrency.effective,
        maxDispatchesPerDay: maxPerDay,
        dispatchesToday: ledger.dispatches,
        // NO "ONLY". This note is rendered verbatim under the fleet table, so
        // an exhaustive-sounding list of bounds that omits a tighter one is a
        // claim the codebase itself contradicts: the process-wide outward
        // mutation fence is still held across a whole `runSwarm` ('builtin')
        // run, and the short outward sections of every other producer
        // (worktree creation, filing, cleanup) plus verification slots (2
        // machine-wide, 1 per repo) serialize too — see
        // src/core/sandbox/execution-leases.ts.
        note: (maxPerDay === null
          ? 'local dispatch costs $0, so the daily budget cap cannot bound it; ' +
            'no daily ceiling is set (explicit operator opt-out) — ' +
            'set daemon.localFleet.maxDispatchesPerDay to restore one'
          : `local dispatch costs $0; the binding daily limit is ` +
            `localFleet.maxDispatchesPerDay=${maxPerDay} (${ledger.dispatches} used today)`) +
          '. Serving slots and daemon.perTickItems also bound this fleet' +
          (this._concurrency.limiter === 'mutation-fence'
            ? ', and the process-wide outward mutation fence is currently the tightest: ' +
              'only one sandboxed agent can execute at a time machine-wide'
            : this._concurrency.limiter === 'lane-cap'
              ? `, and this tick's lane cap is currently the tightest: ${this._concurrency.reason}`
              : ''),
      },
      totals: {
        started: this._started,
        completed: this._completed,
        proposed: this._proposed,
        failed: this._failed,
        timedOut: this._timedOut,
      },
    };
  }

  /**
   * Project the snapshot to disk for out-of-process readers. Best-effort by
   * design: an observation file that cannot be written must never take the
   * fleet down with it.
   */
  publish(): boolean {
    return writeLocalFleetSnapshot(this.snapshot());
  }
}

let processMonitor: LocalFleetMonitor | null = null;

/** The daemon process's monitor. */
export function localFleetMonitor(): LocalFleetMonitor {
  if (processMonitor === null) processMonitor = new LocalFleetMonitor();
  return processMonitor;
}

/**
 * Promote a fleet agent from 'queued' to 'running'.
 *
 * Free function because the caller is the DISPATCH path
 * (`runApiModelSandboxed`), which has the run id but no reason to know about
 * this module's class. The agent id IS the daemon's `attemptId`, which reaches
 * that function as `opts.runId`, so no new plumbing is needed. Unknown ids are
 * ignored, which makes this a no-op in every process that is not the daemon.
 */
export function markLocalFleetAgentRunning(agentId: string): void {
  try {
    localFleetMonitor().markRunning(agentId);
  } catch {
    // Observability must never be able to fail a run.
  }
}

/** Replace the process monitor. Tests use this; production never needs it. */
export function setLocalFleetMonitor(monitor: LocalFleetMonitor | null): void {
  processMonitor = monitor;
}

// ---------------------------------------------------------------------------
// Snapshot persistence
// ---------------------------------------------------------------------------

function ensureDirectory(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** Write the observation snapshot atomically and privately. Never throws. */
export function writeLocalFleetSnapshot(snapshot: LocalFleetSnapshotV1): boolean {
  try {
    const directory = localFleetDirectory();
    if (!ensureDirectory(directory)) return false;
    const body = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(body, 'utf8') > MAX_SNAPSHOT_BYTES) return false;
    writePrivateFileAtomically(
      join(directory, `.snapshot-${randomUUID()}.tmp`),
      localFleetSnapshotPath(),
      body,
      { anchorPath: directory, label: 'local fleet snapshot' },
    );
    return true;
  } catch {
    return false;
  }
}

function validSnapshot(value: unknown): value is LocalFleetSnapshotV1 {
  const record = plainObject(value);
  if (!record) return false;
  if (record['schemaVersion'] !== 1 || record['authority'] !== 'none') return false;
  if (typeof record['observedAt'] !== 'string' || !Number.isFinite(Date.parse(record['observedAt']))) return false;
  if (typeof record['pid'] !== 'number' || !Number.isSafeInteger(record['pid'])) return false;
  if (!Array.isArray(record['inFlight']) || !Array.isArray(record['recent'])) return false;
  if (!plainObject(record['runtime']) || !plainObject(record['concurrency'])) return false;
  if (!plainObject(record['slots']) || !plainObject(record['health']) || !plainObject(record['limiter'])) return false;
  return true;
}

/**
 * Read the fleet snapshot from another process.
 *
 * A file older than `LOCAL_FLEET_SNAPSHOT_STALE_MS` is returned as `stale` WITH
 * its content, never silently as current: "the daemon died twenty minutes ago
 * mid-task" is exactly the thing an operator needs told, and it is the thing a
 * naive read would present as four busy agents.
 */
export function readLocalFleetSnapshot(opts?: { nowMs?: number; staleMs?: number }): LocalFleetSnapshotRead {
  const nowMs = opts?.nowMs ?? Date.now();
  const staleMs = opts?.staleMs ?? LOCAL_FLEET_SNAPSHOT_STALE_MS;
  let raw: string;
  try {
    raw = readFileSync(localFleetSnapshotPath(), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT'
      ? { freshness: 'missing', snapshot: null, ageMs: null, reason: 'no local fleet snapshot has been written' }
      : { freshness: 'unreadable', snapshot: null, ageMs: null, reason: 'local fleet snapshot could not be read' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { freshness: 'unreadable', snapshot: null, ageMs: null, reason: 'local fleet snapshot is not valid JSON' };
  }
  if (!validSnapshot(parsed)) {
    return { freshness: 'unreadable', snapshot: null, ageMs: null, reason: 'local fleet snapshot is malformed' };
  }
  const ageMs = nowMs - Date.parse(parsed.observedAt);
  if (ageMs > staleMs) {
    return {
      freshness: 'stale',
      snapshot: parsed,
      ageMs,
      reason: `local fleet snapshot is ${Math.round(ageMs / 1000)}s old; the daemon may have stopped`,
    };
  }
  return { freshness: 'fresh', snapshot: parsed, ageMs, reason: 'live' };
}

// ---------------------------------------------------------------------------
// The explicit, non-monetary daily limiter — requirement 5
// ---------------------------------------------------------------------------

export interface LocalFleetDispatchLedger {
  /** UTC day the count belongs to. */
  readonly day: string;
  readonly dispatches: number;
}

function emptyLedger(nowMs: number): LocalFleetDispatchLedger {
  return { day: utcDay(nowMs), dispatches: 0 };
}

/** Read today's local dispatch count. A missing or stale-day ledger reads as zero. */
export function readLocalFleetDispatchLedger(nowMs = Date.now()): LocalFleetDispatchLedger {
  try {
    const parsed = plainObject(JSON.parse(readFileSync(localFleetLedgerPath(), 'utf8')));
    const day = typeof parsed?.['day'] === 'string' ? parsed['day'] : '';
    const dispatches = typeof parsed?.['dispatches'] === 'number' && Number.isSafeInteger(parsed['dispatches'])
      ? Math.max(0, parsed['dispatches'])
      : 0;
    if (day !== utcDay(nowMs)) return emptyLedger(nowMs);
    return { day, dispatches };
  } catch {
    return emptyLedger(nowMs);
  }
}

/**
 * AUTHORITATIVE in-process count, persisted as a checkpoint.
 *
 * The file was previously the source of truth, incremented by a non-atomic
 * read-then-write: up to `effective` agents finishing together each read the
 * same value and wrote `value + 1`, losing every increment but one. For the
 * one limiter this module's header calls the real bound on free work, that is
 * wrong in the permissive direction.
 *
 * So the daemon process counts in memory — where increments cannot interleave,
 * because JavaScript has no preemption — and persists the result as a
 * best-effort checkpoint so a restart resumes today's total rather than
 * starting over. Keyed by ledger PATH as well as day, so a relocated HOME (a
 * test, another user) never inherits a stale count.
 */
interface LedgerState { path: string; day: string; dispatches: number }
let ledgerState: LedgerState | null = null;

function syncLedgerState(nowMs: number): LedgerState {
  const path = localFleetLedgerPath();
  const day = utcDay(nowMs);
  if (ledgerState !== null && ledgerState.path === path && ledgerState.day === day) {
    return ledgerState;
  }
  const persisted = readLocalFleetDispatchLedger(nowMs);
  ledgerState = { path, day, dispatches: persisted.dispatches };
  return ledgerState;
}

function persistLedgerState(state: LedgerState): void {
  try {
    const directory = localFleetDirectory();
    if (ensureDirectory(directory)) {
      writePrivateFileAtomically(
        join(directory, `.ledger-${randomUUID()}.tmp`),
        localFleetLedgerPath(),
        `${JSON.stringify({ day: state.day, dispatches: state.dispatches })}\n`,
        { anchorPath: directory, label: 'local fleet dispatch ledger' },
      );
    }
  } catch {
    // An unwritable checkpoint must not stop work. The in-process count still
    // binds for this process's lifetime, which is the window that matters.
  }
}

/** Drop the in-process count. Tests only; production never needs it. */
export function resetLocalFleetDispatchState(): void {
  ledgerState = null;
}

/** Today's local dispatch count, preferring this process's authoritative one. */
export function currentLocalFleetDispatchCount(nowMs = Date.now()): number {
  return syncLedgerState(nowMs).dispatches;
}

/** Increment today's local dispatch count. Best effort; never throws. */
export function recordLocalFleetDispatch(nowMs = Date.now()): LocalFleetDispatchLedger {
  const state = syncLedgerState(nowMs);
  state.dispatches += 1;
  persistLedgerState(state);
  return { day: state.day, dispatches: state.dispatches };
}

/** A reserved place in today's ceiling, returned by {@link reserveLocalFleetDispatch}. */
export interface LocalFleetDispatchReservation extends LocalFleetDispatchAllowance {
  /**
   * Hand the reservation back — the turn never dispatched (kill switch, budget
   * short-circuit, a lost queue claim). Idempotent, and a no-op once the UTC
   * day has rolled, so a release can never make a fresh day negative.
   */
  release(): void;
}

/**
 * Take a place in today's ceiling BEFORE the turn runs.
 *
 * Counting after the fact made the cap unable to do its job twice over: a
 * long-running agent was invisible to the check for its entire duration, and a
 * verdict computed once per tick was frozen while the whole tick spent it, so
 * a tick starting one dispatch below the cap still dispatched its full
 * `perTickItems`. Reserving first makes the ceiling a ceiling; releasing on a
 * turn that never dispatched keeps it from counting work that did not happen.
 */
export function reserveLocalFleetDispatch(
  settings: LocalFleetSettings,
  nowMs = Date.now(),
): LocalFleetDispatchReservation {
  const refused = (allowance: LocalFleetDispatchAllowance): LocalFleetDispatchReservation => ({
    ...allowance,
    release: (): void => { /* nothing was taken */ },
  });

  const state = syncLedgerState(nowMs);
  const cap = settings.maxDispatchesPerDay;
  if (cap !== null && state.dispatches >= cap) {
    return refused({
      allowed: false,
      used: state.dispatches,
      cap,
      reason: `local fleet daily ceiling reached (${state.dispatches}/${cap})`,
    });
  }

  state.dispatches += 1;
  persistLedgerState(state);
  const takenOnDay = state.day;
  let released = false;
  return {
    allowed: true,
    used: state.dispatches,
    cap,
    reason: cap === null
      ? 'no daily local dispatch ceiling configured (operator opt-out)'
      : `local fleet within its daily ceiling (${state.dispatches}/${cap})`,
    release: (): void => {
      if (released) return;
      released = true;
      const current = syncLedgerState(Date.now());
      if (current.day !== takenOnDay || current.dispatches <= 0) return;
      current.dispatches -= 1;
      persistLedgerState(current);
    },
  };
}

export interface LocalFleetDispatchAllowance {
  readonly allowed: boolean;
  readonly used: number;
  readonly cap: number | null;
  readonly reason: string;
}

/**
 * The daily-ceiling check. Separate from the USD budget on purpose: local work
 * is free, so `remainingBudget <= 0` can never fire for it, and a cap that
 * cannot fire is not a cap.
 */
export function localFleetDispatchAllowed(
  settings: LocalFleetSettings,
  nowMs = Date.now(),
): LocalFleetDispatchAllowance {
  // The in-process count, not the file: they agree except while a concurrent
  // tick has reservations in flight, and in that window the in-process one is
  // the correct answer.
  const ledger = { dispatches: currentLocalFleetDispatchCount(nowMs) };
  const cap = settings.maxDispatchesPerDay;
  if (cap === null) {
    return {
      allowed: true,
      used: ledger.dispatches,
      cap: null,
      reason: 'no daily local dispatch ceiling configured — explicit operator opt-out ' +
        '(serving slots and perTickItems still bound the loop)',
    };
  }
  if (ledger.dispatches >= cap) {
    return {
      allowed: false,
      used: ledger.dispatches,
      cap,
      reason: `local fleet daily ceiling reached (${ledger.dispatches}/${cap})`,
    };
  }
  return {
    allowed: true,
    used: ledger.dispatches,
    cap,
    reason: `local fleet within its daily ceiling (${ledger.dispatches}/${cap})`,
  };
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * The shape the Autonomy cockpit reads.
 *
 * Field-for-field what `src/web-ui/routes/verse/autonomy/fleet-contract.ts`
 * declares as `FleetSnapshot`/`FleetAgent`, so the API route that serves it is
 * one projection call and no adapter. Declared structurally rather than by
 * importing that file, because `src/web-ui/**` belongs to the cockpit lane and
 * a core module must not depend on a web bundle.
 *
 * `null` means "not reported" everywhere here — never a zero standing in for an
 * unknown, which on a utilisation meter would read as "idle" and be a lie.
 */
export interface LocalFleetAgentProjection {
  readonly id: string;
  readonly task: string | null;
  readonly repo: string | null;
  readonly engine: string | null;
  readonly model: string | null;
  readonly state: 'queued' | 'running' | 'finishing';
  readonly startedAt: string | null;
  readonly slot: number | null;
}

export interface LocalFleetSnapshotProjection {
  readonly agents: readonly LocalFleetAgentProjection[];
  readonly queueDepth: number | null;
  readonly slotsTotal: number | null;
  readonly slotsBusy: number | null;
  readonly notes: readonly string[];
  readonly sampledAt: string | null;
}

/**
 * Project the durable snapshot onto the cockpit's contract.
 *
 * `slotsTotal`/`slotsBusy` are the runtime's OWN numbers, not the derived
 * concurrency, because the cockpit's header promises those two are the truth
 * about the hardware. When the runtime did not report them they stay null and
 * the panel says "unknown" rather than drawing an empty meter.
 *
 * `notes` carries the caveats a reader needs to trust the rest: a stale read,
 * a fail-closed concurrency, a runtime that is down, and the limiter — because
 * "4 agents, 0 busy" with no note is indistinguishable from a wedged fleet.
 */
export function projectFleetSnapshot(
  snapshot: LocalFleetSnapshotV1,
  read?: { freshness: LocalFleetSnapshotFreshness; ageMs: number | null },
): LocalFleetSnapshotProjection {
  const notes: string[] = [];
  if (read && read.freshness !== 'fresh') {
    notes.push(
      `snapshot is ${read.freshness}${read.ageMs === null ? '' : ` (${Math.round(read.ageMs / 1000)}s old)`}` +
      ' — the daemon that wrote it may no longer be running',
    );
  }
  if (!snapshot.enabled) notes.push('local-only is off; this fleet is not armed');
  if (snapshot.concurrency.limiter === 'fail-closed') {
    notes.push(`concurrency failed closed to 1: ${snapshot.concurrency.reason}`);
  }
  if (snapshot.concurrency.limiter === 'mutation-fence') {
    notes.push(`bounded by the outward mutation fence, not by slots: ${snapshot.concurrency.reason}`);
  }
  if (snapshot.concurrency.limiter === 'lane-cap') {
    notes.push(`bounded by this tick's lane cap, not by slots: ${snapshot.concurrency.reason}`);
  }
  if (snapshot.health.state !== 'healthy') {
    notes.push(`serving runtime ${snapshot.health.state}: ${snapshot.health.reasons[0] ?? snapshot.runtime.detail}`);
  }
  notes.push(snapshot.limiter.note);

  return {
    agents: snapshot.inFlight.map((agent, index) => ({
      id: agent.agentId,
      task: agent.title || null,
      repo: agent.repo || null,
      engine: agent.engine || null,
      model: agent.model,
      state: agent.state,
      startedAt: agent.startedAt,
      // The serving runtime does not tell us which slot a request landed on,
      // so this is a stable display ordinal, not a claim about llama-server's
      // internal slot ids. Ordering is by start time (see `snapshot()`).
      //
      // A QUEUED agent holds no slot at all, and the panel renders `null` here
      // as "no slot" — which is the difference between an agent working and an
      // agent waiting for the mutation fence.
      slot: agent.state === 'running' ? index : null,
    })),
    queueDepth: snapshot.queue.depth,
    slotsTotal: snapshot.runtime.slots,
    slotsBusy: snapshot.runtime.busySlots,
    notes,
    sampledAt: snapshot.observedAt,
  };
}

/**
 * Map a daemon dispatch result to a fleet outcome, without importing the
 * daemon's own (very large) type surface — the shape below is exactly the part
 * of `TickItemOutcome` this module needs, and nothing else.
 */
export function localFleetOutcomeOf(result: {
  dispatched?: boolean;
  dispatch?: { production?: { outcome?: string } | undefined; skipReason?: string | undefined } | undefined;
}): { outcome: LocalFleetAgentOutcome; detail: string } {
  if (result.dispatched !== true) {
    return { outcome: 'skipped', detail: text(result.dispatch?.skipReason ?? 'not dispatched') };
  }
  const production = text(result.dispatch?.production?.outcome ?? '');
  if (production === 'proposal-created') return { outcome: 'proposed', detail: production };
  if (production === 'cancelled') return { outcome: 'cancelled', detail: production };
  if (production === 'producer-failed' || production === 'gate-blocked') {
    return { outcome: 'failed', detail: production };
  }
  return { outcome: 'no-proposal', detail: production || 'no proposal produced' };
}
