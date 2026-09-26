/**
 * routes/verse/autonomy/fleet-model.ts — every derivation the local-fleet
 * surfaces make, as pure functions. No React, no I/O, so the rules that decide
 * what the operator is told are unit-testable without a DOM.
 *
 * The one rule this file exists to enforce:
 *
 *   **A concurrency number the runtime will not honour is a lie, and the UI
 *   must print the truth instead of the configuration.**
 *
 * That is not a hypothetical. Measured on this machine (docs/LOCAL-FLEET.md),
 * four concurrent Qwen3.8 requests to Ollama returned at 3.7 / 7.6 / 11.4 /
 * 15.2s — a four-second stagger, which is a queue. The same weights on
 * llama-server returned at 8.6 / 8.9 / 9.0 / 9.0s: continuous batching across
 * four slots sharing one 27 GB copy. Ollama's log calls it a refusal
 * (`model architecture does not currently support parallel requests`) and
 * `OLLAMA_NUM_PARALLEL` does not move it.
 *
 * So `runtimeCapacity()` never reports `slotsTotal` as capacity unless the
 * runtime says it batches. When a runtime that serializes is configured with
 * four slots, the capacity is ONE and `overstated` is true, and the panel says
 * so in words. A queue that looks like slowness is the exact failure this
 * surface is here to prevent.
 *
 * The bodies these functions narrow come from routes that are landing in
 * parallel (see fleet-contract.ts), so everything is projected STRUCTURALLY
 * rather than cast: a field-name drift degrades to an honest "unknown" at
 * render time instead of throwing.
 */
import { UNKNOWN, formatDuration, percentText } from './format.js';
import type {
  FleetAgent,
  FleetAgentState,
  FleetSnapshot,
  LocalOnlyPolicy,
  LocalOnlyRefusal,
  LocalOnlySource,
  ServingRuntimeKind,
  ServingRuntimeParallelism,
  ServingRuntimeSnapshot,
  ServingRuntimeState,
} from './fleet-contract.js';

