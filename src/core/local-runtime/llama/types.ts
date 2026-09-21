/**
 * Typed surface for the supervised llama-server local serving runtime.
 *
 * WHY THIS EXISTS AT ALL — the measured constraint (docs/LOCAL-FLEET.md):
 * Ollama refuses to serve Qwen3.8 concurrently (`model architecture does not
 * currently support parallel requests, architecture=qwen35`), so four agents
 * queue behind one another (3.7 / 7.6 / 11.4 / 15.2s). llama-server serves the
 * same GGUF across N continuous-batching slots sharing ONE copy of the weights
 * (8.6 / 8.9 / 9.0 / 9.0s — they finish together). The fleet therefore runs on
 * llama-server; Ollama stays for discovery, embeddings and single chats.
 *
 * Everything here is a plain data shape. No function in this family throws for
 * an absent or unhealthy runtime: absence is a value (`state: 'down'`), and an
 * unreadable answer is `'unknown'`, never an exception a caller can forget to
 * catch.
 */

/** Liveness of the serving runtime. `unknown` = we could not find out. */
export type LlamaRuntimeState = 'up' | 'down' | 'unknown' | 'loading';

/**
 * WHICH serving runtime is answering the resolved base URL.
 *
 * Not a formality. `models.llamaServer.baseUrl` is an operator-settable string,
 * and pointing it at Ollama's `http://localhost:11434/v1` produces a runtime
 * that answers `/v1/models` — so `engineInstalled` keeps the engine routable —
 * while 404ing `/health` and `/props`. Asserting 'llama-server' for whatever
 * replies would render that as "llama-server · state unknown" and turn every
 * dispatch into the staggered queue docs/LOCAL-FLEET.md measured, with no
 * surface saying why.
 */
export type ServingRuntimeIdentity = 'llama-server' | 'ollama' | 'unknown';

/** Who started the process we are looking at. */
export type LlamaRuntimeOwner = 'cli' | 'launchd' | 'adopted';

/**
 * Slot capacity — the ONLY legitimate source of fleet concurrency.
 *
 * `configured` is read back from the live server (`/props.total_slots`), never
 * assumed from the `--parallel` flag we passed: a flag that silently did not
 * take effect, paired with a fleet configured to dispatch that many agents, is
 * exactly how a queue becomes invisible. When the server cannot be read the
 * value is null and callers must treat concurrency as unknown rather than
 * substituting their own number.
 */
export interface LlamaSlotCapacity {
  /** Slots the live server reports (`/props.total_slots`). Null when unknown. */
  configured: number | null;
  /** Slots currently generating (`/slots[].is_processing`). Null when unknown. */
  busy: number | null;
  /** configured - busy, when both are known. */
  idle: number | null;
  /** Where `configured` came from. 'unknown' means do not trust a number. */
  source: 'props' | 'slots' | 'unknown';
}

/**
 * A full health + capacity reading. Always returned, never thrown.
 *
 * `managed` distinguishes "a llama-server is answering on this port" from "a
 * llama-server WE own is answering on this port": an unmanaged one can be
 * adopted (`local-runtime start` verifies its argv first) but is never killed
 * on a guess.
 */
export interface LlamaRuntimeSnapshot {
  schemaVersion: 1;
  state: LlamaRuntimeState;
  /** Which runtime is actually answering, identified rather than assumed. */
  runtimeKind: ServingRuntimeIdentity;
  /**
   * The runtime's own words when it refuses to serve this model in parallel,
   * or null when it does not refuse. Evidence, never a substitute for the
   * sentence a surface writes around it.
   */
  parallelRefusal: string | null;
  /** OpenAI-compatible base, e.g. http://127.0.0.1:8080/v1 */
  baseUrl: string;
  /** Scheme + authority, e.g. http://127.0.0.1:8080 */
  origin: string;
  host: string;
  port: number;
  /** Absolute model path or alias the server reports. */
  model: string | null;
  /** Human-facing model name (Ollama ref when we started it, else basename). */
  modelName: string | null;
  /** Quantisation the server reports (`model_ftype`), e.g. 'Q8_0'. */
  quant: string | null;
  /** Context tokens the server was launched with, across all slots. */
  contextTotal: number | null;
  /** Context tokens available to ONE slot (`/props` n_ctx). */
  contextPerSlot: number | null;
  slots: LlamaSlotCapacity;
  /** Pid of the serving process when we can prove it is ours, else null. */
  pid: number | null;
  owner: LlamaRuntimeOwner | null;
  /** True when a verified ownership record names this port and pid. */
  managed: boolean;
  /** ISO time the recorded process was started. */
  startedAt: string | null;
  uptimeMs: number | null;
  /** True when ~/Library/LaunchAgents holds our plist. */
  launchAgentInstalled: boolean;
  /** True when ~/.ashlr/KILL is engaged. Reported, never acted on here. */
  killSwitchEngaged: boolean;
  /** Last failure encountered while probing, or null. Never a secret. */
  lastError: string | null;
  checkedAt: string;
}

/**
 * Crash-safe ownership record, written at spawn time and read on the next
 * start. Modelled on desktop/src-tauri/src/sidecar_guard.rs: two numbers and
 * some paths, nothing that could ever carry a credential.
 */
