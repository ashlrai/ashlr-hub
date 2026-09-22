/**
 * core/verse/fleet-types.ts — the WIRE contract for the three local-fleet
 * routes, and the projectors that produce it.
 *
 *   GET  /api/verse/runtime     → ServingRuntimeSnapshot
 *   POST /api/verse/runtime     → RuntimeActionResult   (start|stop|restart)
 *   GET  /api/verse/fleet       → FleetSnapshot
 *   GET  /api/verse/local-only  → LocalOnlyPolicy
 *   POST /api/verse/local-only  → LocalOnlyUpdateResult
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────
 *
 * Three core modules already know the answers — `local-runtime/llama` (is a
 * runtime serving, and across how many slots), `policy/local-only` (what is
 * refused), `daemon/local-fleet` (who is in flight) — but each speaks its own
 * internal dialect, and none of them is a transport shape. Without a single
 * declaration site the conversion has to happen somewhere, and the only other
 * candidate is the browser. That is the wrong place: it makes the *client* the
 * authority on what "4 slots" means, and every additional client (the CLI's
 * status command, a future desktop panel) has to reimplement the same
 * judgement calls and get them identically right.
 *
 * So the server commits to a shape here. The UI still narrows defensively —
 * a field it cannot recognise degrades to "unknown" rather than throwing —
 * but it is narrowing a contract, not inventing one.
 *
 * ── THE ONE RULE THIS FILE ENFORCES ────────────────────────────────────────
 *
 * Slots are not concurrency, and a slot count you cannot verify is not a slot
 * count. `LlamaSlotCapacity.source === 'unknown'` is the runtime lane's own
 * trust marker; a count carrying it is DROPPED here rather than quoted, which
 * cascades to `parallel.capable: null` and no concurrency claim at all. The
 * alternative — quoting the `--parallel` flag we asked for — is precisely how
 * a queue becomes invisible (docs/LOCAL-FLEET.md, "Concurrency is bounded by
 * slots, not by ambition").
 *
 * SECURITY: nothing here carries a secret. `endpoint` is host:port so an
 * operator can tell two runtimes apart — never a full URL with credentials,
 * never a token, never the launcher argv.
 */

import type { LlamaRuntimeSnapshot } from '../local-runtime/llama/types.js';
import type { LocalOnlyPolicySnapshot } from '../policy/local-only.js';
import type {
  LocalFleetAgentProjection,
  LocalFleetSnapshotProjection,
} from '../daemon/local-fleet.js';

// ---------------------------------------------------------------------------
// Serving runtime
// ---------------------------------------------------------------------------

/**
 * Which server is actually answering `/v1/chat/completions` for the fleet.
 *
 * NOT the same question as "which models are installed" (that is
 * `/api/verse/local-models`). A machine can have twelve models installed,
 * Ollama up, and still have no runtime capable of serving a fleet.
 */
export type ServingRuntimeKind = 'llama-server' | 'ollama' | 'vllm' | 'unknown';

export type ServingRuntimeState = 'running' | 'starting' | 'stopping' | 'stopped' | 'unknown';

/**
 * Whether the runtime batches concurrent requests for the model it has loaded
 * — the single fact that decides whether a "fleet" is a fleet or a queue
 * wearing one's clothes.
 *
 * Measured on this machine (docs/LOCAL-FLEET.md): four concurrent requests to
 * Qwen3.8 on Ollama returned at 3.7 / 7.6 / 11.4 / 15.2s — a four-second
 * stagger, i.e. strict serialization. The same model file on llama-server
 * returned at 8.6 / 8.9 / 9.0 / 9.0s: all four finished together. Ollama's own
 * log gives the reason as a refusal rather than a tuning problem, and
 * `OLLAMA_NUM_PARALLEL` does not change it.
 */
export interface ServingRuntimeParallelism {
  /**
   * `true` = the runtime batches across slots. `false` = it serializes, and
   * any concurrency number above 1 is a queue. `null` = NOT DETERMINED, which
   * is its own state and must never be rendered as either of the other two.
   */
  capable: boolean | null;
  /**
   * The runtime's own words when it refuses, carried verbatim as evidence
   * beside the sentence the UI writes — never in place of it.
   */
  refusal: string | null;
  /**
   * Slots the runtime will genuinely run at once. The ceiling on real
   * concurrency and the only number a fleet cap may be derived from.
   * null = the runtime did not report one we are willing to trust.
   */
  slots: number | null;
}