// ---------------------------------------------------------------------------
// Structural narrowing
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(source: Record<string, unknown>, key: string): string | null {
  const v = source[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A count that is meaningful at zero — so 0 stays 0 and absent stays null. */
function count(source: Record<string, unknown>, key: string): number | null {
  const v = num(source, key);
  return v === null ? null : Math.max(0, Math.round(v));
}

function bool(source: Record<string, unknown>, key: string): boolean | null {
  const v = source[key];
  return typeof v === 'boolean' ? v : null;
}

function strings(source: Record<string, unknown>, key: string): string[] {
  const v = source[key];
  return Array.isArray(v) ? v.filter((entry): entry is string => typeof entry === 'string') : [];
}

const RUNTIME_KINDS: readonly ServingRuntimeKind[] = ['llama-server', 'ollama', 'vllm', 'unknown'];
const RUNTIME_STATES: readonly ServingRuntimeState[] = [
  'running',
  'starting',
  'stopping',
  'stopped',
  'unknown',
];
const AGENT_STATES: readonly FleetAgentState[] = ['queued', 'running', 'finishing'];
const LOCAL_ONLY_SOURCES: readonly LocalOnlySource[] = [
  'off',
  'config',
  'env',
  'config+env',
  'latch',
  'unknown',
];

function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = source[key];
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function projectParallelism(raw: unknown): ServingRuntimeParallelism {
  const r = record(raw);
  if (!r) return { capable: null, refusal: null, slots: null };
  return { capable: bool(r, 'capable'), refusal: str(r, 'refusal'), slots: count(r, 'slots') };
}

/**
 * Owner R's `LlamaRuntimeSnapshot` (`src/core/local-runtime/llama/types.ts`)
 * spells the same facts differently, and the route that serves it is not
 * written yet — so rather than betting on one envelope, this reads both.
 *
 * The mapping, with the two judgement calls stated:
 *
 *  - `state: 'up' | 'down' | 'loading' | 'unknown'` → running / stopped /
 *    starting / unknown.
 *  - `contextPerSlot` wins over `contextTotal`. `-c 65536 --parallel 4` gives
 *    each slot 16k, and the number an agent's turn actually runs in is the
 *    per-slot one. Quoting the total would overstate every agent's context
 *    fourfold — the same class of error as quoting slots as concurrency.
 *  - `managed` → `supervised`. R is explicit that an unmanaged server may be
 *    adopted but is "never killed on a guess", which is exactly the condition
 *    under which this panel must not offer a stop button.
 */
const LLAMA_STATE: Readonly<Record<string, ServingRuntimeState>> = {
  up: 'running',
  down: 'stopped',
  loading: 'starting',
  unknown: 'unknown',
};

function projectLlamaShape(r: Record<string, unknown>): ServingRuntimeSnapshot | null {
  const rawState = r['state'];
  if (typeof rawState !== 'string' || !(rawState in LLAMA_STATE)) return null;
  const slots = record(r['slots']);
  const host = str(r, 'host');
  const port = count(r, 'port');
  const configured = slots ? count(slots, 'configured') : null;
  const busy = slots ? count(slots, 'busy') : null;
  // `slots.source` is R's own trust marker: 'unknown' means "do not trust a
  // number", so a slot count carrying it is dropped rather than quoted.
  const slotSource = slots ? str(slots, 'source') : null;
  const trusted = slotSource !== null && slotSource !== 'unknown';
  const total = trusted ? configured : null;

  const refusal = str(r, 'parallelRefusal');
  const identity = str(r, 'runtimeKind');
  const contextPerSlot = count(r, 'contextPerSlot');
  const contextTotal = count(r, 'contextTotal');

  return {
    // IDENTIFIED where the producer says so. A base URL pointed at Ollama's
    // /v1 answers /v1/models — enough to keep the engine routable — while
    // 404ing /health and /props, and asserting 'llama-server' for it would
    // hide the one fact that matters: that runtime serialises this model.
    kind: identity === 'ollama' ? 'ollama' : identity === 'unknown' ? 'unknown' : 'llama-server',
    state: LLAMA_STATE[rawState] ?? 'unknown',
    endpoint: host !== null && port !== null ? `${host}:${port}` : (str(r, 'origin') ?? null),
    // A digest is not a name. `modelName` falls back to `model_path`'s basename
    // at the producer, which for a blob out of Ollama's content-addressed store
    // is `sha256-…`: it identifies the machine's storage layout and names
    // nothing. Null renders as "unknown", which is the honest answer.
    model: humaneModelName(str(r, 'modelName')) ?? humaneModelName(str(r, 'model')),
    slotsTotal: total,
    slotsBusy: trusted ? busy : null,
    // PER-SLOT, or nothing. `-c 65536 --parallel 4` gives each agent 16k, so
    // the `-c` total is usable only divided by a slot count we trust.
    contextTokens:
      contextPerSlot ??
      (total !== null && total > 0 && contextTotal !== null && contextTotal > 0
        ? Math.floor(contextTotal / total)
        : null),
    startedAt: str(r, 'startedAt'),
    parallel: {
      // llama-server's slots ARE its continuous-batching slots: a count read
      // back off the live server (`/props.total_slots`, `/slots`) is a count
      // of requests it will run at the same time, which is what the
      // measurement in docs/LOCAL-FLEET.md showed. An untrusted or absent
      // reading claims nothing — `null`, not `true`.
      capable: refusal !== null ? false : trusted && total !== null ? true : null,
      // The runtime's own words when it refuses, carried verbatim as evidence.
      refusal,
      slots: total,
    },
    reason: str(r, 'lastError'),
    supervised: bool(r, 'managed') ?? false,
    sampledAt: str(r, 'checkedAt'),
  };
}

/** A displayable model name, or null for an absent or digest-shaped one. */
function humaneModelName(raw: string | null): string | null {
  if (raw === null || raw.length === 0) return null;
  const base = raw.split('/').pop() ?? raw;
  if (base.length === 0) return null;
  if (/^sha256[-:][0-9a-f]{16,}$/i.test(base)) return null;
  return base;
}

export function projectServingRuntime(raw: unknown): ServingRuntimeSnapshot | null {
  const r = record(raw);
  if (!r) return null;
  // A body already in this surface's own shape wins; otherwise try owner R's.
  if (!('kind' in r) && 'slots' in r && 'state' in r) {
    const llama = projectLlamaShape(r);
    if (llama !== null) return llama;
  }
  return {
    kind: oneOf(r, 'kind', RUNTIME_KINDS, 'unknown'),
    state: oneOf(r, 'state', RUNTIME_STATES, 'unknown'),
    endpoint: str(r, 'endpoint'),
    model: str(r, 'model'),
    slotsTotal: count(r, 'slotsTotal'),
    slotsBusy: count(r, 'slotsBusy'),
    contextTokens: count(r, 'contextTokens'),
    startedAt: str(r, 'startedAt'),
    parallel: projectParallelism(r['parallel']),
    reason: str(r, 'reason'),
    // A runtime this server cannot supervise must not be offered buttons, so
    // an unreported flag reads as NOT supervised. The conservative default is
    // "no controls" rather than controls that 404 on the first click.
    supervised: bool(r, 'supervised') ?? false,
    sampledAt: str(r, 'sampledAt'),
  };
}

function projectAgent(raw: unknown): FleetAgent | null {
  const r = record(raw);
  if (!r) return null;
  const id = str(r, 'id');
  if (id === null) return null;
  return {
    id,
    task: str(r, 'task'),
    repo: str(r, 'repo'),
    engine: str(r, 'engine'),
    model: str(r, 'model'),
    state: oneOf(r, 'state', AGENT_STATES, 'running'),
    startedAt: str(r, 'startedAt'),
    slot: count(r, 'slot'),
  };
}

export function projectFleet(raw: unknown): FleetSnapshot | null {
  const r = record(raw);
  if (!r) return null;
  const rawAgents = Array.isArray(r['agents']) ? (r['agents'] as unknown[]) : [];
  return {
    agents: rawAgents.map(projectAgent).filter((a): a is FleetAgent => a !== null),
    queueDepth: count(r, 'queueDepth'),
    slotsTotal: count(r, 'slotsTotal'),
    slotsBusy: count(r, 'slotsBusy'),
    notes: strings(r, 'notes'),
    sampledAt: str(r, 'sampledAt'),
  };
}

function projectRefusal(raw: unknown): LocalOnlyRefusal | null {
  const r = record(raw);
  if (!r) return null;
  const engine = str(r, 'engine');
  if (engine === null) return null;
  return { engine, reason: str(r, 'reason') ?? 'The dispatcher refuses this engine while local-only is on.' };
}

/**
 * `source` is carried through as the resolver's own value — it is no longer
 * flattened onto a smaller union here.
 *
 * The flattening this replaced mapped `'latch'` onto `'config'`, which tells
 * an operator the mode is stored in the config and editable when in fact the
 * process has pinned it for its own lifetime. Only the separate `mutable`
 * flag kept that from reaching the screen as a working switch that silently
 * does nothing. An unrecognised value lands on `'unknown'`, which makes no
 * claim at all.
 */
/** Sources that pin the mode to this server process, whatever the config says. */
const PINNED_SOURCES: ReadonlySet<LocalOnlySource> = new Set<LocalOnlySource>([
  'env',
  'config+env',
  'latch',
  'unknown',
]);

export function projectLocalOnly(raw: unknown): LocalOnlyPolicy | null {
  const r = record(raw);
  if (!r) return null;
  const rawRefusals = Array.isArray(r['refuses']) ? (r['refuses'] as unknown[]) : [];
  const source = oneOf(r, 'source', LOCAL_ONLY_SOURCES, 'unknown');
  return {
    // An unreported `enabled` is NOT "on": claiming cloud is unreachable when
    // the server never said so is the one error this policy cannot afford.
    enabled: bool(r, 'enabled') ?? false,
    source,
    refuses: rawRefusals.map(projectRefusal).filter((x): x is LocalOnlyRefusal => x !== null),
    // A policy pinned by the server's own process — an env var, or a latch
    // this process already took — is never editable from here, whatever the
    // body claims: a write would be silently overridden on the next read.
    // `'unknown'` is treated as pinned too, because offering a switch for a
    // policy this client cannot identify is the more expensive mistake.
    mutable: PINNED_SOURCES.has(source) ? false : (bool(r, 'mutable') ?? false),
    detail: str(r, 'detail'),
    sampledAt: str(r, 'sampledAt') ?? str(r, 'checkedAt'),
  };
}

// ---------------------------------------------------------------------------
// The capacity verdict — the point of this whole file
// ---------------------------------------------------------------------------

export type CapacityVerdict = 'batched' | 'serialized' | 'unknown' | 'offline';

export interface RuntimeCapacity {
  verdict: CapacityVerdict;
  /**
   * How many agents can genuinely be in flight at once. `null` means it
   * cannot be known from this reading — which is NOT the same as 0 and must
   * never render as a number.
   */
  effectiveConcurrency: number | null;
  /** What the runtime was configured with, honoured or not. */
  configuredSlots: number | null;
  /**
   * True when the configured slot count is larger than what the runtime will
   * actually run in parallel. While this is true, the configured number must
   * not be presented as capacity anywhere on the screen.
   */
  overstated: boolean;
  headline: string;
  detail: string;
  tone: 'success' | 'warning' | 'danger' | 'neutral' | 'unknown';
}

/** Human name for a runtime, used in sentences. */
export function runtimeLabel(kind: ServingRuntimeKind): string {
  switch (kind) {
    case 'llama-server':
      return 'llama-server';
    case 'ollama':
      return 'Ollama';
    case 'vllm':
      return 'vLLM';
    default:
      return 'the serving runtime';
  }
}

export function runtimeCapacity(runtime: ServingRuntimeSnapshot | null): RuntimeCapacity {
  if (runtime === null) {
    return {
      verdict: 'unknown',
      effectiveConcurrency: null,
      configuredSlots: null,
      overstated: false,
      headline: 'No serving runtime reported',
      detail:
        'Serving runtime unavailable — concurrency unknown.',
      tone: 'unknown',
    };
  }

  const configured = runtime.slotsTotal ?? runtime.parallel.slots;
  const name = runtimeLabel(runtime.kind);

  if (runtime.state !== 'running') {
    return {
      verdict: 'offline',
      effectiveConcurrency: null,
      configuredSlots: configured,
      overstated: false,
      headline: runtime.state === 'stopped' ? 'Not serving' : `Serving runtime is ${runtime.state}`,
      detail:
        runtime.state === 'stopped'
          ? `${name} is not running, so no local agent can take a turn. Start it before dispatching a fleet.`
          : `${name} is ${runtime.state}; capacity is not settled until it reports running.`,
      tone: runtime.state === 'stopped' ? 'neutral' : 'warning',
    };
  }

  if (runtime.parallel.capable === false) {
    // The measured case. The configured number is real — it is simply not a
    // concurrency, and printing it as one is the failure mode this exists for.
    const overstated = configured !== null && configured > 1;
    return {
      verdict: 'serialized',
      effectiveConcurrency: 1,
      configuredSlots: configured,
      overstated,
      headline: `${name} serializes requests`,
      detail: overstated
        ? `${name} has ${configured} slots configured but runs one request at a time for this model, so the real capacity is one agent. The other ${configured - 1} would queue, and a queue looks like slowness rather than a wait.`
        : `${name} runs one request at a time for this model. A second agent waits for the first to finish.`,
      tone: 'danger',
    };
  }

  if (runtime.parallel.capable === null) {
    return {
      verdict: 'unknown',
      effectiveConcurrency: null,
      configuredSlots: configured,
      overstated: false,
      headline: 'Batching not confirmed',
      detail: `${name} is running${
        configured === null ? '' : ` with ${configured} slots configured`
      }, but it has not reported whether it batches concurrent requests for this model. Until it does, this panel will not quote a concurrency it cannot stand behind.`,
      tone: 'unknown',
    };
  }

  if (configured === null) {
    return {
      verdict: 'batched',
      effectiveConcurrency: null,
      configuredSlots: null,
      overstated: false,
      headline: `${name} batches concurrent requests`,
      detail: `${name} batches, but reported no slot count, so the ceiling on concurrent agents is unknown.`,
      tone: 'unknown',
    };
  }

  return {
    verdict: 'batched',
    effectiveConcurrency: configured,
    configuredSlots: configured,
    overstated: false,
    headline: `${configured} agent${configured === 1 ? '' : 's'} in parallel`,
    detail: `${name} batches across ${configured} slot${
      configured === 1 ? '' : 's'
    } sharing one copy of the weights, so ${configured} agent${
      configured === 1 ? '' : 's'
    } can be mid-turn at once.`,
    tone: 'success',
  };
}

/**
 * The measured comparison, kept as data so the panel renders it as evidence
 * rather than as an assertion in prose. Source: docs/LOCAL-FLEET.md, four
 * concurrent requests against the same Qwen3.8 GGUF on this machine.
 */
export interface ConcurrencyEvidenceRow {
  runtime: string;
  /** Per-request completion times, in seconds, in the order they returned. */
  perRequestSeconds: readonly number[];
  wallSeconds: number;
  verdict: string;
}

export const CONCURRENCY_EVIDENCE: readonly ConcurrencyEvidenceRow[] = [
  {
    runtime: 'Ollama',
    perRequestSeconds: [3.7, 7.6, 11.4, 15.2],
    wallSeconds: 15.2,
    verdict: 'staggered — the requests queued',
  },
  {
    runtime: 'llama-server',
    perRequestSeconds: [8.6, 8.9, 9.0, 9.0],
    wallSeconds: 9.1,
    verdict: 'together — the requests batched',
  },
] as const;

// ---------------------------------------------------------------------------
// Utilisation
// ---------------------------------------------------------------------------

export interface SlotUtilisation {
  busy: number | null;
  total: number | null;
  /** 0–100, or null when either half is unknown. */
  percent: number | null;
  /** The share in words, by the one percent rule ("<1%", "99%"); null when unknown. */
  percentText: string | null;
  /** Every slot is taken: the next turn waits. */
  saturated: boolean;
  /** One line, safe to render on its own. */
  label: string;
}

/**
 * Slot occupancy.
 *
 * `total` is the EFFECTIVE concurrency, not the configured slot count — on a
 * runtime that serializes, one busy slot out of four configured is full, and
 * drawing it as 25% would tell the operator there is room when there is none.
 */
export function slotUtilisation(busy: number | null, effectiveTotal: number | null): SlotUtilisation {
  if (busy === null || effectiveTotal === null || effectiveTotal <= 0) {
    return {
      busy,
      total: effectiveTotal,
      percent: null,
      percentText: null,
      saturated: false,
      label:
        busy === null
          ? 'Slot occupancy is not reported.'
          : `${busy} in flight; the number of slots is not known, so occupancy cannot be drawn.`,
    };
  }
  const clamped = Math.min(busy, effectiveTotal);
  const share = (clamped / effectiveTotal) * 100;
  const percent = Math.round(share);
  const saturated = busy >= effectiveTotal;
  return {
    busy,
    total: effectiveTotal,
    percent,
    percentText: percentText(share),
    saturated,
    label: saturated
      ? `All ${effectiveTotal} slot${effectiveTotal === 1 ? '' : 's'} busy — new turns wait for one to free up.`
      : `${busy} of ${effectiveTotal} slot${effectiveTotal === 1 ? '' : 's'} busy.`,
  };
}

/**
 * What the operator is actually waiting on.
 *
 * Saturation alone is not bad news — a fleet at full occupancy is a fleet
 * working. Saturation WITH a queue is the thing to say plainly, because from
 * the outside it is indistinguishable from the machine being slow.
 */
export interface FleetPressure {
  state: 'idle' | 'working' | 'saturated' | 'queued' | 'unknown';
  headline: string;
  detail: string;
  tone: 'success' | 'running' | 'warning' | 'neutral' | 'unknown';
}

export function fleetPressure(
  fleet: FleetSnapshot | null,
  utilisation: SlotUtilisation,
  capacity: RuntimeCapacity,
): FleetPressure {
  if (fleet === null) {
    return {
      state: 'unknown',
      headline: 'Fleet not reported',
      // A missing reading — never shown as an empty fleet.
      detail: 'Fleet status unavailable.',
      tone: 'unknown',
    };
  }

  const running = fleet.agents.filter((a) => a.state !== 'queued').length;
  const queued = fleet.queueDepth ?? fleet.agents.filter((a) => a.state === 'queued').length;

  if (queued > 0) {
    return {
      state: 'queued',
      headline: `${queued} waiting for a slot`,
      detail:
        capacity.verdict === 'serialized'
          ? `${running} turn${running === 1 ? '' : 's'} in flight and ${queued} queued. This runtime serializes, so the queue drains one at a time — the wait is a wait, not slow inference.`
          : `${running} turn${running === 1 ? '' : 's'} in flight and ${queued} queued behind ${
              utilisation.total === null ? 'the available slots' : `${utilisation.total} slots`
            }. Queued turns have not started; their wall time is queueing, not work.`,
      tone: 'warning',
    };
  }

  if (running === 0) {
    return {
      state: 'idle',
      headline: 'Nothing in flight',
      detail: 'No agent is mid-turn.',
      tone: 'neutral',
    };
  }

  if (utilisation.saturated) {
    return {
      state: 'saturated',
      headline: `All slots busy · ${running} in flight`,
      detail: `Every slot is working and nothing is queued behind them. The next turn will wait, but none is waiting yet.`,
      tone: 'running',
    };
  }

  return {
    state: 'working',
    headline: `${running} in flight`,
    detail: utilisation.label,
    tone: 'running',
  };
}

// ---------------------------------------------------------------------------
// Local-only impact
// ---------------------------------------------------------------------------

export interface SeatLike {
  id: string;
  engine: string;
  label: string;
}

export interface LocalOnlyImpact {
  /** Seats that become unreachable while the policy is on. */
  blocked: SeatLike[];
  /** Seats unaffected — the local ones. */
  allowed: SeatLike[];
  /** The named refusal per blocked engine, from the server when it sent one. */
  refusalFor: (engine: string) => string;
  /** One line summarising the blast radius against the CURRENT seat roster. */
  summary: string;
}

const DEFAULT_REFUSAL = 'Refused: local-only is on and this engine is not local.';

/**
 * What local-only would block, measured against the seats that actually exist
 * on this machine right now.
 *
 * Deliberately computed from the live roster rather than from a fixed list of
 * cloud engines: the sentence "this would block 3 of your 5 seats" is only
 * trustworthy if the 5 is the operator's own number.
 */
export function localOnlyImpact(
  policy: LocalOnlyPolicy | null,
  seats: readonly SeatLike[],
): LocalOnlyImpact {
  const blocked = seats.filter((s) => s.engine !== 'local');
  const allowed = seats.filter((s) => s.engine === 'local');
  const byEngine = new Map<string, string>();
  for (const refusal of policy?.refuses ?? []) byEngine.set(refusal.engine, refusal.reason);

  const summary =
    seats.length === 0
      ? 'No seats are configured, so there is nothing for this policy to block yet.'
      : blocked.length === 0
        ? `Every one of your ${seats.length} seat${seats.length === 1 ? '' : 's'} is local, so this policy would block nothing today.`
        : `${blocked.length} of ${seats.length} seat${seats.length === 1 ? '' : 's'} would become unreachable; ${allowed.length} local seat${allowed.length === 1 ? '' : 's'} would keep working.`;

  return {
    blocked,
    allowed,
    refusalFor: (engine: string) => byEngine.get(engine) ?? DEFAULT_REFUSAL,
    summary,
  };
}

/** Where the policy came from, as a sentence an operator can act on. */
export function localOnlySourceNote(policy: LocalOnlyPolicy | null): string | null {
  if (policy === null) return null;
  // The policy's own sentence, when it wrote one. It knows things this client
  // does not — e.g. that an env var tried and failed to clear a persisted
  // local-only — and a template would erase exactly that.
  if (policy.detail !== null) return policy.detail;
  switch (policy.source) {
    case 'env':
    case 'config+env':
      return 'This policy is pinned by an environment variable on the server process, so it cannot be changed from here — restart the server without it to take the switch back.';
    case 'latch':
      return 'This process already observed a persisted local-only and has pinned it for its own lifetime, so turning it off takes effect for new dispatches but not for the seams that latched. Restart the server to clear it.';
    case 'config':
      return 'Stored in the hub config and applied on the next dispatch.';
    case 'off':
      return 'Not configured; cloud engines are reachable.';
    default:
      return 'The server did not say where this setting came from.';
  }
}

// ---------------------------------------------------------------------------
// Small formatters
// ---------------------------------------------------------------------------

/** "4m 12s" since an ISO instant, against a live clock. Absent stays absent. */
export function elapsedSince(iso: string | null, now: number): string {
  if (!iso) return UNKNOWN;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return UNKNOWN;
  return formatDuration(Math.max(0, now - at));
}

/** Uptime for the runtime header. Same rules, different words. */
export function formatUptime(startedAt: string | null, now: number): string {
  if (!startedAt) return UNKNOWN;
  const at = Date.parse(startedAt);
  if (Number.isNaN(at)) return UNKNOWN;
  return `up ${formatDuration(Math.max(0, now - at))}`;
}

/**
 * Context windows are quoted in powers of two everywhere the operator has
 * seen them (65536 is "64k"), so the divisor is 1024. Matching
 * `usage/local-model.ts`'s `formatContext` on purpose: two spellings of the
 * same number across two panels is how a UI starts to feel untrustworthy.
 */
export function formatContextTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens)) return UNKNOWN;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

/** Agent rows, ordered so the reader's first question is answered first. */
export function orderAgents(agents: readonly FleetAgent[]): FleetAgent[] {
  const rank: Record<FleetAgentState, number> = { running: 0, finishing: 1, queued: 2 };
  return [...agents].sort((a, b) => {
    const byState = rank[a.state] - rank[b.state];
    if (byState !== 0) return byState;
    // Longest-running first: the one most likely to be stuck is the one an
    // operator scanning this table is looking for.
    const at = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const bt = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
    if (Number.isNaN(at) && Number.isNaN(bt)) return a.id.localeCompare(b.id);
    if (Number.isNaN(at)) return 1;
    if (Number.isNaN(bt)) return -1;
    return at - bt;
  });
}