export interface LlamaOwnershipRecord {
  schemaVersion: 1;
  /** Pid of the llama-server process. */
  pid: number;
  port: number;
  host: string;
  /** Absolute path of the llama-server binary, for the pid-recycling guard. */
  binPath: string;
  /** Absolute path of the GGUF blob passed with -m. */
  modelPath: string;
  /** Ollama model reference the blob was resolved from, e.g. qwen3.8:27b-ctx64k. */
  modelRef: string | null;
  /** Exact argv (excluding argv[0]) we launched with. */
  args: string[];
  /** Slot count REQUESTED. The live server is still the source of truth. */
  requestedSlots: number;
  /** Total context REQUESTED (-c). */
  requestedContext: number;
  startedAt: string;
  owner: LlamaRuntimeOwner;
}

/**
 * Crash-safe ownership record for the DETACHED Anthropic proxy host.
 *
 * Same discipline as {@link LlamaOwnershipRecord} and for the same reason: a
 * pid is not an identity, so the record also carries what the proxy's argv must
 * still say before anything is terminated. It is a separate file
 * (`anthropic-proxy.json`) because it describes a separate process with its own
 * lifetime — see {@link import('./paths.js').anthropicProxyRecordPath}.
 *
 * There is no `args` field. The host process's whole argv is two integers and a
 * fixed internal flag, all reconstructible from the fields below, and a stored
 * argv nobody re-derives is just another thing that can go stale.
 */
export interface AnthropicProxyOwnershipRecord {
  schemaVersion: 1;
  /** Pid of the proxy host process. */
  pid: number;
  /** The port the PROXY listens on — not llama-server's. */
  port: number;
  host: string;
  /**
   * Absolute path of the executable hosting the proxy (`process.execPath` of
   * the spawner: `node`, or the packaged `ashlr` binary). This is the proxy's
   * equivalent of {@link LlamaOwnershipRecord.binPath} — argv[0] has to still
   * be this before the pid is signalled.
   */
  execPath: string;
  /** llama-server's port, as handed to the host process. */
  upstreamPort: number;
  /** `http://host:port` the proxy forwards every request to. */
  upstreamOrigin: string;
  startedAt: string;
  owner: LlamaRuntimeOwner;
}

/**
 * Outcome of a proxy lifecycle command.
 *
 * Mirrors {@link LlamaLifecycleResult} minus the snapshot: the proxy has no
 * `/props` to read, and inventing a health surface for it would be a second
 * source of truth about a runtime that already has one.
 */
export interface AnthropicProxyLifecycleResult {
  ok: boolean;
  action:
    | 'started'
    | 'already-running'
    | 'adopted'
    | 'restarted'
    | 'stopped'
    | 'not-running'
    | 'refused'
    | 'failed';
  /** One-line human explanation. Never carries a token or a secret. */
  detail: string;
  /** The record in force after the command, or null when there is none. */
  record: AnthropicProxyOwnershipRecord | null;
  /** `http://host:port/v1` an Anthropic client should use, when one is up. */
  baseUrl: string | null;
}

/** Facts about the world that {@link shouldReclaim} needs, gathered separately. */
export interface LlamaLivenessFacts {
  /** The recorded pid is a live, non-zombie process. */
  processAlive: boolean;
  /** That pid's argv still matches the recorded binary, model and port. */
  argvMatches: boolean;
}

/** Resolved launch parameters, after config / env / defaults are merged. */
export interface LlamaRuntimeConfig {
  /**
   * Bind address. GUARANTEED loopback unless the operator wrote
   * `models.llamaServer.allowNonLoopback: true` in the persisted config — an
   * env var alone can never widen it, because llama-server has NO
   * authentication of any kind and `local-runtime install` would bake the
   * resulting argv into a KeepAlive launchd job that returns at every login.
   */
  host: string;
  /**
   * Set when a non-loopback host was REQUESTED and refused. Carries the
   * requested value so the lifecycle detail can name the downgrade instead of
   * silently serving somewhere the operator did not expect.
   */
  hostDowngradedFrom: string | null;
  port: number;
  /**
   * Port for the Anthropic normalising proxy (anthropic-proxy.ts), which
   * binds the SAME already-gated `host` as llama-server. It is never passed to
   * llama-server's argv — `buildLlamaServerArgs` takes a `Pick` that excludes
   * it — it lives here so one resolver answers "which ports does this runtime
   * own?" rather than two that can drift apart.
   */
  anthropicPort: number;
  /** Slots to request via --parallel. */
  slots: number;
  /** Total context to request via -c, shared across slots. */
  context: number;
  /** Ollama model reference to resolve the GGUF from. */
  modelRef: string;
  /** Explicit GGUF path, when the operator bypassed Ollama's store. */
  modelPath: string | null;
  /** llama-server binary; resolved from PATH when not configured. */
  binPath: string | null;
  /** Extra argv appended verbatim after the managed flags. */
  extraArgs: string[];
}

/** Outcome of a lifecycle command. Never a thrown error for an expected state. */
export interface LlamaLifecycleResult {
  ok: boolean;
  /** Machine-readable outcome, stable across releases. */
  action:
    | 'started'
    | 'already-running'
    | 'adopted'
    | 'stopped'
    | 'not-running'
    | 'restarted'
    | 'refused'
    | 'failed';
  /** One-line human explanation. Never carries a token or a secret. */
  detail: string;
  snapshot: LlamaRuntimeSnapshot;
  /** Absolute log paths, when a process was launched by us. */
  logs?: { stdout: string; stderr: string };
}