export interface ServingRuntimeSnapshot {
  kind: ServingRuntimeKind;
  state: ServingRuntimeState;
  /** Host:port only. Never a full URL with credentials, never a token. */
  endpoint: string | null;
  /** The model the runtime currently has loaded, as the runtime names it. */
  model: string | null;
  /** Slots in service right now. */
  slotsTotal: number | null;
  /** Slots with a request on them right now. */
  slotsBusy: number | null;
  /**
   * Context window available to ONE agent, in tokens.
   *
   * This is per-slot, not the `-c` total: `-c 65536 --parallel 4` gives each
   * agent 16k, and quoting 64k would overstate every turn fourfold — the same
   * error class as quoting slots as concurrency.
   */
  contextTokens: number | null;
  /** ISO start time, for uptime. null when not up or not reported. */
  startedAt: string | null;
  parallel: ServingRuntimeParallelism;
  /** Machine-readable degradation detail. Rendered as evidence, not as prose. */
  reason: string | null;
  /**
   * True when THIS server can start and stop the runtime. False means the
   * runtime is externally managed (launchd, a terminal the operator owns) and
   * the controls must say so instead of offering buttons that cannot work.
   */
  supervised: boolean;
  sampledAt: string | null;
}

/** `POST /api/verse/runtime` — supervise the serving runtime. */
export type RuntimeAction = 'start' | 'stop' | 'restart';

export interface RuntimeActionResult {
  ok: boolean;
  /** Machine-readable outcome from the supervisor, stable across releases. */
  action: string;
  /** The server's account of what it just did. Shown verbatim. */
  note: string;
  runtime: ServingRuntimeSnapshot | null;
}

// ---------------------------------------------------------------------------
// Local-only policy
// ---------------------------------------------------------------------------

/**
 * Where the setting came from.
 *
 * This is the policy resolver's own union, carried through unchanged rather
 * than flattened at the boundary. `'config+env'` and `'latch'` are the two
 * that matter operationally: both mean the mode is pinned for this process and
 * the switch in the UI must not pretend otherwise.
 */
export type LocalOnlySource =
  | 'off'
  | 'config'
  | 'env'
  | 'config+env'
  | 'latch'
  /**
   * Not emitted by the resolver — it always knows how it resolved. It exists
   * so a client narrowing a body from an older or newer server has a member to
   * land on that makes no claim, instead of being forced to pick one of the
   * five real answers and assert something the server never said.
   */
  | 'unknown';

/** One engine the local-only policy refuses, with the refusal it hands back. */
export interface LocalOnlyRefusal {
  engine: string;
  /** The refusal message the dispatcher raises. Quoted, not paraphrased. */
  reason: string;
}

export interface LocalOnlyPolicy {
  enabled: boolean;
  source: LocalOnlySource;
  /** Engines that become UNREACHABLE while enabled, with their named refusal. */
  refuses: LocalOnlyRefusal[];
  /** False when the policy is pinned by env or by this process having latched. */
  mutable: boolean;
  /**
   * The policy's own explanation of how it resolved — including the case where
   * an env var tried and failed to turn a persisted local-only off. Preferred
   * over any sentence a client could compose, because a real refusal beats a
   * template.
   */
  detail: string | null;
  sampledAt: string | null;
}

/** `POST /api/verse/local-only` — flip the policy. */
export interface LocalOnlyUpdate {
  enabled: boolean;
}

export interface LocalOnlyUpdateResult {
  ok: boolean;
  policy: LocalOnlyPolicy;
  note: string;
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export type FleetAgentState = 'queued' | 'running' | 'finishing';

/**
 * The in-flight agent shape, declared by `daemon/local-fleet.ts` and re-exported
 * here so the route and its producer cannot drift: there is one declaration,
 * and this file names where it lives rather than restating it.
 */
export type FleetAgent = LocalFleetAgentProjection;
export type FleetSnapshot = LocalFleetSnapshotProjection;

// ---------------------------------------------------------------------------
// Projectors — core dialect → wire
// ---------------------------------------------------------------------------

/**
 * llama-server's state union → the transport's.
 *
 * `loading` becomes `starting` and NOT `running`: a runtime still mapping 27 GB
 * of weights answers `/health` before it can answer a completion, and calling
 * that "running" is how a fleet dispatches into a wall.
 */
const RUNTIME_STATE: Readonly<Record<LlamaRuntimeSnapshot['state'], ServingRuntimeState>> = {
  up: 'running',
  down: 'stopped',
  loading: 'starting',
  unknown: 'unknown',
};

/**
 * Project the runtime lane's snapshot onto the wire contract.
 *
 * Three judgement calls live here, all of them about refusing to overstate:
 *
 *  1. **An untrusted slot count is dropped, not quoted.** `slots.source ===
 *     'unknown'` means the live server could not be read, so `slotsTotal`,
 *     `slotsBusy` and `parallel.slots` all go null and `capable` goes null with
 *     them. A fleet that cannot verify its width must report no width.
 *  2. **`contextTokens` is per-slot.** See the field's own comment.
 *  3. **One slot is not batching.** A llama-server started `--parallel 1` will
 *     not overlap anything, so `capable` is `false` there rather than `true`:
 *     the field answers "will this runtime run my agents at the same time",
 *     not "is this binary theoretically capable of continuous batching".
 */
/**
 * A model name a person can read, or nothing.
 *
 * `modelName` is the Ollama reference we started the server with, and it is
 * null for a runtime we merely ADOPTED — one the operator launched in a
 * terminal. The obvious fallback, `model`, is then whatever llama-server
 * reports as its model path, which for a blob resolved out of Ollama's store
 * is `.../blobs/sha256-2bb22714…`: a 64-character digest that identifies the
 * machine's storage layout, tells a reader nothing, and has no business on a
 * transport this deliberately carries no machine detail.
 *
 * So a digest-shaped name is dropped rather than shown. Null renders as
 * "unknown", which is the honest answer: the server is serving a model we can
 * see but cannot name.
 */
function humaneModelName(snapshot: LlamaRuntimeSnapshot): string | null {
  // BOTH candidates go through the same test. `modelName` is not safe by
  // construction: `composeSnapshot` derives it from `model_path`'s basename
  // when no ownership record names a reference, which for a blob out of
  // Ollama's content-addressed store is the digest itself. Testing only
  // `model` left the guard unreachable and shipped `sha256-2bb22714…` as the
  // model name on `GET /api/verse/runtime`.
  return nameOrNull(snapshot.modelName) ?? nameOrNull(snapshot.model);
}

/** A displayable model name, or null for an absent or digest-shaped one. */
function nameOrNull(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  const base = raw.split('/').pop() ?? raw;
  if (base.length === 0) return null;
  if (/^sha256[-:][0-9a-f]{16,}$/i.test(base)) return null;
  return base;
}

export function projectServingRuntime(snapshot: LlamaRuntimeSnapshot): ServingRuntimeSnapshot {
  const trusted = snapshot.slots.source !== 'unknown';
  const total = trusted ? snapshot.slots.configured : null;
  const busy = trusted ? snapshot.slots.busy : null;

  // IDENTIFIED, not asserted. `models.llamaServer.baseUrl` is a string an
  // operator can point anywhere; pointed at Ollama's /v1 it keeps the engine
  // routable (it serves /v1/models) while 404ing /health and /props. Calling
  // that "llama-server · state unknown" hides the one fact that matters — that
  // this runtime SERIALISES this architecture — behind a degradation notice.
  const kind: ServingRuntimeKind =
    snapshot.runtimeKind === 'ollama'
      ? 'ollama'
      // An under-specified snapshot (an older projection, a hand-built
      // fixture) carries no identity; 'llama-server' stays the answer for
      // everything that is not positively something else.
      : snapshot.runtimeKind === 'unknown' ? 'unknown' : 'llama-server';

  const refusal = snapshot.parallelRefusal ?? null;

  let capable: boolean | null;
  if (refusal !== null) capable = false;
  else if (total === null) capable = null;
  else if (total > 1) capable = true;
  else capable = false;

  return {
    kind,
    state: RUNTIME_STATE[snapshot.state] ?? 'unknown',
    endpoint: `${snapshot.host}:${snapshot.port}`,
    model: humaneModelName(snapshot),
    slotsTotal: total,
    slotsBusy: busy,
    // PER-SLOT, or nothing. Falling back to the `-c` total would report 65536
    // to an operator whose agents each have 16384 — a fourfold overstatement,
    // and one that only appears when `/props` is unreadable, i.e. exactly when
    // nobody can check it. A total is usable only when a TRUSTED slot count can
    // divide it; otherwise this stays null and the panel says "unknown".
    contextTokens:
      snapshot.contextPerSlot ??
      (total !== null && total > 0 && snapshot.contextTotal !== null && snapshot.contextTotal > 0
        ? Math.floor(snapshot.contextTotal / total)
        : null),
    startedAt: snapshot.startedAt,
    parallel: {
      capable,
      // llama-server does not refuse — it batches — so this stays null for it
      // and the reason field carries whatever actually went wrong. A runtime
      // that DOES refuse supplies its own words through the probe; this
      // surface never invents evidence.
      refusal,
      slots: total,
    },
    reason:
      refusal !== null
        ? 'this endpoint is Ollama, not llama-server: it serialises this model architecture, ' +
          'so every agent past the first queues invisibly. Point models.llamaServer.baseUrl at ' +
          'a llama-server (`ashlr local-runtime start`) to get a fleet rather than a queue.'
        : snapshot.lastError ??
          (total === 1
            ? 'the runtime is serving a single slot, so agents will queue rather than overlap — restart it with --parallel N to widen the fleet'
            : null),
    // Only a runtime with a verified ownership record can be stopped from
    // here. An adopted-but-unrecorded server gets no buttons rather than
    // buttons that refuse on the first click.
    supervised: snapshot.managed,
    sampledAt: snapshot.checkedAt,
  };
}

/** Project the policy lane's snapshot onto the wire contract. */
export function projectLocalOnlyPolicy(
  snapshot: LocalOnlyPolicySnapshot,
  sampledAt: string,
): LocalOnlyPolicy {
  return {
    enabled: snapshot.enabled,
    source: snapshot.source,
    refuses: snapshot.refuses.map((r) => ({ engine: r.engine, reason: r.reason })),
    mutable: snapshot.mutable,
    detail: snapshot.detail,
    sampledAt,
  };
}

/**
 * The fleet snapshot when the daemon has never written one.
 *
 * Deliberately not an error: a hub that has never run the local fleet is a
 * normal state, and the note says which of the two reasons applies so the
 * panel does not render "0 agents" as though the fleet were idle when it was
 * never armed.
 */
export function emptyFleetSnapshot(note: string, sampledAt: string): FleetSnapshot {
  return {
    agents: [],
    queueDepth: null,
    slotsTotal: null,
    slotsBusy: null,
    notes: [note],
    sampledAt,
  };
}

/**
 * Fold the live runtime reading into a fleet snapshot.
 *
 * The daemon writes its snapshot when it ticks; between ticks the slot numbers
 * in it age. The runtime probe is live on every request, so when it can be
 * trusted it wins for `slotsTotal`/`slotsBusy` — otherwise a fleet panel next
 * to a runtime panel shows two different slot counts for the same server,
 * which is exactly the disagreement this contract exists to prevent.
 */
export function withLiveSlots(
  fleet: FleetSnapshot,
  runtime: ServingRuntimeSnapshot | null,
): FleetSnapshot {
  if (runtime === null || runtime.slotsTotal === null) return fleet;
  return {
    ...fleet,
    slotsTotal: runtime.slotsTotal,
    slotsBusy: runtime.slotsBusy ?? fleet.slotsBusy,
  };
}

/** True for a config whose local-only setting can be written by this server. */
export function localOnlyWritable(policy: LocalOnlyPolicy): boolean {
  return policy.mutable;
}
